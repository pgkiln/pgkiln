import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { usedInPanel } from './search.ts';
import { subscriptionNote } from './subscriptions.ts';
import { documentExtras } from './documents.ts';
import { workflowExtras, workflowForm } from './workflows.ts';
import { restExtras } from './rest.ts';
import { COMPONENTS } from './components.ts';
import { actionExtras, actionPrefill, automationExtras } from './automations.ts';
import { layoutExtras } from './layouts.ts';
import { templateExtras, templateImport } from './templates.ts';
import { credentialExtras, needsSecret, restSourceExtras } from './websources.ts';
import { dataLoadDefExtras } from './dataload.ts';
import { appHeader, back, BASE, csrf, developer, flash, input, region, select, send, shell, type Req } from './ui.ts';
import { endSessions, grantAccess, roleHints, roleHintsHtml, splitRoles } from './users.ts';
import { appOr404, componentForm, lookups, saveComponent } from './forms.ts';
import { catalogPicker } from './rest-catalogs.ts';
import { COMPONENT_SETTINGS, componentSetting, componentSettingsFrom, type ComponentSettings } from '../runtime/component-settings.ts';

// Shared Components: navigation, authorization schemes, LOVs, application
// items and processes, report layouts, and access control.

/** A list's entries, with links to edit them and to add one. */
function listExtras(appId: number, list: any, entries: any[]): Raw {
  const own = entries.filter((e) => e.list_name === list.name);
  return html`<h3>Entries</h3>
    ${list.type === 'sql' ? html`<p class="muted">This list shows the rows of its query; entries below are not used.</p>` : ''}
    ${own.length
      ? html`<ul class="tree">${own.map((e) => html`<li><a href="?c=list_entry-${e.id}">${icon(e.icon ?? 'chevron')}<span>${e.parent_id ? '↳ ' : ''}${e.label}</span>${e.target_page ? html`<span class="kind">p${e.target_page}</span>` : e.target_url ? html`<span class="kind">url</span>` : ''}</a></li>`)}</ul>`
      : html`<p class="muted">No entries yet.</p>`}
    <p><a class="btn" href="?new=list_entry&amp;list=${encodeURIComponent(list.name)}">＋ Add entry</a></p>`;
}

/** (sprint 74) A row's second column in a component list. */
function detailOf(kind: string, r: any): string {
  switch (kind) {
    case 'nav_entry': return r.target_page ? `page ${r.target_page}` : r.target_url ?? '';
    case 'authz_scheme': return r.type;
    case 'app_process': return r.point;
    case 'automation': return r.enabled ? r.schedule ?? '' : 'off';
    case 'list': return r.type;
    case 'list_entry': return `${r.list_name}${r.target_page ? `, page ${r.target_page}` : ''}`;
    case 'web_credential': return r.type;
    case 'rest_source': return `${r.method ?? ''} ${r.url ?? ''}`.trim();
    case 'supporting_script': return r.kind;
    case 'search_config': return r.source_type;
    case 'lov': return r.type ?? '';
    case 'app_item': return r.scope ?? '';
    default: return r.description ?? '';
  }
}

interface ScItem { label: string; href: string; kind?: string }
/**
 * (sprint 74) The groups of the Shared Components page, like APEX's. Component types pgkiln keeps in Settings
 * open the right Settings tab; a few APEX types have no counterpart (docs/apex-feature-parity.md says why).
 */
export function sharedGroups(appId: number): { key: string; title: string; icon: string; items: ScItem[] }[] {
  const t = (kind: string, label = COMPONENTS[kind].plural): ScItem => ({ label, href: `${BASE}/apps/${appId}/shared?type=${kind}`, kind });
  const settings = (tab: string, label: string): ScItem => ({ label, href: `${BASE}/apps/${appId}/settings?tab=${tab}` });
  const page = (path: string, label: string): ScItem => ({ label, href: `${BASE}/apps/${appId}/${path}` });
  return [
    { key: 'logic', title: 'Application Logic', icon: 'code', items: [t('app_item', 'Application Items'), t('app_process', 'Application Processes'), t('app_computation', 'Application Computations'), t('app_setting', 'Application Settings'), t('build_option', 'Build Options'), page('settings?tab=definition', 'Application Definition')] },
    { key: 'security', title: 'Security', icon: 'shield', items: [{ label: 'Access Control', href: `${BASE}/apps/${appId}/shared?view=tree`, kind: 'access' }, settings('security', 'Authentication'), t('authz_scheme', 'Authorization Schemes'), settings('security', 'Security Attributes'), settings('signin', 'Sign-in and Session Management')] },
    { key: 'other', title: 'Other Components', icon: 'layers', items: [t('lov', 'Lists of Values'), t('list', 'Lists'), t('list_entry', 'List Entries'), t('email_template', 'Email Templates'), t('shortcut', 'Shortcuts'), t('component_group', 'Component Groups'), t('supporting_script', 'Supporting Objects'), page('subscriptions', 'Subscriptions')] },
    { key: 'navigation', title: 'Navigation and Search', icon: 'compass', items: [t('nav_entry', 'Navigation Menu'), settings('ui', 'Navigation Bar List'), page('breadcrumbs', 'Breadcrumbs'), t('page_group', 'Page Groups'), t('search_config', 'Search Configurations')] },
    { key: 'ui', title: 'User Interface', icon: 'grid', items: [page('theme', 'Themes and Theme Roller'), settings('ui', 'User Interface Attributes'), t('template_component', 'Template Components'), page('plugins', 'Plug-ins'), page('component-settings', 'Component Settings'), settings('pwa', 'Progressive Web App')] },
    { key: 'files', title: 'Files and Reports', icon: 'file', items: [page('static-files', 'Static Application Files'), t('report_layout', 'Report Layouts'), t('report_query', 'Report Queries'), t('document_template', 'Document Templates')] },
    { key: 'data', title: 'Data Sources', icon: 'database', items: [t('rest_source', 'REST Data Sources'), t('web_credential', 'Web Credentials'), t('rest_module', 'RESTful Services'), t('data_load_def', 'Data Load Definitions')] },
    { key: 'workflows', title: 'Workflows and Automations', icon: 'activity', items: [t('workflow_definition', 'Workflows'), t('task_definition', 'Task Definitions'), t('automation', 'Automations')] },
    { key: 'globalization', title: 'Globalization', icon: 'globe', items: [page('globalization', 'Translations and Text Messages'), t('dynamic_translation', 'Dynamic Translations'), settings('globalization', 'Globalization Attributes')] },
    { key: 'ai', title: 'Generative AI', icon: 'lightbulb', items: [page('ai', 'AI Services')] },
  ];
}

export async function sharedRoutes(app: FastifyInstance) {
  // (sprint 74) Breadcrumbs (APEX: a breadcrumb component): the pages by their breadcrumb parent
  app.get(`${BASE}/apps/:id/breadcrumbs`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOr404(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const pages = (await owner.query<{ id: number; page_no: number; name: string; parent_page: number | null }>('select id, page_no, name, parent_page from meta.page where app_id = $1 order by page_no', [a.id])).rows;
    const known = new Set(pages.map((p) => p.page_no));
    const tree = (parent: number | null, seen: Set<number>): Raw => {
      const kids = pages.filter((p) => (parent === null ? p.parent_page === null || !known.has(p.parent_page) || p.parent_page === p.page_no : p.parent_page === parent && p.page_no !== parent) && !seen.has(p.page_no));
      if (!kids.length) return html``;
      return html`<ul class="tree">${kids.map((p) => {
        const next = new Set(seen).add(p.page_no);
        return html`<li><a href="${BASE}/pages/${p.id}">${icon('file')}<span>${p.name}</span><span class="kind">p${p.page_no}</span></a>${tree(p.page_no, next)}</li>`;
      })}</ul>`;
    };
    const main = html`${appHeader(a, 'shared')}
      ${region('Breadcrumbs', html`<p class="muted u-mt0">A page's breadcrumb lists the pages above it: each page names its breadcrumb parent (Page Designer → page → Breadcrumb parent). Pages without one show Home.</p>${tree(null, new Set())}`)}`;
    return send(reply, s, shell(s, 'Breadcrumbs', [['App Builder', BASE], [a.name, `${BASE}/apps/${a.id}`], ['Shared Components', `${BASE}/apps/${a.id}/shared`], ['Breadcrumbs']], main));
  });

  // (105) Component Settings (APEX): the application's defaults of its built-in component types
  app.get(`${BASE}/apps/:id/component-settings`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOr404(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const cur = (a.component_settings ?? {}) as ComponentSettings;
    const groups = [...new Set(COMPONENT_SETTINGS.map((x) => x.group))];
    const main = html`${appHeader(a, 'shared')}
      ${region('Component Settings', html`<p class="muted u-mt0">Defaults for the application's built-in component types, used where a component sets nothing itself. Empty: pgkiln's default.</p>
        <form method="post" action="${BASE}/apps/${a.id}/component-settings">${csrf(s)}
          ${groups.map((g) => html`<fieldset class="u-mb1"><legend>${g}</legend>${COMPONENT_SETTINGS.filter((x) => x.group === g).map((x) =>
            input(x.key, x.label, cur[x.key] ?? '', { type: 'number', placeholder: String(x.def), help: `${x.help} ${x.min}–${x.max.toLocaleString('en')}; now ${componentSetting(cur, x.key).toLocaleString('en')}.` }))}</fieldset>`)}
          <div class="buttons"><button class="btn btn-hot">Save</button></div>
        </form>`)}`;
    return send(reply, s, shell(s, 'Component Settings', [['App Builder', BASE], [a.name, `${BASE}/apps/${a.id}`], ['Shared Components', `${BASE}/apps/${a.id}/shared`], ['Component Settings']], main));
  });

  app.post(`${BASE}/apps/:id/component-settings`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOr404(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const { settings, problems } = componentSettingsFrom(req.body ?? {});
    if (problems.length) flash(s, problems.join(' '), 'error');
    else {
      await owner.query('update meta.app set component_settings = $2 where id = $1', [a.id, JSON.stringify(settings)]);
      flash(s, 'Component settings saved.');
    }
    return back(reply, s, `${BASE}/apps/${a.id}/component-settings`);
  });

  // ---------------------------------------------------------------- shared components
  const SHARED = ['nav_entry', 'authz_scheme', 'build_option', 'page_group', 'lov', 'app_item', 'app_process', 'app_computation', 'shortcut', 'report_query', 'component_group', 'automation', 'automation_action', 'report_layout', 'document_template', 'task_definition', 'workflow_definition', 'rest_module', 'template_component', 'web_credential', 'rest_source', 'data_load_def', 'list', 'list_entry', 'supporting_script', 'search_config', 'email_template', 'app_setting', 'dynamic_translation'];

  const ORDER: Record<string, string> = {
    search_config: 'seq, name', dynamic_translation: 'language, source',
    nav_entry: 'parent_id nulls first, seq, id', app_process: 'seq, id', app_computation: 'seq, id', list_entry: 'list_name, parent_id nulls first, seq, id', automation_action: 'automation_name, seq, name', supporting_script: 'kind, seq, name',
  };

  app.get(`${BASE}/apps/:id/shared`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOr404(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const lk = await lookups(a.id);
    const rows: Record<string, any[]> = {};
    for (const kind of SHARED)
      rows[kind] = (await owner.query(`select * from ${COMPONENTS[kind].table} where app_id = $1 order by ${ORDER[kind] ?? 'name'}`, [a.id])).rows;
    const users = (
      await owner.query(
        `select ac.id, ac.username, ac.display_name, ac.active, ac.last_login_at, aa.roles
           from meta.app_access aa join meta.account ac on ac.id = aa.account_id
          where aa.app_id = $1 order by lower(ac.username)`,
        [a.id],
      )
    ).rows;

    const [selKind, selId] = (req.query.c ?? '').split('-');
    const newKind = req.query.new;
    const type = typeof req.query.type === 'string' ? req.query.type : '';
    const crumbsBase: [string, string?][] = [['App Builder', BASE], [a.name, `${BASE}/apps/${a.id}`], ['Shared Components', `${BASE}/apps/${a.id}/shared`]];
    // (sprint 74) APEX's Shared Components: a grid of component types in groups, with counts
    if (!selKind && !newKind && !type && req.query.view !== 'tree') {
      const counts: Record<string, number> = Object.fromEntries(SHARED.map((k) => [k, rows[k].length]));
      counts.access = users.length;
      const main = html`${appHeader(a, 'shared')}
        <div class="sc-head"><p class="muted u-m0">The components the pages of ${a.name} share.</p><a class="btn" href="?view=tree">${icon('list')} Tree view</a></div>
        <div class="sc-grid">${sharedGroups(a.id).map((g) => html`<section class="region region-standard sc-group" aria-labelledby="sc-${g.key}">
          <header class="region-header"><h2 id="sc-${g.key}">${icon(g.icon)} ${g.title}</h2></header>
          <ul class="sc-links">${g.items.map((it) => html`<li><a href="${it.href}">${it.label}</a>${it.kind && counts[it.kind] !== undefined ? html`<span class="sc-count" aria-label="${counts[it.kind]} ${it.label}">${counts[it.kind]}</span>` : ''}</li>`)}</ul>
        </section>`)}</div>`;
      return send(reply, s, shell(s, 'Shared Components', [['App Builder', BASE], [a.name, `${BASE}/apps/${a.id}`], ['Shared Components']], main));
    }
    // (sprint 74) one component type: a searchable, sortable list with Create; a row opens its editor
    if (type && SHARED.includes(type)) {
      const spec = COMPONENTS[type];
      const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
      const desc = req.query.sort === 'desc';
      const shown = rows[type]
        .map((r) => ({ r, name: String(spec.summary(r)) }))
        .filter((x) => !q || x.name.toLowerCase().includes(q.toLowerCase()))
        .sort((x, y) => (desc ? -1 : 1) * x.name.localeCompare(y.name, 'en', { numeric: true }));
      const main = html`${appHeader(a, 'shared')}
        <div class="sc-list-head"><h1>${spec.plural}</h1><a class="btn btn-hot" href="?new=${type}">${icon('plus')} Create</a></div>
        <form method="get" class="search u-mwnone u-mb1" role="search"><input type="hidden" name="type" value="${type}">
          <div class="field"><label class="label" for="f_q">Search</label><input id="f_q" name="q" type="search" value="${q}" placeholder="Name" data-filter-rows="sc-rows"></div>
          <button class="btn u-selfend">${icon('search')} Go</button></form>
        <div class="table-wrap"><table class="report"><thead><tr>
          <th scope="col" aria-sort="${desc ? 'descending' : 'ascending'}"><a href="?type=${type}${q ? `&q=${encodeURIComponent(q)}` : ''}${desc ? '' : '&sort=desc'}">Name ${desc ? '▼' : '▲'}</a></th>
          <th scope="col">Details</th></tr></thead>
          <tbody id="sc-rows">${shown.length
            ? shown.map(({ r, name }) => html`<tr><td data-label="Name"><a href="?c=${type}-${r.id}">${icon(type === 'nav_entry' ? (r.icon ?? 'chevron') : spec.icon)} ${r.parent_id ? '↳ ' : ''}${name}</a></td>
                <td data-label="Details">${detailOf(type, r)}</td></tr>`)
            : html`<tr><td colspan="2" class="empty">${q ? 'Nothing matches.' : `No ${spec.plural.toLowerCase()} yet.`}</td></tr>`}</tbody></table></div>
        <p class="muted">${shown.length} of ${rows[type].length}</p>`;
      return send(reply, s, shell(s, spec.plural, [...crumbsBase, [spec.plural]], main));
    }
    let editor: Raw;
    if (newKind && SHARED.includes(newKind)) {
      const spec = COMPONENTS[newKind];
      // "Add entry" from a list fills in the list, "Add action" from an automation the automation (and the next sequence)
      const prefill = newKind === 'list_entry' && req.query.list ? { list_name: String(req.query.list).toUpperCase() } : newKind === 'automation_action' && req.query.automation ? actionPrefill(String(req.query.automation), rows.automation_action) : {};
      editor = region(`New ${spec.label.toLowerCase()}`, componentForm(spec, newKind, { seq: 10, ...spec.defaults, ...prefill }, lk, `${BASE}/apps/${a.id}/shared/${newKind}`, s, 'Create'));
      if (newKind === 'template_component') editor = html`${editor}${templateImport(a.id, s)}`;
      if (newKind === 'rest_source') editor = html`${await catalogPicker(a.id, s)}${editor}`;
    } else if (selKind && SHARED.includes(selKind)) {
      const spec = COMPONENTS[selKind];
      const row = rows[selKind].find((r) => String(r.id) === selId);
      // a workflow definition's form edits its development version (src/builder/workflows.ts)
      const [formSpec, formRow] = row && selKind === 'workflow_definition' ? workflowForm(spec, row) : [spec, row];
      editor = row
        ? region(`${spec.label}: ${spec.summary(row)}`, html`${componentForm(formSpec, selKind, formRow, lk, `${BASE}/apps/${a.id}/shared/${selKind}/${row.id}`, s, 'Save')}
            ${selKind === 'report_layout' ? layoutExtras(a.id, row, s) : selKind === 'automation' ? await automationExtras(a.id, row, s, rows.automation_action) : selKind === 'automation_action' ? actionExtras(row, rows.automation) : selKind === 'document_template' ? documentExtras(a.id, row) : selKind === 'workflow_definition' ? await workflowExtras(a.id, row, s, req.query) : selKind === 'rest_module' ? restExtras(a, row) : selKind === 'template_component' ? templateExtras(a.id, row, req.query) : selKind === 'web_credential' ? credentialExtras(a.id, row, s) : selKind === 'rest_source' ? await restSourceExtras(a.id, row, s) : selKind === 'data_load_def' ? dataLoadDefExtras(row) : selKind === 'list' ? listExtras(a.id, row, rows.list_entry) : selKind === 'supporting_script' ? html`<p class="u-mt1"><a class="btn" href="${BASE}/apps/${a.id}/supporting-objects">${icon('play')} Run supporting objects…</a></p>` : ''}
            ${await usedInPanel(a.id, selKind, row)}
            ${await subscriptionNote(a.id, selKind, row, s)}
            <form method="post" action="${BASE}/apps/${a.id}/shared/${selKind}/${row.id}/delete" class="danger-zone">${csrf(s)}<button class="btn btn-danger" data-confirm="Delete this ${spec.label.toLowerCase()}?">Delete</button></form>`)
        : html`<p>Not found.</p>`;
    } else {
      const accounts = (await owner.query('select username from meta.account where active order by lower(username) limit 2000')).rows;
      const appHints = (await roleHints([a.id])).get(a.id) ?? [];
      const groupRoles = (await owner.query('select group_name, role from meta.app_group_role where app_id = $1 order by 1, 2', [a.id])).rows;
      const groupMap = html`<h3>Identity-provider groups → roles</h3>
        <p class="muted u-mt0">With single sign-on, members of these groups get the role in this app, and may sign in even without being listed above.</p>
        ${groupRoles.length
          ? html`<div class="chips">${groupRoles.map((g) => html`<span class="chip">${g.group_name} → <b>${g.role}</b>
              <form method="post" action="${BASE}/apps/${a.id}/groups/delete" class="u-inline">${csrf(s)}<input type="hidden" name="group_name" value="${g.group_name}"><input type="hidden" name="role" value="${g.role}"><button class="link-button" aria-label="Remove mapping ${g.group_name} to ${g.role}">×</button></form></span>`)}</div>`
          : html`<p class="muted">No group mappings.</p>`}
        <form method="post" action="${BASE}/apps/${a.id}/groups">${csrf(s)}
          <div class="form-grid">${input('group_name', 'Group (as in the token)', '', { required: true, placeholder: 'e.g. hr-managers' })}${input('role', 'Role in this app', '', { required: true, placeholder: 'e.g. manager' })}</div>
          <div class="buttons"><button class="btn">Add mapping</button></div>
        </form>`;
      editor = region('Access control', html`
        <form method="post" action="${BASE}/apps/${a.id}/access" class="search u-mwnone u-mb1">${csrf(s)}
          ${select('access_control', 'Who may sign in', a.access_control, [
            ['assigned', 'Only accounts listed below (role-based access)'],
            ['any_user', 'Any active account in the directory'],
          ])}
          <button class="btn u-selfend">Save</button>
        </form>
        <p class="muted">Accounts live in the <a href="${BASE}/users">user directory</a>; here you grant them access to <b>${a.name}</b> and assign roles, which authorization schemes and <code>meta.has_role()</code> check. Role changes apply at the user's next sign-in (their sessions in this app end).</p>
        <div class="table-wrap"><table class="report report-reflow"><thead><tr><th>Account</th><th>Roles in this app</th><th>Last sign-in</th><th></th></tr></thead><tbody>
          ${users.length
            ? users.map((u) => html`<tr>
                <td data-label="Account"><a href="${BASE}/users/${u.id}">${u.username}</a>${u.display_name ? html` <span class="muted">${u.display_name}</span>` : ''}${u.active ? '' : html` <b>(inactive)</b>`}</td>
                <td data-label="Roles"><form method="post" action="${BASE}/apps/${a.id}/access/${u.id}" class="search roles-form u-m0 u-mwnone">${csrf(s)}
                  <input name="roles" value="${u.roles.join(', ')}" aria-label="Roles of ${u.username}" placeholder="no roles"><button class="btn">Save</button>
                  ${roleHintsHtml(appHints, 'Add')}</form></td>
                <td data-label="Last sign-in">${u.last_login_at ? String(u.last_login_at).slice(0, 16) : '—'}</td>
                <td data-label=""><form method="post" action="${BASE}/apps/${a.id}/access/${u.id}/revoke">${csrf(s)}<button class="link-button" data-confirm="Revoke ${u.username}'s access to ${a.name}?">Revoke</button></form></td>
              </tr>`)
            : html`<tr><td colspan="4" class="empty">No accounts have access yet.</td></tr>`}
        </tbody></table></div>
        ${groupMap}
        <h3>Grant access</h3>
        <form method="post" action="${BASE}/apps/${a.id}/access">${csrf(s)}
          <div class="form-grid">
            <div class="field"><label class="label" for="f_grant_user">Account</label>
              <input id="f_grant_user" name="username" list="accounts-list" required autocomplete="off" placeholder="username">
              <datalist id="accounts-list">${accounts.map((x) => html`<option value="${x.username}"></option>`)}</datalist>
              <small class="help">An existing account. <a href="${BASE}/users">Create accounts in Users.</a></small></div>
            <div class="field"><label class="label" for="f_roles">Roles</label>
              <input id="f_roles" name="roles" placeholder="comma separated, or pick below">
              ${roleHintsHtml(appHints)}</div>
          </div>
          <div class="buttons"><button class="btn btn-hot">Grant access</button></div>
        </form>`);
    }

    const tree = html`<ul class="tree">
      <li class="group">Security</li>
      <li><a href="${BASE}/apps/${a.id}/shared"${!selKind && !newKind ? raw(' aria-current="page"') : ''}>${icon('users')}<span>Access control</span><span class="kind">${users.length}</span></a></li>
      <li class="group">Globalization</li>
      <li><a href="${BASE}/apps/${a.id}/globalization">${icon('file')}<span>Translations and text messages</span><span class="kind">${[a.language, ...(a.languages ?? [])].join(', ')}</span></a></li>
      <li class="group">Files and plug-ins</li>
      <li><a href="${BASE}/apps/${a.id}/static-files">${icon('file')}<span>Static application files</span></a></li>
      <li><a href="${BASE}/apps/${a.id}/plugins">${icon('layers')}<span>Plug-ins</span></a></li>
      <li class="group">Subscriptions</li>
      <li><a href="${BASE}/apps/${a.id}/subscriptions">${icon('layers')}<span>Subscriptions and subscribers</span>${a.app_type && a.app_type !== 'standard' ? html`<span class="kind">${a.app_type}</span>` : ''}</a></li>
      ${SHARED.map((kind) => {
        const spec = COMPONENTS[kind];
        return html`<li class="group">${spec.plural}<a href="?new=${kind}" aria-label="Add ${spec.label}">＋ Add</a></li>
          ${rows[kind].map((r) => html`<li><a href="?c=${kind}-${r.id}"${selKind === kind && selId === String(r.id) ? raw(' aria-current="page"') : ''}>${icon(kind === 'nav_entry' ? (r.icon ?? 'chevron') : spec.icon)}<span>${r.parent_id ? '↳ ' : ''}${spec.summary(r)}</span>${
            kind === 'nav_entry' && r.target_page ? html`<span class="kind">p${r.target_page}</span>` : kind === 'authz_scheme' ? html`<span class="kind">${r.type}</span>` : kind === 'app_process' ? html`<span class="kind">${r.point}</span>` : kind === 'report_layout' ? html`<span class="kind">${r.paper}${r.is_default ? ' · default' : ''}</span>` : kind === 'automation' ? html`<span class="kind">${r.enabled ? (r.last_status === 'error' || r.last_status === 'warning' ? r.last_status : r.schedule) : 'off'}</span>` : kind === 'web_credential' ? html`<span class="kind">${r.type}${r.secret_enc || !needsSecret(r) ? '' : ' · no secret'}</span>` : kind === 'rest_source' ? html`<span class="kind">${r.method}${r.sync_table ? ' · sync' : ''}</span>` : kind === 'list' ? html`<span class="kind">${r.type}</span>` : kind === 'supporting_script' ? html`<span class="kind">${r.kind}</span>` : kind === 'search_config' ? html`<span class="kind">${r.source_type}</span>` : ''
          }</a></li>`)}${kind === 'supporting_script' ? html`<li><a href="${BASE}/apps/${a.id}/supporting-objects">${icon('play')}<span>Review and run…</span></a></li>` : ''}`;
      })}
    </ul>`;

    const main = html`${appHeader(a, 'shared')}
      <div class="designer"><aside class="region region-standard">${tree}</aside><div>${editor}</div></div>`;
    const kindShown = selKind && SHARED.includes(selKind) ? selKind : newKind && SHARED.includes(newKind) ? newKind : '';
    return send(reply, s, shell(s, 'Shared Components', kindShown ? [...crumbsBase, [COMPONENTS[kindShown].plural, `${BASE}/apps/${a.id}/shared?type=${kindShown}`], [selKind ? 'Edit' : 'Create']] : [...crumbsBase.slice(0, 2), ['Shared Components']], main));
  });

  app.post(`${BASE}/apps/:id/shared/:kind/:cid?`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const { id, kind, cid } = req.params;
    if (!SHARED.includes(kind)) return reply.code(404).send('Unknown component type');
    try {
      const newId = await saveComponent(kind, 'app_id', id, cid, req.body ?? {});
      flash(s, `${COMPONENTS[kind].label} saved.`);
      return back(reply, s, `${BASE}/apps/${id}/shared?c=${kind}-${newId}`);
    } catch (e) {
      flash(s, (e as Error).message, 'error');
      return back(reply, s, `${BASE}/apps/${id}/shared?${cid ? `c=${kind}-${cid}` : `new=${kind}`}`);
    }
  });

  app.post(`${BASE}/apps/:id/shared/:kind/:cid/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const { id, kind, cid } = req.params;
    if (!SHARED.includes(kind)) return reply.code(404).send('Unknown component type');
    await owner.query(`delete from ${COMPONENTS[kind].table} where id = $1 and app_id = $2`, [cid, id]);
    flash(s, `${COMPONENTS[kind].label} deleted.`);
    return back(reply, s, `${BASE}/apps/${id}/shared`);
  });

  // ---------------------------------------------------------------- access control
  app.post(`${BASE}/apps/:id/access`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = req.body ?? {};
    try {
      if (b.access_control) {
        await owner.query('update meta.app set access_control = $2 where id = $1', [req.params.id, b.access_control === 'any_user' ? 'any_user' : 'assigned']);
        flash(s, 'Access control saved.');
      } else {
        const acc = await owner.one('select id from meta.account where lower(username) = lower($1)', [b.username?.trim() ?? '']);
        if (!acc) throw new Error(`There is no account "${b.username}". Create it under Users first.`);
        await grantAccess(req.params.id, acc.id, splitRoles(b.roles));
        flash(s, `Access granted to ${b.username}.`);
      }
    } catch (e) {
      flash(s, (e as Error).message, 'error');
    }
    return back(reply, s, `${BASE}/apps/${req.params.id}/shared`);
  });

  app.post(`${BASE}/apps/:id/groups`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = req.body ?? {};
    await owner.query('insert into meta.app_group_role (app_id, group_name, role) values ($1, $2, $3) on conflict do nothing', [
      req.params.id, b.group_name?.trim(), b.role?.trim().toLowerCase(),
    ]);
    flash(s, 'Group mapping added. It applies at the next sign-in.');
    return back(reply, s, `${BASE}/apps/${req.params.id}/shared`);
  });

  app.post(`${BASE}/apps/:id/groups/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    await owner.query('delete from meta.app_group_role where app_id = $1 and group_name = $2 and role = $3', [req.params.id, req.body?.group_name, req.body?.role]);
    flash(s, 'Group mapping removed. It applies at the next sign-in.');
    return back(reply, s, `${BASE}/apps/${req.params.id}/shared`);
  });

  app.post(`${BASE}/apps/:id/access/:accountId`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    await grantAccess(req.params.id, req.params.accountId, splitRoles(req.body?.roles));
    flash(s, 'Roles saved. They apply at the next sign-in.');
    return back(reply, s, `${BASE}/apps/${req.params.id}/shared`);
  });

  app.post(`${BASE}/apps/:id/access/:accountId/revoke`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    await owner.query('delete from meta.app_access where app_id = $1 and account_id = $2', [req.params.id, req.params.accountId]);
    await endSessions(req.params.accountId, req.params.id);
    flash(s, 'Access revoked.');
    return back(reply, s, `${BASE}/apps/${req.params.id}/shared`);
  });

}
