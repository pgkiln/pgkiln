// SQL Workshop → Unload Data (sprint 32): a table, a view or a query to CSV,
// JSON, Excel or XML, streamed from a cursor, over HTTP against the database.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { parseFile } from '../src/dataload.ts';
import { xmlTable } from '../src/xml.ts';
import { DEFAULT_UNLOAD, jsonValue, unloadStatement, unloadToBuffer, UnloadError, validTag, xmlName } from '../src/unload.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let dev: Browser;

before(async () => {
  app = await buildApp({ logger: false });
  await owner.query(`drop schema if exists ws_ul cascade; create schema ws_ul;
    create table ws_ul.item (id int primary key, name text, amount numeric(12,2), big bigint, flag boolean, created timestamptz, doc jsonb, data bytea, "odd col" text);
    insert into ws_ul.item values
      (1, 'plain', 10.50, 9007199254740993, true, '2026-10-05 12:34:56.789+00', '{"a": [1, 2]}', '\\x00ff', 'x'),
      (2, '=HYPERLINK("http://evil")', -3, null, false, null, null, null, null),
      (3, E'a,b;c "q" <tag> & \\'s\\'\\r\\nnext', null, 1, null, null, '"s"', null, '');
    create view ws_ul.item_v as select id, name from ws_ul.item;`);
  dev = new Browser(app);
  await dev.get('/builder/login');
  await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
});

after(async () => {
  await owner.query('drop schema if exists ws_ul cascade');
  await app.close();
  await closePools();
});

const unload = async (form: Record<string, string | string[]>) => {
  await dev.get(form.source === 'query' ? '/builder/sql/unload?source=query' : `/builder/sql/unload?table=${encodeURIComponent(String(form.table))}`);
  return dev.submit('/builder/sql/unload', { header: '1', bom: '1', ...form });
};
const all = ['id', 'name', 'amount', 'big', 'flag', 'created', 'doc', 'data', 'odd col'];

describe('Unload Data', () => {
  test('the page lists tables and views and the chosen table\'s columns; linked from the workshop and Load Data', async () => {
    const res = await dev.get('/builder/sql/unload');
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /<optgroup label="ws_ul">/);
    assert.match(res.body, /<option value="ws_ul.item">item<\/option>/);
    assert.match(res.body, /<option value="ws_ul.item_v">item_v \(view\)<\/option>/);
    assert.match(res.body, /href="\/builder\/sql\/unload" aria-current="page"/);
    const t = await dev.get('/builder/sql/unload?table=ws_ul.item');
    assert.match(t.body, /name="columns" value="odd col" checked/);
    assert.match(t.body, /name="where"/);
    assert.match((await dev.get('/builder/sql/load')).body, /href="\/builder\/sql\/unload"/);
    const q = await dev.get('/builder/sql/unload?source=query');
    assert.match(q.body, /<textarea id="f_query" name="query"/);
  });

  test('CSV: chosen columns, where and order; enclosed and formula-safe; reads back with Load Data', async () => {
    const res = await unload({ source: 'table', table: 'ws_ul.item', columns: ['id', 'name', 'amount', 'flag'], where: 'id <> 99 -- a comment', order: 'id desc', format: 'csv', delimiter: 'semicolon', enclosure: 'double' });
    assert.equal(res.statusCode, 200, res.body.slice(0, 500));
    assert.match(String(res.headers['content-type']), /^text\/csv/);
    assert.match(String(res.headers['content-disposition']), /attachment; filename="item\.csv"/);
    assert.ok(res.body.startsWith('﻿id;name;amount;flag\r\n3;"a,b;c ""q"" <tag> & \'s\'\r\nnext";;\r\n'), JSON.stringify(res.body.slice(0, 80)));
    assert.match(res.body, /\r\n2;"'=HYPERLINK\(""http:\/\/evil""\)";-3\.00;false\r\n1;plain;10\.50;true\r\n$/);
    const sheet = await parseFile('item.csv', res.rawPayload);
    assert.deepEqual(sheet.headers, ['id', 'name', 'amount', 'flag']);
    assert.equal(sheet.rows[0][1], `a,b;c "q" <tag> & 's'\r\nnext`);
    // no heading, no BOM, tab separated, single quotes
    const plain = await dev.submit('/builder/sql/unload', { source: 'table', table: 'ws_ul.item', columns: ['id', 'name'], where: 'id = 3', format: 'csv', delimiter: 'tab', enclosure: 'single' });
    assert.equal(plain.body, `3\t'a,b;c "q" <tag> & ''s''\r\nnext'\r\n`);
  });

  test('JSON: an array of objects with exact numbers, json values and booleans', async () => {
    const res = await unload({ source: 'table', table: 'ws_ul.item', columns: all, order: 'id', format: 'json' });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type']), /^application\/json/);
    assert.match(res.body, /"big":9007199254740993/, 'bigint not rounded');
    const rows = JSON.parse(res.body);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[0], { id: 1, name: 'plain', amount: 10.5, big: 9007199254740992, flag: true, created: '2026-10-05 12:34:56.789+00', doc: { a: [1, 2] }, data: '\\x00ff', 'odd col': 'x' });
    assert.equal(rows[1].flag, false);
    assert.equal(rows[1].created, null);
    assert.equal(rows[2].doc, 's');
    // an empty result is an empty array
    const none = await unload({ source: 'query', query: 'select 1 as x where false;', format: 'json' });
    assert.deepEqual(JSON.parse(none.body), []);
  });

  test('XML: row and root element names, escaped values, odd column names', async () => {
    const res = await unload({ source: 'table', table: 'ws_ul.item', columns: ['id', 'name', 'odd col', 'big'], order: 'id', format: 'xml', root_tag: 'items', row_tag: 'item' });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type']), /^application\/xml/);
    assert.ok(res.body.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<items>\n <item><id>1</id><name>plain</name><odd_col>x</odd_col><big>9007199254740993</big></item>'));
    assert.match(res.body, /<name>a,b;c &quot;q&quot; &lt;tag&gt; &amp; 's'&#13;\nnext<\/name>/);
    assert.match(res.body, /<item><id>2<\/id><name>=HYPERLINK\(&quot;http:\/\/evil&quot;\)<\/name><\/item>/, 'nulls left out');
    const t = xmlTable(res.body, 'item');
    assert.equal(t.rows.length, 3);
    // invalid element names are refused
    const bad = await unload({ source: 'table', table: 'ws_ul.item', columns: ['id'], format: 'xml', root_tag: 'a b', row_tag: 'ROW' });
    assert.equal(bad.statusCode, 422);
    assert.match(bad.body, /XML element names/);
  });

  test('Excel: typed cells, reads back with Load Data', async () => {
    const res = await unload({ source: 'table', table: 'ws_ul.item', columns: ['id', 'name', 'amount', 'flag', 'created'], order: 'id', format: 'xlsx' });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type']), /spreadsheetml/);
    assert.equal(res.rawPayload.subarray(0, 2).toString(), 'PK');
    const sheet = await parseFile('item.xlsx', res.rawPayload);
    assert.deepEqual(sheet.headers, ['id', 'name', 'amount', 'flag', 'created']);
    assert.equal(sheet.rows.length, 3);
    assert.equal(sheet.rows[1][1], '=HYPERLINK("http://evil")', 'text stays text (inline string, never a formula)');
  });

  test('a query: one SELECT only, read-only, errors are shown on the form', async () => {
    const ok = await unload({ source: 'query', query: '-- comment\nwith x as (select generate_series(1, 3) as n) select n, n * 2 as double from x order by n;', format: 'csv' });
    assert.equal(ok.statusCode, 200);
    assert.match(String(ok.headers['content-disposition']), /filename="query\.csv"/);
    assert.equal(ok.body, '﻿n,double\r\n1,2\r\n2,4\r\n3,6\r\n');
    for (const [query, message] of [
      ['select 1; select 2', /exactly one SELECT/],
      ['delete from ws_ul.item', /Only a SELECT/],
      ['\\copy ws_ul.item to x', /exactly one SELECT/],
      ['with d as (delete from ws_ul.item returning *) select * from d', /read-only transaction/],
      ['select * into ws_ul.copy from ws_ul.item', /read-only transaction|not allowed/],
      ['select nextval(\'ws_ul.nope\')', /does not exist/],
      ['select 1/0', /division by zero/],
    ] as [string, RegExp][]) {
      const res = await unload({ source: 'query', query, format: 'csv' });
      assert.equal(res.statusCode, 422, query);
      assert.match(res.body, message, query);
      assert.match(res.body, /<textarea id="f_query" name="query"[^>]*>/, 'the form again');
    }
    assert.equal((await owner.one('select count(*)::int as n from ws_ul.item')).n, 3);
    assert.equal((await owner.one(`select to_regclass('ws_ul.copy') as t`)).t, null);
    // table mode: the WHERE text can't add a statement
    const sneaky = await unload({ source: 'table', table: 'ws_ul.item', columns: ['id'], where: '1 = 1); delete from ws_ul.item where (true', format: 'csv' });
    assert.equal(sneaky.statusCode, 422);
    assert.equal((await owner.one('select count(*)::int as n from ws_ul.item')).n, 3);
    // unknown tables and columns
    assert.equal((await dev.submit('/builder/sql/unload', { source: 'table', table: 'ws_ul.nope', columns: 'id', format: 'csv' })).statusCode, 422);
    const cols = await dev.submit('/builder/sql/unload', { source: 'table', table: 'ws_ul.item', columns: 'id) from pg_authid --', format: 'csv' });
    assert.equal(cols.statusCode, 422);
    assert.match(cols.body, /at least one column/);
  });

  test('streams many rows in batches; the row limit caps the result', async () => {
    const res = await unload({ source: 'query', query: 'select g as n, md5(g::text) as h from generate_series(1, 25000) g', format: 'csv' });
    assert.equal(res.statusCode, 200);
    const lines = res.body.split('\r\n');
    assert.equal(lines.length, 25002);
    assert.equal(lines[25000].split(',')[0], '25000');
    const c = await owner.pool.connect();
    try {
      await c.query('begin read only');
      const out = await unloadToBuffer(c, 'select g from generate_series(1, 5000) g', { ...DEFAULT_UNLOAD, format: 'json' }, 1500);
      assert.equal(JSON.parse(out.toString()).length, 1500);
      await c.query('rollback');
    } finally {
      c.release();
    }
  });

  test('helpers', () => {
    assert.equal(unloadStatement('  select 1 ;  '), 'select 1');
    assert.equal(unloadStatement('(select 1) union (select 2)'), '(select 1) union (select 2)');
    assert.equal(unloadStatement('values (1)'), 'values (1)');
    assert.throws(() => unloadStatement(''), UnloadError);
    assert.throws(() => unloadStatement('update t set a = 1'), UnloadError);
    assert.throws(() => unloadStatement(`select ';' as x; drop table t`), UnloadError);
    assert.equal(unloadStatement(`select ';' as x`), `select ';' as x`);
    for (const tag of ['xmlrow', 'XML', '1a', 'a<b', 'a b', '', 'x'.repeat(65)]) assert.equal(validTag(tag), false, tag);
    for (const tag of ['ROW', 'my-row', 'a.b', '_x']) assert.equal(validTag(tag), true, tag);
    assert.equal(xmlName('odd col'), 'odd_col');
    assert.equal(xmlName('1st'), '_1st');
    assert.equal(xmlName('xmlish'), '_xmlish');
    assert.equal(jsonValue('NaN', 1700), '"NaN"');
    assert.equal(jsonValue('1e+20', 701), '1e+20');
    assert.equal(jsonValue('Infinity', 701), '"Infinity"');
    assert.equal(jsonValue('007', 25), '"007"');
  });
});
