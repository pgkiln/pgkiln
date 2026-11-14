// Sub regions in a real browser (sprint 195, NX-F2; HR page 53): a tabs container as ARIA tabs (arrow keys, Home,
// End, the tab remembered), a partial refresh of a sub region inside its tab, a flexbox container side by side on
// a laptop and one under the other at 360 px, the page without JavaScript (links and every panel), no CSP or axe
// violations; and a tabs container with a report and a form built by drag and drop in the Page Designer.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools, owner } from '../../src/db.ts';

const AXE = readFileSync(new URL('../../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
const PAGE_NO = 9195;
let base = '';
let browser: Browser;
let close: () => Promise<void>;
let hr = 0;
const R: Record<string, number> = {};

before(async () => {
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  hr = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  for (const r of (await owner.query(`select r.id, r.title from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 53`, [hr])).rows) R[r.title] = r.id;
  close = async () => {
    await owner.query('delete from meta.page where app_id = $1 and page_no = $2', [hr, PAGE_NO]);
    await browser.close();
    await app.close();
    await closePools();
  };
});
after(() => close());

async function open(width = 1280, javaScriptEnabled = true) {
  // sign in and choose a department with JavaScript, then look at the page as asked
  const first = await browser.newContext({ viewport: { width, height: 900 } });
  const p = await first.newPage();
  await p.goto(`${base}/a/hr/login`);
  await p.fill('#username', 'king');
  await p.fill('#password', 'king');
  await Promise.all([p.waitForNavigation(), p.click('button.btn-hot')]);
  await p.goto(`${base}/a/hr/53`);
  await Promise.all([p.waitForNavigation(), p.selectOption('#P53_DEPTNO', '20')]);
  const state = await first.storageState();
  await first.close();
  const context = await browser.newContext({ viewport: { width, height: 900 }, javaScriptEnabled, storageState: state });
  await context.addInitScript(() => {
    (window as any).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as any).__csp.push(`${e.violatedDirective}: ${e.blockedURI || e.sample || 'inline'}`));
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/a/hr/53`);
  return { page, errors };
}
const axe = async (page: Page, within?: string) => {
  await page.evaluate(AXE);
  const r = await page.evaluate((sel) => (window as any).axe.run(sel ? document.querySelector(sel) : document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }), within);
  return r.violations.map((v: { id: string; nodes: { html: string }[] }) => `${v.id}: ${v.nodes[0]?.html.slice(0, 160)}`);
};
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

describe('sub regions at run time (HR page 53)', () => {
  test('a tabs container is ARIA tabs: arrow keys, Home and End; a sub region refreshes inside its tab; the tab is remembered', async () => {
    const { page, errors } = await open();
    const box = page.locator(`[data-region-tabs="${R.Department}"]`);
    assert.equal(await box.locator('[role="tablist"]').count(), 1);
    const tabs = box.locator('[role="tab"]');
    assert.deepEqual(await tabs.allInnerTexts(), ['Employees', 'Edit department', 'Salaries by job', 'Administration']);
    const selected = async () => box.locator('[role="tab"][aria-selected="true"]').innerText();
    const visiblePanels = async () => box.locator('[role="tabpanel"]:visible').count();
    assert.equal(await selected(), 'Employees');
    assert.equal(await visiblePanels(), 1);
    assert.equal(await page.locator(`#R${R['Edit department']}`).isVisible(), false);
    assert.equal(await tabs.nth(1).getAttribute('tabindex'), '-1', 'one tab stop: the current tab');
    assert.deepEqual(await axe(page), []);
    // the keyboard
    await tabs.nth(0).focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await selected(), 'Edit department');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Edit department');
    assert.equal(await page.locator('#P53_DNAME').inputValue(), 'RESEARCH');
    // Save sits at the right end of the form's bottom bar (button position Next)
    const save = (await page.locator(`#R${R['Edit department']} .region-footer-end [data-button="SAVE"]`).boundingBox())!;
    const footer = (await page.locator(`#R${R['Edit department']} .region-footer`).boundingBox())!;
    assert.ok(save.x + save.width > footer.x + footer.width - 40, 'Save at the end of the bottom bar');
    await page.keyboard.press('End');
    assert.equal(await selected(), 'Administration');
    await page.keyboard.press('ArrowRight');
    assert.equal(await selected(), 'Employees', 'wraps around');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Home');
    assert.equal(await selected(), 'Employees');
    assert.equal(await visiblePanels(), 1);
    // Refresh replaces the report only: the tab stays, the report is there with its rows
    await page.evaluate((id) => (document.getElementById(`R${id}`)!.dataset.marker = 'old'), R.Employees);
    await Promise.all([page.waitForResponse((r) => r.url().includes('/da/')), page.click('[data-button="REFRESH_EMPLOYEES"]')]);
    await page.waitForFunction((id) => !document.getElementById(`R${id}`)?.dataset.marker, R.Employees);
    assert.equal(await selected(), 'Employees');
    assert.equal(await page.locator(`#R${R.Employees}`).isVisible(), true);
    assert.match(await page.locator(`#R${R.Employees}`).innerText(), /Smith/);
    // the tab chosen comes back on the next visit in this browser session
    await tabs.nth(2).click();
    await page.reload();
    assert.equal(await page.locator(`[data-region-tabs="${R.Department}"] [role="tab"][aria-selected="true"]`).innerText(), 'Salaries by job');
    assert.deepEqual(await axe(page), [], 'with another tab open');
    assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
    assert.deepEqual(errors, []);
    await page.context().close();
  });

  test('a flexbox container: side by side on a laptop, one under the other at 360 px; the tabs scroll, the page does not', async () => {
    const tops = async (page: Page) => Promise.all(['Headcount', 'Monthly salaries', 'Location'].map(async (t) => (await page.locator(`#R${R[t]}`).boundingBox())!));
    const wide = await open(1280);
    const w = await tops(wide.page);
    assert.ok(w.every((b) => Math.abs(b.y - w[0].y) < 2), 'one row');
    await wide.page.context().close();
    const phone = await open(360);
    const n = await tops(phone.page);
    assert.ok(n[1].y > n[0].y + n[0].height - 1 && n[2].y > n[1].y + n[1].height - 1, 'one under the other');
    assert.ok(await fits(phone.page), 'no horizontal scroll at 360 px');
    assert.deepEqual(await axe(phone.page, '.t-content'), [], 'the regions (the header\'s narrow user menu is checked by accessibility.test.ts)');
    // the last tab can be reached from the keyboard
    await phone.page.locator(`[data-region-tabs="${R.Department}"] [role="tab"]`).first().focus();
    await phone.page.keyboard.press('End');
    assert.equal(await phone.page.locator(`[data-region-tabs="${R.Department}"] [role="tab"][aria-selected="true"]`).isVisible(), true);
    assert.deepEqual(phone.errors, []);
    await phone.page.context().close();
  });

  test('without JavaScript: links to the sub regions, every panel shown, a heading for the plain ones', async () => {
    const { page } = await open(1280, false);
    const box = page.locator(`[data-region-tabs="${R.Department}"]`);
    assert.equal(await box.locator('[role="tab"]').count(), 0);
    assert.equal(await box.locator(`a.region-tab[href="#R${R['Edit department']}"]`).count(), 1);
    for (const t of ['Employees', 'Edit department', 'Salaries by job', 'Administration']) assert.equal(await page.locator(`#R${R[t]}`).isVisible(), true, t);
    assert.equal(await box.locator('h3.region-tabpanel-title').first().innerText(), 'Employees');
    assert.ok(await fits(page));
    await page.context().close();
  });
});

describe('sub regions in the Page Designer', () => {
  test('a tabs container with a report and a form inside, by drag and drop; it survives export and import', async () => {
    await owner.query('delete from meta.page where app_id = $1 and page_no = $2', [hr, PAGE_NO]);
    const pid = (await owner.one(`insert into meta.page (app_id, page_no, name) values ($1, $2, 'Sub regions test') returning id`, [hr, PAGE_NO])).id;
    const context = await browser.newContext({ viewport: { width: 1440, height: 1600 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${base}/builder/login`);
    await page.fill('#f_username', 'admin');
    await page.fill('#f_password', 'admin');
    await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
    await page.goto(`${base}/builder/apps/${hr}/pages/${PAGE_NO}`);
    const drop = async (type: string, target: string) => {
      await Promise.all([page.waitForNavigation(), page.dragAndDrop(`.pd-gal[data-new="region"][data-type="${type}"]`, target)]);
    };
    await drop('tabs_container', '.pd-zone-body > .pd-grid > .pd-grid-end');
    const tabs = (await owner.one(`select id from meta.region where page_id = $1 and template = 'tabs_container'`, [pid])).id;
    const slot = `.pd-subgrid[data-parent="${tabs}"] > .pd-grid-end`;
    assert.equal(await page.locator(slot).count(), 1, 'the container offers its Sub regions slot');
    await drop('report', slot);
    await drop('form', slot);
    const kids = (await owner.query('select type, template from meta.region where parent_id = $1 order by seq', [tabs])).rows;
    assert.deepEqual(kids, [{ type: 'report', template: 'plain' }, { type: 'form', template: 'plain' }]);
    // the layout and the tree show them inside the container
    assert.equal(await page.locator(`.pd-subgrid[data-parent="${tabs}"] > .pd-region`).count(), 2);
    assert.equal(await page.locator(`.pd-tree a.pd-node[data-parent="${tabs}"]`).count(), 2);
    // drag the form out of the container to the page, and back in before the report
    const form = (await owner.one(`select id from meta.region where parent_id = $1 and type = 'form'`, [tabs])).id;
    const report = (await owner.one(`select id from meta.region where parent_id = $1 and type = 'report'`, [tabs])).id;
    await Promise.all([page.waitForNavigation(), page.dragAndDrop(`.pd-region[data-id="${form}"] > .pd-region-head`, '.pd-zone-body > .pd-grid > .pd-grid-end')]);
    assert.equal((await owner.one('select parent_id from meta.region where id = $1', [form])).parent_id, null);
    await Promise.all([page.waitForNavigation(), page.dragAndDrop(`.pd-region[data-id="${form}"] > .pd-region-head`, `.pd-region[data-id="${report}"] > .pd-region-head`, { targetPosition: { x: 5, y: 5 } })]);
    assert.deepEqual((await owner.query('select id from meta.region where parent_id = $1 order by seq', [tabs])).rows.map((r) => r.id), [form, report]);
    assert.deepEqual(errors, []);
    // export and import keep the tree
    const doc = (await owner.one(`select meta.export_app('hr') as doc`)).doc;
    const exported = doc.pages.find((p: any) => p.page_no === PAGE_NO).regions;
    assert.deepEqual(exported.filter((r: any) => r.parent_id === tabs).map((r: any) => r.type), ['form', 'report']);
    await owner.query(`delete from meta.app where alias = 'e2e-s195'`);
    try {
      const copy = (await owner.one(`select meta.import_app($1::jsonb, 'e2e-s195') as id`, [JSON.stringify(doc)])).id;
      const rows = (await owner.query(`select c.type, p.template from meta.region c join meta.region p on p.id = c.parent_id join meta.page g on g.id = c.page_id
                                       where g.app_id = $1 and g.page_no = $2 order by c.seq`, [copy, PAGE_NO])).rows;
      assert.deepEqual(rows, [{ type: 'form', template: 'tabs_container' }, { type: 'report', template: 'tabs_container' }]);
    } finally {
      await owner.query(`delete from meta.app where alias = 'e2e-s195'`);
    }
    await context.close();
  });
});
