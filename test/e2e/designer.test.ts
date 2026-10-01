// Browser tests of the builder's IDE chrome and the page designer: panes as
// tabs on phones and portrait tablets, three panes from 1024px, the tree and
// property filter, drag and drop with its keyboard and button alternatives,
// undo, and the builder's theme switch.
//   npm run test:e2e   (SCREENSHOTS=1 saves the designer to test-results/)
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools, owner } from '../../src/db.ts';

let base = '';
let browser: Browser;
let close: () => Promise<void>;
let appId: number;
const shots = process.env.SCREENSHOTS === '1';
if (shots) mkdirSync('test-results', { recursive: true });
const PAGE_NO = 9201;
// the same widths as responsive.test.ts (importing it would run its tests twice)
const VIEWPORTS = {
  phone: { width: 390, height: 844 },
  'tablet-portrait': { width: 768, height: 1024 },
  'tablet-landscape': { width: 1024, height: 768 },
  desktop: { width: 1440, height: 900 },
} as const;

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
after(async () => close());

/** A fresh page with two regions, items and a button (so tests can move them). */
async function scratchPage() {
  await owner.query('delete from meta.page where app_id = $1 and page_no = $2', [appId, PAGE_NO]);
  const p = (await owner.one(`insert into meta.page (app_id, page_no, name) values ($1, $2, 'Designer test') returning id`, [appId, PAGE_NO])).id as number;
  const region = async (seq: number, title: string, columns = 12) =>
    (await owner.one(`insert into meta.region (page_id, seq, title, type, source, columns) values ($1, $2, $3, 'static', '<p>x</p>', $4) returning id`, [p, seq, title, columns])).id as number;
  const r1 = await region(10, 'First region', 8);
  const r2 = await region(20, 'Second region', 4);
  const item = async (seq: number, name: string, regionId: number) =>
    (await owner.one(`insert into meta.item (page_id, region_id, seq, name, label) values ($1, $2, $3, $4, $5) returning id`, [p, regionId, seq, name, name.slice(6)])).id as number;
  const i1 = await item(10, `P${PAGE_NO}_ALPHA`, r1);
  const i2 = await item(20, `P${PAGE_NO}_BETA`, r1);
  await owner.query(`insert into meta.button (page_id, region_id, seq, name, label) values ($1, $2, 10, 'SAVE', 'Save')`, [p, r2]);
  return { p, r1, r2, i1, i2 };
}

async function signIn(size: { width: number; height: number }) {
  const context = await browser.newContext({ viewport: size });
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

const seqOf = async (table: string, id: number) => (await owner.one(`select * from meta.${table} where id = $1`, [id]));

for (const [vp, size] of Object.entries(VIEWPORTS)) {
  describe(`page designer at ${vp} (${size.width}px)`, () => {
    test('the panes: tabs below 1024px, side by side from there', async () => {
      const ids = await scratchPage();
      const { page, errors } = await signIn(size);
      await page.goto(`${base}/builder/pages/${ids.p}`);
      const paneTabs = page.locator('.pd > .tablist [role=tab]');
      if (size.width < 1024) {
        assert.equal(await paneTabs.count(), 3);
        assert.equal(await page.locator('#pd-p-layout').isVisible(), true, 'the layout first');
        assert.equal(await page.locator('#pd-p-tree').isVisible(), false);
        await page.click('#pd-p-tree-tab');
        assert.equal(await page.locator('#pd-p-tree').isVisible(), true);
        assert.equal(await page.locator('#pd-p-layout').isVisible(), false);
        await fits(page, 'tree tab');
        // a component opens with the Properties tab
        await page.click(`.pd-tree a[href$="c=item-${ids.i1}"]`);
        await page.waitForURL(/c=item-/);
        assert.equal(await page.locator('#pd-p-props').isVisible(), true, 'properties after choosing a component');
      } else {
        assert.equal(await paneTabs.count(), 0);
        for (const id of ['#pd-p-tree', '#pd-p-layout', '#pd-p-props']) assert.equal(await page.locator(id).isVisible(), true, id);
        const [l, c, r] = await Promise.all(['.pd-left', '.pd-center', '.pd-right'].map((s) => page.locator(s).boundingBox()));
        assert.ok(l!.x < c!.x && c!.x < r!.x, 'tree, layout, properties from left to right');
        await page.click(`.pd-canvas a[href$="c=item-${ids.i1}"]`);
        await page.waitForURL(/c=item-/);
      }
      await fits(page, 'designer');
      if (shots) {
        await page.goto(`${base}/builder/pages/${ids.p}?c=region-${ids.r1}`);
        await page.screenshot({ path: `test-results/${vp}-designer.png` });
      }
      // the rest of the builder carries the same chrome
      await page.goto(`${base}/builder/apps/${appId}`);
      assert.equal(await page.locator('.ide-rail .rail-link[aria-current]').count(), 1);
      assert.equal(await page.locator('.ide-tabs .ide-tab[aria-current]').textContent(), 'Pages');
      await fits(page, 'application home');
      assert.deepEqual(errors, []);
      await page.context().close();
    });

    test('the Arrange buttons move and resize without drag and drop', async () => {
      const ids = await scratchPage();
      const { page } = await signIn(size);
      await page.goto(`${base}/builder/pages/${ids.p}?c=item-${ids.i2}`);
      await Promise.all([page.waitForNavigation(), page.click('.pe-arrange button[title^="Move up"]')]);
      assert.ok((await seqOf('item', ids.i2)).seq < (await seqOf('item', ids.i1)).seq, 'moved up');
      // into the other region
      await page.selectOption('#pe-move-region', String(ids.r2));
      await Promise.all([page.waitForNavigation(), page.click('.pe-arrange form:has(#pe-move-region) button')]);
      assert.equal((await seqOf('item', ids.i2)).region_id, ids.r2);
      await page.goto(`${base}/builder/pages/${ids.p}?c=region-${ids.r1}`);
      await Promise.all([page.waitForNavigation(), page.click('.pe-arrange button[title^="Wider"]')]);
      assert.equal((await owner.one('select columns from meta.region where id = $1', [ids.r1])).columns, 9);
      await fits(page, 'arrange');
      await page.context().close();
    });
  });
}

describe('page designer interaction (desktop)', () => {
  const size = VIEWPORTS.desktop;

  test('drag a region, an item and a gallery entry; undo takes a step back', async () => {
    const ids = await scratchPage();
    const { page, errors } = await signIn(size);
    await page.goto(`${base}/builder/pages/${ids.p}`);
    // the second region before the first
    await Promise.all([
      page.waitForURL(/c=region-/),
      page.dragAndDrop(`.pd-region[data-id="${ids.r2}"] .pd-region-head`, `.pd-region[data-id="${ids.r1}"] .pd-region-body`, { targetPosition: { x: 10, y: 10 } }),
    ]);
    assert.ok((await seqOf('region', ids.r2)).seq < (await seqOf('region', ids.r1)).seq, 'region moved before the other');
    // an item into the other region
    await Promise.all([
      page.waitForURL(new RegExp(`c=item-${ids.i1}`)),
      page.dragAndDrop(`.pd-chip[data-id="${ids.i1}"]`, `.pd-region[data-id="${ids.r2}"] .pd-slot-item`),
    ]);
    assert.equal((await seqOf('item', ids.i1)).region_id, ids.r2);
    // undo puts it back
    await Promise.all([page.waitForNavigation(), page.click('.tb-undo button[title^="Undo"]')]);
    assert.equal((await seqOf('item', ids.i1)).region_id, ids.r1);
    // a new item from the gallery, straight into a region
    await page.click('#pd-g-items-tab');
    await Promise.all([
      page.waitForURL(/c=item-/),
      page.dragAndDrop('.pd-gal[data-new="item"][data-type="date"]', `.pd-region[data-id="${ids.r2}"] .pd-slot-item`),
    ]);
    const created = await owner.one(`select name, type, region_id from meta.item where page_id = $1 and name like $2`, [ids.p, `P${PAGE_NO}_NEW%`]);
    assert.deepEqual([created.type, created.region_id], ['date', ids.r2]);
    assert.equal(await page.locator('.pe-title').textContent().then((t) => t?.includes(created.name)), true, 'the new item is selected');
    // the gallery stays on the tab used last
    assert.equal(await page.locator('#pd-g-items').isVisible(), true);
    assert.deepEqual(errors, []);
    await page.context().close();
  });

  test('keyboard: Alt+arrows move and resize; the tree and the property filter', async () => {
    const ids = await scratchPage();
    const { page } = await signIn(size);
    await page.goto(`${base}/builder/pages/${ids.p}`);
    await page.focus(`.pd-chip[data-id="${ids.i1}"]`);
    await Promise.all([page.waitForURL(new RegExp(`c=item-${ids.i1}`)), page.keyboard.press('Alt+ArrowDown')]);
    assert.ok((await seqOf('item', ids.i1)).seq > (await seqOf('item', ids.i2)).seq, 'moved down');
    await page.focus(`.pd-region[data-id="${ids.r1}"] .pd-region-link`);
    await Promise.all([page.waitForURL(new RegExp(`c=region-${ids.r1}`)), page.keyboard.press('Alt+Shift+ArrowLeft')]);
    assert.equal((await owner.one('select columns from meta.region where id = $1', [ids.r1])).columns, 7);

    // the tree: arrow keys walk the nodes, Left closes a folder
    const tree = page.locator('#pd-l-rendering .pd-tree');
    assert.equal(await tree.getAttribute('role'), 'tree');
    await page.locator('#pd-l-rendering [role=treeitem][tabindex="0"]').focus();
    const label = () => page.evaluate(() => document.activeElement?.textContent?.trim());
    const start = await label();
    await page.keyboard.press('ArrowDown');
    assert.notEqual(await label(), start);
    const regions = page.locator('#pd-l-rendering .pd-folder', { hasText: 'Regions' });
    await regions.focus();
    await page.keyboard.press('ArrowLeft');
    assert.equal(await regions.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator(`#pd-l-rendering a[href$="c=region-${ids.r2}"]`).isVisible(), false);
    await page.keyboard.press('ArrowRight');
    assert.equal(await regions.getAttribute('aria-expanded'), 'true');

    // the property filter
    const fields = page.locator('.pe .field:visible');
    const all = await fields.count();
    await page.fill('#pe-filter', 'column span');
    assert.ok((await fields.count()) < all && (await fields.count()) >= 1, 'fewer properties');
    assert.equal(await page.locator('.pe .field.pe-hit').first().locator('.label').textContent(), 'Column span (1-12)');
    await page.fill('#pe-filter', 'no such property at all');
    assert.equal(await page.locator('.pe-empty-filter').isVisible(), true);
    await page.press('#pe-filter', 'Escape');
    assert.equal(await fields.count(), all);
    await page.context().close();
  });

  test('the builder theme: dark by default, light and system on request', async () => {
    const { page } = await signIn(size);
    await page.goto(`${base}/builder`);
    const rail = await page.evaluate(() => getComputedStyle(document.querySelector('.ide-rail')!).backgroundColor);
    await page.click('.rail-avatar');
    await Promise.all([page.waitForNavigation(), page.click('.ide-theme button[value="light"]')]);
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    assert.equal(new URL(page.url()).pathname, '/builder');
    const light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.ide-rail')!).backgroundColor), rail, 'the chrome stays dark');
    await page.click('.rail-avatar');
    await Promise.all([page.waitForNavigation(), page.click('.ide-theme button[value="dark"]')]);
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    assert.notEqual(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), light);
    await page.context().close();
  });
});
