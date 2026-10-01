// Workflows: the engine (src/workflow.ts), the console region, the builder,
// with the HR example's ONBOARDING workflow and a few test definitions.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { runWorkflows, stepProblems, workflowDiagram, type Step } from '../src/workflow.ts';
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
    await c.query(`select set_config('pgapex.app_id', $1, true), set_config('pgapex.app_user', $2, true)`, [String(appId), user]);
    return (await c.query('select meta.start_workflow($1, $2, $3) as id', [name, detail, vars])).rows[0].id as string;
  });
/**
 * Run workflows until this one stops moving. Another pgapex server on the same database (e.g. a
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
const wf = (id: string) => owner.one('select state, current_step, waiting_task::text, error, vars from meta.workflow where id = $1', [id]);
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
    const hr = (await owner.one(`select steps from meta.workflow_definition where app_id = $1 and name = 'ONBOARDING'`, [appId])).steps;
    assert.deepEqual(stepProblems(hr, new Set(['ONBOARD_PREPARE', 'ONBOARD_ACCESS'])), []);
    assert.deepEqual(stepProblems(hr, new Set(['ONBOARD_PREPARE'])), ['Step 3 (ACCESS): task definition ONBOARD_ACCESS doesn\'t exist.']);
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
});

describe('running workflows', () => {
  test('onboarding with a high salary: manager task, access task, welcome; the console shows it', async () => {
    const id = await start('king', 'ONBOARDING', '9901', { ENAME: 'Newhigh', SAL: 3000 });
    await settle(id);
    const w1 = await wf(id);
    assert.equal(w1.state, 'waiting');
    assert.equal(w1.current_step, 'PREPARE');
    const prepare = await owner.one('select subject, owner_users, workflow_id::text from meta.task where id = $1', [w1.waiting_task]);
    assert.deepEqual(prepare, { subject: 'Prepare the workplace of Newhigh', owner_users: ['blake'], workflow_id: id });

    // blake completes his task in the task list; the trigger wakes the workflow
    assert.equal(await post(await as('blake'), `/a/hr/tasks/${w1.waiting_task}`, { action: 'complete' }), null);
    await settle(id);
    const w2 = await wf(id);
    assert.equal(w2.current_step, 'ACCESS', 'salary 3000 needs access');
    assert.equal(w2.vars.TASK_OUTCOME, 'COMPLETED');
    assert.equal(w2.vars.TASK_APPROVER, 'blake');

    // an administrator gives access
    assert.equal(await post(await as('king'), `/a/hr/tasks/${w2.waiting_task}`, { action: 'complete' }), null);
    await settle(id);
    const done = await wf(id);
    assert.equal(done.state, 'completed');
    assert.ok(done.vars.WELCOMED_AT, 'the sql step\'s column became a variable');
    assert.ok(await owner.one(`select 1 from hr.notification where username = 'blake' and message = 'Newhigh is ready to start.'`));
    assert.deepEqual(await events(id), [
      '-:started', 'PREPARE:task', 'PREPARE:step', 'NEEDS_ACCESS:step', 'ACCESS:task', 'ACCESS:step', 'WELCOME:step', 'END:completed',
    ]);
    const console_ = (await (await as('king')).get('/a/hr/14')).body;
    assert.match(console_, /Onboarding of Newhigh/);
    assert.match(console_, /completed/);
  });

  test('a low salary skips the access task', async () => {
    const id = await start('king', 'ONBOARDING', '9902', { ENAME: 'Newlow', SAL: 1000 });
    await settle(id);
    const w = await wf(id);
    assert.equal(await post(await as('blake'), `/a/hr/tasks/${w.waiting_task}`, { action: 'complete' }), null);
    await settle(id);
    assert.equal((await wf(id)).state, 'completed');
    assert.ok((await events(id)).includes('NEEDS_ACCESS:step'));
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
    const task1 = (await wf(t1)).waiting_task;
    assert.match(await post(await as('allen'), `/a/hr/workflows/${t1}`, { action: 'terminate' }) ?? '', /cannot terminate/);
    assert.doesNotMatch((await (await as('allen')).get('/a/hr/14')).body, /Onboarding of Newother/);
    assert.equal(await post(await as('king'), `/a/hr/workflows/${t1}`, { action: 'terminate' }), null);
    assert.equal((await wf(t1)).state, 'terminated');
    assert.equal((await owner.one('select state from meta.task where id = $1', [task1])).state, 'cancelled');

    // a cancelled task without a "cancelled" branch ends the workflow
    await owner.query(`delete from meta.workflow where id = $1`, [t1]);
    const t2 = await start('king', 'ONBOARDING', '9903', { ENAME: 'Newother', SAL: 1000 });
    await settle(t2);
    await post(await as('king'), `/a/hr/tasks/${(await wf(t2)).waiting_task}`, { action: 'cancel' });
    await settle(t2);
    assert.equal((await wf(t2)).state, 'terminated');
    assert.ok((await events(t2)).includes('PREPARE:terminated'));
  });

  test('the employee form starts onboarding when an employee is created', async () => {
    const proc = await owner.one(`select code from meta.process x join meta.page p on p.id = x.page_id where p.app_id = $1 and p.page_no = 3 and x.name = 'Start onboarding'`, [appId]);
    assert.match(proc.code, /meta\.start_workflow\('ONBOARDING', :P3_EMPNO/);
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
});
