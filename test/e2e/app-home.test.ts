// Sprint 197 (NX-U4, NX-U5): an application's home is the Pages report and the side column (Tasks, then the
// application lock and comments), nothing below the report; Create pages from a table and Create blank page are on
// Create page's Component tab; the Page Designer has one Save, in the toolbar, that saves at 360 px and without JavaScript.
//   npm run test:e2e   (SCREENSHOTS=1 saves the pages to test-results/)
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
const PAGE_NO = 9197;
const WIDTHS = [360, 1366] as const;

before(async () => {
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  close = async () => {
    await owner.query('delete from meta.page where app_id = $1 and page_no = any($2)', [appId, [PAGE_NO, PAGE_NO + 1]]);
    await browser.close();
    await app.close();
    await closePools();
  };
});
after(async () => close());

async function signIn(width: number, js = true) {
  const context = await browser.newContext({ viewport: { width, height: 800 }, javaScriptEnabled: js });
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

/** The property editor form's own submit buttons (the toolbar's Save is outside it). */
const submits = (page: Page) => page.evaluate(() => [...document.querySelectorAll('#pd-form button')].filter((b) => (b as HTMLButtonElement).type === 'submit').length);

async function fits(page: Page, what: string) {
  const o = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    return document.documentElement.scrollWidth > vw + 1 ? { scrollWidth: document.documentElement.scrollWidth, vw } : null;
  });
  assert.equal(o, null, `${what} overflows: ${JSON.stringify(o)}`);
  if (await page.evaluate(() => 'innerWidth' in window && (window as any).__csp !== undefined))
    assert.deepEqual(await page.evaluate(() => (window as any).__csp), [], `${what}: CSP violations`);
}

for (const width of WIDTHS) {
  describe(`the application home and Create page at ${width}px (NX-U4)`, () => {
    test('the Pages report and the side column, nothing below the report', async () => {
      const { page, errors } = await signIn(width);
      await page.goto(`${base}/builder/apps/${appId}`);
      // the main column holds the report only
      const main = page.locator('.app-home-main');
      assert.equal(await main.locator('form[action$="/wizard"], form[action$="/pages"], #app-lock').count(), 0);
      assert.equal(await page.getByText('Create pages from a table').count(), 0);
      assert.equal(await page.getByText('Create blank page').count(), 0);
      // Tasks, then the lock and comments, in the side column
      const tasks = await page.locator('.app-side .app-tasks').boundingBox();
      const lock = await page.locator('.app-side #app-lock').boundingBox();
      const report = await main.boundingBox();
      assert.ok(tasks && lock && report);
      assert.ok(lock.y >= tasks.y + tasks.height - 1, 'the lock under Tasks');
      if (width >= 1100) {
        assert.ok(tasks.x >= report.x + report.width - 1, 'the side column right of the report');
        assert.ok(tasks.y < report.y + 100, 'beside the report, not under it');
      } else assert.ok(tasks.y >= report.y + report.height - 1, 'on a phone under the report');
      assert.equal(await page.locator('#app-lock input[name="note"]').isVisible(), true);
      await fits(page, 'app home');
      if (shots) await page.screenshot({ path: `test-results/app-home-${width}.png`, fullPage: true });
      // the header's Create page opens both forms, above the grid
      await Promise.all([page.waitForNavigation(), page.click('.ide-head a.btn-hot, a.btn-hot[href$="/create-page"]')]);
      assert.match(page.url(), /\/create-page$/);
      const fromTable = page.locator('form[action$="/wizard"]').first();
      const blank = page.locator(`form[action="/builder/apps/${appId}/pages"]`);
      assert.equal(await fromTable.isVisible(), true);
      assert.equal(await blank.isVisible(), true);
      const grid = await page.locator('.cp-grid').boundingBox();
      assert.ok(grid && (await blank.boundingBox())!.y < grid.y, 'the quick forms come first');
      if (width >= 1100) {
        const [t, b] = [await fromTable.boundingBox(), await blank.boundingBox()];
        assert.ok(t && b && Math.abs(t.y - b.y) < 80 && b.x > t.x, 'side by side');
      }
      await fits(page, 'create page');
      if (shots) await page.screenshot({ path: `test-results/create-page-quick-${width}.png`, fullPage: true });
      // Create pages from a table goes on to the options step
      await fromTable.locator('select[name="kind"]').selectOption('report_form');
      await fromTable.locator('select[name="table"]').selectOption('hr.dept');
      await Promise.all([page.waitForNavigation(), fromTable.locator('button').click()]);
      assert.match(page.url(), /\/wizard\?kind=report_form&table=hr\.dept/);
      assert.deepEqual(errors, []);
      await page.context().close();
    });
  });
}

describe('Create blank page without JavaScript (NX-U4)', () => {
  test('the form on Create page makes the page and opens it in the Page Designer', async () => {
    await owner.query('delete from meta.page where app_id = $1 and page_no = $2', [appId, PAGE_NO + 1]);
    const { page } = await signIn(360, false);
    await page.goto(`${base}/builder/apps/${appId}/create-page`);
    const blank = page.locator(`form[action="/builder/apps/${appId}/pages"]`);
    await blank.locator('input[name="page_no"]').fill(String(PAGE_NO + 1));
    await blank.locator('input[name="name"]').fill('Blank from Create page');
    await Promise.all([page.waitForNavigation(), blank.locator('button').click()]);
    assert.match(page.url(), /\/builder\/apps\/\d+\/pages\/9198|\/builder\/pages\/\d+/);
    assert.ok(await owner.one('select 1 as ok from meta.page where app_id = $1 and page_no = $2 and name = $3', [appId, PAGE_NO + 1, 'Blank from Create page']));
    await fits(page, 'designer after create');
    await page.context().close();
  });
});

describe('the Page Designer has one Save (NX-U5)', () => {
  for (const [width, js] of [[360, true], [360, false], [1366, true], [1366, false]] as const) {
    test(`${width}px, ${js ? 'with' : 'without'} JavaScript: the toolbar Save is the only one, in view, and saves`, async () => {
      await owner.query('delete from meta.page where app_id = $1 and page_no = $2', [appId, PAGE_NO]);
      const p = (await owner.one(`insert into meta.page (app_id, page_no, name, title) values ($1, $2, 'One save', 'Before') returning id`, [appId, PAGE_NO])).id;
      const r = (await owner.one(`insert into meta.region (page_id, seq, title, type, source) values ($1, 10, 'Region A', 'static', '<p>x</p>') returning id`, [p])).id;
      const { page, errors } = await signIn(width, js);
      // the page's properties
      await page.goto(`${base}/builder/apps/${appId}/pages/${PAGE_NO}?c=page`);
      if (js && width < 1024) await page.click('#pd-p-props-tab').catch(() => {});
      const saves = page.locator('button:has-text("Save"), button[title^="Save"]');
      assert.equal(await saves.count(), 1, 'one Save control');
      assert.equal(await submits(page), 0, 'nothing to save at the foot of the form');
      const save = page.locator('.tb-save');
      const box = await save.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= 800, `Save in view: ${JSON.stringify(box)}`);
      assert.match((await save.getAttribute('title'))!, /Ctrl\+S/);
      await page.locator('#pd-form input[name="title"]').fill('After');
      await Promise.all([page.waitForNavigation(), save.click()]);
      assert.equal((await owner.one('select title from meta.page where id = $1', [p])).title, 'After');
      await fits(page, 'designer');
      // a region's properties: one Save too
      await page.goto(`${base}/builder/apps/${appId}/pages/${PAGE_NO}?c=region-${r}`);
      assert.equal(await page.locator('button:has-text("Save"), button[title^="Save"]').count(), 1);
      assert.equal(await submits(page), 0);
      await page.locator('#pd-form input[name="title"]').fill('Region B');
      // Enter in a field submits with the toolbar's Save (the form's default button)
      await Promise.all([page.waitForNavigation(), page.locator('#pd-form input[name="title"]').press('Enter')]);
      assert.equal((await owner.one('select title from meta.region where id = $1', [r])).title, 'Region B');
      if (shots) await page.screenshot({ path: `test-results/designer-one-save-${width}-${js ? 'js' : 'nojs'}.png` });
      assert.deepEqual(errors, []);
      await page.context().close();
    });
  }
});
