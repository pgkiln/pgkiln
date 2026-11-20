// Custom authentication (APEX: Custom authentication scheme). The app's own
// PL/pgSQL decides whether a user name and password are valid: either a
// function body with the parameters p_username and p_password returning
// boolean, or a named function (p_username text, p_password text) returns
// boolean. It runs as the app's database role, in a transaction that is
// rolled back unless the check and the optional post-authentication code
// succeed. The password is only ever a query parameter: it is never part of
// the SQL text, never stored and never logged (errors are logged by their
// SQLSTATE only, since a message could repeat the password).

import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { appTx, type Client } from './db.ts';
import type { App } from './metadata.ts';

type CustomAuthApp = Pick<App, 'id' | 'alias' | 'db_role' | 'custom_auth_function' | 'custom_auth_code' | 'custom_auth_post_code'>;

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
export const customAuthConfigured = (a: Pick<App, 'custom_auth_function' | 'custom_auth_code'>) =>
  !!(a.custom_auth_function?.trim() || a.custom_auth_code?.trim());

/** Check a user name and password with the app's custom function; the result never contains the password. */
export async function customAuthenticate(a: CustomAuthApp, username: string, password: string): Promise<CustomAuthResult> {
  if (!customAuthConfigured(a)) return { ok: false, reason: 'denied', detail: 'no check configured' };
  if (!username || !password || password.includes('\0')) return { ok: false, reason: 'invalid', detail: 'no user name or password' };
  try {
    return await appTx({ appId: a.id, alias: a.alias, dbRole: a.db_role, appUser: 'nobody', sessionId: '' }, async (c) => {
      let ok: unknown;
      try {
        if (a.custom_auth_function?.trim()) {
          const name = a.custom_auth_function.trim();
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
