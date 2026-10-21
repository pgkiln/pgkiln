import type { FastifyInstance } from 'fastify';
import { replaceApp } from '../cli/replace.ts';
import { owner } from '../db.ts';
import { html } from '../html.ts';
import { icon } from '../icons.ts';
import { clientIp, logActivity } from '../session.ts';
import { appOr404 } from './forms.ts';
import { appHeader, back, BASE, csrf, developer, flash, input, region, send, shell, type Req } from './ui.ts';

// Application → Backups (APEX: Application Backups, migration 082): the
// exports this installation keeps of an application (before every import
// that replaces it, a merge or a restore; daily when it changed; on demand),
// with download, restore and delete. A restore is an import --replace of the
// backup, so the version it replaces is backed up as well. Locks of the
// application are respected (developer() refuses a POST to a locked app).

const REASON: Record<string, string> = {
  import: 'before an import', merge: 'before a working copy merge', restore: 'before a restore', daily: 'daily', manual: 'made by hand',
};
const when = (d: string | Date) => new Date(d).toISOString().slice(0, 16).replace('T', ' ');
const kb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** Back up the applications whose newest backup is older than a day and that changed since (the scheduler). */
export async function backupTick() {
  const due = (await owner.query<{ id: number }>(
    `select a.id from meta.app a
      where a.backups_keep > 0
        and not exists (select 1 from meta.app_backup b where b.app_id = a.id and b.created_at > now() - interval '1 day')`)).rows;
  for (const a of due) await owner.query(`select meta.backup_app($1, 'daily', 'scheduler')`, [a.id]).catch((e) => console.error(`backup of application ${a.id}:`, (e as Error).message));
  return due.length;
}

export async function backupRoutes(app: FastifyInstance) {
  app.get(`${BASE}/apps/:id(^\\d+$)/backups`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOr404(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const rows = (await owner.query(
      'select id, created_at, created_by, reason, note, size from meta.app_backup where app_id = $1 order by created_at desc, id desc', [a.id])).rows;
    const body = html`
      ${region('Backups', html`
        <p class="muted u-mt0">Exports of this application kept by this installation: one before every import that replaces it (also from the
          command line and the MCP server), before a working copy merge and a restore, one a day when it changed, and the ones made here.
          The newest ${a.backups_keep} are kept. Backups are not exported.</p>
        <div class="table-wrap"><table class="report report-reflow"><thead><tr><th>Made (UTC)</th><th>Why</th><th>By</th><th>Note</th><th class="num">Size</th><th>Actions</th></tr></thead><tbody>
        ${rows.length ? rows.map((b) => html`<tr>
          <td data-label="Made">${when(b.created_at)}</td>
          <td data-label="Why">${REASON[b.reason] ?? b.reason}</td>
          <td data-label="By">${b.created_by ?? ''}</td>
          <td data-label="Note" class="u-break">${b.note ?? ''}</td>
          <td class="num" data-label="Size">${kb(b.size)}</td>
          <td data-label="Actions"><div class="buttons">
            <a class="btn btn-sm" href="${BASE}/apps/${a.id}/backups/${b.id}/download">${icon('download')} Download</a>
            <form method="post" action="${BASE}/apps/${a.id}/backups/${b.id}/restore" class="u-inline">${csrf(s)}
              <button class="btn btn-sm" data-confirm="Restore the application as it was on ${when(b.created_at)}? Its pages, shared components and settings become those of the backup; the current version is backed up first.">${icon('history')} Restore</button></form>
            <form method="post" action="${BASE}/apps/${a.id}/backups/${b.id}/delete" class="u-inline">${csrf(s)}
              <button class="btn btn-sm btn-danger" data-confirm="Delete this backup?">Delete</button></form>
          </div></td></tr>`)
          : html`<tr><td colspan="6" class="empty">No backups yet.</td></tr>`}</tbody></table></div>`)}
      <div class="columns">
        ${region('Back up now', html`<form method="post" action="${BASE}/apps/${a.id}/backups">${csrf(s)}
          <div class="form-grid">${input('note', 'Note', '', { placeholder: 'e.g. before the new dashboard' })}</div>
          <div class="buttons"><button class="btn btn-hot">${icon('save')} Back up now</button></div></form>`)}
        ${region('Keep', html`<form method="post" action="${BASE}/apps/${a.id}/backups/settings">${csrf(s)}
          <div class="form-grid">${input('keep', 'Backups to keep', a.backups_keep, { type: 'number', help: '0 to 500; 0 makes no backups at all (also not before an import).' })}</div>
          <div class="buttons"><button class="btn">Save</button></div></form>`)}
      </div>`;
    const main = html`${appHeader(a, 'pages', s)}<div class="ide-body">${body}</div>`;
    return send(reply, s, shell(s, `${a.name} backups`, [['App Builder', BASE], [a.name, `${BASE}/apps/${a.id}`], ['Backups']], main));
  });

  app.post(`${BASE}/apps/:id(^\\d+$)/backups`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOr404(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const r = await owner.one(`select meta.backup_app($1, 'manual', $2, $3) as id`, [a.id, s.username, String(req.body?.note ?? '').trim().slice(0, 500) || null]);
    flash(s, r.id ? 'Backup made.' : 'No backup made: this application keeps none (set "Backups to keep").', r.id ? 'ok' : 'error');
    return back(reply, s, `${BASE}/apps/${a.id}/backups`);
  });

  app.post(`${BASE}/apps/:id(^\\d+$)/backups/settings`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const keep = Number(req.body?.keep);
    if (!Number.isInteger(keep) || keep < 0 || keep > 500) flash(s, 'Backups to keep: a whole number from 0 to 500.', 'error');
    else {
      await owner.query('update meta.app set backups_keep = $2, updated_at = now() where id = $1', [req.params.id, keep]);
      // fewer to keep: the oldest go now
      await owner.query(`delete from meta.app_backup where app_id = $1 and id not in (select id from meta.app_backup where app_id = $1 order by created_at desc, id desc limit $2)`, [req.params.id, keep]);
      flash(s, 'Saved.');
    }
    return back(reply, s, `${BASE}/apps/${req.params.id}/backups`);
  });

  app.get(`${BASE}/apps/:id(^\\d+$)/backups/:bid(^\\d+$)/download`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = await owner.one(`select b.doc, b.created_at, a.alias from meta.app_backup b join meta.app a on a.id = b.app_id where b.id = $1 and b.app_id = $2`, [req.params.bid, req.params.id]);
    if (!b) return reply.code(404).send('Not found');
    const name = `${b.alias}-${new Date(b.created_at).toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')}.json`;
    return reply.header('content-disposition', `attachment; filename="${name.replace(/[^\w.-]/g, '_')}"`).header('cache-control', 'private, no-store')
      .type('application/json').send(JSON.stringify(b.doc, null, 2));
  });

  app.post(`${BASE}/apps/:id(^\\d+$)/backups/:bid(^\\d+$)/restore`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOr404(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    try {
      const at = await owner.tx(async (c) => {
        const b = (await c.query('select doc, created_at from meta.app_backup where id = $1 and app_id = $2', [req.params.bid, a.id])).rows[0];
        if (!b) throw new Error('Backup not found.');
        await replaceApp(c, b.doc, a.alias, { backup: { reason: 'restore', user: s.username, note: `before restoring the backup of ${when(b.created_at)}` } });
        return when(b.created_at);
      });
      await logActivity({ appId: a.id, username: s.username, event: 'backup_restored', ip: clientIp(req), detail: `backup ${req.params.bid} of ${at}` });
      flash(s, `Restored the application as it was on ${at}. The version it replaced is the newest backup.`);
    } catch (e) {
      flash(s, `Restore failed: ${(e as Error).message}`, 'error');
    }
    return back(reply, s, `${BASE}/apps/${a.id}/backups`);
  });

  app.post(`${BASE}/apps/:id(^\\d+$)/backups/:bid(^\\d+$)/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const r = await owner.query('delete from meta.app_backup where id = $1 and app_id = $2', [req.params.bid, req.params.id]);
    flash(s, r.rowCount ? 'Backup deleted.' : 'Not found.', r.rowCount ? 'ok' : 'error');
    return back(reply, s, `${BASE}/apps/${req.params.id}/backups`);
  });
}
