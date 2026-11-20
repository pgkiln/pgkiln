// Sprint 241 (MG-10, MG-11, MG-13) in a real browser, on HR page 68 (HR part 104): the visitor sign-in kiosk.
// Page template No navigation (no header, menu or title bar; the service worker still registers), placeholders in
// empty fields and as the select list's empty choice, labels from &ITEM. substitutions. At 390 px and 1280 px, under
// the strict CSP.
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

before(async () => {
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  close = async () => {
    await browser.close();
    await app.close();
    await closePools();
  };
});
after(() => close());

async function open(width: number): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height: 860 } });
  await context.addInitScript(() => {
    (window as any).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as any).__csp.push(`${e.violatedDirective}: ${e.blockedURI || e.sample || 'inline'}`));
  });
  const page = await context.newPage();
  await page.goto(`${base}/a/hr/login`);
  await page.fill('#username', 'king');
  await page.fill('#password', 'king');
  await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
  await page.goto(`${base}/a/hr/68`);
  return page;
}

describe('sprint 241: HR page 68, the visitor sign-in kiosk', () => {
  for (const width of [390, 1280]) {
    test(`${width} px: no header, menu or title bar; placeholders and substituted labels; nothing wider than the screen`, async () => {
      const page = await open(width);
      assert.equal(await page.locator('header.t-header, nav.t-nav, .t-titlebar').count(), 0);
      assert.equal(await page.locator('h1').innerText(), 'Welcome');
      assert.ok(((await page.locator('h1').boundingBox())?.width ?? 0) <= 1, 'the heading is for screen readers');
      assert.equal(await page.getAttribute('#P68_EMAIL', 'placeholder'), 'name@example.com');
      assert.equal(await page.getAttribute('#P68_NOTE', 'placeholder'), 'Accessibility needs, a parking space, …');
      assert.equal(await page.locator('#P68_HOST option').first().innerText(), '- Choose your host -');
      assert.match(await page.locator('label[for="P68_NAME"]').innerText(), /^Your name/);
      // the date picker still works with a placeholder of its own
      assert.equal(await page.getAttribute('#P68_VISIT_DATE', 'placeholder'), 'Today, or the day you come');
      await page.click('[data-date-pick="P68_VISIT_DATE"]');
      await page.locator('.date-picker, [role="dialog"]').first().waitFor({ state: 'visible' });
      await page.keyboard.press('Escape');
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(over <= 1, `the page is ${over}px wider than the screen`);
      // the application's service worker still registers on a No navigation page
      assert.equal(await page.evaluate(() => document.body.dataset.sw), '/a/hr/sw.js');
      assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
      await page.context().close();
    });
  }

  test('signing in a visitor: the required name is asked for by its label, then the visit is stored', async () => {
    const page = await open(390);
    await page.click('button:has-text("Sign in")');
    await page.locator('#P68_NAME_error').waitFor({ state: 'visible' });
    assert.match(await page.locator('#P68_NAME_error').innerText(), /Your name/);
    await page.fill('#P68_NAME', 'Grace Visitor 241');
    await page.selectOption('#P68_HOST', { index: 1 });
    await Promise.all([page.waitForNavigation(), page.click('button:has-text("Sign in")')]);
    assert.match(await page.locator('.alert-success').innerText(), /Thank you, Grace Visitor 241/);
    try {
      assert.equal((await owner.one(`select count(*)::int as n from hr.visitor where name = 'Grace Visitor 241'`)).n, 1);
    } finally {
      await owner.query(`delete from hr.visitor where name = 'Grace Visitor 241'`);
    }
    assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
    await page.context().close();
  });
});
