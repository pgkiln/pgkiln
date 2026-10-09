import type { FastifyInstance, FastifyReply } from 'fastify';
import { passwordDaysLeft, passwordProblem } from '../accounts.ts';
import { appTx, runtime } from '../db.ts';
import { html, raw } from '../html.ts';
import { baseLanguage, LANGUAGE_NAMES } from '../i18n.ts';
import { forgetAllRemembered, rememberCookie, rememberedCount } from '../remember.ts';
import { getSession, loginThrottled, logActivity, saveState, takeFlash } from '../session.ts';
import { loginWindowMinutes } from '../security.ts';
import type { PageContext } from './context.ts';
import { databaseTimeZone, isTheme, matchLanguage, sameOffset, THEME_COOKIE, timeZoneFor, timeZoneNames, validTimeZone } from './locale.ts';
import { chrome, clientTexts } from './render.ts';
import { appStyles, choosable, chosenStyleName, styleChoice } from './styles.ts';
import { loadApp } from '../metadata.ts';
import { pushSection } from './push.ts';
import { appWithLocale, loadContext, safeNext, txContext, type Req } from './routes.ts';

// "My account": details, own password, and preferences (light/dark and
// language). APEX has the APIs for this (APEX_UTIL.CHANGE_CURRENT_USER_PW,
// theme style per user); pgkiln provides the page itself.

/** Keep a signed-in user's style variant for this app (meta.account_style; '' = the base colours). */
async function saveStyle(appId: number, username: string, style: string) {
  await runtime.query(
    `insert into meta.account_style (account_id, app_id, style)
     select id, $2, $3 from meta.account where lower(username) = lower($1)
     on conflict (account_id, app_id) do update set style = excluded.style`,
    [username, appId, style],
  );
}

const themeCookie = (reply: FastifyReply, theme: string) =>
  reply.setCookie(THEME_COOKIE, theme, { path: '/', sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true', maxAge: 365 * 86400 });

/** My account → Time zone: automatic (the browser's) or one of PostgreSQL's time zones. */
async function timeZoneField(ctx: PageContext) {
  const t = ctx.locale.t;
  const own = typeof ctx.session.state.__TZ_PREF === 'string' ? ctx.session.state.__TZ_PREF : '';
  const browser = typeof ctx.session.state.__TZ === 'string' ? ctx.session.state.__TZ : '';
  const { sorted } = await timeZoneNames();
  return html`<div class="field"><label class="label" for="time_zone">${t('timezone.label')}</label>
    <select id="time_zone" name="time_zone" aria-describedby="time_zone_help">
      <option value="">${browser ? t('timezone.auto_browser', { zone: browser }) : t('timezone.auto')}</option>
      ${sorted.map((z) => html`<option value="${z}"${z === own ? raw(' selected') : ''}>${z}</option>`)}
    </select>
    <small class="help" id="time_zone_help">${t('timezone.current', { zone: ctx.locale.timeZone ?? t('timezone.server') })}</small></div>`;
}

async function accountPage(ctx: PageContext, reply: FastifyReply, error?: string, code = 200) {
  const t = ctx.locale.t;
  const acc = (await runtime.one(
    `select a.username, a.display_name, a.email, a.password_changed_at is not null as has_password
       from meta.account a where lower(a.username) = lower($1)`,
    [ctx.user],
  )) ?? {};
  const days = await passwordDaysLeft(ctx.user);
  const devices = ctx.app.remember_me_days ? await rememberedCount(ctx.app.id, ctx.user) : 0;
  // only the user directory's own passwords change here (not database roles, custom checks or a proxy's users)
  const hasPassword = !!acc.has_password && ownPasswords(ctx.app);
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
        ${ctx.locale.themeChoice || styleChoice(ctx.app) || ctx.locale.languages.length > 1 || ctx.app.time_zone_auto
          ? html`<section class="region region-standard col-6"><header class="region-header"><h2>${t('account.preferences')}</h2></header><div class="region-body">
              <form method="post" action="${ctx.base}/account">${csrf}
                ${ctx.locale.themeChoice
                  ? html`<fieldset class="field"><legend class="label">${t('theme.label')}</legend><div class="pref-options">
                      ${(['auto', 'light', 'dark'] as const).map((m) => opt('theme', m, t(`theme.${m}`), ctx.locale.theme === m))}</div></fieldset>`
                  : ''}
                ${styleChoice(ctx.app)
                  ? html`<div class="field"><label class="label" for="style">${t('style.label')}</label>
                      <select id="style" name="style">${['', ...appStyles(ctx.app.theme).map((x) => x.name)].map((n) =>
                        html`<option value="${n}"${n === chosenStyleName(ctx.app, ctx.session) ? raw(' selected') : ''}>${n || t('style.standard')}</option>`)}</select></div>`
                  : ''}
                ${ctx.locale.languages.length > 1
                  ? html`<div class="field"><label class="label" for="language">${t('language.label')}</label>
                      <select id="language" name="language">${ctx.locale.languages.map((l) =>
                        html`<option value="${l}"${l === ctx.locale.lang ? raw(' selected') : ''}>${LANGUAGE_NAMES[baseLanguage(l)] ?? l}</option>`)}</select></div>`
                  : ''}
                ${ctx.app.time_zone_auto ? await timeZoneField(ctx) : ''}
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
        ${await pushSection(ctx)}
      </div>
    </div>
    <script type="application/json" id="pgapex-meta">${raw(JSON.stringify({ csrf: ctx.session.csrf_token, das: [], texts: clientTexts(ctx) }).replace(/</g, '\\u003c'))}</script>`;
  ctx.vis = { regions: new Set(), items: new Set(), editable: new Set(), buttons: new Map(), dynamicActions: new Set() };
  const body = await appTx(txContext(ctx), async (c) => {
    ctx.client = c;
    return chrome(ctx, main, t('account.title'));
  });
  await saveState(ctx.session);
  return reply.code(code).type('text/html').send(body);
}

/** Whether the app's users sign in with the user directory's passwords (so My account may change them). */
const ownPasswords = (a: { authentication: string }) => a.authentication === 'app_users';

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
    // the time zone: '' is automatic (the browser's); anything else must be one PostgreSQL knows
    const zoneSent = ctx.app.time_zone_auto && typeof b.time_zone === 'string';
    const zone = zoneSent ? await validTimeZone(b.time_zone) : undefined;
    if (zoneSent && b.time_zone !== '' && !zone) return accountPage(ctx, reply, ctx.locale.t('timezone.invalid'), 422);
    await runtime.query(
      `update meta.account set theme_pref = coalesce($2, theme_pref), language = coalesce($3, language),
              time_zone = case when $4 then $5 else time_zone end where lower(username) = lower($1)`,
      [ctx.user, theme ?? null, language ?? null, zoneSent, zone ?? null],
    );
    if (zoneSent) {
      if (zone) ctx.session.state.__TZ_PREF = zone;
      else delete ctx.session.state.__TZ_PREF;
    }
    if (theme) {
      ctx.session.state.__THEME = theme;
      themeCookie(reply, theme);
    }
    if (language) ctx.session.state.__LANG = language;
    // a style variant: only one of the app's own styles ('' = the base colours)
    if (choosable(ctx.app, b.style)) {
      ctx.session.state.__STYLE = b.style;
      await saveStyle(ctx.app.id, ctx.user, b.style);
    }
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
    if (!ctx.app.local_login || !ownPasswords(ctx.app)) return accountPage(ctx, reply, t('login.password_disabled'), 403);
    // wrong current passwords count like failed sign-ins: no guessing it from a session left open
    if (await loginThrottled(ctx.app.id, ctx.user, ctx.ip)) {
      logActivity({ appId: ctx.app.id, username: ctx.user, event: 'login_locked', ip: ctx.ip, detail: 'password change' });
      return accountPage(ctx, reply, t('login.throttled', { minutes: loginWindowMinutes() }), 429);
    }
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

  // Automatic time zone: app.js sends the browser's time zone once per session (also signed out).
  // Answers whether the page should be shown again in the new time zone.
  app.post('/a/:alias/tz', async (req: Req, reply) => {
    const a = await loadApp(req.params.alias);
    if (!a) return reply.code(404).send({ error: 'not found' });
    const session = await getSession(req, reply, a.id, `/a/${a.alias}`);
    const b = req.body ?? {};
    if (b.__csrf !== session.csrf_token) return reply.code(403).send({ error: 'session changed' });
    if (!a.time_zone_auto) return reply.send({ reload: false });
    const zone = await validTimeZone(b.tz);
    if (!zone) return reply.code(422).send({ error: 'unknown time zone' });
    const effective = async () => (await timeZoneFor(a, session)).tz ?? (await databaseTimeZone());
    const before = await effective();
    session.state.__TZ = zone;
    await saveState(session);
    // show the page again only when its times change (UTC and Etc/UTC don't)
    return reply.send({ reload: !sameOffset(before, await effective()) });
  });

  // Quick style switch (Theme Roller style variants) from the user menu; signed out: this session only.
  app.post('/a/:alias/account/style', async (req: Req, reply) => {
    const a = await loadApp(req.params.alias);
    if (!a) return reply.code(404).send('Not found');
    const session = await getSession(req, reply, a.id, `/a/${a.alias}`);
    const b = req.body ?? {};
    const to = safeNext(a, b.next);
    if (b.__csrf !== session.csrf_token || !choosable(a, b.style)) return reply.redirect(to, 303);
    session.state.__STYLE = b.style;
    if (session.username) await saveStyle(a.id, session.username, b.style);
    await saveState(session);
    return reply.redirect(to, 303);
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
