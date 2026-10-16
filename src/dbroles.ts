import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import pg from 'pg';

// (sprint 99, Database Actions DA-13) Database Users: the SQL that creates, changes and drops a PostgreSQL role,
// from what the form says and what the catalog says now. Pure functions: src/builder/db-users.ts reads the
// catalog and runs the statements; test/db-users.test.ts tests them.
//
// Passwords: the server never sends a password to PostgreSQL. scramVerifier() hashes it here (SCRAM-SHA-256,
// like psql's \password and libpq's PQencryptPasswordConn), and the statement carries the verifier as a literal
// (pg's escapeLiteral). Statements are built with PASSWORD_SLOT in its place: maskSql() shows them with
// '********' (the review, the activity log), withVerifier() fills in the verifier only for running them.

const ident = pg.escapeIdentifier;
const literal = pg.escapeLiteral;

/** Where the password goes in a generated statement (never shown: see maskSql / withVerifier). */
export const PASSWORD_SLOT = '\u0000password\u0000';
export const MASK = `'********'`;

export type DefaultPriv = 'none' | 'read' | 'write' | 'custom';
export type ExistingPriv = '' | 'read' | 'write' | 'revoke';

export interface SchemaGrant {
  schema: string;
  usage: boolean;
  create: boolean;
  /** privileges on tables (and sequences) the creator makes in the schema from now on */
  defaults: DefaultPriv;
  /** a one-off grant on the tables there now ('' = no change) */
  existing?: ExistingPriv;
}

export interface RoleSpec {
  name: string;
  login: boolean;
  /** keep the password, set a new one, or remove it (an existing role); none / set for a new one */
  password: 'keep' | 'set' | 'remove';
  /** YYYY-MM-DD, '' = no expiry */
  validUntil: string;
  /** -1 = no limit */
  connLimit: number;
  memberOf: string[];
  /** the search path in this database, comma separated ('' = the server's default) */
  searchPath: string;
  comment: string;
  schemas: SchemaGrant[];
}

export interface RoleContext {
  /** the current database (ALTER ROLE … IN DATABASE) */
  database: string;
  /** the role whose new objects the default privileges cover (pgkiln's owner connection) */
  creator: string;
}

export const emptyRole = (name = ''): RoleSpec => ({ name, login: false, password: 'keep', validUntil: '', connLimit: -1, memberOf: [], searchPath: '', comment: '', schemas: [] });

/** A name for a new role: PostgreSQL reserves pg_, pgkiln reserves pgkiln. */
export const ROLE_NAME = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
export const reservedName = (name: string) => /^pg_/i.test(name) || /^pgkiln/i.test(name);

/** The schemas of a search path ($user stays $user), or null when one isn't a plain name. */
export function parseSearchPath(text: string): string[] | null {
  const parts = text.split(',').map((p) => p.trim()).filter(Boolean).map((p) => (/^".*"$/.test(p) ? p.slice(1, -1).replace(/""/g, '"') : p));
  return parts.every((p) => p === '$user' || /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(p)) ? parts : null;
}

const validDate = (d: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
};

export interface CheckOptions {
  isNew: boolean;
  /** roles a role may be made a member of (existing memberships may stay) */
  grantable: string[];
  /** schemas whose privileges the form may change */
  schemas: string[];
  before: RoleSpec | null;
}

/** What is wrong with a spec (empty: fine). */
export function checkRole(spec: RoleSpec, o: CheckOptions): string[] {
  const errors: string[] = [];
  if (o.isNew) {
    if (!ROLE_NAME.test(spec.name)) errors.push('The name starts with a letter or _ and has only letters, digits, _ and $ (at most 63).');
    else if (reservedName(spec.name)) errors.push('Names starting with pg_ or pgkiln are reserved (PostgreSQL, pgkiln).');
  }
  if (spec.validUntil && !validDate(spec.validUntil)) errors.push('Valid until is a date (YYYY-MM-DD).');
  if (!Number.isInteger(spec.connLimit) || spec.connLimit < -1 || spec.connLimit > 100000) errors.push('The connection limit is a whole number from -1 (no limit) to 100000.');
  if (spec.searchPath && !parseSearchPath(spec.searchPath)) errors.push('The search path is a comma-separated list of schema names ($user for the role\'s own).');
  if (spec.comment.length > 1000) errors.push('The comment has at most 1000 characters.');
  const kept = new Set(o.before?.memberOf ?? []);
  for (const m of spec.memberOf) {
    if (m === spec.name) errors.push('A role is not a member of itself.');
    else if (!kept.has(m) && !o.grantable.includes(m)) errors.push(`The role ${m} can't be granted here (pgkiln's own roles, superusers and login roles can't).`);
  }
  for (const s of spec.schemas) {
    if (!o.schemas.includes(s.schema)) errors.push(`Privileges on the schema ${s.schema} aren't changed here.`);
    if (!['none', 'read', 'write', 'custom'].includes(s.defaults)) errors.push(`Unknown default privileges for ${s.schema}.`);
    if (s.existing && !['read', 'write', 'revoke'].includes(s.existing)) errors.push(`Unknown privileges on the tables of ${s.schema}.`);
  }
  if (o.isNew && spec.password === 'remove') errors.push('A new role has no password to remove.');
  return errors;
}

/** What is wrong with a new password and its confirmation (empty: fine). */
export function checkPassword(password: string, confirm: string): string[] {
  if (password.length < 8) return ['The password has at least 8 characters.'];
  if (password.length > 1024) return ['The password has at most 1024 characters.'];
  if (password.includes('\0')) return ['The password can\'t contain a NUL character.'];
  if (password !== confirm) return ['The password and its confirmation differ.'];
  return [];
}

const privs: Record<Exclude<DefaultPriv, 'custom' | 'none'>, string> = { read: 'SELECT', write: 'SELECT, INSERT, UPDATE, DELETE' };

/**
 * The statements that make `before` (the catalog; null for a new role) into `after`, the password as
 * PASSWORD_SLOT. Nothing that is already so is repeated.
 */
export function roleSql(before: RoleSpec | null, after: RoleSpec, ctx: RoleContext): string[] {
  const out: string[] = [];
  const r = ident(after.name);
  const b = before ?? emptyRole(after.name);
  const opts: string[] = [];
  if (!before || before.login !== after.login) opts.push(after.login ? 'LOGIN' : 'NOLOGIN');
  if (after.password === 'set') opts.push(`PASSWORD ${PASSWORD_SLOT}`);
  else if (after.password === 'remove' && before) opts.push('PASSWORD NULL');
  if (b.validUntil !== after.validUntil) opts.push(`VALID UNTIL ${literal(after.validUntil || 'infinity')}`);
  if (b.connLimit !== after.connLimit) opts.push(`CONNECTION LIMIT ${after.connLimit}`);
  if (!before) out.push(`CREATE ROLE ${r}${opts.length ? ` ${opts.join(' ')}` : ''};`);
  else if (opts.length) out.push(`ALTER ROLE ${r} ${opts.join(' ')};`);

  for (const g of after.memberOf.filter((m) => !b.memberOf.includes(m))) out.push(`GRANT ${ident(g)} TO ${r};`);
  for (const g of b.memberOf.filter((m) => !after.memberOf.includes(m))) out.push(`REVOKE ${ident(g)} FROM ${r};`);

  const path = (t: string) => (parseSearchPath(t) ?? []).join(',');
  if (path(b.searchPath) !== path(after.searchPath)) {
    const p = parseSearchPath(after.searchPath) ?? [];
    out.push(p.length ? `ALTER ROLE ${r} IN DATABASE ${ident(ctx.database)} SET search_path TO ${p.map(ident).join(', ')};`
      : `ALTER ROLE ${r} IN DATABASE ${ident(ctx.database)} RESET search_path;`);
  }

  for (const s of after.schemas) {
    const was = b.schemas.find((x) => x.schema === s.schema) ?? { schema: s.schema, usage: false, create: false, defaults: 'none' as DefaultPriv };
    const n = ident(s.schema);
    const grant = [s.usage && !was.usage ? 'USAGE' : '', s.create && !was.create ? 'CREATE' : ''].filter(Boolean);
    const revoke = [!s.usage && was.usage ? 'USAGE' : '', !s.create && was.create ? 'CREATE' : ''].filter(Boolean);
    if (grant.length) out.push(`GRANT ${grant.join(', ')} ON SCHEMA ${n} TO ${r};`);
    if (revoke.length) out.push(`REVOKE ${revoke.join(', ')} ON SCHEMA ${n} FROM ${r};`);
    if (s.defaults !== 'custom' && s.defaults !== was.defaults) {
      const adp = `ALTER DEFAULT PRIVILEGES FOR ROLE ${ident(ctx.creator)} IN SCHEMA ${n}`;
      if (was.defaults !== 'none') out.push(`${adp} REVOKE ALL ON TABLES FROM ${r};`, `${adp} REVOKE ALL ON SEQUENCES FROM ${r};`);
      if (s.defaults !== 'none') out.push(`${adp} GRANT ${privs[s.defaults]} ON TABLES TO ${r};`);
      if (s.defaults === 'write') out.push(`${adp} GRANT USAGE, SELECT ON SEQUENCES TO ${r};`);
    }
    if (s.existing === 'revoke') out.push(`REVOKE ALL ON ALL TABLES IN SCHEMA ${n} FROM ${r};`, `REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${n} FROM ${r};`);
    else if (s.existing === 'read' || s.existing === 'write') {
      out.push(`GRANT ${privs[s.existing]} ON ALL TABLES IN SCHEMA ${n} TO ${r};`);
      if (s.existing === 'write') out.push(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${n} TO ${r};`);
    }
  }

  if (b.comment !== after.comment) out.push(`COMMENT ON ROLE ${r} IS ${after.comment ? literal(after.comment) : 'NULL'};`);
  return out;
}

/**
 * The statements that drop a role: its objects reassigned to another role (or, without one, dropped with it),
 * its privileges and default privileges in this database revoked (DROP OWNED), then the role.
 */
export function dropSql(name: string, reassignTo: string | null): string[] {
  const r = ident(name);
  return [...(reassignTo ? [`REASSIGN OWNED BY ${r} TO ${ident(reassignTo)};`] : []), `DROP OWNED BY ${r};`, `DROP ROLE ${r};`];
}

/** The statements as the review and the activity log show them: the password masked. */
export const maskSql = (stmts: string[]) => stmts.map((s) => s.split(PASSWORD_SLOT).join(MASK)).join('\n');

/** The statements to run: the password slot filled with the SCRAM verifier (never shown or logged). */
export const withVerifier = (stmts: string[], verifier: string | null) =>
  stmts.map((s) => {
    if (!s.includes(PASSWORD_SLOT)) return s;
    if (!verifier) throw new Error('A password is needed.');
    return s.split(PASSWORD_SLOT).join(literal(verifier));
  });

/** A digest of the reviewed (masked) statements: Apply runs only what the review showed. */
export const reviewDigest = (stmts: string[]) => createHash('sha256').update(maskSql(stmts)).digest('base64url');

// ------------------------------------------------------------------ SCRAM-SHA-256

// RFC 4013 SASLprep, as PostgreSQL applies it (src/common/saslprep.c): non-ASCII spaces become spaces,
// characters "mapped to nothing" go, NFKC; a password it can't prepare (control characters) is used as it is.
const NON_ASCII_SPACE = /[   -   　]/g;
const TO_NOTHING = /[­͏᠆᠋-᠍​-‍⁠︀-️﻿]/g;
export function saslprep(password: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(password)) return password;
  const prepared = password.replace(NON_ASCII_SPACE, ' ').replace(TO_NOTHING, '').normalize('NFKC');
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001F\u007F-\u009F]/.test(prepared) || !prepared ? password : prepared;
}

/** A SCRAM-SHA-256 verifier for ALTER ROLE … PASSWORD (PostgreSQL stores a verifier as it is). */
export function scramVerifier(password: string, salt: Buffer = randomBytes(16), iterations = 4096): string {
  const salted = pbkdf2Sync(Buffer.from(saslprep(password), 'utf8'), salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}
