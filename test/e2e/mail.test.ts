// Mail services in a real browser: Test connection answers in place, the form keeps what was typed.
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
after(async () => close());

describe('mail services', () => {
  test('Test connection answers on the page; what was typed stays', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${base}/builder/login`);
      await page.fill('#f_username', 'admin');
      await page.fill('#f_password', 'admin');
      await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
      await page.goto(`${base}/builder/mail/new?provider=smtp`);
      await page.fill('#f_name', 'E2E_TYPED');
      await page.fill('#f_secret', 'typed-secret');
      await page.evaluate(() => ((window as any).__marker = 'same page'));
      await page.click('button[name="check"][value="connection"]');
      // no host yet: the check names it, on the page
      await page.locator('.mail-check-result .alert-error', { hasText: 'The SMTP host is required' }).waitFor();
      assert.equal(await page.evaluate(() => (window as any).__marker), 'same page', 'no reload');
      assert.equal(await page.inputValue('#f_secret'), 'typed-secret');
      assert.equal(await page.inputValue('#f_name'), 'E2E_TYPED');
    } finally {
      await page.close();
    }
  });
});
