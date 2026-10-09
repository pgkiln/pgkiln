// Tenants for workflows and tasks (0.31, migration 072; APEX:
// APEX_SESSION.SET_TENANT_ID). A session's tenant (meta.set_tenant) goes
// with the workflows and tasks it starts; tasks a workflow creates get the
// workflow's tenant; meta.tasks / meta.workflows, the task list and the
// workflow console, and every action only reach the session's tenant.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { appTx, closePools, owner } from '../src/db.ts';
import { runWorkflows } from '../src/workflow.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
let dbRole: string;
/** a signed-in session of king (meta.has_role reads the session's roles) */
let kingSession: string;

before(async () => {
  app = await buildApp({ logger: false });
  ({ id: appId, db_role: dbRole } = (await owner.one(`select id, db_role from meta.app where alias = 'hr'`))!);
  await cleanup();
  const b = new Browser(app);
  await b.login('king');
  kingSession = (await owner.one(`select id from meta.session where app_id = $1 and username = 'king' order by created_at desc limit 1`, [appId])).id;
  await owner.query(
    `insert into meta.workflow_definition (app_id, name, title, admin_role, steps) values ($1, 'TEST_TENANT', 'Tenant &WHO.', 'admin', $2)`,
    [appId, JSON.stringify([{ name: 'PREPARE', type: 'task', task: 'ONBOARD_PREPARE' }, { name: 'SEEN', type: 'sql', code: 'select meta.tenant_id() as tenant' }])],
  );
});

async function cleanup() {
  await owner.query(`delete from meta.task where app_id = $1 and (subject like 'Tenant test%' or workflow_id in (select id from meta.workflow where name = 'TEST_TENANT'))`, [appId]);
  await owner.query(`delete from meta.workflow where app_id = $1 and name = 'TEST_TENANT'`, [appId]);
  await owner.query(`delete from meta.workflow_definition where app_id = $1 and name = 'TEST_TENANT'`, [appId]);
}

after(async () => {
  await cleanup();
  await app.close();
  await closePools();
});

/** Application SQL as king in his session with `tenant` (what a page process sees after meta.set_tenant). */
const asTenant = <T>(user: 'king', tenant: string | null, fn: (c: import('pg').PoolClient) => Promise<T>) =>
  owner.tx(async (c) => {
    await c.query(
      `select set_config('pgkiln.app_id', $1, true), set_config('pgkiln.app_user', $2, true), set_config('pgkiln.session_id', $3, true), set_config('pgkiln.tenant_id', $4, true)`,
      [String(appId), user, kingSession, tenant ?? ''],
    );
    return fn(c);
  });

async function settle(id: string) {
  for (let i = 0; i < 50; i++) {
    await runWorkflows();
    const w = await owner.one('select state from meta.workflow where id = $1', [id]);
    if (!w || w.state !== 'active') return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('tenants for workflows and tasks', () => {
  let acme: string;
  let globex: string;

  test('a workflow carries the tenant it was started with; its tasks and steps get it too', async () => {
    acme = await asTenant('king', 'acme', async (c) => (await c.query(`select meta.start_workflow('TEST_TENANT', null, '{"who": "acme"}') as id`)).rows[0].id);
    globex = await asTenant('king', 'globex', async (c) => (await c.query(`select meta.start_workflow('TEST_TENANT', null, '{"who": "globex"}') as id`)).rows[0].id);
    await settle(acme);
    await settle(globex);
    const rows = (await owner.query(`select w.id::text, w.tenant_id, t.tenant_id as task_tenant from meta.workflow w join meta.task t on t.workflow_id = w.id where w.id = any($1::bigint[]) order by w.id`, [[acme, globex]])).rows;
    assert.deepEqual(rows.map((r) => [r.tenant_id, r.task_tenant]), [['acme', 'acme'], ['globex', 'globex']]);
    // a task created directly takes the session's tenant; without one, none
    const direct = await asTenant('king', 'acme', async (c) => (await c.query(`select meta.create_task('ONBOARD_ACCESS', null, '{"ename": "x"}') as id`)).rows[0].id);
    const plain = await asTenant('king', null, async (c) => (await c.query(`select meta.create_task('ONBOARD_ACCESS', null, '{"ename": "y"}') as id`)).rows[0].id);
    await owner.query(`update meta.task set subject = 'Tenant test ' || id where id = any($1::bigint[])`, [[direct, plain]]);
    assert.deepEqual((await owner.query('select tenant_id from meta.task where id = any($1::bigint[]) order by id', [[direct, plain]])).rows.map((r) => r.tenant_id), ['acme', null]);
  });

  test('the views show only the session tenant’s workflows and tasks (no tenant: only those without one)', async () => {
    const seen = (tenant: string | null) =>
      asTenant('king', tenant, async (c) => ({
        workflows: (await c.query(`select title, tenant_id from meta.workflows where name = 'TEST_TENANT' order by id`)).rows.map((r) => `${r.title}/${r.tenant_id}`),
        tasks: (await c.query(`select subject from meta.tasks where tenant_id is not null or subject like 'Tenant test%' order by id`)).rows.length,
      }));
    assert.deepEqual((await seen('acme')).workflows, ['Tenant acme/acme']);
    assert.deepEqual((await seen('globex')).workflows, ['Tenant globex/globex']);
    assert.deepEqual((await seen(null)).workflows, []);
    assert.equal((await seen('acme')).tasks, 2, "acme's workflow task and its own task");
    assert.equal((await seen('globex')).tasks, 1);
    assert.equal((await seen(null)).tasks, 1, 'only the task without a tenant');
  });

  test("another tenant (or none) can't act on them: claim, complete, cancel and terminate refuse", async () => {
    const task = (await owner.one(`select id::text from meta.task where workflow_id = $1`, [acme])).id;
    for (const sql of [`select meta.claim_task(${task})`, `select meta.complete_task(${task}, 'completed')`, `select meta.cancel_task(${task})`])
      await assert.rejects(asTenant('king', 'globex', (c) => c.query(sql)), /cannot|not found/, sql);
    await assert.rejects(asTenant('king', 'globex', (c) => c.query(`select meta.terminate_workflow(${acme})`)), /cannot terminate/);
    await assert.rejects(asTenant('king', null, (c) => c.query(`select meta.terminate_workflow(${acme})`)), /cannot terminate/);
    // the right tenant can: completing the task lets the workflow run its last step with the tenant
    await asTenant('king', 'acme', (c) => c.query(`select meta.complete_task(${task}, 'completed')`));
    await settle(acme);
    const w = await owner.one('select state, vars from meta.workflow where id = $1', [acme]);
    assert.equal(w.state, 'completed');
    assert.equal(w.vars.TENANT, 'acme', 'the steps run with the workflow’s tenant');
  });

  test('meta.set_tenant: on the session, at once and for its next requests; the task list and console follow', async () => {
    const king = new Browser(app);
    await king.login('king');
    const sid = (await owner.one(`select id from meta.session where app_id = $1 and username = 'king' order by created_at desc limit 1`, [appId])).id;
    const ctx = { appId, alias: 'hr', dbRole, appUser: 'king', sessionId: sid };
    assert.equal(await appTx(ctx, async (c) => (await c.query(`select meta.set_tenant(' globex ') as x, meta.tenant_id() as t`)).rows[0].t), 'globex', 'at once, trimmed');
    assert.equal((await owner.one('select tenant_id from meta.session where id = $1', [sid])).tenant_id, 'globex');
    assert.equal(await appTx(ctx, async (c) => (await c.query('select meta.tenant_id() as t')).rows[0].t), 'globex', 'the next transaction');
    let page = (await king.get('/a/hr/14')).body;
    assert.match(page, /Tenant globex/);
    assert.doesNotMatch(page, /Tenant acme/);
    await appTx(ctx, (c) => c.query(`select meta.set_tenant('acme')`));
    page = (await king.get('/a/hr/14')).body;
    assert.match(page, /Tenant acme/);
    assert.doesNotMatch(page, /Tenant globex/);
    // cleared with null (or an empty text)
    await appTx(ctx, (c) => c.query(`select meta.set_tenant('')`));
    assert.equal((await owner.one('select tenant_id from meta.session where id = $1', [sid])).tenant_id, null);
    await assert.rejects(appTx(ctx, (c) => c.query(`select meta.set_tenant(repeat('x', 201))`)), /at most 200/);
  });
});
