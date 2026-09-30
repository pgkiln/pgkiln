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
  const o = await overflow(page);
  assert.equal(o, null, `${name} overflows at ${vp}: ${JSON.stringify(o)}`);
}

for (const [vp, size] of Object.entries(VIEWPORTS)) {
  describe(`${vp} (${size.width}px)`, () => {
    test('application pages fit the screen', async () => {
      const page = await (await browser.newContext({ viewport: size })).newPage();
      await login(page, '/a/hr/login', 'king', 'king');
      const pages = (await owner.query(`select p.page_no from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.mode = 'normal' order by 1`)).rows;
      for (const { page_no: p } of pages) {
        const res = await page.goto(`${base}/a/hr/${p}`);
        assert.equal(res?.status(), 200, `page ${p}`);
        await check(page, `app-${p}`, vp);
      }
      // the report's Actions menu fits
      await page.goto(`${base}/a/hr/2`);
      await page.click('summary:has-text("Actions")');
      await check(page, 'app-2-actions', vp);
      await page.context().close();
    });

    test('account pages fit; the theme switch and Dutch work', async () => {
      const anon = await (await browser.newContext({ viewport: size, locale: 'nl-NL' })).newPage();
      await anon.goto(`${base}/a/hr/login`);
      assert.equal(await anon.locator('html').getAttribute('lang'), 'nl');
      await check(anon, 'app-login-nl', vp);
      await anon.context().close();

      const page = await (await browser.newContext({ viewport: size })).newPage();
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
      const page = await (await browser.newContext({ viewport: size })).newPage();
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
      const page = await (await browser.newContext({ viewport: size })).newPage();
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

    test('builder pages fit the screen', async () => {
      const page = await (await browser.newContext({ viewport: size })).newPage();
      await login(page, '/builder/login', 'admin', 'admin', '#f_username', '#f_password');
      const appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
      const pageId = (await owner.one(`select id from meta.page where app_id = $1 and page_no = 3`, [appId])).id;
      const urls = {
        home: '/builder',
        app: `/builder/apps/${appId}`,
        shared: `/builder/apps/${appId}/shared`,
        layout: `/builder/apps/${appId}/shared?c=report_layout-${(await owner.one(`select id from meta.report_layout where app_id = $1 and name = 'HR_DIRECTORY'`, [appId])).id}`,
        settings: `/builder/apps/${appId}/settings`,
        activity: `/builder/apps/${appId}/activity`,
        api: `/builder/apps/${appId}/api`,
        globalization: `/builder/apps/${appId}/globalization?lang=nl`,
        designer: `/builder/pages/${pageId}`,
        sql: '/builder/sql',
        objects: '/builder/sql/objects?o=hr.emp',
        load: '/builder/sql/load',
        developers: '/builder/developers',
        users: '/builder/users',
        providers: '/builder/users/providers',
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
