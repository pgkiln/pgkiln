// App Builder quality tools: search, "where used" and the Advisor.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { advise, type Finding } from '../src/builder/advisor.ts';
import { appEntries, search, whereUsed } from '../src/builder/search.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
let pageId: number; // a scratch page full of mistakes

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  await owner.query(`delete from meta.page where app_id = $1 and page_no = 99`, [appId]);
  pageId = (await owner.one(`insert into meta.page (app_id, page_no, name) values ($1, 99, 'Advisor test') returning id`, [appId])).id;
  const region = async (title: string, source: string, extra: Record<string, unknown> = {}) => {
    const cols = ['page_id', 'title', 'type', 'source', ...Object.keys(extra)];
    const vals = [pageId, title, 'report', source, ...Object.values(extra)];
    return (await owner.one(`insert into meta.region (${cols.join(', ')}) values (${vals.map((_, i) => `$${i + 1}`).join(', ')}) returning id`, vals)).id;
  };
  await region('Bad column', 'select nope from hr.emp');
  await region('No grant', 'select password_hash from meta.account');
  await region('Slow', 'select pg_sleep(30) as x');
  await region('Bad condition', 'select 1 as x', { condition: ':P99_MISSING = ', authz: 'NO_SUCH_SCHEME', config: JSON.stringify({ link: { page: 404, items: { P99_GONE: '#x#' } } }) });
  await owner.query(`insert into meta.item (page_id, name, type, lov) values ($1, 'P99_PICK', 'select', 'LOV:NO_SUCH_LOV')`, [pageId]);
  await owner.query(`insert into meta.button (page_id, name, label, action, target_page) values ($1, 'GO', 'Go', 'redirect', 777)`, [pageId]);
  await owner.query(`insert into meta.validation (page_id, name, item_name, type, expression, message) values ($1, 'Bad regex', 'P99_PICK', 'regex', '(', 'x')`, [pageId]);
  await owner.query(
    `insert into meta.process (page_id, name, type, code) values
       ($1, 'Writes', 'sql', 'insert into hr.dept (deptno, dname, loc) values (99, ''ADVISOR'', ''X''); notify advisor_test'),
       ($1, 'Bad block', 'sql', 'do $$ begin perfrom 1; end $$')`,
    [pageId],
  );
});

after(async () => {
  await owner.query(`delete from meta.page where id = $1`, [pageId]);
  await app.close();
  await closePools();
});

const about = (findings: Finding[], label: string) => findings.filter((f) => f.entry?.label === label);

describe('Advisor', () => {
  let result: Awaited<ReturnType<typeof advise>>;
  before(async () => {
    const t = Date.now();
    result = await advise(appId);
    assert.ok(Date.now() - t < 10_000, 'nothing ran (pg_sleep(30) was only planned)');
  });

  test('the HR sample has no errors outside the scratch page', () => {
    const others = result.findings.filter((f) => f.severity === 'error' && f.entry?.pageNo !== 99);
    assert.deepEqual(others.map((f) => `${f.entry?.label}: ${f.message}`), []);
    assert.ok(result.checked > 40);
  });

  test('SQL errors, missing grants and invalid PL/pgSQL are found', () => {
    assert.match(about(result.findings, 'Bad column')[0]?.message ?? '', /column "nope" does not exist/);
    assert.match(about(result.findings, 'No grant')[0]?.message ?? '', /permission denied/);
    assert.ok(about(result.findings, 'Bad condition').some((f) => f.field === 'Server-side condition (SQL)' && /syntax error/.test(f.message)));
    assert.match(about(result.findings, 'Bad block')[0]?.message ?? '', /syntax error at or near "perfrom"/);
    assert.match(about(result.findings, 'Bad regex')[0]?.message ?? '', /Invalid regular expression/);
    const writes = about(result.findings, 'Writes');
    assert.equal(writes.length, 1, 'the insert plans fine');
    assert.equal(writes[0].severity, 'info');
    assert.match(writes[0].message, /Not checked.*notify advisor_test/);
  });

  test('references to things that do not exist', () => {
    const bad = about(result.findings, 'Bad condition').map((f) => f.message);
    assert.ok(bad.some((m) => /Authorization scheme NO_SUCH_SCHEME doesn't exist/.test(m)));
    assert.ok(bad.some((m) => /page 404, which doesn't exist/.test(m)));
    assert.ok(bad.some((m) => /item P99_GONE, which doesn't exist/.test(m)));
    assert.ok(bad.some((m) => /Item P99_MISSING doesn't exist/.test(m)));
    assert.ok(about(result.findings, 'P99_PICK').some((f) => /List of values NO_SUCH_LOV doesn't exist/.test(f.message)));
    assert.ok(about(result.findings, 'GO').some((f) => /Page 777 doesn't exist/.test(f.message)));
  });

  test('nothing was executed', async () => {
    assert.equal((await owner.one('select count(*)::int as n from hr.dept where deptno = 99')).n, 0);
  });
});

describe('search and where used', () => {
  test('search finds text in every kind of field, case-insensitively', async () => {
    const hits = search(await appEntries(appId), 'GIVE_RAISE');
    assert.ok(hits.some((h) => h.entry.kind === 'process' && /<mark>give_raise<\/mark>/.test(String(h.snippet))));
  });

  test('where used: items, lists of values, schemes and pages', async () => {
    const entries = await appEntries(appId);
    const labels = (hits: ReturnType<typeof whereUsed>) => hits.map((h) => `${h.entry.kind}:${h.entry.label}`);
    const empno = labels(whereUsed(entries, { type: 'item', name: 'P3_EMPNO' }));
    assert.ok(empno.includes('region:Employees'), 'link items in a report');
    assert.ok(empno.some((x) => x.startsWith('button:')), 'button conditions');
    assert.ok(!labels(whereUsed(entries, { type: 'item', name: 'P3_EMP' })).includes('region:Employees'), 'whole words only');
    assert.deepEqual(labels(whereUsed(entries, { type: 'lov', name: 'DEPARTMENTS' })).sort(), ['item:P26_DEPTNO', 'item:P2_DEPTNO', 'item:P3_DEPTNO']);
    assert.ok(whereUsed(entries, { type: 'authz', name: 'ADMIN' }).length > 0);
    assert.ok(labels(whereUsed(entries, { type: 'page', pageNo: 3 })).includes('region:Employees'));
  });

  test('the builder shows search results, the Advisor and "Used in"; developers only', async () => {
    const b = new Browser(app);
    assert.equal((await b.get(`/builder/apps/${appId}/search?q=x`)).statusCode, 302, 'sign-in first');
    assert.equal((await b.get(`/builder/apps/${appId}/advisor`)).statusCode, 302);
    await b.get('/builder/login');
    await b.submit('/builder/login', { username: 'admin', password: 'admin' });
    const res = await b.get(`/builder/apps/${appId}/search?q=${encodeURIComponent('<script>')}`);
    assert.equal(res.statusCode, 200);
    assert.doesNotMatch(res.body, /<script>/, 'the query is escaped');
    assert.match((await b.get(`/builder/apps/${appId}/search?q=give_raise`)).body, /<mark>give_raise<\/mark>/);
    const advisor = (await b.get(`/builder/apps/${appId}/advisor`)).body;
    assert.match(advisor, /column &quot;nope&quot; does not exist|column "nope" does not exist/);
    const lov = await owner.one(`select id from meta.lov where app_id = $1 and name = 'DEPARTMENTS'`, [appId]);
    assert.match((await b.get(`/builder/apps/${appId}/shared?c=lov-${lov.id}`)).body, /Used in \(3\)/);
    const item = await owner.one(`select i.id, i.page_id from meta.item i where i.page_id = (select id from meta.page where app_id = $1 and page_no = 3) and i.name = 'P3_EMPNO'`, [appId]);
    assert.match((await b.get(`/builder/pages/${item.page_id}?c=item-${item.id}`)).body, /Used in \(\d+\)/);
    assert.equal((await b.get('/builder/apps/999999/advisor')).statusCode, 404);
  });
});

describe('Top SQL', () => {
  test('lists the statements of the app role, sorted; resets them; explains when unavailable', async (t) => {
    const { topSql } = await import('../src/builder/top-sql.ts');
    const probe = await topSql('hr_app');
    if (!probe.ok && probe.reason === 'not_loaded') return t.skip('pg_stat_statements is not loaded by this server');
    assert.ok(probe.ok, JSON.stringify(probe));
    const user = new Browser(app);
    await user.login('king');
    for (let i = 0; i < 3; i++) await user.get('/a/hr/2');
    const top = await topSql('hr_app', 'calls');
    assert.ok(top.ok && top.rows.length > 0);
    if (top.ok) {
      assert.ok(top.rows.some((r) => /from hr\.emp/.test(r.query)), 'the report query is listed');
      assert.ok(top.rows.every((r, i) => i === 0 || r.calls <= top.rows[i - 1].calls), 'sorted by calls');
      assert.ok(top.rows.every((r) => !/password_hash|pgapex_authenticator/.test(r.query)));
    }
    assert.deepEqual(await topSql(null), { ok: false, reason: 'no_role' });

    const dev = new Browser(app);
    await dev.get('/builder/login');
    await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
    const page = (await dev.get(`/builder/apps/${appId}/top-sql?sort=mean`)).body;
    assert.match(page, /Top SQL/);
    assert.match(page, /hr\.emp/);
    assert.equal((await dev.submit(`/builder/apps/${appId}/top-sql/reset`, {})).statusCode, 303);
    const after = await topSql('hr_app');
    assert.ok(after.ok && after.rows.every((r) => !/from hr\.emp e/.test(r.query)), 'reset clears the role');
  });
});
