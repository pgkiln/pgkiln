import type { FastifyInstance, FastifyReply } from 'fastify';
import { providerLabel } from '../ai/service.ts';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { agentProblems, aiToolProblems, definitionProblems, EFFORTS, type AiAgent, type AiTool } from '../runtime/ai-agents.ts';
import type { Session } from '../session.ts';
import { appOr404 } from './forms.ts';
import { appHeader, back, BASE, csrf, developer, flash, input, region, select, send, shell, type Req } from './ui.ts';

// Shared Components → Generative AI → AI Agents (migration 121): the
// application's AI tools and AI agents, kept as two JSON lists in meta.app
// (ai_tools, ai_agents) and exported with the application. Each form checks
// its entry (src/runtime/ai-agents.ts) before it saves; the runtime checks
// again. Also the "Tool calls" region of Activity → AI usage.

type Body = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
const all = (v: string | string[] | undefined) => (v === undefined ? [] : [v].flat());

const TOOL_TYPES: [string, string][] = [
  ['sql', 'SQL query (read-only, as the application\'s role)'],
  ['function', 'PL/pgSQL function (may change data)'],
  ['rest', 'REST data source'],
  ['javascript', 'JavaScript action in the browser'],
  ['navigate', 'Navigate: a link to a page'],
];

const when = (d: Date | string) => new Date(d).toISOString().slice(0, 19).replace('T', ' ');
const area = (name: string, label: string, value: unknown, rows: number, help: string, code = false) => html`<div class="field" data-wide><label class="label" for="f_${name}">${label}</label>
  <textarea id="f_${name}" name="${name}" rows="${rows}"${code ? raw(' class="code" spellcheck="false"') : ''}>${value ?? ''}</textarea><small class="help">${help}</small></div>`;

async function schemes(appId: number) {
  return (await owner.query<{ name: string }>('select name from meta.authz_scheme where app_id = $1 order by name', [appId])).rows.map((x) => x.name);
}

const authzSelect = (names: string[], cur: unknown, help: string) =>
  select('authz', 'Authorization scheme', cur ?? '', [['', '- none: everyone who may use the page -'], ['MUST_NOT_BE_PUBLIC_USER', 'Must not be the public user'], ...names.map((n): [string, string] => [n, n]),
    ...(typeof cur === 'string' && cur && cur !== 'MUST_NOT_BE_PUBLIC_USER' && !names.includes(cur) ? [[cur, `${cur} (does not exist)`] as [string, string]] : [])], help);

const crumbs = (a: { id: number; name: string }, last?: string): [string, string?][] => [
  ['App Builder', BASE], [a.name, `${BASE}/apps/${a.id}`], ['Shared Components', `${BASE}/apps/${a.id}/shared`],
  ...(last ? [['AI Agents', `${BASE}/apps/${a.id}/ai-agents`], [last]] as [string, string?][] : [['AI Agents']] as [string, string?][]),
];

// ---------------------------------------------------------------- forms

async function agentForm(a: any, s: Session, x: Partial<AiAgent>, original: string, problems: string[]): Promise<Raw> {
  const services = (await owner.query<{ name: string; provider: string; model: string }>(
    `select s.name, s.provider, s.model from meta.ai_service s join meta.app_ai_service x on x.service_id = s.id and x.app_id = $1 where s.enabled order by s.name`, [a.id])).rows;
  const tools = (a.ai_tools ?? []) as AiTool[];
  const chosen = new Set(x.tools ?? []);
  const svc: [string, string][] = [['', '- choose -'], ...services.map((v): [string, string] => [v.name, `${v.name} (${providerLabel(v.provider)}, ${v.model})`])];
  if (x.service && !services.some((v) => v.name === x.service)) svc.push([x.service, `${x.service} (not available to this application)`]);
  const usedBy = original
    ? (await owner.query<{ page_no: number; title: string | null; page_id: number; id: number }>(
        `select p.page_no, r.title, p.id as page_id, r.id from meta.region r join meta.page p on p.id = r.page_id
          where p.app_id = $1 and r.type = 'ai_assistant' and upper(r.config->>'agent') = $2 order by p.page_no, r.seq`, [a.id, original])).rows
    : [];
  return html`${problems.length ? html`<div class="alert alert-error" role="alert">${problems.join(' ')}</div>` : ''}
    ${services.length ? '' : html`<p class="muted">This application may not use any AI service yet: an administrator adds one under Workspace utilities → AI services and allows this application to use it.</p>`}
    <form method="post" action="${BASE}/apps/${a.id}/ai-agents/agent">${csrf(s)}<input type="hidden" name="original" value="${original}">
      <fieldset class="prop-group"><legend>Agent</legend><div class="form-grid">
        ${input('name', 'Name', x.name ?? '', { required: true, placeholder: 'e.g. SALES_AGENT', help: 'Upper case letters, digits and _. AI assistant regions name the agent.' })}
        ${input('description', 'Description', x.description ?? '')}
        ${select('service', 'AI service', x.service ?? '', svc, 'The conversation, the tools\' results and the system prompt go to this service\'s provider.')}
        ${select('effort', 'Reasoning effort', x.effort ?? '', [['', 'The service\'s'], ...EFFORTS.map((e): [string, string] => [e, e])],
          'Claude: the output effort (thinking depth). OpenAI, Gemini and OpenAI-compatible: reasoning_effort (leave empty for models without reasoning).')}
        ${input('max_steps', 'Maximum steps', x.max_steps ?? '', { type: 'number', placeholder: '5', help: 'Rounds of tool calls per question (1 – 20); then the model must answer.' })}
        ${input('max_tokens', 'Maximum output tokens', x.max_tokens ?? '', { type: 'number', placeholder: 'the service\'s', help: 'Per call to the model (never above the service\'s maximum).' })}
        ${authzSelect(await schemes(a.id), x.authz, 'Only users who pass it may use the agent (regions show a message to the others).')}
        ${area('system', 'System prompt', x.system ?? '', 6, 'Who the agent is, what it may answer and when to use which tool. &ITEM. is replaced by the item\'s value as delimited data.')}
      </div></fieldset>
      <fieldset class="prop-group"><legend>Tools</legend>
        ${tools.length
          ? html`<p class="muted u-mt0">The agent acts only through the tools you tick.</p>${tools.map((t) => html`<div class="field"><label class="check"><input type="checkbox" name="tools" value="${t.name}"${chosen.has(t.name) ? raw(' checked') : ''}> <b>${t.name}</b> <span class="muted">(${t.type}) ${t.description}</span></label></div>`)}`
          : html`<p class="muted u-mt0">No AI tools yet: <a href="${BASE}/apps/${a.id}/ai-agents/tool">add one</a>.</p>`}
      </fieldset>
      <div class="buttons"><button class="btn btn-hot">${original ? 'Save' : 'Add agent'}</button></div>
    </form>
    ${original ? html`<h3>Used by</h3>${usedBy.length
      ? html`<ul>${usedBy.map((r) => html`<li><a href="${BASE}/pages/${r.page_id}?c=region-${r.id}">Page ${r.page_no}: ${r.title ?? 'AI assistant'}</a></li>`)}</ul>`
      : html`<p class="muted">No AI assistant region uses this agent yet (Page Designer → an AI assistant region → AI agent).</p>`}
      <form method="post" action="${BASE}/apps/${a.id}/ai-agents/agent/delete" class="danger-zone">${csrf(s)}<input type="hidden" name="name" value="${original}">
        <button class="btn btn-danger" data-confirm="Delete agent ${original}? Regions that use it show that the assistant is not set up.">Delete agent</button></form>` : ''}`;
}

async function toolForm(a: any, s: Session, x: Partial<AiTool> & { parameters_text?: string }, original: string, problems: string[]): Promise<Raw> {
  const sources = (await owner.query<{ name: string }>('select name from meta.rest_source where app_id = $1 order by name', [a.id])).rows.map((r) => r.name);
  const params = x.parameters_text ?? (x.parameters ? JSON.stringify(x.parameters, null, 2) : '');
  const usedBy = original ? ((a.ai_agents ?? []) as AiAgent[]).filter((g) => (g.tools ?? []).includes(original)).map((g) => g.name) : [];
  return html`${problems.length ? html`<div class="alert alert-error" role="alert">${problems.join(' ')}</div>` : ''}
    <form method="post" action="${BASE}/apps/${a.id}/ai-agents/tool">${csrf(s)}<input type="hidden" name="original" value="${original}">
      <fieldset class="prop-group"><legend>Tool</legend><div class="form-grid">
        ${input('name', 'Name', x.name ?? '', { required: true, placeholder: 'e.g. top_earners', help: 'Letters, digits and _: the model calls the tool by this name.' })}
        ${select('type', 'Type', x.type ?? 'sql', TOOL_TYPES, 'What the tool does; each type uses the fields below that name it.')}
        ${area('description', 'Description', x.description ?? '', 2, 'Tells the model what the tool does and when to use it.')}
        ${area('sql', 'SQL query (SQL)', x.sql ?? '', 6, 'One SELECT with the parameters as :NAME bind values (and :APP_USER, items). Runs as the application\'s database role (grants and row level security apply) in a read-only transaction.', true)}
        ${input('function', 'Function (PL/pgSQL)', x.function ?? '', { placeholder: 'e.g. sales.give_discount', help: 'schema.name, called as the application\'s role with named arguments: each parameter name in lower case is an argument name (P_ORDER → p_order). It may change data.' })}
        ${select('source', 'REST data source (REST)', x.source ?? '', [['', '-'], ...sources.map((n): [string, string] => [n, n])], 'The parameters become the source\'s parameters.')}
        ${input('action', 'Action (JavaScript)', x.action ?? '', { placeholder: 'e.g. highlightOrder', help: 'After the answer the browser calls the function registered with pgkiln.actions.register(name) with {value: the arguments}, and the dynamic actions of the custom event of this name.' })}
        ${input('pages', 'Pages (Navigate)', (x.pages ?? []).join(', '), { placeholder: 'e.g. 3, 7', help: 'The page numbers the agent may link to. pgkiln offers only those the user may open and builds the URL (item values with their checksum).' })}
        ${area('parameters', 'Parameters (JSON; not for Navigate)', params, 6, '{"DNAME": {"type": "string", "description": "A department name"}, "LIMIT": {"type": "integer", "optional": true}}. Types: string, integer, number, boolean, date; "enum" for a list of texts.', true)}
        ${input('max_rows', 'Maximum rows', x.max_rows ?? '', { type: 'number', placeholder: '50', help: 'Rows the model gets back (1 – 500).' })}
        ${input('timeout_s', 'Time limit (seconds)', x.timeout_s ?? '', { type: 'number', placeholder: '15', help: 'SQL and function tools (1 – 60).' })}
        ${authzSelect(await schemes(a.id), x.authz, 'Only users who pass it are offered the tool.')}
      </div></fieldset>
      <div class="buttons"><button class="btn btn-hot">${original ? 'Save' : 'Add tool'}</button></div>
    </form>
    ${original ? html`<h3>Used by</h3>${usedBy.length ? html`<p>${usedBy.join(', ')}</p>` : html`<p class="muted">No agent uses this tool yet.</p>`}
      <form method="post" action="${BASE}/apps/${a.id}/ai-agents/tool/delete" class="danger-zone">${csrf(s)}<input type="hidden" name="name" value="${original}">
        <button class="btn btn-danger" data-confirm="Delete tool ${original}?">Delete tool</button></form>` : ''}`;
}

// ---------------------------------------------------------------- reading the forms

const intOrUndef = (v: string, what: string, errors: string[]) => {
  const t = v.trim();
  if (!t) return undefined;
  const n = Number(t);
  if (!Number.isInteger(n)) errors.push(`${what} is a whole number.`);
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
  const steps = intOrUndef(one(b.max_steps), 'Maximum steps', errors);
  if (steps !== undefined) x.max_steps = steps;
  const tokens = intOrUndef(one(b.max_tokens), 'Maximum output tokens', errors);
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
  const params = one(b.parameters).trim();
  if (params && type !== 'navigate') {
    try {
      x.parameters = JSON.parse(params);
    } catch {
      errors.push('Parameters: not valid JSON.');
      x.parameters_text = params;
    }
  }
  if (type === 'sql' || type === 'function' || type === 'rest') {
    const rows = intOrUndef(one(b.max_rows), 'Maximum rows', errors);
    if (rows !== undefined) x.max_rows = rows;
  }
  if (type === 'sql' || type === 'function') {
    const t = intOrUndef(one(b.timeout_s), 'Time limit', errors);
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
  return region('Tool calls', html`<p class="muted u-mt0">Every tool call of the application's AI assistants and agents, with the arguments the model gave (kept 30 days).</p>
    <div class="table-wrap"><table class="report report-reflow">
    <thead><tr><th>When (UTC)</th><th class="num">Page</th><th>User</th><th>Agent</th><th>Tool</th><th>Arguments</th><th class="num">ms</th><th>Status</th></tr></thead>
    <tbody>${rows.length ? rows.map((r) => html`<tr>
      <td data-label="When">${when(r.at)}</td><td class="num" data-label="Page">${r.page_no ?? ''}</td><td data-label="User">${r.username ?? ''}</td>
      <td data-label="Agent">${r.agent ?? html`<span class="muted">region</span>`}</td><td data-label="Tool">${r.tool} <span class="muted">${r.type}</span></td>
      <td data-label="Arguments"><code class="ai-args">${JSON.stringify(r.arguments)}</code></td><td class="num" data-label="ms">${r.duration_ms}</td>
      <td data-label="Status"><span class="tag${r.status === 'ok' ? ' tag-ok' : ' tag-error'}">${r.status}</span>${r.message ? html` <span class="muted">${r.message}</span>` : ''}</td></tr>`)
      : html`<tr><td colspan="8" class="empty">No tool calls yet.</td></tr>`}</tbody></table></div>`);
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
      <div class="title-row"><h1>AI Agents</h1></div>
      <p class="muted u-mt0">An agent answers in an AI assistant region and acts only through the tools you give it: SQL queries (read-only, as the application's database role, so row level security applies), PL/pgSQL functions, REST data sources, JavaScript actions in the browser, and links to pages (pgkiln builds the URL and its checksum, only for pages the user may open). What users type and the tools' results go to the agent's AI service. <a href="${BASE}/apps/${a.id}/ai">AI usage</a> lists every tool call.</p>
      ${problems.length ? html`<div class="alert alert-error" role="alert">${problems.join(' ')}</div>` : ''}
      <div class="columns">
        ${region('Agents', html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>Agent</th><th>AI service</th><th>Tools</th><th>Authorization</th></tr></thead>
          <tbody>${agents.length ? agents.map((g) => html`<tr><td data-label="Agent"><a href="${BASE}/apps/${a.id}/ai-agents/agent?name=${encodeURIComponent(g.name)}">${g.name}</a>${g.description ? html` <span class="muted">${g.description}</span>` : ''}</td>
            <td data-label="AI service">${g.service}${g.effort ? html` <span class="muted">(${g.effort})</span>` : ''}</td><td data-label="Tools">${(g.tools ?? []).join(', ')}</td><td data-label="Authorization">${g.authz ?? ''}</td></tr>`)
            : html`<tr><td colspan="4" class="empty">No AI agents yet.</td></tr>`}</tbody></table></div>
          <p><a class="btn" href="${BASE}/apps/${a.id}/ai-agents/agent">${icon('plus')} Add agent</a></p>`)}
        ${region('Tools', html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>Tool</th><th>Type</th><th>Authorization</th></tr></thead>
          <tbody>${tools.length ? tools.map((t) => html`<tr><td data-label="Tool"><a href="${BASE}/apps/${a.id}/ai-agents/tool?name=${encodeURIComponent(t.name)}">${t.name}</a> <span class="muted">${t.description}</span></td>
            <td data-label="Type">${t.type}</td><td data-label="Authorization">${t.authz ?? ''}</td></tr>`)
            : html`<tr><td colspan="3" class="empty">No AI tools yet.</td></tr>`}</tbody></table></div>
          <p><a class="btn" href="${BASE}/apps/${a.id}/ai-agents/tool">${icon('plus')} Add tool</a></p>`)}
      </div>`;
    return send(reply, s, shell(s, 'AI Agents', crumbs(a), main));
  });

  app.get(`${BASE}/apps/:id(^\\d+$)/ai-agents/agent`, async (req: Req, reply) => {
    const ok = await load(req, reply);
    if (!ok) return;
    const { s, a } = ok;
    const name = String((req.query as Record<string, unknown>)?.name ?? '').toUpperCase();
    const x = name ? ((a.ai_agents ?? []) as AiAgent[]).find((g) => g.name === name) : {};
    if (!x) return reply.code(404).send('Not found');
    const title = name || 'New agent';
    const main = html`${appHeader(a, 'shared', s)}<div class="title-row"><h1 class="ai-name">${title}</h1></div>${region('AI agent', await agentForm(a, s, x, name, []))}`;
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
      if (original && at < 0) out.push(`Agent ${original} no longer exists.`);
      if (agents.some((g, i) => g.name === x.name && i !== at)) out.push(`An agent ${x.name} exists already.`);
      if (out.length) return out;
      if (at >= 0) agents[at] = x;
      else agents.push(x);
      return [];
    });
    if (problems.length) {
      const main = html`${appHeader(a, 'shared', s)}<div class="title-row"><h1 class="ai-name">${original || 'New agent'}</h1></div>${region('AI agent', await agentForm(a, s, x, original, problems))}`;
      return send(reply.code(422), s, shell(s, original || 'New agent', crumbs(a, original || 'New agent'), main));
    }
    if (original && original !== x.name)
      await owner.query(`update meta.region r set config = jsonb_set(r.config, '{agent}', to_jsonb($3::text)) from meta.page p
                          where p.id = r.page_id and p.app_id = $1 and r.type = 'ai_assistant' and upper(r.config->>'agent') = $2`, [a.id, original, x.name]);
    flash(s, 'AI agent saved.');
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
    const main = html`${appHeader(a, 'shared', s)}<div class="title-row"><h1 class="ai-name">${title}</h1></div>${region('AI tool', await toolForm(a, s, x, name, []))}`;
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
        out.push(`There is no REST data source ${tool.source}.`);
      if (tool.type === 'navigate') {
        const known = new Set((await owner.query<{ page_no: number }>('select page_no from meta.page where app_id = $1', [a.id])).rows.map((p) => p.page_no));
        for (const p of tool.pages ?? []) if (!known.has(p)) out.push(`There is no page ${p}.`);
      }
      const at = original ? tools.findIndex((t) => t.name === original) : -1;
      if (original && at < 0) out.push(`Tool ${original} no longer exists.`);
      if (tools.some((t, i) => t.name === tool.name && i !== at)) out.push(`A tool ${tool.name} exists already.`);
      if (out.length) return out;
      if (at >= 0) tools[at] = tool;
      else tools.push(tool);
      // a renamed tool keeps its agents
      if (original && original !== tool.name) for (const g of agents) if (g.tools) g.tools = g.tools.map((n) => (n === original ? tool.name : n));
      return [];
    });
    if (problems.length) {
      const main = html`${appHeader(a, 'shared', s)}<div class="title-row"><h1 class="ai-name">${original || 'New tool'}</h1></div>${region('AI tool', await toolForm(a, s, x, original, problems))}`;
      return send(reply.code(422), s, shell(s, original || 'New tool', crumbs(a, original || 'New tool'), main));
    }
    flash(s, 'AI tool saved.');
    return back(reply, s, `${BASE}/apps/${a.id}/ai-agents/tool?name=${encodeURIComponent(tool.name)}`);
  });

  app.post(`${BASE}/apps/:id(^\\d+$)/ai-agents/tool/delete`, async (req: Req, reply) => {
    const ok = await load(req, reply);
    if (!ok) return;
    const { s, a } = ok;
    const name = one((req.body as Body)?.name);
    const problems = await update(a.id, (agents, tools) => {
      const users = agents.filter((g) => (g.tools ?? []).includes(name)).map((g) => g.name);
      if (users.length) return [`Tool ${name} is used by ${users.join(', ')}: take it out of those agents first.`];
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

