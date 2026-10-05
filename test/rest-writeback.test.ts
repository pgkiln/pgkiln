// REST data sources that write back (forms, interactive grids), their
// synchronisation into local tables, and the OAuth2 password and refresh
// token grants of web credentials: against a local mock web service and the
// HR example's sample CRM (page 34).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';

process.env.PGAPEX_SECRET_KEY = 'test-only-secret-key-0123456789abcdef';
process.env.PGAPEX_REST_ALLOWED_HOSTS = '127.0.0.1,localhost';
process.env.PGAPEX_REST_PRIVATE_HOSTS = '127.0.0.1';

const { buildApp } = await import('../src/app.ts');
const { closePools, owner, runtime } = await import('../src/db.ts');
const { encryptSecret } = await import('../src/secrets.ts');
const ws = await import('../src/websources.ts');
const sync = await import('../src/restsync.ts');
const { Browser, formFields } = await import('./helpers.ts');

const unescape = (v: string) => v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
/** The posted fields of a grid (as test/grid.test.ts). */
function gridForm(body: string, g: string) {
  const form: Record<string, string> = {};
  for (const m of body.matchAll(new RegExp(`<input([^>]*)name="(${g}_\\d+_[a-z0-9]+)"[^>]*value="([^"]*)"[^>]*>`, 'g'))) {
    if (/type="checkbox"/.test(m[0]) && !/ checked/.test(m[0])) continue;
    form[m[2]] = unescape(m[3]);
  }
  return form;
}

let app: FastifyInstance;
let base = '';
let mock: http.Server;
let mockBase = '';
let appId: number;
const seen: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];

// the mock service: /items (a collection with GET/POST/PUT/PATCH/DELETE), /token (OAuth2)
let items: { id: number; name: string; size: number | null; meta?: unknown }[] = [];
let tokenResponses: { grant: string; refresh: string | null }[] = [];
let refreshValid = new Set<string>();
let nextRefresh = 1;
let access = '';

before(async () => {
  app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      const u = new URL(req.url!, 'http://x');
      const send = (status: number, v?: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(v === undefined ? '' : JSON.stringify(v));
      };
      if (u.pathname === '/token') {
        const f = new URLSearchParams(body);
        const grant = f.get('grant_type')!;
        if (grant === 'password' && !(f.get('username') === 'robot' && f.get('password') === 'pa55')) return send(400, { error: 'invalid_grant' });
        if (grant === 'refresh_token') {
          if (!refreshValid.has(f.get('refresh_token')!)) return send(400, { error: 'invalid_grant' });
          refreshValid.delete(f.get('refresh_token')!); // rotation: a refresh token works once
        }
        const refresh = `rt-${nextRefresh++}`;
        refreshValid.add(refresh);
        access = `at-${refresh}`;
        tokenResponses.push({ grant, refresh });
        return send(200, { access_token: access, token_type: 'bearer', expires_in: 3600, refresh_token: refresh });
      }
      if (u.pathname === '/secure') return req.headers.authorization === `Bearer ${access}` ? send(200, { ok: true }) : send(401, {});
      const m = /^\/items(?:\/(\d+))?$/.exec(u.pathname);
      if (!m) return send(404, { error: 'not found' });
      const id = m[1] ? Number(m[1]) : null;
      const json = body ? JSON.parse(body) : {};
      if (req.method === 'GET' && id === null) return send(200, { data: items });
      const at = items.findIndex((x) => x.id === id);
      if (req.method === 'GET') return at < 0 ? send(404, {}) : send(200, items[at]);
      if (req.method === 'POST') {
        const row = { id: Math.max(0, ...items.map((x) => x.id)) + 1, name: json.name, size: json.size ?? null, meta: json.meta };
        items.push(row);
        return send(201, { result: row });
      }
      if (at < 0) return send(404, {});
      if (req.method === 'PUT') {
        items[at] = { id: id!, name: json.name, size: json.size ?? null, meta: json.meta };
        return send(200, items[at]);
      }
      if (req.method === 'PATCH') {
        items[at] = { ...items[at], ...json };
        return send(200, items[at]);
      }
      if (req.method === 'DELETE') {
        items.splice(at, 1);
        return send(204);
      }
      send(405, {});
    });
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  mockBase = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
});

after(async () => {
  await owner.query(`delete from meta.rest_source where app_id = $1 and name like 'T\\_%'`, [appId]);
  await owner.query(`delete from meta.web_credential where app_id = $1 and name like 'T\\_%'`, [appId]);
  await owner.query('drop table if exists hr.t_sync_copy');
  mock.close();
  await app.close();
  await closePools();
});

type Source = import('../src/websources.ts').RestSource;
const source = (over: Partial<Source>): Source => ({
  id: 0, app_id: 0, name: 'T', url: `${mockBase}/items`, method: 'GET', credential: null, headers: {}, params: [], body: null,
  row_selector: 'data', columns: [{ name: 'id', type: 'integer' }, { name: 'name', type: 'text' }, { name: 'size', type: 'number' }],
  cache_seconds: 0, timeout_s: 5, max_rows: 1000, key_columns: ['id'],
  operations: { insert: { row_selector: 'result' }, update: { path: '/{id}' }, delete: { path: '/{id}' }, fetch: { path: '/{id}' } }, ...over,
});

describe('write-back operations (pure)', () => {
  test('definitions are checked: operation names, methods, paths, key columns', () => {
    assert.deepEqual(ws.operationProblems(source({})), []);
    const bad = ws.operationProblems({
      url: 'https://api.example.com/items', columns: [{ name: 'id' }], params: [], key_columns: ['nope', 'Bad-Name'],
      operations: { insert: { method: 'TRACE' }, upsert: {}, update: { path: 'https://evil.example.com/{id}' }, delete: { path: '/../{id}' }, fetch: { path: '/{other}', extra: 1 } },
    });
    for (const re of [/Key columns are column names/, /"method" is one of/, /operations are insert, update, delete, fetch/, /Operation update: "path" follows/, /Operation delete: "path" follows/,
      /\{other\}, which is not a column/, /unknown key "extra"/])
      assert.ok(bad.some((p) => re.test(p)), String(re));
    assert.ok(ws.operationProblems({ columns: [{ name: 'id' }], key_columns: [], operations: { update: { path: '/{id}' } } }).some((p) => /set the key columns first/.test(p)));
    assert.ok(ws.operationProblems({ columns: [{ name: 'id' }], key_columns: ['x'] }).some((p) => /Key column x is not one of the columns/.test(p)));
    // the builder's checks include them
    assert.ok(ws.sourceProblems({ url: 'https://a.example.com/x', params: [], columns: [], operations: [] }).some((p) => /Operations must be a JSON object/.test(p)));
  });

  test('requests: the path follows the URL, values are encoded, the host is fixed', () => {
    const s = source({ url: `${mockBase}/items?limit=5`, headers: { 'X-Tenant': 'a' } });
    const del = ws.buildOperation(s, 'delete', { id: '7/../../admin?x=1#' });
    assert.equal(del.url, `${mockBase}/items/7%2F..%2F..%2Fadmin%3Fx%3D1%23`, 'one encoded path segment, the query of the URL dropped');
    assert.equal(del.method, 'DELETE');
    assert.equal(del.body, undefined);
    assert.equal(del.headers['x-tenant'], 'a');
    assert.throws(() => ws.buildOperation(s, 'delete', { id: '..' }), /not a valid value in a URL/);
    assert.throws(() => ws.buildOperation(s, 'update', { id: '' }), /needs a value for id/);
    assert.throws(() => ws.buildOperation(source({ operations: {} }), 'insert', {}), /has no insert operation/);
    // a query-string path
    assert.equal(ws.buildOperation(source({ operations: { delete: { path: '?id={id}' } } }), 'delete', { id: 'a b&c' }).url, `${mockBase}/items?id=a%20b%26c`);
    // path parameters of the URL come from the row or the parameters
    const p = source({ url: `${mockBase}/t/{tenant}/items`, params: [{ name: 'tenant', in: 'path', default: 'x' }] });
    assert.equal(ws.buildOperation(p, 'fetch', { id: 3 }, { tenant: 'acme' }).url, `${mockBase}/t/acme/items/3`);
  });

  test('bodies: the row as JSON (nested by column paths), or a template with JSON values', () => {
    const s = source({ columns: [{ name: 'id', type: 'integer' }, { name: 'name', type: 'text' }, { name: 'size', path: 'dims.size', type: 'number' }, { name: 'tags', type: 'json' }, { name: 'ok', type: 'boolean' }] });
    const ins = ws.buildOperation(s, 'insert', { name: 'Box "1"', size: '12.5', tags: '["a"]', ok: 'yes' });
    assert.equal(ins.method, 'POST');
    assert.equal(ins.url, `${mockBase}/items`);
    assert.equal(ins.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(ins.body!), { name: 'Box "1"', dims: { size: 12.5 }, tags: ['a'], ok: true });
    const t = source({ operations: { update: { method: 'PATCH', path: '/{id}', body: '{"label": {name}, "n": {size}, "id": {id}}' } } });
    const up = ws.buildOperation(t, 'update', { id: 4, name: 'He said "hi"', size: '' });
    assert.equal(up.method, 'PATCH');
    assert.equal(up.url, `${mockBase}/items/4`);
    assert.deepEqual(JSON.parse(up.body!), { label: 'He said "hi"', n: null, id: 4 }, 'values are JSON, never raw text');
    assert.equal(ws.jsonValue('abc', 'integer'), 'abc', 'a value that does not fit is sent as typed');
    assert.equal(ws.jsonValue('', 'text'), null);
  });
});

describe('write-back calls', () => {
  test('insert, fetch, update and delete through the mock service', async () => {
    items = [{ id: 1, name: 'one', size: 1 }];
    const s = source({});
    const ins = await ws.callOperation(s, 'insert', { name: 'two', size: '2' });
    assert.equal(ins.status, 201);
    assert.deepEqual(ins.row, { id: 2, name: 'two', size: 2 }, 'the new row from the response (row selector "result")');
    assert.deepEqual((await ws.callOperation(s, 'fetch', { id: 2 })).row, { id: 2, name: 'two', size: 2 });
    assert.equal((await ws.callOperation(s, 'fetch', { id: 99 })).row, null, '404: no row');
    await ws.callOperation(s, 'update', { id: 2, name: 'TWO', size: null });
    assert.deepEqual(items[1], { id: 2, name: 'TWO', size: null, meta: undefined });
    await ws.callOperation(s, 'delete', { id: 1 });
    assert.deepEqual(items.map((x) => x.id), [2]);
    await assert.rejects(ws.callOperation(s, 'delete', { id: 1 }), (e: Error) => /delete operation was answered with 404/.test(e.message));
  });

  test('the allow-list and the credential\'s "valid for" URLs apply to every operation', async () => {
    await assert.rejects(ws.callOperation(source({ url: 'http://10.0.0.1/items' }), 'fetch', { id: 1 }), /allow-list/);
    const cred = await owner.one(
      `insert into meta.web_credential (app_id, name, type, secret_enc, valid_for) values ($1, 'T_WB_CRED', 'bearer', $2, $3) returning id`,
      [appId, encryptSecret('tok'), [`${mockBase}/other/`]],
    );
    try {
      await assert.rejects(ws.callOperation(source({ app_id: appId, credential: 'T_WB_CRED' }), 'fetch', { id: 2 }), /not valid for this URL/);
      await owner.query('update meta.web_credential set valid_for = $2 where id = $1', [cred.id, [`${mockBase}/items`]]);
      seen.length = 0;
      await ws.callOperation(source({ app_id: appId, credential: 'T_WB_CRED' }), 'fetch', { id: 2 });
      assert.equal(seen[0].headers.authorization, 'Bearer tok');
    } finally {
      await owner.query('delete from meta.web_credential where id = $1', [cred.id]);
    }
  });
});

describe('OAuth2 password and refresh token grants', () => {
  test('the password grant; refresh tokens are kept encrypted and rotated', async () => {
    ws.clearTokens();
    tokenResponses = [];
    const c = await owner.one(
      `insert into meta.web_credential (app_id, name, type, username, token_url, grant_type, oauth_username, password_enc)
       values ($1, 'T_PW', 'oauth2', 'public-app', $2, 'password', 'robot', $3) returning id`,
      [appId, `${mockBase}/token`, encryptSecret('pa55')],
    );
    try {
      let cred = await ws.loadCredential(appId, 'T_PW');
      seen.length = 0;
      assert.equal((await ws.call({ url: `${mockBase}/secure`, credential: cred })).status, 200);
      const tokenReq = new URLSearchParams(seen.find((x) => x.url === '/token')!.body);
      assert.equal(tokenReq.get('grant_type'), 'password');
      assert.equal(tokenReq.get('username'), 'robot');
      assert.equal(tokenReq.get('client_id'), 'public-app', 'a public client sends its id in the form');
      assert.equal(seen.find((x) => x.url === '/token')!.headers.authorization, undefined);
      // the refresh token is stored encrypted
      const row = await owner.one('select refresh_token_enc, token_refreshed_at from meta.web_credential where id = $1', [c.id]);
      assert.ok(row.refresh_token_enc?.startsWith('v1:') && !row.refresh_token_enc.includes('rt-'));
      assert.ok(row.token_refreshed_at);
      // after a restart (no tokens in memory) the stored refresh token is used, and the rotated one kept
      ws.clearTokens();
      cred = await ws.loadCredential(appId, 'T_PW');
      assert.equal((await ws.call({ url: `${mockBase}/secure`, credential: cred })).status, 200);
      assert.equal(tokenResponses.at(-1)!.grant, 'refresh_token');
      const rotated = await owner.one('select refresh_token_enc from meta.web_credential where id = $1', [c.id]);
      assert.notEqual(rotated.refresh_token_enc, row.refresh_token_enc);
      // a refresh token that no longer works: the password grant again
      refreshValid.clear();
      ws.clearTokens();
      cred = await ws.loadCredential(appId, 'T_PW');
      assert.equal((await ws.call({ url: `${mockBase}/secure`, credential: cred })).status, 200);
      assert.deepEqual(tokenResponses.slice(-1).map((x) => x.grant), ['password']);
      // a wrong password: an error without the password
      await owner.query('update meta.web_credential set password_enc = $2, refresh_token_enc = null where id = $1', [c.id, encryptSecret('wrong-pass')]);
      ws.clearTokens();
      await assert.rejects(ws.call({ url: `${mockBase}/secure`, credential: await ws.loadCredential(appId, 'T_PW') }),
        (e: Error) => /answered 400 \(invalid_grant\)/.test(e.message) && !e.message.includes('wrong-pass'));
    } finally {
      await owner.query('delete from meta.web_credential where id = $1', [c.id]);
    }
  });

  test('the refresh token grant: needs a refresh token, keeps the newest one', async () => {
    ws.clearTokens();
    refreshValid = new Set(['start-token']);
    const c = await owner.one(
      `insert into meta.web_credential (app_id, name, type, username, token_url, grant_type, secret_enc)
       values ($1, 'T_RT', 'oauth2', 'client-9', $2, 'refresh_token', $3) returning id`,
      [appId, `${mockBase}/token`, encryptSecret('client-secret')],
    );
    try {
      await assert.rejects(ws.call({ url: `${mockBase}/secure`, credential: await ws.loadCredential(appId, 'T_RT') }), /has no refresh token: enter one/);
      await owner.query('update meta.web_credential set refresh_token_enc = $2 where id = $1', [c.id, encryptSecret('start-token')]);
      seen.length = 0;
      assert.equal((await ws.call({ url: `${mockBase}/secure`, credential: await ws.loadCredential(appId, 'T_RT') })).status, 200);
      const t = seen.find((x) => x.url === '/token')!;
      assert.equal(new URLSearchParams(t.body).get('refresh_token'), 'start-token');
      assert.equal(t.headers.authorization, `Basic ${Buffer.from('client-9:client-secret').toString('base64')}`);
      // the old token was used up; the stored one is the new one
      ws.clearTokens();
      assert.equal((await ws.call({ url: `${mockBase}/secure`, credential: await ws.loadCredential(appId, 'T_RT') })).status, 200);
      refreshValid.clear();
      ws.clearTokens();
      await assert.rejects(ws.call({ url: `${mockBase}/secure`, credential: await ws.loadCredential(appId, 'T_RT') }), /may have expired: enter a new one/);
    } finally {
      await owner.query('delete from meta.web_credential where id = $1', [c.id]);
    }
  });

  test('checks', () => {
    assert.deepEqual(ws.credentialProblems({ type: 'oauth2', token_url: 'https://x/token', username: 'c', grant_type: 'password', oauth_username: 'u' }), []);
    assert.ok(ws.credentialProblems({ type: 'oauth2', token_url: 'https://x/token', username: 'c', grant_type: 'password' }).some((p) => /password flow needs the user name/.test(p)));
    assert.ok(ws.credentialProblems({ type: 'oauth2', token_url: 'https://x/token', username: 'c', grant_type: 'implicit' }).some((p) => /grant type is one of/.test(p)));
  });
});

describe('synchronisation into a local table', () => {
  let id: number;
  before(async () => {
    await owner.query('create table hr.t_sync_copy (id int primary key, name text not null, size numeric, note text default \'local\', total int generated always as (id * 2) stored)');
    await owner.query('grant select, insert, update, delete on hr.t_sync_copy to hr_app');
    id = (await owner.one(
      `insert into meta.rest_source (app_id, name, url, row_selector, columns, key_columns, sync_table, sync_mode)
       values ($1, 'T_SYNC', $2, 'data', $3, '{id}', 'hr.t_sync_copy', 'merge') returning id`,
      [appId, `${mockBase}/items`, JSON.stringify(source({}).columns)],
    )).id;
  });
  const copy = async () => (await owner.query('select id, name, size::float as size, note from hr.t_sync_copy order by id')).rows;

  test('merge: inserts, updates only changed rows, and deletes when asked', async () => {
    items = [{ id: 1, name: 'a', size: 1 }, { id: 2, name: 'b', size: 2 }, { id: 2, name: 'b dup', size: 2 }];
    let r = await sync.runSync(id, 'manual', { by: 'tester' });
    assert.equal(r.status, 'ok', String(r.message));
    assert.deepEqual([r.rows, r.inserted, r.updated, r.deleted], [3, 2, 0, 0], 'a duplicate key counts once');
    items = [{ id: 1, name: 'a', size: 1 }, { id: 3, name: 'c', size: null }];
    r = await sync.runSync(id, 'manual');
    assert.deepEqual([r.inserted, r.updated, r.deleted], [1, 0, 0], 'unchanged rows are not updated; no delete without sync_delete');
    await owner.query('update meta.rest_source set sync_delete = true where id = $1', [id]);
    items[0].name = 'A';
    r = await sync.runSync(id, 'manual');
    assert.deepEqual([r.inserted, r.updated, r.deleted], [0, 1, 1]);
    assert.deepEqual(await copy(), [{ id: 1, name: 'A', size: 1, note: 'local' }, { id: 3, name: 'c', size: null, note: 'local' }]);
    // a response cut off by the maximum rows deletes nothing
    await owner.query('update meta.rest_source set max_rows = 1 where id = $1', [id]);
    r = await sync.runSync(id, 'manual');
    assert.equal(r.deleted, 0);
    assert.match(r.message!, /Only the first 1 rows were read/);
    await owner.query('update meta.rest_source set max_rows = 1000 where id = $1', [id]);
    const log = await sync.syncLog(id);
    assert.equal(log[log.length - 1].requested_by, 'tester');
    assert.ok(log.every((l) => l.status === 'ok' && l.trigger === 'manual'));
  });

  test('replace and append', async () => {
    await owner.query(`update meta.rest_source set sync_mode = 'replace' where id = $1`, [id]);
    items = [{ id: 7, name: 'seven', size: 7 }];
    let r = await sync.runSync(id, 'manual');
    assert.deepEqual([r.inserted, r.deleted], [1, 2]);
    await owner.query(`update meta.rest_source set sync_mode = 'append' where id = $1`, [id]);
    items = [{ id: 8, name: 'eight', size: 8 }];
    r = await sync.runSync(id, 'manual');
    assert.equal(r.inserted, 1);
    assert.deepEqual((await copy()).map((x) => x.id), [7, 8]);
    // errors are logged (here: a duplicate key), nothing is half written
    r = await sync.runSync(id, 'manual');
    assert.equal(r.status, 'error');
    assert.match(r.message!, /duplicate key/);
    assert.deepEqual((await copy()).map((x) => x.id), [7, 8]);
    await owner.query(`update meta.rest_source set sync_mode = 'merge' where id = $1`, [id]);
  });

  test('from SQL: meta.request_rest_sync queues a run for the scheduler', async () => {
    const queued = await runtime.tx(async (c) => {
      await c.query(`select set_config('pgapex.app_id', $1, true), set_config('pgapex.app_user', 'KING', true)`, [String(appId)]);
      await c.query('set local role hr_app');
      const a = (await c.query(`select meta.request_rest_sync('t_sync') as id`)).rows[0].id;
      const b = (await c.query(`select meta.request_rest_sync('T_SYNC') as id`)).rows[0].id;
      assert.equal(a, b, 'a waiting run is reused');
      await c.query('savepoint nope');
      await assert.rejects(c.query(`select meta.request_rest_sync('NOPE')`), /does not exist in this application/);
      await c.query('rollback to savepoint nope');
      return a;
    });
    items = [{ id: 9, name: 'nine', size: 9 }];
    const r = await sync.runSync(id, 'sql', { log: Number(queued) });
    // (a dev server sharing the database may take the queued run first)
    assert.ok(r.status === 'ok' || r.status === 'busy', String(r.message));
    const status = await runtime.tx(async (c) => {
      await c.query(`select set_config('pgapex.app_id', $1, true)`, [String(appId)]);
      return (await c.query('select meta.rest_sync_status($1) as s', [queued])).rows[0].s;
    });
    assert.equal(status.source, 'T_SYNC');
    assert.equal(status.trigger, 'sql');
    assert.equal(status.requested_by, 'KING');
    // another application can't see it
    const other = await runtime.tx(async (c) => {
      await c.query(`select set_config('pgapex.app_id', '0', true)`);
      return (await c.query('select meta.rest_sync_status($1) as s', [queued])).rows[0].s;
    });
    assert.equal(other, null);
  });

  test('on a schedule: the first pass schedules it, a later pass runs it', async () => {
    await owner.query(`update meta.rest_source set sync_schedule = '*/5 * * * *', sync_enabled = true, sync_next_at = null where id = $1`, [id]);
    try {
      const now = new Date('2031-01-01T00:00:30Z');
      await sync.syncTick(now);
      const next = (await owner.one('select sync_next_at from meta.rest_source where id = $1', [id])).sync_next_at;
      assert.equal(new Date(next).toISOString(), '2031-01-01T00:05:00.000Z');
      await sync.syncTick(new Date('2031-01-01T00:06:00Z'));
      const log = await sync.syncLog(id, 1);
      assert.equal(log[0].trigger, 'schedule');
    } finally {
      await owner.query(`update meta.rest_source set sync_enabled = false, sync_schedule = null where id = $1`, [id]);
    }
  });

  test('checks', () => {
    assert.deepEqual(sync.syncProblems({ sync_table: 'app.copy', sync_mode: 'merge', key_columns: ['id'], sync_schedule: '@hourly', sync_time_zone: 'UTC', sync_enabled: true }), []);
    const bad = sync.syncProblems({ sync_table: 'x; drop table y', sync_mode: 'merge', key_columns: [], sync_schedule: 'every day', sync_enabled: true });
    for (const re of [/local table is a table name/, /merge needs the key columns/, /Schedule:/]) assert.ok(bad.some((p) => re.test(p)), String(re));
  });
});

describe('forms and interactive grids on a REST data source (HR page 34)', () => {
  let url = '';
  before(async () => {
    url = (await owner.one(`select url from meta.rest_source where app_id = $1 and name = 'CRM_CONTACTS'`, [appId])).url;
    await owner.query(`update meta.rest_source set url = $2 where app_id = $1 and name = 'CRM_CONTACTS'`, [appId, `${base}/a/hr/rest/crm/contacts`]);
    ws.clearResponseCache();
  });
  after(async () => {
    await owner.query(`update meta.rest_source set url = $2 where app_id = $1 and name = 'CRM_CONTACTS'`, [appId, url]);
    await owner.query(`delete from hr.crm_contact where name like 'Test %'`);
  });

  test('the grid reads the service and saves through its operations', async () => {
    const b = new Browser(app);
    await b.login('king');
    const page = await b.get('/a/hr/34');
    assert.equal(page.statusCode, 200);
    assert.doesNotMatch(page.body, /alert-error/);
    assert.match(page.body, /Grace Hopper/);
    const grid = (await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 34 and r.type = 'grid'`, [appId])).id;
    const g = `g${grid}`;
    const form = gridForm(page.body, g);
    // the row of Grace Hopper: change the company; add a row
    const graceId = String((await owner.one(`select id from hr.crm_contact where name = 'Grace Hopper'`)).id);
    const row = Object.keys(form).find((k) => k.endsWith('_pk') && form[k] === graceId)!.slice(0, -3);
    const cols = [...page.body.matchAll(new RegExp(`name="${g}_n0_c(\\d+)"`, 'g'))].map((m) => Number(m[1]));
    assert.ok(cols.length >= 3, 'a new-row template with the writable columns');
    // columns c1..: name, company, email, phone (c0 is the key, not writable)
    const res = await b.submit('/a/hr/34', { ...form, [`${row}_c2`]: 'Navy', __request: `GRID_SAVE_${grid}`, [`${g}_n0_c1`]: 'Test Person', [`${g}_n0_c2`]: 'Test Co' });
    assert.equal(res.statusCode, 303, [...res.body.matchAll(/class="(?:alert[^"]*|error[^"]*)"[^>]*>([^<]*)/g)].map((m) => m[1]).join(' | '));
    const grace = await owner.one(`select company, email from hr.crm_contact where name = 'Grace Hopper'`);
    assert.equal(grace.company, 'Navy');
    assert.equal(grace.email, 'grace@example.com', 'a PUT keeps the columns that did not change');
    assert.ok(await owner.one(`select 1 from hr.crm_contact where name = 'Test Person' and company = 'Test Co'`));
    await owner.query(`update hr.crm_contact set company = 'Compilers Inc.' where name = 'Grace Hopper'`);
  });

  test('a tampered row key is refused; a deleted row goes through DELETE', async () => {
    const b = new Browser(app);
    await b.login('king');
    const t = await owner.one(`insert into hr.crm_contact (name) values ('Test Delete') returning id`);
    const page = await b.get('/a/hr/34');
    const grid = (await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 34 and r.type = 'grid'`, [appId])).id;
    const g = `g${grid}`;
    const form = gridForm(page.body, g);
    const row = Object.keys(form).find((k) => k.endsWith('_pk') && form[k] === String(t.id))!.slice(0, -3);
    const ada = (await owner.one(`select id from hr.crm_contact where name = 'Ada Byron'`)).id;
    const tampered = await b.submit('/a/hr/34', { ...form, [`${row}_pk`]: String(ada), [`${row}_del`]: 'true', __request: `GRID_SAVE_${grid}` });
    assert.notEqual(tampered.statusCode, 303);
    assert.ok(await owner.one(`select 1 from hr.crm_contact where id = $1`, [ada]), 'Ada is still there');
    const page2 = await b.get('/a/hr/34');
    const form2 = gridForm(page2.body, g);
    const row2 = Object.keys(form2).find((k) => k.endsWith('_pk') && form2[k] === String(t.id))!.slice(0, -3);
    const res = await b.submit('/a/hr/34', { ...form2, [`${row2}_del`]: 'true', __request: `GRID_SAVE_${grid}` });
    assert.equal(res.statusCode, 303);
    assert.equal(await owner.one(`select 1 from hr.crm_contact where id = $1`, [t.id]), undefined);
  });

  test('the form fetches, creates, saves and deletes through the service', async () => {
    const b = new Browser(app);
    await b.login('king');
    // create
    let page = await b.get('/a/hr/34');
    let res = await b.submit('/a/hr/34', { ...formFields(page.body), P34_ID: '', P34_NAME: 'Test Form', P34_COMPANY: 'Formco', P34_EMAIL: 'f@example.com', __request: 'CREATE' });
    assert.equal(res.statusCode, 303, res.body.slice(0, 300));
    const created = await owner.one(`select id from hr.crm_contact where name = 'Test Form'`);
    assert.ok(created, 'created through POST');
    page = await b.get('/a/hr/34');
    assert.match(page.body, /name="P34_NAME"[^>]*value="Test Form"/, 'the new key went into P34_ID and the row was fetched');
    // save
    res = await b.submit('/a/hr/34', { ...formFields(page.body), P34_PHONE: '+31 6 1234', __request: 'SAVE' });
    assert.equal(res.statusCode, 303);
    assert.equal((await owner.one('select phone, company from hr.crm_contact where id = $1', [created.id])).phone, '+31 6 1234');
    // delete
    page = await b.get('/a/hr/34');
    res = await b.submit('/a/hr/34', { ...formFields(page.body), __request: 'DELETE' });
    assert.equal(res.statusCode, 303);
    assert.equal(await owner.one('select 1 from hr.crm_contact where id = $1', [created.id]), undefined);
  });

  test('the synchronisation of the sample CRM into its local copy', async () => {
    const src = (await owner.one(`select id from meta.rest_source where app_id = $1 and name = 'CRM_CONTACTS'`, [appId])).id;
    const r = await sync.runSync(src, 'manual');
    assert.equal(r.status, 'ok', String(r.message));
    const n = (await owner.one('select count(*)::int as n from hr.crm_contact')).n;
    assert.equal((await owner.one('select count(*)::int as n from hr.crm_contact_copy')).n, n);
  });
});
