// Sprint 230 (AX-9, AX-10, AX-11; migration 188): a region's other property groups, as APEX has them in the Page Designer:
// Layout (Start New Row, Column, Row and Column CSS Classes, Column Attributes), Appearance (Template first, CSS Classes,
// Icon, Render Components), Accessibility (landmark), Advanced (HTML DOM ID, Custom Attributes, Region Display Selector,
// Exclude Title from Translation), Header and Footer, Read Only, Server Cache, Customization, Configuration, Comments and
// Audit Information. The property editor shows them in APEX's order; each takes effect on the page; export, import,
// import --replace and the APEX importer keep them; HR page 57 shows them.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { replaceApp } from '../src/cli/replace.ts';
import { docToFiles, filesToDoc } from '../src/appfiles.ts';
import { apexRegionProps } from '../src/apex-region-props.ts';
import { arrangeRows, classList, gridClasses, parseAttributes } from '../src/runtime/region-props.ts';
import { translatePage } from '../src/runtime/locale.ts';
import { translatorFor } from '../src/builder/i18n.ts';
import { html } from '../src/html.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
let pageId: number;
const alias = 'ts-s230';
const R: Record<string, number> = {};

const devLogin = async () => {
  const dev = new Browser(app);
  await dev.get('/builder/login');
  await dev.post('/builder/login', { __csrf: dev.lastCsrf, username: 'admin', password: 'admin' });
  return dev;
};
const region = async (title: string, o: Record<string, unknown> = {}) => {
  const cols = { title, type: 'static', source: `<p>${title} text</p>`, ...o };
  const keys = Object.keys(cols);
  return (await owner.one(`insert into meta.region (page_id, seq, ${keys.join(', ')}) values ($1, (select coalesce(max(seq), 0) + 10 from meta.region where page_id = $1), ${keys.map((_, i) => `$${i + 2}`).join(', ')}) returning id`,
    [pageId, ...Object.values(cols)])).id as number;
};
const decode = (v: string) => v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const attr = (tag: string, a: string) => new RegExp(`\\s${a}="([^"]*)"`).exec(tag)?.[1];
/** What the toolbar's Save posts: the controls of the property editor's form. */
function designerForm(page: string): Record<string, string> {
  const start = page.indexOf('<form method="post"', page.indexOf('id="pd-r-props"'));
  const inner = page.slice(start, page.indexOf('</form>', start));
  const out: Record<string, string> = {};
  for (const [tag] of inner.matchAll(/<input\b[^>]*>/g)) {
    const name = attr(tag, 'name');
    const type = attr(tag, 'type') ?? 'text';
    if (!name || ['file', 'submit', 'button'].includes(type)) continue;
    if ((type === 'checkbox' || type === 'radio') && !/\schecked\b/.test(tag)) continue;
    out[name] = decode(attr(tag, 'value') ?? '');
  }
  for (const m of inner.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
    const name = attr(m[1], 'name');
    const sel = /<option\b[^>]*\sselected\b[^>]*>/.exec(m[2])?.[0] ?? /<option\b[^>]*>/.exec(m[2])?.[0];
    if (name) out[name] = decode((sel && attr(sel, 'value')) ?? '');
  }
  for (const m of inner.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)) {
    const name = attr(m[1], 'name');
    if (name) out[name] = decode(m[2]);
  }
  return out;
}

before(async () => {
  app = await buildApp({ logger: false });
  await owner.query(`delete from meta.app where alias like 'ts-s230%'`);
  appId = (await owner.one(`insert into meta.app (alias, name, authentication, db_role) values ($1, 'Region properties test', 'none', 'hr_app') returning id`, [alias])).id;
  pageId = (await owner.one(`insert into meta.page (app_id, page_no, name, title, requires_auth) values ($1, 1, 'Home', 'Home', false) returning id`, [appId])).id;
  R.first = await region('First', { columns: 4, new_row: true, row_css_classes: 'row-a row-b', css_classes: 'my-region', icon: 'info', static_id: 'first' });
  R.gap = await region('Gap', { columns: 4, grid_column: 9, column_css_classes: 'col-x', column_attributes: 'data-col="9"' });
  R.wide = await region('Wide', { columns: 6, new_row: true, grid_column: 10 });
  R.nav = await region('Links', { landmark_type: 'navigation', landmark_label: 'Useful &P1_LOCK. links', custom_attributes: `data-kind="links" title="Hello &P1_LOCK." tabindex="0"` });
  R.none = await region('Decoration', { template: 'plain', use_landmark: false, dom_id: 'deco-box' });
  R.text = await region('Texts', { header_text: '<p class="h">Head [&P1_LOCK.]</p>', footer_text: '<p class="f">Foot</p>', static_id: 'texts' });
  R.lock = await region('Lock', { source: '<p>[x:&P1_X.]</p>', render_components: 'above' });
  R.ro = await region('Read only', { source: '', readonly_type: 'sql', readonly_expr: `:P1_LOCK = 'Y'`, static_id: 'ro' });
  await owner.query(`insert into meta.item (page_id, region_id, seq, name, label, type) values ($1, $2, 10, 'P1_LOCK', 'Lock', 'text'), ($1, $3, 10, 'P1_X', 'X', 'text')`, [pageId, R.lock, R.ro]);
  await owner.query(`insert into meta.button (page_id, seq, name, label, action) values ($1, 10, 'SAVE', 'Save', 'submit')`, [pageId]);
});

after(async () => {
  await owner.query(`delete from meta.app where alias like 'ts-s230%'`);
  await owner.query(`delete from meta.user_preference where name = 'PGKILN_REGIONS_P57'`);
  await app.close();
  await closePools();
});

describe('the helpers', () => {
  test('grid classes: span, start column, a new row, and a span cut to end at column 12', () => {
    assert.equal(gridClasses({ columns: 6, grid_column: null, new_row: null }), 'col-6');
    assert.equal(gridClasses({ columns: 4, grid_column: 9, new_row: null }), 'col-4 col-start-9');
    assert.equal(gridClasses({ columns: 4, grid_column: null, new_row: true }), 'col-4 col-start-1');
    assert.equal(gridClasses({ columns: 6, grid_column: 10, new_row: true }), 'col-3 col-start-10');
    assert.equal(gridClasses({ columns: 12, grid_column: 13 as never, new_row: false }), 'col-12');
  });

  test('class lists and attributes', () => {
    assert.equal(classList('  a  u-DisplayNone -x_y '), 'a u-DisplayNone -x_y');
    for (const bad of ['a"b', 'a<b', 'a;b', '9a', 'a{b}', '']) assert.equal(classList(bad), null, bad);
    const p = parseAttributes(`data-a="1" aria-describedby='x' title=plain translate data-a="2"`);
    assert.equal(p.problem, null);
    assert.deepEqual(p.attrs, [{ name: 'data-a', value: '1' }, { name: 'aria-describedby', value: 'x' }, { name: 'title', value: 'plain' }, { name: 'translate', value: null }]);
    assert.match(parseAttributes('onclick="x()"').problem!, /event handlers/);
    assert.match(parseAttributes('style="color:red"').problem!, /style/);
    assert.match(parseAttributes('aria-label="x"').problem!, /not allowed/);
    assert.match(parseAttributes('tabindex="a"').problem!, /whole number/);
    assert.match(parseAttributes('data-x="1" "oops"').problem!, /is not name="value"/);
  });

  test('rows: a region that starts a new row with row classes holds its row', () => {
    const r = (id: number, o: Record<string, unknown> = {}) => [{ id, ...o } as never, html`<i>${id}</i>`] as [never, ReturnType<typeof html>];
    const out = arrangeRows([r(1), r(2, { new_row: true, row_css_classes: 'x y' }), r(3), r(4, { new_row: true }), r(5)]).map(String).join('');
    assert.equal(out, '<i>1</i><div class="t-row x y"><i>2</i><i>3</i></div><i>4</i><i>5</i>');
  });

  test('a title left out of the translation; header, footer and landmark label translated', () => {
    const page = { name: 'P', title: null, regions: [
      { title: 'KPI', title_no_translate: true, header_text: 'Head', footer_text: 'Foot', landmark_label: 'Label', config: {} },
      { title: 'Other', config: {} }], items: [], buttons: [], dynamic_actions: [], validations: [], processes: [] };
    translatePage(page as never, (s) => `nl:${s}`);
    assert.deepEqual(page.regions.map((r: any) => [r.title, r.header_text, r.footer_text, r.landmark_label]),
      [['KPI', 'nl:Head', 'nl:Foot', 'nl:Label'], ['nl:Other', undefined, undefined, undefined]]);
  });
});

describe('on the page', () => {
  test('layout, appearance, accessibility, advanced, header and footer', async () => {
    const b = new Browser(app);
    const page = (await b.get(`/a/${alias}/1`)).body;
    const tag = (id: number) => new RegExp(`<(?:section|dialog)[^>]*id="R${id}"[^>]*>`).exec(page)?.[0] ?? '';
    // Layout: the first region starts a row of its own with its classes; the gap region starts in column 9
    assert.match(page, /<div class="t-row row-a row-b"><section class="region region-static region-standard col-4 col-start-1 my-region"/);
    assert.match(tag(R.gap), /class="region region-static region-standard col-4 col-start-9 col-x"/);
    assert.match(tag(R.gap), / data-col="9"/);
    assert.match(tag(R.wide), /col-3 col-start-10/, 'a span cut to fit');
    // the t-row ends before the next region that starts a new row
    assert.ok(page.indexOf('</div>', page.indexOf('class="t-row')) < page.indexOf(`id="R${R.wide}"`));
    // Appearance: the icon before the title
    assert.match(page, new RegExp(`<h2 id="R${R.first}_title"><span class="region-icon"><svg`));
    // Accessibility: a navigation landmark named by its label; a region that is no landmark
    assert.match(tag(R.nav), / role="navigation" aria-label="Useful &amp;P1_LOCK. links"/);
    assert.doesNotMatch(tag(R.nav), /aria-labelledby/);
    assert.doesNotMatch(tag(R.none), /aria-label|role=/);
    // Advanced: custom attributes (with the substitution left as typed while the item has no value), the DOM id on the content
    assert.match(tag(R.nav), / data-kind="links" title="Hello &amp;P1_LOCK." tabindex="0"/);
    assert.match(page, /<div class="region-content" id="deco-box">/);
    // Header and footer text around the content; Render components above: the item before the text
    assert.match(page, /<div class="region-header-text"><p class="h">Head \[&P1_LOCK.\]<\/p><\/div><p>Texts text<\/p><div class="region-footer-text"><p class="f">Foot<\/p><\/div>/);
    assert.ok(page.indexOf('data-item="P1_LOCK"') < page.indexOf('[x:'), 'items above the content');
    // nothing is customizable here: no Customize link
    assert.doesNotMatch(page, /t-customize/);
  });

  test('Read Only: the region\'s items are read-only while the condition holds, and a post cannot set them', async () => {
    const b = new Browser(app);
    let page = (await b.get(`/a/${alias}/1`)).body;
    assert.match(page, /<div class="field field-text" data-item="P1_X">/);
    await b.submit(`/a/${alias}/1`, { P1_LOCK: 'Y', P1_X: 'first', __request: 'SAVE' });
    page = (await b.get(`/a/${alias}/1`)).body;
    assert.match(page, /<div class="field field-text readonly" data-item="P1_X">/);
    assert.match(page, /\[x:first\]/);
    await b.submit(`/a/${alias}/1`, { P1_LOCK: 'Y', P1_X: 'changed', __request: 'SAVE' });
    page = (await b.get(`/a/${alias}/1`)).body;
    assert.match(page, /\[x:first\]/, 'a read-only item keeps its value');
  });

  test('Customization: HR page 57, the Customize link and the user\'s choice', async () => {
    await owner.query(`delete from meta.user_preference where name = 'PGKILN_REGIONS_P57'`);
    const b = new Browser(app);
    await b.login('king');
    let page = (await b.get('/a/hr/57')).body;
    assert.match(page, /<details class="t-customize">/);
    assert.match(page, /name="show" value="tips" checked> Tips for this page/);
    assert.match(page, /name="show" value="shortcuts"> Shortcuts/);
    assert.match(page, />Tips<\/h2>/);
    assert.doesNotMatch(page, />Shortcuts<\/h2>/, 'hidden by default');
    // a forged request without the session's token is refused
    assert.equal((await b.post('/a/hr/57/customize', { __csrf: 'nope', show: 'shortcuts' })).statusCode, 403);
    const res = await b.submit('/a/hr/57/customize', { show: ['shortcuts', 'no-such-region'] });
    assert.equal(res.statusCode, 303);
    page = (await b.get('/a/hr/57')).body;
    assert.doesNotMatch(page, />Tips<\/h2>/);
    assert.match(page, />Shortcuts<\/h2>/);
    const pref = await owner.one(`select value from meta.user_preference where name = 'PGKILN_REGIONS_P57' and username = 'king'`);
    assert.deepEqual(JSON.parse(pref!.value), { tips: false, shortcuts: true });
    // the public user has no Customize link
    assert.doesNotMatch((await new Browser(app).get(`/a/${alias}/1`)).body, /customize/);
  });

  test('HR page 57: layout, read-only notes, a navigation landmark, and its title kept in Dutch', async () => {
    const b = new Browser(app);
    await b.login('king');
    const page = (await b.get('/a/hr/57')).body;
    assert.match(page, /<div class="t-row hr-row-intro">/);
    assert.match(page, /col-4 col-start-9 hr-gap-column/);
    assert.match(page, /role="navigation" aria-label="Related HR pages"/);
    assert.match(page, /<div class="region-content" id="hr-region-notes">/);
    assert.match(page, /title="Notes of king"/);
  });
});

describe('the property editor', () => {
  test('APEX\'s groups in APEX\'s order, the Template first in Appearance, names in the builder\'s language', async () => {
    const dev = await devLogin();
    const page = (await dev.get(`/builder/pages/${pageId}?c=region-${R.gap}`)).body;
    const form = page.slice(page.indexOf('id="pd-r-props"'), page.indexOf('</form>', page.indexOf('id="pd-r-props"')));
    const groups = [...form.matchAll(/<fieldset class="prop-group"><legend>([^<]+)<\/legend>/g)].map((m) => m[1]);
    assert.deepEqual(groups, ['Identification', 'Source', 'Layout', 'Appearance', 'Accessibility', 'Advanced', 'Header and footer', 'Server-side condition',
      'Read only', 'Security', 'Server cache', 'Customization', 'Configuration', 'Comments', 'Audit information']);
    const appearance = form.slice(form.indexOf('<legend>Appearance'));
    assert.ok(appearance.indexOf('data-prop="template"') < appearance.indexOf('data-prop="css_classes"'));
    assert.match(form, /<option value="" selected>Automatic<\/option>|<option value="9" selected>9<\/option>/);
    // every field has help
    for (const name of ['new_row', 'grid_column', 'row_css_classes', 'column_attributes', 'css_classes', 'render_components', 'use_landmark', 'landmark_type', 'dom_id',
      'custom_attributes', 'display_selector', 'title_no_translate', 'header_text', 'readonly_type', 'customization', 'comments'])
      assert.match(form, new RegExp(`data-prop="${name}"[\\s\\S]*?<small class="help">`), name);
    const de = translatorFor('de');
    assert.equal(de.dyn('pe.group.read_only', 'Read only'), 'Schreibgeschützt');
    assert.equal(de.dyn('pe.region.landmark_type', 'Landmark type'), 'Landmark-Typ');
  });

  test('saving: the new properties, a display selector tab in the settings, the audit information', async () => {
    const dev = await devLogin();
    const url = `/builder/pages/${pageId}?c=region-${R.text}`;
    const f = designerForm((await dev.get(url)).body);
    assert.equal(f.title, 'Texts');
    Object.assign(f, { grid_column: '3', css_classes: '  one   two ', custom_attributes: 'data-x="1"', display_selector: 'true', display_selector_tab: 'Facts',
      customization: 'hidden', customization_name: 'Facts', comments: 'note', landmark_type: 'search', render_components: 'above', __csrf: dev.lastCsrf });
    delete f.use_landmark;
    const res = await dev.post(`/builder/pages/${pageId}/c/region/${R.text}`, f);
    assert.equal(res.statusCode, 303);
    const row = await owner.one('select * from meta.region where id = $1', [R.text]);
    assert.deepEqual([row.grid_column, row.css_classes, row.custom_attributes, row.config.display_selector, row.customization, row.comments, row.landmark_type, row.use_landmark, row.render_components, row.header_text],
      [3, 'one two', 'data-x="1"', 'Facts', 'hidden', 'note', 'search', false, 'above', '<p class="h">Head [&P1_LOCK.]</p>']);
    // the audit information: who and when
    const page = (await dev.get(url)).body;
    assert.match(page, /data-prop="updated_by"[\s\S]*?<output[^>]*>admin<\/output>/);
    // the display selector unchecked removes the key
    const g = designerForm(page);
    delete g.display_selector;
    await dev.post(`/builder/pages/${pageId}/c/region/${R.text}`, { ...g, __csrf: dev.lastCsrf });
    assert.equal((await owner.one('select config ? \'display_selector\' as has from meta.region where id = $1', [R.text]))!.has, false);
    await owner.query(`update meta.region set use_landmark = null, customization = null where id = $1`, [R.text]);
  });

  test('refused: attributes with event handlers or style, class lists with odd characters, a DOM id pgkiln uses', async () => {
    const dev = await devLogin();
    const f = designerForm((await dev.get(`/builder/pages/${pageId}?c=region-${R.gap}`)).body);
    for (const [k, v, msg] of [['custom_attributes', 'onmouseover="alert(1)"', /event handlers/], ['column_attributes', 'style="x"', /style/],
      ['css_classes', 'a"><script>', /CSS class names/], ['dom_id', 'R12', /HTML DOM ID/], ['dom_id', 'P1_X', /HTML DOM ID/]] as const) {
      await dev.post(`/builder/pages/${pageId}/c/region/${R.gap}`, { ...f, [k]: v, __csrf: dev.lastCsrf });
      const after = (await dev.get(`/builder/pages/${pageId}?c=region-${R.gap}`)).body;
      assert.match(after, msg, `${k}: ${v}`);
    }
    const row = await owner.one('select custom_attributes, column_attributes, css_classes, dom_id from meta.region where id = $1', [R.gap]);
    assert.deepEqual(row, { custom_attributes: null, column_attributes: 'data-col="9"', css_classes: null, dom_id: null });
  });
});

describe('exports and imports', () => {
  test('the export carries the properties (files too); an older export without them imports', async () => {
    const doc = (await owner.one('select meta.export_app($1) as d', [alias]))!.d;
    const first = doc.pages[0].regions.find((r: any) => r.title === 'First');
    assert.deepEqual([first.new_row, first.row_css_classes, first.icon], [true, 'row-a row-b', 'info']);
    assert.doesNotMatch(JSON.stringify(doc), /created_on|region_audit/);
    // the text files and back
    const again = filesToDoc(docToFiles(doc, 'text'));
    assert.deepEqual(again.pages[0].regions.find((r: any) => r.title === 'Gap').column_attributes, 'data-col="9"');
    // an export made before migration 188
    const old = structuredClone(doc);
    for (const r of old.pages[0].regions) for (const k of ['new_row', 'grid_column', 'css_classes', 'icon', 'readonly_type', 'readonly_expr', 'customization']) delete r[k];
    const id = (await owner.one(`select meta.import_app($1::jsonb, 'ts-s230-old') as id`, [JSON.stringify(old)]))!.id;
    assert.ok(id);
    assert.equal((await owner.one(`select count(*)::int as n from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and r.new_row is null`, [id]))!.n, 8);
  });

  test('import --replace keeps a region\'s creation in its audit information', async () => {
    await owner.query(`update meta.region_audit set created_on = '2020-01-01', created_by = 'creator' where region_id = $1`, [R.first]);
    const doc = (await owner.one('select meta.export_app($1) as d', [alias]))!.d;
    doc.pages[0].regions.find((r: any) => r.title === 'First').css_classes = 'changed';
    await owner.tx((c) => replaceApp(c, doc, alias, { backup: null }));
    const a = await owner.one(`select a.created_on::date::text as created_on, a.created_by, r.css_classes from meta.region r join meta.region_audit a on a.region_id = r.id
                                where r.page_id = (select id from meta.page where app_id = $1 and page_no = 1) and r.static_id = 'first'`, [appId]);
    assert.deepEqual([a!.created_on, a!.created_by, a!.css_classes], ['2020-01-01', 'creator', 'changed']);
    pageId = (await owner.one('select id from meta.page where app_id = $1 and page_no = 1', [appId]))!.id;
  });

  test('the APEX importer maps the region\'s CSS classes, icon, new row, landmark label and item position', () => {
    const notes: string[] = [];
    const props = apexRegionProps({ p_region_css_classes: 'margin-sm #DEFAULT#', p_icon_css_classes: 'fa-check-circle', p_landmark_label: 'Filters', p_plug_item_display_point: 'BELOW',
      p_region_attributes: 'onclick="x"', p_plug_header: '<b>Hi</b>', p_landmark_type: 'navigation' }, 4, (m) => notes.push(m));
    assert.deepEqual(props, { new_row: true, css_classes: 'margin-sm', icon: 'fa-check-circle', render_components: 'below', landmark_type: 'navigation', landmark_label: 'Filters', header_text: '<b>Hi</b>' });
    assert.equal(notes.length, 2);
    assert.deepEqual(apexRegionProps({ p_plug_new_grid_row: false }, 6, () => {}), {});
  });
});
