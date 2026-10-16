// Sprint 91 (Database Actions DA-1, DA-2): the SQL Worksheet. The statement at the cursor or the
// selection, Run Script with a log per statement, Explain Plan and Autotrace, notices, history, the
// navigator (schema, type, columns, statements to insert) and Run as an application's role.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { applySubstitutions, commandTag, pickStatements, substitutionNames, textTable, usesClientCopy } from '../src/sqlworksheet.ts';
import { formatSql } from '../src/sqlformat.ts';
import { objectStatements } from '../src/builder/worksheet.ts';
import { parsePlan, planText } from '../src/sqlplan.ts';
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

describe('plans as a tree (sprint 92)', () => {
  const json = [{
    Plan: { 'Node Type': 'Hash Join', 'Join Type': 'Left', 'Startup Cost': 1, 'Total Cost': 10.5, 'Plan Rows': 1000, 'Plan Width': 8, 'Actual Total Time': 5, 'Actual Rows': 3, 'Actual Loops': 1, 'Hash Cond': '(e.deptno = d.deptno)',
      Plans: [
        { 'Node Type': 'Seq Scan', 'Relation Name': 'emp', Schema: 'hr', Alias: 'e', 'Startup Cost': 0, 'Total Cost': 4, 'Plan Rows': 14, 'Plan Width': 8, 'Actual Total Time': 1, 'Actual Rows': 14, 'Actual Loops': 1, 'Shared Hit Blocks': 2 },
        { 'Node Type': 'Index Scan', 'Index Name': 'dept_pkey', 'Relation Name': 'dept', Schema: 'hr', Alias: 'd', 'Startup Cost': 0, 'Total Cost': 2, 'Plan Rows': 1, 'Plan Width': 4, 'Actual Total Time': 0.5, 'Actual Rows': 1, 'Actual Loops': 2 },
        { 'Node Type': 'Seq Scan', 'Relation Name': 'x', 'Startup Cost': 0, 'Total Cost': 1, 'Plan Rows': 5, 'Plan Width': 4, 'Actual Total Time': 0, 'Actual Rows': 0, 'Actual Loops': 0 },
      ] },
    'Planning Time': 0.2, 'Execution Time': 5.1,
  }];
  test('steps, their own time, the slowest step and estimates that are far off', () => {
    const p = parsePlan(json, true);
    assert.equal(p.root.op, 'Hash Join (Left)');
    assert.deepEqual(p.root.details, [['Hash Cond', '(e.deptno = d.deptno)']]);
    assert.equal(p.root.selfMs, 3, '5 ms minus 1 ms and 2 × 0.5 ms');
    assert.equal(p.root.slowest, true);
    assert.equal(Math.round(p.root.misestimate!), 333, '1000 estimated, 3 found');
    assert.equal(p.root.children[0].target, 'on hr.emp e');
    assert.equal(p.root.children[1].target, 'using dept_pkey on hr.dept d');
    assert.equal(p.root.children[2].neverRun, true);
    assert.equal(p.root.children[2].misestimate, undefined);
    const text = planText(p);
    assert.match(text, /^Hash Join \(Left\) {2}\(cost=1\.\.10\.50 rows=1000 width=8\) \(actual time=5 rows=3 loops=1\)\n {2}Hash Cond: \(e\.deptno = d\.deptno\)\n {2}-> {2}Seq Scan on hr\.emp e/);
    assert.match(text, /\(never executed\)/);
    assert.match(text, /Buffers: shared hit=2/);
    assert.match(text, /Execution Time: 5\.10 ms$/);
    assert.equal(parsePlan(json, false).root.selfMs, undefined);
  });
});

describe('formatting and substitution variables (sprint 93)', () => {
  test('Format puts each clause on its line, keeps strings, comments and dollar quotes', () => {
    assert.equal(
      formatSql("select e.ename, d.dname from hr.emp e join hr.dept d on d.deptno = e.deptno where e.sal between 1 and 2 and e.job = 'A;  B' order by 1"),
      "select e.ename,\n       d.dname\nfrom hr.emp e\n  join hr.dept d on d.deptno = e.deptno\nwhere e.sal between 1 and 2\n   and e.job = 'A;  B'\norder by 1");
    assert.equal(formatSql('SELECT a FROM t WHERE x::text = $1', 'lower'), 'select a\nfrom t\nwhere x::text = $1');
    assert.equal(formatSql('select a from t', 'upper'), 'SELECT a\nFROM t');
    assert.equal(formatSql("do $$ begin   raise notice 'x'; end $$;"), "do $$ begin   raise notice 'x'; end $$;\n");
    assert.equal(formatSql('select left(name, 3), -1 from t -- why\nwhere id in (select id from u)'), 'select left(name, 3),\n       -1\nfrom t -- why\nwhere id in (select id\n             from u)');
  });
  test('&NAME. substitution variables outside strings and comments', () => {
    assert.deepEqual(substitutionNames("select &col. from &tab. where a = '&no.' -- &nope.\n and b & c"), ['COL', 'TAB']);
    assert.equal(applySubstitutions("select &col. from t where x = '&col.'", { COL: 'ename' }), "select ename from t where x = '&col.'");
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
    assert.match((await b.submit('/builder/sql/worksheet', { sql: 'select null::int as n', mode: 'statement', sel_start: '0', sel_end: '0' })).body, /<td class="ws-rownum">1<\/td><td class="num"><span class="null">\(null\)<\/span><\/td>/);
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
    assert.match(as, new RegExp(`<td>${hr.db_role}</td><td class="num">1</td>`));
    assert.match(as, new RegExp(`Runs as the role ${hr.db_role}`));
    assert.equal((await b.submit('/builder/sql/worksheet', { sql: 'select 1', as_app: '999999' })).statusCode, 404);
  });

  test('(sprint 92) the grid: numbers to the right, All rows, downloads through Unload Data with SQL inserts', async () => {
    const b = await builder();
    await b.get('/builder/sql/worksheet');
    const out = (await b.submit('/builder/sql/worksheet', { sql: `select id, name from ${S}.dept order by id`, mode: 'statement' })).body;
    assert.match(out, /<th scope="col" class="num"><button type="button" class="ws-sort" data-ws-sort="0" hidden>id<\/button>/);
    assert.match(out, /<td class="num">1<\/td><td>Sales<\/td>/);
    assert.match(out, /<form method="post" action="\/builder\/sql\/unload" id="ws-dl"[^>]*>.*<input type="hidden" name="query" value="select id, name from ws91\.dept order by id">/s);
    assert.match(out, /<button form="ws-dl" name="format" value="sql">SQL inserts<\/button>/);
    const sql = await b.submit('/builder/sql/unload', { source: 'query', query: `select id, name, id > 1 as big, null::text as n from ${S}.dept order by id`, format: 'sql' });
    assert.equal(sql.headers['content-type'], 'application/sql; charset=utf-8');
    assert.equal(sql.body, `insert into "query" ("id", "name", "big", "n") values (1, 'Sales', false, null);\ninsert into "query" ("id", "name", "big", "n") values (2, 'Research', true, null);\n`);
    // more rows than the grid shows: All rows runs it again with up to 10,000
    const many = (await b.submit('/builder/sql/worksheet', { sql: 'select g from generate_series(1, 600) g', mode: 'statement' })).body;
    assert.match(many, /showing the first 500/);
    assert.match(many, /name="mode" value="statement_all"/);
    const all = (await b.submit('/builder/sql/worksheet', { sql: 'select g from generate_series(1, 600) g', mode: 'statement_all' })).body;
    assert.doesNotMatch(all, /showing the first/);
    assert.match(all, /<td class="num">600<\/td>/);
    // no download for something that isn't one SELECT
    assert.doesNotMatch((await b.submit('/builder/sql/worksheet', { sql: 'show search_path', mode: 'statement' })).body, /id="ws-dl"/);
  });

  test('(sprint 92) plans as a tree with the text behind a toggle; notices with their time', async () => {
    const b = await builder();
    await b.get('/builder/sql/worksheet');
    const at = (await b.submit('/builder/sql/worksheet', { sql: `select * from ${S}.dept d where d.id = 1`, mode: 'autotrace' })).body;
    assert.match(at, /<span class="ws-plan-op">(Index|Seq|Bitmap Heap) Scan<\/span>/);
    assert.match(at, /<span class="ws-plan-target">(using dept_pkey )?on ws91\.dept d<\/span>/);
    assert.match(at, /execution [\d.]+ ms \(rolled back\)/);
    assert.match(at, /<details class="ws-plan-text"><summary>Text plan<\/summary>/);
    const n = (await b.submit('/builder/sql/worksheet', { sql: "do $$ begin raise notice 'timed'; end $$", mode: 'script' })).body;
    assert.match(n, /<span>timed<\/span> <small class="muted">statement 1 · \d\d:\d\d:\d\d\.\d{3}<\/small>/);
  });

  test('(sprint 92) SQL History: status, rows and time per statement; a repeat counts on its row; one\'s own only', async () => {
    const b = await builder();
    await b.get('/builder/sql/worksheet');
    await owner.query(`delete from meta.sql_history where username = 'admin'`);
    for (let k = 0; k < 3; k++) await b.submit('/builder/sql/worksheet', { sql: `select 92 as again`, mode: 'statement' });
    await b.submit('/builder/sql/worksheet', { sql: `select * from ${S}.missing_92`, mode: 'statement' });
    const rows = (await owner.query(`select sql, status, rows, runs, error from meta.sql_history where username = 'admin' order by id`)).rows;
    assert.deepEqual(rows.map((r) => [r.sql, r.status, r.runs]), [['select 92 as again', 'ok', 3], [`select * from ${S}.missing_92`, 'error', 1]]);
    assert.match(rows[1].error, /does not exist/);
    const page = (await b.get('/builder/sql/worksheet?tab=history')).body;
    assert.match(page, /data-ws-tab="history"[^>]*>|aria-selected="true" data-ws-tab="history"/);
    assert.match(page, /data-active="history"/);
    assert.match(page, /<li data-status="error" data-sql="select \* from ws91\.missing_92">/);
    assert.match(page, /1 row · \d+ ms · 3×/);
    const id = (await owner.one(`select id from meta.sql_history where sql = 'select 92 as again'`))!.id;
    assert.match((await b.get(`/builder/sql/worksheet?history=${id}`)).body, />select 92 as again<\/textarea>/);
    // another developer doesn't get it
    await owner.query(`insert into meta.developer (username, password_hash, is_admin) values ('ws92dev', meta.hash_password('ws92dev'), false) on conflict do nothing`);
    try {
      const other = new Browser(app);
      await other.get('/builder/login');
      await other.submit('/builder/login', { username: 'ws92dev', password: 'ws92dev' });
      const theirs = (await other.get(`/builder/sql/worksheet?history=${id}`)).body;
      assert.doesNotMatch(theirs, /select 92 as again/);
    } finally {
      await owner.query(`delete from meta.developer where username = 'ws92dev'`);
    }
  });

  test('(sprint 93) Save, Save as new, Rename and Download; Files lists the workspace\'s scripts', async () => {
    const b = await builder();
    await owner.query(`delete from meta.sql_script where name like 'ws93%'`);
    await b.get('/builder/sql/worksheet');
    assert.match((await b.submit('/builder/sql/worksheet', { sql: 'select 93', mode: 'save', ws_name: '' })).body, /Name the worksheet to save it as a script/);
    const saved = await b.submit('/builder/sql/worksheet', { sql: 'select 93', mode: 'save', ws_name: 'ws93 first', ws_tab: 'k93' });
    assert.equal(saved.statusCode, 303);
    const id = (await owner.one<{ id: number }>(`select id from meta.sql_script where name = 'ws93 first'`))!.id;
    assert.equal(saved.headers.location, `/builder/sql/worksheet?script=${id}&wstab=k93`);
    const page = (await b.get(saved.headers.location as string)).body;
    assert.match(page, /data-source="script" data-script-id="\d+" data-script-name="ws93 first" data-tab="k93"/);
    assert.match(page, />select 93<\/textarea>/);
    assert.match(page, /Saved as the script “ws93 first”/);
    assert.match(page, new RegExp(`<a href="/builder/sql/worksheet\\?script=${id}" aria-current="true">.*?<span>ws93 first</span>`));
    // Save again updates it; Rename; Save as new; a name taken is refused
    await b.submit('/builder/sql/worksheet', { sql: 'select 93, 2', mode: 'save', script_id: String(id) });
    assert.equal((await owner.one(`select content from meta.sql_script where id = $1`, [id]))!.content, 'select 93, 2');
    await b.submit('/builder/sql/worksheet', { sql: 'select 93, 2', mode: 'rename', script_id: String(id), ws_name: 'ws93 renamed' });
    assert.equal((await owner.one(`select name from meta.sql_script where id = $1`, [id]))!.name, 'ws93 renamed');
    await b.submit('/builder/sql/worksheet', { sql: 'select 93, 3', mode: 'save_as', script_id: String(id), ws_name: 'ws93 copy' });
    assert.equal((await owner.one(`select content from meta.sql_script where name = 'ws93 copy'`))!.content, 'select 93, 3');
    assert.match((await b.submit('/builder/sql/worksheet', { sql: 'x', mode: 'save_as', script_id: String(id), ws_name: 'ws93 copy' })).body, /A script named “ws93 copy” already exists/);
    const dl = await b.submit('/builder/sql/worksheet', { sql: 'select 93;\n', mode: 'download', script_id: String(id) });
    assert.equal(dl.headers['content-disposition'], 'attachment; filename="ws93_renamed.sql"');
    assert.equal(dl.body, 'select 93;\n');
    // SQL Scripts opens a script in the worksheet
    assert.match((await b.get('/builder/sql/scripts')).body, new RegExp(`href="/builder/sql/worksheet\\?script=${id}"`));
    await owner.query(`delete from meta.sql_script where name like 'ws93%'`);
  });

  test('(sprint 93) bind and substitution variables: asked for, remembered, bound as literals', async () => {
    const b = await builder();
    await b.get('/builder/sql/worksheet');
    const sql = `select name from ${S}.dept where id = :ID and name <> &OTHER.`;
    const ask = (await b.submit('/builder/sql/worksheet', { sql, mode: 'statement' })).body;
    assert.match(ask, /<dialog class="ws-binds" id="ws-binds" open/);
    assert.match(ask, /<input name="bind_ID" value=""/);
    assert.match(ask, /<input name="sub_OTHER" value=""/);
    assert.match(ask, /<button class="btn btn-hot" name="mode" value="statement">/);
    assert.doesNotMatch(ask, /<td>Sales<\/td>/, 'nothing ran yet');
    const out = (await b.submit('/builder/sql/worksheet', { sql, mode: 'statement', binds_given: '1', bind_ID: '1', sub_OTHER: "'x'" })).body;
    assert.match(out, /<td>Sales<\/td>/);
    // a value is a literal, never SQL
    const evil = (await b.submit('/builder/sql/worksheet', { sql, mode: 'statement', binds_given: '1', bind_ID: "1 or 1=1", sub_OTHER: "'x'" })).body;
    assert.match(evil, /invalid input syntax for type integer: &quot;1 or 1=1&quot;/);
    // remembered for the next time; the history keeps the statement as written
    assert.match((await b.submit('/builder/sql/worksheet', { sql, mode: 'statement' })).body, /<input name="bind_ID" value="1 or 1=1"/);
    assert.ok(await owner.one(`select 1 as ok from meta.sql_history where username = 'admin' and sql = $1`, [sql]));
  });

  test('(sprint 93) Format as a service for the page', async () => {
    const b = await builder();
    await b.get('/builder/sql/worksheet');
    const res = await b.submit('/builder/sql/worksheet/format', { sql: 'SELECT a FROM t', case: 'upper' });
    assert.deepEqual(res.json(), { sql: 'SELECT a\nFROM t' });
    assert.equal((await b.post('/builder/sql/worksheet/format', { __csrf: 'forged', sql: 'select 1' })).statusCode, 403);
  });
});
