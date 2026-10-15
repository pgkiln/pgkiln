// Sprint 74: the builder's information architecture like APEX's: Shared
// Components as a grid of groups with a list per component type, Settings in
// tabs, search / Create page / icon view / Tasks on the application home, and
// a dismissible default-password warning.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let hr: number;
before(async () => {
  app = await buildApp({ logger: false });
  hr = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
});
after(async () => {
  await app.close();
  await closePools();
});

const builder = async () => {
  const b = new Browser(app);
  await b.get('/builder/login');
  assert.equal((await b.submit('/builder/login', { username: 'admin', password: 'admin' })).statusCode, 303);
  return b;
};

describe('Shared Components', () => {
  test('a grid of at most ten groups with counts; a list per type with search, sort and Create', async () => {
    const b = await builder();
    const grid = (await b.get(`/builder/apps/${hr}/shared`)).body;
    const groups = [...grid.matchAll(/<section class="region region-standard sc-group"/g)].length;
    assert.ok(groups > 0 && groups <= 10, `${groups} groups`);
    const navCount = (await owner.one('select count(*)::int as n from meta.nav_entry where app_id = $1', [hr])).n;
    assert.match(grid, new RegExp(`href="/builder/apps/${hr}/shared\\?type=nav_entry">Navigation Menu</a><span class="sc-count" aria-label="${navCount} Navigation Menu">${navCount}</span>`));
    assert.match(grid, new RegExp(`href="/builder/apps/${hr}/settings\\?tab=pwa">Progressive Web App</a>`));
    const list = (await b.get(`/builder/apps/${hr}/shared?type=nav_entry`)).body;
    assert.equal([...list.matchAll(/<td data-label="Name"><a href="\?c=nav_entry-\d+">/g)].length, navCount);
    assert.match(list, /href="\?new=nav_entry">/);
    assert.match(list, new RegExp(`<p class="muted">${navCount} of ${navCount}</p>`));
    const one = (await owner.one(`select label from meta.nav_entry where app_id = $1 order by id limit 1`, [hr])).label as string;
    const found = (await b.get(`/builder/apps/${hr}/shared?type=nav_entry&q=${encodeURIComponent(one)}`)).body;
    assert.match(found, new RegExp(`[ >]${one.replace(/[()]/g, '\\$&')}</a>`));
    assert.match((await b.get(`/builder/apps/${hr}/shared?type=nav_entry&sort=desc`)).body, /aria-sort="descending"/);
    // the editor keeps the tree; the breadcrumb leads back to the list
    const id = (await owner.one(`select id from meta.nav_entry where app_id = $1 order by id limit 1`, [hr])).id;
    assert.match((await b.get(`/builder/apps/${hr}/shared?c=nav_entry-${id}`)).body, new RegExp(`href="/builder/apps/${hr}/shared\\?type=nav_entry">Navigation menu</a>`));
    // the tree view, with Access control, stays
    assert.match((await b.get(`/builder/apps/${hr}/shared?view=tree`)).body, /Grant access/);
    for (const bad of ['nonsense', '<script>', 'access'])
      assert.equal((await b.get(`/builder/apps/${hr}/shared?type=${encodeURIComponent(bad)}`)).statusCode, 200, bad);
  });

  test('Breadcrumbs: the pages by their breadcrumb parent', async () => {
    const b = await builder();
    const page = (await b.get(`/builder/apps/${hr}/breadcrumbs`)).body;
    assert.match(page, /<h2[^>]*>Breadcrumbs<\/h2>/);
    const child = await owner.one(`select p.id, p.page_no, p.name from meta.page p where p.app_id = $1 and p.parent_page is not null and p.parent_page <> p.page_no order by p.page_no limit 1`, [hr]);
    assert.match(page, new RegExp(`<ul class="tree">[\\s\\S]*<ul class="tree">[\\s\\S]*href="/builder/apps/${hr}/pages/${child.page_no}"`));
  });
});

describe('Settings in tabs', () => {
  test('opens on Definition; a tab by its link; the authentication type shows only its fields; Save returns to the tab', async () => {
    const b = await builder();
    const page = (await b.get(`/builder/apps/${hr}/settings`)).body;
    assert.match(page, /<section class="settings-panel" data-tab="definition">/);
    assert.match(page, /<section class="settings-panel" data-tab="security" hidden>/);
    assert.match(page, /<a href="\?tab=definition" data-tab-link="definition" aria-current="page">Definition<\/a>/);
    const sec = (await b.get(`/builder/apps/${hr}/settings?tab=security`)).body;
    assert.match(sec, /<section class="settings-panel" data-tab="security">/);
    assert.match(sec, /<div class="auth-part" data-auth="custom" hidden>/, 'HR signs in with app users');
    await owner.query(`update meta.app set authentication = 'custom' where id = $1`, [hr]);
    try {
      const custom = (await b.get(`/builder/apps/${hr}/settings?tab=security`)).body;
      assert.match(custom, /<div class="auth-part" data-auth="custom">/);
      assert.match(custom, /<div class="auth-part" data-auth="header" hidden>/);
    } finally {
      await owner.query(`update meta.app set authentication = 'app_users' where id = $1`, [hr]);
    }
    assert.match((await b.get(`/builder/apps/${hr}/settings?tab=<b>`)).body, /data-tab="definition">/, 'an unknown tab: Definition');
    const res = await b.submit(`/builder/apps/${hr}/settings/behaviour`, { error_function: '', session_warning_seconds: '120' });
    assert.equal(res.headers.location, `/builder/apps/${hr}/settings?tab=errors`);
  });
});

describe('the application home', () => {
  test('search by name or number, the icon view, Create page and Tasks', async () => {
    const b = await builder();
    const home = (await b.get(`/builder/apps/${hr}`)).body;
    assert.match(home, /<a class="btn btn-hot" href="#create-page">/);
    assert.match(home, /<aside class="app-tasks/);
    const rows = (body: string) => [...body.matchAll(/<tr>\s*<td class="num">(\d+)<\/td>/g)].map((m) => Number(m[1]));
    const p = await owner.one(`select page_no, name from meta.page where app_id = $1 order by page_no offset 3 limit 1`, [hr]);
    assert.ok(rows((await b.get(`/builder/apps/${hr}?q=${p.page_no}`)).body).includes(p.page_no));
    const byName = rows((await b.get(`/builder/apps/${hr}?q=${encodeURIComponent(p.name)}`)).body);
    assert.ok(byName.includes(p.page_no) && byName.length < rows(home).length);
    assert.match((await b.get(`/builder/apps/${hr}?q=no-such-page-zz`)).body, /No page matches/);
    const icons = (await b.get(`/builder/apps/${hr}?view=icons`)).body;
    assert.match(icons, /<ul class="page-icons" id="pages-rows">/);
    assert.match(icons, /<a href="\?view=icons" aria-current="true">/);
  });
});

describe('the default-password warning', () => {
  test('on the App Builder home only, until dismissed; the avatar keeps a dot', async () => {
    const b = await builder();
    assert.match((await b.get('/builder')).body, /You signed in with the default password/);
    const inApp = (await b.get(`/builder/apps/${hr}`)).body;
    assert.doesNotMatch(inApp, /You signed in with the default password/);
    assert.match(inApp, /class="rail-avatar has-dot"/);
    await b.get('/builder');
    assert.equal((await b.post('/builder/weak/dismiss', { __csrf: 'forged' })).statusCode, 403);
    assert.equal((await b.submit('/builder/weak/dismiss', {})).statusCode, 303);
    const after = (await b.get('/builder')).body;
    assert.doesNotMatch(after, /You signed in with the default password/);
    assert.match(after, /class="rail-avatar has-dot"/);
    // a new sign-in shows it again
    assert.match((await (await builder()).get('/builder')).body, /You signed in with the default password/);
  });
});
