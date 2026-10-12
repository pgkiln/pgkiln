// Data and settings in a real browser (migration 086): an address item asks the geocoder and the
// chosen address fills its coordinates item; a display image from a query shows; a per-user item
// comes back in a new session.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools, owner } from '../../src/db.ts';

let base = '';
let browser: Browser;
let geocoder: Server;
let close: () => Promise<void>;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

before(async () => {
  geocoder = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify([
      { display_name: 'Markt 1, Delft, Nederland', lat: '52.011600', lon: '4.357100' },
      { display_name: 'Markt, Breda, Nederland', lat: '51.5888', lon: '4.7759' },
    ]));
  });
  await new Promise<void>((r) => geocoder.listen(0, '127.0.0.1', r));
  process.env.GEOCODER_URL = `http://127.0.0.1:${(geocoder.address() as AddressInfo).port}/search`;
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  await owner.query(`update hr.emp set photo = $1, photo_mime = 'image/png' where ename = 'SCOTT'`, [PNG]);
  close = async () => {
    await owner.query(`update hr.emp set photo = null, photo_mime = null where ename = 'SCOTT'`);
    await owner.query(`delete from meta.user_preference where app_id = (select id from meta.app where alias = 'hr')`);
    delete process.env.GEOCODER_URL;
    geocoder.close();
    await browser.close();
    await app.close();
    await closePools();
  };
});
after(async () => close());

async function signIn(page: Page) {
  await page.goto(`${base}/a/hr/login`);
  await page.fill('#username', 'king');
  await page.fill('#password', 'king');
  await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
  await page.goto(`${base}/a/hr/43`);
}

describe('data and settings', () => {
  test('Check address offers the places; the one chosen fills the address and its position', async () => {
    const page = await browser.newPage();
    try {
      await signIn(page);
      await page.fill('#P43_ADDRESS', 'Markt 1 Delft');
      await page.getByRole('button', { name: 'Check address' }).click();
      const choice = page.getByRole('option').getByRole('button', { name: 'Markt 1, Delft, Nederland' });
      await choice.waitFor();
      await choice.click();
      assert.equal(await page.inputValue('#P43_ADDRESS'), 'Markt 1, Delft, Nederland');
      assert.equal(await page.inputValue('#P43_LOCATION'), '52.01160,4.35710');
      assert.equal(await page.locator('#P43_ADDRESS_places').isHidden(), true);
    } finally {
      await page.close();
    }
  });

  test('a per-user item comes back in a new session, with the photo of its employee', async () => {
    const scott = String((await owner.one(`select empno from hr.emp where ename = 'SCOTT'`)).empno);
    let page = await browser.newPage();
    try {
      await signIn(page);
      // both lists submit on change
      await Promise.all([page.waitForNavigation(), page.selectOption('#P43_DEPTNO', '20')]);
      await Promise.all([page.waitForNavigation(), page.selectOption('#P43_EMPNO', scott)]);
      const img = page.locator('#P43_PHOTO img');
      await img.waitFor();
      assert.equal(await img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth), 1, 'the picture loaded (the CSP allows it)');
    } finally {
      await page.close();
    }
    page = await (await browser.newContext()).newPage();
    try {
      await signIn(page);
      assert.equal(await page.inputValue('#P43_DEPTNO'), '20');
      assert.equal(await page.inputValue('#P43_EMPNO'), scott);
    } finally {
      await page.close();
    }
  });
});
