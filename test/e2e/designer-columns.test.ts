// (sprint 205, AX-1) Browser tests of the Columns node in the Page Designer's tree: on HR page 2 a click on sal in the
// tree opens its properties, the toolbar's Save stores a new heading, and a reload shows it; at 360 px and on a laptop,
// with the keyboard (arrow keys in the tree), Ctrl+click for several columns, and without JavaScript.
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
let region: number;
let saved: unknown;

before(async () => {
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  const r = await owner.one(`select r.id, r.config from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 2 and r.type = 'report'`, [appId]);
  region = r.id;
  saved = r.config;
  close = async () => {
    await owner.query('update meta.region set config = $2 where id = $1', [region, JSON.stringify(saved)]);
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

async function fits(page: Page, what: string) {
  const o = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    return document.documentElement.scrollWidth > vw + 1 ? { scrollWidth: document.documentElement.scrollWidth, vw } : null;
  });
  assert.equal(o, null, `${what} overflows: ${JSON.stringify(o)}`);
  assert.deepEqual(await page.evaluate(() => (window as any).__csp), [], `${what}: CSP violations`);
}

const heading = async () => (await owner.one('select config from meta.region where id = $1', [region])).config.headings?.sal;
/** the region's first child: its Columns node */
const columnsFolder = (page: Page) => page.locator(`.pd-tree a[data-kind="region"][data-id="${region}"]`).locator('xpath=../ul/li[1]');
const column = (page: Page, name: string) => page.locator(`.pd-tree a[data-kind="column"][data-id="${region}"][data-col="${name}"]`);

for (const size of [{ width: 360, height: 780 }, { width: 1366, height: 768 }]) {
  describe(`report columns in the tree at ${size.width}px (AX-1)`, () => {
    test('click sal in the tree, change its heading, Save, reload: the new heading', async () => {
      await owner.query('update meta.region set config = $2 where id = $1', [region, JSON.stringify(saved)]);
      const { page, errors } = await signIn(size);
      await page.goto(`${base}/builder/apps/${appId}/pages/2`);
      // on a phone the panes are tabs: the tree first
      if (size.width < 1024) await page.click('[data-tabs="pd-panes"] [role=tab]:has-text("Tree")');
      const folder = columnsFolder(page);
      assert.equal(await folder.locator('> .pd-folder').innerText(), 'Columns');
      assert.equal(await folder.getAttribute('data-collapsed'), '', 'the Columns node starts closed');
      await folder.locator('> .pd-folder').click();
      await column(page, 'sal').waitFor({ state: 'visible' });
      await fits(page, 'the tree with the columns open');
      await Promise.all([page.waitForNavigation(), column(page, 'sal').click()]);
      assert.match(page.url(), new RegExp(`c=column-${region}&col=sal`));
      assert.equal(await column(page, 'sal').getAttribute('aria-selected'), 'true');
      const field = page.locator('#f_col_heading');
      await field.waitFor({ state: 'visible' });
      assert.equal(await field.inputValue(), 'Salary');
      assert.equal(await page.locator('#f_col_format').isVisible(), true, 'the format mask');
      await fits(page, 'a column\'s properties');
      await field.fill('Monthly pay');
      await Promise.all([page.waitForNavigation(), page.click('.tb-save')]);
      assert.equal(await heading(), 'Monthly pay');
      await page.reload();
      assert.equal(await page.locator('#f_col_heading').inputValue(), 'Monthly pay');
      // Ctrl+click adds a column: both are edited together
      if (size.width < 1024) await page.click('[data-tabs="pd-panes"] [role=tab]:has-text("Tree")');
      await Promise.all([page.waitForURL(/col=job&col=sal/), column(page, 'job').click({ modifiers: ['Control'] })]);
      assert.equal(await page.locator('#f_col_heading').count(), 0, 'no heading for several columns');
      assert.equal(await page.locator('#f_col_shown').isVisible(), true);
      await fits(page, 'several columns');
      assert.deepEqual(errors, []);
      await page.context().close();
    });
  });
}

describe('the Columns node with the keyboard (AX-1)', () => {
  test('arrow keys open the Columns node and reach sal; Enter opens it; Ctrl+S saves', async () => {
    await owner.query('update meta.region set config = $2 where id = $1', [region, JSON.stringify(saved)]);
    const { page, errors } = await signIn({ width: 1440, height: 900 });
    await page.goto(`${base}/builder/apps/${appId}/pages/2?c=region-${region}`);
    await page.locator(`.pd-tree a[data-kind="region"][data-id="${region}"]`).focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), 'Columns');
    await page.keyboard.press('ArrowRight');
    let guard = 0;
    while ((await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.col)) !== 'sal' && guard++ < 30) await page.keyboard.press('ArrowDown');
    await Promise.all([page.waitForNavigation(), page.keyboard.press('Enter')]);
    await page.locator('#f_col_heading').fill('Pay');
    await Promise.all([page.waitForNavigation(), page.keyboard.press('Control+s')]);
    assert.equal(await heading(), 'Pay');
    // the Attributes tab's Columns group is a shortcut to the node
    await page.goto(`${base}/builder/apps/${appId}/pages/2?c=region-${region}`);
    await page.click('[data-tabs="pd-right"] [role=tab]:has-text("Attributes")');
    await Promise.all([page.waitForNavigation(), page.click('#pd-r-attrs a[title="Open column ename in the tree"]')]);
    assert.match(page.url(), /c=column-\d+&col=ename/);
    assert.equal(await page.locator(`.pd-tree a[data-col="ename"][aria-current="true"]`).isVisible(), true, 'the node is shown, its folder open');
    assert.deepEqual(errors, []);
    await page.context().close();
  });
});

describe('the Columns node without JavaScript (AX-1)', () => {
  test('the column is a link, Save posts its properties, several columns through Select several columns', async () => {
    await owner.query('update meta.region set config = $2 where id = $1', [region, JSON.stringify(saved)]);
    const { page } = await signIn({ width: 1280, height: 800 }, false);
    await page.goto(`${base}/builder/apps/${appId}/pages/2`);
    await Promise.all([page.waitForNavigation(), column(page, 'sal').click()]);
    await page.locator('#f_col_heading').fill('Wage');
    await Promise.all([page.waitForNavigation(), page.click('.tb-save')]);
    assert.equal(await heading(), 'Wage');
    // (with the keyboard: the status bar covers the bottom of the page)
    await page.locator('.pd-colpick > summary').focus();
    await page.keyboard.press('Enter');
    await page.locator('.pd-colpick input[value="job"]').focus();
    await page.keyboard.press('Space');
    await page.locator('.pd-colpick button').focus();
    await Promise.all([page.waitForNavigation(), page.keyboard.press('Enter')]);
    assert.match(page.url(), /col=job&col=sal/);
    await page.locator('#f_col_format').fill('999G990D00');
    await Promise.all([page.waitForNavigation(), page.click('.tb-save')]);
    const c = (await owner.one('select config from meta.region where id = $1', [region])).config;
    assert.deepEqual([c.formats.sal, c.formats.job], ['999G990D00', '999G990D00']);
    await page.context().close();
  });
});
