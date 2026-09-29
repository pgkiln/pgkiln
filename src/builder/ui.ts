import type { FastifyReply, FastifyRequest } from 'fastify';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { documentShell } from '../layout.ts';
import { getSession, saveState, takeFlash, type Session } from '../session.ts';

// Shared building blocks of the builder UI.

export const BASE = '/builder';

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

export function shell(s: Session, title: string, crumbs: [string, string?][], main: Raw, section: Section = 'apps') {
  const ok = takeFlash(s, '__FLASH');
  const err = takeFlash(s, '__ERROR');
  const navLink = (key: Section, href: string, ic: string, label: string) =>
    html`<a href="${href}"${section === key ? raw(' aria-current="page"') : ''}>${icon(ic)}<span>${label}</span></a>`;
  return documentShell(
    `${title} · Builder`,
    html`<header class="topbar builder">
      <a class="brand" href="${BASE}">pgapex <span class="badge">Builder</span></a>
      <nav class="nav" aria-label="Builder">
        ${navLink('apps', BASE, 'grid', 'App Builder')}
        ${navLink('users', `${BASE}/users`, 'user', 'Users')}
        ${navLink('sql', `${BASE}/sql`, 'database', 'SQL Workshop')}
        ${navLink('developers', `${BASE}/developers`, 'users', 'Developers')}
      </nav>
      <div class="user"><span>${s.username}</span>
        <form method="post" action="${BASE}/logout">${csrf(s)}<button class="link-button plain" style="color:inherit">${icon('logout')}<span class="sr-only">Sign out</span></button></form>
      </div>
    </header>
    <main class="page" id="main">
      ${crumbs.length > 1 ? html`<nav class="crumbs-bar" aria-label="Breadcrumb">${crumbs.map(([label, href], i) =>
        html`${i ? ' / ' : ''}${href ? html`<a href="${href}">${label}</a>` : html`<span>${label}</span>`}`)}</nav>` : ''}
      ${s.state.__WEAK ? html`<div class="alert alert-error" role="alert">You signed in with the default password. <a href="${BASE}/developers">Change it now.</a></div>` : ''}
      ${ok ? html`<div class="alert alert-success" role="status">${ok}</div>` : ''}
      ${err ? html`<div class="alert alert-error" role="alert">${err}</div>` : ''}
      ${main}
    </main>`,
    'builder-body',
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

export const region = (title: string, body: Raw | Raw[], extra: Raw | '' = '') =>
  html`<section class="region region-standard"><header class="region-header"><h2>${title}</h2>${extra}</header><div class="region-body">${body}</div></section>`;

export const APP_COLORS = ['#0b63c5', '#17794a', '#b3261e', '#7a4cc2', '#b86e00', '#00796b', '#5c6bc0', '#8d6e63'];

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
  return s;
}

