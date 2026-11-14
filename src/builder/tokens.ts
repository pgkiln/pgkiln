// (sprint 194, NX-F4, SEC-1) Builder tokens in the builder: the Security page's region (make, list, revoke), the
// administrators' list on the Developers page, and the step-up that making one needs. The tokens themselves are in
// src/builder-tokens.ts; what they open is src/builder/api-v1.ts.
//
// Step-up: a token is made only within STEP_UP_MINUTES of a sign-in that used the factors the developer must use: a
// workspace's single sign-on (through the identity provider or directory, never the pgkiln password) and a second
// factor when they have one or the policy requires one (the identity provider's sign-in counts when it decides on
// the second factor, as for the builder itself). finishSignIn (routes.ts) keeps when and how in the session (__AUTH).
// Later than that, the form asks for the password and a code again, or, with single sign-on, to sign in again.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { checkSecondFactor, hasFactor, requirement } from '../mfa.ts';
import { ssoRequired } from '../devsso.ts';
import { clientIp, destroySession, loginThrottled, logActivity, saveState, type Session } from '../session.ts';
import { createToken, DEFAULT_TOKEN_DAYS, MAX_TOKEN_DAYS, parseScopes, revokeToken, STEP_UP_MINUTES, TOKEN_SCOPES, TokenError, tokensOf, type BuilderToken } from '../builder-tokens.ts';
import { tr } from './i18n.ts';
import { isAdmin } from './locks.ts';
import { back, BASE, csrf, developer, flash, input, region, type Req } from './ui.ts';

export type StepUp =
  | { ok: true }
  /** single sign-on is required: only signing in again counts */
  | { ok: false; why: 'sso' }
  /** a second factor is required and the developer has none yet */
  | { ok: false; why: 'enrol' }
  /** the password (and a code, when the developer has a factor) */
  | { ok: false; why: 'password'; code: boolean };

interface AuthState { at: number; mfa: boolean; via: string | null }
const authOf = (s: Pick<Session, 'state'>): AuthState | null => {
  try {
    const a = JSON.parse(String(s.state.__AUTH ?? ''));
    return a && typeof a.at === 'number' ? { at: a.at, mfa: !!a.mfa, via: typeof a.via === 'string' ? a.via : null } : null;
  } catch {
    return null;
  }
};

/** May this session make a token now, and if not, what would it take. */
export async function tokenStepUp(s: Session): Promise<StepUp> {
  const me = s.username!;
  const admin = await isAdmin(me);
  const [sso, factor, rule] = await Promise.all([ssoRequired(me), hasFactor(me), requirement(me, admin)]);
  const auth = authOf(s);
  // the identity provider decides on the second factor (sprint 129): its sign-in counts as one
  if (rule.required && !factor && !s.state.__SSO) return { ok: false, why: 'enrol' };
  const fresh = !!auth && Date.now() - auth.at <= STEP_UP_MINUTES * 60_000 && auth.at <= Date.now() + 60_000;
  const needMfa = factor || rule.required;
  if (fresh && (!sso || auth!.via) && (!needMfa || auth!.mfa)) return { ok: true };
  if (sso) return { ok: false, why: 'sso' };
  return { ok: false, why: 'password', code: factor };
}

const when = (v: string | null) => (v ? String(v).slice(0, 16).replace('T', ' ') : '');
const statusOf = (t: BuilderToken) => (t.revoked_at ? 'revoked' : t.live ? 'active' : 'expired');

/** The public address of the builder, for the example command. */
const publicBase = (req: Req) => (process.env.PUBLIC_URL || `${req.protocol}://${req.headers.host ?? 'localhost'}`).replace(/\/+$/, '');

/** The Security page's region: the token just made (once), the form, the developer's tokens. */
export async function tokensRegion(req: Req, s: Session, made?: { name: string; token: string }): Promise<Raw> {
  const tx = tr(s);
  const [mine, step] = await Promise.all([tokensOf(s.username!), tokenStepUp(s)]);
  const workspaces = s.workspaces ?? [];
  const shown = made
    ? html`<div class="alert alert-warning" role="status"><p class="u-mt0"><b>${tx('tok.shown_title', { name: made.name })}</b> ${tx('tok.shown_once')}</p>
        <div class="field"><label class="label" for="f_new_token">${tx('tok.token_label')}</label>
          <div class="token-copy"><input id="f_new_token" class="token-value" readonly value="${made.token}" spellcheck="false" autocomplete="off" data-select-all>
          <button type="button" class="btn btn-sm" hidden data-copy-from="f_new_token" data-copied="${tx('tok.copied')}">${icon('copy')} ${tx('tok.copy')}</button></div></div>
        <p class="small u-mb0">${tx('tok.use_with')}</p>
        <pre class="code-sample"><code>export PGKILN_TOKEN=…
pgkiln mcp --url ${publicBase(req)}</code></pre></div>`
    : '';
  const stepFields = step.ok ? '' : step.why === 'password'
    ? html`<p class="muted small">${tx(step.code ? 'tok.step_up_code' : 'tok.step_up', { minutes: STEP_UP_MINUTES })}</p>
      <div class="form-grid">
        ${input('password', tx('tok.password'), '', { type: 'password', required: true, auto: 'current-password' })}
        ${step.code ? html`<div class="field"><label class="label" for="f_code">${tx('tok.code')}</label><input id="f_code" name="code" required autocomplete="one-time-code" inputmode="text" maxlength="20" spellcheck="false" autocapitalize="off"></div>` : ''}
      </div>`
    : '';
  const form = !step.ok && step.why === 'enrol'
    ? html`<p class="alert alert-info" role="status">${tx('tok.enrol_first')}</p>`
    : !step.ok && step.why === 'sso'
      ? html`<p class="alert alert-info" role="status">${tx('tok.sso_again', { minutes: STEP_UP_MINUTES })}</p>
        <form method="post" action="${BASE}/security/tokens/sign-in-again">${csrf(s)}<button class="btn">${icon('log-in')} ${tx('tok.sign_in_again')}</button></form>`
      : html`<form method="post" action="${BASE}/security/tokens">${csrf(s)}
        <div class="form-grid">
          ${input('name', tx('tok.name'), '', { required: true, help: tx('tok.name_help') })}
          ${input('days', tx('tok.expires_days'), DEFAULT_TOKEN_DAYS, { type: 'number', required: true, help: tx('tok.expires_help', { max: MAX_TOKEN_DAYS }) })}
          ${workspaces.length > 1
            ? html`<div class="field"><label class="label" for="f_workspace">${tx('tok.workspace')}</label><select id="f_workspace" name="workspace">
                ${workspaces.map((w) => html`<option value="${w.id}"${w.id === s.workspace?.id ? raw(' selected') : ''}>${w.name}</option>`)}</select></div>`
            : html`<input type="hidden" name="workspace" value="${s.workspace?.id ?? ''}">`}
        </div>
        <fieldset class="field token-scopes"><legend class="label">${tx('tok.scopes')}</legend>
          ${TOKEN_SCOPES.map((sc) => html`<label class="check"><input type="checkbox" name="scopes" value="${sc}"${sc === 'read' ? raw(' checked') : ''}> <b>${sc}</b> · ${tx(`tok.scope_${sc}` as 'tok.scope_read')}</label>`)}
        </fieldset>
        ${stepFields}
        <div class="buttons"><button class="btn btn-hot"${s.workspace ? '' : raw(' disabled')}>${icon('key')} ${tx('tok.create')}</button></div>
        ${s.workspace ? '' : html`<p class="muted small">${tx('tok.no_workspace')}</p>`}
      </form>`;
  const list = mine.length
    ? html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>${tx('tok.col_name')}</th><th>${tx('tok.workspace')}</th><th>${tx('tok.scopes')}</th><th>${tx('tok.col_expires')}</th><th>${tx('tok.col_last_used')}</th><th>${tx('tok.col_status')}</th></tr></thead><tbody>
        ${mine.map((t) => tokenRow(s, t, false))}</tbody></table></div>`
    : html`<p class="muted">${tx('tok.none')}</p>`;
  return region(tx('tok.title'), html`<p class="muted u-mt0">${tx.code('tok.intro')}</p>${shown}${form}<h3>${tx('tok.yours')}</h3>${list}`, '', 'tokens');
}

function tokenRow(s: Session, t: BuilderToken, admin: boolean) {
  const tx = tr(s);
  const st = statusOf(t);
  return html`<tr>
    ${admin ? html`<td data-label="${tx('tok.col_developer')}">${t.username}</td>` : ''}
    <td data-label="${tx('tok.col_name')}">${icon('key')} ${t.name}</td>
    <td data-label="${tx('tok.workspace')}">${t.workspace}</td>
    <td data-label="${tx('tok.scopes')}">${t.scopes.join(', ')}</td>
    <td data-label="${tx('tok.col_expires')}">${when(t.expires_at)}</td>
    <td data-label="${tx('tok.col_last_used')}">${t.last_used_at ? html`${when(t.last_used_at)}<br><span class="muted small">${t.last_used_ip ?? ''}</span>` : html`<span class="muted">${tx('tok.never_used')}</span>`}</td>
    <td data-label="${tx('tok.col_status')}">${st === 'active'
      ? html`<form method="post" action="${BASE}/security/tokens/${t.id}/revoke" class="u-inline">${csrf(s)}<input type="hidden" name="back" value="${admin ? 'developers' : 'security'}">
          <button class="btn btn-sm btn-danger" data-confirm="${tx('tok.revoke_confirm', { name: t.name })}" aria-label="${tx('tok.revoke_named', { name: t.name })}">${tx('tok.revoke')}</button></form>`
      : html`<span class="badge${st === 'revoked' ? ' badge-warn' : ''}" title="${t.revoked_reason ?? ''}">${tx(st === 'revoked' ? 'tok.revoked' : 'tok.expired')}</span>`}</td>
  </tr>`;
}

/** The Developers page's region for administrators: every developer's live tokens. */
export async function adminTokensRegion(s: Session): Promise<Raw> {
  const tx = tr(s);
  const all = await tokensOf(null);
  return region(tx('tok.admin_title'), html`<p class="muted u-mt0">${tx('tok.admin_intro')}</p>
    ${all.length
      ? html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>${tx('tok.col_developer')}</th><th>${tx('tok.col_name')}</th><th>${tx('tok.workspace')}</th><th>${tx('tok.scopes')}</th><th>${tx('tok.col_expires')}</th><th>${tx('tok.col_last_used')}</th><th>${tx('tok.col_status')}</th></tr></thead><tbody>
          ${all.map((t) => tokenRow(s, t, true))}</tbody></table></div>`
      : html`<p class="muted">${tx('tok.none')}</p>`}`, '', 'tokens');
}

export async function tokenRoutes(app: FastifyInstance, render: (req: Req, reply: FastifyReply, s: Session, made?: { name: string; token: string }) => Promise<unknown>) {
  app.post(`${BASE}/security/tokens`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const tx = tr(s);
    const me = s.username!;
    const ip = clientIp(req);
    const to = `${BASE}/security#tokens`;
    const step = await tokenStepUp(s);
    if (!step.ok && step.why !== 'password') {
      flash(s, tx(step.why === 'sso' ? 'tok.sso_again' : 'tok.enrol_first', { minutes: STEP_UP_MINUTES }), 'error');
      return back(reply, s, to);
    }
    if (!step.ok) {
      // the step-up: counts with failed sign-ins, so it can't be used to guess a password or a code
      if (await loginThrottled(null, me, ip)) {
        await logActivity({ username: me, event: 'login_locked', ip, detail: 'builder token step-up' });
        flash(s, tx('signin.throttled'), 'error');
        return back(reply, s, to);
      }
      const pwOk = !!(await owner.one('select 1 as ok from meta.developer where username = $1 and crypt($2, password_hash) = password_hash', [me, String(req.body?.password ?? '')]));
      const codeOk = pwOk && (!step.code || !!(await checkSecondFactor(me, String(req.body?.code ?? '').slice(0, 40))));
      if (!pwOk || !codeOk) {
        await logActivity({ username: me, event: 'login_failed', ip, detail: `builder token step-up: ${pwOk ? 'second factor' : 'password'}` });
        flash(s, tx('tok.wrong_pw'), 'error');
        return back(reply, s, to);
      }
      s.state.__AUTH = JSON.stringify({ at: Date.now(), mfa: step.code, via: null });
      await saveState(s);
    }
    // the workspace: one of the developer's now (administrators: any)
    const ws = (s.workspaces ?? []).find((w) => String(w.id) === String(req.body?.workspace ?? ''));
    if (!ws) {
      flash(s, tx('tok.no_workspace'), 'error');
      return back(reply, s, to);
    }
    let made: { token: string; id: number };
    const name = String(req.body?.name ?? '').trim();
    try {
      const scopes = parseScopes((req.body as Record<string, unknown> | undefined)?.scopes);
      const days = Number(String(req.body?.days ?? DEFAULT_TOKEN_DAYS).trim());
      made = await createToken({ username: me, workspaceId: ws.id, name, scopes, days });
      await logActivity({ username: me, event: 'builder_token_created', ip, detail: `${name}: ${scopes.join(', ')}, workspace ${ws.name}, ${days} days` });
    } catch (e) {
      if (!(e instanceof TokenError)) throw e;
      flash(s, e.message, 'error');
      return back(reply, s, to);
    }
    // shown in this answer only: never kept anywhere but as its hash
    reply.header('cache-control', 'no-store');
    return render(req, reply, s, { name, token: made.token });
  });

  app.post(`${BASE}/security/tokens/:id(^\\d{1,15}$)/revoke`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const tx = tr(s);
    const admin = await isAdmin(s.username);
    const to = req.body?.back === 'developers' && admin ? `${BASE}/developers#tokens` : `${BASE}/security#tokens`;
    // an administrator revokes anyone's; a developer only their own (another's is not found)
    const t = await revokeToken(Number(req.params.id), s.username!, `revoked by ${s.username}`, admin ? null : s.username!);
    if (!t) return reply.code(404).send('Not found');
    await logActivity({ username: s.username, event: 'builder_token_revoked', ip: clientIp(req), detail: `${t.username}: ${t.name}` });
    flash(s, tx('tok.revoked_done', { name: t.name }));
    return back(reply, s, to);
  });

  // single sign-on: a new sign-in through the identity provider, then back to the Security page
  app.post(`${BASE}/security/tokens/sign-in-again`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    await destroySession(reply, s, BASE);
    return reply.redirect(`${BASE}/login?next=${encodeURIComponent(`${BASE}/security`)}`, 303);
  });
}
