import type { FastifyInstance } from 'fastify';
import { applyBinds } from '../binds.ts';
import { appTx, savepoint } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import type { Region } from '../metadata.ts';
import { logActivity, saveState } from '../session.ts';
import { pageAllowed } from './authz.ts';
import { publicError, stripSemicolon, type PageContext } from './context.ts';
import { linkAttrs } from './links.ts';
import { cell } from './report.ts';
import { loadContext, safeNext, txContext, type Req } from './routes.ts';

// Task list region (APEX: Unified Task List) and the task actions.
//
//   config: {"context": "my" | "initiated" | "admin", "completed": false}
//     my         open tasks I can act on or claim, or that are assigned to me
//     initiated  tasks I requested (open and, with "completed", done ones)
//     admin      every task of the definitions I administer
//
// The list shows meta.tasks, which already filters on what the user may
// see and says what they may do; POST /a/:alias/tasks/:id runs the action
// through the meta.*_task functions, which check the same rights again.

export const TASK_ACTIONS = ['claim', 'release', 'approve', 'reject', 'complete', 'delegate', 'cancel', 'comment'] as const;
type Action = (typeof TASK_ACTIONS)[number];

interface TaskRow {
  id: string;
  definition: string;
  type: 'approval' | 'action';
  subject: string;
  detail_pk: string | null;
  state: string;
  outcome: string | null;
  priority: number;
  initiator: string;
  actual_owner: string | null;
  created_at: string;
  due_at: string | null;
  completed_at: string | null;
  completed_by: string | null;
  details_page: number | null;
  details_item: string | null;
  overdue: boolean;
  is_initiator: boolean;
  may_act: boolean;
  may_claim: boolean;
  may_release: boolean;
  may_delegate: boolean;
  may_cancel: boolean;
}

export async function renderTasks(ctx: PageContext, r: Region): Promise<Raw> {
  const t = ctx.locale.t;
  if (ctx.user === 'nobody') return html`<p class="empty">${t('tasks.sign_in')}</p>`;
  const context = ['my', 'initiated', 'admin'].includes(r.config.context) ? r.config.context : 'my';
  const completed = r.config.completed === true;
  const where = {
    my: `(may_act or may_claim or (state = 'assigned' and lower(actual_owner) = lower(meta.app_user())))`,
    initiated: 'is_initiator',
    admin: 'is_admin',
  }[context as 'my' | 'initiated' | 'admin'];
  const c = ctx.client!;
  let tasks: TaskRow[];
  let events: { task_id: string; at: string; username: string; event: string; detail: string | null }[];
  try {
    tasks = (
      await savepoint(c, () =>
        c.query<TaskRow>(
          `select * from meta.tasks where ${where} ${completed ? '' : `and state in ('unassigned', 'assigned')`}
            order by state in ('completed', 'cancelled'), overdue desc, priority, due_at nulls last, created_at limit 200`,
        ),
      )
    ).rows;
    events = tasks.length
      ? (await savepoint(c, () => c.query('select task_id::text, at::text, username, event, detail from meta.task_events where task_id = any($1::bigint[]) order by at', [tasks.map((x) => x.id)]))).rows
      : [];
  } catch (e) {
    return html`<div class="alert alert-error" role="alert">${await publicError(ctx, e, `task list "${r.title ?? r.id}"`)}</div>`;
  }
  if (!tasks.length) return html`<p class="empty">${r.config.empty ?? t('tasks.none')}</p>`;

  const fmt = ctx.locale.format;
  const csrf = html`<input type="hidden" name="__csrf" value="${ctx.session.csrf_token}"><input type="hidden" name="next" value="${`${ctx.base}/${ctx.page.page_no}`}">`;
  const action = (id: string) => `${ctx.base}/tasks/${id}`;
  const rows: Raw[] = [];
  for (const k of tasks) {
    const f = `tk${r.id}_${k.id}`;
    ctx.detached.push(html`<form id="${f}" method="post" action="${action(k.id)}">${csrf}</form>`);
    const button = (a: Action, label: string, cls = '', confirm?: string) =>
      html`<button class="btn${cls}" form="${f}" name="action" value="${a}"${confirm ? raw(` data-confirm="${confirm.replace(/"/g, '&quot;')}"`) : ''}>${label}</button>`;
    const open = k.state === 'unassigned' || k.state === 'assigned';
    const link = k.details_page && k.details_item && k.detail_pk !== null && (await pageAllowed(ctx, k.details_page))
      ? html`<a ${linkAttrs(ctx, k.details_page, { [k.details_item]: k.detail_pk })}>${k.subject}</a>`
      : html`${k.subject}`;
    const status = open
      ? k.state === 'assigned' ? t('tasks.assigned_to', { user: k.actual_owner ?? '' }) : t('tasks.unassigned')
      : k.state === 'cancelled' ? t('tasks.cancelled') : t(`tasks.outcome.${k.outcome ?? 'completed'}`);
    const actions = open
      ? html`<div class="task-actions">
          ${k.may_act
            ? html`<input name="comment" form="${f}" maxlength="4000" placeholder="${t('tasks.comment_optional')}" aria-label="${t('tasks.comment')}">
                ${k.type === 'approval'
                  ? html`${button('approve', t('tasks.approve'), ' btn-hot')}${button('reject', t('tasks.reject'), ' btn-danger')}`
                  : button('complete', t('tasks.complete'), ' btn-hot')}`
            : ''}
          ${k.may_claim ? button('claim', t('tasks.claim')) : ''}
          ${k.may_release ? button('release', t('tasks.release')) : ''}
          ${k.may_delegate
            ? html`<span class="task-delegate"><input name="to" form="${f}" maxlength="100" placeholder="${t('tasks.username')}" aria-label="${t('tasks.delegate_to')}">${button('delegate', t('tasks.delegate'))}</span>`
            : ''}
          ${k.may_cancel ? button('cancel', t('tasks.cancel'), ' btn-danger', t('tasks.cancel_confirm')) : ''}
        </div>`
      : '';
    const history = events.filter((e) => e.task_id === k.id);
    rows.push(html`<li class="task${k.overdue ? ' overdue' : ''}">
      <div class="task-head">
        <span class="task-subject">${link}</span>
        ${k.overdue ? html`<span class="tag tag-error">${t('tasks.overdue')}</span>` : ''}
        ${k.priority <= 2 ? html`<span class="tag tag-warning">${t('tasks.priority', { p: k.priority })}</span>` : ''}
      </div>
      <div class="task-meta muted">${t('tasks.requested_by', { user: k.initiator, at: cell(k.created_at, 1184, fmt) })}${k.due_at ? html` · ${t('tasks.due', { at: cell(k.due_at, 1184, fmt) })}` : ''} · <b>${status}</b></div>
      ${actions}
      <details class="task-history"><summary>${t('tasks.history', { n: history.length })}</summary>
        <ol>${history.map((e) => html`<li><span class="muted">${cell(e.at, 1184, fmt)}</span> ${e.username}: ${t(`tasks.event.${e.event}`)}${e.detail ? html` <q>${e.detail}</q>` : ''}</li>`)}</ol>
        <div class="filter-row"><input name="text" form="${f}" maxlength="4000" placeholder="${t('tasks.add_comment')}" aria-label="${t('tasks.add_comment')}">${button('comment', t('tasks.comment'))}</div>
      </details>
    </li>`);
  }
  return html`<ul class="tasks">${rows}</ul>`;
}

export async function taskRoutes(app: FastifyInstance) {
  app.post('/a/:alias/tasks/:id', async (req: Req, reply) => {
    const ctx = await loadContext(req, reply, { pageNo: 'home' });
    if (!ctx) return;
    const b = req.body ?? {};
    const next = safeNext(ctx.app, b.next);
    const id = String(req.params.id ?? '');
    const act = b.action as Action;
    if (b.__csrf !== ctx.session.csrf_token || !/^\d{1,18}$/.test(id) || !TASK_ACTIONS.includes(act)) return reply.redirect(next, 303);
    const t = ctx.locale.t;
    try {
      await appTx(txContext(ctx), async (c) => {
        ctx.client = c;
        const comment = (b.comment ?? '').slice(0, 4000) || null;
        switch (act) {
          case 'claim':
          case 'release':
            await c.query(`select meta.${act}_task($1)`, [id]);
            break;
          case 'delegate':
            await c.query('select meta.delegate_task($1, $2)', [id, (b.to ?? '').slice(0, 100)]);
            break;
          case 'cancel':
            await c.query('select meta.cancel_task($1, $2)', [id, comment]);
            break;
          case 'comment':
            await c.query('select meta.add_task_comment($1, $2)', [id, (b.text ?? '').slice(0, 4000)]);
            break;
          default: {
            const outcome = act === 'approve' ? 'approved' : act === 'reject' ? 'rejected' : 'completed';
            const done = (await c.query<{ r: { action_code: string | null; detail_pk: string | null; params: Record<string, unknown>; initiator: string } }>(
              'select meta.complete_task($1, $2, $3) as r', [id, outcome, comment])).rows[0].r;
            // the definition's action, as the application's role, in this transaction: an error undoes the decision
            if (done.action_code?.trim()) {
              const params = Object.fromEntries(Object.entries(done.params ?? {}).map(([k, v]) => [k.toUpperCase(), v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v)]));
              const binds = { ...params, TASK_ID: id, DETAIL_PK: done.detail_pk, OUTCOME: outcome.toUpperCase(), COMMENT: comment, APPROVER: ctx.user, INITIATOR: done.initiator };
              await c.query(stripSemicolon(applyBinds(done.action_code, binds)));
            }
          }
        }
      });
      logActivity({ appId: ctx.app.id, username: ctx.user, event: 'task', ip: ctx.ip, detail: `${act} ${id}` });
      ctx.session.state.__FLASH = t(`tasks.done.${act}`);
    } catch (e) {
      ctx.session.state.__FLASH_ERROR = await publicError(ctx, e, 'task');
    }
    await saveState(ctx.session);
    return reply.redirect(next, 303);
  });
}
