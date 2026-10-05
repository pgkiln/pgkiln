import type { Process, Region } from '../metadata.ts';
import { WebError } from '../webclient.ts';
import { fetchSource, invoke, invokeCallProblems, invokeJson, isStringMap, loadSource, rowsSql, sourceParamValues, toRows, valueAt, withRest, type InvokeConfig, type Lookup, type RestSource } from '../websources.ts';
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

/**
 * A region that reads a REST data source gets its source replaced (once per
 * request) by SQL over the fetched rows, so reports, cards, charts,
 * calendars, maps and their downloads work unchanged.
 */
export function resolveRestRegion(ctx: PageContext, r: Region): Promise<void> {
  if (!r.rest_source) return Promise.resolve();
  let p = resolved.get(r);
  if (!p) {
    p = restSql(ctx, r.rest_source, r.config?.rest_params, r.source).then((sql) => {
      r.source = sql;
    });
    resolved.set(r, p);
  }
  return p;
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
