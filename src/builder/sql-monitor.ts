import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { parsePlan, planText, type Plan } from '../sqlplan.ts';
import { splitScript } from '../sqlscript.ts';
import type { Session } from '../session.ts';
import { back, BASE, csrf, developer, flash, region, send, shell, workshopTabs, type Req } from './ui.ts';
import { isAdmin } from './locks.ts';
import { planView } from './plan-view.ts';
import { statementsNote, statementsState } from './top-sql.ts';
import { tr, type BuilderKey, type BuilderTranslate } from './i18n.ts';

// (sprint 102, Database Actions DA-14) SQL Workshop › SQL Monitor, for administrators: Database Actions' Real Time
// SQL Monitor and Performance Hub on PostgreSQL's statistics views.
//  - Sessions (GET /builder/sql/monitor): the client sessions of this database (pg_stat_activity) with what they
//    run, wait for and who blocks them, a summary of wait events and the maintenance commands in progress
//    (pg_stat_progress_*). public/sql-monitor.js reloads the live part every 5, 15 or 60 seconds (?fragment=1),
//    with a pause button; without JavaScript, Refresh reloads the page. A row's Cancel / Terminate post to
//    /builder/sql/monitor/session (pg_cancel_backend / pg_terminate_backend), after a confirmation.
//  - Top SQL (GET /builder/sql/monitor/top): pg_stat_statements for the whole database, sortable by any column,
//    total and mean time as bars; Reset statistics posts to /builder/sql/monitor/reset.
//  - A statement (GET /builder/sql/monitor/statements/:queryid): its text, its totals per role, an Explain Plan
//    (EXPLAIN only, never ANALYZE: it is someone else's statement; a text with $1 parameters gets a generic plan,
//    PostgreSQL 16+), and Open in worksheet.
// Every read runs read only with a statement timeout, as the owner connection.

const URL_BASE = `${BASE}/sql/monitor`;
export const REFRESH_SECONDS = [5, 15, 60] as const;

type Row = Record<string, unknown>;

async function readOnly<T>(fn: (q: (sql: string, params?: unknown[]) => Promise<Row[]>) => Promise<T>): Promise<T> {
  return owner.tx(async (c) => {
    await c.query('set transaction read only');
    await c.query(`set local statement_timeout = '10s'`);
    return fn(async (sql, params) => (await c.query(sql, params)).rows);
  });
}

const crumbs = (tx: BuilderTranslate, ...more: [string, string?][]): [string, string?][] => [[tx('rail.sql_workshop'), `${BASE}/sql`], [tx('sql.tool.monitor'), more.length ? URL_BASE : undefined], ...more];
const num = (v: unknown) => (v == null ? '' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 }));
const QUERYID_RE = /^-?\d{1,20}$/;

/** A bar (an SVG: the CSP allows no style attributes) for `value` out of `max`, next to the number. */
const bar = (value: number, max: number) =>
  html`<svg class="sm-bar" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true" focusable="false"><rect class="sm-bar-track" width="100" height="8"></rect><rect class="sm-bar-fill" width="${max > 0 ? Math.max(1, Math.round((value / max) * 100)) : 0}" height="8"></rect></svg>`;

const viewTabs = (tx: BuilderTranslate, active: 'sessions' | 'top') =>
  html`<nav class="seg u-mb1" aria-label="${tx('sm.views')}">
    <a href="${URL_BASE}"${active === 'sessions' ? raw(' aria-current="page"') : ''}>${tx('sm.sessions')}</a>
    <a href="${URL_BASE}/top"${active === 'top' ? raw(' aria-current="page"') : ''}>${tx('sql.tool.topsql')}</a></nav>`;

// ------------------------------------------------------------------ sessions

async function liveData(showIdle: boolean) {
  return readOnly(async (q) => ({
    sessions: await q(
      `select a.pid, a.usename as "user", a.application_name as app, a.client_addr::text as client, a.state,
              a.wait_event_type as wait_type, a.wait_event as wait, a.query_id::text as queryid,
              case when a.state = 'active' then round(extract(epoch from now() - a.query_start)::numeric, 1) end as running_s,
              case when a.state like 'idle in transaction%' then round(extract(epoch from now() - a.state_change)::numeric, 1) end as idle_tx_s,
              round(extract(epoch from now() - a.xact_start)::numeric, 1) as tx_s,
              pg_blocking_pids(a.pid) as blocked_by, left(a.query, 2000) as query
         from pg_stat_activity a
        where a.datname = current_database() and a.backend_type = 'client backend' and a.pid <> pg_backend_pid()
          and ($1 or a.state is distinct from 'idle')
        order by a.state = 'active' desc, a.query_start nulls last limit 200`, [showIdle]),
    totals: (await q(
      `select count(*)::int as sessions, count(*) filter (where state = 'active')::int as active,
              count(*) filter (where state like 'idle in transaction%')::int as idle_tx,
              count(*) filter (where cardinality(pg_blocking_pids(pid)) > 0)::int as blocked,
              coalesce(max(extract(epoch from now() - query_start)) filter (where state = 'active'), 0)::numeric(12, 1)::float8 as longest,
              (select setting::int from pg_settings where name = 'max_connections') as max
         from pg_stat_activity where datname = current_database() and backend_type = 'client backend' and pid <> pg_backend_pid()`))[0],
    waits: await q(
      `select coalesce(wait_event_type, 'CPU') as type, coalesce(wait_event, 'running') as event, count(*)::int as sessions
         from pg_stat_activity
        where state = 'active' and pid <> pg_backend_pid() and (datname = current_database() or datname is null)
        group by 1, 2 order by 3 desc, 1, 2`),
    progress: await q(
      `select pid, 'VACUUM' as command, relid::regclass::text as relation, phase,
              case when heap_blks_total > 0 then round(100.0 * heap_blks_scanned / heap_blks_total) end::int as pct
         from pg_stat_progress_vacuum where datname = current_database()
       union all
       select pid, 'ANALYZE', relid::regclass::text, phase,
              case when sample_blks_total > 0 then round(100.0 * sample_blks_scanned / sample_blks_total) end::int
         from pg_stat_progress_analyze where datname = current_database()
       union all
       select pid, command, coalesce(index_relid::regclass::text, relid::regclass::text), phase,
              case when blocks_total > 0 then round(100.0 * blocks_done / blocks_total)
                   when tuples_total > 0 then round(100.0 * tuples_done / tuples_total) end::int
         from pg_stat_progress_create_index where datname = current_database()
       union all
       select pid, command, relid::regclass::text, phase,
              case when heap_blks_total > 0 then round(100.0 * heap_blks_scanned / heap_blks_total) end::int
         from pg_stat_progress_cluster where datname = current_database()
       union all
       select pid, command || ' ' || type, relid::regclass::text, tuples_processed || ' rows',
              case when bytes_total > 0 then round(100.0 * bytes_processed / bytes_total) end::int
         from pg_stat_progress_copy where datname = current_database()
       order by pid`),
  }));
}

/** The part of the Sessions view that public/sql-monitor.js reloads in place. */
async function livePart(s: Session, showIdle: boolean): Promise<Raw> {
  const tx = tr(s);
  const d = await liveData(showIdle);
  const t = d.totals as Record<string, number>;
  const backTo = `${URL_BASE}${showIdle ? '?idle=1' : ''}`;
  const action = (pid: unknown, kind: 'cancel' | 'terminate') => html`<form method="post" action="${URL_BASE}/session" class="sm-action">${csrf(s)}
    <input type="hidden" name="pid" value="${String(pid)}"><input type="hidden" name="action" value="${kind}"><input type="hidden" name="idle" value="${showIdle ? '1' : ''}">
    <button class="btn btn-sm${kind === 'terminate' ? ' btn-danger' : ''}" data-confirm="${kind === 'cancel' ? tx('sm.cancel_confirm', { pid: String(pid) }) : tx('sm.terminate_confirm', { pid: String(pid) })}"
      aria-label="${kind === 'cancel' ? tx('sm.cancel_label', { pid: String(pid) }) : tx('sm.terminate_label', { pid: String(pid) })}">${kind === 'cancel' ? tx('sm.cancel') : tx('sm.terminate')}</button></form>`;
  return html`<div class="stat-grid u-mb1">
      ${([[tx('sm.sessions'), `${t.sessions} / ${t.max}`], [tx('sm.active'), t.active], [tx('sm.idle_tx'), t.idle_tx], [tx('sm.blocked'), t.blocked], [tx('sm.longest'), t.longest]] as [string, unknown][])
        .map(([l, v]) => html`<div class="stat"><b>${String(v)}</b><span>${l}</span></div>`)}
    </div>
    ${region(tx('sm.sessions'), html`<p class="muted u-mt0">${showIdle ? tx('sm.sessions_intro_all') : tx('sm.sessions_intro')}
        <a href="${showIdle ? URL_BASE : `${URL_BASE}?idle=1`}">${showIdle ? tx('sm.hide_idle') : tx('sm.show_idle')}</a>.
        ${tx.rich('sm.query_text_note', { role: html`<code>pg_read_all_stats</code>` })}</p>
      <div class="table-wrap"><table class="report report-reflow sm-sessions">
      <thead><tr><th class="num">PID</th><th>${tx('sm.col.user')}</th><th>${tx('sm.col.application')}</th><th>${tx('sm.col.state')}</th><th>${tx('sm.col.wait')}</th><th class="num">${tx('sm.col.running')}</th><th>${tx('sm.col.blocked_by')}</th><th>${tx('sm.col.query')}</th><th>${tx('sm.col.actions')}</th></tr></thead>
      <tbody>${d.sessions.length ? d.sessions.map((x) => html`<tr${(x.blocked_by as number[]).length ? raw(' class="is-blocked"') : ''}>
        <td class="num" data-label="PID">${String(x.pid)}</td>
        <td data-label="${tx('sm.col.user')}">${String(x.user ?? '')}</td>
        <td data-label="${tx('sm.col.application')}" class="u-break">${String(x.app ?? '')}${x.client ? html` <span class="muted">${String(x.client)}</span>` : ''}</td>
        <td data-label="${tx('sm.col.state')}">${x.idle_tx_s != null ? html`<span class="tag tag-warning">${String(x.state)} ${String(x.idle_tx_s)} s</span>` : String(x.state ?? '')}</td>
        <td data-label="${tx('sm.col.wait')}">${x.wait_type ? `${x.wait_type}: ${x.wait ?? ''}` : ''}</td>
        <td class="num" data-label="${tx('sm.col.running')}">${x.running_s != null ? String(x.running_s) : ''}</td>
        <td data-label="${tx('sm.col.blocked_by')}">${(x.blocked_by as number[]).length ? html`<span class="tag tag-warning">${(x.blocked_by as number[]).join(', ')}</span>` : ''}</td>
        <td data-label="${tx('sm.col.query')}" class="u-break">${x.query ? x.queryid && x.queryid !== '0'
          ? html`<a href="${URL_BASE}/statements/${String(x.queryid)}" title="${tx('sm.statement_link')}"><code>${String(x.query).slice(0, 500)}</code></a>`
          : html`<code>${String(x.query).slice(0, 500)}</code>` : ''}</td>
        <td data-label="${tx('sm.col.actions')}"><div class="sm-actions">${x.state === 'active' ? action(x.pid, 'cancel') : ''}${action(x.pid, 'terminate')}</div></td></tr>`)
        : html`<tr><td colspan="9" class="empty">${showIdle ? tx('sm.no_other') : tx('sm.no_busy')}</td></tr>`}</tbody></table></div>`)}
    ${region(tx('sm.waits'), html`<p class="muted u-mt0">${tx.rich('sm.waits_intro', { cpu: html`<em>${tx('sm.cpu_running')}</em>` })}</p>
      ${d.waits.length ? html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>${tx('sm.col.type')}</th><th>${tx('sm.col.event')}</th><th class="num">${tx('sm.sessions')}</th></tr></thead>
        <tbody>${d.waits.map((w) => html`<tr><td data-label="${tx('sm.col.type')}">${String(w.type)}</td><td data-label="${tx('sm.col.event')}">${String(w.event)}</td><td class="num" data-label="${tx('sm.sessions')}">${String(w.sessions)}</td></tr>`)}</tbody></table></div>`
        : html`<p class="muted">${tx('sm.no_other_active')}</p>`}`)}
    ${d.progress.length ? region(tx('sm.in_progress'), html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th class="num">PID</th><th>${tx('sm.col.command')}</th><th>${tx('sm.col.object')}</th><th>${tx('sm.col.phase')}</th><th>${tx('sm.col.done')}</th></tr></thead>
      <tbody>${d.progress.map((p) => html`<tr><td class="num" data-label="PID">${String(p.pid)}</td><td data-label="${tx('sm.col.command')}">${String(p.command)}</td>
        <td data-label="${tx('sm.col.object')}" class="u-break">${String(p.relation ?? '')}</td><td data-label="${tx('sm.col.phase')}">${String(p.phase ?? '')}</td>
        <td data-label="${tx('sm.col.done')}">${p.pct != null ? html`<progress max="100" value="${String(p.pct)}" aria-label="${String(p.command)} ${String(p.pid)}"></progress> ${String(p.pct)}%` : ''}</td></tr>`)}</tbody></table></div>`) : ''}
    <p class="muted small sm-updated" data-sm-updated>${tx('sm.updated', { time: new Date().toISOString().slice(11, 19) })} · <a href="${backTo}">${tx('sm.refresh')}</a></p>`;
}

// ------------------------------------------------------------------ Top SQL

const SORTS: Record<string, { col: string; label: BuilderKey; asc?: boolean }> = {
  role: { col: 'r.rolname', label: 'sm.col.role', asc: true },
  calls: { col: 's.calls', label: 'sm.col.calls' },
  total: { col: 's.total_exec_time', label: 'sm.col.total_ms' },
  mean: { col: 's.mean_exec_time', label: 'sm.col.mean_ms' },
  rows: { col: 's.rows', label: 'sm.col.rows' },
  hit: { col: 's.shared_blks_hit', label: 'sm.col.hit' },
  read: { col: 's.shared_blks_read', label: 'sm.col.read' },
  query: { col: 's.query', label: 'sm.col.statement', asc: true },
};

export interface TopRow { queryid: string | null; role: string | null; calls: number; total_ms: number; mean_ms: number; rows: number; hit: number; read: number; query: string }

/** pg_stat_statements of this database, by `sort` (a SORTS key), optionally filtered on the text. */
export async function topStatements(sort: string, desc: boolean, filter: string, limit = 100): Promise<TopRow[]> {
  const by = SORTS[sort] ?? SORTS.total;
  return (await readOnly((q) => q(
    `select s.queryid::text as queryid, r.rolname as role, s.calls::float8 as calls, round(s.total_exec_time::numeric, 2)::float8 as total_ms,
            round(s.mean_exec_time::numeric, 3)::float8 as mean_ms, s.rows::float8 as rows, s.shared_blks_hit::float8 as hit,
            s.shared_blks_read::float8 as read, left(s.query, 1000) as query
       from pg_stat_statements s left join pg_roles r on r.oid = s.userid
      where s.dbid = (select oid from pg_database where datname = current_database())
        and ($1 = '' or s.query ilike '%' || replace(replace(replace($1, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%')
      order by ${by.col} ${desc ? 'desc' : 'asc'} nulls last, s.queryid limit $2`, [filter, limit]))) as unknown as TopRow[];
}

// ------------------------------------------------------------------ Explain

const EXPLAINABLE = /^(select|with|insert|update|delete|merge|values|table)\b/i;

export type MonitorPlan = { ok: true; plan: Plan; text: string; generic: boolean } | { ok: false; error: string; key?: BuilderKey };

/**
 * EXPLAIN (never ANALYZE) of a statement someone else ran: one statement only, of a kind that has a plan, in a
 * read-only transaction that is rolled back, with timeouts. A normalised text with $1… gets a generic plan
 * (PostgreSQL 16+). `schema` is put first in the search path, as unqualified names were resolved in the original.
 */
export async function explainForMonitor(sql: string, schema: string | null): Promise<MonitorPlan> {
  const stmts = splitScript(sql);
  if (stmts.length !== 1 || stmts[0].psql) return { ok: false, error: 'Only one SQL statement can be explained.', key: 'sm.err.one' };
  const text = stmts[0].sql;
  if (!EXPLAINABLE.test(text)) return { ok: false, error: 'Only SELECT, INSERT, UPDATE, DELETE, MERGE and VALUES statements have a plan.', key: 'sm.err.kind' };
  const generic = /\$\d+/.test(text);
  const c = await owner.pool.connect();
  try {
    if (generic && Number((await c.query(`select current_setting('server_version_num') as v`)).rows[0].v) < 160000)
      return { ok: false, error: 'The statement has parameters ($1, …): PostgreSQL 16 or later can explain it with a generic plan. Open it in the worksheet and fill in values.', key: 'sm.err.generic' };
    await c.query('begin transaction read only');
    await c.query(`set local statement_timeout = '5s'`);
    await c.query(`set local lock_timeout = '1s'`);
    if (schema) await c.query(`select set_config('search_path', format('%I, public', $1::text), true)`, [schema]);
    // the extended protocol (Parse/Bind): the server accepts one statement only, whatever the text hides; a generic
    // plan's parameters are bound to nulls, which it doesn't look at
    const params = Math.max(0, ...[...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
    if (params > 100) return { ok: false, error: 'The statement has too many parameters to explain.', key: 'sm.err.params' };
    const out = await c.query({ text: `explain (format json, verbose, costs${generic ? ', generic_plan' : ''}) ${text}`, values: Array(params).fill(null), queryMode: 'extended' } as never);
    const json = (out as { rows: Row[] }).rows[0]?.['QUERY PLAN'];
    const plan = parsePlan(typeof json === 'string' ? JSON.parse(json) : json, false);
    return { ok: true, plan, text: planText(plan), generic };
  } catch (e) {
    const err = e as { message: string; code?: string };
    return { ok: false, error: `${err.message}${err.code ? ` (${err.code})` : ''}` };
  } finally {
    await c.query('rollback').catch(() => {});
    c.release();
  }
}

// ------------------------------------------------------------------ routes

/** The administrator's session, or a 403 (anonymous: the sign-in redirect). */
async function admin(req: Req, reply: Parameters<typeof developer>[1]) {
  const s = await developer(req, reply);
  if (!s) return null;
  if (!(await isAdmin(s.username))) {
    reply.code(403).send('Administrators only.');
    return null;
  }
  return s;
}

const statementOf = async (queryid: string) => {
  const rows = await readOnly((q) => q(
    `select r.rolname as role, s.toplevel, s.calls::float8 as calls, s.total_exec_time::float8 as total_ms, s.mean_exec_time::float8 as mean_ms,
            s.stddev_exec_time::float8 as stddev_ms, s.min_exec_time::float8 as min_ms, s.max_exec_time::float8 as max_ms, s.rows::float8 as rows,
            s.shared_blks_hit::float8 as hit, s.shared_blks_read::float8 as read, s.temp_blks_read::float8 as temp_read,
            s.temp_blks_written::float8 as temp_written, s.query
       from pg_stat_statements s left join pg_roles r on r.oid = s.userid
      where s.queryid = $1::bigint and s.dbid = (select oid from pg_database where datname = current_database())
      order by s.total_exec_time desc`, [queryid]));
  return rows;
};

export async function sqlMonitorRoutes(app: FastifyInstance) {
  app.get(URL_BASE, async (req: Req, reply) => {
    const s = await admin(req, reply);
    if (!s) return;
    const showIdle = req.query?.idle === '1';
    const live = await livePart(s, showIdle);
    if (req.query?.fragment === '1') return reply.header('cache-control', 'no-store').type('text/html').send(String(live));
    const tx = tr(s);
    const main = html`<h1 class="u-mb1">${tx('rail.sql_workshop')}</h1>${workshopTabs('monitor', s)}${viewTabs(tx, 'sessions')}
      <div class="sm-toolbar" data-sm-controls hidden>
        <label for="sm-interval">${tx('sm.refresh_every')}</label>
        <select id="sm-interval" data-sm-interval>${REFRESH_SECONDS.map((n) => html`<option value="${n}">${tx('sm.seconds', { n })}</option>`)}</select>
        <button type="button" class="btn btn-sm" data-sm-pause aria-pressed="false">${tx('sm.pause')}</button>
      </div>
      <div class="sm-live" data-sm-live="${URL_BASE}?${showIdle ? 'idle=1&' : ''}fragment=1" aria-live="off">${live}</div>`;
    return send(reply, s, shell(s, tx('sql.tool.monitor'), crumbs(tx), main, 'sql'));
  });

  app.post(`${URL_BASE}/session`, async (req: Req, reply) => {
    const s = await admin(req, reply);
    if (!s) return;
    const b = (req.body ?? {}) as Record<string, string>;
    const to = `${URL_BASE}${b.idle === '1' ? '?idle=1' : ''}`;
    if (!/^\d{1,9}$/.test(String(b.pid ?? '')) || !['cancel', 'terminate'].includes(String(b.action))) return reply.code(400).send('Bad request');
    // only a client session of this database, and not the connection doing it
    const target = await owner.one<{ pid: number }>(
      `select pid from pg_stat_activity where pid = $1 and datname = current_database() and backend_type = 'client backend' and pid <> pg_backend_pid()`, [Number(b.pid)]);
    const tx = tr(s);
    if (!target) {
      flash(s, tx('sm.not_client', { pid: String(b.pid) }), 'error');
      return back(reply, s, to);
    }
    try {
      const fn = b.action === 'cancel' ? 'pg_cancel_backend' : 'pg_terminate_backend';
      const r = await owner.one<{ ok: boolean }>(`select ${fn}($1) as ok`, [target.pid]);
      if (r?.ok) flash(s, b.action === 'cancel' ? tx('sm.cancelled', { pid: target.pid }) : tx('sm.terminated', { pid: target.pid }));
      else flash(s, tx('sm.not_signalled', { pid: target.pid }), 'error');
    } catch (e) {
      flash(s, (e as Error).message, 'error');
    }
    return back(reply, s, to);
  });

  app.get(`${URL_BASE}/top`, async (req: Req, reply) => {
    const s = await admin(req, reply);
    if (!s) return;
    const q = req.query ?? {};
    const sort = SORTS[q.sort ?? ''] ? q.sort! : 'total';
    const desc = q.dir ? q.dir !== 'asc' : !SORTS[sort].asc;
    const filter = String(q.q ?? '').slice(0, 200);
    const tx = tr(s);
    const state = await statementsState();
    let body: Raw;
    if (!state.ok) body = statementsNote(tx, state.reason, state.message);
    else {
      const [rows, info] = await Promise.all([
        topStatements(sort, desc, filter),
        readOnly((r) => r(`select to_char(stats_reset, 'YYYY-MM-DD HH24:MI') as reset, dealloc from pg_stat_statements_info`)).catch(() => [] as Row[]),
      ]);
      const maxTotal = Math.max(0, ...rows.map((r) => r.total_ms));
      const maxMean = Math.max(0, ...rows.map((r) => r.mean_ms));
      const link = (key: string) => {
        const on = key === sort;
        const nextDesc = on ? !desc : !SORTS[key].asc;
        const params = new URLSearchParams({ sort: key, dir: nextDesc ? 'desc' : 'asc', ...(filter ? { q: filter } : {}) });
        return html`<a href="${URL_BASE}/top?${params}" title="${tx('sm.sort_by', { column: tx(SORTS[key].label) })}">${tx(SORTS[key].label)}${on ? (desc ? ' ▼' : ' ▲') : ''}</a>`;
      };
      const th = (key: string, numeric = true) => html`<th${numeric ? raw(' class="num"') : ''}${key === sort ? raw(` aria-sort="${desc ? 'descending' : 'ascending'}"`) : ''}>${link(key)}</th>`;
      const i = info[0] as Row | undefined;
      body = html`<form method="get" action="${URL_BASE}/top" class="sm-filter u-mb1" role="search">
          <input type="hidden" name="sort" value="${sort}"><input type="hidden" name="dir" value="${desc ? 'desc' : 'asc'}">
          <label class="sr-only" for="sm-q">${tx('sm.contains')}</label><input id="sm-q" name="q" type="search" value="${filter}" maxlength="200" placeholder="${tx('sm.contains')}…">
          <button class="btn btn-sm">${icon('search')} ${tx('common.search')}</button></form>
        <div class="table-wrap"><table class="report report-reflow sm-top"><thead><tr>${th('role', false)}${th('calls')}${th('total')}${th('mean')}${th('rows')}${th('hit')}${th('read')}${th('query', false)}</tr></thead>
        <tbody>${rows.length ? rows.map((r) => html`<tr>
          <td data-label="${tx('sm.col.role')}">${r.role ?? ''}</td>
          <td class="num" data-label="${tx('sm.col.calls')}">${num(r.calls)}</td>
          <td class="num sm-barcell" data-label="${tx('sm.col.total_ms')}">${bar(r.total_ms, maxTotal)}<span>${num(r.total_ms)}</span></td>
          <td class="num sm-barcell" data-label="${tx('sm.col.mean_ms')}">${bar(r.mean_ms, maxMean)}<span>${num(r.mean_ms)}</span></td>
          <td class="num" data-label="${tx('sm.col.rows')}">${num(r.rows)}</td>
          <td class="num" data-label="${tx('sm.col.hit')}">${num(r.hit)}</td>
          <td class="num" data-label="${tx('sm.col.read')}">${num(r.read)}</td>
          <td data-label="${tx('sm.col.statement')}" class="u-break">${r.queryid ? html`<a href="${URL_BASE}/statements/${r.queryid}"><code class="sql-text">${r.query}</code></a>` : html`<code class="sql-text">${r.query}</code>`}</td></tr>`)
          : html`<tr><td colspan="8" class="empty">${filter ? tx('sm.no_match') : tx('sm.none_yet')}</td></tr>`}</tbody></table></div>
        <p class="muted small">${i?.reset ? `${tx('sm.since', { time: String(i.reset) })} ` : ''}${tx.rich('sm.at_most', { p1: html`<code>$1</code>`, p2: html`<code>$2</code>` })}</p>
        <form method="post" action="${URL_BASE}/reset">${csrf(s)}
          <button class="btn" data-confirm="${tx('sm.reset_confirm')}">${icon('history')} ${tx('sm.reset')}</button></form>`;
    }
    const main = html`<h1 class="u-mb1">${tx('rail.sql_workshop')}</h1>${workshopTabs('monitor', s)}${viewTabs(tx, 'top')}
      ${region(tx('sql.tool.topsql'), html`<p class="muted u-mt0">${tx.rich('sm.top_intro', { ext: html`<code>pg_stat_statements</code>` })}</p>${body}`)}`;
    return send(reply, s, shell(s, tx('sql.tool.topsql'), crumbs(tx, [tx('sql.tool.topsql')]), main, 'sql'));
  });

  app.post(`${URL_BASE}/reset`, async (req: Req, reply) => {
    const s = await admin(req, reply);
    if (!s) return;
    try {
      await owner.query('select pg_stat_statements_reset()');
      flash(s, tr(s)('sm.reset_done'));
    } catch (e) {
      flash(s, (e as Error).message, 'error');
    }
    return back(reply, s, `${URL_BASE}/top`);
  });

  app.get(`${URL_BASE}/statements/:queryid`, async (req: Req, reply) => {
    const s = await admin(req, reply);
    if (!s) return;
    const queryid = String(req.params.queryid);
    if (!QUERYID_RE.test(queryid)) return reply.code(404).send('Not found');
    const tx = tr(s);
    const state = await statementsState();
    if (!state.ok) {
      const main = html`<h1 class="u-mb1">${tx('sm.statement')}</h1>${statementsNote(tx, state.reason, state.message)}`;
      return send(reply, s, shell(s, tx('sm.statement'), crumbs(tx, [tx('sm.statement')]), main, 'sql'));
    }
    let rows: Row[];
    try {
      rows = await statementOf(queryid);
    } catch {
      return reply.code(404).send('Not found');
    }
    if (!rows.length) return reply.code(404).send('Not found');
    const sql = String(rows[0].query ?? '');
    const schemas = (await readOnly((q) => q(`select nspname from pg_namespace where nspname !~ '^pg_' and nspname <> 'information_schema' order by 1`))).map((r) => String(r.nspname));
    const schema = typeof req.query?.schema === 'string' && schemas.includes(req.query.schema) ? req.query.schema : '';
    const explained = req.query?.explain === '1' ? await explainForMonitor(sql, schema || null) : null;
    const sum = (k: string) => rows.reduce((a, r) => a + Number(r[k] ?? 0), 0);
    const calls = sum('calls');
    const total = sum('total_ms');
    const tile = (label: string, v: string) => html`<div class="stat"><b>${v}</b><span>${label}</span></div>`;
    const BY_ROLE: Record<string, BuilderKey> = { calls: 'sm.col.calls', total_ms: 'sm.col.total_ms', mean_ms: 'sm.col.mean_ms', stddev_ms: 'sm.col.stddev_ms', min_ms: 'sm.col.min_ms', max_ms: 'sm.col.max_ms', rows: 'sm.col.rows', hit: 'sm.col.hit_short', read: 'sm.col.read_short', temp_read: 'sm.col.temp_read', temp_written: 'sm.col.temp_written' };
    const main = html`<h1 class="u-mb1">${tx('sm.statement')}</h1>
      <div class="stat-grid u-mb1">${tile(tx('sm.col.calls'), num(calls))}${tile(tx('sm.col.total_ms'), num(total))}${tile(tx('sm.col.mean_ms'), num(calls ? total / calls : 0))}${tile(tx('sm.col.rows'), num(sum('rows')))}
        ${tile(tx('sm.col.hit'), num(sum('hit')))}${tile(tx('sm.col.read'), num(sum('read')))}${tile(tx('sm.temp_blocks_written'), num(sum('temp_written')))}</div>
      ${region(tx('sm.text'), html`<pre class="source u-break sm-sql" data-code-view="sql" tabindex="0" aria-label="${tx('sm.sql_text')}">${sql}</pre>
        <div class="buttons"><form method="post" action="${URL_BASE}/statements/${queryid}/worksheet">${csrf(s)}<button class="btn">${icon('code')} ${tx('sm.open_worksheet')}</button></form>
          <a class="btn" href="${URL_BASE}/top">${tx('sm.back_top')}</a></div>`)}
      ${region(tx('sm.by_role'), html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>${tx('sm.col.role')}</th>${Object.values(BY_ROLE).map((k) => html`<th class="num">${tx(k)}</th>`)}</tr></thead>
        <tbody>${rows.map((r) => html`<tr><td data-label="${tx('sm.col.role')}">${String(r.role ?? '')}${r.toplevel === false ? html` <span class="tag">${tx('sm.nested')}</span>` : ''}</td>
          ${Object.entries(BY_ROLE).map(([k, label]) => html`<td class="num" data-label="${tx(label)}">${num(r[k])}</td>`)}</tr>`)}</tbody></table></div>`)}
      ${region(tx('sm.explain_plan'), html`<p class="muted u-mt0">${/\$\d+/.test(sql) ? tx('sm.explain_intro_params') : tx('sm.explain_intro')}</p>
        <form method="get" action="${URL_BASE}/statements/${queryid}" class="sm-filter u-mb1"><input type="hidden" name="explain" value="1">
          <label for="sm-schema">${tx('sm.schema')}</label><select id="sm-schema" name="schema"><option value="">${tx('sm.search_path')}</option>${schemas.map((n) => html`<option value="${n}"${n === schema ? raw(' selected') : ''}>${n}</option>`)}</select>
          <button class="btn">${icon('play')} ${tx('sm.explain')}</button></form>
        ${explained ? explained.ok ? planView(explained.plan, explained.text) : html`<div class="alert alert-error" role="alert">${explained.key ? tx(explained.key) : explained.error}</div>` : ''}`)}`;
    return send(reply, s, shell(s, tx('sm.statement'), crumbs(tx, [tx('sm.statement')]), main, 'sql'));
  });

  app.post(`${URL_BASE}/statements/:queryid/worksheet`, async (req: Req, reply) => {
    const s = await admin(req, reply);
    if (!s) return;
    const queryid = String(req.params.queryid);
    if (!QUERYID_RE.test(queryid) || !(await statementsState()).ok) return reply.code(404).send('Not found');
    const rows = await statementOf(queryid).catch(() => [] as Row[]);
    if (!rows.length) return reply.code(404).send('Not found');
    s.state.__SQLDRAFT = String(rows[0].query ?? '');
    return back(reply, s, `${BASE}/sql/worksheet`);
  });
}
