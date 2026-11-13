// Sprint 176 (parity leftover DA-3; migration 158): share links for query results. The worksheet's Query Result has
// Share: the SELECT is kept behind a random token (meta.sql_share) and /builder/sql/shared/<token> runs it again,
// read-only, for a developer of the same workspace. The maker (or an administrator) renames, extends and stops it.
// DA-11 leftover (migration 159): meta.rest_header sets a response header of a PL/pgSQL REST handler.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { MAX_SHARES, shareTitle, shareToken } from '../src/builder/sql-shares.ts';
import { replyHeaders } from '../src/runtime/rest-handlers.ts';
import { issueApiToken } from '../src/api.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
const S = 'sh176';
const DEV = 'sh176_dev';
const PW = 'Sh176-dev-password!';
const SQL = `select region, amount from ${S}.sale order by region`;

const clean = async () => {
  await owner.query(`delete from meta.sql_share where created_by in ('admin', $1) and (sql like '%sh176%' or title like 'sh176%')`, [DEV]);
  await owner.query(`delete from meta.developer where username = $1`, [DEV]);
};
before(async () => {
  app = await buildApp({ logger: false });
  await owner.query(`drop schema if exists ${S} cascade; create schema ${S}; create table ${S}.sale (region text, amount numeric);
    insert into ${S}.sale values ('North', 100), ('South', 250.5), ('West', null);
    grant usage on schema ${S} to hr_app; grant select on ${S}.sale to hr_app`); // (sprint 185) what the workspace's developer login reads
  await clean();
  await owner.query(`insert into meta.developer (username, password_hash, is_admin) values ($1, meta.hash_password($2), false)`, [DEV, PW]);
});
after(async () => {
  await clean();
  await owner.query(`drop schema if exists ${S} cascade`);
  await app.close();
  await closePools();
});
const builder = async (username = 'admin', password = 'admin') => {
  const b = new Browser(app);
  await b.get('/builder/login');
  assert.equal((await b.submit('/builder/login', { username, password })).statusCode, 303);
  if (username === 'admin') await b.ownerConnection(); // (sprint 185) the owner's schemas: the Owner connection
  await b.get('/builder/sql/worksheet');
  return b;
};
const share = async (b: Browser, query = SQL, extra: Record<string, string> = {}) => {
  const res = await b.submit('/builder/sql/shared', { query, ...extra });
  assert.equal(res.statusCode, 303);
  return String(res.headers.location);
};

describe('share links for query results (DA-3)', () => {
  test('a token is 32 URL-safe characters, never the same twice; a title is the query on one line', () => {
    const a = shareToken();
    assert.match(a, /^[A-Za-z0-9_-]{32}$/);
    assert.notEqual(a, shareToken());
    assert.equal(shareTitle('select 1\n  from x'), 'select 1 from x');
    assert.equal(shareTitle(`select ${'x'.repeat(200)}`).length, 80);
  });

  test('the worksheet offers Share for a SELECT; the link shows the result, the query and its own address', async () => {
    const b = await builder();
    const page = (await b.submit('/builder/sql/worksheet', { sql: SQL, mode: 'statement' })).body;
    assert.match(page, /<button class="btn btn-sm" form="ws-dl" formaction="\/builder\/sql\/shared"/);
    assert.match(page, /href="\/builder\/sql\/shared"/, 'the list is in the worksheet\'s menu');
    const dml = (await b.submit('/builder/sql/worksheet', { sql: `update ${S}.sale set amount = amount returning region`, mode: 'statement' })).body;
    assert.doesNotMatch(dml, /formaction="\/builder\/sql\/shared"/, 'not one SELECT: nothing to share');
    const to = await share(b);
    assert.match(to, /^\/builder\/sql\/shared\/[A-Za-z0-9_-]{32}$/);
    const row = (await owner.one(`select title, sql, created_by, round(extract(epoch from expires_at - created_at) / 86400)::int as days from meta.sql_share where token = $1`, [to.split('/').pop()]))!;
    assert.deepEqual(row, { title: SQL, sql: SQL, created_by: 'admin', days: 7 });
    const res = await b.get(to);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['referrer-policy'], 'same-origin', 'the token is not sent to another site');
    assert.match(String(res.headers['cache-control']), /no-store/);
    assert.match(res.body, /<td>North<\/td><td class="num">100<\/td>/);
    assert.match(res.body, /<td>West<\/td><td class="num"><span class="null">\(null\)<\/span><\/td>/);
    assert.match(res.body, new RegExp(`readonly value="[^"]*${to}"`));
    assert.match(res.body, /Shared by admin on /);
    // the rows are read when the link opens, not when it was made
    await owner.query(`insert into ${S}.sale values ('East', 5)`);
    assert.match((await b.get(to)).body, /<td>East<\/td>/);
    await owner.query(`delete from ${S}.sale where region = 'East'`);
  });

  test('a name and a number of days when sharing; the maker renames and extends, opens it in the worksheet and stops it', async () => {
    const b = await builder();
    const to = await share(b, `${SQL};`, { title: 'sh176 sales', days: '30' });
    const token = to.split('/').pop();
    const days = async () => (await owner.one(`select round(extract(epoch from expires_at - now()) / 86400)::int as d from meta.sql_share where token = $1`, [token]))?.d;
    assert.equal(await days(), 30);
    assert.match((await b.get('/builder/sql/shared')).body, new RegExp(`<a href="${to}">sh176 sales</a>`));
    await b.get(to);
    await b.submit(to, { action: 'save', title: 'sh176 renamed', days: '' });
    assert.equal(await days(), 30, 'the end stays without a choice');
    await b.submit(to, { action: 'save', title: 'sh176 renamed', days: '1' });
    assert.equal(await days(), 1);
    assert.match((await b.get(to)).body, /<h1 class="u-mb1">sh176 renamed<\/h1>/);
    assert.equal((await b.submit(to, { action: 'save', title: ' ' })).statusCode, 303);
    assert.equal((await owner.one('select title from meta.sql_share where token = $1', [token]))!.title, 'sh176 renamed', 'an empty name is refused');
    const open = await b.submit(to, { action: 'worksheet' });
    assert.equal(open.headers.location, '/builder/sql/worksheet');
    assert.match((await b.get('/builder/sql/worksheet')).body, new RegExp(`select region, amount from ${S}\\.sale order by region`));
    await b.get(to);
    assert.equal((await b.submit(to, { action: 'stop' })).headers.location, '/builder/sql/shared');
    assert.equal((await b.get(to)).statusCode, 404);
  });

  test('another developer of the workspace reads it and opens it in the worksheet, but cannot change or stop it', async () => {
    const admin = await builder();
    const to = await share(admin, SQL, { title: 'sh176 for others' });
    const dev = await builder(DEV, PW);
    const page = await dev.get(to);
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /<td>South<\/td>/);
    assert.doesNotMatch(page.body, /value="stop"|name="title"/, 'no controls for a reader');
    assert.equal((await dev.submit(to, { action: 'worksheet' })).headers.location, '/builder/sql/worksheet');
    assert.equal((await dev.submit(to, { action: 'stop' })).statusCode, 403);
    assert.equal((await dev.submit(to, { action: 'save', title: 'sh176 taken' })).statusCode, 403);
    assert.equal((await owner.one('select title from meta.sql_share where token = $1', [to.split('/').pop()]))!.title, 'sh176 for others');
    const list = (await dev.get('/builder/sql/shared')).body;
    assert.match(list, /sh176 for others/);
    // the developer's own link: theirs to stop, and the administrator's too
    const own = await share(dev, SQL, { title: 'sh176 by dev' });
    await admin.get(own);
    assert.equal((await admin.submit(own, { action: 'stop' })).statusCode, 303);
    assert.equal((await dev.get(own)).statusCode, 404);
  });

  test('an ended link, an unknown token and a statement that is not one SELECT', async () => {
    const b = await builder();
    const to = await share(b, SQL, { title: 'sh176 ended' });
    await owner.query(`update meta.sql_share set expires_at = now() - interval '1 second' where token = $1`, [to.split('/').pop()]);
    assert.equal((await b.get(to)).statusCode, 404);
    assert.doesNotMatch((await b.get('/builder/sql/shared')).body, /sh176 ended/);
    assert.equal((await b.get(`/builder/sql/shared/${'a'.repeat(32)}`)).statusCode, 404);
    assert.equal((await b.get('/builder/sql/shared/short')).statusCode, 404);
    // sharing again removes the ended ones
    await share(b, SQL, { title: 'sh176 fresh' });
    assert.equal(await owner.one(`select 1 as x from meta.sql_share where title = 'sh176 ended'`), undefined);
    const count = async () => (await owner.one(`select count(*)::int as n from meta.sql_share`))!.n;
    const before = await count();
    for (const query of [`delete from ${S}.sale`, 'select 1; select 2', '', `select ${'1'.repeat(20001)}`]) {
      const res = await b.submit('/builder/sql/shared', { query });
      assert.equal(res.headers.location, '/builder/sql/worksheet', query.slice(0, 30));
    }
    assert.equal(await count(), before, 'nothing was shared');
    // a query that fails now says so on the link's page
    const gone = await share(b, `select * from ${S}.nothing_here`, { title: 'sh176 gone' });
    const page = await b.get(gone);
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /class="alert alert-error">[^<]*nothing_here/);
    assert.ok(MAX_SHARES >= 100);
  });
});

describe('RESTful Services: response headers of a PL/pgSQL handler (DA-11)', () => {
  let token = '';
  let appId = 0;
  const REASON = 'sh176 rest header';
  const handlers = [
    { method: 'POST', path: 'made', type: 'plpgsql', source: `begin perform meta.rest_header('Location', '/a/hr/rest/m176/made/' || :ID); perform meta.rest_header('X-Made-By', :APP_USER); perform meta.rest_reply(jsonb_build_object('id', :ID::int), 201); end` },
    { method: 'GET', path: 'plain', type: 'plpgsql', source: `begin perform meta.rest_header('X-Trace', 'a'); perform meta.rest_header('x-trace', 'b'); perform meta.rest_header('X-Gone', 'x'); perform meta.rest_header('X-Gone', null); perform meta.rest_reply('{"ok": true}'); end` },
    { method: 'GET', path: 'empty', type: 'plpgsql', source: `begin perform meta.rest_header('X-Only', 'header'); end` },
    { method: 'GET', path: 'refused/:name', type: 'plpgsql', source: `begin perform meta.rest_header(:NAME, 'x'); perform meta.rest_reply('{"ok": true}'); end` },
    { method: 'GET', path: 'value', type: 'plpgsql', source: `begin perform meta.rest_header('X-Long', repeat('x', 2001)); end` },
    { method: 'GET', path: 'many', type: 'plpgsql', source: `begin for i in 1..21 loop perform meta.rest_header('X-H' || i, 'v'); end loop; end` },
  ];
  const call = (method: 'GET' | 'POST', path: string, payload?: unknown) =>
    app.inject({ method, url: `/a/hr/rest/m176/${path}`, headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json' } : {}) }, ...(payload ? { payload: JSON.stringify(payload) } : {}) });
  before(async () => {
    appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
    token = (await issueApiToken(appId, 'king', 1)).token;
    await owner.query(`delete from meta.rest_module where app_id = $1 and name = 'm176'`, [appId]);
    await owner.query(`insert into meta.rest_module (app_id, name, title, handlers) values ($1, 'm176', 'Sprint 176', $2)`, [appId, JSON.stringify(handlers)]);
  });
  after(async () => {
    await owner.query(`delete from meta.rest_module where app_id = $1 and name = 'm176'`, [appId]);
    await owner.query('delete from hr.leave_request where reason = $1', [REASON]);
  });

  test('replyHeaders keeps well-formed headers and drops the server\'s own, bad names and values', () => {
    assert.deepEqual(replyHeaders('{"location": "/x", "X-Trace": "1"}'), { location: '/x', 'x-trace': '1' });
    assert.deepEqual(replyHeaders(JSON.stringify({ 'set-cookie': 'a=b', 'content-type': 'text/html', etag: '"x"', 'access-control-allow-origin': '*', 'x bad': 'v', 'x-lines': 'a\r\nSet-Cookie: b', 'x-num': 5, 'x-ok': 'v' })), { 'x-ok': 'v' });
    for (const bad of ['', 'not json', '[1]', '"text"', null, undefined]) assert.deepEqual(replyHeaders(bad), {});
  });

  test('a handler sets headers next to its reply; the last value of a name wins, null takes one back', async () => {
    const made = await call('POST', 'made', { id: 7 });
    assert.equal(made.statusCode, 201);
    assert.equal(made.headers.location, '/a/hr/rest/m176/made/7');
    assert.equal(made.headers['x-made-by'], 'king');
    assert.deepEqual(made.json(), { id: 7 });
    const plain = await call('GET', 'plain');
    assert.equal(plain.headers['x-trace'], 'b');
    assert.equal(plain.headers['x-gone'], undefined);
    assert.match(String(plain.headers.etag), /^"/, 'the ETag is still the server\'s');
    const empty = await call('GET', 'empty');
    assert.equal(empty.statusCode, 204);
    assert.equal(empty.headers['x-only'], 'header');
    // headers do not leak into the next request
    assert.equal((await call('GET', 'refused/x-fine')).headers['x-only'], undefined);
  });

  test('the server\'s headers, a bad name, a long value and too many are refused with a 400', async () => {
    for (const name of ['set-cookie', 'Content-Type', 'etag', 'Access-Control-Allow-Origin', 'content-security-policy', 'x_bad']) {
      const res = await call('GET', `refused/${name}`);
      assert.equal(res.statusCode, 400, name);
      assert.match(res.json().error, /meta\.rest_header/, name);
    }
    assert.equal((await call('GET', 'refused/x-fine')).statusCode, 200);
    assert.match((await call('GET', 'value')).json().error, /one line of at most 2000/);
    assert.match((await call('GET', 'many')).json().error, /at most 20 headers/);
  });

  test('the HR module: POST leave answers with the Location of the new request, GET leave/:id reads it', async () => {
    const allen = (await issueApiToken(appId, 'allen', 1)).token;
    const res = await app.inject({ method: 'POST', url: '/a/hr/rest/hr/leave', headers: { authorization: `Bearer ${allen}`, 'content-type': 'application/json' }, payload: JSON.stringify({ start_date: '2033-06-06', end_date: '2033-06-07', reason: REASON }) });
    assert.equal(res.statusCode, 201, res.body);
    const id = res.json().id;
    assert.equal(res.headers.location, `/a/hr/rest/hr/leave/${id}`);
    const read = await app.inject({ url: String(res.headers.location), headers: { authorization: `Bearer ${allen}` } });
    assert.equal(read.statusCode, 200);
    assert.equal(read.json().id, id);
    assert.equal(read.json().status, 'PENDING');
  });
});
