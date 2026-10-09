// Template components (APEX 23.1+) and plug-ins: the template language, its
// allow-list and escaping, plug-in files, the template_component region,
// report column templates and the builder pages.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import {
  attributesProblem, compileTemplate, componentProblem, parsePlugin, pluginDocument, renderInstances, rowLookup, TemplateError, urlOk,
  type TemplateComponent,
} from '../src/runtime/template-components.ts';
import { columnNames, mergeColumnTemplates, mergeTemplateRegionSettings, previewHtml, sampleRows } from '../src/builder/templates.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
let page19: { id: number; regions: { id: number; type: string; config: any }[] };

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  const p = await owner.one('select id from meta.page where app_id = $1 and page_no = 19', [appId]);
  page19 = { id: p.id, regions: (await owner.query('select id, type, config from meta.region where page_id = $1 order by seq', [p.id])).rows };
});

after(async () => {
  for (const r of page19.regions) await owner.query('update meta.region set config = $2 where id = $1', [r.id, JSON.stringify(r.config)]);
  await owner.query(`delete from meta.template_component where app_id = $1 and static_id like 'test\\_%'`, [appId]);
  await app.close();
  await closePools();
});

/** Render a template for rows of plain values (attributes: their defaults). */
function render(template: string, rows: Record<string, string>[], opts: { wrapper?: string; multiple?: boolean; attributes?: TemplateComponent['attributes'] } = {}) {
  const c = compileTemplate(template, opts.wrapper);
  const attrs = new Map((opts.attributes ?? []).map((a) => [a.name, a.default ?? '']));
  const lookups = rows.map((r, n) => rowLookup(null, attrs, new Map(Object.entries(r).map(([k, v]) => [k.toUpperCase(), v])), { APEX$ROW_NUM: String(n + 1) }));
  return renderInstances(c, lookups, rowLookup(null, attrs, new Map(), { APEX$ROW_COUNT: String(rows.length) }), !!opts.multiple);
}

const refused = (template: string, pattern: RegExp, wrapper?: string) =>
  assert.throws(() => compileTemplate(template, wrapper), (e: unknown) => e instanceof TemplateError && pattern.test(e.message), template);

describe('template language', () => {
  test('placeholders are escaped in text and attribute values', () => {
    const out = render('<p class="x-#K#" title="#T#">#V#</p>', [{ K: 'a"b', T: "it's <b>", V: '<script>alert(1)</script>&' }]);
    assert.equal(out, '<p class="x-a&quot;b" title="it&#39;s &lt;b&gt;">&lt;script&gt;alert(1)&lt;/script&gt;&amp;</p>');
    assert.equal(render('<b>#V!STRIPHTML#</b>', [{ V: '<i>bold</i> & <img src=x onerror=alert(1)>' }]), '<b>bold &amp; </b>');
    assert.equal(render('<b>#MISSING#</b>', [{}]), '<b></b>', 'unknown names render as nothing');
  });

  test('if, elsif, else, case and loop', () => {
    const t = '{if ?A/}a{elsif !B/}not-b{else/}else{endif/}|{case S/}{when ok,done/}good{when late/}bad{otherwise/}?{endcase/}|{loop "," L/}[#APEX$I#:#APEX$ITEM#]{endloop/}';
    assert.equal(render(t, [{ A: 'x', B: 'Y', S: 'DONE', L: 'p, q' }]), 'a|good|[1:p][2:q]');
    assert.equal(render(t, [{ A: '', B: 'N', S: 'late', L: '' }]), 'not-b|bad|');
    assert.equal(render(t, [{ B: 'yes', S: 'other' }]), 'else|?|');
    assert.equal(render('<span class="{if ?A/}on{else/}off{endif/}">#APEX$ROW_NUM#</span>', [{ A: '1' }, {}]), '<span class="on">1</span><span class="off">2</span>');
  });

  test('wrapper: all rows once, with the row count', () => {
    const out = render('<li>#N#</li>', [{ N: '1' }, { N: '2' }], { wrapper: '<ol title="#APEX$ROW_COUNT#">#APEX$ROWS#</ol>', multiple: true });
    assert.equal(out, '<ol title="2"><li>1</li><li>2</li></ol>');
    assert.equal(render('<li>#N#</li>', [{ N: '1' }], { wrapper: '<ol>#APEX$ROWS#</ol>' }), '<li>1</li>', 'each row: no wrapper');
  });

  test('custom attributes take #COLUMN# from the row', () => {
    const out = render('<b>#LABEL#</b>', [{ STATUS: '<ok>' }], { attributes: [{ name: 'LABEL', default: 'Status: #status#' }] });
    assert.equal(out, '<b>Status: &lt;ok&gt;</b>');
  });

  test('scripts, styles, handlers, forms and frames are refused', () => {
    refused('<script>alert(1)</script>', /not allowed/);
    refused('<style>p{}</style>', /not allowed/);
    refused('<SCRIPT src="x"></SCRIPT>', /not allowed/);
    refused('<p onclick="x()">a</p>', /Event handler/);
    refused('<p ONMOUSEOVER="x()">a</p>', /Event handler/);
    refused('<p style="color:red">a</p>', /style attributes/);
    refused('<p data-confirm="x">a</p>', /data-\*/);
    for (const tag of ['iframe', 'form', 'input', 'button', 'svg', 'math', 'object', 'embed', 'link', 'meta', 'base', 'template', 'textarea'])
      refused(`<${tag}></${tag}>`, /not allowed/);
    refused('<!-- x --><p></p>', /Comments/);
    refused('<p title=#X#>a</p>', /quotes|Placeholders/);
    refused('<p title=x>a</p>', /quotes/);
    refused('<p #X#>a</p>', /Placeholders and directives/);
    refused('<p {if A/}hidden{endif/}>a</p>', /Placeholders and directives/);
    refused('<p title="a>b">x</p>', /attribute values/);
    refused('<p>#X!RAW#</p>', /raw/);
    refused('<p>#X!JS#</p>', /unknown modifier/);
    refused('<p>{if A/}x</p>', /has no \{endif/);
    refused('<p title="{if A/}x">{endif/}</p>', /same attribute value|has no/);
    refused('<p>{foo/}</p>', /Unknown directive/);
    refused('<p>#APEX$ROWS#</p>', /belongs in the wrapper/);
    refused('<li></li>', /exactly once/, '<ol></ol>');
    refused('<li></li>', /exactly once/, '<ol>#APEX$ROWS##APEX$ROWS#</ol>');
    refused('<li></li>', /not in an attribute/, '<ol title="#APEX$ROWS#"></ol>');
    refused('', /empty/);
    refused('<p>x</p>'.repeat(4000), /longer than/);
  });

  test('URLs: only http(s), mailto, tel and relative, also after substitution', () => {
    for (const u of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:x', 'java\tscript:x', '&#106;avascript:x', '&#x6A;avascript:x', 'jav&#x09;ascript:x', 'vbscript:x', 'data:text/html,<b>', 'java&Tab;script:x'])
      assert.equal(urlOk(u), false, u);
    for (const u of ['https://example.com/x', 'http://a', 'mailto:a@b.c', 'tel:+31', '/a/hr/3?x=1', 'page.html', '#top', '?q=1'])
      assert.equal(urlOk(u), true, u);
    assert.equal(urlOk('data:image/png;base64,AAAA', 'src'), true);
    assert.equal(urlOk('data:image/png;base64,AAAA', 'href'), false);
    refused('<a href="javascript:alert(1)">x</a>', /javascript/);
    refused('<a href="java&#115;cript:#X#">x</a>', /javascript/);
    refused('<img src="data:text/html,x">', /only http/);
    // a value can't turn a link into javascript: the attribute is dropped
    for (const v of ['javascript:alert(1)', ' JAVASCRIPT:alert(1)', 'java\nscript:alert(1)', 'vbscript:x'])
      assert.equal(render('<a href="#U#" title="t">x</a>', [{ U: v }]), '<a title="t">x</a>', v);
    assert.equal(render('<a href="#U#">x</a>', [{ U: '&#106;avascript:x' }]), '<a href="&amp;#106;avascript:x">x</a>', 'entities in values are text');
    assert.equal(render('<a href="mailto:#E#">#E#</a>', [{ E: 'a@b.c' }]), '<a href="mailto:a@b.c">a@b.c</a>');
  });
});

describe('components and plug-in files', () => {
  test('attributes are checked', () => {
    assert.equal(attributesProblem([{ name: 'LABEL' }, { name: 'S', type: 'select', options: ['a'] }, { name: 'C', type: 'checkbox' }]), null);
    assert.match(attributesProblem({})!, /JSON list/);
    assert.match(attributesProblem([{ name: 'label' }])!, /upper case/);
    assert.match(attributesProblem([{ name: 'LINK' }])!, /reserved/);
    assert.match(attributesProblem([{ name: 'A' }, { name: 'A' }])!, /twice/);
    assert.match(attributesProblem([{ name: 'A', type: 'html' }])!, /type/);
    assert.match(attributesProblem([{ name: 'A', type: 'select' }])!, /options/);
    assert.match(attributesProblem(Array.from({ length: 31 }, (_, i) => ({ name: `A${i}` })))!, /at most 30/);
    assert.match(componentProblem({ static_id: 'Bad Id', name: 'x', template: '<p></p>' })!, /Static id/);
    assert.match(componentProblem({ static_id: 'ok', name: 'x', template: '<p></p>', css_classes: ['evil'] })!, /CSS class/);
  });

  test('the example plug-ins are valid and survive a round trip', () => {
    const dir = new URL('../examples/plugins/', import.meta.url);
    // template component plug-ins (pgkiln-plugin/1); test/plugins.test.ts checks the others
    const files = readdirSync(dir).filter((f) => f.endsWith('.plugin.json') && JSON.parse(readFileSync(new URL(f, dir), 'utf8')).format === 'pgkiln-plugin/1');
    assert.ok(files.length >= 3);
    for (const f of files) {
      const doc = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
      const c = parsePlugin(doc);
      assert.ok(typeof c !== 'string', `${f}: ${c}`);
      assert.deepEqual(pluginDocument(c as TemplateComponent), doc, f);
    }
  });

  test('plug-in files of another format or with a bad template are refused', () => {
    const ok = { format: 'pgkiln-plugin/1', type: 'template_component', static_id: 'x', name: 'X', template: '<p>#A#</p>' };
    assert.equal(typeof parsePlugin(ok), 'object');
    assert.match(parsePlugin([]) as string, /JSON object/);
    assert.match(parsePlugin({ ...ok, format: 'pgkiln-plugin/9' }) as string, /Unsupported plug-in format/);
    assert.match(parsePlugin({ ...ok, type: 'region_plugin' }) as string, /Unsupported plug-in type/);
    assert.match(parsePlugin({ ...ok, template: 1 }) as string, /"template" is missing/);
    assert.match(parsePlugin({ ...ok, template: '<p onclick="x">' }) as string, /Event handler/);
    assert.match(parsePlugin({ ...ok, css_classes: 'tc-grid' }) as string, /list/);
  });

  test('SQL: export and import a plug-in; the trigger refuses scripts', async () => {
    const doc = (await owner.one(`select meta.export_template_component($1, 'status_badge') as d`, [appId])).d;
    assert.equal(doc.format, 'pgkiln-plugin/1');
    assert.equal(doc.id, undefined);
    assert.equal(doc.app_id, undefined);
    const copy = { ...doc, static_id: 'test_badge', name: 'Test badge' };
    const id = (await owner.one('select meta.import_template_component($1, $2::jsonb) as id', [appId, JSON.stringify(copy)])).id;
    await assert.rejects(owner.query('select meta.import_template_component($1, $2::jsonb)', [appId, JSON.stringify(copy)]), /already exists/);
    assert.equal((await owner.one('select meta.import_template_component($1, $2::jsonb, true) as id', [appId, JSON.stringify({ ...copy, name: 'Again' })])).id, id);
    assert.equal((await owner.one('select name from meta.template_component where id = $1', [id])).name, 'Again');
    await assert.rejects(owner.query('select meta.import_template_component($1, $2::jsonb)', [appId, JSON.stringify({ ...copy, format: 'x' })]), /unsupported plug-in format/);
    for (const template of ['<script>x</script>', '<p onclick="x">', '<a href="javascript:x">', '<p>#A!RAW#</p>', '<p style="x">'])
      await assert.rejects(owner.query('select meta.import_template_component($1, $2::jsonb, true)', [appId, JSON.stringify({ ...copy, template })]), /not allowed/, template);
    await assert.rejects(owner.query(`update meta.template_component set wrapper = '<ol></ol>' where id = $1`, [id]), /APEX\$ROWS/);
    await assert.rejects(owner.query(`update meta.template_component set css_classes = '{evil}' where id = $1`, [id]), /check/);
  });
});

describe('builder helpers', () => {
  const badge: TemplateComponent = {
    static_id: 'badge', name: 'Badge', template: '<span class="tc-badge">#LABEL# #EXTRA#</span>{if ?FLAG/}!{endif/}',
    attributes: [{ name: 'LABEL', default: '#STATUS#' }, { name: 'MODE', type: 'select', options: ['a', 'b'], default: 'a' }, { name: 'ON', type: 'checkbox' }],
  };

  test('sample rows, expected columns and the preview', () => {
    assert.deepEqual(sampleRows('a=1\nB = two\n\n\nc=3\nnot a line'), [new Map([['A', '1'], ['B', 'two']]), new Map([['C', '3']])]);
    assert.deepEqual(columnNames(badge).sort(), ['EXTRA', 'FLAG', 'STATUS']);
    const p = String(previewHtml(badge, 'STATUS=<b>x</b>\nEXTRA=y', false));
    assert.match(p, /<span class="tc-badge">&lt;b&gt;x&lt;\/b&gt; y<\/span>/);
    assert.match(String(previewHtml({ ...badge, template: '<script>' }, '', false)), /alert-error/);
  });

  test('region settings: only components and pages of the app; attributes of the chosen component', () => {
    const allowed = { pages: new Set([3]), components: new Map([['badge', badge]]) };
    assert.deepEqual(
      mergeTemplateRegionSettings({ component: 'badge', other: 1 }, { component: 'badge', display: 'multiple', max_rows: '20', empty: ' None ', link_page: '3', link_items: 'p3_id=#id#', attr_LABEL: '#job#', attr_MODE: 'a', attr_ON: 'Y', attr_NOPE: 'x' }, allowed),
      { component: 'badge', other: 1, display: 'multiple', max_rows: 20, empty: 'None', link: { page: 3, items: { P3_ID: '#id#' } }, attributes: { LABEL: '#job#', ON: 'Y' } },
    );
    assert.deepEqual(mergeTemplateRegionSettings({ component: 'badge', attributes: { LABEL: 'x' } }, { component: 'nope', display: 'grid', max_rows: '9999', link_page: '99' }, allowed), {});
    assert.deepEqual(mergeTemplateRegionSettings({ component: 'other' }, { component: 'badge', attr_LABEL: 'kept?' }, allowed), { component: 'badge' }, 'attributes of another component are not taken over');
  });

  test('column templates: known columns and components only; other settings kept', () => {
    const comps = new Map([['badge', badge]]);
    const b = { n: '3', col_0: 'status', tc_0: 'badge', attrs_0: 'LABEL=#status#\nNOPE=1\nmode=b', col_1: 'evil', tc_1: 'badge', col_2: 'ename', tc_2: 'missing' };
    assert.deepEqual(mergeColumnTemplates({ page_size: 10, column_templates: { old: {} } }, b, ['status', 'ename'], comps), {
      page_size: 10, column_templates: { status: { component: 'badge', attributes: { LABEL: '#status#', MODE: 'b' } } },
    });
    assert.deepEqual(mergeColumnTemplates({ column_templates: { status: { component: 'badge' } } }, { n: '1', col_0: 'status', tc_0: '' }, ['status'], comps), {});
  });
});

describe('at run time', () => {
  test('page 19: contact cards with checksummed links, a timeline, badges in the report', async () => {
    const b = new Browser(app);
    await b.login('king');
    const res = await b.get('/a/hr/19');
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /<div class="tc-region tc-grid"><article class="tc-card">/);
    assert.match(res.body, /<a href="\/a\/hr\/3\?P3_EMPNO=\d+&amp;cs=[0-9a-f]+" data-dialog>/, 'links to the modal form');
    assert.match(res.body, /<ol class="tc-timeline"><li class="tc-timeline-item tc-state-info">/);
    assert.match(res.body, /<td class="tc-cell" data-label="Status"><span class="tc-badge tc-badge-(success|warning|danger)">/);
    assert.doesNotMatch(res.body, /alert-error/);
  });

  test('without access to the linked page, the cards have no link', async () => {
    const b = new Browser(app);
    await b.login('allen'); // not a manager: page 3 is closed
    const res = await b.get('/a/hr/19');
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /<article class="tc-card">/);
    assert.doesNotMatch(res.body, /href="\/a\/hr\/3(?![0-9])/);
  });

  test('data from the database is text, never markup', async () => {
    await owner.query(`update hr.emp set ename = '"><img src=x onerror=alert(1)>', job = 'x" onmouseover="alert(1)' where empno = 7788`);
    try {
      const b = new Browser(app);
      await b.login('king');
      const res = await b.get('/a/hr/19');
      assert.equal(res.statusCode, 200);
      assert.doesNotMatch(res.body, /<img src=x|" onmouseover=/i);
      assert.match(res.body, /&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;/i);
    } finally {
      await owner.query(`update hr.emp set ename = 'SCOTT', job = 'ANALYST' where empno = 7788`);
    }
  });

  test('a missing or broken component shows a message, not the template', async () => {
    const r = page19.regions.find((x) => x.type === 'template_component')!;
    const b = new Browser(app);
    await b.login('king');
    await owner.query('update meta.region set config = $2 where id = $1', [r.id, JSON.stringify({ component: 'no_such' })]);
    assert.match((await b.get('/a/hr/19')).body, /The template component &quot;no_such&quot; does not exist/);
    // a component that slipped past the trigger (a coarse check) is checked again when rendered
    await owner.query(`insert into meta.template_component (app_id, static_id, name, template) values ($1, 'test_broken', 'Broken', '<p title=x>a</p>')`, [appId]);
    await owner.query('update meta.region set config = $2 where id = $1', [r.id, JSON.stringify({ component: 'test_broken' })]);
    const body = (await b.get('/a/hr/19')).body;
    assert.match(body, /The template component &quot;Broken&quot; is not valid/);
    assert.doesNotMatch(body, /<p title=x>/);
    await owner.query('update meta.region set config = $2 where id = $1', [r.id, JSON.stringify(r.config)]);
  });
});

describe('builder', () => {
  let b: Browser;
  let cardId: number;
  before(async () => {
    b = new Browser(app);
    await b.get('/builder/login');
    await b.submit('/builder/login', { username: 'admin', password: 'admin' });
    cardId = (await owner.one(`select id from meta.template_component where app_id = $1 and static_id = 'contact_card'`, [appId])).id;
  });

  test('Shared Components: list, editor with attributes and preview, where used', async () => {
    assert.match((await b.get(`/builder/apps/${appId}/shared`)).body, /Template components/);
    const page = (await b.get(`/builder/apps/${appId}/shared?c=template_component-${cardId}`)).body;
    for (const s of ['Custom attributes', 'Preview', 'Download plug-in file', '<code>#INITIALS#</code>', 'class="tc-preview"']) assert.ok(page.includes(s), s);
    assert.match(page, /Used in/);
    assert.match(page, /Team/, 'the region on page 19');
    const preview = (await b.get(`/builder/apps/${appId}/shared?${new URLSearchParams({ c: `template_component-${cardId}`, sample: 'NAME=<script>alert(1)</script>' })}`)).body;
    assert.match(preview, /<h3 class="tc-title"><a href="#">&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/a>/);
    assert.match((await b.get(`/builder/apps/${appId}/shared?new=template_component`)).body, /Import a plug-in/);
  });

  test('saving: the template is checked; good ones are stored', async () => {
    const form = { name: 'Test chip', static_id: 'test_chip', version: '1', description: '', template: '<span class="tc-badge">#LABEL#</span>', wrapper: '', css_classes: 'tc-inline, tc-compact', attributes: '[{"name": "LABEL", "default": "#ename#"}]' };
    let res = await b.submit(`/builder/apps/${appId}/shared/template_component`, form);
    assert.equal(res.statusCode, 303);
    const row = await owner.one(`select * from meta.template_component where app_id = $1 and static_id = 'test_chip'`, [appId]);
    assert.deepEqual(row.css_classes, ['tc-inline', 'tc-compact']);
    assert.deepEqual(row.attributes, [{ name: 'LABEL', default: '#ename#' }]);
    res = await b.submit(`/builder/apps/${appId}/shared/template_component/${row.id}`, { ...form, attributes: '', template: '<span onclick="x()">#LABEL#</span>' });
    assert.equal(res.statusCode, 303);
    assert.match((await b.get(String(res.headers.location))).body, /Event handler attributes/);
    assert.equal((await owner.one('select template from meta.template_component where id = $1', [row.id])).template, form.template, 'not saved');
    await b.submit(`/builder/apps/${appId}/shared/template_component/${row.id}/delete`, {});
  });

  test('plug-in download and import', async () => {
    const dl = await b.get(`/builder/apps/${appId}/template-components/${cardId}/export`);
    assert.equal(dl.statusCode, 200);
    assert.match(String(dl.headers['content-disposition']), /attachment; filename="contact_card\.plugin\.json"/);
    const doc = JSON.parse(dl.body);
    assert.deepEqual(doc, JSON.parse(readFileSync(new URL('../examples/plugins/contact-card.plugin.json', import.meta.url), 'utf8')));
    assert.equal((await b.get(`/builder/apps/${appId + 100000}/template-components/${cardId}/export`)).statusCode, 404, 'another app');

    const url = `/builder/apps/${appId}/template-components/import`;
    const imp = async (plugin: string, replace?: boolean) => {
      const res = await b.submit(url, { plugin, ...(replace ? { replace: 'true' } : {}) });
      assert.equal(res.statusCode, 303);
      return (await b.get(String(res.headers.location))).body;
    };
    assert.match(await imp(JSON.stringify({ ...doc, static_id: 'test_card' })), /Template component Contact card imported/);
    assert.match(await imp(JSON.stringify({ ...doc, static_id: 'test_card' })), /already exists/);
    assert.match(await imp(JSON.stringify({ ...doc, static_id: 'test_card', name: 'Card 2' }), true), /Card 2 imported/);
    assert.match(await imp('{not json'), /not valid JSON/);
    assert.match(await imp(JSON.stringify({ ...doc, static_id: 'test_evil', template: '<img src="x" onerror="alert(1)">' })), /Event handler/);
    assert.equal((await owner.one(`select count(*)::int as n from meta.template_component where static_id = 'test_evil'`)).n, 0);
  });

  test('page designer: region settings and column templates', async () => {
    const region = page19.regions.find((x) => x.type === 'template_component')!;
    const report = page19.regions.find((x) => x.type === 'report')!;
    let page = (await b.get(`/builder/pages/${page19.id}?c=region-${region.id}`)).body;
    assert.match(page, /Template component settings/);
    assert.match(page, /<code>initials<\/code>/, 'the columns of the query');
    let res = await b.submit(`/builder/pages/${page19.id}/region/${region.id}/template-settings`, { component: 'contact_card', attr_SUBTITLE: '#email#', link_page: '3', link_items: 'P3_EMPNO=#empno#', max_rows: '5' });
    assert.equal(res.statusCode, 303);
    assert.deepEqual((await owner.one('select config from meta.region where id = $1', [region.id])).config, {
      component: 'contact_card', attributes: { SUBTITLE: '#email#' }, link: { page: 3, items: { P3_EMPNO: '#empno#' } }, max_rows: 5,
    });

    page = (await b.get(`/builder/pages/${page19.id}?c=region-${report.id}`)).body;
    assert.match(page, /Column templates/);
    res = await b.submit(`/builder/pages/${page19.id}/region/${report.id}/column-templates`, { n: '2', col_0: 'status', tc_0: 'status_badge', attrs_0: 'LABEL=#status# (#days#)', col_1: 'employee', tc_1: 'contact_card' });
    assert.equal(res.statusCode, 303);
    const cfg = (await owner.one('select config from meta.region where id = $1', [report.id])).config;
    assert.deepEqual(cfg.column_templates, { status: { component: 'status_badge', attributes: { LABEL: '#status# (#days#)' } }, employee: { component: 'contact_card' } });
    assert.equal(cfg.page_size, 10, 'other settings kept');

    // the wrong region type, page or a forged token
    assert.equal((await b.submit(`/builder/pages/${page19.id}/region/${report.id}/template-settings`, {})).statusCode, 404);
    assert.equal((await b.submit(`/builder/pages/${page19.id}/region/${region.id}/column-templates`, {})).statusCode, 404);
    assert.equal((await b.submit(`/builder/pages/${page19.id + 100000}/region/${region.id}/template-settings`, {})).statusCode, 404);
  });
});

describe('built-in components', () => {
  test('every built-in passes the same checks as a plug-in and survives a round trip', async () => {
    const { BUILTIN_COMPONENTS } = await import('../src/runtime/builtin-components.ts');
    assert.deepEqual(BUILTIN_COMPONENTS.map((c) => c.static_id).sort(), ['ut_avatar', 'ut_badge', 'ut_comments', 'ut_media_list', 'ut_metric_card', 'ut_timeline']);
    for (const c of BUILTIN_COMPONENTS) {
      assert.equal(componentProblem(c), null, c.static_id);
      assert.equal(attributesProblem(c.attributes ?? []), null, c.static_id);
      const back = parsePlugin(JSON.parse(JSON.stringify(pluginDocument(c))));
      assert.ok(typeof back !== 'string', `${c.static_id}: ${back}`);
    }
  });

  test('HR page 39 shows them; values are escaped; the media list links to the dialog with a checksum', async () => {
    const king = new Browser(app);
    await king.login('king');
    const body = (await king.get('/a/hr/39')).body;
    for (const cls of ['tc-metrics', 'tc-avatar-group', 'tc-timeline', 'tc-media-list', 'tc-comments']) assert.ok(body.includes(`class="${cls}"`), cls);
    assert.match(body, /<a href="\/a\/hr\/5\?P5_DEPTNO=10&amp;cs=[0-9a-f]+" data-dialog>Accounting<\/a>/);
    const leave = await owner.one(`insert into hr.leave_request (empno, start_date, end_date, days, reason) values (7839, current_date, current_date, 1, '<img src=x onerror=alert(1)>') returning id`);
    try {
      const again = (await king.get('/a/hr/39')).body;
      assert.ok(again.includes('&lt;img src=x onerror=alert(1)&gt;'));
      assert.ok(!again.includes('<img src=x'));
    } finally {
      await owner.query('delete from hr.leave_request where id = $1', [leave.id]);
    }
  });

  test("the application's component with the same static id replaces the built-in one", async () => {
    const king = new Browser(app);
    await king.login('king');
    await owner.query(
      `insert into meta.template_component (app_id, static_id, name, template, attributes) values ($1, 'ut_avatar', 'My avatar', '<b class="tc-title">#NAME#</b>', '[{"name": "NAME", "default": "#NAME#"}]')`,
      [appId],
    );
    try {
      const body = (await king.get('/a/hr/39')).body;
      assert.match(body, /<b class="tc-title">King<\/b>/);
      assert.doesNotMatch(body, /class="tc-avatar tc-avatar-md" title="King"/);
    } finally {
      await owner.query(`delete from meta.template_component where app_id = $1 and static_id = 'ut_avatar'`, [appId]);
    }
  });

  test('builder: listed under New template component, copied into the application, offered in region settings', async () => {
    const b = new Browser(app);
    await b.get('/builder/login');
    await b.submit('/builder/login', { username: 'admin', password: 'admin' });
    const page = (await b.get(`/builder/apps/${appId}/shared?new=template_component`)).body;
    assert.match(page, /Built-in components/);
    assert.match(page, /<code>ut_metric_card<\/code>/);
    assert.equal((await b.submit(`/builder/apps/${appId}/template-components/copy`, { static_id: 'no_such' })).statusCode, 404);
    await b.get(`/builder/apps/${appId}/shared?new=template_component`);
    assert.equal((await b.post(`/builder/apps/${appId}/template-components/copy`, { __csrf: 'forged', static_id: 'ut_badge' })).statusCode, 403);
    try {
      assert.equal((await b.submit(`/builder/apps/${appId}/template-components/copy`, { static_id: 'ut_badge' })).statusCode, 303);
      const row = await owner.one(`select name, template from meta.template_component where app_id = $1 and static_id = 'ut_badge'`, [appId]);
      assert.equal(row.name, 'Badge');
      // a second copy doesn't overwrite the application's own
      await b.get(`/builder/apps/${appId}/shared?new=template_component`);
      await b.submit(`/builder/apps/${appId}/template-components/copy`, { static_id: 'ut_badge' });
      assert.equal((await owner.one(`select count(*)::int as n from meta.template_component where app_id = $1 and static_id = 'ut_badge'`, [appId])).n, 1);
    } finally {
      await owner.query(`delete from meta.template_component where app_id = $1 and static_id = 'ut_badge'`, [appId]);
    }
    const region = await owner.one(`select r.id, r.page_id from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 39 and r.seq = 10`, [appId]);
    const designer = (await b.get(`/builder/pages/${region.page_id}?c=region-${region.id}`)).body;
    assert.match(designer, /<option value="ut_metric_card" selected>Metric card \(built in\)<\/option>/);
  });
});
