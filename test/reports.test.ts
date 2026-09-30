// Interactive report power features: control break, aggregates, highlights
// and saved reports.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner, runtime } from '../src/db.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let rid: number; // the Employees report on HR page 2

before(async () => {
  app = await buildApp({ logger: false });
  rid = (await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 2 and r.type = 'report'`)).id;
});

after(async () => {
  await owner.query(`delete from meta.saved_report where region_id = $1`, [rid]);
  await owner.query(`update meta.region set config = config - 'public_reports' - 'saved_reports' where id = $1`, [rid]);
  await app.close();
  await closePools();
});

async function as(user: string) {
  const b = new Browser(app);
  await b.login(user);
  return b;
}

const url = (params: [string, string][]) => `/a/hr/2?${new URLSearchParams(params.map(([k, v]) => [`r${rid}_${k}`, v]))}`;
const count = (body: string, re: RegExp) => (body.match(re) ?? []).length;
const tbody = (body: string) => /<tbody>([\s\S]*?)<\/tbody>/.exec(body)?.[1] ?? '';

describe('control break and aggregates', () => {
  test('rows are grouped by the break column, with subtotals and a total', async () => {
    const b = await as('king');
    const body = (await b.get(url([['b', 'job'], ['a', 'sum|sal'], ['a', 'count|empno']]))).body;
    assert.equal(count(tbody(body), /class="break-row"/g), 5, 'one group per job');
    assert.match(body, /Job: ANALYST/);
    assert.match(body, /Subtotal · Count: 2[^<]*<\/td>|Subtotal[\s\S]{0,400}Sum: 6000/, 'analysts subtotal');
    assert.match(body, /<tfoot>[\s\S]*Total[\s\S]*Sum: 29025[\s\S]*<\/tfoot>/, 'grand total of all rows');
    // the break column is not repeated as a column
    assert.doesNotMatch(/<thead>[\s\S]*?<\/thead>/.exec(body)![0], />Job</);
    // groups come in order: ANALYST before CLERK before MANAGER
    const order = [...body.matchAll(/Job: ([A-Z]+)/g)].map((m) => m[1]);
    assert.deepEqual(order, [...order].sort());
  });

  test('aggregates cover the filtered rows only', async () => {
    const body = (await (await as('king')).get(url([['f', 'job|eq|ANALYST'], ['a', 'sum|sal'], ['a', 'avg|sal'], ['a', 'max|ename']]))).body;
    assert.match(body, /<tfoot>[\s\S]*Sum: 6000[\s\S]*<\/tfoot>/);
    assert.match(body, /Average: 3000/);
    assert.match(body, /Maximum: SCOTT/);
  });

  test('the Actions menu offers break, aggregate and highlight; the form fields normalise', async () => {
    const b = await as('king');
    const page = (await b.get('/a/hr/2')).body;
    for (const n of ['bc', 'af', 'ac', 'hc', 'ho', 'hv', 'hk']) assert.match(page, new RegExp(`name="r${rid}_${n}"`), n);
    const res = await b.get(url([['af', 'sum'], ['ac', 'sal']]));
    assert.equal(res.statusCode, 302);
    assert.match(String(res.headers.location), new RegExp(`r${rid}_a=sum%7Csal`));
    const hl = await b.get(url([['hc', 'sal'], ['ho', 'gt'], ['hv', '2900'], ['hk', 'yellow']]));
    assert.match(String(hl.headers.location), new RegExp(`r${rid}_h=sal%7Cgt%7Cyellow%7C2900`));
  });
});

describe('highlights', () => {
  test('matching rows get the color class; the condition runs in SQL', async () => {
    const body = (await (await as('king')).get(url([['h', 'sal|gt|red|2900'], ['h', 'job|eq|yellow|CLERK']]))).body;
    const high = (await owner.one(`select count(*)::int as n from hr.emp where sal > 2900`)).n;
    assert.equal(count(tbody(body), /<tr class="hl-red">/g), high);
    assert.equal(count(tbody(body), /<tr class="hl-yellow">/g), 4, 'clerks');
    assert.match(body, /class="swatch hl-red"/, 'a chip per highlight');
  });
});

describe('input handling', () => {
  test('unknown columns, functions and colors are ignored; values stay literals', async () => {
    const b = await as('king');
    for (const params of [
      [['b', 'no_such_col']],
      [['a', 'sum|no_such_col'], ['a', 'drop|sal'], ['a', 'sum|ename']],
      [['h', `ename|eq|red|x' or '1'='1`], ['h', 'sal|gt|url(javascript:alert(1))|1'], ['h', 'sal"; drop table hr.emp; --|eq|red|1']],
      [['b', 'job"; drop table hr.emp; --'], ['a', 'sum|sal"--']],
    ] as [string, string][][]) {
      const res = await b.get(url(params));
      assert.equal(res.statusCode, 200, JSON.stringify(params));
      assert.doesNotMatch(res.body, /alert-error/, JSON.stringify(params));
      assert.doesNotMatch(res.body, /class="(swatch )?hl-(?!(yellow|green|red|blue|gray)")/, 'only known colors become classes');
      assert.doesNotMatch(res.body.replace(/ value="[^"]*"/g, ''), /javascript:alert/i, 'only as an escaped form value');
    }
    assert.equal((await owner.one(`select count(*)::int as n from hr.emp`)).n, 14);
    const body = (await b.get(url([['h', `ename|eq|red|x' or '1'='1`]]))).body;
    assert.equal(count(tbody(body), /hl-red/g), 0, 'the quote is part of the value');
  });
});

describe('saved reports', () => {
  test('a user saves a report, applies it and deletes it; others do not see it', async () => {
    const king = await as('king');
    await king.get('/a/hr/2');
    const saved = await king.submit(`/a/hr/2/report/${rid}/save`, {
      name: 'Analysts',
      params: new URLSearchParams([[`r${rid}_f`, 'job|eq|ANALYST'], [`r${rid}_a`, 'sum|sal'], ['P3_EMPNO', '7839'], ['r999_q', 'x'], [`r${rid}_p`, '3']]).toString(),
      public: 'true',
    });
    assert.equal(saved.statusCode, 303);
    assert.match(String(saved.headers.location), new RegExp(`r${rid}_f=job`));
    const row = await owner.one(`select * from meta.saved_report where region_id = $1 and name = 'Analysts'`, [rid]);
    assert.equal(row.username, 'king');
    assert.equal(row.public, false, 'public needs the region\'s public_reports scheme');
    assert.equal(row.params, `r${rid}_f=job%7Ceq%7CANALYST&r${rid}_a=sum%7Csal`, 'only the report\'s own state (no items, other regions or page number)');
    const page = (await king.get('/a/hr/2')).body;
    assert.match(page, /Report &quot;Analysts&quot; saved\.|Report "Analysts" saved\./);
    assert.match(page, new RegExp(`<a href="[^"]*r${rid}_f=job%7Ceq%7CANALYST[^"]*">Analysts</a>`));

    const blake = await as('blake');
    const other = (await blake.get('/a/hr/2')).body;
    assert.doesNotMatch(other, />Analysts</, 'private to king');
    // blake cannot delete it
    await blake.submit(`/a/hr/2/report/${rid}/saved/${row.id}/delete`, { params: '' });
    assert.ok(await owner.one('select 1 from meta.saved_report where id = $1', [row.id]));
    // king can
    await king.get('/a/hr/2');
    await king.submit(`/a/hr/2/report/${rid}/saved/${row.id}/delete`, { params: '' });
    assert.equal(await owner.one('select 1 from meta.saved_report where id = $1', [row.id]), undefined);
  });

  test('public reports need the authorization scheme named by the region', async () => {
    await owner.query(`update meta.region set config = config || '{"public_reports": "ADMIN"}' where id = $1`, [rid]);
    try {
      const king = await as('king');
      const page = (await king.get('/a/hr/2')).body;
      assert.match(page, /name="public"/, 'admins may publish');
      await king.submit(`/a/hr/2/report/${rid}/save`, { name: 'High earners', public: 'true', params: `r${rid}_h=sal%7Cgt%7Cgreen%7C2900` });
      assert.equal((await owner.one(`select public from meta.saved_report where region_id = $1 and name = 'High earners'`, [rid])).public, true);
      const blake = await as('blake');
      const other = (await blake.get('/a/hr/2')).body;
      assert.match(other, />High earners</, 'everyone sees public reports');
      assert.doesNotMatch(other, /name="public"/, 'but only admins may publish');
      assert.doesNotMatch(other, /aria-label="Delete High earners"/, 'and only the owner may delete');
      await blake.submit(`/a/hr/2/report/${rid}/save`, { name: 'Mine', public: 'true', params: '' });
      assert.equal((await owner.one(`select public from meta.saved_report where region_id = $1 and name = 'Mine'`, [rid])).public, false);
    } finally {
      await owner.query(`delete from meta.saved_report where region_id = $1`, [rid]);
    }
  });

  test('saving needs the CSRF token, a signed-in user and a visible report', async () => {
    const king = await as('king');
    await king.get('/a/hr/2');
    assert.equal((await king.post(`/a/hr/2/report/${rid}/save`, { __csrf: 'forged', name: 'x', params: '' })).statusCode, 403);
    assert.equal((await king.submit(`/a/hr/2/report/999999/save`, { name: 'x', params: '' })).statusCode, 403, 'unknown region');
    const anon = new Browser(app);
    const res = await anon.post(`/a/hr/2/report/${rid}/save`, { __csrf: '', name: 'x', params: '' });
    assert.ok([302, 303, 403].includes(res.statusCode));
    await owner.query(`update meta.region set config = config || '{"saved_reports": false}' where id = $1`, [rid]);
    try {
      await king.get('/a/hr/2');
      assert.equal((await king.submit(`/a/hr/2/report/${rid}/save`, { name: 'x', params: '' })).statusCode, 403, 'switched off');
    } finally {
      await owner.query(`update meta.region set config = config - 'saved_reports' where id = $1`, [rid]);
    }
    assert.equal((await owner.one(`select count(*)::int as n from meta.saved_report where region_id = $1`, [rid])).n, 0);
  });

  test('applications reach saved reports only through the view and functions', async () => {
    await assert.rejects(runtime.query('select * from meta.saved_report'), /permission denied/);
    await assert.rejects(runtime.query(`insert into meta.saved_report (app_id, region_id, username, name, params) values (1, ${rid}, 'x', 'x', '')`), /permission denied/);
    // without an application context the view is empty and saving is refused
    assert.equal((await runtime.query('select * from meta.saved_reports')).rowCount, 0);
    await assert.rejects(runtime.query(`select meta.save_report(${rid}, 'x', '')`), /sign in|unknown report/);
  });
});
