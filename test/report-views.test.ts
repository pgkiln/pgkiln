// Interactive report views and extras: computed columns, group by, pivot,
// chart view and row selection.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { ComputeError, computeSql } from '../src/runtime/compute.ts';
import { normaliseReportParams } from '../src/runtime/report.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let rid: number; // the Employees report on HR page 2
let pageId: number;
let config: any;

before(async () => {
  app = await buildApp({ logger: false });
  const r = await owner.one(`select r.id, r.page_id, r.config from meta.region r join meta.page p on p.id = r.page_id join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 2 and r.type = 'report'`);
  ({ id: rid, page_id: pageId, config } = r);
});

after(async () => {
  await owner.query('update meta.region set config = $2 where id = $1', [rid, JSON.stringify(config)]);
  await owner.query(`delete from meta.item where page_id = $1 and name = 'P2_SELECTED'`, [pageId]);
  await app.close();
  await closePools();
});

async function as(user: string) {
  const b = new Browser(app);
  await b.login(user);
  return b;
}
const url = (params: [string, string][]) => `/a/hr/2?${new URLSearchParams(params.map(([k, v]) => [`r${rid}_${k}`, v]))}`;
const tbody = (body: string) => /<tbody>([\s\S]*?)<\/tbody>/.exec(body)?.[1] ?? '';
const COLS = ['empno', 'ename', 'job', 'sal', 'comm', 'Total pay'];

describe('computed column expressions', () => {
  test('columns, operators, literals and functions become safe SQL', () => {
    assert.equal(computeSql('sal * 12', COLS), '("__s"."sal" * 12)');
    assert.equal(computeSql('SAL / 0', COLS), '(("__s"."sal")::numeric / nullif((0)::numeric, 0))');
    assert.equal(computeSql(`upper(ename) || ' (' || job || ')'`, COLS), `(((upper(("__s"."ename")::text))::text || (' ('::text)::text)::text || ("__s"."job")::text)::text || (')'::text)::text`);
    assert.equal(computeSql('round(sal * 1.1, 2)', COLS), 'round((("__s"."sal" * 1.1::numeric))::numeric, (2)::int)');
    assert.equal(computeSql('"Total pay" - coalesce(comm, 0)', COLS), '("__s"."Total pay" - coalesce("__s"."comm", 0))');
    assert.equal(computeSql(`'it''s'`, COLS), `'it''s'::text`);
    assert.equal(computeSql('-sal + null', COLS), '((-"__s"."sal") + null)');
  });

  test('anything else is refused', () => {
    for (const expr of [
      'sal; drop table hr.emp', 'pg_sleep(10)', 'sal from hr.emp', '(select 1)', 'secret', '"SAL"', 'sal::text', 'sal = 1',
      `current_setting('x')`, 'round(sal, 1, 2)', 'upper()', 'sal +', '(sal', `'open`, '"open', 'sal $1', '__total', '', 'x'.repeat(501),
      '('.repeat(40) + 'sal' + ')'.repeat(40),
    ])
      assert.throws(() => computeSql(expr, [...COLS, '__total']), ComputeError, expr);
  });
});

describe('form parameters', () => {
  const norm = (q: string) => normaliseReportParams(new URLSearchParams(q));
  test('compute: a new expression under the same name replaces the old one', () => {
    assert.equal(norm('r1_c=Year|sal*12&r1_cn=Year&r1_ce=sal*13'), new URLSearchParams([['r1_c', 'Year|sal*13']]).toString());
    assert.equal(norm('r1_cn=__x&r1_ce=sal'), '');
    assert.equal(norm('r1_cn=a|b&r1_ce=sal'), '', 'no "|" in names');
  });
  test('group by, pivot and chart select their view', () => {
    assert.equal(norm('r1_gb1=job&r1_gb2=&r1_gb3=job&r1_gbf=sum&r1_gbc=sal&r1_p=3'), 'r1_g=job&r1_ga=sum%7Csal&r1_v=group');
    assert.equal(norm('r1_g=job&r1_ga=sum%7Csal&r1_v=group&r1_gb1=&r1_gb2=&r1_gb3=&r1_gbf=&r1_gbc=sal'), '', 'no columns clears the group by');
    assert.equal(norm('r1_pr=job&r1_pp=department&r1_pf=sum&r1_pc=sal'), 'r1_pv=job%7Cdepartment%7Csum%7Csal&r1_v=pivot');
    assert.equal(norm('r1_pr=job&r1_pp=job&r1_pf=sum&r1_pc=sal'), '', 'rows and columns differ');
    assert.equal(norm('r1_ck=donut&r1_cl=job&r1_cf=count&r1_cv=empno'), 'r1_ch=donut%7Cjob%7Ccount%7Cempno&r1_v=chart');
    assert.equal(norm('r1_ck=pie3d&r1_cl=job&r1_cf=count&r1_cv=empno'), '');
    assert.equal(norm('r1_ck=pie&r1_cl=job&r1_cf=count&r1_cv=empno'), 'r1_ch=pie%7Cjob%7Ccount%7Cempno&r1_v=chart');
    for (const kind of ['stacked', 'combo', 'scatter']) assert.equal(norm(`r1_ck=${kind}&r1_cl=job&r1_cf=count&r1_cv=empno`), '', `${kind} needs several series or a numeric x`);
  });
});

describe('report views', () => {
  test('computed columns show, sort, filter and aggregate like real ones', async () => {
    const b = await as('king');
    const body = (await b.get(url([['c', 'Year pay|sal * 12'], ['f', 'Year pay|gt|30000'], ['a', 'sum|Year pay'], ['s', '8'], ['d', 'desc']]))).body;
    assert.match(body, /<th[^>]*>.*Year pay/i);
    const rows = tbody(body);
    assert.match(rows, /60000/, 'KING 5000 * 12');
    assert.doesNotMatch(rows, /SMITH/, 'filtered on the computed column');
    assert.match(body, /<tfoot>[\s\S]*Sum: [\d,.]+[\s\S]*<\/tfoot>/);
    assert.ok(rows.indexOf('KING') > 0 && rows.indexOf('KING') < rows.indexOf('JONES'), 'sorted on it, descending');
    assert.match(body, /class="chip">Year pay = <b>sal \* 12<\/b>/);
  });

  test('a broken computation is reported and left out; the report still works', async () => {
    const body = (await (await as('king')).get(url([['c', 'Bad|pg_sleep(5)'], ['c', 'Year pay|sal*12']]))).body;
    assert.match(body, /Computed column Bad: Unknown function pg_sleep/);
    assert.match(body, /chip chip-error/);
    assert.match(tbody(body), /60000/);
  });

  test('group by: groups, row counts and functions over the filtered rows', async () => {
    const b = await as('king');
    const body = (await b.get(url([['g', 'job'], ['ga', 'sum|sal'], ['ga', 'sum|ename'], ['v', 'group'], ['f', 'sal|ge|1000']]))).body;
    assert.match(body, /class="seg view-switch"/);
    assert.match(body, /aria-current="true">Group by</);
    const head = /<thead>([\s\S]*?)<\/thead>/.exec(body)![1];
    assert.match(head, /Rows/);
    assert.match(head, /Sum: Salary/);
    assert.doesNotMatch(head, /Sum: Name/, 'sum of a text column is left out');
    assert.match(tbody(body), /ANALYST<\/td><td class="num"[^>]*>2<\/td><td class="num"[^>]*>6,?000/);
    assert.doesNotMatch(tbody(body), /SMITH/, 'no detail rows');
    // the Report view is one click away and keeps the settings
    assert.match(body, new RegExp(`href="/a/hr/2\\?[^"]*r${rid}_g=job[^"]*">Report<`));
  });

  test('pivot: one column per value, a total, values escaped as literals', async () => {
    const b = await as('king');
    const body = (await b.get(url([['pv', 'department|job|sum|sal'], ['v', 'pivot']]))).body;
    const head = /<thead>([\s\S]*?)<\/thead>/.exec(body)![1];
    for (const job of ['ANALYST', 'CLERK', 'MANAGER', 'PRESIDENT', 'SALESMAN', 'Total']) assert.match(head, new RegExp(`>${job}<`));
    assert.match(tbody(body), /<th scope="row">ACCOUNTING<\/th>/);
    assert.match(tbody(body), /<th scope="row">RESEARCH<\/th>(<td[^>]*>[^<]*<\/td>){5}<td class="num">10,?875/);
    // a column that isn't in the query, or sum over text, shows a hint instead
    const bad = (await b.get(url([['pv', 'department|nope|sum|sal'], ['v', 'pivot']]))).body;
    assert.match(bad, /Choose the columns for this view/);
  });

  test('chart view: one bar per label, with its data table', async () => {
    const body = (await (await as('king')).get(url([['ch', 'bar|job|count|empno'], ['v', 'chart']]))).body;
    assert.match(body, /class="chart-bar/);
    assert.match(body, /data-tip="CLERK: 4"/);
    assert.match(body, /<summary>Data table<\/summary>/);
  });

  test('views see only the rows the user may see (RLS applies)', async () => {
    const all = tbody((await (await as('king')).get(url([['g', 'job'], ['v', 'group']]))).body);
    const own = tbody((await (await as('allen')).get(url([['g', 'job'], ['v', 'group']]))).body);
    assert.doesNotMatch(own, /alert-error/);
    const rows = (s: string) => [...s.matchAll(/<td class="num"[^>]*>(\d+)<\/td>/g)].reduce((n, m) => n + Number(m[1]), 0);
    assert.ok(rows(own) <= rows(all));
  });
});

describe('row selection', () => {
  before(async () => {
    await owner.query(`insert into meta.item (page_id, name, type) values ($1, 'P2_SELECTED', 'hidden')`, [pageId]);
    await owner.query('update meta.region set config = config || $2 where id = $1', [rid, JSON.stringify({ selection: { column: 'empno', item: 'p2_selected' } })]);
  });

  test('checkboxes per row; the checked values reach the item, colon separated', async () => {
    const b = await as('king');
    const page = (await b.get('/a/hr/2')).body;
    assert.match(page, /data-select-all="P2_SELECTED"/);
    assert.match(page, /<input type="checkbox" name="P2_SELECTED" value="7839" aria-label="Select row 7839">/);
    const res = await b.submit('/a/hr/2', { P2_SELECTED: ['7839', '7902'] });
    assert.equal(res.statusCode, 303);
    const again = (await b.get('/a/hr/2')).body;
    assert.match(again, /value="7839" checked/);
    assert.match(again, /value="7902" checked/);
    assert.doesNotMatch(again, /value="7369" checked/);
  });

  test('no selection column without a valid item; hidden items stay closed otherwise', async () => {
    await owner.query('update meta.region set config = config || $2 where id = $1', [rid, JSON.stringify({ selection: { column: 'empno', item: 'P2_NOPE' } })]);
    const page = (await (await as('king')).get('/a/hr/2')).body;
    assert.doesNotMatch(page, /data-select-all/);
  });
});
