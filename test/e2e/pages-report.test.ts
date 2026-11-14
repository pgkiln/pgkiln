// Sprint 193 (NX-F3): the application home's Pages report in a browser: the column chooser (kept per developer),
// the filters (auto-submitting selects), sorting by Updated, a page opened by its alias; at 360 px and on a laptop
// without horizontal page scroll, CSP violations or script errors.
//   npm run test:e2e
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

before(async () => {
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  await owner.query(`update meta.developer set page_columns = null where username = 'admin'`);
  close = async () => {
    await owner.query(`update meta.developer set page_columns = null where username = 'admin'`);
    await browser.close();
    await app.close();
    await closePools();
  };
});
after(async () => close());

async function signIn(size: { width: number; height: number }) {
  const context = await browser.newContext({ viewport: size });
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
  assert.deepEqual(await page.evaluate(() => (window as any).__csp), [], `${what}: CSP violations`);
}

const headers = (page: Page) => page.locator('table.pages-report thead th').allTextContents();

for (const [name, size] of [['phone', { width: 360, height: 780 }], ['laptop', { width: 1366, height: 768 }]] as const) {
  describe(`the Pages report at ${name} (${size.width}px)`, () => {
    test('the column chooser shows the counts and keeps the choice; filters and sorting by Updated', async () => {
      const { page, errors } = await signIn(size);
      await page.goto(`${base}/builder/apps/${appId}?sort=page`);
      let th = await headers(page);
      assert.ok(th.includes('Type') && th.includes('Alias') && th.some((t) => t.startsWith('Updated by')), th.join('|'));
      assert.ok(!th.includes('Regions'), 'the counts are hidden by default');
      await fits(page, 'pages report');

      // Columns → tick Regions and Items, Save
      await page.click('.pages-columns > summary');
      await page.check('.pages-columns input[value="regions"]');
      await page.check('.pages-columns input[value="items"]');
      await page.uncheck('.pages-columns input[value="conditions"]');
      await fits(page, 'column chooser open');
      await Promise.all([page.waitForNavigation(), page.click('.pages-columns button:not([name])')]);
      th = await headers(page);
      assert.ok(th.includes('Regions') && th.includes('Items') && !th.includes('Conditions'), th.join('|'));
      assert.deepEqual((await owner.one(`select page_columns from meta.developer where username = 'admin'`)).page_columns.includes('regions'), true);
      // kept: a new session of the same developer sees the same columns
      const again = await signIn(size);
      await again.page.goto(`${base}/builder/apps/${appId}`);
      assert.ok((await headers(again.page)).includes('Regions'));
      await again.page.context().close();
      // back to the default set
      await page.click('.pages-columns > summary');
      await Promise.all([page.waitForNavigation(), page.click('.pages-columns button[name="reset"]')]);
      assert.ok(!(await headers(page)).includes('Regions'));

      // a filter submits by itself: Type = Form
      await Promise.all([page.waitForNavigation(), page.selectOption('#pf_type', 'form')]);
      assert.match(page.url(), /type=form/);
      const types = await page.locator('#pages-rows tr').evaluateAll((rows) => rows.map((r) => r.textContent ?? ''));
      assert.ok(types.length > 0 && types.every((t) => t.includes('Form')), 'only forms');
      await fits(page, 'filtered report');
      await page.click('text=Clear filters');
      await page.waitForURL((u) => !u.search.includes('type='));

      // sort by Updated: newest first (a page changed just now leads)
      await owner.query(`insert into meta.page_change (app_id, page_no, updated_by, updated_at) values ($1, 12, 'admin', now())
                         on conflict (app_id, page_no) do update set updated_by = 'admin', updated_at = now()`, [appId]);
      await page.goto(`${base}/builder/apps/${appId}?sort=updated`);
      assert.equal((await page.locator('#pages-rows tr').first().locator('td').first().textContent())?.trim(), '12');
      assert.equal(await page.locator('th[aria-sort="descending"]').count(), 1);

      // Run opens the page by its alias
      const run = await page.locator('#pages-rows tr').first().locator('a[target="_blank"]').getAttribute('href');
      assert.equal(run, '/a/hr/leave-calendar');
      await page.goto(`${base}/builder/apps/${appId}?sort=page`);
      assert.deepEqual(errors, []);
      await page.context().close();
    });
  });
}
