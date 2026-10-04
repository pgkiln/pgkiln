// Smart filters, faceted search extensions (range, star and search facets,
// exclude) and the region display selector (HR page 21).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { SqlParams } from '../src/binds.ts';
import { closePools, owner } from '../src/db.ts';
import { facetDefs, facetFilters, facetFilterSql, reportFacetDefs } from '../src/runtime/facet-state.ts';
import type { Region } from '../src/metadata.ts';
import { mergeDisplaySelectorSettings, mergeFacetsSettings, mergeSmartFiltersSettings, parseRanges, rangesText, type Allowed } from '../src/builder/region-settings.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let smartReport: number; // the report the smart filters filter
let facetReport: number; // the report the faceted search filters
const ids: Record<string, number> = {};

before(async () => {
  app = await buildApp({ logger: false });
  const rows = (await owner.query(
    `select r.id, r.type, r.title from meta.region r join meta.page p on p.id = r.page_id join meta.app a on a.id = p.app_id
      where a.alias = 'hr' and p.page_no = 21 order by r.seq`,
  )).rows;
  for (const r of rows) ids[r.title] = r.id;
  smartReport = ids['Employees'];
  facetReport = ids['Employee list'];
});

after(async () => {
  await app.close();
  await closePools();
});

async function king() {
  const b = new Browser(app);
  await b.login('king');
  return b;
}
const tbodyOf = (body: string, rid: number) => new RegExp(`id="R${rid}"[\\s\\S]*?<tbody>([\\s\\S]*?)</tbody>`).exec(body)?.[1] ?? '';
const names = (body: string, rid: number) => [...tbodyOf(body, rid).matchAll(/data-label="Name">([^<]*)</g)].map((m) => m[1]);
const page21 = (params: [string, string][]) => `/a/hr/21?${new URLSearchParams(params)}`;

describe('facet state (unit)', () => {
  const region = (id: number, type: string, config: object) => ({ id, type, config }) as unknown as Region;
  const defs = reportFacetDefs([
    region(1, 'facets', { report: 9, facets: [{ column: 'job', exclude: true }, { column: 'sal', type: 'range', ranges: [{ to: 1000 }, { from: 1000 }] }, { column: 'r', type: 'star', max: 3 }] }),
    region(2, 'smart_filters', { report: 9, facets: [{ column: 'dept' }, { column: 'job', exclude: false }] }),
    region(3, 'facets', { report: 8, facets: [{ column: 'other' }] }),
  ], 9);

  test('the facets of every filter region of the report; the first definition of a column wins', () => {
    assert.deepEqual([...defs.keys()], ['job', 'sal', 'r', 'dept']);
    assert.equal(defs.get('job')!.exclude, true);
    assert.deepEqual(defs.get('r')!.ranges.map((x) => x.from), ['3', '2', '1']);
    assert.equal(defs.get('sal')!.custom, false, 'ranges given: no from/to unless asked');
    assert.equal(facetDefs({ facets: [{ column: 'd', type: 'range' }] })[0].custom, true, 'no ranges: from/to');
    assert.equal(facetDefs({ facets: [{ column: 'd', type: 'nope' }] })[0].type, 'checkbox');
  });

  test('only filters the facets allow are read from the URL', () => {
    const p = new URLSearchParams([
      ['r9_x_job', 'CLERK'], ['r9_x_job', 'CLERK'], ['r9_xn_job', '1'],
      ['r9_x_other', 'x'], // no facet on this column
      ['r9_x_sal', '5'], // a range facet takes no values
      ['r9_rg_sal', '0|500'], // not one of its ranges
      ['r9_rf_sal', '1'], // no custom range on this facet
      ['r9_rg_r', '2|'],
      ['r9_xn_dept', '1'], ['r9_x_dept', 'SALES'], // dept doesn't allow exclude
    ]);
    assert.deepEqual(facetFilters(p, 9, defs), [
      { column: 'job', kind: 'values', values: ['CLERK'], exclude: true },
      { column: 'r', kind: 'range', from: '2', to: '', custom: false },
      { column: 'dept', kind: 'values', values: ['SALES'], exclude: false },
    ]);
    assert.deepEqual(facetFilters(p, 9, defs, 'job').map((f) => f.column), ['r', 'dept'], 'except a column');
  });

  test('conditions use query parameters; bounds must fit the column type', () => {
    const cols = new Map([['job', 25], ['sal', 1700], ['d', 1082]]);
    const p = new SqlParams();
    assert.equal(facetFilterSql({ column: 'job', kind: 'values', values: ["x' or 1=1 --"], exclude: false }, cols, p), `"__q"."job"::text = any($1::text[])`);
    assert.equal(facetFilterSql({ column: 'job', kind: 'values', values: ['a'], exclude: true }, cols, p), `("__q"."job" is null or not ("__q"."job"::text = any($2::text[])))`);
    assert.equal(facetFilterSql({ column: 'sal', kind: 'range', from: '1', to: '2', custom: true }, cols, p), `("__q"."sal" >= $3::numeric and "__q"."sal" <= $4::numeric)`);
    assert.equal(facetFilterSql({ column: 'd', kind: 'range', from: '', to: '2026-02-01', custom: true }, cols, p), `("__q"."d" < $5::date + 1)`);
    assert.deepEqual(p.values, [["x' or 1=1 --"], ['a'], '1', '2', '2026-02-01']);
    assert.equal(facetFilterSql({ column: 'd', kind: 'range', from: '12', to: '', custom: true }, cols, p), null, 'a number on a date column');
    assert.equal(facetFilterSql({ column: 'job', kind: 'range', from: '1', to: '', custom: true }, cols, p), null, 'a range on a text column');
    assert.equal(facetFilterSql({ column: 'gone', kind: 'values', values: ['a'], exclude: false }, cols, p), null, 'not a column of the report');
  });
});

describe('faceted search extensions (page 21)', () => {
  test('exclude: the chosen values are left out', async () => {
    const b = await king();
    const all = names((await b.get(page21([[`r${facetReport}_n`, '50']]))).body, facetReport);
    const body = (await b.get(page21([[`r${facetReport}_n`, '50'], [`r${facetReport}_x_job`, 'Clerk'], [`r${facetReport}_xn_job`, '1']]))).body;
    const left = names(body, facetReport);
    assert.equal(left.length, all.length - 4, 'four clerks');
    assert.ok(!left.includes('Smith') && left.includes('King'));
    assert.match(body, /name="r\d+_xn_job" value="1" checked data-facet/);
  });

  test('predefined, custom and star ranges', async () => {
    const b = await king();
    const n = [`r${facetReport}_n`, '50'] as [string, string];
    const high = names((await b.get(page21([n, [`r${facetReport}_rg_salary`, '3000|']]))).body, facetReport);
    assert.deepEqual(high.sort(), ['Ford', 'King', 'Scott']);
    const custom = names((await b.get(page21([n, [`r${facetReport}_rg_salary`, '~'], [`r${facetReport}_rf_salary`, '2900'], [`r${facetReport}_rt_salary`, '3000']]))).body, facetReport);
    assert.deepEqual(custom.sort(), ['Ford', 'Jones', 'Scott'], 'custom "to" includes 3000');
    const hired = names((await b.get(page21([n, [`r${facetReport}_rf_hiredate`, '1987-01-01']]))).body, facetReport);
    assert.deepEqual(hired.sort(), ['Adams', 'Scott']);
    const stars = (await b.get(page21([n, [`r${facetReport}_rg_rating`, '5|']]))).body;
    assert.ok(names(stars, facetReport).length > 0);
    assert.match(stars, /5 stars and up/);
    assert.match(stars, /value="5\|" checked/);
  });

  test('the search facet searches the report; counts follow the other filters', async () => {
    const b = await king();
    const body = (await b.get(page21([[`r${facetReport}_q`, 'research']]))).body;
    assert.equal(names(body, facetReport).length, 5);
    assert.match(body, /id="ff\d+_q" name="r\d+_q" form="ff\d+" value="research"/);
    assert.match(body, /value="Analyst" data-facet>\s*<span class="facet-label">Analyst<\/span><span class="facet-count">2<\/span>/);
  });

  test('a facet on another report region does not filter this one', async () => {
    const b = await king();
    const body = (await b.get(page21([[`r${facetReport}_n`, '50'], [`r${facetReport}_x_department`, 'SALES']]))).body;
    assert.equal(names(body, facetReport).length, 14, 'department is a smart filter of the other report only');
  });
});

describe('smart filters (page 21)', () => {
  test('suggestions without a search, filter chips with remove links', async () => {
    const b = await king();
    const plain = (await b.get('/a/hr/21')).body;
    assert.match(plain, /Suggested filters:/);
    assert.match(plain, new RegExp(`href="/a/hr/21\\?r${smartReport}_x_job=Clerk">Job: <b>Clerk</b> <span class="facet-count">4</span>`));
    assert.match(plain, /Salary: <b>Below 1500<\/b>/);

    const body = (await b.get(page21([[`r${smartReport}_x_job`, 'Clerk'], [`r${smartReport}_rg_salary`, '|1500']]))).body;
    assert.deepEqual(names(body, smartReport).sort(), ['Adams', 'James', 'Miller', 'Smith']);
    assert.match(body, /<li class="chip sf-chip">Job: Clerk\s*<a href="\/a\/hr\/21\?r\d+_rg_salary=%7C1500" aria-label="Remove filter Job: Clerk">×<\/a>/);
    assert.match(body, /Salary: Below 1500/);
  });

  test('typing shows matching values; choosing one replaces the search term', async () => {
    const b = await king();
    const body = (await b.get(page21([[`r${smartReport}_q`, 'sale']]))).body;
    assert.match(body, /Filter on:/);
    assert.match(body, new RegExp(`href="/a/hr/21\\?r${smartReport}_x_job=Salesman">Job: <b>Salesman</b>`));
    assert.match(body, new RegExp(`href="/a/hr/21\\?r${smartReport}_x_department=SALES">Department: <b>SALES</b> <span class="facet-count">6</span>`));
    assert.match(body, /<b>sale<\/b>/, 'the search term is a chip');
    const none = (await b.get(page21([[`r${smartReport}_q`, 'zzzz']]))).body;
    assert.match(none, /No filter matches the search/);
  });

  test('the GET form keeps the other parameters and replaces the term', async () => {
    const b = await king();
    const body = (await b.get(page21([[`r${smartReport}_x_job`, 'Clerk'], [`r${smartReport}_q`, 'old']]))).body;
    const form = new RegExp(`<form id="sf${ids['Find employees']}"[^>]*>([\\s\\S]*?)</form>`).exec(body)![1];
    assert.match(form, new RegExp(`name="r${smartReport}_x_job" value="Clerk"`));
    assert.doesNotMatch(form, new RegExp(`name="r${smartReport}_q"`));
  });

  test('Dutch texts', async () => {
    const b = new Browser(app, { 'accept-language': 'nl-NL,nl;q=0.9' });
    await b.login('king');
    const body = (await b.get('/a/hr/21')).body;
    assert.match(body, /Voorgestelde filters:/);
    assert.match(body, /placeholder="Medewerkers zoeken of filteren…"/);
    assert.match(body, />Slimme filters</, 'tab names are translated');
    assert.match(body, />Alles tonen</);
  });
});

describe('region display selector (page 21)', () => {
  test('links to every tab; regions sharing a tab name are one tab; works without JavaScript', async () => {
    const b = await king();
    const body = (await b.get('/a/hr/21')).body;
    const nav = /<nav class="rds rds-tabs"[\s\S]*?<\/nav>/.exec(body)![0];
    assert.match(nav, /data-rds-all>Show all</);
    assert.match(nav, new RegExp(`href="#R${ids['Find employees']}" data-rds-target="R${ids['Find employees']} R${smartReport}">Smart filters<`));
    assert.match(nav, new RegExp(`data-rds-target="R${ids['Filter']} R${facetReport}">Faceted search<`));
    assert.match(nav, />Salaries</);
    assert.match(nav, /data-rds-remember/);
    // every region is rendered (JavaScript hides the other tabs)
    for (const id of Object.values(ids)) assert.match(body, new RegExp(`id="R${id}"`));
    assert.doesNotMatch(body, /rds-hidden/);
  });

  test('a region hidden by a condition has no tab; no members gives a hint', async () => {
    const chart = ids['Average salary by job'];
    try {
      await owner.query(`update meta.region set condition = 'false' where id = $1`, [chart]);
      const body = (await (await king()).get('/a/hr/21')).body;
      assert.doesNotMatch(body, />Salaries</);
      await owner.query(`update meta.region set config = config - 'display_selector' where page_id = (select page_id from meta.region where id = $1)`, [chart]);
      assert.match((await (await king()).get('/a/hr/21')).body, /No regions to choose from/);
    } finally {
      await owner.query(`update meta.region set condition = null, config = config || '{"display_selector": "Salaries"}' where id = $1`, [chart]);
      await owner.query(`update meta.region set config = config || '{"display_selector": "Smart filters"}' where id in ($1, $2)`, [ids['Find employees'], smartReport]);
      await owner.query(`update meta.region set config = config || '{"display_selector": "Faceted search"}' where id in ($1, $2)`, [ids['Filter'], facetReport]);
    }
  });

  test('select style', async () => {
    const sel = ids['Views'];
    try {
      await owner.query(`update meta.region set config = '{"style": "select", "show_all": false}' where id = $1`, [sel]);
      const body = (await (await king()).get('/a/hr/21')).body;
      assert.match(body, /<select class="rds-select">\s*<option value="0">Smart filters<\/option>/);
      assert.doesNotMatch(body, /Show all/);
    } finally {
      await owner.query(`update meta.region set config = '{}' where id = $1`, [sel]);
    }
  });
});

describe('builder settings (sprint 26)', () => {
  const allowed: Allowed = { pages: new Set([1]), lovs: new Set(), reports: new Map([[7, ['job', 'sal', 'hired', 'stars']]]) };

  test('ranges as text', () => {
    assert.deepEqual(parseRanges('..1000 = Low; 1000..3000; 3000..; 2020-01-01..2021-01-01; nonsense; ..; a..b; 1.5..2.5'), [
      { from: '', to: '1000', label: 'Low' }, { from: '1000', to: '3000' }, { from: '3000', to: '' },
      { from: '2020-01-01', to: '2021-01-01' }, { from: '1.5', to: '2.5' },
    ]);
    assert.equal(rangesText([{ to: 1000, label: 'Low' }, { from: 1000 }]), '..1000 = Low; 1000..');
  });

  test('facet types, ranges, from/to, exclude and the search field; other keys kept', () => {
    const out = mergeFacetsSettings({ report: 7, facets: [{ column: 'stars', max: 4, extra: 1 }] }, {
      report: '7', search: 'true', n: '4',
      col_0: 'job', on_0: 'true', exclude_0: 'true', type_0: 'checkbox', ranges_0: '1..2',
      col_1: 'sal', on_1: 'true', type_1: 'range', ranges_1: '..1000; 1000..', custom_1: 'true',
      col_2: 'hired', on_2: 'true', type_2: 'range',
      col_3: 'stars', on_3: 'true', type_3: 'star', exclude_3: 'true',
    }, allowed);
    assert.deepEqual(out, {
      report: 7, search: true,
      facets: [
        { column: 'job', exclude: true },
        { column: 'sal', type: 'range', ranges: [{ from: '', to: '1000' }, { from: '1000', to: '' }], custom: true },
        { column: 'hired', type: 'range', custom: false },
        { max: 4, extra: 1, column: 'stars', type: 'star' },
      ],
    });
    const again = mergeFacetsSettings(out, { report: '7', n: '1', col_0: 'hired', on_0: 'true', type_0: 'range', custom_0: 'true' }, allowed);
    assert.deepEqual(again, { report: 7, facets: [{ column: 'hired', type: 'range' }] }, 'defaults left out');
  });

  test('smart filters and display selector', () => {
    assert.deepEqual(mergeSmartFiltersSettings({ display_selector: 'Tab' }, { report: '7', n: '1', col_0: 'job', on_0: 'true', suggestions: '5', placeholder: ' Find… ' }, allowed),
      { display_selector: 'Tab', report: 7, facets: [{ column: 'job' }], suggestions: 5, placeholder: 'Find…' });
    assert.deepEqual(mergeSmartFiltersSettings({ suggestions: 5 }, { report: '7', suggestions: '3' }, allowed), { report: 7 });
    assert.deepEqual(mergeSmartFiltersSettings({}, { report: '7', suggestions: '99' }, allowed), { report: 7 });
    assert.deepEqual(mergeDisplaySelectorSettings({ x: 1 }, { style: 'select', remember: 'true' }), { x: 1, style: 'select', show_all: false });
    assert.deepEqual(mergeDisplaySelectorSettings({ style: 'select' }, { style: 'tabs', show_all: 'true', remember: 'true' }), {});
  });

  test('the designer forms save; the display selector marks the regions of its page only', async () => {
    const b = new Browser(app);
    await b.get('/builder/login');
    await b.submit('/builder/login', { username: 'admin', password: 'admin' });
    const sel = ids['Views'];
    const pid = (await owner.one('select page_id from meta.region where id = $1', [sel])).page_id;
    const other = (await owner.one(`select r.id, r.config from meta.region r join meta.page p on p.id = r.page_id join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 2 and r.type = 'report'`));
    const before = (await owner.query('select id, config from meta.region where page_id = $1', [pid])).rows;
    try {
      const form = (await b.get(`/builder/pages/${pid}?c=region-${sel}`)).body;
      assert.match(form, /Display selector settings/);
      assert.match(form, new RegExp(`name="tab_${smartReport}" maxlength="60" value="Smart filters"`));
      const res = await b.submit(`/builder/pages/${pid}/region/${sel}/settings`, {
        style: 'select', show_all: 'true', members: '1',
        [`member_${smartReport}`]: 'true', [`tab_${smartReport}`]: 'Mine', [`member_${facetReport}`]: 'true', [`member_${other.id}`]: 'true', [`tab_${other.id}`]: 'x',
      });
      assert.equal(res.statusCode, 303);
      const now = new Map((await owner.query('select id, config from meta.region where page_id = $1', [pid])).rows.map((r) => [r.id, r.config]));
      assert.deepEqual(now.get(sel), { style: 'select', remember: false });
      assert.equal(now.get(smartReport).display_selector, 'Mine');
      assert.equal(now.get(facetReport).display_selector, true);
      assert.equal(now.get(ids['Filter']).display_selector, undefined, 'unticked');
      assert.deepEqual((await owner.one('select config from meta.region where id = $1', [other.id])).config, other.config, 'another page is left alone');

      const sf = ids['Find employees'];
      assert.match((await b.get(`/builder/pages/${pid}?c=region-${sf}`)).body, /Smart filters settings/);
      assert.equal((await b.submit(`/builder/pages/${pid}/region/${sf}/settings`, { report: String(smartReport), n: '1', col_0: 'job', on_0: 'true', suggestions: '2' })).statusCode, 303);
      assert.deepEqual((await owner.one('select config from meta.region where id = $1', [sf])).config.facets, [{ column: 'job' }]);
    } finally {
      for (const r of before) await owner.query('update meta.region set config = $2 where id = $1', [r.id, JSON.stringify(r.config)]);
    }
  });
});
