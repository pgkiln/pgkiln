// Sprint 31 page logic in a real browser (HR page 28): a "dialog closed"
// dynamic action refreshes a region instead of reloading the page and shows
// the dialog's message; a download process hands the browser a file; and
// without JavaScript the dialog link still works as a plain page.
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
let job = '';

before(async () => {
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  job = (await owner.one(`select job from hr.emp where empno = 7934`)).job;
  close = async () => {
    await owner.query(`update hr.emp set job = $1 where empno = 7934`, [job]);
    await browser.close();
    await app.close();
    await closePools();
  };
});
after(() => close());

async function open(javaScriptEnabled = true) {
  const context = await browser.newContext({ javaScriptEnabled, acceptDownloads: true });
  await context.addInitScript(() => {
    (window as any).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as any).__csp.push(`${e.violatedDirective}: ${e.blockedURI || e.sample || 'inline'}`));
  });
  const page = await context.newPage();
  await page.goto(`${base}/a/hr/login`);
  await page.fill('#username', 'king');
  await page.fill('#password', 'king');
  await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
  // the toolkit starts with your own employee: KING; MILLER (7934) is in his team
  await page.goto(`${base}/a/hr/28`);
  return page;
}

const violations = (page: Page) => page.evaluate(() => (window as any).__csp as string[]);
const team = (page: Page) => page.locator('.region', { has: page.locator('h2', { hasText: /^Team$/ }) });

describe('sprint 31 page logic', () => {
  test('dialog closed: saving the dialog refreshes the team region, the page is not reloaded', async () => {
    const page = await open();
    await team(page).locator('table a, .report-reflow a').filter({ hasText: /^Miller$/ }).first().waitFor();
    await page.evaluate(() => ((window as any).__marker = 'still here'));
    await team(page).locator('table a, .report-reflow a').filter({ hasText: /^Miller$/ }).first().click();
    const frame = page.frameLocator('#t-dialog iframe');
    await frame.locator('#P3_JOB').waitFor();
    await frame.locator('#P3_JOB').selectOption('ANALYST');
    await frame.locator('button.btn[value="SAVE"]').click();
    // the region shows the new job without a reload
    await team(page).getByText('Analyst', { exact: true }).first().waitFor({ timeout: 5000 });
    assert.equal(await page.evaluate(() => (window as any).__marker), 'still here', 'the page was not reloaded');
    assert.equal(await page.locator('#t-dialog[open]').count(), 0, 'the dialog is closed');
    // the dialog's success message comes along with the refresh
    await page.locator('.messages .alert-success').first().waitFor({ timeout: 5000 });
    assert.deepEqual(await violations(page), []);
    await page.context().close();
  });

  test('download: the business card button hands the browser a vCard file', async () => {
    const page = await open();
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('button.btn[value="CARD"]')]);
    assert.equal(download.suggestedFilename(), 'king.vcf');
    const stream = await download.createReadStream();
    let body = '';
    for await (const chunk of stream) body += chunk;
    assert.match(body, /^BEGIN:VCARD/);
    assert.deepEqual(await violations(page), []);
    await page.context().close();
  });

  test('without JavaScript the team link opens the dialog page as a normal page', async () => {
    const page = await open(false);
    await Promise.all([page.waitForNavigation(), team(page).locator('table a, .report-reflow a').filter({ hasText: /^Miller$/ }).first().click()]);
    assert.match(page.url(), /\/a\/hr\/3/);
    await page.locator('#P3_JOB').waitFor();
    await page.context().close();
  });
});
