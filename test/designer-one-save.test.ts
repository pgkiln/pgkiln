// (sprint 202) The Page Designer's property editor: one Save for both tabs of a region (AX-2) and type names instead
// of type codes (AX-3).
//   AX-2: the Attributes tab's settings are part of the property editor's form (form="pd-form", names "<key>:<field>"),
//   the toolbar's Save sends them with the region's properties; no settings form has a Save button of its own and no
//   property label says JSON: the region's settings as JSON are in Utilities → Show as JSON.
//   AX-3: the tree, the layout and the Type lists say Interactive Report, Select List, Submit Page … in the builder's
//   language.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { REGION_TYPES, ITEM_TYPES, BUTTON_ACTIONS } from '../src/builder/arrange.ts';
import { COMPONENTS } from '../src/builder/components.ts';
import { embedSettings, settingsBodies } from '../src/builder/settings-save.ts';
import { DA_ACTION_LABELS, DA_EVENT_LABELS, PROCESS_TYPE_LABELS, VALIDATION_TYPE_LABELS, COMPUTATION_TYPE_LABELS, REGION_TEMPLATE_LABELS } from '../src/builder/type-names.ts';
import { html } from '../src/html.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let dev: Browser;
let appId: number;
const PAGE_NO = 9202;
let pageId: number;

before(async () => {
  app = await buildApp({ logger: false });
  dev = new Browser(app);
  await dev.get('/builder/login');
  await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  await owner.query('delete from meta.page where app_id = $1 and page_no = $2', [appId, PAGE_NO]);
  pageId = (await owner.one(`insert into meta.page (app_id, page_no, name) values ($1, $2, 'One Save') returning id`, [appId, PAGE_NO])).id;
});

after(async () => {
  await owner.query('delete from meta.page where app_id = $1 and page_no = $2', [appId, PAGE_NO]);
  await app.close();
  await closePools();
});

const decode = (v: string) => v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const attr = (tag: string, a: string) => new RegExp(`\\s${a}="([^"]*)"`).exec(tag)?.[1];

/** What a browser posts with the toolbar's Save: the controls inside form#pd-form and those with form="pd-form". */
function designerForm(page: string): Record<string, string | string[]> {
  const start = page.indexOf('<form method="post"', page.indexOf('id="pd-r-props"'));
  const inner = page.slice(start, page.indexOf('</form>', start));
  const outer = [...page.matchAll(/<(?:input|select|textarea)\b[^>]*\sform="pd-form"[^>]*>(?:[\s\S]*?<\/(?:select|textarea)>)?/g)].map((m) => m[0]).join('\n');
  const out: Record<string, string | string[]> = {};
  const add = (k: string, v: string) => {
    const was = out[k];
    out[k] = was === undefined ? v : ([] as string[]).concat(was, v);
  };
  for (const text of [inner, outer]) {
    for (const [tag] of text.matchAll(/<input\b[^>]*>/g)) {
      const name = attr(tag, 'name');
      const type = attr(tag, 'type') ?? 'text';
      if (!name || ['file', 'submit', 'button'].includes(type)) continue;
      if ((type === 'checkbox' || type === 'radio') && !/\schecked\b/.test(tag)) continue;
      add(name, decode(attr(tag, 'value') ?? ''));
    }
    for (const m of text.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
      const name = attr(m[1], 'name');
      const sel = /<option\b[^>]*\sselected\b[^>]*>/.exec(m[2])?.[0] ?? /<option\b[^>]*>/.exec(m[2])?.[0];
      if (name) add(name, decode((sel && attr(sel, 'value')) ?? ''));
    }
    for (const m of text.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)) {
      const name = attr(m[1], 'name');
      if (name) add(name, decode(m[2]));
    }
  }
  return out;
}

/** The property editor's part of a designer page. */
const propertyEditor = (page: string) => page.slice(page.indexOf('<div class="pe">'), page.indexOf('<details class="pe-help"'));
const visibleText = (h: string) => decode(h.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

describe('AX-2: one Save in the Page Designer', () => {
  test('embedSettings: the form becomes a group of the property editor form, names keyed, no CSRF of its own', () => {
    const form = html`<h3>Report settings</h3><form method="post" action="/builder/pages/7/region/9/report-settings" class="component-form"><input type="hidden" name="__csrf" value="t">
      <input id="a" name="page_size" value="15" placeholder="a > b"><select name="mobile"><option value="x">X</option></select><textarea name="note">&lt;input name="x"&gt;</textarea>
      <input type="checkbox" name="searchable" value="true" checked></form><form method="get" action="/elsewhere"><input name="q"></form>`;
    const out = String(embedSettings(form, 'pd-form', 'report'));
    assert.match(out, /^<input type="hidden" name="__region_type" value="report" form="pd-form">/);
    assert.match(out, /<div class="component-form pd-settings" data-settings="report-settings"><input type="hidden" name="__settings" value="report-settings" form="pd-form">/);
    assert.match(out, /<input id="a" name="report-settings:page_size" value="15" placeholder="a > b" form="pd-form">/);
    assert.match(out, /<select name="report-settings:mobile" form="pd-form">/);
    assert.match(out, /<textarea name="report-settings:note" form="pd-form">&lt;input name="x"&gt;<\/textarea>/);
    assert.match(out, /name="report-settings:searchable" value="true" checked form="pd-form">/);
    assert.doesNotMatch(out, /__csrf/);
    // another form (not a region's settings) is left as it is
    assert.match(out, /<form method="get" action="\/elsewhere"><input name="q"><\/form>/);
    assert.equal(String(embedSettings('', 'pd-form', 'report')), '');
  });

  test('settingsBodies: each form\'s fields without the key; unknown keys are not forms', () => {
    const forms = settingsBodies({ __settings: ['report-settings', 'ai-filter', 'BAD key'], 'report-settings:page_size': '25', 'ai-filter:service': '-', title: 'x', 'other:y': '1' });
    assert.deepEqual([...forms.keys()], ['report-settings', 'ai-filter']);
    assert.deepEqual(forms.get('report-settings'), { page_size: '25' });
    assert.deepEqual(forms.get('ai-filter'), { service: '-' });
    assert.equal(settingsBodies({ title: 'x' }).size, 0);
  });

  test('every region type: one Save control, no Save of a settings form, no property label with JSON', async () => {
    for (const type of REGION_TYPES()) {
      const r = (await owner.one(`insert into meta.region (page_id, seq, title, type, source) values ($1, 10, $2, $3, 'select 1 as id, ''a'' as label') returning id`, [pageId, `R ${type}`, type])).id;
      try {
        const page = (await dev.get(`/builder/pages/${pageId}?c=region-${r}`)).body;
        assert.equal([...page.matchAll(/class="btn btn-sm tb-save"/g)].length, 1, `${type}: the toolbar's Save`);
        const pe = propertyEditor(page);
        // the only button left in the property editor is Delete region (its own form, in the danger zone)
        const buttons = [...pe.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].filter((m) => !/type="button"/.test(m[0])).map((m) => visibleText(m[1]));
        assert.deepEqual(buttons, ['Delete region'], `${type}: buttons ${buttons.join(', ')}`);
        assert.doesNotMatch(pe, /These fields write/, type);
        const labels = [...pe.matchAll(/<(?:label|legend)\b[^>]*class="(?:label|check)"[^>]*>([\s\S]*?)<\/(?:label|legend)>/g)].map((m) => visibleText(m[1]));
        assert.deepEqual(labels.filter((l) => /\bJSON\b/.test(l)), [], `${type}: labels with JSON`);
        // every control of the Attributes tab goes with the toolbar's Save
        const attrs = /id="pd-r-attrs"[\s\S]*?<\/section>/.exec(page)?.[0] ?? '';
        assert.doesNotMatch(attrs, /<form\b/, `${type}: a form of its own`);
        const loose = [...attrs.matchAll(/<(?:input|select|textarea)\b[^>]*\sname="[^"]*"[^>]*>/g)].map((m) => m[0]).filter((t) => !/\sform="pd-form"/.test(t));
        assert.deepEqual(loose, [], `${type}: controls outside the property editor's form`);
        // Utilities → Show as JSON for the selected region
        assert.match(page, new RegExp(`href="/builder/apps/${appId}/pages/${PAGE_NO}\\?c=region-${r}&amp;json=1">[\\s\\S]{0,120}Show as JSON</a>`), type);
      } finally {
        await owner.query('delete from meta.region where id = $1', [r]);
      }
    }
  });

  test('the toolbar\'s Save saves the Region and the Attributes tab together; other settings keys are kept', async () => {
    const r = (await owner.one(`insert into meta.region (page_id, seq, title, type, source, config) values ($1, 10, 'Orders', 'report', 'select 1 as id, ''a'' as name', '{"keep_me": 1}') returning id`, [pageId])).id;
    const page = (await dev.get(`/builder/pages/${pageId}?c=region-${r}`)).body;
    const form = designerForm(page);
    assert.equal(form.__region_type, 'report');
    assert.deepEqual(form.__settings, ['report-settings', 'column-templates', 'ai-filter']);
    assert.ok('report-settings:page_size' in form && 'title' in form);
    assert.ok(!('config' in form), 'no settings as JSON in the Region tab');
    const res = await dev.request('POST', `/builder/pages/${pageId}/c/region/${r}`, { ...form, title: 'Orders 2', 'report-settings:page_size': '25' });
    assert.equal(res.statusCode, 303);
    assert.match(String(res.headers.location), new RegExp(`c=region-${r}$`));
    const row = await owner.one('select title, config from meta.region where id = $1', [r]);
    assert.equal(row.title, 'Orders 2');
    assert.equal(row.config.page_size, 25);
    assert.equal(row.config.keep_me, 1, 'a key without a field is kept');
    // one message: the region was saved
    const after = (await dev.get(`/builder/pages/${pageId}?c=region-${r}`)).body;
    assert.match(after, /Region saved\./);
    // a changed Type: the old type's settings are not applied to the new one
    const chart = await dev.request('POST', `/builder/pages/${pageId}/c/region/${r}`, { ...designerForm(after), type: 'chart', 'report-settings:page_size': '50' });
    assert.equal(chart.statusCode, 303);
    const now = await owner.one('select type, config from meta.region where id = $1', [r]);
    assert.equal(now.type, 'chart');
    assert.equal(now.config.page_size, 25);
    await owner.query('delete from meta.region where id = $1', [r]);
  });

  test('a settings form\'s problem is shown after the Save; its own route still works', async () => {
    const a = (await owner.one(`insert into meta.region (page_id, seq, title, type) values ($1, 20, 'Assistant', 'ai_assistant') returning id`, [pageId])).id;
    const page = (await dev.get(`/builder/pages/${pageId}?c=region-${a}`)).body;
    const res = await dev.request('POST', `/builder/pages/${pageId}/c/region/${a}`, { ...designerForm(page), title: 'Assistant 2', 'assistant:tools': '{nope' });
    assert.equal(res.statusCode, 303);
    const after = (await dev.get(`/builder/pages/${pageId}?c=region-${a}`)).body;
    assert.match(after, /Region saved\./);
    assert.match(after, /alert-error[^>]*>[\s\S]{0,200}not valid JSON/);
    assert.equal((await owner.one('select title from meta.region where id = $1', [a])).title, 'Assistant 2');
    await owner.query('delete from meta.region where id = $1', [a]);
    const r = (await owner.one(`insert into meta.region (page_id, seq, title, type, source) values ($1, 10, 'Asked', 'report', 'select 1 as id') returning id`, [pageId])).id;
    // the form's own route (API, older pages): its message and back to the region
    const own = await dev.submit(`/builder/pages/${pageId}/region/${r}/report-settings`, { n: '0', page_size: '10' });
    assert.equal(own.statusCode, 303);
    assert.equal((await owner.one('select config from meta.region where id = $1', [r])).config.page_size, 10);
    // another page's region is not found through this page
    assert.equal((await dev.submit(`/builder/pages/${pageId}/region/999999999/report-settings`, { n: '0' })).statusCode, 404);
    await owner.query('delete from meta.region where id = $1', [r]);
  });

  test('Show as JSON: every key, saved by the same Save, the Attributes tab left out', async () => {
    const r = (await owner.one(`insert into meta.region (page_id, seq, title, type, source, config) values ($1, 10, 'As JSON', 'chart', 'select ''a'' as label, 1 as v', '{"kind": "pie", "unknown_key": true}') returning id`, [pageId])).id;
    const page = (await dev.get(`/builder/pages/${pageId}?c=region-${r}&json=1`)).body;
    assert.doesNotMatch(page, /id="pd-r-attrs"/);
    assert.match(page, /<section class="tab-panel" id="pd-r-json" data-tab data-tab-active data-tab-force>/);
    assert.match(page, /<textarea id="f_region_config" name="config" form="pd-form"[^>]*data-code="json"[^>]*>[\s\S]*unknown_key/);
    assert.match(page, new RegExp(`<a href="/builder/apps/${appId}/pages/${PAGE_NO}\\?c=region-${r}">Show as fields</a>`));
    const form = designerForm(page);
    assert.ok(!('__settings' in form));
    const res = await dev.request('POST', `/builder/pages/${pageId}/c/region/${r}`, { ...form, config: '{"kind": "donut", "unknown_key": false}' });
    assert.equal(res.statusCode, 303);
    assert.match(String(res.headers.location), /&json=1$/, 'the JSON view stays open');
    assert.deepEqual((await owner.one('select config from meta.region where id = $1', [r])).config, { kind: 'donut', unknown_key: false });
    // not JSON: refused, nothing saved, back to the JSON view
    const bad = await dev.request('POST', `/builder/pages/${pageId}/c/region/${r}`, { ...form, config: '{nope' });
    assert.match(String(bad.headers.location), /&json=1$/);
    assert.deepEqual((await owner.one('select config from meta.region where id = $1', [r])).config, { kind: 'donut', unknown_key: false });
    await owner.query('delete from meta.region where id = $1', [r]);
  });

  test('items, buttons, dynamic actions and branches: no property label says JSON', () => {
    for (const k of ['region', 'item', 'button', 'dynamic_action', 'validation', 'process', 'computation', 'branch'])
      for (const f of COMPONENTS[k].fields) assert.doesNotMatch(f.hidden ? '' : f.label, /\bJSON\b/, `${k}.${f.name}`);
  });
});

describe('AX-3: type names in the Page Designer', () => {
  const CODES = new Set([...REGION_TYPES(), ...ITEM_TYPES(), ...BUTTON_ACTIONS(), ...Object.keys(DA_ACTION_LABELS), ...Object.keys(DA_EVENT_LABELS),
    ...Object.keys(PROCESS_TYPE_LABELS), ...Object.keys(VALIDATION_TYPE_LABELS), ...Object.keys(COMPUTATION_TYPE_LABELS), ...Object.keys(REGION_TEMPLATE_LABELS)]);
  /** a code shown: lower case words with an underscore, or a part (between →, :, · and brackets) that is a type code */
  const codes = (texts: string[]) => texts.filter((t) => /\b[a-z]+_[a-z_]+\b/.test(t) || t.split(/[()→:·]/).some((w) => CODES.has(w.trim())));
  /** a tree node's title is "name (type)": the name is the developer's */
  const note = (title: string) => /\(([^()]*)\)$/.exec(title)?.[1] ?? '';
  const SELECTS = ['f_region_type', 'f_region_template', 'f_item_type', 'f_button_action', 'f_dynamic_action_event', 'f_dynamic_action_action', 'f_process_type', 'f_validation_type', 'f_computation_type'];

  for (const no of [2, 3]) {
    test(`HR page ${no}: the tree, the layout and the Type lists show no type codes`, async () => {
      const p = await owner.one('select id from meta.page where app_id = $1 and page_no = $2', [appId, no]);
      const page = (await dev.get(`/builder/apps/${appId}/pages/${no}`)).body;
      const tree = [...page.matchAll(/<span class="pd-note">([^<]*)<\/span>/g)].map((m) => decode(m[1]));
      const titles = [...page.matchAll(/<a class="pd-node"[^>]*\stitle="([^"]*)"/g)].map((m) => note(decode(m[1])));
      const layout = [...page.matchAll(/<div class="pd-region-type">([^<]*)<\/div>/g)].map((m) => decode(m[1]));
      assert.ok(tree.length > 2 && titles.length > 2 && layout.length > 0);
      assert.deepEqual(codes([...tree, ...titles, ...layout]), [], 'codes in the tree or the layout');
      // every component of the page selected: its Type list's option texts
      const comps = [
        ...(await owner.query('select id from meta.region where page_id = $1', [p.id])).rows.map((x) => `region-${x.id}`),
        ...(await owner.query('select id from meta.item where page_id = $1', [p.id])).rows.map((x) => `item-${x.id}`),
        ...(await owner.query('select id from meta.button where page_id = $1', [p.id])).rows.map((x) => `button-${x.id}`),
        ...(await owner.query('select id from meta.dynamic_action where page_id = $1', [p.id])).rows.map((x) => `dynamic_action-${x.id}`),
        ...(await owner.query('select id from meta.process where page_id = $1', [p.id])).rows.map((x) => `process-${x.id}`),
        ...(await owner.query('select id from meta.validation where page_id = $1', [p.id])).rows.map((x) => `validation-${x.id}`),
        ...(await owner.query('select id from meta.computation where page_id = $1', [p.id])).rows.map((x) => `computation-${x.id}`),
      ];
      for (const c of comps) {
        const body = (await dev.get(`/builder/apps/${appId}/pages/${no}?c=${c}`)).body;
        const heading = visibleText(/<div class="pe-title">([\s\S]*?)<\/div>/.exec(body)?.[1] ?? '');
        assert.doesNotMatch(heading, /\b[a-z]+_[a-z_]+\b/, `${c}: heading ${heading}`);
        for (const id of SELECTS) {
          const sel = new RegExp(`<select id="${id}"[^>]*>([\\s\\S]*?)</select>`).exec(body)?.[1];
          if (!sel) continue;
          const options = [...sel.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => decode(m[1]));
          assert.deepEqual(codes(options), [], `${c}: ${id}`);
        }
      }
    });
  }

  test('in the builder\'s language', async () => {
    await owner.query(`update meta.developer set language = 'de' where username = 'admin'`);
    try {
      // the language is taken at sign-in
      const de = new Browser(app);
      await de.get('/builder/login');
      await de.submit('/builder/login', { username: 'admin', password: 'admin' });
      const page = (await de.get(`/builder/apps/${appId}/pages/3`)).body;
      assert.match(page, /<span class="pd-note">Auswahlliste<\/span>/);
      assert.match(page, /<span class="pd-note">P3_JOB → Wert festlegen<\/span>/);
      const p = await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 2 and r.type = 'report'`, [appId]);
      const body = (await de.get(`/builder/apps/${appId}/pages/2?c=region-${p.id}`)).body;
      assert.match(body, /<option value="report" selected>Interaktiver Bericht<\/option>/);
      assert.match(body, /Als JSON anzeigen/);
    } finally {
      await owner.query(`update meta.developer set language = null where username = 'admin'`);
    }
  });
});
