// Automatic time zone and number masks in a real browser (HR page 29): the
// sign-in form and app.js send the browser's time zone, so the page shows
// times in it; a number item with a mask reads the language's notation.
// Without JavaScript the application's time zone applies. All under the
// strict Content-Security-Policy.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools, owner } from '../../src/db.ts';

let base = '';
let browser: Browser;
let close: () => Promise<void>;

before(async () => {
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  await owner.query(`update meta.account set time_zone = null where username = 'king'`);
  close = async () => {
    await owner.query(`update meta.account set time_zone = null where username = 'king'`);
    await browser.close();
    await app.close();
    await closePools();
  };
});

after(() => close());

async function signedIn(timezoneId: string, javaScriptEnabled = true) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId, javaScriptEnabled });
  await context.addInitScript(() => {
    (window as any).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as any).__csp.push(`${e.violatedDirective}: ${e.blockedURI || e.sample || 'inline'}`));
  });
  const page = await context.newPage();
  await page.goto(`${base}/a/hr/login`);
  await page.fill('#username', 'king');
  await page.fill('#password', 'king');
  await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
  return { context, page };
}

const zoneShown = (page: Page) => page.locator('td[data-label="Time zone"]').first().innerText();
const violations = (page: Page) => page.evaluate(() => (window as any).__csp as string[]);

describe('automatic time zone and number masks', () => {
  test('the browser\'s time zone comes along with the sign-in', async () => {
    const { context, page } = await signedIn('Asia/Tokyo');
    await page.goto(`${base}/a/hr/29?lang=en`);
    assert.equal((await zoneShown(page)).trim(), 'Asia/Tokyo');
    assert.deepEqual(await violations(page), []);
    await context.close();
  });

  test('a session that started without it gets it from app.js, and the page shows it', async () => {
    const context = await browser.newContext({ timezoneId: 'America/Sao_Paulo' });
    const page = await context.newPage();
    // sign in without the browser's time zone (as a form post without app.js would)
    await page.goto(`${base}/a/hr/login`);
    const csrf = await page.locator('input[name="__csrf"]').first().getAttribute('value');
    await page.request.post(`${base}/a/hr/login`, { form: { __csrf: csrf ?? '', username: 'king', password: 'king', next: '/a/hr/29' }, maxRedirects: 0 });
    await page.goto(`${base}/a/hr/29?lang=en`);
    // app.js posts the zone and loads the page again
    await page.waitForFunction(() => document.querySelector('td[data-label="Time zone"]')?.textContent?.trim() === 'America/Sao_Paulo', null, { timeout: 10_000 });
    await context.close();
  });

  test('without JavaScript the application\'s time zone applies', async () => {
    const appTz = (await owner.one(`select time_zone from meta.app where alias = 'hr'`)).time_zone;
    await owner.query(`update meta.app set time_zone = 'Europe/Lisbon' where alias = 'hr'`);
    try {
      const { context, page } = await signedIn('Asia/Tokyo', false);
      await page.goto(`${base}/a/hr/29?lang=en`);
      assert.equal((await zoneShown(page)).trim(), 'Europe/Lisbon');
      await context.close();
    } finally {
      await owner.query(`update meta.app set time_zone = $1 where alias = 'hr'`, [appTz]);
    }
  });

  test('a number item with a mask takes Dutch notation and shows the result formatted', async () => {
    const { context, page } = await signedIn('Europe/Amsterdam');
    await page.goto(`${base}/a/hr/29?lang=nl`);
    await page.fill('#P29_AMOUNT', '1.234,50');
    await Promise.all([page.waitForNavigation(), page.click('button[data-button="CONVERT"]')]);
    assert.equal(await page.inputValue('#P29_AMOUNT'), '1.234,50');
    assert.match(await page.locator('#P29_WITH_VAT').innerText(), /€1\.493,75/);
    assert.deepEqual(await violations(page), []);
    await context.close();
  });
});
