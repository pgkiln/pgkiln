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
import { scopedTx as tx } from './i18n.ts';

// (sprint 139, AP-6; APEX: Workspace Utilities → OpenTelemetry) Workspace
// utilities → OpenTelemetry (administrators): the instance's collector, what
// it receives, GET /metrics, and each workspace's choice; a workspace's
// administrators switch its applications off or add a collector of their own
// on /builder/workspaces/:id/telemetry. Headers (an API key) are write-only:
// stored encrypted, only their names are shown.

const crumbs = (): [string, string?][] => [[tx('tel.app_builder'), BASE], [tx('tel.workspace_utilities'), `${BASE}/utilities`], [tx('tel.opentelemetry')]];
const ORIGIN: Record<Origin, string> = { builder: 'set here', environment: 'environment variable', default: 'default' };

const check = (name: string, label: string, on: boolean, help?: string) =>
  html`<div class="field"><label class="check"><input type="checkbox" name="${name}" value="true"${on ? raw(' checked') : ''}> ${label}</label>${help ? html`<small class="help">${help}</small>` : ''}</div>`;

const headersField = (names: string[], help: string) => html`<div class="field"><label class="label" for="f_headers">${tx('tel.headers')}</label>
  <textarea id="f_headers" name="headers" rows="2" maxlength="4000" spellcheck="false" autocomplete="off" placeholder="${names.length ? `${names.join(', ')} set: type new headers to replace them` : 'e.g. x-honeycomb-team=…, Authorization=Bearer …'}"></textarea>
  <small class="help">${help}${names.length ? html` Set now: <b>${names.join(', ')}</b> (values hidden).` : ''}</small>
  ${names.length ? html`<label class="check"><input type="checkbox" name="remove_headers" value="true"> ${tx('tel.remove_the_headers')}</label>` : ''}</div>`;

const when = (ms: number | null) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '—');

function statusCell(key: string): Raw {
  const st = destinationStatus(key);
  return html`${st.sent} sent${st.dropped ? html`, <span class="otel-problem">${st.dropped} dropped</span>` : ''} · last success ${when(st.lastOkAt)}
    ${st.lastError ? html`<br><span class="otel-problem">Last problem (${when(st.lastErrorAt)}): ${st.lastError}</span>` : ''}`;
}

async function adminOnly(s: Session, reply: FastifyReply) {
  if (await isAdmin(s.username)) return true;
  await send(reply.code(403), s, shell(s, tx('tel.opentelemetry'), crumbs(), html`<h1 class="u-mb1">${tx('tel.opentelemetry')}</h1><div class="alert alert-error" role="alert">${tx('tel.only_administrators_set_up_opentelemetry')}</div>`));
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
    const from = (k: string) => html`<span class="muted">(${tx.dyn(`tel.o.${t.origin[k] ?? 'default'}`, ORIGIN[t.origin[k] ?? 'default'])})</span>`;
    const pub = (process.env.PUBLIC_URL ?? '').replace(/\/+$/, '');
    const main = html`<h1 class="u-mb1">${tx('tel.opentelemetry')}</h1>
      <p class="muted u-mt0">${tx.code('tel.send_traces_logs_and_metrics')}</p>
      ${t.protocolWarning ? html`<div class="alert alert-warning" role="status">${t.protocolWarning}</div>` : ''}
      <div class="columns wide-left">
        ${region(tx('tel.collector'), html`<form method="post" action="${BASE}/telemetry">${csrf(s)}
          ${check('enabled', tx('tel.send_to_this_collector'), t.enabled, tx('tel.off_nothing_leaves_the_server'))}
          <div class="form-grid">
            ${input('endpoint', tx('tel.collector_url'), t.origin.otel_endpoint === 'builder' ? t.endpoint : '', { placeholder: t.endpoint || 'http://otel-collector:4318', help: tx.rich('tel.endpoint_help', { value: html`<b>${t.endpoint || tx('tel.none')}</b>`, origin: from('otel_endpoint'), env: html`<code>OTEL_EXPORTER_OTLP_ENDPOINT</code>` }) as unknown as string })}
            ${input('service_name', tx('tel.service_name'), t.origin.otel_service_name === 'builder' ? t.serviceName : '', { placeholder: t.serviceName, help: tx('tel.service_help', { value: t.serviceName }) })}
            ${input('sample', tx('tel.sample_ratio'), t.origin.otel_sample === 'builder' ? String(t.sample) : '', { placeholder: String(t.sample), help: tx('tel.share_of_traces_sent_0') })}
            ${select('user', tx('tel.user'), t.user, [['hashed', tx('tel.hashed_the_same_user_gives')], ['name', tx('tel.user_name')], ['none', tx('tel.not_sent')]], 'enduser.id on the page span and on logs.')}
          </div>
          ${headersField(t.headerNames, tx('tel.sent_with_every_request_to'))}
          <fieldset class="field"><legend class="label">${tx('tel.send')}</legend><div class="radio-group">
            ${check('traces', tx('tel.traces'), t.traces)}${check('logs', tx('tel.logs_errors_refused_access_and'), t.logs)}${check('metrics', `Metrics, every ${Math.round(t.intervalMs / 1000)} seconds`, t.metrics)}
          </div></fieldset>
          ${check('values', tx('tel.include_values'), t.values, 'SQL statements with their literals, bind values, query strings and AI tool arguments. Off: literals become ?, values are left out and error messages have quoted values removed.')}
          ${check('builder', tx('tel.trace_builder_requests_too'), t.builder, tx('tel.applications_only_by_default'))}
          ${check('browser', tx('tel.browser_spans'), t.browser, tx('tel.pages_report_their_load_time'))}
          ${check('prometheus', tx('tel.prometheus_endpoint_metrics'), t.prometheus, tx('tel.for_administrators_signed_in_to'))}
          <div class="buttons"><button class="btn btn-hot">${tx('tel.save')}</button></div></form>
          <form method="post" action="${BASE}/telemetry/test" class="u-mt1">${csrf(s)}<button class="btn">${tx('tel.send_a_test_span')}</button></form>`)}
        ${region(tx('tel.status'), html`<p class="muted u-mt0">${tx('tel.since_this_server_started_each')}</p>
          <div class="table-wrap"><table class="report report-reflow"><thead><tr><th>${tx('tel.collector')}</th><th>${tx('tel.sending')}</th></tr></thead><tbody>
            <tr><td data-label="${tx('tel.collector')}">This instance's${t.enabled ? '' : html` <span class="muted">${tx('tel.off')}</span>`}</td><td data-label="${tx('tel.sending')}">${statusCell('instance')}</td></tr>
            ${workspaces.filter((w) => w.telemetry === 'own').map((w) => html`<tr><td data-label="${tx('tel.collector')}">Workspace ${w.name}</td><td data-label="${tx('tel.sending')}">${statusCell(`ws:${w.id}`)}</td></tr>`)}
          </tbody></table></div>`)}
        ${region(tx('tel.prometheus'), html`<p class="muted u-mt0">${t.prometheus ? html`<code>GET ${pub || ''}/metrics</code> answers with the counters, durations and queue lengths in the Prometheus text format.` : tx('tel.off_switch_it_on_above')}
            A scraper sends <code>Authorization: Bearer &lt;token&gt;</code>. ${t.prometheusTokenHash ? (t.origin.metrics_token_hash === 'builder' || !process.env.PGKILN_METRICS_TOKEN ? 'A token is set.' : tx('tel.the_token_is_pgkiln_metrics')) : tx('tel.no_token_is_set')}</p>
          ${token ? html`<div class="alert alert-success" role="status">${tx.rich('tel.new_token', { token: html`<code class="cell-break">${token}</code>` })}</div>` : ''}
          <form method="post" action="${BASE}/telemetry/token" class="buttons">${csrf(s)}<button class="btn" name="action" value="new">${t.prometheusTokenHash ? tx('tel.replace_the_token') : tx('tel.make_a_token')}</button>
            ${t.prometheusTokenHash ? html`<button class="btn btn-danger" name="action" value="remove" data-confirm="${tx('tel.remove_the_metrics_token_scrapers')}">${tx('tel.remove_the_token')}</button>` : ''}</form>`)}
        ${region(tx('tel.workspaces'), html`<p class="muted u-mt0">${tx('tel.a_workspace_s_administrators_may')}</p>
          <div class="table-wrap"><table class="report report-reflow"><thead><tr><th>${tx('tel.workspace')}</th><th>${tx('tel.applications')}</th><th>${tx('tel.sends')}</th></tr></thead><tbody>
          ${workspaces.length ? workspaces.map((w) => html`<tr><td data-label="${tx('tel.workspace')}"><a href="${BASE}/workspaces/${w.id}/telemetry">${w.name}</a></td><td data-label="${tx('tel.applications')}" class="num">${w.apps}</td>
            <td data-label="${tx('tel.sends')}" class="cell-break">${w.telemetry === 'off' ? 'nothing' : w.telemetry === 'own' ? html`to the instance's collector and ${w.telemetry_endpoint}` : 'to the instance\'s collector'}</td></tr>`)
            : html`<tr><td colspan="3" class="empty">${tx('tel.no_workspaces')}</td></tr>`}</tbody></table></div>`)}
      </div>`;
    return send(reply, s, shell(s, tx('tel.opentelemetry'), crumbs(), main));
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
    flash(s, problem ?? tx('tel.opentelemetry_settings_saved'), problem ? 'error' : 'ok');
    return back(reply, s, `${BASE}/telemetry`);
  });

  app.post(`${BASE}/telemetry/test`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply))) return;
    const problem = await sendTest(null);
    flash(s, problem ? tx('tel.test_failed', { problem }) : tx('tel.the_collector_took_the_test'), problem ? 'error' : 'ok');
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
      flash(s, tx('tel.the_metrics_token_is_removed'));
    }
    return back(reply, s, `${BASE}/telemetry`);
  });

  // ---------------------------------------------------------------- a workspace's own

  const wsAllowed = async (s: Session, reply: FastifyReply, id: string) => {
    if (await workspaceAdmin(s.username, id)) return true;
    await send(reply.code(403), s, shell(s, tx('tel.opentelemetry'), [[tx('tel.administration')], [tx('tel.opentelemetry')]],
      html`<h1 class="u-mb1">${tx('tel.opentelemetry')}</h1><div class="alert alert-error" role="alert">${tx('tel.only_the_workspace_s_administrators')}</div>`, 'users'));
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
      <p class="muted u-mt0">${tx.rich('tel.intro', { state: t.enabled ? tx('tel.the_instance_sends_them_to') : tx('tel.the_instance_sends_nothing_at'), network: html`<a href="${BASE}/network?ws=${w.id}">${tx('tel.network_access')}</a>` })}</p>
      <div class="columns wide-left">
        ${region(tx('tel.setting'), html`<form method="post" action="${BASE}/workspaces/${w.id}/telemetry">${csrf(s)}
          <fieldset class="field"><legend class="label">${tx('tel.the_applications_send')}</legend><div class="radio-group">
            ${radio('instance', tx('tel.as_the_instance_does'), '(default)')}
            ${radio('off', tx('tel.nothing'), 'not even to the instance\'s collector')}
            ${radio('own', tx('tel.also_to_our_own_collector'), '')}
          </div></fieldset>
          <div class="form-grid">${input('endpoint', tx('tel.own_collector_url'), w.telemetry_endpoint ?? '', { placeholder: tx('tel.https_otlp_example_com'), help: tx('tel.the_otlp_http_base_address') })}</div>
          ${headersField(names.length ? names : w.has_headers ? [tx('tel.unreadable')] : [], tx('tel.sent_with_every_request_to_2'))}
          ${check('values', tx('tel.include_values_for_the_own'), w.telemetry_values, 'SQL statements with their literals, bind values and query strings.')}
          <div class="buttons"><button class="btn btn-hot">${tx('tel.save')}</button></div></form>
          ${w.telemetry === 'own' ? html`<form method="post" action="${BASE}/workspaces/${w.id}/telemetry/test" class="u-mt1">${csrf(s)}<button class="btn">${tx('tel.send_a_test_span')}</button></form>` : ''}`)}
        ${w.telemetry === 'own' ? region(tx('tel.status'), html`<p class="u-mt0">${statusCell(`ws:${w.id}`)}</p>`) : ''}
      </div>`;
    return send(reply, s, shell(s, `OpenTelemetry · ${w.name}`, [[tx('tel.administration')], [w.name, `${BASE}/workspaces/${w.id}`], [tx('tel.opentelemetry')]], main, 'users'));
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
    flash(s, problem ?? tx('tel.saved'), problem ? 'error' : 'ok');
    return back(reply, s, `${BASE}/workspaces/${id}/telemetry`);
  });

  app.post(`${BASE}/workspaces/:id(^\\d{1,9}$)/telemetry/test`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await wsAllowed(s, reply, req.params.id))) return;
    const id = Number(req.params.id);
    const problem = workspaceTelemetry(id)?.mode === 'own' ? await sendTest(id) : tx('tel.the_workspace_has_no_collector');
    flash(s, problem ? tx('tel.test_failed', { problem }) : tx('tel.the_collector_took_the_test'), problem ? 'error' : 'ok');
    return back(reply, s, `${BASE}/workspaces/${id}/telemetry`);
  });
}
