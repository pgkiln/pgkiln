// The Standard page template's other display positions in a real browser (sprint 234, AX-12): HR page 70 shows a
// region in the header after the logo, before and after the navigation bar, a top navigation bar under the header,
// full width content, and an inline dialog in the Dialogs, drawers and popups position that its button opens; on a
// phone the header keeps only After logo and nothing overflows. The Page Designer draws the positions as drop zones
// in APEX's order and a region dragged onto After logo moves there. 390 px and desktop, strict CSP.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools, owner } from '../../src/db.ts';

const PAGE_NO = 9234;
let base = '';
let browser: Browser;
let close: () => Promise<void>;
let appId = 0;

before(async () => {
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  close = async () => {
    await owner.query('delete from meta.page where app_id = $1 and page_no = $2', [appId, PAGE_NO]);
    await browser.close();
    await app.close();
    await closePools();
  };
});
after(() => close());

async function open(width: number, height = 900) {
  const context = await browser.newContext({ viewport: { width, height } });
  await context.addInitScript(() => {
    (window as any).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as any).__csp.push(`${e.violatedDirective}: ${e.blockedURI || 'inline'}`));
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  return { page, errors };
}

async function fits(page: Page, what: string) {
  const o = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    return document.documentElement.scrollWidth > vw + 1 ? { scrollWidth: document.documentElement.scrollWidth, vw } : null;
  });
  assert.equal(o, null, `${what} overflows: ${JSON.stringify(o)}`);
  assert.deepEqual(await page.evaluate(() => (window as any).__csp), [], `${what}: CSP violations`);
}

const visible = (page: Page, sel: string) => page.locator(sel).first().isVisible();

describe('the Standard page template\'s other positions (sprint 234, AX-12)', () => {
  for (const width of [390, 1440]) {
    test(`HR page 70 at ${width} px: the header's regions, the top navigation, full width content and an inline dialog`, async () => {
      const { page, errors } = await open(width);
      await page.goto(`${base}/a/hr/login`);
      await page.fill('#username', 'king');
      await page.fill('#password', 'king');
      await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
      await page.goto(`${base}/a/hr/70`);
      // After logo: in the header, after the application's name, on every width
      assert.equal(await visible(page, '.t-header .t-pos-after_logo'), true);
      const logo = (await page.locator('.t-header .t-logo').boundingBox())!;
      const tag = (await page.locator('.t-header .t-pos-after_logo').boundingBox())!;
      assert.ok(tag.x >= logo.x + logo.width - 1, 'after the logo');
      assert.ok(tag.y >= 0 && tag.y + tag.height <= 53, 'inside the header bar');
      // Before / After navigation bar: in the header on a wide screen, left out on a phone
      assert.equal(await visible(page, '.t-header .t-pos-before_navigation_bar'), width > 640);
      assert.equal(await visible(page, '.t-header .t-pos-after_navigation_bar'), width > 640);
      if (width > 640) {
        const before = (await page.locator('.t-pos-before_navigation_bar').boundingBox())!;
        const afterBar = (await page.locator('.t-pos-after_navigation_bar').boundingBox())!;
        const user = (await page.locator('.t-header .t-user').boundingBox())!;
        assert.ok(before.x < user.x && afterBar.x > user.x, 'before and after the user menu');
      }
      // Top navigation: a bar under the header
      const header = (await page.locator('.t-header').boundingBox())!;
      const bar = (await page.locator('.t-topnav').boundingBox())!;
      assert.ok(bar.y >= header.y + header.height - 1, 'under the header');
      assert.match(await page.locator('.t-topnav').innerText(), /Employees/);
      // Full width content above the body; the dialog opens from the body's button
      const wide = (await page.locator('.t-pos-full_width').boundingBox())!;
      const body = (await page.locator('[data-region-static-id="pos-body"], .region:has-text("About the positions")').first().boundingBox())!;
      assert.ok(wide.y < body.y, 'full width content before the body');
      assert.equal(await page.locator('.t-pos-dialogs dialog[open]').count(), 0);
      await page.click('button:has-text("About this page")');
      await page.locator('.t-pos-dialogs dialog[open]').waitFor();
      assert.match(await page.locator('.t-pos-dialogs dialog[open]').innerText(), /inline dialog/);
      await page.keyboard.press('Escape');
      await fits(page, `page 70 at ${width}`);
      assert.deepEqual(errors, []);
      await page.context().close();
    });
  }

  test('the Page Designer: the positions as drop zones in APEX\'s order; a region dragged onto After logo moves there', async () => {
    await owner.query('delete from meta.page where app_id = $1 and page_no = $2', [appId, PAGE_NO]);
    const p = (await owner.one(`insert into meta.page (app_id, page_no, name) values ($1, $2, 'Positions test') returning id`, [appId, PAGE_NO])).id as number;
    const rid = (await owner.one(`insert into meta.region (page_id, seq, title, type, template, source) values ($1, 10, 'Tag', 'static', 'plain', '<p>x</p>') returning id`, [p])).id as number;
    const { page, errors } = await open(1440, 1600);
    await page.goto(`${base}/builder/login`);
    await page.fill('#f_username', 'admin');
    await page.fill('#f_password', 'admin');
    await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
    await page.goto(`${base}/builder/apps/${appId}/pages/${PAGE_NO}`);
    const zones = await page.locator('#pd-layout section.pd-zone').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));
    assert.deepEqual(zones, ['Banner', 'After logo', 'Before navigation bar', 'After navigation bar', 'Top navigation', 'Breadcrumb bar', 'Full width content', 'Body', 'Footer', 'Dialogs, drawers and popups']);
    // the header's three side by side
    const ys = await page.locator('.pd-header-zones > .pd-zone').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
    assert.equal(new Set(ys).size, 1, `one row: ${ys}`);
    // drag the region by its head onto the After logo zone
    const src = `.pd-region[data-id="${rid}"] > .pd-region-head`;
    await page.locator(src).hover();
    await page.mouse.down();
    const box = (await page.locator(src).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2 + 8, box.y + box.height / 2 + 8, { steps: 2 });
    const t = (await page.locator('.pd-grid[data-position="after_logo"] > .pd-grid-end').boundingBox())!;
    await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 4 });
    await Promise.all([page.waitForNavigation(), page.mouse.up()]);
    assert.equal((await owner.one('select position from meta.region where id = $1', [rid])).position, 'after_logo');
    assert.equal(await page.locator(`.pd-grid[data-position="after_logo"] > .pd-region[data-id="${rid}"]`).count(), 1);
    await fits(page, 'designer at 1440');
    // on a phone the layout fits too (the header's zones under each other)
    await page.setViewportSize({ width: 390, height: 900 });
    await page.reload();
    await fits(page, 'designer at 390');
    assert.deepEqual(errors, []);
    await page.context().close();
  });
});
