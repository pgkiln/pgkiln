// The Progressive Web App in a real browser (the HR example has it on):
// installable, pages offline, forms queued offline and sent later, the
// location button and photos made smaller before upload.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools, owner } from '../../src/db.ts';
import { png } from '../../src/runtime/pwa.ts';

let base = '';
let browser: Browser;
let close: () => Promise<void>;
const REASON = `offline e2e ${Date.now()}`;

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

after(async () => {
  const ids = (await owner.query('select id from hr.leave_request where reason = $1', [REASON])).rows.map((r) => String(r.id));
  await owner.query(`delete from meta.task where detail_pk = any($1::text[]) and app_id = (select id from meta.app where alias = 'hr')`, [ids]);
  await owner.query('delete from hr.leave_request where reason = $1', [REASON]);
  await owner.query(`update hr.emp set work_location = null where empno = 7788`);
  await close();
});

async function signedIn(context: BrowserContext, user = 'king') {
  const page = await context.newPage();
  await page.goto(`${base}/a/hr/login`);
  await page.fill('#username', user);
  await page.fill('#password', user);
  await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
  return page;
}

/** Wait until the app's service worker controls the page (after a reload when it was just installed). */
async function controlled(page: Page) {
  await page.evaluate(() => navigator.serviceWorker.ready);
  if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
}

describe('Progressive Web App', () => {
  test('installable: manifest, icons and a service worker that controls the app', async () => {
    const context = await browser.newContext();
    const page = await signedIn(context);
    await controlled(page);
    const cdp = await context.newCDPSession(page);
    const manifest = await cdp.send('Page.getAppManifest');
    assert.deepEqual(manifest.errors, [], 'manifest parses');
    const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
    assert.deepEqual(installabilityErrors, [], 'Chrome can install it');
    assert.equal(await page.evaluate(() => navigator.serviceWorker.controller!.scriptURL.replace(location.origin, '')), '/a/hr/sw.js');
    await context.close();
  });

  test('offline: visited pages from the device with a notice, others get the offline page', async () => {
    const context = await browser.newContext();
    const page = await signedIn(context);
    await controlled(page);
    await page.goto(`${base}/a/hr/2`); // visited online: kept
    await context.setOffline(true);
    await page.goto(`${base}/a/hr/2`);
    assert.match(await page.locator('h1').innerText(), /Employees/);
    await page.locator('.offline-banner').waitFor();
    await page.goto(`${base}/a/hr/4`); // never opened on this device
    assert.match(await page.locator('h1').innerText(), /You're offline/);
    await page.locator('[data-offline-pages] a').first().waitFor();
    assert.ok((await page.locator('[data-offline-pages] a').allInnerTexts()).includes('/a/hr/2'));
    await context.setOffline(false);
    // signing out empties the page cache
    await page.goto(`${base}/a/hr/1`);
    await Promise.all([page.waitForNavigation(), page.locator('.t-user summary').click().then(() => page.click('text=Sign out'))]);
    const kept = await page.evaluate(async () => (await (await caches.open('pgapex-pages-/a/hr')).keys()).length);
    assert.equal(kept, 0);
    await context.close();
  });

  test('a form sent offline is kept on the device and sent when the connection is back', async () => {
    const context = await browser.newContext();
    const page = await signedIn(context);
    await controlled(page);
    await page.goto(`${base}/a/hr/7?clear=1`);
    await page.fill('#P7_START_DATE', '2027-06-07');
    await page.fill('#P7_END_DATE', '2027-06-08');
    await page.fill('#P7_REASON', REASON);
    await context.setOffline(true);
    await Promise.all([page.waitForURL(/queued=1/), page.locator('button.btn-hot[value="CREATE"]').click()]);
    await page.locator('.alert-success', { hasText: 'Saved on this device' }).waitFor();
    await page.locator('.offline-queue summary', { hasText: '1 form(s) waiting' }).waitFor();
    assert.equal((await owner.query('select 1 from hr.leave_request where reason = $1', [REASON])).rows.length, 0, 'not sent yet');

    await context.setOffline(false); // "online": app.js asks the service worker to send it
    for (let i = 0; i < 50 && !(await owner.query('select 1 from hr.leave_request where reason = $1', [REASON])).rows.length; i++) await page.waitForTimeout(200);
    const rows = (await owner.query('select empno, start_date::text, status from hr.leave_request where reason = $1', [REASON])).rows;
    assert.deepEqual(rows, [{ empno: 7839, start_date: '2027-06-07', status: 'PENDING' }], 'sent once, as king');
    await page.locator('.offline-queue').waitFor({ state: 'detached' });

    // sending it again (a resend after a lost response) changes nothing: the submission id
    const sent = await page.evaluate(() => (document.querySelector('input[name="__submit_id"]') as HTMLInputElement | null)?.value ?? null);
    assert.ok(sent);
    await context.close();
  });

  test('location button and photos made smaller before upload', async () => {
    const context = await browser.newContext({ permissions: ['geolocation'], geolocation: { latitude: 52.0116, longitude: 4.3571 } });
    const page = await signedIn(context);
    await page.goto(`${base}/a/hr/2`);
    const href = await page.locator('a[href*="P3_EMPNO=7788"]').first().getAttribute('href');
    await page.goto(`${base}${href!.replace(/&amp;/g, '&')}`);
    await page.click('[data-locate="P3_WORK_LOCATION"]');
    await page.waitForFunction(() => (document.getElementById('P3_WORK_LOCATION') as HTMLInputElement).value !== '');
    assert.equal(await page.inputValue('#P3_WORK_LOCATION'), '52.01160,4.35710');
    assert.equal(await page.getAttribute('#P3_PHOTO', 'capture'), 'environment');

    // a 2400 × 2400 PNG (noise, like a photo: it doesn't compress) becomes a JPEG of at most 1200 pixels
    const noise = new Uint8Array(2400 * 2400 * 4);
    for (let i = 0; i < noise.length; i++) noise[i] = i % 4 === 3 ? 255 : Math.floor(Math.random() * 256);
    const big = png(2400, 2400, noise);
    await page.setInputFiles('#P3_PHOTO', { name: 'big.png', mimeType: 'image/png', buffer: big });
    // (hr_45) the photo is cropped to a square first: keep the proposed part
    await page.click('dialog.crop-dialog button[value="apply"]');
    await page.waitForFunction(() => (document.getElementById('P3_PHOTO') as HTMLInputElement).files![0].type === 'image/jpeg');
    const size = await page.evaluate(async () => {
      const f = (document.getElementById('P3_PHOTO') as HTMLInputElement).files![0];
      const img = await createImageBitmap(f);
      return [img.width, img.height, f.name];
    });
    assert.deepEqual(size, [1200, 1200, 'big.jpg']);
    await context.close();
  });
});
