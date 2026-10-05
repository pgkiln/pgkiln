// The interactive grid (sprint 31) in a real browser, HR page 27: selecting a
// master row refreshes the detail regions in place, row action menus, moving
// and resizing columns (kept per user), frozen columns, copy and paste of
// cell ranges; and the same page without JavaScript.
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
const R: Record<string, number> = {};

before(async () => {
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  for (const r of (await owner.query(`select r.id, r.title from meta.region r join meta.page p on p.id = r.page_id join meta.app a on a.id = p.app_id
                                       where a.alias = 'hr' and p.page_no = 27`)).rows) R[r.title] = r.id;
  await owner.query(`delete from meta.saved_report where region_id = any($1)`, [Object.values(R)]);
  close = async () => {
    await owner.query(`delete from meta.saved_report where region_id = any($1)`, [Object.values(R)]);
    await browser.close();
    await app.close();
    await closePools();
  };
});
after(() => close());

async function open(javaScriptEnabled = true) {
  const context = await browser.newContext({ javaScriptEnabled, viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    (window as any).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as any).__csp.push(`${e.violatedDirective}: ${e.blockedURI || e.sample || 'inline'}`));
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  const page = await context.newPage();
  await page.goto(`${base}/a/hr/login`);
  await page.fill('#username', 'king');
  await page.fill('#password', 'king');
  await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
  await page.goto(`${base}/a/hr/27`);
  return page;
}

const violations = (page: Page) => page.evaluate(() => (window as any).__csp as string[]);
const staff = () => `#R${R.Staff}`;
const headers = (page: Page) => page.locator(`${staff()} thead th[data-col-name]`).evaluateAll((ths) => ths.map((th) => th.getAttribute('data-col-name')));

/** Select a department in the master grid (in place, with JavaScript). */
async function pick(page: Page, deptno: number) {
  const link = page.locator(`#R${R.Departments} a.grid-pick-link[href*="_sel=${deptno}&"]`);
  await Promise.all([page.waitForURL(new RegExp(`r${R.Departments}_sel=${deptno}&`)), link.click()]);
  await page.waitForFunction((id) => !document.querySelector(`#R${id}[aria-busy]`) && !!document.querySelector(`#R${id} table.grid-table`), R.Staff);
}

describe('interactive grid (HR page 27)', () => {
  test('selecting a master row refreshes the details without reloading the page', async () => {
    const page = await open();
    assert.match(await page.locator(staff()).innerText(), /Select a row above/);
    await page.evaluate(() => ((window as any).__marker = 1));
    await pick(page, 20);
    assert.equal(await page.evaluate(() => (window as any).__marker), 1, 'no reload');
    assert.match(page.url(), new RegExp(`r${R.Departments}_sel=20`));
    const names = (await owner.query(`select ename from hr.emp where deptno = 20`)).rows.map((x) => x.ename as string);
    const shown = await page.locator(`${staff()} table.grid-table > tbody:not(.grid-template) input[name$="_c1"]`).evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
    assert.deepEqual(shown.sort(), names.sort());
    assert.match(await page.locator(`#R${R['Jobs in the department']}`).innerText(), /Analyst/);
    assert.equal(await page.locator(`#R${R.Departments} tr.is-selected`).count(), 1);
    // the footer: totals over the department
    assert.match(await page.locator(`${staff()} tfoot`).innerText(), /Sum: [\d.,]+/);
    // another department
    await pick(page, 30);
    assert.equal(await page.locator(`${staff()} table.grid-table > tbody:not(.grid-template) tr[data-row]`).count(), Number((await owner.one(`select count(*) from hr.emp where deptno = 30`)).count));
    // the selection stays after a reload
    await page.reload();
    assert.equal(await page.locator(`#R${R.Departments} tr.is-selected a[href*="_sel=30&"]`).count(), 1);
    assert.deepEqual(await violations(page), []);
    await page.context().close();
  });

  test('the first column is frozen; dragging and resizing a column is kept for the user', async () => {
    const page = await open();
    await pick(page, 20);
    const name = page.locator(`${staff()} thead th[data-col-name="ename"]`);
    assert.equal(await name.evaluate((th) => getComputedStyle(th).position), 'sticky');
    assert.deepEqual((await headers(page)).slice(0, 3), ['ename', 'job', 'sal']);
    // drag "sal" before "job"
    const saved = page.waitForResponse((r) => r.url().endsWith(`/grid/${R.Staff}/layout`) && r.request().method() === 'POST');
    await page.locator(`${staff()} thead th[data-col-name="sal"]`).dragTo(page.locator(`${staff()} thead th[data-col-name="job"]`), { targetPosition: { x: 3, y: 5 } });
    assert.equal((await saved).status(), 200);
    assert.deepEqual((await headers(page)).slice(0, 3), ['ename', 'sal', 'job']);
    // the cells moved with their header
    const firstRow = page.locator(`${staff()} table.grid-table > tbody:not(.grid-template) tr[data-row="0"] td[data-col]`);
    assert.equal(await firstRow.nth(1).getAttribute('data-col'), await page.locator(`${staff()} thead th[data-col-name="sal"]`).getAttribute('data-col'));
    // resize "job" by dragging its handle
    const handle = page.locator(`${staff()} thead th[data-col-name="job"] .grid-resize`);
    const box = (await handle.boundingBox())!;
    const before = await page.locator(`${staff()} thead th[data-col-name="job"]`).evaluate((th) => (th as HTMLElement).offsetWidth);
    const resized = page.waitForResponse((r) => r.url().endsWith(`/grid/${R.Staff}/layout`));
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    assert.equal((await resized).status(), 200);
    const width = Number(await page.locator(`${staff()} thead th[data-col-name="job"]`).getAttribute('data-width'));
    assert.ok(Math.abs(width - (before + 60)) <= 3, `width ${width}, was ${before}`);
    // after a reload the layout is the user's
    await page.reload();
    assert.deepEqual((await headers(page)).slice(0, 3), ['ename', 'sal', 'job']);
    assert.equal(await page.locator(`${staff()} thead th[data-col-name="job"]`).getAttribute('data-width'), String(width));
    // Actions → Columns → Reset
    await page.click(`${staff()} .grid-actions-menu > summary`);
    await Promise.all([page.waitForNavigation(), page.click(`button[form="rr${R.Staff}"]`)]);
    assert.deepEqual((await headers(page)).slice(0, 3), ['ename', 'job', 'sal']);
    assert.deepEqual(await violations(page), []);
    await page.context().close();
  });

  test('a row actions menu: duplicate makes a new row, delete marks the row', async () => {
    const page = await open();
    await pick(page, 20);
    const row = page.locator(`${staff()} table.grid-table > tbody:not(.grid-template) tr[data-row="1"]`);
    const ename = await row.locator('input[name$="_c1"]').inputValue();
    await row.locator('.row-menu > summary').click();
    const panel = row.locator('.row-menu .menu-panel');
    assert.equal(await panel.isVisible(), true);
    assert.equal(await panel.locator('a', { hasText: 'Show employee' }).count(), 1);
    await panel.locator('[data-grid-dup]').click();
    const added = page.locator(`${staff()} table.grid-table > tbody:not(.grid-template) tr.grid-new`);
    assert.equal(await added.count(), 1);
    assert.equal(await added.locator('input[name$="_c1"]').inputValue(), ename);
    assert.equal(await row.locator('.row-menu').getAttribute('open'), null, 'the menu closed');
    await row.locator('.row-menu > summary').click();
    await panel.locator('[data-grid-del]').click();
    assert.match((await row.getAttribute('class')) ?? '', /deleted/);
    assert.deepEqual(await violations(page), []);
    await page.context().close();
  });

  test('copy a range of cells and paste it into other rows; the grid save stores it', async () => {
    const page = await open();
    await pick(page, 40);
    // department 40 has no staff: paste two new rows (name, job) from a spreadsheet
    await page.click(`${staff()} [data-grid-add]`);
    const first = page.locator(`${staff()} table.grid-table > tbody:not(.grid-template) tr.grid-new input[name$="_c1"]`).first();
    await first.focus();
    await page.evaluate(({ sel }) => {
      const el = document.querySelector(sel)!;
      const data = new DataTransfer();
      data.setData('text/plain', 'PASTEONE\tClerk\r\nPASTETWO\tAnalyst\r\n');
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, { sel: `${staff()} table.grid-table > tbody:not(.grid-template) tr.grid-new input[name$="_c1"]` });
    const news = page.locator(`${staff()} table.grid-table > tbody:not(.grid-template) tr.grid-new`);
    assert.equal(await news.count(), 2, 'a row was added for the second line');
    assert.equal(await news.nth(1).locator('input[name$="_c1"]').inputValue(), 'PASTETWO');
    assert.equal(await news.nth(0).locator('select[name$="_c2"]').inputValue(), 'CLERK');
    assert.equal(await news.nth(1).locator('select[name$="_c2"]').inputValue(), 'ANALYST');
    // copy: shift+click selects a range, the copy event carries tab-separated text
    await news.nth(0).locator('td[data-col="1"]').click();
    await news.nth(1).locator('td[data-col="2"]').click({ modifiers: ['Shift'] });
    assert.equal(await page.locator(`${staff()} td.grid-cell-selected`).count(), 4);
    const copied = await page.evaluate((sel) => {
      const data = new DataTransfer();
      document.querySelector(sel)!.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
      return data.getData('text/plain');
    }, `${staff()} td.grid-cell-selected`);
    assert.equal(copied, 'PASTEONE\tClerk\r\nPASTETWO\tAnalyst');
    try {
      await Promise.all([page.waitForNavigation(), page.click(`${staff()} button[value="GRID_SAVE_${R.Staff}"]`)]);
      const rows = (await owner.query(`select ename, job, deptno from hr.emp where ename like 'PASTE%' order by ename`)).rows;
      assert.deepEqual(rows, [{ ename: 'PASTEONE', job: 'CLERK', deptno: 40 }, { ename: 'PASTETWO', job: 'ANALYST', deptno: 40 }]);
      assert.deepEqual(await violations(page), []);
    } finally {
      await owner.query(`delete from hr.emp where ename like 'PASTE%'`);
    }
    await page.context().close();
  });

  test('without JavaScript: the select link reloads the page, the Columns form arranges the grid', async () => {
    const page = await open(false);
    await Promise.all([page.waitForNavigation(), page.locator(`#R${R.Departments} a.grid-pick-link[href*="_sel=20&"]`).click()]);
    assert.ok(await page.locator(`${staff()} tbody tr[data-row]`).count() > 0);
    // the Actions menu is a <details>: open it, hide the salary column
    await page.click(`${staff()} .grid-actions-menu > summary`);
    const form = `rl${R.Staff}`;
    const idx = await page.locator(`input[form="${form}"][name^="col_"][value="sal"]`).getAttribute('name');
    await page.uncheck(`input[form="${form}"][name="show_${idx!.slice(4)}"]`);
    await Promise.all([page.waitForNavigation(), page.click(`button[form="${form}"].btn-hot`)]);
    assert.equal(await page.locator(`${staff()} thead th[data-col-name="sal"]`).isHidden(), true);
    await page.click(`${staff()} .grid-actions-menu > summary`);
    await Promise.all([page.waitForNavigation(), page.click(`button[form="rr${R.Staff}"]`)]);
    assert.equal(await page.locator(`${staff()} thead th[data-col-name="sal"]`).isVisible(), true);
    await page.context().close();
  });
});
