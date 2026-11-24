// (sprint 244, MG-29) OneDrive / SharePoint as object storage for file items (provider "graph"), against a local
// Microsoft Graph stub (test/graph-stub.ts): an OAuth2 client credentials token, simple uploads into the configured
// folder, upload sessions in ranges for files over 4 MiB (the upload URL gets no credential), downloads through pgkiln
// (Graph's redirect to a pre-authenticated URL followed by the server, without the credential), replace, remove,
// delete, a save that rolls back, several files per item in a SharePoint site's library, and the configuration check.
process.env.PGKILN_REST_ALLOWED_HOSTS = '127.0.0.1';
process.env.PGKILN_REST_PRIVATE_HOSTS = '127.0.0.1';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { objectStoreOf, objectStoreProblem } from '../src/objectstore.ts';
import { driveUrl, GRAPH_CHUNK, graphFileName, pathUrl } from '../src/objectstore-graph.ts';
import { putObject, resolveStore, staticPart } from '../src/objectstore.ts';
import { documentPdf } from '../src/runtime/document.ts';
import { BUILT_IN } from '../src/runtime/pdf.ts';
import { mailTick } from '../src/mail/mail.ts';
import { encryptSecret } from '../src/secrets.ts';
import { Browser } from './helpers.ts';
import { startGraphStub, stubItem, STUB_CLIENT_ID, STUB_CLIENT_SECRET, STUB_TOKEN, type GraphStub } from './graph-stub.ts';

process.env.PGKILN_SECRET_KEY = 'test-only-secret-key-0123456789abcdef';

const ALIAS = 't-graphstore';
const DRIVE = 'b!hrdrive';
const SITE = 'contoso.sharepoint.com,1111,2222';
let app: FastifyInstance;
let appId: number;
let stub: GraphStub;

before(async () => {
  app = await buildApp({ logger: false });
  stub = await startGraphStub();
  await owner.query(`delete from meta.app where alias = $1`, [ALIAS]);
  await owner.query(`drop schema if exists t_graphstore cascade`);
  await owner.query(`create schema t_graphstore;
    create table t_graphstore.doc (id serial primary key, title text not null, file_key text, file_name text, file_mime text, file_size int);
    create table t_graphstore.attachment (id serial primary key, doc_id int not null references t_graphstore.doc on delete cascade, file_key text not null, file_name text, file_mime text, file_size int);
    grant usage on schema t_graphstore to pgkiln_runtime, hr_app;
    grant all on all tables in schema t_graphstore to pgkiln_runtime, hr_app;
    grant all on all sequences in schema t_graphstore to pgkiln_runtime, hr_app;`);
  appId = (await owner.one(`insert into meta.app (alias, name, authentication, db_role) values ($1, 'Graph storage', 'none', 'hr_app') returning id`, [ALIAS])).id;
  await owner.query(`insert into meta.web_credential (app_id, name, type, username, secret_enc, token_url, grant_type, scope, valid_for)
      values ($1, 'GRAPH', 'oauth2', $2, $3, $4, 'client_credentials', 'https://graph.microsoft.com/.default', $5)`,
    [appId, STUB_CLIENT_ID, encryptSecret(STUB_CLIENT_SECRET), stub.tokenUrl, [stub.url + '/']]);
  const pid = (await owner.one(`insert into meta.page (app_id, page_no, name, requires_auth, protection) values ($1, 1, 'Doc', false, 'unrestricted') returning id`, [appId])).id;
  const rid = (await owner.one(`insert into meta.region (page_id, seq, title, type, table_name, pk_column, pk_item) values ($1, 10, 'Doc', 'form', 't_graphstore.doc', 'id', 'P1_ID') returning id`, [pid])).id;
  await owner.query(`insert into meta.item (page_id, region_id, seq, name, type, source_column, config) values
      ($1, $2, 10, 'P1_ID', 'hidden', 'id', '{}'),
      ($1, $2, 20, 'P1_TITLE', 'text', 'title', '{}'),
      ($1, $2, 30, 'P1_FILE', 'file', 'file_key', $3),
      ($1, $2, 40, 'P1_ATTACH', 'file', 'file_key', $4)`,
    [pid, rid,
     JSON.stringify({ object_store: { provider: 'graph', url: stub.url, drive: DRIVE, folder: 'HR/Documents', credential: 'GRAPH' }, filename_column: 'file_name', mime_column: 'file_mime', size_column: 'file_size' }),
     JSON.stringify({ object_store: { provider: 'graph', url: stub.url, site: SITE, folder: 'Attachments', credential: 'GRAPH' }, multiple: true, table: 't_graphstore.attachment', parent_column: 'doc_id', key_column: 'id', filename_column: 'file_name', mime_column: 'file_mime', size_column: 'file_size' })]);
  await owner.query(`insert into meta.button (page_id, region_id, seq, name, label) values ($1, $2, 10, 'CREATE', 'Create'), ($1, $2, 20, 'SAVE', 'Save'), ($1, $2, 30, 'DELETE', 'Delete')`, [pid, rid]);
  await owner.query(`insert into meta.process (page_id, seq, name, type, region_id) values ($1, 10, 'Save', 'form_dml', $2)`, [pid, rid]);
});

after(async () => {
  await owner.query(`delete from meta.app where alias = $1`, [ALIAS]);
  await owner.query(`drop schema if exists t_graphstore cascade`);
  await stub.close();
  await app.close();
  await closePools();
});

const file = (name: string, data: string | Buffer, type = 'text/plain') => ({ name, type, data: Buffer.isBuffer(data) ? data : Buffer.from(data) });
const downloads = (body: string, item: string) => [...body.matchAll(new RegExp(`href="(/a/${ALIAS}/1/file/${item}\\?[^"]+)"`, 'g'))].map((m) => m[1].replace(/&amp;/g, '&'));
const stored = () => [...stub.items.values()].map((i) => `${i.drive}:${i.folder}/${i.name}`).sort();

describe('object storage in OneDrive / SharePoint (Microsoft Graph)', () => {
  test('a configuration is checked', () => {
    const ok = { provider: 'graph', drive: 'b!abc-DEF_1', folder: 'HR/Documents', credential: 'GRAPH' };
    assert.equal(objectStoreProblem(ok), null);
    assert.equal(objectStoreProblem({ provider: 'graph', site: 'contoso.sharepoint.com,1-2,3-4', credential: 'GRAPH' }), null);
    assert.equal(objectStoreProblem({ ...ok, url: 'https://graph.microsoft.us/v1.0' }), null);
    assert.match(objectStoreProblem({ provider: 'graph', credential: 'GRAPH' })!, /"drive".*"site"/);
    assert.match(objectStoreProblem({ ...ok, folder: 'HR/../Finance' })!, /folder/);
    assert.match(objectStoreProblem({ ...ok, folder: 'HR/a:b' })!, /folder/);
    assert.match(objectStoreProblem({ ...ok, drive: '..' })!, /drive/);
    assert.match(objectStoreProblem({ ...ok, drive: 'a/b' })!, /drive/);
    assert.match(objectStoreProblem({ ...ok, url: 'https://u:p@graph.example/v1.0' })!, /url/);
    assert.match(objectStoreProblem({ ...ok, credential: 'bad name' })!, /credential/);
    assert.match(objectStoreProblem({ ...ok, bucket: 'x' })!, /unknown key "bucket"/);
    assert.match(objectStoreProblem({ provider: 'ftp', url: 'https://x/b', credential: 'S3' })!, /provider/);
    // S3 stays the default, and "s3" may be named
    assert.equal(objectStoreProblem({ provider: 's3', url: 'https://x/b', credential: 'S3' }), null);
    assert.equal(objectStoreOf({ object_store: ok })?.provider, 'graph');
    assert.equal(objectStoreOf({ object_store: { provider: 'ftp', url: 'https://x/b', credential: 'S3' } }), null);
    // file names never become paths; reserved names get a prefix
    assert.equal(graphFileName('../../etc/passwd'), '_.._etc_passwd');
    assert.equal(graphFileName('con.txt'), 'file_con.txt');
    assert.equal(graphFileName('a b?.pdf'), 'a_b_.pdf');
    assert.equal(pathUrl({ provider: 'graph', credential: 'G', drive: 'b!x', folder: 'HR Docs/2026' }, 'a.pdf'), 'https://graph.microsoft.com/v1.0/drives/b!x/root:/HR%20Docs/2026/a.pdf:');
  });

  test('create, download, replace, remove and delete: the folder follows the record', async () => {
    const b = new Browser(app);
    await b.get(`/a/${ALIAS}/1`);
    let res = await b.upload(`/a/${ALIAS}/1`, { __request: 'CREATE', P1_TITLE: 'Contract' }, { P1_FILE: file('contract.txt', 'version 1') });
    assert.equal(res.statusCode, 303, res.body.slice(0, 300));
    const row = await owner.one(`select * from t_graphstore.doc where title = 'Contract'`);
    // the source column holds the drive item's id
    assert.ok(stub.items.has(row.file_key));
    assert.deepEqual([row.file_name, row.file_mime, row.file_size], ['contract.txt', 'text/plain', 9]);
    assert.deepEqual(stored(), [`${DRIVE}:HR/Documents/contract.txt`]);
    assert.equal(stub.tokensIssued, 1);

    // the download comes through pgkiln: Graph's redirect is followed by the server, without the token
    const page = (await b.get(`/a/${ALIAS}/1?P1_ID=${row.id}`)).body;
    assert.match(page, /contract\.txt/);
    assert.doesNotMatch(page, /127\.0\.0\.1|tempauth|stub-access-token/);
    stub.log.length = 0;
    const dl = await b.get(downloads(page, 'P1_FILE')[0]);
    assert.equal(dl.statusCode, 200);
    assert.equal(dl.body, 'version 1');
    assert.equal(dl.headers['cache-control'], 'private, no-store');
    const hop = stub.log.find((l) => l.path.startsWith('/dl/'))!;
    assert.equal(hop.auth, false, 'the pre-authenticated download URL gets no Authorization header');
    assert.ok(stub.log.filter((l) => l.path.startsWith('/v1.0/')).every((l) => l.auth));

    // a second file of the same name gets a number (conflictBehavior rename); the old one goes after the commit
    res = await b.upload(`/a/${ALIAS}/1`, { __request: 'SAVE', P1_ID: String(row.id), P1_TITLE: 'Contract' }, { P1_FILE: file('contract.txt', 'version 2') });
    assert.equal(res.statusCode, 303);
    const row2 = await owner.one(`select * from t_graphstore.doc where id = $1`, [row.id]);
    assert.notEqual(row2.file_key, row.file_key);
    assert.deepEqual(stored(), [`${DRIVE}:HR/Documents/contract 1.txt`]);

    // remove the file
    await b.get(`/a/${ALIAS}/1?P1_ID=${row.id}`);
    res = await b.submit(`/a/${ALIAS}/1`, { __request: 'SAVE', P1_ID: String(row.id), P1_TITLE: 'Contract', P1_FILE__REMOVE: 'true' });
    assert.equal(res.statusCode, 303);
    assert.equal((await owner.one(`select file_key from t_graphstore.doc where id = $1`, [row.id])).file_key, null);
    assert.deepEqual(stored(), []);

    // delete the record with a file
    await b.get(`/a/${ALIAS}/1?P1_ID=${row.id}`);
    await b.upload(`/a/${ALIAS}/1`, { __request: 'SAVE', P1_ID: String(row.id), P1_TITLE: 'Contract' }, { P1_FILE: file('c3.txt', 'v3') });
    assert.equal(stored().length, 1);
    await b.get(`/a/${ALIAS}/1?P1_ID=${row.id}`);
    res = await b.submit(`/a/${ALIAS}/1`, { __request: 'DELETE', P1_ID: String(row.id), P1_TITLE: 'Contract' });
    assert.equal(res.statusCode, 303);
    assert.deepEqual(stored(), []);
  });

  test('a file over 4 MiB goes through an upload session, in ranges, without the credential', async () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 123);
    for (let i = 0; i < big.length; i++) big[i] = i % 251;
    const b = new Browser(app);
    await b.get(`/a/${ALIAS}/1`);
    stub.log.length = 0;
    const res = await b.upload(`/a/${ALIAS}/1`, { __request: 'CREATE', P1_TITLE: 'Scan' }, { P1_FILE: file('scan.pdf', big, 'application/pdf') });
    assert.equal(res.statusCode, 303, res.body.slice(0, 300));
    assert.ok(stub.log.some((l) => l.method === 'POST' && l.path.endsWith('/root:/HR/Documents/scan.pdf:/createUploadSession') && l.auth));
    const ranges = stub.log.filter((l) => l.path.startsWith('/upload/'));
    assert.deepEqual(ranges.map((l) => l.range), [`bytes 0-${GRAPH_CHUNK - 1}/${big.length}`, `bytes ${GRAPH_CHUNK}-${big.length - 1}/${big.length}`]);
    assert.ok(ranges.every((l) => !l.auth), 'the upload URL gets no Authorization header');
    const row = await owner.one(`select * from t_graphstore.doc where title = 'Scan'`);
    assert.ok(stub.items.get(row.file_key)!.body.equals(big));
    const page = (await b.get(`/a/${ALIAS}/1?P1_ID=${row.id}`)).body;
    const dl = await app.inject({ method: 'GET', url: downloads(page, 'P1_FILE')[0], headers: { cookie: [...b.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
    assert.equal(dl.statusCode, 200);
    assert.ok(dl.rawPayload.equals(big));
    await b.submit(`/a/${ALIAS}/1`, { __request: 'DELETE', P1_ID: String(row.id), P1_TITLE: 'Scan' });
    assert.deepEqual(stored(), []);
  });

  test('a save that fails leaves nothing in the drive', async () => {
    const b = new Browser(app);
    await b.get(`/a/${ALIAS}/1`);
    const res = await b.upload(`/a/${ALIAS}/1`, { __request: 'CREATE', P1_TITLE: '' }, { P1_FILE: file('orphan.txt', 'x') });
    assert.notEqual(res.statusCode, 303);
    assert.deepEqual(stored(), []);
  });

  test('several files per item in a SharePoint site\'s library; a removed one goes', async () => {
    const b = new Browser(app);
    await b.get(`/a/${ALIAS}/1`);
    const res = await b.upload(`/a/${ALIAS}/1`, { __request: 'CREATE', P1_TITLE: 'Bundle' }, { P1_ATTACH: [file('a.txt', 'A'), file('b.txt', 'BB')] });
    assert.equal(res.statusCode, 303, res.body.slice(0, 300));
    assert.deepEqual(stored(), [`site:${SITE}:Attachments/a.txt`, `site:${SITE}:Attachments/b.txt`]);
    const doc = await owner.one(`select id from t_graphstore.doc where title = 'Bundle'`);
    const rows = (await owner.query(`select id, file_key, file_name from t_graphstore.attachment where doc_id = $1 order by id`, [doc.id])).rows;
    const page = (await b.get(`/a/${ALIAS}/1?P1_ID=${doc.id}`)).body;
    assert.equal((await b.get(downloads(page, 'P1_ATTACH')[1])).body, 'BB');
    await b.submit(`/a/${ALIAS}/1`, { __request: 'SAVE', P1_ID: String(doc.id), P1_TITLE: 'Bundle', P1_ATTACH__REMOVE: String(rows[0].id) });
    assert.deepEqual(stored(), [`site:${SITE}:Attachments/b.txt`]);
    await b.get(`/a/${ALIAS}/1?P1_ID=${doc.id}`);
    await b.submit(`/a/${ALIAS}/1`, { __request: 'DELETE', P1_ID: String(doc.id), P1_TITLE: 'Bundle' });
    assert.deepEqual(stored(), []);
  });

  test('the credential must be OAuth2 or a bearer token, valid for the Graph URL', async () => {
    const { putObject } = await import('../src/objectstore.ts');
    const store = { provider: 'graph' as const, url: stub.url, drive: DRIVE, credential: 'GRAPH' };
    await owner.query(`update meta.web_credential set valid_for = '{https://elsewhere.example.com/}' where app_id = $1`, [appId]);
    try {
      await assert.rejects(putObject(appId, store, 'n.txt', Buffer.from('n'), 'text/plain'), /not valid for this URL/);
    } finally {
      await owner.query(`update meta.web_credential set valid_for = $2 where app_id = $1`, [appId, [stub.url + '/']]);
    }
    await owner.query(`insert into meta.web_credential (app_id, name, type, username, scope, secret_enc) values ($1, 'S3KEY', 'aws_sigv4', 'AKID', 'eu-test-1', $2)`, [appId, encryptSecret('x')]);
    await assert.rejects(putObject(appId, { ...store, credential: 'S3KEY' }, 'n.txt', Buffer.from('n'), 'text/plain'), /not of type OAuth2 or bearer/);
    // a bearer token works too
    await owner.query(`insert into meta.web_credential (app_id, name, type, secret_enc) values ($1, 'GRAPH_BEARER', 'bearer', $2)`, [appId, encryptSecret(STUB_TOKEN)]);
    const id = await putObject(appId, { ...store, credential: 'GRAPH_BEARER' }, 'bearer.txt', Buffer.from('b'), 'text/plain');
    assert.equal(stub.items.get(id)?.name, 'bearer.txt');
    stub.items.delete(id);
  });
});

describe('stored files in PDFs and mails, a folder per record (sprint 253, MG-30, MG-31)', () => {
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const store = () => ({ provider: 'graph' as const, url: stub.url, drive: DRIVE, folder: 'HR/Documents', credential: 'GRAPH' });
  const setFolder = (folder: string) =>
    owner.query(`update meta.item set config = jsonb_set(config, '{object_store,folder}', to_jsonb($2::text)) where name = 'P1_FILE' and page_id in (select id from meta.page where app_id = $1)`, [appId, folder]);

  test('substitutions: checked as a segment, each value one safe segment, the static part for containment', () => {
    const o = { ...store(), folder: 'Orders/&P3_ID./Photos' };
    assert.equal(objectStoreProblem(o), null);
    assert.equal(objectStoreProblem({ provider: 's3', url: 'https://x/b', credential: 'S3', prefix: 'orders/&P3_ID./' }), null);
    const v = (x: string | null) => (resolveStore(o, () => x) as typeof o).folder;
    assert.equal(v('42'), 'Orders/42/Photos');
    assert.equal(v('../../Finance'), 'Orders/____Finance/Photos');
    assert.equal(v('a\\b\u0001c. '), 'Orders/a_b_c_/Photos');
    assert.equal(v(''), 'Orders/_/Photos');
    assert.equal(v(null), 'Orders/_/Photos');
    assert.equal(objectStoreProblem(resolveStore(o, () => '..')), null);
    const s3 = resolveStore({ url: 'https://x/b', credential: 'S3', prefix: 'orders/&P3_ID./' }, () => 'A/B c..d') as { prefix: string };
    assert.equal(s3.prefix, 'orders/A_B_c_d/');
    assert.equal(staticPart('Orders/&P3_ID./Photos'), 'Orders/');
    assert.equal(staticPart('Orders/WB-&P3_ID./Photos'), 'Orders/');
    assert.equal(staticPart('&P3_ID.'), '');
    assert.equal(staticPart('Orders/Photos'), 'Orders/Photos');
    // (a delegated credential) the signed-in user's OneDrive
    assert.equal(driveUrl({ provider: 'graph', credential: 'G', drive: 'me' }), 'https://graph.microsoft.com/v1.0/me/drive');
  });

  test('a folder per record: the upload goes to the record\'s folder, downloads reach any record\'s folder, nothing outside', async () => {
    await setFolder('HR/&P1_TITLE./Files');
    try {
      const b = new Browser(app);
      await b.get(`/a/${ALIAS}/1`);
      const res = await b.upload(`/a/${ALIAS}/1`, { __request: 'CREATE', P1_TITLE: '../Fin/ance' }, { P1_FILE: file('order.txt', 'per record') });
      assert.equal(res.statusCode, 303, res.body.slice(0, 300));
      assert.deepEqual(stored(), [`${DRIVE}:HR/__Fin_ance/Files/order.txt`]);
      const row = await owner.one(`select * from t_graphstore.doc where title = '../Fin/ance'`);
      const page = (await b.get(`/a/${ALIAS}/1?P1_ID=${row.id}`)).body;
      assert.equal((await b.get(downloads(page, 'P1_FILE')[0])).body, 'per record');
      // a key of a file outside the static part ("HR/") is refused
      const outside = stubItem(stub, DRIVE, 'Finance', 'salaries.txt', 'secret');
      await owner.query(`update t_graphstore.doc set file_key = $2 where id = $1`, [row.id, outside]);
      const page2 = (await b.get(`/a/${ALIAS}/1?P1_ID=${row.id}`)).body;
      const dl = await b.get(downloads(page2, 'P1_FILE')[0]);
      assert.notEqual(dl.statusCode, 200);
      assert.doesNotMatch(dl.body, /secret/);
      stub.items.delete(outside);
      await owner.query(`update t_graphstore.doc set file_key = null where id = $1`, [row.id]);
      await b.get(`/a/${ALIAS}/1?P1_ID=${row.id}`);
      await b.submit(`/a/${ALIAS}/1`, { __request: 'DELETE', P1_ID: String(row.id), P1_TITLE: '../Fin/ance' });
    } finally {
      await setFolder('HR/Documents');
      for (const [id, i] of stub.items) if (i.folder.startsWith('HR/__Fin')) stub.items.delete(id);
    }
  });

  test('<img src="stored:ITEM:key"> in a document: fetched while drawing; a missing or refused one is left out', async () => {
    const id = await putObject(appId, store(), 'photo.png', PNG, 'image/png');
    const outside = stubItem(stub, DRIVE, 'Finance', 'x.png', 'not here');
    const draw = (src: string) => documentPdf({ html: `<p>Photo</p><img src="${src}" width="20mm">`, layout: { ...BUILT_IN }, title: 't', author: 'a', footer: 'f', pageLabel: () => 'p', appId });
    try {
      const images = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Subtype \/Image/g) ?? []).length;
      assert.ok(images(await draw(`stored:P1_FILE:${id}`)) > 0);
      assert.ok(images(await draw(`stored:p1_file:${id}`)) > 0, 'the item name in any case');
      assert.equal(images(await draw('stored:P1_FILE:01NOSUCHITEM')), 0);
      assert.equal(images(await draw(`stored:P1_FILE:${outside}`)), 0, 'outside the folder');
      assert.equal(images(await draw(`stored:P1_TITLE:${id}`)), 0, 'not a file item with an object store');
      // without the application (a caller that does not pass it) nothing is fetched
      assert.equal(images(await documentPdf({ html: `<img src="stored:P1_FILE:${id}">`, layout: { ...BUILT_IN }, title: 't', author: 'a', footer: 'f', pageLabel: () => 'p' })), 0);
    } finally {
      stub.items.delete(id);
      stub.items.delete(outside);
    }
  });

  test('meta.add_mail_attachment_stored: the sender fetches the file when it sends; a missing file fails the mail', async () => {
    const id = await putObject(appId, store(), 'report.txt', Buffer.from('the report'), 'text/plain');
    const sid = (await owner.one(`insert into meta.mail_service (name, provider, senders, settings) values ('T253_LOG', 'log', '{@example.com}', '{"default_from": "app@example.com"}') returning id`)).id;
    await owner.query(`insert into meta.app_mail_service (app_id, service_id, from_address, is_default) values ($1, $2, 'app@example.com', true)`, [appId, sid]);
    const queue = async (key: string) => {
      const c = await owner.pool.connect();
      try {
        await c.query('begin');
        await c.query(`select set_config('pgkiln.app_id', $1, true), set_config('pgkiln.app_user', 'KING', true)`, [String(appId)]);
        await c.query('set local role hr_app');
        const m = (await c.query(`select meta.send_mail('king@example.com', 'T253 report', 'x') as id`)).rows[0].id;
        await c.query(`select meta.add_mail_attachment_stored($1, 'p1_file', $2, 'report.txt', 'text/plain')`, [m, key]);
        await c.query('commit');
        return m as string;
      } catch (e) {
        await c.query('rollback');
        throw e;
      } finally {
        c.release();
      }
    };
    try {
      const m = await queue(id);
      const a = await owner.one('select content, stored_item, stored_key from meta.mail_attachment where mail_id = $1', [m]);
      assert.deepEqual(a, { content: null, stored_item: 'P1_FILE', stored_key: id });
      stub.log.length = 0;
      await mailTick();
      const sent = await owner.one('select status, message from meta.mail_queue where id = $1', [m]);
      assert.equal(sent.status, 'sent', sent.message);
      assert.ok(stub.log.some((l) => l.path.endsWith(`/items/${id}/content`)), 'fetched from the store when sending');
      const missing = await queue('01NOSUCHITEM');
      await mailTick();
      const failed = await owner.one('select status, message from meta.mail_queue where id = $1', [missing]);
      assert.equal(failed.status, 'error');
      assert.match(failed.message, /not in the object store of P1_FILE/);
    } finally {
      stub.items.delete(id);
      await owner.query(`delete from meta.mail_queue where app_id = $1`, [appId]);
      await owner.query(`delete from meta.mail_service where name = 'T253_LOG'`);
    }
  });
});

describe('HR example, page 77 (part 108)', () => {
  test('the policy documents page renders; until MS_GRAPH is set up an upload is refused and nothing is saved', async () => {
    const b = new Browser(app);
    await b.login('king');
    const page = await b.get('/a/hr/77');
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /Policies in SharePoint/);
    assert.match(page.body, /type="file"[^>]*name="P77_FILE"|name="P77_FILE"[^>]*type="file"/);
    const before = (await owner.one(`select count(*)::int as n from hr.policy_document`)).n;
    const res = await b.upload('/a/hr/77', { __request: 'CREATE', P77_TITLE: 'Travel policy' }, { P77_FILE: file('travel.pdf', '%PDF-1.4', 'application/pdf') });
    assert.notEqual(res.statusCode, 303);
    assert.equal((await owner.one(`select count(*)::int as n from hr.policy_document`)).n, before);
    // an employee who is not an administrator does not get the page
    const e = new Browser(app);
    await e.login('smith');
    assert.notEqual((await e.get('/a/hr/77')).statusCode, 200);
  });
});
