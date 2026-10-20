// Sprint 118 (WS-9, migration 126): Administration → Mail queue (delivery per
// hour and per workspace / application, the slowest provider calls, failures
// with the provider's answer, Retry and Purge), a workspace's own mail service,
// and a workspace's network access list that narrows the installation's
// allow-list for every outgoing web call of its applications.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';

process.env.PGKILN_SECRET_KEY = 'test-only-secret-key-0123456789abcdef';
process.env.PGKILN_REST_ALLOWED_HOSTS = '127.0.0.1,localhost';
process.env.PGKILN_REST_PRIVATE_HOSTS = '127.0.0.1,localhost';

const { buildApp } = await import('../src/app.ts');
const { closePools, owner, runtime } = await import('../src/db.ts');
const { mailTick } = await import('../src/mail/mail.ts');
const { clearTokens } = await import('../src/mail/providers.ts');
const { parseHostList } = await import('../src/network-acl.ts');
const wr = await import('../src/webrequests.ts');
const { Browser } = await import('./helpers.ts');
const { MailMock } = await import('./mail-mock.ts');

let app: FastifyInstance;
let appId: number;
let wsId: number;
let otherWs: number;
let mock: http.Server;
let mockBase = '';
let port = 0;
const mail = new MailMock();
const alias = 'mn-s118';
const ROLE = 'pgkiln_mn_s118';
const SCHEMA = 'mn_s118';
const WS = 'S118 Net';
const OTHER_WS = 'S118 Other';
const WSADMIN = 's118wsadmin';
const OTHERADMIN = 's118otheradmin';
const DEV = 's118dev';
const seen: string[] = [];

const asApp = <T>(fn: (q: (sql: string, params?: unknown[]) => Promise<any[]>) => Promise<T>) =>
  runtime.tx(async (c) => {
    await c.query(`select set_config('pgkiln.app_id', $1, true), set_config('pgkiln.app_user', 'ann', true)`, [String(appId)]);
    await c.query(`set local role ${ROLE}`);
    return fn(async (sql, params = []) => (await c.query(sql, params)).rows);
  });

const restrict = (hosts: string[] | null) =>
  owner.query('update meta.workspace set network_restricted = $2, network_hosts = $3 where id = $1', [wsId, hosts !== null, hosts ?? []]);

async function builder(user: string, password = user) {
  const b = new Browser(app);
  await b.get('/builder/login');
  const r = await b.submit('/builder/login', { username: user, password });
  assert.equal(r.statusCode, 303);
  await b.get('/builder/home');
  return b;
}

async function cleanup() {
  await owner.query('delete from meta.app where alias = $1', [alias]);
  await owner.query(`drop schema if exists ${SCHEMA} cascade`);
  await owner.query(`drop role if exists ${ROLE}`);
  await owner.query('delete from meta.workspace where name = any($1)', [[WS, OTHER_WS]]);
  await owner.query('delete from meta.developer where username = any($1)', [[WSADMIN, OTHERADMIN, DEV]]);
}

before(async () => {
  await cleanup();
  app = await buildApp({ logger: false });
  mock = http.createServer((req, res) => {
    seen.push(req.url!);
    if (req.url === '/away') {
      res.writeHead(302, { location: `http://localhost:${port}/json` });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  port = (mock.address() as AddressInfo).port;
  mockBase = `http://127.0.0.1:${port}`;
  await mail.start();

  await owner.query(`create role ${ROLE} nologin`);
  await owner.query(`grant ${ROLE} to pgkiln_runtime`);
  await owner.query(`create schema ${SCHEMA}`);
  await owner.query(`grant usage on schema ${SCHEMA} to ${ROLE}`);
  await owner.query(`create table ${SCHEMA}.log (msg text)`);
  await owner.query(`grant select, insert on ${SCHEMA}.log to ${ROLE}`);
  wsId = (await owner.one(`insert into meta.workspace (name) values ($1) returning id`, [WS])).id;
  otherWs = (await owner.one(`insert into meta.workspace (name) values ($1) returning id`, [OTHER_WS])).id;
  for (const u of [WSADMIN, OTHERADMIN, DEV]) await owner.query(`insert into meta.developer (username, password_hash, is_admin) values ($1, meta.hash_password($1), false)`, [u]);
  await owner.query('delete from meta.workspace_member where username = any($1)', [[WSADMIN, OTHERADMIN, DEV]]);
  await owner.query('insert into meta.workspace_member (workspace_id, username, is_admin) values ($1, $2, true), ($1, $3, false), ($4, $5, true)', [wsId, WSADMIN, DEV, otherWs, OTHERADMIN]);
  appId = (await owner.one(`insert into meta.app (alias, name, authentication, db_role, debug_level) values ($1, 'Mail and network test', 'none', $2, 4) returning id`, [alias, ROLE])).id;
  await owner.query('insert into meta.workspace_app (app_id, workspace_id) values ($1, $2)', [appId, wsId]);
  const pageId = (await owner.one(`insert into meta.page (app_id, page_no, name, requires_auth) values ($1, 1, 'Home', false) returning id`, [appId])).id;
  const regionId = (await owner.one(`insert into meta.region (page_id, seq, title, type, source) values ($1, 10, 'Form', 'static', '<p>Call</p>') returning id`, [pageId])).id;
  await owner.query(`insert into meta.item (page_id, region_id, seq, name, label, type) values ($1, $2, 1, 'P1_URL', 'URL', 'text'), ($1, $2, 2, 'P1_REQ', 'Request', 'hidden')`, [pageId, regionId]);
  await owner.query(`insert into meta.button (page_id, region_id, name, label) values ($1, $2, 'CALL', 'Call')`, [pageId, regionId]);
  await owner.query(
    `insert into meta.process (page_id, seq, name, type, point, code, when_button) values
       ($1, 1, 'Queue', 'sql', 'submit', 'select meta.web_request(:P1_URL) as p1_req', 'CALL'),
       ($1, 2, 'Read', 'sql', 'submit', $2, 'CALL')`,
    [pageId, `insert into ${SCHEMA}.log select coalesce(meta.web_response(:P1_REQ::bigint)->>'status_code', meta.web_response(:P1_REQ::bigint)->>'message')`]);
});

after(async () => {
  await cleanup();
  mock.close();
  await mail.stop();
  await app.close();
  await closePools();
});

beforeEach(async () => {
  await restrict(null);
  await owner.query(`delete from ${SCHEMA}.log`);
  await owner.query('delete from meta.network_refusal where workspace_id = $1', [wsId]);
});

/** Submit page 1 with a URL: the process queues meta.web_request and the next reads its response. */
async function callFromPage(url: string) {
  await owner.query('delete from meta.debug_view where app_id = $1', [appId]);
  await owner.query(`delete from ${SCHEMA}.log`);
  const b = new Browser(app);
  await b.get(`/a/${alias}/1`);
  const res = await b.submit(`/a/${alias}/1`, { __request: 'CALL', P1_URL: url });
  assert.equal(res.statusCode, 303, res.body);
  return (await owner.one(`select msg from ${SCHEMA}.log`)).msg as string;
}

/** The debug messages of the app's latest POST (stored after the response: wait for them). */
async function debugMessages() {
  for (let i = 0; i < 50; i++) {
    const v = await owner.one(`select id from meta.debug_view where app_id = $1 and method = 'POST' order by id desc limit 1`, [appId]);
    if (v) return (await owner.query('select level, component, message from meta.debug_message where view_id = $1 order by seq', [v.id])).rows;
    await new Promise((r) => setTimeout(r, 40));
  }
  return [];
}

describe('network access lists', () => {
  test('entries: host, *.domain, host:port, [IPv6]:port; anything else is refused (form and database)', async () => {
    assert.deepEqual(parseHostList('API.example.com, *.example.org\napi.example.com:8443 [::1]:8080 api.example.com'),
      ['api.example.com', '*.example.org', 'api.example.com:8443', '[::1]:8080']);
    for (const bad of ['https://api.example.com', 'api.example.com/v1', '*', 'host:0', 'host:70000', 'user@host', '-x.example.com', 'a/b'])
      assert.throws(() => parseHostList(bad), /is not a host/, bad);
    for (const bad of [['https://x'], ['*'], ['a/b'], ['host:99999']])
      await assert.rejects(owner.query('update meta.workspace set network_hosts = $2 where id = $1', [wsId, bad]), /workspace_network_hosts_ok/, bad[0]);
  });

  test('done when: a workspace limited to api.example.com gets a refused request for another host, logged in debug', async () => {
    assert.equal(await callFromPage(`${mockBase}/json`), '200', 'unrestricted: the installation\'s list');
    await restrict(['api.example.com']);
    const before = seen.length;
    const msg = await callFromPage(`${mockBase}/json`);
    assert.match(msg, /not on the network access list of workspace S118 Net/);
    assert.equal(seen.length, before, 'no request was made');
    const debug = await debugMessages();
    assert.ok(debug.some((d) => d.level === 2 && d.component === 'web' && /network access list of workspace S118 Net/.test(d.message)), JSON.stringify(debug));
    const r = await owner.one('select * from meta.network_refusal where workspace_id = $1 order by id desc limit 1', [wsId]);
    assert.equal(r.app_id, appId);
    assert.equal(r.host, `127.0.0.1:${port}`);
    assert.equal(r.list, 'workspace');
    assert.equal(r.what, 'meta.web_request');
    // listed with its port: allowed
    await restrict([`127.0.0.1:${port}`]);
    await owner.query(`delete from ${SCHEMA}.log`);
    assert.equal(await callFromPage(`${mockBase}/json`), '200');
    // restricted with no hosts: nothing
    await restrict([]);
    await owner.query(`delete from ${SCHEMA}.log`);
    assert.match(await callFromPage(`${mockBase}/json`), /network access list/);
  });

  test('a workspace list only narrows: a host the installation refuses stays refused', async () => {
    await restrict(['evil.example', `127.0.0.1:${port}`]);
    const id = (await asApp((q) => q(`select meta.web_request('http://evil.example/x') as id`)))[0].id;
    await wr.webRequestTick();
    const row = await owner.one('select status, message from meta.web_request_log where id = $1', [id]);
    assert.equal(row.status, 'error');
    assert.match(row.message, /not on the server's allow-list/);
    assert.equal((await owner.one(`select list from meta.network_refusal where workspace_id = $1 and host = 'evil.example'`, [wsId])).list, 'installation');
  });

  test('a redirect that leaves the workspace list is refused', async () => {
    await restrict([`127.0.0.1:${port}`]);
    const before = seen.length;
    assert.match(await callFromPage(`${mockBase}/away`), /The host localhost:\d+ is not on the network access list/);
    assert.equal(seen.length, before + 1, 'only the first hop was made');
    await restrict([`127.0.0.1:${port}`, 'localhost']);
    await owner.query(`delete from ${SCHEMA}.log`);
    assert.equal(await callFromPage(`${mockBase}/away`), '200');
  });

  test('Administration → Network access: a workspace administrator sets the list; others are refused', async () => {
    const wa = await builder(WSADMIN);
    let page = await wa.get(`/builder/network?ws=${wsId}`);
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /Workspace S118 Net/);
    assert.match(page.body, /127\.0\.0\.1/, 'the installation\'s list');
    assert.doesNotMatch(page.body, /Private hosts/, 'administrators only');
    let res = await wa.submit('/builder/network', { ws: String(wsId), restricted: 'true', hosts: 'API.example.com\n*.example.org' });
    assert.equal(res.statusCode, 303);
    assert.deepEqual((await owner.one('select network_restricted as r, network_hosts as h from meta.workspace where id = $1', [wsId])), { r: true, h: ['api.example.com', '*.example.org'] });
    page = await wa.get(`/builder/network?ws=${wsId}&url=${encodeURIComponent(`${mockBase}/json`)}`);
    assert.match(page.body, /alert-error">The host 127\.0\.0\.1:\d+ is not on the network access list/);
    assert.match(page.body, /Not on the installation.s list, so never reachable: api\.example\.com, \*\.example\.org/);
    res = await wa.submit('/builder/network', { ws: String(wsId), restricted: 'true', hosts: 'https://x' });
    assert.match((await wa.get(`/builder/network?ws=${wsId}`)).body, /is not a host/);
    // another workspace's list: refused
    assert.equal((await wa.get(`/builder/network?ws=${otherWs}`)).statusCode, 403);
    assert.equal((await wa.submit('/builder/network', { ws: String(otherWs), restricted: 'true', hosts: '' })).statusCode, 403);
    assert.equal((await owner.one('select network_restricted from meta.workspace where id = $1', [otherWs])).network_restricted, false);
    // a developer who is not a workspace administrator: refused
    const dev = await builder(DEV);
    assert.equal((await dev.get(`/builder/network?ws=${wsId}`)).statusCode, 403);
    assert.equal((await dev.submit('/builder/network', { ws: String(wsId), restricted: 'false', hosts: '' })).statusCode, 403);
    // administrators: every workspace and the private hosts
    const admin = await builder('admin');
    page = await admin.get(`/builder/network?ws=${otherWs}`);
    assert.match(page.body, /Private hosts/);
    assert.match(page.body, /S118 Net<\/a>/);
  });

  test('the Administration menu has Mail queue and Network access', async () => {
    const wa = await builder(WSADMIN);
    await wa.submit('/builder/workspace', { workspace: String(wsId) });
    const body = (await wa.get('/builder/home')).body;
    assert.match(body, /href="\/builder\/mail-queue"[^>]*>.*Mail queue/);
    assert.match(body, /href="\/builder\/network"[^>]*>.*Network access/);
    assert.doesNotMatch((await (await builder(DEV)).get('/builder/home')).body, /Mail queue/);
  });
});

describe('mail queue and a workspace\'s own mail service', () => {
  before(() => clearTokens());
  beforeEach(() => mail.reset());

  const smtpForm = (extra: Record<string, string> = {}) => ({
    provider: 'smtp', host: '127.0.0.1', port: String(mail.smtpPort), security: 'none', auth: 'password', username: 'mailer@example.com',
    senders: '@example.com', default_from: 'app@example.com', enabled: 'true', ...extra,
  });

  test('a workspace administrator adds the workspace\'s mail service; its applications send through it; the secret is never shown', async () => {
    const wa = await builder(WSADMIN);
    let page = await wa.get(`/builder/workspaces/${wsId}/mail`);
    assert.equal(page.statusCode, 200);
    assert.doesNotMatch(page.body, /name="base_url"|name="token_url"/, 'the providers\' own APIs only');
    const res = await wa.submit(`/builder/workspaces/${wsId}/mail`, smtpForm({ secret: 'the-password', base_url: 'http://169.254.169.254', token_url: 'http://169.254.169.254/t' }));
    assert.equal(res.statusCode, 303);
    const svc = await owner.one('select * from meta.mail_service where workspace_id = $1', [wsId]);
    assert.equal(svc.name, `WORKSPACE_${wsId}`);
    assert.equal(svc.settings.base_url, undefined);
    assert.equal(svc.settings.token_url, undefined);
    assert.ok(svc.secret_enc && !svc.secret_enc.includes('the-password'));
    page = await wa.get(`/builder/workspaces/${wsId}/mail`);
    assert.doesNotMatch(page.body, /the-password|v1:/);
    assert.match(page.body, /A secret is stored/);
    // the application has no service of its own: it sends through the workspace's
    const id = (await asApp((q) => q(`select meta.send_mail('king@example.com', 'T ws mail', 'Hello') as id`)))[0].id;
    await mailTick();
    const m = await owner.one('select * from meta.mail_queue where id = $1', [id]);
    assert.equal(m.status, 'sent', m.message);
    assert.equal(m.service, `WORKSPACE_${wsId}`);
    assert.equal(m.provider, 'smtp');
    assert.ok(m.duration_ms >= 0 && m.last_attempt_at);
    assert.equal(mail.smtpHits[0].from, 'app@example.com');
    // Test connection through the same checks
    const check = await wa.request('POST', `/builder/workspaces/${wsId}/mail/check`, { __csrf: wa.lastCsrf, ...smtpForm({ check: 'connection' }) });
    assert.match(check.body, /Connected to 127\.0\.0\.1/);
  });

  test('its SMTP host must be on the workspace\'s network access list (checked on every send)', async () => {
    await restrict(['smtp.example.com']);
    const id = (await asApp((q) => q(`select meta.send_mail('king@example.com', 'T ws refused', 'Hello') as id`)))[0].id;
    await mailTick();
    const m = await owner.one('select status, message from meta.mail_queue where id = $1', [id]);
    assert.equal(m.status, 'error');
    assert.match(m.message, /not on the network access list of workspace S118 Net/);
    assert.equal(mail.smtpHits.length, 0);
    assert.ok(await owner.one(`select 1 from meta.network_refusal where workspace_id = $1 and what like 'mail service%'`, [wsId]));
    await restrict([`127.0.0.1:${mail.smtpPort}`]);
    const ok = (await asApp((q) => q(`select meta.send_mail('king@example.com', 'T ws allowed', 'Hello') as id`)))[0].id;
    await mailTick();
    assert.equal((await owner.one('select status from meta.mail_queue where id = $1', [ok])).status, 'sent');
  });

  test('done when: the Mail queue shows yesterday\'s failed message with its SMTP reply; Retry and Purge', async () => {
    mail.smtpReject.set('gone@example.com', 550);
    const id = (await asApp((q) => q(`select meta.send_mail('gone@example.com', 'T yesterday', 'Hello') as id`)))[0].id;
    await mailTick();
    await owner.query(`update meta.mail_queue set created_at = now() - interval '1 day 2 hours', last_attempt_at = now() - interval '1 day 2 hours' where id = $1`, [id]);
    const admin = await builder('admin');
    let page = await admin.get('/builder/mail-queue');
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /T yesterday/);
    assert.match(page.body, /550 5\.1\.1 no such user/, 'the SMTP server\'s reply');
    assert.match(page.body, /WORKSPACE_\d+ \(smtp\)/);
    // the workspace administrator sees it; another workspace's administrator does not; a developer is refused
    const wa = await builder(WSADMIN);
    await wa.submit('/builder/workspace', { workspace: String(wsId) });
    page = await wa.get('/builder/mail-queue?period=168');
    assert.match(page.body, /550 5\.1\.1 no such user/);
    assert.match(page.body, /Per hour/);
    assert.match(page.body, /Slowest provider calls/);
    const oa = await builder(OTHERADMIN);
    assert.doesNotMatch((await oa.get('/builder/mail-queue')).body, /T yesterday/);
    assert.equal((await oa.submit(`/builder/mail-queue/${id}/retry`, {})).statusCode, 404);
    assert.equal((await oa.submit(`/builder/mail-queue/${id}/purge`, {})).statusCode, 404);
    await oa.submit('/builder/mail-queue/purge', {});
    assert.ok(await owner.one('select 1 from meta.mail_queue where id = $1', [id]), 'another workspace\'s bulk purge leaves it');
    assert.equal((await (await builder(DEV)).get('/builder/mail-queue')).statusCode, 403);
    // Retry: queued again with fresh attempts (and sent now that the address is accepted)
    mail.smtpReject.clear();
    await wa.get('/builder/mail-queue');
    assert.equal((await wa.submit(`/builder/mail-queue/${id}/retry`, {})).statusCode, 303);
    await mailTick();
    assert.equal((await owner.one('select status from meta.mail_queue where id = $1', [id])).status, 'sent');
    // Purge
    await wa.get('/builder/mail-queue');
    assert.equal((await wa.submit(`/builder/mail-queue/${id}/purge`, {})).statusCode, 303);
    assert.ok(!(await owner.one('select 1 from meta.mail_queue where id = $1', [id])));
  });

  test('per hour and per application counts; Purge all failed of the scope', async () => {
    mail.smtpReject.set('gone@example.com', 550);
    await asApp((q) => q(`select meta.send_mail('gone@example.com', 'T fail 1', 'x'), meta.send_mail('gone@example.com', 'T fail 2', 'x'), meta.send_mail('king@example.com', 'T ok', 'x')`));
    await mailTick();
    const admin = await builder('admin');
    const page = (await admin.get(`/builder/mail-queue?ws=${wsId}`)).body;
    const row = new RegExp(`${alias}</a></td>\\s*<td class="num" data-label="Sent">(\\d+)</td><td class="num" data-label="Failed"><b>(\\d+)</b>`).exec(page);
    assert.ok(row, 'the application\'s row');
    assert.ok(Number(row![1]) >= 1 && Number(row![2]) >= 2);
    await admin.submit(`/builder/mail-queue/purge?ws=${wsId}&app=${appId}`, {});
    assert.equal((await owner.one(`select count(*)::int as n from meta.mail_queue where app_id = $1 and status = 'error'`, [appId])).n, 0);
    assert.ok((await owner.one(`select count(*)::int as n from meta.mail_queue where app_id = $1 and status = 'sent'`, [appId])).n >= 1, 'sent mail stays');
  });

  test('an application an administrator gave a service keeps it; a service of another workspace is never used', async () => {
    const other = (await owner.one(`insert into meta.mail_service (name, provider, senders, workspace_id) values ('T_S118_OTHER', 'log', '{@example.com}', $1) returning id`, [otherWs])).id;
    try {
      await owner.query(`insert into meta.app_mail_service (app_id, service_id, from_address) values ($1, $2, 'app@example.com')`, [appId, other]);
      assert.equal((await owner.one('select meta.mail_service_for_app($1) as s', [appId])).s, null, 'another workspace\'s service: none');
      await assert.rejects(asApp((q) => q(`select meta.send_mail('king@example.com', 'T other', 'x')`)), /may not send e-mail/);
    } finally {
      await owner.query('delete from meta.mail_service where id = $1', [other]);
    }
    assert.ok((await owner.one('select meta.mail_service_for_app($1) as s', [appId])).s, 'the workspace\'s own again');
  });
});
