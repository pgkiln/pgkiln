// SQL Workshop › SQL Monitor in a real browser (sprint 102, Database Actions DA-14): the sessions table refreshes
// in place (a new session shows up without a reload), the interval and the pause are remembered; Top SQL with its
// bars; no CSP or axe-core violations, and the pages fit a phone.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { chromium, type Browser, type Page } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools, owner, ownerUrl } from '../../src/db.ts';
import { statementsState } from '../../src/builder/top-sql.ts';

const AXE = readFileSync(new URL('../../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
let base = '';
let browser: Browser;
let close: () => Promise<void>;
const clients: pg.Client[] = [];

before(async () => {
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  close = async () => {
    for (const c of clients) await c.end().catch(() => {});
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
const ok = async (page: Page, what: string) => {
  assert.deepEqual(await page.evaluate(() => (window as any).__csp), [], `${what}: CSP`);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${what}: no page overflow`);
  assert.deepEqual(await axe(page), [], `${what}: axe`);
};

describe('SQL Monitor', () => {
  test('the sessions table refreshes without a reload; interval and pause are remembered', async () => {
    const page = await signedIn(1280);
    await page.goto(`${base}/builder/sql/monitor`);
    await page.evaluate(() => localStorage.removeItem('pgkiln.sqlMonitor'));
    await page.reload();
    assert.equal(await page.isVisible('[data-sm-controls]'), true, 'the controls show with JavaScript');
    assert.equal(await page.inputValue('[data-sm-interval]'), '5');
    await ok(page, 'sessions');
    await page.evaluate(() => ((window as any).__marker = 1)); // gone if the page reloads
    const c = new pg.Client({ connectionString: ownerUrl, application_name: 'e2e-sm102-live' });
    await c.connect();
    clients.push(c);
    const sleeping = c.query('select pg_sleep(20)').catch(() => {});
    await page.waitForSelector('text=e2e-sm102-live', { timeout: 12_000 });
    assert.equal(await page.evaluate(() => (window as any).__marker), 1, 'refreshed in place');
    // cancel it from its row (the confirmation accepted)
    page.once('dialog', (d) => d.accept());
    await Promise.all([page.waitForNavigation(), page.click('tr:has-text("e2e-sm102-live") button:has-text("Cancel")')]);
    await sleeping;
    assert.match(await page.textContent('body') ?? '', /Asked session \d+ to cancel/);

    await page.selectOption('[data-sm-interval]', '60');
    await page.click('[data-sm-pause]');
    assert.equal(await page.getAttribute('[data-sm-pause]', 'aria-pressed'), 'true');
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('pgkiln.sqlMonitor') ?? '{}')), { seconds: 60, paused: true });
    await page.reload();
    assert.equal(await page.inputValue('[data-sm-interval]'), '60');
    assert.equal(await page.textContent('[data-sm-pause]'), 'Resume');
    await page.click('[data-sm-pause]');
    assert.equal(await page.getAttribute('[data-sm-pause]', 'aria-pressed'), 'false');
    await page.context().close();
  });

  test('Top SQL and a statement fit a phone', async () => {
    const page = await signedIn(390);
    await page.goto(`${base}/builder/sql/monitor`);
    await ok(page, 'sessions (phone)');
    await page.goto(`${base}/builder/sql/monitor/top`);
    await ok(page, 'Top SQL (phone)');
    if ((await statementsState()).ok) {
      await owner.query(`select count(*) /* e2e sm102 */ from meta.app where id > $1`, [0]);
      await page.goto(`${base}/builder/sql/monitor/top?q=e2e%20sm102`);
      assert.ok(await page.isVisible('svg.sm-bar'), 'bars');
      await page.click('a:has-text("e2e sm102")');
      await page.click('button:has-text("Explain")');
      await page.waitForSelector('.ws-plan-tree');
      await ok(page, 'a statement (phone)');
    }
    await page.context().close();
  });
});
