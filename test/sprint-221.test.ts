// Sprint 221 (parity: Liquibase change log, "Missing: preconditions and contexts"; migration 183): a change set's
// Liquibase context, labels and sql-check precondition. pgkiln proposes a precondition for a plain create or added
// column, the developer writes or changes them in SQL Workshop › Change Log, the Liquibase changelog carries them
// (context:, labels:, --preconditions / --precondition-sql-check) and a download can pick the change sets of contexts.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { contextList, flywayFile, liquibaseChangelog, oneLine, parseContext, plainScript, preconditionFor, preconditionOf, runsIn, type ChangeSet } from '../src/changelog.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
const S = 'cl221';
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
  await b.ownerConnection();
  await b.get('/builder/sql/worksheet');
  return b;
};
const cs = (over: Partial<ChangeSet>): ChangeSet => ({ id: 1, workspace_id: 1, schema_name: 'hr', seq: 2, name: 'add_bonus', author: 'nick q', source: 'table', sql: 'alter table hr.emp add column bonus int;', object_name: 'emp', created_at: '2026-11-12T10:00:00', exported_at: null, ...over });
/** The proposed check run against the database: what it gives now. */
const run = async (sql: string) => Number(Object.values((await owner.query(sql)).rows[0])[0]);

describe('the proposed precondition of a statement', () => {
  test('a create or an added column: a count of what it makes, 0 while that does not exist', async () => {
    const cases: [string, number | null][] = [
      [`create table ${S}.bonus (id int)`, 0],
      [`create table ${S}.EMP (id int)`, 1], // folded to lower case, as PostgreSQL does
      [`create table "${S}"."Emp" (id int)`, 0],
      [`create index emp_pkey on ${S}.emp (id)`, 1], // an index is made in its table's schema
      [`create view ${S}.v as select 1`, 0],
      [`create sequence ${S}.s`, 0],
      [`create schema ${S}`, 1],
      [`alter table ${S}.emp add column bonus int`, 0],
      [`alter table ${S}.emp add name text`, 1],
      ['alter table emp add column if not exists name text', 1], // the change set's schema
      [`alter table ${S}.emp add constraint c check (id > 0)`, null],
      [`drop table ${S}.emp`, null],
      [`comment on table ${S}.emp is 'x'`, null],
    ];
    for (const [sql, want] of cases) {
      const check = preconditionFor(sql, S);
      if (want === null) assert.equal(check, null, sql);
      else assert.equal(await run(check!), want, sql);
    }
  });

  test('a change set: the sum of its statements\' checks, expected 0, else marked ran; none when one has none', async () => {
    const p = preconditionOf([`create table ${S}.a (x int)`, `alter table ${S}.emp add b int`], S)!;
    assert.deepEqual([p.expected, p.onFail], ['0', 'MARK_RAN']);
    assert.equal(await run(p.sql), 0);
    assert.equal(await run(preconditionOf([`create table ${S}.a (x int)`, `alter table ${S}.emp add name text`], S)!.sql), 1);
    assert.equal(preconditionOf([`create table ${S}.a (x int)`, `drop table ${S}.b`], S), null);
    assert.equal(preconditionOf([], S), null);
  });

  test('SQL on one line: comments dropped outside quotes', () => {
    assert.equal(oneLine("select count(*) -- the rows\nfrom t /* x */ where a = '--not' and \"b--\" = 1;\n"), `select count(*) from t where a = '--not' and "b--" = 1`);
  });
});

describe('context expressions', () => {
  test('and, or, a comma, ! and not, parentheses; invalid ones are null', () => {
    const on = (expr: string, active: string) => parseContext(expr)!(contextList(active));
    assert.equal(on('dev', 'dev'), true);
    assert.equal(on('dev', 'prod'), false);
    assert.equal(on('dev, test', 'test'), true);
    assert.equal(on('dev and !prod', 'dev'), true);
    assert.equal(on('dev and !prod', 'dev, prod'), false);
    assert.equal(on('not prod', 'test'), true);
    assert.equal(on('(a or b) and c', 'b c'), true);
    assert.equal(on('(a or b) and c', 'a'), false);
    assert.equal(on('DEV', 'dev'), true);
    for (const bad of ['', 'dev and', '(dev', 'dev)', 'a b', 'and', '!', 'dev; drop'])
      assert.equal(parseContext(bad), null, bad);
  });

  test('as Liquibase runs them: no contexts given or no expression: every change set', () => {
    assert.equal(runsIn({ context: 'prod' }, contextList('')), true);
    assert.equal(runsIn({ context: null }, contextList('dev')), true);
    assert.equal(runsIn({ context: 'prod' }, contextList('dev')), false);
  });
});

describe('the migration files', () => {
  const c = cs({ context: 'dev and !prod', labels: 'jira-1', precondition_sql: 'select count(*)\nfrom information_schema.columns -- here\nwhere column_name = \'bonus\'', precondition_expected: '0', precondition_on_fail: 'MARK_RAN' });

  test('Liquibase: context and labels on the changeset line, the precondition before the SQL', () => {
    const text = liquibaseChangelog([c, cs({ seq: 3, name: 'plain' })]);
    assert.match(text, /^--changeset nick_q:0002-add_bonus context:"dev and !prod" labels:jira-1\n--preconditions onFail:MARK_RAN\n--precondition-sql-check expectedResult:0 select count\(\*\) from information_schema\.columns where column_name = 'bonus'\n--comment: hr/m);
    assert.match(text, /^--changeset nick_q:0003-plain\n--comment/m, 'nothing for a change set without them');
    assert.match(liquibaseChangelog([cs({ context: 'prod', precondition_sql: 'select 1', precondition_expected: null, precondition_on_fail: null })]),
      /context:prod\n--preconditions onFail:HALT\n--precondition-sql-check expectedResult:0 select 1\n/);
  });

  test('plain SQL and Flyway: comments (they have no preconditions or contexts)', () => {
    for (const text of [plainScript([c]), flywayFile(c)]) {
      assert.match(text, /^-- context: dev and !prod$/m);
      assert.match(text, /^-- labels: jira-1$/m);
      assert.match(text, /^-- precondition \(MARK_RAN unless it gives 0\): select count\(\*\) from information_schema.columns where column_name = 'bonus'$/m);
      assert.match(text, /^alter table hr\.emp add column bonus int;$/m);
    }
  });
});

describe('SQL Workshop › Change Log', () => {
  test('a recorded create gets its precondition; context, labels and precondition are saved; a download picks contexts', async () => {
    const b = await builder();
    const r = await b.submit('/builder/sql/worksheet', { sql: `create table ${S}.bonus (id int); alter table ${S}.emp add column bonus int; comment on table ${S}.emp is 'x'`, mode: 'script' });
    assert.ok(r.statusCode < 400, r.body.slice(0, 200));
    const rows = async () => (await owner.query(`select id::int, seq, name, context, labels, precondition_sql, precondition_expected, precondition_on_fail from meta.change_set where schema_name = $1 order by seq`, [S])).rows;
    const [first] = await rows();
    assert.ok(first, 'recorded');
    // the comment has no plain check: no precondition for the change set
    assert.equal(first.precondition_sql, null);

    // a change set of only creates is proposed one
    await b.submit('/builder/sql/worksheet', { sql: `create table ${S}.second (id int)`, mode: 'script' });
    const second = (await rows()).at(-1)!;
    assert.deepEqual([second.precondition_expected, second.precondition_on_fail], ['0', 'MARK_RAN']);
    assert.equal(await run(second.precondition_sql), 1, 'it exists now: a second run would mark it ran');

    let page = (await b.get(`/builder/sql/changes?schema=${S}`)).body;
    assert.match(page, /Liquibase: context, labels, precondition/);
    assert.match(page, /name="on_fail"/);

    const save = (id: number, form: Record<string, string>) => b.submit(`/builder/sql/changes/${id}/liquibase`, form);
    assert.equal((await save(first.id, { context: '  dev   and !prod ', labels: 'jira-1, reporting', precondition: 'select count(*) from cl221.emp', expected: '0', on_fail: 'WARN' })).statusCode, 303);
    assert.deepEqual((await rows())[0], { ...first, context: 'dev and !prod', labels: 'jira-1, reporting', precondition_sql: 'select count(*) from cl221.emp', precondition_expected: '0', precondition_on_fail: 'WARN' });
    await save(second.id, { context: 'prod', labels: '', precondition: second.precondition_sql, expected: '0', on_fail: 'MARK_RAN' });

    page = (await b.get(`/builder/sql/changes?schema=${S}`)).body;
    assert.match(page, /name="contexts"/, 'the contexts field, as change sets have contexts');

    const download = async (contexts: string) => (await b.submit('/builder/sql/changes/download', { schema: S, format: 'liquibase', which: 'all', contexts })).body;
    const all = await download('');
    assert.match(all, /context:"dev and !prod" labels:"jira-1, reporting"\n--preconditions onFail:WARN\n--precondition-sql-check expectedResult:0 select count\(\*\) from cl221\.emp\n/);
    assert.match(all, /create_second context:prod\n--preconditions onFail:MARK_RAN\n/);
    const dev = await download('dev');
    assert.match(dev, /create_bonus context:/);
    assert.doesNotMatch(dev, /create_second/);
    const prod = await download('prod, test');
    assert.doesNotMatch(prod, /create_bonus/);
    assert.match(prod, /create_second context:prod/);

    // emptied: the attributes are removed (the expected result and what to do on failure go with the check)
    await save(first.id, { context: '', labels: '', precondition: '', expected: '5', on_fail: 'WARN' });
    const cleared = (await rows())[0];
    assert.deepEqual([cleared.context, cleared.labels, cleared.precondition_sql, cleared.precondition_expected, cleared.precondition_on_fail], [null, null, null, null, null]);
  });

  test('invalid input is refused with a message and changes nothing', async () => {
    const b = await builder();
    const id = (await owner.one<{ id: number }>(`insert into meta.change_set (workspace_id, schema_name, name, author, source, sql) values (1, $1, 'v', 'admin', 'worksheet', 'create table x (a int);') returning id::int`, [S]))!.id;
    for (const form of <Record<string, string>[]>[{ context: 'dev and' }, { context: 'dev"; drop' }, { labels: 'a\nb' }, { labels: 'x'.repeat(201) }, { precondition: 'x'.repeat(100_001) }, { precondition: 'select 1', expected: 'a\nb' }]) {
      const r = await b.submit(`/builder/sql/changes/${id}/liquibase`, form);
      assert.equal(r.statusCode, 303, JSON.stringify(form).slice(0, 80));
      const row = await owner.one(`select context, labels, precondition_sql from meta.change_set where id = $1`, [id]);
      assert.deepEqual(row, { context: null, labels: null, precondition_sql: null }, JSON.stringify(form).slice(0, 80));
    }
    assert.match((await b.get(`/builder/sql/changes?schema=${S}`)).body, /alert-error/);
    // an unknown on-fail is HALT
    await b.submit(`/builder/sql/changes/${id}/liquibase`, { precondition: 'select 1', on_fail: 'DROP' });
    assert.equal((await owner.one(`select precondition_on_fail from meta.change_set where id = $1`, [id])).precondition_on_fail, 'HALT');
    await assert.rejects(owner.query(`update meta.change_set set context = 'a;b' where id = $1`, [id]), /check constraint/);
  });
});
