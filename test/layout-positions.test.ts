// Sprint 77 (migration 099): display positions of regions (banner, breadcrumb
// bar, left / right side column, body, footer), button positions in a region
// and the side-column page templates; the Page Designer's layout draws them as
// drop zones and moves set them.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
let pageId: number;
const alias = 'ts-s77';
const r: Record<string, number> = {};
const b: Record<string, number> = {};

const region = async (title: string, position: string | null, seq: number) =>
  (await owner.one(`insert into meta.region (page_id, seq, title, type, source, position) values ($1, $2, $3, 'static', $4, $5) returning id`,
    [pageId, seq, title, `<p>${title} text</p>`, position])).id as number;
const button = async (name: string, regionId: number | null, slot: string | null, seq: number) =>
  (await owner.one(`insert into meta.button (page_id, region_id, seq, name, label, action, slot) values ($1, $2, $3, $4, $4, 'submit', $5) returning id`,
    [pageId, regionId, seq, name, slot])).id as number;
const devLogin = async () => {
  const dev = new Browser(app);
  await dev.get('/builder/login');
  await dev.post('/builder/login', { __csrf: dev.lastCsrf, username: 'admin', password: 'admin' });
  return dev;
};
const at = (body: string, text: string) => {
  const i = body.indexOf(text);
  assert.ok(i >= 0, `${text} is on the page`);
  return i;
};

before(async () => {
  app = await buildApp({ logger: false });
  await owner.query('delete from meta.app where alias = $1', [alias]);
  appId = (await owner.one(`insert into meta.app (alias, name, authentication) values ($1, 'Positions test', 'none') returning id`, [alias])).id;
  pageId = (await owner.one(`insert into meta.page (app_id, page_no, name, requires_auth) values ($1, 1, 'Home', false) returning id`, [appId])).id;
  r.body = await region('Main', null, 10);
  r.banner = await region('Notice', 'banner', 20);
  r.crumb = await region('Trail', 'breadcrumb', 30);
  r.left = await region('Filters', 'left', 40);
  r.footer = await region('Small print', 'footer', 50);
  b.next = await button('NEXT', r.body, 'next', 10);
  b.prev = await button('PREVIOUS', r.body, 'previous', 20);
  b.create = await button('CREATE', r.body, 'create', 30);
  b.save = await button('SAVE', r.body, null, 40);
});

after(async () => {
  await owner.query('delete from meta.app where id = $1', [appId]);
  await app.close();
  await closePools();
});

describe('display positions at runtime', () => {
  test('banner and breadcrumb come first, the footer last; left goes into the body on a standard page', async () => {
    await owner.query(`update meta.page set page_template = 'standard' where id = $1`, [pageId]);
    const html = (await new Browser(app).get(`/a/${alias}/1`)).body;
    assert.ok(at(html, 'Notice text') < at(html, 'Trail text'));
    assert.ok(at(html, 'Trail text') < at(html, 'Main text'));
    assert.ok(at(html, 'Main text') < at(html, 'Filters text'), 'in sequence in the body');
    assert.ok(at(html, 'Filters text') < at(html, 'Small print text'));
    assert.match(html, /class="t-regions t-pos-banner"/);
    assert.match(html, /class="t-regions t-pos-footer"/);
    assert.doesNotMatch(html, /t-columns/);
  });

  test('a side-column page template puts left regions in an aside beside the body', async () => {
    await owner.query(`update meta.page set page_template = 'left_side_column' where id = $1`, [pageId]);
    const html = (await new Browser(app).get(`/a/${alias}/1`)).body;
    assert.match(html, /<div class="t-columns t-columns-left"><aside class="t-side" aria-label="Left column">/);
    const aside = /<aside class="t-side"[\s\S]*?<\/aside>/.exec(html)![0];
    assert.match(aside, /Filters text/);
    assert.doesNotMatch(aside, /Main text/);
    // a right-column template leaves left regions in the body
    await owner.query(`update meta.page set page_template = 'right_side_column' where id = $1`, [pageId]);
    const right = (await new Browser(app).get(`/a/${alias}/1`)).body;
    assert.doesNotMatch(right, /<aside class="t-side"/, 'no right regions: no column');
    assert.ok(at(right, 'Main text') < at(right, 'Filters text'));
    await owner.query(`update meta.page set page_template = 'standard' where id = $1`, [pageId]);
  });

  test('a region left out by its condition leaves no empty position behind', async () => {
    await owner.query(`update meta.region set condition = 'false' where id = $1`, [r.footer]);
    try {
      const html = (await new Browser(app).get(`/a/${alias}/1`)).body;
      assert.doesNotMatch(html, /t-pos-footer/);
    } finally {
      await owner.query('update meta.region set condition = null where id = $1', [r.footer]);
    }
  });

  test('button positions: create in the header, previous at the left and next at the right of the bottom bar', async () => {
    const html = (await new Browser(app).get(`/a/${alias}/1`)).body;
    const section = new RegExp(`<section[^>]*id="R${r.body}"[\\s\\S]*?</section>`).exec(html)![0];
    const header = /<header class="region-header">[\s\S]*?<\/header>/.exec(section)![0];
    assert.match(header, /value="CREATE"/);
    const footer = /<footer class="region-footer region-footer-split">[\s\S]*?<\/footer>/.exec(section)![0];
    const start = /region-footer-start">[\s\S]*?<\/div><div class="region-footer-end/.exec(footer)![0];
    assert.match(start, /value="PREVIOUS"/);
    assert.doesNotMatch(start, /value="NEXT"/);
    const end = footer.slice(footer.indexOf('region-footer-end'));
    assert.match(end, /value="NEXT"/);
    assert.match(end, /value="SAVE"/, 'a static region keeps its other buttons at the bottom');
  });

  test('the database refuses unknown positions and page templates', async () => {
    await assert.rejects(owner.query(`update meta.region set position = 'sidebar' where id = $1`, [r.body]), /check constraint/);
    await assert.rejects(owner.query(`update meta.button set slot = 'top' where id = $1`, [b.save]), /check constraint/);
    await assert.rejects(owner.query(`update meta.page set page_template = 'two_columns' where id = $1`, [pageId]), /check constraint/);
  });
});

describe('the Page Designer layout', () => {
  test('draws the page template\'s positions as zones, and buttons in their positions', async () => {
    await owner.query(`update meta.page set page_template = 'left_side_column' where id = $1`, [pageId]);
    try {
      const dev = await devLogin();
      const html = (await dev.get(`/builder/pages/${pageId}`)).body;
      for (const pos of ['banner', 'breadcrumb', 'left', 'body', 'footer']) assert.match(html, new RegExp(`data-drop="region" data-position="${pos}"`), pos);
      assert.doesNotMatch(html, /data-position="right"/, 'no right column on a left side column page without right regions');
      assert.match(html, /<div class="pd-columns pd-columns-left">/);
      const left = /<section class="pd-zone pd-zone-left[\s\S]*?<\/section>/.exec(html)![0];
      assert.match(left, /Filters/);
      assert.match(html, new RegExp(`data-region="${r.body}" data-slot="next"[^>]*>[\\s\\S]*?data-id="${b.next}"`));
      assert.match(html, new RegExp(`class="pd-slot pd-slot-button pd-slot-spare" data-drop="button" data-region="${r.body}" data-slot="edit"`), 'empty positions are drop targets while dragging');
      // a new region from a zone's link starts in that position
      const form = (await dev.get(`/builder/pages/${pageId}?new=region&position=footer`)).body;
      assert.match(form, /<option value="footer" selected>/);
    } finally {
      await owner.query(`update meta.page set page_template = 'standard' where id = $1`, [pageId]);
    }
  });

  test('a standard page shows a side position only while it has regions', async () => {
    const dev = await devLogin();
    const html = (await dev.get(`/builder/pages/${pageId}`)).body;
    assert.match(html, /data-position="left"/);
    assert.match(html, /not in this page template: shown in the body/);
    assert.doesNotMatch(html, /data-position="right"/);
  });

  test('moving a region into a position, a button into a button position; undo puts them back', async () => {
    const dev = await devLogin();
    await dev.get(`/builder/pages/${pageId}`);
    const post = (op: string, form: Record<string, string>) => dev.post(`/builder/pages/${pageId}/layout/${op}`, { ...form, __csrf: dev.lastCsrf });
    assert.equal((await post('move', { kind: 'region', id: String(r.body), position: 'left', before: String(r.left) })).statusCode, 303);
    const rows = (await owner.query(`select id, seq, position from meta.region where page_id = $1 and position = 'left' order by seq`, [pageId])).rows;
    assert.deepEqual(rows.map((x) => x.id), [r.body, r.left]);
    // the body position is stored as null, like a new region's
    assert.equal((await post('move', { kind: 'region', id: String(r.footer), position: 'body', before: '' })).statusCode, 303);
    assert.equal((await owner.one('select position from meta.region where id = $1', [r.footer])).position, null);
    // a button into the header's Edit position, then up and down stay among that position's buttons
    assert.equal((await post('move', { kind: 'button', id: String(b.save), region: String(r.body), slot: 'edit', before: '' })).statusCode, 303);
    assert.equal((await owner.one('select slot from meta.button where id = $1', [b.save])).slot, 'edit');
    assert.equal((await post('move', { kind: 'button', id: String(b.save), dir: 'down' })).statusCode, 303);
    assert.equal((await owner.one('select slot, region_id from meta.button where id = $1', [b.save])).slot, 'edit');
    // a page-level button has no position
    assert.equal((await post('move', { kind: 'button', id: String(b.save), region: '', slot: 'next', before: '' })).statusCode, 303);
    assert.deepEqual(Object.values(await owner.one('select region_id, slot from meta.button where id = $1', [b.save])), [null, null]);
    // undo, five times, restores the positions too
    for (let i = 0; i < 5; i++) assert.equal((await post('undo', {})).statusCode, 303);
    assert.equal((await owner.one('select position from meta.region where id = $1', [r.body])).position, null);
    assert.equal((await owner.one('select position from meta.region where id = $1', [r.footer])).position, 'footer');
    assert.deepEqual(Object.values(await owner.one('select region_id, slot from meta.button where id = $1', [b.save])), [r.body, null]);
  });

  test('a new region or button from the gallery lands in the zone it was dropped on', async () => {
    const dev = await devLogin();
    await dev.get(`/builder/pages/${pageId}`);
    const post = (form: Record<string, string>) => dev.post(`/builder/pages/${pageId}/layout/create`, { ...form, __csrf: dev.lastCsrf });
    assert.equal((await post({ kind: 'region', type: 'facets', position: 'left' })).statusCode, 303);
    const fr = await owner.one(`select id, position from meta.region where page_id = $1 and type = 'facets'`, [pageId]);
    assert.equal(fr.position, 'left');
    assert.equal((await post({ kind: 'button', type: 'submit', region: String(r.body), slot: 'close' })).statusCode, 303);
    assert.equal((await owner.one(`select slot from meta.button where page_id = $1 and name = 'NEW_BUTTON'`, [pageId])).slot, 'close');
    await owner.query('delete from meta.region where id = $1', [fr.id]);
    await owner.query(`delete from meta.button where page_id = $1 and name = 'NEW_BUTTON'`, [pageId]);
  });

  test('unknown positions are refused', async () => {
    const dev = await devLogin();
    await dev.get(`/builder/pages/${pageId}`);
    const post = (op: string, form: Record<string, string>) => dev.post(`/builder/pages/${pageId}/layout/${op}`, { ...form, __csrf: dev.lastCsrf });
    assert.equal((await post('move', { kind: 'region', id: String(r.body), position: "left'; --", before: '' })).statusCode, 400);
    assert.equal((await post('move', { kind: 'button', id: String(b.next), region: String(r.body), slot: 'constructor', before: '' })).statusCode, 400);
    assert.equal((await post('create', { kind: 'region', type: 'static', position: 'sidebar' })).statusCode, 400);
    assert.equal((await owner.one(`select count(*)::int as n from meta.region where page_id = $1`, [pageId])).n, 5, 'the refused create left nothing behind');
    assert.equal((await owner.one('select position from meta.region where id = $1', [r.body])).position, null);
  });
});
