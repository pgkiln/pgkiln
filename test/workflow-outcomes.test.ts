// (123) Workflows and approvals, APEX 26.2: custom task outcomes, task events and notifications
// (src/task-events.ts), the send_mail and draft steps, migrating running instances to a newer
// version, and the diagram as an SVG file. With the HR example's SALARY_CHANGE (part 67).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { runTaskHooks } from '../src/task-events.ts';
import { outcomeMap, runWorkflows, stepProblems, workflowDiagram, type Step } from '../src/workflow.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
let defId: number;
const EMPNO = 7499;
let salBefore: string;

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  defId = (await owner.one(`select id from meta.workflow_definition where app_id = $1 and name = 'SALARY_CHANGE'`, [appId])).id;
  salBefore = (await owner.one('select sal::text from hr.emp where empno = $1', [EMPNO])).sal;
  await cleanup();
});

async function cleanup() {
  await owner.query(`delete from meta.task where app_id = $1 and (definition_id in (select id from meta.task_definition where app_id = $1 and name like 'TEST123_%')
                       or workflow_id in (select id from meta.workflow where name = 'SALARY_CHANGE' or name like 'TEST123_%'))`, [appId]);
  await owner.query(`delete from meta.task where app_id = $1 and definition_id = (select id from meta.task_definition where app_id = $1 and name = 'SALARY_DECISION')`, [appId]);
  await owner.query(`delete from meta.workflow where app_id = $1 and (name = 'SALARY_CHANGE' or name like 'TEST123_%')`, [appId]);
  await owner.query(`delete from meta.workflow_definition where app_id = $1 and name like 'TEST123_%'`, [appId]);
  await owner.query(`delete from meta.task_definition where app_id = $1 and name like 'TEST123_%'`, [appId]);
  await owner.query(`delete from meta.workflow_migration where app_id = $1`, [appId]);
  await owner.query(`delete from hr.notification where message like 'Salary change of %' or message like 'test123%'`);
  await owner.query(`delete from meta.mail_queue where app_id = $1 and (template in ('SALARY_TASK', 'SALARY_CHANGED') or subject like 'test123%')`, [appId]);
  await owner.query('update hr.emp set sal = $2 where empno = $1', [EMPNO, salBefore]);
}

after(async () => {
  await cleanup();
  await app.close();
  await closePools();
});

const asUser = (user: string) =>
  owner.tx(async (c) => {
    await c.query(`select set_config('pgkiln.app_id', $1, true), set_config('pgkiln.app_user', $2, true)`, [String(appId), user]);
    return c;
  });
/** Start a workflow as `user` (what a page process does). */
const start = (user: string, name: string, detail: string | null, vars: Record<string, unknown>) =>
  owner.tx(async (c) => {
    await c.query(`select set_config('pgkiln.app_id', $1, true), set_config('pgkiln.app_user', $2, true)`, [String(appId), user]);
    return (await c.query('select meta.start_workflow($1, $2, $3) as id', [name, detail, vars])).rows[0].id as string;
  });
async function settle(id: string) {
  for (let i = 0; i < 50; i++) {
    await runWorkflows();
    const w = await owner.one('select state from meta.workflow where id = $1', [id]);
    if (!w || w.state !== 'active') return;
    await new Promise((r) => setTimeout(r, 100));
  }
}
const wf = (id: string) => owner.one('select state, current_step, waiting_task::text, error, vars, version, steps from meta.workflow where id = $1', [id]);
const events = async (id: string) => (await owner.query('select step, event, detail from meta.workflow_event where workflow_id = $1 order by id', [id])).rows;

async function appUser(user: string) {
  const b = new Browser(app);
  await b.login(user);
  return b;
}
async function developer() {
  const b = new Browser(app);
  await b.get('/builder/login');
  await b.submit('/builder/login', { username: 'admin', password: 'admin' });
  return b;
}
/** Act on a task in the task list (page 14); returns the error shown, or null. */
async function act(b: Browser, task: string, action: string, extra: Record<string, string> = {}) {
  await b.get('/a/hr/14');
  await b.post(`/a/hr/tasks/${task}`, { __csrf: b.lastCsrf, next: '/a/hr/14', action, ...extra });
  const page = (await b.get('/a/hr/14')).body;
  return /alert alert-error" role="alert">([^<]*)/.exec(page)?.[1] ?? null;
}

describe('custom task outcomes', () => {
  test('the definition\'s outcomes are the buttons; a switch branches on them; Undecided asks again', async () => {
    const id = await start('blake', 'SALARY_CHANGE', String(EMPNO), { ENAME: 'Allen', NEW_SAL: 1777 });
    await settle(id);
    let w = await wf(id);
    assert.deepEqual([w.state, w.current_step, w.version], ['waiting', 'APPROVE', '2']);
    const first = w.waiting_task;
    const king = await appUser('king');
    const page = (await king.get('/a/hr/14')).body;
    assert.match(page, new RegExp(`<button class="btn to-success" form="tk\\d+_${first}" name="action" value="outcome:yes">Yes</button>`));
    assert.match(page, new RegExp(`value="outcome:no">No</button>`));
    assert.match(page, new RegExp(`<button class="btn to-warning" form="tk\\d+_${first}" name="action" value="outcome:undecided">Undecided</button>`));
    assert.doesNotMatch(page, new RegExp(`form="tk\\d+_${first}" name="action" value="approve"`), 'no Approve button: the definition has its own outcomes');

    // Undecided: the switch goes back to the task step, a new task
    assert.equal(await act(king, first, 'outcome:undecided', { comment: 'need numbers' }), null);
    assert.deepEqual(await owner.one('select state, outcome from meta.task where id = $1', [first]), { state: 'completed', outcome: 'undecided' });
    assert.match((await owner.one(`select detail from meta.task_event where task_id = $1 and event = 'completed'`, [first])).detail, /^Undecided: need numbers$/);
    await settle(id);
    w = await wf(id);
    assert.equal(w.current_step, 'APPROVE');
    assert.notEqual(w.waiting_task, first);
    assert.equal(w.vars.TASK_OUTCOME, 'UNDECIDED');
    assert.ok((await events(id)).some((e) => e.step === 'DECIDE' && e.detail === 'outcome UNDECIDED'));

    // Yes: the salary is applied and the employee gets an e-mail (the send_mail step of version 2)
    assert.equal(await act(king, w.waiting_task, 'outcome:yes'), null);
    await settle(id);
    w = await wf(id);
    assert.equal(w.state, 'completed', w.error);
    assert.equal((await owner.one('select sal::text from hr.emp where empno = $1', [EMPNO])).sal, '1777.00');
    const mail = await owner.one(`select to_addresses, subject, body_text from meta.mail_queue where app_id = $1 and template = 'SALARY_CHANGED' order by id desc limit 1`, [appId]);
    assert.deepEqual(mail.to_addresses, ['allen@example.com']);
    assert.equal(mail.subject, 'Your salary changes to 1777');
    assert.match(mail.body_text, /approved by king/);
    assert.ok((await events(id)).some((e) => e.step === 'TELL' && /^mail \d+ to allen@example.com$/.test(e.detail)));
  });

  test('outcomes come from the definition only: unknown ones and the type\'s own are refused', async () => {
    const t = await owner.tx(async (c) => {
      await c.query(`select set_config('pgkiln.app_id', $1, true), set_config('pgkiln.app_user', 'blake', true)`, [String(appId)]);
      return (await c.query(`select meta.create_task('SALARY_DECISION', $1, '{"ENAME": "Allen", "NEW_SAL": 1}') as id`, [String(EMPNO)])).rows[0].id as string;
    });
    const king = await appUser('king');
    assert.match(String(await act(king, t, 'outcome:maybe')), /cannot end as maybe/);
    assert.match(String(await act(king, t, 'approve')), /cannot end as approved/);
    assert.equal((await owner.one('select state from meta.task where id = $1', [t])).state, 'unassigned');
    await assert.rejects(owner.tx(async (c) => {
      await c.query(`select set_config('pgkiln.app_id', $1, true), set_config('pgkiln.app_user', 'king', true)`, [String(appId)]);
      await c.query(`select meta.close_tasks('SALARY_DECISION', $1, 'perhaps')`, [String(EMPNO)]);
    }), /Invalid outcome perhaps/);
    // close_tasks takes a custom outcome
    const n = await owner.tx(async (c) => {
      await c.query(`select set_config('pgkiln.app_id', $1, true), set_config('pgkiln.app_user', 'king', true)`, [String(appId)]);
      return (await c.query(`select meta.close_tasks('SALARY_DECISION', $1, 'NO') as n`, [String(EMPNO)])).rows[0].n;
    });
    assert.equal(n, 1);
    assert.deepEqual(await owner.one('select state, outcome from meta.task where id = $1', [t]), { state: 'completed', outcome: 'no' });
    // the database checks the definition's outcomes
    await assert.rejects(owner.query(`update meta.task_definition set outcomes = '[{"name": "OK", "colour": "pink"}]' where app_id = $1 and name = 'SALARY_DECISION'`, [appId]), /check constraint/);
    await assert.rejects(owner.query(`update meta.task_definition set outcomes = '[{"name": "expired"}]' where app_id = $1 and name = 'SALARY_DECISION'`, [appId]), /check constraint/);
  });

  test('steps are checked against the task definitions\' outcomes', () => {
    const outcomes = outcomeMap([{ name: 'SALARY_DECISION', type: 'approval', outcomes: [{ name: 'YES' }, { name: 'NO' }] }, { name: 'PLAIN', type: 'approval' }]);
    const tasks = new Set(['SALARY_DECISION', 'PLAIN']);
    const ok: Step[] = [
      { name: 'ASK', type: 'task', task: 'SALARY_DECISION', next: { YES: 'END', no: 'END', expired: 'END' } },
      { name: 'D', type: 'switch', cases: [{ outcome: 'yes', next: 'END' }] },
      { name: 'END', type: 'end' },
    ];
    assert.deepEqual(stepProblems(ok, tasks, { outcomes }), []);
    const bad = stepProblems([
      { name: 'ASK', type: 'task', task: 'SALARY_DECISION', next: { approved: 'END' } },
      { name: 'P', type: 'task', task: 'PLAIN', next: { yes: 'END' } },
      { name: 'D', type: 'switch', cases: [{ outcome: 'MAYBE', next: 'END' }] },
      { name: 'E', type: 'switch', cases: [{ when: 'true', outcome: 'YES', next: 'END' }] as never },
      { name: 'END', type: 'end' },
    ], tasks, { outcomes });
    for (const re of [/ASK\): task definition SALARY_DECISION has no outcome approved/, /P\): task definition PLAIN has no outcome yes/, /D\): no task of this workflow ends as MAYBE/, /E\): "cases" is a list/])
      assert.ok(bad.some((p) => re.test(p)), `${re}: ${bad.join(' | ')}`);
  });

  test('the builder checks outcomes, events and notifications', async () => {
    const dev = await developer();
    const d = await owner.one(`select id from meta.task_definition where app_id = $1 and name = 'SALARY_DECISION'`, [appId]);
    const url = `/builder/apps/${appId}/shared?c=task_definition-${d.id}`;
    const page = (await dev.get(url)).body;
    assert.match(page, /name="outcomes"/);
    assert.match(page, /name="events"/);
    assert.match(page, /name="notifications"/);
    assert.match(page, /name="fail_recovery"/);
    const save = `/builder/apps/${appId}/shared/task_definition/${d.id}`;
    const form = { name: 'SALARY_DECISION', type: 'approval', subject: 'Salary of &ENAME. to &NEW_SAL.', owner_roles: 'admin', admin_role: 'admin', priority: '2', due_in: '5 days' };
    for (const [field, value, re] of [
      ['outcomes', '[{"name": "YES", "colour": "pink"}]', /the colour is default, primary, success, danger, warning/],
      ['outcomes', '[{"name": "YES"}, {"name": "yes"}]', /listed twice/],
      ['events', '[{"on": "never", "type": "sql", "code": "select 1"}]', /&quot;on&quot; is complete, expire, fail/],
      ['events', '[{"on": "complete", "type": "mail", "to": "x@example.com"}]', /give a &quot;template&quot;, or a &quot;subject&quot; and a &quot;body&quot;/],
      ['notifications', '{"created": "X"}', /&quot;created&quot; is not create, complete or expire/],
    ] as const) {
      await dev.get(url);
      await dev.submit(save, { ...form, [field]: value });
      const body = (await dev.get(url)).body;
      assert.match(body, re, `${field}: ${/alert alert-error" role="alert">([^<]*)/.exec(body)?.[1]}`);
    }
    const now = await owner.one('select outcomes from meta.task_definition where id = $1', [d.id]);
    assert.equal(now.outcomes.length, 3, 'unchanged');
  });
});

describe('task events and notifications', () => {
  test('create: the owners get the template; complete: the event SQL runs as the application, after the commit', async () => {
    const id = await start('blake', 'SALARY_CHANGE', String(EMPNO), { ENAME: 'Allen', NEW_SAL: 1650 });
    await settle(id);
    const task = (await wf(id)).waiting_task;
    assert.ok(await owner.one(`select 1 as ok from meta.task_hook where task_id = $1 and event = 'create' and done_at is null`, [task]));
    assert.ok((await runTaskHooks()) >= 1);
    const mail = await owner.one(`select to_addresses, subject from meta.mail_queue where app_id = $1 and template = 'SALARY_TASK' order by id desc limit 1`, [appId]);
    // the potential owners: the application's users with role admin
    assert.deepEqual(mail.to_addresses.sort(), ['demo@example.com', 'king@example.com']);
    assert.equal(mail.subject, 'To decide: Salary of Allen to 1650');
    const king = await appUser('king');
    assert.equal(await act(king, task, 'outcome:no'), null);
    await runTaskHooks();
    assert.ok(await owner.one(`select 1 as ok from hr.notification where username = 'blake' and message = 'Salary change of Allen: no.'`));
    assert.ok(await owner.one(`select 1 as ok from meta.task_hook where task_id = $1 and event = 'complete' and done_at is not null and error is null`, [task]));
    await settle(id);
    assert.equal((await wf(id)).state, 'completed');
    assert.equal((await owner.one('select sal::text from hr.emp where empno = $1', [EMPNO])).sal, '1777.00', 'No: not applied');
  });

  test('fail: the completion SQL fails; the fail actions run; reopen (default) or complete', async () => {
    await owner.query(`insert into meta.task_definition (app_id, name, type, subject, owner_roles, action_code, events)
      values ($1, 'TEST123_FAIL', 'action', 'test123 fail &N.', '{admin}', 'do $b$ begin raise exception ''test123 budget exceeded''; end $b$',
              '[{"on": "fail", "type": "mail", "to": "hr-desk@example.com", "subject": "test123 failed: #SUBJECT#", "body": "Error: #ERROR# by #APPROVER#"}]')`, [appId]);
    const create = (n: number) => owner.tx(async (c) => {
      await c.query(`select set_config('pgkiln.app_id', $1, true), set_config('pgkiln.app_user', 'blake', true)`, [String(appId)]);
      return (await c.query(`select meta.create_task('TEST123_FAIL', null, $1) as id`, [{ N: n }])).rows[0].id as string;
    });
    const king = await appUser('king');
    const t1 = await create(1);
    assert.match(String(await act(king, t1, 'complete')), /could not be completed: test123 budget exceeded/);
    assert.equal((await owner.one('select state from meta.task where id = $1', [t1])).state, 'unassigned', 'reopened');
    assert.ok(await owner.one(`select 1 as ok from meta.task_event where task_id = $1 and event = 'failed' and detail = 'test123 budget exceeded'`, [t1]));
    const m = await owner.one(`select to_addresses, subject, body_text from meta.mail_queue where app_id = $1 and subject = 'test123 failed: test123 fail 1'`, [appId]);
    assert.deepEqual(m.to_addresses, ['hr-desk@example.com']);
    assert.equal(m.body_text, 'Error: test123 budget exceeded by king');
    // complete: the decision stands without the SQL's effect
    await owner.query(`update meta.task_definition set fail_recovery = 'complete' where app_id = $1 and name = 'TEST123_FAIL'`, [appId]);
    const t2 = await create(2);
    assert.match(String(await act(king, t2, 'complete')), /test123 budget exceeded/);
    assert.deepEqual(await owner.one('select state, outcome from meta.task where id = $1', [t2]), { state: 'completed', outcome: 'completed' });
    // without fail events or a recovery an error still undoes the decision, as before
    await owner.query(`update meta.task_definition set fail_recovery = null, events = null where app_id = $1 and name = 'TEST123_FAIL'`, [appId]);
    const t3 = await create(3);
    assert.match(String(await act(king, t3, 'complete')), /test123 budget exceeded/);
    assert.equal((await owner.one('select state from meta.task where id = $1', [t3])).state, 'unassigned');
    assert.equal(await owner.one(`select 1 as ok from meta.task_event where task_id = $1 and event = 'failed'`, [t3]), undefined);
  });

  test('expire: the event starts a workflow; a failing hook is retried and keeps its error', async () => {
    await owner.query(`insert into meta.workflow_definition (app_id, name, title, steps) values ($1, 'TEST123_FOLLOW_UP', 'Follow-up &REASON.', '[{"name": "NOTE", "type": "sql", "code": "select :REASON as reason, :TASK_ID as task"}]')`, [appId]);
    await owner.query(`insert into meta.task_definition (app_id, name, type, subject, owner_roles, due_in, expiration, events)
      values ($1, 'TEST123_EXPIRE', 'action', 'test123 expire', '{admin}', '1 day', 'expire',
              '[{"on": "expire", "type": "workflow", "workflow": "TEST123_FOLLOW_UP", "vars": {"REASON": "late &SUBJECT."}},
                {"on": "complete", "type": "sql", "code": "select nope from hr.emp"}]')`, [appId]);
    const t = await owner.tx(async (c) => {
      await c.query(`select set_config('pgkiln.app_id', $1, true), set_config('pgkiln.app_user', 'blake', true)`, [String(appId)]);
      return (await c.query(`select meta.create_task('TEST123_EXPIRE') as id`)).rows[0].id as string;
    });
    await owner.query(`update meta.task set due_at = now() - interval '1 minute' where id = $1`, [t]);
    await owner.query('select meta.task_expire_tick()');
    assert.equal((await owner.one('select state from meta.task where id = $1', [t])).state, 'expired');
    await runTaskHooks();
    const w = await owner.one(`select id::text, title, initiator, vars from meta.workflow where app_id = $1 and name = 'TEST123_FOLLOW_UP'`, [appId]);
    assert.equal(w.title, 'Follow-up late test123 expire');
    assert.equal(w.initiator, 'blake');
    assert.equal(w.vars.TASK_ID, t);
    // a complete event that fails: three attempts, then it stays with its error
    const t2 = await owner.tx(async (c) => {
      await c.query(`select set_config('pgkiln.app_id', $1, true), set_config('pgkiln.app_user', 'blake', true)`, [String(appId)]);
      return (await c.query(`select meta.create_task('TEST123_EXPIRE') as id`)).rows[0].id as string;
    });
    assert.equal(await act(await appUser('king'), t2, 'complete'), null);
    for (let i = 0; i < 4; i++) await runTaskHooks();
    const h = await owner.one(`select attempts, done_at is not null as done, error from meta.task_hook where task_id = $1 and event = 'complete'`, [t2]);
    assert.deepEqual([h.attempts, h.done], [3, true]);
    assert.match(h.error, /column "nope" does not exist/);
  });
});

describe('draft steps', () => {
  test('allowed in a development version, refused in the active one and on activation, drawn dashed', async () => {
    const d = await owner.one('select dev_version, dev_steps from meta.workflow_definition where id = $1', [defId]);
    assert.equal(d.dev_version, '3');
    assert.equal(d.dev_steps[0].type, 'draft');
    await assert.rejects(owner.query('select meta.activate_workflow_version($1)', [defId]), /has draft steps \(BUDGET_CHECK\)/);
    await assert.rejects(owner.query(`update meta.workflow_definition set steps = dev_steps where id = $1`, [defId]), /workflow_definition_no_draft/);
    assert.deepEqual(stepProblems(d.dev_steps, new Set(['SALARY_DECISION'])), []);
    assert.ok(stepProblems(d.dev_steps, new Set(['SALARY_DECISION']), { drafts: false }).some((p) => /BUDGET_CHECK\): is a draft/.test(p)));
    const svg = workflowDiagram(d.dev_steps).toString();
    assert.match(svg, /<g class="wf-node wf-draft"><rect[^>]*\/>\s*<text[^>]*>BUDGET_CHECK<\/text>\s*<text[^>]*>draft: check the depart…<\/text>/);

    const dev = await developer();
    const url = `/builder/apps/${appId}/shared?c=workflow_definition-${defId}`;
    const page = (await dev.get(url)).body;
    assert.match(page, /Draft steps \(BUDGET_CHECK\) are placeholders/);
    assert.match(page, /name="action" value="activate" disabled/);
    await dev.submit(`/builder/apps/${appId}/shared/workflow_definition/${defId}/versions`, { action: 'activate' });
    assert.equal((await owner.one('select version from meta.workflow_definition where id = $1', [defId])).version, '2');
    assert.match((await dev.get(url)).body, /can&#39;t be activated: Step 1 \(BUDGET_CHECK\): is a draft/);
    // a new definition's steps are its active version: no drafts
    await dev.get(`/builder/apps/${appId}/shared?new=workflow_definition`);
    await dev.submit(`/builder/apps/${appId}/shared/workflow_definition`, { name: 'TEST123_DRAFTY', title: 'x', steps: '[{"name": "A", "type": "draft"}]' });
    assert.equal(await owner.one(`select 1 as ok from meta.workflow_definition where app_id = $1 and name = 'TEST123_DRAFTY'`, [appId]), undefined);
    // a draft reached by a running instance faults it (only possible through SQL)
    await owner.query(`insert into meta.workflow_definition (app_id, name, title, steps) values ($1, 'TEST123_RUN', 'x', '[{"name": "A", "type": "sql", "code": "select 1 as one"}]')`, [appId]);
    const w = await start('king', 'TEST123_RUN', null, {});
    await owner.query(`update meta.workflow set steps = '[{"name": "A", "type": "draft"}]' where id = $1`, [w]);
    await settle(w);
    assert.match((await wf(w)).error, /A is a draft/);
  });
});

describe('migrating running instances', () => {
  test('a running SALARY_CHANGE instance moves from version 1 to 2 at the same approval step, and goes on with version 2', async () => {
    const d = await owner.one('select inactive_versions from meta.workflow_definition where id = $1', [defId]);
    const v1 = d.inactive_versions.find((v: any) => v.version === '1').steps;
    const id = await start('blake', 'SALARY_CHANGE', String(EMPNO), { ENAME: 'Allen', NEW_SAL: 1888 });
    await settle(id);
    // as if it had started before version 2 was activated
    await owner.query(`update meta.workflow set version = '1', steps = $2 where id = $1`, [id, JSON.stringify(v1)]);
    const task = (await wf(id)).waiting_task;
    const other = await start('blake', 'SALARY_CHANGE', String(EMPNO), { ENAME: 'Allen', NEW_SAL: 1999 });
    await settle(other);
    await owner.query(`update meta.workflow set version = '1', steps = $2 where id = $1`, [other, JSON.stringify(v1)]);

    const dev = await developer();
    const defPage = (await dev.get(`/builder/apps/${appId}/shared?c=workflow_definition-${defId}`)).body;
    assert.match(defPage, new RegExp(`href="/builder/apps/${appId}/shared/workflow_definition/${defId}/migrate"`));
    const base = `/builder/apps/${appId}/shared/workflow_definition/${defId}/migrate`;
    let page = (await dev.get(base)).body;
    assert.match(page, /<option value="2" selected>2 \(active\)<\/option>/);
    assert.match(page, new RegExp(`name="wf" value="${id}" id="wf-${id}" checked`));
    assert.match(page, /<select name="m.APPROVE"><option value="">— no mapping —<\/option><option value="APPROVE" selected>APPROVE \(task\)/);
    // preview (GET: nothing changes): one instance, mapped to APPROVE
    page = (await dev.get(`${base}?preview=1&to=2&wf=${id}&m.APPROVE=APPROVE`)).body;
    assert.match(page, /<span class="tag tag-info">ready<\/span>/);
    assert.match(page, /Migrate 1 instance\(s\)/);
    assert.equal((await wf(id)).version, '1');
    // unmapped: refused, nothing changes
    page = (await dev.get(`${base}?preview=1&to=2&wf=${id}&m.APPROVE=`)).body;
    assert.match(page, /no step of version 2 is mapped to APPROVE/);
    assert.doesNotMatch(page, /Migrate 1 instance/);
    await dev.submit(base, { to: '2', wf: [id, other], 'm.APPROVE': '' });
    assert.equal((await wf(id)).version, '1');
    assert.equal((await wf(other)).version, '1');
    // a task step must stay a task step of the same definition
    page = (await dev.get(`${base}?preview=1&to=2&wf=${id}&m.APPROVE=APPLY`)).body;
    assert.match(page, /waits for a task: APPLY must be a task step/);

    // apply
    await dev.get(`${base}?preview=1&to=2&wf=${id}&m.APPROVE=APPROVE`);
    const res = await dev.submit(base, { to: '2', wf: id, 'm.APPROVE': 'APPROVE' });
    assert.equal(res.statusCode, 303);
    let w = await wf(id);
    assert.deepEqual([w.state, w.version, w.current_step, w.waiting_task], ['waiting', '2', 'APPROVE', task]);
    assert.ok(w.steps.some((s: Step) => s.name === 'TELL'), 'the steps of version 2');
    assert.equal((await wf(other)).version, '1', 'only the chosen instance');
    assert.match((await events(id)).at(-1).detail, /^version 1 → 2: APPROVE → APPROVE \(by admin\)$/);
    const log = await owner.one('select definition_name, to_version, mapping, workflow_ids, migrated_by from meta.workflow_migration where app_id = $1 order by id desc limit 1', [appId]);
    assert.deepEqual(log, { definition_name: 'SALARY_CHANGE', to_version: '2', mapping: { APPROVE: 'APPROVE' }, workflow_ids: [id], migrated_by: 'admin' });
    // again: it already runs version 2
    const again = (await owner.query(`select problem from meta.migrate_workflows($1, '2', $2::bigint[], '{"APPROVE": "APPROVE"}', false, 'admin')`, [defId, [id]])).rows[0].problem;
    assert.match(again, /runs version 2, which is not older than 2/);

    // the decision: version 2 goes on with its send_mail step
    assert.equal(await act(await appUser('king'), task, 'outcome:yes'), null);
    await settle(id);
    w = await wf(id);
    assert.equal(w.state, 'completed', w.error);
    assert.ok((await events(id)).some((e) => e.step === 'TELL'));
  });
});

describe('diagram export', () => {
  test('the whole model as an SVG file; PNG from it in the browser', async () => {
    const dev = await developer();
    const page = (await dev.get(`/builder/apps/${appId}/shared?c=workflow_definition-${defId}`)).body;
    assert.match(page, new RegExp(`<a class="btn btn-sm" href="/builder/apps/${appId}/shared/workflow_definition/${defId}/diagram.svg\\?v=3" download data-wf-svg>Download SVG</a>`));
    assert.match(page, /<button type="button" class="btn btn-sm" data-wf-png hidden>Download PNG<\/button>/);
    const res = await dev.get(`/builder/apps/${appId}/shared/workflow_definition/${defId}/diagram.svg?v=2`);
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type']), /^image\/svg\+xml/);
    assert.equal(res.headers['content-disposition'], 'attachment; filename="salary_change-v2.svg"');
    assert.match(String(res.headers['content-security-policy']), /sandbox/);
    assert.match(res.body, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<svg class="wf-diagram" xmlns="http:\/\/www.w3.org\/2000\/svg" width="\d+" height="\d+"/);
    assert.match(res.body, /<title>SALARY_CHANGE version 2<\/title><style>/);
    for (const name of ['APPROVE', 'DECIDE', 'APPLY', 'TELL', 'END']) assert.match(res.body, new RegExp(`>${name}</text>`));
    assert.match(res.body, /send e-mail SALARY_CHANGED/);
    assert.match(res.body, /outcome YES/);
    // the default: the development version, drafts included
    assert.match((await dev.get(`/builder/apps/${appId}/shared/workflow_definition/${defId}/diagram.svg`)).body, /wf-draft/);
    assert.equal((await dev.get(`/builder/apps/${appId}/shared/workflow_definition/${defId}/diagram.svg?v=99`)).statusCode, 404);
  });
});
