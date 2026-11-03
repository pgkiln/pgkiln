// Sprint 135 (AP-2): full-text search configurations (migration 135). Search type fulltext: websearch_to_tsquery,
// ts_rank_cd order, ts_headline highlights; the text search configuration; "Did you mean" with pg_trgm; the report
// search on a tsvector column; the Advisor's GIN index check; Table Properties › Add full-text search; export.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { headlined, searchConfigProblems, textSearchConfig, tsConfigFor, tsvectorSql } from '../src/runtime/search.ts';
import { fulltextDdl } from '../src/builder/fulltext.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
let pageId: number;
let region: number;
let report: number;
const S = 'fts135';

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  pageId = (await owner.one('select id from meta.page where app_id = $1 and page_no = 1', [appId])).id;
  await owner.query(`drop schema if exists ${S} cascade; create schema ${S}; grant usage on schema ${S} to hr_app;
    create table ${S}.product (id int primary key, name text not null, description text,
      search_vector tsvector generated always as (setweight(to_tsvector('english', name), 'A') || setweight(to_tsvector('english', coalesce(description, '')), 'B')) stored);
    create index product_search_vector_idx on ${S}.product using gin (search_vector);
    insert into ${S}.product (id, name, description) values
      (1, 'Trail runner', 'Light shoes for running on rough trails, with a grippy sole.'),
      (2, 'Running shoes', 'Our best running shoes: cushioned shoes for the daily run.'),
      (3, 'Shoe polish', 'Keeps leather shoes shiny.'),
      (4, 'Run tracker', 'A watch that counts your steps.'),
      (5, 'Shoe sale', 'Every shoe for the run at half price.');
    create table ${S}.note (id int primary key, body text, body_vector tsvector);
    grant select on ${S}.product, ${S}.note to hr_app;`);
  await owner.query(`delete from meta.search_config where app_id = $1 and name like 'FTS135_%'`, [appId]);
  await owner.query(
    `insert into meta.search_config (app_id, name, label, seq, source_type, source, search_type, fts_vector, fts_config, title_column, description_column, searchable_columns, did_you_mean) values
       ($1, 'FTS135_PRODUCTS', 'Products', 10, 'table', '${S}.product', 'fulltext', 'search_vector', 'english', 'name', 'description', '{}', true),
       ($1, 'FTS135_BUILT', 'Built', 20, 'sql', 'select id, name, description from ${S}.product where id <> 5', 'fulltext', null, null, 'name', 'description', '{name,description}', false)`,
    [appId],
  );
  region = (await owner.one(
    `insert into meta.region (page_id, seq, title, type, config) values ($1, 999, 'Search', 'search', '{"configs": ["FTS135_PRODUCTS"]}') returning id`, [pageId])).id;
  report = (await owner.one(
    `insert into meta.region (page_id, seq, title, type, source, config) values ($1, 998, 'Products report', 'report', 'select id, name, search_vector from ${S}.product order by id', '{"hidden": ["search_vector"], "fulltext": "search_vector"}') returning id`,
    [pageId])).id;
});

after(async () => {
  await owner.query('delete from meta.region where id = any($1)', [[region, report]]);
  await owner.query(`delete from meta.search_config where app_id = $1 and name like 'FTS135_%'`, [appId]);
  await owner.query(`drop schema if exists ${S} cascade`);
  await app.close();
  await closePools();
});

const results = (body: string) => /<div class="search-results" id="R\d+_results" aria-live="polite">([\s\S]*?)<\/div>\s*(?:<\/div>|<\/section>)/.exec(body)?.[1] ?? '';
const titles = (r: string) => [...r.matchAll(/<span class="search-title">([\s\S]*?)<\/span>/g)].map((m) => m[1].replace(/<\/?mark>/g, ''));
const king = async () => {
  const b = new Browser(app);
  await b.login('king');
  return b;
};
const search = async (b: Browser, text: string, conf = region) => results((await b.get(`/a/hr/1?s${conf}=${encodeURIComponent(text)}`)).body);

describe('sprint 135 AP-2: full-text search configurations', () => {
  test('helpers: headlines escaped, languages, the tsvector, checks', () => {
    assert.equal(String(headlined('a run <b>&</b>')), 'a <mark>run</mark> &lt;b&gt;&amp;&lt;/b&gt;');
    assert.equal(String(headlined('stray  and  markers')), 'stray  and  markers');
    assert.equal(tsConfigFor('nl'), 'dutch');
    assert.equal(tsConfigFor('de-AT'), 'german');
    assert.equal(tsConfigFor('ja'), 'simple');
    assert.equal(tsvectorSql({ fts_vector: 'search_vector', searchable_columns: [], title_column: 'a', subtitle_column: null, description_column: null }, '$1'), 't."search_vector"');
    assert.equal(tsvectorSql({ fts_vector: null, searchable_columns: ['a', 'b'], title_column: 'a', subtitle_column: null, description_column: null }, '$1'),
      `to_tsvector($1, coalesce(t."a"::text, '') || ' ' || coalesce(t."b"::text, ''))`);
    assert.deepEqual(searchConfigProblems({ source_type: 'table', source: 'x', title_column: 'a', search_type: 'fulltext', fts_config: 'english' }), []);
    assert.match(searchConfigProblems({ source_type: 'list', source: 'L', search_type: 'fulltext' }).join(), /table or SQL/);
    assert.match(searchConfigProblems({ source_type: 'table', source: 'x', title_column: 'a', search_type: 'fulltext', fts_config: "english'" }).join(), /text search configuration/);
    assert.match(searchConfigProblems({ source_type: 'table', source: 'x', title_column: 'a', search_type: 'semantic' as never }).join(), /search type/);
    assert.match(searchConfigProblems({ source_type: 'table', source: 'x', title_column: 'a', search_type: 'fulltext', fts_vector: 'v; drop table x' }).join(), /one column/);
  });

  test('the text search configuration: asked for, else the language\'s, else simple; only names in pg_ts_config', async () => {
    assert.equal(await textSearchConfig(owner, 'dutch', 'en'), 'dutch');
    assert.equal(await textSearchConfig(owner, null, 'de'), 'german');
    assert.equal(await textSearchConfig(owner, 'no_such_config', 'en'), 'english');
    assert.equal(await textSearchConfig(owner, "english'; drop table x; --", 'xx'), 'simple');
  });

  test("'running shoes' finds run and shoe, the best match first, the matched words highlighted", async () => {
    const b = await king();
    const r = await search(b, 'running shoes');
    assert.match(r, /<h3>Products<\/h3>/);
    const found = titles(r);
    assert.deepEqual(found.slice(0, 1), ['Running shoes'], found.join(' | '));
    assert.deepEqual(new Set(found), new Set(['Running shoes', 'Trail runner', 'Shoe sale']), 'stemmed: shoe and run count, polish and the tracker do not');
    assert.match(r, /<span class="search-title"><mark>Running<\/mark> <mark>shoes<\/mark><\/span>/);
    assert.match(r, /<span class="search-description">[^<]*<mark>shoe<\/mark> for the <mark>run<\/mark>/);
    // web search syntax: a phrase, or, -word
    assert.deepEqual(titles(await search(b, '"daily run"')), ['Running shoes']);
    assert.deepEqual(new Set(titles(await search(b, 'polish or watch'))), new Set(['Shoe polish', 'Run tracker']));
    assert.deepEqual(new Set(titles(await search(b, 'shoe -polish -sale'))), new Set(['Running shoes', 'Trail runner']));
  });

  test('a tsvector built from the searchable columns, in the application language\'s configuration (english)', async () => {
    const b = await king();
    await owner.query(`update meta.region set config = '{"configs": ["FTS135_BUILT"]}' where id = $1`, [region]);
    try {
      const found = titles(await search(b, 'runs'));
      assert.deepEqual(new Set(found), new Set(['Running shoes', 'Trail runner', 'Run tracker']));
    } finally {
      await owner.query(`update meta.region set config = '{"configs": ["FTS135_PRODUCTS"]}' where id = $1`, [region]);
    }
  });

  test('did you mean: nothing without pg_trgm; with it, the closest words as a link', async () => {
    const b = await king();
    const installed = !!(await owner.one(`select 1 as x from pg_extension where extname = 'pg_trgm'`));
    const before = await search(b, 'runnning shoos');
    assert.match(before, /Nothing found\./);
    if (!installed) {
      assert.doesNotMatch(before, /search-suggestion/, 'no pg_trgm: no suggestion, no error');
      const can = await owner.query(`create extension pg_trgm schema ${S}`).then(() => true, () => false);
      if (!can) return;
      await owner.query(`grant usage on schema ${S} to public`);
    }
    try {
      const r = await search(b, 'runnning shoos');
      assert.match(r, new RegExp(`<p class="muted search-suggestion">Did you mean: <a href="/a/hr/1\\?s${region}=running\\+shoes?">running shoes?</a></p>`));
      assert.doesNotMatch(await search(b, 'qqqqqq'), /search-suggestion/, 'nothing close: nothing suggested');
      // a configuration that does not ask for it suggests nothing
      await owner.query(`update meta.search_config set did_you_mean = false where app_id = $1 and name = 'FTS135_PRODUCTS'`, [appId]);
      assert.doesNotMatch(await search(b, 'runnning shoos'), /search-suggestion/);
    } finally {
      await owner.query(`update meta.search_config set did_you_mean = true where app_id = $1 and name = 'FTS135_PRODUCTS'`, [appId]);
      if (!installed) await owner.query('drop extension if exists pg_trgm');
    }
  });

  test('a report search also uses the source\'s tsvector column (named in the attributes, even hidden)', async () => {
    const b = await king();
    const rows = async (q: string) => [...(await b.get(`/a/hr/1?r${report}_q=${encodeURIComponent(q)}`)).body.split(`Products report`).slice(1).join('').matchAll(/<td[^>]*>(Trail runner|Running shoes|Shoe polish|Run tracker|Shoe sale)<\/td>/g)].map((m) => m[1]);
    // "runs" is in no name: only full-text search (run) finds them
    assert.deepEqual(new Set(await rows('runs')), new Set(['Trail runner', 'Running shoes', 'Run tracker', 'Shoe sale']));
    // the pattern search still works (part of a word)
    assert.deepEqual(await rows('polis'), ['Shoe polish']);
    // a hidden tsvector column the attributes don't name is not used
    await owner.query(`update meta.region set config = config - 'fulltext' where id = $1`, [report]);
    try {
      assert.deepEqual(await rows('runs'), []);
    } finally {
      await owner.query(`update meta.region set config = config || '{"fulltext": "search_vector"}' where id = $1`, [report]);
    }
  });

  test('the Advisor warns when the tsvector has no GIN index, and checks the configuration', async () => {
    const { advise } = await import('../src/builder/advisor.ts');
    await owner.query(
      `insert into meta.search_config (app_id, name, label, source_type, source, search_type, fts_vector, fts_config, title_column) values
         ($1, 'FTS135_NOIDX', 'No index', 'table', '${S}.note', 'fulltext', 'body_vector', 'english', 'body'),
         ($1, 'FTS135_BADCFG', 'Bad config', 'table', '${S}.product', 'fulltext', 'search_vector', 'klingon', 'name'),
         ($1, 'FTS135_NOTTSV', 'Not a tsvector', 'table', '${S}.product', 'fulltext', 'name', null, 'name')`, [appId]);
    try {
      const { findings } = await advise(appId);
      const of = (label: string) => findings.filter((f) => f.entry?.kind === 'search_config' && f.entry.label.includes(label));
      assert.ok(of('FTS135_NOIDX').some((f) => f.severity === 'warning' && /body_vector has no GIN index/.test(f.message)), JSON.stringify(of('FTS135_NOIDX')));
      assert.ok(of('FTS135_BADCFG').some((f) => f.severity === 'error' && /klingon doesn't exist/.test(f.message)));
      assert.ok(of('FTS135_NOTTSV').some((f) => f.severity === 'error'), JSON.stringify(of('FTS135_NOTTSV')));
      assert.deepEqual(of('FTS135_PRODUCTS'), [], 'a tsvector column with a GIN index passes');
      assert.ok(of('FTS135_BUILT').every((f) => f.severity !== 'error'));
      await owner.query(`create index note_body_vector_idx on ${S}.note using gin (body_vector)`);
      assert.deepEqual((await advise(appId)).findings.filter((f) => f.entry?.kind === 'search_config' && f.entry.label.includes('FTS135_NOIDX')), []);
    } finally {
      await owner.query(`delete from meta.search_config where app_id = $1 and name in ('FTS135_NOIDX', 'FTS135_BADCFG', 'FTS135_NOTTSV')`, [appId]);
    }
  });

  test('Table Properties › Add full-text search: preview, apply in one transaction, recorded in the change log', async () => {
    const b = new Browser(app);
    await b.get('/builder/login');
    assert.equal((await b.submit('/builder/login', { username: 'admin', password: 'admin' })).statusCode, 303);
    await owner.query(`create table ${S}.article (id int primary key, title text, body varchar(2000), n int)`);
    const ref = `${S}.article`;
    const form = (await b.get(`/builder/sql/objects/fulltext?o=${ref}`)).body;
    assert.match(form, /<h1 class="u-mb1">Full-text search on fts135\.article<\/h1>/);
    assert.match(form, /name="c\.0\.name" value="title"/);
    assert.match(form, /name="c\.1\.name" value="body"/);
    assert.doesNotMatch(form, /value="n"/, 'only text columns');
    assert.match(form, /<option selected>english<\/option>/);
    assert.match((await b.get(`/builder/sql/objects/table?o=${ref}`)).body, /href="\/builder\/sql\/objects\/fulltext\?o=fts135\.article"/);
    const post = { o: ref, 'c.0.name': 'title', 'c.0.use': 'on', 'c.0.w': 'A', 'c.1.name': 'body', 'c.1.use': 'on', 'c.1.w': 'B', config: 'english', column: 'search_vector', index: 'article_search_vector_idx' };
    const preview = (await b.submit('/builder/sql/objects/fulltext', { ...post, mode: 'preview' })).body;
    assert.ok(preview.includes(fulltextDdl(ref, 'search_vector', 'article_search_vector_idx', 'english', [{ name: 'title', weight: 'A' }, { name: 'body', weight: 'B' }])[0].replace(/'/g, '&#39;')), String(preview.match(/<pre[\s\S]*?<\/pre>/)?.[0]));
    assert.match(preview, /create index article_search_vector_idx on fts135\.article using gin \(search_vector\);/);
    assert.equal((await owner.one(`select count(*)::int as n from pg_attribute where attrelid = '${ref}'::regclass and attname = 'search_vector'`)).n, 0, 'a preview changes nothing');
    const changes = (await owner.one(`select count(*)::int as n from meta.change_set`)).n;
    const applied = await b.submit('/builder/sql/objects/fulltext', { ...post, mode: 'apply' });
    assert.equal(applied.statusCode, 303);
    assert.equal(applied.headers.location, `/builder/sql/objects/table?o=${ref}`);
    await owner.query(`insert into ${ref} values (1, 'Running shoes', 'for the daily run', 3)`);
    assert.equal((await owner.one(`select count(*)::int as n from ${ref} where search_vector @@ websearch_to_tsquery('english', 'shoe runs')`)).n, 1);
    assert.equal((await owner.one(`select indexdef from pg_indexes where schemaname = '${S}' and indexname = 'article_search_vector_idx'`)).indexdef, `CREATE INDEX article_search_vector_idx ON ${S}.article USING gin (search_vector)`);
    const cs = await owner.one(`select source, sql from meta.change_set order by id desc limit 1`);
    assert.ok((await owner.one(`select count(*)::int as n from meta.change_set`)).n > changes);
    assert.equal(cs.source, 'table');
    assert.match(cs.sql, /add column search_vector tsvector generated always as/);
    // now the column exists: the same names are refused; existing tsvector columns are listed with their index
    const again = (await b.submit('/builder/sql/objects/fulltext', { ...post, mode: 'preview' })).body;
    assert.match(again, /search_vector already exists\./);
    assert.match(again, /<code>search_vector<\/code> \(GIN index\)/);
  });

  test('exported and imported with the application; an older export gets the defaults', async () => {
    const doc = (await owner.one(`select meta.export_app('hr') as d`)).d;
    const p = doc.search_configs.find((c: any) => c.name === 'FTS135_PRODUCTS');
    assert.equal(p.search_type, 'fulltext');
    assert.equal(p.fts_vector, 'search_vector');
    assert.equal(p.fts_config, 'english');
    assert.equal(p.did_you_mean, true);
    for (const c of doc.search_configs) if (c.name === 'FTS135_BUILT') for (const k of ['search_type', 'fts_vector', 'fts_config', 'did_you_mean']) delete c[k];
    const copy = (await owner.one(`select meta.import_app($1::jsonb, 'hr-fts-copy') as id`, [JSON.stringify(doc)])).id;
    try {
      const rows = (await owner.query(`select name, search_type, fts_vector, fts_config, did_you_mean from meta.search_config where app_id = $1 and name like 'FTS135_%' order by name`, [copy])).rows;
      assert.deepEqual(rows, [
        { name: 'FTS135_BUILT', search_type: 'standard', fts_vector: null, fts_config: null, did_you_mean: false },
        { name: 'FTS135_PRODUCTS', search_type: 'fulltext', fts_vector: 'search_vector', fts_config: 'english', did_you_mean: true },
      ]);
    } finally {
      await owner.query('delete from meta.app where id = $1', [copy]);
    }
  });
});
