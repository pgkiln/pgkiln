// Database-account authentication (APEX: Database Accounts). The user signs
// in with a PostgreSQL login role and its password. pgkiln never reads
// pg_authid: it opens a short-lived connection as that role to its own
// database (host, port and database of DATABASE_URL) and closes it again, so
// PostgreSQL itself checks the password (and pg_hba.conf, VALID UNTIL,
// CONNECTION LIMIT, NOLOGIN). Only the roles listed for the app, or members
// of the app's membership role, may sign in; superusers and pgkiln's own
// connection roles never. The password is only ever passed to that one
// connection attempt: it is not stored and never logged.

import pg from 'pg';
import { ownerUrl } from './db.ts';
import type { App } from './metadata.ts';

/** How long a sign-in connection attempt may take. */
const CONNECT_TIMEOUT_MS = 5000;
/** A role name: 1 to 63 bytes (PostgreSQL's limit), no control characters. */
const roleNameOk = (s: string) => s.length > 0 && Buffer.byteLength(s) <= 63 && !/[\x00-\x1f\x7f]/.test(s);

export const parseRoleList = (text: string | undefined) =>
  [...new Set((text ?? '').split(/[,\n]/).map((r) => r.trim()).filter(roleNameOk))].slice(0, 200);
export const validRoleName = (s: string | undefined) => (s && roleNameOk(s.trim()) ? s.trim() : null);

/** pgkiln's own login roles (owner and runtime connections): never a sign-in. */
function serviceRoles() {
  const names = new Set<string>();
  for (const url of [ownerUrl, process.env.RUNTIME_DATABASE_URL]) {
    try {
      if (url) names.add(decodeURIComponent(new URL(url).username));
    } catch {
      // not a URL: nothing to add
    }
  }
  return names;
}

type DbAuthApp = Pick<App, 'db_auth_roles' | 'db_auth_member_of'>;

/** Before connecting: the name is a valid role name, may sign in to the app by the list, and is no service role. */
export function dbRoleListed(a: DbAuthApp, role: string) {
  if (!roleNameOk(role) || serviceRoles().has(role)) return false;
  if (a.db_auth_roles?.length && a.db_auth_roles.includes(role)) return true;
  // with a membership role, membership is checked once connected
  return !!a.db_auth_member_of;
}

export type DbAuthResult = { ok: true; role: string } | { ok: false; reason: 'invalid' | 'unavailable' | 'denied'; detail: string };

/** Check a role's password by connecting as it, and its membership; the result never contains the password. */
export async function dbAuthenticate(a: DbAuthApp, role: string, password: string): Promise<DbAuthResult> {
  if (!dbRoleListed(a, role)) return { ok: false, reason: 'denied', detail: 'role not allowed' };
  if (!password || password.includes('\0')) return { ok: false, reason: 'invalid', detail: 'no password' };
  const url = new URL(ownerUrl);
  url.username = encodeURIComponent(role);
  url.password = encodeURIComponent(password);
  const client = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: CONNECT_TIMEOUT_MS, application_name: 'pgapex-sign-in', statement_timeout: CONNECT_TIMEOUT_MS });
  client.on('error', () => {});
  try {
    try {
      await client.connect();
    } catch (e) {
      const err = e as { code?: string; severity?: string };
      // a PostgreSQL answer (wrong password, no such role, NOLOGIN, expired, pg_hba): invalid;
      // too many connections, shutting down, or no answer at all: unavailable
      const server = typeof err.severity === 'string';
      const busy = server && /^(53|57|08)/.test(err.code ?? '');
      return { ok: false, reason: server && !busy ? 'invalid' : 'unavailable', detail: `connection refused (${err.code ?? 'no code'})` };
    }
    const row = (
      await client.query<{ role: string; super: boolean; member: boolean }>(
        `select current_user::text as role, r.rolsuper as super,
                exists (select 1 from pg_roles m where m.rolname = $1 and pg_has_role(current_user, m.oid, 'MEMBER')) as member
           from pg_roles r where r.rolname = current_user`,
        [a.db_auth_member_of ?? null],
      )
    ).rows[0];
    if (!row) return { ok: false, reason: 'denied', detail: 'no role' };
    if (row.super) return { ok: false, reason: 'denied', detail: 'superuser refused' };
    if (serviceRoles().has(row.role)) return { ok: false, reason: 'denied', detail: 'service role refused' };
    const listed = !!a.db_auth_roles?.includes(row.role);
    if (!listed && !(a.db_auth_member_of && row.member)) return { ok: false, reason: 'denied', detail: 'not a member' };
    return { ok: true, role: row.role };
  } catch (e) {
    return { ok: false, reason: 'unavailable', detail: `check failed (${(e as { code?: string }).code ?? 'no code'})` };
  } finally {
    await client.end().catch(() => {});
  }
}
