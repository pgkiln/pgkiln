import type { FastifyInstance, FastifyReply } from 'fastify';
import { owner } from '../db.ts';
import { html } from '../html.ts';
import { icon } from '../icons.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import { isAdmin } from './locks.ts';
import { back, BASE, csrf, developer, flash, region, select, send, shell, type Req } from './ui.ts';
import { workspaceAdmin } from './workspaces.ts';

// (sprint 118, WS-9; APEX 26.2 Administration → Mail queue) Delivery health of
// the mail queue (meta.mail_queue): queued, sent, failed and retrying mail per
// hour and per workspace / application, the slowest provider calls, and the
// failures with the provider's answer, with Retry and Purge.
//
// Who sees what: administrators see every workspace (or one); a workspace
// administrator sees the mail of their current workspace's applications only.
// Every action checks the mail's workspace again on the server. Bodies and
// attachments are never shown here.

export const PERIODS: [string, string][] = [['24', 'Last 24 hours'], ['48', 'Last 48 hours'], ['168', 'Last 7 days']];

/** The mail a developer may see: every workspace (null) or one; false when none. */
export async function queueScope(s: Session): Promise<{ admin: boolean; workspace: number | null } | false> {
  if (await isAdmin(s.username)) return { admin: true, workspace: null };
  if (s.workspace && (await workspaceAdmin(s.username, s.workspace.id))) return { admin: false, workspace: s.workspace.id };
  return false;
}

async function refuse(s: Session, reply: FastifyReply) {
  const main = html`<h1 class="u-mb1">Mail queue</h1><div class="alert alert-error" role="alert">Only administrators and workspace administrators see the mail queue.</div>`;
  await send(reply.code(403), s, shell(s, 'Mail queue', [['Administration'], ['Mail queue']], main, 'users'));
}

const when = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '');
const id = (v: unknown) => (/^\d{1,9}$/.test(String(v ?? '')) ? Number(v) : null);
/** the scope condition on meta.mail_queue q: $1 workspace (null: all), $2 application (null: all) */
const IN_SCOPE = '($1::int is null or meta.app_workspace(q.app_id) = $1) and ($2::int is null or q.app_id = $2)';

export async function mailQueueRoutes(app: FastifyInstance) {
  app.get(`${BASE}/mail-queue`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const scope = await queueScope(s);
    if (!scope) return refuse(s, reply);
    const hours = PERIODS.some(([v]) => v === req.query.period) ? Number(req.query.period) : 24;
    const ws = scope.admin ? id(req.query.ws) : scope.workspace;
    const appId = id(req.query.app);
    const p = [ws, appId, hours];
    const since = `now() - make_interval(hours => $3)`;
    const [workspaces, apps, totals, perHour, usage, slowest, failures] = await Promise.all([
      scope.admin ? owner.query<{ id: number; name: string }>('select id, name from meta.workspace order by id = 1 desc, lower(name)').then((r) => r.rows) : [],
      owner.query<{ id: number; alias: string }>('select id, alias from meta.app a where $1::int is null or meta.app_workspace(a.id) = $1 order by alias', [ws]).then((r) => r.rows),
      owner.one(
        `select count(*) filter (where status = 'queued' and attempts = 0)::int as queued,
                count(*) filter (where status = 'queued' and attempts > 0)::int as retrying,
                count(*) filter (where status = 'sending')::int as sending,
                count(*) filter (where status = 'sent' and sent_at >= ${since})::int as sent,
                count(*) filter (where status = 'error' and coalesce(last_attempt_at, created_at) >= ${since})::int as failed,
                round(avg(duration_ms) filter (where last_attempt_at >= ${since}))::int as avg_ms
           from meta.mail_queue q where ${IN_SCOPE}`, p),
      owner.query(
        `select h as hour, count(*) filter (where k = 'queued')::int as queued, count(*) filter (where k = 'sent')::int as sent,
                count(*) filter (where k = 'failed')::int as failed, count(*) filter (where k = 'retrying')::int as retrying
           from (select date_trunc('hour', q.created_at) as h, 'queued' as k from meta.mail_queue q where ${IN_SCOPE} and q.created_at >= ${since}
                 union all select date_trunc('hour', q.sent_at), 'sent' from meta.mail_queue q where ${IN_SCOPE} and q.status = 'sent' and q.sent_at >= ${since}
                 union all select date_trunc('hour', coalesce(q.last_attempt_at, q.created_at)), 'failed' from meta.mail_queue q
                            where ${IN_SCOPE} and q.status = 'error' and coalesce(q.last_attempt_at, q.created_at) >= ${since}
                 union all select date_trunc('hour', q.last_attempt_at), 'retrying' from meta.mail_queue q
                            where ${IN_SCOPE} and q.status = 'queued' and q.attempts > 0 and q.last_attempt_at >= ${since}) e
          group by h order by h desc`, p).then((r) => r.rows),
      owner.query(
        `select w.name as workspace, a.alias, a.name, q.app_id,
                count(*) filter (where q.status = 'sent' and q.sent_at >= ${since})::int as sent,
                count(*) filter (where q.status = 'error' and coalesce(q.last_attempt_at, q.created_at) >= ${since})::int as failed,
                count(*) filter (where q.status = 'queued' and q.attempts > 0)::int as retrying,
                count(*) filter (where q.status in ('queued', 'sending') and q.attempts = 0)::int as queued,
                round(avg(q.duration_ms) filter (where q.last_attempt_at >= ${since}))::int as avg_ms,
                max(q.duration_ms) filter (where q.last_attempt_at >= ${since}) as max_ms
           from meta.mail_queue q join meta.app a on a.id = q.app_id join meta.workspace w on w.id = meta.app_workspace(q.app_id)
          where ${IN_SCOPE} and (q.created_at >= ${since} or q.last_attempt_at >= ${since} or q.status in ('queued', 'sending'))
          group by w.name, a.alias, a.name, q.app_id order by lower(w.name), a.alias`, p).then((r) => r.rows),
      owner.query(
        `select q.id, q.last_attempt_at, a.alias, q.service, q.provider, q.status, q.duration_ms, q.subject
           from meta.mail_queue q join meta.app a on a.id = q.app_id
          where ${IN_SCOPE} and q.last_attempt_at >= ${since} and q.duration_ms is not null
          order by q.duration_ms desc, q.id desc limit 10`, p).then((r) => r.rows),
      // failures are listed until they are retried or purged (kept 30 days), whatever the period
      owner.query(
        `select q.id, q.created_at, coalesce(q.last_attempt_at, q.created_at) as failed_at, a.alias, w.name as workspace, q.to_addresses, q.cc_addresses,
                q.bcc_addresses, q.subject, q.service, q.provider, q.attempts, q.message
           from meta.mail_queue q join meta.app a on a.id = q.app_id join meta.workspace w on w.id = meta.app_workspace(q.app_id)
          where ($1::int is null or meta.app_workspace(q.app_id) = $1) and ($2::int is null or q.app_id = $2) and q.status = 'error'
          order by q.id desc limit 100`, [ws, appId]).then((r) => r.rows),
    ]);
    const wsName = ws ? (scope.admin ? workspaces.find((w) => w.id === ws)?.name : s.workspace?.name) : null;
    const filters = html`<form method="get" class="filter-row mail-queue-filters">
        ${select('period', 'Period', String(hours), PERIODS)}
        ${scope.admin ? select('ws', 'Workspace', ws ? String(ws) : '', [['', 'All workspaces'], ...workspaces.map((w): [string, string] => [String(w.id), w.name])]) : ''}
        ${select('app', 'Application', appId ? String(appId) : '', [['', 'All applications'], ...apps.map((a): [string, string] => [String(a.id), a.alias])])}
        <div class="buttons"><button class="btn">Show</button></div></form>`;
    const total = totals.sent + totals.failed;
    const health = total ? Math.round((totals.sent / total) * 1000) / 10 : null;
    const stat = (n: unknown, label: string, cls = '') => html`<div class="stat${cls}"><b>${n ?? '–'}</b><span>${label}</span></div>`;
    const keep = new URLSearchParams(Object.entries({ period: String(hours), ...(scope.admin && ws ? { ws: String(ws) } : {}), ...(appId ? { app: String(appId) } : {}) })).toString();
    const action = (path: string, label: unknown, cls: string, confirm?: string) =>
      html`<form method="post" action="${BASE}/mail-queue${path}?${keep}" class="inline-form">${csrf(s)}<button class="btn btn-sm${cls}"${confirm ? html` data-confirm="${confirm}"` : ''}>${label}</button></form>`;
    const main = html`
      <div class="title-row"><h1>Mail queue</h1></div>
      <p class="muted u-mt0">Delivery of the mail ${wsName ? html`of workspace <b>${wsName}</b>` : 'of every workspace'}: what was queued, sent and failed, which mail is being retried, how long the providers took, and the failures with the provider's answer. Mail is kept 30 days.${scope.admin ? '' : ' You see your workspace\'s applications only.'}</p>
      ${filters}
      <div class="stat-grid mail-queue-stats">
        ${stat(totals.queued, 'queued now')}${stat(totals.retrying, 'retrying now')}${stat(totals.sending, 'being sent')}
        ${stat(totals.sent, 'sent')}${stat(totals.failed, 'failed', totals.failed ? ' stat-bad' : '')}
        ${stat(health === null ? null : `${health}%`, 'delivered')}${stat(totals.avg_ms === null ? null : `${totals.avg_ms} ms`, 'average provider call')}
      </div>
      <div class="columns">
        ${region('Per hour', html`<div class="table-wrap"><table class="report report-reflow">
          <thead><tr><th>Hour (UTC)</th><th class="num">Queued</th><th class="num">Sent</th><th class="num">Failed</th><th class="num">Retrying</th></tr></thead>
          <tbody>${perHour.length ? perHour.map((h) => html`<tr><td data-label="Hour">${when(h.hour)}</td><td class="num" data-label="Queued">${h.queued}</td>
              <td class="num" data-label="Sent">${h.sent}</td><td class="num" data-label="Failed">${h.failed ? html`<b>${h.failed}</b>` : 0}</td><td class="num" data-label="Retrying">${h.retrying}</td></tr>`)
            : html`<tr><td colspan="5" class="empty">No mail in this period.</td></tr>`}</tbody></table></div>`)}
        ${region('Slowest provider calls', html`<div class="table-wrap"><table class="report report-reflow">
          <thead><tr><th>When (UTC)</th><th>Application</th><th>Service</th><th>Status</th><th class="num">Time</th></tr></thead>
          <tbody>${slowest.length ? slowest.map((m) => html`<tr><td data-label="When">${when(m.last_attempt_at)}</td><td data-label="Application">${m.alias}</td>
              <td data-label="Service" class="u-break">${m.service ?? ''}${m.provider ? html` <span class="muted">${m.provider}</span>` : ''}</td>
              <td data-label="Status"><span class="tag${m.status === 'sent' ? ' tag-ok' : m.status === 'error' ? ' tag-error' : ''}">${m.status === 'queued' ? 'retrying' : m.status}</span></td>
              <td class="num" data-label="Time">${m.duration_ms} ms</td></tr>`)
            : html`<tr><td colspan="5" class="empty">No provider calls in this period.</td></tr>`}</tbody></table></div>`)}
      </div>
      ${region('Per workspace and application', html`<div class="table-wrap"><table class="report report-reflow">
        <thead><tr><th>Workspace</th><th>Application</th><th class="num">Sent</th><th class="num">Failed</th><th class="num">Retrying</th><th class="num">Queued</th><th class="num">Average</th><th class="num">Slowest</th></tr></thead>
        <tbody>${usage.length ? usage.map((u) => html`<tr><td data-label="Workspace">${u.workspace}</td>
            <td data-label="Application"><a href="${BASE}/mail-queue?${new URLSearchParams({ period: String(hours), ...(scope.admin && ws ? { ws: String(ws) } : {}), app: String(u.app_id) }).toString()}">${u.alias}</a></td>
            <td class="num" data-label="Sent">${u.sent}</td><td class="num" data-label="Failed">${u.failed ? html`<b>${u.failed}</b>` : 0}</td>
            <td class="num" data-label="Retrying">${u.retrying}</td><td class="num" data-label="Queued">${u.queued}</td>
            <td class="num" data-label="Average">${u.avg_ms === null ? '–' : `${u.avg_ms} ms`}</td><td class="num" data-label="Slowest">${u.max_ms === null ? '–' : `${u.max_ms} ms`}</td></tr>`)
          : html`<tr><td colspan="8" class="empty">No mail in this period.</td></tr>`}</tbody></table></div>`)}
      ${region('Failures', html`<p class="muted u-mt0">Mail that will not be tried again: the provider refused it, or it failed ${5} times. <b>Retry</b> queues it again with fresh attempts; <b>Purge</b> deletes it.</p>
        <div class="table-wrap"><table class="report report-reflow mail-failures">
        <thead><tr><th>Failed (UTC)</th><th>Application</th><th>To</th><th>Subject</th><th>Provider's answer</th><th>Actions</th></tr></thead>
        <tbody>${failures.length ? failures.map((m) => html`<tr>
            <td data-label="Failed">${when(m.failed_at)}<br><span class="muted small">queued ${when(m.created_at)} · ${m.attempts} attempt${m.attempts === 1 ? '' : 's'}</span></td>
            <td data-label="Application">${m.alias}${scope.admin && !ws ? html`<br><span class="muted small">${m.workspace}</span>` : ''}</td>
            <td data-label="To" class="u-break">${[...m.to_addresses, ...m.cc_addresses].join(', ')}${m.bcc_addresses.length ? html` <span class="muted">+${m.bcc_addresses.length} bcc</span>` : ''}</td>
            <td data-label="Subject" class="u-break">${m.subject}</td>
            <td data-label="Provider's answer" class="u-break">${m.service ? html`<span class="muted small">${m.service}${m.provider ? ` (${m.provider})` : ''}</span><br>` : ''}<span class="mail-answer">${m.message ?? ''}</span></td>
            <td data-label="Actions"><div class="buttons u-mt0">${action(`/${m.id}/retry`, 'Retry', '')}${action(`/${m.id}/purge`, 'Purge', ' btn-danger', 'Delete this mail?')}</div></td></tr>`)
          : html`<tr><td colspan="6" class="empty">No failed mail.</td></tr>`}</tbody></table></div>
        ${failures.length ? html`<div class="buttons">${action('/retry', html`${icon('refresh')} Retry all failed`, '')}${action('/purge', html`${icon('trash')} Purge all failed`, ' btn-danger', 'Delete every failed mail shown here?')}</div>` : ''}`,
        '', 'failures')}`;
    return send(reply, s, shell(s, 'Mail queue', [['Administration'], ['Mail queue']], main, 'users'));
  });

  /** One mail's id when this developer may act on it (its application is in their scope). */
  const mine = async (s: Session, mailId: unknown) => {
    const scope = await queueScope(s);
    if (!scope) return null;
    const m = await owner.one<{ id: string; app_id: number }>(
      'select q.id, q.app_id from meta.mail_queue q where q.id = $1 and ($2::int is null or meta.app_workspace(q.app_id) = $2)', [id(mailId), scope.workspace]);
    return m;
  };
  const redirect = (req: Req) => {
    const q = new URLSearchParams();
    for (const k of ['period', 'ws', 'app']) if (id(req.query[k])) q.set(k, String(req.query[k]));
    return `${BASE}/mail-queue${q.size ? `?${q}` : ''}#failures`;
  };

  app.post(`${BASE}/mail-queue/:mid(^\\d{1,12}$)/retry`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    if (!(await queueScope(s))) return refuse(s, reply);
    const m = await mine(s, req.params.mid);
    if (!m) return reply.code(404).send('Not found');
    const r = await owner.query(`update meta.mail_queue set status = 'queued', attempts = 0, not_before = now(), message = null where id = $1 and status in ('error', 'cancelled')`, [m.id]);
    if (r.rowCount) await owner.query(`select pg_notify('pgkiln_mail', $1)`, [String(m.id)]);
    await logActivity({ appId: m.app_id, username: s.username, event: 'mail_queue', ip: clientIp(req), detail: `retry mail ${m.id}` });
    flash(s, r.rowCount ? 'The mail is queued again.' : 'The mail has changed meanwhile.', r.rowCount ? 'ok' : 'error');
    return back(reply, s, redirect(req));
  });

  app.post(`${BASE}/mail-queue/:mid(^\\d{1,12}$)/purge`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    if (!(await queueScope(s))) return refuse(s, reply);
    const m = await mine(s, req.params.mid);
    if (!m) return reply.code(404).send('Not found');
    // mail that is waiting or being sent is cancelled on the application's Mail page, not purged
    const r = await owner.query(`delete from meta.mail_queue where id = $1 and status in ('error', 'cancelled', 'sent')`, [m.id]);
    await logActivity({ appId: m.app_id, username: s.username, event: 'mail_queue', ip: clientIp(req), detail: `purged mail ${m.id}` });
    flash(s, r.rowCount ? 'The mail is deleted.' : 'Only sent, failed or cancelled mail can be purged.', r.rowCount ? 'ok' : 'error');
    return back(reply, s, redirect(req));
  });

  // all failed mail in the developer's scope (and the filter's workspace and application)
  for (const what of ['retry', 'purge'] as const)
    app.post(`${BASE}/mail-queue/${what}`, async (req: Req, reply) => {
      const s = await developer(req, reply);
      if (!s) return;
      const scope = await queueScope(s);
      if (!scope) return refuse(s, reply);
      const ws = scope.admin ? id(req.query.ws) : scope.workspace;
      const appId = id(req.query.app);
      const r = what === 'retry'
        ? await owner.query(`update meta.mail_queue q set status = 'queued', attempts = 0, not_before = now(), message = null where ${IN_SCOPE} and q.status = 'error'`, [ws, appId])
        : await owner.query(`delete from meta.mail_queue q where ${IN_SCOPE} and q.status = 'error'`, [ws, appId]);
      if (what === 'retry' && r.rowCount) await owner.query(`select pg_notify('pgkiln_mail', '')`);
      await logActivity({ appId: appId, username: s.username, event: 'mail_queue', ip: clientIp(req),
        detail: `${what === 'retry' ? 'retried' : 'purged'} ${r.rowCount} failed mail(s)${ws ? ` of workspace ${ws}` : ''}${appId ? ` of application ${appId}` : ''}` });
      flash(s, `${r.rowCount} mail${r.rowCount === 1 ? '' : 's'} ${what === 'retry' ? 'queued again' : 'deleted'}.`);
      return back(reply, s, redirect(req));
    });
}
