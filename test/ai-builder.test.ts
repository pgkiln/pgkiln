// Sprint 36 item 3: App Builder AI — the builder's AI service, SQL from a
// question (shown, never run), explain a query or an error, describe tables
// for models, and pages from a description (proposed, created only when the
// developer ticks them) — against the scripted mock (no real API calls).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';

process.env.PGKILN_SECRET_KEY = 'test-only-secret-key-0123456789abcdef';

const { buildApp } = await import('../src/app.ts');
const { closePools, owner } = await import('../src/db.ts');
const { encryptSecret } = await import('../src/secrets.ts');
const { checkProposals, describeTables, tableInfo } = await import('../src/builder/ai-builder.ts');
const { Browser } = await import('./helpers.ts');
const { startScriptMock } = await import('./ai-script-mock.ts');

let app: FastifyInstance;
let mock: Awaited<ReturnType<typeof startScriptMock>>;
let admin: InstanceType<typeof Browser>;
let appId: number;
const SVC = 'T_AI3_BUILDER';
const DEV = 't_ai3_dev';
const alias = 'ai-s36-pages';
const last = () => mock.seen.at(-1)!;

async function signIn(user: string, password: string) {
  const b = new Browser(app);
  await b.get('/builder/login');
  await b.post('/builder/login', { __csrf: b.lastCsrf, username: user, password });
  await b.get('/builder');
  return b;
}

before(async () => {
  mock = await startScriptMock();
  app = await buildApp({ logger: false });
  await owner.query(`delete from meta.ai_service where name = $1`, [SVC]);
  await owner.query(`insert into meta.ai_service (name, provider, model, base_url, api_key_enc) values ($1, 'anthropic', 'claude-opus-5-5', $2, $3)`, [SVC, `${mock.base}/claude`, encryptSecret('sk-ant-builder')]);
  await owner.query(`insert into meta.developer (username, password_hash, is_admin) values ($1, meta.hash_password('T-ai3-dev-password!'), false) on conflict do nothing`, [DEV]);
  await owner.query(`delete from meta.app where alias = $1`, [alias]);
  appId = (await owner.one(`insert into meta.app (alias, name, authentication, db_role) values ($1, 'AI pages', 'none', 'hr_app') returning id`, [alias])).id;
  await owner.query(`insert into meta.page (app_id, page_no, name) values ($1, 1, 'Home')`, [appId]);
  await owner.query(`delete from meta.ai_table_note where schema_name = 'hr' and table_name = 'dept'`);
  admin = await signIn('admin', 'admin');
});

after(async () => {
  await owner.query(`update meta.builder_ai set service_id = null`);
  await owner.query(`delete from meta.ai_service where name = $1`, [SVC]);
  await owner.query(`delete from meta.developer where username = $1`, [DEV]);
  await owner.query(`delete from meta.app where alias = $1`, [alias]);
  await owner.query(`delete from meta.ai_table_note where schema_name = 'hr' and table_name = 'dept'`);
  await owner.query(`comment on table hr.dept is null; comment on column hr.dept.loc is null`);
  await mock.close();
  await app.close();
  await closePools();
});

describe('the App Builder\'s AI service', () => {
  test('without one the pages say so; only administrators choose it', async () => {
    await owner.query(`update meta.builder_ai set service_id = null`);
    const dev = await signIn(DEV, 'T-ai3-dev-password!');
    assert.match((await dev.get('/builder/sql/ai')).body, /ask an administrator/);
    const before = mock.seen.length;
    assert.match((await dev.submit('/builder/sql/ai/sql', { schema: 'hr', question: 'x' })).body, /has no AI service yet/);
    assert.equal(mock.seen.length, before);
    assert.equal((await dev.submit('/builder/sql/ai/service', { service: SVC })).statusCode, 403);
    assert.equal((await admin.get('/builder/sql/ai')).statusCode, 200);
    assert.equal((await admin.submit('/builder/sql/ai/service', { service: SVC.toLowerCase() })).statusCode, 303);
    assert.match((await dev.get('/builder/sql/ai')).body, new RegExp(`AI service: <b>${SVC}</b>`));
  });
});

describe('SQL Workshop AI', () => {
  test('SQL from a question: the schema without rows goes to the model; the SQL is shown, not run', async () => {
    mock.script = [{ text: JSON.stringify({ sql: 'delete from hr.dept;', explanation: 'Deletes <all> departments.' }) }];
    const before = (await owner.one('select count(*)::int as n from hr.dept')).n;
    const res = await admin.submit('/builder/sql/ai/sql', { schema: 'hr', question: 'remove all departments' });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /Deletes &lt;all&gt; departments\./);
    assert.match(res.body, /<textarea id="f_ai_sql" name="sql"[^>]*>delete from hr\.dept<\/textarea>/);
    assert.match(res.body, /<form method="post" action="\/builder\/sql">/);
    assert.equal((await owner.one('select count(*)::int as n from hr.dept')).n, before, 'nothing ran');
    const r = last();
    assert.equal(r.body.messages[0].content, 'remove all departments');
    assert.match(r.body.system, /table hr\.dept\n {2}deptno integer primary key/);
    assert.match(r.body.system, /mgr integer references hr\.emp\.empno/);
    assert.doesNotMatch(r.body.system, /KING|ACCOUNTING/, 'no rows');
    assert.equal(r.body.output_config.format.type, 'json_schema');
    const u = await owner.one(`select app_id, username, source from meta.ai_usage where service = $1 order by id desc limit 1`, [SVC]);
    assert.deepEqual(u, { app_id: null, username: 'admin', source: 'builder' });
  });

  test('explain a query and its error: the answer escaped and formatted', async () => {
    mock.script = [{ text: 'The column is **misspelled**:\n- use `ename` <img src=x>' }];
    const res = await admin.submit('/builder/sql/ai/explain', { schema: '', sql: 'select enam from hr.emp', error: 'column "enam" does not exist' });
    assert.match(res.body, /The column is <strong>misspelled<\/strong>:<\/p><ul><li>use <code>ename<\/code> &lt;img src=x&gt;<\/li><\/ul>/);
    assert.equal(last().body.messages[0].content, 'Query:\nselect enam from hr.emp\n\nError:\ncolumn "enam" does not exist');
    assert.match((await admin.submit('/builder/sql/ai/explain', { sql: '', error: '' })).body, /Paste a query/);
  });
});

describe('describe tables for AI', () => {
  test('notes are saved (optionally as comments) and go to the model; a draft is only shown', async () => {
    const page = (await admin.get('/builder/sql/ai/describe?schema=hr&table=dept')).body;
    assert.match(page, /name="note:loc"/);
    assert.equal((await admin.submit('/builder/sql/ai/describe', { schema: 'hr', table: 'dept', 'note:': 'Departments of the company.', 'note:loc': 'The city of the office.', comments: 'true' })).statusCode, 303);
    assert.deepEqual((await owner.query(`select column_name, note from meta.ai_table_note where schema_name = 'hr' and table_name = 'dept' order by 1`)).rows,
      [{ column_name: '', note: 'Departments of the company.' }, { column_name: 'loc', note: 'The city of the office.' }]);
    assert.equal((await owner.one(`select obj_description('hr.dept'::regclass, 'pg_class') as d`)).d, 'Departments of the company.');
    const text = describeTables(await tableInfo({ schema: 'hr', table: 'dept' }));
    assert.match(text, /^table hr\.dept -- Departments of the company\.\n/);
    assert.match(text, /loc text -- The city of the office\./);
    mock.script = [{ text: JSON.stringify({ table: 'Company departments <b>', columns: [{ name: 'dname', description: 'The name.' }, { name: 'nope', description: 'x' }] }) }];
    const draft = (await admin.submit('/builder/sql/ai/describe/draft', { schema: 'hr', table: 'dept' })).body;
    assert.match(draft, /Drafted by AI/);
    assert.match(draft, />Company departments &lt;b&gt;<\/textarea>/);
    assert.match(draft, /name="note:dname" maxlength="2000" value="The name\."/);
    assert.match(draft, /name="note:loc" maxlength="2000" value="The city of the office\."/, 'existing notes stay');
    assert.match(last().body.output_config.format.schema.properties.columns.items.properties.name.enum.join(','), /^deptno,dname,loc,/);
    assert.equal((await owner.one(`select note from meta.ai_table_note where schema_name = 'hr' and table_name = 'dept' and column_name = ''`)).note, 'Departments of the company.', 'the draft is not saved');
    // clearing a description deletes it
    await admin.submit('/builder/sql/ai/describe', { schema: 'hr', table: 'dept', 'note:': 'Departments of the company.', 'note:loc': '' });
    assert.equal((await owner.one(`select count(*)::int as n from meta.ai_table_note where schema_name = 'hr' and table_name = 'dept'`)).n, 1);
  });

  test('pgkiln\'s and the system\'s tables are not described', async () => {
    assert.equal((await admin.submit('/builder/sql/ai/describe', { schema: 'meta', table: 'app', 'note:': 'x' })).statusCode, 404);
    assert.equal((await admin.submit('/builder/sql/ai/describe/draft', { schema: 'pg_catalog', table: 'pg_authid' })).statusCode, 404);
    assert.doesNotMatch((await admin.get('/builder/sql/ai/describe')).body, /<option value="meta">/);
  });
});

describe('create pages with AI', () => {
  test('proposals are checked: known page types and tables, free page numbers', () => {
    const used = new Set([1, 2]);
    const out = checkProposals({ pages: [
      { kind: 'report_form', table: 'hr.dept', page: 2, form_page: 3, label: 'Departments', reason: 'r' },
      { kind: 'calendar', table: 'meta.app', page: 9, label: 'x' },
      { kind: 'shell', table: 'hr.dept', page: 9, label: 'x' },
      { kind: 'cards', table: 'hr.emp', page: 4, form_page: null, label: '' },
    ] }, ['hr.dept', 'hr.emp'], used);
    assert.deepEqual(out.map((p) => [p.kind, p.table, p.page, p.form_page, p.label]), [['report_form', 'hr.dept', 3, 4, 'Departments'], ['cards', 'hr.emp', 5, null, 'emp']]);
  });

  test('a description becomes proposals; the ticked ones are created', async () => {
    assert.match((await admin.get(`/builder/apps/${appId}`)).body, /Create pages with AI/);
    mock.script = [{ text: JSON.stringify({ pages: [
      { kind: 'report_form', table: 'hr.dept', page: 1, form_page: 2, label: 'Departments', reason: 'To manage <departments>.' },
      { kind: 'calendar', table: 'hr.leave_request', page: 4, form_page: null, label: 'Leave calendar', reason: 'Leave by date.' },
      { kind: 'chart', table: 'meta.app', page: 6, form_page: null, label: 'Apps', reason: 'x' },
    ] }) }];
    const res = await admin.submit(`/builder/apps/${appId}/ai-pages`, { description: 'Manage departments and see leave on a calendar' });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /To manage &lt;departments&gt;\./);
    assert.doesNotMatch(res.body, /meta\.app/);
    const r = last();
    assert.match(r.body.system, /- report_form: Report and form\./);
    assert.match(r.body.system, /Page numbers 1 are taken; the first free one is 2/);
    assert.ok(r.body.output_config.format.schema.properties.pages.items.properties.table.enum.includes('hr.dept'));
    assert.ok(!r.body.output_config.format.schema.properties.pages.items.properties.table.enum.some((t: string) => t.startsWith('meta.')));
    assert.match(res.body, /name="page_0" type="number" min="1" max="99999" value="2"/, 'page 1 is taken: moved');
    assert.match(res.body, /name="form_0" type="number" min="1" max="99999" value="3"/);
    // the developer unticks the calendar and creates the report and form
    const created = await admin.submit(`/builder/apps/${appId}/ai-pages/create`, {
      count: '2', on_0: 'true', kind_0: 'report_form', table_0: 'hr.dept', page_0: '2', form_0: '3', label_0: 'Departments',
      kind_1: 'calendar', table_1: 'hr.leave_request', page_1: '4', label_1: 'Leave calendar',
    });
    assert.equal(created.statusCode, 303);
    assert.deepEqual((await owner.query('select page_no from meta.page where app_id = $1 order by 1', [appId])).rows.map((x) => x.page_no), [1, 2, 3]);
    assert.equal((await owner.one(`select label from meta.nav_entry where app_id = $1 and target_page = 2`, [appId])).label, 'Departments');
  });

  test('forged proposals are refused: other tables, used pages, no CSRF', async () => {
    const before = (await owner.one('select count(*)::int as n from meta.page where app_id = $1', [appId])).n;
    await admin.submit(`/builder/apps/${appId}/ai-pages/create`, { count: '1', on_0: 'true', kind_0: 'grid', table_0: 'meta.developer', page_0: '7', label_0: 'x' });
    await admin.submit(`/builder/apps/${appId}/ai-pages/create`, { count: '1', on_0: 'true', kind_0: 'grid', table_0: 'hr.emp', page_0: '2', label_0: 'x' });
    assert.equal((await admin.post(`/builder/apps/${appId}/ai-pages/create`, { __csrf: 'forged', count: '1', on_0: 'true', kind_0: 'grid', table_0: 'hr.emp', page_0: '7' })).statusCode, 403);
    assert.equal((await owner.one('select count(*)::int as n from meta.page where app_id = $1', [appId])).n, before);
  });
});
