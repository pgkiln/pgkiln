// Sprint 36 "Generate text with AI" in a real browser (HR page 37, against
// the local mock of the Claude API: no real API calls): with JavaScript the
// buttons run the processes through their dynamic actions (no page submit,
// the button waits for the answer); without JavaScript they submit the page.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import '../../src/env.ts';

process.env.PGKILN_SECRET_KEY ??= 'e2e-only-secret-key-0123456789abcdef';

const { buildApp } = await import('../../src/app.ts');
const { closePools, owner } = await import('../../src/db.ts');
const { encryptSecret } = await import('../../src/secrets.ts');
const { startAiMock } = await import('../ai-mock.ts');

let base = '';
let browser: Browser;
let mock: Awaited<ReturnType<typeof startAiMock>>;
let close: () => Promise<void>;

before(async () => {
  mock = await startAiMock();
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  await owner.query(`delete from meta.ai_service where name = 'HR_ASSISTANT'`);
  const svc = (await owner.one(`insert into meta.ai_service (name, provider, model, effort, base_url, api_key_enc) values ('HR_ASSISTANT', 'anthropic', 'claude-opus-5-5', 'medium', $1, $2) returning id`,
    [`${mock.base}/claude`, encryptSecret('sk-ant-e2e')])).id;
  await owner.query(`insert into meta.app_ai_service (app_id, service_id) select id, $1 from meta.app where alias = 'hr'`, [svc]);
  close = async () => {
    await owner.query(`delete from meta.ai_usage where service = 'HR_ASSISTANT'`);
    await owner.query(`delete from meta.ai_service where name = 'HR_ASSISTANT'`);
    await browser.close();
    await app.close();
    await mock.close();
    await closePools();
  };
});
after(() => close());

async function open(javaScriptEnabled: boolean, width = 1440) {
  const context = await browser.newContext({ javaScriptEnabled, viewport: { width, height: 900 } });
  await context.addInitScript(() => {
    (window as any).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as any).__csp.push(`${e.violatedDirective}: ${e.blockedURI || e.sample || 'inline'}`));
  });
  const page = await context.newPage();
  await page.goto(`${base}/a/hr/login`);
  await page.fill('#username', 'king');
  await page.fill('#password', 'king');
  await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
  await page.goto(`${base}/a/hr/37`);
  return page;
}

const violations = (page: Page) => page.evaluate(() => (window as any).__csp as string[]);

describe('sprint 36 Generate text with AI (HR page 37)', () => {
  test('with JavaScript: Summarise and Fill in the request run without a page submit', async () => {
    const page = await open(true, 390);
    assert.doesNotMatch(await page.content(), /No AI service is configured/);
    await page.evaluate(() => ((window as any).__marker = 'still here'));
    await page.fill('#P37_MESSAGE', 'Hi, I would like the week of 16 November off to help my parents move. <b>Ann</b>');
    mock.mode = 'text';
    mock.answer = 'Ann asks for <i>the week</i> of 16 November off to help her parents move.';
    await page.click('button[data-button="SUMMARISE"]');
    await page.waitForFunction(() => (document.getElementById('P37_SUMMARY') as HTMLTextAreaElement).value.startsWith('Ann asks'));
    assert.equal(await page.inputValue('#P37_SUMMARY'), 'Ann asks for <i>the week</i> of 16 November off to help her parents move.');
    assert.equal(await page.locator('#P37_SUMMARY i').count(), 0, 'the answer is text, not markup');
    mock.answer = JSON.stringify({ start_date: '2026-11-16', end_date: '2026-11-20', reason: 'Helping parents move house' });
    await page.click('button[data-button="READ"]');
    await page.waitForFunction(() => (document.getElementById('P37_START_DATE') as HTMLInputElement).value === '2026-11-16');
    assert.equal(await page.inputValue('#P37_END_DATE'), '2026-11-20');
    assert.equal(await page.inputValue('#P37_REASON'), 'Helping parents move house');
    assert.equal(await page.evaluate(() => (window as any).__marker), 'still here', 'the page was not reloaded');
    assert.equal(await page.locator('button[data-button="READ"]').isDisabled(), false, 'the button is enabled again');
    const sent = mock.seen.filter((r) => r.path === '/claude/v1/messages').at(-1)!;
    assert.match(sent.body.messages[0].content, /&lt;b&gt;Ann&lt;\/b&gt;/, 'the message is sent as escaped data');
    assert.deepEqual(await violations(page), []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true, 'fits a phone');
    await page.context().close();
  });

  test('an error comes back as a message, the items stay', async () => {
    const page = await open(true);
    await page.fill('#P37_MESSAGE', 'Anything');
    await page.fill('#P37_SUMMARY', 'kept');
    mock.mode = 'rate';
    try {
      await page.click('button[data-button="SUMMARISE"]');
      await page.getByText(/busy \(rate limit\)/).first().waitFor();
    } finally {
      mock.mode = 'text';
    }
    assert.equal(await page.inputValue('#P37_SUMMARY'), 'kept');
    assert.deepEqual(await violations(page), []);
    await page.context().close();
  });

  test('without JavaScript the button submits the page and the process runs', async () => {
    const page = await open(false);
    await page.fill('#P37_MESSAGE', 'Two days off next week for a training.');
    mock.answer = 'A two-day training next week.';
    await Promise.all([page.waitForNavigation(), page.click('button[data-button="SUMMARISE"]')]);
    assert.equal(await page.inputValue('#P37_SUMMARY'), 'A two-day training next week.');
    assert.match(await page.content(), /Summary written: check it before you use it\./);
    await page.context().close();
  });
});
