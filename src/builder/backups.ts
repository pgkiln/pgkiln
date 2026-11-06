import type { FastifyInstance } from 'fastify';
import { replaceApp } from '../cli/replace.ts';
import { owner } from '../db.ts';
import { html } from '../html.ts';
import { icon } from '../icons.ts';
import { clientIp, logActivity } from '../session.ts';
import { appOr404 } from './forms.ts';
import { appHeader, back, BASE, csrf, developer, flash, input, region, send, shell, type Req } from './ui.ts';
import { scopedTx as tx, type BuilderKey } from './i18n.ts';

// Application → Backups (APEX: Application Backups, migration 082): the
// exports this installation keeps of an application (before every import
// that replaces it, a merge or a restore; daily when it changed; on demand),
// with download, restore and delete. A restore is an import --replace of the
// backup, so the version it replaces is backed up as well. Locks of the
// application are respected (developer() refuses a POST to a locked app).

const REASON: Record<string, BuilderKey> = {
  import: 'bkp.reason.import', merge: 'bkp.reason.merge', restore: 'bkp.reason.restore', daily: 'bkp.reason.daily', manual: 'bkp.reason.manual',
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
      ${region(tx('app.head.backups'), html`
        <p class="muted u-mt0">${tx('bkp.intro', { n: a.backups_keep })}</p>
        <div class="table-wrap"><table class="report report-reflow"><thead><tr><th>${tx('bkp.made_utc')}</th><th>${tx('bkp.why')}</th><th>${tx('bkp.by')}</th><th>${tx('bkp.note')}</th><th class="num">${tx('bkp.size')}</th><th>${tx('bkp.actions')}</th></tr></thead><tbody>
        ${rows.length ? rows.map((b) => html`<tr>
          <td data-label="${tx('bkp.made')}">${when(b.created_at)}</td>
          <td data-label="${tx('bkp.why')}">${REASON[b.reason] ? tx(REASON[b.reason]) : b.reason}</td>
          <td data-label="${tx('bkp.by')}">${b.created_by ?? ''}</td>
          <td data-label="${tx('bkp.note')}" class="u-break">${b.note ?? ''}</td>
          <td class="num" data-label="${tx('bkp.size')}">${kb(b.size)}</td>
          <td data-label="${tx('bkp.actions')}"><div class="buttons">
            <a class="btn btn-sm" href="${BASE}/apps/${a.id}/backups/${b.id}/download">${icon('download')} ${tx('bkp.download')}</a>
            <form method="post" action="${BASE}/apps/${a.id}/backups/${b.id}/restore" class="u-inline">${csrf(s)}
              <button class="btn btn-sm" data-confirm="${tx('bkp.restore_confirm', { when: when(b.created_at) })}">${icon('history')} ${tx('bkp.restore')}</button></form>
            <form method="post" action="${BASE}/apps/${a.id}/backups/${b.id}/delete" class="u-inline">${csrf(s)}
              <button class="btn btn-sm btn-danger" data-confirm="${tx('bkp.delete_confirm')}">${tx('bkp.delete')}</button></form>
          </div></td></tr>`)
          : html`<tr><td colspan="6" class="empty">${tx('bkp.none')}</td></tr>`}</tbody></table></div>`)}
      <div class="columns">
        ${region(tx('bkp.back_up_now'), html`<form method="post" action="${BASE}/apps/${a.id}/backups">${csrf(s)}
          <div class="form-grid">${input('note', tx('bkp.note'), '', { placeholder: tx('bkp.note_placeholder') })}</div>
          <div class="buttons"><button class="btn btn-hot">${icon('save')} ${tx('bkp.back_up_now')}</button></div></form>`)}
        ${region(tx('bkp.keep'), html`<form method="post" action="${BASE}/apps/${a.id}/backups/settings">${csrf(s)}
          <div class="form-grid">${input('keep', tx('bkp.to_keep'), a.backups_keep, { type: 'number', help: tx('bkp.to_keep_help') })}</div>
          <div class="buttons"><button class="btn">${tx('common.save')}</button></div></form>`)}
      </div>`;
    const main = html`${appHeader(a, 'pages', s)}<div class="ide-body">${body}</div>`;
    return send(reply, s, shell(s, tx('bkp.page_title', { name: a.name }), [[tx('rail.app_builder'), BASE], [a.name, `${BASE}/apps/${a.id}`], [tx('app.head.backups')]], main));
  });

  app.post(`${BASE}/apps/:id(^\\d+$)/backups`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOr404(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const r = await owner.one(`select meta.backup_app($1, 'manual', $2, $3) as id`, [a.id, s.username, String(req.body?.note ?? '').trim().slice(0, 500) || null]);
    flash(s, r.id ? tx('bkp.made_flash') : tx('bkp.none_kept'), r.id ? 'ok' : 'error');
    return back(reply, s, `${BASE}/apps/${a.id}/backups`);
  });

  app.post(`${BASE}/apps/:id(^\\d+$)/backups/settings`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const keep = Number(req.body?.keep);
    if (!Number.isInteger(keep) || keep < 0 || keep > 500) flash(s, tx('bkp.keep_invalid'), 'error');
    else {
      await owner.query('update meta.app set backups_keep = $2, updated_at = now() where id = $1', [req.params.id, keep]);
      // fewer to keep: the oldest go now
      await owner.query(`delete from meta.app_backup where app_id = $1 and id not in (select id from meta.app_backup where app_id = $1 order by created_at desc, id desc limit $2)`, [req.params.id, keep]);
      flash(s, tx('bkp.saved'));
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
        if (!b) throw new Error(tx('bkp.not_found'));
        await replaceApp(c, b.doc, a.alias, { backup: { reason: 'restore', user: s.username, note: `before restoring the backup of ${when(b.created_at)}` } });
        return when(b.created_at);
      });
      await logActivity({ appId: a.id, username: s.username, event: 'backup_restored', ip: clientIp(req), detail: `backup ${req.params.bid} of ${at}` });
      flash(s, tx('bkp.restored', { when: at }));
    } catch (e) {
      flash(s, tx('bkp.restore_failed', { message: (e as Error).message }), 'error');
    }
    return back(reply, s, `${BASE}/apps/${a.id}/backups`);
  });

  app.post(`${BASE}/apps/:id(^\\d+$)/backups/:bid(^\\d+$)/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const r = await owner.query('delete from meta.app_backup where id = $1 and app_id = $2', [req.params.bid, req.params.id]);
    flash(s, r.rowCount ? tx('bkp.deleted') : tx('bkp.not_found_short'), r.rowCount ? 'ok' : 'error');
    return back(reply, s, `${BASE}/apps/${req.params.id}/backups`);
  });
}
