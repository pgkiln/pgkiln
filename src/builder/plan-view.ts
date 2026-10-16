import { html, raw, type Raw } from '../html.ts';
import type { Plan, PlanNode } from '../sqlplan.ts';

// (sprint 92, DA-4; shared since sprint 102) A query plan (src/sqlplan.ts) drawn as a tree: the SQL Worksheet's
// Explain Plan and Autotrace tabs and the Database Monitor's statement page. Styles: .ws-plan-* in worksheet.css.

const fmtMs = (n: number) => (n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(1) : n.toFixed(3));

/** (sprint 92, DA-4) A plan as a tree of steps (open), with the text plan behind a toggle. */
export function planView(plan: Plan, text: string): Raw {
  const step = (n: PlanNode): Raw => html`<li><details open${n.slowest ? raw(' class="is-slowest"') : ''}>
    <summary><span class="ws-plan-op">${n.op}</span>${n.target ? html` <span class="ws-plan-target">${n.target}</span>` : ''}
      <span class="ws-plan-nums">cost ${n.startupCost.toFixed(2)}..${n.totalCost.toFixed(2)} · rows ${n.planRows} · width ${n.width}${plan.analyze
        ? n.neverRun ? html` · <em>never executed</em>` : html` · <strong>${fmtMs(n.actualTotal ?? 0)} ms</strong> × ${n.loops} · ${n.actualRows} row${n.actualRows === 1 ? '' : 's'}${n.selfMs !== undefined ? ` · self ${fmtMs(n.selfMs)} ms` : ''}${n.sharedHit || n.sharedRead ? ` · buffers ${n.sharedHit ?? 0} hit${n.sharedRead ? `, ${n.sharedRead} read` : ''}` : ''}`
        : ''}</span>
      ${n.slowest ? html`<span class="tag tag-warn">slowest step</span>` : ''}
      ${n.misestimate ? html`<span class="tag tag-warn" title="Estimated ${n.planRows} rows, got ${n.actualRows}: ANALYZE the table, or look at the statistics">estimate ${n.misestimate >= 1 ? `${Math.round(n.misestimate)}× too high` : `${Math.round(1 / n.misestimate)}× too low`}</span>` : ''}
    </summary>
    ${n.details.length ? html`<dl class="ws-plan-details">${n.details.map(([k, v]) => html`<dt>${k}</dt><dd><code>${v}</code></dd>`)}</dl>` : ''}
    ${n.children.length ? html`<ul class="ws-plan-tree">${n.children.map(step)}</ul>` : ''}
  </details></li>`;
  return html`${plan.planningMs !== undefined || plan.executionMs !== undefined ? html`<p class="muted small ws-info">${plan.planningMs !== undefined ? `Planning ${fmtMs(plan.planningMs)} ms` : ''}${plan.executionMs !== undefined ? ` · execution ${fmtMs(plan.executionMs)} ms (rolled back)` : ''}</p>` : ''}
    <ul class="ws-plan-tree ws-plan-root">${step(plan.root)}</ul>
    <details class="ws-plan-text"><summary>Text plan</summary><pre class="ws-log ws-plan">${text}</pre></details>`;
}
