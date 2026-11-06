import type { FastifyInstance } from 'fastify';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { owner } from '../db.ts';
import { root } from '../env.ts';
import { html, raw } from '../html.ts';
import { icon } from '../icons.ts';
import { DEBUG_LEVELS } from '../debug.ts';
import { isAdmin } from './locks.ts';
import { appHeader, back, BASE, csrf, developer, flash, region, select, send, shell, type Req } from './ui.ts';
import { scopedTx as tx } from './i18n.ts';

// App Builder → Activity → Debug messages (APEX: Debug Messages): the page
// views an application recorded while its debug level was on, and the timed
// entries of each (src/debug.ts, migration 051). Workspace utilities →
// Installation (APEX: instance administration, install/upgrade log): the
// migration runs (src/migrate.ts writes public.pgkiln_install_log) and every
// applied migration and example script. Administrators only.

const PAGE_SIZE = 50;
const LEVEL_NAMES: Record<number, string> = { 1: 'error', 2: 'warning', 4: 'info', 6: 'trace', 9: 'all' };
const levelName = (n: number) => LEVEL_NAMES[n] ?? String(n);
const levelTag = (n: number) => html`<span class="ev${n <= 2 ? raw(' ev-error') : ''}">${n} ${levelName(n)}</span>`;
const VERSION = (() => {
  try {
    return (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return '?';
  }
})();

const appOf = async (id: string) => (/^\d+$/.test(id) ? await owner.one('select * from meta.app where id = $1', [id]) : undefined);

export async function diagnosticsRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- debug messages
  app.get(`${BASE}/apps/:id/debug`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOf(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const pageNo = /^\d{1,9}$/.test(req.query.page ?? '') ? Number(req.query.page) : null;
    const user = (req.query.user ?? '').trim().slice(0, 200) || null;
    const before = /^\d{1,18}$/.test(req.query.before ?? '') ? req.query.before : null;
    const problems = req.query.problems === '1';
    const views = (
      await owner.query(
        `select v.id, v.started_at, v.page_no, p.name as page_name, v.method, v.path, v.username, v.status, v.level, v.elapsed_ms::float8 as ms, v.entries,
                (select count(*) from meta.debug_message m where m.view_id = v.id and m.level <= 2)::int as problems
           from meta.debug_view v left join meta.page p on p.app_id = v.app_id and p.page_no = v.page_no
          where v.app_id = $1 and ($2::int is null or v.page_no = $2) and ($3::text is null or lower(v.username) = lower($3))
            and ($4::bigint is null or v.id < $4)
            and (not $5 or v.status >= 400 or exists (select 1 from meta.debug_message m where m.view_id = v.id and m.level <= 2))
          order by v.id desc limit ${PAGE_SIZE + 1}`,
        [a.id, pageNo, user, before, problems],
      )
    ).rows;
    const more = views.length > PAGE_SIZE;
    if (more) views.pop();
    const total = (await owner.one('select count(*)::int as n from meta.debug_view where app_id = $1', [a.id])).n as number;
    const query = (extra: Record<string, string>) => {
      const q = new URLSearchParams();
      if (pageNo !== null) q.set('page', String(pageNo));
      if (user) q.set('user', user);
      if (problems) q.set('problems', '1');
      for (const [k, v] of Object.entries(extra)) q.set(k, v);
      return q.toString();
    };
    const main = html`${appHeader(a, 'activity', s)}
      <div class="columns">
        ${region(tx('diag.debug_level'), html`
          <p class="muted u-mt0">${a.debug_level
            ? tx.rich('diag.on', { state: html`<b>${tx('diag.on_state', { level: a.debug_level })}</b>`, fn: html`<code>meta.debug(level, text)</code>` })
            : tx.rich('diag.off', { fn: html`<code>meta.debug(level, text)</code>` })}</p>
          <form method="post" action="${BASE}/apps/${a.id}/debug/settings">${csrf(s)}
            <div class="form-grid">
              ${select('debug_level', tx('diag.debug_level'), String(a.debug_level), DEBUG_LEVELS.map(([n, label]): [string, string] => [String(n), label]), tx('diag.level_9_records_posted_item'))}
              ${select('debug_retention_days', tx('diag.keep_messages_for'), String(a.debug_retention_days), [1, 2, 7, 14, 30, 90].map((d): [string, string] => [String(d), `${d} day${d === 1 ? '' : 's'}`]))}
            </div>
            <div class="buttons"><button class="btn btn-hot">${tx('diag.save')}</button></div>
          </form>`)}
        ${region(tx('diag.page_views'), html`
          <form method="get" action="${BASE}/apps/${a.id}/debug" class="u-mb1">
            <div class="form-grid">
              <div class="field"><label class="label" for="f_page">${tx('diag.page')}</label><input id="f_page" name="page" type="number" min="1" value="${pageNo ?? ''}"></div>
              <div class="field"><label class="label" for="f_user">${tx('diag.user')}</label><input id="f_user" name="user" value="${user ?? ''}"></div>
            </div>
            <div class="field"><label class="check"><input type="checkbox" name="problems" value="1"${problems ? raw(' checked') : ''}> ${tx('diag.only_with_errors_or_warnings')}</label></div>
            <div class="buttons"><button class="btn">${icon('search')} ${tx('diag.filter')}</button></div>
          </form>
          ${views.length
            ? html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>${tx('diag.when')}</th><th class="num">${tx('diag.page')}</th><th>${tx('diag.request')}</th><th>${tx('diag.user')}</th><th class="num">${tx('diag.status')}</th><th class="num">ms</th><th class="num">${tx('diag.entries')}</th><th></th></tr></thead>
              <tbody>${views.map((v) => html`<tr>
                <td data-label="${tx('diag.when')}">${String(v.started_at).slice(0, 19)}</td>
                <td class="num" data-label="${tx('diag.page')}">${v.page_no ?? ''}${v.page_name ? html` <span class="muted">${v.page_name}</span>` : ''}</td>
                <td data-label="${tx('diag.request')}"><code>${v.method} ${v.path}</code></td>
                <td data-label="${tx('diag.user')}">${v.username ?? ''}</td>
                <td class="num" data-label="${tx('diag.status')}">${v.status >= 400 ? html`<span class="ev ev-error">${v.status}</span>` : v.status}</td>
                <td class="num" data-label="ms">${v.ms}</td>
                <td class="num" data-label="${tx('diag.entries')}">${v.entries}${v.problems ? html` <span class="ev ev-error">${v.problems} problem${v.problems === 1 ? '' : 's'}</span>` : ''}</td>
                <td><a href="${BASE}/apps/${a.id}/debug/${v.id}">${tx('diag.view')}</a></td></tr>`)}</tbody></table></div>
              ${more ? html`<p><a class="btn" href="?${query({ before: String(views[views.length - 1].id) })}">${tx('diag.older_page_views')}</a></p>` : ''}`
            : html`<p class="muted">No page views recorded${pageNo !== null || user || problems ? ' for this filter' : ''}.</p>`}
          <p class="muted">${total} page view${total === 1 ? '' : 's'} kept for ${a.debug_retention_days} day${a.debug_retention_days === 1 ? '' : 's'} (at most 5000). <a href="${BASE}/apps/${a.id}/activity">${tx('diag.back_to_activity')}</a></p>
          ${total
            ? html`<form method="post" action="${BASE}/apps/${a.id}/debug/purge">${csrf(s)}
                <button class="btn btn-danger" data-confirm="${tx('diag.delete_confirm', { app: a.name })}">${icon('close')} ${tx('diag.delete_all_debug_messages')}</button></form>`
            : ''}`)}
      </div>`;
    return send(reply, s, shell(s, tx('diag.title', { app: a.name }), [[tx('diag.app_builder'), BASE], [a.name, `${BASE}/apps/${a.id}`], [tx('diag.activity'), `${BASE}/apps/${a.id}/activity`], [tx('diag.debug_messages')]], main));
  });

  app.get(`${BASE}/apps/:id/debug/:view`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOf(req.params.id);
    if (!a || !/^\d{1,18}$/.test(req.params.view)) return reply.code(404).send('Not found');
    const v = await owner.one(
      `select v.*, v.elapsed_ms::float8 as ms, p.name as page_name,
              (select max(id) from meta.debug_view o where o.app_id = v.app_id and o.id < v.id) as prev,
              (select min(id) from meta.debug_view o where o.app_id = v.app_id and o.id > v.id) as next
         from meta.debug_view v left join meta.page p on p.app_id = v.app_id and p.page_no = v.page_no
        where v.id = $1 and v.app_id = $2`,
      [req.params.view, a.id],
    );
    if (!v) return reply.code(404).send('Not found');
    const entries = (
      await owner.query(
        `select seq, elapsed_ms::float8 as ms, duration_ms::float8 as dur, level, component, message,
                (lead(elapsed_ms) over (order by seq) - elapsed_ms)::float8 as gap
           from meta.debug_message where view_id = $1 order by seq`,
        [v.id],
      )
    ).rows;
    const slowest = Math.max(0, ...entries.map((e) => e.dur ?? 0));
    const main = html`${appHeader(a, 'activity', s)}
      ${region(tx('diag.page_view', { id: v.id }), html`
        <div class="stat-grid">
          <div class="stat"><b>${v.ms ?? '?'} ms</b><span>${tx('diag.total_time')}</span></div>
          <div class="stat"><b>${v.page_no ?? '-'}</b><span>${v.page_name ?? 'page'}</span></div>
          <div class="stat"><b>${v.status ?? '?'}</b><span>${tx('diag.http_status')}</span></div>
          <div class="stat"><b>${v.entries}</b><span>entries (level ${v.level})</span></div>
        </div>
        <p class="muted u-mt0"><code>${v.method} ${v.path}</code> · ${v.username ?? ''} · ${String(v.started_at).slice(0, 23)}</p>
        <p class="seg">
          ${v.prev ? html`<a href="${BASE}/apps/${a.id}/debug/${v.prev}">${tx('diag.previous')}</a>` : ''}
          <a href="${BASE}/apps/${a.id}/debug">${tx('diag.all_page_views')}</a>
          ${v.page_no ? html`<a href="${BASE}/apps/${a.id}/debug?page=${v.page_no}">Page ${v.page_no} only</a>` : ''}
          ${v.next ? html`<a href="${BASE}/apps/${a.id}/debug/${v.next}">${tx('diag.next')}</a>` : ''}
        </p>
        <div class="table-wrap"><table class="report report-reflow debug-log"><thead><tr><th class="num">${tx('diag.elapsed_ms')}</th><th class="num">${tx('diag.duration_ms')}</th><th class="num">${tx('diag.until_next')}</th><th>${tx('diag.level')}</th><th>${tx('diag.component')}</th><th>${tx('diag.message')}</th></tr></thead>
          <tbody>${entries.map((e) => html`<tr${e.dur && e.dur === slowest && slowest > 0 ? raw(' class="debug-slowest"') : ''}>
            <td class="num" data-label="${tx('diag.elapsed_ms')}">${e.ms}</td>
            <td class="num" data-label="${tx('diag.duration_ms')}">${e.dur ?? ''}</td>
            <td class="num" data-label="${tx('diag.until_next')}">${e.gap ?? ''}</td>
            <td data-label="${tx('diag.level')}">${levelTag(e.level)}</td>
            <td data-label="${tx('diag.component')}">${e.component ?? ''}</td>
            <td data-label="${tx('diag.message')}" class="debug-text">${e.message}</td></tr>`)}</tbody></table></div>`)}`;
    return send(reply, s, shell(s, tx('diag.view_title', { id: v.id, app: a.name }), [[tx('diag.app_builder'), BASE], [a.name, `${BASE}/apps/${a.id}`], [tx('diag.debug_messages'), `${BASE}/apps/${a.id}/debug`], [tx('diag.page_view', { id: v.id })]], main));
  });

  app.post(`${BASE}/apps/:id/debug/settings`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOf(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const level = Number(req.body?.debug_level);
    const days = Number(req.body?.debug_retention_days);
    if (!DEBUG_LEVELS.some(([n]) => n === level) || !Number.isInteger(days) || days < 1 || days > 90) {
      flash(s, tx('diag.choose_a_debug_level_and'), 'error');
      return back(reply, s, `${BASE}/apps/${a.id}/debug`);
    }
    await owner.query('update meta.app set debug_level = $2, debug_retention_days = $3, updated_at = now() where id = $1', [a.id, level, days]);
    flash(s, level ? tx('diag.on_flash', { level }) : tx('diag.debug_messages_off'));
    return back(reply, s, `${BASE}/apps/${a.id}/debug`);
  });

  app.post(`${BASE}/apps/:id/debug/purge`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOf(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const n = (await owner.query('delete from meta.debug_view where app_id = $1', [a.id])).rowCount ?? 0;
    flash(s, `${n} page view${n === 1 ? '' : 's'} deleted.`);
    return back(reply, s, `${BASE}/apps/${a.id}/debug`);
  });

  // ---------------------------------------------------------------- install / upgrade log
  app.get(`${BASE}/installation`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    if (!(await isAdmin(s.username))) {
      const main = html`<h1 class="u-mb1">${tx('diag.installation')}</h1><div class="alert alert-error" role="alert">${tx('diag.only_administrators_see_the_installation')}</div>`;
      return send(reply.code(403), s, shell(s, tx('diag.installation'), [[tx('diag.app_builder'), BASE], [tx('diag.workspace_utilities'), `${BASE}/utilities`], [tx('diag.installation')]], main));
    }
    const has = async (t: string) => !!(await owner.one('select to_regclass($1) is not null as ok', [t]))?.ok;
    const [runs, migrations, examples] = await Promise.all([
      has('public.pgkiln_install_log').then((ok) => (ok ? owner.query('select * from public.pgkiln_install_log order by id desc limit 100').then((r) => r.rows) : [])),
      has('public.pgkiln_migration').then((ok) => (ok ? owner.query('select name, applied_at from public.pgkiln_migration order by name desc').then((r) => r.rows) : [])),
      has('public.pgkiln_seed').then((ok) => (ok ? owner.query('select name, applied_at from public.pgkiln_seed order by applied_at desc, name desc').then((r) => r.rows) : [])),
    ]);
    const dir = join(root, 'db/migrations');
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.sql')).sort() : [];
    const applied = new Set(migrations.map((m) => m.name as string));
    const pending = files.filter((f) => !applied.has(f));
    const unknown = migrations.filter((m) => !files.includes(m.name));
    const db = await owner.one(`select current_database() as name, split_part(version(), ' on ', 1) as version, pg_size_pretty(pg_database_size(current_database())) as size`);
    const main = html`<h1 class="u-mb1">${tx('diag.installation')}</h1>
      <div class="stat-grid">
        <div class="stat"><b>${VERSION}</b><span>${tx('diag.pgkiln_version_of_this_server')}</span></div>
        <div class="stat"><b>${migrations.length}</b><span>${migrations[0] ? tx('diag.applied_latest', { name: migrations[0].name.replace(/\.sql$/, '') }) : tx('diag.applied_n')}</span></div>
        <div class="stat"><b>${pending.length}</b><span>${tx('diag.migrations_not_applied')}</span></div>
        <div class="stat"><b>${db.size}</b><span>${db.name} · ${db.version}</span></div>
      </div>
      ${pending.length
        ? html`<div class="alert alert-error" role="alert">${tx.rich(pending.length === 1 ? 'diag.missing_1' : 'diag.missing', { n: pending.length, list: pending.join(', '), npm: html`<code>npm run db:migrate</code>`, cli: html`<code>pgkiln migrate</code>` })}</div>`
        : ''}
      ${unknown.length ? html`<div class="alert alert-error" role="alert">${tx('diag.unknown', { list: unknown.map((m) => m.name).join(', ') })}</div>` : ''}
      <div class="columns">
        ${region(tx('diag.install_and_upgrade_runs'), runs.length
          ? html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>${tx('diag.started')}</th><th>${tx('diag.kind')}</th><th>${tx('diag.version')}</th><th>${tx('diag.status')}</th><th class="num">${tx('diag.files')}</th><th>${tx('diag.applied')}</th><th>${tx('diag.by')}</th></tr></thead>
            <tbody>${runs.map((r) => html`<tr>
              <td data-label="${tx('diag.started')}">${String(r.started_at).slice(0, 19)}</td><td data-label="${tx('diag.kind')}">${r.kind}</td><td data-label="${tx('diag.version')}">${r.version ?? ''}</td>
              <td data-label="${tx('diag.status')}">${r.status === 'ok' ? html`<span class="ev ev-login">ok</span>` : html`<span class="ev ev-error">failed</span>`}${r.error ? html`<div class="small">${r.error}</div>` : ''}</td>
              <td class="num" data-label="${tx('diag.files')}">${r.applied.length}</td>
              <td data-label="${tx('diag.applied')}" class="debug-text">${r.applied.join(', ')}</td><td data-label="${tx('diag.by')}">${r.db_user}</td></tr>`)}</tbody></table></div>`
          : html`<p class="muted u-mt0">${tx.code('diag.no_runs_recorded_yet_runs')}</p>`)}
        ${region(tx('diag.applied_migrations'), html`<div class="table-wrap"><table class="report"><thead><tr><th>${tx('diag.file')}</th><th>${tx('diag.applied')}</th></tr></thead>
          <tbody>${migrations.map((m) => html`<tr><td><code>${m.name}</code></td><td>${String(m.applied_at).slice(0, 19)}</td></tr>`)}</tbody></table></div>`)}
        ${examples.length
          ? region(tx('diag.example_and_seed_scripts'), html`<div class="table-wrap"><table class="report"><thead><tr><th>${tx('diag.file')}</th><th>${tx('diag.applied')}</th></tr></thead>
              <tbody>${examples.map((m) => html`<tr><td><code>${m.name}</code></td><td>${String(m.applied_at).slice(0, 19)}</td></tr>`)}</tbody></table></div>`)
          : ''}
      </div>`;
    return send(reply, s, shell(s, tx('diag.installation'), [[tx('diag.app_builder'), BASE], [tx('diag.workspace_utilities'), `${BASE}/utilities`], [tx('diag.installation')]], main));
  });
}
