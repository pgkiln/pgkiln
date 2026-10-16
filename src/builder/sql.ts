import type { FastifyInstance, FastifyReply } from 'fastify';
import pg from 'pg';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { back, BASE, csrf, developer, flash, region, send, shell, workshopTabs, type Req } from './ui.ts';
import { owner } from '../db.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import { clearCompletions } from './code-editor.ts';
import { scriptRoutes } from './scripts.ts';
import { worksheetRoutes } from './worksheet.ts';
import { launchpad, launchpadRoutes } from './launchpad.ts';
import { sqlChartRoutes } from './sql-charts.ts';
import { isAdmin } from './locks.ts';
import { quickSqlRoutes } from './quicksql.ts';
import { queryBuilderRoutes } from './querybuilder.ts';
import { unloadRoutes } from './unload.ts';
import { ddlToolRoutes } from './ddl-tools.ts';
import { sqlUtilityRoutes } from './sql-utilities.ts';
import { createTemplate, objectBrowserRoutes } from './object-browser.ts';
import { objectActionRoutes } from './object-actions.ts';
import { tableEditorRoutes } from './table-editor.ts';
import { dataModelerRoutes } from './data-modeler.ts';
import { autoRestBuilderRoutes } from './autorest.ts';
import { changeLogRoutes } from './changelog.ts';
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
  const list = (title: string | Raw, rows: Raw[], empty: string) =>
    html`<section class="sw-recent"><h2>${title}</h2>${rows.length ? html`<ul>${rows}</ul>` : html`<p class="muted">${empty}</p>`}</section>`;
  const main = html`<div class="ab-home">
    <div class="ab-main">
      <h1 class="sr-only">SQL Workshop</h1>
      ${workshopTabs('home')}
      ${await launchpad(s, await isAdmin(s.username))}
      <div class="sw-recents">
        ${list('Recently created tables', tables.rows.map((t) => html`<li><a href="${BASE}/sql/objects?o=${encodeURIComponent(t.qname)}">${t.qname}</a><span class="muted">~${Number(t.rows).toLocaleString('en')} rows</span></li>`), 'No tables you can read.')}
        ${list(html`<a href="${BASE}/sql/worksheet?tab=history" title="Open SQL History">Recent SQL commands</a>`, commands.rows.map((c) => html`<li><a href="${BASE}/sql/worksheet?recent=${c.id}" title="${c.detail.slice(0, 500)}">${c.detail.replace(/\s+/g, ' ').slice(0, 60)}</a><span class="muted">${ago(c.at)}</span></li>`), 'You haven\'t run SQL commands yet.')}
        ${list('Recent SQL scripts', scripts.rows.map((x) => html`<li><a href="${BASE}/sql/scripts/${x.id}">${x.name}</a><span class="muted">${ago(x.updated_at)}</span></li>`), 'No scripts in this workspace yet.')}
      </div>
    </div>
    <aside class="ab-side" aria-label="About, schema and tasks">
      <section><h2>About</h2><p>The SQL Workshop is a collection of tools to manage database objects. It runs as ${workshopRunsAs(db)}.</p>
        <a href="https://github.com/pgkiln/pgkiln/blob/main/docs/guide/03-builder.md#sql-workshop" target="_blank" rel="noopener">Learn more …</a></section>
      <section><h2>Schema</h2><p>The default schema of this session: first in the search path of the SQL Worksheet and SQL Scripts.</p>
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
  // (sprint 97) Charts: saved charts and their dashboard
  await app.register(sqlChartRoutes);
  // (sprint 96) the Launchpad's pins and the builder's search (Ctrl+K)
  await app.register(launchpadRoutes);
  // (sprint 91) the SQL Worksheet (was SQL Commands; /sql/commands and a post to /sql are the same page)
  await app.register(worksheetRoutes);
  app.get(`${BASE}/sql`, workshopHome);

  // (sprint 61) the session's default schema: first in the search path of the SQL Worksheet and SQL Scripts
  app.post(`${BASE}/sql/schema`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const wanted = String(req.body?.schema ?? '');
    const usable = await usableSchemas(await workshopDb(s));
    if (wanted && !usable.includes(wanted)) return reply.code(404).send('Not found');
    if (wanted) s.state.__SQLSCHEMA = wanted;
    else delete s.state.__SQLSCHEMA;
    flash(s, wanted ? `Schema ${wanted} first in the search path of the SQL Worksheet and SQL Scripts.` : 'The default search path again.');
    return back(reply, s, `${BASE}/sql`);
  });

  // (sprint 75) the Object Browser: object-browser.ts
  await app.register(objectBrowserRoutes);
  // (sprint 94) an object's menu: Quick DDL, Drop, Add index / trigger / policy, Open in a panel
  await app.register(objectActionRoutes);
  // (sprint 95) Table Properties: create, edit or copy a table in a form
  await app.register(tableEditorRoutes);
  // (sprint 98) the Data Modeler: relational diagrams, their DDL and data dictionary
  await app.register(dataModelerRoutes);
  // (sprint 100) RESTful Services: AutoREST (autorest.ts)
  await app.register(autoRestBuilderRoutes);
  // (sprint 106) the change log (changelog.ts)
  await app.register(changeLogRoutes);
}
