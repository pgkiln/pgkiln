import { shapeStyle } from '../runtime/maps.ts';
import type { FastifyInstance } from 'fastify';
import { aiFilterSettingsForm, assistantSettingsForm } from './assistant.ts';
import { designSql } from './websources.ts';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { CALENDAR_VIEWS, calendarViews } from '../runtime/calendar.ts';
import { CHART_KINDS } from '../runtime/charts.ts';
import { heading } from '../runtime/items.ts';
import { positionColumns } from '../runtime/report.ts';
import { anyBound, MAX_RANGES, type Range } from '../runtime/facet-state.ts';
import type { Session } from '../session.ts';
import { linkItemsText, parseLinkItems, reportColumns, reportSettingsForm } from './report-settings.ts';
import { back, BASE, csrf, developer, flash, type Req } from './ui.ts';
import { columnTemplatesForm, templateRegionForm } from './templates.ts';
import { LIST_TEMPLATES } from '../runtime/lists.ts';
import { MAX_EXTRA_LAYERS } from '../runtime/maps.ts';
import { postgis } from '../runtime/spatial.ts';
import { reporterSettingsForm } from './reporter.ts';
import { formDesignerSettingsForm } from './form-designer.ts';
import { scopedTx as tx, tr, withTranslator } from './i18n.ts';

// Page designer → a region → Settings: the region's "config" JSON as a form
// for grid, chart, cards, calendar and faceted search regions (report
// regions have their own form in report-settings.ts). Like the report
// settings, saving replaces only the keys the form knows, leaves every other
// key alone and leaves defaults out.

type Config = Record<string, any>;
type Body = Record<string, string | undefined>;

/** What the merge functions may refer to: checked server-side, so a forged form can't point elsewhere. */
export interface Allowed {
  pages: Set<number>;
  lovs: Set<string>;
  reports: Map<number, string[]>; // report regions on the same page → their columns
  authz?: Set<string>; // the app's authorization scheme names (upper case)
}

export const SETTINGS_TYPES = ['grid', 'chart', 'cards', 'calendar', 'facets', 'smart_filters', 'display_selector', 'tasks', 'workflows', 'map', 'tree', 'list'] as const;
type SettingsType = (typeof SETTINGS_TYPES)[number];

const GRID_PAGE_SIZES = ['5', '10', '15', '25', '50', '100', '200'];
const CHART_LABELS: Record<string, string> = {
  bar: 'Bar (horizontal)',
  column: 'Column',
  stacked: 'Stacked column',
  line: 'Line',
  area: 'Area',
  combo: 'Column and line (first series as columns)',
  scatter: 'Scatter (first column is x)',
  donut: 'Donut',
  pie: 'Pie',
  bubble: 'Bubble (label, x, y and size columns)',
  gauge: 'Gauge (one dial per row)',
  funnel: 'Funnel (stages in the query order)',
  radar: 'Radar (one axis per row)',
  gantt: 'Gantt (task, start and end columns)',
  treemap: 'Treemap (label and value; node_id, parent_id for a hierarchy)',
  sunburst: 'Sunburst (label and value; node_id, parent_id for a hierarchy)',
  timeline: 'Timeline (label, start, end; a series column for lanes)',
  pyramid: 'Pyramid (one series; two series back to back)',
  polar: 'Polar area (one sector per row)',
  range: 'Range (low and high columns: floating columns)',
  boxplot: 'Box plot (one value per row, or min, Q1, median, Q3 and max)',
  stock: 'Stock (open, high, low and close columns: candlesticks)',
};
const GAUGE_KEYS = ['min', 'max', 'warning', 'critical'] as const;
const CARD_COLUMNS = ['title', 'subtitle', 'body', 'badge', 'icon'];
const FACET_LIMIT = 12;

// ---------------------------------------------------------------- shared bits

const opt = (value: string, label: string, current: unknown) => html`<option value="${value}"${String(current ?? '') === value ? raw(' selected') : ''}>${label}</option>`;
const check = (name: string, label: string, on: boolean) =>
  html`<div class="field"><span class="label" aria-hidden="true"></span><label class="check"><input type="checkbox" name="${name}" value="true"${on ? raw(' checked') : ''}> ${label}</label></div>`;

/** A {page, items} link from the form, or undefined (no page, or a page of another app). */
function mergeLink(b: Body, pages: Set<number>, prefix = 'link') {
  const page = Number(b[`${prefix}_page`]);
  if (!b[`${prefix}_page`] || !pages.has(page)) return undefined;
  const items = parseLinkItems(b[`${prefix}_items`]);
  return { page, ...(Object.keys(items).length ? { items } : {}) };
}

function setter(out: Config) {
  return (k: string, v: unknown) => {
    if (v === undefined) delete out[k];
    else out[k] = v;
  };
}

/** The column names as a hint, or the reason they couldn't be read. */
function columnsHint(cols: { columns: string[] } | { error: string }, expected?: string[]): Raw {
  if ('error' in cols) return html`<div class="alert alert-error" role="alert">The columns could not be read: ${cols.error}</div>`;
  const missing = (expected ?? []).filter((e) => !cols.columns.some((c) => c.toLowerCase() === e));
  return html`<p class="muted">Columns of the query: ${cols.columns.length ? cols.columns.map((c, i) => html`${i ? ', ' : ''}<code>${c}</code>`) : 'none'}.</p>
    ${missing.length ? html`<div class="alert alert-error" role="alert">The query has no column ${missing.map((m, i) => html`${i ? ' or ' : ''}<code>${m}</code>`)}.</div>` : ''}`;
}

function linkFieldset(
  id: (n: string) => string, link: { page?: number; items?: Record<string, string> } | undefined, pages: { page_no: number; name: string }[], what: string,
  { prefix = 'link', legend = tx('rs.link'), placeholder = 'P3_ID=#id#', help = tx('rs.link_help') }: { prefix?: string; legend?: string; placeholder?: string; help?: string } = {},
) {
  return html`<fieldset class="prop-group"><legend>${legend}</legend><div class="form-grid">
    <div class="field"><label class="label" for="${id(`${prefix}_page`)}">${tx('rs.links_to_page', { what })}</label>
      <select id="${id(`${prefix}_page`)}" name="${prefix}_page">${opt('', tx('rs.no_link'), link?.page)}${pages.map((p) => opt(String(p.page_no), `${p.page_no}. ${p.name}`, link?.page))}</select></div>
    <div class="field" data-wide><label class="label" for="${id(`${prefix}_items`)}">${tx('rs.set_items')}</label>
      <input id="${id(`${prefix}_items`)}" name="${prefix}_items" value="${linkItemsText(link?.items)}" placeholder="${placeholder}">
      <small class="help">${help}</small></div>
  </div></fieldset>`;
}

const emptyField = (id: (n: string) => string, cfg: Config) => html`<div class="field" data-wide><label class="label" for="${id('empty')}">${tx('rs.text_when_there_are_no')}</label>
  <input id="${id('empty')}" name="empty" value="${cfg.empty ?? ''}" placeholder="${tx('rs.no_data_found')}"></div>`;

/** Columns in the settings that the query no longer returns stay listed (marked), so they can be cleared. */
function withStale(names: string[], configured: string[]) {
  const known = new Set(names);
  return { all: [...names, ...[...new Set(configured)].filter((n) => !known.has(n))], known };
}

const staleTag = (known: Set<string>, n: string) => (known.has(n) ? '' : html` <span class="tag tag-error">${tx('rs.not_in_query')}</span>`);

// ---------------------------------------------------------------- merges (pure, unit tested)

export function mergeChartSettings(config: Config, b: Body, a: Allowed): Config {
  const out = { ...config };
  const set = setter(out);
  set('kind', b.kind && (CHART_KINDS as string[]).includes(b.kind) && b.kind !== 'bar' ? b.kind : undefined);
  set('empty', b.empty?.trim() || undefined);
  set('link', mergeLink(b, a.pages));
  const gauge: Config = {};
  for (const k of GAUGE_KEYS) {
    const raw = b[`gauge_${k}`]?.trim();
    const v = Number(raw);
    if (raw && Number.isFinite(v)) gauge[k] = v;
  }
  set('gauge', Object.keys(gauge).length ? gauge : undefined);
  // (sprint 69) Gantt drag and drop
  set('gantt_move', b.gantt_move?.trim() || undefined);
  const authz = b.gantt_move_authz?.trim().toUpperCase();
  set('gantt_move_authz', authz && (authz === 'MUST_NOT_BE_PUBLIC_USER' || a.authz?.has(authz)) ? authz : undefined);
  set('gantt_snap', b.gantt_snap === 'day' || b.gantt_snap === 'hour' ? b.gantt_snap : undefined);
  return out;
}

export function mergeCardsSettings(config: Config, b: Body, a: Allowed): Config {
  const out = { ...config };
  const set = setter(out);
  set('style', b.style === 'metric' ? 'metric' : undefined);
  set('empty', b.empty?.trim() || undefined);
  set('link', mergeLink(b, a.pages));
  return out;
}

export function mergeCalendarSettings(config: Config, b: Body, a: Allowed): Config {
  const out = { ...config };
  const set = setter(out);
  set('link', mergeLink(b, a.pages));
  set('create', mergeLink(b, a.pages, 'create'));
  // views: all four is the default (left out); none ticked means all four too
  const views = CALENDAR_VIEWS.filter((v) => b[`view_${v}`] === 'true');
  const enabled = views.length ? views : CALENDAR_VIEWS;
  set('views', views.length && views.length < CALENDAR_VIEWS.length ? views : undefined);
  set('view', b.view && (enabled as string[]).includes(b.view) && b.view !== enabled[0] ? b.view : undefined);
  const hour = (v: string | undefined, lo: number, hi: number) => {
    const n = Number(v);
    return v?.trim() && Number.isInteger(n) && n >= lo && n <= hi ? n : undefined;
  };
  const start = hour(b.day_start, 0, 23);
  const end = hour(b.day_end, 1, 24);
  set('day_start', start !== undefined && start !== 8 ? start : undefined);
  set('day_end', end !== undefined && end !== 18 && end > (start ?? 8) ? end : undefined);
  set('move', b.move?.trim() || undefined);
  const key = b.key?.trim();
  set('key', key && /^[A-Za-z_][A-Za-z0-9_$]*$/.test(key) && key.toLowerCase() !== 'id' ? key : undefined);
  const authz = b.move_authz?.trim().toUpperCase();
  set('move_authz', authz && (authz === 'MUST_NOT_BE_PUBLIC_USER' || a.authz?.has(authz)) ? authz : undefined);
  return out;
}

export function mergeGridSettings(config: Config, b: Body, a: Allowed): Config {
  const out = { ...config };
  const set = setter(out);
  const size = Number(b.page_size);
  set('page_size', GRID_PAGE_SIZES.includes(String(size)) && size !== 25 ? size : undefined);
  const allow: Record<string, false> = {};
  for (const op of ['insert', 'update', 'delete']) if (b[`allow_${op}`] !== 'true') allow[op] = false;
  // other keys under "allow" don't exist, so the object is the form's alone
  set('allow', Object.keys(allow).length ? allow : undefined);

  const n = Math.min(Number(b.n) || 0, 500);
  const cols = Array.from({ length: n }, (_, i) => ({
    name: (b[`col_${i}`] ?? '').trim(),
    heading: (b[`heading_${i}`] ?? '').trim(),
    shown: b[`shown_${i}`] === 'true',
    readonly: b[`readonly_${i}`] === 'true',
    required: b[`required_${i}`] === 'true',
    lov: (b[`lov_${i}`] ?? '').trim(),
    // (sprint 174, CD-1) undefined when the form has no validation fields (an older page still open): left as it is
    validation: b[`validation_${i}`] === undefined ? undefined : b[`validation_${i}`]!.trim().slice(0, 4000),
    validationMessage: (b[`validation_message_${i}`] ?? '').trim().slice(0, 500),
  })).filter((c) => c.name);
  const headings = Object.fromEntries(cols.filter((c) => c.heading).map((c) => [c.name, c.heading]));
  set('headings', Object.keys(headings).length ? headings : undefined);
  const hidden = cols.filter((c) => !c.shown).map((c) => c.name);
  set('hidden', hidden.length ? hidden : undefined);
  const readonly = cols.filter((c) => c.readonly).map((c) => c.name);
  set('readonly', readonly.length ? readonly : undefined);

  // per-column settings: keep keys the form doesn't know (and columns it didn't post)
  const columns: Config = { ...(config.columns ?? {}) };
  for (const c of cols) {
    const col: Config = { ...(columns[c.name] ?? {}) };
    if (c.required) col.required = true;
    else delete col.required;
    const shared = /^LOV:([A-Z0-9_]+)$/i.exec(c.lov);
    // a shared LOV of this app, or the custom value that was already there (shown as its own option)
    if (shared && a.lovs.has(shared[1].toUpperCase())) col.lov = `LOV:${shared[1].toUpperCase()}`;
    else if (c.lov && c.lov === col.lov) col.lov = c.lov;
    else delete col.lov;
    if (c.validation !== undefined) {
      if (c.validation) col.validation = c.validation;
      else delete col.validation;
      if (c.validation && c.validationMessage) col.validation_message = c.validationMessage;
      else delete col.validation_message;
    }
    if (Object.keys(col).length) columns[c.name] = col;
    else delete columns[c.name];
  }
  set('columns', Object.keys(columns).length ? columns : undefined);
  if (b.grid_features === '1') mergeGridFeatures(out, b, a, cols.map((c) => c.name));
  return out;
}

const ITEM_NAME = /^[A-Z][A-Z0-9_]{0,59}$/;
const AGG_FNS = ['sum', 'avg', 'count', 'min', 'max'];

/** "sal=sum,avg; ename=count" → {"sal": ["sum", "avg"], "ename": "count"}; unknown columns and functions left out. */
export function parseAggregates(text: string | undefined, columns: string[]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const part of (text ?? '').split(';')) {
    const [col, fns] = part.split('=').map((x) => x?.trim() ?? '');
    if (!col || !columns.includes(col)) continue;
    const list = [...new Set((fns ?? '').split(',').map((f) => f.trim().toLowerCase()).filter((f) => AGG_FNS.includes(f)))];
    if (list.length) out[col] = list.length === 1 ? list[0] : list;
  }
  return out;
}

export const aggregatesText = (aggs: unknown) =>
  aggs && typeof aggs === 'object' && !Array.isArray(aggs)
    ? Object.entries(aggs as Record<string, unknown>).map(([c, f]) => `${c}=${[f].flat().join(',')}`).join('; ')
    : '';

/** Sprint 31 grid settings: aggregates, frozen columns, row actions, master-detail, Actions menu, saved reports. */
function mergeGridFeatures(out: Config, b: Body, a: Allowed, columns: string[]) {
  const set = setter(out);
  const aggs = parseAggregates(b.aggregates, columns);
  set('aggregates', Object.keys(aggs).length ? aggs : undefined);
  const frozen = Number(b.frozen);
  set('frozen', Number.isInteger(frozen) && frozen >= 1 && frozen <= 5 ? frozen : undefined);
  set('actions', b.actions === 'true' ? undefined : false);
  set('saved_reports', b.saved_reports === 'true' ? undefined : false);
  const pub = (b.public_reports ?? '').trim().toUpperCase();
  set('public_reports', pub && a.authz?.has(pub) ? pub : undefined);
  // views besides the grid: all three is the default (left out); none ticked means the grid only
  // (only when the form has the Views fieldset)
  const views = GRID_USER_VIEWS.filter((v) => b[`view_${v}`] === 'true');
  if (b.grid_views === '1') set('views', views.length < GRID_USER_VIEWS.length ? views : undefined);
  // row actions: an edit link, duplicate and delete; custom links stay as written in the JSON
  const edit = mergeLink(b, a.pages, 'edit');
  const ra: Config = { ...(out.row_actions && typeof out.row_actions === 'object' ? out.row_actions : {}) };
  if (edit) ra.edit = edit;
  else delete ra.edit;
  if (b.row_duplicate === 'true') delete ra.duplicate;
  else ra.duplicate = false;
  if (b.row_delete === 'true') delete ra.delete;
  else ra.delete = false;
  set('row_actions', b.row_actions === 'true' ? ra : undefined);
  // master-detail
  const selCol = (b.select_column ?? '').trim();
  const selItem = (b.select_item ?? '').trim().toUpperCase();
  set('select_row', selCol && columns.includes(selCol) && ITEM_NAME.test(selItem) ? { column: selCol, item: selItem } : undefined);
  const mItem = (b.master_item ?? '').trim().toUpperCase();
  const mCol = (b.master_column ?? '').trim();
  set('master', ITEM_NAME.test(mItem) ? { item: mItem, ...(mCol && /^[a-z_][a-z0-9_$]{0,62}$/i.test(mCol) ? { column: mCol } : {}) } : undefined);
}

/** "from..to = label; …" (either bound may be empty; numbers or ISO dates) → ranges; malformed parts are left out. */
export function parseRanges(text: string | undefined): Range[] {
  const out: Range[] = [];
  for (const part of (text ?? '').split(';')) {
    const m = /^\s*(.*?)\s*\.\.\s*(.*?)\s*(?:=\s*(.*?)\s*)?$/.exec(part);
    if (!m || (!m[1] && !m[2]) || !anyBound(m[1]) || !anyBound(m[2])) continue;
    out.push({ from: m[1], to: m[2], ...(m[3] ? { label: m[3].slice(0, 80) } : {}) });
    if (out.length >= MAX_RANGES) break;
  }
  return out;
}

/** Ranges as the settings form shows them. */
export const rangesText = (ranges: unknown) =>
  (Array.isArray(ranges) ? ranges : [])
    .map((r: any) => `${r?.from ?? ''}..${r?.to ?? ''}${r?.label ? ` = ${r.label}` : ''}`)
    .join('; ');

const FACET_FORM_KEYS = ['label', 'limit', 'type', 'ranges', 'custom', 'exclude', 'chart'];

/** The facets table of a faceted search or smart filters form (and the report it filters). */
function mergeFacetList(out: Config, config: Config, b: Body, a: Allowed, charts = true) {
  const set = setter(out);
  const report = Number(b.report);
  const columns = a.reports.get(report);
  set('report', columns ? report : undefined);
  if (!columns) return false;
  const n = Math.min(Number(b.n) || 0, 500);
  const old = new Map<string, Config>((config.facets ?? []).map((f: Config) => [f.column, f]));
  const facets = Array.from({ length: n }, (_, i) => ({
    column: (b[`col_${i}`] ?? '').trim(),
    on: b[`on_${i}`] === 'true',
    label: (b[`label_${i}`] ?? '').trim(),
    limit: Number(b[`limit_${i}`]),
    type: b[`type_${i}`] === 'range' || b[`type_${i}`] === 'star' ? b[`type_${i}`] : 'checkbox',
    ranges: parseRanges(b[`ranges_${i}`]),
    custom: b[`custom_${i}`] === 'true',
    exclude: b[`exclude_${i}`] === 'true',
    chart: charts && (b[`chart_${i}`] === 'bar' || b[`chart_${i}`] === 'pie') ? b[`chart_${i}`] : null,
    seq: Number(b[`seq_${i}`]) || (i + 1) * 10,
  }))
    .filter((f) => f.on && columns.includes(f.column))
    .sort((x, y) => x.seq - y.seq)
    .map((f) => {
      const rest = Object.fromEntries(Object.entries(old.get(f.column) ?? {}).filter(([key]) => !FACET_FORM_KEYS.includes(key)));
      if (f.type !== 'star') delete rest.max;
      return {
        ...rest,
        column: f.column,
        ...(f.label ? { label: f.label } : {}),
        ...(f.type !== 'checkbox' ? { type: f.type } : {}),
        ...(f.type === 'checkbox' && Number.isInteger(f.limit) && f.limit >= 1 && f.limit <= 50 && f.limit !== FACET_LIMIT ? { limit: f.limit } : {}),
        ...(f.type === 'checkbox' && f.exclude ? { exclude: true } : {}),
        ...(f.type === 'range' && f.ranges.length ? { ranges: f.ranges } : {}),
        // a range facet without ranges has from/to fields unless switched off; with ranges, only when switched on
        ...(f.type === 'range' && f.custom !== !f.ranges.length ? { custom: f.custom } : {}),
        // (sprint 65) a chart of the counts (faceted search only)
        ...(f.chart ? { chart: f.chart } : {}),
      };
    });
  set('facets', facets.length ? facets : undefined);
  return true;
}

export function mergeFacetsSettings(config: Config, b: Body, a: Allowed): Config {
  const out = { ...config };
  if (!mergeFacetList(out, config, b, a)) return out;
  setter(out)('search', b.search === 'true' ? true : undefined);
  return out;
}

export function mergeSmartFiltersSettings(config: Config, b: Body, a: Allowed): Config {
  const out = { ...config };
  // (sprint 65) facet charts belong to faceted search
  if (!mergeFacetList(out, config, b, a, false)) return out;
  const set = setter(out);
  const n = Number(b.suggestions);
  set('suggestions', b.suggestions !== undefined && b.suggestions !== '' && Number.isInteger(n) && n >= 0 && n <= 10 && n !== 3 ? n : undefined);
  set('placeholder', b.placeholder?.trim().slice(0, 100) || undefined);
  set('ask', b.ask === 'true' ? true : undefined);
  return out;
}

export function mergeDisplaySelectorSettings(config: Config, b: Body): Config {
  const out = { ...config };
  const set = setter(out);
  set('style', b.style === 'select' || b.style === 'carousel' ? b.style : undefined);
  set('show_all', b.show_all === 'true' ? undefined : false);
  const interval = Number(b.interval);
  set('interval', b.style === 'carousel' && Number.isInteger(interval) && interval >= 1 && interval <= 120 ? interval : undefined);
  set('remember', b.remember === 'true' ? undefined : false);
  return out;
}

export function mergeListSettings(config: Config, b: Body): Config {
  const out = { ...config };
  const set = setter(out);
  const name = (b.list ?? '').trim().toUpperCase();
  set('list', /^[A-Z][A-Z0-9_]{0,59}$/.test(name) ? name : undefined);
  set('template', (LIST_TEMPLATES as readonly string[]).includes(b.template ?? '') && b.template !== 'links' ? b.template : undefined);
  return out;
}

export function mergeTasksSettings(config: Config, b: Body): Config {
  const out = { ...config };
  const set = setter(out);
  set('context', b.context === 'initiated' || b.context === 'admin' ? b.context : undefined);
  set('completed', b.completed === 'true' ? true : undefined);
  set('empty', b.empty?.trim() || undefined);
  return out;
}

export function mergeWorkflowsSettings(config: Config, b: Body): Config {
  const out = { ...config };
  const set = setter(out);
  set('context', b.context === 'admin' ? 'admin' : undefined);
  set('completed', b.completed === 'true' ? true : undefined);
  set('empty', b.empty?.trim() || undefined);
  return out;
}

// (159, CD-6) a map layer's kind and the style of a lines / polygons / extruded layer
const LAYER_KINDS = new Set(['heat', 'lines', 'polygons', 'extruded']);
function mergeStyle(b: Body, p: string): Config | undefined {
  const s = shapeStyle({ fill_color: b[`${p}_fill_color`]?.trim() || undefined, stroke_color: b[`${p}_stroke_color`]?.trim() || undefined,
    stroke_width: b[`${p}_stroke_width`]?.trim() ? Number(b[`${p}_stroke_width`]) : undefined, opacity: b[`${p}_opacity`]?.trim() ? Number(b[`${p}_opacity`]) : undefined });
  return Object.keys(s).length ? (s as Config) : undefined;
}
function styleFields(id: (n: string) => string, p: string, st: Config | undefined) {
  const s = (st ?? {}) as Config;
  return html`<div class="field"><label class="label" for="${id(`${p}_fill_color`)}">${tx('rs.fill_colour_lines_polygons')}</label>
      <input id="${id(`${p}_fill_color`)}" name="${p}_fill_color" value="${s.fill_color ?? ''}" placeholder="#2e5c8a" pattern="#[0-9a-fA-F]{6}"></div>
    <div class="field"><label class="label" for="${id(`${p}_stroke_color`)}">${tx('rs.line_colour')}</label>
      <input id="${id(`${p}_stroke_color`)}" name="${p}_stroke_color" value="${s.stroke_color ?? ''}" placeholder="#1b2230" pattern="#[0-9a-fA-F]{6}"></div>
    <div class="field"><label class="label" for="${id(`${p}_stroke_width`)}">${tx('rs.line_width')}</label>
      <input id="${id(`${p}_stroke_width`)}" name="${p}_stroke_width" type="number" min="0" max="20" step="0.5" value="${s.stroke_width ?? ''}"></div>
    <div class="field"><label class="label" for="${id(`${p}_opacity`)}">${tx('rs.opacity_0_1')}</label>
      <input id="${id(`${p}_opacity`)}" name="${p}_opacity" type="number" min="0" max="1" step="0.05" value="${s.opacity ?? ''}"></div>`;
}

export function mergeMapSettings(config: Config, b: Body, a: Allowed): Config {
  const out = { ...config };
  const set = setter(out);
  set('height', b.height === 'small' || b.height === 'large' ? b.height : undefined);
  const zoom = Number(b.zoom);
  set('zoom', b.zoom && Number.isInteger(zoom) && zoom >= 1 && zoom <= 19 ? zoom : undefined);
  set('empty', b.empty?.trim() || undefined);
  set('link', mergeLink(b, a.pages));
  set('layer', LAYER_KINDS.has(b.layer ?? '') ? b.layer : undefined);
  set('cluster', b.cluster === 'true' && !b.layer && b.load !== 'tiles' ? true : undefined);
  set('style', mergeStyle(b, 'style'));
  set('name', b.name?.trim().slice(0, 60) || undefined);
  set('visible_area', b.load === 'area' ? true : undefined);
  set('tiles', b.load === 'tiles' ? true : undefined);
  const report = Number(b.report);
  set('report', b.report && a.reports.has(report) ? report : undefined);
  set('filter', b.filter === 'distance' && out.report !== undefined ? 'distance' : undefined);
  // more layers: layer<i>_source (empty: the layer is removed), _name, _layer, _cluster, _hidden, _load, _link_page/_items
  if (b.layers === '1') {
    const layers: Config[] = [];
    for (let i = 0; i < MAX_EXTRA_LAYERS; i++) {
      const source = b[`layer${i}_source`]?.trim();
      if (!source) continue;
      const layer: Config = { name: b[`layer${i}_name`]?.trim().slice(0, 60) || `Layer ${layers.length + 2}`, source };
      const load = b[`layer${i}_load`];
      if (LAYER_KINDS.has(b[`layer${i}_layer`] ?? '')) layer.layer = b[`layer${i}_layer`];
      else if (b[`layer${i}_cluster`] === 'true' && load !== 'tiles') layer.cluster = true;
      const style = mergeStyle(b, `layer${i}`);
      if (style) layer.style = style;
      if (b[`layer${i}_hidden`] === 'true') layer.hidden = true;
      if (load === 'area') layer.visible_area = true;
      else if (load === 'tiles') layer.tiles = true;
      const link = mergeLink(b, a.pages, `layer${i}_link`);
      if (link) layer.link = link;
      layers.push(layer);
    }
    set('layers', layers.length ? layers : undefined);
  }
  return out;
}

export function mergeTreeSettings(config: Config, b: Body, a: Allowed): Config {
  const out = { ...config };
  const set = setter(out);
  const levels = Number(b.expanded);
  set('expanded', b.expanded !== undefined && b.expanded !== '' && Number.isInteger(levels) && levels >= 0 && levels <= 20 && levels !== 1 ? levels : undefined);
  set('empty', b.empty?.trim() || undefined);
  set('link', mergeLink(b, a.pages));
  return out;
}

const MERGES: Record<SettingsType, (c: Config, b: Body, a: Allowed) => Config> = {
  tasks: (c, b) => mergeTasksSettings(c, b),
  workflows: (c, b) => mergeWorkflowsSettings(c, b),
  map: mergeMapSettings,
  tree: mergeTreeSettings,
  grid: mergeGridSettings,
  chart: mergeChartSettings,
  cards: mergeCardsSettings,
  calendar: mergeCalendarSettings,
  facets: mergeFacetsSettings,
  smart_filters: mergeSmartFiltersSettings,
  display_selector: (c, b) => mergeDisplaySelectorSettings(c, b),
  list: (c, b) => mergeListSettings(c, b),
};

// ---------------------------------------------------------------- forms

interface RegionRow {
  id: number;
  type: string;
  source: string | null;
  config: Config;
}

async function gridFields(appId: number, r: RegionRow, id: (n: string) => string) {
  const cfg = r.config ?? {};
  const cols = await reportColumns(appId, await designSql(appId, r));
  const lovs = (await owner.query('select name from meta.lov where app_id = $1 order by name', [appId])).rows.map((x) => x.name as string);
  const authz = (await owner.query('select name from meta.authz_scheme where app_id = $1 order by name', [appId])).rows.map((x) => x.name as string);
  const pages = (await owner.query('select page_no, name from meta.page where app_id = $1 order by page_no', [appId])).rows;
  const colCfg: Config = cfg.columns ?? {};
  const { all, known } = withStale('columns' in cols ? cols.columns : [], [...(cfg.hidden ?? []), ...(cfg.readonly ?? []), ...Object.keys(cfg.headings ?? {}), ...Object.keys(colCfg)]);
  const lower = (xs: string[] | undefined) => new Set((xs ?? []).map((x) => x.toLowerCase()));
  const hidden = lower(cfg.hidden);
  const readonly = lower(cfg.readonly);
  const allow = cfg.allow ?? {};

  const lovSelect = (n: string, i: number) => {
    const cur = colCfg[n]?.lov as string | undefined;
    const custom = cur && !lovs.some((l) => `LOV:${l}` === cur.toUpperCase()) ? cur : null;
    return html`<select name="lov_${i}" aria-label="${tx('rs.aria_list_of_values_of', { name: n })}">${opt('', tx('rs.text_field'), cur)}${lovs.map((l) => opt(`LOV:${l}`, l, cur?.toUpperCase()))}${custom ? opt(custom, `custom: ${custom.length > 40 ? custom.slice(0, 40) + '…' : custom}`, cur) : ''}</select>`;
  };
  const rows = all.map((n, i) => html`<tr>
      <td data-label="${tx('rs.column')}"><code>${n}</code>${staleTag(known, n)}<input type="hidden" name="col_${i}" value="${n}"></td>
      <td data-label="${tx('rs.heading')}"><input name="heading_${i}" value="${cfg.headings?.[n] ?? ''}" placeholder="${heading(n)}" aria-label="${tx('rs.aria_heading_of', { name: n })}"></td>
      <td data-label="${tx('rs.shown')}"><input type="checkbox" name="shown_${i}" value="true"${hidden.has(n.toLowerCase()) ? '' : raw(' checked')} aria-label="${tx('rs.aria_show', { name: n })}"></td>
      <td data-label="${tx('rs.read_only')}"><input type="checkbox" name="readonly_${i}" value="true"${readonly.has(n.toLowerCase()) ? raw(' checked') : ''} aria-label="${n} is read-only"></td>
      <td data-label="${tx('rs.required')}"><input type="checkbox" name="required_${i}" value="true"${colCfg[n]?.required ? raw(' checked') : ''} aria-label="${n} is required"></td>
      <td data-label="${tx('rs.edit_as')}">${lovSelect(n, i)}</td>
    </tr>`);

  return html`${'error' in cols ? columnsHint(cols) : ''}
    <input type="hidden" name="n" value="${all.length}">
    <fieldset class="prop-group"><legend>${tx('rs.behaviour')}</legend><div class="form-grid">
      <div class="field"><label class="label" for="${id('page_size')}">${tx('rs.rows_per_page')}</label>
        <select id="${id('page_size')}" name="page_size">${GRID_PAGE_SIZES.map((x) => opt(x, x, cfg.page_size ?? 25))}</select></div>
      ${check('allow_insert', tx('rs.users_may_add_rows'), allow.insert !== false)}
      ${check('allow_update', tx('rs.users_may_change_rows'), allow.update !== false)}
      ${check('allow_delete', tx('rs.users_may_delete_rows'), allow.delete !== false)}
    </div>
    <small class="help">${tx('rs.saving_needs_a_process_of')}</small></fieldset>
    <input type="hidden" name="grid_features" value="1">
    <fieldset class="prop-group"><legend>${tx('rs.totals_and_columns')}</legend><div class="form-grid">
      <div class="field" data-wide><label class="label" for="${id('aggregates')}">${tx('rs.aggregates_in_the_footer')}</label>
        <input id="${id('aggregates')}" name="aggregates" value="${aggregatesText(cfg.aggregates)}" placeholder="sal=sum,avg; empno=count">
        <small class="help">${tx('rs.column_sum_avg_count_min')}</small></div>
      <div class="field"><label class="label" for="${id('frozen')}">${tx('rs.frozen_columns')}</label>
        <select id="${id('frozen')}" name="frozen">${['0', '1', '2', '3', '4', '5'].map((x) => opt(x, x === '0' ? 'none' : `the first ${x}`, cfg.frozen ?? 0))}</select>
        <small class="help">${tx('rs.stay_in_view_while_the')}</small></div>
      ${check('actions', tx('rs.actions_menu_columns_aggregates_saved'), cfg.actions !== false)}
      ${check('saved_reports', tx('rs.users_may_save_grid_reports'), cfg.saved_reports !== false)}
      <div class="field"><label class="label" for="${id('public_reports')}">${tx('rs.public_reports_by')}</label>
        <select id="${id('public_reports')}" name="public_reports">${opt('', tx('rs.nobody'), cfg.public_reports)}${authz.map((n) => opt(n, n, cfg.public_reports))}</select></div>
    </div></fieldset>
    <input type="hidden" name="grid_views" value="1">
    <fieldset class="prop-group"><legend>${tx('rs.views')}</legend><div class="form-grid">
      ${GRID_USER_VIEWS.map((v) => check(`view_${v}`, tx.dyn(`rs.gridview.${v}`, GRID_VIEW_LABELS[v]), !Array.isArray(cfg.views) || cfg.views.includes(v)))}
    </div>
    <small class="help">${tx('rs.views_users_may_switch_to')}</small></fieldset>
    <fieldset class="prop-group"><legend>${tx('rs.row_actions')}</legend><div class="form-grid">
      ${check('row_actions', tx('rs.row_actions_menu'), !!cfg.row_actions)}
      ${check('row_duplicate', tx('rs.duplicate'), cfg.row_actions?.duplicate !== false)}
      ${check('row_delete', tx('rs.delete'), cfg.row_actions?.delete !== false)}
    </div></fieldset>
    ${linkFieldset(id, cfg.row_actions?.edit, pages, tx('rs.w.edit'), { prefix: 'edit', legend: tx('rs.row_actions_edit'), placeholder: 'P3_ID=#id#' })}
    <fieldset class="prop-group"><legend>${tx('rs.master_detail')}</legend><div class="form-grid">
      <div class="field"><label class="label" for="${id('select_column')}">${tx('rs.as_a_master_column_of')}</label>
        <select id="${id('select_column')}" name="select_column">${opt('', tx('rs.not_a_master'), cfg.select_row?.column)}${all.map((n) => opt(n, n, cfg.select_row?.column))}</select></div>
      <div class="field"><label class="label" for="${id('select_item')}">${tx('rs.goes_into_item')}</label>
        <input id="${id('select_item')}" name="select_item" value="${cfg.select_row?.item ?? ''}" placeholder="P1_ID"></div>
      <div class="field"><label class="label" for="${id('master_item')}">${tx('rs.as_a_detail_follows_item')}</label>
        <input id="${id('master_item')}" name="master_item" value="${cfg.master?.item ?? ''}" placeholder="P1_ID"></div>
      <div class="field"><label class="label" for="${id('master_column')}">${tx('rs.and_new_rows_get_it')}</label>
        <input id="${id('master_column')}" name="master_column" value="${cfg.master?.column ?? ''}" placeholder="dept_id"></div>
    </div>
    <small class="help">${tx('rs.a_master_grid_s_selected')}</small></fieldset>
    <fieldset class="prop-group"><legend>${tx('rs.columns')}</legend>
      ${all.length
        ? html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>${tx('rs.column')}</th><th>${tx('rs.heading')}</th><th>${tx('rs.shown')}</th><th>${tx('rs.read_only')}</th><th>${tx('rs.required')}</th><th>${tx('rs.edit_as')}</th></tr></thead><tbody>${rows}</tbody></table></div>
          <small class="help">${tx('rs.edit_as_picks_a_shared')}</small>`
        : html`<p class="muted">${tx('rs.no_columns_yet')}</p>`}
    </fieldset>
    ${all.length ? html`<fieldset class="prop-group"><legend>${tx('rs.col_validations')}</legend>
      <details${all.some((n) => colCfg[n]?.validation) ? raw(' open') : ''}><summary>${tx('rs.col_validations_summary')}</summary>
      <div class="table-wrap"><table class="report report-reflow"><thead><tr><th>${tx('rs.column')}</th><th>${tx('rs.valid_when')}</th><th>${tx('rs.error_message')}</th></tr></thead><tbody>${all.map((n, i) => html`<tr>
        <td data-label="${tx('rs.column')}"><code>${n}</code></td>
        <td data-label="${tx('rs.valid_when')}"><input name="validation_${i}" value="${colCfg[n]?.validation ?? ''}" maxlength="4000" spellcheck="false" placeholder=":${n.toUpperCase()} is not null" aria-label="${tx('rs.aria_valid_when', { name: n })}"></td>
        <td data-label="${tx('rs.error_message')}"><input name="validation_message_${i}" value="${colCfg[n]?.validation_message ?? ''}" maxlength="500" aria-label="${tx('rs.aria_error_message', { name: n })}"></td>
      </tr>`)}</tbody></table></div>
      <small class="help">${tx('rs.col_validations_help')}</small></details></fieldset>` : ''}`;
}

/** A map's further layers, each with its own query: the filled ones and one empty to add (up to MAX_EXTRA_LAYERS). */
/** How a map layer's rows reach the browser: with the page, for the visible area, or as vector tiles. */
function loadField(id: (n: string) => string, name: string, l: Config) {
  const load = l.tiles === true ? 'tiles' : l.visible_area === true ? 'area' : '';
  return html`<div class="field"><label class="label" for="${id(name)}">${tx('rs.load')}</label>
    <select id="${id(name)}" name="${name}">${opt('', tx('rs.all_rows_with_the_page'), load)}${opt('area', tx('rs.rows_in_the_visible_area'), load)}${opt('tiles', tx('rs.vector_tiles_large_data_sets'), load)}</select>
    <small class="help">${tx.code('rs.the_visible_area_and_vector')}</small></div>`;
}

async function mapLayersFieldsets(cfg: Config, appId: number, allPages: { page_no: number; name: string }[], id: (n: string) => string) {
  const layers: Config[] = (Array.isArray(cfg.layers) ? cfg.layers : []).slice(0, MAX_EXTRA_LAYERS);
  const shown = layers.length < MAX_EXTRA_LAYERS ? [...layers, {}] : layers;
  const parts = [];
  for (const [i, l] of shown.entries()) {
    const p = `layer${i}`;
    const hint = l.source ? columnsHint(await reportColumns(appId, l.source)) : '';
    parts.push(html`<fieldset class="prop-group"><legend>${l.source ? tx('rs.layer_n', { n: i + 2, name: l.name ?? '' }) : tx('rs.add_layer')}</legend>
      ${hint}
      <div class="form-grid">
        <div class="field"><label class="label" for="${id(`${p}_name`)}">${tx('rs.name_legend')}</label>
          <input id="${id(`${p}_name`)}" name="${p}_name" value="${l.name ?? ''}" maxlength="60"></div>
        <div class="field"><label class="label" for="${id(`${p}_layer`)}">${tx('rs.show_places_as')}</label>
          <select id="${id(`${p}_layer`)}" name="${p}_layer">${opt('', tx('rs.markers'), l.layer)}${opt('heat', tx('rs.heat_map'), l.layer)}${opt('lines', tx('rs.lines'), l.layer)}${opt('polygons', tx('rs.polygons'), l.layer)}${opt('extruded', tx('rs.extruded_polygons_shaded_by_height'), l.layer)}</select></div>
        ${styleFields(id, p, l.style)}
        ${loadField(id, `${p}_load`, l)}
        ${check(`${p}_cluster`, tx('rs.group_markers'), l.cluster === true)}
        ${check(`${p}_hidden`, tx('rs.off_at_first'), l.hidden === true)}
        <div class="field" data-wide><label class="label" for="${id(`${p}_source`)}">${tx('rs.query')}</label>
          <textarea id="${id(`${p}_source`)}" name="${p}_source" class="code" rows="5" spellcheck="false" data-code="sql" placeholder="select lat, lng, title from …">${l.source ?? ''}</textarea>
          <small class="help">${tx('rs.the_same_columns_as_the')}</small></div>
        <div class="field"><label class="label" for="${id(`${p}_link_page`)}">${tx('rs.each_place_links_to_page')}</label>
          <select id="${id(`${p}_link_page`)}" name="${p}_link_page">${opt('', tx('rs.no_link'), l.link?.page)}${allPages.map((x) => opt(String(x.page_no), `${x.page_no}. ${x.name}`, l.link?.page))}</select></div>
        <div class="field"><label class="label" for="${id(`${p}_link_items`)}">${tx('rs.set_items')}</label>
          <input id="${id(`${p}_link_items`)}" name="${p}_link_items" value="${linkItemsText(l.link?.items)}" placeholder="P3_ID=#id#"></div>
      </div></fieldset>`);
  }
  return html`<input type="hidden" name="layers" value="1">${parts}`;
}

/** A map can filter a report on its page to the visible area; the report needs position columns. */
async function mapReportFieldset(r: RegionRow, pageId: number, appId: number, id: (n: string) => string) {
  const cfg = r.config ?? {};
  const reports = (await owner.query(`select id, title, source, rest_source from meta.region where page_id = $1 and type = 'report' order by seq, id`, [pageId])).rows;
  const target = reports.find((x) => x.id === Number(cfg.report));
  const cols = target ? await reportColumns(appId, await designSql(appId, target)) : null;
  // with PostGIS a geometry/geography column filters too (only the column names are known here)
  const noPosition = cols && 'columns' in cols && !positionColumns(cols.columns) && !(await postgis());
  return html`<fieldset class="prop-group"><legend>${tx('rs.filter_a_report')}</legend><div class="form-grid">
      <div class="field"><label class="label" for="${id('report')}">${tx('rs.report_region')}</label>
        <select id="${id('report')}" name="report">${opt('', tx('rs.none'), target?.id)}${reports.map((x) => opt(String(x.id), `${x.title ?? tx('rs.untitled')} (#${x.id})`, cfg.report))}</select>
        <small class="help">${reports.length ? tx('rs.map_report_help') : tx('rs.map_report_none')}</small></div>
      <div class="field"><label class="label" for="${id('filter')}">${tx('rs.filter_by')}</label>
        <select id="${id('filter')}" name="filter">${opt('', tx('rs.the_visible_area'), cfg.filter)}${opt('distance', tx('rs.distance_from_the_centre'), cfg.filter)}</select>
        <small class="help">${tx('rs.the_condition_runs_on_the')}</small></div>
    </div>
    ${noPosition ? html`<div class="alert alert-error" role="alert">${tx.code('rs.no_position_alert')}</div>` : ''}
    </fieldset>`;
}

const FACET_TYPE_LABELS: Record<string, string> = { checkbox: 'Checkboxes', range: 'Ranges', star: 'Star rating' };

async function facetsFields(r: RegionRow, pageId: number, appId: number, id: (n: string) => string, smart: boolean) {
  const cfg = r.config ?? {};
  const reports = (await owner.query(`select id, title, source, rest_source from meta.region where page_id = $1 and type = 'report' order by seq, id`, [pageId])).rows;
  const target = reports.find((x) => x.id === Number(cfg.report));
  const cols = target ? await reportColumns(appId, await designSql(appId, target)) : null;
  const facets: Config[] = Array.isArray(cfg.facets) ? cfg.facets : [];
  const byCol = new Map(facets.map((f) => [f.column, f]));
  // configured facets first, in their order; then the report's other columns
  const { all, known } = withStale(
    [...facets.map((f) => f.column).filter((c) => cols && 'columns' in cols && cols.columns.includes(c)), ...(cols && 'columns' in cols ? cols.columns : []).filter((c) => !byCol.has(c))],
    facets.map((f) => f.column),
  );
  const rows = all.map((n, i) => {
    const f = byCol.get(n);
    const type = f?.type === 'range' || f?.type === 'star' ? f.type : 'checkbox';
    const custom = type === 'range' && (f?.custom === true || (f?.custom !== false && !(Array.isArray(f?.ranges) && f.ranges.length)));
    return html`<tr>
      <td data-label="${tx('rs.column')}"><code>${n}</code>${staleTag(known, n)}<input type="hidden" name="col_${i}" value="${n}"></td>
      <td data-label="${tx('rs.facet')}"><input type="checkbox" name="on_${i}" value="true"${f ? raw(' checked') : ''} aria-label="${tx('rs.aria_facet_on', { name: n })}"></td>
      <td data-label="${tx('rs.label')}"><input name="label_${i}" value="${f?.label ?? ''}" placeholder="${heading(n)}" aria-label="${tx('rs.aria_label_of', { name: n })}"></td>
      <td data-label="${tx('rs.type')}"><select name="type_${i}" aria-label="${tx('rs.aria_type_of_the_facet_on', { name: n })}">${Object.entries(FACET_TYPE_LABELS).map(([k, l]) => opt(k, tx.dyn(`rs.facet.${k}`, l), type))}</select></td>
      <td data-label="${tx('rs.values_shown')}"><input name="limit_${i}" type="number" min="1" max="50" value="${f?.limit ?? ''}" placeholder="${FACET_LIMIT}" aria-label="${tx('rs.aria_values_shown_for', { name: n })}" class="u-mw6"></td>
      <td data-label="${tx('rs.exclude')}"><input type="checkbox" name="exclude_${i}" value="true"${f?.exclude === true ? raw(' checked') : ''} aria-label="${tx('rs.aria_users_may_exclude_values_of', { name: n })}"></td>
      <td data-label="${tx('rs.ranges')}"><input name="ranges_${i}" value="${rangesText(f?.ranges)}" placeholder="..1000; 1000..3000 = Middle; 3000.." aria-label="${tx('rs.aria_ranges_of', { name: n })}"></td>
      <td data-label="${tx('rs.from_to')}"><input type="checkbox" name="custom_${i}" value="true"${custom ? raw(' checked') : ''} aria-label="${tx('rs.aria_users_may_type_a_range', { name: n })}"></td>
      ${smart ? '' : html`<td data-label="${tx('rs.chart')}"><select name="chart_${i}" aria-label="${tx('rs.aria_chart_of_the_facet_on', { name: n })}">${opt('', tx('rs.none_2'), f?.chart)}${opt('bar', tx('rs.bar'), f?.chart)}${opt('pie', tx('rs.pie'), f?.chart)}</select></td>`}
      <td data-label="${tx('rs.order')}"><input name="seq_${i}" type="number" value="${(i + 1) * 10}" aria-label="${tx('rs.aria_order_of', { name: n })}" class="u-mw6"></td>
    </tr>`;
  });
  return html`<input type="hidden" name="n" value="${all.length}">
    <fieldset class="prop-group"><legend>${tx('rs.filters')}</legend><div class="form-grid">
      <div class="field"><label class="label" for="${id('report')}">${tx('rs.report_region')}</label>
        <select id="${id('report')}" name="report">${opt('', tx('rs.choose'), target?.id)}${reports.map((x) => opt(String(x.id), `${x.title ?? tx('rs.untitled')} (#${x.id})`, cfg.report))}</select>
        <small class="help">${reports.length ? tx(smart ? 'rs.report_smart_help' : 'rs.report_facets_help') : tx('rs.report_first')}</small></div>
      ${smart
        ? html`<div class="field"><label class="label" for="${id('suggestions')}">${tx('rs.suggestions_per_facet_0_10')}</label>
            <input id="${id('suggestions')}" name="suggestions" type="number" min="0" max="10" value="${cfg.suggestions ?? 3}"></div>
          <div class="field" data-wide><label class="label" for="${id('placeholder')}">${tx('rs.placeholder_of_the_search_field')}</label>
            <input id="${id('placeholder')}" name="placeholder" maxlength="100" value="${cfg.placeholder ?? ''}" placeholder="${tx('rs.search_or_filter')}"></div>
          ${check('ask', tx('rs.read_the_search_as_a'), cfg.ask === true)}`
        : html`${check('search', tx('rs.a_search_field_searches_all'), cfg.search === true)}`}
    </div></fieldset>
    ${cols && 'error' in cols ? columnsHint(cols) : ''}
    ${target
      ? html`<fieldset class="prop-group"><legend>${tx('rs.facets')}</legend>
          ${all.length
            ? html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>${tx('rs.column')}</th><th>${tx('rs.facet')}</th><th>${tx('rs.label')}</th><th>${tx('rs.type')}</th><th>${tx('rs.values_shown')}</th><th>${tx('rs.exclude')}</th><th>${tx('rs.ranges')}</th><th>${tx('rs.from_to')}</th>${smart ? '' : html`<th>${tx('rs.chart')}</th>`}<th>${tx('rs.order')}</th></tr></thead><tbody>${rows}</tbody></table></div>
              <small class="help">${tx.code('rs.facets_help')}${smart ? '' : html` ${tx('rs.facets_help_chart')}`}</small>`
            : html`<p class="muted">${tx('rs.the_report_has_no_columns')}</p>`}
        </fieldset>`
      : ''}`;
}

const VIEW_LABELS: Record<string, string> = { month: 'Month', week: 'Week', day: 'Day', list: 'List' };
const GRID_USER_VIEWS = ['row', 'group', 'chart'] as const;
const GRID_VIEW_LABELS: Record<string, string> = { row: 'Single row view', group: 'Group by', chart: 'Chart' };

async function calendarFields(appId: number, r: RegionRow, id: (n: string) => string, pages: { page_no: number; name: string }[]) {
  const cfg = r.config ?? {};
  const views = calendarViews(cfg);
  const schemes = (await owner.query('select name from meta.authz_scheme where app_id = $1 order by name', [appId])).rows.map((x) => x.name as string);
  return html`${columnsHint(await reportColumns(appId, await designSql(appId, r)), ['start_date', 'title'])}
    <p class="muted u-mt0">${tx.code('rs.calendar_help')}</p>
    <fieldset class="prop-group"><legend>${tx('rs.views')}</legend>
      <div class="form-grid">
        ${CALENDAR_VIEWS.map((v) => check(`view_${v}`, tx.dyn(`rs.view.${v}`, VIEW_LABELS[v]), views.includes(v)))}
        <div class="field"><label class="label" for="${id('view')}">${tx('rs.shown_first')}</label>
          <select id="${id('view')}" name="view">${CALENDAR_VIEWS.map((v) => opt(v, tx.dyn(`rs.view.${v}`, VIEW_LABELS[v]), cfg.view ?? views[0]))}</select></div>
        <div class="field"><label class="label" for="${id('day_start')}">${tx('rs.week_and_day_views_from')}</label>
          <input id="${id('day_start')}" name="day_start" type="number" min="0" max="23" value="${cfg.day_start ?? ''}" placeholder="8"></div>
        <div class="field"><label class="label" for="${id('day_end')}">${tx('rs.until_hour')}</label>
          <input id="${id('day_end')}" name="day_end" type="number" min="1" max="24" value="${cfg.day_end ?? ''}" placeholder="18"></div>
      </div>
      <small class="help">${tx('rs.users_switch_between_the_ticked')}</small></fieldset>
    ${linkFieldset(id, cfg.link, pages, tx('rs.w.event'), { legend: tx('rs.edit_link') })}
    ${linkFieldset(id, cfg.create, pages, tx('rs.w.slot'), {
      prefix: 'create', legend: tx('rs.create_on_click'), placeholder: 'P3_START=#start#,P3_END=#end#',
      help: tx('rs.create_help'),
    })}
    <fieldset class="prop-group"><legend>${tx('rs.drag_and_drop')}</legend><div class="form-grid">
      <div class="field" data-wide><label class="label" for="${id('move')}">${tx('rs.sql_that_moves_an_event')}</label>
        <textarea id="${id('move')}" name="move" rows="3" data-code="sql" placeholder="update my_schema.event set starts_at = :NEW_START::timestamp, ends_at = :NEW_END::timestamp where id = :EVENT_ID::int">${cfg.move ?? ''}</textarea>
        <small class="help">${tx.code('rs.runs_as_the_application_s')}</small></div>
      <div class="field"><label class="label" for="${id('key')}">${tx('rs.key_column')}</label>
        <input id="${id('key')}" name="key" value="${cfg.key ?? ''}" placeholder="id"></div>
      <div class="field"><label class="label" for="${id('move_authz')}">${tx('rs.who_may_drag')}</label>
        <select id="${id('move_authz')}" name="move_authz">${opt('', tx('rs.everyone_who_sees_the_calendar'), cfg.move_authz)}${opt('MUST_NOT_BE_PUBLIC_USER', tx('rs.signed_in_users'), cfg.move_authz)}${schemes.map((n) => opt(n, `Authorization: ${n}`, cfg.move_authz))}</select></div>
    </div>
    <small class="help">${tx('rs.only_events_the_user_sees')}</small></fieldset>`;
}

/** The display selector's settings: style and options, and which regions of the page take part. */
async function displaySelectorFields(r: RegionRow, pageId: number, id: (n: string) => string) {
  const cfg = r.config ?? {};
  const others = (await owner.query(`select id, title, type, config->'display_selector' as flag from meta.region
                                     where page_id = $1 and id <> $2 and type <> 'display_selector' order by seq, id`, [pageId, r.id])).rows;
  return html`<fieldset class="prop-group"><legend>${tx('rs.appearance')}</legend><div class="form-grid">
      <div class="field"><label class="label" for="${id('style')}">${tx('rs.show_as')}</label>
        <select id="${id('style')}" name="style">${opt('', tx('rs.tabs'), cfg.style)}${opt('select', tx('rs.select_list'), cfg.style)}${opt('carousel', tx('rs.carousel_one_at_a_time'), cfg.style)}</select></div>
      <div class="field"><label class="label" for="${id('interval')}">${tx('rs.carousel_next_region_every_seconds')}</label>
        <input id="${id('interval')}" name="interval" type="number" min="1" max="120" value="${cfg.interval ?? ''}" placeholder="empty: only by hand">
        <small class="help">${tx('rs.not_while_the_pointer_or')}</small></div>
    </div>
    ${check('show_all', tx('rs.show_all_choice_shows_every'), cfg.show_all !== false)}
    ${check('remember', tx('rs.remember_the_choice_during_the'), cfg.remember !== false)}</fieldset>
    <fieldset class="prop-group"><legend>${tx('rs.regions')}</legend>
      <input type="hidden" name="members" value="1">
      ${others.length
        ? html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>${tx('rs.region')}</th><th>${tx('rs.in_a_tab')}</th><th>${tx('rs.tab_name')}</th></tr></thead><tbody>
            ${others.map((x) => html`<tr>
              <td data-label="${tx('rs.region')}">${x.title || '(untitled)'} <span class="muted">(${x.type} #${x.id})</span></td>
              <td data-label="${tx('rs.in_a_tab')}"><input type="checkbox" name="member_${x.id}" value="true"${x.flag === true || (typeof x.flag === 'string' && x.flag.trim()) ? raw(' checked') : ''} aria-label="${tx('rs.aria_show_in_the_display_selector', { name: x.title || `region ${x.id}` })}"></td>
              <td data-label="${tx('rs.tab_name')}"><input name="tab_${x.id}" maxlength="60" value="${typeof x.flag === 'string' ? x.flag : ''}" placeholder="${x.title || ''}" aria-label="${tx('rs.aria_tab_name_of', { name: x.title || `region ${x.id}` })}"></td>
            </tr>`)}</tbody></table></div>`
        : html`<p class="muted">${tx('rs.there_are_no_other_regions')}</p>`}
      <small class="help">${tx.code('rs.a_chosen_region_gets_display')}</small>
    </fieldset>`;
}

/** The settings form under a region in the page designer, or '' for types without one. */
/** (sprint 162) in the developer's builder language: the helpers below use the request's scoped translator */
export const regionSettingsForm = (pageId: number, appId: number, r: RegionRow, s: Session) => withTranslator(tr(s), () => regionSettingsFormInner(pageId, appId, r, s));

async function regionSettingsFormInner(pageId: number, appId: number, r: RegionRow, s: Session): Promise<Raw | ''> {
  if (r.type === 'report') return html`${await reportSettingsForm(pageId, appId, r, s)}${await columnTemplatesForm(pageId, appId, r, s)}${await aiFilterSettingsForm(pageId, appId, r, s)}`;
  if (r.type === 'ai_assistant') return assistantSettingsForm(pageId, appId, r, s);
  if (r.type === 'template_component') return templateRegionForm(pageId, appId, r, s);
  if (r.type === 'data_reporter') return reporterSettingsForm(pageId, appId, r, s);
  if (r.type === 'form_designer') return formDesignerSettingsForm(pageId, appId, r, s);
  if (!(SETTINGS_TYPES as readonly string[]).includes(r.type)) return '';
  const cfg = r.config ?? {};
  const id = (n: string) => `rg_${r.id}_${n}`;
  const pages = async () => (await owner.query('select page_no, name from meta.page where app_id = $1 order by page_no', [appId])).rows;
  const schemes = async () => (await owner.query('select name from meta.authz_scheme where app_id = $1 order by name', [appId])).rows.map((x) => x.name as string);
  let body: Raw;
  let title = tx('rs.t.settings');
  switch (r.type as SettingsType) {
    case 'grid':
      title = tx('rs.t.grid');
      body = await gridFields(appId, r, id);
      break;
    case 'chart':
      title = tx('rs.t.chart');
      body = html`${columnsHint(await reportColumns(appId, await designSql(appId, r)))}
        <p class="muted u-mt0">${tx.code('rs.chart_help')}</p>
        <fieldset class="prop-group"><legend>${tx('rs.appearance')}</legend><div class="form-grid">
          <div class="field"><label class="label" for="${id('kind')}">${tx('rs.chart_type')}</label>
            <select id="${id('kind')}" name="kind">${CHART_KINDS.map((k) => opt(k, tx.dyn(`rs.chart.${k}`, CHART_LABELS[k]), cfg.kind ?? 'bar'))}</select></div>
          ${emptyField(id, cfg)}
        </div></fieldset>
        <fieldset class="prop-group"><legend>${tx('rs.gauge')}</legend><div class="form-grid">
          ${GAUGE_KEYS.map((k) => html`<div class="field"><label class="label" for="${id(`gauge_${k}`)}">${tx(`rs.gauge.${k}`)}</label>
            <input id="${id(`gauge_${k}`)}" name="gauge_${k}" type="number" step="any" value="${cfg.gauge?.[k] ?? ''}" placeholder="${k === 'min' ? '0' : k === 'max' ? 'automatic' : ''}"></div>`)}
        </div>
        <small class="help">${tx('rs.gauge_charts_only_a_warning')}</small></fieldset>
        ${linkFieldset(id, cfg.link, await pages(), tx('rs.w.point'))}
        <small class="help">${tx.code('rs.drill_down_column_takes_the')}</small>
        <fieldset class="prop-group"><legend>${tx('rs.gantt_drag_and_drop')}</legend><div class="form-grid">
          <div class="field" data-wide><label class="label" for="${id('gantt_move')}">${tx('rs.sql_that_moves_a_task')}</label>
            <textarea id="${id('gantt_move')}" name="gantt_move" rows="3" data-code="sql" placeholder="update my_schema.task set starts = :NEW_START::date, ends = :NEW_END::date where id = :TASK_ID::int">${cfg.gantt_move ?? ''}</textarea>
            <small class="help">${tx.code('rs.gantt_charts_with_a_task')}</small></div>
          <div class="field"><label class="label" for="${id('gantt_move_authz')}">${tx('rs.who_may_drag')}</label>
            <select id="${id('gantt_move_authz')}" name="gantt_move_authz">${opt('', tx('rs.everyone_who_sees_the_chart'), cfg.gantt_move_authz)}${opt('MUST_NOT_BE_PUBLIC_USER', tx('rs.signed_in_users'), cfg.gantt_move_authz)}${(await schemes()).map((n) => opt(n, `Authorization: ${n}`, cfg.gantt_move_authz))}</select></div>
          <div class="field"><label class="label" for="${id('gantt_snap')}">${tx('rs.steps')}</label>
            <select id="${id('gantt_snap')}" name="gantt_snap">${opt('', tx('rs.days_or_hours_when_a'), cfg.gantt_snap)}${opt('day', tx('rs.days'), cfg.gantt_snap)}${opt('hour', tx('rs.hours'), cfg.gantt_snap)}</select></div>
        </div><small class="help">${tx('rs.only_tasks_the_user_sees')}</small></fieldset>`;
      break;
    case 'cards':
      title = tx('rs.t.cards');
      body = html`${columnsHint(await reportColumns(appId, await designSql(appId, r)))}
        <p class="muted u-mt0">Cards show the columns ${CARD_COLUMNS.map((c, i) => html`${i ? ', ' : ''}<code>${c}</code>`)}; KPI tiles show title, badge (the value) and icon.</p>
        <fieldset class="prop-group"><legend>${tx('rs.appearance')}</legend><div class="form-grid">
          <div class="field"><label class="label" for="${id('style')}">${tx('rs.style')}</label>
            <select id="${id('style')}" name="style">${opt('', tx('rs.cards'), cfg.style)}${opt('metric', tx('rs.kpi_tiles_metric'), cfg.style)}</select></div>
          ${emptyField(id, cfg)}
        </div></fieldset>
        ${linkFieldset(id, cfg.link, await pages(), tx('rs.w.card'))}`;
      break;
    case 'calendar':
      title = tx('rs.t.calendar');
      body = await calendarFields(appId, r, id, await pages());
      break;
    case 'facets':
      title = tx('rs.t.facets');
      body = await facetsFields(r, pageId, appId, id, false);
      break;
    case 'smart_filters':
      title = tx('rs.t.smart');
      body = await facetsFields(r, pageId, appId, id, true);
      break;
    case 'display_selector':
      title = tx('rs.t.selector');
      body = await displaySelectorFields(r, pageId, id);
      break;
    case 'list': {
      title = tx('rs.t.list');
      const lists = (await owner.query('select name, type from meta.list where app_id = $1 order by name', [appId])).rows;
      body = html`<p class="muted u-mt0">${tx('rs.shows_a_list_from_shared')}</p>
        <fieldset class="prop-group"><legend>${tx('rs.list')}</legend><div class="form-grid">
          <div class="field"><label class="label" for="${id('list')}">${tx('rs.list')}</label>
            <select id="${id('list')}" name="list">${opt('', tx('rs.choose'), cfg.list)}${lists.map((l) => opt(l.name, `${l.name} (${l.type})`, cfg.list))}${cfg.list && !lists.some((l) => l.name === cfg.list) ? opt(cfg.list, `${cfg.list} (missing!)`, cfg.list) : ''}</select></div>
          <div class="field"><label class="label" for="${id('template')}">${tx('rs.template')}</label>
            <select id="${id('template')}" name="template">${opt('', tx('rs.links_nested'), cfg.template)}${opt('badges', tx('rs.badge_list'), cfg.template)}${opt('cards', tx('rs.cards_menu'), cfg.template)}${opt('tabs', tx('rs.tabs'), cfg.template)}${opt('wizard_progress', tx('rs.wizard_progress_numbered_steps'), cfg.template)}</select></div>
        </div></fieldset>`;
      break;
    }
    case 'map': {
      title = tx('rs.t.map');
      const allPages = await pages();
      body = html`${columnsHint(await reportColumns(appId, await designSql(appId, r)))}
        <p class="muted u-mt0">${tx.code('rs.map_help')}</p>
        <fieldset class="prop-group"><legend>${tx('rs.appearance')}</legend><div class="form-grid">
          <div class="field"><label class="label" for="${id('layer')}">${tx('rs.show_places_as')}</label>
            <select id="${id('layer')}" name="layer">${opt('', tx('rs.markers'), cfg.layer)}${opt('heat', tx('rs.heat_map'), cfg.layer)}${opt('lines', tx('rs.lines'), cfg.layer)}${opt('polygons', tx('rs.polygons'), cfg.layer)}${opt('extruded', tx('rs.extruded_polygons_shaded_by_height'), cfg.layer)}</select></div>
          ${styleFields(id, 'style', cfg.style)}
          <div class="field"><label class="label" for="${id('name')}">${tx('rs.layer_name_legend')}</label>
            <input id="${id('name')}" name="name" value="${cfg.name ?? ''}" maxlength="60" placeholder="the region title"></div>
          <div class="field"><label class="label" for="${id('height')}">${tx('rs.height')}</label>
            <select id="${id('height')}" name="height">${opt('small', tx('rs.small'), cfg.height)}${opt('', tx('rs.medium'), cfg.height)}${opt('large', tx('rs.large'), cfg.height)}</select></div>
          <div class="field"><label class="label" for="${id('zoom')}">${tx('rs.zoom_for_a_single_place')}</label>
            <input id="${id('zoom')}" name="zoom" type="number" min="1" max="19" value="${cfg.zoom ?? ''}" placeholder="14"></div>
          ${loadField(id, 'load', cfg)}
          ${check('cluster', tx('rs.group_markers_that_are_close'), cfg.cluster === true)}
          ${emptyField(id, cfg)}
        </div></fieldset>
        ${linkFieldset(id, cfg.link, allPages, tx('rs.w.place'))}
        ${await mapLayersFieldsets(cfg, appId, allPages, id)}
        ${await mapReportFieldset(r, pageId, appId, id)}`;
      break;
    }
    case 'tree':
      title = tx('rs.t.tree');
      body = html`${columnsHint(await reportColumns(appId, await designSql(appId, r)), ['id', 'parent_id', 'label'])}
        <p class="muted u-mt0">${tx.code('rs.tree_help')}</p>
        <fieldset class="prop-group"><legend>${tx('rs.appearance')}</legend><div class="form-grid">
          <div class="field"><label class="label" for="${id('expanded')}">${tx('rs.levels_open_at_first')}</label>
            <input id="${id('expanded')}" name="expanded" type="number" min="0" max="20" value="${cfg.expanded ?? 1}"></div>
          ${emptyField(id, cfg)}
        </div></fieldset>
        ${linkFieldset(id, cfg.link, await pages(), tx('rs.w.node'))}`;
      break;
    case 'workflows':
      title = tx('rs.t.workflows');
      body = html`<p class="muted u-mt0">${tx.code('rs.workflow_help')}</p>
        <fieldset class="prop-group"><legend>${tx('rs.workflows')}</legend><div class="form-grid">
          <div class="field"><label class="label" for="${id('context')}">${tx('rs.show')}</label>
            <select id="${id('context')}" name="context">${opt('', tx('rs.workflows_i_started'), cfg.context)}${opt('admin', tx('rs.workflows_i_administer'), cfg.context)}</select></div>
          ${emptyField(id, cfg)}
        </div>
        ${check('completed', tx('rs.include_completed_and_terminated_workflows'), cfg.completed === true)}</fieldset>`;
      break;
    case 'tasks':
      title = tx('rs.t.tasks');
      body = html`<p class="muted u-mt0">${tx.code('rs.task_help')}</p>
        <fieldset class="prop-group"><legend>${tx('rs.tasks')}</legend><div class="form-grid">
          <div class="field"><label class="label" for="${id('context')}">${tx('rs.show')}</label>
            <select id="${id('context')}" name="context">${opt('', tx('rs.my_tasks_to_act_on'), cfg.context)}${opt('initiated', tx('rs.tasks_i_requested'), cfg.context)}${opt('admin', tx('rs.tasks_i_administer'), cfg.context)}</select></div>
          ${emptyField(id, cfg)}
        </div>
        ${check('completed', tx('rs.include_completed_and_cancelled_tasks'), cfg.completed === true)}</fieldset>`;
      break;
  }
  return html`<h3 class="u-mt15">${title}</h3>
    <p class="muted u-mt0">${tx('rs.these_fields_write_the_region')}</p>
    <form method="post" action="${BASE}/pages/${pageId}/region/${r.id}/settings" class="component-form">${csrf(s)}
      ${body!}
      <div class="buttons"><button class="btn btn-hot">Save ${title.toLowerCase()}</button></div>
    </form>`;
}

// ---------------------------------------------------------------- route

export async function regionSettingsRoutes(app: FastifyInstance) {
  app.post(`${BASE}/pages/:pid/region/:rid/settings`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const { pid, rid } = req.params as { pid: string; rid: string };
    const r = /^\d+$/.test(pid) && /^\d+$/.test(rid)
      ? await owner.one(`select r.id, r.type, r.config, p.app_id from meta.region r join meta.page p on p.id = r.page_id where r.id = $1 and r.page_id = $2`, [rid, pid])
      : undefined;
    if (!r || !(SETTINGS_TYPES as readonly string[]).includes(r.type)) return reply.code(404).send('Not found');
    const [pages, lovs, reports, schemes] = await Promise.all([
      owner.query('select page_no from meta.page where app_id = $1', [r.app_id]),
      owner.query('select name from meta.lov where app_id = $1', [r.app_id]),
      r.type === 'facets' || r.type === 'smart_filters' || r.type === 'map' ? owner.query(`select id, source from meta.region where page_id = $1 and type = 'report'`, [pid]) : Promise.resolve({ rows: [] as any[] }),
      owner.query('select name from meta.authz_scheme where app_id = $1', [r.app_id]),
    ]);
    const reportCols = new Map<number, string[]>();
    for (const x of reports.rows) {
      const c = await reportColumns(r.app_id, await designSql(r.app_id, x));
      reportCols.set(x.id, 'columns' in c ? c.columns : []);
    }
    const config = MERGES[r.type as SettingsType](r.config ?? {}, (req.body ?? {}) as Body, {
      pages: new Set(pages.rows.map((x) => x.page_no)),
      lovs: new Set(lovs.rows.map((x) => x.name)),
      reports: reportCols,
      authz: new Set(schemes.rows.map((x) => String(x.name).toUpperCase())),
    });
    await owner.query('update meta.region set config = $2 where id = $1', [r.id, JSON.stringify(config)]);
    // the display selector's form also says which regions of the page take part
    const b = (req.body ?? {}) as Body;
    if (r.type === 'display_selector' && b.members === '1') {
      // {region id: true or the tab name}, for the regions of this page only (checked in the update)
      const flags: Record<string, string | boolean> = {};
      for (const k of Object.keys(b)) {
        const m = /^member_(\d{1,9})$/.exec(k);
        if (m && b[k] === 'true') flags[m[1]] = (b[`tab_${m[1]}`] ?? '').trim().slice(0, 60) || true;
      }
      await owner.query(
        `update meta.region set config = case when $3::jsonb ? id::text then jsonb_set(config, '{display_selector}', $3::jsonb -> id::text) else config - 'display_selector' end
          where page_id = $1 and id <> $2 and type <> 'display_selector'
            and ($3::jsonb -> id::text) is distinct from (config -> 'display_selector')`,
        [pid, r.id, JSON.stringify(flags)],
      );
    }
    flash(s, tr(s)('rs.saved'));
    return back(reply, s, `${BASE}/pages/${pid}?c=region-${rid}`);
  });
}
