// Sprint 239 in a real browser: a signature drawn with a finger on a phone (390 px) is posted as a PNG and stored with
// the leave request; Clear empties the pad; and a scan button reads a QR code with the bundled zxing-wasm decoder where
// the browser has no BarcodeDetector (as Safari on iOS), served by pgkiln itself, inside the page's CSP.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools, owner } from '../../src/db.ts';
import { qrSvg } from '../../src/qrcode.ts';
import { pngSize } from '../../src/runtime/files.ts';

let base = '';
let browser: Browser;
let close: () => Promise<void>;
const REASON = 'sprint 239 e2e signature';
const alias = 'scan-e2e-239';
const ROLE = 'pgkiln_e2e239_scan';
const CODE = 'PGK-239-0042';

before(async () => {
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  await owner.query(`delete from meta.app where alias = $1`, [alias]);
  await owner.query(`drop role if exists ${ROLE}`);
  await owner.query(`create role ${ROLE} nologin`);
  await owner.query(`grant ${ROLE} to pgkiln_runtime`);
  const appId = (await owner.one(`insert into meta.app (alias, name, authentication, db_role) values ($1, 'Scan', 'none', $2) returning id`, [alias, ROLE])).id;
  const p = (await owner.one(`insert into meta.page (app_id, page_no, name, requires_auth) values ($1, 1, 'Scan', false) returning id`, [appId])).id;
  const r = (await owner.one(`insert into meta.region (page_id, seq, title, type, source) values ($1, 1, 'Main', 'static', 'main') returning id`, [p])).id;
  await owner.query(`insert into meta.item (page_id, region_id, seq, name, label, type, config) values ($1, $2, 1, 'P1_CODE', 'Article code', 'text', '{"scan": true}')`, [p, r]);
  close = async () => {
    await owner.query(`delete from hr.leave_request where reason like $1`, [`${REASON}%`]);
    await owner.query(`delete from meta.app where alias = $1`, [alias]);
    await owner.query(`drop role if exists ${ROLE}`);
    await browser.close();
    await app.close();
    await closePools();
  };
});
after(() => close());

/** A context that records CSP violations. */
async function contextWith(opts: Parameters<Browser['newContext']>[0]) {
  const context = await browser.newContext(opts);
  await context.addInitScript(() => {
    (window as any).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as any).__csp.push(`${e.violatedDirective}: ${e.blockedURI || e.sample || 'inline'}`));
  });
  return context;
}

async function signIn(context: BrowserContext, user: string) {
  const page = await context.newPage();
  await page.goto(`${base}/a/hr/login`);
  await page.fill('#username', user);
  await page.fill('#password', user);
  await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
  return page;
}

/** A finger stroke across the pad (real touch events, which the browser turns into pointer events). */
async function swipe(page: Page, context: BrowserContext, points: [number, number][]) {
  const box = (await page.locator('#P7_SIGNATURE_PAD').boundingBox())!;
  const cdp = await context.newCDPSession(page);
  const at = ([x, y]: [number, number]) => [{ x: box.x + x * box.width, y: box.y + y * box.height }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(points[0]) });
  for (const p of points.slice(1)) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(p) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

const chosen = (page: Page) => page.evaluate(() => [...(document.getElementById('P7_SIGNATURE') as HTMLInputElement).files!].map((f) => `${f.name} ${f.type} ${f.size > 100}`));

describe('signature item on a phone', () => {
  test('drawn with a finger at 390 px, cleared, drawn again and stored as a PNG with the leave request', async () => {
    const context = await contextWith({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    const page = await signIn(context, 'allen');
    await page.goto(`${base}/a/hr/7?clear=1`);
    const pad = page.locator('#P7_SIGNATURE_PAD');
    await pad.scrollIntoViewIfNeeded();
    assert.ok(await pad.isVisible(), 'app.js shows the pad');
    assert.equal(await page.locator('.signature-upload').getAttribute('open'), null, 'the upload alternative is folded away');
    const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    assert.ok(fits, 'no horizontal scrolling at 390 px');
    const width = (await pad.boundingBox())!.width;
    assert.ok(width > 250 && width <= 390, `the pad uses the width (${width})`);
    const scrollY = await page.evaluate(() => window.scrollY);
    await swipe(page, context, [[0.1, 0.5], [0.3, 0.2], [0.5, 0.8], [0.7, 0.3], [0.9, 0.6]]);
    await page.waitForFunction(() => (document.getElementById('P7_SIGNATURE') as HTMLInputElement).files!.length === 1);
    assert.deepEqual(await chosen(page), ['signature.png image/png true']);
    assert.equal(await page.evaluate(() => window.scrollY), scrollY, 'the page did not scroll under the finger');
    // the clear button: named, and it empties the pad and the file input
    await page.getByRole('button', { name: 'Clear signature' }).click();
    assert.deepEqual(await chosen(page), []);
    await swipe(page, context, [[0.2, 0.7], [0.4, 0.3], [0.6, 0.7], [0.8, 0.3]]);
    await page.waitForFunction(() => (document.getElementById('P7_SIGNATURE') as HTMLInputElement).files!.length === 1);
    const day = 3000 + Math.floor(Math.random() * 900);
    await page.fill('#P7_START_DATE', new Date(Date.now() + day * 864e5).toISOString().slice(0, 10));
    await page.fill('#P7_END_DATE', new Date(Date.now() + (day + 6) * 864e5).toISOString().slice(0, 10));
    await page.fill('#P7_REASON', `${REASON} touch`);
    await Promise.all([page.waitForNavigation(), page.click('button.btn[value="CREATE"]')]);
    const row = await owner.one(`select signature from hr.leave_request where reason = $1`, [`${REASON} touch`]);
    assert.ok(row?.signature, 'stored');
    const size = pngSize(row.signature);
    assert.ok(size && size.width >= (width - 4) * 2 && size.width <= width * 2, `a PNG at the device's resolution (${JSON.stringify(size)})`);
    assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
    await context.close();
  });
});

describe('scan without BarcodeDetector', () => {
  test('the bundled zxing-wasm decoder reads a QR code from the camera, from pgkiln\'s own files, within the CSP', async () => {
    const context = await contextWith({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const svg = qrSvg(CODE, { px: 8 })!;
    // as Safari on iOS: no BarcodeDetector; the camera shows a QR code (a canvas stream)
    // (a string: functions compiled by tsx carry helpers the page doesn't have)
    await context.addInitScript(`
      delete window.BarcodeDetector;
      const canvas = document.createElement('canvas');
      canvas.width = 480;
      canvas.height = 480;
      const g = canvas.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, 480, 480);
      const img = new Image();
      img.onload = () => g.drawImage(img, 90, 90, 300, 300);
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(${JSON.stringify(svg)});
      // a stream only sends frames when the canvas changes: touch a corner pixel now and then
      setInterval(() => { g.fillStyle = Math.random() < 0.5 ? '#fff' : '#fefefe'; g.fillRect(0, 0, 1, 1); }, 50);
      Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: async () => canvas.captureStream(15) }, configurable: true });
    `);
    const page = await context.newPage();
    const requests: string[] = [];
    page.on('request', (r) => requests.push(r.url()));
    const res = await page.goto(`${base}/a/${alias}/1`);
    assert.match(String(res!.headers()['content-security-policy']), /script-src 'self' 'wasm-unsafe-eval';/);
    const scan = page.locator('[data-scan="P1_CODE"]');
    assert.ok(await scan.isVisible(), 'the scan button is shown without BarcodeDetector');
    await scan.click();
    await page.waitForFunction((code) => (document.getElementById('P1_CODE') as HTMLInputElement).value === code, CODE, { timeout: 20000 });
    assert.equal(await page.locator('dialog.scan-dialog').count(), 0, 'the dialog closed');
    assert.ok(requests.some((u) => u.startsWith(`${base}/static/vendor/zxing/zxing_reader.wasm`)), 'the WebAssembly came from pgkiln');
    assert.deepEqual(requests.filter((u) => !u.startsWith(base) && !u.startsWith('data:')), [], 'nothing from elsewhere');
    assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
    await context.close();
  });
});
