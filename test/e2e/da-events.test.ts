// Sprint 156 (CD-3, part 1): dynamic action events, client-side conditions and actions in a real browser:
// double click, mouse enter / leave, key down with Cancel Event, greater / not in list conditions, Set Style,
// Collapse / Expand tree, Open report dialog, before_refresh and the server-side condition (sprint 154).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools, owner } from '../../src/db.ts';

let base = '';
let browser: Browser;
let close: () => Promise<void>;
const alias = 'da-s156';
const ROLE = 'pgkiln_s156_da';

before(async () => {
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  await owner.query(`delete from meta.app where alias = $1`, [alias]);
  await owner.query(`drop role if exists ${ROLE}`);
  await owner.query(`create role ${ROLE} nologin`);
  await owner.query(`grant ${ROLE} to pgkiln_runtime`);
  const appId = (await owner.one(`insert into meta.app (alias, name, authentication, db_role) values ($1, 'DA events', 'none', $2) returning id`, [alias, ROLE])).id;
  const p = (await owner.one(`insert into meta.page (app_id, page_no, name, requires_auth) values ($1, 1, 'Home', false) returning id`, [appId])).id;
  const box = (await owner.one(`insert into meta.region (page_id, seq, title, type, source, static_id) values ($1, 1, 'Box', 'static', '<p>box</p>', 'box') returning id`, [p])).id;
  const tree = (await owner.one(`insert into meta.region (page_id, seq, title, type, source) values ($1, 2, 'Tree', 'tree', $2) returning id`,
    [p, `select 1 as id, null::int as parent_id, 'Root' as label union all select 2, 1, 'Child' union all select 3, 2, 'Grandchild'`])).id;
  const report = (await owner.one(`insert into meta.region (page_id, seq, title, type, source) values ($1, 3, 'Numbers', 'report', 'select g as n from generate_series(1, 3) g') returning id`, [p])).id;
  await owner.query(`insert into meta.item (page_id, region_id, seq, name, type) values ($1, $2, 1, 'P1_N', 'text'), ($1, $2, 2, 'P1_K', 'text'), ($1, $2, 3, 'P1_OUT', 'text')`, [p, box]);
  await owner.query(`insert into meta.button (page_id, region_id, seq, name, label, action) values ($1, $2, 1, 'GO', 'Go', 'submit'), ($1, $2, 2, 'TREE', 'Tree', 'da'), ($1, $2, 3, 'FILTER', 'Filter', 'da'), ($1, $2, 4, 'REFRESH', 'Refresh', 'da')`, [p, box]);
  const da = (seq: number, cols: Record<string, unknown>) => {
    const keys = Object.keys(cols);
    return owner.query(`insert into meta.dynamic_action (page_id, seq, name, ${keys.join(', ')}) values ($1, $2, $3, ${keys.map((_, i) => `$${i + 4}`).join(', ')})`,
      [p, seq, `da ${seq}`, ...keys.map((k) => cols[k])]);
  };
  await da(1, { event: 'double_click', trigger_element: 'P1_N', action: 'set_value', code: `select 'double' as "P1_OUT"`, affected_items: 'P1_OUT' });
  await da(2, { event: 'mouse_enter', trigger_element: 'BOX', action: 'add_class', affected_region_id: box, css_classes: 'is-hovered' });
  await da(3, { event: 'mouse_leave', trigger_element: 'box', action: 'remove_class', affected_region_id: box, css_classes: 'is-hovered' });
  // a typed character in P1_K is cancelled (key_press: printable keys only)
  await da(4, { event: 'key_press', trigger_element: 'P1_K', action: 'cancel_event' });
  await da(5, { event: 'change', trigger_element: 'P1_N', action: 'set_style', affected_items: 'P1_N', condition_type: 'greater', condition_value: '100', config: JSON.stringify({ styles: { color: 'rgb(180, 35, 24)', 'font-weight': 'bold' } }) });
  await da(6, { event: 'click', trigger_element: 'GO', action: 'cancel_event', condition_type: 'less', condition_value: '10' });
  await da(7, { event: 'click', trigger_element: 'TREE', action: 'expand_tree', affected_region_id: tree });
  await da(8, { event: 'click', trigger_element: 'FILTER', action: 'open_report_dialog', affected_region_id: report, code: 'filter' });
  await da(9, { event: 'before_refresh', trigger_element: String(report), action: 'set_value', code: `select 'before' as "P1_OUT"`, affected_items: 'P1_OUT' });
  await da(10, { event: 'click', trigger_element: 'REFRESH', action: 'refresh_region', affected_region_id: report });
  await da(11, { event: 'load', action: 'add_class', affected_region_id: box, css_classes: 'never-on', server_condition_type: 'never' });
  close = async () => {
    await owner.query(`delete from meta.app where alias = $1`, [alias]);
    await owner.query(`drop role if exists ${ROLE}`);
    await browser.close();
    await app.close();
    await closePools();
  };
});
after(async () => close());

describe('dynamic action events and actions (CD-3)', () => {
  test('double click, mouse enter / leave, key press cancelled, greater condition with Set Style', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${base}/a/${alias}/1`);
      await page.dblclick('#P1_N');
      await page.waitForFunction(() => (document.getElementById('P1_OUT') as HTMLInputElement).value === 'double');
      await page.hover('[data-static-id="box"] p');
      await page.locator('[data-static-id="box"].is-hovered').waitFor();
      await page.mouse.move(0, 0);
      await page.locator('[data-static-id="box"]:not(.is-hovered)').waitFor();
      // key_press with Cancel Event: typed characters don't reach P1_K
      await page.click('#P1_K');
      await page.keyboard.type('ab');
      assert.equal(await page.inputValue('#P1_K'), '');
      await page.fill('#P1_N', '150');
      await page.dispatchEvent('#P1_N', 'change');
      assert.equal(await page.$eval('#P1_N', (el) => getComputedStyle(el).fontWeight), '700');
      // (166) on the field itself, so a colour shows (it was set on the wrapper, which the field's own colour hides)
      assert.equal(await page.$eval('#P1_N', (el) => getComputedStyle(el).color), 'rgb(180, 35, 24)');
      await page.fill('#P1_N', '50');
      await page.dispatchEvent('#P1_N', 'change');
      assert.equal(await page.locator('.never-on').count(), 0, 'a dynamic action whose server-side condition fails is not on the page');
    } finally {
      await page.close();
    }
  });

  test('Cancel Event on a submit button (less than 10), expand tree, open report dialog, before_refresh', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${base}/a/${alias}/1`);
      // the condition is on the first trigger item… the button has none: an empty value fails "less", so GO submits
      await page.click('button[data-button="TREE"]');
      assert.equal(await page.locator('.tree-view details:not([open])').count(), 0, 'every node open');
      await page.click('button[data-button="FILTER"]');
      await page.locator('dialog.ir-dialog[open]').waitFor();
      await page.keyboard.press('Escape');
      await page.click('button[data-button="REFRESH"]');
      await page.waitForFunction(() => (document.getElementById('P1_OUT') as HTMLInputElement).value === 'before');
      await Promise.all([page.waitForNavigation(), page.click('button[data-button="GO"]')]);
    } finally {
      await page.close();
    }
  });
});
