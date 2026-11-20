// Sprint 233: the Developers page in a browser at phone, tablet and desktop widths: another developer's e-mail input
// keeps a usable width in the reflow table, the Administrator checkbox sits in the Add developer form's grid with the
// same spacing as the other fields, the Remove confirmation names the locks it releases, and removing releases them;
// no horizontal page scroll, CSP violations or script errors.
//   npm run test:e2e
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools, owner } from '../../src/db.ts';

const DEV = 'e2e_s233_dev';
let base = '';
let browser: Browser;
let close: () => Promise<void>;
let appId: number;

const addDev = () =>
  owner.query(`insert into meta.developer (username, password_hash, is_admin, email) values ($1, meta.hash_password('E2e-s233-password!'), false, 'someone@example.com') on conflict do nothing`, [DEV]);

before(async () => {
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  await addDev();
  close = async () => {
    await owner.query('delete from meta.developer where username = $1', [DEV]);
    await owner.query(`delete from meta.builder_lock where locked_by = $1`, [DEV]);
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
  return { page, errors, context };
}

describe('sprint 233 Developers page', () => {
  for (const [name, size] of [
    ['phone', { width: 390, height: 844 }],
    ['tablet', { width: 820, height: 1180 }],
    ['desktop', { width: 1440, height: 900 }],
  ] as const) {
    test(`layout at ${name} width`, async () => {
      const { page, errors, context } = await signIn(size);
      try {
        await page.goto(`${base}/builder/developers`);
        const email = page.locator(`input[name="email"][aria-label="E-mail address of ${DEV}"]`);
        const w = (await email.boundingBox())!.width;
        assert.ok(w >= 140, `the e-mail input is ${w}px wide (it was 57px in a column of three)`);
        assert.equal(await email.inputValue(), 'someone@example.com');
        // the Administrator checkbox is a cell of the form grid, not a line glued under the e-mail help
        assert.equal(await page.locator('form[action="/builder/developers"] .form-grid .dev-admin-field input[name="is_admin"]').count(), 1);
        const help = (await page.locator('form[action="/builder/developers"] #f_email').locator('xpath=ancestor::*[contains(@class,"field")][1]').boundingBox())!;
        const check = (await page.locator('.dev-admin-field').boundingBox())!;
        if (check.y > help.y + 1) assert.ok(check.y - (help.y + help.height) >= 8, `gap above the checkbox: ${check.y - (help.y + help.height)}px`);
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.ok(over <= 1, `horizontal page scroll: ${over}px`);
        assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    });
  }

  test('Remove names the locks it releases, and releases them', async () => {
    await addDev();
    await owner.query(`delete from meta.builder_lock where app_id = $1 and page_no in (0, 4)`, [appId]);
    await owner.query(`insert into meta.builder_lock (app_id, page_no, locked_by) values ($1, 0, $2), ($1, 4, $2)`, [appId, DEV]);
    const { page, errors, context } = await signIn({ width: 1280, height: 900 });
    try {
      await page.goto(`${base}/builder/developers`);
      const row = page.locator('tr', { hasText: DEV });
      await row.getByText('holds 2 lock(s)').waitFor();
      let message = '';
      page.once('dialog', (d) => {
        message = d.message();
        void d.accept();
      });
      const remove = row.locator('form[action="/builder/developers/delete"] button');
      const confirm = await remove.getAttribute('data-confirm');
      assert.match(confirm ?? '', /Their 2 lock\(s\) are released: .*application, pages 4/);
      await remove.click();
      // the builder's confirm is a dialog of its own or the browser's
      const ok = page.locator('dialog[open] button.btn-danger, dialog[open] button.btn-hot');
      if (!message && (await ok.count())) await ok.first().click();
      await page.getByText('Developer removed; 2 lock(s) released.').waitFor();
      assert.equal((await owner.query('select 1 from meta.builder_lock where locked_by = $1', [DEV])).rowCount, 0);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
});
