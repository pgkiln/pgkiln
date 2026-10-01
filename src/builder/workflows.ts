import { owner } from '../db.ts';
import { html } from '../html.ts';
import { stepProblems, workflowDiagram, type Step } from '../workflow.ts';

// Shared Components → Workflows: the diagram of the steps, problems with
// them, and how many instances there are.

export async function workflowExtras(appId: number, row: { id: number; steps: Step[] }) {
  const tasks = new Set((await owner.query('select name from meta.task_definition where app_id = $1', [appId])).rows.map((r) => r.name as string));
  const problems = stepProblems(row.steps, tasks);
  const counts = (await owner.query('select state, count(*)::int as n from meta.workflow where definition_id = $1 group by 1 order by 1', [row.id])).rows;
  return html`<fieldset class="prop-group u-mt125"><legend>Diagram</legend>
    ${problems.length ? html`<div class="alert alert-error" role="alert"><ul class="u-m0">${problems.map((p) => html`<li>${p}</li>`)}</ul></div>` : ''}
    <div class="wf-wrap">${workflowDiagram(row.steps)}</div>
    <p class="muted small">Instances: ${counts.length ? counts.map((c, i) => html`${i ? ', ' : ''}${c.n} ${c.state}`) : 'none yet'}. Running instances keep the steps they started with.</p>
  </fieldset>`;
}
