// Sprint 165 (migration 154): the notification bell and live badges in a real browser. A notification added
// while the page is open shows on the bell and on a navigation bar badge without a reload; opening it from the
// bell goes to its page; a timer dynamic action runs again and again. HR is the fixture, put back afterwards.
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
let appId = 0;
let entry = 0;
const PAGE = 9166;

const notify = (user: string, title: string, page: number | null = null) =>
  owner.tx(async (c) => {
    await c.query(`select set_config('pgkiln.app_id', $1, true), set_config('pgkiln.app_user', 'king', true)`, [String(appId)]);
    await c.query('select meta.notify($1, $2, null, $3)', [user, title, page]);
  });

before(async () => {
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  const saved = (await owner.one('select notifications, live_badges_s, navbar_list from meta.app where id = $1', [appId]))!;
  await owner.query('update meta.app set notifications = true, live_badges_s = 10 where id = $1', [appId]);
  await owner.query('delete from meta.notification where app_id = $1', [appId]);
  await owner.query('delete from meta.page where app_id = $1 and page_no = $2', [appId, PAGE]);
  entry = (await owner.one(
    `insert into meta.list_entry (app_id, list_name, seq, label, icon, target_page, badge_query)
     values ($1, $2, 99, 'Inbox', 'inbox', 1, 'select nullif(meta.unread_notifications(), 0)') returning id`, [appId, saved.navbar_list ?? 'HR_NAVBAR'])).id;
  const p = (await owner.one(`insert into meta.page (app_id, page_no, name) values ($1, $2, 'Timer') returning id`, [appId, PAGE])).id;
  const r = (await owner.one(`insert into meta.region (page_id, seq, title, type, source) values ($1, 1, 'Clock', 'static', '<p>clock</p>') returning id`, [p])).id;
  await owner.query(`insert into meta.item (page_id, region_id, seq, name, label, type) values ($1, $2, 1, 'P9166_RUNS', 'Runs', 'text')`, [p, r]);
  await owner.query(
    `insert into meta.dynamic_action (page_id, seq, name, event, trigger_element, action, code, affected_items, items_to_submit)
     values ($1, 1, 'Count', 'timer', '5', 'set_value', 'select coalesce(nullif(:P9166_RUNS, ''''), ''0'')::int + 1 as "P9166_RUNS"', 'P9166_RUNS', 'P9166_RUNS')`, [p]);
  close = async () => {
    await owner.query('update meta.app set notifications = $2, live_badges_s = $3 where id = $1', [appId, saved.notifications, saved.live_badges_s]);
    await owner.query('delete from meta.list_entry where id = $1', [entry]);
    await owner.query('delete from meta.page where app_id = $1 and page_no = $2', [appId, PAGE]);
    await owner.query('delete from meta.notification where app_id = $1', [appId]);
    await browser.close();
    await app.close();
    await closePools();
  };
});
after(async () => close());

async function signIn(user: string) {
  const page = await browser.newPage();
  await page.goto(`${base}/a/hr/login`);
  await page.fill('input[name="username"]', user);
  await page.fill('input[name="password"]', user);
  await Promise.all([page.waitForURL(/\/a\/hr\/1/), page.click('button[type="submit"], .login-card button.btn-hot')]);
  return page;
}

describe('live badges and the bell', () => {
  test('a new notification reaches the open page; opening it from the bell goes to its page', async () => {
    const page = await signIn('allen');
    const count = page.locator('[data-bell] [data-badge="bell"]');
    const inbox = page.locator(`[data-badge="b:${entry}"]`);
    assert.equal(await count.isHidden(), true);
    assert.equal(await inbox.isHidden(), true);
    await notify('allen', 'Leave request of WARD', 2);
    await notify('allen', 'Second one');
    // the next refresh (every 10 s) shows them
    await count.waitFor({ state: 'visible', timeout: 15000 });
    assert.equal(await count.textContent(), '2');
    assert.equal(await inbox.textContent(), '2');
    assert.equal(await page.locator('[data-bell] summary').getAttribute('aria-label'), 'Notifications: 2 unread');
    await page.click('[data-bell] summary');
    const item = page.locator('[data-bell-panel] .t-notification', { hasText: 'Leave request of WARD' });
    await item.waitFor();
    await Promise.all([page.waitForURL(/\/a\/hr\/2$/), item.click()]);
    assert.equal(await page.locator('[data-bell] [data-badge="bell"]').textContent(), '1', 'one read now');
    await page.close();
  });

  test('a timer dynamic action runs every few seconds', async () => {
    const page = await signIn('allen');
    await page.goto(`${base}/a/hr/${PAGE}`);
    const runs = page.locator('[name="P9166_RUNS"]');
    await page.waitForFunction(() => Number((document.querySelector('[name="P9166_RUNS"]') as HTMLInputElement)?.value) >= 2, null, { timeout: 15000 });
    assert.ok(Number(await runs.inputValue()) >= 2);
    await page.close();
  });
});
