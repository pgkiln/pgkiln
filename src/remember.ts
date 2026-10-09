import type { FastifyReply, FastifyRequest } from 'fastify';
import { passwordDaysLeft } from './accounts.ts';
import { owner } from './db.ts';
import { hashToken, newToken } from './security.ts';
import { ssoAccess } from './sso.ts';

// "Remember me" (APEX: persistent authentication). The cookie holds a
// random token; meta.persistent_login keeps its sha256, the account, the
// sign-in's identity-provider groups and a fixed expiry (N days after the
// sign-in, never extended). Using a token deletes it and issues a new one,
// so a copied cookie works once at most. Access, the account's state and
// group-mapped roles are checked again on every use.

export const rememberCookie = (appId: number) => `pgkiln_remember_${appId}`;
const secure = () => process.env.COOKIE_SECURE === 'true';

interface RememberApp {
  id: number;
  alias: string;
  remember_me_days: number | null;
}

/** After a sign-in with "Remember me" checked: a token valid for the app's number of days. */
export async function issueRemember(req: FastifyRequest, reply: FastifyReply, a: RememberApp, username: string, opts: { groups?: string[]; method?: string; expiresAt?: Date } = {}) {
  if (!a.remember_me_days) return;
  const token = newToken();
  const row = await owner.one<{ expires_at: Date }>(
    `insert into meta.persistent_login (app_id, account_id, token_hash, groups, method, user_agent, expires_at)
     select $1, ac.id, $3, $4, $5, left($6, 200), coalesce($7::timestamptz, now() + make_interval(days => $8))
       from meta.account ac where lower(ac.username) = lower($2)
     returning expires_at`,
    [a.id, username, hashToken(token), opts.groups ?? [], opts.method ?? 'password', req.headers['user-agent'] ?? null, opts.expiresAt ?? null, a.remember_me_days],
  );
  if (!row) return;
  const maxAge = Math.max(0, Math.floor((new Date(row.expires_at).getTime() - Date.now()) / 1000));
  reply.setCookie(rememberCookie(a.id), token, { path: `/a/${a.alias}`, httpOnly: true, sameSite: 'lax', secure: secure(), maxAge });
}

/**
 * The account a valid "Remember me" cookie stands for, with its group-mapped
 * roles, or null (and the cookie cleared). The token is used up either way;
 * the caller signs the user in and calls issueRemember() with `expiresAt`.
 */
export async function useRemember(req: FastifyRequest, reply: FastifyReply, a: RememberApp) {
  const token = req.cookies[rememberCookie(a.id)];
  if (!token) return null;
  const clear = () => reply.clearCookie(rememberCookie(a.id), { path: `/a/${a.alias}` });
  if (!a.remember_me_days || token.length > 100) return clear(), null;
  const row = await owner.one<{ username: string; active: boolean; groups: string[]; method: string; expires_at: Date }>(
    `with used as (
       delete from meta.persistent_login where token_hash = $1 and app_id = $2 returning account_id, groups, method, expires_at)
     select ac.username, ac.active, u.groups, u.method, u.expires_at
       from used u join meta.account ac on ac.id = u.account_id
      where u.expires_at > now()`,
    [hashToken(token), a.id],
  );
  if (!row || !row.active) return clear(), null;
  // an expired password needs the password form; access may have been withdrawn
  if (row.method === 'password' && (await passwordDaysLeft(row.username)) === 0) return clear(), null;
  const access = await ssoAccess(a.id, row.username, row.groups);
  if (!access.allowed) return clear(), null;
  return { username: row.username, roles: access.roles, groups: row.groups, method: row.method, expiresAt: new Date(row.expires_at) };
}

/** Sign-out: forget this browser's token. */
export async function forgetRemember(req: FastifyRequest, reply: FastifyReply, a: { id: number; alias: string }) {
  const token = req.cookies[rememberCookie(a.id)];
  if (token && token.length <= 100) await owner.query('delete from meta.persistent_login where token_hash = $1', [hashToken(token)]);
  reply.clearCookie(rememberCookie(a.id), { path: `/a/${a.alias}` });
}

/** My account → "Sign out on all devices": every remembered sign-in of the account in this app. */
export async function forgetAllRemembered(appId: number, username: string) {
  await owner.query(
    'delete from meta.persistent_login where app_id = $1 and account_id = (select id from meta.account where lower(username) = lower($2))',
    [appId, username],
  );
}

/** How many browsers remember the account in this app. */
export async function rememberedCount(appId: number, username: string) {
  return (
    await owner.one<{ n: number }>(
      `select count(*)::int as n from meta.persistent_login
        where app_id = $1 and expires_at > now() and account_id = (select id from meta.account where lower(username) = lower($2))`,
      [appId, username],
    )
  )?.n ?? 0;
}
