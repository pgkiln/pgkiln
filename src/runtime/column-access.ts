// (sprint 210, AX-1; APEX: a report or grid column's Server-side Condition and Authorization Scheme) A column of a
// report, classic report, interactive grid or cards region can have a server-side condition and an authorization
// scheme, from the same catalogue as regions and items (meta.condition_ok, isAuthorized). They live in the region's
// config, so exports, application files and diff_app carry them without a schema change:
//
//   "column_access": {"SALARY": {"authz": "HR_ADMIN", "condition_type": "item_equals", "condition_expr": "P2_MODE", "condition_value": "FULL"}}
//
// A column whose authorization fails or whose condition is false is not in the region at all for this request: its
// source becomes `select <the other columns> from (<source>) "__c"`, so nothing that reads the region's rows can see it
// (the page, a partial refresh, CSV / Excel / PDF downloads, a grid's save, filters, sorting, search, facets, charts
// and group by of the report). Its values are not there for #COLUMN# substitutions either. computeVisibility (authz.ts)
// applies it for every request, before anything reads a region; the page's regions are this request's own objects
// (loadPage), and the region's original source is kept here so a second computeVisibility starts from it.
import pg from 'pg';
import { applyBinds } from '../binds.ts';
import type { Condition, Region } from '../metadata.ts';
import { savepoint } from '../db.ts';
import { bindValues, publicError, stripSemicolon, type PageContext } from './context.ts';
import { resolveRestRegion } from './rest-sources.ts';

/** The region types whose columns can have a condition and an authorization scheme. */
export const COLUMN_ACCESS_TYPES: ReadonlySet<string> = new Set(['report', 'classic_report', 'grid', 'cards']);

export interface ColumnAccess extends Condition {
  authz: string | null;
}

/** A region's column rules (config.column_access), by column name; only well-formed entries. */
export function columnAccessOf(r: Pick<Region, 'type' | 'config'>): Map<string, ColumnAccess> {
  const out = new Map<string, ColumnAccess>();
  const ca = r.config?.column_access;
  if (!COLUMN_ACCESS_TYPES.has(r.type) || !ca || typeof ca !== 'object' || Array.isArray(ca)) return out;
  for (const [name, v] of Object.entries(ca as Record<string, unknown>)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const x = v as Record<string, unknown>;
    const s = (k: string) => (typeof x[k] === 'string' && (x[k] as string).trim() ? (x[k] as string) : null);
    const rule: ColumnAccess = { authz: s('authz'), condition_type: s('condition_type') as Condition['condition_type'], condition_expr: s('condition_expr'), condition_value: s('condition_value') };
    if (rule.authz || rule.condition_type) out.set(name, rule);
  }
  return out;
}

/** The region's source before this request restricted it (REST rows already in it). */
const original = new WeakMap<Region, string | null>();
/** The column names of a source (as run with this request's binds): one probe per source text. */
const probed = new WeakMap<PageContext, Map<string, string[] | null>>();

/** The region's source as it was before restrictColumns changed it in this request. */
export const originalSource = (r: Region) => (original.has(r) ? original.get(r)! : r.source);

/**
 * Decide the region's column rules for this request and leave out the columns the user may not see. Returns the
 * names left out. `holds` and `authorized` are computeVisibility's condition and authorization checks.
 */
export async function restrictColumns(
  ctx: PageContext, r: Region,
  check: { authorized: (ref: string | null) => Promise<boolean>; holds: (c: Condition, where: string) => Promise<boolean> },
): Promise<string[]> {
  const rules = columnAccessOf(r);
  if (!rules.size) return [];
  if (!original.has(r)) {
    // a REST region's rows replace its source once per request: restrict what came back
    if (r.rest_source) await resolveRestRegion(ctx, r);
    original.set(r, r.source);
  }
  const src = original.get(r) ?? null;
  r.source = src;
  const denied: string[] = [];
  for (const [name, rule] of rules) {
    const ok = (await check.authorized(rule.authz)) && (await check.holds(rule, `condition of column ${name} of region "${r.title ?? r.id}"`));
    if (!ok) denied.push(name);
  }
  if (!denied.length || !src?.trim()) return denied;
  const out = new Set(denied.map((n) => n.toLowerCase()));
  const text = stripSemicolon(src);
  const names = await columnNames(ctx, text);
  // fail closed: a source that can't be read shows no rows (it would fail the same way unrestricted)
  r.source = names
    ? `select ${names.filter((n) => !out.has(n.toLowerCase())).map((n) => `"__c".${pg.escapeIdentifier(n)}`).join(', ')} from (\n${text}\n) "__c"`
    : `select * from (\n${text}\n) "__c" where false`;
  return denied;
}

async function columnNames(ctx: PageContext, text: string): Promise<string[] | null> {
  let cache = probed.get(ctx);
  if (!cache) probed.set(ctx, (cache = new Map()));
  const sql = `select * from (\n${applyBinds(text, bindValues(ctx))}\n) "__c" limit 0`;
  if (cache.has(sql)) return cache.get(sql)!;
  let names: string[] | null = null;
  try {
    const c = ctx.client!;
    names = (await savepoint(c, () => c.query(sql))).fields.map((f) => f.name);
  } catch (e) {
    ctx.errors.page.push(await publicError(ctx, e, 'region columns'));
  }
  cache.set(sql, names);
  return names;
}
