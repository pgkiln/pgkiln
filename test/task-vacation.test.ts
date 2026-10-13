// Sprint 64 (migration 094): vacation rules, and expiring, renewing and
// escalating overdue tasks, with the HR sample's LEAVE_APPROVAL tasks: allen
// requests leave, his manager blake decides; jones stands in for blake.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
let definition: { id: number; due_in: string | null; expiration: string | null; max_renewals: number | null; escalate_role: string | null };
const leaveIds: number[] = [];
let day = 0;

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  definition = (await owner.one(`select id, due_in, expiration, max_renewals, escalate_role from meta.task_definition where app_id = $1 and name = 'LEAVE_APPROVAL'`, [appId]))!;
  await owner.query('delete from meta.task_vacation where app_id = $1', [appId]);
});

after(async () => {
  await owner.query('update meta.task_definition set due_in = $2, expiration = $3, max_renewals = $4, escalate_role = $5 where id = $1',
    [definition.id, definition.due_in, definition.expiration, definition.max_renewals, definition.escalate_role]);
  await owner.query('delete from meta.task_vacation where app_id = $1', [appId]);
  await owner.query(`delete from meta.task where app_id = $1 and detail_pk = any($2::text[])`, [appId, leaveIds.map(String)]);
  await owner.query('delete from hr.leave_request where id = any($1)', [leaveIds]);
  await app.close();
  await closePools();
});

const asUser = <T>(user: string, fn: (c: any) => Promise<T>) =>
  owner.tx(async (c) => {
    await c.query(`select set_config('pgkiln.app_id', $1, true), set_config('pgkiln.app_user', $2, true)`, [String(appId), user]);
    return fn(c);
  });

async function requestLeave(user = 'allen') {
  const id = await asUser(user, async (c) => {
    const start = new Date(Date.UTC(2028, 0, 3 + 7 * day++));
    const end = new Date(start.getTime() + 86400_000);
    return (await c.query('select hr.request_leave($1::date, $2::date, $3) as id', [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10), 'vacation test'])).rows[0].id as number;
  });
  leaveIds.push(id);
  return (await owner.one(`select * from meta.task where app_id = $1 and detail_pk = $2`, [appId, String(id)])) as { id: string };
}

const rights = (user: string, taskId: string) =>
  asUser(user, async (c) => (await c.query('select true as may_see, may_act, may_claim from meta.tasks where id = $1', [taskId])).rows[0] ?? null);
const events = async (id: string) => (await owner.query('select event, username, detail from meta.task_event where task_id = $1 order by id', [id])).rows.map((e) => `${e.event}:${e.username}${e.detail ? `:${e.detail}` : ''}`);
const setRule = (user: string, to: string, from: string, until: string) => asUser(user, (c) => c.query('select meta.set_vacation_rule($1, $2::timestamptz, $3::timestamptz)', [to, from, until]));

describe('vacation rules', () => {
  test('while the rule is active the delegate may act on the user\'s tasks; before and after it, not', async () => {
    const task = await requestLeave();
    assert.equal(await rights('jones', task.id), null, 'jones sees nothing without a rule');
    // a rule that starts tomorrow does nothing yet
    await setRule('blake', 'JONES', new Date(Date.now() + 86400_000).toISOString(), new Date(Date.now() + 5 * 86400_000).toISOString());
    assert.equal(await rights('jones', task.id), null);
    assert.equal((await owner.one('select delegate_to from meta.task_vacation where app_id = $1 and username = $2', [appId, 'blake'])).delegate_to, 'jones', 'stored lower case');
    // active now
    await setRule('blake', 'jones', new Date(Date.now() - 3600_000).toISOString(), new Date(Date.now() + 86400_000).toISOString());
    assert.deepEqual(await rights('jones', task.id), { may_see: true, may_act: true, may_claim: true });
    // claimed by blake: jones may still act for him (the actual owner is on vacation)
    await asUser('blake', (c) => c.query('select meta.claim_task($1)', [task.id]));
    assert.equal((await rights('jones', task.id))?.may_act, true);
    await asUser('jones', (c) => c.query(`select meta.complete_task($1, 'approved', 'for blake')`, [task.id]));
    assert.equal((await owner.one('select completed_by from meta.task where id = $1', [task.id])).completed_by, 'jones');
    // removed: no more access to new tasks
    await asUser('blake', (c) => c.query('select meta.clear_vacation_rule()'));
    const next = await requestLeave();
    assert.equal(await rights('jones', next.id), null);
  });

  test('the rule is checked: signed in, another user, ends after it starts and within a year', async () => {
    const now = Date.now();
    const iso = (d: number) => new Date(now + d * 86400_000).toISOString();
    for (const [user, to, from, until, msg] of [
      ['nobody', 'jones', iso(0), iso(1), /Sign in/],
      ['blake', '', iso(0), iso(1), /Name the user/],
      ['blake', 'Blake', iso(0), iso(1), /yourself/],
      ['blake', 'jones', iso(2), iso(1), /ends after it starts/],
      ['blake', 'jones', iso(-5), iso(-1), /in the future/],
      ['blake', 'jones', iso(0), iso(400), /at most a year/],
    ] as const)
      await assert.rejects(setRule(user, to, from, until), msg);
  });

  test('the task list shows the rule form and saves whole days; others\' rules stay theirs', async () => {
    const b = new Browser(app);
    await b.login('blake');
    const page = (await b.get('/a/hr/14')).body;
    assert.match(page, /<details class="task-vacation">/);
    assert.match(page, /action="\/a\/hr\/tasks\/vacation"/);
    const today = new Date().toISOString().slice(0, 10);
    const later = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);
    const res = await b.post('/a/hr/tasks/vacation', { __csrf: b.lastCsrf, action: 'set', to: 'jones', from: today, until: later, next: '/a/hr/14' });
    assert.equal(res.statusCode, 303);
    const after = (await b.get('/a/hr/14')).body;
    assert.match(after, /Vacation rule saved/);
    assert.match(after, /jones acts on your tasks from/);
    const rule = await owner.one(`select (ends_at - starts_at) = interval '4 days' as four from meta.task_vacation where app_id = $1 and username = 'blake'`, [appId]);
    assert.equal(rule.four, true, 'from the start of the first day to the end of the last');
    // without the CSRF token: nothing
    await b.post('/a/hr/tasks/vacation', { action: 'clear', next: '/a/hr/14' });
    assert.ok(await owner.one(`select 1 as ok from meta.task_vacation where app_id = $1 and username = 'blake'`, [appId]));
    await b.get('/a/hr/14');
    await b.post('/a/hr/tasks/vacation', { __csrf: b.lastCsrf, action: 'clear', next: '/a/hr/14' });
    assert.equal(await owner.one(`select 1 as ok from meta.task_vacation where app_id = $1 and username = 'blake'`, [appId]), undefined);
  });
});

describe('expiration policies', () => {
  const overdue = (id: string) => owner.query(`update meta.task set due_at = now() - interval '1 minute' where id = $1`, [id]);
  const policy = (expiration: string | null, extra: { max_renewals?: number; escalate_role?: string } = {}) =>
    owner.query(`update meta.task_definition set due_in = '2 days', expiration = $2, max_renewals = $3, escalate_role = $4 where id = $1`,
      [definition.id, expiration, extra.max_renewals ?? null, extra.escalate_role ?? null]);
  const tick = async () => (await owner.one('select meta.task_expire_tick() as n')).n as number;
  const row = (id: string) => owner.one('select state, outcome, priority, renewals, actual_owner, owner_roles, due_at > now() as future, escalated_at is not null as escalated from meta.task where id = $1', [id]);

  test('none: an overdue task stays open', async () => {
    await policy(null);
    const task = await requestLeave();
    await overdue(task.id);
    await tick();
    assert.equal((await row(task.id)).state, 'unassigned');
  });

  test('expire: the task ends as expired, without an outcome; the task list shows it as done', async () => {
    await policy('expire');
    const task = await requestLeave();
    await overdue(task.id);
    assert.ok((await tick()) >= 1);
    const r = await row(task.id);
    assert.deepEqual([r.state, r.outcome], ['expired', null]);
    assert.deepEqual((await events(task.id)).slice(-1), ['expired:system']);
    assert.equal((await rights('blake', task.id))?.may_act ?? false, false);
  });

  test('renew: the due date moves on, up to the maximum, then the task expires', async () => {
    await policy('renew', { max_renewals: 2 });
    const task = await requestLeave();
    for (const n of [1, 2]) {
      await overdue(task.id);
      await tick();
      const r = await row(task.id);
      assert.deepEqual([r.state, r.renewals, r.future], ['unassigned', n, true]);
    }
    await overdue(task.id);
    await tick();
    assert.equal((await row(task.id)).state, 'expired');
    assert.deepEqual((await events(task.id)).filter((e) => e !== 'created:allen'), ['renewed:system:1 of 2', 'renewed:system:2 of 2', 'expired:system']);
  });

  test('escalate: once, to the escalation role, priority 1, unassigned with a new due date; overdue again it expires', async () => {
    await policy('escalate', { escalate_role: 'HR_ADMIN' });
    const task = await requestLeave();
    await asUser('blake', (c) => c.query('select meta.claim_task($1)', [task.id]));
    await overdue(task.id);
    await tick();
    const r = await row(task.id);
    assert.deepEqual([r.state, r.actual_owner, r.priority, r.future, r.escalated], ['unassigned', null, 1, true, true]);
    assert.ok(r.owner_roles.includes('hr_admin'));
    await overdue(task.id);
    await tick();
    assert.equal((await row(task.id)).state, 'expired');
    assert.deepEqual((await events(task.id)).filter((e) => e.endsWith(':system') || e.includes(':system:')), ['escalated:system:HR_ADMIN', 'expired:system']);
  });

  test('the builder checks the policy: a due date first, a role to escalate to', async () => {
    const { COMPONENTS } = await import('../src/builder/components.ts');
    const v = COMPONENTS.task_definition.validate!;
    assert.match(String(v({ expiration: 'expire' })), /Due in/);
    assert.match(String(v({ expiration: 'escalate', due_in: '1 day' })), /Escalation role/);
    assert.match(String(v({ expiration: 'renew', due_in: '1 day', max_renewals: 500 })), /1 to 100/);
    assert.equal(v({ expiration: 'renew', due_in: '1 day', max_renewals: 5 }), null);
  });
});
