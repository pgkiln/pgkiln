import type { FastifyInstance } from 'fastify';
import { nextRun, parseCron, runAutomation } from '../automations.ts';
import { owner } from '../db.ts';
import { html } from '../html.ts';
import { icon } from '../icons.ts';
import type { Session } from '../session.ts';
import { back, BASE, csrf, developer, flash, type Req } from './ui.ts';

// Shared Components → Automations: next run, Run now and the run history
// under the generic component form (components.ts).

const when = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 19).replace('T', ' ') + ' UTC' : '—');

/** Next run, Run now and the last runs of an automation. */
export async function automationExtras(appId: number, row: { id: number; enabled: boolean; schedule: string; time_zone: string }, s: Session) {
  const log = (
    await owner.query(
      `select started_at, finished_at, trigger, status, rows, message from meta.automation_log where automation_id = $1 order by started_at desc, id desc limit 20`,
      [row.id],
    )
  ).rows;
  let next: string;
  try {
    next = row.enabled ? when(nextRun(parseCron(row.schedule), row.time_zone, new Date())) : 'not scheduled (disabled)';
  } catch (e) {
    next = `never: ${(e as Error).message}`;
  }
  const scheduler = process.env.AUTOMATIONS === 'off' ? html` <b>(the scheduler is off on this server: AUTOMATIONS=off)</b>` : '';
  return html`<fieldset class="prop-group u-mt125"><legend>Runs</legend>
      <p>Next run: <b>${next}</b>${scheduler}</p>
      <form method="post" action="${BASE}/apps/${appId}/shared/automation/${row.id}/run">${csrf(s)}
        <button class="btn">${icon('play')} Run now</button>
      </form>
      ${log.length
        ? html`<div class="table-wrap u-mt075"><table class="report report-reflow"><thead><tr><th>Started</th><th>Took</th><th>By</th><th>Status</th><th class="num">Rows</th><th>Message</th></tr></thead><tbody>
            ${log.map((l) => html`<tr>
              <td data-label="Started">${when(l.started_at)}</td>
              <td data-label="Took">${l.finished_at ? `${((new Date(l.finished_at).getTime() - new Date(l.started_at).getTime()) / 1000).toFixed(1)} s` : '…'}</td>
              <td data-label="By">${l.trigger}</td>
              <td data-label="Status"><span class="tag${l.status === 'error' ? ' tag-error' : ''}">${l.status}</span></td>
              <td class="num" data-label="Rows">${l.rows ?? ''}</td>
              <td data-label="Message">${l.message ?? ''}</td></tr>`)}
          </tbody></table></div>`
        : html`<p class="muted">No runs yet.</p>`}
    </fieldset>`;
}

export async function automationRoutes(app: FastifyInstance) {
  app.post(`${BASE}/apps/:id/shared/automation/:cid/run`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const { id, cid } = req.params as { id: string; cid: string };
    const target = `${BASE}/apps/${id}/shared?c=automation-${cid}`;
    const a = /^\d+$/.test(id) && /^\d+$/.test(cid) ? await owner.one('select id from meta.automation where id = $1 and app_id = $2', [cid, id]) : undefined;
    if (!a) return reply.code(404).send('Not found');
    const r = await runAutomation(a.id, 'manual');
    if (r.status === 'ok') flash(s, `Ran successfully${r.rows ? ` for ${r.rows} row(s)` : ''}.`);
    else flash(s, r.message ?? 'The automation failed.', 'error');
    return back(reply, s, target);
  });
}
