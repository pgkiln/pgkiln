// Sprint 203 (AX-6, AX-7): Recently edited pages in the application home's side column, Copy application in Tasks,
// Utilities' Recently updated pages by name with relative times, Shared Components → Templates, and the builder's
// search (Ctrl+K) finding Templates and Session State Protection; at 360 and 1366 px, by keyboard.
//   npm run test:e2e   (SCREENSHOTS=1 saves the pages to test-results/)
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools, owner } from '../../src/db.ts';

let base = '';
let browser: Browser;
let close: () => Promise<void>;
let appId: number;
const shots = process.env.SCREENSHOTS === '1';
if (shots) mkdirSync('test-results', { recursive: true });
const WIDTHS = [360, 1366] as const;
const COPY = 'e2e203-copy';

before(async () => {
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  await owner.query(`delete from meta.app where alias like 'e2e203%'`);
  // a page change of the developer, so the home has something to list
  await owner.query(`insert into meta.page_change (app_id, page_no, updated_by, updated_at) values ($1, 1, 'admin', now())
                     on conflict (app_id, page_no) do update set updated_by = excluded.updated_by, updated_at = excluded.updated_at`, [appId]);
  close = async () => {
    await owner.query(`delete from meta.app where alias like 'e2e203%'`);
    await browser.close();
    await app.close();
    await closePools();
  };
});
after(async () => close());

async function signIn(width: number, js = true) {
  const context = await browser.newContext({ viewport: { width, height: 800 }, javaScriptEnabled: js });
  await context.addInitScript(() => {
    (window as any).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as any).__csp.push(`${e.violatedDirective}: ${e.blockedURI || 'inline'}`));
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/builder/login`);
  await page.fill('#f_username', 'admin');
  await page.fill('#f_password', 'admin');
  await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
  return { page, errors };
}

async function fits(page: Page, what: string) {
  const o = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    return document.documentElement.scrollWidth > vw + 1 ? { scrollWidth: document.documentElement.scrollWidth, vw } : null;
  });
  assert.equal(o, null, `${what} overflows: ${JSON.stringify(o)}`);
  if (await page.evaluate(() => (window as any).__csp !== undefined)) assert.deepEqual(await page.evaluate(() => (window as any).__csp), [], `${what}: CSP violations`);
}

/** Focus the first element matching `selector` from the one before it with Tab (it is in the tab order). */
async function tabTo(page: Page, selector: string) {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel)!;
    // the focusable element before it in document order
    const all = [...document.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, summary, [tabindex]')].filter((e) => !e.hasAttribute('disabled') && e.tabIndex >= 0 && e.offsetParent !== null);
    all[all.indexOf(el as HTMLElement) - 1]?.focus();
  }, selector);
  await page.keyboard.press('Tab');
  assert.ok(await page.evaluate((sel) => document.activeElement === document.querySelector(sel), selector), `Tab reaches ${selector}`);
}

for (const width of WIDTHS) {
  describe(`sprint 203 at ${width}px`, () => {
    test('the application home: Recently edited pages under Tasks, by keyboard into the Page Designer', async () => {
      const { page, errors } = await signIn(width);
      await page.goto(`${base}/builder/apps/${appId}`);
      const recent = page.locator('.app-side .app-recent');
      assert.ok(await recent.isVisible());
      const tasks = (await page.locator('.app-side .app-tasks').boundingBox())!;
      const box = (await recent.boundingBox())!;
      assert.ok(box.y >= tasks.y + tasks.height - 1, 'under Tasks');
      const links = recent.locator('a');
      const n = await links.count();
      assert.ok(n >= 1 && n <= 5, `${n} pages`);
      assert.ok(await page.locator('.app-tasks a', { hasText: 'Copy application' }).isVisible());
      await fits(page, 'app home');
      if (shots) await page.screenshot({ path: `test-results/sprint203-home-${width}.png`, fullPage: true });
      await tabTo(page, '.app-recent a');
      await Promise.all([page.waitForURL(/\/builder\/apps\/\d+\/pages\/\d+$/), page.keyboard.press('Enter')]);
      assert.deepEqual(errors, []);
      await page.context().close();
    });

    test('Utilities: every row of Recently updated pages has a name and a relative time', async () => {
      const { page } = await signIn(width);
      await page.goto(`${base}/builder/apps/${appId}/utilities`);
      const cells = await page.locator('table:has(th:text("Last change")) td[data-label="Page"]').allTextContents();
      for (const c of cells) assert.doesNotMatch(c.trim(), /^\d+$/, c);
      const times = await page.locator('table:has(th:text("Last change")) td[data-label="Last change"]').allTextContents();
      for (const t of times) assert.match(t.trim(), /ago|just now/, t);
      await fits(page, 'utilities');
      await page.context().close();
    });

    test('Shared Components → Templates: the tables fit, where-used opens by keyboard', async () => {
      const { page, errors } = await signIn(width);
      await page.goto(`${base}/builder/apps/${appId}/shared`);
      await Promise.all([page.waitForURL(/\/templates$/), page.locator('#sc-ui ~ * a, section[aria-labelledby="sc-ui"] a', { hasText: /^Templates$/ }).first().click()]);
      for (const h of ['Page templates', 'Region templates', 'Button templates', 'Label templates', 'Report templates', 'List templates'])
        assert.ok(await page.getByRole('heading', { name: h }).isVisible(), h);
      await fits(page, 'templates');
      if (shots) await page.screenshot({ path: `test-results/sprint203-templates-${width}.png`, fullPage: true });
      await tabTo(page, '#page-templates details.tpl-uses > summary');
      await page.keyboard.press('Enter');
      const first = page.locator('#page-templates details.tpl-uses[open] a').first();
      assert.ok(await first.isVisible());
      assert.match((await first.getAttribute('href'))!, /\/pages\/\d+\?c=page$/);
      await fits(page, 'templates with a list open');
      assert.deepEqual(errors, []);
      await page.context().close();
    });
  });
}

describe('sprint 203: Ctrl+K and Copy application', () => {
  test('Ctrl+K in an application finds Templates and Session State Protection', async () => {
    const { page, errors } = await signIn(1366);
    await page.goto(`${base}/builder/apps/${appId}/shared`);
    await page.keyboard.press('Control+k');
    await page.locator('.palette[open] input').fill('template');
    const first = page.locator('.palette-list [role=option]').first();
    await first.waitFor();
    assert.match(await first.textContent() ?? '', /^Templates Shared component/);
    await Promise.all([page.waitForURL(/\/templates$/), page.keyboard.press('Enter')]);
    await page.keyboard.press('Control+k');
    await page.locator('.palette[open] input').fill('session state');
    await page.locator('.palette-list [role=option]', { hasText: 'Session State Protection' }).first().waitFor();
    await Promise.all([page.waitForURL(/settings\?tab=errors#expire-bookmarks$/), page.keyboard.press('Enter')]);
    assert.ok(await page.locator('#expire-bookmarks').isVisible());
    assert.deepEqual(errors, []);
    await page.context().close();
  });

  test('Copy application at 360 px, without JavaScript: the form fits and Enter copies', async () => {
    const { page } = await signIn(360, false);
    await page.goto(`${base}/builder/apps/${appId}`);
    await Promise.all([page.waitForURL(/\/copy$/), page.locator('.app-tasks a', { hasText: 'Copy application' }).click()]);
    await fits(page, 'copy application');
    await page.fill('#f_name', 'E2E 203 copy');
    await page.fill('#f_alias', COPY);
    await Promise.all([page.waitForURL(/\/builder\/apps\/\d+$/), page.locator('#f_alias').press('Enter')]);
    const copy = await owner.one(`select id, name from meta.app where alias = $1`, [COPY]);
    assert.ok(copy);
    assert.ok(page.url().endsWith(`/builder/apps/${copy.id}`));
    assert.ok(await page.getByText('created as a copy of').isVisible());
    await page.context().close();
  });
});
