import type { FastifyInstance, FastifyReply } from 'fastify';
import { passwordDaysLeft, passwordProblem } from '../accounts.ts';
import { appTx, runtime } from '../db.ts';
import { html, raw } from '../html.ts';
import { baseLanguage, LANGUAGE_NAMES } from '../i18n.ts';
import { clientIp, getSession, logActivity, saveState, takeFlash, type Session } from '../session.ts';
import type { PageContext } from './context.ts';
import { isTheme, matchLanguage, THEME_COOKIE } from './locale.ts';
import { documentShell } from '../layout.ts';
import { publicUrl } from '../sso.ts';
import { chrome } from './render.ts';
import { appWithLocale, loadContext, rootAttrs, safeNext, simplePage, txContext, type Req } from './routes.ts';
import type { Locale } from './locale.ts';
import type { App } from '../metadata.ts';

// "My account": details, own password, and preferences (light/dark and
// language). APEX has the APIs for this (APEX_UTIL.CHANGE_CURRENT_USER_PW,
// theme style per user); pgapex provides the page itself.

const themeCookie = (reply: FastifyReply, theme: string) =>
  reply.setCookie(THEME_COOKIE, theme, { path: '/', sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true', maxAge: 365 * 86400 });

async function accountPage(ctx: PageContext, reply: FastifyReply, error?: string, code = 200) {
  const t = ctx.locale.t;
  const acc = (await runtime.one(
    `select a.username, a.display_name, a.email, a.password_changed_at is not null as has_password
       from meta.account a where lower(a.username) = lower($1)`,
    [ctx.user],
  )) ?? {};
  const days = await passwordDaysLeft(ctx.user);
  const hasPassword = !!acc.has_password;
  const flash = takeFlash(ctx.session);
  const csrf = html`<input type="hidden" name="__csrf" value="${ctx.session.csrf_token}">`;
  const opt = (name: string, value: string, label: string, checked: boolean) =>
    html`<label class="check"><input type="radio" name="${name}" value="${value}"${checked ? raw(' checked') : ''}> ${label}</label>`;

  const main = html`<div class="t-titlebar"><h1>${t('account.title')}</h1></div>
    <div class="t-content">
      <div class="messages" aria-live="polite">
        ${flash ? html`<div class="alert alert-success" role="status">${flash}</div>` : ''}
        ${error ? html`<div class="alert alert-error" role="alert">${error}</div>` : ''}
      </div>
      <div class="t-regions">
        <section class="region region-standard col-6"><header class="region-header"><h2>${t('account.details')}</h2></header><div class="region-body">
          <dl class="details">
            <dt>${t('account.username')}</dt><dd>${acc.username ?? ctx.user}</dd>
            ${acc.display_name ? html`<dt>${t('account.name')}</dt><dd>${acc.display_name}</dd>` : ''}
            ${acc.email ? html`<dt>${t('account.email')}</dt><dd>${acc.email}</dd>` : ''}
            ${ctx.roles.length ? html`<dt>${t('account.roles')}</dt><dd>${ctx.roles.join(', ')}</dd>` : ''}
          </dl>
        </div></section>
        ${ctx.locale.themeChoice || ctx.locale.languages.length > 1
          ? html`<section class="region region-standard col-6"><header class="region-header"><h2>${t('account.preferences')}</h2></header><div class="region-body">
              <form method="post" action="${ctx.base}/account">${csrf}
                ${ctx.locale.themeChoice
                  ? html`<fieldset class="field"><legend class="label">${t('theme.label')}</legend><div class="pref-options">
                      ${(['auto', 'light', 'dark'] as const).map((m) => opt('theme', m, t(`theme.${m}`), ctx.locale.theme === m))}</div></fieldset>`
                  : ''}
                ${ctx.locale.languages.length > 1
                  ? html`<div class="field"><label class="label" for="language">${t('language.label')}</label>
                      <select id="language" name="language">${ctx.locale.languages.map((l) =>
                        html`<option value="${l}"${l === ctx.locale.lang ? raw(' selected') : ''}>${LANGUAGE_NAMES[baseLanguage(l)] ?? l}</option>`)}</select></div>`
                  : ''}
                <div class="buttons"><button class="btn btn-hot">${t('common.save')}</button></div>
              </form>
            </div></section>`
          : ''}
        <section class="region region-standard col-6"><header class="region-header"><h2>${t('password.change')}</h2></header><div class="region-body">
          ${hasPassword && ctx.app.local_login
            ? html`${days !== null ? html`<p class="muted">${t('password.days_left', { days })}</p>` : ''}
              <form method="post" action="${ctx.base}/account/password" class="form-grid">${csrf}
                <div class="field"><label class="label" for="password">${t('password.current')}</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="200"></div>
                <div class="field"><label class="label" for="new_password">${t('password.new')}</label><input id="new_password" name="new_password" type="password" autocomplete="new-password" required maxlength="200"></div>
                <div class="field"><label class="label" for="confirm_password">${t('password.confirm')}</label><input id="confirm_password" name="confirm_password" type="password" autocomplete="new-password" required maxlength="200"></div>
                <div class="buttons" data-wide><button class="btn btn-hot">${t('password.change')}</button></div>
              </form>`
            : html`<p class="muted">${t('account.sso_only')}</p>`}
        </div></section>
      </div>
    </div>`;
  ctx.vis = { regions: new Set(), items: new Set(), editable: new Set(), buttons: new Map(), dynamicActions: new Set() };
  const body = await appTx(txContext(ctx), async (c) => {
    ctx.client = c;
    return chrome(ctx, main, t('account.title'));
  });
  await saveState(ctx.session);
  return reply.code(code).type('text/html').send(body);
}

/** A small card page like the login page (forgot / reset password). */
function cardPage(app: App, locale: Locale, title: string, body: ReturnType<typeof html>) {
  return documentShell(`${title} · ${app.name}`, html`<main class="login"><div class="card login-card"><h1>${title}</h1>${body}</div></main>`,
    'login-body', {}, '', rootAttrs(locale));
}

/** Requests for reset links per IP address in the last 15 minutes. */
async function resetRequests(ip: string) {
  return (await runtime.one<{ n: number }>(
    `select count(*)::int as n from meta.activity_log where event = 'password_reset_requested' and ip = $1 and at > now() - interval '15 minutes'`, [ip]))?.n ?? 0;
}

/** Load an app for the forgot/reset pages; 404 unless the app offers it. */
async function resetApp(req: Req, reply: FastifyReply) {
  const loaded = await appWithLocale(req, req.params.alias);
  if (!loaded || !loaded.app.password_reset || !loaded.app.local_login || loaded.app.authentication === 'none') {
    simplePage(reply, 404, 'Not found', 'This page is not available.');
    return null;
  }
  const session = await getSession(req, reply, loaded.app.id, `/a/${loaded.app.alias}`);
  return { ...loaded, session };
}

const forgotForm = (app: App, locale: Locale, session: Session, message?: string, error?: string) => {
  const t = locale.t;
  return cardPage(app, locale, t('forgot.title'), html`
    ${error ? html`<div class="alert alert-error" role="alert">${error}</div>` : ''}
    ${message ? html`<div class="alert alert-success" role="status">${message}</div>` : html`<p class="muted">${t('forgot.text')}</p>`}
    ${message ? '' : html`<form method="post" class="login-form">
      <input type="hidden" name="__csrf" value="${session.csrf_token}">
      <div class="field"><label class="label" for="login">${t('forgot.login')}</label><input id="login" name="login" autocomplete="username" required maxlength="200" autofocus></div>
      <button class="btn btn-hot">${t('forgot.submit')}</button>
    </form>`}
    <p class="login-extra"><a href="/a/${app.alias}/login">${t('forgot.back')}</a></p>`);
};

const resetForm = (app: App, locale: Locale, session: Session, token: string, username: string, error?: string) => {
  const t = locale.t;
  return cardPage(app, locale, t('reset.title'), html`
    ${error ? html`<div class="alert alert-error" role="alert">${error}</div>` : ''}
    <form method="post" action="/a/${app.alias}/reset" class="login-form">
      <input type="hidden" name="__csrf" value="${session.csrf_token}"><input type="hidden" name="token" value="${token}">
      <div class="field"><label class="label" for="username">${t('login.username')}</label><input id="username" value="${username}" autocomplete="username" readonly></div>
      <div class="field"><label class="label" for="new_password">${t('password.new')}</label><input id="new_password" name="new_password" type="password" autocomplete="new-password" required maxlength="200" autofocus></div>
      <div class="field"><label class="label" for="confirm_password">${t('password.confirm')}</label><input id="confirm_password" name="confirm_password" type="password" autocomplete="new-password" required maxlength="200"></div>
      <button class="btn btn-hot">${t('password.change')}</button>
    </form>`);
};

export async function accountRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- forgot password (opt-in per app)
  app.get('/a/:alias/forgot', async (req: Req, reply) => {
    const r = await resetApp(req, reply);
    if (!r) return;
    await saveState(r.session);
    return reply.type('text/html').send(forgotForm(r.app, r.locale, r.session));
  });

  app.post('/a/:alias/forgot', async (req: Req, reply) => {
    const r = await resetApp(req, reply);
    if (!r) return;
    const { app: a, locale, session } = r;
    const t = locale.t;
    if (req.body?.__csrf !== session.csrf_token) return reply.type('text/html').send(forgotForm(a, locale, session));
    const ip = clientIp(req);
    const login = (req.body?.login ?? '').trim().slice(0, 200);
    // The answer is the same whether or not the account exists.
    const done = () => reply.type('text/html').send(forgotForm(a, locale, session, t('forgot.sent')));
    if (!login || (await resetRequests(ip)) >= 10) return done();
    const found = await runtime.one<{ username: string; email: string; display_name: string | null; token: string }>(
      'select * from meta.start_password_reset($1, $2)', [a.id, login]);
    await logActivity({ appId: a.id, username: found?.username ?? login.slice(0, 100), event: 'password_reset_requested', ip, detail: found ? 'link sent' : 'no match' });
    if (found) {
      const link = `${publicUrl()}/a/${a.alias}/reset?token=${found.token}`;
      await runtime.tx(async (c) => {
        await c.query(`select set_config('pgapex.app_id', $1, true), set_config('pgapex.app_user', $2, true)`, [String(a.id), found.username]);
        await c.query('select meta.send_mail($1, $2, $3)', [
          found.email,
          t('reset.mail.subject', { app: a.name }),
          t('reset.mail.body', { name: found.display_name ?? found.username, user: found.username, app: a.name, link }),
        ]);
      });
    }
    return done();
  });

  app.get<{ Params: { alias: string }; Querystring: { token?: string } }>('/a/:alias/reset', async (req, reply) => {
    const r = await resetApp(req as unknown as Req, reply);
    if (!r) return;
    const token = String(req.query.token ?? '').slice(0, 200);
    const username = (await runtime.one<{ u: string | null }>('select meta.check_password_reset($1, $2) as u', [r.app.id, token]))?.u;
    await saveState(r.session);
    reply.header('cache-control', 'no-store');
    if (!username) return reply.code(410).type('text/html').send(forgotForm(r.app, r.locale, r.session, undefined, r.locale.t('reset.invalid')));
    return reply.type('text/html').send(resetForm(r.app, r.locale, r.session, token, username));
  });

  app.post('/a/:alias/reset', async (req: Req, reply) => {
    const r = await resetApp(req, reply);
    if (!r) return;
    const { app: a, locale, session } = r;
    const t = locale.t;
    const b = req.body ?? {};
    const token = String(b.token ?? '').slice(0, 200);
    const username = (await runtime.one<{ u: string | null }>('select meta.check_password_reset($1, $2) as u', [a.id, token]))?.u;
    if (!username || b.__csrf !== session.csrf_token)
      return reply.code(410).type('text/html').send(cardPage(a, locale, t('reset.title'), html`<div class="alert alert-error" role="alert">${t('reset.invalid')}</div>
        <p class="login-extra"><a href="/a/${a.alias}/forgot">${t('forgot.title')}</a></p>`));
    const again = (msg: string) => reply.code(422).type('text/html').send(resetForm(a, locale, session, token, username, msg));
    if (b.new_password !== b.confirm_password) return again(t('password.mismatch'));
    const problem = await passwordProblem(b.new_password, { username, t });
    if (problem) return again(problem);
    const done = (await runtime.one<{ u: string | null }>('select meta.finish_password_reset($1, $2, $3) as u', [a.id, token, b.new_password]))?.u;
    if (!done) return again(t('reset.invalid'));
    logActivity({ appId: a.id, username: done, event: 'password_reset', ip: clientIp(req) });
    session.state.__FLASH = t('reset.done');
    await saveState(session);
    return reply.redirect(`/a/${a.alias}/login`, 303);
  });

  app.get('/a/:alias/account', async (req: Req, reply) => {
    const ctx = await loadContext(req, reply, { pageNo: 'home' });
    if (!ctx) return;
    return accountPage(ctx, reply);
  });

  app.post('/a/:alias/account', async (req: Req, reply) => {
    const ctx = await loadContext(req, reply, { pageNo: 'home' });
    if (!ctx) return;
    const b = req.body ?? {};
    if (b.__csrf !== ctx.session.csrf_token) return reply.redirect(`${ctx.base}/account`, 303);
    const theme = ctx.locale.themeChoice && isTheme(b.theme) ? b.theme : undefined;
    const language = matchLanguage(b.language, ctx.locale.languages);
    await runtime.query(
      `update meta.account set theme_pref = coalesce($2, theme_pref), language = coalesce($3, language) where lower(username) = lower($1)`,
      [ctx.user, theme ?? null, language ?? null],
    );
    if (theme) {
      ctx.session.state.__THEME = theme;
      themeCookie(reply, theme);
    }
    if (language) ctx.session.state.__LANG = language;
    // the confirmation in the newly chosen language
    const again = await appWithLocale(req, ctx.app.alias, ctx.session);
    ctx.session.state.__FLASH = (again?.locale.t ?? ctx.locale.t)('account.saved');
    await saveState(ctx.session);
    return reply.redirect(`${ctx.base}/account`, 303);
  });

  app.post('/a/:alias/account/password', async (req: Req, reply) => {
    const ctx = await loadContext(req, reply, { pageNo: 'home' });
    if (!ctx) return;
    const b = req.body ?? {};
    const t = ctx.locale.t;
    if (b.__csrf !== ctx.session.csrf_token) return reply.redirect(`${ctx.base}/account`, 303);
    if (!ctx.app.local_login) return accountPage(ctx, reply, t('login.password_disabled'), 403);
    if (b.new_password !== b.confirm_password) return accountPage(ctx, reply, t('password.mismatch'), 422);
    const problem = await passwordProblem(b.new_password, { username: ctx.user, t });
    if (problem) return accountPage(ctx, reply, problem, 422);
    let ok = false;
    try {
      ok = !!(await runtime.one('select meta.change_password($1, $2, $3, $4, $5) as ok',
        [ctx.app.id, ctx.user, (b.password ?? '').slice(0, 200), b.new_password, ctx.session.id]))?.ok;
    } catch (e) {
      if ((e as { code?: string }).code === 'P0001') return accountPage(ctx, reply, t('password.same_as_old'), 422);
      throw e;
    }
    if (!ok) {
      await logActivity({ appId: ctx.app.id, username: ctx.user, event: 'login_failed', ip: ctx.ip, detail: 'password change' });
      return accountPage(ctx, reply, t('password.wrong_current'), 401);
    }
    logActivity({ appId: ctx.app.id, username: ctx.user, event: 'password_changed', ip: ctx.ip });
    ctx.session.state.__FLASH = t('password.changed');
    await saveState(ctx.session);
    return reply.redirect(`${ctx.base}/account`, 303);
  });

  // Quick light/dark switch from the user menu; works signed out too (cookie only).
  app.post('/a/:alias/account/theme', async (req: Req, reply) => {
    const loaded = await appWithLocale(req, req.params.alias);
    if (!loaded) return reply.code(404).send('Not found');
    const { app: a } = loaded;
    const session = await getSession(req, reply, a.id, `/a/${a.alias}`);
    const b = req.body ?? {};
    const to = safeNext(a, b.next);
    if (b.__csrf !== session.csrf_token || a.theme?.user_choice === false || !isTheme(b.theme)) return reply.redirect(to, 303);
    session.state.__THEME = b.theme;
    themeCookie(reply, b.theme);
    if (session.username) {
      await runtime.query('update meta.account set theme_pref = $2 where lower(username) = lower($1)', [session.username, b.theme]);
    }
    await saveState(session);
    return reply.redirect(to, 303);
  });
}
