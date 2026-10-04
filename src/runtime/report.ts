import { icon } from '../icons.ts';
import pg from 'pg';
import { applyBinds, literal, queryValues, SqlParams } from '../binds.ts';
import { savepoint } from '../db.ts';
import { esc, html, raw, type Raw } from '../html.ts';
import type { Region } from '../metadata.ts';
import { isAuthorized, pageAllowed } from './authz.ts';
import { bindValues, publicError, stripSemicolon, type PageContext } from './context.ts';
import { heading, splitValues } from './items.ts';
import { linkAttrs } from './links.ts';
import type { Translate } from '../i18n.ts';
import type { Formatter } from './format.ts';
import { writeXlsx, type XlsxCell } from '../xlsx.ts';
import { REPORT_CHART_KINDS } from './charts.ts';
import { ComputeError, computeNameOk, computeSql, type Computation } from './compute.ts';
import { renderView, VIEWS, type View } from './report-views.ts';
import { columnTemplates } from './template-components.ts';
import { facetFilterSql, facetFilters, reportFacetDefs, searchSql } from './facet-state.ts';
import { resolveRestRegion } from './rest-sources.ts';

// Interactive report: the developer's SELECT is wrapped as a subquery and the
// end user's search, filters, sort and paging are applied around it. User
// input only ever becomes query parameters (search, facets) or escaped
// literals (filters, highlights), quoted identifiers of columns that exist in
// the result, whitelisted operators, or integers.

const NUMERIC_OIDS = new Set([20, 21, 23, 26, 700, 701, 1700]);
export const isNumeric = (typeOid: number) => NUMERIC_OIDS.has(typeOid);
const PDF_MAX_ROWS = Number(process.env.PDF_MAX_ROWS ?? 5000);
const TIMESTAMP_OIDS = new Set([1114, 1184]);
export const PAGE_SIZES = [5, 10, 15, 25, 50, 100];
/** Rows in a CSV or Excel download (streamed with a cursor, so memory stays flat); Excel's own limit is 1,048,575. */
export const DOWNLOAD_MAX_ROWS = Math.max(1, Math.min(1_048_575, Number(process.env.DOWNLOAD_MAX_ROWS) || 1_000_000));
/** The highest page number a report or grid accepts from the URL. */
export const MAX_PAGE = 1_000_000;

/**
 * A region's row limit (config.max_rows): a whole number from 1 to 1,000,000,
 * or the fallback when it is missing or not a positive number.
 */
export function maxRows(r: { config: Record<string, any> }, fallback: number | null): number | null {
  const n = Math.floor(Number(r.config?.max_rows));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 1_000_000) : fallback;
}

/** "Row ranges X to Y" without a total (config.pagination = "range"), as in APEX; otherwise "X–Y of N". */
export const rangePaging = (r: Region) => r.config.pagination === 'range';

/** The rows of one page: offset and limit (one row more than shown, so the pager knows whether there is a next page). */
export function pageWindow(r: Region, st: { page: number; size: number }) {
  const max = maxRows(r, null);
  const page = Math.max(1, Math.min(st.page, max ? Math.ceil(max / st.size) : MAX_PAGE));
  const offset = (page - 1) * st.size;
  return { page, offset, limit: max ? Math.max(1, Math.min(st.size + 1, max + 1 - offset)) : st.size + 1, max };
}

export const OPERATORS: Record<string, { label: string; sql: (col: string, v: string) => string; noValue?: boolean }> = {
  eq: { label: '=', sql: (c, v) => `${c} = ${literal(v)}` },
  ne: { label: '≠', sql: (c, v) => `${c} is distinct from ${literal(v)}` },
  contains: { label: 'contains', sql: (c, v) => `${c}::text ilike ${literal(`%${escapeLike(v)}%`)}` },
  not_contains: { label: 'does not contain', sql: (c, v) => `coalesce(${c}::text, '') not ilike ${literal(`%${escapeLike(v)}%`)}` },
  gt: { label: '>', sql: (c, v) => `${c} > ${literal(v)}` },
  ge: { label: '≥', sql: (c, v) => `${c} >= ${literal(v)}` },
  lt: { label: '<', sql: (c, v) => `${c} < ${literal(v)}` },
  le: { label: '≤', sql: (c, v) => `${c} <= ${literal(v)}` },
  null: { label: 'is empty', sql: (c) => `${c} is null`, noValue: true },
  not_null: { label: 'is not empty', sql: (c) => `${c} is not null`, noValue: true },
};

const escapeLike = (v: string) => v.replace(/[\\%_]/g, '\\$&');

/** Operator names in the user's language (symbols stay as they are). */
const opLabel = (t: Translate, op: string) =>
  ({ contains: t('op.contains'), not_contains: t('op.not_contains'), null: t('op.null'), not_null: t('op.not_null') } as Record<string, string>)[op] ?? OPERATORS[op]?.label ?? op;

interface Filter {
  column: string;
  op: string;
  value: string;
  raw: string;
}

export const AGGREGATES: Record<string, { numeric: boolean; sql: (col: string) => string }> = {
  sum: { numeric: true, sql: (c) => `sum(${c})` },
  avg: { numeric: true, sql: (c) => `round(avg(${c})::numeric, 2)` },
  count: { numeric: false, sql: (c) => `count(${c})` },
  min: { numeric: false, sql: (c) => `min(${c})` },
  max: { numeric: false, sql: (c) => `max(${c})` },
};
export const HIGHLIGHT_COLORS = ['yellow', 'green', 'red', 'blue', 'gray'];

interface Aggregate {
  fn: string;
  column: string;
  raw: string;
}

interface Highlight extends Filter {
  color: string;
}

export interface ReportState {
  search: string;
  sort: number;
  desc: boolean;
  page: number;
  size: number;
  filters: Filter[];
  /** control break column */
  breakCol: string | null;
  aggregates: Aggregate[];
  highlights: Highlight[];
  /** computed columns (name|expression) */
  computations: Computation[];
  /** which view shows: the rows, or a group by, pivot or chart of them */
  view: View;
  groupBy: { columns: string[]; functions: Aggregate[] };
  pivot: { row: string; column: string; fn: string; value: string } | null;
  chart: { kind: string; label: string; fn: string; value: string } | null;
  /** the visible area of a map region that filters this report (r<id>_bb) */
  area: MapArea | null;
}

/** A map's visible area: south, west, north, east (west > east when it spans the antimeridian). */
export interface MapArea {
  s: number;
  w: number;
  n: number;
  e: number;
}

/** "south,west,north,east" → a map area, or null when it isn't one. */
export function parseArea(v: string | null): MapArea | null {
  const parts = (v ?? '').split(',');
  if (parts.length !== 4 || parts.some((x) => !/^\s*-?\d{1,3}(\.\d{1,8})?\s*$/.test(x))) return null;
  const [s, w, n, e] = parts.map(Number);
  return Math.abs(s) <= 90 && Math.abs(n) <= 90 && s <= n && Math.abs(w) <= 180 && Math.abs(e) <= 180 ? { s, w, n, e } : null;
}

/**
 * The columns a report's rows have their position in, as for a map region:
 * lat/lng (or latitude/longitude, lon), or location as "lat,lng" text.
 */
export type Position = { lat: string; lng: string } | { location: string };
export function positionColumns(names: string[]): Position | null {
  const find = (...want: string[]) => names.find((n) => want.includes(n.toLowerCase()));
  const lat = find('lat', 'latitude');
  const lng = find('lng', 'lon', 'longitude');
  if (lat && lng) return { lat, lng };
  const location = find('location');
  return location ? { location } : null;
}

const LOCATION_RE = `'^\\s*-?\\d{1,2}(\\.\\d+)?\\s*,\\s*-?\\d{1,3}(\\.\\d+)?\\s*$'`;

/** SQL for "the row lies in the area" (the numbers are parsed, never text from the URL). */
export function areaCondition(area: MapArea, pos: Position) {
  const [lat, lng] =
    'lat' in pos
      ? [`(${q(pos.lat)})::float8`, `(${q(pos.lng)})::float8`]
      : [1, 2].map((i) => `(case when ${q(pos.location)}::text ~ ${LOCATION_RE} then trim(split_part(${q(pos.location)}::text, ',', ${i}))::float8 end)`);
  const lngIn = area.w <= area.e ? `${lng} between ${area.w} and ${area.e}` : `(${lng} >= ${area.w} or ${lng} <= ${area.e})`;
  return `(${lat} between ${area.s} and ${area.n} and ${lngIn})`;
}

export const MAX_COMPUTATIONS = 5;
const MAX_GROUP_COLUMNS = 3;
const MAX_GROUP_FUNCTIONS = 6;

export const key = (r: Region, k: string) => `r${r.id}_${k}`;

/**
 * Row selection: "selection": {"column": "empno", "item": "P2_SELECTED"} puts
 * a checkbox in front of each row; on submit the checked rows' values reach
 * the item, colon separated (like a checkbox group). The item must be on the
 * page; it may be hidden.
 */
export function selectionOf(page: { items: { name: string }[] }, r: Region) {
  const sel = r.config.selection as { column?: unknown; item?: unknown } | undefined;
  if (r.type !== 'report' || typeof sel?.column !== 'string' || typeof sel?.item !== 'string') return null;
  const item = sel.item.toUpperCase();
  return page.items.some((i) => i.name === item) ? { column: sel.column, item } : null;
}

export function reportState(ctx: PageContext, r: Region): ReportState {
  const p = ctx.params;
  const size = parseInt(p.get(key(r, 'n')) ?? '', 10) || Number(r.config.page_size) || 15;
  return {
    search: (p.get(key(r, 'q')) ?? '').trim(),
    sort: r.config.sortable === false ? 0 : Math.max(0, Math.min(1000, parseInt(p.get(key(r, 's')) ?? '0', 10) || 0)),
    desc: p.get(key(r, 'd')) === 'desc',
    page: Math.max(1, Math.min(MAX_PAGE, parseInt(p.get(key(r, 'p')) ?? '1', 10) || 1)),
    size: Math.max(1, Math.min(500, size)),
    filters: p.getAll(key(r, 'f')).flatMap((raw) => {
      const [column, op, ...rest] = raw.split('|');
      return column && OPERATORS[op] ? [{ column, op, value: rest.join('|'), raw }] : [];
    }),
    breakCol: p.get(key(r, 'b')) || null,
    aggregates: p.getAll(key(r, 'a')).slice(0, 20).flatMap((raw) => {
      const [fn, column] = raw.split('|');
      return AGGREGATES[fn] && column ? [{ fn, column, raw }] : [];
    }),
    // column|operator|color|value (the value last: it may contain "|")
    highlights: p.getAll(key(r, 'h')).slice(0, 10).flatMap((raw) => {
      const [column, op, color, ...rest] = raw.split('|');
      return column && OPERATORS[op] && HIGHLIGHT_COLORS.includes(color) ? [{ column, op, color, value: rest.join('|'), raw }] : [];
    }),
    // name|expression (the expression last: it may contain "|")
    computations: p.getAll(key(r, 'c')).slice(0, MAX_COMPUTATIONS).flatMap((raw) => {
      const [name, ...rest] = raw.split('|');
      return name && computeNameOk(name) && rest.length ? [{ name, expr: rest.join('|'), raw }] : [];
    }),
    view: (VIEWS as string[]).includes(p.get(key(r, 'v')) ?? '') ? (p.get(key(r, 'v')) as View) : 'report',
    groupBy: {
      columns: p.getAll(key(r, 'g')).filter(Boolean).slice(0, MAX_GROUP_COLUMNS),
      functions: p.getAll(key(r, 'ga')).slice(0, MAX_GROUP_FUNCTIONS).flatMap((raw) => {
        const [fn, column] = raw.split('|');
        return AGGREGATES[fn] && column ? [{ fn, column, raw }] : [];
      }),
    },
    pivot: (() => {
      const [row, column, fn, value] = (p.get(key(r, 'pv')) ?? '').split('|');
      return row && column && AGGREGATES[fn] && value ? { row, column, fn, value } : null;
    })(),
    chart: (() => {
      const [kind, label, fn, value] = (p.get(key(r, 'ch')) ?? '').split('|');
      return (REPORT_CHART_KINDS as string[]).includes(kind) && label && AGGREGATES[fn] && value ? { kind, label, fn, value } : null;
    })(),
    area: parseArea(p.get(key(r, 'bb'))),
  };
}

/**
 * The filter form submits r<id>_fc/_fo/_fv; fold them into a r<id>_f entry.
 * Returns the normalised query string when a redirect is needed.
 */
export function normaliseReportParams(params: URLSearchParams): string | null {
  let changed = false;
  const take = (id: string, names: string[]) => {
    const values = names.map((n) => params.get(`r${id}_${n}`) ?? '');
    for (const n of [...names, 'p']) params.delete(`r${id}_${n}`);
    changed = true;
    return values;
  };
  for (const k of [...params.keys()]) {
    let m: RegExpExecArray | null;
    if ((m = /^r(\d+)_fc$/.exec(k))) {
      // filter: column, operator, value
      const [col, op, val] = take(m[1], ['fc', 'fo', 'fv']);
      if (col && OPERATORS[op || 'eq']) params.append(`r${m[1]}_f`, `${col}|${op || 'eq'}|${val}`);
    } else if ((m = /^r(\d+)_bc$/.exec(k))) {
      // control break
      const [col] = take(m[1], ['bc']);
      if (col) params.set(`r${m[1]}_b`, col);
      else params.delete(`r${m[1]}_b`);
    } else if ((m = /^r(\d+)_ac$/.exec(k))) {
      // aggregate: function, column
      const [col, fn] = take(m[1], ['ac', 'af']);
      const v = `${fn}|${col}`;
      if (col && AGGREGATES[fn] && !params.getAll(`r${m[1]}_a`).includes(v)) params.append(`r${m[1]}_a`, v);
    } else if ((m = /^r(\d+)_hc$/.exec(k))) {
      // highlight: column, operator, value, color
      const [col, op, val, color] = take(m[1], ['hc', 'ho', 'hv', 'hk']);
      if (col && OPERATORS[op] && HIGHLIGHT_COLORS.includes(color)) params.append(`r${m[1]}_h`, `${col}|${op}|${color}|${val}`);
    } else if ((m = /^r(\d+)_cn$/.exec(k))) {
      // computed column: name, expression (a new expression under an existing name replaces it)
      const [name, expr] = take(m[1], ['cn', 'ce']);
      const n = name.trim();
      if (n && expr.trim() && computeNameOk(n)) {
        const rest = params.getAll(`r${m[1]}_c`).filter((x) => x.split('|')[0] !== n);
        params.delete(`r${m[1]}_c`);
        for (const x of [...rest, `${n}|${expr.trim()}`].slice(-MAX_COMPUTATIONS)) params.append(`r${m[1]}_c`, x);
      }
    } else if ((m = /^r(\d+)_gb1$/.exec(k))) {
      // group by: up to three columns and a function to add
      const [c1, c2, c3, fn, col] = take(m[1], ['gb1', 'gb2', 'gb3', 'gbf', 'gbc']);
      const columns = [...new Set([c1, c2, c3].filter(Boolean))];
      params.delete(`r${m[1]}_g`);
      for (const c of columns) params.append(`r${m[1]}_g`, c);
      const v = `${fn}|${col}`;
      if (AGGREGATES[fn] && col && !params.getAll(`r${m[1]}_ga`).includes(v)) params.append(`r${m[1]}_ga`, v);
      if (columns.length) params.set(`r${m[1]}_v`, 'group');
      else {
        params.delete(`r${m[1]}_ga`);
        if (params.get(`r${m[1]}_v`) === 'group') params.delete(`r${m[1]}_v`);
      }
    } else if ((m = /^r(\d+)_pr$/.exec(k))) {
      // pivot: row column, pivot column, function, value column
      const [row, col, fn, value] = take(m[1], ['pr', 'pp', 'pf', 'pc']);
      if (row && col && row !== col && AGGREGATES[fn] && value) {
        params.set(`r${m[1]}_pv`, `${row}|${col}|${fn}|${value}`);
        params.set(`r${m[1]}_v`, 'pivot');
      }
    } else if ((m = /^r(\d+)_ck$/.exec(k))) {
      // chart: kind, label column, function, value column
      const [kind, label, fn, value] = take(m[1], ['ck', 'cl', 'cf', 'cv']);
      if ((REPORT_CHART_KINDS as string[]).includes(kind) && label && AGGREGATES[fn] && value) {
        params.set(`r${m[1]}_ch`, `${kind}|${label}|${fn}|${value}`);
        params.set(`r${m[1]}_v`, 'chart');
      }
    }
  }
  return changed ? params.toString() : null;
}

export function regionUrl(ctx: PageContext, r: Region, change: (p: URLSearchParams) => void) {
  const p = new URLSearchParams(ctx.params);
  for (const k of ['clear', 'cs', 'dialog']) p.delete(k);
  change(p);
  const q = p.toString();
  return `${ctx.base}/${ctx.page.page_no}${q ? `?${q}` : ''}${ctx.dialog ? `${q ? '&' : '?'}dialog=1` : ''}`;
}

export async function fieldsOf(ctx: PageContext, src: string) {
  const c = ctx.client!;
  const res = await savepoint(c, () => c.query(`select * from (\n${src}\n) "__q" limit 0`));
  return res.fields;
}

export async function columnsOf(ctx: PageContext, src: string) {
  return (await fieldsOf(ctx, src)).map((f) => f.name);
}

export const q = (col: string) => `"__q".${pg.escapeIdentifier(col)}`;

/**
 * The region's source with the user's computed columns added at the end.
 * A computation that doesn't parse (or whose name is taken) is left out and
 * reported, so the report keeps working and the user can remove it.
 */
export async function withComputations(ctx: PageContext, src: string, st: ReportState) {
  if (!st.computations.length) return { src, errors: [] as { c: Computation; message: string }[] };
  const columns = await columnsOf(ctx, src);
  const errors: { c: Computation; message: string }[] = [];
  const exprs: string[] = [];
  const taken = new Set(columns.map((c) => c.toLowerCase()));
  for (const c of st.computations) {
    try {
      if (taken.has(c.name.toLowerCase())) throw new ComputeError(`There is already a column ${c.name}.`);
      exprs.push(`${computeSql(c.expr, columns)} as ${pg.escapeIdentifier(c.name)}`);
      taken.add(c.name.toLowerCase());
    } catch (e) {
      if (!(e instanceof ComputeError)) throw e;
      errors.push({ c, message: e.message });
    }
  }
  return { src: exprs.length ? `select "__s".*, ${exprs.join(', ')} from (\n${src}\n) "__s"` : src, errors };
}

/**
 * The report's query with the user's search, filters and facets applied:
 * the source, the WHERE clause, and the result's column names (only looked
 * up when a user-chosen column needs checking).
 */
export async function filtered(ctx: PageContext, r: Region, st: ReportState) {
  await resolveRestRegion(ctx, r);
  const { src } = await withComputations(ctx, stripSemicolon(applyBinds(r.source ?? 'select 1', bindValues(ctx))), st);
  const where: string[] = [];
  // the search term, facet values and range bounds are query parameters
  const p = new SqlParams();
  if (st.search) where.push(searchSql(st.search, p));
  const facets = facetFilters(ctx.params, r.id, reportFacetDefs(ctx.page.regions, r.id, ctx.vis?.regions));
  const needCols = st.filters.length || facets.length || st.breakCol || st.aggregates.length || st.highlights.length || st.view !== 'report' || st.area;
  // column name → type oid
  const cols = new Map<string, number>(needCols ? (await fieldsOf(ctx, src)).map((f) => [f.name, f.dataTypeID]) : []);
  for (const f of st.filters) if (cols.has(f.column)) where.push(OPERATORS[f.op].sql(q(f.column), f.value));
  for (const f of facets) {
    const cond = facetFilterSql(f, cols, p);
    if (cond) where.push(cond);
  }
  const pos = st.area ? positionColumns([...cols.keys()]) : null;
  if (st.area && pos) where.push(areaCondition(st.area, pos));
  return { src, where: where.length ? ` where ${where.join(' and ')}` : '', cols, values: queryValues(p.values) };
}

/**
 * The report's rows as a query: its text and parameter values (for c.query({...sql, rowMode})).
 * A page asks for one row more than it shows (see pageInfo). With a maximum row
 * count (config.max_rows) and a total, the total is counted over at most
 * max_rows + 1 rows, so a huge table never has to be read to the end.
 */
export async function buildSql(ctx: PageContext, r: Region, st: ReportState, mode: 'page' | 'csv' | 'xlsx' | 'pdf') {
  const { src, where, cols, values } = await filtered(ctx, r, st);
  const extra: string[] = [];
  const range = rangePaging(r);
  const win = pageWindow(r, st);
  if (mode === 'page') {
    extra.push(range ? 'null::int8 as "__total"' : 'count(*) over () as "__total"');
    // highlights: one boolean per rule, the first true one colors the row
    st.highlights.forEach((h, i) => {
      if (cols.has(h.column)) extra.push(`coalesce(${OPERATORS[h.op].sql(q(h.column), h.value)}, false) as "__h${i}"`);
    });
  }
  const order: string[] = [];
  if (st.breakCol && cols.has(st.breakCol)) order.push(`${q(st.breakCol)} asc nulls last`);
  if (st.sort) order.push(`${st.sort} ${st.desc ? 'desc' : 'asc'} nulls last`);
  const orderBy = order.length ? ` order by ${order.join(', ')}` : '';
  let from = `(\n${src}\n) "__q"${where}`;
  if (mode === 'page' && win.max && !range) from = `(select "__q".* from ${from}${orderBy} limit ${win.max + 1}) "__q"`;
  let sql = `select "__q".*${extra.map((x) => `, ${x}`).join('')} from ${from}${orderBy}`;
  // one row more than a PDF shows, so it can say it was cut off
  const cap = (n: number) => (win.max ? Math.min(win.max, n) : n);
  sql += mode === 'page' ? ` limit ${win.limit} offset ${win.offset}` : ` limit ${mode === 'pdf' ? cap(PDF_MAX_ROWS) + 1 : cap(DOWNLOAD_MAX_ROWS)}`;
  return { text: sql, values };
}

/**
 * What a page of rows shows: the rows (without the extra one), the range and
 * whether there are more; total is null for "row ranges" pagination, capped
 * when the maximum row count was reached.
 */
export function pageInfo(r: Region, st: { page: number; size: number }, rows: unknown[][], totalIdx: number) {
  const win = pageWindow(r, st);
  const shown = rows.slice(0, Math.max(0, win.max ? Math.min(st.size, win.max - win.offset) : st.size));
  let total: number | null = null;
  let capped = false;
  if (!rangePaging(r) && rows.length) {
    total = Number(rows[0][totalIdx]);
    if (win.max && total > win.max) (total = win.max), (capped = true);
  }
  const from = shown.length ? win.offset + 1 : 0;
  const to = win.offset + shown.length;
  const more = total === null ? rows.length > shown.length : to < total;
  return { rows: shown, page: win.page, from, to, total, capped, more };
}
export type PageInfo = ReturnType<typeof pageInfo>;

/** The pager under a report or grid: "X–Y of N" (or "Rows X–Y"), Previous and Next. */
export function pagerNav(ctx: PageContext, r: Region, info: PageInfo, linkAttr: Raw | '' = '') {
  const t = ctx.locale.t;
  if (!info.more && info.page <= 1) return info.total ? html`<div class="pager"><span>${t('report.rows')}: ${info.total}</span></div>` : '';
  const text =
    info.total === null ? t('report.range_open', { from: info.from, to: info.to })
    : t(info.capped ? 'report.range_more' : 'report.range', { from: info.from, to: info.to, total: info.total });
  return html`<nav class="pager" aria-label="${t('report.pagination')}">
    <span>${text}</span>
    ${info.page > 1 ? html`<a class="btn" href="${regionUrl(ctx, r, (p) => p.set(key(r, 'p'), String(info.page - 1)))}"${linkAttr}>‹ ${t('report.previous')}</a>` : ''}
    ${info.more ? html`<a class="btn" href="${regionUrl(ctx, r, (p) => p.set(key(r, 'p'), String(info.page + 1)))}"${linkAttr}>${t('report.next')} ›</a>` : ''}
  </nav>`;
}

/**
 * The aggregates over all filtered rows (not just the page): the totals,
 * and per control-break value when there is a break column.
 */
async function aggregateRows(ctx: PageContext, r: Region, st: ReportState, numeric: (col: string) => boolean) {
  const { src, where, cols, values } = await filtered(ctx, r, st);
  const aggs = st.aggregates.filter((a) => cols.has(a.column) && (!AGGREGATES[a.fn].numeric || numeric(a.column)));
  if (!aggs.length) return null;
  const exprs = aggs.map((a) => AGGREGATES[a.fn].sql(q(a.column)));
  const c = ctx.client!;
  const total = await savepoint(c, () => c.query({ text: `select ${exprs.join(', ')} from (\n${src}\n) "__q"${where}`, values, rowMode: 'array' }));
  const groups = new Map<string, unknown[]>();
  if (st.breakCol && cols.has(st.breakCol)) {
    const res = await savepoint(c, () =>
      c.query({ text: `select ${q(st.breakCol!)}::text, ${exprs.join(', ')} from (\n${src}\n) "__q"${where} group by 1`, values, rowMode: 'array' }),
    );
    for (const row of res.rows) groups.set(String(row[0]), row.slice(1));
  }
  return { aggs, types: total.fields.map((f) => f.dataTypeID), total: total.rows[0] ?? [], groups };
}

export function cell(v: unknown, typeOid?: number, fmt?: Formatter) {
  if (v === null || v === undefined) return '';
  const formatted = fmt?.(v, typeOid);
  if (formatted !== undefined) return formatted;
  // "2026-09-29 16:06:23.900333+00" -> "2026-09-29 16:06"
  if (typeOid && TIMESTAMP_OIDS.has(typeOid)) return String(v).slice(0, 16);
  if (typeof v === 'boolean') return v ? '✓' : '✗';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export const visibleColumns = (r: Region, fields: pg.FieldDef[]) => {
  const hidden = new Set<string>((r.config.hidden ?? []).map((h: string) => h.toLowerCase()));
  return fields.map((f, i) => ({ f, i })).filter(({ f }) => !hidden.has(f.name.toLowerCase()) && !f.name.startsWith('__'));
};

export const headingOf = (r: Region, name: string, tr: (s: string) => string = (s) => s) => tr(r.config.headings?.[name] ?? heading(name));

/** CSV download (Actions → Download). Cells that look like formulas are neutralised. */
export async function reportCsv(ctx: PageContext, r: Region) {
  const st = reportState(ctx, r);
  const c = ctx.client!;
  const res = await savepoint(c, async () => c.query({ ...(await buildSql(ctx, r, st, 'csv')), rowMode: 'array' }));
  const cols = visibleColumns(r, res.fields);
  const esc = (s: string, numeric: boolean) => {
    if (!numeric && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.map(({ f }) => esc(headingOf(r, f.name, ctx.locale.tr), false)).join(',')];
  for (const row of res.rows)
    lines.push(cols.map(({ f, i }) => esc(cell(row[i], f.dataTypeID), NUMERIC_OIDS.has(f.dataTypeID))).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** A value as an Excel cell: numbers, booleans and dates keep their type. */
export function xlsxCell(v: unknown, typeOid: number): XlsxCell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v);
  // int8 and numeric arrive as strings; keep them exact when a double can't
  if (NUMERIC_OIDS.has(typeOid) && /^-?\d{1,15}(\.\d+)?$/.test(s) && s.replace(/[-.]/g, '').length <= 15) return Number(s);
  if (typeOid === 1082) return { date: s };
  if (TIMESTAMP_OIDS.has(typeOid)) return { date: s, time: true };
  return s;
}

/** Excel download (Actions → Download Excel): same rows and columns as the CSV. */
export async function reportXlsx(ctx: PageContext, r: Region) {
  const st = reportState(ctx, r);
  const c = ctx.client!;
  const res = await savepoint(c, async () => c.query({ ...(await buildSql(ctx, r, st, 'xlsx')), rowMode: 'array' }));
  const cols = visibleColumns(r, res.fields);
  return writeXlsx({
    name: r.title ?? ctx.page.title ?? ctx.page.name,
    headings: cols.map(({ f }) => headingOf(r, f.name, ctx.locale.tr)),
    rows: res.rows.map((row) => cols.map(({ f, i }) => xlsxCell(row[i], f.dataTypeID))),
  });
}

/** The report's own state parameters (r<id>_*), as saved in a saved report. */
export function reportParams(r: Region, params: URLSearchParams) {
  const out = new URLSearchParams();
  const prefix = `r${r.id}_`;
  for (const [k, v] of params) if (k.startsWith(prefix) && !/_(p|csv|xlsx|pdf)$/.test(k)) out.append(k, v);
  return out;
}

/** Actions → Saved reports: apply, delete and save (signed-in users; off with "saved_reports": false). */
async function savedReports(ctx: PageContext, r: Region) {
  if (ctx.user === 'nobody' || r.config.saved_reports === false) return null;
  const t = ctx.locale.t;
  const c = ctx.client!;
  const list = (
    await savepoint(c, () =>
      c.query<{ id: number; name: string; public: boolean; own: boolean; params: string }>(
        'select id, name, public, own, params from meta.saved_reports where region_id = $1 order by public desc, lower(name)',
        [r.id],
      ),
    )
  ).rows;
  const current = reportParams(r, ctx.params).toString();
  const mayPublish = typeof r.config.public_reports === 'string' && (await isAuthorized(ctx, r.config.public_reports));
  const base = `${ctx.base}/${ctx.page.page_no}/report/${r.id}`;
  const csrf = html`<input type="hidden" name="__csrf" value="${ctx.session.csrf_token}">`;
  const apply = (params: string) =>
    regionUrl(ctx, r, (p) => {
      for (const k of [...p.keys()]) if (k.startsWith(`r${r.id}_`)) p.delete(k);
      for (const [k, v] of new URLSearchParams(params)) if (k.startsWith(`r${r.id}_`)) p.append(k, v);
    });
  const saveForm = `rsv${r.id}`;
  ctx.detached.push(html`<form id="${saveForm}" method="post" action="${base}/save">${csrf}<input type="hidden" name="params" value="${current}"></form>`);
  for (const x of list.filter((x) => x.own))
    ctx.detached.push(html`<form id="rsd${r.id}_${x.id}" method="post" action="${base}/saved/${x.id}/delete">${csrf}<input type="hidden" name="params" value="${current}"></form>`);
  return html`<div class="menu-section">
      <strong>${t('report.saved_reports')}</strong>
      ${list.length
        ? html`<ul class="saved-reports">${list.map((x) => html`<li>
            <a href="${apply(x.params)}"${x.params === current ? raw(' aria-current="true"') : ''}>${x.name}</a>${x.public ? html` <span class="tag">${t('report.public_tag')}</span>` : ''}
            ${x.own ? html`<button class="link-button" form="rsd${r.id}_${x.id}" data-confirm="${t('report.delete_saved_confirm', { name: x.name })}" aria-label="${t('report.delete_saved')} ${x.name}">×</button>` : ''}
          </li>`)}</ul>`
        : ''}
      <div class="filter-row">
        <input name="name" form="${saveForm}" required maxlength="80" aria-label="${t('report.name')}" placeholder="${t('report.save_as')}">
        ${mayPublish ? html`<label class="check"><input type="checkbox" name="public" value="true" form="${saveForm}"> ${t('report.public')}</label>` : ''}
        <button class="btn" form="${saveForm}">${t('report.save')}</button>
      </div>
    </div>`;
}

export async function renderReport(ctx: PageContext, r: Region, filterItems: Raw[]) {
  const t = ctx.locale.t;
  const c = ctx.client!;
  const st = reportState(ctx, r);
  const searchable = r.config.searchable !== false;
  const interactive = r.config.interactive !== false && searchable;

  let res: pg.QueryResult<any[]>;
  let pageNo = st.page;
  let failure: string | null = null;
  try {
    const run = async (p: number) => savepoint(c, async () => c.query({ ...(await buildSql(ctx, r, { ...st, page: p }, 'page')), rowMode: 'array' }));
    res = await run(pageNo);
    if (res.rows.length === 0 && pageNo > 1) res = await run((pageNo = 1));
    pageNo = pageWindow(r, { ...st, page: pageNo }).page;
  } catch (e) {
    failure = await publicError(ctx, e, `report "${r.title ?? r.id}"`);
    res = { rows: [], fields: [] } as any;
  }

  // the source's columns come first, then __total and the highlight flags
  const totalIdx = res.fields.findIndex((f) => f.name === '__total');
  const fields = totalIdx >= 0 ? res.fields.slice(0, totalIdx) : [];
  const info = pageInfo(r, { ...st, page: pageNo }, res.rows, totalIdx);
  const hlIdx = st.highlights.map((_, i) => res.fields.findIndex((f) => f.name === `__h${i}`));
  const breakIdx = st.breakCol ? fields.findIndex((f) => f.name === st.breakCol) : -1;
  const allCols = visibleColumns(r, fields);
  const cols = allCols.filter(({ i }) => i !== breakIdx);
  let agg: Awaited<ReturnType<typeof aggregateRows>> = null;
  if (!failure && st.aggregates.length)
    try {
      agg = await aggregateRows(ctx, r, st, (col) => NUMERIC_OIDS.has(fields.find((f) => f.name === col)?.dataTypeID ?? 0));
    } catch (e) {
      failure = await publicError(ctx, e, `report "${r.title ?? r.id}" aggregates`);
    }
  const link = r.config.link as { column: string; page: number; items?: Record<string, string> } | undefined;
  const linkIdx = link && (await pageAllowed(ctx, link.page)) ? fields.findIndex((f) => f.name.toLowerCase() === link.column.toLowerCase()) : -1;
  const pre = new Set<string>((r.config.preformatted ?? []).map((x: string) => x.toLowerCase()));
  let computeErrors: { c: Computation; message: string }[] = [];
  if (st.computations.length && !failure)
    computeErrors = (await withComputations(ctx, stripSemicolon(applyBinds(r.source ?? 'select 1', bindValues(ctx))), st).catch(() => ({ errors: [] }))).errors;
  const selection = st.view === 'report' ? selectionOf(ctx.page, r) : null;
  const selIdx = selection ? fields.findIndex((f) => f.name.toLowerCase() === selection.column.toLowerCase()) : -1;
  const selected = new Set(selIdx >= 0 ? splitValues(ctx.session.state[selection!.item] ?? '') : []);
  const lead = selIdx >= 0 ? 1 : 0;
  // columns rendered through a template component (config.column_templates)
  const templated = st.view === 'report' ? await columnTemplates(ctx, r, fields, (v, oid) => cell(v, oid, ctx.locale.format), (v) => cell(v)) : new Map();
  let rowNum = (pageNo - 1) * st.size;

  const rowItems = (row: unknown[]) => {
    const items: Record<string, string> = {};
    for (const [k, v] of Object.entries(link!.items ?? {}))
      items[k] = v.replace(/#([A-Za-z0-9_]+)#/g, (m, col: string) => {
        const i = fields.findIndex((f) => f.name.toLowerCase() === col.toLowerCase());
        return i === -1 ? m : cell(row[i]);
      });
    return items;
  };

  const header = cols.map(({ f, i }) => {
    const pos = i + 1;
    const cls = NUMERIC_OIDS.has(f.dataTypeID) ? 'num' : null;
    const label = headingOf(r, f.name, ctx.locale.tr);
    if (r.config.sortable === false) return html`<th scope="col" class="${cls}">${label}</th>`;
    const active = st.sort === pos;
    const href = regionUrl(ctx, r, (p) => {
      p.set(key(r, 's'), String(pos));
      if (active && !st.desc) p.set(key(r, 'd'), 'desc');
      else p.delete(key(r, 'd'));
      p.delete(key(r, 'p'));
    });
    return html`<th scope="col" class="${cls}" aria-sort="${active ? (st.desc ? 'descending' : 'ascending') : 'none'}"><a href="${href}">${label}<span class="sort-ind" aria-hidden="true">${active ? (st.desc ? '▼' : '▲') : ''}</span></a></th>`;
  });
  if (lead) header.unshift(html`<th scope="col" class="row-select"><label><input type="checkbox" data-select-all="${selection!.item}" aria-label="${t('report.select_all')}"><span class="row-select-label" aria-hidden="true">${t('report.select_all')}</span></label></th>`);

  // an aggregate row (totals, or a control break's subtotals): the values
  // under their columns, the label in the first cell
  const aggRow = (values: unknown[], label: string, cls: string) =>
    html`<tr class="${cls}">${lead ? html`<td class="row-select"></td>` : ''}${cols.map(({ f }, ci) => {
      const parts = agg!.aggs.flatMap((a, ai) => (a.column === f.name ? [`${t(`agg.${a.fn}`)}: ${cell(values[ai], agg!.types[ai], ctx.locale.format)}`] : []));
      const text = [ci === 0 ? label : '', ...parts].filter(Boolean).join(' · ');
      return html`<td class="${parts.length && NUMERIC_OIDS.has(f.dataTypeID) ? 'num' : null}" data-label="${parts.length ? headingOf(r, f.name, ctx.locale.tr) : ''}">${text}</td>`;
    })}</tr>`;
  const breakKey = (v: unknown) => (v === null || v === undefined ? '\u0000' : String(v));
  const breakField = breakIdx >= 0 ? fields[breakIdx] : undefined;
  const lastPage = !info.more;

  const body: Raw[] = [];
  let group: string | undefined;
  for (const row of info.rows) {
    if (breakField) {
      const k = breakKey(row[breakIdx]);
      if (k !== group) {
        if (group !== undefined && agg?.groups.has(group)) body.push(aggRow(agg.groups.get(group)!, t('report.subtotal'), 'agg-row subtotal'));
        group = k;
        const value = cell(row[breakIdx], breakField.dataTypeID, ctx.locale.format);
        body.push(html`<tr class="break-row"><th colspan="${cols.length + lead || 1}" scope="colgroup">${headingOf(r, breakField.name, ctx.locale.tr)}: ${value || '—'}</th></tr>`);
      }
    }
    const hl = st.highlights.find((_, hi) => hlIdx[hi] >= 0 && row[hlIdx[hi]] === true);
    const pick = lead
      ? html`<td class="row-select" data-label="${t('report.select_row')}"><input type="checkbox" name="${selection!.item}" value="${cell(row[selIdx])}"${selected.has(cell(row[selIdx])) ? raw(' checked') : ''} aria-label="${t('report.select_row')} ${cell(row[selIdx])}"></td>`
      : '';
    rowNum++;
    body.push(html`<tr class="${hl ? `hl-${hl.color}` : null}">${pick}${cols.map(({ f, i }) => {
      const text = cell(row[i], f.dataTypeID, ctx.locale.format);
      const cls = [NUMERIC_OIDS.has(f.dataTypeID) ? 'num' : '', pre.has(f.name.toLowerCase()) ? 'pre' : ''].filter(Boolean).join(' ') || null;
      const label = headingOf(r, f.name, ctx.locale.tr);
      const tpl = templated.get(i);
      if (tpl) return html`<td class="${cls ? `${cls} tc-cell` : 'tc-cell'}" data-label="${label}">${tpl(row, rowNum)}</td>`;
      return i === linkIdx
        ? html`<td class="${cls}" data-label="${label}"><a ${linkAttrs(ctx, link!.page, rowItems(row))}>${text || t('report.edit')}</a></td>`
        : html`<td class="${cls}" data-label="${label}">${text}</td>`;
    })}</tr>`);
  }
  // the last group's subtotal once the group has ended (on the last page)
  if (breakField && group !== undefined && lastPage && agg?.groups.has(group)) body.push(aggRow(agg.groups.get(group)!, t('report.subtotal'), 'agg-row subtotal'));
  const foot = agg && cols.length ? html`<tfoot>${aggRow(agg.total, t('report.total'), 'agg-row total')}</tfoot>` : '';

  // ---- toolbar: filter items, search, Actions menu ----
  const searchForm = `rs${r.id}`;
  const filterForm = `rf${r.id}`;
  const hiddenInputs = (except: string[]) =>
    [...ctx.params.entries()]
      .filter(([k]) => !except.includes(k) && !['clear', 'cs'].includes(k))
      .map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`);
  const action = `${ctx.base}/${ctx.page.page_no}`;
  if (searchable) {
    ctx.detached.push(html`<form id="${searchForm}" method="get" action="${action}">${hiddenInputs([key(r, 'q'), key(r, 'p')])}${ctx.dialog ? html`<input type="hidden" name="dialog" value="1">` : ''}</form>`);
  }
  const breakForm = `rb${r.id}`;
  const aggForm = `ra${r.id}`;
  const hlForm = `rh${r.id}`;
  const computeForm = `rc${r.id}`;
  const groupForm = `rg${r.id}`;
  const pivotForm = `rp${r.id}`;
  const chartForm = `rk${r.id}`;
  if (interactive) {
    for (const id of [filterForm, breakForm, aggForm, hlForm, computeForm, groupForm, pivotForm, chartForm])
      ctx.detached.push(html`<form id="${id}" method="get" action="${action}">${hiddenInputs([key(r, 'p')])}</form>`);
  }
  const saved = interactive ? await savedReports(ctx, r) : null;

  const chips = st.filters.map((f) => {
    const href = regionUrl(ctx, r, (p) => {
      const rest = p.getAll(key(r, 'f')).filter((x) => x !== f.raw);
      p.delete(key(r, 'f'));
      rest.forEach((x) => p.append(key(r, 'f'), x));
      p.delete(key(r, 'p'));
    });
    const op = OPERATORS[f.op];
    return html`<span class="chip">${headingOf(r, f.column, ctx.locale.tr)} ${opLabel(t, f.op)}${op.noValue ? '' : html` <b>${f.value}</b>`}
      <a href="${href}" aria-label="${t('report.remove_filter')}">×</a></span>`;
  });
  const removeValue = (k: string, raw: string) =>
    regionUrl(ctx, r, (p) => {
      const rest = p.getAll(key(r, k)).filter((x) => x !== raw);
      p.delete(key(r, k));
      rest.forEach((x) => p.append(key(r, k), x));
      p.delete(key(r, 'p'));
    });
  if (breakField)
    chips.push(html`<span class="chip">${t('report.break')}: <b>${headingOf(r, breakField.name, ctx.locale.tr)}</b>
      <a href="${regionUrl(ctx, r, (p) => { p.delete(key(r, 'b')); p.delete(key(r, 'p')); })}" aria-label="${t('report.remove')}">×</a></span>`);
  for (const a of st.aggregates)
    chips.push(html`<span class="chip">${t(`agg.${a.fn}`)}: <b>${headingOf(r, a.column, ctx.locale.tr)}</b>
      <a href="${removeValue('a', a.raw)}" aria-label="${t('report.remove')}">×</a></span>`);
  for (const h of st.highlights)
    chips.push(html`<span class="chip"><span class="swatch hl-${h.color}" aria-hidden="true"></span>${headingOf(r, h.column, ctx.locale.tr)} ${opLabel(t, h.op)}${OPERATORS[h.op].noValue ? '' : html` <b>${h.value}</b>`}
      <a href="${removeValue('h', h.raw)}" aria-label="${t('report.remove')}">×</a></span>`);
  const dropView = (p: URLSearchParams, v: View, keys: string[]) => {
    for (const k of keys) p.delete(key(r, k));
    if (p.get(key(r, 'v')) === v) p.delete(key(r, 'v'));
    p.delete(key(r, 'p'));
  };
  for (const c of st.computations) {
    const err = computeErrors.find((x) => x.c.raw === c.raw);
    chips.push(html`<span class="chip${err ? ' chip-error' : ''}"${err ? raw(` title="${esc(err.message)}"`) : ''}>${c.name} = <b>${c.expr}</b>
      <a href="${removeValue('c', c.raw)}" aria-label="${t('report.remove')}">×</a></span>`);
  }
  if (st.groupBy.columns.length)
    chips.push(html`<span class="chip">${t('report.group_by')}: <b>${st.groupBy.columns.map((c) => headingOf(r, c, ctx.locale.tr)).join(', ')}</b>${st.groupBy.functions.map((a) => html` · ${t(`agg.${a.fn}`)}: ${headingOf(r, a.column, ctx.locale.tr)}`)}
      <a href="${regionUrl(ctx, r, (p) => dropView(p, 'group', ['g', 'ga']))}" aria-label="${t('report.remove')}">×</a></span>`);
  if (st.pivot)
    chips.push(html`<span class="chip">${t('report.pivot')}: <b>${headingOf(r, st.pivot.row, ctx.locale.tr)} × ${headingOf(r, st.pivot.column, ctx.locale.tr)}</b>
      <a href="${regionUrl(ctx, r, (p) => dropView(p, 'pivot', ['pv']))}" aria-label="${t('report.remove')}">×</a></span>`);
  if (st.chart)
    chips.push(html`<span class="chip">${t('report.chart')}: <b>${t(`chart.${st.chart.kind}`)}, ${headingOf(r, st.chart.label, ctx.locale.tr)}</b>
      <a href="${regionUrl(ctx, r, (p) => dropView(p, 'chart', ['ch']))}" aria-label="${t('report.remove')}">×</a></span>`);
  if (st.area) {
    // a report without position columns can't be filtered by a map: say so on the chip
    const pos = positionColumns(cols.map(({ f }) => f.name));
    chips.push(html`<span class="chip${pos ? '' : ' chip-error'}"${pos ? '' : raw(` title="${esc(t('report.no_position'))}"`)}>${t('report.map_area')}
      <a href="${regionUrl(ctx, r, (p) => { p.delete(key(r, 'bb')); p.delete(key(r, 'p')); })}" aria-label="${t('report.remove')}">×</a></span>`);
  }
  if (st.search)
    chips.unshift(
      html`<span class="chip">${t('report.search_chip')} <b>${st.search}</b> <a href="${regionUrl(ctx, r, (p) => { p.delete(key(r, 'q')); p.delete(key(r, 'p')); })}" aria-label="${t('report.clear_search')}">×</a></span>`,
    );

  const actionsMenu = interactive
    ? html`<details class="menu actions-menu">
        <summary class="btn">${t('report.actions')} <span aria-hidden="true">▾</span></summary>
        <div class="menu-panel">
          <div class="menu-section">
            <strong>${t('report.filter')}</strong>
            <div class="filter-row">
              <select name="${key(r, 'fc')}" form="${filterForm}" aria-label="${t('report.column')}">${cols.map(({ f }) => html`<option value="${f.name}">${headingOf(r, f.name, ctx.locale.tr)}</option>`)}</select>
              <select name="${key(r, 'fo')}" form="${filterForm}" aria-label="${t('report.operator')}">${Object.keys(OPERATORS).map((k) => html`<option value="${k}"${k === 'contains' ? raw(' selected') : ''}>${opLabel(t, k)}</option>`)}</select>
              <input name="${key(r, 'fv')}" form="${filterForm}" aria-label="${t('report.value')}" placeholder="${t('report.value')}">
              <button class="btn btn-hot" form="${filterForm}">${t('report.apply')}</button>
            </div>
          </div>
          ${r.config.sortable === false
            ? ''
            : html`<div class="menu-section"><strong>${t('report.sort')}</strong>
                <div class="seg">${cols.map(({ f, i }) => {
                  const pos = i + 1;
                  const active = st.sort === pos;
                  const href = regionUrl(ctx, r, (p) => {
                    p.set(key(r, 's'), String(pos));
                    if (active && !st.desc) p.set(key(r, 'd'), 'desc');
                    else p.delete(key(r, 'd'));
                    p.delete(key(r, 'p'));
                  });
                  return html`<a href="${href}"${active ? raw(' aria-current="true"') : ''}>${headingOf(r, f.name, ctx.locale.tr)}${active ? (st.desc ? ' ▼' : ' ▲') : ''}</a>`;
                })}</div>
              </div>`}
          <div class="menu-section">
            <strong>${t('report.break')}</strong>
            <div class="filter-row">
              <select name="${key(r, 'bc')}" form="${breakForm}" aria-label="${t('report.break')}">
                <option value="">${t('report.none')}</option>
                ${allCols.map(({ f }) => html`<option value="${f.name}"${f.name === st.breakCol ? raw(' selected') : ''}>${headingOf(r, f.name, ctx.locale.tr)}</option>`)}
              </select>
              <button class="btn" form="${breakForm}">${t('report.apply')}</button>
            </div>
          </div>
          <div class="menu-section">
            <strong>${t('report.aggregate')}</strong>
            <div class="filter-row">
              <select name="${key(r, 'af')}" form="${aggForm}" aria-label="${t('report.function')}">${Object.keys(AGGREGATES).map((fn) => html`<option value="${fn}">${t(`agg.${fn}`)}</option>`)}</select>
              <select name="${key(r, 'ac')}" form="${aggForm}" aria-label="${t('report.column')}">${cols.map(({ f }) => html`<option value="${f.name}">${headingOf(r, f.name, ctx.locale.tr)}</option>`)}</select>
              <button class="btn" form="${aggForm}">${t('report.apply')}</button>
            </div>
          </div>
          <div class="menu-section">
            <strong>${t('report.highlight')}</strong>
            <div class="filter-row">
              <select name="${key(r, 'hc')}" form="${hlForm}" aria-label="${t('report.column')}">${allCols.map(({ f }) => html`<option value="${f.name}">${headingOf(r, f.name, ctx.locale.tr)}</option>`)}</select>
              <select name="${key(r, 'ho')}" form="${hlForm}" aria-label="${t('report.operator')}">${Object.keys(OPERATORS).map((k) => html`<option value="${k}"${k === 'eq' ? raw(' selected') : ''}>${opLabel(t, k)}</option>`)}</select>
              <input name="${key(r, 'hv')}" form="${hlForm}" aria-label="${t('report.value')}" placeholder="${t('report.value')}">
              <select name="${key(r, 'hk')}" form="${hlForm}" aria-label="${t('report.color')}">${HIGHLIGHT_COLORS.map((c) => html`<option value="${c}">${t(`color.${c}`)}</option>`)}</select>
              <button class="btn" form="${hlForm}">${t('report.apply')}</button>
            </div>
          </div>
          <div class="menu-section">
            <strong>${t('report.compute')}</strong>
            <div class="filter-row">
              <input name="${key(r, 'cn')}" form="${computeForm}" maxlength="40" aria-label="${t('report.compute_name')}" placeholder="${t('report.compute_name')}">
              <input name="${key(r, 'ce')}" form="${computeForm}" maxlength="500" aria-label="${t('report.compute_expr')}" placeholder="${t('report.compute_expr')}">
              <button class="btn" form="${computeForm}">${t('report.apply')}</button>
            </div>
            <small class="help">${t('report.compute_help')}</small>
          </div>
          <div class="menu-section">
            <strong>${t('report.group_by')}</strong>
            <div class="filter-row">
              ${[1, 2, 3].map((n) => html`<select name="${key(r, `gb${n}`)}" form="${groupForm}" aria-label="${t('report.group_by')} ${n}">
                <option value="">${t('report.none')}</option>${allCols.map(({ f }) => html`<option value="${f.name}"${f.name === st.groupBy.columns[n - 1] ? raw(' selected') : ''}>${headingOf(r, f.name, ctx.locale.tr)}</option>`)}</select>`)}
              <select name="${key(r, 'gbf')}" form="${groupForm}" aria-label="${t('report.function')}"><option value="">${t('report.none')}</option>${Object.keys(AGGREGATES).map((fn) => html`<option value="${fn}">${t(`agg.${fn}`)}</option>`)}</select>
              <select name="${key(r, 'gbc')}" form="${groupForm}" aria-label="${t('report.column')}">${allCols.map(({ f }) => html`<option value="${f.name}"${f.name === '' ? raw(' selected') : ''}>${headingOf(r, f.name, ctx.locale.tr)}</option>`)}</select>
              <button class="btn" form="${groupForm}">${t('report.apply')}</button>
            </div>
          </div>
          <div class="menu-section">
            <strong>${t('report.pivot')}</strong>
            <div class="filter-row">
              <select name="${key(r, 'pr')}" form="${pivotForm}" aria-label="${t('report.pivot_row')}">${allCols.map(({ f }) => html`<option value="${f.name}"${f.name === st.pivot?.row ? raw(' selected') : ''}>${headingOf(r, f.name, ctx.locale.tr)}</option>`)}</select>
              <select name="${key(r, 'pp')}" form="${pivotForm}" aria-label="${t('report.pivot_column')}">${allCols.map(({ f }) => html`<option value="${f.name}"${f.name === st.pivot?.column ? raw(' selected') : ''}>${headingOf(r, f.name, ctx.locale.tr)}</option>`)}</select>
              <select name="${key(r, 'pf')}" form="${pivotForm}" aria-label="${t('report.function')}">${Object.keys(AGGREGATES).map((fn) => html`<option value="${fn}"${fn === (st.pivot?.fn ?? 'count') ? raw(' selected') : ''}>${t(`agg.${fn}`)}</option>`)}</select>
              <select name="${key(r, 'pc')}" form="${pivotForm}" aria-label="${t('report.value_column')}">${allCols.map(({ f }) => html`<option value="${f.name}"${f.name === st.pivot?.value ? raw(' selected') : ''}>${headingOf(r, f.name, ctx.locale.tr)}</option>`)}</select>
              <button class="btn" form="${pivotForm}">${t('report.apply')}</button>
            </div>
          </div>
          <div class="menu-section">
            <strong>${t('report.chart')}</strong>
            <div class="filter-row">
              <select name="${key(r, 'ck')}" form="${chartForm}" aria-label="${t('report.chart_type')}">${REPORT_CHART_KINDS.map((k) => html`<option value="${k}"${k === st.chart?.kind ? raw(' selected') : ''}>${t(`chart.${k}`)}</option>`)}</select>
              <select name="${key(r, 'cl')}" form="${chartForm}" aria-label="${t('report.label_column')}">${allCols.map(({ f }) => html`<option value="${f.name}"${f.name === st.chart?.label ? raw(' selected') : ''}>${headingOf(r, f.name, ctx.locale.tr)}</option>`)}</select>
              <select name="${key(r, 'cf')}" form="${chartForm}" aria-label="${t('report.function')}">${Object.keys(AGGREGATES).map((fn) => html`<option value="${fn}"${fn === (st.chart?.fn ?? 'count') ? raw(' selected') : ''}>${t(`agg.${fn}`)}</option>`)}</select>
              <select name="${key(r, 'cv')}" form="${chartForm}" aria-label="${t('report.value_column')}">${allCols.map(({ f }) => html`<option value="${f.name}"${f.name === st.chart?.value ? raw(' selected') : ''}>${headingOf(r, f.name, ctx.locale.tr)}</option>`)}</select>
              <button class="btn" form="${chartForm}">${t('report.apply')}</button>
            </div>
          </div>
          ${saved ?? ''}
          <div class="menu-section"><strong>${t('report.rows_per_page')}</strong>
            <div class="seg">${PAGE_SIZES.map((n) =>
              html`<a href="${regionUrl(ctx, r, (p) => { p.set(key(r, 'n'), String(n)); p.delete(key(r, 'p')); })}"${n === st.size ? raw(' aria-current="true"') : ''}>${n}</a>`)}</div>
          </div>
          <div class="menu-section menu-links">
            <a href="${regionUrl(ctx, r, (p) => p.set(key(r, 'csv'), '1'))}" download>${icon('download')} ${t('report.download')}</a>
            <a href="${regionUrl(ctx, r, (p) => p.set(key(r, 'xlsx'), '1'))}" download>${icon('download')} ${t('report.download_xlsx')}</a>
            <a href="${regionUrl(ctx, r, (p) => p.set(key(r, 'pdf'), '1'))}" download>${icon('download')} ${t('report.download_pdf')}</a>
            <button type="button" data-print>${icon('printer')} ${t('report.print')}</button>
            <a href="${regionUrl(ctx, r, (p) => { for (const k of [...p.keys()]) if (k.startsWith(`r${r.id}_`)) p.delete(k); })}">${icon('history')} ${t('report.reset')}</a>
          </div>
        </div>
      </details>`
    : '';

  const toolbar =
    searchable || filterItems.length
      ? html`<div class="report-toolbar">
          ${filterItems}
          ${searchable
            ? html`<div class="search" role="search">
                <input type="search" name="${key(r, 'q')}" value="${st.search}" placeholder="${t('report.search_all')}" form="${searchForm}" aria-label="${t('report.search')} ${r.title ?? ''}">
                <button class="btn" form="${searchForm}">${t('report.go')}</button>
                ${actionsMenu}
              </div>`
            : ''}
        </div>
        ${chips.length ? html`<div class="chips">${chips}</div>` : ''}`
      : '';

  // Keep the toolbar only when a search or filter may be the cause, so it can be removed.
  if (failure) return html`${reportParams(r, ctx.params).size ? toolbar : ''}<div class="alert alert-error" role="alert">${failure}</div>`;

  // Report / Group by / Pivot / Chart, once the user has set up another view
  const views = VIEWS.filter((v) => v === 'report' || (v === 'group' && st.groupBy.columns.length) || (v === 'pivot' && st.pivot) || (v === 'chart' && st.chart));
  const switcher = views.length > 1
    ? html`<nav class="seg view-switch" aria-label="${t('report.view')}">${views.map((v) => html`<a href="${regionUrl(ctx, r, (p) => {
        if (v === 'report') p.delete(key(r, 'v'));
        else p.set(key(r, 'v'), v);
        p.delete(key(r, 'p'));
      })}"${v === st.view ? raw(' aria-current="true"') : ''}>${t(`report.view_${v}`)}</a>`)}</nav>`
    : '';
  const errors = computeErrors.map((x) => html`<div class="alert alert-error" role="alert">${t('report.compute_error', { name: x.c.name, message: x.message })}</div>`);
  if (st.view !== 'report') return html`${toolbar}${switcher}${errors}${await renderView(ctx, r, st)}`;

  const empty = r.config.empty ?? t('report.no_data');
  return html`${toolbar}${switcher}${errors}
    <div class="table-wrap"><table class="report${r.config.mobile === 'scroll' ? '' : ' report-reflow'}">
      <thead><tr>${header}</tr></thead>
      <tbody>${body.length ? body : html`<tr><td colspan="${cols.length + lead || 1}" class="empty">${empty}</td></tr>`}</tbody>
      ${info.rows.length ? foot : ''}
    </table></div>
    ${info.more || info.page > 1 || searchable ? pagerNav(ctx, r, info) : ''}`;
}
