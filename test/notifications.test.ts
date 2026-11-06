// In-app notifications and live badges (sprint 165, migration 154; APEX: navigation menu badges, a
// notification bell, badges refreshed while the page is open). HR is the fixture: its settings, a
// navigation bar entry, a test page and the notifications are put back afterwards. The authorization
// and session cases are in security.test.ts.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { processProblems } from '../src/runtime/processes.ts';
import { COMPONENTS } from '../src/builder/components.ts';
import { translatorFor } from '../src/builder/i18n.ts';
import { saveNotificationSettings } from '../src/builder/notification-settings.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
let saved: { notifications: boolean; live_badges_s: number | null; navbar_list: string | null };
let entryId: number;
const PAGE = 9165;

/** meta.notify (or any SQL) as HR's application code, as king. */
async function asApp<T = any>(sql: string, params: unknown[] = []): Promise<T> {
  return owner.tx(async (c) => {
    await c.query(`select set_config('pgkiln.app_id', $1, true), set_config('pgkiln.app_user', 'king', true)`, [String(appId)]);
    return (await c.query(sql, params)).rows[0] as T;
  });
}

async function signedIn(user: string) {
  const b = new Browser(app);
  assert.equal((await b.login(user)).statusCode, 303);
  return b;
}

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  saved = (await owner.one('select notifications, live_badges_s, navbar_list from meta.app where id = $1', [appId]))!;
  await owner.query('delete from meta.notification where app_id = $1', [appId]);
  await owner.query('delete from meta.page where app_id = $1 and page_no = $2', [appId, PAGE]);
  entryId = (await owner.one(
    `insert into meta.list_entry (app_id, list_name, seq, label, icon, target_page, badge_query)
     values ($1, $2, 99, 'Inbox', 'inbox', 1, 'select nullif(meta.unread_notifications(), 0)') returning id`,
    [appId, saved.navbar_list ?? 'HR_NAVBAR'],
  )).id;
  const pageId = (await owner.one(`insert into meta.page (app_id, page_no, name) values ($1, $2, 'Notify test') returning id`, [appId, PAGE])).id;
  const regionId = (await owner.one(`insert into meta.region (page_id, seq, title, type, source) values ($1, 10, 'Send', 'static', '<p>Send</p>') returning id`, [pageId])).id;
  await owner.query(`insert into meta.item (page_id, region_id, seq, name, label, type) values ($1, $2, 1, 'P9165_TO', 'To', 'text')`, [pageId, regionId]);
  await owner.query(
    `insert into meta.button (page_id, region_id, name, label, badge_query) values ($1, $2, 'NOTIFY', 'Notify', 'select meta.unread_notifications()')`,
    [pageId, regionId]);
  await owner.query(
    `insert into meta.process (page_id, seq, name, type, point, when_button, config) values ($1, 1, 'Notify', 'send_notification', 'submit', 'NOTIFY', $2)`,
    [pageId, JSON.stringify({ to: '&P9165_TO.', title: 'From &APP_USER.', body: 'Open employee 7839', page: 3, items: { P3_EMPNO: '7839' }, icon: 'user' })]);
  await owner.query(
    `insert into meta.dynamic_action (page_id, seq, name, event, trigger_element, action, affected_region_id) values ($1, 1, 'Every minute', 'timer', '60', 'refresh_region', $2)`,
    [pageId, regionId]);
});

after(async () => {
  await owner.query('update meta.app set notifications = $2, live_badges_s = $3 where id = $1', [appId, saved.notifications, saved.live_badges_s]);
  await owner.query('delete from meta.list_entry where id = $1', [entryId]);
  await owner.query('delete from meta.page where app_id = $1 and page_no = $2', [appId, PAGE]);
  await owner.query('delete from meta.notification where app_id = $1', [appId]);
  await app.close();
  await closePools();
});

beforeEach(async () => {
  await owner.query('update meta.app set notifications = true, live_badges_s = 30 where id = $1', [appId]);
  await owner.query('delete from meta.notification where app_id = $1', [appId]);
});

describe('meta.notify and the SQL API', () => {
  test('refused while the application has notifications off; checks its arguments', async () => {
    await owner.query('update meta.app set notifications = false where id = $1', [appId]);
    await assert.rejects(asApp(`select meta.notify('allen', 'Hello')`), /notifications are off/);
    await owner.query('update meta.app set notifications = true where id = $1', [appId]);
    await assert.rejects(asApp(`select meta.notify('allen', '  ')`), /title is required/);
    await assert.rejects(asApp(`select meta.notify('al len', 'Hi')`), /user name is required/);
    await assert.rejects(asApp(`select meta.notify('allen', 'Hi', p_icon => 'Bad Icon')`), /icon is an icon name/);
    await assert.rejects(asApp(`select meta.notify('allen', 'Hi', p_page => 77777)`), /page 77777 does not exist/);
    await assert.rejects(asApp(`select meta.notify('allen', 'Hi', p_items => '{"P3_EMPNO": "1"}')`), /with a page/);
    await assert.rejects(owner.query(`select meta.notify('allen', 'Hi')`), /no current application/);
  });

  test('a link signed for the recipient; unread count, mark read and the own view', async () => {
    const { id } = await asApp(`select meta.notify('allen', 'Employee 7839 changed', 'Salary', 3, '{"P3_EMPNO": "7839"}', 'user') as id`);
    const row = await owner.one('select username, url, icon, created_by, read_at from meta.notification where id = $1', [id]);
    assert.equal(row.username, 'allen');
    assert.equal(row.created_by, 'king');
    assert.match(row.url, /^\/a\/hr\/3\?P3_EMPNO=7839&cs=[0-9a-f]{32}$/);
    const cs = (await owner.one(`select meta.url_checksum($1, 3, 'allen', '{"P3_EMPNO": "7839"}') as cs`, [appId])).cs;
    assert.ok(row.url.endsWith(`cs=${cs}`), 'signed for allen, not for king who sent it');
    assert.equal((await asApp(`select meta.unread_notifications('ALLEN') as n`)).n, 1);
    assert.equal((await asApp(`select meta.unread_notifications() as n`)).n, 0, "king's own: none");
    const allen = async (sql: string) => owner.tx(async (c) => {
      await c.query(`select set_config('pgkiln.app_id', $1, true), set_config('pgkiln.app_user', 'allen', true)`, [String(appId)]);
      return (await c.query(sql)).rows[0];
    });
    assert.equal((await allen('select count(*)::int as n from meta.my_notifications')).n, 1);
    assert.equal((await allen('select meta.mark_notifications_read() as n')).n, 1);
    assert.equal((await allen('select meta.unread_notifications() as n')).n, 0);
  });

  test('a user keeps the newest 500', async () => {
    await asApp(`select meta.notify('allen', 'N' || g) from generate_series(1, 505) g`);
    const r = await owner.one(`select count(*)::int as n, min(title) filter (where title = 'N1') as first from meta.notification where app_id = $1 and username = 'allen'`, [appId]);
    assert.equal(r.n, 500);
    assert.equal(r.first, null, 'the oldest went');
  });
});

describe('the bell', () => {
  test('signed-in users see their unread count and newest notifications; nothing when it is off', async () => {
    await asApp(`select meta.notify('allen', 'Approve leave of WARD', 'Two days', 3, '{"P3_EMPNO": "7521"}')`);
    await asApp(`select meta.notify('allen', 'Second <b>one</b>')`);
    await asApp(`select meta.notify('blake', 'For Blake only')`);
    const b = await signedIn('allen');
    const page = (await b.get('/a/hr/1')).body;
    assert.match(page, /<details class="menu t-bell" data-bell>/);
    assert.match(page, /<span class="t-bell-count" data-badge="bell">2<\/span>/);
    assert.match(page, /aria-label="Notifications: 2 unread"/);
    assert.match(page, /Approve leave of WARD/);
    assert.match(page, /Second &lt;b&gt;one&lt;\/b&gt;/, 'escaped');
    assert.doesNotMatch(page, /For Blake only/);
    assert.match(page, /action="\/a\/hr\/notifications\/\d+\/open"/);
    await owner.query('update meta.app set notifications = false where id = $1', [appId]);
    assert.doesNotMatch((await b.get('/a/hr/1')).body, /data-bell/);
    assert.equal((await b.get('/a/hr/notifications')).statusCode, 404);
  });

  test('opening one marks it read and goes to its page; Mark all read', async () => {
    // page 3 is for managers: king is one
    const { id } = await asApp(`select meta.notify('king', 'Open me', null, 3, '{"P3_EMPNO": "7839"}') as id`);
    await asApp(`select meta.notify('king', 'No page')`);
    const b = await signedIn('king');
    await b.get('/a/hr/notifications');
    const res = await b.submit(`/a/hr/notifications/${id}/open`, {});
    assert.equal(res.statusCode, 303);
    assert.match(String(res.headers.location), /^\/a\/hr\/3\?P3_EMPNO=7839&cs=/);
    assert.ok((await owner.one('select read_at from meta.notification where id = $1', [id])).read_at);
    const target = await b.get(String(res.headers.location));
    assert.equal(target.statusCode, 200, 'the signed link opens');
    const list = (await b.get('/a/hr/notifications')).body;
    assert.match(list, /class="t-notification-entry is-unread"/);
    assert.match(list, /class="t-notification-entry"/);
    const read = await b.submit('/a/hr/notifications/read', { next: '/a/hr/notifications' });
    assert.equal(read.headers.location, '/a/hr/notifications');
    assert.equal((await owner.one(`select count(*)::int as n from meta.notification where app_id = $1 and read_at is null`, [appId])).n, 0);
    assert.match((await b.get('/a/hr/notifications')).body, /Notifications marked as read\./);
  });

  test('the page needs a signed-in user', async () => {
    const res = await new Browser(app).get('/a/hr/notifications');
    assert.equal(res.statusCode, 302);
    assert.match(String(res.headers.location), /^\/a\/hr\/login\?next=/);
  });
});

describe('badges', () => {
  test('a list entry\'s badge query in the navigation bar, keyed for the live refresh', async () => {
    await asApp(`select meta.notify('allen', 'A'), meta.notify('allen', 'B'), meta.notify('allen', 'C')`);
    const b = await signedIn('allen');
    const page = (await b.get('/a/hr/1')).body;
    assert.match(page, new RegExp(`<span>Inbox</span> <span class="badge" data-badge="b:${entryId}">3</span>`));
    assert.match(page, /<body[^>]* data-live="30"/);
    await owner.query('update meta.app set live_badges_s = null where id = $1', [appId]);
    const off = (await b.get('/a/hr/1')).body;
    assert.match(off, /<span>Inbox<\/span> <span class="badge">3<\/span>/, 'no keys without live badges');
    assert.doesNotMatch(off, /data-live=/);
  });

  test('the live endpoint: list entries, buttons with a badge query and the bell, as they are now', async () => {
    const b = await signedIn('allen');
    const page = (await b.get(`/a/hr/${PAGE}`)).body;
    assert.match(page, new RegExp(`<span class="badge" data-badge="b:${entryId}" hidden></span>`), 'an empty badge is a hidden place');
    assert.match(page, /<span class="btn-badge" data-badge="btn:\d+">0<\/span>/);
    let live = await b.get(`/a/hr/${PAGE}/live`);
    assert.equal(live.statusCode, 200);
    assert.equal(live.headers['cache-control'], 'private, no-store');
    let state = live.json();
    assert.equal(state.badges[`b:${entryId}`], null);
    assert.equal(state.bell.unread, 0);
    await asApp(`select meta.notify('allen', 'New order'), meta.notify('allen', 'Another')`);
    state = (await b.get(`/a/hr/${PAGE}/live`)).json();
    assert.equal(state.badges[`b:${entryId}`], '2');
    assert.ok(Object.entries(state.badges).some(([k, v]) => k.startsWith('btn:') && v === '2'));
    assert.equal(state.bell.unread, 2);
    assert.equal(state.bell.label, 'Notifications: 2 unread');
    assert.match(state.bell.panel, /New order/);
    await owner.query('update meta.app set live_badges_s = null where id = $1', [appId]);
    assert.equal((await b.get(`/a/hr/${PAGE}/live`)).statusCode, 404);
  });
});

describe('send_notification and the timer event', () => {
  test('the process adds a notification for the user it names, in the page\'s transaction', async () => {
    assert.deepEqual(processProblems('send_notification', { to: '&P1_X.', title: 'Hi' }), []);
    assert.equal(processProblems('send_notification', { title: 'Hi', icon: 'Bad', push: 'yes' }).length, 3);
    const b = await signedIn('king');
    await b.get(`/a/hr/${PAGE}`);
    const res = await b.submit(`/a/hr/${PAGE}`, { __request: 'NOTIFY', P9165_TO: 'allen' });
    assert.equal(res.statusCode, 303, res.body);
    const n = await owner.one(`select title, body, icon, url from meta.notification where app_id = $1 and username = 'allen'`, [appId]);
    assert.deepEqual([n.title, n.body, n.icon], ['From king', 'Open employee 7839', 'user']);
    assert.match(n.url, /^\/a\/hr\/3\?P3_EMPNO=7839&cs=/);
  });

  test('timer: on the page with its seconds; the builder checks them', async () => {
    const b = await signedIn('allen');
    const page = (await b.get(`/a/hr/${PAGE}`)).body;
    assert.match(page, /"event":"timer","trigger":\["60"\]/);
    const check = COMPONENTS.dynamic_action.validate!;
    assert.equal(check({ event: 'timer', trigger_element: '60', action: 'refresh_region' } as never), null);
    assert.match(String(check({ event: 'timer', trigger_element: '2', action: 'refresh_region' } as never)), /5 to 3600/);
    assert.match(String(check({ event: 'timer', trigger_element: 'P1_X', action: 'refresh_region' } as never)), /5 to 3600/);
  });
});

describe('builder settings', () => {
  test('User Interface → Notifications: the bell and live badges, checked', async () => {
    const dev = new Browser(app);
    await dev.get('/builder/login');
    await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
    const form = (await dev.get(`/builder/apps/${appId}/settings?tab=ui`)).body;
    assert.match(form, /name="notifications" value="true" checked/);
    assert.match(form, /name="live_badges_s"[^>]*value="30"/);
    // (the whole settings form is not posted: it would replace HR's other settings)
    const tx = translatorFor('en');
    await saveNotificationSettings(String(appId), { notification_settings: '1', live_badges_s: '120' }, tx);
    let now = await owner.one('select notifications, live_badges_s from meta.app where id = $1', [appId]);
    assert.deepEqual([now.notifications, now.live_badges_s], [false, 120]);
    await assert.rejects(saveNotificationSettings(String(appId), { notification_settings: '1', notifications: 'true', live_badges_s: '5' }, tx), /from 10 to 3600/);
    await saveNotificationSettings(String(appId), { notifications: 'true', live_badges_s: '' }, tx);
    now = await owner.one('select notifications, live_badges_s from meta.app where id = $1', [appId]);
    assert.deepEqual([now.notifications, now.live_badges_s], [false, 120], 'not in the form: unchanged');
    await saveNotificationSettings(String(appId), { notification_settings: '1', notifications: 'true', live_badges_s: '' }, tx);
    now = await owner.one('select notifications, live_badges_s from meta.app where id = $1', [appId]);
    assert.deepEqual([now.notifications, now.live_badges_s], [true, null]);
  });
});
