// Passkeys for application users in a real browser (sprint 131, SEC-3 part 2): Chromium's virtual authenticator
// stands in for a fingerprint reader. king adds a passkey on My account, saves the recovery codes, and at the next
// sign-in uses the passkey for the second step; no CSP or axe-core violations. WebAuthn needs a host name, so the
// test uses localhost (an IP address is not a valid relying party).
process.env.PGKILN_SECRET_KEY ??= 'test-only-secret-key-0123456789abcdef';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools, owner } from '../../src/db.ts';

const AXE = readFileSync(new URL('../../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
let base = '';
let browser: Browser;
let appId = 0;
let close: () => Promise<void>;

async function cleanup() {
  await owner.query(`delete from meta.account_factor where account_id = (select id from meta.account where username = 'king')`);
  await owner.query(`delete from meta.account_recovery_code where account_id = (select id from meta.account where username = 'king')`);
  await owner.query(`update meta.app set mfa = 'off', mfa_roles = '{}' where id = $1`, [appId]);
}

before(async () => {
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  await cleanup();
  await owner.query(`insert into meta.activity_log (username, event, detail) values ('king', 'login_unlocked', 'e2e')`);
  await owner.query(`update meta.app set mfa = 'optional' where id = $1`, [appId]);
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://localhost:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  close = async () => {
    await browser.close();
    await app.close();
    await cleanup();
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

async function password(page: Page) {
  await page.goto(`${base}/a/hr/login`);
  await page.fill('input[name="username"]', 'king');
  await page.fill('input[name="password"]', 'king');
  await Promise.all([page.waitForNavigation(), page.click('form.login-form button.btn-hot')]);
}

describe('passkeys for application users (browser)', () => {
  test('add a passkey on My account, then use it for the second step', async () => {
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

    await password(page);
    assert.doesNotMatch(page.url(), /login/, 'optional and no factor yet: signed in');
    await page.goto(`${base}/a/hr/account`);
    const add = page.locator('#two-step [data-passkey]');
    await add.waitFor({ state: 'visible' });
    assert.deepEqual(await axe(page), []);
    await Promise.all([page.waitForNavigation(), add.click()]);
    assert.equal(await page.locator('#two-step .mfa-codes li').count(), 10, 'the first factor brings recovery codes');
    assert.match((await page.textContent('#two-step')) ?? '', /Passkey/);
    await page.check('#two-step input[name="saved"]');
    await Promise.all([page.waitForNavigation(), page.click('#two-step form[action$="/codes/confirm"] button')]);
    await csp(page);

    // signed out: the next sign-in offers the passkey
    await c.clearCookies();
    await password(page);
    assert.match(page.url(), /\/a\/hr\/login\/2fa$/);
    const use = page.locator('.mfa-passkey [data-passkey]');
    await use.waitFor({ state: 'visible' });
    assert.deepEqual(await axe(page), []);
    await Promise.all([page.waitForNavigation(), use.click()]);
    assert.doesNotMatch(page.url(), /login/);
    await csp(page);
    const log = await owner.one(`select detail from meta.activity_log where app_id = $1 and username = 'king' and event = 'login' order by id desc limit 1`, [appId]);
    assert.equal(log.detail, 'password 2fa (passkey)');
    await c.close();
  });
});
