// The task list's vacation rule in a real browser (migration 094): the rule's
// fields sit inside the page's form, so they post through a detached form.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools, owner } from '../../src/db.ts';

let base = '';
let browser: Browser;
let close: () => Promise<void>;
const rules = () => owner.query(`delete from meta.task_vacation where app_id = (select id from meta.app where alias = 'hr')`);

before(async () => {
  await rules();
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  close = async () => {
    await rules();
    await browser.close();
    await app.close();
    await closePools();
  };
});
after(async () => close());

describe('task list', () => {
  test('a vacation rule is set and removed from the task list; it fits a phone', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${base}/a/hr/login`);
    await page.fill('#username', 'blake');
    await page.fill('#password', 'blake');
    await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
    await page.goto(`${base}/a/hr/14`);
    await page.click('.task-vacation summary');
    const day = (d: number) => new Date(Date.now() + d * 86400_000).toISOString().slice(0, 10);
    await page.fill('.task-vacation input[name="to"]', 'jones');
    await page.fill('.task-vacation input[name="from"]', day(0));
    await page.fill('.task-vacation input[name="until"]', day(7));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390, 'no sideways scrolling');
    await Promise.all([page.waitForNavigation(), page.click('.task-vacation button[value="set"]')]);
    await page.locator('.alert-success', { hasText: 'Vacation rule saved' }).waitFor();
    assert.match(await page.locator('.task-vacation').innerText(), /jones acts on your tasks from/);
    const row = await owner.one(`select delegate_to from meta.task_vacation where username = 'blake'`);
    assert.equal(row?.delegate_to, 'jones');
    await Promise.all([page.waitForNavigation(), page.click('.task-vacation button[value="clear"]')]);
    await page.locator('.alert-success', { hasText: 'Vacation rule removed' }).waitFor();
    assert.equal(await owner.one(`select 1 as ok from meta.task_vacation where username = 'blake'`), undefined);
    await page.close();
  });
});
