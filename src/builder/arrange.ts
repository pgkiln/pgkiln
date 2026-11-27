import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { saveState, type Session } from '../session.ts';
import { COMPONENTS } from './components.ts';
import { newComponentRegion } from './component-regions.ts';
import { BASE, developer, flash, type Req } from './ui.ts';
import { scopedTx as tx } from './i18n.ts';

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
/** (sprint 90) The components with a build option, which can be commented out. */
const COMMENTABLE = new Set(['region', 'item', 'button', 'dynamic_action', 'validation', 'process', 'computation', 'branch']);

const options = (kind: string, field: string) => COMPONENTS[kind].fields.find((f) => f.name === field)!.options!.filter(Boolean);
export const REGION_TYPES = () => options('region', 'type');
export const ITEM_TYPES = () => options('item', 'type');
export const BUTTON_ACTIONS = () => options('button', 'action');
/** (099) display positions of regions and button positions (slots) of region buttons; body and region are the defaults (null) */
export const POSITIONS = () => options('region', 'position');
export const SLOTS = () => options('button', 'slot');
export const POSITION_LABELS: Record<string, string> = {
  banner: 'Banner', breadcrumb: 'Breadcrumb bar', left: 'Left column', body: 'Body', right: 'Right column', footer: 'Footer',
  // (sprint 234, AX-12) the Standard page template's other positions
  after_logo: 'After logo', before_navigation_bar: 'Before navigation bar', after_navigation_bar: 'After navigation bar',
  top_navigation: 'Top navigation', full_width: 'Full width content', dialogs: 'Dialogs, drawers and popups',
};
export const SLOT_LABELS: Record<string, string> = {
  region: 'Region buttons', create: 'Create', edit: 'Edit', change: 'Change', copy: 'Copy', help: 'Help', up: 'Up',
  previous: 'Previous', close: 'Close', delete: 'Delete', next: 'Next',
  // (sprint 259) in the region body
  top_of_region: 'Top of Region', bottom_of_region: 'Bottom of Region',
};
/** The button positions in a region's header and in its bottom bar (previous, close, delete at the left; next at the right). */
export const TOP_SLOTS = ['create', 'edit', 'change', 'copy', 'help', 'up', 'top_of_region'];
export const BOTTOM_SLOTS = ['bottom_of_region', 'previous', 'close', 'delete', 'next'];

/** Gallery names and icons. */
export const REGION_LABELS: Record<string, [string, string]> = {
  report: ['Interactive Report', 'table'], grid: ['Interactive Grid', 'grid'], form: ['Form', 'file'], chart: ['Chart', 'chart'],
  cards: ['Cards', 'layers'], calendar: ['Calendar', 'calendar'], facets: ['Faceted Search', 'filter'], smart_filters: ['Smart Filters', 'search'], display_selector: ['Region Display Selector', 'menu'], tasks: ['Task List', 'inbox'],
  workflows: ['Workflow Console', 'activity'], map: ['Map', 'map'], tree: ['Tree', 'org'], static: ['Static Content', 'region'], dynamic: ['Dynamic Content', 'code'],
  template_component: ['Template Component', 'layers'], list: ['List', 'list'], data_reporter: ['Data Reporter', 'table'], form_designer: ['Form Designer', 'file'],
  ai_assistant: ['AI Assistant', 'bolt'], url: ['URL', 'link'], search: ['Search', 'search'], login: ['Login', 'lock'], plugin: ['Plug-in', 'layers'],
  classic_report: ['Classic Report', 'table'], breadcrumb: ['Breadcrumb', 'chevron'], help_text: ['Help Text', 'help'],
  json_form: ['JSON Form', 'file'],
};
export const ITEM_LABELS: Record<string, [string, string]> = {
  text: ['Text Field', 'item'], textarea: ['Text Area', 'item'], number: ['Number Field', 'item'], date: ['Date Picker', 'calendar'],
  datetime: ['Date and Time', 'clock'], select: ['Select List', 'list'], popup_lov: ['Popup LOV', 'search'], radio: ['Radio Group', 'check'],
  checkbox: ['Checkbox', 'check'], switch: ['Switch', 'check'], checkbox_group: ['Checkbox Group', 'check'], multiselect: ['Multi Select', 'list'],
  email: ['E-mail', 'inbox'], tel: ['Phone Number', 'item'], url: ['URL', 'item'], color: ['Color Picker', 'item'], file: ['File Upload', 'upload'],
  location: ['Location', 'map'], richtext: ['Rich Text Editor', 'edit'], markdown: ['Markdown Editor', 'code'], rating: ['Star Rating', 'check'],
  combobox: ['Combobox (Tags)', 'list'], daterange: ['Date Range', 'calendar'], qrcode: ['QR Code', 'scan'], image: ['Display Image', 'file'], address: ['Geocoded Address', 'map'], signature: ['Signature', 'edit'], hidden: ['Hidden', 'item'], display: ['Display Only', 'file'], password: ['Password', 'key'],
  shuttle: ['Shuttle', 'arrow-right'], select_one: ['Select One', 'search'], select_many: ['Select Many', 'check'],
};
export const BUTTON_LABELS: Record<string, [string, string]> = {
  submit: ['Submit Page', 'button'], redirect: ['Redirect to Page', 'button'], da: ['Dynamic Action', 'bolt'], document: ['Download Document', 'download'],
};

/**
 * (172, APEX: the gallery's container regions) Gallery entries that make a static region with a container template:
 * its sub regions are dropped into it. Created like a region type (data-type), they are not region types themselves.
 */
export const CONTAINER_LABELS: Record<string, [string, string]> = {
  tabs_container: ['Tabs Container', 'layers'], flex_container: ['Flexbox Container', 'grid'], collapsible_container: ['Collapsible', 'region'],
};
const CONTAINER_TEMPLATE: Record<string, string> = { tabs_container: 'tabs_container', flex_container: 'flex_container', collapsible_container: 'collapsible' };
/** (172) The templates that exist to hold sub regions: the layout always offers their sub region slot. */
export const CONTAINER_TEMPLATES = new Set(['tabs_container', 'flex_container', 'collapsible']);

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
  // position and slot (099) are missing from snapshots taken before them: those leave them as they are
  region: { id: number; seq: number; columns: number; position?: string | null; parent_id?: number | null }[];
  item: { id: number; seq: number; region_id: number | null }[];
  button: { id: number; seq: number; region_id: number | null; slot?: string | null }[];
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
  const region = await c.query('select id, seq, columns, position, parent_id from meta.region where page_id = $1 order by id', [pid]);
  const item = await c.query('select id, seq, region_id from meta.item where page_id = $1 order by id', [pid]);
  const button = await c.query('select id, seq, region_id, slot from meta.button where page_id = $1 order by id', [pid]);
  return { region: region.rows, item: item.rows, button: button.rows };
}

/** Puts the layout of a snapshot back; components deleted since are skipped, regions that are gone become "no region". */
async function restore(c: Q, pid: number, snap: Snap) {
  const regions = new Set((await c.query('select id from meta.region where page_id = $1', [pid])).rows.map((r) => r.id));
  // (172) sub regions leave their parents first, then go into theirs (one level deep at every step)
  for (const r of snap.region)
    if ('parent_id' in r && r.parent_id == null) await c.query('update meta.region set parent_id = null where id = $1 and page_id = $2 and parent_id is not null', [r.id, pid]);
  for (const r of snap.region)
    await c.query('update meta.region set seq = $3, columns = $4, position = case when $5 then $6 else position end where id = $1 and page_id = $2', [r.id, pid, r.seq, r.columns, 'position' in r, r.position ?? null]);
  for (const r of snap.region)
    if (r.parent_id != null && regions.has(r.parent_id))
      await c.query('update meta.region set parent_id = $3 where id = $1 and page_id = $2 and parent_id is distinct from $3', [r.id, pid, r.parent_id]);
  for (const r of snap.item)
    await c.query('update meta.item set seq = $3, region_id = $4 where id = $1 and page_id = $2', [r.id, pid, r.seq, r.region_id !== null && regions.has(r.region_id) ? r.region_id : null]);
  for (const r of snap.button)
    await c.query('update meta.button set seq = $3, region_id = $4, slot = case when $5 then $6 else slot end where id = $1 and page_id = $2',
      [r.id, pid, r.seq, r.region_id !== null && regions.has(r.region_id) ? r.region_id : null, 'slot' in r, r.slot ?? null]);
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
    throw new LayoutError(400, tx('arr.that_region_is_not_on'));
  return id;
}

/**
 * (172) The region a region goes into: '' is the page (a display position), otherwise a region of this page that is
 * not a sub region itself, and not the region; a region with sub regions stays at page level (one level of nesting).
 */
async function targetParent(c: Q, pid: number, id: number, value: string): Promise<number | null> {
  if (value === '') return null;
  const parent = int(value);
  const row = parent === null ? null : (await c.query('select id, parent_id from meta.region where id = $1 and page_id = $2', [parent, pid])).rows[0];
  if (!row) throw new LayoutError(400, tx('arr.that_region_is_not_on'));
  if (row.id === id || row.parent_id !== null) throw new LayoutError(400, tx('arr.sub_region_holds_none'));
  if ((await c.query('select 1 from meta.region where parent_id = $1', [id])).rowCount) throw new LayoutError(400, tx('arr.container_stays_on_page'));
  return row.id;
}

/**
 * Moves a region, item or button. `dir` moves it one place up or down among
 * its neighbours; otherwise it goes before `before` (an id in the target
 * container, or '' for the end) in `region` (items and buttons; '' = page level),
 * `position` (regions: a display position, '' = body) and `slot` (buttons: a
 * button position, '' = with the region's other buttons).
 * Sequences in the target container are renumbered 10, 20, 30…
 */
export async function moveComponent(c: Q, pid: number, kind: LayoutKind, id: number, o: { dir?: string; region?: string; before?: string; position?: string; slot?: string; parent?: string }) {
  const table = COMPONENTS[kind].table;
  const row = (await c.query(`select * from ${table} where id = $1 and page_id = $2`, [id, pid])).rows[0];
  if (!row) throw new LayoutError(404, `${COMPONENTS[kind].label} not found on this page.`);
  let region: number | null = kind === 'region' ? null : row.region_id;
  if (kind !== 'region' && o.region !== undefined && !o.dir) region = await targetRegion(c, pid, o.region);
  // the container: a region's display position; a button's region and position in it (page-level buttons have none)
  let place: string = kind === 'region' ? (row.position ?? 'body') : kind === 'button' && region !== null ? (row.slot ?? 'region') : '';
  if (kind === 'region' && o.position !== undefined && !o.dir) place = o.position || 'body';
  // (172) a region's parent region (sub regions are ordered among their siblings, and take the parent's position)
  let parent: number | null = kind === 'region' ? row.parent_id ?? null : null;
  if (kind === 'region' && o.parent !== undefined && !o.dir) parent = await targetParent(c, pid, id, o.parent);
  if (kind === 'region' && parent !== null)
    place = (await c.query('select position from meta.region where id = $1', [parent])).rows[0].position ?? 'body';
  if (kind === 'button' && o.slot !== undefined && !o.dir) place = o.slot || 'region';
  if (kind === 'button' && region === null) place = '';
  if (kind === 'region' && !POSITIONS().includes(place)) throw new LayoutError(400, tx('arr.unknown_position'));
  if (kind === 'button' && place && !SLOTS().includes(place)) throw new LayoutError(400, tx('arr.unknown_button_position'));
  const scope = kind === 'region' ? " and parent_id is not distinct from $3 and (parent_id is not null or coalesce(position, 'body') = $2)"
    : kind === 'button' ? " and region_id is not distinct from $2 and (region_id is null or coalesce(slot, 'region') = $3)"
    : ' and region_id is not distinct from $2';
  const params = kind === 'region' ? [pid, place, parent] : kind === 'button' ? [pid, region, place] : [pid, region];
  const list: number[] = (await c.query(`select id from ${table} where page_id = $1${scope} order by seq, id`, params)).rows.map((r) => r.id);
  const others = list.filter((x) => x !== id);
  let at: number;
  if (o.dir === 'up' || o.dir === 'down') {
    const now = list.indexOf(id);
    at = Math.max(0, Math.min(others.length, now + (o.dir === 'up' ? -1 : 1)));
  } else if (o.dir) {
    throw new LayoutError(400, tx('arr.unknown_direction'));
  } else if (!o.before) {
    at = others.length;
  } else {
    const before = int(o.before);
    at = before === null ? -1 : others.indexOf(before);
    if (at < 0) throw new LayoutError(400, tx('arr.the_place_to_move_to'));
  }
  others.splice(at, 0, id);
  const stored = place === 'body' || place === 'region' || place === '' ? null : place;
  for (const [i, x] of others.entries()) {
    if (kind === 'region') await c.query(`update ${table} set seq = $3, position = case when id = $4 then $5::text else position end, parent_id = case when id = $4 then $6::int else parent_id end where id = $1 and page_id = $2`, [x, pid, (i + 1) * 10, id, stored, parent]);
    else if (kind === 'button') await c.query(`update ${table} set seq = $3, region_id = case when id = $4 then $5::int else region_id end, slot = case when id = $4 then $6::text else slot end where id = $1 and page_id = $2`, [x, pid, (i + 1) * 10, id, region, stored]);
    else await c.query(`update ${table} set seq = $3, region_id = case when id = $4 then $5::int else region_id end where id = $1 and page_id = $2`, [x, pid, (i + 1) * 10, id, region]);
  }
  // (172) a container's sub regions go to its new position with it
  if (kind === 'region') await c.query('update meta.region set position = $3 where parent_id = $1 and page_id = $2 and position is distinct from $3', [id, pid, stored]);
}

/**
 * (172) Deletes a region; its sub regions are kept: they move up to the page, into the deleted region's position and
 * place (in their order). Returns false when the region is not on the page.
 */
export async function deleteRegion(c: Q, pid: number, id: number): Promise<boolean> {
  const row = (await c.query('select id, seq, position, parent_id from meta.region where id = $1 and page_id = $2', [id, pid])).rows[0];
  if (!row) return false;
  const kids: number[] = (await c.query('select id from meta.region where parent_id = $1 order by seq, id', [id])).rows.map((r) => r.id);
  if (kids.length) {
    const list: number[] = (await c.query("select id from meta.region where page_id = $1 and parent_id is null and coalesce(position, 'body') = coalesce($2, 'body') order by seq, id", [pid, row.position])).rows.map((r) => r.id);
    list.splice(list.indexOf(id), 1, ...kids);
    await c.query('update meta.region set parent_id = null, position = $2 where parent_id = $1', [id, row.position]);
    for (const [i, x] of list.entries()) await c.query('update meta.region set seq = $2 where id = $1', [x, (i + 1) * 10]);
  }
  await c.query('delete from meta.region where id = $1 and page_id = $2', [id, pid]);
  return true;
}

/** Sets a region's column span (1–12), or widens / narrows it by one column. */
export async function spanRegion(c: Q, pid: number, id: number, o: { columns?: string; delta?: string }) {
  const row = (await c.query('select columns from meta.region where id = $1 and page_id = $2', [id, pid])).rows[0];
  if (!row) throw new LayoutError(404, tx('arr.region_not_found_on_this'));
  const n = o.delta === '1' ? row.columns + 1 : o.delta === '-1' ? row.columns - 1 : int(o.columns);
  if (n === null || n < 1 || n > 12) throw new LayoutError(400, tx('arr.the_column_span_is_1'));
  await c.query('update meta.region set columns = $3 where id = $1 and page_id = $2', [id, pid, n]);
  return n;
}

/** A new component from the gallery, with a working default; placed like moveComponent. Returns its id. */
export async function createComponent(c: Q, pid: number, kind: LayoutKind, type: string, o: { region?: string; before?: string; position?: string; slot?: string; parent?: string }) {
  const page = (await c.query('select page_no from meta.page where id = $1', [pid])).rows[0];
  if (!page) throw new LayoutError(404, tx('arr.page_not_found'));
  let id: number;
  if (kind === 'region') {
    // (172) a container from the gallery is a static region with a container template
    const container = CONTAINER_TEMPLATE[type];
    // (sprint 231, AX-14) a built-in template component from the gallery: a template_component region of it
    const tc = newComponentRegion(type);
    if (!REGION_TYPES().includes(type) && !container && !tc) throw new LayoutError(400, tx('arr.unknown_region_type'));
    const parentTemplate = o.parent ? (await c.query('select template from meta.region where id = $1 and page_id = $2', [int(o.parent) ?? 0, pid])).rows[0]?.template : null;
    id = (await c.query(`insert into meta.region (page_id, seq, title, type, source, template) values ($1, 999999, $2, $3, $4, $5) returning id`,
      [pid, container ? CONTAINER_LABELS[type][0] : tc ? tc.title : `New ${REGION_LABELS[type]?.[0].toLowerCase() ?? type}`, container ? 'static' : tc ? 'template_component' : type,
       container ? null : tc ? tc.source : NEW_REGION_SOURCE[type] ?? null,
       // a tab shows the sub region's title: its own frame and heading would repeat it
       container ?? (parentTemplate === 'tabs_container' ? 'plain' : 'standard')])).rows[0].id;
    if (tc) await c.query('update meta.region set config = $2 where id = $1', [id, JSON.stringify(tc.config)]);
    // (140) a breadcrumb goes in the breadcrumb bar, without a frame of its own (unless it is dropped elsewhere)
    if (type === 'breadcrumb') {
      await c.query(`update meta.region set template = 'plain', title = 'Breadcrumb' where id = $1`, [id]);
      if (!o.position && !o.before) o = { ...o, position: 'breadcrumb' };
    }
  } else {
    const region = await targetRegion(c, pid, o.region ?? '');
    if (kind === 'item') {
      if (!ITEM_TYPES().includes(type)) throw new LayoutError(400, tx('arr.unknown_item_type'));
      const taken = new Set((await c.query('select name from meta.item where page_id = $1', [pid])).rows.map((r) => r.name));
      const base = `P${page.page_no}_NEW`;
      let name = base;
      for (let i = 2; taken.has(name); i++) name = `${base}_${i}`;
      id = (await c.query(`insert into meta.item (page_id, region_id, seq, name, label, type) values ($1, $2, 999999, $3, 'New item', $4) returning id`, [pid, region, name, type])).rows[0].id;
    } else {
      if (!BUTTON_ACTIONS().includes(type)) throw new LayoutError(400, tx('arr.unknown_button_action'));
      const taken = new Set((await c.query('select name from meta.button where page_id = $1', [pid])).rows.map((r) => r.name));
      let name = 'NEW_BUTTON';
      for (let i = 2; taken.has(name); i++) name = `NEW_BUTTON_${i}`;
      id = (await c.query(`insert into meta.button (page_id, region_id, seq, name, label, action) values ($1, $2, 999999, $3, 'New button', $4) returning id`, [pid, region, name, type])).rows[0].id;
    }
  }
  await moveComponent(c, pid, kind, id, { region: o.region ?? '', before: o.before ?? '', position: o.position ?? '', slot: o.slot ?? '', ...(kind === 'region' ? { parent: o.parent ?? '' } : {}) });
  return id;
}

/** A copy of a row of a page component table with some columns changed; returns its id. */
async function copyRow(c: Q, kind: LayoutKind, id: number, over: Record<string, unknown>): Promise<number> {
  const table = COMPONENTS[kind].table;
  return (await c.query(
    `insert into ${table} select (jsonb_populate_record(null::${table}, to_jsonb(x) || jsonb_build_object('id', nextval('${table}_id_seq')) || $2::jsonb)).* from ${table} x where id = $1 returning id`,
    [id, JSON.stringify(over)],
  )).rows[0].id;
}

/** NAME, or NAME_2, NAME_3… when the page has an item (or button) of that name already. */
async function freeName(c: Q, kind: 'item' | 'button', pid: number, name: string) {
  const taken = new Set((await c.query(`select name from ${COMPONENTS[kind].table} where page_id = $1`, [pid])).rows.map((r) => r.name));
  let out = name;
  for (let i = 2; taken.has(out); i++) out = `${name}_${i}`;
  return out;
}

/**
 * (sprint 77, APEX: Duplicate and Copy to other Page in the rendering tree's menu) A copy of a region (with its
 * items and buttons), an item or a button: on the same page right after the original, or at the end of another
 * page of the same application (items named P<n>_ get that page's number; components of a region go to page level
 * there). Item and button names are made unique on the page. Returns the copy's id.
 */
export async function duplicateComponent(c: Q, pid: number, kind: LayoutKind, id: number, toPid: number = pid) {
  const table = COMPONENTS[kind].table;
  const row = (await c.query(`select * from ${table} where id = $1 and page_id = $2`, [id, pid])).rows[0];
  if (!row) throw new LayoutError(404, `${COMPONENTS[kind].label} not found on this page.`);
  const pages = (await c.query('select t.page_no from meta.page t join meta.page f on f.app_id = t.app_id where t.id = $1 and f.id = $2', [toPid, pid])).rows;
  if (!pages.length) throw new LayoutError(400, tx('arr.that_page_is_not_in'));
  const same = toPid === pid;
  const rename = (name: string) => (same ? name : name.replace(/^P\d+_/, `P${pages[0].page_no}_`));
  const copyChild = async (k: 'item' | 'button', x: any, regionId: number | null) =>
    copyRow(c, k, x.id, { page_id: toPid, region_id: regionId, name: await freeName(c, k, toPid, rename(x.name)), ...(k === 'button' && regionId === null ? { slot: null } : {}) });
  // where the copy goes: after the original in its container, or at the end of the other page
  let place: { region?: string; position?: string; slot?: string; parent?: string; before: string } = { before: '' };
  if (same) {
    const scope = kind === 'region' ? " and parent_id is not distinct from $3 and (parent_id is not null or coalesce(position, 'body') = coalesce($2, 'body'))" : ' and region_id is not distinct from $2';
    const list: number[] = (await c.query(`select id from ${table} where page_id = $1${scope} order by seq, id`, kind === 'region' ? [pid, row.position, row.parent_id] : [pid, row.region_id])).rows.map((r) => r.id);
    const next = list[list.indexOf(id) + 1];
    place = { region: String(row.region_id ?? ''), position: row.position ?? '', slot: row.slot ?? '', before: next ? String(next) : '', ...(kind === 'region' ? { parent: String(row.parent_id ?? '') } : {}) };
  } else place = { region: '', position: row.position ?? '', slot: '', before: '', ...(kind === 'region' ? { parent: '' } : {}) };
  let copy: number;
  if (kind === 'region') {
    const staticId = row.static_id && !same && !(await c.query('select 1 from meta.region where page_id = $1 and static_id = $2', [toPid, row.static_id])).rowCount ? row.static_id : null;
    // (172) a sub region copied to another page goes to its page level; a container brings its sub regions along
    copy = await copyRow(c, 'region', id, { page_id: toPid, static_id: staticId, parent_id: same ? row.parent_id : null, ...(same ? { dom_id: null } : {}) });
    const copyRegion = async (from: number, to: number) => {
      for (const k of ['item', 'button'] as const)
        for (const x of (await c.query(`select id, name from ${COMPONENTS[k].table} where region_id = $1 order by seq, id`, [from])).rows) await copyChild(k, x, to);
    };
    await copyRegion(id, copy);
    for (const sub of (await c.query('select id, static_id from meta.region where parent_id = $1 order by seq, id', [id])).rows) {
      const subStatic = sub.static_id && !(await c.query('select 1 from meta.region where page_id = $1 and static_id = $2', [toPid, sub.static_id])).rowCount ? sub.static_id : null;
      await copyRegion(sub.id, await copyRow(c, 'region', sub.id, { page_id: toPid, static_id: subStatic, parent_id: copy, position: row.position, ...(same ? { dom_id: null } : {}) }));
    }
  } else copy = await copyChild(kind, row, same ? row.region_id : null);
  await moveComponent(c, toPid, kind, copy, place);
  return copy;
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
    if (!isKind(kind) || id === null) throw new LayoutError(400, tx('arr.unknown_component'));
    await recorded(s, pid, `Move ${await describe(kind, id)}`, (c) => moveComponent(c, pid, kind, id, { dir: b.dir, region: b.region, before: b.before, position: b.position, slot: b.slot, parent: b.parent }));
    return { sel: `${kind}-${id}`, message: `${COMPONENTS[kind].label} moved.` };
  });

  route('span', async (s, pid, b) => {
    const id = int(b.id);
    if (id === null) throw new LayoutError(400, tx('arr.unknown_region'));
    let n = 0;
    await recorded(s, pid, `Resize ${await describe('region', id)}`, async (c) => {
      n = await spanRegion(c, pid, id, { columns: b.columns, delta: b.delta });
    });
    return { sel: `region-${id}`, message: tx('arr.spans', { n }) };
  });

  route('create', async (s, pid, b) => {
    const kind = b.kind;
    if (!isKind(kind)) throw new LayoutError(400, tx('arr.unknown_component_type'));
    const id = await owner.tx((c) => createComponent(c, pid, kind, b.type ?? '', { region: b.region, before: b.before, position: b.position, slot: b.slot, parent: b.parent }));
    keep(s, { pid, undo: [], redo: [] }); // earlier layout steps no longer line up with the new component
    return { sel: `${kind}-${id}`, message: `${COMPONENTS[kind].label} created; set its properties on the right.` };
  });

  // (sprint 77) the rendering tree's menu: Duplicate, Copy to other Page
  // (sprint 90, PD-4; APEX: Comment Out) a component left out of the page by the build option COMMENTED_OUT (made with
  // the status Exclude when first needed); Uncomment takes it off again. Not a layout change: the undo history stays.
  route('comment', async (_s, pid, b) => {
    const kind = b.kind ?? '';
    const id = int(b.id);
    if (!COMMENTABLE.has(kind) || id === null) throw new LayoutError(400, tx('arr.unknown_component'));
    const on = b.on !== 'false';
    const done = await owner.tx(async (c) => {
      if (on)
        await c.query(
          `insert into meta.build_option (app_id, name, status, description)
           select app_id, 'COMMENTED_OUT', 'exclude', 'Components commented out in the page designer' from meta.page where id = $1
           on conflict (app_id, name) do nothing`, [pid]);
      return (await c.query(`update ${COMPONENTS[kind].table} set build_option = $3 where id = $1 and page_id = $2 and ${on ? 'true' : `build_option = 'COMMENTED_OUT'`}`, [id, pid, on ? 'COMMENTED_OUT' : null])).rowCount;
    });
    if (!done) throw new LayoutError(404, tx('arr.unknown_component'));
    return { sel: `${kind}-${id}`, message: `${COMPONENTS[kind].label} ${on ? 'commented out: it stays in the page designer and is left out of the page (build option COMMENTED_OUT)' : 'back on the page'}.` };
  });

  route('duplicate', async (s, pid, b) => {
    const kind = b.kind;
    const id = int(b.id);
    if (!isKind(kind) || id === null) throw new LayoutError(400, tx('arr.unknown_component'));
    const copy = await owner.tx((c) => duplicateComponent(c, pid, kind, id));
    keep(s, { pid, undo: [], redo: [] });
    return { sel: `${kind}-${copy}`, message: `${COMPONENTS[kind].label} duplicated.` };
  });

  app.post(`${BASE}/pages/:pid/layout/copy`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = (req.body ?? {}) as Record<string, string | undefined>;
    const pid = int(req.params.pid);
    const to = int(b.page);
    const kind = b.kind;
    const id = int(b.id);
    try {
      if (pid === null || !(await owner.one('select 1 as ok from meta.page where id = $1', [pid]))) throw new LayoutError(404, 'Page not found');
      if (!isKind(kind) || id === null || to === null) throw new LayoutError(400, tx('arr.unknown_component_or_page'));
      const copy = await owner.tx((c) => duplicateComponent(c, pid, kind, id, to));
      if (to === pid) keep(s, { pid, undo: [], redo: [] });
      flash(s, `${COMPONENTS[kind].label} copied.`);
      await saveState(s);
      const location = `${BASE}/pages/${to}?c=${kind}-${copy}`;
      return wantsJson(req) ? reply.send({ ok: true, location }) : reply.redirect(location, 303);
    } catch (e) {
      if (!(e instanceof LayoutError)) throw e;
      return wantsJson(req) ? reply.code(e.status).send({ ok: false, error: e.message }) : reply.code(e.status).type('text/plain').send(e.message);
    }
  });

  for (const op of ['undo', 'redo'] as const)
    route(op, async (s, pid) => {
      const h = history(s, pid);
      const step = (op === 'undo' ? h.undo : h.redo).pop();
      if (!step) return { sel: '', message: op === 'undo' ? tx('arr.nothing_undo') : tx('arr.nothing_redo') };
      await owner.tx((c) => restore(c, pid, op === 'undo' ? step.before : step.after));
      (op === 'undo' ? h.redo : h.undo).push(step);
      keep(s, h);
      return { sel: '', message: `${op === 'undo' ? tx('arr.undone') : tx('arr.redone')}: ${step.label}.` };
    });
}
