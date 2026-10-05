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
          const el = document.getElementById('pgapex-css') as HTMLStyleElement;
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
        settings: `/builder/apps/${appId}/settings`,
        activity: `/builder/apps/${appId}/activity`,
        api: `/builder/apps/${appId}/api`,
        search: `/builder/apps/${appId}/search?q=empno`,
        advisor: `/builder/apps/${appId}/advisor`,
        top_sql: `/builder/apps/${appId}/top-sql`,
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
      };
      for (const [name, url] of Object.entries(urls)) {
        const res = await page.goto(`${base}${url}`);
        assert.equal(res?.status(), 200, name);
        await check(page, `builder-${name}`, vp);
      }
      await page.context().close();
    });
  });
}
