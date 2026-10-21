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
import { teamHomeBlock } from './team.ts';
import { tr } from './i18n.ts';

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
  const [apps, users, devs, counts] = await Promise.all([
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
    // the workspace's developers (its members and the installation's administrators) as users of its applications
    owner.query<{ username: string; views: number; apps: number }>(
      `select l.username, count(*)::int as views, count(distinct l.app_id)::int as apps
         from meta.app a join meta.activity_log l on l.app_id = a.id
        where ${inWorkspaceSql('a', 1)} and l.event = 'page_view' and l.at > now() - $2::interval
          and lower(l.username) in (select lower(m.username) from meta.workspace_member m where m.workspace_id = $1
                                    union select lower(d.username) from meta.developer d where d.is_admin)
        group by l.username order by views desc, lower(l.username) limit ${TOP}`,
      [ws, interval],
    ),
    owner.one<{ apps: number; tables: number; developers: number; reporting: number }>(
      `select (select count(*) from meta.app a where ${inWorkspaceSql('a', 1)})::int as apps,
              -- the tables of the schemas this workspace's database roles may use (as Workspace utilization counts them)
              (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                where c.relkind in ('r', 'p') and not c.relispartition and n.nspname !~ '^pg_' and n.nspname not in ('information_schema', 'meta')
                  and exists (select 1 from (select db_role as r from meta.app where meta.app_workspace(id) = $1 and db_role is not null
                                             union select role_name from meta.workspace_role where workspace_id = $1) x
                               join pg_roles rl on rl.rolname = x.r
                              where has_schema_privilege(rl.oid, n.oid, 'USAGE')))::int as tables,
              (select count(*) from meta.workspace_member m where m.workspace_id = $1)::int as developers,
              -- reporting applications: apps of type 'reporting' (Data Reporter → Create reporting application)
              meta.reporting_app_count($1) as reporting`,
      [ws],
    ),
  ]);
  return { apps: apps.rows, users: users.rows, developers: devs.rows, counts: counts! };
}

/** The System message: the running version, and a newer release when the check is on. */
async function systemMessage(s: Session, admin: boolean) {
  const tx = tr(s);
  const check = await releaseCheckEnabled();
  // never wait for GitHub: show what is cached, refresh in the background
  if (check.on) void refreshRelease();
  const c = check.on ? cachedRelease() : null;
  const r = c?.release;
  const newer = r && newerVersion(r.version, VERSION) ? r : null;
  const body = newer
    ? html`<div class="alert alert-info wh-release" role="status">${icon('bell')}<div>
        <strong>${tx('wh.available', { version: newer.version })}</strong>
        <p>${newer.name}${newer.publishedAt ? html` <span class="muted">(${ago(newer.publishedAt, Date.now(), tx)})</span>` : ''}. ${tx('wh.server_runs', { version: VERSION })}</p>
        <p><a href="${newer.url}" target="_blank" rel="noopener noreferrer">${tx('wh.release_notes')} ${icon('external')}</a> ·
          <a href="https://github.com/pgkiln/pgkiln/blob/main/docs/guide/01-installation.md#upgrading" target="_blank" rel="noopener">${tx('wh.how_upgrade')}</a></p>
        <p class="small muted">${tx.rich('wh.upgrade_steps', { npm: html`<code>npm install -g pgkiln@${newer.version}</code>`, docker: html`<code>pgkiln/pgkiln:${newer.version}</code>`, migrate: html`<code>pgkiln migrate</code>` })}</p></div></div>`
    : html`<p class="u-mt0">${tx.rich('wh.server_runs_strong', { version: html`<strong>pgkiln ${VERSION}</strong>` })}${check.on && r && !newer ? ` ${tx('wh.latest')}` : ''}</p>`;
  const status = !check.on
    ? tx('wh.check_off')
    : c?.error
      ? tx(c.release ? 'wh.check_failed_older' : 'wh.check_failed', { error: c.error })
      : c ? tx('wh.checked', { ago: ago(new Date(c.at), Date.now(), tx) }) : tx('wh.checking');
  const admins = admin
    ? html`<form method="post" action="${HOME}/release-check" class="wh-release-form">${csrf(s)}
        <p class="small muted u-mt0">${status} ${check.on ? '' : tx.rich('wh.check_explain', { host: html`<code>api.github.com</code>` })}
          ${check.from === 'environment' ? html`(<code>PGKILN_RELEASE_CHECK</code>)` : ''}</p>
        <div class="buttons">${check.on
          ? html`<button class="btn btn-sm" name="check" value="now">${icon('refresh')} ${tx('wh.check_now')}</button><button class="btn btn-sm" name="check" value="off">${tx('wh.turn_off')}</button>`
          : html`<button class="btn btn-sm" name="check" value="on">${tx('wh.check_on')}</button>`}</div></form>`
    : '';
  return region(tx('wh.system'), html`${body}${admins}`, '', 'system-message');
}

/** (Instance settings page) the release check: on, off, or as the environment says. */
export async function releaseCheckRegion(s: Session) {
  const check = await releaseCheckEnabled();
  const value = check.from === 'builder' ? (check.on ? 'on' : 'off') : 'default';
  const opt = (v: string, label: string) => html`<option value="${v}"${v === value ? raw(' selected') : ''}>${label}</option>`;
  return region('New versions', html`<form method="post" action="${HOME}/release-check">${csrf(s)}<input type="hidden" name="from" value="instance">
      <div class="field"><label class="label" for="f_release_check">Check for new pgkiln releases</label>
        <select id="f_release_check" name="check">${opt('default', `As the environment says (${process.env.PGKILN_RELEASE_CHECK ? 'PGKILN_RELEASE_CHECK' : 'off'})`)}${opt('on', 'On')}${opt('off', 'Off')}</select>
        <small class="help">On: the server asks GitHub (<code>api.github.com</code>) once a day for the latest release and the Workspace home
          announces a newer one with its release notes. Nothing about this installation is sent. In effect: <b>${check.on ? 'on' : 'off'}</b>.
          Turn it off when the server may not reach the internet.</small></div>
      <div class="buttons"><button class="btn">Save</button></div></form>`, '', 'release-check');
}

/** The workspace message, with a pencil (a <details> form, no script needed) for its administrators. */
function workspaceMessage(s: Session, canEdit: boolean) {
  const w = s.workspace;
  if (!w) return '';
  if (!w.message && !canEdit) return '';
  const tx = tr(s);
  return html`<section class="region region-standard wh-message" id="workspace-message" aria-labelledby="wh-message-title">
    <header class="region-header"><h2 id="wh-message-title">${tx('wh.message')}</h2></header>
    <div class="region-body">
      ${w.message ? html`<p class="wh-message-text">${w.message}</p>` : html`<p class="muted u-mt0">${tx('wh.message_none', { name: w.name })}</p>`}
      ${canEdit ? html`<details class="wh-edit"><summary class="btn btn-sm" title="${tx('wh.message_edit_title')}">${icon('edit')}<span>${tx('wh.message_edit')}</span></summary>
        <form method="post" action="${HOME}/message">${csrf(s)}<input type="hidden" name="workspace" value="${w.id}">
          <div class="field"><label class="label" for="f_message">${tx('wh.message')}</label>
            <textarea id="f_message" name="message" rows="3" maxlength="2000">${w.message ?? ''}</textarea>
            <small class="help">${tx('wh.message_help', { name: w.name })}</small></div>
          <div class="buttons"><button class="btn btn-hot">${tx('wh.message_save')}</button></div></form></details>` : ''}
    </div></section>`;
}

const REPO = 'https://github.com/pgkiln/pgkiln';
const GUIDE = `${REPO}/blob/main`;
/** The Data Reporter tool (sprint 110, WS-2): its card and link only when the route exists. */
export const REPORTER = `${BASE}/reporter`;

export async function workspaceHomeRoutes(app: FastifyInstance) {
  app.get(HOME, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const ws = currentWorkspace(s);
    const [tf, admin, canEdit] = await Promise.all([timeframeOf(s), isAdmin(s.username), s.workspace ? workspaceAdmin(s.username, s.workspace.id) : false]);
    const data = await homeData(ws, tf);
    const sql = s.workspace?.sql_workshop !== false;
    const reporter = app.hasRoute({ method: 'GET', url: REPORTER });
    const tx = tr(s);
    const card = (href: string, ic: string, title: string, text: string) =>
      html`<a class="ab-tile" href="${href}"><span class="ab-tile-icon">${icon(ic)}</span><strong>${title}</strong><span>${text}</span></a>`;
    const stat = (n: number, one: string, many: string, href: string | null) => {
      const inner = html`<b>${n}</b><span>${n === 1 ? one : many}</span>`;
      return href ? html`<a class="stat" href="${href}">${inner}</a>` : html`<div class="stat">${inner}</div>`;
    };
    const tfLabel = tx(`wh.tf.${tf}`);
    const timeframe = html`<form method="post" action="${HOME}/timeframe" class="segmented wh-timeframe" role="group" aria-labelledby="wh-tf-label">${csrf(s)}
        <span class="sr-only" id="wh-tf-label">${tx('wh.timeframe')}</span>
        ${(Object.keys(TIMEFRAMES) as Timeframe[]).map((k) => html`<button name="timeframe" value="${k}" aria-pressed="${k === tf ? 'true' : 'false'}">${tx(`wh.tf.${k}`)}</button>`)}</form>`;
    const none = html`<p class="muted u-mt0">${tx('wh.no_views', { tf: tfLabel })}</p>`;
    const people = (rows: { username: string; views: number; apps: number }[], caption: string, who: string) => rows.length
      ? html`<div class="table-wrap"><table class="report"><caption class="sr-only">${caption}</caption>
          <thead><tr><th scope="col">${who}</th><th scope="col" class="num">${tx('wh.col.views')}</th><th scope="col" class="num">${tx('wh.col.apps')}</th></tr></thead>
          <tbody>${rows.map((u) => html`<tr><td class="cell-break">${u.username}</td><td class="num">${u.views}</td><td class="num">${u.apps}</td></tr>`)}</tbody></table></div>`
      : none;
    const topApps = data.apps.length
      ? html`<div class="table-wrap"><table class="report"><caption class="sr-only">${tx('wh.top_apps_caption', { tf: tfLabel })}</caption>
          <thead><tr><th scope="col">${tx('wh.col.app')}</th><th scope="col" class="num">${tx('wh.col.views')}</th><th scope="col" class="num">${tx('wh.col.users')}</th></tr></thead>
          <tbody>${data.apps.map((a) => html`<tr><td class="cell-break"><a href="${BASE}/apps/${a.id}">${a.name}</a></td><td class="num">${a.views}</td><td class="num">${a.users}</td></tr>`)}</tbody></table></div>`
      : none;
    const ext = (href: string, label: string) => html`<li><a href="${href}" target="_blank" rel="noopener">${label}${icon('chevron')}</a></li>`;
    const main = html`<div class="ab-home wh-home">
      <div class="ab-main">
        <h1 class="wh-title">${s.workspace ? tx('wh.title_ws', { name: s.workspace.name }) : tx('wh.title')}</h1>
        <nav class="ab-tiles ab-tiles-wrap wh-tools" aria-label="${tx('wh.tools')}">
          ${card(`${BASE}/apps`, 'grid', tx('rail.app_builder'), tx('wh.card.apps'))}
          ${sql ? card(`${BASE}/sql`, 'database', tx('rail.sql_workshop'), tx('wh.card.sql')) : ''}
          ${reporter ? card(REPORTER, 'pie-chart', tx('rail.reporter'), tx('wh.card.reporter')) : ''}
          ${card(`${BASE}/gallery`, 'package', tx('rail.gallery'), tx('wh.card.gallery'))}
        </nav>
        ${workspaceMessage(s, canEdit)}
        <section class="wh-summary" aria-labelledby="wh-summary-title">
          <h2 id="wh-summary-title">${tx('wh.summary')}</h2>
          <div class="stat-grid wh-stats">
            ${stat(data.counts.apps, tx('wh.stat.app'), tx('wh.stat.apps'), `${BASE}/apps`)}
            ${stat(data.counts.tables, tx('wh.stat.table'), tx('wh.stat.tables'), sql ? `${BASE}/sql/objects` : null)}
            ${stat(data.counts.developers, tx('wh.stat.developer'), tx('wh.stat.developers'), `${BASE}/developers`)}
            ${stat(data.counts.reporting, tx('wh.stat.reporting'), tx('wh.stat.reportings'), reporter ? REPORTER : null)}
          </div>
        </section>
        <div class="wh-top-head"><h2>${tx('wh.activity')}</h2>${timeframe}</div>
        <div class="wh-top">
          ${region(tx('wh.top_apps', { tf: tfLabel }), topApps)}
          ${region(tx('wh.top_users', { tf: tfLabel }), people(data.users, tx('wh.top_users_caption', { tf: tfLabel }), tx('wh.col.user')))}
          ${region(tx('wh.top_devs', { tf: tfLabel }), people(data.developers, tx('wh.top_devs_caption', { tf: tfLabel }), tx('wh.col.developer')))}
        </div>
        ${await systemMessage(s, admin)}
      </div>
      <aside class="ab-side" aria-label="${tx('wh.aside')}">
        <section><h2>${tx('common.about')}</h2><p>${tx('wh.about')} ${s.workspace ? tx('wh.you_work', { name: s.workspace.name }) : ''}</p></section>
        ${await teamHomeBlock(s)}
        <section><h2>${tx('wh.learn_more')}</h2><ul class="ab-links ab-tasks">
          ${ext(`${GUIDE}/docs/README.md`, tx('wh.guide'))}
          ${ext(`${GUIDE}/docs/guide/10-tutorial.md`, tx('wh.tutorial'))}
          ${ext(`${GUIDE}/docs/guide/11-from-apex.md`, tx('wh.from_apex'))}
          ${ext(`${GUIDE}/CHANGELOG.md`, tx('wh.whats_new'))}
          ${ext(`${REPO}/discussions`, tx('wh.discussions'))}
        </ul></section>
        <section><h2>${tx('wh.resources')}</h2><ul class="ab-links ab-tasks">
          ${ext(`${GUIDE}/docs/guide/20-ai-agents.md`, tx('wh.mcp'))}
          ${ext(`${REPO}/issues`, tx('wh.report_problem'))}
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
      flash(s, tr(s)('wh.flash.too_long'), 'error');
      return back(reply, s, HOME);
    }
    const r = await owner.query('update meta.workspace set message = $2 where id = $1', [id, message || null]);
    if (!r.rowCount) return reply.code(404).send('Not found');
    await logActivity({ appId: null, username: s.username, event: 'workspace', ip: clientIp(req), detail: `workspace ${id}: message` });
    flash(s, tr(s)(message ? 'wh.flash.saved' : 'wh.flash.removed'));
    return back(reply, s, `${HOME}#workspace-message`);
  });

  // the release check (administrators): on, off, or check now
  app.post(`${HOME}/release-check`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    if (!(await isAdmin(s.username))) return reply.code(403).send('Only administrators change the release check.');
    const v = req.body?.check;
    // from the Instance settings page (back there) or the Workspace home
    const to = req.body?.from === 'instance' ? `${BASE}/instance#release-check` : `${HOME}#system-message`;
    if (v === 'on' || v === 'off' || v === 'default') {
      await setReleaseCheck(v === 'default' ? '' : v);
      await logActivity({ appId: null, username: s.username, event: 'instance_settings', ip: clientIp(req), detail: `release check ${v}` });
      const now = await releaseCheckEnabled();
      if (now.on) await refreshRelease(true);
      flash(s, tr(s)(now.on ? 'wh.flash.check_daily' : 'wh.check_off'));
    } else if (v === 'now') {
      if (!(await releaseCheckEnabled()).on) {
        flash(s, tr(s)('wh.check_off'), 'error');
        return back(reply, s, to);
      }
      await refreshRelease(true);
      const c = cachedRelease();
      flash(s, c?.error ? tr(s)('wh.flash.check_failed', { error: c.error }) : tr(s)('wh.flash.checked'), c?.error ? 'error' : 'ok');
    } else return reply.code(400).send('Unknown action');
    return back(reply, s, to);
  });
}
