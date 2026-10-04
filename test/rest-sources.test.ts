// REST data sources, web credentials and the invoke_api process, against a
// local mock web service and the HR example's own REST module (page 23).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';

// the server's configuration for these tests: local services are allowed
process.env.PGAPEX_SECRET_KEY = 'test-only-secret-key-0123456789abcdef';
process.env.PGAPEX_REST_ALLOWED_HOSTS = '127.0.0.1,localhost';
process.env.PGAPEX_REST_PRIVATE_HOSTS = '127.0.0.1';

const { buildApp } = await import('../src/app.ts');
const { closePools, owner } = await import('../src/db.ts');
const { decryptSecret, encryptSecret } = await import('../src/secrets.ts');
const { isPrivateAddress, urlProblem, webRequest } = await import('../src/webclient.ts');
const ws = await import('../src/websources.ts');
const { Browser, formFields } = await import('./helpers.ts');

let app: FastifyInstance;
let base = '';
let mock: http.Server;
let mockBase = '';
let appId: number;
const seen: { url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
let tokenCalls = 0;
let currentToken = '';

before(async () => {
  app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url!, headers: req.headers, body });
      const u = new URL(req.url!, 'http://x');
      const send = (status: number, v: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(typeof v === 'string' ? v : JSON.stringify(v));
      };
      if (u.pathname.startsWith('/weather/'))
        return send(200, {
          location: { name: decodeURIComponent(u.pathname.slice(9)) },
          list: [
            { day: '2026-10-04', temp: '12.5', rain: true, info: { wind: 3 } },
            { day: '2026-10-05', temp: 14, rain: 'no', info: { wind: 5 } },
            { day: 'not a date', temp: 'warm', rain: null },
          ],
          query: Object.fromEntries(u.searchParams),
        });
      if (u.pathname === '/echo') return send(200, { method: req.method, headers: req.headers, body });
      if (u.pathname === '/token') {
        tokenCalls++;
        if (req.headers.authorization !== `Basic ${Buffer.from('client-1:s3cret').toString('base64')}`) return send(401, { error: 'invalid_client' });
        currentToken = `tok-${tokenCalls}`;
        return send(200, { access_token: currentToken, token_type: 'bearer', expires_in: 3600 });
      }
      if (u.pathname === '/protected') return req.headers.authorization === `Bearer ${currentToken}` ? send(200, { ok: true }) : send(401, { error: 'expired' });
      if (u.pathname === '/loop') return send(302, {}, { location: '/loop' });
      if (u.pathname === '/redirect') return send(302, {}, { location: u.searchParams.get('to')! });
      if (u.pathname === '/big') return send(200, `"${'x'.repeat(6_000_000)}"`);
      if (u.pathname === '/slow') return setTimeout(() => send(200, {}), 3000);
      if (u.pathname === '/html') return send(200, '<html>');
      if (u.pathname === '/fail') return send(503, { error: 'down' });
      send(404, { error: 'not found' });
    });
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  mockBase = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
});

after(async () => {
  await owner.query(`delete from meta.rest_source where app_id = $1 and name like 'T\\_%'`, [appId]);
  await owner.query(`delete from meta.web_credential where app_id = $1 and name like 'T\\_%'`, [appId]);
  mock.close();
  await app.close();
  await closePools();
});

const source = (over: Partial<import('../src/websources.ts').RestSource>): import('../src/websources.ts').RestSource => ({
  id: 0, app_id: 0, name: 'T', url: `${mockBase}/echo`, method: 'GET', credential: null, headers: {}, params: [], body: null,
  row_selector: null, columns: [], cache_seconds: 0, timeout_s: 5, max_rows: 1000, ...over,
});

describe('JSON responses into rows', () => {
  test('paths, row selector, typed columns', () => {
    const doc = { data: { items: [{ a: 1, 'x y': { z: [5, 6] } }, { a: 2 }] } };
    assert.deepEqual(ws.select(doc, 'data.items[*].a'), [1, 2]);
    assert.deepEqual(ws.select(doc, '$.data.items[0]["x y"].z[1]'), [6]);
    assert.equal(ws.valueAt(doc, 'data.nope.a'), undefined);
    assert.throws(() => ws.parsePath('a[b'), /unclosed/);
    const { rows, columns } = ws.toRows({ list: [{ day: '2026-10-04', temp: '12.5', ok: 'y', n: '7', ts: 1700000000 }, { day: 'x', temp: 'warm', ok: 'maybe', n: '7.5', ts: 'nope' }] }, {
      row_selector: 'list', max_rows: 10,
      columns: [{ name: 'day', type: 'date' }, { name: 'temp', type: 'number' }, { name: 'ok', type: 'boolean' }, { name: 'n', type: 'integer' }, { name: 'ts', type: 'timestamp' }],
    });
    assert.equal(columns.length, 5);
    assert.deepEqual(rows[0], { day: '2026-10-04', temp: 12.5, ok: true, n: 7, ts: '2023-11-14T22:13:20.000Z' });
    assert.deepEqual(rows[1], { day: null, temp: null, ok: null, n: null, ts: null });
    // one object is one row; max_rows cuts
    assert.equal(ws.toRows({ a: 1 }, { row_selector: '', columns: [], max_rows: 5 }).rows.length, 1);
    assert.equal(ws.toRows([1, 2, 3].map((a) => ({ a })), { row_selector: null, columns: [], max_rows: 2 }).truncated, true);
    assert.deepEqual(ws.guessColumns([{ id: 1, Name: 'x', 'first-day': '2026-01-01', price: 1.5, tags: [] }]).map((c) => `${c.name}:${c.type}`),
      ['id:integer', 'name:text', 'first_day:date', 'price:number', 'tags:json']);
  });

  test('rows become SQL with one escaped literal; names are checked', () => {
    const sql = ws.rowsSql([{ name: 'v', type: 'text' }], [{ v: "it's :P1_X $$ --" }]);
    assert.match(sql, /jsonb_to_recordset\('.*it''s :P1_X \$\$ --.*'::jsonb\) as "__rest"\("v" text\)/);
    assert.throws(() => ws.rowsSql([{ name: 'a"; drop table x; --' }], []), /not a valid SQL name/);
    assert.equal(ws.withRest('select 1', null), 'with rest as (\nselect 1\n)\nselect * from rest');
  });

  test('definitions are checked', () => {
    assert.deepEqual(ws.sourceProblems({ url: 'https://api.example.com/v1/{id}', params: [{ name: 'id', in: 'path' }], columns: [{ name: 'a', type: 'text' }], headers: {} }), []);
    const bad = ws.sourceProblems({
      url: 'https://{host}.example.com/x/{missing}', params: [{ name: 'Bad Name', in: 'cookie' }, { name: 'host', in: 'path' }],
      columns: [{ name: 'x', type: 'money' }, { name: 'x' }], headers: { Authorization: 'Bearer x', 'X-A': 'a\r\nb' }, row_selector: 'a[',
    });
    for (const re of [/host is fixed/, /"name" is lowercase/, /"in" is one of/, /add a path parameter "missing"/, /"type" is one of/, /defined twice/, /Header Authorization: not allowed/, /one line/, /Row selector/])
      assert.ok(bad.some((p) => re.test(p)), String(re));
    assert.match(ws.sourceProblems({ url: 'https://user:pw@api.example.com/', params: [], columns: [] }).join(), /user name or password/);
    assert.match(ws.credentialProblems({ type: 'oauth2' }).join(), /token URL/);
    assert.match(ws.credentialProblems({ type: 'header', header_name: 'bad header' }).join(), /header's name/);
    assert.match(ws.credentialProblems({ type: 'bearer', valid_for: ['ftp://x'] }).join(), /not an http/);
  });

  test('requests: parameters in the path, query, headers and body', () => {
    const s = source({
      url: 'https://api.example.com/cities/{city}', method: 'POST',
      params: [{ name: 'city', in: 'path' }, { name: 'units', in: 'query', default: 'metric' }, { name: 'x_trace', in: 'header' }, { name: 'q', in: 'body' }],
    });
    const r = ws.buildRequest(s, { city: 'Den Haag/../x?y', x_trace: 'abc', q: 'he said "hi"' });
    assert.equal(r.url, 'https://api.example.com/cities/Den%20Haag%2F..%2Fx%3Fy?units=metric');
    assert.equal(r.headers['x-trace'], 'abc');
    assert.deepEqual(JSON.parse(r.body!), { q: 'he said "hi"' });
    assert.throws(() => ws.buildRequest(s, { city: '..' }), /not a valid value/);
    assert.throws(() => ws.buildRequest(s, { nope: '1' }), /no parameter nope/);
    assert.throws(() => ws.buildRequest(s, { city: 'a', x_trace: 'a\r\nInjected: 1' }), /one line/);
    const t = source({ url: 'https://api.example.com/q', method: 'POST', params: [{ name: 'q', in: 'body', required: true }], body: '{"query": {q}, "n": 1}' });
    assert.deepEqual(JSON.parse(ws.buildRequest(t, { q: 'a"b' }).body!), { query: 'a"b', n: 1 });
    assert.throws(() => ws.buildRequest(t, {}), /needs a value for q/);
  });
});

describe('secrets', () => {
  test('encrypted with the key, authenticated, and useless without it', () => {
    const enc = encryptSecret('p@ss');
    assert.match(enc, /^v1:/);
    assert.ok(!enc.includes('p@ss'));
    assert.notEqual(encryptSecret('p@ss'), enc, 'a fresh IV each time');
    assert.equal(decryptSecret(enc), 'p@ss');
    const tampered = `v1:${Buffer.from(Buffer.from(enc.slice(3), 'base64').map((b, i) => (i === 30 ? b ^ 1 : b))).toString('base64')}`;
    assert.throws(() => decryptSecret(tampered), /cannot be decrypted/);
    const key = process.env.PGAPEX_SECRET_KEY;
    try {
      process.env.PGAPEX_SECRET_KEY = 'another-key-of-at-least-32-characters!!';
      assert.throws(() => decryptSecret(enc), /cannot be decrypted/);
      process.env.PGAPEX_SECRET_KEY = 'short';
      assert.throws(() => encryptSecret('x'), /PGAPEX_SECRET_KEY/);
    } finally {
      process.env.PGAPEX_SECRET_KEY = key;
    }
  });
});

describe('outgoing requests (SSRF protection)', () => {
  test('addresses: private, loopback, link-local and mapped forms are not public', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fd00::1',
      '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a9fe:a9fe', '2002:7f00:1::', '224.0.0.1', 'not-an-ip'])
      assert.equal(isPrivateAddress(ip), true, ip);
    for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
  });

  test('the allow-list, schemes, and credentials in URLs', () => {
    assert.equal(urlProblem(`${mockBase}/x`), null);
    assert.match(urlProblem('https://example.com/')!, /not on the server's allow-list/);
    assert.match(urlProblem('file:///etc/passwd')!, /Only http and https/);
    assert.match(urlProblem('http://user:pw@127.0.0.1/')!, /user name or password/);
    assert.match(urlProblem('http://[::1]/')!, /allow-list/);
    const saved = process.env.PGAPEX_REST_ALLOWED_HOSTS;
    const savedPrivate = process.env.PGAPEX_REST_PRIVATE_HOSTS;
    try {
      process.env.PGAPEX_REST_PRIVATE_HOSTS = '';
      process.env.PGAPEX_REST_ALLOWED_HOSTS = '*.example.com, api.other.org:8443, 10.0.0.5';
      assert.equal(urlProblem('https://api.example.com/'), null);
      assert.match(urlProblem('https://example.com/')!, /allow-list/, 'the wildcard is for subdomains');
      assert.match(urlProblem('https://evilexample.com/')!, /allow-list/);
      assert.equal(urlProblem('https://api.other.org:8443/'), null);
      assert.match(urlProblem('https://api.other.org/')!, /allow-list/, 'another port');
      assert.match(urlProblem('http://10.0.0.5/')!, /private/, 'allowed, but private');
      assert.match(urlProblem('http://0x7f000001/')!, /allow-list/, 'numeric forms are normalised first');
      process.env.PGAPEX_REST_ALLOWED_HOSTS = '';
      assert.match(urlProblem(`https://api.example.com/`)!, /allow-list/, 'unset: nothing is allowed');
    } finally {
      process.env.PGAPEX_REST_ALLOWED_HOSTS = saved;
      process.env.PGAPEX_REST_PRIVATE_HOSTS = savedPrivate;
    }
  });

  test('host names are checked after DNS resolution; redirects are checked too', async () => {
    const port = new URL(mockBase).port;
    // localhost is allowed, but resolves to a loopback address that is not
    await assert.rejects(webRequest(`http://localhost:${port}/echo`), /resolves to a private/);
    await assert.rejects(webRequest(`${mockBase}/redirect?to=${encodeURIComponent(`http://localhost:${port}/echo`)}`), /resolves to a private/);
    await assert.rejects(webRequest(`${mockBase}/redirect?to=${encodeURIComponent('http://169.254.169.254/latest/meta-data/')}`), /allow-list/);
    await assert.rejects(webRequest(`${mockBase}/loop`), /redirected too often/);
    // a same-origin redirect keeps the secret header, a cross-origin one drops it
    const other = http.createServer((req, res) => res.end(JSON.stringify({ auth: req.headers.authorization ?? null })));
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
    try {
      const to = `http://127.0.0.1:${(other.address() as AddressInfo).port}/`;
      const res = await webRequest(`${mockBase}/redirect?to=${encodeURIComponent(to)}`, { headers: { authorization: 'Bearer secret' }, secretHeaders: ['authorization'] });
      assert.deepEqual(JSON.parse(res.body.toString()), { auth: null });
    } finally {
      other.close();
    }
  });

  test('time and size limits', async () => {
    await assert.rejects(webRequest(`${mockBase}/slow`, { timeoutMs: 300 }), /did not answer in time/);
    await assert.rejects(webRequest(`${mockBase}/big`), /larger than/);
    await assert.rejects(webRequest(`${mockBase}/echo`, { maxBytes: 10 }), /larger than/);
  });
});

describe('web credentials', () => {
  const cred = (over: Partial<import('../src/websources.ts').WebCredential>): import('../src/websources.ts').WebCredential => ({
    id: 900001, app_id: 0, name: 'T', type: 'basic', username: 'u', header_name: null, token_url: null, scope: null, valid_for: [], secret_enc: encryptSecret('s3cret'), ...over,
  });
  const echo = async (c: import('../src/websources.ts').WebCredential, url = `${mockBase}/echo`) => JSON.parse((await ws.call({ url, credential: c })).body.toString()).headers;

  test('basic, bearer and header credentials sign the request', async () => {
    assert.equal((await echo(cred({}))).authorization, `Basic ${Buffer.from('u:s3cret').toString('base64')}`);
    assert.equal((await echo(cred({ type: 'bearer' }))).authorization, 'Bearer s3cret');
    assert.equal((await echo(cred({ type: 'header', header_name: 'X-API-Key' })))['x-api-key'], 's3cret');
    await assert.rejects(echo(cred({ secret_enc: null })), /has no secret yet/);
  });

  test('"valid for" keeps a credential to its URLs', async () => {
    const c = cred({ type: 'bearer', valid_for: [`${mockBase}/ec`, `${mockBase}/api/`] });
    await assert.rejects(echo(c), /not valid for this URL/, 'a prefix ends at a path segment');
    assert.equal(ws.credentialValidFor(c, `${mockBase}/api/x`), true);
    assert.equal(ws.credentialValidFor(c, `${mockBase}/api`), true);
    assert.equal(ws.credentialValidFor(c, `${mockBase}/apix`), false);
    assert.equal(ws.credentialValidFor({ valid_for: ['https://api.example.com/'] }, 'https://api.example.com.evil.org/'), false);
  });

  test('OAuth2 client credentials: the token is cached, and fetched again after a 401', async () => {
    ws.clearTokens();
    const c = cred({ id: 900002, type: 'oauth2', username: 'client-1', token_url: `${mockBase}/token`, scope: 'read' });
    const before = tokenCalls;
    for (let i = 0; i < 3; i++) assert.equal((await ws.call({ url: `${mockBase}/protected`, credential: c })).status, 200);
    assert.equal(tokenCalls - before, 1, 'one token for three calls');
    const req = [...seen].reverse().find((s) => s.url === '/token')!;
    assert.equal(new URLSearchParams(req.body).get('grant_type'), 'client_credentials');
    assert.equal(new URLSearchParams(req.body).get('scope'), 'read');
    currentToken = 'revoked';
    assert.equal((await ws.call({ url: `${mockBase}/protected`, credential: c })).status, 200, 'renewed after a 401');
    assert.equal(tokenCalls - before, 2);
    await assert.rejects(ws.call({ url: `${mockBase}/protected`, credential: cred({ id: 900003, type: 'oauth2', username: 'client-1', token_url: `${mockBase}/token`, secret_enc: encryptSecret('wrong') }) }),
      (e: Error) => /answered 401 \(invalid_client\)/.test(e.message) && !e.message.includes('wrong'));
  });

  test('the HR API through pgapex\'s own OAuth endpoint', async () => {
    const client = await owner.one(`select * from meta.oauth_create_client('hr', 'rest-sources-test', '{admin}')`);
    try {
      const c = cred({ id: 900004, type: 'oauth2', username: client.client_id, token_url: `${base}/oauth/token`, secret_enc: encryptSecret(client.client_secret) });
      const res = await ws.call({ url: `${base}/a/hr/rest/v1/employees?limit=3`, credential: c });
      assert.equal(res.status, 200);
      assert.equal(JSON.parse(res.body.toString()).items.length, 3);
    } finally {
      await owner.query(`delete from meta.api_client where app_id = $1 and name = 'rest-sources-test'`, [appId]);
    }
  });
});

describe('REST data sources in applications (HR page 23)', () => {
  const urls = new Map<string, string>();
  before(async () => {
    for (const r of (await owner.query(`select name, url from meta.rest_source where app_id = $1`, [appId])).rows) {
      urls.set(r.name, r.url);
      await owner.query('update meta.rest_source set url = replace(url, $3, $4) where app_id = $1 and name = $2', [appId, r.name, 'http://127.0.0.1:3100', base]);
    }
    await owner.query(`update meta.web_credential set token_url = replace(token_url, 'http://127.0.0.1:3100', $2), valid_for = array[$2 || '/a/hr/rest/'] where app_id = $1 and name = 'HR_API'`, [appId, base]);
    ws.clearResponseCache();
  });
  after(async () => {
    for (const [name, url] of urls) await owner.query('update meta.rest_source set url = $3 where app_id = $1 and name = $2', [appId, name, url]);
    await owner.query(`update meta.web_credential set token_url = 'http://127.0.0.1:3100/oauth/token', valid_for = '{http://127.0.0.1:3100/a/hr/rest/}' where app_id = $1 and name = 'HR_API'`, [appId]);
  });

  test('a report, cards and a list of values read the source; invoke_api fills items', async () => {
    const b = new Browser(app);
    await b.login('allen');
    const page = await b.get('/a/hr/23');
    assert.equal(page.statusCode, 200);
    assert.doesNotMatch(page.body, /alert-error/);
    assert.match(page.body, /ACCOUNTING/);
    assert.match(page.body, /<option value="10"[^>]*>ACCOUNTING<\/option>/, 'the list of values');
    assert.match(page.body, /card/);
    const fields = formFields(page.body);
    const res = await b.submit('/a/hr/23', { ...fields, P23_DEPTNO: '20', __request: 'LOOKUP' });
    assert.equal(res.statusCode, 303);
    const after = await b.get('/a/hr/23');
    assert.match(after.body, /RESEARCH/);
    assert.match(after.body, /Dallas/);
    assert.match(after.body, /The API answered/);
  });

  test('cached responses are reused; errors are shown without details', async () => {
    const id = (await owner.one(`insert into meta.rest_source (app_id, name, url, params, row_selector, columns, cache_seconds) values ($1, 'T_WEATHER', $2, $3, 'list', $4, 60) returning id`, [
      appId, `${mockBase}/weather/{city}`, JSON.stringify([{ name: 'city', in: 'path', default: '&APP_USER.' }, { name: 'units', in: 'query', default: 'metric' }]),
      JSON.stringify([{ name: 'day', type: 'date' }, { name: 'temp', type: 'number' }, { name: 'wind', path: 'info.wind', type: 'integer' }]),
    ])).id;
    const page = (await owner.one(`select p.id from meta.page p where p.app_id = $1 and p.page_no = 23`, [appId])).id;
    const region = (await owner.one(`insert into meta.region (page_id, seq, title, type, columns, rest_source, source, config) values ($1, 99, 'T weather', 'report', 12, 'T_WEATHER', 'select day, temp, wind, temp * 2 as double from rest where :P23_DEPTNO is null', '{"rest_params": {"units": "imperial"}}') returning id`, [page])).id;
    try {
      const b = new Browser(app);
      await b.login('allen');
      const n = seen.length;
      const body = (await b.get('/a/hr/23')).body;
      assert.match(body, /2026-10-04/);
      assert.match(body, /25\.0|>25</, 'typed: a number in SQL');
      const call = seen.slice(n).find((s) => s.url.startsWith('/weather/'))!;
      assert.equal(call.url, '/weather/allen?units=imperial', 'parameters: default with a substitution, and the region\'s value');
      await b.get('/a/hr/23');
      assert.equal(seen.slice(n).filter((s) => s.url.startsWith('/weather/')).length, 1, 'cached for 60 seconds');
      // a failing service: the region shows a reference, the activity log has the details
      await owner.query(`update meta.rest_source set url = $2, cache_seconds = 0 where id = $1`, [id, `${mockBase}/fail`]);
      const failed = (await b.get('/a/hr/23')).body;
      assert.match(failed, /alert-error/);
      assert.doesNotMatch(failed, /answered 503/);
      assert.ok(await owner.one(`select 1 from meta.activity_log where event = 'error' and detail like '%answered 503%' and at > now() - interval '1 minute'`));
      // not JSON
      await owner.query(`update meta.rest_source set url = $2 where id = $1`, [id, `${mockBase}/html`]);
      assert.match((await b.get('/a/hr/23')).body, /alert-error/);
    } finally {
      await owner.query('delete from meta.region where id = $1', [region]);
    }
  });
});
