// Generate DDL and Schema Comparison (sprint 56, src/ddl.ts): a schema with
// one of everything (test/fixtures/ddl-schema.sql) is read, its script
// creates a second schema that compares as the same, and after changes to
// the copy the change script makes it the same again.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { Browser } from './helpers.ts';
import { changeScript, compare, ddlScript, readSchema, userSchemas } from '../src/ddl.ts';

const A = 'ddl_a';
const B = 'ddl_b';
const drop = async () => owner.query(`drop schema if exists ${A} cascade; drop schema if exists ${B} cascade;`);
/** Run a script as the owner, on a connection of its own (it sets search_path). */
const run = async (sql: string) => {
  const c = await owner.pool.connect();
  try {
    await c.query(sql);
  } finally {
    c.release(true);
  }
};

before(async () => {
  await drop();
  await run(`create schema ${A}; set search_path = ${A}, public; ${readFileSync(new URL('./fixtures/ddl-schema.sql', import.meta.url), 'utf8')}`);
});
after(async () => {
  await drop();
  await closePools();
});

describe('generate DDL', () => {
  test('every kind of object, unqualified, in an order that runs', async () => {
    const objects = await readSchema(owner.pool, A);
    const kinds = new Set(objects.map((o) => o.kind));
    for (const k of ['type', 'domain', 'sequence', 'table', 'function', 'view', 'materialized view', 'constraint', 'foreign key', 'index', 'trigger', 'rls', 'policy', 'comment', 'grant'])
      assert.ok(kinds.has(k as never), k);
    const script = ddlScript(B, objects);
    assert.doesNotMatch(script, /ddl_a/, 'no name of the schema it was read from');
    assert.match(script, /create type mood as enum \('sad', 'ok', 'happy'\);/);
    assert.match(script, /id integer generated always as identity not null/);
    assert.match(script, /yearly numeric\(12,2\) generated always as \(\(salary \* \(12\)::numeric\)\) stored/);
    assert.match(script, /create table events_2026 partition of events FOR VALUES FROM \('2026-01-01'\) TO \('2027-01-01'\);/);
    assert.ok(script.indexOf('create or replace view rich ') < script.indexOf('create or replace view rich_names '), 'a view after the one it uses');
    assert.ok(script.indexOf('FUNCTION dept_count') > script.indexOf('create table dept'), 'a SQL-standard function after the tables');
    assert.ok(script.indexOf('FUNCTION raise_pay') < script.indexOf('create table dept'), 'a PL/pgSQL function before them');
    assert.match(script, /comment on column emp\.name is 'Full name';/);
    assert.match(script, /grant select on table emp to public;/);
    assert.match(script, /revoke execute on function raise_pay\(p_pct numeric\) from public;/, 'PUBLIC may not run it, as in the source');
    // the sequences of identity and serial columns come with their tables; serial's is owned by its column
    assert.doesNotMatch(script, /create sequence dept_id_seq/);
    assert.match(script, /alter sequence emp_id_seq owned by emp\.id;/);
  });

  test('the script creates the same schema elsewhere: the two compare as the same', async () => {
    await run(ddlScript(B, await readSchema(owner.pool, A)));
    const r = compare(await readSchema(owner.pool, A), await readSchema(owner.pool, B));
    assert.deepEqual(r.differences.map((d) => `${d.state} ${d.key}`), []);
    assert.ok(r.same > 20);
  });

  test('the schemas offered: not PostgreSQL\'s, not pgkiln\'s metadata', async () => {
    const list = await userSchemas(owner);
    assert.ok(list.includes(A));
    assert.ok(!list.includes('meta') && !list.includes('pg_catalog') && !list.includes('information_schema'));
  });
});

describe('schema comparison', () => {
  test('differences, and a change script that makes the target like the source', async () => {
    await run(`set search_path = ${B};
      alter table emp drop column feeling;
      alter table emp add column extra text;
      alter table dept alter column budget set default 10;
      alter table emp alter column ticket type bigint;
      drop index emp_name;
      create index emp_extra on emp (extra);
      create or replace view rich as select id, name from emp where salary > 9000;
      drop trigger dept_touch on dept;
      drop policy own_dept on emp;
      create policy own_dept on emp for select to public using (true);
      comment on table emp is 'Staff';
      revoke select on emp from public;
      create function only_here() returns int language sql as 'select 1';`);
    const source = await readSchema(owner.pool, A);
    const target = await readSchema(owner.pool, B);
    const { differences } = compare(source, target);
    const states = Object.fromEntries(differences.map((d) => [d.key, d.state]));
    assert.equal(states['table:emp'], 'different');
    assert.equal(states['table:dept'], 'different');
    assert.equal(states['index:emp_name'], 'source');
    assert.equal(states['index:emp_extra'], 'target');
    assert.equal(states['view:rich'], 'different');
    assert.equal(states['trigger:dept.dept_touch'], 'source');
    assert.equal(states['policy:emp.own_dept'], 'different');
    assert.equal(states['function:only_here()'], 'target');

    const script = changeScript(A, B, source, target);
    assert.match(script, /alter table emp add column feeling mood default 'ok'::mood;/);
    assert.match(script, /alter table emp alter column ticket type integer;/);
    assert.match(script, /alter table dept alter column budget set default 0;/);
    assert.match(script, /-- alter table emp drop column extra;/, 'drops are left for review');
    assert.match(script, /-- drop routine only_here\(\);/);
    assert.match(script, /-- drop index emp_extra;/);
    await run(script);
    // the target now has the source's objects; what only it had stays (the drops were commented out)
    const after = compare(await readSchema(owner.pool, A), await readSchema(owner.pool, B));
    assert.deepEqual(after.differences.map((d) => `${d.state} ${d.key}`).sort(), ['different table:emp', 'target function:only_here()', 'target index:emp_extra'].sort());
    // (emp: the column only the target has; the re-added column is last now, which a comparison ignores)
    // with the drops too, they are the same
    await run(`set search_path = ${B}; alter table emp drop column extra; drop function only_here();`);
    assert.deepEqual(compare(await readSchema(owner.pool, A), await readSchema(owner.pool, B)).differences.map((d) => d.key), []);
  });
});

describe('SQL Workshop pages', () => {
  test('Generate DDL and Schema Comparison: the script, its download, the differences', async () => {
    const app = await buildApp({ logger: false });
    try {
      const dev = new Browser(app);
      await dev.get('/builder/login');
      await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
      const first = await dev.get('/builder/sql/ddl');
      assert.equal(first.statusCode, 200);
      assert.match(first.body, new RegExp(`<option value="${A}">`));
      assert.doesNotMatch(first.body, /<option value="meta">/);
      const page = await dev.get(`/builder/sql/ddl?schema=${A}&t=tables&t=types`);
      assert.match(page.body, /create type mood as enum/);
      assert.doesNotMatch(page.body, /create or replace view rich/, 'only the chosen types');
      const file = await dev.get(`/builder/sql/ddl?schema=${A}&t=tables&download=1`);
      assert.match(String(file.headers['content-disposition']), new RegExp(`attachment; filename="${A}.sql"`));
      assert.match(file.body, /^-- DDL of schema ddl_a/);
      const cmp = await dev.get(`/builder/sql/compare?source=${A}&target=${B}`);
      assert.equal(cmp.statusCode, 200);
      assert.match(cmp.body, /The schemas are the same|difference\(s\)/);
      assert.match((await dev.get(`/builder/sql/compare?source=${A}&target=${A}`)).body, /Choose two different schemas/);
    } finally {
      await app.close();
    }
  });
});

describe('command line and MCP', () => {
  const cli = (...args: string[]) => {
    const r = spawnSync(process.execPath, [new URL('../bin/pgkiln.js', import.meta.url).pathname, ...args], { encoding: 'utf8' });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };

  test('pgkiln ddl and pgkiln compare (exit code 1 when the schemas differ)', async () => {
    const ddl = cli('ddl', A, '--no-grants');
    assert.equal(ddl.code, 0, ddl.err);
    assert.match(ddl.out, /create type mood as enum/);
    assert.doesNotMatch(ddl.out, /^grant /m);
    await run(`set search_path = ${B}; create table cli_only (id int);`);
    try {
      const cmp = cli('compare', A, B);
      assert.equal(cmp.code, 1);
      assert.match(cmp.out, /^- table cli_only$/m);
      const script = cli('compare', A, B, '--script');
      assert.match(script.out, /-- drop table cli_only;/);
    } finally {
      await run(`drop table ${B}.cli_only`);
    }
    assert.equal(cli('compare', A, B).code, 0);
    assert.notEqual(cli('ddl', 'no_such_schema').code, 0);
  });
});
