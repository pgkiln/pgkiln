// Sprint 173 (parity leftovers): DA-6 an application page from a saved chart (a page with a Chart region whose
// source is the chart's SELECT, label column first); DA-3 the SQL Worksheet's Query Result loads its next rows as the
// grid scrolls to its end.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { chartRegionSource } from '../src/builder/sql-charts.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
let role: string;
const S = 'ch173';
const PAGE = 8173;

const clean = async () => {
  await owner.query(`delete from meta.nav_entry where app_id = $1 and target_page = $2`, [appId, PAGE]);
  await owner.query(`delete from meta.page where app_id = $1 and page_no = $2`, [appId, PAGE]);
  await owner.query(`delete from meta.sql_chart where name like 'ch173%'`);
};
before(async () => {
  app = await buildApp({ logger: false });
  const a = (await owner.one<{ id: number; db_role: string }>(`select id, db_role from meta.app where alias = 'hr'`))!;
  appId = a.id;
  role = a.db_role;
  await owner.query(`drop schema if exists ${S} cascade; create schema ${S}; create table ${S}.sale (region text, amount numeric, units int);
    insert into ${S}.sale values ('North', 100, 3), ('South', 250.5, 7), ('West', 80, 2);
    grant usage on schema ${S} to ${role}; grant select on ${S}.sale to ${role}`);
  await clean();
});
after(async () => {
  await clean();
  await owner.query(`drop schema if exists ${S} cascade`);
  await app.close();
  await closePools();
});
const builder = async () => {
  const b = new Browser(app);
  await b.get('/builder/login');
  assert.equal((await b.submit('/builder/login', { username: 'admin', password: 'admin' })).statusCode, 303);
  await b.ownerConnection(); // (sprint 185) the owner's schemas: the Owner connection
  return b;
};
const SQL = `select region, amount, units from ${S}.sale order by region`;

describe('an application page from a saved chart (DA-6)', () => {
  test('the region source: the label first, then the values, identifiers quoted', () => {
    assert.equal(chartRegionSource('select 1 as n, 2 as "a""b", \'x\' as l;', { kind: 'bar', label: 'l', values: ['a"b', 'n'] }),
      'select "l", "a""b", "n"\n  from (\nselect 1 as n, 2 as "a""b", \'x\' as l\n) chart_rows');
  });

  test('the chart\'s page names the application; the page is created with a Chart region and a menu entry, and it draws', async () => {
    const b = await builder();
    await b.get('/builder/sql/worksheet');
    await b.submit('/builder/sql/charts', { chart_sql: SQL, chart_name: 'ch173 sales', chart_kind: 'column', chart_label: 'region', chart_values: 'units' });
    const id = (await owner.one<{ id: number }>(`select id from meta.sql_chart where name = 'ch173 sales'`))!.id;
    const one = (await b.get(`/builder/sql/charts/${id}`)).body;
    assert.match(one, new RegExp(`<form method="get" action="/builder/sql/charts/${id}/page"`));
    assert.match(one, new RegExp(`<option value="${appId}">`));
    const go = await b.get(`/builder/sql/charts/${id}/page?app=${appId}`);
    assert.equal(go.headers.location, `/builder/apps/${appId}/chart-page?chart=${id}`);
    const step = (await b.get(`/builder/apps/${appId}/chart-page?chart=${id}`)).body;
    assert.match(step, /name="name"[^>]*value="ch173 sales"/);
    assert.match(step, /select &quot;region&quot;, &quot;units&quot;/);
    assert.match(step, new RegExp(`database role, ${role}`));
    const made = await b.submit(`/builder/apps/${appId}/chart-page`, { chart: String(id), page_no: String(PAGE), name: 'Sales by region', nav: 'on' });
    assert.equal(made.statusCode, 303);
    const page = (await owner.one<{ id: number; name: string }>('select id, name from meta.page where app_id = $1 and page_no = $2', [appId, PAGE]))!;
    assert.equal(made.headers.location, `/builder/pages/${page.id}`);
    assert.equal(page.name, 'Sales by region');
    const r = (await owner.one<{ type: string; source: string; config: { kind: string } }>('select type, source, config from meta.region where page_id = $1', [page.id]))!;
    assert.equal(r.type, 'chart');
    assert.equal(r.config.kind, 'column');
    assert.equal(r.source, `select "region", "units"\n  from (\n${SQL}\n) chart_rows`);
    assert.deepEqual(await owner.one('select label, icon from meta.nav_entry where app_id = $1 and target_page = $2', [appId, PAGE]), { label: 'Sales by region', icon: 'chart' });
    // the page in the application: the chart with its three labels
    const king = new Browser(app);
    assert.equal((await king.login('king')).statusCode, 303);
    const body = (await king.get(`/a/hr/${PAGE}`)).body;
    for (const label of ['North', 'South', 'West']) assert.match(body, new RegExp(label));
    assert.doesNotMatch(body, /alert-error/);
  });

  test('a page number in use, no name: an error and nothing is made; without the menu box there is no entry', async () => {
    const b = await builder();
    const id = (await owner.one<{ id: number }>(`select id from meta.sql_chart where name = 'ch173 sales'`))!.id;
    await b.get(`/builder/apps/${appId}/chart-page?chart=${id}`);
    const pages = async () => Number((await owner.one<{ n: string }>('select count(*) as n from meta.page where app_id = $1', [appId]))!.n);
    const before = await pages();
    for (const body of [{ page_no: String(PAGE), name: 'Again' }, { page_no: '8174', name: ' ' }, { page_no: 'x', name: 'X' }]) {
      const res = await b.submit(`/builder/apps/${appId}/chart-page`, { chart: String(id), ...body });
      assert.equal(res.headers.location, `/builder/apps/${appId}/chart-page?chart=${id}`);
      assert.match((await b.get(res.headers.location as string)).body, /Enter a name and a page number that is not in use/);
    }
    assert.equal(await pages(), before);
    await owner.query(`delete from meta.nav_entry where app_id = $1 and target_page = $2`, [appId, PAGE]);
    await owner.query(`delete from meta.page where app_id = $1 and page_no = $2`, [appId, PAGE]);
    await b.submit(`/builder/apps/${appId}/chart-page`, { chart: String(id), page_no: String(PAGE), name: 'No menu' });
    assert.equal(await owner.one('select 1 as x from meta.nav_entry where app_id = $1 and target_page = $2', [appId, PAGE]), undefined);
  });

  test('a chart without a number column makes no page; unknown charts and applications are not found', async () => {
    const b = await builder();
    const r = (await owner.one<{ id: number }>(`insert into meta.sql_chart (name, sql) values ('ch173 text', 'select region from ${S}.sale') returning id`))!;
    await b.get(`/builder/apps/${appId}/chart-page?chart=${r.id}`);
    const res = await b.submit(`/builder/apps/${appId}/chart-page`, { chart: String(r.id), page_no: '8175', name: 'Text' });
    assert.equal(res.headers.location, `/builder/apps/${appId}/chart-page?chart=${r.id}`);
    assert.equal(await owner.one('select 1 as x from meta.page where app_id = $1 and page_no = 8175', [appId]), undefined);
    for (const url of [`/builder/apps/${appId}/chart-page?chart=999999`, `/builder/apps/${appId}/chart-page?chart=x`, `/builder/apps/999999/chart-page?chart=${r.id}`,
      `/builder/sql/charts/${r.id}/page?app=x`, `/builder/sql/charts/x/page?app=${appId}`])
      assert.equal((await b.get(url)).statusCode, 404, url);
  });
});

describe('SQL Worksheet: the next rows on scroll (DA-3)', () => {
  const MANY = 'select g as n, case when g % 7 = 0 then null else \'row \' || g end as label from generate_series(1, 1234) g order by g';

  test('a query with more rows than shown: the grid says where the next rows start; a short one and All rows do not', async () => {
    const b = await builder();
    await b.get('/builder/sql/worksheet');
    const page = (await b.submit('/builder/sql/worksheet', { sql: MANY, mode: 'statement' })).body;
    assert.match(page, /<table class="report" data-ws-grid data-ws-more="500">/);
    assert.match(page, /<span data-ws-showing>showing the first 500<\/span>/);
    assert.match(page, /<p class="ws-more muted small" data-ws-more-end hidden>More rows load as you scroll\.<\/p>/);
    assert.match(page, /name="mode" value="statement_all"/, 'All rows stays, also for a browser without JavaScript');
    const short = (await b.submit('/builder/sql/worksheet', { sql: 'select 1 as n', mode: 'statement' })).body;
    assert.doesNotMatch(short, /data-ws-more/);
    const all = (await b.submit('/builder/sql/worksheet', { sql: MANY, mode: 'statement_all' })).body;
    assert.doesNotMatch(all, /data-ws-more/);
    // a statement that is not one SELECT cannot be read again
    const dml = (await b.submit('/builder/sql/worksheet', { sql: `insert into ${S}.sale select 'r' || g, g, g from generate_series(1, 600) g returning region`, mode: 'statement' })).body;
    assert.match(dml, /showing the first 500/);
    assert.doesNotMatch(dml, /data-ws-more/, 'not one SELECT: it cannot be read again');
    await owner.query(`delete from ${S}.sale where region like 'r%'`);
  });

  test('the rows from an offset, as the grid shows them; the last part says there is no more', async () => {
    const b = await builder();
    await b.get('/builder/sql/worksheet');
    const next = await b.submit('/builder/sql/worksheet/rows', { query: MANY, offset: '500' });
    assert.equal(next.statusCode, 200);
    assert.match(String(next.headers['content-type']), /application\/json/);
    const one = JSON.parse(next.body) as { rows: (string | null)[][]; more: boolean };
    assert.equal(one.rows.length, 500);
    assert.deepEqual(one.rows[0], ['501', 'row 501']);
    assert.deepEqual(one.rows[3], ['504', null], 'a null stays a null');
    assert.equal(one.more, true);
    const last = JSON.parse((await b.submit('/builder/sql/worksheet/rows', { query: `${MANY};`, offset: '1000' })).body);
    assert.equal(last.rows.length, 234);
    assert.equal(last.more, false);
    assert.deepEqual(JSON.parse((await b.submit('/builder/sql/worksheet/rows', { query: MANY, offset: '1234' })).body), { rows: [], more: false });
  });

  test('never past 10,000 rows; not a SELECT, a bad offset and an error are refused', async () => {
    const b = await builder();
    await b.get('/builder/sql/worksheet');
    const big = 'select g from generate_series(1, 20000) g';
    const end = JSON.parse((await b.submit('/builder/sql/worksheet/rows', { query: big, offset: '9800' })).body);
    assert.equal(end.rows.length, 200);
    assert.equal(end.more, false);
    for (const offset of ['10000', '-1', 'x', '']) assert.equal((await b.submit('/builder/sql/worksheet/rows', { query: big, offset })).statusCode, 400, offset);
    for (const query of [`delete from ${S}.sale`, 'select 1; select 2', ''])
      assert.equal((await b.submit('/builder/sql/worksheet/rows', { query, offset: '0' })).statusCode, 400, query);
    const bad = await b.submit('/builder/sql/worksheet/rows', { query: 'select * from ch173.nothing_here', offset: '0' });
    assert.equal(bad.statusCode, 422);
    assert.match(JSON.parse(bad.body).error, /nothing_here/);
  });
});
