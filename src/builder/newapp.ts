import pg from 'pg';
import { owner, type Client } from '../db.ts';
import { passwordProblem } from '../accounts.ts';
import { replaceApp } from '../cli/replace.ts';
import { placeApp } from './workspaces.ts';
import { BASE_STYLES, NEW_APP_BASE } from '../runtime/styles.ts';
import { LANGUAGE_NAMES } from '../i18n.ts';
import { isIcon } from '../icons.ts';
import { secretKeyConfigured } from '../secrets.ts';

/** (097) The icon of a new application's home page when the developer chose none. */
export const DEFAULT_APP_ICON = 'layers';
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** (sprint 72) The page number of a generated application's About page. */
export const ABOUT_PAGE = 9000;

/**
 * (sprint 72) The About page of a generated application (APEX: the About Page
 * feature): the application's name, its description or the pages of its menu,
 * and a Help menu with it in the header's navigation bar (a list NAVBAR, unless
 * the application has a navigation bar list already). Nothing when the page
 * number is taken.
 */
export async function addAboutPage(c: Client, appId: number, description?: string | null) {
  const app = (await c.query<{ name: string; navbar_list: string | null; home_page: number }>('select name, navbar_list, home_page from meta.app where id = $1', [appId])).rows[0];
  if ((await c.query('select 1 from meta.page where app_id = $1 and page_no = $2', [appId, ABOUT_PAGE])).rowCount) return;
  const pages = (
    await c.query<{ label: string }>(
      `select e.label from meta.nav_entry e where e.app_id = $1 and e.parent_id is null and e.target_page is not null and e.target_page <> $2 order by e.seq, e.id`,
      [appId, app.home_page],
    )
  ).rows.map((r) => r.label);
  const text = description
    ? `<p>${escapeHtml(description)}</p>`
    : pages.length
      ? `<p>${escapeHtml(app.name)} has these pages:</p><ul>${pages.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`
      : `<p>${escapeHtml(app.name)}</p>`;
  const page = (await c.query(`insert into meta.page (app_id, page_no, name, title, parent_page) values ($1, $2, 'About', $3, $4) returning id`, [appId, ABOUT_PAGE, `About ${app.name}`.slice(0, 200), app.home_page])).rows[0].id;
  await c.query(`insert into meta.region (page_id, seq, title, type, source) values ($1, 10, $2, 'static', $3)`, [page, app.name, text]);
  if (app.navbar_list) return;
  await c.query(`insert into meta.list (app_id, name, description) values ($1, 'NAVBAR', 'The navigation bar: the Help menu') on conflict (app_id, name) do nothing`, [appId]);
  const help = (await c.query(`insert into meta.list_entry (app_id, list_name, seq, label, icon) values ($1, 'NAVBAR', 10, 'Help', 'help') returning id`, [appId])).rows[0].id;
  await c.query(`insert into meta.list_entry (app_id, list_name, parent_id, seq, label, icon, target_page) values ($1, 'NAVBAR', $2, 10, 'About', 'info', $3)`, [appId, help, ABOUT_PAGE]);
  await c.query(`update meta.app set navbar_list = 'NAVBAR' where id = $1`, [appId]);
}

/**
 * (sprint 73) The Create Application wizard's features (APEX: Features). Each maps to a setting or to pages:
 * - about: an About page in a Help menu (addAboutPage)
 * - access: authorization schemes CONTRIBUTOR and READER next to ADMIN (roles admin, contributor, reader)
 * - activity: an Activity page for administrators (page 9010: page views per day and the latest activity)
 * - feedback: users may send feedback (the navigation bar's Feedback entry)
 * - theme: users may choose light or dark (theme.user_choice)
 * - pwa, push: installable, with push notifications (push needs PGKILN_SECRET_KEY; its key is made after the commit)
 */
export interface Features { about: boolean; access: boolean; activity: boolean; feedback: boolean; theme: boolean; pwa: boolean; push: boolean }
export const FEATURES: [keyof Features, string, string, boolean][] = [
  ['about', 'About page', 'An About page in a Help menu of the header.', true],
  ['access', 'Access control', 'Authorization schemes for the roles admin, contributor and reader, to put on pages, regions and buttons.', false],
  ['activity', 'Activity reporting', 'A page for administrators with the page views per day and the latest activity.', false],
  ['feedback', 'Feedback', 'Users send feedback from the header; you read it under Activity → Feedback.', false],
  ['theme', 'Theme style selection', 'Users may choose the light or the dark theme.', true],
  ['pwa', 'Install as an app (PWA)', 'Installable on phones and desktops, with offline pages.', false],
  ['push', 'Push notifications', 'Notifications to the users\' devices (with Install as an app).', false],
];
/** The features ticked on a form (a form without them: the defaults). */
export const featuresFrom = (b: Record<string, unknown>, posted: boolean): Features =>
  Object.fromEntries(FEATURES.map(([k, , , on]) => [k, posted ? b[`f_${k}`] === 'true' : on])) as unknown as Features;

/** (sprint 73) The Activity page of a generated application. */
export const ACTIVITY_PAGE = 9010;

async function applyFeatures(c: Client, appId: number, f: Partial<Features>, notes: string[]) {
  if (f.access) {
    await c.query(
      `insert into meta.authz_scheme (app_id, name, type, value, error_message) values
         ($1, 'CONTRIBUTOR', 'sql', 'meta.has_role(''admin'') or meta.has_role(''contributor'')', 'Only contributors can do this.'),
         ($1, 'READER', 'sql', 'meta.has_role(''admin'') or meta.has_role(''contributor'') or meta.has_role(''reader'')', 'Only readers can open this page.')
       on conflict do nothing`,
      [appId],
    );
  }
  if (f.activity && !(await c.query('select 1 from meta.page where app_id = $1 and page_no = $2', [appId, ACTIVITY_PAGE])).rowCount) {
    const home = (await c.query('select home_page from meta.app where id = $1', [appId])).rows[0].home_page;
    const page = (await c.query(`insert into meta.page (app_id, page_no, name, title, parent_page, authz) values ($1, $2, 'Activity', 'Activity', $3, 'ADMIN') returning id`, [appId, ACTIVITY_PAGE, home])).rows[0].id;
    await c.query(
      `insert into meta.region (page_id, seq, title, type, source, config) values
         ($1, 10, 'Page views per day', 'chart', $2, '{"kind": "column"}'),
         ($1, 20, 'Latest activity', 'report', $3, '{"headings": {"at": "Time", "username": "User", "event": "Event", "page_no": "Page", "elapsed_ms": "Time taken (ms)"}}')`,
      [page,
       `select to_char(date_trunc('day', at), 'YYYY-MM-DD') as "Day", count(*) as "Page views"
  from meta.app_activity(30)
 where event = 'page_view'
 group by 1
 order by 1`,
       `select at, username, event, page_no, elapsed_ms
  from meta.app_activity(30)`],
    );
    await c.query(`insert into meta.nav_entry (app_id, seq, label, icon, target_page, authz) values ($1, 9010, 'Activity', 'activity', $2, 'ADMIN')`, [appId, ACTIVITY_PAGE]);
  }
  if (f.feedback) await c.query('update meta.app set feedback = true where id = $1', [appId]);
  if (f.theme === false) await c.query(`update meta.app set theme = theme || '{"user_choice": false}' where id = $1`, [appId]);
  if (f.pwa || f.push) await c.query('update meta.app set pwa = true where id = $1', [appId]);
  if (f.push) {
    if (secretKeyConfigured()) await c.query('update meta.app set pwa_push = true where id = $1', [appId]);
    else notes.push('Push notifications are off: they need PGKILN_SECRET_KEY in the server\'s environment.');
  }
}

/** (sprint 72) After a wizard generated the pages: the home page's cards and, unless turned off, the About page; (sprint 73) the chosen features. */
export async function finishGeneratedApp(c: Client, appId: number, o: { about?: boolean; description?: string | null; features?: Partial<Features>; notes?: string[] } = {}) {
  const f = { ...(o.features ?? {}) };
  if (f.about === undefined) f.about = o.about !== false;
  await applyFeatures(c, appId, f, o.notes ?? []);
  await addHomeCards(c, appId);
  if (f.about) await addAboutPage(c, appId, o.description);
}

/**
 * (097) A card per page of the navigation menu on the home page (a static list
 * HOME_PAGES shown by a list region with the cards template), after the pages
 * of a new application were generated. Does nothing when the application has
 * no other pages, or the list exists already.
 */
export async function addHomeCards(c: Client, appId: number) {
  const entries = (
    await c.query<{ label: string; icon: string | null; target_page: number; authz: string | null }>(
      `select e.label, e.icon, e.target_page, e.authz from meta.nav_entry e join meta.app a on a.id = e.app_id
        where e.app_id = $1 and e.parent_id is null and e.target_page is not null and e.target_page <> a.home_page
        order by e.seq, e.id`,
      [appId],
    )
  ).rows;
  if (!entries.length) return;
  const made = await c.query(`insert into meta.list (app_id, name, description) values ($1, 'HOME_PAGES', 'The cards of the home page') on conflict (app_id, name) do nothing`, [appId]);
  if (!made.rowCount) return;
  for (const [n, e] of entries.entries())
    await c.query('insert into meta.list_entry (app_id, list_name, seq, label, icon, target_page, authz) values ($1, $2, $3, $4, $5, $6, $7)', [appId, 'HOME_PAGES', (n + 1) * 10, e.label, e.icon, e.target_page, e.authz]);
  await c.query(
    `insert into meta.region (page_id, seq, title, type, template, config)
     select p.id, 20, 'Pages', 'list', 'plain', '{"list": "HOME_PAGES", "template": "cards"}' from meta.page p join meta.app a on a.id = p.app_id and p.page_no = a.home_page where a.id = $1`,
    [appId],
  );
}

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
  /** (097) a line about the application, shown on the home page */
  description?: string;
  /** (097) the application's icon (a name from icons.svg) */
  icon?: string;
  /** (sprint 73) appearance: base style, menu position, accent colour; the primary language */
  base?: string;
  nav?: string;
  accent?: string;
  language?: string;
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
  /** the workspace that gets the application (the developer's current one) */
  workspaceId: number;
  /** (097) shown under the name on the home page */
  description?: string | null;
  /** (097) the home page's icon */
  icon?: string | null;
  /** (sprint 73) the theme: base style (Iris when not given), menu at the top, own accent colour */
  base?: 'iris' | 'lavender' | 'standard';
  topNav?: boolean;
  accent?: string | null;
  /** (sprint 73) the primary language (default en) */
  language?: string;
}

/** pgkiln's and the system's schemas never become an application's parsing schema. */
export const reservedSchema = (schema: string) => /^pg_/i.test(schema) || ['meta', 'information_schema'].includes(schema.toLowerCase());

/** Validate the form (outside the transaction: the password check may look up the account). Throws an Error with a message for the developer. */
export async function checkNewApp(b: NewAppInput, workspaceId: number): Promise<CheckedApp> {
  if (!(workspaceId > 0)) throw new Error('You are not a developer of any workspace yet: ask an administrator to add you to one.');
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
  const description = (b.description ?? '').trim().slice(0, 300) || null;
  const appIcon = (b.icon ?? '').trim();
  if (appIcon && !isIcon(appIcon)) throw new Error('Choose one of the icons in the list.');
  const base = b.base === 'lavender' || b.base === 'standard' ? b.base : 'iris';
  const accent = /^#[0-9a-f]{6}$/i.test(b.accent ?? '') && b.accent!.toLowerCase() !== BASE_STYLES[base].accent ? b.accent!.toLowerCase() : null;
  const language = (b.language ?? '').trim() || 'en';
  if (!(language in LANGUAGE_NAMES)) throw new Error('Choose one of the languages in the list.');
  return {
    name, alias, schema, role: `app_${alias.replace(/-/g, '_')}`, authentication, adminUser, adminPassword, workspaceId, description, icon: appIcon || null,
    base, topNav: b.nav === 'top', accent, language,
  };
}

/** Create the schema, the role and the application (inside the caller's owner transaction). */
export async function createApp(c: Client, a: CheckedApp): Promise<{ id: number; existingAccount: boolean }> {
  const S = pg.escapeIdentifier(a.schema);
  const R = pg.escapeIdentifier(a.role);
  // The parsing schema: a role that can only use this schema.
  // (090) an isolated workspace's application gets a new role, and a schema that is new (owned by that
  // role) or one of the workspace's own: never another workspace's
  const isolated = (await c.query('select 1 from meta.workspace where id = $1 and isolated', [a.workspaceId])).rowCount;
  const roleExists = (await c.query('select 1 from pg_roles where rolname = $1', [a.role])).rowCount;
  if (isolated) {
    // (a taken alias fails below, with its own message)
    const aliasTaken = (await c.query('select 1 from meta.app where alias = $1', [a.alias])).rowCount;
    if (roleExists && !aliasTaken) throw new Error(`The database role ${a.role} exists already: choose another alias.`);
    const foreign = await c.query(
      `select 1 from pg_namespace n where n.nspname = $1
          and n.nspowner::regrole::text not in (select role_name from meta.workspace_role where workspace_id = $2)`,
      [a.schema, a.workspaceId],
    );
    if (foreign.rowCount) throw new Error(`The schema ${a.schema} exists already and doesn't belong to this workspace: choose another schema.`);
  }
  if (!roleExists) await c.query(`create role ${R} nologin`);
  await c.query(`create schema if not exists ${S}${isolated ? ` authorization ${R}` : ''}`);
  if (isolated) {
    // a name the workspace lists already (an application deleted, its role dropped) is its own; another workspace's is refused
    await c.query('insert into meta.workspace_role (workspace_id, role_name) values ($1, $2) on conflict (workspace_id, role_name) do nothing', [a.workspaceId, a.role]);
  } else await c.query(`grant ${R} to pgkiln_runtime`);
  await c.query(`grant usage on schema ${S} to ${R}`);
  await c.query(`grant select, insert, update, delete on all tables in schema ${S} to ${R}`);
  await c.query(`grant usage, select on all sequences in schema ${S} to ${R}`);
  await c.query(`grant execute on all functions in schema ${S} to ${R}`);
  await c.query(`alter default privileges in schema ${S} grant select, insert, update, delete on tables to ${R}`);
  await c.query(`alter default privileges in schema ${S} grant usage, select on sequences to ${R}`);
  await c.query(`alter default privileges in schema ${S} grant execute on functions to ${R}`);

  // new applications start with the newest base style (Iris), light (users may switch to dark); existing ones keep theirs
  // (sprint 73) the wizard's appearance: base style, menu at the top, an own accent colour
  const theme: Record<string, string> = { mode: 'light' };
  const base = a.base ?? NEW_APP_BASE;
  if (base !== 'standard') theme.base = base;
  if (a.topNav) theme.nav = 'top';
  if (a.accent) theme.accent = a.accent;
  const r = await c.query('insert into meta.app (alias, name, authentication, db_role, theme, language) values ($1, $2, $3, $4, $5, $6) returning id', [a.alias, a.name, a.authentication, a.role, theme, a.language ?? 'en']);
  const appId = r.rows[0].id as number;
  await placeApp(c, appId, a.workspaceId);
  const p = await c.query(`insert into meta.page (app_id, page_no, name, title) values ($1, 1, 'Home', 'Home') returning id`, [appId]);
  // (097) a hero with the application's icon, name and description (no developer wording for end users)
  await c.query(`insert into meta.region (page_id, seq, title, type, source, template, config) values ($1, 10, $2, 'static', $3, 'hero', $4)`, [
    p.rows[0].id, a.name, a.description ? `<p>${escapeHtml(a.description)}</p>` : '', { icon: a.icon ?? DEFAULT_APP_ICON },
  ]);
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
  await replaceApp(c, doc, a.alias, { backup: null });
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
