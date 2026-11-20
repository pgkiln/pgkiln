// Custom authentication (APEX: Custom authentication scheme). The app's own
// PL/pgSQL decides whether a user name and password are valid: either a
// function body with the parameters p_username and p_password returning
// boolean, or a named function (p_username text, p_password text) returns
// boolean. It runs as the app's database role, in a transaction that is
// rolled back unless the check and the optional post-authentication code
// succeed. The password is only ever a query parameter: it is never part of
// the SQL text, never stored and never logged (errors are logged by their
// SQLSTATE only, since a message could repeat the password).
// (sprint 248, MG-21) Or a hash query: SQL with p_username returning the stored
// password hash (Django, bcrypt), checked by the server (src/password-hashes.ts).

import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { appTx, runtime, type Client } from './db.ts';
import type { App } from './metadata.ts';
import { DEFAULT_SHAPE, dummyCheck, verifyPasswordHash, type HashShape } from './password-hashes.ts';

type CustomAuthApp = Pick<App, 'id' | 'alias' | 'db_role' | 'custom_auth_function' | 'custom_auth_code' | 'custom_auth_post_code' | 'custom_auth_hash_query'>;

/** `typed`: what the user typed, when post-authentication named the user otherwise (meta.set_auth_user, sprint 241) */
export type CustomAuthResult = { ok: true; username: string; typed?: string } | { ok: false; reason: 'invalid' | 'denied'; detail: string };

/** btrim(): spaces only (String.trim would also drop the formatting characters checked below) */
const trimSpaces = (s: string) => s.replace(/^ +| +$/g, '');

const NOBODY = 'nobody is the name of a user who is not signed in';

/**
 * (sprint 241, MG-15) Why a user name can't be a session's user (null: it can): as meta.auth_user_problem in
 * migration 197. Empty, longer than 100 characters, a control, line-separator, zero-width or bidirectional
 * formatting character (which would make one name look like another in the activity log), or "nobody".
 */
export function authUserProblem(name: string): string | null {
  const v = trimSpaces(name);
  if (!v) return 'the user name is empty';
  if ([...v].length > 100) return 'the user name is longer than 100 characters';
  if (/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/.test(v)) return 'the user name contains a control or formatting character';
  if (v.toLowerCase() === 'nobody') return NOBODY;
  return null;
}

/** A function name as stored (lower case, optionally schema-qualified), quoted for SQL. */
export const FUNCTION_NAME = /^[a-z_][a-z0-9_$]{0,62}(\.[a-z_][a-z0-9_$]{0,62})?$/;
export const quotedFunction = (name: string) => name.split('.').map((p) => pg.escapeIdentifier(p)).join('.');

/** A PL/pgSQL body ("return …;" or a block) as a temporary function of this transaction; returns its name. */
async function tempFunction(c: Client, body: string, params: string, returns: string) {
  const code = body.trim();
  const block = /^(declare|begin)\b/i.test(code) ? code : `begin\n${code}\nend`;
  const id = randomBytes(8).toString('hex');
  const tag = `$pgkiln_${id}$`;
  if (block.includes(tag)) throw new Error('The code contains the generated quote tag.');
  const fn = `pg_temp.pgkiln_auth_${id}`;
  await c.query(`create function ${fn}(${params}) returns ${returns} language plpgsql as ${tag}\n${block}\n${tag}`);
  return fn;
}

const code = (e: unknown) => (e as { code?: string }).code ?? 'no code';

/** Undo the transaction without turning the refusal into an error. */
class Refused extends Error {
  constructor(readonly result: CustomAuthResult & { ok: false }) {
    super(result.detail);
  }
}

/** Is the custom check configured at all? */
export const customAuthConfigured = (a: Pick<App, 'custom_auth_function' | 'custom_auth_code' | 'custom_auth_hash_query'>) =>
  !!(a.custom_auth_function?.trim() || a.custom_auth_code?.trim() || a.custom_auth_hash_query?.trim());

/** Which check signs users in: the function, else the body, else the hash query (sprint 248). */
export const customAuthKind = (a: Pick<App, 'custom_auth_function' | 'custom_auth_code' | 'custom_auth_hash_query'>) =>
  a.custom_auth_function?.trim() ? 'function' : a.custom_auth_code?.trim() ? 'body' : a.custom_auth_hash_query?.trim() ? 'hash_query' : null;

/** (sprint 248) Per application, the kind and cost of its last real hash: what a dummy check of an unknown user costs. */
const lastShape = new Map<number, HashShape>();

/** bcrypt by pgcrypto, on the runtime connection: the password is a parameter, the result only compared. */
const pgcryptoBcrypt = async (password: string, hash: string) =>
  (await runtime.one<{ h: string | null }>('select public.crypt($1::text, $2::text) as h', [password, hash]))?.h ?? '';

/**
 * (sprint 248, MG-21) The hash query: the stored hash of the user (as the app's role, read in a transaction of its own),
 * then checked here, outside the transaction. A user with no hash, a query that fails or returns several rows and a
 * hash that can't be read get a dummy check of the same cost: every refusal looks and takes the same.
 */
async function hashQueryCheck(a: CustomAuthApp, username: string, password: string): Promise<{ ok: true } | { ok: false; detail: string }> {
  const fallback = lastShape.get(a.id) ?? DEFAULT_SHAPE;
  const refuse = async (detail: string) => {
    await dummyCheck(password, fallback, pgcryptoBcrypt);
    return { ok: false, detail } as const;
  };
  let rows: { h: unknown }[];
  try {
    rows = await appTx({ appId: a.id, alias: a.alias, dbRole: a.db_role, appUser: 'nobody', sessionId: '' }, async (c) => {
      const fn = await tempSqlFunction(c, a.custom_auth_hash_query!);
      return (await c.query(`select h from ${fn}($1) as h limit 2`, [username])).rows;
    });
  } catch (e) {
    return refuse(`hash query failed (${code(e)})`);
  }
  if (rows.length > 1) return refuse('the hash query returned more than one row');
  const stored = rows[0]?.h;
  if (typeof stored !== 'string' || !stored.trim()) return refuse('unknown user (no hash)');
  let r;
  try {
    r = await verifyPasswordHash(stored, password, pgcryptoBcrypt, fallback);
  } catch (e) {
    return { ok: false, detail: `hash check failed (${code(e)})` };
  }
  if (r.shape) lastShape.set(a.id, r.shape);
  return r.ok ? { ok: true } : { ok: false, detail: `hash query: ${r.reason}` };
}

/** A query with p_username as a temporary SQL function of this transaction returning setof text; returns its name. */
async function tempSqlFunction(c: Client, query: string) {
  const sql = query.trim().replace(/;\s*$/, '');
  const id = randomBytes(8).toString('hex');
  const tag = `$pgkiln_${id}$`;
  if (sql.includes(tag)) throw new Error('The query contains the generated quote tag.');
  const fn = `pg_temp.pgkiln_hash_${id}`;
  await c.query(`create function ${fn}(p_username text) returns setof text language sql stable as ${tag}\n${sql}\n${tag}`);
  return fn;
}

/** Check a user name and password with the app's custom function; the result never contains the password. */
export async function customAuthenticate(a: CustomAuthApp, username: string, password: string): Promise<CustomAuthResult> {
  if (!customAuthConfigured(a)) return { ok: false, reason: 'denied', detail: 'no check configured' };
  if (!username || !password || password.includes('\0')) return { ok: false, reason: 'invalid', detail: 'no user name or password' };
  const kind = customAuthKind(a);
  if (kind === 'hash_query') {
    const h = await hashQueryCheck(a, username, password);
    if (!h.ok) return { ok: false, reason: 'invalid', detail: h.detail };
  }
  try {
    return await appTx({ appId: a.id, alias: a.alias, dbRole: a.db_role, appUser: 'nobody', sessionId: '' }, async (c) => {
      let ok: unknown;
      try {
        if (kind === 'hash_query') {
          ok = true; // checked above, outside this transaction
        } else if (kind === 'function') {
          const name = a.custom_auth_function!.trim();
          if (!FUNCTION_NAME.test(name)) throw Object.assign(new Error('bad function name'), { code: 'name' });
          ok = (await c.query(`select ${quotedFunction(name)}($1::text, $2::text)::boolean as ok`, [username, password])).rows[0]?.ok;
        } else {
          const fn = await tempFunction(c, a.custom_auth_code!, 'p_username text, p_password text', 'boolean');
          ok = (await c.query(`select ${fn}($1, $2) as ok`, [username, password])).rows[0]?.ok;
          await c.query(`drop function ${fn}(text, text)`);
        }
      } catch (e) {
        throw new Refused({ ok: false, reason: 'invalid', detail: `check failed (${code(e)})` });
      }
      if (ok !== true) throw new Refused({ ok: false, reason: 'invalid', detail: 'check returned false' });
      let name = username;
      if (a.custom_auth_post_code?.trim()) {
        let set: string | null;
        try {
          // (sprint 241, MG-15) meta.set_auth_user works only now: the phase is set, and the name it records is read
          // right after this code, in this transaction (anything set before, e.g. by the check, is cleared first)
          await c.query(`select set_config('pgkiln.app_user', $1, true), set_config('pgkiln.auth_user', '', true), set_config('pgkiln.auth_phase', 'post_authentication', true)`, [username]);
          const fn = await tempFunction(c, a.custom_auth_post_code, 'p_username text', 'void');
          await c.query(`select ${fn}($1)`, [username]);
          await c.query(`drop function ${fn}(text)`);
          set = (await c.query(`select current_setting('pgkiln.auth_user', true) as name, set_config('pgkiln.auth_phase', '', true)`)).rows[0]?.name || null;
        } catch (e) {
          throw new Refused({ ok: false, reason: 'denied', detail: `post-authentication failed (${code(e)})` });
        }
        if (set !== null) {
          // checked again here: the setting may have been written with set_config instead of meta.set_auth_user
          const problem = authUserProblem(set);
          if (problem) throw new Refused({ ok: false, reason: 'denied', detail: `post-authentication set no valid user name (${problem})` });
          name = trimSpaces(set);
        }
      }
      // "nobody" is the user who isn't signed in: never a session's user
      if (authUserProblem(name) === NOBODY) throw new Refused({ ok: false, reason: 'denied', detail: 'the user name nobody is reserved' });
      return { ok: true, username: name, ...(name !== username ? { typed: username } : {}) } as const;
    });
  } catch (e) {
    if (e instanceof Refused) return e.result;
    return { ok: false, reason: 'invalid', detail: `check failed (${code(e)})` };
  }
}
