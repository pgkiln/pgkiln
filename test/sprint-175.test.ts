// Sprint 175 (parity leftover DA-17; migration 157): a rollback block per change set. pgkiln proposes it when every
// statement has a plain inverse, the developer writes or changes it in SQL Workshop › Change Log, and the migration
// files carry it: Liquibase --rollback lines, a Flyway undo migration (U0001__name.sql), a comment in plain SQL.
// DA-11 leftover: a REST module's GET answers carry an ETag; If-None-Match with it answers 304.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { flywayUndoFile, flywayUndoName, liquibaseChangelog, plainScript, rollbackFor, rollbackOf, type ChangeSet } from '../src/changelog.ts';
import { issueApiToken } from '../src/api.ts';
import { etagOf, noneMatch } from '../src/runtime/rest.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
const S = 'cl175';
const wipe = async () => {
  await owner.query(`drop schema if exists ${S} cascade`);
  await owner.query(`delete from meta.change_set where schema_name = '${S}'; delete from meta.change_set_counter where schema_name = '${S}'`);
};
before(async () => {
  app = await buildApp({ logger: false });
  await wipe();
  await owner.query(`create schema ${S}; create table ${S}.emp (id int primary key, name text not null)`);
});
after(async () => {
  await wipe();
  await app.close();
  await closePools();
});
const builder = async () => {
  const b = new Browser(app);
  await b.get('/builder/login');
  assert.equal((await b.submit('/builder/login', { username: 'admin', password: 'admin' })).statusCode, 303);
  await b.get('/builder/sql/worksheet');
  return b;
};
const sets = async () => (await owner.query(`select id::int, seq, name, sql, rollback_sql, exported_at from meta.change_set where schema_name = $1 order by seq`, [S])).rows;
const cs = (over: Partial<ChangeSet>): ChangeSet => ({ id: 1, workspace_id: 1, schema_name: 'hr', seq: 2, name: 'add_bonus', author: 'nick q', source: 'table', sql: 'alter table hr.emp add column bonus int;', object_name: 'emp', created_at: '2026-11-12T10:00:00', exported_at: null, ...over });

describe('the rollback of a statement', () => {
  test('what was created is dropped; an added column or named constraint is dropped', () => {
    const cases: [string, string | null][] = [
      ['create table hr.bonus (id int, amount numeric(10,2))', 'drop table hr.bonus'],
      ['CREATE TABLE "My T"."Order Lines" (a int);', 'drop table "My T"."Order Lines"'],
      ['create unique index bonus_ix on hr.bonus (id)', 'drop index hr.bonus_ix'],
      ['create index concurrently hr.b2 on hr.bonus (id)', 'drop index hr.b2'],
      ['create index plain_ix on bonus (id)', 'drop index plain_ix'],
      ['create materialized view hr.mv as select 1', 'drop materialized view hr.mv'],
      ['create view hr.v as select 1', 'drop view hr.v'],
      ['-- note\ncreate sequence hr.s start 10;', 'drop sequence hr.s'],
      ['alter table hr.emp add column bonus numeric(10,2) default 0', 'alter table hr.emp drop column bonus'],
      ['alter table only hr.emp add bonus int', 'alter table hr.emp drop column bonus'],
      ['alter table hr.emp add constraint emp_ck check (sal > 0 and comm in (1, 2))', 'alter table hr.emp drop constraint emp_ck'],
    ];
    for (const [sql, want] of cases) assert.equal(rollbackFor(sql), want, sql);
  });

  test('nothing is proposed when the inverse is not plain', () => {
    for (const sql of [
      'create or replace view hr.v as select 1', 'create table if not exists hr.bonus (id int)', 'alter table hr.emp add column if not exists bonus int',
      'alter table hr.emp add bonus int, add other int', 'alter table hr.emp add check (sal > 0)', 'alter table hr.emp add primary key (id)',
      "comment on column hr.emp.sal is 'Salary'", 'drop table hr.bonus', 'alter table hr.emp drop column bonus', 'alter table hr.emp alter column sal type int',
      'grant select on hr.emp to x', 'create function hr.f() returns int language sql as $$ select 1 $$', 'create trigger t before insert on hr.emp for each row execute function hr.f()',
    ]) assert.equal(rollbackFor(sql), null, sql);
  });

  test('a change set: each inverse, the last statement first; none when one statement has none', () => {
    assert.equal(rollbackOf(['create table hr.b (id int)', 'create index b_ix on hr.b (id);']), 'drop index hr.b_ix;\n\ndrop table hr.b;');
    assert.equal(rollbackOf(['create table hr.b (id int)', 'grant select on hr.b to x']), null);
    assert.equal(rollbackOf([]), null);
  });
});

describe('the rollback in migration files', () => {
  const rb = 'alter table hr.emp drop column bonus;\n\n-- and the index\ndrop index hr.bonus_ix;';
  test('Liquibase: --rollback lines after the change set; none without a rollback', () => {
    const lb = liquibaseChangelog([cs({ rollback_sql: rb }), cs({ seq: 3, name: 'other' })]);
    assert.match(lb, /alter table hr\.emp add column bonus int;\n--rollback alter table hr\.emp drop column bonus;\n--rollback -- and the index\n--rollback drop index hr\.bonus_ix;\n\n--changeset nick_q:0003-other/);
    assert.equal((lb.match(/--rollback/g) ?? []).length, 3);
  });
  test('Flyway: an undo migration U0002__add_bonus.sql; plain SQL: a comment', () => {
    assert.equal(flywayUndoName(cs({})), 'U0002__add_bonus.sql');
    assert.equal(flywayUndoFile(cs({})), null);
    assert.match(flywayUndoFile(cs({ rollback_sql: rb }))!, /^-- hr #2 add_bonus: nick q, 2026-11-12 10:00:00 \(table\) \(undo\)\nalter table hr\.emp drop column bonus;/);
    assert.match(plainScript([cs({ rollback_sql: rb })]), /add column bonus int;\n-- rollback:\n--   alter table hr\.emp drop column bonus;\n--   -- and the index\n--   drop index hr\.bonus_ix;\n$/);
    assert.doesNotMatch(plainScript([cs({ rollback_sql: '  ' })]), /rollback/);
  });
});

describe('Change Log: rollback blocks (DA-17)', () => {
  test('the worksheet records a proposed rollback; a change set without a plain inverse has none', async () => {
    const b = await builder();
    await b.submit('/builder/sql/worksheet', { sql: `alter table ${S}.emp add column bonus numeric(8,2);\ncreate index emp_name_ix on ${S}.emp (name);`, mode: 'script' });
    await b.submit('/builder/sql/worksheet', { sql: `alter table ${S}.emp alter column name drop not null;`, mode: 'script' });
    const [one, two] = await sets();
    assert.equal(one.rollback_sql, `drop index ${S}.emp_name_ix;\n\nalter table ${S}.emp drop column bonus;`);
    assert.equal(two.rollback_sql, null);
    const page = (await b.get(`/builder/sql/changes?schema=${S}`)).body;
    assert.match(page, new RegExp(`<textarea id="f_rb_${one.id}" name="rollback"[^>]*>drop index ${S}\\.emp_name_ix;`));
    assert.match(page, new RegExp(`<textarea id="f_rb_${two.id}" name="rollback"[^>]*></textarea>`));
    assert.match(page, /name="undo" value="1">.*?U0001__add_bonus\.sql/s);
    assert.equal((page.match(/name="undo"/g) ?? []).length, 1, 'only a change set with a rollback offers its undo file');
  });

  test('write, change and remove a rollback; the downloads carry it', async () => {
    const b = await builder();
    const [one, two] = await sets();
    const saved = await b.submit(`/builder/sql/changes/${two.id}/rollback`, { rollback: `alter table ${S}.emp alter column name set not null;\r\n` });
    assert.equal(saved.headers.location, `/builder/sql/changes?schema=${S}`);
    assert.equal((await sets())[1].rollback_sql, `alter table ${S}.emp alter column name set not null;`);
    assert.match((await b.get(saved.headers.location as string)).body, /Rollback of change set 2 saved\./);
    const lb = (await b.submit('/builder/sql/changes/download', { schema: S, format: 'liquibase', which: 'all' })).body;
    assert.match(lb, new RegExp(`--rollback drop index ${S}\\.emp_name_ix;\\n--rollback alter table ${S}\\.emp drop column bonus;`));
    assert.match(lb, new RegExp(`--rollback alter table ${S}\\.emp alter column name set not null;`));
    const zip = await b.submit('/builder/sql/changes/download', { schema: S, format: 'flyway', which: 'all' });
    assert.equal(zip.headers['content-type'], 'application/zip');
    for (const f of ['V0001__add_bonus.sql', 'U0001__add_bonus.sql', 'V0002__alter_emp.sql', 'U0002__alter_emp.sql']) assert.ok(zip.rawPayload.includes(Buffer.from(f)), f);
    // one change set: its undo file alone does not mark it as written
    await owner.query(`update meta.change_set set exported_at = null where schema_name = $1`, [S]);
    const undo = await b.submit(`/builder/sql/changes/${one.id}/download`, { undo: '1' });
    assert.match(String(undo.headers['content-disposition']), /U0001__add_bonus\.sql/);
    assert.match(undo.body, /\(undo\)\ndrop index/);
    assert.equal((await sets())[0].exported_at, null);
    await b.submit(`/builder/sql/changes/${one.id}/download`, {});
    assert.notEqual((await sets())[0].exported_at, null);
    // removed: no undo file, a single Flyway file again
    await b.submit(`/builder/sql/changes/${two.id}/rollback`, { rollback: '  ' });
    assert.equal((await sets())[1].rollback_sql, null);
    await b.submit(`/builder/sql/changes/${one.id}/rollback`, { rollback: '' });
    await owner.query(`update meta.change_set set exported_at = null where seq = 2 and schema_name = $1`, [S]);
    await owner.query(`update meta.change_set set exported_at = now() where seq = 1 and schema_name = $1`, [S]);
    const single = await b.submit('/builder/sql/changes/download', { schema: S, format: 'flyway', which: 'pending' });
    assert.match(String(single.headers['content-disposition']), /V0002__alter_emp\.sql/);
    assert.equal((await b.submit(`/builder/sql/changes/${one.id}/download`, { undo: '1' })).body.includes('(undo)'), false, 'without a rollback the migration file comes');
  });

  test('the rollback is never run: writing one changes nothing in the schema', async () => {
    const b = await builder();
    const [one] = await sets();
    await b.submit(`/builder/sql/changes/${one.id}/rollback`, { rollback: `drop table ${S}.emp;` });
    assert.ok(await owner.one(`select 1 as x from information_schema.tables where table_schema = $1 and table_name = 'emp'`, [S]));
    assert.equal((await b.submit('/builder/sql/changes/999999/rollback', { rollback: 'x' })).statusCode, 404);
  });
});

describe('RESTful Services: ETags (DA-11)', () => {
  let token = '';
  const call = (path: string, headers: Record<string, string> = {}, method = 'GET', payload?: unknown) =>
    app.inject({ method: method as 'GET', url: `/a/hr/rest/hr/${path}`, headers: { authorization: `Bearer ${token}`, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, payload: payload !== undefined ? JSON.stringify(payload) : undefined });
  before(async () => {
    const appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
    token = (await issueApiToken(appId, 'king', 1)).token;
  });
  after(async () => {
    await owner.query(`update hr.emp set photo = null, photo_mime = null, photo_name = null where empno = 7900`);
  });

  test('the tag of a content; If-None-Match lists, weak tags and *', () => {
    const tag = etagOf('{"a":1}');
    assert.match(tag, /^"[A-Za-z0-9_-]{32}"$/);
    assert.equal(etagOf('{"a":1}'), tag);
    assert.notEqual(etagOf('{"a":2}'), tag);
    assert.equal(etagOf(Buffer.from('{"a":1}')), tag);
    assert.equal(noneMatch(tag, tag), true);
    assert.equal(noneMatch(`"other", W/${tag}`, tag), true);
    assert.equal(noneMatch('*', tag), true);
    assert.equal(noneMatch('"other"', tag), false);
    assert.equal(noneMatch(undefined, tag), false);
    assert.equal(noneMatch(tag.slice(1, -1), tag), false, 'a tag is quoted');
  });

  test('a single row: the tag with the row, 304 without it when the tag is sent back, the row again after a change', async () => {
    const first = await call('emp/7839');
    assert.equal(first.statusCode, 200);
    const tag = String(first.headers.etag);
    assert.equal(tag, etagOf(first.body));
    const again = await call('emp/7839', { 'if-none-match': tag });
    assert.equal(again.statusCode, 304);
    assert.equal(again.body, '');
    assert.equal(again.headers.etag, tag);
    assert.equal((await call('emp/7839', { 'if-none-match': '"something-else"' })).statusCode, 200);
    const hired = (await owner.one('select hiredate::text from hr.emp where empno = 7839')).hiredate;
    await owner.query(`update hr.emp set hiredate = hiredate - 1 where empno = 7839`);
    try {
      const changed = await call('emp/7839', { 'if-none-match': tag });
      assert.equal(changed.statusCode, 200);
      assert.notEqual(changed.headers.etag, tag);
    } finally {
      await owner.query('update hr.emp set hiredate = $1 where empno = 7839', [hired]);
    }
  });

  test('the tag never replaces the checks: no token is 401, a missing row 404, whatever tag is sent', async () => {
    const tag = String((await call('emp/7839')).headers.etag);
    assert.equal((await app.inject({ method: 'GET', url: '/a/hr/rest/hr/emp/7839', headers: { 'if-none-match': tag } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/a/hr/rest/hr/emp/7839', headers: { 'if-none-match': '*' } })).statusCode, 401);
    assert.equal((await call('emp/1', { 'if-none-match': '*' })).statusCode, 404);
  });

  test('media has a tag too; a collection is streamed and has none', async () => {
    await owner.query(`update hr.emp set photo = $1, photo_mime = 'image/png', photo_name = 'p.png' where empno = 7900`, [Buffer.from('not really a png')]);
    const photo = await call('emp/7900/photo');
    assert.equal(photo.statusCode, 200);
    const tag = String(photo.headers.etag);
    assert.equal(tag, etagOf(Buffer.from('not really a png')));
    assert.equal(photo.headers['x-content-type-options'], 'nosniff');
    const again = await call('emp/7900/photo', { 'if-none-match': tag });
    assert.equal(again.statusCode, 304);
    assert.equal(again.rawPayload.length, 0);
    const list = await call('emp?limit=2');
    assert.equal(list.statusCode, 200);
    assert.equal(list.headers.etag, undefined);
  });
});
