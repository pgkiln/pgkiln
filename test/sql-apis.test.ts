// More APEX APIs in SQL (070): zips built and read in SQL (APEX_ZIP), XML and
// Excel in meta.parse_data (APEX_DATA_PARSER), the server unpacking archives
// it receives, and BOOLEAN session state (meta.v_boolean).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { strFromU8, unzipSync, zipSync, strToU8 } from 'fflate';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { unpackForSql } from '../src/unpack.ts';
import { xmlTable } from '../src/xml.ts';
import { writeXlsx } from '../src/xlsx.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
const digest = (b: Buffer) => createHash('sha256').update(b).digest();
const forget = (b: Buffer) => owner.query('delete from meta.unpacked_file where digest = $1', [digest(b)]);

before(async () => {
  app = await buildApp({ logger: false });
});
after(async () => {
  await app.close();
  await closePools();
});

describe('APEX_ZIP in SQL', () => {
  test('meta.zip_add / zip_finish build a zip any tool reads; zip_entries / zip_entry read it back', async () => {
    const z: Buffer = (await owner.one(
      `select meta.zip_finish(meta.zip_add(meta.zip_add(null, 'a.txt', convert_to('hello', 'utf8')), 'map/ünï.csv', convert_to(E'x,y\\n1,2', 'utf8'))) as z`)).z;
    const files = unzipSync(new Uint8Array(z));
    assert.deepEqual(Object.keys(files), ['a.txt', 'map/ünï.csv']);
    assert.equal(strFromU8(files['map/ünï.csv']), 'x,y\n1,2');
    const entries = (await owner.query('select name, size from meta.zip_entries($1)', [z])).rows;
    assert.deepEqual(entries, [{ name: 'a.txt', size: '5' }, { name: 'map/ünï.csv', size: '7' }]);
    assert.equal((await owner.one(`select convert_from(meta.zip_entry($1, 'a.txt'), 'utf8') as t`, [z])).t, 'hello');
    assert.equal((await owner.one(`select meta.zip_entry($1, 'nope') as t`, [z])).t, null);
    // an aggregate over rows
    const agg: Buffer = (await owner.one(`select meta.zip_agg(n || '.txt', convert_to(n, 'utf8') order by n) as z from (values ('b'), ('a')) v(n)`)).z;
    assert.deepEqual(Object.keys(unzipSync(new Uint8Array(agg))), ['a.txt', 'b.txt']);
    // the CRC is the standard one
    assert.equal(Number((await owner.one(`select meta.crc32(convert_to('The quick brown fox jumps over the lazy dog', 'utf8')) as c`)).c), 0x414fa339);
  });

  test('names stay inside the archive; a finished zip takes no more files', async () => {
    for (const bad of ['../evil.txt', '/etc/passwd', 'a/../../b', 'a\\b', ''])
      await assert.rejects(owner.query(`select meta.zip_add(null, $1, '\\x00')`, [bad]), /relative path/, bad);
    await assert.rejects(owner.query(`select meta.zip_add(meta.zip_finish(meta.zip_add(null, 'a', '')), 'b', '')`), /finished already/);
    await assert.rejects(owner.query(`select * from meta.zip_entries('\\x0102'::bytea)`), /not a zip/);
  });

  test('a compressed zip is read after the server unpacked it (as on upload or a web response)', async () => {
    const zip = Buffer.from(zipSync({ 'docs/readme.md': strToU8('# Hi\n'.repeat(200)), 'data.json': strToU8('[{"a":1}]') }, { level: 9 }));
    await forget(zip);
    await assert.rejects(owner.query(`select meta.zip_entry($1, 'data.json')`, [zip]), /compressed/);
    assert.equal(await unpackForSql(zip), true);
    assert.deepEqual((await owner.query('select name from meta.zip_entries($1)', [zip])).rows.map((r) => r.name), ['docs/readme.md', 'data.json']);
    assert.equal((await owner.one(`select convert_from(meta.zip_entry($1, 'data.json'), 'utf8') as t`, [zip])).t, '[{"a":1}]');
    // the runtime role reads entries through the functions only
    const { runtime } = await import('../src/db.ts');
    await assert.rejects(runtime.query('select * from meta.unpacked_entry'), /permission denied/);
    assert.equal((await runtime.query(`select count(*)::int as n from meta.zip_entries($1)`, [zip])).rows[0].n, 2);
    await forget(zip);
  });

  test('archives over the limits are not unpacked', async () => {
    assert.equal(await unpackForSql(Buffer.from('not a zip')), false);
    // declared sizes beyond the limit (a "zip bomb"): refused before inflating
    const bomb = Buffer.from(zipSync({ 'zeros.bin': new Uint8Array(210 * 1024 * 1024) }, { level: 9 }));
    assert.equal(await unpackForSql(bomb), false);
    assert.equal((await owner.query('select 1 from meta.unpacked_file where digest = $1', [digest(bomb)])).rowCount, 0);
  });
});

describe('meta.parse_data: XML and Excel', () => {
  const xmlCases: [string, string | null][] = [
    ['<employees><employee id="1"><name>King</name><job>PRESIDENT</job></employee><employee id="2"><name>Blake</name><address><city>Delft</city></address></employee></employees>', null],
    ['<r><meta><title>x</title></meta><items><item>a</item><item>b</item><item>c</item></items></r>', null],
    ['<n:list xmlns:n="urn:x"><n:row a="1" b="2"/><n:row a="3"><n:v>z &amp; y</n:v></n:row></n:list>', null],
    ['<orders><order no="7"><line sku="A"><qty>2</qty></line></order><order no="8"><line sku="B"><qty>5</qty></line></order></orders>', 'order'],
    ['<x><price cur="EUR">5</price><price cur="USD">6</price></x>', 'x/price'],
  ];

  test('XML rows and columns are the data loader\'s', async () => {
    for (const [xml, rowTag] of xmlCases) {
      const expected = xmlTable(xml, rowTag);
      const rows = (await owner.query('select line_number, cols from meta.parse_data_rows(convert_to($1, \'utf8\'), $2, \'auto\', true, null, $3)', [xml, 'data.xml', rowTag])).rows;
      assert.deepEqual(rows[0].cols, expected.headers, xml);
      assert.deepEqual(rows.slice(1).map((r) => r.cols), expected.rows.map((r) => r.map((v) => (v === null || v.trim() === '' ? null : v.trim()))), xml);
    }
    const cols = (await owner.query(`select column_name, data_type from meta.parse_data_columns(convert_to($1, 'utf8'))`, [xmlCases[0][0]])).rows;
    assert.deepEqual(cols.map((c) => c.column_name), ['id', 'name', 'job', 'address_city']);
    assert.equal(cols[0].data_type, 'integer');
    const data = (await owner.query(`select data from meta.parse_data(convert_to($1, 'utf8'))`, [xmlCases[0][0]])).rows;
    assert.deepEqual(data[1].data, { id: '2', name: 'Blake', job: null, address_city: 'Delft' });
  });

  test('XML with a DTD or entities is refused, broken XML is reported', async () => {
    await assert.rejects(owner.query(`select * from meta.parse_data(convert_to($1, 'utf8'))`, ['<!DOCTYPE x [<!ENTITY a "aaaa">]><x><y>&a;</y></x>']), /DTD or entity/);
    await assert.rejects(owner.query(`select * from meta.parse_data(convert_to($1, 'utf8'), 'x.xml')`, ['<x><y></x>']), /not valid XML/);
    await assert.rejects(owner.query(`select * from meta.parse_data(convert_to($1, 'utf8'), 'x.xml', 'auto', true, null, 'nothing')`, ['<x><y>1</y></x>']), /no <nothing> elements/);
    await assert.rejects(owner.query(`select * from meta.parse_data(convert_to($1, 'utf8'), 'x.xml', 'auto', true, null, 'a"]|//b')`, ['<x><y>1</y></x>']), /not an element name/);
  });

  test('Excel: the sheets the server read; a sheet by name', async () => {
    const book = writeXlsx({ name: 'Staff', headings: ['Name', 'Hired', 'Salary'], rows: [['King', { date: '1981-11-17' }, 5000], ['Blake', { date: '1981-05-01' }, 2850.5]] });
    await forget(book);
    await assert.rejects(owner.query(`select * from meta.parse_data($1, 'staff.xlsx')`, [book]), /has not been read by pgkiln/);
    assert.equal(await unpackForSql(book), true);
    const rows = (await owner.query(`select line_number, data from meta.parse_data($1, 'staff.xlsx')`, [book])).rows;
    assert.deepEqual(rows, [
      { line_number: 1, data: { name: 'King', hired: '1981-11-17', salary: '5000' } },
      { line_number: 2, data: { name: 'Blake', hired: '1981-05-01', salary: '2850.5' } },
    ]);
    const cols = (await owner.query(`select column_name, data_type from meta.parse_data_columns($1, 'staff.xlsx')`, [book])).rows;
    assert.deepEqual(cols.map((c) => c.data_type), ['text', 'date', 'numeric']);
    assert.equal((await owner.query(`select * from meta.parse_data($1, 'x.xlsx', 'auto', true, null, 'Staff')`, [book])).rowCount, 2);
    await assert.rejects(owner.query(`select * from meta.parse_data($1, 'x.xlsx', 'auto', true, null, 'Other')`, [book]), /no sheet named Other \(it has Staff\)/);
    // an xlsx is a zip too: its parts can be read
    assert.ok((await owner.query(`select 1 from meta.zip_entries($1) where name = 'xl/workbook.xml'`, [book])).rowCount);
    await forget(book);
  });

  test('a file item upload is unpacked for SQL', async () => {
    const book = writeXlsx({ name: 'Upload', headings: ['A'], rows: [['x'], ['y']] });
    await forget(book);
    const king = new Browser(app);
    await king.login('king');
    await king.get('/a/hr/13');
    await king.upload('/a/hr/13', {}, { P13_FILE: { name: 'upload.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data: book } });
    assert.ok((await owner.query('select 1 from meta.unpacked_file where digest = $1 and kind = \'xlsx\'', [digest(book)])).rowCount, 'unpacked on upload');
    assert.deepEqual((await owner.query(`select cols from meta.parse_data_rows($1)`, [book])).rows.map((r) => r.cols), [['A'], ['x'], ['y']]);
    await forget(book);
  });
});

describe('BOOLEAN session state', () => {
  test('meta.v_boolean reads true/false (and yes/no, 1/0, on/off, Y/N) as booleans', async () => {
    const s = await owner.one(`insert into meta.session (token_hash, state) values ('t-bool-' || gen_random_uuid(), $1) returning id`,
      [JSON.stringify({ P1_ON: 'true', P1_YES: 'Y', P1_ONE: '1', P1_OFF: 'off', P1_NO: 'false', P1_EMPTY: '', P1_TEXT: 'maybe' })]);
    try {
      const r = await owner.tx(async (c) => {
        await c.query(`select set_config('pgkiln.session_id', $1, true)`, [s.id]);
        return (await c.query(`select meta.v_boolean('p1_on') as a, meta.v_boolean('P1_YES') as b, meta.v_boolean('P1_ONE') as c, meta.v_boolean('P1_OFF') as d,
                                     meta.v_boolean('P1_NO') as e, meta.v_boolean('P1_EMPTY') as f, meta.v_boolean('P1_TEXT') as g, meta.v_boolean('P1_NONE') as h`)).rows[0];
      });
      assert.deepEqual(r, { a: true, b: true, c: true, d: false, e: false, f: null, g: null, h: null });
    } finally {
      await owner.query('delete from meta.session where id = $1', [s.id]);
    }
  });
});
