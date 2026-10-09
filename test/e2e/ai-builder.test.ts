// Sprint 36 App Builder AI in a real browser (against the scripted local mock
// of the Claude API: no real API calls): SQL from a question, a drafted table
// description and proposed pages, on a phone and a desktop.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import '../../src/env.ts';

process.env.PGKILN_SECRET_KEY ??= 'e2e-only-secret-key-0123456789abcdef';

const { buildApp } = await import('../../src/app.ts');
const { closePools, owner } = await import('../../src/db.ts');
const { encryptSecret } = await import('../../src/secrets.ts');
const { startScriptMock } = await import('../ai-script-mock.ts');

let base = '';
let browser: Browser;
let mock: Awaited<ReturnType<typeof startScriptMock>>;
let close: () => Promise<void>;
let appId = 0;
const SVC = 'E2E_BUILDER_AI';

before(async () => {
  mock = await startScriptMock();
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  await owner.query(`delete from meta.ai_service where name = $1`, [SVC]);
  const svc = (await owner.one(`insert into meta.ai_service (name, provider, model, base_url, api_key_enc) values ($1, 'anthropic', 'claude-opus-5-5', $2, $3) returning id`,
    [SVC, `${mock.base}/claude`, encryptSecret('sk-ant-e2e')])).id;
  await owner.query('update meta.builder_ai set service_id = $1', [svc]);
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  close = async () => {
    await owner.query('update meta.builder_ai set service_id = null');
    await owner.query(`delete from meta.ai_usage where service = $1`, [SVC]);
    await owner.query(`delete from meta.ai_service where name = $1`, [SVC]);
    await browser.close();
    await app.close();
    await mock.close();
    await closePools();
  };
});
after(() => close());

async function open(width: number) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.addInitScript(() => {
    (window as any).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as any).__csp.push(`${e.violatedDirective}: ${e.blockedURI || e.sample || 'inline'}`));
  });
  const page = await context.newPage();
  await page.goto(`${base}/builder/login`);
  await page.fill('#f_username', 'admin');
  await page.fill('#f_password', 'admin');
  await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
  return page;
}

async function fits(page: Page, what: string) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(over <= 1, `${what}: the page scrolls sideways by ${over}px`);
  assert.deepEqual(await page.evaluate(() => (window as any).__csp), [], `${what}: CSP violations`);
}

for (const width of [390, 1440])
  describe(`App Builder AI, ${width}px`, () => {
    test('SQL from a question, then explained', async () => {
      const page = await open(width);
      await page.goto(`${base}/builder/sql/ai`);
      mock.script = [{ text: JSON.stringify({ sql: 'select d.dname, count(e.empno) as employees_with_a_rather_long_column_alias_name from hr.dept d left join hr.emp e on e.deptno = d.deptno group by d.dname order by 2 desc', explanation: 'Counts employees per department.' }) }];
      await page.fill('#f_question', 'employees per department');
      await Promise.all([page.waitForNavigation(), page.click('form[action$="/sql/ai/sql"] button')]);
      assert.match(await page.locator('#f_ai_sql').inputValue(), /^select d\.dname/);
      await fits(page, 'SQL from a question');
      mock.script = [{ text: 'It counts **employees** per department:\n- a left join keeps empty departments' }];
      await page.fill('#f_sql', 'select 1');
      await Promise.all([page.waitForNavigation(), page.click('form[action$="/sql/ai/explain"] button')]);
      await page.locator('.ai-answer li').waitFor();
      await fits(page, 'explanation');
      await page.context().close();
    });

    test('a drafted table description and proposed pages', async () => {
      const page = await open(width);
      await page.goto(`${base}/builder/sql/ai/describe?schema=hr&table=emp`);
      mock.script = [{ text: JSON.stringify({ table: 'Employees of the company.', columns: [{ name: 'sal', description: 'Monthly salary in dollars.' }] }) }];
      await Promise.all([page.waitForNavigation(), page.click('button[formaction$="/describe/draft"]')]);
      assert.equal(await page.locator('input[name="note:sal"]').inputValue(), 'Monthly salary in dollars.');
      await fits(page, 'drafted description');
      await page.goto(`${base}/builder/apps/${appId}/ai-pages`);
      mock.script = [{ text: JSON.stringify({ pages: [
        { kind: 'report_form', table: 'hr.dept', page: 90, form_page: 91, label: 'Departments', reason: 'To manage departments with a rather long explanation of why this page helps.' },
        { kind: 'calendar', table: 'hr.leave_request', page: 92, form_page: null, label: 'Leave calendar', reason: 'Leave by date.' },
      ] }) }];
      await page.fill('#f_description', 'departments and a leave calendar');
      await Promise.all([page.waitForNavigation(), page.click('form[action$="/ai-pages"] button.btn-hot')]);
      assert.equal(await page.locator('input[name^="page_"]').count(), 2);
      await fits(page, 'proposed pages');
      await page.context().close();
    });

    test('a blueprint drafted by AI, reviewed (not created)', async () => {
      const page = await open(width);
      await page.goto(`${base}/builder/blueprints/new`);
      await fits(page, 'blueprint editor');
      mock.script = [{ text: JSON.stringify({
        name: 'Field service with a rather long application name', alias: 'e2e-blueprint-not-created', schema: 'e2e_blueprint_not_created',
        tables: [{ name: 'customer_with_a_long_table_name', label: 'Customers', columns: [{ name: 'name', type: 'text', required: true, unique: true, values: [], references: '' },
          { name: 'segment', type: 'text', required: false, unique: false, values: ['Small', 'Medium', 'Large', 'Enterprise', 'Government', 'Non-profit'], references: '' }] },
          { name: 'visit', label: 'Visits', columns: [{ name: 'customer_id', type: 'integer', required: true, unique: false, values: [], references: 'customer_with_a_long_table_name' }, { name: 'visited_on', type: 'date', required: true, unique: false, values: [], references: '' }] }],
        pages: [{ type: 'report_form', table: 'customer_with_a_long_table_name', page: 2, form_page: 3, label: 'Customers', text: '' }, { type: 'calendar', table: 'visit', page: 4, form_page: null, label: 'Visits', text: '' }],
        dashboard: true, sample_data: [],
      }) }];
      await page.fill('#f_description', 'field service visits');
      await Promise.all([page.waitForNavigation(), page.click('form[action$="/blueprints/draft"] button')]);
      assert.match(await page.locator('#f_spec').inputValue(), /customer_with_a_long_table_name/);
      await Promise.all([page.waitForNavigation(), page.click('form[action$="/blueprints/review"] button.btn-hot')]);
      await page.locator('text=Create the application').first().waitFor();
      await page.locator('summary', { hasText: 'The SQL' }).click();
      await fits(page, 'blueprint review');
      await page.context().close();
    });
  });
