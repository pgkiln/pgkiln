import { blockingLock, refuseLocked } from './locks.ts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { readFileSync } from 'node:fs';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { documentShell } from '../layout.ts';
import { getSession, saveState, takeFlash, type Session } from '../session.ts';

// Shared building blocks of the builder UI.

export const BASE = '/builder';

/** pgapex's version and the database name, for the builder's status bar. */
const VERSION = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
const DATABASE = (() => {
  try {
    return decodeURIComponent(new URL(process.env.DATABASE_URL ?? '').pathname.slice(1)) || 'pgapex';
  } catch {
    return 'pgapex';
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

export type Section = 'apps' | 'users' | 'sql' | 'developers';

// ------------------------------------------------------------------ builder head
// Builder-only stylesheets and scripts, loaded on every builder page after
// app.css / app.js (the runtime never loads them). Add new builder assets
// here, and only here.
export const BUILDER_STYLES = ['/static/builder.css', '/static/code-editor.css'];
export const BUILDER_SCRIPTS = ['/static/builder.js', '/static/code-editor.js'];
export const builderHead = () =>
  html`${BUILDER_STYLES.map((href) => html`<link rel="stylesheet" href="${href}">\n`)}${BUILDER_SCRIPTS.map((src) => html`<script src="${src}" defer></script>\n`)}`;

/** Builder-only icons (public/builder-icons.svg); other names come from the shared sprite. */
export const BUILDER_ICONS = [
  'builder', 'back', 'down', 'up', 'left', 'right', 'undo', 'redo', 'zoom-in', 'zoom-out', 'expand', 'help', 'wrench',
  'region', 'item', 'button', 'grip', 'arrow-up', 'arrow-down', 'narrow', 'wide', 'sun', 'moon', 'monitor',
  'rendering', 'processing', 'shapes', 'save', 'dots', 'pages',
] as const;
export function bicon(name: string, cls = 'icon') {
  if (!(BUILDER_ICONS as readonly string[]).includes(name)) return icon(name, cls);
  return html`<svg class="${cls}" aria-hidden="true" focusable="false"><use href="/static/builder-icons.svg#b-${name}"></use></svg>`;
}

// ------------------------------------------------------------------ theme
// The builder's own light/dark choice (separate from the runtime's): kept in
// the session and in a cookie, so it survives signing out. Dark by default.
export type BuilderTheme = 'dark' | 'light' | 'auto';
export const THEME_COOKIE = 'pgapex_btheme';
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
 * A builder page: the icon rail on the left (App Builder, SQL Workshop, Users,
 * Developers, Search, Help, the developer's menu), a compact toolbar with
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
  const themeButton = (t: BuilderTheme, ic: string, label: string) =>
    html`<button name="theme" value="${t}" aria-pressed="${theme === t ? 'true' : 'false'}">${bicon(ic)}<span>${label}</span></button>`;
  return documentShell(
    `${title} · Builder`,
    html`<a class="skip-link" href="#main">Skip to content</a>
    <nav class="ide-rail" aria-label="Builder">
      <a class="rail-logo" href="${BASE}" title="pgapex Builder"><span aria-hidden="true">pg</span><span class="sr-only">pgapex Builder home</span></a>
      <ul class="rail-list">
        ${rail('apps', BASE, 'builder', 'App Builder')}
        ${rail('sql', `${BASE}/sql`, 'database', 'SQL Workshop')}
        ${rail('users', `${BASE}/users`, 'user', 'Users')}
        ${rail('developers', `${BASE}/developers`, 'users', 'Developers')}
        ${appId ? rail('search', `${BASE}/apps/${appId}/search`, 'search', 'Search this application') : ''}
      </ul>
      <ul class="rail-list rail-bottom">
        ${rail('help', 'https://github.com/NickVrgr/Postgresql_APEX/blob/main/docs/guide/03-builder.md', 'help', 'Help', raw(' target="_blank" rel="noopener"'))}
        <li><details class="menu rail-user">
          <summary class="rail-avatar" title="${s.username}"><span aria-hidden="true">${initials(s.username ?? '')}</span><span class="sr-only">Account: ${s.username}</span></summary>
          <div class="menu-panel">
            <div class="menu-section"><strong>${s.username}</strong><span class="muted small">Developer</span></div>
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
        <div class="ide-tools">${opts.toolbar ?? ''}</div>
      </header>
      ${s.state.__WEAK || ok || err ? html`<div class="ide-alerts">
        ${s.state.__WEAK ? html`<div class="alert alert-error" role="alert">You signed in with the default password. <a href="${BASE}/developers">Change it now.</a></div>` : ''}
        ${ok ? html`<div class="alert alert-success" role="status">${ok}</div>` : ''}
        ${err ? html`<div class="alert alert-error" role="alert">${err}</div>` : ''}
      </div>` : ''}
      <main class="${opts.full ? 'ide-work' : 'page ide-page'}" id="main">
        ${main}
      </main>
      <footer class="ide-status">
        <span title="Signed in as">${icon('user')}${s.username}</span>
        <span title="Database">${icon('database')}${DATABASE}</span>
        <span title="Builder language">en</span>
        <span class="ide-status-version">pgapex ${VERSION}</span>
      </footer>
    </div>`,
    `builder-body ide${opts.full ? ' ide-full' : ''}`,
    {},
    builderHead(),
    { theme },
  );
}

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
        <div><h1>${a.name}</h1><span class="muted small">Application ${a.id} · /a/${a.alias}</span></div>
        <div class="buttons ide-head-actions">
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
export const workshopTabs = (active: 'sql' | 'objects' | 'load') => html`<nav class="ide-tabs u-mb1" aria-label="SQL Workshop">
    <a class="ide-tab" href="${BASE}/sql"${active === 'sql' ? raw(' aria-current="page"') : ''}>${icon('code')}<span>SQL Commands</span></a>
    <a class="ide-tab" href="${BASE}/sql/objects"${active === 'objects' ? raw(' aria-current="page"') : ''}>${icon('database')}<span>Object Browser</span></a>
    <a class="ide-tab" href="${BASE}/sql/load"${active === 'load' ? raw(' aria-current="page"') : ''}>${icon('upload')}<span>Load Data</span></a></nav>`;

/** Number of app tile colours (.app-color-0 … -7 in app.css). */
export const APP_COLORS = 8;

// ------------------------------------------------------------------ auth

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
  // a page or application locked by another developer can't be changed (locks.ts)
  if (req.method === 'POST') {
    const hit = await blockingLock(s.username, req.url);
    if (hit) {
      await refuseLocked(req, reply, s, hit);
      return null;
    }
  }
  return s;
}

