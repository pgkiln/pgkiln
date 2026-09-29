import { SignJWT } from 'jose';
import { owner } from './db.ts';

// Tokens for the REST API that PostgREST serves next to pgapex. They're
// HS256 JWTs signed with API_JWT_SECRET (the same secret PostgREST uses),
// carrying the claims meta.app_user() / meta.has_role() understand.

export const apiUrl = () => (process.env.API_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
export const MAX_TOKEN_HOURS = 24 * 30;

function secret() {
  const s = process.env.API_JWT_SECRET ?? '';
  if (s.length < 32) throw new Error('API_JWT_SECRET is not set (at least 32 characters, shared with PostgREST).');
  return new TextEncoder().encode(s);
}

/**
 * Issue a token for an account in an application. The account must be
 * active and have access to the app; its roles in the app are included.
 */
export async function issueApiToken(appId: number, username: string, hours: number) {
  const app = await owner.one('select alias, api_role, access_control from meta.app where id = $1', [appId]);
  if (!app?.api_role) throw new Error('Set the application’s API database role first.');
  const acc = await owner.one(
    `select a.username, a.active, aa.roles, aa.app_id is not null as has_access
       from meta.account a left join meta.app_access aa on aa.account_id = a.id and aa.app_id = $1
      where lower(a.username) = lower($2)`,
    [appId, username],
  );
  if (!acc) throw new Error(`There is no account "${username}".`);
  if (!acc.active) throw new Error('This account is inactive.');
  if (!acc.has_access && app.access_control !== 'any_user') throw new Error('This account has no access to the application.');
  const ttl = Math.max(1, Math.min(MAX_TOKEN_HOURS, Math.round(hours)));
  const token = await new SignJWT({ role: app.api_role, app_user: acc.username, app: app.alias, roles: acc.roles ?? [] })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setExpirationTime(`${ttl}h`)
    .sign(secret());
  return { token, expiresInHours: ttl, username: acc.username as string };
}
