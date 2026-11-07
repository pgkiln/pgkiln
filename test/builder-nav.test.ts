// Sprint 170 (UX-3, UX-4): the builder's icon rail marks one section per page, by the request's path; Administration
// is a rail entry whose page groups the workspace utilities; the rail can show its labels (kept in the session).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools } from '../src/db.ts';
import { sectionOf } from '../src/builder/ui.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
before(async () => {
  app = await buildApp({ logger: false });
});
after(async () => {
  await app.close();
  await closePools();
});

const admin = async () => {
  const b = new Browser(app);
  await b.get('/builder/login');
  assert.equal((await b.submit('/builder/login', { username: 'admin', password: 'admin' })).statusCode, 303);
  return b;
};
const current = (body: string) => [...body.matchAll(/<a href="([^"]+)" class="rail-link"[^>]*aria-current="page"/g)].map((m) => m[1]);

describe('the builder rail (UX-3)', () => {
  test('sectionOf: the path decides; a path it does not know keeps the page\'s own section', () => {
    assert.equal(sectionOf('/builder/home', 'apps'), 'home');
    assert.equal(sectionOf('/builder/sql/worksheet?new=1', 'apps'), 'sql');
    assert.equal(sectionOf('/builder/utilities', 'apps'), 'admin');
    assert.equal(sectionOf('/builder/workspaces/1/utilization', 'apps'), 'admin');
    assert.equal(sectionOf('/builder/users/providers', 'apps'), 'admin');
    assert.equal(sectionOf('/builder/apps/1/pages/3', 'sql'), 'apps');
    assert.equal(sectionOf('/builder/security', 'developers'), 'developers', 'the developer\'s own page: no section');
    assert.equal(sectionOf('/builder/utilitiesx', 'apps'), 'apps', 'whole path segments only');
    assert.equal(sectionOf(undefined, 'team'), 'team');
  });

  test('exactly one rail entry is current, the right one', async () => {
    const b = await admin();
    for (const [path, href] of [
      ['/builder/home', '/builder/home'], ['/builder/apps/1', '/builder/apps'], ['/builder/sql', '/builder/sql'],
      ['/builder/utilities', '/builder/utilities'], ['/builder/users', '/builder/utilities'], ['/builder/developers', '/builder/utilities'],
      ['/builder/instance', '/builder/utilities'], ['/builder/team', '/builder/team'],
    ] as const) assert.deepEqual(current((await b.get(path)).body), [href], path);
  });

  test('labels next to the icons, kept for the session; the toggle needs the CSRF token and stays in the builder', async () => {
    const b = await admin();
    await b.get('/builder/apps');
    assert.doesNotMatch((await b.get('/builder/apps')).body, /class="builder-body ide[^"]*rail-labels/);
    const on = await b.request('POST', '/builder/rail', { __csrf: b.lastCsrf, labels: 'labels' });
    assert.equal(on.statusCode, 303);
    assert.match((await b.get('/builder/apps')).body, /class="builder-body ide[^"]*rail-labels/);
    assert.equal((await b.request('POST', '/builder/rail', { labels: '' })).statusCode, 403, 'no CSRF token');
    const res = await b.app.inject({ method: 'POST', url: '/builder/rail', payload: new URLSearchParams({ __csrf: b.lastCsrf, labels: '' }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: [...b.cookies].map(([k, v]) => `${k}=${v}`).join('; '), referer: 'https://evil.example/builder/x' } });
    assert.equal(res.headers.location, '/builder/home', 'another site\'s page is not where it goes back to');
    assert.doesNotMatch((await b.get('/builder/apps')).body, /rail-labels/);
  });
});

describe('Administration (UX-4)', () => {
  test('the workspace utilities in sections, without the rail\'s own tools', async () => {
    const body = (await (await admin()).get('/builder/utilities')).body;
    const sections = [...body.matchAll(/<section class="adm-section"[^>]*><h2 id="adm-([a-z]+)"/g)].map((m) => m[1]);
    assert.deepEqual(sections, ['people', 'connections', 'data', 'operations', 'workspace', 'instance', 'reports']);
    assert.match(body, /<h1>Administration<\/h1>/);
    assert.doesNotMatch(body, /class="adm-tile" href="\/builder\/(gallery|sql)"/);
    assert.match(body, /data-adm-filter/);
  });
});

describe('one heading and one primary action per page (UX-5), what needs attention first (UX-13)', () => {
  const visibleH1 = (body: string) => [...body.matchAll(/<h1(?![^>]*class="[^"]*sr-only)[^>]*>([\s\S]*?)<\/h1>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());
  // in the page's main area (the shell's own chrome is not a page action)
  const primaries = (body: string) => {
    const main = body.slice(body.indexOf('<main'), body.indexOf('</main>'));
    return [...main.matchAll(/class="btn[^"]*\b(btn-hot|btn-run)\b[^"]*"/g)].length;
  };
  test('App Builder, an application, SQL Workshop, the gallery and Administration', async () => {
    const b = await admin();
    for (const [path, h1] of [['/builder/apps', 'App Builder'], ['/builder/apps/1', 'HR Demo'], ['/builder/sql', 'SQL Workshop'],
      ['/builder/gallery', 'App Gallery'], ['/builder/utilities', 'Administration']] as const) {
      const body = (await b.get(path)).body;
      assert.deepEqual(visibleH1(body), [h1], `${path}: one visible heading`);
      assert.ok(primaries(body) <= 1, `${path}: at most one primary action (${primaries(body)})`);
    }
    // App Builder: Create once, in the header; the old cards and the duplicate tasks are gone
    const ab = (await b.get('/builder/apps')).body;
    assert.equal((ab.match(/href="\/builder\/create"/g) ?? []).length, 1);
    assert.doesNotMatch(ab, /class="ab-tile"/);
    // an application's Pages tab: Create page is the header's primary action, not repeated in Tasks
    const home = (await b.get('/builder/apps/1')).body;
    assert.match(home, /class="btn btn-sm btn-hot" href="\/builder\/apps\/1\/create-page"/);
    assert.doesNotMatch(home.slice(home.indexOf('app-tasks')), /href="\/builder\/apps\/1\/create-page"/);
    assert.doesNotMatch(home.slice(home.indexOf('app-tasks')), /settings\?tab=definition/, 'Delete the application is not a task');
  });

  test('the Workspace home lists lockout risks above the tools for administrators', async () => {
    const { attentionCount } = await import('../src/instance-checks.ts');
    const body = (await (await admin()).get('/builder/home')).body;
    if ((await attentionCount()) > 0) assert.ok(body.indexOf('wh-attention') > 0 && body.indexOf('wh-attention') < body.indexOf('wh-tools'), 'above the tools');
    else assert.doesNotMatch(body, /wh-attention/);
  });
});
