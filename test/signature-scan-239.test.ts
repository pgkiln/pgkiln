// Sprint 239 (MG-12, MG-4): the signature item type (a pad whose drawing is posted as a PNG and kept as a temporary
// file, like a file upload's) and the barcode decoder bundled for scan buttons where the browser has no
// BarcodeDetector (zxing-wasm, served by pgkiln; the page's CSP allows its WebAssembly only where a scan item is).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { presetItem } from '../src/metadata.ts';
import { pngSize } from '../src/runtime/files.ts';
import { urlChecksum } from '../src/security.ts';
import { ZXING_SCRIPT, ZXING_VERSION, ZXING_WASM } from '../src/zxing.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let hrId: number;
const alias = 'items-s239';
const ROLE = 'pgkiln_s239_items';
const REASON = 'sprint 239 signature';
// the smallest valid PNG (1x1 transparent pixel)
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

before(async () => {
  app = await buildApp({ logger: false });
  hrId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  await owner.query(`delete from meta.app where alias = $1`, [alias]);
  await owner.query(`drop role if exists ${ROLE}`);
  await owner.query(`create role ${ROLE} nologin`);
  await owner.query(`grant ${ROLE} to pgkiln_runtime`);
  const appId = (await owner.one(`insert into meta.app (alias, name, authentication, db_role) values ($1, 'Items', 'none', $2) returning id`, [alias, ROLE])).id;
  const page = async (no: number) => (await owner.one(`insert into meta.page (app_id, page_no, name, requires_auth) values ($1, $2, 'P', false) returning id`, [appId, no])).id;
  const p1 = await page(1);
  const p2 = await page(2);
  const r1 = (await owner.one(`insert into meta.region (page_id, seq, title, type, source) values ($1, 1, 'Main', 'static', 'main') returning id`, [p1])).id;
  const r2 = (await owner.one(`insert into meta.region (page_id, seq, title, type, source) values ($1, 1, 'Main', 'static', 'main') returning id`, [p2])).id;
  await owner.query(`insert into meta.item (page_id, region_id, seq, name, label, type, config, required) values
    ($1, $2, 1, 'P1_CODE', 'Code', 'text', '{"scan": true}', false),
    ($1, $2, 2, 'P1_SIG', 'Signed by', 'signature', '{"crop": "1:1", "max_px": 800, "multiple": true, "max_mb": 5}', false),
    ($1, $2, 3, 'P1_NAME', 'Name', 'text', '{}', true)`, [p1, r1]);
  await owner.query(`insert into meta.item (page_id, region_id, seq, name, label, type, config) values ($1, $2, 1, 'P2_NAME', 'Name', 'text', '{}')`, [p2, r2]);
  await owner.query(`insert into meta.button (page_id, region_id, seq, name, label) values ($1, $2, 1, 'SAVE', 'Save')`, [p1, r1]);
});
after(async () => {
  await owner.query(`delete from meta.app where alias = $1`, [alias]);
  await owner.query(`drop role if exists ${ROLE}`);
  await owner.query(`delete from hr.leave_request where reason like $1`, [`${REASON}%`]);
  await app.close();
  await closePools();
});

describe('signature items (MG-12)', () => {
  test('a preset of a file item: one PNG of at most 1 MB, no cropping or resizing', () => {
    const s = presetItem({ name: 'P1_SIG', type: 'signature', config: { crop: '1:1', max_px: 800, multiple: true, max_mb: 5, capture: 'user' } } as any);
    assert.equal(s.type, 'file');
    assert.deepEqual(s.config, { accept: 'image/png', max_mb: 1, preset: 'signature' });
    assert.equal(presetItem({ name: 'P1_SIG', type: 'signature', config: { max_mb: 0.5 } } as any).config.max_mb, 0.5);
  });

  test('pngSize reads a PNG header and nothing else', () => {
    assert.deepEqual(pngSize(PNG), { width: 1, height: 1 });
    assert.equal(pngSize(Buffer.from('GIF89a' + 'x'.repeat(40))), null);
    assert.equal(pngSize(PNG.subarray(0, 20)), null);
  });

  test('the page: a pad (shown by app.js), a clear button, and a PNG file input that works without JavaScript', async () => {
    const res = await new Browser(app).get(`/a/${alias}/1`);
    const body = res.body;
    assert.match(body, /enctype="multipart\/form-data"/);
    assert.match(body, /<div class="signature" data-signature="P1_SIG">/);
    assert.match(body, /<div class="signature-pad" hidden>\s*<canvas class="signature-canvas" id="P1_SIG_PAD" role="img" aria-label="Signed by: sign with a finger, a pen or the mouse"><\/canvas>/);
    assert.match(body, /<button type="button" class="btn btn-sm signature-clear" data-signature-clear="P1_SIG" aria-controls="P1_SIG_PAD">[\s\S]*?Clear signature<\/button>/);
    assert.match(body, /<details class="signature-upload" open><summary>Or upload a picture of the signature \(PNG\)<\/summary>\s*<input type="file" id="P1_SIG" name="P1_SIG" accept="image\/png"/);
    assert.doesNotMatch(body, /data-crop|data-max-px|multiple/, 'no cropping, resizing or several files');
  });

  test('a drawn signature is kept as a temporary file "<item>.png" through a validation error, and previewed', async () => {
    const b = new Browser(app);
    await b.get(`/a/${alias}/1`);
    const res = await b.upload(`/a/${alias}/1`, { __request: 'SAVE', P1_NAME: '' }, { P1_SIG: { name: 'drawing.png', type: 'image/png', data: PNG } });
    assert.equal(res.statusCode, 422, 'P1_NAME is required: the page comes back');
    const f = await owner.one(`select filename, mime_type, size from meta.temp_file where item_name = 'P1_SIG' order by created_at desc limit 1`);
    assert.deepEqual([f.filename, f.mime_type, f.size], ['p1_sig.png', 'image/png', PNG.length]);
    assert.match(res.body, /<img class="file-preview signature-preview" src="\/a\/items-s239\/1\/file\/P1_SIG\?k=temp%3A[0-9a-f-]+&amp;cs=[^"]+&amp;inline=1" alt="Signed by">/);
    const url = /src="(\/a\/items-s239\/1\/file\/P1_SIG\?[^"]+)"/.exec(res.body)![1].replace(/&amp;/g, '&');
    const dl = await b.get(url);
    assert.equal(dl.statusCode, 200);
    assert.equal(dl.headers['content-type'], 'image/png');
    assert.deepEqual(dl.rawPayload, PNG);
  });

  test('HR: a leave request signed on page 7 stores the PNG; the request shows it read only', async () => {
    const allen = new Browser(app);
    await allen.login('allen');
    const form = await allen.get('/a/hr/7?clear=1');
    assert.match(form.body, /data-signature="P7_SIGNATURE"/);
    // a week far ahead (a different one per run), so it overlaps nothing
    const day = 4000 + Math.floor(Math.random() * 3000);
    const start = new Date(Date.now() + day * 864e5).toISOString().slice(0, 10);
    const end = new Date(Date.now() + (day + 6) * 864e5).toISOString().slice(0, 10);
    const res = await allen.upload('/a/hr/7', { __request: 'CREATE', P7_START_DATE: start, P7_END_DATE: end, P7_REASON: `${REASON} hr` },
      { P7_SIGNATURE: { name: 'signature.png', type: 'image/png', data: PNG } });
    assert.equal(res.statusCode, 303, res.body.slice(0, 500));
    const row = await owner.one(`select id, signature from hr.leave_request where reason = $1`, [`${REASON} hr`]);
    assert.deepEqual(row.signature, PNG);
    const audit = await owner.one(`select new_values from hr.audit_log where table_name = 'leave_request' and row_pk = $1 order by id desc limit 1`, [String(row.id)]);
    assert.ok(!('signature' in (audit?.new_values ?? {})), 'the audit trail leaves the picture out');
    const items = { P7_ID: String(row.id) };
    const view = await allen.get(`/a/hr/7?${new URLSearchParams({ ...items, cs: urlChecksum(hrId, 7, 'allen', items) })}`);
    assert.match(view.body, /<div class="display-value" id="P7_SIGNATURE">[\s\S]*?<img class="file-preview signature-preview" src="[^"]+inline=1" alt="Signature">[\s\S]*?p7_signature\.png/);
    assert.doesNotMatch(view.body, /data-signature="P7_SIGNATURE"/, 'read only: no pad');
  });

  test('the database knows the type', async () => {
    await assert.rejects(owner.query(`insert into meta.item (page_id, name, type) select page_id, 'P1_X', 'signature_pad' from meta.item where name = 'P1_SIG' limit 1`), /item_type_check/);
  });
});

describe('barcode scan fallback (MG-4)', () => {
  test('the decoder is served by pgkiln itself (script and WebAssembly), nothing else under its path', async () => {
    const b = new Browser(app);
    assert.equal(ZXING_SCRIPT, `/static/vendor/zxing/reader.js?v=${ZXING_VERSION}`);
    const js = await b.get(ZXING_SCRIPT);
    assert.equal(js.statusCode, 200);
    assert.match(String(js.headers['content-type']), /^text\/javascript/);
    assert.match(js.body, /ZXingWASM/);
    const wasm = await b.get(ZXING_WASM);
    assert.equal(wasm.statusCode, 200);
    assert.equal(wasm.headers['content-type'], 'application/wasm');
    assert.deepEqual([...wasm.rawPayload.subarray(0, 4)], [0x00, 0x61, 0x73, 0x6d], 'a WebAssembly module');
    for (const bad of ['index.js', 'package.json', '..%2F..%2Fpackage.json', 'zxing_full.wasm'])
      assert.equal((await b.get(`/static/vendor/zxing/${bad}`)).statusCode, 404, bad);
  });

  test('a page with a scan item may compile WebAssembly; other pages may not', async () => {
    const b = new Browser(app);
    const scan = await b.get(`/a/${alias}/1`);
    assert.match(String(scan.headers['content-security-policy']), /script-src 'self' 'wasm-unsafe-eval';/);
    assert.doesNotMatch(String(scan.headers['content-security-policy']), /'unsafe-eval'/);
    assert.match(scan.body, /data-scan="P1_CODE" data-decoder="\/static\/vendor\/zxing\/reader\.js\?v=[\d.]+" data-decoder-wasm="\/static\/vendor\/zxing\/zxing_reader\.wasm\?v=[\d.]+" hidden>/);
    const plain = await b.get(`/a/${alias}/2`);
    assert.match(String(plain.headers['content-security-policy']), /script-src 'self';/);
  });
});
