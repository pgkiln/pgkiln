import pg from 'pg';
import type { Client } from './db.ts';
import { owner } from './db.ts';
import type { DatasetRow } from './datasets.ts';
import { createApp, type CheckedApp } from './builder/newapp.ts';

// (sprint 110, migration 120) Reporting applications (APEX 26.1: Data Reporter → Create Reporting
// Application): a pgkiln application of type 'reporting' on one or more datasets of the workspace, with the
// Data Reporter region as its engine. Users sign in with accounts of the user directory (the workspace's
// sign-in); their roles decide what they may do:
//
//   viewer         runs published reports (every user with access, also without a role)
//   editor         builds, saves, publishes and unpublishes reports of their own
//   administrator  also unpublishes and deletes anyone's reports
//
// The application's database role reads only the datasets' tables and views (SELECT, nothing else), so every
// report runs through its grants and row level security.

export const REPORTING_ROLES = ['viewer', 'editor', 'administrator'] as const;
export const MAX_REPORTING_DATASETS = 10;

/** The Data Reporter region's settings of a reporting application on these datasets. */
export function reportingConfig(name: string, datasets: { name: string }[]) {
  return {
    sources: datasets.map((d) => ({ id: d.name, dataset: d.name })),
    publishing: true,
    edit_authz: 'EDITOR',
    share_authz: 'EDITOR',
    admin_authz: 'ADMIN',
    welcome_title: name,
    page_size: 25,
  };
}

/**
 * Create a reporting application in the caller's owner transaction: createApp() (schema = the first dataset's,
 * the first user an administrator), then the type, the roles' authorization schemes, page 1 with the Data
 * Reporter, and the role's grants narrowed to SELECT on the datasets' tables and views.
 */
export async function createReportingApp(c: Client, a: CheckedApp, datasets: DatasetRow[]): Promise<{ id: number; existingAccount: boolean }> {
  if (!datasets.length) throw new Error('Choose at least one dataset.');
  if (datasets.length > MAX_REPORTING_DATASETS) throw new Error(`A reporting application has at most ${MAX_REPORTING_DATASETS} datasets.`);
  const app = await createApp(c, a);
  const R = pg.escapeIdentifier(a.role);
  // read only: nothing but SELECT on the datasets' objects (createApp granted the whole parsing schema)
  const S = pg.escapeIdentifier(a.schema);
  await c.query(`revoke all on all tables in schema ${S} from ${R}`);
  await c.query(`revoke all on all sequences in schema ${S} from ${R}`);
  await c.query(`revoke all on all functions in schema ${S} from ${R}`);
  await c.query(`alter default privileges in schema ${S} revoke all on tables from ${R}`);
  await c.query(`alter default privileges in schema ${S} revoke all on sequences from ${R}`);
  await c.query(`alter default privileges in schema ${S} revoke all on functions from ${R}`);
  for (const d of datasets) {
    await c.query(`grant usage on schema ${pg.escapeIdentifier(d.schema_name)} to ${R}`);
    for (const t of d.tables) {
      const exists = (await c.query('select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and c.relname = $2', [d.schema_name, t.table])).rowCount;
      if (exists) await c.query(`grant select on ${pg.escapeIdentifier(d.schema_name)}.${pg.escapeIdentifier(t.table)} to ${R}`);
    }
  }

  await c.query(`update meta.app set app_type = 'reporting', access_control = 'assigned', updated_at = now() where id = $1`, [app.id]);
  await c.query(`update meta.authz_scheme set value = 'administrator', error_message = 'Only administrators of the reports can do this.' where app_id = $1 and name = 'ADMIN'`, [app.id]);
  await c.query(
    `insert into meta.authz_scheme (app_id, name, type, value, error_message)
     values ($1, 'EDITOR', 'sql', 'meta.has_role(''editor'') or meta.has_role(''administrator'')', 'Only editors can change reports.')`,
    [app.id],
  );
  await c.query(`update meta.app_access set roles = '{administrator}' where app_id = $1`, [app.id]);

  // page 1: the Data Reporter instead of the hero
  const page = (await c.query<{ id: number }>(`update meta.page set name = 'Reports', title = 'Reports' where app_id = $1 and page_no = 1 returning id`, [app.id])).rows[0];
  await c.query('delete from meta.region where page_id = $1', [page.id]);
  await c.query(`insert into meta.region (page_id, seq, title, type, columns, template, config) values ($1, 10, 'Reports', 'data_reporter', 12, 'standard', $2)`, [
    page.id, JSON.stringify(reportingConfig(a.name, datasets)),
  ]);
  await c.query(`update meta.nav_entry set label = 'Reports', icon = 'chart' where app_id = $1 and target_page = 1`, [app.id]);
  return app;
}

/** (sprint 110) The number of reporting applications of a workspace (the workspace home's summary; meta.reporting_app_count). */
export async function reportingAppCount(workspaceId: number): Promise<number> {
  return (await owner.one<{ n: number }>('select meta.reporting_app_count($1) as n', [workspaceId]))?.n ?? 0;
}

/** The reporting applications of a workspace, with the datasets they use (from the region's settings). */
export async function reportingApps(workspaceId: number) {
  return (
    await owner.query<{ id: number; alias: string; name: string; datasets: string[]; users: number; reports: number }>(
      `select a.id, a.alias, a.name,
              coalesce((select array_agg(distinct s ->> 'dataset' order by s ->> 'dataset')
                          from meta.page p join meta.region r on r.page_id = p.id, jsonb_array_elements(case when jsonb_typeof(r.config -> 'sources') = 'array' then r.config -> 'sources' else '[]' end) s
                         where p.app_id = a.id and r.type = 'data_reporter' and s ? 'dataset'), '{}') as datasets,
              (select count(*)::int from meta.app_access x where x.app_id = a.id) as users,
              (select count(*)::int from meta.data_report d where d.app_id = a.id and d.shared) as reports
         from meta.app a
        where a.app_type = 'reporting' and meta.app_workspace(a.id) = $1
        order by lower(a.name), a.id`,
      [workspaceId],
    )
  ).rows;
}
