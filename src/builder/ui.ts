import { availabilityBadge } from './availability.ts';
import { appOfPath, blockingLock, isAdmin, refuseLocked } from './locks.ts';
import { appAllowed, loadWorkspaces, workspaceMenu } from './workspaces.ts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { readFileSync } from 'node:fs';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { documentShell } from '../layout.ts';
import { getSession, saveState, takeFlash, type Session } from '../session.ts';
import { SQL_TOOLS, TOOL_GROUPS } from './sql-tools.ts';
import { ensureDevbar } from '../runtime/devbar.ts';
import { noteChange } from './app-updates.ts';

// Shared building blocks of the builder UI.

export const BASE = '/builder';
/** (sprint 86) The page designer's address: the application's id and the page's number (/builder/pages/:id redirects here). */
export const designerUrl = (appId: number, pageNo: number, query = '') => `${BASE}/apps/${appId}/pages/${pageNo}${query ? `?${query}` : ''}`;

/** pgkiln's version and the database name, for the builder's status bar. */
const VERSION = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
const DATABASE = (() => {
  try {
    return decodeURIComponent(new URL(process.env.DATABASE_URL ?? '').pathname.slice(1)) || 'pgkiln';
  } catch {
    return 'pgkiln';
  }
})();

export type Body = Record<string, string | undefined>;
export type Req = FastifyRequest<{ Params: Record<string, string>; Body: Body; Querystring: Record<string, string> }>;

// ------------------------------------------------------------------ helpers

export function flash(s: Session, message: string, kind: 'ok' | 'error' = 'ok') {
  s.state[kind === 'ok' ? '__FLASH' : '__ERROR'] = message;
}

export async function back(reply: FastifyReply, s: Session, to: string) {
  await saveState(s);
  return reply.redirect(to, 303);
}

/** Send a builder page; persists the session because shell() consumed its flash messages. */
export async function send(reply: FastifyReply, s: Session, body: string) {
  await saveState(s);
  return reply.type('text/html').send(body);
}

export type Section = 'home' | 'apps' | 'users' | 'sql' | 'developers' | 'gallery' | 'reporter' | 'team';

// ------------------------------------------------------------------ builder head
// Builder-only stylesheets and scripts, loaded on every builder page after
// app.css / app.js (the runtime never loads them). Add new builder assets
// here, and only here.
export const BUILDER_STYLES = ['/static/builder.css', '/static/code-editor.css', '/static/worksheet.css', '/static/data-modeler.css'];
export const BUILDER_SCRIPTS = ['/static/builder.js', '/static/code-editor.js', '/static/worksheet.js', '/static/palette.js', '/static/data-modeler.js', '/static/sql-monitor.js'];
export const builderHead = () =>
  html`${BUILDER_STYLES.map((href) => html`<link rel="stylesheet" href="${href}">\n`)}${BUILDER_SCRIPTS.map((src) => html`<script src="${src}" defer></script>\n`)}`;

/** Builder-only icons (public/builder-icons.svg); other names come from the shared sprite. */
export const BUILDER_ICONS = [
  'builder', 'back', 'down', 'up', 'left', 'right', 'undo', 'redo', 'zoom-in', 'zoom-out', 'expand', 'help', 'wrench',
  'region', 'item', 'button', 'grip', 'arrow-up', 'arrow-down', 'narrow', 'wide', 'sun', 'moon', 'monitor',
  'rendering', 'processing', 'shapes', 'save', 'dots', 'pages', 'kiln',
] as const;
export function bicon(name: string, cls = 'icon') {
  if (!(BUILDER_ICONS as readonly string[]).includes(name)) return icon(name, cls);
  return html`<svg class="${cls}" aria-hidden="true" focusable="false"><use href="/static/builder-icons.svg#b-${name}"></use></svg>`;
}
/** (sprint 105) the pgkiln brand mark (an ember flame) for the rail and the sign-in pages. */
export const brandMark = () => bicon('kiln');

// ------------------------------------------------------------------ theme
// The builder's own light/dark choice (separate from the runtime's): kept in
// the session and in a cookie, so it survives signing out. Dark by default.
export type BuilderTheme = 'dark' | 'light' | 'auto';
export const THEME_COOKIE = 'pgkiln_btheme';
export const builderTheme = (s: Session): BuilderTheme => {
  const t = s.state.__BTHEME;
  return t === 'light' || t === 'auto' ? t : 'dark';
};
export const validTheme = (t: unknown): BuilderTheme | null => (t === 'dark' || t === 'light' || t === 'auto' ? t : null);

// ------------------------------------------------------------------ chrome
export interface ShellOpts {
  /** right-hand side of the top toolbar (page designer: page switcher, undo, create, run…) */
  toolbar?: Raw | '';
  /** a full-viewport workspace (the page designer) instead of a scrolling document */
  full?: boolean;
}

const initials = (name: string) => name.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';

/**
 * A builder page: the icon rail on the left (App Builder, SQL Workshop, Search;
 * Administration, Help, the developer's menu), an environment banner (091), a compact toolbar with
 * back button and breadcrumb, then the page itself.
 */
export function shell(s: Session, title: string, crumbs: [string, string?][], main: Raw, section: Section = 'apps', opts: ShellOpts = {}) {
  const ok = takeFlash(s, '__FLASH');
  const err = takeFlash(s, '__ERROR');
  const theme = builderTheme(s);
  // the application these pages belong to (for the Search entry), from the breadcrumb
  const appId = crumbs.map(([, href]) => /^\/builder\/apps\/(\d+)$/.exec(href ?? '')?.[1]).find(Boolean);
  const rail = (key: Section | 'search' | 'help', href: string, ic: string, label: string, extra: Raw | '' = '') =>
    html`<li><a href="${href}" class="rail-link" title="${label}"${section === key ? raw(' aria-current="page"') : ''}${extra}>${bicon(ic)}<span class="rail-label">${label}</span></a></li>`;
  const back = [...crumbs].reverse().find(([, href], i) => i > 0 && href);
  // (sprint 74) the default-password warning: on the Workspace home (sprint 109), the App Builder home and the Developers page only, until
  // dismissed (for this sign-in); a dot on the avatar stays until the password is changed
  const weak = !!s.state.__WEAK;
  const weakBanner = weak && !s.state.__WEAK_HIDDEN && crumbs.length === 1 && (crumbs[0][0] === 'Home' || crumbs[0][0] === 'App Builder' || crumbs[0][0] === 'Developers');
  const themeButton = (t: BuilderTheme, ic: string, label: string) =>
    html`<button name="theme" value="${t}" aria-pressed="${theme === t ? 'true' : 'false'}">${bicon(ic)}<span>${label}</span></button>`;
  return documentShell(
    `${title} · Builder`,
    html`<a class="skip-link" href="#main">Skip to content</a>
    <nav class="ide-rail" aria-label="Builder">
      <a class="rail-logo" href="${BASE}/home" title="pgkiln Builder">${brandMark()}<span class="sr-only">pgkiln Builder home</span></a>
      <ul class="rail-list">
        ${rail('home', `${BASE}/home`, 'home', 'Home')}
        ${rail('apps', `${BASE}/apps`, 'builder', 'App Builder')}
        ${s.workspace?.sql_workshop === false ? '' : rail('sql', `${BASE}/sql`, 'database', 'SQL Workshop')}
        ${rail('gallery', `${BASE}/gallery`, 'package', 'App Gallery')}
        ${rail('reporter', `${BASE}/reporter`, 'pie-chart', 'Data Reporter')}
        ${rail('team', `${BASE}/team`, 'kanban', 'Team Development')}
        ${appId ? rail('search', `${BASE}/apps/${appId}/search`, 'search', 'Search this application') : ''}
      </ul>
      <ul class="rail-list rail-bottom">
        <li><details class="menu rail-user rail-admin">
          <summary class="rail-link${section === 'users' || section === 'developers' ? ' rail-open' : ''}" title="Administration"${section === 'users' || section === 'developers' ? raw(' aria-current="page"') : ''}>${icon('settings')}<span class="rail-label">Administration</span></summary>
          <div class="menu-panel">
            <div class="menu-section menu-links">
              <strong>Administration</strong>
              <a href="${BASE}/utilities">${icon('grid')} Workspace utilities</a>
            </div>
            ${s.workspace?.admin ? html`<div class="menu-section menu-links">
              <span class="small muted">Manage service: ${s.workspace.name}</span>
              <a href="${BASE}/workspaces/${s.workspace.id}#service">${icon('bell')} Workspace message and environment banner</a>
              <a href="${BASE}/workspaces/${s.workspace.id}#preferences">${icon('sliders-horizontal')} Workspace preferences</a>
              <a href="${BASE}/workspaces/${s.workspace.id}#links">${icon('external-link')} Extension links</a>
              <a href="${BASE}/workspaces/${s.workspace.id}/utilization">${icon('chart')} Workspace utilization</a>
              <a href="${BASE}/mail-queue">${icon('inbox')} Mail queue</a>
              <a href="${BASE}/network">${icon('globe')} Network access</a>
              <a href="${BASE}/workspaces/${s.workspace.id}">${icon('layers')} Workspace and developers</a>
            </div>` : ''}
            <div class="menu-section menu-links">
              <a href="${BASE}/users">${icon('user')} Manage users and groups</a>
              <a href="${BASE}/developers">${icon('users')} Developers</a>
              <a href="${BASE}/dashboard">${icon('activity')} Monitor activity</a>
              ${s.instanceAdmin ? html`<a href="${BASE}/db-users">${icon('key')} Database users</a>` : ''}
              <a href="${BASE}/developers">${icon('key')} Change my password</a>
            </div>
          </div></details></li>
        ${s.workspace?.links?.length ? html`<li><details class="menu rail-user rail-admin rail-extensions">
          <summary class="rail-link" title="Extensions">${icon('puzzle')}<span class="rail-label">Extensions</span></summary>
          <div class="menu-panel"><div class="menu-section menu-links"><strong>Extensions</strong>
            ${s.workspace.links.map((l) => html`<a href="${l.url}" target="_blank" rel="noopener noreferrer"${l.description ? html` title="${l.description}"` : ''}>${icon('external-link')} ${l.label}</a>`)}
          </div></div></details></li>` : ''}
        ${rail('help', 'https://github.com/pgkiln/pgkiln/blob/main/docs/guide/03-builder.md', 'help', 'Help', raw(' target="_blank" rel="noopener"'))}
        <li><details class="menu rail-user">
          <summary class="rail-avatar${weak ? ' has-dot' : ''}" title="${weak ? `${s.username}: change the default password` : s.username}"><span aria-hidden="true">${initials(s.username ?? '')}</span><span class="sr-only">Account: ${s.username}${weak ? ' (the default password: change it)' : ''}</span></summary>
          <div class="menu-panel">
            <div class="menu-section"><strong>${s.username}</strong><span class="muted small">Developer</span></div>
            ${weak ? html`<div class="menu-section"><a class="weak-note" href="${BASE}/developers">${icon('alert')} You use the default password: change it</a></div>` : ''}
            ${workspaceMenu(s)}
            <div class="menu-section"><span class="small muted" id="theme-label">Builder theme</span>
              <form method="post" action="${BASE}/theme" class="segmented ide-theme" role="group" aria-labelledby="theme-label">${csrf(s)}
                ${themeButton('dark', 'moon', 'Dark')}${themeButton('light', 'sun', 'Light')}${themeButton('auto', 'monitor', 'System')}
              </form></div>
            <div class="menu-section menu-links">
              <a href="${BASE}/developers">${icon('key')} Change password</a>
              <form method="post" action="${BASE}/logout">${csrf(s)}<button>${icon('logout')} Sign out</button></form>
            </div>
          </div></details></li>
      </ul>
    </nav>
    <div class="ide-main">
      <header class="ide-bar">
        ${back ? html`<a class="ide-back" href="${back[1]}" title="Back to ${back[0]}">${bicon('back')}<span class="sr-only">Back to ${back[0]}</span></a>` : ''}
        <nav class="ide-crumbs" aria-label="Breadcrumb"><ol>${crumbs.map(([label, href], i) =>
          html`<li>${href && i < crumbs.length - 1 ? html`<a href="${href}">${label}</a>` : html`<span aria-current="page">${label}</span>`}</li>`)}</ol></nav>
        <form method="get" action="${BASE}/palette" class="ide-search" role="search" data-palette>
          <label class="sr-only" for="ide-search-q">Search the builder</label>
          <input id="ide-search-q" name="q" type="search" placeholder="Search (Ctrl+K)" autocomplete="off" aria-keyshortcuts="Control+K"></form>
        <div class="ide-tools">${opts.toolbar ?? ''}</div>
      </header>
      ${s.workspace?.banner_label ? html`<div class="ide-banner ide-banner-${BANNER_COLORS.includes(s.workspace.banner_color ?? '') ? s.workspace.banner_color : 'blue'}" role="note" aria-label="Environment">${s.workspace.banner_label}</div>` : ''}
      ${weakBanner || ok || err ? html`<div class="ide-alerts">
        ${weakBanner ? html`<div class="alert alert-error alert-dismissible" role="alert"><span>You signed in with the default password. <a href="${BASE}/developers">Change it now.</a></span>
          <form method="post" action="${BASE}/weak/dismiss">${csrf(s)}<button class="link-button" aria-label="Dismiss until the next sign-in" title="Dismiss until the next sign-in">${icon('close')}</button></form></div>` : ''}
        ${ok ? html`<div class="alert alert-success" role="status">${ok}</div>` : ''}
        ${err ? html`<div class="alert alert-error" role="alert">${err}</div>` : ''}
      </div>` : ''}
      <main class="${opts.full ? 'ide-work' : 'page ide-page'}" id="main">
        ${main}
      </main>
      <footer class="ide-status">
        <span title="Signed in as">${icon('user')}${s.username}</span>
        ${s.workspace ? html`<span title="Workspace">${icon('layers')}${s.workspace.name}</span>` : ''}
        <span title="Database">${icon('database')}${DATABASE}</span>
        <span title="Builder language">en</span>
        <span class="ide-status-version">pgkiln ${VERSION}</span>
      </footer>
    </div>`,
    `builder-body ide${opts.full ? ' ide-full' : ''}`,
    {},
    builderHead(),
    { theme },
  );
}

/** (091) the colours of a workspace's environment banner (builder.css draws them) */
export const BANNER_COLORS = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'gray'];

export const csrf = (s: Session) => html`<input type="hidden" name="__csrf" value="${s.csrf_token}">`;

export function input(name: string, label: string, value: unknown, opts: { type?: string; help?: string; required?: boolean; placeholder?: string; auto?: string } = {}) {
  return html`<div class="field"><label class="label" for="f_${name}">${label}</label>
    <input id="f_${name}" name="${name}" type="${opts.type ?? 'text'}" value="${value ?? ''}"${opts.required ? raw(' required') : ''} placeholder="${opts.placeholder}"${opts.auto ? raw(` autocomplete="${opts.auto}"`) : ''}>
    ${opts.help ? html`<small class="help">${opts.help}</small>` : ''}</div>`;
}

export function select(name: string, label: string, value: unknown, options: (string | [string, string])[], help?: string) {
  return html`<div class="field"><label class="label" for="f_${name}">${label}</label>
    <select id="f_${name}" name="${name}">${options.map((o) => {
      const [v, l] = Array.isArray(o) ? o : [o, o];
      return html`<option value="${v}"${String(value ?? '') === v ? raw(' selected') : ''}>${l}</option>`;
    })}</select>${help ? html`<small class="help">${help}</small>` : ''}</div>`;
}

export const region = (title: string, body: Raw | Raw[], extra: Raw | '' = '', id = '') =>
  html`<section class="region region-standard"${id ? raw(` id="${id.replace(/[^a-z0-9-]/g, '')}"`) : ''}><header class="region-header"><h2>${title}</h2>${extra}</header><div class="region-body">${body}</div></section>`;

/** Title and tabs of an application's builder pages (Pages, Shared Components, …). */
export const appHeader = (a: any, active: 'pages' | 'shared' | 'settings' | 'activity' | 'api' | 'search' | 'advisor') => {
  const tab = (key: typeof active, href: string, ic: string, label: string) =>
    html`<a class="ide-tab" href="${href}"${active === key ? raw(' aria-current="page"') : ''}>${bicon(ic)}<span>${label}</span></a>`;
  return html`
    <div class="ide-head">
      <div class="ide-head-title"><span class="ide-app-icon" aria-hidden="true">${String(a.name ?? '?').slice(0, 1).toUpperCase()}</span>
        <div><h1>${a.name}</h1><span class="muted small">Application ${a.id} · /a/${a.alias}</span> ${availabilityBadge(a)}</div>
        <div class="buttons ide-head-actions">
          <a class="btn btn-sm" href="${BASE}/apps/${a.id}/working-copies">${icon('layers')} Working copies</a>
          <a class="btn btn-sm" href="${BASE}/apps/${a.id}/backups">${icon('history')} Backups</a>
          <a class="btn btn-sm" href="${BASE}/apps/${a.id}/availability">${icon('power')} Availability</a>
          <a class="btn btn-sm" href="${BASE}/apps/${a.id}/export">${icon('download')} Export</a>
          <a class="btn btn-sm btn-run" href="/a/${a.alias}" target="_blank" rel="noopener">${icon('play')} Run</a>
        </div></div>
      <nav class="ide-tabs" aria-label="Application">
        ${tab('pages', `${BASE}/apps/${a.id}`, 'pages', 'Pages')}
        ${tab('shared', `${BASE}/apps/${a.id}/shared`, 'shapes', 'Shared Components')}
        ${tab('activity', `${BASE}/apps/${a.id}/activity`, 'activity', 'Activity')}
        ${tab('api', `${BASE}/apps/${a.id}/api`, 'code', 'REST API')}
        ${tab('settings', `${BASE}/apps/${a.id}/settings`, 'settings', 'Settings')}
        ${tab('search', `${BASE}/apps/${a.id}/search`, 'search', 'Search')}
        ${tab('advisor', `${BASE}/apps/${a.id}/advisor`, 'check', 'Advisor')}
      </nav>
    </div>`;
};

/** Tabs of the SQL Workshop. */
export type WorkshopTab = 'home' | 'sql' | 'scripts' | 'quicksql' | 'query' | 'objects' | 'load' | 'unload' | 'sample' | 'ai' | 'ddl' | 'compare' | 'utilities' | 'charts' | 'modeler' | 'rest' | 'scheduling' | 'datapump' | 'monitor' | 'changes';
export const workshopTabs = (active: WorkshopTab) => {
  const tab = (key: string, href: string, ic: string, label: string) =>
    html`<a class="ide-tab" href="${href}"${active === key ? raw(' aria-current="page"') : ''}>${icon(ic)}<span>${label}</span></a>`;
  // (sprint 75) the main tools as tabs, the others in a More menu (the open one is a tab too), so the strip never
  // scrolls; (sprint 96) the More menu under the Launchpad's headings, from SQL_TOOLS
  const main = SQL_TOOLS.filter((t) => t.main);
  const open = SQL_TOOLS.find((t) => !t.main && t.tab === active);
  return html`<nav class="ide-tabs sw-tabs u-mb1" aria-label="SQL Workshop">
    ${tab('home', `${BASE}/sql`, 'home', 'Home')}${main.map((t) => tab(t.tab!, t.href, t.icon, t.label))}
    ${open ? tab(open.tab!, open.href, open.icon, open.label) : ''}
    <details class="menu sw-more"><summary class="ide-tab">${icon('chevron-down')}<span>More</span></summary>
      <div class="menu-panel align-right">${TOOL_GROUPS.map(([g, heading]) => {
        // administrators' tools are on the Launchpad and the Utilities page, not in every developer's menu
        const list = SQL_TOOLS.filter((t) => t.group === g && !t.main && !t.admin);
        return list.length ? html`<div class="menu-section menu-links"><span class="small muted">${heading}</span>${list.map((t) => html`<a href="${t.href}"${t.tab && t.tab === active ? raw(' aria-current="page"') : ''}>${icon(t.icon)} ${t.label}</a>`)}</div>` : '';
      })}</div></details></nav>`;
};

/** Number of app tile colours (.app-color-0 … -7 in app.css). */
export const APP_COLORS = 8;

// ------------------------------------------------------------------ auth

/**
 * A developer session of an administrator, for installation-wide sign-in settings (identity providers,
 * LDAP directories, the password policy); other developers get a 403 page. Null when refused.
 */
export async function administrator(req: Req, reply: FastifyReply, title: string) {
  const s = await developer(req, reply);
  if (!s) return null;
  if (await isAdmin(s.username)) return s;
  const main = html`<h1 class="u-mb1">${title}</h1><div class="alert alert-error" role="alert">Only administrators change ${title.toLowerCase()}: they decide who can sign in to every application.</div>`;
  await send(reply.code(403), s, shell(s, title, [['Users', `${BASE}/users`], [title]], main, 'users'));
  return null;
}

export async function developer(req: Req, reply: FastifyReply) {
  const s = await getSession(req, reply, null, BASE);
  if (!s.username) {
    reply.redirect(`${BASE}/login`);
    return null;
  }
  if (req.method === 'POST' && req.body?.__csrf !== s.csrf_token) {
    reply.code(403).send('Invalid CSRF token; reload the page and try again.');
    return null;
  }
  // (079) the developer toolbar on the applications' pages in this browser
  await ensureDevbar(req, reply, s);
  // workspaces: an application outside the developer's workspaces doesn't exist for them
  await loadWorkspaces(s);
  const target = await appOfPath(req.url);
  if (target && !(await appAllowed(s, target.appId))) {
    reply.code(404).send('Not found');
    return null;
  }
  // (093) a workspace preference may turn the SQL Workshop off
  if (s.workspace?.sql_workshop === false && /^\/builder\/sql(?:[/?]|$)/.test(req.url)) {
    await send(reply.code(403), s, shell(s, 'SQL Workshop', [['App Builder', BASE], ['SQL Workshop']],
      html`<h1>SQL Workshop</h1><div class="alert alert-info" role="status">The SQL Workshop is turned off for the workspace ${s.workspace.name}. Its administrators can turn it on in the workspace preferences${s.workspaces && s.workspaces.length > 1 ? '; or switch to another workspace' : ''}.</div>`, 'sql'));
    return null;
  }
  // a page or application locked by another developer can't be changed (locks.ts)
  if (req.method === 'POST') {
    const hit = await blockingLock(s.username, req.url);
    if (hit) {
      await refuseLocked(req, reply, s, hit);
      return null;
    }
    // (116) who changed the application last (app-updates.ts)
    noteChange(req, s as Session & { username: string }, target?.appId ?? null);
  }
  return s;
}

