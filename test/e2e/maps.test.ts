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
  const referers = new Set<string>();
  await context.route(`${tileOrigin()}/**`, (route) => {
    tiles++;
    referers.add(route.request().headers().referer ?? '(none)');
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
  return { context, page, tiles: () => tiles, referers: () => [...referers] };
}

const violations = (page: Page) => page.evaluate(() => (window as any).__csp as string[]);

describe('map and tree regions', () => {
  test('the map draws with tiles and markers, without breaking the Content-Security-Policy', async () => {
    const { context, page, tiles, referers } = await signedIn();
    await page.goto(`${base}/a/hr/4`);
    await page.locator('.leaflet-container').waitFor();
    await page.locator('.leaflet-tile-loaded').first().waitFor();
    assert.equal(await page.locator('.leaflet-marker-icon').count(), 4, 'the four offices');
    assert.ok(tiles() > 0);
    // OpenStreetMap blocks tile requests without a Referer; only the origin is sent, never the page
    assert.deepEqual(referers(), [`${base}/`]);
    await page.locator('.leaflet-marker-icon').first().click();
    const popup = page.locator('.leaflet-popup-content');
    await popup.waitFor();
    assert.match(await popup.locator('a').getAttribute('href') ?? '', /\/a\/hr\/5\?.*P5_DEPTNO=/);
    assert.deepEqual(await violations(page), []);
    await context.close();
  });

  test('a heat map paints its canvas with a legend; moving the other map offers to filter the list to that area', async () => {
    const { context, page } = await signedIn();
    await page.goto(`${base}/a/hr/16`);
    const heat = page.locator('canvas.map-heat');
    await heat.waitFor();
    // some pixels of the heat layer are painted (in the ramp's blue)
    const painted = await heat.evaluate((c: HTMLCanvasElement) => {
      const px = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < px.length; i += 4) if (px[i] > 0 && px[i - 1] > px[i - 3]) n++;
      return n;
    });
    assert.ok(painted > 100, `painted pixels: ${painted}`);
    assert.equal(await page.locator('.map-legend').count(), 1);
    // the offices map: no button until the user moves the map
    const offices = page.locator('[data-map]').nth(1);
    const go = page.locator('.map-filter-go');
    assert.equal(await go.isVisible(), false);
    await offices.scrollIntoViewIfNeeded();
    // zoom in on Chicago (the marker west of the lakes)
    const chicago = await page.evaluate(() => {
      const maps = document.querySelectorAll('[data-map]');
      const icons = [...maps[1].querySelectorAll('.leaflet-marker-icon')].map((m) => m.getAttribute('title'));
      return icons.indexOf('SALES');
    });
    const marker = offices.locator('.leaflet-marker-icon').nth(chicago);
    const box = (await marker.boundingBox())!;
    const map = (await offices.boundingBox())!;
    for (let i = 0; i < 3; i++) {
      await offices.dblclick({ position: { x: box.x + box.width / 2 - map.x, y: box.y + box.height - 4 - map.y } });
      await page.waitForTimeout(500);
    }
    await go.waitFor();
    await Promise.all([page.waitForNavigation(), go.click()]);
    assert.match(decodeURIComponent(page.url()), /\?r\d+_bb=-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/);
    const rows = await page.locator('table.report tbody tr').allTextContents();
    assert.ok(rows.length > 0 && rows.every((r) => r.includes('Chicago')), rows.join(' | '));
    assert.equal(await page.locator('.chip', { hasText: 'Map area' }).count(), 1);
    // "Show everything" takes the filter away again
    await Promise.all([page.waitForNavigation(), page.locator('.map-filter-clear').click()]);
    assert.equal(await page.locator('.chip', { hasText: 'Map area' }).count(), 0);
    assert.deepEqual(await violations(page), []);
    await context.close();
  });

  test('several layers: clustered visits, coloured layers, a legend that switches layers; filtering by the distance from the centre', async () => {
    const { context, page } = await signedIn();
    await page.goto(`${base}/a/hr/33`);
    await page.locator('.leaflet-container').waitFor();
    const clusters = page.locator('.map-cluster');
    await clusters.first().waitFor();
    // every visit is in a cluster or a dot of its own
    const counted = async () => {
      const inClusters = (await clusters.allTextContents()).reduce((a, t) => a + Number(t), 0);
      return inClusters + (await page.locator('path.map-dot.map-c1').count());
    };
    assert.equal(await counted(), 80);
    const before = await clusters.count();
    assert.ok(before > 0 && before < 80);
    assert.match((await clusters.first().getAttribute('title')) ?? '', /^\d+ places: zoom in$/);
    assert.equal(await page.locator('path.map-dot.map-c2').count(), 4, 'the offices');
    assert.equal(await page.locator('path.leaflet-interactive.map-c3').count(), 7, 'four areas and three routes');
    assert.equal(await page.locator('canvas.map-heat').count(), 0, 'the heat map is off at first');
    // the legend switches layers
    const legend = page.locator('.map-layers');
    assert.deepEqual(await legend.locator('label').allTextContents(), ['Visits', 'Offices', 'Sales areas', 'Visit density']);
    await legend.locator('label', { hasText: 'Offices' }).locator('input').uncheck();
    assert.equal(await page.locator('path.map-dot.map-c2').count(), 0);
    await legend.locator('label', { hasText: 'Visit density' }).locator('input').check();
    await page.locator('canvas.map-heat').waitFor();
    assert.equal(await page.locator('.map-legend').count(), 1);
    // a click on a cluster zooms in to its places
    const zoom = () => page.evaluate(() => document.querySelector('.leaflet-container .leaflet-tile-container img')?.getAttribute('src') ?? '');
    const tileBefore = await zoom();
    await clusters.first().click();
    await page.waitForTimeout(600);
    assert.notEqual(await zoom(), tileBefore, 'the map zoomed in');
    assert.equal(await counted(), 80, 'still every visit, regrouped');
    // the map was moved: "Show places within … km of the centre"
    const go = page.locator('.map-filter-go');
    await go.waitFor();
    assert.match((await go.textContent()) ?? '', /^Show places within [\d.,]+ km of the centre$/);
    await Promise.all([page.waitForNavigation(), go.click()]);
    assert.match(decodeURIComponent(page.url()), /\?r\d+_near=-?\d+(\.\d+)?,-?\d+(\.\d+)?,\d+(\.\d+)?$/);
    assert.equal(await page.locator('.chip', { hasText: /Within [\d.,]+ km/ }).count(), 1);
    await page.locator('path.map-near').waitFor({ state: 'attached' });
    await Promise.all([page.waitForNavigation(), page.locator('.map-filter-clear').click()]);
    assert.equal(await page.locator('.chip', { hasText: 'Within' }).count(), 0);
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
