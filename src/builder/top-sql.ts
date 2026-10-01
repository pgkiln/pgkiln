import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw } from '../html.ts';
import { icon } from '../icons.ts';
import { appHeader, back, BASE, csrf, developer, flash, region, send, shell, type Req } from './ui.ts';

// App Builder → Activity → Top SQL: the statements the application's
// database role ran, from pg_stat_statements (APEX: Top SQL in the
// Monitor Activity pages). Applications that share a role share the list.

const SORTS: Record<string, string> = { total: 'total_exec_time', mean: 'mean_exec_time', calls: 'calls', rows: 'rows' };

export type TopSql =
  | { ok: true; rows: { queryid: string; calls: number; total_ms: number; mean_ms: number; rows: number; share: number; query: string }[] }
  | { ok: false; reason: 'no_role' | 'not_installed' | 'not_loaded' | 'error'; message?: string };

/** The role's statements, slowest in total first (or by mean time, calls or rows). */
export async function topSql(role: string | null, sort = 'total', limit = 50): Promise<TopSql> {
  if (!role) return { ok: false, reason: 'no_role' };
  if (!(await owner.one(`select 1 as ok from pg_extension where extname = 'pg_stat_statements'`))) return { ok: false, reason: 'not_installed' };
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
    const sort = SORTS[req.query.sort ?? ''] ? req.query.sort! : 'total';
    const top = await topSql(a.db_role, sort);
    const sortLink = (key: string, label: string) =>
      html`<a href="${BASE}/apps/${a.id}/top-sql?sort=${key}"${sort === key ? raw(' aria-current="true"') : ''}>${label}</a>`;
    const body = top.ok
      ? top.rows.length
        ? html`<div class="seg u-mb1">Sort by ${sortLink('total', 'total time')} ${sortLink('mean', 'time per call')} ${sortLink('calls', 'calls')} ${sortLink('rows', 'rows')}</div>
            <div class="table-wrap"><table class="report report-reflow top-sql"><thead><tr><th class="num">Calls</th><th class="num">Total ms</th><th class="num">Mean ms</th><th class="num">Rows</th><th class="num">Share</th><th>Statement</th></tr></thead>
            <tbody>${top.rows.map((r) => html`<tr>
              <td class="num" data-label="Calls">${r.calls}</td><td class="num" data-label="Total ms">${r.total_ms}</td><td class="num" data-label="Mean ms">${r.mean_ms}</td>
              <td class="num" data-label="Rows">${r.rows}</td><td class="num" data-label="Share">${r.share ?? 0}%</td>
              <td data-label="Statement"><code class="sql-text">${r.query}</code></td></tr>`)}</tbody></table></div>
            <form method="post" action="${BASE}/apps/${a.id}/top-sql/reset" class="u-mt1">${csrf(s)}
              <button class="btn" data-confirm="Clear the statistics of role ${a.db_role}?">${icon('history')} Reset the statistics</button></form>`
        : html`<p class="muted">No statements recorded for <code>${a.db_role}</code> yet. Use the application, then come back.</p>`
      : top.reason === 'no_role'
        ? html`<div class="alert alert-error" role="alert">This application runs as the owner role, so its statements can't be told apart. Give it a database role in Settings.</div>`
        : html`<div class="alert alert-error" role="alert">${top.reason === 'not_installed'
            ? html`The <code>pg_stat_statements</code> extension isn't installed. As a superuser: <code>create extension pg_stat_statements;</code>`
            : top.reason === 'not_loaded'
              ? html`The server doesn't load <code>pg_stat_statements</code> yet. Set <code>shared_preload_libraries = 'pg_stat_statements'</code> (the development <code>docker-compose.yml</code> does) and restart PostgreSQL.`
              : html`The statistics could not be read: ${top.message}`}</div>`;
    const main = html`${appHeader(a, 'activity')}
      ${region('Top SQL', html`<p class="muted u-mt0">Statements run as the role <code>${a.db_role ?? '(owner)'}</code> since the statistics were last reset, from <code>pg_stat_statements</code>. Literals and binds show as <code>$1</code>, <code>$2</code>…; applications that share a role share this list. <a href="${BASE}/apps/${a.id}/activity">Back to Activity</a></p>
        ${body}`)}`;
    return send(reply, s, shell(s, `Top SQL · ${a.name}`, [['App Builder', BASE], [a.name, `${BASE}/apps/${a.id}`], ['Activity', `${BASE}/apps/${a.id}/activity`], ['Top SQL']], main));
  });

  app.post(`${BASE}/apps/:id/top-sql/reset`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOf(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    try {
      if (!a.db_role) throw new Error('The application has no database role.');
      await owner.query(`select pg_stat_statements_reset((select oid from pg_roles where rolname = $1), (select oid from pg_database where datname = current_database()), 0)`, [a.db_role]);
      flash(s, 'Statistics reset.');
    } catch (e) {
      flash(s, (e as Error).message, 'error');
    }
    return back(reply, s, `${BASE}/apps/${a.id}/top-sql`);
  });
}
