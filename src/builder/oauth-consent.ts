import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { owner } from '../db.ts';
import { scopeForApp, scopeForWorkspace } from '../network-acl.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import { publicUrl } from '../sso.ts';
import { authorizationUrl, exchangeAuthorizationCode, loadCredentialById, type WebCredential } from '../websources.ts';
import { html } from '../html.ts';
import { icon } from '../icons.ts';
import { back, BASE, csrf, developer, flash, type Req } from './ui.ts';
import { tr } from './i18n.ts';

// (sprint 222; migration 184) The OAuth2 authorization code flow of a web credential (APEX: consent in the browser).
// A developer clicks Authorize on an application's credential (Shared Components) or a workspace's (Workspace
// utilities, its administrators). pgkiln keeps a one-time state with a PKCE verifier (meta.web_credential_pending,
// builder only, ten minutes, bound to the builder session that started it) and sends the browser to the service's
// authorization URL. The service sends it back to /builder/oauth/callback with a code; pgkiln exchanges it at the
// token URL (through the workspace's network access list), keeps the refresh token encrypted and the access token
// in its cache. The code, the tokens and the verifier never reach the page, a log line or the activity log.

// a literal: ui.ts (BASE) is not initialised yet when a module it imports loads this one
export const CALLBACK = '/builder/oauth/callback';
/** The redirect URI to register at the service. */
export const consentRedirectUri = () => `${publicUrl()}${CALLBACK}`;
const PENDING_MINUTES = 10;
const sha256 = (x: string) => createHash('sha256').update(x).digest('base64url');
const b64url = (b: Buffer) => b.toString('base64url');

/** Where the developer returns to: the credential's page. */
const pageOf = (p: { app_id: number | null; credential_id: string | number }) =>
  p.app_id ? `${BASE}/apps/${p.app_id}/shared?c=web_credential-${p.credential_id}` : `${BASE}/workspace-credentials?edit=${p.credential_id}#credential-form`;

/**
 * Start the flow for a credential the caller may change (checked by the caller): a pending row, then a redirect to
 * the service. A credential that isn't ready (another grant, no authorization URL or client id) goes back with a message.
 */
export async function startConsent(req: Req, reply: FastifyReply, s: Session, c: WebCredential | null, where: { appId: number | null }) {
  const tx = tr(s);
  const home = c ? pageOf({ app_id: where.appId, credential_id: c.id }) : `${BASE}/home`;
  if (!c) return reply.code(404).send('Not found');
  if (c.type !== 'oauth2' || c.grant_type !== 'authorization_code' || !c.authorize_url || !c.username || !c.token_url) {
    flash(s, tx('oac.not_ready', { name: c.name }), 'error');
    return back(reply, s, home);
  }
  const state = b64url(randomBytes(32));
  const verifier = b64url(randomBytes(48));
  await owner.query(`delete from meta.web_credential_pending where created_at < now() - make_interval(mins => $1)`, [PENDING_MINUTES]);
  await owner.query(
    `insert into meta.web_credential_pending (state_hash, app_id, workspace, credential_id, username, session_hash, code_verifier) values ($1, $2, $3, $4, $5, $6, $7)`,
    [sha256(state), where.appId, where.appId === null, c.id, s.username, sha256(s.id), verifier]);
  let url: string;
  try {
    url = authorizationUrl(c, { state, challenge: sha256(verifier), redirectUri: consentRedirectUri() });
  } catch (e) {
    flash(s, (e as Error).message, 'error');
    return back(reply, s, home);
  }
  await logActivity({ appId: where.appId, username: s.username, event: 'web_credential_consent', ip: clientIp(req), detail: `web credential ${c.name}: authorization started` });
  return reply.redirect(url, 303);
}

/** The Authorize panel of a credential with the authorization code grant: its state, the redirect URI to register, the button. */
export function consentPanel(s: Session, row: { type: string; grant_type?: string | null; authorized: boolean; at?: Date | string | null }, action: string) {
  if (row.type !== 'oauth2' || row.grant_type !== 'authorization_code') return '';
  const tx = tr(s);
  return html`<fieldset class="prop-group u-mt125"><legend>${tx('oac.title')}</legend>
    <p>${row.authorized
      ? html`<span class="tag tag-ok">${tx('oac.authorized')}</span> ${row.at ? tx('oac.authorized_at', { at: new Date(row.at).toISOString().slice(0, 16).replace('T', ' ') }) : ''}`
      : html`<span class="tag tag-warn">${tx('oac.not_authorized')}</span> ${tx('oac.not_authorized_help')}`}</p>
    <p class="small">${tx('oac.redirect_uri')} <code class="u-break">${consentRedirectUri()}</code></p>
    <form method="post" action="${action}">${csrf(s)}<button class="btn${row.authorized ? '' : ' btn-hot'}">${icon('key')} ${tx(row.authorized ? 'oac.authorize_again' : 'oac.authorize')}</button></form>
  </fieldset>`;
}

export async function oauthConsentRoutes(app: FastifyInstance) {
  // an application's credential: any developer of the application (the path's application is checked by developer())
  app.post(`${BASE}/apps/:id(^\\d+$)/web-credentials/:cid(^\\d+$)/authorize`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const appId = Number(req.params.id);
    const c = await loadCredentialById({ appId, id: Number(req.params.cid) });
    return startConsent(req, reply, s, c, { appId });
  });

  // the service sends the browser back here: with a code, or with an error (the developer said no)
  app.get(CALLBACK, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const tx = tr(s);
    const q = (req.query ?? {}) as Record<string, unknown>;
    const state = typeof q.state === 'string' ? q.state : '';
    // one-time: taken whatever happens next; only the session that started it, within ten minutes
    const p = state && state.length <= 200 ? await owner.one<{ app_id: number | null; workspace: boolean; credential_id: string; username: string; code_verifier: string }>(
      `delete from meta.web_credential_pending where state_hash = $1 and session_hash = $2 and created_at > now() - make_interval(mins => $3)
        returning app_id, workspace, credential_id::text, username, code_verifier`, [sha256(state), sha256(s.id), PENDING_MINUTES]) : null;
    if (!p || p.username !== s.username) {
      flash(s, tx('oac.bad_state'), 'error');
      return back(reply, s, `${BASE}/home`);
    }
    const home = pageOf(p);
    const c = await loadCredentialById(p.app_id ? { appId: p.app_id, id: Number(p.credential_id) } : { workspaceId: s.workspace?.id ?? -1, id: Number(p.credential_id) });
    if (!c) {
      flash(s, tx('oac.gone'), 'error');
      return back(reply, s, `${BASE}/home`);
    }
    if (typeof q.error === 'string') {
      // the service's error code only (a short token), never its free text
      const code = /^[A-Za-z0-9_.-]{1,60}$/.test(q.error) ? q.error : 'error';
      await logActivity({ appId: p.app_id, username: s.username, event: 'web_credential_consent', ip: clientIp(req), detail: `web credential ${c.name}: refused (${code})` });
      flash(s, tx('oac.refused', { name: c.name, code }), 'error');
      return back(reply, s, home);
    }
    const code = typeof q.code === 'string' && q.code.length <= 4000 ? q.code : '';
    if (!code) {
      flash(s, tx('oac.no_code'), 'error');
      return back(reply, s, home);
    }
    try {
      const what = `token endpoint of web credential ${c.name}`;
      const scope = p.app_id ? await scopeForApp(p.app_id, what) : s.workspace ? await scopeForWorkspace(s.workspace.id, what) : null;
      const r = await exchangeAuthorizationCode(c, { code, verifier: p.code_verifier, redirectUri: consentRedirectUri() }, scope);
      await logActivity({ appId: p.app_id, username: s.username, event: 'web_credential_consent', ip: clientIp(req), detail: `web credential ${c.name}: authorized${r.refresh ? '' : ' (no refresh token)'}` });
      flash(s, r.refresh ? tx('oac.done', { name: c.name }) : tx('oac.no_refresh', { name: c.name, at: r.expires.toISOString().slice(0, 16).replace('T', ' ') }), r.refresh ? 'ok' : 'error');
    } catch (e) {
      await logActivity({ appId: p.app_id, username: s.username, event: 'web_credential_consent', ip: clientIp(req), detail: `web credential ${c.name}: the token request failed` });
      flash(s, tx('oac.failed', { name: c.name, error: (e as Error).message }), 'error');
    }
    return back(reply, s, home);
  });
}
