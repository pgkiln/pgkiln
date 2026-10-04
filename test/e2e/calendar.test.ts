// Calendar and chart interactions in a real browser (HR page 24 "Planner"):
// dragging a meeting moves it on the server and redraws the calendar, a click
// on an empty hour opens the form with the time filled in, and a chart's data
// point drills down to a page. All under the strict Content-Security-Policy.
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
let saved: { id: number; starts_at: string; ends_at: string | null }[] = [];

before(async () => {
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  saved = (await owner.query('select id, starts_at, ends_at from hr.meeting')).rows;
  close = async () => {
    for (const m of saved) await owner.query('update hr.meeting set starts_at = $2, ends_at = $3 where id = $1', [m.id, m.starts_at, m.ends_at]);
    await owner.query(`delete from hr.meeting where title = 'E2E meeting'`);
    await browser.close();
    await app.close();
    await closePools();
  };
});

after(() => close());

async function signedIn(width = 1440) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
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

const violations = (page: Page) => page.evaluate(() => (window as any).__csp as string[]);

describe('calendar and chart interactions', () => {
  test('dragging a meeting to another day and hour moves it, keeping its length', async () => {
    const { context, page } = await signedIn();
    const m = await owner.one(`select id, starts_at::date + 1 as next_day from hr.meeting where title = 'Team stand-up'`);
    const day = String(m.next_day);
    await page.goto(`${base}/a/hr/24`);
    const event = page.locator(`.calendar [data-move="${m.id}"]`).first();
    const target = page.locator(`.calendar td[data-drop="${day}T11:00"]`);
    await event.dragTo(target, { targetPosition: { x: 10, y: 20 } });
    await page.locator('.calendar .cal-status', { hasText: 'Team stand-up' }).waitFor();
    const row = await owner.one(`select to_char(starts_at, 'YYYY-MM-DD HH24:MI') as s, to_char(ends_at, 'YYYY-MM-DD HH24:MI') as e from hr.meeting where id = $1`, [m.id]);
    assert.deepEqual(row, { s: `${day} 11:00`, e: `${day} 11:30` });
    // the calendar was redrawn with the meeting in its new slot
    assert.equal(await page.locator(`.calendar td[data-drop="${day}T11:00"] [data-move="${m.id}"]`).count(), 1);
    assert.deepEqual(await violations(page), []);
    await context.close();
  });

  test('a meeting of someone else cannot be moved: the error is shown and nothing changes', async () => {
    const { context, page } = await signedIn();
    await page.goto(`${base}/a/hr/login`);
    await page.fill('#username', 'jones');
    await page.fill('#password', 'jones');
    await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
    const m = await owner.one(`select id, starts_at::date as day, starts_at from hr.meeting where title = 'Budget review'`);
    await page.goto(`${base}/a/hr/24`);
    await page.locator(`.calendar [data-move="${m.id}"]`).first().dragTo(page.locator(`.calendar td[data-drop="${m.day}T16:00"]`), { targetPosition: { x: 10, y: 20 } });
    await page.locator('.alert-error', { hasText: 'Only the organizer' }).waitFor();
    assert.equal(String((await owner.one('select starts_at from hr.meeting where id = $1', [m.id])).starts_at), String(m.starts_at));
    await context.close();
  });

  test('a click on an empty hour opens the form with that time; the meeting is added', async () => {
    const { context, page } = await signedIn();
    await page.goto(`${base}/a/hr/24`);
    const cell = page.locator('.calendar td[data-add]').filter({ hasNot: page.locator('.cal-event') }).nth(20);
    const slot = await cell.getAttribute('data-drop');
    await Promise.all([page.waitForNavigation(), cell.click({ position: { x: 8, y: 30 } })]);
    assert.match(page.url(), /P24_STARTS_AT=/);
    assert.equal(await page.inputValue('#P24_STARTS_AT'), slot);
    await page.fill('#P24_TITLE', 'E2E meeting');
    await Promise.all([page.waitForNavigation(), page.click('button[value="CREATE"]')]);
    assert.equal((await owner.one(`select to_char(starts_at, 'YYYY-MM-DD"T"HH24:MI') as s from hr.meeting where title = 'E2E meeting'`)).s, slot);
    assert.deepEqual(await violations(page), []);
    await context.close();
  });

  test('week, day and list views and the chart drill-down work at phone width', async () => {
    const { context, page } = await signedIn(390);
    await page.goto(`${base}/a/hr/24`);
    for (const view of ['Day', 'List', 'Month', 'Week']) {
      await Promise.all([page.waitForNavigation(), page.click(`.cal-views a:text-is("${view}")`)]);
      assert.equal(await page.locator('.cal-views [aria-current="page"]').textContent(), view);
    }
    // a gauge links to the employee list of its department
    await Promise.all([page.waitForNavigation(), page.locator('.chart-gauge a.gauge').first().click()]);
    assert.match(page.url(), /\/a\/hr\/2\?P2_DEPTNO=\d+&cs=/);
    assert.notEqual(await page.inputValue('#P2_DEPTNO'), '');
    assert.deepEqual(await violations(page), []);
    await context.close();
  });
});
