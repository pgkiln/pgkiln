// Sprint 243 (MG-17, migration 200): binary request bodies. meta.web_request(..., p_body_blob, p_chunk_bytes) and
// meta.web_request_source(..., p_body_blob, p_content_type): the bytes reach the service unchanged, Content-Type from
// p_headers, the size limit PGKILN_REST_MAX_UPLOAD_BYTES, retries send the same bytes, uploads in ranges follow
// nextExpectedRanges; src/webupload.ts sendBinary; a REST module handler with "body": "blob" (HR page 71).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';

process.env.PGKILN_SECRET_KEY ??= 'test-only-secret-key-0123456789abcdef';
process.env.PGKILN_REST_ALLOWED_HOSTS = '127.0.0.1,localhost';
process.env.PGKILN_REST_PRIVATE_HOSTS = '127.0.0.1';

const { buildApp } = await import('../src/app.ts');
const { closePools, owner, runtime } = await import('../src/db.ts');
const { encryptSecret } = await import('../src/secrets.ts');
const wr = await import('../src/webrequests.ts');
const up = await import('../src/webupload.ts');
const { handlerProblems } = await import('../src/runtime/rest.ts');
const { Browser } = await import('./helpers.ts');

let app: FastifyInstance;
let appId: number;
let mock: http.Server;
let base = '';
const alias = 'wr-blob-s243';
const ROLE = 'pgkiln_wr_s243';
type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer };
const seen: Seen[] = [];
let failNext = 0;
/** the upload session the mock keeps (as Microsoft Graph does) */
let session: Buffer = Buffer.alloc(0);

const asApp = <T>(fn: (q: (sql: string, params?: unknown[]) => Promise<any[]>) => Promise<T>) =>
  runtime.tx(async (c) => {
    await c.query(`select set_config('pgkiln.app_id', $1, true), set_config('pgkiln.app_user', 'ann', true)`, [String(appId)]);
    await c.query(`set local role ${ROLE}`);
    return fn(async (sql, params = []) => (await c.query(sql, params)).rows);
  });
const one = async (sql: string, params: unknown[] = []) => (await asApp((q) => q(sql, params)))[0];
const response = async (id: string | number) => (await one('select meta.web_response($1) as r', [id])).r;

before(async () => {
  app = await buildApp({ logger: false });
  mock = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      const u = new URL(req.url!, 'http://x');
      if (u.pathname.startsWith('/upload')) {
        if (failNext > 0) {
          failNext--;
          res.writeHead(503, { 'content-type': 'text/plain' });
          return res.end('busy');
        }
        res.writeHead(201, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ size: body.length, type: req.headers['content-type'], auth: req.headers.authorization ?? null }));
      }
      if (u.pathname === '/session') {
        // Graph: Content-Range bytes a-b/total; 202 + nextExpectedRanges until complete, then 201
        const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(req.headers['content-range'] ?? ''));
        if (!m) {
          res.writeHead(400);
          return res.end();
        }
        const [start, , total] = [Number(m[1]), Number(m[2]), Number(m[3])];
        if (start !== session.length) {
          res.writeHead(416, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ nextExpectedRanges: [`${session.length}-`] }));
        }
        session = Buffer.concat([session, body]);
        // the first time a range ends past 100000 bytes, keep only 100000 of it and ask again from there
        if (u.searchParams.get('lose') === '1' && session.length > 100_000 && !seen.some((s) => s.url.includes('lost'))) {
          session = session.subarray(0, 100_000);
          seen.at(-1)!.url += '#lost';
        }
        if (session.length < total) {
          res.writeHead(202, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ nextExpectedRanges: [`${session.length}-${total - 1}`] }));
        }
        res.writeHead(201, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ id: 'item-1', size: session.length }));
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;

  await owner.query(`delete from meta.app where alias = $1`, [alias]);
  await owner.query(`drop role if exists ${ROLE}`);
  await owner.query(`create role ${ROLE} nologin`);
  await owner.query(`grant ${ROLE} to pgkiln_runtime`);
  appId = (await owner.one(`insert into meta.app (alias, name, authentication, db_role) values ($1, 'Blob test', 'none', $2) returning id`, [alias, ROLE])).id;
  await owner.query(
    `insert into meta.web_credential (app_id, name, type, secret_enc, valid_for) values ($1, 'T_BLOB_TOKEN', 'bearer', $2, $3)`,
    [appId, encryptSecret('t0ken-s243'), [`${base}/upload/`]],
  );
  await owner.query(
    `insert into meta.rest_source (app_id, name, url, method, credential, headers, params, columns) values
       ($1, 'T_BLOB_SRC', $2, 'PUT', 'T_BLOB_TOKEN', '{}', $3::jsonb, '[]'),
       ($1, 'T_BLOB_GET', $4, 'GET', null, '{}', '[]', '[]')`,
    [appId, `${base}/upload/{name}`, JSON.stringify([{ name: 'name', in: 'path', required: true }]), `${base}/upload/x`],
  );
});

after(async () => {
  await owner.query('delete from meta.app where id = $1', [appId]);
  await owner.query(`drop role if exists ${ROLE}`);
  mock.close();
  await app.close();
  await closePools();
});

describe('meta.web_request with a binary body (MG-17)', () => {
  test('SQL refuses what it can check: method, both bodies, ranges, header names', async () => {
    const url = `${base}/upload/a`;
    const bad = async (sql: string, re: RegExp) => assert.rejects(asApp((q) => q(sql, sql.includes('$1') ? [url] : [])), re);
    await bad(`select meta.web_request($1, 'GET', p_body_blob => '\\x01'::bytea)`, /POST, PUT or PATCH, not GET/);
    await bad(`select meta.web_request($1, 'PUT', 'text', p_body_blob => '\\x01'::bytea)`, /not both/);
    await bad(`select meta.web_request($1, 'POST', p_body_blob => '\\x01'::bytea, p_chunk_bytes => 65536)`, /sent with PUT/);
    await bad(`select meta.web_request($1, 'PUT', p_body_blob => '\\x01'::bytea, p_chunk_bytes => 1000)`, /65536/);
    await bad(`select meta.web_request($1, 'PUT', p_chunk_bytes => 65536)`, /give p_body_blob/);
    await bad(`select meta.web_request($1, 'PUT', p_body_blob => '\\x01'::bytea, p_headers => '{"Content-Length": "1"}')`, /set by the server/);
    await bad(`select meta.web_request_source('t_blob_get', p_body_blob => '\\x01'::bytea)`, /not GET/);
    await assert.rejects(asApp((q) => q(`select meta.web_request_source('t_blob_src', p_content_type => 'image/png')`)), /media type of p_body_blob/);
  });

  test('the bytes arrive unchanged, with the Content-Type of p_headers; the blob is let go once it succeeded', async () => {
    const data = randomBytes(300_000);
    data[0] = 0; // NUL bytes and all
    const id = (await one(`select meta.web_request($1, 'PUT', p_body_blob => $2, p_headers => '{"Content-Type": "image/jpeg"}', p_credential => 'T_BLOB_TOKEN') as id`,
      [`${base}/upload/photo.jpg`, data])).id;
    assert.equal((await response(id)).body_blob_bytes, 300_000);
    await wr.webRequestTick();
    const r = await response(id);
    assert.equal(r.status, 'ok', r.message);
    assert.equal(r.status_code, 201);
    assert.deepEqual(r.json, { size: 300_000, type: 'image/jpeg', auth: 'Bearer t0ken-s243' });
    const got = seen.at(-1)!;
    assert.equal(got.method, 'PUT');
    assert.ok(got.body.equals(data), 'the same bytes');
    assert.equal(got.headers['content-length'], '300000');
    assert.ok(!got.headers['transfer-encoding']);
    const row = await owner.one('select body_blob, body_blob_bytes, body from meta.web_request_log where id = $1', [id]);
    assert.equal(row.body_blob, null);
    assert.equal(Number(row.body_blob_bytes), 300_000);
    assert.equal(row.body, null);
  });

  test('without a Content-Type header the body is application/octet-stream', async () => {
    const id = (await one(`select meta.web_request($1, 'POST', p_body_blob => '\\xdeadbeef'::bytea) as id`, [`${base}/upload/raw`])).id;
    await wr.webRequestTick();
    assert.equal((await response(id)).json.type, 'application/octet-stream');
    assert.equal(seen.at(-1)!.body.toString('hex'), 'deadbeef');
  });

  test('retries send the same bytes; the blob stays until the request succeeded', async () => {
    const data = randomBytes(5000);
    failNext = 1;
    const id = (await one(`select meta.web_request($1, 'PUT', p_body_blob => $2, p_max_attempts => 3) as id`, [`${base}/upload/again`, data])).id;
    await wr.webRequestTick();
    let r = await response(id);
    assert.equal(r.status, 'retry');
    assert.ok((await owner.one('select body_blob from meta.web_request_log where id = $1', [id])).body_blob.equals(data), 'kept for the next attempt');
    await owner.query(`update meta.web_request_log set next_attempt_at = now() where id = $1`, [id]);
    await wr.webRequestTick();
    r = await response(id);
    assert.equal(r.status, 'ok');
    assert.equal(r.attempts, 2);
    const both = seen.filter((s) => s.url === '/upload/again');
    assert.equal(both.length, 2);
    for (const s of both) assert.ok(s.body.equals(data));
    // the same idempotency key on both attempts
    assert.equal(both[0].headers['idempotency-key'], both[1].headers['idempotency-key']);
  });

  test('larger than PGKILN_REST_MAX_UPLOAD_BYTES: an error, never sent and never retried', async () => {
    const was = process.env.PGKILN_REST_MAX_UPLOAD_BYTES;
    process.env.PGKILN_REST_MAX_UPLOAD_BYTES = '1000';
    const n = seen.length;
    try {
      const id = (await one(`select meta.web_request($1, 'PUT', p_body_blob => $2, p_max_attempts => 5) as id`, [`${base}/upload/big`, Buffer.alloc(1001)])).id;
      await wr.webRequestTick();
      const r = await response(id);
      assert.equal(r.status, 'error');
      assert.match(r.message, /larger than 1000 bytes \(PGKILN_REST_MAX_UPLOAD_BYTES\)/);
      assert.equal(seen.length, n, 'nothing sent');
      // exactly the limit is fine
      const ok = (await one(`select meta.web_request($1, 'PUT', p_body_blob => $2) as id`, [`${base}/upload/limit`, Buffer.alloc(1000)])).id;
      await wr.webRequestTick();
      assert.equal((await response(ok)).status_code, 201);
    } finally {
      if (was === undefined) delete process.env.PGKILN_REST_MAX_UPLOAD_BYTES;
      else process.env.PGKILN_REST_MAX_UPLOAD_BYTES = was;
    }
    assert.equal(up.maxUploadBytes(), was ? Number(was) : 25 * 1024 * 1024);
  });

  test('in ranges (p_chunk_bytes): Content-Range per range, 202 until the last, nextExpectedRanges followed', async () => {
    const data = randomBytes(200_000);
    session = Buffer.alloc(0);
    const n = seen.length;
    const id = (await one(`select meta.web_request($1, 'PUT', p_body_blob => $2, p_chunk_bytes => 65536, p_headers => '{"Content-Type": "application/pdf"}') as id`,
      [`${base}/session`, data])).id;
    await wr.webRequestTick();
    const r = await response(id);
    assert.equal(r.status_code, 201, JSON.stringify(r));
    assert.equal(r.json.size, 200_000);
    assert.equal(r.chunk_bytes, 65536);
    assert.ok(session.equals(data));
    const ranges = seen.slice(n).map((s) => s.headers['content-range']);
    assert.deepEqual(ranges, ['bytes 0-65535/200000', 'bytes 65536-131071/200000', 'bytes 131072-196607/200000', 'bytes 196608-199999/200000']);
    assert.ok(seen.slice(n).every((s) => s.headers['content-type'] === 'application/pdf' && s.method === 'PUT'));
  });

  test('a service that kept less than a range asks for the rest: the next range starts there', async () => {
    const data = randomBytes(150_000);
    session = Buffer.alloc(0);
    const res = await up.sendBinary({ appId, url: `${base}/session?lose=1`, body: data, chunkBytes: 65536 });
    assert.equal(res.status, 201);
    assert.ok(session.equals(data));
    const ranges = seen.filter((s) => s.url.startsWith('/session?lose=1')).map((s) => s.headers['content-range']);
    assert.deepEqual(ranges, ['bytes 0-65535/150000', 'bytes 65536-131071/150000', 'bytes 100000-149999/150000']);
  });

  test('a REST data source with a binary body: its URL, method and credential, p_content_type', async () => {
    const id = (await one(`select meta.web_request_source('t_blob_src', '{"name": "scan 1.pdf"}', p_body_blob => '\\x255044462d'::bytea, p_content_type => 'application/pdf') as id`)).id;
    await wr.webRequestTick();
    const r = await response(id);
    assert.equal(r.status_code, 201, r.message);
    assert.deepEqual(r.json, { size: 5, type: 'application/pdf', auth: 'Bearer t0ken-s243' });
    assert.equal(seen.at(-1)!.url, '/upload/scan%201.pdf');
    assert.equal(seen.at(-1)!.body.toString(), '%PDF-');
  });

  test('a page process: the request is made right after it, the blob comes with the take', async () => {
    const data = randomBytes(2000);
    const r = await asApp(async (q) => {
      const id = (await q(`select meta.web_request($1, 'PUT', p_body_blob => $2) as id`, [`${base}/upload/inline`, data]))[0].id;
      const taken = await q('select * from meta.web_request_take(5)');
      assert.equal(taken.length, 1);
      assert.ok(taken[0].body_blob.equals(data));
      const res = await wr.execute(appId, taken[0]);
      await q('select meta.web_request_done($1, $2, $3, null, null, null, null)', [id, res.status, res.statusCode]);
      return (await q('select meta.web_response($1) as r', [id]))[0].r;
    });
    assert.equal(r.status_code, 201);
    assert.ok(seen.at(-1)!.body.equals(data));
  });
});

describe('REST module handlers with "body": "blob"', () => {
  test('only sql and plpgsql handlers of POST, PUT or PATCH', () => {
    const h = (x: Record<string, unknown>) => handlerProblems([{ method: 'PUT', path: 'f/:name', type: 'sql', source: 'select 1', body: 'blob', ...x }]);
    assert.deepEqual(h({}), []);
    assert.deepEqual(h({ type: 'plpgsql', method: 'POST' }), []);
    assert.match(h({ method: 'GET', type: 'item' }).join(' '), /"body": "blob" belongs to/);
    assert.match(h({ method: 'DELETE' }).join(' '), /"body": "blob" belongs to/);
    assert.match(h({ body: 'text' }).join(' '), /"body": "blob" belongs to/);
  });

  test('HR page 71: a file item\'s blob is sent to the sample CRM, whole and in ranges', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const publicUrl = process.env.PUBLIC_URL;
    process.env.PUBLIC_URL = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    try {
      await owner.query(`delete from hr.crm_file where name like 's243-%'`);
      const b = new Browser(app);
      await b.login('king', 'king');
      const page = await b.get('/a/hr/71');
      assert.equal(page.statusCode, 200);
      assert.match(page.body, /Send in ranges/);
      for (const [button, name, size] of [['SEND', 's243-photo.png', 3000], ['SEND_RANGES', 's243-scan.pdf', 150_000]] as const) {
        await b.get('/a/hr/71');
        const data = randomBytes(size);
        const res = await b.upload('/a/hr/71', { __request: button }, { P71_FILE: { name, type: button === 'SEND' ? 'image/png' : 'application/pdf', data } });
        assert.equal(res.statusCode, 303, res.body.slice(0, 800));
        const after = await b.get(res.headers.location as string);
        assert.match(after.body, new RegExp(`HTTP 201: ${size} of ${size} bytes stored`), after.body.match(/P71_STATUS[\s\S]{0,400}/)?.[0] ?? 'no status');
        if (button === 'SEND_RANGES') assert.match(after.body, /sent in ranges of 65536 bytes/);
        const row = await owner.one('select content, content_type from hr.crm_file where name = $1', [name]);
        assert.ok(row.content.equals(data), name);
        assert.equal(row.content_type, button === 'SEND' ? 'image/png' : 'application/pdf');
        assert.match(after.body, new RegExp(name.replace('.', '\\.')));
      }
    } finally {
      if (publicUrl === undefined) delete process.env.PUBLIC_URL;
      else process.env.PUBLIC_URL = publicUrl;
      await owner.query(`delete from hr.crm_file where name like 's243-%'`);
    }
  });
});
