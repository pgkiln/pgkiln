// Quick edit from the developer toolbar and the Page Designer's help pane in a
// real browser (sprint 59): a developer signed in to the builder and to the
// HR application clicks a region and an item of a page and gets them in the
// Page Designer; the help pane follows the focused property.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type BrowserContext } from 'playwright';
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

async function developer(): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${base}/builder/login`);
  await page.fill('#f_username', 'admin');
  await page.fill('#f_password', 'admin');
  await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
  await page.goto(`${base}/a/hr/login`);
  await page.fill('#username', 'king');
  await page.fill('#password', 'king');
  await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
  await page.close();
  return context;
}

describe('quick edit and the help pane (browser)', () => {
  test('Quick edit: a click on a region or an item opens it in the Page Designer; Esc ends it', async () => {
    const context = await developer();
    const page = await context.newPage();
    await page.goto(`${base}/a/hr/44`);
    const region = (await owner.one(`select r.id, r.page_id, p.app_id from meta.region r join meta.page p on p.id = r.page_id join meta.app a on a.id = p.app_id
                                       where a.alias = 'hr' and p.page_no = 44 and r.title = 'Welcome to HR'`));
    const toggle = page.locator('[data-quick-edit]');
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
    await page.hover(`#R${region.id} .region-hero-text`);
    assert.match((await page.locator(`#R${region.id}`).getAttribute('class')) ?? '', /qe-target/);
    const [designer] = await Promise.all([context.waitForEvent('page'), page.click(`#R${region.id} .region-hero-text`)]);
    await designer.waitForLoadState();
    assert.equal(new URL(designer.url()).pathname + new URL(designer.url()).search, `/builder/apps/${region.app_id}/pages/44?c=region-${region.id}`, '(sprint 86) the page designer by the page\'s number');
    assert.match(page.url(), /\/a\/hr\/44$/, 'the page itself stays');
    // an item, on a page with items
    await page.goto(`${base}/a/hr/43`);
    await page.click('[data-quick-edit]');
    // the builder's tab is reused (window.open with its name)
    await page.click('[data-item="P43_ADDRESS"] label');
    await designer.waitForURL(/\?c=item-\d+$/);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('[data-quick-edit]').getAttribute('aria-pressed'), 'false');
    await context.close();
  });

  test('the help pane shows the focused property\'s help and its guide section', async () => {
    const context = await developer();
    const page = await context.newPage();
    const region = await owner.one(`select r.id, r.page_id from meta.region r join meta.page p on p.id = r.page_id join meta.app a on a.id = p.app_id
                                     where a.alias = 'hr' and p.page_no = 44 and r.title = 'Welcome to HR'`);
    await page.goto(`${base}/builder/pages/${region.page_id}?c=region-${region.id}`);
    const pane = page.locator('[data-pe-help]');
    assert.match(await pane.innerText(), /Select a property/);
    await page.locator('.pe [data-prop="template"] select').focus();
    assert.match(await pane.locator('h3').innerText(), /Template/);
    assert.match(await pane.innerText(), /hero: a large banner/);
    assert.match(await pane.innerText(), /Stored as template/);
    assert.equal(await pane.locator('a', { hasText: 'This component in the guide' }).getAttribute('href'), 'https://pgkiln.vargar.eu/docs/pages-and-regions#static-and-dynamic-content');
    await context.close();
  });
});

describe('values kept under pgkiln\'s old name (browser)', () => {
  test('(sprint 86) pgapex.* in localStorage moves to pgkiln.* once; a value under the new name wins', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${base}/a/hr/login`);
    await page.evaluate(() => {
      localStorage.clear();
      localStorage.setItem('pgapex.nav', 'closed');
      localStorage.setItem('pgapex.builder.pd-tab', 'tree');
      localStorage.setItem('pgapex.devbar', '{"dock":"top"}');
      localStorage.setItem('pgkiln.devbar', '{"dock":"left"}');
      sessionStorage.setItem('pgapex.rds./a/hr/1.x', 'R1_tab');
    });
    await page.reload();
    const kept = await page.evaluate(() => ({ ...localStorage, ...Object.fromEntries(Object.entries(sessionStorage).map(([k, v]) => [`s:${k}`, v])) }));
    assert.equal(kept['pgkiln.nav'], 'closed');
    assert.equal(kept['pgkiln.builder.pd-tab'], 'tree');
    assert.equal(kept['pgkiln.devbar'], '{"dock":"left"}', 'the newer value wins');
    assert.equal(kept['s:pgkiln.rds./a/hr/1.x'], 'R1_tab');
    assert.deepEqual(Object.keys(kept).filter((k) => /pgapex/.test(k)), []);
    await context.close();
  });
});
