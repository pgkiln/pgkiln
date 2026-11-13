import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw } from '../html.ts';
import { clientIp, logActivity } from '../session.ts';
import { back, BASE, csrf, developer, flash, region, send, shell, workshopTabs, type Req } from './ui.ts';
import { restNav } from './rest-modules.ts';
import { currentWorkspace } from './workspaces.ts';
import { tr, type BuilderTranslate } from './i18n.ts';

// (sprint 177, migration 160) SQL Workshop › RESTful Services › Web requests: the outbox of meta.web_request for
// the applications of the developer's workspace (never another workspace's: the query keys on the session's
// workspace). Each request with its status, attempts, next attempt and last error, and its callback's state.
// Re-queue sends a request that gave up, failed or was cancelled again (from its first attempt); Cancel stops one
// that waits; Call again runs a failed callback once more (the request itself is not sent again). Responses are
// not shown here: the application reads them with meta.web_response.

export const REQUESTS = `${BASE}/sql/rest/requests`;
const STATES = ['queued', 'running', 'retry', 'ok', 'error', 'gave_up', 'cancelled'] as const;
type State = (typeof STATES)[number];
const WAITING: readonly string[] = ['queued', 'retry'];
const ENDED: readonly string[] = ['error', 'gave_up', 'cancelled'];
const LIST = 200;

interface Row {
  id: string;
  app_id: number;
  alias: string;
  status: State;
  method: string;
  url: string | null;
  source: string | null;
  attempts: number;
  max_attempts: number | null;
  status_code: number | null;
  message: string | null;
  requested: string;
  requested_by: string | null;
  next: string | null;
  ordering_key: string | null;
  callback: string | null;
  callback_state: string | null;
  callback_error: string | null;
}

const stateTag = (tx: BuilderTranslate, st: string) =>
  html`<span class="tag ${st === 'ok' || st === 'done' ? 'tag-ok' : st === 'error' || st === 'gave_up' || st === 'failed' ? 'tag-error' : st === 'retry' ? 'tag-warning' : 'tag-info'}">${tx.dyn(`wq.state.${st}`, st)}</span>`;

/** The URL without its query string (it may carry a key), shortened. */
const target = (r: Pick<Row, 'url' | 'source'>) => {
  if (r.source) return r.source;
  const u = (r.url ?? '').split(/[?#]/)[0];
  return u.length > 120 ? `${u.slice(0, 119)}…` : u;
};

export async function webRequestRoutes(app: FastifyInstance) {
  app.get(REQUESTS, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const tx = tr(s);
    const state = (STATES as readonly string[]).includes(String(req.query.state)) ? String(req.query.state) : '';
    const rows = (await owner.query<Row>(
      `select l.id::text, l.app_id, a.alias, l.status, l.method, l.url, l.source, l.attempts, l.max_attempts, l.status_code, l.message,
              to_char(l.requested_at, 'YYYY-MM-DD HH24:MI:SS') as requested, l.requested_by,
              to_char(l.next_attempt_at, 'YYYY-MM-DD HH24:MI:SS') as next, l.ordering_key, l.callback, l.callback_state, l.callback_error
         from meta.web_request_log l join meta.app a on a.id = l.app_id
        where meta.app_workspace(a.id) = $1 and ($2 = '' or l.status = $2)
        order by l.id desc limit ${LIST}`, [currentWorkspace(s), state])).rows;
    const counts = new Map((await owner.query<{ status: string; n: number }>(
      `select l.status, count(*)::int as n from meta.web_request_log l join meta.app a on a.id = l.app_id where meta.app_workspace(a.id) = $1 group by 1`,
      [currentWorkspace(s)])).rows.map((r) => [r.status, r.n]));
    const L = { app: tx('sm.col.application'), request: tx('wq.col.request'), state: tx('sm.col.state'), attempts: tx('wq.col.attempts'), next: tx('wq.col.next'), result: tx('wq.col.result'), actions: tx('wq.col.actions') };
    const act = (r: Row, action: string, label: string, confirm?: string) =>
      html`<form method="post" action="${REQUESTS}/${r.id}" class="inline-form">${csrf(s)}<input type="hidden" name="state" value="${state}">${confirm
        ? html`<button class="btn btn-sm" name="action" value="${action}" data-confirm="${confirm}">${label}</button>`
        : html`<button class="btn btn-sm" name="action" value="${action}">${label}</button>`}</form>`;
    const filter = html`<nav class="settings-tabs" aria-label="${tx('wq.filter')}">
      <a href="${REQUESTS}"${state === '' ? raw(' aria-current="page"') : ''}>${tx('wq.all')}</a>
      ${STATES.filter((k) => counts.has(k) || k === state).map((k) => html`<a href="${REQUESTS}?state=${k}"${state === k ? raw(' aria-current="page"') : ''}>${tx.dyn(`wq.state.${k}`, k)} (${counts.get(k) ?? 0})</a>`)}</nav>`;
    const table = rows.length
      ? html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>${L.app}</th><th>${L.request}</th><th>${L.state}</th><th>${L.attempts}</th><th>${L.next}</th><th>${L.result}</th><th>${L.actions}</th></tr></thead><tbody>
          ${rows.map((r) => html`<tr>
            <td data-label="${L.app}"><a href="${BASE}/apps/${r.app_id}">${r.alias}</a></td>
            <td data-label="${L.request}" class="u-break wrap-anywhere"><code>${r.source ? 'SOURCE' : r.method}</code> ${target(r)}<br>
              <span class="muted small">#${r.id} · ${r.requested}${r.requested_by ? ` · ${r.requested_by}` : ''}${r.ordering_key ? ` · ${tx('wq.key', { key: r.ordering_key })}` : ''}</span></td>
            <td data-label="${L.state}">${stateTag(tx, r.status)}</td>
            <td data-label="${L.attempts}">${r.attempts}${r.max_attempts ? ` / ${r.max_attempts}` : ''}</td>
            <td data-label="${L.next}">${r.status === 'retry' ? r.next ?? '' : ''}</td>
            <td data-label="${L.result}" class="u-break wrap-anywhere">${r.status_code ? html`<b>${r.status_code}</b> ` : ''}${r.message ? html`<span class="small">${r.message.slice(0, 300)}</span>` : ''}
              ${r.callback ? html`<br><span class="muted small"><code>${r.callback}</code></span> ${r.callback_state ? stateTag(tx, r.callback_state) : ''}${r.callback_error && r.callback_state !== 'done' ? html` <span class="small">${r.callback_error.slice(0, 300)}</span>` : ''}` : ''}</td>
            <td data-label="${L.actions}">${ENDED.includes(r.status) ? act(r, 'requeue', tx('wq.requeue'), tx('wq.requeue_confirm')) : ''}${WAITING.includes(r.status) ? act(r, 'cancel', tx('wq.cancel')) : ''}${r.callback_state === 'failed' ? act(r, 'callback', tx('wq.call_again')) : ''}</td></tr>`)}
        </tbody></table></div>${rows.length === LIST ? html`<p class="muted small">${tx('wq.latest', { n: LIST })}</p>` : ''}`
      : html`<p class="muted">${tx('wq.none')}</p>`;
    const main = html`<h1 class="u-mb1">${tx('rail.sql_workshop')}</h1>${workshopTabs('rest', s)}${restNav('requests', tx)}
      <p class="muted">${tx.code('wq.intro')}</p>${filter}${region(tx('wq.title'), table)}`;
    return send(reply, s, shell(s, tx('wq.title'), [[tx('rail.sql_workshop'), `${BASE}/sql`], [tx('sql.tool.rest'), `${BASE}/sql/rest`], [tx('wq.title')]], main, 'sql'));
  });

  // re-queue, cancel, call the callback again: only a request of an application of the session's workspace
  app.post(`${REQUESTS}/:id`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const tx = tr(s);
    const id = /^\d{1,18}$/.test(req.params.id) ? req.params.id : '0';
    const action = String(req.body?.action ?? '');
    const state = (STATES as readonly string[]).includes(String(req.body?.state)) ? `?state=${req.body!.state}` : '';
    const mine = `id = $1 and app_id in (select a.id from meta.app a where meta.app_workspace(a.id) = $2)`;
    const sql = action === 'requeue'
      ? `update meta.web_request_log set status = 'queued', attempts = 0, next_attempt_at = null, finished_at = null, started_at = null, lease_until = null, message = null,
                status_code = null, response_url = null, response_headers = null, response_body = null,
                callback_state = null, callback_attempts = 0, callback_next_at = null, callback_error = null, requested_at = now()
          where ${mine} and status in ('error', 'gave_up', 'cancelled') returning app_id`
      : action === 'cancel'
        ? `update meta.web_request_log set status = 'cancelled', finished_at = now(), next_attempt_at = null, message = coalesce(message, 'Cancelled.')
            where ${mine} and status in ('queued', 'retry') returning app_id`
        : action === 'callback'
          ? `update meta.web_request_log set callback_state = 'pending', callback_attempts = 0, callback_next_at = null where ${mine} and callback_state = 'failed' returning app_id`
          : null;
    if (!sql) return reply.code(400).send('Bad request');
    const done = await owner.one<{ app_id: number }>(sql, [id, currentWorkspace(s)]);
    if (!done) flash(s, tx('wq.not_changed'), 'error');
    else {
      if (action !== 'cancel') await owner.query(`select pg_notify('pgkiln_web_request', '')`);
      await logActivity({ appId: done.app_id, username: s.username, event: 'web_request', ip: clientIp(req), detail: `web request ${id}: ${action}` });
      flash(s, tx(action === 'requeue' ? 'wq.requeued' : action === 'cancel' ? 'wq.cancelled' : 'wq.callback_queued'));
    }
    return back(reply, s, `${REQUESTS}${state}`);
  });
}
