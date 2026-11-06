// Sprint 167 (the design questions the sample apps raised): hidden items the browser may set
// ({"value_protected": false}), default values for a grid's new rows (columns.<col>.default / default_sql),
// items in any region type (a tree), a login region that leaves the focus alone ({"autofocus": false}), and a
// region-slot button before Next in the bottom bar.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
const alias = 's167';
const ROLE = 'pgkiln_s167';
let gridId = 0;
let daProtected = 0;

/** A grid's posted fields as a browser would send them (unchecked checkboxes left out). */
const gridFields = (body: string, g: string) => {
  const form: Record<string, string> = {};
  for (const m of body.matchAll(new RegExp(`<input([^>]*)name="(${g}_[a-z0-9_]+)"[^>]*value="([^"]*)"[^>]*>`, 'g'))) {
    if (/type="checkbox"/.test(m[0]) && !/ checked/.test(m[0])) continue;
    form[m[2]] = m[3].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  }
  return form;
};

before(async () => {
  app = await buildApp({ logger: false });
  await owner.query(`delete from meta.app where alias = $1`, [alias]);
  await owner.query(`drop schema if exists s167 cascade`);
  await owner.query(`drop role if exists ${ROLE}`);
  await owner.query(`create role ${ROLE} nologin`);
  await owner.query(`grant ${ROLE} to pgkiln_runtime`);
  await owner.query(`create schema s167;
    create table s167.thing (id int generated always as identity primary key, name text, status text, made date, qty int);
    create table s167.node (id text primary key, parent_id text, label text);
    insert into s167.node values ('a', null, 'Alpha'), ('b', 'a', 'Beta');
    grant usage on schema s167 to ${ROLE};
    grant select, insert, update, delete on s167.thing to ${ROLE};
    grant select on s167.node to ${ROLE};`);
  const appId = (await owner.one(`insert into meta.app (alias, name, db_role) values ($1, 'Sprint 167', $2) returning id`, [alias, ROLE])).id;
  const page = async (no: number) => (await owner.one(`insert into meta.page (app_id, page_no, name, requires_auth) values ($1, $2, 'P', false) returning id`, [appId, no])).id;
  const p1 = await page(1);
  const region = async (p: number, seq: number, type: string, extra: Record<string, unknown> = {}) =>
    (await owner.one(
      `insert into meta.region (page_id, seq, title, type, source, table_name, pk_column, config) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [p, seq, `R${seq}`, type, extra.source ?? null, extra.table ?? null, extra.pk ?? null, extra.config ?? {}],
    )).id;
  const form = await region(p1, 1, 'static', { source: 'P=&P1_P. H=&P1_H.' });
  gridId = await region(p1, 2, 'grid', {
    source: 'select id, name, status, made, qty from s167.thing order by id', table: 's167.thing', pk: 'id',
    config: { columns: { status: { default: '&P1_STATUS.' }, made: { default_sql: "select date '2026-11-06'" }, qty: { default: 5 } } },
  });
  const tree = await region(p1, 3, 'tree', { source: 'select id, parent_id, label from s167.node' });
  await owner.query(`insert into meta.item (page_id, region_id, seq, name, label, type, default_value, config) values
    ($1, $2, 1, 'P1_H', null, 'hidden', 'start', '{"value_protected": false}'),
    ($1, $2, 2, 'P1_P', null, 'hidden', null, '{}'),
    ($1, $2, 3, 'P1_STATUS', null, 'hidden', null, '{}'),
    ($1, $3, 1, 'P1_SHOWN', 'Chosen node', 'display', 'none yet', '{}')`, [p1, form, tree]);
  await owner.query(`insert into meta.computation (page_id, seq, item_name, point, type, expression) values ($1, 1, 'P1_STATUS', 'before_header', 'static', 'OPEN')`, [p1]);
  await owner.query(`insert into meta.process (page_id, seq, name, type, region_id) values ($1, 1, 'Save', 'grid_dml', $2)`, [p1, gridId]);
  await owner.query(`insert into meta.button (page_id, region_id, seq, name, label, slot) values
    ($1, $2, 1, 'GO_ON', 'Next one', 'next'), ($1, $2, 2, 'SAVE', 'Save it', 'region'), ($1, $2, 3, 'BACK', 'Back', 'previous')`, [p1, form]);
  daProtected = (await owner.one(`insert into meta.dynamic_action (page_id, seq, name, event, trigger_element, action, affected_items, code)
    values ($1, 1, 'Protected', 'click', 'SAVE', 'set_value', 'P1_P', 'select ''from the server''') returning id`, [p1])).id;
  // two login regions: the default puts the cursor in the user name, {"autofocus": false} doesn't
  const p2 = await page(2);
  await region(p2, 1, 'login');
  const p3 = await page(3);
  await region(p3, 1, 'login', { config: { autofocus: false } });
});
after(async () => {
  await owner.query(`delete from meta.app where alias = $1`, [alias]);
  await owner.query(`drop schema if exists s167 cascade`);
  await owner.query(`drop role if exists ${ROLE}`);
  await app.close();
  await closePools();
});

describe('sprint 167: hidden items the browser may set', () => {
  test('an unprotected hidden item is a hidden input; a protected one is not rendered', async () => {
    const body = (await new Browser(app).get(`/a/${alias}/1`)).body;
    assert.match(body, /<input type="hidden" id="P1_H" name="P1_H" value="start" data-item="P1_H">/);
    assert.doesNotMatch(body, /name="P1_P"/, 'protected: the value stays on the server');
  });

  test('a submit takes the unprotected item\'s posted value, never the protected one\'s', async () => {
    const b = new Browser(app);
    await b.get(`/a/${alias}/1`);
    const res = await b.submit(`/a/${alias}/1`, { __request: 'SAVE', P1_H: 'from the browser', P1_P: 'forged' });
    assert.equal(res.statusCode, 303);
    const body = (await b.get(`/a/${alias}/1`)).body;
    assert.match(body, /H=from the browser/);
    assert.doesNotMatch(body, /forged/);
    assert.match(body, /name="P1_H" value="from the browser"/);
  });

  test('a server-side set_value sets a protected hidden item\'s session value (not sent to the browser)', async () => {
    const b = new Browser(app);
    await b.get(`/a/${alias}/1`);
    const res = await b.post(`/a/${alias}/1/da/${daProtected}`, { __csrf: b.lastCsrf });
    assert.equal(res.statusCode, 200);
    const body = (await b.get(`/a/${alias}/1`)).body;
    assert.match(body, /P=from the server/);
    assert.doesNotMatch(body, /value="from the server"/);
  });
});

describe('sprint 167: default values for a grid\'s new rows', () => {
  const g = () => `g${gridId}`;

  test('the new row starts with the columns\' defaults (text with &ITEM., a number, a SELECT) and posts them as _def', async () => {
    const body = (await new Browser(app).get(`/a/${alias}/1`)).body;
    const f = gridFields(body, g());
    assert.equal(f[`${g()}_n0_c2`], 'OPEN');
    assert.equal(f[`${g()}_n0_c3`], '2026-11-06');
    assert.equal(f[`${g()}_n0_c4`], '5');
    assert.equal(f[`${g()}_n0_c1`], '', 'no default: empty');
    assert.deepEqual(JSON.parse(f[`${g()}_n0_def`]), { 2: 'OPEN', 3: '2026-11-06', 4: '5' });
  });

  test('a new row left at its defaults is blank; a filled-in one is inserted with them', async () => {
    const b = new Browser(app);
    const f = gridFields((await b.get(`/a/${alias}/1`)).body, g());
    await b.submit(`/a/${alias}/1`, { ...f, __request: `GRID_SAVE_${gridId}` });
    assert.equal((await owner.query(`select from s167.thing`)).rowCount, 0, 'untouched: not inserted');
    const res = await b.submit(`/a/${alias}/1`, { ...f, [`${g()}_n0_c1`]: 'Widget', __request: `GRID_SAVE_${gridId}` });
    assert.equal(res.statusCode, 303);
    const row = await owner.one(`select name, status, made::text, qty from s167.thing`);
    assert.deepEqual(row, { name: 'Widget', status: 'OPEN', made: '2026-11-06', qty: 5 });
    await owner.query(`truncate s167.thing`);
  });

  test('a changed default alone makes the row count; a broken _def only stops it being blank', async () => {
    const b = new Browser(app);
    const f = gridFields((await b.get(`/a/${alias}/1`)).body, g());
    await b.submit(`/a/${alias}/1`, { ...f, [`${g()}_n0_c4`]: '7', __request: `GRID_SAVE_${gridId}` });
    assert.equal((await owner.one(`select qty from s167.thing`)).qty, 7);
    await owner.query(`truncate s167.thing`);
    for (const bad of ['not json', '[1,2]', '{"2": 5}', 'x'.repeat(30000)]) {
      const res = await b.submit(`/a/${alias}/1`, { ...f, [`${g()}_n0_def`]: bad, __request: `GRID_SAVE_${gridId}` });
      assert.equal(res.statusCode, 303, bad.slice(0, 20));
    }
    // without a usable _def the defaults are values like any other: the rows are inserted
    assert.equal((await owner.query(`select from s167.thing`)).rowCount, 4);
    await owner.query(`truncate s167.thing`);
  });
});

describe('sprint 167: layout', () => {
  test('items placed in a tree region are shown under the tree', async () => {
    const body = (await new Browser(app).get(`/a/${alias}/1`)).body;
    assert.match(body, /class="tree-view[\s\S]*<div class="form-grid region-items">[\s\S]*data-item="P1_SHOWN"[\s\S]*none yet/);
  });

  test('a region-slot button comes before Next in the bottom bar', async () => {
    const body = (await new Browser(app).get(`/a/${alias}/1`)).body;
    const end = /<div class="region-footer-end">([\s\S]*?)<\/div><\/footer>/.exec(body)?.[1] ?? '';
    assert.ok(end.indexOf('Save it') >= 0 && end.indexOf('Save it') < end.indexOf('Next one'), end);
    assert.match(/<div class="region-footer-start">([\s\S]*?)<\/div>/.exec(body)?.[1] ?? '', /Back/);
  });

  test('a login region puts the cursor in the user name unless {"autofocus": false}', async () => {
    assert.match((await new Browser(app).get(`/a/${alias}/2`)).body, /id="username"[^>]*autofocus/);
    const off = (await new Browser(app).get(`/a/${alias}/3`)).body;
    assert.match(off, /id="username"/);
    assert.doesNotMatch(off, /id="username"[^>]*autofocus/);
  });
});
