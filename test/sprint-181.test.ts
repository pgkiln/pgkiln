// Sprint 181 (parity leftovers). WS-8: remote catalogues for the App Gallery (migration 164): starter and utility
// apps listed from a URL, their blueprints fetched on Install and opened in the review.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';

process.env.PGKILN_REST_ALLOWED_HOSTS = '127.0.0.1';
process.env.PGKILN_REST_PRIVATE_HOSTS = '127.0.0.1';

const { buildApp } = await import('../src/app.ts');
const { closePools, owner } = await import('../src/db.ts');
const { parseCatalogue } = await import('../src/gallery-remote.ts');
const { Browser } = await import('./helpers.ts');

const BLUEPRINT = { ...JSON.parse(readFileSync(new URL('../examples/gallery/starters/team-tasks.json', import.meta.url), 'utf8')), alias: 's181-tasks', name: 'Remote Tasks' };
let routes: Record<string, { status?: number; body: string }> = {};
let hits: string[] = [];
let server: http.Server;
let base = '';
let app: FastifyInstance;

const catalogue = (more: Record<string, unknown> = {}) => JSON.stringify({
  starters: [{ key: 'remote-tasks', title: 'Remote Tasks <b>bold</b>', icon: 'list-checks', version: '2.0', url: 'blueprints/tasks.json', description: 'Tasks from <script>alert(1)</script> afar' }],
  utilities: [{ key: 'remote-notes', title: 'Remote Notes', icon: 'no-such-icon', url: `${base}/blueprints/notes.json` }],
  ...more,
});
const admin = async () => {
  const b = new Browser(app);
  await b.get('/builder/login');
  await b.submit('/builder/login', { username: 'admin', password: 'admin' });
  await b.get('/builder/gallery?tab=starters');
  return b;
};
const sources = async () => (await owner.query(`select * from meta.gallery_source where name like 'S181%' order by id`)).rows;

before(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    const r = routes[req.url ?? ''];
    res.writeHead(r?.status ?? (r ? 200 : 404), { 'content-type': 'application/json' });
    res.end(r?.body ?? '{}');
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  app = await buildApp({ logger: false });
});
beforeEach(async () => {
  hits = [];
  routes = { '/gallery.json': { body: catalogue() }, '/blueprints/tasks.json': { body: JSON.stringify(BLUEPRINT) }, '/blueprints/notes.json': { body: JSON.stringify({ ...BLUEPRINT, alias: 's181-notes' }) } };
  await owner.query(`delete from meta.gallery_source where name like 'S181%'`);
});
after(async () => {
  await owner.query(`delete from meta.gallery_source where name like 'S181%'`);
  await app.close();
  server.close();
  await closePools();
});

describe('sprint 181: remote catalogues in the App Gallery (WS-8)', () => {
  test('the catalogue is checked: blueprints only, keys unique, URLs resolved, unknown icons replaced', () => {
    const { catalogue: c, problems } = parseCatalogue({
      samples: [{ key: 'evil', file: 'samples/x.sql' }],
      starters: [
        { key: 'a', title: 'A', url: 'a.json', icon: 'list-checks', version: '1.2', description: 'x'.repeat(900) },
        { key: 'a', title: 'Again', url: 'b.json' },
        { key: 'Bad Key', title: 'B', url: 'b.json' },
        { key: 'c', title: 'C', url: 'javascript:alert(1)' },
        { key: 'd', title: 'D', url: 'file:///etc/passwd' },
        { key: 'e', url: 'e.json' },
      ],
      utilities: [{ key: 'u', title: 'U', url: '../u.json', icon: 'nope', version: '<b>' }],
    }, 'https://example.com/cat/gallery.json');
    assert.deepEqual(c.starters.map((x) => x.key), ['a']);
    assert.equal(c.starters[0].url, 'https://example.com/cat/a.json');
    assert.equal(c.starters[0].description.length, 500);
    assert.equal(c.utilities[0].url, 'https://example.com/u.json');
    assert.equal(c.utilities[0].icon, 'package');
    assert.equal(c.utilities[0].version, '');
    assert.equal(problems.length, 6, problems.join(' | '));
    assert.match(problems.join(' '), /Sample apps are left out/);
    assert.equal(parseCatalogue([], 'https://x/').problems[0], 'The catalogue is not a JSON object.');
  });

  test('an administrator adds a catalogue; its apps are listed with its name, escaped, and open in the blueprint review', async () => {
    const a = await admin();
    let res = await a.submit('/builder/gallery/sources', { name: 'S181 Partner', url: `${base}/gallery.json`, tab: 'starters' });
    assert.equal(res.statusCode, 303);
    const [src] = await sources();
    assert.equal(src.catalogue.starters.length, 1);
    assert.equal(src.error, null);
    const page = (await a.get('/builder/gallery?tab=starters')).body;
    assert.match(page, /<h2>Remote Tasks &lt;b&gt;bold&lt;\/b&gt;<\/h2><span class="muted small">S181 Partner<\/span>/);
    assert.match(page, /title="Version 2\.0">v2\.0</);
    assert.ok(!page.includes('<script>alert(1)</script>'));
    assert.match(page, new RegExp(`action="/builder/gallery/remote/${src.id}/starters/remote-tasks"`));
    assert.match((await a.get('/builder/gallery?tab=utilities')).body, /Remote Notes/);
    // Install: the blueprint is fetched now and opens in the review; nothing is created
    hits = [];
    res = await a.submit(`/builder/gallery/remote/${src.id}/starters/remote-tasks`, {});
    assert.equal(res.statusCode, 200, res.body.slice(0, 300));
    assert.deepEqual(hits, ['/blueprints/tasks.json']);
    assert.match(res.body, /s181-tasks/);
    assert.equal((await owner.query(`select 1 from meta.app where alias = 's181-tasks'`)).rowCount, 0);
  });

  test('a failed refresh keeps the apps listed and says why; switched off, nothing is listed or installed', async () => {
    const a = await admin();
    await a.submit('/builder/gallery/sources', { name: 'S181 Flaky', url: `${base}/gallery.json`, tab: 'starters' });
    const [src] = await sources();
    routes['/gallery.json'] = { status: 500, body: 'oops' };
    await a.submit(`/builder/gallery/sources/${src.id}/refresh`, { tab: 'starters' });
    const [after] = await sources();
    assert.match(after.error, /500/);
    assert.equal(after.catalogue.starters.length, 1, 'the previous entries stay');
    routes['/gallery.json'] = { body: 'not json' };
    await a.submit(`/builder/gallery/sources/${src.id}/refresh`, { tab: 'starters' });
    assert.match((await sources())[0].error, /not JSON/);
    await a.submit(`/builder/gallery/sources/${src.id}/toggle`, { tab: 'starters' });
    const dev = await admin();
    assert.doesNotMatch((await dev.get('/builder/gallery?tab=starters')).body, /<h2>Remote Tasks/);
    assert.equal((await dev.submit(`/builder/gallery/remote/${src.id}/starters/remote-tasks`, {})).statusCode, 404);
    await a.submit(`/builder/gallery/sources/${src.id}/delete`, { tab: 'starters' });
    assert.equal((await sources()).length, 0);
  });

  test('a blueprint that is missing or not JSON gives a message, not a review', async () => {
    const a = await admin();
    await a.submit('/builder/gallery/sources', { name: 'S181 Broken', url: `${base}/gallery.json`, tab: 'starters' });
    const [src] = await sources();
    delete routes['/blueprints/tasks.json'];
    const res = await a.submit(`/builder/gallery/remote/${src.id}/starters/remote-tasks`, {});
    assert.equal(res.statusCode, 303);
    assert.match((await a.get(res.headers.location as string)).body, /The blueprint of Remote Tasks &lt;b&gt;bold&lt;\/b&gt; could not be fetched: The server answered 404/);
  });
});
