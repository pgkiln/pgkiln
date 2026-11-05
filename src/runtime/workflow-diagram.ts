// (sprint 160, CD-7) Workflow Diagram region (APEX 24.2+): one workflow instance drawn as its steps, the ones it went
// through (green), where it is now (blue) and a failed step (red); each step's tooltip says when it was reached and
// what happened. config {"instance_item": "P9_WORKFLOW_ID"}. The instance comes through meta.workflows, as the
// application's role: only workflows the user started or administers (the Workflow Console's rule). Server-rendered SVG.
import { owner, savepoint } from '../db.ts';
import { html, type Raw } from '../html.ts';
import type { Region } from '../metadata.ts';
import { workflowDiagram, type Step } from '../workflow.ts';
import { publicError, type PageContext } from './context.ts';
import { cell } from './report.ts';

export async function renderWorkflowDiagram(ctx: PageContext, r: Region): Promise<Raw> {
  const t = ctx.locale.t;
  const itemName = typeof r.config.instance_item === 'string' ? r.config.instance_item.toUpperCase() : '';
  const id = (itemName ? (ctx.session.state[itemName] ?? '') : '').trim();
  if (!/^\d{1,18}$/.test(id)) return html`<p class="empty">${r.config.empty ?? t('workflows.none')}</p>`;
  const c = ctx.client!;
  let w: { id: string; title: string; state: string; current_step: string | null; error: string | null; active_steps: string[] } | undefined;
  let events: { at: string; step: string | null; event: string; detail: string | null }[] = [];
  try {
    w = (await savepoint(c, () => c.query('select id::text, title, state, current_step, error, active_steps from meta.workflows where id = $1::bigint', [id]))).rows[0];
    if (w) events = (await savepoint(c, () => c.query('select at::text, step, event, detail from meta.workflow_events where workflow_id = $1::bigint order by at, id', [id]))).rows;
  } catch (e) {
    return html`<div class="alert alert-error" role="alert">${await publicError(ctx, e, `workflow diagram "${r.title ?? r.id}"`)}</div>`;
  }
  // not one the user may see (or none): the same as no instance
  if (!w) return html`<p class="empty">${r.config.empty ?? t('workflows.none')}</p>`;
  // the steps of its version: only after the view let this user see the instance (the steps hold SQL)
  const steps = (await owner.query<{ steps: Step[] }>('select steps from meta.workflow where id = $1::bigint and app_id = $2', [id, ctx.app.id])).rows[0]?.steps ?? [];
  const reached = new Set(events.filter((e) => e.step).map((e) => e.step!));
  const active = w.state === 'completed' || w.state === 'terminated' ? [] : w.active_steps.length ? w.active_steps : w.current_step ? [w.current_step] : [];
  const failed = w.state === 'faulted' ? active : [];
  const done = [...reached].filter((s) => !active.includes(s));
  const notes = new Map<string, string>();
  // events without a step (started, terminated) belong to the first step's history
  for (const e of events) {
    const step = e.step ?? steps[0]?.name;
    if (step) notes.set(step, [notes.get(step), `${cell(e.at, 1184, ctx.locale.format)}: ${e.event}${e.detail ? ` (${e.detail})` : ''}`].filter(Boolean).join('\n'));
  }
  return html`<div class="wf-wrap wf-instance" data-state="${w.state}">
    <p class="muted u-mt0">${w.title} · ${t(`workflows.state.${w.state}`)}</p>
    ${w.error ? html`<div class="alert alert-error" role="alert">${w.error}</div>` : ''}
    ${workflowDiagram(steps, { active: failed.length ? [] : active, failed, done, notes, id: `r${r.id}` })}
  </div>`;
}
