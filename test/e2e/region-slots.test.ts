// A region's slots on the Page Designer's layout in a real browser (sprint 207, AX-4): a report dragged from the
// gallery onto a Tabs Container's Sub regions slot is nested; the Sub regions slot of any other region shows while a
// region is dragged (not in the region itself, nor for a region that holds sub regions); CREATE dragged to Next takes
// that position (a maximized layout shows every slot); the bar's ? opens the Help tab with the keyboard hint; no
// overflow at 390 and 1366 px, no CSP violations.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools, owner } from '../../src/db.ts';

const PAGE_NO = 9207;
let base = '';
let browser: Browser;
let close: () => Promise<void>;
let appId = 0;

before(async () => {
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  close = async () => {
    await owner.query('delete from meta.page where app_id = $1 and page_no = $2', [appId, PAGE_NO]);
    await browser.close();
    await app.close();
    await closePools();
  };
});
after(() => close());

/** A page with a report (and its CREATE button), a tabs container and a static region. */
async function scratch() {
  await owner.query('delete from meta.page where app_id = $1 and page_no = $2', [appId, PAGE_NO]);
  const p = (await owner.one(`insert into meta.page (app_id, page_no, name) values ($1, $2, 'Slots test') returning id`, [appId, PAGE_NO])).id as number;
  const region = async (seq: number, title: string, type: string, template: string, source: string | null) =>
    (await owner.one(`insert into meta.region (page_id, seq, title, type, template, source) values ($1, $2, $3, $4, $5, $6) returning id`, [p, seq, title, type, template, source])).id as number;
  const report = await region(10, 'Orders', 'report', 'standard', 'select 1 as id');
  const tabs = await region(20, 'Tabs', 'static', 'tabs_container', null);
  const notes = await region(30, 'Notes', 'static', 'standard', '<p>x</p>');
  const create = (await owner.one(`insert into meta.button (page_id, region_id, seq, name, label, action) values ($1, $2, 10, 'CREATE', 'Create', 'redirect') returning id`, [p, report])).id as number;
  return { p, report, tabs, notes, create };
}

async function signIn(width: number, height = 900) {
  const context = await browser.newContext({ viewport: { width, height } });
  await context.addInitScript(() => {
    (window as any).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as any).__csp.push(`${e.violatedDirective}: ${e.blockedURI || 'inline'}`));
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/builder/login`);
  await page.fill('#f_username', 'admin');
  await page.fill('#f_password', 'admin');
  await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
  return { page, errors };
}

async function fits(page: Page, what: string) {
  const o = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    return document.documentElement.scrollWidth > vw + 1 ? { scrollWidth: document.documentElement.scrollWidth, vw } : null;
  });
  assert.equal(o, null, `${what} overflows: ${JSON.stringify(o)}`);
  assert.deepEqual(await page.evaluate(() => (window as any).__csp), [], `${what}: CSP violations`);
}

/**
 * Drags with the mouse: the drag starts first (the slots it shows move the layout), then the target is looked up
 * where it is now (Playwright's dragAndDrop measures the target before the drag starts).
 */
async function drag(page: Page, src: string, to: string) {
  await page.locator(src).hover();
  await page.mouse.down();
  const box = (await page.locator(src).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2 + 8, box.y + box.height / 2 + 8, { steps: 2 });
  await page.locator(to).scrollIntoViewIfNeeded();
  const t = (await page.locator(to).boundingBox())!;
  await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 4 });
  await Promise.all([page.waitForNavigation(), page.mouse.up()]);
}

const shown = (page: Page, sel: string) => page.evaluate((s) => [...document.querySelectorAll(s)].map((el) => getComputedStyle(el).display !== 'none'), sel);

describe('a region\'s slots on the layout (sprint 207, AX-4)', () => {
  test('a report from the gallery onto a Tabs Container\'s Sub regions slot is nested; CREATE dragged to Next', async () => {
    const ids = await scratch();
    // (tall: the layout's slots are in view above the gallery)
    const { page, errors } = await signIn(1440, 1600);
    await page.goto(`${base}/builder/apps/${appId}/pages/${PAGE_NO}`);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    // the container's slot is always there
    await drag(page, '.pd-gal[data-new="region"][data-type="report"]', `.pd-subgrid[data-parent="${ids.tabs}"] > .pd-grid-end`);
    const nested = (await owner.query(`select id, type, template from meta.region where parent_id = $1`, [ids.tabs])).rows;
    assert.deepEqual(nested.map((r) => [r.type, r.template]), [['report', 'plain']]);
    assert.equal(await page.locator(`.pd-subgrid[data-parent="${ids.tabs}"] > .pd-region[data-id="${nested[0].id}"]`).count(), 1);
    // the bar: no keyboard hint cut off at the right, a ? instead
    assert.equal(await page.locator('.pd-canvas-bar .pd-canvas-hint').count(), 0);
    assert.equal(await page.locator('.pd-canvas-bar [data-show-tab="pd-c-help"]').isVisible(), true);
    // other regions' Sub regions slots and empty button positions: hidden until a drag starts
    assert.deepEqual(await shown(page, `.pd-region[data-id="${ids.notes}"] .pd-sub-spare`), [false]);
    assert.deepEqual(await shown(page, `.pd-slot[data-region="${ids.report}"][data-slot="next"]`), [false]);
    // while a region is dragged: every other region's Sub regions slot, not its own; a region holding sub regions
    // (the tabs container) is offered none
    const during = (src: string) => page.evaluate((s) => {
      const dt = new DataTransfer();
      document.querySelector(s)!.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      const out = [...document.querySelectorAll('.pd-region')].filter((r) => r.querySelector(':scope > .pd-region-body > .pd-sub-spare'))
        .map((r) => [r.getAttribute('data-id'), getComputedStyle(r.querySelector(':scope > .pd-region-body > .pd-sub-spare')!).display !== 'none']);
      document.querySelector(s)!.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
      return Object.fromEntries(out);
    }, src);
    assert.deepEqual(await during(`.pd-region[data-id="${ids.notes}"] > .pd-region-head`), { [ids.report]: true, [ids.notes]: false });
    assert.deepEqual(await during(`.pd-region[data-id="${ids.tabs}"] > .pd-region-head`), { [ids.report]: false, [ids.notes]: false });
    assert.deepEqual(await during('.pd-gal[data-new="region"][data-type="chart"]'), { [ids.report]: true, [ids.notes]: true });
    // a region dragged onto another region's Sub regions slot (sent as drag events: the slot shows once a drag starts)
    await Promise.all([page.waitForNavigation(), page.evaluate(({ src, to }) => {
      const dt = new DataTransfer();
      document.querySelector(src)!.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      const slot = document.querySelector(to) as HTMLElement;
      if (getComputedStyle(slot).display === 'none') throw new Error('the Sub regions slot does not show while dragging');
      slot.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      slot.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    }, { src: `.pd-region[data-id="${ids.notes}"] > .pd-region-head`, to: `.pd-subgrid[data-parent="${ids.report}"] > .pd-grid-end` })]);
    assert.equal((await owner.one('select parent_id from meta.region where id = $1', [ids.notes])).parent_id, ids.report);
    // a maximized layout shows every slot: CREATE dragged to Next with the mouse
    await page.click('[data-maximize]');
    assert.equal(await page.locator('body.pd-max').count(), 1);
    assert.deepEqual(await shown(page, `.pd-slot[data-region="${ids.report}"][data-slot="next"]`), [true]);
    await drag(page, `.pd-chip[data-kind="button"][data-id="${ids.create}"]`, `.pd-slot[data-region="${ids.report}"][data-slot="next"]`);
    assert.equal((await owner.one('select slot from meta.button where id = $1', [ids.create])).slot, 'next');
    // the tree shows it under Buttons → Next
    assert.equal(await page.locator(`.pd-tree li[data-slot="next"] a.pd-node[data-id="${ids.create}"]`).count(), 1);
    await page.click('[data-maximize]');
    await fits(page, 'layout');
    assert.deepEqual(errors, []);
    await page.context().close();
  });

  for (const width of [390, 1366]) {
    test(`the bar's ? opens the Help tab with the keyboard hint; nothing overflows (${width} px)`, async () => {
      await scratch();
      const { page, errors } = await signIn(width);
      await page.goto(`${base}/builder/apps/${appId}/pages/${PAGE_NO}`);
      await page.evaluate(() => localStorage.clear());
      await page.reload();
      const bar = await page.locator('.pd-canvas-bar').boundingBox();
      const help = await page.locator('.pd-canvas-bar [data-show-tab]').boundingBox();
      assert.ok(help!.x + help!.width <= bar!.x + bar!.width + 1, 'the ? is inside the bar');
      await page.click('.pd-canvas-bar [data-show-tab]');
      assert.equal(await page.locator('#pd-c-help').isVisible(), true);
      assert.equal(await page.locator('#pd-c-help-tab').getAttribute('aria-selected'), 'true');
      assert.match(await page.locator('#pd-kbd').innerText(), /Alt\+Shift/);
      await fits(page, `help at ${width}`);
      // a maximized layout with every slot fits too
      await page.click('#pd-c-layout-tab');
      await page.click('[data-maximize]');
      await fits(page, `maximized layout at ${width}`);
      await page.click('[data-maximize]');
      assert.deepEqual(errors, []);
      await page.context().close();
    });
  }

  test('without JavaScript the ? is a link to the Help section', async () => {
    await scratch();
    const context = await browser.newContext({ viewport: { width: 390, height: 900 }, javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto(`${base}/builder/login`);
    await page.fill('#f_username', 'admin');
    await page.fill('#f_password', 'admin');
    await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
    await page.goto(`${base}/builder/apps/${appId}/pages/${PAGE_NO}`);
    assert.equal(await page.locator('.pd-canvas-bar a[href="#pd-c-help"]').count(), 1);
    assert.equal(await page.locator('#pd-c-help #pd-kbd').count(), 1);
    await context.close();
  });
});
