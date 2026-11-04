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
const crumbs = (title: string): [string, string?][] => [['App Builder', BASE], ['Workspace utilities', `${BASE}/utilities`], [title]];
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
    await send(reply.code(403), s, shell(s, title, crumbs(title), html`<h1 class="u-mb1">${title}</h1><div class="alert alert-error" role="alert">You are not a developer of any workspace yet.</div>`));
    return null;
  }
  return { s, ws: { id: s.workspace.id, name: s.workspace.name }, admin: await workspaceAdmin(s.username, s.workspace.id) };
}

/** For changes: the workspace's administrators only (403 otherwise). */
async function manager(req: Req, reply: FastifyReply, title: string): Promise<Ctx | null> {
  const c = await context(req, reply, title);
  if (!c) return null;
  if (c.admin) return c;
  await send(reply.code(403), c.s, shell(c.s, title, crumbs(title), html`<h1 class="u-mb1">${title}</h1><div class="alert alert-error" role="alert">Only the workspace's administrators change these.</div>`));
  return null;
}

const readOnlyNote = (c: Ctx) => (c.admin ? '' : html`<div class="alert alert-info" role="status">You can see these; the workspace's administrators change them.</div>`);

// ====================================================================== static workspace files

/** The applications of the workspace that load a file (every page, or some pages). */
async function fileUsers(wsId: number) {
  const rows = (await owner.query<{ name: string; alias: string; pages: number[] | null }>(
    `select substr(u.n, 18) as name, a.alias, null::int[] as pages
       from meta.app a, unnest(a.static_includes) u(n) where meta.app_workspace(a.id) = $1 and u.n like '#WORKSPACE\\_FILES#%'
     union all
     select substr(u.n, 18), a.alias, array_agg(p.page_no order by p.page_no)
       from meta.app a join meta.page p on p.app_id = a.id, unnest(p.static_includes) u(n)
      where meta.app_workspace(a.id) = $1 and u.n like '#WORKSPACE\\_FILES#%' group by 1, 2`, [wsId])).rows;
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
    ? region(editName ? `Edit ${editName}` : 'New file', html`<form method="post" action="${FILES}/save">${csrf(s)}
        ${editName ? html`<input type="hidden" name="original" value="${editName}">` : ''}
        <div class="form-grid">${input('name', 'File name', editName ?? '', { required: true, placeholder: 'brand.css', help: 'Letters, digits, _, - and . (e.g. brand.css, common.js).' })}</div>
        <div class="field" data-wide><label class="label" for="f_content">Content</label>
          <textarea id="f_content" name="content" class="code" rows="18" spellcheck="false">${content}</textarea></div>
        <div class="buttons"><a class="btn" href="${FILES}">Cancel</a><button class="btn btn-hot">${icon('check')} Save</button></div>
      </form>`)
    : '';
  return html`<div class="title-row"><h1>Static workspace files</h1></div>
    <p class="muted u-mt0">CSS, JavaScript, JSON, images and fonts that every application of ${ws.name} may use: an application loads one on
      every page with <code>#WORKSPACE_FILES#<i>name</i></code> in Shared Components → Static application files → Every page loads (a page:
      Page → Appearance), and templates, HTML and links use <code>#WORKSPACE_FILES#</code> for their URL. Each application serves them from its
      own address (<code>/a/<i>alias</i>/workspace-files/<i>name</i></code>), never another workspace's. Up to ${size(STATIC_MAX)} per file; no HTML.
      They travel with the workspace export.</p>
    ${readOnlyNote(c)}
    ${editor}
    ${region('Files', html`${files.length
      ? html`<div class="table-wrap"><table class="report report-reflow">
          <thead><tr><th scope="col">Name</th><th scope="col">Type</th><th scope="col" class="num">Size</th><th scope="col">Loaded by</th><th scope="col">Changed (UTC)</th>${c.admin ? html`<th scope="col">Actions</th>` : ''}</tr></thead>
          <tbody>${files.map((f) => html`<tr>
            <td data-label="Name" class="u-break"><a href="${FILES}/file/${encodeURIComponent(f.name)}" target="_blank" rel="noopener">${f.name}</a></td>
            <td data-label="Type">${f.mime}</td><td class="num" data-label="Size">${size(Number(f.bytes))}</td>
            <td data-label="Loaded by" class="u-break">${includable(f.name) ? (users.get(f.name)?.join(', ') || html`<span class="muted">-</span>`) : ''}</td>
            <td data-label="Changed">${when(f.changed)}${f.updated_by ? html` <span class="muted">${f.updated_by}</span>` : ''}</td>
            ${c.admin ? html`<td data-label="Actions" class="nowrap">${editable(f.name) ? html`<a class="btn btn-small" href="${FILES}?edit=${encodeURIComponent(f.name)}">Edit</a> ` : ''}
              <form method="post" action="${FILES}/delete" class="inline">${csrf(s)}<input type="hidden" name="name" value="${f.name}">
                <button class="btn btn-small btn-danger" data-confirm="Delete ${f.name}? Applications that load it leave it out." aria-label="Delete ${f.name}">${icon('trash')}</button></form></td>` : ''}
          </tr>`)}</tbody></table></div>`
      : html`<p class="muted">No files yet.</p>`}
      ${c.admin ? html`<div class="buttons u-mt1"><a class="btn" href="${FILES}?new=1">${icon('plus')} New file</a></div>
      <form method="post" action="${FILES}/upload" enctype="multipart/form-data" class="search u-mwnone u-mt1">${csrf(s)}
        <input type="file" name="file" multiple aria-label="Files to upload" accept="${Object.keys(STATIC_TYPES).map((x) => `.${x}`).join(',')}">
        <button class="btn">${icon('upload')} Upload</button>
        <small class="help">A file with the same name is replaced.</small>
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
      return html`<span class="tag tag-error">not a valid URL</span>`;
    }
    const problem = urlProblem(url) ?? scopeProblem(scope, url);
    return problem ? html`<span class="tag tag-error">refused</span> <span class="muted small">${problem}</span>` : html`<span class="tag tag-ok">may be called</span>`;
  };
  const form = editing || creating
    ? region(editing ? `Remote server ${editing.static_id}` : 'New remote server', html`<form method="post" action="${SERVERS}">${csrf(s)}
        ${editing ? html`<input type="hidden" name="id" value="${editing.id}">` : ''}
        <div class="form-grid">
          ${input('static_id', 'Static id', v.static_id ?? '', { required: true, placeholder: 'CRM', help: 'Upper case letters, digits and _: REST data sources, catalogs and AI services name the server by it. Renaming it moves this workspace\'s sources and catalogs along.' })}
          ${input('name', 'Name', v.name ?? '', { required: true, placeholder: 'CRM system' })}
          ${input('base_url', 'Base URL (this installation)', v.base_url ?? '', { placeholder: 'https://crm.example.com/api', help: 'No trailing slash, query or fragment. Sources add their path after it.' })}
          ${input('env_var', 'Or from the environment variable', v.env_var ?? '', { placeholder: `${ENV_PREFIX}CRM`, help: `When the server's environment sets it, it wins over the base URL (one value per environment: development, test, production). Only ${ENV_PREFIX}… names.` })}
          ${input('credential', 'Default web credential', v.credential ?? '', { placeholder: 'e.g. CRM_API', help: 'Sources on this server that name no credential of their own use this one (an application\'s credential of that name, else the workspace\'s).' })}
          <div class="field" data-wide><label class="label" for="f_description">Description</label><textarea id="f_description" name="description" rows="2">${v.description ?? ''}</textarea></div>
        </div>
        <div class="buttons"><a class="btn" href="${SERVERS}">Cancel</a><button class="btn btn-hot">${icon('check')} Save</button></div></form>
        ${editing ? html`<form method="post" action="${SERVERS}/${editing.id}/delete" class="danger-zone">${csrf(s)}
          <button class="btn btn-danger" data-confirm="Delete remote server ${editing.static_id}? Sources on it fail until a server gets its static id again.">Delete server</button></form>` : ''}`, '', 'server-form')
    : '';
  return html`<div class="title-row"><h1>Remote servers</h1>${c.admin ? html`<a class="btn" href="${SERVERS}?new=1#server-form">${icon('plus')} New server</a>` : ''}</div>
    <p class="muted u-mt0">Named base URLs of ${ws.name}: a REST data source, a REST source catalog or an AI service names a server and a path
      instead of a full URL, so moving from development to production changes one value here (or one environment variable), and every source on
      the server follows at once. The URL still passes every check a full URL does: the installation's allow-list, this workspace's
      <a href="${BASE}/network">network access</a> list and the address checks when the call is made.</p>
    ${readOnlyNote(c)}
    ${form}
    ${region('Servers', html`<div class="table-wrap"><table class="report report-reflow">
      <thead><tr><th>Server</th><th>URL now</th><th>Network access</th><th>Default credential</th><th>Used by</th></tr></thead>
      <tbody>${servers.length ? servers.map((x) => {
        const u = serverUrl(x);
        return html`<tr>
          <td data-label="Server">${c.admin ? html`<a href="${SERVERS}?edit=${x.id}#server-form">${x.static_id}</a>` : x.static_id}<br><span class="muted small">${x.name}</span></td>
          <td data-label="URL now" class="u-break">${u.url ? html`<code>${u.url}</code>` : ''}<br><span class="muted small">${u.from === 'env' ? `from ${x.env_var}` : x.env_var ? `stored (${x.env_var} is not set)` : 'stored'}</span></td>
          <td data-label="Network access">${verdict(x)}</td>
          <td data-label="Default credential">${x.credential ?? html`<span class="muted">none</span>`}</td>
          <td data-label="Used by" class="u-break">${users.get(x.static_id)?.join(', ') || html`<span class="muted">nothing yet</span>`}</td></tr>`;
      }) : html`<tr><td colspan="5" class="empty">No remote servers yet.</td></tr>`}</tbody></table></div>`)}`;
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
    html`${input(name, label, '', { type: 'password', auto: 'new-password', help: `${help} ${stored ? 'One is stored (encrypted): it is never shown; type a new one to replace it.' : 'Write-only: never shown again or exported.'}` })}
      ${stored ? html`<div class="field"><label class="check"><input type="checkbox" name="remove_${name}" value="true"> Remove the stored ${label.toLowerCase()}</label></div>` : ''}`;
  const form = editing || creating
    ? region(editing ? `Web credential ${editing.name}` : 'New web credential', html`<form method="post" action="${CREDS}">${csrf(s)}
        ${editing ? html`<input type="hidden" name="id" value="${editing.id}">` : ''}
        ${secretKeyConfigured() ? '' : html`<div class="alert alert-error" role="alert">The server has no <code>PGKILN_SECRET_KEY</code>: secrets can't be stored until it is set.</div>`}
        <div class="form-grid">
          ${input('name', 'Name', v.name ?? '', { required: true, placeholder: 'CRM_API', help: 'The applications of the workspace use it by this name (an application\'s own credential of the same name wins).' })}
          ${select('type', 'Authentication', v.type ?? 'basic', ['basic', 'header', 'bearer', 'oauth2', 'aws_sigv4'], 'basic: user name + password · header: an HTTP header with the secret (API key) · bearer: Authorization: Bearer <secret> · oauth2: client credentials, password or refresh token grant · aws_sigv4: an S3-compatible object store.')}
          ${input('username', 'User name / client id / access key id', v.username ?? '')}
          ${select('grant_type', 'Grant type (oauth2)', v.grant_type ?? 'client_credentials', GRANT_TYPES)}
          ${input('oauth_username', 'OAuth2 user name (password grant)', v.oauth_username ?? '')}
          ${input('header_name', 'Header name (header)', v.header_name ?? '', { placeholder: 'X-API-Key' })}
          ${input('token_url', 'Token URL (oauth2)', v.token_url ?? '', { placeholder: 'https://login.example.com/oauth/token' })}
          ${input('scope', 'Scope (oauth2) / region (aws_sigv4)', v.scope ?? '')}
          ${input('valid_for', 'Valid for URLs', (v.valid_for ?? []).join(', '), { placeholder: 'https://crm.example.com/api/', help: 'Comma separated URL prefixes: the credential is only ever sent to these. Recommended.' })}
          ${secret('secret', 'Secret', v.has_secret, 'The password, header value, token, client secret or secret access key.')}
          ${secret('password', 'OAuth2 password', v.has_password, 'The password grant: the OAuth2 user\'s password.')}
          ${secret('refresh_token', 'Refresh token', v.has_refresh, 'The refresh token grant: a refresh token to start with.')}
          <div class="field" data-wide><label class="label" for="f_description">Description</label><textarea id="f_description" name="description" rows="2">${v.description ?? ''}</textarea></div>
        </div>
        <div class="buttons"><a class="btn" href="${CREDS}">Cancel</a><button class="btn btn-hot">${icon('check')} Save</button></div></form>
        ${editing ? html`<form method="post" action="${CREDS}/${editing.id}/delete" class="danger-zone">${csrf(s)}
          <button class="btn btn-danger" data-confirm="Delete web credential ${editing.name}? Applications that use it fail until one of that name exists.">Delete credential</button></form>` : ''}`, '', 'credential-form')
    : '';
  return html`<div class="title-row"><h1>Workspace web credentials</h1>${c.admin ? html`<a class="btn" href="${CREDS}?new=1#credential-form">${icon('plus')} New credential</a>` : ''}</div>
    <p class="muted u-mt0">Web credentials of ${ws.name} that its applications use by name in REST data sources, the Invoke API process,
      remote servers and object storage, so a key is entered once for the workspace. An application's own credential (Shared Components →
      Web credentials) with the same name wins. Secrets are encrypted with the server's key, never shown again and never exported.</p>
    ${readOnlyNote(c)}
    ${form}
    ${region('Credentials', html`<div class="table-wrap"><table class="report report-reflow">
      <thead><tr><th>Name</th><th>Authentication</th><th>Secret</th><th>Valid for</th><th>Overridden by</th><th>Changed (UTC)</th></tr></thead>
      <tbody>${creds.length ? creds.map((x) => html`<tr>
        <td data-label="Name">${c.admin ? html`<a href="${CREDS}?edit=${x.id}#credential-form">${x.name}</a>` : x.name}${x.description ? html`<br><span class="muted small">${x.description}</span>` : ''}</td>
        <td data-label="Authentication">${x.type}${x.type === 'oauth2' ? html` <span class="muted">(${x.grant_type})</span>` : ''}</td>
        <td data-label="Secret">${x.has_secret || x.has_password || x.has_refresh ? 'stored (encrypted)' : html`<span class="muted">none yet</span>`}</td>
        <td data-label="Valid for" class="u-break">${x.valid_for.length ? x.valid_for.join(', ') : html`<span class="muted">any URL</span>`}</td>
        <td data-label="Overridden by" class="u-break">${shadowed.find((r) => r.name === x.name)?.apps ?? html`<span class="muted">-</span>`}</td>
        <td data-label="Changed">${when(x.updated_at)}${x.updated_by ? html` <span class="muted">${x.updated_by}</span>` : ''}</td></tr>`)
        : html`<tr><td colspan="6" class="empty">No workspace web credentials yet.</td></tr>`}</tbody></table></div>`)}`;
}

// ====================================================================== routes

export async function workspaceResourceRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- files
  app.get(FILES, async (req: Req, reply) => {
    const c = await context(req, reply, 'Static workspace files');
    if (!c) return;
    return send(reply, c.s, shell(c.s, 'Static workspace files', crumbs('Static workspace files'), await filesPage(c, req.query ?? {})));
  });

  // a file for the workspace's developers, with the headers the applications serve it with
  app.get(`${FILES}/file/:name`, async (req: Req, reply) => {
    const c = await context(req, reply, 'Static workspace files');
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
    const c = await manager(req, reply, 'Static workspace files');
    if (!c) return;
    const { s } = c;
    if (!uploads.length) {
      flash(s, 'Choose one or more files.', 'error');
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
    const c = await manager(req, reply, 'Static workspace files');
    if (!c) return;
    const { s } = c;
    const b = req.body ?? {};
    const name = String(b.name ?? '').trim();
    const original = b.original ? String(b.original) : null;
    const type = staticType(name);
    const content = Buffer.from(String(b.content ?? '').replace(/\r\n/g, '\n'), 'utf8');
    if (!type || !editable(name)) {
      flash(s, 'The name must end in a text type (.js, .css, .json, .txt, .csv, .md, .map) and use letters, digits, _, - and . only.', 'error');
      return back(reply, s, original ? `${FILES}?edit=${encodeURIComponent(original)}` : `${FILES}?new=1`);
    }
    if (content.length > STATIC_MAX) {
      flash(s, `The file is larger than ${size(STATIC_MAX)}.`, 'error');
      return back(reply, s, FILES);
    }
    try {
      if (original && original !== name) {
        const r = await owner.query('update meta.workspace_file set name = $3, mime = $4, content = $5, updated_by = $6, updated_at = now() where workspace_id = $1 and name = $2',
          [c.ws.id, original, name, type, content, s.username]);
        if (!r.rowCount) throw new Error('No such file.');
      } else await storeFile(c.ws.id, name, type, content, s.username);
      await logActivity({ appId: null, username: s.username, event: 'workspace', ip: clientIp(req), detail: `workspace ${c.ws.id} file saved: ${name}` });
      flash(s, `${name} saved.`);
      return back(reply, s, `${FILES}?edit=${encodeURIComponent(name)}`);
    } catch (e) {
      flash(s, (e as Error).message.includes('workspace_file_workspace_id_name_key') ? `There is a file ${name} already.` : (e as Error).message, 'error');
      return back(reply, s, FILES);
    }
  });

  app.post(`${FILES}/delete`, async (req: Req, reply) => {
    const c = await manager(req, reply, 'Static workspace files');
    if (!c) return;
    const name = String(req.body?.name ?? '');
    const r = await owner.query('delete from meta.workspace_file where workspace_id = $1 and name = $2', [c.ws.id, name]);
    if (r.rowCount) await logActivity({ appId: null, username: c.s.username, event: 'workspace', ip: clientIp(req), detail: `workspace ${c.ws.id} file deleted: ${name}` });
    flash(c.s, r.rowCount ? `${name} deleted.` : 'No such file.', r.rowCount ? 'ok' : 'error');
    return back(reply, c.s, FILES);
  });

  // ---------------------------------------------------------------- remote servers
  app.get(SERVERS, async (req: Req, reply) => {
    const c = await context(req, reply, 'Remote servers');
    if (!c) return;
    return send(reply, c.s, shell(c.s, 'Remote servers', crumbs('Remote servers'), await serversPage(c, req.query ?? {})));
  });

  app.post(SERVERS, async (req: Req, reply) => {
    const c = await manager(req, reply, 'Remote servers');
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
          if (!old) throw new Error('No such remote server.');
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
      flash(s, `Remote server ${v.static_id} saved.`);
      return back(reply, s, SERVERS);
    } catch (e) {
      flash(s, (e as Error).message.includes('remote_server_workspace_id_static_id_key') ? `This workspace has a remote server ${v.static_id} already.` : (e as Error).message, 'error');
      return back(reply, s, retry);
    }
  });

  app.post(`${SERVERS}/:sid/delete`, async (req: Req, reply) => {
    const c = await manager(req, reply, 'Remote servers');
    if (!c) return;
    const r = await owner.one<{ static_id: string }>('delete from meta.remote_server where id = $1 and workspace_id = $2 returning static_id', [id(req.params.sid), c.ws.id]);
    if (r) {
      clearResponseCache();
      await logActivity({ appId: null, username: c.s.username, event: 'workspace', ip: clientIp(req), detail: `workspace ${c.ws.id} remote server ${r.static_id} deleted` });
    }
    flash(c.s, r ? `Remote server ${r.static_id} deleted.` : 'No such remote server.', r ? 'ok' : 'error');
    return back(reply, c.s, SERVERS);
  });

  // ---------------------------------------------------------------- web credentials
  app.get(CREDS, async (req: Req, reply) => {
    const c = await context(req, reply, 'Workspace web credentials');
    if (!c) return;
    return send(reply, c.s, shell(c.s, 'Workspace web credentials', crumbs('Workspace web credentials'), await credentialsPage(c, req.query ?? {})));
  });

  app.post(CREDS, async (req: Req, reply) => {
    const c = await manager(req, reply, 'Workspace web credentials');
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
    const problems = [...(/^[A-Z][A-Z0-9_]{0,59}$/.test(v.name) ? [] : ['The name is upper case letters, digits and _, starting with a letter, e.g. CRM_API.']), ...credentialProblems(v)];
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
        if (!r.rowCount) throw new Error('No such web credential.');
        clearTokens(`w${editId}`);
      } else
        await owner.query(
          `insert into meta.workspace_credential (workspace_id, ${cols.join(', ')}, updated_by, secret_enc, password_enc, refresh_token_enc)
           values ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}, $12, $13, $14, $15)`,
          [c.ws.id, ...vals, s.username, secrets.secret_enc, secrets.password_enc, secrets.refresh_token_enc]);
      clearResponseCache();
      await logActivity({ appId: null, username: s.username, event: 'workspace', ip: clientIp(req), detail: `workspace ${c.ws.id} web credential ${v.name} ${editId ? 'changed' : 'added'}` });
      flash(s, `Web credential ${v.name} saved.`);
      return back(reply, s, CREDS);
    } catch (e) {
      flash(s, (e as Error).message.includes('workspace_credential_workspace_id_name_key') ? `This workspace has a web credential ${v.name} already.` : (e as Error).message, 'error');
      return back(reply, s, retry);
    }
  });

  app.post(`${CREDS}/:cid/delete`, async (req: Req, reply) => {
    const c = await manager(req, reply, 'Workspace web credentials');
    if (!c) return;
    const r = await owner.one<{ id: number; name: string }>('delete from meta.workspace_credential where id = $1 and workspace_id = $2 returning id, name', [id(req.params.cid), c.ws.id]);
    if (r) {
      clearTokens(`w${r.id}`);
      clearResponseCache();
      await logActivity({ appId: null, username: c.s.username, event: 'workspace', ip: clientIp(req), detail: `workspace ${c.ws.id} web credential ${r.name} deleted` });
    }
    flash(c.s, r ? `Web credential ${r.name} deleted.` : 'No such web credential.', r ? 'ok' : 'error');
    return back(reply, c.s, CREDS);
  });
}

