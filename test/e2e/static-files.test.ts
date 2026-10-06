// Static application files in a real browser (HR example part 46): the page
// loads hr.js and hr.css from /a/hr/static/, the "Execute JavaScript" dynamic
// actions call the function hr.js registered (on open and on change), and the
// strict Content-Security-Policy reports nothing.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright';
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

describe('static application files (browser)', () => {
  test('Execute JavaScript runs a function from a static file, on open and on change', async () => {
    const context = await browser.newContext({ locale: 'en-US' });
    await context.addInitScript(() => {
      (window as any).__csp = [];
      document.addEventListener('securitypolicyviolation', (e) => (window as any).__csp.push(`${e.violatedDirective}: ${e.blockedURI || 'inline'}`));
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/a/hr/login`);
    await page.fill('#username', 'king');
    await page.fill('#password', 'king');
    await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);

    const loaded: string[] = [];
    page.on('response', (r) => r.url().includes('/a/hr/static/') && loaded.push(`${r.status()} ${new URL(r.url()).pathname}`));
    await page.goto(`${base}/a/hr/3`);
    assert.deepEqual(loaded.sort(), ['200 /a/hr/static/hr.css', '200 /a/hr/static/hr.js']);
    const annual = page.locator('[data-item="P3_SAL"] .hr-annual');
    await annual.waitFor({ state: 'attached' });
    assert.equal(await annual.textContent(), '', 'an empty salary: nothing on open');
    await page.fill('#P3_SAL', '1000');
    await page.locator('#P3_SAL').dispatchEvent('change');
    await page.waitForFunction(() => document.querySelector('[data-item="P3_SAL"] .hr-annual')?.textContent === 'Per year: 12,000');
    assert.equal(await page.evaluate(() => typeof (window as any).pgapex.actions.register), 'function');
    assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
    assert.deepEqual(errors, []);
    await context.close();
  });
});
