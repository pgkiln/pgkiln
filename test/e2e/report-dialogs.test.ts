// Sprint 143 (AP-9; APEX 26.2) in a real browser, on HR page 2 (Employees): Actions → Filter with "is one of" ticked
// in the column's value list, "is between" two dates with the date picker, periods only for date columns; Actions →
// Columns with drag and drop and the arrow buttons (announced); without JavaScript the same dialogs work as forms.
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
let rid = 0;

before(async () => {
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  rid = (await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id join meta.app a on a.id = p.app_id
    where a.alias = 'hr' and p.page_no = 2 and r.type = 'report' order by r.seq limit 1`)).id;
  close = async () => {
    await browser.close();
    await app.close();
    await closePools();
  };
});
after(() => close());

async function open(o: { javaScriptEnabled?: boolean; width?: number } = {}) {
  const context = await browser.newContext({ javaScriptEnabled: o.javaScriptEnabled ?? true, viewport: { width: o.width ?? 1280, height: 900 } });
  await context.addInitScript(() => {
    (window as any).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as any).__csp.push(`${e.violatedDirective}: ${e.blockedURI || e.sample || 'inline'}`));
  });
  const page = await context.newPage();
  await page.goto(`${base}/a/hr/login`);
  await page.fill('#username', 'king');
  await page.fill('#password', 'king');
  await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
  await page.goto(`${base}/a/hr/2`);
  return page;
}
const R = () => `#R${rid}`;
const violations = (page: Page) => page.evaluate(() => (window as any).__csp as string[]);
const names = (page: Page) => page.locator(`${R()} tbody td[data-label="Name"]`).allTextContents();
const headings = (page: Page) => page.locator(`${R()} thead th[data-col]`).evaluateAll((ths) => ths.map((th) => th.getAttribute('data-col')));
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
async function dialog(page: Page, which: string) {
  await page.click(`${R()} .actions-menu > summary`);
  await page.click(`${R()} details[data-ir-dialog="${which}"] > summary`);
  return page.locator('dialog.ir-dialog');
}

describe('sprint 143: the report dialogs of 26.2', () => {
  test('is one of: the values with counts, ticked, in one filter', async () => {
    const page = await open();
    const dlg = await dialog(page, 'filter');
    await dlg.locator('select[data-filter-column]').selectOption('job');
    // a text column: no periods
    assert.equal(await dlg.locator('select[data-filter-op] option[value="period"]').isDisabled(), true);
    await dlg.locator('select[data-filter-op]').selectOption('in');
    const list = dlg.locator('.filter-values');
    await list.locator('input[type="checkbox"][value="CLERK"]').waitFor();
    assert.equal(await dlg.locator('input[name$="_fv2"]').isVisible(), false, 'no second value for a list');
    assert.match(await list.locator('label:has(input[value="CLERK"])').textContent() ?? '', /CLERK\s*4/);
    // the search narrows the list
    await list.locator('input[type="search"]').fill('analy');
    assert.equal(await list.locator('li:not([hidden])').count(), 1);
    await list.locator('input[value="ANALYST"]').check();
    await list.locator('input[type="search"]').fill('');
    await list.locator('input[value="CLERK"]').check();
    await Promise.all([page.waitForNavigation(), dlg.locator('button.btn-hot').click()]);
    const want = (await owner.query(`select ename from hr.emp where job in ('CLERK', 'ANALYST') order by 1`)).rows.map((r) => r.ename);
    assert.deepEqual((await names(page)).sort(), want);
    assert.match(await page.locator(`${R()} .chips`).textContent() ?? '', /Job is one of (ANALYST, CLERK|CLERK, ANALYST)/);
    assert.deepEqual(await violations(page), []);
  });

  test('is between two dates with the date picker; periods on a date column', async () => {
    const page = await open();
    const dlg = await dialog(page, 'filter');
    await dlg.locator('select[data-filter-column]').selectOption('hiredate');
    assert.equal(await dlg.locator('select[data-filter-op] option[value="period"]').isDisabled(), false);
    await dlg.locator('select[data-filter-op]').selectOption('between');
    const from = dlg.locator('input[name$="_fv"]');
    assert.equal(await from.getAttribute('data-date-mask'), 'YYYY-MM-DD');
    assert.equal(await dlg.locator(`[data-date-pick="r${rid}_fv"]`).isVisible(), true);
    // the picker writes the date into the field
    await from.fill('1981-02-01');
    await dlg.locator(`[data-date-pick="r${rid}_fv"]`).click();
    await dlg.locator('.date-picker button[data-iso="1981-02-20"]').click();
    assert.equal(await from.inputValue(), '1981-02-20');
    await dlg.locator('input[name$="_fv2"]').fill('1981-09-30');
    await Promise.all([page.waitForNavigation(), dlg.locator('button.btn-hot').click()]);
    const want = (await owner.query(`select ename from hr.emp where hiredate between '1981-02-20' and '1981-09-30' order by 1`)).rows.map((r) => r.ename);
    assert.ok(want.length > 1);
    assert.deepEqual((await names(page)).sort(), want);
    assert.match(await page.locator(`${R()} .chips`).textContent() ?? '', /is between 1981-02-20 and 1981-09-30/);
    // a period: the value fields give way to the list of periods
    const again = await dialog(page, 'filter');
    await again.locator('select[data-filter-column]').selectOption('hiredate');
    await again.locator('select[data-filter-op]').selectOption('period');
    assert.equal(await again.locator('input[name$="_fv"]').isVisible(), false);
    assert.equal(await again.locator('select[name$="_fpr"]').isVisible(), true);
    // choosing a text column moves a period back to "="
    await again.locator('select[data-filter-column]').selectOption('job');
    assert.equal(await again.locator('select[data-filter-op]').inputValue(), 'eq');
  });

  test('Columns: drag a column, move one with the arrows (announced), apply', async () => {
    const page = await open();
    const dlg = await dialog(page, 'columns');
    await dlg.locator('li[data-col-name="sal"]').dragTo(dlg.locator('li[data-col-name="ename"]'), { targetPosition: { x: 20, y: 2 } });
    assert.deepEqual(await dlg.locator('li[data-col-name]').evaluateAll((lis) => lis.map((li) => li.getAttribute('data-col-name'))),
      ['empno', 'sal', 'ename', 'job', 'department', 'hiredate', 'active']);
    // the arrows move without leaving the dialog, keep the focus and say where the column is now
    const up = dlg.locator('li[data-col-name="hiredate"] .ir-col-move button').first();
    await up.click();
    assert.equal(await page.evaluate(() => document.activeElement?.closest('li')?.getAttribute('data-col-name')), 'hiredate');
    assert.match(await dlg.locator('[data-col-status]').textContent() ?? '', /position 5 of 7/);
    assert.equal(await dlg.locator('li[data-col-name="empno"] .ir-col-move button').first().isDisabled(), true);
    await Promise.all([page.waitForNavigation(), dlg.locator('button.btn-hot').click()]);
    assert.deepEqual(await headings(page), ['empno', 'sal', 'ename', 'job', 'hiredate', 'department', 'active']);
    assert.match(await page.locator(`${R()} .chips`).textContent() ?? '', /Own column order/);
    // the chip puts them back
    await Promise.all([page.waitForNavigation(), page.locator(`${R()} .chips a[aria-label="Back to the report's column order"]`).click()]);
    assert.deepEqual((await headings(page)).slice(0, 3), ['empno', 'ename', 'job']);
    assert.deepEqual(await violations(page), []);
  });

  test('without JavaScript: a list typed with commas, a move with the arrow buttons', async () => {
    const page = await open({ javaScriptEnabled: false });
    await page.click(`${R()} .actions-menu > summary`);
    await page.click(`${R()} details[data-ir-dialog="filter"] > summary`);
    const body = page.locator(`${R()} details[data-ir-dialog="filter"] .ir-body`);
    await body.locator('select[name$="_fc"]').selectOption('job');
    await body.locator('select[name$="_fo"]').selectOption('in');
    await body.locator('input[name$="_fv"]').fill('PRESIDENT, MANAGER');
    await Promise.all([page.waitForNavigation(), body.locator('button.btn-hot').click()]);
    assert.equal((await names(page)).length, 4);
    await page.click(`${R()} .actions-menu > summary`);
    await page.click(`${R()} details[data-ir-dialog="columns"] > summary`);
    await Promise.all([page.waitForNavigation(), page.locator(`${R()} li[data-col-name="job"] .ir-col-move button`).first().click()]);
    assert.deepEqual((await headings(page)).slice(0, 3), ['empno', 'job', 'ename']);
    assert.equal((await names(page)).length, 4, 'the filter stays');
  });

  test('the dialogs fit a phone', async () => {
    const page = await open({ width: 390 });
    const dlg = await dialog(page, 'filter');
    await dlg.locator('select[data-filter-column]').selectOption('job');
    await dlg.locator('select[data-filter-op]').selectOption('in');
    await dlg.locator('.filter-values input[type="checkbox"]').first().waitFor();
    const box = await dlg.boundingBox();
    assert.ok(box && box.width <= 390, `${box?.width}`);
    assert.equal(await overflow(page), 0);
  });
});
