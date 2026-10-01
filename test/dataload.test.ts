// Data loading: CSV/XLSX parsing, the SQL Workshop's Load Data pages, and
// the data_load page process (HR page 13, which runs as the app's role).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { columnName, detectDelimiter, inferType, parseCsv, parseFile } from '../src/dataload.ts';
import { closePools, owner } from '../src/db.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
const csv = (text: string) => ({ name: 'data.csv', type: 'text/csv', data: Buffer.from(text) });

before(async () => {
  app = await buildApp({ logger: false });
});

after(async () => {
  await owner.query('drop table if exists public.dl_test_new, public.dl_test_existing');
  await owner.query('delete from hr.emp where empno between 9101 and 9399');
  await owner.query(`delete from hr.audit_log where table_name = 'emp' and row_pk::int between 9101 and 9399`);
  await app.close();
  await closePools();
});

async function builder() {
  const b = new Browser(app);
  await b.get('/builder/login');
  await b.submit('/builder/login', { username: 'admin', password: 'admin' });
  await b.get('/builder/sql/load');
  return b;
}

/** Upload in the builder; returns the URL of the target page. */
async function upload(b: Browser, file: { name: string; type: string; data: Buffer }, headers = true) {
  const res = await b.upload('/builder/sql/load', headers ? { headers: 'true' } : {}, { file });
  assert.equal(res.statusCode, 303, res.body.slice(0, 300));
  const url = String(res.headers.location);
  await b.get(url);
  return url.split('?')[0];
}

describe('parsing', () => {
  test('CSV: quotes, escaped quotes, line breaks in fields, CRLF, empty lines', () => {
    assert.deepEqual(parseCsv('a,b\r\n"x, ""y""","line\nbreak"\r\n\r\n1,\n'), [['a', 'b'], ['x, "y"', 'line\nbreak'], ['1', '']]);
  });

  test('the delimiter is detected outside quotes', () => {
    assert.equal(detectDelimiter('a;b;c\n1;2;3'), ';');
    assert.equal(detectDelimiter('"a,b";c;d\n'), ';');
    assert.equal(detectDelimiter('a\tb\tc'), '\t');
    assert.equal(detectDelimiter('a,b'), ',');
  });

  test('BOM, Windows-1252 and empty cells', async () => {
    const utf8 = await parseFile('x.csv', Buffer.from('\uFEFFnaam;stad\nJosé;Zürich\n;\n'));
    assert.deepEqual(utf8.headers, ['naam', 'stad']);
    assert.deepEqual(utf8.rows, [['José', 'Zürich']], 'rows without values are left out');
    const latin = await parseFile('x.csv', Buffer.from([0x6e, 0x0a, 0x4a, 0x6f, 0x73, 0xe9, 0x0a])); // "n\nJosé" in Windows-1252
    assert.deepEqual(latin.rows, [['José']]);
  });

  test('Excel files, with dates and numbers as written', async () => {
    const sheet = await parseFile('employees.xlsx', readFileSync('test/fixtures/employees.xlsx'));
    assert.equal(sheet.format, 'xlsx');
    assert.deepEqual(sheet.headers, ['empno', 'ename', 'job', 'hiredate', 'sal', 'deptno']);
    assert.deepEqual(sheet.rows[0], ['9101', 'XL ONE', 'CLERK', '2024-01-01', '1100.5', '20']);
  });

  test('JSON: arrays of objects, a wrapping object, JSON Lines; nested values as JSON text', async () => {
    const arr = await parseFile('x.json', Buffer.from('[{"empno": 1, "ename": "A", "tags": ["x"]}, {"ename": "B", "active": true, "empno": null}]'));
    assert.deepEqual(arr, { format: 'json', headers: ['empno', 'ename', 'tags', 'active'], rows: [['1', 'A', '["x"]', null], [null, 'B', null, 'true']] });
    const wrapped = await parseFile('data.txt', Buffer.from('\uFEFF {"employees": [{"a": 1}], "count": 1}'));
    assert.deepEqual(wrapped.rows, [['1']], 'detected by content, BOM allowed');
    const lines = await parseFile('x.jsonl', Buffer.from('{"a": 1}\n{"a": 2, "b": {"c": 3}}\n'));
    assert.deepEqual(lines, { format: 'json', headers: ['a', 'b'], rows: [['1', null], ['2', '{"c":3}']] });
    await assert.rejects(parseFile('x.json', Buffer.from('[1, 2]')), /must be an object/);
    await assert.rejects(parseFile('x.json', Buffer.from('[]')), /no records/);
    await assert.rejects(parseFile('x.json', Buffer.from('{"a": ')), /not valid JSON/);
  });

  test('binary files that are not Excel are refused', async () => {
    await assert.rejects(parseFile('x.csv', Buffer.from([0x00, 0x01, 0x02])), /not a text/);
    await assert.rejects(parseFile('x.xlsx', Buffer.from('PK\x03\x04garbage')), /not a readable Excel/);
  });

  test('type inference and column names', () => {
    assert.equal(inferType(['1', '-2', null]), 'integer');
    assert.equal(inferType(['1', '99999999999']), 'bigint');
    assert.equal(inferType(['1.5', '2']), 'numeric');
    assert.equal(inferType(['yes', 'no']), 'boolean');
    assert.equal(inferType(['2024-01-31']), 'date');
    assert.equal(inferType(['2024-01-31', '2024-02-01 10:30']), 'timestamp');
    assert.equal(inferType(['01-02-2024']), 'text', 'only ISO dates');
    const used = new Set<string>(['id']);
    assert.equal(columnName('Hire Date', used), 'hire_date');
    assert.equal(columnName('Hire date', used), 'hire_date_2');
    assert.equal(columnName('2nd name', used), 'c_2nd_name');
    assert.equal(columnName('Größe', used), 'grosse');
  });
});

describe('SQL Workshop: Load Data', () => {
  test('needs a signed-in developer', async () => {
    const res = await new Browser(app).get('/builder/sql/load');
    assert.equal(res.statusCode, 302);
    assert.match(String(res.headers.location), /\/builder\/login/);
  });

  test('upload, preview and load into a new table with inferred types', async () => {
    const b = await builder();
    const url = await upload(b, csv('Name;Price;In stock;Released\nWidget;9.95;yes;2024-03-01\n"Gadget; deluxe";19.50;no;2023-11-15\n'));
    const preview = await b.get(url);
    assert.match(preview.body, /Gadget; deluxe/);
    assert.match(preview.body, /delimiter “;”/);
    assert.match(preview.body, /<option selected>numeric<\/option>/);
    const res = await b.submit(url, {
      h: '1', target: 'new', new_table: 'public.dl_test_new',
      name_0: 'name', type_0: 'text', name_1: 'price', type_1: 'numeric', name_2: 'in_stock', type_2: 'boolean', name_3: 'released', type_3: 'date',
    });
    assert.equal(res.statusCode, 200, res.body.slice(0, 300));
    assert.match(res.body, /2 row\(s\) inserted/);
    const rows = (await owner.query('select name, price, in_stock, released::text from public.dl_test_new order by id')).rows;
    assert.deepEqual(rows[1], { name: 'Gadget; deluxe', price: '19.50', in_stock: false, released: '2023-11-15' });
    assert.equal((await b.get(url)).statusCode, 302, 'the uploaded file is removed after loading');
  });

  test('existing table: columns map by name; errors roll back everything unless skipped; merge by key', async () => {
    await owner.query('create table public.dl_test_existing (code text primary key, qty int not null, note text)');
    const b = await builder();
    const url = await upload(b, csv('Code,Qty,Note\nA,1,first\nB,x,bad qty\nC,3,\n'));
    const mapped = await b.get(`${url}?h=1&table=dl_test_existing`);
    assert.match(mapped.body, /<option value="qty" selected>/);
    const form = { h: '1', target: 'existing', table: 'dl_test_existing', map_0: 'code', map_1: 'qty', map_2: 'note', mode: 'append' };
    const failed = await b.submit(url, form);
    assert.equal(failed.statusCode, 422);
    assert.match(failed.body, /nothing was loaded/);
    assert.match(failed.body, /<td class="num">3<\/td><td>invalid input syntax for type integer: &quot;x&quot;/);
    assert.equal((await owner.one('select count(*)::int as n from public.dl_test_existing')).n, 0);

    const skipped = await b.submit(url, { ...form, skip_errors: 'true' });
    assert.match(skipped.body, /2 row\(s\) inserted, 1 skipped/);

    const again = await upload(b, csv('code,qty\nA,10\nD,4\n'));
    const merged = await b.submit(again, { h: '1', target: 'existing', table: 'dl_test_existing', map_0: 'code', map_1: 'qty', mode: 'merge' });
    assert.match(merged.body, /1 row\(s\) inserted, 1 updated/);
    const rows = (await owner.query('select code, qty, note from public.dl_test_existing order by code')).rows;
    assert.deepEqual(rows, [
      { code: 'A', qty: 10, note: 'first' },
      { code: 'C', qty: 3, note: null },
      { code: 'D', qty: 4, note: null },
    ]);
  });

  test("another developer session cannot use someone else's upload", async () => {
    const b = await builder();
    const url = await upload(b, csv('a\n1\n'));
    const other = await builder();
    assert.equal((await other.get(url)).statusCode, 302);
  });
});

describe('data_load process (HR page 13)', () => {
  async function as(user: string) {
    const b = new Browser(app);
    await b.login(user);
    await b.get('/a/hr/13');
    return b;
  }

  test('admins merge a file into hr.emp as the app role; the audit trail records who', async () => {
    const b = await as('king');
    const res = await b.upload('/a/hr/13', { __request: 'LOAD' }, {
      P13_FILE: csv('empno,ename,job,mgr,hiredate,sal,deptno\n9301,NOVAK,ANALYST,7566,2026-09-01,3100,20\n9302,OKAFOR,CLERK,7782,2026-09-15,1000,10\n'),
    });
    assert.equal(res.statusCode, 303, res.body.slice(0, 500));
    assert.match((await b.get('/a/hr/13')).body, /2 row\(s\) added, 0 updated/);
    assert.equal((await owner.one('select count(*)::int as n from hr.emp where empno in (9301, 9302)')).n, 2);
    const audit = await owner.one(`select changed_by from hr.audit_log where table_name = 'emp' and row_pk = '9301'`);
    assert.equal(audit.changed_by, 'king');
    const xlsx = await b.upload('/a/hr/13', { __request: 'LOAD' }, {
      P13_FILE: { name: 'employees.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data: readFileSync('test/fixtures/employees.xlsx') },
    });
    assert.equal(xlsx.statusCode, 303);
    assert.equal((await owner.one(`select hiredate::text from hr.emp where empno = 9101`)).hiredate, '2024-01-01');
  });

  test('a row with an error loads nothing and is reported on the file item', async () => {
    const b = await as('king');
    const res = await b.upload('/a/hr/13', { __request: 'LOAD' }, {
      P13_FILE: csv('empno,ename,sal,deptno\n9303,GOOD,1000,20\n9304,RICH,99999,20\n9305,NODEPT,1000,77\n'),
    });
    assert.equal(res.statusCode, 422);
    assert.match(res.body, /Nothing was loaded: 2 row\(s\) have errors/);
    assert.match(res.body, /3: Salary must stay below the president/, 'RAISE messages are shown');
    assert.match(res.body, /id="P13_FILE_error"/);
    assert.doesNotMatch(res.body, /emp_deptno_fkey/, 'constraint names are not shown');
    assert.equal((await owner.one('select count(*)::int as n from hr.emp where empno between 9303 and 9305')).n, 0);
  });

  test('the page and the process need the ADMIN role', async () => {
    const b = new Browser(app);
    await b.login('blake');
    assert.equal((await b.get('/a/hr/13')).statusCode, 403);
  });
});
