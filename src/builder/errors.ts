import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { html } from '../html.ts';
import { documentShell } from '../layout.ts';
import { BASE, shell, THEME_COOKIE, validTheme } from './ui.ts';
import { cookieLanguage, setRequestTranslator, tr, translatorFor } from './i18n.ts';
import { getSession } from '../session.ts';
import { loadLanguage } from './language.ts';
import { loadWorkspaces } from './workspaces.ts';
import { recentApps } from './home.ts';

// (sprint 86) The builder's error pages: a browser that opens an address under /builder that
// doesn't exist (or an application or page that doesn't, or not for this developer), or that
// meets a server error, gets an HTML page in the builder's theme with a way back, instead of
// JSON or plain text. Requests from scripts (fetch, the layout canvas) keep their plain answers.

/** A browser's navigation (it asks for HTML), not a script's request. */
export const wantsHtml = (req: FastifyRequest) =>
  (req.method === 'GET' || req.method === 'HEAD') && /\btext\/html\b/.test(String(req.headers.accept ?? '')) && req.headers['x-requested-with'] === undefined;

const isBuilder = (url: string) => url === BASE || url.startsWith(`${BASE}/`) || url.startsWith(`${BASE}?`);

/** The error page for a status (404, or 500 for any server error), in the builder language of this device (i18n.ts). */
export function builderErrorPage(req: FastifyRequest, status: number) {
  const tx = translatorFor(cookieLanguage(req));
  const server = status >= 500;
  const title = tx(server ? 'error.server_title' : 'error.not_found_title');
  const theme = validTheme((req.cookies as Record<string, string> | undefined)?.[THEME_COOKIE]) ?? 'auto';
  return documentShell(
    `${title} · ${tx('rail.app_builder')}`,
    html`<main class="t-error" id="main"><div class="card"><h1>${title}</h1><p>${tx(server ? 'error.server_text' : 'error.not_found_text')}</p>
      <p class="muted">${tx(server ? 'error.label_error' : 'error.label_not_found')}: <code>${req.url.split('?')[0].slice(0, 200)}</code></p>
      <p><a class="btn btn-hot" href="${BASE}">${tx('error.home')}</a></p></div></main>`,
    'login-body',
    {},
    '',
    { theme, lang: tx.lang },
  );
}

/** "/builder/apps/new?x" → "apps new": the words of an address, for the search field of the page */
export const searchFromPath = (url: string) =>
  url.split(/[?#]/)[0].slice(BASE.length).split('/').map((w) => { try { return decodeURIComponent(w); } catch { return w; } })
    .filter((w) => w && !/^\d+$/.test(w)).join(' ').replace(/[^\p{L}\p{N} _.-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

/**
 * (UX-10) "Page not found" for a signed-in developer: inside the builder's frame (rail, header search, status bar),
 * with a search field filled from the address and the recent applications. The session is only read: nothing is
 * saved, so a waiting message stays for the next page. Null: not signed in (the standalone page then).
 */
export async function framedNotFound(req: FastifyRequest, reply: FastifyReply) {
  const s = await getSession(req, reply, null, BASE, { touch: false }).catch(() => null);
  if (!s?.username) return null;
  if (s.state.__BLANG === undefined) await loadLanguage(s);
  const tx = tr(s);
  setRequestTranslator(tx);
  await loadWorkspaces(s);
  s.path = req.url;
  const title = tx('error.not_found_title');
  const recent = await recentApps(s).catch(() => []);
  const main = html`<div class="ab-narrow nf-page">
    <h1>${title}</h1>
    <p>${tx('error.not_found_text')}</p>
    <p class="muted">${tx('error.label_not_found')}: <code>${req.url.split('?')[0].slice(0, 200)}</code></p>
    <form method="get" action="${BASE}/palette" class="search nf-search" role="search">
      <label class="sr-only" for="nf-q">${tx('bar.search_label')}</label>
      <input id="nf-q" type="search" name="q" value="${searchFromPath(req.url)}" autofocus><button class="btn">${tx('common.search')}</button></form>
    ${recent.length ? html`<h2>${tx('ab.recent')}</h2><ul class="ab-links">${recent.map((a) => html`<li><a href="${BASE}/apps/${a.id}">${a.name}</a></li>`)}</ul>` : ''}
    <p><a class="btn btn-hot" href="${BASE}">${tx('error.home')}</a></p>
  </div>`;
  return shell(s, title, [[title]], main);
}

const sendPage = async (req: FastifyRequest, reply: FastifyReply, status: number) =>
  reply.code(status).type('text/html; charset=utf-8').header('cache-control', 'no-store')
    .send((status === 404 && (await framedNotFound(req, reply))) || builderErrorPage(req, status));

/**
 * The hooks (registered on the root instance): unknown builder addresses, the builder's own
 * "Not found" answers and server errors become HTML pages for browsers.
 */
export function builderErrorPages(app: FastifyInstance) {
  app.setNotFoundHandler((req, reply) => {
    if (isBuilder(req.url) && wantsHtml(req)) return sendPage(req, reply, 404);
    return reply.code(404).send({ message: `Route ${req.method}:${req.url} not found`, error: 'Not Found', statusCode: 404 });
  });
  // a route's own plain "Not found" (an id that doesn't exist, another workspace's application)
  app.addHook('onSend', async (req, reply, payload) => {
    if (reply.statusCode !== 404 || !isBuilder(req.url) || !wantsHtml(req)) return payload;
    if (!/^text\/plain\b/.test(String(reply.getHeader('content-type') ?? ''))) return payload;
    reply.type('text/html; charset=utf-8');
    return (await framedNotFound(req, reply)) || builderErrorPage(req, 404);
  });
}

/** For the root error handler: a server error on a builder page a browser opened, as HTML (true: sent). */
export function builderServerError(req: FastifyRequest, reply: FastifyReply, err: Error & { statusCode?: number }) {
  if (!isBuilder(req.url) || !wantsHtml(req) || (err.statusCode !== undefined && err.statusCode < 500)) return false;
  req.log.error(err);
  reply.code(500).type('text/html; charset=utf-8').header('cache-control', 'no-store').send(builderErrorPage(req, 500));
  return true;
}
