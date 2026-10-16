import type { FastifyInstance, FastifyReply } from 'fastify';
import { apiRoleProblem, issueApiToken } from '../api.ts';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { handlerProblems, METHODS, PARAM_TYPES, templateProblems, type Handler, type HandlerParam, type Template } from '../runtime/rest.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import { publicUrl } from '../sso.ts';
import { lockText } from './locks.ts';
import { back, BASE, csrf, developer, flash, region, send, shell, workshopTabs, type Req } from './ui.ts';
import { splitRoles } from './users.ts';
import { currentWorkspace } from './workspaces.ts';

// (sprint 104, Database Actions DA-11 part 2; migration 117) SQL Workshop › RESTful Services › Modules: an
// application's REST modules (meta.rest_module, served by runtime/rest.ts) edited the ORDS way, as a tree of
// module (base path /a/<alias>/rest/<name>/) › templates (URIs with :parameters) › handlers (method and source
// type: collection query, single row, SQL, PL/pgSQL, media). The module's roles are its privilege; a handler adds
// its own roles or is public. Each handler page has a Try it panel: the request runs through the real endpoint
// (fastify inject) with no token or a short-lived token of an account of the application, as App › REST API issues
// them. Modules belong to the application, so they travel with its export. Only applications of the developer's
// workspace; a Run only or locked application refuses changes.

export const MODULES = `${BASE}/sql/rest/modules`;
const NAME = /^[a-z][a-z0-9_-]{0,39}$/;
const TYPE_LABELS: Record<string, string> = {
  collection: 'Collection query: rows, paged',
  item: 'Single row: an object, 404 without a row',
  sql: 'SQL: the first row of the last statement',
  plpgsql: 'PL/pgSQL block: meta.rest_reply(body, status)',
  media: 'Media resource: content_type and content',
};
const MAX_TRY_BODY = 20_000;

interface ModRow {
  id: number;
  app_id: number;
  name: string;
  title: string;
  description: string | null;
  enabled: boolean;
  handlers: Handler[];
  roles: string[];
  templates: Template[];
  app_alias: string;
  app_name: string;
  db_role: string | null;
}

/** RESTful Services' two parts as tabs: Modules and AutoREST. */
export const restNav = (active: 'modules' | 'autorest') =>
  html`<nav class="settings-tabs" aria-label="RESTful Services">
    <a href="${MODULES}"${active === 'modules' ? raw(' aria-current="page"') : ''}>Modules</a>
    <a href="${BASE}/sql/rest"${active === 'autorest' ? raw(' aria-current="page"') : ''}>AutoREST (tables and views)</a></nav>`;

/** The modules of the current workspace's applications (one, with id). */
async function modules(s: Session, id?: number): Promise<ModRow[]> {
  return (await owner.query<ModRow>(
    `select m.*, a.alias as app_alias, a.name as app_name, a.db_role from meta.rest_module m join meta.app a on a.id = m.app_id
      where meta.app_workspace(a.id) = $1 ${id !== undefined ? 'and m.id = $2' : ''} order by lower(a.name), m.name`,
    id !== undefined ? [currentWorkspace(s), id] : [currentWorkspace(s)])).rows;
}

async function workspaceApps(s: Session) {
  return (await owner.query<{ id: number; alias: string; name: string }>(
    'select id, alias, name from meta.app a where meta.app_workspace(a.id) = $1 order by lower(name)', [currentWorkspace(s)])).rows;
}

/** Why the application can't be changed now (Run only, or locked by another developer), or null. */
async function changeRefused(s: Session, appId: number): Promise<string | null> {
  const a = await owner.one<{ run_only: boolean }>(`select build_status = 'run_only' as run_only from meta.app where id = $1`, [appId]);
  if (a?.run_only) return `${lockText({ page_no: 0, locked_by: '', locked_at: '', note: null, run_only: true })} Set it back to Run and build to change it.`;
  const lock = await owner.one(`select page_no, locked_by, locked_at::text, note from meta.builder_lock where app_id = $1 and page_no = 0 and locked_by <> $2`, [appId, s.username]);
  return lock ? `${lockText(lock)} Changes are refused until it is unlocked.` : null;
}

/** The module's templates: the declared ones and every handler's path, sorted. */
export function templatesOf(m: Pick<ModRow, 'templates' | 'handlers'>): Template[] {
  const list: Template[] = (Array.isArray(m.templates) ? m.templates : []).filter((t) => typeof t?.uri === 'string').map((t) => ({ ...t }));
  for (const h of Array.isArray(m.handlers) ? m.handlers : []) if (!list.some((t) => t.uri === h.path)) list.push({ uri: h.path });
  return list.sort((a, b) => a.uri.localeCompare(b.uri));
}

const errorList = (problems: string[]) =>
  problems.length ? html`<div class="alert alert-error" role="alert"><ul class="u-m0">${problems.map((p) => html`<li>${p}</li>`)}</ul></div>` : '';
const q = (v: Record<string, string>) => new URLSearchParams(v).toString();
const tplUrl = (m: ModRow, uri: string) => `${MODULES}/${m.id}/template?${q({ t: uri })}`;
const handlerUrl = (m: ModRow, h: Pick<Handler, 'path' | 'method'>) => `${MODULES}/${m.id}/handler?${q({ t: h.path, m: h.method })}`;
const baseUrl = (m: Pick<ModRow, 'app_alias' | 'name'>) => `${publicUrl()}/a/${m.app_alias}/rest/${m.name}/`;
const access = (m: ModRow, h: Handler) =>
  [h.auth === 'public' ? 'public' : 'token', m.roles.length ? `module role ${m.roles.join(' or ')}` : '', h.roles?.length ? `role ${h.roles.join(' or ')}` : ''].filter(Boolean).join(', ');

/** The module's tree: module › templates › handlers. */
function tree(m: ModRow, sel: { t?: string; m?: string } = {}) {
  const here = (on: boolean) => (on ? raw(' aria-current="page"') : '');
  return html`<nav aria-label="Templates and handlers" class="rm-tree"><ul class="tree">
    <li><a href="${MODULES}/${m.id}"${here(sel.t === undefined)}>${icon('folder')}<span>${m.name}/</span></a>
      <ul>${templatesOf(m).map((t) => html`<li><a href="${tplUrl(m, t.uri)}"${here(sel.t === t.uri && !sel.m)}>${icon('chevron')}<span>${t.uri || '/'}</span></a>
        <ul>${m.handlers.filter((h) => h.path === t.uri).map((h) => html`<li><a href="${handlerUrl(m, h)}"${here(sel.t === t.uri && sel.m === h.method)}><code>${h.method}</code><span>${h.type}</span></a></li>`)}</ul></li>`)}
      </ul></li></ul></nav>`;
}

/** The page frame: tabs, the module's tree beside the content. */
function frame(s: Session, m: ModRow, title: string, crumbs: [string, string?][], sel: { t?: string; m?: string }, body: Raw) {
  const main = html`<h1 class="u-mb1">SQL Workshop</h1>${workshopTabs('rest')}${restNav('modules')}
    <h2 class="u-mb1 wrap-anywhere">${m.title} <span class="muted small">${m.app_name} · /a/${m.app_alias}/rest/${m.name}/${m.enabled ? '' : ' · disabled'}</span></h2>
    <div class="rm-layout">${region('Module', tree(m, sel))}<div class="rm-main">${body}</div></div>`;
  return shell(s, title, [['SQL Workshop', `${BASE}/sql`], ['RESTful Services', MODULES], ...crumbs], main, 'sql');
}

// ------------------------------------------------------------------ pages

async function listPage(s: Session, b: Record<string, unknown> = {}, problems: string[] = []) {
  const [list, apps] = await Promise.all([modules(s), workspaceApps(s)]);
  const table = list.length
    ? html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>Module</th><th>Base path</th><th>Application</th><th>Templates</th><th>Handlers</th><th>Privilege</th></tr></thead><tbody>
      ${list.map((m) => html`<tr${m.enabled ? '' : raw(' class="muted"')}>
        <td data-label="Module"><a href="${MODULES}/${m.id}">${m.title}</a>${m.enabled ? '' : html` <span class="tag">off</span>`}</td>
        <td data-label="Base path" class="wrap-anywhere"><code>/a/${m.app_alias}/rest/${m.name}/</code></td>
        <td data-label="Application">${m.app_name}</td>
        <td data-label="Templates">${templatesOf(m).length}</td>
        <td data-label="Handlers">${Array.isArray(m.handlers) ? m.handlers.length : 0}</td>
        <td data-label="Privilege">${m.roles.length ? `role ${m.roles.join(' or ')}` : 'any token'}</td></tr>`)}
      </tbody></table></div>`
    : html`<p class="muted">No REST modules yet. Create one below: a base path, then templates and handlers.</p>`;
  const v = (k: string) => String(b[k] ?? '');
  const form = html`<form method="post" action="${MODULES}" id="create">${csrf(s)}${errorList(problems)}
    <div class="form-grid">
      <div class="field"><label class="label" for="f_app">Application</label>
        <select id="f_app" name="app_id" required>${apps.map((a) => html`<option value="${a.id}"${v('app_id') === String(a.id) ? raw(' selected') : ''}>${a.name} (${a.alias})</option>`)}</select>
        <small class="help">Its database role runs the handlers; its tokens and roles decide who may call them.</small></div>
      <div class="field"><label class="label" for="f_name">Base path</label><input id="f_name" name="name" required value="${v('name')}" placeholder="e.g. sales">
        <small class="help">/a/&lt;app&gt;/rest/<b>name</b>/ — lower case letters, digits, _ and - (at most 40)</small></div>
      <div class="field"><label class="label" for="f_title">Title</label><input id="f_title" name="title" required value="${v('title')}" placeholder="e.g. Sales API"></div>
      <div class="field"><label class="label" for="f_roles">Privilege: roles</label><input id="f_roles" name="roles" value="${v('roles')}" placeholder="any caller with a token">
        <small class="help">Comma separated: every handler needs one of these application roles.</small></div>
    </div>
    <div class="field"><label class="label" for="f_description">Description</label><input id="f_description" name="description" value="${v('description')}"></div>
    <div class="buttons"><button class="btn btn-hot"${apps.length ? '' : raw(' disabled')}>${icon('plus')} Create module</button></div></form>`;
  const main = html`<h1 class="u-mb1">SQL Workshop</h1>${workshopTabs('rest')}${restNav('modules')}
    <p class="muted">RESTful Services modules: a module is a base path of an application, its templates are URIs with <code>:parameters</code>, and each template has handlers per method with their source: a collection query, a single row, SQL, a PL/pgSQL block or a media resource. Handlers run as the application's database role with the caller as <code>meta.app_user()</code>, so its grants and row level security apply; parameters are bound, never pasted into the SQL. Every module has an OpenAPI document. Modules belong to their application: they travel with its export (also in Shared Components › RESTful Services).</p>
    ${region('Modules', table)}${region('Create a module', form)}`;
  return shell(s, 'RESTful Services: Modules', [['SQL Workshop', `${BASE}/sql`], ['RESTful Services', `${BASE}/sql/rest`], ['Modules']], main, 'sql');
}

/** Checks of the role the handlers run as. */
async function roleChecks(m: ModRow) {
  const problem = m.db_role ? await apiRoleProblem(m.db_role) : null;
  return html`<ul class="checklist">
    <li>${problem ? '✗' : m.db_role ? '✓' : 'ℹ'} ${problem
      ? html`The application's database role: ${problem} Its handlers answer 403.`
      : m.db_role ? html`Handlers run as <code>${m.db_role}</code> with <code>meta.app_user()</code> the caller` : html`The application has no database role: handlers run as pgkiln's runtime role. Give it its own role (Application › Settings) so grants and row level security are its own.`}</li>
    <li>${m.enabled ? '✓' : '✗'} ${m.enabled ? 'Enabled' : 'Disabled: every handler answers 404'}</li>
    <li>ℹ ${m.roles.length ? `Privilege: callers need the role ${m.roles.join(' or ')}` : 'No privilege roles: any valid token of the application (handlers may add roles)'}</li>
  </ul>`;
}

async function modulePage(s: Session, m: ModRow, problems: string[] = [], b?: Record<string, unknown>) {
  const v = (k: keyof ModRow & string, d: unknown) => String(b?.[k] ?? d ?? '');
  const openapi = `${baseUrl(m)}openapi.json`;
  const settings = html`<form method="post" action="${MODULES}/${m.id}">${csrf(s)}${errorList(problems)}
      <div class="form-grid">
        <div class="field"><label class="label" for="f_name">Base path</label><input id="f_name" name="name" required value="${v('name', m.name)}"><small class="help">/a/${m.app_alias}/rest/<b>name</b>/</small></div>
        <div class="field"><label class="label" for="f_title">Title</label><input id="f_title" name="title" required value="${v('title', m.title)}"></div>
        <div class="field"><label class="label" for="f_roles">Privilege: roles</label><input id="f_roles" name="roles" value="${b ? String(b.roles ?? '') : m.roles.join(', ')}" placeholder="any caller with a token"><small class="help">Comma separated: every handler needs one of these roles.</small></div>
        <div class="field"><label class="label" for="f_enabled">Status</label><select id="f_enabled" name="enabled"><option value="1"${m.enabled ? raw(' selected') : ''}>Enabled</option><option value="0"${m.enabled ? '' : raw(' selected')}>Disabled (404)</option></select></div>
      </div>
      <div class="field"><label class="label" for="f_description">Description</label><input id="f_description" name="description" value="${v('description', m.description)}"></div>
      <div class="buttons"><button class="btn btn-hot">Save</button></div></form>`;
  const templates = templatesOf(m);
  const tplTable = templates.length
    ? html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>Template</th><th>Handlers</th><th>Description</th></tr></thead><tbody>
      ${templates.map((t) => html`<tr><td data-label="Template"><a href="${tplUrl(m, t.uri)}"><code>${t.uri || '/'}</code></a></td>
        <td data-label="Handlers">${m.handlers.filter((h) => h.path === t.uri).map((h) => html`<a href="${handlerUrl(m, h)}"><code>${h.method}</code></a> `)}</td>
        <td data-label="Description">${t.description ?? ''}</td></tr>`)}</tbody></table></div>`
    : html`<p class="muted">No templates yet.</p>`;
  const addTpl = html`<form method="post" action="${MODULES}/${m.id}/template" class="u-mt1">${csrf(s)}
      <div class="form-grid">
        <div class="field"><label class="label" for="f_uri">URI template</label><input id="f_uri" name="uri" required placeholder="e.g. orders/:id"><small class="help">Segments and <code>:parameters</code> (bound as <code>:ID</code>)</small></div>
        <div class="field"><label class="label" for="f_tdesc">Description</label><input id="f_tdesc" name="description"></div>
      </div><div class="buttons"><button class="btn">${icon('plus')} Add template</button></div></form>`;
  const body = html`
    ${region('Checks', await roleChecks(m))}
    ${region('Templates', html`${tplTable}${addTpl}`)}
    ${region('OpenAPI', html`<p class="wrap-anywhere u-mt0">The module's OpenAPI 3 document (without the SQL): <a href="${openapi}" target="_blank" rel="noopener"><code>${openapi}</code></a></p>
      <p class="muted small">Import it into Swagger UI, Postman or a client generator. Handlers' documented parameters become its query parameters and request bodies.</p>`)}
    ${region('Module', html`${settings}
      <form method="post" action="${MODULES}/${m.id}/delete" class="danger-zone">${csrf(s)}<button class="btn btn-danger" data-confirm="Delete the module ${m.name} with all its templates and handlers?">${icon('trash')} Delete module</button></form>`)}`;
  return frame(s, m, `REST module ${m.name}`, [[m.name]], {}, body);
}

async function templatePage(s: Session, m: ModRow, uri: string, problems: string[] = []) {
  const t = templatesOf(m).find((x) => x.uri === uri)!;
  const handlers = m.handlers.filter((h) => h.path === uri);
  const used = new Set<string>(handlers.map((h) => h.method));
  const free = METHODS.filter((x) => !used.has(x));
  const body = html`${errorList(problems)}
    ${region('Handlers', html`${handlers.length
      ? html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>Method</th><th>Source type</th><th>Access</th><th>Description</th></tr></thead><tbody>
        ${handlers.map((h) => html`<tr><td data-label="Method"><a href="${handlerUrl(m, h)}"><code>${h.method}</code></a></td><td data-label="Source type">${TYPE_LABELS[h.type] ?? h.type}</td>
          <td data-label="Access">${access(m, h)}</td><td data-label="Description">${h.description ?? ''}</td></tr>`)}</tbody></table></div>`
      : html`<p class="muted">No handlers yet: the URI answers 404.</p>`}
      ${free.length ? html`<form method="get" action="${MODULES}/${m.id}/handler" class="search u-mwnone u-mt1"><input type="hidden" name="t" value="${uri}">
        <div class="field"><label class="label" for="f_new">Method</label><select id="f_new" name="new">${free.map((x) => html`<option>${x}</option>`)}</select></div>
        <button class="btn u-selfend">${icon('plus')} Add handler</button></form>` : ''}
      <p class="wrap-anywhere muted small">URL: <code>${baseUrl(m)}${uri}</code></p>`)}
    ${region('Template', html`<form method="post" action="${MODULES}/${m.id}/template">${csrf(s)}<input type="hidden" name="orig" value="${uri}">
        <div class="form-grid">
          <div class="field"><label class="label" for="f_uri">URI template</label><input id="f_uri" name="uri" required value="${uri}"><small class="help">Renaming it moves its handlers too.</small></div>
          <div class="field"><label class="label" for="f_tdesc">Description</label><input id="f_tdesc" name="description" value="${t?.description ?? ''}"></div>
        </div><div class="buttons"><button class="btn btn-hot">Save</button></div></form>
      <form method="post" action="${MODULES}/${m.id}/template/delete" class="danger-zone">${csrf(s)}<input type="hidden" name="uri" value="${uri}">
        <button class="btn btn-danger" data-confirm="Delete the template ${uri} and its ${handlers.length} handler(s)?">${icon('trash')} Delete template</button></form>`)}`;
  return frame(s, m, `REST ${m.name}/${uri}`, [[m.name, `${MODULES}/${m.id}`], [uri || '/']], { t: uri }, body);
}

/** "name in [type] [required] [description]" per line ↔ the handler's params. */
export function parseParams(text: string): { params: HandlerParam[]; problems: string[] } {
  const params: HandlerParam[] = [];
  const problems: string[] = [];
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    const words = line.trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const [name, where, ...rest] = words;
    if (where !== 'query' && where !== 'body') {
      problems.push(`Parameters, line ${i + 1}: write "name query" or "name body", then optionally a type (${PARAM_TYPES.join(', ')}), "required" and a description.`);
      continue;
    }
    const p: HandlerParam = { name, in: where };
    if (rest[0] && PARAM_TYPES.includes(rest[0])) p.type = rest.shift() as HandlerParam['type'];
    if (rest[0] === 'required') {
      p.required = true;
      rest.shift();
    }
    if (rest.length) p.description = rest.join(' ').slice(0, 500);
    params.push(p);
  }
  return { params, problems };
}
const paramsText = (ps: HandlerParam[] | undefined) =>
  (ps ?? []).map((p) => [p.name, p.in, p.type ?? '', p.required ? 'required' : '', p.description ?? ''].filter(Boolean).join(' ')).join('\n');

/** The path parameters of a URI template. */
const pathParams = (uri: string) => [...uri.matchAll(/:([a-z][a-z0-9_]*)/gi)].map((x) => x[1]);

interface TryResult {
  method: string;
  url: string;
  as: string;
  status?: number;
  type?: string;
  body?: string;
  error?: string;
}

async function handlerPage(s: Session, m: ModRow, uri: string, method: string | null, opts: { problems?: string[]; form?: Record<string, unknown>; tried?: TryResult; tryForm?: Record<string, unknown> } = {}) {
  const existing = method ? m.handlers.find((h) => h.path === uri && h.method === method) : undefined;
  const isNew = !existing;
  const f = opts.form;
  const h: Partial<Handler> = existing ?? { method: (method ?? 'GET') as Handler['method'], path: uri, type: method && method !== 'GET' ? 'plpgsql' : 'collection', source: '' };
  const v = (k: string, d: unknown) => String(f ? (f[k] ?? '') : (d ?? ''));
  const type = v('type', h.type);
  const editor = html`<form method="post" action="${MODULES}/${m.id}/handler">${csrf(s)}${errorList(opts.problems ?? [])}
      <input type="hidden" name="t" value="${uri}">${existing ? html`<input type="hidden" name="orig_m" value="${existing.method}">` : ''}
      <div class="form-grid">
        <div class="field"><label class="label" for="f_method">Method</label><select id="f_method" name="method">${METHODS.map((x) => html`<option${v('method', h.method) === x ? raw(' selected') : ''}>${x}</option>`)}</select></div>
        <div class="field"><label class="label" for="f_type">Source type</label><select id="f_type" name="type">${Object.entries(TYPE_LABELS).map(([k, l]) => html`<option value="${k}"${type === k ? raw(' selected') : ''}>${l}</option>`)}</select></div>
        <div class="field"><label class="label" for="f_description">Description</label><input id="f_description" name="description" value="${v('description', h.description)}"></div>
      </div>
      <div class="field"><label class="label" for="f_source">Source</label>
        <textarea id="f_source" name="source" class="code sql-editor" rows="10" spellcheck="false" data-code="${type === 'plpgsql' ? 'plpgsql' : 'sql'}" required>${v('source', h.source)}</textarea>
        <small class="help">Binds, upper case: path parameters (${pathParams(uri).map((p) => `:${p.toUpperCase()}`).join(', ') || 'none here'}), query parameters and JSON body fields; <code>:BODY</code> is the whole body; <code>:APP_USER</code> is the caller. Values are bound, never pasted into the SQL. PL/pgSQL: a block (<code>declare … begin … end</code>, or statements) that answers with <code>perform meta.rest_reply(jsonb_build_object(…), 201)</code>. Media: a query returning <code>content_type</code>, <code>content</code> and optionally <code>filename</code>.</small></div>
      <fieldset class="prop-group"><legend>Who may call it</legend>
        <label class="check"><input type="radio" name="auth" value="token"${v('auth', h.auth ?? 'token') !== 'public' ? raw(' checked') : ''}> A bearer token of the application${m.roles.length ? ` with the module's role ${m.roles.join(' or ')}` : ''}</label>
        <label class="check"><input type="radio" name="auth" value="public"${v('auth', h.auth) === 'public' ? raw(' checked') : ''}> Public: no token <small class="help">(runs as <code>nobody</code>${m.roles.length ? '; the module\'s roles still apply, so it answers 403' : ''})</small></label>
      </fieldset>
      <div class="form-grid">
        <div class="field"><label class="label" for="f_roles">Roles</label><input id="f_roles" name="roles" value="${f ? String(f.roles ?? '') : (h.roles ?? []).join(', ')}" placeholder="no further role"><small class="help">Comma separated: the caller needs one of them too.</small></div>
        <div class="field"><label class="label" for="f_page_size">Page size</label><input id="f_page_size" name="page_size" type="number" min="1" max="500" value="${v('page_size', h.page_size)}" placeholder="25"><small class="help">Collection queries: rows without ?limit=.</small></div>
        <div class="field"><label class="label" for="f_status">Status</label><input id="f_status" name="status" type="number" min="200" max="299" value="${v('status', h.status)}" placeholder="201 for POST, else 200"><small class="help">SQL and PL/pgSQL handlers.</small></div>
      </div>
      <div class="field"><label class="label" for="f_params">Parameters (documentation)</label>
        <textarea id="f_params" name="params" class="code" rows="3" spellcheck="false" placeholder="start_date body string required First day">${f ? String(f.params ?? '') : paramsText(h.params)}</textarea>
        <small class="help">One per line: <code>name query|body [${PARAM_TYPES.join('|')}] [required] [description]</code>. They go into the OpenAPI document and the Try it form; a required one missing answers 400.</small></div>
      <div class="buttons"><button class="btn btn-hot">${isNew ? 'Create handler' : 'Save'}</button></div></form>
    ${existing ? html`<form method="post" action="${MODULES}/${m.id}/handler/delete" class="danger-zone">${csrf(s)}<input type="hidden" name="t" value="${uri}"><input type="hidden" name="m" value="${existing.method}">
      <button class="btn btn-danger" data-confirm="Delete the handler ${existing.method} ${uri}?">${icon('trash')} Delete handler</button></form>` : ''}`;
  const body = html`${region(isNew ? `New handler for ${uri || '/'}` : `${h.method} ${uri || '/'}`, editor)}${existing ? await tryPanel(s, m, existing, opts.tried, opts.tryForm) : ''}`;
  return frame(s, m, `REST ${h.method} ${m.name}/${uri}`, [[m.name, `${MODULES}/${m.id}`], [uri || '/', tplUrl(m, uri)], [isNew ? 'New handler' : String(h.method)]], { t: uri, m: existing?.method }, body);
}

/** Accounts a Try it request may run as: those with access to the application (all active ones for "any user"). */
async function tryAccounts(appId: number) {
  return (await owner.query<{ username: string }>(
    `select ac.username from meta.account ac, meta.app a where a.id = $1 and ac.active
        and (a.access_control = 'any_user' or exists (select 1 from meta.app_access aa where aa.app_id = a.id and aa.account_id = ac.id))
      order by lower(ac.username) limit 200`, [appId])).rows.map((r) => r.username);
}

async function tryPanel(s: Session, m: ModRow, h: Handler, tried?: TryResult, f?: Record<string, unknown>) {
  const accounts = await tryAccounts(m.app_id);
  const v = (k: string, d = '') => String(f?.[k] ?? d);
  const qs = (h.params ?? []).filter((p) => p.in === 'query').map((p) => `${p.name}=`).join('&');
  const bodyEx = h.method === 'GET' || h.method === 'DELETE' ? '' : JSON.stringify(Object.fromEntries((h.params ?? []).filter((p) => p.in === 'body').map((p) => [p.name, p.type === 'integer' || p.type === 'number' ? 0 : p.type === 'boolean' ? false : ''])), null, 2);
  const result = tried
    ? html`<div class="u-mt1" role="status"><h3 class="small">Response</h3>
        <p class="wrap-anywhere"><code>${tried.method} ${tried.url}</code> as <b>${tried.as || 'no token'}</b></p>
        ${tried.error ? html`<div class="alert alert-error">${tried.error}</div>` : html`<p><b>${tried.status}</b> <span class="muted">${tried.type ?? ''}</span></p>
          ${tried.body ? html`<pre class="source wrap-pre">${tried.body}</pre>` : ''}`}</div>`
    : '';
  const params = pathParams(h.path);
  return region('Try it', html`<form method="post" action="${MODULES}/${m.id}/try">${csrf(s)}<input type="hidden" name="t" value="${h.path}"><input type="hidden" name="m" value="${h.method}">
      <p class="muted u-mt0">Sends the request to the real endpoint: a PUT, POST or DELETE changes data. <em>As</em> an account issues a short-lived token for it, as App › REST API does; without one you see what a caller without a token gets.</p>
      <div class="form-grid">
        <div class="field"><label class="label" for="f_as">As</label><select id="f_as" name="as"><option value="">No token</option>${accounts.map((u) => html`<option${v('as') === u ? raw(' selected') : ''}>${u}</option>`)}</select></div>
        ${params.map((p) => html`<div class="field"><label class="label" for="f_p_${p}">:${p}</label><input id="f_p_${p}" name="p_${p}" value="${v(`p_${p}`)}" required></div>`)}
        <div class="field"><label class="label" for="f_query">Query string</label><input id="f_query" name="query" value="${v('query', qs)}" placeholder="limit=10&amp;offset=0"></div>
      </div>
      ${h.method === 'GET' || h.method === 'DELETE' ? '' : html`<div class="field"><label class="label" for="f_body">JSON body</label><textarea id="f_body" name="body" class="code" rows="5" spellcheck="false" data-code="json">${v('body', bodyEx)}</textarea></div>`}
      <div class="buttons"><button class="btn btn-hot">${icon('play')} Send ${h.method}</button></div></form>
    ${result}
    <h3 class="small">cURL</h3><pre class="source wrap-pre">curl${h.method === 'GET' ? '' : ` -X ${h.method}`} "${baseUrl(m)}${h.path.replace(/:([a-z][a-z0-9_]*)/gi, (_, p) => `<${p}>`)}"${h.auth === 'public' ? '' : ' -H "Authorization: Bearer $TOKEN"'}${bodyEx ? ` -H "Content-Type: application/json" -d '${bodyEx.replace(/\s+/g, ' ')}'` : ''}</pre>`);
}

// ------------------------------------------------------------------ changes

/** Change a module's definition in a transaction (row locked), after the Run only / lock check. */
async function change(m: ModRow, fn: (cur: { handlers: Handler[]; templates: Template[] }) => { handlers: Handler[]; templates: Template[] } | string[]): Promise<string[]> {
  return owner.tx(async (c) => {
    const cur = (await c.query('select handlers, templates from meta.rest_module where id = $1 for update', [m.id])).rows[0];
    if (!cur) return ['The module no longer exists.'];
    const next = fn({ handlers: Array.isArray(cur.handlers) ? cur.handlers : [], templates: Array.isArray(cur.templates) ? cur.templates : [] });
    if (Array.isArray(next)) return next;
    const problems = [...templateProblems(next.templates), ...handlerProblems(next.handlers)];
    if (problems.length) return problems;
    await c.query('update meta.rest_module set handlers = $2::jsonb, templates = $3::jsonb where id = $1', [m.id, JSON.stringify(next.handlers), JSON.stringify(next.templates)]);
    return [];
  });
}

/** A handler from the form, or the problems with it. */
function readHandler(b: Record<string, unknown>, uri: string): { h: Handler; problems: string[] } {
  const problems: string[] = [];
  const str = (k: string) => String(b[k] ?? '').trim();
  const h: Handler = { method: str('method') as Handler['method'], path: uri, type: str('type') as Handler['type'], source: String(b.source ?? '').replace(/\r\n/g, '\n').trim() };
  const auth = str('auth') || 'token';
  if (auth === 'public') h.auth = 'public';
  else if (auth !== 'token') problems.push('Choose who may call it: a token of the application, or public.');
  if (str('description')) h.description = str('description').slice(0, 500);
  const roles = splitRoles(str('roles'));
  if (roles.some((r) => r.length > 100)) problems.push('Role names are at most 100 characters.');
  if (roles.length) h.roles = roles;
  if (str('page_size')) {
    const n = Number(str('page_size'));
    if (!Number.isInteger(n) || n < 1 || n > 500) problems.push('The page size is 1 to 500.');
    else h.page_size = n;
  }
  if (str('status')) {
    const n = Number(str('status'));
    if (!Number.isInteger(n) || n < 200 || n > 299) problems.push('The status is 200 to 299.');
    else h.status = n;
  }
  const p = parseParams(String(b.params ?? ''));
  problems.push(...p.problems);
  if (p.params.length) h.params = p.params;
  return { h, problems };
}

async function modOr404(req: Req, reply: FastifyReply, s: Session) {
  const id = Number(req.params.id);
  const m = Number.isInteger(id) && id > 0 && id < 2 ** 31 ? (await modules(s, id))[0] : undefined;
  if (!m) reply.code(404).send('Not found');
  else {
    m.handlers = Array.isArray(m.handlers) ? m.handlers : [];
    m.roles = m.roles ?? [];
  }
  return m;
}

const log = (req: Req, s: Session, m: Pick<ModRow, 'app_id' | 'name'>, detail: string) =>
  logActivity({ appId: m.app_id, username: s.username, event: 'rest_module', ip: clientIp(req), detail: `${m.name}: ${detail}`.slice(0, 500) });

export async function restModuleRoutes(app: FastifyInstance) {
  app.get(MODULES, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    return send(reply, s, await listPage(s));
  });

  app.post(MODULES, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = (req.body ?? {}) as Record<string, string>;
    const again = async (problems: string[]) => send(reply.code(422), s, await listPage(s, b, problems));
    const a = (await workspaceApps(s)).find((x) => String(x.id) === String(b.app_id ?? ''));
    if (!a) return again(['Choose an application of this workspace.']);
    const name = String(b.name ?? '').trim();
    const title = String(b.title ?? '').trim();
    const problems: string[] = [];
    if (!NAME.test(name)) problems.push('The base path starts with a lower case letter: letters, digits, _ and - (at most 40).');
    if (!title || title.length > 200) problems.push('The title is 1 to 200 characters.');
    const roles = splitRoles(b.roles);
    const refused = await changeRefused(s, a.id);
    if (refused) problems.push(refused);
    if (problems.length) return again(problems);
    try {
      const r = await owner.one<{ id: number }>(
        `insert into meta.rest_module (app_id, name, title, description, roles, handlers, templates) values ($1, $2, $3, $4, $5, '[]', '[]') returning id`,
        [a.id, name, title, String(b.description ?? '').trim() || null, roles]);
      await log(req, s, { app_id: a.id, name }, 'module created');
      flash(s, `Module ${name} created at /a/${a.alias}/rest/${name}/. Add a template next.`);
      return back(reply, s, `${MODULES}/${r!.id}`);
    } catch (e) {
      if ((e as { code?: string }).code !== '23505') throw e;
      return again([`${a.name} already has a module ${name}.`]);
    }
  });

  app.get(`${MODULES}/:id`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const m = await modOr404(req, reply, s);
    if (!m) return;
    return send(reply, s, await modulePage(s, m));
  });

  app.post(`${MODULES}/:id`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const m = await modOr404(req, reply, s);
    if (!m) return;
    const b = (req.body ?? {}) as Record<string, string>;
    const name = String(b.name ?? '').trim();
    const title = String(b.title ?? '').trim();
    const problems: string[] = [];
    if (!NAME.test(name)) problems.push('The base path starts with a lower case letter: letters, digits, _ and - (at most 40).');
    if (!title || title.length > 200) problems.push('The title is 1 to 200 characters.');
    const refused = await changeRefused(s, m.app_id);
    if (refused) problems.push(refused);
    if (!problems.length) {
      try {
        await owner.query('update meta.rest_module set name = $2, title = $3, description = $4, roles = $5, enabled = $6 where id = $1',
          [m.id, name, title, String(b.description ?? '').trim() || null, splitRoles(b.roles), b.enabled !== '0']);
      } catch (e) {
        if ((e as { code?: string }).code !== '23505') throw e;
        problems.push(`${m.app_name} already has a module ${name}.`);
      }
    }
    if (problems.length) return send(reply.code(422), s, await modulePage(s, m, problems, b));
    await log(req, s, { app_id: m.app_id, name }, `module saved (${b.enabled === '0' ? 'disabled' : 'enabled'}, roles: ${splitRoles(b.roles).join(', ') || 'none'})`);
    flash(s, 'Saved.');
    return back(reply, s, `${MODULES}/${m.id}`);
  });

  app.post(`${MODULES}/:id/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const m = await modOr404(req, reply, s);
    if (!m) return;
    const refused = await changeRefused(s, m.app_id);
    if (refused) {
      flash(s, refused, 'error');
      return back(reply, s, `${MODULES}/${m.id}`);
    }
    await owner.query('delete from meta.rest_module where id = $1', [m.id]);
    await log(req, s, m, 'module deleted');
    flash(s, `Module ${m.name} deleted: its URLs answer 404.`);
    return back(reply, s, MODULES);
  });

  app.get(`${MODULES}/:id/template`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const m = await modOr404(req, reply, s);
    if (!m) return;
    const uri = String(req.query?.t ?? '');
    if (!templatesOf(m).some((t) => t.uri === uri)) return reply.code(404).send('Not found');
    return send(reply, s, await templatePage(s, m, uri));
  });

  // add a template (no orig), or change one (orig: its URI; its handlers move along)
  app.post(`${MODULES}/:id/template`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const m = await modOr404(req, reply, s);
    if (!m) return;
    const b = (req.body ?? {}) as Record<string, string>;
    const uri = String(b.uri ?? '').trim().replace(/^\/+|\/+$/g, '');
    const orig = b.orig === undefined ? null : String(b.orig);
    const description = String(b.description ?? '').trim().slice(0, 500);
    const refused = await changeRefused(s, m.app_id);
    const problems = refused ? [refused] : await change(m, (cur) => {
      const list = templatesOf(cur);
      if (orig === null && list.some((t) => t.uri === uri)) return [`The template ${uri} is there already.`];
      if (orig !== null && !list.some((t) => t.uri === orig)) return ['The template no longer exists.'];
      const next = list.filter((t) => t.uri !== orig).map((t) => ({ uri: t.uri, ...(t.description ? { description: t.description } : {}) }));
      next.push({ uri, ...(description ? { description } : {}) });
      return { templates: next.sort((x, y) => x.uri.localeCompare(y.uri)), handlers: cur.handlers.map((h) => (orig !== null && h.path === orig ? { ...h, path: uri } : h)) };
    });
    if (problems.length) {
      if (orig !== null && templatesOf(m).some((t) => t.uri === orig)) return send(reply.code(422), s, await templatePage(s, m, orig, problems));
      return send(reply.code(422), s, await modulePage(s, m, problems));
    }
    await log(req, s, m, orig === null ? `template ${uri} added` : `template ${orig} saved as ${uri}`);
    flash(s, 'Saved.');
    return back(reply, s, tplUrl(m, uri));
  });

  app.post(`${MODULES}/:id/template/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const m = await modOr404(req, reply, s);
    if (!m) return;
    const uri = String(req.body?.uri ?? '');
    const refused = await changeRefused(s, m.app_id);
    const problems = refused ? [refused] : await change(m, (cur) => ({ templates: cur.templates.filter((t) => t?.uri !== uri), handlers: cur.handlers.filter((h) => h.path !== uri) }));
    if (problems.length) {
      flash(s, problems.join(' '), 'error');
      return back(reply, s, `${MODULES}/${m.id}`);
    }
    await log(req, s, m, `template ${uri} deleted`);
    flash(s, `Template ${uri || '/'} and its handlers deleted.`);
    return back(reply, s, `${MODULES}/${m.id}`);
  });

  app.get(`${MODULES}/:id/handler`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const m = await modOr404(req, reply, s);
    if (!m) return;
    const uri = String(req.query?.t ?? '');
    const method = req.query?.m ? String(req.query.m) : null;
    if (!templatesOf(m).some((t) => t.uri === uri)) return reply.code(404).send('Not found');
    if (method && !m.handlers.some((h) => h.path === uri && h.method === method)) return reply.code(404).send('Not found');
    const fresh = METHODS.includes(String(req.query?.new ?? '')) ? String(req.query!.new) : 'GET';
    return send(reply, s, await handlerPage(s, m, uri, method, method ? {} : { form: { method: fresh, type: fresh === 'GET' ? 'collection' : 'plpgsql', auth: 'token' } }));
  });

  app.post(`${MODULES}/:id/handler`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const m = await modOr404(req, reply, s);
    if (!m) return;
    const b = (req.body ?? {}) as Record<string, string>;
    const uri = String(b.t ?? '');
    const orig = b.orig_m ? String(b.orig_m) : null;
    if (!templatesOf(m).some((t) => t.uri === uri)) return reply.code(404).send('Not found');
    const { h, problems } = readHandler(b, uri);
    const refused = await changeRefused(s, m.app_id);
    if (refused) problems.push(refused);
    if (!problems.length)
      problems.push(...await change(m, (cur) => {
        if (orig !== null && !cur.handlers.some((x) => x.path === uri && x.method === orig)) return ['The handler no longer exists.'];
        const at = orig === null ? -1 : cur.handlers.findIndex((x) => x.path === uri && x.method === orig);
        const handlers = [...cur.handlers];
        if (at >= 0) handlers[at] = h;
        else handlers.push(h);
        return { handlers, templates: cur.templates };
      }));
    if (problems.length) return send(reply.code(422), s, await handlerPage(s, m, uri, orig, { problems, form: b }));
    await log(req, s, m, `handler ${h.method} ${uri} ${orig === null ? 'created' : 'saved'} (${h.type}, ${h.auth === 'public' ? 'public' : 'token'})`);
    flash(s, 'Saved.');
    return back(reply, s, handlerUrl(m, h));
  });

  app.post(`${MODULES}/:id/handler/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const m = await modOr404(req, reply, s);
    if (!m) return;
    const uri = String(req.body?.t ?? '');
    const method = String(req.body?.m ?? '');
    const refused = await changeRefused(s, m.app_id);
    const problems = refused ? [refused] : await change(m, (cur) => ({ templates: cur.templates, handlers: cur.handlers.filter((h) => !(h.path === uri && h.method === method)) }));
    if (problems.length) {
      flash(s, problems.join(' '), 'error');
      return back(reply, s, `${MODULES}/${m.id}`);
    }
    await log(req, s, m, `handler ${method} ${uri} deleted`);
    flash(s, `Handler ${method} ${uri || '/'} deleted.`);
    return back(reply, s, templatesOf({ ...m, handlers: m.handlers.filter((h) => !(h.path === uri && h.method === method)) }).some((t) => t.uri === uri) ? tplUrl(m, uri) : `${MODULES}/${m.id}`);
  });

  // Try it: the request goes through the real endpoint (so its checks all apply), the response is shown in the page
  app.post(`${MODULES}/:id/try`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const m = await modOr404(req, reply, s);
    if (!m) return;
    const b = (req.body ?? {}) as Record<string, string>;
    const uri = String(b.t ?? '');
    const h = m.handlers.find((x) => x.path === uri && x.method === String(b.m ?? ''));
    if (!h) return reply.code(404).send('Not found');
    const as = String(b.as ?? '');
    const path = uri.split('/').map((seg) => (seg.startsWith(':') ? encodeURIComponent(String(b[`p_${seg.slice(1)}`] ?? '')) : seg)).join('/');
    const query = String(b.query ?? '').trim().replace(/^\?/, '');
    const url = `/a/${m.app_alias}/rest/${m.name}/${path}${query ? `?${new URLSearchParams(query)}` : ''}`;
    const tried: TryResult = { method: h.method, url, as };
    try {
      const headers: Record<string, string> = {};
      if (as) {
        if (!(await tryAccounts(m.app_id)).includes(as)) throw new Error('Choose an account with access to the application.');
        headers.authorization = `Bearer ${(await issueApiToken(m.app_id, as, 1)).token}`;
      }
      const raw = h.method === 'GET' || h.method === 'DELETE' ? '' : String(b.body ?? '').trim();
      if (raw) {
        try {
          JSON.parse(raw);
        } catch {
          throw new Error('The body is not valid JSON.');
        }
        headers['content-type'] = 'application/json';
      }
      const res = await req.server.inject({ method: h.method, url, headers, ...(raw ? { payload: raw } : {}) });
      tried.status = res.statusCode;
      tried.type = String(res.headers['content-type'] ?? '');
      if (/json/.test(tried.type)) {
        let text = res.body;
        try {
          text = JSON.stringify(JSON.parse(res.body), null, 2);
        } catch { /* as sent */ }
        tried.body = text.length > MAX_TRY_BODY ? `${text.slice(0, MAX_TRY_BODY)}\n… (${text.length} characters)` : text;
      } else if (res.rawPayload.length) tried.body = `(${res.rawPayload.length} bytes of ${tried.type || 'content'})`;
      await log(req, s, m, `tried ${h.method} ${uri} as ${as || 'no token'}: ${res.statusCode}`);
    } catch (e) {
      tried.error = (e as Error).message;
    }
    return send(reply, s, await handlerPage(s, m, uri, h.method, { tried, tryForm: b }));
  });
}
