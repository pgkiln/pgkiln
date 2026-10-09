import { SignJWT } from 'jose';
import { owner } from './db.ts';

// Tokens for the REST API that PostgREST serves next to pgkiln. They're
// HS256 JWTs signed with API_JWT_SECRET (the same secret PostgREST uses),
// carrying the claims meta.app_user() / meta.has_role() understand.

export const apiUrl = () => (process.env.API_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
export const MAX_TOKEN_HOURS = 24 * 30;

export function jwtSecret() {
  const s = process.env.API_JWT_SECRET ?? '';
  if (s.length < 32) throw new Error('API_JWT_SECRET is not set (at least 32 characters, shared with PostgREST).');
  return new TextEncoder().encode(s);
}

/**
 * Why a role can't be an application's API role, or null when it can. A
 * token names the role PostgREST switches to, so it must never be a role
 * that bypasses row level security or owns pgkiln's metadata.
 */
export async function apiRoleProblem(role: string) {
  const r = await owner.one(
    `select r.rolsuper, r.rolbypassrls, pg_has_role(r.oid, current_user, 'MEMBER') as owns_meta,
            r.rolname in ('pgkiln_authenticator', 'pgkiln_runtime', 'pgkiln_anon') as internal
       from pg_roles r where r.rolname = $1`,
    [role],
  );
  if (!r) return `There is no database role "${role}".`;
  if (r.rolsuper || r.rolbypassrls) return `"${role}" bypasses row level security; use a role with only the API's privileges.`;
  if (r.owns_meta || r.internal) return `"${role}" is one of pgkiln's own roles; create a dedicated API role (see the REST API chapter).`;
  return null;
}

/** Whether PostgREST at API_URL answers, and its version. */
export async function apiStatus(): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(`${apiUrl()}/`, { signal: AbortSignal.timeout(2000) });
    return { ok: res.ok, detail: res.headers.get('server') ?? `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

/**
 * Issue a token for an account in an application. The account must be
 * active and have access to the app. Roles are not put in the token:
 * meta.has_role() reads them from meta.app_access at each request, and
 * meta.api_check() rejects the token once the account loses access.
 */
export async function issueApiToken(appId: number, username: string, hours: number) {
  const app = await owner.one('select alias, api_role, access_control from meta.app where id = $1', [appId]);
  if (!app) throw new Error('No such application.');
  // without an API role the token is for pgkiln's own REST modules only (they run as the app's role)
  const problem = app.api_role ? await apiRoleProblem(app.api_role) : null;
  if (problem) throw new Error(problem);
  const acc = await owner.one(
    `select a.username, a.active, aa.app_id is not null as has_access
       from meta.account a left join meta.app_access aa on aa.account_id = a.id and aa.app_id = $1
      where lower(a.username) = lower($2)`,
    [appId, username],
  );
  if (!acc) throw new Error(`There is no account "${username}".`);
  if (!acc.active) throw new Error('This account is inactive.');
  if (!acc.has_access && app.access_control !== 'any_user') throw new Error('This account has no access to the application.');
  const ttl = Math.max(1, Math.min(MAX_TOKEN_HOURS, Math.round(hours)));
  const token = await new SignJWT({ ...(app.api_role ? { role: app.api_role } : {}), app_user: acc.username, app: app.alias })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setExpirationTime(`${ttl}h`)
    .sign(jwtSecret());
  return { token, expiresInHours: ttl, username: acc.username as string };
}
