// Builder code editor: the completions endpoint (what the app's database role
// can use, items as binds), the inline Advisor check, and the data-code marks
// on the builder's code fields.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { clearCompletions, codeCheck, codeLang, type Completions } from '../src/builder/code-editor.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
let dev: Browser;

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  // a table the app role has no grant on, and a column it can't see
  await owner.query(`create table if not exists hr.ce_secret (id int, token text)`);
  await owner.query(`revoke all on hr.ce_secret from hr_app`);
  clearCompletions();
  dev = new Browser(app);
  await dev.get('/builder/login');
  await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
});

after(async () => {
  await owner.query('drop table if exists hr.ce_secret');
  await app.close();
  await closePools();
});

const get = async (b: Browser, q: string) => {
  const res = await b.get(`/builder/code/completions${q}`);
  return { res, data: res.statusCode === 200 ? (JSON.parse(res.body) as Completions & { page: number | null; app: number | null }) : null };
};

describe('code editor: completions', () => {
  test("tables, views and columns of the app's schema, as the app's role", async () => {
    const { res, data } = await get(dev, `?app=${appId}`);
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type']), /application\/json/);
    assert.match(String(res.headers['cache-control']), /no-store/);
    assert.equal(data!.role, 'hr_app');
    assert.ok(data!.schemas.includes('hr'));
    const emp = data!.relations.find((r) => r.schema === 'hr' && r.name === 'emp');
    assert.ok(emp, 'hr.emp is listed');
    assert.equal(emp!.kind, 'table');
    for (const c of ['empno', 'ename', 'deptno', 'sal']) assert.ok(emp!.columns.some((x) => x.name === c), c);
    assert.equal(emp!.columns.find((x) => x.name === 'empno')!.type, 'integer');
    assert.ok(data!.functions.some((f) => f.schema === 'meta' && f.name === 'has_role'), 'functions the role may execute');
  });

  test('page items (with their page) and application items are offered as binds', async () => {
    const { data } = await get(dev, `?app=${appId}`);
    assert.ok(data!.items.some((i) => i.name === 'P3_EMPNO' && i.page === 3));
    assert.ok(data!.items.some((i) => i.name === 'AI_ENAME' && i.page === null), 'application items');
    // by page: the page number comes along, for ordering the page's own items first
    const page = await owner.one(`select id from meta.page where app_id = $1 and page_no = 3`, [appId]);
    const byPage = await get(dev, `?page=${page.id}`);
    assert.equal(byPage.data!.page, 3);
    assert.equal(byPage.data!.app, appId);
  });

  test("nothing the app's role can't reach: ungranted tables, closed meta tables, other roles' schemas", async () => {
    const { data } = await get(dev, `?app=${appId}`);
    const names = data!.relations.map((r) => `${r.schema}.${r.name}`);
    assert.ok(!names.includes('hr.ce_secret'), 'a table without grants');
    for (const t of ['meta.developer', 'meta.account', 'meta.session', 'meta.instance_setting', 'meta.app']) assert.ok(!names.includes(t), t);
    assert.ok(!data!.schemas.includes('pg_toast') && !data!.schemas.includes('pg_catalog'));
    // the owner view (SQL Workshop) does see it
    const ownerView = await get(dev, '');
    assert.equal(ownerView.data!.role, null);
    assert.ok(ownerView.data!.relations.some((r) => r.schema === 'hr' && r.name === 'ce_secret'));
  });

  test('column grants are respected', async () => {
    await owner.query('grant select (id) on hr.ce_secret to hr_app');
    try {
      clearCompletions();
      const { data } = await get(dev, `?app=${appId}`);
      const t = data!.relations.find((r) => r.schema === 'hr' && r.name === 'ce_secret');
      assert.deepEqual(t?.columns.map((c) => c.name), ['id'], 'only the granted column');
    } finally {
      await owner.query('revoke all on hr.ce_secret from hr_app');
      clearCompletions();
    }
  });

  test('developers only; unknown or malformed apps are 404', async () => {
    const anon = new Browser(app);
    const res = await anon.get(`/builder/code/completions?app=${appId}`);
    assert.equal(res.statusCode, 302);
    assert.doesNotMatch(res.body, /empno/);
    // an application user's session is not a builder session
    const king = new Browser(app);
    await king.login('king');
    const asKing = await king.get(`/builder/code/completions?app=${appId}`);
    assert.equal(asKing.statusCode, 302);
    assert.doesNotMatch(asKing.body, /empno/);
    for (const q of ['?app=999999', '?app=1%20or%201=1', '?page=x', '?app=-1']) assert.equal((await dev.get(`/builder/code/completions${q}`)).statusCode, 404, q);
  });

  test('cached per app for a short while; GET changes nothing', async () => {
    const before = (await owner.one('select count(*)::int as n from meta.activity_log')).n;
    const a = await get(dev, `?app=${appId}`);
    await owner.query('create table hr.ce_later (id int)');
    await owner.query('grant select on hr.ce_later to hr_app');
    try {
      const b = await get(dev, `?app=${appId}`);
      assert.deepEqual(b.data!.relations.length, a.data!.relations.length, 'served from the cache');
      clearCompletions();
      const c = await get(dev, `?app=${appId}`);
      assert.ok(c.data!.relations.some((r) => r.name === 'ce_later'));
    } finally {
      await owner.query('drop table hr.ce_later');
      clearCompletions();
    }
    assert.equal((await owner.one('select count(*)::int as n from meta.activity_log')).n, before);
  });
});

describe('code editor: freshness', () => {
  test('running SQL in the SQL Workshop refreshes the catalog; items are never stale', async () => {
    await get(dev, `?app=${appId}`); // cached now
    await dev.get('/builder/sql');
    await dev.submit('/builder/sql', { sql: 'create table hr.ce_ddl (id int); grant select on hr.ce_ddl to hr_app' });
    try {
      assert.ok((await get(dev, `?app=${appId}`)).data!.relations.some((r) => r.name === 'ce_ddl'));
      await owner.query(`insert into meta.app_item (app_id, name) values ($1, 'AI_CE_FRESH')`, [appId]);
      assert.ok((await get(dev, `?app=${appId}`)).data!.items.some((i) => i.name === 'AI_CE_FRESH'));
    } finally {
      await owner.query(`delete from meta.app_item where app_id = $1 and name = 'AI_CE_FRESH'`, [appId]);
      await owner.query('drop table if exists hr.ce_ddl');
      clearCompletions();
    }
  });
});

describe('code editor: check', () => {
  test("plans SQL as the app's role like the Advisor; needs the CSRF token", async () => {
    const page = await dev.get(`/builder/apps/${appId}/shared`);
    assert.equal(page.statusCode, 200);
    const ok = await dev.submit('/builder/code/check', { app: String(appId), shape: 'select', sql: 'select ename from hr.emp where empno = :P3_EMPNO' });
    assert.equal(ok.statusCode, 200);
    assert.equal(JSON.parse(ok.body).ok, true);
    const bad = JSON.parse((await dev.submit('/builder/code/check', { app: String(appId), shape: 'select', sql: 'select nope from hr.emp' })).body);
    assert.equal(bad.ok, false);
    assert.match(bad.message, /column "nope" does not exist/);
    const denied = JSON.parse((await dev.submit('/builder/code/check', { app: String(appId), shape: 'select', sql: 'select * from hr.ce_secret' })).body);
    assert.match(denied.message, /permission denied/, 'as the app role, not the owner');
    const bool = JSON.parse((await dev.submit('/builder/code/check', { app: String(appId), shape: 'boolean', sql: "meta.has_role('admin')" })).body);
    assert.equal(bool.ok, true);
    // nothing runs: a DELETE is only planned
    const n = (await owner.one('select count(*)::int as n from hr.emp')).n;
    assert.equal(JSON.parse((await dev.submit('/builder/code/check', { app: String(appId), shape: 'statements', sql: 'delete from hr.emp' })).body).ok, true);
    assert.equal((await owner.one('select count(*)::int as n from hr.emp')).n, n);
    assert.equal((await dev.post('/builder/code/check', { app: String(appId), shape: 'select', sql: 'select 1' })).statusCode, 403, 'no CSRF token');
    assert.equal((await dev.submit('/builder/code/check', { app: String(appId), shape: 'drop', sql: 'select 1' })).statusCode, 400);
  });
});

describe('code editor: marked fields', () => {
  test('language per field, following the component type', () => {
    assert.equal(codeLang('region', { name: 'source', kind: 'code' }, { type: 'report' }), 'sql');
    assert.equal(codeLang('region', { name: 'source', kind: 'code' }, { type: 'static' }), 'html');
    assert.equal(codeLang('region', { name: 'config', kind: 'json' }), 'json');
    assert.equal(codeLang('process', { name: 'code', kind: 'code' }), 'plpgsql');
    assert.equal(codeLang('document_template', { name: 'template', kind: 'code' }), 'html');
    assert.equal(codeLang('validation', { name: 'expression', kind: 'code' }, { type: 'regex' }), 'text');
    assert.equal(codeLang('region', { name: 'title', kind: 'text' }), null);
    assert.equal(codeLang('dynamic_action', { name: 'code', kind: 'code' }, { action: 'set_value' }), 'sql');
    assert.equal(codeLang('dynamic_action', { name: 'code', kind: 'code' }, { action: 'execute_sql' }), 'plpgsql');
  });

  test('the Advisor check per field follows the component type too', () => {
    assert.equal(codeCheck('region', { name: 'source' }, { type: 'report' }), 'select');
    assert.equal(codeCheck('region', { name: 'source' }, { type: 'static' }), null);
    assert.equal(codeCheck('region', { name: 'condition' }), 'boolean');
    assert.equal(codeCheck('dynamic_action', { name: 'code' }, { action: 'set_value' }), 'select');
    assert.equal(codeCheck('dynamic_action', { name: 'code' }, { action: 'execute_sql' }), 'statements');
    assert.equal(codeCheck('process', { name: 'code' }, { type: 'sql' }), 'statements');
    assert.equal(codeCheck('process', { name: 'code' }, { type: 'form_dml' }), null);
    assert.equal(codeCheck('document_template', { name: 'template' }), null);
  });

  test('the builder marks its code fields and loads the editor', async () => {
    const page = await owner.one(`select id from meta.page where app_id = $1 and page_no = 2`, [appId]);
    const region = await owner.one(`select id from meta.region where page_id = $1 and type = 'report' order by id limit 1`, [page.id]);
    const body = (await dev.get(`/builder/pages/${page.id}?c=region-${region.id}`)).body;
    assert.match(body, /<script src="\/static\/code-editor\.js" defer><\/script>/);
    assert.match(body, /<link rel="stylesheet" href="\/static\/code-editor\.css">/);
    assert.match(body, /name="source" [^>]*data-code="sql" data-code-switch="type:static=html,form=text,\*=sql" data-code-check="select"/);
    assert.match(body, /name="condition" [^>]*data-code="sql"[^>]*data-code-check="boolean"/);
    assert.match(body, /name="config" [^>]*data-code="json"/);
    const shared = (await dev.get(`/builder/apps/${appId}/shared?new=document_template`)).body;
    assert.match(shared, /name="template" [^>]*data-code="html"/);
    assert.match((await dev.get('/builder/sql')).body, /name="sql" [^>]*data-code="plpgsql"/);
    const wf = (await dev.get(`/builder/apps/${appId}/shared?new=workflow_definition`)).body;
    assert.match(wf, /name="steps" [^>]*data-code="json"/);
    const da = (await dev.get(`/builder/pages/${page.id}?new=dynamic_action`)).body;
    assert.match(da, /name="code" [^>]*data-code-check-switch="action:set_value=select,\*=statements"/);
    assert.match((await dev.get('/builder/import')).body, /name="doc" [^>]*data-code="json"/, 'import an application');
    const rest = (await dev.get(`/builder/apps/${appId}/shared?new=rest_module`)).body;
    assert.match(rest, /name="handlers" [^>]*data-code="json"/);
    // runtime pages don't load it
    const king = new Browser(app);
    await king.login('king');
    assert.doesNotMatch((await king.get('/a/hr/1')).body, /code-editor/);
  });

  test('the editor script and stylesheet are served', async () => {
    const js = await app.inject({ method: 'GET', url: '/static/code-editor.js' });
    assert.equal(js.statusCode, 200);
    assert.match(String(js.headers['content-type']), /javascript/);
    assert.doesNotMatch(js.body, /innerHTML|insertAdjacentHTML|outerHTML|eval\(|new Function/, 'text only, no HTML parsing');
    const css = await app.inject({ method: 'GET', url: '/static/code-editor.css' });
    assert.equal(css.statusCode, 200);
  });
});
