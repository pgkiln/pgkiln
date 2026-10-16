// Administration → Database Users in a real browser (sprint 99, Database Actions DA-13): create report_reader
// (login, valid until next year, usage on hr), the SQL reviewed with the password masked before Apply, the role in
// the list; drop it; no CSP or axe-core violations, and the pages fit a phone.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools, owner } from '../../src/db.ts';

const AXE = readFileSync(new URL('../../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
const ROLE = 'report_reader';
const PASSWORD = 'E2e-reader-pw-99';
let base = '';
let browser: Browser;
let close: () => Promise<void>;

const dropRole = () => owner.query(`do $$ begin if exists (select 1 from pg_roles where rolname = '${ROLE}') then drop owned by ${ROLE}; drop role ${ROLE}; end if; end $$`);

before(async () => {
  await dropRole();
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  close = async () => {
    await dropRole();
    await browser.close();
    await app.close();
    await closePools();
  };
});
after(() => close());

async function signedIn(width: number) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.addInitScript(() => {
    (window as any).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as any).__csp.push(`${e.violatedDirective}: ${e.blockedURI || e.sample || 'inline'}`));
  });
  const page = await context.newPage();
  await page.goto(`${base}/builder/login`);
  await page.fill('#f_username', 'admin');
  await page.fill('#f_password', 'admin');
  await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
  return page;
}
const axe = async (page: Page) => {
  await page.evaluate(AXE);
  const r = await page.evaluate(() => (window as any).axe.run(document.querySelector('main') ?? document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }));
  return r.violations.map((v: { id: string; nodes: { html: string }[] }) => `${v.id}: ${v.nodes[0]?.html.slice(0, 120)}`);
};
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const ok = async (page: Page, what: string) => {
  assert.deepEqual(await page.evaluate(() => (window as any).__csp), [], `${what}: CSP`);
  assert.ok(await fits(page), `${what}: no page overflow`);
};

describe('Database Users (browser)', () => {
  for (const width of [1280, 390]) {
    test(`create report_reader: review the SQL (password masked), apply, find it in the list; drop it (${width} px)`, async () => {
      const page = await signedIn(width);
      try {
        // from the Administration menu
        await page.goto(`${base}/builder`);
        await page.click('summary[title="Administration"]');
        await Promise.all([page.waitForNavigation(), page.click('.rail-admin a[href="/builder/db-users"]')]);
        await ok(page, 'list');
        if (width > 1000) assert.deepEqual(await axe(page), []);
        await Promise.all([page.waitForNavigation(), page.click('a[href="/builder/db-users/new"]')]);
        await ok(page, 'new');
        await page.fill('#f_name', ROLE);
        await page.check('input[name="password_mode"][value="set"]');
        const nextYear = `${new Date().getFullYear() + 1}-03-31`;
        await page.fill('#f_valid_until', nextYear);
        await page.check('input[aria-label="Usage on hr"]');
        if (width > 1000) assert.deepEqual(await axe(page), []);
        await Promise.all([page.waitForNavigation(), page.click('button[value="review"]')]);
        // the SQL before Apply, the password masked; nothing exists yet
        const sql = await page.locator('pre.dbu-sql').innerText();
        assert.match(sql, new RegExp(`CREATE ROLE "${ROLE}" LOGIN PASSWORD '\\*{8}' VALID UNTIL '${nextYear}';`));
        assert.match(sql, new RegExp(`GRANT USAGE ON SCHEMA "hr" TO "${ROLE}";`));
        assert.equal((await owner.one('select count(*)::int as n from pg_roles where rolname = $1', [ROLE])).n, 0);
        await ok(page, 'review');
        if (width > 1000) assert.deepEqual(await axe(page), []);
        await page.fill('#f_password', PASSWORD);
        await page.fill('#f_confirm', PASSWORD);
        await Promise.all([page.waitForNavigation(), page.click('button[value="apply"]')]);
        assert.match(await page.locator('.alert-success').innerText(), /Created the role report_reader/);
        assert.equal(await page.locator(`a[href="/builder/db-users/role/${ROLE}"]`).count(), 1);
        assert.ok(!(await page.content()).includes(PASSWORD));
        await ok(page, 'list after');
        // the role's page, then drop it
        await Promise.all([page.waitForNavigation(), page.click(`a[href="/builder/db-users/role/${ROLE}"]`)]);
        await ok(page, 'role');
        assert.equal(await page.locator('input[aria-label="Usage on hr"]').isChecked(), true);
        await Promise.all([page.waitForNavigation(), page.click('a.btn-danger')]);
        await ok(page, 'drop');
        assert.match(await page.locator('pre.dbu-sql').innerText(), new RegExp(`DROP ROLE "${ROLE}";`));
        page.once('dialog', (d) => d.accept());
        await Promise.all([page.waitForNavigation(), page.click('button.btn-danger')]);
        assert.match(await page.locator('.alert-success').innerText(), /Dropped the role report_reader/);
        assert.equal((await owner.one('select count(*)::int as n from pg_roles where rolname = $1', [ROLE])).n, 0);
      } finally {
        await page.context().close();
      }
    });
  }
});
