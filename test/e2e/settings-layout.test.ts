// (sprint 198, NX-U3) Settings use the window's width: from 1280 px a right rail with each tab's section links (real
// anchors) and, on Security and Sign-in, the security checklist; the Sign-in tab in two columns of sections. At
// 1456 × 836 the Sign-in tab fits in two screens and the checklist is in view without scrolling; below 1280 px one
// column as before; 360 and 1366 px without horizontal scrolling; axe on every tab.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type BrowserContextOptions, type Page } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools, owner } from '../../src/db.ts';

const AXE = readFileSync(new URL('../../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
const TABS = ['definition', 'security', 'signin', 'ui', 'globalization', 'errors', 'pwa'];

let base = '';
let browser: Browser;
let close: () => Promise<void>;
let appId = 0;

before(async () => {
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  // a few directories and identity providers, as an installation that uses them has: the Sign-in tab's longest form
  await owner.query(`delete from meta.ldap_directory where name like 'e2e-nxu3-%'`);
  await owner.query(`delete from meta.auth_provider where name like 'e2e-nxu3-%'`);
  for (const n of [1, 2, 3]) {
    await owner.query(`insert into meta.ldap_directory (name, display_name, url, user_base) values ($1, $2, 'ldaps://ldap.example.com', 'dc=example,dc=com')`, [`e2e-nxu3-${n}`, `Corporate directory ${n}`]);
    await owner.query(`insert into meta.auth_provider (name, display_name, issuer, client_id) values ($1, $2, 'https://login.example.com', 'pgkiln')`, [`e2e-nxu3-${n}`, `Single sign-on ${n}`]);
  }
  close = async () => {
    await owner.query(`delete from meta.ldap_directory where name like 'e2e-nxu3-%'`);
    await owner.query(`delete from meta.auth_provider where name like 'e2e-nxu3-%'`);
    await browser.close();
    await app.close();
    await closePools();
  };
});
after(async () => close());

async function signedIn(options: BrowserContextOptions) {
  const context = await browser.newContext(options);
  await context.addInitScript(() => {
    (window as any).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as any).__csp.push(`${e.violatedDirective}: ${e.blockedURI || 'inline'}`));
  });
  const page = await context.newPage();
  await page.goto(`${base}/builder/login`);
  await page.fill('#f_username', 'admin');
  await page.fill('#f_password', 'admin');
  await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
  return page;
}

const settings = (tab: string) => `${base}/builder/apps/${appId}/settings?tab=${tab}`;

/** The checklist's box and the room between the top bar and the status bar. */
const checklistBox = (page: Page) => page.evaluate(() => {
  const ck = document.querySelector<HTMLElement>('#st-checklist');
  const r = ck?.getBoundingClientRect();
  const status = document.querySelector('.ide-status')?.getBoundingClientRect().height ?? 0;
  return r && r.height ? { top: r.top, bottom: r.bottom, room: window.innerHeight - status } : null;
});

async function noOverflow(page: Page, name: string) {
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth }));
  assert.ok(o.sw <= o.vw + 1, `${name} scrolls sideways: ${JSON.stringify(o)}`);
  assert.deepEqual(await page.evaluate(() => (window as any).__csp), [], `${name} violates the CSP`);
}

describe('settings layout (NX-U3)', () => {
  test('1456 × 836: Sign-in in two screens, the checklist in view, the rail with real anchors', async () => {
    const page = await signedIn({ viewport: { width: 1456, height: 836 } });
    await page.goto(settings('signin'));
    // the six methods are there, and the tab still fits in two screens
    assert.equal(await page.locator('.settings-panel[data-tab="signin"] input[name="ldap_directories"]').count() >= 3, true);
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    assert.ok(height <= 2 * 836, `the Sign-in tab is ${height} px high`);
    for (const tab of ['signin', 'security']) {
      await page.goto(settings(tab));
      const box = await checklistBox(page);
      assert.ok(box, `the checklist is shown on ${tab}`);
      assert.ok(box.top >= 0 && box.bottom <= box.room, `the checklist is in view without scrolling on ${tab}: ${JSON.stringify(box)}`);
      // the rail stays beside the form while it scrolls
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      const after = await checklistBox(page);
      assert.ok(after && after.top >= 0 && after.bottom <= after.room, `the checklist stays in view on ${tab}: ${JSON.stringify(after)}`);
      // the rail is beside the form, not under it
      const [form, rail] = await Promise.all(['.settings-body', '.settings-rail'].map((s) => page.locator(s).boundingBox()));
      assert.ok(rail!.x >= form!.x + form!.width, 'the rail is to the right of the form');
    }
    // every tab: the rail's links are anchors of a section on the page (without JavaScript too: plain href="#…")
    for (const tab of TABS) {
      await page.goto(settings(tab));
      const links = await page.locator('.settings-rail-nav:not([hidden]) a[data-rail-link]').evaluateAll((as) => as.map((a) => a.getAttribute('href')!));
      assert.ok(links.length >= 1, `${tab} has section links`);
      for (const href of links) {
        assert.match(href, /^#[a-z][a-z0-9-]*$/);
        assert.equal(await page.locator(href).count(), 1, `${tab}: ${href} is on the page`);
        assert.ok(await page.locator(href).isVisible(), `${tab}: ${href} is visible`);
      }
      assert.equal(await page.locator('.settings-rail-nav:not([hidden])').count() >= 1, true);
      assert.equal(await page.locator('#st-checklist').isVisible(), ['security', 'signin'].includes(tab), `the checklist on ${tab}`);
      await noOverflow(page, `settings ${tab} at 1456`);
    }
    // a section link scrolls to its section and marks itself as the current one
    await page.goto(settings('signin'));
    await page.click('.settings-rail a[href="#two-factor"]');
    await page.waitForFunction(() => document.querySelector('.settings-rail a[href="#two-factor"]')?.getAttribute('aria-current') === 'location');
    assert.ok(page.url().endsWith('#two-factor'));
    // the tabs switch without a reload, and the rail follows
    await page.click('[data-tab-link="errors"]');
    assert.ok(await page.locator('.settings-rail a[href="#session-management"]').isVisible());
    assert.equal(await page.locator('#st-checklist').isVisible(), false);
    await page.click('[data-tab-link="security"]');
    assert.ok(await page.locator('#st-checklist').isVisible());
    assert.ok(await page.locator('.settings-rail a[href="#st-authentication"]').isVisible());
    await page.context().close();
  });

  test('without JavaScript the rail is the tab\'s, its links jump', async () => {
    const page = await signedIn({ viewport: { width: 1456, height: 836 }, javaScriptEnabled: false });
    await page.goto(settings('errors'));
    await page.click('.settings-rail a[href="#expire-bookmarks"]');
    assert.ok(page.url().endsWith('#expire-bookmarks'));
    assert.ok(await page.evaluate(() => window.scrollY > 0));
    assert.equal(await page.locator('#st-checklist').isVisible(), false);
    await page.goto(settings('security'));
    assert.ok(await page.locator('#st-checklist').isVisible());
    await page.context().close();
  });

  test('below 1280 px one column: the checklist under the form, on Security only', async () => {
    const page = await signedIn({ viewport: { width: 1279, height: 836 } });
    await page.goto(settings('security'));
    assert.equal(await page.locator('.settings-rail-nav:not([hidden]) a').first().isVisible(), false, 'no section links');
    const [form, ck] = await Promise.all(['.settings-body', '#st-checklist'].map((s) => page.locator(s).boundingBox()));
    assert.ok(ck!.y >= form!.y + form!.height, 'the checklist is under the form');
    await page.goto(settings('signin'));
    assert.equal(await page.locator('#st-checklist').isVisible(), false);
    await page.context().close();
  });

  for (const width of [360, 1366]) {
    test(`${width} px: every tab and Create application without sideways scrolling`, async () => {
      const page = await signedIn({ viewport: { width, height: 800 } });
      for (const tab of TABS) {
        await page.goto(settings(tab));
        await noOverflow(page, `settings ${tab} at ${width}`);
      }
      for (const path of ['create', 'create/full']) {
        await page.goto(`${base}/builder/${path}`);
        await noOverflow(page, `${path} at ${width}`);
      }
      await page.context().close();
    });
  }

  test('1456 px: the full Create application form in two columns', async () => {
    const page = await signedIn({ viewport: { width: 1456, height: 836 } });
    await page.goto(`${base}/builder/create/full`);
    const boxes = await page.locator('.aw-form > .region').evaluateAll((rs) => rs.map((r) => r.getBoundingClientRect().left));
    assert.ok(new Set(boxes.map(Math.round)).size === 2, `regions in two columns: ${boxes}`);
    await noOverflow(page, 'create at 1456');
    await page.context().close();
  });

  test('axe: every settings tab at 1456 px and at 360 px', async () => {
    const found: string[] = [];
    for (const width of [1456, 360]) {
      const page = await signedIn({ viewport: { width, height: 836 } });
      for (const tab of TABS) {
        await page.goto(settings(tab));
        await page.evaluate(AXE);
        const r = await page.evaluate(() => (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }));
        for (const v of r.violations as { id: string; nodes: { html: string }[] }[]) found.push(`${tab} at ${width}: ${v.id} e.g. ${v.nodes[0]?.html.slice(0, 160)}`);
      }
      await page.context().close();
    }
    assert.deepEqual(found, []);
  });
});
