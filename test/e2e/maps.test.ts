// Map and tree regions in a real browser: Leaflet runs under the strict
// Content-Security-Policy (tiles from the tile server, no inline styles or
// scripts), markers link to their page, and the tree opens and closes.
// Tile requests are answered locally (no internet needed): the browser still
// loads them from the tile server's origin, so the policy is what's tested.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools } from '../../src/db.ts';
import { png } from '../../src/runtime/pwa.ts';
import { tileOrigin } from '../../src/maptiles.ts';

let base = '';
let browser: Browser;
let close: () => Promise<void>;
const TILE = png(256, 256, new Uint8Array(256 * 256 * 4).fill(220));

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

async function signedIn() {
  const context = await browser.newContext();
  let tiles = 0;
  await context.route(`${tileOrigin()}/**`, (route) => {
    tiles++;
    return route.fulfill({ contentType: 'image/png', body: TILE });
  });
  await context.addInitScript(() => {
    (window as any).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as any).__csp.push(`${e.violatedDirective}: ${e.blockedURI || e.sample || 'inline'}`));
  });
  const page = await context.newPage();
  await page.goto(`${base}/a/hr/login`);
  await page.fill('#username', 'king');
  await page.fill('#password', 'king');
  await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
  return { context, page, tiles: () => tiles };
}

const violations = (page: Page) => page.evaluate(() => (window as any).__csp as string[]);

describe('map and tree regions', () => {
  test('the map draws with tiles and markers, without breaking the Content-Security-Policy', async () => {
    const { context, page, tiles } = await signedIn();
    await page.goto(`${base}/a/hr/4`);
    await page.locator('.leaflet-container').waitFor();
    await page.locator('.leaflet-tile-loaded').first().waitFor();
    assert.equal(await page.locator('.leaflet-marker-icon').count(), 4, 'the four offices');
    assert.ok(tiles() > 0);
    await page.locator('.leaflet-marker-icon').first().click();
    const popup = page.locator('.leaflet-popup-content');
    await popup.waitFor();
    assert.match(await popup.locator('a').getAttribute('href') ?? '', /\/a\/hr\/5\?.*P5_DEPTNO=/);
    assert.deepEqual(await violations(page), []);
    await context.close();
  });

  test('the tree opens and closes; nodes link to the record', async () => {
    const { context, page } = await signedIn();
    await page.goto(`${base}/a/hr/8`);
    const smith = page.locator('.tree-view a', { hasText: 'Smith' });
    assert.equal(await smith.isVisible(), false, 'two levels open: Smith is deeper');
    // the label is a link; the rest of the row (the count) opens the branch
    await page.locator('.tree-view summary', { hasText: 'Ford' }).locator('.tree-count').click();
    assert.equal(await smith.isVisible(), true);
    await smith.click();
    const frame = page.locator('dialog.t-dialog[open] iframe');
    await frame.waitFor();
    assert.match(await frame.getAttribute('src') ?? '', /\/a\/hr\/3\?.*P3_EMPNO=7369/);
    assert.deepEqual(await violations(page), []);
    await context.close();
  });
});
