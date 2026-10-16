// Sprint 94 (Database Actions DA-8, part 1): an object's menu in the SQL Worksheet's navigator and the Object
// Browser: Quick DDL into the worksheet or as a file, Drop with what depends on it, Add index / trigger / policy,
// Open in a panel. Nothing runs: every statement goes into the worksheet.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
const S = 'oa94';
before(async () => {
  app = await buildApp({ logger: false });
  await owner.query(`drop schema if exists ${S} cascade`);
  await owner.query(`
    create schema ${S};
    create table ${S}.dept (id int primary key, name text not null);
    create table ${S}.emp (id int primary key, dept_id int references ${S}.dept);
    create view ${S}.dept_v as select name from ${S}.dept;
    create table ${S}.lonely (a int);
    create function ${S}.f(x int) returns int language sql as 'select x';
    alter table ${S}.dept enable row level security;
    create policy only_one on ${S}.dept using (id = 1);
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
const act = (k: string, o: string, d: string, n?: string) => `/builder/sql/objects/action?${new URLSearchParams({ schema: S, k, o, do: d, ...(n ? { n } : {}) })}`;
const textarea = (page: string) => /<textarea id="ws-sql"[^>]*>([\s\S]*?)<\/textarea>/.exec(page)![1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

describe('an object\'s menu', () => {
  test('in the worksheet\'s navigator and the Object Browser\'s tree', async () => {
    const b = await builder();
    const ws = (await b.get(`/builder/sql/worksheet?schema=${S}`)).body;
    assert.match(ws, /<details class="menu obj-menu"><summary title="Actions for dept"/);
    assert.match(ws, new RegExp(`href="/builder/sql/objects/action\\?schema=${S}&amp;k=table&amp;o=${S}.dept&amp;do=drop"`));
    assert.match(ws, new RegExp(`data-obj-open="/builder/sql/objects/panel\\?schema=${S}&amp;k=table&amp;o=${S}.dept"`));
    const ob = (await b.get(`/builder/sql/objects?schema=${S}`)).body;
    assert.match(ob, /<li class="ob-item"><a [^>]*>.*?<span>emp<\/span>.*?<\/a><details class="menu obj-menu">/s);
  });

  test('Quick DDL goes into a new worksheet, or comes as a file', async () => {
    const b = await builder();
    await b.get('/builder/sql/worksheet');
    const r = await b.get(act('table', `${S}.dept`, 'ddl'));
    assert.equal(r.statusCode, 303);
    assert.equal(r.headers.location, '/builder/sql/worksheet');
    const page = (await b.get('/builder/sql/worksheet')).body;
    assert.match(page, /data-source="insert"/);
    const sql = textarea(page);
    assert.match(sql, /^-- DDL of oa94\.dept\nset search_path to oa94, public;\n\ncreate table dept \(/);
    assert.match(sql, /create policy only_one on dept/);
    const file = await b.get(act('function', `${S}.f(integer)`, 'download'));
    assert.equal(file.headers['content-disposition'], 'attachment; filename="f_integer.sql"');
    assert.match(file.body, /CREATE OR REPLACE FUNCTION oa94\.f\(x integer\)/);
  });

  test('Drop lists what depends on the object; nothing is dropped', async () => {
    const b = await builder();
    await b.get(act('table', `${S}.dept`, 'drop'));
    const sql = textarea((await b.get('/builder/sql/worksheet')).body);
    assert.match(sql, /-- These depend on oa94\.dept: drop them first, or add CASCADE to drop them too:/);
    assert.match(sql, /--   view oa94\.dept_v/);
    assert.match(sql, /--   constraint emp_dept_id_fkey on table oa94\.emp/);
    assert.match(sql, /drop table oa94\.dept;$/);
    await b.get(act('table', `${S}.lonely`, 'drop'));
    assert.equal(textarea((await b.get('/builder/sql/worksheet')).body), '-- Nothing else depends on oa94.lonely.\ndrop table oa94.lonely;');
    await b.get(act('policy', `${S}.dept`, 'drop', 'only_one on dept'));
    assert.equal(textarea((await b.get('/builder/sql/worksheet')).body), 'drop policy only_one on oa94.dept;');
    assert.ok((await owner.one(`select to_regclass('${S}.dept') as t`))!.t, 'still there');
  });

  test('Add index, trigger and policy write a statement to fill in (tables only)', async () => {
    const b = await builder();
    await b.get(act('table', `${S}.emp`, 'index'));
    assert.equal(textarea((await b.get('/builder/sql/worksheet')).body), 'create index emp_id_idx on oa94.emp (id);');
    await b.get(act('table', `${S}.emp`, 'trigger'));
    assert.match(textarea((await b.get('/builder/sql/worksheet')).body), /create trigger emp_trg\n {2}before insert or update on oa94\.emp/);
    await b.get(act('table', `${S}.emp`, 'policy'));
    assert.match(textarea((await b.get('/builder/sql/worksheet')).body), /alter table oa94\.emp enable row level security;\n\ncreate policy emp_select on oa94\.emp/);
    assert.equal((await b.get(act('view', `${S}.dept_v`, 'index'))).statusCode, 404);
  });

  test('Open: the Object Browser\'s detail as a fragment whose links stay in the panel', async () => {
    const b = await builder();
    const p = await b.get(`/builder/sql/objects/panel?schema=${S}&k=table&o=${S}.dept`);
    assert.equal(p.statusCode, 200);
    assert.doesNotMatch(p.body, /<html|<body/);
    assert.match(p.body, /^<div class="obj-panel" data-label="Tables: oa94\.dept">/);
    assert.match(p.body, /href="\/builder\/sql\/objects\/panel\?schema=oa94&amp;k=table&amp;o=oa94\.dept&amp;tab=data"/);
  });

  test('only listed objects of a usable schema; anything else is not found', async () => {
    const b = await builder();
    for (const url of [
      act('table', `${S}.nope`, 'ddl'), act('table', `${S}.dept`, 'evil'), act('view', `${S}.dept`, 'ddl'),
      `/builder/sql/objects/action?schema=meta&k=table&o=meta.app&do=ddl`, `/builder/sql/objects/panel?schema=meta&k=table&o=meta.app`,
      act('policy', `${S}.dept`, 'drop', 'x on dept'), `/builder/sql/objects/panel?schema=${S}&k=policy&o=${S}.dept&n=only_one%20on%20dept`,
    ]) assert.equal((await b.get(url)).statusCode, 404, url);
    const anon = new Browser(app);
    assert.equal((await anon.get(act('table', `${S}.dept`, 'ddl'))).headers.location, '/builder/login');
  });
});
