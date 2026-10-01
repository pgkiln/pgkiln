import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { saveState, type Session } from '../session.ts';
import { COMPONENTS } from './components.ts';
import { BASE, developer, flash, type Req } from './ui.ts';

// Page designer layout: moving regions, items and buttons (drag and drop on
// the Layout tab, or the Move up / Move down / column span buttons), creating
// them from the gallery, and undo / redo of layout changes.
//
// Every endpoint is a plain form post (so the buttons work without
// JavaScript) that answers with a redirect back to the designer; builder.js
// posts the same forms with fetch and `Accept: application/json` and gets
// `{ ok, location }` instead. Ids must belong to the page in the URL, and
// region targets to the same page; anything else is refused.

export const LAYOUT_KINDS = ['region', 'item', 'button'] as const;
export type LayoutKind = (typeof LAYOUT_KINDS)[number];
const isKind = (k: unknown): k is LayoutKind => (LAYOUT_KINDS as readonly unknown[]).includes(k);

const options = (kind: string, field: string) => COMPONENTS[kind].fields.find((f) => f.name === field)!.options!.filter(Boolean);
export const REGION_TYPES = () => options('region', 'type');
export const ITEM_TYPES = () => options('item', 'type');
export const BUTTON_ACTIONS = () => options('button', 'action');

/** Gallery names and icons. */
export const REGION_LABELS: Record<string, [string, string]> = {
  report: ['Interactive report', 'table'], grid: ['Interactive grid', 'grid'], form: ['Form', 'file'], chart: ['Chart', 'chart'],
  cards: ['Cards', 'layers'], calendar: ['Calendar', 'calendar'], facets: ['Faceted search', 'filter'], tasks: ['Task list', 'inbox'],
  workflows: ['Workflow console', 'activity'], map: ['Map', 'map'], tree: ['Tree', 'org'], static: ['Static content', 'region'], dynamic: ['Dynamic content', 'code'],
  template_component: ['Template component', 'layers'],
};
export const ITEM_LABELS: Record<string, [string, string]> = {
  text: ['Text field', 'item'], textarea: ['Text area', 'item'], number: ['Number field', 'item'], date: ['Date picker', 'calendar'],
  datetime: ['Date and time', 'clock'], select: ['Select list', 'list'], popup_lov: ['Popup LOV', 'search'], radio: ['Radio group', 'check'],
  checkbox: ['Checkbox', 'check'], switch: ['Switch', 'check'], checkbox_group: ['Checkbox group', 'check'], multiselect: ['Multi select', 'list'],
  email: ['E-mail', 'inbox'], tel: ['Phone number', 'item'], url: ['URL', 'item'], color: ['Color picker', 'item'], file: ['File upload', 'upload'],
  location: ['Location', 'map'], hidden: ['Hidden', 'item'], display: ['Display only', 'file'], password: ['Password', 'key'],
};
export const BUTTON_LABELS: Record<string, [string, string]> = {
  submit: ['Submit page', 'button'], redirect: ['Redirect to page', 'button'], da: ['Dynamic action', 'bolt'], document: ['Download document', 'download'],
};

/** A working starting point per region type, so a new region renders straight away. */
const NEW_REGION_SOURCE: Record<string, string | null> = {
  report: "select 1 as id, 'Edit the query of this region' as name",
  chart: "select 'A' as label, 3 as value union all select 'B', 5",
  cards: "select 'Card title' as title, 'Edit the query of this region' as body",
  calendar: "select current_date as start_date, 'Event' as title",
  map: "select 52.37 as lat, 4.89 as lng, 'A place' as title",
  tree: "select 1 as id, null::int as parent_id, 'Root' as label",
  dynamic: "select '<p>' || meta.html_escape(:APP_USER) || '</p>' as html",
  static: '<p>New region</p>',
};

// ---------------------------------------------------------------- snapshots (undo / redo)

interface Snap {
  region: { id: number; seq: number; columns: number }[];
  item: { id: number; seq: number; region_id: number | null }[];
  button: { id: number; seq: number; region_id: number | null }[];
}
interface History {
  pid: number;
  undo: { label: string; before: Snap; after: Snap }[];
  redo: { label: string; before: Snap; after: Snap }[];
}
const HISTORY_KEY = '__PD_UNDO';
const HISTORY_MAX = 20;

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }> };

async function snapshot(c: Q, pid: number): Promise<Snap> {
  // one after the other: a transaction's client runs one query at a time
  const region = await c.query('select id, seq, columns from meta.region where page_id = $1 order by id', [pid]);
  const item = await c.query('select id, seq, region_id from meta.item where page_id = $1 order by id', [pid]);
  const button = await c.query('select id, seq, region_id from meta.button where page_id = $1 order by id', [pid]);
  return { region: region.rows, item: item.rows, button: button.rows };
}

/** Puts the layout of a snapshot back; components deleted since are skipped, regions that are gone become "no region". */
async function restore(c: Q, pid: number, snap: Snap) {
  const regions = new Set((await c.query('select id from meta.region where page_id = $1', [pid])).rows.map((r) => r.id));
  for (const r of snap.region) await c.query('update meta.region set seq = $3, columns = $4 where id = $1 and page_id = $2', [r.id, pid, r.seq, r.columns]);
  for (const kind of ['item', 'button'] as const)
    for (const r of snap[kind])
      await c.query(`update ${COMPONENTS[kind].table} set seq = $3, region_id = $4 where id = $1 and page_id = $2`, [r.id, pid, r.seq, r.region_id !== null && regions.has(r.region_id) ? r.region_id : null]);
}

function history(s: Session, pid: number): History {
  try {
    const h = JSON.parse(s.state[HISTORY_KEY] ?? '');
    if (h && h.pid === pid && Array.isArray(h.undo) && Array.isArray(h.redo)) return h;
  } catch {}
  return { pid, undo: [], redo: [] };
}
const keep = (s: Session, h: History) => {
  s.state[HISTORY_KEY] = JSON.stringify(h);
};

/** What the toolbar's Undo and Redo buttons would do on this page. */
export function undoState(s: Session, pid: number) {
  const h = history(s, pid);
  return { undo: h.undo.at(-1)?.label ?? null, redo: h.redo.at(-1)?.label ?? null };
}

// ---------------------------------------------------------------- operations

export class LayoutError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const int = (v: unknown) => (typeof v === 'string' && /^\d{1,9}$/.test(v) ? Number(v) : null);

/** The region a component goes to: '' is page level (no region), otherwise a region of this page. */
async function targetRegion(c: Q, pid: number, value: string): Promise<number | null> {
  if (value === '') return null;
  const id = int(value);
  if (id === null || !(await c.query('select 1 from meta.region where id = $1 and page_id = $2', [id, pid])).rowCount)
    throw new LayoutError(400, 'That region is not on this page.');
  return id;
}

/**
 * Moves a region, item or button. `dir` moves it one place up or down among
 * its neighbours; otherwise it goes before `before` (an id in the target
 * container, or '' for the end) in `region` (items and buttons; '' = page level).
 * Sequences in the target container are renumbered 10, 20, 30…
 */
export async function moveComponent(c: Q, pid: number, kind: LayoutKind, id: number, o: { dir?: string; region?: string; before?: string }) {
  const table = COMPONENTS[kind].table;
  const row = (await c.query(`select * from ${table} where id = $1 and page_id = $2`, [id, pid])).rows[0];
  if (!row) throw new LayoutError(404, `${COMPONENTS[kind].label} not found on this page.`);
  let region: number | null = kind === 'region' ? null : row.region_id;
  if (kind !== 'region' && o.region !== undefined && !o.dir) region = await targetRegion(c, pid, o.region);
  const scope = kind === 'region' ? '' : ' and region_id is not distinct from $2';
  const list: number[] = (await c.query(`select id from ${table} where page_id = $1${scope} order by seq, id`, kind === 'region' ? [pid] : [pid, region])).rows.map((r) => r.id);
  const others = list.filter((x) => x !== id);
  let at: number;
  if (o.dir === 'up' || o.dir === 'down') {
    const now = list.indexOf(id);
    at = Math.max(0, Math.min(others.length, now + (o.dir === 'up' ? -1 : 1)));
  } else if (o.dir) {
    throw new LayoutError(400, 'Unknown direction.');
  } else if (!o.before) {
    at = others.length;
  } else {
    const before = int(o.before);
    at = before === null ? -1 : others.indexOf(before);
    if (at < 0) throw new LayoutError(400, 'The place to move to is not in that region.');
  }
  others.splice(at, 0, id);
  for (const [i, x] of others.entries()) {
    if (kind === 'region') await c.query(`update ${table} set seq = $3 where id = $1 and page_id = $2`, [x, pid, (i + 1) * 10]);
    else await c.query(`update ${table} set seq = $3, region_id = case when id = $4 then $5::int else region_id end where id = $1 and page_id = $2`, [x, pid, (i + 1) * 10, id, region]);
  }
}

/** Sets a region's column span (1–12), or widens / narrows it by one column. */
export async function spanRegion(c: Q, pid: number, id: number, o: { columns?: string; delta?: string }) {
  const row = (await c.query('select columns from meta.region where id = $1 and page_id = $2', [id, pid])).rows[0];
  if (!row) throw new LayoutError(404, 'Region not found on this page.');
  const n = o.delta === '1' ? row.columns + 1 : o.delta === '-1' ? row.columns - 1 : int(o.columns);
  if (n === null || n < 1 || n > 12) throw new LayoutError(400, 'The column span is 1 to 12.');
  await c.query('update meta.region set columns = $3 where id = $1 and page_id = $2', [id, pid, n]);
  return n;
}

/** A new component from the gallery, with a working default; placed like moveComponent. Returns its id. */
export async function createComponent(c: Q, pid: number, kind: LayoutKind, type: string, o: { region?: string; before?: string }) {
  const page = (await c.query('select page_no from meta.page where id = $1', [pid])).rows[0];
  if (!page) throw new LayoutError(404, 'Page not found.');
  let id: number;
  if (kind === 'region') {
    if (!REGION_TYPES().includes(type)) throw new LayoutError(400, 'Unknown region type.');
    id = (await c.query(`insert into meta.region (page_id, seq, title, type, source) values ($1, 999999, $2, $3, $4) returning id`,
      [pid, `New ${REGION_LABELS[type]?.[0].toLowerCase() ?? type}`, type, NEW_REGION_SOURCE[type] ?? null])).rows[0].id;
  } else {
    const region = await targetRegion(c, pid, o.region ?? '');
    if (kind === 'item') {
      if (!ITEM_TYPES().includes(type)) throw new LayoutError(400, 'Unknown item type.');
      const taken = new Set((await c.query('select name from meta.item where page_id = $1', [pid])).rows.map((r) => r.name));
      const base = `P${page.page_no}_NEW`;
      let name = base;
      for (let i = 2; taken.has(name); i++) name = `${base}_${i}`;
      id = (await c.query(`insert into meta.item (page_id, region_id, seq, name, label, type) values ($1, $2, 999999, $3, 'New item', $4) returning id`, [pid, region, name, type])).rows[0].id;
    } else {
      if (!BUTTON_ACTIONS().includes(type)) throw new LayoutError(400, 'Unknown button action.');
      const taken = new Set((await c.query('select name from meta.button where page_id = $1', [pid])).rows.map((r) => r.name));
      let name = 'NEW_BUTTON';
      for (let i = 2; taken.has(name); i++) name = `NEW_BUTTON_${i}`;
      id = (await c.query(`insert into meta.button (page_id, region_id, seq, name, label, action) values ($1, $2, 999999, $3, 'New button', $4) returning id`, [pid, region, name, type])).rows[0].id;
    }
  }
  await moveComponent(c, pid, kind, id, { region: o.region ?? '', before: o.before ?? '' });
  return id;
}

// ---------------------------------------------------------------- routes

const wantsJson = (req: Req) => String(req.headers.accept ?? '').includes('application/json');

export async function arrangeRoutes(app: FastifyInstance) {
  const route = (op: string, handler: (s: Session, pid: number, b: Record<string, string | undefined>) => Promise<{ sel: string; message: string } | null>) =>
    app.post(`${BASE}/pages/:pid/layout/${op}`, async (req: Req, reply) => {
      const s = await developer(req, reply); // signed-in developer + CSRF, like every builder form
      if (!s) return;
      const pid = int(req.params.pid);
      if (pid === null || !(await owner.one('select 1 as ok from meta.page where id = $1', [pid]))) return reply.code(404).send('Page not found');
      try {
        const res = await handler(s, pid, req.body ?? {});
        const location = `${BASE}/pages/${pid}${res?.sel ? `?c=${res.sel}` : ''}`;
        if (res?.message) flash(s, res.message);
        await saveState(s);
        return wantsJson(req) ? reply.send({ ok: true, location }) : reply.redirect(location, 303);
      } catch (e) {
        if (!(e instanceof LayoutError)) throw e;
        return wantsJson(req) ? reply.code(e.status).send({ ok: false, error: e.message }) : reply.code(e.status).type('text/plain').send(e.message);
      }
    });

  /** Runs a layout change in a transaction and records it for undo. */
  const recorded = async (s: Session, pid: number, label: string, change: (c: Q) => Promise<void>) => {
    const h = history(s, pid);
    await owner.tx(async (c) => {
      const before = await snapshot(c, pid);
      await change(c);
      h.undo.push({ label, before, after: await snapshot(c, pid) });
    });
    h.undo = h.undo.slice(-HISTORY_MAX);
    h.redo = [];
    keep(s, h);
  };

  const describe = async (kind: LayoutKind, id: number) => {
    const r = await owner.one(`select * from ${COMPONENTS[kind].table} where id = $1`, [id]);
    return r ? `${COMPONENTS[kind].label.toLowerCase()} ${COMPONENTS[kind].summary(r)}` : COMPONENTS[kind].label.toLowerCase();
  };

  route('move', async (s, pid, b) => {
    const kind = b.kind;
    const id = int(b.id);
    if (!isKind(kind) || id === null) throw new LayoutError(400, 'Unknown component.');
    await recorded(s, pid, `Move ${await describe(kind, id)}`, (c) => moveComponent(c, pid, kind, id, { dir: b.dir, region: b.region, before: b.before }));
    return { sel: `${kind}-${id}`, message: `${COMPONENTS[kind].label} moved.` };
  });

  route('span', async (s, pid, b) => {
    const id = int(b.id);
    if (id === null) throw new LayoutError(400, 'Unknown region.');
    let n = 0;
    await recorded(s, pid, `Resize ${await describe('region', id)}`, async (c) => {
      n = await spanRegion(c, pid, id, { columns: b.columns, delta: b.delta });
    });
    return { sel: `region-${id}`, message: `Region spans ${n} of 12 columns.` };
  });

  route('create', async (s, pid, b) => {
    const kind = b.kind;
    if (!isKind(kind)) throw new LayoutError(400, 'Unknown component type.');
    const id = await owner.tx((c) => createComponent(c, pid, kind, b.type ?? '', { region: b.region, before: b.before }));
    keep(s, { pid, undo: [], redo: [] }); // earlier layout steps no longer line up with the new component
    return { sel: `${kind}-${id}`, message: `${COMPONENTS[kind].label} created; set its properties on the right.` };
  });

  for (const op of ['undo', 'redo'] as const)
    route(op, async (s, pid) => {
      const h = history(s, pid);
      const step = (op === 'undo' ? h.undo : h.redo).pop();
      if (!step) return { sel: '', message: `Nothing to ${op}.` };
      await owner.tx((c) => restore(c, pid, op === 'undo' ? step.before : step.after));
      (op === 'undo' ? h.redo : h.undo).push(step);
      keep(s, h);
      return { sel: '', message: `${op === 'undo' ? 'Undone' : 'Redone'}: ${step.label}.` };
    });
}
