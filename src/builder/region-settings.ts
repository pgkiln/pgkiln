import type { FastifyInstance } from 'fastify';
import { designSql } from './websources.ts';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { CHART_KINDS } from '../runtime/charts.ts';
import { heading } from '../runtime/items.ts';
import { positionColumns } from '../runtime/report.ts';
import type { Session } from '../session.ts';
import { linkItemsText, parseLinkItems, reportColumns, reportSettingsForm } from './report-settings.ts';
import { back, BASE, csrf, developer, flash, type Req } from './ui.ts';
import { columnTemplatesForm, templateRegionForm } from './templates.ts';

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
}

export const SETTINGS_TYPES = ['grid', 'chart', 'cards', 'calendar', 'facets', 'tasks', 'workflows', 'map', 'tree'] as const;
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
};
const CARD_COLUMNS = ['title', 'subtitle', 'body', 'badge', 'icon'];
const FACET_LIMIT = 12;

// ---------------------------------------------------------------- shared bits

const opt = (value: string, label: string, current: unknown) => html`<option value="${value}"${String(current ?? '') === value ? raw(' selected') : ''}>${label}</option>`;
const check = (name: string, label: string, on: boolean) =>
  html`<div class="field"><span class="label" aria-hidden="true"></span><label class="check"><input type="checkbox" name="${name}" value="true"${on ? raw(' checked') : ''}> ${label}</label></div>`;

/** A {page, items} link from the form, or undefined (no page, or a page of another app). */
function mergeLink(b: Body, pages: Set<number>) {
  const page = Number(b.link_page);
  if (!b.link_page || !pages.has(page)) return undefined;
  const items = parseLinkItems(b.link_items);
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

function linkFieldset(id: (n: string) => string, link: { page?: number; items?: Record<string, string> } | undefined, pages: { page_no: number; name: string }[], what: string) {
  return html`<fieldset class="prop-group"><legend>Link</legend><div class="form-grid">
    <div class="field"><label class="label" for="${id('link_page')}">${what} links to page</label>
      <select id="${id('link_page')}" name="link_page">${opt('', '- no link -', link?.page)}${pages.map((p) => opt(String(p.page_no), `${p.page_no}. ${p.name}`, link?.page))}</select></div>
    <div class="field" data-wide><label class="label" for="${id('link_items')}">Set items</label>
      <input id="${id('link_items')}" name="link_items" value="${linkItemsText(link?.items)}" placeholder="P3_ID=#id#">
      <small class="help">ITEM=#column#, comma separated; #column# is replaced by the row's value.</small></div>
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

export function mergeChartSettings(config: Config, b: Body): Config {
  const out = { ...config };
  const set = setter(out);
  set('kind', b.kind && (CHART_KINDS as string[]).includes(b.kind) && b.kind !== 'bar' ? b.kind : undefined);
  set('empty', b.empty?.trim() || undefined);
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
  setter(out)('link', mergeLink(b, a.pages));
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
  return out;
}

export function mergeFacetsSettings(config: Config, b: Body, a: Allowed): Config {
  const out = { ...config };
  const set = setter(out);
  const report = Number(b.report);
  const columns = a.reports.get(report);
  set('report', columns ? report : undefined);
  if (!columns) return out;
  const n = Math.min(Number(b.n) || 0, 500);
  const old = new Map<string, Config>((config.facets ?? []).map((f: Config) => [f.column, f]));
  const facets = Array.from({ length: n }, (_, i) => ({
    column: (b[`col_${i}`] ?? '').trim(),
    on: b[`on_${i}`] === 'true',
    label: (b[`label_${i}`] ?? '').trim(),
    limit: Number(b[`limit_${i}`]),
    seq: Number(b[`seq_${i}`]) || (i + 1) * 10,
  }))
    .filter((f) => f.on && columns.includes(f.column))
    .sort((x, y) => x.seq - y.seq)
    .map((f) => {
      const { label: _l, limit: _n, ...rest } = old.get(f.column) ?? {};
      return {
        ...rest,
        column: f.column,
        ...(f.label ? { label: f.label } : {}),
        ...(Number.isInteger(f.limit) && f.limit >= 1 && f.limit <= 50 && f.limit !== FACET_LIMIT ? { limit: f.limit } : {}),
      };
    });
  set('facets', facets.length ? facets : undefined);
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
  const report = Number(b.report);
  set('report', b.report && a.reports.has(report) ? report : undefined);
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
  chart: (c, b) => mergeChartSettings(c, b),
  cards: mergeCardsSettings,
  calendar: mergeCalendarSettings,
  facets: mergeFacetsSettings,
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
    <fieldset class="prop-group"><legend>Columns</legend>
      ${all.length
        ? html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>Column</th><th>Heading</th><th>Shown</th><th>Read-only</th><th>Required</th><th>Edit as</th></tr></thead><tbody>${rows}</tbody></table></div>
          <small class="help">"Edit as" picks a shared list of values (Shared Components → Lists of values) for a select list.</small>`
        : html`<p class="muted">No columns yet.</p>`}
    </fieldset>`;
}

/** A map can filter a report on its page to the visible area; the report needs position columns. */
async function mapReportFieldset(r: RegionRow, pageId: number, appId: number, id: (n: string) => string) {
  const cfg = r.config ?? {};
  const reports = (await owner.query(`select id, title, source from meta.region where page_id = $1 and type = 'report' order by seq, id`, [pageId])).rows;
  const target = reports.find((x) => x.id === Number(cfg.report));
  const cols = target ? await reportColumns(appId, await designSql(appId, target)) : null;
  const noPosition = cols && 'columns' in cols && !positionColumns(cols.columns);
  return html`<fieldset class="prop-group"><legend>Filter a report</legend><div class="form-grid">
      <div class="field"><label class="label" for="${id('report')}">Report region</label>
        <select id="${id('report')}" name="report">${opt('', '- none -', target?.id)}${reports.map((x) => opt(String(x.id), `${x.title ?? '(untitled)'} (#${x.id})`, cfg.report))}</select>
        <small class="help">${reports.length ? 'Users can show only the rows in the map\'s visible area ("Show this area in the list"). The report needs lat and lng (or location) columns.' : 'Add a report region to this page to filter it by the map area.'}</small></div>
    </div>
    ${noPosition ? html`<div class="alert alert-error" role="alert">The report has no <code>lat</code>/<code>lng</code> or <code>location</code> columns, so the map area can't filter it.</div>` : ''}
    </fieldset>`;
}

async function facetsFields(r: RegionRow, pageId: number, appId: number, id: (n: string) => string) {
  const cfg = r.config ?? {};
  const reports = (await owner.query(`select id, title, source from meta.region where page_id = $1 and type = 'report' order by seq, id`, [pageId])).rows;
  const target = reports.find((x) => x.id === Number(cfg.report));
  const cols = target ? await reportColumns(appId, await designSql(appId, target)) : null;
  const facets: Config[] = cfg.facets ?? [];
  const byCol = new Map(facets.map((f) => [f.column, f]));
  // configured facets first, in their order; then the report's other columns
  const { all, known } = withStale(
    [...facets.map((f) => f.column).filter((c) => cols && 'columns' in cols && cols.columns.includes(c)), ...(cols && 'columns' in cols ? cols.columns : []).filter((c) => !byCol.has(c))],
    facets.map((f) => f.column),
  );
  const rows = all.map((n, i) => {
    const f = byCol.get(n);
    return html`<tr>
      <td data-label="Column"><code>${n}</code>${staleTag(known, n)}<input type="hidden" name="col_${i}" value="${n}"></td>
      <td data-label="Facet"><input type="checkbox" name="on_${i}" value="true"${f ? raw(' checked') : ''} aria-label="Facet on ${n}"></td>
      <td data-label="Label"><input name="label_${i}" value="${f?.label ?? ''}" placeholder="${heading(n)}" aria-label="Label of ${n}"></td>
      <td data-label="Values shown"><input name="limit_${i}" type="number" min="1" max="50" value="${f?.limit ?? ''}" placeholder="${FACET_LIMIT}" aria-label="Values shown for ${n}" class="u-mw6"></td>
      <td data-label="Order"><input name="seq_${i}" type="number" value="${(i + 1) * 10}" aria-label="Order of ${n}" class="u-mw6"></td>
    </tr>`;
  });
  return html`<input type="hidden" name="n" value="${all.length}">
    <fieldset class="prop-group"><legend>Filters</legend><div class="form-grid">
      <div class="field"><label class="label" for="${id('report')}">Report region</label>
        <select id="${id('report')}" name="report">${opt('', '- choose -', target?.id)}${reports.map((x) => opt(String(x.id), `${x.title ?? '(untitled)'} (#${x.id})`, cfg.report))}</select>
        <small class="help">${reports.length ? 'The report on this page that the facets filter. Save to list its columns.' : 'Add a report region to this page first.'}</small></div>
    </div></fieldset>
    ${cols && 'error' in cols ? columnsHint(cols) : ''}
    ${target
      ? html`<fieldset class="prop-group"><legend>Facets</legend>
          ${all.length
            ? html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>Column</th><th>Facet</th><th>Label</th><th>Values shown</th><th>Order</th></tr></thead><tbody>${rows}</tbody></table></div>`
            : html`<p class="muted">The report has no columns.</p>`}
        </fieldset>`
      : ''}`;
}

/** The settings form under a region in the page designer, or '' for types without one. */
export async function regionSettingsForm(pageId: number, appId: number, r: RegionRow, s: Session): Promise<Raw | ''> {
  if (r.type === 'report') return html`${await reportSettingsForm(pageId, appId, r, s)}${await columnTemplatesForm(pageId, appId, r, s)}`;
  if (r.type === 'template_component') return templateRegionForm(pageId, appId, r, s);
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
        <p class="muted u-mt0">The first column is the label; each following numeric column is a series (up to 8).</p>
        <fieldset class="prop-group"><legend>Appearance</legend><div class="form-grid">
          <div class="field"><label class="label" for="${id('kind')}">Chart type</label>
            <select id="${id('kind')}" name="kind">${CHART_KINDS.map((k) => opt(k, CHART_LABELS[k], cfg.kind ?? 'bar'))}</select></div>
          ${emptyField(id, cfg)}
        </div></fieldset>`;
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
      body = html`${columnsHint(await reportColumns(appId, await designSql(appId, r)), ['start_date', 'title'])}
        <p class="muted u-mt0">The query returns <code>start_date</code>, <code>title</code> and optionally <code>end_date</code>.</p>
        ${linkFieldset(id, cfg.link, await pages(), 'Each event')}`;
      break;
    case 'facets':
      title = 'Faceted search settings';
      body = await facetsFields(r, pageId, appId, id);
      break;
    case 'map':
      title = 'Map settings';
      body = html`${columnsHint(await reportColumns(appId, await designSql(appId, r)))}
        <p class="muted u-mt0">Each row is a marker at <code>lat</code>, <code>lng</code> (or <code>location</code> as "lat,lng"), with <code>title</code> and <code>body</code> in its popup; a <code>geojson</code> column draws lines and areas. A heat map weighs each place by a <code>weight</code> column.</p>
        <fieldset class="prop-group"><legend>Appearance</legend><div class="form-grid">
          <div class="field"><label class="label" for="${id('layer')}">Show places as</label>
            <select id="${id('layer')}" name="layer">${opt('', 'Markers', cfg.layer)}${opt('heat', 'Heat map', cfg.layer)}</select></div>
          <div class="field"><label class="label" for="${id('height')}">Height</label>
            <select id="${id('height')}" name="height">${opt('small', 'Small', cfg.height)}${opt('', 'Medium', cfg.height)}${opt('large', 'Large', cfg.height)}</select></div>
          <div class="field"><label class="label" for="${id('zoom')}">Zoom for a single place (1–19)</label>
            <input id="${id('zoom')}" name="zoom" type="number" min="1" max="19" value="${cfg.zoom ?? ''}" placeholder="14"></div>
          ${emptyField(id, cfg)}
        </div></fieldset>
        ${linkFieldset(id, cfg.link, await pages(), 'Each place')}
        ${await mapReportFieldset(r, pageId, appId, id)}`;
      break;
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
    const [pages, lovs, reports] = await Promise.all([
      owner.query('select page_no from meta.page where app_id = $1', [r.app_id]),
      owner.query('select name from meta.lov where app_id = $1', [r.app_id]),
      r.type === 'facets' || r.type === 'map' ? owner.query(`select id, source from meta.region where page_id = $1 and type = 'report'`, [pid]) : Promise.resolve({ rows: [] as any[] }),
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
    });
    await owner.query('update meta.region set config = $2 where id = $1', [r.id, JSON.stringify(config)]);
    flash(s, 'Settings saved.');
    return back(reply, s, `${BASE}/pages/${pid}?c=region-${rid}`);
  });
}
