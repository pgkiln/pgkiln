// The sprint 26 item types in a real browser: the rich text editor, the
// Markdown toolbar, tags, star rating, date range and password reveal are
// progressive enhancements that save what the plain form would, without
// breaking the Content-Security-Policy; and the page works without JavaScript.
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
let id: string;

before(async () => {
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  id = String(
    (await owner.one(`insert into hr.review (empno, period, rating, skills, summary, notes, created_by)
                      values (7566, '2025-01-01:2025-12-31', 2, 'SQL', '<p>Start</p>', 'start', 'e2e') returning id`)).id,
  );
  close = async () => {
    await owner.query(`delete from hr.review where created_by = 'e2e'`);
    await browser.close();
    await app.close();
    await closePools();
  };
});
after(() => close());

async function open(javaScriptEnabled = true) {
  const context = await browser.newContext({ javaScriptEnabled });
  await context.addInitScript(() => {
    (window as any).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as any).__csp.push(`${e.violatedDirective}: ${e.blockedURI || e.sample || 'inline'}`));
  });
  const page = await context.newPage();
  await page.goto(`${base}/a/hr/login`);
  await page.fill('#username', 'king');
  await page.fill('#password', 'king');
  await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
  await page.goto(`${base}/a/hr/20`);
  // the review, through the report's link (the URL carries a checksum)
  await Promise.all([page.waitForNavigation(), page.locator('table a', { hasText: new RegExp(`^${id}$`) }).first().click()]);
  return page;
}

const violations = (page: Page) => page.evaluate(() => (window as any).__csp as string[]);

describe('sprint 26 item types', () => {
  test('editing with the enhanced controls saves the same values as the plain form', async () => {
    const page = await open();
    // rich text: an editable area with a toolbar instead of the textarea
    assert.equal(await page.locator('#P20_SUMMARY').isHidden(), true);
    const editor = page.locator('.rte-area');
    await editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.locator('[data-richtext] button[data-cmd=bold]').click();
    await page.keyboard.type('Bold');
    // Markdown: the toolbar wraps the selection
    await page.fill('#P20_NOTES', 'word');
    await page.locator('#P20_NOTES').selectText();
    await page.locator('[data-markdown] button[data-cmd=bold]').click();
    assert.equal(await page.inputValue('#P20_NOTES'), '**word**');
    // tags: add one, remove one
    const tagInput = page.locator('[data-tags] input[list]');
    await tagInput.fill('Planning');
    await tagInput.press('Enter');
    await tagInput.fill('Brand new');
    await tagInput.press('Enter');
    await page.locator('.tag-remove[aria-label="Remove SQL"]').click();
    assert.deepEqual((await page.locator('.tag-list .tag').allInnerTexts()).map((t) => t.replace(/\s*×$/, '')), ['Planning', 'Brand new']);
    // rating and dates
    await page.click('label[for="P20_RATING_5"]');
    await page.fill('#P20_PERIOD', '2025-07-01');
    assert.equal(await page.getAttribute('#P20_PERIOD_TO', 'min'), '2025-07-01');
    // password reveal
    await page.fill('#P20_PIN', 'abc');
    await page.click('[data-reveal="P20_PIN"]');
    assert.equal(await page.getAttribute('#P20_PIN', 'type'), 'text');
    assert.equal(await page.getAttribute('[data-reveal="P20_PIN"]', 'aria-pressed'), 'true');
    await page.click('[data-reveal="P20_PIN"]');
    assert.equal(await page.getAttribute('#P20_PIN', 'type'), 'password');

    await Promise.all([page.waitForNavigation(), page.click('button:has-text("Apply changes")')]);
    assert.equal(await page.locator('.alert-error').count(), 0);
    const row = await owner.one('select * from hr.review where id = $1', [id]);
    assert.equal(row.period, '2025-07-01:2025-12-31');
    assert.equal(row.rating, 5);
    assert.equal(row.skills, 'Planning:Brand new');
    assert.match(row.summary, /^<p>Start<\/p>.*<b>Bold<\/b>/);
    assert.equal(row.notes, '**word**');
    assert.equal(await page.locator('svg.qr-code').count(), 1);
    assert.deepEqual(await violations(page), []);
  });

  test('pasted HTML goes through the allow-list before it reaches the page', async () => {
    const page = await open();
    const editor = page.locator('.rte-area');
    await editor.click();
    await page.keyboard.press('Control+End');
    await editor.evaluate((el) => {
      const data = new DataTransfer();
      data.setData('text/html', '<p style="color:red" onclick="alert(1)">Pasted <b class="x">bold</b><img src="https://evil.example/x.png"><script>alert(1)</script></p><a href="javascript:alert(1)">bad</a> <a href="https://example.com/">good</a>');
      data.setData('text/plain', 'Pasted bold');
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    const inner = await editor.innerHTML();
    assert.match(inner, /Pasted (<\/span>)?<b>bold<\/b>/); // Chrome may wrap the text in a bare span
    assert.doesNotMatch(inner, /style=|onclick|<img|<script|javascript:|class="x"/);
    assert.match(inner, /<a href="https:\/\/example.com\/" rel="noopener noreferrer nofollow">good<\/a>/);
    assert.equal(await page.inputValue('#P20_SUMMARY'), inner);
    assert.deepEqual(await violations(page), []);
  });

  test('without JavaScript the plain controls work', async () => {
    const page = await open(false);
    assert.equal(await page.locator('.rte-toolbar').first().isHidden(), true);
    await page.fill('#P20_SUMMARY', '<p>Plain <i>HTML</i></p><script>x</script>');
    await page.fill('#P20_SKILLS', 'A:B');
    await page.click('label[for="P20_RATING_3"]');
    await page.fill('#P20_PERIOD_TO', '2025-11-30');
    await Promise.all([page.waitForNavigation(), page.click('button:has-text("Apply changes")')]);
    const row = await owner.one('select * from hr.review where id = $1', [id]);
    assert.equal(row.summary, '<p>Plain <i>HTML</i></p>');
    assert.equal(row.skills, 'A:B');
    assert.equal(row.rating, 3);
    assert.equal(row.period, '2025-07-01:2025-11-30');
  });
});
