// Sprint 98 (Database Actions DA-10): the Data Modeler in a real browser. A diagram "hr core" of hr.emp, hr.dept and
// hr.leave_request: the FK lines are drawn, a dragged box follows with its lines, Save keeps the position over a
// reload, undo / redo, zoom, the mini-map, Export SVG and PNG; a box's name opens Table Properties; it fits a phone
// and never violates the CSP.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools, owner } from '../../src/db.ts';

let base = '';
let browser: Browser;
let close: () => Promise<void>;
const NAME = 'hr core e2e';

before(async () => {
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  await owner.query('delete from meta.sql_diagram where name = $1', [NAME]);
  close = async () => {
    await owner.query('delete from meta.sql_diagram where name = $1', [NAME]);
    await browser.close();
    await app.close();
    await closePools();
  };
});
after(() => close());

async function builder(viewport = { width: 1440, height: 1000 }): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  await context.addInitScript(() => {
    (window as any).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as any).__csp.push(`${e.violatedDirective}: ${e.blockedURI || e.sample || 'inline'}`));
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => assert.fail(`page error: ${e.message}`));
  await page.goto(`${base}/builder/login`);
  await page.fill('#f_username', 'admin');
  await page.fill('#f_password', 'admin');
  await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
  return { context, page };
}
const transform = (page: Page, name: string) => page.getAttribute(`.dm-box[data-name="${name}"]`, 'transform');

describe('Data Modeler', () => {
  test('create "hr core"; drag, save, reload; undo / redo; zoom, mini-map; export SVG and PNG; open a table', async () => {
    const { context, page } = await builder();
    await page.goto(`${base}/builder/sql/modeler`);
    await page.fill('#f_name', NAME);
    await page.selectOption('#f_schema', 'hr');
    await page.fill('#f_objects', 'emp, dept, leave_request');
    await Promise.all([page.waitForNavigation(), page.click('button:has-text("Create diagram")')]);
    assert.equal(await page.locator('.dm-box').count(), 3);
    assert.equal(await page.locator('.dm-fk[data-from="emp"][data-to="dept"]').count(), 1);
    assert.equal(await page.locator('.dm-fk[data-from="leave_request"][data-to="emp"]').count(), 1);

    // drag dept down: its line follows
    const line = page.locator('.dm-fk[data-from="emp"][data-to="dept"] .dm-line');
    const before = await line.getAttribute('d');
    const start = await transform(page, 'dept');
    const box = (await page.locator('.dm-box[data-name="dept"] .dm-frame').boundingBox())!;
    await page.mouse.move(box.x + 40, box.y + 60);
    await page.mouse.down();
    await page.mouse.move(box.x + 60, box.y + 460, { steps: 6 });
    await page.mouse.up();
    const moved = await transform(page, 'dept');
    assert.notEqual(moved, start);
    assert.notEqual(await line.getAttribute('d'), before);
    assert.equal(await page.textContent('.dm-status'), 'Unsaved changes');

    // undo, redo; the arrow keys move a focused box
    await page.click('[data-dm=undo]');
    assert.equal(await transform(page, 'dept'), start);
    await page.click('[data-dm=redo]');
    assert.equal(await transform(page, 'dept'), moved);
    await page.focus('.dm-box[data-name="emp"]');
    const empAt = await transform(page, 'emp');
    await page.keyboard.press('ArrowDown');
    assert.notEqual(await transform(page, 'emp'), empAt);
    await page.keyboard.press('Control+z');
    assert.equal(await transform(page, 'emp'), empAt);

    // save (Ctrl+S): the position survives a reload
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => document.querySelector('.dm-status')!.textContent === 'Saved');
    await page.reload();
    assert.equal(await transform(page, 'dept'), moved);

    // zoom, fit, mini-map
    const width = Number(await page.getAttribute('#dm-svg', 'width'));
    await page.click('[data-dm=zoom-in]');
    assert.ok(Number(await page.getAttribute('#dm-svg', 'width')) > width);
    await page.click('[data-dm=fit]');
    await page.click('[data-dm=minimap]');
    assert.equal(await page.locator('.dm-minimap use').count(), 1);
    // (sprint 108) the builder is dark by default: the boxes take the theme's colours, not the export's white, and the
    // rules have no .dm-svg ancestor, so the mini-map's <use> copy is themed too; the toggle shows that it is on
    const fills = await page.evaluate(() => ({
      frame: getComputedStyle(document.querySelector('.dm-box .dm-frame')!).fill,
      title: getComputedStyle(document.querySelector('.dm-box .dm-title')!).fill,
      mini: getComputedStyle(document.querySelector('.dm-minimap')!).backgroundColor,
    }));
    assert.notEqual(fills.frame, 'rgb(255, 255, 255)', 'a dark box');
    assert.notEqual(fills.title, fills.frame);
    assert.notEqual(fills.mini, 'rgb(255, 255, 255)', 'a dark mini-map');
    assert.equal(await page.getAttribute('[data-dm=minimap]', 'aria-pressed'), 'true');
    await page.click('[data-dm=minimap]');
    assert.equal(await page.locator('.dm-minimap').count(), 0);

    // exports
    const [svg] = await Promise.all([page.waitForEvent('download'), page.click('[data-dm=svg]')]);
    assert.equal(svg.suggestedFilename(), 'hr_core_e2e.svg');
    const text = readFileSync((await svg.path())!, 'utf8');
    assert.match(text, /<svg[^>]+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(text, /data-from="leave_request" data-to="emp"/);
    assert.doesNotMatch(text, /<a |tabindex|id="dm-/);
    const [png] = await Promise.all([page.waitForEvent('download'), page.click('[data-dm=png]')]);
    assert.equal(png.suggestedFilename(), 'hr_core_e2e.png');
    assert.equal(readFileSync((await png.path())!).subarray(1, 4).toString(), 'PNG');

    // auto layout (undoable), then leave without saving: undo first, so nothing is unsaved
    await page.click('[data-dm=auto]');
    assert.notEqual(await transform(page, 'dept'), moved);
    await page.click('[data-dm=undo]');
    // a box's name opens Table Properties
    await Promise.all([page.waitForNavigation(), page.click('.dm-box[data-name="emp"] .dm-title')]);
    assert.match(page.url(), /\/builder\/sql\/objects\/table\?o=hr\.emp$/);
    assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
    await context.close();
  });

  test('a phone: the canvas scrolls inside the page; the data dictionary prints', async () => {
    const { context, page } = await builder({ width: 390, height: 844 });
    const id = (await owner.one('select id from meta.sql_diagram where name = $1', [NAME]))!.id;
    await page.goto(`${base}/builder/sql/modeler/${id}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0);
    assert.ok(await page.locator('[data-dm=save]').isVisible());
    await page.goto(`${base}/builder/sql/modeler/${id}/dictionary`);
    assert.ok(await page.locator('.dm-dict-actions [data-dm=print]').isVisible());
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0);
    assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
    await context.close();
  });
});
