import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { passwordProblem } from '../accounts.ts';
import { runtime } from '../db.ts';
import { html, type Raw } from '../html.ts';
import { documentShell } from '../layout.ts';
import type { App } from '../metadata.ts';
import { clientIp, getSession, logActivity, saveState, type Session } from '../session.ts';
import { publicUrl } from '../sso.ts';
import type { Locale } from './locale.ts';
import { pwaHead } from './pwa.ts';
import { appWithLocale, rootAttrs, simplePage, type Req } from './routes.ts';
import { passwordResetAvailable } from './signin.ts';

// "Forgot password?" for app users (migration 087). The request answers the
// same whether or not an account matched; the database keeps only a SHA-256
// hash of the token and queues the mail through the application's mail
// service (meta.request_password_reset). The link is single-use and expires
// after 30 minutes; opening it moves the token into the session and drops
// it from the address bar. Setting the new password ends every session and
// "keep me signed in" token of the account.
//
//   GET/POST /a/<alias>/password/forgot   ask for a link
//   GET      /a/<alias>/password/reset?token=…  open the link
//   GET/POST /a/<alias>/password/reset    choose the new password

const RESET = '__RESET';
/** Requests per address and window, whatever was typed in (the database also allows 3 per account per hour). */
const MAX_PER_IP = 5;
const WINDOW_MINUTES = 15;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function card(app: App, locale: Locale, title: string, body: Raw) {
  return documentShell(
    `${title} · ${app.name}`,
    html`<main class="login">
      <div class="card login-card">
        <h1>${title}</h1>
        ${body}
        <a class="login-forgot" href="/a/${app.alias}/login">${locale.t('reset.back')}</a>
      </div>
    </main>`,
    'login-body',
    {},
    pwaHead(app),
    rootAttrs(locale),
  );
}

const forgotPage = (app: App, locale: Locale, session: Session, message?: Raw) => {
  const t = locale.t;
  return card(app, locale, t('reset.title'), html`${message ?? html`<p class="muted">${t('reset.intro')}</p>`}
    <form method="post" action="/a/${app.alias}/password/forgot" class="login-form">
      <input type="hidden" name="__csrf" value="${session.csrf_token}">
      <div class="field"><label class="label" for="login">${t('reset.login_label')}</label><input id="login" name="login" autocomplete="username" autofocus required maxlength="200"></div>
      <button class="btn btn-hot">${t('reset.send')}</button>
    </form>`);
};

const newPasswordPage = (app: App, locale: Locale, session: Session, username: string, error?: string) => {
  const t = locale.t;
  return card(app, locale, t('reset.new_title'), html`${error ? html`<div class="alert alert-error" role="alert">${error}</div>` : ''}
    <form method="post" action="/a/${app.alias}/password/reset" class="login-form">
      <input type="hidden" name="__csrf" value="${session.csrf_token}">
      <div class="field"><label class="label" for="username">${t('login.username')}</label><input id="username" name="username" value="${username}" autocomplete="username" readonly></div>
      <div class="field"><label class="label" for="new_password">${t('password.new')}</label><input id="new_password" name="new_password" type="password" autocomplete="new-password" required maxlength="200" autofocus></div>
      <div class="field"><label class="label" for="confirm_password">${t('password.confirm')}</label><input id="confirm_password" name="confirm_password" type="password" autocomplete="new-password" required maxlength="200"></div>
      <button class="btn btn-hot">${t('password.change')}</button>
    </form>`);
};

/** The mail: plain text, and the same as HTML with the link as a link. #USER# is filled in by the database. */
function resetMail(app: App, locale: Locale, link: string) {
  const t = locale.t;
  const text = t('reset.mail_body', { app: app.name, link });
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const body = text.split(/\n{2,}/).map((para) => `<p>${esc(para).replace(esc(link), `<a href="${esc(link)}">${esc(link)}</a>`).replace(/\n/g, '<br>')}</p>`).join('\n');
  return { subject: t('reset.mail_subject', { app: app.name }), text, html: `<!doctype html><html><body>${body}</body></html>` };
}

export function passwordResetRoutes(app: FastifyInstance) {
  /** The application (with its locale) and session, when it offers password resets; else a 404 page. */
  const start = async (req: Req, reply: Parameters<typeof simplePage>[0]) => {
    const loaded = await appWithLocale(req, req.params.alias);
    if (!loaded || !(await passwordResetAvailable(loaded.app))) {
      simplePage(reply, 404, (loaded?.locale.t ?? ((k: string) => k))('error.not_found'), loaded ? loaded.locale.t('login.method_unavailable') : req.params.alias, loaded ? `/a/${loaded.app.alias}/login` : undefined, loaded?.locale);
      return null;
    }
    const session = await getSession(req, reply, loaded.app.id, `/a/${loaded.app.alias}`);
    return { ...loaded, session };
  };

  app.get('/a/:alias/password/forgot', async (req: Req, reply) => {
    const s = await start(req, reply);
    if (!s) return;
    const body = forgotPage(s.app, s.locale, s.session);
    await saveState(s.session);
    return reply.type('text/html').send(body);
  });

  app.post('/a/:alias/password/forgot', async (req: Req, reply) => {
    const s = await start(req, reply);
    if (!s) return;
    const { app: a, locale, session } = s;
    const t = locale.t;
    if (req.body?.__csrf !== session.csrf_token)
      return reply.code(403).type('text/html').send(forgotPage(a, locale, session, html`<div class="alert alert-error" role="alert">${t('login.expired_session')}</div>`));
    const ip = clientIp(req);
    const login = String(req.body?.login ?? '').slice(0, 200).replace(/\0/g, '');
    const recent = await runtime.one<{ n: number }>(
      `select count(*)::int as n from meta.activity_log where app_id = $1 and event = 'password_reset_request' and ip = $2 and at > now() - make_interval(mins => $3)`,
      [a.id, ip, WINDOW_MINUTES],
    );
    if ((recent?.n ?? 0) >= MAX_PER_IP)
      return reply.code(429).type('text/html').send(forgotPage(a, locale, session, html`<div class="alert alert-error" role="alert">${t('login.throttled', { minutes: WINDOW_MINUTES })}</div>`));
    await logActivity({ appId: a.id, username: login.slice(0, 100), event: 'password_reset_request', ip });
    if (login.trim()) {
      const token = randomBytes(32).toString('base64url');
      const mail = resetMail(a, locale, `${publicUrl()}/a/${a.alias}/password/reset?token=${token}`);
      await runtime.query('select meta.request_password_reset($1, $2, $3, $4, $5, $6, $7)', [a.id, login, sha256(token), ip, mail.subject, mail.text, mail.html]);
    }
    // the same answer whether or not an account matched
    return reply.type('text/html').send(card(a, locale, t('reset.title'), html`<div class="alert alert-success" role="status">${t('reset.sent')}</div>`));
  });

  app.get<{ Params: { alias: string }; Querystring: { token?: string } }>('/a/:alias/password/reset', async (req, reply) => {
    const s = await start(req as Req, reply);
    if (!s) return;
    const { app: a, locale, session } = s;
    // the link: keep the token in the session and take it out of the address bar (and history); a redirect
    // without content, so no page with the token in its address loads anything (the Referer stays clean)
    const token = typeof req.query.token === 'string' ? req.query.token.slice(0, 100) : null;
    if (token !== null) {
      session.state[RESET] = sha256(token);
      await saveState(session);
      return reply.redirect(`/a/${a.alias}/password/reset`, 303);
    }
    const hash = session.state[RESET];
    const user = hash ? (await runtime.one<{ u: string | null }>('select meta.password_reset_user($1, $2) as u', [a.id, hash]))?.u : null;
    if (!user) return reply.code(410).type('text/html').send(invalidPage(a, locale));
    return reply.type('text/html').send(newPasswordPage(a, locale, session, user));
  });

  app.post('/a/:alias/password/reset', async (req: Req, reply) => {
    const s = await start(req, reply);
    if (!s) return;
    const { app: a, locale, session } = s;
    const t = locale.t;
    const hash = session.state[RESET];
    const user = hash ? (await runtime.one<{ u: string | null }>('select meta.password_reset_user($1, $2) as u', [a.id, hash]))?.u : null;
    if (!user) return reply.code(410).type('text/html').send(invalidPage(a, locale));
    const b = req.body ?? {};
    const again = (msg: string, code = 422) => reply.code(code).type('text/html').send(newPasswordPage(a, locale, session, user, msg));
    if (b.__csrf !== session.csrf_token) return again(t('login.expired_session'), 403);
    if (b.new_password !== b.confirm_password) return again(t('password.mismatch'));
    const problem = await passwordProblem(b.new_password, { username: user, t });
    if (problem) return again(problem);
    const done = (await runtime.one<{ u: string | null }>('select meta.reset_password($1, $2, $3) as u', [a.id, hash, String(b.new_password).slice(0, 200)]))?.u;
    if (!done) return reply.code(410).type('text/html').send(invalidPage(a, locale));
    delete session.state[RESET];
    session.state.__FLASH = t('reset.done');
    await saveState(session);
    await logActivity({ appId: a.id, username: done, event: 'password_reset', ip: clientIp(req) });
    return reply.redirect(`/a/${a.alias}/login`, 303);
  });

  const invalidPage = (a: App, locale: Locale) =>
    card(a, locale, locale.t('reset.new_title'), html`<div class="alert alert-error" role="alert">${locale.t('reset.invalid')}</div>
      <a class="btn" href="/a/${a.alias}/password/forgot">${locale.t('reset.send')}</a>`);
}
