import { owner } from '../db.ts';
import { html } from '../html.ts';
import { scopedTx as tx } from './i18n.ts';

// Page designer → a background chain process → "Jobs": the last runs of the
// chain for every user (meta.process_job; process-jobs.ts runs them).

const when = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 19).replace('T', ' ') + ' UTC' : '—');

export async function processJobsPanel(processId: number) {
  const jobs = (
    await owner.query(
      `select id, state, app_user, queued_at, started_at, ended_at, steps_done, steps_total, current, message, error
         from meta.process_job where process_id = $1 order by id desc limit 20`,
      [processId],
    )
  ).rows;
  const off = process.env.BACKGROUND_PROCESSES === 'off' ? html`<p><b>${tx('pjb.off')}</b></p>` : '';
  return html`${off}${jobs.length
    ? html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>${tx('pjb.job')}</th><th>${tx('pjb.state')}</th><th>${tx('pjb.by')}</th><th>${tx('pjb.queued')}</th><th>${tx('pjb.took')}</th><th>${tx('pjb.steps')}</th><th>${tx('pjb.message')}</th></tr></thead><tbody>
        ${jobs.map((j) => html`<tr>
          <td data-label="${tx('pjb.job')}">${j.id}</td>
          <td data-label="${tx('pjb.state')}"><span class="tag${j.state === 'failed' ? ' tag-error' : ''}">${j.state}</span></td>
          <td data-label="${tx('pjb.by')}">${j.app_user}</td>
          <td data-label="${tx('pjb.queued')}">${when(j.queued_at)}</td>
          <td data-label="${tx('pjb.took')}">${j.started_at && j.ended_at ? `${((new Date(j.ended_at).getTime() - new Date(j.started_at).getTime()) / 1000).toFixed(1)} s` : j.started_at ? '…' : ''}</td>
          <td data-label="${tx('pjb.steps')}">${j.steps_done}/${j.steps_total}${j.current ? ` (${j.current})` : ''}</td>
          <td data-label="${tx('pjb.message')}">${j.error ?? j.message ?? ''}</td></tr>`)}
      </tbody></table></div>`
    : html`<p class="muted">${tx('pjb.no_runs')}</p>`}`;
}
