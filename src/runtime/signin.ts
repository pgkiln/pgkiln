import { runtime } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import type { App } from '../metadata.ts';
import { takeFlash, type Session } from '../session.ts';
import { enabledProviders } from '../sso.ts';
import type { PageContext } from './context.ts';
import type { Locale } from './locale.ts';
import { passkeyBlock, passkeyForm } from './passkey-signin.ts';
import { languagePicker } from './render.ts';
import { remembersUsername } from '../remember-username.ts';

// The sign-in form: (sprint 199) "Sign in with a passkey" (passkey-signin.ts), the identity providers' buttons,
// user name and password, (sprint 231) "Remember username", "Keep me signed in" and "Forgot password?". The built-in sign-in page
// (routes.ts) and the "login" region of an application's own login page
// (migration 087, meta.app.login_page) both show it; it always posts to
// /a/<alias>/login, whose checks (CSRF, throttling, every sign-in method)
// are the same either way.
//
// On a login page the form's fields sit inside the page's own form, so they
// name a separate, detached <form> with the form attribute (formId).

/** Where to go after signing in: a path of this application, else its home page. */
export const safeNext = (app: App, next: string | undefined) =>
  // (sprint 189, NX-S5) deep linking off: every sign-in goes to the home page
  // (sprint 165) no dot segments either: /a/<alias>/../../builder stays inside the application
  app.deep_linking !== false && next && next.startsWith(`/a/${app.alias}/`) && !/[\\\r\n]/.test(next) && !next.includes('//') && !/\/(\.|%2e){1,2}(\/|$|\?|#)/i.test(next) ? next : `/a/${app.alias}/${app.home_page}`;

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
  o: {
    error?: string; username?: string; formId?: string; autofocus?: boolean; passkeyFormId?: string; host?: boolean;
    /** (sprint 231) the browser's remembered user name (remember-username.ts) */
    remembered?: string;
    /** (sprint 231) a Login region's {"remember_username": false} / {"persistent_auth": false} leave the boxes out */
    rememberUsername?: boolean; persistentAuth?: boolean;
  } = {},
): Promise<Raw> {
  const t = locale.t;
  // database accounts and custom authentication: the user name and password form only
  const dbAuth = app.authentication === 'database' || app.authentication === 'custom';
  const local = dbAuth || app.local_login;
  // "Keep me signed in" (APEX: persistent authentication) only where the application allows it
  const remember = dbAuth || o.persistentAuth === false ? null : app.remember_me_days;
  // (sprint 231, AX-13) "Remember username" (APEX: P9999_REMEMBER): filled in and checked from the cookie
  const rememberUser = remembersUsername(app) && o.rememberUsername !== false;
  const remembered = rememberUser ? o.remembered : undefined;
  const username = o.username ?? remembered ?? '';
  // a remembered name: the cursor goes to the password
  const focusPassword = o.autofocus !== false && !o.username && !!remembered;
  const providers = dbAuth ? [] : await enabledProviders(app.sso_providers ?? []);
  const nextQs = next ? `?next=${encodeURIComponent(next)}` : '';
  const forgot = !dbAuth && local && (await passwordResetAvailable(app));
  const fa = o.formId ? raw(` form="${o.formId}"`) : '';
  const fields = html`<input type="hidden" name="__csrf" value="${session.csrf_token}"${fa}>
    <input type="hidden" name="next" value="${next}"${fa}>
    ${app.time_zone_auto ? html`<input type="hidden" name="__tz" value=""${fa}>` : ''}
    <div class="field"><label class="label" for="username">${t('login.username')}</label><input id="username" name="username" value="${username}" autocomplete="username"${o.autofocus === false || focusPassword ? '' : raw(' autofocus')} required maxlength="100"${fa}></div>
    <div class="field"><label class="label" for="password">${t('login.password')}</label><input id="password" name="password" type="password" autocomplete="current-password"${focusPassword ? raw(' autofocus') : ''} required maxlength="200"${fa}></div>
    ${rememberUser || remember ? html`<div class="login-checks">
      ${rememberUser ? html`<label class="check"><input type="checkbox" name="remember_username" value="true"${remembered ? raw(' checked') : ''}${fa}> ${t('login.remember_username')}</label>` : ''}
      ${remember ? html`<label class="check"><input type="checkbox" name="remember" value="true"${fa}> ${t('login.remember', { days: remember })}</label>` : ''}</div>` : ''}
    <button class="btn btn-hot"${fa}>${t('login.submit')}</button>
    ${forgot ? html`<a class="login-forgot" href="/a/${app.alias}/password/forgot">${t('reset.link')}</a>` : ''}`;
  return html`${o.error ? html`<div class="alert alert-error" role="alert">${o.error}</div>` : ''}
    ${((f) => (f ? html`<div class="alert alert-success" role="status">${f}</div>` : ''))(takeFlash(session))}
    ${local && !dbAuth ? passkeyBlock(app, locale, session, next, { formId: o.passkeyFormId, host: o.host }) : ''}
    ${providers.length
      ? html`<div class="sso-buttons">${providers.map(
          (pr) => html`<a class="btn${local ? '' : ' btn-hot'}" href="/a/${app.alias}/sso/${pr.name}${nextQs}">${t('login.with', { provider: pr.display_name })}</a>`,
        )}</div>${local ? html`<div class="or" role="separator"><span>${t('login.or')}</span></div>` : ''}`
      : ''}
    ${local
      ? o.formId ? html`<div class="login-form">${fields}</div>` : html`<form method="post" action="/a/${app.alias}/login" class="login-form">${fields}</form>`
      : providers.length ? '' : html`<p>${t('login.none')}</p>`}`;
}

/** The "login" region of an application's own login page; (167) {"autofocus": false} leaves the focus where the page puts it;
 *  (sprint 231) {"remember_username": false} and {"persistent_auth": false} leave out "Remember username" and "Keep me signed in". */
export async function renderLoginRegion(ctx: PageContext, config: { autofocus?: unknown; remember_username?: unknown; persistent_auth?: unknown } = {}): Promise<Raw> {
  const s = ctx.session.state;
  const error = s[LOGIN_ERROR] ?? undefined;
  const username = s[LOGIN_USER] ?? undefined;
  delete s[LOGIN_ERROR];
  delete s[LOGIN_USER];
  const formId = 'pgkiln-login';
  ctx.detached.push(html`<form id="${formId}" method="post" action="/a/${ctx.app.alias}/login"></form>`);
  // (sprint 199) "Sign in with a passkey" posts a form of its own
  const passkeyFormId = 'pgkiln-login-passkey';
  const pk = ctx.passkeyHost === false ? '' : passkeyForm(ctx.app, passkeyFormId);
  if (pk) ctx.detached.push(pk);
  const next = safeNext(ctx.app, ctx.params.get('next') ?? undefined);
  const here = `${ctx.base}/${ctx.page.page_no}${ctx.params.get('next') ? `?next=${encodeURIComponent(next)}` : ''}`;
  return html`<div class="login-region">${await signInForm(ctx.app, ctx.locale, ctx.session, next, {
    error, username, formId, passkeyFormId, host: ctx.passkeyHost, autofocus: config.autofocus !== false,
    // (sprint 231) the remembered user name; {"remember_username": false} / {"persistent_auth": false} leave a box out
    remembered: ctx.rememberedUser, rememberUsername: config.remember_username !== false, persistentAuth: config.persistent_auth !== false,
  })}
    ${languagePicker(ctx.app, ctx.locale, here)}</div>`;
}
