// The Create Application wizard in a real browser (sprint 87, parity handoff WIZ-4): the alias follows
// the name until it is edited, First user and Password hide for authentication None, and choosing a
// schema reloads the Pages list (with RLS badges) without leaving the page.
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

async function developer(): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
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
    await page.goto(`${base}/builder/create`);
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
    await page.goto(`${base}/builder/create`);
    await page.evaluate(() => ((window as any).__stay = true));
    assert.equal(await page.isVisible('form.create-schema button'), false, 'no button with JavaScript');
    await page.selectOption('form.create-schema select[name="schema"]', 'hr');
    await page.waitForSelector('#aw-pages input[name^="t_"][value="leave_request"]', { state: 'attached' });
    assert.equal(await page.evaluate(() => (window as any).__stay), true, 'the page was not reloaded');
    assert.match(page.url(), /\/builder\/create\?schema=hr$/);
    assert.equal(await page.inputValue('#aw-schema-fields input[name="schema"]'), 'hr');
    assert.equal(await page.inputValue('#f_name'), 'Hr');
    assert.match(await page.inputValue('#f_alias'), /^hr(-\d+)?$/);
    assert.ok((await page.locator('#aw-pages .aw-rls').count()) >= 1, 'hr has tables with row level security');
    await page.context().close();
  });
});
