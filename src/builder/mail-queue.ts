import type { FastifyInstance, FastifyReply } from 'fastify';
import { owner } from '../db.ts';
import { html } from '../html.ts';
import { icon } from '../icons.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import { isAdmin } from './locks.ts';
import { back, BASE, csrf, developer, flash, region, select, send, shell, type Req } from './ui.ts';
import { workspaceAdmin } from './workspaces.ts';
import { tr } from './i18n.ts';

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
/** (sprint 152) the periods in the developer's language */
const periods = (tx: ReturnType<typeof tr>): [string, string][] => PERIODS.map(([v]) => [v, tx(`mq.period.${v}` as 'mq.period.24')]);

/** The mail a developer may see: every workspace (null) or one; false when none. */
export async function queueScope(s: Session): Promise<{ admin: boolean; workspace: number | null } | false> {
  if (await isAdmin(s.username)) return { admin: true, workspace: null };
  if (s.workspace && (await workspaceAdmin(s.username, s.workspace.id))) return { admin: false, workspace: s.workspace.id };
  return false;
}

async function refuse(s: Session, reply: FastifyReply) {
  const tx = tr(s);
  const main = html`<h1 class="u-mb1">${tx('mq.title')}</h1><div class="alert alert-error" role="alert">${tx('mq.refused')}</div>`;
  await send(reply.code(403), s, shell(s, tx('mq.title'), [[tx('rail.admin')], [tx('mq.title')]], main, 'users'));
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
    const tx = tr(s);
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
        ${select('period', tx('mq.period'), String(hours), periods(tx))}
        ${scope.admin ? select('ws', tx('mq.workspace'), ws ? String(ws) : '', [['', tx('mq.all_workspaces')], ...workspaces.map((w): [string, string] => [String(w.id), w.name])]) : ''}
        ${select('app', tx('mq.app'), appId ? String(appId) : '', [['', tx('mq.all_apps')], ...apps.map((a): [string, string] => [String(a.id), a.alias])])}
        <div class="buttons"><button class="btn">${tx('common.show')}</button></div></form>`;
    const total = totals.sent + totals.failed;
    const health = total ? Math.round((totals.sent / total) * 1000) / 10 : null;
    const stat = (n: unknown, label: string, cls = '') => html`<div class="stat${cls}"><b>${n ?? '–'}</b><span>${label}</span></div>`;
    const keep = new URLSearchParams(Object.entries({ period: String(hours), ...(scope.admin && ws ? { ws: String(ws) } : {}), ...(appId ? { app: String(appId) } : {}) })).toString();
    const action = (path: string, label: unknown, cls: string, confirm?: string) =>
      html`<form method="post" action="${BASE}/mail-queue${path}?${keep}" class="inline-form">${csrf(s)}<button class="btn btn-sm${cls}"${confirm ? html` data-confirm="${confirm}"` : ''}>${label}</button></form>`;
    const main = html`
      <div class="title-row"><h1>${tx('mq.title')}</h1></div>
      <p class="muted u-mt0">${wsName ? tx.rich('mq.intro_ws', { workspace: html`<b>${wsName}</b>` }) : tx('mq.intro_all')}${scope.admin ? '' : ` ${tx('mq.only_yours')}`}</p>
      ${filters}
      <div class="stat-grid mail-queue-stats">
        ${stat(totals.queued, tx('mq.stat.queued'))}${stat(totals.retrying, tx('mq.stat.retrying'))}${stat(totals.sending, tx('mq.stat.sending'))}
        ${stat(totals.sent, tx('mq.stat.sent'))}${stat(totals.failed, tx('mq.stat.failed'), totals.failed ? ' stat-bad' : '')}
        ${stat(health === null ? null : `${health}%`, tx('mq.stat.delivered'))}${stat(totals.avg_ms === null ? null : `${totals.avg_ms} ms`, tx('mq.stat.avg'))}
      </div>
      <div class="columns">
        ${region(tx('mq.per_hour'), html`<div class="table-wrap"><table class="report report-reflow">
          <thead><tr><th>${tx('mq.col.hour')}</th><th class="num">${tx('mq.col.queued')}</th><th class="num">${tx('mq.col.sent')}</th><th class="num">${tx('mq.col.failed')}</th><th class="num">${tx('mq.col.retrying')}</th></tr></thead>
          <tbody>${perHour.length ? perHour.map((h) => html`<tr><td data-label="${tx('mq.col.hour_short')}">${when(h.hour)}</td><td class="num" data-label="${tx('mq.col.queued')}">${h.queued}</td>
              <td class="num" data-label="${tx('mq.col.sent')}">${h.sent}</td><td class="num" data-label="${tx('mq.col.failed')}">${h.failed ? html`<b>${h.failed}</b>` : 0}</td><td class="num" data-label="${tx('mq.col.retrying')}">${h.retrying}</td></tr>`)
            : html`<tr><td colspan="5" class="empty">${tx('mq.none_period')}</td></tr>`}</tbody></table></div>`)}
        ${region(tx('mq.slowest'), html`<div class="table-wrap"><table class="report report-reflow">
          <thead><tr><th>${tx('mq.col.when')}</th><th>${tx('mq.app')}</th><th>${tx('mq.col.service')}</th><th>${tx('mq.col.status')}</th><th class="num">${tx('mq.col.time')}</th></tr></thead>
          <tbody>${slowest.length ? slowest.map((m) => html`<tr><td data-label="${tx('mq.col.when_short')}">${when(m.last_attempt_at)}</td><td data-label="${tx('mq.app')}">${m.alias}</td>
              <td data-label="${tx('mq.col.service')}" class="u-break">${m.service ?? ''}${m.provider ? html` <span class="muted">${m.provider}</span>` : ''}</td>
              <td data-label="${tx('mq.col.status')}"><span class="tag${m.status === 'sent' ? ' tag-ok' : m.status === 'error' ? ' tag-error' : ''}">${m.status === 'queued' ? tx('mq.status.retrying') : ['sent', 'error', 'sending', 'cancelled'].includes(m.status) ? tx(`mq.status.${m.status}` as 'mq.status.sent') : m.status}</span></td>
              <td class="num" data-label="${tx('mq.col.time')}">${m.duration_ms} ms</td></tr>`)
            : html`<tr><td colspan="5" class="empty">${tx('mq.none_calls')}</td></tr>`}</tbody></table></div>`)}
      </div>
      ${region(tx('mq.per_app'), html`<div class="table-wrap"><table class="report report-reflow">
        <thead><tr><th>${tx('mq.workspace')}</th><th>${tx('mq.app')}</th><th class="num">${tx('mq.col.sent')}</th><th class="num">${tx('mq.col.failed')}</th><th class="num">${tx('mq.col.retrying')}</th><th class="num">${tx('mq.col.queued')}</th><th class="num">${tx('mq.col.average')}</th><th class="num">${tx('mq.col.slowest')}</th></tr></thead>
        <tbody>${usage.length ? usage.map((u) => html`<tr><td data-label="${tx('mq.workspace')}">${u.workspace}</td>
            <td data-label="${tx('mq.app')}"><a href="${BASE}/mail-queue?${new URLSearchParams({ period: String(hours), ...(scope.admin && ws ? { ws: String(ws) } : {}), app: String(u.app_id) }).toString()}">${u.alias}</a></td>
            <td class="num" data-label="${tx('mq.col.sent')}">${u.sent}</td><td class="num" data-label="${tx('mq.col.failed')}">${u.failed ? html`<b>${u.failed}</b>` : 0}</td>
            <td class="num" data-label="${tx('mq.col.retrying')}">${u.retrying}</td><td class="num" data-label="${tx('mq.col.queued')}">${u.queued}</td>
            <td class="num" data-label="${tx('mq.col.average')}">${u.avg_ms === null ? '–' : `${u.avg_ms} ms`}</td><td class="num" data-label="${tx('mq.col.slowest')}">${u.max_ms === null ? '–' : `${u.max_ms} ms`}</td></tr>`)
          : html`<tr><td colspan="8" class="empty">${tx('mq.none_period')}</td></tr>`}</tbody></table></div>`)}
      ${region(tx('mq.failures'), html`<p class="muted u-mt0">${tx.rich('mq.failures_intro', { n: 5, retry: html`<b>${tx('mq.retry')}</b>`, purge: html`<b>${tx('mq.purge')}</b>` })}</p>
        <div class="table-wrap"><table class="report report-reflow mail-failures">
        <thead><tr><th>${tx('mq.col.failed_at')}</th><th>${tx('mq.app')}</th><th>${tx('mq.col.to')}</th><th>${tx('mq.col.subject')}</th><th>${tx('mq.col.answer')}</th><th>${tx('mq.col.actions')}</th></tr></thead>
        <tbody>${failures.length ? failures.map((m) => html`<tr>
            <td data-label="${tx('mq.col.failed')}">${when(m.failed_at)}<br><span class="muted small">${tx('mq.queued_at', { when: when(m.created_at) })} · ${tx(m.attempts === 1 ? 'mq.attempts_one' : 'mq.attempts', { n: m.attempts })}</span></td>
            <td data-label="${tx('mq.app')}">${m.alias}${scope.admin && !ws ? html`<br><span class="muted small">${m.workspace}</span>` : ''}</td>
            <td data-label="${tx('mq.col.to')}" class="u-break">${[...m.to_addresses, ...m.cc_addresses].join(', ')}${m.bcc_addresses.length ? html` <span class="muted">+${m.bcc_addresses.length} bcc</span>` : ''}</td>
            <td data-label="${tx('mq.col.subject')}" class="u-break">${m.subject}</td>
            <td data-label="${tx('mq.col.answer')}" class="u-break">${m.service ? html`<span class="muted small">${m.service}${m.provider ? ` (${m.provider})` : ''}</span><br>` : ''}<span class="mail-answer">${m.message ?? ''}</span></td>
            <td data-label="${tx('mq.col.actions')}"><div class="buttons u-mt0">${action(`/${m.id}/retry`, tx('mq.retry'), '')}${action(`/${m.id}/purge`, tx('mq.purge'), ' btn-danger', tx('mq.purge_confirm'))}</div></td></tr>`)
          : html`<tr><td colspan="6" class="empty">${tx('mq.none_failed')}</td></tr>`}</tbody></table></div>
        ${failures.length ? html`<div class="buttons">${action('/retry', html`${icon('refresh')} ${tx('mq.retry_all')}`, '')}${action('/purge', html`${icon('trash')} ${tx('mq.purge_all')}`, ' btn-danger', tx('mq.purge_all_confirm'))}</div>` : ''}`,
        '', 'failures')}`;
    return send(reply, s, shell(s, tx('mq.title'), [[tx('rail.admin')], [tx('mq.title')]], main, 'users'));
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
    flash(s, r.rowCount ? tr(s)('mq.requeued') : tr(s)('mq.changed'), r.rowCount ? 'ok' : 'error');
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
    flash(s, r.rowCount ? tr(s)('mq.deleted') : tr(s)('mq.only_done'), r.rowCount ? 'ok' : 'error');
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
      flash(s, tr(s)(what === 'retry' ? (r.rowCount === 1 ? 'mq.n_requeued_one' : 'mq.n_requeued') : (r.rowCount === 1 ? 'mq.n_deleted_one' : 'mq.n_deleted'), { n: r.rowCount ?? 0 }));
      return back(reply, s, redirect(req));
    });
}
