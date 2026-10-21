// (sprint 122, WS-5) "Ask in your own words" on faceted search and smart
// filters: a condition a facet on the page can hold sets that facet (values,
// excluded values, a custom range, stars) instead of a report filter, the
// facets are chips of the Ask box, and smart filters with "ask": true offer a
// typed phrase as one suggestion that sets the facets it names.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';

const { buildApp } = await import('../src/app.ts');
const { closePools, owner } = await import('../src/db.ts');
const { checkPlan, chipsOf, removeChip } = await import('../src/runtime/ir-plan.ts');
const { applyFacetSettings, clearFacets, facetSettings } = await import('../src/runtime/ask-facets.ts');
const { facetDefs } = await import('../src/runtime/facet-state.ts');
const { Browser } = await import('./helpers.ts');

type Col = { name: string; label: string; kind: 'number' | 'date' | 'text' | 'boolean'; pos: number };
const COLS: Col[] = [
  { name: 'job', label: 'Job', kind: 'text', pos: 3 }, { name: 'department', label: 'Department', kind: 'text', pos: 4 },
  { name: 'hiredate', label: 'Hiredate', kind: 'date', pos: 5 }, { name: 'sal', label: 'Salary', kind: 'number', pos: 6 },
  { name: 'rating', label: 'Rating', kind: 'number', pos: 7 }, { name: 'ename', label: 'Name', kind: 'text', pos: 2 },
];
const defs = (facets: unknown[]) => new Map(facetDefs({ facets }).map((f) => [f.column, f]));
const DEFS = defs([
  { column: 'job', exclude: true }, { column: 'department' }, { column: 'sal', type: 'range', custom: true, ranges: [{ to: 1500 }] },
  { column: 'hiredate', type: 'range', ranges: [{ to: '1982-01-01' }], custom: true }, { column: 'rating', type: 'star', max: 5 },
]);
const plan = (filters: { column: string; operator: string; value: string }[]) => checkPlan({ filters }, COLS);

describe('conditions a facet can hold', () => {
  test('values, excluded values, a custom range and stars move to the facets; the rest stays a report filter', () => {
    const p = plan([
      { column: 'job', operator: 'eq', value: 'CLERK' }, { column: 'job', operator: 'eq', value: 'ANALYST' },
      { column: 'sal', operator: 'ge', value: '1000' }, { column: 'sal', operator: 'le', value: '3000' },
      { column: 'ename', operator: 'contains', value: 'MI' },
    ]);
    const s = facetSettings(p, DEFS, COLS);
    assert.deepEqual(s, [
      { column: 'job', kind: 'values', values: ['CLERK', 'ANALYST'], exclude: false },
      { column: 'sal', kind: 'range', from: '1000', to: '3000', custom: true },
    ]);
    assert.deepEqual(p.filters, [{ column: 'ename', operator: 'contains', value: 'MI' }]);
    const stars = plan([{ column: 'rating', operator: 'ge', value: '4' }]);
    s.push(...facetSettings(stars, DEFS, COLS));
    assert.deepEqual(s[2], { column: 'rating', kind: 'range', from: '4', to: '', custom: false });
    const params = new URLSearchParams('r9_p=2&r9_x_job=MANAGER&keep=1');
    applyFacetSettings(params, 9, s);
    assert.deepEqual(params.getAll('r9_x_job'), ['CLERK', 'ANALYST']);
    assert.equal(params.get('r9_rg_sal'), '~');
    assert.equal(params.get('r9_rf_sal'), '1000');
    assert.equal(params.get('r9_rt_sal'), '3000');
    assert.equal(params.get('r9_rg_rating'), '4|');
    assert.equal(params.get('r9_p'), null, 'back to the first page');
    assert.equal(params.get('keep'), '1');
    clearFacets(params, 9);
    assert.equal(params.toString(), 'keep=1');
  });

  test('not: only where the facet allows exclude; strict bounds, contains and unknown columns stay report filters', () => {
    let p = plan([{ column: 'job', operator: 'ne', value: 'CLERK' }, { column: 'department', operator: 'ne', value: 'SALES' }]);
    assert.deepEqual(facetSettings(p, DEFS, COLS), [{ column: 'job', kind: 'values', values: ['CLERK'], exclude: true }]);
    assert.deepEqual(p.filters, [{ column: 'department', operator: 'ne', value: 'SALES' }], 'department has no exclude');
    p = plan([{ column: 'sal', operator: 'gt', value: '3000' }, { column: 'job', operator: 'contains', value: 'CLE' }, { column: 'rating', operator: 'ge', value: '9' }]);
    assert.deepEqual(facetSettings(p, DEFS, COLS), []);
    assert.equal(p.filters.length, 3);
    // a range facet without custom ranges, and a bound that isn't a number
    p = plan([{ column: 'sal', operator: 'ge', value: '1000' }]);
    assert.deepEqual(facetSettings(p, defs([{ column: 'sal', type: 'range', ranges: [{ to: 1500 }] }]), COLS), []);
    p = plan([{ column: 'sal', operator: 'ge', value: '1e9; drop table x' }]);
    assert.deepEqual(facetSettings(p, DEFS, COLS), []);
    // dates: a custom range of days
    p = plan([{ column: 'hiredate', operator: 'ge', value: '1981-01-01' }, { column: 'hiredate', operator: 'le', value: '1981-12-31' }]);
    assert.deepEqual(facetSettings(p, DEFS, COLS), [{ column: 'hiredate', kind: 'range', from: '1981-01-01', to: '1981-12-31', custom: true }]);
  });

  test('the facets are chips (Remove only)', () => {
    const params = new URLSearchParams('r9_x_job=CLERK&r9_x_job=ANALYST&r9_xn_job=1&r9_rg_sal=~&r9_rf_sal=1000&r9_f=ename|contains|MI');
    const chips = chipsOf(params, 9, DEFS);
    assert.deepEqual(chips.map((c) => c.key), ['f:ename|contains|MI', 'fx:job:CLERK', 'fx:job:ANALYST', 'fr:sal:1000|']);
    assert.deepEqual(chipsOf(params, 9).map((c) => c.key), ['f:ename|contains|MI'], 'without facets on the page: none');
    removeChip(params, 9, chips[1]);
    assert.deepEqual(params.getAll('r9_x_job'), ['ANALYST']);
    assert.equal(params.get('r9_xn_job'), '1');
    removeChip(params, 9, chipsOf(params, 9, DEFS)[1]);
    assert.equal(params.get('r9_x_job'), null);
    assert.equal(params.get('r9_xn_job'), null, 'the last value takes exclude with it');
    removeChip(params, 9, chipsOf(params, 9, DEFS)[1]);
    assert.equal(params.toString(), 'r9_f=ename%7Ccontains%7CMI');
  });
});

describe('HR Demo employees with smart filters', () => {
  let app: FastifyInstance;
  let report: number;
  let smart: number;
  before(async () => {
    app = await buildApp({ logger: false });
    const r = await owner.one<{ id: number; page_id: number }>(`select r.id, r.page_id from meta.region r join meta.page p on p.id = r.page_id join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 2 and r.type = 'report' and r.config ? 'ai_filter'`);
    report = r!.id;
    smart = (await owner.one<{ id: number }>(`insert into meta.region (page_id, seq, title, type, config) values ($1, 1, 'Filter', 'smart_filters', $2) returning id`, [r!.page_id, JSON.stringify({
      report, ask: true, facets: [{ column: 'job', exclude: true }, { column: 'department' }, { column: 'sal', label: 'Salary', type: 'range', custom: true, ranges: [{ to: 1500 }, { from: 1500 }] }],
    })]))!.id;
  });
  after(async () => {
    await owner.query('delete from meta.region where id = $1', [smart]);
    await app.close();
    await closePools();
  });
  const k = (x: string) => `r${report}_${x}`;
  const at = (res: { headers: Record<string, unknown> }) => new URL(res.headers.location as string, 'http://x');

  test('Ask: "clerks in sales with salary between 900 and 3000" sets the facets, not report filters; Undo', async () => {
    const b = new Browser(app);
    await b.login('king');
    await b.get('/a/hr/2');
    const res = await b.submit(`/a/hr/2/report/${report}/ask`, { question: 'clerks in sales with salary between 900 and 3000', params: 'x=1' });
    assert.equal(res.statusCode, 303, res.body);
    const loc = at(res);
    assert.deepEqual(loc.searchParams.getAll(k('x_job')), ['CLERK']);
    assert.deepEqual(loc.searchParams.getAll(k('x_department')), ['SALES']);
    assert.equal(loc.searchParams.get(k('rf_sal')), '900');
    assert.equal(loc.searchParams.get(k('rt_sal')), '3000');
    assert.deepEqual(loc.searchParams.getAll(k('f')), [], 'no report filters');
    const page = (await b.get(`${loc.pathname}${loc.search}`)).body;
    assert.match(page, /JAMES/, 'the clerk in sales');
    assert.doesNotMatch(page, /SMITH/, 'a clerk in research');
    assert.match(page, /class="chip ask-chip"><span class="ask-chip-text">Job: CLERK/);
    assert.match(page, /class="chip sf-chip">Salary: 900 – 3000/, 'the smart filters show the range');
    assert.match(page, /Applied: Job: CLERK; Department: SALES; Salary: 900 – 3000/);
    // Remove the job chip through the Ask chip form
    const params = loc.searchParams.toString();
    const keys = [...page.matchAll(/name="k(\d+)" value="([^"]+)"/g)].map((m) => [m[1], m[2].replace(/&#124;|&amp;#124;/g, '|')]);
    const job = keys.find(([, v]) => v === 'fx:job:CLERK');
    assert.ok(job, JSON.stringify(keys));
    const removed = await b.submit(`/a/hr/2/report/${report}/chips`, { params, ...Object.fromEntries(keys.map(([i, v]) => [`k${i}`, v])), remove: job![0] });
    assert.deepEqual(at(removed).searchParams.getAll(k('x_job')), []);
    assert.deepEqual(at(removed).searchParams.getAll(k('x_department')), ['SALES']);
    // a tampered chip key is refused
    const bad = await b.submit(`/a/hr/2/report/${report}/chips`, { params, k0: 'fx:job:KING', remove: '0' });
    assert.equal(bad.statusCode, 403);
    // Undo returns to before the question
    const undo = await b.submit(`/a/hr/2/report/${report}/chips`, { params: '', undo: '1' });
    assert.equal(at(undo).searchParams.getAll(k('x_job')).length, 1, 'before the removal');
  });

  test('smart filters with "ask": the typed phrase is offered as one suggestion that sets the facets', async () => {
    const b = new Browser(app);
    await b.login('king');
    const page = (await b.get(`/a/hr/2?${k('q')}=${encodeURIComponent('not clerks with salary at least 2000')}`)).body;
    assert.match(page, /Understood as:/);
    const href = page.match(/sf-understood[\s\S]*?href="([^"]+)"/)?.[1]?.replace(/&amp;/g, '&');
    assert.ok(href, page);
    assert.match(page, /Job: not CLERK · Salary: 2000 or more|Job: not CLERK · Salary: at least 2000/);
    const u = new URL(href!, 'http://x');
    assert.deepEqual(u.searchParams.getAll(k('x_job')), ['CLERK']);
    assert.equal(u.searchParams.get(k('xn_job')), '1');
    assert.equal(u.searchParams.get(k('rf_sal')), '2000');
    assert.equal(u.searchParams.get(k('q')), null, 'the term is replaced');
    const filtered = (await b.get(`${u.pathname}${u.search}`)).body;
    assert.match(filtered, /KING/);
    assert.doesNotMatch(filtered, /MILLER/, 'a clerk');
    // a plain value is the ordinary matching suggestion, not a second chip; without "ask" no phrase
    assert.doesNotMatch((await b.get(`/a/hr/2?${k('q')}=clerk`)).body, /Understood as:/);
    await owner.query(`update meta.region set config = config - 'ask' where id = $1`, [smart]);
    assert.doesNotMatch((await b.get(`/a/hr/2?${k('q')}=${encodeURIComponent('not clerks with salary at least 2000')}`)).body, /Understood as:/);
    await owner.query(`update meta.region set config = config || '{"ask": true}' where id = $1`, [smart]);
  });
});
