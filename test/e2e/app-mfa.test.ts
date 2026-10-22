// Two-factor sign-in for application users in a real browser (sprint 130, SEC-3): the second step's page when an
// app must be added (QR code, key, first code), the recovery codes shown once, My account's section, and the code
// at the next sign-in; no CSP or axe-core violations.
process.env.PGKILN_SECRET_KEY ??= 'test-only-secret-key-0123456789abcdef';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools, owner } from '../../src/db.ts';
import { stepNow, totpAt, unbase32 } from '../../src/mfa.ts';

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
  await owner.query(`update meta.app set mfa = 'roles', mfa_roles = '{admin}' where id = $1`, [appId]);
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
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

async function passwordStep(page: Page) {
  await page.goto(`${base}/a/hr/login`);
  await page.fill('input[name="username"]', 'king');
  await page.fill('input[name="password"]', 'king');
  await Promise.all([page.waitForNavigation(), page.click('form.login-form button.btn-hot')]);
  assert.match(page.url(), /\/a\/hr\/login\/2fa$/);
}

describe('two-factor sign-in for application users (browser)', () => {
  test('adding an app while signing in, the recovery codes, My account, and the code next time', async () => {
    const c = await browser.newContext();
    await c.addInitScript(() => {
      (window as any).__csp = [];
      document.addEventListener('securitypolicyviolation', (e) => (window as any).__csp.push(`${e.violatedDirective}: ${e.blockedURI || e.sample || 'inline'}`));
    });
    const page = await c.newPage();
    await passwordStep(page);
    assert.equal(await page.locator('.mfa-qr svg').count(), 1);
    assert.deepEqual(await axe(page), []);
    await csp(page);
    const secret = ((await page.textContent('code.mfa-secret')) ?? '').replace(/\s/g, '');
    await page.fill('#code', totpAt(unbase32(secret), stepNow()));
    await Promise.all([page.waitForLoadState(), page.click('form.login-form button')]);
    assert.equal(await page.locator('.mfa-codes li').count(), 10);
    assert.deepEqual(await axe(page), []);
    await page.check('input[name="saved"]');
    await Promise.all([page.waitForNavigation(), page.click('form.login-form button')]);
    assert.doesNotMatch(page.url(), /login/);

    await page.goto(`${base}/a/hr/account`);
    assert.match((await page.textContent('#two-step')) ?? '', /Recovery codes left: 10/);
    assert.deepEqual(await axe(page), []);
    await csp(page);

    // signed out: the next sign-in asks for a code
    await c.clearCookies();
    await passwordStep(page);
    assert.equal(await page.locator('.mfa-qr').count(), 0);
    assert.deepEqual(await axe(page), []);
    await page.fill('#code', totpAt(unbase32(secret), stepNow() + 1));
    await Promise.all([page.waitForNavigation(), page.click('form.login-form button')]);
    assert.doesNotMatch(page.url(), /login/);
    await csp(page);
    await c.close();
  });
});
