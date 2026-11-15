// (sprint 202) Browser tests of the Page Designer's one Save for a region (AX-2) and of type names (AX-3):
// a setting changed on the Attributes tab is saved by the toolbar's Save and by Ctrl+S, at 360 px and on a laptop,
// with and without JavaScript; Utilities → Show as JSON is reached with the keyboard and saved by the same Save;
// the tree and the Type list show names, not codes.
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
const PAGE_NO = 9212;

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

/** A fresh page with one report region. */
async function scratch() {
  await owner.query('delete from meta.page where app_id = $1 and page_no = $2', [appId, PAGE_NO]);
  const p = (await owner.one(`insert into meta.page (app_id, page_no, name) values ($1, $2, 'One Save') returning id`, [appId, PAGE_NO])).id as number;
  const r = (await owner.one(`insert into meta.region (page_id, seq, title, type, source, config) values ($1, 10, 'Staff', 'report', 'select empno, ename from hr.emp', '{"keep_me": 1}') returning id`, [p])).id as number;
  return { p, r };
}

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

const config = async (r: number) => (await owner.one('select config from meta.region where id = $1', [r])).config;

for (const size of [{ width: 360, height: 780 }, { width: 1366, height: 768 }]) {
  describe(`one Save for a region at ${size.width}px (AX-2)`, () => {
    test('the Attributes tab is saved by the toolbar Save and Ctrl+S; Show as JSON from Utilities with the keyboard', async () => {
      const { p, r } = await scratch();
      const { page, errors } = await signIn(size);
      await page.goto(`${base}/builder/pages/${p}?c=region-${r}`);
      assert.equal(await page.locator('#pd-p-props').isVisible(), true);
      // no Save of its own on the Attributes tab, no settings as JSON on the Region tab
      await page.click('[data-tabs="pd-right"] [role=tab]:has-text("Attributes")');
      assert.equal(await page.locator('#pd-r-attrs button:not([type=button])').count(), 0);
      assert.equal(await page.locator('#pd-r-props textarea[name="config"]').count(), 0);
      assert.equal(await page.getByText('These fields write').count(), 0);
      const rows = page.locator(`#rs_${r}_page_size`);
      await rows.focus();
      await rows.selectOption('25');
      assert.match((await page.locator('.tb-save').getAttribute('class'))!, /is-dirty/, 'a change of the Attributes tab marks Save');
      await fits(page, 'Attributes tab');
      await Promise.all([page.waitForNavigation(), page.keyboard.press('Control+s')]);
      assert.equal((await config(r)).page_size, 25);
      assert.equal((await config(r)).keep_me, 1);
      // the toolbar's Save (a click, as on a phone) saves the Region tab and the Attributes tab together
      await page.click('[data-tabs="pd-right"] [role=tab]:has-text("Region")');
      await page.locator('#pd-r-props input[name="title"]').fill('Staff list');
      await page.click('[data-tabs="pd-right"] [role=tab]:has-text("Attributes")');
      await page.locator(`#rs_${r}_page_size`).selectOption('50');
      await Promise.all([page.waitForNavigation(), page.click('.tb-save')]);
      const row = await owner.one('select title, config from meta.region where id = $1', [r]);
      assert.equal(row.title, 'Staff list');
      assert.equal(row.config.page_size, 50);
      assert.match(await page.locator('.alert-success').first().innerText(), /Region saved/);

      // Utilities → Show as JSON, with the keyboard
      const util = page.locator('details.tb-menu:has(a:text("Show as JSON")) > summary');
      await util.focus();
      await page.keyboard.press('Enter');
      const link = page.locator('a:text("Show as JSON")');
      await link.focus();
      await Promise.all([page.waitForURL(/json=1/), page.keyboard.press('Enter')]);
      assert.equal(await page.locator('#pd-r-json').isVisible(), true, 'the JSON view is open');
      assert.equal(await page.locator('#pd-r-attrs').count(), 0);
      assert.match(await page.locator('#f_region_config').inputValue(), /"keep_me": 1/);
      await page.locator('#f_region_config').fill('{"page_size": 10, "keep_me": 2}');
      await fits(page, 'Show as JSON');
      await Promise.all([page.waitForNavigation(), page.keyboard.press('Control+s')]);
      assert.deepEqual(await config(r), { page_size: 10, keep_me: 2 });
      assert.match(page.url(), /json=1/, 'the JSON view stays open');
      await Promise.all([page.waitForNavigation(), page.click('a:text("Show as fields")')]);
      await page.click('[data-tabs="pd-right"] [role=tab]:has-text("Attributes")');
      assert.equal(await page.locator(`#rs_${r}_page_size`).inputValue(), '10');
      assert.deepEqual(errors, []);
      await page.context().close();
    });
  });
}

describe('one Save without JavaScript (AX-2)', () => {
  test('the toolbar Save posts the Attributes tab with the region', async () => {
    const { p, r } = await scratch();
    const { page } = await signIn({ width: 1280, height: 800 }, false);
    await page.goto(`${base}/builder/pages/${p}?c=region-${r}`);
    await page.locator(`#rs_${r}_page_size`).selectOption('100');
    await Promise.all([page.waitForNavigation(), page.click('.tb-save')]);
    assert.equal((await config(r)).page_size, 100);
    await page.context().close();
  });
});

describe('type names in the Page Designer (AX-3)', () => {
  test('HR pages 2 and 3: the tree and the region\'s Type list say Interactive Report, Select List, Popup LOV …', async () => {
    const { page, errors } = await signIn({ width: 1440, height: 900 });
    for (const no of [2, 3]) {
      await page.goto(`${base}/builder/apps/${appId}/pages/${no}`);
      const notes = await page.locator('#pd-p-tree .pd-note').allInnerTexts();
      assert.ok(notes.length > 2);
      assert.deepEqual(notes.filter((t) => /\b[a-z]+_[a-z_]+\b/.test(t) || /^(report|form|select|popup_lov|hidden|text|redirect|submit|document|number|date|switch|file|location)$/.test(t.trim())), [], `page ${no}`);
    }
    assert.ok((await page.locator('#pd-p-tree .pd-note').allInnerTexts()).includes('Popup LOV'));
    await page.locator('#pd-p-tree a.pd-node[data-kind="region"]').first().click();
    await page.waitForURL(/c=region-/);
    const options = await page.locator('#f_region_type option').allInnerTexts();
    assert.ok(options.includes('Interactive Report') && options.includes('Classic Report'), options.join(', '));
    assert.deepEqual(options.filter((t) => /^[a-z_]+$/.test(t)), []);
    assert.deepEqual(errors, []);
    await page.context().close();
  });
});
