// The Create Application wizard in a real browser (sprint 87, parity handoff WIZ-4): the alias follows
// the name until it is edited, First user and Password hide for authentication None, and choosing a
// schema reloads the Pages list (with RLS badges) without leaving the page.
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

async function developer(opts: { width?: number; javaScriptEnabled?: boolean } = {}): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: opts.width ?? 1280, height: 900 }, javaScriptEnabled: opts.javaScriptEnabled ?? true })).newPage();
  await page.goto(`${base}/builder/login`);
  await page.fill('#f_username', 'admin');
  await page.fill('#f_password', 'admin');
  await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
  return page;
}

describe('the Create Application wizard (browser)', () => {
  test('the alias follows the name until it is edited; authentication None hides the first user', async () => {
    const page = await developer();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/builder/create/full`);
    await page.fill('#f_name', 'Café Orders 2026!');
    assert.equal(await page.inputValue('#f_alias'), 'cafe-orders-2026');
    await page.fill('#f_name', '2026 plan');
    assert.equal(await page.inputValue('#f_alias'), 'app-2026-plan');
    await page.fill('#f_alias', 'myplan');
    await page.fill('#f_name', 'Something else');
    assert.equal(await page.inputValue('#f_alias'), 'myplan', 'edited: no longer follows');
    assert.equal(await page.isVisible('#f_admin_user'), true);
    await page.selectOption('#f_authentication', 'none');
    assert.equal(await page.isVisible('#f_admin_user'), false);
    assert.equal(await page.isVisible('#f_admin_password'), false);
    await page.selectOption('#f_authentication', 'app_users');
    assert.equal(await page.isVisible('#f_admin_password'), true);
    assert.deepEqual(errors, []);
    await page.context().close();
  });

  test('choosing a schema reloads the Pages list in place, with the name and alias proposed for it', async () => {
    const page = await developer();
    await page.goto(`${base}/builder/create/full`);
    await page.evaluate(() => ((window as any).__stay = true));
    assert.equal(await page.isVisible('button[form="aw-schema-get"]'), false, 'no button with JavaScript');
    await page.selectOption('select[name="schema"][form="aw-schema-get"]', 'hr');
    await page.waitForSelector('#aw-pages input[name^="t_"][value="leave_request"]', { state: 'attached' });
    assert.equal(await page.evaluate(() => (window as any).__stay), true, 'the page was not reloaded');
    assert.match(page.url(), /\/builder\/create\/full\?schema=hr$/);
    assert.equal(await page.inputValue('#aw-schema-fields input[name="schema"]'), 'hr');
    assert.equal(await page.inputValue('#f_name'), 'Hr');
    assert.match(await page.inputValue('#f_alias'), /^hr(-\d+)?$/);
    assert.ok((await page.locator('#aw-pages .aw-rls').count()) >= 1, 'hr has tables with row level security');
    // (UX-7) the footer's summary counts the pages and follows the choices
    assert.match(await page.textContent('#aw-summary') ?? '', /^\d+ pages on hr · App users/);
    await page.selectOption('#f_authentication', 'none');
    assert.match(await page.textContent('#aw-summary') ?? '', /^\d+ pages on hr · None/);
    await page.context().close();
  });

  test('(UX-7) at 1366 × 768 the name, the schema and Create are on screen without scrolling', async () => {
    const page = await developer();
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto(`${base}/builder/create/full`);
    const inView = async (sel: string) => {
      const box = await page.locator(sel).first().boundingBox();
      return !!box && box.y >= 0 && box.y + box.height <= 768;
    };
    for (const sel of ['#f_name', '#f_schema', '.aw-footer button.btn-hot']) assert.ok(await inView(sel), sel);
    assert.equal(await page.evaluate(() => window.scrollY), 0);
  });
});

// (sprint 196, NX-U1) the short Create screen: a name and Enter creates and opens the application
describe('Create application in one field (browser)', () => {
  const ALIASES = ['e2e-quick-196', 'e2e-quick-196-2', 'e2e-nojs-196'];
  let madeAccount = false;
  const drop = async () => {
    for (const a of ALIASES) {
      const n = a.replace(/-/g, '_');
      await owner.query('delete from meta.app where alias = $1', [a]);
      await owner.query(`drop schema if exists ${n} cascade`);
      await owner.query(`drop owned by app_${n} cascade`).catch(() => {});
      await owner.query(`drop role if exists app_${n}`);
    }
  };
  before(async () => {
    await drop();
    // the developer has an account in Users: the name is the only field
    madeAccount = !(await owner.one(`select 1 as ok from meta.account where lower(username) = 'admin'`));
    if (madeAccount) await owner.query(`insert into meta.account (username, password_hash) values ('admin', meta.hash_password('E2e-quick-196!'))`);
  });
  after(async () => {
    await drop();
    if (madeAccount) await owner.query(`delete from meta.account where username = 'admin'`);
  });

  test('typing a name and pressing Enter creates and opens the application (keyboard only)', async () => {
    const page = await developer();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/builder/create`);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'f_name', 'the name has the focus');
    await page.keyboard.type('E2E Quick 196');
    assert.equal(await page.getAttribute('#f_alias', 'placeholder'), 'e2e-quick-196', 'the alias it will get');
    await Promise.all([page.waitForURL(/\/builder\/apps\/\d+$/), page.keyboard.press('Enter')]);
    const a = await owner.one(`select id, name, authentication from meta.app where alias = 'e2e-quick-196'`);
    assert.deepEqual([a.name, a.authentication], ['E2E Quick 196', 'app_users']);
    assert.ok(page.url().endsWith(`/builder/apps/${a.id}`));
    assert.match(await page.textContent('body') ?? '', /Application e2e-quick-196 created/);
    // the full form is a link under it, reached with the keyboard
    await page.goto(`${base}/builder/create`);
    await page.focus('a.create-source[href="/builder/create/full"]');
    await Promise.all([page.waitForURL(/\/builder\/create\/full$/), page.keyboard.press('Enter')]);
    assert.equal(await page.isVisible('.aw-footer button.btn-hot'), true);
    assert.deepEqual(errors, []);
    await page.context().close();
  });

  test('at 360 px and without JavaScript: on screen, no sideways scrolling, and Enter still creates', async () => {
    const page = await developer({ width: 360, javaScriptEnabled: false });
    await page.goto(`${base}/builder/create`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal scroll');
    for (const sel of ['#f_name', '#f_alias', '.aw-quick button.btn-hot']) {
      const box = await page.locator(sel).boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= 360, sel);
    }
    await page.fill('#f_name', 'E2E NoJS 196');
    await page.fill('#f_alias', 'e2e-nojs-196');
    await Promise.all([page.waitForURL(/\/builder\/apps\/\d+$/), page.press('#f_name', 'Enter')]);
    assert.ok(await owner.one(`select 1 as ok from meta.app where alias = 'e2e-nojs-196'`));
    // an error comes back to the short screen with the name kept
    await page.goto(`${base}/builder/create`);
    await page.fill('#f_name', 'E2E NoJS again');
    await page.fill('#f_alias', 'e2e-nojs-196');
    await page.press('#f_name', 'Enter');
    await page.waitForSelector('.alert-error');
    assert.match(await page.textContent('.alert-error') ?? '', /already exists/);
    assert.equal(await page.inputValue('#f_name'), 'E2E NoJS again');
    await page.context().close();
  });
});
