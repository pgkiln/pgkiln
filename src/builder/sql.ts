import type { FastifyInstance, FastifyReply } from 'fastify';
import pg from 'pg';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { back, BASE, csrf, developer, flash, region, send, shell, workshopTabs, type Req } from './ui.ts';
import { owner } from '../db.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import { clearCompletions } from './code-editor.ts';
import { scriptRoutes } from './scripts.ts';
import { quickSqlRoutes } from './quicksql.ts';
import { queryBuilderRoutes } from './querybuilder.ts';
import { unloadRoutes } from './unload.ts';
import { ddlToolRoutes } from './ddl-tools.ts';
import { sqlUtilityRoutes } from './sql-utilities.ts';
import { currentWorkspace, sessionSchema, usableSchemas, workshopDb, workshopRunsAs } from './workspaces.ts';

// SQL Workshop: SQL commands and the object browser (owner connection; an isolated
// workspace's developer login for its developers, see workshopDb).

const ago = (t: string | Date) => {
  const sec = Math.max(0, (Date.now() - new Date(t).getTime()) / 1000);
  const [n, unit] = sec < 60 ? [sec, 'second'] : sec < 3600 ? [sec / 60, 'minute'] : sec < 86400 ? [sec / 3600, 'hour'] : sec < 86400 * 30 ? [sec / 86400, 'day'] : sec < 86400 * 365 ? [sec / 86400 / 30, 'month'] : [sec / 86400 / 365, 'year'];
  const k = Math.floor(n);
  return `${k} ${unit}${k === 1 ? '' : 's'} ago`;
};

/** (sprint 61, APEX: the SQL Workshop home) tiles, the newest tables, recent commands and scripts, the session's schema. */
async function workshopHome(req: Req, reply: FastifyReply) {
  const s = await developer(req, reply);
  if (!s) return;
  const db = await workshopDb(s);
  const [schemas, schema, tables, commands, scripts] = await Promise.all([
    usableSchemas(db),
    sessionSchema(s, db),
    // PostgreSQL keeps no creation time: object ids grow, so the highest are the newest
    db.query<{ qname: string; schema: string; name: string; rows: number }>(
      `select c.oid::regclass::text as qname, n.nspname as schema, c.relname as name, greatest(c.reltuples, 0)::bigint as rows
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r', 'p') and not c.relispartition and n.nspname !~ '^pg_' and n.nspname not in ('information_schema', 'meta')
          and has_schema_privilege(n.oid, 'USAGE') and has_table_privilege(c.oid, 'SELECT')
          and not (n.nspname = 'public' and c.relname like 'pgkiln\\_%')
        order by c.oid desc limit 15`,
    ),
    owner.query<{ id: string; detail: string; at: string }>(
      `select id, detail, at from meta.activity_log where username = $1 and event = 'sql_command' order by id desc limit 15`,
      [s.username],
    ),
    owner.query<{ id: number; name: string; updated_at: string }>(
      `select id, name, updated_at from meta.sql_script where workspace_id = $1 order by updated_at desc limit 15`,
      [currentWorkspace(s)],
    ),
  ]);
  const tile = (href: string, ic: string, title: string, text: string) =>
    html`<a class="ab-tile sw-tile" href="${BASE}${href}"><span class="ab-tile-icon sw-tile-icon">${icon(ic)}</span><strong>${title}</strong><span>${text}</span></a>`;
  const list = (title: string, rows: Raw[], empty: string) =>
    html`<section class="sw-recent"><h2>${title}</h2>${rows.length ? html`<ul>${rows}</ul>` : html`<p class="muted">${empty}</p>`}</section>`;
  const main = html`<div class="ab-home">
    <div class="ab-main">
      <h1 class="sr-only">SQL Workshop</h1>
      ${workshopTabs('home')}
      <div class="ab-tiles sw-tiles">
        ${tile('/sql/objects', 'search', 'Object Browser', 'Browse tables, views and functions, their policies, grants and data.')}
        ${tile('/sql/commands', 'code', 'SQL Commands', 'Run SQL statements against your schemas.')}
        ${tile('/sql/scripts', 'file', 'SQL Scripts', 'Create, upload and run stored SQL scripts.')}
        ${tile('/sql/utilities', 'wrench', 'Utilities', 'Load and unload data, sample data, DDL, schema comparison, object reports and the database.')}
        ${tile('/sql/quick', 'bolt', 'Quick SQL', 'Write a data model in shorthand and get the DDL.')}
      </div>
      <div class="sw-recents">
        ${list('Recently created tables', tables.rows.map((t) => html`<li><a href="${BASE}/sql/objects?o=${encodeURIComponent(t.qname)}">${t.qname}</a><span class="muted">~${Number(t.rows).toLocaleString('en')} rows</span></li>`), 'No tables you can read.')}
        ${list('Recent SQL commands', commands.rows.map((c) => html`<li><a href="${BASE}/sql/commands?recent=${c.id}" title="${c.detail.slice(0, 500)}">${c.detail.replace(/\s+/g, ' ').slice(0, 60)}</a><span class="muted">${ago(c.at)}</span></li>`), 'You haven\'t run SQL commands yet.')}
        ${list('Recent SQL scripts', scripts.rows.map((x) => html`<li><a href="${BASE}/sql/scripts/${x.id}">${x.name}</a><span class="muted">${ago(x.updated_at)}</span></li>`), 'No scripts in this workspace yet.')}
      </div>
    </div>
    <aside class="ab-side" aria-label="About, schema and tasks">
      <section><h2>About</h2><p>The SQL Workshop is a collection of tools to manage database objects. It runs as ${workshopRunsAs(db)}.</p>
        <a href="https://github.com/pgkiln/pgkiln/blob/main/docs/guide/03-builder.md#sql-workshop" target="_blank" rel="noopener">Learn more …</a></section>
      <section><h2>Schema</h2><p>The default schema of this session: first in the search path of SQL Commands and SQL Scripts.</p>
        <form method="post" action="${BASE}/sql/schema" class="sw-schema">${csrf(s)}
          <label class="sr-only" for="f_schema">Schema</label>
          <select id="f_schema" name="schema" data-autosubmit><option value="">(the default search path)</option>${schemas.map((n) => html`<option value="${n}"${n === schema ? raw(' selected') : ''}>${n}</option>`)}</select>
          <button class="btn btn-sm">Set</button></form></section>
      <section><h2>Tasks</h2><ul class="ab-links ab-tasks">
        <li><a href="${BASE}/sql/quick">Create a data model with Quick SQL${icon('chevron')}</a></li>
        <li><a href="${BASE}/blueprints">Create an application from a blueprint${icon('chevron')}</a></li>
        <li><a href="${BASE}/sql/ai/describe">Describe tables${icon('chevron')}</a></li>
        <li><a href="${BASE}/sql/sample-data">Generate sample data${icon('chevron')}</a></li>
        <li><a href="${BASE}/sql/ddl">Generate DDL${icon('chevron')}</a></li>
      </ul></section>
    </aside>
  </div>`;
  return send(reply, s, shell(s, 'SQL Workshop', [['SQL Workshop']], main, 'sql'));
}

export async function sqlRoutes(app: FastifyInstance) {
  // SQL Scripts, Quick SQL and the query builder (sprint 31)
  await app.register(scriptRoutes);
  await app.register(quickSqlRoutes);
  await app.register(queryBuilderRoutes);
  // Unload Data (sprint 32)
  await app.register(unloadRoutes);
  // Generate DDL and Schema Comparison (sprint 56)
  await app.register(ddlToolRoutes);
  await app.register(sqlUtilityRoutes);
  // ---------------------------------------------------------------- SQL workshop
  const resultTable = (res: pg.QueryResult<any[]>, limit = 500) => {
    const rows = (res.rows ?? []).slice(0, limit);
    return html`<div class="table-wrap"><table class="report"><thead><tr>${res.fields.map((f) => html`<th>${f.name}</th>`)}</tr></thead>
      <tbody>${rows.map((r) => html`<tr>${r.map((v) => html`<td>${v === null ? html`<span class="null">null</span>` : typeof v === 'object' ? JSON.stringify(v) : String(v)}</td>`)}</tr>`)}</tbody></table></div>`;
  };

  const sqlWorkshop = async (req: Req, reply: FastifyReply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const sql = req.body?.sql ?? '';
    let result: Raw | '' = '';
    const db = await workshopDb(s);
    // (sprint 61) a command from the home page's Recent SQL Commands (the developer's own)
    let text = sql;
    if (req.method === 'GET' && /^\d{1,18}$/.test(String(req.query?.recent ?? ''))) {
      const r = await owner.one<{ detail: string }>(`select detail from meta.activity_log where id = $1 and username = $2 and event = 'sql_command'`, [req.query!.recent, s.username]);
      if (r) text = r.detail;
    }
    const schema = await sessionSchema(s, db);
    if (req.method === 'POST' && sql.trim()) {
      const started = performance.now();
      try {
        // a connection of its own, closed afterwards: the SQL may SET ROLE or change settings,
        // which must not leak into the builder's pooled owner connections
        const c = await db.pool.connect();
        let out;
        try {
          if (schema) await c.query(`select set_config('search_path', $1, false)`, [`${pg.escapeIdentifier(schema)}, public`]);
          out = await c.query({ text: sql, rowMode: 'array' });
        } finally {
          c.release(true);
        }
        const res = Array.isArray(out) ? out[out.length - 1] : out;
        const ms = (performance.now() - started).toFixed(0);
        result = res.fields?.length
          ? html`<p class="muted">${res.rowCount} row(s) in ${ms} ms${res.rows.length > 500 ? ' (showing 500)' : ''}</p>${resultTable(res)}`
          : html`<div class="alert alert-success">${res.command ?? 'Statement'} completed${res.rowCount !== null ? `, ${res.rowCount} row(s)` : ''} in ${ms} ms.</div>`;
      } catch (e) {
        result = html`<div class="alert alert-error"><strong>Error:</strong> ${(e as Error).message}</div>`;
      }
      clearCompletions(); // the script may have changed tables or grants
      await logActivity({ username: s.username, event: 'sql_command', ip: clientIp(req), elapsedMs: Math.round(performance.now() - started), detail: sql.length > 2000 ? `${sql.slice(0, 2000)}…` : sql });
    }
    const main = html`<h1 class="u-mb1">SQL Workshop</h1>${workshopTabs('sql')}
      <p class="muted">Runs as ${workshopRunsAs(db)} (not as an application role)${schema ? html`, schema <code>${schema}</code> first in the search path (<a href="${BASE}/sql">change</a>)` : ''}. Multiple statements are allowed; results of the last one are shown.</p>
      <form method="post" action="${BASE}/sql/commands">${csrf(s)}
        <textarea name="sql" class="code sql-editor" rows="12" spellcheck="false" aria-label="SQL" data-code="plpgsql">${text || 'select current_user, version();'}</textarea>
        <div class="buttons"><button class="btn btn-hot">${icon('play')} Run (Ctrl+Enter)</button></div>
      </form>
      <div class="u-mt1">${result}</div>`;
    return send(reply, s, shell(s, 'SQL Workshop', [['SQL Workshop']], main, 'sql'));
  };
  app.get(`${BASE}/sql/commands`, sqlWorkshop);
  app.post(`${BASE}/sql/commands`, sqlWorkshop);
  // (before sprint 61 SQL Commands was /builder/sql: a post there still runs)
  app.post(`${BASE}/sql`, sqlWorkshop);
  app.get(`${BASE}/sql`, workshopHome);

  // (sprint 61) the session's default schema: first in the search path of SQL Commands and SQL Scripts
  app.post(`${BASE}/sql/schema`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const wanted = String(req.body?.schema ?? '');
    const usable = await usableSchemas(await workshopDb(s));
    if (wanted && !usable.includes(wanted)) return reply.code(404).send('Not found');
    if (wanted) s.state.__SQLSCHEMA = wanted;
    else delete s.state.__SQLSCHEMA;
    flash(s, wanted ? `Schema ${wanted} first in the search path of SQL Commands and SQL Scripts.` : 'The default search path again.');
    return back(reply, s, `${BASE}/sql`);
  });

  app.get(`${BASE}/sql/objects`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const db = await workshopDb(s);
    const objects = (
      await db.query(
        `select n.nspname as schema, c.relname as name, c.oid::regclass::text as qname,
                case c.relkind when 'r' then 'table' when 'p' then 'table' when 'v' then 'view' when 'm' then 'view' end as kind,
                c.relrowsecurity as rls
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.relkind in ('r', 'p', 'v', 'm') and n.nspname !~ '^pg_' and n.nspname not in ('information_schema')
            and has_schema_privilege(n.oid, 'USAGE')
         union all
         select n.nspname, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', p.oid::regprocedure::text, 'function', false
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname !~ '^pg_' and n.nspname not in ('information_schema') and p.prokind in ('f', 'p')
            and has_schema_privilege(n.oid, 'USAGE')
          order by 1, 4 desc, 2`,
      )
    ).rows;
    const o = req.query.o;
    const selected = objects.find((x) => x.qname === o);
    let detail: Raw = html`<p class="muted">Select a table, view or function.</p>`;
    if (selected) {
      if (selected.kind === 'function') {
        const src = await db.one('select pg_get_functiondef($1::regprocedure) as def', [selected.qname]);
        detail = region(selected.qname, html`<pre class="source">${src.def}</pre>`);
      } else {
        const [cols, policies, grants, data] = await Promise.all([
          db.query(
            `select a.attname as column, format_type(a.atttypid, a.atttypmod) as type, not a.attnotnull as nullable,
                    pg_get_expr(d.adbin, d.adrelid) as "default"
               from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
              where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped order by a.attnum`,
            [selected.qname],
          ),
          db.query('select policyname as policy, cmd, roles::text, qual as using, with_check from pg_policies where schemaname = $1 and tablename = $2', [selected.schema, selected.name]),
          db.query(
            `select grantee, string_agg(privilege_type, ', ' order by privilege_type) as privileges
               from information_schema.role_table_grants where table_schema = $1 and table_name = $2 group by grantee order by grantee`,
            [selected.schema, selected.name],
          ),
          db.pool.query({ text: `select * from ${selected.qname} limit 25`, rowMode: 'array' }).catch((e) => e as Error),
        ]);
        const asArray = (r: pg.QueryResult) => ({ ...r, rows: r.rows.map((x) => Object.values(x)) }) as unknown as pg.QueryResult<any[]>;
        detail = html`${region(`${selected.kind === 'view' ? 'View' : 'Table'} ${selected.qname}`, resultTable(asArray(cols)),
            html`<span class="count">${selected.rls ? 'row level security ON' : 'no RLS'}</span>`)}
          <div class="u-spacer"></div>
          ${region('Row level security policies', policies.rowCount ? resultTable(asArray(policies)) : html`<p class="muted">No policies.</p>`)}
          <div class="u-spacer"></div>
          ${region('Grants', resultTable(asArray(grants)))}
          <div class="u-spacer"></div>
          ${region('Data (first 25 rows)', data instanceof Error ? html`<div class="alert alert-error">${data.message}</div>` : resultTable(data))}`;
      }
    }
    let lastSchema = '';
    const list = html`<ul class="tree">${objects.map((x) => {
      const header = x.schema !== lastSchema ? html`<li class="group">${(lastSchema = x.schema)}</li>` : '';
      return html`${header}<li><a href="?o=${encodeURIComponent(x.qname)}"${x.qname === o ? raw(' aria-current="page"') : ''}>${icon(x.kind === 'function' ? 'code' : x.kind === 'view' ? 'layers' : 'table')}<span>${x.name}</span>${x.rls ? html`<span class="tag">RLS</span>` : ''}</a></li>`;
    })}</ul>`;
    const main = html`<h1 class="u-mb1">SQL Workshop</h1>${workshopTabs('objects')}
      <div class="designer"><aside class="region region-standard" aria-label="Database objects">${list}</aside><div>${detail}</div></div>`;
    return send(reply, s, shell(s, 'Object Browser', [['SQL Workshop', `${BASE}/sql`], ['Object Browser']], main, 'sql'));
  });

}
