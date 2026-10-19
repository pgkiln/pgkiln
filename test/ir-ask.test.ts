// (sprint 112) AI interactive reports: "Ask in your own words" turns a
// question into the report's own settings (filters, sort, group by, pivot,
// chart, highlights, aggregates, computed columns), shown as chips with Edit
// and Remove; Undo goes back. Without an AI service a rule-based parser reads
// the question (English, Dutch, German); with one, the AI mock answers.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';

const { buildApp } = await import('../src/app.ts');
const { closePools, owner } = await import('../src/db.ts');
const { encryptSecret } = await import('../src/secrets.ts');
const { parseQuestion, PHRASES } = await import('../src/runtime/ir-phrases.ts');
const { applyPlan, checkPlan, chipsOf, editChip, removeChip, planIsEmpty } = await import('../src/runtime/ir-plan.ts');
const { aiFilterOf, aiFilterProblems, planSchema } = await import('../src/runtime/ai-filter.ts');
const { Browser } = await import('./helpers.ts');
const { startAiMock } = await import('./ai-mock.ts');

type Col = { name: string; label: string; kind: 'number' | 'date' | 'text' | 'boolean'; pos: number; computed?: boolean };
const COLS: Col[] = [
  { name: 'empno', label: 'No.', kind: 'number', pos: 1 }, { name: 'ename', label: 'Name', kind: 'text', pos: 2 }, { name: 'job', label: 'Job', kind: 'text', pos: 3 },
  { name: 'department', label: 'Department', kind: 'text', pos: 4 }, { name: 'hiredate', label: 'Hiredate', kind: 'date', pos: 5 }, { name: 'sal', label: 'Salary', kind: 'number', pos: 6 },
  { name: 'comm', label: 'Comm', kind: 'number', pos: 7 }, { name: 'active', label: 'Active', kind: 'boolean', pos: 8 },
];
const VALUES: Record<string, string[]> = { job: ['CLERK', 'MANAGER', 'ANALYST', 'SALESMAN', 'PRESIDENT'], department: ['SALES', 'RESEARCH', 'ACCOUNTING'], ename: ['SMITH', 'KING'] };
const lookup = async (column: string | null, cands: string[]) => {
  let best: { column: string; value: string; candidate: string } | null = null;
  for (const [c, vs] of Object.entries(VALUES))
    if (!column || column === c) for (const v of vs) for (const k of cands) if (v.toLowerCase() === k && (!best || k.length > best.candidate.length)) best = { column: c, value: v, candidate: k };
  return best;
};
const parse = (q: string, lang = 'en') => parseQuestion(q, COLS, lang, lookup, '2026-10-19');

let app: FastifyInstance;
let mock: Awaited<ReturnType<typeof startAiMock>>;
let hrId: number;
let region: number;
let oldConfig: unknown;
const SERVICE = 'T_WS5_AI';

before(async () => {
  app = await buildApp({ logger: false });
  mock = await startAiMock();
  hrId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  const r = await owner.one(`select r.id, r.config from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 2 and r.type = 'report'`, [hrId]);
  region = r.id;
  oldConfig = r.config;
  await owner.query(`delete from meta.ai_service where name = $1`, [SERVICE]);
  const svc = (await owner.one(`insert into meta.ai_service (name, provider, model, base_url, api_key_enc, effort) values ($1, 'anthropic', 'claude-opus-5-5', $2, $3, 'medium') returning id`,
    [SERVICE, `${mock.base}/claude`, encryptSecret('sk-ant-ws5')])).id;
  await owner.query(`insert into meta.app_ai_service (app_id, service_id) values ($1, $2)`, [hrId, svc]);
});

after(async () => {
  await owner.query('update meta.region set config = $2 where id = $1', [region, JSON.stringify(oldConfig)]);
  await owner.query(`delete from meta.ai_service where name = $1`, [SERVICE]);
  await mock.close();
  await app.close();
  await closePools();
});

async function king() {
  const b = new Browser(app);
  await b.login('king');
  await b.get('/a/hr/2');
  return b;
}
const k = (x: string) => `r${region}_${x}`;
const at = (res: { headers: Record<string, unknown> }) => new URL(res.headers.location as string, 'http://x');
const chipCount = (body: string) => (body.match(/<li class="chip ask-chip">/g) ?? []).length;

describe('the phrase parser', () => {
  test('English: filters, sort, group by, aggregates, pivot, chart, highlights, computed columns, values', async () => {
    const cases: [string, unknown][] = [
      ['sum of salary by department where job is clerk', { filters: [{ column: 'job', operator: 'eq', value: 'CLERK' }], group_by: ['department'], group_functions: [{ function: 'sum', column: 'sal' }] }],
      ['salary over 3000', { filters: [{ column: 'sal', operator: 'gt', value: '3000' }] }],
      ['sort by hire date', { sort_column: 'hiredate', sort_descending: false }],
      ['sort by hire date, newest first', { sort_column: 'hiredate', sort_descending: true }],
      ['only clerks', { filters: [{ column: 'job', operator: 'eq', value: 'CLERK' }] }],
      ['only clerks hired after 1981', { filters: [{ column: 'job', operator: 'eq', value: 'CLERK' }, { column: 'hiredate', operator: 'gt', value: '1981-12-31' }] }],
      ['bonus is 10% of salary', { computed_columns: [{ name: 'bonus', expression: '0.1 * sal' }] }],
      ['highlight salary over 4000 in red', { highlights: [{ column: 'sal', operator: 'gt', value: '4000', color: 'red' }] }],
      ['count by department', { group_by: ['department'], group_functions: [{ function: 'count', column: 'empno' }] }],
      ['pie chart of count by department', { chart: { type: 'pie', label: 'department', function: 'count', value: 'empno' } }],
      ['pivot sum of salary by department and job', { pivot: { row: 'department', column: 'job', function: 'sum', value: 'sal' } }],
      ['salary between 1,000 and 3k', { filters: [{ column: 'sal', operator: 'ge', value: '1000' }, { column: 'sal', operator: 'le', value: '3000' }] }],
      ['no commission', { filters: [{ column: 'comm', operator: 'null', value: '' }] }],
      ['managers hired before june 1981, highest salary first', { filters: [{ column: 'job', operator: 'eq', value: 'MANAGER' }, { column: 'hiredate', operator: 'lt', value: '1981-06-01' }], sort_column: 'sal', sort_descending: true }],
      ['total salary', { aggregates: [{ function: 'sum', column: 'sal' }] }],
      ['not clerks', { filters: [{ column: 'job', operator: 'ne', value: 'CLERK' }] }],
      ['break by department', { control_break: 'department' }],
      ['start over', { reset: true }],
      ['name contains "Mi"', { filters: [{ column: 'ename', operator: 'contains', value: 'Mi' }] }],
      ['hired this year', { filters: [{ column: 'hiredate', operator: 'ge', value: '2026-01-01' }, { column: 'hiredate', operator: 'le', value: '2026-12-31' }] }],
    ];
    for (const [q, want] of cases) {
      const r = await parse(q);
      const got = Object.fromEntries(Object.entries(r.plan).filter(([, v]) => !(Array.isArray(v) && !v.length)));
      assert.deepEqual(got, want, q);
      assert.deepEqual(r.left, [], q);
    }
  });

  test('what is not understood is reported, not guessed', async () => {
    const r = await parse('the weather in spring');
    assert.equal(planIsEmpty(checkPlan(r.plan, COLS)), true);
    assert.deepEqual(r.left, ['the weather in spring']);
    const s = await parse('salary over 3000 and the moon');
    assert.deepEqual(s.plan.filters, [{ column: 'sal', operator: 'gt', value: '3000' }]);
    assert.deepEqual(s.left, ['the moon']);
  });

  test('Dutch and German phrase tables; English is always understood too', async () => {
    assert.deepEqual((await parse('som van salary per department waar job is clerk', 'nl')).plan.group_functions, [{ function: 'sum', column: 'sal' }]);
    assert.deepEqual((await parse('salary tussen 1.000 en 3.000', 'nl')).plan.filters, [{ column: 'sal', operator: 'ge', value: '1000' }, { column: 'sal', operator: 'le', value: '3000' }]);
    assert.deepEqual((await parse('sorteer op hiredate aflopend', 'nl')).plan.sort_descending, true);
    assert.deepEqual((await parse('nur clerks', 'de')).plan.filters, [{ column: 'job', operator: 'eq', value: 'CLERK' }]);
    assert.deepEqual((await parse('markiere salary über 4000 in rot', 'de')).plan.highlights, [{ column: 'sal', operator: 'gt', value: '4000', color: 'red' }]);
    assert.deepEqual((await parse('bonus ist 10% von salary', 'de')).plan.computed_columns, [{ name: 'bonus', expression: '0.1 * sal' }]);
    assert.deepEqual((await parse('salary over 3000', 'de')).plan.filters, [{ column: 'sal', operator: 'gt', value: '3000' }]);
    assert.deepEqual(Object.keys(PHRASES).sort(), ['de', 'en', 'nl']);
  });
});

describe('plans and chips', () => {
  test('a plan becomes the report\'s URL parameters; filters on a column replace that column\'s', () => {
    const p = new URLSearchParams('r9_f=job|eq|MANAGER&r9_f=sal|gt|1&r9_p=3&x=1');
    applyPlan(p, 9, checkPlan({ filters: [{ column: 'job', operator: 'eq', value: 'CLERK' }], group_by: ['department'], group_functions: [{ function: 'sum', column: 'sal' }], sort_column: 'sal', sort_descending: true }, COLS));
    assert.deepEqual(p.getAll('r9_f'), ['sal|gt|1', 'job|eq|CLERK']);
    assert.deepEqual(p.getAll('r9_g'), ['department']);
    assert.deepEqual(p.getAll('r9_ga'), ['sum|sal']);
    assert.equal(p.get('r9_v'), 'group');
    assert.equal(p.get('r9_s'), '6');
    assert.equal(p.get('r9_d'), 'desc');
    assert.equal(p.get('r9_p'), null);
    assert.equal(p.get('x'), '1');
    applyPlan(p, 9, checkPlan({ reset: true }, COLS));
    assert.equal(p.toString(), 'x=1');
  });

  test('computed columns: checked with the Compute validator, usable in the same answer', () => {
    const plan = checkPlan({ computed_columns: [{ name: 'bonus', expression: 'sal * 0.1' }, { name: 'evil', expression: 'sal); drop table x; --' }, { name: 'sal', expression: '1' }],
      filters: [{ column: 'bonus', operator: 'gt', value: '100' }], sort_column: 'bonus' }, COLS, 9);
    assert.deepEqual(plan.computed, [{ name: 'bonus', expr: 'sal * 0.1' }]);
    assert.deepEqual(plan.filters, [{ column: 'bonus', operator: 'gt', value: '100' }]);
    assert.equal(plan.sort?.pos, 10);
  });

  test('chips: one per setting, edited and removed one by one', () => {
    const p = new URLSearchParams('r9_f=job|eq|CLERK&r9_g=department&r9_ga=sum|sal&r9_v=group');
    const chips = chipsOf(p, 9);
    assert.deepEqual(chips.map((c) => c.kind), ['filter', 'group', 'groupfn']);
    editChip(p, 9, chips[0], { a: 'job', b: 'eq', c: 'MANAGER', d: '', e: '' }, COLS, () => 'x');
    assert.deepEqual(p.getAll('r9_f'), ['job|eq|MANAGER']);
    removeChip(p, 9, chipsOf(p, 9)[2]);
    assert.deepEqual(p.getAll('r9_ga'), []);
    assert.equal(p.get('r9_v'), 'group');
    removeChip(p, 9, chipsOf(p, 9)[1]);
    assert.equal(p.get('r9_v'), null, 'the last group column takes the view with it');
    assert.throws(() => editChip(p, 9, chipsOf(p, 9)[0], { a: 'job', b: 'eq', c: 'x', d: '', e: '' }, COLS.filter((c) => c.name !== 'job'), () => 'x'), /column job/);
  });

  test('config: {} is the built-in phrases, a service name is checked', () => {
    const r = (config: Record<string, unknown>) => ({ id: 1, type: 'report', config } as any);
    assert.ok(aiFilterOf(r({ ai_filter: {} })));
    assert.ok(aiFilterOf(r({ ai_filter: { service: 'X1' } })));
    assert.equal(aiFilterOf(r({ ai_filter: { service: 'x; drop' } })), null);
    assert.deepEqual(aiFilterProblems({}), []);
    assert.equal(aiFilterProblems({ service: 3 }).length, 1);
    const s: any = planSchema(COLS);
    assert.deepEqual(s.properties.group_by.items.enum, COLS.map((c) => c.name));
    assert.ok(s.required.includes('computed_columns'));
  });
});

describe('HR Demo employees: without an AI service', () => {
  test('"sum of salary by department where job is clerk" gives three chips that can be edited or removed one by one; Undo', async () => {
    const b = await king();
    let page = (await b.get('/a/hr/2')).body;
    assert.match(page, /class="ai-filter"/);
    let res = await b.submit(`/a/hr/2/report/${region}/ask`, { question: 'sum of salary by department where job is clerk', params: 'x=1' });
    assert.equal(res.statusCode, 303, res.body);
    let loc = at(res);
    assert.deepEqual(loc.searchParams.getAll(k('f')), ['job|eq|CLERK']);
    assert.deepEqual(loc.searchParams.getAll(k('g')), ['department']);
    assert.deepEqual(loc.searchParams.getAll(k('ga')), ['sum|sal']);
    assert.equal(loc.searchParams.get(k('v')), 'group');
    assert.equal(loc.searchParams.get('x'), '1');
    page = (await b.get(`${loc.pathname}${loc.search}`)).body;
    assert.equal(chipCount(page), 3, page);
    assert.match(page, /Job = CLERK/);
    assert.match(page, /Group by: Department/);
    assert.match(page, /Sum: Salary per group/);
    assert.match(page, /Applied: Job = CLERK; Group by: Department; Sum: Salary/);
    assert.match(page, /report-group/, 'the group by view shows');
    assert.doesNotMatch(page, /<div class="chips">/, 'no second chip row under the toolbar');
    assert.match(page, /name="undo"/);
    const params = loc.searchParams.toString();
    // edit the filter: job is manager
    res = await b.submit(`/a/hr/2/report/${region}/chips`, { params, k0: 'f:job|eq|CLERK', k1: 'g:department', k2: 'ga:sum|sal', edit: '0', e0_a: 'job', e0_b: 'eq', e0_c: 'MANAGER' });
    assert.equal(res.statusCode, 303);
    loc = at(res);
    assert.deepEqual(loc.searchParams.getAll(k('f')), ['job|eq|MANAGER']);
    // remove the sum
    res = await b.submit(`/a/hr/2/report/${region}/chips`, { params: loc.searchParams.toString(), k0: 'f:job|eq|MANAGER', k1: 'g:department', k2: 'ga:sum|sal', remove: '2' });
    loc = at(res);
    assert.deepEqual(loc.searchParams.getAll(k('ga')), []);
    assert.deepEqual(loc.searchParams.getAll(k('g')), ['department']);
    page = (await b.get(`${loc.pathname}${loc.search}`)).body;
    assert.equal(chipCount(page), 2);
    // remove the group by: the report view again
    res = await b.submit(`/a/hr/2/report/${region}/chips`, { params: loc.searchParams.toString(), k0: 'f:job|eq|MANAGER', k1: 'g:department', remove: '1' });
    loc = at(res);
    assert.equal(loc.searchParams.get(k('v')), null);
    page = (await b.get(`${loc.pathname}${loc.search}`)).body;
    assert.match(page, /JONES|BLAKE|CLARK/);
    assert.doesNotMatch(page, /SMITH/);
    // Undo: back to the group by, then to the sum, then before the question
    res = await b.submit(`/a/hr/2/report/${region}/chips`, { params: loc.searchParams.toString(), undo: '1' });
    assert.deepEqual(at(res).searchParams.getAll(k('g')), ['department']);
    res = await b.submit(`/a/hr/2/report/${region}/chips`, { params: '', undo: '1' });
    assert.deepEqual(at(res).searchParams.getAll(k('ga')), ['sum|sal']);
    res = await b.submit(`/a/hr/2/report/${region}/chips`, { params: '', undo: '1' });
    assert.deepEqual(at(res).searchParams.getAll(k('f')), ['job|eq|CLERK']);
    res = await b.submit(`/a/hr/2/report/${region}/chips`, { params: '', undo: '1' });
    assert.equal(at(res).search, '?x=1');
  });

  test('a computed column from a sentence, then used; a sort by it', async () => {
    const b = await king();
    let res = await b.submit(`/a/hr/2/report/${region}/ask`, { question: 'bonus is 10% of salary', params: '' });
    let loc = at(res);
    assert.deepEqual(loc.searchParams.getAll(k('c')), ['bonus|0.1 * sal']);
    res = await b.submit(`/a/hr/2/report/${region}/ask`, { question: 'bonus over 400, sort by bonus descending', params: loc.searchParams.toString() });
    loc = at(res);
    assert.deepEqual(loc.searchParams.getAll(k('f')), ['bonus|gt|400']);
    assert.equal(loc.searchParams.get(k('s')), '8');
    const page = (await b.get(`${loc.pathname}${loc.search}`)).body;
    assert.match(page, /bonus = 0.1 \* sal/);
    assert.match(page, /KING/);
    assert.doesNotMatch(page, /TURNER/);
  });

  test('nothing understood: a message with the words, the report unchanged', async () => {
    const b = await king();
    const res = await b.submit(`/a/hr/2/report/${region}/ask`, { question: 'what is the weather', params: `${k('f')}=job|eq|CLERK` });
    assert.deepEqual(at(res).searchParams.getAll(k('f')), ['job|eq|CLERK']);
    const page = (await b.get('/a/hr/2')).body;
    assert.match(page, /The question gave no report settings/);
    assert.match(page, /Not understood: what is the weather/);
  });

  test('a mistake in an edit is a message, not a change', async () => {
    const b = await king();
    const params = `${k('a')}=sum|sal`;
    let res = await b.submit(`/a/hr/2/report/${region}/chips`, { params, k0: 'a:sum|sal', edit: '0', e0_a: 'sum', e0_b: 'job' });
    assert.equal(res.statusCode, 303);
    assert.deepEqual(at(res).searchParams.getAll(k('a')), ['sum|sal']);
    assert.match((await b.get('/a/hr/2')).body, /Sum needs a column with numbers/);
    res = await b.submit(`/a/hr/2/report/${region}/chips`, { params: `${k('c')}=x|sal*2`, k0: 'c:x|sal*2', edit: '0', e0_a: 'x', e0_b: 'sal +' });
    assert.deepEqual(at(res).searchParams.getAll(k('c')), ['x|sal*2']);
  });

  test('the no-JavaScript chip form: buttons in one POST form, Edit as details', async () => {
    const b = await king();
    const page = (await b.get(`/a/hr/2?${k('f')}=job|eq|CLERK&${k('s')}=6&${k('d')}=desc`)).body;
    assert.match(page, new RegExp(`<form id="aic${region}" method="post" action="/a/hr/2/report/${region}/chips">`));
    assert.match(page, /<details class="ask-edit"><summary/);
    assert.match(page, /<button class="ask-chip-x" name="remove" value="1"/);
    assert.match(page, /sorted by Salary ↓/);
    assert.doesNotMatch(page, /style="/);
  });
});

describe('HR Demo employees: with an AI service (mock)', () => {
  test('the same question through the service gives the same three chips', async () => {
    await owner.query(`update meta.region set config = config || $2 where id = $1`, [region, JSON.stringify({ ai_filter: { service: SERVICE } })]);
    try {
      const b = await king();
      mock.answer = JSON.stringify({
        reset: false, filters: [{ column: 'job', operator: 'eq', value: 'CLERK' }], highlights: [], search: '', sort_column: '', sort_descending: false, control_break: '',
        aggregates: [], group_by: ['department', 'password'], group_functions: [{ function: 'sum', column: 'sal' }, { function: 'sum', column: 'job' }], pivot: null, chart: null, computed_columns: [],
      });
      const before = mock.seen.length;
      const res = await b.submit(`/a/hr/2/report/${region}/ask`, { question: 'sum of salary by department where job is clerk', params: '' });
      const loc = at(res);
      assert.deepEqual(loc.searchParams.getAll(k('f')), ['job|eq|CLERK']);
      assert.deepEqual(loc.searchParams.getAll(k('g')), ['department']);
      assert.deepEqual(loc.searchParams.getAll(k('ga')), ['sum|sal'], 'sum of a text column is dropped');
      const call = mock.seen[before];
      assert.equal(call.body.messages[0].content, 'sum of salary by department where job is clerk');
      assert.deepEqual(call.body.output_config.format.schema.properties.group_by.items.enum, ['empno', 'ename', 'job', 'department', 'hiredate', 'sal', 'active']);
      const page = (await b.get(`${loc.pathname}${loc.search}`)).body;
      assert.equal(chipCount(page), 3);
      // the current settings go with the next question
      mock.answer = JSON.stringify({ reset: false, filters: [], highlights: [], search: '', sort_column: 'sal', sort_descending: true, control_break: '', aggregates: [], group_by: [], group_functions: [], pivot: null, chart: { type: 'bar', label: 'job', function: 'avg', value: 'sal' }, computed_columns: [{ name: 'yearly', expression: 'sal * 12' }] });
      const res2 = await b.submit(`/a/hr/2/report/${region}/ask`, { question: 'and a chart of average salary per job', params: loc.searchParams.toString() });
      assert.match(mock.seen[mock.seen.length - 1].body.system, /current settings[^\n]*Job = CLERK/);
      const loc2 = at(res2);
      assert.equal(loc2.searchParams.get(k('ch')), 'bar|job|avg|sal');
      assert.equal(loc2.searchParams.get(k('v')), 'chart');
      assert.deepEqual(loc2.searchParams.getAll(k('c')), ['yearly|sal * 12']);
      assert.equal((await owner.one(`select source from meta.ai_usage where app_id = $1 order by id desc limit 1`, [hrId])).source, 'nl2ir');
    } finally {
      await owner.query('update meta.region set config = $2 where id = $1', [region, JSON.stringify(oldConfig)]);
    }
  });

  test('a disabled service: the built-in phrases answer instead', async () => {
    await owner.query(`update meta.region set config = config || $2 where id = $1`, [region, JSON.stringify({ ai_filter: { service: SERVICE } })]);
    await owner.query(`update meta.ai_service set enabled = false where name = $1`, [SERVICE]);
    try {
      const b = await king();
      const before = mock.seen.length;
      const res = await b.submit(`/a/hr/2/report/${region}/ask`, { question: 'salary over 3000', params: '' });
      assert.deepEqual(at(res).searchParams.getAll(k('f')), ['sal|gt|3000']);
      assert.equal(mock.seen.length, before, 'no call to the service');
    } finally {
      await owner.query(`update meta.ai_service set enabled = true where name = $1`, [SERVICE]);
      await owner.query('update meta.region set config = $2 where id = $1', [region, JSON.stringify(oldConfig)]);
    }
  });
});

describe('builder', () => {
  test('the report\'s settings offer the built-in phrases without an AI service', async () => {
    const b = new Browser(app);
    await b.get('/builder/login');
    await b.post('/builder/login', { __csrf: b.lastCsrf, username: 'admin', password: 'admin' });
    const pageId = (await owner.one('select page_id from meta.region where id = $1', [region])).page_id;
    const form = (await b.get(`/builder/pages/${pageId}?c=region-${region}`)).body;
    assert.match(form, /<option value="-" selected>Built-in phrases \(no AI\)<\/option>/);
    try {
      await b.submit(`/builder/pages/${pageId}/region/${region}/ai-filter`, { service: SERVICE.toLowerCase(), placeholder: 'Ask me' });
      assert.deepEqual((await owner.one('select config from meta.region where id = $1', [region])).config.ai_filter, { service: SERVICE, placeholder: 'Ask me' });
      await b.submit(`/builder/pages/${pageId}/region/${region}/ai-filter`, { service: '-' });
      assert.deepEqual((await owner.one('select config from meta.region where id = $1', [region])).config.ai_filter, {});
    } finally {
      await owner.query('update meta.region set config = $2 where id = $1', [region, JSON.stringify(oldConfig)]);
    }
  });
});
