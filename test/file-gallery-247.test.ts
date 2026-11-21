// (sprint 247, MG-20) Multiple file items on a child table shared by several record types ("filter": constant columns
// written on insert and applied on read and delete; a text parent column for an integer key) and the picture gallery
// ("display": "gallery"). Uses the App Gallery's Sample Files: folders and people share sample_files.picture.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { urlChecksum } from '../src/security.ts';
import { childFilter } from '../src/runtime/files.ts';
import { Browser } from './helpers.ts';
import { dropSample, installSample, SAMPLES } from './gallery-samples.ts';

const SAMPLE = SAMPLES.find((x) => x.key === 'sample-files')!;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
let app: FastifyInstance;
let appId: number;

const pictures = async (type: string, id: string) =>
  (await owner.query<{ id: number; filename: string }>('select id, filename from sample_files.picture where related_type = $1 and related_id = $2 order by id', [type, id])).rows;

/** Demo signed in, with the form of record `id` on `page` (5: folder, 7: person) open. */
async function open(page: 5 | 7, id: string) {
  const b = new Browser(app);
  await b.login('demo', 'demo', 'sample-files');
  const items = { [`P${page}_ID`]: id };
  const res = await b.get(`/a/sample-files/${page}?${new URLSearchParams({ ...items, cs: urlChecksum(appId, page, 'demo', items) })}`);
  assert.equal(res.statusCode, 200, res.body.slice(0, 300));
  return { b, body: res.body };
}

const folder1 = { __request: 'SAVE', P5_NAME: 'Project Alpha', P5_DESCRIPTION: 'Plans and minutes' };

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

describe('multiple file items on a shared child table, shown as a gallery', () => {
  test('each form shows only its own kind of record: the same related_id, another related_type', async () => {
    const folder = (await open(5, '1')).body;
    assert.match(folder, /alpha-site\.png/);
    assert.doesNotMatch(folder, /ada-desk\.png/);
    const person = (await open(7, '1')).body;
    assert.match(person, /ada-desk\.png/);
    assert.doesNotMatch(person, /alpha-site\.png/);
  });

  test('the gallery: a thumbnail linking to the full-size picture, the name as download link, a remove box', async () => {
    const { body } = await open(5, '1');
    const key = (await pictures('folder', '1'))[0].id;
    assert.match(body, /<ul class="file-gallery">/);
    const tile = /<li class="file-gallery-item">[\s\S]*?<\/li>/.exec(body)![0];
    assert.match(tile, /<a class="file-gallery-link" href="\/a\/sample-files\/5\/file\/P5_PICTURES\?k=\d+&amp;cs=[^"]+&amp;inline=1" target="_blank" rel="noopener"><img class="file-gallery-thumb" src="[^"]+inline=1" alt="alpha-site\.png" loading="lazy"><\/a>/);
    assert.match(tile, /<a href="[^"]+" download>alpha-site\.png<\/a>/);
    assert.match(tile, new RegExp(`name="P5_PICTURES__REMOVE" value="${key}"`));
    // the other multiple item of the page keeps its list
    assert.match(body, /<ul class="file-list">/);
    // the full-size link serves the picture inline
    const href = /class="file-gallery-link" href="([^"]+)"/.exec(body)![1].replace(/&amp;/g, '&');
    const b = new Browser(app);
    await b.login('demo', 'demo', 'sample-files');
    const pic = await b.get(href);
    assert.equal(pic.statusCode, 200);
    assert.equal(pic.headers['content-type'], 'image/png');
    assert.deepEqual(pic.rawPayload, PNG);
  });

  test('new pictures get the filter column and the record key (an integer id into a text column)', async () => {
    const { b } = await open(5, '1');
    const res = await b.upload('/a/sample-files/5', folder1, { P5_PICTURES: [{ name: 'a.png', type: 'image/png', data: PNG }, { name: 'b.png', type: 'image/png', data: PNG }] });
    assert.equal(res.statusCode, 303, res.body.slice(0, 500));
    assert.deepEqual((await pictures('folder', '1')).map((p) => p.filename), ['alpha-site.png', 'a.png', 'b.png']);
    assert.deepEqual((await pictures('person', '1')).map((p) => p.filename), ['ada-desk.png'], 'the person is untouched');
  });

  test('a non-image file is shown as a file link in the gallery', async () => {
    await owner.query(`insert into sample_files.picture (related_type, related_id, filename, mime_type, content) values ('folder', '2', 'notes.txt', 'text/plain', 'x')`);
    const { body } = await open(5, '2');
    assert.match(body, /<span class="file-gallery-link file-gallery-other"><svg/);
    assert.match(body, /download>notes\.txt<\/a>/);
    assert.doesNotMatch(body, /alt="notes\.txt"/);
  });

  test('max_files counts only the rows of this record type', async () => {
    // the folder holds 3 of 6; person 1's picture (related_id 1 too) doesn't count
    const { b } = await open(5, '1');
    const png = (name: string) => ({ name, type: 'image/png', data: PNG });
    assert.equal((await b.upload('/a/sample-files/5', folder1, { P5_PICTURES: [png('x0.png'), png('x1.png'), png('x2.png')] })).statusCode, 303);
    assert.equal((await pictures('folder', '1')).length, 6);
    await open(5, '1').then(async ({ b }) => {
      const res = await b.upload('/a/sample-files/5', folder1, { P5_PICTURES: [png('x3.png')] });
      assert.equal(res.statusCode, 422);
      assert.match(res.body, /At most 6 files\./);
    });
    assert.equal((await pictures('folder', '1')).length, 6);
  });

  test('ticked pictures are removed; deleting the record removes only its own kind of pictures', async () => {
    const { b } = await open(5, '1');
    const [, a] = await pictures('folder', '1');
    assert.equal((await b.upload('/a/sample-files/5', { ...folder1, P5_PICTURES__REMOVE: String(a.id) }, {})).statusCode, 303);
    assert.deepEqual((await pictures('folder', '1')).map((p) => p.filename), ['alpha-site.png', 'b.png', 'x0.png', 'x1.png', 'x2.png']);
    // folder 2 and person 2 share related_id 2
    await owner.query(`insert into sample_files.picture (related_type, related_id, filename, mime_type, content) values ('person', '2', 'grace.png', 'image/png', $1)`, [PNG]);
    const f2 = await open(5, '2');
    assert.equal((await f2.b.upload('/a/sample-files/5', { __request: 'DELETE', P5_NAME: 'Office move', P5_DESCRIPTION: '' }, {})).statusCode, 303);
    assert.equal((await pictures('folder', '2')).length, 0);
    assert.deepEqual((await pictures('person', '2')).map((p) => p.filename), ['grace.png']);
  });

  test('filter values: constants, null, and substitutions only of values a request cannot set', () => {
    const item = (filter: unknown) => ({ name: 'P5_PICTURES', type: 'file', config: { multiple: true, filter } }) as any;
    const ctx = (items: any[] = []) =>
      ({ page: { page_no: 5, items }, session: { id: 's', state: { P5_KIND: 'folder', P5_NAME: 'x' } }, app: { id: 1, alias: 'a' }, user: 'DEMO', request: '', locale: { lang: 'en' } }) as any;
    assert.deepEqual(childFilter(ctx(), item(undefined)), []);
    assert.deepEqual(childFilter(ctx(), item({ related_type: 'folder', active: true, n: 3, gone: null, empty: '' })), [
      ['related_type', 'folder'], ['active', 'true'], ['n', '3'], ['gone', null], ['empty', null],
    ]);
    assert.deepEqual(childFilter(ctx(), item({ owner: '&APP_USER.' })), [['owner', 'DEMO']]);
    assert.deepEqual(childFilter(ctx([{ name: 'P5_KIND', type: 'hidden', config: {} }]), item({ related_type: '&P5_KIND.' })), [['related_type', 'folder']]);
    assert.throws(() => childFilter(ctx([{ name: 'P5_NAME', type: 'text' }]), item({ related_type: '&P5_NAME.' })), /protected hidden item/);
    assert.throws(() => childFilter(ctx([{ name: 'P5_KIND', type: 'hidden', config: { value_protected: false } }]), item({ related_type: '&P5_KIND.' })), /protected hidden item/);
    assert.throws(() => childFilter(ctx(), item(['related_type'])), /must be an object/);
    assert.throws(() => childFilter(ctx(), item({ related_type: { a: 1 } })), /text, a number or a boolean/);
  });
});
