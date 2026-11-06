import type { FastifyInstance } from 'fastify';
import { DEFAULT_CLAUDE_MODEL, envKeyName, GEMINI_BASE_URL, generate, keySource, providerLabel, usageToday, type AiService } from '../ai/service.ts';
import type { ProviderName } from '../ai/types.ts';
import { toolCallTable } from './ai-agents.ts';
import { AiError } from '../ai/types.ts';
import { owner } from '../db.ts';
import { html, raw } from '../html.ts';
import { icon } from '../icons.ts';
import { encryptSecret, secretKeyConfigured } from '../secrets.ts';
import type { Session } from '../session.ts';
import { isAdmin } from './locks.ts';
import { back, BASE, csrf, developer, flash, input, region, select, send, shell, type Req } from './ui.ts';
import { scopedTx as tx } from './i18n.ts';

// Workspace utilities → AI services (administrators): the AI services of
// this installation (Claude, OpenAI, Gemini or an OpenAI-compatible endpoint,
// model, effort, output and time limits, base URL, write-only API key), which
// applications may use each one with their daily limits, a test, and the
// usage log. Applications → Activity → AI usage (developers): what an application may use and what it used.
// API keys are encrypted (src/secrets.ts) and never sent back to the browser.

const PROVIDERS = (): [string, string][] => [['anthropic', tx('aisv.claude_anthropic')], ['openai', tx('aisv.openai')], ['gemini', tx('aisv.gemini_google_openai_compatible_endpoint')], ['openai_compatible', tx('aisv.openai_compatible_ollama_vllm_azure')]];
const EFFORTS = (): [string, string][] => [['', tx('aisv.model_default')], ['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'xhigh'], ['max', 'max']];
const TEST_RESULT = '__AITEST';

const check = (name: string, label: string, on: boolean, help?: string) =>
  html`<div class="field"><label class="check"><input type="checkbox" name="${name}" value="true"${on ? raw(' checked') : ''}> ${label}</label>${help ? html`<small class="help">${help}</small>` : ''}</div>`;

const when = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 19).replace('T', ' ') : '');

const KEY_TEXT = { stored: 'stored (encrypted)', env: 'server default', missing: 'missing' } as const;

function serviceForm(s: Partial<AiService>, action: string, csrfField: ReturnType<typeof csrf>, isNew: boolean) {
  const source = s.provider ? keySource(s as AiService) : null;
  return html`<form method="post" action="${action}">${csrfField}
    <fieldset class="prop-group"><legend>${tx('aisv.service')}</legend><div class="form-grid">
      ${isNew ? input('name', tx('aisv.name'), '', { required: true, placeholder: tx('aisv.e_g_claude'), help: tx('aisv.upper_case_letters_digits_and') }) : ''}
      ${input('description', tx('aisv.description'), s.description)}
      ${select('provider', tx('aisv.provider'), s.provider ?? 'anthropic', PROVIDERS(), tx('aisv.prompts_and_the_item_values'))}
      ${input('model', tx('aisv.model'), s.model ?? (isNew ? DEFAULT_CLAUDE_MODEL : ''), { required: true, help: tx('aisv.model_help', { model: DEFAULT_CLAUDE_MODEL }) })}
      ${select('effort', tx('aisv.effort_claude'), isNew ? 'medium' : s.effort ?? '', EFFORTS(), tx('aisv.how_deeply_claude_thinks_thinking'))}
      ${input('max_tokens', tx('aisv.maximum_output_tokens'), s.max_tokens ?? 4000, { type: 'number', help: tx('aisv.per_request_1_128000_a') })}
      ${input('timeout_s', tx('aisv.time_limit_seconds'), s.timeout_s ?? 120, { type: 'number', help: tx('aisv.5_600_pages_wait_for') })}
      ${input('base_url', tx('aisv.base_url'), s.base_url, { placeholder: tx('aisv.empty_the_provider_s_own'), help: `A gateway or proxy that speaks the provider's API. Administrators only. Gemini: empty is ${GEMINI_BASE_URL}. OpenAI-compatible: required, e.g. http://localhost:11434/v1 (Ollama), https://<resource>.openai.azure.com/openai/v1/ (Azure OpenAI).` })}
    </div>
    ${check('refusal_fallback', tx('aisv.refusal_fallbacks_claude'), s.refusal_fallback !== false, tx('aisv.when_claude_declines_a_request'))}
    ${check('enabled', tx('aisv.enabled'), s.enabled !== false)}
    </fieldset>
    <fieldset class="prop-group"><legend>${tx('aisv.api_key')}</legend>
      ${input('api_key', tx('aisv.api_key'), '', { type: 'password', auto: 'new-password', help: source === 'stored' ? 'A key is stored (encrypted). It is never shown; type a new one to replace it.' : `Empty: the server's ${envKeyName((s.provider as ProviderName) ?? 'anthropic')} is used (when set)${s.provider === 'openai_compatible' ? '; an endpoint without keys (Ollama) needs none' : ''}.` })}
      ${source === 'stored' ? check('remove_key', tx('aisv.remove_the_stored_key_use'), false) : ''}
      ${secretKeyConfigured() ? '' : html`<div class="alert alert-error" role="alert">${tx.code('aisv.the_server_has_no_pgkiln')}</div>`}
    </fieldset>
    <div class="buttons"><button class="btn btn-hot">${isNew ? tx('aisv.add_service') : tx('aisv.save')}</button></div>
  </form>`;
}

/** The form's values, checked; throws with a message. */
function formValues(b: Record<string, string | undefined>, hasServer = false) {
  const provider: ProviderName = (['openai', 'gemini', 'openai_compatible'] as const).find((p) => p === b.provider) ?? 'anthropic';
  const model = (b.model ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/.test(model)) throw new Error(tx('aisv.the_model_is_a_name'));
  const maxTokens = Number(b.max_tokens || 4000);
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 128000) throw new Error(tx('aisv.maximum_output_tokens_1_to'));
  const timeout = Number(b.timeout_s || 120);
  if (!Number.isInteger(timeout) || timeout < 5 || timeout > 600) throw new Error(tx('aisv.time_limit_5_to_600'));
  const baseUrl = (b.base_url ?? '').trim() || null;
  if (baseUrl && (!/^https?:\/\/[^\s]+$/i.test(baseUrl) || baseUrl.length > 500)) throw new Error(tx('aisv.the_base_url_starts_with'));
  if (!baseUrl && provider === 'openai_compatible' && !hasServer) throw new Error(tx('aisv.an_openai_compatible_service_needs_2'));
  const effort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(b.effort ?? '') ? b.effort! : null;
  return [(b.description ?? '').trim() || null, provider, model, provider === 'anthropic' ? effort : null, b.refusal_fallback === 'true', maxTokens, timeout, baseUrl, b.enabled === 'true'];
}
const COLUMNS = 'description, provider, model, effort, refusal_fallback, max_tokens, timeout_s, base_url, enabled';

const usageTable = (rows: any[], withApp: boolean) => html`<div class="table-wrap"><table class="report report-reflow">
  <thead><tr><th>${tx('aisv.when_utc')}</th>${withApp ? html`<th>${tx('aisv.application')}</th>` : ''}<th class="num">${tx('aisv.page')}</th><th>${tx('aisv.user')}</th><th>${tx('aisv.service')}</th><th>${tx('aisv.model')}</th><th>${tx('aisv.source')}</th><th class="num">${tx('aisv.input')}</th><th class="num">${tx('aisv.output')}</th><th class="num">ms</th><th>${tx('aisv.status')}</th></tr></thead>
  <tbody>${rows.length ? rows.map((u) => html`<tr>
    <td data-label="${tx('aisv.when')}">${when(u.at)}</td>${withApp ? html`<td data-label="${tx('aisv.application')}">${u.app ?? html`<span class="muted">builder</span>`}</td>` : ''}
    <td class="num" data-label="${tx('aisv.page')}">${u.page_no ?? ''}</td><td data-label="${tx('aisv.user')}">${u.username ?? ''}</td><td data-label="${tx('aisv.service')}">${u.service}</td>
    <td data-label="${tx('aisv.model')}">${u.model}</td><td data-label="${tx('aisv.source')}">${u.source}</td>
    <td class="num" data-label="${tx('aisv.input')}">${u.input_tokens}</td><td class="num" data-label="${tx('aisv.output')}">${u.output_tokens}</td><td class="num" data-label="ms">${u.duration_ms}</td>
    <td data-label="${tx('aisv.status')}"><span class="tag${u.status === 'ok' ? ' tag-ok' : ' tag-error'}">${u.status}</span>${u.message ? html` <span class="muted">${u.message}</span>` : ''}</td></tr>`)
    : html`<tr><td colspan="${withApp ? 11 : 10}" class="empty">${tx('aisv.no_ai_requests_yet')}</td></tr>`}</tbody></table></div>`;

async function adminOnly(s: Session, reply: any, title: string) {
  if (await isAdmin(s.username)) return true;
  const main = html`<h1 class="u-mb1">${title}</h1><div class="alert alert-error" role="alert">${tx('aisv.only_administrators_configure_ai_services')}</div>`;
  await send(reply.code(403), s, shell(s, title, [[tx('aisv.app_builder'), BASE], [tx('aisv.workspace_utilities'), `${BASE}/utilities`], [title]], main));
  return false;
}

export async function aiRoutes(app: FastifyInstance) {
  app.get(`${BASE}/ai`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply, 'AI services'))) return;
    const services = (await owner.query<AiService & { apps: string | null }>(`select s.*, (select string_agg(a.alias, ', ' order by a.alias) from meta.app_ai_service x join meta.app a on a.id = x.app_id where x.service_id = s.id) as apps
      from meta.ai_service s order by s.name`)).rows;
    const summary = (await owner.query(`select a.alias as app, u.service, count(*)::int as requests, sum(u.input_tokens)::bigint as input, sum(u.output_tokens)::bigint as output,
        count(*) filter (where u.status <> 'ok')::int as problems
      from meta.ai_usage u left join meta.app a on a.id = u.app_id where u.at > now() - interval '30 days'
      group by 1, 2 order by 1 nulls first, 2`)).rows;
    const recent = (await owner.query(`select u.*, a.alias as app from meta.ai_usage u left join meta.app a on a.id = u.app_id order by u.id desc limit 100`)).rows;
    const main = html`
      <div class="title-row"><h1>${tx('aisv.ai_services')}</h1></div>
      <p class="muted u-mt0">${tx.rich('aisv.intro', { process: html`<b>${tx('aisv.generate_text_with_ai')}</b>`, fn: html`<code>meta.ai_generate()</code>` })}</p>
      <div class="columns wide-left">
        ${region(tx('aisv.services'), html`<div class="table-wrap"><table class="report report-reflow">
          <thead><tr><th>${tx('aisv.service')}</th><th>${tx('aisv.provider')}</th><th>${tx('aisv.model')}</th><th>${tx('aisv.api_key')}</th><th>${tx('aisv.applications')}</th><th>${tx('aisv.status')}</th></tr></thead>
          <tbody>${services.length ? services.map((x) => html`<tr>
            <td data-label="${tx('aisv.service')}"><a href="${BASE}/ai/${x.id}">${x.name}</a>${x.description ? html` <span class="muted">${x.description}</span>` : ''}</td>
            <td data-label="${tx('aisv.provider')}">${providerLabel(x.provider)}</td>
            <td data-label="${tx('aisv.model')}">${x.model}${x.effort ? html` <span class="muted">(${x.effort})</span>` : ''}</td>
            <td data-label="${tx('aisv.api_key')}">${KEY_TEXT[keySource(x)]}</td>
            <td data-label="${tx('aisv.applications')}">${x.apps ?? html`<span class="muted">none</span>`}</td>
            <td data-label="${tx('aisv.status')}">${x.enabled ? 'enabled' : html`<b>disabled</b>`}</td></tr>`)
            : html`<tr><td colspan="6" class="empty">${tx('aisv.no_ai_services_yet')}</td></tr>`}</tbody></table></div>`)}
        ${region(tx('aisv.add_service'), serviceForm({}, `${BASE}/ai`, csrf(s), true))}
      </div>
      ${region(tx('aisv.usage_30_days'), html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>${tx('aisv.application')}</th><th>${tx('aisv.service')}</th><th class="num">${tx('aisv.requests')}</th><th class="num">${tx('aisv.input_tokens')}</th><th class="num">${tx('aisv.output_tokens')}</th><th class="num">${tx('aisv.not_ok')}</th></tr></thead>
        <tbody>${summary.length ? summary.map((r) => html`<tr><td data-label="${tx('aisv.application')}">${r.app ?? html`<span class="muted">${tx('aisv.builder_tests')}</span>`}</td><td data-label="${tx('aisv.service')}">${r.service}</td><td class="num" data-label="${tx('aisv.requests')}">${r.requests}</td>
          <td class="num" data-label="${tx('aisv.input_tokens')}">${r.input}</td><td class="num" data-label="${tx('aisv.output_tokens')}">${r.output}</td><td class="num" data-label="${tx('aisv.not_ok')}">${r.problems}</td></tr>`)
          : html`<tr><td colspan="6" class="empty">${tx('aisv.no_ai_requests_in_the')}</td></tr>`}</tbody></table></div>`)}
      ${region(tx('aisv.recent_requests'), html`<p class="muted u-mt0">${tx('aisv.tokens_model_duration_and_status')}</p>${usageTable(recent, true)}`)}`;
    return send(reply, s, shell(s, tx('aisv.ai_services'), [[tx('aisv.app_builder'), BASE], [tx('aisv.workspace_utilities'), `${BASE}/utilities`], [tx('aisv.ai_services')]], main));
  });

  app.post(`${BASE}/ai`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply, 'AI services'))) return;
    const b = req.body ?? {};
    try {
      const name = (b.name ?? '').trim().toUpperCase();
      if (!/^[A-Z][A-Z0-9_]{0,59}$/.test(name)) throw new Error(tx('aisv.the_name_is_upper_case'));
      const key = b.api_key ? encryptSecret(b.api_key) : null;
      const r = await owner.one(`insert into meta.ai_service (name, ${COLUMNS}, api_key_enc) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`, [name, ...formValues(b), key]);
      flash(s, tx('aisv.ai_service_added_allow_applications'));
      return back(reply, s, `${BASE}/ai/${r.id}`);
    } catch (e) {
      flash(s, (e as Error).message.includes('ai_service_name_key') ? 'A service with this name exists already.' : (e as Error).message, 'error');
      return back(reply, s, `${BASE}/ai`);
    }
  });

  app.get(`${BASE}/ai/:id(^\\d+$)`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply, 'AI services'))) return;
    const x = await owner.one<AiService>('select * from meta.ai_service where id = $1', [req.params.id]);
    if (!x) return reply.code(404).send('Not found');
    const apps = (await owner.query(`select a.id, a.alias, a.name, x.app_id is not null as allowed, x.max_requests, x.max_tokens
      from meta.app a left join meta.app_ai_service x on x.app_id = a.id and x.service_id = $1 order by a.alias`, [x.id])).rows;
    let test: { ok: boolean; text: string; meta?: string } | null = null;
    try {
      const t = JSON.parse(s.state[TEST_RESULT] ?? 'null');
      if (t?.id === x.id) test = t;
    } catch {
      // ignored
    }
    delete s.state[TEST_RESULT];
    const recent = (await owner.query(`select u.*, a.alias as app from meta.ai_usage u left join meta.app a on a.id = u.app_id where u.service_id = $1 order by u.id desc limit 50`, [x.id])).rows;
    const view = { ...x, api_key_enc: x.api_key_enc ? 'stored' : null }; // the key itself never reaches the page
    // (141) the remote servers of every workspace (administrators choose one)
    const servers = (await owner.query<{ id: number; static_id: string; workspace: string }>(
      'select r.id, r.static_id, w.name as workspace from meta.remote_server r join meta.workspace w on w.id = r.workspace_id order by lower(w.name), r.static_id')).rows;
    const main = html`
      <div class="title-row"><h1 class="ai-name">${x.name}</h1></div>
      <div class="columns wide-left">
        ${region(tx('aisv.settings'), html`${serviceForm(view, `${BASE}/ai/${x.id}`, csrf(s), false)}
          <form method="post" action="${BASE}/ai/${x.id}/delete" class="danger-zone">${csrf(s)}
            <button class="btn btn-danger" data-confirm="${tx('aisv.delete_confirm', { name: x.name })}">${tx('aisv.delete_service')}</button></form>`)}
        ${region(tx('aisv.remote_server'), html`<form method="post" action="${BASE}/ai/${x.id}/server">${csrf(s)}
            <p class="muted u-mt0">${tx('aisv.instead_of_the_base_url')}</p>
            <div class="form-grid">${select('server_id', tx('aisv.remote_server'), x.server_id ? String(x.server_id) : '', [['', tx('aisv.none_the_base_url_above')], ...servers.map((r): [string, string] => [String(r.id), `${r.static_id} (${r.workspace})`])])}
              ${input('server_path', tx('aisv.path'), x.server_path ?? '', { placeholder: '/v1', help: tx('aisv.after_the_server_s_base') })}</div>
            <div class="buttons"><button class="btn">${tx('aisv.save')}</button></div></form>`)}
        ${region(tx('aisv.test'), html`
          <p class="muted u-mt0">${tx('aisv.sends_a_prompt_to_the')}</p>
          <form method="post" action="${BASE}/ai/${x.id}/test">${csrf(s)}
            <div class="field"><label class="label" for="ai_test_prompt">${tx('aisv.prompt')}</label><textarea id="ai_test_prompt" name="prompt" rows="3" maxlength="4000">${tx('aisv.test_prompt')}</textarea></div>
            <div class="buttons"><button class="btn">${icon('play')} ${tx('aisv.test')}</button></div></form>
          ${test ? html`<div class="alert ${test.ok ? 'alert-success' : 'alert-error'}" role="status">${test.meta ?? ''}</div><pre class="source">${test.text}</pre>` : ''}`)}
      </div>
      ${region(tx('aisv.applications'), html`<p class="muted u-mt0">${tx.rich('aisv.apps_intro', { limited: html`<i>${tx('aisv.limited')}</i>` })}</p>
        <form method="post" action="${BASE}/ai/${x.id}/apps">${csrf(s)}
        <div class="table-wrap"><table class="report report-reflow"><thead><tr><th>${tx('aisv.application')}</th><th>${tx('aisv.may_use')}</th><th>${tx('aisv.requests_per_day')}</th><th>${tx('aisv.tokens_per_day')}</th></tr></thead>
        <tbody>${apps.length ? apps.map((a) => html`<tr>
          <td data-label="${tx('aisv.application')}">${a.name} <span class="muted">${a.alias}</span></td>
          <td data-label="${tx('aisv.may_use')}"><label class="check"><input type="checkbox" name="allow" value="${a.id}"${a.allowed ? raw(' checked') : ''}> allowed</label></td>
          <td data-label="${tx('aisv.requests_per_day')}"><input type="number" min="0" name="req_${a.id}" value="${a.max_requests ?? ''}" aria-label="${tx('aisv.aria_req', { app: a.alias })}"></td>
          <td data-label="${tx('aisv.tokens_per_day')}"><input type="number" min="0" name="tok_${a.id}" value="${a.max_tokens ?? ''}" aria-label="${tx('aisv.aria_tok', { app: a.alias })}"></td></tr>`)
          : html`<tr><td colspan="4" class="empty">${tx('aisv.no_applications')}</td></tr>`}</tbody></table></div>
        <div class="buttons"><button class="btn btn-hot">${tx('aisv.save_access')}</button></div></form>`)}
      ${region(tx('aisv.recent_requests'), usageTable(recent, true))}`;
    return send(reply, s, shell(s, x.name, [[tx('aisv.app_builder'), BASE], [tx('aisv.workspace_utilities'), `${BASE}/utilities`], [tx('aisv.ai_services'), `${BASE}/ai`], [x.name]], main));
  });

  app.post(`${BASE}/ai/:id(^\\d+$)`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply, 'AI services'))) return;
    const b = req.body ?? {};
    try {
      const key = b.api_key ? encryptSecret(b.api_key) : null;
      const r = await owner.query(
        `update meta.ai_service set (${COLUMNS}) = ($2, $3, $4, $5, $6, $7, $8, $9, $10), updated_at = now(),
                api_key_enc = case when $12 then null when $11::text is null then api_key_enc else $11 end
          where id = $1`,
        [req.params.id, ...formValues(b, !!(await owner.one('select 1 as ok from meta.ai_service where id = $1 and server_id is not null', [req.params.id]))), key, b.remove_key === 'true'],
      );
      flash(s, r.rowCount ? 'AI service saved.' : tx('aisv.not_found'), r.rowCount ? 'ok' : 'error');
    } catch (e) {
      flash(s, (e as Error).message, 'error');
    }
    return back(reply, s, `${BASE}/ai/${req.params.id}`);
  });

  // (141) the service's remote server and path
  app.post(`${BASE}/ai/:id(^\\d+$)/server`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply, 'AI services'))) return;
    const b = req.body ?? {};
    try {
      const serverId = /^\d{1,9}$/.test(String(b.server_id ?? '')) ? Number(b.server_id) : null;
      const path = String(b.server_path ?? '').trim() || null;
      if (path && (!/^\/[^\s]*$/.test(path) || path.length > 500)) throw new Error(tx('aisv.the_path_starts_with_without'));
      if (serverId && !(await owner.one('select 1 as ok from meta.remote_server where id = $1', [serverId]))) throw new Error(tx('aisv.no_such_remote_server'));
      const r = await owner.query('update meta.ai_service set server_id = $2, server_path = $3, updated_at = now() where id = $1', [req.params.id, serverId, serverId ? path : null]);
      flash(s, r.rowCount ? (serverId ? tx('aisv.the_service_now_calls_its') : tx('aisv.the_service_calls_its_base')) : tx('aisv.not_found'), r.rowCount ? 'ok' : 'error');
    } catch (e) {
      flash(s, (e as Error).message.includes('ai_service_compatible_url') ? tx('aisv.an_openai_compatible_service_needs') : (e as Error).message, 'error');
    }
    return back(reply, s, `${BASE}/ai/${req.params.id}`);
  });

  app.post(`${BASE}/ai/:id(^\\d+$)/apps`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply, 'AI services'))) return;
    const b = req.body as Record<string, string | string[] | undefined>;
    const allow = new Set([b.allow ?? []].flat().map(Number).filter(Number.isInteger));
    const limit = (v: unknown) => {
      const t = String(v ?? '').trim();
      if (!t) return null;
      const n = Number(t);
      if (!Number.isInteger(n) || n < 0) throw new Error(tx('aisv.limits_are_whole_numbers_of'));
      return n;
    };
    try {
      await owner.tx(async (c) => {
        const apps = (await c.query<{ id: number }>('select id from meta.app')).rows.map((a) => a.id);
        await c.query('delete from meta.app_ai_service where service_id = $1 and not (app_id = any($2::int[]))', [req.params.id, [...allow]]);
        for (const id of apps.filter((a) => allow.has(a)))
          await c.query(
            `insert into meta.app_ai_service (app_id, service_id, max_requests, max_tokens) values ($1, $2, $3, $4)
             on conflict (app_id, service_id) do update set max_requests = excluded.max_requests, max_tokens = excluded.max_tokens`,
            [id, req.params.id, limit(b[`req_${id}`]), limit(b[`tok_${id}`])],
          );
      });
      flash(s, tx('aisv.access_saved'));
    } catch (e) {
      flash(s, (e as Error).message, 'error');
    }
    return back(reply, s, `${BASE}/ai/${req.params.id}`);
  });

  app.post(`${BASE}/ai/:id(^\\d+$)/test`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply, 'AI services'))) return;
    const x = await owner.one<{ id: number; name: string }>('select id, name from meta.ai_service where id = $1', [req.params.id]);
    if (!x) return reply.code(404).send('Not found');
    let result: Record<string, unknown>;
    try {
      const prompt = String(req.body?.prompt ?? '').slice(0, 4000) || 'Reply with one short sentence.';
      const r = await generate(x.name, { prompt, maxTokens: 1000 }, { appId: null, user: s.username, source: 'builder' });
      const text = r.text.length > 4000 ? `${r.text.slice(0, 4000)}…` : r.text;
      result = { id: x.id, ok: true, text, meta: tx('aisv.answered_by', { model: r.model, input: r.inputTokens, output: r.outputTokens }) };
    } catch (e) {
      result = { id: x.id, ok: false, text: '', meta: e instanceof AiError ? e.message : tx('aisv.the_test_failed') };
    }
    s.state[TEST_RESULT] = JSON.stringify(result);
    return back(reply, s, `${BASE}/ai/${x.id}`);
  });

  app.post(`${BASE}/ai/:id(^\\d+$)/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply, 'AI services'))) return;
    await owner.query('delete from meta.ai_service where id = $1', [req.params.id]);
    flash(s, tx('aisv.ai_service_deleted'));
    return back(reply, s, `${BASE}/ai`);
  });

  // ---------------------------------------------------------------- per application (developers)
  app.get(`${BASE}/apps/:id(^\\d+$)/ai`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await owner.one<{ id: number; alias: string; name: string }>('select id, alias, name from meta.app where id = $1', [req.params.id]);
    if (!a) return reply.code(404).send('Not found');
    const allowed = (await owner.query<{ id: number; name: string; provider: string; model: string; max_requests: number | null; max_tokens: string | null; enabled: boolean }>(
      `select s.id, s.name, s.provider, s.model, s.enabled, x.max_requests, x.max_tokens from meta.app_ai_service x join meta.ai_service s on s.id = x.service_id where x.app_id = $1 order by s.name`, [a.id])).rows;
    const today = await Promise.all(allowed.map((x) => usageToday(a.id, x.id)));
    const recent = (await owner.query('select * from meta.ai_usage where app_id = $1 order by id desc limit 100', [a.id])).rows;
    const admin = await isAdmin(s.username);
    const main = html`
      <div class="title-row"><h1 class="ai-name">AI usage · ${a.name}</h1></div>
      <p class="muted u-mt0">The AI services this application may use (an administrator allows them${admin ? html` under <a href="${BASE}/ai">${tx('aisv.ai_services')}</a>` : ''}), today's use against their limits, and the recent requests.</p>
      ${region(tx('aisv.services'), html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>${tx('aisv.service')}</th><th>${tx('aisv.model')}</th><th class="num">${tx('aisv.requests_today')}</th><th class="num">${tx('aisv.tokens_today')}</th><th>${tx('aisv.status')}</th></tr></thead>
        <tbody>${allowed.length ? allowed.map((x, i) => html`<tr><td data-label="${tx('aisv.service')}">${x.name}</td><td data-label="${tx('aisv.model')}">${providerLabel(x.provider)} ${x.model}</td>
          <td class="num" data-label="${tx('aisv.requests_today')}">${today[i].requests}${x.max_requests !== null ? ` / ${x.max_requests}` : ''}</td>
          <td class="num" data-label="${tx('aisv.tokens_today')}">${today[i].tokens}${x.max_tokens !== null ? ` / ${x.max_tokens}` : ''}</td>
          <td data-label="${tx('aisv.status')}">${x.enabled ? 'enabled' : html`<b>disabled</b>`}</td></tr>`)
          : html`<tr><td colspan="5" class="empty">${tx('aisv.this_application_may_not_use')}</td></tr>`}</tbody></table></div>`)}
      ${region(tx('aisv.recent_requests'), usageTable(recent, false))}
      ${await toolCallTable(a.id)}`;
    return send(reply, s, shell(s, `AI usage · ${a.name}`, [[tx('aisv.app_builder'), BASE], [a.name, `${BASE}/apps/${a.id}`], [tx('aisv.activity'), `${BASE}/apps/${a.id}/activity`], [tx('aisv.ai_usage')]], main));
  });
}
