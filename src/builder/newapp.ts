import pg from 'pg';
import { owner, type Client } from '../db.ts';
import { passwordProblem } from '../accounts.ts';
import { replaceApp } from '../cli/replace.ts';

// Creating an application (Create → blank application, and Create → from a
// file): the parsing schema, a database role app_<alias> that can use only
// that schema, the app with a Home page, and the first user with the admin
// role. Shared by routes.ts (POST /builder/apps) and appfromfile.ts.

export interface NewAppInput {
  name?: string;
  alias?: string;
  /** an existing schema, or empty: a new schema named after the alias */
  schema?: string;
  authentication?: string;
  admin_user?: string;
  admin_password?: string;
}

export interface CheckedApp {
  name: string;
  alias: string;
  schema: string;
  role: string;
  /** app_users or none from the forms (the meta.app check constraint has the full list) */
  authentication: string;
  adminUser: string | null;
  adminPassword: string | null;
}

/** pgapex's and the system's schemas never become an application's parsing schema. */
export const reservedSchema = (schema: string) => /^pg_/i.test(schema) || ['meta', 'information_schema'].includes(schema.toLowerCase());

/** Validate the form (outside the transaction: the password check may look up the account). Throws an Error with a message for the developer. */
export async function checkNewApp(b: NewAppInput): Promise<CheckedApp> {
  const alias = (b.alias ?? '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]*$/.test(alias) || alias.length > 50) throw new Error('The alias must start with a letter and contain only a-z, 0-9, _ and - (at most 50 characters).');
  const name = (b.name ?? '').trim();
  if (!name) throw new Error('Enter a name for the application.');
  const schema = (b.schema ?? '').trim() || alias.replace(/-/g, '_');
  if (reservedSchema(schema) || schema.length > 63) throw new Error(`The schema ${schema} can't be the parsing schema of an application.`);
  const authentication = (b.authentication ?? '').trim() || 'app_users';
  let adminUser: string | null = null;
  let adminPassword: string | null = null;
  if (authentication !== 'none') {
    adminUser = (b.admin_user ?? '').trim();
    if (!adminUser) throw new Error('Apps with a login page need a first user.');
    const known = await owner.one('select 1 from meta.account where lower(username) = lower($1)', [adminUser]);
    const problem = known ? null : await passwordProblem(b.admin_password);
    if (problem) throw new Error(problem);
    adminPassword = known ? null : (b.admin_password ?? '');
  }
  return { name, alias, schema, role: `app_${alias.replace(/-/g, '_')}`, authentication, adminUser, adminPassword };
}

/** Create the schema, the role and the application (inside the caller's owner transaction). */
export async function createApp(c: Client, a: CheckedApp): Promise<{ id: number; existingAccount: boolean }> {
  const S = pg.escapeIdentifier(a.schema);
  const R = pg.escapeIdentifier(a.role);
  // The parsing schema: a role that can only use this schema.
  await c.query(`create schema if not exists ${S}`);
  if (!(await c.query('select 1 from pg_roles where rolname = $1', [a.role])).rowCount) await c.query(`create role ${R} nologin`);
  await c.query(`grant ${R} to pgapex_runtime`);
  await c.query(`grant usage on schema ${S} to ${R}`);
  await c.query(`grant select, insert, update, delete on all tables in schema ${S} to ${R}`);
  await c.query(`grant usage, select on all sequences in schema ${S} to ${R}`);
  await c.query(`grant execute on all functions in schema ${S} to ${R}`);
  await c.query(`alter default privileges in schema ${S} grant select, insert, update, delete on tables to ${R}`);
  await c.query(`alter default privileges in schema ${S} grant usage, select on sequences to ${R}`);
  await c.query(`alter default privileges in schema ${S} grant execute on functions to ${R}`);

  const r = await c.query('insert into meta.app (alias, name, authentication, db_role) values ($1, $2, $3, $4) returning id', [a.alias, a.name, a.authentication, a.role]);
  const appId = r.rows[0].id as number;
  const p = await c.query(`insert into meta.page (app_id, page_no, name, title) values ($1, 1, 'Home', 'Home') returning id`, [appId]);
  await c.query(`insert into meta.region (page_id, title, type, source) values ($1, 'Welcome', 'static', '<p>Hello, &APP_USER.! Edit this page in the builder.</p>')`, [p.rows[0].id]);
  await c.query(`insert into meta.nav_entry (app_id, seq, label, icon, target_page) values ($1, 1, 'Home', 'home', 1)`, [appId]);
  await c.query(`insert into meta.authz_scheme (app_id, name, type, value, error_message) values ($1, 'ADMIN', 'role', 'admin', 'Only administrators can access this page.')`, [appId]);
  let existingAccount = false;
  if (a.authentication !== 'none') {
    // an existing account just gets access; otherwise create it
    const existing = await c.query('select id from meta.account where lower(username) = lower($1)', [a.adminUser]);
    const accountId =
      existing.rows[0]?.id ??
      (await c.query('insert into meta.account (username, password_hash) values ($1, meta.hash_password($2)) returning id', [a.adminUser, a.adminPassword])).rows[0].id;
    await c.query(`insert into meta.app_access (app_id, account_id, roles) values ($1, $2, '{admin}')`, [appId, accountId]);
    existingAccount = !!existing.rowCount;
  }
  return { id: appId, existingAccount };
}

/**
 * (056) Start a new application from a boilerplate application: its definition
 * (pages, shared components, settings) replaces the new application's, which
 * keeps its name, alias, schema role and authentication. Inside the caller's
 * transaction, right after createApp().
 */
export async function startFromBoilerplate(c: Client, appId: number, a: CheckedApp, boilerplateId: number) {
  const bp = (await c.query<{ alias: string }>(`select alias from meta.app where id = $1 and app_type = 'boilerplate'`, [boilerplateId])).rows[0];
  if (!bp) throw new Error('Choose a boilerplate application (an application of type Boilerplate).');
  const doc = (await c.query('select meta.export_app($1) as d', [bp.alias])).rows[0].d;
  await replaceApp(c, doc, a.alias);
  await c.query(`update meta.app set name = $2, db_role = $3, authentication = $4, app_type = 'standard', api_role = null, updated_at = now() where id = $1`, [
    appId, a.name, a.role, a.authentication,
  ]);
}

/** A friendlier message for the errors creating an application can raise. */
export function createAppError(e: unknown, alias: string) {
  const err = e as { code?: string; constraint?: string; message: string };
  if (err.code === '23505' && /alias/.test(err.constraint ?? err.message)) return `An application with the alias ${alias} already exists.`;
  return err.message;
}
