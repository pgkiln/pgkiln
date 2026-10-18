// Sprint 109 (WS-1; migration 119): the Workspace home (/builder/home), the page the builder opens after signing in:
// tool cards, the workspace message (edited in place), Top applications and Top users over a timeframe remembered per
// developer, the Summary, the System message (the running version; a newer release when the check is on) and the
// side column.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { newerVersion, parseRelease, resetReleaseCache, VERSION } from '../src/release-check.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let server: Server;
let hits = 0;
let reply: unknown = {};
const ALIAS = 'wh109';
let appId: number;
let ws: number;

before(async () => {
  app = await buildApp({ logger: false });
  server = createServer((_req, res) => {
    hits++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(reply));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.PGKILN_RELEASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/releases/latest`;
  await owner.query(`delete from meta.app where alias = $1`, [ALIAS]);
  await owner.query(`delete from meta.workspace where name = 'WH109 test'`);
  // a workspace of its own: other tests' page views stay out of its numbers
  ws = (await owner.one(`insert into meta.workspace (name) values ('WH109 test') returning id`)).id;
  appId = (await owner.one(`insert into meta.app (alias, name, authentication) values ($1, 'Home 109 app', 'none') returning id`, [ALIAS])).id;
  await owner.query('insert into meta.workspace_app (app_id, workspace_id) values ($1, $2)', [appId, ws]);
  await owner.query(`insert into meta.activity_log (app_id, page_no, username, event, at) select $1, 1, 'wh109_user', 'page_view', now() - interval '30 minutes' from generate_series(1, 7)`, [appId]);
  await owner.query(`insert into meta.activity_log (app_id, page_no, username, event, at) select $1, 1, 'wh109_old', 'page_view', now() - interval '3 days' from generate_series(1, 9)`, [appId]);
  await owner.query(`insert into meta.activity_log (app_id, page_no, username, event, at) select $1, 1, 'admin', 'page_view', now() - interval '2 hours' from generate_series(1, 2)`, [appId]);
  await owner.query(`delete from meta.setting where name = 'release_check'`);
  await owner.query(`update meta.developer set home_timeframe = null where username = 'admin'`);
});
after(async () => {
  delete process.env.PGKILN_RELEASE_URL;
  await owner.query(`delete from meta.setting where name = 'release_check'`);
  await owner.query(`update meta.developer set home_timeframe = null where username = 'admin'`);
  await owner.query(`delete from meta.activity_log where app_id = $1`, [appId]);
  await owner.query(`delete from meta.app where id = $1`, [appId]);
  await owner.query(`delete from meta.workspace where id = $1`, [ws]);
  server.close();
  await app.close();
  await closePools();
});

const builder = async () => {
  const b = new Browser(app);
  await b.get('/builder/login');
  const res = await b.submit('/builder/login', { username: 'admin', password: 'admin' });
  assert.equal(res.statusCode, 303);
  assert.equal(res.headers.location, '/builder/home', 'signing in opens the Workspace home');
  await b.get('/builder/home');
  assert.equal((await b.submit('/builder/workspace', { workspace: String(ws) })).statusCode, 303);
  return b;
};

describe('the Workspace home', () => {
  test('after signing in; / and the sign-in page lead there; the App Builder is at /builder/apps and /builder', async () => {
    const b = await builder();
    assert.equal((await b.get('/builder/login')).headers.location, '/builder/home');
    assert.equal((await new Browser(app).get('/')).headers.location, '/builder/home');
    const home = await b.get('/builder/home');
    assert.equal(home.statusCode, 200);
    assert.match(home.body, /<title>Workspace home · Builder<\/title>/);
    assert.match(home.body, /<a href="\/builder\/home" class="rail-link" title="Home" aria-current="page">/, 'the rail has Home');
    assert.match(home.body, /class="rail-logo" href="\/builder\/home"/);
    for (const [href, title] of [['/builder/apps', 'App Builder'], ['/builder/sql', 'SQL Workshop'], ['/builder/gallery', 'App Gallery']])
      assert.match(home.body, new RegExp(`<a class="ab-tile" href="${href}">.*?<strong>${title}</strong>`, 's'));
    assert.match(home.body, /You signed in with the default password/, 'the default-password banner stays on top');
    assert.match((await b.get('/builder')).body, /<h1 class="sr-only">App Builder<\/h1>/);
    const apps = (await b.get('/builder/apps')).body;
    assert.match(apps, /<h1 class="sr-only">App Builder<\/h1>/);
    assert.match(apps, /<a href="\/builder\/apps" class="rail-link" title="App Builder" aria-current="page">/);
    assert.match(home.body, /href="https:\/\/github\.com\/pgkiln\/pgkiln\/discussions"/);
    assert.match(home.body, /10-tutorial\.md/);
    // the Data Reporter card only when its tool (sprint 110) exists
    assert.equal(/href="\/builder\/reporter"/.test(home.body), app.hasRoute({ method: 'GET', url: '/builder/reporter' }));
    assert.match(home.body, /11-from-apex\.md/);
    assert.match(home.body, /CHANGELOG\.md/);
    assert.doesNotMatch(home.body, /<script(?![^>]*src=)/, 'no inline script');
  });

  test('a workspace without the SQL Workshop has no card and no link for tables', async () => {
    const b = await builder();
    await owner.query('update meta.workspace set sql_workshop = false where id = $1', [ws]);
    try {
      const home = (await b.get('/builder/home')).body;
      assert.doesNotMatch(home, /<a class="ab-tile" href="\/builder\/sql">/);
      assert.doesNotMatch(home, /href="\/builder\/sql\/objects"/);
    } finally {
      await owner.query('update meta.workspace set sql_workshop = true where id = $1', [ws]);
    }
  });

  test('Top applications, Top users and the Summary over the timeframe; the timeframe is remembered per developer', async () => {
    const b = await builder();
    let home = (await b.get('/builder/home')).body;
    assert.match(home, /<button name="timeframe" value="day" aria-pressed="true">1 day<\/button>/);
    assert.match(home, new RegExp(`<a href="/builder/apps/${appId}">Home 109 app</a></td><td class="num">9</td><td class="num">2</td>`));
    assert.match(home, /<td class="cell-break">wh109_user<\/td><td class="num">7<\/td>/);
    assert.doesNotMatch(home, /wh109_old/);
    assert.match(home, /<a class="stat" href="\/builder\/apps"><b>\d+<\/b><span>application<\/span><\/a>/, 'one application');
    assert.match(home, /<b>\d+<\/b><span>reporting applications?<\/span>/);
    assert.match(home, /Top developers \(1 day\)/);
    assert.match(home, /<td class="cell-break">admin<\/td><td class="num">2<\/td><td class="num">1<\/td>/, 'the administrator is a developer');
    assert.match(home, /<a class="stat" href="\/builder\/sql\/objects"><b>\d+<\/b><span>tables?<\/span><\/a>/);
    assert.match(home, /<a class="stat" href="\/builder\/developers"><b>0<\/b><span>developers<\/span><\/a>/);
    assert.equal((await b.submit('/builder/home/timeframe', { timeframe: 'week' })).statusCode, 303);
    assert.equal((await owner.one(`select home_timeframe from meta.developer where username = 'admin'`)).home_timeframe, 'week');
    // a new sign-in keeps it
    home = (await (await builder()).get('/builder/home')).body;
    assert.match(home, /<button name="timeframe" value="week" aria-pressed="true">/);
    assert.match(home, /<td class="cell-break">wh109_old<\/td><td class="num">9<\/td>/);
    assert.match(home, /Top users \(1 week\)/);
    await b.get('/builder/home');
    assert.equal((await b.submit('/builder/home/timeframe', { timeframe: 'hour' })).statusCode, 303);
    home = (await b.get('/builder/home')).body;
    assert.match(home, /wh109_user/);
    assert.equal((await b.submit('/builder/home/timeframe', { timeframe: 'year' })).statusCode, 400);
  });

  test('the workspace message: shown, edited in place by an administrator, plain text', async () => {
    const b = await builder();
    await b.get('/builder/home');
    assert.equal((await b.submit('/builder/home/message', { workspace: String(ws), message: 'Maintenance <b>tonight</b>\nat 22:00' })).statusCode, 303);
    const home = (await b.get('/builder/home')).body;
    assert.match(home, /<p class="wh-message-text">Maintenance &lt;b&gt;tonight&lt;\/b&gt;\nat 22:00<\/p>/);
    assert.match(home, /<details class="wh-edit">/);
    assert.match((await b.get('/builder')).body, /Maintenance &lt;b&gt;tonight/, 'the App Builder home shows it too');
    await b.get('/builder/home');
    await b.submit('/builder/home/message', { workspace: String(ws), message: 'x'.repeat(2001) });
    assert.match((await b.get('/builder/home')).body, /at most 2000 characters/);
    await b.submit('/builder/home/message', { workspace: String(ws), message: '' });
    assert.equal((await owner.one('select message from meta.workspace where id = $1', [ws])).message, null);
  });

  test('the System message: the running version; the check is off by default', async () => {
    resetReleaseCache();
    const before = hits;
    const b = await builder();
    const home = (await b.get('/builder/home')).body;
    assert.match(home, new RegExp(`This server runs <strong>pgkiln ${VERSION.replace(/\./g, '\\.')}</strong>`));
    assert.match(home, /The check for new versions is off/);
    assert.match(home, /<button class="btn btn-sm" name="check" value="on">Check for new versions<\/button>/);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(hits, before, 'no request');
  });

  test('turned on: a newer release shows with its notes link and the upgrade hint; Check now; Turn off', async () => {
    resetReleaseCache();
    reply = { tag_name: 'v99.1.0', name: 'pgkiln 99.1.0', html_url: 'https://github.com/pgkiln/pgkiln/releases/tag/v99.1.0', published_at: new Date().toISOString() };
    const b = await builder();
    await b.get('/builder/home');
    assert.equal((await b.submit('/builder/home/release-check', { check: 'on' })).statusCode, 303);
    let home = (await b.get('/builder/home')).body;
    assert.match(home, /<strong>pgkiln 99\.1\.0 is available<\/strong>/);
    assert.match(home, /href="https:\/\/github\.com\/pgkiln\/pgkiln\/releases\/tag\/v99\.1\.0"/);
    assert.match(home, /pgkiln migrate/);
    // the same version: no announcement
    reply = { tag_name: `v${VERSION}`, name: 'current' };
    const n = hits;
    await b.submit('/builder/home/release-check', { check: 'now' });
    assert.equal(hits, n + 1);
    home = (await b.get('/builder/home')).body;
    assert.doesNotMatch(home, /is available/);
    assert.match(home, /It is the latest release/);
    // cached: viewing the page asks no more
    await b.get('/builder/home');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(hits, n + 1);
    await b.submit('/builder/home/release-check', { check: 'off' });
    assert.match((await b.get('/builder/home')).body, /The check for new versions is off/);
  });

  test('the workspace preference: /builder opens the App Builder, or the Workspace home', async () => {
    const b = await builder();
    await b.get(`/builder/workspaces/${ws}`);
    try {
      assert.equal((await b.submit(`/builder/workspaces/${ws}/preferences`, { sql_workshop: 'true', rest_services: 'true', builder_home: 'home' })).statusCode, 303);
      assert.equal((await owner.one('select builder_home from meta.workspace where id = $1', [ws])).builder_home, 'home');
      assert.match((await b.get(`/builder/workspaces/${ws}`)).body, /<option value="home" selected>Workspace home<\/option>/);
      const res = await b.get('/builder');
      assert.equal(res.statusCode, 302);
      assert.equal(res.headers.location, '/builder/home');
      assert.equal((await b.get('/builder?q=x')).statusCode, 200, 'a search stays on the App Builder');
      assert.equal((await b.get('/builder/apps')).statusCode, 200);
      await b.submit(`/builder/workspaces/${ws}/preferences`, { sql_workshop: 'true', rest_services: 'true', builder_home: 'apps' });
      assert.equal((await b.get('/builder')).statusCode, 200);
    } finally {
      await owner.query('update meta.workspace set builder_home = null where id = $1', [ws]);
    }
  });

  test('the Instance settings page: the release check on, off or as the environment says', async () => {
    await owner.query(`delete from meta.setting where name = 'release_check'`);
    const b = await builder();
    let page = (await b.get('/builder/instance')).body;
    assert.match(page, /<option value="default" selected>/);
    const res = await b.submit('/builder/home/release-check', { check: 'off', from: 'instance' });
    assert.equal(res.headers.location, '/builder/instance#release-check');
    page = (await b.get('/builder/instance')).body;
    assert.match(page, /<option value="off" selected>Off<\/option>/);
    await b.submit('/builder/home/release-check', { check: 'default', from: 'instance' });
    assert.ok(!(await owner.one(`select 1 from meta.setting where name = 'release_check'`)));
  });

  test('versions and release documents', () => {
    assert.ok(newerVersion('0.51.0', '0.50.0'));
    assert.ok(newerVersion('v1.0.0', '0.50.0'));
    assert.ok(!newerVersion('0.50.0', '0.50.0'));
    assert.ok(!newerVersion('0.9.0', '0.50.0'));
    assert.ok(!newerVersion('1.0.0-rc1', '0.50.0'));
    assert.equal(parseRelease({ tag_name: 'nightly' }), null);
    assert.equal(parseRelease(null), null);
    const r = parseRelease({ tag_name: 'v1.2.3', html_url: 'javascript:alert(1)' })!;
    assert.equal(r.url, 'https://github.com/pgkiln/pgkiln/releases/tag/v1.2.3');
    assert.equal(r.name, 'pgkiln 1.2.3');
  });
});
