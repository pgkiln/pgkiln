import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw } from '../html.ts';
import { icon } from '../icons.ts';
import { appOr404 } from './forms.ts';
import { issuesFrom } from '../team.ts';
import { toIssueButton } from './team.ts';
import { appHeader, back, BASE, csrf, developer, flash, region, select, send, shell, type Req } from './ui.ts';

// Application → Feedback (APEX: Team Development → Feedback, migration 084):
// switch the application's Feedback link on or off, read what users sent
// (newest first, filtered by status and kind), and answer it with a status
// and a response the user sees on the feedback page. Answers are data, not
// a change of the application: allowed while it is locked or Run only.

const STATUSES: [string, string][] = [['open', 'Open'], ['in_progress', 'In progress'], ['done', 'Done'], ['declined', 'Declined']];
const KINDS: [string, string][] = [['comment', 'Comment'], ['idea', 'Idea'], ['problem', 'Problem']];
const when = (d: string | Date) => new Date(d).toISOString().slice(0, 16).replace('T', ' ');

export async function feedbackRoutes(app: FastifyInstance) {
  app.get(`${BASE}/apps/:id(^\\d+$)/feedback`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOr404(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const status = STATUSES.some(([v]) => v === req.query.status) ? String(req.query.status) : '';
    const kind = KINDS.some(([v]) => v === req.query.kind) ? String(req.query.kind) : '';
    const rows = (await owner.query(
      `select * from meta.feedback where app_id = $1 and ($2 = '' or status = $2) and ($3 = '' or kind = $3) order by created_at desc limit 300`,
      [a.id, status, kind])).rows;
    const counts = (await owner.query(`select status, count(*)::int as n from meta.feedback where app_id = $1 group by 1`, [a.id])).rows;
    const count = (st: string) => counts.find((c) => c.status === st)?.n ?? 0;
    // (sprint 113) feedback turned into a Team Development issue links to it
    const issues = await issuesFrom('feedback', rows.map((f) => Number(f.id)));
    const body = html`
      ${region('Feedback', html`
        <form method="post" action="${BASE}/apps/${a.id}/feedback/settings" class="u-mb1">${csrf(s)}
          <label class="check"><input type="checkbox" name="feedback" value="true"${a.feedback ? raw(' checked') : ''}> Users can send feedback</label>
          <small class="help">A <b>Feedback</b> link in the application's navigation bar opens a page for a comment, an idea or a problem about the page the user came from, with their earlier feedback and your answers.</small>
          <div class="buttons"><button class="btn btn-sm">Save</button></div></form>
        <p class="muted">${count('open')} open, ${count('in_progress')} in progress, ${count('done')} done, ${count('declined')} declined.</p>
        <form method="get" class="filter-row">
          ${select('status', 'Status', status, [['', 'All'], ...STATUSES])}
          ${select('kind', 'Kind', kind, [['', 'All'], ...KINDS])}
          <button class="btn btn-sm">${icon('filter')} Show</button></form>
        ${rows.length ? html`<ul class="feedback-admin">${rows.map((f) => html`<li class="feedback-item" id="feedback-${f.id}">
          <div class="feedback-meta"><span class="tag">${KINDS.find(([v]) => v === f.kind)?.[1]}</span>
            <b>${f.username}</b> <span class="muted">${when(f.created_at)}${f.page_no ? html` · <a href="/a/${a.alias}/${f.page_no}" target="_blank" rel="noopener">page ${f.page_no}</a>` : ''}${f.rating ? ` · ${'★'.repeat(f.rating)}` : ''}${f.user_agent ? ` · ${f.user_agent}` : ''}</span></div>
          <p class="feedback-body">${f.body}</p>
          <p class="feedback-issue">${toIssueButton(s, 'feedback', Number(f.id), issues.get(Number(f.id)))}</p>
          <form method="post" action="${BASE}/apps/${a.id}/feedback/${f.id}">${csrf(s)}
            <div class="form-grid">
              ${select('status', 'Status', f.status, STATUSES)}
              <div class="field" data-wide><label class="label" for="f_response_${f.id}">Answer (the user sees it)</label>
                <textarea id="f_response_${f.id}" name="response" rows="2" maxlength="4000">${f.response ?? ''}</textarea>
                ${f.responded_by ? html`<small class="help">By ${f.responded_by}, ${when(f.responded_at)}</small>` : ''}</div>
            </div>
            <div class="buttons"><button class="btn btn-sm btn-hot">Save</button></div></form>
        </li>`)}</ul>` : html`<p class="muted">No feedback${status || kind ? ' with these filters' : ' yet'}.</p>`}`)}`;
    const main = html`${appHeader(a, 'activity', s)}<div class="ide-body">${body}</div>`;
    return send(reply, s, shell(s, `${a.name} feedback`, [['App Builder', BASE], [a.name, `${BASE}/apps/${a.id}`], ['Activity', `${BASE}/apps/${a.id}/activity`], ['Feedback']], main));
  });

  app.post(`${BASE}/apps/:id(^\\d+$)/feedback/settings`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    await owner.query('update meta.app set feedback = $2, updated_at = now() where id = $1', [req.params.id, req.body?.feedback === 'true']);
    flash(s, 'Saved.');
    return back(reply, s, `${BASE}/apps/${req.params.id}/feedback`);
  });

  app.post(`${BASE}/apps/:id(^\\d+$)/feedback/:fid(^\\d+$)`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = req.body ?? {};
    const status = STATUSES.some(([v]) => v === b.status) ? b.status : 'open';
    const response = String(b.response ?? '').replace(/\r\n?/g, '\n').trim().slice(0, 4000) || null;
    const r = await owner.query(
      `update meta.feedback set status = $3, response = $4,
              responded_by = case when $4::text is distinct from response then $5 else responded_by end,
              responded_at = case when $4::text is distinct from response then now() else responded_at end
        where id = $2 and app_id = $1`,
      [req.params.id, req.params.fid, status, response, s.username]);
    flash(s, r.rowCount ? 'Saved.' : 'Not found.', r.rowCount ? 'ok' : 'error');
    return back(reply, s, `${BASE}/apps/${req.params.id}/feedback`);
  });
}
