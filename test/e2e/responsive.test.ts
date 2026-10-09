// Browser tests: every application and builder page must fit phone, tablet
// and desktop widths without horizontal page scrolling, and the key
// interactions must work on touch-sized screens.
//   npx playwright install chromium   (once)
//   npm run test:e2e                  (SCREENSHOTS=1 saves them to test-results/)
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools, owner } from '../../src/db.ts';
import { createCopy } from '../../src/workingcopy.ts';
import { subscribe } from '../../src/subscriptions.ts';
import { workbook } from '../xlsxbook.ts';

export const VIEWPORTS = {
  phone: { width: 390, height: 844 },
  'tablet-portrait': { width: 768, height: 1024 },
  'tablet-landscape': { width: 1024, height: 768 },
  desktop: { width: 1440, height: 900 },
} as const;

let base = '';
let browser: Browser;
let close: () => Promise<void>;
const shots = process.env.SCREENSHOTS === '1';
if (shots) mkdirSync('test-results', { recursive: true });

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
after(async () => close());

async function login(page: Page, url: string, user: string, password: string, userField = '#username', passField = '#password') {
  await page.goto(`${base}${url}`);
  await page.fill(userField, user);
  await page.fill(passField, password);
  await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
}

/** Widest element sticking out of the viewport, for a helpful failure message. */
/** A browser context that records Content-Security-Policy violations (checked in check()). */
async function newContext(options: Parameters<Browser['newContext']>[0]) {
  const context = await browser.newContext(options);
  await context.addInitScript(() => {
    (window as any).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as any).__csp.push(`${e.violatedDirective}: ${e.blockedURI || e.sample || 'inline'}`));
  });
  return context;
}

async function overflow(page: Page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth <= vw + 1) return null;
    let worst: { tag: string; cls: string; right: number } | null = null;
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width && r.right > vw + 1 && (!worst || r.right > worst.right)) worst = { tag: el.tagName, cls: el.className?.toString?.() ?? '', right: Math.round(r.right) };
    }
    return { scrollWidth: document.documentElement.scrollWidth, vw, worst };
  });
}

async function check(page: Page, name: string, vp: string) {
  if (shots) await page.screenshot({ path: `test-results/${vp}-${name}.png`, fullPage: true });
  const csp = await page.evaluate(() => (window as any).__csp ?? []);
  assert.deepEqual(csp, [], `${name} violates the Content-Security-Policy at ${vp}`);
  const o = await overflow(page);
  assert.equal(o, null, `${name} overflows at ${vp}: ${JSON.stringify(o)}`);
}

for (const [vp, size] of Object.entries(VIEWPORTS)) {
  describe(`${vp} (${size.width}px)`, () => {
    test('application pages fit the screen', async () => {
      const page = await (await newContext({ viewport: size })).newPage();
      await login(page, '/a/hr/login', 'king', 'king');
      const pages = (await owner.query(`select p.page_no from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.mode = 'normal' order by 1`)).rows;
      for (const { page_no: p } of pages) {
        const res = await page.goto(`${base}/a/hr/${p}`);
        assert.equal(res?.status(), 200, `page ${p}`);
        await check(page, `app-${p}`, vp);
      }
      // the Iris base style (the default for new applications): same layout, its own colours
      await owner.query(`update meta.app set theme = theme || '{"base": "iris"}' where alias = 'hr'`);
      try {
        for (const p of [1, 2, 3]) {
          await page.goto(`${base}/a/hr/${p}`);
          assert.equal(await page.getAttribute('html', 'data-style'), 'iris');
          assert.equal((await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--radius'))).trim(), '12px');
          await check(page, `app-${p}-iris`, vp);
        }
      } finally {
        await owner.query(`update meta.app set theme = theme - 'base' where alias = 'hr'`);
      }
      // a review on page 20: the rich text and Markdown editors, tags, stars, date range and QR code
      await page.goto(`${base}/a/hr/20`);
      await Promise.all([page.waitForNavigation(), page.locator('table a', { hasText: /^\d+$/ }).first().click()]);
      await page.locator('svg.qr-code').waitFor();
      await check(page, 'app-20-review', vp);
      // the report's Actions menu fits
      await page.goto(`${base}/a/hr/2`);
      await page.click('summary:has-text("Actions")');
      await check(page, 'app-2-actions', vp);
      // the other report views: a computed column, group by, pivot and chart
      const rid = (await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 2 and r.type = 'report'`)).id;
      const views: Record<string, [string, string][]> = {
        compute: [['c', 'Year pay|sal * 12']],
        group: [['g', 'department'], ['g', 'job'], ['ga', 'sum|sal'], ['ga', 'avg|sal'], ['v', 'group']],
        pivot: [['pv', 'department|job|sum|sal'], ['v', 'pivot']],
        chart: [['ch', 'column|job|sum|sal'], ['v', 'chart']],
      };
      for (const [name, params] of Object.entries(views)) {
        const res = await page.goto(`${base}/a/hr/2?${new URLSearchParams(params.map(([k, v]) => [`r${rid}_${k}`, v]))}`);
        assert.equal(res?.status(), 200, name);
        assert.equal(await page.locator('.alert-error').count(), 0, `${name}: no errors`);
        await check(page, `app-2-${name}`, vp);
      }
      // the planner's calendar views (page 24; the week view is its first, already checked above)
      const cal = (await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 24 and r.type = 'calendar'`)).id;
      for (const v of ['month', 'day', 'list']) {
        const res = await page.goto(`${base}/a/hr/24?r${cal}_v=${v}`);
        assert.equal(res?.status(), 200, `calendar ${v}`);
        await check(page, `app-24-${v}`, vp);
      }
      // page 27: the interactive grid with a selected master row, a row actions menu and its Actions menu
      const masterId = (await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 27 and r.title = 'Departments'`)).id;
      await page.goto(`${base}/a/hr/27`);
      await Promise.all([page.waitForURL(new RegExp(`r${masterId}_sel=20&`)), page.locator(`#R${masterId} a.grid-pick-link[href*="_sel=20&"]`).click()]);
      await page.locator('.region-grid:not([aria-busy]) tr[data-row] .row-menu').first().waitFor();
      await check(page, 'app-27-selected', vp);
      await page.locator('.region-grid tr[data-row] .row-menu > summary').last().click();
      await check(page, 'app-27-row-menu', vp);
      await page.locator('.region-grid .grid-actions-menu > summary').last().click();
      await check(page, 'app-27-actions', vp);
      // row selection: select all checks every row
      const before = (await owner.one('select config from meta.region where id = $1', [rid])).config;
      const pageId = (await owner.one('select page_id from meta.region where id = $1', [rid])).page_id;
      await owner.query(`insert into meta.item (page_id, name, type) values ($1, 'P2_SELECTED', 'hidden')`, [pageId]);
      await owner.query('update meta.region set config = config || $2 where id = $1', [rid, JSON.stringify({ selection: { column: 'empno', item: 'P2_SELECTED' } })]);
      try {
        await page.goto(`${base}/a/hr/2`);
        await page.locator('[data-select-all]').check();
        const boxes = page.locator('input[name="P2_SELECTED"]');
        assert.ok((await boxes.count()) > 0);
        assert.equal(await page.locator('input[name="P2_SELECTED"]:not(:checked)').count(), 0, 'all rows checked');
        await check(page, 'app-2-selection', vp);
      } finally {
        await owner.query('update meta.region set config = $2 where id = $1', [rid, JSON.stringify(before)]);
        await owner.query(`delete from meta.item where page_id = $1 and name = 'P2_SELECTED'`, [pageId]);
      }
      await page.context().close();
    });

    test('page 21: display selector tabs, smart filters and range facets', async () => {
      const ids = Object.fromEntries((await owner.query(`select r.title, r.id from meta.region r join meta.page p on p.id = r.page_id join meta.app a on a.id = p.app_id
                                                          where a.alias = 'hr' and p.page_no = 21`)).rows.map((r) => [r.title, r.id]));
      const page = await (await newContext({ viewport: size })).newPage();
      await login(page, '/a/hr/login', 'king', 'king');
      await page.goto(`${base}/a/hr/21`);
      await page.evaluate(() => sessionStorage.clear());
      await page.goto(`${base}/a/hr/21`);
      // JavaScript turns the links into tabs; "Show all" is first and shows everything
      assert.equal(await page.locator('.rds-list[role="tablist"] [role="tab"]').count(), 4);
      assert.equal(await page.locator('.rds-hidden').count(), 0);
      await page.click('.rds-tab:has-text("Faceted search")');
      assert.equal(await page.locator(`#R${ids['Employee list']}`).isVisible(), true);
      assert.equal(await page.locator(`#R${ids['Employees']}`).isVisible(), false, 'the other tab is hidden');
      assert.equal(await page.locator('.rds-tab:has-text("Faceted search")').getAttribute('aria-selected'), 'true');
      await check(page, 'app-21-facets', vp);
      // arrow keys move between tabs
      await page.keyboard.press('ArrowRight');
      assert.equal(await page.locator(`#R${ids['Average salary by job']}`).isVisible(), true);
      // the choice is remembered; a predefined range applies on change
      await page.goto(`${base}/a/hr/21`);
      assert.equal(await page.locator(`#R${ids['Average salary by job']}`).isVisible(), true, 'remembered');
      await page.click('.rds-tab:has-text("Faceted search")');
      await Promise.all([page.waitForNavigation(), page.locator(`#R${ids['Filter']} input[type="radio"][value="3000|"]`).check()]);
      assert.equal(await page.locator(`#R${ids['Employee list']} tbody tr`).count(), 3);
      assert.equal(await page.locator(`#R${ids['Employee list']}`).isVisible(), true, 'the tab stays after the reload');
      // smart filters: a suggestion becomes a chip
      await page.click('.rds-tab:has-text("Smart filters")');
      await Promise.all([page.waitForNavigation(), page.click(`#R${ids['Find employees']} .chip-suggest >> nth=0`)]);
      assert.equal(await page.locator(`#R${ids['Find employees']} .sf-chip`).count(), 1);
      await check(page, 'app-21-smart', vp);
      await page.context().close();
    });

    test('page 25: lazy regions load after the page shows; without JavaScript a link shows them', async () => {
      const ids = Object.fromEntries((await owner.query(`select r.title, r.id from meta.region r join meta.page p on p.id = r.page_id join meta.app a on a.id = p.app_id
                                                          where a.alias = 'hr' and p.page_no = 25`)).rows.map((r) => [r.title, r.id]));
      const page = await (await newContext({ viewport: size })).newPage();
      await login(page, '/a/hr/login', 'king', 'king');
      await page.goto(`${base}/a/hr/25`);
      await page.waitForFunction(() => !document.querySelector('[data-lazy]'));
      assert.equal(await page.locator(`#R${ids['Readings of sensor A']} table.report tbody tr`).count(), 10);
      assert.equal(await page.locator(`#R${ids['Average per sensor']} .bar-row`).count(), 8);
      // the lazy report's search box works (its form came along)
      await page.fill(`#R${ids['Readings of sensor A']} input[type="search"]`, '23');
      await Promise.all([page.waitForNavigation(), page.press(`#R${ids['Readings of sensor A']} input[type="search"]`, 'Enter')]);
      await page.waitForFunction(() => !document.querySelector('[data-lazy]'));
      assert.match(page.url(), new RegExp(`r${ids['Readings of sensor A']}_q=23`));
      await check(page, 'app-25-large', vp);
      await page.context().close();
      const plain = await browser.newContext({ viewport: size, javaScriptEnabled: false });
      const nojs = await plain.newPage();
      await login(nojs, '/a/hr/login', 'king', 'king');
      await nojs.goto(`${base}/a/hr/25`);
      const show = nojs.locator(`#R${ids['Readings of sensor A']} .region-lazy-link`);
      assert.equal(await show.isVisible(), true);
      await Promise.all([nojs.waitForNavigation(), show.click()]);
      assert.equal(await nojs.locator(`#R${ids['Readings of sensor A']} table.report tbody tr`).count(), 10);
      await plain.close();
    });

    test('a refreshed chart region brings its styles through the CSSOM', async () => {
      const r = await owner.one(`select r.id, r.page_id from meta.region r join meta.page p on p.id = r.page_id join meta.app a on a.id = p.app_id
                                  where a.alias = 'hr' and p.page_no = 1 and r.type = 'chart' order by r.seq, r.id limit 1`);
      const da = await owner.one(`insert into meta.dynamic_action (page_id, name, event, action, affected_region_id) values ($1, 'e2e refresh', 'load', 'refresh_region', $2) returning id`, [r.page_id, r.id]);
      try {
        const page = await (await newContext({ viewport: size })).newPage();
        await login(page, '/a/hr/login', 'king', 'king');
        const done = page.waitForResponse((res) => res.url().includes(`/da/${da.id}`));
        await page.goto(`${base}/a/hr/1`);
        await done;
        await page.waitForTimeout(200);
        const { inline, rules, height } = await page.evaluate((id) => {
          const el = document.getElementById('pgkiln-css') as HTMLStyleElement;
          const col = document.querySelector(`#R${id} .col`) as HTMLElement;
          return { inline: el.textContent!.split('\n').filter(Boolean).length, rules: el.sheet!.cssRules.length, height: col.getBoundingClientRect().height };
        }, r.id);
        assert.ok(rules > inline, `the refresh added rules (${rules} > ${inline})`);
        assert.ok(height > 0, 'the refreshed columns have their height');
        await check(page, 'app-1-refreshed', vp);
        await page.context().close();
      } finally {
        await owner.query('delete from meta.dynamic_action where id = $1', [da.id]);
      }
    });

    test('project plan (page 32): Gantt bars and dependencies line up with their rows; pyramid and polar draw', async () => {
      const page = await (await newContext({ viewport: size })).newPage();
      await login(page, '/a/hr/login', 'king', 'king');
      const res = await page.goto(`${base}/a/hr/32`);
      assert.equal(res?.status(), 200);
      const g = await page.evaluate(() => {
        const chart = document.querySelector('.chart-gantt')!;
        const labels = [...chart.querySelectorAll('.gantt-labels li')].map((li) => li.getBoundingClientRect());
        const lanes = [...chart.querySelectorAll('.gantt-lane')].map((l) => l.getBoundingClientRect());
        const bar = chart.querySelector('.gantt-bar')!.getBoundingClientRect();
        const deps = chart.querySelector('.gantt-deps')!.getBoundingClientRect();
        const plot = chart.querySelector('.gantt-plot')!.getBoundingClientRect();
        return { offsets: labels.map((l, i) => Math.abs(l.top - lanes[i].top)), bar: bar.width, depsH: deps.height, plotH: plot.height };
      });
      assert.ok(g.offsets.every((d) => d < 1), `labels and lanes share their rows: ${g.offsets}`);
      assert.ok(g.bar > 4, 'a bar has a width');
      assert.ok(Math.abs(g.depsH - g.plotH) < 1, 'the dependency layer covers the rows');
      assert.ok((await page.locator('.chart-pyramid .pyramid-seg').count()) >= 3);
      assert.ok((await page.locator('.chart-polar .polar-sector').count()) >= 3);
      await page.locator('.chart-gantt .gantt-bar').first().hover();
      await check(page, 'app-32-charts', vp);
      await page.context().close();
    });

    test('contacts (page 34): a grid and a form on a REST data source read and write the service', async () => {
      const env = { allowed: process.env.PGKILN_REST_ALLOWED_HOSTS, priv: process.env.PGKILN_REST_PRIVATE_HOSTS };
      process.env.PGKILN_REST_ALLOWED_HOSTS = '127.0.0.1';
      process.env.PGKILN_REST_PRIVATE_HOSTS = '127.0.0.1';
      const url = (await owner.one(`select s.url from meta.rest_source s join meta.app a on a.id = s.app_id where a.alias = 'hr' and s.name = 'CRM_CONTACTS'`)).url;
      await owner.query(`update meta.rest_source s set url = $1 from meta.app a where a.id = s.app_id and a.alias = 'hr' and s.name = 'CRM_CONTACTS'`, [`${base}/a/hr/rest/crm/contacts`]);
      const page = await (await newContext({ viewport: size })).newPage();
      try {
        await login(page, '/a/hr/login', 'king', 'king');
        const res = await page.goto(`${base}/a/hr/34`);
        assert.equal(res?.status(), 200);
        assert.equal(await page.locator('.region-grid .alert-error').count(), 0);
        assert.ok((await page.locator('.region-grid tr[data-row]').count()) >= 4, 'the contacts of the service');
        await check(page, 'app-34-rest-grid', vp);
        // the form: a new contact through the service's POST, then its row is fetched
        const name = `E2E ${vp}`;
        await page.fill('#P34_NAME', name);
        await page.fill('#P34_COMPANY', 'Playwright');
        await Promise.all([page.waitForNavigation(), page.click('button[data-button="CREATE"]')]);
        assert.equal(await page.inputValue('#P34_NAME'), name);
        assert.ok(await owner.one(`select 1 from hr.crm_contact where name = $1`, [name]));
        await check(page, 'app-34-rest-form', vp);
      } finally {
        await owner.query(`delete from hr.crm_contact where name like 'E2E %'`);
        await owner.query(`update meta.rest_source s set url = $1 from meta.app a where a.id = s.app_id and a.alias = 'hr' and s.name = 'CRM_CONTACTS'`, [url]);
        for (const [k, v] of [['PGKILN_REST_ALLOWED_HOSTS', env.allowed], ['PGKILN_REST_PRIVATE_HOSTS', env.priv]] as const)
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        await page.context().close();
      }
    });

    test('parse and fetch (page 35): the parsed file and the response of a web request from SQL', async () => {
      const env = { allowed: process.env.PGKILN_REST_ALLOWED_HOSTS, priv: process.env.PGKILN_REST_PRIVATE_HOSTS, url: process.env.PUBLIC_URL };
      process.env.PGKILN_REST_ALLOWED_HOSTS = '127.0.0.1';
      process.env.PGKILN_REST_PRIVATE_HOSTS = '127.0.0.1';
      process.env.PUBLIC_URL = base;
      const page = await (await newContext({ viewport: size })).newPage();
      try {
        await login(page, '/a/hr/login', 'king', 'king');
        const res = await page.goto(`${base}/a/hr/35`);
        assert.equal(res?.status(), 200);
        assert.ok((await page.locator('table.report td, .report-reflow td').filter({ hasText: 'hire_date' }).count()) >= 1, 'the columns of the sample file');
        await Promise.all([page.waitForNavigation(), page.click('button[data-button="FETCH"]')]);
        assert.match(await page.locator('body').innerText(), /HTTP 200/);
        assert.equal(await page.locator('.alert-error').count(), 0);
        await check(page, 'app-35-fetched', vp);
      } finally {
        for (const [k, v] of [['PGKILN_REST_ALLOWED_HOSTS', env.allowed], ['PGKILN_REST_PRIVATE_HOSTS', env.priv], ['PUBLIC_URL', env.url]] as const)
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        await page.context().close();
      }
    });

    test('data reporter (page 36): a saved report with its chart, and a new report with the editor open', async () => {
      const page = await (await newContext({ viewport: size })).newPage();
      await login(page, '/a/hr/login', 'king', 'king');
      const r = await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 36 and r.type = 'data_reporter'`);
      const saved = (await owner.one(`select id from meta.data_report where region_id = $1 and name = 'Salary by department'`, [r.id])).id;
      await page.goto(`${base}/a/hr/36?dr${r.id}_open=${saved}`);
      assert.equal(await page.locator('.reporter figure.chart').count(), 1);
      await check(page, 'app-36-saved', vp);
      // the editor without JavaScript-only parts: pick the source, open the editor, filter and run
      await page.goto(`${base}/a/hr/36`);
      await Promise.all([page.waitForNavigation(), page.locator('.reporter-new button').click()]);
      await page.locator(`select[name="dr${r.id}_fc"]`).first().selectOption('job');
      await page.locator(`input[name="dr${r.id}_fv"]`).first().fill('CLERK');
      await Promise.all([page.waitForNavigation(), page.locator('.reporter-editor button.btn-hot').click()]);
      assert.equal(await page.locator('.reporter-table tbody tr').count(), 4);
      await check(page, 'app-36-editor', vp);
      await page.context().close();
    });

    test('page logic (page 22): the menu button opens and fits; the badge shows', async () => {
      const page = await (await newContext({ viewport: size })).newPage();
      await login(page, '/a/hr/login', 'king', 'king');
      const res = await page.goto(`${base}/a/hr/22`);
      assert.equal(res?.status(), 200);
      assert.equal(await page.locator('.btn-badge').count(), 1, 'the Check button has a badge');
      await page.click('details.btn-menu > summary');
      await page.locator('details.btn-menu .menu-panel').waitFor({ state: 'visible' });
      await check(page, 'app-22-menu', vp);
      const box = await page.locator('details.btn-menu .menu-panel').boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= size.width + 1, `the menu fits: ${JSON.stringify(box)}`);
      await page.context().close();
    });

    test('account pages fit; the theme switch and Dutch work', async () => {
      const anon = await (await newContext({ viewport: size, locale: 'nl-NL' })).newPage();
      await anon.goto(`${base}/a/hr/login`);
      assert.equal(await anon.locator('html').getAttribute('lang'), 'nl');
      await check(anon, 'app-login-nl', vp);
      await anon.context().close();

      const page = await (await newContext({ viewport: size })).newPage();
      await login(page, '/a/hr/login', 'king', 'king');
      await page.goto(`${base}/a/hr/account`);
      await check(page, 'app-account', vp);
      await page.click('.t-user summary');
      await check(page, 'app-user-menu', vp);
      await Promise.all([page.waitForNavigation(), page.click('.theme-switch button[value="dark"]')]);
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      assert.notEqual(bg, 'rgb(243, 244, 246)', 'dark background');
      await check(page, 'app-account-dark', vp);
      await owner.query(`update meta.account set theme_pref = 'auto' where username = 'king'`);
      await page.context().close();
    });

    test('navigation is reachable', async () => {
      const page = await (await newContext({ viewport: size })).newPage();
      await login(page, '/a/hr/login', 'king', 'king');
      const nav = page.locator('#t-nav');
      if (size.width < 1024) {
        assert.equal(await nav.isVisible(), false, 'menu starts closed on small screens');
        await page.click('.t-nav-toggle');
        await nav.waitFor({ state: 'visible', timeout: 2000 }); // slides in
        await page.waitForTimeout(300);
        await check(page, 'app-nav-open', vp);
        await page.mouse.click(size.width - 10, size.height / 2); // the backdrop
        await nav.waitFor({ state: 'hidden', timeout: 2000 });
      } else {
        assert.equal(await nav.isVisible(), true, 'menu starts open on large screens');
      }
      await page.context().close();
    });

    test('modal dialog form fits and saves', async () => {
      const page = await (await newContext({ viewport: size })).newPage();
      await login(page, '/a/hr/login', 'king', 'king');
      await page.goto(`${base}/a/hr/2`);
      await page.locator('table.report a, .report-reflow a').filter({ hasText: '7839' }).first().click();
      const frame = page.frameLocator('#t-dialog iframe');
      await frame.locator('#P3_ENAME').waitFor();
      const box = await page.locator('#t-dialog').boundingBox();
      assert.ok(box && box.width <= size.width && box.height <= size.height, `dialog fits: ${JSON.stringify(box)}`);
      const saveVisible = await frame.locator('button.btn[value="SAVE"]').isVisible();
      assert.ok(saveVisible, 'save button reachable');
      if (shots) await page.screenshot({ path: `test-results/${vp}-app-dialog.png` });
      await page.context().close();
    });

    test('report rows chosen on one page stay chosen on the next', async () => {
      if (vp !== 'desktop') return;
      const r = await owner.one(`select r.id, r.page_id, r.config from meta.region r join meta.page p on p.id = r.page_id join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 2 and r.type = 'report'`);
      await owner.query(`insert into meta.item (page_id, name, type) values ($1, 'P2_E2E_SEL', 'hidden')`, [r.page_id]);
      await owner.query('update meta.region set config = config || $2 where id = $1', [r.id, JSON.stringify({ selection: { column: 'empno', item: 'P2_E2E_SEL' } })]);
      const page = await (await newContext({ viewport: size })).newPage();
      try {
        await login(page, '/a/hr/login', 'king', 'king');
        await page.goto(`${base}/a/hr/2?r${r.id}_n=5`);
        const first = page.locator('input[type=checkbox][name="P2_E2E_SEL"]').first();
        const value = await first.getAttribute('value');
        const done = page.waitForResponse((res) => res.url().includes(`/report/${r.id}/select`));
        await first.check();
        await done;
        await page.locator(`[data-sel-count="${r.id}"]`).filter({ hasText: '1 selected' }).waitFor();
        await page.goto(`${base}/a/hr/2?r${r.id}_n=5&r${r.id}_p=2`);
        assert.equal(await page.locator(`input[type=hidden][name="P2_E2E_SEL"][value="${value}"]`).count(), 1, 'carried as a hidden value');
        await page.goto(`${base}/a/hr/2?r${r.id}_n=5`);
        assert.equal(await page.locator(`input[type=checkbox][name="P2_E2E_SEL"][value="${value}"]`).isChecked(), true);
      } finally {
        await page.context().close();
        await owner.query('update meta.region set config = $2 where id = $1', [r.id, JSON.stringify(r.config)]);
        await owner.query(`delete from meta.item where page_id = $1 and name = 'P2_E2E_SEL'`, [r.page_id]);
      }
    });

    test('a drawer page slides in from the right (full screen on phones)', async () => {
      const page = await (await newContext({ viewport: size })).newPage();
      await login(page, '/a/hr/login', 'allen', 'allen');
      await page.goto(`${base}/a/hr/6`);
      await page.locator('a, button').filter({ hasText: 'Request leave' }).first().click();
      await page.frameLocator('#t-dialog iframe').locator('form').first().waitFor();
      const dlg = page.locator('#t-dialog');
      assert.match(String(await dlg.getAttribute('class')), /\bt-drawer\b.*|.*\bt-dialog-right\b/);
      await page.waitForTimeout(300); // the slide-in animation
      const box = (await dlg.boundingBox())!;
      assert.ok(Math.abs(box.x + box.width - size.width) <= 1, `docked to the right edge: ${JSON.stringify(box)}`);
      assert.ok(Math.abs(box.height - size.height) <= 1, `full height: ${JSON.stringify(box)}`);
      if (size.width <= 640) assert.ok(box.width >= size.width - 1, 'full width on phones');
      else assert.ok(box.width < size.width, 'narrower than the screen');
      if (shots) await page.screenshot({ path: `test-results/${vp}-app-drawer.png` });
      await page.context().close();
    });

    test('several files can be chosen in the dialog form and are listed after saving', async () => {
      const page = await (await newContext({ viewport: size })).newPage();
      await login(page, '/a/hr/login', 'king', 'king');
      const open = async () => {
        await page.goto(`${base}/a/hr/2`);
        await page.locator('table.report a, .report-reflow a').filter({ hasText: '7934' }).first().click();
        const frame = page.frameLocator('#t-dialog iframe');
        await frame.locator('#P3_DOCUMENTS').waitFor();
        return frame;
      };
      try {
        let frame = await open();
        await frame.locator('#P3_DOCUMENTS').setInputFiles([
          { name: 'contract.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF\n') },
          { name: 'a-rather-long-file-name-for-a-certificate-of-employment-2026.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF\n') },
        ]);
        await frame.locator('button.btn[value="SAVE"]').click();
        await page.locator('#t-dialog iframe').waitFor({ state: 'detached' }).catch(() => {});
        frame = await open();
        assert.equal(await frame.locator('.file-list li').count(), 2);
        const inner = page.frames().find((f) => f.url().includes('/a/hr/3'))!;
        const wide = await inner.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
        assert.equal(wide, false, 'the file list fits the dialog');
        await frame.locator('#P3_DOCUMENTS').scrollIntoViewIfNeeded();
        if (shots) await page.screenshot({ path: `test-results/${vp}-app-dialog-files.png` });
      } finally {
        await owner.query(`delete from hr.emp_document where empno = 7934`);
        await page.context().close();
      }
    });

    test('style variants and template options: the user menu switch, the CSS, the fit', async () => {
      const app = await owner.one(`select id, theme from meta.app where alias = 'hr'`);
      const r = await owner.one(`select r.id, r.template_options from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 1 order by r.seq limit 1`, [app.id]);
      await owner.query(`update meta.app set theme = theme || $2::jsonb where id = $1`, [app.id, JSON.stringify({
        styles: [{ name: 'Square serif', accent: '#7a1f5c', font: 'serif', font_size: 'large', radius: 'none' }, { name: 'Round', radius: 'large' }],
        style_choice: true,
      })]);
      await owner.query(`update meta.region set template_options = '{to-accent,to-compact}' where id = $1`, [r.id]);
      const page = await (await newContext({ viewport: size })).newPage();
      try {
        await login(page, '/a/hr/login', 'king', 'king');
        await page.goto(`${base}/a/hr/1`);
        assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--radius').trim()), '8px');
        await page.click('details.t-user > summary');
        await check(page, 'app-style-menu', vp);
        await Promise.all([page.waitForNavigation(), page.click('.style-switch button[value="Square serif"]')]);
        const look = await page.evaluate((id) => ({
          radius: getComputedStyle(document.documentElement).getPropertyValue('--radius').trim(),
          font: getComputedStyle(document.body).fontFamily,
          size: getComputedStyle(document.body).fontSize,
          border: getComputedStyle(document.getElementById(`R${id}`)!).borderTopWidth,
        }), r.id);
        assert.deepEqual({ ...look, font: /Charter|Georgia|serif/.test(look.font) }, { radius: '0px', font: true, size: '16px', border: '3px' });
        await check(page, 'app-style-square-serif', vp);
        // back to Standard
        await page.click('details.t-user > summary');
        await Promise.all([page.waitForNavigation(), page.click('.style-switch button[value=""]')]);
        assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--radius').trim()), '8px');
      } finally {
        await page.context().close();
        await owner.query(`update meta.app set theme = $2 where id = $1`, [app.id, JSON.stringify(app.theme)]);
        await owner.query(`update meta.region set template_options = $2 where id = $1`, [r.id, r.template_options]);
        await owner.query(`delete from meta.account_style where app_id = $1`, [app.id]);
      }
    });

    test('builder pages fit the screen', async () => {
      const page = await (await newContext({ viewport: size })).newPage();
      await login(page, '/builder/login', 'admin', 'admin', '#f_username', '#f_password');
      const appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
      const pageId = (await owner.one(`select id from meta.page where app_id = $1 and page_no = 3`, [appId])).id;
      const urls = {
        home: '/builder',
        home_cards: '/builder?view=grid',
        create: '/builder/create',
        import: '/builder/import',
        dashboard: '/builder/dashboard',
        utilities: '/builder/utilities',
        app: `/builder/apps/${appId}`,
        shared: `/builder/apps/${appId}/shared`,
        layout: `/builder/apps/${appId}/shared?c=report_layout-${(await owner.one(`select id from meta.report_layout where app_id = $1 and name = 'HR_DIRECTORY'`, [appId])).id}`,
        automation: `/builder/apps/${appId}/shared?c=automation-${(await owner.one(`select id from meta.automation where app_id = $1 and name = 'Remind managers'`, [appId])).id}`,
        automation_action: `/builder/apps/${appId}/shared?c=automation_action-${(await owner.one(`select id from meta.automation_action where app_id = $1 and automation_name = 'Remind managers' and seq = 20`, [appId])).id}`,
        automation_action_new: `/builder/apps/${appId}/shared?new=automation_action&automation=Remind%20managers`,
        settings: `/builder/apps/${appId}/settings`,
        theme_roller: `/builder/apps/${appId}/theme`,
        activity: `/builder/apps/${appId}/activity`,
        api: `/builder/apps/${appId}/api`,
        search: `/builder/apps/${appId}/search?q=empno`,
        advisor: `/builder/apps/${appId}/advisor`,
        top_sql: `/builder/apps/${appId}/top-sql`,
        debug: `/builder/apps/${appId}/debug`,
        debug_view: `/builder/apps/${appId}/debug/${await (async () => {
          const v = (await owner.one(`insert into meta.debug_view (app_id, page_no, username, method, path, status, level, elapsed_ms, entries)
            values ($1, 3, 'king', 'GET', '/a/hr/3', 200, 9, 42.5, 3) returning id`, [appId])).id;
          await owner.query(`insert into meta.debug_message (view_id, seq, elapsed_ms, duration_ms, level, component, message) values
            ($1, 1, 0, null, 4, 'request', 'GET /a/hr/3 (parameters: P3_EMPNO, cs)'), ($1, 2, 1.2, 38.1, 6, 'region', 'region "Employees" (report)'),
            ($1, 3, 40, null, 4, 'meta.debug', repeat('a long message without spaces ', 3) || repeat('x', 300))`, [v]);
          return v;
        })()}`,
        installation: '/builder/installation',
        workspaces: '/builder/workspaces',
        workspace: '/builder/workspaces/1',
        rest_module: `/builder/apps/${appId}/shared?c=rest_module-${(await owner.one(`select id from meta.rest_module where app_id = $1 and name = 'v1'`, [appId])).id}`,
        workflow: `/builder/apps/${appId}/shared?c=workflow_definition-${(await owner.one(`select id from meta.workflow_definition where app_id = $1 and name = 'ONBOARDING'`, [appId])).id}`,
        task_definition: `/builder/apps/${appId}/shared?c=task_definition-${(await owner.one(`select id from meta.task_definition where app_id = $1 and name = 'LEAVE_APPROVAL'`, [appId])).id}`,
        document: `/builder/apps/${appId}/shared?c=document_template-${(await owner.one(`select id from meta.document_template where app_id = $1 and name = 'EMPLOYEE_SHEET'`, [appId])).id}`,
        used_in: `/builder/apps/${appId}/shared?c=lov-${(await owner.one(`select id from meta.lov where app_id = $1 and name = 'DEPARTMENTS'`, [appId])).id}`,
        globalization: `/builder/apps/${appId}/globalization?lang=nl`,
        designer: `/builder/pages/${pageId}`,
        report_region: await (async () => {
          const r = await owner.one(`select r.id, r.page_id from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 2 and r.type = 'report'`, [appId]);
          return `/builder/pages/${r.page_id}?c=region-${r.id}`;
        })(),
        ...Object.fromEntries(
          (await owner.query(`select distinct on (r.type) r.type, r.id, r.page_id from meta.region r join meta.page p on p.id = r.page_id
                               where p.app_id = $1 and r.type in ('grid', 'chart', 'cards', 'calendar', 'facets', 'template_component') order by r.type, r.id`, [appId])).rows
            .map((r) => [`${r.type}_region`, `/builder/pages/${r.page_id}?c=region-${r.id}`]),
        ),
        template_component: `/builder/apps/${appId}/shared?c=template_component-${(await owner.one(`select id from meta.template_component where app_id = $1 and static_id = 'contact_card'`, [appId])).id}`,
        template_import: `/builder/apps/${appId}/shared?new=template_component`,
        web_credential: `/builder/apps/${appId}/shared?c=web_credential-${(await owner.one(`select id from meta.web_credential where app_id = $1 and name = 'HR_API'`, [appId])).id}`,
        rest_source: `/builder/apps/${appId}/shared?c=rest_source-${(await owner.one(`select id from meta.rest_source where app_id = $1 and name = 'DEPARTMENT'`, [appId])).id}`,
        rest_region: await (async () => {
          const r = await owner.one(`select r.id, r.page_id from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 23 and r.rest_source is not null and r.type = 'report'`, [appId]);
          return `/builder/pages/${r.page_id}?c=region-${r.id}`;
        })(),
        column_templates: await (async () => {
          const r = await owner.one(`select r.id, r.page_id from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 19 and r.type = 'report'`, [appId]);
          return `/builder/pages/${r.page_id}?c=region-${r.id}`;
        })(),
        build_option: `/builder/apps/${appId}/shared?c=build_option-${(await owner.one(`select id from meta.build_option where app_id = $1 and name = 'LEAVE_FORECAST'`, [appId])).id}`,
        ...Object.fromEntries(
          await Promise.all(['computation', 'branch'].map(async (k) => {
            const r = await owner.one(`select x.id, x.page_id from meta.${k} x join meta.page p on p.id = x.page_id where p.app_id = $1 and p.page_no = 22 order by x.seq limit 1`, [appId]);
            return [k, `/builder/pages/${r.page_id}?c=${k}-${r.id}`];
          })),
        ),
        sql: '/builder/sql',
        objects: '/builder/sql/objects?o=hr.emp',
        load: '/builder/sql/load',
        unload: '/builder/sql/unload',
        unload_table: '/builder/sql/unload?table=hr.emp',
        unload_query: '/builder/sql/unload?source=query',
        // (sprint 35) Sample Data: the start page, the tables of a schema, the generator form and a saved generator (HR example part 40)
        sample_data: '/builder/sql/sample-data',
        sample_data_tables: '/builder/sql/sample-data?schema=hr',
        sample_data_form: '/builder/sql/sample-data?schema=hr&t=dept&t=emp&t=leave_request',
        sample_data_saved: `/builder/sql/sample-data/${(await owner.one(`select id from meta.data_generator where name = 'HR demo staff'`)).id}`,
        scripts: '/builder/sql/scripts',
        script_new: '/builder/sql/scripts/new',
        script: `/builder/sql/scripts/${(await owner.one(`insert into meta.sql_script (name, content) values ('E2E script', 'select empno, ename, job, hiredate, sal, comm, deptno from hr.emp;\nselect 1/0;')
          on conflict (name) do update set content = excluded.content returning id`)).id}`,
        script_run: `/builder/sql/scripts/runs/${(await owner.one(`insert into meta.sql_script_run (script_name, run_by, statements, succeeded, failed, results) values ('E2E script', 'admin', 2, 1, 1, $1) returning id`, [JSON.stringify([
          { n: 1, line: 1, sql: 'select empno, ename, job, hiredate, sal, comm, deptno from hr.emp', status: 'ok', command: 'SELECT', rows: 2, ms: 1,
            columns: ['empno', 'ename', 'job', 'hiredate', 'sal', 'comm', 'deptno'], sample: [['7369', 'SMITH', 'CLERK', '1980-12-17', '850.00', null, '20'], ['7499', 'ALLEN', 'SALESMAN', '1981-02-20', '1600.00', '300.00', '30']] },
          { n: 2, line: 2, sql: 'select 1/0', status: 'error', error: 'division by zero', ms: 0 },
        ])])).id}`,
        quick_sql: '/builder/sql/quick',
        query_builder: '/builder/sql/query?schema=hr&t=emp&t=dept&c=t1.ename&c=t1.job&c=t2.dname&wc=t1.sal&wo=%3E&wv=1000&oc=t1.ename',
        data_load_def: `/builder/apps/${appId}/shared?c=data_load_def-${(await owner.one(`select id from meta.data_load_def where app_id = $1 and name = 'EMP_XML'`, [appId])).id}`,
        developers: '/builder/developers',
        users: '/builder/users',
        providers: '/builder/users/providers',
        directories: '/builder/users/directories',
        user: `/builder/users/${(await owner.one(`select id from meta.account where username = 'king'`)).id}`,
        // (sprint 31) lists, the list region, supporting objects, a locked page with comments
        list: `/builder/apps/${appId}/shared?c=list-${(await owner.one(`select id from meta.list where app_id = $1 and name = 'HR_SHORTCUTS'`, [appId])).id}`,
        list_entry: `/builder/apps/${appId}/shared?c=list_entry-${(await owner.one(`select id from meta.list_entry where app_id = $1 and list_name = 'HR_SHORTCUTS' order by seq limit 1`, [appId])).id}`,
        list_region: await (async () => {
          const r = await owner.one(`select r.id, r.page_id from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 31 and r.type = 'list' order by r.seq, r.id limit 1`, [appId]);
          return `/builder/pages/${r.page_id}?c=region-${r.id}`;
        })(),
        supporting_objects: `/builder/apps/${appId}/supporting-objects?imported=1`,
        locked_page: `/builder/pages/${(await owner.one('select id from meta.page where app_id = $1 and page_no = 31', [appId])).id}`,
        // (sprint 32) step 2 of the create page wizards
        ...Object.fromEntries(
          [['form', 'hr.emp'], ['cards', 'hr.emp'], ['calendar', 'hr.leave_request'], ['chart', 'hr.emp'], ['map', 'hr.dept'], ['facets', 'hr.emp'], ['master_detail', 'hr.dept'], ['report_form', 'hr.dept']]
            .map(([kind, table]) => [`wizard_${kind}`, `/builder/apps/${appId}/wizard?kind=${kind}&table=${table}`]),
        ),
        // (sprint 34) working copies: the list, and a copy compared with a long difference shown
        working_copies: `/builder/apps/${appId}/working-copies`,
        working_copy_compare: await (async () => {
          await owner.query(`delete from meta.app where alias in ('hr-e2e', 'e2e-library', 'e2e-subscriber')`);
          const id = await createCopy(appId, 'e2e', 'admin');
          await owner.query(`update meta.lov set query = $2 where app_id = $1 and name = 'JOBS'`, [id, 'select job_title as d, job_id as r from hr.job where job_title is not null and job_id is not null order by job_title, job_id -- a long changed line']);
          await owner.query(`update meta.page set name = 'Staff' where app_id = $1 and page_no = 2`, [id]);
          return `/builder/apps/${id}/compare?c=shared%2Flovs%2Fjobs`;
        })(),
        // (sprint 34) subscriptions: a library application and a subscriber
        ...(await (async () => {
          await owner.query(`delete from meta.app where alias in ('e2e-library', 'e2e-subscriber')`);
          const lib = (await owner.one(`insert into meta.app (alias, name, app_type) values ('e2e-library', 'E2E shared components library', 'library') returning id`)).id;
          const sub = (await owner.one(`insert into meta.app (alias, name) values ('e2e-subscriber', 'E2E subscriber') returning id`)).id;
          await owner.query(`insert into meta.lov (app_id, name, query) values ($1, 'DEPARTMENTS_WITH_A_LONG_NAME', 'select dname as d, deptno as r from hr.dept')`, [lib]);
          await owner.query(`insert into meta.authz_scheme (app_id, name, type, value, error_message) values ($1, 'MANAGERS', 'role', 'manager', 'Managers only.')`, [lib]);
          await subscribe(sub, lib, 'lov', 'DEPARTMENTS_WITH_A_LONG_NAME', 'admin');
          return { subscriptions: `/builder/apps/${sub}/subscriptions`, subscribers: `/builder/apps/${lib}/subscriptions` };
        })()),
        // (sprint 35) create application from pasted data and from existing tables
        create_paste: '/builder/create/paste',
        create_tables: '/builder/create/tables?schema=hr',
        // (sprint 35) the Data Reporter region's settings (data sources and their columns)
        data_reporter_region: await (async () => {
          const r = await owner.one(`select r.id, r.page_id from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 36 and r.type = 'data_reporter'`, [appId]);
          return `/builder/pages/${r.page_id}?c=region-${r.id}`;
        })(),
        // (sprint 36) AI services (a service with usage rows), one service, and an application's AI usage
        ...(await (async () => {
          await owner.query(`delete from meta.ai_service where name = 'E2E_CLAUDE_WITH_A_LONG_SERVICE_NAME'`);
          const svc = (await owner.one(`insert into meta.ai_service (name, description, provider, model, effort, base_url)
            values ('E2E_CLAUDE_WITH_A_LONG_SERVICE_NAME', 'A service for the responsive tests', 'anthropic', 'claude-opus-5-5', 'medium', 'https://gateway.example.com/a/very/long/path/without/breaks') returning id`)).id;
          await owner.query(`insert into meta.app_ai_service (app_id, service_id, max_requests, max_tokens) values ($1, $2, 100, 200000)`, [appId, svc]);
          await owner.query(`insert into meta.ai_usage (app_id, page_no, username, service_id, service, provider, model, source, input_tokens, output_tokens, duration_ms, status, message)
            values ($1, 37, 'king', $2, 'E2E_CLAUDE_WITH_A_LONG_SERVICE_NAME', 'anthropic', 'claude-opus-5-5', 'process', 1234, 567, 2345, 'ok', null),
                   ($1, 37, 'king', $2, 'E2E_CLAUDE_WITH_A_LONG_SERVICE_NAME', 'anthropic', 'claude-opus-5-5', 'dynamic_action', 0, 0, 120, 'error', 'rate_limit 429')`, [appId, svc]);
          return { ai_services: '/builder/ai', ai_service: `/builder/ai/${svc}`, ai_usage: `/builder/apps/${appId}/ai` };
        })()),
        // (sprint 36) the AI assistant region's settings and a report's "Ask in your own words" (HR page 38)
        ...(await (async () => {
          const rs = (await owner.query(`select r.id, r.page_id, r.type from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 38 and r.type in ('ai_assistant', 'report')`, [appId])).rows;
          const at = (type: string) => { const r = rs.find((x) => x.type === type); return `/builder/pages/${r.page_id}?c=region-${r.id}`; };
          return { ai_assistant_region: at('ai_assistant'), ai_filter_region: at('report') };
        })()),
        // (sprint 36) App Builder AI: SQL Workshop → AI, describe a table, create pages with AI
        sql_ai: '/builder/sql/ai',
        sql_ai_describe: '/builder/sql/ai/describe?schema=hr&table=leave_request',
        ai_pages: `/builder/apps/${appId}/ai-pages`,
        // (sprint 36) blueprints: the list and the editor with the example
        blueprints: '/builder/blueprints',
        blueprint_new: '/builder/blueprints/new',
      };
      await owner.query(`insert into meta.builder_lock (app_id, page_no, locked_by, note) values ($1, 31, 'e2e_other_developer', 'reworking the shortcuts') on conflict do nothing`, [appId]);
      await owner.query(`insert into meta.dev_comment (app_id, page_no, author, body) values ($1, 31, 'e2e_other_developer', $2), ($1, 0, 'e2e_other_developer', 'An application comment')`, [appId, 'A long comment without spaces: ' + 'x'.repeat(120)]);
      try {
        for (const [name, url] of Object.entries(urls)) {
          const res = await page.goto(`${base}${url}`);
          assert.equal(res?.status(), 200, name);
          await check(page, `builder-${name}`, vp);
        }
      } finally {
        await owner.query(`delete from meta.builder_lock where app_id = $1 and locked_by = 'e2e_other_developer'`, [appId]);
        await owner.query(`delete from meta.app where alias = 'hr-e2e'`);
        await owner.query(`delete from meta.dev_comment where app_id = $1 and author = 'e2e_other_developer'`, [appId]);
        await owner.query(`delete from meta.debug_view where app_id = $1 and path = '/a/hr/3' and username = 'king'`, [appId]);
        await owner.query(`delete from meta.ai_usage where service = 'E2E_CLAUDE_WITH_A_LONG_SERVICE_NAME'`);
        await owner.query(`delete from meta.ai_service where name = 'E2E_CLAUDE_WITH_A_LONG_SERVICE_NAME'`);
      }
      // (sprint 35) Sample Data: a preview (inserted and rolled back) of the HR example's saved generator
      {
        await page.goto(`${base}${urls.sample_data_saved}`);
        await Promise.all([page.waitForNavigation(), page.click('button[name=action][value=preview]')]);
        assert.match(await page.content(), /Rolled back: nothing was saved/);
        await check(page, 'builder-sample_data_preview', vp);
      }
      // (sprint 32) create an application from a file: upload, step 2, the result and the generated pages
      const alias = `e2e-ff-${size.width}`;
      const schema = alias.replace(/-/g, '_');
      const dropApp = async () => {
        await owner.query('delete from meta.app where alias = $1', [alias]);
        await owner.query(`drop schema if exists ${schema} cascade`);
        if ((await owner.query('select 1 from pg_roles where rolname = $1', [`app_${schema}`])).rowCount) {
          await owner.query(`drop owned by app_${schema}`);
          await owner.query(`drop role app_${schema}`);
        }
      };
      await dropApp();
      try {
        await page.goto(`${base}/builder/create/file`);
        await check(page, 'builder-create_file', vp);
        const csv = ['Product name,Category,Description of the product,Price,In stock,Released', ...Array.from({ length: 12 }, (_, i) =>
          `Product ${i + 1},${['Tools', 'Toys', 'Garden'][i % 3]},A rather long description of product number ${i + 1} to see how wide text fits,${(i * 3.5 + 1).toFixed(2)},${i % 2 ? 'yes' : 'no'},2026-0${(i % 9) + 1}-1${i % 9}`)].join('\n');
        await page.setInputFiles('#f_file', { name: 'e2e-products.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
        await Promise.all([page.waitForURL(/\/builder\/create\/file\/[0-9a-f-]{36}/), page.locator('main button.btn-hot').click()]);
        await check(page, 'builder-create_file_step2', vp);
        await page.fill('#f_alias', alias);
        await page.selectOption('#f_authentication', 'none');
        await Promise.all([page.waitForNavigation(), page.locator('main button.btn-hot').click()]);
        assert.match(await page.locator('main').innerText(), /12 row\(s\) loaded/);
        await check(page, 'builder-create_file_done', vp);
        for (const p of [2, 4, 5]) {
          const res = await page.goto(`${base}/a/${alias}/${p}`);
          assert.equal(res?.status(), 200, `${alias} page ${p}`);
          await check(page, `app-from-file-${p}`, vp);
        }
      } finally {
        await dropApp();
      }
      // (sprint 35) a workbook with several sheets: step 2 with a section per sheet and foreign keys, the result, the dashboard
      const wbAlias = `e2e-wb-${size.width}`;
      const dropWb = async () => {
        const sch = wbAlias.replace(/-/g, '_');
        await owner.query('delete from meta.app where alias = $1', [wbAlias]);
        await owner.query(`drop schema if exists ${sch} cascade`);
        if ((await owner.query('select 1 from pg_roles where rolname = $1', [`app_${sch}`])).rowCount) {
          await owner.query(`drop owned by app_${sch}`);
          await owner.query(`drop role app_${sch}`);
        }
      };
      await dropWb();
      try {
        const book = workbook([
          { name: 'Departments with a rather long sheet name', rows: [['ID', 'Name', 'City'], ...Array.from({ length: 6 }, (_, i) => [i + 1, `Department ${i + 1}`, ['Utrecht', 'Delft'][i % 2]])] },
          { name: 'Employees', rows: [['Employee ID', 'Name', 'Department ID', 'A rather long column heading without breaks_to_wrap'], ...Array.from({ length: 12 }, (_, i) => [i + 1, `Person ${i + 1}`, (i % 6) + 1, 'x'.repeat(40)])] },
        ]);
        await page.goto(`${base}/builder/create/file`);
        await page.setInputFiles('#f_file', { name: 'e2e-company.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: book });
        await Promise.all([page.waitForURL(/\/builder\/create\/file\/[0-9a-f-]{36}/), page.locator('main button.btn-hot').click()]);
        await check(page, 'builder-create_file_sheets', vp);
        await page.fill('#f_alias', wbAlias);
        await page.fill('#f_s0_table', 'departments');
        await page.selectOption('#f_authentication', 'none');
        // without JavaScript: the form is posted to redraw the proposals for the new table name
        await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Update the proposals' }).click()]);
        assert.equal(await page.isChecked('input[name="fk_1_2"]'), true, 'employees.department_id → departments.id');
        await Promise.all([page.waitForNavigation(), page.locator('main button.btn-hot').click()]);
        assert.match(await page.locator('main').innerText(), /12 row\(s\) loaded/);
        await check(page, 'builder-create_file_sheets_done', vp);
        const res = await page.goto(`${base}/a/${wbAlias}/6`);
        assert.equal(res?.status(), 200, `${wbAlias} dashboard`);
        await check(page, 'app-from-sheets-dashboard', vp);
      } finally {
        await dropWb();
      }
      await page.context().close();
    });
  });
}
