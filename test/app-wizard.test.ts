// Sprint 35: the create application wizard, finished: a file with several
// sheets (or JSON arrays) becomes several tables with proposed foreign keys
// (src/builder/appsheets.ts), pasted CSV/TSV text takes the same steps, and an
// application can be made on the existing tables of a schema
// (src/builder/appwizard.ts).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { parseBook, planFrom, proposal, proposeForeignKeys, proposeKey, singular } from '../src/builder/appsheets.ts';
import { pastedName } from '../src/builder/appwizard.ts';
import { Browser, formFields } from './helpers.ts';
import { workbook } from './xlsxbook.ts';

let app: FastifyInstance;
const ALIASES = ['aw35-company', 'aw35-json', 'aw35-fail', 'aw35-paste', 'aw35-tables', 'aw35-some'];
const SOURCE = 'aw35_src';

async function dropApp(alias: string, dropSchema = true) {
  const schema = alias.replace(/-/g, '_');
  const role = `app_${schema}`;
  await owner.query('delete from meta.app where alias = $1', [alias]);
  if (dropSchema) await owner.query(`drop schema if exists ${schema} cascade`);
  if ((await owner.query('select 1 from pg_roles where rolname = $1', [role])).rowCount) {
    await owner.query(`drop owned by ${role}`);
    await owner.query(`drop role ${role}`);
  }
}
async function cleanup() {
  for (const alias of ALIASES) await dropApp(alias);
  await owner.query(`drop schema if exists ${SOURCE} cascade`);
}

before(async () => {
  app = await buildApp({ logger: false });
  await cleanup();
});
after(async () => {
  await cleanup();
  await app.close();
  await closePools();
});

const builder = async () => {
  const b = new Browser(app);
  await b.get('/builder/login');
  assert.equal((await b.submit('/builder/login', { username: 'admin', password: 'admin' })).statusCode, 303);
  return b;
};

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const COMPANY = () =>
  workbook([
    { name: 'Departments', rows: [['ID', 'Name', 'City'], [10, 'Sales', 'Utrecht'], [20, 'Research', 'Delft'], [30, 'Support', 'Delft']] },
    { name: 'Notes', rows: [] },
    {
      name: 'Employees',
      rows: [['Employee ID', 'Name', 'Department ID', 'Job'], [1, 'Ann', 10, 'Clerk'], [2, 'Bob', 20, 'Analyst'], [3, 'Cy', 10, 'Clerk'], [4, 'Di', 30, 'Clerk']],
    },
    { name: 'Projects', rows: [['Code', 'Title', 'Department'], ['P-1', 'Website', 10], ['P-2', 'Robot', 99]] },
    { name: 'Assignments', rows: [['Employee ID', 'Project Code', 'Hours'], [1, 'P-1', 8], [2, 'P-2', 4], [3, 'P-1', 2]] },
  ]);

/** Upload a file, then return the step 2 URL, the page and the posted values a browser would send. */
async function upload(b: Browser, name: string, type: string, data: Buffer) {
  await b.get('/builder/create/file');
  const res = await b.upload('/builder/create/file', { headers: 'true' }, { file: { name, type, data } });
  assert.equal(res.statusCode, 303, res.body.slice(0, 500));
  const url = res.headers.location as string;
  const page = await b.get(url);
  assert.equal(page.statusCode, 200);
  const form = /<form method="post" action="\/builder\/create\/file\/[^"]+">[\s\S]*?<\/form>/.exec(page.body)![0];
  return { url, body: page.body, fields: formFields(form) };
}

describe('several sheets: parsing and proposals', () => {
  test('every sheet with rows becomes a table; JSON with several arrays too', async () => {
    const sheets = await parseBook('company.xlsx', COMPANY());
    assert.deepEqual(sheets.map((s) => s.name), ['Departments', 'Employees', 'Projects', 'Assignments'], 'the empty sheet is left out');
    assert.deepEqual(sheets[1].rows[0], ['1', 'Ann', '10', 'Clerk']);
    const json = await parseBook('shop.json', Buffer.from(JSON.stringify({ customers: [{ id: 1, name: 'Ann' }], orders: [{ id: 7, customer_id: 1 }], version: 3 })));
    assert.deepEqual(json.map((s) => [s.name, s.headers]), [['customers', ['id', 'name']], ['orders', ['id', 'customer_id']]]);
    const one = await parseBook('one.json', Buffer.from(JSON.stringify({ rows: [{ a: 1 }] })));
    assert.equal(one.length, 1);
    const csv = await parseBook('x.csv', Buffer.from('a;b\n1;2\n'));
    assert.deepEqual([csv.length, csv[0].name, csv[0].delimiter], [1, 'x', ';']);
  });

  test('keys, names and foreign keys are proposed', async () => {
    assert.deepEqual(['departments', 'categories', 'addresses', 'boss', 'data'].map(singular), ['department', 'category', 'address', 'boss', 'data']);
    const sheets = await parseBook('company.xlsx', COMPANY());
    const p = proposal(sheets);
    assert.deepEqual([p.s0_table, p.s0_key, p.s0_name_0, p.s1_table, p.s1_key, p.s1_name_0, p.s2_key, p.s2_type_0, p.s3_key], ['departments', '0', 'id', 'employees', '0', 'employee_id', '0', 'text', '']);
    assert.equal(proposeKey({ ...sheets[0], rows: [['1', 'a', null], ['1', 'b', null]] }, 'departments'), null, 'repeated values are no key');
    const fks = proposeForeignKeys(planFrom(sheets, (n) => p[n] ?? ''));
    assert.deepEqual(fks, [
      { from: 1, col: 2, to: 0, missing: 0 },
      { from: 2, col: 2, to: 0, missing: 1 },
      { from: 3, col: 0, to: 1, missing: 0 },
      { from: 3, col: 1, to: 2, missing: 0 },
    ]);
    // an excluded sheet is no target
    assert.equal(proposeForeignKeys(planFrom(sheets, (n) => (n === 's0_on' ? '' : (p[n] ?? '')))).filter((f) => f.to === 0).length, 0);
  });

  test('pasted data gets a file name from the title', () => {
    assert.equal(pastedName('Sales 2026!'), 'Sales 2026.csv');
    assert.equal(pastedName('  ../../etc '), 'etc.csv');
    assert.equal(pastedName(''), 'Pasted data.csv');
  });
});

describe('create an application from a workbook with several sheets', () => {
  test('step 2 shows a section per sheet and the proposed foreign keys', async () => {
    const b = await builder();
    const { body, fields } = await upload(b, 'company.xlsx', XLSX, COMPANY());
    assert.match(body, /company\.xlsx: 4 sheets \(Departments: 3 row\(s\), Employees: 4 row\(s\), Projects: 2 row\(s\), Assignments: 3 row\(s\)\)/);
    for (const name of ['Departments', 'Employees', 'Projects', 'Assignments']) assert.match(body, new RegExp(`<h2>Sheet ${name}</h2>`));
    assert.equal(fields.s1_on, 'true');
    assert.equal(fields.fk_1_2, '0', 'employees.department_id → departments.id is ticked');
    assert.equal(fields.fk_2_2, undefined, 'projects.department has a value departments lacks: not ticked');
    assert.match(body, /1 row\(s\) have a value that departments\.id doesn&#39;t have|1 row\(s\) have a value that departments\.id doesn't have/);
    assert.equal(fields.fk_3_0, '1');
    assert.equal(fields.fk_3_1, '2');
    assert.equal(fields.table, undefined, 'no single-table fields');
  });

  test('creates the tables, keys, rows, foreign keys, pages, navigation and a dashboard in one go', async () => {
    const b = await builder();
    const { url, fields } = await upload(b, 'company.xlsx', XLSX, COMPANY());
    const res = await b.submit(url, { ...fields, alias: 'aw35-company', name: 'AW company', authentication: 'none', s3_name_2: 'hours_worked', action: 'create' });
    assert.equal(res.statusCode, 200, res.body.slice(0, 3000));
    assert.match(res.body, /aw35_company\.departments: 3 row\(s\) loaded\. aw35_company\.employees: 4 row\(s\) loaded\./);
    assert.match(res.body, /employees\.department_id → departments\.id/);
    const fk = (await owner.query(
      `select conrelid::regclass::text as t, confrelid::regclass::text as r from pg_constraint where contype = 'f' and connamespace = 'aw35_company'::regnamespace order by 1, 2`,
    )).rows;
    assert.deepEqual(fk, [
      { t: 'aw35_company.assignments', r: 'aw35_company.employees' },
      { t: 'aw35_company.assignments', r: 'aw35_company.projects' },
      { t: 'aw35_company.employees', r: 'aw35_company.departments' },
    ]);
    // an integer key is the identity key and continues after the loaded keys; a text key is unique next to a new id
    await owner.query(`insert into aw35_company.departments (name) values ('New')`);
    assert.equal((await owner.one(`select id from aw35_company.departments where name = 'New'`)).id, '31');
    const pcols = (await owner.query(`select column_name, is_nullable from information_schema.columns where table_schema = 'aw35_company' and table_name = 'projects' order by ordinal_position`)).rows;
    assert.deepEqual(pcols.map((c) => c.column_name), ['id', 'code', 'title', 'department']);
    assert.equal(pcols[1].is_nullable, 'NO');
    assert.equal((await owner.one(`select count(*)::int as n from aw35_company.assignments where hours_worked > 0`)).n, 3);
    const a = await owner.one(`select id from meta.app where alias = 'aw35-company'`);
    const pages = (await owner.query('select page_no, name, mode from meta.page where app_id = $1 order by page_no', [a.id])).rows;
    assert.deepEqual(pages.map((p) => p.page_no), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const nav = (await owner.query('select label, target_page from meta.nav_entry where app_id = $1 order by seq', [a.id])).rows;
    assert.deepEqual(nav.map((n) => n.label), ['Home', 'Departments', 'Employees', 'Projects', 'Assignments', 'Dashboard']);
    const charts = (await owner.query(`select r.title, r.columns from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 10 order by r.seq`, [a.id])).rows;
    assert.ok(charts.length >= 3, JSON.stringify(charts));
    assert.equal(charts[0].title, 'Departments per city');
    assert.equal(charts[1].title, 'Employees per department');
    assert.ok(charts.every((c) => c.columns === 6));
    // a form's foreign key is a select list
    const item = await owner.one(`select i.type from meta.item i join meta.page p on p.id = i.page_id where p.app_id = $1 and p.page_no = 5 and i.source_column = 'department_id'`, [a.id]);
    assert.equal(item.type, 'select');
    const v = new Browser(app);
    for (const page of [2, 4, 6, 8, 10]) assert.equal((await v.get(`/a/aw35-company/${page}`)).statusCode, 200, `page ${page}`);
    assert.match((await v.get('/a/aw35-company/4')).body, /Ann/);
    assert.match((await v.get('/a/aw35-company/10')).body, /Sales/);
  });

  test('sheets can be left out, names changed and foreign keys unticked; "Update the proposals" only redraws', async () => {
    const b = await builder();
    const { url, fields } = await upload(b, 'company.xlsx', XLSX, COMPANY());
    const { fk_1_2: _x, s3_on: _y, chart: _z, ...rest } = fields;
    const preview = await b.submit(url, { ...rest, alias: 'aw35-some', name: 'AW some', authentication: 'none', s0_table: 'teams', s1_name_2: 'team_id', action: 'preview' });
    assert.equal(preview.statusCode, 200);
    assert.equal((await owner.query(`select 1 from meta.app where alias = 'aw35-some'`)).rowCount, 0);
    const again = formFields(/<form method="post" action="\/builder\/create\/file\/[^"]+">[\s\S]*?<\/form>/.exec(preview.body)![0]);
    assert.equal(again.s0_table, 'teams');
    assert.equal(again.s3_on, undefined);
    assert.equal(again.fk_1_2, undefined, 'stays unticked');
    assert.match(preview.body, /employees\.team_id → teams\.id/, 'the proposal follows the new names');
    const res = await b.submit(url, { ...again, action: 'create' });
    assert.equal(res.statusCode, 200, res.body.slice(0, 2000));
    assert.equal((await owner.query(`select 1 from pg_class where relname = 'assignments' and relnamespace = 'aw35_some'::regnamespace`)).rowCount, 0);
    assert.equal((await owner.query(`select 1 from pg_constraint where contype = 'f' and connamespace = 'aw35_some'::regnamespace`)).rowCount, 0);
    const a = await owner.one(`select id from meta.app where alias = 'aw35-some'`);
    assert.deepEqual((await owner.query('select page_no from meta.page where app_id = $1 order by 1', [a.id])).rows.map((p) => p.page_no), [1, 2, 3, 4, 5, 6, 7]);
  });

  test('a foreign key whose values are missing: nothing is created and the reason is shown', async () => {
    const b = await builder();
    const { url, fields } = await upload(b, 'company.xlsx', XLSX, COMPANY());
    const res = await b.submit(url, { ...fields, alias: 'aw35-fail', name: 'AW fail', authentication: 'none', fk_2_2: '0' });
    assert.equal(res.statusCode, 422);
    assert.match(res.body, /Foreign key projects\.department → departments\.id: Key \(department\)=\(99\) is not present/);
    for (const [form, message] of [
      [{ s1_table: 'departments' }, /a table name of its own/],
      [{ s1_table: 'Bad name' }, /Sheet Employees: the table name must be lower-case/],
      [{ s0_key: '', s0_name_0: 'id' }, /&quot;id&quot; is the name of the new key column/],
      [{ s0_on: '', s1_on: '', s2_on: '', s3_on: '' }, /Choose at least one sheet/],
    ] as [Record<string, string>, RegExp][]) {
      const r = await b.submit(url, { ...fields, alias: 'aw35-fail', name: 'AW fail', authentication: 'none', ...form });
      assert.equal(r.statusCode, 422, JSON.stringify(form));
      assert.match(r.body, message);
    }
    assert.equal((await owner.query(`select 1 from meta.app where alias = 'aw35-fail'`)).rowCount, 0);
    assert.equal((await owner.query(`select 1 from pg_namespace where nspname = 'aw35_fail'`)).rowCount, 0);
    assert.equal((await owner.query(`select 1 from pg_roles where rolname = 'app_aw35_fail'`)).rowCount, 0);
  });

  test('JSON with several arrays', async () => {
    const b = await builder();
    const doc = { customers: [{ id: 1, name: 'Ann' }, { id: 2, name: 'Bob' }], orders: [{ id: 7, customer_id: 1, total: 5.5 }, { id: 8, customer_id: 2, total: 3 }] };
    const { url, body, fields } = await upload(b, 'shop.json', 'application/json', Buffer.from(JSON.stringify(doc)));
    assert.match(body, /shop\.json: 2 arrays/);
    assert.equal(fields.fk_1_1, '0');
    const res = await b.submit(url, { ...fields, alias: 'aw35-json', name: 'AW json', authentication: 'none' });
    assert.equal(res.statusCode, 200, res.body.slice(0, 2000));
    assert.equal((await owner.one(`select count(*)::int as n from aw35_json.orders o join aw35_json.customers c on c.id = o.customer_id`)).n, 2);
  });
});

describe('create an application from pasted data', () => {
  test('tab-separated text takes the steps of a file', async () => {
    const b = await builder();
    assert.match((await b.get('/builder/create')).body, /href="\/builder\/create\/paste"/);
    await b.get('/builder/create/paste');
    const empty = await b.submit('/builder/create/paste', { title: 'x', data: '  ', headers: 'true' });
    assert.equal(empty.statusCode, 422);
    assert.match(empty.body, /Paste the data/);
    const json = await b.submit('/builder/create/paste', { title: 'x', data: '[{"a": 1}]', headers: 'true' });
    assert.equal(json.statusCode, 422);
    assert.match(json.body, /Paste delimited text/);
    const res = await b.submit('/builder/create/paste', { title: 'Team list', data: 'Name\tCity\tJoined\nAnn\tUtrecht\t2026-01-05\nBob\tDelft\t2026-02-01\n', headers: 'true' });
    assert.equal(res.statusCode, 303, res.body.slice(0, 500));
    const url = res.headers.location as string;
    const page = await b.get(url);
    assert.match(page.body, /Team list\.csv: 2 row\(s\), 3 column\(s\), delimiter tab/);
    assert.match(page.body, /href="\/builder\/create\/paste">Paste other data/);
    const fields = formFields(/<form method="post" action="\/builder\/create\/file\/[^"]+">[\s\S]*?<\/form>/.exec(page.body)![0]);
    assert.deepEqual([fields.name, fields.alias, fields.table, fields.type_2], ['Team list', 'team-list', 'team_list', 'date']);
    const done = await b.submit(url, { ...fields, alias: 'aw35-paste', name: 'AW paste', authentication: 'none' });
    assert.equal(done.statusCode, 200, done.body.slice(0, 2000));
    assert.match(done.body, /href="\/builder\/create\/paste"/);
    assert.equal((await owner.one(`select count(*)::int as n from aw35_paste.team_list`)).n, 2);
  });
});

describe('create an application from existing tables', () => {
  before(async () => {
    await owner.query(`create schema ${SOURCE}`);
    await owner.query(`create table ${SOURCE}.region (id int primary key, name text not null)`);
    await owner.query(`create table ${SOURCE}.store (id int generated always as identity primary key, name text, region_id int references ${SOURCE}.region)`);
    await owner.query(`create table ${SOURCE}.stock_log (store_id int, day date, qty int)`);
    await owner.query(`create view ${SOURCE}.store_list as select s.name, r.name as region from ${SOURCE}.store s join ${SOURCE}.region r on r.id = s.region_id`);
    await owner.query(`insert into ${SOURCE}.region values (1, 'North'), (2, 'South')`);
    await owner.query(`insert into ${SOURCE}.store (name, region_id) values ('A', 1), ('B', 1), ('C', 2)`);
  });

  test('lists the tables and views of a schema; refuses pgkiln and system schemas', async () => {
    const b = await builder();
    assert.match((await b.get('/builder/create')).body, /href="\/builder\/create\/tables"/);
    const first = await b.get('/builder/create/tables');
    assert.equal(first.statusCode, 200);
    assert.doesNotMatch(first.body, /<option value="meta"|<option value="pg_catalog"|<option value="information_schema"/);
    const page = await b.get(`/builder/create/tables?schema=${SOURCE}`);
    const form = formFields(/<form method="post" action="\/builder\/create\/tables">[\s\S]*?<\/form>/.exec(page.body)![0]);
    assert.deepEqual(Object.entries(form).filter(([k]) => k.startsWith('t_')).map(([, v]) => v), ['region', 'stock_log', 'store'], 'tables ticked, the view not');
    assert.match(page.body, /store_list<\/label>\s*<small class="muted">view: a report/);
    assert.match(page.body, /no single-column primary key: a report/);
    for (const schema of ['meta', 'pg_catalog', 'information_schema', 'nope']) assert.match((await b.get(`/builder/create/tables?schema=${schema}`)).body, /Choose one of the schemas in the list/);
  });

  test('creates the app with report and form pages, a report for a view, navigation and a dashboard', async () => {
    const b = await builder();
    await b.get(`/builder/create/tables?schema=${SOURCE}`);
    const res = await b.submit('/builder/create/tables', {
      schema: SOURCE, t_0: 'region', t_1: 'stock_log', t_2: 'store', t_3: 'store_list', t_9: 'app',
      name: 'AW tables', alias: 'aw35-tables', authentication: 'none', chart: 'true',
    });
    assert.equal(res.statusCode, 200, res.body.slice(0, 2000));
    const a = await owner.one(`select id, db_role from meta.app where alias = 'aw35-tables'`);
    assert.equal(a.db_role, 'app_aw35_tables');
    const pages = (await owner.query('select page_no, name, mode from meta.page where app_id = $1 order by page_no', [a.id])).rows;
    assert.deepEqual(pages.map((p) => [p.page_no, p.name]), [
      [1, 'Home'], [2, 'Region'], [3, 'Region Form'], [4, 'Stock Log'], [5, 'Store'], [6, 'Store Form'], [7, 'Store List'], [8, 'Dashboard'],
    ]);
    const nav = (await owner.query('select label from meta.nav_entry where app_id = $1 order by seq', [a.id])).rows.map((n) => n.label);
    assert.deepEqual(nav, ['Home', 'Region', 'Stock Log', 'Store', 'Store List', 'Dashboard']);
    const charts = (await owner.query(`select r.title from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 8`, [a.id])).rows;
    assert.deepEqual(charts.map((c) => c.title), ['Store per region'], 'the foreign key groups the rows');
    const v = new Browser(app);
    for (const page of [2, 4, 5, 7, 8]) assert.equal((await v.get(`/a/aw35-tables/${page}`)).statusCode, 200, `page ${page}`);
    assert.match((await v.get('/a/aw35-tables/7')).body, /South/);
    assert.match((await v.get('/a/aw35-tables/8')).body, /North/);
    // the source tables are untouched; the app's role may use them
    assert.equal((await owner.one(`select has_table_privilege('app_aw35_tables', '${SOURCE}.store', 'select,insert') as ok`)).ok, true);
    await dropApp('aw35-tables', false);
  });

  test('nothing chosen, a bad alias: the form says so and nothing is created', async () => {
    const b = await builder();
    await b.get(`/builder/create/tables?schema=${SOURCE}`);
    const none = await b.submit('/builder/create/tables', { schema: SOURCE, name: 'AW', alias: 'aw35-tables', authentication: 'none' });
    assert.equal(none.statusCode, 422);
    assert.match(none.body, /Choose at least one table or view/);
    const bad = await b.submit('/builder/create/tables', { schema: SOURCE, t_0: 'region', name: 'AW', alias: 'Bad alias', authentication: 'none' });
    assert.equal(bad.statusCode, 422);
    assert.match(bad.body, /The alias must start with a letter/);
    assert.match(bad.body, /name="t_0" value="region" checked/, 'the choice is kept');
    assert.equal((await owner.query(`select 1 from meta.app where alias = 'aw35-tables'`)).rowCount, 0);
  });
});
