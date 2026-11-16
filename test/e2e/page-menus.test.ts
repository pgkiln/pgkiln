// (sprint 206, AX-5) Browser tests of the Page Designer's menus on the open page: from HR page 3, Utilities → History
// of this page and Create → Copy this page, with the keyboard, at 360 px and on a laptop, and without JavaScript;
// View as text fits a phone.
//   npm run test:e2e
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools, owner } from '../../src/db.ts';

let base = '';
let browser: Browser;
let close: () => Promise<void>;
let appId: number;
const COPIES = [9216, 9217, 9218];

const cleanup = () => owner.query('delete from meta.page where app_id = $1 and page_no = any($2)', [appId, COPIES]);

before(async () => {
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  await cleanup();
  close = async () => {
    await cleanup();
    await browser.close();
    await app.close();
    await closePools();
  };
});
after(async () => close());

async function signIn(size: { width: number; height: number }, javaScriptEnabled = true) {
  const context = await browser.newContext({ viewport: size, javaScriptEnabled });
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

async function fits(page: Page, what: string, js = true) {
  const o = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    return document.documentElement.scrollWidth > vw + 1 ? { scrollWidth: document.documentElement.scrollWidth, vw } : null;
  });
  assert.equal(o, null, `${what} overflows: ${JSON.stringify(o)}`);
  if (js) assert.deepEqual(await page.evaluate(() => (window as any).__csp), [], `${what}: CSP violations`);
}

/** Open a toolbar menu and follow one of its links, with the keyboard only. */
async function menuWithKeyboard(page: Page, menu: string, entry: string) {
  const summary = page.locator(`details.tb-menu > summary[title="${menu}"]`);
  await summary.focus();
  await page.keyboard.press('Enter');
  const link = page.locator(`details.tb-menu[open] a:text("${entry}")`);
  assert.equal(await link.isVisible(), true, `${menu} → ${entry} is shown`);
  await link.focus();
  await Promise.all([page.waitForNavigation(), page.keyboard.press('Enter')]);
}

for (const [i, size] of [{ width: 360, height: 780 }, { width: 1366, height: 768 }].entries()) {
  describe(`the Page Designer's menus on page 3 at ${size.width}px (AX-5)`, () => {
    test('Utilities → History of this page and Create → Copy this page, with the keyboard', async () => {
      const { page, errors } = await signIn(size);
      await page.goto(`${base}/builder/apps/${appId}/pages/3`);
      await menuWithKeyboard(page, 'Utilities', 'History of this page');
      assert.match(page.url(), new RegExp(`/builder/apps/${appId}/utilities/history\\?page=3$`));
      assert.equal(await page.locator('#f_page').inputValue(), '3');
      await fits(page, 'History of this page');

      await page.goto(`${base}/builder/apps/${appId}/pages/3`);
      await menuWithKeyboard(page, 'Create', 'Copy this page');
      assert.match(page.url(), new RegExp(`/builder/apps/${appId}/copy-page\\?from=${appId}&page=3$`));
      await fits(page, 'Copy this page');
      const no = COPIES[i];
      await page.locator('#f_new_page').fill(String(no));
      await page.locator('#f_name').fill(`Employees Form copy ${size.width}`);
      await Promise.all([page.waitForNavigation(), page.locator('button:text("Copy page")').press('Enter')]);
      const copy = await owner.one('select name from meta.page where app_id = $1 and page_no = $2', [appId, no]);
      assert.equal(copy?.name, `Employees Form copy ${size.width}`);
      assert.match(page.url(), new RegExp(`/builder/apps/${appId}/pages/${no}`), 'the copy opens in the Page Designer');

      // View as text and its checksum fit the screen
      await page.goto(`${base}/builder/apps/${appId}/pages/3/text#checksum`);
      assert.equal(await page.locator('#checksum').isVisible(), true);
      assert.ok((await page.locator('.pdu-file').count()) > 5);
      await fits(page, 'View as text');
      assert.deepEqual(errors, []);
      await page.context().close();
    });
  });
}

describe('the Page Designer\'s menus without JavaScript (AX-5)', () => {
  test('Create → Copy this page works as a plain link and form', async () => {
    const { page } = await signIn({ width: 1280, height: 800 }, false);
    await page.goto(`${base}/builder/apps/${appId}/pages/3`);
    await page.click('details.tb-menu > summary[title="Create"]');
    await Promise.all([page.waitForNavigation(), page.click('a:text("Copy this page")')]);
    await page.locator('#f_new_page').fill(String(COPIES[2]));
    await Promise.all([page.waitForNavigation(), page.click('button:text("Copy page")')]);
    assert.ok(await owner.one('select 1 as ok from meta.page where app_id = $1 and page_no = $2', [appId, COPIES[2]]));
    await page.goto(`${base}/builder/apps/${appId}/pages/3`);
    await page.click('details.tb-menu > summary[title="Utilities"]');
    await Promise.all([page.waitForNavigation(), page.click('a:text("History of this page")')]);
    assert.equal(await page.locator('#f_page').inputValue(), '3');
    await page.context().close();
  });
});
