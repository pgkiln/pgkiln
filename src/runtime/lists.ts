import { applyBinds } from '../binds.ts';
import { runtime, savepoint } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon, isIcon } from '../icons.ts';
import type { Region } from '../metadata.ts';
import { isAuthorized, pageAllowed, sqlTrue } from './authz.ts';
import { bindValues, publicError, stripSemicolon, substitute, type PageContext } from './context.ts';
import { isModal, pageHref } from './links.ts';
import { overlayHash, STATIC_HASH } from './open-region.ts';
import { HEX } from './styles.ts';

// Lists (APEX: Shared Components > Lists): links with a label, a target (a
// page of the app with item values, a path inside the app, or an http(s)
// address), an icon, a badge and child entries. A list is static (rows of
// meta.list_entry, each with a condition, an authorization scheme and a
// build option) or the rows of a query run as the app's role:
//   select label, page, items, url, icon, badge, description, id, parent_id from …
// (only label is required). Entries the user can't open (page authorization)
// are left out like menu entries; a parent without a target and without
// visible children too. Links to pages with item values carry the checksum.
//
// Shown by "list" regions ({"list": "NAME", "template": "links" | "badges" |
// "cards" | "tabs"}) and, per app, as the navigation menu (nav_list) or the
// navigation bar (navbar_list).

export interface ListNode {
  label: string;
  href: string | null;
  modal: boolean;
  external: boolean;
  icon: string | null;
  badge: string | null;
  /** (154) the entry's id (a query's id column, else its label): finds its badge again for a live refresh */
  key: string;
  description: string | null;
  /** (sprint 254, MG-34) the entry's tile background, #rrggbb */
  color: string | null;
  /** the entry's page is the current page */
  current: boolean;
  /** the current page is below the entry (its page, a parent page of it, or a child entry) */
  inTrail: boolean;
  children: ListNode[];
}

export const LIST_TEMPLATES = ['links', 'badges', 'cards', 'tabs', 'wizard_progress', 'tiles'] as const;
export type ListTemplate = (typeof LIST_TEMPLATES)[number];
/** Most rows a list query may give. */
export const LIST_MAX_ROWS = 500;

interface Entry {
  id: number | string | null;
  parent_id: number | string | null;
  label: string;
  page: number | null;
  items: Record<string, string>;
  url: string | null;
  icon: string | null;
  badge: string | null;
  /** (154) a SELECT whose first value is the badge (static entries; wins over badge) */
  badge_query?: string | null;
  description: string | null;
  color?: string | null;
  condition?: string | null;
  authz?: string | null;
}

/** A path inside the application (as branch URLs) or an http(s) address; anything else is refused. */
export function safeListUrl(url: string): { kind: 'app' | 'external'; url: string } | null {
  const u = url.trim();
  if (/^https?:\/\/[^\s<>"'`\\]+$/i.test(u) && u.length <= 2000) return { kind: 'external', url: u };
  if (/^[A-Za-z0-9_&.?=%#,:~+-][A-Za-z0-9_&.?=%#,:~+/ -]*$/.test(u) && !/(\/\/|\.\.\/|\.\.$|^\.|[\\\x00-\x1f])/.test(u) && !/^[a-z][a-z0-9+.-]*:/i.test(u))
    return { kind: 'app', url: u };
  return null;
}

const toItems = (v: unknown): Record<string, string> => {
  let o = v;
  if (typeof o === 'string') {
    try {
      o = JSON.parse(o);
    } catch {
      return {};
    }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
  return Object.fromEntries(Object.entries(o as Record<string, unknown>).filter(([k]) => /^[A-Za-z][A-Za-z0-9_$]*$/.test(k)).map(([k, x]) => [k, x == null ? '' : String(x)]));
};

/** The entries of a list (static rows, or a query's rows), or null when the app has no such list. */
async function entriesOf(ctx: PageContext, name: string): Promise<Entry[] | null> {
  const list = await runtime.one<{ type: string; query: string | null }>('select type, query from meta.list where app_id = $1 and name = $2', [ctx.app.id, name.toUpperCase()]);
  if (!list) return null;
  if (list.type === 'sql') {
    const c = ctx.client;
    if (!c || !list.query?.trim()) return [];
    try {
      const sql = stripSemicolon(applyBinds(list.query, bindValues(ctx)));
      const res = await savepoint(c, () => c.query(`select * from (${sql}) q limit ${LIST_MAX_ROWS}`));
      return res.rows.map((r) => ({
        id: r.id ?? null,
        parent_id: r.parent_id ?? null,
        label: String(r.label ?? ''),
        page: Number.isInteger(Number(r.page)) && Number(r.page) > 0 && r.page !== null && r.page !== '' ? Number(r.page) : null,
        items: toItems(r.items),
        url: r.url == null || r.url === '' ? null : String(r.url),
        icon: r.icon == null ? null : String(r.icon),
        badge: r.badge == null || r.badge === '' ? null : String(r.badge),
        description: r.description == null ? null : String(r.description),
        color: r.color == null ? null : String(r.color),
      }));
    } catch (e) {
      ctx.errors.page.push(await publicError(ctx, e, `list ${name}`));
      return [];
    }
  }
  const rows = (
    await runtime.query(
      `select id, parent_id, label, target_page, target_items, target_url, icon, badge, badge_query, description, color, condition, authz
         from meta.list_entry where app_id = $1 and list_name = $2 and meta.build_option_on(app_id, build_option)
        order by seq, id`,
      [ctx.app.id, name.toUpperCase()],
    )
  ).rows;
  return rows.map((r) => ({
    id: r.id, parent_id: r.parent_id, label: ctx.locale.tr(r.label), page: r.target_page, items: r.target_items ?? {}, url: r.target_url,
    icon: r.icon, badge: r.badge, badge_query: r.badge_query, description: r.description ? ctx.locale.tr(r.description) : null, color: r.color, condition: r.condition, authz: r.authz,
  }));
}

/**
 * (029, 154) A badge from SQL: the first value of the query's first row, run as the application's
 * role with the page's binds; an error is a page error and no badge. Empty values give no badge.
 */
export async function queryBadge(ctx: PageContext, query: string, what: string): Promise<string | null> {
  const c = ctx.client;
  if (!c) return null;
  try {
    const sql = stripSemicolon(applyBinds(query, bindValues(ctx)));
    const res = await savepoint(c, () => c.query({ text: sql, rowMode: 'array' }));
    const v = res.rows[0]?.[0];
    return v === null || v === undefined ? null : String(v).trim().slice(0, 100) || null;
  } catch (e) {
    ctx.errors.page.push(await publicError(ctx, e, what));
    return null;
  }
}

/** The current page and its parent pages (for "in trail"). */
function trail(ctx: PageContext) {
  const pages = new Set<number>();
  for (let p: number | null | undefined = ctx.page.page_no, guard = 0; p && guard < 10; guard++) {
    pages.add(p);
    p = ctx.app.pages.find((x) => x.page_no === p)?.parent_page;
  }
  return pages;
}

/** The visible tree of a list for this request, or null when the list does not exist. */
export async function listTree(ctx: PageContext, name: string): Promise<ListNode[] | null> {
  const entries = await entriesOf(ctx, name);
  if (!entries) return null;
  const current = trail(ctx);
  const ids = new Set(entries.map((e) => (e.id == null ? null : String(e.id))));
  const node = async (e: Entry, depth: number): Promise<ListNode | null> => {
    if (!(await isAuthorized(ctx, e.authz))) return null;
    if (e.condition && !(await sqlTrue(ctx, e.condition, `condition of list entry "${e.label}"`))) return null;
    if (e.page && !(await pageAllowed(ctx, e.page))) return null;
    const children = depth < 6 && e.id != null ? await build(String(e.id), depth + 1) : [];
    let href: string | null = null;
    let external = false;
    if (e.page) href = pageHref(ctx, e.page, e.items);
    else if (e.url) {
      const safe = safeListUrl(substitute(e.url, ctx, encodeURIComponent));
      if (safe) {
        external = safe.kind === 'external';
        // (sprint 238, MG-14) #<static id>: an inline dialog region of this page (app.js opens it; #R<id> without JavaScript)
        href = external ? safe.url : STATIC_HASH.test(safe.url) ? overlayHash(ctx, safe.url.slice(1)) : `${ctx.base}/${safe.url}`;
      }
    }
    if (!href && !children.length) return null;
    const isCurrent = e.page !== null && e.page === ctx.page.page_no;
    return {
      label: substitute(e.label, ctx, (x) => x),
      href,
      modal: !!e.page && isModal(ctx, e.page),
      external,
      icon: e.icon,
      badge: e.badge_query?.trim()
        ? await queryBadge(ctx, e.badge_query, `badge of list entry "${e.label}"`)
        : e.badge === null ? null : substitute(e.badge, ctx, (x) => x),
      key: String(e.id ?? e.label),
      description: e.description === null ? null : substitute(e.description, ctx, (x) => x),
      color: e.color && HEX.test(e.color) ? e.color.toLowerCase() : null,
      current: isCurrent,
      inTrail: isCurrent || (e.page !== null && current.has(e.page)) || children.some((c) => c.inTrail),
      children,
    };
  };
  const build = async (parent: string | null, depth: number): Promise<ListNode[]> => {
    const out: ListNode[] = [];
    for (const e of entries) {
      // an unknown parent id makes the entry a top-level one
      const p = e.parent_id == null || !ids.has(String(e.parent_id)) ? null : String(e.parent_id);
      if (p !== parent) continue;
      const n = await node(e, depth);
      if (n) out.push(n);
    }
    return out;
  };
  return build(null, 0);
}

const linkAttrs = (n: ListNode, cls?: string) =>
  html`href="${n.href}"${cls ? html` class="${cls}"` : ''}${n.current ? raw(' aria-current="page"') : ''}${n.modal ? raw(' data-dialog') : ''}${n.external ? raw(' rel="noopener noreferrer"') : ''}`;
/**
 * An entry's badge. live: the prefix of the badge's data-badge key when the application refreshes
 * badges (154); an empty badge is then a hidden placeholder the refresh can fill.
 */
const badge = (n: ListNode, live?: string) =>
  n.badge !== null
    ? html` <span class="badge"${live ? html` data-badge="${live}${n.key}"` : ''}>${n.badge}</span>`
    : live ? html` <span class="badge" data-badge="${live}${n.key}" hidden></span>` : '';

/** Entries as the navigation menu (the same markup as navigation entries). */
export function navMarkup(nodes: ListNode[], topNav: boolean, live?: string): Raw[] {
  return nodes.map((n) => {
    const label = html`${icon(n.icon ?? 'chevron')}<span>${n.label}</span>${badge(n, live)}`;
    if (n.children.length)
      return html`<li><details${n.inTrail && !topNav ? raw(' open') : ''}><summary class="${n.inTrail ? 'in-trail' : null}">${label}</summary><ul>${
        n.href ? html`<li><a ${linkAttrs(n)}>${label}</a></li>` : ''}${navMarkup(n.children, topNav, live)}</ul></details></li>`;
    return html`<li><a ${linkAttrs(n, !n.current && n.inTrail ? 'in-trail' : undefined)}>${label}</a></li>`;
  });
}

const hasIcon = (n: ListNode) => isIcon(n.icon);

/** Entries as the navigation bar in the header: links, with a menu for entries with children (labels of entries with an icon hide on small screens). */
export function navbarMarkup(nodes: ListNode[], label: string, live?: string): Raw {
  if (!nodes.length) return raw('');
  return html`<nav class="t-navbar" aria-label="${label}"><ul>${nodes.map((n) =>
    n.children.length
      ? html`<li><details class="menu"><summary${hasIcon(n) ? html` class="nb-icon"` : ''}>${icon(n.icon)}<span>${n.label}</span>${badge(n, live)}</summary><div class="menu-panel align-right"><ul class="t-navbar-menu">${
          [...(n.href ? [n] : []), ...n.children].map((c) => html`<li><a ${linkAttrs(c)}>${icon(c.icon)}<span>${c.label}</span>${badge(c, live)}</a></li>`)}</ul></div></details></li>`
      : html`<li><a ${linkAttrs(n, hasIcon(n) ? 'nb-icon' : undefined)}>${icon(n.icon)}<span>${n.label}</span>${badge(n, live)}</a></li>`)}</ul></nav>`;
}

function linksMarkup(nodes: ListNode[]): Raw {
  return html`<ul class="list-links">${nodes.map((n) => html`<li>${n.href ? html`<a ${linkAttrs(n)}>${icon(n.icon)}<span>${n.label}</span>${badge(n)}</a>` : html`<span class="list-heading">${icon(n.icon)}<span>${n.label}</span>${badge(n)}</span>`}${
    n.children.length ? linksMarkup(n.children) : ''}</li>`)}</ul>`;
}

/** Every entry with a link, depth first (badge lists, cards and tabs are flat). */
const flat = (nodes: ListNode[]): ListNode[] => nodes.flatMap((n) => [...(n.href ? [n] : []), ...flat(n.children)]);

/** A "list" region. */
export async function renderListRegion(ctx: PageContext, r: Region): Promise<Raw> {
  const t = ctx.locale.t;
  const name = typeof r.config.list === 'string' ? r.config.list : '';
  const nodes = name ? await listTree(ctx, name) : null;
  if (!nodes) return html`<p class="muted">${t('list.missing', { list: name || '-' })}</p>`;
  if (!nodes.length) return html`<p class="muted">${t('list.empty')}</p>`;
  const template: ListTemplate = (LIST_TEMPLATES as readonly string[]).includes(r.config.template) ? r.config.template : 'links';
  const label = r.title || name;
  switch (template) {
    case 'badges':
      return html`<ul class="list-badges">${flat(nodes).map((n) => html`<li><a ${linkAttrs(n, 'list-badge')}><span class="list-badge-value">${n.badge ?? icon(n.icon ?? 'chevron')}</span><span class="list-badge-label">${n.label}</span></a></li>`)}</ul>`;
    case 'cards':
      return html`<ul class="cards list-cards">${flat(nodes).map((n) => html`<li><a ${linkAttrs(n, 'card list-card')}><span class="list-card-head"><span class="list-card-icon">${icon(n.icon ?? 'chevron')}</span><h3>${n.label}</h3>${badge(n)}</span>${n.description ? html`<p class="muted">${n.description}</p>` : ''}</a></li>`)}</ul>`;
    case 'tiles':
      return tilesMarkup(ctx, r, flat(nodes));
    case 'tabs':
      return html`<nav class="list-tabs" aria-label="${label}"><ul class="rds-list">${nodes.filter((n) => n.href).map((n) => html`<li><a ${linkAttrs(n, `rds-tab${n.inTrail ? ' is-current' : ''}`)}>${icon(n.icon)}<span>${n.label}</span>${badge(n)}</a></li>`)}</ul></nav>`;
    case 'wizard_progress': {
      // (088) the steps of a wizard (APEX: Wizard Progress): the current one (the page in the trail), the ones before it done
      const steps = flat(nodes);
      const at = steps.findIndex((n) => n.inTrail);
      return html`<nav class="wizard-progress" aria-label="${label}"><ol>${steps.map((n, i) => {
        const state = i === at ? 'current' : at >= 0 && i < at ? 'done' : 'todo';
        const text = html`<span class="wizard-step-no" aria-hidden="true">${state === 'done' ? icon('check') : i + 1}</span><span class="wizard-step-label">${n.label}</span>`;
        return html`<li class="wizard-step is-${state}"${state === 'current' ? html` aria-current="step"` : ''}>${state === 'done' && n.href ? html`<a ${linkAttrs(n, '')}>${text}</a>` : text}</li>`;
      })}</ol></nav>`;
    }
    default:
      return html`<nav aria-label="${label}">${linksMarkup(nodes)}</nav>`;
  }
}

/** (sprint 254, MG-34) A number from a region's config within [min, max], else the default. */
const within = (v: unknown, min: number, max: number, dflt: number) => {
  const n = Math.round(Number(v));
  return v !== undefined && v !== null && v !== '' && Number.isFinite(n) && n >= min && n <= max ? n : dflt;
};

/** Black or white, whichever reads better on a #rrggbb background (WCAG relative luminance). */
export function textOn(hex: string): '#000000' | '#ffffff' {
  const lin = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const l = 0.2126 * lin(1) + 0.7152 * lin(3) + 0.0722 * lin(5);
  return (l + 0.05) / 0.05 > 1.05 / (l + 0.05) ? '#000000' : '#ffffff';
}

/** A tile's icon: an icon name, or a picture among the application's files (#APP_FILES#tile.svg; a path on this site). */
function tileIcon(ctx: PageContext, value: string | null): Raw | '' {
  if (!value) return '';
  if (isIcon(value)) return icon(value);
  const src = substitute(value.trim(), ctx, encodeURIComponent);
  return /^\/(?![/\\])[^\s"'<>]*$/.test(src) ? html`<img src="${src}" alt="" loading="lazy" decoding="async">` : '';
}

/**
 * (sprint 254, MG-34) Tiles (Appsmith's home-screen containers): one coloured tile per entry with its icon (an icon
 * name or a picture file) and its label as real text. The region's config sets the row height, the gap, the number
 * of columns (none: as many as fit), the alignment and the icon size: {"tile_height": 90, "tile_gap": 8,
 * "tile_columns": 1, "tile_align": "center", "tile_icon_size": 45}. Colours come from each entry's color (else the
 * accent colour); the text is black or white, whichever reads better.
 */
function tilesMarkup(ctx: PageContext, r: Region, nodes: ListNode[]): Raw {
  const c = r.config ?? {};
  const cols = within(c.tile_columns, 1, 12, 0);
  const vars = [
    `--tile-height:${within(c.tile_height, 32, 400, 90)}px`,
    `--tile-gap:${within(c.tile_gap, 0, 64, 8)}px`,
    `--tile-icon:${within(c.tile_icon_size, 16, 200, 45)}px`,
    `--tile-align:${c.tile_align === 'left' ? 'flex-start' : c.tile_align === 'right' ? 'flex-end' : 'center'}`,
    ...(cols ? [`--tile-columns:repeat(${cols},minmax(0,1fr))`] : []),
  ].join(';');
  return html`<ul class="list-tiles ${ctx.css.cls(vars)}">${nodes.filter((n) => n.href).map((n) => {
    const colour = n.color ? ` ${ctx.css.cls(`--tile-bg:${n.color};--tile-fg:${textOn(n.color)}`)}` : '';
    return html`<li><a ${linkAttrs(n, `list-tile${colour}`)}>${n.icon ? html`<span class="list-tile-icon">${tileIcon(ctx, n.icon)}</span>` : ''}<span class="list-tile-label">${n.label}</span>${badge(n)}</a></li>`;
  })}</ul>`;
}
