// (sprint 230, migration 188, AX-9, AX-10, AX-11) A region's property groups beyond its type's own, as APEX has them in
// the Page Designer, and what they do on the page:
//
// Layout          new_row (Start New Row), grid_column (Column 1-12, else Automatic), row_css_classes (on the row a
//                 region with new_row starts: <div class="t-row …">), column_css_classes and column_attributes (on the
//                 region's grid cell: in pgkiln's grid that is the region's element). The column and span become
//                 col-start-N and col-N classes (a span that would run past column 12 is cut to fit).
// Appearance      css_classes, icon (on the templates that show one), render_components (items above or below)
// Accessibility   use_landmark (false: no landmark), landmark_type (an ARIA role), landmark_label (aria-label)
// Advanced        dom_id (the id of the region's content: its element stays R<id>, which pgkiln's scripts use),
//                 custom_attributes (only data-*, aria-* but the name, title, lang, dir, tabindex and translate:
//                 never on* handlers, style, id, class or src/href, so the strict CSP and the page's own
//                 attributes stay), title_no_translate
// Header / Footer header_text and footer_text: HTML around the content, &ITEM. substitutions escaped (as static content)
// Read Only       readonly_type/expr/value: a server-side condition; when it holds the region's items and its sub
//                 regions' items are read-only and a grid has no Save (computeVisibility)
// Customization   customization 'shown' | 'hidden': the page's Customize link lists the region and the user's choice is
//                 kept as a user preference (PGKILN_REGIONS_P<page>); the public user gets the defaults
import type { FastifyInstance, FastifyReply } from 'fastify';
import { appTx } from '../db.ts';
import { esc, html, raw, type Raw } from '../html.ts';
import { icon, isIcon } from '../icons.ts';
import type { Region } from '../metadata.ts';
import { saveState } from '../session.ts';
import { checkPageAccess, computeVisibility, Forbidden } from './authz.ts';
import { publicError, substitute, type PageContext } from './context.ts';
import { conditionHolds } from './logic.ts';
import { expandShortcuts } from './shortcuts.ts';

// ---------------------------------------------------------------- class lists and attributes

const CLASS = /^-?[A-Za-z_][A-Za-z0-9_-]*$/;
/** A list of CSS class names (at most 20, each a plain class name), or null when it isn't one. */
export function classList(s: string | null | undefined): string | null {
  const parts = String(s ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length || parts.length > 20 || !parts.every((c) => CLASS.test(c) && c.length <= 60)) return null;
  return parts.join(' ');
}
/** A message when a property's text is not a list of CSS class names. */
export const classListProblem = (label: string, s: string | null | undefined) =>
  String(s ?? '').trim() && !classList(s) ? `${label}: CSS class names separated by spaces (letters, digits, _ and -; at most 20), e.g. u-colors margin-top-md` : null;

/** The attributes a region's Custom Attributes and Column Attributes may set. */
const ATTRIBUTE = /^(data-[a-z0-9_.-]{1,60}|aria-(?!label$|labelledby$|hidden$)[a-z]{2,30}|title|lang|dir|tabindex|translate)$/;
const TOKEN = /\s*([^\s="'<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/y;

export interface Attribute { name: string; value: string | null }

/** name="value" pairs (also 'value', bare value or no value); `problem` names the first one that can't be used. */
export function parseAttributes(text: string | null | undefined): { attrs: Attribute[]; problem: string | null } {
  const s = String(text ?? '');
  const attrs: Attribute[] = [];
  let problem: string | null = null;
  TOKEN.lastIndex = 0;
  let at = 0;
  while (at < s.length) {
    if (/^\s*$/.test(s.slice(at))) break;
    TOKEN.lastIndex = at;
    const m = TOKEN.exec(s);
    if (!m || m.index !== at || TOKEN.lastIndex === at) {
      problem ??= `"${s.slice(at).trim().slice(0, 40)}" is not name="value"`;
      break;
    }
    at = TOKEN.lastIndex;
    const name = m[1].toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? null;
    if (!ATTRIBUTE.test(name)) {
      problem ??= /^on/.test(name) ? `${name}: event handlers are not allowed (use a dynamic action)`
        : name === 'style' ? 'style: not allowed (the Content-Security-Policy refuses inline styles; use CSS Classes)'
        : `${name}: not allowed (use data-*, aria-*, title, lang, dir, tabindex or translate)`;
      continue;
    }
    if (name === 'tabindex' && !/^-?\d{1,3}$/.test(value ?? '')) {
      problem ??= 'tabindex: a whole number';
      continue;
    }
    if (name === 'dir' && !['ltr', 'rtl', 'auto'].includes(value ?? '')) {
      problem ??= 'dir: ltr, rtl or auto';
      continue;
    }
    if (attrs.some((a) => a.name === name) || attrs.length >= 30) continue;
    attrs.push({ name, value });
  }
  return { attrs, problem };
}
/** A message when a property's attributes can't all be used (the builder refuses to save them). */
export function attributesProblem(label: string, text: string | null | undefined): string | null {
  const { problem } = parseAttributes(text);
  return problem ? `${label}: ${problem}` : null;
}

/** The attributes as HTML (values with &ITEM. substitutions, escaped), leaving out names in `taken`. */
function attributesHtml(ctx: PageContext, text: string | null | undefined, taken: Set<string>): string {
  let out = '';
  for (const a of parseAttributes(text).attrs) {
    if (taken.has(a.name)) continue;
    taken.add(a.name);
    out += a.value === null ? ` ${a.name}` : ` ${a.name}="${esc(substitute(a.value, ctx, (v) => v))}"`;
  }
  return out;
}

// ---------------------------------------------------------------- Layout

/** The grid column the region starts in (Column, else 1 when it starts a new row), or null (it flows). */
export const startColumn = (r: Pick<Region, 'grid_column' | 'new_row'>) =>
  Number.isInteger(r.grid_column) && r.grid_column! >= 1 && r.grid_column! <= 12 ? r.grid_column! : r.new_row ? 1 : null;

/** col-N (the span, cut so that it ends at column 12 at the latest) and col-start-N. */
export function gridClasses(r: Pick<Region, 'columns' | 'grid_column' | 'new_row'>): string {
  const start = startColumn(r);
  const span = Math.max(1, Math.min(Number(r.columns) || 12, 12, start ? 13 - start : 12));
  return `col-${span}${start ? ` col-start-${start}` : ''}`;
}

/**
 * The regions of one grid (a display position, or a region's sub regions) with Row CSS Classes: a region with Start New
 * Row and row classes begins a <div class="t-row …"> (a 12-column grid of its own) that holds it and the regions after it
 * until the next region that starts a new row. Regions without row classes stay where they are.
 */
export function arrangeRows(list: [Region, Raw][]): Raw[] {
  const out: Raw[] = [];
  let row: Raw[] | null = null;
  let cls = '';
  const flush = () => {
    if (row) out.push(html`<div class="t-row ${cls}">${row}</div>`);
    row = null;
  };
  for (const [r, x] of list) {
    if (r.new_row) {
      flush();
      const c = classList(r.row_css_classes);
      if (c) {
        row = [x];
        cls = c;
        continue;
      }
    }
    if (row) (row as Raw[]).push(x);
    else out.push(x);
  }
  flush();
  return out;
}

// ---------------------------------------------------------------- the region's element

/** Classes (grid, CSS Classes, Column CSS Classes) and attributes (Custom and Column Attributes) of a region's element. */
export function shellExtras(ctx: PageContext, r: Region): { cls: string; attrs: Raw } {
  const extra = [classList(r.css_classes), classList(r.column_css_classes)].filter(Boolean).join(' ');
  const taken = new Set(['id', 'class', 'style', 'hidden', 'role', 'aria-label', 'aria-labelledby', 'data-static-id', 'data-inline-region', 'data-region-tabs']);
  const attrs = attributesHtml(ctx, r.custom_attributes, taken) + attributesHtml(ctx, r.column_attributes, taken);
  return { cls: `${gridClasses(r)}${extra ? ` ${extra}` : ''}`, attrs: raw(attrs) };
}

/**
 * The region's landmark: its role (Landmark Type) and accessible name (Landmark Label, else the title: aria-labelledby
 * the heading `titleId` when the template shows one). Use Landmark = No: neither (a section without a name is no
 * landmark). A dialog keeps its role and always has a name.
 */
export function landmarkAttrs(ctx: PageContext, r: Region, titleId: string | null, dialog = false): Raw {
  if (r.use_landmark === false && !dialog) return raw('');
  const role = !dialog && r.landmark_type && r.landmark_type !== 'region' && /^[a-z]+$/.test(r.landmark_type) ? ` role="${r.landmark_type}"` : '';
  const label = r.landmark_label?.trim() ? substitute(r.landmark_label.trim(), ctx, (v) => v) : '';
  if (label) return raw(`${role} aria-label="${esc(label)}"`);
  if (titleId) return raw(`${role} aria-labelledby="${titleId}"`);
  if (r.title) return raw(`${role} aria-label="${esc(r.title)}"`);
  return raw(role);
}

/** The region's icon (Appearance → Icon), or ''. */
export const regionIcon = (r: Region): Raw | '' => (r.icon && isIcon(r.icon) ? html`<span class="region-icon">${icon(r.icon)}</span>` : '');

/** A dom id the page may use: not one of pgkiln's own (R<id>…, an item's name). */
export const domIdOk = (s: string | null | undefined): s is string =>
  typeof s === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(s) && !/^R\d/.test(s) && !/^[A-Z][A-Z0-9_]*$/.test(s);

/**
 * The region's content with its Header Text and Footer Text (HTML, &ITEM. escaped, shortcuts expanded, as static
 * content) and, with an HTML DOM ID, in a <div id="…"> of its own.
 */
export async function frameContent(ctx: PageContext, r: Region, body: Raw): Promise<Raw> {
  const text = async (s: string | null | undefined, cls: string) =>
    s?.trim() ? html`<div class="${cls}">${raw(substitute(await expandShortcuts(ctx, s, 'html'), ctx, esc))}</div>` : '';
  const head = await text(r.header_text, 'region-header-text');
  const foot = await text(r.footer_text, 'region-footer-text');
  const inner = head || foot ? html`${head}${body}${foot}` : body;
  return domIdOk(r.dom_id) ? html`<div class="region-content" id="${r.dom_id}">${inner}</div>` : inner;
}

// ---------------------------------------------------------------- Read Only

/** The shown regions whose Read Only condition holds, and their sub regions. A broken condition counts as read-only. */
export async function readOnlyRegions(ctx: PageContext, shown: Set<number>): Promise<Set<number>> {
  const out = new Set<number>();
  for (const r of ctx.page.regions) {
    if (!shown.has(r.id) || !r.readonly_type) continue;
    const errors = ctx.errors.page.length;
    const holds = await conditionHolds(ctx, { condition_type: r.readonly_type as never, condition_expr: r.readonly_expr ?? null, condition_value: r.readonly_value ?? null },
      `read-only condition of region "${r.title ?? r.id}"`);
    if (holds || ctx.errors.page.length > errors) out.add(r.id);
  }
  for (const r of ctx.page.regions) if (r.parent_id != null && out.has(r.parent_id)) out.add(r.id);
  return out;
}

// ---------------------------------------------------------------- Customization

/** The key of a region in the user's choice: its static id, else its id. */
const keyOf = (r: Region) => r.static_id || String(r.id);
const prefName = (ctx: PageContext) => `PGKILN_REGIONS_P${ctx.page.page_no}`;

/**
 * The customizable regions the user may see (authorization, condition) and whether each shows: the user's choice, else
 * the region's default (customization 'shown' or 'hidden'). The public user has no choice of their own.
 */
export async function customizedRegions(ctx: PageContext, shown: Set<number>): Promise<Map<number, boolean>> {
  const regions = ctx.page.regions.filter((r) => r.customization && shown.has(r.id) && r.parent_id == null);
  const out = new Map<number, boolean>();
  if (!regions.length) return out;
  let choice: Record<string, unknown> = {};
  if (ctx.user !== 'nobody' && ctx.client) {
    try {
      const v = (await ctx.client.query('select meta.get_preference($1) as v', [prefName(ctx)])).rows[0]?.v;
      const parsed = v ? JSON.parse(v) : null;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) choice = parsed;
    } catch {
      choice = {};
    }
  }
  for (const r of regions) {
    const own = choice[keyOf(r)];
    out.set(r.id, typeof own === 'boolean' ? own : r.customization === 'shown');
  }
  return out;
}

/** The page's Customize link (a disclosure with a checkbox per customizable region), for a signed-in user. */
export function customizePanel(ctx: PageContext): Raw | '' {
  const list = ctx.vis?.customizable;
  if (!list?.size || ctx.user === 'nobody') return '';
  const t = ctx.locale.t;
  const regions = ctx.page.regions.filter((r) => list.has(r.id));
  return html`<details class="t-customize">
    <summary>${icon('settings')}<span>${t('customize.link')}</span></summary>
    <form method="post" action="${ctx.base}/${ctx.page.page_no}/customize" class="t-customize-form">
      <input type="hidden" name="__csrf" value="${ctx.session.csrf_token}">
      <fieldset><legend>${t('customize.legend')}</legend>
        ${regions.map((r) => html`<label class="check"><input type="checkbox" name="show" value="${keyOf(r)}"${list.get(r.id) ? raw(' checked') : ''}> ${r.customization_name?.trim() || r.title || keyOf(r)}</label>`)}
      </fieldset>
      <div class="buttons"><button class="btn btn-hot">${t('customize.apply')}</button></div>
    </form>
  </details>`;
}

type Loader = (req: any, reply: FastifyReply, opts?: { json?: boolean }) => Promise<PageContext | null>;
type Tx = (ctx: PageContext) => Parameters<typeof appTx>[0];

/** POST /a/:alias/:page/customize: the user's choice of the page's customizable regions (shown ones checked). */
export function customizeRoutes(app: FastifyInstance, loadContext: Loader, txContext: Tx) {
  app.post('/a/:alias/:page/customize', async (req: any, reply) => {
    const ctx = await loadContext(req, reply);
    if (!ctx) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const deny = (code: number, message: string) => reply.code(code).type('text/plain').send(message);
    if (body.__csrf !== ctx.session.csrf_token) return deny(403, ctx.locale.t('error.session_reload'));
    if (ctx.user === 'nobody') return deny(403, ctx.locale.t('error.access_denied'));
    const show = new Set(([] as unknown[]).concat(body.show ?? []).filter((v): v is string => typeof v === 'string').slice(0, 200));
    try {
      await appTx(txContext(ctx), async (c) => {
        ctx.client = c;
        await checkPageAccess(ctx);
        const vis = await computeVisibility(ctx);
        const choice: Record<string, boolean> = {};
        for (const r of ctx.page.regions) if (vis.customizable?.has(r.id)) choice[keyOf(r)] = show.has(keyOf(r));
        await c.query('select meta.set_preference($1, $2)', [prefName(ctx), JSON.stringify(choice)]);
      });
      ctx.session.state.__FLASH = ctx.locale.t('customize.saved');
    } catch (e) {
      if (e instanceof Forbidden) return deny(403, ctx.locale.t('error.access_denied'));
      ctx.session.state.__FLASH = await publicError(ctx, e, 'customize');
    }
    await saveState(ctx.session);
    return reply.redirect(`${ctx.base}/${ctx.page.page_no}`, 303);
  });
}
