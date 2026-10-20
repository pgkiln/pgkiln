// Sprint 118 (WS-9): Administration → Mail queue, Network access and a
// workspace's own mail service work without JavaScript on a phone (390 px):
// the forms post and come back, nothing overflows, the Content-Security-Policy
// holds, and the Administration menu has both entries.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools, owner } from '../../src/db.ts';

let base = '';
let browser: Browser;
let close: () => Promise<void>;
let appId: number;
let mailId: string;

before(async () => {
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  mailId = (await owner.one(`insert into meta.mail_queue (app_id, to_addresses, subject, body_text, status, attempts, message, service, provider, duration_ms, last_attempt_at)
    values ($1, '{gone@example.com}', 'E2E118 failed yesterday', 'x', 'error', 5, 'The SMTP server refused the message: 550 5.1.1 no such user', 'DEVELOPMENT_LOG', 'smtp', 640, now() - interval '1 day') returning id`, [appId])).id;
  close = async () => {
    await owner.query(`delete from meta.mail_queue where subject like 'E2E118 %'`);
    await owner.query(`update meta.workspace set network_restricted = false, network_hosts = '{}' where id = 1`);
    await owner.query(`delete from meta.mail_service where workspace_id = 1`);
    await browser.close();
    await app.close();
    await closePools();
  };
});
after(async () => close());

async function page(js: boolean): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, javaScriptEnabled: js });
  await context.addInitScript(() => {
    (window as any).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as any).__csp.push(`${e.violatedDirective}: ${e.blockedURI || e.sample || 'inline'}`));
  });
  const p = await context.newPage();
  await p.goto(`${base}/builder/login`);
  await p.fill('#f_username', 'admin');
  await p.fill('#f_password', 'admin');
  await Promise.all([p.waitForNavigation(), p.click('button.btn-hot')]);
  return p;
}

async function fits(p: Page, name: string) {
  const wide = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(wide <= 1, `${name} overflows by ${wide}px`);
  if (await p.evaluate(() => typeof (window as any).__csp !== 'undefined')) assert.deepEqual(await p.evaluate(() => (window as any).__csp), [], `${name}: CSP`);
}

describe('sprint 118: administration pages without JavaScript at 390 px', () => {
  test('the Administration menu has Mail queue and Network access', async () => {
    const p = await page(true);
    await p.goto(`${base}/builder/home`);
    await p.click('.rail-admin > summary');
    assert.ok(await p.locator('.rail-admin a[href="/builder/mail-queue"]').isVisible());
    assert.ok(await p.locator('.rail-admin a[href="/builder/network"]').isVisible());
    await fits(p, 'menu');
    await p.context().close();
  });

  test('Mail queue: yesterday\'s failure with its SMTP reply, Retry without JavaScript', async () => {
    const p = await page(false);
    await p.goto(`${base}/builder/mail-queue`);
    const row = p.locator('.mail-failures tr', { hasText: 'E2E118 failed yesterday' });
    assert.match(await row.innerText(), /550 5\.1\.1 no such user/);
    await fits(p, 'mail queue');
    await Promise.all([p.waitForNavigation(), row.locator('button', { hasText: 'Retry' }).click()]);
    assert.match(await p.locator('body').innerText(), /queued again/);
    assert.equal((await owner.one('select status from meta.mail_queue where id = $1', [mailId])).status, 'queued');
    await owner.query(`update meta.mail_queue set status = 'cancelled' where id = $1`, [mailId]);
    await p.context().close();
  });

  test('Network access: restrict the workspace and check a URL without JavaScript', async () => {
    const p = await page(false);
    await p.goto(`${base}/builder/network?ws=1`);
    await p.check('input[name=restricted][value=true]');
    await p.fill('#f_hosts', 'api.example.com');
    await Promise.all([p.waitForNavigation(), p.click('#workspace-list button.btn-hot')]);
    assert.deepEqual((await owner.one('select network_hosts from meta.workspace where id = 1')).network_hosts, ['api.example.com']);
    // allowed by the installation (PGKILN_REST_PRIVATE_HOSTS in CI and .env, or refused by it): never by this workspace
    await p.fill('#f_url', 'http://127.0.0.1:3155/x');
    await Promise.all([p.waitForNavigation(), p.press('#f_url', 'Enter')]);
    assert.match(await p.locator('[role=status] .alert-error').innerText(), /not on the network access list of workspace Default|not on the server's allow-list/);
    await fits(p, 'network access');
    await owner.query(`update meta.workspace set network_restricted = false, network_hosts = '{}' where id = 1`);
    await p.context().close();
  });

  test('a workspace\'s mail service: saved without JavaScript; the secret is not shown again', async () => {
    const p = await page(false);
    await p.goto(`${base}/builder/workspaces/1/mail?provider=resend`);
    await p.fill('#f_senders', '@example.com');
    await p.fill('#f_secret', 'e2e-resend-key-never-shown');
    await Promise.all([p.waitForNavigation(), p.click('.mail-service-form button.btn-hot')]);
    assert.ok(await owner.one(`select 1 from meta.mail_service where workspace_id = 1 and provider = 'resend'`));
    assert.doesNotMatch(await p.content(), /e2e-resend-key-never-shown/);
    await fits(p, 'workspace mail');
    await p.context().close();
  });
});
