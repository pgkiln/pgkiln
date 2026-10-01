// Template components in a real browser: a plug-in file is imported and
// previewed in the builder, its region settings are saved in the page
// designer, and at run time a card's #LINK# opens the modal form as a
// dialog, all without breaking the Content-Security-Policy.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools, owner } from '../../src/db.ts';

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
  close = async () => {
    await owner.query(`delete from meta.template_component where app_id = $1 and static_id = 'e2e_badge'`, [appId]);
    await browser.close();
    await app.close();
    await closePools();
  };
});
after(() => close());

async function open(url: string, user: string, password: string, userField = '#username', passField = '#password') {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    (window as any).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as any).__csp.push(`${e.violatedDirective}: ${e.blockedURI || e.sample || 'inline'}`));
  });
  const page = await context.newPage();
  await page.goto(`${base}${url}`);
  await page.fill(userField, user);
  await page.fill(passField, password);
  await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
  return page;
}

const violations = (page: Page) => page.evaluate(() => (window as any).__csp as string[]);

describe('template components', () => {
  test('builder: import a plug-in file, preview it, set a region to use it', async () => {
    const page = await open('/builder/login', 'admin', 'admin', '#f_username', '#f_password');
    await page.goto(`${base}/builder/apps/${appId}/shared?new=template_component`);
    const doc = JSON.parse(readFileSync(new URL('../../examples/plugins/status-badge.plugin.json', import.meta.url), 'utf8'));
    await page.fill('#f_tc_plugin', JSON.stringify({ ...doc, static_id: 'e2e_badge', name: 'E2E badge' }));
    await Promise.all([page.waitForNavigation(), page.click('button:has-text("Import plug-in")')]);
    assert.match(await page.locator('.alert-success').innerText(), /E2E badge imported/);

    // the preview with sample rows
    await page.fill('#f_tc_sample', 'STATUS=approved\n\nSTATUS=<b>late</b>');
    await Promise.all([page.waitForNavigation(), page.click('.tc-preview-form button')]);
    const preview = page.locator('.tc-preview');
    assert.equal(await preview.locator('.tc-badge-success').innerText(), 'approved');
    assert.equal(await preview.locator('.tc-badge-neutral').innerText(), '<b>late</b>', 'markup in data is text');
    assert.equal(await preview.locator('b').count(), 0);

    // the region on page 19 switches to it, with an attribute
    const r = await owner.one(`select r.id, r.page_id, r.config from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 19 and r.type = 'template_component' order by r.seq limit 1`, [appId]);
    try {
      await page.goto(`${base}/builder/pages/${r.page_id}?c=region-${r.id}`);
      // the settings are on the property editor's Attributes tab, which stays open after a save
      await page.click('[data-tabs="pd-right"] [role=tab]:has-text("Attributes")');
      await page.selectOption(`#tc_${r.id}_component`, 'e2e_badge');
      await Promise.all([page.waitForNavigation(), page.click('button:has-text("Save template component settings")')]);
      await page.fill(`#tc_${r.id}_attr_LABEL`, '#name#');
      await Promise.all([page.waitForNavigation(), page.click('button:has-text("Save template component settings")')]);
      const cfg = (await owner.one('select config from meta.region where id = $1', [r.id])).config;
      assert.equal(cfg.component, 'e2e_badge');
      assert.deepEqual(cfg.attributes, { LABEL: '#name#' });
      assert.deepEqual(await violations(page), []);
    } finally {
      await owner.query('update meta.region set config = $2 where id = $1', [r.id, JSON.stringify(r.config)]);
    }
    await page.context().close();
  });

  test('run time: cards link to the modal form, the timeline and badges show', async () => {
    const page = await open('/a/hr/login', 'king', 'king');
    await page.goto(`${base}/a/hr/19`);
    assert.ok((await page.locator('.tc-grid .tc-card').count()) > 5);
    assert.ok((await page.locator('ol.tc-timeline > li.tc-timeline-item').count()) > 0);
    assert.ok((await page.locator('td.tc-cell .tc-badge').count()) > 0);
    await page.locator('.tc-card a[data-dialog]').filter({ hasText: 'King' }).click();
    const frame = page.frameLocator('#t-dialog iframe');
    await frame.locator('#P3_ENAME').waitFor();
    assert.equal(await frame.locator('#P3_ENAME').inputValue(), 'KING');
    assert.deepEqual(await violations(page), []);
    await page.context().close();
  });
});
