import type { Process, Region } from '../metadata.ts';
import { WebError } from '../webclient.ts';
import { buildRequest, call, fetchSource, loadCredential, loadSource, parseJson, rowsSql, toRows, valueAt, withRest, type RestSource } from '../websources.ts';
import { bindValues, toState, type PageContext } from './context.ts';

// REST data sources in applications:
// - a region with rest_source reads the source's rows instead of SQL; its
//   own SQL (optional) selects from the CTE "rest". Parameters come from
//   config.rest_params ({"city": "&P1_CITY."}) or the source's defaults.
// - a shared list of values with rest_source: its query selects from "rest".
// - the invoke_api process calls a source (or a URL) with values from page
//   items and puts values of the response into items.

/** &ITEM. substitutions in a parameter value (unset items are empty). */
function paramValue(ctx: PageContext, text: string) {
  const values = bindValues(ctx);
  return text.replace(/&([A-Za-z][A-Za-z0-9_]*)\./g, (m, name: string) => {
    const upper = name.toUpperCase();
    const known = upper in values || ctx.page.items.some((i) => i.name === upper) || ctx.app.app_items.includes(upper);
    return known ? (values[upper] ?? '') : m;
  });
}

/** Values for every parameter of the source: given ones (with substitutions), else the default (with substitutions). */
export function paramValues(ctx: PageContext, s: RestSource, given: Record<string, unknown> | undefined) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(given ?? {}))
    if (!s.params.some((p) => p.name === k)) throw new WebError(`REST data source ${s.name} has no parameter ${k}.`);
  for (const p of s.params) {
    const v = given?.[p.name] ?? p.default;
    out[p.name] = v === undefined || v === null ? '' : paramValue(ctx, String(v));
  }
  return out;
}

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

interface InvokeConfig {
  /** a REST data source (its URL, method, credential, parameters) */
  source?: string;
  params?: Record<string, string>;
  /** or a URL (&ITEM. substitutions after the host, URL-encoded), method, credential and body */
  url?: string;
  method?: string;
  credential?: string;
  body?: string;
  /** item → JSON path in the response, e.g. {"P5_TEMP": "current.temperature"} */
  items?: Record<string, string>;
  /** item for the HTTP status; with it, an error status doesn't fail the process */
  status_item?: string;
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/** Problems with an invoke_api process configuration (empty: fine). */
export function invokeProblems(conf: unknown): string[] {
  const c = (conf ?? {}) as InvokeConfig;
  const out: string[] = [];
  if (!c.source === !c.url) out.push('An invoke_api process needs either "source" (a REST data source) or "url".');
  if (c.url !== undefined && (typeof c.url !== 'string' || !/^https?:\/\/[^/?#&{]+([/?#]|$)/i.test(c.url)))
    out.push('"url" starts with http:// or https:// and a fixed host (substitutions only after the host).');
  if (c.method !== undefined && !METHODS.includes(String(c.method).toUpperCase())) out.push(`"method" is one of ${METHODS.join(', ')}.`);
  for (const k of ['params', 'items'] as const)
    if (c[k] !== undefined && (typeof c[k] !== 'object' || c[k] === null || Array.isArray(c[k]) || Object.values(c[k]!).some((v) => typeof v !== 'string')))
      out.push(`"${k}" is an object of strings.`);
  return out;
}

export async function invokeApi(ctx: PageContext, p: Process, assignable: Set<string>): Promise<string | null> {
  const conf = (p.config ?? {}) as InvokeConfig;
  const problems = invokeProblems(conf);
  if (problems.length) throw new WebError(`Process "${p.name}": ${problems.join(' ')}`);
  let source: RestSource | null = null;
  let res;
  if (conf.source) {
    source = await loadSource(ctx.app.id, conf.source);
    const req = buildRequest(source, paramValues(ctx, source, conf.params));
    const credential = source.credential ? await loadCredential(ctx.app.id, source.credential) : null;
    res = await call({ ...req, credential, timeoutMs: source.timeout_s * 1000 });
  } else {
    // values are URL-encoded and only follow the host (invokeProblems), so the host is always the developer's
    const url = conf.url!.replace(/&([A-Za-z][A-Za-z0-9_]*)\./g, (m) => {
      const v = paramValue(ctx, m);
      if (v === m) return m;
      if (v === '.' || v === '..') throw new WebError(`Process "${p.name}": "${v}" is not a valid value in a URL.`);
      return encodeURIComponent(v);
    });
    const method = (conf.method ?? 'GET').toUpperCase();
    const body = conf.body ? conf.body.replace(/&([A-Za-z][A-Za-z0-9_]*)\./g, (m) => JSON.stringify(paramValue(ctx, m))) : undefined;
    const credential = conf.credential ? await loadCredential(ctx.app.id, conf.credential) : null;
    res = await call({ url, method, headers: body ? { 'content-type': 'application/json' } : {}, body, credential, timeoutMs: 10_000 });
  }
  const set = (item: string, v: unknown) => {
    const name = item.toUpperCase();
    if (!assignable.has(name)) throw new WebError(`Process "${p.name}": ${name} is not an item of this page or an application item.`);
    ctx.session.state[name] = toState(v);
  };
  if (conf.status_item) set(conf.status_item, String(res.status));
  else if (res.status < 200 || res.status > 299) throw new WebError(`Process "${p.name}": the web service answered ${res.status}.`, res.status);
  const json = res.status >= 200 && res.status <= 299 ? parseJson(res, `Process "${p.name}"`) : null;
  if (conf.items) for (const [item, path] of Object.entries(conf.items)) set(item, valueAt(json, path) ?? null);
  else if (source && json !== null) {
    // without a mapping: the first row's columns set the items named like them
    const { rows } = toRows(json, source);
    for (const [k, v] of Object.entries(rows[0] ?? {})) if (assignable.has(k.toUpperCase())) ctx.session.state[k.toUpperCase()] = toState(v);
  }
  return p.success_message;
}
