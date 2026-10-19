import type { FastifyInstance } from 'fastify';
import { applyBinds } from '../binds.ts';
import { appTx, savepoint } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import type { Region } from '../metadata.ts';
import { logActivity, saveState } from '../session.ts';
import { runActions, taskBinds, type TaskAction } from '../task-events.ts';
import { pageAllowed } from './authz.ts';
import { publicError, stripSemicolon, type PageContext } from './context.ts';
import { appDateMask, appDateReader, dateField } from './items.ts';
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
//
// (094) The "my" list also holds the user's vacation rule (who acts on their
// tasks while they are away, from and until a day), saved by POST
// /a/:alias/tasks/vacation through meta.set_vacation_rule / clear_vacation_rule.
// Expired tasks (the definition's expiration policy) show as done.

export const TASK_ACTIONS = ['claim', 'release', 'approve', 'reject', 'complete', 'delegate', 'cancel', 'comment', 'outcome'] as const;
/** (123) a custom outcome's colour → the button's classes (a whitelist: the definition can't add others) */
const OUTCOME_CLASS: Record<string, string> = { default: '', primary: ' btn-hot', success: ' to-success', danger: ' to-danger', warning: ' to-warning' };
interface Outcome { name: string; label?: string; colour?: string }
type Action = (typeof TASK_ACTIONS)[number];

/** What meta.complete_task returns (123: with the outcome, its label and the fail events). */
interface CompleteResult {
  action_code: string | null;
  detail_pk: string | null;
  params: Record<string, unknown>;
  initiator: string;
  outcome?: string;
  label?: string;
  subject?: string;
  fail_events?: unknown[];
  fail_recovery?: 'reopen' | 'complete';
}

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
  /** (123) the definition's custom outcomes */
  outcomes: Outcome[] | null;
}

export async function renderTasks(ctx: PageContext, r: Region): Promise<Raw> {
  const t = ctx.locale.t;
  if (ctx.user === 'nobody') return html`<p class="empty">${t('tasks.sign_in')}</p>`;
  const context = ['my', 'initiated', 'admin'].includes(r.config.context) ? r.config.context : 'my';
  const vacation = context === 'my' ? await vacationPanel(ctx, r) : '';
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
            order by state in ('completed', 'cancelled', 'expired'), overdue desc, priority, due_at nulls last, created_at limit 200`,
        ),
      )
    ).rows;
    events = tasks.length
      ? (await savepoint(c, () => c.query('select task_id::text, at::text, username, event, detail from meta.task_events where task_id = any($1::bigint[]) order by at', [tasks.map((x) => x.id)]))).rows
      : [];
  } catch (e) {
    return html`<div class="alert alert-error" role="alert">${await publicError(ctx, e, `task list "${r.title ?? r.id}"`)}</div>`;
  }
  if (!tasks.length) return html`${vacation}<p class="empty">${r.config.empty ?? t('tasks.none')}</p>`;

  const fmt = ctx.locale.format;
  const csrf = html`<input type="hidden" name="__csrf" value="${ctx.session.csrf_token}"><input type="hidden" name="next" value="${`${ctx.base}/${ctx.page.page_no}`}">`;
  const action = (id: string) => `${ctx.base}/tasks/${id}`;
  const rows: Raw[] = [];
  for (const k of tasks) {
    const f = `tk${r.id}_${k.id}`;
    ctx.detached.push(html`<form id="${f}" method="post" action="${action(k.id)}">${csrf}</form>`);
    const button = (a: Action, label: string, cls = '', confirm?: string) =>
      html`<button class="btn${cls}" form="${f}" name="action" value="${a}"${confirm ? raw(` data-confirm="${confirm.replace(/"/g, '&quot;')}"`) : ''}>${label}</button>`;
    // (123) custom outcomes: one button each, posting action=outcome:<name>
    const custom = Array.isArray(k.outcomes) && k.outcomes.length ? k.outcomes.filter((o) => o && typeof o.name === 'string') : null;
    const open = k.state === 'unassigned' || k.state === 'assigned';
    const link = k.details_page && k.details_item && k.detail_pk !== null && (await pageAllowed(ctx, k.details_page))
      ? html`<a ${linkAttrs(ctx, k.details_page, { [k.details_item]: k.detail_pk })}>${k.subject}</a>`
      : html`${k.subject}`;
    const status = open
      ? k.state === 'assigned' ? t('tasks.assigned_to', { user: k.actual_owner ?? '' }) : t('tasks.unassigned')
      : k.state === 'cancelled' ? t('tasks.cancelled') : k.state === 'expired' ? t('tasks.expired')
      : custom?.find((o) => o.name.toLowerCase() === k.outcome)?.label ?? (['approved', 'rejected', 'completed'].includes(k.outcome ?? 'completed') ? t(`tasks.outcome.${k.outcome ?? 'completed'}`) : String(k.outcome).toUpperCase());
    const actions = open
      ? html`<div class="task-actions">
          ${k.may_act
            ? html`<input name="comment" form="${f}" maxlength="4000" placeholder="${t('tasks.comment_optional')}" aria-label="${t('tasks.comment')}">
                ${custom
                  ? custom.map((o) => html`<button class="btn${OUTCOME_CLASS[o.colour ?? 'default'] ?? ''}" form="${f}" name="action" value="${`outcome:${o.name.toLowerCase()}`}">${o.label ?? o.name}</button>`)
                  : k.type === 'approval'
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
  return html`${vacation}<ul class="tasks">${rows}</ul>`;
}

/** (094) The user's vacation rule: the rule, or a form to set one. */
async function vacationPanel(ctx: PageContext, r: Region): Promise<Raw | ''> {
  const t = ctx.locale.t;
  const c = ctx.client!;
  let rule: { delegate_to: string; from_day: string; until_day: string; active: boolean } | undefined;
  try {
    rule = (await savepoint(c, () => c.query(
      `select delegate_to, starts_at::date::text as from_day, (ends_at - interval '1 microsecond')::date::text as until_day, active from meta.vacation_rule()`))).rows[0];
  } catch {
    return '';
  }
  // the region sits inside the page's form: the vacation form is detached (like the task actions' forms)
  const f = `tkvac${r.id}`;
  ctx.detached.push(html`<form id="${f}" method="post" action="${ctx.base}/tasks/vacation"><input type="hidden" name="__csrf" value="${ctx.session.csrf_token}"><input type="hidden" name="next" value="${`${ctx.base}/${ctx.page.page_no}`}"></form>`);
  const fmt = ctx.locale.format;
  const day = (d: string) => cell(d, 1082, fmt);
  return html`<details class="task-vacation"${rule ? raw(' open') : ''}><summary>${t('tasks.vacation')}${rule ? html` · <b>${rule.delegate_to}</b>` : ''}</summary>
    ${rule ? html`<p>${t('tasks.vacation_active', { user: rule.delegate_to, from: day(rule.from_day), until: day(rule.until_day) })}</p>
      <button class="btn" form="${f}" name="action" value="clear">${t('tasks.vacation_clear')}</button>`
    : html`<p class="muted">${t('tasks.vacation_help')}</p>
      <div class="vacation-fields">
        <label>${t('tasks.vacation_to')} <input name="to" form="${f}" maxlength="100" required autocomplete="off"></label>
        <label>${t('tasks.vacation_from')} ${dateField(ctx, { id: `${f}_from`, iso: '', mask: appDateMask(ctx), attrs: html` name="from" form="${f}" required` })}</label>
        <label>${t('tasks.vacation_until')} ${dateField(ctx, { id: `${f}_until`, iso: '', mask: appDateMask(ctx), attrs: html` name="until" form="${f}" required` })}</label>
        <button class="btn" form="${f}" name="action" value="set">${t('tasks.vacation_save')}</button></div>`}
  </details>`;
}

export async function taskRoutes(app: FastifyInstance) {
  // (094) set or remove the user's vacation rule
  app.post('/a/:alias/tasks/vacation', async (req: Req, reply) => {
    const ctx = await loadContext(req, reply, { pageNo: 'home' });
    if (!ctx) return;
    const b = req.body ?? {};
    const next = safeNext(ctx.app, b.next);
    if (b.__csrf !== ctx.session.csrf_token || !['set', 'clear'].includes(String(b.action))) return reply.redirect(next, 303);
    const t = ctx.locale.t;
    // (sprint 84) typed in the application's date format (or YYYY-MM-DD)
    const readDate = appDateReader(ctx);
    const date = (v: unknown) => (typeof v === 'string' && v.length <= 100 ? readDate(v) : null);
    try {
      await appTx(txContext(ctx), async (c) => {
        if (b.action === 'clear') await c.query('select meta.clear_vacation_rule()');
        // whole days in the session's time zone: from the start of the first until the end of the last
        else await c.query('select meta.set_vacation_rule($1, $2::date::timestamptz, ($3::date + 1)::timestamptz)', [String(b.to ?? '').slice(0, 100), date(b.from), date(b.until)]);
      });
      logActivity({ appId: ctx.app.id, username: ctx.user, event: 'task', ip: ctx.ip, detail: `vacation rule ${b.action === 'clear' ? 'removed' : 'set'}` });
      ctx.session.state.__FLASH = t(b.action === 'clear' ? 'tasks.done.vacation_clear' : 'tasks.done.vacation');
    } catch (e) {
      ctx.session.state.__FLASH_ERROR = await publicError(ctx, e, 'vacation rule');
    }
    await saveState(ctx.session);
    return reply.redirect(next, 303);
  });

  app.post('/a/:alias/tasks/:id', async (req: Req, reply) => {
    const ctx = await loadContext(req, reply, { pageNo: 'home' });
    if (!ctx) return;
    const b = req.body ?? {};
    const next = safeNext(ctx.app, b.next);
    const id = String(req.params.id ?? '');
    // (123) a custom outcome: "outcome:<name>" (the definition's outcomes are checked by meta.complete_task)
    const custom = typeof b.action === 'string' && /^outcome:[a-z][a-z0-9_]{0,29}$/i.test(b.action) ? b.action.slice(8).toLowerCase() : null;
    const act = (custom ? 'outcome' : b.action) as Action;
    if (b.__csrf !== ctx.session.csrf_token || !/^\d{1,18}$/.test(id) || !TASK_ACTIONS.includes(act) || (act === 'outcome' && !custom)) return reply.redirect(next, 303);
    const t = ctx.locale.t;
    let failed: string | null = null;
    let failedErr: unknown = null;
    let label: string | null = null;
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
            const outcome = custom ?? (act === 'approve' ? 'approved' : act === 'reject' ? 'rejected' : 'completed');
            // (123) a failing completion SQL with fail events or a recovery: back to one of these savepoints
            await c.query('savepoint task_decision');
            const done = (await c.query<{ r: CompleteResult }>('select meta.complete_task($1, $2, $3) as r', [id, outcome, comment])).rows[0].r;
            label = done.label ?? null;
            // the definition's action, as the application's role, in this transaction: an error undoes the decision
            if (done.action_code?.trim()) {
              const params = Object.fromEntries(Object.entries(done.params ?? {}).map(([k, v]) => [k.toUpperCase(), v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v)]));
              const binds = { ...params, TASK_ID: id, DETAIL_PK: done.detail_pk, OUTCOME: (done.outcome ?? outcome).toUpperCase(), COMMENT: comment, APPROVER: ctx.user, INITIATOR: done.initiator };
              const handled = (done.fail_events?.length ?? 0) > 0 || done.fail_recovery === 'complete';
              if (!handled) await c.query(stripSemicolon(applyBinds(done.action_code, binds)));
              else {
                await c.query('savepoint task_action');
                try {
                  await c.query(stripSemicolon(applyBinds(done.action_code, binds)));
                  await c.query('release savepoint task_action');
                } catch (e) {
                  // (123) the Fail event: undo the SQL's effect (and, to reopen, the decision), log it, run the fail actions
                  failed = (e as Error).message;
                  failedErr = e;
                  await c.query(done.fail_recovery === 'complete' ? 'rollback to savepoint task_action' : 'rollback to savepoint task_decision');
                  await c.query('select meta.log_task_failure($1, $2)', [id, failed]);
                  await runActions(c, (done.fail_events ?? []) as TaskAction[], {
                    ...taskBinds({ id, detail_pk: done.detail_pk, params: done.params, subject: done.subject ?? '', outcome: done.outcome ?? outcome, completed_by: ctx.user, initiator: done.initiator }),
                    EVENT: 'FAIL', ERROR: failed, COMMENT: comment,
                  }, done.detail_pk);
                  if (done.fail_recovery !== 'complete') return;
                }
              }
            }
          }
        }
      });
      logActivity({ appId: ctx.app.id, username: ctx.user, event: 'task', ip: ctx.ip, detail: `${custom ? `outcome ${custom}` : act} ${id}${failed ? ' (failed)' : ''}` });
      if (failed !== null) ctx.session.state.__FLASH_ERROR = t('tasks.done.failed', { error: await publicError(ctx, failedErr, 'task') });
      else ctx.session.state.__FLASH = act === 'outcome' ? t('tasks.done.outcome', { outcome: label ?? custom ?? '' }) : t(`tasks.done.${act}`);
    } catch (e) {
      ctx.session.state.__FLASH_ERROR = await publicError(ctx, e, 'task');
    }
    await saveState(ctx.session);
    return reply.redirect(next, 303);
  });
}
