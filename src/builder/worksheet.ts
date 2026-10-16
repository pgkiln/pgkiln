import type { FastifyInstance, FastifyReply } from 'fastify';
import pg from 'pg';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { owner } from '../db.ts';
import { devDbForApp } from '../workspace-db.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import { bicon, BASE, csrf, developer, send, shell, workshopTabs, type Req } from './ui.ts';
import { clearCompletions } from './code-editor.ts';
import { createTemplate, listObjects, OB_TYPES, pickSchema, SYSTEM_SCHEMAS, type Obj } from './object-browser.ts';
import { currentWorkspace, inWorkspaceSql, sessionSchema, usableSchemas, workshopDb, workshopRunsAs } from './workspaces.ts';
import { explainStatement, pickStatements, runStatements, textTable, type RunMode, type WorksheetRun } from '../sqlworksheet.ts';

// (sprint 91, Database Actions DA-1/DA-2) The SQL Worksheet: one screen with a navigator (schema, object
// type, filter; tables and views open to their columns and give SELECT / INSERT / UPDATE / DELETE
// statements, by drag and drop too), the editor with a toolbar, and output tabs: Query Result, Script
// Output, Notices, Explain Plan, Autotrace and SQL History, over a status bar. Run Statement (Ctrl+Enter)
// runs the statement at the cursor or the selection, Run Script (F5) all of them with a log per statement,
// Explain Plan (F10) plans it and Autotrace (F6) runs it with EXPLAIN ANALYZE in a transaction that is
// rolled back. Everything is one form: without JavaScript the buttons post it and the panes stack (Run
// Statement then runs everything, as SQL Commands did). Runs use the workshop's connection (an isolated
// workspace's developer login for its developers), or, with "Run as", an application's database role so
// row level security applies. /sql/commands (and a post to /sql) is the same page.

const NAV_TYPES: [string, string][] = [['all', 'All Objects'], ...OB_TYPES.map(([t, label]) => [t, label] as [string, string]), ['policy', 'Policies']];
const MODES: RunMode[] = ['statement', 'script', 'explain', 'autotrace'];
const TABS = [
  ['result', 'Query Result'], ['output', 'Script Output'], ['notices', 'Notices'], ['explain', 'Explain Plan'], ['autotrace', 'Autotrace'], ['history', 'SQL History'],
] as const;
type Tab = (typeof TABS)[number][0];

/** An identifier as SQL writes it: quoted only when it has to be. */
const ident = (n: string) => (/^[a-z_][a-z0-9_$]*$/.test(n) && !RESERVED.has(n) ? n : pg.escapeIdentifier(n));
const RESERVED = new Set(['all', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc', 'case', 'cast', 'check', 'collate', 'column', 'constraint', 'create', 'default', 'desc', 'distinct', 'do', 'else', 'end', 'except', 'false', 'for', 'foreign', 'from', 'grant', 'group', 'having', 'in', 'into', 'limit', 'not', 'null', 'offset', 'on', 'only', 'or', 'order', 'primary', 'references', 'select', 'table', 'then', 'to', 'true', 'union', 'unique', 'user', 'using', 'when', 'where', 'with']);

interface Column { name: string; type: string; notnull: boolean; pk: boolean }

/** The statements the navigator offers for a table or view (SELECT for a view or materialized view only). */
export function objectStatements(schema: string, name: string, cols: Column[], kind: string) {
  const q = `${ident(schema)}.${ident(name)}`;
  const names = cols.map((c) => ident(c.name));
  const select = `select ${names.length ? names.join(',\n       ') : '*'}\n  from ${q}`;
  if (kind !== 'table') return { select };
  const keys = cols.filter((c) => c.pk);
  const where = (keys.length ? keys : cols.slice(0, 1)).map((c) => `${ident(c.name)} = null`).join('\n   and ');
  const editable = cols.filter((c) => !c.pk);
  return {
    select,
    insert: `insert into ${q} (${names.join(', ')})\nvalues (${cols.map(() => 'null').join(', ')})`,
    update: `update ${q}\n   set ${(editable.length ? editable : cols).map((c) => `${ident(c.name)} = null`).join(',\n       ')}\n where ${where}`,
    delete: `delete from ${q}\n where ${where}`,
  };
}

const MAX_COLUMN_OBJECTS = 400;

/** The navigator's tree for a schema and an object type. */
async function navigatorTree(db: Awaited<ReturnType<typeof workshopDb>>, schema: string, type: string): Promise<Raw> {
  if (!schema) return html`<p class="muted ws-nav-empty">No schema you may use.</p>`;
  let objects: (Obj | { type: 'policy'; name: string; ref: string; rls: false; ext: false })[] = await listObjects(db, schema, false);
  if (type === 'all' || type === 'policy') {
    const pol = (await db.query<{ name: string; ref: string }>(
      `select p.polname || ' on ' || c.relname as name, c.oid::regclass::text as ref
         from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 order by 1`, [schema])).rows;
    objects = [...objects, ...pol.map((p) => ({ type: 'policy' as const, name: p.name, ref: p.ref, rls: false as const, ext: false as const }))];
  }
  if (type !== 'all') objects = objects.filter((o) => o.type === type);
  const rels = objects.filter((o) => o.type === 'table' || o.type === 'view' || o.type === 'matview').slice(0, MAX_COLUMN_OBJECTS);
  const cols = new Map<string, Column[]>();
  if (rels.length) {
    const rows = (await db.query<Column & { ref: string }>(
      `select c.oid::regclass::text as ref, a.attname as name, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as notnull,
              exists (select 1 from pg_constraint k where k.conrelid = c.oid and k.contype = 'p' and a.attnum = any (k.conkey)) as pk
         from pg_class c join pg_attribute a on a.attrelid = c.oid
        where c.oid::regclass::text = any ($1) and a.attnum > 0 and not a.attisdropped
        order by c.oid, a.attnum`, [rels.map((o) => o.ref)])).rows;
    for (const r of rows) cols.set(r.ref, [...(cols.get(r.ref) ?? []), r]);
  }
  const iconOf = (t: string) => (OB_TYPES.find(([k]) => k === t)?.[2] ?? 'shield');
  const label = (t: string) => NAV_TYPES.find(([k]) => k === t)?.[1] ?? t;
  if (!objects.length) return html`<p class="muted ws-nav-empty">No ${type === 'all' ? 'objects' : label(type).toLowerCase()} in ${schema}.</p>`;
  return html`<ul class="ws-tree" id="ws-tree">${objects.map((o) => {
    const list = cols.get(o.ref);
    const obLink = `${BASE}/sql/objects?${new URLSearchParams(o.type === 'policy' ? { schema, k: 'table', o: o.ref, tab: 'rls' } : { schema, k: o.type, o: o.ref })}`;
    if (!list) return html`<li class="ws-obj" data-name="${o.name.toLowerCase()}"><a href="${obLink}" title="${label(o.type)}">${icon(iconOf(o.type))}<span>${o.name}</span></a></li>`;
    const st = objectStatements(schema, o.name, list, o.type);
    return html`<li class="ws-obj" data-name="${o.name.toLowerCase()}"><details>
      <summary draggable="true" data-ws-sql="${st.select}" title="${label(o.type).replace(/s$/, '')}: drag into the editor for a SELECT">${icon(iconOf(o.type))}<span>${o.name}</span>${o.rls ? html`<span class="tag">RLS</span>` : ''}</summary>
      <ul class="ws-cols">${list.map((c) => html`<li title="${c.type}${c.notnull ? ' not null' : ''}">${c.pk ? icon('key') : icon('minus')}<span>${c.name}</span><small class="muted">${c.type}</small></li>`)}</ul>
      <div class="ws-obj-actions">
        ${Object.entries(st).map(([k, sql]) => html`<button type="button" class="btn btn-sm" data-ws-insert="${sql}" hidden>${k.toUpperCase()}</button>`)}
        <a class="btn btn-sm" href="${obLink}">Open</a>
      </div>
    </details></li>`;
  })}</ul>${objects.length > rels.length && rels.length === MAX_COLUMN_OBJECTS ? html`<p class="muted small ws-nav-empty">Columns are listed for the first ${MAX_COLUMN_OBJECTS} tables and views.</p>` : ''}`;
}

/** The output panes of a run (empty: the page as opened). */
function outputPanes(run: WorksheetRun | null, mode: RunMode | null, history: { id: string; detail: string; at: string }[]): { panes: Record<Tab, Raw>; active: Tab; status: Raw } {
  const results = run?.results ?? [];
  const ran = results.filter((r) => r.status !== 'not_run');
  const query = [...ran].reverse().find((r) => r.columns);
  const errors = ran.filter((r) => r.status === 'error');
  const warnings = run?.notices.filter((n) => n.level === 'WARNING').length ?? 0;
  const oneLine = (sql: string) => { const x = sql.replace(/\s+/g, ' '); return x.length > 80 ? `${x.slice(0, 79)}…` : x; };

  const result: Raw = query
    ? html`<p class="muted small ws-info">${query.rows ?? query.data!.length} row${query.rows === 1 ? '' : 's'} · ${query.ms} ms${query.more ? html` · showing the first ${query.data!.length}` : ''} · line ${query.line}</p>
      <div class="table-wrap ws-grid"><table class="report"><thead><tr><th scope="col" class="ws-rownum">#</th>${query.columns!.map((c) => html`<th scope="col">${c}</th>`)}</tr></thead>
      <tbody>${query.data!.map((r, k) => html`<tr><td class="ws-rownum">${k + 1}</td>${r.map((v) => html`<td>${v === null ? html`<span class="null">(null)</span>` : v}</td>`)}</tr>`)}</tbody></table></div>`
    : run && mode !== 'explain' && mode !== 'autotrace'
      ? html`<p class="muted">${errors.length ? 'The statement failed: see Script Output.' : 'No rows: the last statement was not a query. See Script Output.'}</p>`
      : html`<p class="muted">Run a query (Ctrl+Enter) to see its rows here.</p>`;

  const log = run
    ? html`<pre class="ws-log">${results.map((r) => {
        if (r.status === 'not_run') return html`<span class="muted">-- ${r.n}. line ${r.line}: not run (an earlier statement failed)\n</span>`;
        const head = html`<span class="ws-log-sql">-- ${r.n}. line ${r.line}: ${oneLine(r.sql)}</span>\n`;
        if (r.status === 'skipped') return html`${head}<span class="ws-log-warn">${r.error}</span>\n\n`;
        if (r.status === 'error') return html`${head}<span class="ws-log-err">Error${r.errorLine ? ` at line ${r.errorLine}${r.errorColumn ? `, column ${r.errorColumn}` : ''}` : ''}: ${r.error}</span>\n\n`;
        const body = r.columns ? `${textTable(r.columns, r.data ?? [])}\n${r.more ? `(first ${r.data!.length} of ${r.rows} rows)\n` : ''}` : '';
        const notes = run.notices.filter((n) => n.n === r.n).map((n) => `${n.level}: ${n.message}\n`).join('');
        return html`${head}${body}${notes}<span class="ws-log-ok">${r.tag}</span> <span class="muted">(${r.ms} ms)</span>\n\n`;
      })}<span class="muted">${ran.length} statement${ran.length === 1 ? '' : 's'} run, ${errors.length} failed, ${run.ms} ms.</span></pre>`
    : html`<p class="muted">Run Script (F5) runs every statement and logs each one here.</p>`;

  const notices = run?.notices.length
    ? html`<ul class="ws-notices">${run.notices.map((n) => html`<li><span class="tag${n.level === 'WARNING' ? ' tag-warn' : ''}">${n.level}</span> <span>${n.message}</span> <small class="muted">statement ${n.n}</small></li>`)}</ul>`
    : html`<p class="muted">RAISE NOTICE, INFO and WARNING messages of the last run show here.</p>`;

  const planOf = (m: RunMode, empty: string) => mode === m && run
    ? (run.plan ? html`<pre class="ws-log ws-plan">${run.plan}</pre>` : html`<p class="alert alert-error">${run.results[0]?.error ?? 'No plan.'}</p>`)
    : html`<p class="muted">${empty}</p>`;

  const hist = history.length
    ? html`<ul class="ws-history">${history.map((h) => html`<li><a href="${BASE}/sql/worksheet?recent=${h.id}" data-ws-history="${h.detail}" title="${h.detail.slice(0, 500)}"><code>${oneLine(h.detail)}</code></a><small class="muted">${new Date(h.at).toISOString().slice(0, 16).replace('T', ' ')}</small></li>`)}</ul>`
    : html`<p class="muted">Your statements show here after you run them.</p>`;

  const active: Tab = !run ? 'result' : mode === 'explain' ? 'explain' : mode === 'autotrace' ? 'autotrace' : mode === 'script' || !query || errors.length ? 'output' : 'result';
  const time = new Date().toTimeString().slice(0, 8);
  const last = !run ? 'Ready.' : errors.length
    ? `Error${errors[0].errorLine ? ` at line ${errors[0].errorLine}` : ''}: ${errors[0].error}`
    : mode === 'explain' || mode === 'autotrace' ? `${mode === 'explain' ? 'Explain plan' : 'Autotrace'} in ${run.ms} ms.`
      : query && ran.length === 1 ? `${query.rows} row${query.rows === 1 ? '' : 's'} in ${query.ms} ms.`
        : `${ran.length} statement${ran.length === 1 ? '' : 's'} in ${run.ms} ms.`;
  const status = html`<span class="ws-count ${errors.length ? 'is-err' : ''}" title="Errors">${icon('x-circle')} ${errors.length}</span>
    <span class="ws-count ${warnings ? 'is-warn' : ''}" title="Warnings">${icon('alert')} ${warnings}</span>
    <span class="ws-busy" hidden>${icon('refresh')} Running…</span>
    <span class="ws-last">${last}</span><span class="muted ws-time">${run ? time : ''}</span>`;
  return { panes: { result, output: log, notices, explain: planOf('explain', 'Explain Plan (F10) shows how PostgreSQL would run the statement at the cursor; nothing runs.'), autotrace: planOf('autotrace', 'Autotrace (F6) runs the statement at the cursor with EXPLAIN ANALYZE and rolls it back: actual rows, time and buffers per step.'), history: hist }, active, status };
}

/** The applications whose database role a run can take (the developer's workspace). */
async function runAsApps(s: Session) {
  return (await owner.query<{ id: number; name: string; db_role: string }>(
    `select a.id, a.name, a.db_role from meta.app a where ${inWorkspaceSql('a', 1)} and a.db_role is not null order by a.name, a.id`, [currentWorkspace(s)])).rows;
}

async function worksheet(req: Req, reply: FastifyReply) {
  const s = await developer(req, reply);
  if (!s) return;
  const db = await workshopDb(s);
  const body = req.body ?? {};
  const isPost = req.method === 'POST';
  // a browser posts line breaks as CRLF; the cursor's offsets count LF
  let text: string = isPost ? String(body.sql ?? '').replace(/\r\n?/g, '\n') : '';
  if (!isPost) {
    // a command from SQL History or the home page's Recent SQL Commands (the developer's own)
    if (/^\d{1,18}$/.test(String(req.query?.recent ?? ''))) {
      const r = await owner.one<{ detail: string }>(`select detail from meta.activity_log where id = $1 and username = $2 and event = 'sql_command'`, [req.query!.recent, s.username]);
      if (r) text = r.detail;
    }
  }
  const [schemas, searchSchema, apps] = await Promise.all([usableSchemas(db), sessionSchema(s, db), runAsApps(s)]);
  if (!isPost) {
    // (sprint 75) a statement to review: from the Object Browser's column actions, or a CREATE template
    if (typeof s.state.__SQLDRAFT === 'string') {
      text = s.state.__SQLDRAFT;
      delete s.state.__SQLDRAFT;
    } else if (typeof req.query?.template === 'string') {
      const into = typeof req.query.schema === 'string' && schemas.includes(req.query.schema) ? req.query.schema : (searchSchema ?? 'public');
      text = createTemplate(req.query.template, into) ?? text;
    }
  }
  // the navigator: schema and object type
  const navSchemas = schemas.filter((n) => !SYSTEM_SCHEMAS.includes(n));
  const navSchema = await pickSchema(s, db, navSchemas, isPost ? body.nav_schema : req.query?.schema);
  const navType = NAV_TYPES.some(([k]) => k === (isPost ? body.nav_type : req.query?.type)) ? String(isPost ? body.nav_type : req.query?.type) : 'all';
  const asApp = isPost && /^\d{1,9}$/.test(String(body.as_app ?? '')) ? apps.find((a) => String(a.id) === String(body.as_app)) : undefined;
  if (isPost && body.as_app && !asApp) return reply.code(404).send('Not found');

  let run: WorksheetRun | null = null;
  let mode: RunMode | null = null;
  let ran: { start: number; end: number } | null = null;
  const continueOnError = body.continue_on_error === 'on';
  if (isPost && text.trim() && body.mode !== 'nav') {
    const m: RunMode = MODES.find((x) => x === body.mode) ?? 'statement';
    mode = m;
    const sel = /^\d{1,9}$/.test(String(body.sel_start ?? '')) && /^\d{1,9}$/.test(String(body.sel_end ?? '')) ? { start: Number(body.sel_start), end: Number(body.sel_end) } : undefined;
    const statements = pickStatements(text, m, sel);
    if (statements.length) {
      ran = { start: statements[0].start, end: statements[statements.length - 1].end };
      // a connection of its own, closed afterwards: the SQL may SET ROLE or change settings, which must not
      // leak into the builder's pooled connections
      const c = await (asApp ? await devDbForApp(asApp.id) : db).pool.connect();
      const started = performance.now();
      try {
        if (searchSchema) await c.query(`select set_config('search_path', $1, false)`, [`${pg.escapeIdentifier(searchSchema)}, public`]);
        if (asApp) {
          await c.query(`select set_config('pgkiln.app_id', $1, false)`, [String(asApp.id)]);
          await c.query(`set role ${pg.escapeIdentifier(asApp.db_role)}`);
        }
        run = m === 'explain' || m === 'autotrace'
          ? await explainStatement(c, statements[0], m === 'autotrace')
          : await runStatements(c, text, statements, { continueOnError: m === 'script' && continueOnError });
      } catch (e) {
        run = { results: [{ n: 1, line: statements[0].line, sql: statements[0].sql, start: 0, end: 0, status: 'error', error: (e as Error).message, ms: 0 }], notices: [], failed: 1, ms: 0 };
      } finally {
        c.release(true);
      }
      if (mode === 'statement' || mode === 'script') {
        clearCompletions(); // the statements may have changed tables or grants
        const detail = statements.map((x) => x.sql).join(';\n');
        await logActivity({ username: s.username, event: 'sql_command', ip: clientIp(req), elapsedMs: Math.round(performance.now() - started), detail: detail.length > 2000 ? `${detail.slice(0, 2000)}…` : detail });
      }
    }
  }
  const history = (await owner.query<{ id: string; detail: string; at: string }>(
    `select id, detail, at from meta.activity_log where username = $1 and event = 'sql_command' order by id desc limit 50`, [s.username])).rows;
  const { panes, active, status } = outputPanes(run, mode, history);
  const firstError = run?.results.find((r) => r.status === 'error');
  const runsAs = asApp ? `the role ${asApp.db_role} of ${asApp.name}` : workshopRunsAs(db);

  const toolBtn = (m: RunMode, ic: string, label: string, key: string, hot = false) =>
    html`<button class="btn btn-sm${hot ? ' btn-hot' : ''}" name="mode" value="${m}" title="${label} (${key})" data-ws-key="${key}">${icon(ic)}<span>${label}</span></button>`;
  const main = html`<div class="ws-page">
    <h1 class="sr-only">SQL Worksheet</h1>
    ${workshopTabs('sql')}
    <form method="post" action="${BASE}/sql/worksheet" class="ws" id="ws" data-ran="${ran ? `${ran.start},${ran.end}` : ''}" data-error-line="${firstError?.errorLine ?? ''}">${csrf(s)}
      <button class="ws-default" name="mode" value="nav" tabindex="-1">Refresh the navigator</button>
      <input type="hidden" name="sel_start" value=""><input type="hidden" name="sel_end" value="">
      <aside class="ws-nav" id="ws-nav" aria-label="Navigator">
        <div class="ws-nav-head">
          <label class="sr-only" for="ws-schema">Schema</label>
          <select id="ws-schema" name="nav_schema" data-ws-nav>${navSchemas.map((n) => html`<option value="${n}"${n === navSchema ? raw(' selected') : ''}>${n}</option>`)}</select>
          <label class="sr-only" for="ws-type">Object type</label>
          <select id="ws-type" name="nav_type" data-ws-nav>${NAV_TYPES.map(([k, label]) => html`<option value="${k}"${k === navType ? raw(' selected') : ''}>${label}</option>`)}</select>
          <div class="ws-nav-search">
            <label class="sr-only" for="ws-filter">Search objects</label>
            <input id="ws-filter" type="search" placeholder="Search" autocomplete="off" data-ws-filter>
            <button class="btn btn-sm btn-icon" name="mode" value="nav" title="Refresh">${icon('refresh')}<span class="sr-only">Refresh</span></button>
          </div>
        </div>
        <div class="ws-nav-body" id="ws-nav-body">${await navigatorTree(db, navSchema, navType)}</div>
      </aside>
      <div class="ws-split ws-split-v" role="separator" aria-orientation="vertical" aria-label="Resize the navigator" tabindex="0" data-ws-split="nav" hidden></div>
      <section class="ws-main" aria-label="Worksheet">
        <div class="ws-toolbar" role="toolbar" aria-label="Worksheet">
          <button type="button" class="btn btn-sm btn-icon" data-ws-toggle-nav title="Hide or show the navigator" hidden>${bicon('left')}<span class="sr-only">Navigator</span></button>
          ${toolBtn('statement', 'play', 'Run Statement', 'Ctrl+Enter', true)}
          ${toolBtn('script', 'file', 'Run Script', 'F5')}
          ${toolBtn('explain', 'route', 'Explain Plan', 'F10')}
          ${toolBtn('autotrace', 'activity', 'Autotrace', 'F6')}
          <label class="ws-check"><input type="checkbox" name="continue_on_error"${continueOnError ? raw(' checked') : ''}> Continue on error</label>
          <span class="ws-spacer"></span>
          <label class="ws-runas"><span>Run as</span>
            <select name="as_app" title="Who the statements run as">
              <option value="">${db === owner ? 'Owner connection' : 'Workspace login'}</option>
              ${apps.map((a) => html`<option value="${a.id}"${asApp?.id === a.id ? raw(' selected') : ''}>${a.name} (${a.db_role})</option>`)}
            </select></label>
          <button type="button" class="btn btn-sm btn-icon" data-ws-clear title="Clear the editor" hidden>${icon('trash')}<span class="sr-only">Clear</span></button>
          <button type="button" class="btn btn-sm btn-icon" data-ws-fullscreen title="Fullscreen (Escape leaves)" aria-pressed="false" hidden>${bicon('expand')}<span class="sr-only">Fullscreen</span></button>
        </div>
        <p class="ws-runs-as muted small">Runs as ${runsAs}${searchSchema ? html`; <code>${searchSchema}</code> first in the search path (<a href="${BASE}/sql">change</a>)` : ''}. Each statement commits on its own.</p>
        <div class="ws-editor">
          <textarea id="ws-sql" name="sql" aria-label="SQL" class="code sql-editor" rows="14" spellcheck="false" data-code="plpgsql">${text || (isPost ? '' : 'select current_user, version();')}</textarea>
        </div>
        <div class="ws-split ws-split-h" role="separator" aria-orientation="horizontal" aria-label="Resize the output" tabindex="0" data-ws-split="out" hidden></div>
        <div class="ws-output" data-active="${active}">
          <div class="ws-tabs" role="tablist" aria-label="Output">${TABS.map(([k, label]) => html`<button type="button" role="tab" id="ws-tab-${k}" aria-controls="ws-pane-${k}" aria-selected="${k === active ? 'true' : 'false'}" data-ws-tab="${k}">${label}</button>`)}</div>
          ${TABS.map(([k, label]) => html`<section class="ws-pane" id="ws-pane-${k}" role="tabpanel" aria-labelledby="ws-tab-${k}" data-pane="${k}"><h2 class="ws-pane-title">${label}</h2>${panes[k]}</section>`)}
        </div>
      </section>
      <footer class="ws-status" role="status" aria-live="polite">${status}</footer>
    </form>
  </div>`;
  return send(reply, s, shell(s, 'SQL Worksheet', [['SQL Workshop', `${BASE}/sql`], ['SQL Worksheet']], main, 'sql', { full: true }));
}

export async function worksheetRoutes(app: FastifyInstance) {
  for (const path of ['/sql/worksheet', '/sql/commands']) {
    app.get(`${BASE}${path}`, worksheet);
    app.post(`${BASE}${path}`, worksheet);
  }
  // (before sprint 61 SQL Commands was /builder/sql: a post there still runs)
  app.post(`${BASE}/sql`, worksheet);

  // the navigator for another schema or object type (the page swaps it in without a reload)
  app.get(`${BASE}/sql/worksheet/navigator`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const db = await workshopDb(s);
    const schemas = (await usableSchemas(db)).filter((n) => !SYSTEM_SCHEMAS.includes(n));
    if (req.query?.schema && !schemas.includes(String(req.query.schema))) return reply.code(404).send('Not found');
    const schema = await pickSchema(s, db, schemas, req.query?.schema);
    const type = NAV_TYPES.some(([k]) => k === req.query?.type) ? String(req.query!.type) : 'all';
    return reply.header('Cache-Control', 'private, no-store').type('text/html').send(String(await navigatorTree(db, schema, type)));
  });
}
