import { applyBinds } from '../binds.ts';
import { savepoint } from '../db.ts';
import { bindValues, publicError, stripSemicolon, type PageContext, type Visibility } from './context.ts';
import { saveButton, saveRequest } from './grid.ts';
import { selectionOf } from './report.ts';

export class Forbidden extends Error {}

/**
 * Evaluate an authorization reference ("ADMIN", "!ADMIN", or the built-in
 * MUST_NOT_BE_PUBLIC_USER). Unknown schemes fail closed. Results are cached
 * per request, as in APEX's "once per page view".
 */
export async function isAuthorized(ctx: PageContext, ref: string | null | undefined): Promise<boolean> {
  if (!ref) return true;
  const negate = ref.startsWith('!');
  const name = (negate ? ref.slice(1) : ref).trim().toUpperCase();
  let ok = ctx.authzCache.get(name);
  if (ok === undefined) {
    if (name === 'MUST_NOT_BE_PUBLIC_USER') ok = ctx.user !== 'nobody';
    else {
      const scheme = ctx.app.authz_schemes.find((s) => s.name === name);
      if (!scheme) ok = false;
      else if (scheme.type === 'role') ok = ctx.roles.includes(scheme.value.toLowerCase());
      else ok = await sqlTrue(ctx, scheme.value, `authorization ${name}`);
    }
    ctx.authzCache.set(name, ok);
  }
  return negate ? !ok : ok;
}

/**
 * Evaluate a SQL boolean expression with binds. Errors yield `onError`
 * (false by default: a broken condition hides a region or button).
 */
export async function sqlTrue(ctx: PageContext, expr: string | null | undefined, where: string, onError = false): Promise<boolean> {
  if (!expr?.trim()) return true;
  const c = ctx.client!;
  try {
    const res = await savepoint(c, () => c.query(`select (${stripSemicolon(applyBinds(expr, bindValues(ctx)))})::boolean as ok`));
    return res.rows[0]?.ok === true;
  } catch (e) {
    ctx.errors.page.push(await publicError(ctx, e, where));
    return onError;
  }
}

export function authzMessage(ctx: PageContext, ref: string | null) {
  const name = ref?.replace(/^!/, '').toUpperCase();
  return ctx.app.authz_schemes.find((s) => s.name === name)?.error_message ?? ctx.locale.t('error.not_authorized');
}

export async function checkPageAccess(ctx: PageContext) {
  if (!(await isAuthorized(ctx, ctx.page.authz))) throw new Forbidden(authzMessage(ctx, ctx.page.authz));
}

/** Can the current user open this page? Used to hide links and menu entries. */
export async function pageAllowed(ctx: PageContext, pageNo: number) {
  const p = ctx.app.pages.find((x) => x.page_no === pageNo);
  if (!p) return false;
  if (ctx.app.authentication !== 'none' && p.requires_auth && ctx.user === 'nobody') return false;
  return isAuthorized(ctx, p.authz);
}

/**
 * Decide which regions, items, buttons and dynamic actions exist for this
 * user in the current session state. Rendering uses it, and so does the
 * submit handler, *before* applying posted values: a button or item that
 * was not rendered cannot be pressed or set by a forged request.
 */
export async function computeVisibility(ctx: PageContext): Promise<Visibility> {
  const vis: Visibility = { regions: new Set(), items: new Set(), editable: new Set(), buttons: new Map(), dynamicActions: new Set() };
  for (const r of ctx.page.regions)
    if ((await isAuthorized(ctx, r.authz)) && (await sqlTrue(ctx, r.condition, `condition of region "${r.title ?? r.id}"`)))
      vis.regions.add(r.id);

  for (const i of ctx.page.items) {
    if (i.region_id !== null && !vis.regions.has(i.region_id)) continue;
    if (!(await isAuthorized(ctx, i.authz))) continue;
    vis.items.add(i.name);
    if (i.type === 'hidden' || i.type === 'display' || i.type === 'qrcode') continue;
    // fail closed: a broken read-only condition makes the item read-only
    if (i.readonly_condition && (await sqlTrue(ctx, i.readonly_condition, `read-only condition of ${i.name}`, true))) continue;
    vis.editable.add(i.name);
  }

  // a report's row selection posts its item, hidden or not (the values are the user's input: check them in the process)
  for (const r of ctx.page.regions) {
    const sel = vis.regions.has(r.id) ? selectionOf(ctx.page, r) : null;
    if (sel && vis.items.has(sel.item)) vis.editable.add(sel.item);
  }

  for (const b of ctx.page.buttons) {
    if (b.region_id !== null && !vis.regions.has(b.region_id)) continue;
    if (!(await isAuthorized(ctx, b.authz))) continue;
    if (!(await sqlTrue(ctx, b.condition, `condition of button ${b.name}`))) continue;
    vis.buttons.set(b.name, b);
  }

  // A menu button's submit entries are requests of their own (id 0: not rendered as buttons). A request
  // that is also a page button's name follows that button's visibility only.
  for (const b of [...vis.buttons.values()]) {
    if (b.action !== 'menu' || !Array.isArray(b.menu)) continue;
    for (const e of b.menu) {
      if (!e.request || vis.buttons.has(e.request) || ctx.page.buttons.some((x) => x.name === e.request)) continue;
      if (!(await isAuthorized(ctx, e.authz))) continue;
      vis.buttons.set(e.request, { ...b, id: 0, name: e.request, label: e.label, action: 'submit', target_page: null, target_items: {}, menu: null, hot: false, confirm: e.confirm ?? null, badge: null, badge_query: null });
    }
  }

  // an editable grid brings its own Save button
  for (const r of ctx.page.regions)
    if (r.type === 'grid' && vis.regions.has(r.id) && ctx.page.processes.some((p) => p.type === 'grid_dml' && p.region_id === r.id))
      vis.buttons.set(saveRequest(r), saveButton(r));

  for (const d of ctx.page.dynamic_actions) if (await isAuthorized(ctx, d.authz)) vis.dynamicActions.add(d.id);
  ctx.vis = vis;
  return vis;
}
