// Sprint 149 (WS-6 leftover; migration 144): running instances inside parallel branches move to a newer version.
// The main path at its join and each open branch at its own step are mapped and checked with the same rules; the
// branches' join and split are renamed through the mapping; the instance then finishes on the new version.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { runWorkflows, type Step } from '../src/workflow.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
let defId: number;
const NAME = 'TEST149_SPLIT';

const V1: Step[] = [
  { name: 'SPLIT', type: 'parallel', branches: ['A', 'B'], join: 'J' },
  { name: 'A', type: 'wait', for: '1 hour', next: 'J' },
  { name: 'B', type: 'wait', for: '1 hour', next: 'J' },
  { name: 'J', type: 'join' },
  { name: 'END', type: 'end' },
] as Step[];
const V2: Step[] = [
  { name: 'SPLIT2', type: 'parallel', branches: ['A2', 'B'], join: 'J2' },
  { name: 'A2', type: 'wait', for: '1 hour', next: 'J2' },
  { name: 'B', type: 'wait', for: '1 hour', next: 'J2' },
  { name: 'J2', type: 'join' },
  { name: 'DONE', type: 'sql', code: "select 'v2' as finished_on" },
  { name: 'END', type: 'end' },
] as Step[];

async function cleanup() {
  await owner.query(`delete from meta.workflow where app_id = $1 and name = $2`, [appId, NAME]);
  await owner.query(`delete from meta.workflow_definition where app_id = $1 and name = $2`, [appId, NAME]);
  await owner.query(`delete from meta.workflow_migration where app_id = $1 and definition_name = $2`, [appId, NAME]);
}

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  await cleanup();
  defId = (await owner.one(`insert into meta.workflow_definition (app_id, name, title, admin_role, steps, version) values ($1, $2, 'Split test', 'admin', $3, '1') returning id`,
    [appId, NAME, JSON.stringify(V1)])).id;
});
after(async () => {
  await cleanup();
  await app.close();
  await closePools();
});

const start = () =>
  owner.tx(async (c) => {
    await c.query(`select set_config('pgkiln.app_id', $1, true), set_config('pgkiln.app_user', 'king', true)`, [String(appId)]);
    return (await c.query('select meta.start_workflow($1) as id', [NAME])).rows[0].id as string;
  });
async function settle() {
  for (let i = 0; i < 20; i++) await runWorkflows();
}
const wf = (id: string) => owner.one('select state, version, current_step, error, vars from meta.workflow where id = $1', [id]);
const branches = async (id: string) => (await owner.query(
  `select name, state, current_step, join_step, split_step from meta.workflow_branch where workflow_id = $1 order by id`, [id])).rows;
const preview = async (id: string, map: Record<string, string>) => (await owner.query(
  `select branch, from_step, to_step, problem from meta.migrate_workflows($1, '2', $2::bigint[], $3, false, 'admin')`, [defId, [id], map])).rows;

describe('migrating instances inside parallel branches', () => {
  let id: string;
  test('started on version 1: the main path waits at J, the branches at A and B', async () => {
    id = await start();
    await settle();
    assert.deepEqual([(await wf(id)).state, (await wf(id)).current_step], ['waiting', 'J']);
    assert.deepEqual((await branches(id)).map((b) => `${b.name}:${b.state}:${b.current_step}`), ['A:waiting:A', 'B:waiting:B']);
    // version 2 is activated while it runs
    await owner.query(`update meta.workflow_definition set inactive_versions = $2, steps = $3, version = '2' where id = $1`,
      [defId, JSON.stringify([{ version: '1', steps: V1 }]), JSON.stringify(V2)]);
  });

  test('every position is mapped and checked: a join stays a join, a branch not onto its join, none unmapped', async () => {
    const ok = await preview(id, { J: 'J2', A: 'A2', B: 'B' });
    assert.deepEqual(ok.map((r) => `${r.branch ?? 'main'} ${r.from_step}→${r.to_step} ${r.problem ?? 'ready'}`), ['main J→J2 ready', 'A A→A2 ready', 'B B→B ready']);
    const bad = await preview(id, { J: 'DONE', A: 'A2' });
    assert.match(bad[0].problem, /waits at a join: DONE must be a join step/);
    assert.match(bad[1].problem, /ends at the join J: version 2 has no join step DONE/);
    assert.match(bad[2].problem, /no step of version 2 is mapped to B/);
    // a waiting branch stays at a step of its kind (an active one also can't be mapped onto its own join)
    assert.match((await preview(id, { J: 'J2', A: 'J2', B: 'B' }))[1].problem, /waits at a wait step: J2 must be a wait step/);
    assert.match((await preview(id, { J: 'J2', A: 'DONE', B: 'B' }))[1].problem, /waits at a wait step: DONE must be a wait step/);
    await assert.rejects(owner.query(`select * from meta.migrate_workflows($1, '2', $2::bigint[], $3, true, 'admin')`, [defId, [id], { J: 'J2', A: 'J2', B: 'B' }]),
      /Nothing was migrated: instance \d+ \(branch A\) waits at a wait step: J2 must be a wait step/);
    // an active branch (not waiting at its wait step) can't be put onto its own join
    await owner.query(`update meta.workflow_branch set state = 'active' where workflow_id = $1 and name = 'A'`, [id]);
    try {
      assert.match((await preview(id, { J: 'J2', A: 'J2', B: 'B' }))[1].problem, /can't be mapped onto its own join J2/);
    } finally {
      await owner.query(`update meta.workflow_branch set state = 'waiting' where workflow_id = $1 and name = 'A'`, [id]);
    }
    assert.equal((await wf(id)).version, '1', 'nothing moved');
    assert.deepEqual((await branches(id)).map((b) => b.current_step), ['A', 'B']);
  });

  test('the builder shows the branches\' steps to map and a row per path; applying moves the whole instance', async () => {
    const dev = new Browser(app);
    await dev.get('/builder/login');
    await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
    const base = `/builder/apps/${appId}/shared/workflow_definition/${defId}/migrate`;
    let page = (await dev.get(base)).body;
    assert.match(page, /branches at A, B/);
    for (const st of ['A', 'B', 'J']) assert.match(page, new RegExp(`<select name="m\\.${st}">`));
    page = (await dev.get(`${base}?preview=1&to=2&wf=${id}&m.J=J2&m.A=A2&m.B=B`)).body;
    assert.match(page, /<td data-label="Path">branch A<\/td>/);
    assert.match(page, /Migrate 1 instance\(s\)/, 'counted once, not per branch');
    const res = await dev.submit(base, { to: '2', wf: id, 'm.J': 'J2', 'm.A': 'A2', 'm.B': 'B' });
    assert.equal(res.statusCode, 303);
    const w = await wf(id);
    assert.deepEqual([w.version, w.current_step, w.state], ['2', 'J2', 'waiting']);
    assert.deepEqual((await branches(id)).map((b) => `${b.name}:${b.current_step}:${b.join_step}:${b.split_step}`), ['A:A2:J2:SPLIT2', 'B:B:J2:SPLIT2']);
    const ev = (await owner.query(`select detail from meta.workflow_event where workflow_id = $1 and event = 'migrated' order by id`, [id])).rows.map((r) => r.detail);
    assert.deepEqual(ev, ['version 1 → 2: J → J2 (by admin)', 'version 1 → 2: branch A: A → A2 (by admin)', 'version 1 → 2: branch B: B → B (by admin)']);
    const log = await owner.one(`select workflow_ids, mapping from meta.workflow_migration where definition_name = $1 order by id desc limit 1`, [NAME]);
    assert.deepEqual(log.workflow_ids, [id]);
  });

  test('then it finishes on version 2: the branches end at J2, the join lets the main path go on to DONE', async () => {
    await owner.query(`update meta.workflow_branch set wait_until = now() - interval '1 second' where workflow_id = $1`, [id]);
    await settle();
    const w = await wf(id);
    assert.equal(w.state, 'completed', w.error ?? '');
    assert.equal(w.vars.FINISHED_ON, 'v2');
    assert.ok((await branches(id)).every((b) => b.state === 'done'));
  });
});
