// Search configurations and the search region (migration 080).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { likePattern, marked, searchConfigProblems, searchWords } from '../src/runtime/search.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
let pageId: number;
let region: number;

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  pageId = (await owner.one('select id from meta.page where app_id = $1 and page_no = 1', [appId])).id;
  await owner.query(`delete from meta.search_config where app_id = $1 and name like 'T_%'`, [appId]);
  await owner.query(
    `insert into meta.search_config (app_id, name, label, seq, source_type, source, searchable_columns, title_column, subtitle_column, description_column, badge_column, icon, link) values
       ($1, 'T_EMPLOYEES', 'Employees', 10, 'table', 'hr.emp', '{ename,job}', 'ename', 'job', null, 'deptno', 'user', '{"page": 3, "items": {"P3_EMPNO": "#EMPNO#"}}'),
       ($1, 'T_DEPARTMENTS', 'Departments', 20, 'sql', 'select deptno, dname, initcap(loc) as city, ''building'' as ic from hr.dept where :APP_USER is not null', '{dname,city}', 'dname', 'city', null, null, '#IC#', null),
       ($1, 'T_SHORTCUTS', 'Shortcuts', 30, 'list', 'HR_SHORTCUTS', '{}', null, null, null, null, 'link', null)`,
    [appId],
  );
  region = (await owner.one(
    `insert into meta.region (page_id, seq, title, type, config) values ($1, 999, 'Search', 'search', '{"configs": ["T_EMPLOYEES", "T_DEPARTMENTS", "T_SHORTCUTS"]}') returning id`,
    [pageId],
  )).id;
});

after(async () => {
  await owner.query('delete from meta.region where id = $1', [region]);
  await owner.query(`delete from meta.search_config where app_id = $1 and name like 'T_%'`, [appId]);
  await app.close();
  await closePools();
});

const results = (body: string) => /<div class="search-results" id="R\d+_results" aria-live="polite">([\s\S]*?)<\/div>\s*(?:<\/div>|<\/section>)/.exec(body)?.[1] ?? '';

describe('search configurations and the search region', () => {
  test('words, LIKE patterns, marking and configuration checks', () => {
    assert.deepEqual(searchWords('  clerk  Mil clerk '), ['clerk', 'Mil']);
    assert.equal(searchWords('a b c d e f g h i j').length, 8);
    assert.equal(likePattern('50%_a\\b'), '%50\\%\\_a\\\\b%');
    assert.equal(marked('MILLER', ['mil']).toString(), '<mark>MIL</mark>LER');
    assert.equal(marked('<b>Mil</b>', ['mil']).toString(), '&lt;b&gt;<mark>Mil</mark>&lt;/b&gt;');
    assert.deepEqual(searchConfigProblems({ source_type: 'table', source: 'x', title_column: 'name' }), []);
    assert.match(searchConfigProblems({ source_type: 'table', source: 'x', title_column: 'name; drop table x' }).join(), /not a column name/);
    assert.match(searchConfigProblems({ source_type: 'sql', source: 'delete from x', title_column: 'a' }).join(), /SELECT/);
    assert.match(searchConfigProblems({ source_type: 'table', source: 'x' }).join(), /title/);
  });

  test('the region searches its configurations: grouped results, marked words, links with a checksum', async () => {
    const b = new Browser(app);
    await b.login('king');
    const page = (await b.get('/a/hr/1')).body;
    assert.match(page, new RegExp(`<input type="search" id="R${region}_q" name="s${region}" value=""`));
    assert.equal(results(page).trim(), '', 'no search text: no results');

    const res = (await b.get(`/a/hr/1?s${region}=mil`)).body;
    const r = results(res);
    assert.match(r, /<h3>Employees<\/h3>/);
    assert.match(r, /<mark>MIL<\/mark>LER/);
    assert.match(r, /<a class="search-hit" href="\/a\/hr\/3\?P3_EMPNO=7934&amp;cs=[0-9a-f]+" data-dialog>/);
    assert.match(r, /<span class="badge-pill">10<\/span>/);
    assert.doesNotMatch(r, /Departments/, 'a configuration without results shows nothing');
    // every word must be found: CLERK and MIL → MILLER only
    const both = results((await b.get(`/a/hr/1?s${region}=${encodeURIComponent('clerk mil')}`)).body);
    assert.equal([...both.matchAll(/class="search-title"/g)].length, 1);
    // the SQL configuration (with a bind) and the icon from a column; the list (entries the user may see)
    const dept = results((await b.get(`/a/hr/1?s${region}=${encodeURIComponent('sales')}`)).body);
    assert.match(dept, /<h3>Departments<\/h3>[\s\S]*#building[\s\S]*<mark>SALES<\/mark>/);
    const list = results((await b.get(`/a/hr/1?s${region}=${encodeURIComponent('calendar')}`)).body);
    assert.match(list, /<h3>Shortcuts<\/h3>[\s\S]*href="\/a\/hr\/12"[\s\S]*Leave <mark>calendar<\/mark>/);
    // nothing found
    assert.match(results((await b.get(`/a/hr/1?s${region}=zzzz`)).body), /class="muted search-empty">Nothing found\./);
  });

  test('% and _ are literal; at most max_results per configuration, with a note', async () => {
    const b = new Browser(app);
    await b.login('king');
    assert.match(results((await b.get(`/a/hr/1?s${region}=${encodeURIComponent('%')}`)).body), /Nothing found/);
    await owner.query(`update meta.search_config set max_results = 2 where app_id = $1 and name = 'T_EMPLOYEES'`, [appId]);
    try {
      const r = results((await b.get(`/a/hr/1?s${region}=a`)).body);
      assert.equal([...r.split('<h3>Departments')[0].matchAll(/class="search-title"/g)].length, 2);
      assert.match(r, /Showing the first 2 rows\./);
    } finally {
      await owner.query(`update meta.search_config set max_results = 10 where app_id = $1 and name = 'T_EMPLOYEES'`, [appId]);
    }
  });

  test('a configuration that fails shows its error; the others still answer', async () => {
    await owner.query(`update meta.search_config set source = 'hr.no_such_table' where app_id = $1 and name = 'T_DEPARTMENTS'`, [appId]);
    try {
      const b = new Browser(app);
      await b.login('king');
      const r = results((await b.get(`/a/hr/1?s${region}=a`)).body);
      assert.match(r, /<h3>Employees<\/h3>/);
      assert.match(r, /<h3>Departments<\/h3><div class="alert alert-error"/);
    } finally {
      await owner.query(`update meta.search_config set source = 'select deptno, dname, initcap(loc) as city, ''building'' as ic from hr.dept where :APP_USER is not null' where app_id = $1 and name = 'T_DEPARTMENTS'`, [appId]);
    }
  });

  test('search as you type: the region endpoint answers with the results; a page item as the search field', async () => {
    const b = new Browser(app);
    await b.login('king');
    await b.get('/a/hr/1');
    const res = await b.get(`/a/hr/1/region/${region}?s${region}=king`);
    assert.equal(res.statusCode, 200);
    assert.match(JSON.parse(res.body).html, /<mark>KING<\/mark>/);
    // another region type is not served there
    const other = (await owner.one(`select id from meta.region where page_id = $1 and type = 'static' limit 1`, [pageId]))?.id;
    if (other) assert.equal((await b.get(`/a/hr/1/region/${other}`)).statusCode, 403);

    const item = (await owner.one(`insert into meta.item (page_id, seq, name, type) values ($1, 998, 'P1_FIND', 'text') returning id`, [pageId])).id;
    await owner.query(`update meta.region set config = config || '{"item": "P1_FIND"}' where id = $1`, [region]);
    try {
      const page = (await b.get('/a/hr/1')).body;
      assert.doesNotMatch(page, new RegExp(`name="s${region}"`), 'no field of its own');
      const csrf = b.lastCsrf;
      await b.post('/a/hr/1', { __csrf: csrf, P1_FIND: 'scott' });
      assert.match(results((await b.get('/a/hr/1')).body), /<mark>SCOTT<\/mark>/);
    } finally {
      await owner.query(`update meta.region set config = config - 'item' where id = $1`, [region]);
      await owner.query('delete from meta.item where id = $1', [item]);
    }
  });

  test('the Advisor plans each configuration with its columns, and checks the regions\' names', async () => {
    const { advise } = await import('../src/builder/advisor.ts');
    await owner.query(`insert into meta.search_config (app_id, name, label, source_type, source, title_column) values ($1, 'T_BAD', 'Bad', 'table', 'hr.emp', 'no_such_column')`, [appId]);
    await owner.query(`update meta.region set config = jsonb_set(config, '{configs}', config->'configs' || '["T_MISSING"]') where id = $1`, [region]);
    try {
      const { findings } = await advise(appId);
      assert.ok(findings.some((f) => f.entry?.kind === 'search_config' && /no_such_column/.test(f.message)), JSON.stringify(findings.filter((f) => f.entry?.kind === 'search_config')));
      assert.ok(findings.some((f) => /Search configuration T_MISSING doesn't exist/.test(f.message)));
      assert.ok(!findings.some((f) => f.entry?.kind === 'search_config' && /T_EMPLOYEES|Employees/.test(f.entry.label)), 'the good ones pass');
    } finally {
      await owner.query(`delete from meta.search_config where app_id = $1 and name = 'T_BAD'`, [appId]);
      await owner.query(`update meta.region set config = jsonb_set(config, '{configs}', (config->'configs') - 'T_MISSING') where id = $1`, [region]);
    }
  });

  test('exported and imported with the application', async () => {
    const doc = (await owner.one(`select meta.export_app('hr') as d`)).d;
    const names = doc.search_configs.map((c: any) => c.name);
    assert.ok(names.includes('T_EMPLOYEES') && names.includes('T_SHORTCUTS'));
    const copy = (await owner.one(`select meta.import_app($1::jsonb, 'hr-search-copy') as id`, [JSON.stringify(doc)])).id;
    try {
      const c = await owner.one(`select * from meta.search_config where app_id = $1 and name = 'T_EMPLOYEES'`, [copy]);
      assert.deepEqual(c.searchable_columns, ['ename', 'job']);
      assert.deepEqual(c.link, { page: 3, items: { P3_EMPNO: '#EMPNO#' } });
    } finally {
      await owner.query('delete from meta.app where id = $1', [copy]);
    }
  });
});
