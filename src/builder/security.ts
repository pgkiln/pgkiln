import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import {
  addTotp, adminEmails, adminFactors, codesLeft, confirmRecoveryCodes, factorsOf, hasFactor, matchTotp, MFA_POLICIES, mfaPolicy, newRecoveryCodes, newTotpSecret,
  notifyMfa, otpauthUri, policyProblem, requiredFor, resetFactors, setPolicy, unbase32, type MfaPolicy,
} from '../mfa.ts';
import { qrSvg } from '../qrcode.ts';
import { secretKeyConfigured } from '../secrets.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import { tr } from './i18n.ts';
import { isAdmin } from './locks.ts';
import { back, BASE, csrf, developer, flash, input, region, send, shell, type Req } from './ui.ts';

// (sprint 126, SEC-2 and SEC-6) Developer › Security: a developer's second factors (authenticator apps, TOTP)
// and recovery codes; the instance's policy (Instance settings); an administrator's reset of another
// developer's factors (Developers). Adding an app: a new secret is kept in the session until a code from the
// app confirms it, then stored encrypted with the instance key. Recovery codes are shown once; they count
// only after "I saved them". Removing a factor asks for the password, and is refused when it would leave a
// developer the policy covers without one, or the instance without enough administrators who have one.

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
    const [factors, left, pol, admin] = await Promise.all([factorsOf(me), codesLeft(me), mfaPolicy(), isAdmin(me)]);
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
        ${region(tx('mfa.apps'), html`${factors.length
          ? html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>${tx('mfa.app_name')}</th><th>${tx('mfa.added')}</th><th>${tx('mfa.last_used')}</th><th></th></tr></thead><tbody>
              ${factors.map((f) => html`<tr><td data-label="${tx('mfa.app_name')}">${icon('key')} ${f.name}</td><td data-label="${tx('mfa.added')}">${when(f.created_at)}</td><td data-label="${tx('mfa.last_used')}">${when(f.last_used_at)}</td>
                <td><details class="menu"><summary class="btn btn-sm">${tx('mfa.remove')}</summary><div class="menu-panel"><form method="post" action="${BASE}/security/factor/${f.id}/delete" class="menu-section">${csrf(s)}
                  ${input(`password_${f.id}`, tx('mfa.your_password'), '', { type: 'password', required: true, auto: 'current-password' })}
                  <button class="btn btn-sm btn-danger">${tx('mfa.remove_app')}</button></form></div></details></td></tr>`)}
              </tbody></table></div>`
          : html`<p class="muted">${tx('mfa.no_apps')}</p>`}
          ${setup}`)}
        ${region(tx('mfa.codes_title'), html`<p class="u-mt0">${factors.length || left ? tx('mfa.codes_left', { n: left }) : tx('mfa.codes_after')}</p>
          ${factors.length && left < 3 ? html`<p class="alert alert-warning" role="status">${tx('mfa.codes_low')}</p>` : ''}
          ${factors.length ? html`<form method="post" action="${BASE}/security/codes">${csrf(s)}<button class="btn" data-confirm="${tx('mfa.codes_new_confirm')}">${tx('mfa.codes_new')}</button></form>` : ''}`)}
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
    const f = await owner.one('select id from meta.developer_factor where id = $1 and username = $2', [id, me]);
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
    await logActivity({ username: me, event: '2fa_removed', ip: clientIp(req), detail: last ? 'the last authenticator app (recovery codes removed)' : 'an authenticator app' });
    flash(s, tx('mfa.removed'));
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
    if (!policy || !Number.isInteger(grace) || grace < 0 || grace > 90) return reply.code(400).send('policy is off, admins or all; grace_days 0 to 90');
    if (await policyProblem(policy)) {
      flash(s, tx('mfa.policy_needs_admins'), 'error');
      return back(reply, s, `${BASE}/instance#mfa`);
    }
    await setPolicy(policy, grace);
    await logActivity({ username: s.username, event: '2fa_policy', ip: clientIp(req), detail: `${policy}, grace ${grace} days` });
    await notifyMfa(await adminEmails(), `pgkiln: two-factor sign-in policy is now ${policy}`, `${s.username} set the two-factor policy to ${policy} (grace period ${grace} days).`);
    flash(s, tx('mfa.policy_saved'));
    return back(reply, s, `${BASE}/instance#mfa`);
  });
}

/** The Instance settings region for the policy (administrators). */
export async function policyRegion(s: Session): Promise<Raw> {
  const tx = tr(s);
  const [pol, af, without] = await Promise.all([
    mfaPolicy(), adminFactors(),
    owner.query<{ username: string; is_admin: boolean }>('select username, is_admin from meta.developer d where not exists (select 1 from meta.developer_factor f where f.username = d.username) order by username'),
  ]);
  const opt = (v: MfaPolicy) => html`<option value="${v}"${pol.policy === v ? raw(' selected') : ''}>${tx(({ off: 'mfa.policy_off', admins: 'mfa.policy_admins', all: 'mfa.policy_all' } as const)[v])}</option>`;
  return region(tx('mfa.policy_title'), html`<form method="post" action="${BASE}/instance/mfa">${csrf(s)}
      <div class="form-grid">
        <div class="field"><label class="label" for="f_policy">${tx('mfa.policy_label')}</label><select id="f_policy" name="policy">${MFA_POLICIES.map(opt)}</select></div>
        ${input('grace_days', tx('mfa.grace'), pol.graceDays, { type: 'number', help: tx('mfa.grace_help') })}
      </div>
      <p class="muted small">${tx('mfa.policy_help', { enrolled: af.enrolled, admins: af.admins })}</p>
      <div class="buttons"><button class="btn btn-hot">${tx('mfa.policy_save')}</button></div></form>
    ${without.rows.length ? html`<p class="small">${tx('mfa.without', { list: without.rows.map((d) => `${d.username}${d.is_admin ? ' (admin)' : ''}`).join(', ') })}</p>` : ''}
    <p class="muted small">${tx('mfa.cli_note')}</p>`, '', 'mfa');
}
