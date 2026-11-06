import type { FastifyInstance, FastifyReply } from 'fastify';
import { providerLabel } from '../ai/service.ts';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { agentProblems, aiToolProblems, definitionProblems, EFFORTS, type AiAgent, type AiTool } from '../runtime/ai-agents.ts';
import type { Session } from '../session.ts';
import { appOr404 } from './forms.ts';
import { appHeader, back, BASE, csrf, developer, flash, input, region, select, send, shell, type Req } from './ui.ts';
import { scopedTx as tx } from './i18n.ts';

// Shared Components → Generative AI → AI Agents (migration 121): the
// application's AI tools and AI agents, kept as two JSON lists in meta.app
// (ai_tools, ai_agents) and exported with the application. Each form checks
// its entry (src/runtime/ai-agents.ts) before it saves; the runtime checks
// again. Also the "Tool calls" region of Activity → AI usage.

type Body = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
const all = (v: string | string[] | undefined) => (v === undefined ? [] : [v].flat());

const TOOL_TYPES = (): [string, string][] => [
  ['sql', tx('agt.type.sql')],
  ['function', tx('agt.type.function')],
  ['rest', tx('agt.type.rest')],
  ['javascript', tx('agt.type.javascript')],
  ['navigate', tx('agt.type.navigate')],
  ['retrieve', tx('agt.type.retrieve')],
];

const when = (d: Date | string) => new Date(d).toISOString().slice(0, 19).replace('T', ' ');
const area = (name: string, label: string, value: unknown, rows: number, help: string, code = false) => html`<div class="field" data-wide><label class="label" for="f_${name}">${label}</label>
  <textarea id="f_${name}" name="${name}" rows="${rows}"${code ? raw(' class="code" spellcheck="false"') : ''}>${value ?? ''}</textarea><small class="help">${help}</small></div>`;

async function schemes(appId: number) {
  return (await owner.query<{ name: string }>('select name from meta.authz_scheme where app_id = $1 order by name', [appId])).rows.map((x) => x.name);
}

const authzSelect = (names: string[], cur: unknown, help: string) =>
  select('authz', tx('agt.authorization_scheme'), cur ?? '', [['', tx('agt.none_everyone_who_may_use')], ['MUST_NOT_BE_PUBLIC_USER', tx('agt.must_not_be_the_public')], ...names.map((n): [string, string] => [n, n]),
    ...(typeof cur === 'string' && cur && cur !== 'MUST_NOT_BE_PUBLIC_USER' && !names.includes(cur) ? [[cur, `${cur} (does not exist)`] as [string, string]] : [])], help);

const crumbs = (a: { id: number; name: string }, last?: string): [string, string?][] => [
  [tx('agt.app_builder'), BASE], [a.name, `${BASE}/apps/${a.id}`], [tx('agt.shared_components'), `${BASE}/apps/${a.id}/shared`],
  ...(last ? [[tx('agt.ai_agents'), `${BASE}/apps/${a.id}/ai-agents`], [last]] as [string, string?][] : [[tx('agt.ai_agents')]] as [string, string?][]),
];

// ---------------------------------------------------------------- forms

async function agentForm(a: any, s: Session, x: Partial<AiAgent>, original: string, problems: string[]): Promise<Raw> {
  const services = (await owner.query<{ name: string; provider: string; model: string }>(
    `select s.name, s.provider, s.model from meta.ai_service s join meta.app_ai_service x on x.service_id = s.id and x.app_id = $1 where s.enabled order by s.name`, [a.id])).rows;
  const tools = (a.ai_tools ?? []) as AiTool[];
  const chosen = new Set(x.tools ?? []);
  const svc: [string, string][] = [['', tx('agt.choose')], ...services.map((v): [string, string] => [v.name, `${v.name} (${providerLabel(v.provider)}, ${v.model})`])];
  if (x.service && !services.some((v) => v.name === x.service)) svc.push([x.service, `${x.service} (not available to this application)`]);
  const usedBy = original
    ? (await owner.query<{ page_no: number; title: string | null; page_id: number; id: number }>(
        `select p.page_no, r.title, p.id as page_id, r.id from meta.region r join meta.page p on p.id = r.page_id
          where p.app_id = $1 and r.type = 'ai_assistant' and upper(r.config->>'agent') = $2 order by p.page_no, r.seq`, [a.id, original])).rows
    : [];
  return html`${problems.length ? html`<div class="alert alert-error" role="alert">${problems.join(' ')}</div>` : ''}
    ${services.length ? '' : html`<p class="muted">${tx('agt.this_application_may_not_use')}</p>`}
    <form method="post" action="${BASE}/apps/${a.id}/ai-agents/agent">${csrf(s)}<input type="hidden" name="original" value="${original}">
      <fieldset class="prop-group"><legend>${tx('agt.agent')}</legend><div class="form-grid">
        ${input('name', tx('agt.name'), x.name ?? '', { required: true, placeholder: tx('agt.e_g_sales_agent'), help: tx('agt.upper_case_letters_digits_and') })}
        ${input('description', tx('agt.description'), x.description ?? '')}
        ${select('service', tx('agt.ai_service'), x.service ?? '', svc, tx('agt.the_conversation_the_tools_results'))}
        ${select('effort', tx('agt.reasoning_effort'), x.effort ?? '', [['', tx('agt.the_service_s_2')], ...EFFORTS.map((e): [string, string] => [e, e])],
          tx('agt.effort_help'))}
        ${input('max_steps', tx('agt.maximum_steps'), x.max_steps ?? '', { type: 'number', placeholder: '5', help: tx('agt.rounds_of_tool_calls_per') })}
        ${input('max_tokens', tx('agt.maximum_output_tokens'), x.max_tokens ?? '', { type: 'number', placeholder: tx('agt.the_service_s'), help: tx('agt.per_call_to_the_model') })}
        ${authzSelect(await schemes(a.id), x.authz, tx('agt.only_users_who_pass_it'))}
        ${area('system', tx('agt.system_prompt'), x.system ?? '', 6, tx('agt.system_help'))}
      </div></fieldset>
      <fieldset class="prop-group"><legend>${tx('agt.tools')}</legend>
        ${tools.length
          ? html`<p class="muted u-mt0">${tx('agt.the_agent_acts_only_through')}</p>${tools.map((t) => html`<div class="field"><label class="check"><input type="checkbox" name="tools" value="${t.name}"${chosen.has(t.name) ? raw(' checked') : ''}> <b>${t.name}</b> <span class="muted">(${t.type}) ${t.description}</span></label></div>`)}`
          : html`<p class="muted u-mt0">${tx.rich('agt.no_tools', { link: html`<a href="${BASE}/apps/${a.id}/ai-agents/tool">${tx('agt.add_one')}</a>` })}</p>`}
      </fieldset>
      <div class="buttons"><button class="btn btn-hot">${original ? tx('agt.save') : tx('agt.add_agent')}</button></div>
    </form>
    ${original ? html`<h3>${tx('agt.used_by')}</h3>${usedBy.length
      ? html`<ul>${usedBy.map((r) => html`<li><a href="${BASE}/pages/${r.page_id}?c=region-${r.id}">Page ${r.page_no}: ${r.title ?? 'AI assistant'}</a></li>`)}</ul>`
      : html`<p class="muted">${tx('agt.no_ai_assistant_region_uses')}</p>`}
      <form method="post" action="${BASE}/apps/${a.id}/ai-agents/agent/delete" class="danger-zone">${csrf(s)}<input type="hidden" name="name" value="${original}">
        <button class="btn btn-danger" data-confirm="${tx('agt.delete_agent_confirm', { name: original })}">${tx('agt.delete_agent')}</button></form>` : ''}`;
}

async function toolForm(a: any, s: Session, x: Partial<AiTool> & { parameters_text?: string }, original: string, problems: string[]): Promise<Raw> {
  const sources = (await owner.query<{ name: string }>('select name from meta.rest_source where app_id = $1 order by name', [a.id])).rows.map((r) => r.name);
  const configs = (await owner.query<{ name: string; search_type: string }>(`select name, search_type from meta.search_config where app_id = $1 and source_type <> 'list' order by name`, [a.id])).rows;
  const params = x.parameters_text ?? (x.parameters ? JSON.stringify(x.parameters, null, 2) : '');
  const usedBy = original ? ((a.ai_agents ?? []) as AiAgent[]).filter((g) => (g.tools ?? []).includes(original)).map((g) => g.name) : [];
  return html`${problems.length ? html`<div class="alert alert-error" role="alert">${problems.join(' ')}</div>` : ''}
    <form method="post" action="${BASE}/apps/${a.id}/ai-agents/tool">${csrf(s)}<input type="hidden" name="original" value="${original}">
      <fieldset class="prop-group"><legend>${tx('agt.tool')}</legend><div class="form-grid">
        ${input('name', tx('agt.name'), x.name ?? '', { required: true, placeholder: tx('agt.e_g_top_earners'), help: tx('agt.letters_digits_and_the_model') })}
        ${select('type', tx('agt.type'), x.type ?? 'sql', TOOL_TYPES(), tx('agt.what_the_tool_does_each'))}
        ${area('description', tx('agt.description'), x.description ?? '', 2, tx('agt.tells_the_model_what_the'))}
        ${area('sql', tx('agt.sql_query_sql'), x.sql ?? '', 6, tx('agt.sql_help'), true)}
        ${input('function', tx('agt.function_pl_pgsql'), x.function ?? '', { placeholder: tx('agt.e_g_sales_give_discount'), help: tx('agt.schema_name_called_as_the') })}
        ${select('source', tx('agt.rest_data_source_rest'), x.source ?? '', [['', '-'], ...sources.map((n): [string, string] => [n, n])], tx('agt.the_parameters_become_the_source'))}
        ${input('action', tx('agt.action_javascript'), x.action ?? '', { placeholder: tx('agt.e_g_highlightorder'), help: tx('agt.after_the_answer_the_browser') })}
        ${input('pages', tx('agt.pages_navigate'), (x.pages ?? []).join(', '), { placeholder: 'e.g. 3, 7', help: tx('agt.the_page_numbers_the_agent') })}
        ${select('search_config', tx('agt.search_configuration_retrieve'), x.search_config ?? '', [['', '-'], ...configs.map((c): [string, string] => [c.name, `${c.name} (${c.search_type})`]),
          ...(x.search_config && !configs.some((c) => c.name === x.search_config) ? [[x.search_config, `${x.search_config} (does not exist)`] as [string, string]] : [])],
          'The model gives a text; pgkiln runs this search configuration (best: vector or hybrid) as the application\'s role, so row level security applies, and returns the best rows\' title, text and score.')}
        ${area('parameters', tx('agt.parameters_json_not_for_navigate'), params, 6, '{"DNAME": {"type": "string", "description": "A department name"}, "LIMIT": {"type": "integer", "optional": true}}. Types: string, integer, number, boolean, date; "enum" for a list of texts.', true)}
        ${input('max_rows', tx('agt.maximum_rows'), x.max_rows ?? '', { type: 'number', placeholder: '50', help: tx('agt.rows_the_model_gets_back') })}
        ${input('timeout_s', tx('agt.time_limit_seconds'), x.timeout_s ?? '', { type: 'number', placeholder: '15', help: tx('agt.sql_and_function_tools_1') })}
        ${authzSelect(await schemes(a.id), x.authz, tx('agt.only_users_who_pass_it_2'))}
      </div></fieldset>
      <div class="buttons"><button class="btn btn-hot">${original ? tx('agt.save') : tx('agt.add_tool')}</button></div>
    </form>
    ${original ? html`<h3>${tx('agt.used_by')}</h3>${usedBy.length ? html`<p>${usedBy.join(', ')}</p>` : html`<p class="muted">${tx('agt.no_agent_uses_this_tool')}</p>`}
      <form method="post" action="${BASE}/apps/${a.id}/ai-agents/tool/delete" class="danger-zone">${csrf(s)}<input type="hidden" name="name" value="${original}">
        <button class="btn btn-danger" data-confirm="${tx('agt.delete_tool_confirm', { name: original })}">${tx('agt.delete_tool')}</button></form>` : ''}`;
}

// ---------------------------------------------------------------- reading the forms

const intOrUndef = (v: string, what: string, errors: string[]) => {
  const t = v.trim();
  if (!t) return undefined;
  const n = Number(t);
  if (!Number.isInteger(n)) errors.push(tx('agt.whole_number', { what }));
  return n;
};

function agentFrom(b: Body, errors: string[]): AiAgent {
  const x: AiAgent = { name: one(b.name).trim().toUpperCase(), service: one(b.service).trim().toUpperCase() };
  const text = (k: 'description' | 'system', max: number) => {
    const v = one(b[k]).replace(/\r\n?/g, '\n').trim().slice(0, max);
    if (v) x[k] = v;
  };
  text('description', 500);
  text('system', 20_000);
  const effort = one(b.effort);
  if (effort) x.effort = effort as AiAgent['effort'];
  const tools = all(b.tools).map((t) => t.trim()).filter(Boolean);
  if (tools.length) x.tools = [...new Set(tools)];
  const steps = intOrUndef(one(b.max_steps), tx('agt.f_steps'), errors);
  if (steps !== undefined) x.max_steps = steps;
  const tokens = intOrUndef(one(b.max_tokens), tx('agt.f_tokens'), errors);
  if (tokens !== undefined) x.max_tokens = tokens;
  const authz = one(b.authz).trim();
  if (authz) x.authz = authz;
  return x;
}

function toolFrom(b: Body, errors: string[]): AiTool & { parameters_text?: string } {
  const type = one(b.type) as AiTool['type'];
  const x: AiTool & { parameters_text?: string } = { name: one(b.name).trim(), type, description: one(b.description).replace(/\r\n?/g, '\n').trim() };
  if (type === 'sql') x.sql = one(b.sql).replace(/\r\n?/g, '\n').trim();
  if (type === 'function') x.function = one(b.function).trim();
  if (type === 'rest') x.source = one(b.source).trim().toUpperCase();
  if (type === 'javascript') x.action = one(b.action).trim();
  if (type === 'navigate') x.pages = one(b.pages).split(/[\s,;]+/).filter(Boolean).map(Number);
  if (type === 'retrieve') x.search_config = one(b.search_config).trim().toUpperCase();
  const params = one(b.parameters).trim();
  if (params && type !== 'navigate' && type !== 'retrieve') {
    try {
      x.parameters = JSON.parse(params);
    } catch {
      errors.push(tx('agt.parameters_not_valid_json'));
      x.parameters_text = params;
    }
  }
  if (type === 'sql' || type === 'function' || type === 'rest' || type === 'retrieve') {
    const rows = intOrUndef(one(b.max_rows), tx('agt.f_rows'), errors);
    if (rows !== undefined) x.max_rows = rows;
  }
  if (type === 'sql' || type === 'function' || type === 'retrieve') {
    const t = intOrUndef(one(b.timeout_s), tx('agt.f_timeout'), errors);
    if (t !== undefined) x.timeout_s = t;
  }
  const authz = one(b.authz).trim();
  if (authz) x.authz = authz;
  return x;
}

/** Change the application's lists in one transaction (row locked); `change` returns problems to refuse with. */
async function update(appId: number, change: (agents: AiAgent[], tools: AiTool[]) => string[] | Promise<string[]>) {
  return owner.tx(async (c) => {
    const row = (await c.query<{ ai_agents: AiAgent[]; ai_tools: AiTool[] }>('select ai_agents, ai_tools from meta.app where id = $1 for update', [appId])).rows[0];
    const agents = [...(row?.ai_agents ?? [])];
    const tools = [...(row?.ai_tools ?? [])];
    const problems = await change(agents, tools);
    if (problems.length) return problems;
    await c.query('update meta.app set ai_agents = $2, ai_tools = $3, updated_at = now() where id = $1', [appId, JSON.stringify(agents), JSON.stringify(tools)]);
    return [];
  });
}

// ---------------------------------------------------------------- AI usage: tool calls

/** The "Tool calls" region of Activity → AI usage: the latest calls with their arguments. */
export async function toolCallTable(appId: number): Promise<Raw> {
  const rows = (await owner.query('select * from meta.ai_tool_call where app_id = $1 order by id desc limit 100', [appId])).rows;
  return region(tx('agt.tool_calls'), html`<p class="muted u-mt0">${tx('agt.every_tool_call_of_the')}</p>
    <div class="table-wrap"><table class="report report-reflow">
    <thead><tr><th>${tx('agt.when_utc')}</th><th class="num">${tx('agt.page')}</th><th>${tx('agt.user')}</th><th>${tx('agt.agent')}</th><th>${tx('agt.tool')}</th><th>${tx('agt.arguments')}</th><th class="num">ms</th><th>${tx('agt.status')}</th></tr></thead>
    <tbody>${rows.length ? rows.map((r) => html`<tr>
      <td data-label="${tx('agt.when')}">${when(r.at)}</td><td class="num" data-label="${tx('agt.page')}">${r.page_no ?? ''}</td><td data-label="${tx('agt.user')}">${r.username ?? ''}</td>
      <td data-label="${tx('agt.agent')}">${r.agent ?? html`<span class="muted">region</span>`}</td><td data-label="${tx('agt.tool')}">${r.tool} <span class="muted">${r.type}</span></td>
      <td data-label="${tx('agt.arguments')}"><code class="ai-args">${JSON.stringify(r.arguments)}</code></td><td class="num" data-label="ms">${r.duration_ms}</td>
      <td data-label="${tx('agt.status')}"><span class="tag${r.status === 'ok' ? ' tag-ok' : ' tag-error'}">${r.status}</span>${r.message ? html` <span class="muted">${r.message}</span>` : ''}</td></tr>`)
      : html`<tr><td colspan="8" class="empty">${tx('agt.no_tool_calls_yet')}</td></tr>`}</tbody></table></div>`);
}

// ---------------------------------------------------------------- routes

export async function aiAgentRoutes(app: FastifyInstance) {
  const load = async (req: Req, reply: FastifyReply) => {
    const s = await developer(req, reply);
    if (!s) return null;
    const a = await appOr404(req.params.id);
    if (!a) {
      reply.code(404).send('Not found');
      return null;
    }
    return { s, a };
  };

  app.get(`${BASE}/apps/:id(^\\d+$)/ai-agents`, async (req: Req, reply) => {
    const ok = await load(req, reply);
    if (!ok) return;
    const { s, a } = ok;
    const agents = (a.ai_agents ?? []) as AiAgent[];
    const tools = (a.ai_tools ?? []) as AiTool[];
    const problems = definitionProblems(agents, tools);
    const main = html`${appHeader(a, 'shared', s)}
      <div class="title-row"><h1>${tx('agt.ai_agents')}</h1></div>
      <p class="muted u-mt0">${tx.rich('agt.intro', { usage: html`<a href="${BASE}/apps/${a.id}/ai">${tx('agt.ai_usage')}</a>` })}</p>
      ${problems.length ? html`<div class="alert alert-error" role="alert">${problems.join(' ')}</div>` : ''}
      <div class="columns">
        ${region(tx('agt.agents'), html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>${tx('agt.agent')}</th><th>${tx('agt.ai_service')}</th><th>${tx('agt.tools')}</th><th>${tx('agt.authorization')}</th></tr></thead>
          <tbody>${agents.length ? agents.map((g) => html`<tr><td data-label="${tx('agt.agent')}"><a href="${BASE}/apps/${a.id}/ai-agents/agent?name=${encodeURIComponent(g.name)}">${g.name}</a>${g.description ? html` <span class="muted">${g.description}</span>` : ''}</td>
            <td data-label="${tx('agt.ai_service')}">${g.service}${g.effort ? html` <span class="muted">(${g.effort})</span>` : ''}</td><td data-label="${tx('agt.tools')}">${(g.tools ?? []).join(', ')}</td><td data-label="${tx('agt.authorization')}">${g.authz ?? ''}</td></tr>`)
            : html`<tr><td colspan="4" class="empty">${tx('agt.no_ai_agents_yet')}</td></tr>`}</tbody></table></div>
          <p><a class="btn" href="${BASE}/apps/${a.id}/ai-agents/agent">${icon('plus')} ${tx('agt.add_agent')}</a></p>`)}
        ${region(tx('agt.tools'), html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>${tx('agt.tool')}</th><th>${tx('agt.type')}</th><th>${tx('agt.authorization')}</th></tr></thead>
          <tbody>${tools.length ? tools.map((t) => html`<tr><td data-label="${tx('agt.tool')}"><a href="${BASE}/apps/${a.id}/ai-agents/tool?name=${encodeURIComponent(t.name)}">${t.name}</a> <span class="muted">${t.description}</span></td>
            <td data-label="${tx('agt.type')}">${t.type}</td><td data-label="${tx('agt.authorization')}">${t.authz ?? ''}</td></tr>`)
            : html`<tr><td colspan="3" class="empty">${tx('agt.no_ai_tools_yet')}</td></tr>`}</tbody></table></div>
          <p><a class="btn" href="${BASE}/apps/${a.id}/ai-agents/tool">${icon('plus')} ${tx('agt.add_tool')}</a></p>`)}
      </div>`;
    return send(reply, s, shell(s, tx('agt.ai_agents'), crumbs(a), main));
  });

  app.get(`${BASE}/apps/:id(^\\d+$)/ai-agents/agent`, async (req: Req, reply) => {
    const ok = await load(req, reply);
    if (!ok) return;
    const { s, a } = ok;
    const name = String((req.query as Record<string, unknown>)?.name ?? '').toUpperCase();
    const x = name ? ((a.ai_agents ?? []) as AiAgent[]).find((g) => g.name === name) : {};
    if (!x) return reply.code(404).send('Not found');
    const title = name || 'New agent';
    const main = html`${appHeader(a, 'shared', s)}<div class="title-row"><h1 class="ai-name">${title}</h1></div>${region(tx('agt.ai_agent'), await agentForm(a, s, x, name, []))}`;
    return send(reply, s, shell(s, title, crumbs(a, title), main));
  });

  app.post(`${BASE}/apps/:id(^\\d+$)/ai-agents/agent`, async (req: Req, reply) => {
    const ok = await load(req, reply);
    if (!ok) return;
    const { s, a } = ok;
    const b = (req.body ?? {}) as Body;
    const original = one(b.original).toUpperCase();
    const errors: string[] = [];
    const x = agentFrom(b, errors);
    const problems = errors.length ? errors : await update(a.id, (agents, tools) => {
      const out = agentProblems(x, new Set(tools.map((t) => t.name)));
      const at = original ? agents.findIndex((g) => g.name === original) : -1;
      if (original && at < 0) out.push(tx('agt.agent_gone', { name: original }));
      if (agents.some((g, i) => g.name === x.name && i !== at)) out.push(tx('agt.agent_exists', { name: x.name }));
      if (out.length) return out;
      if (at >= 0) agents[at] = x;
      else agents.push(x);
      return [];
    });
    if (problems.length) {
      const main = html`${appHeader(a, 'shared', s)}<div class="title-row"><h1 class="ai-name">${original || 'New agent'}</h1></div>${region(tx('agt.ai_agent'), await agentForm(a, s, x, original, problems))}`;
      return send(reply.code(422), s, shell(s, original || 'New agent', crumbs(a, original || 'New agent'), main));
    }
    if (original && original !== x.name)
      await owner.query(`update meta.region r set config = jsonb_set(r.config, '{agent}', to_jsonb($3::text)) from meta.page p
                          where p.id = r.page_id and p.app_id = $1 and r.type = 'ai_assistant' and upper(r.config->>'agent') = $2`, [a.id, original, x.name]);
    flash(s, tx('agt.ai_agent_saved'));
    return back(reply, s, `${BASE}/apps/${a.id}/ai-agents/agent?name=${encodeURIComponent(x.name)}`);
  });

  app.post(`${BASE}/apps/:id(^\\d+$)/ai-agents/agent/delete`, async (req: Req, reply) => {
    const ok = await load(req, reply);
    if (!ok) return;
    const { s, a } = ok;
    const name = one((req.body as Body)?.name).toUpperCase();
    await update(a.id, (agents) => {
      const at = agents.findIndex((g) => g.name === name);
      if (at >= 0) agents.splice(at, 1);
      return [];
    });
    flash(s, `AI agent ${name} deleted.`);
    return back(reply, s, `${BASE}/apps/${a.id}/ai-agents`);
  });

  app.get(`${BASE}/apps/:id(^\\d+$)/ai-agents/tool`, async (req: Req, reply) => {
    const ok = await load(req, reply);
    if (!ok) return;
    const { s, a } = ok;
    const name = String((req.query as Record<string, unknown>)?.name ?? '');
    const x = name ? ((a.ai_tools ?? []) as AiTool[]).find((t) => t.name === name) : {};
    if (!x) return reply.code(404).send('Not found');
    const title = name || 'New tool';
    const main = html`${appHeader(a, 'shared', s)}<div class="title-row"><h1 class="ai-name">${title}</h1></div>${region(tx('agt.ai_tool'), await toolForm(a, s, x, name, []))}`;
    return send(reply, s, shell(s, title, crumbs(a, title), main));
  });

  app.post(`${BASE}/apps/:id(^\\d+$)/ai-agents/tool`, async (req: Req, reply) => {
    const ok = await load(req, reply);
    if (!ok) return;
    const { s, a } = ok;
    const b = (req.body ?? {}) as Body;
    const original = one(b.original);
    const errors: string[] = [];
    const x = toolFrom(b, errors);
    const { parameters_text: _, ...tool } = x;
    const problems = errors.length ? errors : await update(a.id, async (agents, tools) => {
      const out = aiToolProblems(tool);
      if (tool.type === 'rest' && tool.source && !(await owner.one('select 1 from meta.rest_source where app_id = $1 and name = $2', [a.id, tool.source])))
        out.push(tx('agt.no_rest_source', { name: tool.source }));
      if (tool.type === 'retrieve' && tool.search_config && !(await owner.one(`select 1 from meta.search_config where app_id = $1 and name = $2 and source_type <> 'list'`, [a.id, tool.search_config])))
        out.push(tx('agt.no_search_config', { name: tool.search_config }));
      if (tool.type === 'navigate') {
        const known = new Set((await owner.query<{ page_no: number }>('select page_no from meta.page where app_id = $1', [a.id])).rows.map((p) => p.page_no));
        for (const p of tool.pages ?? []) if (!known.has(p)) out.push(tx('agt.no_page', { n: p }));
      }
      const at = original ? tools.findIndex((t) => t.name === original) : -1;
      if (original && at < 0) out.push(tx('agt.tool_gone', { name: original }));
      if (tools.some((t, i) => t.name === tool.name && i !== at)) out.push(`A tool ${tool.name} exists already.`);
      if (out.length) return out;
      if (at >= 0) tools[at] = tool;
      else tools.push(tool);
      // a renamed tool keeps its agents
      if (original && original !== tool.name) for (const g of agents) if (g.tools) g.tools = g.tools.map((n) => (n === original ? tool.name : n));
      return [];
    });
    if (problems.length) {
      const main = html`${appHeader(a, 'shared', s)}<div class="title-row"><h1 class="ai-name">${original || 'New tool'}</h1></div>${region(tx('agt.ai_tool'), await toolForm(a, s, x, original, problems))}`;
      return send(reply.code(422), s, shell(s, original || 'New tool', crumbs(a, original || 'New tool'), main));
    }
    flash(s, tx('agt.ai_tool_saved'));
    return back(reply, s, `${BASE}/apps/${a.id}/ai-agents/tool?name=${encodeURIComponent(tool.name)}`);
  });

  app.post(`${BASE}/apps/:id(^\\d+$)/ai-agents/tool/delete`, async (req: Req, reply) => {
    const ok = await load(req, reply);
    if (!ok) return;
    const { s, a } = ok;
    const name = one((req.body as Body)?.name);
    const problems = await update(a.id, (agents, tools) => {
      const users = agents.filter((g) => (g.tools ?? []).includes(name)).map((g) => g.name);
      if (users.length) return [tx('agt.tool_used', { name, agents: users.join(', ') })];
      const at = tools.findIndex((t) => t.name === name);
      if (at >= 0) tools.splice(at, 1);
      return [];
    });
    if (problems.length) {
      flash(s, problems.join(' '), 'error');
      return back(reply, s, `${BASE}/apps/${a.id}/ai-agents/tool?name=${encodeURIComponent(name)}`);
    }
    flash(s, `AI tool ${name} deleted.`);
    return back(reply, s, `${BASE}/apps/${a.id}/ai-agents`);
  });
}

/** The agents an AI assistant region may name (the region settings form). */
export async function agentOptions(appId: number) {
  return ((await owner.one<{ ai_agents: AiAgent[] }>('select ai_agents from meta.app where id = $1', [appId]))?.ai_agents ?? []).map((g) => g.name);
}

