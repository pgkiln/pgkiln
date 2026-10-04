// Calendar region (src/runtime/calendar.ts): month, week, day and list views,
// create on click and drag and drop, against the HR example's page 24
// "Planner" (meetings) and page 12 (leave, a calendar without the new settings).
// Drag and drop in a real browser: test/e2e/calendar.test.ts; the endpoint's
// security: test/security.test.ts ("sprint 26 views").
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { urlChecksum } from '../src/security.ts';
import { calendarViews, moveEvent, parseDay, parseTarget } from '../src/runtime/calendar.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let king: Browser;
let appId: number;
let rid: number;
let monday: string;
let saved: { id: number; starts_at: string; ends_at: string | null }[] = [];

before(async () => {
  app = await buildApp({ logger: false });
  king = new Browser(app);
  await king.login('king');
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  rid = (await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 24 and r.type = 'calendar'`, [appId])).id;
  monday = (await owner.one(`select to_char(date_trunc('week', current_date), 'YYYY-MM-DD') as d`)).d;
  saved = (await owner.query('select id, starts_at, ends_at from hr.meeting')).rows;
});

after(async () => {
  for (const m of saved) await owner.query('update hr.meeting set starts_at = $2, ends_at = $3 where id = $1', [m.id, m.starts_at, m.ends_at]);
  await app.close();
  await closePools();
});

const meeting = async (title: string) => (await owner.one(`select id from hr.meeting where title = $1`, [title])).id as number;
const hrefs = (body: string, cls: string) => [...body.matchAll(new RegExp(`<a class="${cls}" href="([^"]+)"`, 'g'))].map((m) => m[1].replace(/&amp;/g, '&'));

describe('calendar: moving events (pure)', () => {
  test('targets are real dates, optionally with an hour', () => {
    assert.ok(parseTarget('2026-10-05'));
    assert.deepEqual(parseTarget('2026-10-05T09:30')?.minutes, 570);
    for (const bad of ['2026-02-30', '2026-10-05T24:00', '2026-10-05 09:00', "2026-10-05'; drop", '', '0000-01-01']) assert.equal(parseTarget(bad), null, bad);
    assert.equal(parseDay('2026-13-01'), null);
  });

  test('a timed event dropped on an hour starts there; the duration stays', () => {
    assert.deepEqual(moveEvent('2026-10-05 09:00:00', '2026-10-05 09:30:00', '2026-10-07T14:00'), { start: '2026-10-07 14:00', end: '2026-10-07 14:30' });
    // across midnight, and the zone suffix of timestamptz values is kept
    assert.deepEqual(moveEvent('2026-10-05 22:00:00+02', '2026-10-06 01:00:00+02', '2026-10-09T23:00'), { start: '2026-10-09 23:00+02', end: '2026-10-10 02:00+02' });
  });

  test('dropped on a day: whole days, keeping the time of day; date events stay dates', () => {
    assert.deepEqual(moveEvent('2026-10-05 09:00:00', null, '2026-10-01'), { start: '2026-10-01 09:00', end: null });
    assert.deepEqual(moveEvent('2026-10-05', '2026-10-07', '2026-11-02'), { start: '2026-11-02', end: '2026-11-04' });
    assert.deepEqual(moveEvent('2026-10-05', null, '2026-10-06T10:00'), { start: '2026-10-06', end: null }, 'an all-day event ignores the hour');
    assert.equal(moveEvent('not a date', null, '2026-10-06'), null);
  });

  test('views: all four unless some are listed', () => {
    assert.deepEqual(calendarViews({}), ['month', 'week', 'day', 'list']);
    assert.deepEqual(calendarViews({ views: ['list', 'week', 'x'] }), ['week', 'list']);
    assert.deepEqual(calendarViews({ views: ['x'] }), ['month', 'week', 'day', 'list']);
  });
});

describe('calendar: views', () => {
  test('week view (the region\'s first view): hours, all-day row, meetings in their slot, the switcher', async () => {
    const body = (await king.get(`/a/hr/24?r${rid}_d=${monday}`)).body;
    assert.match(body, /<table class="cal-grid cal-week">/);
    assert.match(body, /<a class="btn active" href="[^"]*" aria-current="page">Week<\/a>/);
    assert.match(body, new RegExp(`<td data-drop="${monday}T09:00" data-add>.*?Team stand-up.*?09:00–09:30`, 's'));
    assert.match(body, /<tr class="cal-allday"><th scope="row">All day<\/th>/);
    assert.match(body, /<th scope="row" class="cal-hour">08:00<\/th>/);
    assert.match(body, /<th scope="row" class="cal-hour">17:00<\/th>/);
    assert.doesNotMatch(body, /cal-hour">18:00/);
    // the switcher keeps the day; the week view is the default, so it has no _v
    assert.match(body, new RegExp(`href="/a/hr/24\\?r${rid}_v=month&amp;r${rid}_m=${monday.slice(0, 7)}"`));
    assert.match(body, new RegExp(`href="/a/hr/24\\?r${rid}_v=day&amp;r${rid}_d=${monday}"`));
  });

  test('day, list and month views', async () => {
    const day = (await king.get(`/a/hr/24?r${rid}_v=day&r${rid}_d=${monday}`)).body;
    assert.match(day, /<table class="cal-grid cal-day">/);
    assert.match(day, /Team stand-up/);
    assert.doesNotMatch(day, /Budget review/, 'Tuesday');
    assert.match(day, /aria-label="Next day"/);
    const list = (await king.get(`/a/hr/24?r${rid}_v=list&r${rid}_m=${monday.slice(0, 7)}`)).body;
    assert.match(list, /<ol class="cal-list">/);
    assert.match(list, /<span class="cal-when">09:00–09:30<\/span><a class="cal-event timed"[^>]*>Team stand-up<\/a>/);
    const month = (await king.get(`/a/hr/24?r${rid}_v=month&r${rid}_m=2020-02`)).body;
    assert.match(month, /<table class="cal-month">/);
    assert.match(month, /February 2020/);
    assert.match(month, /Nothing planned this month\./);
  });

  test('a calendar without new settings keeps its month view and gains the switcher (page 12)', async () => {
    const body = (await king.get('/a/hr/12')).body;
    assert.match(body, /<table class="cal-month">/);
    assert.match(body, /<nav class="cal-views buttons" aria-label="Calendar view">/);
    assert.doesNotMatch(body, /data-calendar=|data-drop=|cal-add/, 'no drag and drop or create links unless configured');
  });

  test('more than four events on a day link to that day', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 5; i++)
      ids.push((await owner.one(`insert into hr.meeting (title, starts_at, organizer) values ($1, $2::date + time '08:00', 'king') returning id`, [`Busy ${i}`, '2030-01-15'])).id);
    try {
      const body = (await king.get(`/a/hr/24?r${rid}_v=month&r${rid}_m=2030-01`)).body;
      assert.match(body, new RegExp(`<a class="cal-more" href="/a/hr/24\\?r${rid}_v=day&amp;r${rid}_d=2030-01-15">\\+1 more</a>`));
    } finally {
      await owner.query('delete from hr.meeting where id = any($1)', [ids]);
    }
  });

  test('in Dutch', async () => {
    const nl = new Browser(app, { 'accept-language': 'nl' });
    await nl.login('king');
    await nl.get('/a/hr/1?lang=nl');
    const body = (await nl.get(`/a/hr/24?r${rid}_d=${monday}`)).body;
    assert.match(body, /Hele dag/);
    assert.match(body, />Maand<\/a>/);
  });
});

describe('calendar: create on click', () => {
  test('each day and hour has a checksummed link with the slot; the form opens with it', async () => {
    const body = (await king.get(`/a/hr/24?r${rid}_d=${monday}`)).body;
    const links = hrefs(body, 'cal-add');
    assert.equal(links.length, 7 * 11, '7 days × (all day + 10 hours)');
    const at10 = links.find((h) => h.includes(`P24_STARTS_AT=${monday}+10%3A00`))!;
    const q = new URLSearchParams(at10.split('?')[1]);
    assert.equal(q.get('P24_ENDS_AT'), `${monday} 11:00`);
    assert.equal(q.get('cs'), urlChecksum(appId, 24, 'king', { P24_STARTS_AT: `${monday} 10:00`, P24_ENDS_AT: `${monday} 11:00` }));
    const form = (await king.get(at10)).body;
    assert.match(form, new RegExp(`id="P24_STARTS_AT" name="P24_STARTS_AT" value="${monday}T10:00"`));
    // an all-day slot gives a date, which a datetime item shows as midnight
    const allDay = links.find((h) => h.includes(`P24_STARTS_AT=${monday}&`))!;
    assert.match((await king.get(allDay)).body, new RegExp(`name="P24_STARTS_AT" value="${monday}T00:00"`));
  });
});

describe('calendar: drag and drop', () => {
  test('the organizer moves a meeting; the answer is the redrawn calendar', async () => {
    const id = await meeting('Team stand-up');
    await king.get(`/a/hr/24?r${rid}_d=${monday}`);
    const res = await king.post(`/a/hr/24/calendar/${rid}/move`, { __csrf: king.lastCsrf, key: String(id), to: `${monday}T15:00`, __url_params: `r${rid}_d=${monday}` });
    assert.equal(res.statusCode, 200, res.body);
    const out = res.json();
    assert.match(out.message, /^Team stand-up moved to \d{4}-\d{2}-\d{2} 15:00\.$/);
    assert.match(out.region, new RegExp(`<td data-drop="${monday}T15:00" data-add>.*?Team stand-up`, 's'));
    assert.match(out.region, /^<section class="region region-calendar/);
    const row = await owner.one(`select to_char(starts_at, 'HH24:MI') as s, to_char(ends_at, 'HH24:MI') as e from hr.meeting where id = $1`, [id]);
    assert.deepEqual(row, { s: '15:00', e: '15:30' });
    const log = await owner.one(`select detail from meta.activity_log where event = 'calendar_move' order by id desc limit 1`);
    assert.match(log.detail, new RegExp(`key ${id} to ${monday}T15:00`));
  });

  test('a move the application refuses (not the organizer) is a 400 with its message', async () => {
    const jones = new Browser(app);
    await jones.login('jones');
    await jones.get('/a/hr/24');
    const id = await meeting('Budget review');
    const res = await jones.post(`/a/hr/24/calendar/${rid}/move`, { __csrf: jones.lastCsrf, key: String(id), to: `${monday}T08:00` });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /Only the organizer can move this meeting/);
  });
});
