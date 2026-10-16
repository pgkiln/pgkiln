// Sprint 102 (Database Actions DA-14): SQL Workshop › SQL Monitor: live sessions with cancel / terminate, wait
// events, Top SQL from pg_stat_statements with bars and sorting, a statement's page with its plan and Open in
// worksheet. pg_stat_statements needs shared_preload_libraries: without it (CI's postgres:17) the Top SQL tests
// check the explanation instead.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner, ownerUrl } from '../src/db.ts';
import { Browser } from './helpers.ts';
import { explainForMonitor } from '../src/builder/sql-monitor.ts';
import { statementsState } from '../src/builder/top-sql.ts';

const SCHEMA = 'sm102';
const DEV = 'sm102_dev';
const DEV_PW = 'Sm102-dev-password!';

let app: FastifyInstance;
let admin: Browser;
let dev: Browser;
let statements = false;
const clients: pg.Client[] = [];

async function connect(name: string) {
  const c = new pg.Client({ connectionString: ownerUrl, application_name: name });
  c.on('error', () => {}); // a terminated client
  await c.connect();
  clients.push(c);
  const pid = (await c.query('select pg_backend_pid() as pid')).rows[0].pid as number;
  return { c, pid };
}

async function signIn(b: Browser, username: string, password: string) {
  await b.get('/builder/login');
  return b.submit('/builder/login', { username, password });
}

before(async () => {
  await owner.query(`drop schema if exists ${SCHEMA} cascade`);
  await owner.query('delete from meta.developer where username = $1', [DEV]);
  await owner.query(`create schema ${SCHEMA}; create table ${SCHEMA}.t (id int primary key, note text); insert into ${SCHEMA}.t select g, 'n' || g from generate_series(1, 50) g;`);
  await owner.query(`insert into meta.developer (username, password_hash, is_admin) values ($1, meta.hash_password($2), false)`, [DEV, DEV_PW]);
  app = await buildApp({ logger: false });
  admin = new Browser(app);
  await signIn(admin, 'admin', 'admin');
  dev = new Browser(app);
  await signIn(dev, DEV, DEV_PW);
  statements = (await statementsState()).ok;
});
after(async () => {
  for (const c of clients) await c.end().catch(() => {});
  await owner.query(`drop schema if exists ${SCHEMA} cascade`);
  await owner.query('delete from meta.developer where username = $1', [DEV]);
  await app.close();
  await closePools();
});

describe('SQL Monitor: sessions', () => {
  test('a blocked session shows who blocks it; the live part comes alone with ?fragment=1', async () => {
    const holder = await connect('sm102-holder');
    const waiter = await connect('sm102-waiter');
    await holder.c.query('begin');
    await holder.c.query(`update ${SCHEMA}.t set note = 'held' where id = 1`);
    const waiting = waiter.c.query(`update ${SCHEMA}.t set note = 'waited' where id = 1`).catch((e: Error) => e);
    for (let i = 0; i < 50 && !(await owner.one(`select 1 as ok from pg_stat_activity where pid = $1 and wait_event_type = 'Lock'`, [waiter.pid])); i++)
      await new Promise((r) => setTimeout(r, 50));
    const page = await admin.get('/builder/sql/monitor');
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /data-sm-live="\/builder\/sql\/monitor\?fragment=1"/);
    assert.match(page.body, /data-sm-interval/);
    assert.match(page.body, /<option value="5">5 seconds<\/option><option value="15">15 seconds<\/option><option value="60">60 seconds<\/option>/);
    assert.match(page.body, /sm102-holder/);
    assert.match(page.body, /class="is-blocked"/);
    assert.match(page.body, new RegExp(`<span class="tag tag-warning">${holder.pid}</span>`), 'blocked by the holder');
    assert.match(page.body, /Lock: (transactionid|tuple)/);
    assert.match(page.body, /idle in transaction/);
    const fragment = await admin.get('/builder/sql/monitor?fragment=1');
    assert.equal(fragment.statusCode, 200);
    assert.doesNotMatch(fragment.body, /<html|<nav class="ide-tabs/);
    assert.match(fragment.body, /sm102-waiter/);
    assert.match(fragment.headers['cache-control'] as string, /no-store/);
    await holder.c.query('rollback');
    assert.ok(!((await waiting) instanceof Error));
  });

  test('Cancel stops a running statement, Terminate ends a session; idle sessions on request', async () => {
    const sleeper = await connect('sm102-sleeper');
    const sleeping = sleeper.c.query('select pg_sleep(30)').catch((e: { code?: string }) => e);
    for (let i = 0; i < 50 && !(await owner.one(`select 1 as ok from pg_stat_activity where pid = $1 and state = 'active'`, [sleeper.pid])); i++)
      await new Promise((r) => setTimeout(r, 50));
    const page = (await admin.get('/builder/sql/monitor')).body;
    assert.match(page, new RegExp(`aria-label="Cancel the statement of session ${sleeper.pid}"`));
    const res = await admin.submit('/builder/sql/monitor/session', { pid: String(sleeper.pid), action: 'cancel' });
    assert.equal(res.statusCode, 303);
    assert.equal(((await sleeping) as { code?: string }).code, '57014', 'canceled');
    assert.match((await admin.get('/builder/sql/monitor')).body, /Asked session \d+ to cancel/);

    const idle = await connect('sm102-idle');
    assert.doesNotMatch((await admin.get('/builder/sql/monitor')).body, /sm102-idle/, 'idle sessions are hidden');
    assert.match((await admin.get('/builder/sql/monitor?idle=1')).body, /sm102-idle/);
    const ended = new Promise((r) => idle.c.once('end', r));
    assert.equal((await admin.submit('/builder/sql/monitor/session', { pid: String(idle.pid), action: 'terminate', idle: '1' })).headers.location, '/builder/sql/monitor?idle=1');
    await ended;
    assert.equal(await owner.one('select 1 as ok from pg_stat_activity where pid = $1', [idle.pid]), undefined);
  });

  test('only client sessions of this database can be signalled', async () => {
    const bg = (await owner.one(`select pid from pg_stat_activity where backend_type = 'checkpointer'`))?.pid;
    if (bg) {
      await admin.get('/builder/sql/monitor');
      assert.equal((await admin.submit('/builder/sql/monitor/session', { pid: String(bg), action: 'terminate' })).statusCode, 303);
      assert.match((await admin.get('/builder/sql/monitor')).body, /isn&#39;t a client session of this database|isn't a client session of this database/);
      assert.ok(await owner.one('select 1 as ok from pg_stat_activity where pid = $1', [bg]), 'the checkpointer runs on');
    }
    await admin.get('/builder/sql/monitor');
    for (const form of [{ pid: 'x', action: 'cancel' }, { pid: '1', action: 'kill' }, { pid: '1;select 1', action: 'cancel' }])
      assert.equal((await admin.submit('/builder/sql/monitor/session', form)).statusCode, 400, JSON.stringify(form));
  });

  test('administrators only; on the Launchpad, in the search and in the old Database Monitor\'s place', async () => {
    for (const url of ['/builder/sql/monitor', '/builder/sql/monitor?fragment=1', '/builder/sql/monitor/top', '/builder/sql/monitor/statements/1', '/builder/sql/utilities/monitor'])
      assert.equal((await dev.get(url)).statusCode, 403, url);
    await dev.get('/builder/sql');
    for (const url of ['/builder/sql/monitor/session', '/builder/sql/monitor/reset', '/builder/sql/monitor/statements/1/worksheet'])
      assert.equal((await dev.submit(url, { pid: '1', action: 'cancel' })).statusCode, 403, url);
    assert.doesNotMatch((await dev.get('/builder/sql')).body, /href="\/builder\/sql\/monitor"/);
    const home = (await admin.get('/builder/sql')).body;
    assert.match(home, /href="\/builder\/sql\/monitor"/);
    assert.match(home, /href="\/builder\/sql\/monitor\/top"/);
    const found = (await admin.get('/builder/palette?q=top%20sql', )).body;
    assert.match(found, /\/builder\/sql\/monitor\/top/);
    assert.equal((await admin.get('/builder/sql/utilities/monitor')).headers.location, '/builder/sql/monitor');
  });
});

describe('SQL Monitor: Top SQL and a statement', () => {
  test('Top SQL: bars, sorting by any column, a filter; a statement with its plan and Open in worksheet', async () => {
    const page = await admin.get('/builder/sql/monitor/top');
    assert.equal(page.statusCode, 200);
    if (!statements) {
      assert.match(page.body, /pg_stat_statements/);
      assert.match(page.body, /alert-error/);
      return;
    }
    const c = (await connect('sm102-top')).c;
    for (let i = 0; i < 3; i++) await c.query(`select count(*) /* sm102 top */ from ${SCHEMA}.t where id > $1`, [i]);
    const top = (await admin.get('/builder/sql/monitor/top?q=sm102%20top&sort=calls')).body;
    assert.match(top, /sm102 top/);
    assert.match(top, /<svg class="sm-bar"/);
    assert.match(top, /<rect class="sm-bar-fill" width="100"/, 'the largest value fills its bar');
    assert.match(top, /aria-sort="descending"/);
    for (const sort of ['role', 'calls', 'total', 'mean', 'rows', 'hit', 'read', 'query'])
      for (const dir of ['asc', 'desc']) assert.equal((await admin.get(`/builder/sql/monitor/top?sort=${sort}&dir=${dir}`)).statusCode, 200, sort);
    assert.match((await admin.get('/builder/sql/monitor/top?q=no-such-statement-sm102')).body, /No statements match/);
    const queryid = /href="\/builder\/sql\/monitor\/statements\/(-?\d+)"><code class="sql-text">select count\(\*\) \/\* sm102 top/.exec(top)?.[1];
    assert.ok(queryid, 'a link to the statement');

    const stmt = (await admin.get(`/builder/sql/monitor/statements/${queryid}`)).body;
    assert.match(stmt, /sm102 top/);
    assert.match(stmt, /<b>3<\/b><span>Calls<\/span>/);
    assert.match(stmt, /Open in worksheet/);
    const plan = (await admin.get(`/builder/sql/monitor/statements/${queryid}?explain=1&schema=${SCHEMA}`)).body;
    assert.match(plan, /ws-plan-tree/, 'a plan tree');
    assert.match(plan, /sm102\.t|Seq Scan|Index/);
    const ws = await admin.submit(`/builder/sql/monitor/statements/${queryid}/worksheet`, {});
    assert.equal(ws.headers.location, '/builder/sql/worksheet');
    assert.match((await admin.get('/builder/sql/worksheet')).body, /sm102 top/);

    await admin.get('/builder/sql/monitor/top');
    assert.equal((await admin.submit('/builder/sql/monitor/reset', {})).statusCode, 303);
    assert.doesNotMatch((await admin.get('/builder/sql/monitor/top?q=sm102%20top')).body, /<code class="sql-text">select count/);
    assert.equal((await admin.get(`/builder/sql/monitor/statements/${queryid}`)).statusCode, 404);
  });

  test('Explain never runs the statement, explains one statement only, and gives $1 a generic plan', async () => {
    const before = (await owner.one(`select count(*)::int as n from ${SCHEMA}.t`)).n;
    const ins = await explainForMonitor(`insert into ${SCHEMA}.t values (999, 'x')`, null);
    assert.ok(ins.ok, JSON.stringify(ins));
    const del = await explainForMonitor(`with d as (delete from t returning *) select * from d`, SCHEMA);
    assert.ok(del.ok, JSON.stringify(del));
    assert.equal((await owner.one(`select count(*)::int as n from ${SCHEMA}.t`)).n, before);
    const two = await explainForMonitor(`select 1; delete from ${SCHEMA}.t`, null);
    assert.equal(two.ok, false);
    const ddl = await explainForMonitor(`drop table ${SCHEMA}.t`, null);
    assert.equal(ddl.ok, false);
    assert.ok(await owner.one(`select to_regclass('${SCHEMA}.t') as t`));
    const generic = await explainForMonitor(`select * from ${SCHEMA}.t where id = $1`, null);
    const v = Number((await owner.one(`select current_setting('server_version_num') as v`)).v);
    if (v >= 160000) assert.ok(generic.ok && generic.generic, JSON.stringify(generic));
    else assert.equal(generic.ok, false);
    const unknown = await explainForMonitor('select * from no_such_table_sm102', null);
    assert.equal(unknown.ok, false);
    assert.match((unknown as { error: string }).error, /does not exist/);
  });
});
