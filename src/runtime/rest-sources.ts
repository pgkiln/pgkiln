import type { Process, Region } from '../metadata.ts';
import { WebError } from '../webclient.ts';
import { callOperation, fetchSource, invoke, invokeCallProblems, invokeJson, isStringMap, loadSource, rowsSql, sourceParamValues, toRows, valueAt, withRest, type InvokeConfig, type Lookup, type RestSource } from '../websources.ts';
import { bindValues, toState, type PageContext } from './context.ts';

// REST data sources in applications:
// - a region with rest_source reads the source's rows instead of SQL; its
//   own SQL (optional) selects from the CTE "rest". Parameters come from
//   config.rest_params ({"city": "&P1_CITY."}) or the source's defaults.
// - a shared list of values with rest_source: its query selects from "rest".
// - the invoke_api process calls a source (or a URL) with values from page
//   items and puts values of the response into items.

/** &ITEM. substitutions: known items (unset ones are empty); other names stay as written. */
function itemLookup(ctx: PageContext): Lookup {
  const values = bindValues(ctx);
  return (upper) => {
    const known = upper in values || ctx.page.items.some((i) => i.name === upper) || ctx.app.app_items.includes(upper);
    return known ? (values[upper] ?? '') : undefined;
  };
}

/** Values for every parameter of the source: given ones (with substitutions), else the default (with substitutions). */
export const paramValues = (ctx: PageContext, s: RestSource, given: Record<string, unknown> | undefined) => sourceParamValues(s, given, itemLookup(ctx));

/** SQL over a source's rows: `sql` reads the CTE "rest" (default: select * from rest). */
export async function restSql(ctx: PageContext, sourceName: string, given: Record<string, unknown> | undefined, sql: string | null | undefined) {
  const s = await loadSource(ctx.app.id, sourceName);
  const { json } = await fetchSource(s, paramValues(ctx, s, given));
  const { columns, rows } = toRows(json, s);
  return withRest(rowsSql(columns, rows), sql);
}

const resolved = new WeakMap<Region, Promise<void>>();

/** What a region read from its REST data source in this request (grids write back with it). */
interface RestRegionInfo {
  source: RestSource;
  rows: Record<string, unknown>[];
  params: Record<string, string>;
}
const regionInfo = new WeakMap<Region, RestRegionInfo>();
export const restRegionInfo = (r: Region) => regionInfo.get(r);

/**
 * A region that reads a REST data source gets its source replaced (once per
 * request) by SQL over the fetched rows, so reports, cards, charts,
 * calendars, maps, grids and their downloads work unchanged. A grid without
 * a primary key column takes the source's first key column.
 */
export function resolveRestRegion(ctx: PageContext, r: Region): Promise<void> {
  if (!r.rest_source) return Promise.resolve();
  let p = resolved.get(r);
  if (!p) {
    p = (async () => {
      const s = await loadSource(ctx.app.id, r.rest_source!);
      const params = paramValues(ctx, s, r.config?.rest_params);
      const { json } = await fetchSource(s, params);
      const { columns, rows } = toRows(json, s);
      regionInfo.set(r, { source: s, rows, params });
      if (!r.pk_column && s.key_columns?.length) r.pk_column = s.key_columns[0];
      r.source = withRest(rowsSql(columns, rows), r.source);
    })();
    resolved.set(r, p);
  }
  return p;
}

// ---------------------------------------------------------------- write-back (forms, grids)

/** Whether a REST region's source defines the operation (a grid's Add, Save and Delete follow it). */
export function restAllows(r: Region, op: 'insert' | 'update' | 'delete') {
  return !!regionInfo.get(r)?.source.operations?.[op];
}

/** A REST grid's writable columns: the source's columns but the key, read-only and master columns. */
export function restWritable(r: Region, exclude: Set<string>) {
  const info = regionInfo.get(r);
  if (!info) return new Set<string>();
  const keys = new Set([...(info.source.key_columns ?? []), r.pk_column ?? '']);
  return new Set(info.source.columns.map((c) => c.name).filter((n) => !keys.has(n) && !exclude.has(n.toLowerCase())));
}

/**
 * One write-back call of a REST grid for a row. Update sends the row as it
 * was read from the service (in this request) with the changed columns, so
 * a PUT replaces the whole row and read-only columns can't be changed from
 * the browser.
 */
export async function restGridCall(r: Region, op: 'insert' | 'update' | 'delete', pk: string | null, changes: Record<string, unknown>) {
  const info = regionInfo.get(r);
  if (!info) throw new WebError(`Region "${r.title ?? r.id}": its REST data source was not read.`);
  const key = r.pk_column!;
  let row: Record<string, unknown> = { ...changes };
  if (op !== 'insert') {
    const read = info.rows.find((x) => x[key] !== null && x[key] !== undefined && String(x[key]) === pk);
    row = op === 'update' ? { ...(read ?? {}), ...changes, [key]: read?.[key] ?? pk } : { [key]: read?.[key] ?? pk };
  }
  return callOperation(info.source, op, row, info.params);
}

/** The source and key of a REST form region (the region's primary key column, else the source's first key column). */
async function restForm(ctx: PageContext, r: Region) {
  const s = await loadSource(ctx.app.id, r.rest_source!);
  const key = r.pk_column ?? s.key_columns?.[0];
  if (!key) throw new WebError(`Form "${r.title ?? r.id}": set the key columns of REST data source ${s.name}, or the region's primary key column.`);
  return { s, key, params: paramValues(ctx, s, r.config?.rest_params) };
}

/**
 * The row of a REST form region with this key: its fetch operation, or else
 * the source's rows (read like a region's) searched for the key. Null when
 * there is none.
 */
export async function restFetchRow(ctx: PageContext, r: Region, pk: string): Promise<Record<string, unknown> | null> {
  const { s, key, params } = await restForm(ctx, r);
  if (s.operations?.fetch) return (await callOperation(s, 'fetch', { [key]: pk }, params)).row;
  const { json } = await fetchSource(s, params);
  return toRows(json, s).rows.find((x) => x[key] !== null && x[key] !== undefined && String(x[key]) === pk) ?? null;
}

/**
 * Insert, update or delete the row of a REST form region: the items' values
 * by their source column (and the key for update and delete). Insert puts
 * the new row's key from the response into the primary key item.
 */
export async function restFormDml(ctx: PageContext, r: Region, op: 'insert' | 'update' | 'delete', values: Record<string, string | null>, pk: string | null) {
  const { s, key, params } = await restForm(ctx, r);
  if (!s.operations?.[op]) throw new WebError(`REST data source ${s.name} has no ${op} operation.`);
  let row: Record<string, unknown> = op === 'delete' ? {} : { ...values };
  // a PUT replaces the whole row: the columns without an item keep the service's values
  if (op === 'update' && (s.operations.update!.method ?? 'PUT').toUpperCase() === 'PUT') {
    const current = await restFetchRow(ctx, r, pk!);
    row = { ...(current ?? {}), ...values };
  }
  if (op !== 'insert') row[key] = pk;
  const res = await callOperation(s, op, row, params);
  if (op === 'insert') {
    const v = res.row?.[key];
    if (v !== undefined && v !== null) ctx.session.state[r.pk_item!] = toState(v);
  }
  return res;
}

// ---------------------------------------------------------------- invoke_api

interface InvokeProcessConfig extends InvokeConfig {
  /** item → JSON path in the response, e.g. {"P5_TEMP": "current.temperature"} */
  items?: Record<string, string>;
  /** item for the HTTP status; with it, an error status doesn't fail the process */
  status_item?: string;
}

/** Problems with an invoke_api process configuration (empty: fine). */
export function invokeProblems(conf: unknown): string[] {
  const c = (conf ?? {}) as InvokeProcessConfig;
  const out = invokeCallProblems(c);
  if (c.items !== undefined && !isStringMap(c.items)) out.push('"items" is an object of strings.');
  return out;
}

export async function invokeApi(ctx: PageContext, p: Process, assignable: Set<string>): Promise<string | null> {
  const conf = (p.config ?? {}) as InvokeProcessConfig;
  const problems = invokeProblems(conf);
  const what = `Process "${p.name}"`;
  if (problems.length) throw new WebError(`${what}: ${problems.join(' ')}`);
  const { res, source } = await invoke(ctx.app.id, conf, itemLookup(ctx), what);
  const set = (item: string, v: unknown) => {
    const name = item.toUpperCase();
    if (!assignable.has(name)) throw new WebError(`${what}: ${name} is not an item of this page or an application item.`);
    ctx.session.state[name] = toState(v);
  };
  if (conf.status_item) set(conf.status_item, String(res.status));
  const json = invokeJson(res, what, !!conf.status_item);
  if (conf.items) for (const [item, path] of Object.entries(conf.items)) set(item, valueAt(json, path) ?? null);
  else if (source && json !== null) {
    // without a mapping: the first row's columns set the items named like them
    const { rows } = toRows(json, source);
    for (const [k, v] of Object.entries(rows[0] ?? {})) if (assignable.has(k.toUpperCase())) ctx.session.state[k.toUpperCase()] = toState(v);
  }
  return p.success_message;
}
