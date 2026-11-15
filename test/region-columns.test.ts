// (sprint 205, AX-1) Report, grid, cards and calendar columns in the Page Designer: a Columns node in the tree under
// the region (the query's columns in their order, then those its settings still name), a column's properties in the
// property editor (one column, or several: what they share), saved by the toolbar's Save into the region's config as
// before (headings, formats, column_options, hidden, pdf, link; a grid's readonly and columns), and the Attributes
// tab's Columns group as a shortcut to the node.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { configuredColumns, mergeColumnSettings, selectedColumns } from '../src/builder/region-columns.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let dev: Browser;
let appId: number;
const PAGE_NO = 9205;
let pageId: number;
let report: number;
let grid: number;
let cards: number;
let calendar: number;

before(async () => {
  app = await buildApp({ logger: false });
  dev = new Browser(app);
  await dev.get('/builder/login');
  await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  await owner.query('delete from meta.page where app_id = $1 and page_no = $2', [appId, PAGE_NO]);
  pageId = (await owner.one(`insert into meta.page (app_id, page_no, name) values ($1, $2, 'Columns') returning id`, [appId, PAGE_NO])).id;
  const region = async (seq: number, title: string, type: string, source: string, config: object) =>
    (await owner.one(`insert into meta.region (page_id, seq, title, type, source, config, table_name) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [pageId, seq, title, type, source, JSON.stringify(config), type === 'grid' ? 'hr.emp' : null])).id as number;
  report = await region(10, 'Staff', 'report', 'select empno, ename, sal, comm from hr.emp',
    { headings: { sal: 'Salary', gone: 'Old column' }, link: { column: 'empno', page: 3, items: { P3_EMPNO: '#empno#' }, icon: true }, keep_me: 1 });
  grid = await region(20, 'Grid', 'grid', 'select empno, ename, job, deptno from hr.emp', { readonly: ['job'], columns: { deptno: { lov: 'select 1' } } });
  cards = await region(30, 'Cards', 'cards', 'select ename as title, job as subtitle, sal as badge from hr.emp', {});
  calendar = await region(40, 'Calendar', 'calendar', 'select hiredate as start_date, ename as title, empno from hr.emp', {});
});

after(async () => {
  await owner.query('delete from meta.page where app_id = $1 and page_no = $2', [appId, PAGE_NO]);
  await app.close();
  await closePools();
});

const designer = (q: string) => dev.get(`/builder/pages/${pageId}?${q}`).then((r) => r.body);
const config = async (id: number) => (await owner.one('select config from meta.region where id = $1', [id])).config;
const propertyEditor = (page: string) => page.slice(page.indexOf('<div class="pe">'), page.indexOf('<details class="pe-help"'));
const decode = (v: string) => v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const attr = (tag: string, a: string) => new RegExp(`\\s${a}="([^"]*)"`).exec(tag)?.[1];

/** What the toolbar's Save posts: the controls of form#pd-form, as a browser sends them. */
function saveForm(page: string): Record<string, string | string[]> {
  const start = page.indexOf('id="pd-form"');
  const text = page.slice(start, page.indexOf('</form>', start));
  const out: Record<string, string | string[]> = {};
  const add = (k: string, v: string) => {
    const was = out[k];
    out[k] = was === undefined ? v : ([] as string[]).concat(was, v);
  };
  for (const [tag] of text.matchAll(/<input\b[^>]*>/g)) {
    const name = attr(tag, 'name');
    const type = attr(tag, 'type') ?? 'text';
    if (!name || ((type === 'checkbox' || type === 'radio') && !/\schecked\b/.test(tag))) continue;
    add(name, decode(attr(tag, 'value') ?? ''));
  }
  for (const m of text.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
    const sel = /<option\b[^>]*\sselected\b[^>]*>/.exec(m[2])?.[0] ?? /<option\b[^>]*>/.exec(m[2])?.[0];
    add(attr(m[1], 'name')!, decode((sel && attr(sel, 'value')) ?? ''));
  }
  for (const m of text.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)) add(attr(m[1], 'name')!, decode(m[2]));
  return out;
}
const save = (rid: number, form: Record<string, string | string[]>) => dev.request('POST', `/builder/pages/${pageId}/region/${rid}/columns`, form);

describe('sprint 205 AX-1: columns in the Page Designer', () => {
  test('the tree: a Columns node under report, grid, cards and calendar regions, the query\'s order, stale ones after', async () => {
    const page = await designer('');
    const node = (rid: number) => [...page.matchAll(new RegExp(`data-kind="column" data-id="${rid}" data-col="([^"]+)"`, 'g'))].map((m) => m[1]);
    assert.deepEqual(node(report), ['empno', 'ename', 'sal', 'comm', 'gone']);
    assert.deepEqual(node(grid), ['empno', 'ename', 'job', 'deptno']);
    assert.deepEqual(node(cards), ['title', 'subtitle', 'badge']);
    assert.deepEqual(node(calendar), ['start_date', 'title', 'empno']);
    // the Columns folder comes first under the region; a column's note is its heading and type
    assert.match(page, new RegExp(`data-id="${report}"[^>]*>[\\s\\S]*?</a><ul><li data-collapsed><span class="pd-node pd-folder"><span class="pd-label">Columns</span>`));
    assert.match(page, /data-col="sal" title="sal \(Salary · numeric\)">[\s\S]*?<span class="pd-label">sal<\/span><span class="pd-note">Salary · numeric<\/span>/);
    assert.match(page, /data-col="gone"[^>]*>[\s\S]*?not in the query/);
    // each column is a link (also without JavaScript)
    assert.match(page, new RegExp(`<a class="pd-node" href="/builder/apps/${appId}/pages/${PAGE_NO}\\?c=column-${report}&amp;col=sal"`));
  });

  test('a region whose query can\'t be read: the folder says so', async () => {
    const bad = (await owner.one(`insert into meta.region (page_id, seq, title, type, source) values ($1, 50, 'Broken', 'report', 'select nope from nowhere') returning id`, [pageId])).id;
    try {
      const page = await designer('');
      assert.match(page, new RegExp(`data-id="${bad}"[^>]*>[\\s\\S]*?<span class="pd-label">Columns</span></span><ul><li class="pd-empty">The columns could not be read</li>`));
    } finally {
      await owner.query('delete from meta.region where id = $1', [bad]);
    }
  });

  test('a column\'s properties: heading and format, saved by the toolbar\'s Save; other settings kept', async () => {
    const page = await designer(`c=column-${report}&col=sal`);
    assert.match(page, /aria-current="true" data-kind="column" data-id="\d+" data-col="sal"/);
    const pe = propertyEditor(page);
    assert.match(page, /<div class="pe-title">[\s\S]*?Column: sal \(Staff\)/);
    assert.match(pe, new RegExp(`<form method="post" action="/builder/pages/${pageId}/region/${report}/columns" class="component-form" id="pd-form">`));
    assert.match(pe, /<input id="f_col_heading" name="heading" value="Salary"/);
    assert.match(pe, /<input id="f_col_format" name="format" value=""/);
    assert.match(pe, /<dt>Data type<\/dt><dd>numeric<\/dd>/);
    assert.match(page, /class="btn btn-sm tb-save" form="pd-form"/);
    assert.doesNotMatch(page, /id="pd-r-attrs"/, 'no Attributes tab for a column');
    const res = await save(report, { ...saveForm(page), heading: 'Monthly salary', format: 'FML999G990D00' });
    assert.equal(res.statusCode, 303);
    assert.equal(res.headers.location, `/builder/pages/${pageId}?c=column-${report}&col=sal`);
    const c = await config(report);
    assert.equal(c.headings.sal, 'Monthly salary');
    assert.equal(c.formats.sal, 'FML999G990D00');
    assert.equal(c.keep_me, 1);
    assert.deepEqual(c.link, { column: 'empno', page: 3, items: { P3_EMPNO: '#empno#' }, icon: true });
    assert.equal(c.headings.gone, 'Old column');
    const again = await designer(`c=column-${report}&col=sal`);
    assert.match(again, /Column sal saved\./);
    assert.match(again, /name="heading" value="Monthly salary"/);
  });

  test('only the fields that changed are applied: a change made elsewhere meanwhile is kept', async () => {
    const page = await designer(`c=column-${report}&col=comm`);
    await owner.query(`update meta.region set config = config || '{"formats": {"sal": "FML999G990D00", "comm": "999G990"}}' where id = $1`, [report]);
    await save(report, { ...saveForm(page), heading: 'Commission' });
    const c = await config(report);
    assert.equal(c.headings.comm, 'Commission');
    assert.equal(c.formats.comm, '999G990', 'the format typed on another tab meanwhile');
  });

  test('a mask that is not valid is not saved; the rest is', async () => {
    const page = await designer(`c=column-${report}&col=ename`);
    await save(report, { ...saveForm(page), heading: 'Name', format: '9X9' });
    const c = await config(report);
    assert.equal(c.headings.ename, 'Name');
    assert.equal(c.formats.ename, undefined);
    assert.match(await designer(`c=column-${report}&col=ename`), /alert-error[\s\S]{0,200}Saved, except: ename:/);
  });

  test('Shown, Display, In PDF and PDF width', async () => {
    const page = await designer(`c=column-${report}&col=comm`);
    const form = saveForm(page);
    delete form.shown;
    await save(report, { ...form, display: 'to-col-right', width: '30' });
    let c = await config(report);
    assert.deepEqual(c.hidden, ['comm']);
    assert.deepEqual(c.column_options.comm, ['to-col-right']);
    assert.equal(c.pdf.widths.comm, 30);
    assert.equal(c.pdf.columns, undefined, 'the PDF prints what is shown');
    // printed although hidden: the PDF gets its own list
    const p2 = saveForm(await designer(`c=column-${report}&col=comm`));
    await save(report, { ...p2, print: 'true' });
    c = await config(report);
    assert.deepEqual(c.pdf.columns, ['empno', 'ename', 'sal', 'comm']);
    // shown again: the lists agree and the PDF's own list goes
    const p3 = saveForm(await designer(`c=column-${report}&col=comm`));
    await save(report, { ...p3, shown: 'true', display: '', width: '' });
    c = await config(report);
    assert.equal(c.hidden, undefined);
    assert.equal(c.pdf?.columns, undefined);
    assert.equal(c.column_options, undefined);
    assert.equal(c.pdf?.widths, undefined);
  });

  test('the link moves to the column that gets a page, and goes with "no link"', async () => {
    const page = await designer(`c=column-${report}&col=ename`);
    assert.match(propertyEditor(page), /<select id="f_col_link_page" name="link_page"><option value="" selected>- no link -<\/option>/);
    await save(report, { ...saveForm(page), link_page: '3', link_items: 'P3_EMPNO=#empno#' });
    assert.deepEqual((await config(report)).link, { column: 'ename', page: 3, items: { P3_EMPNO: '#empno#' }, icon: true });
    // a page of another application (or none) is refused
    await save(report, { ...saveForm(await designer(`c=column-${report}&col=ename`)), link_page: '999999' });
    assert.equal((await config(report)).link.page, 3);
    // "no link" on another column leaves the link alone; on its column, removes it
    await save(report, { ...saveForm(await designer(`c=column-${report}&col=sal`)), heading: 'Salary' });
    assert.equal((await config(report)).link.column, 'ename');
    await save(report, { ...saveForm(await designer(`c=column-${report}&col=ename`)), link_page: '' });
    assert.equal((await config(report)).link, undefined);
  });

  test('several columns: what they share, Mixed left as it is, per-column fields left out', async () => {
    await owner.query(`update meta.region set config = config || '{"column_options": {"sal": ["to-col-right"]}, "formats": {"sal": "999G990", "comm": "999G990"}}' where id = $1`, [report]);
    const page = await designer(`c=column-${report}&col=comm&col=sal`);
    assert.match(page, /<div class="pe-title">[\s\S]*?2 columns \(Staff\)/);
    assert.equal([...page.matchAll(/aria-current="true" data-kind="column"/g)].length, 2);
    const pe = propertyEditor(page);
    assert.doesNotMatch(pe, /name="heading"|name="link_page"/);
    assert.match(pe, /<input id="f_col_format" name="format" value="999G990"/, 'the mask they share');
    assert.match(pe, /<select id="f_col_display" name="display"><option value="__mixed__" selected>Mixed: leave as they are<\/option>/);
    assert.match(pe, /<select id="f_col_shown" name="shown">/, 'a yes/no list instead of a checkbox');
    const form = saveForm(page);
    assert.deepEqual(form.col, ['sal', 'comm']);
    await save(report, { ...form, shown: 'false', format: '990' });
    const c = await config(report);
    assert.deepEqual(c.hidden, ['sal', 'comm']);
    assert.equal(c.formats.sal, '990');
    assert.equal(c.formats.comm, '990');
    assert.deepEqual(c.column_options, { sal: ['to-col-right'] }, 'Mixed: each keeps its own');
    assert.equal(c.headings.sal, 'Salary', 'no heading for several columns');
    // a Mixed text field left empty keeps each value
    await owner.query(`update meta.region set config = config || '{"formats": {"sal": "999", "comm": "990"}, "hidden": []}' where id = $1`, [report]);
    const p2 = await designer(`c=column-${report}&col=sal&col=comm`);
    assert.match(propertyEditor(p2), /name="mixed_format" value="1"/);
    await save(report, saveForm(p2));
    assert.deepEqual((await config(report)).formats, { sal: '999', comm: '990' });
  });

  test('select several columns without JavaScript: a GET form of checkboxes', async () => {
    const pe = propertyEditor(await designer(`c=column-${report}&col=sal`));
    assert.match(pe, new RegExp(`<form method="get" action="/builder/apps/${appId}/pages/${PAGE_NO}" class="pd-colpick-form">\\s*<input type="hidden" name="c" value="column-${report}">`));
    assert.match(pe, /<input type="checkbox" name="col" value="sal" checked>/);
    assert.match(pe, /<input type="checkbox" name="col" value="ename">/);
  });

  test('a grid column: heading, shown, read-only, required, edit as and its validation', async () => {
    const page = await designer(`c=column-${grid}&col=job`);
    const pe = propertyEditor(page);
    assert.match(pe, /id="f_col_readonly" name="readonly" value="true" checked/);
    assert.doesNotMatch(pe, /name="format"|name="print"/);
    const form = saveForm(page);
    delete form.readonly;
    await save(grid, { ...form, required: 'true', lov: 'LOV:DEPARTMENTS', validation: ':JOB is not null', validation_message: 'A job' });
    let c = await config(grid);
    assert.equal(c.readonly, undefined);
    assert.deepEqual(c.columns.job, { required: true, lov: 'LOV:DEPARTMENTS', validation: ':JOB is not null', validation_message: 'A job' });
    assert.deepEqual(c.columns.deptno, { lov: 'select 1' }, 'a custom list of values is kept');
    // a list of values that isn't a shared one of this application: refused
    await save(grid, { ...saveForm(await designer(`c=column-${grid}&col=job`)), lov: 'select password_hash from meta.developer' });
    assert.equal((await config(grid)).columns.job.lov, 'LOV:DEPARTMENTS');
    // the custom one is offered for the column that has it, unchanged
    const dp = await designer(`c=column-${grid}&col=deptno`);
    assert.match(propertyEditor(dp), /<option value="select 1" selected>custom: select 1<\/option>/);
    await save(grid, { ...saveForm(dp), heading: 'Department' });
    c = await config(grid);
    assert.deepEqual(c.columns.deptno, { lov: 'select 1' });
    assert.equal(c.headings.deptno, 'Department');
  });

  test('cards: a format mask; calendar: what the column is read as, no Save', async () => {
    const page = await designer(`c=column-${cards}&col=badge`);
    assert.match(propertyEditor(page), /<dt>Read as<\/dt><dd>Badge<\/dd>/);
    await save(cards, { ...saveForm(page), format: 'FML999G990' });
    assert.deepEqual((await config(cards)).formats, { badge: 'FML999G990' });
    const cal = await designer(`c=column-${calendar}&col=empno`);
    assert.match(propertyEditor(cal), /<dt>Read as<\/dt><dd>Not shown; links can use it as #empno#<\/dd>/);
    assert.match(propertyEditor(cal), /no settings per column/);
    assert.doesNotMatch(cal, /class="btn btn-sm tb-save"/);
    assert.match(propertyEditor(await designer(`c=column-${calendar}&col=start_date`)), /<dd>Start of the event<\/dd>/);
  });

  test('unknown columns and regions: refused, nothing saved', async () => {
    const before = await config(report);
    const page = await designer(`c=column-${report}&col=sal`);
    const res = await save(report, { ...saveForm(page), col: ['sal', 'password_hash'], format: '990' });
    assert.equal(res.statusCode, 303);
    assert.deepEqual(await config(report), before);
    assert.match(await designer(`c=column-${report}&col=sal`), /This region has no column password_hash: nothing was saved\./);
    // a region type without columns, and a column that doesn't exist in the address
    const st = (await owner.one(`insert into meta.region (page_id, seq, title, type) values ($1, 60, 'Static', 'static') returning id`, [pageId])).id;
    assert.equal((await save(st, { ...saveForm(page) })).statusCode, 404);
    await owner.query('delete from meta.region where id = $1', [st]);
    assert.match(propertyEditor(await designer(`c=column-${report}&col=nope`)), /Component not found\./);
  });

  test('the Attributes tab\'s Columns group selects the column\'s node', async () => {
    const page = await designer(`c=region-${report}`);
    assert.match(page, new RegExp(`<a href="/builder/pages/${pageId}\\?c=column-${report}&amp;col=sal" title="Open column sal in the tree"><code>sal</code></a>`));
    const g = await designer(`c=region-${grid}`);
    assert.match(g, new RegExp(`<a href="/builder/pages/${pageId}\\?c=column-${grid}&amp;col=job"`));
  });

  test('in the builder\'s language', async () => {
    await owner.query(`update meta.developer set language = 'de' where username = 'admin'`);
    try {
      // the language is taken at sign-in
      const de = new Browser(app);
      await de.get('/builder/login');
      await de.submit('/builder/login', { username: 'admin', password: 'admin' });
      const page = (await de.get(`/builder/pages/${pageId}?c=column-${report}&col=sal`)).body;
      assert.match(page, /<span class="pd-label">Spalten<\/span>/);
      assert.match(page, /Spalte: sal \(Staff\)/);
      assert.match(propertyEditor(page), /<legend>Identifikation<\/legend>/);
    } finally {
      await owner.query(`update meta.developer set language = null where username = 'admin'`);
    }
  });

  test('helpers: configured columns, the selection in the region\'s order, the merge', () => {
    assert.deepEqual(configuredColumns('report', { hidden: ['a'], headings: { b: 'B' }, formats: { c: '9' }, column_options: { d: [] }, pdf: { columns: ['e'], widths: { f: 1 } } }), ['a', 'b', 'c', 'd', 'e', 'f']);
    assert.deepEqual(configuredColumns('grid', { hidden: ['a'], readonly: ['b'], headings: { c: 'C' }, columns: { d: {} } }), ['a', 'b', 'c', 'd']);
    assert.deepEqual(configuredColumns('calendar', { link: { column: 'x' } }), []);
    const list = { columns: [{ name: 'a', type: null, stale: false }, { name: 'b', type: null, stale: false }] };
    assert.deepEqual(selectedColumns(['b', 'a', 'zz'], list), ['a', 'b']);
    assert.deepEqual(selectedColumns('b', list), ['b']);
    assert.deepEqual(selectedColumns(undefined, list), []);
    const allowed = { pages: new Set([1]), lovs: new Set<string>() };
    // a field that isn't the type's, or a single column's field for several, is not applied
    const m = mergeColumnSettings('cards', { formats: { a: '9' } }, ['a', 'b'], ['a', 'b'], { heading: 'x', format: '990', readonly: 'true' }, allowed);
    assert.deepEqual(m.config, { formats: { a: '990', b: '990' } });
    const h = mergeColumnSettings('report', { headings: { a: 'A' } }, ['a', 'b'], ['a', 'b'], { heading: 'x' }, allowed);
    assert.deepEqual(h.config, { headings: { a: 'A' } });
    // empty settings objects are left out
    assert.deepEqual(mergeColumnSettings('report', { headings: { a: 'A' } }, ['a'], ['a'], { heading: '' }, allowed).config, {});
  });
});
