import type { FastifyInstance, FastifyReply } from 'fastify';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { newToken } from '../security.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import {
  instanceTelemetry, refreshTelemetry, saveInstanceTelemetry, saveWorkspaceTelemetry, setMetricsToken, workspaceTelemetry,
  type InstanceForm, type Origin, type WorkspaceForm,
} from '../telemetry/config.ts';
import { destinationStatus, sendTest } from '../telemetry/export.ts';
import { isAdmin } from './locks.ts';
import { back, BASE, csrf, developer, flash, input, region, select, send, shell, type Req } from './ui.ts';
import { workspaceAdmin } from './workspaces.ts';

// (sprint 139, AP-6; APEX: Workspace Utilities → OpenTelemetry) Workspace
// utilities → OpenTelemetry (administrators): the instance's collector, what
// it receives, GET /metrics, and each workspace's choice; a workspace's
// administrators switch its applications off or add a collector of their own
// on /builder/workspaces/:id/telemetry. Headers (an API key) are write-only:
// stored encrypted, only their names are shown.

const crumbs: [string, string?][] = [['App Builder', BASE], ['Workspace utilities', `${BASE}/utilities`], ['OpenTelemetry']];
const ORIGIN: Record<Origin, string> = { builder: 'set here', environment: 'environment variable', default: 'default' };

const check = (name: string, label: string, on: boolean, help?: string) =>
  html`<div class="field"><label class="check"><input type="checkbox" name="${name}" value="true"${on ? raw(' checked') : ''}> ${label}</label>${help ? html`<small class="help">${help}</small>` : ''}</div>`;

const headersField = (names: string[], help: string) => html`<div class="field"><label class="label" for="f_headers">Headers</label>
  <textarea id="f_headers" name="headers" rows="2" maxlength="4000" spellcheck="false" autocomplete="off" placeholder="${names.length ? `${names.join(', ')} set: type new headers to replace them` : 'e.g. x-honeycomb-team=…, Authorization=Bearer …'}"></textarea>
  <small class="help">${help}${names.length ? html` Set now: <b>${names.join(', ')}</b> (values hidden).` : ''}</small>
  ${names.length ? html`<label class="check"><input type="checkbox" name="remove_headers" value="true"> Remove the headers</label>` : ''}</div>`;

const when = (ms: number | null) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '—');

function statusCell(key: string): Raw {
  const st = destinationStatus(key);
  return html`${st.sent} sent${st.dropped ? html`, <span class="otel-problem">${st.dropped} dropped</span>` : ''} · last success ${when(st.lastOkAt)}
    ${st.lastError ? html`<br><span class="otel-problem">Last problem (${when(st.lastErrorAt)}): ${st.lastError}</span>` : ''}`;
}

async function adminOnly(s: Session, reply: FastifyReply) {
  if (await isAdmin(s.username)) return true;
  await send(reply.code(403), s, shell(s, 'OpenTelemetry', crumbs, html`<h1 class="u-mb1">OpenTelemetry</h1><div class="alert alert-error" role="alert">Only administrators set up OpenTelemetry for the installation.</div>`));
  return false;
}

export async function telemetryBuilderRoutes(app: FastifyInstance) {
  app.get(`${BASE}/telemetry`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply))) return;
    await refreshTelemetry(true);
    const t = instanceTelemetry();
    const token = typeof s.state.__METRICS_TOKEN === 'string' ? s.state.__METRICS_TOKEN : null;
    if (token) {
      delete s.state.__METRICS_TOKEN;
      const { saveState } = await import('../session.ts');
      await saveState(s);
    }
    const workspaces = (await owner.query<{ id: number; name: string; telemetry: string; telemetry_endpoint: string | null; apps: number }>(
      `select w.id, w.name, w.telemetry, w.telemetry_endpoint, (select count(*) from meta.app a where meta.app_workspace(a.id) = w.id)::int as apps
         from meta.workspace w order by w.name`)).rows;
    const from = (k: string) => html`<span class="muted">(${ORIGIN[t.origin[k] ?? 'default']})</span>`;
    const pub = (process.env.PUBLIC_URL ?? '').replace(/\/+$/, '');
    const main = html`<h1 class="u-mb1">OpenTelemetry</h1>
      <p class="muted u-mt0">Send traces, logs and metrics of the applications to your own monitoring (Grafana, Jaeger, Datadog, Honeycomb, OCI APM,
        or anything that speaks OTLP) through an OpenTelemetry Collector. A trace per page request, with a span for each SQL statement, REST data source call,
        AI request and tool call; mail and workflow steps as traces of their own. pgkiln sends OTLP over HTTP as JSON. The standard <code>OTEL_*</code>
        environment variables work too; a value set here wins. Chapter 1 of the guide (Monitoring with OpenTelemetry) explains every choice.</p>
      ${t.protocolWarning ? html`<div class="alert alert-warning" role="status">${t.protocolWarning}</div>` : ''}
      <div class="columns wide-left">
        ${region('Collector', html`<form method="post" action="${BASE}/telemetry">${csrf(s)}
          ${check('enabled', 'Send to this collector', t.enabled, 'Off: nothing leaves the server (workspaces with a collector of their own still send to it).')}
          <div class="form-grid">
            ${input('endpoint', 'Collector URL', t.origin.otel_endpoint === 'builder' ? t.endpoint : '', { placeholder: t.endpoint || 'http://otel-collector:4318', help: html`The OTLP/HTTP base address; /v1/traces, /v1/logs and /v1/metrics are added. In effect: <b>${t.endpoint || 'none'}</b> ${from('otel_endpoint')} (<code>OTEL_EXPORTER_OTLP_ENDPOINT</code>).` as unknown as string })}
            ${input('service_name', 'Service name', t.origin.otel_service_name === 'builder' ? t.serviceName : '', { placeholder: t.serviceName, help: `service.name of everything sent (OTEL_SERVICE_NAME). In effect: ${t.serviceName}.` })}
            ${input('sample', 'Sample ratio', t.origin.otel_sample === 'builder' ? String(t.sample) : '', { placeholder: String(t.sample), help: 'Share of traces sent, 0 to 1 (OTEL_TRACES_SAMPLER_ARG). A trace with an error is always sent. A caller\'s traceparent decides for its trace.' })}
            ${select('user', 'User', t.user, [['hashed', 'Hashed (the same user gives the same value, the name is not sent)'], ['name', 'User name'], ['none', 'Not sent']], 'enduser.id on the page span and on logs.')}
          </div>
          ${headersField(t.headerNames, 'Sent with every request to the collector, name=value, one per line or comma separated (OTEL_EXPORTER_OTLP_HEADERS). Stored encrypted.')}
          <fieldset class="field"><legend class="label">Send</legend><div class="radio-group">
            ${check('traces', 'Traces', t.traces)}${check('logs', 'Logs: errors, refused access and failed sign-ins', t.logs)}${check('metrics', `Metrics, every ${Math.round(t.intervalMs / 1000)} seconds`, t.metrics)}
          </div></fieldset>
          ${check('values', 'Include values', t.values, 'SQL statements with their literals, bind values, query strings and AI tool arguments. Off: literals become ?, values are left out and error messages have quoted values removed.')}
          ${check('builder', 'Trace builder requests too', t.builder, 'Applications only by default.')}
          ${check('browser', 'Browser spans', t.browser, 'Pages report their load time and Ajax calls to pgkiln, which adds them to the page\'s trace. The browser never sees the collector or its headers.')}
          ${check('prometheus', 'Prometheus endpoint /metrics', t.prometheus, 'For administrators signed in to the builder, or a scraper with the metrics token below (PGKILN_METRICS, PGKILN_METRICS_TOKEN).')}
          <div class="buttons"><button class="btn btn-hot">Save</button></div></form>
          <form method="post" action="${BASE}/telemetry/test" class="u-mt1">${csrf(s)}<button class="btn">Send a test span</button></form>`)}
        ${region('Status', html`<p class="muted u-mt0">Since this server started. Each server of the installation sends its own.</p>
          <div class="table-wrap"><table class="report report-reflow"><thead><tr><th>Collector</th><th>Sending</th></tr></thead><tbody>
            <tr><td data-label="Collector">This instance's${t.enabled ? '' : html` <span class="muted">(off)</span>`}</td><td data-label="Sending">${statusCell('instance')}</td></tr>
            ${workspaces.filter((w) => w.telemetry === 'own').map((w) => html`<tr><td data-label="Collector">Workspace ${w.name}</td><td data-label="Sending">${statusCell(`ws:${w.id}`)}</td></tr>`)}
          </tbody></table></div>`)}
        ${region('Prometheus', html`<p class="muted u-mt0">${t.prometheus ? html`<code>GET ${pub || ''}/metrics</code> answers with the counters, durations and queue lengths in the Prometheus text format.` : 'Off: switch it on above.'}
            A scraper sends <code>Authorization: Bearer &lt;token&gt;</code>. ${t.prometheusTokenHash ? (t.origin.metrics_token_hash === 'builder' || !process.env.PGKILN_METRICS_TOKEN ? 'A token is set.' : 'The token is PGKILN_METRICS_TOKEN.') : 'No token is set.'}</p>
          ${token ? html`<div class="alert alert-success" role="status">The new token (shown once): <code class="cell-break">${token}</code></div>` : ''}
          <form method="post" action="${BASE}/telemetry/token" class="buttons">${csrf(s)}<button class="btn" name="action" value="new">${t.prometheusTokenHash ? 'Replace the token' : 'Make a token'}</button>
            ${t.prometheusTokenHash ? html`<button class="btn btn-danger" name="action" value="remove" data-confirm="Remove the metrics token? Scrapers that use it get 401.">Remove the token</button>` : ''}</form>`)}
        ${region('Workspaces', html`<p class="muted u-mt0">A workspace's administrators may switch its applications off, or send them to a collector of their own as well.</p>
          <div class="table-wrap"><table class="report report-reflow"><thead><tr><th>Workspace</th><th>Applications</th><th>Sends</th></tr></thead><tbody>
          ${workspaces.length ? workspaces.map((w) => html`<tr><td data-label="Workspace"><a href="${BASE}/workspaces/${w.id}/telemetry">${w.name}</a></td><td data-label="Applications" class="num">${w.apps}</td>
            <td data-label="Sends" class="cell-break">${w.telemetry === 'off' ? 'nothing' : w.telemetry === 'own' ? html`to the instance's collector and ${w.telemetry_endpoint}` : 'to the instance\'s collector'}</td></tr>`)
            : html`<tr><td colspan="3" class="empty">No workspaces.</td></tr>`}</tbody></table></div>`)}
      </div>`;
    return send(reply, s, shell(s, 'OpenTelemetry', crumbs, main));
  });

  app.post(`${BASE}/telemetry`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply))) return;
    const problem = await saveInstanceTelemetry((req.body ?? {}) as InstanceForm);
    if (!problem) {
      const t = instanceTelemetry();
      await logActivity({ username: s.username, event: 'instance_settings', ip: clientIp(req),
        detail: `OpenTelemetry: ${t.enabled ? `on, ${t.endpoint}` : 'off'}, sample ${t.sample}, user ${t.user}, values ${t.values}, browser ${t.browser}, /metrics ${t.prometheus}` });
    }
    flash(s, problem ?? 'OpenTelemetry settings saved.', problem ? 'error' : 'ok');
    return back(reply, s, `${BASE}/telemetry`);
  });

  app.post(`${BASE}/telemetry/test`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply))) return;
    const problem = await sendTest(null);
    flash(s, problem ? `The collector did not take the test span: ${problem}` : 'The collector took the test span ("pgkiln test span").', problem ? 'error' : 'ok');
    return back(reply, s, `${BASE}/telemetry`);
  });

  app.post(`${BASE}/telemetry/token`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply))) return;
    const action = (req.body as { action?: string } | undefined)?.action;
    if (action === 'new') {
      const token = `pgkm_${newToken()}`;
      await setMetricsToken(token);
      s.state.__METRICS_TOKEN = token;
      await logActivity({ username: s.username, event: 'instance_settings', ip: clientIp(req), detail: 'metrics token made' });
    } else if (action === 'remove') {
      await setMetricsToken(null);
      await logActivity({ username: s.username, event: 'instance_settings', ip: clientIp(req), detail: 'metrics token removed' });
      flash(s, 'The metrics token is removed.');
    }
    return back(reply, s, `${BASE}/telemetry`);
  });

  // ---------------------------------------------------------------- a workspace's own

  const wsAllowed = async (s: Session, reply: FastifyReply, id: string) => {
    if (await workspaceAdmin(s.username, id)) return true;
    await send(reply.code(403), s, shell(s, 'OpenTelemetry', [['Administration'], ['OpenTelemetry']],
      html`<h1 class="u-mb1">OpenTelemetry</h1><div class="alert alert-error" role="alert">Only the workspace's administrators change its OpenTelemetry setting.</div>`, 'users'));
    return false;
  };

  app.get(`${BASE}/workspaces/:id(^\\d{1,9}$)/telemetry`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await wsAllowed(s, reply, req.params.id))) return;
    const w = await owner.one<{ id: number; name: string; telemetry: string; telemetry_endpoint: string | null; telemetry_values: boolean; has_headers: boolean }>(
      'select id, name, telemetry, telemetry_endpoint, telemetry_values, telemetry_headers_enc is not null as has_headers from meta.workspace where id = $1', [req.params.id]);
    if (!w) return reply.code(404).send('Not found');
    await refreshTelemetry(true);
    const t = instanceTelemetry();
    const names = Object.keys(workspaceTelemetry(w.id)?.headers ?? {});
    const radio = (v: string, label: string, help: string) => html`<label class="check"><input type="radio" name="mode" value="${v}"${w.telemetry === v ? raw(' checked') : ''}> ${label} <span class="muted small">${help}</span></label>`;
    const main = html`<div class="title-row"><h1>OpenTelemetry · ${w.name}</h1></div>
      <p class="muted u-mt0">Traces and logs of this workspace's applications. ${t.enabled ? 'The instance sends them to its collector.' : 'The instance sends nothing at the moment.'}
        A collector of the workspace's own is reached through the installation's allow-list and this workspace's <a href="${BASE}/network?ws=${w.id}">network access</a> list.</p>
      <div class="columns wide-left">
        ${region('Setting', html`<form method="post" action="${BASE}/workspaces/${w.id}/telemetry">${csrf(s)}
          <fieldset class="field"><legend class="label">The applications send</legend><div class="radio-group">
            ${radio('instance', 'As the instance does', '(default)')}
            ${radio('off', 'Nothing', 'not even to the instance\'s collector')}
            ${radio('own', 'Also to our own collector', '')}
          </div></fieldset>
          <div class="form-grid">${input('endpoint', 'Own collector URL', w.telemetry_endpoint ?? '', { placeholder: 'https://otlp.example.com', help: 'The OTLP/HTTP base address; /v1/traces and /v1/logs are added.' })}</div>
          ${headersField(names.length ? names : w.has_headers ? ['(unreadable)'] : [], 'Sent with every request to the own collector (an API key). Stored encrypted.')}
          ${check('values', 'Include values for the own collector', w.telemetry_values, 'SQL statements with their literals, bind values and query strings.')}
          <div class="buttons"><button class="btn btn-hot">Save</button></div></form>
          ${w.telemetry === 'own' ? html`<form method="post" action="${BASE}/workspaces/${w.id}/telemetry/test" class="u-mt1">${csrf(s)}<button class="btn">Send a test span</button></form>` : ''}`)}
        ${w.telemetry === 'own' ? region('Status', html`<p class="u-mt0">${statusCell(`ws:${w.id}`)}</p>`) : ''}
      </div>`;
    return send(reply, s, shell(s, `OpenTelemetry · ${w.name}`, [['Administration'], [w.name, `${BASE}/workspaces/${w.id}`], ['OpenTelemetry']], main, 'users'));
  });

  app.post(`${BASE}/workspaces/:id(^\\d{1,9}$)/telemetry`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await wsAllowed(s, reply, req.params.id))) return;
    const id = Number(req.params.id);
    if (!(await owner.one('select 1 from meta.workspace where id = $1', [id]))) return reply.code(404).send('Not found');
    const f = (req.body ?? {}) as WorkspaceForm;
    const problem = await saveWorkspaceTelemetry(id, f);
    if (!problem)
      await logActivity({ username: s.username, event: 'workspace', ip: clientIp(req), detail: `workspace ${id} OpenTelemetry: ${f.mode}${f.mode === 'own' ? ` ${f.endpoint}` : ''}` });
    flash(s, problem ?? 'Saved.', problem ? 'error' : 'ok');
    return back(reply, s, `${BASE}/workspaces/${id}/telemetry`);
  });

  app.post(`${BASE}/workspaces/:id(^\\d{1,9}$)/telemetry/test`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await wsAllowed(s, reply, req.params.id))) return;
    const id = Number(req.params.id);
    const problem = workspaceTelemetry(id)?.mode === 'own' ? await sendTest(id) : 'The workspace has no collector of its own.';
    flash(s, problem ? `The collector did not take the test span: ${problem}` : 'The collector took the test span ("pgkiln test span").', problem ? 'error' : 'ok');
    return back(reply, s, `${BASE}/workspaces/${id}/telemetry`);
  });
}
