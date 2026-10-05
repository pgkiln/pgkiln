// Page designer → settings forms for grid, chart, cards, calendar and faceted search regions.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import {
  type Allowed, mergeCalendarSettings, mergeCardsSettings, mergeChartSettings, mergeFacetsSettings, mergeGridSettings, mergeMapSettings,
} from '../src/builder/region-settings.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let regions: { id: number; page_id: number; page_no: number; type: string; config: any }[];

before(async () => {
  app = await buildApp({ logger: false });
  regions = (await owner.query(
    `select r.id, r.page_id, p.page_no, r.type, r.config from meta.region r join meta.page p on p.id = r.page_id join meta.app a on a.id = p.app_id
      where a.alias = 'hr' and r.type in ('grid', 'chart', 'cards', 'calendar', 'facets') order by r.id`,
  )).rows;
});

after(async () => {
  for (const r of regions) await owner.query('update meta.region set config = $2 where id = $1', [r.id, JSON.stringify(r.config)]);
  await app.close();
  await closePools();
});

const allowed: Allowed = { pages: new Set([3, 5, 7]), lovs: new Set(['DEPARTMENTS']), reports: new Map([[19, ['job', 'department', 'status', 'ename']]]) };
const cols = (...c: [string, Record<string, string>][]) =>
  Object.fromEntries([['n', String(c.length)], ...c.flatMap(([name, x], i) => [[`col_${i}`, name], ...Object.entries(x).map(([k, v]) => [`${k}_${i}`, v])])]);
const allowAll = { allow_insert: 'true', allow_update: 'true', allow_delete: 'true' };

describe('region settings: merges', () => {
  test('chart: kind and empty text; the default bar is left out; unknown kinds are dropped', () => {
    assert.deepEqual(mergeChartSettings({ kind: 'donut', other: 1 }, { kind: 'bar', empty: ' ' }, allowed), { other: 1 });
    assert.deepEqual(mergeChartSettings({}, { kind: 'area', empty: 'Nothing yet' }, allowed), { kind: 'area', empty: 'Nothing yet' });
    assert.deepEqual(mergeChartSettings({}, { kind: 'pie3d' }, allowed), {});
    for (const kind of ['stacked', 'combo', 'scatter', 'pie', 'bubble', 'gauge', 'funnel', 'radar', 'gantt', 'pyramid', 'polar']) assert.deepEqual(mergeChartSettings({}, { kind }, allowed), { kind });
  });

  test('chart: drill-down link to a page of the app; gauge numbers only', () => {
    assert.deepEqual(mergeChartSettings({}, { kind: 'gauge', link_page: '5', link_items: 'P5_DEPTNO=#deptno#', gauge_min: '0', gauge_max: '120', gauge_warning: '80.5', gauge_critical: 'x' }, allowed), {
      kind: 'gauge', link: { page: 5, items: { P5_DEPTNO: '#deptno#' } }, gauge: { min: 0, max: 120, warning: 80.5 },
    });
    assert.deepEqual(mergeChartSettings({ link: { page: 5 }, gauge: { max: 3 } }, { link_page: '99', gauge_max: '' }, allowed), {});
  });

  test('cards: style, empty and a link to a page of the app only', () => {
    assert.deepEqual(mergeCardsSettings({ x: true }, { style: 'metric', link_page: '5', link_items: 'p5_deptno=#deptno#' }, allowed), {
      x: true, style: 'metric', link: { page: 5, items: { P5_DEPTNO: '#deptno#' } },
    });
    assert.deepEqual(mergeCardsSettings({ style: 'metric', link: { page: 5 } }, { style: '', link_page: '99' }, allowed), {});
  });

  test('calendar: link only', () => {
    assert.deepEqual(mergeCalendarSettings({}, { link_page: '7', link_items: 'P7_ID=#id#' }, allowed), { link: { page: 7, items: { P7_ID: '#id#' } } });
    assert.deepEqual(mergeCalendarSettings({ link: { page: 7 } }, { link_page: '' }, allowed), {});
  });

  test('calendar: views, create link, hours, drag and drop; defaults left out', () => {
    const all = { view_month: 'true', view_week: 'true', view_day: 'true', view_list: 'true' };
    assert.deepEqual(mergeCalendarSettings({ x: 1 }, { ...all, view: 'month', day_start: '8', day_end: '18', key: 'id' }, { ...allowed, authz: new Set(['MANAGER']) }), { x: 1 });
    assert.deepEqual(
      mergeCalendarSettings({}, {
        view_week: 'true', view_day: 'true', view: 'day', day_start: '7', day_end: '20', create_page: '7', create_items: 'P7_START_DATE=#start#',
        move: ' select app.move(:EVENT_ID, :NEW_START, :NEW_END) ', key: 'booking_id', move_authz: 'manager',
      }, { ...allowed, authz: new Set(['MANAGER']) }),
      {
        views: ['week', 'day'], view: 'day', day_start: 7, day_end: 20, create: { page: 7, items: { P7_START_DATE: '#start#' } },
        move: 'select app.move(:EVENT_ID, :NEW_START, :NEW_END)', key: 'booking_id', move_authz: 'MANAGER',
      },
    );
    // a view that isn't enabled, a key that isn't an identifier, an unknown scheme, a page of another app, bad hours
    assert.deepEqual(
      mergeCalendarSettings({ views: ['list'], move_authz: 'X' }, { view_month: 'true', view: 'list', key: 'id; drop', move_authz: 'NOPE', create_page: '99', day_start: '25', day_end: '3' }, allowed),
      { views: ['month'] },
    );
    assert.deepEqual(mergeCalendarSettings({}, { move_authz: 'must_not_be_public_user' }, allowed), { move_authz: 'MUST_NOT_BE_PUBLIC_USER' });
  });

  test('grid: defaults left out, per-column keys kept, LOVs checked', () => {
    const base = { columns: { dname: { required: true, width: 9 }, gone: { required: true } }, page_size: 50, preformatted: ['x'] };
    const out = mergeGridSettings(base, {
      ...allowAll, page_size: '25',
      ...cols(['deptno', { shown: 'true', readonly: 'true', heading: 'No.' }], ['dname', { shown: 'true' }], ['loc', { lov: 'LOV:departments' }], ['x', { shown: 'true', lov: 'LOV:NOPE' }]),
    }, allowed);
    assert.deepEqual(out, {
      preformatted: ['x'],
      headings: { deptno: 'No.' },
      hidden: ['loc'],
      readonly: ['deptno'],
      columns: { dname: { width: 9 }, gone: { required: true }, loc: { lov: 'LOV:DEPARTMENTS' } },
    });
    // a custom LOV that was already there survives; a new one typed into a forged form doesn't
    const custom = { columns: { job: { lov: 'STATIC:Clerk;CLERK' } } };
    assert.deepEqual(mergeGridSettings(custom, { ...allowAll, ...cols(['job', { shown: 'true', lov: 'STATIC:Clerk;CLERK' }]) }, allowed).columns, custom.columns);
    assert.equal(mergeGridSettings({}, { ...allowAll, ...cols(['job', { shown: 'true', lov: 'select 1, 1' }]) }, allowed).columns, undefined);
  });

  test('grid: switches and page size', () => {
    assert.deepEqual(mergeGridSettings({}, { page_size: '100', allow_update: 'true' }, allowed), { page_size: 100, allow: { insert: false, delete: false } });
    assert.deepEqual(mergeGridSettings({ page_size: 50 }, { ...allowAll, page_size: '7' }, allowed), {});
  });

  test('facets: report checked, order, labels and limits; old extra keys kept', () => {
    const out = mergeFacetsSettings({ report: 19, facets: [{ column: 'job', label: 'Job', extra: 1 }] }, {
      report: '19',
      ...cols(['job', { on: 'true', label: '', limit: '12', seq: '30' }], ['status', { on: 'true', label: 'State', limit: '5', seq: '10' }], ['ename', { seq: '20' }], ['salary', { on: 'true' }]),
    }, allowed);
    assert.deepEqual(out, { report: 19, facets: [{ column: 'status', label: 'State', limit: 5 }, { extra: 1, column: 'job' }] });
    assert.deepEqual(mergeFacetsSettings({ report: 19, facets: [] }, { report: '4' }, allowed), { facets: [] }, 'not a report on this page');
    assert.deepEqual(mergeFacetsSettings({ report: 19, facets: [{ column: 'job' }] }, { report: '19', n: '1', col_0: 'job' }, allowed), { report: 19 });
  });
});

describe('region settings: designer', () => {
  let b: Browser;
  before(async () => {
    b = new Browser(app);
    await b.get('/builder/login');
    await b.submit('/builder/login', { username: 'admin', password: 'admin' });
  });
  const of = (type: string) => regions.find((r) => r.type === type)!;
  const url = (r: { id: number; page_id: number }) => `/builder/pages/${r.page_id}/region/${r.id}/settings`;

  test('every region type shows its form with the columns of its query', async () => {
    for (const [type, title, column] of [['grid', 'Grid settings', 'dname'], ['chart', 'Chart settings', null], ['cards', 'Cards settings', null], ['calendar', 'Calendar settings', 'start_date'], ['facets', 'Faceted search settings', 'job']] as const) {
      const r = of(type);
      const page = (await b.get(`/builder/pages/${r.page_id}?c=region-${r.id}`)).body;
      assert.match(page, new RegExp(title), type);
      assert.doesNotMatch(page, /could not be read/, type);
      if (column) assert.match(page, new RegExp(`<code>${column}</code>`), `${type}: ${column}`);
    }
  });

  test('saving the grid form round-trips the sample settings', async () => {
    const r = of('grid');
    const page = (await b.get(`/builder/pages/${r.page_id}?c=region-${r.id}`)).body;
    const n = Number(/name="n" value="(\d+)"/.exec(page)![1]);
    const body: Record<string, string> = { ...allowAll, page_size: '25', n: String(n) };
    for (let i = 0; i < n; i++) {
      body[`col_${i}`] = new RegExp(`name="col_${i}" value="([^"]+)"`).exec(page)![1];
      body[`heading_${i}`] = new RegExp(`name="heading_${i}" value="([^"]*)"`).exec(page)![1];
      body[`shown_${i}`] = 'true';
      if (new RegExp(`name="required_${i}" value="true" checked`).test(page)) body[`required_${i}`] = 'true';
    }
    assert.equal((await b.submit(url(r), body)).statusCode, 303);
    const cfg = (await owner.one('select config from meta.region where id = $1', [r.id])).config;
    const { page_size: _default, ...expected } = r.config; // 25 is the default, so it's left out
    assert.deepEqual(cfg, expected, 'unchanged form, unchanged config');
  });

  test('saving cards and facets; other region types and pages are refused', async () => {
    const cards = of('cards');
    assert.equal((await b.submit(url(cards), { style: 'metric', empty: 'None' })).statusCode, 303);
    const cfg = (await owner.one('select config from meta.region where id = $1', [cards.id])).config;
    assert.deepEqual(cfg, { style: 'metric', empty: 'None' });

    const facets = of('facets');
    assert.equal((await b.submit(url(facets), { report: String(facets.config.report), n: '2', col_0: 'job', on_0: 'true', col_1: 'department', on_1: 'true', label_1: 'Dept' })).statusCode, 303);
    assert.deepEqual((await owner.one('select config from meta.region where id = $1', [facets.id])).config, {
      report: facets.config.report, facets: [{ column: 'job' }, { column: 'department', label: 'Dept' }],
    });

    const report = await owner.one(`select id, page_id from meta.region where type = 'report' limit 1`);
    assert.equal((await b.submit(url(report), {})).statusCode, 404, 'report regions use their own form');
    assert.equal((await b.submit(`/builder/pages/${cards.page_id + 100000}/region/${cards.id}/settings`, {})).statusCode, 404);
    b.lastCsrf = 'forged';
    assert.equal((await b.submit(url(cards), {})).statusCode, 403);
    assert.equal((await new Browser(app).post(url(cards), {})).statusCode, 302, 'developers only');
  });
});

describe('map settings', () => {
  test('a heat layer and a report on the page to filter; other values are dropped', () => {
    assert.deepEqual(mergeMapSettings({}, { layer: 'heat', report: '19' }, allowed), { layer: 'heat', report: 19 });
    assert.deepEqual(mergeMapSettings({ layer: 'heat', report: 19 }, { layer: 'markers', report: '' }, allowed), {});
    assert.deepEqual(mergeMapSettings({}, { layer: 'nuclear', report: '20' }, allowed), {}, 'only a report of this page');
  });
});
