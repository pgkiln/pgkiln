// (sprint 186, NX-S2) Every application runs as a database role of its own (APEX: its parsing schema).
//
// meta.app refuses an empty or powerful db_role when an application is made or its role is set (migration 167,
// meta.role_is_powerful: a superuser, BYPASSRLS, CREATEROLE/CREATEDB/REPLICATION, pgkiln's or PostgreSQL's own roles,
// a member of one of those or of the owner of pgkiln's schemas). This module is the other half:
//
//   - setAppRole(): every transaction that runs an application's SQL (appTx, automations, workflows, REST
//     handlers, ...) sets the role here. A powerful role is always refused. An application without a role (made
//     before migration 167) runs only in development mode: a page request of a developer of the application with
//     a builder session in the same browser (the developer toolbar, src/runtime/devbar.ts), as the runtime login,
//     and only when that login is not powerful itself. Everything else (end users, REST, background work) is
//     refused with AppRoleRefused, which the server shows as a clear page (src/app.ts, runtime/routes.ts).
//   - roleProblem(): the same rules for the forms that save a role (settings, import), with a message first.
//   - makeAppRole() / importRole(): app_<alias>, with rights on a schema, for Settings → Security and for an
//     import of a file without a role (never the owner or the runtime login instead).
import pg from 'pg';

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export type RoleProblem = 'missing' | 'powerful';

export class AppRoleRefused extends Error {
  readonly code = 'PGKILN_APP_ROLE';
  constructor(readonly problem: RoleProblem, readonly app: string | null, readonly role: string | null) {
    const name = app ? `Application ${app}` : 'The application';
    super(problem === 'missing'
      ? `${name} has no database role of its own, so it runs only for its developers from the builder: give it one in Settings → Security.`
      : `${name} can't run as ${role}: a superuser, a role that bypasses row level security, creates roles or owns pgkiln's schemas (or a member of one) is refused. Give it a role of its own in Settings → Security.`);
  }
}

const TTL_MS = Number(process.env.PGKILN_WORKSPACE_CACHE_MS ?? 5000);
const powerfulCache = new Map<string, { at: number; powerful: boolean }>();

/** Is role one no application may run as (meta.role_is_powerful, cached a few seconds)? */
export async function rolePowerful(db: Queryable, role: string): Promise<boolean> {
  const hit = powerfulCache.get(role);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.powerful;
  const powerful = !!(await db.query('select meta.role_is_powerful($1) as p', [role])).rows[0]?.p;
  if (powerfulCache.size > 1000) powerfulCache.clear();
  powerfulCache.set(role, { at: Date.now(), powerful });
  return powerful;
}

/** Forget what was checked (tests, and after this process changed a role). */
export const rolesChanged = () => powerfulCache.clear();

/** Why role can't be an application's database role, or null. */
export async function roleProblem(db: Queryable, role: string | null | undefined): Promise<RoleProblem | null> {
  const r = role?.trim();
  if (!r) return 'missing';
  return (await rolePowerful(db, r)) ? 'powerful' : null;
}

/** Null when the application may run now; developer: a page request in development mode (see above). */
export async function runRefusal(db: Queryable, role: string | null | undefined, developer: boolean): Promise<RoleProblem | null> {
  const p = await roleProblem(db, role);
  return p === 'missing' && developer ? null : p;
}

/**
 * Inside an application's transaction: SET LOCAL ROLE to its role, or refuse (AppRoleRefused). Without a role,
 * in development mode only, the transaction stays on the runtime login, unless that login bypasses row level
 * security or owns pgkiln (a RUNTIME_DATABASE_URL that is the owner's).
 */
export async function setAppRole(c: Queryable, role: string | null | undefined, opts: { developer?: boolean; app?: string | null } = {}) {
  const p = await roleProblem(c, role);
  if (p === 'powerful' || (p === 'missing' && !opts.developer)) throw new AppRoleRefused(p, opts.app ?? null, role ?? null);
  if (p === 'missing') {
    const bad = (await c.query(
      `select r.rolsuper or r.rolbypassrls or pg_has_role(current_user, n.nspowner, 'MEMBER') as bad
         from pg_roles r, pg_namespace n where r.rolname = current_user and n.nspname = 'meta'`)).rows[0]?.bad;
    if (bad !== false) throw new AppRoleRefused('missing', opts.app ?? null, null);
    return;
  }
  await c.query(`set local role ${pg.escapeIdentifier(role!.trim())}`);
}

/** The role pgkiln makes for an application: app_<alias> (as the Create Application wizard does). */
export const appRoleName = (alias: string) => `app_${alias.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`.slice(0, 63);

/** The rights the Create Application wizard gives an application's role on its schema (src/builder/newapp.ts). */
export async function grantSchema(c: Queryable, schema: string, role: string) {
  const S = pg.escapeIdentifier(schema);
  const R = pg.escapeIdentifier(role);
  await c.query(`grant usage on schema ${S} to ${R}`);
  await c.query(`grant select, insert, update, delete on all tables in schema ${S} to ${R}`);
  await c.query(`grant usage, select on all sequences in schema ${S} to ${R}`);
  await c.query(`grant execute on all functions in schema ${S} to ${R}`);
  await c.query(`alter default privileges in schema ${S} grant select, insert, update, delete on tables to ${R}`);
  await c.query(`alter default privileges in schema ${S} grant usage, select on sequences to ${R}`);
  await c.query(`alter default privileges in schema ${S} grant execute on functions to ${R}`);
}

/** pgkiln's and the system's schemas never become an application's parsing schema. */
export const reservedSchema = (schema: string) => /^pg_/i.test(schema) || /^pgkiln/i.test(schema) || ['meta', 'information_schema'].includes(schema.toLowerCase());

export class AppRoleError extends Error {}

/**
 * Make (or reuse) app_<alias> for an application of workspace ws, with the wizard's rights on schema (when given and
 * it exists): a new role that can't sign in; an existing one only when it isn't powerful and no other application
 * uses it. Shared workspace: pgkiln_runtime becomes a member (as for every shared application's role); isolated:
 * it becomes one of the workspace's roles, and only the workspace's own schemas are granted. Inside the caller's
 * owner transaction. Returns the role and whether it was created.
 */
export async function makeAppRole(c: Queryable, o: { alias: string; ws: number; schema?: string | null; appId?: number | null }) {
  const role = appRoleName(o.alias);
  const exists = !!(await c.query('select 1 from pg_roles where rolname = $1', [role])).rowCount;
  if (exists) {
    if ((await c.query('select meta.role_is_powerful($1) as p', [role])).rows[0].p)
      throw new AppRoleError(`The role ${role} exists and is too powerful for an application (superuser, BYPASSRLS, CREATEROLE or pgkiln's own): choose another one.`);
    const user = (await c.query('select alias from meta.app where db_role = $1 and ($2::int is null or id <> $2) limit 1', [role, o.appId ?? null])).rows[0];
    if (user) throw new AppRoleError(`The role ${role} exists and application ${user.alias} uses it: set the application's role yourself.`);
  } else await c.query(`create role ${pg.escapeIdentifier(role)} nologin`);
  const isolated = !!(await c.query('select 1 from meta.workspace where id = $1 and isolated', [o.ws])).rowCount;
  if (isolated) {
    await c.query('insert into meta.workspace_role (workspace_id, role_name) values ($1, $2) on conflict (workspace_id, role_name) do nothing', [o.ws, role]);
  } else if (!(await c.query(`select pg_has_role('pgkiln_runtime', $1, 'MEMBER') as m`, [role])).rows[0].m) {
    await c.query(`grant ${pg.escapeIdentifier(role)} to pgkiln_runtime`);
  }
  const schema = o.schema?.trim();
  if (schema) {
    if (reservedSchema(schema)) throw new AppRoleError(`The schema ${schema} can't be an application's parsing schema.`);
    const s = (await c.query('select nspowner::regrole::text as owner from pg_namespace where nspname = $1', [schema])).rows[0];
    if (!s) throw new AppRoleError(`The schema ${schema} doesn't exist.`);
    if (isolated && !(await c.query('select 1 from meta.workspace_role where workspace_id = $1 and role_name = $2', [o.ws, s.owner])).rowCount)
      throw new AppRoleError(`The schema ${schema} isn't one of this isolated workspace's schemas.`);
    await grantSchema(c, schema, role);
  }
  rolesChanged();
  return { role, created: !exists };
}

/**
 * An import of a file without a database role (sprint 186): keep the installed application's role when the import
 * replaces one, else make app_<alias> (makeAppRole; with rights on schema when known, as the APEX importer's parsing
 * schema). Sets doc.app.db_role and returns a note for the import's result, or null when the file has a role.
 */
export async function importRole(c: Queryable, doc: { app?: Record<string, unknown> } | null | undefined, o: { alias: string; ws?: number; schema?: string | null }) {
  if (!doc || typeof doc !== 'object') return null;
  const app = (doc.app ??= {});
  if (typeof app.db_role === 'string' && app.db_role.trim()) return null;
  const alias = String(o.alias || app.alias || '').trim().toLowerCase();
  if (!alias) return null;
  const installed = (await c.query('select db_role from meta.app where alias = $1', [alias])).rows[0];
  if (installed?.db_role) {
    app.db_role = installed.db_role;
    return `The file has no database role: the application keeps its role ${installed.db_role}.`;
  }
  const { role, created } = await makeAppRole(c, { alias, ws: o.ws ?? 1, schema: o.schema ?? null, appId: null });
  app.db_role = role;
  return `The file has no database role: the application runs as ${role}, ${created ? 'a role pgkiln created' : 'an existing role'}${o.schema ? ` with rights on schema ${o.schema}` : ' without rights yet'}. Grant it what the pages need (the Advisor lists the SQL it can't run).`;
}
