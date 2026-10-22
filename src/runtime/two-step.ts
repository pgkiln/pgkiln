import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  accountCodesLeft, accountFactors, accountHasFactor, accountId, addAccountTotp, checkAccountCode, confirmAccountCodes, mfaOn, mfaRequired,
  newAccountCodes, removeAccountFactor, secondStep, withSecondStep,
} from '../account-mfa.ts';
import { html, raw, type Raw } from '../html.ts';
import { documentShell } from '../layout.ts';
import { accountRoles, type App } from '../metadata.ts';
import { matchTotp, newTotpSecret, otpauthUri, unbase32 } from '../mfa.ts';
import { qrSvg } from '../qrcode.ts';
import { secretKeyConfigured } from '../secrets.ts';
import { loginWindowMinutes } from '../security.ts';
import { clientIp, getSession, loginThrottled, logActivity, saveState, type Session } from '../session.ts';
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

const PENDING = '__MFA';
const STEP_SECONDS = 300;
const ENROL_SECONDS = 600;

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
  /** while adding an app: the new secret, then (after its first code) the recovery codes to show once */
  secret?: string;
  codes?: string[];
}

function pendingOf(s: Session): Pending | null {
  try {
    const p = JSON.parse(String(s.state[PENDING] ?? '')) as Pending;
    const limit = (p?.enrol ? ENROL_SECONDS : STEP_SECONDS) * 1000;
    return p && typeof p.u === 'string' && Date.now() - Number(p.at) < limit ? p : null;
  } catch {
    return null;
  }
}

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
  const p: Pending = { u: username, ...opts, at: Date.now(), enrol: need === 'enrol' };
  session.state[PENDING] = JSON.stringify(p);
  await saveState(session);
  return reply.redirect(`/a/${a.alias}/login/2fa`, 303);
}

function card(a: App, locale: Locale, title: string, body: Raw) {
  return documentShell(
    `${title} · ${a.name}`,
    html`<main class="login">
      <div class="card login-card">
        <h1>${title}</h1>
        ${body}
        <a class="login-forgot" href="/a/${a.alias}/login">${locale.t('reset.back')}</a>
      </div>
    </main>`,
    'login-body',
    {},
    pwaHead(a),
    rootAttrs(locale),
  );
}

const csrfField = (s: Session) => html`<input type="hidden" name="__csrf" value="${s.csrf_token}">`;
const alert = (error?: string) => html`${error ? html`<div class="alert alert-error" role="alert">${error}</div>` : ''}`;
const grouped = (secret: string) => secret.replace(/(.{4})/g, '$1 ').trim();

function codesList(codes: string[]) {
  return html`<ol class="mfa-codes">${codes.map((c) => html`<li><code>${c}</code></li>`)}</ol>`;
}

/** The second step's page: a code; or a new app (QR code, then its first code); or the recovery codes, once. */
function stepPage(a: App, locale: Locale, s: Session, p: Pending, error?: string) {
  const t = locale.t;
  const action = `/a/${a.alias}/login/2fa`;
  if (p.codes)
    return card(a, locale, t('mfa.codes_title'), html`<p>${t('mfa.codes_once')}</p>${codesList(p.codes)}
      <form method="post" action="${action}/done" class="login-form">${csrfField(s)}
        <label class="check"><input type="checkbox" name="saved" value="1" required> ${t('mfa.codes_saved')}</label>
        <button class="btn btn-hot">${t('mfa.continue')}</button></form>`);
  if (p.enrol && p.secret)
    return card(a, locale, t('mfa.enrol_title'), html`<p class="muted">${t('mfa.enrol_intro')}</p>${alert(error)}
      <ol class="mfa-steps">
        <li>${t('mfa.scan')}</li>
        <li>${t('mfa.or_enter')} <code class="mfa-secret">${grouped(p.secret)}</code></li>
        <li>${t('mfa.enter_code')}</li>
      </ol>
      <div class="mfa-qr">${raw(qrSvg(otpauthUri(p.secret, p.u, a.name), { label: t('mfa.qr_label'), px: 4 }) ?? '')}</div>
      <form method="post" action="${action}" class="login-form">${csrfField(s)}
        <div class="field"><label class="label" for="code">${t('mfa.code')}</label><input id="code" name="code" required inputmode="numeric" autocomplete="one-time-code" maxlength="7" autofocus></div>
        <button class="btn btn-hot">${t('mfa.verify')}</button></form>`);
  return card(a, locale, t('mfa.step_title'), html`<p class="muted">${t('mfa.step_intro')}</p>${alert(error)}
    <form method="post" action="${action}" class="login-form">${csrfField(s)}
      <div class="field"><label class="label" for="code">${t('mfa.code')}</label><input id="code" name="code" required autocomplete="one-time-code" maxlength="20" spellcheck="false" autocapitalize="off" autofocus></div>
      <button class="btn btn-hot">${t('mfa.verify')}</button></form>`);
}

/** The signed-out session's pending sign-in, or a page that says it expired. */
async function start(req: Req, reply: FastifyReply) {
  const loaded = await appWithLocale(req, req.params.alias);
  if (!loaded) return null;
  const session = await getSession(req, reply, loaded.app.id, `/a/${loaded.app.alias}`);
  const { app: a, locale } = (await appWithLocale(req, req.params.alias, session))!;
  const p = session.username ? null : pendingOf(session);
  return { a, locale, session, p };
}

const expired = async (reply: FastifyReply, a: App, locale: Locale, s: Session) => {
  delete s.state[PENDING];
  await saveState(s);
  return reply.code(410).type('text/html').send(card(a, locale, locale.t('mfa.step_title'), alert(locale.t('mfa.expired'))));
};

/** Sign in with the pending sign-in's options, now with "+2fa" in its method. */
async function finish(req: Req, reply: FastifyReply, a: App, s: Session, p: Pending, detail: string, next?: string, flash?: string) {
  const n = await signIn(req, reply, a, s, p.u, {
    extraRoles: p.extraRoles, groups: p.groups, remember: p.remember, method: withSecondStep(p.method),
    detail: `${p.detail ?? 'password'} ${detail}`,
  });
  if (flash) {
    n.state.__FLASH = flash;
    await saveState(n);
  }
  return reply.redirect(next ?? safeNext(a, p.next), 303);
}

export async function twoStepRoutes(app: FastifyInstance) {
  app.get('/a/:alias/login/2fa', async (req: Req, reply) => {
    const r = await start(req, reply);
    if (!r) return reply.code(404).send('Not found');
    const { a, locale, session: s, p } = r;
    if (!p) return expired(reply, a, locale, s);
    const id = await accountId(p.u);
    if (id === null) return expired(reply, a, locale, s);
    if (p.enrol && !p.codes && !(await accountHasFactor(id))) {
      // fail closed: without the instance key there is nowhere safe to keep the app's secret
      if (!secretKeyConfigured()) return reply.code(503).type('text/html').send(card(a, locale, locale.t('mfa.enrol_title'), alert(locale.t('mfa.no_key'))));
      if (!p.secret) {
        p.secret = newTotpSecret();
        s.state[PENDING] = JSON.stringify(p);
      }
    }
    await saveState(s);
    return reply.type('text/html').send(stepPage(a, locale, s, p));
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
    if (await loginThrottled(a.id, p.u, ip)) {
      logActivity({ appId: a.id, username: p.u, event: 'login_locked', ip, detail: '2fa' });
      delete s.state[PENDING];
      await saveState(s);
      return reply.code(429).type('text/html').send(card(a, locale, t('mfa.step_title'), alert(t('login.throttled', { minutes: loginWindowMinutes() }))));
    }
    const code = String(req.body?.code ?? '').slice(0, 40);
    // adding the first app while signing in: its first code proves it works
    if (p.enrol && p.secret && !p.codes) {
      const step = matchTotp(unbase32(p.secret), code.replace(/\s/g, ''), null);
      if (step === null) {
        await logActivity({ appId: a.id, username: p.u, event: 'login_failed', ip, detail: '2fa (new app)' });
        return reply.code(401).type('text/html').send(stepPage(a, locale, s, p, t('mfa.wrong')));
      }
      await addAccountTotp(id, t('mfa.app_default'), p.secret, step);
      await logActivity({ appId: a.id, username: p.u, event: '2fa_enrolled', ip, detail: 'authenticator app (sign-in)' });
      p.codes = await newAccountCodes(id);
      delete p.secret;
      s.state[PENDING] = JSON.stringify(p);
      await saveState(s);
      return reply.type('text/html').send(stepPage(a, locale, s, p));
    }
    const ok = await checkAccountCode(id, code);
    if (!ok) {
      await logActivity({ appId: a.id, username: p.u, event: 'login_failed', ip, detail: '2fa' });
      return reply.code(401).type('text/html').send(stepPage(a, locale, s, p, t('mfa.wrong')));
    }
    if (ok.kind === 'recovery') {
      const left = await accountCodesLeft(id);
      await logActivity({ appId: a.id, username: p.u, event: '2fa_recovery_used', ip, detail: `${left} left` });
      // to My account: one code fewer, maybe time for new ones
      return finish(req, reply, a, s, p, '2fa (recovery code)', `/a/${a.alias}/account#two-step`, t('mfa.recovery_used', { n: left }));
    }
    return finish(req, reply, a, s, p, '2fa');
  });

  // the recovery codes were shown once after adding the first app while signing in
  app.post('/a/:alias/login/2fa/done', async (req: Req, reply) => {
    const r = await start(req, reply);
    if (!r) return reply.code(404).send('Not found');
    const { a, locale, session: s, p } = r;
    if (!p?.codes || req.body?.__csrf !== s.csrf_token) return expired(reply, a, locale, s);
    if (req.body?.saved !== '1') return reply.code(422).type('text/html').send(stepPage(a, locale, s, p));
    const id = await accountId(p.u);
    if (id === null) return expired(reply, a, locale, s);
    await confirmAccountCodes(id);
    return finish(req, reply, a, s, p, '2fa (new app)');
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
  const done = async (reply: FastifyReply, ctx: PageContext, flash?: string, error?: boolean) => {
    if (flash) ctx.session.state[error ? '__FLASH_ERROR' : '__FLASH'] = flash;
    await saveState(ctx.session);
    return reply.redirect(`${ctx.base}/account#two-step`, 303);
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

  // removing an app asks for a code (from any app, or a recovery code): a session left open is not enough
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
    if (!factors.some((f) => f.id === factorId)) return done(reply, ctx);
    if (factors.length === 1 && mfaRequired(ctx.app, ctx.roles)) return done(reply, ctx, t('mfa.keep_one'), true);
    if (!(await checkAccountCode(id, String(req.body?.code ?? '').slice(0, 40)))) {
      await logActivity({ appId: ctx.app.id, username: ctx.user, event: 'login_failed', ip: ctx.ip, detail: '2fa remove' });
      return done(reply, ctx, t('mfa.wrong'), true);
    }
    await removeAccountFactor(id, factorId);
    await logActivity({ appId: ctx.app.id, username: ctx.user, event: '2fa_removed', ip: ctx.ip, detail: 'authenticator app' });
    return done(reply, ctx, t('mfa.removed'));
  });
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

/** My account → Two-step sign-in (when the application has a second step). */
export async function twoStepSection(ctx: PageContext): Promise<Raw | ''> {
  if (!mfaOn(ctx.app)) return '';
  const id = await accountId(ctx.user);
  if (id === null) return '';
  const t = ctx.locale.t;
  const [factors, left] = await Promise.all([accountFactors(id), accountCodesLeft(id)]);
  const required = mfaRequired(ctx.app, ctx.roles);
  const pending = newSecret(ctx.session, 10);
  let shown: string[] | null = null;
  try {
    const c = JSON.parse(String(ctx.session.state.__CODES_NEW ?? ''));
    shown = Array.isArray(c) ? c : null;
  } catch {
    shown = null;
  }
  const error = typeof ctx.session.state.__FLASH_ERROR === 'string' ? ctx.session.state.__FLASH_ERROR : '';
  delete ctx.session.state.__FLASH_ERROR;
  const base = `${ctx.base}/account/2fa`;
  const csrf = html`<input type="hidden" name="__csrf" value="${ctx.session.csrf_token}">`;
  const when = (v: string | null) => (v ? String(v).slice(0, 10) : '');
  return html`<section class="region region-standard col-6" id="two-step"><header class="region-header"><h2>${t('mfa.step_title')}</h2></header><div class="region-body">
    ${error ? html`<div class="alert alert-error" role="alert">${error}</div>` : ''}
    <p class="muted u-mt0">${factors.length ? t('mfa.on') : required ? t('mfa.required_you') : t('mfa.off')}</p>
    ${shown
      ? html`<h3>${t('mfa.codes_title')}</h3><p>${t('mfa.codes_once')}</p>${codesList(shown)}
        <form method="post" action="${base}/codes/confirm">${csrf}
          <label class="check"><input type="checkbox" name="saved" value="1" required> ${t('mfa.codes_saved')}</label>
          <div class="buttons"><button class="btn btn-hot">${t('mfa.continue')}</button></div></form>`
      : ''}
    ${factors.length
      ? html`<ul class="mfa-factors">${factors.map((f) => html`<li><strong>${f.name}</strong> <span class="muted">${when(f.created_at)}</span>
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
  </div></section>`;
}

