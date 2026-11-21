// The JSON form region in a real browser (sprint 246, MG-19): HR page 74 draws the "Workplace inspection" schema of
// hr.form_template as fields; Add a row / Remove work on the follow-up actions (JavaScript), Save stores the answers
// as one JSON value, and a value the schema refuses comes back with its error at the field. 390 px and desktop,
// strict CSP, nothing wider than the screen.
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
let rid = 0;

const clean = () => owner.query(`delete from hr.form_answer where upper(username) = 'KING'`);

before(async () => {
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  rid = (await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id join meta.app a on a.id = p.app_id
                           where a.alias = 'hr' and p.page_no = 74 and r.static_id = 'jf-form'`)).id;
  await clean();
  close = async () => {
    await clean();
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
  await page.goto(`${base}/a/hr/login`);
  await page.fill('#username', 'king');
  await page.fill('#password', 'king');
  await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
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

const field = (key: string) => `[name="jf${rid}:${key}"]`;

describe('the JSON form region (sprint 246, MG-19)', () => {
  for (const width of [390, 1440]) {
    test(`HR page 74 at ${width} px: fields from the schema, repeating rows, save and a refused value`, async () => {
      await clean();
      const { page, errors } = await open(width);
      await page.goto(`${base}/a/hr/74`);
      await page.locator(field('location')).waitFor();
      await fits(page, 'the form');
      // with JavaScript: no empty rows, an Add a row button, the Remove boxes are buttons
      assert.equal(await page.locator('[data-jf-list] [data-jf-row]').count(), 0);
      const add = page.locator('[data-jf-add]');
      assert.equal(await add.isVisible(), true);
      await add.click();
      await add.click();
      assert.equal(await page.locator('[data-jf-list] [data-jf-row]').count(), 2);
      assert.deepEqual(await page.locator('[data-jf-list] .jf-row-title').allTextContents(), ['Row 1', 'Row 2']);
      // the new row's first field has the focus
      assert.equal(await page.evaluate(() => (document.activeElement as HTMLInputElement).name), `jf${rid}:actions/3/what`);
      await page.fill(field('actions/2/what'), 'Fix the cable');
      await page.fill(field('actions/2/due'), '2026-12-01');
      await page.fill(field('actions/3/what'), 'Go away');
      await page.locator('[data-jf-list] [data-jf-row]').nth(1).locator('[data-jf-remove]').click();
      assert.equal(await page.locator('[data-jf-list] [data-jf-row]').count(), 1);
      await fits(page, 'the form with a row');

      // a refused value: the radio group is required, the score at most 10
      await page.fill(field('location'), 'B2.14');
      await page.fill(field('inspected_on'), '2026-11-20');
      await page.fill(field('score'), '11');
      await Promise.all([page.waitForLoadState('load'), page.click('button[value="SAVE"]:not(.default-submit)')]);
      await page.locator('.has-error').first().waitFor();
      assert.match(await page.locator(`.has-error:has(${field('overall')}) .error`).textContent() ?? '', /required/);
      assert.match(await page.locator(`.has-error:has(${field('score')}) .error`).textContent() ?? '', /at most 10/);
      assert.equal(await page.inputValue(field('location')), 'B2.14');
      assert.equal(await page.inputValue(field('actions/0/what')), 'Fix the cable');
      await fits(page, 'the form with errors');

      await page.check(`${field('overall')}[value="fair"]`);
      await page.check(`${field('hazards')}[value="fire"]`);
      await page.fill(field('score'), '7');
      await page.check(field('fire_exits_clear'));
      await Promise.all([page.waitForURL(/\/a\/hr\/74$/), page.click('button[value="SAVE"]:not(.default-submit)')]);
      const row = await owner.one(`select answers from hr.form_answer where upper(username) = 'KING'`);
      assert.deepEqual(row.answers, {
        location: 'B2.14', inspected_on: '2026-11-20', overall: 'fair', hazards: ['fire'], score: 7, fire_exits_clear: true,
        contact: {}, actions: [{ what: 'Fix the cable', due: '2026-12-01', done: false }],
      });
      // the read-only region shows what was saved
      const saved = page.locator('.region:has-text("Your saved answers")').last();
      await saved.waitFor();
      assert.match(await saved.textContent() ?? '', /Fix the cable/);
      assert.equal(await saved.locator('input[name^="jf"]').count(), 0);
      await fits(page, 'the saved answers');
      assert.deepEqual(errors, []);
    });
  }
});
