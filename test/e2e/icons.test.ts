// Icons in a real browser (0.31): a Lucide icon with modifiers draws from its
// own file under the strict CSP, and the builder's icon picker finds Lucide
// icons as you type and saves the one chosen.
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
let entry: { id: number; icon: string | null };

before(async () => {
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  entry = (await owner.one(`select n.id, n.icon from meta.nav_entry n join meta.app a on a.id = n.app_id where a.alias = 'hr' and n.target_page = 1`))!;
  close = async () => {
    await owner.query('update meta.nav_entry set icon = $2 where id = $1', [entry.id, entry.icon]);
    await browser.close();
    await app.close();
    await closePools();
  };
});
after(() => close());

describe('icons (browser)', () => {
  test('a Lucide icon with modifiers draws under the CSP; the picker finds and saves one', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(() => {
      (window as any).__csp = [];
      document.addEventListener('securitypolicyviolation', (e) => (window as any).__csp.push(`${e.violatedDirective}: ${e.blockedURI || 'inline'}`));
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => assert.fail(`page error: ${e.message}`));
    // the builder: search "vehicle" in the navigation entry's icon picker and pick "car-front" (a Lucide icon)
    await page.goto(`${base}/builder/login`);
    await page.fill('#f_username', 'admin');
    await page.fill('#f_password', 'admin');
    await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
    const hr = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
    await page.goto(`${base}/builder/apps/${hr}/shared?c=nav_entry-${entry.id}`);
    const picker = page.locator('.icon-picker').first();
    await picker.locator('summary').click();
    await picker.locator('input[data-icon-filter]').fill('vehicle');
    const car = picker.locator('[data-icon-more] .icon-choice', { has: page.locator('input[value="car-front"]') });
    await car.waitFor();
    await car.click();
    assert.equal(await picker.locator('summary .icon-name, summary span').last().textContent(), 'car-front');
    await Promise.all([page.waitForNavigation(), page.locator('form.component-form button.btn-hot, form button.btn-hot').first().click()]);
    assert.equal((await owner.one('select icon from meta.nav_entry where id = $1', [entry.id])).icon, 'car-front');
    // the application: a Font APEX name with a modifier draws Lucide's bus from /static/icon/bus.svg
    await owner.query(`update meta.nav_entry set icon = 'fa-bus fa-2x' where id = $1`, [entry.id]);
    await page.goto(`${base}/a/hr/login`);
    await page.fill('#username', 'king');
    await page.fill('#password', 'king');
    await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
    const svg = page.locator('svg.icon-2x').first();
    await svg.waitFor({ state: 'attached' });
    await page.waitForFunction(() => {
      const use = document.querySelector('svg.icon-2x use') as SVGUseElement | null;
      return !!use && use.getBBox().width > 0;
    });
    assert.match((await svg.locator('use').getAttribute('href')) ?? '', /^\/static\/icon\/bus\.svg\?v=[\d.]+#i$/);
    assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
    await context.close();
  });
});
