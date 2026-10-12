// SQL Workshop → Generate DDL and Schema Comparison in a real browser
// (sprint 56): the pages, the script in the code editor, the differences
// with their diff; no CSP or axe-core violations.
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
let close: () => Promise<void>;

before(async () => {
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  await owner.query(`drop schema if exists e2e_ddl_a cascade; drop schema if exists e2e_ddl_b cascade;
    create schema e2e_ddl_a; create table e2e_ddl_a.t (id int primary key, name text); create view e2e_ddl_a.v as select name from e2e_ddl_a.t;
    create schema e2e_ddl_b; create table e2e_ddl_b.t (id int primary key, name varchar(20), extra int);`);
  close = async () => {
    await owner.query('drop schema if exists e2e_ddl_a cascade; drop schema if exists e2e_ddl_b cascade;');
    await browser.close();
    await app.close();
    await closePools();
  };
});
after(() => close());

async function signedIn() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
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

describe('SQL Workshop utilities (browser)', () => {
  test('Generate DDL: choose a schema, the script shows in the editor', async () => {
    const page = await signedIn();
    await page.goto(`${base}/builder/sql/ddl`);
    await page.selectOption('#f_schema', 'e2e_ddl_a');
    await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
    assert.match(await page.locator('textarea[aria-label="DDL of e2e_ddl_a"]').inputValue(), /create or replace view v as/);
    assert.deepEqual(await axe(page), []);
    assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
    await page.context().close();
  });

  test('Schema Comparison: the differences with their diff and a change script', async () => {
    const page = await signedIn();
    await page.goto(`${base}/builder/sql/compare?source=e2e_ddl_a&target=e2e_ddl_b`);
    assert.match(await page.locator('main').innerText(), /Only in the source/);
    await page.locator('.compare-list summary', { hasText: /^table\s+t$/ }).click();
    assert.equal(await page.locator('.compare-list pre.diff .diff-add').count() > 0, true);
    assert.match(await page.locator('textarea[aria-label="Change script"]').inputValue(), /alter table t alter column name type text;/);
    assert.deepEqual(await axe(page), []);
    assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
    if (process.env.DDL_SHOT) await page.screenshot({ path: process.env.DDL_SHOT, fullPage: true });
    await page.context().close();
  });
});
