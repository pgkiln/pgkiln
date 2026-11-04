// Sprint 140 (AP-4, migration 140): the item types shuttle, select_one and select_many, the region types
// classic_report, breadcrumb and help_text (with the page's help text), in the gallery, at runtime, in
// exports, the Advisor and HR page 50.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { advise } from '../src/builder/advisor.ts';
import { regionConfigHelp } from '../src/builder/region-help.ts';
import { COMPONENTS } from '../src/builder/components.ts';
import { ITEM_LABELS, REGION_LABELS } from '../src/builder/arrange.ts';
import { LOV_CHECKED, MULTI_VALUE } from '../src/runtime/items.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
let pageId: number;
let hrId: number;
const alias = 'ts-s140';
const rid: Record<string, number> = {};

const devLogin = async () => {
  const dev = new Browser(app);
  await dev.get('/builder/login');
  await dev.post('/builder/login', { __csrf: dev.lastCsrf, username: 'admin', password: 'admin' });
  return dev;
};
const region = async (page: number, title: string, type: string, source: string | null, config: object = {}, extra: { position?: string; template?: string } = {}) =>
  (await owner.one(`insert into meta.region (page_id, seq, title, type, source, config, position, template) values ($1, (select coalesce(max(seq), 0) + 10 from meta.region where page_id = $1), $2, $3, $4, $5, $6, $7) returning id`,
    [page, title, type, source, JSON.stringify(config), extra.position ?? null, extra.template ?? 'standard'])).id as number;
const sectionOf = (body: string, id: number) => {
  const m = new RegExp(`<section[^>]* id="R${id}"[\\s\\S]*?</section>`).exec(body);
  assert.ok(m, `region ${id} is on the page`);
  return m[0];
};

before(async () => {
  app = await buildApp({ logger: false });
  hrId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  await owner.query('delete from meta.app where alias = $1', [alias]);
  appId = (await owner.one(`insert into meta.app (alias, name, authentication) values ($1, 'Types test', 'none') returning id`, [alias])).id;
  const home = (await owner.one(`insert into meta.page (app_id, page_no, name, title, requires_auth) values ($1, 1, 'Home', 'Home', false) returning id`, [appId])).id;
  pageId = (await owner.one(`insert into meta.page (app_id, page_no, name, title, requires_auth, parent_page, help) values ($1, 2, 'Picks', 'Picks', false, 1, $2) returning id`,
    [appId, 'Some **help** for &P2_ONE..\n\n- one\n- two'])).id;
  void home;
  const form = await region(pageId, 'Form', 'static', '');
  await owner.query(`insert into meta.item (page_id, region_id, seq, name, label, type, lov, required) values
    ($1, $2, 10, 'P2_SHUTTLE', 'Shuttle', 'shuttle', 'STATIC:Alpha;A,Beta;B,Gamma;G,Delta;D', false),
    ($1, $2, 20, 'P2_ONE', 'One', 'select_one', 'STATIC:Red;R,Green;G,Blue;B', false),
    ($1, $2, 30, 'P2_MANY', 'Many', 'select_many', 'STATIC:Red;R,Green;G,Blue;B', true),
    ($1, $2, 40, 'P2_SHOWN', 'Shown', 'shuttle', 'STATIC:Alpha;A,Beta;B,Gamma;G', false)`, [pageId, form]);
  await owner.query(`update meta.item set readonly_condition = 'true' where page_id = $1 and name = 'P2_SHOWN'`, [pageId]);
  await owner.query(`insert into meta.button (page_id, region_id, seq, name, label, action) values ($1, $2, 10, 'SAVE', 'Save', 'submit')`, [pageId, form]);
  rid.crumb = await region(pageId, 'Trail', 'breadcrumb', null, {}, { position: 'breadcrumb', template: 'plain' });
  rid.help = await region(pageId, 'Help', 'help_text', null);
  rid.classic = await region(pageId, 'Numbers', 'classic_report', `select n, 'Row ' || n as label from generate_series(1, 40) n`, { page_size: 15 });
  rid.range = await region(pageId, 'Range', 'classic_report', `select n from generate_series(1, 40) n`, { page_size: 10, pagination: 'range' });
  rid.none = await region(pageId, 'All', 'classic_report', `select n from generate_series(1, 40) n`, { pagination: 'none', sortable: false });
  rid.pairs = await region(pageId, 'Pairs', 'classic_report', `select 'Ann' as name, 'Sales' as dept`, { report_template: 'value_pairs', headings: { dept: 'Department' } });
  rid.media = await region(pageId, 'Media', 'classic_report', `select 'First' as title, 'The first one' as description`, { report_template: 'media_list' });
  rid.search = await region(pageId, 'Searchable', 'classic_report', `select n from generate_series(1, 40) n`, { searchable: true });
});

after(async () => {
  await owner.query(`delete from meta.app where alias in ($1, 'ts-s140-copy')`, [alias]);
  await app.close();
  await closePools();
});

describe('the gallery and the property editor', () => {
  test('the Page Designer offers the six new types, with labels and icons', async () => {
    const dev = await devLogin();
    const res = await dev.get(`/builder/apps/${appId}/pages/2`);
    assert.equal(res.statusCode, 200);
    for (const [k, t, name] of [['item', 'shuttle', 'Shuttle'], ['item', 'select_one', 'Select One'], ['item', 'select_many', 'Select Many'],
      ['region', 'classic_report', 'Classic Report'], ['region', 'breadcrumb', 'Breadcrumb'], ['region', 'help_text', 'Help Text']])
      assert.match(res.body, new RegExp(`data-new="${k}" data-type="${t}"[^>]*>[\\s\\S]{0,400}?<span>${name}</span>`), `${t} in the gallery`);
    for (const t of ['shuttle', 'select_one', 'select_many']) assert.ok(ITEM_LABELS[t], t);
    for (const t of ['classic_report', 'breadcrumb', 'help_text']) assert.ok(REGION_LABELS[t], t);
    // the types in the property editor's Type list
    const itemTypes = COMPONENTS.item.fields.find((f) => f.name === 'type')!.options!;
    const regionTypes = COMPONENTS.region.fields.find((f) => f.name === 'type')!.options!;
    for (const t of ['shuttle', 'select_one', 'select_many']) assert.ok(itemTypes.includes(t), t);
    for (const t of ['classic_report', 'breadcrumb', 'help_text']) assert.ok(regionTypes.includes(t), t);
    // the page's help text in the page properties
    assert.match(res.body, /<textarea id="f_help" name="help"[^>]*>Some \*\*help\*\*/);
  });

  test('every new type is accepted by the database, and a breadcrumb from the gallery goes to the breadcrumb bar', async () => {
    const dev = await devLogin();
    await dev.get(`/builder/apps/${appId}/pages/1`);
    const home = (await owner.one(`select id from meta.page where app_id = $1 and page_no = 1`, [appId])).id;
    const res = await dev.post(`/builder/pages/${home}/layout/create`, { __csrf: dev.lastCsrf, kind: 'region', type: 'breadcrumb' });
    assert.equal(res.statusCode, 303, res.body);
    const r = await owner.one(`select position, template, title from meta.region where page_id = $1 and type = 'breadcrumb'`, [home]);
    assert.deepEqual(r, { position: 'breadcrumb', template: 'plain', title: 'Breadcrumb' });
    for (const type of ['classic_report', 'help_text']) {
      await dev.get(`/builder/apps/${appId}/pages/1`);
      assert.equal((await dev.post(`/builder/pages/${home}/layout/create`, { __csrf: dev.lastCsrf, kind: 'region', type })).statusCode, 303);
    }
    const formRegion = (await owner.one(`select id from meta.region where page_id = $1 and type = 'classic_report'`, [home])).id;
    for (const type of ['shuttle', 'select_one', 'select_many']) {
      await dev.get(`/builder/apps/${appId}/pages/1`);
      assert.equal((await dev.post(`/builder/pages/${home}/layout/create`, { __csrf: dev.lastCsrf, kind: 'item', type, region: String(formRegion) })).statusCode, 303, type);
    }
    assert.equal((await owner.one(`select count(*)::int as n from meta.item where page_id = $1 and type in ('shuttle', 'select_one', 'select_many')`, [home])).n, 3);
    await owner.query(`delete from meta.region where page_id = $1`, [home]);
    await assert.rejects(owner.query(`insert into meta.item (page_id, name, type) values ($1, 'P1_BAD', 'shuttles')`, [home]), /item_type_check/);
  });

  test('the region type help names the attributes of each new type', () => {
    assert.match(regionConfigHelp('classic_report').text, /report_template/);
    assert.match(regionConfigHelp('classic_report').text, /"pagination"/);
    assert.match(regionConfigHelp('breadcrumb').text, /"current":false/);
    assert.match(regionConfigHelp('help_text').text, /Help text/);
    assert.ok(regionConfigHelp('classic_report').url?.includes('#classic_report'));
  });

  test('the new item types are list-of-values types like the others', () => {
    for (const t of ['shuttle', 'select_one', 'select_many']) assert.ok(LOV_CHECKED.has(t), t);
    assert.ok(MULTI_VALUE.has('shuttle') && MULTI_VALUE.has('select_many') && !MULTI_VALUE.has('select_one'));
  });

  test('the page help text is saved from the page properties', async () => {
    const dev = await devLogin();
    const page = await dev.get(`/builder/apps/${appId}/pages/2`);
    const form: Record<string, string> = { __csrf: dev.lastCsrf, page_no: '2', name: 'Picks', title: 'Picks', mode: 'normal', protection: 'checksum', parent_page: '1', help: 'Changed\r\nhelp' };
    assert.equal(page.statusCode, 200);
    const res = await dev.post(`/builder/pages/${pageId}`, form);
    assert.ok([302, 303].includes(res.statusCode), res.body);
    assert.equal((await owner.one(`select help from meta.page where id = $1`, [pageId])).help, 'Changed\nhelp');
    await owner.query(`update meta.page set requires_auth = false, help = $2 where id = $1`, [pageId, 'Some **help** for &P2_ONE..\n\n- one\n- two']);
  });
});

describe('shuttle, select one and select many at runtime', () => {
  test('without JavaScript: a select list and two multi-selection lists; the shuttle lists the chosen values first', async () => {
    const b = new Browser(app);
    await b.get(`/a/${alias}/2`);
    const res = await b.submit(`/a/${alias}/2`, { __request: 'SAVE', P2_SHUTTLE: ['G', 'A'], P2_ONE: 'B', P2_MANY: ['R', 'B'] });
    assert.equal(res.statusCode, 303, res.body);
    const page = (await b.get(`/a/${alias}/2`)).body;
    assert.match(page, /<div class="shuttle" data-shuttle="P2_SHUTTLE"[^>]*data-move-all-label="Move all"/);
    assert.match(page, /<select id="P2_SHUTTLE" name="P2_SHUTTLE" multiple[^>]*>\s*<option value="G" data-i="2" selected>Gamma<\/option><option value="A" data-i="0" selected>Alpha<\/option><option value="B" data-i="1">Beta<\/option><option value="D" data-i="3">Delta<\/option>/);
    assert.match(page, /data-select-pick="one"[^>]*>\s*<select id="P2_ONE" name="P2_ONE">\s*<option value="">- Select -<\/option>/);
    assert.match(page, /<option value="B" selected>Blue<\/option>/);
    assert.match(page, /data-select-pick="many"[^>]*>\s*<select id="P2_MANY" name="P2_MANY" multiple size="3" aria-required="true">/);
  });

  test('a value that is not in the list of values is refused; a required select many needs a value', async () => {
    const b = new Browser(app);
    await b.get(`/a/${alias}/2`);
    const bad = await b.submit(`/a/${alias}/2`, { __request: 'SAVE', P2_SHUTTLE: ['A', 'Z'], P2_ONE: 'X', P2_MANY: ['R', 'Q'] });
    assert.equal(bad.statusCode, 422);
    for (const label of ['Shuttle', 'One', 'Many']) assert.match(bad.body, new RegExp(`id="P2_${label === 'Shuttle' ? 'SHUTTLE' : label.toUpperCase()}_error"`), label);
    const none = await b.submit(`/a/${alias}/2`, { __request: 'SAVE', P2_ONE: 'R' });
    assert.match(none.body, /id="P2_MANY_error"/);
  });

  test('read-only, the chosen values show by their display values, in order', async () => {
    const b = new Browser(app);
    await owner.query(`update meta.item set default_value = 'G:A' where page_id = $1 and name = 'P2_SHOWN'`, [pageId]);
    try {
      const page = (await b.get(`/a/${alias}/2`)).body;
      assert.match(page, /<div class="display-value" id="P2_SHOWN">Gamma, Alpha<\/div>/);
    } finally {
      await owner.query(`update meta.item set default_value = null where page_id = $1 and name = 'P2_SHOWN'`, [pageId]);
    }
  });
});

describe('the classic report', () => {
  test('pages with "X – Y of N", sorts by its headings and has no Actions menu or search', async () => {
    const page = (await new Browser(app).get(`/a/${alias}/2`)).body;
    const r = sectionOf(page, rid.classic);
    assert.match(r, /<table class="report report-classic report-reflow">/);
    assert.equal((r.match(/<tr class="">/g) ?? []).length, 15);
    assert.match(r, /1–15 of 40/);
    assert.match(r, /<a href="[^"]*r\d+_s=1[^"]*">N<span class="sort-ind"/);
    assert.doesNotMatch(r, /ir-menu|data-col=|type="search"|Actions/);
  });

  test('pagination "range" leaves out the total, "none" shows every row without a pager', async () => {
    const page = (await new Browser(app).get(`/a/${alias}/2`)).body;
    const range = sectionOf(page, rid.range);
    assert.doesNotMatch(range, / of 40/);
    assert.match(range, /class="pager"/);
    const all = sectionOf(page, rid.none);
    assert.equal((all.match(/<tr class="">/g) ?? []).length, 40);
    assert.doesNotMatch(all, /class="pager"|sort-ind/);
  });

  test('the value_pairs and media_list templates', async () => {
    const page = (await new Browser(app).get(`/a/${alias}/2`)).body;
    assert.match(sectionOf(page, rid.pairs), /<div class="cr-pairs"><dl><dt>Name<\/dt><dd>Ann<\/dd><dt>Department<\/dt><dd>Sales<\/dd><\/dl><\/div>/);
    assert.match(sectionOf(page, rid.media), /<ul class="cr-media"><li><div class="cr-media-title">First<\/div><p class="cr-media-text">The first one<\/p><\/li><\/ul>/);
  });

  test('an interactive report\'s settings in the URL do nothing; {"searchable": true} adds the search', async () => {
    const b = new Browser(app);
    const page = (await b.get(`/a/${alias}/2?r${rid.classic}_f=${encodeURIComponent('n|eq|3')}&r${rid.classic}_v=chart&r${rid.classic}_n=5&r${rid.classic}_q=7`)).body;
    const r = sectionOf(page, rid.classic);
    assert.equal((r.match(/<tr class="">/g) ?? []).length, 15);
    assert.doesNotMatch(r, /chip/);
    const s = sectionOf((await b.get(`/a/${alias}/2?r${rid.search}_q=7`)).body, rid.search);
    assert.match(s, /type="search"/);
    assert.equal((s.match(/<tr class="">/g) ?? []).length, 4); // 7, 17, 27, 37
    // no downloads: those are the interactive report's
    const csv = await b.get(`/a/${alias}/2?r${rid.classic}_csv=1`);
    assert.notEqual(csv.headers['content-type'], 'text/csv; charset=utf-8');
  });
});

describe('the breadcrumb and help text regions', () => {
  test('the breadcrumb region shows the trail and the current page; the title bar then has none', async () => {
    const page = (await new Browser(app).get(`/a/${alias}/2`)).body;
    assert.match(sectionOf(page, rid.crumb), /<nav class="region-crumbs" aria-label="Trail"><ol class="crumbs"><li><a href="\/a\/ts-s140\/1">Home<\/a><\/li><li><span aria-current="page">Picks<\/span><\/li><\/ol><\/nav>/);
    assert.match(page, /<div class="t-regions t-pos-breadcrumb">/);
    assert.doesNotMatch(/<div class="t-titlebar">[\s\S]*?<\/div>/.exec(page)![0], /crumbs/);
    await owner.query(`update meta.region set config = '{"current": false}' where id = $1`, [rid.crumb]);
    try {
      assert.doesNotMatch(sectionOf((await new Browser(app).get(`/a/${alias}/2`)).body, rid.crumb), /aria-current/);
    } finally {
      await owner.query(`update meta.region set config = '{}' where id = $1`, [rid.crumb]);
    }
    // without a breadcrumb region the title bar shows the trail, as before
    const home = (await new Browser(app).get(`/a/${alias}/1`)).body;
    assert.doesNotMatch(home, /region-crumbs/);
  });

  test('the help text region shows the page help as Markdown with item values', async () => {
    const b = new Browser(app);
    await b.get(`/a/${alias}/2`);
    await b.submit(`/a/${alias}/2`, { __request: 'SAVE', P2_ONE: 'G', P2_MANY: 'R' });
    const help = sectionOf((await b.get(`/a/${alias}/2`)).body, rid.help);
    assert.match(help, /<div class="help-text rich-text"><p>Some <strong>help<\/strong> for G\.<\/p>\n<ul><li>one<\/li><li>two<\/li><\/ul><\/div>/);
    await owner.query(`update meta.page set help = null where id = $1`, [pageId]);
    try {
      assert.match(sectionOf((await b.get(`/a/${alias}/2`)).body, rid.help), /No help is available for this page\./);
    } finally {
      await owner.query(`update meta.page set help = $2 where id = $1`, [pageId, 'Some **help** for &P2_ONE..\n\n- one\n- two']);
    }
  });
});

describe('export, import and the Advisor', () => {
  test('the page help and the new types travel with an export', async () => {
    const doc = (await owner.one(`select meta.export_app($1) as doc`, [alias])).doc;
    const page = doc.pages.find((p: { page_no: number }) => p.page_no === 2);
    assert.match(page.help, /Some \*\*help\*\*/);
    assert.ok(page.items.some((i: { type: string }) => i.type === 'shuttle'));
    assert.ok(page.regions.some((r: { type: string }) => r.type === 'help_text'));
    await owner.query(`delete from meta.app where alias = 'ts-s140-copy'`);
    const id = (await owner.one(`select meta.import_app($1::jsonb, 'ts-s140-copy') as id`, [JSON.stringify(doc)])).id;
    const copy = await owner.one(`select p.help, (select string_agg(i.type, ',' order by i.seq) from meta.item i where i.page_id = p.id) as items,
                                         (select string_agg(r.type, ',' order by r.seq) from meta.region r where r.page_id = p.id) as regions
                                    from meta.page p where p.app_id = $1 and p.page_no = 2`, [id]);
    assert.equal(copy.help, page.help);
    assert.equal(copy.items, 'shuttle,select_one,select_many,shuttle');
    assert.match(copy.regions, /breadcrumb,help_text,classic_report/);
  });

  test('the Advisor warns about a list item without a list of values', async () => {
    await owner.query(`insert into meta.item (page_id, seq, name, type) values ($1, 90, 'P2_EMPTY', 'select_many')`, [pageId]);
    try {
      const { findings } = await advise(appId);
      assert.ok(findings.some((f) => f.field === 'List of values' && /select_many item needs a list of values/.test(f.message)), JSON.stringify(findings.map((f) => f.message)));
    } finally {
      await owner.query(`delete from meta.item where page_id = $1 and name = 'P2_EMPTY'`, [pageId]);
    }
  });
});

describe('HR page 50: a page as an APEX port would make it', () => {
  test('the shuttle cascades from the department, submits in its order and the classic report follows it', async () => {
    const b = new Browser(app);
    await b.login('king');
    const first = await b.get('/a/hr/50');
    assert.equal(first.statusCode, 200);
    assert.match(first.body, /<nav class="region-crumbs"/);
    // the cascading list of values: the shuttle again, with the department's employees
    const lov = await b.post('/a/hr/50/lov/P50_MEMBERS', { __csrf: b.lastCsrf, P50_DEPTNO: '10' });
    assert.equal(lov.statusCode, 200, lov.body);
    const html = lov.json().html as string;
    assert.match(html, /data-shuttle="P50_MEMBERS"/);
    assert.match(html, /KING \(PRESIDENT\)/);
    assert.doesNotMatch(html, /FORD/);
    const saved = await b.submit('/a/hr/50', { __request: 'SAVE', P50_DEPTNO: '20', P50_MEMBERS: ['7902', '7566'], P50_SKILLS: ['SQL', 'TS'] });
    assert.equal(saved.statusCode, 303, saved.body);
    let page = (await b.get('/a/hr/50')).body;
    assert.ok(page.indexOf('>FORD<') < page.indexOf('>JONES<') && page.indexOf('>FORD<') > 0);
    await b.submit('/a/hr/50', { __request: 'SAVE', P50_DEPTNO: '20', P50_MEMBERS: ['7566', '7902'], P50_SKILLS: 'SQL' });
    page = (await b.get('/a/hr/50')).body;
    assert.ok(page.indexOf('>JONES<') < page.indexOf('>FORD<'));
    // an employee of another department is not in the shuttle's list
    const bad = await b.submit('/a/hr/50', { __request: 'SAVE', P50_DEPTNO: '20', P50_MEMBERS: ['7566', '7839'] });
    assert.equal(bad.statusCode, 422);
    assert.match(bad.body, /id="P50_MEMBERS_error"/);
    assert.equal(hrId > 0, true);
  });
});
