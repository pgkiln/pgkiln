// Sprint 36 AI assistant and natural-language report filters in a real
// browser (HR page 38, against the scripted local mock of the Claude API:
// no real API calls), with and without JavaScript, on a phone and a desktop.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import '../../src/env.ts';

process.env.PGAPEX_SECRET_KEY ??= 'e2e-only-secret-key-0123456789abcdef';

const { buildApp } = await import('../../src/app.ts');
const { closePools, owner } = await import('../../src/db.ts');
const { encryptSecret } = await import('../../src/secrets.ts');
const { startScriptMock } = await import('../ai-script-mock.ts');

let base = '';
let browser: Browser;
let mock: Awaited<ReturnType<typeof startScriptMock>>;
let close: () => Promise<void>;

before(async () => {
  mock = await startScriptMock();
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

async function open(javaScriptEnabled: boolean, width: number) {
  const context = await browser.newContext({ javaScriptEnabled, viewport: { width, height: 900 } });
  await context.addInitScript(() => {
    (window as any).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as any).__csp.push(`${e.violatedDirective}: ${e.blockedURI || e.sample || 'inline'}`));
  });
  const page = await context.newPage();
  await page.goto(`${base}/a/hr/login`);
  await page.fill('#username', 'scott');
  await page.fill('#password', 'scott');
  await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
  await page.goto(`${base}/a/hr/38`);
  return page;
}

async function fits(page: Page, what: string) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(over <= 1, `${what}: the page scrolls sideways by ${over}px`);
  if (await page.evaluate(() => !!(window as any).__csp)) assert.deepEqual(await page.evaluate(() => (window as any).__csp), [], `${what}: CSP violations`);
}

for (const js of [true, false])
  for (const width of [390, 1440])
    describe(`HR page 38, ${js ? 'with' : 'without'} JavaScript, ${width}px`, () => {
      test('a question with a tool call, the answer, a new conversation', async () => {
        const page = await open(js, width);
        await fits(page, 'empty chat');
        mock.script = [{ tools: [{ name: 'departments', input: {} }] }, { text: 'There are **4** departments:\n- ACCOUNTING\n- RESEARCH\n- SALES\n- OPERATIONS_WITH_A_VERY_LONG_NAME_WITHOUT_ANY_BREAKS_AT_ALL' }];
        await page.fill('.assistant-input textarea', 'Which departments are there?');
        if (js) await Promise.all([page.waitForNavigation(), page.keyboard.press('Control+Enter')]);
        else await Promise.all([page.waitForNavigation(), page.click('.assistant-actions button.btn-hot')]);
        await page.locator('.assistant-msg-assistant li', { hasText: 'SALES' }).waitFor();
        assert.equal(await page.locator('.assistant-msg-user').count(), 1);
        assert.match(await page.locator('.assistant-tools').innerText(), /departments/);
        await fits(page, 'chat with an answer');
        await Promise.all([page.waitForNavigation(), page.click('.assistant-actions button:not(.btn-hot)')]);
        assert.equal(await page.locator('.assistant-msg-user').count(), 0);
        await page.context().close();
      });

      test('a question about the staff list becomes its filters and sort', async () => {
        const page = await open(js, width);
        mock.script = [{ text: JSON.stringify({ filters: [{ column: 'job', operator: 'eq', value: 'MANAGER' }], search: '', sort_column: 'sal', sort_descending: true }) }];
        await page.fill('.ai-filter input', 'managers, best paid first');
        await Promise.all([page.waitForNavigation(), page.click('.ai-filter button')]);
        const rows = page.locator('section.region-report table tbody tr');
        assert.equal(await rows.count(), 3);
        assert.match(await rows.first().innerText(), /JONES/);
        assert.match(await page.locator('.messages').innerText(), /Applied: Job = MANAGER/);
        await fits(page, 'filtered report');
        await page.context().close();
      });
    });
