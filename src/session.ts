import type { FastifyReply, FastifyRequest } from 'fastify';
import { runtime } from './db.ts';
import { hashToken, loginMaxFailuresPerIp, loginMaxFailuresPerUser, loginWindowMinutes, newToken } from './security.ts';
import { instanceSetting } from './instance.ts';

export interface Session {
  id: string; // internal id, exposed to SQL as pgkiln.session_id
  app_id: number | null;
  username: string | null;
  csrf_token: string;
  state: Record<string, string | null>;
  /** Roles resolved at sign-in (lower case); see meta.has_role(). */
  roles: string[];
  isNew?: boolean;
  /** Builder only: the developer's workspaces and the current one (src/builder/workspaces.ts). */
  workspaces?: { id: number; name: string }[];
  workspace?: { id: number; name: string } | null;
}

// instance settings (src/instance.ts): the builder's value, else SESSION_* environment variables, else 60 minutes / 8 hours
const IDLE_MINUTES = () => instanceSetting('session_idle_minutes');
const MAX_HOURS = () => instanceSetting('session_max_hours');
const secure = () => process.env.COOKIE_SECURE === 'true';

export const cookieName = (appId: number | null) => (appId === null ? 'pgkiln_dev' : `pgkiln_app_${appId}`);

async function find(token: string | undefined, appId: number | null) {
  if (!token || token.length > 100) return undefined;
  return runtime.one<Session>(
    `update meta.session set last_seen = now()
      where token_hash = $1 and app_id is not distinct from $2
        and last_seen > now() - make_interval(mins => $3)
        and created_at > now() - make_interval(hours => $4)
     returning id, app_id, username, csrf_token, state, roles`,
    [hashToken(token), appId, IDLE_MINUTES(), MAX_HOURS()],
  );
}

/**
 * The cookie holds a random token; the database only stores its sha256.
 * Expired sessions are purged opportunistically.
 */
export async function createSession(reply: FastifyReply, appId: number | null, path: string, username: string | null = null, roles: string[] = []) {
  const token = newToken();
  const s = (await runtime.one<Session>(
    `insert into meta.session (token_hash, app_id, username, roles) values ($1, $2, $3, $4)
     returning id, app_id, username, csrf_token, state, roles`,
    [hashToken(token), appId, username, roles.map((r) => r.toLowerCase())],
  ))!;
  if (Math.random() < 0.05)
    runtime
      .query(`delete from meta.session where last_seen < now() - make_interval(mins => $1) or created_at < now() - make_interval(hours => $2)`, [IDLE_MINUTES(), MAX_HOURS()])
      .catch(() => {});
  reply.setCookie(cookieName(appId), token, { path, httpOnly: true, sameSite: 'lax', secure: secure() });
  return { ...s, isNew: true };
}

export async function getSession(req: FastifyRequest, reply: FastifyReply, appId: number | null, path: string) {
  return (await find(req.cookies[cookieName(appId)], appId)) ?? createSession(reply, appId, path);
}

export async function saveState(s: Session) {
  await runtime.query('update meta.session set state = $2 where id = $1', [s.id, s.state]);
}

export async function destroySession(reply: FastifyReply, s: Session, path: string) {
  await runtime.query('delete from meta.session where id = $1', [s.id]);
  reply.clearCookie(cookieName(s.app_id), { path });
}

/** Take (and clear) a one-shot flash message stored in session state. */
export function takeFlash(s: Session, key = '__FLASH') {
  const msg = s.state[key] ?? null;
  delete s.state[key];
  return msg;
}

export function clientIp(req: FastifyRequest) {
  return req.ip;
}

/** Fire-and-forget activity log entry; returns the log id when awaited. */
export async function logActivity(entry: {
  appId?: number | null;
  pageNo?: number | null;
  username?: string | null;
  event: string;
  ip?: string;
  elapsedMs?: number;
  detail?: string;
}) {
  try {
    const r = await runtime.one<{ id: string }>(
      `insert into meta.activity_log (app_id, page_no, username, event, ip, elapsed_ms, detail)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [entry.appId ?? null, entry.pageNo ?? null, entry.username ?? null, entry.event, entry.ip ?? null, entry.elapsedMs ?? null, entry.detail?.slice(0, 2000) ?? null],
    );
    return r?.id;
  } catch {
    return undefined;
  }
}

/**
 * Login throttling: failed attempts since the user's last successful login
 * within the window, per username and per IP address. appId null = builder.
 */
export async function loginThrottled(appId: number | null, username: string, ip: string) {
  const counts = await runtime.one<{ user_fails: number; ip_fails: number }>(
    `select count(*) filter (where lower(l.username) = lower($2)
                               and l.at > coalesce((select max(s.at) from meta.activity_log s
                                                     where ((s.app_id is not distinct from $1 and s.event = 'login') or s.event = 'login_unlocked')
                                                       and lower(s.username) = lower($2)), '-infinity'))::int as user_fails,
            count(*) filter (where l.ip = $3)::int as ip_fails
       from meta.activity_log l
      where l.app_id is not distinct from $1 and l.event = 'login_failed' and l.at > now() - make_interval(mins => $4)`,
    [appId, username, ip, loginWindowMinutes()],
  );
  return !!counts && (counts.user_fails >= loginMaxFailuresPerUser() || counts.ip_fails >= loginMaxFailuresPerIp());
}
