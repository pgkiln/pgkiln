// Link columns, row actions and inline dialogs by static id in a real browser (sprint 238, MG-6 and MG-14; HR page 66):
// the report's links and ⋮ menu, a modal target as a dialog, a button and a link to #dept-note, the dialog shown again
// after an error inside it, after "Save and add another" (a process's open_region) and the branch's note-kept dialog;
// no CSP or axe-core violations; without JavaScript the dialog with the error is shown.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools } from '../../src/db.ts';

const AXE = readFileSync(new URL('../../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
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

async function open(javaScriptEnabled = true, width = 1280) {
  const context = await browser.newContext({ javaScriptEnabled, viewport: { width, height: 900 } });
  await context.addInitScript(() => {
    (window as any).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as any).__csp.push(`${e.violatedDirective}: ${e.blockedURI || e.sample || 'inline'}`));
  });
  const page = await context.newPage();
  await page.goto(`${base}/a/hr/login`);
  await page.fill('#username', 'king');
  await page.fill('#password', 'king');
  await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
  await page.goto(`${base}/a/hr/66`);
  return page;
}
const axe = async (page: Page) => {
  await page.evaluate(AXE);
  const r = await page.evaluate(() => (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }));
  return r.violations.map((v: { id: string; nodes: { html: string }[] }) => `${v.id}: ${v.nodes[0]?.html.slice(0, 160)}`);
};
const note = (page: Page) => page.locator('dialog[data-static-id="dept-note"]');
const kept = (page: Page) => page.locator('dialog[data-static-id="note-kept"]');
const isModal = (page: Page, sid: string) => page.evaluate((s) => document.querySelector(`dialog[data-static-id="${s}"]`)!.matches(':modal'), sid);

describe('link columns and row actions (HR page 66)', () => {
  test('the report\'s links, the ⋮ menu, a modal target as a dialog', async () => {
    const page = await open();
    const report = page.locator('[data-static-id="departments"]');
    assert.ok(await report.locator('a.btn-hot:has-text("Overview")').count() >= 4);
    assert.ok(await report.locator('a.btn-danger:has-text("Delete…")').count() >= 4);
    // the Employees button only where the department has staff (OPERATIONS has none)
    const ops = report.locator('tr', { hasText: 'OPERATIONS' });
    assert.equal(await ops.locator('a.btn:has-text("Employees")').count(), 0);
    assert.equal(await report.locator('tr', { hasText: 'ACCOUNTING' }).locator('a.btn:has-text("Employees")').count(), 1);
    assert.deepEqual(await axe(page), []);
    // the ⋮ menu
    const row = report.locator('tr', { hasText: 'RESEARCH' });
    await row.locator('.row-menu > summary').click();
    assert.equal(await row.locator('.row-menu a:has-text("Employees of RESEARCH")').isVisible(), true);
    assert.deepEqual(await axe(page), [], 'with the menu open');
    await row.locator('.row-menu > summary').click();
    // the icon link to the modal page 5 opens it as a dialog
    await row.locator('a.link-icon').click();
    await page.waitForSelector('dialog#t-dialog[open] iframe');
    const frame = page.frameLocator('dialog#t-dialog iframe');
    assert.equal(await frame.locator('#P5_DNAME').inputValue(), 'RESEARCH');
    assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
    await page.context().close();
  });

  test('the classic reports: a link column, and links under each entry of a media list', async () => {
    const page = await open();
    assert.equal(await page.locator('[data-static-id="locations"] td.link-col a:has-text("First department")').count(), 4);
    assert.equal(await page.locator('[data-static-id="department-cards"] .cr-links a.btn:has-text("Edit")').count(), 4);
    await page.context().close();
  });
});

describe('inline dialogs by static id (HR page 66)', () => {
  test('a button with target_region and a link to #dept-note open the dialog', async () => {
    const page = await open();
    assert.equal(await note(page).isVisible(), false);
    await page.click('a.btn:has-text("Add a note")');
    assert.equal(await note(page).isVisible(), true);
    assert.equal(await isModal(page, 'dept-note'), true);
    assert.deepEqual(await axe(page), [], 'with the dialog open');
    await note(page).locator('[data-region-close]').click();
    assert.equal(await note(page).isVisible(), false);
    await page.click('a[href="#dept-note"]');
    assert.equal(await note(page).isVisible(), true);
    await page.keyboard.press('Escape');
    assert.equal(await note(page).isVisible(), false);
    await page.context().close();
  });

  test('an error inside the dialog, "Save and add another" and the branch\'s dialog', async () => {
    const page = await open();
    await page.click('a.btn:has-text("Add a note")');
    // the note is required: the page comes back with the dialog open and the error in it
    await Promise.all([page.waitForNavigation(), note(page).locator('button:has-text("Save and add another")').click()]);
    assert.equal(await note(page).isVisible(), true);
    assert.equal(await isModal(page, 'dept-note'), true);
    assert.ok(await note(page).locator('.has-error, [aria-invalid="true"]').count() >= 1, 'the error shows in the dialog');
    assert.deepEqual(await axe(page), [], 'with the error in the dialog');
    // add another: the dialog comes back, empty
    await note(page).locator('textarea[name="P66_NOTE"]').fill('First note');
    await Promise.all([page.waitForNavigation(), note(page).locator('button:has-text("Save and add another")').click()]);
    assert.equal(await note(page).isVisible(), true);
    assert.equal(await note(page).locator('textarea[name="P66_NOTE"]').inputValue(), '');
    assert.equal(await kept(page).isVisible(), false);
    // Save: the branch opens the note-kept dialog
    await note(page).locator('textarea[name="P66_NOTE"]').fill('Second note');
    await Promise.all([page.waitForNavigation(), note(page).locator('button:has-text("Save")').last().click()]);
    assert.equal(await note(page).isVisible(), false);
    assert.equal(await kept(page).isVisible(), true);
    assert.match(await kept(page).innerText(), /Second note/);
    // a reload doesn't open it again
    await page.reload();
    assert.equal(await kept(page).isVisible(), false);
    assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
    await page.context().close();
  });

  test('without JavaScript: the dialog with the error is shown, and #R<id> of the button opens it', async () => {
    const page = await open(false);
    assert.equal(await note(page).isVisible(), false);
    const href = (await page.getAttribute('a.btn:has-text("Add a note")', 'href'))!;
    assert.match(href, /^#R\d+$/);
    await page.goto(`${base}/a/hr/66${href}`);
    assert.equal(await note(page).isVisible(), true);
    await Promise.all([page.waitForNavigation(), note(page).locator('button:has-text("Save")').last().click()]);
    assert.equal(await note(page).isVisible(), true, 'shown again with the error');
    await page.context().close();
  });

  test('at phone width the report\'s links and the dialog fit', async () => {
    const page = await open(true, 390);
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(width <= 391, `no horizontal scroll (${width})`);
    await page.click('a.btn:has-text("Add a note")');
    const box = (await note(page).boundingBox())!;
    assert.ok(box.x >= 0 && box.x + box.width <= 390, 'the dialog fits');
    await page.context().close();
  });
});
