// REST modules served by pgapex (the HR example's /a/hr/rest/v1).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { issueApiToken } from '../src/api.ts';
import { closePools, owner } from '../src/db.ts';
import { handlerProblems, matchHandler, type Handler } from '../src/runtime/rest.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
const REASON = `rest test ${Date.now()}`;
const token: Record<string, string> = {};

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  for (const u of ['king', 'allen']) token[u] = (await issueApiToken(appId, u, 1)).token;
});

after(async () => {
  const ids = (await owner.query('select id from hr.leave_request where reason = $1', [REASON])).rows.map((r) => String(r.id));
  await owner.query('delete from meta.task where app_id = $1 and detail_pk = any($2::text[])', [appId, ids]);
  await owner.query('delete from hr.leave_request where reason = $1', [REASON]);
  await owner.query(`update meta.rest_module set enabled = true where app_id = $1 and name = 'v1'`, [appId]);
  await owner.query(`update meta.account set active = true where username = 'allen'`);
  await owner.query(`delete from meta.api_client where app_id = $1 and name = 'rest-test'`, [appId]);
  await app.close();
  await closePools();
});

const call = (method: string, path: string, who?: string, payload?: unknown) =>
  app.inject({
    method: method as 'GET',
    url: `/a/hr/rest/v1/${path}`,
    headers: { ...(who ? { authorization: `Bearer ${token[who] ?? who}` } : {}), ...(payload ? { 'content-type': 'application/json' } : {}) },
    payload: payload ? JSON.stringify(payload) : undefined,
  });

describe('handlers', () => {
  test('definitions are checked; paths match with parameters', () => {
    const hs: Handler[] = [
      { method: 'GET', path: 'employees', type: 'collection', source: 'select 1' },
      { method: 'GET', path: 'employees/:empno', type: 'item', source: 'select 1' },
      { method: 'POST', path: 'employees', type: 'sql', source: 'select 1' },
    ];
    assert.deepEqual(handlerProblems(hs), []);
    assert.deepEqual(matchHandler(hs, 'GET', 'employees/7839'), { handler: hs[1], params: { EMPNO: '7839' } });
    assert.equal(matchHandler(hs, 'DELETE', 'employees'), 'method');
    assert.equal(matchHandler(hs, 'GET', 'nope'), null);
    const bad = handlerProblems([
      { method: 'FETCH', path: 'a b', type: 'list', source: '' },
      { method: 'POST', path: 'x', type: 'item', source: 'select 1' },
      { method: 'GET', path: 'openapi.json', type: 'item', source: 'select 1' },
      { method: 'GET', path: 'e/:id', type: 'item', source: 'select 1' },
      { method: 'GET', path: 'e/:other', type: 'item', source: 'select 1' },
    ]);
    for (const re of [/"method" is one of/, /"path" is like/, /"type" is one of/, /"source" is the SQL/, /answer GET/, /reserved/, /defined twice/])
      assert.ok(bad.some((p) => re.test(p)), String(re));
  });
});

describe('REST module v1', () => {
  test('a token is needed (except for public endpoints); it must be valid and for this app', async () => {
    assert.equal((await call('GET', 'employees')).statusCode, 401);
    assert.equal((await call('GET', 'employees', 'not-a-token')).statusCode, 401);
    const depts = await call('GET', 'departments');
    assert.equal(depts.statusCode, 200, 'public');
    assert.equal(depts.json().items[0].dname, 'ACCOUNTING');
    // a token of another application (claims "app": "other") is refused
    const { SignJWT } = await import('jose');
    const { jwtSecret } = await import('../src/api.ts');
    const other = await new SignJWT({ app: 'other', app_user: 'king' }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(jwtSecret());
    assert.equal((await call('GET', 'employees', other)).statusCode, 401);
  });

  test('collections are paged, items found or 404, unknown paths and methods answer 404 and 405', async () => {
    const page = (await call('GET', 'employees?limit=5&offset=5', 'king')).json();
    assert.equal(page.items.length, 5);
    assert.deepEqual([page.offset, page.limit, page.has_more], [5, 5, true]);
    const king = (await call('GET', 'employees/7839', 'king')).json();
    assert.deepEqual([king.name, king.job], ['King', 'President']);
    assert.equal((await call('GET', 'employees/1', 'king')).statusCode, 404);
    assert.equal((await call('GET', 'nope', 'king')).statusCode, 404);
    assert.equal((await call('DELETE', 'employees', 'king')).statusCode, 405);
  });

  test('POST runs as the caller, with RLS; business errors are 400 with the message', async () => {
    const res = await call('POST', 'leave', 'allen', { start_date: '2027-11-01', end_date: '2027-11-02', reason: REASON });
    assert.equal(res.statusCode, 201, res.body);
    const id = res.json().id;
    assert.equal((await owner.one('select empno from hr.leave_request where id = $1', [id])).empno, 7499, 'requested as allen');
    const mine = (await call('GET', 'my/leave', 'allen')).json().items;
    assert.ok(mine.some((l: any) => l.id === id));
    assert.ok(!(await call('GET', 'my/leave', 'king')).json().items.some((l: any) => l.id === id), 'king\'s own list');
    const again = await call('POST', 'leave', 'allen', { start_date: '2027-11-01', end_date: '2027-11-02', reason: REASON });
    assert.equal(again.statusCode, 400);
    assert.match(again.json().error, /overlaps/);
  });

  test('roles, deactivated accounts, revoked clients and disabled modules', async () => {
    assert.equal((await call('GET', 'reports/payroll', 'allen')).statusCode, 403);
    assert.equal((await call('GET', 'reports/payroll', 'king')).statusCode, 200);
    await owner.query(`update meta.account set active = false where username = 'allen'`);
    assert.equal((await call('GET', 'employees', 'allen')).statusCode, 403);
    await owner.query(`update meta.account set active = true where username = 'allen'`);
    // an OAuth client (client credentials) with a role
    const c = (await owner.one(`select * from meta.oauth_create_client($1, 'rest-test', '{manager}')`, ['hr']));
    const tok = await app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'client_credentials', client_id: c.client_id, client_secret: c.client_secret } });
    const access = tok.json().access_token;
    assert.equal((await call('GET', 'reports/payroll', access)).statusCode, 200, 'the client has the manager role');
    await owner.query(`select meta.oauth_revoke_client($1)`, [c.client_id]);
    assert.equal((await call('GET', 'employees', access)).statusCode, 401);
    await owner.query(`update meta.rest_module set enabled = false where app_id = $1 and name = 'v1'`, [appId]);
    assert.equal((await call('GET', 'employees', 'king')).statusCode, 404);
    await owner.query(`update meta.rest_module set enabled = true where app_id = $1 and name = 'v1'`, [appId]);
  });

  test('the OpenAPI description, the builder page and the Advisor', async () => {
    const doc = (await app.inject({ url: '/a/hr/rest/v1/openapi.json' })).json();
    assert.equal(doc.openapi, '3.0.3');
    assert.deepEqual(Object.keys(doc.paths).sort(), ['/departments', '/departments/{deptno}', '/employees', '/employees/{empno}', '/leave', '/my/leave', '/reports/payroll']);
    assert.deepEqual(doc.paths['/departments'].get.security, [], 'public');
    assert.equal(doc.paths['/employees/{empno}'].get.parameters[0].name, 'empno');
    assert.ok(!JSON.stringify(doc).includes('hr.emp'), 'no SQL in the description');
    const dev = new Browser(app);
    await dev.get('/builder/login');
    await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
    const m = await owner.one(`select id from meta.rest_module where app_id = $1 and name = 'v1'`, [appId]);
    const page = (await dev.get(`/builder/apps/${appId}/shared?c=rest_module-${m.id}`)).body;
    assert.match(page, /\/a\/hr\/rest\/v1\/openapi\.json/);
    assert.match(page, /token, role manager or admin/);
    const { advise } = await import('../src/builder/advisor.ts');
    const r = await advise(appId);
    assert.ok(!r.findings.some((f) => f.entry?.kind === 'rest_module'), 'the HR module checks out');
    assert.ok((await owner.one(`select meta.export_app('hr') as d`)).d.rest_modules.some((x: any) => x.name === 'v1'));
  });

  test('the builder saves a module with valid handlers and refuses broken ones', async () => {
    const dev = new Browser(app);
    await dev.get('/builder/login');
    await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
    await dev.get(`/builder/apps/${appId}/shared?new=rest_module`);
    const module = (name: string, handlers: unknown) => ({ name, title: 'Test', description: '', enabled: 'true', handlers: JSON.stringify(handlers) });
    try {
      await dev.submit(`/builder/apps/${appId}/shared/rest_module`, module('test_ok', [{ method: 'GET', path: 'one', type: 'item', source: 'select 1 as one' }]));
      const saved = await owner.one(`select handlers from meta.rest_module where app_id = $1 and name = 'test_ok'`, [appId]);
      assert.equal(saved?.handlers[0].path, 'one', 'valid handlers are saved');
      await dev.get(`/builder/apps/${appId}/shared?new=rest_module`);
      await dev.submit(`/builder/apps/${appId}/shared/rest_module`, module('test_broken', [{ method: 'FETCH', path: 'x', type: 'item', source: 'select 1' }]));
      assert.equal(await owner.one(`select 1 from meta.rest_module where name = 'test_broken'`), undefined, 'broken handlers are not');
    } finally {
      await owner.query(`delete from meta.rest_module where app_id = $1 and name in ('test_ok', 'test_broken')`, [appId]);
    }
  });
});
