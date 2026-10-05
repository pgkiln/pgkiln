// Interactive grid (sprint 31): aggregates over the whole result, frozen
// columns, per-user column layouts and saved grid reports, master-detail,
// row actions. HR example page 27 (examples/hr/hr_28_grid.sql): a master grid
// of departments, a detail grid of their staff and a detail report.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { arrange, cleanLayout, parseLayout } from '../src/runtime/grid-layout.ts';
import { layoutFromForm } from '../src/runtime/grid.ts';
import { aggregatesText, mergeGridSettings, parseAggregates } from '../src/builder/region-settings.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let king: Browser;
let pageId: number;
const R: Record<string, number> = {};

before(async () => {
  app = await buildApp({ logger: false });
  king = new Browser(app);
  await king.login('king');
  pageId = (await owner.one(`select p.id from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 27`)).id;
  for (const r of (await owner.query('select id, title from meta.region where page_id = $1', [pageId])).rows) R[r.title] = r.id;
  await owner.query(`delete from meta.saved_report where region_id = any($1)`, [Object.values(R)]);
});

after(async () => {
  await owner.query(`delete from meta.saved_report where region_id = any($1)`, [Object.values(R)]);
  await app.close();
  await closePools();
});

const sectionOf = (page: string, id: number) => {
  const start = page.indexOf(`id="R${id}"`);
  return page.slice(start, page.indexOf('</section>', start));
};
const unescape = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"');
/** The select link of the master row with this value. */
const selectLink = (page: string, value: string) => {
  const m = new RegExp(`href="([^"]*r${R.Departments}_sel=${value}&amp;[^"]*)"`).exec(page);
  assert.ok(m, `select link for ${value}`);
  return unescape(m[1]);
};
/** The posted fields of a grid as a browser would send them. */
export function gridForm(body: string, g: string) {
  const form: Record<string, string> = {};
  for (const m of body.matchAll(new RegExp(`<input([^>]*)name="(${g}_\\d+_[a-z0-9]+)"[^>]*value="([^"]*)"[^>]*>`, 'g'))) {
    if (/type="checkbox"/.test(m[0]) && !/ checked/.test(m[0])) continue;
    form[m[2]] = unescape(m[3]);
  }
  for (const m of body.matchAll(new RegExp(`<select name="(${g}_\\d+_c\\d+)"[^>]*>([\\s\\S]*?)</select>`, 'g')))
    form[m[1]] = unescape(/<option value="([^"]*)" selected>/.exec(m[2])?.[1] ?? '');
  return form;
}
const headerOrder = (section: string) => [...section.matchAll(/<th scope="col"[^>]*data-col-name="([^"]+)"/g)].map((m) => m[1]);

describe('grid layout (pure)', () => {
  test('cleanLayout bounds names, widths and the frozen count', () => {
    const l = cleanLayout({ order: ['a', 'a', 'b', 7, 'x\u0000y', 'z'.repeat(64)], hidden: 'a', widths: { a: 5, b: 99999, c: 'wide', d: 120.4 }, frozen: 99 });
    assert.deepEqual(l, { order: ['a', 'b'], hidden: [], widths: { a: 40, b: 1000, d: 120 }, frozen: 5 });
    assert.equal(parseLayout('not json'), null);
    assert.equal(parseLayout('[1]'), null);
    assert.equal(parseLayout('x'.repeat(7000)), null);
  });

  test('arrange: listed columns first, frozen ones get widths and offsets, not every column can be hidden', () => {
    const cols = ['a', 'b', 'c', 'd'].map((name) => ({ name }));
    const out = arrange(cols, { order: ['c', 'a'], hidden: ['b'], widths: { a: 100 }, frozen: 2 }, 44);
    assert.deepEqual(out.map((p) => [p.col.name, p.hidden, p.frozen, p.left, p.width]), [
      ['c', false, true, 44, 160],
      ['a', false, true, 204, 100],
      ['b', true, false, 0, null],
      ['d', false, false, 0, null],
    ]);
    assert.ok(arrange(cols, { order: [], hidden: ['a', 'b', 'c', 'd'], widths: {}, frozen: 0 }, 0).every((p) => !p.hidden));
  });

  test('the Columns form: positions, shown, widths', () => {
    const l = layoutFromForm({ n: '3', col_0: 'a', show_0: 'true', pos_0: '3', col_1: 'b', pos_1: '1', width_1: '250', col_2: 'c', show_2: 'true', pos_2: 'x', frozen: '1' });
    assert.deepEqual(l, { order: ['b', 'a', 'c'], hidden: ['b'], widths: { b: 250 }, frozen: 1 });
  });

  test('builder: aggregates text and the grid features', () => {
    assert.deepEqual(parseAggregates('sal = sum, AVG, nope; ename=count; ghost=sum; job=', ['sal', 'ename', 'job']), { sal: ['sum', 'avg'], ename: 'count' });
    assert.equal(aggregatesText({ sal: ['sum', 'avg'], ename: 'count' }), 'sal=sum,avg; ename=count');
    const allowed = { pages: new Set([3]), lovs: new Set<string>(), reports: new Map(), authz: new Set(['ADMIN']) };
    const form = {
      allow_insert: 'true', allow_update: 'true', allow_delete: 'true', n: '2', col_0: 'deptno', shown_0: 'true', col_1: 'sal', shown_1: 'true',
      grid_features: '1', aggregates: 'sal=sum', frozen: '2', actions: 'true', saved_reports: 'true', public_reports: 'admin',
      row_actions: 'true', row_duplicate: 'true', edit_page: '3', edit_items: 'P3_ID=#deptno#',
      select_column: 'deptno', select_item: 'p9_dept', master_item: '', master_column: '',
    };
    assert.deepEqual(mergeGridSettings({ row_actions: { links: [{ label: 'X', page: 3 }] } }, form, allowed), {
      aggregates: { sal: 'sum' }, frozen: 2, public_reports: 'ADMIN',
      row_actions: { links: [{ label: 'X', page: 3 }], edit: { page: 3, items: { P3_ID: '#deptno#' } }, delete: false },
      select_row: { column: 'deptno', item: 'P9_DEPT' },
    });
    // a forged form: unknown page, scheme, column and item names are left out
    const forged = mergeGridSettings({}, { ...form, edit_page: '999', public_reports: 'NOPE', select_column: 'x', master_item: 'bad name', actions: '', row_actions: '' }, allowed);
    assert.deepEqual(forged, { aggregates: { sal: 'sum' }, frozen: 2, actions: false });
  });
});

describe('grid regions on HR page 27', () => {
  test('without a selection the details wait for one; selecting a row fills them', async () => {
    const page = (await king.get('/a/hr/27')).body;
    // a fresh session: nothing selected yet
    const fresh = new Browser(app);
    await fresh.login('king');
    const first = (await fresh.get('/a/hr/27')).body;
    assert.match(sectionOf(first, R.Staff), /Select a row above/);
    const res = await fresh.get(selectLink(page, '20'));
    assert.equal(res.statusCode, 200);
    const staff = sectionOf(res.body, R.Staff);
    const names = (await owner.query(`select ename from hr.emp where deptno = 20`)).rows.map((x) => x.ename);
    for (const n of names) assert.match(staff, new RegExp(`value="${n}"`));
    assert.match(sectionOf(res.body, R['Jobs in the department']), /Analyst/);
    // the selected master row is marked
    assert.match(sectionOf(res.body, R.Departments), /<tr class="is-selected"/);
    assert.match(sectionOf(res.body, R.Departments), /r\d+_sel=20[^"]*" data-grid-select="\d+,\d+" data-grid-leave aria-current="true"/);
  });

  test('the detail region refreshes through GET …/region/:id with the selection', async () => {
    const page = (await king.get('/a/hr/27')).body;
    const q = selectLink(page, '30').split('?')[1];
    const res = await king.get(`/a/hr/27/region/${R.Staff}?${q}`);
    assert.equal(res.statusCode, 200);
    const json = JSON.parse(res.body);
    const names = (await owner.query(`select ename from hr.emp where deptno = 30`)).rows.map((x) => x.ename);
    for (const n of names) assert.match(json.html, new RegExp(`value="${n}"`));
    assert.match(json.css, /left:/);
    // the selection stays in the session
    assert.match(sectionOf((await king.get('/a/hr/27')).body, R.Staff), new RegExp(`value="${names[0]}"`));
  });

  test('aggregates are computed over every row of the search, not only the page', async () => {
    const page = (await king.get('/a/hr/27')).body;
    await king.get(selectLink(page, '20'));
    const cfg = (await owner.one('select config from meta.region where id = $1', [R.Staff])).config;
    await owner.query(`update meta.region set config = config || '{"page_size": 2}' where id = $1`, [R.Staff]);
    try {
      const body = (await king.get(`/a/hr/27?r${R.Staff}_a=${encodeURIComponent('min|sal')}`)).body;
      const staff = sectionOf(body, R.Staff);
      const total = await owner.one(`select sum(sal)::numeric(12,2)::text as s, max(sal)::text as mx, min(sal)::text as mn, count(*)::int as n from hr.emp where deptno = 20`);
      assert.match(staff, /<tfoot>/);
      assert.match(staff, new RegExp(`Sum: ${total.s}`));
      assert.match(staff, new RegExp(`Count: ${total.n}<`));
      assert.match(staff, new RegExp(`Minimum: ${total.mn}`), 'the user\'s own aggregate');
      assert.match(staff, /class="chip">Minimum/);
      // the search narrows the totals too
      const clerks = await owner.one(`select sum(sal)::text as s from hr.emp where deptno = 20 and job = 'CLERK'`);
      const searched = sectionOf((await king.get(`/a/hr/27?r${R.Staff}_q=clerk`)).body, R.Staff);
      assert.match(searched, new RegExp(`Sum: ${clerks.s}`));
    } finally {
      await owner.query('update meta.region set config = $2 where id = $1', [R.Staff, cfg]);
    }
  });

  test('the developer\'s layout: order, frozen first column with a width', async () => {
    const staff = sectionOf((await king.get('/a/hr/27')).body, R.Staff);
    assert.deepEqual(headerOrder(staff).slice(0, 3), ['ename', 'job', 'sal']);
    assert.match(staff, /data-col-name="ename" data-width="170"/);
    assert.match(staff, /<th scope="col" class="grid-sized x\w+ grid-frozen x\w+ grid-frozen-last" data-col="1"/);
    assert.match(staff, /data-frozen="1"/);
  });

  test('a user arranges columns (form and JSON), the save keeps hidden values, Reset goes back', async () => {
    const page = (await king.get('/a/hr/27')).body;
    await king.get(selectLink(page, '20'));
    const g = `g${R.Staff}`;
    // the Columns form: comm hidden, sal first, mgr 120px, two frozen
    const res = await king.submit(`/a/hr/27/grid/${R.Staff}/layout`, {
      params: `r${R.Staff}_q=a&r9999_x=1&P27_DEPTNO=40`, n: '3',
      col_0: 'sal', show_0: 'true', pos_0: '1', col_1: 'comm', pos_1: '2', col_2: 'mgr', show_2: 'true', pos_2: '3', width_2: '120', frozen: '2',
    });
    assert.equal(res.statusCode, 303);
    assert.equal(res.headers.location, `/a/hr/27?r${R.Staff}_q=a&r9999_x=1`, 'only report and grid parameters come back');
    const body = (await king.get('/a/hr/27')).body;
    const staff = sectionOf(body, R.Staff);
    assert.deepEqual(headerOrder(staff).slice(0, 3), ['sal', 'comm', 'mgr']);
    assert.match(staff, /<th scope="col"[^>]*data-col-name="comm" hidden>/);
    assert.match(staff, /data-frozen="2"/);
    // inputs keep their names (the query's positions), hidden ones still post
    const rowOf = (form: Record<string, string>) => Object.keys(form).find((k) => form[k] === 'SMITH')!.replace(/_c\d+$/, '');
    const pk = gridForm(staff, g)[`${rowOf(gridForm(staff, g))}_pk`];
    const before = await owner.one('select sal, comm from hr.emp where empno = $1', [pk]);
    await owner.query('update hr.emp set comm = 11 where empno = $1', [pk]);
    try {
      // the update may move the row (no order by): find it again
      const fresh = gridForm(sectionOf((await king.get('/a/hr/27')).body, R.Staff), g);
      const row = rowOf(fresh);
      assert.equal(fresh[`${row}_pk`], String(pk));
      assert.equal(fresh[`${row}_c6`], '11.00', 'the hidden column still posts its value');
      const saved = await king.submit('/a/hr/27', { ...fresh, __request: `GRID_SAVE_${R.Staff}`, [`${row}_c5`]: '901' });
      assert.equal(saved.statusCode, 303, saved.body.match(/alert-error[^<]*<[^<]*/)?.[0] ?? '');
      const after = await owner.one('select sal::text, comm::text from hr.emp where empno = $1', [pk]);
      assert.deepEqual(after, { sal: '901.00', comm: '11.00' });
    } finally {
      await owner.query('update hr.emp set sal = $2, comm = $3 where empno = $1', [pk, before.sal, before.comm]);
    }
    // app.js posts JSON
    const json = await king.request('POST', `/a/hr/27/grid/${R.Staff}/layout`, { __csrf: king.lastCsrf, layout: JSON.stringify({ order: ['job', 'ename'], widths: { job: 222 } }) });
    assert.equal(json.statusCode, 303, 'without accept: json a redirect');
    const ajax = await app.inject({
      method: 'POST', url: `/a/hr/27/grid/${R.Staff}/layout`,
      payload: new URLSearchParams({ __csrf: king.lastCsrf, layout: JSON.stringify({ order: ['job', 'ename'], widths: { job: 222 } }) }).toString(),
      headers: { cookie: [...king.cookies].map(([k, v]) => `${k}=${v}`).join('; '), 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    });
    assert.equal(ajax.statusCode, 200);
    assert.deepEqual(JSON.parse(ajax.body), { ok: true });
    const staff2 = sectionOf((await king.get('/a/hr/27')).body, R.Staff);
    assert.deepEqual(headerOrder(staff2).slice(0, 2), ['job', 'ename']);
    assert.match(staff2, /data-col-name="job" data-width="222"/);
    // another user still sees the developer's layout
    const blake = new Browser(app);
    await blake.login('blake');
    assert.deepEqual(headerOrder(sectionOf((await blake.get(selectLink((await blake.get('/a/hr/27')).body, '20'))).body, R.Staff)).slice(0, 1), ['ename']);
    // Reset
    assert.equal((await king.submit(`/a/hr/27/grid/${R.Staff}/layout/reset`, { params: '' })).statusCode, 303);
    assert.deepEqual(headerOrder(sectionOf((await king.get('/a/hr/27')).body, R.Staff)).slice(0, 1), ['ename']);
  });

  test('saved grid reports keep the layout and the search; applying one makes its layout the user\'s', async () => {
    await king.get('/a/hr/27');
    await king.submit(`/a/hr/27/grid/${R.Staff}/layout`, { n: '1', col_0: 'hiredate', show_0: 'true', pos_0: '1', frozen: '0' });
    const saved = await king.submit(`/a/hr/27/report/${R.Staff}/save`, { name: 'By hire date', params: `r${R.Staff}_q=clerk` });
    assert.equal(saved.statusCode, 303);
    const row = await owner.one(`select id, params, kind from meta.saved_report where region_id = $1 and name = 'By hire date'`, [R.Staff]);
    const params = new URLSearchParams(row.params);
    assert.equal(params.get(`r${R.Staff}_q`), 'clerk');
    assert.deepEqual(JSON.parse(params.get(`r${R.Staff}_lay`)!).order, ['hiredate']);
    // back to the default, then apply the report
    await king.submit(`/a/hr/27/grid/${R.Staff}/layout/reset`, { params: '' });
    const page = (await king.get('/a/hr/27')).body;
    assert.match(page, new RegExp(`action="/a/hr/27/grid/${R.Staff}/saved/${row.id}/apply"`));
    const applied = await king.submit(`/a/hr/27/grid/${R.Staff}/saved/${row.id}/apply`, { params: `r${R.Staff}_q=zzz&r${R.Departments}_q=x` });
    assert.equal(applied.statusCode, 303);
    assert.equal(applied.headers.location, `/a/hr/27?r${R.Departments}_q=x&r${R.Staff}_q=clerk`);
    const staff = sectionOf((await king.get(applied.headers.location as string)).body, R.Staff);
    assert.equal(headerOrder(staff)[0], 'hiredate');
    assert.match(staff, /<button class="link-button" form="rsa\d+_\d+" aria-current="true">By hire date<\/button>/);
    await king.submit(`/a/hr/27/grid/${R.Staff}/layout/reset`, { params: '' });
  });

  test('row actions: edit link (signed, to an allowed page), duplicate, delete, custom link', async () => {
    const page = (await king.get('/a/hr/27')).body;
    const body = (await king.get(selectLink(page, '20'))).body;
    const staff = sectionOf(body, R.Staff);
    assert.match(staff, /<details class="menu row-menu">/);
    assert.match(staff, /href="\/a\/hr\/3\?P3_EMPNO=\d+&amp;cs=[0-9a-f]{32}" data-dialog>/);
    assert.match(staff, /href="\/a\/hr\/26\?P26_EMPNO=\d+&amp;cs=[0-9a-f]{32}">Show employee</);
    assert.match(staff, new RegExp(`<label for="g${R.Staff}_0_del" data-grid-del>`));
    assert.match(staff, new RegExp(`<input type="checkbox" id="g${R.Staff}_0_del"`));
    // the master configures no duplicate
    assert.doesNotMatch(sectionOf(body, R.Departments), /data-grid-dup/);
    // duplicate without JavaScript: the row's values in a new row
    const form = gridForm(staff, `g${R.Staff}`);
    const pk = form[`g${R.Staff}_1_pk`];
    const ename = form[`g${R.Staff}_1_c1`];
    const dup = sectionOf((await king.get(`/a/hr/27?r${R.Staff}_dup=${pk}`)).body, R.Staff);
    assert.match(dup, new RegExp(`<tr class="grid-new" data-new-row="0">[\\s\\S]*?name="g${R.Staff}_n0_c1" value="${ename}"`));
    // edit to a page the user may not open: no link (page 10 is for administrators)
    const cfg = (await owner.one('select config from meta.region where id = $1', [R.Staff])).config;
    await owner.query(`update meta.region set config = jsonb_set(config, '{row_actions,edit,page}', '10') where id = $1`, [R.Staff]);
    try {
      const blake = new Browser(app);
      await blake.login('blake');
      const b = sectionOf((await blake.get(selectLink((await blake.get('/a/hr/27')).body, '20'))).body, R.Staff);
      assert.doesNotMatch(b, /href="\/a\/hr\/10\?/);
      assert.match(b, /Show employee/);
    } finally {
      await owner.query('update meta.region set config = $2 where id = $1', [R.Staff, cfg]);
    }
  });

  test('a new row in the detail grid belongs to the selected master row', async () => {
    const page = (await king.get('/a/hr/27')).body;
    const body = (await king.get(selectLink(page, '40'))).body;
    const staff = sectionOf(body, R.Staff);
    const g = `g${R.Staff}`;
    try {
      const res = await king.submit('/a/hr/27', { ...gridForm(staff, g), __request: `GRID_SAVE_${R.Staff}`, [`${g}_n0_c1`]: 'GRIDKID', [`${g}_n0_c4`]: '2026-01-02' });
      assert.equal(res.statusCode, 303, res.body.slice(0, 300));
      assert.equal((await owner.one(`select deptno from hr.emp where ename = 'GRIDKID'`)).deptno, 40);
    } finally {
      await owner.query(`delete from hr.emp where ename = 'GRIDKID'`);
    }
  });

  test('the builder shows the new grid settings', async () => {
    const dev = new Browser(app);
    await dev.get('/builder/login');
    await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
    const res = await dev.get(`/builder/pages/${pageId}?c=region-${R.Staff}`);
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /name="aggregates" value="sal=sum,avg,max; ename=count"/);
    assert.match(res.body, /name="master_item" value="P27_DEPTNO"/);
  });
});
