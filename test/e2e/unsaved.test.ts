// Warn on unsaved changes (migration 077) in a real browser: a link or a redirect
// button asks while an item changed, submitting doesn't, an item with
// {"warn_unsaved": false} doesn't count, and closing the tab asks (beforeunload).
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
let pageId: number;
let job = '';
let sal: string;

before(async () => {
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  pageId = (await owner.one(`select p.id from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 3`)).id;
  ({ sal, job } = (await owner.one('select sal::text, job from hr.emp where empno = 7839'))!);
  await owner.query('update meta.page set warn_unsaved = true where id = $1', [pageId]);
  close = async () => {
    await owner.query('update meta.page set warn_unsaved = false where id = $1', [pageId]);
    await owner.query(`update meta.item set config = config - 'warn_unsaved' where page_id = $1 and name = 'P3_JOB'`, [pageId]);
    // the test changes the job too (an item that doesn't count) and saves
    await owner.query('update hr.emp set sal = $1, job = $2 where empno = 7839', [sal, job]);
    await browser.close();
    await app.close();
    await closePools();
  };
});
after(async () => close());

async function openKing(page: Page) {
  await page.goto(`${base}/a/hr/login`);
  await page.fill('#username', 'king');
  await page.fill('#password', 'king');
  await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
  await page.goto(`${base}/a/hr/2`);
  // the report opens the form in a dialog: open its link as a page
  const href = await page.getAttribute('a[href*="P3_EMPNO=7839"]', 'href');
  await page.goto(`${base}${href}`);
  await page.waitForSelector('form.page-form[data-warn-unsaved="on"]');
}

describe('warn on unsaved changes', () => {
  test('a link asks only when an item changed; "stay" keeps the page and its value', async () => {
    const page = await browser.newPage();
    try {
      await openKing(page);
      assert.equal(await page.evaluate(() => (window as any).pgkiln.isChanged()), false);
      // nothing changed: the link just goes
      await Promise.all([page.waitForNavigation(), page.click('#t-nav a[href="/a/hr/1"]')]);
      await page.goBack();
      await page.waitForSelector('#P3_SAL');

      await page.fill('#P3_SAL', '9999');
      assert.equal(await page.evaluate(() => (window as any).pgkiln.isChanged()), true);
      let message = '';
      page.once('dialog', (d) => {
        message = d.message();
        void d.dismiss();
      });
      await page.click('#t-nav a[href="/a/hr/1"]');
      assert.match(message, /unsaved changes/);
      assert.match(page.url(), /\/a\/hr\/3/, 'stayed on the page');
      assert.equal(await page.inputValue('#P3_SAL'), '9999');

      page.once('dialog', (d) => void d.accept());
      await Promise.all([page.waitForNavigation(), page.click('#t-nav a[href="/a/hr/1"]')]);
      assert.match(page.url(), /\/a\/hr\/1$/);
    } finally {
      await page.close();
    }
  });

  test('submitting the page doesn\'t ask; an item left out doesn\'t count', async () => {
    await owner.query(`update meta.item set config = coalesce(config, '{}') || '{"warn_unsaved": false}' where page_id = $1 and name = 'P3_JOB'`, [pageId]);
    const page = await browser.newPage();
    let asked = 0;
    page.on('dialog', (d) => {
      asked++;
      void d.dismiss();
    });
    try {
      await openKing(page);
      assert.ok(await page.$('[data-item="P3_JOB"][data-no-warn]'));
      // an item that doesn't count
      await page.$eval('#P3_JOB', (el: any) => {
        el.value = el.tagName === 'SELECT' ? [...el.options].map((o: any) => o.value).find((v: string) => v && v !== el.value) : 'X';
      });
      assert.equal(await page.evaluate(() => (window as any).pgkiln.isChanged()), false);
      // a change that is saved by the page's own button
      await page.fill('#P3_SAL', String(Number(sal) + 1));
      await Promise.all([page.waitForNavigation(), page.click('button[value="SAVE"]:not(.default-submit)')]);
      assert.equal(asked, 0);
    } finally {
      await page.close();
    }
  });

  test('closing or reloading the tab with a change asks (beforeunload)', async () => {
    const page = await browser.newPage();
    try {
      await openKing(page);
      // the page's beforeunload handler cancels the unload (the browser then asks) only with a change
      const cancels = () => page.evaluate(() => {
        const ev = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(ev);
        return ev.defaultPrevented;
      });
      assert.equal(await cancels(), false);
      await page.fill('#P3_SAL', '1');
      assert.equal(await cancels(), true);
      // after a failed submit the values on the page are not saved: it counts as changed
      await page.fill('#P3_ENAME', '');
      await Promise.all([page.waitForNavigation(), page.click('button[value="SAVE"]:not(.default-submit)')]);
      await page.waitForSelector('form.page-form[data-warn-unsaved="changed"]');
      assert.equal(await page.evaluate(() => (window as any).pgkiln.isChanged()), true);
      assert.equal(await cancels(), true);
    } finally {
      await page.close();
    }
  });
});
