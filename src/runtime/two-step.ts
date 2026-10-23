import { isIP } from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  accountCodesLeft, accountFactors, accountHasFactor, accountId, accountMustUseMfa, accountPasskeys, accountUserHandle, addAccountPasskey,
  addAccountTotp, checkAccountCode, confirmAccountCodes, EMAIL_CODE_MINUTES, emailCodeHash, emailCodeMatches, emailCodeTarget, markSecondStep,
  mfaOn, mfaRequired, newAccountCodes, newEmailCode, queueEmailCode, removeAccountFactor, secondStep, secondStepWithin, TOKEN_STEP_MINUTES,
  useAccountPasskey, withSecondStep,
} from '../account-mfa.ts';
import { issueApiToken, MAX_TOKEN_HOURS } from '../api.ts';
import { html, raw, type Raw } from '../html.ts';
import { documentShell } from '../layout.ts';
import { accountRoles, type App } from '../metadata.ts';
import { matchTotp, newTotpSecret, otpauthUri, unbase32 } from '../mfa.ts';
import { qrSvg } from '../qrcode.ts';
import { secretKeyConfigured } from '../secrets.ts';
import { loginWindowMinutes } from '../security.ts';
import { clientIp, getSession, loginThrottled, logActivity, saveState, type Session } from '../session.ts';
import { ALGORITHMS, giveChallenge, relyingParty, takeChallenge, verifyAssertion, verifyRegistration, WebAuthnError } from '../webauthn.ts';
import type { PageContext } from './context.ts';
import type { Locale } from './locale.ts';
import { pwaHead } from './pwa.ts';
import { appWithLocale, completeLogin, loadContext, rootAttrs, safeNext, signIn, type Req } from './routes.ts';

// (sprint 130, SEC-3) The second step of signing in to an application, and "Two-step sign-in" on My account.
//
// A password or LDAP sign-in that the application asks a second step of (src/account-mfa.ts) doesn't get a session
// yet: what it would have become is kept in the signed-out session for five minutes (ten while adding an app), and
// /a/<alias>/login/2fa asks for a code from the authenticator app or a recovery code. When the application requires
// the step and the user has no app yet, the same page shows a QR code first, then the recovery codes once. Wrong
// codes count as failed sign-ins (the same lockout). The sign-in's method gets "+2fa", so a remembered or shared
// sign-in made from it may skip the step later.
//
// (sprint 131, SEC-3 part 2) Passkeys (WebAuthn, src/webauthn.ts; public/app.js [data-passkey]) at the second step
// and on My account, also as the first factor a user adds while signing in; a code by e-mail when the application
// allows it, for users who have another factor; step-up: a signed-in user whose page needs a more recent second step
// comes here with ?next= and goes back after it (the session's __MFA_AT); and My account → REST API token.

const PENDING = '__MFA';
const STEP_SECONDS = 300;
const ENROL_SECONDS = 600;
const EMAILS_PER_STEP = 3;

interface Pending {
  u: string;
  next?: string;
  remember?: boolean;
  extraRoles?: string[];
  groups?: string[];
  method?: string;
  detail?: string;
  at: number;
  enrol?: boolean;
  /** (sprint 131) a signed-in user asked again (step-up): no new session, back to `next` */
  stepup?: boolean;
  /** while adding an app: the new secret, then (after its first code) the recovery codes to show once */
  secret?: string;
  codes?: string[];
  /** (sprint 131) what was added while signing in, for the activity log */
  added?: 'app' | 'passkey';
  /** (sprint 131) a code sent by e-mail: its hash, when, and how many were sent in this step */
  mail?: { h: string; at: number; n: number };
}

function pendingOf(s: Session): Pending | null {
  try {
    const p = JSON.parse(String(s.state[PENDING] ?? '')) as Pending;
    const limit = (p?.enrol ? ENROL_SECONDS : STEP_SECONDS) * 1000;
    if (!p || typeof p.u !== 'string' || Date.now() - Number(p.at) >= limit) return null;
    // a step-up belongs to the signed-in user; a sign-in's step to a signed-out session
    return !!p.stepup === !!s.username && (!p.stepup || p.u === s.username) ? p : null;
  } catch {
    return null;
  }
}

const keep = (s: Session, p: Pending) => { s.state[PENDING] = JSON.stringify(p); };

interface PasswordSignIn {
  next?: string;
  remember?: boolean;
  extraRoles?: string[];
  groups?: string[];
  method?: string;
  detail?: string;
}

/**
 * A password or LDAP sign-in that succeeded: signed in at once, or on to the second step when the application asks
 * for one of this user.
 */
export async function passwordSignIn(req: FastifyRequest, reply: FastifyReply, a: App, session: Session, username: string, opts: PasswordSignIn = {}) {
  const roles = [...(await accountRoles(a.id, username)), ...(opts.extraRoles ?? []).map((r) => r.toLowerCase())];
  const need = await secondStep(a, username, roles);
  if (!need) return completeLogin(req, reply, a, session, username, opts);
  keep(session, { u: username, ...opts, at: Date.now(), enrol: need === 'enrol' });
  await saveState(session);
  return reply.redirect(`/a/${a.alias}/login/2fa`, 303);
}

function card(a: App, locale: Locale, title: string, body: Raw, back = `/a/${a.alias}/login`) {
  return documentShell(
    `${title} · ${a.name}`,
    html`<main class="login">
      <div class="card login-card">
        <h1>${title}</h1>
        ${body}
        <a class="login-forgot" href="${back}">${locale.t('reset.back')}</a>
      </div>
    </main>`,
    'login-body',
    {},
    pwaHead(a),
    rootAttrs(locale),
  );
}

const csrfField = (s: Session) => html`<input type="hidden" name="__csrf" value="${s.csrf_token}">`;
const alert = (error?: string, kind = 'error') => html`${error ? html`<div class="alert alert-${kind}" role="${kind === 'error' ? 'alert' : 'status'}">${error}</div>` : ''}`;
const grouped = (secret: string) => secret.replace(/(.{4})/g, '$1 ').trim();

function codesList(codes: string[]) {
  return html`<ol class="mfa-codes">${codes.map((c) => html`<li><code>${c}</code></li>`)}</ol>`;
}

/** The hidden fields public/app.js fills with the browser's WebAuthn answer. */
const passkeyFields = (names: string[]) => html`${names.map((n) => html`<input type="hidden" name="${n}">`)}`;
const ASSERTION = ['credentialId', 'clientDataJSON', 'authenticatorData', 'signature', 'userHandle'];
const ATTESTATION = ['clientDataJSON', 'attestationObject', 'transports'];

/** What the second step's page offers besides a code. */
interface Offers { passkey: boolean; mail: boolean; newPasskey: boolean; notice?: string }

/** The second step's page: a code; or a new app (QR code, then its first code); or the recovery codes, once. */
function stepPage(a: App, locale: Locale, s: Session, p: Pending, offers: Offers, error?: string) {
  const t = locale.t;
  const action = `/a/${a.alias}/login/2fa`;
  const back = p.stepup ? safeNext(a, p.next) : undefined;
  if (p.codes)
    return card(a, locale, t('mfa.codes_title'), html`<p>${t('mfa.codes_once')}</p>${codesList(p.codes)}
      <form method="post" action="${action}/done" class="login-form">${csrfField(s)}
        <label class="check"><input type="checkbox" name="saved" value="1" required> ${t('mfa.codes_saved')}</label>
        <button class="btn btn-hot">${t('mfa.continue')}</button></form>`);
  if (p.enrol && (p.secret || offers.newPasskey))
    return card(a, locale, t('mfa.enrol_title'), html`<p class="muted">${t('mfa.enrol_intro')}</p>${alert(error)}
      ${p.secret
        ? html`<ol class="mfa-steps">
            <li>${t('mfa.scan')}</li>
            <li>${t('mfa.or_enter')} <code class="mfa-secret">${grouped(p.secret)}</code></li>
            <li>${t('mfa.enter_code')}</li>
          </ol>
          <div class="mfa-qr">${raw(qrSvg(otpauthUri(p.secret, p.u, a.name), { label: t('mfa.qr_label'), px: 4 }) ?? '')}</div>
          <form method="post" action="${action}" class="login-form">${csrfField(s)}
            <div class="field"><label class="label" for="code">${t('mfa.code')}</label><input id="code" name="code" required inputmode="numeric" autocomplete="one-time-code" maxlength="7" autofocus></div>
            <button class="btn btn-hot">${t('mfa.verify')}</button></form>`
        : ''}
      ${offers.newPasskey
        ? html`<form method="post" action="${action}/passkey/new" class="login-form mfa-passkey">${csrfField(s)}${passkeyFields(ATTESTATION)}
            <p class="muted">${p.secret ? t('mfa.or_passkey') : t('mfa.passkey_intro')}</p>
            <button class="btn${p.secret ? '' : ' btn-hot'}" hidden data-passkey="${action}/passkey/new/options" data-passkey-error="${t('mfa.passkey_failed')}">${t('mfa.add_passkey')}</button>
            <p class="small" role="status" data-passkey-status></p></form>`
        : ''}`);
  return card(a, locale, p.stepup ? t('mfa.stepup_title') : t('mfa.step_title'), html`<p class="muted">${p.stepup ? t('mfa.stepup_intro') : t('mfa.step_intro')}</p>
    ${alert(offers.notice, 'success')}${alert(error)}
    <form method="post" action="${action}" class="login-form">${csrfField(s)}
      <div class="field"><label class="label" for="code">${t('mfa.code')}</label><input id="code" name="code" required autocomplete="one-time-code" maxlength="20" spellcheck="false" autocapitalize="off" autofocus></div>
      <button class="btn btn-hot">${t('mfa.verify')}</button></form>
    ${offers.passkey
      ? html`<form method="post" action="${action}/passkey" class="login-form mfa-passkey">${csrfField(s)}${passkeyFields(ASSERTION)}
          <button class="btn" hidden data-passkey="${action}/passkey/options" data-passkey-error="${t('mfa.passkey_failed')}">${t('mfa.use_passkey')}</button>
          <p class="small" role="status" data-passkey-status></p></form>`
      : ''}
    ${offers.mail
      ? html`<form method="post" action="${action}/email" class="login-form">${csrfField(s)}<button class="link-button">${t('mfa.email_send')}</button></form>`
      : ''}`, back);
}

/** The signed-out session's pending sign-in (or a signed-in user's step-up), or a page that says it expired. */
async function start(req: Req, reply: FastifyReply) {
  const loaded = await appWithLocale(req, req.params.alias);
  if (!loaded) return null;
  const session = await getSession(req, reply, loaded.app.id, `/a/${loaded.app.alias}`);
  const { app: a, locale } = (await appWithLocale(req, req.params.alias, session))!;
  return { a, locale, session, p: pendingOf(session) };
}

const expired = async (reply: FastifyReply, a: App, locale: Locale, s: Session) => {
  const wasStepUp = !!s.username;
  delete s.state[PENDING];
  await saveState(s);
  if (wasStepUp) return reply.redirect(`/a/${a.alias}/${a.home_page}`, 303);
  return reply.code(410).type('text/html').send(card(a, locale, locale.t('mfa.step_title'), alert(locale.t('mfa.expired'))));
};

/** What the page offers this user here: their passkeys for this site, an e-mail code, a new passkey while enrolling. */
async function offersFor(req: FastifyRequest, a: App, p: Pending, id: number, notice?: string): Promise<Offers> {
  const rp = relyingParty(req);
  const host = !isIP(rp.rpId);
  const [keys, mail] = await Promise.all([accountPasskeys(id, rp.rpId), p.enrol ? null : emailCodeTarget(a, id)]);
  return { passkey: host && keys.length > 0, mail: !!mail && (p.mail?.n ?? 0) < EMAILS_PER_STEP, newPasskey: host && !!p.enrol && !p.codes, notice };
}

/** Signed in (or, for a step-up, confirmed) with the pending sign-in's options, now with "+2fa" in its method. */
async function finish(req: Req, reply: FastifyReply, a: App, s: Session, p: Pending, detail: string, next?: string, flash?: string) {
  if (p.stepup) {
    delete s.state[PENDING];
    markSecondStep(s.state);
    if (flash) s.state.__FLASH = flash;
    await saveState(s);
    await logActivity({ appId: a.id, username: p.u, event: '2fa_stepup', ip: clientIp(req), detail });
    return reply.redirect(safeNext(a, p.next), 303);
  }
  const n = await signIn(req, reply, a, s, p.u, {
    extraRoles: p.extraRoles, groups: p.groups, remember: p.remember, method: withSecondStep(p.method),
    detail: `${p.detail ?? 'password'} ${detail}`,
  });
  markSecondStep(n.state);
  if (flash) n.state.__FLASH = flash;
  await saveState(n);
  return reply.redirect(next ?? safeNext(a, p.next), 303);
}

/** Too many wrong codes: the same lockout as wrong passwords. Returns a reply when locked. */
async function locked(reply: FastifyReply, a: App, locale: Locale, s: Session, p: Pending, ip: string, what: string) {
  if (!(await loginThrottled(a.id, p.u, ip))) return null;
  logActivity({ appId: a.id, username: p.u, event: 'login_locked', ip, detail: what });
  delete s.state[PENDING];
  await saveState(s);
  return reply.code(429).type('text/html').send(card(a, locale, locale.t('mfa.step_title'), alert(locale.t('login.throttled', { minutes: loginWindowMinutes() }))));
}

export async function twoStepRoutes(app: FastifyInstance) {
  app.get('/a/:alias/login/2fa', async (req: Req, reply) => {
    const r = await start(req, reply);
    if (!r) return reply.code(404).send('Not found');
    const { a, locale, session: s } = r;
    let p = r.p;
    // (sprint 131) step-up: a signed-in user sent here by a page that needs a more recent second step
    const next = typeof (req.query as { next?: unknown }).next === 'string' ? String((req.query as { next: string }).next).slice(0, 2000) : undefined;
    if (s.username && (!p || (next && p.next !== next))) {
      const id = await accountId(s.username);
      if (id === null || !(await accountHasFactor(id)))
        return reply.code(403).type('text/html').send(card(a, locale, locale.t('mfa.stepup_title'),
          html`${alert(locale.t('mfa.stepup_none'))}<p><a class="btn" href="/a/${a.alias}/account#two-step">${locale.t('mfa.my_account')}</a></p>`, `/a/${a.alias}/${a.home_page}`));
      p = { u: s.username, next, at: Date.now(), stepup: true };
      keep(s, p);
    }
    if (!p) return expired(reply, a, locale, s);
    const id = await accountId(p.u);
    if (id === null) return expired(reply, a, locale, s);
    const offers = await offersFor(req, a, p, id);
    if (p.enrol && !p.codes && !(await accountHasFactor(id))) {
      // fail closed: without the instance key there is nowhere safe to keep the app's secret (a passkey needs none)
      if (!secretKeyConfigured() && !offers.newPasskey)
        return reply.code(503).type('text/html').send(card(a, locale, locale.t('mfa.enrol_title'), alert(locale.t('mfa.no_key'))));
      if (!p.secret && secretKeyConfigured()) {
        p.secret = newTotpSecret();
        keep(s, p);
      }
    }
    await saveState(s);
    return reply.header('cache-control', 'no-store').type('text/html').send(stepPage(a, locale, s, p, offers));
  });

  app.post('/a/:alias/login/2fa', async (req: Req, reply) => {
    const r = await start(req, reply);
    if (!r) return reply.code(404).send('Not found');
    const { a, locale, session: s, p } = r;
    const t = locale.t;
    if (!p || req.body?.__csrf !== s.csrf_token) return expired(reply, a, locale, s);
    const ip = clientIp(req);
    const id = await accountId(p.u);
    if (id === null) return expired(reply, a, locale, s);
    const lock = await locked(reply, a, locale, s, p, ip, '2fa');
    if (lock) return lock;
    const code = String(req.body?.code ?? '').slice(0, 40);
    const wrong = async (detail: string) => {
      await logActivity({ appId: a.id, username: p.u, event: 'login_failed', ip, detail });
      return reply.code(401).type('text/html').send(stepPage(a, locale, s, p, await offersFor(req, a, p, id), t('mfa.wrong')));
    };
    // adding the first app while signing in: its first code proves it works
    if (p.enrol && p.secret && !p.codes) {
      const step = matchTotp(unbase32(p.secret), code.replace(/\s/g, ''), null);
      if (step === null) return wrong('2fa (new app)');
      await addAccountTotp(id, t('mfa.app_default'), p.secret, step);
      await logActivity({ appId: a.id, username: p.u, event: '2fa_enrolled', ip, detail: 'authenticator app (sign-in)' });
      p.codes = await newAccountCodes(id);
      p.added = 'app';
      delete p.secret;
      keep(s, p);
      await saveState(s);
      return reply.type('text/html').send(stepPage(a, locale, s, p, await offersFor(req, a, p, id)));
    }
    if (p.enrol) return expired(reply, a, locale, s);
    // (sprint 131) the code sent by e-mail, valid for some minutes and once
    if (p.mail && Date.now() - p.mail.at < EMAIL_CODE_MINUTES * 60_000 && emailCodeMatches(p.mail.h, code)) {
      delete p.mail;
      keep(s, p);
      return finish(req, reply, a, s, p, '2fa (e-mail code)');
    }
    const ok = await checkAccountCode(id, code);
    if (!ok) return wrong('2fa');
    if (ok.kind === 'recovery') {
      const left = await accountCodesLeft(id);
      await logActivity({ appId: a.id, username: p.u, event: '2fa_recovery_used', ip, detail: `${left} left` });
      // to My account: one code fewer, maybe time for new ones
      return finish(req, reply, a, s, p, '2fa (recovery code)', p.stepup ? undefined : `/a/${a.alias}/account#two-step`, t('mfa.recovery_used', { n: left }));
    }
    return finish(req, reply, a, s, p, '2fa');
  });

  // (sprint 131) a code by e-mail, for a user who has an authenticator app or a passkey (never the only factor)
  app.post('/a/:alias/login/2fa/email', async (req: Req, reply) => {
    const r = await start(req, reply);
    if (!r) return reply.code(404).send('Not found');
    const { a, locale, session: s, p } = r;
    const t = locale.t;
    if (!p || p.enrol || req.body?.__csrf !== s.csrf_token) return expired(reply, a, locale, s);
    const ip = clientIp(req);
    const id = await accountId(p.u);
    if (id === null) return expired(reply, a, locale, s);
    const lock = await locked(reply, a, locale, s, p, ip, '2fa e-mail');
    if (lock) return lock;
    const target = (p.mail?.n ?? 0) < EMAILS_PER_STEP ? await emailCodeTarget(a, id) : null;
    const code = newEmailCode();
    const sent = !!target && (await queueEmailCode(a, p.u, target,
      t('mfa.email_subject', { app: a.name }), t('mfa.email_body', { app: a.name, code, minutes: EMAIL_CODE_MINUTES })));
    if (sent) {
      p.mail = { h: emailCodeHash(code), at: Date.now(), n: (p.mail?.n ?? 0) + 1 };
      keep(s, p);
      await logActivity({ appId: a.id, username: p.u, event: '2fa_email', ip, detail: 'code sent' });
    }
    await saveState(s);
    const offers = await offersFor(req, a, p, id, sent ? t('mfa.email_sent', { minutes: EMAIL_CODE_MINUTES }) : undefined);
    return reply.code(sent ? 200 : 429).type('text/html').send(stepPage(a, locale, s, p, offers, sent ? undefined : t('mfa.email_failed')));
  });

  // (sprint 131) the second step with a passkey: options for navigator.credentials.get(), then the browser's answer
  app.post('/a/:alias/login/2fa/passkey/options', async (req: Req, reply) => {
    const r = await start(req, reply);
    if (!r) return reply.code(404).send('Not found');
    const { session: s, p } = r;
    if (!p || p.enrol || req.body?.__csrf !== s.csrf_token) return reply.code(403).send('Sign in again.');
    const id = await accountId(p.u);
    const rp = relyingParty(req);
    const keys = id === null ? [] : await accountPasskeys(id, rp.rpId);
    if (!keys.length) return reply.code(404).send('No passkey for this site.');
    const challenge = giveChallenge(s, 'get');
    await saveState(s);
    return reply.header('cache-control', 'no-store').send({ mode: 'get', challenge, rpId: rp.rpId, allow: keys.map((k) => ({ id: k.credential_id, transports: k.transports })) });
  });

  app.post('/a/:alias/login/2fa/passkey', async (req: Req, reply) => {
    const r = await start(req, reply);
    if (!r) return reply.code(404).send('Not found');
    const { a, locale, session: s, p } = r;
    const challenge = takeChallenge(s, 'get');
    if (!p || p.enrol || req.body?.__csrf !== s.csrf_token) return expired(reply, a, locale, s);
    const ip = clientIp(req);
    const id = await accountId(p.u);
    if (id === null) return expired(reply, a, locale, s);
    const lock = await locked(reply, a, locale, s, p, ip, '2fa passkey');
    if (lock) return lock;
    const rp = relyingParty(req);
    const key = (await accountPasskeys(id, rp.rpId)).find((k) => k.credential_id === String(req.body?.credentialId ?? ''));
    let why = key ? '' : 'unknown passkey';
    if (key && !challenge) why = 'no or an expired challenge';
    if (key && challenge) {
      try {
        const v = verifyAssertion(
          { clientDataJSON: String(req.body?.clientDataJSON ?? ''), authenticatorData: String(req.body?.authenticatorData ?? ''), signature: String(req.body?.signature ?? '') },
          { alg: key.alg, jwk: key.public_key, signCount: Number(key.sign_count) }, { challenge, ...rp });
        if (!(await useAccountPasskey(key.id, key.sign_count, v.signCount))) why = 'used at the same time elsewhere';
      } catch (e) {
        why = e instanceof WebAuthnError ? e.message : 'unreadable answer';
      }
    }
    if (why) {
      await logActivity({ appId: a.id, username: p.u, event: 'login_failed', ip, detail: `2fa passkey: ${why}` });
      await saveState(s);
      return reply.code(401).type('text/html').send(stepPage(a, locale, s, p, await offersFor(req, a, p, id), locale.t('mfa.passkey_failed')));
    }
    return finish(req, reply, a, s, p, '2fa (passkey)');
  });

  // (sprint 131) adding a passkey as the first factor while signing in (the application requires one)
  app.post('/a/:alias/login/2fa/passkey/new/options', async (req: Req, reply) => {
    const r = await start(req, reply);
    if (!r) return reply.code(404).send('Not found');
    const { a, session: s, p } = r;
    if (!p?.enrol || p.codes || req.body?.__csrf !== s.csrf_token) return reply.code(403).send('Sign in again.');
    const id = await accountId(p.u);
    if (id === null) return reply.code(403).send('Sign in again.');
    return reply.header('cache-control', 'no-store').send(await createOptions(req, s, a, id, p.u));
  });

  app.post('/a/:alias/login/2fa/passkey/new', async (req: Req, reply) => {
    const r = await start(req, reply);
    if (!r) return reply.code(404).send('Not found');
    const { a, locale, session: s, p } = r;
    const t = locale.t;
    const challenge = takeChallenge(s, 'create');
    if (!p?.enrol || p.codes || req.body?.__csrf !== s.csrf_token) return expired(reply, a, locale, s);
    const id = await accountId(p.u);
    if (id === null) return expired(reply, a, locale, s);
    const ip = clientIp(req);
    const added = challenge ? await registerPasskey(req, a, id, p.u, challenge, t('mfa.passkey_default'), ip, 'sign-in') : 'expired';
    if (added !== 'ok') {
      await saveState(s);
      return reply.code(422).type('text/html').send(stepPage(a, locale, s, p, await offersFor(req, a, p, id), t(added === 'known' ? 'mfa.passkey_known' : 'mfa.passkey_failed')));
    }
    p.codes = await newAccountCodes(id);
    p.added = 'passkey';
    delete p.secret;
    keep(s, p);
    await saveState(s);
    return reply.type('text/html').send(stepPage(a, locale, s, p, await offersFor(req, a, p, id)));
  });

  // the recovery codes were shown once after adding the first app or passkey while signing in
  app.post('/a/:alias/login/2fa/done', async (req: Req, reply) => {
    const r = await start(req, reply);
    if (!r) return reply.code(404).send('Not found');
    const { a, locale, session: s, p } = r;
    if (!p?.codes || req.body?.__csrf !== s.csrf_token) return expired(reply, a, locale, s);
    const id = await accountId(p.u);
    if (id === null) return expired(reply, a, locale, s);
    if (req.body?.saved !== '1') return reply.code(422).type('text/html').send(stepPage(a, locale, s, p, await offersFor(req, a, p, id)));
    await confirmAccountCodes(id);
    return finish(req, reply, a, s, p, `2fa (new ${p.added === 'passkey' ? 'passkey' : 'app'})`);
  });

  // ---------------------------------------------------------------- My account → Two-step sign-in
  const SECRET_MINUTES = 10;
  const signedIn = async (req: Req, reply: FastifyReply) => {
    const ctx = await loadContext(req, reply, { pageNo: 'home' });
    if (!ctx) return null;
    const id = await accountId(ctx.user);
    if (req.body?.__csrf !== ctx.session.csrf_token || !mfaOn(ctx.app) || id === null) {
      reply.redirect(`${ctx.base}/account`, 303);
      return null;
    }
    return { ctx, id };
  };
  const done = async (reply: FastifyReply, ctx: PageContext, flash?: string, error?: boolean, anchor = 'two-step') => {
    if (flash) ctx.session.state[error ? '__FLASH_ERROR' : '__FLASH'] = flash;
    await saveState(ctx.session);
    return reply.redirect(`${ctx.base}/account#${anchor}`, 303);
  };

  app.post('/a/:alias/account/2fa/start', async (req: Req, reply) => {
    const r = await signedIn(req, reply);
    if (!r) return;
    if (secretKeyConfigured()) r.ctx.session.state.__TOTP_NEW = JSON.stringify({ secret: newTotpSecret(), at: Date.now() });
    return done(reply, r.ctx);
  });

  app.post('/a/:alias/account/2fa/cancel', async (req: Req, reply) => {
    const r = await signedIn(req, reply);
    if (!r) return;
    delete r.ctx.session.state.__TOTP_NEW;
    return done(reply, r.ctx);
  });

  app.post('/a/:alias/account/2fa/confirm', async (req: Req, reply) => {
    const r = await signedIn(req, reply);
    if (!r) return;
    const { ctx, id } = r;
    const t = ctx.locale.t;
    const pending = newSecret(ctx.session, SECRET_MINUTES);
    if (!pending) {
      delete ctx.session.state.__TOTP_NEW;
      return done(reply, ctx, t('mfa.expired'), true);
    }
    const step = matchTotp(unbase32(pending), String(req.body?.code ?? '').replace(/\s/g, ''), null);
    if (step === null) return done(reply, ctx, t('mfa.wrong'), true);
    const first = !(await accountHasFactor(id));
    await addAccountTotp(id, String(req.body?.name ?? '') || t('mfa.app_default'), pending, step);
    delete ctx.session.state.__TOTP_NEW;
    await logActivity({ appId: ctx.app.id, username: ctx.user, event: '2fa_enrolled', ip: ctx.ip, detail: 'authenticator app' });
    if (first || !(await accountCodesLeft(id))) ctx.session.state.__CODES_NEW = JSON.stringify(await newAccountCodes(id));
    return done(reply, ctx, t('mfa.added'));
  });

  // (sprint 131) a passkey on My account: the options for navigator.credentials.create(), then the browser's answer
  app.post('/a/:alias/account/2fa/passkey/options', async (req: Req, reply) => {
    const r = await signedIn(req, reply);
    if (!r) return;
    await saveState(r.ctx.session);
    return reply.header('cache-control', 'no-store').send(await createOptions(req, r.ctx.session, r.ctx.app, r.id, r.ctx.user));
  });

  app.post('/a/:alias/account/2fa/passkey', async (req: Req, reply) => {
    const r = await signedIn(req, reply);
    if (!r) return;
    const { ctx, id } = r;
    const t = ctx.locale.t;
    const challenge = takeChallenge(ctx.session, 'create');
    if (!challenge) return done(reply, ctx, t('mfa.expired'), true);
    const first = !(await accountHasFactor(id));
    const added = await registerPasskey(req, ctx.app, id, ctx.user, challenge, String(req.body?.pk_name ?? '') || t('mfa.passkey_default'), ctx.ip, 'My account');
    if (added !== 'ok') return done(reply, ctx, t(added === 'known' ? 'mfa.passkey_known' : 'mfa.passkey_failed'), true);
    if (first || !(await accountCodesLeft(id))) ctx.session.state.__CODES_NEW = JSON.stringify(await newAccountCodes(id));
    return done(reply, ctx, t('mfa.passkey_added'));
  });

  app.post('/a/:alias/account/2fa/codes', async (req: Req, reply) => {
    const r = await signedIn(req, reply);
    if (!r) return;
    if (!(await accountHasFactor(r.id))) return done(reply, r.ctx);
    r.ctx.session.state.__CODES_NEW = JSON.stringify(await newAccountCodes(r.id));
    await logActivity({ appId: r.ctx.app.id, username: r.ctx.user, event: '2fa_codes', ip: r.ctx.ip, detail: 'new recovery codes' });
    return done(reply, r.ctx);
  });

  app.post('/a/:alias/account/2fa/codes/confirm', async (req: Req, reply) => {
    const r = await signedIn(req, reply);
    if (!r) return;
    if (req.body?.saved !== '1') return done(reply, r.ctx);
    await confirmAccountCodes(r.id);
    delete r.ctx.session.state.__CODES_NEW;
    return done(reply, r.ctx);
  });

  // removing an app or a passkey asks for a code (from any app, or a recovery code): a session left open is not enough
  app.post('/a/:alias/account/2fa/:id/delete', async (req: Req, reply) => {
    const r = await signedIn(req, reply);
    if (!r) return;
    const { ctx, id } = r;
    const t = ctx.locale.t;
    if (await loginThrottled(ctx.app.id, ctx.user, ctx.ip)) {
      logActivity({ appId: ctx.app.id, username: ctx.user, event: 'login_locked', ip: ctx.ip, detail: '2fa remove' });
      return done(reply, ctx, t('login.throttled', { minutes: loginWindowMinutes() }), true);
    }
    const factors = await accountFactors(id);
    const factorId = Number((req.params as { id?: string }).id);
    const factor = factors.find((f) => f.id === factorId);
    if (!factor) return done(reply, ctx);
    if (factors.length === 1 && mfaRequired(ctx.app, ctx.roles)) return done(reply, ctx, t('mfa.keep_one'), true);
    if (!(await checkAccountCode(id, String(req.body?.code ?? '').slice(0, 40)))) {
      await logActivity({ appId: ctx.app.id, username: ctx.user, event: 'login_failed', ip: ctx.ip, detail: '2fa remove' });
      return done(reply, ctx, t('mfa.wrong'), true);
    }
    await removeAccountFactor(id, factorId);
    await logActivity({ appId: ctx.app.id, username: ctx.user, event: '2fa_removed', ip: ctx.ip, detail: factor.kind === 'passkey' ? 'passkey' : 'authenticator app' });
    return done(reply, ctx, t(factor.kind === 'passkey' ? 'mfa.passkey_removed' : 'mfa.removed'));
  });

  // ---------------------------------------------------------------- My account → REST API token (sprint 131)
  // Only when the application lets users create their own (meta.app.api_self_tokens). A user the application
  // requires a second step of gives one first, unless the session had one in the last 15 minutes. The token is
  // kept in the session until the page has shown it once.
  app.post('/a/:alias/account/token', async (req: Req, reply) => {
    const ctx = await loadContext(req, reply, { pageNo: 'home' });
    if (!ctx) return;
    const t = ctx.locale.t;
    if (req.body?.__csrf !== ctx.session.csrf_token || !ctx.app.api_self_tokens || ctx.user === 'nobody') return reply.redirect(`${ctx.base}/account`, 303);
    if ((await accountMustUseMfa(ctx.app, ctx.user)) && !secondStepWithin(ctx.session.state, TOKEN_STEP_MINUTES)) {
      ctx.session.state.__FLASH = t('token.step_first');
      await saveState(ctx.session);
      return reply.redirect(`${ctx.base}/login/2fa?next=${encodeURIComponent(`${ctx.base}/account#api-token`)}`, 303);
    }
    try {
      const issued = await issueApiToken(ctx.app.id, ctx.user, Number(req.body?.hours) || 8, { self: true });
      ctx.session.state.__TOKEN_NEW = JSON.stringify({ token: issued.token, hours: issued.expiresInHours });
      await logActivity({ appId: ctx.app.id, username: issued.username, event: 'api_token', ip: ctx.ip, detail: `by the user on My account, ${issued.expiresInHours} h` });
      return done(reply, ctx, undefined, false, 'api-token');
    } catch (e) {
      return done(reply, ctx, (e as Error).message, true, 'api-token');
    }
  });
}

/** WebAuthn options for adding a passkey to an account (a one-time challenge kept in the session). */
async function createOptions(req: FastifyRequest, s: Session, a: App, id: number, username: string) {
  const rp = relyingParty(req);
  const challenge = giveChallenge(s, 'create');
  await saveState(s);
  return {
    mode: 'create', challenge, rp: { id: rp.rpId, name: a.name }, algs: ALGORITHMS,
    // a stable handle that isn't the user name (the authenticator may show it, but it says nothing)
    user: { id: accountUserHandle(id), name: username, displayName: username },
    exclude: (await accountPasskeys(id, rp.rpId)).map((k) => k.credential_id),
  };
}

/** Check the browser's answer and keep the passkey: 'ok', 'known' (added already) or 'failed'. */
async function registerPasskey(req: Req, a: App, id: number, username: string, challenge: string, name: string, ip: string, where: string) {
  const rp = relyingParty(req);
  let reg;
  try {
    reg = verifyRegistration({ clientDataJSON: String(req.body?.clientDataJSON ?? ''), attestationObject: String(req.body?.attestationObject ?? '') }, { challenge, ...rp });
  } catch (e) {
    await logActivity({ appId: a.id, username, event: '2fa_refused', ip, detail: `passkey: ${e instanceof WebAuthnError ? e.message : 'unreadable answer'}` });
    return 'failed' as const;
  }
  try {
    await addAccountPasskey(id, name, { ...reg, rpId: rp.rpId, transports: String(req.body?.transports ?? '').split(',').filter(Boolean) });
  } catch {
    return 'known' as const;
  }
  await logActivity({ appId: a.id, username, event: '2fa_enrolled', ip, detail: `passkey (${rp.rpId}, ${where})` });
  return 'ok' as const;
}

/** The app secret being added on My account (kept in the session for some minutes), or null. */
function newSecret(s: Session, minutes: number): string | null {
  try {
    const p = JSON.parse(String(s.state.__TOTP_NEW ?? ''));
    return p && typeof p.secret === 'string' && Date.now() - Number(p.at) < minutes * 60_000 ? p.secret : null;
  } catch {
    return null;
  }
}

/** Something kept in the session to show once (recovery codes, a token), taken out. */
function takeOnce<T>(s: Session, key: string): T | null {
  try {
    const v = JSON.parse(String(s.state[key] ?? ''));
    return v ?? null;
  } catch {
    return null;
  }
}

/** My account → Two-step sign-in (when the application has a second step). */
export async function twoStepSection(ctx: PageContext, rpId = ''): Promise<Raw | ''> {
  if (!mfaOn(ctx.app)) return '';
  const id = await accountId(ctx.user);
  if (id === null) return '';
  const t = ctx.locale.t;
  const [factors, left] = await Promise.all([accountFactors(id), accountCodesLeft(id)]);
  const required = mfaRequired(ctx.app, ctx.roles);
  const pending = newSecret(ctx.session, 10);
  const shown = takeOnce<string[]>(ctx.session, '__CODES_NEW');
  const error = typeof ctx.session.state.__FLASH_ERROR === 'string' ? ctx.session.state.__FLASH_ERROR : '';
  delete ctx.session.state.__FLASH_ERROR;
  const base = `${ctx.base}/account/2fa`;
  const csrf = html`<input type="hidden" name="__csrf" value="${ctx.session.csrf_token}">`;
  const when = (v: string | null) => (v ? String(v).slice(0, 10) : '');
  return html`<section class="region region-standard col-6" id="two-step"><header class="region-header"><h2>${t('mfa.step_title')}</h2></header><div class="region-body">
    ${error ? html`<div class="alert alert-error" role="alert">${error}</div>` : ''}
    <p class="muted u-mt0">${factors.length ? t('mfa.on_any') : required ? t('mfa.required_you') : t('mfa.off')}</p>
    ${Array.isArray(shown)
      ? html`<h3>${t('mfa.codes_title')}</h3><p>${t('mfa.codes_once')}</p>${codesList(shown)}
        <form method="post" action="${base}/codes/confirm">${csrf}
          <label class="check"><input type="checkbox" name="saved" value="1" required> ${t('mfa.codes_saved')}</label>
          <div class="buttons"><button class="btn btn-hot">${t('mfa.continue')}</button></div></form>`
      : ''}
    ${factors.length
      ? html`<ul class="mfa-factors">${factors.map((f) => html`<li><strong>${f.name}</strong> <span class="muted">${f.kind === 'passkey' ? t('mfa.kind_passkey') : t('mfa.kind_app')} · ${when(f.created_at)}</span>
          ${f.kind === 'passkey' && rpId && f.rp_id !== rpId ? html` <span class="badge">${f.rp_id}</span>` : ''}
          <details><summary class="link-button">${t('mfa.remove')}</summary>
            <form method="post" action="${base}/${f.id}/delete">${csrf}
              <div class="field"><label class="label" for="rm_${f.id}">${t('mfa.remove_code')}</label><input id="rm_${f.id}" name="code" required autocomplete="one-time-code" maxlength="20"></div>
              <div class="buttons"><button class="btn btn-danger">${t('mfa.remove')}</button></div></form></details></li>`)}</ul>
        <p>${t('mfa.codes_left', { n: left })}</p>
        <form method="post" action="${base}/codes">${csrf}<button class="btn">${t('mfa.codes_new')}</button></form>`
      : ''}
    ${pending
      ? html`<h3>${t('mfa.add_app')}</h3>
        <ol class="mfa-steps"><li>${t('mfa.scan')}</li><li>${t('mfa.or_enter')} <code class="mfa-secret">${grouped(pending)}</code></li><li>${t('mfa.enter_code')}</li></ol>
        <div class="mfa-qr">${raw(qrSvg(otpauthUri(pending, ctx.user, ctx.app.name), { label: t('mfa.qr_label'), px: 4 }) ?? '')}</div>
        <form method="post" action="${base}/confirm">${csrf}
          <div class="field"><label class="label" for="mfa_name">${t('mfa.app_name')}</label><input id="mfa_name" name="name" value="${t('mfa.app_default')}" required maxlength="60"></div>
          <div class="field"><label class="label" for="mfa_code">${t('mfa.code')}</label><input id="mfa_code" name="code" required inputmode="numeric" autocomplete="one-time-code" maxlength="7"></div>
          <div class="buttons"><button class="btn btn-hot">${t('mfa.confirm_app')}</button></div></form>
        <form method="post" action="${base}/cancel">${csrf}<button class="link-button">${t('mfa.cancel')}</button></form>`
      : secretKeyConfigured()
        ? html`<form method="post" action="${base}/start">${csrf}<div class="buttons"><button class="btn${factors.length ? '' : ' btn-hot'}">${t('mfa.add_app')}</button></div></form>`
        : html`<p class="alert alert-info" role="status">${t('mfa.no_key')}</p>`}
    ${pending
      ? ''
      : html`<h3>${t('mfa.kind_passkey')}</h3><p class="muted u-mt0">${t('mfa.passkey_intro')}</p>
        ${rpId && isIP(rpId)
          ? html`<p class="alert alert-info" role="status">${t('mfa.passkey_needs_host')}</p>`
          : html`<form method="post" action="${base}/passkey" class="mfa-passkey">${csrf}${passkeyFields(ATTESTATION)}
              <div class="field"><label class="label" for="pk_name">${t('mfa.app_name')}</label><input id="pk_name" name="pk_name" value="${t('mfa.passkey_default')}" required maxlength="60"></div>
              <div class="buttons"><button class="btn" hidden data-passkey="${base}/passkey/options" data-passkey-error="${t('mfa.passkey_failed')}">${t('mfa.add_passkey')}</button></div>
              <p class="small" role="status" data-passkey-status></p>
              <noscript><p class="muted small">${t('mfa.passkey_needs_js')}</p></noscript></form>`}`}
  </div></section>`;
}

/** (sprint 131) My account → REST API token, when the application lets users create their own. */
export async function tokenSection(ctx: PageContext): Promise<Raw | ''> {
  if (!ctx.app.api_self_tokens || (await accountId(ctx.user)) === null) return '';
  const t = ctx.locale.t;
  const issued = takeOnce<{ token: string; hours: number }>(ctx.session, '__TOKEN_NEW');
  delete ctx.session.state.__TOKEN_NEW;
  const needsStep = await accountMustUseMfa(ctx.app, ctx.user);
  const csrf = html`<input type="hidden" name="__csrf" value="${ctx.session.csrf_token}">`;
  return html`<section class="region region-standard col-6" id="api-token"><header class="region-header"><h2>${t('token.title')}</h2></header><div class="region-body">
    <p class="muted u-mt0">${t('token.intro')}${needsStep ? html` ${t('token.needs_step')}` : ''}</p>
    ${issued?.token
      ? html`<div class="field"><label class="label" for="api_token">${t('token.shown_once', { hours: issued.hours })}</label>
          <textarea id="api_token" rows="4" readonly spellcheck="false">${issued.token}</textarea></div>`
      : ''}
    <form method="post" action="${ctx.base}/account/token">${csrf}
      <div class="field"><label class="label" for="token_hours">${t('token.hours')}</label><input id="token_hours" name="hours" type="number" min="1" max="${MAX_TOKEN_HOURS}" value="8" required></div>
      <div class="buttons"><button class="btn">${t('token.create')}</button></div></form>
  </div></section>`;
}
