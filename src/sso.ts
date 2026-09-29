import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { owner } from './db.ts';

// OpenID Connect sign-in (authorization code flow with PKCE).
//
// Security measures:
//  * state (one-time, 10 minutes) + a cookie of the browser that started the
//    flow, so a callback can't be replayed or injected into another browser
//    (login CSRF);
//  * PKCE (S256) and a nonce bound to the ID token;
//  * ID token signature checked against the provider's JWKS, with issuer,
//    audience, expiry and an algorithm allow-list;
//  * accounts are linked by the provider's stable subject ("sub"); an
//    existing account is linked by username only while it has no identity
//    at that provider yet;
//  * client secrets are read with the owner connection only.

export interface Provider {
  id: number;
  name: string;
  display_name: string;
  issuer: string;
  client_id: string;
  client_secret: string | null;
  scopes: string;
  username_claim: string;
  groups_claim: string;
  auto_create: boolean;
  enabled: boolean;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  token_endpoint_auth_methods_supported?: string[];
}

export class SsoError extends Error {}

const ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'];
const PENDING_MINUTES = 10;
const b64url = (b: Buffer) => b.toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export const publicUrl = () => (process.env.PUBLIC_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3100}`).replace(/\/+$/, '');
export const redirectUri = (p: Pick<Provider, 'name'>) => `${publicUrl()}/sso/callback/${p.name}`;

export async function loadProvider(name: string) {
  return owner.one<Provider>('select * from meta.auth_provider where name = $1 and enabled', [name]);
}

export async function enabledProviders(names: string[]) {
  if (!names.length) return [];
  return (await owner.query<Provider>('select id, name, display_name from meta.auth_provider where enabled and name = any($1) order by display_name', [names])).rows;
}

// Discovery documents and key sets are cached per issuer.
const discoveryCache = new Map<string, { at: number; doc: Discovery }>();
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function discover(issuer: string): Promise<Discovery> {
  const hit = discoveryCache.get(issuer);
  if (hit && Date.now() - hit.at < 3600_000) return hit.doc;
  const res = await fetch(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new SsoError(`Discovery failed for ${issuer} (HTTP ${res.status}).`);
  const doc = (await res.json()) as Discovery;
  if (doc.issuer?.replace(/\/+$/, '') !== issuer.replace(/\/+$/, '')) throw new SsoError('The discovery document belongs to a different issuer.');
  for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const)
    if (!doc[k]) throw new SsoError(`The discovery document has no ${k}.`);
  discoveryCache.set(issuer, { at: Date.now(), doc });
  return doc;
}

function jwks(doc: Discovery) {
  let set = jwksCache.get(doc.jwks_uri);
  if (!set) jwksCache.set(doc.jwks_uri, (set = createRemoteJWKSet(new URL(doc.jwks_uri))));
  return set;
}

/** Start: returns the provider URL to redirect to, and the browser-binding cookie value. */
export async function startSignIn(p: Provider, appId: number, next: string | undefined) {
  const doc = await discover(p.issuer);
  const state = b64url(randomBytes(32));
  const nonce = b64url(randomBytes(32));
  const verifier = b64url(randomBytes(48));
  const browserKey = b64url(randomBytes(32));
  await owner.query(`delete from meta.sso_pending where created_at < now() - make_interval(mins => $1)`, [PENDING_MINUTES]);
  await owner.query(
    `insert into meta.sso_pending (state, app_id, provider_id, code_verifier, nonce, browser_hash, next)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [state, appId, p.id, verifier, nonce, sha256(browserKey), next ?? null],
  );
  const url = new URL(doc.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: p.client_id,
    redirect_uri: redirectUri(p),
    scope: p.scopes,
    state,
    nonce,
    code_challenge: b64url(createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
  }).toString();
  return { url: url.toString(), browserKey };
}

/** Read a claim by name or dot path (e.g. realm_access.roles). */
function claim(payload: JWTPayload, path: string): unknown {
  return path.split('.').reduce<any>((v, k) => (v && typeof v === 'object' ? v[k] : undefined), payload);
}

export interface SsoResult {
  appId: number;
  next: string | null;
  username: string;
  groups: string[];
}

/** Callback: validate state/browser, exchange the code, verify the ID token, resolve the account. */
export async function finishSignIn(p: Provider, params: URLSearchParams, browserKey: string | undefined): Promise<SsoResult> {
  if (params.get('error')) throw new SsoError(`The identity provider refused the sign-in: ${params.get('error_description') ?? params.get('error')}`);
  const state = params.get('state') ?? '';
  const code = params.get('code') ?? '';
  const pending = await owner.one(
    `delete from meta.sso_pending where state = $1 and provider_id = $2 and created_at > now() - make_interval(mins => $3)
     returning app_id, code_verifier, nonce, browser_hash, next`,
    [state, p.id, PENDING_MINUTES],
  );
  if (!pending) throw new SsoError('This sign-in link has expired or was already used. Please try again.');
  if (!browserKey || sha256(browserKey) !== pending.browser_hash)
    throw new SsoError('This sign-in was started in another browser. Please try again.');
  if (!code) throw new SsoError('The identity provider returned no authorization code.');

  const doc = await discover(p.issuer);
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(p),
    code_verifier: pending.code_verifier,
    client_id: p.client_id,
  });
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (p.client_secret) {
    const methods = doc.token_endpoint_auth_methods_supported ?? ['client_secret_basic'];
    if (methods.includes('client_secret_basic'))
      headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(p.client_id)}:${encodeURIComponent(p.client_secret)}`).toString('base64')}`;
    else form.set('client_secret', p.client_secret);
  }
  const res = await fetch(doc.token_endpoint, { method: 'POST', headers, body: form, signal: AbortSignal.timeout(10_000) });
  const tokens = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string };
  if (!res.ok || !tokens.id_token) throw new SsoError(`The token request failed${tokens.error ? ` (${tokens.error})` : ''}.`);

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(tokens.id_token, jwks(doc), {
      issuer: doc.issuer,
      audience: p.client_id,
      algorithms: ALGORITHMS,
      clockTolerance: 60,
    }));
  } catch (e) {
    throw new SsoError(`The identity token is not valid (${(e as Error).message}).`);
  }
  if (payload.nonce !== pending.nonce) throw new SsoError('The identity token does not belong to this sign-in (nonce mismatch).');
  if (!payload.sub) throw new SsoError('The identity token has no subject.');

  const username = claim(payload, p.username_claim);
  if (typeof username !== 'string' || !username || /[\s:]/.test(username) || username.length > 100)
    throw new SsoError(`The identity token has no usable "${p.username_claim}" claim.`);
  if (p.username_claim === 'email' && payload.email_verified === false) throw new SsoError('Your e-mail address is not verified at the identity provider.');
  const rawGroups = claim(payload, p.groups_claim);
  const groups = Array.isArray(rawGroups) ? rawGroups.filter((g): g is string => typeof g === 'string').map((g) => g.replace(/^\//, '')) : [];

  const account = await resolveAccount(p, payload, username);
  return { appId: pending.app_id, next: pending.next, username: account, groups };
}

/** Find the account for this identity, link it on first use, or create it (auto_create). */
async function resolveAccount(p: Provider, payload: JWTPayload, username: string) {
  return owner.tx(async (c) => {
    const linked = await c.query(
      `select a.username, a.active from meta.account_identity i join meta.account a on a.id = i.account_id
        where i.provider_id = $1 and i.subject = $2`,
      [p.id, payload.sub],
    );
    let acc = linked.rows[0];
    if (!acc) {
      const byName = await c.query(
        `select a.id, a.username, a.active,
                exists (select 1 from meta.account_identity i where i.account_id = a.id and i.provider_id = $2) as has_identity
           from meta.account a where lower(a.username) = lower($1)`,
        [username, p.id],
      );
      let row = byName.rows[0];
      if (row?.has_identity)
        throw new SsoError('This account is already linked to another identity at this provider.');
      if (!row) {
        if (!p.auto_create) throw new SsoError(`There is no account for "${username}". Ask an administrator for access.`);
        row = (
          await c.query(
            `insert into meta.account (username, display_name, email) values ($1, $2, $3) returning id, username, active`,
            [username, typeof payload.name === 'string' ? payload.name : null, typeof payload.email === 'string' ? payload.email : null],
          )
        ).rows[0];
      }
      await c.query('insert into meta.account_identity (provider_id, subject, account_id) values ($1, $2, $3)', [p.id, payload.sub, row.id]);
      acc = row;
    }
    if (!acc.active) throw new SsoError('Your account is disabled.');
    await c.query('update meta.account set last_login_at = now() where lower(username) = lower($1)', [acc.username]);
    return acc.username as string;
  });
}

/**
 * Roles from identity-provider groups for an app, and whether the account
 * may use the app at all (access row, any_user, or a mapped group).
 */
export async function ssoAccess(appId: number, username: string, groups: string[]) {
  const mapped = (
    await owner.query<{ role: string }>(
      'select distinct lower(role) as role from meta.app_group_role where app_id = $1 and group_name = any($2)',
      [appId, groups],
    )
  ).rows.map((r) => r.role);
  const r = await owner.one(
    `select a.access_control = 'any_user' or exists (
              select 1 from meta.app_access aa join meta.account ac on ac.id = aa.account_id
               where aa.app_id = a.id and lower(ac.username) = lower($2)) as allowed
       from meta.app a where a.id = $1`,
    [appId, username],
  );
  return { allowed: !!r?.allowed || mapped.length > 0, roles: mapped };
}
