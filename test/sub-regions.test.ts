// Sprint 195 (NX-F2, migration 172): sub regions. A region inside another region of its page (one level), shown
// as its parent's template says (tabs_container, flex_container, collapsible, any other on a grid); the parent's
// condition applies to it; built in the Page Designer (gallery, Sub regions slot, Move into, tree), kept by export
// and import (the pgkiln/2 document and the directory files), copy page, duplicate and undo; deleting a container
// moves its sub regions up; the APEX importer maps p_parent_plug_id; the Advisor checks containers; HR page 53.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { advise } from '../src/builder/advisor.ts';
import { COMPONENTS } from '../src/builder/components.ts';
import { CONTAINER_LABELS } from '../src/builder/arrange.ts';
import { docToFiles, filesToDoc } from '../src/appfiles.ts';
import { compareFiles } from '../src/cli/diff.ts';
import { apexToDoc } from '../src/apeximport.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
let pageId: number;
const alias = 'ts-s195';
const R: Record<string, number> = {};

const devLogin = async () => {
  const dev = new Browser(app);
  await dev.get('/builder/login');
  await dev.post('/builder/login', { __csrf: dev.lastCsrf, username: 'admin', password: 'admin' });
  return dev;
};
const region = async (page: number, title: string, o: { type?: string; template?: string; parent?: number; source?: string; columns?: number; condition_type?: string; static_id?: string } = {}) =>
  (await owner.one(`insert into meta.region (page_id, seq, title, type, source, template, parent_id, columns, condition_type, static_id)
                    values ($1, (select coalesce(max(seq), 0) + 10 from meta.region where page_id = $1), $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [page, title, o.type ?? 'static', o.source ?? `<p>${title} text</p>`, o.template ?? 'standard', o.parent ?? null, o.columns ?? 12, o.condition_type ?? null, o.static_id ?? null])).id as number;
const parents = async (app: number, page = 1) =>
  Object.fromEntries((await owner.query(`select r.title, p2.title as parent from meta.region r join meta.page pg on pg.id = r.page_id
                                          left join meta.region p2 on p2.id = r.parent_id where pg.app_id = $1 and pg.page_no = $2`, [app, page])).rows.map((r) => [r.title, r.parent]));

before(async () => {
  app = await buildApp({ logger: false });
  await owner.query(`delete from meta.app where alias like 'ts-s195%'`);
  appId = (await owner.one(`insert into meta.app (alias, name, authentication, db_role) values ($1, 'Sub regions test', 'none', 'hr_app') returning id`, [alias])).id;
  pageId = (await owner.one(`insert into meta.page (app_id, page_no, name, title, requires_auth) values ($1, 1, 'Home', 'Home', false) returning id`, [appId])).id;
  R.tabs = await region(pageId, 'Tabs', { template: 'tabs_container', source: '', static_id: 'tabs' });
  R.alpha = await region(pageId, 'Alpha', { template: 'plain', parent: R.tabs });
  R.beta = await region(pageId, 'Beta', { parent: R.tabs, type: 'report', source: `select n from generate_series(1, 3) n` });
  R.never = await region(pageId, 'Never', { template: 'plain', parent: R.tabs, condition_type: 'never' });
  R.flex = await region(pageId, 'Flex', { template: 'flex_container', source: '' });
  R.f1 = await region(pageId, 'Flex one', { parent: R.flex });
  R.f2 = await region(pageId, 'Flex two', { parent: R.flex });
  R.grid = await region(pageId, 'Grid', { source: '<p>Own content</p>' });
  R.g1 = await region(pageId, 'Grid one', { parent: R.grid, columns: 6 });
  R.echo = await region(pageId, 'Echo', { source: '<p>[secret:&P1_SECRET.][open:&P1_OPEN.]</p>' });
  R.hidden = await region(pageId, 'Hidden', { condition_type: 'never' });
  R.h1 = await region(pageId, 'Hidden child', { parent: R.hidden });
  await owner.query(`insert into meta.item (page_id, region_id, seq, name, label, type) values ($1, $2, 10, 'P1_SECRET', 'Secret', 'text'), ($1, $3, 10, 'P1_OPEN', 'Open', 'text')`, [pageId, R.h1, R.alpha]);
  await owner.query(`insert into meta.button (page_id, region_id, seq, name, label, action) values ($1, $2, 10, 'HIDDEN_GO', 'Go', 'submit'), ($1, $3, 10, 'NEXT_STEP', 'Next', 'submit')`, [pageId, R.h1, R.alpha]);
  await owner.query(`update meta.button set slot = 'next' where page_id = $1 and name = 'NEXT_STEP'`, [pageId]);
  await owner.query(`insert into meta.dynamic_action (page_id, seq, name, event, trigger_element, action, affected_region_id) values ($1, 10, 'Refresh beta', 'click', 'NEXT_STEP', 'refresh_region', $2), ($1, 20, 'Refresh hidden', 'click', 'NEXT_STEP', 'refresh_region', $3)`, [pageId, R.beta, R.h1]);
});

after(async () => {
  await owner.query(`delete from meta.app where alias like 'ts-s195%'`);
  await app.close();
  await closePools();
});

describe('the data model (migration 172)', () => {
  test('a parent on the same page, one level deep; containers and sub regions refuse more', async () => {
    const other = (await owner.one(`insert into meta.page (app_id, page_no, name) values ($1, 9, 'Other') returning id`, [appId])).id;
    try {
      const elsewhere = await region(other, 'Elsewhere');
      await assert.rejects(owner.query('update meta.region set parent_id = $1 where id = $2', [R.tabs, elsewhere]), /parent region of "Elsewhere" is on another page/);
      await assert.rejects(owner.query('update meta.region set parent_id = $1 where id = $2', [R.alpha, R.grid]), /is a sub region itself/);
      await assert.rejects(owner.query('update meta.region set parent_id = $1 where id = $2', [R.flex, R.tabs]), /has sub regions, so it cannot go inside another region/);
      await assert.rejects(owner.query('update meta.region set parent_id = id where id = $1', [R.hidden]), /region_parent_not_self/);
      await assert.rejects(owner.query('update meta.region set page_id = $1 where id = $2', [other, R.alpha]), /on another page/);
      await assert.rejects(owner.query(`update meta.region set template = 'tabs' where id = $1`, [R.grid]), /region_template_check/);
    } finally {
      await owner.query('delete from meta.page where id = $1', [other]);
    }
    assert.equal((await parents(appId)).Alpha, 'Tabs', 'nothing changed');
  });
});

describe('the runtime', () => {
  test('a tabs container: a tab per shown sub region, panels with the regions; flex and grid containers; no sub region at page level', async () => {
    const res = await new Browser(app).get(`/a/${alias}/1`);
    assert.equal(res.statusCode, 200);
    const b = res.body;
    const tabs = new RegExp(`<div class="region-tabs" data-region-tabs="${R.tabs}">([\\s\\S]*?)</div>\\s*</div>\\s*</section>`).exec(b)?.[1] ?? '';
    assert.match(tabs, new RegExp(`<a class="region-tab" id="R${R.tabs}_tab${R.alpha}" href="#R${R.alpha}" data-tab-panel="R${R.tabs}_panel${R.alpha}">Alpha</a>`));
    assert.match(tabs, new RegExp(`href="#R${R.beta}"[^>]*>Beta</a>`));
    assert.doesNotMatch(b, new RegExp(`id="R${R.never}"|>Never<`), 'a sub region its condition leaves out has no tab');
    // the plain sub region gets a heading for the page without JavaScript (the standard one has its own)
    assert.match(b, new RegExp(`<div class="region-tabpanel" id="R${R.tabs}_panel${R.alpha}"><h3 class="region-tabpanel-title">Alpha</h3><section class="region region-static region-plain`));
    assert.match(b, new RegExp(`<div class="region-tabpanel" id="R${R.tabs}_panel${R.beta}"><section class="region region-report region-standard`));
    // the sub region is inside its container, not again at page level
    const container = b.indexOf(`id="R${R.tabs}"`);
    assert.ok(container > 0 && b.indexOf(`id="R${R.alpha}"`) > container && b.indexOf(`id="R${R.alpha}"`) < b.indexOf(`id="R${R.flex}"`));
    assert.equal(b.split(`id="R${R.alpha}"`).length, 2, 'rendered once');
    // Next in the sub region's own bottom bar
    assert.match(b, new RegExp(`id="R${R.alpha}"[\\s\\S]*?<div class="region-footer-end"><div class="buttons"><button type="submit"[^>]*data-button="NEXT_STEP"`));
    assert.match(b, new RegExp(`id="R${R.flex}"[\\s\\S]*?<div class="region-children region-flex">\\s*<section class="region region-static region-standard col-12" id="R${R.f1}"`));
    assert.match(b, new RegExp(`id="R${R.grid}"[\\s\\S]*?<p>Own content</p><div class="t-regions region-children"><section class="region region-static region-standard col-6" id="R${R.g1}"`));
    assert.match(b, /<section class="region region-static region-flex_container col-12"/, 'a flexbox container has no frame');
  });

  test("the parent's condition applies to its sub regions: their items, buttons and refreshes too", async () => {
    const user = new Browser(app);
    const res = await user.get(`/a/${alias}/1`);
    assert.doesNotMatch(res.body, /Hidden child|name="P1_SECRET"|HIDDEN_GO/);
    // a button of a hidden sub region cannot be pressed, its item cannot be set
    assert.equal((await user.submit(`/a/${alias}/1`, { __request: 'HIDDEN_GO' })).statusCode, 403);
    await user.get(`/a/${alias}/1`);
    await user.submit(`/a/${alias}/1`, { __request: 'NEXT_STEP', P1_SECRET: 'forged', P1_OPEN: 'fine' });
    const echo = (await user.get(`/a/${alias}/1`)).body;
    assert.match(echo, /\[secret:(&P1_SECRET\.)?\]\[open:fine\]/, 'the visible sub region\'s item is set, the hidden one\'s is not');
    // the region route refuses it as it refuses a hidden region
    assert.equal((await user.get(`/a/${alias}/1/region/${R.h1}`)).statusCode, 403);
    // a partial refresh of a sub region: only that region's markup; the hidden one renders nothing
    await user.get(`/a/${alias}/1`);
    const da = async (name: string) => (await owner.one('select id from meta.dynamic_action where page_id = $1 and name = $2', [pageId, name])).id;
    const ok = await user.post(`/a/${alias}/1/da/${await da('Refresh beta')}`, { __csrf: user.lastCsrf });
    assert.equal(ok.statusCode, 200);
    const out = JSON.parse(ok.body);
    assert.match(out.regions[R.beta], new RegExp(`^<section class="region region-report region-standard col-12" id="R${R.beta}"`));
    assert.doesNotMatch(out.regions[R.beta], /region-tabpanel/, 'the panel around it stays on the page');
    const hidden = JSON.parse((await user.post(`/a/${alias}/1/da/${await da('Refresh hidden')}`, { __csrf: user.lastCsrf })).body);
    assert.equal(hidden.regions[R.h1], '');
  });

  test("a container left out by its build option takes its sub regions along", async () => {
    await owner.query(`insert into meta.build_option (app_id, name, status) values ($1, 'S195_OFF', 'exclude') on conflict do nothing`, [appId]);
    await owner.query(`update meta.region set build_option = 'S195_OFF' where id = $1`, [R.flex]);
    try {
      const b = (await new Browser(app).get(`/a/${alias}/1`)).body;
      assert.doesNotMatch(b, /Flex one|Flex two/);
    } finally {
      await owner.query(`update meta.region set build_option = null where id = $1`, [R.flex]);
    }
  });
});

describe('export, import, files, copy page', () => {
  test('meta.export_app / import_app keep the parents (new ids)', async () => {
    const doc = (await owner.one('select meta.export_app($1) as doc', [alias])).doc;
    const alpha = doc.pages[0].regions.find((r: any) => r.title === 'Alpha');
    assert.equal(alpha.parent_id, R.tabs);
    const id = (await owner.one(`select meta.import_app($1::jsonb, 'ts-s195-copy') as id`, [JSON.stringify(doc)])).id;
    assert.deepEqual(await parents(id), await parents(appId));
    assert.equal((await owner.one(`select count(*)::int as n from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and r.parent_id in
      (select r2.id from meta.region r2 join meta.page p2 on p2.id = r2.page_id where p2.app_id = $2)`, [id, appId])).n, 0, 'no parent points into the old application');
    // a parent missing from the document leaves the region at page level
    const broken = structuredClone(doc);
    broken.pages[0].regions.find((r: any) => r.title === 'Flex one').parent_id = 999999999;
    const b = (await owner.one(`select meta.import_app($1::jsonb, 'ts-s195-broken') as id`, [JSON.stringify(broken)])).id;
    assert.equal((await parents(b))['Flex one'], null);
  });

  test('the directory files name the parent by static id; files → document → files is lossless; diff shows a changed parent', async () => {
    const doc = (await owner.one('select meta.export_app($1) as doc', [alias])).doc;
    const files = docToFiles(doc, 'text');
    const alphaFile = [...files.keys()].find((p) => /regions\/\d+-alpha\.yaml$/.test(p))!;
    assert.match(files.get(alphaFile)!.toString(), /^parent: tabs$/m);
    const tabsFile = [...files.keys()].find((p) => /regions\/\d+-tabs\.yaml$/.test(p))!;
    assert.doesNotMatch(files.get(tabsFile)!.toString(), /^parent:/m, 'a region at page level has no parent line');
    assert.doesNotMatch(files.get(alphaFile)!.toString(), /parent_id/);
    const back = filesToDoc(files);
    const byTitle = (d: any, t: string) => d.pages[0].regions.find((r: any) => r.title === t);
    assert.equal(byTitle(back, 'Alpha').parent_id, byTitle(back, 'Tabs').id);
    assert.equal(byTitle(back, 'Tabs').parent_id, null);
    assert.deepEqual(compareFiles(files, docToFiles(back, 'text')), []);
    // importing the files' document keeps the tree
    const id = (await owner.one(`select meta.import_app($1::jsonb, 'ts-s195-files') as id`, [JSON.stringify(back)])).id;
    assert.deepEqual(await parents(id), await parents(appId));
    // a file whose parent changed: diff_app reports it; an unknown parent is refused when read
    const moved = new Map(files);
    moved.set(alphaFile, Buffer.from(files.get(alphaFile)!.toString().replace(/^parent: tabs$/m, 'parent: flex')));
    assert.deepEqual(compareFiles(files, moved), [{ path: alphaFile, status: 'M' }]);
    moved.set(alphaFile, Buffer.from(files.get(alphaFile)!.toString().replace(/^parent: tabs$/m, 'parent: no-such-region')));
    assert.throws(() => filesToDoc(moved), /no region "no-such-region" on this page/);
  });

  test('meta.copy_page copies the tree onto the new page', async () => {
    await owner.query('select meta.copy_page($1, 1, $1, 7)', [appId]);
    try {
      assert.deepEqual(await parents(appId, 7), await parents(appId, 1));
      assert.equal((await owner.one(`select count(*)::int as n from meta.region c join meta.region p on p.id = c.parent_id where c.page_id <> p.page_id`)).n, 0);
    } finally {
      await owner.query('delete from meta.page where app_id = $1 and page_no = 7', [appId]);
    }
  });
});

describe('the Page Designer', () => {
  let pid: number;
  const ids = async () => Object.fromEntries((await owner.query('select title, id from meta.region where page_id = $1', [pid])).rows.map((r) => [r.title, r.id]));
  before(async () => {
    pid = (await owner.one(`insert into meta.page (app_id, page_no, name) values ($1, 2, 'Built') returning id`, [appId])).id;
  });

  test('gallery containers, the Sub regions slot, the tree and the property editor', async () => {
    const dev = await devLogin();
    const page = await dev.get(`/builder/apps/${appId}/pages/1`);
    assert.equal(page.statusCode, 200);
    for (const [t, name] of Object.entries(CONTAINER_LABELS)) assert.match(page.body, new RegExp(`data-new="region" data-type="${t}"[^>]*>[\\s\\S]{0,300}?<span>${name[0]}</span>`));
    assert.match(page.body, new RegExp(`<div class="pd-grid pd-subgrid" data-drop="region" data-position="body" data-parent="${R.tabs}">`));
    assert.match(page.body, /<span class="pd-label">Sub regions<\/span>/, 'a branch in the tree');
    assert.match(page.body, new RegExp(`data-kind="region" data-id="${R.alpha}" data-position="" data-parent="${R.tabs}" data-next="${R.beta}"`));
    assert.match(page.body, new RegExp(`data-kind="region" data-id="${R.tabs}" data-position="" data-parent="" data-container`));
    assert.doesNotMatch(page.body, new RegExp(`data-drop="region"[^>]*data-parent="${R.alpha}"`), 'a sub region has no slot of its own');
    assert.ok(COMPONENTS.region.fields.some((f) => f.name === 'parent_id' && f.kind === 'region'));
    assert.ok(COMPONENTS.region.fields.find((f) => f.name === 'template')!.options!.includes('tabs_container'));
    // a sub region's Parent region offers regions at page level, not itself nor other sub regions
    const props = await dev.get(`/builder/apps/${appId}/pages/1?c=region-${R.alpha}`);
    const select = /<select id="f_region_parent_id" name="parent_id">([\s\S]*?)<\/select>/.exec(props.body)?.[1] ?? '';
    assert.match(select, new RegExp(`<option value="${R.tabs}" selected>Tabs \\(static\\)</option>`));
    assert.doesNotMatch(select, new RegExp(`value="${R.alpha}"|value="${R.beta}"`));
    // the create form from the slot's link: the parent is set
    const create = await dev.get(`/builder/apps/${appId}/pages/1?new=region&parent=${R.flex}`);
    assert.match(/<select id="f_region_parent_id" name="parent_id">([\s\S]*?)<\/select>/.exec(create.body)?.[1] ?? '', new RegExp(`<option value="${R.flex}" selected>`));
  });

  test('a tabs container with a report and a form, built by the layout, survives export and import', async () => {
    const dev = await devLogin();
    await dev.get(`/builder/apps/${appId}/pages/2`);
    const layout = (op: string, form: Record<string, string>) => dev.request('POST', `/builder/pages/${pid}/layout/${op}`, { __csrf: dev.lastCsrf, ...form });
    assert.equal((await layout('create', { kind: 'region', type: 'tabs_container', position: '' })).statusCode, 303);
    const tabs = (await ids())['Tabs Container'];
    const t = await owner.one('select type, template from meta.region where id = $1', [tabs]);
    assert.deepEqual(t, { type: 'static', template: 'tabs_container' });
    assert.equal((await layout('create', { kind: 'region', type: 'report', parent: String(tabs) })).statusCode, 303);
    assert.equal((await layout('create', { kind: 'region', type: 'form', parent: String(tabs) })).statusCode, 303);
    const x = await ids();
    const kids = (await owner.query('select title, template, parent_id, seq from meta.region where page_id = $1 and parent_id is not null order by seq', [pid])).rows;
    assert.deepEqual(kids.map((k) => [k.title, k.template, k.parent_id]), [['New interactive report', 'plain', tabs], ['New form', 'plain', tabs]]);
    // the page renders them as tabs
    const run = await new Browser(app).get(`/a/${alias}/2`);
    assert.match(run.body, new RegExp(`data-region-tabs="${tabs}"[\\s\\S]*?>New interactive report</a>[\\s\\S]*?>New form</a>`));
    // and the export keeps them, through the files too
    const doc = (await owner.one('select meta.export_app($1) as doc', [alias])).doc;
    const back = filesToDoc(docToFiles(doc, 'text'));
    const id = (await owner.one(`select meta.import_app($1::jsonb, 'ts-s195-built') as id`, [JSON.stringify(back)])).id;
    assert.deepEqual(await parents(id, 2), { 'Tabs Container': null, 'New interactive report': 'Tabs Container', 'New form': 'Tabs Container' });
    void x;
  });

  test('move into, out of and within a container; one level; undo; duplicate; delete moves sub regions up', async () => {
    const dev = await devLogin();
    await dev.get(`/builder/apps/${appId}/pages/2`);
    const layout = (op: string, form: Record<string, string>) => dev.request('POST', `/builder/pages/${pid}/layout/${op}`, { __csrf: dev.lastCsrf, ...form });
    let x = await ids();
    const tabs = x['Tabs Container'];
    // a region at page level goes into the container, before the form
    await layout('create', { kind: 'region', type: 'static', position: 'left' });
    x = await ids();
    const loose = x['New static content'];
    assert.equal((await layout('move', { kind: 'region', id: String(loose), parent: String(tabs), before: String(x['New form']), position: '' })).statusCode, 303);
    let kids = (await owner.query('select title, position from meta.region where parent_id = $1 order by seq', [tabs])).rows;
    assert.deepEqual(kids.map((k) => k.title), ['New interactive report', 'New static content', 'New form']);
    assert.ok(kids.every((k) => k.position === null), 'a sub region takes its container\'s position');
    // Alt+↑ within the container
    await layout('move', { kind: 'region', id: String(loose), dir: 'up' });
    kids = (await owner.query('select title from meta.region where parent_id = $1 order by seq', [tabs])).rows;
    assert.equal(kids[0].title, 'New static content');
    // undo puts it back at page level, in the left column
    await layout('undo', {});
    await layout('undo', {});
    assert.deepEqual(await owner.one('select parent_id, position from meta.region where id = $1', [loose]), { parent_id: null, position: 'left' });
    await layout('redo', {});
    assert.equal((await owner.one('select parent_id from meta.region where id = $1', [loose])).parent_id, tabs);
    // one level: not into a sub region, a container not into a region, not into itself
    for (const [id, parent, msg] of [[loose, x['New form'], /nest one level deep/], [tabs, loose, /nest one level deep/], [tabs, tabs, /nest one level deep/]] as const) {
      const res = await dev.request('POST', `/builder/pages/${pid}/layout/move`, { __csrf: dev.lastCsrf, kind: 'region', id: String(id), parent: String(parent) });
      assert.equal(res.statusCode, 400);
      assert.match(res.body, msg);
    }
    // the container moves to the footer with its sub regions
    await layout('move', { kind: 'region', id: String(tabs), position: 'footer', parent: '' });
    assert.deepEqual((await owner.query('select distinct position from meta.region where page_id = $1', [pid])).rows, [{ position: 'footer' }]);
    await layout('move', { kind: 'region', id: String(tabs), position: '', parent: '' });
    // out again, to the page
    await layout('move', { kind: 'region', id: String(loose), parent: '', position: '' });
    assert.equal((await owner.one('select parent_id from meta.region where id = $1', [loose])).parent_id, null);
    await owner.query('delete from meta.region where id = $1', [loose]);
    // duplicate: the container with copies of its sub regions; a duplicated sub region stays in its container
    await layout('duplicate', { kind: 'region', id: String(tabs) });
    const copies = (await owner.query(`select id from meta.region where page_id = $1 and title = 'Tabs Container' and id <> $2`, [pid, tabs])).rows;
    assert.equal(copies.length, 1);
    assert.equal((await owner.one('select count(*)::int as n from meta.region where parent_id = $1', [copies[0].id])).n, 2);
    await layout('duplicate', { kind: 'region', id: String((await owner.one(`select id from meta.region where parent_id = $1 and title = 'New form'`, [tabs])).id) });
    assert.equal((await owner.one(`select count(*)::int as n from meta.region where parent_id = $1 and title = 'New form'`, [tabs])).n, 2);
    // copy to another page: the container with its sub regions
    const res = await dev.request('POST', `/builder/pages/${pid}/layout/copy`, { __csrf: dev.lastCsrf, kind: 'region', id: String(tabs), page: String(pageId) });
    assert.equal(res.statusCode, 303);
    const copied = (await owner.one(`select id from meta.region where page_id = $1 and title = 'Tabs Container'`, [pageId])).id;
    assert.equal((await owner.one('select count(*)::int as n from meta.region where parent_id = $1 and page_id = $2', [copied, pageId])).n, 3);
    await owner.query('delete from meta.region where parent_id = $1 or id = $1', [copied]);
    // delete the copy: its sub regions move up to the page, where it was
    const before = (await owner.query(`select id from meta.region where page_id = $1 and parent_id is null order by seq, id`, [pid])).rows.map((r) => r.id);
    const kidsOfCopy = (await owner.query('select id from meta.region where parent_id = $1 order by seq, id', [copies[0].id])).rows.map((r) => r.id);
    const del = await dev.request('POST', `/builder/pages/${pid}/c/region/${copies[0].id}/delete`, { __csrf: dev.lastCsrf });
    assert.equal(del.statusCode, 303);
    const after = (await owner.query(`select id, parent_id from meta.region where page_id = $1 and parent_id is null order by seq, id`, [pid])).rows.map((r) => r.id);
    assert.deepEqual(after, before.flatMap((id) => (id === copies[0].id ? kidsOfCopy : [id])));
    // a delete by SQL leaves them at page level too (on delete set null)
    const sqlKids = (await owner.query('select id from meta.region where parent_id = $1', [tabs])).rows.length;
    await owner.query('delete from meta.region where id = $1', [tabs]);
    assert.equal((await owner.one('select count(*)::int as n from meta.region where page_id = $1 and parent_id is null', [pid])).n, after.length - 1 + sqlKids);
  });

  test('the property editor refuses a parent on another page and a second level', async () => {
    const dev = await devLogin();
    const p2 = await region(pid, 'Container two', { template: 'flex_container' });
    const child = await region(pid, 'Child two', { parent: p2 });
    await dev.get(`/builder/apps/${appId}/pages/2?c=region-${child}`);
    const save = async (parent: number) => {
      const r = await dev.request('POST', `/builder/pages/${pid}/c/region/${child}`, { __csrf: dev.lastCsrf, title: 'Child two', type: 'static', template: 'standard', seq: '10', columns: '12', parent_id: String(parent), config: '{}' });
      return { status: r.statusCode, flash: (await dev.get(String(r.headers.location))).body };
    };
    assert.match((await save(R.tabs)).flash, /Parent region: that region is not on this page/);
    const third = await region(pid, 'Grandchild');
    await dev.get(`/builder/apps/${appId}/pages/2?c=region-${third}`);
    const r = await dev.request('POST', `/builder/pages/${pid}/c/region/${third}`, { __csrf: dev.lastCsrf, title: 'Grandchild', type: 'static', template: 'standard', seq: '10', columns: '12', parent_id: String(child), config: '{}' });
    const flash = (await dev.get(String(r.headers.location))).body;
    assert.match(flash, /is a sub region itself/);
    assert.equal((await owner.one('select parent_id from meta.region where id = $1', [third])).parent_id, null);
  });
});

describe('the Advisor', () => {
  test('an empty tabs or flexbox container and an untitled tab', async () => {
    const empty = await region(pageId, 'Empty tabs', { template: 'tabs_container', source: '' });
    const untitled = (await owner.one(`insert into meta.region (page_id, seq, type, template, parent_id, source) values ($1, 999, 'static', 'plain', $2, '<p>x</p>') returning id`, [pageId, R.tabs])).id;
    try {
      const { findings } = await advise(appId);
      const of = (id: number) => findings.filter((f: any) => f.entry?.id === id || f.entry?.key === `region-${id}`).map((f: any) => `${f.severity} ${f.field}: ${f.message}`);
      assert.ok(of(empty).some((m) => /^warning Template: A tabs_container shows its sub regions, and this region has none/.test(m)), of(empty).join('\n'));
      assert.ok(of(untitled).some((m) => /^warning Title: A sub region of a tabs container has no title/.test(m)), of(untitled).join('\n'));
      assert.deepEqual(of(R.tabs).filter((m) => /sub region/.test(m)), [], 'a container with sub regions is fine');
    } finally {
      await owner.query('delete from meta.region where id = any($1)', [[empty, untitled]]);
    }
  });
});

describe('the APEX importer', () => {
  const plug = (id: number, name: string, extra = '') => `wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(${id})
,p_plug_name=>'${name}'
,p_plug_display_sequence=>${id % 100}
${extra});
`;
  const source = `prompt --application/create_application
begin
wwv_imp_workspace.create_flow(
 p_id=>wwv_flow.g_flow_id
,p_name=>'Nested'
,p_alias=>'NESTED'
);
end;
/
begin
wwv_flow_imp_page.create_page(
 p_id=>1
,p_name=>'Home'
);
${plug(1010, 'Tabs', ",p_region_template_options=>'#DEFAULT#:t-TabsRegion-mod--simple'")}
${plug(1020, 'First tab', ',p_parent_plug_id=>wwv_flow_imp.id(1010)')}
${plug(1030, 'Second tab', ',p_parent_plug_id=>wwv_flow_imp.id(1010)')}
${plug(1040, 'Deep', ',p_parent_plug_id=>wwv_flow_imp.id(1030)')}
${plug(1050, 'Folded', ",p_region_template_options=>'#DEFAULT#:is-collapsed'")}
${plug(1060, 'Orphan', ',p_parent_plug_id=>wwv_flow_imp.id(424242)')}
end;
/
`;
  test('p_parent_plug_id becomes the parent; deeper regions go into the top-most ancestor, with a note; tabs and collapsible templates', async () => {
    const { doc, report } = apexToDoc(source) as { doc: any; report: any };
    const regions = doc.pages[0].regions;
    const byName = (n: string) => regions.find((r: any) => r.title === n);
    assert.equal(byName('First tab').parent_id, byName('Tabs').id);
    assert.equal(byName('Second tab').parent_id, byName('Tabs').id);
    assert.equal(byName('Deep').parent_id, byName('Tabs').id, 'one level: the top-most ancestor');
    assert.equal(byName('Orphan').parent_id, undefined);
    assert.equal(byName('Tabs').template, 'tabs_container');
    assert.equal(byName('Folded').template, 'collapsible');
    const notes = report.entries.filter((e: any) => e.kind === 'region').flatMap((e: any) => e.notes ?? []);
    assert.ok(notes.some((n: string) => /nested 2 levels deep in APEX: pgkiln nests one level, so it is a sub region of "Tabs"/.test(n)), notes.join('\n'));
    assert.ok(!notes.some((n: string) => /places it on the page after its parent/.test(n)), 'no longer flattened');
    // and it imports
    const id = (await owner.one(`select meta.import_app($1::jsonb, 'ts-s195-apex') as id`, [JSON.stringify({ ...doc, app: { ...doc.app, db_role: 'hr_app' } })])).id;
    assert.deepEqual(await parents(id), { Tabs: null, 'First tab': 'Tabs', 'Second tab': 'Tabs', Deep: 'Tabs', Folded: null, Orphan: null });
  });
});

describe('HR page 53 (the sample)', () => {
  test('a tabs container, a flexbox container and a collapsible with sub regions', async () => {
    const hr = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
    const p = await parents(hr, 53);
    assert.equal(p.Employees, 'Department');
    assert.equal(p['Edit department'], 'Department');
    assert.equal(p.Headcount, 'Key figures');
    assert.equal(p['How it is built'], 'About this page');
    assert.deepEqual((await owner.query(`select distinct r.template from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 53 and r.parent_id is null order by 1`, [hr])).rows.map((r) => r.template),
      ['collapsible', 'flex_container', 'plain', 'tabs_container']);
  });
});
