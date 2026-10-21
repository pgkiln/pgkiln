import type { FastifyInstance, FastifyReply } from 'fastify';
import pg from 'pg';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { owner } from '../db.ts';
import { devDbForApp } from '../workspace-db.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import { back, bicon, BASE, csrf, developer, flash, send, shell, workshopTabs, type Req } from './ui.ts';
import { tr, translatorFor, type BuilderTranslate } from './i18n.ts';
import { clearCompletions } from './code-editor.ts';
import { createTemplate, listObjects, OB_TYPES, pickSchema, SYSTEM_SCHEMAS, type Obj } from './object-browser.ts';
import { objectMenu } from './object-actions.ts';
import { askedSpec, chartControls, chartSpec, drawChart } from './sql-charts.ts';
import { currentWorkspace, inWorkspaceSql, sessionSchema, usableSchemas, workshopDb, workshopRunsAs } from './workspaces.ts';
import { applySubstitutions, explainStatement, pickStatements, runStatements, substitutionNames, textTable, type RunMode, type WorksheetRun } from '../sqlworksheet.ts';
import { applyBinds, bindNames } from '../binds.ts';
import { formatSql } from '../sqlformat.ts';
import { planView } from './plan-view.ts';
import { unloadStatement } from '../unload.ts';
import { recordChanges } from '../changelog.ts';
import { accountRun, beginTxn, endAllTxns, endTxn, findTxn, outsideTxnOnly, txnIdleSeconds, txnNote, txnState, clearTxnNote, type WorksheetTxn } from '../worksheet-txn.ts';

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
  ['result', 'Query Result'], ['chart', 'Chart'], ['output', 'Script Output'], ['notices', 'Notices'], ['explain', 'Explain Plan'], ['autotrace', 'Autotrace'], ['history', 'SQL History'],
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
async function navigatorTree(db: Awaited<ReturnType<typeof workshopDb>>, schema: string, type: string, tx: BuilderTranslate): Promise<Raw> {
  if (!schema) return html`<p class="muted ws-nav-empty">${tx('ws.nav.no_schema')}</p>`;
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
  const label = (t: string) => tx.dyn(`ob.type.${t}`, NAV_TYPES.find(([k]) => k === t)?.[1] ?? t);
  // English lower-cases the type in the sentence; other languages keep the label as it is (German nouns)
  if (!objects.length) return html`<p class="muted ws-nav-empty">${type === 'all' ? tx('ws.nav.no_objects', { schema }) : tx('ws.nav.no_type', { type: tx.lang === 'en' ? label(type).toLowerCase() : label(type), schema })}</p>`;
  return html`<ul class="ws-tree" id="ws-tree">${objects.map((o) => {
    const list = cols.get(o.ref);
    const obLink = `${BASE}/sql/objects?${new URLSearchParams(o.type === 'policy' ? { schema, k: 'table', o: o.ref, tab: 'rls' } : { schema, k: o.type, o: o.ref })}`;
    if (!list) return html`<li class="ws-obj" data-name="${o.name.toLowerCase()}"><a href="${obLink}" title="${label(o.type)}">${icon(iconOf(o.type))}<span>${o.name}</span></a>${objectMenu(schema, o)}</li>`;
    const st = objectStatements(schema, o.name, list, o.type);
    return html`<li class="ws-obj" data-name="${o.name.toLowerCase()}">${objectMenu(schema, o)}<details>
      <summary draggable="true" data-ws-sql="${st.select}" title="${tx('ws.nav.drag', { type: tx.lang === 'en' ? label(o.type).replace(/s$/, '') : label(o.type) })}">${icon(iconOf(o.type))}<span>${o.name}</span>${o.rls ? html`<span class="tag">RLS</span>` : ''}</summary>
      <ul class="ws-cols">${list.map((c) => html`<li title="${c.type}${c.notnull ? ' not null' : ''}">${c.pk ? icon('key') : icon('minus')}<span>${c.name}</span><small class="muted">${c.type}</small></li>`)}</ul>
      <div class="ws-obj-actions">
        ${Object.entries(st).map(([k, sql]) => html`<button type="button" class="btn btn-sm" data-ws-insert="${sql}" hidden>${k.toUpperCase()}</button>`)}
        <a class="btn btn-sm" href="${obLink}">${tx('ws.nav.open')}</a>
      </div>
    </details></li>`;
  })}</ul>${objects.length > rels.length && rels.length === MAX_COLUMN_OBJECTS ? html`<p class="muted small ws-nav-empty">${tx('ws.nav.cols_limit', { n: MAX_COLUMN_OBJECTS })}</p>` : ''}`;
}

/** The output panes of a run (empty: the page as opened). */
function outputPanes(run: WorksheetRun | null, mode: RunMode | null, history: HistoryRow[], tabAsked: string, chart: Raw | null, tx: BuilderTranslate): { panes: Record<Tab, Raw>; active: Tab; status: Raw } {
  const results = run?.results ?? [];
  const ran = results.filter((r) => r.status !== 'not_run');
  const query = [...ran].reverse().find((r) => r.columns);
  const errors = ran.filter((r) => r.status === 'error');
  const warnings = run?.notices.filter((n) => n.level === 'WARNING').length ?? 0;
  const oneLine = (sql: string) => { const x = sql.replace(/\s+/g, ' '); return x.length > 80 ? `${x.slice(0, 79)}…` : x; };

  const rowsLabel = (q: NonNullable<typeof query>) => tx(q.rows === 1 ? 'ws.rows_one' : 'ws.rows', { n: q.rows ?? q.data!.length });
  const errorText = (line: number | undefined, col: number | undefined, error: string | undefined) =>
    line ? (col ? tx('ws.error_at_col', { line, col, error }) : tx('ws.error_at', { line, error })) : tx('ws.error', { error });
  let download: Raw | '' = '';
  if (query) {
    try {
      unloadStatement(query.sql);
      download = html`<details class="menu ws-dl"><summary class="btn btn-sm">${icon('download')}<span>${tx('ws.download')}</span></summary>
        <div class="menu-panel align-right"><div class="menu-section menu-links">${(['csv', 'json', 'xml', 'xlsx', 'sql'] as const).map((f) =>
          html`<button form="ws-dl" name="format" value="${f}">${{ csv: 'CSV', json: 'JSON', xml: 'XML', xlsx: 'Excel', sql: tx('ws.dl.sql') }[f]}</button>`)}</div></div></details>`;
    } catch {
      download = '';
    }
  }
  const result: Raw = query
    ? html`<div class="ws-result-bar">
        <p class="muted small ws-info">${rowsLabel(query)} · ${query.ms} ms${query.more ? html` · ${tx('ws.result.showing', { n: query.data!.length })}` : ''} · ${tx('ws.line', { n: query.line })}</p>
        <span class="ws-spacer"></span>
        ${query.more ? html`<button class="btn btn-sm" name="mode" value="statement_all" title="${tx('ws.all_rows.title', { n: ALL_ROWS.toLocaleString(tx.lang) })}">${tx('ws.all_rows')}</button>` : ''}
        <button class="btn btn-sm" name="mode" value="chart" title="${tx('ws.chart.title')}">${icon('chart')}<span>${tx('ws.tab.chart')}</span></button>
        <button type="button" class="btn btn-sm" data-ws-copy hidden>${icon('copy')}<span>${tx('ws.copy')}</span></button>
        ${download}
      </div>
      <div class="table-wrap ws-grid"><table class="report" data-ws-grid><thead><tr><th scope="col" class="ws-rownum">#</th>${query.columns!.map((c, k) => html`<th scope="col"${query.numeric?.[k] ? raw(' class="num"') : ''}><button type="button" class="ws-sort" data-ws-sort="${k}" hidden>${c}</button><span class="ws-sort-label">${c}</span></th>`)}</tr></thead>
      <tbody>${query.data!.map((r, k) => html`<tr><td class="ws-rownum">${k + 1}</td>${r.map((v, i) => html`<td${query.numeric?.[i] ? raw(' class="num"') : ''}>${v === null ? html`<span class="null">(null)</span>` : v}</td>`)}</tr>`)}</tbody></table></div>
      <dialog class="ws-cell" id="ws-cell" aria-labelledby="ws-cell-title"><div class="ws-cell-head"><strong id="ws-cell-title">${tx('ws.value')}</strong><button type="button" class="btn btn-sm" data-ws-cell-close>${tx('ws.close')}</button></div><pre></pre></dialog>`
    : run && mode !== 'explain' && mode !== 'autotrace'
      ? html`<p class="muted">${errors.length ? tx('ws.result.failed') : tx('ws.result.no_rows')}</p>`
      : html`<p class="muted">${tx('ws.result.empty')}</p>`;

  const log = run
    ? html`<pre class="ws-log">${results.map((r) => {
        if (r.status === 'not_run') return html`<span class="muted">${tx('ws.log.not_run', { n: r.n, line: r.line })}\n</span>`;
        const head = html`<span class="ws-log-sql">${tx('ws.log.head', { n: r.n, line: r.line, sql: oneLine(r.sql) })}</span>\n`;
        if (r.status === 'skipped') return html`${head}<span class="ws-log-warn">${r.error}</span>\n\n`;
        if (r.status === 'error') return html`${head}<span class="ws-log-err">${errorText(r.errorLine, r.errorColumn, r.error)}</span>\n\n`;
        const body = r.columns ? `${textTable(r.columns, r.data ?? [])}\n${r.more ? `${tx('ws.log.first', { n: r.data!.length, rows: r.rows })}\n` : ''}` : '';
        const notes = run.notices.filter((n) => n.n === r.n).map((n) => `${n.level}: ${n.message}\n`).join('');
        return html`${head}${body}${notes}<span class="ws-log-ok">${r.tag}</span> <span class="muted">(${r.ms} ms)</span>\n\n`;
      })}<span class="muted">${tx(ran.length === 1 ? 'ws.log.summary_one' : 'ws.log.summary', { n: ran.length, failed: errors.length, ms: run.ms })}</span></pre>`
    : html`<p class="muted">${tx('ws.log.empty')}</p>`;

  const notices = run?.notices.length
    ? html`<ul class="ws-notices">${run.notices.map((n) => html`<li><span class="tag${n.level === 'WARNING' ? ' tag-warn' : ''}">${n.level}</span> <span>${n.message}</span> <small class="muted">${tx('ws.notice.meta', { n: n.n, at: n.at })}</small></li>`)}</ul>`
    : html`<p class="muted">${tx('ws.notice.empty')}</p>`;

  const planOf = (m: RunMode, empty: string) => mode === m && run
    ? (run.tree ? planView(run.tree, run.plan ?? '') : html`<p class="alert alert-error">${run.results[0]?.error ?? tx('ws.no_plan')}</p>`)
    : html`<p class="muted">${empty}</p>`;

  const when = (at: string) => new Date(at).toISOString().slice(0, 16).replace('T', ' ');
  const hist = history.length
    ? html`<div class="ws-hist-bar" hidden>
        <label class="sr-only" for="ws-hist-q">${tx('ws.hist.search')}</label><input id="ws-hist-q" type="search" placeholder="${tx('ws.hist.search')}" data-ws-hist-q>
        <label class="sr-only" for="ws-hist-s">${tx('ws.hist.status')}</label><select id="ws-hist-s" data-ws-hist-s><option value="">${tx('ws.hist.all')}</option><option value="ok">${tx('ws.hist.ok')}</option><option value="error">${tx('ws.hist.failed')}</option></select>
      </div>
      <ul class="ws-history">${history.map((h) => html`<li data-status="${h.status}" data-sql="${h.sql.toLowerCase()}">
        <span class="ws-hist-icon ${h.status === 'error' ? 'is-err' : 'is-ok'}" title="${h.status === 'error' ? tx('ws.hist.failed_title', { error: h.error ?? '' }) : tx('ws.hist.ok')}">${icon(h.status === 'error' ? 'x-circle' : 'check-circle')}</span>
        <a href="${BASE}/sql/worksheet?history=${h.id}" data-ws-history="${h.sql}" title="${tx('ws.hist.insert', { sql: h.sql.slice(0, 500) })}"><code>${oneLine(h.sql)}</code></a>
        <small class="muted ws-hist-meta">${h.status === 'ok' && h.rows !== null ? `${tx(h.rows === '1' ? 'ws.rows_one' : 'ws.rows', { n: h.rows })} · ` : ''}${h.ms ?? 0} ms${h.runs > 1 ? ` · ${h.runs}×` : ''} · ${when(h.at)}</small>
        <button type="button" class="btn btn-sm" data-ws-run="${h.sql}" title="${tx('ws.hist.run_title')}" hidden>${tx('common.run')}</button>
        <button type="button" class="btn btn-sm btn-icon" data-ws-copy-text="${h.sql}" title="${tx('ws.copy')}" hidden>${icon('copy')}<span class="sr-only">${tx('ws.copy')}</span></button>
      </li>`)}</ul>`
    : html`<p class="muted">${tx('ws.hist.empty')}</p>`;

  const active: Tab = chart && run ? 'chart' : !run ? (TABS.find(([k]) => k === tabAsked)?.[0] ?? 'result') : mode === 'explain' ? 'explain' : mode === 'autotrace' ? 'autotrace' : mode === 'script' || !query || errors.length ? 'output' : 'result';
  const time = new Date().toTimeString().slice(0, 8);
  const last = !run ? tx('ws.ready') : errors.length
    ? errorText(errors[0].errorLine, undefined, errors[0].error)
    : mode === 'explain' || mode === 'autotrace' ? tx(mode === 'explain' ? 'ws.status.explain' : 'ws.status.autotrace', { ms: run.ms })
      : query && ran.length === 1 ? tx(query.rows === 1 ? 'ws.status.rows_one' : 'ws.status.rows', { n: query.rows, ms: query.ms })
        : tx(ran.length === 1 ? 'ws.status.stmts_one' : 'ws.status.stmts', { n: ran.length, ms: run.ms });
  const status = html`<span class="ws-count ${errors.length ? 'is-err' : ''}" title="${tx('ws.errors')}">${icon('x-circle')} ${errors.length}</span>
    <span class="ws-count ${warnings ? 'is-warn' : ''}" title="${tx('ws.warnings')}">${icon('alert')} ${warnings}</span>
    <span class="ws-busy" hidden>${icon('refresh')} ${tx('ws.running')}</span>
    <span class="ws-last">${last}</span><span class="muted ws-time">${run ? time : ''}</span>`;
  return { panes: { result, chart: chart ?? html`<p class="muted">${tx('ws.chart.empty')}</p>`, output: log, notices, explain: planOf('explain', tx('ws.explain.empty')), autotrace: planOf('autotrace', tx('ws.autotrace.empty')), history: hist }, active, status };
}

/** (sprint 107) The idle timeout in words. */
const idleLabel = (tx: BuilderTranslate) => {
  const sec = txnIdleSeconds();
  return sec % 60 ? tx('ws.idle.seconds', { n: sec }) : tx(sec === 60 ? 'ws.idle.minute' : 'ws.idle.minutes', { n: sec / 60 });
};

/** (sprint 107) The transaction badge's text (public/worksheet.js writes the same after a reload or a tab switch). */
export function txnBadge(state: 'open' | 'aborted' | 'none', statements: number, startedMs: number | null, note: string | null, tx: BuilderTranslate = translatorFor('en')): string {
  if (state === 'none') return note ?? tx('ws.txn.none');
  const min = startedMs ? Math.floor((Date.now() - startedMs) / 60_000) : 0;
  const age = min < 1 ? tx('ws.txn.under_minute') : tx('ws.txn.min', { n: min });
  return `${tx(state === 'aborted' ? 'ws.txn.failed' : 'ws.txn.open')} · ${tx(statements === 1 ? 'ws.stmt_one' : 'ws.stmt', { n: statements })} · ${age}`;
}

/** (sprint 107) Commit or Rollback a worksheet tab's transaction (the toolbar's buttons, and the JSON endpoint). */
async function finishTxn(req: Req, s: Session, tab: string, t: WorksheetTxn | undefined, action: 'commit' | 'rollback'): Promise<{ ok: boolean; message: string; busy?: boolean }> {
  const tx = tr(s);
  if (!t) return { ok: false, message: tx('ws.txn.no_txn') };
  if (t.busy) return { ok: false, busy: true, message: tx('ws.txn.busy') };
  const n = t.statements;
  const failed = txnState(t) === 'aborted';
  const ended = await endTxn(t, action);
  clearTxnNote(s.id, tab);
  if (ended.ddl.length) await recordChanges({ workspaceId: t.workspaceId, author: s.username ?? '?', source: 'worksheet', defaultSchema: t.defaultSchema, statements: ended.ddl });
  await logActivity({ username: s.username, event: 'sql_command', ip: clientIp(req), detail: ended.tag.toLowerCase() });
  if (ended.error) return { ok: false, message: tx('ws.txn.end_failed', { action: action.toUpperCase(), error: ended.error }) };
  if (action === 'commit' && ended.tag !== 'COMMIT') return { ok: false, message: tx('ws.txn.commit_rolled') };
  const what = tx(n === 1 ? 'ws.stmt_one' : 'ws.stmt', { n });
  return { ok: true, message: tx(action === 'commit' ? 'ws.txn.committed' : failed ? 'ws.txn.rolled_back_failed' : 'ws.txn.rolled_back', { what }) };
}

/** (sprint 107) A tab's transaction as JSON, for the badge after a reload or a tab switch. */
function txnStatus(s: Session, tab: string) {
  const t = findTxn(s.id, tab);
  const state = t && t.workspaceId === currentWorkspace(s) ? txnState(t) : 'none';
  const note = state === 'none' ? txnNote(s.id, tab) : null;
  return {
    state, statements: t?.statements ?? 0, startedMs: t?.startedMs ?? null, lastMs: t?.lastMs ?? null, idleSeconds: txnIdleSeconds(),
    runsAs: t?.runsAs ?? null, note, badge: txnBadge(state, t?.statements ?? 0, t?.startedMs ?? null, note, tr(s)), now: Date.now(),
  };
}

/** The applications whose database role a run can take (the developer's workspace). */
async function runAsApps(s: Session) {
  return (await owner.query<{ id: number; name: string; db_role: string }>(
    `select a.id, a.name, a.db_role from meta.app a where ${inWorkspaceSql('a', 1)} and a.db_role is not null order by a.name, a.id`, [currentWorkspace(s)])).rows;
}

async function worksheet(req: Req, reply: FastifyReply) {
  const s = await developer(req, reply);
  if (!s) return;
  const tx = tr(s);
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
      if (name.length > 200) fileError = tx('ws.file.name_long');
      else if (text.length > 5_000_000) fileError = tx('ws.file.too_big');
      else if (body.mode === 'save' && script) {
        await owner.query('update meta.sql_script set content = $2, updated_by = $3, updated_at = now() where id = $1 and workspace_id = $4', [script.id, text, s.username, currentWorkspace(s)]);
      } else if (body.mode === 'rename' && script) {
        if (!name) fileError = tx('ws.file.new_name');
        else await owner.query('update meta.sql_script set name = $2, updated_by = $3, updated_at = now() where id = $1 and workspace_id = $4', [script.id, name, s.username, currentWorkspace(s)]);
      } else if (!name) fileError = tx('ws.file.need_name');
      else {
        const r = await owner.one<{ id: number }>(
          `insert into meta.sql_script (name, content, created_by, updated_by, workspace_id) values ($1, $2, $3, $3, $4) returning id`, [name, text, s.username, currentWorkspace(s)]);
        script = { id: r!.id, name };
      }
    } catch (e) {
      if ((e as { code?: string }).code !== '23505') throw e;
      fileError = tx('ws.file.exists', { name });
    }
    if (!fileError && script) {
      flash(s, body.mode === 'rename' ? tx('ws.file.renamed', { name }) : tx('ws.file.saved', { name: body.mode === 'save' ? script.name : name }));
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
  let chartAsked = false;
  const remembered: Record<string, string> = (() => {
    try {
      const v = JSON.parse(s.state.__WSBINDS ?? '{}');
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch {
      return {};
    }
  })();
  // (sprint 107, DA-2) transaction mode: the worksheet tab's open transaction (bound to this session)
  const txnAsked = isPost && body.txn === 'on';
  let txn: WorksheetTxn | undefined = tabKey ? findTxn(s.id, tabKey) : undefined;
  let txnError = '';
  let txnInfo = '';
  if (txn && txn.workspaceId !== currentWorkspace(s)) {
    await endTxn(txn, 'rollback', tx('ws.txn.switched'));
    txn = undefined;
  }
  if (isPost && (body.mode === 'commit' || body.mode === 'rollback')) {
    const done = await finishTxn(req, s, tabKey, txn, body.mode === 'commit' ? 'commit' : 'rollback');
    if (!done.busy) txn = undefined;
    if (done.ok) txnInfo = done.message;
    else txnError = done.message;
  }
  if (isPost && text.trim() && !['nav', 'save', 'save_as', 'rename', 'download', 'commit', 'rollback'].includes(String(body.mode ?? ''))) {
    const m: RunMode = MODES.find((x) => x === body.mode) ?? 'statement';
    const allRows = body.mode === 'statement_all';
    chartAsked = body.mode === 'chart';
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
    const explaining = m === 'explain' || m === 'autotrace';
    // (sprint 107) which connection: the tab's transaction (open, or opened now), or one of its own
    const useTxn = statements.length > 0 && txnAsked && (!explaining || (!!txn && txnState(txn) !== 'none'));
    if (statements.length) {
      const blocked = txnAsked && !explaining ? statements.find((x) => !x.psql && outsideTxnOnly(x.sql)) : undefined;
      if (txn && !txnAsked) txnError = tx('ws.txn.open_first');
      else if (txnAsked && !tabKey) txnError = tx('ws.txn.needs_js');
      else if (txn && (asApp?.id ?? null) !== txn.asAppId) txnError = tx('ws.txn.runs_as', { who: txn.runsAs });
      else if (txn?.busy) txnError = tx('ws.txn.busy');
      else if (blocked) txnError = tx('ws.txn.not_in_txn', { line: blocked.line, what: outsideTxnOnly(blocked.sql) });
    }
    if (statements.length && !txnError) {
      ran = { start: statements[0].start, end: statements[statements.length - 1].end };
      const started = performance.now();
      const runOn = (c: pg.ClientBase, inTxn: boolean) => explaining
        ? explainStatement(c, statements[0], m === 'autotrace', inTxn)
        : runStatements(c, text, statements, { continueOnError: m === 'script' && continueOnError, gridRows: allRows ? ALL_ROWS : GRID_ROWS });
      const failedRun = (e: unknown): WorksheetRun => ({ results: [{ n: 1, line: statements[0].line, sql: statements[0].sql, start: 0, end: 0, status: 'error', error: (e as Error).message, ms: 0 }], notices: [], failed: 1, ms: 0 });
      if (useTxn) {
        if (!txn) {
          const note = txnNote(s.id, tabKey);
          const began = await beginTxn({ sessionId: s.id, username: s.username!, workspaceId: currentWorkspace(s), tab: tabKey, db: asApp ? await devDbForApp(asApp.id) : db,
            asApp: asApp ?? null, runsAs: asApp ? tx('ws.runs_as_role', { role: asApp.db_role, app: asApp.name }) : workshopRunsAs(db), searchSchema });
          if (typeof began === 'string') txnError = began;
          else {
            txn = began;
            if (note) txnInfo = tx('ws.txn.new_started', { note });
          }
        }
        if (txn) {
          const t = txn;
          t.busy = true;
          try {
            run = await runOn(t.client, true);
          } catch (e) {
            run = failedRun(e);
          } finally {
            t.busy = false;
            t.lastMs = Date.now();
          }
        }
      } else {
        // a connection of its own, closed afterwards: the SQL may SET ROLE or change settings, which must not
        // leak into the builder's pooled connections
        const c = await (asApp ? await devDbForApp(asApp.id) : db).pool.connect();
        try {
          if (searchSchema) await c.query(`select set_config('search_path', $1, false)`, [`${pg.escapeIdentifier(searchSchema)}, public`]);
          if (asApp) {
            await c.query(`select set_config('pgkiln.app_id', $1, false)`, [String(asApp.id)]);
            await c.query(`set role ${pg.escapeIdentifier(asApp.db_role)}`);
          }
          run = await runOn(c, false);
          // (sprint 107) a BEGIN typed in Autocommit lasts for the run only: say so when it was left open
          if (!explaining && c.getTransactionStatus() !== 'I') {
            await c.query('rollback').catch(() => {});
            run.notices.push({ level: 'WARNING', message: tx('ws.txn.begin_left'), n: run.results.filter((r) => r.status !== 'not_run').length, at: new Date().toISOString().slice(11, 23) });
          }
        } catch (e) {
          run = failedRun(e);
        } finally {
          c.release(true);
        }
      }
      // the log and history show the statements as written (with :NAME), not with the values
      if (run) for (const r of run.results) r.sql = picked[r.n - 1]?.sql ?? r.sql;
      // (sprint 107) the transaction's statements and DDL; a COMMIT / ROLLBACK typed in the editor ended it
      let committedDdl: string[] | null = null;
      if (txn && run && !explaining) {
        committedDdl = accountRun(txn, run.results);
        if (txnState(txn) === 'none' && findTxn(s.id, tabKey) === txn) {
          await endTxn(txn, 'rollback'); // nothing open: just closes the connection
          txn = undefined;
          txnInfo = tx('ws.txn.ended_editor');
        }
      }
      if (txn && findTxn(s.id, tabKey) !== txn) txn = undefined; // the database ended the connection
      if (run && (mode === 'statement' || mode === 'script')) {
        clearCompletions(); // the statements may have changed tables or grants
        await recordHistory(s, run);
        // (sprint 106, DA-17) the DDL that succeeded goes into the change log (in a transaction: when it commits)
        await recordChanges({ workspaceId: currentWorkspace(s), author: s.username ?? '?', source: 'worksheet', defaultSchema: searchSchema ?? 'public',
          statements: committedDdl ?? run.results.filter((r) => r.status === 'ok').map((r) => r.sql) });
        const detail = picked.map((x) => x.sql).join(';\n');
        await logActivity({ username: s.username, event: 'sql_command', ip: clientIp(req), elapsedMs: Math.round(performance.now() - started), detail: detail.length > 2000 ? `${detail.slice(0, 2000)}…` : detail });
      }
    }
  }
  const history = (await owner.query<HistoryRow>(
    `select id, sql, status, rows, ms, error, runs, at from meta.sql_history where username = $1 and workspace_id = $2 order by id desc limit $3`,
    [s.username, currentWorkspace(s), HISTORY_SHOWN])).rows;
  const lastQuery = [...(run?.results ?? [])].reverse().find((r) => r.status === 'ok' && r.columns);
  // (sprint 97, DA-6) Create Chart: the last query drawn, its settings and Save
  let chartPane: Raw | null = null;
  let chartCss = '';
  if (chartAsked && lastQuery?.columns) {
    const spec = chartSpec(lastQuery.columns, lastQuery.numeric ?? [], askedSpec(body));
    if (!spec) chartPane = html`<p class="muted">${tx('ws.chart.nothing')}</p>`;
    else {
      const d = drawChart('', lastQuery.columns, lastQuery.data ?? [], spec);
      chartCss = d.css;
      chartPane = html`${chartControls(lastQuery.columns, spec)}
        <div class="ch-actions"><button class="btn btn-sm" name="mode" value="chart">${icon('refresh')} ${tx('ws.chart.again')}</button>
          <input type="hidden" name="chart_sql" value="${lastQuery.sql}">
          <label class="sr-only" for="ws-chart-name">${tx('ws.chart.name')}</label><input id="ws-chart-name" name="chart_name" placeholder="${tx('ws.chart.name')}" maxlength="120">
          <button class="btn btn-sm btn-hot" formaction="${BASE}/sql/charts">${icon('save')} ${tx('ws.chart.save')}</button></div>
        <div class="ch-view">${d.body}</div>`;
    }
  }
  const { panes, active, status } = outputPanes(run, mode, history, String(req.query?.tab ?? ''), chartPane, tx);
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
      <h2 id="ws-binds-title">${tx('ws.binds.title')}</h2>
      <p class="muted small">${tx.rich('ws.binds.help', { bind: html`<code>:NAME</code>`, sub: html`<code>&amp;NAME.</code>` })}</p>
      <input type="hidden" name="binds_given" value="1">
      <div class="ws-binds-fields">${askValues.binds.map((n) => html`<label class="field"><span class="label"><code>:${n}</code></span><input name="bind_${n}" value="${remembered[`:${n}`] ?? ''}" autocomplete="off"></label>`)}${askValues.subs.map((n) => html`<label class="field"><span class="label"><code>&amp;${n}.</code></span><input name="sub_${n}" value="${remembered[`&${n}`] ?? ''}" autocomplete="off"></label>`)}</div>
      <div class="buttons"><button class="btn btn-hot" name="mode" value="${askValues.mode}">${icon('play')} ${tx('common.run')}</button><button class="btn" name="mode" value="nav" data-ws-binds-cancel>${tx('common.cancel')}</button></div>
    </dialog>` : '';
  const runsAs = asApp ? tx('ws.runs_as_role', { role: asApp.db_role, app: asApp.name }) : workshopRunsAs(db);
  // (sprint 107) the transaction badge: the real state of the tab's transaction on the server
  const tState = txnState(txn);
  const tNote = !txn && tabKey ? txnNote(s.id, tabKey) : null;
  if (tState === 'aborted' && !txnError) txnError = tx('ws.txn.aborted');
  const txnOn = txnAsked || !!txn;
  const badge = txnBadge(tState, txn?.statements ?? 0, txn?.startedMs ?? null, tNote, tx);

  const toolBtn = (m: RunMode, ic: string, label: string, key: string, hot = false) =>
    html`<button class="btn btn-sm${hot ? ' btn-hot' : ''}" name="mode" value="${m}" title="${label} (${key})" data-ws-key="${key}">${icon(ic)}<span>${label}</span></button>`;
  const main = html`${chartCss ? html`<style nonce="${req.cspNonce}">${raw(chartCss.replace(/</g, ''))}</style>` : ''}<div class="ws-page">
    <h1 class="sr-only">${tx('ws.title')}</h1>
    ${workshopTabs('sql', s)}
    <form method="post" action="${BASE}/sql/worksheet" class="ws" id="ws" data-ran="${ran ? `${ran.start},${ran.end}` : ''}" data-error-line="${firstError?.errorLine ?? ''}"
      data-source="${source}" data-script-id="${script?.id ?? ''}" data-script-name="${script?.name ?? ''}" data-tab="${tabKey}">${csrf(s)}
      <button class="ws-default" name="mode" value="nav" tabindex="-1">${tx('ws.refresh_nav')}</button>
      <input type="hidden" name="sel_start" value=""><input type="hidden" name="sel_end" value="">
      <input type="hidden" name="script_id" value="${script?.id ?? ''}"><input type="hidden" name="ws_tab" value="${tabKey}">
      ${bindDialog}
      <aside class="ws-nav" id="ws-nav" aria-label="${tx('ws.navigator')}">
        <div class="ws-nav-switch" role="tablist" aria-label="${tx('ws.navigator')}" hidden>
          <button type="button" role="tab" aria-selected="true" aria-controls="ws-nav-objects" data-ws-navtab="objects">${tx('ws.objects')}</button>
          <button type="button" role="tab" aria-selected="false" aria-controls="ws-files" data-ws-navtab="files">${tx('ws.files')}</button>
        </div>
        <div id="ws-nav-objects" class="ws-nav-panel">
        <div class="ws-nav-head">
          <label class="sr-only" for="ws-schema">${tx('ws.schema')}</label>
          <select id="ws-schema" name="nav_schema" data-ws-nav>${navSchemas.map((n) => html`<option value="${n}"${n === navSchema ? raw(' selected') : ''}>${n}</option>`)}</select>
          <label class="sr-only" for="ws-type">${tx('ws.object_type')}</label>
          <select id="ws-type" name="nav_type" data-ws-nav>${NAV_TYPES.map(([k, label]) => html`<option value="${k}"${k === navType ? raw(' selected') : ''}>${tx.dyn(`ob.type.${k}`, label)}</option>`)}</select>
          <div class="ws-nav-search">
            <label class="sr-only" for="ws-filter">${tx('ws.search_objects')}</label>
            <input id="ws-filter" type="search" placeholder="${tx('common.search')}" autocomplete="off" data-ws-filter>
            <button class="btn btn-sm btn-icon" name="mode" value="nav" title="${tx('ws.refresh')}">${icon('refresh')}<span class="sr-only">${tx('ws.refresh')}</span></button>
          </div>
        </div>
        <div class="ws-nav-body" id="ws-nav-body">${await navigatorTree(db, navSchema, navType, tx)}</div>
        </div>
        <section id="ws-files" class="ws-nav-panel ws-files" aria-label="${tx('ws.files')}">
          <h2 class="ws-files-title">${tx('ws.files')} <small class="muted">${tx('ws.sql_scripts')}</small></h2>
          ${files.length ? html`<ul>${files.map((f) => html`<li><a href="${BASE}/sql/worksheet?script=${f.id}"${script?.id === f.id ? raw(' aria-current="true"') : ''}>${icon('file')}<span>${f.name}</span></a></li>`)}</ul>` : html`<p class="muted small">${tx('ws.no_scripts')}</p>`}
        </section>
      </aside>
      <div class="ws-split ws-split-v" role="separator" aria-orientation="vertical" aria-label="${tx('ws.resize_nav')}" tabindex="0" data-ws-split="nav" hidden></div>
      <section class="ws-main" aria-label="${tx('ws.worksheet')}">
        <div class="ws-toolbar" role="toolbar" aria-label="${tx('ws.worksheet')}">
          <button type="button" class="btn btn-sm btn-icon" data-ws-toggle-nav title="${tx('ws.toggle_nav')}" hidden>${bicon('left')}<span class="sr-only">${tx('ws.navigator')}</span></button>
          <details class="menu ws-file"><summary class="btn btn-sm" title="${tx('ws.file.menu')}">${icon('file')}<span class="ws-file-name">${script?.name ?? tx('ws.untitled')}</span></summary>
            <div class="menu-panel"><div class="menu-section ws-file-panel">
              <label class="label" for="ws-name">${tx('ws.name')}</label>
              <input id="ws-name" name="ws_name" value="${script?.name ?? ''}" maxlength="200" autocomplete="off">
              <div class="ws-file-actions">
                <button class="btn btn-sm btn-hot" name="mode" value="save" title="${tx('ws.save_title')}">${icon('save')} ${tx('ws.key.save')}</button>
                ${script ? html`<button class="btn btn-sm" name="mode" value="save_as">${tx('ws.save_as')}</button><button class="btn btn-sm" name="mode" value="rename">${tx('ws.rename')}</button>` : ''}
                <button class="btn btn-sm" name="mode" value="download">${icon('download')} ${tx('ws.download')}</button>
              </div>
              <div class="ws-file-actions"><a class="btn btn-sm" href="${BASE}/sql/worksheet?new=1" data-ws-new>${icon('plus')} ${tx('ws.new')}</a><a class="btn btn-sm" href="#ws-files" data-ws-open>${tx('ws.open_file')}</a>
                ${script ? html`<input type="hidden" name="pin_href" value="${BASE}/sql/worksheet?script=${script.id}"><input type="hidden" name="pin_label" value="${script.name}"><input type="hidden" name="back" value="${BASE}/sql/worksheet?script=${script.id}">
                  <button class="btn btn-sm" formaction="${BASE}/pins" title="${tx('ws.pin_title')}">${icon('pin')} ${tx('ws.pin')}</button>` : ''}</div>
            </div></div></details>
          ${toolBtn('statement', 'play', tx('ws.run_statement'), 'Ctrl+Enter', true)}
          ${toolBtn('script', 'file', tx('ws.run_script'), 'F5')}
          ${toolBtn('explain', 'route', tx('ws.tab.explain'), 'F10')}
          ${toolBtn('autotrace', 'activity', tx('ws.tab.autotrace'), 'F6')}
          <label class="ws-check"><input type="checkbox" name="continue_on_error"${continueOnError ? raw(' checked') : ''}> ${tx('ws.continue')}</label>
          <span class="ws-spacer"></span>
          <button type="button" class="btn btn-sm btn-icon" data-ws-format title="${tx('ws.format_title')}" hidden>${icon('sliders')}<span class="sr-only">${tx('ws.format')}</span></button>
          <button type="button" class="btn btn-sm btn-icon" data-ws-case title="${tx('ws.case_title')}" hidden><span aria-hidden="true" class="ws-aa">Aa</span><span class="sr-only">${tx('ws.case')}</span></button>
          <button type="button" class="btn btn-sm btn-icon" data-ws-find title="${tx('ws.find_title')}" hidden>${icon('search')}<span class="sr-only">${tx('ws.find')}</span></button>
          <a class="btn btn-sm btn-icon" href="${BASE}/sql/load?schema=${encodeURIComponent(navSchema)}" title="${tx('ws.load_title')}">${icon('upload')}<span class="sr-only">${tx('ws.load')}</span></a>
          <details class="menu ws-keys"><summary class="btn btn-sm btn-icon" title="${tx('ws.keys')}">?<span class="sr-only">${tx('ws.keys')}</span></summary>
            <div class="menu-panel align-right"><div class="menu-section"><dl class="ws-keylist">
              <dt>Ctrl+Enter</dt><dd>${tx('ws.run_statement')}</dd><dt>F5</dt><dd>${tx('ws.run_script')}</dd><dt>F10</dt><dd>${tx('ws.tab.explain')}</dd><dt>F6</dt><dd>${tx('ws.tab.autotrace')}</dd>
              <dt>Ctrl+S</dt><dd>${tx('ws.key.save')}</dd><dt>Ctrl+F7</dt><dd>${tx('ws.format')}</dd><dt>Ctrl+B</dt><dd>${tx('ws.case')}</dd><dt>Ctrl+F / Ctrl+H</dt><dd>${tx('ws.key.find')}</dd>
              <dt>Ctrl+G</dt><dd>${tx('ws.key.goto')}</dd><dt>Ctrl+/</dt><dd>${tx('ws.key.comment')}</dd><dt>Ctrl+Space</dt><dd>${tx('ws.key.suggest')}</dd><dt>F1</dt><dd>${tx('ws.key.help')}</dd><dt>Escape</dt><dd>${tx('ws.key.fullscreen')}</dd>
            </dl>
            <label class="ws-kwcase" hidden>${tx('ws.kwcase')} <select data-ws-kwcase><option value="lower">${tx('ws.lower')}</option><option value="upper">${tx('ws.upper')}</option></select></label>
            <a href="https://github.com/pgkiln/pgkiln/blob/main/docs/guide/03-builder.md#sql-workshop" target="_blank" rel="noopener" data-ws-help>${tx('ws.help')}</a></div></div></details>
          <span class="ws-txn" data-ws-txn data-state="${tState}" data-statements="${txn?.statements ?? 0}" data-started="${txn?.startedMs ?? ''}" data-last="${txn?.lastMs ?? ''}" data-idle="${txnIdleSeconds()}" data-note="${tNote ?? ''}" data-now="${Date.now()}" hidden>
            <label class="ws-runas"><span>${tx('ws.commit_label')}</span><select name="txn" data-ws-txn-mode title="${tx('ws.txn.mode_title')}">
              <option value="">${tx('ws.autocommit')}</option><option value="on"${txnOn ? raw(' selected') : ''}>${tx('ws.transaction')}</option></select></label>
            <span class="ws-txn-badge" data-ws-txn-badge data-state="${tState}" role="status" title="${tState === 'none' ? '' : tx('ws.txn.runs_as_title', { who: txn?.runsAs ?? '' })}">${badge}</span>
            <button class="btn btn-sm" name="mode" value="commit" data-ws-txn-commit title="${tx('ws.txn.commit_title')}"${txn ? '' : raw(' disabled')}>${icon('check')}<span>${tx('ws.commit_label')}</span></button>
            <button class="btn btn-sm" name="mode" value="rollback" data-ws-txn-rollback title="${tx('ws.txn.rollback_title')}"${txn ? '' : raw(' disabled')}>${icon('undo')}<span>${tx('ws.rollback')}</span></button>
          </span>
          <label class="ws-runas"><span>${tx('ws.run_as')}</span>
            <select name="as_app" title="${tx('ws.run_as_title')}">
              <option value="">${db === owner ? tx('ws.owner_conn') : tx('ws.ws_login')}</option>
              ${apps.map((a) => html`<option value="${a.id}"${asApp?.id === a.id ? raw(' selected') : ''}>${a.name} (${a.db_role})</option>`)}
            </select></label>
          <button type="button" class="btn btn-sm btn-icon" data-ws-clear title="${tx('ws.clear_title')}" hidden>${icon('trash')}<span class="sr-only">${tx('ws.clear')}</span></button>
          <button type="button" class="btn btn-sm btn-icon" data-ws-fullscreen title="${tx('ws.fullscreen_title')}" aria-pressed="false" hidden>${bicon('expand')}<span class="sr-only">${tx('ws.fullscreen')}</span></button>
        </div>
        <p class="ws-runs-as muted small">${tx('ws.runs_as', { who: runsAs })}${searchSchema ? html`; ${tx.rich('ws.search_path', { schema: html`<code>${searchSchema}</code>`, change: html`<a href="${BASE}/sql">${tx('ws.change')}</a>` })}` : ''}. <span data-ws-commit-note>${txnOn
          ? tx('ws.commit.txn', { idle: idleLabel(tx) })
          : tx('ws.commit.auto')}</span></p>
        ${fileError ? html`<p class="alert alert-error ws-file-error" role="alert">${fileError}</p>` : ''}
        ${txnError ? html`<p class="alert alert-error ws-txn-alert" role="alert">${txnError}</p>` : txnInfo ? html`<p class="alert alert-info ws-txn-alert" role="status">${txnInfo}</p>` : ''}
        <div class="ws-wtabs" role="group" aria-label="${tx('ws.worksheets')}" hidden></div>
        <div class="ws-findbar" hidden>
          <label class="sr-only" for="ws-find-q">${tx('ws.find')}</label><input id="ws-find-q" type="search" placeholder="${tx('ws.find')}" autocomplete="off" data-ws-find-q>
          <label class="sr-only" for="ws-find-r">${tx('ws.replace_with')}</label><input id="ws-find-r" placeholder="${tx('ws.replace_with')}" autocomplete="off" data-ws-find-r>
          <label class="ws-check"><input type="checkbox" data-ws-find-re> ${tx('ws.regex')}</label>
          <label class="ws-check"><input type="checkbox" data-ws-find-cs> ${tx('ws.match_case')}</label>
          <button type="button" class="btn btn-sm" data-ws-find-next>${tx('ws.next')}</button>
          <button type="button" class="btn btn-sm" data-ws-find-replace>${tx('ws.replace')}</button>
          <button type="button" class="btn btn-sm" data-ws-find-all>${tx('ws.replace_all')}</button>
          <label class="sr-only" for="ws-goto">${tx('ws.key.goto')}</label><input id="ws-goto" type="number" min="1" placeholder="${tx('ws.line_ph')}" class="ws-goto" data-ws-goto>
          <span class="muted small" data-ws-find-msg></span>
          <button type="button" class="btn btn-sm btn-icon" data-ws-find-close title="${tx('ws.close_esc')}">${icon('x-circle')}<span class="sr-only">${tx('ws.close')}</span></button>
        </div>
        <div class="ws-editor">
          <textarea id="ws-sql" name="sql" aria-label="SQL" class="code sql-editor" rows="14" spellcheck="false" data-code="plpgsql">${text || (isPost ? '' : 'select current_user, version();')}</textarea>
        </div>
        <div class="ws-split ws-split-h" role="separator" aria-orientation="horizontal" aria-label="${tx('ws.resize_out')}" tabindex="0" data-ws-split="out" hidden></div>
        <div class="ws-output" data-active="${active}">
          <div class="ws-tabs" role="tablist" aria-label="${tx('ws.output')}">${TABS.map(([k]) => html`<button type="button" role="tab" id="ws-tab-${k}" aria-controls="ws-pane-${k}" aria-selected="${k === active ? 'true' : 'false'}" data-ws-tab="${k}">${tx(`ws.tab.${k}`)}</button>`)}</div>
          ${TABS.map(([k]) => html`<section class="ws-pane" id="ws-pane-${k}" role="tabpanel" aria-labelledby="ws-tab-${k}" data-pane="${k}"><h2 class="ws-pane-title">${tx(`ws.tab.${k}`)}</h2>${panes[k]}</section>`)}
        </div>
      </section>
      <footer class="ws-status" role="status" aria-live="polite">${status}</footer>
    </form>
    ${downloadable ? html`<form method="post" action="${BASE}/sql/unload" id="ws-dl" class="ws-dl-form">${csrf(s)}<input type="hidden" name="source" value="query"><input type="hidden" name="query" value="${downloadable}"><input type="hidden" name="header" value="1"><input type="hidden" name="bom" value="1"></form>` : ''}
  </div>`;
  return send(reply, s, shell(s, tx('ws.title'), [['SQL Workshop', `${BASE}/sql`], [tx('ws.title')]], main, 'sql', { full: true }));
}

export async function worksheetRoutes(app: FastifyInstance) {
  for (const path of ['/sql/worksheet', '/sql/commands']) {
    app.get(`${BASE}${path}`, worksheet);
    app.post(`${BASE}${path}`, worksheet);
  }
  // (before sprint 61 SQL Commands was /builder/sql: a post there still runs)
  app.post(`${BASE}/sql`, worksheet);

  // (sprint 107, DA-2) transaction mode: a tab's transaction (the badge), Commit / Rollback without a reload (closing a
  // worksheet tab, switching to Autocommit). Always the caller's own session: another developer's tab doesn't exist here.
  app.get(`${BASE}/sql/worksheet/txn`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const tab = String(req.query?.tab ?? '');
    if (!/^[a-z0-9]{1,20}$/.test(tab)) return reply.code(400).send({ error: 'Which worksheet?' });
    return reply.header('Cache-Control', 'no-store').send(txnStatus(s, tab));
  });
  app.post(`${BASE}/sql/worksheet/txn`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const tab = String(req.body?.tab ?? '');
    const action = req.body?.action;
    if (!/^[a-z0-9]{1,20}$/.test(tab) || (action !== 'commit' && action !== 'rollback')) return reply.code(400).send({ error: 'Which worksheet, and commit or rollback?' });
    const t = findTxn(s.id, tab);
    const done = await finishTxn(req, s, tab, t && t.workspaceId === currentWorkspace(s) ? t : undefined, action);
    return reply.code(done.busy ? 409 : 200).header('Cache-Control', 'no-store').send({ ...done, ...txnStatus(s, tab) });
  });
  app.addHook('onClose', async () => endAllTxns());

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
    return reply.header('Cache-Control', 'private, no-store').type('text/html').send(String(await navigatorTree(db, schema, type, tr(s))));
  });
}
