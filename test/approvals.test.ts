// Approvals and the task list, with the HR sample's LEAVE_APPROVAL tasks:
// allen and scott request leave; their managers (blake, jones) decide.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner, runtime } from '../src/db.ts';
import { mergeTasksSettings } from '../src/builder/region-settings.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
const leaveIds: number[] = [];
let day = 0;

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
});

after(async () => {
  await owner.query(`delete from meta.task where app_id = $1 and detail_pk = any($2::text[])`, [appId, leaveIds.map(String)]);
  await owner.query('delete from hr.leave_request where id = any($1)', [leaveIds]);
  await app.close();
  await closePools();
});

/** Run SQL as if in the HR app, signed in as `user` (the leave request triggers create and close tasks). */
const asUser = <T>(user: string, fn: (c: any) => Promise<T>) =>
  owner.tx(async (c) => {
    await c.query(`select set_config('pgkiln.app_id', $1, true), set_config('pgkiln.app_user', $2, true)`, [String(appId), user]);
    return fn(c);
  });

/** A new leave request (a weekday in 2027, a different one each time) and its task. */
async function requestLeave(user: string) {
  const id = await asUser(user, async (c) => {
    // a Monday-to-Wednesday stretch that doesn't overlap earlier requests of this run
    const start = new Date(Date.UTC(2027, 2, 1 + 7 * day++));
    const end = new Date(start.getTime() + 2 * 86400_000);
    return (await c.query('select hr.request_leave($1::date, $2::date, $3) as id', [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10), 'test'])).rows[0].id as number;
  });
  leaveIds.push(id);
  const task = await owner.one(`select * from meta.task where app_id = $1 and detail_pk = $2`, [appId, String(id)]);
  return { id, task };
}

async function as(user: string) {
  const b = new Browser(app);
  await b.login(user);
  return b;
}
/** POST a task action from the task list page, as a browser would. */
async function act(b: Browser, taskId: string, action: string, extra: Record<string, string> = {}) {
  await b.get('/a/hr/14');
  const res = await b.post(`/a/hr/tasks/${taskId}`, { __csrf: b.lastCsrf, action, next: '/a/hr/14', ...extra });
  assert.equal(res.statusCode, 303);
  const page = (await b.get('/a/hr/14')).body;
  return { ok: /alert-success/.exec(page) ? /alert alert-success" role="status">([^<]*)/.exec(page)![1] : null, error: /alert alert-error" role="alert">([^<]*)/.exec(page)?.[1] ?? null };
}
const taskRow = (id: string) => owner.one('select state, outcome, actual_owner, completed_by from meta.task where id = $1', [id]);
const events = async (id: string) => (await owner.query('select event, username, detail from meta.task_event where task_id = $1 order by id', [id])).rows.map((e) => `${e.event}:${e.username}${e.detail ? `:${e.detail}` : ''}`);

describe('approvals', () => {
  test('a leave request creates a task for the manager, with subject, due date and history', async () => {
    const { task } = await requestLeave('allen');
    assert.match(task.subject, /^Leave for Allen: 3 day\(s\) from \d\d [A-Z][a-z]{2} 2027$/);
    assert.deepEqual(task.owner_users, ['blake']);
    assert.equal(task.initiator, 'allen');
    assert.equal(task.state, 'unassigned');
    assert.ok(task.due_at > task.created_at);
    assert.deepEqual(await events(task.id), ['created:allen']);
  });

  test('the manager approves in the task list; the decision is made by the definition\'s SQL', async () => {
    const { id, task } = await requestLeave('allen');
    const blake = await as('blake');
    const list = (await blake.get('/a/hr/14')).body;
    assert.match(list, new RegExp(`Leave for Allen`));
    assert.match(list, /value="approve"/);
    const r = await act(blake, task.id, 'approve', { comment: 'Enjoy!' });
    assert.equal(r.error, null);
    assert.equal(r.ok, 'Approved.');
    assert.deepEqual(await taskRow(task.id), { state: 'completed', outcome: 'approved', actual_owner: 'blake', completed_by: 'blake' });
    const leave = await owner.one('select status, decided_by, decision_note from hr.leave_request where id = $1', [id]);
    assert.deepEqual(leave, { status: 'APPROVED', decided_by: 'blake', decision_note: 'Enjoy!' });
    assert.deepEqual(await events(task.id), ['created:allen', 'approved:blake:Enjoy!']);
  });

  test('who may do what: others see nothing, the initiator cannot decide, forged posts change nothing', async () => {
    const { task } = await requestLeave('allen');
    // scott is no participant: not in his list, and a forged post is refused
    const scott = await as('scott');
    assert.doesNotMatch((await scott.get('/a/hr/14')).body, /Leave for Allen/);
    assert.match((await act(scott, task.id, 'approve')).error ?? '', /cannot complete this task|not found/);
    // allen sees it under "Requested by me" but cannot approve his own request
    const allen = await as('allen');
    const page = (await allen.get('/a/hr/14')).body;
    assert.match(page, /Leave for Allen/);
    assert.match((await act(allen, task.id, 'approve')).error ?? '', /cannot complete this task/);
    // a wrong CSRF token does nothing
    await allen.get('/a/hr/14');
    await allen.post(`/a/hr/tasks/${task.id}`, { __csrf: 'forged', action: 'cancel', next: '/a/hr/14' });
    assert.equal((await taskRow(task.id)).state, 'unassigned');
    // the runtime and the app role read tasks only through meta.tasks
    await assert.rejects(runtime.query('select * from meta.task'), /permission denied/);
  });

  test('claim, release, delegate; an error in the action SQL undoes the decision', async () => {
    const { id, task } = await requestLeave('allen');
    const blake = await as('blake');
    await act(blake, task.id, 'claim');
    assert.deepEqual(await taskRow(task.id), { state: 'assigned', outcome: null, actual_owner: 'blake', completed_by: null });
    await act(blake, task.id, 'release');
    assert.equal((await taskRow(task.id)).state, 'unassigned');
    // only the owner (or an administrator) may delegate: claim it again first
    assert.match((await act(blake, task.id, 'delegate', { to: 'scott' })).error ?? '', /cannot delegate this task/);
    await act(blake, task.id, 'claim');
    assert.match((await act(blake, task.id, 'delegate', { to: 'nobody-like-this' })).error ?? '', /is not a user of this application/);
    assert.match((await act(blake, task.id, 'delegate', { to: 'allen' })).error ?? '', /cannot go to the person who requested it/);
    await act(blake, task.id, 'delegate', { to: 'scott' });
    assert.equal((await taskRow(task.id)).actual_owner, 'scott');
    // scott may now approve the task, but the action SQL fails: row level security hides allen's
    // request from him (and hr.decide_leave would refuse a non-manager). Nothing changes.
    const scott = await as('scott');
    const r = await act(scott, task.id, 'approve');
    assert.match(r.error ?? '', /Leave request \d+ not found|Only a manager of this employee can decide/);
    assert.deepEqual(await taskRow(task.id), { state: 'assigned', outcome: null, actual_owner: 'scott', completed_by: null });
    assert.equal((await owner.one('select status from hr.leave_request where id = $1', [id])).status, 'PENDING');
    assert.deepEqual((await events(task.id)).map((e) => e.split(':')[0]), ['created', 'claimed', 'released', 'claimed', 'delegated']);
  });

  test('comments; the initiator cancels; deciding on the leave page closes the task', async () => {
    const a = await requestLeave('allen');
    const allen = await as('allen');
    await act(allen, a.task.id, 'comment', { text: 'Please decide before Friday' });
    await act(allen, a.task.id, 'cancel');
    assert.equal((await taskRow(a.task.id)).state, 'cancelled');
    assert.deepEqual(await events(a.task.id), ['created:allen', 'commented:allen:Please decide before Friday', 'cancelled:allen']);

    const b = await requestLeave('scott');
    assert.deepEqual(b.task.owner_users, ['jones']);
    // jones rejects on the leave request page (hr.decide_leave), not in the task list
    await asUser('jones', (c) => c.query(`select hr.decide_leave($1, 'REJECTED', 'busy')`, [b.id]).catch(async (e: Error) => {
      // decide_leave checks has_role/is_manager_of through the session; jones is scott's manager
      throw e;
    }));
    assert.deepEqual(await taskRow(b.task.id), { state: 'completed', outcome: 'rejected', actual_owner: null, completed_by: 'jones' });
    assert.deepEqual((await events(b.task.id)).map((e) => e.split(':')[0]), ['created', 'closed']);
  });

  test('task list settings and the builder', async () => {
    assert.deepEqual(mergeTasksSettings({ x: 1, context: 'admin' }, { context: '', completed: 'true', empty: ' ' }), { x: 1, completed: true });
    assert.deepEqual(mergeTasksSettings({}, { context: 'initiated' }), { context: 'initiated' });
    const dev = new Browser(app);
    await dev.get('/builder/login');
    await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
    const def = await owner.one(`select id from meta.task_definition where app_id = $1 and name = 'LEAVE_APPROVAL'`, [appId]);
    const page = (await dev.get(`/builder/apps/${appId}/shared?c=task_definition-${def.id}`)).body;
    assert.match(page, /On completion \(SQL\)/);
    assert.match(page, /hr\.decide_leave/);
    const region = await owner.one(`select r.id, r.page_id from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 14 order by r.seq limit 1`, [appId]);
    assert.match((await dev.get(`/builder/pages/${region.page_id}?c=region-${region.id}`)).body, /Task list settings/);
    const doc = (await owner.one(`select meta.export_app('hr') as d`)).d;
    assert.equal(doc.task_definitions[0].name, 'LEAVE_APPROVAL');
  });
});
