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
    const main = html`${appHeader(a, 'activity')}
      <div class="columns">
        ${region('Debug level', html`
          <p class="muted u-mt0">${a.debug_level
            ? html`<b>Debug messages are on (level ${a.debug_level})</b>: every request of this application records its steps with timings, and SQL can add messages with <code>meta.debug(level, text)</code>. This costs time and space: turn it off when you are done.`
            : html`Debug messages are off: requests record nothing, and <code>meta.debug(level, text)</code> returns at once. Choose a level to record the requests of this application.`}</p>
          <form method="post" action="${BASE}/apps/${a.id}/debug/settings">${csrf(s)}
            <div class="form-grid">
              ${select('debug_level', 'Debug level', String(a.debug_level), DEBUG_LEVELS.map(([n, label]): [string, string] => [String(n), label]), 'Level 9 records posted item values (never those of password items).')}
              ${select('debug_retention_days', 'Keep messages for', String(a.debug_retention_days), [1, 2, 7, 14, 30, 90].map((d): [string, string] => [String(d), `${d} day${d === 1 ? '' : 's'}`]))}
            </div>
            <div class="buttons"><button class="btn btn-hot">Save</button></div>
          </form>`)}
        ${region('Page views', html`
          <form method="get" action="${BASE}/apps/${a.id}/debug" class="u-mb1">
            <div class="form-grid">
              <div class="field"><label class="label" for="f_page">Page</label><input id="f_page" name="page" type="number" min="1" value="${pageNo ?? ''}"></div>
              <div class="field"><label class="label" for="f_user">User</label><input id="f_user" name="user" value="${user ?? ''}"></div>
            </div>
            <div class="field"><label class="check"><input type="checkbox" name="problems" value="1"${problems ? raw(' checked') : ''}> Only with errors or warnings</label></div>
            <div class="buttons"><button class="btn">${icon('search')} Filter</button></div>
          </form>
          ${views.length
            ? html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>When</th><th class="num">Page</th><th>Request</th><th>User</th><th class="num">Status</th><th class="num">ms</th><th class="num">Entries</th><th></th></tr></thead>
              <tbody>${views.map((v) => html`<tr>
                <td data-label="When">${String(v.started_at).slice(0, 19)}</td>
                <td class="num" data-label="Page">${v.page_no ?? ''}${v.page_name ? html` <span class="muted">${v.page_name}</span>` : ''}</td>
                <td data-label="Request"><code>${v.method} ${v.path}</code></td>
                <td data-label="User">${v.username ?? ''}</td>
                <td class="num" data-label="Status">${v.status >= 400 ? html`<span class="ev ev-error">${v.status}</span>` : v.status}</td>
                <td class="num" data-label="ms">${v.ms}</td>
                <td class="num" data-label="Entries">${v.entries}${v.problems ? html` <span class="ev ev-error">${v.problems} problem${v.problems === 1 ? '' : 's'}</span>` : ''}</td>
                <td><a href="${BASE}/apps/${a.id}/debug/${v.id}">View</a></td></tr>`)}</tbody></table></div>
              ${more ? html`<p><a class="btn" href="?${query({ before: String(views[views.length - 1].id) })}">Older page views</a></p>` : ''}`
            : html`<p class="muted">No page views recorded${pageNo !== null || user || problems ? ' for this filter' : ''}.</p>`}
          <p class="muted">${total} page view${total === 1 ? '' : 's'} kept for ${a.debug_retention_days} day${a.debug_retention_days === 1 ? '' : 's'} (at most 5000). <a href="${BASE}/apps/${a.id}/activity">Back to Activity</a></p>
          ${total
            ? html`<form method="post" action="${BASE}/apps/${a.id}/debug/purge">${csrf(s)}
                <button class="btn btn-danger" data-confirm="Delete all debug messages of ${a.name}?">${icon('close')} Delete all debug messages</button></form>`
            : ''}`)}
      </div>`;
    return send(reply, s, shell(s, `Debug messages · ${a.name}`, [['App Builder', BASE], [a.name, `${BASE}/apps/${a.id}`], ['Activity', `${BASE}/apps/${a.id}/activity`], ['Debug messages']], main));
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
    const main = html`${appHeader(a, 'activity')}
      ${region(`Page view ${v.id}`, html`
        <div class="stat-grid">
          <div class="stat"><b>${v.ms ?? '?'} ms</b><span>total time</span></div>
          <div class="stat"><b>${v.page_no ?? '-'}</b><span>${v.page_name ?? 'page'}</span></div>
          <div class="stat"><b>${v.status ?? '?'}</b><span>HTTP status</span></div>
          <div class="stat"><b>${v.entries}</b><span>entries (level ${v.level})</span></div>
        </div>
        <p class="muted u-mt0"><code>${v.method} ${v.path}</code> · ${v.username ?? ''} · ${String(v.started_at).slice(0, 23)}</p>
        <p class="seg">
          ${v.prev ? html`<a href="${BASE}/apps/${a.id}/debug/${v.prev}">◂ Previous</a>` : ''}
          <a href="${BASE}/apps/${a.id}/debug">All page views</a>
          ${v.page_no ? html`<a href="${BASE}/apps/${a.id}/debug?page=${v.page_no}">Page ${v.page_no} only</a>` : ''}
          ${v.next ? html`<a href="${BASE}/apps/${a.id}/debug/${v.next}">Next ▸</a>` : ''}
        </p>
        <div class="table-wrap"><table class="report report-reflow debug-log"><thead><tr><th class="num">Elapsed ms</th><th class="num">Duration ms</th><th class="num">Until next</th><th>Level</th><th>Component</th><th>Message</th></tr></thead>
          <tbody>${entries.map((e) => html`<tr${e.dur && e.dur === slowest && slowest > 0 ? raw(' class="debug-slowest"') : ''}>
            <td class="num" data-label="Elapsed ms">${e.ms}</td>
            <td class="num" data-label="Duration ms">${e.dur ?? ''}</td>
            <td class="num" data-label="Until next">${e.gap ?? ''}</td>
            <td data-label="Level">${levelTag(e.level)}</td>
            <td data-label="Component">${e.component ?? ''}</td>
            <td data-label="Message" class="debug-text">${e.message}</td></tr>`)}</tbody></table></div>`)}`;
    return send(reply, s, shell(s, `Debug ${v.id} · ${a.name}`, [['App Builder', BASE], [a.name, `${BASE}/apps/${a.id}`], ['Debug messages', `${BASE}/apps/${a.id}/debug`], [`Page view ${v.id}`]], main));
  });

  app.post(`${BASE}/apps/:id/debug/settings`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOf(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const level = Number(req.body?.debug_level);
    const days = Number(req.body?.debug_retention_days);
    if (!DEBUG_LEVELS.some(([n]) => n === level) || !Number.isInteger(days) || days < 1 || days > 90) {
      flash(s, 'Choose a debug level and a retention of 1 to 90 days.', 'error');
      return back(reply, s, `${BASE}/apps/${a.id}/debug`);
    }
    await owner.query('update meta.app set debug_level = $2, debug_retention_days = $3, updated_at = now() where id = $1', [a.id, level, days]);
    flash(s, level ? `Debug messages on (level ${level}).` : 'Debug messages off.');
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
      const main = html`<h1 class="u-mb1">Installation</h1><div class="alert alert-error" role="alert">Only administrators see the installation log.</div>`;
      return send(reply.code(403), s, shell(s, 'Installation', [['App Builder', BASE], ['Workspace utilities', `${BASE}/utilities`], ['Installation']], main));
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
    const main = html`<h1 class="u-mb1">Installation</h1>
      <div class="stat-grid">
        <div class="stat"><b>${VERSION}</b><span>pgkiln version of this server</span></div>
        <div class="stat"><b>${migrations.length}</b><span>migrations applied${migrations[0] ? html`, the latest ${migrations[0].name.replace(/\.sql$/, '')}` : ''}</span></div>
        <div class="stat"><b>${pending.length}</b><span>migrations not applied</span></div>
        <div class="stat"><b>${db.size}</b><span>${db.name} · ${db.version}</span></div>
      </div>
      ${pending.length
        ? html`<div class="alert alert-error" role="alert">This database misses ${pending.length} migration${pending.length === 1 ? '' : 's'} of this server (${pending.join(', ')}). Run <code>npm run db:migrate</code> or <code>pgkiln migrate</code>.</div>`
        : ''}
      ${unknown.length ? html`<div class="alert alert-error" role="alert">The database has migrations this server does not know (${unknown.map((m) => m.name).join(', ')}): the server is older than the database.</div>` : ''}
      <div class="columns">
        ${region('Install and upgrade runs', runs.length
          ? html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>Started</th><th>Kind</th><th>Version</th><th>Status</th><th class="num">Files</th><th>Applied</th><th>By</th></tr></thead>
            <tbody>${runs.map((r) => html`<tr>
              <td data-label="Started">${String(r.started_at).slice(0, 19)}</td><td data-label="Kind">${r.kind}</td><td data-label="Version">${r.version ?? ''}</td>
              <td data-label="Status">${r.status === 'ok' ? html`<span class="ev ev-login">ok</span>` : html`<span class="ev ev-error">failed</span>`}${r.error ? html`<div class="small">${r.error}</div>` : ''}</td>
              <td class="num" data-label="Files">${r.applied.length}</td>
              <td data-label="Applied" class="debug-text">${r.applied.join(', ')}</td><td data-label="By">${r.db_user}</td></tr>`)}</tbody></table></div>`
          : html`<p class="muted u-mt0">No runs recorded yet: runs are logged from version 0.25 on (each <code>db:migrate</code> or <code>pgkiln migrate</code> that applies or fails a file). The applied migrations below show when each file was applied.</p>`)}
        ${region('Applied migrations', html`<div class="table-wrap"><table class="report"><thead><tr><th>File</th><th>Applied</th></tr></thead>
          <tbody>${migrations.map((m) => html`<tr><td><code>${m.name}</code></td><td>${String(m.applied_at).slice(0, 19)}</td></tr>`)}</tbody></table></div>`)}
        ${examples.length
          ? region('Example and seed scripts', html`<div class="table-wrap"><table class="report"><thead><tr><th>File</th><th>Applied</th></tr></thead>
              <tbody>${examples.map((m) => html`<tr><td><code>${m.name}</code></td><td>${String(m.applied_at).slice(0, 19)}</td></tr>`)}</tbody></table></div>`)
          : ''}
      </div>`;
    return send(reply, s, shell(s, 'Installation', [['App Builder', BASE], ['Workspace utilities', `${BASE}/utilities`], ['Installation']], main));
  });
}
