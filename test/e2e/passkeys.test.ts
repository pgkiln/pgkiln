// Passkeys in a real browser (sprint 127, SEC-2): Chromium's virtual authenticator (DevTools protocol) stands in
// for a fingerprint reader. A developer adds a passkey on the Security page, saves the recovery codes, signs out
// and signs in again with the passkey; nothing violates the Content-Security-Policy. WebAuthn needs a host name,
// so the test uses localhost (an IP address is not a valid relying party).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools, owner } from '../../src/db.ts';

const DEV = 'e2e_passkey';
const PW = 'E2e-passkey-password-1!';
let base = '';
let browser: Browser;
let close: () => Promise<void>;

before(async () => {
  await owner.query('delete from meta.developer where username = $1', [DEV]);
  await owner.query(`insert into meta.developer (username, password_hash) values ($1, meta.hash_password($2))`, [DEV, PW]);
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://localhost:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  close = async () => {
    await browser.close();
    await app.close();
    await owner.query('delete from meta.developer where username = $1', [DEV]);
    await closePools();
  };
});
after(() => close());

const csp = async (page: Page) => assert.deepEqual(await page.evaluate(() => (window as any).__csp), [], 'Content-Security-Policy');

async function signInWithPassword(page: Page) {
  await page.goto(`${base}/builder/login`);
  await page.fill('#f_username, input[name="username"]', DEV);
  await page.fill('input[name="password"]', PW);
  await Promise.all([page.waitForNavigation(), page.click('.signin-submit')]);
}

describe('passkeys in a browser', () => {
  test('add a passkey, then sign in with it', async () => {
    const c = await browser.newContext();
    await c.addInitScript(() => {
      (window as any).__csp = [];
      document.addEventListener('securitypolicyviolation', (e) => (window as any).__csp.push(`${e.violatedDirective}: ${e.blockedURI || e.sample || 'inline'}`));
    });
    const page = await c.newPage();
    const cdp = await c.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    });

    await signInWithPassword(page);
    await page.goto(`${base}/builder/security`);
    const add = page.locator('[data-passkey="/builder/security/passkey/options"]');
    await add.waitFor({ state: 'visible' });
    await page.fill('#f_pk_name', 'Virtual key');
    await Promise.all([page.waitForURL(/\/builder\/security/), add.click()]);
    await page.waitForSelector('.mfa-codes li');
    assert.equal(await page.locator('.mfa-codes li').count(), 10);
    await page.check('input[name="saved"]');
    await Promise.all([page.waitForNavigation(), page.click('form[action$="/codes/confirm"] button')]);
    assert.match(await page.locator('main').innerText(), /Virtual key/);
    await csp(page);

    await Promise.all([page.waitForNavigation(), page.locator('form[action$="/logout"] button').first().evaluate((b: HTMLButtonElement) => b.click())]);
    await signInWithPassword(page);
    assert.match(page.url(), /\/builder\/login\/2fa$/);
    const use = page.locator('[data-passkey-submit]');
    await use.waitFor({ state: 'visible' });
    await Promise.all([page.waitForURL((u) => !/\/login/.test(u.pathname)), use.click()]);
    assert.doesNotMatch(page.url(), /login/);
    await csp(page);
    const row = await owner.one<{ name: string; last_used_at: string }>(`select name, last_used_at from meta.developer_factor where username = $1 and kind = 'passkey'`, [DEV]);
    assert.equal(row?.name, 'Virtual key');
    await c.close();
  });
});
