import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw } from '../html.ts';
import { icon } from '../icons.ts';
import { cachedRelease, newerVersion, refreshRelease, releaseCheckEnabled, setReleaseCheck, VERSION } from '../release-check.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import { ago } from './home.ts';
import { isAdmin } from './locks.ts';
import { back, BASE, csrf, developer, flash, region, send, shell, type Req } from './ui.ts';
import { currentWorkspace, inWorkspaceSql, workspaceAdmin } from './workspaces.ts';

// (sprint 109, WS-1) The Workspace home (APEX: the workspace home page), the page the builder opens after
// signing in: cards for the tools (App Builder, SQL Workshop, App Gallery), the workspace message (edited in place
// by its administrators), Top applications and Top users by page views over a reporting timeframe each developer
// chooses (meta.developer.home_timeframe, migration 119), a Summary of counts that link to their tool, a System
// message (the running version; "pgkiln X is available" when an administrator turned the release check on:
// src/release-check.ts) and a side column with Learn more and Resources. Everything is of the current workspace.

export const HOME = `${BASE}/home`;

export type Timeframe = 'hour' | 'day' | 'week';
export const TIMEFRAMES: Record<Timeframe, { label: string; interval: string }> = {
  hour: { label: '1 hour', interval: '1 hour' },
  day: { label: '1 day', interval: '1 day' },
  week: { label: '1 week', interval: '7 days' },
};
const isTimeframe = (v: unknown): v is Timeframe => typeof v === 'string' && Object.hasOwn(TIMEFRAMES, v);
const TOP = 5;

async function timeframeOf(s: Session): Promise<Timeframe> {
  const r = await owner.one<{ tf: string | null }>('select home_timeframe as tf from meta.developer where username = $1', [s.username]);
  return isTimeframe(r?.tf) ? r.tf : 'day';
}

/** The workspace's numbers: top applications and users over the timeframe, and the summary counts. */
export async function homeData(ws: number, tf: Timeframe) {
  const interval = TIMEFRAMES[tf].interval;
  const [apps, users, counts] = await Promise.all([
    owner.query<{ id: number; name: string; views: number; users: number }>(
      `select * from (
         select a.id, a.name,
                (select count(*) from meta.activity_log l where l.app_id = a.id and l.event = 'page_view' and l.at > now() - $2::interval)::int as views,
                (select count(distinct l.username) from meta.activity_log l where l.app_id = a.id and l.event = 'page_view' and l.at > now() - $2::interval)::int as users
           from meta.app a where ${inWorkspaceSql('a', 1)}) x
        where views > 0 order by views desc, lower(name) limit ${TOP}`,
      [ws, interval],
    ),
    owner.query<{ username: string; views: number; apps: number }>(
      `select l.username, count(*)::int as views, count(distinct l.app_id)::int as apps
         from meta.app a join meta.activity_log l on l.app_id = a.id
        where ${inWorkspaceSql('a', 1)} and l.event = 'page_view' and l.at > now() - $2::interval and l.username is not null
        group by l.username order by views desc, lower(l.username) limit ${TOP}`,
      [ws, interval],
    ),
    owner.one<{ apps: number; tables: number; developers: number; views: number }>(
      `select (select count(*) from meta.app a where ${inWorkspaceSql('a', 1)})::int as apps,
              -- the tables of the schemas this workspace's database roles may use (as Workspace utilization counts them)
              (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                where c.relkind in ('r', 'p') and not c.relispartition and n.nspname !~ '^pg_' and n.nspname not in ('information_schema', 'meta')
                  and exists (select 1 from (select db_role as r from meta.app where meta.app_workspace(id) = $1 and db_role is not null
                                             union select role_name from meta.workspace_role where workspace_id = $1) x
                               join pg_roles rl on rl.rolname = x.r
                              where has_schema_privilege(rl.oid, n.oid, 'USAGE')))::int as tables,
              (select count(*) from meta.workspace_member m where m.workspace_id = $1)::int as developers,
              (select count(*) from meta.app a join meta.activity_log l on l.app_id = a.id
                where ${inWorkspaceSql('a', 1)} and l.event = 'page_view' and l.at > now() - $2::interval)::int as views`,
      [ws, interval],
    ),
  ]);
  return { apps: apps.rows, users: users.rows, counts: counts! };
}

/** The System message: the running version, and a newer release when the check is on. */
async function systemMessage(s: Session, admin: boolean) {
  const check = await releaseCheckEnabled();
  // never wait for GitHub: show what is cached, refresh in the background
  if (check.on) void refreshRelease();
  const c = check.on ? cachedRelease() : null;
  const r = c?.release;
  const newer = r && newerVersion(r.version, VERSION) ? r : null;
  const body = newer
    ? html`<div class="alert alert-info wh-release" role="status">${icon('bell')}<div>
        <strong>pgkiln ${newer.version} is available</strong>
        <p>${newer.name}${newer.publishedAt ? html` <span class="muted">(${ago(newer.publishedAt)})</span>` : ''}. This server runs pgkiln ${VERSION}.</p>
        <p><a href="${newer.url}" target="_blank" rel="noopener noreferrer">Release notes ${icon('external')}</a> ·
          <a href="https://github.com/pgkiln/pgkiln/blob/main/docs/guide/01-installation.md#upgrading" target="_blank" rel="noopener">How to upgrade</a></p>
        <p class="small muted">To upgrade: back up the database, install the new version (<code>npm install -g pgkiln@${newer.version}</code>, or the
          Docker image <code>pgkiln/pgkiln:${newer.version}</code>), run <code>pgkiln migrate</code> and restart the server.</p></div></div>`
    : html`<p class="u-mt0">This server runs <strong>pgkiln ${VERSION}</strong>.${check.on && r && !newer ? ' It is the latest release.' : ''}</p>`;
  const status = !check.on
    ? 'The check for new versions is off.'
    : c?.error
      ? `The last check failed (${c.error})${c.release ? '; the result above is older' : ''}.`
      : c ? `Checked ${ago(new Date(c.at))}.` : 'Checking for a new version…';
  const admins = admin
    ? html`<form method="post" action="${HOME}/release-check" class="wh-release-form">${csrf(s)}
        <p class="small muted u-mt0">${status} ${check.on ? '' : html`When on, the server asks GitHub (<code>api.github.com</code>) once a day for the latest release; nothing about this installation is sent.`}
          ${check.from === 'environment' ? html`(<code>PGKILN_RELEASE_CHECK</code>)` : ''}</p>
        <div class="buttons">${check.on
          ? html`<button class="btn btn-sm" name="check" value="now">${icon('refresh')} Check now</button><button class="btn btn-sm" name="check" value="off">Turn off</button>`
          : html`<button class="btn btn-sm" name="check" value="on">Check for new versions</button>`}</div></form>`
    : '';
  return region('System message', html`${body}${admins}`, '', 'system-message');
}

/** The workspace message, with a pencil (a <details> form, no script needed) for its administrators. */
function workspaceMessage(s: Session, canEdit: boolean) {
  const w = s.workspace;
  if (!w) return '';
  if (!w.message && !canEdit) return '';
  return html`<section class="region region-standard wh-message" id="workspace-message" aria-labelledby="wh-message-title">
    <header class="region-header"><h2 id="wh-message-title">Workspace message</h2></header>
    <div class="region-body">
      ${w.message ? html`<p class="wh-message-text">${w.message}</p>` : html`<p class="muted u-mt0">No message for the developers of ${w.name}.</p>`}
      ${canEdit ? html`<details class="wh-edit"><summary class="btn btn-sm" title="Edit the workspace message">${icon('edit')}<span>Edit message</span></summary>
        <form method="post" action="${HOME}/message">${csrf(s)}<input type="hidden" name="workspace" value="${w.id}">
          <div class="field"><label class="label" for="f_message">Workspace message</label>
            <textarea id="f_message" name="message" rows="3" maxlength="2000">${w.message ?? ''}</textarea>
            <small class="help">Shown to the developers of ${w.name} here and on the App Builder home. Plain text, up to 2000 characters; empty removes it.</small></div>
          <div class="buttons"><button class="btn btn-hot">Save message</button></div></form></details>` : ''}
    </div></section>`;
}

const GUIDE = 'https://github.com/pgkiln/pgkiln/blob/main';

export async function workspaceHomeRoutes(app: FastifyInstance) {
  app.get(HOME, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const ws = currentWorkspace(s);
    const [tf, admin, canEdit] = await Promise.all([timeframeOf(s), isAdmin(s.username), s.workspace ? workspaceAdmin(s.username, s.workspace.id) : false]);
    const data = await homeData(ws, tf);
    const sql = s.workspace?.sql_workshop !== false;
    const card = (href: string, ic: string, title: string, text: string) =>
      html`<a class="ab-tile" href="${href}"><span class="ab-tile-icon">${icon(ic)}</span><strong>${title}</strong><span>${text}</span></a>`;
    const stat = (n: number, label: string, href: string | null) =>
      href ? html`<a class="stat" href="${href}"><b>${n}</b><span>${label}</span></a>` : html`<div class="stat"><b>${n}</b><span>${label}</span></div>`;
    const tfLabel = TIMEFRAMES[tf].label;
    const timeframe = html`<form method="post" action="${HOME}/timeframe" class="segmented wh-timeframe" role="group" aria-labelledby="wh-tf-label">${csrf(s)}
        <span class="sr-only" id="wh-tf-label">Reporting timeframe</span>
        ${(Object.keys(TIMEFRAMES) as Timeframe[]).map((k) => html`<button name="timeframe" value="${k}" aria-pressed="${k === tf ? 'true' : 'false'}">${TIMEFRAMES[k].label}</button>`)}</form>`;
    const topApps = data.apps.length
      ? html`<div class="table-wrap"><table class="report"><caption class="sr-only">Top applications, last ${tfLabel}</caption>
          <thead><tr><th scope="col">Application</th><th scope="col" class="num">Page views</th><th scope="col" class="num">Users</th></tr></thead>
          <tbody>${data.apps.map((a) => html`<tr><td class="cell-break"><a href="${BASE}/apps/${a.id}">${a.name}</a></td><td class="num">${a.views}</td><td class="num">${a.users}</td></tr>`)}</tbody></table></div>`
      : html`<p class="muted u-mt0">No page views in the last ${tfLabel}.</p>`;
    const topUsers = data.users.length
      ? html`<div class="table-wrap"><table class="report"><caption class="sr-only">Top users, last ${tfLabel}</caption>
          <thead><tr><th scope="col">User</th><th scope="col" class="num">Page views</th><th scope="col" class="num">Applications</th></tr></thead>
          <tbody>${data.users.map((u) => html`<tr><td class="cell-break">${u.username}</td><td class="num">${u.views}</td><td class="num">${u.apps}</td></tr>`)}</tbody></table></div>`
      : html`<p class="muted u-mt0">No page views in the last ${tfLabel}.</p>`;
    const main = html`<div class="ab-home wh-home">
      <div class="ab-main">
        <h1 class="wh-title">${s.workspace ? html`Workspace ${s.workspace.name}` : 'Workspace home'}</h1>
        <nav class="ab-tiles ab-tiles-wrap wh-tools" aria-label="Tools">
          ${card(BASE, 'grid', 'App Builder', 'Create, edit and run the applications of this workspace.')}
          ${sql ? card(`${BASE}/sql`, 'database', 'SQL Workshop', 'Run SQL, browse database objects, load data and build REST services.') : ''}
          ${card(`${BASE}/gallery`, 'package', 'App Gallery', 'Sample and starter applications to install.')}
        </nav>
        ${workspaceMessage(s, canEdit)}
        <section class="wh-summary" aria-labelledby="wh-summary-title">
          <h2 id="wh-summary-title">Summary</h2>
          <div class="stat-grid wh-stats">
            ${stat(data.counts.apps, data.counts.apps === 1 ? 'application' : 'applications', BASE)}
            ${stat(data.counts.tables, data.counts.tables === 1 ? 'table' : 'tables', sql ? `${BASE}/sql/objects` : null)}
            ${stat(data.counts.developers, data.counts.developers === 1 ? 'developer' : 'developers', `${BASE}/developers`)}
            ${stat(data.counts.views, `page views (${tfLabel})`, `${BASE}/dashboard`)}
          </div>
        </section>
        <div class="wh-top-head"><h2>Activity</h2>${timeframe}</div>
        <div class="columns wh-top">
          ${region(`Top applications (${tfLabel})`, topApps)}
          ${region(`Top users (${tfLabel})`, topUsers)}
        </div>
        <div class="u-spacer"></div>
        ${await systemMessage(s, admin)}
      </div>
      <aside class="ab-side" aria-label="Learn more and resources">
        <section><h2>About</h2><p>The workspace home: its tools, how its applications are used and what is new. ${s.workspace ? html`You work in ${s.workspace.name}.` : ''}</p></section>
        <section><h2>Learn more</h2><ul class="ab-links ab-tasks">
          <li><a href="${GUIDE}/docs/README.md" target="_blank" rel="noopener">The pgkiln guide${icon('chevron')}</a></li>
          <li><a href="${GUIDE}/docs/guide/11-from-apex.md" target="_blank" rel="noopener">Coming from APEX${icon('chevron')}</a></li>
          <li><a href="${GUIDE}/CHANGELOG.md" target="_blank" rel="noopener">What's new (changelog)${icon('chevron')}</a></li>
        </ul></section>
        <section><h2>Resources</h2><ul class="ab-links ab-tasks">
          <li><a href="${GUIDE}/docs/guide/10-tutorial.md" target="_blank" rel="noopener">Tutorial${icon('chevron')}</a></li>
          <li><a href="${GUIDE}/docs/guide/04-pages-and-regions.md#data_reporter-data-reporter" target="_blank" rel="noopener">Data Reporter regions${icon('chevron')}</a></li>
          <li><a href="${GUIDE}/docs/guide/20-ai-agents.md" target="_blank" rel="noopener">AI coding agents (MCP)${icon('chevron')}</a></li>
          <li><a href="https://github.com/pgkiln/pgkiln/issues" target="_blank" rel="noopener">Report a problem${icon('chevron')}</a></li>
        </ul></section>
      </aside>
    </div>`;
    return send(reply, s, shell(s, 'Workspace home', [['Home']], main, 'home'));
  });

  // the reporting timeframe, remembered per developer
  app.post(`${HOME}/timeframe`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const tf = req.body?.timeframe;
    if (!isTimeframe(tf)) return reply.code(400).send('Unknown timeframe');
    await owner.query('update meta.developer set home_timeframe = $2 where username = $1', [s.username, tf]);
    return back(reply, s, HOME);
  });

  // the workspace message, by the workspace's administrators (and the installation's)
  app.post(`${HOME}/message`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const id = String(req.body?.workspace ?? '');
    if (!/^\d{1,9}$/.test(id)) return reply.code(400).send('Unknown workspace');
    if (!(await workspaceAdmin(s.username, id))) return reply.code(403).send('Only the workspace\'s administrators change its message.');
    const message = String(req.body?.message ?? '').replace(/\r\n/g, '\n').trim();
    if (message.length > 2000) {
      flash(s, 'The message is at most 2000 characters.', 'error');
      return back(reply, s, HOME);
    }
    const r = await owner.query('update meta.workspace set message = $2 where id = $1', [id, message || null]);
    if (!r.rowCount) return reply.code(404).send('Not found');
    await logActivity({ appId: null, username: s.username, event: 'workspace', ip: clientIp(req), detail: `workspace ${id}: message` });
    flash(s, message ? 'Workspace message saved.' : 'Workspace message removed.');
    return back(reply, s, `${HOME}#workspace-message`);
  });

  // the release check (administrators): on, off, or check now
  app.post(`${HOME}/release-check`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    if (!(await isAdmin(s.username))) return reply.code(403).send('Only administrators change the release check.');
    const v = req.body?.check;
    if (v === 'on' || v === 'off') {
      await setReleaseCheck(v);
      await logActivity({ appId: null, username: s.username, event: 'instance_settings', ip: clientIp(req), detail: `release check ${v}` });
      if (v === 'on') await refreshRelease(true);
      flash(s, v === 'on' ? 'The server checks for new versions once a day.' : 'The check for new versions is off.');
    } else if (v === 'now') {
      if (!(await releaseCheckEnabled()).on) {
        flash(s, 'The check for new versions is off.', 'error');
        return back(reply, s, `${HOME}#system-message`);
      }
      await refreshRelease(true);
      const c = cachedRelease();
      flash(s, c?.error ? `The check failed (${c.error}).` : 'Checked for a new version.', c?.error ? 'error' : 'ok');
    } else return reply.code(400).send('Unknown action');
    return back(reply, s, `${HOME}#system-message`);
  });
}
