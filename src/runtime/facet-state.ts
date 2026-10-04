import pg from 'pg';
import type { SqlParams } from '../binds.ts';
import type { Region } from '../metadata.ts';

// The filters that faceted search and smart filter regions put on a report,
// read from the report's URL parameters (so they are bookmarkable, kept in
// saved reports and work without JavaScript):
//
//   r<id>_x_<column>=value   a value of a checkbox facet (repeatable)
//   r<id>_xn_<column>=1      ... excluded instead of included (APEX 26.1 "exclude")
//   r<id>_rg_<column>=a|b    a predefined range of a range or star facet: a <= column < b
//   r<id>_rg_<column>=~      the custom range below is chosen
//   r<id>_rf_<column>=a      custom range: column >= a
//   r<id>_rt_<column>=b      custom range: column <= b (a date: the whole day)
//
// A filter only counts when a facets or smart filters region on the page
// configures a facet of that kind on that column (and allows exclude or a
// custom range): anything else in the URL is ignored. Values and bounds are
// query parameters ($n), never SQL text; column names are checked against
// the report's columns and quoted.

export const NUMBER_OIDS = new Set([20, 21, 23, 26, 700, 701, 1700]);
export const DATE_OIDS = new Set([1082, 1114, 1184]);
export const CUSTOM_RANGE = '~';
const NUM = /^-?\d{1,15}(\.\d{1,10})?$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** At most this many filters are read from a URL (each becomes a condition). */
export const MAX_FILTERS = 50;
const MAX_VALUES = 100;
const MAX_VALUE_LENGTH = 500;
export const MAX_RANGES = 20;
export const STAR_MAX = 10;

export type RangeKind = 'number' | 'date';
export const rangeKind = (oid: number | undefined): RangeKind | null =>
  oid === undefined ? null : NUMBER_OIDS.has(oid) ? 'number' : DATE_OIDS.has(oid) ? 'date' : null;

/** A range bound as given ('' = open), checked for the column's kind. */
export function validBound(v: string, kind: RangeKind | null): boolean {
  if (v === '') return true;
  if (kind === 'number') return NUM.test(v);
  if (kind === 'date') {
    if (!DAY.test(v)) return false;
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }
  return false;
}

/** Either kind of bound, before the column's type is known (configuration). */
export const anyBound = (v: string) => validBound(v, 'number') || validBound(v, 'date');

export interface Range {
  from: string;
  to: string;
  label?: string;
}

/** "from|to" → a range (either side may be empty, not both), or null. */
export function parseRange(raw: string | null | undefined): Range | null {
  if (!raw) return null;
  const i = raw.indexOf('|');
  if (i < 0) return null;
  const from = raw.slice(0, i).trim();
  const to = raw.slice(i + 1).trim();
  if (!from && !to) return null;
  if (!anyBound(from) || !anyBound(to)) return null;
  return { from, to };
}

export const rangeValue = (r: Range) => `${r.from}|${r.to}`;

/** The predefined ranges of a facet's configuration ([{from, to, label}]), checked. */
export function configuredRanges(f: { ranges?: unknown }): Range[] {
  if (!Array.isArray(f.ranges)) return [];
  const out: Range[] = [];
  for (const x of f.ranges.slice(0, MAX_RANGES)) {
    if (!x || typeof x !== 'object') continue;
    const from = x.from === undefined || x.from === null ? '' : String(x.from).trim();
    const to = x.to === undefined || x.to === null ? '' : String(x.to).trim();
    if ((!from && !to) || !anyBound(from) || !anyBound(to)) continue;
    out.push({ from, to, ...(typeof x.label === 'string' && x.label.trim() ? { label: x.label.trim() } : {}) });
  }
  return out;
}

// ---------------------------------------------------------------- facet definitions

export type FacetType = 'checkbox' | 'range' | 'star';
export const FACET_TYPES: FacetType[] = ['checkbox', 'range', 'star'];

/** One facet of a faceted search or smart filters region, normalised. */
export interface FacetDef {
  column: string;
  label?: string;
  limit?: number;
  type: FacetType;
  /** range: predefined ranges; star: "n stars and up" for n = max … 1 */
  ranges: Range[];
  /** range: users may type their own from/to */
  custom: boolean;
  /** checkbox: users may exclude the chosen values instead */
  exclude: boolean;
  /** star: the highest rating */
  max: number;
}

/** A region's config.facets as definitions (unknown types and malformed entries are left out). */
export function facetDefs(config: Record<string, any> | null | undefined): FacetDef[] {
  const list = Array.isArray(config?.facets) ? config.facets : [];
  const out: FacetDef[] = [];
  const seen = new Set<string>();
  for (const f of list) {
    if (!f || typeof f !== 'object' || typeof f.column !== 'string' || !f.column || seen.has(f.column)) continue;
    const type: FacetType = FACET_TYPES.includes(f.type) ? f.type : 'checkbox';
    seen.add(f.column);
    const max = Number.isInteger(f.max) && f.max >= 2 && f.max <= STAR_MAX ? f.max : 5;
    const ranges =
      type === 'range' ? configuredRanges(f) : type === 'star' ? Array.from({ length: max }, (_, i) => ({ from: String(max - i), to: '' })) : [];
    out.push({
      column: f.column,
      ...(typeof f.label === 'string' && f.label ? { label: f.label } : {}),
      ...(Number.isInteger(f.limit) ? { limit: f.limit } : {}),
      type,
      ranges,
      custom: type === 'range' && (f.custom === true || (f.custom !== false && !ranges.length)),
      exclude: type === 'checkbox' && f.exclude === true,
      max,
    });
  }
  return out;
}

/** Region types whose config.facets filter a report (config.report). */
export const FILTER_REGION_TYPES = ['facets', 'smart_filters'];

/**
 * The facets that may filter a report: those of every faceted search and
 * smart filters region on the page that points at it (the first definition
 * of a column wins).
 */
export function reportFacetDefs(regions: Region[], reportId: number, visible?: Set<number>): Map<string, FacetDef> {
  const out = new Map<string, FacetDef>();
  for (const r of regions)
    if (FILTER_REGION_TYPES.includes(r.type) && Number(r.config?.report) === reportId && (!visible || visible.has(r.id)))
      for (const f of facetDefs(r.config)) if (!out.has(f.column)) out.set(f.column, f);
  return out;
}

// ---------------------------------------------------------------- filters from the URL

export type FacetFilter =
  | { column: string; kind: 'values'; values: string[]; exclude: boolean }
  | { column: string; kind: 'range'; from: string; to: string; custom: boolean };

export const facetKeys = (reportId: number) => ({
  values: `r${reportId}_x_`,
  exclude: `r${reportId}_xn_`,
  range: `r${reportId}_rg_`,
  from: `r${reportId}_rf_`,
  to: `r${reportId}_rt_`,
});

/** Every URL parameter name a facet on `column` uses. */
export const facetParamNames = (reportId: number, column: string) => Object.values(facetKeys(reportId)).map((p) => p + column);

/** Whether a URL parameter belongs to one of the report's facets. */
export const isFacetParam = (reportId: number, name: string) => Object.values(facetKeys(reportId)).some((p) => name.startsWith(p));

/**
 * The facet filters on a report that its facets allow (except those on one
 * column: a facet's own counts ignore its own selection).
 */
export function facetFilters(params: URLSearchParams, reportId: number, defs: Map<string, FacetDef>, except?: string): FacetFilter[] {
  const k = facetKeys(reportId);
  const out: FacetFilter[] = [];
  for (const def of defs.values()) {
    if (out.length >= MAX_FILTERS) break;
    const column = def.column;
    if (column === except) continue;
    if (def.type === 'checkbox') {
      const values = [...new Set(params.getAll(k.values + column))]
        .filter((v) => v !== '' && !v.includes('\0') && v.length <= MAX_VALUE_LENGTH)
        .slice(0, MAX_VALUES);
      if (values.length) out.push({ column, kind: 'values', values, exclude: def.exclude && params.get(k.exclude + column) === '1' });
      continue;
    }
    const chosen = params.get(k.range + column) ?? '';
    if (chosen && chosen !== CUSTOM_RANGE) {
      // only one of the facet's own ranges
      const r = parseRange(chosen);
      if (r && def.ranges.some((x) => x.from === r.from && x.to === r.to)) out.push({ column, kind: 'range', from: r.from, to: r.to, custom: false });
    } else if (def.custom) {
      const from = (params.get(k.from + column) ?? '').trim();
      const to = (params.get(k.to + column) ?? '').trim();
      if ((from || to) && anyBound(from) && anyBound(to)) out.push({ column, kind: 'range', from, to, custom: true });
    }
  }
  return out;
}

const q = (col: string) => `"__q".${pg.escapeIdentifier(col)}`;

/**
 * The SQL condition of one filter, its values added to `p`, or null when it
 * doesn't apply: an unknown column, a range on a column that is neither a
 * number nor a date, or a bound that doesn't fit the column.
 */
export function facetFilterSql(f: FacetFilter, cols: Map<string, number>, p: SqlParams): string | null {
  if (!cols.has(f.column)) return null;
  const c = q(f.column);
  if (f.kind === 'values') {
    const list = p.add(f.values, 'text[]');
    return f.exclude ? `(${c} is null or not (${c}::text = any(${list})))` : `${c}::text = any(${list})`;
  }
  return rangeSql(c, cols.get(f.column), f, p);
}

/** from <= column < to (predefined) or from <= column <= to (custom; a date "to" is the whole day). */
export function rangeSql(c: string, oid: number | undefined, r: { from: string; to: string; custom?: boolean }, p: SqlParams): string | null {
  const kind = rangeKind(oid);
  if (!kind || !validBound(r.from, kind) || !validBound(r.to, kind) || (!r.from && !r.to)) return null;
  const cast = kind === 'number' ? 'numeric' : 'date';
  const parts: string[] = [];
  if (r.from) parts.push(`${c} >= ${p.add(r.from, cast)}`);
  if (r.to) {
    if (!r.custom) parts.push(`${c} < ${p.add(r.to, cast)}`);
    else if (kind === 'number') parts.push(`${c} <= ${p.add(r.to, cast)}`);
    else parts.push(`${c} < ${p.add(r.to, cast)} + 1`);
  }
  return `(${parts.join(' and ')})`;
}

/** The conditions of all applicable filters. */
export function facetWhere(params: URLSearchParams, reportId: number, defs: Map<string, FacetDef>, cols: Map<string, number>, p: SqlParams, except?: string): string[] {
  return facetFilters(params, reportId, defs, except)
    .map((f) => facetFilterSql(f, cols, p))
    .filter((s): s is string => s !== null);
}

/** The condition of the report's text search (the row as text contains the term). */
export function searchSql(term: string, p: SqlParams) {
  return `"__q"::text ilike ${p.add(`%${term.replace(/[\\%_]/g, '\\$&')}%`, 'text')}`;
}

// ---------------------------------------------------------------- labels

type T = (key: string, params?: Record<string, string>) => string;

/** A range as text: its label, "a – b", "a or more", "below b" or "★★★★ & up". */
export function rangeLabel(r: Range, t: T, def?: Pick<FacetDef, 'type'>) {
  if (r.label) return r.label;
  if (def?.type === 'star') return t(r.from === '1' ? 'facets.star_up' : 'facets.stars_up', { n: r.from });
  if (r.from && r.to) return `${r.from} – ${r.to}`;
  return r.from ? t('facets.at_least', { from: r.from }) : t('facets.below', { to: r.to });
}

/** One filter as text, e.g. "Job: Clerk, Analyst", "Job: not Clerk", "Salary: 1000 – 2000". */
export function describeFacetFilter(f: FacetFilter, label: string, t: T, def?: FacetDef) {
  if (f.kind === 'values') return `${label}: ${f.exclude ? `${t('facets.not')} ` : ''}${f.values.join(', ')}`;
  const known = !f.custom ? def?.ranges.find((x) => x.from === f.from && x.to === f.to) : undefined;
  return `${label}: ${rangeLabel(known ?? f, t, f.custom ? undefined : def)}`;
}
