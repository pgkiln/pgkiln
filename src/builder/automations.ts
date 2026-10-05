import type { FastifyInstance } from 'fastify';
import { nextRun, parseCron, runAutomation, type RowError } from '../automations.ts';
import { owner } from '../db.ts';
import { html, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import type { Session } from '../session.ts';
import { back, BASE, csrf, developer, flash, type Req } from './ui.ts';

// Shared Components → Automations: the actions (add, edit, reorder),
// next run, Run now and the run history with the errors per row, under the
// generic component form (components.ts). Actions are edited with the
// generic form too (kind automation_action).

const when = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 19).replace('T', ' ') + ' UTC' : '—');
const STATUS_TAG: Record<string, string> = { error: ' tag-error', warning: ' tag-warning', ok: ' tag-ok' };

/** The prefilled values of a new action of an automation: the automation and the next sequence. */
export function actionPrefill(automation: string, actions: any[]) {
  const own = actions.filter((x) => x.automation_name === automation);
  return { automation_name: automation, seq: (own.length ? Math.max(...own.map((x) => Number(x.seq) || 0)) : 0) + 10, name: own.length ? '' : 'Action' };
}

/** Under an action's form: back to its automation. */
export function actionExtras(row: any, automations: any[]): Raw {
  const a = automations.find((x) => x.name === row.automation_name);
  return a ? html`<p class="u-mt1"><a class="btn" href="?c=automation-${a.id}">${icon('clock')} Back to ${a.name}</a></p>` : html``;
}

function rowErrors(errors: RowError[] | null, failed: number | null): Raw {
  if (!errors?.length) return html``;
  return html`<details><summary>${failed ?? errors.length} failed row(s)${failed && failed > errors.length ? ` (first ${errors.length})` : ''}</summary>
    <ul class="small">${errors.map((e) => html`<li>Row ${e.row}, action <b>${e.action}</b>: ${e.message}${e.values ? html`<br><code>${e.values}</code>` : ''}</li>`)}</ul></details>`;
}

/** Actions, next run, Run now and the last runs of an automation. */
export async function automationExtras(appId: number, row: { id: number; name: string; enabled: boolean; schedule: string; time_zone: string; query: string | null; error_handling: string }, s: Session, allActions: any[]) {
  const actions = allActions.filter((x) => x.automation_name === row.name);
  const log = (
    await owner.query(
      `select started_at, finished_at, trigger, status, rows, rows_failed, errors, message, run_by from meta.automation_log where automation_id = $1 order by started_at desc, id desc limit 20`,
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
  const move = (id: number, dir: 'up' | 'down', label: string, disabled: boolean) =>
    html`<form method="post" action="${BASE}/apps/${appId}/shared/automation_action/${id}/move" class="u-inline">${csrf(s)}<input type="hidden" name="dir" value="${dir}"><button class="link-button" aria-label="${label}"${disabled ? html` disabled` : ''}>${dir === 'up' ? '↑' : '↓'}</button></form>`;
  const actionsHtml = html`<fieldset class="prop-group u-mt125"><legend>Actions</legend>
      <p class="muted u-mt0">Run in this order${row.query?.trim() ? ', for each row of the query' : ', once'}, in one transaction${row.error_handling === 'skip' && row.query?.trim() ? ' per run; a failing row is rolled back and skipped' : ''}.</p>
      ${actions.length
        ? html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th class="num">Seq</th><th>Action</th><th>Condition</th><th>Order</th></tr></thead><tbody>
            ${actions.map((x, i) => html`<tr>
              <td class="num" data-label="Seq">${x.seq}</td>
              <td data-label="Action"><a href="?c=automation_action-${x.id}">${x.name}</a></td>
              <td data-label="Condition">${x.condition ? html`<code>${x.condition.length > 80 ? x.condition.slice(0, 80) + '…' : x.condition}</code>` : html`<span class="muted">always</span>`}</td>
              <td data-label="Order">${move(x.id, 'up', `Move ${x.name} up`, i === 0)} ${move(x.id, 'down', `Move ${x.name} down`, i === actions.length - 1)}</td></tr>`)}
          </tbody></table></div>`
        : html`<p class="muted">No actions yet: a run does nothing.</p>`}
      <p><a class="btn" href="?new=automation_action&amp;automation=${encodeURIComponent(row.name)}">＋ Add action</a></p>
    </fieldset>`;
  return html`${actionsHtml}<fieldset class="prop-group u-mt125"><legend>Runs</legend>
      <p>Next run: <b>${next}</b>${scheduler}</p>
      <p class="muted">From application code: <code>select meta.run_automation('${row.name}')</code> runs it now, in the caller's transaction.</p>
      <form method="post" action="${BASE}/apps/${appId}/shared/automation/${row.id}/run">${csrf(s)}
        <button class="btn">${icon('play')} Run now</button>
      </form>
      ${log.length
        ? html`<div class="table-wrap u-mt075"><table class="report report-reflow"><thead><tr><th>Started</th><th>Took</th><th>By</th><th>Status</th><th class="num">Rows</th><th class="num">Failed</th><th>Message</th></tr></thead><tbody>
            ${log.map((l) => html`<tr>
              <td data-label="Started">${when(l.started_at)}</td>
              <td data-label="Took">${l.finished_at ? `${((new Date(l.finished_at).getTime() - new Date(l.started_at).getTime()) / 1000).toFixed(1)} s` : '…'}</td>
              <td data-label="By">${l.trigger}${l.run_by ? html` <span class="muted">(${l.run_by})</span>` : ''}</td>
              <td data-label="Status"><span class="tag${STATUS_TAG[l.status] ?? ''}">${l.status}</span></td>
              <td class="num" data-label="Rows">${l.rows ?? ''}</td>
              <td class="num" data-label="Failed">${l.rows_failed || ''}</td>
              <td data-label="Message">${l.message ?? ''}${rowErrors(l.errors, l.rows_failed)}</td></tr>`)}
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
    else if (r.status === 'warning') flash(s, `Ran with errors: ${r.message}. See the run history.`, 'error');
    else flash(s, r.message ?? 'The automation failed.', 'error');
    return back(reply, s, target);
  });

  // reorder: swap an action with its neighbour (sequences renumbered 10, 20, …)
  app.post(`${BASE}/apps/:id/shared/automation_action/:cid/move`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const { id, cid } = req.params as { id: string; cid: string };
    const up = req.body?.dir === 'up';
    const act = /^\d+$/.test(id) && /^\d+$/.test(cid) ? await owner.one('select id, automation_name from meta.automation_action where id = $1 and app_id = $2', [cid, id]) : undefined;
    if (!act) return reply.code(404).send('Not found');
    await owner.tx(async (c) => {
      const ids: number[] = (
        await c.query('select id from meta.automation_action where app_id = $1 and automation_name = $2 order by seq, name for update', [id, act.automation_name])
      ).rows.map((r) => r.id);
      const i = ids.indexOf(act.id);
      const j = up ? i - 1 : i + 1;
      if (j >= 0 && j < ids.length) [ids[i], ids[j]] = [ids[j], ids[i]];
      await c.query('update meta.automation_action x set seq = m.n * 10 from unnest($1::int[]) with ordinality as m(id, n) where x.id = m.id', [ids]);
    });
    const auto = await owner.one('select id from meta.automation where app_id = $1 and name = $2', [id, act.automation_name]);
    return back(reply, s, `${BASE}/apps/${id}/shared?c=automation-${auto?.id ?? ''}`);
  });
}
