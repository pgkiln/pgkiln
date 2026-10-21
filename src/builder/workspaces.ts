import { tr, translatorFor, type BuilderTranslate } from './i18n.ts';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { owner, type Db } from '../db.ts';
import { devDbForWorkspace, workspacesChanged } from '../workspace-db.ts';
import { ownerUrl, runtimeUrl } from '../db.ts';
import { secretKeyConfigured } from '../secrets.ts';
import { html, raw } from '../html.ts';
import { icon } from '../icons.ts';
import { clientIp, logActivity, type BuilderWorkspace, type Session } from '../session.ts';
import { isAdmin } from './locks.ts';
import { back, BANNER_COLORS, BASE, csrf, developer, flash, input, region, select, send, shell, type Req } from './ui.ts';

// Workspaces (064; APEX: workspaces). A workspace groups applications and the
// developers who build them. developer() loads the developer's workspaces into
// the session object (loadWorkspaces) and refuses every /apps/:id and
// /pages/:pid request for an application outside them (appAllowed). The
// current workspace (session state __WS) scopes the App Builder's lists and
// receives new applications. Administrators see every workspace and manage
// them on Workspace utilities → Workspaces.
//
// Not a security boundary between developers who write SQL (the SQL Workshop
// and application code run with installation-wide rights): see chapter 3.

export type WorkspaceRef = BuilderWorkspace;

/** Workspace 1: applications without a meta.workspace_app row belong to it. */
export const DEFAULT_WORKSPACE = 1;

/** The workspaces a developer may use (administrators: all), and the current one, on the session object. */
export async function loadWorkspaces(s: Session) {
  const rows = (
    await owner.query<WorkspaceRef & { instance_admin?: boolean }>(
      `select w.id, w.name, w.message, w.banner_label, w.banner_color, w.isolated, w.sql_workshop, w.rest_services, w.builder_home,
              coalesce((select json_agg(json_build_object('label', l.label, 'url', l.url, 'description', l.description) order by l.position, lower(l.label))
                          from meta.workspace_link l where l.workspace_id = w.id), '[]') as links,
              exists (select 1 from meta.developer d where d.username = $1 and d.is_admin)
                or exists (select 1 from meta.workspace_member m where m.workspace_id = w.id and m.username = $1 and m.is_admin) as admin,
              exists (select 1 from meta.developer d where d.username = $1 and d.is_admin) as instance_admin
         from meta.workspace w
        where exists (select 1 from meta.developer d where d.username = $1 and d.is_admin)
           or exists (select 1 from meta.workspace_member m where m.workspace_id = w.id and m.username = $1)
        order by w.id = 1 desc, lower(w.name)`,
      [s.username],
    )
  ).rows;
  s.workspaces = rows;
  s.instanceAdmin = !!rows[0]?.instance_admin;
  const wanted = Number(s.state.__WS);
  s.workspace = rows.find((w) => w.id === wanted) ?? rows[0] ?? null;
}

/** The current workspace's id; -1 (no application matches) for a developer without a workspace. */
export const currentWorkspace = (s: Session) => s.workspace?.id ?? -1;

/** The workspace of an application (Default without a row), or null when the application doesn't exist. */
export async function appWorkspace(appId: number | string): Promise<number | null> {
  if (!/^\d{1,9}$/.test(String(appId))) return null;
  const r = await owner.one<{ ws: number }>('select meta.app_workspace(id) as ws from meta.app where id = $1', [appId]);
  return r ? r.ws : null;
}

/**
 * May this developer open the application? Missing applications pass (the
 * route answers 404 itself). Opening an application of another of the
 * developer's workspaces makes that workspace the current one.
 */
export async function appAllowed(s: Session, appId: number | string) {
  const ws = await appWorkspace(appId);
  if (ws === null) return true;
  const w = s.workspaces?.find((x) => x.id === ws);
  if (!w) return false;
  if (s.workspace?.id !== w.id) {
    s.workspace = w;
    s.state.__WS = String(w.id);
  }
  return true;
}

/**
 * The connection for a developer's own SQL (the SQL Workshop's tools): the owner, or in an
 * isolated workspace (090) its developer login, which reaches the workspace's application
 * roles only. Administrators keep the owner.
 */
export async function workshopDb(s: Session): Promise<Db> {
  if (!s.workspace || (await isAdmin(s.username))) return owner;
  return (await devDbForWorkspace(s.workspace.id)) ?? owner;
}

/** Schemas the SQL Workshop's connection may use (not pgkiln's, not the system's). */
export async function usableSchemas(db: Db) {
  return (await db.query<{ n: string }>(
    `select nspname as n from pg_namespace where nspname !~ '^pg_' and nspname not in ('information_schema', 'meta')
        and has_schema_privilege(oid, 'USAGE') order by 1`)).rows.map((r) => r.n);
}

/** (sprint 61) The session's default schema (SQL Workshop home), if the connection may still use it. */
export async function sessionSchema(s: Session, db: Db) {
  const v = s.state.__SQLSCHEMA;
  if (typeof v !== 'string' || !v) return null;
  return (await db.one<{ ok: boolean }>(`select has_schema_privilege(oid, 'USAGE') as ok from pg_namespace where nspname = $1`, [v]))?.ok ? v : null;
}

/** Who the SQL Workshop runs as, for its notes. */
export const workshopRunsAs = (db: Db) => (db === owner ? 'the builder\'s owner connection' : 'this isolated workspace\'s developer login (its applications\' roles, nothing else)');

/** Put an application in a workspace (inside the caller's transaction, or on the owner pool). */
export async function placeApp(db: { query: (sql: string, params?: unknown[]) => Promise<unknown> }, appId: number, workspaceId: number) {
  await db.query(
    `insert into meta.workspace_app (app_id, workspace_id) values ($1, $2)
     on conflict (app_id) do update set workspace_id = excluded.workspace_id`,
    [appId, workspaceId],
  );
}

/** SQL condition "application a is in workspace $n" for the App Builder's lists. */
export const inWorkspaceSql = (alias: string, param: number) => `meta.app_workspace(${alias}.id) = $${param}`;

/** The switcher in the builder's account menu, for developers with several workspaces. */
export function workspaceMenu(s: Session) {
  const list = s.workspaces ?? [];
  if (list.length < 2) return '';
  return html`<div class="menu-section"><span class="small muted" id="ws-label">${tr(s)('status.workspace')}</span>
    <form method="post" action="${BASE}/workspace" class="ws-switch" aria-labelledby="ws-label">${csrf(s)}
      ${list.map((w) => html`<button name="workspace" value="${w.id}" aria-pressed="${s.workspace?.id === w.id ? 'true' : 'false'}">${icon('layers')}<span>${w.name}</span></button>`)}
    </form></div>`;
}

const NAME = /^\S(.{0,58}\S)?$/;

async function adminOnly(s: Session, reply: FastifyReply) {
  if (await isAdmin(s.username)) return true;
  const tx = tr(s);
  const main = html`<h1 class="u-mb1">${tx('wsp.title')}</h1><div class="alert alert-error" role="alert">${tx('wsp.admins_only')}</div>`;
  await send(reply.code(403), s, shell(s, tx('wsp.title'), [['App Builder', BASE], ['Workspace utilities', `${BASE}/utilities`], [tx('wsp.title')]], main));
  return false;
}

/** An administrator, or a workspace administrator of this workspace (090). */
export async function workspaceAdmin(username: string | null, workspaceId: number | string) {
  if (!username) return false;
  if (await isAdmin(username)) return true;
  return !!(await owner.one('select 1 as ok from meta.workspace_member where workspace_id = $1 and username = $2 and is_admin', [workspaceId, username]));
}

async function workspaceAdminOnly(s: Session, reply: FastifyReply, workspaceId: string) {
  if (await workspaceAdmin(s.username, workspaceId)) return true;
  return adminOnly(s, reply);
}

const crumbs = (tx: BuilderTranslate, extra: [string, string?][] = []): [string, string?][] => [['App Builder', BASE], ['Workspace utilities', `${BASE}/utilities`], [tx('wsp.title'), `${BASE}/workspaces`], ...extra];

const nameError = (e: unknown, tx: BuilderTranslate) => {
  const m = (e as Error).message;
  if (m.includes('workspace_name_key')) return tx('wsp.err.exists');
  if (m.includes('workspace_name_check')) return tx('wsp.err.name_check');
  return m;
};

const ROLE = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

/** Why this installation can't isolate a workspace (090), or null. */
export function isolationProblem(tx: BuilderTranslate = translatorFor('en')): string | null {
  if (!secretKeyConfigured()) return tx('wsp.iso.secret');
  if (runtimeUrl === ownerUrl) return tx('wsp.iso.runtime');
  return null;
}

/** A role problem from meta.workspace_sync_roles (or a duplicate role) in words. */
const roleError = (e: unknown, tx: BuilderTranslate) => {
  const m = (e as Error).message;
  if (m.includes('workspace_role_role_name_key')) return tx('wsp.err.role_taken');
  if (m.includes('workspace_role_pkey')) return tx('wsp.err.role_has');
  return m;
};

/** The Isolation region of a workspace's page. */
function isolationRegion(s: Session, w: { id: number; name: string; isolated: boolean; run_role: string | null; dev_role: string | null },
  roles: { role_name: string; exists: boolean; apps: string | null }[]) {
  const tx = tr(s);
  const problem = w.isolated ? null : isolationProblem(tx);
  const body = w.isolated
    ? html`<p class="u-mt0"><span class="tag">${icon('lock')} ${tx('wsp.isolated_tag')}</span> ${tx.rich('wsp.iso.on', { run: html`<code>${w.run_role}</code>`, dev: html`<code>${w.dev_role}</code>` })}</p>
      <div class="table-wrap"><table class="report report-reflow"><thead><tr><th>${tx('wsp.db_role')}</th><th>${tx('wsp.used_by')}</th><th></th></tr></thead><tbody>
        ${roles.length
          ? roles.map((r) => html`<tr><td data-label="${tx('wsp.db_role')}"><code>${r.role_name}</code>${r.exists ? '' : html` <span class="tag tag-error">${tx('wsp.missing')}</span>`}</td>
              <td data-label="${tx('wsp.used_by')}">${r.apps ?? html`<span class="muted">${tx('wsp.no_app')}</span>`}</td>
              <td><form method="post" action="${BASE}/workspaces/${w.id}/roles">${csrf(s)}<input type="hidden" name="role" value="${r.role_name}">
                <button class="btn btn-sm" name="action" value="remove">${tx('wsp.remove')}</button></form></td></tr>`)
          : html`<tr><td colspan="3" class="empty">${tx('wsp.no_roles')}</td></tr>`}</tbody></table></div>
      <form method="post" action="${BASE}/workspaces/${w.id}/roles" class="u-mt1">${csrf(s)}
        ${input('role', tx('wsp.add_role'), '', { help: tx('wsp.add_role_help') })}
        <div class="buttons"><button class="btn" name="action" value="add">${icon('plus')} ${tx('wsp.add_role_btn')}</button></div></form>
      <form method="post" action="${BASE}/workspaces/${w.id}/isolation" class="danger-zone">${csrf(s)}<input type="hidden" name="isolated" value="false">
        <button class="btn btn-danger" data-confirm="${tx('wsp.make_shared_confirm', { name: w.name })}">${tx('wsp.make_shared')}</button></form>`
    : html`<p class="u-mt0">${tx('wsp.shared_text')}</p>
      <p class="muted small">${tx('wsp.iso_help')}</p>
      ${problem ? html`<div class="alert alert-error" role="alert">${tx('wsp.to_isolate', { problem })}</div>` : ''}
      <form method="post" action="${BASE}/workspaces/${w.id}/isolation">${csrf(s)}<input type="hidden" name="isolated" value="true">
        <div class="buttons"><button class="btn btn-hot"${problem ? raw(' disabled') : ''} data-confirm="${tx('wsp.isolate_confirm', { name: w.name })}">${icon('lock')} ${tx('wsp.isolate')}</button></div></form>`;
  return region(tx('wsp.isolation'), body);
}

/** (091) Manage service: the workspace message and the environment banner. */
function serviceRegion(s: Session, w: { id: number; message: string | null; banner_label: string | null; banner_color: string }) {
  const tx = tr(s);
  return region(tx('wsp.service'), html`<form method="post" action="${BASE}/workspaces/${w.id}/service">${csrf(s)}
      <div class="field"><label class="label" for="f_message">${tx('wsp.message')}</label>
        <textarea id="f_message" name="message" rows="3" maxlength="2000">${w.message ?? ''}</textarea>
        <small class="help">${tx('wsp.message_help')}</small></div>
      <div class="form-grid">
        ${input('banner_label', tx('wsp.banner'), w.banner_label ?? '', { placeholder: 'DEVELOPMENT', help: tx('wsp.banner_help') })}
        ${select('banner_color', tx('wsp.banner_colour'), w.banner_color, BANNER_COLORS.map((c): [string, string] => [c, c[0].toUpperCase() + c.slice(1)]))}
      </div>
      <div class="buttons"><button class="btn">${tx('wsp.save')}</button></div></form>`, '', 'service');
}

/** (093) Workspace preferences: the SQL Workshop and the applications' REST modules on or off. */
function preferencesRegion(s: Session, w: { id: number; sql_workshop: boolean; rest_services: boolean; builder_home: string | null }) {
  const check = (name: string, on: boolean, label: string, help: string) =>
    html`<div class="field"><label class="check"><input type="checkbox" name="${name}" value="true"${on ? raw(' checked') : ''}> ${label}</label><small class="help">${help}</small></div>`;
  const tx = tr(s);
  return region(tx('wsp.prefs'), html`<form method="post" action="${BASE}/workspaces/${w.id}/preferences">${csrf(s)}
      ${check('sql_workshop', w.sql_workshop, tx('wsp.sql_on'), tx('wsp.sql_on_help'))}
      ${check('rest_services', w.rest_services, tx('wsp.rest_on'), tx('wsp.rest_on_help', { path: '/a/<alias>/rest/…' }))}
      ${select('builder_home', tx('wsp.builder_home'), w.builder_home === 'home' ? 'home' : 'apps', [['apps', tx('wsp.home.apps')], ['home', tx('wsp.home.home')]], tx('wsp.builder_home_help'))}
      <div class="buttons"><button class="btn">${tx('wsp.save_prefs')}</button></div></form>`, '', 'preferences');
}

/** (093) Extension links: links to other tools in the builder's Extensions menu. */
function linksRegion(s: Session, w: { id: number }, links: { id: number; label: string; url: string; description: string | null; position: number }[]) {
  const tx = tr(s);
  return region(tx('wsp.links'), html`<p class="muted u-mt0">${tx.rich('wsp.links_help', { menu: html`<strong>${tx('wsp.extensions')}</strong>` })}</p>
      <div class="table-wrap"><table class="report report-reflow">
        <thead><tr><th>${tx('wsp.label')}</th><th>${tx('wsp.url')}</th><th class="num">${tx('wsp.order')}</th><th></th></tr></thead>
        <tbody>${links.length
          ? links.map((l) => html`<tr><td data-label="${tx('wsp.label')}">${l.label}${l.description ? html` <span class="muted">${l.description}</span>` : ''}</td>
              <td data-label="${tx('wsp.url')}" class="u-break"><a href="${l.url}" target="_blank" rel="noopener noreferrer">${l.url}</a></td>
              <td class="num" data-label="${tx('wsp.order')}">${l.position}</td>
              <td><form method="post" action="${BASE}/workspaces/${w.id}/links/${l.id}/delete">${csrf(s)}<button class="btn btn-sm btn-danger" data-confirm="${tx('wsp.delete_link_confirm', { label: l.label })}">${tx('wsp.delete')}</button></form></td></tr>`)
          : html`<tr><td colspan="4" class="empty">${tx('wsp.no_links')}</td></tr>`}</tbody></table></div>
      <form method="post" action="${BASE}/workspaces/${w.id}/links" class="u-mt1">${csrf(s)}
        <div class="form-grid">
          ${input('label', tx('wsp.label'), '', { required: true, placeholder: tx('wsp.label_ph') })}
          ${input('url', tx('wsp.url'), '', { required: true, type: 'url', placeholder: 'https://grafana.example.com', help: 'http:// or https://' })}
          ${input('description', tx('wsp.description'), '')}
          ${input('position', tx('wsp.order'), '0', { type: 'number' })}
        </div>
        <div class="buttons"><button class="btn">${icon('plus')} ${tx('wsp.add_link')}</button></div></form>`, '', 'links');
}

const LINK_LABEL = /^\S(.{0,58}\S)?$/;
const LINK_URL = /^https?:\/\/[^\s<>"]+$/;

export async function workspaceRoutes(app: FastifyInstance) {
  // switch the current workspace (any of the developer's own)
  app.post(`${BASE}/workspace`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const w = s.workspaces?.find((x) => String(x.id) === req.body?.workspace);
    if (!w) return reply.code(404).send('Not found');
    s.state.__WS = String(w.id);
    flash(s, tr(s)('wsp.switched', { name: w.name }));
    return back(reply, s, BASE);
  });

  app.get(`${BASE}/workspaces`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply))) return;
    const tx = tr(s);
    const rows = (
      await owner.query(
        `select w.id, w.name, w.description, w.isolated,
                (select count(*) from meta.app a where meta.app_workspace(a.id) = w.id)::int as apps,
                (select string_agg(m.username, ', ' order by m.username) from meta.workspace_member m where m.workspace_id = w.id) as members
           from meta.workspace w order by w.id = 1 desc, lower(w.name)`,
      )
    ).rows;
    const main = html`
      <div class="title-row"><h1>${tx('wsp.title')}</h1></div>
      <p class="muted u-mt0">${tx.rich('wsp.intro', { isolated: html`<strong>${tx('wsp.isolated_word')}</strong>` })}</p>
      <div class="columns wide-left">
        ${region(tx('wsp.title'), html`<div class="table-wrap"><table class="report report-reflow">
          <thead><tr><th>${tx('wsp.workspace')}</th><th class="num">${tx('wsp.applications')}</th><th>${tx('wsp.developers')}</th></tr></thead>
          <tbody>${rows.map((w) => html`<tr>
            <td data-label="${tx('wsp.workspace')}"><a href="${BASE}/workspaces/${w.id}">${w.name}</a>${w.isolated ? html` <span class="tag">${icon('lock')} ${tx('wsp.isolated_tag')}</span>` : ''}${w.description ? html` <span class="muted">${w.description}</span>` : ''}</td>
            <td class="num" data-label="${tx('wsp.applications')}">${w.apps}</td>
            <td data-label="${tx('wsp.developers')}">${w.members ?? html`<span class="muted">${tx('wsp.admins_text')}</span>`}</td></tr>`)}</tbody></table></div>`)}
        ${region(tx('wsp.add'), html`<form method="post" action="${BASE}/workspaces">${csrf(s)}
          ${input('name', tx('wsp.name'), '', { required: true, help: tx('wsp.name_help') })}
          ${input('description', tx('wsp.description'), '')}
          <p class="muted small">${tx('wsp.first_dev')}</p>
          <div class="buttons"><button class="btn btn-hot">${icon('plus')} ${tx('wsp.add')}</button></div></form>`)}
      </div>`;
    return send(reply, s, shell(s, tx('wsp.title'), [['App Builder', BASE], ['Workspace utilities', `${BASE}/utilities`], [tx('wsp.title')]], main));
  });

  app.post(`${BASE}/workspaces`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply))) return;
    const name = String(req.body?.name ?? '').trim();
    if (!NAME.test(name)) {
      flash(s, tr(s)('wsp.err.name'), 'error');
      return back(reply, s, `${BASE}/workspaces`);
    }
    try {
      const id = await owner.tx(async (c) => {
        const w = (await c.query('insert into meta.workspace (name, description) values ($1, $2) returning id', [name, String(req.body?.description ?? '').trim() || null])).rows[0].id as number;
        await c.query('insert into meta.workspace_member (workspace_id, username) values ($1, $2)', [w, s.username]);
        return w;
      });
      await logActivity({ appId: null, username: s.username, event: 'workspace', ip: clientIp(req), detail: `created workspace ${name}` });
      flash(s, tr(s)('wsp.added', { name }));
      return back(reply, s, `${BASE}/workspaces/${id}`);
    } catch (e) {
      flash(s, nameError(e, tr(s)), 'error');
      return back(reply, s, `${BASE}/workspaces`);
    }
  });

  app.get(`${BASE}/workspaces/:id(^\\d{1,9}$)`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await workspaceAdminOnly(s, reply, req.params.id))) return;
    const full = await isAdmin(s.username);
    const tx = tr(s);
    const w = await owner.one('select * from meta.workspace where id = $1', [req.params.id]);
    if (!w) return reply.code(404).send('Not found');
    const [devs, apps, others, rolesQ] = await Promise.all([
      owner.query(
        `select d.username, d.is_admin, m.username is not null as member, coalesce(m.is_admin, false) as ws_admin
           from meta.developer d left join meta.workspace_member m on m.username = d.username and m.workspace_id = $1 order by d.username`,
        [w.id],
      ),
      owner.query(`select a.id, a.name, a.alias from meta.app a where meta.app_workspace(a.id) = $1 order by lower(a.name), a.id`, [w.id]),
      owner.query('select id, name from meta.workspace where id <> $1 order by id = 1 desc, lower(name)', [w.id]),
      owner.query(
        `select x.role_name, exists (select 1 from pg_roles r where r.rolname = x.role_name) as exists,
                (select string_agg(a.alias, ', ' order by a.alias) from meta.app a where a.db_role = x.role_name) as apps
           from meta.workspace_role x where x.workspace_id = $1 order by 1`,
        [w.id],
      ),
    ]);
    const roles = rolesQ;
    const links = (await owner.query('select id, label, url, description, position from meta.workspace_link where workspace_id = $1 order by position, lower(label)', [w.id])).rows;
    const main = html`
      <div class="title-row"><h1>${w.name}</h1></div>
      <div class="columns wide-left">
        ${region(tx('wsp.settings'), html`<form method="post" action="${BASE}/workspaces/${w.id}">${csrf(s)}
            ${input('name', tx('wsp.name'), w.name, { required: true })}
            ${input('description', tx('wsp.description'), w.description ?? '')}
            <div class="buttons"><button class="btn btn-hot">${tx('wsp.save')}</button></div></form>
          ${!full ? '' : w.id === 1
            ? html`<p class="muted small">${tx('wsp.default_no_delete')}</p>`
            : html`<form method="post" action="${BASE}/workspaces/${w.id}/delete" class="danger-zone">${csrf(s)}
                <button class="btn btn-danger" data-confirm="${tx('wsp.delete_confirm', { name: w.name })}"${apps.rows.length ? raw(' disabled') : ''}>${tx('wsp.delete_ws')}</button>
                ${apps.rows.length ? html`<p class="muted small">${tx('wsp.move_first')}</p>` : ''}</form>`}`)}
        ${region(tx('wsp.developers'), html`<p class="muted u-mt0">${tx('wsp.devs_help')}</p>
          <form method="post" action="${BASE}/workspaces/${w.id}/members">${csrf(s)}
            <fieldset class="field"><legend class="sr-only">${tx('wsp.developers')}</legend><div class="radio-group">
            ${devs.rows.map((d) => html`<label class="check"><input type="checkbox" name="member" value="${d.username}"${d.member ? raw(' checked') : ''}> ${d.username}${d.is_admin ? html` <span class="muted">${tx('wsp.administrator')}</span>` : ''}</label>`)}
            </div></fieldset>
            <fieldset class="field"><legend class="label">${tx('wsp.ws_admins')}</legend><div class="radio-group">
            ${devs.rows.filter((d) => d.member && !d.is_admin).map((d) => html`<label class="check"><input type="checkbox" name="admin" value="${d.username}"${d.ws_admin ? raw(' checked') : ''}> ${d.username}</label>`)}
            </div><small class="help">${tx('wsp.ws_admins_help')}</small></fieldset>
            <div class="buttons"><button class="btn">${tx('wsp.save_devs')}</button></div></form>`)}
      </div>
      ${serviceRegion(s, w)}
      ${region(tx('wsp.mail_net'), html`<p class="u-mt0">${tx.rich('wsp.mail_net_text', { mail: html`<a href="${BASE}/workspaces/${w.id}/mail">${tx('wsp.mail_service')}</a>`, network: html`<a href="${BASE}/network?ws=${w.id}">${tx('wsp.network')}</a>`, queue: html`<a href="${BASE}/mail-queue${full ? `?ws=${w.id}` : ''}">${tx('wsp.queue')}</a>` })}</p>`, '', 'mail-network')}
      <div class="columns">${preferencesRegion(s, w)}${linksRegion(s, w, links)}</div>
      ${full ? isolationRegion(s, w, roles.rows) : region(tx('wsp.isolation'), html`<p class="u-mt0">${w.isolated ? tx('wsp.iso_short_on') : tx('wsp.iso_short_off')} ${tx('wsp.admins_change')}</p>`)}
      ${!full ? '' : region(tx('wsp.applications'), html`<div class="table-wrap"><table class="report report-reflow">
        <thead><tr><th>${tx('wsp.application')}</th><th>${tx('wsp.move_to')}</th></tr></thead>
        <tbody>${apps.rows.length
          ? apps.rows.map((a) => html`<tr><td data-label="${tx('wsp.application')}"><a href="${BASE}/apps/${a.id}">${a.name}</a> <span class="muted">${a.id} · /a/${a.alias}</span></td>
              <td data-label="${tx('wsp.move_to')}">${others.rows.length
                ? html`<form method="post" action="${BASE}/workspaces/${w.id}/move" class="search u-mwnone">${csrf(s)}<input type="hidden" name="app" value="${a.id}">
                    <label class="sr-only" for="move-${a.id}">${tx('wsp.move_label', { app: a.name })}</label>
                    <select id="move-${a.id}" name="to">${others.rows.map((o) => html`<option value="${o.id}">${o.name}</option>`)}</select>
                    <button class="btn">${tx('wsp.move')}</button></form>`
                : html`<span class="muted">${tx('wsp.no_other')}</span>`}</td></tr>`)
          : html`<tr><td colspan="2" class="empty">${tx('wsp.no_apps')}</td></tr>`}</tbody></table></div>`)}`;
    return send(reply, s, shell(s, w.name, full ? crumbs(tx, [[w.name]]) : [['App Builder', BASE], ['Workspace utilities', `${BASE}/utilities`], [w.name]], main));
  });

  app.post(`${BASE}/workspaces/:id(^\\d{1,9}$)`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await workspaceAdminOnly(s, reply, req.params.id))) return;
    const name = String(req.body?.name ?? '').trim();
    try {
      if (!NAME.test(name)) throw new Error(tr(s)('wsp.err.name'));
      const r = await owner.query('update meta.workspace set name = $2, description = $3 where id = $1', [req.params.id, name, String(req.body?.description ?? '').trim() || null]);
      flash(s, tr(s)(r.rowCount ? 'wsp.saved' : 'wsp.not_found'), r.rowCount ? 'ok' : 'error');
    } catch (e) {
      flash(s, nameError(e, tr(s)), 'error');
    }
    return back(reply, s, `${BASE}/workspaces/${req.params.id}`);
  });

  app.post(`${BASE}/workspaces/:id(^\\d{1,9}$)/members`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await workspaceAdminOnly(s, reply, req.params.id))) return;
    if (!(await owner.one('select 1 as ok from meta.workspace where id = $1', [req.params.id]))) return reply.code(404).send('Not found');
    const posted = req.body?.member as unknown;
    const names = (Array.isArray(posted) ? posted : posted == null ? [] : [posted]).map(String).slice(0, 10000);
    const postedAdmins = req.body?.admin as unknown;
    const admins = (Array.isArray(postedAdmins) ? postedAdmins : postedAdmins == null ? [] : [postedAdmins]).map(String).slice(0, 10000);
    await owner.tx(async (c) => {
      await c.query('delete from meta.workspace_member where workspace_id = $1', [req.params.id]);
      // only existing developers (unknown names are ignored)
      await c.query(
        `insert into meta.workspace_member (workspace_id, username, is_admin)
         select $1, d.username, d.username = any($3::text[]) from meta.developer d where d.username = any($2::text[])`,
        [req.params.id, names, admins],
      );
    });
    await logActivity({ appId: null, username: s.username, event: 'workspace', ip: clientIp(req), detail: `developers of workspace ${req.params.id}: ${names.join(', ').slice(0, 1000)}` });
    flash(s, tr(s)('wsp.devs_saved'));
    return back(reply, s, `${BASE}/workspaces/${req.params.id}`);
  });

  app.post(`${BASE}/workspaces/:id(^\\d{1,9}$)/move`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply))) return;
    const from = Number(req.params.id);
    const appId = /^\d{1,9}$/.test(req.body?.app ?? '') ? Number(req.body!.app) : null;
    const to = (await owner.one<{ id: number; name: string }>('select id, name from meta.workspace where id = $1', [/^\d{1,9}$/.test(req.body?.to ?? '') ? req.body!.to : null]));
    if (appId === null || !to || (await appWorkspace(appId)) !== from) return reply.code(404).send('Not found');
    try {
      await owner.tx(async (c) => {
        // (090) the application's database role goes along: out of the old workspace's roles (when no other
        // application there uses it), into the new one's when that one is isolated
        const role = (await c.query<{ db_role: string | null }>('select db_role from meta.app where id = $1', [appId])).rows[0]?.db_role;
        if (role) {
          await c.query(
            `delete from meta.workspace_role x where x.workspace_id = $1 and x.role_name = $2
                and not exists (select 1 from meta.app a where a.db_role = $2 and a.id <> $3 and meta.app_workspace(a.id) = $1)`,
            [from, role, appId],
          );
          if ((await c.query('select 1 from meta.workspace where id = $1 and isolated', [to.id])).rowCount)
            await c.query('insert into meta.workspace_role (workspace_id, role_name) values ($1, $2) on conflict do nothing', [to.id, role]);
        }
        await placeApp(c, appId, to.id);
        // (092) groups are the old workspace's
        await c.query('delete from meta.app_group_member where app_id = $1', [appId]);
      });
    } catch (e) {
      flash(s, tr(s)('wsp.not_moved', { why: roleError(e, tr(s)) }), 'error');
      return back(reply, s, `${BASE}/workspaces/${from}`);
    } finally {
      await workspacesChanged();
    }
    await logActivity({ appId, username: s.username, event: 'workspace', ip: clientIp(req), detail: `moved from workspace ${from} to ${to.id}` });
    flash(s, tr(s)('wsp.moved', { name: to.name }));
    return back(reply, s, `${BASE}/workspaces/${from}`);
  });

  app.post(`${BASE}/workspaces/:id(^\\d{1,9}$)/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply))) return;
    const id = Number(req.params.id);
    if (id === DEFAULT_WORKSPACE) {
      flash(s, tr(s)('wsp.err.default'), 'error');
      return back(reply, s, `${BASE}/workspaces/${id}`);
    }
    if (await owner.one('select 1 as ok from meta.workspace where id = $1 and isolated', [id])) {
      flash(s, tr(s)('wsp.err.isolated'), 'error');
      return back(reply, s, `${BASE}/workspaces/${id}`);
    }
    if (await owner.one('select 1 as ok from meta.workspace_app where workspace_id = $1 limit 1', [id])) {
      flash(s, tr(s)('wsp.err.has_apps'), 'error');
      return back(reply, s, `${BASE}/workspaces/${id}`);
    }
    const r = await owner.one<{ name: string }>('delete from meta.workspace where id = $1 returning name', [id]);
    if (r) await logActivity({ appId: null, username: s.username, event: 'workspace', ip: clientIp(req), detail: `deleted workspace ${r.name}` });
    flash(s, r ? tr(s)('wsp.deleted', { name: r.name }) : tr(s)('wsp.not_found'), r ? 'ok' : 'error');
    return back(reply, s, `${BASE}/workspaces`);
  });

  // (090) isolate a workspace, or make it shared again
  app.post(`${BASE}/workspaces/:id(^\\d{1,9}$)/isolation`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply))) return;
    const id = Number(req.params.id);
    const on = req.body?.isolated === 'true';
    try {
      const problem = on ? isolationProblem(tr(s)) : null;
      if (problem) throw new Error(problem);
      const r = await owner.query('update meta.workspace set isolated = $2 where id = $1', [id, on]);
      if (!r.rowCount) return reply.code(404).send('Not found');
      await logActivity({ appId: null, username: s.username, event: 'workspace', ip: clientIp(req), detail: `workspace ${id} ${on ? 'isolated' : 'shared'}` });
      flash(s, tr(s)(on ? 'wsp.isolated_now' : 'wsp.shared_now'));
    } catch (e) {
      flash(s, tr(s)(on ? 'wsp.not_isolated' : 'wsp.not_changed', { why: roleError(e, tr(s)) }), 'error');
    } finally {
      await workspacesChanged();
    }
    return back(reply, s, `${BASE}/workspaces/${id}`);
  });

  // (090) the database roles of an isolated workspace
  app.post(`${BASE}/workspaces/:id(^\\d{1,9}$)/roles`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply))) return;
    const id = Number(req.params.id);
    const role = String(req.body?.role ?? '').trim();
    const remove = req.body?.action === 'remove';
    try {
      if (!ROLE.test(role)) throw new Error(tr(s)('wsp.err.role_name'));
      if (!remove && !(await owner.one('select 1 as ok from pg_roles where rolname = $1', [role]))) throw new Error(tr(s)('wsp.err.no_role', { role }));
      if (remove) {
        const used = await owner.one<{ aliases: string }>(
          `select string_agg(alias, ', ') as aliases from meta.app a where a.db_role = $2 and meta.app_workspace(a.id) = $1 having count(*) > 0`,
          [id, role],
        );
        if (used) throw new Error(tr(s)(used.aliases.includes(',') ? 'wsp.err.role_used' : 'wsp.err.role_used_one', { apps: used.aliases, role }));
        await owner.query('delete from meta.workspace_role where workspace_id = $1 and role_name = $2', [id, role]);
      } else await owner.query('insert into meta.workspace_role (workspace_id, role_name) values ($1, $2)', [id, role]);
      await logActivity({ appId: null, username: s.username, event: 'workspace', ip: clientIp(req), detail: `workspace ${id}: ${remove ? 'removed' : 'added'} role ${role}` });
      flash(s, tr(s)(remove ? 'wsp.role_removed' : 'wsp.role_added', { role }));
    } catch (e) {
      flash(s, tr(s)('wsp.not_saved', { why: roleError(e, tr(s)) }), 'error');
    } finally {
      await workspacesChanged();
    }
    return back(reply, s, `${BASE}/workspaces/${id}`);
  });

  // (091) the workspace message and environment banner
  app.post(`${BASE}/workspaces/:id(^\\d{1,9}$)/service`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await workspaceAdminOnly(s, reply, req.params.id))) return;
    const message = String(req.body?.message ?? '').replace(/\r\n/g, '\n').trim();
    const label = String(req.body?.banner_label ?? '').trim();
    const color = BANNER_COLORS.includes(String(req.body?.banner_color)) ? String(req.body?.banner_color) : 'blue';
    try {
      if (message.length > 2000) throw new Error(tr(s)('wsp.err.message'));
      if (label && !/^\S(.{0,38}\S)?$/.test(label)) throw new Error(tr(s)('wsp.err.banner'));
      const r = await owner.query('update meta.workspace set message = $2, banner_label = $3, banner_color = $4 where id = $1', [req.params.id, message || null, label || null, color]);
      if (!r.rowCount) return reply.code(404).send('Not found');
      await logActivity({ appId: null, username: s.username, event: 'workspace', ip: clientIp(req), detail: `workspace ${req.params.id}: message and banner` });
      flash(s, tr(s)('wsp.service_saved'));
    } catch (e) {
      flash(s, (e as Error).message, 'error');
    }
    return back(reply, s, `${BASE}/workspaces/${req.params.id}`);
  });

  // (093) workspace preferences
  app.post(`${BASE}/workspaces/:id(^\\d{1,9}$)/preferences`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await workspaceAdminOnly(s, reply, req.params.id))) return;
    const sql = req.body?.sql_workshop === 'true';
    const rest = req.body?.rest_services === 'true';
    // (119) what /builder opens: the App Builder (null) or the Workspace home
    const home = req.body?.builder_home === 'home' ? 'home' : null;
    const r = await owner.query('update meta.workspace set sql_workshop = $2, rest_services = $3, builder_home = $4 where id = $1', [req.params.id, sql, rest, home]);
    if (!r.rowCount) return reply.code(404).send('Not found');
    await logActivity({ appId: null, username: s.username, event: 'workspace', ip: clientIp(req), detail: `workspace ${req.params.id}: SQL Workshop ${sql ? 'on' : 'off'}, RESTful services ${rest ? 'on' : 'off'}, /builder opens ${home ?? 'apps'}` });
    flash(s, tr(s)('wsp.prefs_saved'));
    return back(reply, s, `${BASE}/workspaces/${req.params.id}`);
  });

  // (093) extension links
  app.post(`${BASE}/workspaces/:id(^\\d{1,9}$)/links`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await workspaceAdminOnly(s, reply, req.params.id))) return;
    const label = String(req.body?.label ?? '').trim();
    const url = String(req.body?.url ?? '').trim();
    const description = String(req.body?.description ?? '').trim();
    const position = Number(req.body?.position || 0);
    try {
      if (!LINK_LABEL.test(label)) throw new Error(tr(s)('wsp.err.label'));
      if (!LINK_URL.test(url) || url.length > 2000 || !URL.canParse(url)) throw new Error(tr(s)('wsp.err.url'));
      if (description.length > 500) throw new Error(tr(s)('wsp.err.description'));
      if (!Number.isInteger(position) || Math.abs(position) > 100000) throw new Error(tr(s)('wsp.err.order'));
      await owner.query('insert into meta.workspace_link (workspace_id, label, url, description, position) values ($1, $2, $3, $4, $5)', [req.params.id, label, url, description || null, position]);
      await logActivity({ appId: null, username: s.username, event: 'workspace', ip: clientIp(req), detail: `workspace ${req.params.id}: extension link ${label}` });
      flash(s, tr(s)('wsp.link_added', { label }));
    } catch (e) {
      const err = e as { code?: string; message: string };
      flash(s, err.code === '23505' ? tr(s)('wsp.link_exists', { label }) : err.code === '23503' ? tr(s)('wsp.not_found') : err.code ? tr(s)('wsp.link_not_saved') : err.message, 'error');
    }
    return back(reply, s, `${BASE}/workspaces/${req.params.id}#links`);
  });

  app.post(`${BASE}/workspaces/:id(^\\d{1,9}$)/links/:lid(^\\d{1,9}$)/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await workspaceAdminOnly(s, reply, req.params.id))) return;
    const r = await owner.query('delete from meta.workspace_link where id = $2 and workspace_id = $1', [req.params.id, req.params.lid]);
    flash(s, tr(s)(r.rowCount ? 'wsp.link_deleted' : 'wsp.not_found'), r.rowCount ? 'ok' : 'error');
    return back(reply, s, `${BASE}/workspaces/${req.params.id}#links`);
  });

  // (091) workspace utilization: its applications, their size and use, its schemas' storage
  app.get(`${BASE}/workspaces/:id(^\\d{1,9}$)/utilization`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await workspaceAdminOnly(s, reply, req.params.id))) return;
    const tx = tr(s);
    const w = await owner.one<{ id: number; name: string }>('select id, name from meta.workspace where id = $1', [req.params.id]);
    if (!w) return reply.code(404).send('Not found');
    const [apps, schemas, totals] = await Promise.all([
      owner.query(
        `select a.id, a.name, a.alias, a.db_role,
                (select count(*) from meta.page p where p.app_id = a.id)::int as pages,
                (select count(*) from meta.region r join meta.page p on p.id = r.page_id where p.app_id = a.id)::int as regions,
                (select count(*) from meta.item i join meta.page p on p.id = i.page_id where p.app_id = a.id)::int as items,
                (select count(*) from meta.activity_log l where l.app_id = a.id and l.event = 'page_view' and l.at > now() - interval '30 days')::int as views,
                (select count(distinct l.username) from meta.activity_log l where l.app_id = a.id and l.event = 'page_view' and l.at > now() - interval '30 days')::int as users,
                (select coalesce(sum(octet_length(f.content)), 0) from meta.static_file f where f.app_id = a.id)::bigint as files
           from meta.app a where meta.app_workspace(a.id) = $1 order by lower(a.name)`,
        [w.id],
      ),
      owner.query(
        `select n.nspname as schema, n.nspowner::regrole::text as owner, count(c.oid)::int as tables,
                coalesce(sum(pg_total_relation_size(c.oid)), 0)::bigint as bytes
           from pg_namespace n left join pg_class c on c.relnamespace = n.oid and c.relkind in ('r', 'p', 'm')
          where n.nspname !~ '^pg_' and n.nspname not in ('information_schema', 'meta')
            and exists (select 1 from (select db_role as r from meta.app where meta.app_workspace(id) = $1 and db_role is not null
                                       union select role_name from meta.workspace_role where workspace_id = $1) x
                         join pg_roles rl on rl.rolname = x.r
                        where has_schema_privilege(rl.oid, n.oid, 'USAGE'))
          group by 1, 2 order by 1`,
        [w.id],
      ),
      owner.one(
        `select (select count(*) from meta.workspace_member where workspace_id = $1)::int as developers,
                (select count(*) from meta.sql_script where workspace_id = $1)::int as scripts`,
        [w.id],
      ),
    ]);
    const size = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);
    const sum = (k: string) => apps.rows.reduce((t, r) => t + Number(r[k]), 0);
    const main = html`<div class="title-row"><h1>${tx('wsp.util_title', { name: w.name })}</h1></div>
      <div class="stat-grid u-mb1">
        ${[[tx('wsp.applications'), apps.rows.length], [tx('wsp.pages'), sum('pages')], [tx('wsp.developers'), totals.developers], [tx('wsp.views30'), sum('views')], [tx('wsp.scripts'), totals.scripts]]
          .map(([l, v]) => html`<div class="stat"><b>${String(v)}</b><span>${l}</span></div>`)}
      </div>
      ${region(tx('wsp.applications'), html`<div class="table-wrap"><table class="report report-reflow">
        <thead><tr><th>${tx('wsp.application')}</th><th class="num">${tx('wsp.pages')}</th><th class="num">${tx('wsp.regions')}</th><th class="num">${tx('wsp.items')}</th><th class="num">${tx('wsp.views30')}</th><th class="num">${tx('wsp.users30')}</th><th class="num">${tx('wsp.static')}</th></tr></thead>
        <tbody>${apps.rows.length ? apps.rows.map((a) => html`<tr><td data-label="${tx('wsp.application')}"><a href="${BASE}/apps/${a.id}">${a.name}</a> <span class="muted">/a/${a.alias}</span></td>
          <td class="num" data-label="${tx('wsp.pages')}">${a.pages}</td><td class="num" data-label="${tx('wsp.regions')}">${a.regions}</td><td class="num" data-label="${tx('wsp.items')}">${a.items}</td>
          <td class="num" data-label="${tx('wsp.views')}">${a.views}</td><td class="num" data-label="${tx('wsp.users')}">${a.users}</td><td class="num" data-label="${tx('wsp.static')}">${size(Number(a.files))}</td></tr>`)
          : html`<tr><td colspan="7" class="empty">${tx('wsp.no_apps')}</td></tr>`}</tbody></table></div>`)}
      <div class="u-spacer"></div>
      ${region(tx('wsp.schemas'), html`<p class="muted u-mt0">${tx('wsp.schemas_help')}</p>
        <div class="table-wrap"><table class="report report-reflow">
        <thead><tr><th>${tx('wsp.schema')}</th><th>${tx('wsp.owner')}</th><th class="num">${tx('wsp.tables')}</th><th class="num">${tx('wsp.storage')}</th></tr></thead>
        <tbody>${schemas.rows.length ? schemas.rows.map((r) => html`<tr><td data-label="${tx('wsp.schema')}">${r.schema}</td><td data-label="${tx('wsp.owner')}"><code>${r.owner}</code></td>
          <td class="num" data-label="${tx('wsp.tables')}">${r.tables}</td><td class="num" data-label="${tx('wsp.storage')}">${size(Number(r.bytes))}</td></tr>`)
          : html`<tr><td colspan="4" class="empty">${tx('wsp.no_schemas')}</td></tr>`}</tbody></table></div>`)}`;
    return send(reply, s, shell(s, tx('wsp.util_crumb', { name: w.name }), [['App Builder', BASE], ['Workspace utilities', `${BASE}/utilities`], [w.name, `${BASE}/workspaces/${w.id}`], [tx('wsp.utilization')]], main));
  });
}
