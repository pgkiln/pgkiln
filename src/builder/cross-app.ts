import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw } from '../html.ts';
import { icon } from '../icons.ts';
import { BASE, developer, region, send, shell, type Req } from './ui.ts';
import { currentWorkspace } from './workspaces.ts';

// Cross-application reports (sprint 61; APEX: Workspace Utilities → Cross
// Application Reports): one read-only report per topic over every application
// of the current workspace. Each query takes the workspace id as $1 and
// returns app_id and app (the name) first; those become a link.

interface Report {
  title: string;
  about: string;
  columns: [key: string, label: string, cls?: 'num'][];
  sql: string;
}

/** The current workspace's applications (alias a). */
const IN_WS = 'meta.app_workspace(a.id) = $1';

export const REPORTS: Record<string, Report> = {
  attributes: {
    title: 'Application attributes',
    about: 'The main settings of every application: type, sign-in, availability, build status, debug level, language and database role.',
    columns: [['alias', 'Alias'], ['app_type', 'Type'], ['authentication', 'Sign-in'], ['availability', 'Availability'], ['build_status', 'Build status'], ['debug_level', 'Debug', 'num'], ['language', 'Language'], ['db_role', 'Database role'], ['updated', 'Updated']],
    sql: `select a.id as app_id, a.name as app, a.alias, a.app_type, a.authentication, a.availability, a.build_status, a.debug_level,
                 a.language, coalesce(a.db_role, '(runtime connection)') as db_role, to_char(a.updated_at, 'YYYY-MM-DD HH24:MI') as updated
            from meta.app a where ${IN_WS} order by lower(a.name)`,
  },
  'build-options': {
    title: 'Build options',
    about: 'The build options of every application and whether their components are included.',
    columns: [['name', 'Build option'], ['status', 'Status'], ['description', 'Description']],
    sql: `select a.id as app_id, a.name as app, b.name, b.status, b.description
            from meta.app a join meta.build_option b on b.app_id = a.id where ${IN_WS} order by lower(a.name), b.name`,
  },
  comments: {
    title: 'Developer comments',
    about: 'The developers\' comments on applications and pages, newest first.',
    columns: [['page_no', 'Page', 'num'], ['author', 'Author'], ['created', 'Written'], ['body', 'Comment']],
    sql: `select a.id as app_id, a.name as app, c.page_no, c.author, to_char(c.created_at, 'YYYY-MM-DD HH24:MI') as created, left(c.body, 500) as body
            from meta.app a join meta.dev_comment c on c.app_id = a.id where ${IN_WS} order by c.created_at desc limit 500`,
  },
  authentication: {
    title: 'Authentication',
    about: 'How people sign in to every application: the sign-in method, password sign-in, identity providers and LDAP directories, access control, the login page and Forgot password.',
    columns: [['authentication', 'Sign-in'], ['local_login', 'Passwords'], ['providers', 'Identity providers'], ['ldap', 'LDAP directories'], ['access_control', 'Access'], ['remember_me_days', 'Keep me signed in (days)', 'num'], ['login_page', 'Login page', 'num'], ['password_reset', 'Forgot password']],
    sql: `select a.id as app_id, a.name as app, a.authentication, case when a.local_login then 'yes' else 'no' end as local_login,
                 array_to_string(a.sso_providers, ', ') as providers, array_to_string(a.ldap_directories, ', ') as ldap,
                 a.access_control, a.remember_me_days, a.login_page, case when a.password_reset then 'yes' else 'no' end as password_reset
            from meta.app a where ${IN_WS} order by lower(a.name)`,
  },
  authorization: {
    title: 'Authorization schemes',
    about: 'The authorization schemes of every application: their type and what they check.',
    columns: [['name', 'Scheme'], ['type', 'Type'], ['value', 'Checks'], ['error_message', 'Error message']],
    sql: `select a.id as app_id, a.name as app, s.name, s.type, left(s.value, 300) as value, s.error_message
            from meta.app a join meta.authz_scheme s on s.app_id = a.id where ${IN_WS} order by lower(a.name), s.name`,
  },
  'password-items': {
    title: 'Password items',
    about: 'Every password item: pgkiln never shows their values again, never keeps them in session state for the next page and never writes them to the debug log.',
    columns: [['page_no', 'Page', 'num'], ['name', 'Item'], ['label', 'Label'], ['reveal', 'Show button'], ['required', 'Required']],
    sql: `select a.id as app_id, a.name as app, p.page_no, i.name, i.label,
                 case when (i.config ->> 'reveal')::boolean then 'yes' else 'no' end as reveal, case when i.required then 'yes' else 'no' end as required
            from meta.app a join meta.page p on p.app_id = a.id join meta.item i on i.page_id = p.id
           where ${IN_WS} and i.type = 'password' order by lower(a.name), p.page_no, i.seq`,
  },
  theme: {
    title: 'Theme summary',
    about: 'The look of every application: base style, Theme Roller style, navigation and the colours it sets.',
    columns: [['base', 'Base style'], ['style', 'Style'], ['nav', 'Navigation'], ['colors', 'Colours set', 'num'], ['pwa', 'Installable (PWA)']],
    sql: `select a.id as app_id, a.name as app, coalesce(a.theme ->> 'base', 'default') as base, coalesce(a.theme ->> 'style', '-') as style,
                 coalesce(a.theme ->> 'nav', 'side') as nav,
                 (select count(*) from jsonb_object_keys(coalesce(a.theme -> 'colors', '{}'::jsonb)))::int as colors,
                 case when a.pwa then 'yes' else 'no' end as pwa
            from meta.app a where ${IN_WS} order by lower(a.name)`,
  },
};

/** The links in Workspace utilities' side column. */
export const crossAppLinks = () =>
  Object.entries(REPORTS).map(([k, r]) => html`<li><a href="${BASE}/utilities/reports/${k}">${r.title}${icon('chevron')}</a></li>`);

export async function crossAppRoutes(app: FastifyInstance) {
  app.get(`${BASE}/utilities/reports/:kind`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const r = Object.hasOwn(REPORTS, req.params.kind) ? REPORTS[req.params.kind] : undefined;
    if (!r) return reply.code(404).send('Not found');
    const rows = (await owner.query(r.sql, [currentWorkspace(s)])).rows;
    const cell = (v: unknown) => (v === null || v === undefined || v === '' ? html`<span class="muted">-</span>` : String(v));
    const main = html`<div class="title-row"><h1>${r.title}</h1></div>
      <p class="muted u-mt0">${r.about} Applications of the workspace ${s.workspace?.name ?? ''}.</p>
      <nav class="ide-tabs u-mb1" aria-label="Cross-application reports">${Object.entries(REPORTS).map(([k, x]) =>
        html`<a class="ide-tab" href="${BASE}/utilities/reports/${k}"${k === req.params.kind ? raw(' aria-current="page"') : ''}><span>${x.title}</span></a>`)}</nav>
      ${region(r.title, rows.length
        ? html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>Application</th>${r.columns.map(([, l, c]) => html`<th${c ? raw(` class="${c}"`) : ''}>${l}</th>`)}</tr></thead>
            <tbody>${rows.map((row) => html`<tr><td data-label="Application"><a href="${BASE}/apps/${row.app_id}">${row.app}</a></td>
              ${r.columns.map(([k, l, c]) => html`<td data-label="${l}"${c ? raw(` class="${c}"`) : ''}>${cell(row[k])}</td>`)}</tr>`)}</tbody></table></div>`
        : html`<p class="muted">Nothing to report in this workspace.</p>`, html`<span class="count">${rows.length}</span>`)}`;
    return send(reply, s, shell(s, r.title, [['App Builder', BASE], ['Workspace utilities', `${BASE}/utilities`], [r.title]], main));
  });
}
