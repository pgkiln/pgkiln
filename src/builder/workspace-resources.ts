import type { FastifyInstance, FastifyReply } from 'fastify';
import { owner } from '../db.ts';
import { html } from '../html.ts';
import { icon } from '../icons.ts';
import { scopeForWorkspace } from '../network-acl.ts';
import { ENV_PREFIX, serverProblems, serverUrl, type RemoteServer } from '../remote-servers.ts';
import { readMultipart } from '../runtime/files.ts';
import { includable, STATIC_MAX, STATIC_TYPES, staticType } from '../runtime/static-files.ts';
import { encryptSecret, secretKeyConfigured } from '../secrets.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import { scopeProblem, urlProblem } from '../webclient.ts';
import { clearResponseCache, clearTokens, credentialProblems, GRANT_TYPES } from '../websources.ts';
import { back, BASE, csrf, developer, flash, input, region, select, send, shell, type Body, type Req } from './ui.ts';
import { workspaceAdmin } from './workspaces.ts';
import { scopedTx as tx } from './i18n.ts';

// (sprint 141, AP-7) Workspace utilities → Static workspace files, Remote
// servers and Web credentials (APEX: Static Workspace Files, Remote Servers,
// workspace Web Credentials), for the developer's current workspace. Its
// developers see them; its administrators (and the installation's) change
// them. Nothing here reaches another workspace: every query is bound to the
// current workspace's id.
//
//   /builder/workspace-files        CSS, JavaScript, images and fonts every application of the workspace may
//                                   load (#WORKSPACE_FILES#name; served at /a/<alias>/workspace-files/<name>)
//   /builder/remote-servers         named base URLs (src/remote-servers.ts) and what uses them
//   /builder/workspace-credentials  web credentials the applications use by name; secrets write-only

const FILES = `${BASE}/workspace-files`;
const SERVERS = `${BASE}/remote-servers`;
const CREDS = `${BASE}/workspace-credentials`;
const crumbs = (title: string): [string, string?][] => [[tx('wres.app_builder'), BASE], [tx('wres.workspace_utilities'), `${BASE}/utilities`], [title]];
const id = (v: unknown) => (/^\d{1,9}$/.test(String(v ?? '')) ? Number(v) : null);
const when = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '');
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const editable = (name: string) => /^text\/|^application\/json$/.test(staticType(name) ?? '');

interface Ctx {
  s: Session;
  ws: { id: number; name: string };
  admin: boolean;
}

/** The developer's current workspace and whether they manage it; null after answering (no workspace). */
async function context(req: Req, reply: FastifyReply, title: string): Promise<Ctx | null> {
  const s = await developer(req, reply);
  if (!s) return null;
  if (!s.workspace) {
    await send(reply.code(403), s, shell(s, title, crumbs(title), html`<h1 class="u-mb1">${title}</h1><div class="alert alert-error" role="alert">${tx('wres.you_are_not_a_developer')}</div>`));
    return null;
  }
  return { s, ws: { id: s.workspace.id, name: s.workspace.name }, admin: await workspaceAdmin(s.username, s.workspace.id) };
}

/** For changes: the workspace's administrators only (403 otherwise). */
async function manager(req: Req, reply: FastifyReply, title: string): Promise<Ctx | null> {
  const c = await context(req, reply, title);
  if (!c) return null;
  if (c.admin) return c;
  await send(reply.code(403), c.s, shell(c.s, title, crumbs(title), html`<h1 class="u-mb1">${title}</h1><div class="alert alert-error" role="alert">${tx('wres.only_the_workspace_s_administrators')}</div>`));
  return null;
}

const readOnlyNote = (c: Ctx) => (c.admin ? '' : html`<div class="alert alert-info" role="status">${tx('wres.you_can_see_these_the')}</div>`);

// ====================================================================== static workspace files

/** The applications of the workspace that load a file (every page, or some pages). */
async function fileUsers(wsId: number) {
  const rows = (await owner.query<{ name: string; alias: string; pages: number[] | null }>(
    `select substr(u.n, 18) as name, a.alias, null::int[] as pages
       from meta.app a, unnest(a.static_includes) u(n) where meta.app_workspace(a.id) = $1 and u.n like '#WORKSPACE\\_FILES#%'
     union all
     select substr(u.n, 18), a.alias, array_agg(p.page_no order by p.page_no)
       from meta.app a join meta.page p on p.app_id = a.id, unnest(p.static_includes) u(n)
      where meta.app_workspace(a.id) = $1 and u.n like '#WORKSPACE\\_FILES#%' group by 1, 2
      order by 2, 3 nulls first`, [wsId])).rows;
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.name, [...(out.get(r.name) ?? []), r.pages ? `${r.alias} (page ${r.pages.join(', ')})` : r.alias]);
  return out;
}

async function filesPage(c: Ctx, query: Record<string, string | undefined>) {
  const { s, ws } = c;
  const files = (await owner.query<{ name: string; mime: string; bytes: string; changed: Date; updated_by: string | null }>(
    'select name, mime, octet_length(content) as bytes, updated_at as changed, updated_by from meta.workspace_file where workspace_id = $1 order by name', [ws.id])).rows;
  const users = await fileUsers(ws.id);
  const editName = c.admin && query.edit && files.some((f) => f.name === query.edit) && editable(query.edit) ? query.edit : null;
  const creating = c.admin && query.new === '1';
  const content = editName
    ? (await owner.one<{ content: Buffer }>('select content from meta.workspace_file where workspace_id = $1 and name = $2', [ws.id, editName]))!.content.toString('utf8')
    : '';
  const editor = editName || creating
    ? region(editName ? tx('wres.edit_named', { name: editName }) : tx('wres.new_file'), html`<form method="post" action="${FILES}/save">${csrf(s)}
        ${editName ? html`<input type="hidden" name="original" value="${editName}">` : ''}
        <div class="form-grid">${input('name', tx('wres.file_name'), editName ?? '', { required: true, placeholder: 'brand.css', help: tx('wres.letters_digits_and_e_g') })}</div>
        <div class="field" data-wide><label class="label" for="f_content">${tx('wres.content')}</label>
          <textarea id="f_content" name="content" class="code" rows="18" spellcheck="false">${content}</textarea></div>
        <div class="buttons"><a class="btn" href="${FILES}">${tx('wres.cancel')}</a><button class="btn btn-hot">${icon('check')} ${tx('wres.save')}</button></div>
      </form>`)
    : '';
  return html`<div class="title-row"><h1>${tx('wres.static_workspace_files')}</h1></div>
    <p class="muted u-mt0">${tx.rich('wres.files_intro', { workspace: ws.name, tag: html`<code>#WORKSPACE_FILES#<i>name</i></code>`, sub: html`<code>#WORKSPACE_FILES#</code>`, path: html`<code>/a/<i>alias</i>/workspace-files/<i>name</i></code>`, size: size(STATIC_MAX) })}</p>
    ${readOnlyNote(c)}
    ${editor}
    ${region(tx('wres.files'), html`${files.length
      ? html`<div class="table-wrap"><table class="report report-reflow">
          <thead><tr><th scope="col">${tx('wres.name')}</th><th scope="col">${tx('wres.type')}</th><th scope="col" class="num">${tx('wres.size')}</th><th scope="col">${tx('wres.loaded_by')}</th><th scope="col">${tx('wres.changed_utc')}</th>${c.admin ? html`<th scope="col">${tx('wres.actions')}</th>` : ''}</tr></thead>
          <tbody>${files.map((f) => html`<tr>
            <td data-label="${tx('wres.name')}" class="u-break"><a href="${FILES}/file/${encodeURIComponent(f.name)}" target="_blank" rel="noopener">${f.name}</a></td>
            <td data-label="${tx('wres.type')}">${f.mime}</td><td class="num" data-label="${tx('wres.size')}">${size(Number(f.bytes))}</td>
            <td data-label="${tx('wres.loaded_by')}" class="u-break">${includable(f.name) ? (users.get(f.name)?.join(', ') || html`<span class="muted">-</span>`) : ''}</td>
            <td data-label="${tx('wres.changed')}">${when(f.changed)}${f.updated_by ? html` <span class="muted">${f.updated_by}</span>` : ''}</td>
            ${c.admin ? html`<td data-label="${tx('wres.actions')}" class="nowrap">${editable(f.name) ? html`<a class="btn btn-small" href="${FILES}?edit=${encodeURIComponent(f.name)}">${tx('wres.edit')}</a> ` : ''}
              <form method="post" action="${FILES}/delete" class="inline">${csrf(s)}<input type="hidden" name="name" value="${f.name}">
                <button class="btn btn-small btn-danger" data-confirm="${tx('wres.delete_file_confirm', { name: f.name })}" aria-label="${tx('wres.delete_named', { name: f.name })}">${icon('trash')}</button></form></td>` : ''}
          </tr>`)}</tbody></table></div>`
      : html`<p class="muted">${tx('wres.no_files_yet')}</p>`}
      ${c.admin ? html`<div class="buttons u-mt1"><a class="btn" href="${FILES}?new=1">${icon('plus')} ${tx('wres.new_file')}</a></div>
      <form method="post" action="${FILES}/upload" enctype="multipart/form-data" class="search u-mwnone u-mt1">${csrf(s)}
        <input type="file" name="file" multiple aria-label="${tx('wres.files_to_upload')}" accept="${Object.keys(STATIC_TYPES).map((x) => `.${x}`).join(',')}">
        <button class="btn">${icon('upload')} ${tx('wres.upload')}</button>
        <small class="help">${tx('wres.a_file_with_the_same')}</small>
      </form>` : ''}`)}`;
}

/** Insert or replace a file of the workspace. */
const storeFile = (wsId: number, name: string, type: string, data: Buffer, by: string | null) =>
  owner.query(
    `insert into meta.workspace_file (workspace_id, name, mime, content, updated_by) values ($1, $2, $3, $4, $5)
     on conflict (workspace_id, name) do update set mime = excluded.mime, content = excluded.content, updated_by = excluded.updated_by, updated_at = now()`,
    [wsId, name, type, data, by]);

// ====================================================================== remote servers

interface ServerRow extends RemoteServer {
  updated_at: Date;
  updated_by: string | null;
}

/** What uses each server of the workspace: REST data sources (by application), catalogs, AI services. */
async function serverUsers(wsId: number) {
  const rows = (await owner.query<{ server: string; what: string }>(
    `select s.server, 'REST data source ' || a.alias || '.' || s.name as what
       from meta.rest_source s join meta.app a on a.id = s.app_id where s.server is not null and meta.app_workspace(a.id) = $1
     union all
     select c.server, 'catalog ' || c.name from meta.rest_catalog c where c.workspace_id = $1 and c.server is not null
     union all
     select r.static_id, 'AI service ' || x.name from meta.ai_service x join meta.remote_server r on r.id = x.server_id where r.workspace_id = $1
     order by 1, 2`, [wsId])).rows;
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.server, [...(out.get(r.server) ?? []), r.what]);
  return out;
}

async function serversPage(c: Ctx, query: Record<string, string | undefined>) {
  const { s, ws } = c;
  const servers = (await owner.query<ServerRow>('select * from meta.remote_server where workspace_id = $1 order by static_id', [ws.id])).rows;
  const users = await serverUsers(ws.id);
  const scope = await scopeForWorkspace(ws.id, 'check');
  const editing = c.admin && query.edit ? servers.find((x) => String(x.id) === query.edit) ?? null : null;
  const creating = c.admin && query.new === '1';
  const v: Partial<ServerRow> = editing ?? {};
  const verdict = (x: RemoteServer) => {
    const u = serverUrl(x);
    if (!u.url) return html`<span class="tag tag-error">${u.problem}</span>`;
    let url: URL;
    try {
      url = new URL(u.url);
    } catch {
      return html`<span class="tag tag-error">${tx('wres.not_a_valid_url')}</span>`;
    }
    const problem = urlProblem(url) ?? scopeProblem(scope, url);
    return problem ? html`<span class="tag tag-error">refused</span> <span class="muted small">${problem}</span>` : html`<span class="tag tag-ok">${tx('wres.may_be_called')}</span>`;
  };
  const form = editing || creating
    ? region(editing ? tx('wres.server_title', { id: editing.static_id }) : tx('wres.new_remote_server'), html`<form method="post" action="${SERVERS}">${csrf(s)}
        ${editing ? html`<input type="hidden" name="id" value="${editing.id}">` : ''}
        <div class="form-grid">
          ${input('static_id', tx('wres.static_id'), v.static_id ?? '', { required: true, placeholder: 'CRM', help: tx('wres.upper_case_letters_digits_and') })}
          ${input('name', tx('wres.name'), v.name ?? '', { required: true, placeholder: tx('wres.crm_system') })}
          ${input('base_url', tx('wres.base_url_this_installation'), v.base_url ?? '', { placeholder: tx('wres.https_crm_example_com_api'), help: tx('wres.no_trailing_slash_query_or') })}
          ${input('env_var', tx('wres.or_from_the_environment_variable'), v.env_var ?? '', { placeholder: `${ENV_PREFIX}CRM`, help: tx('wres.env_help', { prefix: ENV_PREFIX }) })}
          ${input('credential', tx('wres.default_web_credential'), v.credential ?? '', { placeholder: tx('wres.e_g_crm_api'), help: tx('wres.sources_on_this_server_that') })}
          <div class="field" data-wide><label class="label" for="f_description">${tx('wres.description')}</label><textarea id="f_description" name="description" rows="2">${v.description ?? ''}</textarea></div>
        </div>
        <div class="buttons"><a class="btn" href="${SERVERS}">${tx('wres.cancel')}</a><button class="btn btn-hot">${icon('check')} ${tx('wres.save')}</button></div></form>
        ${editing ? html`<form method="post" action="${SERVERS}/${editing.id}/delete" class="danger-zone">${csrf(s)}
          <button class="btn btn-danger" data-confirm="${tx('wres.delete_server_confirm', { id: editing.static_id })}">${tx('wres.delete_server')}</button></form>` : ''}`, '', 'server-form')
    : '';
  return html`<div class="title-row"><h1>${tx('wres.remote_servers')}</h1>${c.admin ? html`<a class="btn" href="${SERVERS}?new=1#server-form">${icon('plus')} ${tx('wres.new_server')}</a>` : ''}</div>
    <p class="muted u-mt0">${tx.rich('wres.servers_intro', { workspace: ws.name, network: html`<a href="${BASE}/network">${tx('wres.network_access')}</a>` })}</p>
    ${readOnlyNote(c)}
    ${form}
    ${region(tx('wres.servers'), html`<div class="table-wrap"><table class="report report-reflow">
      <thead><tr><th>${tx('wres.server')}</th><th>${tx('wres.url_now')}</th><th>${tx('wres.network_access_2')}</th><th>${tx('wres.default_credential')}</th><th>${tx('wres.used_by')}</th></tr></thead>
      <tbody>${servers.length ? servers.map((x) => {
        const u = serverUrl(x);
        return html`<tr>
          <td data-label="${tx('wres.server')}">${c.admin ? html`<a href="${SERVERS}?edit=${x.id}#server-form">${x.static_id}</a>` : x.static_id}<br><span class="muted small">${x.name}</span></td>
          <td data-label="${tx('wres.url_now')}" class="u-break">${u.url ? html`<code>${u.url}</code>` : ''}<br><span class="muted small">${u.from === 'env' ? `from ${x.env_var}` : x.env_var ? `stored (${x.env_var} is not set)` : 'stored'}</span></td>
          <td data-label="${tx('wres.network_access_2')}">${verdict(x)}</td>
          <td data-label="${tx('wres.default_credential')}">${x.credential ?? html`<span class="muted">none</span>`}</td>
          <td data-label="${tx('wres.used_by')}" class="u-break">${users.get(x.static_id)?.join(', ') || html`<span class="muted">${tx('wres.nothing_yet')}</span>`}</td></tr>`;
      }) : html`<tr><td colspan="5" class="empty">${tx('wres.no_remote_servers_yet')}</td></tr>`}</tbody></table></div>`)}`;
}

// ====================================================================== workspace web credentials

interface CredentialRow {
  id: number;
  name: string;
  description: string | null;
  type: string;
  username: string | null;
  header_name: string | null;
  token_url: string | null;
  scope: string | null;
  valid_for: string[];
  grant_type: string;
  oauth_username: string | null;
  has_secret: boolean;
  has_password: boolean;
  has_refresh: boolean;
  updated_at: Date;
  updated_by: string | null;
}

/** Never the encrypted columns themselves: only whether they are set. */
const CRED_COLUMNS = `id, name, description, type, username, header_name, token_url, scope, valid_for, grant_type, oauth_username,
  secret_enc is not null as has_secret, password_enc is not null as has_password, refresh_token_enc is not null as has_refresh, updated_at, updated_by`;

async function credentialsPage(c: Ctx, query: Record<string, string | undefined>) {
  const { s, ws } = c;
  const creds = (await owner.query<CredentialRow>(`select ${CRED_COLUMNS} from meta.workspace_credential where workspace_id = $1 order by name`, [ws.id])).rows;
  // applications with a credential of the same name (theirs wins)
  const shadowed = (await owner.query<{ name: string; apps: string }>(
    `select c.name, string_agg(a.alias, ', ' order by a.alias) as apps from meta.web_credential c join meta.app a on a.id = c.app_id
      where meta.app_workspace(a.id) = $1 and c.name in (select name from meta.workspace_credential where workspace_id = $1) group by 1`, [ws.id])).rows;
  const editing = c.admin && query.edit ? creds.find((x) => String(x.id) === query.edit) ?? null : null;
  const creating = c.admin && query.new === '1';
  const v: Partial<CredentialRow> = editing ?? { type: 'basic', grant_type: 'client_credentials' };
  const secret = (name: string, label: string, stored: boolean | undefined, help: string) =>
    html`${input(name, label, '', { type: 'password', auto: 'new-password', help: `${help} ${stored ? tx('wres.one_is_stored_encrypted_it') : tx('wres.write_only_never_shown_again')}` })}
      ${stored ? html`<div class="field"><label class="check"><input type="checkbox" name="remove_${name}" value="true"> ${tx('wres.remove_stored', { what: label.toLowerCase() })}</label></div>` : ''}`;
  const form = editing || creating
    ? region(editing ? tx('wres.credential_title', { name: editing.name }) : tx('wres.new_web_credential'), html`<form method="post" action="${CREDS}">${csrf(s)}
        ${editing ? html`<input type="hidden" name="id" value="${editing.id}">` : ''}
        ${secretKeyConfigured() ? '' : html`<div class="alert alert-error" role="alert">${tx.code('wres.no_secret_key')}</div>`}
        <div class="form-grid">
          ${input('name', tx('wres.name'), v.name ?? '', { required: true, placeholder: 'CRM_API', help: tx('wres.the_applications_of_the_workspace') })}
          ${select('type', tx('wres.authentication'), v.type ?? 'basic', ['basic', 'header', 'bearer', 'oauth2', 'aws_sigv4'], tx('wres.type_help'))}
          ${input('username', tx('wres.user_name_client_id_access'), v.username ?? '')}
          ${select('grant_type', tx('wres.grant_type_oauth2'), v.grant_type ?? 'client_credentials', GRANT_TYPES)}
          ${input('oauth_username', tx('wres.oauth2_user_name_password_grant'), v.oauth_username ?? '')}
          ${input('header_name', tx('wres.header_name_header'), v.header_name ?? '', { placeholder: tx('wres.x_api_key') })}
          ${input('token_url', tx('wres.token_url_oauth2'), v.token_url ?? '', { placeholder: tx('wres.https_login_example_com_oauth') })}
          ${input('scope', tx('wres.scope_oauth2_region_aws_sigv4'), v.scope ?? '')}
          ${input('valid_for', tx('wres.valid_for_urls'), (v.valid_for ?? []).join(', '), { placeholder: tx('wres.https_crm_example_com_api_2'), help: tx('wres.comma_separated_url_prefixes_the') })}
          ${secret('secret', tx('wres.secret'), v.has_secret, tx('wres.the_password_header_value_token'))}
          ${secret('password', 'OAuth2 password', v.has_password, tx('wres.the_password_grant_the_oauth2'))}
          ${secret('refresh_token', tx('wres.refresh_token'), v.has_refresh, tx('wres.the_refresh_token_grant_a'))}
          <div class="field" data-wide><label class="label" for="f_description">${tx('wres.description')}</label><textarea id="f_description" name="description" rows="2">${v.description ?? ''}</textarea></div>
        </div>
        <div class="buttons"><a class="btn" href="${CREDS}">${tx('wres.cancel')}</a><button class="btn btn-hot">${icon('check')} ${tx('wres.save')}</button></div></form>
        ${editing ? html`<form method="post" action="${CREDS}/${editing.id}/delete" class="danger-zone">${csrf(s)}
          <button class="btn btn-danger" data-confirm="${tx('wres.delete_credential_confirm', { name: editing.name })}">${tx('wres.delete_credential')}</button></form>` : ''}`, '', 'credential-form')
    : '';
  return html`<div class="title-row"><h1>${tx('wres.workspace_web_credentials')}</h1>${c.admin ? html`<a class="btn" href="${CREDS}?new=1#credential-form">${icon('plus')} ${tx('wres.new_credential')}</a>` : ''}</div>
    <p class="muted u-mt0">${tx('wres.credentials_intro', { workspace: ws.name })}</p>
    ${readOnlyNote(c)}
    ${form}
    ${region(tx('wres.credentials'), html`<div class="table-wrap"><table class="report report-reflow">
      <thead><tr><th>${tx('wres.name')}</th><th>${tx('wres.authentication')}</th><th>${tx('wres.secret')}</th><th>${tx('wres.valid_for')}</th><th>${tx('wres.overridden_by')}</th><th>${tx('wres.changed_utc')}</th></tr></thead>
      <tbody>${creds.length ? creds.map((x) => html`<tr>
        <td data-label="${tx('wres.name')}">${c.admin ? html`<a href="${CREDS}?edit=${x.id}#credential-form">${x.name}</a>` : x.name}${x.description ? html`<br><span class="muted small">${x.description}</span>` : ''}</td>
        <td data-label="${tx('wres.authentication')}">${x.type}${x.type === 'oauth2' ? html` <span class="muted">(${x.grant_type})</span>` : ''}</td>
        <td data-label="${tx('wres.secret')}">${x.has_secret || x.has_password || x.has_refresh ? 'stored (encrypted)' : html`<span class="muted">${tx('wres.none_yet')}</span>`}</td>
        <td data-label="${tx('wres.valid_for')}" class="u-break">${x.valid_for.length ? x.valid_for.join(', ') : html`<span class="muted">${tx('wres.any_url')}</span>`}</td>
        <td data-label="${tx('wres.overridden_by')}" class="u-break">${shadowed.find((r) => r.name === x.name)?.apps ?? html`<span class="muted">-</span>`}</td>
        <td data-label="${tx('wres.changed')}">${when(x.updated_at)}${x.updated_by ? html` <span class="muted">${x.updated_by}</span>` : ''}</td></tr>`)
        : html`<tr><td colspan="6" class="empty">${tx('wres.no_workspace_web_credentials_yet')}</td></tr>`}</tbody></table></div>`)}`;
}

// ====================================================================== routes

export async function workspaceResourceRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- files
  app.get(FILES, async (req: Req, reply) => {
    const c = await context(req, reply, tx('wres.files_title'));
    if (!c) return;
    return send(reply, c.s, shell(c.s, tx('wres.files_title'), crumbs(tx('wres.files_title')), await filesPage(c, req.query ?? {})));
  });

  // a file for the workspace's developers, with the headers the applications serve it with
  app.get(`${FILES}/file/:name`, async (req: Req, reply) => {
    const c = await context(req, reply, tx('wres.files_title'));
    if (!c) return;
    const type = staticType(String(req.params.name));
    const f = type ? await owner.one<{ content: Buffer }>('select content from meta.workspace_file where workspace_id = $1 and name = $2', [c.ws.id, req.params.name]) : null;
    if (!f) return reply.code(404).type('text/plain').send('Not found');
    reply.type(type!.startsWith('text/') ? `${type}; charset=utf-8` : type!).header('x-content-type-options', 'nosniff').header('cache-control', 'no-store')
      // a script or a document opened here never runs on the builder's origin
      .header('content-security-policy', `default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox`);
    if (/^(text\/javascript|application\/json)/.test(type!)) reply.header('content-disposition', 'inline');
    return reply.send(f.content);
  });

  app.post(`${FILES}/upload`, async (req: Req, reply) => {
    let uploads: { filename: string; data: Buffer; truncated: boolean }[] = [];
    if (req.isMultipart()) {
      const parsed = await readMultipart(req, STATIC_MAX / 1024 / 1024);
      req.body = parsed.body as Body;
      uploads = parsed.lists.get('file') ?? [];
    }
    const c = await manager(req, reply, tx('wres.files_title'));
    if (!c) return;
    const { s } = c;
    if (!uploads.length) {
      flash(s, tx('wres.choose_one_or_more_files'), 'error');
      return back(reply, s, FILES);
    }
    const saved: string[] = [];
    for (const u of uploads) {
      const name = u.filename.split(/[\\/]/).pop()!.trim();
      const type = staticType(name);
      if (u.truncated) flash(s, `${name} is larger than ${size(STATIC_MAX)}.`, 'error');
      else if (!type) flash(s, `${name}: not an allowed name or type (letters, digits, _, - and .; ${Object.keys(STATIC_TYPES).join(', ')}).`, 'error');
      else {
        await storeFile(c.ws.id, name, type, u.data, s.username);
        saved.push(name);
      }
    }
    if (saved.length) {
      await logActivity({ appId: null, username: s.username, event: 'workspace', ip: clientIp(req), detail: `workspace ${c.ws.id} files uploaded: ${saved.join(', ')}`.slice(0, 1000) });
      flash(s, `Uploaded: ${saved.join(', ')}.`);
    }
    return back(reply, s, FILES);
  });

  app.post(`${FILES}/save`, async (req: Req, reply) => {
    const c = await manager(req, reply, tx('wres.files_title'));
    if (!c) return;
    const { s } = c;
    const b = req.body ?? {};
    const name = String(b.name ?? '').trim();
    const original = b.original ? String(b.original) : null;
    const type = staticType(name);
    const content = Buffer.from(String(b.content ?? '').replace(/\r\n/g, '\n'), 'utf8');
    if (!type || !editable(name)) {
      flash(s, tx('wres.the_name_must_end_in'), 'error');
      return back(reply, s, original ? `${FILES}?edit=${encodeURIComponent(original)}` : `${FILES}?new=1`);
    }
    if (content.length > STATIC_MAX) {
      flash(s, tx('wres.too_large', { size: size(STATIC_MAX) }), 'error');
      return back(reply, s, FILES);
    }
    try {
      if (original && original !== name) {
        const r = await owner.query('update meta.workspace_file set name = $3, mime = $4, content = $5, updated_by = $6, updated_at = now() where workspace_id = $1 and name = $2',
          [c.ws.id, original, name, type, content, s.username]);
        if (!r.rowCount) throw new Error(tx('wres.no_such_file'));
      } else await storeFile(c.ws.id, name, type, content, s.username);
      await logActivity({ appId: null, username: s.username, event: 'workspace', ip: clientIp(req), detail: `workspace ${c.ws.id} file saved: ${name}` });
      flash(s, `${name} saved.`);
      return back(reply, s, `${FILES}?edit=${encodeURIComponent(name)}`);
    } catch (e) {
      flash(s, (e as Error).message.includes('workspace_file_workspace_id_name_key') ? tx('wres.file_exists', { name }) : (e as Error).message, 'error');
      return back(reply, s, FILES);
    }
  });

  app.post(`${FILES}/delete`, async (req: Req, reply) => {
    const c = await manager(req, reply, tx('wres.files_title'));
    if (!c) return;
    const name = String(req.body?.name ?? '');
    const r = await owner.query('delete from meta.workspace_file where workspace_id = $1 and name = $2', [c.ws.id, name]);
    if (r.rowCount) await logActivity({ appId: null, username: c.s.username, event: 'workspace', ip: clientIp(req), detail: `workspace ${c.ws.id} file deleted: ${name}` });
    flash(c.s, r.rowCount ? `${name} deleted.` : tx('wres.no_such_file'), r.rowCount ? 'ok' : 'error');
    return back(reply, c.s, FILES);
  });

  // ---------------------------------------------------------------- remote servers
  app.get(SERVERS, async (req: Req, reply) => {
    const c = await context(req, reply, tx('wres.servers_title'));
    if (!c) return;
    return send(reply, c.s, shell(c.s, tx('wres.servers_title'), crumbs(tx('wres.servers_title')), await serversPage(c, req.query ?? {})));
  });

  app.post(SERVERS, async (req: Req, reply) => {
    const c = await manager(req, reply, tx('wres.servers_title'));
    if (!c) return;
    const { s } = c;
    const b = req.body ?? {};
    const text = (k: string) => String(b[k] ?? '').trim() || null;
    const v = {
      static_id: String(b.static_id ?? '').trim().toUpperCase(), name: String(b.name ?? '').trim(), description: text('description'),
      base_url: text('base_url')?.replace(/\/+$/, '') ?? null, env_var: text('env_var')?.toUpperCase() ?? null, credential: text('credential')?.toUpperCase() ?? null,
    };
    const editId = id(b.id);
    const retry = editId ? `${SERVERS}?edit=${editId}#server-form` : `${SERVERS}?new=1#server-form`;
    const problems = serverProblems(v);
    if (problems.length) {
      flash(s, problems.join(' '), 'error');
      return back(reply, s, retry);
    }
    try {
      await owner.tx(async (db) => {
        if (editId) {
          const old = (await db.query<{ static_id: string }>('select static_id from meta.remote_server where id = $1 and workspace_id = $2 for update', [editId, c.ws.id])).rows[0];
          if (!old) throw new Error(tx('wres.no_such_remote_server'));
          await db.query(
            `update meta.remote_server set static_id = $3, name = $4, description = $5, base_url = $6, env_var = $7, credential = $8, updated_by = $9, updated_at = now()
              where id = $1 and workspace_id = $2`, [editId, c.ws.id, v.static_id, v.name, v.description, v.base_url, v.env_var, v.credential, s.username]);
          // a renamed server: this workspace's sources and catalogs follow it
          if (old.static_id !== v.static_id) {
            await db.query('update meta.rest_source x set server = $3 from meta.app a where a.id = x.app_id and meta.app_workspace(a.id) = $1 and x.server = $2', [c.ws.id, old.static_id, v.static_id]);
            await db.query('update meta.rest_catalog set server = $3 where workspace_id = $1 and server = $2', [c.ws.id, old.static_id, v.static_id]);
          }
        } else
          await db.query(
            `insert into meta.remote_server (workspace_id, static_id, name, description, base_url, env_var, credential, updated_by) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [c.ws.id, v.static_id, v.name, v.description, v.base_url, v.env_var, v.credential, s.username]);
      });
      // cached REST responses were fetched from the old URL
      clearResponseCache();
      await logActivity({ appId: null, username: s.username, event: 'workspace', ip: clientIp(req),
        detail: `workspace ${c.ws.id} remote server ${v.static_id} ${editId ? 'changed' : 'added'}: ${v.base_url ?? ''}${v.env_var ? ` (${v.env_var})` : ''}`.slice(0, 1000) });
      flash(s, tx('wres.server_saved', { id: v.static_id }));
      return back(reply, s, SERVERS);
    } catch (e) {
      flash(s, (e as Error).message.includes('remote_server_workspace_id_static_id_key') ? tx('wres.server_exists', { id: v.static_id }) : (e as Error).message, 'error');
      return back(reply, s, retry);
    }
  });

  app.post(`${SERVERS}/:sid/delete`, async (req: Req, reply) => {
    const c = await manager(req, reply, tx('wres.servers_title'));
    if (!c) return;
    const r = await owner.one<{ static_id: string }>('delete from meta.remote_server where id = $1 and workspace_id = $2 returning static_id', [id(req.params.sid), c.ws.id]);
    if (r) {
      clearResponseCache();
      await logActivity({ appId: null, username: c.s.username, event: 'workspace', ip: clientIp(req), detail: `workspace ${c.ws.id} remote server ${r.static_id} deleted` });
    }
    flash(c.s, r ? tx('wres.server_deleted', { id: r.static_id }) : tx('wres.no_such_remote_server'), r ? 'ok' : 'error');
    return back(reply, c.s, SERVERS);
  });

  // ---------------------------------------------------------------- web credentials
  app.get(CREDS, async (req: Req, reply) => {
    const c = await context(req, reply, tx('wres.credentials_title'));
    if (!c) return;
    return send(reply, c.s, shell(c.s, tx('wres.credentials_title'), crumbs(tx('wres.credentials_title')), await credentialsPage(c, req.query ?? {})));
  });

  app.post(CREDS, async (req: Req, reply) => {
    const c = await manager(req, reply, tx('wres.credentials_title'));
    if (!c) return;
    const { s } = c;
    const b = req.body ?? {};
    const text = (k: string) => String(b[k] ?? '').trim() || null;
    const editId = id(b.id);
    const retry = editId ? `${CREDS}?edit=${editId}#credential-form` : `${CREDS}?new=1#credential-form`;
    const v = {
      name: String(b.name ?? '').trim().toUpperCase(), description: text('description'),
      type: ['basic', 'header', 'bearer', 'oauth2', 'aws_sigv4'].includes(String(b.type)) ? String(b.type) : 'basic',
      username: text('username'), header_name: text('header_name'), token_url: text('token_url'), scope: text('scope'),
      valid_for: [...new Set(String(b.valid_for ?? '').split(',').map((x) => x.trim()).filter(Boolean))],
      grant_type: GRANT_TYPES.includes(String(b.grant_type)) ? String(b.grant_type) : 'client_credentials', oauth_username: text('oauth_username'),
    };
    const problems = [...(/^[A-Z][A-Z0-9_]{0,59}$/.test(v.name) ? [] : [tx('wres.the_name_is_upper_case')]), ...credentialProblems(v)];
    if (problems.length) {
      flash(s, problems.join(' '), 'error');
      return back(reply, s, retry);
    }
    try {
      // secrets: encrypted here; empty keeps the stored one, "remove" clears it
      const enc = (k: string) => (b[k] ? encryptSecret(String(b[k])) : null);
      const secrets = { secret_enc: enc('secret'), password_enc: enc('password'), refresh_token_enc: enc('refresh_token') };
      const remove = { secret_enc: b.remove_secret === 'true', password_enc: b.remove_password === 'true', refresh_token_enc: b.remove_refresh_token === 'true' };
      const cols = ['name', 'description', 'type', 'username', 'header_name', 'token_url', 'scope', 'valid_for', 'grant_type', 'oauth_username'] as const;
      const vals = cols.map((k) => v[k]);
      if (editId) {
        const sets = (Object.keys(secrets) as (keyof typeof secrets)[]).map((k, i) =>
          `${k} = case when $${14 + i * 2}::text is not null then $${14 + i * 2} when $${15 + i * 2} then null else ${k} end`);
        const r = await owner.query(
          `update meta.workspace_credential set ${cols.map((k, i) => `${k} = $${i + 3}`).join(', ')}, updated_by = $13, updated_at = now(),
                  ${sets.join(', ')}, token_refreshed_at = case when $18::text is not null or $19 then null else token_refreshed_at end
            where id = $1 and workspace_id = $2`,
          [editId, c.ws.id, ...vals, s.username, secrets.secret_enc, remove.secret_enc, secrets.password_enc, remove.password_enc, secrets.refresh_token_enc, remove.refresh_token_enc]);
        if (!r.rowCount) throw new Error(tx('wres.no_such_web_credential'));
        clearTokens(`w${editId}`);
      } else
        await owner.query(
          `insert into meta.workspace_credential (workspace_id, ${cols.join(', ')}, updated_by, secret_enc, password_enc, refresh_token_enc)
           values ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}, $12, $13, $14, $15)`,
          [c.ws.id, ...vals, s.username, secrets.secret_enc, secrets.password_enc, secrets.refresh_token_enc]);
      clearResponseCache();
      await logActivity({ appId: null, username: s.username, event: 'workspace', ip: clientIp(req), detail: `workspace ${c.ws.id} web credential ${v.name} ${editId ? 'changed' : 'added'}` });
      flash(s, tx('wres.credential_saved', { name: v.name }));
      return back(reply, s, CREDS);
    } catch (e) {
      flash(s, (e as Error).message.includes('workspace_credential_workspace_id_name_key') ? tx('wres.credential_exists', { name: v.name }) : (e as Error).message, 'error');
      return back(reply, s, retry);
    }
  });

  app.post(`${CREDS}/:cid/delete`, async (req: Req, reply) => {
    const c = await manager(req, reply, tx('wres.credentials_title'));
    if (!c) return;
    const r = await owner.one<{ id: number; name: string }>('delete from meta.workspace_credential where id = $1 and workspace_id = $2 returning id, name', [id(req.params.cid), c.ws.id]);
    if (r) {
      clearTokens(`w${r.id}`);
      clearResponseCache();
      await logActivity({ appId: null, username: c.s.username, event: 'workspace', ip: clientIp(req), detail: `workspace ${c.ws.id} web credential ${r.name} deleted` });
    }
    flash(c.s, r ? tx('wres.credential_deleted', { name: r.name }) : tx('wres.no_such_web_credential'), r ? 'ok' : 'error');
    return back(reply, c.s, CREDS);
  });
}

