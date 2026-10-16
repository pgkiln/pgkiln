// SQL Workshop › RESTful Services (sprint 100, AutoREST) in a real browser: REST › Enable from an object's menu,
// the object's page with its endpoints and examples, no CSP or axe-core violations, and a phone's width.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools, owner } from '../../src/db.ts';

const AXE = readFileSync(new URL('../../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
let base = '';
let browser: Browser;
let close: () => Promise<void>;
let appId: number;

before(async () => {
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  await owner.query(`delete from meta.rest_object where app_id = $1 and schema_name = 'hr' and object_name = 'dept'`, [appId]);
  close = async () => {
    await owner.query(`delete from meta.rest_object where app_id = $1 and schema_name = 'hr' and object_name = 'dept'`, [appId]);
    await browser.close();
    await app.close();
    await closePools();
  };
});
after(() => close());

async function signedIn(width = 1280) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.addInitScript(() => {
    (window as any).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as any).__csp.push(`${e.violatedDirective}: ${e.blockedURI || e.sample || 'inline'}`));
  });
  const page = await context.newPage();
  await page.goto(`${base}/builder/login`);
  await page.fill('#f_username', 'admin');
  await page.fill('#f_password', 'admin');
  await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
  return page;
}
const axe = async (page: Page) => {
  await page.evaluate(AXE);
  const r = await page.evaluate(() => (window as any).axe.run(document.querySelector('main') ?? document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }));
  return r.violations.map((v: { id: string; nodes: { html: string }[] }) => `${v.id}: ${v.nodes[0]?.html.slice(0, 120)}`);
};
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

describe('RESTful Services (browser)', () => {
  test('REST › Enable from the Object Browser menu publishes hr.dept; the page shows its endpoints', async () => {
    const page = await signedIn();
    await page.goto(`${base}/builder/sql/objects?schema=hr&k=table&o=hr.dept`);
    const menu = page.locator('details.obj-menu', { has: page.locator('summary[aria-label="Actions for dept"]') }).first();
    await menu.locator('summary').click();
    await Promise.all([page.waitForNavigation(), menu.getByText('REST › Enable / Disable').click()]);
    assert.match(page.url(), /\/builder\/sql\/rest\?schema=hr&name=dept#enable$/);
    assert.equal(await page.locator('#f_object option:checked').innerText(), 'hr.dept');
    assert.deepEqual(await axe(page), []);
    await page.check('input[name="methods"][value="POST"]');
    await Promise.all([page.waitForNavigation(), page.locator('#enable button.btn-hot').click()]);
    assert.match(page.url(), /\/builder\/sql\/rest\/\d+$/);
    const text = await page.locator('main').innerText();
    assert.match(text, /\/a\/hr\/autorest\/dept\//);
    assert.match(text, /curl /);
    assert.match(text, /openapi\.json/);
    assert.deepEqual(await axe(page), []);
    assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
    // the endpoint wants a token
    const status = await page.evaluate(async () => (await fetch('/a/hr/autorest/dept/')).status);
    assert.equal(status, 401);
    await page.context().close();
  });

  test('a phone\'s width: no page overflow, no sr-only text in the tables', async () => {
    const page = await signedIn(390);
    const id = (await owner.one(`select id from meta.rest_object where app_id = $1 and schema_name = 'hr' and object_name = 'dept'`, [appId]))?.id;
    for (const url of ['/builder/sql/rest', `/builder/sql/rest/${id}`]) {
      await page.goto(`${base}${url}`);
      assert.ok(await noOverflow(page), `${url} fits 390 px`);
      assert.equal(await page.locator('.table-wrap .sr-only').count(), 0);
    }
    assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
    await page.context().close();
  });
});
