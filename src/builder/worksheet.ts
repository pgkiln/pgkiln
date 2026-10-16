import type { FastifyInstance, FastifyReply } from 'fastify';
import pg from 'pg';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { owner } from '../db.ts';
import { devDbForApp } from '../workspace-db.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import { back, bicon, BASE, csrf, developer, flash, send, shell, workshopTabs, type Req } from './ui.ts';
import { clearCompletions } from './code-editor.ts';
import { createTemplate, listObjects, OB_TYPES, pickSchema, SYSTEM_SCHEMAS, type Obj } from './object-browser.ts';
import { objectMenu } from './object-actions.ts';
import { currentWorkspace, inWorkspaceSql, sessionSchema, usableSchemas, workshopDb, workshopRunsAs } from './workspaces.ts';
import { applySubstitutions, explainStatement, pickStatements, runStatements, substitutionNames, textTable, type RunMode, type WorksheetRun } from '../sqlworksheet.ts';
import { applyBinds, bindNames } from '../binds.ts';
import { formatSql } from '../sqlformat.ts';
import type { Plan, PlanNode } from '../sqlplan.ts';
import { unloadStatement } from '../unload.ts';

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
/** (sprint 92) Rows of a query (the Query Result grid): normally, and with "All rows". */
const GRID_ROWS = 500;
const ALL_ROWS = 10_000;
/** (sprint 92) SQL History: rows kept per developer and workspace, and shown. */
const HISTORY_KEEP = 500;
const HISTORY_SHOWN = 200;

interface HistoryRow { id: string; sql: string; status: 'ok' | 'error'; rows: string | null; ms: number | null; error: string | null; runs: number; at: string }

const fmtMs = (n: number) => (n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(1) : n.toFixed(3));

/** (sprint 92, DA-4) A plan as a tree of steps (open), with the text plan behind a toggle. */
function planView(plan: Plan, text: string): Raw {
  const step = (n: PlanNode): Raw => html`<li><details open${n.slowest ? raw(' class="is-slowest"') : ''}>
    <summary><span class="ws-plan-op">${n.op}</span>${n.target ? html` <span class="ws-plan-target">${n.target}</span>` : ''}
      <span class="ws-plan-nums">cost ${n.startupCost.toFixed(2)}..${n.totalCost.toFixed(2)} · rows ${n.planRows} · width ${n.width}${plan.analyze
        ? n.neverRun ? html` · <em>never executed</em>` : html` · <strong>${fmtMs(n.actualTotal ?? 0)} ms</strong> × ${n.loops} · ${n.actualRows} row${n.actualRows === 1 ? '' : 's'}${n.selfMs !== undefined ? ` · self ${fmtMs(n.selfMs)} ms` : ''}${n.sharedHit || n.sharedRead ? ` · buffers ${n.sharedHit ?? 0} hit${n.sharedRead ? `, ${n.sharedRead} read` : ''}` : ''}`
        : ''}</span>
      ${n.slowest ? html`<span class="tag tag-warn">slowest step</span>` : ''}
      ${n.misestimate ? html`<span class="tag tag-warn" title="Estimated ${n.planRows} rows, got ${n.actualRows}: ANALYZE the table, or look at the statistics">estimate ${n.misestimate >= 1 ? `${Math.round(n.misestimate)}× too high` : `${Math.round(1 / n.misestimate)}× too low`}</span>` : ''}
    </summary>
    ${n.details.length ? html`<dl class="ws-plan-details">${n.details.map(([k, v]) => html`<dt>${k}</dt><dd><code>${v}</code></dd>`)}</dl>` : ''}
    ${n.children.length ? html`<ul class="ws-plan-tree">${n.children.map(step)}</ul>` : ''}
  </details></li>`;
  return html`${plan.planningMs !== undefined || plan.executionMs !== undefined ? html`<p class="muted small ws-info">${plan.planningMs !== undefined ? `Planning ${fmtMs(plan.planningMs)} ms` : ''}${plan.executionMs !== undefined ? ` · execution ${fmtMs(plan.executionMs)} ms (rolled back)` : ''}</p>` : ''}
    <ul class="ws-plan-tree ws-plan-root">${step(plan.root)}</ul>
    <details class="ws-plan-text"><summary>Text plan</summary><pre class="ws-log ws-plan">${text}</pre></details>`;
}

/** (sprint 92, DA-5) Keep the statements of a run in SQL History: the same statement again right after counts on its row. */
async function recordHistory(s: Session, run: WorksheetRun) {
  const ws = currentWorkspace(s);
  for (const r of run.results) {
    if (r.status !== 'ok' && r.status !== 'error') continue;
    const sql = r.sql.length > 20000 ? `${r.sql.slice(0, 19999)}…` : r.sql;
    const rows = r.status === 'ok' ? (r.rows ?? null) : null;
    const updated = await owner.query(
      `update meta.sql_history h set runs = runs + 1, at = now(), status = $4, rows = $5, ms = $6, error = $7
        where h.id = (select id from meta.sql_history where username = $1 and workspace_id = $2 order by id desc limit 1) and h.sql = $3`,
      [s.username, ws, sql, r.status, rows, r.ms, r.error ?? null]);
    if (!updated.rowCount)
      await owner.query(`insert into meta.sql_history (username, workspace_id, sql, status, rows, ms, error) values ($1, $2, $3, $4, $5, $6, $7)`,
        [s.username, ws, sql, r.status, rows, r.ms, r.error ?? null]);
  }
  await owner.query(
    `delete from meta.sql_history where username = $1 and workspace_id = $2
        and id < (select min(id) from (select id from meta.sql_history where username = $1 and workspace_id = $2 order by id desc limit $3) x)`,
    [s.username, ws, HISTORY_KEEP]);
}

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
    if (!list) return html`<li class="ws-obj" data-name="${o.name.toLowerCase()}"><a href="${obLink}" title="${label(o.type)}">${icon(iconOf(o.type))}<span>${o.name}</span></a>${objectMenu(schema, o)}</li>`;
    const st = objectStatements(schema, o.name, list, o.type);
    return html`<li class="ws-obj" data-name="${o.name.toLowerCase()}">${objectMenu(schema, o)}<details>
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
function outputPanes(run: WorksheetRun | null, mode: RunMode | null, history: HistoryRow[], tabAsked: string): { panes: Record<Tab, Raw>; active: Tab; status: Raw } {
  const results = run?.results ?? [];
  const ran = results.filter((r) => r.status !== 'not_run');
  const query = [...ran].reverse().find((r) => r.columns);
  const errors = ran.filter((r) => r.status === 'error');
  const warnings = run?.notices.filter((n) => n.level === 'WARNING').length ?? 0;
  const oneLine = (sql: string) => { const x = sql.replace(/\s+/g, ' '); return x.length > 80 ? `${x.slice(0, 79)}…` : x; };

  const rowsLabel = (q: NonNullable<typeof query>) => `${q.rows ?? q.data!.length} row${q.rows === 1 ? '' : 's'}`;
  let download: Raw | '' = '';
  if (query) {
    try {
      unloadStatement(query.sql);
      download = html`<details class="menu ws-dl"><summary class="btn btn-sm">${icon('download')}<span>Download</span></summary>
        <div class="menu-panel align-right"><div class="menu-section menu-links">${(['csv', 'json', 'xml', 'xlsx', 'sql'] as const).map((f) =>
          html`<button form="ws-dl" name="format" value="${f}">${{ csv: 'CSV', json: 'JSON', xml: 'XML', xlsx: 'Excel', sql: 'SQL inserts' }[f]}</button>`)}</div></div></details>`;
    } catch {
      download = '';
    }
  }
  const result: Raw = query
    ? html`<div class="ws-result-bar">
        <p class="muted small ws-info">${rowsLabel(query)} · ${query.ms} ms${query.more ? html` · showing the first ${query.data!.length}` : ''} · line ${query.line}</p>
        <span class="ws-spacer"></span>
        ${query.more ? html`<button class="btn btn-sm" name="mode" value="statement_all" title="Run the statement again and show up to ${ALL_ROWS.toLocaleString('en')} rows">All rows</button>` : ''}
        <button type="button" class="btn btn-sm" data-ws-copy hidden>${icon('copy')}<span>Copy</span></button>
        ${download}
      </div>
      <div class="table-wrap ws-grid"><table class="report" data-ws-grid><thead><tr><th scope="col" class="ws-rownum">#</th>${query.columns!.map((c, k) => html`<th scope="col"${query.numeric?.[k] ? raw(' class="num"') : ''}><button type="button" class="ws-sort" data-ws-sort="${k}" hidden>${c}</button><span class="ws-sort-label">${c}</span></th>`)}</tr></thead>
      <tbody>${query.data!.map((r, k) => html`<tr><td class="ws-rownum">${k + 1}</td>${r.map((v, i) => html`<td${query.numeric?.[i] ? raw(' class="num"') : ''}>${v === null ? html`<span class="null">(null)</span>` : v}</td>`)}</tr>`)}</tbody></table></div>
      <dialog class="ws-cell" id="ws-cell" aria-labelledby="ws-cell-title"><div class="ws-cell-head"><strong id="ws-cell-title">Value</strong><button type="button" class="btn btn-sm" data-ws-cell-close>Close</button></div><pre></pre></dialog>`
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
    ? html`<ul class="ws-notices">${run.notices.map((n) => html`<li><span class="tag${n.level === 'WARNING' ? ' tag-warn' : ''}">${n.level}</span> <span>${n.message}</span> <small class="muted">statement ${n.n} · ${n.at}</small></li>`)}</ul>`
    : html`<p class="muted">RAISE NOTICE, INFO and WARNING messages of the last run show here.</p>`;

  const planOf = (m: RunMode, empty: string) => mode === m && run
    ? (run.tree ? planView(run.tree, run.plan ?? '') : html`<p class="alert alert-error">${run.results[0]?.error ?? 'No plan.'}</p>`)
    : html`<p class="muted">${empty}</p>`;

  const when = (at: string) => new Date(at).toISOString().slice(0, 16).replace('T', ' ');
  const hist = history.length
    ? html`<div class="ws-hist-bar" hidden>
        <label class="sr-only" for="ws-hist-q">Search the history</label><input id="ws-hist-q" type="search" placeholder="Search the history" data-ws-hist-q>
        <label class="sr-only" for="ws-hist-s">Status</label><select id="ws-hist-s" data-ws-hist-s><option value="">All</option><option value="ok">Succeeded</option><option value="error">Failed</option></select>
      </div>
      <ul class="ws-history">${history.map((h) => html`<li data-status="${h.status}" data-sql="${h.sql.toLowerCase()}">
        <span class="ws-hist-icon ${h.status === 'error' ? 'is-err' : 'is-ok'}" title="${h.status === 'error' ? `Failed: ${h.error ?? ''}` : 'Succeeded'}">${icon(h.status === 'error' ? 'x-circle' : 'check-circle')}</span>
        <a href="${BASE}/sql/worksheet?history=${h.id}" data-ws-history="${h.sql}" title="Insert at the cursor: ${h.sql.slice(0, 500)}"><code>${oneLine(h.sql)}</code></a>
        <small class="muted ws-hist-meta">${h.status === 'ok' && h.rows !== null ? `${h.rows} row${h.rows === '1' ? '' : 's'} · ` : ''}${h.ms ?? 0} ms${h.runs > 1 ? ` · ${h.runs}×` : ''} · ${when(h.at)}</small>
        <button type="button" class="btn btn-sm" data-ws-run="${h.sql}" title="Put it in the editor and run it" hidden>Run</button>
        <button type="button" class="btn btn-sm btn-icon" data-ws-copy-text="${h.sql}" title="Copy" hidden>${icon('copy')}<span class="sr-only">Copy</span></button>
      </li>`)}</ul>`
    : html`<p class="muted">Your statements show here after you run them.</p>`;

  const active: Tab = !run ? (TABS.find(([k]) => k === tabAsked)?.[0] ?? 'result') : mode === 'explain' ? 'explain' : mode === 'autotrace' ? 'autotrace' : mode === 'script' || !query || errors.length ? 'output' : 'result';
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
  // (sprint 93, DA-7) where the editor's text came from, for the page's worksheet tabs: a run, a saved script, a
  // statement to insert (history, a template, a draft from the Object Browser) or nothing (restore the tabs)
  let source: 'run' | 'script' | 'insert' | 'blank' = isPost ? 'run' : 'blank';
  const scriptOf = (id: unknown) => /^\d{1,9}$/.test(String(id ?? ''))
    ? owner.one<{ id: number; name: string; content: string }>('select id, name, content from meta.sql_script where id = $1 and workspace_id = $2', [String(id), currentWorkspace(s)])
    : Promise.resolve(undefined);
  let script: { id: number; name: string } | null = null;
  if (isPost) {
    const r = await scriptOf(body.script_id);
    if (r) script = { id: r.id, name: r.name };
  } else {
    const r = await scriptOf(req.query?.script);
    if (req.query?.new === '1') source = 'insert'; // a new, empty worksheet
    if (r) {
      script = { id: r.id, name: r.name };
      text = r.content;
      source = 'script';
    }
  }
  const tabKey = /^[a-z0-9]{1,20}$/.test(String((isPost ? body.ws_tab : req.query?.wstab) ?? '')) ? String(isPost ? body.ws_tab : req.query!.wstab) : '';

  // (sprint 93, DA-7) the worksheet as a file: Save, Save As, Rename (SQL Scripts of the workspace), Download
  let fileError = '';
  if (isPost && ['save', 'save_as', 'rename', 'download'].includes(String(body.mode ?? ''))) {
    const name = String(body.ws_name ?? '').trim();
    if (body.mode === 'download') {
      const file = (script?.name ?? (name || 'worksheet')).replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'worksheet';
      return reply.header('content-disposition', `attachment; filename="${file}.sql"`).header('cache-control', 'private, no-store').type('application/sql; charset=utf-8').send(text);
    }
    try {
      if (name.length > 200) fileError = 'A name has at most 200 characters.';
      else if (text.length > 5_000_000) fileError = 'A script holds at most 5 MB.';
      else if (body.mode === 'save' && script) {
        await owner.query('update meta.sql_script set content = $2, updated_by = $3, updated_at = now() where id = $1 and workspace_id = $4', [script.id, text, s.username, currentWorkspace(s)]);
      } else if (body.mode === 'rename' && script) {
        if (!name) fileError = 'Enter the new name.';
        else await owner.query('update meta.sql_script set name = $2, updated_by = $3, updated_at = now() where id = $1 and workspace_id = $4', [script.id, name, s.username, currentWorkspace(s)]);
      } else if (!name) fileError = 'Name the worksheet to save it as a script.';
      else {
        const r = await owner.one<{ id: number }>(
          `insert into meta.sql_script (name, content, created_by, updated_by, workspace_id) values ($1, $2, $3, $3, $4) returning id`, [name, text, s.username, currentWorkspace(s)]);
        script = { id: r!.id, name };
      }
    } catch (e) {
      if ((e as { code?: string }).code !== '23505') throw e;
      fileError = `A script named “${name}” already exists.`;
    }
    if (!fileError && script) {
      flash(s, body.mode === 'rename' ? `Renamed to “${name}”.` : `Saved as the script “${body.mode === 'save' ? script.name : name}”.`);
      return back(reply, s, `${BASE}/sql/worksheet?${new URLSearchParams({ script: String(script.id), ...(tabKey ? { wstab: tabKey } : {}) })}`);
    }
  }
  if (!isPost) {
    // a command from SQL History or the home page's Recent SQL Commands (the developer's own)
    if (/^\d{1,18}$/.test(String(req.query?.recent ?? ''))) {
      const r = await owner.one<{ detail: string }>(`select detail from meta.activity_log where id = $1 and username = $2 and event = 'sql_command'`, [req.query!.recent, s.username]);
      if (r) {
        text = r.detail;
        source = 'insert';
      }
    }
    // (sprint 92) a statement from SQL History (one's own, in this workspace)
    if (/^\d{1,18}$/.test(String(req.query?.history ?? ''))) {
      const r = await owner.one<{ sql: string }>(`select sql from meta.sql_history where id = $1 and username = $2 and workspace_id = $3`, [req.query!.history, s.username, currentWorkspace(s)]);
      if (r) {
        text = r.sql;
        source = 'insert';
      }
    }
  }
  const [schemas, searchSchema, apps] = await Promise.all([usableSchemas(db), sessionSchema(s, db), runAsApps(s)]);
  if (!isPost) {
    // (sprint 75) a statement to review: from the Object Browser's column actions, or a CREATE template
    if (typeof s.state.__SQLDRAFT === 'string') {
      text = s.state.__SQLDRAFT;
      delete s.state.__SQLDRAFT;
      source = 'insert';
    } else if (typeof req.query?.template === 'string') {
      const into = typeof req.query.schema === 'string' && schemas.includes(req.query.schema) ? req.query.schema : (searchSchema ?? 'public');
      const t = createTemplate(req.query.template, into);
      if (t) {
        text = t;
        source = 'insert';
      }
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
  // (sprint 93, DA-9) bind variables (:NAME) and substitution variables (&NAME.) asked for before a run
  let askValues: { binds: string[]; subs: string[]; mode: string } | null = null;
  const remembered: Record<string, string> = (() => {
    try {
      const v = JSON.parse(s.state.__WSBINDS ?? '{}');
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch {
      return {};
    }
  })();
  if (isPost && text.trim() && !['nav', 'save', 'save_as', 'rename', 'download'].includes(String(body.mode ?? ''))) {
    const m: RunMode = MODES.find((x) => x === body.mode) ?? 'statement';
    const allRows = body.mode === 'statement_all';
    mode = m;
    const sel = /^\d{1,9}$/.test(String(body.sel_start ?? '')) && /^\d{1,9}$/.test(String(body.sel_end ?? '')) ? { start: Number(body.sel_start), end: Number(body.sel_end) } : undefined;
    const picked = pickStatements(text, m, sel);
    const binds = [...new Set(picked.flatMap((x) => (x.psql ? [] : bindNames(x.sql))))].slice(0, 50);
    const subs = [...new Set(picked.flatMap((x) => (x.psql ? [] : substitutionNames(x.sql))))].slice(0, 50);
    if (picked.length && (binds.length || subs.length) && body.binds_given !== '1') {
      askValues = { binds, subs, mode: String(body.mode ?? 'statement') };
      ran = { start: picked[0].start, end: picked[picked.length - 1].end };
    }
    const value = (prefix: string, n: string) => String(body[`${prefix}_${n}`] ?? '').slice(0, 4000);
    if (!askValues && (binds.length || subs.length)) {
      for (const n of binds) remembered[`:${n}`] = value('bind', n);
      for (const n of subs) remembered[`&${n}`] = value('sub', n);
      s.state.__WSBINDS = JSON.stringify(Object.fromEntries(Object.entries(remembered).slice(-100)));
    }
    const statements = askValues ? [] : picked.map((x) => (x.psql ? x : {
      ...x,
      sql: applyBinds(applySubstitutions(x.sql, Object.fromEntries(subs.map((n) => [n, value('sub', n)]))), Object.fromEntries(binds.map((n) => [n, value('bind', n)]))),
    }));
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
          : await runStatements(c, text, statements, { continueOnError: m === 'script' && continueOnError, gridRows: allRows ? ALL_ROWS : GRID_ROWS });
      } catch (e) {
        run = { results: [{ n: 1, line: statements[0].line, sql: statements[0].sql, start: 0, end: 0, status: 'error', error: (e as Error).message, ms: 0 }], notices: [], failed: 1, ms: 0 };
      } finally {
        c.release(true);
      }
      // the log and history show the statements as written (with :NAME), not with the values
      if (run) for (const r of run.results) r.sql = picked[r.n - 1]?.sql ?? r.sql;
      if (mode === 'statement' || mode === 'script') {
        clearCompletions(); // the statements may have changed tables or grants
        if (run) await recordHistory(s, run);
        const detail = picked.map((x) => x.sql).join(';\n');
        await logActivity({ username: s.username, event: 'sql_command', ip: clientIp(req), elapsedMs: Math.round(performance.now() - started), detail: detail.length > 2000 ? `${detail.slice(0, 2000)}…` : detail });
      }
    }
  }
  const history = (await owner.query<HistoryRow>(
    `select id, sql, status, rows, ms, error, runs, at from meta.sql_history where username = $1 and workspace_id = $2 order by id desc limit $3`,
    [s.username, currentWorkspace(s), HISTORY_SHOWN])).rows;
  const { panes, active, status } = outputPanes(run, mode, history, String(req.query?.tab ?? ''));
  const lastQuery = [...(run?.results ?? [])].reverse().find((r) => r.status === 'ok' && r.columns);
  const downloadable = (() => {
    try {
      return lastQuery ? unloadStatement(lastQuery.sql) : null;
    } catch {
      return null; // not one SELECT: Unload Data would refuse it
    }
  })();
  const firstError = run?.results.find((r) => r.status === 'error');
  const files = (await owner.query<{ id: number; name: string; updated_at: string }>(
    'select id, name, updated_at from meta.sql_script where workspace_id = $1 order by lower(name) limit 300', [currentWorkspace(s)])).rows;
  const bindDialog = askValues ? html`<dialog class="ws-binds" id="ws-binds" open aria-labelledby="ws-binds-title" data-ws-binds>
      <h2 id="ws-binds-title">Values for the run</h2>
      <p class="muted small">Bind variables (<code>:NAME</code>) get a value as a quoted literal; substitution variables (<code>&amp;NAME.</code>) put the text into the statement as it is. Empty is NULL for a bind variable.</p>
      <input type="hidden" name="binds_given" value="1">
      <div class="ws-binds-fields">${askValues.binds.map((n) => html`<label class="field"><span class="label"><code>:${n}</code></span><input name="bind_${n}" value="${remembered[`:${n}`] ?? ''}" autocomplete="off"></label>`)}${askValues.subs.map((n) => html`<label class="field"><span class="label"><code>&amp;${n}.</code></span><input name="sub_${n}" value="${remembered[`&${n}`] ?? ''}" autocomplete="off"></label>`)}</div>
      <div class="buttons"><button class="btn btn-hot" name="mode" value="${askValues.mode}">${icon('play')} Run</button><button class="btn" name="mode" value="nav" data-ws-binds-cancel>Cancel</button></div>
    </dialog>` : '';
  const runsAs = asApp ? `the role ${asApp.db_role} of ${asApp.name}` : workshopRunsAs(db);

  const toolBtn = (m: RunMode, ic: string, label: string, key: string, hot = false) =>
    html`<button class="btn btn-sm${hot ? ' btn-hot' : ''}" name="mode" value="${m}" title="${label} (${key})" data-ws-key="${key}">${icon(ic)}<span>${label}</span></button>`;
  const main = html`<div class="ws-page">
    <h1 class="sr-only">SQL Worksheet</h1>
    ${workshopTabs('sql')}
    <form method="post" action="${BASE}/sql/worksheet" class="ws" id="ws" data-ran="${ran ? `${ran.start},${ran.end}` : ''}" data-error-line="${firstError?.errorLine ?? ''}"
      data-source="${source}" data-script-id="${script?.id ?? ''}" data-script-name="${script?.name ?? ''}" data-tab="${tabKey}">${csrf(s)}
      <button class="ws-default" name="mode" value="nav" tabindex="-1">Refresh the navigator</button>
      <input type="hidden" name="sel_start" value=""><input type="hidden" name="sel_end" value="">
      <input type="hidden" name="script_id" value="${script?.id ?? ''}"><input type="hidden" name="ws_tab" value="${tabKey}">
      ${bindDialog}
      <aside class="ws-nav" id="ws-nav" aria-label="Navigator">
        <div class="ws-nav-switch" role="tablist" aria-label="Navigator" hidden>
          <button type="button" role="tab" aria-selected="true" aria-controls="ws-nav-objects" data-ws-navtab="objects">Objects</button>
          <button type="button" role="tab" aria-selected="false" aria-controls="ws-files" data-ws-navtab="files">Files</button>
        </div>
        <div id="ws-nav-objects" class="ws-nav-panel">
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
        </div>
        <section id="ws-files" class="ws-nav-panel ws-files" aria-label="Files">
          <h2 class="ws-files-title">Files <small class="muted">(SQL Scripts)</small></h2>
          ${files.length ? html`<ul>${files.map((f) => html`<li><a href="${BASE}/sql/worksheet?script=${f.id}"${script?.id === f.id ? raw(' aria-current="true"') : ''}>${icon('file')}<span>${f.name}</span></a></li>`)}</ul>` : html`<p class="muted small">No scripts yet: Save a worksheet to make one.</p>`}
        </section>
      </aside>
      <div class="ws-split ws-split-v" role="separator" aria-orientation="vertical" aria-label="Resize the navigator" tabindex="0" data-ws-split="nav" hidden></div>
      <section class="ws-main" aria-label="Worksheet">
        <div class="ws-toolbar" role="toolbar" aria-label="Worksheet">
          <button type="button" class="btn btn-sm btn-icon" data-ws-toggle-nav title="Hide or show the navigator" hidden>${bicon('left')}<span class="sr-only">Navigator</span></button>
          <details class="menu ws-file"><summary class="btn btn-sm" title="Save, open, rename or download the worksheet (Ctrl+S saves)">${icon('file')}<span class="ws-file-name">${script?.name ?? 'Untitled'}</span></summary>
            <div class="menu-panel"><div class="menu-section ws-file-panel">
              <label class="label" for="ws-name">Name</label>
              <input id="ws-name" name="ws_name" value="${script?.name ?? ''}" maxlength="200" autocomplete="off">
              <div class="ws-file-actions">
                <button class="btn btn-sm btn-hot" name="mode" value="save" title="Save (Ctrl+S)">${icon('save')} Save</button>
                ${script ? html`<button class="btn btn-sm" name="mode" value="save_as">Save as new</button><button class="btn btn-sm" name="mode" value="rename">Rename</button>` : ''}
                <button class="btn btn-sm" name="mode" value="download">${icon('download')} Download</button>
              </div>
              <div class="ws-file-actions"><a class="btn btn-sm" href="${BASE}/sql/worksheet?new=1" data-ws-new>${icon('plus')} New</a><a class="btn btn-sm" href="#ws-files" data-ws-open>Open…</a></div>
            </div></div></details>
          ${toolBtn('statement', 'play', 'Run Statement', 'Ctrl+Enter', true)}
          ${toolBtn('script', 'file', 'Run Script', 'F5')}
          ${toolBtn('explain', 'route', 'Explain Plan', 'F10')}
          ${toolBtn('autotrace', 'activity', 'Autotrace', 'F6')}
          <label class="ws-check"><input type="checkbox" name="continue_on_error"${continueOnError ? raw(' checked') : ''}> Continue on error</label>
          <span class="ws-spacer"></span>
          <button type="button" class="btn btn-sm btn-icon" data-ws-format title="Format (Ctrl+F7)" hidden>${icon('sliders')}<span class="sr-only">Format</span></button>
          <button type="button" class="btn btn-sm btn-icon" data-ws-case title="Convert case of the selection (Ctrl+B)" hidden><span aria-hidden="true" class="ws-aa">Aa</span><span class="sr-only">Convert case</span></button>
          <button type="button" class="btn btn-sm btn-icon" data-ws-find title="Find and replace (Ctrl+F, Ctrl+H)" hidden>${icon('search')}<span class="sr-only">Find</span></button>
          <a class="btn btn-sm btn-icon" href="${BASE}/sql/load?schema=${encodeURIComponent(navSchema)}" title="Load data into a table">${icon('upload')}<span class="sr-only">Load data</span></a>
          <details class="menu ws-keys"><summary class="btn btn-sm btn-icon" title="Keyboard shortcuts">?<span class="sr-only">Keyboard shortcuts</span></summary>
            <div class="menu-panel align-right"><div class="menu-section"><dl class="ws-keylist">
              <dt>Ctrl+Enter</dt><dd>Run Statement</dd><dt>F5</dt><dd>Run Script</dd><dt>F10</dt><dd>Explain Plan</dd><dt>F6</dt><dd>Autotrace</dd>
              <dt>Ctrl+S</dt><dd>Save</dd><dt>Ctrl+F7</dt><dd>Format</dd><dt>Ctrl+B</dt><dd>Convert case</dd><dt>Ctrl+F / Ctrl+H</dt><dd>Find / replace</dd>
              <dt>Ctrl+G</dt><dd>Go to line</dd><dt>Ctrl+/</dt><dd>Comment the lines</dd><dt>Ctrl+Space</dt><dd>Suggestions</dd><dt>F1</dt><dd>Help</dd><dt>Escape</dt><dd>Leave fullscreen</dd>
            </dl>
            <label class="ws-kwcase" hidden>Format keywords in <select data-ws-kwcase><option value="lower">lower case</option><option value="upper">UPPER CASE</option></select></label>
            <a href="https://github.com/pgkiln/pgkiln/blob/main/docs/guide/03-builder.md#sql-workshop" target="_blank" rel="noopener" data-ws-help>Help on the SQL Worksheet</a></div></div></details>
          <label class="ws-runas"><span>Run as</span>
            <select name="as_app" title="Who the statements run as">
              <option value="">${db === owner ? 'Owner connection' : 'Workspace login'}</option>
              ${apps.map((a) => html`<option value="${a.id}"${asApp?.id === a.id ? raw(' selected') : ''}>${a.name} (${a.db_role})</option>`)}
            </select></label>
          <button type="button" class="btn btn-sm btn-icon" data-ws-clear title="Clear the editor" hidden>${icon('trash')}<span class="sr-only">Clear</span></button>
          <button type="button" class="btn btn-sm btn-icon" data-ws-fullscreen title="Fullscreen (Escape leaves)" aria-pressed="false" hidden>${bicon('expand')}<span class="sr-only">Fullscreen</span></button>
        </div>
        <p class="ws-runs-as muted small">Runs as ${runsAs}${searchSchema ? html`; <code>${searchSchema}</code> first in the search path (<a href="${BASE}/sql">change</a>)` : ''}. Each statement commits on its own.</p>
        ${fileError ? html`<p class="alert alert-error ws-file-error" role="alert">${fileError}</p>` : ''}
        <div class="ws-wtabs" role="tablist" aria-label="Worksheets" hidden></div>
        <div class="ws-findbar" hidden>
          <label class="sr-only" for="ws-find-q">Find</label><input id="ws-find-q" type="search" placeholder="Find" autocomplete="off" data-ws-find-q>
          <label class="sr-only" for="ws-find-r">Replace with</label><input id="ws-find-r" placeholder="Replace with" autocomplete="off" data-ws-find-r>
          <label class="ws-check"><input type="checkbox" data-ws-find-re> Regex</label>
          <label class="ws-check"><input type="checkbox" data-ws-find-cs> Match case</label>
          <button type="button" class="btn btn-sm" data-ws-find-next>Next</button>
          <button type="button" class="btn btn-sm" data-ws-find-replace>Replace</button>
          <button type="button" class="btn btn-sm" data-ws-find-all>Replace all</button>
          <label class="sr-only" for="ws-goto">Go to line</label><input id="ws-goto" type="number" min="1" placeholder="Line" class="ws-goto" data-ws-goto>
          <span class="muted small" data-ws-find-msg></span>
          <button type="button" class="btn btn-sm btn-icon" data-ws-find-close title="Close (Escape)">${icon('x-circle')}<span class="sr-only">Close</span></button>
        </div>
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
    ${downloadable ? html`<form method="post" action="${BASE}/sql/unload" id="ws-dl" class="ws-dl-form">${csrf(s)}<input type="hidden" name="source" value="query"><input type="hidden" name="query" value="${downloadable}"><input type="hidden" name="header" value="1"><input type="hidden" name="bom" value="1"></form>` : ''}
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

  // (sprint 93, DA-9) Format: the worksheet's text laid out, keywords in the case asked for
  app.post(`${BASE}/sql/worksheet/format`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const sql = String(req.body?.sql ?? '');
    if (sql.length > 1_000_000) return reply.code(413).send({ error: 'Too long to format.' });
    return reply.header('Cache-Control', 'no-store').send({ sql: formatSql(sql, req.body?.case === 'upper' ? 'upper' : 'lower') });
  });

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
