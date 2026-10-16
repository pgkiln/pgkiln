// Sprint 91 (Database Actions DA-1, DA-2): the SQL Worksheet. The statement at the cursor or the
// selection, Run Script with a log per statement, Explain Plan and Autotrace, notices, history, the
// navigator (schema, type, columns, statements to insert) and Run as an application's role.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { commandTag, pickStatements, textTable, usesClientCopy } from '../src/sqlworksheet.ts';
import { objectStatements } from '../src/builder/worksheet.ts';
import { Browser } from './helpers.ts';

describe('picking the statements to run', () => {
  const text = 'select 1;\n\nselect 2\n  from t;\nselect 3';
  test('Run Statement takes the statement at the cursor, right after its semicolon too', () => {
    assert.deepEqual(pickStatements(text, 'statement', { start: 3, end: 3 }).map((s) => s.sql), ['select 1']);
    assert.deepEqual(pickStatements(text, 'statement', { start: 9, end: 9 }).map((s) => s.sql), ['select 1']);
    assert.deepEqual(pickStatements(text, 'statement', { start: 20, end: 20 }).map((s) => s.sql), ['select 2\n  from t']);
    assert.deepEqual(pickStatements(text, 'statement', { start: text.length, end: text.length }).map((s) => s.sql), ['select 3']);
    // in the blank line between two: the one before
    assert.deepEqual(pickStatements(text, 'statement', { start: 10, end: 10 }).map((s) => s.sql), ['select 1']);
  });
  test('a selection runs whole, with its lines and offsets in the worksheet', () => {
    const s = pickStatements(text, 'statement', { start: 11, end: text.length });
    assert.deepEqual(s.map((x) => x.sql), ['select 2\n  from t', 'select 3']);
    assert.deepEqual(s.map((x) => x.line), [3, 5]);
    assert.equal(text.slice(s[0].start, s[0].end), 'select 2\n  from t');
  });
  test('Run Script and a run without a cursor take everything', () => {
    assert.equal(pickStatements(text, 'script', { start: 3, end: 3 }).length, 3);
    assert.equal(pickStatements(text, 'statement').length, 3);
    assert.deepEqual(pickStatements('', 'statement', { start: 0, end: 0 }), []);
  });
  test('command tags like psql\'s', () => {
    assert.equal(commandTag('insert into t values (1)', 'INSERT', 1), 'INSERT 0 1');
    assert.equal(commandTag('select 1', 'SELECT', 3), 'SELECT 3');
    assert.equal(commandTag('create or replace function f() …', 'CREATE', null), 'CREATE FUNCTION');
    assert.equal(commandTag('create unique index on t (a)', 'CREATE', null), 'CREATE INDEX');
    assert.equal(commandTag('drop materialized view if exists v', 'DROP', null), 'DROP MATERIALIZED VIEW');
    assert.equal(commandTag('/* x */ alter table t add b int', 'ALTER', null), 'ALTER TABLE');
    assert.equal(commandTag('do $$ begin end $$', 'DO', null), 'DO');
  });
  test('rows as text and COPY with the client stream', () => {
    assert.equal(textTable(['a', 'bb'], [['1', null], ['22', 'x']]), ' a  | bb\n----+----\n 1  |\n 22 | x');
    assert.ok(usesClientCopy('copy t from stdin'));
    assert.ok(usesClientCopy('COPY (select 1) TO STDOUT with csv'));
    assert.ok(!usesClientCopy("copy t to '/tmp/x'"));
  });
  test('the navigator\'s statements quote names only when they must', () => {
    const st = objectStatements('hr', 'Emp', [{ name: 'id', type: 'integer', notnull: true, pk: true }, { name: 'full name', type: 'text', notnull: false, pk: false }], 'table');
    assert.equal(st.select, 'select id,\n       "full name"\n  from hr."Emp"');
    assert.equal(st.delete, 'delete from hr."Emp"\n where id = null');
    assert.match(st.update!, /set "full name" = null\n where id = null/);
    assert.deepEqual(Object.keys(objectStatements('hr', 'v', [], 'view')), ['select']);
  });
});

let app: FastifyInstance;
const S = 'ws91';
before(async () => {
  app = await buildApp({ logger: false });
  await owner.query(`drop schema if exists ${S} cascade`);
  await owner.query(`
    create schema ${S};
    create table ${S}.dept (id int primary key, name text not null);
    create view ${S}.dept_v as select name from ${S}.dept;
    insert into ${S}.dept values (1, 'Sales'), (2, 'Research');
    alter table ${S}.dept enable row level security;
    create policy dept_one on ${S}.dept using (id = 1);
  `);
});
after(async () => {
  await owner.query(`drop schema if exists ${S} cascade`);
  await app.close();
  await closePools();
});

const builder = async () => {
  const b = new Browser(app);
  await b.get('/builder/login');
  assert.equal((await b.submit('/builder/login', { username: 'admin', password: 'admin' })).statusCode, 303);
  return b;
};

describe('the SQL Worksheet page', () => {
  test('one screen: navigator with the schema\'s objects and columns, toolbar, output tabs and status bar', async () => {
    const b = await builder();
    const page = (await b.get(`/builder/sql/worksheet?schema=${S}`)).body;
    assert.match(page, /<aside class="ws-nav"/);
    assert.match(page, new RegExp(`<option value="${S}" selected>`));
    assert.match(page, /data-ws-sql="select id,\n {7}name\n {2}from ws91\.dept"/);
    assert.match(page, /<span>dept_one on dept<\/span>/, 'policies are listed');
    assert.match(page, /<span>id<\/span><small class="muted">integer<\/small>/);
    for (const label of ['Query Result', 'Script Output', 'Notices', 'Explain Plan', 'Autotrace', 'SQL History']) assert.match(page, new RegExp(`>${label}</button>`));
    for (const key of ['Ctrl\\+Enter', 'F5', 'F10', 'F6']) assert.match(page, new RegExp(`data-ws-key="${key}"`));
    assert.match(page, /<footer class="ws-status"/);
    assert.match(page, /aria-current="page"><svg[^>]*>.*?<\/svg><span>SQL Worksheet<\/span>/s);
    // SQL Commands is the same page
    assert.match((await b.get('/builder/sql/commands')).body, /<form method="post" action="\/builder\/sql\/worksheet" class="ws"/);
    // only tables and views of a type
    const views = (await b.get(`/builder/sql/worksheet/navigator?schema=${S}&type=view`)).body;
    assert.match(views, /dept_v/);
    assert.doesNotMatch(views, /<span>dept<\/span>/);
    assert.equal((await b.get('/builder/sql/worksheet/navigator?schema=meta')).statusCode, 404);
    assert.equal((await b.get('/builder/sql/worksheet/navigator?schema=no_such')).statusCode, 404);
  });

  test('Run Statement runs the statement at the cursor and shows its rows', async () => {
    const b = await builder();
    await b.get('/builder/sql/worksheet');
    const sql = `select name from ${S}.dept order by id;\nselect 'second' as w`;
    const out = (await b.submit('/builder/sql/worksheet', { sql, mode: 'statement', sel_start: '5', sel_end: '5' })).body;
    assert.match(out, /<td>Sales<\/td>/);
    assert.doesNotMatch(out, /<td>second<\/td>/);
    assert.match(out, /data-ran="0,38"/);
    assert.match(out, /data-active="result"/);
    assert.match(out, /2 rows in \d+ ms\./);
    const second = (await b.submit('/builder/sql/worksheet', { sql, mode: 'statement', sel_start: String(sql.length), sel_end: String(sql.length) })).body;
    assert.match(second, /<td>second<\/td>/);
    assert.doesNotMatch(second, /<td>Sales<\/td>/);
    // NULL reads (null), with row numbers
    assert.match((await b.submit('/builder/sql/worksheet', { sql: 'select null::int as n', mode: 'statement', sel_start: '0', sel_end: '0' })).body, /<td class="ws-rownum">1<\/td><td><span class="null">\(null\)<\/span><\/td>/);
  });

  test('Run Script runs everything with a log per statement; it stops at an error unless told to continue', async () => {
    const b = await builder();
    await b.get('/builder/sql/worksheet');
    const sql = `create table ${S}.t (a int);\ninsert into ${S}.t values (1), (2);\nselect * from ${S}.nope;\nselect count(*) from ${S}.t`;
    const out = (await b.submit('/builder/sql/worksheet', { sql, mode: 'script', sel_start: '0', sel_end: '0' })).body;
    assert.match(out, /CREATE TABLE<\/span>/);
    assert.match(out, /INSERT 0 2<\/span>/);
    assert.match(out, /Error at line 3, column 15: relation &quot;ws91.nope&quot; does not exist \(42P01\)/);
    assert.match(out, /4\. line 4: not run/);
    assert.match(out, /data-active="output"/);
    assert.match(out, /data-error-line="3"/);
    assert.match(out, /class="ws-count is-err"/);
    const all = (await b.submit('/builder/sql/worksheet', { sql: sql.replace(`create table ${S}.t (a int);\n`, ''), mode: 'script', continue_on_error: 'on' })).body;
    assert.match(all, / count\n-+\n 4\n/);
    assert.match(all, /3 statements run, 1 failed/);
    // psql commands and COPY from the client are skipped
    const skip = (await b.submit('/builder/sql/worksheet', { sql: '\\set x 1\ncopy ws91.t from stdin;\nselect 1', mode: 'script' })).body;
    assert.match(skip, /psql meta-commands are not supported/);
    assert.match(skip, /use Load Data or Unload Data/);
  });

  test('notices, Explain Plan (nothing runs) and Autotrace (rolled back)', async () => {
    const b = await builder();
    await b.get('/builder/sql/worksheet');
    const n = (await b.submit('/builder/sql/worksheet', { sql: "do $$ begin raise notice 'hello %', 91; raise warning 'careful'; end $$", mode: 'script' })).body;
    assert.match(n, /<span class="tag">NOTICE<\/span> <span>hello 91<\/span>/);
    assert.match(n, /class="ws-count is-warn"/);
    const ex = (await b.submit('/builder/sql/worksheet', { sql: `delete from ${S}.dept`, mode: 'explain', sel_start: '0', sel_end: '0' })).body;
    assert.match(ex, /<pre class="ws-log ws-plan">Delete on ws91\.dept/);
    assert.match(ex, /data-active="explain"/);
    const at = (await b.submit('/builder/sql/worksheet', { sql: `delete from ${S}.dept`, mode: 'autotrace', sel_start: '0', sel_end: '0' })).body;
    assert.match(at, /actual time=/);
    assert.equal((await owner.one(`select count(*)::int as n from ${S}.dept`)).n, 2, 'Explain and Autotrace changed nothing');
    assert.match((await b.submit('/builder/sql/worksheet', { sql: 'create table x91 (a int)', mode: 'explain' })).body, /<p class="alert alert-error">syntax error/);
  });

  test('SQL History lists one\'s own statements; Run as an application role applies its row level security', async () => {
    const b = await builder();
    await b.get('/builder/sql/worksheet');
    await b.submit('/builder/sql/worksheet', { sql: 'select 91 as history_check', mode: 'statement' });
    const page = (await b.get('/builder/sql/worksheet')).body;
    assert.match(page, /data-ws-history="select 91 as history_check"/);
    const hr = (await owner.one<{ id: number; db_role: string }>(`select id, db_role from meta.app where alias = 'hr'`))!;
    assert.match(page, new RegExp(`<option value="${hr.id}">[^<]*\\(${hr.db_role}\\)</option>`));
    await owner.query(`grant usage on schema ${S} to ${hr.db_role}; grant select on ${S}.dept to ${hr.db_role}`);
    const as = (await b.submit('/builder/sql/worksheet', { sql: `select current_user as u, count(*) as n from ${S}.dept`, mode: 'statement', as_app: String(hr.id) })).body;
    assert.match(as, new RegExp(`<td>${hr.db_role}</td><td>1</td>`));
    assert.match(as, new RegExp(`Runs as the role ${hr.db_role}`));
    assert.equal((await b.submit('/builder/sql/worksheet', { sql: 'select 1', as_app: '999999' })).statusCode, 404);
  });
});
