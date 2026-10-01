import type { FastifyInstance, FastifyReply } from 'fastify';
import { passwordDaysLeft, passwordProblem } from '../accounts.ts';
import { appTx, runtime } from '../db.ts';
import { html, raw } from '../html.ts';
import { baseLanguage, LANGUAGE_NAMES } from '../i18n.ts';
import { forgetAllRemembered, rememberCookie, rememberedCount } from '../remember.ts';
import { getSession, logActivity, saveState, takeFlash } from '../session.ts';
import type { PageContext } from './context.ts';
import { isTheme, matchLanguage, THEME_COOKIE } from './locale.ts';
import { chrome } from './render.ts';
import { appWithLocale, loadContext, safeNext, txContext, type Req } from './routes.ts';

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
  const devices = ctx.app.remember_me_days ? await rememberedCount(ctx.app.id, ctx.user) : 0;
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
        ${ctx.app.remember_me_days
          ? html`<section class="region region-standard col-6"><header class="region-header"><h2>${t('account.devices')}</h2></header><div class="region-body">
              <p class="muted u-mt0">${t('account.devices_help', { count: devices })}</p>
              <form method="post" action="${ctx.base}/account/devices">${csrf}<button class="btn">${t('account.forget_devices')}</button></form>
            </div></section>`
          : ''}
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

export async function accountRoutes(app: FastifyInstance) {
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

  app.post('/a/:alias/account/devices', async (req: Req, reply) => {
    const ctx = await loadContext(req, reply, { pageNo: 'home' });
    if (!ctx) return;
    if (req.body?.__csrf !== ctx.session.csrf_token) return reply.redirect(`${ctx.base}/account`, 303);
    await forgetAllRemembered(ctx.app.id, ctx.user);
    reply.clearCookie(rememberCookie(ctx.app.id), { path: ctx.base });
    logActivity({ appId: ctx.app.id, username: ctx.user, event: 'logout', ip: ctx.ip, detail: 'all remembered devices' });
    ctx.session.state.__FLASH = ctx.locale.t('account.devices_forgotten');
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
