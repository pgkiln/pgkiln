// Builder tokens on the Security page in a real browser (sprint 194, NX-F4): a developer makes a token, sees it once
// with a working Copy button, finds it in the list and revokes it; the page fits a 360-pixel phone and keeps to the
// Content-Security-Policy.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools, owner } from '../../src/db.ts';

const DEV = 'e2e_tok194';
const PW = 'E2e-tok194-password-1!';
let base = '';
let browser: Browser;
let close: () => Promise<void>;

before(async () => {
  await owner.query('delete from meta.developer where username = $1', [DEV]);
  await owner.query(`insert into meta.developer (username, password_hash, is_admin) values ($1, meta.hash_password($2), false)`, [DEV, PW]);
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://localhost:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  close = async () => {
    await browser.close();
    await app.close();
    await owner.query('delete from meta.session where app_id is null and username = $1', [DEV]);
    await owner.query('delete from meta.developer where username = $1', [DEV]);
    await closePools();
  };
});
after(() => close());

const csp = async (page: Page) => assert.deepEqual(await page.evaluate(() => (window as any).__csp), [], 'Content-Security-Policy');
const noOverflow = async (page: Page) =>
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), 'no horizontal scroll');

describe('builder tokens in a browser', () => {
  for (const [label, viewport] of [['desktop', { width: 1280, height: 900 }], ['phone-360', { width: 360, height: 780 }]] as const)
    test(`make a token, copy it once, revoke it (${label})`, async () => {
      const c = await browser.newContext({ viewport, permissions: ['clipboard-read', 'clipboard-write'] });
      await c.addInitScript(() => {
        (window as any).__csp = [];
        document.addEventListener('securitypolicyviolation', (e) => (window as any).__csp.push(`${e.violatedDirective}: ${e.blockedURI || e.sample || 'inline'}`));
      });
      const page = await c.newPage();
      await page.goto(`${base}/builder/login`);
      await page.fill('input[name="username"]', DEV);
      await page.fill('input[name="password"]', PW);
      await Promise.all([page.waitForNavigation(), page.click('.signin-submit')]);
      await page.goto(`${base}/builder/security#tokens`);
      const region = page.locator('#tokens');
      await region.waitFor();
      await noOverflow(page);
      await page.fill('#f_name', `Agent ${label}`);
      await page.fill('#f_days', '7');
      await page.check('input[name="scopes"][value="write"]');
      await Promise.all([page.waitForNavigation(), region.locator('form[action="/builder/security/tokens"] button.btn-hot').click()]);
      const field = page.locator('#f_new_token');
      const token = await field.inputValue();
      assert.match(token, /^pgkb_[A-Za-z0-9_-]{43}$/);
      await noOverflow(page);
      const copy = page.locator('[data-copy-from="f_new_token"]');
      await copy.waitFor({ state: 'visible' });
      await copy.click();
      await page.waitForFunction(() => /Copied/.test(document.querySelector('[data-copy-from]')?.textContent ?? ''));
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), token);
      await csp(page);
      // once: the page again has the token in its list, not the token itself
      await page.goto(`${base}/builder/security#tokens`);
      assert.equal(await page.locator('#f_new_token').count(), 0);
      assert.doesNotMatch(await page.content(), new RegExp(token));
      const row = page.locator('#tokens tr', { hasText: `Agent ${label}` });
      assert.match(await row.innerText(), /read, write/);
      await noOverflow(page);
      page.once('dialog', (d) => d.accept());
      await Promise.all([page.waitForNavigation(), row.locator('button.btn-danger').click()]);
      assert.match(await page.locator('#tokens tr', { hasText: `Agent ${label}` }).innerText(), /Revoked/);
      const r = await fetch(`${base}/builder/api/v1/me`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(r.status, 401);
      await csp(page);
      await c.close();
    });
});
