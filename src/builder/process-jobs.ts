import { owner } from '../db.ts';
import { html } from '../html.ts';

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
  const off = process.env.BACKGROUND_PROCESSES === 'off' ? html`<p><b>Background processes are off on this server (BACKGROUND_PROCESSES=off).</b></p>` : '';
  return html`${off}${jobs.length
    ? html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>Job</th><th>State</th><th>By</th><th>Queued</th><th>Took</th><th>Steps</th><th>Message</th></tr></thead><tbody>
        ${jobs.map((j) => html`<tr>
          <td data-label="Job">${j.id}</td>
          <td data-label="State"><span class="tag${j.state === 'failed' ? ' tag-error' : ''}">${j.state}</span></td>
          <td data-label="By">${j.app_user}</td>
          <td data-label="Queued">${when(j.queued_at)}</td>
          <td data-label="Took">${j.started_at && j.ended_at ? `${((new Date(j.ended_at).getTime() - new Date(j.started_at).getTime()) / 1000).toFixed(1)} s` : j.started_at ? '…' : ''}</td>
          <td data-label="Steps">${j.steps_done}/${j.steps_total}${j.current ? ` (${j.current})` : ''}</td>
          <td data-label="Message">${j.error ?? j.message ?? ''}</td></tr>`)}
      </tbody></table></div>`
    : html`<p class="muted">No runs yet.</p>`}`;
}
