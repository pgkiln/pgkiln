import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import {
  addPasskey, addTotp, adminEmails, adminFactors, codesLeft, confirmRecoveryCodes, factorsOf, forgetBrowsers, hasFactor, matchTotp, MFA_POLICIES, mfaPolicy,
  newRecoveryCodes, newTotpSecret, notifyMfa, otpauthUri, passkeysOf, policyProblem, requiredFor, resetFactors, setPolicy, setTrustDays, trustDays,
  trustedBrowsers, unbase32, type MfaPolicy,
} from '../mfa.ts';
import { qrSvg } from '../qrcode.ts';
import { secretKeyConfigured } from '../secrets.ts';
import { clientIp, logActivity, saveState, type Session } from '../session.ts';
import { ALGORITHMS, b64url, newChallenge, relyingParty, verifyRegistration, WebAuthnError } from '../webauthn.ts';
import { tr } from './i18n.ts';
import { isAdmin } from './locks.ts';
import { back, BASE, csrf, developer, flash, input, region, send, shell, type Req } from './ui.ts';

// (sprint 126, SEC-2 and SEC-6) Developer › Security: a developer's second factors (authenticator apps, TOTP)
// and recovery codes; the instance's policy (Instance settings); an administrator's reset of another
// developer's factors (Developers). Adding an app: a new secret is kept in the session until a code from the
// app confirms it, then stored encrypted with the instance key. Recovery codes are shown once; they count
// only after "I saved them". Removing a factor asks for the password, and is refused when it would leave a
// developer the policy covers without one, or the instance without enough administrators who have one.
// (sprint 127) Passkeys (WebAuthn): the browser asks the server for options (a one-time challenge kept in the
// session for five minutes), calls navigator.credentials.create() and posts the answer in a normal form
// (public/builder.js, [data-passkey]); without JavaScript the button stays hidden. Trusted browsers can be
// forgotten here; the instance decides how long a browser may be trusted (0 = never).

const CHALLENGE_SECONDS = 300;

/** A one-time WebAuthn challenge kept in the session (for this purpose only), or null when there is none or it expired. */
export function takeChallenge(s: Session, purpose: 'create' | 'get'): string | null {
  try {
    const p = JSON.parse(String(s.state.__PK ?? ''));
    delete s.state.__PK;
    return p && p.purpose === purpose && Date.now() - Number(p.at) < CHALLENGE_SECONDS * 1000 && typeof p.c === 'string' ? p.c : null;
  } catch {
    delete s.state.__PK;
    return null;
  }
}
export function giveChallenge(s: Session, purpose: 'create' | 'get'): string {
  const c = newChallenge();
  s.state.__PK = JSON.stringify({ c, purpose, at: Date.now() });
  return c;
}

const SECRET_MINUTES = 10;

async function verifyPassword(username: string, password: string) {
  return !!(await owner.one('select 1 as ok from meta.developer where username = $1 and crypt($2, password_hash) = password_hash', [username, password]));
}

export async function securityRoutes(app: FastifyInstance) {
  app.get(`${BASE}/security`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const tx = tr(s);
    const me = s.username!;
    const [factors, left, pol, admin, days, trusted] = await Promise.all([factorsOf(me), codesLeft(me), mfaPolicy(), isAdmin(me), trustDays(), trustedBrowsers(me)]);
    const rp = relyingParty(req);
    const required = requiredFor(pol.policy, admin);
    const pending = (() => {
      try {
        const p = JSON.parse(String(s.state.__TOTP_NEW ?? ''));
        return p && Date.now() - p.at < SECRET_MINUTES * 60_000 ? (p as { secret: string; at: number }) : null;
      } catch {
        return null;
      }
    })();
    const shownCodes: string[] | null = (() => {
      try {
        const c = JSON.parse(String(s.state.__CODES_NEW ?? ''));
        return Array.isArray(c) ? c : null;
      } catch {
        return null;
      }
    })();
    delete s.state.__MFA_DUE; // the page says it itself
    const when = (v: string | null) => (v ? String(v).slice(0, 16).replace('T', ' ') : '—');
    const setup = pending
      ? html`<form method="post" action="${BASE}/security/totp/confirm">${csrf(s)}
          <ol class="mfa-steps">
            <li>${tx('mfa.scan')}</li>
            <li>${tx('mfa.or_enter')} <code class="mfa-secret">${pending.secret.replace(/(.{4})/g, '$1 ').trim()}</code></li>
            <li>${tx('mfa.enter_code')}</li>
          </ol>
          <div class="mfa-qr">${raw(qrSvg(otpauthUri(pending.secret, me), { label: tx('mfa.qr_label'), px: 4 }) ?? '')}</div>
          <div class="form-grid">
            ${input('name', tx('mfa.app_name'), tx('mfa.app_default'), { required: true })}
            <div class="field"><label class="label" for="f_code">${tx('mfa.code')}</label><input id="f_code" name="code" required inputmode="numeric" pattern="[0-9 ]{6,7}" autocomplete="one-time-code" maxlength="7"></div>
          </div>
          <div class="buttons"><button class="btn btn-hot">${tx('mfa.confirm_app')}</button></div></form>
        <form method="post" action="${BASE}/security/totp/cancel">${csrf(s)}<button class="link-button">${tx('mfa.cancel_setup')}</button></form>`
      : html`<form method="post" action="${BASE}/security/totp/start">${csrf(s)}
          <div class="buttons"><button class="btn${factors.length ? '' : ' btn-hot'}"${secretKeyConfigured() ? '' : raw(' disabled')}>${icon('plus')} ${tx('mfa.add_app')}</button></div>
          ${secretKeyConfigured() ? '' : html`<p class="alert alert-error" role="alert">${tx('mfa.no_key')}</p>`}</form>`;
    const main = html`<h1 class="u-mb1">${tx('mfa.title')}</h1>
      <p class="muted u-mt0">${tx('mfa.intro')}</p>
      ${required && !factors.length ? html`<div class="alert alert-warning" role="alert">${tx('mfa.required_you')}</div>` : ''}
      ${shownCodes
        ? region(tx('mfa.codes_title'), html`<p>${tx('mfa.codes_once')}</p>
            <ol class="mfa-codes">${shownCodes.map((c) => html`<li><code>${c}</code></li>`)}</ol>
            <form method="post" action="${BASE}/security/codes/confirm">${csrf(s)}
              <label class="check"><input type="checkbox" name="saved" value="1" required> ${tx('mfa.codes_saved')}</label>
              <div class="buttons"><button class="btn btn-hot">${tx('mfa.codes_done')}</button></div></form>`, '', 'codes')
        : ''}
      <div class="columns">
        ${region(tx('mfa.factors'), html`${factors.length
          ? html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>${tx('mfa.app_name')}</th><th>${tx('mfa.kind')}</th><th>${tx('mfa.added')}</th><th>${tx('mfa.last_used')}</th><th></th></tr></thead><tbody>
              ${factors.map((f) => html`<tr><td data-label="${tx('mfa.app_name')}">${icon(f.kind === 'passkey' ? 'fingerprint' : 'smartphone')} ${f.name}</td>
                <td data-label="${tx('mfa.kind')}">${f.kind === 'passkey' ? tx('mfa.kind_passkey') : tx('mfa.kind_app')}${f.kind === 'passkey' && f.rp_id !== rp.rpId ? html` <span class="badge badge-warn" title="${tx('mfa.other_domain_help', { domain: f.rp_id ?? '' })}">${tx('mfa.other_domain', { domain: f.rp_id ?? '' })}</span>` : ''}</td>
                <td data-label="${tx('mfa.added')}">${when(f.created_at)}</td><td data-label="${tx('mfa.last_used')}">${when(f.last_used_at)}</td>
                <td><details class="menu"><summary class="btn btn-sm">${tx('mfa.remove')}</summary><div class="menu-panel"><form method="post" action="${BASE}/security/factor/${f.id}/delete" class="menu-section">${csrf(s)}
                  ${input(`password_${f.id}`, tx('mfa.your_password'), '', { type: 'password', required: true, auto: 'current-password' })}
                  <button class="btn btn-sm btn-danger">${tx(f.kind === 'passkey' ? 'mfa.remove_passkey' : 'mfa.remove_app')}</button></form></div></details></td></tr>`)}
              </tbody></table></div>`
          : html`<p class="muted">${tx('mfa.no_apps')}</p>`}
          <h3>${tx('mfa.kind_passkey')}</h3>
          <p class="muted small u-mt0">${tx('mfa.passkey_intro')}</p>
          <form method="post" action="${BASE}/security/passkey">${csrf(s)}
            <div class="form-grid">${input('pk_name', tx('mfa.app_name'), tx('mfa.passkey_default'), { required: true })}</div>
            <input type="hidden" name="clientDataJSON"><input type="hidden" name="attestationObject"><input type="hidden" name="transports">
            ${isIP(rp.rpId) ? html`<p class="alert alert-info" role="status">${tx('mfa.passkey_needs_host', { host: rp.rpId })}</p>`
              : html`<div class="buttons"><button class="btn${factors.length ? '' : ' btn-hot'}" hidden data-passkey="${BASE}/security/passkey/options" data-passkey-error="${tx('mfa.passkey_failed')}">${icon('fingerprint')} ${tx('mfa.add_passkey')}</button></div>`}
            <p class="small" role="status" data-passkey-status></p>
            <noscript><p class="muted small">${tx('mfa.passkey_needs_js')}</p></noscript>
          </form>
          <h3>${tx('mfa.kind_app')}</h3>
          ${setup}`)}
        ${region(tx('mfa.codes_title'), html`<p class="u-mt0">${factors.length || left ? tx('mfa.codes_left', { n: left }) : tx('mfa.codes_after')}</p>
          ${factors.length && left < 3 ? html`<p class="alert alert-warning" role="status">${tx('mfa.codes_low')}</p>` : ''}
          ${factors.length ? html`<form method="post" action="${BASE}/security/codes">${csrf(s)}<button class="btn" data-confirm="${tx('mfa.codes_new_confirm')}">${tx('mfa.codes_new')}</button></form>` : ''}
          ${days || trusted ? html`<h3>${tx('mfa.trusted_title')}</h3>
            <p class="u-mt0">${days ? tx('mfa.trusted_count', { n: trusted, days }) : tx('mfa.trusted_off')}</p>
            ${trusted ? html`<form method="post" action="${BASE}/security/forget-browsers">${csrf(s)}<button class="btn">${tx('mfa.forget_browsers')}</button></form>` : ''}` : ''}`)}
      </div>`;
    return send(reply, s, shell(s, tx('mfa.title'), [[tx('mfa.title')]], main, 'developers'));
  });

  app.post(`${BASE}/security/totp/start`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    if (!secretKeyConfigured()) return back(reply, s, `${BASE}/security`);
    s.state.__TOTP_NEW = JSON.stringify({ secret: newTotpSecret(), at: Date.now() });
    return back(reply, s, `${BASE}/security`);
  });

  app.post(`${BASE}/security/totp/cancel`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    delete s.state.__TOTP_NEW;
    return back(reply, s, `${BASE}/security`);
  });

  app.post(`${BASE}/security/totp/confirm`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const tx = tr(s);
    let pending: { secret: string; at: number } | null = null;
    try {
      pending = JSON.parse(String(s.state.__TOTP_NEW ?? ''));
    } catch {
      pending = null;
    }
    if (!pending || Date.now() - pending.at > SECRET_MINUTES * 60_000) {
      delete s.state.__TOTP_NEW;
      flash(s, tx('mfa.setup_expired'), 'error');
      return back(reply, s, `${BASE}/security`);
    }
    const step = matchTotp(unbase32(pending.secret), String(req.body?.code ?? '').replace(/\s/g, ''), null);
    if (step === null) {
      flash(s, tx('mfa.wrong_setup'), 'error');
      return back(reply, s, `${BASE}/security`);
    }
    const first = !(await hasFactor(s.username!));
    await addTotp(s.username!, String(req.body?.name ?? ''), pending.secret, step);
    delete s.state.__TOTP_NEW;
    delete s.state.__MFA_DUE;
    await logActivity({ username: s.username, event: '2fa_enrolled', ip: clientIp(req), detail: 'authenticator app' });
    // the first app: recovery codes at once (they count only once the developer saved them)
    if (first || !(await codesLeft(s.username!))) s.state.__CODES_NEW = JSON.stringify(await newRecoveryCodes(s.username!));
    flash(s, tx('mfa.app_added'));
    return back(reply, s, `${BASE}/security#codes`);
  });

  app.post(`${BASE}/security/codes`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    if (!(await hasFactor(s.username!))) return back(reply, s, `${BASE}/security`);
    s.state.__CODES_NEW = JSON.stringify(await newRecoveryCodes(s.username!));
    await logActivity({ username: s.username, event: '2fa_codes', ip: clientIp(req), detail: 'new recovery codes' });
    return back(reply, s, `${BASE}/security#codes`);
  });

  app.post(`${BASE}/security/codes/confirm`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    if (req.body?.saved !== '1') return back(reply, s, `${BASE}/security#codes`);
    await confirmRecoveryCodes(s.username!);
    delete s.state.__CODES_NEW;
    flash(s, tr(s)('mfa.codes_kept'));
    return back(reply, s, `${BASE}/security`);
  });

  app.post(`${BASE}/security/factor/:id(^\\d{1,9}$)/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const tx = tr(s);
    const me = s.username!;
    const id = Number(req.params.id);
    const f = await owner.one<{ kind: string }>('select id, kind from meta.developer_factor where id = $1 and username = $2', [id, me]);
    if (!f) return reply.code(404).send('Not found');
    if (!(await verifyPassword(me, String(req.body?.[`password_${id}`] ?? '')))) {
      await logActivity({ username: me, event: 'login_failed', ip: clientIp(req), detail: 'builder (removing a second factor)' });
      flash(s, tx('mfa.wrong_password'), 'error');
      return back(reply, s, `${BASE}/security`);
    }
    const last = (await factorsOf(me)).length === 1;
    if (last) {
      const pol = await mfaPolicy();
      const admin = await isAdmin(me);
      if (requiredFor(pol.policy, admin)) {
        flash(s, tx('mfa.cannot_remove_required'), 'error');
        return back(reply, s, `${BASE}/security`);
      }
      // (SEC-6) never fewer administrators with a factor than the policy needs
      if (admin && pol.policy !== 'off') {
        const { admins, enrolled } = await adminFactors();
        if (enrolled - 1 < Math.min(2, admins)) {
          flash(s, tx('mfa.cannot_remove_admin'), 'error');
          return back(reply, s, `${BASE}/security`);
        }
      }
    }
    await owner.query('delete from meta.developer_factor where id = $1 and username = $2', [id, me]);
    if (last) await owner.query('delete from meta.developer_recovery_code where username = $1', [me]);
    // a lost phone or key: browsers trusted with it must ask again
    await forgetBrowsers(me);
    const what = f.kind === 'passkey' ? 'a passkey' : 'an authenticator app';
    await logActivity({ username: me, event: '2fa_removed', ip: clientIp(req), detail: last ? `${what}, the last factor (recovery codes removed)` : what });
    flash(s, tx('mfa.removed'));
    return back(reply, s, `${BASE}/security`);
  });

  // (sprint 127) a passkey: the options for navigator.credentials.create(), then the browser's answer
  app.post(`${BASE}/security/passkey/options`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const me = s.username!;
    const rp = relyingParty(req);
    const challenge = giveChallenge(s, 'create');
    await saveState(s);
    reply.header('cache-control', 'no-store');
    return reply.send({
      mode: 'create', challenge, rp: { id: rp.rpId, name: 'pgkiln' }, algs: ALGORITHMS,
      // a stable handle that isn't the user name (the authenticator may show it, but it says nothing)
      user: { id: b64url(createHash('sha256').update(`pgkiln-developer:${me}`).digest().subarray(0, 16)), name: me, displayName: me },
      exclude: (await passkeysOf(me, rp.rpId)).map((p) => p.credential_id),
    });
  });

  app.post(`${BASE}/security/passkey`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const tx = tr(s);
    const me = s.username!;
    const challenge = takeChallenge(s, 'create');
    if (!challenge) {
      flash(s, tx('mfa.setup_expired'), 'error');
      return back(reply, s, `${BASE}/security`);
    }
    const rp = relyingParty(req);
    let reg;
    try {
      reg = verifyRegistration({ clientDataJSON: String(req.body?.clientDataJSON ?? ''), attestationObject: String(req.body?.attestationObject ?? '') }, { challenge, ...rp });
    } catch (e) {
      await logActivity({ username: me, event: '2fa_refused', ip: clientIp(req), detail: `passkey: ${e instanceof WebAuthnError ? e.message : 'unreadable answer'}` });
      flash(s, tx('mfa.passkey_failed'), 'error');
      return back(reply, s, `${BASE}/security`);
    }
    const first = !(await hasFactor(me));
    try {
      await addPasskey(me, String(req.body?.pk_name ?? ''), { ...reg, rpId: rp.rpId, transports: String(req.body?.transports ?? '').split(',').filter(Boolean) });
    } catch {
      flash(s, tx('mfa.passkey_known'), 'error');
      return back(reply, s, `${BASE}/security`);
    }
    delete s.state.__MFA_DUE;
    await logActivity({ username: me, event: '2fa_enrolled', ip: clientIp(req), detail: `passkey (${rp.rpId})` });
    if (first || !(await codesLeft(me))) s.state.__CODES_NEW = JSON.stringify(await newRecoveryCodes(me));
    flash(s, tx('mfa.passkey_added'));
    return back(reply, s, `${BASE}/security${s.state.__CODES_NEW ? '#codes' : ''}`);
  });

  app.post(`${BASE}/security/forget-browsers`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    await forgetBrowsers(s.username!);
    await logActivity({ username: s.username, event: '2fa_forget_browsers', ip: clientIp(req) });
    flash(s, tr(s)('mfa.browsers_forgotten'));
    return back(reply, s, `${BASE}/security`);
  });

  // (SEC-6) an administrator resets another developer's second factors: logged, the developer and the administrators told
  app.post(`${BASE}/developers/reset-2fa`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const tx = tr(s);
    if (!(await isAdmin(s.username))) return reply.code(403).send('Only administrators reset second factors.');
    const who = String(req.body?.username ?? '');
    const reason = String(req.body?.[`reason_${who.replace(/[^\w]/g, '_')}`] ?? req.body?.reason ?? '').trim().slice(0, 200);
    if (who === s.username) return reply.code(400).send('Use your own Security page.');
    if (!reason) {
      flash(s, tx('mfa.reason_needed'), 'error');
      return back(reply, s, `${BASE}/developers`);
    }
    if (!(await resetFactors(who))) return reply.code(404).send('Not found');
    await logActivity({ username: s.username, event: '2fa_reset', ip: clientIp(req), detail: `${who}: ${reason}` });
    const dev = await owner.one<{ email: string | null }>('select email from meta.developer where username = $1', [who]);
    await notifyMfa([dev?.email ?? '', ...(await adminEmails())], `pgkiln: two-factor sign-in of ${who} reset`,
      `${s.username} removed the second factors of developer ${who} (reason: ${reason}). ${who} signs in with the password only until they set up an authenticator app again.`);
    flash(s, tx('mfa.reset_done', { user: who }));
    return back(reply, s, `${BASE}/developers`);
  });

  // (SEC-2, SEC-6) the instance's policy: off, administrators or all developers, with a grace period
  app.post(`${BASE}/instance/mfa`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const tx = tr(s);
    if (!(await isAdmin(s.username))) return reply.code(403).send('Only administrators change the policy.');
    const policy = MFA_POLICIES.includes(req.body?.policy as MfaPolicy) ? (req.body!.policy as MfaPolicy) : null;
    const grace = Number(req.body?.grace_days);
    const trust = Number(req.body?.trust_days ?? 0);
    if (!policy || !Number.isInteger(grace) || grace < 0 || grace > 90 || !Number.isInteger(trust) || trust < 0 || trust > 90)
      return reply.code(400).send('policy is off, admins or all; grace_days and trust_days 0 to 90');
    if (await policyProblem(policy)) {
      flash(s, tx('mfa.policy_needs_admins'), 'error');
      return back(reply, s, `${BASE}/instance#mfa`);
    }
    await setPolicy(policy, grace);
    await setTrustDays(trust);
    await logActivity({ username: s.username, event: '2fa_policy', ip: clientIp(req), detail: `${policy}, grace ${grace} days, trust browsers ${trust} days` });
    await notifyMfa(await adminEmails(), `pgkiln: two-factor sign-in policy is now ${policy}`, `${s.username} set the two-factor policy to ${policy} (grace period ${grace} days).`);
    flash(s, tx('mfa.policy_saved'));
    return back(reply, s, `${BASE}/instance#mfa`);
  });
}

/** The Instance settings region for the policy (administrators). */
export async function policyRegion(s: Session): Promise<Raw> {
  const tx = tr(s);
  const [pol, af, days, without] = await Promise.all([
    mfaPolicy(), adminFactors(), trustDays(),
    owner.query<{ username: string; is_admin: boolean }>('select username, is_admin from meta.developer d where not exists (select 1 from meta.developer_factor f where f.username = d.username) order by username'),
  ]);
  const opt = (v: MfaPolicy) => html`<option value="${v}"${pol.policy === v ? raw(' selected') : ''}>${tx(({ off: 'mfa.policy_off', admins: 'mfa.policy_admins', all: 'mfa.policy_all' } as const)[v])}</option>`;
  return region(tx('mfa.policy_title'), html`<form method="post" action="${BASE}/instance/mfa">${csrf(s)}
      <div class="form-grid">
        <div class="field"><label class="label" for="f_policy">${tx('mfa.policy_label')}</label><select id="f_policy" name="policy">${MFA_POLICIES.map(opt)}</select></div>
        ${input('grace_days', tx('mfa.grace'), pol.graceDays, { type: 'number', help: tx('mfa.grace_help') })}
        ${input('trust_days', tx('mfa.trust_days'), days, { type: 'number', help: tx('mfa.trust_days_help') })}
      </div>
      <p class="muted small">${tx('mfa.policy_help', { enrolled: af.enrolled, admins: af.admins })}</p>
      <div class="buttons"><button class="btn btn-hot">${tx('mfa.policy_save')}</button></div></form>
    ${without.rows.length ? html`<p class="small">${tx('mfa.without', { list: without.rows.map((d) => `${d.username}${d.is_admin ? ' (admin)' : ''}`).join(', ') })}</p>` : ''}
    <p class="muted small">${tx('mfa.cli_note')}</p>`, '', 'mfa');
}
