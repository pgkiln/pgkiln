// Sprint 75: the SQL Workshop's Object Browser like APEX's (a tree by object
// type with a filter and a schema in the header, system objects hidden, a
// table in tabs, column actions that write the SQL to review) and its tools
// as tabs with a More menu.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
const S = 'ob75';
before(async () => {
  app = await buildApp({ logger: false });
  await owner.query(`drop schema if exists ${S} cascade`);
  await owner.query(`
    create schema ${S};
    create table ${S}.dept (id int primary key, name text not null unique);
    create table ${S}.emp (id int primary key, name text not null, dept_id int references ${S}.dept, boss int references ${S}.emp);
    create index emp_name_idx on ${S}.emp (name);
    create view ${S}.emp_v as select e.name, d.name as dept from ${S}.emp e join ${S}.dept d on d.id = e.dept_id;
    create sequence ${S}.ticket_seq;
    create type ${S}.mood as enum ('ok', 'meh');
    create function ${S}.emp_count() returns bigint language sql as 'select count(*) from ${S}.emp';
    create function ${S}.touch() returns trigger language plpgsql as 'begin return new; end';
    create trigger emp_touch before update on ${S}.emp for each row execute function ${S}.touch();
    insert into ${S}.dept values (1, 'Sales');
    insert into ${S}.emp select g, 'E' || g, 1, null from generate_series(1, 30) g;
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
const folder = (page: string, label: string) => {
  const m = new RegExp(`<summary>.*?<span>${label}</span><span class="kind">(\\d+)</span></summary>\\s*<ul class="tree">([\\s\\S]*?)</ul>`).exec(page);
  return m ? { n: Number(m[1]), names: [...m[2].matchAll(/<span>([^<]+)<\/span>/g)].map((x) => x[1]) } : null;
};

describe('Object Browser', () => {
  test('folders by object type; the filter; pgkiln\'s schemas only with system objects', async () => {
    const b = await builder();
    const page = (await b.get(`/builder/sql/objects?schema=${S}`)).body;
    assert.deepEqual(folder(page, 'Tables'), { n: 2, names: ['dept', 'emp'] });
    assert.deepEqual(folder(page, 'Views')?.names, ['emp_v']);
    assert.deepEqual(folder(page, 'Sequences')?.names, ['ticket_seq']);
    assert.deepEqual(folder(page, 'Types')?.names, ['mood']);
    assert.deepEqual(folder(page, 'Functions')?.names, ['emp_count()', 'touch()']);
    assert.deepEqual(folder(page, 'Triggers')?.names, ['emp_touch on emp']);
    assert.ok(folder(page, 'Indexes')!.names.includes('emp_name_idx'));
    assert.match(page, /Create database objects in ob75/, 'nothing selected: the create tiles');
    assert.doesNotMatch(page, /<option value="meta"/);
    assert.match((await b.get(`/builder/sql/objects?schema=${S}&system=1`)).body, /<option value="meta"/);
    assert.doesNotMatch((await b.get('/builder/sql/objects?schema=meta')).body, /<option value="meta" selected/, 'meta is not offered without system objects');
    const filtered = (await b.get(`/builder/sql/objects?schema=${S}&q=emp`)).body;
    assert.deepEqual(folder(filtered, 'Tables')?.names, ['emp']);
    assert.equal(folder(filtered, 'Sequences'), null, 'a folder without matches is left out');
  });

  test('a table in tabs: constraints with the keys, DDL, data in pages, dependencies', async () => {
    const b = await builder();
    const at = (tab: string, extra = '') => b.get(`/builder/sql/objects?schema=${S}&k=table&o=${S}.emp&tab=${tab}${extra}`).then((r) => r.body);
    const cons = await at('constraints');
    assert.match(cons, /emp_pkey<\/td><td>primary key<\/td><td>PRIMARY KEY \(id\)/);
    assert.match(cons, /FOREIGN KEY \(dept_id\) REFERENCES ob75\.dept\(id\)<\/td><td>ob75\.dept/);
    assert.match(cons, /FOREIGN KEY \(boss\) REFERENCES ob75\.emp\(id\)/);
    assert.match(await at('ddl'), /create table emp \(\n {2}id integer not null,/);
    const data = await at('data', '&p=2');
    assert.match(data, /Rows 26–30/);
    assert.match(await at('dependencies'), /ob75\.emp_v/);
    assert.match(await at('triggers'), /emp_touch/);
    assert.match(await at('indexes'), /emp_name_idx/);
    // an object that is not in the schema is not shown
    assert.match((await b.get(`/builder/sql/objects?schema=${S}&k=table&o=${encodeURIComponent('meta.account')}`)).body, /Create database objects in ob75/);
    assert.match((await b.get(`/builder/sql/objects?schema=${S}&k=table&o=${encodeURIComponent(`${S}.emp; drop table ${S}.dept`)}`)).body, /Create database objects in ob75/);
    assert.equal((await owner.one(`select to_regclass('${S}.dept') is not null as ok`)).ok, true);
  });

  test('column actions write the ALTER TABLE into SQL Commands; nothing runs', async () => {
    const b = await builder();
    await b.get(`/builder/sql/objects?schema=${S}&k=table&o=${S}.emp&tab=columns`);
    const res = await b.submit('/builder/sql/objects/alter', { schema: S, table: `${S}.emp`, action: 'add', column: 'hired', type: 'date', not_null: '' });
    assert.equal(res.headers.location, '/builder/sql/worksheet');
    assert.match((await b.get('/builder/sql/commands')).body, /alter table ob75\.emp add column &quot;hired&quot; date;<\/textarea>/);
    assert.equal((await owner.query(`select 1 from information_schema.columns where table_schema = '${S}' and table_name = 'emp' and column_name = 'hired'`)).rowCount, 0);
    // the draft is shown once
    assert.doesNotMatch((await b.get('/builder/sql/commands')).body, /add column hired/);
    await b.get('/builder/sql/objects');
    await b.submit('/builder/sql/objects/alter', { schema: S, table: `${S}.emp`, action: 'rename', column: 'name', new_name: 'full name' });
    assert.match((await b.get('/builder/sql/commands')).body, /alter table ob75\.emp rename column &quot;name&quot; to &quot;full name&quot;|The new name must be a valid name/);
    for (const bad of <Record<string, string>[]>[
      { action: 'add', column: 'x', type: 'text; drop table ob75.dept' },
      { action: 'add', column: 'x"; drop', type: 'text' },
      { action: 'drop', column: 'nope' },
      { action: 'truncate', column: 'name' },
    ]) {
      await b.get('/builder/sql/objects');
      const r = await b.submit('/builder/sql/objects/alter', { schema: S, table: `${S}.emp`, ...bad });
      assert.notEqual(r.headers.location, '/builder/sql/worksheet', JSON.stringify(bad));
    }
    await b.get('/builder/sql/objects');
    assert.equal((await b.submit('/builder/sql/objects/alter', { schema: S, table: 'pg_catalog.pg_authid', action: 'drop', column: 'rolname' })).headers.location, '/builder/sql/objects');
    assert.equal((await b.post('/builder/sql/objects/alter', { __csrf: 'forged', table: `${S}.emp`, action: 'drop', column: 'name' })).statusCode, 403);
  });

  test('the + menu starts a CREATE statement; the tools are tabs with a More menu', async () => {
    const b = await builder();
    const cmd = (await b.get(`/builder/sql/commands?template=table&schema=${S}`)).body;
    assert.match(cmd, /create table &quot;ob75&quot;\.new_table \(/);
    assert.doesNotMatch((await b.get('/builder/sql/commands?template=table&schema=no_such_schema')).body, /no_such_schema/);
    assert.doesNotMatch((await b.get('/builder/sql/commands?template=evil')).body, /evil/);
    const tabs = /<nav class="ide-tabs sw-tabs[\s\S]*?<\/nav>/.exec(cmd)![0];
    assert.equal([...tabs.matchAll(/<a class="ide-tab"/g)].length, 5, 'five main tabs');
    assert.match(tabs, /<summary class="ide-tab">.*More/s);
    const quick = /<nav class="ide-tabs sw-tabs[\s\S]*?<\/nav>/.exec((await b.get('/builder/sql/quick')).body)![0];
    assert.match(quick, /<a class="ide-tab" href="\/builder\/sql\/quick" aria-current="page">/, 'the open tool from More is a tab too');
  });
});

describe('Object Browser (sprint 89, SQL-4)', () => {
  test('the schema: the one asked for is remembered; otherwise the parsing schema of the last changed application', async () => {
    const b = await builder();
    const shown = async (url: string) => /<select id="ob-schema" name="schema" data-autosubmit>[\s\S]*?<option value="([^"]+)" selected>/.exec((await b.get(url)).body)?.[1];
    // a new session without a schema of its own: the HR application's (its role uses hr), when HR changed last
    await owner.query(`update meta.app set updated_at = now() + interval '1 minute' where alias = 'hr'`);
    assert.equal(await shown('/builder/sql/objects'), 'hr');
    assert.equal(await shown(`/builder/sql/objects?schema=${S}`), S);
    assert.equal(await shown('/builder/sql/objects'), S, 'remembered');
    assert.equal(await shown('/builder/sql/objects?schema=nope_not_there'), S, 'an unknown schema: the remembered one');
  });

  test('a table\'s tabs on one row with More; NULL is a blank cell', async () => {
    const b = await builder();
    const page = (await b.get(`/builder/sql/objects?schema=${S}&k=table&o=${S}.emp&tab=data`)).body;
    const nav = /<nav class="settings-tabs ob-tabs"[^>]*>([\s\S]*?)<\/nav>/.exec(page)![1];
    const main = [...nav.replace(/<details[\s\S]*<\/details>/, '').matchAll(/>([A-Za-z ]+)<\/a>/g)].map((m) => m[1]);
    assert.deepEqual(main, ['Columns', 'Data', 'Indexes', 'Constraints', 'DDL']);
    assert.match(nav, /<details class="menu ob-more"><summary>More[\s\S]*>Triggers<\/a>[\s\S]*>Row level security<\/a>/);
    // a tab under More, when current, is shown in the row too
    const grants = /<nav class="settings-tabs ob-tabs"[^>]*>([\s\S]*?)<\/nav>/.exec((await b.get(`/builder/sql/objects?schema=${S}&k=table&o=${S}.emp&tab=grants`)).body)![1];
    assert.match(grants.replace(/<details[\s\S]*<\/details>/, ''), /aria-current="page">Grants<\/a>/);
    // boss is null in every row: blank, not an italic "null"
    assert.doesNotMatch(page, /<span class="null">null<\/span>/);
    assert.match(page, /<td>E1<\/td><td>1<\/td><td><\/td>/);
  });

  test('the Columns toolbar: Add, Modify, Rename, Drop; Modify writes type, nulls and default in one statement', async () => {
    const b = await builder();
    const page = (await b.get(`/builder/sql/objects?schema=${S}&k=table&o=${S}.emp&tab=columns`)).body;
    assert.match(page, /<div class="ob-toolbar" role="toolbar" aria-label="Columns">/);
    for (const label of ['Add column', 'Modify column', 'Rename column', 'Drop column']) assert.match(page, new RegExp(`<summary class="btn btn-sm"><svg[^>]*>[\\s\\S]*?</svg> ${label}</summary>`));
    let res = await b.submit('/builder/sql/objects/alter', { schema: S, table: `${S}.emp`, action: 'modify', column: 'name', type: 'varchar(80)', nullable: 'null', default_action: 'set', default: "'unknown'" });
    assert.equal(res.headers.location, '/builder/sql/worksheet');
    assert.match((await b.get('/builder/sql/commands')).body,
      /alter table ob75\.emp\n {2}alter column &quot;name&quot; type varchar\(80\) using &quot;name&quot;::varchar\(80\),\n {2}alter column &quot;name&quot; drop not null,\n {2}alter column &quot;name&quot; set default &#39;unknown&#39;;<\/textarea>/);
    assert.equal((await owner.one(`select attnotnull from pg_attribute where attrelid = '${S}.emp'::regclass and attname = 'name'`)).attnotnull, true, 'nothing ran');
    await b.submit('/builder/sql/objects/alter', { schema: S, table: `${S}.emp`, action: 'modify', column: 'dept_id', default_action: 'drop' });
    assert.match((await b.get('/builder/sql/commands')).body, /alter table ob75\.emp\n {2}alter column &quot;dept_id&quot; drop default;/);
    // refused: nothing to change, a statement as a default, a column the table hasn't, a type that isn't one
    for (const [bad, message] of [
      [{ column: 'name' }, /Nothing to change/],
      [{ column: 'name', default_action: 'set', default: '0; drop table ob75.dept' }, /A default is one expression/],
      [{ column: 'name', default_action: 'set', default: '0 -- x' }, /A default is one expression/],
      [{ column: 'nope', nullable: 'null' }, /Choose a column of the table/],
      [{ column: 'name', type: 'text; drop table x' }, /A type is a name/],
    ] as const) {
      res = await b.submit('/builder/sql/objects/alter', { schema: S, table: `${S}.emp`, action: 'modify', ...bad });
      assert.match((await b.get(res.headers.location as string)).body, message);
    }
    assert.ok(await owner.one(`select to_regclass('${S}.dept') is not null as ok`));
  });
});
