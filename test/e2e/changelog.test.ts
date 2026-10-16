// SQL Workshop › Change Log (sprint 106) in a real browser: a column added in Table Properties becomes change set
// V0001__add_bonus.sql in the Change Log; no CSP or axe-core violations, and a phone's width.
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
let appId: number;

before(async () => {
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  await owner.query(`drop schema if exists e2e106 cascade; create schema e2e106; create table e2e106.emp (id int primary key, name text)`);
  await owner.query(`delete from meta.change_set where schema_name = 'e2e106'; delete from meta.change_set_counter where schema_name = 'e2e106'`);
  close = async () => {
    await owner.query(`drop schema if exists e2e106 cascade`);
    await owner.query(`delete from meta.change_set where schema_name = 'e2e106'; delete from meta.change_set_counter where schema_name = 'e2e106'`);
    await browser.close();
    await app.close();
    await closePools();
  };
});
after(() => close());

async function signedIn(width = 1280) {
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
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

describe('Change Log (browser)', () => {
  test('Table Properties › add a column › Apply: the Change Log lists V0001__add_bonus.sql', async () => {
    const page = await signedIn();
    await page.goto(`${base}/builder/sql/objects/table?o=e2e106.emp`);
    const rows = page.locator('[data-te-grid=col] tbody tr:not([hidden])');
    const n = await rows.count();
    await page.locator('[data-te-add=col]').click();
    await rows.nth(n).locator('input[name$=".name"]').fill('bonus');
    await rows.nth(n).locator('input[name$=".type"]').fill('numeric(8,2)');
    await Promise.all([page.waitForNavigation(), page.locator('button[value=apply]').click()]);
    await page.goto(`${base}/builder/sql/changes?schema=e2e106`);
    const text = await page.locator('main').innerText();
    assert.match(text, /V0001__add_bonus\.sql/);
    assert.match(text, /Table Properties/);
    await page.locator('summary', { hasText: 'V0001__add_bonus.sql' }).click();
    assert.match(await page.locator('main pre').first().innerText(), /alter table e2e106\.emp add column bonus numeric\(8,2\);/);
    assert.deepEqual(await axe(page), []);
    assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
    await page.context().close();
  });

  test('a phone\'s width: no page overflow', async () => {
    const page = await signedIn(390);
    await page.goto(`${base}/builder/sql/changes?schema=e2e106`);
    assert.ok(await noOverflow(page));
    assert.equal(await page.locator('.table-wrap .sr-only').count(), 0);
    assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
    await page.context().close();
  });
});
