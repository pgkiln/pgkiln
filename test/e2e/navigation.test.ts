// Back to the calling page and a dialog that sends the page below elsewhere, in a real browser (sprint 249, MG-22,
// MG-23, MG-27; HR part 113): Departments (page 4) → "Find an employee" opens the modal page 76 → "Open the profile"
// closes the dialog and the page below shows Employee profiles (page 51) with that employee → "Back to page 4"
// (a button label with &APP_PREVIOUS_PAGE.) goes back to Departments; the same from Employees (page 2) goes back
// there, with the department filter it had. No CSP violations.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools } from '../../src/db.ts';

let base = '';
let browser: Browser;
let close: () => Promise<void>;

before(async () => {
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  close = async () => {
    await browser.close();
    await app.close();
    await closePools();
  };
});
after(() => close());

async function signIn() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
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

/** Find an employee in the dialog and open the profile in the page below. */
async function findAndOpen(page: Page, name: string) {
  await page.click('a.btn:has-text("Find an employee")');
  await page.waitForSelector('dialog#t-dialog[open] iframe');
  const frame = page.frameLocator('dialog#t-dialog iframe');
  await frame.locator('#P76_EMPNO').selectOption({ label: name });
  await Promise.all([page.waitForURL(/\/a\/hr\/51\?P51_EMPNO=\d+&cs=/), frame.locator('button:has-text("Open the profile")').click()]);
  assert.equal(await page.locator('dialog#t-dialog[open]').count(), 0, 'the dialog closed');
}

describe('back to the calling page, a dialog branch in the page below (HR part 113)', () => {
  test('Departments → dialog → profile in the page below → back to Departments', async () => {
    const page = await signIn();
    await page.goto(`${base}/a/hr/4`);
    await findAndOpen(page, 'Allen');
    assert.equal(await page.locator('#P51_TITLE').count(), 1, 'the profile form of the employee');
    const back = page.locator('button:has-text("Back to page 4")');
    assert.equal(await back.count(), 1, 'the label names the page the user came from');
    await Promise.all([page.waitForURL(`${base}/a/hr/4`), back.click()]);
    assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
    await page.context().close();
  });

  test('from Employees with a department chosen: back there, the filter kept', async () => {
    const page = await signIn();
    await page.goto(`${base}/a/hr/2`);
    const deptno = page.locator('#P2_DEPTNO');
    const value = await deptno.locator('option').nth(1).getAttribute('value');
    await Promise.all([page.waitForLoadState('load'), deptno.selectOption(value!)]);
    await page.waitForLoadState('networkidle');
    await findAndOpen(page, 'King');
    await Promise.all([page.waitForURL(/\/a\/hr\/2(\?|$)/), page.locator('button:has-text("Back to page 2")').click()]);
    assert.equal(await page.locator('#P2_DEPTNO').inputValue(), value);
    assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
    await page.context().close();
  });
});
