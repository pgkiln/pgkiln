// Sprint 143 (AP-9; APEX 26.2: the interactive report's modern dialogs): Actions → Filter takes several values at
// once ("is one of", "is not one of": a list with counts, or typed with commas), two bounds ("is between", dates in
// the application's date format, the whole last day counted) and relative periods ("is in the last 7 days");
// Actions → Columns puts the columns in another order (drag and drop with JavaScript, arrow buttons without), and the
// order reaches the page, the downloads and the PDF.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { clearLocaleCache } from '../src/runtime/locale.ts';
import { describeFilter, filterOk, listValues, rangeValues } from '../src/runtime/report.ts';
import { english } from '../src/i18n.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
let rid: number;
const alias = 'rdlg-s143';
const ROLE = 'pgkiln_s143_rdlg';
const SCHEMA = 'rdlg143';

before(async () => {
  app = await buildApp({ logger: false });
  await owner.query(`delete from meta.app where alias = $1`, [alias]);
  await owner.query(`drop schema if exists ${SCHEMA} cascade`);
  await owner.query(`drop owned by ${ROLE}`).catch(() => undefined);
  await owner.query(`drop role if exists ${ROLE}`);
  await owner.query(`create role ${ROLE} nologin`);
  await owner.query(`grant ${ROLE} to pgkiln_runtime`);
  // 14 rows: job CLERK / ANALYST / MANAGER (one without a job), hired 2020-01-02 … 2020-01-15, seen g days ago
  await owner.query(`
    create schema ${SCHEMA};
    create table ${SCHEMA}.emp (id int primary key, name text not null, job text, secret text, hired date, seen timestamptz, sal numeric);
    insert into ${SCHEMA}.emp select g, 'E' || g, case when g = 14 then null else (array['CLERK', 'ANALYST', 'MANAGER'])[1 + g % 3] end, 's' || g,
      date '2020-01-01' + g, now() - make_interval(days => g), g * 100 from generate_series(1, 14) g;
    grant usage on schema ${SCHEMA} to ${ROLE};
    grant select on all tables in schema ${SCHEMA} to ${ROLE};
  `);
  appId = (await owner.one(`insert into meta.app (alias, name, authentication, db_role) values ($1, 'Report dialogs', 'none', $2) returning id`, [alias, ROLE])).id;
  const page = (await owner.one(`insert into meta.page (app_id, page_no, name, requires_auth) values ($1, 1, 'Home', false) returning id`, [appId])).id;
  rid = (await owner.one(`insert into meta.region (page_id, seq, title, type, source, config) values ($1, 10, 'Staff', 'report', $2, $3) returning id`,
    [page, `select id, name, job, secret, hired, seen, sal from ${SCHEMA}.emp`, { hidden: ['secret'], page_size: 50 }])).id;
});

after(async () => {
  await owner.query('delete from meta.app where id = $1', [appId]);
  await owner.query(`drop schema if exists ${SCHEMA} cascade`);
  await owner.query(`drop owned by ${ROLE}`);
  await owner.query(`drop role if exists ${ROLE}`);
  await app.close();
  await closePools();
});

const f = (k: string) => `r${rid}_${k}`;
const get = (q: string) => new Browser(app).get(`/a/${alias}/1?${q}`);
const page = (q = '') => get(q).then((r) => r.body);
const ids = (body: string) => [...body.matchAll(/<td class="num" data-label="Id">(\d+)<\/td>/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
const filter = (col: string, op: string, value: string) => `${f('f')}=${encodeURIComponent(`${col}|${op}|${value}`)}`;
/** a dialog's GET form, as the browser sends it: the redirect's target */
async function submit(q: string) {
  const res = await get(q);
  assert.equal(res.statusCode, 302, q);
  return new URL(String(res.headers.location), 'http://x').searchParams;
}

describe('values of a filter', () => {
  test('a list: JSON from the dialog, or text with commas; duplicates and empty values left out', () => {
    assert.deepEqual(listValues('["CLERK","ANALYST, SENIOR"]'), ['CLERK', 'ANALYST, SENIOR']);
    assert.deepEqual(listValues('CLERK, ANALYST,,CLERK'), ['CLERK', 'ANALYST']);
    assert.deepEqual(listValues('[1, 2, {"x": 1}]'), ['1', '2']);
    assert.deepEqual(listValues('[broken'), ['[broken']);
    assert.equal(listValues(JSON.stringify(Array.from({ length: 300 }, (_, i) => `v${i}`))).length, 100);
    assert.deepEqual(rangeValues('["2020-01-01",""]'), ['2020-01-01', '']);
    assert.deepEqual(rangeValues('10, 20'), ['10', '20']);
    assert.equal(filterOk('in', '[]'), false);
    assert.equal(filterOk('between', '["",""]'), false);
    assert.equal(filterOk('period', 'last_7_days'), true);
    assert.equal(filterOk('period', 'today; drop table x'), false);
    assert.equal(filterOk('period', '__proto__'), false);
    assert.equal(filterOk('nope', 'x'), false);
  });

  test('in words: the chip, the PDF and Ask say the same', () => {
    assert.equal(describeFilter(english, 'Job', 'in', '["CLERK","ANALYST"]'), 'Job is one of CLERK, ANALYST');
    assert.equal(describeFilter(english, 'Job', 'not_in', 'CLERK'), 'Job is not one of CLERK');
    assert.equal(describeFilter(english, 'Hired', 'between', '["2020-01-03","2020-01-05"]'), 'Hired is between 2020-01-03 and 2020-01-05');
    assert.equal(describeFilter(english, 'Hired', 'between', '["2020-01-03",""]'), 'Hired ≥ 2020-01-03');
    assert.equal(describeFilter(english, 'Seen', 'period', 'last_7_days'), 'Seen is in the last 7 days');
  });
});

describe('Actions → Filter', () => {
  test('the dialog: a column with its kind, every operator, a second value, a period and a place for the list', async () => {
    const body = await page();
    const dlg = /<div class="filter-row filter-dialog" data-filter-dialog[\s\S]*?<\/div>\s*<\/div>/.exec(body)?.[0] ?? '';
    assert.match(dlg, new RegExp(`data-values="/a/${alias}/1/report/${rid}/values" data-list="${f('fl')}"`));
    assert.match(dlg, /<option value="hired" data-kind="date">/);
    assert.match(dlg, /<option value="sal" data-kind="number">/);
    assert.match(dlg, /<option value="job" data-kind="text">/);
    assert.doesNotMatch(dlg, /value="secret"/, 'a hidden column is not offered');
    for (const [op, kind] of [['in', 'list'], ['not_in', 'list'], ['between', 'range'], ['period', 'period'], ['null', 'none'], ['eq', 'one']])
      assert.match(dlg, new RegExp(`<option value="${op}" data-op-kind="${kind}"`), op);
    assert.match(dlg, new RegExp(`name="${f('fv2')}"`));
    assert.match(dlg, new RegExp(`<select class="filter-field" name="${f('fpr')}"[\\s\\S]*?<option value="last_7_days">the last 7 days</option>`));
    assert.match(dlg, /data-mask-off="YYYY-MM-DD"/);
  });

  test('is one of: ticked values and typed ones; rows with one of them; a chip in words', async () => {
    const p = await submit(`${f('fc')}=job&${f('fo')}=in&${f('fl')}=CLERK&${f('fl')}=ANALYST&${f('fv')}=`);
    assert.deepEqual(p.getAll(f('f')), ['job|in|["CLERK","ANALYST"]']);
    for (const k of ['fc', 'fo', 'fv', 'fl', 'fv2', 'fpr']) assert.equal(p.get(f(k)), null, k);
    const body = await page(p.toString());
    // g % 3: 0 → CLERK (3, 6, 9, 12), 1 → ANALYST (1, 4, 7, 10, 13); 14 has no job
    assert.deepEqual(ids(body), [1, 3, 4, 6, 7, 9, 10, 12, 13]);
    assert.match(body, /<span class="chip">Job is one of CLERK, ANALYST/);
    const typed = await submit(`${f('fc')}=job&${f('fo')}=in&${f('fv')}=${encodeURIComponent('MANAGER, CLERK')}`);
    assert.deepEqual(typed.getAll(f('f')), ['job|in|["MANAGER","CLERK"]']);
    assert.equal(ids(await page(typed.toString())).length, 8);
    // a value holding a comma stays one value when ticked
    assert.deepEqual((await submit(`${f('fc')}=name&${f('fo')}=in&${f('fl')}=${encodeURIComponent('E1, E2')}`)).getAll(f('f')), ['name|in|["E1, E2"]']);
    // nothing chosen: no filter
    assert.deepEqual((await submit(`${f('fc')}=job&${f('fo')}=in&${f('fv')}=`)).getAll(f('f')), []);
  });

  test('is not one of keeps the rows without a value; a list on a number or date column', async () => {
    assert.deepEqual(ids(await page(filter('job', 'not_in', '["CLERK","ANALYST"]'))), [2, 5, 8, 11, 14]);
    assert.deepEqual(ids(await page(filter('sal', 'in', '["100","300"]'))), [1, 3]);
    assert.deepEqual(ids(await page(filter('hired', 'in', '["2020-01-02","2020-01-04"]'))), [1, 3]);
  });

  test('is between: both bounds included, the whole last day of a timestamp; an open bound', async () => {
    const p = await submit(`${f('fc')}=hired&${f('fo')}=between&${f('fv')}=2020-01-03&${f('fv2')}=2020-01-05`);
    assert.deepEqual(p.getAll(f('f')), ['hired|between|["2020-01-03","2020-01-05"]']);
    const body = await page(p.toString());
    assert.deepEqual(ids(body), [2, 3, 4]);
    assert.match(body, /<span class="chip">Hired is between 2020-01-03 and 2020-01-05/);
    assert.deepEqual(ids(await page(filter('sal', 'between', '["", "300"]'))), [1, 2, 3]);
    assert.deepEqual(ids(await page(filter('sal', 'between', '["1200", ""]'))), [12, 13, 14]);
    // a timestamp column: "to yesterday" takes the whole of yesterday (the row seen 1 day ago), not today's rows
    const d = (await owner.one(`select (current_date - 2)::text as a, (current_date - 1)::text as b`)) as { a: string; b: string };
    assert.deepEqual(ids(await page(filter('seen', 'between', JSON.stringify([d.a, d.b])))), [1, 2]);
    assert.deepEqual((await submit(`${f('fc')}=hired&${f('fo')}=between&${f('fv')}=&${f('fv2')}=`)).getAll(f('f')), [], 'no bounds: no filter');
  });

  test("is between in the application's date format", async () => {
    await owner.query(`update meta.app set date_format = 'DD.MM.YYYY' where id = $1`, [appId]);
    clearLocaleCache();
    try {
      assert.match(await page(), /data-mask-off="DD.MM.YYYY"/);
      assert.deepEqual(ids(await page(filter('hired', 'between', '["03.01.2020","05.01.2020"]'))), [2, 3, 4]);
      assert.deepEqual(ids(await page(filter('hired', 'in', '["04.01.2020"]'))), [3]);
    } finally {
      await owner.query(`update meta.app set date_format = null where id = $1`, [appId]);
      clearLocaleCache();
    }
  });

  test('is in a period: rolling with the date; an unknown period is no filter', async () => {
    const p = await submit(`${f('fc')}=seen&${f('fo')}=period&${f('fpr')}=last_7_days`);
    assert.deepEqual(p.getAll(f('f')), ['seen|period|last_7_days']);
    const body = await page(p.toString());
    // seen g days ago: the last 7 days are today and the six before it
    assert.deepEqual(ids(body), [1, 2, 3, 4, 5, 6]);
    assert.match(body, /<span class="chip">Seen is in the last 7 days/);
    assert.deepEqual(ids(await page(filter('seen', 'period', 'yesterday'))), [1]);
    assert.equal(ids(await page(filter('hired', 'period', 'this_year'))).length, 0);
    assert.equal(ids(await page(filter('seen', 'period', 'someday'))).length, 14, 'an unknown period is left out');
  });

  test('a highlight offers the one-value operators only', async () => {
    const body = await page();
    const hl = new RegExp(`<select name="${f('ho')}"[^>]*>([\\s\\S]*?)</select>`).exec(body)![1];
    assert.match(hl, /value="eq"/);
    assert.doesNotMatch(hl, /value="(in|not_in|between|period)"/);
    assert.equal(ids(await page(`${f('h')}=${encodeURIComponent('job|in|yellow|CLERK')}`)).length, 14);
  });
});

describe('Actions → Columns', () => {
  const headings = (body: string) => [...body.matchAll(/<th scope="col"[^>]*data-col="([^"]+)"/g)].map((m) => m[1]);

  test('the dialog lists the columns in order with arrows; the first cannot go up, the last not down', async () => {
    const body = await page();
    const list = /<ol class="ir-col-order" data-col-order>([\s\S]*?)<\/ol>/.exec(body)![1];
    assert.deepEqual([...list.matchAll(/data-col-name="([^"]+)"/g)].map((m) => m[1]), ['id', 'name', 'job', 'hired', 'seen', 'sal']);
    assert.match(body, new RegExp(`name="${f('od')}" value="\\[&quot;id&quot;,&quot;name&quot;,&quot;job&quot;,&quot;hired&quot;,&quot;seen&quot;,&quot;sal&quot;\\]"`));
    assert.match(list, new RegExp(`name="${f('mv')}" value="uid"[^>]*disabled`));
    assert.match(list, new RegExp(`name="${f('mv')}" value="dsal"[^>]*disabled`));
    assert.doesNotMatch(list, /secret/);
  });

  test('a move without JavaScript, the new order on the page, a chip back to the report order', async () => {
    const order = ['id', 'name', 'job', 'hired', 'seen', 'sal'].map((c) => `${f('o')}=${c}`).join('&');
    const od = `${f('od')}=${encodeURIComponent(JSON.stringify(['id', 'name', 'job', 'hired', 'seen', 'sal']))}`;
    const p = await submit(`${order}&${od}&${f('mv')}=usal`);
    assert.deepEqual(p.getAll(f('o')), ['id', 'name', 'job', 'hired', 'sal', 'seen']);
    const p2 = await submit(`${p.getAll(f('o')).map((c) => `${f('o')}=${c}`).join('&')}&${od}&${f('mv')}=uhired&${f('x')}=job`);
    assert.deepEqual(p2.getAll(f('o')), ['id', 'name', 'hired', 'job', 'sal', 'seen']);
    assert.deepEqual(p2.getAll(f('x')), ['job'], 'the hidden columns go along');
    const body = await page(p2.toString());
    assert.deepEqual(headings(body), ['id', 'name', 'hired', 'sal', 'seen']);
    assert.match(body, /<span class="chip">Own column order/);
    // the dialog shows the new order
    const list = /<ol class="ir-col-order" data-col-order>([\s\S]*?)<\/ol>/.exec(body)![1];
    assert.deepEqual([...list.matchAll(/data-col-name="([^"]+)"/g)].map((m) => m[1]), ['id', 'name', 'hired', 'job', 'sal', 'seen']);
    // back in the default order: no parameter
    const back = await submit(`${order}&${od}`);
    assert.deepEqual(back.getAll(f('o')), []);
    // a dragged order (as the list sends it) and an unknown name
    const dragged = await submit(`${['sal', 'id', 'nope', 'name', 'job', 'hired', 'seen'].map((c) => `${f('o')}=${c}`).join('&')}&${od}`);
    assert.deepEqual(headings(await page(dragged.toString())), ['sal', 'id', 'name', 'job', 'hired', 'seen']);
  });

  test('the download follows the order and leaves out the hidden columns', async () => {
    const res = await get(`${f('o')}=sal&${f('o')}=name&${f('x')}=hired&${f('csv')}=1`);
    assert.equal(res.statusCode, 200);
    const head = res.body.replace(/^﻿/, '').split('\r\n')[0];
    assert.equal(head, 'Sal,Name,Id,Job,Seen');
  });
});
