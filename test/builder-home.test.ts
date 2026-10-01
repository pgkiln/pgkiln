// The App Builder's workspace pages (src/builder/home.ts): the home page with
// its search, sort, views and Recent list; Create, Import, Dashboard and
// Workspace Utilities; the status bar.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { ago } from '../src/builder/home.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let dev: Browser;
let appId: number;

before(async () => {
  app = await buildApp({ logger: false });
  dev = new Browser(app);
  await dev.get('/builder/login');
  await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
});
after(async () => {
  await app.close();
  await closePools();
});

describe('App Builder home', () => {
  test('tiles, the applications as a report, the side column and the status bar', async () => {
    const body = (await dev.get('/builder?view=report&sort=name')).body;
    for (const href of ['/builder/create', '/builder/import', '/builder/dashboard', '/builder/utilities']) assert.ok(body.includes(`class="ab-tile" href="${href}"`), href);
    assert.match(body, /<table class="report ab-apps">/);
    assert.ok(body.includes(`href="/builder/apps/${appId}"`));
    assert.ok(body.includes('href="/a/hr"'), 'run link');
    assert.match(body, /<aside class="ab-side"/);
    assert.match(body, /<h2>Tasks<\/h2>/);
    assert.match(body, /<footer class="ide-status">[\s\S]*admin[\s\S]*pgapex \d+\.\d+\.\d+/);
  });

  test('search on the server (without script), sort and the cards view, remembered for the session', async () => {
    // the list only (the Recent column links to applications too)
    const list = async (url: string) => /<div class="ab-main">[\s\S]*?<aside/.exec((await dev.get(url)).body)![0];
    assert.ok((await list('/builder?q=hr')).includes(`href="/builder/apps/${appId}"`));
    const none = await list('/builder?q=no-such-application-xyz');
    assert.match(none, /No application matches/);
    assert.ok(!none.includes(`href="/builder/apps/${appId}"`));
    // LIKE wildcards are searched for literally
    assert.match((await dev.get('/builder?q=%25')).body, /No application matches/);
    const sorted = (await dev.get('/builder?q=&sort=updated')).body;
    assert.match(sorted, /aria-sort="descending"><a href="[^"]*sort=updated/);
    assert.match((await dev.get('/builder?sort=bogus')).body, /aria-sort="descending"><a href="[^"]*sort=updated/, 'an unknown sort keeps the last one');
    assert.match((await dev.get('/builder?view=grid')).body, /<div class="ab-cards">/);
    assert.match((await dev.get('/builder')).body, /<div class="ab-cards">/, 'the view is remembered');
    await dev.get('/builder?view=report&sort=name');
  });

  test('Recent lists the applications the developer opened', async () => {
    const other = new Browser(app);
    await other.get('/builder/login');
    await other.submit('/builder/login', { username: 'admin', password: 'admin' });
    await other.get(`/builder/apps/${appId}`);
    const side = /<aside class="ab-side"[\s\S]*<\/aside>/.exec((await other.get('/builder')).body)![0];
    assert.match(side, new RegExp(`<h2>Recent</h2><ul class="ab-links"><li><a href="/builder/apps/${appId}">`));
  });

  test('Create and Import have their own pages; their errors come back to them', async () => {
    assert.match((await dev.get('/builder/create')).body, /<form method="post" action="\/builder\/apps">/);
    assert.match((await dev.get('/builder/import')).body, /<form method="post" action="\/builder\/import">/);
    await dev.get('/builder/create');
    const bad = await dev.submit('/builder/apps', { name: 'x', alias: '1 bad alias', authentication: 'none' });
    assert.equal(bad.headers.location, '/builder/create');
    await dev.get('/builder/import');
    const broken = await dev.submit('/builder/import', { doc: '{not json' });
    assert.equal(broken.headers.location, '/builder/import');
    assert.match((await dev.get('/builder/import')).body, /Import failed/);
  });

  test('the dashboard and workspace utilities', async () => {
    const dash = (await dev.get('/builder/dashboard')).body;
    assert.match(dash, /page views \(24h\)/);
    assert.ok(dash.includes(`href="/builder/apps/${appId}/activity"`));
    const util = (await dev.get('/builder/utilities')).body;
    for (const href of ['/builder/users', '/builder/users/providers', '/builder/developers', '/builder/sql']) assert.ok(util.includes(`href="${href}"`), href);
  });

  test('every builder link on the home page and the utilities page opens', async () => {
    for (const url of ['/builder', '/builder/utilities', '/builder/dashboard']) {
      const hrefs = [...(await dev.get(url)).body.matchAll(/href="(\/builder[^"#]*)/g)].map((m) => m[1].replace(/&amp;/g, '&'));
      assert.ok(hrefs.length > 5, url);
      for (const href of new Set(hrefs)) assert.equal((await dev.get(href)).statusCode, 200, `${url} → ${href}`);
    }
  });

  test('relative times as APEX shows them', () => {
    const now = Date.parse('2026-10-01T12:00:00Z');
    assert.equal(ago(new Date(now - 20_000), now), 'just now');
    assert.equal(ago(new Date(now - 60_000), now), '1 minute ago');
    assert.equal(ago(new Date(now - 3 * 3600_000), now), '3 hours ago');
    assert.equal(ago(new Date(now - 2 * 86400_000), now), '2 days ago');
    assert.equal(ago(new Date(now - 620 * 86400_000), now), '1.7 years ago');
    assert.equal(ago(null, now), '');
  });
});
