// Signing in to an application with a passkey alone in a real browser (sprint 199, NX-U6): Chromium's virtual
// authenticator stands in for a fingerprint reader. king adds a passkey on My account; signed out, HR's sign-in page
// shows "Sign in with a passkey" above the username and the password, and one press (from the keyboard) signs him in,
// without a username. Without JavaScript the button stays hidden and the password form works as before. No CSP or
// axe-core violations. WebAuthn needs a host name, so the test uses localhost (an IP address is not a relying party).
process.env.PGKILN_SECRET_KEY ??= 'test-only-secret-key-0123456789abcdef';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools, owner } from '../../src/db.ts';

const AXE = readFileSync(new URL('../../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
let base = '';
let browser: Browser;
let appId = 0;
let saved: { passkey_signin: boolean; mfa: string };
let close: () => Promise<void>;

async function cleanup() {
  await owner.query(`delete from meta.account_factor where account_id = (select id from meta.account where username = 'king')`);
  await owner.query(`delete from meta.account_recovery_code where account_id = (select id from meta.account where username = 'king')`);
}

before(async () => {
  const a = await owner.one(`select id, passkey_signin, mfa from meta.app where alias = 'hr'`);
  appId = a.id;
  saved = { passkey_signin: a.passkey_signin, mfa: a.mfa };
  await cleanup();
  await owner.query(`update meta.app set passkey_signin = true, mfa = 'off' where id = $1`, [appId]);
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://localhost:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  close = async () => {
    await browser.close();
    await app.close();
    await cleanup();
    await owner.query(`update meta.app set passkey_signin = $2, mfa = $3 where id = $1`, [appId, saved.passkey_signin, saved.mfa]);
    await closePools();
  };
});
after(() => close());

const axe = async (page: Page) => {
  await page.evaluate(AXE);
  const r = await page.evaluate(() => (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }));
  return r.violations.map((v: { id: string; nodes: { html: string }[] }) => `${v.id}: ${v.nodes[0]?.html.slice(0, 120)}`);
};
const csp = async (page: Page) => assert.deepEqual(await page.evaluate(() => (window as any).__csp), [], 'Content-Security-Policy');

async function context(options: Parameters<Browser['newContext']>[0] = {}): Promise<BrowserContext> {
  const c = await browser.newContext(options);
  await c.addInitScript(() => {
    (window as any).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as any).__csp.push(`${e.violatedDirective}: ${e.blockedURI || e.sample || 'inline'}`));
  });
  return c;
}

async function password(page: Page) {
  // no throttling from other tests (they sign in wrongly from 127.0.0.1 on purpose)
  await owner.query(`delete from meta.activity_log where event = 'login_failed' and at > now() - interval '1 day' and (ip in ('127.0.0.1', '::1', '::ffff:127.0.0.1') or lower(username) = 'king')`);
  await owner.query(`insert into meta.activity_log (username, event, detail) values ('king', 'login_unlocked', 'e2e')`);
  await page.goto(`${base}/a/hr/login`);
  await page.fill('input[name="username"]', 'king');
  await page.fill('input[name="password"]', 'king');
  await Promise.all([page.waitForNavigation(), page.click('form.login-form button.btn-hot')]);
}

describe('signing in with a passkey alone (browser)', () => {
  test('done when: king adds a passkey, then signs in with one press, without a username', async () => {
    const c = await context();
    const page = await c.newPage();
    const cdp = await c.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    });

    await password(page);
    await page.goto(`${base}/a/hr/account`);
    assert.match((await page.textContent('#two-step')) ?? '', /sign in with a passkey alone/);
    const add = page.locator('#two-step [data-passkey]');
    await add.waitFor({ state: 'visible' });
    await Promise.all([page.waitForNavigation(), add.click()]);
    await page.check('#two-step input[name="saved"]');
    await Promise.all([page.waitForNavigation(), page.click('#two-step form[action$="/codes/confirm"] button')]);
    const creds = (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials;
    assert.equal(creds.length, 1);
    assert.equal(creds[0].isResidentCredential, true, 'a discoverable passkey');

    // signed out: the sign-in page shows the button above the fields, with the app's mark
    await c.clearCookies();
    await page.goto(`${base}/a/hr/login`);
    const button = page.locator('.login-passkey-button');
    await button.waitFor({ state: 'visible' });
    assert.ok(await page.locator('.login-card .login-mark').isVisible());
    const [b, u] = [await button.boundingBox(), await page.locator('#username').boundingBox()];
    assert.ok(b && u && b.y < u.y, 'above the username');
    assert.deepEqual(await axe(page), []);
    await csp(page);
    // keyboard only: the username has the focus; one Shift+Tab reaches the passkey button, Enter signs in
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('login-passkey-button')), true);
    await page.keyboard.press('Enter');
    await page.waitForURL((url) => !/\/login/.test(url.pathname));
    await page.waitForLoadState();
    const log = await owner.one(`select username, detail from meta.activity_log where app_id = $1 and event = 'login' order by id desc limit 1`, [appId]);
    assert.deepEqual([log.username, log.detail], ['king', 'passkey (user verified)']);

    // an authenticator that can't verify the user: refused with the one message, the password form still there
    await c.clearCookies();
    await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false });
    // (HR is a PWA: its service worker may still be busy with the home page; a navigation it aborts is tried again)
    await page.goto(`${base}/a/hr/login`).catch(() => page.goto(`${base}/a/hr/login`));
    await button.waitFor({ state: 'visible' });
    await button.click();
    await page.locator('[data-passkey-status]:not(:empty), .alert-error').first().waitFor();
    assert.match(page.url(), /login/);
    await c.close();
  });

  test('without JavaScript: no button, and the password form works unchanged', async () => {
    const c = await context({ javaScriptEnabled: false });
    const page = await c.newPage();
    await page.goto(`${base}/a/hr/login`);
    assert.equal(await page.locator('.login-passkey').isVisible(), false);
    assert.equal(await page.locator('.login-passkey-button').isVisible(), false);
    await password(page);
    assert.doesNotMatch(page.url(), /login/);
    await c.close();
  });
});
