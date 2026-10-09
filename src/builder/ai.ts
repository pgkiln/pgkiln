import type { FastifyInstance } from 'fastify';
import { DEFAULT_CLAUDE_MODEL, envKeyName, generate, keySource, usageToday, type AiService } from '../ai/service.ts';
import { AiError } from '../ai/types.ts';
import { owner } from '../db.ts';
import { html, raw } from '../html.ts';
import { icon } from '../icons.ts';
import { encryptSecret, secretKeyConfigured } from '../secrets.ts';
import type { Session } from '../session.ts';
import { isAdmin } from './locks.ts';
import { back, BASE, csrf, developer, flash, input, region, select, send, shell, type Req } from './ui.ts';

// Workspace utilities → AI services (administrators): the AI services of
// this installation (Claude or OpenAI, model, effort, output and time limits,
// base URL, write-only API key), which applications may use each one with
// their daily limits, a test, and the usage log. Applications → Activity →
// AI usage (developers): what an application may use and what it used.
// API keys are encrypted (src/secrets.ts) and never sent back to the browser.

const PROVIDERS: [string, string][] = [['anthropic', 'Claude (Anthropic)'], ['openai', 'OpenAI']];
const EFFORTS: [string, string][] = [['', 'Model default'], ['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'xhigh'], ['max', 'max']];
const TEST_RESULT = '__AITEST';

const check = (name: string, label: string, on: boolean, help?: string) =>
  html`<div class="field"><label class="check"><input type="checkbox" name="${name}" value="true"${on ? raw(' checked') : ''}> ${label}</label>${help ? html`<small class="help">${help}</small>` : ''}</div>`;

const when = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 19).replace('T', ' ') : '');

const KEY_TEXT = { stored: 'stored (encrypted)', env: 'server default', missing: 'missing' } as const;

function serviceForm(s: Partial<AiService>, action: string, csrfField: ReturnType<typeof csrf>, isNew: boolean) {
  const source = s.provider ? keySource(s as AiService) : null;
  return html`<form method="post" action="${action}">${csrfField}
    <fieldset class="prop-group"><legend>Service</legend><div class="form-grid">
      ${isNew ? input('name', 'Name', '', { required: true, placeholder: 'e.g. CLAUDE', help: 'Upper case letters, digits and _. Processes refer to the service by this name.' }) : ''}
      ${input('description', 'Description', s.description)}
      ${select('provider', 'Provider', s.provider ?? 'anthropic', PROVIDERS, 'Prompts, and the item values they contain, are sent to this provider.')}
      ${input('model', 'Model', s.model ?? (isNew ? DEFAULT_CLAUDE_MODEL : ''), { required: true, help: `Exactly as the provider names it, e.g. ${DEFAULT_CLAUDE_MODEL} (Claude) or the OpenAI model your account uses. pgkiln never changes it.` })}
      ${select('effort', 'Effort (Claude)', isNew ? 'medium' : s.effort ?? '', EFFORTS, 'How deeply Claude thinks (thinking is always on for current Claude models): lower is faster and cheaper; high or more for hard tasks. Model default: medium for Claude Opus 5.5.')}
      ${input('max_tokens', 'Maximum output tokens', s.max_tokens ?? 4000, { type: 'number', help: 'Per request (1 – 128000); a process may ask for fewer.' })}
      ${input('timeout_s', 'Time limit (seconds)', s.timeout_s ?? 120, { type: 'number', help: '5 – 600. Pages wait for the answer.' })}
      ${input('base_url', 'Base URL', s.base_url, { placeholder: 'empty: the provider\'s own API', help: 'A gateway or proxy that speaks the provider\'s API. Administrators only.' })}
    </div>
    ${check('refusal_fallback', 'Refusal fallbacks (Claude)', s.refusal_fallback !== false, 'When Claude declines a request for safety reasons, Anthropic re-runs it on its recommended fallback model. The usage log shows the model that answered.')}
    ${check('enabled', 'Enabled', s.enabled !== false)}
    </fieldset>
    <fieldset class="prop-group"><legend>API key</legend>
      ${input('api_key', 'API key', '', { type: 'password', auto: 'new-password', help: source === 'stored' ? 'A key is stored (encrypted). It is never shown; type a new one to replace it.' : `Empty: the server's ${envKeyName((s.provider as 'anthropic') ?? 'anthropic')} is used (when set).` })}
      ${source === 'stored' ? check('remove_key', 'Remove the stored key (use the server default)', false) : ''}
      ${secretKeyConfigured() ? '' : html`<div class="alert alert-error" role="alert">The server has no <code>PGAPEX_SECRET_KEY</code>: API keys can't be stored until it is set (the server's environment variables still work).</div>`}
    </fieldset>
    <div class="buttons"><button class="btn btn-hot">${isNew ? 'Add service' : 'Save'}</button></div>
  </form>`;
}

/** The form's values, checked; throws with a message. */
function formValues(b: Record<string, string | undefined>) {
  const provider = b.provider === 'openai' ? 'openai' : 'anthropic';
  const model = (b.model ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/.test(model)) throw new Error('The model is a name like claude-opus-5-5 (letters, digits and . _ : / @ -).');
  const maxTokens = Number(b.max_tokens || 4000);
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 128000) throw new Error('Maximum output tokens: 1 to 128000.');
  const timeout = Number(b.timeout_s || 120);
  if (!Number.isInteger(timeout) || timeout < 5 || timeout > 600) throw new Error('Time limit: 5 to 600 seconds.');
  const baseUrl = (b.base_url ?? '').trim() || null;
  if (baseUrl && (!/^https?:\/\/[^\s]+$/i.test(baseUrl) || baseUrl.length > 500)) throw new Error('The base URL starts with http:// or https://.');
  const effort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(b.effort ?? '') ? b.effort! : null;
  return [(b.description ?? '').trim() || null, provider, model, provider === 'anthropic' ? effort : null, b.refusal_fallback === 'true', maxTokens, timeout, baseUrl, b.enabled === 'true'];
}
const COLUMNS = 'description, provider, model, effort, refusal_fallback, max_tokens, timeout_s, base_url, enabled';

const usageTable = (rows: any[], withApp: boolean) => html`<div class="table-wrap"><table class="report report-reflow">
  <thead><tr><th>When (UTC)</th>${withApp ? html`<th>Application</th>` : ''}<th class="num">Page</th><th>User</th><th>Service</th><th>Model</th><th>Source</th><th class="num">Input</th><th class="num">Output</th><th class="num">ms</th><th>Status</th></tr></thead>
  <tbody>${rows.length ? rows.map((u) => html`<tr>
    <td data-label="When">${when(u.at)}</td>${withApp ? html`<td data-label="Application">${u.app ?? html`<span class="muted">builder</span>`}</td>` : ''}
    <td class="num" data-label="Page">${u.page_no ?? ''}</td><td data-label="User">${u.username ?? ''}</td><td data-label="Service">${u.service}</td>
    <td data-label="Model">${u.model}</td><td data-label="Source">${u.source}</td>
    <td class="num" data-label="Input">${u.input_tokens}</td><td class="num" data-label="Output">${u.output_tokens}</td><td class="num" data-label="ms">${u.duration_ms}</td>
    <td data-label="Status"><span class="tag${u.status === 'ok' ? ' tag-ok' : ' tag-error'}">${u.status}</span>${u.message ? html` <span class="muted">${u.message}</span>` : ''}</td></tr>`)
    : html`<tr><td colspan="${withApp ? 11 : 10}" class="empty">No AI requests yet.</td></tr>`}</tbody></table></div>`;

async function adminOnly(s: Session, reply: any, title: string) {
  if (await isAdmin(s.username)) return true;
  const main = html`<h1 class="u-mb1">${title}</h1><div class="alert alert-error" role="alert">Only administrators configure AI services.</div>`;
  await send(reply.code(403), s, shell(s, title, [['App Builder', BASE], ['Workspace utilities', `${BASE}/utilities`], [title]], main));
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
      <div class="title-row"><h1>AI services</h1></div>
      <p class="muted u-mt0">Large language models the applications of this installation may use (processes and dynamic actions <b>Generate text with AI</b>, and <code>meta.ai_generate()</code> from SQL). Prompts, including the item values they contain, are sent to the chosen provider. Allow each application on the service's page.</p>
      <div class="columns wide-left">
        ${region('Services', html`<div class="table-wrap"><table class="report report-reflow">
          <thead><tr><th>Service</th><th>Provider</th><th>Model</th><th>API key</th><th>Applications</th><th>Status</th></tr></thead>
          <tbody>${services.length ? services.map((x) => html`<tr>
            <td data-label="Service"><a href="${BASE}/ai/${x.id}">${x.name}</a>${x.description ? html` <span class="muted">${x.description}</span>` : ''}</td>
            <td data-label="Provider">${x.provider === 'anthropic' ? 'Claude' : 'OpenAI'}</td>
            <td data-label="Model">${x.model}${x.effort ? html` <span class="muted">(${x.effort})</span>` : ''}</td>
            <td data-label="API key">${KEY_TEXT[keySource(x)]}</td>
            <td data-label="Applications">${x.apps ?? html`<span class="muted">none</span>`}</td>
            <td data-label="Status">${x.enabled ? 'enabled' : html`<b>disabled</b>`}</td></tr>`)
            : html`<tr><td colspan="6" class="empty">No AI services yet.</td></tr>`}</tbody></table></div>`)}
        ${region('Add service', serviceForm({}, `${BASE}/ai`, csrf(s), true))}
      </div>
      ${region('Usage (30 days)', html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>Application</th><th>Service</th><th class="num">Requests</th><th class="num">Input tokens</th><th class="num">Output tokens</th><th class="num">Not ok</th></tr></thead>
        <tbody>${summary.length ? summary.map((r) => html`<tr><td data-label="Application">${r.app ?? html`<span class="muted">builder tests</span>`}</td><td data-label="Service">${r.service}</td><td class="num" data-label="Requests">${r.requests}</td>
          <td class="num" data-label="Input tokens">${r.input}</td><td class="num" data-label="Output tokens">${r.output}</td><td class="num" data-label="Not ok">${r.problems}</td></tr>`)
          : html`<tr><td colspan="6" class="empty">No AI requests in the last 30 days.</td></tr>`}</tbody></table></div>`)}
      ${region('Recent requests', html`<p class="muted u-mt0">Tokens, model, duration and status of each call. Prompts and answers are never logged (an application's debug messages at level 9 show them).</p>${usageTable(recent, true)}`)}`;
    return send(reply, s, shell(s, 'AI services', [['App Builder', BASE], ['Workspace utilities', `${BASE}/utilities`], ['AI services']], main));
  });

  app.post(`${BASE}/ai`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply, 'AI services'))) return;
    const b = req.body ?? {};
    try {
      const name = (b.name ?? '').trim().toUpperCase();
      if (!/^[A-Z][A-Z0-9_]{0,59}$/.test(name)) throw new Error('The name is upper case letters, digits and _ (e.g. CLAUDE).');
      const key = b.api_key ? encryptSecret(b.api_key) : null;
      const r = await owner.one(`insert into meta.ai_service (name, ${COLUMNS}, api_key_enc) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`, [name, ...formValues(b), key]);
      flash(s, 'AI service added. Allow applications to use it below, and test it.');
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
    const main = html`
      <div class="title-row"><h1 class="ai-name">${x.name}</h1></div>
      <div class="columns wide-left">
        ${region('Settings', html`${serviceForm(view, `${BASE}/ai/${x.id}`, csrf(s), false)}
          <form method="post" action="${BASE}/ai/${x.id}/delete" class="danger-zone">${csrf(s)}
            <button class="btn btn-danger" data-confirm="Delete AI service ${x.name}? Processes that use it fail until another service gets its name.">Delete service</button></form>`)}
        ${region('Test', html`
          <p class="muted u-mt0">Sends a prompt to the service (counted in the usage log as a builder test).</p>
          <form method="post" action="${BASE}/ai/${x.id}/test">${csrf(s)}
            <div class="field"><label class="label" for="ai_test_prompt">Prompt</label><textarea id="ai_test_prompt" name="prompt" rows="3" maxlength="4000">Reply with one short sentence to confirm you can read this.</textarea></div>
            <div class="buttons"><button class="btn">${icon('play')} Test</button></div></form>
          ${test ? html`<div class="alert ${test.ok ? 'alert-success' : 'alert-error'}" role="status">${test.meta ?? ''}</div><pre class="source">${test.text}</pre>` : ''}`)}
      </div>
      ${region('Applications', html`<p class="muted u-mt0">Which applications may use this service, with optional limits per day (UTC). Empty limits: no limit. Requests over a limit fail with a message and are logged as <i>limited</i>.</p>
        <form method="post" action="${BASE}/ai/${x.id}/apps">${csrf(s)}
        <div class="table-wrap"><table class="report report-reflow"><thead><tr><th>Application</th><th>May use</th><th>Requests per day</th><th>Tokens per day</th></tr></thead>
        <tbody>${apps.length ? apps.map((a) => html`<tr>
          <td data-label="Application">${a.name} <span class="muted">${a.alias}</span></td>
          <td data-label="May use"><label class="check"><input type="checkbox" name="allow" value="${a.id}"${a.allowed ? raw(' checked') : ''}> allowed</label></td>
          <td data-label="Requests per day"><input type="number" min="0" name="req_${a.id}" value="${a.max_requests ?? ''}" aria-label="Requests per day for ${a.alias}"></td>
          <td data-label="Tokens per day"><input type="number" min="0" name="tok_${a.id}" value="${a.max_tokens ?? ''}" aria-label="Tokens per day for ${a.alias}"></td></tr>`)
          : html`<tr><td colspan="4" class="empty">No applications.</td></tr>`}</tbody></table></div>
        <div class="buttons"><button class="btn btn-hot">Save access</button></div></form>`)}
      ${region('Recent requests', usageTable(recent, true))}`;
    return send(reply, s, shell(s, x.name, [['App Builder', BASE], ['Workspace utilities', `${BASE}/utilities`], ['AI services', `${BASE}/ai`], [x.name]], main));
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
        [req.params.id, ...formValues(b), key, b.remove_key === 'true'],
      );
      flash(s, r.rowCount ? 'AI service saved.' : 'Not found.', r.rowCount ? 'ok' : 'error');
    } catch (e) {
      flash(s, (e as Error).message, 'error');
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
      if (!Number.isInteger(n) || n < 0) throw new Error('Limits are whole numbers of 0 or more (empty: no limit).');
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
      flash(s, 'Access saved.');
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
      result = { id: x.id, ok: true, text, meta: `Answered by ${r.model}: ${r.inputTokens} input and ${r.outputTokens} output tokens.` };
    } catch (e) {
      result = { id: x.id, ok: false, text: '', meta: e instanceof AiError ? e.message : 'The test failed.' };
    }
    s.state[TEST_RESULT] = JSON.stringify(result);
    return back(reply, s, `${BASE}/ai/${x.id}`);
  });

  app.post(`${BASE}/ai/:id(^\\d+$)/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply, 'AI services'))) return;
    await owner.query('delete from meta.ai_service where id = $1', [req.params.id]);
    flash(s, 'AI service deleted.');
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
      <p class="muted u-mt0">The AI services this application may use (an administrator allows them${admin ? html` under <a href="${BASE}/ai">AI services</a>` : ''}), today's use against their limits, and the recent requests.</p>
      ${region('Services', html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>Service</th><th>Model</th><th class="num">Requests today</th><th class="num">Tokens today</th><th>Status</th></tr></thead>
        <tbody>${allowed.length ? allowed.map((x, i) => html`<tr><td data-label="Service">${x.name}</td><td data-label="Model">${x.provider === 'anthropic' ? 'Claude' : 'OpenAI'} ${x.model}</td>
          <td class="num" data-label="Requests today">${today[i].requests}${x.max_requests !== null ? ` / ${x.max_requests}` : ''}</td>
          <td class="num" data-label="Tokens today">${today[i].tokens}${x.max_tokens !== null ? ` / ${x.max_tokens}` : ''}</td>
          <td data-label="Status">${x.enabled ? 'enabled' : html`<b>disabled</b>`}</td></tr>`)
          : html`<tr><td colspan="5" class="empty">This application may not use any AI service yet.</td></tr>`}</tbody></table></div>`)}
      ${region('Recent requests', usageTable(recent, false))}`;
    return send(reply, s, shell(s, `AI usage · ${a.name}`, [['App Builder', BASE], [a.name, `${BASE}/apps/${a.id}`], ['Activity', `${BASE}/apps/${a.id}/activity`], ['AI usage']], main));
  });
}
