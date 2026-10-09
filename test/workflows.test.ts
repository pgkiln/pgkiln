// Workflows: the engine (src/workflow.ts), the console region, the builder,
// with the HR example's ONBOARDING workflow and a few test definitions.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { runWorkflows, stepProblems, stepWarnings, workflowDiagram, type Step } from '../src/workflow.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
const EMPS = [9901, 9902, 9903];

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  await cleanup();
  // new hires reporting to blake: one with a high salary (needs access), one without
  await owner.query(`insert into hr.emp (empno, ename, job, mgr, hiredate, sal, deptno) values
    (9901, 'NEWHIGH', 'ANALYST', 7698, current_date, 3000, 30), (9902, 'NEWLOW', 'CLERK', 7698, current_date, 1000, 30), (9903, 'NEWOTHER', 'CLERK', 7698, current_date, 1000, 30)`);
  const def = (name: string, steps: unknown) =>
    owner.query(`insert into meta.workflow_definition (app_id, name, title, admin_role, steps) values ($1, $2, 'Test &N.', 'admin', $3)`, [appId, name, JSON.stringify(steps)]);
  await def('TEST_FAULT', [{ name: 'DIVIDE', type: 'sql', code: 'select 10 / (:N::int) as result' }, { name: 'END', type: 'end' }]);
  await def('TEST_WAIT', [{ name: 'PAUSE', type: 'wait', for: '1 second' }, { name: 'AFTER', type: 'sql', code: "select 'done' as status" }]);
  // parallel branches: the first one wins; nested, with a failing step; an end step in a branch
  await def('TEST_ANY', [
    { name: 'SPLIT', type: 'parallel', branches: ['SLOW', 'FAST'], join: 'FIRST' },
    { name: 'SLOW', type: 'task', task: 'ONBOARD_ACCESS', next: 'FIRST' },
    { name: 'FAST', type: 'sql', code: "select 'fast' as winner", next: 'FIRST' },
    { name: 'FIRST', type: 'join', wait_for: 'any' },
    { name: 'END', type: 'end' },
  ]);
  await def('TEST_NESTED', [
    { name: 'OUTER', type: 'parallel', branches: ['X', 'INNER'], join: 'J1' },
    { name: 'X', type: 'sql', code: 'select 10 / (:N::int) as r', next: 'J1' },
    { name: 'INNER', type: 'parallel', branches: ['Y', 'Z'], join: 'J2' },
    { name: 'Y', type: 'sql', code: 'select 1 as y', next: 'J2' },
    { name: 'Z', type: 'sql', code: 'select 2 as z', next: 'J2' },
    { name: 'J2', type: 'join', next: 'J1' },
    { name: 'J1', type: 'join' },
    { name: 'TOTAL', type: 'sql', code: 'select :Y::int + :Z::int + :R::int as total' },
  ]);
  await def('TEST_BRANCH_END', [
    { name: 'SPLIT', type: 'parallel', branches: ['CHECK', 'LONG'], join: 'J' },
    { name: 'CHECK', type: 'switch', cases: [{ when: ':STOP::boolean', next: 'END' }], otherwise: 'J' },
    { name: 'LONG', type: 'wait', for: '1 hour', next: 'J' },
    { name: 'J', type: 'join' },
    { name: 'DONE', type: 'sql', code: 'select true as done_flag' },
    { name: 'END', type: 'end' },
  ]);
  await def('TEST_VERSIONS', [{ name: 'PAUSE', type: 'wait', for: '1 hour' }, { name: 'A', type: 'sql', code: "select 'v1' as ran" }]);
});

async function cleanup() {
  await owner.query(`delete from meta.task where app_id = $1 and (detail_pk = any($2::text[]) or workflow_id in (select id from meta.workflow where name like 'TEST_%'))`, [appId, EMPS.map(String)]);
  await owner.query(`delete from meta.workflow where app_id = $1 and (detail_pk = any($2::text[]) or name like 'TEST_%')`, [appId, EMPS.map(String)]);
  await owner.query(`delete from meta.workflow_definition where app_id = $1 and name like 'TEST_%'`, [appId]);
  await owner.query(`delete from hr.notification where message like 'New%is ready to start.'`);
  await owner.query('delete from hr.emp where empno = any($1)', [EMPS]);
}

after(async () => {
  await cleanup();
  await app.close();
  await closePools();
});

/** Start a workflow as `user` in the HR app (what a page process does). */
const start = (user: string, name: string, detail: string | null, vars: Record<string, unknown>) =>
  owner.tx(async (c) => {
    await c.query(`select set_config('pgkiln.app_id', $1, true), set_config('pgkiln.app_user', $2, true)`, [String(appId), user]);
    return (await c.query('select meta.start_workflow($1, $2, $3) as id', [name, detail, vars])).rows[0].id as string;
  });
/**
 * Run workflows until this one stops moving. Another pgkiln server on the same database (e.g. a
 * running `npm run dev`) may take steps too: the engine locks each instance, so wait for the state.
 */
async function settle(id: string) {
  for (let i = 0; i < 50; i++) {
    await runWorkflows();
    const w = await owner.one('select state from meta.workflow where id = $1', [id]);
    if (!w || w.state !== 'active') return;
    await new Promise((r) => setTimeout(r, 100));
  }
}
const wf = (id: string) => owner.one('select state, current_step, waiting_task::text, error, vars, version from meta.workflow where id = $1', [id]);
/** What meta.workflows shows `user` about a workflow. */
const viewAs = (user: string, id: string) =>
  owner.tx(async (c) => {
    await c.query(`select set_config('pgkiln.app_id', $1, true), set_config('pgkiln.app_user', $2, true)`, [String(appId), user]);
    return (await c.query('select version, active_steps from meta.workflows where id = $1', [id])).rows[0];
  });
const openTasks = async (id: string) =>
  (await owner.query(`select id::text, subject, owner_users from meta.task where workflow_id = $1 and state in ('unassigned', 'assigned') order by id`, [id])).rows;
const events = async (id: string) => (await owner.query('select step, event from meta.workflow_event where workflow_id = $1 order by id', [id])).rows.map((e) => `${e.step ?? '-'}:${e.event}`);

async function as(user: string) {
  const b = new Browser(app);
  await b.login(user);
  return b;
}
async function post(b: Browser, url: string, form: Record<string, string>) {
  await b.get('/a/hr/14');
  await b.post(url, { __csrf: b.lastCsrf, next: '/a/hr/14', ...form });
  const page = (await b.get('/a/hr/14')).body;
  return /alert alert-error" role="alert">([^<]*)/.exec(page)?.[1] ?? null;
}

describe('workflow definitions', () => {
  test('steps are checked: names, types, targets, intervals, task definitions', async () => {
    // version 1 of the HR example's ONBOARDING (part 11); part 18 made version 2 active
    const def = await owner.one(`select steps, version, inactive_versions from meta.workflow_definition where app_id = $1 and name = 'ONBOARDING'`, [appId]);
    const hr = def.inactive_versions.find((v: any) => v.version === '1').steps;
    assert.deepEqual(stepProblems(hr, new Set(['ONBOARD_PREPARE', 'ONBOARD_ACCESS'])), []);
    assert.deepEqual(stepProblems(hr, new Set(['ONBOARD_PREPARE'])), ['Step 3 (ACCESS): task definition ONBOARD_ACCESS doesn\'t exist.']);
    assert.equal(def.version, '2');
    assert.deepEqual(stepProblems(def.steps, new Set(['ONBOARD_PREPARE', 'ONBOARD_ACCESS'])), []);
    const bad = stepProblems([
      { name: 'a', type: 'sql', code: 'select 1' },
      { name: 'B', type: 'loop' },
      { name: 'C', type: 'wait', for: 'soon' },
      { name: 'C', type: 'end' },
      { name: 'D', type: 'task', task: 'X', next: { approved: 'NOWHERE', maybe: 'C' } },
      { name: 'E', type: 'switch', cases: [{ when: 'true' }] },
    ]);
    for (const re of [/"name" must be an upper-case name/, /"type" must be one of/, /"for" is an interval/, /name C is used twice/, /outcomes are approved/, /there is no step NOWHERE/, /"cases" is a list/])
      assert.ok(bad.some((p) => re.test(p)), String(re));
    assert.deepEqual(stepProblems([]), ['A workflow needs at least one step.']);
    const svg = String(workflowDiagram(hr as Step[]));
    for (const n of ['PREPARE', 'NEEDS_ACCESS', 'ACCESS', 'WELCOME', 'END']) assert.match(svg, new RegExp(`>${n}<`));
    assert.match(svg, />otherwise</);
    assert.doesNotMatch(svg, /style=/, 'no inline styles (CSP)');
  });

  test('parallel branches are checked: each reaches its own join, stays separate and inside', () => {
    const sql = (name: string, next?: string) => ({ name, type: 'sql', code: 'select 1', ...(next ? { next } : {}) });
    const ok = [
      { name: 'SPLIT', type: 'parallel', branches: ['A', 'B'], join: 'MEET' },
      sql('A', 'MEET'), sql('B', 'MEET'),
      { name: 'MEET', type: 'join', wait_for: 'any' },
      { name: 'END', type: 'end' },
    ];
    assert.deepEqual(stepProblems(ok), []);
    assert.deepEqual(stepWarnings(ok), []);
    const problems = (steps: unknown[]) => stepProblems(steps).join(' | ');
    // a branch that runs past the join
    assert.match(problems([ok[0], sql('A', 'END'), sql('B', 'MEET'), ok[3], ok[4]]), /branch A never reaches the join MEET/);
    // two branches through one step
    assert.match(problems([ok[0], sql('A', 'C'), sql('B', 'C'), sql('C', 'MEET'), ok[3], ok[4]]), /branches A and B both go through C/);
    // a join without a parallel step, a parallel step whose join isn't one
    assert.match(problems([sql('A'), { name: 'J', type: 'join' }]), /J: no parallel step joins here/);
    assert.match(problems([{ name: 'SPLIT', type: 'parallel', branches: ['A', 'B'], join: 'A' }, sql('A'), sql('B')]), /A is not a join step/);
    // into the join from outside the branches
    assert.match(problems([sql('X', 'MEET'), ...ok]), /X: goes to the join MEET from outside the branches of SPLIT/);
    // bad shapes
    assert.match(problems([{ name: 'SPLIT', type: 'parallel', branches: ['A'], join: 'MEET' }, sql('A', 'MEET'), ok[3]]), /at least two/);
    assert.match(problems([{ name: 'SPLIT', type: 'parallel', branches: ['A', 'A'], join: 'MEET' }, sql('A', 'MEET'), ok[3]]), /listed twice/);
    assert.match(problems([...ok.slice(0, 3), { name: 'MEET', type: 'join', wait_for: 'some' }]), /"wait_for" is all/);
    // nested parallel steps are fine
    assert.deepEqual(stepProblems([
      { name: 'OUTER', type: 'parallel', branches: ['X', 'INNER'], join: 'J1' },
      sql('X', 'J1'),
      { name: 'INNER', type: 'parallel', branches: ['Y', 'Z'], join: 'J2' },
      sql('Y', 'J2'), sql('Z', 'J2'),
      { name: 'J2', type: 'join', next: 'J1' },
      { name: 'J1', type: 'join' },
    ]), []);
    // never reached: an Advisor warning
    assert.deepEqual(stepWarnings([sql('A', 'END'), sql('LOST'), { name: 'END', type: 'end' }]), ['Step LOST is never reached.']);
    const svg = String(workflowDiagram(ok as Step[], { active: ['A', 'B'] }));
    assert.match(svg, /wf-edge wf-edge-branch/);
    assert.match(svg, /join \(any\)/);
    assert.equal(svg.match(/wf-active/g)?.length, 2);
  });
});

describe('running workflows', () => {
  test('onboarding with a high salary: the workplace and access in parallel, then welcome; the console shows it', async () => {
    const id = await start('king', 'ONBOARDING', '9901', { ENAME: 'Newhigh', SAL: 3000 });
    await settle(id);
    const w1 = await wf(id);
    assert.deepEqual([w1.state, w1.current_step, w1.version], ['waiting', 'READY', '2'], 'the main path waits at the join');
    const open1 = await openTasks(id);
    assert.deepEqual(open1.map((t) => t.subject), ['Prepare the workplace of Newhigh', 'Give Newhigh access to HR Demo'], 'both branches have their task');
    assert.deepEqual(open1[0].owner_users, ['blake']);
    assert.deepEqual(await viewAs('king', id), { version: '2', active_steps: ['PREPARE', 'ACCESS'] });
    const console1 = (await (await as('king')).get('/a/hr/14')).body;
    assert.match(console1, /at PREPARE, ACCESS/, 'the console shows both steps');
    assert.match(console1, /class="wf-node wf-task wf-active"/);

    // the administrator gives access first: the join still waits for the workplace
    assert.equal(await post(await as('king'), `/a/hr/tasks/${open1[1].id}`, { action: 'complete' }), null);
    await settle(id);
    assert.deepEqual([(await wf(id)).state, (await openTasks(id)).length], ['waiting', 1]);
    // blake completes his task in the task list; the trigger wakes the branch, and the join goes on
    assert.equal(await post(await as('blake'), `/a/hr/tasks/${open1[0].id}`, { action: 'complete' }), null);
    await settle(id);
    const done = await wf(id);
    assert.equal(done.state, 'completed');
    assert.equal(done.vars.TASK_APPROVER, 'blake');
    assert.ok(done.vars.WELCOMED_AT, 'the sql step\'s column became a variable');
    assert.ok(await owner.one(`select 1 from hr.notification where username = 'blake' and message = 'Newhigh is ready to start.'`));
    assert.deepEqual(await events(id), [
      '-:started', 'SPLIT:split', 'PREPARE:task', 'IT:step', 'ACCESS:task', 'ACCESS:step', 'PREPARE:step', 'READY:joined', 'WELCOME:step', 'END:completed',
    ]);
    assert.deepEqual((await owner.query(`select name, state from meta.workflow_branch where workflow_id = $1 order by id`, [id])).rows, [
      { name: 'PREPARE', state: 'done' }, { name: 'IT', state: 'done' },
    ]);
    const console_ = (await (await as('king')).get('/a/hr/14')).body;
    assert.match(console_, /Onboarding of Newhigh/);
    assert.match(console_, /completed/);
    assert.match(console_, /version 2/);
  });

  test('a low salary skips the access task: its branch is done at once', async () => {
    const id = await start('king', 'ONBOARDING', '9902', { ENAME: 'Newlow', SAL: 1000 });
    await settle(id);
    const tasks = await openTasks(id);
    assert.equal(tasks.length, 1);
    assert.equal(await post(await as('blake'), `/a/hr/tasks/${tasks[0].id}`, { action: 'complete' }), null);
    await settle(id);
    assert.equal((await wf(id)).state, 'completed');
    assert.ok((await events(id)).includes('IT:step'));
    assert.ok(!(await events(id)).includes('ACCESS:task'));
  });

  test('a failing step faults the workflow; an administrator retries it', async () => {
    const id = await start('allen', 'TEST_FAULT', null, { N: 0 });
    await settle(id);
    const w = await wf(id);
    assert.equal(w.state, 'faulted');
    assert.match(w.error, /division by zero/);
    // allen started it but isn't an administrator: he may terminate, not retry
    assert.match(await post(await as('allen'), `/a/hr/workflows/${id}`, { action: 'retry' }) ?? '', /cannot retry/);
    await owner.query(`update meta.workflow set vars = '{"N": 2}' where id = $1`, [id]);
    assert.equal(await post(await as('king'), `/a/hr/workflows/${id}`, { action: 'retry' }), null);
    await settle(id);
    const ok = await wf(id);
    assert.equal(ok.state, 'completed');
    assert.equal(ok.vars.RESULT, 5);
    assert.deepEqual((await events(id)).map((e) => e.split(':')[1]), ['started', 'faulted', 'retried', 'step', 'completed']);
  });

  test('waits, terminating, and a cancelled task', async () => {
    const wait = await start('allen', 'TEST_WAIT', null, {});
    await settle(wait);
    assert.equal((await wf(wait)).state, 'waiting');
    await runWorkflows();
    assert.equal((await wf(wait)).state, 'waiting', 'not before the time');
    await new Promise((r) => setTimeout(r, 1100));
    await settle(wait);
    for (let i = 0; i < 20 && (await wf(wait)).state === 'waiting'; i++) (await runWorkflows(), await new Promise((r) => setTimeout(r, 100)));
    assert.deepEqual([(await wf(wait)).state, (await wf(wait)).vars.STATUS], ['completed', 'done']);

    // terminate: the initiator may; its open task is cancelled. Others can't even see it.
    const t1 = await start('king', 'ONBOARDING', '9903', { ENAME: 'Newother', SAL: 1000 });
    await settle(t1);
    const task1 = (await openTasks(t1))[0].id;
    assert.match(await post(await as('allen'), `/a/hr/workflows/${t1}`, { action: 'terminate' }) ?? '', /cannot terminate/);
    assert.doesNotMatch((await (await as('allen')).get('/a/hr/14')).body, /Onboarding of Newother/);
    assert.equal(await post(await as('king'), `/a/hr/workflows/${t1}`, { action: 'terminate' }), null);
    assert.equal((await wf(t1)).state, 'terminated');
    assert.equal((await owner.one('select state from meta.task where id = $1', [task1])).state, 'cancelled');

    // a cancelled task without a "cancelled" branch ends the workflow
    await owner.query(`delete from meta.workflow where id = $1`, [t1]);
    const t2 = await start('king', 'ONBOARDING', '9903', { ENAME: 'Newother', SAL: 1000 });
    await settle(t2);
    await post(await as('king'), `/a/hr/tasks/${(await openTasks(t2))[0].id}`, { action: 'cancel' });
    await settle(t2);
    assert.equal((await wf(t2)).state, 'terminated');
    assert.ok((await events(t2)).includes('PREPARE:terminated'));
  });

  test('the employee form starts onboarding when an employee is created', async () => {
    const proc = await owner.one(`select code from meta.process x join meta.page p on p.id = x.page_id where p.app_id = $1 and p.page_no = 3 and x.name = 'Start onboarding'`, [appId]);
    assert.match(proc.code, /meta\.start_workflow\('ONBOARDING', :P3_EMPNO/);
  });
});

describe('parallel branches', () => {
  test('wait_for any: the first branch to arrive goes on; the others are cancelled with their tasks', async () => {
    const id = await start('king', 'TEST_ANY', null, { N: 1 });
    await settle(id);
    const w = await wf(id);
    assert.equal(w.state, 'completed');
    assert.equal(w.vars.WINNER, 'fast');
    assert.deepEqual((await owner.query(`select name, state from meta.workflow_branch where workflow_id = $1 order by id`, [id])).rows, [
      { name: 'SLOW', state: 'cancelled' }, { name: 'FAST', state: 'done' },
    ]);
    assert.deepEqual(await openTasks(id), [], 'the slow branch\'s task is cancelled');
    assert.equal((await owner.one(`select state from meta.task where workflow_id = $1`, [id])).state, 'cancelled');
    const ev = await events(id);
    for (const e of ['SPLIT:split', 'SLOW:task', 'FAST:step', 'SLOW:cancelled', 'FIRST:joined', 'END:completed']) assert.ok(ev.includes(e), e);
  });

  test('nested branches; a failing branch faults the workflow while the others go on, and a retry resumes it', async () => {
    const id = await start('king', 'TEST_NESTED', null, { N: 0 });
    await settle(id);
    const w = await wf(id);
    assert.equal(w.state, 'faulted');
    assert.match(w.error, /^X: division by zero/);
    assert.equal(w.current_step, 'J1', 'the main path waits at the outer join');
    assert.equal(w.vars.Y, 1, 'the inner branches went on');
    assert.equal(w.vars.Z, 2);
    const branches = async () => (await owner.query(`select name, state from meta.workflow_branch where workflow_id = $1 order by id`, [id])).rows.map((b) => `${b.name}:${b.state}`);
    assert.deepEqual(await branches(), ['X:faulted', 'INNER:done', 'Y:done', 'Z:done']);
    assert.deepEqual(await viewAs('king', id), { version: '1', active_steps: ['X'] });
    // king is an administrator (admin_role 'admin'): he retries; the failed branch runs again
    await owner.query(`update meta.workflow set vars = vars || '{"N": 2}' where id = $1`, [id]);
    assert.equal(await post(await as('king'), `/a/hr/workflows/${id}`, { action: 'retry' }), null);
    await settle(id);
    const done = await wf(id);
    assert.equal(done.state, 'completed');
    assert.equal(done.vars.TOTAL, 8);
    assert.deepEqual(await branches(), ['X:done', 'INNER:done', 'Y:done', 'Z:done']);
    const ev = await events(id);
    for (const e of ['OUTER:split', 'INNER:split', 'X:faulted', 'J2:joined', 'X:retried', 'J1:joined', 'TOTAL:step']) assert.ok(ev.includes(e), e);
  });

  test('an end step in a branch ends the workflow and cancels the other branches; terminating cancels them too', async () => {
    const id = await start('king', 'TEST_BRANCH_END', null, { STOP: true });
    await settle(id);
    const w = await wf(id);
    assert.equal(w.state, 'completed');
    assert.equal(w.vars.DONE_FLAG, undefined, 'the steps after the join did not run');
    assert.deepEqual((await owner.query(`select name, state from meta.workflow_branch where workflow_id = $1 order by id`, [id])).rows.map((b) => b.state), ['done', 'cancelled']);

    const t = await start('king', 'TEST_BRANCH_END', null, { STOP: false });
    await settle(t);
    assert.deepEqual(await viewAs('king', t), { version: '1', active_steps: ['LONG'] });
    assert.equal(await post(await as('king'), `/a/hr/workflows/${t}`, { action: 'terminate' }), null);
    assert.equal((await wf(t)).state, 'terminated');
    assert.deepEqual((await owner.query(`select state from meta.workflow_branch where workflow_id = $1 order by id`, [t])).rows.map((b) => b.state), ['done', 'cancelled']);
  });
});

describe('versions', () => {
  test('a new version is a copy; activating it moves the old one to history; running instances keep theirs', async () => {
    const d = await owner.one(`select id from meta.workflow_definition where app_id = $1 and name = 'TEST_VERSIONS'`, [appId]);
    const old = await start('king', 'TEST_VERSIONS', null, {});
    await settle(old);
    assert.deepEqual([(await wf(old)).state, (await wf(old)).version], ['waiting', '1']);

    assert.equal((await owner.one('select meta.new_workflow_version($1) as v', [d.id])).v, '2');
    const dev = await owner.one('select version, steps, dev_version, dev_steps from meta.workflow_definition where id = $1', [d.id]);
    assert.deepEqual([dev.version, dev.dev_version], ['1', '2']);
    assert.deepEqual(dev.dev_steps, dev.steps, 'a copy of the active version');
    await assert.rejects(owner.query('select meta.new_workflow_version($1)', [d.id]), /already has a version in development \(2\)/);
    // the development version changes; new instances still start the active one
    await owner.query(`update meta.workflow_definition set dev_steps = '[{"name": "A", "type": "sql", "code": "select ''v2'' as ran"}]' where id = $1`, [d.id]);
    assert.equal((await wf(await start('king', 'TEST_VERSIONS', null, {}))).version, '1');

    assert.equal((await owner.one('select meta.activate_workflow_version($1) as v', [d.id])).v, '2');
    const act = await owner.one('select version, activated_at, dev_version, inactive_versions from meta.workflow_definition where id = $1', [d.id]);
    assert.deepEqual([act.version, act.dev_version, !!act.activated_at], ['2', null, true]);
    assert.deepEqual(act.inactive_versions.map((v: any) => [v.version, v.steps.length, !!v.deactivated_at]), [['1', 2, true]]);
    const fresh = await start('king', 'TEST_VERSIONS', null, {});
    await settle(fresh);
    assert.deepEqual([(await wf(fresh)).state, (await wf(fresh)).version, (await wf(fresh)).vars.RAN], ['completed', '2', 'v2']);
    // the instance that started before goes on with version 1
    await owner.query('update meta.workflow set wait_until = now() where id = $1', [old]);
    await settle(old);
    assert.deepEqual([(await wf(old)).state, (await wf(old)).version, (await wf(old)).vars.RAN], ['completed', '1', 'v1']);

    // labels: free text, but unique within the definition
    await assert.rejects(owner.query(`select meta.new_workflow_version($1, '1')`, [d.id]), /already has a version 1/);
    await assert.rejects(owner.query(`select meta.new_workflow_version($1, 'x y')`, [d.id]), /check constraint/);
    assert.equal((await owner.one(`select meta.new_workflow_version($1, ' beta ') as v`, [d.id])).v, 'beta');
    await owner.query('select meta.discard_workflow_version($1)', [d.id]);
    assert.equal((await owner.one('select dev_version from meta.workflow_definition where id = $1', [d.id])).dev_version, null);
    await assert.rejects(owner.query('select meta.activate_workflow_version($1)', [d.id]), /no version in development/);
    assert.equal((await owner.one('select meta.new_workflow_version($1) as v', [d.id])).v, '3', 'the next whole number');
    await owner.query('select meta.discard_workflow_version($1)', [d.id]);
  });

  test('an export carries the versions; an older export without them imports as version 1', async () => {
    const doc = (await owner.one(`select meta.export_app('hr') as d`)).d;
    const onboarding = doc.workflow_definitions.find((w: any) => w.name === 'ONBOARDING');
    assert.equal(onboarding.version, '2');
    assert.deepEqual(onboarding.inactive_versions.map((v: any) => v.version), ['1']);
    for (const w of doc.workflow_definitions) for (const k of ['version', 'activated_at', 'dev_version', 'dev_steps', 'inactive_versions']) delete w[k];
    const id = (await owner.one(`select meta.import_app($1::jsonb, 'hr_wf_versions') as id`, [JSON.stringify(doc)])).id;
    try {
      const copy = await owner.one(`select version, inactive_versions from meta.workflow_definition where app_id = $1 and name = 'ONBOARDING'`, [id]);
      assert.deepEqual(copy, { version: '1', inactive_versions: [] });
    } finally {
      await owner.query('delete from meta.app where id = $1', [id]);
    }
  });
});

describe('builder', () => {
  test('the definition page draws the workflow; broken steps are not saved; the Advisor checks step SQL', async () => {
    const dev = new Browser(app);
    await dev.get('/builder/login');
    await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
    const def = await owner.one(`select id from meta.workflow_definition where app_id = $1 and name = 'ONBOARDING'`, [appId]);
    const page = (await dev.get(`/builder/apps/${appId}/shared?c=workflow_definition-${def.id}`)).body;
    assert.match(page, /<svg class="wf-diagram"/);
    assert.match(page, /Instances: /);
    await dev.get(`/builder/apps/${appId}/shared?new=workflow_definition`);
    await dev.submit(`/builder/apps/${appId}/shared/workflow_definition`, { name: 'TEST_BROKEN', title: 'x', steps: '[{"name": "A", "type": "sql"}]' });
    assert.equal(await owner.one(`select 1 from meta.workflow_definition where name = 'TEST_BROKEN'`), undefined);
    await owner.query(`insert into meta.workflow_definition (app_id, name, title, steps) values ($1, 'TEST_BADSQL', 'x', '[{"name": "A", "type": "sql", "code": "select nope from hr.emp"}]')`, [appId]);
    const { advise } = await import('../src/builder/advisor.ts');
    const r = await advise(appId);
    assert.ok(r.findings.some((f) => f.entry?.label === 'TEST_BADSQL' && /column "nope" does not exist/.test(f.message)));
    const doc = (await owner.one(`select meta.export_app('hr') as d`)).d;
    assert.ok(doc.workflow_definitions.some((w: any) => w.name === 'ONBOARDING'));
  });

  test('versions in the builder: the active steps are read-only; a new version is edited, then activated or discarded', async () => {
    const dev = new Browser(app);
    await dev.get('/builder/login');
    await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
    const d = await owner.one(`select id, steps, version from meta.workflow_definition where app_id = $1 and name = 'TEST_VERSIONS'`, [appId]);
    const url = `/builder/apps/${appId}/shared?c=workflow_definition-${d.id}`;
    const save = `/builder/apps/${appId}/shared/workflow_definition/${d.id}`;
    const versions = `${save}/versions`;
    const form = (steps: unknown) => ({ name: 'TEST_VERSIONS', title: 'Test &N.', description: '', admin_role: 'admin', steps: JSON.stringify(steps) });
    const changed = [{ name: 'B', type: 'sql', code: "select 'changed' as ran" }];
    const stepsNow = async () => owner.one('select version, steps, dev_version, dev_steps from meta.workflow_definition where id = $1', [d.id]);

    let page = (await dev.get(url)).body;
    assert.match(page, /<legend>Versions<\/legend>/);
    assert.match(page, new RegExp(`Steps of version ${d.version} \\(active, read-only\\)`));
    assert.match(page, /<textarea[^>]*name="steps"[^>]*readonly/);
    assert.match(page, /<textarea[^>]*name="steps"[^>]*>[^<]*&quot;PAUSE&quot;|<textarea[^>]*name="steps"[^>]*>[^<]*&quot;A&quot;/, 'the form shows the active steps');
    assert.match(page, /tag tag-info">active</);
    // the active version can't be changed; saving it unchanged (the other properties) can
    await dev.submit(save, form(changed));
    assert.deepEqual((await stepsNow()).steps, d.steps);
    assert.match((await dev.get(url)).body, new RegExp(`Version ${d.version} is active and can(&#39;|')t be changed`));
    assert.equal((await dev.submit(save, { ...form(d.steps), description: 'unchanged steps' })).statusCode, 303);
    assert.equal((await owner.one('select description from meta.workflow_definition where id = $1', [d.id])).description, 'unchanged steps');

    // labels are checked; a new version is a copy; saving edits it
    await dev.get(url);
    await dev.submit(versions, { action: 'new', version: '<b>x</b>' });
    assert.equal((await stepsNow()).dev_version, null);
    await dev.get(url);
    await dev.submit(versions, { action: 'new', version: 'next-1' });
    assert.equal((await stepsNow()).dev_version, 'next-1');
    page = (await dev.get(url)).body;
    assert.match(page, /Steps of version next-1 \(development, JSON\)/);
    assert.match(page, /tag tag-warning">development</);
    assert.doesNotMatch(page, /name="action" value="new"/, 'one development version at a time');
    await dev.submit(save, form(changed));
    assert.deepEqual([(await stepsNow()).steps, (await stepsNow()).dev_steps], [d.steps, changed]);
    assert.match((await dev.get(url)).body, /<textarea[^>]*name="steps"[^>]*>[^<]*&quot;B&quot;/, 'the form shows the development steps');

    // broken development steps are not activated
    await owner.query(`update meta.workflow_definition set dev_steps = '[{"name": "A", "type": "task", "task": "NO_SUCH_TASK"}]' where id = $1`, [d.id]);
    await dev.get(url);
    await dev.submit(versions, { action: 'activate' });
    assert.equal((await stepsNow()).version, d.version);
    assert.match((await dev.get(url)).body, /can&#39;t be activated|can't be activated/);
    await owner.query('update meta.workflow_definition set dev_steps = $2 where id = $1', [d.id, JSON.stringify(changed)]);
    await dev.get(url);
    await dev.submit(versions, { action: 'activate' });
    const active = await stepsNow();
    assert.deepEqual([active.version, active.steps, active.dev_version], ['next-1', changed, null]);
    page = (await dev.get(url)).body;
    assert.match(page, new RegExp(`<b>${d.version}</b></td>\\s*<td data-label="State"><span class="tag">inactive<`), 'the old version is history');

    // discard
    await dev.get(url);
    await dev.submit(versions, { action: 'new' });
    assert.match((await stepsNow()).dev_version, /^\d+$/, 'the next whole number');
    await dev.get(url);
    await dev.submit(versions, { action: 'discard' });
    assert.equal((await stepsNow()).dev_version, null);
    // other applications' definitions and unknown actions
    await dev.get(url);
    assert.equal((await dev.submit(`/builder/apps/${appId + 100000}/shared/workflow_definition/${d.id}/versions`, { action: 'new' })).statusCode, 404);
    assert.equal((await dev.submit(versions, { action: 'drop' })).statusCode, 400);
  });
});
