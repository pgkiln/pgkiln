// Isolated workspaces (090, src/workspace-db.ts): an isolated workspace's
// applications run on its own login role and its developers' SQL on another;
// row-level security on meta shows each login its own workspace's rows only;
// meta.app_id() refuses another workspace's application; the workspace's
// database roles are its own; the SQL Workshop's saved work is per workspace.
process.env.PGKILN_SECRET_KEY ??= 'test-only-secret-key-0123456789abcdef';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner, ownerUrl, runtimeUrl, sharedRuntime } from '../src/db.ts';
import { devDbForApp, runtimeForApp, workspacesChanged } from '../src/workspace-db.ts';
import { Browser } from './helpers.ts';

const DEV = 'iso_test_dev';
const DEV_PW = 'Iso-test-dev-password!';
const WS = ['ISO Test A', 'ISO Test B'];
const ALIASES = ['iso-test-a', 'iso-test-b', 'iso-test-imp'];
const isolatedRuntime = runtimeUrl !== ownerUrl;

let app: FastifyInstance;
let admin: Browser;
let dev: Browser;
let hrId: number;
let wsA: number;
let appA: number;

async function cleanup() {
  await owner.query(`update meta.workspace set isolated = false where name = any($1)`, [WS]);
  await owner.query('delete from meta.app where alias = any($1)', [ALIASES]);
  await owner.query('delete from meta.workspace where name = any($1)', [WS]);
  for (const a of ALIASES) {
    const n = a.replace(/-/g, '_');
    await owner.query(`drop schema if exists ${n} cascade`);
    await owner.query(`drop owned by ${'app_' + n} cascade`).catch(() => {});
    await owner.query(`drop role if exists ${'app_' + n}`);
  }
  await owner.query('delete from meta.developer where username = $1', [DEV]);
  await owner.query(`delete from meta.sql_script where name like 'iso test %'`);
  await workspacesChanged();
}

async function signIn(b: Browser, username: string, password: string) {
  await b.get('/builder/login');
  return b.submit('/builder/login', { username, password });
}

/** The flash message shown on the next page. */
const flashOf = async (b: Browser, url: string) => (await b.get(url)).body;

/** Run SQL in the SQL Workshop and return the page. */
async function sqlCommand(b: Browser, sql: string) {
  await b.get('/builder/sql');
  return (await b.submit('/builder/sql', { sql })).body;
}

before(async () => {
  await cleanup();
  app = await buildApp({ logger: false });
  await owner.query(`insert into meta.developer (username, password_hash, is_admin) values ($1, meta.hash_password($2), false)`, [DEV, DEV_PW]);
  admin = new Browser(app);
  await signIn(admin, 'admin', 'admin');
  dev = new Browser(app);
  hrId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
});
after(async () => {
  await cleanup();
  await app.close();
  await closePools();
});

describe('isolated workspaces', { skip: !isolatedRuntime && 'needs RUNTIME_DATABASE_URL' }, () => {
  test('only administrators isolate a workspace, with CSRF', async () => {
    await admin.get('/builder/workspaces');
    for (const name of WS) await admin.submit('/builder/workspaces', { name });
    wsA = (await owner.one('select id from meta.workspace where name = $1', [WS[0]])).id;
    await owner.query('delete from meta.workspace_member where workspace_id = 1 and username = $1', [DEV]);
    await owner.query('insert into meta.workspace_member (workspace_id, username) values ($1, $2)', [wsA, DEV]);
    await signIn(dev, DEV, DEV_PW);
    await dev.get('/builder');
    assert.equal((await dev.submit(`/builder/workspaces/${wsA}/isolation`, { isolated: 'true' })).statusCode, 403);
    assert.equal((await admin.post(`/builder/workspaces/${wsA}/isolation`, { isolated: 'true' })).statusCode, 403, 'CSRF');
    assert.equal((await owner.one('select isolated from meta.workspace where id = $1', [wsA])).isolated, false);
    await admin.get(`/builder/workspaces/${wsA}`);
    assert.equal((await admin.submit(`/builder/workspaces/${wsA}/isolation`, { isolated: 'true' })).statusCode, 303);
    const w = await owner.one('select isolated, run_role, dev_role from meta.workspace where id = $1', [wsA]);
    assert.equal(w.isolated, true);
    assert.match(w.run_role, /^pgkiln_ws\d+_run_[0-9a-f]{8}$/);
    const roles = await owner.one(`select r.rolcanlogin as run_login, r.rolsuper as run_super, d.rolcanlogin as dev_login,
                                          pg_has_role(r.oid, 'pgkiln_app_code', 'MEMBER') as run_code, pg_has_role(d.oid, 'pgkiln_app_code', 'MEMBER') as dev_code
                                     from pg_roles r, pg_roles d where r.rolname = $1 and d.rolname = $2`, [w.run_role, w.dev_role]);
    assert.deepEqual(roles, { run_login: true, run_super: false, dev_login: true, run_code: true, dev_code: false });
    assert.match((await admin.get(`/builder/workspaces/${wsA}`)).body, /isolated/);
  });

  test('a new application gets a role and schema of its own, not the shared runtime\'s', async () => {
    await admin.get('/builder');
    await admin.submit('/builder/workspace', { workspace: String(wsA) });
    await admin.get('/builder/create');
    assert.equal((await admin.submit('/builder/apps', { name: 'ISO test A', alias: 'iso-test-a', authentication: 'none' })).statusCode, 303);
    appA = (await owner.one(`select id from meta.app where alias = 'iso-test-a'`)).id;
    const r = await owner.one(
      `select (select role_name from meta.workspace_role where workspace_id = $1) as role,
              pg_has_role('pgkiln_runtime', 'app_iso_test_a', 'MEMBER') as shared,
              (select nspowner::regrole::text from pg_namespace where nspname = 'iso_test_a') as schema_owner`,
      [wsA],
    );
    assert.deepEqual(r, { role: 'app_iso_test_a', shared: false, schema_owner: 'app_iso_test_a' });
    // an alias whose role exists already is refused (it could be another workspace's)
    await owner.query('create role app_iso_test_b nologin');
    await admin.get('/builder/create');
    await admin.submit('/builder/apps', { name: 'ISO test B', alias: 'iso-test-b', authentication: 'none' });
    assert.ok(!(await owner.one(`select 1 as ok from meta.app where alias = 'iso-test-b'`)));
    await owner.query('drop role app_iso_test_b');
    await admin.submit('/builder/workspace', { workspace: '1' });
  });

  test('the application runs on the workspace\'s own login and sees only its workspace in meta', async () => {
    await workspacesChanged();
    const db = await runtimeForApp(appA);
    assert.notEqual(db, sharedRuntime);
    const w = await owner.one('select run_role from meta.workspace where id = $1', [wsA]);
    const r = await db.one(`select session_user::text as login, (select count(*)::int from meta.app) as apps,
                                   (select count(*)::int from meta.page where app_id = $1) as hr_pages,
                                   (select count(*)::int from meta.session where app_id = $1) as hr_sessions`, [hrId]);
    assert.deepEqual(r, { login: w.run_role, apps: 1, hr_pages: 0, hr_sessions: 0 });
    // the application's page renders through it
    assert.equal((await new Browser(app).get('/a/iso-test-a/1')).statusCode, 200);
    // the shared runtime no longer sees the isolated application, and HR keeps working
    assert.equal((await sharedRuntime.one(`select count(*)::int as n from meta.app where alias = 'iso-test-a'`)).n, 0);
    const hr = new Browser(app);
    await hr.login('king');
    assert.equal((await hr.get('/a/hr/1')).statusCode, 200);
  });

  test('application SQL can\'t reach another workspace: RESET ROLE, SET ROLE, meta.app_id(), its tables', async () => {
    const db = await runtimeForApp(appA);
    await assert.rejects(
      db.tx(async (c) => {
        await c.query(`select set_config('pgkiln.app_id', $1, true)`, [String(hrId)]);
        await c.query('select meta.app_id()');
      }),
      /not in this workspace/,
    );
    await assert.rejects(db.tx(async (c) => c.query('set role pgkiln_runtime')), /permission denied/);
    await assert.rejects(db.tx(async (c) => c.query('set role hr_app')), /permission denied/);
    await assert.rejects(db.tx(async (c) => c.query(`select set_config('role', 'hr_app', true)`)), /permission denied/);
    // HR's data, through the role it may use
    await assert.rejects(db.tx(async (c) => {
      await c.query('set local role app_iso_test_a');
      await c.query('reset role');
      await c.query('select count(*) from hr.emp');
    }), /permission denied/);
    // functions that take an application id refuse HR's
    await assert.rejects(db.query('select meta.account_roles($1, $2)', [hrId, 'king']), /not in this workspace/);
    await assert.rejects(db.query(`select meta.authenticate($1, 'king', 'king')`, [hrId]), /not in this workspace/);
    // and the shared runtime can't reach the isolated application either
    await assert.rejects(sharedRuntime.query('select meta.account_roles($1, $2)', [appA, 'admin']), /not in this workspace/);
    await assert.rejects(sharedRuntime.tx(async (c) => c.query('set role app_iso_test_a')), /permission denied/);
  });

  test('the developers\' SQL Workshop runs on the workspace\'s developer login', async () => {
    await dev.get('/builder');
    let page = await sqlCommand(dev, 'select current_user, session_user');
    const w = await owner.one('select dev_role from meta.workspace where id = $1', [wsA]);
    assert.ok(page.includes('app_iso_test_a') && page.includes(w.dev_role), 'starts as the workspace role on its own login');
    assert.match(page, /developer login/);
    page = await sqlCommand(dev, 'create table iso_test_a.note (id int primary key, body text); insert into iso_test_a.note values (1, \'hello\'); select body from iso_test_a.note');
    assert.match(page, /hello/);
    for (const sql of ['select count(*) from meta.app', 'select count(*) from hr.emp', 'reset role; set role pgkiln_runtime', 'set role hr_app', 'select * from meta.developer']) {
      page = await sqlCommand(dev, sql);
      assert.match(page, /permission denied/, sql);
    }
    // the application reads the table the developer made (its role owns it)
    const db = await runtimeForApp(appA);
    const n = await db.tx(async (c) => {
      await c.query('set local role app_iso_test_a');
      return (await c.query('select count(*)::int as n from iso_test_a.note')).rows[0].n;
    });
    assert.equal(n, 1);
    // the developer login of the Advisor and code checks
    assert.notEqual(await devDbForApp(appA), owner);
    // administrators keep the owner
    page = await sqlCommand(admin, 'select session_user');
    assert.match(page, /owner connection/);
  });

  test('SQL scripts, blueprints and data load definitions belong to a workspace', async () => {
    const other = (await owner.one(`insert into meta.sql_script (name, content, created_by, updated_by) values ('iso test default', 'select 1;', 'admin', 'admin') returning id`)).id;
    assert.equal((await dev.get(`/builder/sql/scripts/${other}`)).statusCode, 404);
    assert.doesNotMatch((await dev.get('/builder/sql/scripts')).body, /iso test default/);
    await dev.get('/builder/sql/scripts/new');
    await dev.submit('/builder/sql/scripts', { name: 'iso test own', content: 'select current_user;', action: 'run' });
    const own = await owner.one(`select workspace_id from meta.sql_script where name = 'iso test own'`);
    assert.equal(own.workspace_id, wsA);
    const run = await owner.one(`select workspace_id, results::text as r from meta.sql_script_run where script_name = 'iso test own' order by id desc limit 1`);
    assert.equal(run.workspace_id, wsA);
    assert.match(run.r, /app_iso_test_a/);
    // the Default workspace doesn't see the isolated workspace's script
    assert.doesNotMatch((await admin.get('/builder/sql/scripts')).body, /iso test own/);
  });

  test('an import can\'t claim another workspace\'s (or any other) database role', async () => {
    const doc = (await owner.one(`select meta.export_app('iso-test-a') as d`)).d;
    doc.app.db_role = 'hr_app';
    await dev.get('/builder/import');
    await dev.submit('/builder/import', { doc: JSON.stringify(doc), alias: 'iso-test-imp' });
    assert.ok(!(await owner.one(`select 1 as ok from meta.app where alias = 'iso-test-imp'`)), 'refused');
    assert.match(await flashOf(dev, '/builder/import'), /not a database role of workspace/);
    assert.equal((await owner.one(`select pg_has_role('pgkiln_runtime', 'hr_app', 'MEMBER') as ok`)).ok, true, 'HR keeps its role');
    // a developer's settings can't switch the application to another role either
    await assert.rejects(owner.query(`update meta.app set db_role = 'hr_app' where id = $1`, [appA]), /not a database role of workspace/);
  });

  test('the workspace\'s roles: administrators add and remove them; a role of another workspace or a powerful one is refused', async () => {
    await admin.get(`/builder/workspaces/${wsA}`);
    await admin.submit(`/builder/workspaces/${wsA}/roles`, { role: 'hr_app', action: 'add' });
    assert.match(await flashOf(admin, `/builder/workspaces/${wsA}`), /used by an application of another workspace/);
    await admin.submit(`/builder/workspaces/${wsA}/roles`, { role: 'pgkiln_runtime', action: 'add' });
    assert.match(await flashOf(admin, `/builder/workspaces/${wsA}`), /can(&#39;|')t belong to an isolated workspace/);
    await admin.submit(`/builder/workspaces/${wsA}/roles`, { role: 'app_iso_test_a', action: 'remove' });
    assert.match(await flashOf(admin, `/builder/workspaces/${wsA}`), /iso-test-a runs as app_iso_test_a/);
    assert.equal((await owner.one('select count(*)::int as n from meta.workspace_role where workspace_id = $1', [wsA])).n, 1);
  });

  test('moving the application out and making the workspace shared give the role back to the shared runtime', async () => {
    await admin.get(`/builder/workspaces/${wsA}`);
    assert.equal((await admin.submit(`/builder/workspaces/${wsA}/move`, { app: String(appA), to: '1' })).statusCode, 303);
    const r = await owner.one(`select pg_has_role('pgkiln_runtime', 'app_iso_test_a', 'MEMBER') as shared,
                                      (select count(*)::int from meta.workspace_role where workspace_id = $1) as roles`, [wsA]);
    assert.deepEqual(r, { shared: true, roles: 0 });
    await workspacesChanged();
    assert.equal(await runtimeForApp(appA), sharedRuntime);
    // deleting needs a shared workspace first
    await admin.submit(`/builder/workspaces/${wsA}/delete`, {});
    assert.ok(await owner.one('select 1 as ok from meta.workspace where id = $1', [wsA]));
    await admin.get(`/builder/workspaces/${wsA}`);
    await admin.submit(`/builder/workspaces/${wsA}/isolation`, { isolated: 'false' });
    const w = await owner.one(`select w.isolated, r.rolcanlogin from meta.workspace w join pg_roles r on r.rolname = w.run_role where w.id = $1`, [wsA]);
    assert.deepEqual(w, { isolated: false, rolcanlogin: false });
  });

  test('workspace administrators manage their workspace\'s name and developers, nothing else', async () => {
    const wsB = (await owner.one('select id from meta.workspace where name = $1', [WS[1]])).id;
    await dev.get('/builder');
    assert.equal((await dev.get(`/builder/workspaces/${wsA}`)).statusCode, 403, 'not yet');
    await admin.get(`/builder/workspaces/${wsA}`);
    await admin.submit(`/builder/workspaces/${wsA}/members`, { member: ['admin', DEV], admin: DEV });
    assert.equal((await owner.one('select is_admin from meta.workspace_member where workspace_id = $1 and username = $2', [wsA, DEV])).is_admin, true);
    const page = await dev.get(`/builder/workspaces/${wsA}`);
    assert.equal(page.statusCode, 200);
    assert.doesNotMatch(page.body, /Isolate this workspace|Make shared|Add role|Delete workspace/);
    assert.equal((await dev.get(`/builder/workspaces/${wsB}`)).statusCode, 403);
    assert.equal((await dev.get('/builder/workspaces')).statusCode, 403);
    await dev.get(`/builder/workspaces/${wsA}`);
    assert.equal((await dev.submit(`/builder/workspaces/${wsA}/isolation`, { isolated: 'true' })).statusCode, 403);
    assert.equal((await dev.submit(`/builder/workspaces/${wsA}/roles`, { role: 'hr_app', action: 'add' })).statusCode, 403);
    assert.equal((await dev.submit(`/builder/workspaces/${wsA}/delete`, {})).statusCode, 403);
    assert.equal((await dev.submit(`/builder/workspaces/${wsB}/members`, { member: DEV })).statusCode, 403);
    assert.equal((await dev.submit(`/builder/workspaces/${wsA}`, { name: WS[0], description: 'renamed by its administrator' })).statusCode, 303);
    assert.equal((await owner.one('select description from meta.workspace where id = $1', [wsA])).description, 'renamed by its administrator');
  });

  test('pgkiln_app_code has every right pgkiln_runtime has in meta (migrations keep them in step)', async () => {
    const missing = await owner.query(
      `select c.oid::regclass::text as obj, x.privilege_type from pg_class c, aclexplode(c.relacl) x
        where c.relnamespace = 'meta'::regnamespace and x.grantee = 'pgkiln_runtime'::regrole
          and not case when c.relkind = 'S' then has_sequence_privilege('pgkiln_app_code', c.oid, x.privilege_type)
                       else has_table_privilege('pgkiln_app_code', c.oid, x.privilege_type) end
       union all
       select p.oid::regprocedure::text, 'EXECUTE' from pg_proc p, aclexplode(p.proacl) x
        where p.pronamespace = 'meta'::regnamespace and x.grantee = 'pgkiln_runtime'::regrole
          and not has_function_privilege('pgkiln_app_code', p.oid, 'EXECUTE')`,
    );
    assert.deepEqual(missing.rows, []);
  });
});
