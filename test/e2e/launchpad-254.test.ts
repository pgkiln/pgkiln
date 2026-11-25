// A launchpad as low-code tools draw one (sprint 254, MG-32 … MG-35, HR page 78): the page's content width "full",
// a banner in a box of its own height, tiles from a list (icon, label as text, colour), and an inline dialog shown as
// a notification: centred, no header, a coloured background, closed by a click outside. No CSP or axe violations.
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

async function open(width: number, bypassCSP = false) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, bypassCSP });
  await context.addInitScript(() => {
    (window as any).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as any).__csp.push(`${e.violatedDirective}: ${e.blockedURI || e.sample || 'inline'}`));
  });
  const page = await context.newPage();
  await page.goto(`${base}/a/hr/login`);
  await page.fill('#username', 'king');
  await page.fill('#password', 'king');
  await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
  await page.goto(`${base}/a/hr/78`);
  return page;
}
const axe = async (page: Page) => {
  await page.evaluate(AXE);
  const r = await page.evaluate(() => (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }));
  return r.violations.map((v: { id: string; nodes: { html: string }[] }) => `${v.id}: ${v.nodes[0]?.html.slice(0, 160)}`);
};

describe('launchpad (HR page 78)', () => {
  test('full width, a banner 140 px high, three columns of tiles with text labels', async () => {
    const page = await open(1920);
    const content = (await page.locator('.t-content').boundingBox())!;
    const main = (await page.locator('.t-main').boundingBox())!;
    assert.ok(content.width > 1500 && Math.abs(content.width - main.width) < 2, `the content fills the main area (${content.width} of ${main.width})`);
    const banner = page.locator('#P78_BANNER img');
    assert.equal(Math.round((await banner.boundingBox())!.height), 140);
    assert.equal(await banner.evaluate((img) => getComputedStyle(img).objectFit), 'cover');
    const tiles = page.locator('.list-tiles .list-tile');
    assert.equal(await tiles.count(), 6);
    assert.deepEqual((await tiles.allInnerTexts()).map((t) => t.trim()), ['Employees', 'Departments', 'Leave requests', 'Analytics', 'Search', 'Before you start']);
    const boxes = await Promise.all([0, 1, 2, 3].map(async (i) => (await tiles.nth(i).boundingBox())!));
    assert.ok(boxes.every((b) => b.height >= 90), 'at least the row height');
    assert.equal(Math.round(boxes[0].y), Math.round(boxes[2].y), 'three on a row');
    assert.ok(boxes[3].y > boxes[0].y, 'the fourth on the next row');
    // the picture icon and an icon from the icon set; light tiles get dark text
    assert.equal(await tiles.nth(0).locator('img').getAttribute('src'), '/a/hr/static/tile-team.svg');
    assert.equal(await tiles.nth(1).locator('svg.icon').count(), 1);
    assert.equal(await tiles.nth(0).evaluate((a) => getComputedStyle(a).backgroundColor), 'rgb(47, 85, 151)');
    assert.equal(await tiles.nth(4).evaluate((a) => getComputedStyle(a).color), 'rgb(0, 0, 0)');
    // the greeting: a plain region with Centre the text, Bold text and Large text
    const greeting = page.locator('p:has-text("what would you like to do")');
    assert.deepEqual(await greeting.evaluate((p) => [getComputedStyle(p).fontWeight, getComputedStyle(p).textAlign]), ['700', 'center']);
    // the footer follows the content width
    const footer = (await page.locator('.t-footer').boundingBox())!;
    assert.ok(footer.width > 1500, `the footer is as wide (${footer.width})`);
    assert.deepEqual(await axe(page), []);
    assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
    await page.context().close();
  });

  test('on a phone: one tile per row', async () => {
    const page = await open(412);
    const tiles = page.locator('.list-tiles .list-tile');
    const [a, b] = [(await tiles.nth(0).boundingBox())!, (await tiles.nth(1).boundingBox())!];
    assert.ok(b.y > a.y + a.height - 1 && a.width > 300, `stacked (${a.width} wide)`);
    await page.context().close();
  });

  test('the notification dialog: centred, no header, green; a click outside closes it', async () => {
    const page = await open(1440);
    const dialog = page.locator('dialog[data-static-id="launch-reminder"]');
    await page.click('.list-tile:has-text("Before you start")');
    assert.equal(await dialog.isVisible(), true);
    const box = (await dialog.boundingBox())!;
    assert.ok(Math.abs(box.x + box.width / 2 - 720) < 2, 'centred across');
    assert.ok(box.width <= 400, 'small');
    assert.equal(await dialog.locator('.region-header').evaluate((h) => h.getBoundingClientRect().height <= 1), true, 'the header is hidden');
    assert.equal(await dialog.evaluate((d) => getComputedStyle(d).backgroundColor), 'rgb(229, 244, 236)');
    assert.deepEqual(await axe(page), [], 'with the dialog open');
    await page.mouse.click(20, 20);
    assert.equal(await dialog.isVisible(), false);
    await page.context().close();
  });

  test('an application\'s margins on regions do not move an inline dialog to a corner', async () => {
    const page = await open(1440, true);
    await page.addStyleTag({ content: 'body .t-regions > .region:not(.x-plain) { margin: .75rem; }' });
    await page.click('.list-tile:has-text("Before you start")');
    const box = (await page.locator('dialog[data-static-id="launch-reminder"]').boundingBox())!;
    assert.ok(Math.abs(box.x + box.width / 2 - 720) < 2 && box.y > 100, `centred (${box.x}, ${box.y})`);
    await page.context().close();
  });

  test('without a page setting the application\'s content width applies, centred', async () => {
    const app = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
    await owner.query(`update meta.page set content_width = null where app_id = $1 and page_no = 78`, [app]);
    await owner.query(`update meta.app set theme = theme || '{"content_width": "1000"}' where id = $1`, [app]);
    try {
      const page = await open(1920);
      const content = (await page.locator('.t-content').boundingBox())!;
      const main = (await page.locator('.t-main').boundingBox())!;
      assert.equal(Math.round(content.width), 1000);
      assert.ok(Math.abs(content.x - main.x - (main.width - 1000) / 2) < 2, 'centred');
      assert.equal(Math.round((await page.locator('.t-footer').boundingBox())!.width), 1000 - 48, 'the footer too');
      await page.context().close();
    } finally {
      await owner.query(`update meta.app set theme = theme - 'content_width' where id = $1`, [app]);
      await owner.query(`update meta.page set content_width = 'full' where app_id = $1 and page_no = 78`, [app]);
    }
  });
});
