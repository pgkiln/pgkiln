// Sprint 228 (parity: SQL Workshop, "Missing: a recycle bin"; migration 186): a table dropped to the recycle bin is
// renamed to BIN$… in its schema with everything on it; SQL Workshop › Recycle Bin restores it (renamed back, or to
// another name) or purges it (dropped). The navigator leaves BIN$ tables out.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
const S = 'rb228';
const wipe = async () => {
  await owner.query(`drop schema if exists ${S} cascade`);
  await owner.query(`delete from meta.recycle_bin where schema_name = '${S}'`);
  await owner.query(`delete from meta.change_set where schema_name = '${S}'; delete from meta.change_set_counter where schema_name = '${S}'`);
};
before(async () => {
  app = await buildApp({ logger: false });
  await wipe();
  await owner.query(`create schema ${S};
    create table ${S}.emp (id int primary key, name text not null);
    insert into ${S}.emp values (1, 'a'), (2, 'b');
    create index emp_name_ix on ${S}.emp (name);
    create view ${S}.emp_v as select * from ${S}.emp;
    create table ${S}.other (id int)`);
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
  await b.get('/builder/sql/recycle-bin');
  return b;
};
const bin = async () => (await owner.query(`select id::int, original_name, bin_name from meta.recycle_bin where schema_name = $1 order by id`, [S])).rows;
const exists = async (name: string) => !!(await owner.one(`select to_regclass($1) as r`, [`${S}."${name}"`])).r;
const messages = async (b: Browser, url: string) => [...(await b.get(url)).body.matchAll(/<div class="alert alert-(?:error|success)"[^>]*>([\s\S]*?)<\/div>/g)].map((m) => m[1]).join(' | ');

describe('the recycle bin', () => {
  test('drop: renamed to BIN$… with its rows, index and view; listed; left out of the navigator; in the change log', async () => {
    const b = await builder();
    const confirm = await b.get(`/builder/sql/recycle-bin/drop?schema=${S}&name=emp`);
    assert.equal(confirm.statusCode, 200, `${confirm.statusCode} ${confirm.headers.location} ${confirm.body.slice(0, 200)}`);
    assert.match(confirm.body, /Drop rb228\.emp to the recycle bin/);
    assert.equal((await b.submit('/builder/sql/recycle-bin/drop', { schema: S, name: 'emp' })).statusCode, 303);
    const [row] = await bin();
    assert.equal(row.original_name, 'emp');
    assert.match(row.bin_name, /^BIN\$[a-z0-9]{8,40}$/);
    assert.equal(await exists('emp'), false);
    assert.equal(Number((await owner.one(`select count(*) as n from ${S}."${row.bin_name}"`)).n), 2);
    assert.equal(Number((await owner.one(`select count(*) as n from ${S}.emp_v`)).n), 2, 'the view follows the table');
    assert.ok(await owner.one(`select 1 from pg_indexes where schemaname = $1 and tablename = $2 and indexname = 'emp_name_ix'`, [S, row.bin_name]));
    const page = (await b.get('/builder/sql/recycle-bin')).body;
    assert.match(page, /rb228\.emp/);
    assert.ok(page.includes(row.bin_name));
    const nav = (await b.get(`/builder/sql/objects?schema=${S}`)).body;
    assert.ok(!nav.includes(row.bin_name), 'not in the Object Browser');
    assert.ok(await owner.one(`select 1 from meta.change_set where schema_name = $1 and sql like 'alter table "rb228"."emp" rename to "BIN$%'`, [S]));
  });

  test('restore: back under its name; a taken name is refused, another name works', async () => {
    const b = await builder();
    const [row] = await bin();
    await owner.query(`create table ${S}.emp (x int)`);
    await b.submit(`/builder/sql/recycle-bin/${row.id}/restore`, { name: 'emp' });
    assert.match(await messages(b, '/builder/sql/recycle-bin'), /rb228\.emp exists already/);
    for (const bad of ['1x', 'a b', 'BIN$abcdefgh1', 'x'.repeat(64)]) {
      await b.get('/builder/sql/recycle-bin');
      await b.submit(`/builder/sql/recycle-bin/${row.id}/restore`, { name: bad });
    }
    assert.equal((await bin()).length, 1);
    await b.get('/builder/sql/recycle-bin');
    await b.submit(`/builder/sql/recycle-bin/${row.id}/restore`, { name: 'emp_back' });
    assert.equal((await bin()).length, 0);
    assert.equal(Number((await owner.one(`select count(*) as n from ${S}.emp_back`)).n), 2);
    await owner.query(`drop table ${S}.emp`);
  });

  test('purge: dropped for good; one with a dependent view is refused and stays; purge all', async () => {
    const b = await builder();
    await b.get(`/builder/sql/recycle-bin`);
    await b.submit('/builder/sql/recycle-bin/drop', { schema: S, name: 'other' });
    await b.get(`/builder/sql/recycle-bin`);
    await b.submit('/builder/sql/recycle-bin/drop', { schema: S, name: 'emp_back' });
    const rows = await bin();
    assert.equal(rows.length, 2);
    const other = rows.find((r) => r.original_name === 'other')!;
    await b.get(`/builder/sql/recycle-bin`);
    await b.submit(`/builder/sql/recycle-bin/${other.id}/purge`, {});
    assert.equal(await exists(other.bin_name), false);
    // the view emp_v depends on emp_back: no cascade, it stays
    await b.get(`/builder/sql/recycle-bin`);
    await b.submit('/builder/sql/recycle-bin/purge-all', {});
    assert.match(await messages(b, '/builder/sql/recycle-bin'), /not purged .*: rb228\.emp_back/);
    assert.equal((await bin()).length, 1);
    await owner.query(`drop view ${S}.emp_v`);
    await b.get(`/builder/sql/recycle-bin`);
    await b.submit('/builder/sql/recycle-bin/purge-all', {});
    assert.equal((await bin()).length, 0);
    assert.equal((await owner.one(`select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and c.relname like 'BIN$%'`, [S])).n, 0);
  });

  test('a table renamed or dropped outside the bin is forgotten', async () => {
    const b = await builder();
    await owner.query(`create table ${S}.gone (id int)`);
    await b.submit('/builder/sql/recycle-bin/drop', { schema: S, name: 'gone' });
    const [row] = await bin();
    await owner.query(`drop table ${S}."${row.bin_name}"`);
    await b.get('/builder/sql/recycle-bin');
    assert.equal((await bin()).length, 0);
  });
});
