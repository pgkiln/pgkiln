// (sprint 218) Shared Components' tree (a .designer side list with its own scrollbar): clicking an entry loads a new
// page, and the list stays where it was instead of jumping back to the top; opened fresh, the selected entry is in view.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools, owner } from '../../src/db.ts';

let base = '';
let browser: Browser;
let close: () => Promise<void>;
let appId: number;

before(async () => {
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  close = async () => {
    await browser.close();
    await app.close();
    await closePools();
  };
});
after(async () => close());

test('the Shared Components tree keeps its scroll position from one entry to the next', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/builder/login`);
  await page.fill('#f_username', 'admin');
  await page.fill('#f_password', 'admin');
  await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
  await page.goto(`${base}/builder/apps/${appId}/shared?view=tree`);
  const aside = page.locator('.designer > aside');
  assert.ok(await aside.evaluate((a) => a.scrollHeight > a.clientHeight + 200), 'the tree is longer than its box');
  // an entry far down the list (automation actions are near the end)
  const link = aside.locator('a[href^="?c=automation_action-"]').first();
  await link.scrollIntoViewIfNeeded();
  const before = await aside.evaluate((a) => a.scrollTop);
  assert.ok(before > 200, `scrolled down (${before})`);
  await Promise.all([page.waitForNavigation(), link.click()]);
  const after = await aside.evaluate((a) => a.scrollTop);
  assert.ok(Math.abs(after - before) <= 2, `kept: ${before} → ${after}`);
  assert.equal(await aside.locator('[aria-current="page"]').getAttribute('href'), await link.getAttribute('href'));
  // a fresh tab on that entry: no saved position, the selected entry is scrolled into view
  const fresh = await context.newPage();
  await fresh.goto(page.url());
  const inView = await fresh.locator('.designer > aside').evaluate((a) => {
    const c = a.querySelector('[aria-current="page"]')!.getBoundingClientRect();
    const r = a.getBoundingClientRect();
    return a.scrollTop > 0 && c.top >= r.top && c.bottom <= r.bottom;
  });
  assert.ok(inView, 'the selected entry is visible in a new tab');
  assert.deepEqual(errors, []);
  await context.close();
});
