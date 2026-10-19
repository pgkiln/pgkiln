// Sprint 115 (WS-11, APEX 26.1 component details) in a real browser, on HR page 47
// (examples/hr/hr_68_component_details.sql): a popup LOV over 6,000 rows scrolls to
// its end without a More button (and pages with More without IntersectionObserver);
// the wait popup around a long process and around an Ajax call; dynamic actions on
// menu entries. Phones, tablets and desktops; light and dark; no CSP violations.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type BrowserContextOptions, type Page } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools } from '../../src/db.ts';

const VIEWPORTS = {
  phone: { width: 390, height: 844 },
  'tablet-portrait': { width: 768, height: 1024 },
  'tablet-landscape': { width: 1024, height: 768 },
  desktop: { width: 1440, height: 900 },
} as const;

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

async function open(options: BrowserContextOptions = {}, init?: () => void) {
  const context = await browser.newContext(options);
  await context.addInitScript(() => {
    (window as any).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as any).__csp.push(`${e.violatedDirective}: ${e.blockedURI || e.sample || 'inline'}`));
  });
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  await page.goto(`${base}/a/hr/login`);
  await page.fill('#username', 'king');
  await page.fill('#password', 'king');
  await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
  await page.goto(`${base}/a/hr/47`);
  return page;
}

const violations = (page: Page) => page.evaluate(() => (window as any).__csp as string[]);
/** Scroll the dialog's list to its end (the results or the dialog's body, whichever scrolls). */
const scrollEnd = (dlg: ReturnType<Page['locator']>) =>
  dlg.evaluate((d) => d.querySelectorAll<HTMLElement>('.popup-lov-body, .popup-lov-results').forEach((el) => (el.scrollTop = el.scrollHeight)));
const pageFits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

describe('popup LOV: infinite scrolling', () => {
  test('6,000 rows: scrolling the dialog loads them all, without a More button', async () => {
    const page = await open();
    await page.locator('[data-item="P47_REF"] .popup-lov-open').click();
    const dlg = page.locator('dialog.popup-lov-dialog[open]');
    await dlg.locator('.popup-lov-table').waitFor();
    const rows = dlg.locator('tbody tr');
    assert.ok((await rows.count()) >= 100);
    // scroll to the end until the last row is there
    for (let i = 0; i < 200 && !(await dlg.locator('.popup-lov-pick', { hasText: 'REF-06000' }).count()); i++) {
      await scrollEnd(dlg);
      await page.waitForTimeout(50);
    }
    await dlg.locator('.popup-lov-pick', { hasText: 'REF-06000' }).waitFor();
    assert.equal(await rows.count(), 6000);
    assert.equal(await dlg.locator('.popup-lov-pages, .popup-lov-sentinel').count(), 0, 'no More button, nothing left to load');
    await dlg.locator('.popup-lov-pick', { hasText: 'REF-06000' }).click();
    assert.match(await page.inputValue('[data-item="P47_REF"] .popup-lov-display'), /^REF-06000/);
    assert.equal(await page.inputValue('#P47_REF'), '6000');
    assert.deepEqual(await violations(page), []);
    await page.context().close();
  });

  test('a search starts over and scrolls within its matches', async () => {
    const page = await open();
    await page.locator('[data-item="P47_REF"] .popup-lov-open').click();
    const dlg = page.locator('dialog.popup-lov-dialog[open]');
    await dlg.locator('.popup-lov-table').waitFor();
    await dlg.locator('.popup-lov-search').fill('REF-059');
    await dlg.locator('.popup-lov-pick', { hasText: 'REF-05999' }).waitFor();
    assert.equal(await dlg.locator('tbody tr').count(), 100);
    assert.equal(await dlg.locator('.popup-lov-sentinel').count(), 0);
    await page.context().close();
  });

  test('without IntersectionObserver the dialog pages with More', async () => {
    const page = await open({}, () => {
      delete (window as any).IntersectionObserver;
    });
    await page.locator('[data-item="P47_REF"] .popup-lov-open').click();
    const dlg = page.locator('dialog.popup-lov-dialog[open]');
    await dlg.locator('.popup-lov-table').waitFor();
    assert.equal(await dlg.locator('tbody tr').count(), 100);
    await dlg.locator('.popup-lov-pages button', { hasText: 'More' }).click();
    await dlg.locator('.popup-lov-pick', { hasText: 'REF-00101' }).waitFor();
    assert.equal(await dlg.locator('tbody tr').count(), 100);
    await page.context().close();
  });
});

describe('wait popup', () => {
  test('around an Ajax call: shown, busy, then removed and the item filled', async () => {
    const page = await open();
    await page.locator('button', { hasText: 'Check in the background' }).click();
    const wait = page.locator('dialog.wait-popup[open]');
    await wait.waitFor();
    assert.equal(await wait.locator('[role="status"]').innerText(), 'Checking…');
    assert.equal(await page.locator('#main').getAttribute('aria-busy'), 'true');
    await wait.waitFor({ state: 'detached', timeout: 10_000 });
    assert.match(await page.inputValue('#P47_RESULT'), /^14 employees, checked at/);
    assert.equal(await page.locator('#main').getAttribute('aria-busy'), null);
    assert.deepEqual(await violations(page), []);
    await page.context().close();
  });

  test('around a long process: shown until the next page', async () => {
    const page = await open();
    const nav = page.waitForNavigation();
    // in the page itself: Playwright's locators would wait for the next page
    const state = await page.evaluate(
      () =>
        new Promise<string[]>((resolve) => {
          [...document.querySelectorAll<HTMLButtonElement>('button[data-button="RECALC"]')][0].click();
          setTimeout(() => {
            const d = document.querySelector('dialog.wait-popup');
            resolve([String(d?.hasAttribute('open')), d?.textContent ?? '', String(document.getElementById('main')?.getAttribute('aria-busy'))]);
          }, 300);
        }),
    );
    assert.deepEqual(state, ['true', 'Recalculating…', 'true']);
    await nav;
    await page.locator('.alert', { hasText: 'Recalculated.' }).waitFor();
    assert.equal(await page.locator('dialog.wait-popup[open]').count(), 0);
    assert.deepEqual(await violations(page), []);
    await page.context().close();
  });

  test('pgkiln.waitPopup() from JavaScript returns its remover', async () => {
    const page = await open();
    const shown = await page.evaluate(() => {
      (window as any).__remove = (window as any).pgkiln.waitPopup('Busy');
      return !!document.querySelector('dialog.wait-popup[open]');
    });
    assert.equal(shown, true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('dialog.wait-popup[open]').count(), 1, 'Escape does not close it');
    await page.evaluate(() => (window as any).__remove());
    assert.equal(await page.locator('dialog.wait-popup[open]').count(), 0);
    await page.context().close();
  });
});

describe('dynamic actions on menu entries', () => {
  test('Actions → Say hello and Count employees run their dynamic actions', async () => {
    const page = await open();
    const menu = page.locator('details.btn-menu[data-button="ACTIONS"]');
    await menu.locator('summary').click();
    await menu.locator('[data-menu-entry="HELLO"]').click();
    await page.locator('.alert', { hasText: 'Hello from a menu entry.' }).waitFor();
    assert.equal(await menu.evaluate((d) => (d as HTMLDetailsElement).open), false, 'the menu closes');
    await menu.locator('summary').click();
    await menu.locator('[data-menu-entry="COUNT"]').click();
    await page.locator('dialog.wait-popup[open]', { hasText: 'Counting employees…' }).waitFor();
    await page.waitForFunction(() => /counted at/.test((document.getElementById('P47_RESULT') as HTMLInputElement).value));
    assert.equal(await page.locator('dialog.wait-popup[open]').count(), 0);
    // the link entry still navigates
    await menu.locator('summary').click();
    await Promise.all([page.waitForNavigation(), menu.locator('a', { hasText: 'Pick an employee' }).click()]);
    assert.match(page.url(), /\/a\/hr\/26/);
    assert.deepEqual(await violations(page), []);
    await page.context().close();
  });
});

for (const [vp, size] of Object.entries(VIEWPORTS)) {
  describe(`component details at ${vp} (${size.width}px)`, () => {
    for (const colorScheme of ['light', 'dark'] as const) {
      test(`the wait popup and the popup LOV dialog fit (${colorScheme})`, async () => {
        const page = await open({ viewport: size, colorScheme });
        assert.ok(await pageFits(page), 'page 47 fits');
        const remove = await page.evaluateHandle(() => (window as any).pgkiln.waitPopup('Please wait while a rather long process with a rather long description finishes'));
        const box = await page.locator('dialog.wait-popup[open]').boundingBox();
        assert.ok(box && box.x >= 0 && box.x + box.width <= size.width && box.y >= 0 && box.y + box.height <= size.height, `wait popup in view: ${JSON.stringify(box)}`);
        const [bg, fg] = await page.locator('dialog.wait-popup').evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).color]);
        assert.notEqual(bg, fg);
        if (colorScheme === 'dark') assert.notEqual(bg, 'rgb(255, 255, 255)', 'a dark wait popup');
        await remove.evaluate((fn: any) => fn());
        await page.locator('[data-item="P47_REF"] .popup-lov-open').click();
        const dlg = page.locator('dialog.popup-lov-dialog[open]');
        await dlg.locator('.popup-lov-table').waitFor();
        await scrollEnd(dlg);
        await dlg.locator('.popup-lov-pick', { hasText: 'REF-00101' }).waitFor();
        assert.ok(await pageFits(page), 'the dialog fits');
        assert.deepEqual(await violations(page), []);
        await page.context().close();
      });
    }
  });
}
