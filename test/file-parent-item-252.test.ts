// (sprint 252) A multiple file item outside a form region: "parent_item" names the protected hidden item holding the
// record's key, for a page that saves with its own processes. Uses the App Gallery's Sample Files, page 8 (site visits),
// whose pictures share sample_files.picture with folders and people (related_type 'visit').
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { urlChecksum } from '../src/security.ts';
import { parentItem } from '../src/runtime/files.ts';
import { Browser } from './helpers.ts';
import { dropSample, installSample, SAMPLES } from './gallery-samples.ts';

const SAMPLE = SAMPLES.find((x) => x.key === 'sample-files')!;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
let app: FastifyInstance;
let appId: number;

const pictures = async (id: string) =>
  (await owner.query<{ id: number; filename: string }>(`select id, filename from sample_files.picture where related_type = 'visit' and related_id = $1 order by id`, [id])).rows;

/** Demo signed in, page 8 open (for visit `id`, or empty for a new one). */
async function open(id?: string) {
  const b = new Browser(app);
  await b.login('demo', 'demo', 'sample-files');
  const items: Record<string, string> = id ? { P8_ID: id } : {};
  const res = await b.get(id ? `/a/sample-files/8?${new URLSearchParams({ ...items, cs: urlChecksum(appId, 8, 'demo', items) })}` : '/a/sample-files/8');
  assert.equal(res.statusCode, 200, res.body.slice(0, 300));
  return { b, body: res.body };
}

before(async () => {
  await dropSample(SAMPLE);
  await installSample(SAMPLE);
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'sample-files'`)).id;
});

after(async () => {
  await app.close();
  await dropSample(SAMPLE);
  await closePools();
});

describe('a multiple file item with a parent_item (no form region)', () => {
  test("a new visit's pictures are saved with it, after the process that inserted it set the key", async () => {
    const { b } = await open();
    const res = await b.upload('/a/sample-files/8', { __request: 'SAVE', P8_NOTE: 'Boiler check' }, {
      P8_PICTURES: [{ name: 'a.png', type: 'image/png', data: PNG }, { name: 'b.png', type: 'image/png', data: PNG }],
    });
    assert.equal(res.statusCode, 303, res.body.slice(0, 400));
    const id = String((await owner.one(`select id from sample_files.visit where note = 'Boiler check'`)).id);
    assert.deepEqual((await pictures(id)).map((p) => p.filename), ['a.png', 'b.png']);
    // shown on the visit's page as a gallery, and on no other visit's page
    assert.match((await open(id)).body, /<ul class="file-gallery">[\s\S]*a\.png[\s\S]*b\.png/);
    assert.doesNotMatch((await open('1')).body, /a\.png/);
  });

  test('a stored picture is removed with its box; an upload to an existing visit is added to it', async () => {
    const id = String((await owner.one(`select id from sample_files.visit where note = 'Boiler check'`)).id);
    const [first] = await pictures(id);
    const { b } = await open(id);
    const res = await b.upload('/a/sample-files/8', { __request: 'SAVE', P8_NOTE: 'Boiler check', P8_PICTURES__REMOVE: String(first.id) }, {
      P8_PICTURES: [{ name: 'c.png', type: 'image/png', data: PNG }],
    });
    assert.equal(res.statusCode, 303, res.body.slice(0, 400));
    assert.deepEqual((await pictures(id)).map((p) => p.filename), ['b.png', 'c.png']);
  });

  test('the download serves the picture; max_files counts the stored ones', async () => {
    const id = String((await owner.one(`select id from sample_files.visit where note = 'Boiler check'`)).id);
    const { b, body } = await open(id);
    const href = /class="file-gallery-link" href="([^"]+)"/.exec(body)![1].replace(/&amp;/g, '&');
    const pic = await b.get(href);
    assert.equal(pic.statusCode, 200);
    assert.deepEqual(pic.rawPayload, PNG);
    const three = [1, 2, 3].map((n) => ({ name: `x${n}.png`, type: 'image/png', data: PNG }));
    const res = await b.upload('/a/sample-files/8', { __request: 'SAVE', P8_NOTE: 'Boiler check' }, { P8_PICTURES: three });
    assert.equal(res.statusCode, 422);
    assert.match(res.body, /At most 4 files\./);
    assert.equal((await pictures(id)).length, 2);
  });

  test('parent_item must be a protected hidden item of the page', () => {
    const item = (name: string, type: string, config: Record<string, unknown> = {}) => ({ name, type, config }) as never;
    const files = item('P8_PICTURES', 'file', { multiple: true, parent_item: 'P8_ID' });
    const ctx = (items: unknown[]) => ({ page: { items } }) as never;
    assert.equal(parentItem(ctx([item('P8_ID', 'hidden'), files]), files), 'P8_ID');
    assert.equal(parentItem(ctx([item('P8_ID', 'hidden'), item('X', 'file', { multiple: true })]), item('X', 'file', {})), undefined);
    assert.throws(() => parentItem(ctx([item('P8_ID', 'text'), files]), files), /protected hidden item/);
    assert.throws(() => parentItem(ctx([item('P8_ID', 'hidden', { value_protected: false }), files]), files), /protected hidden item/);
    assert.throws(() => parentItem(ctx([files]), files), /protected hidden item/);
  });
});
