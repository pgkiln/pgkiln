// The search region in a real browser (migration 080): results while the user types, without
// reloading the page (the field keeps its focus), and the URL follows the search.
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

describe('search region', () => {
  test('results appear while typing; the page is not reloaded', async () => {
    const region = (await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id join meta.app a on a.id = p.app_id
                                      where a.alias = 'hr' and p.page_no = 42 and r.type = 'search'`)).id;
    const page = await browser.newPage();
    try {
      await page.goto(`${base}/a/hr/login`);
      await page.fill('#username', 'king');
      await page.fill('#password', 'king');
      await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
      await page.goto(`${base}/a/hr/42`);
      await page.evaluate(() => ((window as any).__marker = 'same page'));
      await page.click(`#R${region}_q`);
      await page.keyboard.type('scot');
      await page.locator(`#R${region}_results mark`, { hasText: /scot/i }).first().waitFor();
      assert.equal(await page.evaluate(() => (window as any).__marker), 'same page', 'no reload');
      assert.equal(await page.evaluate(() => document.activeElement?.id), `R${region}_q`, 'the field keeps its focus');
      assert.match(page.url(), new RegExp(`s${region}=scot`));
      // a result opens the employee (a dialog page)
      assert.equal(await page.locator(`#R${region}_results a.search-hit`).count(), 1);
      // clearing the field empties the results
      await page.fill(`#R${region}_q`, '');
      await page.locator(`#R${region}_q`).dispatchEvent('input');
      await page.waitForFunction((id) => !document.querySelector(`#R${id}_results .search-hit`), region);
    } finally {
      await page.close();
    }
  });
});
