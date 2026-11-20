// Sprint 240 (MG-7, MG-8) in a real browser, on HR page 67 (HR part 103), opened as a dialog from page 35:
// the file item in the grid's toolbar, "Read the file" that stays in the dialog, the grid's Save that stays too,
// "Import" that closes it; the Ajax callback LOOKUP_CONTACT (a chain whose first step's web request is made
// before its second step) and execute_sql + set_value. At 1280 and 390 px, under the strict CSP.
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
const env = { allowed: process.env.PGKILN_REST_ALLOWED_HOSTS, priv: process.env.PGKILN_REST_PRIVATE_HOSTS, url: process.env.PUBLIC_URL };

before(async () => {
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  // the page's web requests go to the HR example's own sample CRM on this server
  process.env.PGKILN_REST_ALLOWED_HOSTS = '127.0.0.1';
  process.env.PGKILN_REST_PRIVATE_HOSTS = '127.0.0.1';
  process.env.PUBLIC_URL = base;
  browser = await chromium.launch();
  close = async () => {
    await owner.query(`delete from hr.crm_contact where company = 'E2E Import'`);
    await owner.query(`delete from hr.contact_import`);
    for (const [k, v] of [['PGKILN_REST_ALLOWED_HOSTS', env.allowed], ['PGKILN_REST_PRIVATE_HOSTS', env.priv], ['PUBLIC_URL', env.url]] as const)
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    await browser.close();
    await app.close();
    await closePools();
  };
});
after(() => close());

async function open(width: number): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.addInitScript(() => {
    (window as any).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as any).__csp.push(`${e.violatedDirective}: ${e.blockedURI || e.sample || 'inline'}`));
  });
  const page = await context.newPage();
  await page.goto(`${base}/a/hr/login`);
  await page.fill('#username', 'king');
  await page.fill('#password', 'king');
  await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
  return page;
}

const CSV = 'Name,Company,E-mail\nRuth Teitelbaum,E2E Import,ruth@example.com\nJean Bartik,E2E Import,jean@example.com\n';

describe('sprint 240: an import dialog that stays open; web requests right after Ajax callbacks', () => {
  for (const width of [1280, 390])
    test(`upload, preview, save and import in one dialog (${width} px)`, async () => {
      await owner.query(`delete from hr.contact_import`);
      const page = await open(width);
      await page.goto(`${base}/a/hr/35`);
      await page.locator('a', { hasText: 'Import contacts' }).click();
      const frame = page.frameLocator('#t-dialog iframe');
      // the file item stands in the grid's toolbar
      const file = frame.locator('.grid-toolbar #P67_FILE');
      await file.waitFor();
      await file.setInputFiles({ name: 'contacts.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) });
      await frame.locator('button[data-button="PREVIEW"]').click();
      // the dialog stays open: the same page again, with the success message and the lines
      await frame.locator('.alert-success', { hasText: 'The file is read' }).waitFor();
      assert.equal(await page.locator('#t-dialog[open]').count(), 1);
      assert.equal(await frame.locator('.grid-table tr[data-row]').count(), 2);
      // the grid's Save stays in the dialog too
      await frame.locator('.grid-table tr[data-row]').first().locator('input[type="text"]').first().fill('Ruth Lichterman');
      await frame.locator('button[name="__request"][value^="GRID_SAVE_"]').click();
      await frame.locator('.grid-table td', { hasText: 'Ruth Lichterman' }).first().waitFor();
      assert.equal(await page.locator('#t-dialog[open]').count(), 1);
      // at 390 px the dialog's page doesn't scroll sideways
      const overflow = await frame.locator('body').evaluate((b) => b.ownerDocument.documentElement.scrollWidth - b.ownerDocument.documentElement.clientWidth);
      assert.ok(overflow <= 1, `horizontal overflow ${overflow}px`);
      // Import closes the dialog
      await frame.locator('button[data-button="IMPORT"]').click();
      await page.locator('#t-dialog[open]').waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
      await page.waitForFunction(() => !document.querySelector('#t-dialog[open]'));
      const names = (await owner.query(`select name from hr.crm_contact where company = 'E2E Import' order by id`)).rows.map((r) => r.name);
      assert.deepEqual(names, ['Ruth Lichterman', 'Jean Bartik']);
      assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
      await owner.query(`delete from hr.crm_contact where company = 'E2E Import'`);
      await page.context().close();
    });

  test('Look up: one Ajax call answers with the web service\'s contact; Count: execute_sql then set_value', async () => {
    const page = await open(1280);
    await page.goto(`${base}/a/hr/67`);
    const before = Number((await owner.one(`select count(*) from hr.crm_contact`)).count);
    await page.fill('#P67_CRM_ID', '2');
    await page.click('button[data-button="LOOKUP"]');
    await page.locator('.alert-success', { hasText: 'Grace Hopper' }).waitFor({ timeout: 10000 });
    assert.match(await page.locator('[data-item="P67_CRM_FOUND"]').innerText(), /Grace Hopper, Compilers Inc\., grace@example\.com/);
    await page.click('button[data-button="COUNT"]');
    await page.locator('[data-item="P67_CRM_COUNT"]', { hasText: `${before} contacts` }).waitFor({ timeout: 10000 });
    // a contact that doesn't exist: the service's 404 is the answer
    await page.fill('#P67_CRM_ID', '999999');
    await page.click('button[data-button="LOOKUP"]');
    await page.getByText('No contact 999999 in the CRM (HTTP 404).').first().waitFor({ timeout: 10000 });
    assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
    await page.context().close();
  });
});
