import { savepoint } from '../db.ts';
import type { Region } from '../metadata.ts';
import type { PageContext } from './context.ts';

// Interactive grid column layout: the order of the columns, which ones a
// user hid, their widths and how many stay frozen (sticky) on the left while
// the grid scrolls sideways. A layout only arranges the columns the grid
// shows anyway (the developer's "hidden" columns never appear).
//
// Which layout applies: the user's own (meta.saved_report, kind 'layout';
// for the public user "nobody", the session), else the developer's
// config.layout, else the query's order. A saved grid report carries a
// layout as r<id>_lay; applying the report makes it the user's layout.

export interface GridLayout {
  order: string[];
  hidden: string[];
  widths: Record<string, number>;
  frozen: number;
}

export const MAX_FROZEN = 5;
export const MIN_WIDTH = 40;
export const MAX_WIDTH = 1000;
/** Width of a frozen column without one (its left neighbours' widths must be known). */
export const FROZEN_WIDTH = 160;
const MAX_COLUMNS = 200;
// a column name as PostgreSQL reports it: no control characters, at most 63 bytes
const nameOk = (n: unknown): n is string => typeof n === 'string' && n.length > 0 && Buffer.byteLength(n) <= 63 && !/[\u0000-\u001f\u007f]/.test(n);

export const emptyLayout = (): GridLayout => ({ order: [], hidden: [], widths: {}, frozen: 0 });

/** Any value → a layout with only well-formed names, widths clamped, at most MAX_FROZEN frozen. */
export function cleanLayout(x: unknown): GridLayout {
  const out = emptyLayout();
  if (!x || typeof x !== 'object' || Array.isArray(x)) return out;
  const o = x as Record<string, unknown>;
  const names = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter(nameOk))].slice(0, MAX_COLUMNS) : []);
  out.order = names(o.order);
  out.hidden = names(o.hidden);
  if (o.widths && typeof o.widths === 'object' && !Array.isArray(o.widths))
    for (const [k, v] of Object.entries(o.widths as Record<string, unknown>).slice(0, MAX_COLUMNS)) {
      const w = Math.round(Number(v));
      if (nameOk(k) && Number.isFinite(w) && w > 0) out.widths[k] = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, w));
    }
  const f = Math.floor(Number(o.frozen));
  out.frozen = Number.isFinite(f) ? Math.max(0, Math.min(MAX_FROZEN, f)) : 0;
  return out;
}

/** JSON text → a layout, or null when it isn't one (or is longer than 6000 characters). */
export function parseLayout(text: string | null | undefined): GridLayout | null {
  if (!text || text.length > 6000) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? cleanLayout(v) : null;
  } catch {
    return null;
  }
}

/** The layout as stored: only what differs from nothing. */
export function layoutJson(l: GridLayout) {
  const o: Record<string, unknown> = {};
  if (l.order.length) o.order = l.order;
  if (l.hidden.length) o.hidden = l.hidden;
  if (Object.keys(l.widths).length) o.widths = l.widths;
  if (l.frozen) o.frozen = l.frozen;
  return JSON.stringify(o);
}

export const layoutParam = (r: Region) => `r${r.id}_lay`;
const sessionKey = (r: Region) => `__GRID_LAYOUT_${r.id}`;

/** The developer's default layout of the grid (config.layout, plus config.frozen as a shorthand). */
export function defaultLayout(r: Region): GridLayout {
  const l = cleanLayout(r.config.layout);
  if (!l.frozen && r.config.frozen !== undefined) l.frozen = cleanLayout({ frozen: r.config.frozen }).frozen;
  return l;
}

/** The layout this user sees, and whether it is their own (so Reset has something to do). */
export async function currentLayout(ctx: PageContext, r: Region): Promise<{ layout: GridLayout; own: boolean }> {
  let text: string | null = null;
  if (ctx.user === 'nobody') text = ctx.session.state[sessionKey(r)] ?? null;
  else {
    const c = ctx.client!;
    const row = (
      await savepoint(c, () =>
        c.query<{ params: string }>(`select params from meta.saved_reports where region_id = $1 and kind = 'layout' and own limit 1`, [r.id]),
      )
    ).rows[0];
    text = row ? new URLSearchParams(row.params).get(layoutParam(r)) : null;
  }
  const own = parseLayout(text);
  return own ? { layout: own, own: true } : { layout: defaultLayout(r), own: false };
}

/** Keep the user's layout (null: back to the default). */
export async function storeLayout(ctx: PageContext, r: Region, layout: GridLayout | null) {
  if (ctx.user === 'nobody') {
    ctx.session.state[sessionKey(r)] = layout ? layoutJson(layout) : null;
    return;
  }
  const c = ctx.client!;
  if (layout) await c.query('select meta.save_grid_layout($1, $2)', [r.id, new URLSearchParams([[layoutParam(r), layoutJson(layout)]]).toString()]);
  else await c.query('select meta.reset_grid_layout($1)', [r.id]);
}

export interface Placed<T> {
  col: T;
  hidden: boolean;
  width: number | null;
  frozen: boolean;
  /** left offset of a frozen column in px, after the grid's leading columns */
  left: number;
}

/**
 * The columns in the layout's order: listed ones first, the rest in the
 * query's order. A user can't hide every column (then all show); the first
 * `frozen` shown columns are frozen, each with a width so the next one knows
 * where to stick.
 */
export function arrange<T extends { name: string }>(cols: T[], layout: GridLayout, lead = 0): Placed<T>[] {
  const pos = new Map(layout.order.map((n, i) => [n, i]));
  const sorted = cols
    .map((col, i) => ({ col, i }))
    .sort((a, b) => (pos.get(a.col.name) ?? MAX_COLUMNS + a.i) - (pos.get(b.col.name) ?? MAX_COLUMNS + b.i))
    .map(({ col }) => col);
  const hidden = new Set(layout.hidden);
  const allHidden = sorted.every((c) => hidden.has(c.name));
  let frozenLeft = Math.min(layout.frozen, MAX_FROZEN);
  let left = lead;
  return sorted.map((col) => {
    const h = !allHidden && hidden.has(col.name);
    let width = layout.widths[col.name] ?? null;
    let frozen = false;
    let at = 0;
    if (!h && frozenLeft > 0) {
      frozenLeft--;
      frozen = true;
      width ??= FROZEN_WIDTH;
      at = left;
      left += width;
    }
    return { col, hidden: h, width, frozen, left: at };
  });
}
