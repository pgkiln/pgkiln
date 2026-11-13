// Sprint 136 (AP-1): vector providers, meta.embed, pgvector detection, Table Properties › Add vector column (the
// embedding queue and Backfill), search types vector and hybrid, the Retrieve tool of AI agents, export. Embeddings
// come from the local mock (test/ai-mock.ts: deterministic "topic" vectors), never from a real API. Everything that
// needs pgvector skips when the extension isn't installed (stock postgres images: CI's upgrade jobs).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';

process.env.PGKILN_SECRET_KEY ??= 'test-only-secret-key-0123456789abcdef';
process.env.EMBEDDINGS = 'off';

const { buildApp } = await import('../src/app.ts');
const { closePools, owner } = await import('../src/db.ts');
const { encryptSecret } = await import('../src/secrets.ts');
const { vectorProviderProblems, vectorProvidersProblems, forgetQueries } = await import('../src/ai/embeddings.ts');
const { searchConfigProblems } = await import('../src/runtime/search.ts');
const { aiToolProblems } = await import('../src/runtime/ai-agents.ts');
const { drainEmbeddings, pgvectorStatus, vectorTriggers } = await import('../src/vector.ts');
const { vectorDdl } = await import('../src/builder/vector-column.ts');
const { conceptEmbedding } = await import('./ai-mock.ts');
const { startScriptMock } = await import('./ai-script-mock.ts');
const { Browser } = await import('./helpers.ts');

const HAS_PGVECTOR = !!(await owner.one(`select 1 as x from pg_extension where extname = 'vector'`));
const NEEDS = HAS_PGVECTOR ? {} : { skip: 'pgvector is not installed in the test database' };
const S = 'vt136';
const SERVICE = 'T_S136_EMB';
const CHAT = 'HR_ASSISTANT';

let app: FastifyInstance;
let mock: Awaited<ReturnType<typeof startScriptMock>>;
let hrId: number;
let page1: number;
let region: number;
let saved: { vector_providers: unknown; ai_tools: unknown; ai_agents: unknown };

const embeddingCalls = () => mock.seen.filter((r) => r.path === '/openai/v1/embeddings');
const claudeCalls = () => mock.seen.filter((r) => r.path === '/claude/v1/messages');
const results = (body: string) => /<div class="search-results" id="R\d+_results" aria-live="polite">([\s\S]*?)<\/div>\s*(?:<\/div>|<\/section>)/.exec(body)?.[1] ?? '';
const titles = (r: string) => [...r.matchAll(/<span class="search-title">([\s\S]*?)<\/span>/g)].map((m) => m[1].replace(/<\/?mark>/g, ''));
const groupTitles = (r: string, label: string) => titles([...r.matchAll(/<section class="search-group"><h3>([^<]*)<\/h3>([\s\S]*?)<\/section>/g)].find((m) => m[1] === label)?.[2] ?? '');
async function user(name: string) {
  const b = new Browser(app);
  assert.equal((await b.login(name)).statusCode, 303);
  return b;
}
async function builder() {
  const b = new Browser(app);
  await b.get('/builder/login');
  assert.equal((await b.submit('/builder/login', { username: 'admin', password: 'admin' })).statusCode, 303);
  await b.ownerConnection(); // (sprint 185) the owner's schemas: the Owner connection
  return b;
}
const search = async (b: InstanceType<typeof Browser>, text: string, pageNo = 1, r = region) => results((await b.get(`/a/hr/${pageNo}?s${r}=${encodeURIComponent(text)}`)).body);

before(async () => {
  mock = await startScriptMock();
  app = await buildApp({ logger: false });
  hrId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  page1 = (await owner.one('select id from meta.page where app_id = $1 and page_no = 1', [hrId])).id;
  saved = (await owner.one('select vector_providers, ai_tools, ai_agents from meta.app where id = $1', [hrId]))!;
  await owner.query(`delete from meta.ai_service where name = any($1)`, [[SERVICE, CHAT]]);
  const emb = (await owner.one(`insert into meta.ai_service (name, provider, model, base_url, api_key_enc) values ($1, 'openai_compatible', 'unused-chat', $2, $3) returning id`,
    [SERVICE, `${mock.base}/openai/v1`, encryptSecret('sk-s136-embedding-secret')])).id;
  const chat = (await owner.one(`insert into meta.ai_service (name, provider, model, base_url, api_key_enc, effort, max_tokens) values ($1, 'anthropic', 'claude-opus-5-5', $2, $3, 'medium', 4000) returning id`,
    [CHAT, `${mock.base}/claude`, encryptSecret('sk-ant-s136-secret')])).id;
  await owner.query(`insert into meta.app_ai_service (app_id, service_id) values ($1, $2), ($1, $3)`, [hrId, emb, chat]);
  await owner.query(`update meta.app set vector_providers = vector_providers || $2::jsonb where id = $1`,
    [hrId, JSON.stringify([{ name: 'T136_EMB', type: 'ai_service', service: SERVICE, model: 'mock-embed', dimensions: 8, batch_size: 3 }])]);
  await owner.query(`drop schema if exists ${S} cascade; create schema ${S}; grant usage on schema ${S} to hr_app;
    create table ${S}.policy (id int primary key, title text not null, body text not null, audience text not null default 'all');
    insert into ${S}.policy (id, title, body, audience) select id, title, body, audience from hr.policy;
    alter table ${S}.policy enable row level security;
    create policy visible on ${S}.policy for select using (audience = 'all' or meta.has_role('manager') or meta.has_role('admin'));
    grant select, insert, update on ${S}.policy to hr_app;`);
  await owner.query(`delete from meta.search_config where app_id = $1 and name like 'VT136%'`, [hrId]);
  region = (await owner.one(`insert into meta.region (page_id, seq, title, type, config) values ($1, 997, 'Search by meaning', 'search', '{"configs": ["VT136"]}') returning id`, [page1])).id;
});

after(async () => {
  await owner.query('delete from meta.region where id = $1', [region]);
  await owner.query(`delete from meta.search_config where app_id = $1 and name like 'VT136%'`, [hrId]);
  await owner.query('update meta.app set vector_providers = $2, ai_tools = $3, ai_agents = $4 where id = $1',
    [hrId, JSON.stringify(saved.vector_providers), JSON.stringify(saved.ai_tools), JSON.stringify(saved.ai_agents)]);
  await owner.query(`delete from meta.embedding_queue where tbl in (select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1)`, [S]);
  await owner.query(`drop schema if exists ${S} cascade`);
  await owner.query(`delete from meta.ai_service where name = any($1)`, [[SERVICE, CHAT]]);
  await owner.query(`delete from meta.ai_conversation where app_id = $1`, [hrId]);
  await mock.close();
  await app.close();
  await closePools();
});

describe('sprint 136 AP-1: vector providers and their checks', () => {
  test('providers, search configurations and Retrieve tools are checked', () => {
    assert.deepEqual(vectorProviderProblems({ name: 'DOCS', type: 'ai_service', service: 'EMB', model: 'text-embedding-3-small', dimensions: 1536 }), []);
    assert.deepEqual(vectorProviderProblems({ name: 'TOY', type: 'function', function: 'sales.embed', dimensions: 8 }), []);
    assert.ok(vectorProviderProblems({ name: 'docs', type: 'ai_service', service: 'EMB', model: 'm', dimensions: 8 }).length, 'upper case');
    assert.ok(vectorProviderProblems({ name: 'TOY', type: 'function', function: 'embed', dimensions: 8 }).length, 'schema.name');
    assert.ok(vectorProviderProblems({ name: 'TOY', type: 'function', function: 'x.embed(); drop table y', dimensions: 8 }).length);
    assert.ok(vectorProviderProblems({ name: 'TOY', type: 'function', function: 'x.e', dimensions: 0 }).length, 'dimensions');
    assert.ok(vectorProviderProblems({ name: 'X', type: 'ai_service', service: 'EMB', model: 'bad model', dimensions: 8 }).length, 'a model name');
    assert.ok(vectorProvidersProblems([{ name: 'A', type: 'function', function: 'a.b', dimensions: 2 }, { name: 'A', type: 'function', function: 'a.b', dimensions: 2 }]).some((p) => /twice/.test(p)));
    assert.deepEqual(vectorProvidersProblems(saved.vector_providers), [], 'the HR example is valid');
    const base = { source_type: 'table' as const, source: 'hr.policy', title_column: 'title', searchable_columns: [] };
    assert.deepEqual(searchConfigProblems({ ...base, search_type: 'vector', vector_provider: 'P', vector_column: 'embedding', distance: 'cosine', min_similarity: 0.3 }), []);
    assert.ok(searchConfigProblems({ ...base, search_type: 'vector', vector_column: 'embedding' }).length, 'a provider');
    assert.ok(searchConfigProblems({ ...base, search_type: 'vector', vector_provider: 'P', vector_column: 'embedding; drop table x' }).length, 'a column name');
    assert.ok(searchConfigProblems({ ...base, search_type: 'vector', vector_provider: 'P', vector_column: 'e', distance: 'manhattan' as never }).length);
    assert.ok(searchConfigProblems({ ...base, search_type: 'vector', vector_provider: 'P', vector_column: 'e', min_similarity: 2 }).length);
    assert.ok(searchConfigProblems({ ...base, search_type: 'hybrid', vector_provider: 'P', vector_column: 'e' }).length, 'hybrid needs a key');
    assert.ok(searchConfigProblems({ ...base, source_type: 'list', search_type: 'vector', vector_provider: 'P', vector_column: 'e' }).length, 'not a list');
    assert.deepEqual(aiToolProblems({ name: 'docs', type: 'retrieve', description: 'd', search_config: 'POLICIES' }), []);
    assert.ok(aiToolProblems({ name: 'docs', type: 'retrieve', description: 'd' }).length, 'a configuration');
    assert.ok(aiToolProblems({ name: 'docs', type: 'retrieve', description: 'd', search_config: 'P', parameters: { X: { type: 'string' } } }).length, 'no parameters');
  });

  test('the DDL of a vector column: vector(n), an HNSW index for the distance, the trigger with its arguments', () => {
    const ddl = vectorDdl({ table: 'sales.doc', vectorType: 'public.vector', column: 'embedding', index: 'doc_embedding_idx', trigger: 'embedding_embed', dims: 1536, distance: 'l2', mode: 'queue', appId: 7, provider: 'DOCS', key: 'id', sources: ['title', 'body'] });
    assert.equal(ddl[0], 'alter table sales.doc\n  add column embedding public.vector(1536)');
    assert.equal(ddl[1], 'create index doc_embedding_idx on sales.doc using hnsw (embedding vector_l2_ops)');
    assert.match(ddl[2], /after insert or update of title, body on sales\.doc\n  for each row execute function meta\.embedding_enqueue\('7', 'DOCS', 'embedding', 'id', 'title', 'body'\)/);
    const big = vectorDdl({ table: 't', vectorType: 'public.vector', column: 'e', index: 'i', trigger: 'g', dims: 3072, distance: 'cosine', mode: 'set', appId: 1, provider: 'P', key: 'id', sources: ['a'] });
    assert.equal(big.length, 2, 'no HNSW index above 2,000 dimensions');
    assert.match(big[1], /before insert or update of a on t\n  for each row execute function meta\.embedding_set/);
  });

  test('pgvector detected (as the SQL Workshop detects pg_cron)', async () => {
    const st = await pgvectorStatus(owner);
    assert.equal(st.installed, HAS_PGVECTOR);
    if (HAS_PGVECTOR) assert.match(st.version!, /^\d+\.\d+/);
  });

  test('meta.embed: a function provider in SQL, as the caller; an AI service provider says the server calls it', NEEDS, async () => {
    const v = (await owner.one(`select meta.embed('time off for a family move', 'POLICY_EMBEDDINGS', $1) as v`, [hrId])).v;
    assert.equal(v.length, 8);
    assert.deepEqual(v.map((x: number) => Math.round(x * 1e4)), conceptEmbedding('time off for a family move').map((x) => Math.round(x * 1e4)), 'the HR stand-in and the mock agree');
    await assert.rejects(owner.query(`select meta.embed('x', 'T136_EMB', $1)`, [hrId]), /uses AI service T_S136_EMB, which the pgkiln server calls/);
    await assert.rejects(owner.query(`select meta.embed('x', 'NOPE', $1)`, [hrId]), /there is no vector provider NOPE/);
    await assert.rejects(owner.query(`select meta.embed('x', 'POLICY_EMBEDDINGS')`), /no current application/);
  });
});

describe('sprint 136 AP-1: a vector column kept current, and search by meaning', NEEDS, () => {
  test('Table Properties › Add vector column: preview, apply, every row queued and embedded by the AI service; a change is queued again', async () => {
    const b = await builder();
    const ref = `${S}.policy`;
    const form = (await b.get(`/builder/sql/objects/vector?o=${ref}`)).body;
    assert.match(form, /<h1 class="u-mb1">Vector column on vt136\.policy<\/h1>/);
    assert.match(form, new RegExp(`<option value="${hrId}:T136_EMB"`));
    assert.match((await b.get(`/builder/sql/objects/table?o=${ref}`)).body, /href="\/builder\/sql\/objects\/vector\?o=vt136\.policy"/);
    const post = { o: ref, provider: `${hrId}:T136_EMB`, keep: 'queue', 'c.0.name': 'title', 'c.0.use': 'on', 'c.1.name': 'body', 'c.1.use': 'on', distance: 'cosine', column: 'embedding', index: 'policy_embedding_idx' };
    const preview = (await b.submit('/builder/sql/objects/vector', { ...post, mode: 'preview' })).body;
    assert.match(preview, /add column embedding public\.vector\(8\);/);
    assert.match(preview, /create index policy_embedding_idx on vt136\.policy using hnsw \(embedding vector_cosine_ops\);/);
    assert.match(preview, new RegExp(`meta\\.embedding_enqueue\\(&#39;${hrId}&#39;, &#39;T136_EMB&#39;, &#39;embedding&#39;, &#39;id&#39;, &#39;title&#39;, &#39;body&#39;\\)`));
    assert.equal((await owner.one(`select count(*)::int as n from pg_attribute where attrelid = '${ref}'::regclass and attname = 'embedding'`)).n, 0, 'a preview changes nothing');
    const applied = await b.submit('/builder/sql/objects/vector', { ...post, mode: 'apply' });
    assert.equal(applied.statusCode, 303);
    const rows = (await owner.one(`select count(*)::int as n from ${ref}`)).n;
    assert.equal((await owner.one(`select count(*)::int as n from meta.embedding_queue where tbl = '${ref}'::regclass`)).n, rows, 'the rows there are now are queued');
    assert.match((await owner.one(`select sql from meta.change_set order by id desc limit 1`)).sql, /meta\.embedding_enqueue/);
    let page = (await b.get(`/builder/sql/objects/vector?o=${ref}`)).body;
    assert.match(page, new RegExp(`0 of ${rows} rows embedded, ${rows} queued`));
    const before = embeddingCalls().length;
    await drainEmbeddings();
    const calls = embeddingCalls().slice(before);
    assert.equal(calls.length, Math.ceil(rows / 3), 'batches of the provider\'s 3 texts');
    assert.equal(calls[0].body.model, 'mock-embed');
    assert.equal(calls[0].body.encoding_format, 'float');
    assert.equal(calls[0].headers.authorization, 'Bearer sk-s136-embedding-secret');
    assert.ok(calls.some((c) => c.body.input.some((t: string) => /^Relocation leave\nEmployees who relocate/.test(t))), 'title and body, one per line');
    assert.equal((await owner.one(`select count(embedding)::int as n from ${ref}`)).n, rows);
    assert.equal((await owner.one(`select count(*)::int as n from meta.embedding_queue where tbl = '${ref}'::regclass`)).n, 0);
    page = (await b.get(`/builder/sql/objects/vector?o=${ref}`)).body;
    assert.match(page, new RegExp(`${rows} of ${rows} rows embedded, 0 queued`));
    assert.match(page, /kept by T136_EMB from title, body/);
    const usage = await owner.one(`select count(*)::int as n, sum(input_tokens)::int as tokens from meta.ai_usage where app_id = $1 and source = 'embedding' and service = $2`, [hrId, SERVICE]);
    assert.ok(usage.n >= calls.length && usage.tokens > 0, 'logged under AI usage');
    // a changed body is queued again (as the application's role, through the security definer trigger); a change elsewhere is not
    await owner.query(`update ${ref} set audience = audience where id = 1`);
    assert.equal((await owner.one(`select count(*)::int as n from meta.embedding_queue where tbl = '${ref}'::regclass`)).n, 0);
    await owner.query(`update ${ref} set body = 'Every employee has 25 days of paid holiday a year.' where id = 1`);
    assert.equal((await owner.one(`select count(*)::int as n from meta.embedding_queue where tbl = '${ref}'::regclass`)).n, 1);
    await drainEmbeddings();
    assert.deepEqual((await owner.one(`select embedding::real[] as v from ${ref} where id = 1`)).v.map((x: number) => Math.round(x * 1e4)),
      conceptEmbedding('Annual leave\nEvery employee has 25 days of paid holiday a year.').map((x) => Math.round(x * 1e4)));
    // Backfill: all rows again
    const t = (await vectorTriggers(owner, ref))[0];
    assert.deepEqual([t.mode, t.provider, t.vectorColumn, t.keyColumn, t.sourceColumns], ['queue', 'T136_EMB', 'embedding', 'id', ['title', 'body']]);
    assert.equal((await b.submit('/builder/sql/objects/vector', { o: ref, column: 'embedding', all: 'on', mode: 'backfill' })).statusCode, 303);
    assert.equal((await owner.one(`select count(*)::int as n from meta.embedding_queue where tbl = '${ref}'::regclass`)).n, rows);
    await drainEmbeddings();
    // the Advisor is satisfied with the column (dimensions, HNSW index)
  });

  test('a failing batch is kept with its message and retried later', async () => {
    const ref = `${S}.policy`;
    await owner.query(`update meta.app set vector_providers = jsonb_set(vector_providers, (select array[(ordinality - 1)::text, 'dimensions'] from jsonb_array_elements(vector_providers) with ordinality where value->>'name' = 'T136_EMB'), '9') where id = $1`, [hrId]);
    try {
      await owner.query(`update ${ref} set title = title || '' , body = body || ' ' where id = 2`);
      await drainEmbeddings();
      const q = await owner.one(`select attempts, last_error, next_at > now() as later from meta.embedding_queue where tbl = '${ref}'::regclass`);
      assert.equal(q.attempts, 1);
      assert.match(q.last_error, /the model returned 8 dimensions, the provider says 9/);
      assert.equal(q.later, true);
      assert.match((await (await builder()).get(`/builder/sql/objects/vector?o=${ref}`)).body, /1 failing/);
    } finally {
      await owner.query(`update meta.app set vector_providers = jsonb_set(vector_providers, (select array[(ordinality - 1)::text, 'dimensions'] from jsonb_array_elements(vector_providers) with ordinality where value->>'name' = 'T136_EMB'), '8') where id = $1`, [hrId]);
      await owner.query(`update meta.embedding_queue set next_at = now() where tbl = '${ref}'::regclass`);
      await drainEmbeddings();
    }
  });

  test('"time off for a family move" finds Relocation leave, which uses none of those words; only rows the user may read', async () => {
    await owner.query(
      `insert into meta.search_config (app_id, name, label, seq, source_type, source, search_type, vector_provider, vector_column, distance, min_similarity, title_column, description_column, max_results)
       values ($1, 'VT136', 'Policies (vector)', 10, 'table', '${S}.policy', 'vector', 'T136_EMB', 'embedding', 'cosine', 0.6, 'title', 'body', 5)`, [hrId]);
    forgetQueries();
    const king = await user('king');
    const before = embeddingCalls().length;
    const found = titles(await search(king, 'time off for a family move'));
    assert.equal(found[0], 'Relocation leave', found.join(', '));
    assert.ok(!found.includes('Sick leave'), 'less similar than 0.6');
    assert.equal(embeddingCalls().length, before + 1, 'the search text, embedded once');
    assert.equal(embeddingCalls().at(-1)!.body.input[0], 'time off for a family move');
    await search(king, 'time off for a family move');
    assert.equal(embeddingCalls().length, before + 1, 'remembered for the next search');
    // row level security: an employee never finds the managers' policy, a manager does
    await owner.query(`update meta.search_config set min_similarity = null where app_id = $1 and name = 'VT136'`, [hrId]);
    assert.ok(titles(await search(king, 'pay scale')).includes('Salary bands'));
    const scott = await user('scott');
    const forScott = titles(await search(scott, 'pay scale'));
    assert.ok(forScott.length && !forScott.includes('Salary bands'), forScott.join(', '));
    // output escaped
    await owner.query(`update ${S}.policy set title = '<img src=x onerror=alert(1)> Relocation leave' where id = 6`);
    try {
      const r = await search(king, 'time off for a family move');
      assert.match(r, /<span class="search-title">&lt;img src=x onerror=alert\(1\)&gt; Relocation leave<\/span>/, 'escaped, and no word marked: found by meaning');
      assert.doesNotMatch(r, /<img src=x/);
    } finally {
      await owner.query(`update ${S}.policy set title = 'Relocation leave' where id = 6`);
      await drainEmbeddings();
    }
  });

  test('hybrid: full-text and vector rankings fused; the HR Search page (function provider)', async () => {
    await owner.query(`alter table ${S}.policy add column search_vector tsvector generated always as (to_tsvector('english', title || ' ' || body)) stored`);
    await owner.query(
      `insert into meta.search_config (app_id, name, label, seq, source_type, source, search_type, fts_vector, fts_config, vector_provider, vector_column, key_column, min_similarity, title_column, description_column, max_results)
       values ($1, 'VT136H', 'Policies (hybrid)', 20, 'table', '${S}.policy', 'hybrid', 'search_vector', 'english', 'T136_EMB', 'embedding', 'id', 0.6, 'title', 'body', 3)`, [hrId]);
    await owner.query(`update meta.region set config = '{"configs": ["VT136H"]}' where id = $1`, [region]);
    try {
      const king = await user('king');
      assert.equal(titles(await search(king, 'time off for a family move'))[0], 'Relocation leave', 'by meaning');
      assert.equal(titles(await search(king, 'sickness doctor note'))[0], 'Sick leave', 'by words and meaning');
      // the HR example: page 42 searches POLICIES_MEANING (hybrid, the stand-in function provider) too
      const r42 = (await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 42 and r.type = 'search'`, [hrId])).id;
      const r = await search(king, 'time off for a family move', 42, r42);
      assert.match(r, /<h3>Policies by meaning<\/h3>/);
      assert.equal(groupTitles(r, 'Policies by meaning')[0], 'Relocation leave');
    } finally {
      await owner.query(`update meta.region set config = '{"configs": ["VT136"]}' where id = $1`, [region]);
    }
  });

  test('without the vector column or with a missing provider, the configuration shows what is wrong; the Advisor checks dimensions and the index', async () => {
    const { advise } = await import('../src/builder/advisor.ts');
    await owner.query(
      `insert into meta.search_config (app_id, name, label, seq, source_type, source, search_type, vector_provider, vector_column, distance, title_column)
       values ($1, 'VT136_NOPROV', 'No provider', 30, 'table', '${S}.policy', 'vector', 'NO_SUCH', 'embedding', 'l2', 'title')`, [hrId]);
    try {
      const { findings } = await advise(hrId);
      const mine = (name: string) => findings.filter((f) => f.entry?.kind === 'search_config' && f.entry.label.includes(name)).map((f) => `${f.severity}: ${f.message}`);
      assert.ok(mine('VT136_NOPROV').some((m) => /error: There is no vector provider NO_SUCH/.test(m)), JSON.stringify(mine('VT136_NOPROV')));
      assert.ok(mine('VT136_NOPROV').some((m) => /warning: The index on embedding is for vector_cosine_ops, not vector_l2_ops/.test(m)));
      assert.deepEqual(mine('VT136 '), [], 'the good one passes');
      assert.deepEqual(findings.filter((f) => f.severity === 'error' && f.entry?.kind === 'search_config' && /POLICIES/.test(f.entry.label)), [], 'the HR example passes');
      const king = await user('king');
      await owner.query(`update meta.region set config = '{"configs": ["VT136_NOPROV"]}' where id = $1`, [region]);
      assert.match(await search(king, 'anything'), /There is no vector provider NO_SUCH/);
    } finally {
      await owner.query(`update meta.region set config = '{"configs": ["VT136"]}' where id = $1`, [region]);
      await owner.query(`delete from meta.search_config where app_id = $1 and name = 'VT136_NOPROV'`, [hrId]);
    }
  });
});

describe('sprint 136 AP-1: an agent answers through a Retrieve tool', NEEDS, () => {
  test('page 49: the policies the user may read go to the model, logged as a retrieve tool call', async () => {
    const r49 = (await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 49 and r.type = 'ai_assistant'`, [hrId])).id;
    const ask = async (name: string, question: string, query: string) => {
      mock.script = [{ tools: [{ name: 'policy_search', input: { QUERY: query } }] }, { text: 'You get three paid days (Relocation leave).' }];
      const b = await user(name);
      assert.match((await b.get('/a/hr/49')).body, /Do I get time off for a family move/);
      const before = claudeCalls().length;
      assert.equal((await b.submit(`/a/hr/49/assistant/${r49}/send`, { message: question, params: '' })).statusCode, 303);
      const calls = claudeCalls().slice(before);
      assert.equal(calls.length, 2);
      const tool = calls[0].body.tools.find((t: any) => t.name === 'policy_search');
      assert.deepEqual(Object.keys(tool.input_schema.properties), ['QUERY']);
      const result = calls[1].body.messages.at(-1).content[0];
      assert.equal(result.is_error, undefined, result.content);
      return { result: JSON.parse(result.content), page: (await b.get('/a/hr/49')).body };
    };
    const { result, page } = await ask('scott', 'Do I get time off for a family move?', 'time off for a family move');
    assert.equal(result.rows[0].title, 'Relocation leave');
    assert.match(result.rows[0].text, /relocate to another city/);
    assert.ok(typeof result.rows[0].score === 'number');
    assert.match(page, /You get three paid days \(Relocation leave\)\./);
    // row level security: the managers' policy is never retrieved for an employee
    const pay = await ask('scott', 'How are salary bands reviewed?', 'salary bands raise');
    assert.ok(!JSON.stringify(pay.result).includes('Salary bands'), JSON.stringify(pay.result));
    const king = await ask('king', 'How are salary bands reviewed?', 'salary bands raise');
    assert.equal(king.result.rows[0].title, 'Salary bands');
    const log = await owner.one(`select agent, tool, type, status, arguments from meta.ai_tool_call where app_id = $1 and tool = 'policy_search' order by id desc limit 1`, [hrId]);
    assert.deepEqual([log.agent, log.type, log.status, log.arguments], ['POLICY_AGENT', 'retrieve', 'ok', { QUERY: 'salary bands raise' }]);
  });

  test('a Retrieve tool on an AI service provider (the mock), as the application\'s role', async () => {
    const tools = [...(saved.ai_tools as any[]), { name: 'vt_search', type: 'retrieve', search_config: 'VT136', description: 'Policies by meaning.', max_rows: 2 }];
    const agents = [...(saved.ai_agents as any[]).filter((a) => a.name !== 'POLICY_AGENT'), { ...(saved.ai_agents as any[]).find((a) => a.name === 'POLICY_AGENT'), tools: ['vt_search'] }];
    await owner.query('update meta.app set ai_tools = $2, ai_agents = $3 where id = $1', [hrId, JSON.stringify(tools), JSON.stringify(agents)]);
    try {
      const r49 = (await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 49 and r.type = 'ai_assistant'`, [hrId])).id;
      mock.script = [{ tools: [{ name: 'vt_search', input: { QUERY: 'pay scale', EXTRA: 'x' } }] }, { tools: [{ name: 'vt_search', input: { QUERY: 'pay scale' } }] }, { text: 'No policy covers that.' }];
      const b = await user('scott');
      await b.get('/a/hr/49');
      const before = claudeCalls().length;
      await b.submit(`/a/hr/49/assistant/${r49}/send`, { message: 'pay?', params: '' });
      const calls = claudeCalls().slice(before);
      const first = calls[1].body.messages.at(-1).content[0];
      assert.equal(first.is_error, true);
      assert.match(first.content, /Unknown argument "EXTRA"/);
      const second = JSON.parse(calls[2].body.messages.at(-1).content[0].content);
      assert.ok(second.rows.length <= 2 && !JSON.stringify(second).includes('Salary bands'), JSON.stringify(second));
    } finally {
      await owner.query('update meta.app set ai_tools = $2, ai_agents = $3 where id = $1', [hrId, JSON.stringify(saved.ai_tools), JSON.stringify(saved.ai_agents)]);
    }
  });
});

describe('sprint 136 AP-1: the builder pages and export', () => {
  test('Shared Components › Vector providers: add, refuse a bad one, test the dimensions, rename keeps its configurations', NEEDS, async () => {
    const b = await builder();
    const list = (await b.get(`/builder/apps/${hrId}/vector-providers`)).body;
    assert.match(list, /POLICY_EMBEDDINGS/);
    assert.match(list, /pgvector [\d.]+ is installed/);
    assert.match((await b.get(`/builder/apps/${hrId}/shared`)).body, /vector-providers/);
    await b.get(`/builder/apps/${hrId}/vector-providers/provider`);
    const bad = await b.submit(`/builder/apps/${hrId}/vector-providers/provider`, { original: '', name: 'T136_BAD', type: 'function', function: 'nope', dimensions: '8' });
    assert.equal(bad.statusCode, 422);
    assert.match(bad.body, /the function is schema\.name/);
    const ok = await b.submit(`/builder/apps/${hrId}/vector-providers/provider`, { original: '', name: 't136_mock', type: 'ai_service', service: SERVICE, model: 'mock-embed', dimensions: '8' });
    assert.equal(ok.statusCode, 303);
    const def = ((await owner.one('select vector_providers from meta.app where id = $1', [hrId])).vector_providers as any[]).find((p) => p.name === 'T136_MOCK');
    assert.deepEqual(def, { name: 'T136_MOCK', type: 'ai_service', service: SERVICE, model: 'mock-embed', dimensions: 8 });
    const form = (await b.get(`/builder/apps/${hrId}/vector-providers/provider?name=T136_MOCK`)).body;
    assert.doesNotMatch(form, /sk-s136/, 'no key on the page');
    await b.submit(`/builder/apps/${hrId}/vector-providers/test`, { name: 'T136_MOCK' });
    assert.match((await b.get(`/builder/apps/${hrId}/vector-providers/provider?name=T136_MOCK`)).body, /with 8 dimensions, as the provider says/);
    // the workspace utility lists providers and vector columns
    const ws = (await b.get('/builder/vector-providers')).body;
    assert.match(ws, /T136_MOCK/);
    assert.match(ws, /vt136\.policy\.embedding/);
    assert.match((await b.get('/builder/utilities')).body, /href="\/builder\/vector-providers"/);
    await b.submit(`/builder/apps/${hrId}/vector-providers/provider/delete`, { name: 'T136_MOCK' });
    assert.ok(!((await owner.one('select vector_providers from meta.app where id = $1', [hrId])).vector_providers as any[]).some((p) => p.name === 'T136_MOCK'));
  });

  test('exported with the application (the key stays with the AI service); an older export gets the defaults', async () => {
    const doc = (await owner.one(`select meta.export_app('hr') as d`)).d;
    assert.ok(doc.app.vector_providers.some((p: any) => p.name === 'T136_EMB' && p.service === SERVICE));
    assert.doesNotMatch(JSON.stringify(doc), /sk-s136-embedding-secret|api_key_enc/);
    if (HAS_PGVECTOR) {
      const c = doc.search_configs.find((x: any) => x.name === 'POLICIES_MEANING');
      assert.deepEqual([c.search_type, c.vector_provider, c.vector_column, c.key_column, c.distance, c.min_similarity], ['hybrid', 'POLICY_EMBEDDINGS', 'embedding', 'id', 'cosine', 0.6]);
    }
    delete doc.app.vector_providers;
    for (const c of doc.search_configs) delete c.distance;
    await owner.query(`delete from meta.app where alias = 'hr-vec-copy'`);
    const copy = (await owner.one(`select meta.import_app($1::jsonb, 'hr-vec-copy') as id`, [JSON.stringify(doc)])).id;
    try {
      assert.deepEqual((await owner.one('select vector_providers from meta.app where id = $1', [copy])).vector_providers, []);
      assert.deepEqual((await owner.query(`select distinct distance from meta.search_config where app_id = $1`, [copy])).rows, [{ distance: 'cosine' }]);
    } finally {
      await owner.query('delete from meta.app where id = $1', [copy]);
    }
  });
});
