// Sprint 150 (AP-7 leftover; migration 145): remote databases. Another PostgreSQL database's tables become foreign
// tables (postgres_fdw) in a local schema; an application's role queries them like its own tables. The "remote"
// database here is this one, reached over TCP as the server sees itself, with a user and a password, so postgres_fdw
// really connects and authenticates.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { remoteDbProblems, serverNameOf, type RemoteDb } from '../src/remote-db.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let host = '';
let port = 5432;
let dbname = '';
const ROLE = 'pgkiln_t150_app';
const REMOTE_USER = 't150_remote';
const PW = 'T150-remote-secret!';

async function cleanup() {
  for (const r of (await owner.query(`select name, local_schema from meta.remote_database where name like 'T150%'`)).rows) {
    await owner.query(`drop schema if exists ${r.local_schema} cascade`);
    await owner.query(`drop server if exists ${serverNameOf(r.name)} cascade`);
  }
  await owner.query(`delete from meta.remote_database where name like 'T150%'`);
  for (const s of ['t150_crm', 't150_crm2', 't150_src']) await owner.query(`drop schema if exists ${s} cascade`);
  for (const s of ['t150', 't150b', 't150x']) await owner.query(`drop server if exists pgkiln_rdb_${s} cascade`);
  await owner.query(`delete from meta.app where alias = 't150'`);
  await owner.query(`drop role if exists ${REMOTE_USER}`);
  await owner.query(`drop role if exists ${ROLE}`);
}

before(async () => {
  app = await buildApp({ logger: false });
  await cleanup();
  await owner.query('create extension if not exists postgres_fdw');
  const me = (await owner.one(`select host(inet_server_addr()) as host, inet_server_port() as port, current_database() as db`));
  host = me.host ?? '127.0.0.1';
  port = me.port ?? 5432;
  dbname = me.db;
  // the remote side: a user with a password and a schema it may read
  await owner.query(`create role ${REMOTE_USER} login password '${PW}'`);
  await owner.query(`create schema t150_src; create table t150_src.items (id int primary key, name text not null);
    insert into t150_src.items values (1, 'Anvil'), (2, 'Bellows');
    create view t150_src.item_names as select name from t150_src.items;
    grant usage on schema t150_src to ${REMOTE_USER}; grant select, insert on t150_src.items to ${REMOTE_USER}; grant select on t150_src.item_names to ${REMOTE_USER};`);
  // an application with a database role and a report on the foreign table
  await owner.query(`create role ${ROLE} nologin; grant ${ROLE} to pgkiln_runtime`);
  const appId = (await owner.one(`insert into meta.app (alias, name, authentication, db_role) values ('t150', 'Remote test', 'none', $1) returning id`, [ROLE])).id;
  const pageId = (await owner.one(`insert into meta.page (app_id, page_no, name, requires_auth) values ($1, 1, 'Items', false) returning id`, [appId])).id;
  await owner.query(`insert into meta.region (page_id, seq, title, type, source) values ($1, 10, 'Remote items', 'report', 'select id, name from t150_crm.items order by id')`, [pageId]);
});
after(async () => {
  await cleanup();
  await app.close();
  await closePools();
});

async function admin() {
  const b = new Browser(app);
  await b.get('/builder/login');
  await b.submit('/builder/login', { username: 'admin', password: 'admin' });
  await b.get('/builder/remote-databases');
  return b;
}
const flashOf = (body: string) => /class="(?:alert|flash)[^"]*"[^>]*>([^<]*)/.exec(body)?.[1] ?? '';
const asApp = async (sql: string) => owner.tx(async (c) => {
  await c.query(`set local role ${ROLE}`);
  return (await c.query(sql)).rows;
});
const form = (extra: Record<string, string | string[]> = {}) => ({
  mode: 'save', name: 'T150', host, port: String(port), dbname, user_name: REMOTE_USER, password: PW, remote_schema: 't150_src', local_schema: 't150_crm',
  tables: '', grant_roles: ROLE, ...extra,
});

describe('settings checks', () => {
  test('names, host, port, schema and roles', () => {
    const ok: RemoteDb = { name: 'CRM', description: null, host: 'db.example.com', port: 5432, dbname: 'crm', user_name: 'reader', remote_schema: 'public', local_schema: 'crm', tables: [], grant_roles: ['r'], writable: false };
    assert.deepEqual(remoteDbProblems(ok, ['r']), []);
    assert.deepEqual(remoteDbProblems({ ...ok, host: '::1' }, ['r']), []);
    const bad = remoteDbProblems({ ...ok, name: 'crm', host: "x' , password 'y", port: 70000, local_schema: 'public', grant_roles: ['postgres'], tables: ['a\nb'] }, ['r']);
    assert.equal(bad.length, 6, bad.join('\n'));
    assert.ok(remoteDbProblems({ ...ok, local_schema: 'meta' }, ['r']).length);
    assert.ok(remoteDbProblems({ ...ok, local_schema: 'pg_temp_1' }, ['r']).length);
  });
});

describe('remote databases (postgres_fdw)', () => {
  test('the page: postgres_fdw installed, an empty list, the application roles to grant to', async () => {
    const page = (await (await admin()).get('/builder/remote-databases')).body;
    assert.match(page, /postgres_fdw is installed/);
    assert.match(page, new RegExp(`name="grant_roles" value="${ROLE}"`));
    assert.match(page, /No remote databases yet/);
  });

  test('a wrong password: the test fails and nothing is left behind', async () => {
    const b = await admin();
    await b.submit('/builder/remote-databases', form({ mode: 'test', name: 'T150B', password: 'wrong', local_schema: 't150_crm2' }));
    const page = (await b.get('/builder/remote-databases')).body;
    assert.match(page, /The test failed: [^<]*(password authentication failed|could not connect)/);
    assert.equal((await owner.query(`select 1 from pg_foreign_server where srvname = 'pgkiln_rdb_t150b'`)).rowCount, 0);
    assert.equal((await owner.query(`select 1 from pg_namespace where nspname = 't150_crm2'`)).rowCount, 0);
  });

  test('test, then add: the tables imported, SELECT for the application role only, the password nowhere in meta', async () => {
    const b = await admin();
    await b.submit('/builder/remote-databases', form({ mode: 'test' }));
    assert.match((await b.get('/builder/remote-databases')).body, /The connection works: 2 table\(s\) would be imported into t150_crm\. Nothing was saved\./);
    assert.equal((await owner.query(`select 1 from pg_namespace where nspname = 't150_crm'`)).rowCount, 0, 'the test was rolled back');
    const res = await b.submit('/builder/remote-databases', form());
    assert.equal(res.statusCode, 303);
    assert.match((await b.get('/builder/remote-databases')).body, /T150: 2 table\(s\) imported into t150_crm\./);
    assert.deepEqual(await asApp('select id, name from t150_crm.items order by id'), [{ id: 1, name: 'Anvil' }, { id: 2, name: 'Bellows' }]);
    assert.deepEqual(await asApp('select name from t150_crm.item_names order by name'), [{ name: 'Anvil' }, { name: 'Bellows' }]);
    await assert.rejects(asApp(`insert into t150_crm.items values (3, 'Crucible')`), /permission denied/);
    const row = await owner.one(`select * from meta.remote_database where name = 'T150'`);
    assert.doesNotMatch(JSON.stringify(row), new RegExp(PW), 'pgkiln keeps no password');
    assert.deepEqual([row.imported, row.grant_roles, row.server_name], [2, [ROLE], 'pgkiln_rdb_t150']);
    // the user mapping's options: not for the application role
    assert.deepEqual(await asApp(`select umoptions from pg_user_mappings where srvname = 'pgkiln_rdb_t150'`), [{ umoptions: null }]);
  });

  test('a report region on the foreign table renders the remote rows', async () => {
    const page = (await new Browser(app).get('/a/t150/1')).body;
    assert.match(page, /Anvil/);
    assert.match(page, /Bellows/);
  });

  test('edit without the password: writable, a table list; import again picks up remote changes', async () => {
    const b = await admin();
    const id = (await owner.one(`select id from meta.remote_database where name = 'T150'`)).id;
    await b.get(`/builder/remote-databases?edit=${id}`);
    await b.submit('/builder/remote-databases', form({ id: String(id), password: '', tables: 'items', writable: 'true' }));
    assert.match((await b.get('/builder/remote-databases')).body, /T150: 1 table\(s\) imported/);
    await asApp(`insert into t150_crm.items values (3, 'Crucible')`);
    assert.equal((await owner.one(`select name from t150_src.items where id = 3`)).name, 'Crucible', 'written on the remote side');
    await assert.rejects(asApp('select * from t150_crm.item_names'), /does not exist/);
    // a new remote column shows after Import again
    await owner.query('alter table t150_src.items add column weight int');
    await b.submit(`/builder/remote-databases/${id}/refresh`, {});
    assert.deepEqual(Object.keys((await asApp('select * from t150_crm.items order by id limit 1'))[0]), ['id', 'name', 'weight']);
  });

  test('a schema that is not its own is refused; delete drops the schema and the server', async () => {
    const b = await admin();
    await b.submit('/builder/remote-databases', form({ name: 'T150X', local_schema: 'hr' }));
    assert.match((await b.get('/builder/remote-databases')).body, /Nothing was changed: Schema hr exists and is not remote database T150X&#39;s/);
    assert.equal((await owner.query(`select 1 from pg_foreign_server where srvname = 'pgkiln_rdb_t150x'`)).rowCount, 0, 'rolled back');
    const id = (await owner.one(`select id from meta.remote_database where name = 'T150'`)).id;
    await b.submit(`/builder/remote-databases/${id}/delete`, {});
    assert.match((await b.get('/builder/remote-databases')).body, /T150 deleted with its schema t150_crm\./);
    assert.equal((await owner.query(`select 1 from pg_namespace where nspname = 't150_crm'`)).rowCount, 0);
    assert.equal((await owner.query(`select 1 from pg_foreign_server where srvname = 'pgkiln_rdb_t150'`)).rowCount, 0);
  });
});
