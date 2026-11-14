// (sprint 194, NX-F4, SEC-1) Personal builder tokens (migration 171): a developer's key for the builder's API
// (/builder/api/v1, src/builder/api-v1.ts), which `pgkiln mcp --url … --token-env …` uses to act as that developer from
// their own machine. A token belongs to one developer and one workspace, has scopes (read, write, sql), always
// expires (default 30 days, at most 365), and is kept as sha256 only: it is shown once, when it is made.
//
// What a token may do is looked up at every request, never copied into it: the developer must still exist, still be
// a member of the workspace (or an administrator), and not be held to set up a second factor first. Making one needs a
// recent sign-in with the factors the developer must use (single sign-on, a second factor; tokenStepUp in
// src/builder/tokens.ts). Removing a developer removes their tokens (foreign key); a password set by an administrator
// or on the command line, their own new password and a reset of their second factors revoke them (revokeTokensOf).
import { owner } from './db.ts';
import { enrolmentDue } from './mfa.ts';
import { hashToken, loginMaxFailuresPerIp, loginWindowMinutes } from './security.ts';
import { randomBytes } from 'node:crypto';

export const TOKEN_SCOPES = ['read', 'write', 'sql'] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];
export const DEFAULT_TOKEN_DAYS = 30;
export const MAX_TOKEN_DAYS = 365;
/** Live tokens one developer may have. */
export const MAX_TOKENS = 50;
/** Minutes after a sign-in (or a step-up) in which a developer may make a token. */
export const STEP_UP_MINUTES = 10;
/** Every token starts with this, so a secret scanner (and a person) recognises one. */
export const TOKEN_PREFIX = 'pgkb_';
const TOKEN_RE = /^pgkb_[A-Za-z0-9_-]{43}$/;
const NAME_RE = /^\S(.{0,58}\S)?$/;

export interface BuilderToken {
  id: number;
  username: string;
  workspace_id: number;
  workspace: string;
  name: string;
  scopes: TokenScope[];
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  last_used_ip: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  revoked_reason: string | null;
  /** live: not revoked and not expired */
  live: boolean;
}

export class TokenError extends Error {}

const COLUMNS = `t.id::int as id, t.username, t.workspace_id, w.name as workspace, t.name, t.scopes, t.created_at::text, t.expires_at::text,
  t.last_used_at::text, t.last_used_ip, t.revoked_at::text, t.revoked_by, t.revoked_reason,
  (t.revoked_at is null and t.expires_at > now()) as live`;

/** The scopes of a form or a request, in their order; unknown ones are refused. */
export function parseScopes(given: unknown): TokenScope[] {
  const list = [given].flat().flatMap((v) => String(v ?? '').split(/[\s,]+/)).map((v) => v.trim().toLowerCase()).filter(Boolean);
  for (const s of list) if (!(TOKEN_SCOPES as readonly string[]).includes(s)) throw new TokenError(`Unknown scope ${s}: read, write or sql.`);
  return TOKEN_SCOPES.filter((s) => list.includes(s));
}

/** Make a token; returns it (the only time it exists outside the caller's hands) with its row. */
export async function createToken(o: { username: string; workspaceId: number; name: string; scopes: TokenScope[]; days: number }) {
  const name = String(o.name ?? '').trim();
  if (!NAME_RE.test(name)) throw new TokenError('A name of 1 to 60 characters, not starting or ending with a space.');
  if (!o.scopes.length) throw new TokenError('Choose at least one scope.');
  if (!Number.isInteger(o.days) || o.days < 1 || o.days > MAX_TOKEN_DAYS) throw new TokenError(`Expires in 1 to ${MAX_TOKEN_DAYS} days.`);
  const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
  return owner.tx(async (c) => {
    // tokens revoked or expired more than 90 days ago are of no more use, not even to read
    await c.query(`delete from meta.builder_token where username = $1 and coalesce(revoked_at, expires_at) < now() - interval '90 days'`, [o.username]);
    const n = (await c.query<{ n: number }>(`select count(*)::int as n from meta.builder_token where username = $1 and revoked_at is null and expires_at > now()`, [o.username])).rows[0].n;
    if (n >= MAX_TOKENS) throw new TokenError(`You have ${n} live tokens: revoke one first.`);
    if ((await c.query(`select 1 from meta.builder_token where username = $1 and lower(name) = lower($2) and revoked_at is null`, [o.username, name])).rowCount)
      throw new TokenError(`You already have a token named ${name}: choose another name, or revoke that one.`);
    const id = (await c.query<{ id: number }>(
      `insert into meta.builder_token (username, workspace_id, name, token_hash, scopes, expires_at)
       values ($1, $2, $3, $4, $5, now() + make_interval(days => $6)) returning id::int`,
      [o.username, o.workspaceId, name, hashToken(token), o.scopes, o.days],
    )).rows[0].id;
    return { token, id };
  });
}

/** A developer's tokens (live first), or every developer's (null: the administrators' list). */
export async function tokensOf(username: string | null): Promise<BuilderToken[]> {
  return (await owner.query<BuilderToken>(
    `select ${COLUMNS} from meta.builder_token t join meta.workspace w on w.id = t.workspace_id
      where ($1::text is null or t.username = $1)
        and ($1::text is not null or (t.revoked_at is null and t.expires_at > now()))
        and coalesce(t.revoked_at, least(t.expires_at, now())) > now() - interval '90 days'
      order by (t.revoked_at is null and t.expires_at > now()) desc, t.username, t.created_at desc`,
    [username],
  )).rows;
}

/** Revoke one token: the developer's own (username given) or anyone's (an administrator: null). False when not found. */
export async function revokeToken(id: number, by: string, reason: string, onlyOf: string | null): Promise<BuilderToken | null> {
  const r = await owner.one<{ id: number }>(
    `update meta.builder_token set revoked_at = now(), revoked_by = $2, revoked_reason = $3
      where id = $1 and revoked_at is null and ($4::text is null or username = $4) returning id::int`,
    [id, by.slice(0, 200), reason.slice(0, 200), onlyOf],
  );
  if (!r) return null;
  return (await owner.one<BuilderToken>(`select ${COLUMNS} from meta.builder_token t join meta.workspace w on w.id = t.workspace_id where t.id = $1`, [id])) ?? null;
}

/**
 * Revoke every live token of a developer (a password set for them, their second factors reset, their own new
 * password). `db`: inside the caller's transaction. Returns how many.
 */
export async function revokeTokensOf(username: string, reason: string, by = 'pgkiln', db: { query: (sql: string, params?: unknown[]) => Promise<{ rowCount: number | null }> } = owner) {
  return (await db.query(
    `update meta.builder_token set revoked_at = now(), revoked_by = $2, revoked_reason = $3 where username = $1 and revoked_at is null`,
    [username, by.slice(0, 200), reason.slice(0, 200)],
  )).rowCount ?? 0;
}

/** Who a request's token is: the developer, the workspace, the scopes. Built fresh for every request. */
export interface TokenCaller {
  tokenId: number;
  name: string;
  username: string;
  workspaceId: number;
  workspace: string;
  scopes: TokenScope[];
  expiresAt: string;
  admin: boolean;
}

export type TokenCheck = { ok: true; caller: TokenCaller } | { ok: false; status: 401 | 403 | 429; error: string; log?: string };

/** The token of an Authorization header ("Bearer pgkb_…"), or null. Nothing else (cookies, the query string) counts. */
export function bearerOf(header: unknown): string | null {
  if (typeof header !== 'string' || header.length > 200) return null;
  const m = /^Bearer[ ]+(\S+)[ ]*$/i.exec(header);
  return m ? m[1] : null;
}

/** Too many failed attempts from this address (the sign-in limit per IP address, over the same window). */
export async function tokenThrottled(ip: string) {
  const r = await owner.one<{ n: number }>(
    `select count(*)::int as n from meta.activity_log
      where app_id is null and event = 'login_failed' and ip = $1 and at > now() - make_interval(mins => $2)`,
    [ip, loginWindowMinutes()],
  );
  return (r?.n ?? 0) >= loginMaxFailuresPerIp();
}

/**
 * Check a request's bearer token. Unknown, expired and revoked tokens are 401 (and count as failed sign-ins of the
 * address); a token whose developer may no longer use the workspace is 403. The last use is recorded.
 */
export async function checkToken(header: unknown, ip: string): Promise<TokenCheck> {
  if (await tokenThrottled(ip)) return { ok: false, status: 429, error: 'Too many failed attempts from this address: try again later.' };
  const token = bearerOf(header);
  if (!token) return { ok: false, status: 401, error: 'Send a builder token: Authorization: Bearer pgkb_…', log: header ? 'malformed Authorization header' : '' };
  if (!TOKEN_RE.test(token)) return { ok: false, status: 401, error: 'This is not a builder token.', log: 'not a builder token' };
  const t = await owner.one<{ id: number; name: string; username: string; workspace_id: number; workspace: string; scopes: TokenScope[]; expires_at: string; expired: boolean; revoked: boolean; is_admin: boolean; member: boolean }>(
    `select t.id::int as id, t.name, t.username, t.workspace_id, w.name as workspace, t.scopes, t.expires_at::text,
            t.expires_at <= now() as expired, t.revoked_at is not null as revoked, d.is_admin,
            exists (select 1 from meta.workspace_member m where m.workspace_id = t.workspace_id and m.username = t.username) as member
       from meta.builder_token t join meta.developer d on d.username = t.username join meta.workspace w on w.id = t.workspace_id
      where t.token_hash = $1`,
    [hashToken(token)],
  );
  if (!t) return { ok: false, status: 401, error: 'Unknown builder token.', log: 'unknown builder token' };
  if (t.revoked) return { ok: false, status: 401, error: 'This builder token was revoked.', log: `revoked builder token ${t.name} of ${t.username}` };
  if (t.expired) return { ok: false, status: 401, error: 'This builder token has expired.', log: `expired builder token ${t.name} of ${t.username}` };
  // checked now, not when the token was made
  if (!t.member && !t.is_admin) return { ok: false, status: 403, error: `${t.username} is no longer a developer of workspace ${t.workspace}.` };
  if ((await enrolmentDue(t.username, t.is_admin))?.due === 'enrol') return { ok: false, status: 403, error: `${t.username} must set up two-factor sign-in in the builder first.` };
  await owner.query('update meta.builder_token set last_used_at = now(), last_used_ip = $2 where id = $1', [t.id, ip.slice(0, 100)]);
  return { ok: true, caller: { tokenId: t.id, name: t.name, username: t.username, workspaceId: t.workspace_id, workspace: t.workspace, scopes: t.scopes, expiresAt: t.expires_at, admin: t.is_admin } };
}
