// Object storage for file items (0.31): AWS Signature Version 4 (the AWS
// documentation's example), a file item that keeps its files in an
// S3-compatible bucket (a mock that checks every signature): create, replace,
// remove, delete, a save that rolls back, several files per item, downloads
// through the application (RLS, checksum), and the credential's checks.
process.env.PGAPEX_REST_ALLOWED_HOSTS = '127.0.0.1';
process.env.PGAPEX_REST_PRIVATE_HOSTS = '127.0.0.1';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { objectStoreProblem, signV4 } from '../src/objectstore.ts';
import { encryptSecret } from '../src/secrets.ts';
import { Browser } from './helpers.ts';

const ALIAS = 't-objstore';
const ACCESS = 'AKIDTESTKEY123';
const SECRET = 'test/secret+key';
let app: FastifyInstance;
let appId: number;
let s3: http.Server;
let bucket = '';
const objects = new Map<string, { body: Buffer; type: string }>();
const refused: string[] = [];

/** A tiny S3: PUT, GET and DELETE of objects, each request's signature checked. */
function mockS3() {
  return http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const auth = String(req.headers.authorization ?? '');
      const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(auth);
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const hash = createHash('sha256').update(body).digest('hex');
      const ok = m && m[1] === ACCESS && m[3] === 'eu-test-1' && req.headers['x-amz-content-sha256'] === hash &&
        signV4({
          method: req.method!, url,
          headers: Object.fromEntries(m[4].split(';').map((h) => [h, String(req.headers[h])])),
          payloadHash: hash, accessKey: ACCESS, secretKey: SECRET, region: 'eu-test-1', amzDate: String(req.headers['x-amz-date']),
        }) === auth;
      if (!ok) {
        refused.push(`${req.method} ${url.pathname}`);
        res.writeHead(403).end('<Error><Code>SignatureDoesNotMatch</Code></Error>');
        return;
      }
      const key = decodeURIComponent(url.pathname);
      if (req.method === 'PUT') {
        objects.set(key, { body, type: String(req.headers['content-type']) });
        res.writeHead(200).end();
      } else if (req.method === 'GET') {
        const o = objects.get(key);
        if (o) res.writeHead(200, { 'content-type': o.type }).end(o.body);
        else res.writeHead(404).end();
      } else if (req.method === 'DELETE') {
        objects.delete(key);
        res.writeHead(204).end();
      } else res.writeHead(405).end();
    });
  });
}

const stored = () => [...objects.keys()].sort();

before(async () => {
  app = await buildApp({ logger: false });
  s3 = mockS3();
  await new Promise<void>((r) => s3.listen(0, '127.0.0.1', r));
  bucket = `http://127.0.0.1:${(s3.address() as AddressInfo).port}/hr-bucket`;
  await owner.query(`delete from meta.app where alias = $1`, [ALIAS]);
  await owner.query(`drop schema if exists t_objstore cascade`);
  await owner.query(`create schema t_objstore;
    create table t_objstore.doc (id serial primary key, title text not null, file_key text, file_name text, file_mime text, file_size int);
    create table t_objstore.attachment (id serial primary key, doc_id int not null references t_objstore.doc on delete cascade, file_key text not null, file_name text, file_mime text, file_size int);
    grant usage on schema t_objstore to pgapex_runtime;
    grant all on all tables in schema t_objstore to pgapex_runtime;
    grant all on all sequences in schema t_objstore to pgapex_runtime;`);
  appId = (await owner.one(`insert into meta.app (alias, name, authentication) values ($1, 'Object storage', 'none') returning id`, [ALIAS])).id;
  await owner.query(`insert into meta.web_credential (app_id, name, type, username, scope, secret_enc, valid_for) values ($1, 'S3', 'aws_sigv4', $2, 'eu-test-1', $3, $4)`,
    [appId, ACCESS, encryptSecret(SECRET), [bucket + '/']]);
  const pid = (await owner.one(`insert into meta.page (app_id, page_no, name, requires_auth, protection) values ($1, 1, 'Doc', false, 'unrestricted') returning id`, [appId])).id;
  const rid = (await owner.one(`insert into meta.region (page_id, seq, title, type, table_name, pk_column, pk_item) values ($1, 10, 'Doc', 'form', 't_objstore.doc', 'id', 'P1_ID') returning id`, [pid])).id;
  const store = { url: bucket, credential: 'S3', prefix: 'docs/' };
  await owner.query(`insert into meta.item (page_id, region_id, seq, name, type, source_column, config) values
      ($1, $2, 10, 'P1_ID', 'hidden', 'id', '{}'),
      ($1, $2, 20, 'P1_TITLE', 'text', 'title', '{}'),
      ($1, $2, 30, 'P1_FILE', 'file', 'file_key', $3),
      ($1, $2, 40, 'P1_ATTACH', 'file', 'file_key', $4)`,
    [pid, rid, JSON.stringify({ object_store: store, filename_column: 'file_name', mime_column: 'file_mime', size_column: 'file_size' }),
     JSON.stringify({ object_store: { ...store, prefix: 'attachments/' }, multiple: true, table: 't_objstore.attachment', parent_column: 'doc_id', key_column: 'id', filename_column: 'file_name', mime_column: 'file_mime', size_column: 'file_size' })]);
  await owner.query(`insert into meta.button (page_id, region_id, seq, name, label) values ($1, $2, 10, 'CREATE', 'Create'), ($1, $2, 20, 'SAVE', 'Save'), ($1, $2, 30, 'DELETE', 'Delete')`, [pid, rid]);
  await owner.query(`insert into meta.process (page_id, seq, name, type, region_id) values ($1, 10, 'Save', 'form_dml', $2)`, [pid, rid]);
});

after(async () => {
  await owner.query(`delete from meta.app where alias = $1`, [ALIAS]);
  await owner.query(`drop schema if exists t_objstore cascade`);
  await new Promise((r) => s3.close(r));
  await app.close();
  await closePools();
});

const file = (name: string, text: string, type = 'text/plain') => ({ name, type, data: Buffer.from(text) });
const downloads = (body: string, item: string) => [...body.matchAll(new RegExp(`href="(/a/${ALIAS}/1/file/${item}\\?[^"]+)"`, 'g'))].map((m) => m[1].replace(/&amp;/g, '&'));

describe('object storage', () => {
  test('Signature Version 4: the AWS documentation\'s GET Object example', () => {
    const url = new URL('https://examplebucket.s3.amazonaws.com/test.txt');
    const auth = signV4({
      method: 'GET', url, payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9', 'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'x-amz-date': '20130524T000000Z' },
      accessKey: 'AKIAIOSFODNN7EXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', amzDate: '20130524T000000Z',
    });
    assert.equal(auth, 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });

  test('a configuration is checked', () => {
    assert.equal(objectStoreProblem({ url: 'https://s3.eu-west-1.amazonaws.com/b', credential: 'S3', prefix: 'a/b/' }), null);
    assert.match(objectStoreProblem({ url: 'ftp://x/b', credential: 'S3' })!, /url/);
    assert.match(objectStoreProblem({ url: 'https://u:p@x/b', credential: 'S3' })!, /url/);
    assert.match(objectStoreProblem({ url: 'https://x/b', credential: 'bad name!' })!, /credential/);
    assert.match(objectStoreProblem({ url: 'https://x/b', credential: 'S3', prefix: '../up' })!, /prefix/);
  });

  test('create, download, replace, remove and delete: the bucket follows the record', async () => {
    const b = new Browser(app);
    await b.get(`/a/${ALIAS}/1`);
    let res = await b.upload(`/a/${ALIAS}/1`, { __request: 'CREATE', P1_TITLE: 'Contract' }, { P1_FILE: file('contract.txt', 'version 1') });
    assert.equal(res.statusCode, 303, res.body.slice(0, 300));
    const row = await owner.one(`select * from t_objstore.doc where title = 'Contract'`);
    assert.match(row.file_key, /^docs\/[0-9a-f-]{36}\/contract\.txt$/);
    assert.deepEqual([row.file_name, row.file_mime, row.file_size], ['contract.txt', 'text/plain', 9]);
    assert.deepEqual(stored(), [`/hr-bucket/${row.file_key}`]);
    assert.equal((await owner.one(`select count(*)::int as n from meta.temp_file where filename = 'contract.txt'`)).n, 0);

    // the form shows it with its size; the download comes from the bucket
    let page = (await b.get(`/a/${ALIAS}/1?P1_ID=${row.id}`)).body;
    assert.match(page, /contract\.txt/);
    assert.match(page, /9 B/);
    const dl = await b.get(downloads(page, 'P1_FILE')[0]);
    assert.equal(dl.statusCode, 200);
    assert.equal(dl.body, 'version 1');

    // a new file replaces the object (the old one goes once the save committed)
    res = await b.upload(`/a/${ALIAS}/1`, { __request: 'SAVE', P1_ID: String(row.id), P1_TITLE: 'Contract' }, { P1_FILE: file('contract-v2.txt', 'version 2') });
    assert.equal(res.statusCode, 303);
    const row2 = await owner.one(`select * from t_objstore.doc where id = $1`, [row.id]);
    assert.notEqual(row2.file_key, row.file_key);
    assert.deepEqual(stored(), [`/hr-bucket/${row2.file_key}`]);

    // remove the file
    await b.get(`/a/${ALIAS}/1?P1_ID=${row.id}`);
    res = await b.submit(`/a/${ALIAS}/1`, { __request: 'SAVE', P1_ID: String(row.id), P1_TITLE: 'Contract', P1_FILE__REMOVE: 'true' });
    assert.equal(res.statusCode, 303);
    assert.equal((await owner.one(`select file_key from t_objstore.doc where id = $1`, [row.id])).file_key, null);
    assert.deepEqual(stored(), []);

    // delete the record with a file
    await b.get(`/a/${ALIAS}/1?P1_ID=${row.id}`);
    await b.upload(`/a/${ALIAS}/1`, { __request: 'SAVE', P1_ID: String(row.id), P1_TITLE: 'Contract' }, { P1_FILE: file('c3.txt', 'v3') });
    assert.equal(stored().length, 1);
    await b.get(`/a/${ALIAS}/1?P1_ID=${row.id}`);
    res = await b.submit(`/a/${ALIAS}/1`, { __request: 'DELETE', P1_ID: String(row.id), P1_TITLE: 'Contract' });
    assert.equal(res.statusCode, 303);
    assert.deepEqual(stored(), []);
    assert.deepEqual(refused, [], 'every request was signed correctly');
  });

  test('a save that fails leaves nothing in the bucket', async () => {
    const b = new Browser(app);
    await b.get(`/a/${ALIAS}/1`);
    // title is not null: the insert fails after the file went to the bucket
    const res = await b.upload(`/a/${ALIAS}/1`, { __request: 'CREATE', P1_TITLE: '' }, { P1_FILE: file('orphan.txt', 'x') });
    assert.notEqual(res.statusCode, 303);
    assert.deepEqual(stored(), []);
  });

  test('several files per item: one object and row each; a removed one goes', async () => {
    const b = new Browser(app);
    await b.get(`/a/${ALIAS}/1`);
    const res = await b.upload(`/a/${ALIAS}/1`, { __request: 'CREATE', P1_TITLE: 'Bundle' }, { P1_ATTACH: [file('a.txt', 'A'), file('b.txt', 'BB')] });
    assert.equal(res.statusCode, 303, res.body.slice(0, 300));
    const doc = await owner.one(`select id from t_objstore.doc where title = 'Bundle'`);
    const rows = (await owner.query(`select id, file_key, file_name, file_size from t_objstore.attachment where doc_id = $1 order by id`, [doc.id])).rows;
    assert.deepEqual(rows.map((r) => [r.file_name, r.file_size]), [['a.txt', 1], ['b.txt', 2]]);
    assert.ok(rows.every((r) => /^attachments\//.test(r.file_key)));
    assert.equal(stored().length, 2);
    const page = (await b.get(`/a/${ALIAS}/1?P1_ID=${doc.id}`)).body;
    const links = downloads(page, 'P1_ATTACH');
    assert.equal(links.length, 2);
    assert.equal((await b.get(links[1])).body, 'BB');
    await b.submit(`/a/${ALIAS}/1`, { __request: 'SAVE', P1_ID: String(doc.id), P1_TITLE: 'Bundle', P1_ATTACH__REMOVE: String(rows[0].id) });
    assert.deepEqual(stored(), [`/hr-bucket/${rows[1].file_key}`]);
    await b.get(`/a/${ALIAS}/1?P1_ID=${doc.id}`);
    await b.submit(`/a/${ALIAS}/1`, { __request: 'DELETE', P1_ID: String(doc.id), P1_TITLE: 'Bundle' });
    assert.deepEqual(stored(), []);
  });

  test('the credential must be an access key, valid for the bucket', async () => {
    const b = new Browser(app);
    await b.get(`/a/${ALIAS}/1`);
    await owner.query(`update meta.web_credential set valid_for = '{https://elsewhere.example.com/}' where app_id = $1`, [appId]);
    try {
      const res = await b.upload(`/a/${ALIAS}/1`, { __request: 'CREATE', P1_TITLE: 'Nope' }, { P1_FILE: file('n.txt', 'n') });
      assert.notEqual(res.statusCode, 303);
      assert.equal((await owner.query(`select 1 from t_objstore.doc where title = 'Nope'`)).rowCount, 0);
      assert.deepEqual(stored(), []);
    } finally {
      await owner.query(`update meta.web_credential set valid_for = $2 where app_id = $1`, [appId, [bucket + '/']]);
    }
    await assert.rejects(owner.query(`update meta.web_credential set type = 'aws_v2' where app_id = $1`, [appId]), /check constraint/);
  });
});
