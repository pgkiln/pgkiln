// Dates in the application's date format with pgkiln's date picker (sprint 84, parity handoff IR-4):
// date items, date range items, interactive grid cells and a faceted search's custom date range are
// text in the date format (YYYY-MM-DD without one), read back as dates. HR is the fixture, with a
// date format set for this test (restored afterwards).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { Browser, gridForm } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
let saved: string | null;
let king: Browser;
const R: Record<string, number> = {};

before(async () => {
  app = await buildApp({ logger: false });
  const a = await owner.one(`select id, date_format from meta.app where alias = 'hr'`);
  appId = a.id;
  saved = a.date_format;
  await owner.query(`update meta.app set date_format = 'DD-MM-YYYY' where id = $1`, [appId]);
  for (const r of (await owner.query(`select r.id, r.title from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 27`, [appId])).rows) R[r.title] = r.id;
  king = new Browser(app);
  assert.equal((await king.login('king')).statusCode, 303);
});
after(async () => {
  await owner.query('update meta.app set date_format = $2 where id = $1', [appId, saved]);
  await owner.query(`update hr.emp set hiredate = '1981-12-03' where ename = 'JAMES'`);
  await app.close();
  await closePools();
});

const sectionOf = (page: string, id: number) => {
  const start = page.indexOf(`id="R${id}"`);
  return page.slice(start, page.indexOf('</section>', start));
};

describe('dates in the application\'s date format', () => {
  test('an interactive grid\'s date cells: text in the format with the date picker; a typed date is saved', async () => {
    const page = (await king.get('/a/hr/27')).body;
    const sel = /href="([^"]*r\d+_sel=30&amp;[^"]*)"/.exec(sectionOf(page, R.Departments))![1].replace(/&amp;/g, '&');
    const staff = sectionOf((await king.get(sel)).body, R.Staff);
    assert.doesNotMatch(staff, /type="date"/);
    const james = (await owner.one(`select empno, to_char(hiredate, 'DD-MM-YYYY') as d from hr.emp where ename = 'JAMES'`));
    assert.match(staff, new RegExp(`name="g${R.Staff}_\\d+_c4"[^>]* value="${james.d}" placeholder="DD-MM-YYYY"[^>]*data-date-mask="DD-MM-YYYY"`));
    assert.match(staff, /data-date-pick="f_g\d+_\d+_c4"/);
    const g = `g${R.Staff}`;
    const form = gridForm(staff, g);
    const row = Object.keys(form).find((k) => k.endsWith('_pk') && form[k] === String(james.empno))!.slice(0, -3);
    assert.equal(form[`${row}_c4`], james.d, 'the helper reads the date field');
    const res = await king.submit('/a/hr/27', { ...form, __request: `GRID_SAVE_${R.Staff}`, [`${row}_c4`]: '05-01-1982' });
    assert.equal(res.statusCode, 303, res.body.slice(0, 300));
    assert.equal((await owner.one(`select hiredate::text as d from hr.emp where ename = 'JAMES'`)).d, '1982-01-05');
    // an unchanged date (as shown) is not an update
    const again = gridForm(sectionOf((await king.get(sel)).body, R.Staff), g);
    const res2 = await king.submit('/a/hr/27', { ...again, __request: `GRID_SAVE_${R.Staff}` });
    assert.equal(res2.statusCode, 303);
    assert.match((await king.get(sel)).body, /No changes|nothing to save|no changes/i);
  });

  test('a faceted search\'s custom date range: typed in the date format, it filters', async () => {
    const r = await owner.one(`select r.id, (r.config->>'report')::int as report from meta.region r join meta.page p on p.id = r.page_id
                                where p.app_id = $1 and p.page_no = 21 and r.type = 'facets'`, [appId]);
    const plain = (await king.get('/a/hr/21')).body;
    assert.match(plain, new RegExp(`name="r${r.report}_rf_hiredate"[^>]* value="" placeholder="DD-MM-YYYY"`));
    const all = Number((await owner.one('select count(*)::int as n from hr.emp')).n);
    const in81 = Number((await owner.one(`select count(*)::int as n from hr.emp where hiredate between '1981-01-01' and '1981-12-31'`)).n);
    assert.ok(in81 > 0 && in81 < all);
    const body = (await king.get(`/a/hr/21?r${r.report}_rg_hiredate=~&r${r.report}_rf_hiredate=01-01-1981&r${r.report}_rt_hiredate=31-12-1981`)).body;
    assert.match(body, new RegExp(`Total row count ${in81}\\b`));
    assert.match(body, new RegExp(`name="r${r.report}_rf_hiredate"[^>]* value="01-01-1981"`), 'shown as typed, in the format');
  });

  test('the task list\'s vacation rule: its days typed in the date format', async () => {
    const b = new Browser(app);
    await b.login('blake');
    const page = (await b.get('/a/hr/14')).body;
    assert.match(page, /name="from" form="tkvac\d+" required[^>]* placeholder="DD-MM-YYYY"/);
    assert.doesNotMatch(page, /type="date"/);
    const day = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);
    const dmy = (iso: string) => iso.split('-').reverse().join('-');
    try {
      const res = await b.post('/a/hr/tasks/vacation', { __csrf: b.lastCsrf, action: 'set', to: 'jones', from: dmy(day(1)), until: dmy(day(2)), next: '/a/hr/14' });
      assert.equal(res.statusCode, 303);
      const rule = await owner.one(`select (ends_at - starts_at) = interval '2 days' as two from meta.task_vacation where app_id = $1 and username = 'blake'`, [appId]);
      assert.equal(rule?.two, true);
    } finally {
      await owner.query(`delete from meta.task_vacation where app_id = $1 and username = 'blake'`, [appId]);
    }
  });
});
