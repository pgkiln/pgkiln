// Sprint 207 (AX-4, APEX: a region's slots in the Page Designer's Layout): every region on the layout draws a Sub
// regions slot and the button positions its template places, as drop targets (the empty ones while dragging, or
// always on a maximized layout); the rendering tree groups a region's buttons by position under one Buttons node;
// the layout's keyboard hint is in the Help tab, the bar keeps a ? that opens it.
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
const alias = 'ts-s207';
const r: Record<string, number> = {};
const b: Record<string, number> = {};

const region = async (title: string, seq: number, template = 'standard', parent: number | null = null) =>
  (await owner.one(`insert into meta.region (page_id, seq, title, type, source, template, parent_id) values ($1, $2, $3, 'static', '<p>x</p>', $4, $5) returning id`,
    [pageId, seq, title, template, parent])).id as number;
const button = async (name: string, regionId: number | null, slot: string | null, seq: number) =>
  (await owner.one(`insert into meta.button (page_id, region_id, seq, name, label, action, slot) values ($1, $2, $3, $4, $4, 'submit', $5) returning id`,
    [pageId, regionId, seq, name, slot])).id as number;
let dev: Browser;
const designer = async () => (await dev.get(`/builder/pages/${pageId}`)).body;
/** the layout block of a region (up to the next region's block or the end of its grid) */
const block = (html: string, id: number) => {
  const at = html.indexOf(`data-kind="region" data-id="${id}" data-span=`);
  assert.ok(at >= 0, `region ${id} is on the layout`);
  const start = html.lastIndexOf('<div class="pd-region ', at);
  const end = html.indexOf('<span class="pd-resize"', start);
  return html.slice(start, end);
};
const tree = (html: string) => /<ul class="pd-tree" aria-label="Rendering"[\s\S]*?<\/ul>\s*<dialog/.exec(html)![0];

before(async () => {
  app = await buildApp({ logger: false });
  await owner.query('delete from meta.app where alias = $1', [alias]);
  appId = (await owner.one(`insert into meta.app (alias, name, authentication, db_role) values ($1, 'Slots test', 'none', 'hr_app') returning id`, [alias])).id;
  pageId = (await owner.one(`insert into meta.page (app_id, page_no, name, requires_auth) values ($1, 1, 'Home', false) returning id`, [appId])).id;
  r.report = await region('Orders', 10);
  r.hero = await region('Welcome', 20, 'hero');
  r.tabs = await region('Tabs', 30, 'tabs_container');
  r.inner = await region('Inner', 10, 'plain', r.tabs);
  b.create = await button('CREATE', r.report, null, 10);
  b.close = await button('CANCEL', r.report, 'close', 20);
  b.heroNext = await button('GO', r.hero, 'next', 10);
  dev = new Browser(app);
  await dev.get('/builder/login');
  await dev.post('/builder/login', { __csrf: dev.lastCsrf, username: 'admin', password: 'admin' });
});

after(async () => {
  await owner.query('delete from meta.app where id = $1', [appId]);
  await app.close();
  await closePools();
});

describe('the layout: a region\'s slots', () => {
  test('a standard region offers every button position and a Sub regions slot, the empty ones as spares', async () => {
    const html = await designer();
    const own = block(html, r.report);
    for (const sl of ['create', 'edit', 'change', 'copy', 'help', 'up', 'previous', 'delete', 'next'])
      assert.match(own, new RegExp(`class="pd-slot pd-slot-button pd-slot-spare" data-drop="button" data-region="${r.report}" data-slot="${sl}"`), sl);
    assert.match(own, new RegExp(`class="pd-slot pd-slot-button" data-drop="button" data-region="${r.report}" data-slot="close"`), 'a position with a button is no spare');
    assert.match(own, new RegExp(`class="pd-slot pd-slot-button" data-drop="button" data-region="${r.report}" data-slot="region"`));
    // the Sub regions slot of a region that is not a container: a spare, a drop target for regions
    assert.match(own, new RegExp(`<div class="pd-sub pd-sub-spare">\\s*<div class="pd-sub-label">Sub regions</div>\\s*<div class="pd-grid pd-subgrid" data-drop="region" data-position="body" data-parent="${r.report}">`));
    assert.match(own, new RegExp(`href="/builder/apps/${appId}/pages/1\\?new=region&amp;parent=${r.report}"`));
  });

  test('a template that does not place buttons by position (hero) offers only the region\'s buttons, and positions in use', async () => {
    const own = block(await designer(), r.hero);
    assert.match(own, new RegExp(`data-region="${r.hero}" data-slot="region"`));
    assert.match(own, new RegExp(`class="pd-slot pd-slot-button" data-drop="button" data-region="${r.hero}" data-slot="next"`), 'its button keeps a place');
    for (const sl of ['create', 'edit', 'previous', 'close', 'delete']) assert.doesNotMatch(own, new RegExp(`data-region="${r.hero}" data-slot="${sl}"`), sl);
    assert.match(own, /<div class="pd-slots pd-slots-top"><\/div>/, 'an empty row (hidden by CSS)');
  });

  test('a container\'s slot is no spare; a region with sub regions says so (data-holds); a sub region has no slot of its own', async () => {
    const html = await designer();
    const tabs = block(html, r.tabs);
    assert.match(tabs, /^<div class="pd-region [^"]*" data-kind="region" data-id="\d+" data-span="12" data-holds>/);
    assert.match(tabs, new RegExp(`<div class="pd-sub">\\s*<div class="pd-sub-label">Sub regions <small>`));
    assert.doesNotMatch(block(html, r.report), /data-holds/);
    assert.doesNotMatch(block(html, r.inner), /pd-subgrid/);
  });

  test('a report dropped on a region\'s Sub regions slot is nested; a button dropped on Next takes that position', async () => {
    await dev.get(`/builder/pages/${pageId}`);
    const made = await dev.post(`/builder/pages/${pageId}/layout/create`, { __csrf: dev.lastCsrf, kind: 'region', type: 'report', parent: String(r.report), position: 'body', before: '' });
    assert.equal(made.statusCode, 303);
    const sub = (await owner.one(`select id, parent_id, type from meta.region where page_id = $1 and type = 'report'`, [pageId]));
    assert.equal(sub.parent_id, r.report);
    const moved = await dev.post(`/builder/pages/${pageId}/layout/move`, { __csrf: dev.lastCsrf, kind: 'button', id: String(b.create), region: String(r.report), slot: 'next', before: '' });
    assert.equal(moved.statusCode, 303);
    assert.equal((await owner.one('select slot from meta.button where id = $1', [b.create])).slot, 'next');
    // the region now holds a sub region: its slot is no spare, and it stays at page level
    const own = block(await designer(), r.report);
    assert.match(own, / data-holds>/);
    assert.match(own, /<div class="pd-sub">/);
    const refused = await dev.post(`/builder/pages/${pageId}/layout/move`, { __csrf: dev.lastCsrf, kind: 'region', id: String(r.report), parent: String(r.hero), before: '' });
    assert.equal(refused.statusCode, 400);
    await owner.query('delete from meta.region where id = $1', [sub.id]);
    await owner.query('update meta.button set slot = null where id = $1', [b.create]);
  });
});

describe('the rendering tree: buttons by position', () => {
  test('one Buttons node, a folder per position in the layout\'s order', async () => {
    const t = tree(await designer());
    const reportNode = t.slice(t.indexOf(`data-id="${r.report}"`), t.indexOf(`data-id="${r.hero}"`));
    assert.equal(reportNode.split('<span class="pd-label">Buttons</span>').length - 1, 1, 'one Buttons node');
    assert.match(reportNode, /<li data-slot="region"><span class="pd-node pd-folder"><span class="pd-label">Region buttons<\/span><\/span><ul><li><a class="pd-node"[^>]*data-kind="button"[^>]*title="CREATE/);
    assert.match(reportNode, /<li data-slot="close"><span class="pd-node pd-folder"><span class="pd-label">Close<\/span>[\s\S]*?title="CANCEL/);
    assert.ok(reportNode.indexOf('data-slot="region"') < reportNode.indexOf('data-slot="close"'), 'the region\'s own before the bottom bar');
    assert.doesNotMatch(t, /Buttons: /);
  });
});

describe('the layout bar and the Help tab', () => {
  test('the keyboard hint is in the Help tab; the bar has a ? that opens it', async () => {
    const html = await designer();
    const bar = /<div class="pd-canvas-bar"[\s\S]*?<\/div>/.exec(html)![0];
    assert.doesNotMatch(bar, /pd-canvas-hint|Alt\+/);
    assert.match(bar, /<a class="tb-btn pd-canvas-help" href="#pd-c-help" data-show-tab="pd-c-help" title="Layout help and keyboard keys">/);
    const help = /<section class="tab-panel" id="pd-c-help"[\s\S]*?<\/section>/.exec(html)![0];
    assert.match(help, /<p id="pd-kbd">Drag to move\. Keyboard: Alt\+/);
    assert.match(help, /While you drag, each region shows its slots/);
    // the layout's components are still described by it
    assert.match(html, /class="pd-region-link"[^>]*aria-describedby="pd-kbd"/);
  });
});
