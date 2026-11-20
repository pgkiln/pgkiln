// Mail services in a real browser: Test connection answers in place, the form keeps what was typed.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright';
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
after(async () => close());

describe('mail services', () => {
  test('Test connection answers on the page; what was typed stays', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${base}/builder/login`);
      await page.fill('#f_username', 'admin');
      await page.fill('#f_password', 'admin');
      await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
      await page.goto(`${base}/builder/mail/new?provider=smtp`);
      await page.fill('#f_name', 'E2E_TYPED');
      await page.fill('#f_secret', 'typed-secret');
      await page.evaluate(() => ((window as any).__marker = 'same page'));
      await page.click('button[name="check"][value="connection"]');
      // no host yet: the check names it, on the page
      await page.locator('.mail-check-result .alert-error', { hasText: 'The SMTP host is required' }).waitFor();
      assert.equal(await page.evaluate(() => (window as any).__marker), 'same page', 'no reload');
      assert.equal(await page.inputValue('#f_secret'), 'typed-secret');
      assert.equal(await page.inputValue('#f_name'), 'E2E_TYPED');
    } finally {
      await page.close();
    }
  });

  // (sprint 236) several services per application: link a second one to HR and make it the default, at phone width
  test('a second service for an application; Default moves the default there', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
    const before = (await owner.query('select service_id, is_default from meta.app_mail_service where app_id = $1', [appId])).rows;
    await owner.query(`delete from meta.mail_service where name in ('E2E_FIRST', 'E2E_SECOND')`);
    // HR's default for this test (other test files may have changed HR's services)
    const first = (await owner.one(`insert into meta.mail_service (name, provider, senders) values ('E2E_FIRST', 'log', '{@first.example}') returning id`)).id;
    await owner.query(`insert into meta.app_mail_service (app_id, service_id, from_address, is_default) values ($1, $2, 'hr@first.example', true)`, [appId, first]);
    const svc = (await owner.one(`insert into meta.mail_service (name, provider, senders) values ('E2E_SECOND', 'log', '{@second.example}') returning id`)).id;
    try {
      await page.goto(`${base}/builder/login`);
      await page.fill('#f_username', 'admin');
      await page.fill('#f_password', 'admin');
      await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
      await page.goto(`${base}/builder/mail/${svc}`);
      await page.check(`input[name="allow"][value="${appId}"]`);
      await page.check(`input[name="default"][value="${appId}"]`);
      await page.fill(`input[name="from_${appId}"]`, 'hr@second.example');
      await Promise.all([page.waitForNavigation(), page.click(`form[action="/builder/mail/${svc}/apps"] button.btn-hot`)]);
      await page.locator('.alert', { hasText: 'Applications saved' }).waitFor();
      assert.ok(await page.isChecked(`input[name="default"][value="${appId}"]`));
      const cell = await page.locator(`input[name="allow"][value="${appId}"]`).locator("xpath=ancestor::td").innerText();
      assert.match(cell, /also: .*E2E_FIRST/);
      assert.equal((await owner.one('select is_default from meta.app_mail_service where app_id = $1 and service_id = $2', [appId, svc])).is_default, true);
      // no horizontal scrolling at 390 px
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    } finally {
      await owner.query('delete from meta.mail_service where id = any($1::int[])', [[svc, first]]);
      for (const r of before) if (r.is_default) await owner.query('update meta.app_mail_service set is_default = true where app_id = $1 and service_id = $2', [appId, r.service_id]);
      await page.close();
    }
  });
});
