import type { FastifyInstance } from 'fastify';
import { designSql } from './websources.ts';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import {
  attributeValues, compiled, LAYOUT_CLASSES, parsePlugin, pluginDocument, renderInstances, rowLookup, TemplateError,
  type TcAttribute, type TemplateComponent, type TcUse,
} from '../runtime/template-components.ts';
import { BUILTIN_COMPONENTS, builtinComponents } from '../runtime/builtin-components.ts';
import type { Session } from '../session.ts';
import { linkItemsText, parseLinkItems, reportColumns } from './report-settings.ts';
import { back, BASE, csrf, developer, flash, type Req } from './ui.ts';
import { scopedTx as tx } from './i18n.ts';

// Template components in the builder:
//   - Shared Components → Template components: the extras under the
//     property form (attributes, a preview with sample rows, the plug-in
//     download) and the plug-in import (templates are checked again there);
//   - page designer: the settings of a template_component region, and the
//     column templates of a report region.
// The property form itself comes from template-spec.ts.

type Body = Record<string, string | undefined>;
type Config = Record<string, any>;

const opt = (value: string, label: string, current: unknown) => html`<option value="${value}"${String(current ?? '') === value ? raw(' selected') : ''}>${label}</option>`;

const asComponent = (row: any): TemplateComponent => ({ ...row, attributes: Array.isArray(row.attributes) ? row.attributes : [], css_classes: row.css_classes ?? [] });

/** "NAME=value" lines, rows separated by a blank line → one map per row (names upper case). */
export function sampleRows(text: string): Map<string, string>[] {
  return text
    .split(/\r?\n\s*\r?\n/)
    .map((block) => new Map(
      block.split(/\r?\n/)
        .map((l) => /^\s*([A-Za-z][A-Za-z0-9_$]*)\s*=(.*)$/.exec(l))
        .filter((m): m is RegExpExecArray => !!m)
        .map((m) => [m[1].toUpperCase(), m[2].trim()]),
    ))
    .filter((m) => m.size)
    .slice(0, 20);
}

/** The component rendered with sample rows, as the runtime would (links become "#"). */
export function previewHtml(c: TemplateComponent, sample: string, multiple: boolean): Raw {
  let comp;
  try {
    comp = compiled(c);
  } catch (e) {
    if (e instanceof TemplateError) return html`<div class="alert alert-error" role="alert">${e.message}</div>`;
    throw e;
  }
  const attrs = attributeValues(c, {});
  const rows = sampleRows(sample);
  const lookups = (rows.length ? rows : [new Map<string, string>()]).map((cols, n) => rowLookup(null, attrs, cols, { APEX$ROW_NUM: String(n + 1), LINK: '#' }));
  const layout = (c.css_classes ?? []).filter((k) => (LAYOUT_CLASSES as readonly string[]).includes(k));
  return html`<div class="${['tc-region', ...(layout.length ? layout : [tx('tpl.tc_list')])].join(' ')}">${raw(renderInstances(comp, lookups, rowLookup(null, attrs, new Map()), multiple))}</div>`;
}

/** Placeholders a template uses that are neither attributes nor built in: probably columns. */
export function columnNames(c: TemplateComponent) {
  const attrs = new Set((c.attributes ?? []).map((a) => a.name));
  const names = new Set<string>();
  for (const text of [c.template, ...(c.attributes ?? []).map((a) => a.default ?? '')])
    for (const m of (text ?? '').matchAll(/#([A-Za-z][A-Za-z0-9_$]*)(?:![A-Za-z]+)?#|\{(?:if|elsif|case|loop)\s+(?:"[^"]*"\s+)?[?!]?([A-Za-z][A-Za-z0-9_$]*)\s*\/\}/g)) {
      const n = (m[1] ?? m[2]).toUpperCase();
      if (!attrs.has(n) && n !== 'LINK' && !n.startsWith('APEX$')) names.add(n);
    }
  return [...names];
}

/** Shared Components → a template component: attributes, preview, plug-in download. */
export function templateExtras(appId: number, row: any, query: Record<string, string | undefined>) {
  const c = asComponent(row);
  const cols = columnNames(c);
  const sample = query.sample ?? cols.map((n) => `${n}=${n.toLowerCase()} 1`).join('\n') + (cols.length ? `\n\n${cols.map((n) => `${n}=${n.toLowerCase()} 2`).join('\n')}` : '');
  const multiple = query.multiple === '1';
  const attrs: TcAttribute[] = c.attributes ?? [];
  return html`<fieldset class="prop-group u-mt125"><legend>${tx('tpl.custom_attributes')}</legend>
      ${attrs.length
        ? html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>${tx('tpl.name')}</th><th>${tx('tpl.label')}</th><th>${tx('tpl.type')}</th><th>${tx('tpl.default')}</th></tr></thead><tbody>
            ${attrs.map((a) => html`<tr><td data-label="${tx('tpl.name')}"><code>#${a.name}#</code></td><td data-label="${tx('tpl.label')}">${a.label ?? ''}</td>
              <td data-label="${tx('tpl.type')}">${a.type ?? 'text'}${a.options?.length ? html` <span class="muted">(${a.options.join(', ')})</span>` : ''}</td>
              <td data-label="${tx('tpl.default')}"><code>${a.default ?? ''}</code></td></tr>`)}
          </tbody></table></div>`
        : html`<p class="muted">${tx('tpl.none_the_template_uses_the')}</p>`}
      ${cols.length ? html`<p class="muted">Columns the template expects: ${cols.map((n, i) => html`${i ? ', ' : ''}<code>${n.toLowerCase()}</code>`)}.</p>` : ''}
    </fieldset>
    <fieldset class="prop-group"><legend>${tx('tpl.preview')}</legend>
      <form method="get" action="${BASE}/apps/${appId}/shared" class="tc-preview-form">
        <input type="hidden" name="c" value="template_component-${row.id}">
        <div class="field" data-wide><label class="label" for="f_tc_sample">${tx('tpl.sample_rows')}</label>
          <textarea id="f_tc_sample" name="sample" class="code" rows="5" spellcheck="false">${sample}</textarea>
          <small class="help">${tx('tpl.one_name_value_per_line')}</small></div>
        <label class="check"><input type="checkbox" name="multiple" value="1"${multiple ? raw(' checked') : ''}> ${tx('tpl.as_multiple_in_the_wrapper')}</label>
        <div class="buttons"><button class="btn">${tx('tpl.preview')}</button></div>
      </form>
      <div class="tc-preview" aria-label="${tx('tpl.preview')}">${previewHtml(c, sample, multiple)}</div>
    </fieldset>
    <fieldset class="prop-group"><legend>${tx('tpl.plug_in')}</legend>
      <p class="muted u-mt0">${tx('tpl.share_this_component_with_other')}</p>
      <div class="buttons"><a class="btn" href="${BASE}/apps/${appId}/template-components/${row.id}/export" download>${tx('tpl.download_plug_in_file')}</a></div>
    </fieldset>`;
}

/** Under "New template component": copy a built-in one, or import a plug-in file. */
export function templateImport(appId: number, s: Session) {
  return html`<section class="region region-standard u-mt125"><header class="region-header"><h2>${tx('tpl.built_in_components')}</h2></header><div class="region-body">
    <p class="muted u-mt0">${tx('tpl.every_application_can_use_these')}</p>
    <div class="table-wrap"><table class="report report-reflow"><thead><tr><th>${tx('tpl.component')}</th><th>${tx('tpl.static_id')}</th><th><span class="sr-only">${tx('tpl.actions')}</span></th></tr></thead><tbody>
    ${BUILTIN_COMPONENTS.map((c) => html`<tr><td data-label="${tx('tpl.component')}"><b>${c.name}</b> <span class="muted">${c.description ?? ''}</span></td><td data-label="${tx('tpl.static_id')}"><code>${c.static_id}</code></td>
      <td data-label="${tx('tpl.actions')}"><form method="post" action="${BASE}/apps/${appId}/template-components/copy" class="u-inline">${csrf(s)}<input type="hidden" name="static_id" value="${c.static_id}">
        <button class="btn btn-sm">${tx('tpl.copy_into_this_application')}</button></form></td></tr>`)}
    </tbody></table></div></div></section>
  <section class="region region-standard u-mt125"><header class="region-header"><h2>${tx('tpl.import_a_plug_in')}</h2></header><div class="region-body">
    <form method="post" action="${BASE}/apps/${appId}/template-components/import">${csrf(s)}
      <div class="field" data-wide><label class="label" for="f_tc_plugin">${tx('tpl.plug_in_file_json')}</label>
        <textarea id="f_tc_plugin" name="plugin" class="code" rows="7" spellcheck="false" required placeholder='{"format": "pgkiln-plugin/1", "type": "template_component", …}'></textarea>
        <small class="help">${tx('tpl.paste_the_contents_of_a')}</small></div>
      <label class="check"><input type="checkbox" name="replace" value="true"> ${tx('tpl.replace_a_component_with_the')}</label>
      <div class="buttons"><button class="btn btn-hot">${tx('tpl.import_plug_in')}</button></div>
    </form></div></section>`;
}

// ---------------------------------------------------------------- region settings

/** The value fields of a component's custom attributes (names attr_NAME). */
function attributeFields(c: TemplateComponent | undefined, values: Record<string, string> | undefined, idp: string): Raw {
  if (!c) return html`<p class="muted">${tx('tpl.choose_a_component_and_save')}</p>`;
  const attrs = c.attributes ?? [];
  if (!attrs.length) return html`<p class="muted">${c.name} has no custom attributes.</p>`;
  return html`<div class="form-grid">${attrs.map((a) => {
    const id = `${idp}_${a.name}`;
    const v = values?.[a.name];
    const label = a.label || a.name;
    const help = html`<small class="help">#${a.name}#${a.help ? ` · ${a.help}` : ''}${a.default ? html` · default <code>${a.default}</code>` : ''}</small>`;
    if (a.type === 'checkbox')
      return html`<div class="field"><span class="label" aria-hidden="true"></span><label class="check"><input type="checkbox" name="attr_${a.name}" value="Y"${(v ?? a.default ?? 'N') === 'Y' ? raw(' checked') : ''}> ${label}</label>${help}</div>`;
    if (a.type === 'select')
      return html`<div class="field"><label class="label" for="${id}">${label}</label>
        <select id="${id}" name="attr_${a.name}">${opt('', `- default${a.default ? ` (${a.default})` : ''} -`, v)}${(a.options ?? []).map((o) => opt(o, o, v))}${v && !(a.options ?? []).includes(v) ? opt(v, v, v) : ''}</select>${help}</div>`;
    return html`<div class="field"><label class="label" for="${id}">${label}</label>
      <input id="${id}" name="attr_${a.name}" value="${v ?? ''}" placeholder="${a.default ?? ''}">${help}</div>`;
  })}</div>`;
}

/** Posted attr_NAME fields → the attribute values to keep (only the component's attributes; defaults left out). */
export function mergeAttributes(c: TemplateComponent, b: Body): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const a of c.attributes ?? []) {
    let v = b[`attr_${a.name}`];
    if (a.type === 'checkbox') v = v === 'Y' ? 'Y' : 'N';
    v = v?.trim();
    if (v && v !== (a.default ?? (a.type === 'checkbox' ? 'N' : ''))) out[a.name] = v.slice(0, 2000);
  }
  return Object.keys(out).length ? out : undefined;
}

export interface TemplateAllowed {
  pages: Set<number>;
  components: Map<string, TemplateComponent>;
}

/** A template_component region's config after its settings form (other keys kept, defaults left out). */
export function mergeTemplateRegionSettings(config: Config, b: Body, a: TemplateAllowed): Config {
  const out: Config = { ...config };
  const set = (k: string, v: unknown) => (v === undefined ? delete out[k] : (out[k] = v));
  const c = b.component ? a.components.get(b.component) : undefined;
  set('component', c ? c.static_id : undefined);
  // attributes of another component than the one they were set for don't carry over
  set('attributes', c && c.static_id === config.component ? mergeAttributes(c, b) : undefined);
  set('display', b.display === 'multiple' ? 'multiple' : undefined);
  const max = Number(b.max_rows);
  set('max_rows', Number.isInteger(max) && max >= 1 && max <= 500 ? max : undefined);
  set('empty', b.empty?.trim() || undefined);
  const page = Number(b.link_page);
  if (b.link_page && a.pages.has(page)) {
    const items = parseLinkItems(b.link_items);
    set('link', { page, ...(Object.keys(items).length ? { items } : {}) });
  } else set('link', undefined);
  return out;
}

/** The application's components over the built-in ones, by static id. */
async function appComponents(appId: number) {
  const rows = (await owner.query('select * from meta.template_component where app_id = $1 order by name', [appId])).rows;
  return new Map<string, TemplateComponent>([...builtinComponents(), ...rows.map((r): [string, TemplateComponent] => [r.static_id as string, asComponent(r)])]);
}

/** The settings form of a template_component region in the page designer. */
export async function templateRegionForm(pageId: number, appId: number, r: { id: number; source: string | null; config: Config }, s: Session) {
  const cfg = r.config ?? {};
  const comps = await appComponents(appId);
  const pages = (await owner.query('select page_no, name from meta.page where app_id = $1 order by page_no', [appId])).rows;
  const c = comps.get(cfg.component);
  const id = (n: string) => `tc_${r.id}_${n}`;
  const cols = r.source?.trim() ? await reportColumns(appId, await designSql(appId, r)) : null;
  const expected = c ? columnNames(c) : [];
  const missing = cols && 'columns' in cols ? expected.filter((e) => !cols.columns.some((x) => x.toUpperCase() === e)) : [];
  return html`<h3 class="u-mt15">${tx('tpl.template_component_settings')}</h3>
    <p class="muted u-mt0">${tx('tpl.these_fields_write_the_region')}</p>
    ${cols && 'error' in cols ? html`<div class="alert alert-error" role="alert">The columns could not be read: ${cols.error}</div>` : ''}
    ${cols && 'columns' in cols ? html`<p class="muted">Columns of the query (#NAME# in the template and in attribute values): ${cols.columns.map((x, i) => html`${i ? ', ' : ''}<code>${x}</code>`)}.</p>` : html`<p class="muted">${tx('tpl.no_query_the_component_shows')}</p>`}
    ${missing.length ? html`<p class="muted">Note: the template also uses ${missing.map((m, i) => html`${i ? ', ' : ''}<code>#${m}#</code>`)}, which the query doesn't return.</p>` : ''}
    <form method="post" action="${BASE}/pages/${pageId}/region/${r.id}/template-settings" class="component-form">${csrf(s)}
      <fieldset class="prop-group"><legend>${tx('tpl.component')}</legend><div class="form-grid">
        <div class="field"><label class="label" for="${id('component')}">${tx('tpl.template_component')}</label>
          <select id="${id('component')}" name="component">${opt('', tx('tpl.choose'), cfg.component)}${[...comps.values()].map((x) => opt(x.static_id, `${x.name} (${x.builtin ? tx('tpl.built_in') : x.static_id})`, cfg.component))}</select>
          <small class="help">${tx.rich('tpl.builtin_help', { link: html`<a href="${BASE}/apps/${appId}/shared?new=template_component">${tx('tpl.shared_components_template_components')}</a>` })}</small></div>
        <div class="field"><label class="label" for="${id('display')}">${tx('tpl.display')}</label>
          <select id="${id('display')}" name="display">${opt('', tx('tpl.each_row_as_an_instance'), cfg.display)}${opt('multiple', tx('tpl.multiple_all_rows_in_the'), cfg.display)}</select>
          ${c && !c.wrapper && cfg.display === 'multiple' ? html`<small class="help">${c.name} has no wrapper, so the rows show one after another.</small>` : ''}</div>
        <div class="field"><label class="label" for="${id('max_rows')}">${tx('tpl.at_most_rows')}</label>
          <input id="${id('max_rows')}" name="max_rows" type="number" min="1" max="500" value="${cfg.max_rows ?? ''}" placeholder="500"></div>
        <div class="field" data-wide><label class="label" for="${id('empty')}">${tx('tpl.text_when_there_are_no')}</label>
          <input id="${id('empty')}" name="empty" value="${cfg.empty ?? ''}" placeholder="${tx('tpl.no_data_found')}"></div>
      </div></fieldset>
      <fieldset class="prop-group"><legend>${tx('tpl.attributes')}</legend>
        ${attributeFields(c, cfg.attributes, id('attr'))}
      </fieldset>
      <fieldset class="prop-group"><legend>${tx('tpl.link_link')}</legend><div class="form-grid">
        <div class="field"><label class="label" for="${id('link_page')}">${tx('tpl.each_instance_links_to_page')}</label>
          <select id="${id('link_page')}" name="link_page">${opt('', tx('tpl.no_link'), cfg.link?.page)}${pages.map((p) => opt(String(p.page_no), `${p.page_no}. ${p.name}`, cfg.link?.page))}</select>
          <small class="help">${tx('tpl.the_template_puts_it_in')}</small></div>
        <div class="field" data-wide><label class="label" for="${id('link_items')}">${tx('tpl.set_items')}</label>
          <input id="${id('link_items')}" name="link_items" value="${linkItemsText(cfg.link?.items)}" placeholder="${tx('tpl.p3_id_id')}">
          <small class="help">${tx('tpl.item_column_comma_separated')}</small></div>
      </div></fieldset>
      <div class="buttons"><button class="btn btn-hot">${tx('tpl.save_template_component_settings')}</button></div>
    </form>`;
}

// ---------------------------------------------------------------- report column templates

/** "NAME=value" lines → attribute values. */
const attrLines = (text: string | undefined): Record<string, string> =>
  Object.fromEntries(
    (text ?? '').split(/\r?\n/)
      .map((l) => /^\s*([A-Za-z][A-Za-z0-9_$]*)\s*=(.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => [m[1].toUpperCase(), m[2].trim()]),
  );
const linesOf = (attrs: Record<string, string> | undefined) => Object.entries(attrs ?? {}).map(([k, v]) => `${k}=${v}`).join('\n');

/** A report's config after the column templates form: "column_templates" replaced, nothing else touched. */
export function mergeColumnTemplates(config: Config, b: Body, columns: string[], components: Map<string, TemplateComponent>): Config {
  const out: Config = { ...config };
  const tpl: Record<string, TcUse> = {};
  const n = Math.min(Number(b.n) || 0, 500);
  for (let i = 0; i < n; i++) {
    const col = b[`col_${i}`] ?? '';
    const c = components.get(b[`tc_${i}`] ?? '');
    if (!col || !c || !columns.includes(col)) continue;
    const given = attrLines(b[`attrs_${i}`]);
    const attributes: Record<string, string> = {};
    for (const a of c.attributes ?? []) if (given[a.name] !== undefined && given[a.name] !== '') attributes[a.name] = String(given[a.name]).slice(0, 2000);
    tpl[col] = { component: c.static_id, ...(Object.keys(attributes).length ? { attributes } : {}) };
  }
  if (Object.keys(tpl).length) out.column_templates = tpl;
  else delete out.column_templates;
  return out;
}

/** Report regions: render columns through a template component. */
export async function columnTemplatesForm(pageId: number, appId: number, r: { id: number; source: string | null; config: Config }, s: Session): Promise<Raw | ''> {
  const comps = await appComponents(appId);
  const cfg = r.config ?? {};
  const current: Record<string, TcUse> = cfg.column_templates ?? {};
  if (!comps.size && !Object.keys(current).length) return '';
  const cols = await reportColumns(appId, await designSql(appId, r));
  const names = 'columns' in cols ? cols.columns : [];
  const all = [...names, ...Object.keys(current).filter((k) => !names.includes(k))];
  const rows = all.map((col, i) => {
    const use = current[col];
    const c = use?.component ? comps.get(use.component) : undefined;
    const hint = c?.attributes?.length ? `${c.attributes.map((a) => `${a.name}=`).join('\n')}` : 'NAME=value';
    return html`<tr>
      <td data-label="${tx('tpl.column')}"><code>${col}</code>${names.includes(col) ? '' : html` <span class="tag tag-error">${tx('tpl.not_in_the_query')}</span>`}<input type="hidden" name="col_${i}" value="${col}"></td>
      <td data-label="${tx('tpl.template_component')}"><select name="tc_${i}" aria-label="${tx('tpl.aria_component', { column: col })}">${opt('', tx('tpl.plain_value'), use?.component)}${[...comps.values()].map((x) => opt(x.static_id, x.name, use?.component))}${use?.component && !c ? opt(use.component, tx('tpl.missing', { name: use.component }), use.component) : ''}</select></td>
      <td data-label="${tx('tpl.attributes')}"><textarea name="attrs_${i}" class="code" rows="${Math.max(1, Math.min(4, c?.attributes?.length ?? 1))}" spellcheck="false" aria-label="${tx('tpl.aria_attrs', { column: col })}" placeholder="${hint}">${linesOf(use?.attributes)}</textarea></td>
    </tr>`;
  });
  return html`<h3 class="u-mt15">${tx('tpl.column_templates')}</h3>
    <p class="muted u-mt0">${tx('tpl.render_a_column_s_cells')}</p>
    <form method="post" action="${BASE}/pages/${pageId}/region/${r.id}/column-templates" class="component-form">${csrf(s)}
      <input type="hidden" name="n" value="${all.length}">
      ${all.length
        ? html`<div class="table-wrap"><table class="report report-reflow tc-columns"><thead><tr><th>${tx('tpl.column')}</th><th>${tx('tpl.template_component')}</th><th>${tx('tpl.attributes')}</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : html`<p class="muted">${tx('tpl.no_columns_yet')}</p>`}
      <div class="buttons"><button class="btn btn-hot">${tx('tpl.save_column_templates')}</button></div>
    </form>`;
}

// ---------------------------------------------------------------- routes

const isId = (x: string | undefined) => /^\d{1,9}$/.test(x ?? '');

export async function templateRoutes(app: FastifyInstance) {
  // a component as a plug-in file
  app.get(`${BASE}/apps/:id/template-components/:tid/export`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const { id, tid } = req.params;
    const row = isId(id) && isId(tid) ? await owner.one('select * from meta.template_component where id = $1 and app_id = $2', [tid, id]) : undefined;
    if (!row) return reply.code(404).send('Not found');
    return reply
      .header('content-disposition', `attachment; filename="${row.static_id}.plugin.json"`)
      .type('application/json')
      .send(JSON.stringify(pluginDocument(asComponent(row)), null, 2));
  });

  // a plug-in file into this application
  app.post(`${BASE}/apps/:id/template-components/import`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const { id } = req.params;
    if (!isId(id) || !(await owner.one('select 1 from meta.app where id = $1', [id]))) return reply.code(404).send('Not found');
    let doc: unknown;
    try {
      doc = JSON.parse(req.body?.plugin ?? '');
    } catch {
      flash(s, tx('tpl.import_failed_the_plug_in'), 'error');
      return back(reply, s, `${BASE}/apps/${id}/shared?new=template_component`);
    }
    const c = parsePlugin(doc);
    if (typeof c === 'string') {
      flash(s, tx('tpl.import_failed', { error: c }), 'error');
      return back(reply, s, `${BASE}/apps/${id}/shared?new=template_component`);
    }
    try {
      const r = await owner.one('select meta.import_template_component($1, $2::jsonb, $3) as id', [id, JSON.stringify(pluginDocument(c)), req.body?.replace === 'true']);
      flash(s, tx('tpl.imported', { name: c.name }));
      return back(reply, s, `${BASE}/apps/${id}/shared?c=template_component-${r.id}`);
    } catch (e) {
      flash(s, tx('tpl.import_failed', { error: (e as Error).message }), 'error');
      return back(reply, s, `${BASE}/apps/${id}/shared?new=template_component`);
    }
  });

  // a built-in component into this application, to change it
  app.post(`${BASE}/apps/:id/template-components/copy`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const { id } = req.params;
    if (!isId(id) || !(await owner.one('select 1 from meta.app where id = $1', [id]))) return reply.code(404).send('Not found');
    const c = BUILTIN_COMPONENTS.find((x) => x.static_id === req.body?.static_id);
    if (!c) return reply.code(404).send('Not found');
    try {
      const r = await owner.one('select meta.import_template_component($1, $2::jsonb, false) as id', [id, JSON.stringify(pluginDocument(c))]);
      flash(s, `${c.name} copied: this application's ${c.static_id} now replaces the built-in one.`);
      return back(reply, s, `${BASE}/apps/${id}/shared?c=template_component-${r.id}`);
    } catch (e) {
      flash(s, tx('tpl.copy_failed', { error: (e as Error).message }), 'error');
      return back(reply, s, `${BASE}/apps/${id}/shared?new=template_component`);
    }
  });

  const regionOf = async (pid: string, rid: string, type: string) =>
    isId(pid) && isId(rid)
      ? owner.one(`select r.id, r.config, r.source, p.app_id from meta.region r join meta.page p on p.id = r.page_id where r.id = $1 and r.page_id = $2 and r.type = $3`, [rid, pid, type])
      : undefined;

  app.post(`${BASE}/pages/:pid/region/:rid/template-settings`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const { pid, rid } = req.params;
    const r = await regionOf(pid, rid, 'template_component');
    if (!r) return reply.code(404).send('Not found');
    const pages = (await owner.query('select page_no from meta.page where app_id = $1', [r.app_id])).rows;
    const config = mergeTemplateRegionSettings(r.config ?? {}, (req.body ?? {}) as Body, {
      pages: new Set(pages.map((x) => x.page_no)),
      components: await appComponents(r.app_id),
    });
    await owner.query('update meta.region set config = $2 where id = $1', [r.id, JSON.stringify(config)]);
    flash(s, tx('tpl.template_component_settings_saved'));
    return back(reply, s, `${BASE}/pages/${pid}?c=region-${rid}`);
  });

  app.post(`${BASE}/pages/:pid/region/:rid/column-templates`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const { pid, rid } = req.params;
    const r = await regionOf(pid, rid, 'report');
    if (!r) return reply.code(404).send('Not found');
    const cols = await reportColumns(r.app_id, await designSql(r.app_id, r));
    // when the query can't be read, the columns already configured stay allowed
    const names = 'columns' in cols ? cols.columns : Object.keys(r.config?.column_templates ?? {});
    const config = mergeColumnTemplates(r.config ?? {}, (req.body ?? {}) as Body, names, await appComponents(r.app_id));
    await owner.query('update meta.region set config = $2 where id = $1', [r.id, JSON.stringify(config)]);
    flash(s, tx('tpl.column_templates_saved'));
    return back(reply, s, `${BASE}/pages/${pid}?c=region-${rid}`);
  });
}
