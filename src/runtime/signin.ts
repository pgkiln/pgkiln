import { runtime } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import type { App } from '../metadata.ts';
import { takeFlash, type Session } from '../session.ts';
import { enabledProviders } from '../sso.ts';
import type { PageContext } from './context.ts';
import type { Locale } from './locale.ts';
import { languagePicker } from './render.ts';

// The sign-in form: the identity providers' buttons, user name and password,
// "Keep me signed in" and "Forgot password?". The built-in sign-in page
// (routes.ts) and the "login" region of an application's own login page
// (migration 087, meta.app.login_page) both show it; it always posts to
// /a/<alias>/login, whose checks (CSRF, throttling, every sign-in method)
// are the same either way.
//
// On a login page the form's fields sit inside the page's own form, so they
// name a separate, detached <form> with the form attribute (formId).

/** Where to go after signing in: a path of this application, else its home page. */
export const safeNext = (app: App, next: string | undefined) =>
  next && next.startsWith(`/a/${app.alias}/`) && !/[\\\r\n]/.test(next) && !next.includes('//') ? next : `/a/${app.alias}/${app.home_page}`;

/** "Forgot password?" is offered: turned on, app users with passwords, an enabled mail service. */
export async function passwordResetAvailable(app: App) {
  if (!app.password_reset) return false;
  return !!(await runtime.one<{ ok: boolean }>('select meta.password_reset_available($1) as ok', [app.id]))?.ok;
}

/** A failed sign-in on an application's own login page: the message and user name, shown once. */
export const LOGIN_ERROR = '__LOGIN_ERROR';
export const LOGIN_USER = '__LOGIN_USER';

export async function signInForm(
  app: App, locale: Locale, session: Session, next: string,
  o: { error?: string; username?: string; formId?: string } = {},
): Promise<Raw> {
  const t = locale.t;
  // database accounts and custom authentication: the user name and password form only
  const dbAuth = app.authentication === 'database' || app.authentication === 'custom';
  const local = dbAuth || app.local_login;
  const remember = dbAuth ? null : app.remember_me_days;
  const providers = dbAuth ? [] : await enabledProviders(app.sso_providers ?? []);
  const nextQs = next ? `?next=${encodeURIComponent(next)}` : '';
  const forgot = !dbAuth && local && (await passwordResetAvailable(app));
  const fa = o.formId ? raw(` form="${o.formId}"`) : '';
  const fields = html`<input type="hidden" name="__csrf" value="${session.csrf_token}"${fa}>
    <input type="hidden" name="next" value="${next}"${fa}>
    ${app.time_zone_auto ? html`<input type="hidden" name="__tz" value=""${fa}>` : ''}
    <div class="field"><label class="label" for="username">${t('login.username')}</label><input id="username" name="username" value="${o.username ?? ''}" autocomplete="username" autofocus required maxlength="100"${fa}></div>
    <div class="field"><label class="label" for="password">${t('login.password')}</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="200"${fa}></div>
    ${remember ? html`<label class="check"><input type="checkbox" name="remember" value="true"${fa}> ${t('login.remember', { days: remember })}</label>` : ''}
    <button class="btn btn-hot"${fa}>${t('login.submit')}</button>
    ${forgot ? html`<a class="login-forgot" href="/a/${app.alias}/password/forgot">${t('reset.link')}</a>` : ''}`;
  return html`${o.error ? html`<div class="alert alert-error" role="alert">${o.error}</div>` : ''}
    ${((f) => (f ? html`<div class="alert alert-success" role="status">${f}</div>` : ''))(takeFlash(session))}
    ${providers.length
      ? html`<div class="sso-buttons">${providers.map(
          (pr) => html`<a class="btn${local ? '' : ' btn-hot'}" href="/a/${app.alias}/sso/${pr.name}${nextQs}">${t('login.with', { provider: pr.display_name })}</a>`,
        )}</div>${local ? html`<div class="or" role="separator"><span>${t('login.or')}</span></div>` : ''}`
      : ''}
    ${local
      ? o.formId ? html`<div class="login-form">${fields}</div>` : html`<form method="post" action="/a/${app.alias}/login" class="login-form">${fields}</form>`
      : providers.length ? '' : html`<p>${t('login.none')}</p>`}`;
}

/** The "login" region of an application's own login page. */
export async function renderLoginRegion(ctx: PageContext): Promise<Raw> {
  const s = ctx.session.state;
  const error = s[LOGIN_ERROR] ?? undefined;
  const username = s[LOGIN_USER] ?? undefined;
  delete s[LOGIN_ERROR];
  delete s[LOGIN_USER];
  const formId = 'pgkiln-login';
  ctx.detached.push(html`<form id="${formId}" method="post" action="/a/${ctx.app.alias}/login"></form>`);
  const next = safeNext(ctx.app, ctx.params.get('next') ?? undefined);
  const here = `${ctx.base}/${ctx.page.page_no}${ctx.params.get('next') ? `?next=${encodeURIComponent(next)}` : ''}`;
  return html`<div class="login-region">${await signInForm(ctx.app, ctx.locale, ctx.session, next, { error, username, formId })}
    ${languagePicker(ctx.app, ctx.locale, here)}</div>`;
}
