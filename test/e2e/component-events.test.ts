// Sprint 161 (CD-3, part 2): component events of grid, calendar, map and tree regions in a real browser:
// grid_row_init and grid_save, calendar_date_select (with Cancel Event) and calendar_view_change,
// map_object_click and map_change, tree_selection_change. Each event's condition sees the component's value.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools, owner } from '../../src/db.ts';
import { png } from '../../src/runtime/pwa.ts';
import { tileOrigin } from '../../src/maptiles.ts';

let base = '';
let browser: Browser;
let close: () => Promise<void>;
const alias = 'da-s161';
const ROLE = 'pgkiln_s161_da';
const TILE = png(256, 256, new Uint8Array(256 * 256 * 4).fill(220));
const today = new Date().toISOString().slice(0, 10);

before(async () => {
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  await owner.query(`delete from meta.app where alias = $1`, [alias]);
  await owner.query(`drop schema if exists s161 cascade`);
  await owner.query(`drop role if exists ${ROLE}`);
  await owner.query(`create role ${ROLE} nologin`);
  await owner.query(`grant ${ROLE} to pgkiln_runtime`);
  await owner.query(`create schema s161`);
  await owner.query(`create table s161.thing (id serial primary key, name text)`);
  await owner.query(`insert into s161.thing (name) values ('first')`);
  await owner.query(`grant usage on schema s161 to ${ROLE}; grant all on s161.thing to ${ROLE}; grant usage on sequence s161.thing_id_seq to ${ROLE}`);
  const appId = (await owner.one(`insert into meta.app (alias, name, authentication, db_role) values ($1, 'Component events', 'none', $2) returning id`, [alias, ROLE])).id;
  const p = (await owner.one(`insert into meta.page (app_id, page_no, name, requires_auth) values ($1, 1, 'Home', false) returning id`, [appId])).id;
  const box = (await owner.one(`insert into meta.region (page_id, seq, title, type, source) values ($1, 1, 'Box', 'static', '<p>box</p>') returning id`, [p])).id;
  const grid = (await owner.one(`insert into meta.region (page_id, seq, title, type, source, table_name, pk_column, static_id, config) values ($1, 2, 'Things', 'grid', 'select id, name from s161.thing order by id', 's161.thing', 'id', 'things', $2) returning id`,
    [p, JSON.stringify({ allow: { insert: true, update: true, delete: true } })])).id;
  await owner.query(`insert into meta.process (page_id, seq, name, type, region_id, point) values ($1, 1, 'Save things', 'grid_dml', $2, 'submit')`, [p, grid]);
  const cal = (await owner.one(`insert into meta.region (page_id, seq, title, type, source, config) values ($1, 3, 'Calendar', 'calendar', $2, $3) returning id`,
    [p, `select current_date as start_date, 'Today' as title, 1 as id`, JSON.stringify({ create: { page: 1, items: {} } })])).id;
  const map = (await owner.one(`insert into meta.region (page_id, seq, title, type, source) values ($1, 4, 'Map', 'map', $2) returning id`,
    [p, `select 52.09 as lat, 5.12 as lng, 'Utrecht' as title, 42 as id`])).id;
  const tree = (await owner.one(`insert into meta.region (page_id, seq, title, type, source, config) values ($1, 5, 'Tree', 'tree', $2, $3) returning id`,
    [p, `select 1 as id, null::int as parent_id, 'Root' as label union all select 2, 1, 'Child'`, JSON.stringify({ link: { page: 1, items: {} } })])).id;
  await owner.query(`insert into meta.item (page_id, region_id, seq, name, type) values ($1, $2, 1, 'P1_OUT', 'text'), ($1, $2, 2, 'P1_MAP', 'text'), ($1, $2, 3, 'P1_NODE', 'text')`, [p, box]);
  const da = (seq: number, cols: Record<string, unknown>) => {
    const keys = Object.keys(cols);
    return owner.query(`insert into meta.dynamic_action (page_id, seq, name, ${keys.join(', ')}) values ($1, $2, $3, ${keys.map((_, i) => `$${i + 4}`).join(', ')})`,
      [p, seq, `da ${seq}`, ...keys.map((k) => cols[k])]);
  };
  const out = (text: string) => ({ action: 'set_value', code: `select '${text}' as "P1_OUT"`, affected_items: 'P1_OUT' });
  await da(1, { event: 'grid_row_init', trigger_element: 'THINGS', ...out('row added') });
  await da(2, { event: 'grid_save', trigger_element: String(grid), ...out('grid saved') });
  // the date chosen is today's: set P1_OUT; any date: cancel the Create link
  await da(3, { event: 'calendar_date_select', trigger_element: String(cal), condition_type: 'equals', condition_value: today, ...out('date chosen') });
  await da(4, { event: 'calendar_date_select', trigger_element: String(cal), action: 'cancel_event' });
  await da(5, { event: 'calendar_view_change', trigger_element: String(cal), condition_type: 'equals', condition_value: 'week', ...out('week view') });
  await da(6, { event: 'map_object_click', trigger_element: String(map), condition_type: 'equals', condition_value: '42', ...out('marker 42') });
  await da(7, { event: 'map_change', trigger_element: String(map), action: 'set_value', code: `select 'moved' as "P1_MAP"`, affected_items: 'P1_MAP' });
  await da(8, { event: 'tree_selection_change', trigger_element: String(tree), condition_type: 'equals', condition_value: '2', ...out('node 2') });
  // set_value without SQL: the node's id into P1_NODE; then cancel the link (last: it stops the actions after it)
  await da(9, { event: 'tree_selection_change', trigger_element: String(tree), action: 'set_value', affected_items: 'P1_NODE' });
  await da(10, { event: 'tree_selection_change', trigger_element: String(tree), action: 'cancel_event' });
  close = async () => {
    await owner.query(`delete from meta.app where alias = $1`, [alias]);
    await owner.query(`drop schema if exists s161 cascade`);
    await owner.query(`drop role if exists ${ROLE}`);
    await browser.close();
    await app.close();
    await closePools();
  };
});
after(async () => close());

async function open(): Promise<Page> {
  const context = await browser.newContext();
  await context.route(`${tileOrigin()}/**`, (route) => route.fulfill({ contentType: 'image/png', body: TILE }));
  const page = await context.newPage();
  await page.goto(`${base}/a/${alias}/1`);
  return page;
}
const outIs = (page: Page, v: string, item = 'P1_OUT') =>
  page.waitForFunction(([id, x]) => (document.getElementById(id) as HTMLInputElement).value === x, [item, v]);

describe('component events (CD-3)', () => {
  test('grid: row initialization on Add row, Save on the page that comes back', async () => {
    const page = await open();
    try {
      await page.click('[data-grid-add]');
      await outIs(page, 'row added');
      await page.locator('[data-grid] tr[data-new-row] input:not([type=hidden])').first().fill('second');
      await Promise.all([page.waitForNavigation(), page.click('button.btn-hot[value^="GRID_SAVE_"]')]);
      await outIs(page, 'grid saved');
      assert.equal((await owner.one(`select count(*)::int as n from s161.thing`)).n, 2);
      // a reload doesn't run it again
      await page.reload();
      assert.equal(await page.evaluate(() => JSON.parse(document.getElementById('pgkiln-meta')!.textContent!).savedGrids), undefined);
    } finally {
      await page.context().close();
    }
  });

  test('calendar: date select sees the date and cancels the Create link; view change sees the view', async () => {
    const page = await open();
    try {
      const url = page.url();
      await page.click(`.calendar td[data-date="${today}"]`, { position: { x: 4, y: 4 } });
      await outIs(page, 'date chosen');
      assert.equal(page.url(), url, 'the Create link stayed closed');
      await Promise.all([page.waitForNavigation(), page.click('.cal-views a:has-text("Week"), .cal-views a[href*="_v=week"]')]);
      await outIs(page, 'week view');
      assert.ok(!page.url().includes('cal_changed'), 'the marker is taken out of the address');
    } finally {
      await page.context().close();
    }
  });

  test('map: object click sees the id column, map change after a zoom', async () => {
    const page = await open();
    try {
      await page.locator('.leaflet-marker-icon').first().click();
      await outIs(page, 'marker 42');
      await page.locator('.leaflet-control-zoom-out').click();
      await outIs(page, 'moved', 'P1_MAP');
    } finally {
      await page.context().close();
    }
  });

  test('tree: selection change sees the node id, marks it and cancels its link', async () => {
    const page = await open();
    try {
      const url = page.url();
      await page.locator('.tree-view li[data-node="2"] > a').click();
      await outIs(page, 'node 2');
      assert.equal(page.url(), url);
      assert.equal(await page.locator('.tree-view li.tree-selected').getAttribute('data-node'), '2');
      await outIs(page, '2', 'P1_NODE');
    } finally {
      await page.context().close();
    }
  });
});
