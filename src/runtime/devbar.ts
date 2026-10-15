// Developer toolbar (APEX: Runtime Developer Toolbar) and session state
// viewer (APEX: Session → View session state), migration 079.
//
// A builder session hands the browser a second random token in the cookie
// pgkiln_devbar (path /a, HttpOnly, SameSite=Lax); the database keeps its
// sha256 on the builder session (meta.session.devbar_hash). A page of an
// application shows the toolbar when that token belongs to a live builder
// session of a developer who may open the application (an administrator, or
// a member of its workspace). The token does nothing else: it is not the
// builder session's token, and every builder request still needs that one.
//
// The toolbar links to the App Builder, the application and the page in the
// Page Designer, (sprint 59) Quick edit: click a region, item or button of the
// page to open it in the Page Designer (app.js; GET /builder/pages/:id/quick), shows the session state (GET /a/:alias/:page/devbar/session),
// clears the page's items, and switches debug messages on for this session
// only (POST …/devbar/debug; meta.session.state.__DEBUG_LEVEL, read by
// loadContext).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { owner, runtime } from '../db.ts';
import { DEBUG_LEVELS } from '../debug.ts';
import { html, raw, type Raw } from '../html.ts';
import { hashToken, newToken } from '../security.ts';
import { saveState, sessionLimits, type Session } from '../session.ts';
import { documentShell } from '../layout.ts';
import { icon } from '../icons.ts';
import type { PageContext } from './context.ts';

export const DEVBAR_COOKIE = 'pgkiln_devbar';
const COOKIE_PATH = '/a';
const BUILDER = '/builder';
/** The session state key of the session's own debug level. */
export const SESSION_DEBUG = '__DEBUG_LEVEL';

export interface Devbar {
  username: string;
}

/** Builder: give the browser a toolbar token for this developer session (when it has none that matches). */
export async function ensureDevbar(req: FastifyRequest, reply: FastifyReply, s: Session) {
  if (!s.username) return;
  const token = req.cookies[DEVBAR_COOKIE];
  if (token && token.length <= 100 && s.devbar_hash && hashToken(token) === s.devbar_hash) return;
  const fresh = newToken();
  s.devbar_hash = hashToken(fresh);
  await runtime.query('update meta.session set devbar_hash = $2 where id = $1 and app_id is null', [s.id, s.devbar_hash]);
  reply.setCookie(DEVBAR_COOKIE, fresh, { path: COOKIE_PATH, httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true' });
}

/** Builder sign-out: the toolbar goes with the session. */
export function clearDevbar(reply: FastifyReply) {
  reply.clearCookie(DEVBAR_COOKIE, { path: COOKIE_PATH });
}

/** The developer whose live builder session the request's toolbar token belongs to, if they may open this application. */
export async function devbarOf(req: FastifyRequest, appId: number): Promise<Devbar | null> {
  const token = req.cookies?.[DEVBAR_COOKIE];
  if (!token || token.length > 100) return null;
  const { idleMinutes, maxHours } = sessionLimits();
  const row = await owner.one<{ username: string }>(
    `select s.username from meta.session s
      where s.devbar_hash = $1 and s.app_id is null and s.username is not null
        and s.last_seen > now() - make_interval(mins => $2) and s.created_at > now() - make_interval(hours => $3)
        and exists (select 1 from meta.developer d where d.username = s.username
                     and (d.is_admin or exists (select 1 from meta.workspace_member m
                                                 where m.username = d.username and m.workspace_id = meta.app_workspace($4))))`,
    [hashToken(token), idleMinutes, maxHours, appId],
  );
  return row ? { username: row.username } : null;
}

/** The session's own debug level (0: none), set from the toolbar. */
export const sessionDebugLevel = (s: Session) => {
  const n = Number(s.state[SESSION_DEBUG] ?? 0);
  return DEBUG_LEVELS.some(([level]) => level === n) ? n : 0;
};

/**
 * The toolbar (not in dialogs): (sprint 72) a compact bar of icons with tooltips,
 * centred at the bottom like APEX's. Debug, Info and Settings open small panels
 * (<details>, so they work without JavaScript). With JavaScript (app.js) the bar
 * shrinks to a slim tab after a few seconds without use and can be docked at the
 * top, left or right (Settings; kept in the browser).
 */
export function devbarHtml(ctx: PageContext): Raw | '' {
  if (!ctx.devbar || ctx.dialog) return '';
  const level = sessionDebugLevel(ctx.session);
  const appLevel = Number(ctx.app.debug_level ?? 0);
  const page = ctx.page.page_no;
  // (sprint 79, UI-4; APEX: App 77536, Page 8, Debug ⏻) each tool with a short text; "Icons only" in Settings
  const text = (s: string) => html`<span class="devbar-text" aria-hidden="true">${s}</span>`;
  const tool = (href: string, label: string, name: string, short: string) =>
    html`<li><a class="devbar-tool" href="${href}" title="${label}" aria-label="${label}">${icon(name)}${text(short)}</a></li>`;
  const menu = (label: string, name: string, cls: string, body: Raw, hidden = false, short = label) =>
    html`<li${hidden ? raw(' hidden') : ''}><details class="devbar-menu ${cls}"><summary class="devbar-tool" title="${label}" aria-label="${label}">${icon(name)}${text(short)}</summary>
      <div class="devbar-pop" role="group" aria-label="${label}">${body}</div></details></li>`;
  return html`<div class="devbar" data-dock="bottom">
    <nav aria-label="Developer toolbar"><ul class="devbar-tools">
      ${tool(BUILDER, 'App Builder', 'home', 'Home')}
      ${tool(`${BUILDER}/apps/${ctx.app.id}`, `Application ${ctx.app.id}`, 'grid', `App ${ctx.app.id}`)}
      ${tool(`${BUILDER}/apps/${ctx.app.id}/pages/${page}`, `Edit page ${page}`, 'edit', `Page ${page}`)}
      ${tool(`${ctx.base}/${page}/devbar/session`, 'Session', 'database', 'Session')}
      ${menu(`Debug: ${level || appLevel ? 'on' : 'off'}`, 'bolt', `devbar-debug-menu${level || appLevel ? ' is-on' : ''}`, html`<form method="post" action="${ctx.base}/${page}/devbar/debug" class="devbar-debug">
        <input type="hidden" name="__csrf" value="${ctx.session.csrf_token}">
        <label for="devbar-debug">Debug messages</label>
        <select id="devbar-debug" name="level">${DEBUG_LEVELS.map(([n, label]) =>
          html`<option value="${n}"${n === level ? raw(' selected') : ''}>${n === 0 ? (appLevel ? `Application (${appLevel})` : 'Off') : label}</option>`)}</select>
        <button>Set</button>
      </form>${level || appLevel ? html`<a href="${BUILDER}/apps/${ctx.app.id}/debug">View debug</a>` : ''}`, false, `Debug ${level || appLevel ? 'on' : 'off'}`)}
      <li><button type="button" class="devbar-tool devbar-quick" data-quick-edit="${BUILDER}/pages/${ctx.page.id}" aria-pressed="false" title="Quick edit" aria-label="Quick edit" hidden>${icon('scan')}${text('Quick edit')}</button></li>
      ${tool(`${BUILDER}/apps/${ctx.app.id}/theme`, 'Customize (Theme Roller)', 'sliders', 'Customize')}
      ${menu('Info', 'info', 'devbar-info', html`<dl class="devbar-facts">
        <dt>Application</dt><dd>${ctx.app.name} (${ctx.app.id})</dd>
        <dt>Page</dt><dd>${page}: ${ctx.page.name}</dd>
        <dt>User</dt><dd>${ctx.user ?? 'nobody'}</dd>
        <dt>Developer</dt><dd>${ctx.devbar.username}</dd>
      </dl>`)}
      ${menu('Settings', 'settings', 'devbar-settings', html`<fieldset class="devbar-dock"><legend>Position</legend>
        ${(['bottom', 'top', 'left', 'right'] as const).map((d) => html`<label><input type="radio" name="devbar-dock" value="${d}"${d === 'bottom' ? raw(' checked') : ''}> ${d[0].toUpperCase() + d.slice(1)}</label>`)}
      </fieldset>
      <label class="devbar-autohide"><input type="checkbox" name="devbar-autohide" checked> Hide when not used</label>
      <label class="devbar-autohide"><input type="checkbox" name="devbar-compact"> Icons only</label>`, true)}
    </ul></nav>
  </div>`;
}

const INTERNAL = /^__/;

/** Session state viewer and the toolbar's actions. */
export function devbarRoutes(app: FastifyInstance, loadContext: (req: any, reply: FastifyReply) => Promise<PageContext | null>) {
  const developerContext = async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = await loadContext(req, reply);
    if (!ctx) return null;
    if (!ctx.devbar) {
      reply.code(404).type('text/plain').send('Not found');
      return null;
    }
    return ctx;
  };

  app.get('/a/:alias/:page/devbar/session', async (req, reply) => {
    const ctx = await developerContext(req, reply);
    if (!ctx) return;
    const state = ctx.session.state;
    const show = (name: string, type?: string) => {
      const v = state[name];
      if (v === undefined || v === null) return html`<span class="muted">(null)</span>`;
      if (type === 'password') return html`<span class="muted">(set, not shown)</span>`;
      return html`<code>${v.length > 2000 ? `${v.slice(0, 2000)}…` : v}</code>`;
    };
    const pageItems = ctx.page.items.map((i) => i.name);
    const known = new Set([...pageItems, ...ctx.app.app_items]);
    const others = Object.keys(state).filter((k) => !INTERNAL.test(k) && !known.has(k)).sort();
    const table = (rows: Raw[], cols: string[]) =>
      rows.length
        ? html`<div class="table-wrap"><table class="report"><thead><tr>${cols.map((c) => html`<th scope="col">${c}</th>`)}</tr></thead><tbody>${rows}</tbody></table></div>`
        : html`<p class="muted">None.</p>`;
    const body = html`<main class="t-main devbar-session" id="main">
      <div class="t-titlebar"><h1>Session state</h1></div>
      <div class="t-content">
        <p><a href="${ctx.base}/${ctx.page.page_no}">Back to page ${ctx.page.page_no}</a></p>
        <dl class="devbar-facts">
          <dt>Application</dt><dd>${ctx.app.name} (${ctx.app.alias}, ${ctx.app.id})</dd>
          <dt>User</dt><dd>${ctx.user}</dd>
          <dt>Roles</dt><dd>${ctx.roles.join(', ') || '–'}</dd>
          <dt>Session</dt><dd><code>${ctx.session.id}</code></dd>
          <dt>Language</dt><dd>${ctx.locale.lang}</dd>
          <dt>Time zone</dt><dd>${ctx.locale.timeZone ?? '–'}</dd>
          <dt>Debug</dt><dd>${sessionDebugLevel(ctx.session) ? `level ${sessionDebugLevel(ctx.session)} for this session` : Number(ctx.app.debug_level) ? `level ${ctx.app.debug_level} (application)` : 'off'}</dd>
        </dl>
        <h2>Page ${ctx.page.page_no}: ${ctx.page.name}</h2>
        ${table(ctx.page.items.map((i) => html`<tr><td><code>${i.name}</code></td><td>${i.type}</td><td>${show(i.name, i.type)}</td></tr>`), ['Item', 'Type', 'Value'])}
        <form method="post" action="${ctx.base}/${ctx.page.page_no}/devbar/clear">
          <input type="hidden" name="__csrf" value="${ctx.session.csrf_token}">
          <button class="btn">Clear the items of page ${ctx.page.page_no}</button>
        </form>
        <h2>Application items</h2>
        ${table(ctx.app.app_items.map((n) => html`<tr><td><code>${n}</code></td><td>${show(n)}</td></tr>`), ['Item', 'Value'])}
        <h2>Other values (items of other pages)</h2>
        ${table(others.map((n) => html`<tr><td><code>${n}</code></td><td>${show(n)}</td></tr>`), ['Name', 'Value'])}
      </div>
    </main>`;
    return reply.type('text/html').send(
      documentShell(`Session state · ${ctx.app.name}`, body, 't-app devbar-page', { 'data-base': ctx.base }, '', {
        lang: 'en', dir: 'ltr', theme: ctx.locale.theme, style: ctx.locale.style,
      }),
    );
  });

  app.post('/a/:alias/:page/devbar/clear', async (req: any, reply) => {
    const ctx = await developerContext(req, reply);
    if (!ctx) return;
    if (req.body?.__csrf !== ctx.session.csrf_token) return reply.code(403).type('text/plain').send('Invalid CSRF token');
    for (const i of ctx.page.items) delete ctx.session.state[i.name];
    await saveState(ctx.session);
    return reply.redirect(`${ctx.base}/${ctx.page.page_no}/devbar/session`, 303);
  });

  app.post('/a/:alias/:page/devbar/debug', async (req: any, reply) => {
    const ctx = await developerContext(req, reply);
    if (!ctx) return;
    if (req.body?.__csrf !== ctx.session.csrf_token) return reply.code(403).type('text/plain').send('Invalid CSRF token');
    const level = Number(req.body?.level);
    if (level && DEBUG_LEVELS.some(([n]) => n === level)) ctx.session.state[SESSION_DEBUG] = String(level);
    else delete ctx.session.state[SESSION_DEBUG];
    await saveState(ctx.session);
    return reply.redirect(`${ctx.base}/${ctx.page.page_no}`, 303);
  });
}
