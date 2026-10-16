// Sprint 104 (Database Actions DA-11, part 2; migration 117): SQL Workshop › RESTful Services › Modules. Modules,
// templates and handlers (collection query, single row, SQL, PL/pgSQL, media) of an application, served at
// /a/<alias>/rest/<module>/, with an OpenAPI document and a Try it panel. The HR example's module "hr"
// (examples/hr/hr_62_rest_module.sql) is the "done when" of the card.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { issueApiToken } from '../src/api.ts';
import { closePools, owner } from '../src/db.ts';
import { handlerProblems, templateProblems } from '../src/runtime/rest.ts';
import { mediaResponse, plpgsqlBlock, safeContentType } from '../src/runtime/rest-handlers.ts';
import { parseParams, templatesOf } from '../src/builder/rest-modules.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
const REASON = `rest104 ${Date.now()}`;
const token: Record<string, string> = {};

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  for (const u of ['king', 'allen']) token[u] = (await issueApiToken(appId, u, 1)).token;
  await owner.query(`delete from meta.rest_module where app_id = $1 and name like 'm104%'`, [appId]);
});

after(async () => {
  const ids = (await owner.query('select id from hr.leave_request where reason like $1', [`${REASON}%`])).rows.map((r) => String(r.id));
  await owner.query('delete from meta.task where app_id = $1 and detail_pk = any($2::text[])', [appId, ids]);
  await owner.query('delete from hr.leave_request where reason like $1', [`${REASON}%`]);
  await owner.query(`update hr.emp set photo = null, photo_mime = null, photo_name = null where empno = 7900`);
  await owner.query(`delete from meta.rest_module where app_id = $1 and name like 'm104%'`, [appId]);
  await owner.query(`delete from meta.app where alias = 'hr_rest104'`);
  await app.close();
  await closePools();
});

const call = (method: string, path: string, who?: string, payload?: unknown, module = 'hr') =>
  app.inject({
    method: method as 'GET',
    url: `/a/hr/rest/${module}/${path}`,
    headers: { ...(who ? { authorization: `Bearer ${token[who] ?? who}` } : {}), ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
    payload: payload !== undefined ? JSON.stringify(payload) : undefined,
  });

const builder = async () => {
  const b = new Browser(app);
  await b.get('/builder/login');
  assert.equal((await b.submit('/builder/login', { username: 'admin', password: 'admin' })).statusCode, 303);
  await b.get('/builder/sql/rest/modules');
  return b;
};

describe('definitions', () => {
  test('PL/pgSQL blocks: binds read meta.rest_param, strings and casts stay; statements get begin … end', () => {
    const block = plpgsqlBlock("declare v int; begin v := :ID::int; raise notice ':NOT_A_BIND %', :Name; end;");
    assert.match(block, /^do \$pgkiln_rest\$\n/);
    assert.match(block, /v := meta\.rest_param\('ID'\)::int/);
    assert.match(block, /':NOT_A_BIND %', meta\.rest_param\('NAME'\)/);
    assert.match(plpgsqlBlock('perform 1'), /begin\nperform 1;\nend/);
    assert.throws(() => plpgsqlBlock('begin end $pgkiln_rest$; select 1; --'), /may not contain/);
  });

  test('handler and template checks know the new source types and parameters', () => {
    assert.deepEqual(handlerProblems([
      { method: 'POST', path: 'leave', type: 'plpgsql', source: 'begin null; end', params: [{ name: 'start_date', in: 'body', type: 'string', required: true }] },
      { method: 'GET', path: 'emp/:id/photo', type: 'media', source: 'select 1' },
    ]), []);
    const bad = handlerProblems([
      { method: 'POST', path: 'x', type: 'media', source: 'select 1' },
      { method: 'PUT', path: 'y', type: 'plpgsql', source: 'begin end $pgkiln_rest$' },
      { method: 'GET', path: 'z', type: 'item', source: 'select 1', params: [{ name: 'a b', in: 'header' as 'query', type: 'date' as 'string' }] },
      { method: 'GET', path: 'w', type: 'item', source: 'select 1', params: [{ name: 'app_user', in: 'query' }] },
    ]);
    for (const re of [/media handlers answer GET/, /may not contain/, /name is letters/, /"in" query or body/, /type is one of/, /set by the server/])
      assert.ok(bad.some((p) => re.test(p)), String(re));
    assert.deepEqual(templateProblems([{ uri: 'emp' }, { uri: 'emp/:id', description: 'One' }]), []);
    const tbad = templateProblems([{ uri: '' }, { uri: 'a b' }, { uri: 'openapi.json' }, { uri: 'e/:id' }, { uri: 'e/:other' }, { uri: 'x/:app_user' }]);
    for (const re of [/URI is like/, /reserved/, /there twice/, /can't be URI parameters/]) assert.ok(tbad.some((p) => re.test(p)), String(re));
    assert.deepEqual(templatesOf({ templates: [{ uri: 'b' }], handlers: [{ method: 'GET', path: 'a', type: 'item', source: 'x' }, { method: 'POST', path: 'b', type: 'sql', source: 'x' }] }).map((t) => t.uri), ['a', 'b']);
  });

  test('parameter lines', () => {
    assert.deepEqual(parseParams('start_date body string required First day\n\nlimit query integer\nq query'), {
      params: [{ name: 'start_date', in: 'body', type: 'string', required: true, description: 'First day' }, { name: 'limit', in: 'query', type: 'integer' }, { name: 'q', in: 'query' }],
      problems: [],
    });
    assert.equal(parseParams('oops').problems.length, 1);
  });

  test('media responses are sandboxed; content types and file names are cleaned', () => {
    const r = mediaResponse({ content_type: 'text/html', content: '<script>alert(1)</script>', filename: 'a"\r\nb/c.html' });
    assert.equal(r.headers['content-type'], 'text/html');
    assert.match(r.headers['content-security-policy'], /sandbox/);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['content-disposition'], 'inline; filename="a___b_c.html"');
    assert.equal(safeContentType('text/html\r\nSet-Cookie: x=1'), 'application/octet-stream');
    assert.equal(safeContentType('image/png; charset=binary'), 'image/png; charset=binary');
    assert.throws(() => mediaResponse({ x: 1 }), /content_type and content/);
  });
});

describe('the HR module "hr"', () => {
  test('GET emp/:id: a single row handler returns an employee as JSON; 404 without one; 401 without a token', async () => {
    const res = await call('GET', 'emp/7839', 'allen');
    assert.equal(res.statusCode, 200);
    assert.deepEqual({ ...(res.json() as object), hiredate: undefined }, { empno: 7839, name: 'King', job: 'President', deptno: 10, hiredate: undefined, mgr: null });
    assert.equal((await call('GET', 'emp/1', 'allen')).statusCode, 404);
    assert.equal((await call('GET', 'emp/7839')).statusCode, 401);
    assert.equal((await call('DELETE', 'emp/7839', 'allen')).statusCode, 405);
    const list = (await call('GET', 'emp?limit=3', 'allen')).json();
    assert.equal(list.items.length, 3);
    assert.equal(list.has_more, true);
  });

  test('POST leave: a PL/pgSQL handler with binds from the body; meta.rest_reply sets body and status', async () => {
    const res = await call('POST', 'leave', 'allen', { start_date: '2032-06-07', end_date: '2032-06-08', reason: `${REASON} it's 'quoted'` });
    assert.equal(res.statusCode, 201, res.body);
    const { id, status } = res.json();
    assert.equal(status, 'requested');
    const row = await owner.one('select empno, reason, start_date::text from hr.leave_request where id = $1', [id]);
    assert.equal(row.reason, `${REASON} it's 'quoted'`);
    assert.equal(row.start_date, '2032-06-07');
    assert.equal(row.empno, (await owner.one(`select empno from hr.emp where username = 'allen'`)).empno, 'as the caller (meta.app_user)');
    const missing = await call('POST', 'leave', 'allen', { start_date: '2032-06-07' });
    assert.equal(missing.statusCode, 400);
    assert.match(missing.json().error, /end_date/);
    // a PL/pgSQL error is a 400 with its message
    const bad = await call('POST', 'leave', 'allen', { start_date: '2032-06-08', end_date: '2032-06-07', reason: `${REASON} backwards` });
    assert.equal(bad.statusCode, 400, bad.body);
  });

  test('payroll/:deptno: the handler\'s roles (403 without them)', async () => {
    assert.equal((await call('GET', 'payroll/10', 'allen')).statusCode, 403);
    assert.equal((await call('GET', 'payroll/10')).statusCode, 401);
    const ok = await call('GET', 'payroll/10', 'king');
    assert.equal(ok.statusCode, 200);
    assert.ok(ok.json().items.length >= 2);
  });

  test('emp/:id/photo: a media handler sends the content with its type', async () => {
    assert.equal((await call('GET', 'emp/7900/photo', 'allen')).statusCode, 404);
    await owner.query(`update hr.emp set photo = $1, photo_mime = 'image/png', photo_name = 'james.png' where empno = 7900`, [Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])]);
    const res = await call('GET', 'emp/7900/photo', 'allen');
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'image/png');
    assert.deepEqual([...res.rawPayload], [0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    assert.equal(res.headers['content-disposition'], 'inline; filename="james.png"');
  });

  test('the OpenAPI document lists the templates, handlers, parameters and roles', async () => {
    const doc = (await app.inject({ url: '/a/hr/rest/hr/openapi.json' })).json();
    assert.deepEqual(Object.keys(doc.paths).sort(), ['/emp', '/emp/{id}', '/emp/{id}/photo', '/leave', '/payroll/{deptno}']);
    assert.equal(doc.paths['/emp/{id}'].description, 'One employee by number');
    assert.deepEqual(doc.paths['/emp/{id}'].get.parameters, [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }]);
    const post = doc.paths['/leave'].post;
    assert.deepEqual(post.requestBody.content['application/json'].schema.required, ['start_date', 'end_date']);
    assert.equal(post.requestBody.content['application/json'].schema.properties.start_date.description, 'First day (YYYY-MM-DD)');
    assert.ok(post.responses['201'] && post.responses['400'] && post.responses['401']);
    assert.match(doc.paths['/payroll/{deptno}'].get.description, /manager, admin/);
    assert.ok(doc.paths['/emp/{id}/photo'].get.responses['200'].content['application/octet-stream']);
    assert.doesNotMatch(JSON.stringify(doc), /select|request_leave/, 'no SQL in the document');
  });

  test('the module\'s privilege: its roles apply to every handler', async () => {
    await owner.query(`insert into meta.rest_module (app_id, name, title, roles, handlers) values ($1, 'm104priv', 'Priv', '{manager}', $2)`,
      [appId, JSON.stringify([{ method: 'GET', path: 'me', type: 'item', source: 'select :APP_USER as who' }, { method: 'GET', path: 'open', type: 'item', auth: 'public', source: 'select 1 as one' }])]);
    assert.equal((await call('GET', 'me', 'allen', undefined, 'm104priv')).statusCode, 403);
    assert.deepEqual((await call('GET', 'me', 'king', undefined, 'm104priv')).json(), { who: 'king' });
    assert.equal((await call('GET', 'open', undefined, undefined, 'm104priv')).statusCode, 403, 'public handlers still need the module\'s role');
  });
});

describe('builder: SQL Workshop › RESTful Services › Modules', () => {
  test('create a module, a template emp/:id with a single row GET, and try it', async () => {
    const b = await builder();
    const list = await b.get('/builder/sql/rest/modules');
    assert.equal(list.statusCode, 200);
    assert.match(list.body, /HR \(RESTful Services\)/);
    assert.match((await b.get('/builder/sql/rest')).body, /href="\/builder\/sql\/rest\/modules"/, 'AutoREST links to the modules');
    const made = await b.submit('/builder/sql/rest/modules', { app_id: String(appId), name: 'm104b', title: 'Module 104', roles: '', description: '' });
    assert.equal(made.statusCode, 303, made.body);
    const id = (await owner.one(`select id from meta.rest_module where app_id = $1 and name = 'm104b'`, [appId])).id;
    assert.equal((await b.submit('/builder/sql/rest/modules', { app_id: String(appId), name: 'm104b', title: 'Again' })).statusCode, 422, 'unique per application');
    assert.equal((await b.submit('/builder/sql/rest/modules', { app_id: String(appId), name: 'Bad Name', title: 'x' })).statusCode, 422);

    assert.equal((await b.submit(`/builder/sql/rest/modules/${id}/template`, { uri: 'emp/:id', description: 'One employee' })).statusCode, 303);
    assert.equal((await b.submit(`/builder/sql/rest/modules/${id}/template`, { uri: 'emp/:id' })).statusCode, 422, 'twice');
    const tpl = await b.get(`/builder/sql/rest/modules/${id}/template?t=${encodeURIComponent('emp/:id')}`);
    assert.equal(tpl.statusCode, 200);
    assert.match(tpl.body, /No handlers yet/);
    assert.equal((await b.get(`/builder/sql/rest/modules/${id}/handler?t=${encodeURIComponent('emp/:id')}&new=GET`)).statusCode, 200);
    // a single row handler answers GET only
    const wrong = await b.submit(`/builder/sql/rest/modules/${id}/handler`, { t: 'emp/:id', method: 'POST', type: 'item', source: 'select 1', auth: 'token' });
    assert.equal(wrong.statusCode, 422);
    assert.match(wrong.body, /answer GET/);
    const saved = await b.submit(`/builder/sql/rest/modules/${id}/handler`, {
      t: 'emp/:id', method: 'GET', type: 'item', auth: 'token', description: 'One employee', roles: '', page_size: '', status: '', params: 'fields query string Not used',
      source: 'select empno, ename from hr.emp where empno = :ID::int',
    });
    assert.equal(saved.statusCode, 303, saved.body);
    const row = await owner.one('select handlers, templates from meta.rest_module where id = $1', [id]);
    assert.deepEqual(row.handlers, [{ method: 'GET', path: 'emp/:id', type: 'item', source: 'select empno, ename from hr.emp where empno = :ID::int', description: 'One employee', params: [{ name: 'fields', in: 'query', type: 'string', description: 'Not used' }] }]);
    assert.deepEqual(row.templates, [{ uri: 'emp/:id', description: 'One employee' }]);

    const page = await b.get(`/builder/sql/rest/modules/${id}/handler?t=${encodeURIComponent('emp/:id')}&m=GET`);
    assert.match(page.body, /Try it/);
    assert.match(page.body, /name="p_id"/);
    const tried = await b.submit(`/builder/sql/rest/modules/${id}/try`, { t: 'emp/:id', m: 'GET', as: 'king', p_id: '7839', query: '' });
    assert.equal(tried.statusCode, 200);
    assert.match(tried.body, /<b>200<\/b>/);
    assert.match(tried.body, /&quot;ename&quot;: &quot;KING&quot;|"ename": "KING"/);
    const anon = await b.submit(`/builder/sql/rest/modules/${id}/try`, { t: 'emp/:id', m: 'GET', as: '', p_id: '7839' });
    assert.match(anon.body, /<b>401<\/b>/);
    const notAnAccount = await b.submit(`/builder/sql/rest/modules/${id}/try`, { t: 'emp/:id', m: 'GET', as: 'nobody-104', p_id: '7839' });
    assert.match(notAnAccount.body, /Choose an account/);

    // renaming the template moves its handler; deleting it removes both
    assert.equal((await b.submit(`/builder/sql/rest/modules/${id}/template`, { orig: 'emp/:id', uri: 'employee/:id', description: 'Renamed' })).statusCode, 303);
    assert.equal((await owner.one('select handlers->0->>\'path\' as p from meta.rest_module where id = $1', [id])).p, 'employee/:id');
    assert.equal((await call('GET', 'employee/7839', 'allen', undefined, 'm104b')).json().ename, 'KING');
    assert.equal((await b.submit(`/builder/sql/rest/modules/${id}/template/delete`, { uri: 'employee/:id' })).statusCode, 303);
    assert.deepEqual((await owner.one('select handlers, templates from meta.rest_module where id = $1', [id])), { handlers: [], templates: [] });

    // the module's settings, then deleting it
    assert.equal((await b.submit(`/builder/sql/rest/modules/${id}`, { name: 'm104b', title: 'Module 104', roles: 'manager, admin', enabled: '0', description: '' })).statusCode, 303);
    assert.deepEqual((await owner.one('select roles, enabled from meta.rest_module where id = $1', [id])), { roles: ['admin', 'manager'], enabled: false });
    assert.equal((await b.submit(`/builder/sql/rest/modules/${id}/delete`, {})).statusCode, 303);
    assert.equal(await owner.one('select 1 from meta.rest_module where id = $1', [id]), undefined);
  });

  test('a Run only application refuses changes', async () => {
    const b = await builder();
    const id = (await owner.one(`select id from meta.rest_module where app_id = $1 and name = 'hr'`, [appId])).id;
    await owner.query(`update meta.app set build_status = 'run_only' where id = $1`, [appId]);
    try {
      const res = await b.submit(`/builder/sql/rest/modules/${id}/template`, { uri: 'm104x' });
      assert.equal(res.statusCode, 422);
      assert.match(res.body, /Run only/);
    } finally {
      await owner.query(`update meta.app set build_status = 'run_and_build' where id = $1`, [appId]);
    }
    assert.equal((await owner.one(`select templates @> '[{"uri": "m104x"}]' as has from meta.rest_module where id = $1`, [id])).has, false);
  });
});

describe('export', () => {
  test('modules travel with the application, with their privilege and templates; older exports still import', async () => {
    const doc = (await owner.one(`select meta.export_app('hr') as d`)).d;
    const mod = doc.rest_modules.find((m: any) => m.name === 'hr');
    assert.ok(mod.templates.some((t: any) => t.uri === 'emp/:id'));
    assert.deepEqual(mod.roles, []);
    for (const m of doc.rest_modules) {
      delete m.roles;
      delete m.templates;
    }
    const id = (await owner.one(`select meta.import_app($1::jsonb, 'hr_rest104') as id`, [JSON.stringify(doc)])).id;
    const copy = await owner.one(`select roles, templates, jsonb_array_length(handlers) as n from meta.rest_module where app_id = $1 and name = 'hr'`, [id]);
    assert.deepEqual(copy.roles, []);
    assert.deepEqual(copy.templates, []);
    assert.equal(copy.n, 5);
  });
});
