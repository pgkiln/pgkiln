import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw } from '../html.ts';
import { icon } from '../icons.ts';
import { clientIp, logActivity } from '../session.ts';
import { back, BASE, csrf, developer, flash, input, region, send, shell, type Req } from './ui.ts';
import { currentWorkspace } from './workspaces.ts';

// Application groups (092; APEX: Workspace Utilities → Application Groups): a
// workspace's named groups of applications. The App Builder home filters and
// labels applications by group. Every developer of the workspace manages them.

const NAME = /^\S(.{0,58}\S)?$/;
const crumbs = (extra: [string, string?][] = []): [string, string?][] => [['App Builder', BASE], ['Workspace utilities', `${BASE}/utilities`], ['Application groups', `${BASE}/app-groups`], ...extra];

const groupError = (e: unknown) => {
  const m = (e as Error).message;
  if (m.includes('app_group_workspace_id_name_key')) return 'A group with this name exists already.';
  if (m.includes('app_group_name_check')) return 'The name is 1 to 60 characters, without spaces at the start or end.';
  return m;
};

export async function appGroupRoutes(app: FastifyInstance) {
  app.get(`${BASE}/app-groups`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const ws = currentWorkspace(s);
    const [groups, apps] = await Promise.all([
      owner.query<{ id: number; name: string; description: string | null; apps: number }>(
        `select g.id, g.name, g.description, (select count(*) from meta.app_group_member m where m.group_id = g.id)::int as apps
           from meta.app_group g where g.workspace_id = $1 order by lower(g.name)`,
        [ws],
      ),
      owner.query<{ id: number; name: string; alias: string; group_id: number | null }>(
        `select a.id, a.name, a.alias, m.group_id from meta.app a left join meta.app_group_member m on m.app_id = a.id
          where meta.app_workspace(a.id) = $1 order by lower(a.name), a.id`,
        [ws],
      ),
    ]);
    const main = html`<div class="title-row"><h1>Application groups</h1></div>
      <p class="muted u-mt0">Groups organise the applications of this workspace (${s.workspace?.name ?? ''}) on the App Builder home, which can show one group at a time. They change nothing in the applications.</p>
      <div class="columns wide-left">
        ${region('Groups', groups.rows.length
          ? html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>Group</th><th class="num">Applications</th><th>Rename</th><th></th></tr></thead><tbody>
              ${groups.rows.map((g) => html`<tr>
                <td data-label="Group"><a href="${BASE}?group=${g.id}">${g.name}</a>${g.description ? html`<br><span class="muted small">${g.description}</span>` : ''}</td>
                <td class="num" data-label="Applications">${g.apps}</td>
                <td data-label="Rename"><form method="post" action="${BASE}/app-groups/${g.id}" class="search u-mwnone">${csrf(s)}
                  <label class="sr-only" for="g-${g.id}">New name for ${g.name}</label><input id="g-${g.id}" name="name" value="${g.name}" required maxlength="60">
                  <button class="btn btn-sm">Rename</button></form></td>
                <td><form method="post" action="${BASE}/app-groups/${g.id}/delete">${csrf(s)}<button class="btn btn-sm btn-danger" data-confirm="Delete the group ${g.name}? Its applications stay, without a group.">${icon('trash')}<span class="sr-only">Delete ${g.name}</span></button></form></td></tr>`)}
            </tbody></table></div>`
          : html`<p class="muted">No groups yet.</p>`)}
        ${region('Add a group', html`<form method="post" action="${BASE}/app-groups">${csrf(s)}
          ${input('name', 'Name', '', { required: true, placeholder: 'Finance' })}
          ${input('description', 'Description', '')}
          <div class="buttons"><button class="btn btn-hot">${icon('plus')} Add group</button></div></form>`)}
      </div>
      <div class="u-spacer"></div>
      ${region('Applications', apps.rows.length
        ? html`<form method="post" action="${BASE}/app-groups/assign">${csrf(s)}
            <div class="table-wrap"><table class="report report-reflow"><thead><tr><th>Application</th><th>Group</th></tr></thead><tbody>
            ${apps.rows.map((a) => html`<tr><td data-label="Application"><a href="${BASE}/apps/${a.id}">${a.name}</a> <span class="muted">/a/${a.alias}</span></td>
              <td data-label="Group"><label class="sr-only" for="a-${a.id}">Group of ${a.name}</label>
                <select id="a-${a.id}" name="app_${a.id}"><option value="">(no group)</option>${groups.rows.map((g) => html`<option value="${g.id}"${a.group_id === g.id ? raw(' selected') : ''}>${g.name}</option>`)}</select></td></tr>`)}
            </tbody></table></div>
            <div class="buttons"><button class="btn"${groups.rows.length ? '' : raw(' disabled')}>Save groups</button></div></form>`
        : html`<p class="muted">No applications in this workspace.</p>`)}`;
    return send(reply, s, shell(s, 'Application groups', crumbs(), main));
  });

  app.post(`${BASE}/app-groups`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const name = String(req.body?.name ?? '').trim();
    try {
      if (!NAME.test(name)) throw new Error('The name is 1 to 60 characters, without spaces at the start or end.');
      await owner.query('insert into meta.app_group (workspace_id, name, description) values ($1, $2, $3)', [currentWorkspace(s), name, String(req.body?.description ?? '').trim().slice(0, 2000) || null]);
      await logActivity({ username: s.username, event: 'app_group', ip: clientIp(req), detail: `added ${name}` });
      flash(s, `Group ${name} added.`);
    } catch (e) {
      flash(s, groupError(e), 'error');
    }
    return back(reply, s, `${BASE}/app-groups`);
  });

  app.post(`${BASE}/app-groups/:id(^\\d{1,9}$)`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const name = String(req.body?.name ?? '').trim();
    try {
      if (!NAME.test(name)) throw new Error('The name is 1 to 60 characters, without spaces at the start or end.');
      const r = await owner.query('update meta.app_group set name = $3 where id = $1 and workspace_id = $2', [req.params.id, currentWorkspace(s), name]);
      if (!r.rowCount) return reply.code(404).send('Not found');
      flash(s, `Group renamed to ${name}.`);
    } catch (e) {
      flash(s, groupError(e), 'error');
    }
    return back(reply, s, `${BASE}/app-groups`);
  });

  app.post(`${BASE}/app-groups/:id(^\\d{1,9}$)/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const r = await owner.one<{ name: string }>('delete from meta.app_group where id = $1 and workspace_id = $2 returning name', [req.params.id, currentWorkspace(s)]);
    if (!r) return reply.code(404).send('Not found');
    await logActivity({ username: s.username, event: 'app_group', ip: clientIp(req), detail: `deleted ${r.name}` });
    flash(s, `Group ${r.name} deleted.`);
    return back(reply, s, `${BASE}/app-groups`);
  });

  // the group of each application of the workspace (only this workspace's groups and applications)
  app.post(`${BASE}/app-groups/assign`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const ws = currentWorkspace(s);
    const pairs = Object.entries(req.body ?? {}).flatMap(([k, v]) => {
      const m = /^app_(\d{1,9})$/.exec(k);
      return m ? [[Number(m[1]), /^\d{1,9}$/.test(String(v)) ? Number(v) : null] as [number, number | null]] : [];
    }).slice(0, 5000);
    await owner.tx(async (c) => {
      for (const [appId, groupId] of pairs) {
        if (!(await c.query('select 1 from meta.app where id = $1 and meta.app_workspace(id) = $2', [appId, ws])).rowCount) continue;
        if (groupId === null) await c.query('delete from meta.app_group_member where app_id = $1', [appId]);
        else if ((await c.query('select 1 from meta.app_group where id = $1 and workspace_id = $2', [groupId, ws])).rowCount)
          await c.query('insert into meta.app_group_member (app_id, group_id) values ($1, $2) on conflict (app_id) do update set group_id = excluded.group_id', [appId, groupId]);
      }
    });
    flash(s, 'Groups saved.');
    return back(reply, s, `${BASE}/app-groups`);
  });
}
