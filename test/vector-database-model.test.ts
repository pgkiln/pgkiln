// Sprint 151 (AP-1 leftover; migration 146; APEX: a Vector Provider with an ONNX model in the database): vector
// providers of type database_model run the model inside PostgreSQL through an extension, PostgresML's
// pgml.embed(model, text). CI has no PostgresML, so a stand-in pgml.embed with the same signature returns a
// deterministic vector; with the real extension installed the stand-in is not made and its tests are skipped.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { embedQuery, embedsInDatabase, embedTexts, vectorProviderProblems, type VectorProvider } from '../src/ai/embeddings.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let hrId: number;
let stub = false;
const P: VectorProvider = { name: 'T151_MODEL', type: 'database_model', engine: 'pgml', model: 'intfloat/e5-small-v2', dimensions: 4 };

async function setProviders(list: VectorProvider[]) {
  await owner.query(`update meta.app set vector_providers = coalesce((select jsonb_agg(e) from jsonb_array_elements(vector_providers) e where e->>'name' not like 'T151%'), '[]') || $2::jsonb where id = $1`,
    [hrId, JSON.stringify(list)]);
}

before(async () => {
  app = await buildApp({ logger: false });
  hrId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  const real = (await owner.one(`select to_regprocedure('pgml.embed(text, text, jsonb)') is not null and exists (select 1 from pg_extension where extname = 'pgml') as ok`)).ok;
  if (!real) {
    // the stand-in: PostgresML's signature; the vector depends on the model and the text
    await owner.query(`create schema if not exists pgml;
      create or replace function pgml.embed(transformer text, "text" text, kwargs jsonb default '{}') returns real[] language sql immutable as $$
        select array[length("text"), length(transformer), position('fox' in "text"), 1]::real[] $$;
      grant usage on schema pgml to hr_app; grant execute on function pgml.embed(text, text, jsonb) to hr_app;`);
    stub = true;
  }
  await setProviders([P]);
});
after(async () => {
  await setProviders([]);
  if (stub) await owner.query('drop schema if exists pgml cascade');
  await app.close();
  await closePools();
});

describe('database model providers', () => {
  test('checks: an engine and a model; no service or function; an engine only on this type', () => {
    assert.deepEqual(vectorProviderProblems(P), []);
    assert.ok(embedsInDatabase(P) && embedsInDatabase({ type: 'function' }) && !embedsInDatabase({ type: 'ai_service' }));
    assert.match(vectorProviderProblems({ ...P, engine: 'onnxruntime' as any }).join(' '), /the engine is pgml/);
    assert.match(vectorProviderProblems({ ...P, model: "x'); drop table hr.emp; --" }).join(' '), /the model is its name/);
    assert.match(vectorProviderProblems({ ...P, service: 'OPENAI' }).join(' '), /no AI service or function/);
    assert.match(vectorProviderProblems({ name: 'X', type: 'function', function: 'a.b', dimensions: 4, engine: 'pgml' }).join(' '), /only a database model provider has an engine/);
  });

  test('meta.embed runs the model in the database, as the caller (the application role with its grants)', async (t) => {
    if (!stub) return t.skip('real PostgresML installed');
    const own = (await owner.one(`select meta.embed('the quick fox', 'T151_MODEL', $1) as v`, [hrId])).v;
    assert.deepEqual(own, [13, 20, 11, 1]);
    const asApp = await owner.tx(async (c) => {
      await c.query('set local role hr_app');
      return (await c.query(`select meta.embed('fox', 'T151_MODEL', $1) as v`, [hrId])).rows[0].v;
    });
    assert.deepEqual(asApp, [3, 20, 1, 1]);
    // the server's own paths: a batch for a vector column, a search text
    assert.deepEqual(await embedTexts(P, ['a', 'fox'], { appId: hrId }, owner), [[1, 20, 0, 1], [3, 20, 1, 1]]);
    assert.deepEqual(await embedQuery(P, 'fox', { appId: hrId }, owner), [3, 20, 1, 1]);
    await assert.rejects(embedTexts(P, ['a'], { appId: hrId }), /needs a database connection/);
  });

  test('wrong dimensions, a stored model name that is not a name, and a database without PostgresML are clear errors', async (t) => {
    if (!stub) return t.skip('real PostgresML installed');
    await setProviders([{ ...P, dimensions: 8 }]);
    await assert.rejects(owner.query(`select meta.embed('x', 'T151_MODEL', $1)`, [hrId]), /returned 4 dimensions, it has 8/);
    await setProviders([{ ...P, model: "m'; select 1; --" }]);
    await assert.rejects(owner.query(`select meta.embed('x', 'T151_MODEL', $1)`, [hrId]), /is a model name/);
    await setProviders([P]);
    await owner.query('alter function pgml.embed(text, text, jsonb) rename to embed_away');
    try {
      await assert.rejects(owner.query(`select meta.embed('x', 'T151_MODEL', $1)`, [hrId]), /PostgresML, which is not installed in this database \(create extension pgml\)/);
    } finally {
      await owner.query('alter function pgml.embed_away(text, text, jsonb) rename to embed');
    }
  });

  test('the builder: add one, Test embeds a sample text, the lists say where it runs', async (t) => {
    if (!stub) return t.skip('real PostgresML installed');
    await setProviders([]);
    const b = new Browser(app);
    await b.get('/builder/login');
    await b.submit('/builder/login', { username: 'admin', password: 'admin' });
    let page = (await b.get(`/builder/apps/${hrId}/vector-providers/provider`)).body;
    assert.match(page, /<option value="database_model">Model in the database \(PostgresML\)<\/option>/);
    assert.doesNotMatch(page, /PostgresML \(<code>pgml<\/code>\) is not installed/, 'pgml.embed is there');
    await b.submit(`/builder/apps/${hrId}/vector-providers/provider`, { original: '', name: 'T151_MODEL', type: 'database_model', dimensions: '4', engine: 'pgml', db_model: 'intfloat/e5-small-v2', model: 'ignored' });
    const saved = (await owner.one(`select e from meta.app a, jsonb_array_elements(a.vector_providers) e where a.id = $1 and e->>'name' = 'T151_MODEL'`, [hrId])).e;
    assert.deepEqual(saved, { name: 'T151_MODEL', type: 'database_model', engine: 'pgml', model: 'intfloat/e5-small-v2', dimensions: 4 });
    await b.get(`/builder/apps/${hrId}/vector-providers/provider?name=T151_MODEL`);
    await b.submit(`/builder/apps/${hrId}/vector-providers/test`, { name: 'T151_MODEL' });
    page = (await b.get(`/builder/apps/${hrId}/vector-providers`)).body;
    assert.match(page, /4 dimensions/);
    assert.match(page, /in the database \(pgml\)/);
  });
});
