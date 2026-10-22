// Builder sign-in through identity providers in a real browser (sprint 129, SEC-1): the sign-in page with a
// provider's button and a directory choice, the Security page's identities, a provider's "Builder sign-in"
// region and a workspace's single sign-on rule; no CSP or axe-core violations, and the pgkiln password still
// signs in.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools, owner } from '../../src/db.ts';

const AXE = readFileSync(new URL('../../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
const DEV = 'e2e_bsso';
const PW = 'E2e-bsso-password-1!';
let base = '';
let browser: Browser;
let providerId = 0;
let close: () => Promise<void>;

async function cleanup() {
  await owner.query('delete from meta.developer where username = $1', [DEV]);
  await owner.query(`delete from meta.auth_provider where name = 'e2e-idp'`);
  await owner.query(`delete from meta.ldap_directory where name = 'e2e-dir'`);
}

before(async () => {
  await cleanup();
  await owner.query('insert into meta.developer (username, password_hash, is_admin, break_glass) values ($1, meta.hash_password($2), true, true)', [DEV, PW]);
  providerId = (await owner.one(`insert into meta.auth_provider (name, display_name, issuer, client_id, builder) values ('e2e-idp', 'Company IdP', 'https://idp.example.org', 'pgkiln', true) returning id`)).id;
  await owner.query(`insert into meta.ldap_directory (name, display_name, url, user_base, builder) values ('e2e-dir', 'Company directory', 'ldap://127.0.0.1:1', 'ou=people,dc=example,dc=org', true)`);
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

async function open(page: Page, url: string) {
  await page.goto(`${base}${url}`);
}
const axe = async (page: Page) => {
  await page.evaluate(AXE);
  const r = await page.evaluate(() => (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }));
  return r.violations.map((v: { id: string; nodes: { html: string }[] }) => `${v.id}: ${v.nodes[0]?.html.slice(0, 120)}`);
};
const csp = async (page: Page) => assert.deepEqual(await page.evaluate(() => (window as any).__csp), [], 'Content-Security-Policy');

describe('builder sign-in through identity providers (browser)', () => {
  test('the sign-in page, the Security page, the provider and the workspace', async () => {
    const c = await browser.newContext();
    await c.addInitScript(() => {
      (window as any).__csp = [];
      document.addEventListener('securitypolicyviolation', (e) => (window as any).__csp.push(`${e.violatedDirective}: ${e.blockedURI || e.sample || 'inline'}`));
    });
    const page = await c.newPage();
    await open(page, '/builder/login');
    assert.equal(await page.getAttribute('a.signin-idp', 'href'), '/builder/sso/e2e-idp');
    assert.match(await page.textContent('a.signin-idp') ?? '', /Sign in with Company IdP/);
    assert.equal(await page.locator('select[name="method"] option').count(), 2);
    assert.deepEqual(await axe(page), []);
    await csp(page);

    // the pgkiln password (the default choice) still signs in
    await page.fill('input[name="username"]', DEV);
    await page.fill('input[name="password"]', PW);
    await Promise.all([page.waitForNavigation(), page.click('button.signin-submit')]);
    assert.match(page.url(), /\/builder\/home$/);

    await open(page, '/builder/security');
    assert.match(await page.textContent('#identities') ?? '', /Link Company IdP/);
    assert.deepEqual(await axe(page), []);
    await open(page, `/builder/users/providers/${providerId}`);
    assert.match(await page.textContent('#builder-sign-in') ?? '', /Builder sign-in/);
    assert.deepEqual(await axe(page), []);
    await open(page, '/builder/workspaces/1');
    assert.equal(await page.locator('#sso').count(), 1);
    assert.deepEqual(await axe(page), []);
    await open(page, '/builder/developers');
    assert.match(await page.textContent('body') ?? '', /break-glass/);
    assert.deepEqual(await axe(page), []);
    await csp(page);
    await c.close();
  });
});
