// Sprint 146 (AP-8 leftover): the Advisor names JSON sources whose views no longer match their data profile —
// a view missing, a view not made by the source, a column added to, removed from or retyped in the profile, a path
// or read-only flag changed (the trigger's argument) — and is silent for views Create views made from the profile.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/env.ts';
import { closePools, owner } from '../src/db.ts';
import { advise, jsonSourceFindings } from '../src/builder/advisor.ts';
import { jsonSourceDdl, type JsonSource } from '../src/json-sources.ts';

const SOURCE: JsonSource = {
  name: 'T146_DOCS', schema: 'hr', table: 't146_doc', key: ['id'], column: 'doc', view: 't146_doc_v',
  columns: [{ name: 'title', path: ['title'], type: 'text' }, { name: 'n', path: ['a', 'n'], type: 'integer' }],
  arrays: [{ name: 'tags', path: ['tags'], view: 't146_doc_tags', columns: [{ name: 'tag', path: [], type: 'text' }] }],
};
const q = (sql: string, params?: unknown[]) => owner.query(sql, params);
const messages = async (x: JsonSource) => (await jsonSourceFindings([x], q)).map((f) => `${f.severity}: ${f.message}`);
const make = async (x: JsonSource) => { for (const d of jsonSourceDdl(x, { app: 'hr', grants: [], replace: true })) await owner.query(d); };

before(async () => {
  await owner.query('drop table if exists hr.t146_doc cascade');
  await owner.query('create table hr.t146_doc (id int primary key, doc jsonb)');
  await make(SOURCE);
});
after(async () => {
  await owner.query('drop table if exists hr.t146_doc cascade');
  await closePools();
});

describe('JSON source views against their profile', () => {
  test('views made from the profile: nothing to report', async () => {
    assert.deepEqual(await messages(SOURCE), []);
  });

  test('a column added to the profile, one removed, one retyped', async () => {
    const added = { ...SOURCE, columns: [...SOURCE.columns, { name: 'since', path: ['since'], type: 'date' as const }] };
    const [m] = await messages(added);
    assert.match(m, /^warning: View hr\.t146_doc_v is out of date with the profile: no column since\. .*Create views makes it again/);
    assert.match((await messages({ ...SOURCE, columns: [SOURCE.columns[0]] }))[0], /column n isn't in the profile/);
    assert.match((await messages({ ...SOURCE, columns: [SOURCE.columns[0], { ...SOURCE.columns[1], type: 'numeric' }] }))[0], /n is integer, the profile says numeric/);
  });

  test('a path or a read-only flag changed: the trigger writes back other paths', async () => {
    const moved = { ...SOURCE, columns: [SOURCE.columns[0], { ...SOURCE.columns[1], path: ['b', 'n'] }] };
    assert.match((await messages(moved))[0], /hr\.t146_doc_v .*writes back other paths/);
    const ro = { ...SOURCE, columns: [{ ...SOURCE.columns[0], readonly: true }, SOURCE.columns[1]] };
    assert.match((await messages(ro))[0], /writes back other paths/);
    const tags = { ...SOURCE, arrays: [{ ...SOURCE.arrays[0], path: ['labels'] }] };
    const m = await messages(tags);
    assert.equal(m.length, 1);
    assert.match(m[0], /hr\.t146_doc_tags .*writes back other paths/);
  });

  test('a missing view is an error, a view made by hand a warning; Create views clears both', async () => {
    await owner.query('drop view hr.t146_doc_tags');
    assert.match((await messages(SOURCE))[0], /^error: View hr\.t146_doc_tags doesn't exist/);
    await owner.query(`create view hr.t146_doc_tags as select id, 'x'::text as row_key, 1 as position, 'y'::text as tag from hr.t146_doc`);
    assert.match((await messages(SOURCE))[0], /^warning: View hr\.t146_doc_tags wasn't made by this JSON source/);
    await make(SOURCE);
    assert.deepEqual(await messages(SOURCE), []);
  });

  test('odd entries in json_sources are skipped, not thrown', async () => {
    assert.deepEqual(await jsonSourceFindings([null, 1, { name: 'X' }], q), []);
    assert.deepEqual(await jsonSourceFindings(null, q), []);
  });

  test('the HR application: EMP_PROFILE matches its views, and an edited profile shows in advise()', async () => {
    const hr = (await owner.one(`select id, json_sources from meta.app where alias = 'hr'`));
    const ours = (f: { field: string }) => f.field.startsWith('JSON source ');
    assert.deepEqual((await advise(hr.id)).findings.filter(ours), []);
    const c = await owner.pool.connect();
    try {
      await c.query('begin');
      const edited = (hr.json_sources as JsonSource[]).map((x) => (x.name === 'EMP_PROFILE' ? { ...x, columns: x.columns.slice(1) } : x));
      await c.query('update meta.app set json_sources = $2 where id = $1', [hr.id, JSON.stringify(edited)]);
      const found = (await advise(hr.id, c)).findings.filter(ours);
      assert.equal(found.length, 1);
      assert.match(found[0].message, /isn't in the profile/);
    } finally {
      await c.query('rollback');
      c.release();
    }
  });
});
