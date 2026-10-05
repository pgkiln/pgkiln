// Sprint 33 item 5: APEX PL/SQL API equivalents. meta.web_request (queued
// from SQL, made by the server: right after a page process, or by the
// scheduler pass) and meta.parse_data / meta.parse_data_columns (CSV and
// JSON parsed in SQL like the data loader).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';

process.env.PGAPEX_SECRET_KEY = 'test-only-secret-key-0123456789abcdef';
process.env.PGAPEX_REST_ALLOWED_HOSTS = '127.0.0.1,localhost';
process.env.PGAPEX_REST_PRIVATE_HOSTS = '127.0.0.1';

const { buildApp } = await import('../src/app.ts');
const { closePools, owner, runtime } = await import('../src/db.ts');
const { encryptSecret } = await import('../src/secrets.ts');
const wr = await import('../src/webrequests.ts');
const dl = await import('../src/dataload.ts');
const { Browser } = await import('./helpers.ts');

let app: FastifyInstance;
let appId: number;
let mock: http.Server;
let mockBase = '';
const alias = 'wr-s33';
const ROLE = 'pgapex_wr_s33';
const SCHEMA = 'wr_s33';
const seen: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];

/** SQL as the test app's code: its role, meta.app_id() set. */
const asApp = <T>(fn: (q: (sql: string, params?: unknown[]) => Promise<any[]>) => Promise<T>) =>
  runtime.tx(async (c) => {
    await c.query(`select set_config('pgapex.app_id', $1, true), set_config('pgapex.app_user', 'ann', true)`, [String(appId)]);
    await c.query(`set local role ${ROLE}`);
    return fn(async (sql, params = []) => (await c.query(sql, params)).rows);
  });

before(async () => {
  app = await buildApp({ logger: false });
  mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      const u = new URL(req.url!, 'http://x');
      if (u.pathname === '/json') {
        res.writeHead(200, { 'content-type': 'application/json', 'x-demo': 'yes' });
        return res.end(JSON.stringify({ ok: true, q: u.searchParams.get('q'), method: req.method, body }));
      }
      if (u.pathname === '/csv') {
        res.writeHead(200, { 'content-type': 'text/csv' });
        return res.end('id,name\n1,Ann\n2,Bob\n');
      }
      if (u.pathname === '/secure') {
        const ok = req.headers.authorization === `Basic ${Buffer.from('robot:pa55word').toString('base64')}`;
        res.writeHead(ok ? 200 : 401, { 'content-type': 'text/plain' });
        return res.end(ok ? 'welcome' : 'no');
      }
      if (u.pathname === '/big') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('x'.repeat(4000));
      }
      if (u.pathname === '/away') {
        res.writeHead(302, { location: '/json?q=moved' });
        return res.end();
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  mockBase = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;

  await owner.query(`drop schema if exists ${SCHEMA} cascade`);
  await owner.query(`delete from meta.app where alias = $1`, [alias]);
  await owner.query(`drop role if exists ${ROLE}`);
  await owner.query(`create role ${ROLE} nologin`);
  await owner.query(`grant ${ROLE} to pgapex_runtime`);
  await owner.query(`create schema ${SCHEMA}`);
  await owner.query(`grant usage on schema ${SCHEMA} to ${ROLE}`);
  await owner.query(`create table ${SCHEMA}.log (msg text)`);
  await owner.query(`grant select, insert on ${SCHEMA}.log to ${ROLE}`);
  appId = (await owner.one(`insert into meta.app (alias, name, authentication, db_role) values ($1, 'Web request test', 'none', $2) returning id`, [alias, ROLE])).id;
  const pageId = (await owner.one(`insert into meta.page (app_id, page_no, name, requires_auth) values ($1, 1, 'Home', false) returning id`, [appId])).id;
  const regionId = (await owner.one(`insert into meta.region (page_id, seq, title, type, source) values ($1, 10, 'Form', 'static', '<p>Call</p>') returning id`, [pageId])).id;
  await owner.query(`insert into meta.item (page_id, region_id, seq, name, label, type) values ($1, $2, 1, 'P1_Q', 'Q', 'text'), ($1, $2, 2, 'P1_REQ', 'Request', 'hidden')`, [pageId, regionId]);
  await owner.query(`insert into meta.button (page_id, region_id, name, label) values ($1, $2, 'CALL', 'Call')`, [pageId, regionId]);
  await owner.query(
    `insert into meta.process (page_id, seq, name, type, point, code, when_button) values
       ($1, 1, 'Queue', 'sql', 'submit', $2, 'CALL'), ($1, 2, 'Read', 'sql', 'submit', $3, 'CALL')`,
    [pageId,
     `select meta.web_request('${'MOCK'}/json?q=' || meta.url_encode(:P1_Q)) as p1_req`,
     `insert into ${SCHEMA}.log select (meta.web_response(:P1_REQ::bigint)->'json'->>'q') || ' ' || (meta.web_response(:P1_REQ::bigint)->>'status_code')`],
  );
  // the mock's port is only known now
  await owner.query(`update meta.process set code = replace(code, 'MOCK', $2) where page_id = $1`, [pageId, mockBase]);
  await owner.query(
    `insert into meta.web_credential (app_id, name, type, username, secret_enc, valid_for) values ($1, 'T_WR_BASIC', 'basic', 'robot', $2, $3)`,
    [appId, encryptSecret('pa55word'), [`${mockBase}/secure`]],
  );
  await owner.query(
    `insert into meta.rest_source (app_id, name, url, params, columns, timeout_s) values ($1, 'T_WR_SRC', $2, $3::jsonb, '[]', 7)`,
    [appId, `${mockBase}/json`, JSON.stringify([{ name: 'q', in: 'query', default: 'dflt' }])],
  );
});

after(async () => {
  await owner.query('delete from meta.app where id = $1', [appId]);
  await owner.query(`drop schema if exists ${SCHEMA} cascade`);
  await owner.query(`drop role if exists ${ROLE}`);
  mock.close();
  await app.close();
  await closePools();
});

const response = async (id: string | number) => (await asApp((q) => q('select meta.web_response($1) as r', [id])))[0].r;

describe('meta.web_request: queued from SQL, made by the server', () => {
  test('outside a page process the scheduler pass makes it after the commit', async () => {
    const id = (await asApp((q) => q(`select meta.web_request($1, 'POST', '{"a":1}', '{"Content-Type": "application/json", "X-Trace": "t1"}') as id`, [`${mockBase}/json?q=hello`])))[0].id;
    let r = await response(id);
    assert.equal(r.status, 'queued');
    assert.equal(r.body, null);
    const ran = await wr.webRequestTick();
    assert.ok(ran.includes(String(id)));
    r = await response(id);
    assert.equal(r.status, 'ok');
    assert.equal(r.status_code, 200);
    assert.equal(r.headers['x-demo'], 'yes');
    assert.equal(r.content_type, 'application/json');
    assert.deepEqual(r.json, { ok: true, q: 'hello', method: 'POST', body: '{"a":1}' });
    const sent = seen.at(-1)!;
    assert.equal(sent.headers['x-trace'], 't1');
    assert.equal(sent.headers['content-type'], 'application/json');
    assert.ok(r.finished_at && r.requested_at);
  });

  test('a page process queues it, the next process reads the response (same submit)', async () => {
    const b = new Browser(app);
    await b.get(`/a/${alias}/1`);
    const res = await b.submit(`/a/${alias}/1`, { __request: 'CALL', P1_Q: 'a b&c' });
    assert.equal(res.statusCode, 303, res.body);
    const log = (await owner.query(`select msg from ${SCHEMA}.log`)).rows.map((r) => r.msg);
    assert.deepEqual(log, ['a b&c 200']);
    // made once: the scheduler finds nothing left
    const last = (await owner.one(`select status, requested_by from meta.web_request_log where app_id = $1 order by id desc limit 1`, [appId]));
    assert.equal(last.status, 'ok');
    assert.equal(last.requested_by, 'nobody');
  });

  test('a REST data source with parameters; text and blob bodies', async () => {
    const [a, b] = await asApp(async (q) => [
      (await q(`select meta.web_request_source('t_wr_src', '{"q": "from source"}') as id`))[0].id,
      (await q(`select meta.web_request($1) as id`, [`${mockBase}/csv`]))[0].id,
    ]);
    const row = await owner.one('select timeout_s from meta.web_request_log where id = $1', [a]);
    assert.equal(row.timeout_s, 7, "the source's time limit");
    await wr.webRequestTick();
    assert.equal((await response(a)).json.q, 'from source');
    const csv = await response(b);
    assert.equal(csv.body, 'id,name\n1,Ann\n2,Bob\n');
    assert.equal(csv.json, null);
    // the response parsed with meta.parse_data, as the app
    const rows = await asApp((q) => q(`select p.data->>'name' as name from meta.parse_data(meta.web_response_blob($1)) p order by line_number`, [b]));
    assert.deepEqual(rows.map((r) => r.name), ['Ann', 'Bob']);
  });

  test('web credentials sign the request; the secret is never stored', async () => {
    const id = (await asApp((q) => q(`select meta.web_request($1, p_credential => 't_wr_basic') as id`, [`${mockBase}/secure`])))[0].id;
    await wr.webRequestTick();
    const r = await response(id);
    assert.equal(r.status_code, 200);
    assert.equal(r.body, 'welcome');
    const all = JSON.stringify((await owner.query('select * from meta.web_request_log where app_id = $1', [appId])).rows);
    assert.ok(!all.includes('pa55word') && !all.includes(Buffer.from('robot:pa55word').toString('base64')));
    // not valid for another URL of the same host
    const other = (await asApp((q) => q(`select meta.web_request($1, p_credential => 'T_WR_BASIC') as id`, [`${mockBase}/json`])))[0].id;
    await wr.webRequestTick();
    const o = await response(other);
    assert.equal(o.status, 'error');
    assert.match(o.message, /not valid for this URL/);
  });

  test('errors: not on the allow-list, too large, a status code is not an error', async () => {
    const [a, b, c] = await asApp(async (q) => [
      (await q(`select meta.web_request('https://api.example.com/x') as id`))[0].id,
      (await q(`select meta.web_request($1) as id`, [`${mockBase}/nothing`]))[0].id,
      (await q(`select meta.web_request($1) as id`, [`${mockBase}/big`]))[0].id,
    ]);
    const max = process.env.PGAPEX_REST_MAX_BYTES;
    process.env.PGAPEX_REST_MAX_BYTES = '1000';
    try {
      await wr.webRequestTick();
    } finally {
      if (max === undefined) delete process.env.PGAPEX_REST_MAX_BYTES;
      else process.env.PGAPEX_REST_MAX_BYTES = max;
    }
    const ra = await response(a);
    assert.equal(ra.status, 'error');
    assert.match(ra.message, /allow-list/);
    const rb = await response(b);
    assert.equal(rb.status, 'ok');
    assert.equal(rb.status_code, 404);
    const rc = await response(c);
    assert.equal(rc.status, 'error');
    assert.match(rc.message, /larger than 1000 bytes/);
  });

  test('redirects are followed through the same checks', async () => {
    const id = (await asApp((q) => q(`select meta.web_request($1) as id`, [`${mockBase}/away`])))[0].id;
    await wr.webRequestTick();
    const r = await response(id);
    assert.equal(r.status_code, 200);
    assert.equal(r.json.q, 'moved');
    assert.equal(r.url, `${mockBase}/json?q=moved`);
  });

  test('retention: finished requests older than a day, interrupted runs, never-run requests', async () => {
    const ids = (await asApp((q) => q(`select meta.web_request($1) as id from generate_series(1, 3)`, [`${mockBase}/json`]))).map((r) => r.id);
    await owner.query(`update meta.web_request_log set status = 'ok', finished_at = now() - interval '25 hours' where id = $1`, [ids[0]]);
    await owner.query(`update meta.web_request_log set status = 'running', started_at = now() - interval '20 minutes' where id = $1`, [ids[1]]);
    await owner.query(`update meta.web_request_log set requested_at = now() - interval '25 hours' where id = $1`, [ids[2]]);
    await wr.purgeWebRequests(true);
    const rows = (await owner.query('select id, status, message from meta.web_request_log where id = any($1) order by id', [ids])).rows;
    assert.deepEqual(rows.map((r) => [String(r.id), r.status]), [[String(ids[1]), 'error'], [String(ids[2]), 'error']]);
    assert.match(rows[0].message, /interrupted/);
    assert.match(rows[1].message, /not run within 24 hours/);
  });

  test('more than five in one page process: the rest wait for the scheduler', async () => {
    await owner.query('delete from meta.web_request_log where app_id = $1', [appId]);
    const done = await asApp(async (q) => {
      await q(`select meta.web_request($1) from generate_series(1, 7)`, [`${mockBase}/json`]);
      // what the runtime does after a process
      return (await q('select * from meta.web_request_take(5)')).length;
    });
    assert.equal(done, 5);
    const states = (await owner.query('select status, count(*)::int as n from meta.web_request_log where app_id = $1 group by status order by status', [appId])).rows;
    // taken ones stay "running" here because this test didn't finish them; the purge marks them later
    assert.deepEqual(states, [{ status: 'queued', n: 2 }, { status: 'running', n: 5 }]);
    await owner.query('delete from meta.web_request_log where app_id = $1', [appId]);
  });
});

describe('meta.parse_data: CSV and JSON in SQL, like the data loader', () => {
  const sql = async (content: string | Buffer, opts: { file?: string; headers?: boolean } = {}) => {
    const data = typeof content === 'string' ? Buffer.from(content) : content;
    const cols = (await runtime.query(`select * from meta.parse_data_columns($1, $2, p_headers => $3) order by column_position`, [data, opts.file ?? null, opts.headers ?? true])).rows;
    const rows = (await runtime.query(`select * from meta.parse_data($1, $2, p_headers => $3) order by line_number`, [data, opts.file ?? null, opts.headers ?? true])).rows;
    return { cols, rows };
  };
  /** The same file through src/dataload.ts: headings, rows, inferred types and column names. */
  const node = async (content: string | Buffer, opts: { file?: string; headers?: boolean } = {}) => {
    const data = typeof content === 'string' ? Buffer.from(content) : content;
    const sheet = await dl.parseFile(opts.file ?? 'upload', data, { headers: opts.headers ?? true });
    const used = new Set<string>();
    return {
      headings: sheet.headers,
      rows: sheet.rows,
      types: sheet.headers.map((_, i) => dl.inferType(sheet.rows.map((r) => r[i]))),
      names: sheet.headers.map((h) => dl.columnName(h, used)),
    };
  };
  const same = async (content: string | Buffer, opts: { file?: string; headers?: boolean } = {}) => {
    const [s, n] = [await sql(content, opts), await node(content, opts)];
    assert.deepEqual(s.cols.map((c) => c.heading), n.headings, 'headings');
    assert.deepEqual(s.cols.map((c) => c.column_name), n.names, 'column names');
    assert.deepEqual(s.cols.map((c) => c.data_type), n.types, 'types');
    assert.deepEqual(s.rows.map((r) => r.cols), n.rows, 'rows');
    assert.deepEqual(s.rows.map((r) => r.line_number), n.rows.map((_, i) => i + 1));
    return s;
  };

  test('CSV: delimiters, quotes, line breaks in quotes, blank lines, BOM, CRLF', async () => {
    await same('Name;Hire Date;Salary;Active\r\n"Smith; J";2024-01-02;1000.5;yes\r\n\r\n"Jones\nJr";2023-05-06 10:00;2000;no\r\n');
    await same('﻿id,"say ""hi""",Ünïcode Näme,2024\n1,"a ""q""",x,\n3000000000,b,,7\n');
    await same('a|b|c\n1|2\n4|5|6|7\n');
    await same('x\ty\n1\t2\n', { file: 'data.tsv' });
    await same('a,b,a,\n1,2,3,4\n');
    const s = await same('1,2\n3,4\n', { headers: false });
    assert.deepEqual(s.rows[0].data, { column_1: '1', column_2: '2' });
  });

  test('JSON: an array, an object with one array, JSON Lines; nested values as JSON text', async () => {
    const s = await sql('{"employees": [{"id": 1, "name": "A", "tags": [1,2]}, {"id": 2, "extra": "x", "name": ""}]}');
    const n = await node('{"employees": [{"id": 1, "name": "A", "tags": [1,2]}, {"id": 2, "extra": "x", "name": ""}]}');
    assert.deepEqual(s.cols.map((c) => c.heading), n.headings);
    assert.deepEqual(s.cols.map((c) => c.data_type), n.types);
    assert.deepEqual(s.rows.map((r) => r.cols), [['1', 'A', '[1,2]', null], ['2', null, null, 'x']]);
    await same('[{"a": 1, "b": true}, {"b": false, "c": "2024-01-01"}]');
    await same('{"id": 1, "v": "x"}\n{"id": 2, "v": "y"}\n');
    const sel = (await runtime.query(`select cols from meta.parse_data(convert_to('{"result": {"items": [{"k": 1}], "other": [1]}}', 'UTF8'), p_row_selector => 'result.items')`)).rows;
    assert.deepEqual(sel, [{ cols: ['1'] }]);
  });

  test('typed rows with jsonb_populate_record, skip rows, the row limit', async () => {
    await owner.query(`create table ${SCHEMA}.emp (name text, hire_date date, salary numeric)`);
    const rows = (await owner.query(
      `select e.* from meta.parse_data(convert_to($1, 'UTF8')) p, jsonb_populate_record(null::${SCHEMA}.emp, p.data) e order by p.line_number`,
      ['Name,Hire Date,Salary\nAnn,2024-01-02,10.5\nBob,,\n'],
    )).rows;
    assert.deepEqual(rows, [{ name: 'Ann', hire_date: '2024-01-02', salary: '10.5' }, { name: 'Bob', hire_date: null, salary: null }]);
    const skipped = (await runtime.query(`select cols from meta.parse_data(convert_to($1, 'UTF8'), p_skip_rows => 2)`, ['Report\nmade today\na,b\n1,2\n'])).rows;
    assert.deepEqual(skipped, [{ cols: ['1', '2'] }]);
    await assert.rejects(runtime.query(`select * from meta.parse_data(convert_to($1, 'UTF8'), p_max_rows => 2)`, ['a\n1\n2\n3\n']), /the file has 3 rows; at most 2/);
  });

  test('Excel and XML are refused with a pointer to the data loader', async () => {
    const { readFileSync } = await import('node:fs');
    const xlsx = readFileSync(new URL('./fixtures/employees.xlsx', import.meta.url));
    await assert.rejects(runtime.query('select * from meta.parse_data($1)', [xlsx]), /Excel \(\.xlsx\) files can't be parsed in SQL/);
    await assert.rejects(runtime.query(`select * from meta.parse_data(convert_to('<rows><r><a>1</a></r></rows>', 'UTF8'))`), /XML is not parsed/);
    await assert.rejects(runtime.query(`select * from meta.parse_data('\\x610062'::bytea, p_format => 'csv')`), /not a text/);
  });

  test('Windows-1252 text and a big file', async () => {
    const latin = Buffer.from([0x6e, 0x61, 0x6d, 0x65, 0x0a, 0x63, 0x61, 0x66, 0xe9, 0x0a]); // "name\ncafé" in Windows-1252
    await same(latin);
    const big = 'id,name,amount\n' + Array.from({ length: 20000 }, (_, i) => `${i},"name ${i}, x",${i}.5`).join('\n');
    const t0 = Date.now();
    const n = (await runtime.query(`select count(*)::int as n from meta.parse_data(convert_to($1, 'UTF8'))`, [big])).rows[0].n;
    assert.equal(n, 20000);
    assert.ok(Date.now() - t0 < 10000);
  });
});
