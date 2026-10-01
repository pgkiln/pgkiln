// Import an application document *over* an existing application, keeping
// what belongs to this installation: the application's id and alias, who has
// access, API clients, sessions, saved reports, running tasks and workflows,
// and the on/off state of automations. Components are matched by their static
// id (see src/appfiles.ts): saved reports follow their region (page number +
// region key), tasks and workflows their definition (name), automation logs and
// state their automation (name).
//
// How: meta.import_app() loads the document as a temporary application; its
// rows then move to the existing application, whose old components are
// deleted, all in the caller's transaction.
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { regionKeys } from '../appfiles.ts';

/** Tables of an application that are its definition: replaced. */
export const REPLACED = [
  'authz_scheme', 'app_item', 'app_process', 'lov', 'app_group_role', 'text_message', 'translation',
  'report_layout', 'automation', 'document_template', 'task_definition', 'workflow_definition',
  'rest_module', 'nav_entry', 'page',
];
/** Tables of an application that belong to the installation: kept. */
export const KEPT = ['app_access', 'api_client', 'session', 'sso_pending', 'saved_report', 'persistent_login', 'task', 'workflow'];
/** Children of pages (replaced with their page). */
const PAGE_CHILDREN = ['region', 'item', 'button', 'dynamic_action', 'validation', 'process'];
/** References into replaced tables from kept data, repointed below: "table.column". */
const REPOINTED = ['saved_report.region_id', 'task.definition_id', 'workflow.definition_id', 'automation_log.automation_id'];

type Db = pg.ClientBase | pg.Pool;

/** Refuse to run when the schema has tables this code does not know (a newer migration). */
export async function checkSchema(db: Db) {
  const fks = (
    await db.query<{ src: string; col: string; dst: string }>(
      `select c.relname as src, a.attname as col, f.relname as dst
         from pg_constraint k
         join pg_class c on c.oid = k.conrelid
         join pg_class f on f.oid = k.confrelid
         join pg_namespace n on n.oid = c.relnamespace
         join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
        where n.nspname = 'meta' and k.contype = 'f'`,
    )
  ).rows;
  const replaced = new Set([...REPLACED, ...PAGE_CHILDREN]);
  const problems: string[] = [];
  for (const fk of fks) {
    if (fk.dst === 'app' && !REPLACED.includes(fk.src) && !KEPT.includes(fk.src)) problems.push(`meta.${fk.src} (belongs to an application)`);
    if (replaced.has(fk.dst) && !replaced.has(fk.src) && !REPOINTED.includes(`${fk.src}.${fk.col}`))
      problems.push(`meta.${fk.src}.${fk.col} (refers to meta.${fk.dst})`);
  }
  if (problems.length) throw new Error(`replace does not know these tables yet; update src/cli/replace.ts: ${problems.join(', ')}`);
}

/** Replace the components of application `alias` with those of doc. Returns the application id. */
export async function replaceApp(db: Db, doc: unknown, alias: string): Promise<number> {
  await checkSchema(db);
  const target = (await db.query<{ id: number }>('select id from meta.app where alias = $1 for update', [alias])).rows[0];
  if (!target) throw new Error(`application ${alias} not found`);
  const old = target.id;
  const tmpAlias = `pgapex-replace-${randomBytes(6).toString('hex')}`;
  const neu = (await db.query<{ id: number }>('select meta.import_app($1::jsonb, $2) as id', [JSON.stringify(doc), tmpAlias])).rows[0].id;

  // kept data follows its component
  for (const [table, ref] of [['task', 'task_definition'], ['workflow', 'workflow_definition'], ['automation_log', 'automation']] as const) {
    const col = table === 'automation_log' ? 'automation_id' : 'definition_id';
    await db.query(
      `update meta.${table} t set ${col} = n.id
         from meta.${ref} o join meta.${ref} n on n.name = o.name and n.app_id = $2
        where o.app_id = $1 and t.${col} = o.id`,
      [old, neu],
    );
  }
  // automations keep this installation's switch and schedule state
  await db.query(
    `update meta.automation n set enabled = o.enabled, next_run_at = o.next_run_at, last_run_at = o.last_run_at, last_status = o.last_status
       from meta.automation o where o.app_id = $1 and n.app_id = $2 and n.name = o.name`,
    [old, neu],
  );
  const regions = async (appId: number) => {
    const rows = (
      await db.query<{ id: number; page_no: number; title: string; type: string }>(
        `select r.id, p.page_no, r.title, r.type from meta.region r join meta.page p on p.id = r.page_id
          where p.app_id = $1 order by p.page_no, r.seq, r.id`,
        [appId],
      )
    ).rows;
    const byPage = new Map<number, typeof rows>();
    for (const r of rows) byPage.set(r.page_no, [...(byPage.get(r.page_no) ?? []), r]);
    const keys = new Map<string, number>();
    for (const [pageNo, rs] of byPage) regionKeys(rs).forEach((k, i) => keys.set(`${pageNo}/${k}`, rs[i].id));
    return keys;
  };
  const [oldRegions, newRegions] = await Promise.all([regions(old), regions(neu)]);
  const pairs = [...oldRegions].filter(([k]) => newRegions.has(k)).map(([k, id]) => [id, newRegions.get(k)!]);
  if (pairs.length)
    await db.query(
      `update meta.saved_report s set region_id = m.neu
         from unnest($1::int[], $2::int[]) as m(old, neu) where s.region_id = m.old`,
      [pairs.map((p) => p[0]), pairs.map((p) => p[1])],
    );

  // swap the components
  for (const table of REPLACED) await db.query(`delete from meta.${table} where app_id = $1`, [old]);
  for (const table of REPLACED) await db.query(`update meta.${table} set app_id = $1 where app_id = $2`, [old, neu]);

  // the application's settings, except its identity
  const cols = (
    await db.query<{ c: string }>(
      `select quote_ident(column_name) as c from information_schema.columns
        where table_schema = 'meta' and table_name = 'app' and column_name not in ('id', 'alias', 'created_at', 'updated_at')
        order by ordinal_position`,
    )
  ).rows.map((r) => r.c);
  await db.query(
    `update meta.app o set (${cols.join(', ')}) = (select ${cols.join(', ')} from meta.app n where n.id = $2), updated_at = now() where o.id = $1`,
    [old, neu],
  );
  await db.query('delete from meta.app where id = $1', [neu]);
  return old;
}
