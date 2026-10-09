// Data Reporter (APEX 26.1): business users' own reports on HR page 36
// (examples/hr/hr_39_data_reporter.sql), and the builder's settings.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { checkDef, defFromParams, defParams, reportQuery, sourcesOf, type Col } from '../src/runtime/data-reporter.ts';
import { mergeReporterSettings, type DbObject } from '../src/builder/reporter.ts';
import { replaceApp } from '../src/cli/replace.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let rid: number; // the Data Reporter region on HR page 36
let pageId: number;
const P = () => `dr${rid}_`;

before(async () => {
  app = await buildApp({ logger: false });
  const r = await owner.one(`select r.id, r.page_id from meta.region r join meta.page p on p.id = r.page_id join meta.app a on a.id = p.app_id
                              where a.alias = 'hr' and p.page_no = 36 and r.type = 'data_reporter'`);
  rid = r.id;
  pageId = r.page_id;
});

after(async () => {
  await owner.query(`delete from meta.data_report where region_id = $1 and name <> 'Salary by department'`, [rid]);
  await app.close();
  await closePools();
});

async function as(user: string) {
  const b = new Browser(app);
  await b.login(user);
  return b;
}

/** The page URL with the editor's parameters. */
const url = (params: [string, string][]) => `/a/hr/36?${new URLSearchParams(params.map(([k, v]) => [`${P()}${k}`, v]))}`;
const tbody = (body: string) => /<table class="report report-reflow reporter-table"[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/.exec(body)?.[1] ?? '';
const rowsOf = (body: string) => (tbody(body).match(/<tr>/g) ?? []).length;
const heads = (body: string) => [.../<table class="report report-reflow reporter-table"[\s\S]*?<thead>([\s\S]*?)<\/thead>/.exec(body)![1].matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);

const COLS = new Map<string, Col>([
  ['ename', { name: 'ename', label: 'Name', type: 25 }],
  ['job', { name: 'job', label: 'Job', type: 25 }],
  ['sal', { name: 'sal', label: 'Salary', type: 1700 }],
]);

describe('data reporter definitions', () => {
  test('only offered columns, whitelisted operators and functions, and bounded lists are kept', () => {
    const def = checkDef(
      {
        columns: ['ename', 'username', 'ename', '"x"; drop table hr.emp'],
        filters: [{ column: 'job', op: 'eq', value: 'CLERK' }, { column: 'job', op: 'like', value: 'x' }, { column: 'photo', op: 'eq', value: '1' }, { column: 'sal', op: 'gt', value: '' }, { column: 'sal', op: 'null', value: 'ignored' }],
        group: ['job', 'job', 'secret'],
        aggregates: [{ fn: 'sum', column: 'sal' }, { fn: 'sum', column: 'ename' }, { fn: 'count', column: '' }, { fn: 'avg', column: '' }, { fn: 'pg_sleep', column: 'sal' }, { fn: 'constructor', column: 'sal' }],
        sort: [{ column: 'ename', desc: true }, { column: '#2', desc: true }, { column: '#9' }, { column: 'job' }],
        chart: 'bar',
      },
      'employees',
      COLS,
    );
    assert.deepEqual(def.columns, ['ename']);
    assert.deepEqual(def.filters, [{ column: 'job', op: 'eq', value: 'CLERK' }, { column: 'sal', op: 'null', value: '' }]);
    assert.deepEqual(def.group, ['job']);
    assert.deepEqual(def.aggregates, [{ fn: 'sum', column: 'sal' }, { fn: 'count', column: '' }]);
    // grouped: a plain column sorts only when it is a group column; #n is a total
    assert.deepEqual(def.sort, [{ column: '#2', desc: true }, { column: 'job', desc: false }]);
    assert.equal(def.chart, 'bar');
    assert.equal(checkDef({ chart: 'bar', columns: ['ename'] }, 'x', COLS).chart, null, 'a chart needs a group column');
    assert.equal(checkDef({ chart: 'gantt', group: ['job'] }, 'x', COLS).chart, null, 'report chart kinds only');
    assert.equal(checkDef({ filters: Array.from({ length: 9 }, () => ({ column: 'job', op: 'eq', value: 'x' })) }, 'x', COLS).filters.length, 5);
    assert.equal(checkDef({ filters: [{ column: 'job', op: 'eq', value: 'x'.repeat(500) }] }, 'x', COLS).filters[0].value.length, 200);
  });

  test('parameters round-trip, and the query quotes identifiers and escapes values', () => {
    const def = checkDef({ columns: ['ename', 'sal'], filters: [{ column: 'job', op: 'eq', value: `x' or '1'='1` }], group: [], aggregates: [], sort: [{ column: 'sal', desc: true }], chart: null }, 'employees', COLS);
    const again = checkDef(defFromParams(defParams(def, 'dr7_'), 'dr7_'), 'employees', COLS);
    assert.deepEqual(again, def);
    const src = { id: 'employees', schema: 'hr', table: 'staff"v', columns: [] };
    const q = reportQuery(src, def, COLS, 2, 10);
    assert.equal(q.grouped, false);
    assert.match(q.text, /from "hr"\."staff""v" "__q" where "__q"\."job" = 'x'' or ''1''=''1'/);
    assert.match(q.text, /order by "__q"\."sal" desc nulls last limit 11 offset 10$/);
    const g = reportQuery(src, checkDef({ group: ['job'], aggregates: [{ fn: 'avg', column: 'sal' }], sort: [{ column: '#1', desc: true }] }, 'e', COLS), COLS);
    assert.match(g.text, /^select "__q"\."job", round\(avg\("__q"\."sal"\)::numeric, 2\) from .* group by 1 order by 2 desc nulls last limit 1001$/);
  });

  test('sources from the settings leave out malformed entries and pgkiln\'s own schemas', () => {
    const s = sourcesOf({ config: { sources: [
      { id: 'ok', schema: 'hr', table: 'emp', columns: [{ name: 'ename' }, { nope: 1 }] },
      { id: 'ok', schema: 'hr', table: 'dept', columns: [] },
      { id: 'Bad Id', schema: 'hr', table: 'emp', columns: [] },
      { id: 'meta', schema: 'meta', table: 'account', columns: [{ name: 'username' }] },
      { id: 'pg', schema: 'pg_catalog', table: 'pg_authid', columns: [{ name: 'rolpassword' }] },
      'garbage',
    ] } });
    assert.deepEqual(s.map((x) => x.id), ['ok']);
    assert.deepEqual(s[0].columns, [{ name: 'ename' }]);
  });
});

describe('data reporter region', () => {
  test('the list shows own and shared reports and the sources; a saved report runs grouped with its chart', async () => {
    const king = await as('king');
    const home = (await king.get('/a/hr/36')).body;
    assert.match(home, /Salary by department/);
    assert.match(home, /<option value="employees" selected>Employees<\/option><option value="leave">Leave requests<\/option>/);
    const id = (await owner.one(`select id from meta.data_report where region_id = $1 and name = 'Salary by department'`, [rid])).id;
    const page = (await king.get(`/a/hr/36?${P()}open=${id}`)).body;
    assert.deepEqual(heads(page), ['Department', 'Number of rows', 'Sum: Salary', 'Average: Salary']);
    assert.equal(rowsOf(page), 3, 'one row per department');
    assert.match(tbody(page), /^<tr><td class="" data-label="Department">RESEARCH<\/td>/, 'sorted by the salary sum, descending');
    assert.match(page, /<figure class="chart chart-bar" aria-label="Salary by department">/);
    assert.match(page, /€10,875\.00/, 'the column\'s format mask applies to its totals');
  });

  test('the editor\'s parameters pick columns, filter and sort; columns that are not offered are ignored', async () => {
    const king = await as('king');
    const page = (await king.get(url([['src', 'employees'], ['col', 'ename'], ['col', 'sal'], ['col', 'username'], ['fc', 'job'], ['fo', 'eq'], ['fv', 'CLERK'], ['sc', 'sal'], ['sd', 'desc']]))).body;
    assert.deepEqual(heads(page), ['Name', 'Salary']);
    assert.equal(rowsOf(page), 4);
    assert.match(tbody(page), /^<tr><td class="" data-label="Name">MILLER/);
    assert.doesNotMatch(page, /data-label="Username"/);
    // without columns: all offered columns; a page of 15 rows with a Next link
    const all = (await king.get(url([['src', 'employees']]))).body;
    assert.deepEqual(heads(all), ['No.', 'Name', 'Job', 'Department', 'Location', 'Hire date', 'Salary', 'Commission', 'Active']);
    assert.equal(rowsOf(all), 14);
    // a bad value for the column's type is a message, not a broken page
    const bad = await king.get(url([['src', 'employees'], ['fc', 'sal'], ['fo', 'gt'], ['fv', 'lots']]));
    assert.equal(bad.statusCode, 200);
    assert.match(bad.body, /alert-error/);
  });

  test('totals without a group column are one row over all rows', async () => {
    const king = await as('king');
    const page = (await king.get(url([['src', 'employees'], ['af', 'count'], ['ac', ''], ['af', 'max'], ['ac', 'hiredate']]))).body;
    assert.deepEqual(heads(page), ['Number of rows', 'Maximum: Hire date']);
    assert.equal(rowsOf(page), 1);
    assert.match(tbody(page), />14</);
  });

  test('reports run as the application\'s role: row level security applies to leave requests', async () => {
    const n = async (user: string) => {
      const b = await as(user);
      const body = (await b.get(url([['src', 'leave'], ['af', 'count'], ['ac', '']]))).body;
      return Number(/data-label="Number of rows">(\d+)</.exec(body)![1]);
    };
    const all = (await owner.one('select count(*)::int as n from hr.leave_request')).n;
    const own = (await owner.one(`select count(*)::int as n from hr.leave_request l join hr.emp e on e.empno = l.empno where e.username = 'allen'`)).n;
    assert.equal(await n('king'), all, 'an administrator sees all');
    assert.equal(await n('allen'), own, 'an employee only their own');
  });

  test('a user saves, shares, updates and deletes a report; others see only shared ones and copy them', async () => {
    const king = await as('king');
    await king.get(url([['src', 'employees'], ['g', 'job'], ['af', 'count'], ['ac', '']]));
    const params = defParams(checkDef({ group: ['job'], aggregates: [{ fn: 'count', column: '' }] }, 'employees', new Map([['job', { name: 'job', label: 'Job', type: 25 }]])), P()).toString();
    const res = await king.submit(`/a/hr/36/reporter/${rid}/save`, { params, name: 'Jobs', description: 'Head count per job' });
    assert.equal(res.statusCode, 303);
    const row = await owner.one(`select * from meta.data_report where region_id = $1 and name = 'Jobs'`, [rid]);
    assert.equal(row.username, 'king');
    assert.equal(row.shared, false);
    assert.deepEqual(row.definition.group, ['job']);
    assert.equal(res.headers.location, `/a/hr/36?${P()}open=${row.id}`);
    assert.match((await king.get(String(res.headers.location))).body, /Report &quot;Jobs&quot; saved\.|Report "Jobs" saved\./);

    const blake = await as('blake');
    assert.doesNotMatch((await blake.get('/a/hr/36')).body, />Jobs</, 'private to king');
    assert.match((await blake.get(`/a/hr/36?${P()}open=${row.id}`)).body, /That report is not available\./);

    // shared: blake sees it, may not change or delete it, and saves his own copy
    await king.get(`/a/hr/36?${P()}open=${row.id}`);
    await king.submit(`/a/hr/36/reporter/${rid}/save`, { params, name: 'Jobs', shared: 'true', rep: String(row.id), mode: 'save' });
    assert.equal((await owner.one('select shared from meta.data_report where id = $1', [row.id])).shared, true);
    const other = (await blake.get(`/a/hr/36?${P()}open=${row.id}`)).body;
    assert.match(other, /by king/);
    assert.doesNotMatch(other, /reporter\/\d+\/delete/, 'no delete for others');
    assert.doesNotMatch(other, new RegExp(`name="rep" value="${row.id}"`), 'saving makes a new report');
    await blake.submit(`/a/hr/36/reporter/${rid}/save`, { params, name: 'Taken over', rep: String(row.id) });
    assert.equal((await owner.one('select name from meta.data_report where id = $1', [row.id])).name, 'Jobs', 'not overwritten by blake');
    assert.equal(await owner.one(`select 1 from meta.data_report where region_id = $1 and name = 'Taken over'`, [rid]), undefined);
    await blake.submit(`/a/hr/36/reporter/${rid}/save`, { params, name: 'Jobs (mine)' });
    assert.equal((await owner.one(`select username from meta.data_report where region_id = $1 and name = 'Jobs (mine)'`, [rid])).username, 'blake');
    await blake.submit(`/a/hr/36/reporter/${rid}/delete`, { rep: String(row.id) });
    assert.ok(await owner.one('select 1 from meta.data_report where id = $1', [row.id]), 'blake cannot delete it');

    // save as new, then delete
    await king.get(`/a/hr/36?${P()}open=${row.id}`);
    await king.submit(`/a/hr/36/reporter/${rid}/save`, { params, name: 'Jobs 2', rep: String(row.id), mode: 'new' });
    assert.equal((await owner.one(`select count(*)::int as n from meta.data_report where region_id = $1 and username = 'king' and name like 'Jobs%'`, [rid])).n, 2);
    await king.submit(`/a/hr/36/reporter/${rid}/delete`, { rep: String(row.id) });
    assert.equal(await owner.one('select 1 from meta.data_report where id = $1', [row.id]), undefined);
    // a name is required; the work is not lost
    const noName = await king.submit(`/a/hr/36/reporter/${rid}/save`, { params, name: ' ' });
    assert.match(String(noName.headers.location), new RegExp(`${P()}src=employees`));
  });
});

describe('data reporter settings in the builder', () => {
  const emp: DbObject = { oid: 1, schema: 'hr', table: 'emp', columns: [{ name: 'ename', type: 'text' }, { name: 'sal', type: 'numeric' }, { name: 'photo', type: 'bytea' }] };
  const lookup = {
    byName: async (s: string, t: string) => (s === 'hr' && t === 'emp' ? emp : null),
    byOid: async (oid: number) => (oid === 1 ? emp : oid === 2 ? { ...emp, oid: 2, schema: 'meta', table: 'account' } : null),
  };

  test('a new source offers its columns except binary ones; existing ones keep only real columns', async () => {
    const { config, errors } = await mergeReporterSettings({ other: 1 }, { new_object: '1', new_label: 'Staff', page_size: '50', sharing: 'authz:admin' }, { authz: new Set(['ADMIN']) }, lookup);
    assert.deepEqual(errors, []);
    assert.equal(config.other, 1, 'other keys are kept');
    assert.equal(config.page_size, 50);
    assert.equal(config.share_authz, 'admin');
    assert.deepEqual(config.sources, [{ id: 'emp', label: 'Staff', schema: 'hr', table: 'emp', columns: [{ name: 'ename', label: 'Ename' }, { name: 'sal', label: 'Sal' }] }]);
    const next = await mergeReporterSettings(config, {
      s0_key: 'emp', s0_label: 'People', s0_col_0: 'ename', s0_on_0: 'true', s0_label_0: 'Name', s0_col_1: 'sal', s0_col_2: 'username', s0_on_2: 'true', sharing: 'authz:NOPE',
    }, { authz: new Set(['ADMIN']) }, lookup);
    assert.deepEqual(next.config.sources[0].columns, [{ name: 'ename', label: 'Name' }], 'sal unticked, username is not a column');
    assert.equal(next.config.share_authz, undefined, 'unknown schemes are ignored');
    const removed = await mergeReporterSettings(next.config, { s0_key: 'emp', s0_remove: 'true', sharing: 'off' }, { authz: new Set() }, lookup);
    assert.equal(removed.config.sources, undefined);
    assert.equal(removed.config.sharing, false);
  });

  test('pgapex\'s own tables, unknown objects and bad static ids are refused', async () => {
    for (const new_object of ['2', '99', 'hr.emp'])
      assert.equal((await mergeReporterSettings({}, { new_object }, { authz: new Set() }, lookup)).config.sources, undefined);
    const r = await mergeReporterSettings({}, { new_object: '1', new_id: 'Not valid!' }, { authz: new Set() }, lookup);
    assert.equal(r.config.sources[0].id, 'emp');
    assert.equal(r.errors.length, 1);
  });

  test('the page designer shows the settings and saves them', async () => {
    const dev = new Browser(app);
    await dev.get('/builder/login');
    await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
    const page = (await dev.get(`/builder/pages/${pageId}?c=region-${rid}`)).body;
    assert.match(page, /Data Reporter settings/);
    assert.match(page, /hr\.staff_v/);
    const before = (await owner.one('select config from meta.region where id = $1', [rid])).config;
    try {
      const dept = (await owner.one(`select 'hr.dept'::regclass::oid::int as oid`)).oid;
      const form: Record<string, string> = { new_object: String(dept), new_id: 'departments', sharing: '' };
      sourcesOf({ config: before }).forEach((s, i) => {
        form[`s${i}_key`] = s.id;
        s.columns.forEach((c, j) => Object.assign(form, { [`s${i}_col_${j}`]: c.name, [`s${i}_on_${j}`]: 'true', [`s${i}_label_${j}`]: c.label ?? '', [`s${i}_fmt_${j}`]: c.format ?? '' }));
      });
      assert.equal((await dev.submit(`/builder/pages/${pageId}/region/${rid}/reporter`, form)).statusCode, 303);
      const cfg = (await owner.one('select config from meta.region where id = $1', [rid])).config;
      assert.deepEqual(cfg.sources.map((s: any) => s.id), ['employees', 'leave', 'departments']);
      assert.deepEqual(cfg.sources[0].columns, before.sources[0].columns);
    } finally {
      await owner.query('update meta.region set config = $2 where id = $1', [rid, JSON.stringify(before)]);
    }
  });
});

describe('data reporter export and replace', () => {
  test('the sources travel in the region\'s settings; users\' reports stay with their region on replace', async () => {
    const doc = (await owner.one(`select meta.export_app('hr') as d`)).d;
    const region = doc.pages.find((p: any) => p.page_no === 36).regions.find((r: any) => r.type === 'data_reporter');
    assert.deepEqual(region.config.sources.map((s: any) => s.id), ['employees', 'leave']);
    await owner.query(`delete from meta.app where alias = 'hr_dr_copy'`);
    const id = (await owner.one(`select meta.import_app($1::jsonb, 'hr_dr_copy') as id`, [JSON.stringify(doc)])).id;
    try {
      const regionOf = async () => (await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 36 and r.type = 'data_reporter'`, [id])).id;
      const before = await regionOf();
      await owner.query(`insert into meta.data_report (app_id, region_id, username, name, definition) values ($1, $2, 'king', 'Kept', '{"source": "employees"}')`, [id, before]);
      const c = await owner.pool.connect();
      try {
        await c.query('begin');
        await replaceApp(c, doc, 'hr_dr_copy');
        await c.query('commit');
      } finally {
        c.release();
      }
      const after = await regionOf();
      assert.notEqual(after, before);
      assert.equal((await owner.one(`select region_id from meta.data_report where app_id = $1 and name = 'Kept'`, [id])).region_id, after);
    } finally {
      await owner.query(`delete from meta.app where id = $1`, [id]);
    }
  });
});
