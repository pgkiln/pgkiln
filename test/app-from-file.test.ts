// Sprint 32 item 5: Create → From a file (APEX: Create App from a File).
// Upload a CSV/TSV/XLSX file, check the proposed table, and get a new
// application with its own role and schema, the table with the rows, and a
// report and form, a dashboard and a faceted search (src/builder/appfromfile.ts).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { appNameFor, groupColumn, tableNameFor } from '../src/builder/appfromfile.ts';
import { Browser, formFields } from './helpers.ts';

let app: FastifyInstance;
const ALIASES = ['ff32-products', 'ff32-xlsx', 'ff32-bad', 'ff32-skip', 'ff32-login', 'ff32-taken'];
const ACCOUNT = 'ff32_owner';

async function cleanup() {
  for (const alias of ALIASES) {
    const schema = alias.replace(/-/g, '_');
    const role = `app_${schema}`;
    await owner.query('delete from meta.app where alias = $1', [alias]);
    await owner.query(`drop schema if exists ${schema} cascade`);
    if ((await owner.query('select 1 from pg_roles where rolname = $1', [role])).rowCount) {
      await owner.query(`drop owned by ${role}`);
      await owner.query(`drop role ${role}`);
    }
  }
  await owner.query('delete from meta.account where username = $1', [ACCOUNT]);
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

const CSV = [
  'Product Name;Category;Price;In stock;Released',
  'Hammer;Tools;12.50;yes;2026-01-10',
  'Saw;Tools;20;no;2026-02-01',
  'Kite;Toys;8;yes;2026-03-15',
  '"Ball; red";Toys;3.25;yes;2026-04-01',
].join('\n');
const csv = (text = CSV, name = 'products.csv') => ({ file: { name, type: 'text/csv', data: Buffer.from(text) } });

/** Upload a file, then return the step 2 URL and the proposed form. */
async function upload(b: Browser, files: ReturnType<typeof csv>, headers = true) {
  await b.get('/builder/create/file');
  const res = await b.upload('/builder/create/file', headers ? { headers: 'true' } : {}, files);
  assert.equal(res.statusCode, 303, res.body.slice(0, 500));
  const url = res.headers.location as string;
  const page = await b.get(url);
  assert.equal(page.statusCode, 200);
  const form = /<form method="post" action="\/builder\/create\/file\/[^"]+">[\s\S]*?<\/form>/.exec(page.body)![0];
  return { url, body: page.body, fields: formFields(form) };
}

describe('names proposed from the file name', () => {
  test('application name and table name', () => {
    assert.equal(appNameFor('employee-list_2026.xlsx'), 'Employee list 2026');
    assert.equal(appNameFor('C:\\data\\orders.csv'), 'Orders');
    assert.equal(tableNameFor('Employee List 2026.xlsx'), 'employee_list_2026');
    assert.equal(tableNameFor('2026 sales.csv'), 'c_2026_sales');
  });
  test('the dashboard counts the rows by a text, yes/no or date column whose values repeat', () => {
    const col = (column_name: string, kind: string, distinct_values: number | null, is_pk = false) => ({ column_name, kind, distinct_values, is_pk });
    const cat = [col('id', 'number', 10, true), col('name', 'text', 10), col('done', 'boolean', 2), col('city', 'text', 3), col('day', 'date', 4)];
    assert.equal(groupColumn(cat, 10), 'city');
    assert.equal(groupColumn(cat.filter((c) => c.column_name !== 'city'), 10), 'done');
    assert.equal(groupColumn([col('name', 'text', 10), col('n', 'number', 2)], 10), null);
    assert.equal(groupColumn([col('city', 'text', null)], 10), null, 'no statistics');
  });
});

describe('create an application from a CSV file', () => {
  test('the Create page links to it; step 2 proposes the app, the table and the column names and types', async () => {
    const b = await builder();
    assert.match((await b.get('/builder/create')).body, /href="\/builder\/create\/file"/);
    const { body, fields } = await upload(b, csv());
    assert.match(body, /products\.csv: 4 row\(s\), 5 column\(s\), delimiter “;”/);
    assert.equal(fields.name, 'Products');
    assert.equal(fields.alias, 'products');
    assert.equal(fields.table, 'products');
    assert.deepEqual(
      [0, 1, 2, 3, 4].map((i) => [fields[`name_${i}`], fields[`type_${i}`]]),
      [['product_name', 'text'], ['category', 'text'], ['price', 'numeric'], ['in_stock', 'boolean'], ['released', 'date']],
    );
    assert.equal(fields.chart, 'true');
    assert.equal(fields.facets, 'true');
    assert.match(body, /Hammer · Saw · Kite/, 'sample values');
  });

  test('creates the app with its own role and schema, the table with the rows, the pages and the navigation', async () => {
    const b = await builder();
    const { url, fields } = await upload(b, csv());
    const res = await b.submit(url, { ...fields, alias: 'ff32-products', name: 'FF products', authentication: 'none', name_0: 'name' });
    assert.equal(res.statusCode, 200, res.body.slice(0, 2000));
    assert.match(res.body, /Application ff32-products created\. ff32_products\.products: 4 row\(s\) loaded\./);
    const a = await owner.one(`select id, db_role from meta.app where alias = 'ff32-products'`);
    assert.equal(a.db_role, 'app_ff32_products');
    const rows = (await owner.query('select name, category, price, in_stock, released::text from ff32_products.products order by id')).rows;
    assert.deepEqual(rows[3], { name: 'Ball; red', category: 'Toys', price: '3.25', in_stock: true, released: '2026-04-01' });
    const col = await owner.one(`select attidentity from pg_attribute where attrelid = 'ff32_products.products'::regclass and attname = 'id'`);
    assert.equal(col.attidentity, 'd', 'identity primary key');
    const priv = await owner.one(
      `select has_table_privilege('app_ff32_products', 'ff32_products.products', 'select,insert,update,delete') as t,
              has_table_privilege('app_ff32_products', 'meta.account', 'select') as m`,
    );
    assert.deepEqual(priv, { t: true, m: false });
    const pages = (await owner.query('select page_no, name, mode from meta.page where app_id = $1 order by page_no', [a.id])).rows;
    assert.deepEqual(pages.map((p) => p.page_no), [1, 2, 3, 4, 5]);
    assert.equal(pages[2].mode, 'modal');
    const nav = (await owner.query('select label, target_page from meta.nav_entry where app_id = $1 order by seq', [a.id])).rows;
    assert.deepEqual(nav.map((n) => n.target_page), [1, 2, 4, 5]);
    assert.equal(nav[2].label, 'Dashboard');
    const chart = await owner.one(`select r.type, r.source from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 4`, [a.id]);
    assert.equal(chart.type, 'chart');
    assert.match(chart.source, /"category"|\bcategory\b/, 'the rows are counted per category (repeated values), not per name');
    const facets = await owner.one(`select r.config from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 5 and r.type = 'facets'`, [a.id]);
    assert.doesNotMatch(JSON.stringify(facets.config), /"name"/, 'a name per row is no facet');
    // the app runs: the report, the chart and the faceted search show the rows
    const v = new Browser(app);
    for (const page of [2, 4, 5]) {
      const r = await v.get(`/a/ff32-products/${page}`);
      assert.equal(r.statusCode, 200, `page ${page}`);
      if (page !== 4) assert.match(r.body, /Ball; red/, `page ${page}`);
    }
    // the temporary file is gone: posting again goes back to step 1
    const again = await b.submit(url, { ...fields, alias: 'ff32-products2' });
    assert.equal(again.statusCode, 303);
    assert.equal(again.headers.location, '/builder/create/file');
  });

  test('Excel: renamed and skipped columns, other types, no dashboard or facets', async () => {
    const b = await builder();
    const { url, fields } = await upload(b, { file: { name: 'employees.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data: readFileSync('test/fixtures/employees.xlsx') } });
    assert.equal(fields.name_3, 'hiredate');
    assert.equal(fields.type_3, 'date');
    const { chart: _c, facets: _f, ...rest } = fields;
    const res = await b.submit(url, { ...rest, alias: 'ff32-xlsx', name: 'FF xlsx', authentication: 'none', table: 'staff', name_0: 'emp_no', type_4: 'text', name_5: '' });
    assert.equal(res.statusCode, 200, res.body.slice(0, 2000));
    const cols = (await owner.query(`select column_name, data_type from information_schema.columns where table_schema = 'ff32_xlsx' and table_name = 'staff' order by ordinal_position`)).rows;
    assert.deepEqual(cols.map((c) => c.column_name), ['id', 'emp_no', 'ename', 'job', 'hiredate', 'sal']);
    assert.equal(cols[5].data_type, 'text');
    const a = await owner.one(`select id from meta.app where alias = 'ff32-xlsx'`);
    assert.deepEqual((await owner.query('select page_no from meta.page where app_id = $1 order by 1', [a.id])).rows.map((p) => p.page_no), [1, 2, 3]);
  });

  test('a row that does not fit: nothing is created and the rows are listed; skipping loads the others', async () => {
    const bad = `${CSV}\nGlue;Tools;cheap;yes;2026-05-01`;
    const b = await builder();
    const { url, fields } = await upload(b, csv(bad, 'bad.csv'));
    // the type was inferred as text because of the bad value: make it numeric
    assert.equal(fields.type_2, 'text');
    const res = await b.submit(url, { ...fields, alias: 'ff32-bad', name: 'FF bad', authentication: 'none', type_2: 'numeric' });
    assert.equal(res.statusCode, 422);
    assert.match(res.body, /1 row\(s\) could not be loaded/);
    assert.match(res.body, /<td class="num">6<\/td><td>invalid input syntax for type numeric: &quot;cheap&quot;/);
    assert.match(res.body, /value="ff32-bad"/, 'the form keeps the values');
    assert.equal((await owner.query(`select 1 from meta.app where alias = 'ff32-bad'`)).rowCount, 0);
    assert.equal((await owner.query(`select 1 from pg_namespace where nspname = 'ff32_bad'`)).rowCount, 0);
    assert.equal((await owner.query(`select 1 from pg_roles where rolname = 'app_ff32_bad'`)).rowCount, 0);
    const skip = await b.submit(url, { ...fields, alias: 'ff32-skip', name: 'FF skip', authentication: 'none', type_2: 'numeric', skip_errors: 'true' });
    assert.equal(skip.statusCode, 200);
    assert.match(skip.body, /4 row\(s\) loaded, 1 skipped/);
    assert.match(skip.body, /Skipped rows/);
    assert.equal((await owner.one('select count(*)::int as n from ff32_skip.bad')).n, 4);
  });

  test('with a login page: the first user gets the admin role and can use the pages', async () => {
    const b = await builder();
    const { url, fields } = await upload(b, csv());
    const weak = await b.submit(url, { ...fields, alias: 'ff32-login', name: 'FF login', authentication: 'app_users', admin_user: ACCOUNT, admin_password: 'short' });
    assert.equal(weak.statusCode, 422);
    assert.doesNotMatch(weak.body, /value="short"/, 'the password is not sent back');
    const res = await b.submit(url, { ...fields, alias: 'ff32-login', name: 'FF login', authentication: 'app_users', admin_user: ACCOUNT, admin_password: 'Products-2026!' });
    assert.equal(res.statusCode, 200, res.body.slice(0, 1500));
    const u = new Browser(app);
    assert.equal((await u.get('/a/ff32-login/2')).statusCode, 302, 'sign-in needed');
    await u.login(ACCOUNT, 'Products-2026!', 'ff32-login');
    const page = await u.get('/a/ff32-login/2');
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /Hammer/);
  });

  test('a taken alias, a bad table name and bad column names are reported on the form', async () => {
    const b = await builder();
    const { url, fields } = await upload(b, csv());
    const base = { ...fields, alias: 'ff32-taken', name: 'FF taken', authentication: 'none' };
    for (const [form, message] of [
      [{ ...base, alias: 'ff32-products' }, /An application with the alias ff32-products already exists/],
      [{ ...base, table: 'public.products' }, /without a schema/],
      [{ ...base, table: 'Bad Name' }, /lower-case name/],
      [{ ...base, name_1: 'id' }, /&quot;id&quot; is not a valid column name/],
      [{ ...base, name_1: 'price' , name_2: 'price' }, /Column names must be unique/],
      [{ ...base, type_1: 'bytea' }, /Unknown column type bytea/],
      [Object.fromEntries(Object.entries(base).map(([k, v]) => [k, k.startsWith('name_') ? '' : v])), /at least one column/],
    ] as [Record<string, string>, RegExp][]) {
      const res = await b.submit(url, form);
      assert.equal(res.statusCode, 422, JSON.stringify(form));
      assert.match(res.body, message);
    }
    assert.equal((await owner.query(`select 1 from meta.app where alias = 'ff32-taken'`)).rowCount, 0);
  });

  test('step 1 refuses a missing, empty or binary file', async () => {
    const b = await builder();
    await b.get('/builder/create/file');
    const none = await b.upload('/builder/create/file', { headers: 'true' }, {});
    assert.equal(none.statusCode, 422);
    assert.match(none.body, /Choose a file/);
    const empty = await b.upload('/builder/create/file', { headers: 'true' }, csv('a;b\n', 'empty.csv'));
    assert.equal(empty.statusCode, 422);
    assert.match(empty.body, /no rows/);
    const binary = await b.upload('/builder/create/file', { headers: 'true' }, csv('a\0b', 'x.csv'));
    assert.equal(binary.statusCode, 422);
  });
});
