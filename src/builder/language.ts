import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { owner } from '../db.ts';
import { html, raw } from '../html.ts';
import { icon } from '../icons.ts';
import type { Session } from '../session.ts';
import { BUILDER_LANGUAGES, LANG_COOKIE, tr, validBuilderLanguage, type BuilderLang } from './i18n.ts';
import { back, BASE, csrf, developer, type Req } from './ui.ts';

// (sprint 121, WS-7) Choosing the builder's language (APEX: the language links of the builder).
//  - Signed in: the language menu in the status bar (footer) of every builder page posts to /builder/language
//    (CSRF-checked); the choice is stored for the developer (meta.developer.language, migration 127) and in the
//    session, so it holds in every later session and on every device.
//  - Signed out: the sign-in page's language links (GET /builder/login?lang=de) set a cookie only (LANG_COOKIE),
//    for the sign-in page; signing in after such a link stores it for the developer (routes.ts).
// Only the codes of BUILDER_LANGUAGES are accepted; anything else is ignored (a link) or refused (400, the menu).
// Nothing here may run at import time: ui.ts imports this module and this module imports ui.ts.

export const langCookieOptions = () => ({ path: BASE, httpOnly: true, sameSite: 'lax' as const, maxAge: 365 * 24 * 3600, secure: process.env.COOKIE_SECURE === 'true' });

/** Put the developer's stored language into a session that has none yet (a session from before this sprint). */
export async function loadLanguage(s: Session) {
  if (!s.username) return;
  const r = await owner.one<{ language: string | null }>('select language from meta.developer where username = $1', [s.username]);
  s.state.__BLANG = validBuilderLanguage(r?.language) ?? 'en';
}

/** Store a developer's choice (and set it for this session and the sign-in page of this device). */
export async function chooseLanguage(reply: FastifyReply, s: Session, lang: BuilderLang) {
  await owner.query('update meta.developer set language = $2 where username = $1', [s.username, lang]);
  s.state.__BLANG = lang;
  reply.setCookie(LANG_COOKIE, lang, langCookieOptions());
}

/** The language menu of the builder's status bar: a <details> menu of buttons in a form (no script needed). */
export function languageMenu(s: Session) {
  const tx = tr(s);
  return html`<details class="menu ide-lang" data-lang-menu>
    <summary title="${tx('status.language')}">${icon('globe')}<span class="sr-only">${tx('status.language')}: </span><span lang="${tx.lang}">${BUILDER_LANGUAGES.find(([c]) => c === tx.lang)![1]}</span></summary>
    <div class="menu-panel">
      <form method="post" action="${BASE}/language" class="menu-section menu-links ide-lang-form" aria-label="${tx('status.language')}">${csrf(s)}
        <span class="small muted">${tx('status.language')}</span>
        ${BUILDER_LANGUAGES.map(([code, name]) => html`<button name="language" value="${code}" lang="${code}"${code === tx.lang ? raw(' aria-current="true"') : ''}>${code === tx.lang ? icon('check') : html`<span class="ide-lang-pad" aria-hidden="true"></span>`}${name}</button>`)}
      </form>
    </div></details>`;
}

/** The sign-in page's language links (APEX: Deutsch, English, Español, …), keeping where to go after signing in. */
export function signInLanguageLinks(current: BuilderLang, next: string, label: string) {
  return html`<nav class="signin-langs" aria-label="${label}"><ul>${BUILDER_LANGUAGES.map(([code, name]) => {
    const q = new URLSearchParams({ lang: code, ...(next !== `${BASE}/home` ? { next } : {}) });
    return html`<li><a href="${BASE}/login?${q}" lang="${code}" hreflang="${code}"${code === current ? raw(' aria-current="true"') : ''}>${name}</a></li>`;
  })}</ul></nav>`;
}

/** A builder address on this host to go back to (the referring page), else the App Builder. */
const backTo = (req: FastifyRequest) => {
  try {
    const u = new URL(String(req.headers.referer ?? ''));
    return u.host === req.headers.host && u.pathname.startsWith(BASE) ? u.pathname + u.search : BASE;
  } catch {
    return BASE;
  }
};

export async function languageRoutes(app: FastifyInstance) {
  app.post(`${BASE}/language`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const lang = validBuilderLanguage(req.body?.language);
    if (!lang) return reply.code(400).send('Unknown language');
    await chooseLanguage(reply, s, lang);
    return back(reply, s, backTo(req));
  });
}
