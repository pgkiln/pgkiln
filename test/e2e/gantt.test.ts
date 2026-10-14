// Gantt drag and drop in a real browser (HR page 32 "Project plan", part 59):
// dragging a task moves it, dragging its end changes its length, the arrow keys
// do the same, a drag never follows the task's drill-down link, and all of it
// under the strict Content-Security-Policy.
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
let saved: { id: number; starts: string; ends: string | null }[] = [];
const DAY = 86_400_000;

before(async () => {
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  saved = (await owner.query('select id, starts::text, ends::text from hr.project_task')).rows;
  close = async () => {
    for (const t of saved) await owner.query('update hr.project_task set starts = $2, ends = $3 where id = $1', [t.id, t.starts, t.ends]);
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
  await page.goto(`${base}/a/hr/32`);
  return { context, page };
}

const task = async (id: number) => owner.one('select starts::text, ends::text from hr.project_task where id = $1', [id]);
const plus = (d: string, days: number) => new Date(Date.parse(d) + days * DAY).toISOString().slice(0, 10);
/** Pixels per day on the chart's time axis. */
const dayWidth = (page: Page) =>
  page.evaluate((day) => {
    const g = document.querySelector<HTMLElement>('.gantt-editable')!;
    return (g.querySelector('.gantt-plot')!.getBoundingClientRect().width / (Number(g.dataset.hi) - Number(g.dataset.lo))) * day;
  }, DAY);

async function drag(page: Page, selector: string, dx: number, from: 'middle' | 'end' = 'middle') {
  const box = (await page.locator(selector).boundingBox())!;
  const x = from === 'end' ? box.x + box.width - 3 : box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) await page.mouse.move(x + (dx * i) / 5, y);
  await page.mouse.up();
}

describe('gantt drag and drop', () => {
  test('dragging a task moves it by whole days and doesn\'t follow its link; its end changes its length', async () => {
    const { context, page } = await signedIn();
    const before = await task(3);
    const w = await dayWidth(page);
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/chart/') && r.url().endsWith('/move')),
      drag(page, '.gantt-editable [data-task="3"]', w * 2),
    ]);
    await page.locator('.gantt-status', { hasText: 'Plan the floor layout' }).waitFor();
    assert.match(page.url(), /\/a\/hr\/32$/, 'still on the plan');
    assert.deepEqual(await task(3), { starts: plus(before.starts, 2), ends: plus(before.ends, 2) });
    // the end handle: three days longer
    const w2 = await dayWidth(page);
    await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/move')),
      drag(page, '.gantt-editable [data-task="3"]', w2 * 3, 'end'),
    ]);
    await page.waitForFunction(() => !document.querySelector('.gantt-editable[aria-busy]'));
    assert.deepEqual(await task(3), { starts: plus(before.starts, 2), ends: plus(before.ends, 5) });
    assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
    await context.close();
  });

  test('the keyboard: arrows move a task, Shift and the arrows change its end, Escape cancels, Enter saves', async () => {
    const { context, page } = await signedIn();
    const before = await task(5);
    const bar = page.locator('.gantt-editable [data-task="5"]');
    await bar.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Escape');
    await bar.focus();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    assert.match(await page.locator('.gantt-status').innerText(), new RegExp(`Network and phones: ${plus(before.starts, -2)} – ${plus(before.ends, -2)}`));
    await Promise.all([page.waitForResponse((r) => r.url().endsWith('/move')), page.keyboard.press('Enter')]);
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-task') === '5');
    assert.deepEqual(await task(5), { starts: plus(before.starts, -2), ends: plus(before.ends, -2) });
    assert.match(page.url(), /\/a\/hr\/32$/, 'Enter saved instead of following the link');
    await page.keyboard.press('Shift+ArrowRight');
    await Promise.all([page.waitForResponse((r) => r.url().endsWith('/move')), page.keyboard.press('Enter')]);
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-task') === '5');
    assert.deepEqual(await task(5), { starts: plus(before.starts, -2), ends: plus(before.ends, -1) });
    await context.close();
  });

  test('a click without a drag still follows the task\'s link; on a phone the chart fits', async () => {
    const { context, page } = await signedIn(390);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), 'no sideways scroll');
    await Promise.all([page.waitForURL(/\/a\/hr\/2\?/), page.locator('.gantt-editable [data-task="1"]').click()]);
    await context.close();
  });
});
