import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html } from '../html.ts';
import { icon } from '../icons.ts';
import { clientIp, logActivity } from '../session.ts';
import { back, BASE, csrf, developer, flash, input, region, send, shell, type Req } from './ui.ts';
import { currentWorkspace } from './workspaces.ts';
import { scopedTx as tx } from './i18n.ts';

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
    const main = html`<div class="title-row"><h1>${tx('wu.backups')}</h1></div>
      <p class="muted u-mt0">${s.workspace?.name ? tx('wbk.intro', { name: s.workspace.name }) : tx('wbk.intro_this')}</p>
      <div class="stat-grid u-mb1">
        ${[[tx('wbk.applications'), rows.length], [tx('wbk.backups'), rows.reduce((t, r) => t + r.backups, 0)], [tx('wbk.storage'), size(total)], [tx('wbk.changed_since_newest'), rows.filter((r) => r.changed && r.backups_keep > 0).length]]
          .map(([l, v]) => html`<div class="stat"><b>${String(v)}</b><span>${l}</span></div>`)}
      </div>
      ${region(tx('wbk.applications'), html`<div class="table-wrap"><table class="report report-reflow">
        <thead><tr><th>${tx('wbk.application')}</th><th class="num">${tx('wbk.backups')}</th><th class="num">${tx('wbk.kept')}</th><th>${tx('wbk.newest_utc')}</th><th class="num">${tx('wbk.size')}</th><th></th></tr></thead>
        <tbody>${rows.length ? rows.map((a) => html`<tr>
          <td data-label="${tx('wbk.application')}"><a href="${BASE}/apps/${a.id}">${a.name}</a> <span class="muted">/a/${a.alias}</span></td>
          <td class="num" data-label="${tx('wbk.backups')}">${a.backups}</td>
          <td class="num" data-label="${tx('wbk.kept')}">${a.backups_keep === 0 ? html`<span class="tag">${tx('wbk.none')}</span>` : a.backups_keep}</td>
          <td data-label="${tx('wbk.newest')}">${a.newest ? when(a.newest) : html`<span class="muted">${tx('wbk.never')}</span>`}${a.changed && a.backups_keep > 0 && a.newest ? html` <span class="tag">${tx('wbk.changed_since')}</span>` : ''}</td>
          <td class="num" data-label="${tx('wbk.size')}">${size(Number(a.bytes))}</td>
          <td><a class="btn btn-sm" href="${BASE}/apps/${a.id}/backups">${icon('history')} ${tx('wbk.backups')}</a></td></tr>`)
          : html`<tr><td colspan="6" class="empty">${tx('wbk.no_apps')}</td></tr>`}</tbody></table></div>`)}
      ${rows.length ? region(tx('wbk.back_up_all'), html`<form method="post" action="${BASE}/backups">${csrf(s)}
        <p class="muted u-mt0">${tx('wbk.back_up_all_text')}</p>
        <div class="form-grid">${input('note', tx('wbk.note'), '', { placeholder: tx('wbk.note_placeholder') })}
          <div class="field"><label class="check"><input type="checkbox" name="changed" value="true" checked> ${tx('wbk.only_changed')}</label></div></div>
        <div class="buttons"><button class="btn btn-hot">${icon('save')} ${tx('wbk.back_up_now')}</button></div></form>`) : ''}`;
    return send(reply, s, shell(s, tx('wu.backups'), [[tx('rail.app_builder'), BASE], [tx('wu.title'), `${BASE}/utilities`], [tx('wu.backups')]], main));
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
    if (failed.length) flash(s, tx(failed.length > 1 ? 'wbk.failed_many' : 'wbk.failed_one', { n: made, ids: failed.join(', ') }), 'error');
    else flash(s, made ? tx(made > 1 ? 'wbk.made_many' : 'wbk.made_one', { n: made }) : tx('wbk.nothing'));
    return back(reply, s, `${BASE}/backups`);
  });
}
