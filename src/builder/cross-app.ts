import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw } from '../html.ts';
import { icon } from '../icons.ts';
import { BASE, developer, region, send, shell, type Req } from './ui.ts';
import { currentWorkspace } from './workspaces.ts';
import { scopedTx as tx, type BuilderKey } from './i18n.ts';

// Cross-application reports (sprint 61; APEX: Workspace Utilities → Cross
// Application Reports): one read-only report per topic over every application
// of the current workspace. Each query takes the workspace id as $1 and
// returns app_id and app (the name) first; those become a link.

interface Report {
  /** Message keys (src/builder/i18n): the title, the introduction and the column labels. */
  title: BuilderKey;
  about: BuilderKey;
  columns: [key: string, label: BuilderKey, cls?: 'num'][];
  sql: string;
}

/** The current workspace's applications (alias a). */
const IN_WS = 'meta.app_workspace(a.id) = $1';

export const REPORTS: Record<string, Report> = {
  attributes: {
    title: 'xap.attributes.title',
    about: 'xap.attributes.about',
    columns: [['alias', 'xap.col.alias'], ['app_type', 'xap.col.type'], ['authentication', 'xap.col.sign_in'], ['availability', 'xap.col.availability'], ['build_status', 'xap.col.build_status'], ['debug_level', 'xap.col.debug', 'num'], ['language', 'xap.col.language'], ['db_role', 'xap.col.database_role'], ['updated', 'xap.col.updated']],
    sql: `select a.id as app_id, a.name as app, a.alias, a.app_type, a.authentication, a.availability, a.build_status, a.debug_level,
                 a.language, coalesce(a.db_role, '(runtime connection)') as db_role, to_char(a.updated_at, 'YYYY-MM-DD HH24:MI') as updated
            from meta.app a where ${IN_WS} order by lower(a.name)`,
  },
  'build-options': {
    title: 'xap.build_options.title',
    about: 'xap.build_options.about',
    columns: [['name', 'xap.col.build_option'], ['status', 'xap.col.status'], ['description', 'xap.col.description']],
    sql: `select a.id as app_id, a.name as app, b.name, b.status, b.description
            from meta.app a join meta.build_option b on b.app_id = a.id where ${IN_WS} order by lower(a.name), b.name`,
  },
  comments: {
    title: 'xap.comments.title',
    about: 'xap.comments.about',
    columns: [['page_no', 'xap.col.page', 'num'], ['author', 'xap.col.author'], ['created', 'xap.col.written'], ['body', 'xap.col.comment']],
    sql: `select a.id as app_id, a.name as app, c.page_no, c.author, to_char(c.created_at, 'YYYY-MM-DD HH24:MI') as created, left(c.body, 500) as body
            from meta.app a join meta.dev_comment c on c.app_id = a.id where ${IN_WS} order by c.created_at desc limit 500`,
  },
  authentication: {
    title: 'xap.authentication.title',
    about: 'xap.authentication.about',
    columns: [['authentication', 'xap.col.sign_in'], ['local_login', 'xap.col.passwords'], ['providers', 'xap.col.identity_providers'], ['ldap', 'xap.col.ldap_directories'], ['access_control', 'xap.col.access'], ['remember_me_days', 'xap.col.keep_me_signed_in_days', 'num'], ['login_page', 'xap.col.login_page', 'num'], ['password_reset', 'xap.col.forgot_password']],
    sql: `select a.id as app_id, a.name as app, a.authentication, case when a.local_login then 'yes' else 'no' end as local_login,
                 array_to_string(a.sso_providers, ', ') as providers, array_to_string(a.ldap_directories, ', ') as ldap,
                 a.access_control, a.remember_me_days, a.login_page, case when a.password_reset then 'yes' else 'no' end as password_reset
            from meta.app a where ${IN_WS} order by lower(a.name)`,
  },
  authorization: {
    title: 'xap.authorization.title',
    about: 'xap.authorization.about',
    columns: [['name', 'xap.col.scheme'], ['type', 'xap.col.type'], ['value', 'xap.col.checks'], ['error_message', 'xap.col.error_message']],
    sql: `select a.id as app_id, a.name as app, s.name, s.type, left(s.value, 300) as value, s.error_message
            from meta.app a join meta.authz_scheme s on s.app_id = a.id where ${IN_WS} order by lower(a.name), s.name`,
  },
  'password-items': {
    title: 'xap.password_items.title',
    about: 'xap.password_items.about',
    columns: [['page_no', 'xap.col.page', 'num'], ['name', 'xap.col.item'], ['label', 'xap.col.label'], ['reveal', 'xap.col.show_button'], ['required', 'xap.col.required']],
    sql: `select a.id as app_id, a.name as app, p.page_no, i.name, i.label,
                 case when (i.config ->> 'reveal')::boolean then 'yes' else 'no' end as reveal, case when i.required then 'yes' else 'no' end as required
            from meta.app a join meta.page p on p.app_id = a.id join meta.item i on i.page_id = p.id
           where ${IN_WS} and i.type = 'password' order by lower(a.name), p.page_no, i.seq`,
  },
  theme: {
    title: 'xap.theme.title',
    about: 'xap.theme.about',
    columns: [['base', 'xap.col.base_style'], ['style', 'xap.col.style'], ['nav', 'xap.col.navigation'], ['colors', 'xap.col.colours_set', 'num'], ['pwa', 'xap.col.installable_pwa']],
    sql: `select a.id as app_id, a.name as app, coalesce(a.theme ->> 'base', 'default') as base, coalesce(a.theme ->> 'style', '-') as style,
                 coalesce(a.theme ->> 'nav', 'side') as nav,
                 (select count(*) from jsonb_object_keys(coalesce(a.theme -> 'colors', '{}'::jsonb)))::int as colors,
                 case when a.pwa then 'yes' else 'no' end as pwa
            from meta.app a where ${IN_WS} order by lower(a.name)`,
  },
};

/** The links in Workspace utilities' side column. */
export const crossAppLinks = () =>
  Object.entries(REPORTS).map(([k, r]) => html`<li><a href="${BASE}/utilities/reports/${k}">${tx(r.title)}${icon('chevron')}</a></li>`);

export async function crossAppRoutes(app: FastifyInstance) {
  app.get(`${BASE}/utilities/reports/:kind`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const r = Object.hasOwn(REPORTS, req.params.kind) ? REPORTS[req.params.kind] : undefined;
    if (!r) return reply.code(404).send('Not found');
    const rows = (await owner.query(r.sql, [currentWorkspace(s)])).rows;
    const cell = (v: unknown) => (v === null || v === undefined || v === '' ? html`<span class="muted">-</span>` : String(v));
    const main = html`<div class="title-row"><h1>${tx(r.title)}</h1></div>
      <p class="muted u-mt0">${tx(r.about)} ${tx('xap.of_workspace', { name: s.workspace?.name ?? '' })}</p>
      <nav class="ide-tabs u-mb1" aria-label="${tx('xap.nav')}">${Object.entries(REPORTS).map(([k, x]) =>
        html`<a class="ide-tab" href="${BASE}/utilities/reports/${k}"${k === req.params.kind ? raw(' aria-current="page"') : ''}><span>${tx(x.title)}</span></a>`)}</nav>
      ${region(tx(r.title), rows.length
        ? html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>${tx('xap.application')}</th>${r.columns.map(([, l, c]) => html`<th${c ? raw(` class="${c}"`) : ''}>${tx(l)}</th>`)}</tr></thead>
            <tbody>${rows.map((row) => html`<tr><td data-label="${tx('xap.application')}"><a href="${BASE}/apps/${row.app_id}">${row.app}</a></td>
              ${r.columns.map(([k, l, c]) => html`<td data-label="${tx(l)}"${c ? raw(` class="${c}"`) : ''}>${cell(row[k])}</td>`)}</tr>`)}</tbody></table></div>`
        : html`<p class="muted">${tx('xap.nothing')}</p>`, html`<span class="count">${rows.length}</span>`)}`;
    return send(reply, s, shell(s, tx(r.title), [[tx('rail.app_builder'), BASE], [tx('wu.title'), `${BASE}/utilities`], [tx(r.title)]], main));
  });
}
