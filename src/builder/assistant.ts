import type { FastifyInstance } from 'fastify';
import { providerLabel } from '../ai/service.ts';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { aiFilterProblems } from '../runtime/ai-filter.ts';
import { assistantProblems, type AssistantConfig } from '../runtime/assistant.ts';
import type { Session } from '../session.ts';
import { agentOptions } from './ai-agents.ts';
import { back, BASE, csrf, developer, flash, type Req } from './ui.ts';
import { scopedTx as tx } from './i18n.ts';

// Page designer → an AI assistant region → Settings (service, prompts,
// context queries, tools, limits), and → a report region → "Ask in your own
// words" (natural-language filters with an AI service). Saving replaces only
// the keys these forms know.

type Config = Record<string, any>;
type Body = Record<string, string | undefined>;

const opt = (value: string, label: string, current: unknown) => html`<option value="${value}"${String(current ?? '') === value ? raw(' selected') : ''}>${label}</option>`;

/** The AI services an application may use, plus `current` when it names another one. */
async function serviceOptions(appId: number, current: unknown) {
  const allowed = (await owner.query<{ name: string; provider: string; model: string }>(
    `select s.name, s.provider, s.model from meta.ai_service s join meta.app_ai_service x on x.service_id = s.id and x.app_id = $1 where s.enabled order by s.name`, [appId])).rows;
  const cur = typeof current === 'string' ? current.toUpperCase() : '';
  return {
    allowed,
    options: html`${allowed.map((x) => opt(x.name, `${x.name} (${providerLabel(x.provider)}, ${x.model})`, cur))}${cur && !allowed.some((x) => x.name === cur) ? opt(cur, `${cur} (not available to this application)`, cur) : ''}`,
  };
}

const NO_SERVICE = () => html`<p class="muted">${tx.rich('asst.no_service', { link: html`<a href="${BASE}/ai">${tx('asst.workspace_utilities_ai_services')}</a>` })}</p>`;

const json = (v: unknown) => (v === undefined ? '' : JSON.stringify(v, null, 2));

export async function assistantSettingsForm(pageId: number, appId: number, r: { id: number; config: Config }, s: Session): Promise<Raw> {
  const cfg = (r.config ?? {}) as AssistantConfig;
  const id = (n: string) => `ra_${r.id}_${n}`;
  const { allowed, options } = await serviceOptions(appId, cfg.service);
  const problems = assistantProblems(cfg);
  const agents = await agentOptions(appId);
  const agent = typeof cfg.agent === 'string' ? cfg.agent.toUpperCase() : '';
  return html`<h3 class="u-mt15">${tx('asst.ai_assistant_settings')}</h3>
    <p class="muted u-mt0">${tx('asst.a_chat_with_an_ai')}</p>
    ${allowed.length ? '' : NO_SERVICE()}
    ${problems.length ? html`<div class="alert alert-error" role="alert">${problems.join(' ')}</div>` : ''}
    <form method="post" action="${BASE}/pages/${pageId}/region/${r.id}/assistant" class="component-form">${csrf(s)}
      <fieldset class="prop-group"><legend>${tx('asst.assistant')}</legend><div class="form-grid">
        <div class="field"><label class="label" for="${id('agent')}">${tx('asst.ai_agent')}</label>
          <select id="${id('agent')}" name="agent">${opt('', tx('asst.none_the_service_prompt_and'), agent)}${agents.map((n) => opt(n, n, agent))}${agent && !agents.includes(agent) ? opt(agent, `${agent} (does not exist)`, agent) : ''}</select>
          <small class="help">${tx.rich('asst.agent_help', { link: html`<a href="${BASE}/apps/${appId}/ai-agents">${tx('asst.shared_components_ai_agents')}</a>` })}</small></div>
        <div class="field"><label class="label" for="${id('service')}">${tx('asst.ai_service')}</label>
          <select id="${id('service')}" name="service">${opt('', tx('asst.choose'), cfg.service ?? '')}${options}</select></div>
        <div class="field"><label class="label" for="${id('max_rounds')}">${tx('asst.tool_rounds_per_question')}</label>
          <input id="${id('max_rounds')}" name="max_rounds" type="number" min="1" max="10" value="${cfg.max_rounds ?? ''}" placeholder="5"></div>
        <div class="field"><label class="label" for="${id('max_turns')}">${tx('asst.questions_per_conversation')}</label>
          <input id="${id('max_turns')}" name="max_turns" type="number" min="1" max="100" value="${cfg.max_turns ?? ''}" placeholder="20"></div>
        <div class="field" data-wide><label class="label" for="${id('system')}">${tx('asst.system_prompt')}</label>
          <textarea id="${id('system')}" name="system" rows="4">${cfg.system ?? ''}</textarea>
          <small class="help">${tx.code('asst.who_the_assistant_is_and')}</small></div>
        <div class="field" data-wide><label class="label" for="${id('welcome')}">${tx('asst.welcome_text')}</label>
          <textarea id="${id('welcome')}" name="welcome" rows="2">${cfg.welcome ?? ''}</textarea></div>
        <div class="field"><label class="label" for="${id('placeholder')}">${tx('asst.placeholder')}</label>
          <input id="${id('placeholder')}" name="placeholder" maxlength="200" value="${cfg.placeholder ?? ''}"></div>
        <div class="field"><label class="label" for="${id('error_message')}">${tx('asst.error_message')}</label>
          <input id="${id('error_message')}" name="error_message" maxlength="300" value="${cfg.error_message ?? ''}" placeholder="${tx('asst.the_service_s_message')}"></div>
      </div>
      <div class="field"><label class="check"><input type="checkbox" name="public" value="true"${cfg.public ? raw(' checked') : ''}> ${tx('asst.also_for_users_who_are')}</label></div></fieldset>
      <fieldset class="prop-group"><legend>${tx('asst.context_and_tools')}</legend>
        <div class="field"><label class="label" for="${id('context')}">${tx('asst.context_queries_json')}</label>
          <textarea id="${id('context')}" name="context" rows="5" class="code" spellcheck="false">${json(cfg.context)}</textarea>
          <small class="help">${tx.code('asst.run_before_each_question_their')}</small></div>
        <div class="field"><label class="label" for="${id('tools')}">${tx('asst.tools_json')}</label>
          <textarea id="${id('tools')}" name="tools" rows="10" class="code" spellcheck="false">${json(cfg.tools)}</textarea>
          <small class="help">${tx.code('asst.the_model_calls_them_when')}</small></div>
      </fieldset>
      <div class="buttons"><button class="btn btn-hot">${tx('asst.save_ai_assistant_settings')}</button></div>
    </form>`;
}

/** Problems that need the application: unknown REST data sources and authorization schemes in tools. */
async function appProblems(appId: number, cfg: AssistantConfig) {
  const out: string[] = [];
  const sources = new Set((await owner.query<{ name: string }>('select name from meta.rest_source where app_id = $1', [appId])).rows.map((x) => x.name));
  const schemes = new Set((await owner.query<{ name: string }>('select name from meta.authz_scheme where app_id = $1', [appId])).rows.map((x) => x.name.toUpperCase()));
  for (const t of Array.isArray(cfg.tools) ? cfg.tools : []) {
    if (t?.type === 'rest' && typeof t.source === 'string' && !sources.has(t.source.toUpperCase())) out.push(tx('asst.no_rest_source', { tool: t.name, source: t.source.toUpperCase() }));
    if (typeof t?.authz === 'string' && t.authz.trim() && !['MUST_NOT_BE_PUBLIC_USER'].includes(t.authz.replace(/^!/, '').trim().toUpperCase()) && !schemes.has(t.authz.replace(/^!/, '').trim().toUpperCase()))
      out.push(tx('asst.no_authz', { tool: t.name, scheme: t.authz }));
  }
  return out;
}

/** The posted settings merged into the region's config; problems of the result (it is saved anyway). */
export async function mergeAssistantSettings(appId: number, config: Config, b: Body) {
  const out: Config = { ...config };
  const errors: string[] = [];
  const text = (k: string, max: number) => {
    const v = (b[k] ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);
    if (v) out[k] = v;
    else delete out[k];
  };
  out.service = (b.service ?? '').trim().toUpperCase();
  if (!out.service) delete out.service;
  // (121) an agent sets the service, system prompt, tools and steps itself
  const agent = (b.agent ?? '').trim().toUpperCase();
  if (agent) out.agent = agent;
  else delete out.agent;
  text('system', 20_000);
  text('welcome', 2000);
  text('placeholder', 200);
  text('error_message', 300);
  for (const k of ['max_rounds', 'max_turns']) {
    const v = (b[k] ?? '').trim();
    if (v) out[k] = Number(v);
    else delete out[k];
  }
  if (b.public === 'true') out.public = true;
  else delete out.public;
  for (const k of ['context', 'tools']) {
    const v = (b[k] ?? '').trim();
    if (!v) delete out[k];
    else
      try {
        out[k] = JSON.parse(v);
      } catch {
        errors.push(`${k === 'tools' ? tx('asst.tools') : tx('asst.context_queries')}: not valid JSON (kept as it was).`);
      }
  }
  if (out.agent) {
    for (const k of ['service', 'system', 'tools', 'max_rounds']) delete out[k];
    if (!(await agentOptions(appId)).includes(out.agent)) errors.push(tx('asst.no_agent', { agent: out.agent }));
  }
  errors.push(...assistantProblems(out), ...(await appProblems(appId, out as AssistantConfig)));
  return { config: out, errors };
}

/** The "Ask in your own words" settings under a report region. */
export async function aiFilterSettingsForm(pageId: number, appId: number, r: { id: number; config: Config }, s: Session): Promise<Raw> {
  const cfg = (r.config?.ai_filter ?? {}) as Config;
  const id = (n: string) => `raf_${r.id}_${n}`;
  const { options } = await serviceOptions(appId, cfg.service);
  return html`<h3 class="u-mt15">${tx('asst.ask_in_your_own_words')}</h3>
    <p class="muted u-mt0">${tx.rich('asst.filter_intro', { builtin: html`<i>${tx('asst.built_in_phrases')}</i>` })}</p>
    <form method="post" action="${BASE}/pages/${pageId}/region/${r.id}/ai-filter" class="component-form">${csrf(s)}
      <div class="form-grid">
        <div class="field"><label class="label" for="${id('service')}">${tx('asst.ai_service')}</label>
          <select id="${id('service')}" name="service">${opt('', tx('asst.off'), r.config?.ai_filter ? '-' : '')}${opt('-', tx('asst.built_in_phrases_no_ai'), r.config?.ai_filter && !cfg.service ? '-' : '')}${options}</select></div>
        <div class="field" data-wide><label class="label" for="${id('placeholder')}">${tx('asst.placeholder')}</label>
          <input id="${id('placeholder')}" name="placeholder" maxlength="200" value="${cfg.placeholder ?? ''}"></div>
      </div>
      <div class="field"><label class="check"><input type="checkbox" name="public" value="true"${cfg.public ? raw(' checked') : ''}> ${tx('asst.also_for_users_who_are_2')}</label></div>
      <div class="buttons"><button class="btn">${tx('asst.save')}</button></div>
    </form>`;
}

export async function assistantBuilderRoutes(app: FastifyInstance) {
  const regionOf = async (pid: string, rid: string, type: string) =>
    /^\d{1,9}$/.test(pid) && /^\d{1,9}$/.test(rid)
      ? owner.one<{ id: number; config: Config; app_id: number }>(
          `select r.id, r.config, p.app_id from meta.region r join meta.page p on p.id = r.page_id where r.id = $1 and r.page_id = $2 and r.type = $3`, [rid, pid, type])
      : undefined;

  app.post(`${BASE}/pages/:pid/region/:rid/assistant`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const { pid, rid } = req.params as { pid: string; rid: string };
    const r = await regionOf(pid, rid, 'ai_assistant');
    if (!r) return reply.code(404).send('Not found');
    const { config, errors } = await mergeAssistantSettings(r.app_id, r.config ?? {}, (req.body ?? {}) as Body);
    await owner.query('update meta.region set config = $2 where id = $1', [r.id, JSON.stringify(config)]);
    if (errors.length) flash(s, `Saved, but: ${errors.join(' ')}`, 'error');
    else flash(s, tx('asst.settings_saved'));
    return back(reply, s, `${BASE}/pages/${pid}?c=region-${rid}`);
  });

  app.post(`${BASE}/pages/:pid/region/:rid/ai-filter`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const { pid, rid } = req.params as { pid: string; rid: string };
    const r = await regionOf(pid, rid, 'report');
    if (!r) return reply.code(404).send('Not found');
    const b = (req.body ?? {}) as Body;
    const config: Config = { ...(r.config ?? {}) };
    const service = (b.service ?? '').trim().toUpperCase();
    if (!service) delete config.ai_filter;
    else {
      // "-": the built-in phrases, no AI service (sprint 112)
      const placeholder = (b.placeholder ?? '').trim().slice(0, 200);
      config.ai_filter = { ...(service === '-' ? {} : { service }), ...(placeholder ? { placeholder } : {}), ...(b.public === 'true' ? { public: true } : {}) };
    }
    const errors = aiFilterProblems(config.ai_filter);
    if (errors.length) flash(s, errors.join(' '), 'error');
    else {
      await owner.query('update meta.region set config = $2 where id = $1', [r.id, JSON.stringify(config)]);
      flash(s, tx('asst.settings_saved'));
    }
    return back(reply, s, `${BASE}/pages/${pid}?c=region-${rid}`);
  });
}
