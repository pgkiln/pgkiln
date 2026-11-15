// Sprint 203: AX-6 (Recently updated pages name every row, with relative times; Recently edited pages on the
// application home; Copy application in Tasks) and AX-7 (Shared Components → Templates with where each is used;
// Security → Session State Protection; both found by the builder's search).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { ensureSnapshot, recordHistory } from '../src/history.ts';
import { TEMPLATE_KEYS } from '../src/builder/ui-templates.ts';
import { builderMessages, BUILDER_LANGUAGES, translatorFor } from '../src/builder/i18n.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
const GONE = 9293; // a page made and deleted here
const NAMELESS = 9294; // a deleted page whose settings were never recorded
const COPY = 'sprint203-copy';

const login = async () => {
  const b = new Browser(app);
  await b.get('/builder/login');
  assert.equal((await b.submit('/builder/login', { username: 'admin', password: 'admin' })).statusCode, 303);
  return b;
};
const cleanup = async () => {
  await owner.query(`delete from meta.page where app_id = $1 and page_no in (${GONE}, ${NAMELESS})`, [appId]);
  await owner.query(`delete from meta.component_change where app_id = $1 and page_no in (${GONE}, ${NAMELESS})`, [appId]);
  await owner.query(`delete from meta.page_change where app_id = $1 and updated_by = 'sprint203-other'`, [appId]);
  await owner.query(`delete from meta.app where alias like 'sprint203%'`);
};

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  await cleanup();
});

after(async () => {
  await cleanup();
  await recordHistory(appId, null).catch(() => 0); // the snapshot without the test's pages
  await app.close();
  await closePools();
});

describe('sprint 203 AX-6: pages by name, recently edited pages, Copy application', () => {
  test('Recently updated pages: a deleted page by its last recorded name, never a number alone; times are relative', async () => {
    await ensureSnapshot(appId);
    await recordHistory(appId, null);
    await owner.query(`insert into meta.page (app_id, page_no, name, title) values ($1, ${GONE}, 'Sprint 203 gone', 'Gone')`, [appId]);
    await recordHistory(appId, 'admin');
    await owner.query(`delete from meta.page where app_id = $1 and page_no = ${GONE}`, [appId]);
    await recordHistory(appId, 'admin');
    // a change of a page whose settings the history never had (e.g. recorded before the page's settings were split)
    await owner.query(`insert into meta.component_change (app_id, component, label, page_no, op, before, after, changed_by)
                       values ($1, 'pages/${NAMELESS}/regions/x', 'Page ${NAMELESS} › region x', ${NAMELESS}, 'deleted', '{}', null, null)`, [appId]);
    const b = await login();
    const body = (await b.get(`/builder/apps/${appId}/utilities`)).body;
    const table = /Recently updated pages[\s\S]*?<\/table>/.exec(body)![0];
    assert.match(table, new RegExp(`href="/builder/apps/${appId}/utilities/history\\?page=${GONE}">Deleted page ${GONE} \\(Sprint 203 gone\\)</a>`));
    assert.match(table, new RegExp(`>Deleted page ${NAMELESS}</a>`));
    assert.match(table, /<time datetime="[^"]+" title="\d{4}-\d{2}-\d{2} \d{2}:\d{2}">(just now|\d+ (second|minute)s? ago)<\/time>/);
    assert.doesNotMatch(table, /<td data-label="Last change">\d{4}-/, 'no absolute time as the text');
    // every row's first cell has a name, not a number alone
    for (const cell of table.matchAll(/<td data-label="Page">([\s\S]*?)<\/td>/g)) assert.doesNotMatch(cell[1].replace(/<[^>]+>/g, '').trim(), /^\d+$/, cell[1]);
    assert.match(table, /<span class="muted">command line<\/span>/, 'a change without a developer');
    // in German too
    assert.equal(translatorFor('de')('util.deleted_page_named', { n: GONE, name: 'X' }), `Gelöschte Seite ${GONE} (X)`);
  });

  test('the application home lists five recently edited pages, yours first, linking into the Page Designer', async () => {
    // (other test files change pages as admin too: take two pages without admin's changes, and make yours the newest of admin's)
    const pages = (await owner.query<{ page_no: number }>(
      `select p.page_no from meta.page p where p.app_id = $1 and p.page_no > 0
          and not exists (select 1 from meta.component_change c where c.app_id = p.app_id and c.page_no = p.page_no and c.changed_by = 'admin')
          and not exists (select 1 from meta.page_change c where c.app_id = p.app_id and c.page_no = p.page_no and c.updated_by = 'admin')
        order by p.page_no limit 2`, [appId])).rows.map((r) => r.page_no);
    const [mine, other] = pages;
    // a change of yours (dated after any other of admin's), another developer's later still
    await owner.query(`insert into meta.component_change (app_id, component, label, page_no, op, before, after, changed_by, changed_at)
                       values ($1, 'pages/x/page', 'Page', $2, 'changed', '{}', '{}', 'admin', now() + interval '1 hour')`, [appId, mine]);
    await owner.query(`insert into meta.page_change (app_id, page_no, updated_by, updated_at) values ($1, $2, 'sprint203-other', now() + interval '2 hours')
                       on conflict (app_id, page_no) do update set updated_by = excluded.updated_by, updated_at = excluded.updated_at`, [appId, other]);
    try {
      const b = await login();
      const body = (await b.get(`/builder/apps/${appId}`)).body;
      const side = /<div class="app-side">[\s\S]*?<section class="app-recent[\s\S]*?<\/section>/.exec(body)?.[0];
      assert.ok(side, 'in the side column');
      assert.ok(side.indexOf('id="app-tasks-h"') < side.indexOf('id="app-recent-h"'), 'under Tasks');
      const recent = /<section class="app-recent[\s\S]*?<\/section>/.exec(side)![0];
      assert.match(recent, /<h2 id="app-recent-h">Recently edited pages<\/h2>/);
      const links = [...recent.matchAll(/<a href="\/builder\/apps\/(\d+)\/pages\/(\d+)">/g)].map((m) => Number(m[2]));
      assert.ok(links.length >= 2 && links.length <= 5, `${links.length} pages`);
      // yours come first (your newest change first), even before a newer change of someone else
      assert.equal(links[0], mine, `${mine} first in ${links}`);
      assert.ok(links.indexOf(other) === -1 || links.indexOf(other) > 0);
      if (links.includes(other)) assert.match(recent, /· sprint203-other/, 'another developer\'s change says who');
      // Copy application is a task
      assert.match(side, new RegExp(`<a href="/builder/apps/${appId}/copy">[\\s\\S]*?Copy application</a>`));
    } finally {
      await owner.query(`delete from meta.component_change where app_id = $1 and component = 'pages/x/page'`, [appId]);
    }
  });

  test('Copy application: a new application with the pages and shared components, in the same workspace, under a new name', async () => {
    const b = await login();
    const form = (await b.get(`/builder/apps/${appId}/copy`)).body;
    assert.match(form, /<form method="post" action="\/builder\/copy-app">/);
    assert.match(form, /name="name" value="[^"]+ \(copy\)"/);
    assert.match(form, /name="alias" value="[a-z][a-z0-9-]*"/, 'an alias that is free');
    const r = await b.submit('/builder/copy-app', { from: String(appId), name: 'Sprint 203 copy', alias: COPY });
    assert.equal(r.statusCode, 303);
    const copy = await owner.one(`select id, name, alias, meta.app_workspace(id) as ws from meta.app where alias = $1`, [COPY]);
    assert.ok(copy, 'copied');
    assert.equal(r.headers.location, `/builder/apps/${copy.id}`);
    assert.equal(copy.name, 'Sprint 203 copy');
    assert.equal(copy.ws, (await owner.one('select meta.app_workspace($1) as ws', [appId])).ws);
    const count = async (id: number) => owner.one(`select (select count(*) from meta.page where app_id = $1)::int as pages, (select count(*) from meta.lov where app_id = $1)::int as lovs`, [id]);
    assert.deepEqual(await count(copy.id), await count(appId));
    assert.ok(!(await owner.one('select 1 as ok from meta.working_copy where app_id = $1', [copy.id])), 'not a working copy');
    const home = (await b.get(`/builder/apps/${copy.id}`)).body;
    assert.match(home, /created as a copy of/);
    // the pages of the copy are its developer's (Pages report: Updated by)
    assert.ok(await owner.one(`select 1 as ok from meta.page_change where app_id = $1 and updated_by = 'admin'`, [copy.id]));
    // the alias is taken now: refused with a message, back on the form
    await b.get(`/builder/apps/${appId}/copy`);
    const again = await b.submit('/builder/copy-app', { from: String(appId), name: 'Again', alias: COPY });
    assert.equal(again.headers.location, `/builder/apps/${appId}/copy`);
    assert.match((await b.get(`/builder/apps/${appId}/copy`)).body, new RegExp(`The alias ${COPY} is taken`));
  });
});

describe('sprint 203 AX-7: Templates and Session State Protection', () => {
  test('Shared Components → User Interface has Templates, Security has Session State Protection (Expire bookmarks)', async () => {
    const b = await login();
    const body = (await b.get(`/builder/apps/${appId}/shared`)).body;
    const ui = /<section [^>]*aria-labelledby="sc-ui"[\s\S]*?<\/section>/.exec(body)![0];
    assert.match(ui, new RegExp(`<a href="/builder/apps/${appId}/templates">Templates</a>`));
    const sec = /<section [^>]*aria-labelledby="sc-security"[\s\S]*?<\/section>/.exec(body)![0];
    assert.match(sec, new RegExp(`<a href="/builder/apps/${appId}/settings\\?tab=errors#expire-bookmarks">Session State Protection</a>`));
    // the anchor exists on that tab
    assert.match((await b.get(`/builder/apps/${appId}/settings?tab=errors`)).body, /id="expire-bookmarks"/);
  });

  test('Templates lists page, region, button, label, report and list templates with where each is used', async () => {
    const b = await login();
    const res = await b.get(`/builder/apps/${appId}/templates`);
    assert.equal(res.statusCode, 200);
    for (const id of ['page-templates', 'region-templates', 'button-templates', 'label-templates', 'report-templates', 'list-templates'])
      assert.match(res.body, new RegExp(`id="${id}"`), id);
    for (const key of ['left_side_column', 'minimal', 'hero', 'tabs_container', 'flex_container', 'value_pairs', 'wizard_progress']) assert.match(res.body, new RegExp(`<code class="small">${key}</code>`), key);
    // a region with the hero template is listed under Hero, with a link to it in the Page Designer
    const hero = await owner.one(`select r.id, p.page_no from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and r.template = 'hero' limit 1`, [appId]);
    if (hero) {
      const row = /<code class="small">hero<\/code>[\s\S]*?<\/tr>/.exec(res.body)![0];
      assert.match(row, new RegExp(`href="/builder/apps/${appId}/pages/${hero.page_no}\\?c=region-${hero.id}"`));
    }
    const standard = /<code class="small">standard<\/code>[\s\S]*?<\/tr>/.exec(res.body)![0];
    assert.match(standard, /<details class="tpl-uses"><summary>\d+ components<\/summary>/, 'pages with the standard template');
    // Template Components and Theme Roller are linked; the counts of custom and built-in components
    assert.match(res.body, new RegExp(`href="/builder/apps/${appId}/shared\\?type=template_component"`));
    assert.match(res.body, new RegExp(`href="/builder/apps/${appId}/theme"`));
  });

  test('the builder\'s search finds Templates and Session State Protection of the application you are in', async () => {
    const b = await login();
    const find = async (q: string, app = String(appId)) => (JSON.parse((await b.get(`/builder/palette?format=json&q=${encodeURIComponent(q)}${app ? `&app=${app}` : ''}`)).body).results as { kind: string; label: string; href: string }[]);
    const t = await find('template');
    assert.ok(t.some((r) => r.href === `/builder/apps/${appId}/templates` && r.label === 'Templates' && r.kind === 'Shared component'), JSON.stringify(t.slice(0, 5)));
    assert.ok(t.some((r) => r.href === `/builder/apps/${appId}/shared?type=template_component`));
    const ss = await find('session state');
    assert.ok(ss.some((r) => r.href === `/builder/apps/${appId}/settings?tab=errors#expire-bookmarks`));
    // without the parameter (the header's field without JavaScript): the application opened last
    await b.get(`/builder/apps/${appId}`);
    assert.ok((await find('template', '')).some((r) => r.href === `/builder/apps/${appId}/templates`));
    // the results page without JavaScript links to it
    assert.match((await b.get(`/builder/palette?q=template&app=${appId}`)).body, new RegExp(`href="/builder/apps/${appId}/templates"`));
  });

  test('every template has a name and a description in every builder language', () => {
    for (const [lang] of BUILDER_LANGUAGES) {
      const own = builderMessages(lang);
      assert.deepEqual(TEMPLATE_KEYS.filter((k) => !own[k]), [], lang);
    }
  });
});
