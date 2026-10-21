import type { FastifyInstance } from 'fastify';
import { owner, type Db } from '../db.ts';
import { html, raw } from '../html.ts';
import { icon } from '../icons.ts';
import { BASE, developer, region, send, shell, workshopTabs, type Req } from './ui.ts';
import { isAdmin } from './locks.ts';
import { workshopDb, workshopRunsAs } from './workspaces.ts';

// SQL Workshop → Utilities (sprint 62; APEX: SQL Workshop → Utilities): one
// page with the workshop's tools (Load and Unload Data, Sample Data, DDL,
// Compare, Query Builder) and three of its own:
//
//   - Object Reports: fixed catalogue queries (tables without a primary key,
//     foreign keys without an index, RLS without policies, …) over the schemas
//     the SQL Workshop's connection may use (workshopDb: an isolated
//     workspace's developers see only their own roles' schemas);
//   - About Database: version, a few settings, extensions, sizes;
//   - (sprint 102) the Database Monitor moved to SQL Workshop › SQL Monitor
//     (sql-monitor.ts); its old address redirects there.
//
// Every query runs read only with a statement timeout.

/** Schemas of the report queries: usable by the connection, not pgkiln's or the system's (alias n). */
const USABLE = `n.nspname !~ '^pg_' and n.nspname not in ('information_schema', 'meta') and has_schema_privilege(n.oid, 'USAGE')`;

interface Report {
  title: string;
  about: string;
  columns: [key: string, label: string, cls?: 'num'][];
  sql: string;
}

/** Object Reports. Each query returns `object` (schema.name, linked to the Object Browser) first. */
export const OBJECT_REPORTS: Record<string, Report> = {
  'no-primary-key': {
    title: 'Tables without a primary key',
    about: 'Forms, interactive grids and REST write-back need a key to find a row again.',
    columns: [['rows', 'Rows (estimate)', 'num']],
    sql: `select format('%I.%I', n.nspname, c.relname) as object, greatest(c.reltuples, 0)::bigint as rows
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where c.relkind in ('r', 'p') and not c.relispartition and ${USABLE}
             and not exists (select 1 from pg_constraint k where k.conrelid = c.oid and k.contype = 'p')
           order by 1`,
  },
  'unindexed-foreign-keys': {
    title: 'Foreign keys without an index',
    about: 'Deleting or updating a parent row scans the child table, and joins from the parent are slower. An index on the foreign key columns (in this order) avoids it.',
    columns: [['constraint', 'Foreign key'], ['columns', 'Columns'], ['parent', 'References'], ['suggestion', 'Index']],
    sql: `select format('%I.%I', n.nspname, c.relname) as object, k.conname as constraint,
                 (select string_agg(quote_ident(a.attname), ', ' order by u.i) from unnest(k.conkey) with ordinality u(attnum, i)
                    join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.attnum) as columns,
                 k.confrelid::regclass::text as parent,
                 format('create index on %I.%I (%s)', n.nspname, c.relname,
                   (select string_agg(quote_ident(a.attname), ', ' order by u.i) from unnest(k.conkey) with ordinality u(attnum, i)
                      join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.attnum)) as suggestion
            from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
           where k.contype = 'f' and ${USABLE}
             and not exists (select 1 from pg_index i where i.indrelid = k.conrelid
                               and (i.indkey::int2[])[0:cardinality(k.conkey) - 1] @> k.conkey
                               and (i.indkey::int2[])[0:cardinality(k.conkey) - 1] <@ k.conkey)
           order by 1, 2`,
  },
  'rls-without-policies': {
    title: 'Row-level security without policies',
    about: 'Row-level security is enabled but the table has no policy: every role except its owner (and roles that bypass RLS) sees no rows and can change none.',
    columns: [['forced', 'Forced for the owner']],
    sql: `select format('%I.%I', n.nspname, c.relname) as object, case when c.relforcerowsecurity then 'yes' else 'no' end as forced
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where c.relkind in ('r', 'p') and c.relrowsecurity and ${USABLE}
             and not exists (select 1 from pg_policy p where p.polrelid = c.oid)
           order by 1`,
  },
  'no-row-level-security': {
    title: 'Tables without row-level security',
    about: 'Every role with a grant on these tables sees and changes all their rows. Fine for lookup tables; enable row-level security where rows belong to users or tenants.',
    columns: [['owner', 'Owner'], ['grants', 'Granted to']],
    sql: `select format('%I.%I', n.nspname, c.relname) as object, c.relowner::regrole::text as owner,
                 (select string_agg(distinct case when g.grantee = 0 then 'PUBLIC' else g.grantee::regrole::text end, ', ')
                    from aclexplode(c.relacl) g where g.grantee <> c.relowner) as grants
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where c.relkind in ('r', 'p') and not c.relispartition and not c.relrowsecurity and ${USABLE}
           order by 1`,
  },
  'public-grants': {
    title: 'Privileges granted to PUBLIC',
    about: 'Every database role, including ones made later, has these privileges.',
    columns: [['kind', 'Kind'], ['privileges', 'Privileges']],
    sql: `select format('%I.%I', n.nspname, c.relname) as object,
                 case c.relkind when 'r' then 'table' when 'p' then 'table' when 'v' then 'view' when 'm' then 'materialized view' when 'S' then 'sequence' when 'f' then 'foreign table' else c.relkind::text end as kind,
                 string_agg(g.privilege_type, ', ' order by g.privilege_type) as privileges
            from pg_class c join pg_namespace n on n.oid = c.relnamespace, aclexplode(c.relacl) g
           where g.grantee = 0 and ${USABLE}
           group by 1, 2 order by 1`,
  },
  'unused-indexes': {
    title: 'Unused indexes',
    about: 'Indexes not used by a query since the statistics were last reset (not primary keys or unique ones). They slow down writes and take space; check on every server (replicas count their own) before dropping one.',
    columns: [['index', 'Index'], ['size', 'Size', 'num']],
    sql: `select format('%I.%I', s.schemaname, s.relname) as object, s.indexrelname as index, pg_size_pretty(pg_relation_size(s.indexrelid)) as size
            from pg_stat_user_indexes s join pg_index i on i.indexrelid = s.indexrelid join pg_namespace n on n.nspname = s.schemaname
           where s.idx_scan = 0 and not i.indisunique and not i.indisprimary and ${USABLE}
           order by pg_relation_size(s.indexrelid) desc, 1`,
  },
  'largest-tables': {
    title: 'Largest tables',
    about: 'The 100 largest tables with their indexes and TOAST data.',
    columns: [['rows', 'Rows (estimate)', 'num'], ['table_size', 'Table', 'num'], ['index_size', 'Indexes', 'num'], ['total', 'Total', 'num']],
    sql: `select format('%I.%I', n.nspname, c.relname) as object, greatest(c.reltuples, 0)::bigint as rows,
                 pg_size_pretty(pg_table_size(c.oid)) as table_size, pg_size_pretty(pg_indexes_size(c.oid)) as index_size,
                 pg_size_pretty(pg_total_relation_size(c.oid)) as total
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where c.relkind in ('r', 'p', 'm') and ${USABLE}
           order by pg_total_relation_size(c.oid) desc limit 100`,
  },
  'no-comments': {
    title: 'Tables without a comment',
    about: 'Comments (COMMENT ON) document a data model; the App Builder and its AI read them. SQL Workshop → AI → Describe tables drafts them.',
    columns: [['columns', 'Columns', 'num'], ['commented', 'With a comment', 'num']],
    sql: `select format('%I.%I', n.nspname, c.relname) as object,
                 (select count(*) from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped)::int as columns,
                 (select count(*) from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped and col_description(c.oid, a.attnum) is not null)::int as commented
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where c.relkind in ('r', 'p', 'v', 'm') and not c.relispartition and obj_description(c.oid, 'pg_class') is null and ${USABLE}
           order by 1`,
  },
};

/** Run read-only queries with a statement timeout. */
async function readOnly<T>(db: Db, fn: (q: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>) => Promise<T>): Promise<T> {
  return db.tx(async (c) => {
    await c.query('set transaction read only');
    await c.query(`set local statement_timeout = '15s'`);
    return fn(async (sql, params) => (await c.query(sql, params)).rows);
  });
}

const crumbs = (last: string): [string, string?][] => [['SQL Workshop', `${BASE}/sql`], ['Utilities', `${BASE}/sql/utilities`], [last]];

export async function sqlUtilityRoutes(app: FastifyInstance) {
  app.get(`${BASE}/sql/utilities`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const admin = await isAdmin(s.username);
    const tile = (href: string, ic: string, title: string, text: string) =>
      html`<a class="ab-tile sw-tile" href="${BASE}${href}"><span class="ab-tile-icon sw-tile-icon">${icon(ic)}</span><strong>${title}</strong><span>${text}</span></a>`;
    const main = html`<h1 class="u-mb1">SQL Workshop</h1>${workshopTabs('utilities', s)}
      <div class="ab-tiles ab-tiles-wrap">
        ${tile('/sql/load', 'upload', 'Data Workshop: Load Data', 'Load CSV, Excel, JSON or XML into a new or existing table, with saved definitions.')}
        ${tile('/sql/unload', 'download', 'Data Workshop: Unload Data', 'Download a table or a query as CSV, JSON, XML, Excel or SQL inserts.')}
        ${tile('/sql/sample-data', 'layers', 'Sample Data', 'Generate realistic rows for your tables.')}
        ${tile('/sql/query', 'filter', 'Query Builder', 'Build a query by drawing joins between tables.')}
        ${tile('/sql/ddl', 'file', 'Generate DDL', 'The SQL that creates a schema\'s objects.')}
        ${tile('/sql/compare', 'layers', 'Schema Comparison', 'The differences between two schemas, and the SQL to align them.')}
        ${tile('/sql/utilities/reports', 'list', 'Object Reports', 'Tables without a primary key, foreign keys without an index, row-level security, grants, sizes.')}
        ${tile('/sql/utilities/about', 'help', 'About Database', 'The PostgreSQL version, settings, extensions and sizes.')}
        ${admin ? tile('/sql/data-pump', 'archive', 'Schema Export / Import', 'A schema to a file with pg_dump, a file into a schema with pg_restore (administrators).') : ''}
        ${admin ? tile('/sql/scheduling', 'clock', 'Scheduling', 'pg_cron jobs: SQL on a schedule, next runs and run history (administrators).') : ''}
        ${admin ? tile('/sql/monitor', 'activity', 'SQL Monitor', 'Sessions, running and blocked queries, wait events and Top SQL (administrators).') : ''}
      </div>`;
    return send(reply, s, shell(s, 'SQL Workshop utilities', [['SQL Workshop', `${BASE}/sql`], ['Utilities']], main, 'sql'));
  });

  app.get(`${BASE}/sql/utilities/reports`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const db = await workshopDb(s);
    const key = String((req.query as Record<string, unknown>)?.r ?? 'no-primary-key');
    const r = Object.hasOwn(OBJECT_REPORTS, key) ? OBJECT_REPORTS[key] : null;
    if (!r) return reply.code(404).send('Not found');
    let rows: Record<string, unknown>[] = [];
    let error = '';
    try {
      rows = await readOnly(db, (q) => q(r.sql));
    } catch (e) {
      error = (e as Error).message;
    }
    const nav = html`<nav aria-label="Object reports"><ul class="ab-links ab-tasks">${Object.entries(OBJECT_REPORTS).map(([k, x]) =>
      html`<li><a href="${BASE}/sql/utilities/reports?r=${k}"${k === key ? raw(' aria-current="page"') : ''}>${x.title}${icon('chevron')}</a></li>`)}</ul></nav>`;
    const table = html`<div class="table-wrap"><table class="report report-reflow">
      <thead><tr><th>Object</th>${r.columns.map(([, l, c]) => html`<th${c ? raw(` class="${c}"`) : ''}>${l}</th>`)}</tr></thead>
      <tbody>${rows.length
        ? rows.map((row) => html`<tr><td data-label="Object" class="u-break"><a href="${BASE}/sql/objects?o=${encodeURIComponent(String(row.object))}">${String(row.object)}</a></td>
            ${r.columns.map(([k, l, c]) => html`<td data-label="${l}"${c ? raw(` class="${c}"`) : raw(' class="u-break"')}>${k === 'suggestion' ? html`<code>${String(row[k] ?? '')}</code>` : String(row[k] ?? '')}</td>`)}</tr>`)
        : html`<tr><td colspan="${r.columns.length + 1}" class="empty">${error ? 'The report failed.' : 'Nothing found.'}</td></tr>`}</tbody></table></div>`;
    const main = html`<h1 class="u-mb1">SQL Workshop</h1>${workshopTabs('utilities', s)}
      <div class="ab-home"><div class="ab-main">
        ${region(r.title, html`<p class="muted u-mt0">${r.about} Over the schemas ${workshopRunsAs(db)} may use.</p>
          ${error ? html`<div class="alert alert-error" role="alert">${error}</div>` : ''}${table}`)}
      </div><aside class="ab-side" aria-label="Object reports"><section><h2>Object Reports</h2>${nav}</section></aside></div>`;
    return send(reply, s, shell(s, r.title, crumbs('Object Reports'), main, 'sql'));
  });

  app.get(`${BASE}/sql/utilities/about`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const db = await workshopDb(s);
    const info = await readOnly(db, async (q) => ({
      server: (await q(`select version() as version, current_database() as database, current_user as "user", session_user as login,
                               pg_size_pretty(pg_database_size(current_database())) as size,
                               (select setting from pg_settings where name = 'server_version') as server_version,
                               pg_postmaster_start_time() as started`))[0],
      settings: await q(`select name, setting, unit, short_desc from pg_settings
                          where name in ('server_encoding', 'lc_collate', 'TimeZone', 'max_connections', 'shared_buffers', 'work_mem',
                                         'maintenance_work_mem', 'effective_cache_size', 'statement_timeout', 'default_transaction_isolation',
                                         'row_security', 'shared_preload_libraries', 'wal_level', 'max_wal_size')
                          order by lower(name)`),
      extensions: await q(`select e.extname as name, e.extversion as version, n.nspname as schema, a.comment
                             from pg_extension e join pg_namespace n on n.oid = e.extnamespace
                             left join pg_available_extensions a on a.name = e.extname order by 1`),
      schemas: await q(`select n.nspname as schema, n.nspowner::regrole::text as owner,
                               count(c.oid) filter (where c.relkind in ('r', 'p'))::int as tables,
                               pg_size_pretty(coalesce(sum(pg_total_relation_size(c.oid)) filter (where c.relkind in ('r', 'p', 'm')), 0)::bigint) as size
                          from pg_namespace n left join pg_class c on c.relnamespace = n.oid
                         where ${USABLE} group by 1, 2 order by 1`),
    }));
    const sv = info.server as Record<string, string>;
    const main = html`<h1 class="u-mb1">SQL Workshop</h1>${workshopTabs('utilities', s)}
      <div class="stat-grid u-mb1">
        ${[['PostgreSQL', sv.server_version], ['Database', sv.database], ['Size', sv.size], ['Running since', new Date(sv.started).toISOString().slice(0, 16).replace('T', ' ') + ' UTC']]
          .map(([l, v]) => html`<div class="stat"><b class="u-break">${v}</b><span>${l}</span></div>`)}
      </div>
      <p class="muted">${sv.version}. The SQL Workshop runs as <code>${sv.user}</code> (signed in as <code>${sv.login}</code>).</p>
      <div class="columns">
        ${region('Settings', html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>Setting</th><th>Value</th></tr></thead>
          <tbody>${info.settings.map((x) => html`<tr><td data-label="Setting" title="${String(x.short_desc ?? '')}"><code>${String(x.name)}</code></td>
            <td data-label="Value" class="u-break">${String(x.setting ?? '')}${x.unit ? ` ${x.unit}` : ''}</td></tr>`)}</tbody></table></div>`)}
        ${region('Extensions', html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>Extension</th><th>Version</th><th>Schema</th></tr></thead>
          <tbody>${info.extensions.map((x) => html`<tr><td data-label="Extension" class="u-break"><strong>${String(x.name)}</strong>${x.comment ? html` <span class="muted">${String(x.comment)}</span>` : ''}</td>
            <td data-label="Version">${String(x.version)}</td><td data-label="Schema">${String(x.schema)}</td></tr>`)}</tbody></table></div>`)}
      </div>
      <div class="u-spacer"></div>
      ${region('Schemas', html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>Schema</th><th>Owner</th><th class="num">Tables</th><th class="num">Size</th></tr></thead>
        <tbody>${info.schemas.length ? info.schemas.map((x) => html`<tr><td data-label="Schema">${String(x.schema)}</td><td data-label="Owner"><code>${String(x.owner)}</code></td>
          <td class="num" data-label="Tables">${String(x.tables)}</td><td class="num" data-label="Size">${String(x.size)}</td></tr>`)
          : html`<tr><td colspan="4" class="empty">No schemas.</td></tr>`}</tbody></table></div>`)}`;
    return send(reply, s, shell(s, 'About Database', crumbs('About Database'), main, 'sql'));
  });

  // (sprint 102) the Database Monitor became SQL Workshop › SQL Monitor (sql-monitor.ts)
  app.get(`${BASE}/sql/utilities/monitor`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    if (!(await isAdmin(s.username))) return reply.code(403).send('Administrators only.');
    return reply.redirect(`${BASE}/sql/monitor`, 301);
  });
}
