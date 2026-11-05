import pg from 'pg';

// (sprint 150, AP-7 leftover; APEX: REST Enabled SQL, regions on another database) Remote databases: another
// PostgreSQL database's tables as foreign tables (postgres_fdw) in a local schema of their own, which applications
// query like their own tables (as their database role, in their transaction, with the grants given here). See
// migration 145 for the table; Workspace utilities → Remote databases (src/builder/remote-databases.ts) for the page.
//
// Everything runs on the owner connection in the caller's transaction:
//   create (or alter) server pgkiln_rdb_<name> foreign data wrapper postgres_fdw options (host, port, dbname)
//   create (or alter) user mapping for public … options (user, password)   -- the password only lives here
//   create schema <local> (marked as this remote database's by its comment), drop its foreign tables,
//   import foreign schema <remote> [limit to (…)] from server … into <local>
//   revoke from public; grant usage and select (with writable: insert, update, delete) to the chosen app roles
// Names reach SQL quoted (escapeIdentifier) or as literals (escapeLiteral), after the checks below.

export interface RemoteDb {
  id?: number;
  name: string;
  description: string | null;
  host: string;
  port: number;
  dbname: string;
  user_name: string;
  remote_schema: string;
  local_schema: string;
  tables: string[];
  grant_roles: string[];
  writable: boolean;
}

type Q = { query: (sql: string, params?: unknown[]) => Promise<pg.QueryResult<any>> };

const id = pg.escapeIdentifier;
const lit = pg.escapeLiteral;
export const NAME = /^[A-Z][A-Z0-9_]{0,29}$/;
const LOCAL = /^[a-z_][a-z0-9_]{0,62}$/;
// a host name, an IPv4 or an IPv6 address (no spaces, quotes or option syntax)
const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[?[0-9A-Fa-f:.]{2,45}\]?)$/;
// a remote name (database, user, schema, table): any printable text without control characters, at most 63
const REMOTE = /^[^\x00-\x1f\x7f]{1,63}$/;
const RESERVED = /^(pg_.*|information_schema|meta|public|pgkiln.*)$/;
export const MAX_TABLES = 200;

export const serverNameOf = (name: string) => `pgkiln_rdb_${name.toLowerCase()}`;
const marker = (name: string) => `pgkiln remote database ${name}`;

/** What is wrong with a remote database's settings (empty: nothing). `roles`: the roles that may be granted. */
export function remoteDbProblems(x: RemoteDb, roles: string[]): string[] {
  const p: string[] = [];
  if (!NAME.test(x.name)) p.push('The name is an upper case static id (letters, digits, _; at most 30), e.g. CRM.');
  if (!HOST.test(x.host)) p.push('The host is a host name or an IP address.');
  if (!Number.isInteger(x.port) || x.port < 1 || x.port > 65535) p.push('The port is a number from 1 to 65535.');
  if (!REMOTE.test(x.dbname)) p.push('The database is a name of 1 to 63 characters.');
  if (!REMOTE.test(x.user_name)) p.push('The user is a name of 1 to 63 characters.');
  if (!REMOTE.test(x.remote_schema)) p.push('The remote schema is a name of 1 to 63 characters.');
  if (!LOCAL.test(x.local_schema) || RESERVED.test(x.local_schema)) p.push('The local schema is a new lower case name (not public, meta or pg_…), e.g. crm.');
  if (x.tables.length > MAX_TABLES) p.push(`At most ${MAX_TABLES} tables.`);
  for (const t of x.tables) if (!REMOTE.test(t)) p.push(`The table name "${t.slice(0, 70)}" is not a name of 1 to 63 characters.`);
  for (const r of x.grant_roles) if (!roles.includes(r)) p.push(`${r} is not the database role of an application.`);
  if (x.description && x.description.length > 1000) p.push('The description has at most 1000 characters.');
  return p;
}

export interface FdwStatus { installed: boolean; available: boolean; canCreate: boolean }

/** Whether postgres_fdw is installed in this database (and whether the connection could create it). */
export async function fdwStatus(db: Q): Promise<FdwStatus> {
  const r = (await db.query(
    `select exists (select 1 from pg_catalog.pg_extension where extname = 'postgres_fdw') as installed,
            exists (select 1 from pg_catalog.pg_available_extensions where name = 'postgres_fdw') as available,
            (select rolsuper from pg_catalog.pg_roles where rolname = current_user) as superuser`)).rows[0];
  return { installed: r.installed, available: r.available, canCreate: !!r.superuser };
}

/** The database roles of the applications (the roles a remote database's tables may be granted to). */
export async function applicationRoles(db: Q): Promise<string[]> {
  return (await db.query(
    `select distinct a.db_role as r from meta.app a where a.db_role is not null
        and exists (select 1 from pg_catalog.pg_roles x where x.rolname = a.db_role) order by 1`)).rows.map((x) => x.r);
}

/**
 * Make (or change) the server, user mapping and local schema, and import the tables again: the caller's transaction
 * (nothing stays when it fails or is rolled back). `password`: null keeps the mapping's password (it must exist
 * then); `before`: the roles granted until now (their grants go first). Returns the number of foreign tables.
 */
export async function applyRemote(c: Q, x: RemoteDb, password: string | null, before: string[] = []): Promise<number> {
  if (!(await fdwStatus(c)).installed) throw new Error('The postgres_fdw extension is not installed in this database (Workspace utilities → Remote databases).');
  const server = serverNameOf(x.name);
  const exists = (await c.query('select 1 from pg_catalog.pg_foreign_server where srvname = $1', [server])).rowCount;
  const opts: [string, string][] = [['host', x.host], ['port', String(x.port)], ['dbname', x.dbname]];
  if (exists) await c.query(`alter server ${id(server)} options (${opts.map(([k, v]) => `set ${k} ${lit(v)}`).join(', ')})`);
  else await c.query(`create server ${id(server)} foreign data wrapper postgres_fdw options (${opts.map(([k, v]) => `${k} ${lit(v)}`).join(', ')})`);
  const mapped = (await c.query(`select 1 from pg_catalog.pg_user_mappings where srvname = $1 and usename = 'public'`, [server])).rowCount;
  if (!mapped) {
    if (!password) throw new Error('A password is needed the first time (postgres_fdw connects with the remote user and its password).');
    await c.query(`create user mapping for public server ${id(server)} options (user ${lit(x.user_name)}, password ${lit(password)})`);
  } else await c.query(`alter user mapping for public server ${id(server)} options (set user ${lit(x.user_name)}${password ? `, set password ${lit(password)}` : ''})`);

  // the local schema: new, or this remote database's own
  const schema = (await c.query(
    `select pg_catalog.obj_description(n.oid, 'pg_namespace') as comment from pg_catalog.pg_namespace n where n.nspname = $1`, [x.local_schema])).rows[0];
  if (schema && schema.comment !== marker(x.name))
    throw new Error(`Schema ${x.local_schema} exists and is not remote database ${x.name}'s: choose another local schema.`);
  if (!schema) {
    await c.query(`create schema ${id(x.local_schema)}`);
    await c.query(`comment on schema ${id(x.local_schema)} is ${lit(marker(x.name))}`);
  }
  // the foreign tables again: drop the old ones (a view that uses one stops this, and says which)
  const old = (await c.query(
    `select c.relname as t from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relkind = 'f'`, [x.local_schema])).rows;
  for (const o of old) await c.query(`drop foreign table ${id(x.local_schema)}.${id(o.t)}`);
  await c.query(`import foreign schema ${id(x.remote_schema)}${x.tables.length ? ` limit to (${x.tables.map(id).join(', ')})` : ''}
                 from server ${id(server)} into ${id(x.local_schema)}`);
  const count = Number((await c.query(
    `select count(*) as n from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and c.relkind = 'f'`,
    [x.local_schema])).rows[0].n);
  // grants: only the chosen application roles, nobody else
  await c.query(`revoke all on all tables in schema ${id(x.local_schema)} from public`);
  await c.query(`revoke all on schema ${id(x.local_schema)} from public`);
  for (const r of new Set([...before, ...x.grant_roles])) {
    if (!(await c.query('select 1 from pg_catalog.pg_roles where rolname = $1', [r])).rowCount) continue;
    await c.query(`revoke all on all tables in schema ${id(x.local_schema)} from ${id(r)}`);
    await c.query(`revoke all on schema ${id(x.local_schema)} from ${id(r)}`);
  }
  for (const r of x.grant_roles) {
    await c.query(`grant usage on schema ${id(x.local_schema)} to ${id(r)}`);
    await c.query(`grant ${x.writable ? 'select, insert, update, delete' : 'select'} on all tables in schema ${id(x.local_schema)} to ${id(r)}`);
  }
  return count;
}

/** Drop the local schema (when it is this remote database's) and the server with its user mapping. */
export async function dropRemote(c: Q, x: Pick<RemoteDb, 'name' | 'local_schema'>) {
  const schema = (await c.query(
    `select pg_catalog.obj_description(n.oid, 'pg_namespace') as comment from pg_catalog.pg_namespace n where n.nspname = $1`, [x.local_schema])).rows[0];
  if (schema && schema.comment === marker(x.name)) await c.query(`drop schema ${id(x.local_schema)} cascade`);
  await c.query(`drop server if exists ${id(serverNameOf(x.name))} cascade`);
}

/** postgres_fdw keeps connections per session: drop this connection's, so the next query uses new settings. */
export async function disconnect(c: Q) {
  await c.query(`select postgres_fdw_disconnect_all()`).catch(() => undefined);
}
