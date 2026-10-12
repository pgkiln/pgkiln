// An application's own login page in a real browser (sprint 55): no header
// or navigation, the sign-in form's fields belong to a detached form (the
// page's own form wraps the regions), the browser's time zone goes along,
// no CSP or axe-core violations; and "Forgot password?" on the built-in page.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools, owner } from '../../src/db.ts';

const AXE = readFileSync(new URL('../../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
const SERVICE = 'E2E_LOGIN_PAGE';
let base = '';
let browser: Browser;
let appId: number;
let pageId: number;
let saved: { login_page: number | null; password_reset: boolean };
let close: () => Promise<void>;

before(async () => {
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  saved = (await owner.one('select login_page, password_reset from meta.app where id = $1', [appId]))!;
  pageId = (await owner.one(`insert into meta.page (app_id, page_no, name, title, requires_auth, page_template) values ($1, 9997, 'E2E login', 'Welcome', false, 'minimal') returning id`, [appId])).id;
  await owner.query(`insert into meta.region (page_id, seq, title, type, source) values ($1, 5, 'About', 'static', '<p>Sign in with your company account.</p>')`, [pageId]);
  await owner.query(`insert into meta.region (page_id, seq, title, type) values ($1, 10, 'HR Demo', 'login')`, [pageId]);
  const svc = (await owner.one(`insert into meta.mail_service (name, provider, senders) values ($1, 'log', '{@example.com}') returning id`, [SERVICE])).id;
  await owner.query(`insert into meta.app_mail_service (app_id, service_id, from_address) values ($1, $2, 'hr@example.com')
                     on conflict (app_id) do update set service_id = excluded.service_id, from_address = excluded.from_address`, [appId, svc]);
  await owner.query('update meta.app set login_page = 9997, password_reset = true where id = $1', [appId]);
  close = async () => {
    await owner.query('update meta.app set login_page = $2, password_reset = $3 where id = $1', [appId, saved.login_page, saved.password_reset]);
    await owner.query('delete from meta.page where id = $1', [pageId]);
    await owner.query('delete from meta.app_mail_service where app_id = $1', [appId]);
    await owner.query('delete from meta.mail_service where name = $1', [SERVICE]);
    await browser.close();
    await app.close();
    await closePools();
  };
});
after(() => close());

async function open(page: Page, url: string) {
  await page.context().addInitScript(() => {
    (window as any).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as any).__csp.push(`${e.violatedDirective}: ${e.blockedURI || e.sample || 'inline'}`));
  });
  await page.goto(`${base}${url}`);
}
const axe = async (page: Page) => {
  await page.evaluate(AXE);
  const r = await page.evaluate(() => (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }));
  return r.violations.map((v: { id: string; nodes: { html: string }[] }) => `${v.id}: ${v.nodes[0]?.html.slice(0, 120)}`);
};

describe('login page (browser)', () => {
  test('the application\'s own login page: regions around the sign-in form, sign-in works, no CSP or axe problems', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await open(page, '/a/hr/2');
    assert.match(page.url(), /\/a\/hr\/9997\?next=%2Fa%2Fhr%2F2$/);
    assert.equal(await page.locator('.t-header, #t-nav').count(), 0);
    assert.match(await page.locator('main').innerText(), /Sign in with your company account/);
    assert.match(await page.locator('.login-region').innerText(), /Forgot password\?/);
    assert.deepEqual(await axe(page), []);
    await page.fill('#username', 'king');
    await page.fill('#password', 'wrong');
    await Promise.all([page.waitForNavigation(), page.click('.login-region button.btn-hot')]);
    assert.match(await page.locator('.login-region [role="alert"]').innerText(), /Invalid username or password/);
    assert.equal(await page.inputValue('#username'), 'king');
    await page.fill('#password', 'king');
    await Promise.all([page.waitForNavigation(), page.click('.login-region button.btn-hot')]);
    assert.match(page.url(), /\/a\/hr\/2$/);
    assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
    await context.close();
  });

  test('forgot password: the request page and its answer have no CSP or axe problems', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await open(page, '/a/hr/password/forgot');
    assert.deepEqual(await axe(page), []);
    await page.fill('#login', 'nobody-here');
    await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
    assert.match(await page.locator('[role="status"]').innerText(), /If that matches an account/);
    assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
    await context.close();
  });
});
