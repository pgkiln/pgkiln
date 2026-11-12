// The builder's reports at laptop width (sprint 171, UX-8): at 1118 × 679 the App Builder's report view, Users and
// the Data Reporter list fit without a horizontal scroll bar, their column headers aren't cut, and Users' Create
// account opens in a drawer that Escape closes.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools } from '../../src/db.ts';

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

async function developer(): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 1118, height: 679 } })).newPage();
  await page.goto(`${base}/builder/login`);
  await page.fill('#f_username', 'admin');
  await page.fill('#f_password', 'admin');
  await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
  return page;
}

/** No horizontal scrolling of the page or of any .rep-fit table, and every header shows its whole text. */
async function fits(page: Page, what: string) {
  const r = await page.evaluate(() => {
    const out: string[] = [];
    const de = document.documentElement;
    if (de.scrollWidth > de.clientWidth + 1) out.push(`page ${de.scrollWidth} > ${de.clientWidth}`);
    const wraps = [...document.querySelectorAll<HTMLElement>('.table-wrap.rep-fit')];
    for (const w of wraps) if (w.scrollWidth > w.clientWidth + 1) out.push(`table ${w.scrollWidth} > ${w.clientWidth}`);
    for (const th of document.querySelectorAll<HTMLElement>('.table-wrap.rep-fit th')) {
      if (th.offsetParent === null) continue;
      if (th.scrollWidth > th.clientWidth + 1) out.push(`header "${th.textContent?.trim()}" cut`);
    }
    return { out, tables: wraps.length };
  });
  assert.ok(r.tables >= 1, `${what}: a .rep-fit table`);
  assert.deepEqual(r.out, [], what);
}

describe('builder reports at 1118 px (UX-8)', () => {
  test('App Builder (report view), Users and the Data Reporter fit the window', async () => {
    const page = await developer();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/builder/apps?view=report`);
    await fits(page, 'App Builder');
    assert.equal(await page.locator('.ab-apps th.col-low').first().isVisible(), false, 'low-value columns give way');
    assert.equal(await page.locator('.ab-apps th.col-actions').isVisible(), true, 'Actions stays');
    await page.goto(`${base}/builder/users`);
    await fits(page, 'Users');
    await page.goto(`${base}/builder/reporter`);
    await fits(page, 'Data Reporter');
    assert.deepEqual(errors, []);
    await page.context().close();
  });

  test('Users: Create account opens in a drawer; Escape and Close close it', async () => {
    const page = await developer();
    await page.goto(`${base}/builder/users`);
    const drawer = page.locator('details#us-create');
    await drawer.locator('summary').click();
    assert.equal(await drawer.getAttribute('open'), '');
    await page.waitForFunction(() => document.activeElement?.getAttribute('name') === 'username', null, { timeout: 2000 }); // the first field has the focus
    await page.keyboard.press('Escape');
    assert.equal(await drawer.getAttribute('open'), null);
    await drawer.locator('summary').click();
    await drawer.locator('[data-drawer-close]').click();
    assert.equal(await drawer.getAttribute('open'), null);
    await page.context().close();
  });
});
