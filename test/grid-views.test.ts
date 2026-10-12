// Interactive grid views (sprint 54): the single row view (one row as a form,
// saved by the grid's own process), group by and chart (the interactive
// report's views), and config.views. HR example page 27: the Staff grid
// follows the selected department (P27_DEPTNO).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { gridViews } from '../src/runtime/grid.ts';
import { mergeGridSettings } from '../src/builder/region-settings.ts';
import { Browser, gridForm } from './helpers.ts';

let app: FastifyInstance;
let king: Browser;
let S: number; // the Staff grid
let staffCfg: unknown;

before(async () => {
  app = await buildApp({ logger: false });
  king = new Browser(app);
  await king.login('king');
  const page = (await owner.one(`select p.id from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 27`)).id;
  const region = await owner.one(`select id, config from meta.region where page_id = $1 and title = 'Staff'`, [page]);
  S = region.id;
  staffCfg = region.config;
  // department 20 selected (the master grid's selection link sets P27_DEPTNO)
  const body = (await king.get('/a/hr/27')).body;
  const link = new RegExp(`href="([^"]*_sel=20&amp;[^"]*)"`).exec(body)![1].replace(/&amp;/g, '&');
  await king.get(link);
});

after(async () => {
  await owner.query('update meta.region set config = $2 where id = $1', [S, staffCfg]);
  await app.close();
  await closePools();
});

const sectionOf = (page: string) => {
  const start = page.indexOf(`id="R${S}"`);
  return page.slice(start, page.indexOf('</section>', start));
};
const staff = async (q: string) => sectionOf((await king.get(`/a/hr/27?${q}`)).body);
// by employee number, so positions are stable
const sorted = () => `r${S}_s=1`;
const dept20 = async () => (await owner.query(`select empno, ename, sal::text from hr.emp where deptno = 20 order by empno`)).rows;

describe('grid views (pure)', () => {
  test('config.views limits the views; left out means all three', () => {
    assert.deepEqual(gridViews({ config: {} } as never), ['row', 'group', 'chart']);
    assert.deepEqual(gridViews({ config: { views: ['chart', 'nope'] } } as never), ['chart']);
    assert.deepEqual(gridViews({ config: { views: [] } } as never), []);
  });

  test('builder: the Views checkboxes', () => {
    const allowed = { pages: new Set<number>(), lovs: new Set<string>(), reports: new Map(), authz: new Set<string>() };
    const form = { n: '0', grid_features: '1', grid_views: '1', actions: 'true', saved_reports: 'true' };
    assert.equal(mergeGridSettings({}, { ...form, view_row: 'true', view_group: 'true', view_chart: 'true' }, allowed).views, undefined);
    assert.deepEqual(mergeGridSettings({}, { ...form, view_row: 'true' }, allowed).views, ['row']);
    assert.deepEqual(mergeGridSettings({}, form, allowed).views, []);
    // a form without the Views fieldset leaves them alone
    assert.deepEqual(mergeGridSettings({ views: ['chart'] }, { ...form, grid_views: '' }, allowed).views, ['chart']);
  });
});

describe('single row view', () => {
  test('one row of the search as a form, with Previous/Next and its position', async () => {
    const rows = await dept20();
    const s = await staff(`${sorted()}&r${S}_v=row&r${S}_row=2`);
    assert.match(s, /class="grid-record" data-row="0"/);
    assert.match(s, new RegExp(`name="g${S}_0_c1" value="${rows[1].ename}"`));
    assert.doesNotMatch(s, new RegExp(`value="${rows[0].ename}"`), 'only that row');
    assert.match(s, new RegExp(`Row 2 of ${rows.length}`));
    assert.match(s, new RegExp(`r${S}_row=1[^"]*" rel="prev"`));
    assert.match(s, new RegExp(`r${S}_row=3[^"]*" rel="next"`));
    assert.match(s, /aria-current="true">Single row view</);
    // the row's edit and custom links, and the Save button
    assert.match(s, /href="\/a\/hr\/3\?P3_EMPNO=\d+&amp;cs=[0-9a-f]{32}"/);
    assert.match(s, new RegExp(`value="GRID_SAVE_${S}"`));
    // past the end: the last row
    const last = await staff(`${sorted()}&r${S}_v=row&r${S}_row=999`);
    assert.match(last, new RegExp(`value="${rows[rows.length - 1].ename}"`));
    assert.match(last, new RegExp(`Row ${rows.length} of ${rows.length}`));
    // not a number: the first row
    assert.match(await staff(`${sorted()}&r${S}_v=row&r${S}_row=x'`), new RegExp(`value="${rows[0].ename}"`));
  });

  test('the grid links each row to it; going back opens the page with that row', async () => {
    await owner.query(`update meta.region set config = config || '{"page_size": 2}' where id = $1`, [S]);
    try {
      const grid = await staff(`${sorted()}&r${S}_p=2`);
      assert.match(grid, new RegExp(`r${S}_v=row&amp;r${S}_row=3" data-grid-leave>Single row view<`));
      const row = await staff(`${sorted()}&r${S}_v=row&r${S}_row=3`);
      assert.match(row, new RegExp(`href="/a/hr/27\\?r${S}_s=1&amp;r${S}_p=2" data-grid-leave>Grid<`));
    } finally {
      await owner.query('update meta.region set config = $2 where id = $1', [S, staffCfg]);
    }
  });

  test('saved by the grid process: a change, a failed check shows the posted value again', async () => {
    const rows = await dept20();
    const s = await staff(`${sorted()}&r${S}_v=row&r${S}_row=1`);
    const form = gridForm(s, `g${S}`);
    assert.equal(form[`g${S}_0_pk`], String(rows[0].empno));
    try {
      const ok = await king.submit(`/a/hr/27?${sorted()}&r${S}_v=row&r${S}_row=1`, { ...form, __request: `GRID_SAVE_${S}`, [`g${S}_0_c5`]: '1234' });
      assert.equal(ok.statusCode, 303, ok.body.match(/alert-error[^<]*<[^<]*/)?.[0] ?? '');
      assert.equal((await owner.one('select sal::text from hr.emp where empno = $1', [rows[0].empno])).sal, '1234.00');
      assert.equal(ok.headers.location, `/a/hr/27?r${S}_s=1&r${S}_v=row&r${S}_row=1`, 'back to the same row');
      // the Save button posts that state along (formaction)
      assert.match(s, new RegExp(`value="GRID_SAVE_${S}" formaction="/a/hr/27\\?r${S}_s=1&amp;r${S}_v=row&amp;r${S}_row=1"`));
      // the name is required: the form comes back with what was typed
      const bad = await king.submit(`/a/hr/27?${sorted()}&r${S}_v=row&r${S}_row=1`, { ...form, __request: `GRID_SAVE_${S}`, [`g${S}_0_c1`]: '', [`g${S}_0_c5`]: '4321' });
      assert.notEqual(bad.statusCode, 303);
      assert.match(sectionOf(bad.body), new RegExp(`class="grid-record" data-row="0">[\\s\\S]*name="g${S}_0_c5" value="4321"`), 'still the single row view');
      // a key with another row's checksum is refused
      const forged = await king.submit('/a/hr/27', { ...form, __request: `GRID_SAVE_${S}`, [`g${S}_0_pk`]: String(rows[1].empno), [`g${S}_0_c5`]: '1' });
      assert.match(forged.body, /this row was changed outside the grid/);
      assert.equal((await owner.one('select sal::text from hr.emp where empno = $1', [rows[1].empno])).sal, rows[1].sal);
    } finally {
      await owner.query('update hr.emp set sal = $2 where empno = $1', [rows[0].empno, rows[0].sal]);
    }
  });

  test('a new row: a blank form, saved into the selected department', async () => {
    const s = await staff(`r${S}_v=row&r${S}_row=new`);
    assert.match(s, /class="grid-record grid-new" data-new-row="0"/);
    assert.match(s, new RegExp(`name="g${S}_n0_c1" value=""`));
    assert.doesNotMatch(s, new RegExp(`r${S}_row=new" data-grid-leave>`), 'no Add button while adding');
    try {
      const res = await king.submit(`/a/hr/27?r${S}_v=row&r${S}_row=new`, { __request: `GRID_SAVE_${S}`, [`g${S}_n0_c1`]: 'ONEROW', [`g${S}_n0_c4`]: '2026-01-02' });
      assert.equal(res.statusCode, 303, res.body.match(/alert-error[^<]*<[^<]*/)?.[0] ?? '');
      assert.equal((await owner.one(`select deptno from hr.emp where ename = 'ONEROW'`)).deptno, 20);
    } finally {
      await owner.query(`delete from hr.emp where ename = 'ONEROW'`);
    }
  });
});

describe('group by and chart views', () => {
  test('Actions → Group by: groups over every row of the search', async () => {
    const res = await king.get(`/a/hr/27?r${S}_gb1=job&r${S}_gbf=sum&r${S}_gbc=sal`);
    assert.equal(res.statusCode, 302, 'normalised into r<id>_g, r<id>_ga and r<id>_v');
    const s = sectionOf((await king.get(res.headers.location as string)).body);
    assert.match(s, /aria-current="true">Group by</);
    assert.match(s, /<table class="report report-reflow report-group">/);
    const clerks = await owner.one(`select count(*)::int as n from hr.emp where deptno = 20 and job = 'CLERK'`);
    assert.match(s, new RegExp(`CLERK</td><td class="num"[^>]*>${clerks.n}</td>`));
    assert.match(s, /Sum: Salary/);
    assert.doesNotMatch(s, new RegExp(`value="GRID_SAVE_${S}"`), 'nothing to save in this view');
    // the switcher goes back to the grid and keeps the setup
    assert.match(s, new RegExp(`href="/a/hr/27\\?r${S}_g=job[^"]*" data-grid-leave>Grid<`));
  });

  test('Actions → Chart', async () => {
    const s = await staff(`r${S}_ch=${encodeURIComponent('bar|job|count|empno')}&r${S}_v=chart`);
    assert.match(s, /class="chart-bar/);
    assert.match(s, /aria-current="true">Chart</);
  });

  test('the Actions menu offers the views the developer allows; others are ignored', async () => {
    const menu = await staff('');
    assert.match(menu, new RegExp(`name="r${S}_gb1" form="rg${S}"`));
    assert.match(menu, new RegExp(`name="r${S}_ck" form="rk${S}"`));
    await owner.query(`update meta.region set config = config || '{"views": ["row"]}' where id = $1`, [S]);
    try {
      const s = await staff(`r${S}_g=job&r${S}_v=group`);
      assert.doesNotMatch(s, /report-group/);
      assert.match(s, /class="report report-reflow grid-table"/, 'the grid instead');
      assert.doesNotMatch(s, new RegExp(`name="r${S}_gb1"`));
      assert.match(s, new RegExp(`r${S}_v=row&amp;r${S}_row=1" data-grid-leave>Single row view<`), 'in the Actions menu');
      assert.doesNotMatch(s, /class="seg view-switch"/, 'a plain grid has no switcher');
      // pivot is a report view only
      await owner.query(`update meta.region set config = config - 'views' where id = $1`, [S]);
      assert.doesNotMatch(await staff(`r${S}_pv=${encodeURIComponent('job|mgr|sum|sal')}&r${S}_v=pivot`), /report-pivot/);
    } finally {
      await owner.query('update meta.region set config = $2 where id = $1', [S, staffCfg]);
    }
  });
});
