import type { FastifyInstance, FastifyReply } from 'fastify';
import { apiRoleProblem, issueApiToken } from '../api.ts';
import { owner } from '../db.ts';
import { esc, html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { handlerProblems, METHODS, PARAM_TYPES, templateProblems, type Handler, type HandlerParam, type Template } from '../runtime/rest.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import { publicUrl } from '../sso.ts';
import { lockText } from './locks.ts';
import { back, BASE, csrf, developer, flash, region, send, shell, workshopTabs, type Req } from './ui.ts';
import { splitRoles } from './users.ts';
import { currentWorkspace } from './workspaces.ts';
import { scopedTx as tx, tr, translatorFor, withTranslator, type BuilderTranslate } from './i18n.ts';

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
const TYPES = ['collection', 'item', 'sql', 'plpgsql', 'media'] as const;
const typeLabel = (k: string) => ((TYPES as readonly string[]).includes(k) ? tx(`rm.type.${k as (typeof TYPES)[number]}`) : k);
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
  html`<nav class="settings-tabs" aria-label="${tx('sql.tool.rest')}">
    <a href="${MODULES}"${active === 'modules' ? raw(' aria-current="page"') : ''}>${tx('rm.modules')}</a>
    <a href="${BASE}/sql/rest"${active === 'autorest' ? raw(' aria-current="page"') : ''}>${tx('rm.autorest_tab')}</a></nav>`;

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
  if (a?.run_only) return `${lockText({ page_no: 0, locked_by: '', locked_at: '', note: null, run_only: true })} ${tr(s)('rm.run_only_suffix')}`;
  const lock = await owner.one(`select page_no, locked_by, locked_at::text, note from meta.builder_lock where app_id = $1 and page_no = 0 and locked_by <> $2`, [appId, s.username]);
  return lock ? `${lockText(lock)} ${tr(s)('rm.locked_suffix')}` : null;
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
const anyOf = (roles: string[]) => roles.join(` ${tx('rm.or')} `);
const access = (m: ModRow, h: Handler) =>
  [h.auth === 'public' ? tx('rm.public') : tx('rm.token'), m.roles.length ? tx('rm.module_role', { roles: anyOf(m.roles) }) : '', h.roles?.length ? tx('rm.role', { roles: anyOf(h.roles) }) : ''].filter(Boolean).join(', ');

/** The module's tree: module › templates › handlers. */
function tree(m: ModRow, sel: { t?: string; m?: string } = {}) {
  const here = (on: boolean) => (on ? raw(' aria-current="page"') : '');
  return html`<nav aria-label="${tx('rm.tree_aria')}" class="rm-tree"><ul class="tree">
    <li><a href="${MODULES}/${m.id}"${here(sel.t === undefined)}>${icon('folder')}<span>${m.name}/</span></a>
      <ul>${templatesOf(m).map((t) => html`<li><a href="${tplUrl(m, t.uri)}"${here(sel.t === t.uri && !sel.m)}>${icon('chevron')}<span>${t.uri || '/'}</span></a>
        <ul>${m.handlers.filter((h) => h.path === t.uri).map((h) => html`<li><a href="${handlerUrl(m, h)}"${here(sel.t === t.uri && sel.m === h.method)}><code>${h.method}</code><span>${h.type}</span></a></li>`)}</ul></li>`)}
      </ul></li></ul></nav>`;
}

/** The page frame: tabs, the module's tree beside the content. */
function frame(s: Session, m: ModRow, title: string, crumbs: [string, string?][], sel: { t?: string; m?: string }, body: Raw) {
  const main = html`<h1 class="u-mb1">${tx('rail.sql_workshop')}</h1>${workshopTabs('rest', s)}${restNav('modules')}
    <h2 class="u-mb1 wrap-anywhere">${m.title} <span class="muted small">${m.app_name} · /a/${m.app_alias}/rest/${m.name}/${m.enabled ? '' : ` · ${tx('rm.disabled_suffix')}`}</span></h2>
    <div class="rm-layout">${region(tx('rm.module'), tree(m, sel))}<div class="rm-main">${body}</div></div>`;
  return shell(s, title, [[tx('rail.sql_workshop'), `${BASE}/sql`], [tx('sql.tool.rest'), MODULES], ...crumbs], main, 'sql');
}

// ------------------------------------------------------------------ pages

const listPage = (s: Session, b: Record<string, unknown> = {}, problems: string[] = []) => withTranslator(tr(s), () => listPageInner(s, b, problems));
async function listPageInner(s: Session, b: Record<string, unknown>, problems: string[]) {
  const [list, apps] = await Promise.all([modules(s), workspaceApps(s)]);
  const table = list.length
    ? html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>${tx('rm.module')}</th><th>${tx('rm.base_path')}</th><th>${tx('rm.application')}</th><th>${tx('rm.templates')}</th><th>${tx('rm.handlers')}</th><th>${tx('rm.privilege')}</th></tr></thead><tbody>
      ${list.map((m) => html`<tr${m.enabled ? '' : raw(' class="muted"')}>
        <td data-label="${tx('rm.module')}"><a href="${MODULES}/${m.id}">${m.title}</a>${m.enabled ? '' : html` <span class="tag">${tx('rm.off')}</span>`}</td>
        <td data-label="${tx('rm.base_path')}" class="wrap-anywhere"><code>/a/${m.app_alias}/rest/${m.name}/</code></td>
        <td data-label="${tx('rm.application')}">${m.app_name}</td>
        <td data-label="${tx('rm.templates')}">${templatesOf(m).length}</td>
        <td data-label="${tx('rm.handlers')}">${Array.isArray(m.handlers) ? m.handlers.length : 0}</td>
        <td data-label="${tx('rm.privilege')}">${m.roles.length ? tx('rm.role', { roles: anyOf(m.roles) }) : tx('rm.any_token')}</td></tr>`)}
      </tbody></table></div>`
    : html`<p class="muted">${tx('rm.none_yet')}</p>`;
  const v = (k: string) => String(b[k] ?? '');
  const form = html`<form method="post" action="${MODULES}" id="create">${csrf(s)}${errorList(problems)}
    <div class="form-grid">
      <div class="field"><label class="label" for="f_app">${tx('rm.application')}</label>
        <select id="f_app" name="app_id" required>${apps.map((a) => html`<option value="${a.id}"${v('app_id') === String(a.id) ? raw(' selected') : ''}>${a.name} (${a.alias})</option>`)}</select>
        <small class="help">${tx('rm.app_help')}</small></div>
      <div class="field"><label class="label" for="f_name">${tx('rm.base_path')}</label><input id="f_name" name="name" required value="${v('name')}" placeholder="${tx('rm.eg', { example: 'sales' })}">
        <small class="help">/a/&lt;app&gt;/rest/<b>name</b>/ — ${tx('rm.base_path_rule')}</small></div>
      <div class="field"><label class="label" for="f_title">${tx('rm.title')}</label><input id="f_title" name="title" required value="${v('title')}" placeholder="${tx('rm.eg_sales_api')}"></div>
      <div class="field"><label class="label" for="f_roles">${tx('rm.privilege_roles')}</label><input id="f_roles" name="roles" value="${v('roles')}" placeholder="${tx('rm.any_caller')}">
        <small class="help">${tx('rm.roles_help_app')}</small></div>
    </div>
    <div class="field"><label class="label" for="f_description">${tx('rm.description')}</label><input id="f_description" name="description" value="${v('description')}"></div>
    <div class="buttons"><button class="btn btn-hot"${apps.length ? '' : raw(' disabled')}>${icon('plus')} ${tx('rm.create_module')}</button></div></form>`;
  const main = html`<h1 class="u-mb1">${tx('rail.sql_workshop')}</h1>${workshopTabs('rest', s)}${restNav('modules')}
    <p class="muted">${tx.code('rm.intro')}</p>
    ${region(tx('rm.modules'), table)}${region(tx('rm.create_a_module'), form)}`;
  return shell(s, tx('rm.list_title'), [[tx('rail.sql_workshop'), `${BASE}/sql`], [tx('sql.tool.rest'), `${BASE}/sql/rest`], [tx('rm.modules')]], main, 'sql');
}

/** Checks of the role the handlers run as. */
async function roleChecks(m: ModRow) {
  const problem = m.db_role ? await apiRoleProblem(m.db_role) : null;
  return html`<ul class="checklist">
    <li>${problem ? '✗' : m.db_role ? '✓' : 'ℹ'} ${problem
      ? tx('rm.chk.role_problem', { problem })
      : m.db_role ? tx.code('rm.chk.runs_as', { role: m.db_role }) : tx('rm.chk.no_role')}</li>
    <li>${m.enabled ? '✓' : '✗'} ${m.enabled ? tx('rm.enabled') : tx('rm.chk.disabled')}</li>
    <li>ℹ ${m.roles.length ? tx('rm.chk.privilege', { roles: anyOf(m.roles) }) : tx('rm.chk.no_privilege')}</li>
  </ul>`;
}

const modulePage = (s: Session, m: ModRow, problems: string[] = [], b?: Record<string, unknown>) => withTranslator(tr(s), () => modulePageInner(s, m, problems, b));
async function modulePageInner(s: Session, m: ModRow, problems: string[], b?: Record<string, unknown>) {
  const v = (k: keyof ModRow & string, d: unknown) => String(b?.[k] ?? d ?? '');
  const openapi = `${baseUrl(m)}openapi.json`;
  const settings = html`<form method="post" action="${MODULES}/${m.id}">${csrf(s)}${errorList(problems)}
      <div class="form-grid">
        <div class="field"><label class="label" for="f_name">${tx('rm.base_path')}</label><input id="f_name" name="name" required value="${v('name', m.name)}"><small class="help">/a/${m.app_alias}/rest/<b>name</b>/</small></div>
        <div class="field"><label class="label" for="f_title">${tx('rm.title')}</label><input id="f_title" name="title" required value="${v('title', m.title)}"></div>
        <div class="field"><label class="label" for="f_roles">${tx('rm.privilege_roles')}</label><input id="f_roles" name="roles" value="${b ? String(b.roles ?? '') : m.roles.join(', ')}" placeholder="${tx('rm.any_caller')}"><small class="help">${tx('rm.roles_help')}</small></div>
        <div class="field"><label class="label" for="f_enabled">${tx('rm.status')}</label><select id="f_enabled" name="enabled"><option value="1"${m.enabled ? raw(' selected') : ''}>${tx('rm.enabled')}</option><option value="0"${m.enabled ? '' : raw(' selected')}>${tx('rm.disabled_404')}</option></select></div>
      </div>
      <div class="field"><label class="label" for="f_description">${tx('rm.description')}</label><input id="f_description" name="description" value="${v('description', m.description)}"></div>
      <div class="buttons"><button class="btn btn-hot">${tx('rm.save')}</button></div></form>`;
  const templates = templatesOf(m);
  const tplTable = templates.length
    ? html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>${tx('rm.template')}</th><th>${tx('rm.handlers')}</th><th>${tx('rm.description')}</th></tr></thead><tbody>
      ${templates.map((t) => html`<tr><td data-label="${tx('rm.template')}"><a href="${tplUrl(m, t.uri)}"><code>${t.uri || '/'}</code></a></td>
        <td data-label="${tx('rm.handlers')}">${m.handlers.filter((h) => h.path === t.uri).map((h) => html`<a href="${handlerUrl(m, h)}"><code>${h.method}</code></a> `)}</td>
        <td data-label="${tx('rm.description')}">${t.description ?? ''}</td></tr>`)}</tbody></table></div>`
    : html`<p class="muted">${tx('rm.no_templates')}</p>`;
  const addTpl = html`<form method="post" action="${MODULES}/${m.id}/template" class="u-mt1">${csrf(s)}
      <div class="form-grid">
        <div class="field"><label class="label" for="f_uri">${tx('rm.uri_template')}</label><input id="f_uri" name="uri" required placeholder="${tx('rm.eg', { example: 'orders/:id' })}"><small class="help">${tx.code('rm.uri_help')}</small></div>
        <div class="field"><label class="label" for="f_tdesc">${tx('rm.description')}</label><input id="f_tdesc" name="description"></div>
      </div><div class="buttons"><button class="btn">${icon('plus')} ${tx('rm.add_template')}</button></div></form>`;
  const body = html`
    ${region(tx('rm.checks'), await roleChecks(m))}
    ${region(tx('rm.templates'), html`${tplTable}${addTpl}`)}
    ${region('OpenAPI', html`<p class="wrap-anywhere u-mt0">${tx('rm.openapi_doc')} <a href="${openapi}" target="_blank" rel="noopener"><code>${openapi}</code></a></p>
      <p class="muted small">${tx('rm.openapi_help')}</p>`)}
    ${region(tx('rm.module'), html`${settings}
      <form method="post" action="${MODULES}/${m.id}/delete" class="danger-zone">${csrf(s)}<button class="btn btn-danger" data-confirm="${tx('rm.delete_module_confirm', { name: m.name })}">${icon('trash')} ${tx('rm.delete_module')}</button></form>`)}`;
  return frame(s, m, tx('rm.module_title', { name: m.name }), [[m.name]], {}, body);
}

const templatePage = (s: Session, m: ModRow, uri: string, problems: string[] = []) => withTranslator(tr(s), () => templatePageInner(s, m, uri, problems));
async function templatePageInner(s: Session, m: ModRow, uri: string, problems: string[]) {
  const t = templatesOf(m).find((x) => x.uri === uri)!;
  const handlers = m.handlers.filter((h) => h.path === uri);
  const used = new Set<string>(handlers.map((h) => h.method));
  const free = METHODS.filter((x) => !used.has(x));
  const body = html`${errorList(problems)}
    ${region(tx('rm.handlers'), html`${handlers.length
      ? html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>${tx('rm.method')}</th><th>${tx('rm.source_type')}</th><th>${tx('rm.access')}</th><th>${tx('rm.description')}</th></tr></thead><tbody>
        ${handlers.map((h) => html`<tr><td data-label="${tx('rm.method')}"><a href="${handlerUrl(m, h)}"><code>${h.method}</code></a></td><td data-label="${tx('rm.source_type')}">${typeLabel(h.type)}</td>
          <td data-label="${tx('rm.access')}">${access(m, h)}</td><td data-label="${tx('rm.description')}">${h.description ?? ''}</td></tr>`)}</tbody></table></div>`
      : html`<p class="muted">${tx('rm.no_handlers')}</p>`}
      ${free.length ? html`<form method="get" action="${MODULES}/${m.id}/handler" class="search u-mwnone u-mt1"><input type="hidden" name="t" value="${uri}">
        <div class="field"><label class="label" for="f_new">${tx('rm.method')}</label><select id="f_new" name="new">${free.map((x) => html`<option>${x}</option>`)}</select></div>
        <button class="btn u-selfend">${icon('plus')} ${tx('rm.add_handler')}</button></form>` : ''}
      <p class="wrap-anywhere muted small">${tx('rm.url')} <code>${baseUrl(m)}${uri}</code></p>`)}
    ${region(tx('rm.template'), html`<form method="post" action="${MODULES}/${m.id}/template">${csrf(s)}<input type="hidden" name="orig" value="${uri}">
        <div class="form-grid">
          <div class="field"><label class="label" for="f_uri">${tx('rm.uri_template')}</label><input id="f_uri" name="uri" required value="${uri}"><small class="help">${tx('rm.uri_rename_help')}</small></div>
          <div class="field"><label class="label" for="f_tdesc">${tx('rm.description')}</label><input id="f_tdesc" name="description" value="${t?.description ?? ''}"></div>
        </div><div class="buttons"><button class="btn btn-hot">${tx('rm.save')}</button></div></form>
      <form method="post" action="${MODULES}/${m.id}/template/delete" class="danger-zone">${csrf(s)}<input type="hidden" name="uri" value="${uri}">
        <button class="btn btn-danger" data-confirm="${tx('rm.delete_template_confirm', { uri, n: handlers.length })}">${icon('trash')} ${tx('rm.delete_template')}</button></form>`)}`;
  return frame(s, m, `REST ${m.name}/${uri}`, [[m.name, `${MODULES}/${m.id}`], [uri || '/']], { t: uri }, body);
}

/** "name in [type] [required] [description]" per line ↔ the handler's params. */
export function parseParams(text: string, t: BuilderTranslate = translatorFor('en')): { params: HandlerParam[]; problems: string[] } {
  const params: HandlerParam[] = [];
  const problems: string[] = [];
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    const words = line.trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const [name, where, ...rest] = words;
    if (where !== 'query' && where !== 'body') {
      problems.push(t('rm.e.params_line', { n: i + 1, types: PARAM_TYPES.join(', ') }));
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

type HandlerOpts = { problems?: string[]; form?: Record<string, unknown>; tried?: TryResult; tryForm?: Record<string, unknown> };
const handlerPage = (s: Session, m: ModRow, uri: string, method: string | null, opts: HandlerOpts = {}) => withTranslator(tr(s), () => handlerPageInner(s, m, uri, method, opts));
async function handlerPageInner(s: Session, m: ModRow, uri: string, method: string | null, opts: HandlerOpts) {
  const existing = method ? m.handlers.find((h) => h.path === uri && h.method === method) : undefined;
  const isNew = !existing;
  const f = opts.form;
  const h: Partial<Handler> = existing ?? { method: (method ?? 'GET') as Handler['method'], path: uri, type: method && method !== 'GET' ? 'plpgsql' : 'collection', source: '' };
  const v = (k: string, d: unknown) => String(f ? (f[k] ?? '') : (d ?? ''));
  const type = v('type', h.type);
  const editor = html`<form method="post" action="${MODULES}/${m.id}/handler">${csrf(s)}${errorList(opts.problems ?? [])}
      <input type="hidden" name="t" value="${uri}">${existing ? html`<input type="hidden" name="orig_m" value="${existing.method}">` : ''}
      <div class="form-grid">
        <div class="field"><label class="label" for="f_method">${tx('rm.method')}</label><select id="f_method" name="method">${METHODS.map((x) => html`<option${v('method', h.method) === x ? raw(' selected') : ''}>${x}</option>`)}</select></div>
        <div class="field"><label class="label" for="f_type">${tx('rm.source_type')}</label><select id="f_type" name="type">${TYPES.map((k) => html`<option value="${k}"${type === k ? raw(' selected') : ''}>${typeLabel(k)}</option>`)}</select></div>
        <div class="field"><label class="label" for="f_description">${tx('rm.description')}</label><input id="f_description" name="description" value="${v('description', h.description)}"></div>
      </div>
      <div class="field"><label class="label" for="f_source">${tx('rm.source')}</label>
        <textarea id="f_source" name="source" class="code sql-editor" rows="10" spellcheck="false" data-code="${type === 'plpgsql' ? 'plpgsql' : 'sql'}" required>${v('source', h.source)}</textarea>
        <small class="help">${tx.code('rm.source_help', { params: pathParams(uri).map((p) => `:${p.toUpperCase()}`).join(', ') || tx('rm.none_here') })}</small></div>
      <fieldset class="prop-group"><legend>${tx('rm.who')}</legend>
        <label class="check"><input type="radio" name="auth" value="token"${v('auth', h.auth ?? 'token') !== 'public' ? raw(' checked') : ''}> ${m.roles.length ? tx('rm.auth_token_role', { roles: anyOf(m.roles) }) : tx('rm.auth_token')}</label>
        <label class="check"><input type="radio" name="auth" value="public"${v('auth', h.auth) === 'public' ? raw(' checked') : ''}> ${tx('rm.auth_public')} <small class="help">${m.roles.length ? tx.code('rm.auth_public_403') : tx.code('rm.auth_public_help')}</small></label>
      </fieldset>
      <div class="form-grid">
        <div class="field"><label class="label" for="f_roles">${tx('rm.roles')}</label><input id="f_roles" name="roles" value="${f ? String(f.roles ?? '') : (h.roles ?? []).join(', ')}" placeholder="${tx('rm.no_further_role')}"><small class="help">${tx('rm.roles_help_handler')}</small></div>
        <div class="field"><label class="label" for="f_page_size">${tx('rm.page_size')}</label><input id="f_page_size" name="page_size" type="number" min="1" max="500" value="${v('page_size', h.page_size)}" placeholder="25"><small class="help">${tx('rm.page_size_help')}</small></div>
        <div class="field"><label class="label" for="f_status">${tx('rm.status')}</label><input id="f_status" name="status" type="number" min="200" max="299" value="${v('status', h.status)}" placeholder="${tx('rm.status_ph')}"><small class="help">${tx('rm.status_help')}</small></div>
      </div>
      <div class="field"><label class="label" for="f_params">${tx('rm.params')}</label>
        <textarea id="f_params" name="params" class="code" rows="3" spellcheck="false" placeholder="start_date body string required First day">${f ? String(f.params ?? '') : paramsText(h.params)}</textarea>
        <small class="help">${tx.code('rm.params_help', { types: PARAM_TYPES.join('|') })}</small></div>
      <div class="buttons"><button class="btn btn-hot">${isNew ? tx('rm.create_handler') : tx('rm.save')}</button></div></form>
    ${existing ? html`<form method="post" action="${MODULES}/${m.id}/handler/delete" class="danger-zone">${csrf(s)}<input type="hidden" name="t" value="${uri}"><input type="hidden" name="m" value="${existing.method}">
      <button class="btn btn-danger" data-confirm="${tx('rm.delete_handler_confirm', { method: existing.method, uri })}">${icon('trash')} ${tx('rm.delete_handler')}</button></form>` : ''}`;
  const body = html`${region(isNew ? tx('rm.new_handler_for', { uri: uri || '/' }) : `${h.method} ${uri || '/'}`, editor)}${existing ? await tryPanel(s, m, existing, opts.tried, opts.tryForm) : ''}`;
  return frame(s, m, `REST ${h.method} ${m.name}/${uri}`, [[m.name, `${MODULES}/${m.id}`], [uri || '/', tplUrl(m, uri)], [isNew ? tx('rm.new_handler') : String(h.method)]], { t: uri, m: existing?.method }, body);
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
    ? html`<div class="u-mt1" role="status"><h3 class="small">${tx('rm.response')}</h3>
        <p class="wrap-anywhere">${tx.rich('rm.response_as', { request: raw(`<code>${esc(`${tried.method} ${tried.url}`)}</code>`), as: raw(`<b>${esc(tried.as || tx('rm.no_token'))}</b>`) })}</p>
        ${tried.error ? html`<div class="alert alert-error">${tried.error}</div>` : html`<p><b>${tried.status}</b> <span class="muted">${tried.type ?? ''}</span></p>
          ${tried.body ? html`<pre class="source wrap-pre">${tried.body}</pre>` : ''}`}</div>`
    : '';
  const params = pathParams(h.path);
  return region(tx('rm.try_it'), html`<form method="post" action="${MODULES}/${m.id}/try">${csrf(s)}<input type="hidden" name="t" value="${h.path}"><input type="hidden" name="m" value="${h.method}">
      <p class="muted u-mt0">${tx.rich('rm.try_intro', { as: raw(`<em>${esc(tx('rm.as'))}</em>`) })}</p>
      <div class="form-grid">
        <div class="field"><label class="label" for="f_as">${tx('rm.as')}</label><select id="f_as" name="as"><option value="">${tx('rm.no_token_option')}</option>${accounts.map((u) => html`<option${v('as') === u ? raw(' selected') : ''}>${u}</option>`)}</select></div>
        ${params.map((p) => html`<div class="field"><label class="label" for="f_p_${p}">:${p}</label><input id="f_p_${p}" name="p_${p}" value="${v(`p_${p}`)}" required></div>`)}
        <div class="field"><label class="label" for="f_query">${tx('rm.query_string')}</label><input id="f_query" name="query" value="${v('query', qs)}" placeholder="limit=10&amp;offset=0"></div>
      </div>
      ${h.method === 'GET' || h.method === 'DELETE' ? '' : html`<div class="field"><label class="label" for="f_body">${tx('rm.json_body')}</label><textarea id="f_body" name="body" class="code" rows="5" spellcheck="false" data-code="json">${v('body', bodyEx)}</textarea></div>`}
      <div class="buttons"><button class="btn btn-hot">${icon('play')} ${tx('rm.send', { method: h.method })}</button></div></form>
    ${result}
    <h3 class="small">cURL</h3><pre class="source wrap-pre">curl${h.method === 'GET' ? '' : ` -X ${h.method}`} "${baseUrl(m)}${h.path.replace(/:([a-z][a-z0-9_]*)/gi, (_, p) => `<${p}>`)}"${h.auth === 'public' ? '' : ' -H "Authorization: Bearer $TOKEN"'}${bodyEx ? ` -H "Content-Type: application/json" -d '${bodyEx.replace(/\s+/g, ' ')}'` : ''}</pre>`);
}

// ------------------------------------------------------------------ changes

/** Change a module's definition in a transaction (row locked), after the Run only / lock check. */
async function change(t: BuilderTranslate, m: ModRow, fn: (cur: { handlers: Handler[]; templates: Template[] }) => { handlers: Handler[]; templates: Template[] } | string[]): Promise<string[]> {
  return owner.tx(async (c) => {
    const cur = (await c.query('select handlers, templates from meta.rest_module where id = $1 for update', [m.id])).rows[0];
    if (!cur) return [t('rm.e.module_gone')];
    const next = fn({ handlers: Array.isArray(cur.handlers) ? cur.handlers : [], templates: Array.isArray(cur.templates) ? cur.templates : [] });
    if (Array.isArray(next)) return next;
    const problems = [...templateProblems(next.templates), ...handlerProblems(next.handlers)];
    if (problems.length) return problems;
    await c.query('update meta.rest_module set handlers = $2::jsonb, templates = $3::jsonb where id = $1', [m.id, JSON.stringify(next.handlers), JSON.stringify(next.templates)]);
    return [];
  });
}

/** A handler from the form, or the problems with it. */
function readHandler(t: BuilderTranslate, b: Record<string, unknown>, uri: string): { h: Handler; problems: string[] } {
  const problems: string[] = [];
  const str = (k: string) => String(b[k] ?? '').trim();
  const h: Handler = { method: str('method') as Handler['method'], path: uri, type: str('type') as Handler['type'], source: String(b.source ?? '').replace(/\r\n/g, '\n').trim() };
  const auth = str('auth') || 'token';
  if (auth === 'public') h.auth = 'public';
  else if (auth !== 'token') problems.push(t('rm.e.auth'));
  if (str('description')) h.description = str('description').slice(0, 500);
  const roles = splitRoles(str('roles'));
  if (roles.some((r) => r.length > 100)) problems.push(t('rm.e.role_length'));
  if (roles.length) h.roles = roles;
  if (str('page_size')) {
    const n = Number(str('page_size'));
    if (!Number.isInteger(n) || n < 1 || n > 500) problems.push(t('rm.e.page_size'));
    else h.page_size = n;
  }
  if (str('status')) {
    const n = Number(str('status'));
    if (!Number.isInteger(n) || n < 200 || n > 299) problems.push(t('rm.e.status'));
    else h.status = n;
  }
  const p = parseParams(String(b.params ?? ''), t);
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
    if (!a) return again([tr(s)('rm.e.choose_app')]);
    const name = String(b.name ?? '').trim();
    const title = String(b.title ?? '').trim();
    const problems: string[] = [];
    if (!NAME.test(name)) problems.push(tr(s)('rm.e.base_path'));
    if (!title || title.length > 200) problems.push(tr(s)('rm.e.title'));
    const roles = splitRoles(b.roles);
    const refused = await changeRefused(s, a.id);
    if (refused) problems.push(refused);
    if (problems.length) return again(problems);
    try {
      const r = await owner.one<{ id: number }>(
        `insert into meta.rest_module (app_id, name, title, description, roles, handlers, templates) values ($1, $2, $3, $4, $5, '[]', '[]') returning id`,
        [a.id, name, title, String(b.description ?? '').trim() || null, roles]);
      await log(req, s, { app_id: a.id, name }, 'module created');
      flash(s, tr(s)('rm.created', { name, path: `/a/${a.alias}/rest/${name}/` }));
      return back(reply, s, `${MODULES}/${r!.id}`);
    } catch (e) {
      if ((e as { code?: string }).code !== '23505') throw e;
      return again([tr(s)('rm.e.exists', { app: a.name, name })]);
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
    if (!NAME.test(name)) problems.push(tr(s)('rm.e.base_path'));
    if (!title || title.length > 200) problems.push(tr(s)('rm.e.title'));
    const refused = await changeRefused(s, m.app_id);
    if (refused) problems.push(refused);
    if (!problems.length) {
      try {
        await owner.query('update meta.rest_module set name = $2, title = $3, description = $4, roles = $5, enabled = $6 where id = $1',
          [m.id, name, title, String(b.description ?? '').trim() || null, splitRoles(b.roles), b.enabled !== '0']);
      } catch (e) {
        if ((e as { code?: string }).code !== '23505') throw e;
        problems.push(tr(s)('rm.e.exists', { app: m.app_name, name }));
      }
    }
    if (problems.length) return send(reply.code(422), s, await modulePage(s, m, problems, b));
    await log(req, s, { app_id: m.app_id, name }, `module saved (${b.enabled === '0' ? 'disabled' : 'enabled'}, roles: ${splitRoles(b.roles).join(', ') || 'none'})`);
    flash(s, tr(s)('rm.saved'));
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
    flash(s, tr(s)('rm.deleted', { name: m.name }));
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
    const problems = refused ? [refused] : await change(tr(s), m, (cur) => {
      const list = templatesOf(cur);
      if (orig === null && list.some((t) => t.uri === uri)) return [tr(s)('rm.e.template_exists', { uri })];
      if (orig !== null && !list.some((t) => t.uri === orig)) return [tr(s)('rm.e.template_gone')];
      const next = list.filter((t) => t.uri !== orig).map((t) => ({ uri: t.uri, ...(t.description ? { description: t.description } : {}) }));
      next.push({ uri, ...(description ? { description } : {}) });
      return { templates: next.sort((x, y) => x.uri.localeCompare(y.uri)), handlers: cur.handlers.map((h) => (orig !== null && h.path === orig ? { ...h, path: uri } : h)) };
    });
    if (problems.length) {
      if (orig !== null && templatesOf(m).some((t) => t.uri === orig)) return send(reply.code(422), s, await templatePage(s, m, orig, problems));
      return send(reply.code(422), s, await modulePage(s, m, problems));
    }
    await log(req, s, m, orig === null ? `template ${uri} added` : `template ${orig} saved as ${uri}`);
    flash(s, tr(s)('rm.saved'));
    return back(reply, s, tplUrl(m, uri));
  });

  app.post(`${MODULES}/:id/template/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const m = await modOr404(req, reply, s);
    if (!m) return;
    const uri = String(req.body?.uri ?? '');
    const refused = await changeRefused(s, m.app_id);
    const problems = refused ? [refused] : await change(tr(s), m, (cur) => ({ templates: cur.templates.filter((t) => t?.uri !== uri), handlers: cur.handlers.filter((h) => h.path !== uri) }));
    if (problems.length) {
      flash(s, problems.join(' '), 'error');
      return back(reply, s, `${MODULES}/${m.id}`);
    }
    await log(req, s, m, `template ${uri} deleted`);
    flash(s, tr(s)('rm.template_deleted', { uri: uri || '/' }));
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
    const { h, problems } = readHandler(tr(s), b, uri);
    const refused = await changeRefused(s, m.app_id);
    if (refused) problems.push(refused);
    if (!problems.length)
      problems.push(...await change(tr(s), m, (cur) => {
        if (orig !== null && !cur.handlers.some((x) => x.path === uri && x.method === orig)) return [tr(s)('rm.e.handler_gone')];
        const at = orig === null ? -1 : cur.handlers.findIndex((x) => x.path === uri && x.method === orig);
        const handlers = [...cur.handlers];
        if (at >= 0) handlers[at] = h;
        else handlers.push(h);
        return { handlers, templates: cur.templates };
      }));
    if (problems.length) return send(reply.code(422), s, await handlerPage(s, m, uri, orig, { problems, form: b }));
    await log(req, s, m, `handler ${h.method} ${uri} ${orig === null ? 'created' : 'saved'} (${h.type}, ${h.auth === 'public' ? 'public' : 'token'})`);
    flash(s, tr(s)('rm.saved'));
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
    const problems = refused ? [refused] : await change(tr(s), m, (cur) => ({ templates: cur.templates, handlers: cur.handlers.filter((h) => !(h.path === uri && h.method === method)) }));
    if (problems.length) {
      flash(s, problems.join(' '), 'error');
      return back(reply, s, `${MODULES}/${m.id}`);
    }
    await log(req, s, m, `handler ${method} ${uri} deleted`);
    flash(s, tr(s)('rm.handler_deleted', { method, uri: uri || '/' }));
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
        if (!(await tryAccounts(m.app_id)).includes(as)) throw new Error(tr(s)('rm.e.choose_account'));
        headers.authorization = `Bearer ${(await issueApiToken(m.app_id, as, 1, { internal: true })).token}`;
      }
      const raw = h.method === 'GET' || h.method === 'DELETE' ? '' : String(b.body ?? '').trim();
      if (raw) {
        try {
          JSON.parse(raw);
        } catch {
          throw new Error(tr(s)('rm.e.bad_json'));
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
        tried.body = text.length > MAX_TRY_BODY ? `${text.slice(0, MAX_TRY_BODY)}\n… ${tr(s)('rm.characters', { n: text.length })}` : text;
      } else if (res.rawPayload.length) tried.body = tr(s)('rm.bytes_of', { n: res.rawPayload.length, type: tried.type || tr(s)('rm.content') });
      await log(req, s, m, `tried ${h.method} ${uri} as ${as || 'no token'}: ${res.statusCode}`);
    } catch (e) {
      tried.error = (e as Error).message;
    }
    return send(reply, s, await handlerPage(s, m, uri, h.method, { tried, tryForm: b }));
  });
}
