// SQL Workshop (sprint 31): SQL Scripts, Quick SQL and the query builder,
// over HTTP against the database.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { buildQuery, loadCatalog, specFromQuery } from '../src/builder/querybuilder.ts';
import { quickSql } from '../src/quicksql.ts';
import { readFileSync } from 'node:fs';
import { applyMapping, loadWithDefinition, mappingProblems, parseFile } from '../src/dataload.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let dev: Browser;

const cleanup = async () => {
  await owner.query('drop schema if exists ws_test, ws_qs, ws_qb, ws_dl cascade');
  await owner.query(`delete from meta.data_load_def where name like 'WS\\_%'`);
  await owner.query(`delete from hr.emp where empno between 9501 and 9599`);
  await owner.query(`delete from hr.audit_log where table_name = 'emp' and row_pk::int between 9501 and 9599`);
  await owner.query(`delete from meta.sql_script_run where script_name like 'ws %'`);
  await owner.query(`delete from meta.sql_script where name like 'ws %'`);
};

before(async () => {
  app = await buildApp({ logger: false });
  await cleanup();
  dev = new Browser(app);
  await dev.get('/builder/login');
  await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
});

after(async () => {
  await cleanup();
  await app.close();
  await closePools();
});

/** Create a script (action save) or save and run it; returns the redirect target. */
async function saveScript(form: Record<string, string>, id?: number) {
  await dev.get(id ? `/builder/sql/scripts/${id}` : '/builder/sql/scripts/new');
  const res = await dev.submit(id ? `/builder/sql/scripts/${id}` : '/builder/sql/scripts', { action: 'save', ...form });
  assert.equal(res.statusCode, 303, res.body.slice(0, 500));
  return String(res.headers.location);
}

const lastRun = async (name: string) => owner.one('select * from meta.sql_script_run where script_name = $1 order by id desc limit 1', [name]);

describe('SQL Scripts', () => {
  const SCRIPT = `create schema if not exists ws_test;
create table ws_test.t (id int primary key, note text);
insert into ws_test.t values (1, 'a;b'), (2, $$c;d$$);
-- the next one fails
insert into ws_test.t values (1, 'duplicate');
select id, note from ws_test.t order by id;
\\echo psql commands are skipped
insert into ws_test.t values (3, 'after the error');`;

  test('create, list, edit, download', async () => {
    const loc = await saveScript({ name: 'ws demo', description: 'a test', content: SCRIPT });
    const id = Number(/\/scripts\/(\d+)$/.exec(loc)?.[1]);
    assert.ok(id);
    const list = await dev.get('/builder/sql/scripts');
    assert.equal(list.statusCode, 200);
    assert.match(list.body, /ws demo/);
    const edit = await dev.get(`/builder/sql/scripts/${id}`);
    assert.match(edit.body, /7 statement\(s\)/);
    assert.match(edit.body, /data-code="plpgsql"/);
    const dl = await dev.get(`/builder/sql/scripts/${id}/download`);
    assert.equal(dl.statusCode, 200);
    assert.match(String(dl.headers['content-disposition']), /attachment; filename="ws_demo\.sql"/);
    assert.match(String(dl.headers['content-type']), /^application\/sql/);
    assert.equal(dl.body, SCRIPT);
    // a duplicate name is refused
    await dev.get('/builder/sql/scripts/new');
    const dup = await dev.submit('/builder/sql/scripts', { action: 'save', name: 'ws demo', content: 'select 1;' });
    assert.equal(dup.statusCode, 422);
    assert.match(dup.body, /already exists/);
  });

  test('run: stop at the first error (no transaction)', async () => {
    const id = (await owner.one(`select id from meta.sql_script where name = 'ws demo'`)).id;
    await dev.get(`/builder/sql/scripts/${id}`);
    const res = await dev.submit(`/builder/sql/scripts/${id}`, { action: 'run', name: 'ws demo', content: SCRIPT, on_error: 'stop' });
    assert.equal(res.statusCode, 303);
    const page = await dev.get(String(res.headers.location));
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /duplicate key value violates unique constraint/);
    const run = await lastRun('ws demo');
    assert.deepEqual(run.results.map((r: any) => r.status), ['ok', 'ok', 'ok', 'error', 'not_run', 'not_run', 'not_run']);
    assert.equal(run.results[2].rows, 2);
    assert.equal(run.results[3].line, 5);
    assert.equal((await owner.one('select count(*)::int as n from ws_test.t')).n, 2, 'statements before the error stay');
    const log = await owner.one(`select * from meta.activity_log where event = 'sql_script' order by id desc limit 1`);
    assert.match(log.detail, /^ws demo: 7 statement\(s\), 3 ok, 1 failed/);
    assert.equal(log.username, 'admin');
  });

  test('run: continue after errors; first rows of a query; psql lines skipped', async () => {
    await owner.query('drop schema ws_test cascade');
    const id = (await owner.one(`select id from meta.sql_script where name = 'ws demo'`)).id;
    await dev.get(`/builder/sql/scripts/${id}`);
    const res = await dev.submit(`/builder/sql/scripts/${id}`, { action: 'run', name: 'ws demo', content: SCRIPT, on_error: 'continue' });
    const run = await lastRun('ws demo');
    assert.deepEqual(run.results.map((r: any) => r.status), ['ok', 'ok', 'ok', 'error', 'ok', 'skipped', 'ok']);
    assert.deepEqual(run.results[4].columns, ['id', 'note']);
    assert.deepEqual(run.results[4].sample, [['1', 'a;b'], ['2', 'c;d']]);
    assert.equal((await owner.one('select count(*)::int as n from ws_test.t')).n, 3);
    const page = await dev.get(String(res.headers.location));
    assert.match(page.body, /<td>c;d<\/td>/);
    assert.match(page.body, /psql meta-commands are not supported/);
  });

  test('run in one transaction: stop rolls everything back, continue keeps the good statements', async () => {
    await owner.query('drop schema ws_test cascade');
    const id = (await owner.one(`select id from meta.sql_script where name = 'ws demo'`)).id;
    await dev.get(`/builder/sql/scripts/${id}`);
    await dev.submit(`/builder/sql/scripts/${id}`, { action: 'run', name: 'ws demo', content: SCRIPT, on_error: 'stop', transaction: 'true' });
    const run = await lastRun('ws demo');
    assert.equal(run.rolled_back, true);
    assert.equal((await owner.one(`select count(*)::int as n from pg_namespace where nspname = 'ws_test'`)).n, 0, 'nothing was created');
    const page = await dev.get(`/builder/sql/scripts/runs/${run.id}`);
    assert.match(page.body, /rolled back/);

    await dev.get(`/builder/sql/scripts/${id}`);
    await dev.submit(`/builder/sql/scripts/${id}`, { action: 'run', name: 'ws demo', content: SCRIPT, on_error: 'continue', transaction: 'true' });
    const run2 = await lastRun('ws demo');
    assert.equal(run2.rolled_back, false);
    assert.equal(run2.failed, 1);
    assert.deepEqual((await owner.query('select id from ws_test.t order by id')).rows.map((r) => r.id), [1, 2, 3]);
  });

  test('the run history is listed per script and overall', async () => {
    const id = (await owner.one(`select id from meta.sql_script where name = 'ws demo'`)).id;
    const page = await dev.get(`/builder/sql/scripts/${id}`);
    assert.equal((page.body.match(/href="\/builder\/sql\/scripts\/runs\/\d+"/g) ?? []).length, 4);
    assert.match((await dev.get('/builder/sql/scripts')).body, /Recent runs[\s\S]*ws demo/);
  });

  test('upload a .sql file; names stay unique', async () => {
    await dev.get('/builder/sql/scripts');
    const file = { name: 'ws upload.sql', type: 'application/sql', data: Buffer.from('﻿select 1;\r\nselect 2;\r\n') };
    const res = await dev.upload('/builder/sql/scripts/upload', {}, { file });
    assert.equal(res.statusCode, 303);
    const row = await owner.one(`select * from meta.sql_script where name = 'ws upload'`);
    assert.equal(row.content, 'select 1;\nselect 2;\n');
    assert.equal(row.created_by, 'admin');
    await dev.get('/builder/sql/scripts');
    await dev.upload('/builder/sql/scripts/upload', {}, { file });
    assert.ok(await owner.one(`select 1 from meta.sql_script where name = 'ws upload (2)'`));
    // not UTF-8 / binary
    await dev.get('/builder/sql/scripts');
    const bad = await dev.upload('/builder/sql/scripts/upload', {}, { file: { name: 'ws bin.sql', type: 'application/octet-stream', data: Buffer.from([0xff, 0xfe, 0x00, 0x41]) } });
    assert.equal(bad.statusCode, 303);
    assert.equal(await owner.one(`select 1 from meta.sql_script where name = 'ws bin'`), undefined);
  });

  test('delete a script with its runs', async () => {
    const id = (await owner.one(`select id from meta.sql_script where name = 'ws demo'`)).id;
    await dev.get(`/builder/sql/scripts/${id}`);
    const res = await dev.submit(`/builder/sql/scripts/${id}/delete`, {});
    assert.equal(res.statusCode, 303);
    assert.equal(await owner.one('select 1 from meta.sql_script where id = $1', [id]), undefined);
    assert.equal((await owner.one(`select count(*)::int as n from meta.sql_script_run where script_name = 'ws demo'`)).n, 0);
    assert.equal((await dev.get(`/builder/sql/scripts/${id}`)).statusCode, 404);
  });
});

describe('Quick SQL', () => {
  const MODEL = `# schema: ws_qs
# auditcols: true
departments [the departments]
  name /nn /unique
  budget
  employees
    name /nn vc100
    email /lower /unique
    hired_on
    salary num(10,2) /between 0 and 1000000
    status /check active, left /default active
    manager_id /fk employees
    is_remote
view department_staff departments employees`;

  test('the generated DDL runs in PostgreSQL', async () => {
    const { ddl, warnings } = quickSql(MODEL);
    assert.deepEqual(warnings, []);
    await owner.tx(async (c) => {
      await c.query(ddl);
      await c.query(`insert into ws_qs.departments (name) values ('Sales')`);
      await c.query(`insert into ws_qs.employees (department_id, name, email) values (1, 'Ann', 'ann@example.com')`);
      const r = (await c.query('select * from ws_qs.department_staff')).rows[0];
      assert.equal(r.employee_name, 'Ann');
      assert.equal(r.employee_status, 'active');
      assert.ok(r.department_created_at && r.department_updated_by);
      await assert.rejects(c.query(`savepoint a; insert into ws_qs.employees (name, email) values ('Bob', 'BOB@x')`), /check/);
      await c.query('rollback to savepoint a');
      await c.query('rollback');
      await c.query('begin'); // owner.tx commits
    });
  });

  test('preview, save as a script, run', async () => {
    const get = await dev.get('/builder/sql/quick');
    assert.equal(get.statusCode, 200);
    assert.match(get.body, /create table departments/);
    const preview = await dev.submit('/builder/sql/quick', { source: MODEL, action: 'preview' });
    assert.equal(preview.statusCode, 200);
    assert.match(preview.body, /create table ws_qs\.employees/);
    assert.match(preview.body, /comment on table ws_qs\.departments is &#39;the departments&#39;;/);

    const saved = await dev.submit('/builder/sql/quick', { source: MODEL, action: 'save', name: 'ws quick' });
    assert.equal(saved.statusCode, 303);
    const script = await owner.one(`select * from meta.sql_script where name = 'ws quick'`);
    assert.match(script.content, /^-- Generated by Quick SQL\n-- # schema: ws_qs/);
    assert.match(script.content, /create table ws_qs\.departments/);

    await dev.get('/builder/sql/quick');
    const run = await dev.submit('/builder/sql/quick', { source: MODEL, action: 'run', name: 'ws quick run', on_error: 'stop', transaction: 'true' });
    assert.equal(run.statusCode, 303);
    const r = await lastRun('ws quick run');
    assert.equal(r.failed, 0, JSON.stringify(r.results.filter((x: any) => x.error)));
    assert.equal(r.script_id, null);
    assert.ok(await owner.one(`select to_regclass('ws_qs.employees') as t`).then((x) => x.t));
  });

  test('warnings are shown with line numbers', async () => {
    await dev.get('/builder/sql/quick');
    const res = await dev.submit('/builder/sql/quick', { source: 't\n  a /nonsense', action: 'preview' });
    assert.match(res.body, /Line 2: Unknown column directive \/nonsense/);
  });
});

describe('Query builder', () => {
  before(async () => {
    await owner.query(`create schema ws_qb;
      create table ws_qb.dept (id int primary key, name text);
      create table ws_qb.emp (id int primary key, name text, dept_id int references ws_qb.dept, boss int references ws_qb.emp);
      create table ws_qb.lonely (x int);
      create view ws_qb.emp_v as select * from ws_qb.emp;
      insert into ws_qb.dept values (1, 'Sales'), (2, 'R&D');
      insert into ws_qb.emp values (1, 'Ann', 1, null), (2, 'Bob', 2, 1), (3, 'O''Brien', null, 1);`);
  });

  const build = async (q: Record<string, unknown>) => {
    const { rels, fks } = await loadCatalog('ws_qb');
    return buildQuery(rels, fks, specFromQuery(q, 'ws_qb'));
  };

  test('joins follow foreign keys; columns, conditions, sort, limit', async () => {
    const b = await build({ t: ['emp', 'dept'], c: ['t1.name', 't2.name'], jt_t2: 'left', wc: ['t1.name', 't2.name'], wo: ['<>', 'is not null'], wv: ["O'Brien", ''], oc: 't1.name', od: 'desc', limit: '10' });
    assert.ok(b);
    assert.equal(
      b.sql,
      `select t1."name" as "t1_name",
       t2."name" as "t2_name"
  from "ws_qb"."emp" t1
  left join "ws_qb"."dept" t2 on t1."dept_id" = t2."id"
 where t1."name" <> 'O''Brien'
   and t2."name" is not null
 order by t1."name" desc
 limit 10`,
    );
    const rows = (await owner.query(b.sql)).rows;
    assert.deepEqual(rows, [{ t1_name: 'Bob', t2_name: 'R&D' }, { t1_name: 'Ann', t2_name: 'Sales' }]);
  });

  test('names not in the catalog and unknown operators are dropped; values are literals', async () => {
    const b = await build({ t: ['emp', 'nope"; drop table ws_qb.dept; --'], c: ['t1.name', 't1.x"; drop', 't9.name'], wc: ['t1.name', 't1.name', 't1.nope'], wo: ['= 1 or 1=1 --', 'in', '='], wv: ['x', "Ann, O'Brien", 'y'] });
    assert.ok(b);
    assert.doesNotMatch(b.sql, /drop|nope|1=1/);
    assert.match(b.sql, /where t1\."name" in \('Ann', 'O''Brien'\)$/);
    assert.equal((await owner.query(b.sql)).rows.length, 2);
  });

  test('tables without a foreign key are cross joined, with a note; any-condition', async () => {
    const b = await build({ t: ['dept', 'lonely'], wc: ['t1.id', 't1.id'], wo: ['=', '='], wv: ['1', '2'], any: 'or', distinct: '1' });
    assert.match(b!.sql, /^select distinct t1\.\*,\n {7}t2\.\*/);
    assert.match(b!.sql, /cross join "ws_qb"\."lonely" t2/);
    assert.match(b!.sql, /where t1\."id" = '1'\n {4}or t1\."id" = '2'/);
    assert.equal(b!.notes.length, 1);
    assert.equal(await build({ t: 'nope' }), null);
  });

  test('joins drawn by the developer: instead of a cross join or a foreign key, left or inner; nonsense dropped', async () => {
    const b = await build({ t: ['dept', 'lonely'], j: 't2.x=t1.id', jt_t2: 'left' });
    assert.match(b!.sql, /left join "ws_qb"\."lonely" t2 on t2\."x" = t1\."id"/);
    assert.equal(b!.notes.length, 0);
    assert.deepEqual(b!.joins[0].custom, [{ a: 't2.x', b: 't1.id' }]);
    // the form's pair, and a drawn join wins over the foreign key
    const c = await build({ t: ['emp', 'dept'], ja: 't1.id', jb: 't2.id' });
    assert.match(c!.sql, /\n  join "ws_qb"\."dept" t2 on t1\."id" = t2\."id"$/);
    assert.equal((await owner.query(c!.sql)).rows.length, 2);
    // two conditions between the same tables are and-ed
    const d = await build({ t: ['emp', 'dept'], j: ['t1.dept_id=t2.id', 't1.name=t2.name'] });
    assert.match(d!.sql, /on t1\."dept_id" = t2\."id" and t1\."name" = t2\."name"$/);
    // the same table, unknown columns or tables, and text that isn't a column: dropped (back to the foreign key)
    const e = await build({ t: ['emp', 'dept'], j: ['t1.id=t1.boss', 't1.nope=t2.id', 't3.id=t1.id', 't1.id=t2.id; drop table ws_qb.dept', 'x'] });
    assert.match(e!.sql, /join "ws_qb"\."dept" t2 on t1\."dept_id" = t2\."id"$/);
    assert.doesNotMatch(e!.sql, /drop|nope|boss/);
  });

  test('column functions group by the other chosen columns; sorting by a function or a grouped column', async () => {
    const b = await build({ t: ['emp', 'dept'], jt_t2: 'left', c: ['t2.name'], fn: ['t1.id:count', 't1.name:max', 't1.boss:nope', 't1.x; drop:sum'], oc: ['t1.id', 't1.boss', 't2.name'], od: ['desc', 'asc', 'asc'] });
    assert.equal(
      b!.sql,
      `select t2."name",
       count(t1."id") as "count_id",
       max(t1."name") as "max_name"
  from "ws_qb"."emp" t1
  left join "ws_qb"."dept" t2 on t1."dept_id" = t2."id"
 group by t2."name"
 order by count(t1."id") desc, t2."name"`,
    );
    assert.ok(b!.grouped);
    assert.deepEqual((await owner.query(b!.sql)).rows, [
      { name: 'R&D', count_id: '1', max_name: 'Bob' },
      { name: 'Sales', count_id: '1', max_name: 'Ann' },
      { name: null, count_id: '1', max_name: "O'Brien" },
    ]);
    const c = await build({ t: 'emp', fn: 't1.boss:count_distinct' });
    assert.equal(c!.sql, `select count(distinct t1."boss") as "count_distinct_boss"\n  from "ws_qb"."emp" t1`);
    assert.deepEqual((await owner.query(c!.sql)).rows, [{ count_distinct_boss: '1' }]);
  });

  test('the tables keep the order they were chosen in (the form lists them alphabetically), so aliases stay', () => {
    assert.deepEqual(specFromQuery({ t: ['dept', 'emp', 'lonely'], o: 'emp,dept' }, 'ws_qb').tables, ['emp', 'dept', 'lonely']);
    assert.deepEqual(specFromQuery({ t: ['dept', 'emp'] }, 'ws_qb').tables, ['dept', 'emp']);
  });

  test('canvas positions from the query string: table:x,y, bounded; others ignored', () => {
    const spec = specFromQuery({ p: ['emp:10,20', 'dept:999999,1', 'x:-1,2', 'bad', 'a:b:3,4'] }, 'ws_qb');
    assert.deepEqual(spec.positions, { emp: { x: 10, y: 20 }, 'a:b': { x: 3, y: 4 } });
  });

  test('the canvas: a box per table with its columns, the joins as data, positions kept', async () => {
    const page = (await dev.get('/builder/sql/query?schema=ws_qb&t=emp&t=dept&p=dept:300,40&j=t1.name=t2.name')).body;
    assert.match(page, /<div class="qb-canvas" data-joins="([^"]*)">/);
    const joins = JSON.parse(/data-joins="([^"]*)"/.exec(page)![1].replace(/&quot;/g, '"'));
    assert.deepEqual(joins, [{ a: 't1.name', b: 't2.name', custom: true }]);
    assert.match(page, /<div class="qb-table" data-table="emp" data-alias="t1" data-x="16" data-y="16">/);
    assert.match(page, /<div class="qb-table" data-table="dept" data-alias="t2" data-x="300" data-y="40">\s*<input type="hidden" name="p" value="dept:300,40">/);
    assert.match(page, /<li class="qb-col" data-ref="t1\.dept_id">/);
    assert.match(page, /<option value="t1\.id:count">count<\/option>/);
    assert.match(page, /<input type="checkbox" name="j" value="t1\.name=t2\.name" checked>/);
    assert.match(page, /<select name="ja" aria-label="Join: column">/);
    // one table: no join dots
    assert.doesNotMatch((await dev.get('/builder/sql/query?schema=ws_qb&t=emp')).body, /qb-link/);
    const fk = JSON.parse(/data-joins="([^"]*)"/.exec((await dev.get('/builder/sql/query?schema=ws_qb&t=emp&t=dept')).body)![1].replace(/&quot;/g, '"'));
    assert.deepEqual(fk, [{ a: 't1.dept_id', b: 't2.id', custom: false }]);
  });

  test('the page shows the SQL and a form to run it in SQL Commands', async () => {
    const page = await dev.get('/builder/sql/query?schema=ws_qb&t=emp&t=dept');
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /join &quot;ws_qb&quot;\.&quot;dept&quot; t2 on t1\.&quot;dept_id&quot; = t2\.&quot;id&quot;/);
    assert.match(page.body, /<form method="post" action="\/builder\/sql"><input type="hidden" name="__csrf"/);
    const sql = /<input type="hidden" name="sql" value="([^"]*)"/.exec(page.body)![1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    const run = await dev.submit('/builder/sql', { sql });
    assert.match(run.body, /2 row\(s\)/, "inner join: O'Brien has no department");
    // an unknown schema falls back to public
    assert.equal((await dev.get('/builder/sql/query?schema=nope%22')).statusCode, 200);
  });
});

describe('Data load definitions', () => {
  const XML = `<?xml version="1.0"?>
<export><people>
  <person id="1"><name>  ann  smith </name><born>01.02.1990</born><salary>1,234.50</salary></person>
  <person id="2"><name>BOB</name><born>15.11.1985</born></person>
</people></export>`;
  const MAPPING = [
    { source: '@id', column: 'id' },
    { source: 'name', column: 'name', transform: ['collapse_spaces', 'initcap'] },
    { source: 'Born', column: 'born', format: 'DD.MM.YYYY' },
    { source: 'salary', column: 'salary', format: '9,999.99', default: '0' },
    { column: 'status', default: 'NEW' },
  ];
  let defId: number;
  let hrId: number;

  before(async () => {
    await owner.query('create schema ws_dl; create table ws_dl.person (id int primary key, name text, born date, salary numeric, status text)');
    hrId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  });

  test('mapping: transformations, defaults, constants; problems are reported', async () => {
    const sheet = await parseFile('p.xml', Buffer.from(XML));
    const { sheet: out, columns } = applyMapping(sheet, MAPPING);
    assert.deepEqual(out.rows, [
      ['1', 'Ann Smith', '01.02.1990', '1,234.50', 'NEW'],
      ['2', 'Bob', '15.11.1985', '0', 'NEW'],
    ]);
    assert.deepEqual(columns.map((c) => c.format), [null, null, 'DD.MM.YYYY', '9,999.99', null]);
    assert.deepEqual(mappingProblems([{ source: 'a' }, { column: 'b' }, { source: 'c', column: 'c', transform: 'shout' }, { source: 'd', column: 'd', extra: 1 }]), [
      'Column mapping 1 needs a "column".',
      'Column mapping 2 needs a "source" or a "default".',
      'Column mapping 3: unknown transformation "shout" (use trim, upper, lower, initcap, collapse_spaces, digits_only).',
      'Column mapping 4: unknown key "extra".',
    ]);
    assert.throws(() => applyMapping(sheet, [{ source: 'nope', column: 'x' }]), /The file has no column "nope"/);
  });

  test('created in Shared Components (validated) and used by SQL Workshop → Load Data', async () => {
    await dev.get(`/builder/apps/${hrId}/shared?new=data_load_def`);
    const bad = await dev.submit(`/builder/apps/${hrId}/shared/data_load_def`, {
      name: 'ws_people', table_name: 'ws_dl.person', mode: 'merge', format: 'xml', row_tag: 'person', columns: '[{"source": "x"}]',
    });
    assert.equal(bad.statusCode, 303);
    assert.equal(await owner.one(`select 1 from meta.data_load_def where name = 'WS_PEOPLE'`), undefined, 'invalid mapping refused');
    await dev.get(`/builder/apps/${hrId}/shared?new=data_load_def`);
    const ok = await dev.submit(`/builder/apps/${hrId}/shared/data_load_def`, {
      name: 'ws_people', table_name: 'ws_dl.person', mode: 'merge', format: 'xml', row_tag: 'people/person', headers: 'true', columns: JSON.stringify(MAPPING),
    });
    assert.equal(ok.statusCode, 303);
    const def = await owner.one(`select * from meta.data_load_def where name = 'WS_PEOPLE'`);
    assert.ok(def);
    defId = def.id;
    assert.match((await dev.get(String(ok.headers.location))).body, /Load a file with this definition/);

    const form = await dev.get(`/builder/sql/load?definition=${defId}`);
    assert.match(form.body, new RegExp(`<option value="${defId}" selected>`));
    const up = await dev.upload('/builder/sql/load', { definition: String(defId) }, { file: { name: 'people.xml', type: 'application/xml', data: Buffer.from(XML) } });
    assert.equal(up.statusCode, 303, up.body.slice(0, 300));
    const url = String(up.headers.location);
    const preview = await dev.get(url);
    assert.match(preview.body, /XML rows &lt;people\/person&gt;/);
    assert.match(preview.body, /<td>Ann Smith<\/td>/);
    const load = await dev.submit(url.split('?')[0], { h: '1', target: 'definition', d: String(defId) });
    assert.equal(load.statusCode, 200, load.body.slice(0, 500));
    assert.match(load.body, /2 row\(s\) inserted/);
    assert.deepEqual((await owner.query('select id, name, born::text, salary::text, status from ws_dl.person order by id')).rows, [
      { id: 1, name: 'Ann Smith', born: '1990-02-01', salary: '1234.50', status: 'NEW' },
      { id: 2, name: 'Bob', born: '1985-11-15', salary: '0', status: 'NEW' },
    ]);
  });

  test('a mapping made in Load Data can be saved as a definition', async () => {
    const up = await dev.upload('/builder/sql/load', { headers: 'true' }, { file: { name: 'ws people.csv', type: 'text/csv', data: Buffer.from('ID;Full name\n3;Cy\n') } });
    const url = String(up.headers.location).split('?')[0];
    await dev.get(`${url}?h=1&table=ws_dl.person`);
    const res = await dev.submit(url, { h: '1', table: 'ws_dl.person', map_0: 'id', map_1: 'name', mode: 'merge', target: 'save_definition', def_app: String(hrId), def_name: 'ws_people_csv' });
    assert.equal(res.statusCode, 303, res.body.slice(0, 300));
    const def = await owner.one(`select * from meta.data_load_def where name = 'WS_PEOPLE_CSV'`);
    assert.deepEqual(def.columns, [{ source: 'ID', column: 'id' }, { source: 'Full name', column: 'name' }]);
    assert.equal(def.mode, 'merge');
    assert.equal(def.format, 'csv');
    // the same name again: refused, not a 500
    await dev.get(`${url}?h=1&table=ws_dl.person`);
    const dup = await dev.submit(url, { h: '1', table: 'ws_dl.person', map_0: 'id', target: 'save_definition', def_app: String(hrId), def_name: 'ws_people_csv' });
    assert.equal(dup.statusCode, 422);
    assert.match(dup.body, /already has a definition named WS_PEOPLE_CSV/);
  });

  test('exported and imported with the application', async () => {
    const doc = (await owner.one(`select meta.export_app('hr') as d`)).d;
    const defs = doc.data_load_definitions.filter((d: any) => d.name.startsWith('WS_'));
    assert.equal(defs.length, 2);
    assert.equal(defs[0].id, undefined);
    await owner.tx(async (c) => {
      const id = (await c.query(`select meta.import_app($1, 'ws-import') as id`, [doc])).rows[0].id;
      const copy = (await c.query(`select * from meta.data_load_def where app_id = $1 and name = 'WS_PEOPLE'`, [id])).rows[0];
      assert.deepEqual(copy.columns, MAPPING);
      await c.query('rollback; begin');
    });
  });

  test('the data_load process uses a definition, as the application role', async () => {
    await owner.query(`insert into meta.data_load_def (app_id, name, table_name, format, row_tag, mode, columns) values ($1, 'WS_EMP', 'hr.emp', 'xml', 'emp', 'merge', $2)`, [
      hrId,
      JSON.stringify([
        { source: '@no', column: 'empno' },
        { source: 'name', column: 'ename', transform: 'trim upper' },
        { source: 'hired', column: 'hiredate', format: 'DD/MM/YYYY' },
        { column: 'deptno', default: '20' },
        { column: 'sal', default: '1000' },
      ]),
    ]);
    const proc = await owner.one(`select p.id, p.config from meta.process p join meta.page g on g.id = p.page_id where g.app_id = $1 and g.page_no = 13 and p.type = 'data_load'`, [hrId]);
    await owner.query(`update meta.process set config = '{"file_item": "P13_FILE", "definition": "ws_emp"}' where id = $1`, [proc.id]);
    try {
      const b = new Browser(app);
      await b.login('king');
      await b.get('/a/hr/13');
      const res = await b.upload('/a/hr/13', { __request: 'LOAD' }, {
        P13_FILE: { name: 'emps.xml', type: 'application/xml', data: Buffer.from('<emps><emp no="9501"><name> novak </name><hired>01/09/2026</hired></emp><emp no="9502"><name>okafor</name><hired>15/09/2026</hired></emp></emps>') },
      });
      assert.equal(res.statusCode, 303, res.body.slice(0, 800));
      assert.deepEqual((await owner.query('select empno, ename, hiredate::text, deptno from hr.emp where empno between 9501 and 9502 order by empno')).rows, [
        { empno: 9501, ename: 'NOVAK', hiredate: '2026-09-01', deptno: 20 },
        { empno: 9502, ename: 'OKAFOR', hiredate: '2026-09-15', deptno: 20 },
      ]);
      const audit = await owner.one(`select changed_by from hr.audit_log where table_name = 'emp' and row_pk = '9501'`);
      assert.equal(audit.changed_by, 'king', 'loaded through the app (its role and user)');
      // an XML file with a DTD is refused on the file item
      await b.get('/a/hr/13');
      const xxe = await b.upload('/a/hr/13', { __request: 'LOAD' }, {
        P13_FILE: { name: 'evil.xml', type: 'application/xml', data: Buffer.from('<?xml version="1.0"?><!DOCTYPE emps [<!ENTITY x SYSTEM "file:///etc/passwd">]><emps><emp no="9503"><name>&x;</name></emp></emps>') },
      });
      assert.equal(xxe.statusCode, 422);
      assert.match(xxe.body, /DTDs and entity declarations are not allowed/);
      assert.doesNotMatch(xxe.body, /root:/);
    } finally {
      await owner.query('update meta.process set config = $2 where id = $1', [proc.id, proc.config]);
    }
  });

  test('HR page 13 loads the XML sample; the EMP_XML definition loads it too', async () => {
    const xml = readFileSync(new URL('../public/samples/employees.xml', import.meta.url));
    try {
      const b = new Browser(app);
      await b.login('king');
      const form = await b.get('/a/hr/13');
      assert.match(form.body, /accept="[^"]*\.xml/);
      const res = await b.upload('/a/hr/13', { __request: 'LOAD' }, { P13_FILE: { name: 'employees.xml', type: 'application/xml', data: xml } });
      assert.equal(res.statusCode, 303, res.body.slice(0, 800));
      assert.deepEqual((await owner.query('select empno, ename, hiredate::text, comm::text, deptno from hr.emp where empno in (9201, 9202) order by empno')).rows, [
        { empno: 9201, ename: 'NOVAK', hiredate: '2026-09-01', comm: null, deptno: 20 },
        { empno: 9202, ename: 'OKAFOR', hiredate: '2026-09-15', comm: '200.00', deptno: 30 },
      ]);
      const def = await owner.one(`select * from meta.data_load_def where app_id = $1 and name = 'EMP_XML'`, [hrId]);
      const r = await owner.tx(async (c) => {
        const out = await loadWithDefinition(c, def, { filename: 'employees.xml', content: Buffer.from(xml.toString().replace('<ename>NOVAK</ename>', '<ename>  novak   jr </ename>')) });
        const row = (await c.query('select ename from hr.emp where empno = 9201')).rows[0];
        await c.query('rollback; begin');
        return { ...out, ename: row.ename };
      });
      assert.equal(r.updated, 2, 'merged by empno');
      assert.equal(r.ename, 'NOVAK JR');
    } finally {
      await owner.query('delete from hr.emp where empno in (9201, 9202)');
    }
  });
});
