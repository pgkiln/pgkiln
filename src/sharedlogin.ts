import type { FastifyReply, FastifyRequest } from 'fastify';
import { passwordDaysLeft } from './accounts.ts';
import { owner } from './db.ts';
import { instanceSetting } from './instance.ts';
import { hashToken, newToken } from './security.ts';
import { ssoAccess } from './sso.ts';

// Session sharing between applications (067; APEX: session sharing). Apps
// with the same meta.app.session_group and the user directory as
// authentication share a sign-in: signing in to one sets a group cookie
// (path /, HttpOnly) whose token's sha256 is in meta.shared_login; opening
// another app of the group without a session signs the user in there, after
// that app's own access check and with its own roles (group-mapped roles
// from the identity provider's groups kept with the shared sign-in). The
// shared sign-in ends after the session idle time without use, after the
// maximum session length, and when the user signs out of any app of the
// group, which also ends the sessions it started (session state __SHARED).

const secure = () => process.env.COOKIE_SECURE === 'true';
export const shareCookie = (group: string) => `pgapex_share_${group}`;
const GROUP = /^[a-z][a-z0-9_]{0,29}$/;

interface SharingApp {
  id: number;
  authentication: string;
  session_group?: string | null;
}

/** The app's session sharing group, when it can share (the user directory as authentication). */
export const sharingGroup = (a: SharingApp) => (a.authentication === 'app_users' && typeof a.session_group === 'string' && GROUP.test(a.session_group) ? a.session_group : null);

/** After a sign-in to an app of a group: the shared sign-in (a new one replaces this browser's old one). Returns its token's hash. */
export async function issueShared(req: FastifyRequest, reply: FastifyReply, a: SharingApp, username: string, opts: { groups?: string[]; method?: string } = {}) {
  const group = sharingGroup(a);
  if (!group) return null;
  const old = req.cookies[shareCookie(group)];
  if (old && old.length <= 100) await owner.query('delete from meta.shared_login where token_hash = $1', [hashToken(old)]);
  const token = newToken();
  const hash = hashToken(token);
  const row = await owner.one(
    `insert into meta.shared_login (token_hash, session_group, account_id, groups, method)
     select $1, $2, ac.id, $4, $5 from meta.account ac where lower(ac.username) = lower($3) returning token_hash`,
    [hash, group, username, opts.groups ?? [], opts.method ?? 'password'],
  );
  if (!row) return null;
  if (Math.random() < 0.05) purgeShared().catch(() => {});
  reply.setCookie(shareCookie(group), token, { path: '/', httpOnly: true, sameSite: 'lax', secure: secure(), maxAge: instanceSetting('session_max_hours') * 3600 });
  return hash;
}

/**
 * The account a valid shared sign-in of the app's group stands for, with this
 * app's roles, or null (an unusable cookie is cleared). Checks the idle time,
 * the maximum length, the account, an expired password and access to this app.
 */
export async function useShared(req: FastifyRequest, reply: FastifyReply, a: SharingApp) {
  const group = sharingGroup(a);
  if (!group) return null;
  const token = req.cookies[shareCookie(group)];
  if (!token) return null;
  const clear = () => reply.clearCookie(shareCookie(group), { path: '/' });
  if (token.length > 100) return clear(), null;
  const hash = hashToken(token);
  const row = await owner.one<{ username: string; active: boolean; groups: string[]; method: string }>(
    `update meta.shared_login l set last_seen = now()
       from meta.account ac
      where l.token_hash = $1 and l.session_group = $2 and ac.id = l.account_id
        and l.last_seen > now() - make_interval(mins => $3) and l.created_at > now() - make_interval(hours => $4)
     returning ac.username, ac.active, l.groups, l.method`,
    [hash, group, instanceSetting('session_idle_minutes'), instanceSetting('session_max_hours')],
  );
  if (!row || !row.active) {
    await owner.query('delete from meta.shared_login where token_hash = $1', [hash]);
    return clear(), null;
  }
  if (row.method === 'password' && (await passwordDaysLeft(row.username)) === 0) return null;
  const access = await ssoAccess(a.id, row.username, row.groups);
  if (!access.allowed) return null; // no access to this app: its own sign-in page (the shared sign-in stays for the others)
  return { username: row.username, roles: access.roles, groups: row.groups, method: row.method, hash };
}

/** Sign-out from an app of a group: the shared sign-in and every session it started end. */
export async function endShared(req: FastifyRequest, reply: FastifyReply, a: SharingApp) {
  const group = sharingGroup(a);
  if (!group) return;
  const token = req.cookies[shareCookie(group)];
  reply.clearCookie(shareCookie(group), { path: '/' });
  if (!token || token.length > 100) return;
  const hash = hashToken(token);
  await owner.query('delete from meta.shared_login where token_hash = $1', [hash]);
  await owner.query(`delete from meta.session where state->>'__SHARED' = $1`, [hash]);
}

/** Housekeeping: shared sign-ins past the maximum session length. */
export async function purgeShared() {
  await owner.query('delete from meta.shared_login where created_at < now() - make_interval(hours => $1)', [instanceSetting('session_max_hours')]);
}
