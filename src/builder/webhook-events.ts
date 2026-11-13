import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw } from '../html.ts';
import { clientIp, logActivity } from '../session.ts';
import { bodyText } from '../webhooks.ts';
import { back, BASE, csrf, developer, flash, region, send, shell, workshopTabs, type Req } from './ui.ts';
import { MODULES, restNav } from './rest-modules.ts';
import { currentWorkspace } from './workspaces.ts';
import { tr, type BuilderTranslate } from './i18n.ts';

// (sprint 177, migration 161) SQL Workshop › RESTful Services › Webhook events: the events the webhook handlers
// of the workspace's applications received (meta.webhook_event), per handler, with their state, attempts and
// error. An event's page shows the headers kept and the body; Re-process queues a failed (or done) event again.
// Only developers of the application's workspace see events and bodies: every query keys on the session's
// workspace. The signing secret is a web credential's and is never shown.

export const EVENTS = `${BASE}/sql/rest/events`;
const STATES = ['received', 'running', 'retry', 'done', 'failed'] as const;
const LIST = 200;
const BODY_SHOWN = 20_000;

interface Row {
  id: string;
  app_id: number;
  alias: string;
  module: string;
  module_id: number | null;
  path: string;
  event_key: string | null;
  received: string;
  state: string;
  attempts: number;
  max_attempts: number;
  next: string | null;
  error: string | null;
  size: number;
  /** (sprint 180) the module is disabled: the event waits until it is enabled again */
  held: boolean;
}

const stateTag = (tx: BuilderTranslate, st: string) =>
  html`<span class="tag ${st === 'done' ? 'tag-ok' : st === 'failed' ? 'tag-error' : st === 'retry' ? 'tag-warning' : 'tag-info'}">${tx.dyn(`whk.state.${st}`, st)}</span>`;

const COLUMNS = `e.id::text, e.app_id, a.alias, e.module, (select m.id from meta.rest_module m where m.app_id = e.app_id and m.name = e.module) as module_id, e.path, e.event_key,
  to_char(e.received_at, 'YYYY-MM-DD HH24:MI:SS') as received, e.state, e.attempts, e.max_attempts,
  to_char(e.next_attempt_at, 'YYYY-MM-DD HH24:MI:SS') as next, e.error, octet_length(e.body) as size,
  (e.state in ('received', 'retry') and exists (select 1 from meta.rest_module m where m.app_id = e.app_id and m.name = e.module and not m.enabled)) as held`;
/** Events of applications of the session's workspace only. */
const MINE = `meta.app_workspace(a.id) = $1`;

export async function webhookEventRoutes(app: FastifyInstance) {
  app.get(EVENTS, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const tx = tr(s);
    const state = (STATES as readonly string[]).includes(String(req.query.state)) ? String(req.query.state) : '';
    const moduleId = /^\d{1,9}$/.test(String(req.query.module)) ? Number(req.query.module) : null;
    const path = typeof req.query.path === 'string' ? req.query.path.slice(0, 200) : null;
    const rows = (await owner.query<Row>(
      `select ${COLUMNS} from meta.webhook_event e join meta.app a on a.id = e.app_id
        where ${MINE} and ($2 = '' or e.state = $2)
          and ($3::int is null or exists (select 1 from meta.rest_module m where m.id = $3 and m.app_id = e.app_id and m.name = e.module))
          and ($4::text is null or e.path = $4)
        order by e.id desc limit ${LIST}`, [currentWorkspace(s), state, moduleId, path])).rows;
    const qs = (st: string) => {
      const p = new URLSearchParams();
      if (st) p.set('state', st);
      if (moduleId !== null) p.set('module', String(moduleId));
      if (path !== null) p.set('path', path);
      const x = p.toString();
      return x ? `${EVENTS}?${x}` : EVENTS;
    };
    const L = { app: tx('sm.col.application'), handler: tx('whk.col.handler'), event: tx('whk.col.event'), received: tx('whk.col.received'), state: tx('sm.col.state'), attempts: tx('wq.col.attempts'), error: tx('whk.col.error'), actions: tx('wq.col.actions') };
    const filter = html`<nav class="settings-tabs" aria-label="${tx('wq.filter')}">
      <a href="${qs('')}"${state === '' ? raw(' aria-current="page"') : ''}>${tx('wq.all')}</a>
      ${STATES.map((k) => html`<a href="${qs(k)}"${state === k ? raw(' aria-current="page"') : ''}>${tx.dyn(`whk.state.${k}`, k)}</a>`)}</nav>`;
    const table = rows.length
      ? html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>${L.app}</th><th>${L.handler}</th><th>${L.event}</th><th>${L.received}</th><th>${L.state}</th><th>${L.attempts}</th><th>${L.error}</th><th>${L.actions}</th></tr></thead><tbody>
          ${rows.map((r) => html`<tr>
            <td data-label="${L.app}"><a href="${BASE}/apps/${r.app_id}">${r.alias}</a></td>
            <td data-label="${L.handler}" class="u-break wrap-anywhere">${r.module_id ? html`<a href="${MODULES}/${r.module_id}/handler?${new URLSearchParams({ t: r.path, m: 'POST' }).toString()}">${r.module}/${r.path}</a>` : `${r.module}/${r.path}`}</td>
            <td data-label="${L.event}" class="u-break wrap-anywhere"><a href="${EVENTS}/${r.id}">#${r.id}</a>${r.event_key ? html` <span class="muted small">${r.event_key}</span>` : ''}</td>
            <td data-label="${L.received}">${r.received}</td>
            <td data-label="${L.state}">${stateTag(tx, r.state)}${r.state === 'retry' && r.next ? html`<br><span class="muted small">${r.next}</span>` : ''}${r.held ? html`<br><span class="muted small">${tx('whk.held')}</span>` : ''}</td>
            <td data-label="${L.attempts}">${r.attempts} / ${r.max_attempts}</td>
            <td data-label="${L.error}" class="u-break wrap-anywhere"><span class="small">${(r.error ?? '').slice(0, 300)}</span></td>
            <td data-label="${L.actions}">${r.state === 'failed' || r.state === 'done' ? html`<form method="post" action="${EVENTS}/${r.id}" class="inline-form">${csrf(s)}<button class="btn btn-sm" name="action" value="reprocess">${tx('whk.reprocess')}</button></form>` : ''}</td></tr>`)}
        </tbody></table></div>${rows.length === LIST ? html`<p class="muted small">${tx('wq.latest', { n: LIST })}</p>` : ''}`
      : html`<p class="muted">${tx('whk.none')}</p>`;
    const main = html`<h1 class="u-mb1">${tx('rail.sql_workshop')}</h1>${workshopTabs('rest', s)}${restNav('events', tx)}
      <p class="muted">${tx.code('whk.intro')}</p>${filter}${region(path !== null ? `${tx('whk.title')}: ${path}` : tx('whk.title'), table)}`;
    return send(reply, s, shell(s, tx('whk.title'), [[tx('rail.sql_workshop'), `${BASE}/sql`], [tx('sql.tool.rest'), `${BASE}/sql/rest`], [tx('whk.title')]], main, 'sql'));
  });

  // one event: its headers and body, for the developers of its application's workspace
  app.get(`${EVENTS}/:id`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const tx = tr(s);
    const id = /^\d{1,18}$/.test(req.params.id) ? req.params.id : '0';
    const r = await owner.one<Row & { headers: Record<string, string>; content_type: string | null; body: Buffer }>(
      `select ${COLUMNS}, e.headers, e.content_type, substring(e.body from 1 for ${BODY_SHOWN + 4}) as body
         from meta.webhook_event e join meta.app a on a.id = e.app_id where ${MINE} and e.id = $2`, [currentWorkspace(s), id]);
    if (!r) return reply.code(404).send('Not found');
    // the first part of a long body may end inside a character: cut back to valid UTF-8
    let text: string | null = null;
    for (let cut = 0; cut < 4 && text === null; cut++) text = bodyText(r.body.subarray(0, Math.min(r.body.length, BODY_SHOWN + 4) - (r.size > BODY_SHOWN ? cut : 0)));
    let pretty = text;
    if (text !== null && r.size <= BODY_SHOWN) try {
      pretty = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      pretty = text;
    }
    const headers = Object.entries(r.headers ?? {});
    const main = html`<h1 class="u-mb1">${tx('rail.sql_workshop')}</h1>${workshopTabs('rest', s)}${restNav('events', tx)}
      ${region(`${tx('whk.event_n', { id: r.id })} · ${r.module}/${r.path}`, html`<dl class="details">
          <dt>${tx('sm.col.application')}</dt><dd><a href="${BASE}/apps/${r.app_id}">${r.alias}</a></dd>
          <dt>${tx('whk.col.event')}</dt><dd class="wrap-anywhere">${r.event_key ?? html`<span class="muted">${tx('whk.no_event_id')}</span>`}</dd>
          <dt>${tx('whk.col.received')}</dt><dd>${r.received}</dd>
          <dt>${tx('sm.col.state')}</dt><dd>${stateTag(tx, r.state)} ${r.attempts} / ${r.max_attempts}${r.state === 'retry' && r.next ? ` · ${r.next}` : ''}</dd>
          ${r.error ? html`<dt>${tx('whk.col.error')}</dt><dd class="wrap-anywhere">${r.error}</dd>` : ''}
          <dt>${tx('whk.content_type')}</dt><dd class="wrap-anywhere">${r.content_type ?? ''} · ${tx('whk.bytes', { n: r.size })}</dd>
          ${headers.length ? html`<dt>${tx('whk.headers')}</dt><dd class="wrap-anywhere">${headers.map(([k, v]) => html`<code>${k}: ${v}</code><br>`)}</dd>` : ''}
        </dl>
        ${r.state === 'failed' || r.state === 'done' ? html`<form method="post" action="${EVENTS}/${r.id}" class="buttons">${csrf(s)}<input type="hidden" name="to" value="event"><button class="btn" name="action" value="reprocess">${tx('whk.reprocess')}</button></form>` : ''}`)}
      ${region(tx('whk.body'), pretty === null ? html`<p class="muted">${tx('whk.binary')}</p>`
        : html`<pre class="source wrap-pre">${pretty}</pre>${r.size > BODY_SHOWN ? html`<p class="muted small">${tx('whk.body_cut', { n: BODY_SHOWN })}</p>` : ''}`)}`;
    return send(reply, s, shell(s, tx('whk.event_n', { id: r.id }), [[tx('rail.sql_workshop'), `${BASE}/sql`], [tx('sql.tool.rest'), `${BASE}/sql/rest`], [tx('whk.title'), EVENTS], [`#${r.id}`]], main, 'sql'));
  });

  // process an event again (its block runs from the first attempt)
  app.post(`${EVENTS}/:id`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const tx = tr(s);
    const id = /^\d{1,18}$/.test(req.params.id) ? req.params.id : '0';
    if (req.body?.action !== 'reprocess') return reply.code(400).send('Bad request');
    const done = await owner.one<{ app_id: number; module: string; path: string }>(
      `update meta.webhook_event e set state = 'received', attempts = 0, next_attempt_at = null, error = null, processed_at = null, lease_until = null
        where e.id = $2 and e.state in ('failed', 'done') and e.app_id in (select a.id from meta.app a where ${MINE})
        returning e.app_id, e.module, e.path`, [currentWorkspace(s), id]);
    if (!done) flash(s, tx('wq.not_changed'), 'error');
    else {
      await owner.query(`select pg_notify('pgkiln_webhook_event', '')`);
      await logActivity({ appId: done.app_id, username: s.username, event: 'rest_module', ip: clientIp(req), detail: `${done.module}/${done.path}: webhook event ${id} queued again` });
      flash(s, tx('whk.reprocessed'));
    }
    return back(reply, s, req.body?.to === 'event' ? `${EVENTS}/${id}` : EVENTS);
  });
}
