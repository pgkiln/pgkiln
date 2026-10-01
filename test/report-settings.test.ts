// Page designer → Report settings: the report region's config as a form.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { mergeReportSettings, reportColumns } from '../src/builder/report-settings.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
let region: { id: number; page_id: number; config: any };

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  region = (await owner.one(`select r.id, r.page_id, r.config from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 2 and r.type = 'report'`, [appId]))!;
});

after(async () => {
  await owner.query('update meta.region set config = $2 where id = $1', [region.id, JSON.stringify(region.config)]);
  await app.close();
  await closePools();
});

const sets = { pages: new Set([2, 3]), layouts: new Set(['HR_DIRECTORY']), schemes: new Set(['ADMIN']) };
const merge = (config: any, b: Record<string, string>) => mergeReportSettings(config, b, sets.pages, sets.layouts, sets.schemes);
const cols = (...c: [string, Partial<Record<'heading' | 'shown' | 'print' | 'width', string>>][]) =>
  Object.fromEntries([['n', String(c.length)], ...c.flatMap(([name, x], i) => [[`col_${i}`, name], ...Object.entries(x).map(([k, v]) => [`${k}_${i}`, v])])]);
const on = { searchable: 'true', interactive: 'true', sortable: 'true', saved_reports: 'true' };

describe('report settings', () => {
  test('defaults are left out; other keys are kept', () => {
    const out = merge({ preformatted: ['x'], page_size: 50 }, { ...on, page_size: '15', mobile: 'reflow', ...cols(['a', { shown: 'true', print: 'true' }]) });
    assert.deepEqual(out, { preformatted: ['x'] });
  });

  test('columns: headings, hidden, printed and widths', () => {
    const out = merge({}, {
      ...on, page_size: '25', empty: 'Nobody here',
      ...cols(['empno', { heading: 'No.', shown: 'true' }], ['ename', { shown: 'true', print: 'true', width: '50' }], ['secret', { print: '' }]),
      pdf_layout: 'HR_DIRECTORY',
    });
    assert.deepEqual(out, {
      page_size: 25,
      empty: 'Nobody here',
      headings: { empno: 'No.' },
      hidden: ['secret'],
      pdf: { columns: ['ename'], widths: { ename: 50 }, layout: 'HR_DIRECTORY' },
    });
  });

  test('switches, link and public reports; unknown pages, layouts and schemes are dropped', () => {
    const out = merge({ link: { column: 'x', page: 9 } }, {
      page_size: '999', ...cols(['empno', { shown: 'true', print: 'true' }]),
      link_column: 'empno', link_page: '3', link_items: 'p3_empno=#empno#, P3_X = a=b',
      public_reports: 'ADMIN', pdf_layout: 'NO_SUCH',
    });
    assert.deepEqual(out, {
      searchable: false, interactive: false, sortable: false, saved_reports: false,
      public_reports: 'ADMIN',
      link: { column: 'empno', page: 3, items: { P3_EMPNO: '#empno#', P3_X: 'a=b' } },
    });
    assert.equal(merge({}, { link_column: 'empno', link_page: '77', ...cols(['empno', {}]) }).link, undefined, 'page of another app');
    assert.equal(merge({}, { public_reports: 'NOPE' }).public_reports, undefined);
  });

  test('row selection: a column of the query into an item of the page', () => {
    const items = new Set(['P2_SELECTED']);
    const m = (b: Record<string, string>) => mergeReportSettings({ selection: { column: 'x', item: 'Y' } }, { ...on, ...cols(['empno', { shown: 'true', print: 'true' }]), ...b }, sets.pages, sets.layouts, sets.schemes, items);
    assert.deepEqual(m({ sel_column: 'empno', sel_item: 'P2_SELECTED' }).selection, { column: 'empno', item: 'P2_SELECTED' });
    assert.equal(m({ sel_column: 'empno', sel_item: 'P9_OTHER' }).selection, undefined, 'item of another page');
    assert.equal(m({ sel_column: 'nope', sel_item: 'P2_SELECTED' }).selection, undefined);
    assert.equal(m({}).selection, undefined);
  });

  test('columns come from the query, as the app role, without running it', async () => {
    const r = await reportColumns(appId, 'select empno, ename, sal from hr.emp where deptno = :P2_DEPTNO::int');
    assert.deepEqual(r, { columns: ['empno', 'ename', 'sal'] });
    const denied = await reportColumns(appId, 'select password_hash from meta.account');
    assert.ok('error' in denied && /permission denied/.test(denied.error));
    const slow = await reportColumns(appId, 'select pg_sleep(0.1) as x');
    assert.deepEqual(slow, { columns: ['x'] });
  });

  test('the designer shows the form and saves it', async () => {
    const b = new Browser(app);
    await b.get('/builder/login');
    await b.submit('/builder/login', { username: 'admin', password: 'admin' });
    const page = (await b.get(`/builder/pages/${region.page_id}?c=region-${region.id}`)).body;
    assert.match(page, /Report settings/);
    assert.match(page, /<code>hiredate<\/code>/, 'columns of the query');
    const n = Number(/name="n" value="(\d+)"/.exec(page)![1]);
    const body: Record<string, string> = { ...on, page_size: '10', n: String(n), link_column: 'empno', link_page: '3', link_items: 'P3_EMPNO=#empno#' };
    for (let i = 0; i < n; i++) {
      const name = new RegExp(`name="col_${i}" value="([^"]+)"`).exec(page)![1];
      body[`col_${i}`] = name;
      if (name !== 'active') body[`shown_${i}`] = 'true';
      body[`print_${i}`] = name === 'active' ? '' : 'true';
    }
    const res = await b.submit(`/builder/pages/${region.page_id}/region/${region.id}/report-settings`, body);
    assert.equal(res.statusCode, 303);
    const cfg = (await owner.one('select config from meta.region where id = $1', [region.id])).config;
    assert.equal(cfg.page_size, 10);
    assert.deepEqual(cfg.hidden, ['active']);
    assert.deepEqual(cfg.link, { column: 'empno', page: 3, items: { P3_EMPNO: '#empno#' } });
    assert.equal(cfg.pdf, undefined, 'printing what is shown needs no pdf settings');
    // only for report regions of that page, by developers with the CSRF token
    assert.equal((await b.submit(`/builder/pages/${region.page_id + 100000}/region/${region.id}/report-settings`, body)).statusCode, 404);
    b.lastCsrf = 'forged';
    assert.equal((await b.submit(`/builder/pages/${region.page_id}/region/${region.id}/report-settings`, body)).statusCode, 403);
    assert.equal((await new Browser(app).post(`/builder/pages/${region.page_id}/region/${region.id}/report-settings`, body)).statusCode, 302);
  });
});
