import { isIP } from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { accountPasskeyByCredential, accountUserHandle, markAccountSignIn, markSecondStep, passkeyAlone, useAccountPasskey, withSecondStep } from '../account-mfa.ts';
import { passwordDaysLeft } from '../accounts.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { loadApp, type App } from '../metadata.ts';
import { loginWindowMinutes } from '../security.ts';
import { getSession, loginThrottled, logActivity, saveState, type Session } from '../session.ts';
import { giveChallenge, relyingParty, takeChallenge, verifyAssertion, WebAuthnError } from '../webauthn.ts';
import type { Locale } from './locale.ts';
import { headerOf } from './pwa.ts';
import { chosenStyle, themeCss } from './styles.ts';

// (sprint 199, NX-U6) Signing in to an application with a passkey alone, beyond APEX (whose sign-in page has no
// passkeys). An application with "Users may sign in with a passkey alone" (meta.app.passkey_signin, migration 173)
// shows "Sign in with a passkey" above the user name and password, on the built-in sign-in page and in the login
// region of its own login page. Only for the user directory's accounts (passkeyAlone() in account-mfa.ts).
//
// The browser asks for options (a one-time challenge kept in the signed-out session, for 'get' only), then
// navigator.credentials.get() offers the passkeys it holds for the site (discoverable credentials: no user name, an
// empty allow list) and the authenticator must verify the user (userVerification 'required', the UV flag checked
// here), so the passkey counts as both factors: the session's method is "passkey+2fa" and it had a second step now.
// The answer is checked as at the second step (src/webauthn.ts: challenge, origin, RP ID hash, signature, counter);
// then the account must be active, may use the application, isn't locked out by failed sign-ins, and its password
// hasn't expired. Every failure gives the same message and is logged as a failed sign-in (it counts for the lockout).
// Without JavaScript or WebAuthn the button stays hidden (public/app.js [data-passkey-block]).
//
// The sign-in card also carries the application's look: its icon (the PWA icon, else its initial on the accent
// colour) and the theme's colours (Settings → User Interface), as a nonced <style>.

/** The fields public/app.js fills with the browser's answer. */
const ASSERTION = ['credentialId', 'clientDataJSON', 'authenticatorData', 'signature', 'userHandle'];

/**
 * "Sign in with a passkey" and the "or" line under it, hidden until app.js finds WebAuthn. With formId (a login region
 * inside the page's own form) the fields belong to the detached form `formId` through the form attribute.
 */
export function passkeyBlock(app: App, locale: Locale, session: Session, next: string, o: { formId?: string; host?: boolean } = {}): Raw | '' {
  if (!passkeyAlone(app) || o.host === false) return '';
  const t = locale.t;
  const fa = o.formId ? raw(` form="${o.formId}"`) : '';
  const fields = html`<input type="hidden" name="__csrf" value="${session.csrf_token}"${fa}><input type="hidden" name="next" value="${next}"${fa}>
    ${ASSERTION.map((n) => html`<input type="hidden" name="${n}"${fa}>`)}
    <button type="button" class="btn btn-hot login-passkey-button" hidden data-passkey="/a/${app.alias}/login/passkey/options" data-passkey-error="${t('login.passkey_failed')}"${fa}>${icon('fingerprint')} ${t('login.passkey')}</button>
    <p class="small login-passkey-status" role="status" data-passkey-status></p>
    <div class="or" role="separator"><span>${t('login.or')}</span></div>`;
  return o.formId
    ? html`<div class="login-passkey" data-passkey-block hidden>${fields}</div>`
    : html`<form method="post" action="/a/${app.alias}/login/passkey" class="login-passkey" data-passkey-block hidden>${fields}</form>`;
}

/** The detached form a login region's passkey button posts (its fields name it with the form attribute). */
export const passkeyForm = (app: App, formId: string): Raw | '' =>
  passkeyAlone(app) ? html`<form id="${formId}" method="post" action="/a/${app.alias}/login/passkey"></form>` : '';


/** Whether this request's host can have passkeys (a host name, not an IP address). */
export const passkeyHost = (req: { protocol: string; host: string }) => !isIP(relyingParty(req).rpId);

/** The application's mark on the sign-in card: its PWA icon, else its initial on the accent colour. */
export function appMark(app: App): Raw {
  if (app.pwa) return html`<img class="login-mark" src="/a/${app.alias}/icon-192.png" alt="" width="56" height="56">`;
  const initial = [...(app.name.trim() || app.alias)][0]?.toUpperCase() ?? '';
  return html`<span class="login-mark login-mark-letter" aria-hidden="true">${initial}</span>`;
}

/** The theme's colours on the sign-in pages (no page context there): a nonced <style>, or nothing. */
export function signInStyle(app: App, session: Session | undefined, nonce: string): Raw | '' {
  const css = themeCss(app.theme, chosenStyle(app, session));
  return css && nonce ? html`<style nonce="${nonce}">${raw(css)}</style>` : '';
}

/** <meta name="theme-color"> for a browser's address bar, also without the PWA. */
export const themeColorMeta = (app: App): Raw => html`<meta name="theme-color" content="${headerOf(app)}">`;

// ---------------------------------------------------------------- routes

interface LoginRequest {
  a: App;
  locale: Locale;
  session: Session;
  next?: string;
  ip: string;
  fail: (msg: string, code?: number) => Promise<unknown>;
}

interface Deps {
  /** routes.ts: app, session, CSRF, the methods the app allows, throttling by address (null after replying) */
  loginRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<LoginRequest | null>;
  /** routes.ts: the session for the user, the after-login processes */
  signIn: (req: FastifyRequest, reply: FastifyReply, a: App, oldSession: Session, username: string, opts: { method?: string; detail?: string }) => Promise<Session>;
  safeNext: (a: App, next: string | undefined) => string;
}

export async function passkeySigninRoutes(app: FastifyInstance, deps: Deps) {
  // the options for navigator.credentials.get(): a one-time challenge, any of the site's passkeys, the user verified
  app.post<{ Params: { alias: string }; Body: Record<string, string | undefined> }>('/a/:alias/login/passkey/options', async (req, reply) => {
    const a = await loadApp(req.params.alias);
    if (!a || !passkeyAlone(a)) return reply.code(404).send({ error: 'Passkey sign-in is off.' });
    const s = await getSession(req, reply, a.id, `/a/${a.alias}`);
    if (s.username || req.body?.__csrf !== s.csrf_token) return reply.code(403).send({ error: 'Reload the page.' });
    const rp = relyingParty(req);
    const challenge = giveChallenge(s, 'get');
    await saveState(s);
    return reply.header('cache-control', 'no-store').send({ mode: 'get', challenge, rpId: rp.rpId, allow: [], uv: 'required' });
  });

  app.post<{ Params: { alias: string }; Body: Record<string, string | undefined> }>('/a/:alias/login/passkey', async (req, reply) => {
    const r0 = await deps.loginRequest(req, reply);
    if (!r0) return;
    const { a, locale, session: s, next, ip, fail } = r0;
    // single use: the challenge leaves the session before anything is checked
    const challenge = takeChallenge(s, 'get');
    await saveState(s);
    const t = locale.t;
    const body = req.body ?? {};
    if (!passkeyAlone(a)) {
      await logActivity({ appId: a.id, username: null, event: 'login_failed', ip, detail: 'passkey: passkey sign-in is off' });
      return fail(t('login.method_unavailable'), 403);
    }
    const rp = relyingParty(req);
    const key = await accountPasskeyByCredential(a.id, String(body.credentialId ?? ''), rp.rpId);
    const who = key?.username ?? '';
    if (key && (await loginThrottled(a.id, who, ip))) {
      logActivity({ appId: a.id, username: who, event: 'login_locked', ip, detail: 'passkey' });
      return fail(t('login.throttled', { minutes: loginWindowMinutes() }), 429);
    }
    let why = key ? '' : 'unknown passkey';
    if (key && !challenge) why = 'no or an expired challenge';
    else if (key && body.userHandle && body.userHandle !== accountUserHandle(key.account_id)) why = 'the user handle does not match';
    else if (key && challenge) {
      try {
        const v = verifyAssertion(
          { clientDataJSON: String(body.clientDataJSON ?? ''), authenticatorData: String(body.authenticatorData ?? ''), signature: String(body.signature ?? '') },
          { alg: key.alg, jwk: key.public_key, signCount: Number(key.sign_count) }, { challenge, ...rp });
        if (!v.userVerified) why = 'the authenticator did not verify the user';
        else if (!(await useAccountPasskey(key.id, key.sign_count, v.signCount))) why = 'used at the same time elsewhere';
      } catch (e) {
        why = e instanceof WebAuthnError ? e.message : 'unreadable answer';
      }
    }
    if (!why && key && !key.active) why = 'account disabled';
    if (!why && key && !key.allowed) why = 'no access to the application';
    if (why) {
      await logActivity({ appId: a.id, username: who.slice(0, 100) || null, event: 'login_failed', ip, detail: `passkey: ${why}` });
      return fail(t('login.passkey_failed'), 401);
    }
    // the passkey and the user were right: an expired password is still changed with the password first
    if ((await passwordDaysLeft(who, a.id)) === 0) {
      logActivity({ appId: a.id, username: who, event: 'password_expired', ip, detail: 'passkey' });
      return fail(t('login.passkey_expired'), 403);
    }
    await markAccountSignIn(key!.account_id);
    const n = await deps.signIn(req, reply, a, s, who, { method: withSecondStep('passkey'), detail: 'passkey (user verified)' });
    markSecondStep(n.state);
    await saveState(n);
    return reply.redirect(deps.safeNext(a, next), 303);
  });
}
