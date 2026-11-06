// Every feature in a sample app (sprint 166): each catalogued value of the application components
// (region, item, process, validation and computation types, dynamic action events, actions and
// conditions, server-side condition types, button actions, page modes, …) is used by at least one
// of the applications pgkiln ships as examples: HR (examples/hr, the test fixture) and the App
// Gallery's sample apps (examples/gallery/samples). A new value in a catalogue fails this test until
// a sample app uses it, or it is listed in EXEMPT with the reason it can't be shown there. Those
// sample apps are installed and every page rendered by test/gallery.test.ts, so a feature in a
// sample app is also a feature that renders.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import '../src/env.ts';
import { closePools, owner } from '../src/db.ts';
import { dropSample, installSample, SAMPLES } from './gallery-samples.ts';

/** Values no sample app can show, with the reason. Keep it short: a reason is not "not done yet". */
const EXEMPT: Record<string, string> = {
  'meta.app.authentication=header': 'needs a reverse proxy that signs users in and sends a header (docs/guide/08-security.md)',
  'meta.app.authentication=database': 'signs in with PostgreSQL login roles, which a sample script would leave behind in the cluster',
  'meta.app.authentication=none': 'an application nobody signs in to; the gallery checks every sample as its demo account (public pages are shown with page protection and user_public conditions)',
};

const NULL_MEANS: Record<string, string> = { 'meta.region.position': 'body' };

const CATALOGUE = readFileSync(new URL('sample-coverage.sql', import.meta.url), 'utf8');

/** Tables whose rows belong to a page (the application through meta.page), the others carry app_id. */
const BY_PAGE = new Set(['meta.region', 'meta.item', 'meta.process', 'meta.validation', 'meta.computation', 'meta.dynamic_action', 'meta.button', 'meta.branch']);
const CONDITION_COLUMNS: [string, string][] = [
  ['meta.region', 'condition_type'], ['meta.item', 'condition_type'], ['meta.button', 'condition_type'], ['meta.process', 'condition_type'],
  ['meta.validation', 'condition_type'], ['meta.computation', 'condition_type'], ['meta.branch', 'condition_type'],
  ['meta.app_computation', 'condition_type'], ['meta.dynamic_action', 'server_condition_type'],
];

async function used(tbl: string, col: string, apps: number[]): Promise<Set<string>> {
  const sql = tbl === 'meta.app'
    ? `select distinct ${col}::text as v from meta.app where id = any($1)`
    : BY_PAGE.has(tbl)
      ? `select distinct x.${col}::text as v from ${tbl} x join meta.page p on p.id = x.page_id where p.app_id = any($1)`
      : `select distinct ${col}::text as v from ${tbl} where app_id = any($1)`;
  // an empty value that means one of the catalogue's (a region without a position is in the body)
  const empty = NULL_MEANS[`${tbl}.${col}`];
  return new Set((await owner.query<{ v: string | null }>(sql, [apps])).rows.map((r) => r.v ?? empty).filter((v): v is string => !!v));
}

describe('every feature in a sample app', () => {
  let apps: number[] = [];
  before(async () => {
    for (const x of SAMPLES) {
      await dropSample(x);
      await installSample(x);
    }
    apps = (await owner.query<{ id: number }>(`select id from meta.app where alias = any($1)`, [['hr', ...SAMPLES.map((x) => x.alias)]])).rows.map((r) => r.id);
  });
  after(async () => {
    for (const x of SAMPLES) await dropSample(x);
    await closePools();
  });

  test('each catalogued value of the application components is used by HR or a gallery sample app', async () => {
    assert.ok(apps.length >= 2, 'HR and the samples are installed');
    const rows = (await owner.query<{ tbl: string; col: string; val: string }>(CATALOGUE)).rows;
    assert.ok(rows.length > 200, 'the catalogue was read');
    const missing: string[] = [];
    // vector and hybrid search need pgvector (HR parts 72 and 81 add them only then)
    const vector = !!(await owner.one(`select 1 as ok from pg_extension where extname = 'vector'`));
    const needsVector = new Set(vector ? [] : ['meta.search_config.search_type=vector', 'meta.search_config.search_type=hybrid']);
    const seen = new Map<string, Set<string>>();
    for (const r of rows) {
      const k = `${r.tbl}.${r.col}`;
      if (!seen.has(k)) seen.set(k, await used(r.tbl, r.col, apps));
      const key = `${k}=${r.val}`;
      if (!seen.get(k)!.has(r.val) && !EXEMPT[key] && !needsVector.has(key)) missing.push(key);
    }
    // server-side condition types (147): the catalogue is meta.condition_ok
    const def = (await owner.one<{ d: string }>(`select pg_get_functiondef('meta.condition_ok(text, text, text)'::regprocedure) as d`))!.d;
    const types = [...new Set([...def.matchAll(/p_type in \(([^)]*)\)/g)].flatMap((m) => [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1])))];
    assert.ok(types.length > 20, 'the condition types were read');
    const usedTypes = new Set<string>();
    for (const [tbl, col] of CONDITION_COLUMNS) for (const v of await used(tbl, col, apps)) usedTypes.add(v);
    for (const t of types) if (!usedTypes.has(t) && !EXEMPT[`condition=${t}`]) missing.push(`condition=${t}`);
    assert.deepEqual(missing, [], `not shown in any sample app (add it to one, or to EXEMPT with the reason):\n${missing.join('\n')}`);
  });

  test('no exemption is stale: an exempted value is still in a catalogue and still unused', async () => {
    const rows = (await owner.query<{ tbl: string; col: string; val: string }>(CATALOGUE)).rows;
    for (const key of Object.keys(EXEMPT)) {
      if (key.startsWith('condition=')) continue;
      const [k, val] = key.split('=');
      const r = rows.find((x) => `${x.tbl}.${x.col}` === k && x.val === val);
      assert.ok(r, `${key} is in a catalogue`);
      assert.ok(!(await used(r.tbl, r.col, apps)).has(val), `${key} is used by a sample app now: remove the exemption`);
    }
  });
});
