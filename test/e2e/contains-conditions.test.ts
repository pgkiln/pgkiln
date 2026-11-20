// Sprint 235 (MG-9) in a real browser, on HR page 50 (HR part 98): client-side contains / not_contains /
// contains_any conditions on multi-value items. Ticking "Other" in a checkbox group shows the description
// field and unticking hides it; a select many's values show and hide notes.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools } from '../../src/db.ts';

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

async function open(): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    (window as any).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as any).__csp.push(`${e.violatedDirective}: ${e.blockedURI || e.sample || 'inline'}`));
  });
  const page = await context.newPage();
  await page.goto(`${base}/a/hr/login`);
  await page.fill('#username', 'king');
  await page.fill('#password', 'king');
  await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
  await page.goto(`${base}/a/hr/50`);
  return page;
}
const shown = (page: Page, item: string) => page.locator(`[data-item="${item}"]`).isVisible();

describe('sprint 235: contains conditions on multi-value items', () => {
  test('a checkbox group: ticking "Other" shows the description, unticking hides it; one value at a time', async () => {
    const page = await open();
    assert.equal(await shown(page, 'P50_NEEDS_OTHER'), false);
    const box = (label: string) => page.locator('[data-item="P50_NEEDS"] label', { hasText: label }).locator('input');
    await box('Desks').check();
    assert.equal(await shown(page, 'P50_NEEDS_OTHER'), false, 'DESK does not contain OTHER');
    await box('Other').check();
    await page.locator('[data-item="P50_NEEDS_OTHER"]').waitFor({ state: 'visible' });
    await box('Laptops').check();
    assert.equal(await shown(page, 'P50_NEEDS_OTHER'), true, 'DESK:LAPTOP:OTHER still contains OTHER');
    await box('Other').uncheck();
    await page.locator('[data-item="P50_NEEDS_OTHER"]').waitFor({ state: 'hidden' });
    assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
  });

  test('a select many: not_contains SQL shows the tip, contains_any TEST, A11Y the test lab note', async () => {
    const page = await open();
    const choose = (values: string[]) => page.evaluate((v) => {
      const sel = document.getElementById('P50_SKILLS') as HTMLSelectElement;
      for (const o of sel.options) o.selected = v.includes(o.value);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }, values);
    await choose(['TS', 'A11Y']);
    assert.equal(await shown(page, 'P50_SQL_TIP'), true);
    assert.equal(await shown(page, 'P50_LAB_NOTE'), true);
    await choose(['SQL', 'DESIGN']);
    assert.equal(await shown(page, 'P50_SQL_TIP'), false);
    assert.equal(await shown(page, 'P50_LAB_NOTE'), false);
  });
});
