import type { Page, Region } from '../metadata.ts';
import { checksumValid, urlChecksum } from '../security.ts';
import type { PageContext } from './context.ts';
import { regionUrl } from './report.ts';

// Master-detail (APEX: a detail region with a master region). The master
// grid names a column and a page item:
//
//   master grid: config {"select_row": {"column": "deptno", "item": "P27_DEPTNO"}}
//   detail:      config {"master": {"item": "P27_DEPTNO", "column": "deptno"}}
//                source  ... where deptno = :P27_DEPTNO::int
//
// Each master row gets a select link r<master id>_sel=<value>&r<id>_selcs=<sig>:
// the signature (bound to app, page, user, region and value) means only a
// value the server showed this user can be put into the item. Without
// JavaScript the link reloads the page; with it app.js fetches the detail
// regions through GET …/region/:id with the same parameters. The detail's
// "column" is filled with the item's value on new rows of a detail grid.

export interface SelectRow {
  column: string;
  item: string;
}

/** A master grid's selection: the column and the page item (which must be on the page). */
export function selectRowOf(page: Pick<Page, 'items'>, r: Region): SelectRow | null {
  const s = r.config.select_row as { column?: unknown; item?: unknown } | undefined;
  if (r.type !== 'grid' || typeof s?.column !== 'string' || typeof s?.item !== 'string') return null;
  const item = s.item.toUpperCase();
  return page.items.some((i) => i.name === item) ? { column: s.column, item } : null;
}

/** The item a detail region follows (config.master.item), upper case, or null. */
export function masterItemOf(r: Region): string | null {
  const m = r.config.master as { item?: unknown } | undefined;
  return typeof m?.item === 'string' && m.item ? m.item.toUpperCase() : null;
}

/** The column of a detail grid that new rows get the master's value in. */
export function masterColumnOf(r: Region): string | null {
  const m = r.config.master as { column?: unknown } | undefined;
  return typeof m?.column === 'string' && m.column ? m.column : null;
}

/** The master grids on the page whose selection a region follows. */
export function mastersOf(page: Page, r: Region) {
  const item = masterItemOf(r);
  return item ? page.regions.filter((m) => m.id !== r.id && selectRowOf(page, m)?.item === item) : [];
}

/** The regions following a master grid's selection (visible ones, when `visible` is given). */
export function detailsOf(page: Page, master: Region, visible?: Set<number>) {
  const sel = selectRowOf(page, master);
  if (!sel) return [];
  return page.regions.filter((r) => r.id !== master.id && masterItemOf(r) === sel.item && (!visible || visible.has(r.id)));
}

const token = (ctx: PageContext, r: Region, value: string) => urlChecksum(ctx.app.id, ctx.page.page_no, ctx.user, { [`S${r.id}`]: value });

/** The link that selects a master row: the current page with the selection added (the details start on their first page). */
export function selectHref(ctx: PageContext, r: Region, value: string, details: Region[] = []) {
  ctx.userBound = true;
  return regionUrl(ctx, r, (p) => {
    p.set(`r${r.id}_sel`, value);
    p.set(`r${r.id}_selcs`, token(ctx, r, value));
    p.delete(`r${r.id}_dup`);
    for (const d of details) for (const k of ['p', 'k', 'dup']) p.delete(`r${d.id}_${k}`);
  });
}

/**
 * Put a master row's selection (r<id>_sel with a valid signature) into the
 * master's item. Selections with a wrong signature are ignored; returns
 * whether one was applied.
 */
export function applyRowSelection(ctx: PageContext): boolean {
  let applied = false;
  for (const r of ctx.page.regions) {
    const sel = selectRowOf(ctx.page, r);
    const value = ctx.params.get(`r${r.id}_sel`);
    if (!sel || value === null || value.length > 4000) continue;
    if (!checksumValid(token(ctx, r, value), ctx.params.get(`r${r.id}_selcs`) ?? undefined)) continue;
    ctx.session.state[sel.item] = value === '' ? null : value;
    applied = true;
  }
  return applied;
}
