// Sprint 97 (Database Actions DA-6): charts of a query. The worksheet's Chart tab (Create Chart), saving a chart,
// the Charts page with its dashboard, a chart's page (settings, Open in the worksheet, delete).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { chartSpec } from '../src/builder/sql-charts.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
const S = 'ch97';
before(async () => {
  app = await buildApp({ logger: false });
  await owner.query(`drop schema if exists ${S} cascade; create schema ${S}; create table ${S}.sale (region text, amount numeric, units int);
    insert into ${S}.sale values ('North', 100, 3), ('South', 250.5, 7), ('West', 80, 2)`);
  await owner.query(`delete from meta.sql_chart where name like 'ch97%'`);
});
after(async () => {
  await owner.query(`drop schema if exists ${S} cascade`);
  await owner.query(`delete from meta.sql_chart where name like 'ch97%'`);
  await app.close();
  await closePools();
});
const builder = async () => {
  const b = new Browser(app);
  await b.get('/builder/login');
  assert.equal((await b.submit('/builder/login', { username: 'admin', password: 'admin' })).statusCode, 303);
  return b;
};
const SQL = `select region, amount, units from ${S}.sale order by region`;

describe('charts', () => {
  test('the columns drawn: a label and the numbers, or what was asked for', () => {
    assert.deepEqual(chartSpec(['region', 'amount', 'units'], [false, true, true]), { kind: 'bar', label: 'region', values: ['amount', 'units'] });
    assert.deepEqual(chartSpec(['region', 'amount', 'units'], [false, true, true], { kind: 'pie', values: ['units', 'nope'] }), { kind: 'pie', label: 'region', values: ['units'] });
    assert.equal(chartSpec(['a', 'b'], [false, false]), null);
    assert.equal(chartSpec(['region', 'amount'], [false, true], { kind: 'evil' as never }).kind, 'bar');
  });

  test('Create Chart in the worksheet: the Chart tab, settings, its styles with the page\'s nonce', async () => {
    const b = await builder();
    await b.get('/builder/sql/worksheet');
    const res = await b.submit('/builder/sql/worksheet', { sql: SQL, mode: 'chart' });
    const page = res.body;
    assert.match(page, /data-active="chart"/);
    assert.match(page, /<select name="chart_kind" id="ch-kind"><option value="bar" selected>Bar<\/option>/);
    assert.match(page, /<input type="checkbox" name="chart_values" value="amount" checked>/);
    assert.match(page, /<div class="ch-view">.*?North/s);
    const nonce = /'nonce-([^']+)'/.exec(String(res.headers['content-security-policy']))![1];
    assert.match(page, new RegExp(`<style nonce="${nonce.replace(/[+/=]/g, (c) => `\\${c}`)}">\\.x`));
    const pie = (await b.submit('/builder/sql/worksheet', { sql: SQL, mode: 'chart', chart_kind: 'donut', chart_values: 'units' })).body;
    assert.match(pie, /<option value="donut" selected>Donut<\/option>/);
    assert.match(pie, /<input type="checkbox" name="chart_values" value="amount">/);
    assert.match((await b.submit('/builder/sql/worksheet', { sql: `select region from ${S}.sale`, mode: 'chart' })).body, /Nothing to draw/);
  });

  test('save a chart; the Charts page draws the dashboard; a chart\'s page changes, opens and deletes it', async () => {
    const b = await builder();
    await b.get('/builder/sql/worksheet');
    const saved = await b.submit('/builder/sql/charts', { chart_sql: SQL, chart_name: 'ch97 sales', chart_kind: 'column', chart_label: 'region', chart_values: 'amount' });
    assert.equal(saved.statusCode, 303);
    const id = (await owner.one<{ id: number }>(`select id from meta.sql_chart where name = 'ch97 sales'`))!.id;
    assert.equal(saved.headers.location, `/builder/sql/charts/${id}`);
    const list = (await b.get('/builder/sql/charts')).body;
    assert.match(list, new RegExp(`<section class="ch-card"><h2><a href="/builder/sql/charts/${id}">ch97 sales</a></h2>`));
    assert.match(list, /aria-current="page"><svg[^>]*>.*?<\/svg><span>Charts<\/span>/s);
    const one = (await b.get(`/builder/sql/charts/${id}`)).body;
    assert.match(one, /<option value="column" selected>Column<\/option>/);
    assert.match(one, /3 rows\./);
    await b.submit(`/builder/sql/charts/${id}`, { name: 'ch97 sales by units', chart_kind: 'line', chart_label: 'region', chart_values: 'units', action: 'save' });
    assert.deepEqual(await owner.one(`select name, kind, value_cols, on_dashboard from meta.sql_chart where id = $1`, [id]), { name: 'ch97 sales by units', kind: 'line', value_cols: ['units'], on_dashboard: false });
    assert.equal((await b.submit(`/builder/sql/charts/${id}`, { action: 'worksheet' })).headers.location, '/builder/sql/worksheet');
    assert.match((await b.get('/builder/sql/worksheet')).body, />select region, amount, units from ch97\.sale order by region<\/textarea>/);
    await b.submit(`/builder/sql/charts/${id}`, { action: 'delete' });
    assert.equal(await owner.one(`select 1 as x from meta.sql_chart where id = $1`, [id]), undefined);
  });

  test('only one SELECT is saved; a saved chart runs read-only; others\' workspaces and unknown ids are not found', async () => {
    const b = await builder();
    await b.get('/builder/sql/worksheet');
    await b.submit('/builder/sql/charts', { chart_sql: `delete from ${S}.sale`, chart_name: 'ch97 evil' });
    assert.equal(await owner.one(`select 1 as x from meta.sql_chart where name = 'ch97 evil'`), undefined);
    const r = await owner.one<{ id: number }>(`insert into meta.sql_chart (name, sql) values ('ch97 sneaky', 'select region, amount from ${S}.sale for update') returning id`);
    const page = (await b.get(`/builder/sql/charts/${r!.id}`)).body;
    assert.match(page, /cannot execute SELECT FOR UPDATE in a read-only transaction/);
    for (const url of ['/builder/sql/charts/999999', '/builder/sql/charts/x']) assert.equal((await b.get(url)).statusCode, 404, url);
    const other = await owner.one<{ id: number }>(`insert into meta.workspace (name) values ('ch97 other') returning id`);
    const theirs = await owner.one<{ id: number }>(`insert into meta.sql_chart (workspace_id, name, sql) values ($1, 'ch97 theirs', 'select 1') returning id`, [other!.id]);
    assert.equal((await b.get(`/builder/sql/charts/${theirs!.id}`)).statusCode, 404);
    await owner.query(`delete from meta.workspace where name = 'ch97 other'`);
  });
});
