import type { FastifyInstance, FastifyReply } from 'fastify';
import { owner } from '../db.ts';
import { html, raw } from '../html.ts';
import { icon } from '../icons.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import { isAdmin } from './locks.ts';
import { back, BASE, csrf, developer, flash, input, region, send, shell, type Req } from './ui.ts';

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

export interface WorkspaceRef {
  id: number;
  name: string;
}

/** Workspace 1: applications without a meta.workspace_app row belong to it. */
export const DEFAULT_WORKSPACE = 1;

/** The workspaces a developer may use (administrators: all), and the current one, on the session object. */
export async function loadWorkspaces(s: Session) {
  const rows = (
    await owner.query<WorkspaceRef>(
      `select w.id, w.name from meta.workspace w
        where exists (select 1 from meta.developer d where d.username = $1 and d.is_admin)
           or exists (select 1 from meta.workspace_member m where m.workspace_id = w.id and m.username = $1)
        order by w.id = 1 desc, lower(w.name)`,
      [s.username],
    )
  ).rows;
  s.workspaces = rows;
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
  return html`<div class="menu-section"><span class="small muted" id="ws-label">Workspace</span>
    <form method="post" action="${BASE}/workspace" class="ws-switch" aria-labelledby="ws-label">${csrf(s)}
      ${list.map((w) => html`<button name="workspace" value="${w.id}" aria-pressed="${s.workspace?.id === w.id ? 'true' : 'false'}">${icon('layers')}<span>${w.name}</span></button>`)}
    </form></div>`;
}

const NAME = /^\S(.{0,58}\S)?$/;

async function adminOnly(s: Session, reply: FastifyReply) {
  if (await isAdmin(s.username)) return true;
  const main = html`<h1 class="u-mb1">Workspaces</h1><div class="alert alert-error" role="alert">Only administrators manage workspaces.</div>`;
  await send(reply.code(403), s, shell(s, 'Workspaces', [['App Builder', BASE], ['Workspace utilities', `${BASE}/utilities`], ['Workspaces']], main));
  return false;
}

const crumbs = (extra: [string, string?][] = []): [string, string?][] => [['App Builder', BASE], ['Workspace utilities', `${BASE}/utilities`], ['Workspaces', `${BASE}/workspaces`], ...extra];

const nameError = (e: unknown) => {
  const m = (e as Error).message;
  if (m.includes('workspace_name_key')) return 'A workspace with this name exists already.';
  if (m.includes('workspace_name_check')) return 'The name is 1 to 60 characters, without spaces at the start or end.';
  return m;
};

export async function workspaceRoutes(app: FastifyInstance) {
  // switch the current workspace (any of the developer's own)
  app.post(`${BASE}/workspace`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const w = s.workspaces?.find((x) => String(x.id) === req.body?.workspace);
    if (!w) return reply.code(404).send('Not found');
    s.state.__WS = String(w.id);
    flash(s, `Workspace ${w.name}.`);
    return back(reply, s, BASE);
  });

  app.get(`${BASE}/workspaces`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply))) return;
    const rows = (
      await owner.query(
        `select w.id, w.name, w.description,
                (select count(*) from meta.app a where meta.app_workspace(a.id) = w.id)::int as apps,
                (select string_agg(m.username, ', ' order by m.username) from meta.workspace_member m where m.workspace_id = w.id) as members
           from meta.workspace w order by w.id = 1 desc, lower(w.name)`,
      )
    ).rows;
    const main = html`
      <div class="title-row"><h1>Workspaces</h1></div>
      <p class="muted u-mt0">A workspace groups applications and the developers who build them. Developers see and change the applications of their own workspaces; administrators see all of them. Workspaces are not a security boundary between developers who write SQL: the SQL Workshop and application code run with this installation's rights. Give tenants who must not see each other separate installations.</p>
      <div class="columns wide-left">
        ${region('Workspaces', html`<div class="table-wrap"><table class="report report-reflow">
          <thead><tr><th>Workspace</th><th class="num">Applications</th><th>Developers</th></tr></thead>
          <tbody>${rows.map((w) => html`<tr>
            <td data-label="Workspace"><a href="${BASE}/workspaces/${w.id}">${w.name}</a>${w.description ? html` <span class="muted">${w.description}</span>` : ''}</td>
            <td class="num" data-label="Applications">${w.apps}</td>
            <td data-label="Developers">${w.members ?? html`<span class="muted">administrators only</span>`}</td></tr>`)}</tbody></table></div>`)}
        ${region('Add workspace', html`<form method="post" action="${BASE}/workspaces">${csrf(s)}
          ${input('name', 'Name', '', { required: true, help: 'For example the team or department that builds its applications here.' })}
          ${input('description', 'Description', '')}
          <p class="muted small">You become its first developer; add others on its page.</p>
          <div class="buttons"><button class="btn btn-hot">${icon('plus')} Add workspace</button></div></form>`)}
      </div>`;
    return send(reply, s, shell(s, 'Workspaces', [['App Builder', BASE], ['Workspace utilities', `${BASE}/utilities`], ['Workspaces']], main));
  });

  app.post(`${BASE}/workspaces`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply))) return;
    const name = String(req.body?.name ?? '').trim();
    if (!NAME.test(name)) {
      flash(s, 'The name is 1 to 60 characters.', 'error');
      return back(reply, s, `${BASE}/workspaces`);
    }
    try {
      const id = await owner.tx(async (c) => {
        const w = (await c.query('insert into meta.workspace (name, description) values ($1, $2) returning id', [name, String(req.body?.description ?? '').trim() || null])).rows[0].id as number;
        await c.query('insert into meta.workspace_member (workspace_id, username) values ($1, $2)', [w, s.username]);
        return w;
      });
      await logActivity({ appId: null, username: s.username, event: 'workspace', ip: clientIp(req), detail: `created workspace ${name}` });
      flash(s, `Workspace ${name} added.`);
      return back(reply, s, `${BASE}/workspaces/${id}`);
    } catch (e) {
      flash(s, nameError(e), 'error');
      return back(reply, s, `${BASE}/workspaces`);
    }
  });

  app.get(`${BASE}/workspaces/:id(^\\d{1,9}$)`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply))) return;
    const w = await owner.one('select * from meta.workspace where id = $1', [req.params.id]);
    if (!w) return reply.code(404).send('Not found');
    const [devs, apps, others] = await Promise.all([
      owner.query(
        `select d.username, d.is_admin, m.username is not null as member
           from meta.developer d left join meta.workspace_member m on m.username = d.username and m.workspace_id = $1 order by d.username`,
        [w.id],
      ),
      owner.query(`select a.id, a.name, a.alias from meta.app a where meta.app_workspace(a.id) = $1 order by lower(a.name), a.id`, [w.id]),
      owner.query('select id, name from meta.workspace where id <> $1 order by id = 1 desc, lower(name)', [w.id]),
    ]);
    const main = html`
      <div class="title-row"><h1>${w.name}</h1></div>
      <div class="columns wide-left">
        ${region('Settings', html`<form method="post" action="${BASE}/workspaces/${w.id}">${csrf(s)}
            ${input('name', 'Name', w.name, { required: true })}
            ${input('description', 'Description', w.description ?? '')}
            <div class="buttons"><button class="btn btn-hot">Save</button></div></form>
          ${w.id === 1
            ? html`<p class="muted small">The Default workspace can't be deleted: imported applications and applications made with the command line start here.</p>`
            : html`<form method="post" action="${BASE}/workspaces/${w.id}/delete" class="danger-zone">${csrf(s)}
                <button class="btn btn-danger" data-confirm="Delete workspace ${w.name}?"${apps.rows.length ? raw(' disabled') : ''}>Delete workspace</button>
                ${apps.rows.length ? html`<p class="muted small">Move its applications to another workspace first.</p>` : ''}</form>`}`)}
        ${region('Developers', html`<p class="muted u-mt0">Developers of this workspace see and change its applications. Administrators see every workspace.</p>
          <form method="post" action="${BASE}/workspaces/${w.id}/members">${csrf(s)}
            <fieldset class="field"><legend class="sr-only">Developers</legend><div class="radio-group">
            ${devs.rows.map((d) => html`<label class="check"><input type="checkbox" name="member" value="${d.username}"${d.member ? raw(' checked') : ''}> ${d.username}${d.is_admin ? html` <span class="muted">(administrator)</span>` : ''}</label>`)}
            </div></fieldset>
            <div class="buttons"><button class="btn">Save developers</button></div></form>`)}
      </div>
      ${region('Applications', html`<div class="table-wrap"><table class="report report-reflow">
        <thead><tr><th>Application</th><th>Move to</th></tr></thead>
        <tbody>${apps.rows.length
          ? apps.rows.map((a) => html`<tr><td data-label="Application"><a href="${BASE}/apps/${a.id}">${a.name}</a> <span class="muted">${a.id} · /a/${a.alias}</span></td>
              <td data-label="Move to">${others.rows.length
                ? html`<form method="post" action="${BASE}/workspaces/${w.id}/move" class="search u-mwnone">${csrf(s)}<input type="hidden" name="app" value="${a.id}">
                    <label class="sr-only" for="move-${a.id}">Move ${a.name} to</label>
                    <select id="move-${a.id}" name="to">${others.rows.map((o) => html`<option value="${o.id}">${o.name}</option>`)}</select>
                    <button class="btn">Move</button></form>`
                : html`<span class="muted">no other workspace</span>`}</td></tr>`)
          : html`<tr><td colspan="2" class="empty">No applications.</td></tr>`}</tbody></table></div>`)}`;
    return send(reply, s, shell(s, w.name, crumbs([[w.name]]), main));
  });

  app.post(`${BASE}/workspaces/:id(^\\d{1,9}$)`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply))) return;
    const name = String(req.body?.name ?? '').trim();
    try {
      if (!NAME.test(name)) throw new Error('The name is 1 to 60 characters.');
      const r = await owner.query('update meta.workspace set name = $2, description = $3 where id = $1', [req.params.id, name, String(req.body?.description ?? '').trim() || null]);
      flash(s, r.rowCount ? 'Workspace saved.' : 'Not found.', r.rowCount ? 'ok' : 'error');
    } catch (e) {
      flash(s, nameError(e), 'error');
    }
    return back(reply, s, `${BASE}/workspaces/${req.params.id}`);
  });

  app.post(`${BASE}/workspaces/:id(^\\d{1,9}$)/members`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply))) return;
    if (!(await owner.one('select 1 as ok from meta.workspace where id = $1', [req.params.id]))) return reply.code(404).send('Not found');
    const posted = req.body?.member as unknown;
    const names = (Array.isArray(posted) ? posted : posted == null ? [] : [posted]).map(String).slice(0, 10000);
    await owner.tx(async (c) => {
      await c.query('delete from meta.workspace_member where workspace_id = $1', [req.params.id]);
      // only existing developers (unknown names are ignored)
      await c.query(
        `insert into meta.workspace_member (workspace_id, username) select $1, d.username from meta.developer d where d.username = any($2::text[])`,
        [req.params.id, names],
      );
    });
    await logActivity({ appId: null, username: s.username, event: 'workspace', ip: clientIp(req), detail: `developers of workspace ${req.params.id}: ${names.join(', ').slice(0, 1000)}` });
    flash(s, 'Developers saved.');
    return back(reply, s, `${BASE}/workspaces/${req.params.id}`);
  });

  app.post(`${BASE}/workspaces/:id(^\\d{1,9}$)/move`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply))) return;
    const from = Number(req.params.id);
    const appId = /^\d{1,9}$/.test(req.body?.app ?? '') ? Number(req.body!.app) : null;
    const to = (await owner.one<{ id: number; name: string }>('select id, name from meta.workspace where id = $1', [/^\d{1,9}$/.test(req.body?.to ?? '') ? req.body!.to : null]));
    if (appId === null || !to || (await appWorkspace(appId)) !== from) return reply.code(404).send('Not found');
    await placeApp(owner, appId, to.id);
    await logActivity({ appId, username: s.username, event: 'workspace', ip: clientIp(req), detail: `moved from workspace ${from} to ${to.id}` });
    flash(s, `Application moved to ${to.name}.`);
    return back(reply, s, `${BASE}/workspaces/${from}`);
  });

  app.post(`${BASE}/workspaces/:id(^\\d{1,9}$)/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply))) return;
    const id = Number(req.params.id);
    if (id === DEFAULT_WORKSPACE) {
      flash(s, 'The Default workspace cannot be deleted.', 'error');
      return back(reply, s, `${BASE}/workspaces/${id}`);
    }
    if (await owner.one('select 1 as ok from meta.workspace_app where workspace_id = $1 limit 1', [id])) {
      flash(s, 'Move the applications of this workspace to another workspace first.', 'error');
      return back(reply, s, `${BASE}/workspaces/${id}`);
    }
    const r = await owner.one<{ name: string }>('delete from meta.workspace where id = $1 returning name', [id]);
    if (r) await logActivity({ appId: null, username: s.username, event: 'workspace', ip: clientIp(req), detail: `deleted workspace ${r.name}` });
    flash(s, r ? `Workspace ${r.name} deleted.` : 'Not found.', r ? 'ok' : 'error');
    return back(reply, s, `${BASE}/workspaces`);
  });
}
