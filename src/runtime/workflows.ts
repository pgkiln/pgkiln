import type { FastifyInstance } from 'fastify';
import { appTx, savepoint } from '../db.ts';
import { html, type Raw } from '../html.ts';
import type { Region } from '../metadata.ts';
import { logActivity, saveState } from '../session.ts';
import { publicError, type PageContext } from './context.ts';
import { cell } from './report.ts';
import { loadContext, safeNext, txContext, type Req } from './routes.ts';

// Workflow console region (APEX: Workflow Console): the workflows the user
// started, or administers, with their steps; terminate and retry.
//   config: {"context": "initiated" | "admin", "completed": false}

interface WfRow {
  id: string;
  title: string;
  state: string;
  current_step: string | null;
  wait_until: string | null;
  error: string | null;
  initiator: string;
  started_at: string;
  ended_at: string | null;
  may_terminate: boolean;
  may_retry: boolean;
}

export async function renderWorkflows(ctx: PageContext, r: Region): Promise<Raw> {
  const t = ctx.locale.t;
  if (ctx.user === 'nobody') return html`<p class="empty">${t('tasks.sign_in')}</p>`;
  const admin = r.config.context === 'admin';
  const c = ctx.client!;
  let rows: WfRow[];
  let events: { workflow_id: string; at: string; step: string | null; event: string; detail: string | null }[];
  try {
    rows = (await savepoint(c, () => c.query<WfRow>(
      `select id::text, title, state, current_step, wait_until::text, error, initiator, started_at::text, ended_at::text, may_terminate, may_retry
         from meta.workflows where ${admin ? 'is_admin' : 'is_initiator'} ${r.config.completed === true ? '' : `and state in ('active', 'waiting', 'faulted')`}
        order by state = 'faulted' desc, started_at desc limit 200`))).rows;
    events = rows.length
      ? (await savepoint(c, () => c.query('select workflow_id::text, at::text, step, event, detail from meta.workflow_events where workflow_id = any($1::bigint[]) order by at, id', [rows.map((x) => x.id)]))).rows
      : [];
  } catch (e) {
    return html`<div class="alert alert-error" role="alert">${await publicError(ctx, e, `workflows "${r.title ?? r.id}"`)}</div>`;
  }
  if (!rows.length) return html`<p class="empty">${r.config.empty ?? t('workflows.none')}</p>`;
  const fmt = ctx.locale.format;
  const csrf = html`<input type="hidden" name="__csrf" value="${ctx.session.csrf_token}"><input type="hidden" name="next" value="${`${ctx.base}/${ctx.page.page_no}`}">`;
  return html`<ul class="tasks workflows">${rows.map((w) => {
    const f = `wf${r.id}_${w.id}`;
    ctx.detached.push(html`<form id="${f}" method="post" action="${ctx.base}/workflows/${w.id}">${csrf}</form>`);
    const history = events.filter((e) => e.workflow_id === w.id);
    const state = t(`workflows.state.${w.state}`);
    return html`<li class="task${w.state === 'faulted' ? ' overdue' : ''}">
      <div class="task-head"><span class="task-subject">${w.title}</span> <span class="tag${w.state === 'faulted' ? ' tag-error' : w.state === 'completed' ? '' : ' tag-info'}">${state}</span></div>
      <div class="task-meta muted">${t('workflows.started', { user: w.initiator, at: cell(w.started_at, 1184, fmt) })}${w.current_step && w.state !== 'completed' ? html` · ${t('workflows.at_step', { step: w.current_step })}` : ''}${w.wait_until ? html` · ${t('workflows.until', { at: cell(w.wait_until, 1184, fmt) })}` : ''}</div>
      ${w.error ? html`<div class="alert alert-error u-mt075" role="alert">${w.error}</div>` : ''}
      ${w.may_terminate || w.may_retry
        ? html`<div class="task-actions">
            ${w.may_retry ? html`<button class="btn btn-hot" form="${f}" name="action" value="retry">${t('workflows.retry')}</button>` : ''}
            ${w.may_terminate ? html`<button class="btn btn-danger" form="${f}" name="action" value="terminate" data-confirm="${t('workflows.terminate_confirm')}">${t('workflows.terminate')}</button>` : ''}
          </div>`
        : ''}
      <details class="task-history"><summary>${t('tasks.history', { n: history.length })}</summary>
        <ol>${history.map((e) => html`<li><span class="muted">${cell(e.at, 1184, fmt)}</span> ${e.step ? html`<b>${e.step}</b> ` : ''}${t(`workflows.event.${e.event}`)}${e.detail ? html` <q>${e.detail}</q>` : ''}</li>`)}</ol>
      </details>
    </li>`;
  })}</ul>`;
}

export async function workflowRoutes(app: FastifyInstance) {
  app.post('/a/:alias/workflows/:id', async (req: Req, reply) => {
    const ctx = await loadContext(req, reply, { pageNo: 'home' });
    if (!ctx) return;
    const b = req.body ?? {};
    const next = safeNext(ctx.app, b.next);
    const id = String(req.params.id ?? '');
    if (b.__csrf !== ctx.session.csrf_token || !/^\d{1,18}$/.test(id) || !['terminate', 'retry'].includes(b.action ?? '')) return reply.redirect(next, 303);
    try {
      await appTx(txContext(ctx), async (c) => {
        await c.query(b.action === 'retry' ? 'select meta.retry_workflow($1)' : 'select meta.terminate_workflow($1)', [id]);
      });
      logActivity({ appId: ctx.app.id, username: ctx.user, event: 'workflow', ip: ctx.ip, detail: `${b.action} ${id}` });
      ctx.session.state.__FLASH = ctx.locale.t(`workflows.done.${b.action}`);
    } catch (e) {
      ctx.session.state.__FLASH_ERROR = await publicError(ctx, e, 'workflow');
    }
    await saveState(ctx.session);
    return reply.redirect(next, 303);
  });
}
