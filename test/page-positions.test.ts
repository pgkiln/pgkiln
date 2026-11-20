// Sprint 234 (AX-12, migration 199; APEX: the page template's Slot list): the Standard page template's other display
// positions — After logo, Before and After navigation bar (in the header), Top navigation (a bar under it), Full width
// content and Dialogs, drawers and popups. The runtime renders each in its place (the header ones only on pages with
// the header), the Page Designer draws them as drop zones in APEX's order and moves regions into them, and the Advisor
// warns about a header position the page doesn't have and about items there (outside the page's form).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { advise, adviseDoc } from '../src/builder/advisor.ts';
import { POSITIONS } from '../src/builder/arrange.ts';
import { PAGE_POSITIONS, pageHasPosition } from '../src/page-positions.ts';
import { readFileSync } from 'node:fs';
import { apexToDoc } from '../src/apeximport.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
let pageId: number;
const alias = 'ts-s234';
const r: Record<string, number> = {};

const region = async (title: string, position: string | null, seq: number, template = 'standard') =>
  (await owner.one(`insert into meta.region (page_id, seq, title, type, source, position, template) values ($1, $2, $3, 'static', $4, $5, $6) returning id`,
    [pageId, seq, title, `<p>${title} text</p>`, position, template])).id as number;
const at = (body: string, text: string) => {
  const i = body.indexOf(text);
  assert.ok(i >= 0, `${text} is on the page`);
  return i;
};
const setPage = (sql: string) => owner.query(`update meta.page set ${sql} where id = $1`, [pageId]);
let dev: Browser;

before(async () => {
  app = await buildApp({ logger: false });
  await owner.query('delete from meta.app where alias = $1', [alias]);
  appId = (await owner.one(`insert into meta.app (alias, name, authentication, db_role) values ($1, 'Page positions test', 'none', 'hr_app') returning id`, [alias])).id;
  pageId = (await owner.one(`insert into meta.page (app_id, page_no, name, requires_auth) values ($1, 1, 'Home', false) returning id`, [appId])).id;
  r.body = await region('Main', null, 10);
  r.logo = await region('Logo tag', 'after_logo', 20, 'plain');
  r.before = await region('Before bar', 'before_navigation_bar', 30, 'plain');
  r.after = await region('After bar', 'after_navigation_bar', 40, 'plain');
  r.top = await region('Top links', 'top_navigation', 50, 'plain');
  r.crumb = await region('Trail', 'breadcrumb', 60);
  r.full = await region('Wide hero', 'full_width', 70, 'hero');
  r.footer = await region('Small print', 'footer', 80);
  r.dialog = await region('Popup', 'dialogs', 90, 'inline_dialog');
  r.banner = await region('Notice', 'banner', 100);
  dev = new Browser(app);
  await dev.get('/builder/login');
  await dev.post('/builder/login', { __csrf: dev.lastCsrf, username: 'admin', password: 'admin' });
});

after(async () => {
  await owner.query('delete from meta.app where id = $1', [appId]);
  await app.close();
  await closePools();
});

describe('the positions', () => {
  test('every position of the Page Designer\'s select is one of page-positions.ts, in APEX\'s order', () => {
    assert.deepEqual(POSITIONS(), [...PAGE_POSITIONS]);
    assert.deepEqual(PAGE_POSITIONS.slice(0, 7), ['banner', 'after_logo', 'before_navigation_bar', 'after_navigation_bar', 'top_navigation', 'breadcrumb', 'full_width']);
    assert.equal(PAGE_POSITIONS.at(-1), 'dialogs');
  });

  test('which page has which position', () => {
    assert.ok(pageHasPosition({ page_no: 1, page_template: 'standard' }, 'after_logo'));
    assert.ok(pageHasPosition({ page_no: 1, page_template: 'right_side_column' }, 'top_navigation'));
    assert.ok(!pageHasPosition({ page_no: 1, page_template: 'minimal' }, 'after_logo'));
    assert.ok(!pageHasPosition({ page_no: 1, page_template: 'standard', mode: 'modal' }, 'after_navigation_bar'));
    assert.ok(pageHasPosition({ page_no: 1, page_template: 'minimal' }, 'full_width'));
    assert.ok(pageHasPosition({ page_no: 1, page_template: 'minimal' }, 'dialogs'));
    assert.ok(!pageHasPosition({ page_no: 1, page_template: 'standard' }, 'left'));
    assert.ok(pageHasPosition({ page_no: 0, page_template: 'minimal' }, 'after_logo'), 'the Global Page has every position');
    assert.ok(!pageHasPosition({ page_no: 1 }, 'sidebar'));
  });

  test('the database refuses an unknown position', async () => {
    await assert.rejects(owner.query(`update meta.region set position = 'header' where id = $1`, [r.body]), /check constraint/);
  });
});

describe('the positions at runtime', () => {
  test('a standard page: the header, the bar under it, then banner, breadcrumb, full width, body, footer and dialogs', async () => {
    const html = (await new Browser(app).get(`/a/${alias}/1`)).body;
    const header = /<header class="t-header"[\s\S]*?<\/header>/.exec(html)![0];
    assert.ok(at(header, 'class="t-logo"') < at(header, '<div class="t-hpos t-pos-after_logo">'));
    assert.ok(at(header, 'Logo tag text') < at(header, 'class="t-spacer"'));
    assert.ok(at(header, 'class="t-spacer"') < at(header, '<div class="t-hpos t-pos-before_navigation_bar">'));
    assert.ok(at(header, 'Before bar text') < at(header, 'After bar text'));
    // the bar under the header, before the navigation menu and the content
    assert.ok(at(html, '</header>') < at(html, '<div class="t-topnav"><div class="t-regions t-pos-top_navigation">'));
    assert.ok(at(html, 'Top links text') < at(html, '<div class="t-body">'));
    // the content, in order
    const order = ['Notice text', 'Trail text', 'Wide hero', 'Main text', 'Small print text', 'Popup text'];
    for (let i = 1; i < order.length; i++) assert.ok(at(html, order[i - 1]) < at(html, order[i]), `${order[i - 1]} before ${order[i]}`);
    assert.match(html, /class="t-regions t-pos-full_width"/);
    assert.match(html, /class="t-regions t-pos-dialogs"/);
    // the header's regions are outside the page's form, the dialogs inside it (their items are submitted)
    const form = /<form method="post" class="page-form"[\s\S]*?<\/form>\s*<\/div>/.exec(html)![0];
    for (const t of ['Logo tag text', 'Before bar text', 'After bar text', 'Top links text']) assert.ok(!form.includes(t), `${t} outside the form`);
    for (const t of ['Main text', 'Wide hero', 'Popup text']) assert.ok(form.includes(t), `${t} in the form`);
  });

  test('the header positions come after the user menu in the header; a region left out leaves no empty position', async () => {
    await owner.query(`update meta.region set condition = 'false' where id = any($1)`, [[r.after, r.top]]);
    try {
      const html = (await new Browser(app).get(`/a/${alias}/1`)).body;
      assert.doesNotMatch(html, /t-pos-after_navigation_bar|t-topnav/);
      assert.match(html, /t-pos-after_logo/);
    } finally {
      await owner.query('update meta.region set condition = null where id = any($1)', [[r.after, r.top]]);
    }
  });

  test('a minimal page and a dialog have no header: its positions are left out, the others show', async () => {
    await setPage(`page_template = 'minimal'`);
    try {
      const html = (await new Browser(app).get(`/a/${alias}/1`)).body;
      for (const t of ['Logo tag text', 'Before bar text', 'After bar text', 'Top links text']) assert.ok(!html.includes(t), `${t} left out`);
      for (const t of ['Notice text', 'Wide hero', 'Main text', 'Small print text', 'Popup text']) assert.ok(html.includes(t), `${t} shown`);
    } finally {
      await setPage(`page_template = 'standard'`);
    }
    await setPage(`mode = 'modal'`);
    try {
      const html = (await new Browser(app).get(`/a/${alias}/1?dialog=1`)).body;
      assert.doesNotMatch(html, /Logo tag text|Top links text|t-hpos/);
      assert.match(html, /Wide hero/);
    } finally {
      await setPage(`mode = 'normal'`);
    }
  });
});

describe('the Page Designer', () => {
  const zoneOrder = (html: string) => [...html.matchAll(/<section class="pd-zone pd-zone-([a-z_]+)/g)].map((m) => m[1]);

  test('draws every position of the page template as a drop zone, in APEX\'s order, the header\'s side by side', async () => {
    const html = (await dev.get(`/builder/pages/${pageId}`)).body;
    assert.deepEqual(zoneOrder(html), ['banner', 'after_logo', 'before_navigation_bar', 'after_navigation_bar', 'top_navigation', 'breadcrumb', 'full_width', 'body', 'footer', 'dialogs']);
    for (const pos of ['after_logo', 'top_navigation', 'full_width', 'dialogs']) assert.match(html, new RegExp(`data-drop="region" data-position="${pos}"`), pos);
    const band = /<div class="pd-header-zones">[\s\S]*?<\/section><\/div>/.exec(html)?.[0] ?? /<div class="pd-header-zones">[\s\S]*?pd-zone-top_navigation/.exec(html)![0];
    assert.match(band, /pd-zone-after_logo[\s\S]*pd-zone-before_navigation_bar[\s\S]*pd-zone-after_navigation_bar/);
    assert.match(html, /aria-label="After logo"/);
    assert.match(html, /aria-label="Dialogs, drawers and popups"/);
    // the rendering tree: the regions by position, in the same order
    const tree = /<ul class="pd-tree" aria-label="Rendering"[\s\S]*?<\/ul>\s*<dialog/.exec(html)![0];
    const folders = [...tree.matchAll(/<span class="pd-node pd-folder"><span class="pd-label">([^<]+)<\/span>/g)].map((m) => m[1]);
    assert.deepEqual(folders.filter((f) => !f.startsWith('Pre-Rendering') && f !== 'Buttons'),
      ['Banner', 'After logo', 'Before navigation bar', 'After navigation bar', 'Top navigation', 'Breadcrumb bar', 'Full width content', 'Body', 'Footer', 'Dialogs, drawers and popups']);
    // a new region from a zone's link starts in that position
    assert.match((await dev.get(`/builder/pages/${pageId}?new=region&position=top_navigation`)).body, /<option value="top_navigation" selected>/);
  });

  test('a minimal page draws a header position only while it holds regions, and says they are not shown', async () => {
    await setPage(`page_template = 'minimal'`);
    try {
      let html = (await dev.get(`/builder/pages/${pageId}`)).body;
      assert.match(html, /pd-zone-after_logo is-off/);
      assert.match(html, /not in this page template: not shown/);
      await owner.query(`update meta.region set position = 'body' where id = any($1)`, [[r.logo, r.before, r.after, r.top]]);
      html = (await dev.get(`/builder/pages/${pageId}`)).body;
      assert.deepEqual(zoneOrder(html), ['banner', 'breadcrumb', 'full_width', 'body', 'footer', 'dialogs']);
      assert.doesNotMatch(html, /pd-header-zones/);
    } finally {
      await setPage(`page_template = 'standard'`);
      for (const [k, pos] of [['logo', 'after_logo'], ['before', 'before_navigation_bar'], ['after', 'after_navigation_bar'], ['top', 'top_navigation']])
        await owner.query('update meta.region set position = $2 where id = $1', [r[k], pos]);
    }
  });

  test('moving a region into each new position, and back; undo restores it', async () => {
    await dev.get(`/builder/pages/${pageId}`);
    const post = (op: string, form: Record<string, string>) => dev.post(`/builder/pages/${pageId}/layout/${op}`, { ...form, __csrf: dev.lastCsrf });
    for (const pos of ['after_logo', 'before_navigation_bar', 'after_navigation_bar', 'top_navigation', 'full_width', 'dialogs']) {
      assert.equal((await post('move', { kind: 'region', id: String(r.body), position: pos, before: '' })).statusCode, 303, pos);
      assert.equal((await owner.one('select position from meta.region where id = $1', [r.body])).position, pos);
    }
    assert.equal((await post('undo', {})).statusCode, 303);
    assert.equal((await owner.one('select position from meta.region where id = $1', [r.body])).position, 'full_width');
    assert.equal((await post('move', { kind: 'region', id: String(r.body), position: 'body', before: '' })).statusCode, 303);
    assert.equal((await owner.one('select position from meta.region where id = $1', [r.body])).position, null);
    // a new region from the gallery dropped on the Top navigation zone
    assert.equal((await post('create', { kind: 'region', type: 'static', position: 'top_navigation' })).statusCode, 303);
    const made = await owner.one(`select id, position from meta.region where page_id = $1 order by id desc limit 1`, [pageId]);
    assert.equal(made.position, 'top_navigation');
    await owner.query('delete from meta.region where id = $1', [made.id]);
  });
});

describe('the Advisor', () => {
  test('warns about a header position the page has not, and about items and submit buttons there', async () => {
    const field = (f: { field: string }) => f.field === 'Position';
    assert.deepEqual((await advise(appId)).findings.filter(field), [], 'a standard page with static regions: nothing');
    const item = (await owner.one(`insert into meta.item (page_id, region_id, seq, name, label, type) values ($1, $2, 10, 'P1_FIND', 'Find', 'text') returning id`, [pageId, r.before])).id;
    await setPage(`page_template = 'minimal'`);
    try {
      const found = (await advise(appId)).findings.filter(field);
      assert.equal(found.filter((f) => /isn't shown/.test(f.message)).length, 4, found.map((f) => f.message).join('\n'));
      assert.ok(found.some((f) => /minimal page template/.test(f.message) && f.entry?.id === r.logo));
      assert.ok(found.some((f) => /outside the page's form: P1_FIND sends nothing/.test(f.message) && f.entry?.id === r.before));
      // the same checks on an export (no database)
      const doc = (await owner.one('select meta.export_app($1) as d', [alias])).d;
      assert.ok((await adviseDoc(doc)).findings.some((f) => field(f) && /isn't shown/.test(f.message)));
    } finally {
      await setPage(`page_template = 'standard'`);
      await owner.query('delete from meta.item where id = $1', [item]);
    }
  });
});

describe('the APEX importer', () => {
  test('maps the Universal Theme\'s After Logo, Before / After Navigation Bar, Dialogs and Footer display points', () => {
    const F100 = readFileSync(new URL('fixtures/apex/f100.sql', import.meta.url), 'utf8');
    const plug = (n: number, name: string, point: string) => `wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(1370000000000099${n})
,p_plug_name=>'${name}'
,p_plug_display_sequence=>${n}0
,p_plug_display_point=>'${point}'
,p_plug_source=>'<p>${name}</p>'
,p_plug_query_options=>'DERIVED_REPORT_COLUMNS'
);
`;
    const points: [string, string | null][] = [['AFTER_LOGO', 'after_logo'], ['BEFORE_NAVIGATION_BAR', 'before_navigation_bar'], ['AFTER_NAVIGATION_BAR', 'after_navigation_bar'],
      ['REGION_POSITION_04', 'dialogs'], ['REGION_POSITION_05', 'footer'], ['REGION_POSITION_01', 'breadcrumb'], ['BODY', null]];
    const src = F100.replace(`,p_page_component_map=>'14'
);
end;
/`, `,p_page_component_map=>'14'
);
${points.map(([pt], i) => plug(i + 1, `R ${pt}`, pt)).join('')}end;
/`);
    assert.notEqual(src, F100, 'the fixture has the page this test extends');
    const { doc } = apexToDoc(src, { alias: `${alias}-apex`, dbRole: 'hr_app' });
    const regions = doc.pages.flatMap((p: any) => p.regions ?? []);
    for (const [pt, pos] of points) assert.equal(regions.find((r: any) => r.title === `R ${pt}`)?.position ?? null, pos, pt);
  });
});
