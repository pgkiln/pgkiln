import { applyBinds } from '../binds.ts';
import { runtime, savepoint } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon, ICONS } from '../icons.ts';
import type { Region } from '../metadata.ts';
import { isAuthorized, pageAllowed, sqlTrue } from './authz.ts';
import { bindValues, publicError, stripSemicolon, substitute, type PageContext } from './context.ts';
import { isModal, pageHref } from './links.ts';

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
  description: string | null;
  /** the entry's page is the current page */
  current: boolean;
  /** the current page is below the entry (its page, a parent page of it, or a child entry) */
  inTrail: boolean;
  children: ListNode[];
}

export const LIST_TEMPLATES = ['links', 'badges', 'cards', 'tabs'] as const;
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
  description: string | null;
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
      }));
    } catch (e) {
      ctx.errors.page.push(await publicError(ctx, e, `list ${name}`));
      return [];
    }
  }
  const rows = (
    await runtime.query(
      `select id, parent_id, label, target_page, target_items, target_url, icon, badge, description, condition, authz
         from meta.list_entry where app_id = $1 and list_name = $2 and meta.build_option_on(app_id, build_option)
        order by seq, id`,
      [ctx.app.id, name.toUpperCase()],
    )
  ).rows;
  return rows.map((r) => ({
    id: r.id, parent_id: r.parent_id, label: ctx.locale.tr(r.label), page: r.target_page, items: r.target_items ?? {}, url: r.target_url,
    icon: r.icon, badge: r.badge, description: r.description ? ctx.locale.tr(r.description) : null, condition: r.condition, authz: r.authz,
  }));
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
        href = external ? safe.url : `${ctx.base}/${safe.url}`;
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
      badge: e.badge === null ? null : substitute(e.badge, ctx, (x) => x),
      description: e.description === null ? null : substitute(e.description, ctx, (x) => x),
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
const badge = (n: ListNode) => (n.badge !== null ? html` <span class="badge">${n.badge}</span>` : '');

/** Entries as the navigation menu (the same markup as navigation entries). */
export function navMarkup(nodes: ListNode[], topNav: boolean): Raw[] {
  return nodes.map((n) => {
    const label = html`${icon(n.icon ?? 'chevron')}<span>${n.label}</span>${badge(n)}`;
    if (n.children.length)
      return html`<li><details${n.inTrail && !topNav ? raw(' open') : ''}><summary class="${n.inTrail ? 'in-trail' : null}">${label}</summary><ul>${
        n.href ? html`<li><a ${linkAttrs(n)}>${label}</a></li>` : ''}${navMarkup(n.children, topNav)}</ul></details></li>`;
    return html`<li><a ${linkAttrs(n, !n.current && n.inTrail ? 'in-trail' : undefined)}>${label}</a></li>`;
  });
}

const hasIcon = (n: ListNode) => !!n.icon && (ICONS as readonly string[]).includes(n.icon);

/** Entries as the navigation bar in the header: links, with a menu for entries with children (labels of entries with an icon hide on small screens). */
export function navbarMarkup(nodes: ListNode[], label: string): Raw {
  if (!nodes.length) return raw('');
  return html`<nav class="t-navbar" aria-label="${label}"><ul>${nodes.map((n) =>
    n.children.length
      ? html`<li><details class="menu"><summary${hasIcon(n) ? html` class="nb-icon" aria-label="${n.label}"` : ''}>${icon(n.icon)}<span>${n.label}</span>${badge(n)}</summary><div class="menu-panel align-right"><ul class="t-navbar-menu">${
          [...(n.href ? [n] : []), ...n.children].map((c) => html`<li><a ${linkAttrs(c)}>${icon(c.icon)}<span>${c.label}</span>${badge(c)}</a></li>`)}</ul></div></details></li>`
      : html`<li><a ${linkAttrs(n, hasIcon(n) ? 'nb-icon' : undefined)}${hasIcon(n) ? html` aria-label="${n.label}"` : ''}>${icon(n.icon)}<span>${n.label}</span>${badge(n)}</a></li>`)}</ul></nav>`;
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
      return html`<ul class="cards list-cards">${flat(nodes).map((n) => html`<li><a ${linkAttrs(n, 'card list-card')}><span class="list-card-head">${icon(n.icon ?? 'chevron')}<h3>${n.label}</h3>${badge(n)}</span>${n.description ? html`<p class="muted">${n.description}</p>` : ''}</a></li>`)}</ul>`;
    case 'tabs':
      return html`<nav class="list-tabs" aria-label="${label}"><ul class="rds-list">${nodes.filter((n) => n.href).map((n) => html`<li><a ${linkAttrs(n, `rds-tab${n.inTrail ? ' is-current' : ''}`)}>${icon(n.icon)}<span>${n.label}</span>${badge(n)}</a></li>`)}</ul></nav>`;
    default:
      return html`<nav aria-label="${label}">${linksMarkup(nodes)}</nav>`;
  }
}
