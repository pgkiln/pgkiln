// Sprint 106 (Database Actions DA-17; migration 118): the change log. DDL run from the SQL Worksheet, Table
// Properties and Schema Comparison becomes change sets per schema, listed in SQL Workshop › Change Log and written
// as migration files (plain SQL, Liquibase formatted SQL, Flyway V0001__name.sql).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { changeName, ddlTarget, flywayName, isSchemaDdl, liquibaseChangelog, type ChangeSet } from '../src/changelog.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
const S = 'cl106';
const T = 'cl106_copy';

before(async () => {
  app = await buildApp({ logger: false });
  await owner.query(`drop schema if exists ${S} cascade; drop schema if exists ${T} cascade`);
  await owner.query(`delete from meta.change_set where schema_name in ('${S}', '${T}'); delete from meta.change_set_counter where schema_name in ('${S}', '${T}')`);
  await owner.query(`create schema ${S}; create table ${S}.emp (id int primary key, name text not null); insert into ${S}.emp values (1, 'a')`);
});

after(async () => {
  await owner.query(`drop schema if exists ${S} cascade; drop schema if exists ${T} cascade`);
  await owner.query(`delete from meta.change_set where schema_name in ('${S}', '${T}'); delete from meta.change_set_counter where schema_name in ('${S}', '${T}')`);
  await app.close();
  await closePools();
});

const builder = async () => {
  const b = new Browser(app);
  await b.get('/builder/login');
  assert.equal((await b.submit('/builder/login', { username: 'admin', password: 'admin' })).statusCode, 303);
  await b.get('/builder/sql/changes');
  return b;
};
const sets = async (schema = S) =>
  (await owner.query(`select id::int, seq, name, author, source, sql, object_name, exported_at from meta.change_set where schema_name = $1 order by seq`, [schema])).rows;

describe('recognising DDL', () => {
  test('schema DDL, its schema and object, and a name', () => {
    for (const sql of ['create table hr.x (id int)', 'ALTER TABLE hr.emp ADD COLUMN bonus numeric', 'drop view if exists hr.v', "comment on column hr.emp.sal is 'x'", 'grant select on hr.emp to hr_app', '-- note\ncreate index emp_ix on hr.emp (ename)'])
      assert.ok(isSchemaDdl(sql), sql);
    for (const sql of ['select 1', 'insert into hr.emp values (1)', 'create role x', 'alter system set work_mem = 1', 'create temp table t (a int)', 'grant hr_app to bob', 'drop database x', 'alter role x login'])
      assert.ok(!isSchemaDdl(sql), sql);
    assert.deepEqual(ddlTarget('alter table "Sales"."Order Lines" add column x int', 'public'), { schema: 'Sales', object: 'Order Lines' });
    assert.deepEqual(ddlTarget("comment on table HR.Emp is 'a.b'", 'public'), { schema: 'hr', object: 'emp' });
    assert.deepEqual(ddlTarget('create table orders (id int)', 'sales'), { schema: 'sales', object: 'orders' });
    assert.equal(changeName('alter table hr.emp add column bonus numeric(9,2) default 0;'), 'add_bonus');
    assert.equal(changeName('alter table hr.emp drop column bonus'), 'drop_bonus');
    assert.equal(changeName('alter table hr.emp add constraint emp_ck check (sal > 0)'), 'alter_emp');
    assert.equal(changeName('create table hr.orders (id int)'), 'create_orders');
    assert.equal(changeName('create unique index emp_ix on hr.emp (ename)'), 'create_index_emp_ix');
    assert.equal(changeName('create or replace view hr."Big View" as select 1'), 'create_view_big_view');
    assert.equal(flywayName({ seq: 1, name: 'add_bonus' }), 'V0001__add_bonus.sql');
    const lb = liquibaseChangelog([{ seq: 2, name: 'add_bonus', author: 'nick q', schema_name: 'hr', source: 'table', created_at: '2026-10-16T10:00:00', sql: 'alter table hr.emp add column bonus int;' } as ChangeSet]);
    assert.match(lb, /^--liquibase formatted sql\n\n--changeset nick_q:0002-add_bonus\n/);
  });
});

describe('recording and the Change Log', () => {
  test('Table Properties: adding a column records a change set, exported as V0001__add_bonus.sql', async () => {
    const b = await builder();
    await b.get(`/builder/sql/objects/table?schema=${S}&o=${S}.emp`);
    const res = await b.submit('/builder/sql/objects/table', {
      ref: `${S}.emp`, schema: S, name: 'emp', mode: 'apply',
      'col.0.orig': 'id', 'col.0.name': 'id', 'col.0.type': 'integer', 'col.0.pk': 'on', 'col.0.nn': 'on',
      'col.1.orig': 'name', 'col.1.name': 'name', 'col.1.type': 'text', 'col.1.nn': 'on',
      'col.2.orig': '', 'col.2.name': 'bonus', 'col.2.type': 'numeric(8,2)', 'col.2.def': '0',
    });
    assert.equal(res.statusCode, 303, res.body);
    const [cs] = await sets();
    assert.equal(cs.seq, 1);
    assert.equal(cs.name, 'add_bonus');
    assert.equal(cs.source, 'table');
    assert.equal(cs.author, 'admin');
    assert.equal(cs.object_name, 'emp');
    assert.match(cs.sql, /alter table cl106\.emp add column bonus numeric\(8,2\) default 0;/);
    const page = await b.get(`/builder/sql/changes?schema=${S}`);
    assert.match(page.body, /V0001__add_bonus\.sql/);
    assert.match(page.body, /Table Properties/);
    const file = await b.submit(`/builder/sql/changes/${cs.id}/download`, {});
    assert.equal(file.statusCode, 200);
    assert.match(String(file.headers['content-disposition']), /filename="V0001__add_bonus\.sql"/);
    assert.match(file.body, /alter table cl106\.emp add column bonus numeric\(8,2\) default 0;/);
    assert.ok((await sets())[0].exported_at, 'marked as written');
    // a failing apply records nothing
    const bad = await b.submit('/builder/sql/objects/table', {
      ref: `${S}.emp`, schema: S, name: 'emp', mode: 'apply',
      'col.0.orig': 'id', 'col.0.name': 'id', 'col.0.type': 'integer', 'col.0.pk': 'on', 'col.0.nn': 'on',
      'col.1.orig': 'name', 'col.1.name': 'name', 'col.1.type': 'text', 'col.1.nn': 'on',
      'col.2.orig': 'bonus', 'col.2.name': 'bonus', 'col.2.type': 'numeric(8,2)', 'col.2.def': '0',
      'col.3.orig': '', 'col.3.name': 'must', 'col.3.type': 'text', 'col.3.nn': 'on',
    });
    assert.match(bad.body, /Nothing was changed/);
    assert.equal((await sets()).length, 1);
  });

  test('the worksheet records the DDL that succeeded, not queries or data changes', async () => {
    const b = await builder();
    await b.get('/builder/sql/worksheet');
    const sql = `select 1;\ninsert into ${S}.emp (id, name) values (2, 'b');\ncreate index emp_name_ix on ${S}.emp (name);\ncomment on table ${S}.emp is 'People';\ncreate table ${S}.bad (id nope);`;
    await b.submit('/builder/sql/worksheet', { sql, mode: 'script', continue: '1' });
    const list = await sets();
    assert.equal(list.length, 2);
    assert.equal(list[1].seq, 2);
    assert.equal(list[1].source, 'worksheet');
    assert.equal(list[1].name, 'create_index_emp_name_ix');
    assert.match(list[1].sql, /^create index emp_name_ix on cl106\.emp \(name\);\n\ncomment on table cl106\.emp is 'People';$/);
    assert.doesNotMatch(list[1].sql, /insert|nope/);
  });

  test('Schema Comparison: Apply and record makes the target like the source and records the script', async () => {
    const b = await builder();
    await owner.query(`create schema ${T}; create table ${T}.emp (id int primary key, name text not null)`);
    const cmp = await b.get(`/builder/sql/compare?source=${S}&target=${T}`);
    assert.match(cmp.body, /Apply and record/);
    const res = await b.submit('/builder/sql/compare/apply', { source: S, target: T });
    assert.equal(res.statusCode, 303);
    assert.ok(await owner.one(`select 1 from pg_attribute where attrelid = '${T}.emp'::regclass and attname = 'bonus'`), 'applied');
    const [cs] = await sets(T);
    assert.equal(cs.source, 'compare');
    assert.equal(cs.name, `like_${S}`);
    assert.match(cs.sql, /bonus/);
  });

  test('downloads: Liquibase, plain SQL and a zip of Flyway files; pending only; numbers stay after a delete', async () => {
    const b = await builder();
    const lb = await b.submit('/builder/sql/changes/download', { schema: S, format: 'liquibase', which: 'all' });
    assert.equal(lb.statusCode, 200);
    assert.match(lb.body, /^--liquibase formatted sql/);
    assert.match(lb.body, /--changeset admin:0001-add_bonus/);
    assert.match(lb.body, /--changeset admin:0002-create_index_emp_name_ix/);
    const plain = await b.submit('/builder/sql/changes/download', { schema: S, format: 'sql', which: 'all' });
    assert.match(plain.body, /-- cl106 #1 add_bonus: admin/);
    await owner.query(`update meta.change_set set exported_at = null where schema_name = $1`, [S]);
    const zip = await b.submit('/builder/sql/changes/download', { schema: S, format: 'flyway', which: 'pending' });
    assert.equal(zip.headers['content-type'], 'application/zip');
    assert.ok(zip.rawPayload.includes(Buffer.from('V0002__create_index_emp_name_ix.sql')));
    const none = await b.submit('/builder/sql/changes/download', { schema: S, format: 'flyway', which: 'pending' });
    assert.equal(none.statusCode, 303, 'nothing left to write');
    // rename, delete: a deleted number is not given again
    const [first, second] = await sets();
    assert.equal((await b.submit(`/builder/sql/changes/${second.id}`, { name: 'Index On Name' })).statusCode, 303);
    assert.equal((await sets())[1].name, 'create_index_emp_name_ix', 'an invalid name is refused');
    await b.submit(`/builder/sql/changes/${second.id}`, { name: 'index_on_name' });
    assert.equal((await sets())[1].name, 'index_on_name');
    await b.submit(`/builder/sql/changes/${second.id}/delete`, {});
    await b.submit('/builder/sql/worksheet', { sql: `alter table ${S}.emp add column note text;`, mode: 'script' });
    assert.deepEqual((await sets()).map((c) => [c.seq, c.name]), [[first.seq, 'add_bonus'], [3, 'add_note']]);
  });

  test('the latest application export marks what is in it', async () => {
    const b = await builder();
    const appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
    await owner.query(`delete from meta.activity_log where event = 'app_export' and app_id = $1`, [appId]);
    assert.match((await b.get(`/builder/sql/changes?schema=${S}`)).body, /No application of this workspace was exported/);
    assert.equal((await b.get(`/builder/apps/${appId}/export`)).statusCode, 200);
    await b.submit('/builder/sql/worksheet', { sql: `alter table ${S}.emp add column later text;`, mode: 'script' });
    const page = (await b.get(`/builder/sql/changes?schema=${S}&app=${appId}`)).body;
    assert.match(page, /latest export of/);
    assert.equal((page.match(/class="tag">✓ in it/g) ?? []).length, 2);
    assert.equal((page.match(/>after it</g) ?? []).length, 1);
  });
});
