import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw } from '../html.ts';
import { icon } from '../icons.ts';
import { appHeader, back, BASE, csrf, developer, flash, region, send, shell, type Req } from './ui.ts';
import { tr, type BuilderTranslate } from './i18n.ts';

// App Builder → Activity → Top SQL: the statements the application's
// database role ran, from pg_stat_statements (APEX: Top SQL in the
// Monitor Activity pages). Applications that share a role share the list.

const SORTS: Record<string, string> = { total: 'total_exec_time', mean: 'mean_exec_time', calls: 'calls', rows: 'rows' };

export type TopSql =
  | { ok: true; rows: { queryid: string; calls: number; total_ms: number; mean_ms: number; rows: number; share: number; query: string }[] }
  | { ok: false; reason: 'no_role' | 'not_installed' | 'not_loaded' | 'error'; message?: string };

/** (sprint 102) Whether pg_stat_statements can be read: created in this database and loaded by the server. */
export async function statementsState(): Promise<{ ok: true } | { ok: false; reason: 'not_installed' | 'not_loaded' | 'error'; message?: string }> {
  if (!(await owner.one(`select 1 as ok from pg_extension where extname = 'pg_stat_statements'`))) return { ok: false, reason: 'not_installed' };
  try {
    await owner.query('select 1 from pg_stat_statements limit 1');
    return { ok: true };
  } catch (e) {
    const message = (e as Error).message;
    return { ok: false, reason: /shared_preload_libraries/.test(message) ? 'not_loaded' : 'error', message };
  }
}

/** Why the statistics can't be shown, and how to turn them on. */
export function statementsNote(tx: BuilderTranslate, reason: 'not_installed' | 'not_loaded' | 'error', message?: string) {
  const ext = html`<code>pg_stat_statements</code>`;
  const setting = html`<code>shared_preload_libraries = 'pg_stat_statements'</code>`;
  return html`<div class="alert alert-error" role="alert">${reason === 'not_installed'
    ? tx.rich('topsql.not_installed', { ext, setting, alter: html`<code>alter system set shared_preload_libraries = 'pg_stat_statements'</code>`, create: html`<code>create extension pg_stat_statements;</code>` })
    : reason === 'not_loaded'
      ? tx.rich('topsql.not_loaded', { ext, setting, compose: html`<code>docker-compose.yml</code>` })
      : tx('topsql.read_error', { message: message ?? '' })}</div>`;
}

/** The role's statements, slowest in total first (or by mean time, calls or rows). */
export async function topSql(role: string | null, sort = 'total', limit = 50): Promise<TopSql> {
  if (!role) return { ok: false, reason: 'no_role' };
  const state = await statementsState();
  if (!state.ok) return state;
  try {
    const res = await owner.query(
      `select queryid::text, calls::int, round(total_exec_time::numeric, 1)::float8 as total_ms, round(mean_exec_time::numeric, 2)::float8 as mean_ms,
              rows::bigint::float8 as rows, round((100 * total_exec_time / nullif(sum(total_exec_time) over (), 0))::numeric, 1)::float8 as share, query
         from pg_stat_statements
        where userid = (select oid from pg_roles where rolname = $1)
          and dbid = (select oid from pg_database where datname = current_database())
        order by ${SORTS[sort] ?? SORTS.total} desc
        limit $2`,
      [role, limit],
    );
    return { ok: true, rows: res.rows };
  } catch (e) {
    const message = (e as Error).message;
    return { ok: false, reason: /shared_preload_libraries/.test(message) ? 'not_loaded' : 'error', message };
  }
}

export async function topSqlRoutes(app: FastifyInstance) {
  const appOf = async (id: string) => (/^\d+$/.test(id) ? await owner.one('select * from meta.app where id = $1', [id]) : undefined);

  app.get(`${BASE}/apps/:id/top-sql`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOf(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const tx = tr(s);
    const sort = SORTS[req.query.sort ?? ''] ? req.query.sort! : 'total';
    const top = await topSql(a.db_role, sort);
    const sortLink = (key: string, label: string) =>
      html`<a href="${BASE}/apps/${a.id}/top-sql?sort=${key}"${sort === key ? raw(' aria-current="true"') : ''}>${label}</a>`;
    const body = top.ok
      ? top.rows.length
        ? html`<div class="seg u-mb1">${tx.rich('topsql.sort_by', { total: sortLink('total', tx('topsql.sort.total')), mean: sortLink('mean', tx('topsql.sort.mean')), calls: sortLink('calls', tx('topsql.sort.calls')), rows: sortLink('rows', tx('topsql.sort.rows')) })}</div>
            <div class="table-wrap"><table class="report report-reflow top-sql"><thead><tr><th class="num">${tx('sm.col.calls')}</th><th class="num">${tx('sm.col.total_ms')}</th><th class="num">${tx('sm.col.mean_ms')}</th><th class="num">${tx('sm.col.rows')}</th><th class="num">${tx('topsql.share')}</th><th>${tx('sm.col.statement')}</th></tr></thead>
            <tbody>${top.rows.map((r) => html`<tr>
              <td class="num" data-label="${tx('sm.col.calls')}">${r.calls}</td><td class="num" data-label="${tx('sm.col.total_ms')}">${r.total_ms}</td><td class="num" data-label="${tx('sm.col.mean_ms')}">${r.mean_ms}</td>
              <td class="num" data-label="${tx('sm.col.rows')}">${r.rows}</td><td class="num" data-label="${tx('topsql.share')}">${r.share ?? 0}%</td>
              <td data-label="${tx('sm.col.statement')}"><code class="sql-text">${r.query}</code></td></tr>`)}</tbody></table></div>
            <form method="post" action="${BASE}/apps/${a.id}/top-sql/reset" class="u-mt1">${csrf(s)}
              <button class="btn" data-confirm="${tx('topsql.reset_confirm', { role: a.db_role })}">${icon('history')} ${tx('topsql.reset')}</button></form>`
        : html`<p class="muted">${tx.rich('topsql.none_yet', { role: html`<code>${a.db_role}</code>` })}</p>`
      : top.reason === 'no_role'
        ? html`<div class="alert alert-error" role="alert">${tx('topsql.no_role')}</div>`
        : statementsNote(tx, top.reason, top.message);
    const main = html`${appHeader(a, 'activity', s)}
      ${region(tx('sql.tool.topsql'), html`<p class="muted u-mt0">${tx.rich('topsql.intro', { role: html`<code>${a.db_role ?? tx('topsql.owner')}</code>`, ext: html`<code>pg_stat_statements</code>`, p1: html`<code>$1</code>`, p2: html`<code>$2</code>` })} <a href="${BASE}/apps/${a.id}/activity">${tx('topsql.back_activity')}</a></p>
        ${body}`)}`;
    return send(reply, s, shell(s, `${tx('sql.tool.topsql')} · ${a.name}`, [[tx('rail.app_builder'), BASE], [a.name, `${BASE}/apps/${a.id}`], [tx('topsql.activity'), `${BASE}/apps/${a.id}/activity`], [tx('sql.tool.topsql')]], main));
  });

  app.post(`${BASE}/apps/:id/top-sql/reset`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOf(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    try {
      if (!a.db_role) throw new Error(tr(s)('topsql.no_db_role'));
      await owner.query(`select pg_stat_statements_reset((select oid from pg_roles where rolname = $1), (select oid from pg_database where datname = current_database()), 0)`, [a.db_role]);
      flash(s, tr(s)('topsql.reset_done'));
    } catch (e) {
      flash(s, (e as Error).message, 'error');
    }
    return back(reply, s, `${BASE}/apps/${a.id}/top-sql`);
  });
}
