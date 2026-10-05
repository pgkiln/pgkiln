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
  pyramid: 'Pyramid (one series; two series back to back)',
  polar: 'Polar area (one sector per row)',
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
  { prefix = 'link', legend = 'Link', placeholder = 'P3_ID=#id#', help = "ITEM=#column#, comma separated; #column# is replaced by the row's value." } = {},
) {
  return html`<fieldset class="prop-group"><legend>${legend}</legend><div class="form-grid">
    <div class="field"><label class="label" for="${id(`${prefix}_page`)}">${what} links to page</label>
      <select id="${id(`${prefix}_page`)}" name="${prefix}_page">${opt('', '- no link -', link?.page)}${pages.map((p) => opt(String(p.page_no), `${p.page_no}. ${p.name}`, link?.page))}</select></div>
    <div class="field" data-wide><label class="label" for="${id(`${prefix}_items`)}">Set items</label>
      <input id="${id(`${prefix}_items`)}" name="${prefix}_items" value="${linkItemsText(link?.items)}" placeholder="${placeholder}">
      <small class="help">${help}</small></div>
  </div></fieldset>`;
}

const emptyField = (id: (n: string) => string, cfg: Config) => html`<div class="field" data-wide><label class="label" for="${id('empty')}">Text when there are no rows</label>
  <input id="${id('empty')}" name="empty" value="${cfg.empty ?? ''}" placeholder="No data found"></div>`;

/** Columns in the settings that the query no longer returns stay listed (marked), so they can be cleared. */
function withStale(names: string[], configured: string[]) {
  const known = new Set(names);
  return { all: [...names, ...[...new Set(configured)].filter((n) => !known.has(n))], known };
}

const staleTag = (known: Set<string>, n: string) => (known.has(n) ? '' : html` <span class="tag tag-error">not in the query</span>`);

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

const FACET_FORM_KEYS = ['label', 'limit', 'type', 'ranges', 'custom', 'exclude'];

/** The facets table of a faceted search or smart filters form (and the report it filters). */
function mergeFacetList(out: Config, config: Config, b: Body, a: Allowed) {
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
  if (!mergeFacetList(out, config, b, a)) return out;
  const set = setter(out);
  const n = Number(b.suggestions);
  set('suggestions', b.suggestions !== undefined && b.suggestions !== '' && Number.isInteger(n) && n >= 0 && n <= 10 && n !== 3 ? n : undefined);
  set('placeholder', b.placeholder?.trim().slice(0, 100) || undefined);
  return out;
}

export function mergeDisplaySelectorSettings(config: Config, b: Body): Config {
  const out = { ...config };
  const set = setter(out);
  set('style', b.style === 'select' ? 'select' : undefined);
  set('show_all', b.show_all === 'true' ? undefined : false);
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

export function mergeMapSettings(config: Config, b: Body, a: Allowed): Config {
  const out = { ...config };
  const set = setter(out);
  set('height', b.height === 'small' || b.height === 'large' ? b.height : undefined);
  const zoom = Number(b.zoom);
  set('zoom', b.zoom && Number.isInteger(zoom) && zoom >= 1 && zoom <= 19 ? zoom : undefined);
  set('empty', b.empty?.trim() || undefined);
  set('link', mergeLink(b, a.pages));
  set('layer', b.layer === 'heat' ? 'heat' : undefined);
  set('cluster', b.cluster === 'true' && b.layer !== 'heat' ? true : undefined);
  set('name', b.name?.trim().slice(0, 60) || undefined);
  const report = Number(b.report);
  set('report', b.report && a.reports.has(report) ? report : undefined);
  set('filter', b.filter === 'distance' && out.report !== undefined ? 'distance' : undefined);
  // more layers: layer<i>_source (empty: the layer is removed), _name, _layer, _cluster, _hidden, _link_page/_items
  if (b.layers === '1') {
    const layers: Config[] = [];
    for (let i = 0; i < MAX_EXTRA_LAYERS; i++) {
      const source = b[`layer${i}_source`]?.trim();
      if (!source) continue;
      const layer: Config = { name: b[`layer${i}_name`]?.trim().slice(0, 60) || `Layer ${layers.length + 2}`, source };
      if (b[`layer${i}_layer`] === 'heat') layer.layer = 'heat';
      else if (b[`layer${i}_cluster`] === 'true') layer.cluster = true;
      if (b[`layer${i}_hidden`] === 'true') layer.hidden = true;
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
    return html`<select name="lov_${i}" aria-label="List of values of ${n}">${opt('', '- text field -', cur)}${lovs.map((l) => opt(`LOV:${l}`, l, cur?.toUpperCase()))}${custom ? opt(custom, `custom: ${custom.length > 40 ? custom.slice(0, 40) + '…' : custom}`, cur) : ''}</select>`;
  };
  const rows = all.map((n, i) => html`<tr>
      <td data-label="Column"><code>${n}</code>${staleTag(known, n)}<input type="hidden" name="col_${i}" value="${n}"></td>
      <td data-label="Heading"><input name="heading_${i}" value="${cfg.headings?.[n] ?? ''}" placeholder="${heading(n)}" aria-label="Heading of ${n}"></td>
      <td data-label="Shown"><input type="checkbox" name="shown_${i}" value="true"${hidden.has(n.toLowerCase()) ? '' : raw(' checked')} aria-label="Show ${n}"></td>
      <td data-label="Read-only"><input type="checkbox" name="readonly_${i}" value="true"${readonly.has(n.toLowerCase()) ? raw(' checked') : ''} aria-label="${n} is read-only"></td>
      <td data-label="Required"><input type="checkbox" name="required_${i}" value="true"${colCfg[n]?.required ? raw(' checked') : ''} aria-label="${n} is required"></td>
      <td data-label="Edit as">${lovSelect(n, i)}</td>
    </tr>`);

  return html`${'error' in cols ? columnsHint(cols) : ''}
    <input type="hidden" name="n" value="${all.length}">
    <fieldset class="prop-group"><legend>Behaviour</legend><div class="form-grid">
      <div class="field"><label class="label" for="${id('page_size')}">Rows per page</label>
        <select id="${id('page_size')}" name="page_size">${GRID_PAGE_SIZES.map((x) => opt(x, x, cfg.page_size ?? 25))}</select></div>
      ${check('allow_insert', 'Users may add rows', allow.insert !== false)}
      ${check('allow_update', 'Users may change rows', allow.update !== false)}
      ${check('allow_delete', 'Users may delete rows', allow.delete !== false)}
    </div>
    <small class="help">Saving needs a process of type "grid_dml" for this region; without one the grid is read-only.</small></fieldset>
    <input type="hidden" name="grid_features" value="1">
    <fieldset class="prop-group"><legend>Totals and columns</legend><div class="form-grid">
      <div class="field" data-wide><label class="label" for="${id('aggregates')}">Aggregates in the footer</label>
        <input id="${id('aggregates')}" name="aggregates" value="${aggregatesText(cfg.aggregates)}" placeholder="sal=sum,avg; empno=count">
        <small class="help">column=sum, avg, count, min or max; separate columns with ";". Computed over all rows of the search, not only the page. Users can add their own (Actions → Aggregate).</small></div>
      <div class="field"><label class="label" for="${id('frozen')}">Frozen columns</label>
        <select id="${id('frozen')}" name="frozen">${['0', '1', '2', '3', '4', '5'].map((x) => opt(x, x === '0' ? 'none' : `the first ${x}`, cfg.frozen ?? 0))}</select>
        <small class="help">Stay in view while the grid scrolls sideways. Users can change it, move, resize and hide columns; "layout" in the JSON sets the default order and widths.</small></div>
      ${check('actions', 'Actions menu (columns, aggregates, saved reports)', cfg.actions !== false)}
      ${check('saved_reports', 'Users may save grid reports', cfg.saved_reports !== false)}
      <div class="field"><label class="label" for="${id('public_reports')}">Public reports by</label>
        <select id="${id('public_reports')}" name="public_reports">${opt('', '- nobody -', cfg.public_reports)}${authz.map((n) => opt(n, n, cfg.public_reports))}</select></div>
    </div></fieldset>
    <fieldset class="prop-group"><legend>Row actions</legend><div class="form-grid">
      ${check('row_actions', 'Row actions menu', !!cfg.row_actions)}
      ${check('row_duplicate', 'Duplicate', cfg.row_actions?.duplicate !== false)}
      ${check('row_delete', 'Delete', cfg.row_actions?.delete !== false)}
    </div></fieldset>
    ${linkFieldset(id, cfg.row_actions?.edit, pages, 'Edit', { prefix: 'edit', legend: 'Row actions: edit', placeholder: 'P3_ID=#id#' })}
    <fieldset class="prop-group"><legend>Master-detail</legend><div class="form-grid">
      <div class="field"><label class="label" for="${id('select_column')}">As a master: column of the selected row</label>
        <select id="${id('select_column')}" name="select_column">${opt('', '- not a master -', cfg.select_row?.column)}${all.map((n) => opt(n, n, cfg.select_row?.column))}</select></div>
      <div class="field"><label class="label" for="${id('select_item')}">… goes into item</label>
        <input id="${id('select_item')}" name="select_item" value="${cfg.select_row?.item ?? ''}" placeholder="P1_ID"></div>
      <div class="field"><label class="label" for="${id('master_item')}">As a detail: follows item</label>
        <input id="${id('master_item')}" name="master_item" value="${cfg.master?.item ?? ''}" placeholder="P1_ID"></div>
      <div class="field"><label class="label" for="${id('master_column')}">… and new rows get it in column</label>
        <input id="${id('master_column')}" name="master_column" value="${cfg.master?.column ?? ''}" placeholder="dept_id"></div>
    </div>
    <small class="help">A master grid's selected row puts its value into a page item; detail grids and reports use it in their query (:P1_ID) and are refreshed without reloading the page. Other region types follow with {"master": {"item": "P1_ID"}}.</small></fieldset>
    <fieldset class="prop-group"><legend>Columns</legend>
      ${all.length
        ? html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>Column</th><th>Heading</th><th>Shown</th><th>Read-only</th><th>Required</th><th>Edit as</th></tr></thead><tbody>${rows}</tbody></table></div>
          <small class="help">"Edit as" picks a shared list of values (Shared Components → Lists of values) for a select list.</small>`
        : html`<p class="muted">No columns yet.</p>`}
    </fieldset>`;
}

/** A map's further layers, each with its own query: the filled ones and one empty to add (up to MAX_EXTRA_LAYERS). */
async function mapLayersFieldsets(cfg: Config, appId: number, allPages: { page_no: number; name: string }[], id: (n: string) => string) {
  const layers: Config[] = (Array.isArray(cfg.layers) ? cfg.layers : []).slice(0, MAX_EXTRA_LAYERS);
  const shown = layers.length < MAX_EXTRA_LAYERS ? [...layers, {}] : layers;
  const parts = [];
  for (const [i, l] of shown.entries()) {
    const p = `layer${i}`;
    const hint = l.source ? columnsHint(await reportColumns(appId, l.source)) : '';
    parts.push(html`<fieldset class="prop-group"><legend>${l.source ? `Layer ${i + 2}: ${l.name ?? ''}` : 'Add a layer'}</legend>
      ${hint}
      <div class="form-grid">
        <div class="field"><label class="label" for="${id(`${p}_name`)}">Name (legend)</label>
          <input id="${id(`${p}_name`)}" name="${p}_name" value="${l.name ?? ''}" maxlength="60"></div>
        <div class="field"><label class="label" for="${id(`${p}_layer`)}">Show places as</label>
          <select id="${id(`${p}_layer`)}" name="${p}_layer">${opt('', 'Markers', l.layer)}${opt('heat', 'Heat map', l.layer)}</select></div>
        ${check(`${p}_cluster`, 'Group close markers', l.cluster === true)}
        ${check(`${p}_hidden`, 'Off at first', l.hidden === true)}
        <div class="field" data-wide><label class="label" for="${id(`${p}_source`)}">Query</label>
          <textarea id="${id(`${p}_source`)}" name="${p}_source" class="code" rows="5" spellcheck="false" data-code="sql" placeholder="select lat, lng, title from …">${l.source ?? ''}</textarea>
          <small class="help">The same columns as the map's own query. Empty the query to remove the layer.</small></div>
        <div class="field"><label class="label" for="${id(`${p}_link_page`)}">Each place links to page</label>
          <select id="${id(`${p}_link_page`)}" name="${p}_link_page">${opt('', '- no link -', l.link?.page)}${allPages.map((x) => opt(String(x.page_no), `${x.page_no}. ${x.name}`, l.link?.page))}</select></div>
        <div class="field"><label class="label" for="${id(`${p}_link_items`)}">Set items</label>
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
  return html`<fieldset class="prop-group"><legend>Filter a report</legend><div class="form-grid">
      <div class="field"><label class="label" for="${id('report')}">Report region</label>
        <select id="${id('report')}" name="report">${opt('', '- none -', target?.id)}${reports.map((x) => opt(String(x.id), `${x.title ?? '(untitled)'} (#${x.id})`, cfg.report))}</select>
        <small class="help">${reports.length ? 'Users can show only the rows in the map\'s visible area ("Show this area in the list"), or near its centre. The report needs lat and lng (or location) columns, or a PostGIS geometry/geography column.' : 'Add a report region to this page to filter it by the map area.'}</small></div>
      <div class="field"><label class="label" for="${id('filter')}">Filter by</label>
        <select id="${id('filter')}" name="filter">${opt('', 'The visible area', cfg.filter)}${opt('distance', 'Distance from the centre', cfg.filter)}</select>
        <small class="help">The condition runs on the server: with PostGIS installed on a geometry/geography column, else on latitude and longitude.</small></div>
    </div>
    ${noPosition ? html`<div class="alert alert-error" role="alert">The report has no <code>lat</code>/<code>lng</code> or <code>location</code> columns, so the map area can't filter it.</div>` : ''}
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
      <td data-label="Column"><code>${n}</code>${staleTag(known, n)}<input type="hidden" name="col_${i}" value="${n}"></td>
      <td data-label="Facet"><input type="checkbox" name="on_${i}" value="true"${f ? raw(' checked') : ''} aria-label="Facet on ${n}"></td>
      <td data-label="Label"><input name="label_${i}" value="${f?.label ?? ''}" placeholder="${heading(n)}" aria-label="Label of ${n}"></td>
      <td data-label="Type"><select name="type_${i}" aria-label="Type of the facet on ${n}">${Object.entries(FACET_TYPE_LABELS).map(([k, l]) => opt(k, l, type))}</select></td>
      <td data-label="Values shown"><input name="limit_${i}" type="number" min="1" max="50" value="${f?.limit ?? ''}" placeholder="${FACET_LIMIT}" aria-label="Values shown for ${n}" class="u-mw6"></td>
      <td data-label="Exclude"><input type="checkbox" name="exclude_${i}" value="true"${f?.exclude === true ? raw(' checked') : ''} aria-label="Users may exclude values of ${n}"></td>
      <td data-label="Ranges"><input name="ranges_${i}" value="${rangesText(f?.ranges)}" placeholder="..1000; 1000..3000 = Middle; 3000.." aria-label="Ranges of ${n}"></td>
      <td data-label="From/to"><input type="checkbox" name="custom_${i}" value="true"${custom ? raw(' checked') : ''} aria-label="Users may type a range for ${n}"></td>
      <td data-label="Order"><input name="seq_${i}" type="number" value="${(i + 1) * 10}" aria-label="Order of ${n}" class="u-mw6"></td>
    </tr>`;
  });
  return html`<input type="hidden" name="n" value="${all.length}">
    <fieldset class="prop-group"><legend>Filters</legend><div class="form-grid">
      <div class="field"><label class="label" for="${id('report')}">Report region</label>
        <select id="${id('report')}" name="report">${opt('', '- choose -', target?.id)}${reports.map((x) => opt(String(x.id), `${x.title ?? '(untitled)'} (#${x.id})`, cfg.report))}</select>
        <small class="help">${reports.length ? `The report on this page that the ${smart ? 'smart filters' : 'facets'} filter. Save to list its columns.` : 'Add a report region to this page first.'}</small></div>
      ${smart
        ? html`<div class="field"><label class="label" for="${id('suggestions')}">Suggestions per facet (0–10)</label>
            <input id="${id('suggestions')}" name="suggestions" type="number" min="0" max="10" value="${cfg.suggestions ?? 3}"></div>
          <div class="field" data-wide><label class="label" for="${id('placeholder')}">Placeholder of the search field</label>
            <input id="${id('placeholder')}" name="placeholder" maxlength="100" value="${cfg.placeholder ?? ''}" placeholder="Search or filter…"></div>`
        : html`${check('search', 'A search field (searches all columns of the report)', cfg.search === true)}`}
    </div></fieldset>
    ${cols && 'error' in cols ? columnsHint(cols) : ''}
    ${target
      ? html`<fieldset class="prop-group"><legend>Facets</legend>
          ${all.length
            ? html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>Column</th><th>Facet</th><th>Label</th><th>Type</th><th>Values shown</th><th>Exclude</th><th>Ranges</th><th>From/to</th><th>Order</th></tr></thead><tbody>${rows}</tbody></table></div>
              <small class="help">Checkboxes list the most frequent values (Exclude lets users filter them out instead). Ranges and From/to need a number or date column: ranges are <code>from..to = label</code> separated by <code>;</code>, an open end left empty (<code>..1000</code>, <code>2020-01-01..</code>); a range includes its start, not its end. A star rating offers "4 stars and up" and so on (up to 5; <code>"max"</code> in the JSON changes it).</small>`
            : html`<p class="muted">The report has no columns.</p>`}
        </fieldset>`
      : ''}`;
}

const VIEW_LABELS: Record<string, string> = { month: 'Month', week: 'Week', day: 'Day', list: 'List' };

async function calendarFields(appId: number, r: RegionRow, id: (n: string) => string, pages: { page_no: number; name: string }[]) {
  const cfg = r.config ?? {};
  const views = calendarViews(cfg);
  const schemes = (await owner.query('select name from meta.authz_scheme where app_id = $1 order by name', [appId])).rows.map((x) => x.name as string);
  return html`${columnsHint(await reportColumns(appId, await designSql(appId, r)), ['start_date', 'title'])}
    <p class="muted u-mt0">The query returns <code>start_date</code>, <code>title</code> and optionally <code>end_date</code> (dates for all-day events, timestamps for events with a time).</p>
    <fieldset class="prop-group"><legend>Views</legend>
      <div class="form-grid">
        ${CALENDAR_VIEWS.map((v) => check(`view_${v}`, VIEW_LABELS[v], views.includes(v)))}
        <div class="field"><label class="label" for="${id('view')}">Shown first</label>
          <select id="${id('view')}" name="view">${CALENDAR_VIEWS.map((v) => opt(v, VIEW_LABELS[v], cfg.view ?? views[0]))}</select></div>
        <div class="field"><label class="label" for="${id('day_start')}">Week and day views from hour</label>
          <input id="${id('day_start')}" name="day_start" type="number" min="0" max="23" value="${cfg.day_start ?? ''}" placeholder="8"></div>
        <div class="field"><label class="label" for="${id('day_end')}">Until hour</label>
          <input id="${id('day_end')}" name="day_end" type="number" min="1" max="24" value="${cfg.day_end ?? ''}" placeholder="18"></div>
      </div>
      <small class="help">Users switch between the ticked views. Hours outside the range are added when an event needs them.</small></fieldset>
    ${linkFieldset(id, cfg.link, pages, 'Each event', { legend: 'Edit link' })}
    ${linkFieldset(id, cfg.create, pages, 'An empty day or hour slot', {
      prefix: 'create', legend: 'Create on click', placeholder: 'P3_START=#start#,P3_END=#end#',
      help: 'ITEM=#start#, #end# or #date#: the slot clicked (YYYY-MM-DD, or YYYY-MM-DD HH:MI for an hour slot).',
    })}
    <fieldset class="prop-group"><legend>Drag and drop</legend><div class="form-grid">
      <div class="field" data-wide><label class="label" for="${id('move')}">SQL that moves an event</label>
        <textarea id="${id('move')}" name="move" rows="3" data-code="sql" placeholder="update my_schema.event set starts_at = :NEW_START::timestamp, ends_at = :NEW_END::timestamp where id = :EVENT_ID::int">${cfg.move ?? ''}</textarea>
        <small class="help">Runs as the application's database role (row level security applies) with <code>:EVENT_ID</code> (the key column's value), <code>:NEW_START</code> and <code>:NEW_END</code> (same duration as before). Empty: events can't be dragged.</small></div>
      <div class="field"><label class="label" for="${id('key')}">Key column</label>
        <input id="${id('key')}" name="key" value="${cfg.key ?? ''}" placeholder="id"></div>
      <div class="field"><label class="label" for="${id('move_authz')}">Who may drag</label>
        <select id="${id('move_authz')}" name="move_authz">${opt('', 'Everyone who sees the calendar', cfg.move_authz)}${opt('MUST_NOT_BE_PUBLIC_USER', 'Signed-in users', cfg.move_authz)}${schemes.map((n) => opt(n, `Authorization: ${n}`, cfg.move_authz))}</select></div>
    </div>
    <small class="help">Only events the user sees in this calendar can be moved; without a mouse, the edit link changes the dates.</small></fieldset>`;
}

/** The display selector's settings: style and options, and which regions of the page take part. */
async function displaySelectorFields(r: RegionRow, pageId: number, id: (n: string) => string) {
  const cfg = r.config ?? {};
  const others = (await owner.query(`select id, title, type, config->'display_selector' as flag from meta.region
                                     where page_id = $1 and id <> $2 and type <> 'display_selector' order by seq, id`, [pageId, r.id])).rows;
  return html`<fieldset class="prop-group"><legend>Appearance</legend><div class="form-grid">
      <div class="field"><label class="label" for="${id('style')}">Show as</label>
        <select id="${id('style')}" name="style">${opt('', 'Tabs', cfg.style)}${opt('select', 'Select list', cfg.style)}</select></div>
    </div>
    ${check('show_all', '"Show all" choice (shows every region)', cfg.show_all !== false)}
    ${check('remember', 'Remember the choice during the session', cfg.remember !== false)}</fieldset>
    <fieldset class="prop-group"><legend>Regions</legend>
      <input type="hidden" name="members" value="1">
      ${others.length
        ? html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>Region</th><th>In a tab</th><th>Tab name</th></tr></thead><tbody>
            ${others.map((x) => html`<tr>
              <td data-label="Region">${x.title || '(untitled)'} <span class="muted">(${x.type} #${x.id})</span></td>
              <td data-label="In a tab"><input type="checkbox" name="member_${x.id}" value="true"${x.flag === true || (typeof x.flag === 'string' && x.flag.trim()) ? raw(' checked') : ''} aria-label="Show ${x.title || `region ${x.id}`} in the display selector"></td>
              <td data-label="Tab name"><input name="tab_${x.id}" maxlength="60" value="${typeof x.flag === 'string' ? x.flag : ''}" placeholder="${x.title || ''}" aria-label="Tab name of ${x.title || `region ${x.id}`}"></td>
            </tr>`)}</tbody></table></div>`
        : html`<p class="muted">There are no other regions on this page.</p>`}
      <small class="help">A chosen region gets <code>"display_selector": true</code> in its settings (a tab named after it), or the tab name: regions with the same tab name share one tab (e.g. smart filters and their report). Without JavaScript every region shows, with links to each.</small>
    </fieldset>`;
}

/** The settings form under a region in the page designer, or '' for types without one. */
export async function regionSettingsForm(pageId: number, appId: number, r: RegionRow, s: Session): Promise<Raw | ''> {
  if (r.type === 'report') return html`${await reportSettingsForm(pageId, appId, r, s)}${await columnTemplatesForm(pageId, appId, r, s)}${await aiFilterSettingsForm(pageId, appId, r, s)}`;
  if (r.type === 'ai_assistant') return assistantSettingsForm(pageId, appId, r, s);
  if (r.type === 'template_component') return templateRegionForm(pageId, appId, r, s);
  if (r.type === 'data_reporter') return reporterSettingsForm(pageId, appId, r, s);
  if (!(SETTINGS_TYPES as readonly string[]).includes(r.type)) return '';
  const cfg = r.config ?? {};
  const id = (n: string) => `rg_${r.id}_${n}`;
  const pages = async () => (await owner.query('select page_no, name from meta.page where app_id = $1 order by page_no', [appId])).rows;
  let body: Raw;
  let title = 'Settings';
  switch (r.type as SettingsType) {
    case 'grid':
      title = 'Grid settings';
      body = await gridFields(appId, r, id);
      break;
    case 'chart':
      title = 'Chart settings';
      body = html`${columnsHint(await reportColumns(appId, await designSql(appId, r)))}
        <p class="muted u-mt0">The first column is the label; each following numeric column is a series (up to 8).
          A Gantt chart reads <code>label, start, end</code> (dates or timestamps; an empty end is a milestone) and optional columns named
          <code>progress</code> (0 to 100), <code>task_id</code> and <code>depends_on</code> (the ids a task waits for, e.g. <code>3,4</code>).</p>
        <fieldset class="prop-group"><legend>Appearance</legend><div class="form-grid">
          <div class="field"><label class="label" for="${id('kind')}">Chart type</label>
            <select id="${id('kind')}" name="kind">${CHART_KINDS.map((k) => opt(k, CHART_LABELS[k], cfg.kind ?? 'bar'))}</select></div>
          ${emptyField(id, cfg)}
        </div></fieldset>
        <fieldset class="prop-group"><legend>Gauge</legend><div class="form-grid">
          ${GAUGE_KEYS.map((k) => html`<div class="field"><label class="label" for="${id(`gauge_${k}`)}">${{ min: 'Minimum', max: 'Maximum', warning: 'Warning from', critical: 'Critical from' }[k]}</label>
            <input id="${id(`gauge_${k}`)}" name="gauge_${k}" type="number" step="any" value="${cfg.gauge?.[k] ?? ''}" placeholder="${k === 'min' ? '0' : k === 'max' ? 'automatic' : ''}"></div>`)}
        </div>
        <small class="help">Gauge charts only. A warning threshold above the critical one means low values are bad (e.g. warning 50, critical 20).</small></fieldset>
        ${linkFieldset(id, cfg.link, await pages(), 'Each data point')}
        <small class="help">Drill-down: <code>#column#</code> takes the value from the point's row, <code>#series#</code> the name of its series. Columns only the link refers to are not drawn.</small>`;
      break;
    case 'cards':
      title = 'Cards settings';
      body = html`${columnsHint(await reportColumns(appId, await designSql(appId, r)))}
        <p class="muted u-mt0">Cards show the columns ${CARD_COLUMNS.map((c, i) => html`${i ? ', ' : ''}<code>${c}</code>`)}; KPI tiles show title, badge (the value) and icon.</p>
        <fieldset class="prop-group"><legend>Appearance</legend><div class="form-grid">
          <div class="field"><label class="label" for="${id('style')}">Style</label>
            <select id="${id('style')}" name="style">${opt('', 'Cards', cfg.style)}${opt('metric', 'KPI tiles (metric)', cfg.style)}</select></div>
          ${emptyField(id, cfg)}
        </div></fieldset>
        ${linkFieldset(id, cfg.link, await pages(), 'Each card')}`;
      break;
    case 'calendar':
      title = 'Calendar settings';
      body = await calendarFields(appId, r, id, await pages());
      break;
    case 'facets':
      title = 'Faceted search settings';
      body = await facetsFields(r, pageId, appId, id, false);
      break;
    case 'smart_filters':
      title = 'Smart filters settings';
      body = await facetsFields(r, pageId, appId, id, true);
      break;
    case 'display_selector':
      title = 'Display selector settings';
      body = await displaySelectorFields(r, pageId, id);
      break;
    case 'list': {
      title = 'List settings';
      const lists = (await owner.query('select name, type from meta.list where app_id = $1 order by name', [appId])).rows;
      body = html`<p class="muted u-mt0">Shows a list from Shared Components → Lists. Entries the user may not open are left out.</p>
        <fieldset class="prop-group"><legend>List</legend><div class="form-grid">
          <div class="field"><label class="label" for="${id('list')}">List</label>
            <select id="${id('list')}" name="list">${opt('', '- choose -', cfg.list)}${lists.map((l) => opt(l.name, `${l.name} (${l.type})`, cfg.list))}${cfg.list && !lists.some((l) => l.name === cfg.list) ? opt(cfg.list, `${cfg.list} (missing!)`, cfg.list) : ''}</select></div>
          <div class="field"><label class="label" for="${id('template')}">Template</label>
            <select id="${id('template')}" name="template">${opt('', 'Links (nested)', cfg.template)}${opt('badges', 'Badge list', cfg.template)}${opt('cards', 'Cards (menu)', cfg.template)}${opt('tabs', 'Tabs', cfg.template)}</select></div>
        </div></fieldset>`;
      break;
    }
    case 'map': {
      title = 'Map settings';
      const allPages = await pages();
      body = html`${columnsHint(await reportColumns(appId, await designSql(appId, r)))}
        <p class="muted u-mt0">Each row is a marker at <code>lat</code>, <code>lng</code> (or <code>location</code> as "lat,lng"), with <code>title</code> and <code>body</code> in its popup; a <code>geojson</code> column draws lines and areas (with PostGIS installed, a <code>geometry</code> or <code>geography</code> column in WGS 84 works too). A heat map weighs each place by a <code>weight</code> column.</p>
        <fieldset class="prop-group"><legend>Appearance</legend><div class="form-grid">
          <div class="field"><label class="label" for="${id('layer')}">Show places as</label>
            <select id="${id('layer')}" name="layer">${opt('', 'Markers', cfg.layer)}${opt('heat', 'Heat map', cfg.layer)}</select></div>
          <div class="field"><label class="label" for="${id('name')}">Layer name (legend)</label>
            <input id="${id('name')}" name="name" value="${cfg.name ?? ''}" maxlength="60" placeholder="the region title"></div>
          <div class="field"><label class="label" for="${id('height')}">Height</label>
            <select id="${id('height')}" name="height">${opt('small', 'Small', cfg.height)}${opt('', 'Medium', cfg.height)}${opt('large', 'Large', cfg.height)}</select></div>
          <div class="field"><label class="label" for="${id('zoom')}">Zoom for a single place (1–19)</label>
            <input id="${id('zoom')}" name="zoom" type="number" min="1" max="19" value="${cfg.zoom ?? ''}" placeholder="14"></div>
          ${check('cluster', 'Group markers that are close together (clustering)', cfg.cluster === true)}
          ${emptyField(id, cfg)}
        </div></fieldset>
        ${linkFieldset(id, cfg.link, allPages, 'Each place')}
        ${await mapLayersFieldsets(cfg, appId, allPages, id)}
        ${await mapReportFieldset(r, pageId, appId, id)}`;
      break;
    }
    case 'tree':
      title = 'Tree settings';
      body = html`${columnsHint(await reportColumns(appId, await designSql(appId, r)), ['id', 'parent_id', 'label'])}
        <p class="muted u-mt0">The query returns <code>id</code>, <code>parent_id</code> and <code>label</code> (and optionally <code>icon</code>); rows whose parent isn't in the result are the roots.</p>
        <fieldset class="prop-group"><legend>Appearance</legend><div class="form-grid">
          <div class="field"><label class="label" for="${id('expanded')}">Levels open at first</label>
            <input id="${id('expanded')}" name="expanded" type="number" min="0" max="20" value="${cfg.expanded ?? 1}"></div>
          ${emptyField(id, cfg)}
        </div></fieldset>
        ${linkFieldset(id, cfg.link, await pages(), 'Each node')}`;
      break;
    case 'workflows':
      title = 'Workflow console settings';
      body = html`<p class="muted u-mt0">Workflows come from workflow definitions (Shared Components); application SQL starts them with <code>meta.start_workflow(…)</code>.</p>
        <fieldset class="prop-group"><legend>Workflows</legend><div class="form-grid">
          <div class="field"><label class="label" for="${id('context')}">Show</label>
            <select id="${id('context')}" name="context">${opt('', 'Workflows I started', cfg.context)}${opt('admin', 'Workflows I administer', cfg.context)}</select></div>
          ${emptyField(id, cfg)}
        </div>
        ${check('completed', 'Include completed and terminated workflows', cfg.completed === true)}</fieldset>`;
      break;
    case 'tasks':
      title = 'Task list settings';
      body = html`<p class="muted u-mt0">Tasks come from task definitions (Shared Components); application SQL creates them with <code>meta.create_task(…)</code>.</p>
        <fieldset class="prop-group"><legend>Tasks</legend><div class="form-grid">
          <div class="field"><label class="label" for="${id('context')}">Show</label>
            <select id="${id('context')}" name="context">${opt('', 'My tasks: to act on, claim, or assigned to me', cfg.context)}${opt('initiated', 'Tasks I requested', cfg.context)}${opt('admin', 'Tasks I administer', cfg.context)}</select></div>
          ${emptyField(id, cfg)}
        </div>
        ${check('completed', 'Include completed and cancelled tasks', cfg.completed === true)}</fieldset>`;
      break;
  }
  return html`<h3 class="u-mt15">${title}</h3>
    <p class="muted u-mt0">These fields write the region's settings JSON above (other keys are kept).</p>
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
    flash(s, 'Settings saved.');
    return back(reply, s, `${BASE}/pages/${pid}?c=region-${rid}`);
  });
}
