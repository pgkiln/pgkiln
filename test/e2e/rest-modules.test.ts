// SQL Workshop › RESTful Services › Modules (sprint 104) in a real browser: the module's tree, a template, a
// PL/pgSQL handler and its Try it panel; no CSP or axe-core violations, and a phone's width.
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
  close = async () => {
    const ids = (await owner.query(`select id from hr.leave_request where reason = 'e2e104'`)).rows.map((r) => String(r.id));
    await owner.query('delete from meta.task where app_id = $1 and detail_pk = any($2::text[])', [appId, ids]);
    await owner.query(`delete from hr.leave_request where reason = 'e2e104'`);
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

describe('RESTful Services modules (browser)', () => {
  test('the HR module: tree → template → handler; Try it posts a leave request as allen', async () => {
    const page = await signedIn();
    const id = (await owner.one(`select id from meta.rest_module where app_id = $1 and name = 'hr'`, [appId])).id;
    await page.goto(`${base}/builder/sql/rest/modules`);
    await Promise.all([page.waitForNavigation(), page.getByRole('link', { name: 'HR (RESTful Services)' }).click()]);
    assert.match(await page.locator('main').innerText(), /\/a\/hr\/rest\/hr\/openapi\.json/);
    assert.deepEqual(await axe(page), []);
    await Promise.all([page.waitForNavigation(), page.locator('.rm-tree a', { hasText: 'leave' }).first().click()]);
    assert.match(page.url(), /\/template\?t=leave$/);
    await Promise.all([page.waitForNavigation(), page.locator('main table a', { hasText: 'POST' }).click()]);
    assert.match(page.url(), new RegExp(`/builder/sql/rest/modules/${id}/handler\\?t=leave&m=POST$`));
    assert.equal(await page.locator('#f_type').inputValue(), 'plpgsql');
    assert.deepEqual(await axe(page), []);
    await page.selectOption('#f_as', 'allen');
    await page.fill('#f_body', JSON.stringify({ start_date: '2033-02-01', end_date: '2033-02-02', reason: 'e2e104' }));
    await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Send POST' }).click()]);
    const text = await page.locator('main').innerText();
    assert.match(text, /\b201\b/);
    assert.match(text, /"status": "requested"/);
    assert.equal((await owner.one(`select count(*)::int as n from hr.leave_request where reason = 'e2e104'`)).n, 1);
    assert.deepEqual(await axe(page), []);
    assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
    await page.context().close();
  });

  test('a phone\'s width: no page overflow, no sr-only text in the tables', async () => {
    const page = await signedIn(390);
    const id = (await owner.one(`select id from meta.rest_module where app_id = $1 and name = 'hr'`, [appId])).id;
    for (const url of ['/builder/sql/rest/modules', `/builder/sql/rest/modules/${id}`, `/builder/sql/rest/modules/${id}/template?t=${encodeURIComponent('emp/:id')}`, `/builder/sql/rest/modules/${id}/handler?t=leave&m=POST`]) {
      await page.goto(`${base}${url}`);
      assert.ok(await noOverflow(page), `${url} fits 390 px`);
      assert.equal(await page.locator('.table-wrap .sr-only').count(), 0);
    }
    assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
    await page.context().close();
  });
});
