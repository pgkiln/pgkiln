import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { APP_COLORS, BASE, csrf, developer, input, region, select, send, shell, type Req } from './ui.ts';
import type { Session } from '../session.ts';
import { isAdmin } from './locks.ts';
import { currentWorkspace, inWorkspaceSql } from './workspaces.ts';

// The workspace pages of the builder, laid out like APEX's App Builder: the
// home page (tiles, a searchable list of applications as a report or as
// cards, and a side column with About, Recent and Tasks), Create and Import,
// a workspace Dashboard and Workspace Utilities.

type View = 'report' | 'grid';
type Sort = 'name' | 'id' | 'alias' | 'pages' | 'updated';
const SORTS: Record<Sort, string> = {
  name: 'lower(a.name), a.id',
  id: 'a.id',
  alias: 'a.alias',
  pages: 'pages desc, lower(a.name)',
  updated: 'a.updated_at desc nulls last, lower(a.name)',
};
const RECENT_MAX = 8;

/** Remember an application the developer opened (the Recent list on the home page). */
const recentIds = (s: Session) => String(s.state.__RECENT ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
export function rememberApp(s: Session, appId: number) {
  s.state.__RECENT = [appId, ...recentIds(s).filter((id) => id !== appId)].slice(0, RECENT_MAX).join(',');
}

/** "3 minutes ago", "2 days ago", "1.7 years ago", as APEX shows it. */
export function ago(at: Date | string | null | undefined, now = Date.now()) {
  if (!at) return '';
  const sec = Math.max(0, (now - new Date(at).getTime()) / 1000);
  const units: [number, string][] = [[365 * 86400, 'year'], [30 * 86400, 'month'], [7 * 86400, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
  for (const [size, unit] of units) {
    if (sec >= size) {
      const n = sec / size;
      const v = unit === 'year' && n < 10 ? Math.round(n * 10) / 10 : Math.round(n);
      return `${v} ${unit}${v === 1 ? '' : 's'} ago`;
    }
  }
  return 'just now';
}

const appIcon = (a: { id: number; name: string }, cls = '') =>
  html`<span class="app-icon app-color-${a.id % APP_COLORS}${cls ? ` ${cls}` : ''}" aria-hidden="true">${a.name.slice(0, 1).toUpperCase()}</span>`;

/** The four tiles at the top of the App Builder. */
const tiles = () => html`<nav class="ab-tiles" aria-label="App Builder">
  ${[
    ['create', 'plus', 'Create', 'Create a new application in this workspace.'],
    ['import', 'upload', 'Import', 'Import an exported application into this workspace.'],
    ['dashboard', 'activity', 'Dashboard', 'View workspace usage, activity and sign-in problems.'],
    ['utilities', 'settings', 'Workspace Utilities', 'Users, identity providers, developers and the SQL Workshop.'],
  ].map(([path, ic, title, text]) => html`<a class="ab-tile" href="${BASE}/${path}"><span class="ab-tile-icon">${icon(ic)}</span><strong>${title}</strong><span>${text}</span></a>`)}
</nav>`;

/** The side column: About, Recent, Tasks. */
function aside(recent: { id: number; name: string }[], about: string, tasks: [string, string][]) {
  return html`<aside class="ab-side" aria-label="About, recent and tasks">
    <section><h2>About</h2><p>${about}</p>
      <p><a href="https://github.com/NickVrgr/Postgresql_APEX/blob/main/docs/guide/03-builder.md" target="_blank" rel="noopener">Learn more …</a></p></section>
    ${recent.length ? html`<section><h2>Recent</h2><ul class="ab-links">${recent.map((a) => html`<li><a href="${BASE}/apps/${a.id}">${a.name} - ${a.id}</a></li>`)}</ul></section>` : ''}
    <section><h2>Tasks</h2><ul class="ab-links ab-tasks">${tasks.map(([label, href]) => html`<li><a href="${href}">${label}${icon('chevron')}</a></li>`)}</ul></section>
  </aside>`;
}

const TASKS: [string, string][] = [
  ['Create application', `${BASE}/create`],
  ['Create application from a file', `${BASE}/create/file`],
  ['Import application', `${BASE}/import`],
  ['Manage users', `${BASE}/users`],
  ['Identity providers', `${BASE}/users/providers`],
  ['SQL Workshop', `${BASE}/sql`],
  ['Developers', `${BASE}/developers`],
];

async function recentApps(s: Session) {
  const ids = recentIds(s);
  const ws = currentWorkspace(s);
  if (ids.length) {
    const rows = (await owner.query(`select id, name from meta.app a where id = any($1::int[]) and ${inWorkspaceSql('a', 2)}`, [ids, ws])).rows;
    return ids.map((id) => rows.find((r) => r.id === id)).filter(Boolean) as { id: number; name: string }[];
  }
  return (await owner.query(`select id, name from meta.app a where ${inWorkspaceSql('a', 2)} order by updated_at desc nulls last, id desc limit $1`, [RECENT_MAX, ws])).rows;
}

export async function homeRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- App Builder home
  app.get(BASE, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const q = String(req.query.q ?? '').trim().slice(0, 100);
    // the view and sort are remembered for the session
    if (req.query.view === 'grid' || req.query.view === 'report') s.state.__BVIEW = req.query.view;
    if (typeof req.query.sort === 'string' && req.query.sort in SORTS) s.state.__BSORT = req.query.sort;
    const view: View = s.state.__BVIEW === 'grid' ? 'grid' : 'report';
    const sort: Sort = (typeof s.state.__BSORT === 'string' && s.state.__BSORT in SORTS ? s.state.__BSORT : 'name') as Sort;
    const [apps, total, recent] = await Promise.all([
      owner.query(
        `select a.id, a.name, a.alias, a.authentication, a.db_role, a.updated_at,
                (select count(*) from meta.page p where p.app_id = a.id)::int as pages,
                (select count(*) from meta.activity_log l where l.app_id = a.id and l.event = 'page_view' and l.at > now() - interval '1 day')::int as views
           from meta.app a
          where ($1 = '' or a.name ilike '%' || $1 || '%' or a.alias ilike '%' || $1 || '%' or a.id::text = $1) and ${inWorkspaceSql('a', 2)}
          order by ${SORTS[sort]}`,
        [q.replace(/[\\%_]/g, (c) => `\\${c}`), currentWorkspace(s)],
      ),
      owner.one(`select count(*)::int as n from meta.app a where ${inWorkspaceSql('a', 1)}`, [currentWorkspace(s)]),
      recentApps(s),
    ]);
    const link = (o: { view?: View; sort?: Sort }) => {
      const p = new URLSearchParams();
      if (q) p.set('q', q);
      if (o.view) p.set('view', o.view);
      if (o.sort) p.set('sort', o.sort);
      return `${BASE}?${p}`;
    };
    const th = (key: Sort, label: string, cls = '') =>
      html`<th scope="col"${cls ? raw(` class="${cls}"`) : ''}${sort === key ? raw(' aria-sort="' + (key === 'pages' || key === 'updated' ? 'descending' : 'ascending') + '"') : ''}><a href="${link({ sort: key })}">${label}${sort === key ? html`<span class="ab-sorted" aria-hidden="true">${key === 'pages' || key === 'updated' ? '↓' : '↑'}</span>` : ''}</a></th>`;
    const rows = apps.rows;
    const list = rows.length === 0
      ? html`<p class="ab-empty">${total.n ? html`No application matches “${q}”. <a href="${BASE}?q=">Show all</a>` : html`No applications yet. <a href="${BASE}/create">Create one</a> or <a href="${BASE}/import">import one</a>.`}</p>`
      : view === 'grid'
        ? html`<div class="ab-cards">${rows.map((a) => html`<article class="ab-card" data-filter-row>
            <a class="ab-card-main" href="${BASE}/apps/${a.id}">${appIcon(a)}<span><strong>${a.name}</strong><small>${a.id} · /a/${a.alias}</small></span></a>
            <div class="ab-card-meta"><span>${a.pages} pages</span><span>${a.views} views today</span><span>${ago(a.updated_at)}</span></div>
            <div class="ab-card-actions">
              <a class="tb-btn" href="${BASE}/apps/${a.id}" title="Edit ${a.name}">${icon('edit')}<span class="sr-only">Edit ${a.name}</span></a>
              <a class="tb-btn" href="/a/${a.alias}" target="_blank" rel="noopener" title="Run ${a.name}">${icon('play')}<span class="sr-only">Run ${a.name}</span></a>
            </div></article>`)}</div>`
        : html`<div class="table-wrap ab-table"><table class="report ab-apps">
            <caption class="sr-only">Applications</caption>
            <thead><tr>${th('id', 'Application', 'num')}${th('name', 'Name')}${th('alias', 'Alias')}${th('pages', 'Pages', 'num')}<th scope="col" class="num">Views (24h)</th><th scope="col">Sign-in</th>${th('updated', 'Updated')}<th scope="col" class="ab-actions-col">Actions</th></tr></thead>
            <tbody>${rows.map((a) => html`<tr data-filter-row>
              <td class="num">${a.id}</td>
              <td class="ab-name"><a href="${BASE}/apps/${a.id}">${appIcon(a)}<span>${a.name}</span></a></td>
              <td>${a.alias}</td>
              <td class="num">${a.pages}</td>
              <td class="num">${a.views}</td>
              <td>${a.authentication === 'none' ? 'Public' : a.authentication === 'header' ? 'HTTP header' : a.authentication === 'database' ? 'Database accounts' : a.authentication === 'custom' ? 'Custom' : 'App users'}</td>
              <td title="${a.updated_at ? new Date(a.updated_at).toISOString().slice(0, 16).replace('T', ' ') : ''}">${ago(a.updated_at)}</td>
              <td class="ab-actions">
                <a class="tb-btn" href="${BASE}/apps/${a.id}" title="Edit ${a.name}">${icon('edit')}<span class="sr-only">Edit ${a.name}</span></a>
                <a class="tb-btn" href="/a/${a.alias}" target="_blank" rel="noopener" title="Run ${a.name}">${icon('play')}<span class="sr-only">Run ${a.name}</span></a>
              </td></tr>`)}</tbody></table></div>`;
    const viewButton = (v: View, ic: string, label: string) =>
      html`<a class="tb-btn" href="${link({ view: v })}" title="${label}"${view === v ? raw(' aria-current="true"') : ''}>${icon(ic)}<span class="sr-only">${label}</span></a>`;
    const main = html`<div class="ab-home">
      <div class="ab-main">
        <h1 class="sr-only">App Builder</h1>
        ${tiles()}
        <div class="ab-toolbar">
          <form class="ab-search" method="get" action="${BASE}" role="search">
            <label class="sr-only" for="ab-q">Search applications</label>${icon('search')}
            <input id="ab-q" name="q" type="search" value="${q}" placeholder="Search" autocomplete="off" data-filter-list=".ab-home [data-filter-row]">
          </form>
          <div class="ab-views" role="group" aria-label="View">${viewButton('grid', 'grid', 'Cards')}${viewButton('report', 'list', 'Report')}</div>
          <details class="menu ab-menu"><summary class="btn">Actions ${icon('chevron')}</summary>
            <div class="menu-panel" role="menu">
              <div class="menu-section"><span class="small muted">Sort by</span>
                ${(Object.keys(SORTS) as Sort[]).map((k) => html`<a role="menuitem" href="${link({ sort: k })}"${sort === k ? raw(' aria-current="true"') : ''}>${{ name: 'Name', id: 'Application ID', alias: 'Alias', pages: 'Most pages', updated: 'Recently updated' }[k]}</a>`)}</div>
              <div class="menu-section menu-links">
                <a role="menuitem" href="${BASE}/import">${icon('upload')} Import application</a>
                <a role="menuitem" href="${BASE}/dashboard">${icon('activity')} Workspace dashboard</a>
              </div>
            </div></details>
          <span class="ab-count muted" aria-live="polite">${rows.length === total.n ? `${total.n} application${total.n === 1 ? '' : 's'}` : `${rows.length} of ${total.n}`}</span>
          <a class="btn btn-hot ab-create" href="${BASE}/create">Create</a>
        </div>
        ${list}
      </div>
      ${aside(recent, 'The App Builder creates, edits and runs the applications of this workspace: pages and regions on your PostgreSQL tables, with sign-in, roles and row level security.', TASKS)}
    </div>`;
    return send(reply, s, shell(s, 'App Builder', [['App Builder']], main));
  });

  // ---------------------------------------------------------------- create and import
  app.get(`${BASE}/create`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const schemas = await owner.query(`select nspname from pg_namespace where nspname !~ '^pg_' and nspname not in ('information_schema', 'meta') order by 1`);
    const boilerplates = (await owner.query(`select id, name from meta.app a where app_type = 'boilerplate' and ${inWorkspaceSql('a', 1)} order by lower(name), id`, [currentWorkspace(s)])).rows;
    const main = html`<div class="ab-narrow">
      <h1>Create an application</h1>
      <p class="muted">A blank application with a Home page, its own database role and a parsing schema. Add pages with the page wizards afterwards.</p>
      <p><a class="btn" href="${BASE}/create/file">${icon('upload')} From a file</a> <span class="muted small">Or start from a spreadsheet (CSV, Excel, JSON or XML): a table per sheet with its rows, a report and form per table, foreign keys, a dashboard and a faceted search.</span></p>
      <p><a class="btn" href="${BASE}/create/paste">${icon('file')} From pasted data</a> <span class="muted small">Paste rows copied from a spreadsheet, or CSV or TSV text.</span></p>
      <p><a class="btn" href="${BASE}/blueprints">${icon('layers')} From a blueprint</a> <span class="muted small">Describe tables, pages, menu and sample rows as a blueprint (or let AI draft one), review it, create it.</span></p>
      <p><a class="btn" href="${BASE}/create/tables">${icon('table')} From existing tables</a> <span class="muted small">Pick the tables and views of a schema: a report and form per table, navigation and a dashboard.</span></p>
      ${region('Application', html`<form method="post" action="${BASE}/apps">${csrf(s)}
        <div class="form-grid">
          ${input('name', 'Name', '', { required: true })}
          ${input('alias', 'Alias (URL)', '', { required: true, help: 'lowercase, e.g. inventory → /a/inventory' })}
          ${boilerplates.length
            ? select('boilerplate', 'Start from', '', [['', '- a blank application (a Home page) -'], ...boilerplates.map((x): [string, string] => [String(x.id), `${x.name} (boilerplate)`])],
                'A boilerplate application\'s pages, shared components and settings are copied; the new application keeps its own name, alias, role and authentication.')
            : ''}
          ${select('schema', 'Parsing schema', '', [['', '- new schema named after the alias -'], ...schemas.rows.map((r): [string, string] => [r.nspname, r.nspname])],
            'A database role app_<alias> is created with access to this schema only; the app runs as that role.')}
          ${select('authentication', 'Authentication', 'app_users', [['app_users', 'App users (login page)'], ['none', 'None (public)']])}
          ${input('admin_user', 'First user', '', { placeholder: 'e.g. your name', help: 'Gets the admin role. An existing account in Users is reused.' })}
          ${input('admin_password', 'Password', '', { type: 'password', auto: 'new-password', help: 'For a new account; at least 8 characters.' })}
        </div>
        <div class="buttons"><a class="btn" href="${BASE}">Cancel</a><button class="btn btn-hot">Create application</button></div>
      </form>`)}
    </div>`;
    return send(reply, s, shell(s, 'Create application', [['App Builder', BASE], ['Create']], main));
  });

  app.get(`${BASE}/import`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const main = html`<div class="ab-narrow">
      <h1>Import an application</h1>
      <p class="muted">Paste an application export (<code>meta.export_app()</code>, the builder's Export, or <code>pgkiln export</code>). A directory export is imported with <code>pgkiln import</code>.</p>
      ${region('Export file', html`<form method="post" action="${BASE}/import">${csrf(s)}
        <div class="field" data-wide><label class="label" for="f_doc">Export JSON</label><textarea id="f_doc" name="doc" class="code" rows="14" required data-code="json"></textarea></div>
        ${input('alias', 'New alias (optional)', '', { help: 'Leave empty to keep the alias in the export.' })}
        <div class="buttons"><a class="btn" href="${BASE}">Cancel</a><button class="btn btn-hot">Import</button></div>
      </form>`)}
    </div>`;
    return send(reply, s, shell(s, 'Import application', [['App Builder', BASE], ['Import']], main));
  });

  // ---------------------------------------------------------------- workspace dashboard
  app.get(`${BASE}/dashboard`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const [totals, perApp] = await Promise.all([
      owner.one(
        `select (select count(*) from meta.app a where ${inWorkspaceSql('a', 1)})::int as apps,
                (select count(*) from meta.page p join meta.app a on a.id = p.app_id where ${inWorkspaceSql('a', 1)})::int as pages,
                (select count(*) from meta.account where active)::int as accounts,
                count(*) filter (where event = 'page_view')::int as views,
                count(distinct username) filter (where event = 'page_view')::int as users,
                count(*) filter (where event in ('login_failed', 'login_locked'))::int as failures,
                count(*) filter (where event in ('forbidden', 'error'))::int as problems
           from meta.activity_log l where at > now() - interval '1 day'
            and (l.app_id is null or exists (select 1 from meta.app a where a.id = l.app_id and ${inWorkspaceSql('a', 1)}))`,
        [currentWorkspace(s)],
      ),
      owner.query(
        `select a.id, a.name,
                count(l.*) filter (where l.event = 'page_view' and l.at > now() - interval '1 day')::int as views_day,
                count(l.*) filter (where l.event = 'page_view')::int as views_week,
                count(distinct l.username) filter (where l.event = 'page_view')::int as users,
                coalesce(round(avg(l.elapsed_ms) filter (where l.event = 'page_view')), 0)::int as avg_ms,
                count(l.*) filter (where l.event in ('forbidden', 'error'))::int as problems
           from meta.app a left join meta.activity_log l on l.app_id = a.id and l.at > now() - interval '7 days'
          where ${inWorkspaceSql('a', 1)}
          group by a.id, a.name order by views_week desc, lower(a.name)`,
        [currentWorkspace(s)],
      ),
    ]);
    const stat = (n: number | string, label: string) => html`<div class="stat"><b>${n}</b><span>${label}</span></div>`;
    const main = html`<h1 class="u-mb1">Workspace dashboard</h1>
      <div class="stat-grid">
        ${stat(totals.apps, 'applications')}${stat(totals.pages, 'pages')}${stat(totals.accounts, 'active accounts')}
        ${stat(totals.views, 'page views (24h)')}${stat(totals.users, 'distinct users (24h)')}
        ${stat(totals.failures, 'failed / locked sign-ins (24h)')}${stat(totals.problems, 'errors / access denied (24h)')}
      </div>
      ${region('Applications (7 days)', html`<div class="table-wrap"><table class="report"><thead><tr><th scope="col">Application</th><th scope="col" class="num">Views (24h)</th><th scope="col" class="num">Views (7 days)</th><th scope="col" class="num">Users</th><th scope="col" class="num">Avg ms</th><th scope="col" class="num">Errors / denied</th><th scope="col"></th></tr></thead>
        <tbody>${perApp.rows.map((a) => html`<tr><td><a href="${BASE}/apps/${a.id}">${a.name}</a></td><td class="num">${a.views_day}</td><td class="num">${a.views_week}</td><td class="num">${a.users}</td><td class="num">${a.avg_ms}</td><td class="num">${a.problems}</td><td><a href="${BASE}/apps/${a.id}/activity">Activity</a></td></tr>`)}</tbody></table></div>`)}`;
    return send(reply, s, shell(s, 'Dashboard', [['App Builder', BASE], ['Dashboard']], main));
  });

  // ---------------------------------------------------------------- workspace utilities
  app.get(`${BASE}/utilities`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const card = (href: string, ic: Raw | '', title: string, text: string) =>
      html`<a class="ab-tile" href="${href}"><span class="ab-tile-icon">${ic}</span><strong>${title}</strong><span>${text}</span></a>`;
    const main = html`<h1 class="u-mb1">Workspace utilities</h1>
      <div class="ab-tiles ab-tiles-wrap">
        ${card(`${BASE}/users`, icon('user'), 'Users', 'Accounts of the people who use the applications, and their access.')}
        ${card(`${BASE}/users/providers`, icon('key'), 'Identity providers', 'OpenID Connect and SAML sign-in.')}
        ${card(`${BASE}/users/directories`, icon('org'), 'LDAP directories', 'Sign in with directory accounts.')}
        ${card(`${BASE}/users#account-settings`, icon('shield'), 'Password policy', 'Length, complexity and lifetime of passwords.')}
        ${card(`${BASE}/developers`, icon('users'), 'Developers', 'Who may use this builder.')}
        ${card(`${BASE}/sql`, icon('database'), 'SQL Workshop', 'Run SQL, browse objects and load data.')}
        ${card(`${BASE}/dashboard`, icon('activity'), 'Dashboard', 'Usage and problems across the workspace.')}
        ${(await isAdmin(s.username)) ? card(`${BASE}/instance`, icon('settings'), 'Instance settings', 'Session length, sign-in throttling and the server\'s configuration (administrators).') : ''}
        ${(await isAdmin(s.username)) ? card(`${BASE}/workspaces`, icon('layers'), 'Workspaces', 'Groups of applications and their developers (administrators).') : ''}
        ${(await isAdmin(s.username)) ? card(`${BASE}/ai`, icon('bolt'), 'AI services', 'Claude and OpenAI for the applications: models, keys, limits and usage (administrators).') : ''}
        ${(await isAdmin(s.username)) ? card(`${BASE}/installation`, icon('history'), 'Installation', 'Version, install and upgrade runs, applied migrations (administrators).') : ''}
      </div>`;
    return send(reply, s, shell(s, 'Workspace utilities', [['App Builder', BASE], ['Workspace utilities']], main));
  });
}
