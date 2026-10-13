import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html } from '../html.ts';
import { icon } from '../icons.ts';
import { clientIp, logActivity } from '../session.ts';
import { back, BASE, csrf, developer, flash, input, region, send, shell, type Req } from './ui.ts';
import { currentWorkspace } from './workspaces.ts';

// Workspace utilities → Manage backups (APEX: Workspace Utilities → Manage
// Backups): the backups (082) of every application of the current workspace on
// one page, and a backup of all of them at once. Downloading, restoring and
// deleting a backup stay on the application's own Backups page.

const when = (d: string | Date | null) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '');
const size = (n: number) => (n < 1024 * 1024 ? `${Math.max(n ? 1 : 0, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export async function workspaceBackupRoutes(app: FastifyInstance) {
  app.get(`${BASE}/backups`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const rows = (await owner.query(
      `select a.id, a.name, a.alias, a.backups_keep, a.updated_at,
              count(b.id)::int as backups, coalesce(sum(b.size), 0)::bigint as bytes, max(b.created_at) as newest,
              (max(b.created_at) is null or a.updated_at > max(b.created_at)) as changed
         from meta.app a left join meta.app_backup b on b.app_id = a.id
        where meta.app_workspace(a.id) = $1
        group by a.id order by lower(a.name), a.id`, [currentWorkspace(s)])).rows;
    const total = rows.reduce((t, r) => t + Number(r.bytes), 0);
    const main = html`<div class="title-row"><h1>Manage backups</h1></div>
      <p class="muted u-mt0">The backups of the applications of ${s.workspace?.name ?? 'this workspace'}: one before every import that replaces an application, a merge or a restore, one a day when it changed, and the ones made by hand. Open an application's backups to download, restore or delete one.</p>
      <div class="stat-grid u-mb1">
        ${[['Applications', rows.length], ['Backups', rows.reduce((t, r) => t + r.backups, 0)], ['Storage', size(total)], ['Changed since their newest backup', rows.filter((r) => r.changed && r.backups_keep > 0).length]]
          .map(([l, v]) => html`<div class="stat"><b>${String(v)}</b><span>${l}</span></div>`)}
      </div>
      ${region('Applications', html`<div class="table-wrap"><table class="report report-reflow">
        <thead><tr><th>Application</th><th class="num">Backups</th><th class="num">Kept</th><th>Newest (UTC)</th><th class="num">Size</th><th></th></tr></thead>
        <tbody>${rows.length ? rows.map((a) => html`<tr>
          <td data-label="Application"><a href="${BASE}/apps/${a.id}">${a.name}</a> <span class="muted">/a/${a.alias}</span></td>
          <td class="num" data-label="Backups">${a.backups}</td>
          <td class="num" data-label="Kept">${a.backups_keep === 0 ? html`<span class="tag">none</span>` : a.backups_keep}</td>
          <td data-label="Newest">${a.newest ? when(a.newest) : html`<span class="muted">never</span>`}${a.changed && a.backups_keep > 0 && a.newest ? html` <span class="tag">changed since</span>` : ''}</td>
          <td class="num" data-label="Size">${size(Number(a.bytes))}</td>
          <td><a class="btn btn-sm" href="${BASE}/apps/${a.id}/backups">${icon('history')} Backups</a></td></tr>`)
          : html`<tr><td colspan="6" class="empty">No applications.</td></tr>`}</tbody></table></div>`)}
      ${rows.length ? region('Back up all applications', html`<form method="post" action="${BASE}/backups">${csrf(s)}
        <p class="muted u-mt0">Makes a backup of every application of this workspace that keeps backups.</p>
        <div class="form-grid">${input('note', 'Note', '', { placeholder: 'e.g. before the upgrade' })}
          <div class="field"><label class="check"><input type="checkbox" name="changed" value="true" checked> Only applications changed since their newest backup</label></div></div>
        <div class="buttons"><button class="btn btn-hot">${icon('save')} Back up now</button></div></form>`) : ''}`;
    return send(reply, s, shell(s, 'Manage backups', [['App Builder', BASE], ['Workspace utilities', `${BASE}/utilities`], ['Manage backups']], main));
  });

  app.post(`${BASE}/backups`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const note = String(req.body?.note ?? '').trim().slice(0, 500) || null;
    const onlyChanged = req.body?.changed === 'true';
    const apps = (await owner.query<{ id: number }>(
      `select a.id from meta.app a
        where meta.app_workspace(a.id) = $1 and a.backups_keep > 0
          and (not $2 or not exists (select 1 from meta.app_backup b where b.app_id = a.id and b.created_at >= a.updated_at))
        order by a.id`, [currentWorkspace(s), onlyChanged])).rows;
    let made = 0;
    const failed: number[] = [];
    for (const a of apps) {
      try {
        if ((await owner.one(`select meta.backup_app($1, 'manual', $2, $3) as id`, [a.id, s.username, note])).id) made++;
      } catch (e) {
        failed.push(a.id);
        console.error(`backup of application ${a.id}:`, (e as Error).message);
      }
    }
    await logActivity({ appId: null, username: s.username, event: 'backup', ip: clientIp(req), detail: `workspace ${currentWorkspace(s)}: ${made} backup(s)` });
    if (failed.length) flash(s, `${made} backup(s) made; not backed up: application${failed.length > 1 ? 's' : ''} ${failed.join(', ')}.`, 'error');
    else flash(s, made ? `${made} backup${made > 1 ? 's' : ''} made.` : 'Nothing to back up: every application is unchanged since its newest backup, or keeps none.');
    return back(reply, s, `${BASE}/backups`);
  });
}
