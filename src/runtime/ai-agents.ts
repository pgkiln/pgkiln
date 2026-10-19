import pg from 'pg';
import type { ChatTool, ToolOutcome } from '../ai/chat.ts';
import { applyBinds, literal, RESERVED_BINDS } from '../binds.ts';
import { appTx, owner } from '../db.ts';
import { urlChecksum } from '../security.ts';
import { checkArgs, toolSchema, type ParamDef, type ToolDef } from './assistant.ts';
import { isAuthorized, pageAllowed } from './authz.ts';
import { bindValues, dbg, publicError, stripSemicolon, type PageContext } from './context.ts';
import { txContext } from './routes.ts';

// AI agents and AI tools (migration 121; APEX 26.1 / 26.2: Shared Components
// → AI Agents). Both are lists in meta.app (ai_agents, ai_tools), exported
// with the application. An agent is an AI service, a system prompt, a
// reasoning effort, the tools it may use, limits and an authorization
// scheme; an AI assistant region names it ({"agent": "HR_AGENT"}) and the
// conversation runs as before (src/runtime/assistant.ts, src/ai/chat.ts).
//
// The model acts only through the agent's tools, each one constrained here:
// - sql: one query (SELECT / WITH / VALUES / TABLE) with the model's
//   arguments as escaped bind values, run as the application's role (grants
//   and row level security apply) in a read-only transaction with a time
//   limit; at most max_rows rows go back to the model.
// - function: a schema-qualified function called with named arguments (the
//   parameter names, lower case) as the application's role; it may change
//   data (committed), with the same time limit.
// - rest: a REST data source of the application (as in assistant regions).
// - javascript: nothing runs on the server; after the answer the browser
//   calls the function registered with pgkiln.actions.register(action) and
//   the dynamic actions of the custom event "action", with the arguments.
// - navigate: the model picks one of the tool's pages, a link text and item
//   values of that page; pgkiln refuses a page the user may not open and
//   builds the URL itself (item values with their checksum, bound to app,
//   page and user). The link is shown under the answer; nothing opens it.
// Every tool call is logged with its arguments (meta.ai_tool_call, the
// Activity → AI usage page) and in the page's debug messages.

export type AiToolType = 'sql' | 'function' | 'rest' | 'javascript' | 'navigate';
export const AI_TOOL_TYPES: AiToolType[] = ['sql', 'function', 'rest', 'javascript', 'navigate'];
export const EFFORTS = ['low', 'medium', 'high'] as const;

export interface AiTool {
  name: string;
  description: string;
  type: AiToolType;
  sql?: string;
  function?: string;
  source?: string;
  action?: string;
  pages?: number[];
  parameters?: Record<string, ParamDef>;
  max_rows?: number;
  timeout_s?: number;
  authz?: string;
}

export interface AiAgent {
  name: string;
  description?: string;
  service: string;
  system?: string;
  effort?: (typeof EFFORTS)[number] | null;
  tools?: string[];
  max_steps?: number;
  max_tokens?: number;
  authz?: string;
}

export const AGENT_NAME = /^[A-Z][A-Z0-9_]{0,59}$/;
const TOOL_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const PARAM_NAME = /^[A-Za-z][A-Za-z0-9_]{0,59}$/;
const PARAM_TYPES = ['string', 'integer', 'number', 'boolean', 'date'];
const QUERY_START = /^\s*(select|with|values|table)\b/i;
const FUNCTION_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}\.[A-Za-z_][A-Za-z0-9_]{0,62}$/;
/** As pgkiln.actions.register accepts (public/app.js) */
const ACTION_NAME = /^[A-Za-z_$][\w$.-]{0,99}$/;
const SCHEME_REF = /^!?[A-Za-z0-9_ ]{1,60}$/;
const DEFAULT_ROWS = 50;
const DEFAULT_TIMEOUT_S = 15;
export const DEFAULT_STEPS = 5;
const MAX_LINK_ITEMS = 10;

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const intIn = (v: unknown, min: number, max: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

function paramProblems(what: string, params: unknown): string[] {
  const out: string[] = [];
  if (params === undefined) return out;
  if (!isObj(params) || Object.keys(params).length > 20) return [`${what}: "parameters" is an object of at most 20 parameters.`];
  for (const [n, p] of Object.entries(params)) {
    if (!PARAM_NAME.test(n) || /^APP_/i.test(n) || /^AI_PROMPT$/i.test(n)) out.push(`${what}: parameter "${n}": letters, digits and _, not starting with APP_.`);
    if (!isObj(p) || !PARAM_TYPES.includes(p.type)) {
      out.push(`${what}: parameter "${n}": "type" is ${PARAM_TYPES.join(', ')}.`);
      continue;
    }
    if (p.description !== undefined && typeof p.description !== 'string') out.push(`${what}: parameter "${n}": "description" is text.`);
    if (p.enum !== undefined && (!Array.isArray(p.enum) || !p.enum.length || p.enum.length > 100 || p.enum.some((v: unknown) => typeof v !== 'string') || p.type !== 'string'))
      out.push(`${what}: parameter "${n}": "enum" is a list of texts (type string).`);
    if (p.optional !== undefined && typeof p.optional !== 'boolean') out.push(`${what}: parameter "${n}": "optional" is true or false.`);
  }
  return out;
}

/** Problems with one AI tool (builder and runtime). */
export function aiToolProblems(t: unknown): string[] {
  if (!isObj(t)) return ['A tool is an object.'];
  const what = `Tool ${typeof t.name === 'string' ? `"${t.name}"` : '?'}`;
  const out: string[] = [];
  if (typeof t.name !== 'string' || !TOOL_NAME.test(t.name)) out.push(`${what}: the name is letters, digits and _ (at most 64), starting with a letter.`);
  if (typeof t.description !== 'string' || !t.description.trim() || t.description.length > 2000) out.push(`${what}: a description (at most 2000 characters) tells the model what the tool does and when to use it.`);
  if (!AI_TOOL_TYPES.includes(t.type)) out.push(`${what}: the type is ${AI_TOOL_TYPES.join(', ')}.`);
  if (t.type === 'sql' && (typeof t.sql !== 'string' || !QUERY_START.test(t.sql) || t.sql.length > 20_000)) out.push(`${what}: the SQL is one query (SELECT, WITH, VALUES or TABLE); use a function tool to change data.`);
  if (t.type === 'function' && (typeof t.function !== 'string' || !FUNCTION_NAME.test(t.function))) out.push(`${what}: the function is schema.name, e.g. sales.give_discount.`);
  if (t.type === 'rest' && (typeof t.source !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(t.source))) out.push(`${what}: the source names a REST data source.`);
  if (t.type === 'javascript' && (typeof t.action !== 'string' || !ACTION_NAME.test(t.action))) out.push(`${what}: the action is the name of a function registered with pgkiln.actions.register (or of a custom event).`);
  if (t.type === 'navigate') {
    if (!Array.isArray(t.pages) || !t.pages.length || t.pages.length > 50 || t.pages.some((p: unknown) => !intIn(p, 1, 2_147_483_647)))
      out.push(`${what}: "pages" lists the page numbers the agent may offer (1 to 50 pages).`);
    if (t.parameters !== undefined) out.push(`${what}: a navigate tool has no parameters (the model picks a page, a link text and item values).`);
  } else out.push(...paramProblems(what, t.parameters));
  if (t.max_rows !== undefined && !intIn(t.max_rows, 1, 500)) out.push(`${what}: maximum rows 1 to 500.`);
  if (t.timeout_s !== undefined && !intIn(t.timeout_s, 1, 60)) out.push(`${what}: time limit 1 to 60 seconds.`);
  if (t.authz !== undefined && t.authz !== null && (typeof t.authz !== 'string' || !SCHEME_REF.test(t.authz.trim()))) out.push(`${what}: the authorization names a scheme.`);
  return out;
}

/** Problems with one AI agent; `tools` are the application's tool names. */
export function agentProblems(a: unknown, tools: Set<string>): string[] {
  if (!isObj(a)) return ['An agent is an object.'];
  const what = `Agent ${typeof a.name === 'string' ? a.name : '?'}`;
  const out: string[] = [];
  if (typeof a.name !== 'string' || !AGENT_NAME.test(a.name)) out.push(`${what}: the name is upper case letters, digits and _ (e.g. SALES_AGENT).`);
  if (typeof a.service !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(a.service)) out.push(`${what}: choose an AI service.`);
  for (const k of ['description', 'system'] as const) if (a[k] !== undefined && a[k] !== null && typeof a[k] !== 'string') out.push(`${what}: "${k}" is text.`);
  if (typeof a.system === 'string' && a.system.length > 20_000) out.push(`${what}: the system prompt has at most 20,000 characters.`);
  if (a.effort !== undefined && a.effort !== null && !EFFORTS.includes(a.effort)) out.push(`${what}: the reasoning effort is low, medium or high (or empty: the service's).`);
  if (a.tools !== undefined && (!Array.isArray(a.tools) || a.tools.length > 20 || a.tools.some((t: unknown) => typeof t !== 'string')))
    out.push(`${what}: "tools" lists at most 20 tool names.`);
  else for (const t of a.tools ?? []) if (!tools.has(t)) out.push(`${what}: there is no AI tool "${t}".`);
  if (a.max_steps !== undefined && !intIn(a.max_steps, 1, 20)) out.push(`${what}: maximum steps 1 to 20.`);
  if (a.max_tokens !== undefined && !intIn(a.max_tokens, 1, 128_000)) out.push(`${what}: maximum tokens 1 to 128000.`);
  if (a.authz !== undefined && a.authz !== null && (typeof a.authz !== 'string' || !SCHEME_REF.test(a.authz.trim()))) out.push(`${what}: the authorization names a scheme.`);
  return out;
}

/** Problems with an application's lists: each entry, and names used twice. */
export function definitionProblems(agents: unknown, tools: unknown): string[] {
  const out: string[] = [];
  const tl = Array.isArray(tools) ? tools : [];
  const al = Array.isArray(agents) ? agents : [];
  if (!Array.isArray(tools)) out.push('AI tools are a list.');
  if (!Array.isArray(agents)) out.push('AI agents are a list.');
  const names = new Set<string>();
  for (const t of tl) {
    out.push(...aiToolProblems(t));
    if (isObj(t) && typeof t.name === 'string') {
      if (names.has(t.name)) out.push(`Tool "${t.name}" is defined twice.`);
      names.add(t.name);
    }
  }
  const agentNames = new Set<string>();
  for (const a of al) {
    out.push(...agentProblems(a, names));
    if (isObj(a) && typeof a.name === 'string') {
      if (agentNames.has(a.name)) out.push(`Agent ${a.name} is defined twice.`);
      agentNames.add(a.name);
    }
  }
  return out;
}

/** The application's agents and tools (the owner reads them: the builder may have changed them a moment ago). */
export async function loadDefinitions(appId: number): Promise<{ agents: AiAgent[]; tools: AiTool[] }> {
  const r = await owner.one<{ ai_agents: unknown; ai_tools: unknown }>('select ai_agents, ai_tools from meta.app where id = $1', [appId]);
  return { agents: Array.isArray(r?.ai_agents) ? (r!.ai_agents as AiAgent[]) : [], tools: Array.isArray(r?.ai_tools) ? (r!.ai_tools as AiTool[]) : [] };
}

/** An agent by name, with its tools, when it and they are valid (else null: the region is "not set up"). */
export async function agentFor(appId: number, name: string): Promise<{ agent: AiAgent; tools: AiTool[] } | null> {
  const defs = await loadDefinitions(appId);
  const agent = defs.agents.find((a) => a.name === name.toUpperCase());
  if (!agent || agentProblems(agent, new Set(defs.tools.map((t) => t.name))).length) return null;
  const tools = (agent.tools ?? []).map((n) => defs.tools.find((t) => t.name === n)!);
  if (tools.some((t) => aiToolProblems(t).length)) return null;
  return { agent, tools };
}

// ---------------------------------------------------------------- what the model is offered

/** What one turn leaves for the page: links built by navigate tools, browser actions of javascript tools. */
export interface TurnExtras {
  links: { label: string; url: string; dialog: boolean }[];
  actions: { action: string; args: Record<string, string | null> }[];
}

/** A tool, prepared for one question: its definition for the model, and the pages (with items) a navigate tool may offer this user. */
export interface PreparedTool {
  tool: AiTool;
  chat: ChatTool;
  pages?: Map<number, Set<string>>;
}

const asToolDef = (t: AiTool): ToolDef => ({ name: t.name, description: t.description, parameters: t.parameters, max_rows: t.max_rows });

/**
 * The agent's tools this user may use (their authorization schemes), with their schemas. Navigate tools keep
 * only the pages the user may open (checked here, in the caller's transaction). Needs ctx.client.
 */
export async function prepareTools(ctx: PageContext, tools: AiTool[]): Promise<PreparedTool[]> {
  const out: PreparedTool[] = [];
  for (const tool of tools) {
    if (!(await isAuthorized(ctx, tool.authz))) continue;
    if (tool.type !== 'navigate') {
      const extra = tool.type === 'javascript' ? ' It runs in the user\'s browser after your answer; it returns no data.' : '';
      out.push({ tool, chat: { name: tool.name, description: tool.description + extra, parameters: toolSchema(asToolDef(tool)) } });
      continue;
    }
    const pages = new Map<number, Set<string>>();
    for (const n of tool.pages ?? []) if (await pageAllowed(ctx, n)) pages.set(n, new Set());
    if (!pages.size) continue;
    const items = (await owner.query<{ page_no: number; name: string }>(
      `select p.page_no, i.name from meta.item i join meta.page p on p.id = i.page_id where p.app_id = $1 and p.page_no = any($2::int[]) order by i.name`,
      [ctx.app.id, [...pages.keys()]])).rows;
    for (const i of items) pages.get(i.page_no)!.add(i.name.toUpperCase());
    const names = [...new Set(items.filter((i) => pages.has(i.page_no)).map((i) => i.name.toUpperCase()))];
    const titles = [...pages.keys()].map((n) => {
      const p = ctx.app.pages.find((x) => x.page_no === n);
      return `${n} (${p?.title ?? p?.name ?? ''}; items: ${[...pages.get(n)!].join(', ') || 'none'})`;
    });
    out.push({
      tool,
      pages,
      chat: {
        name: tool.name,
        description: `${tool.description} Shows the user a link to one of these pages under your answer (it does not open it): ${titles.join('; ')}.`,
        parameters: {
          type: 'object',
          properties: {
            page: { type: 'integer', enum: [...pages.keys()], description: 'The page to link to.' },
            label: { type: 'string', description: 'The link text the user sees, e.g. "Open the order".' },
            items: {
              type: 'array',
              description: 'Item values the page opens with (e.g. its key item); [] for none.',
              items: {
                type: 'object',
                properties: { name: { type: 'string', ...(names.length ? { enum: names } : {}) }, value: { type: 'string' } },
                required: ['name', 'value'],
                additionalProperties: false,
              },
            },
          },
          required: ['page', 'label', 'items'],
          additionalProperties: false,
        },
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------- running a tool

export interface AgentOutcome extends ToolOutcome {
  /** pgkiln refused the call (a page the user may not open) */
  refused?: boolean;
}

const rowsJson = (rows: Record<string, unknown>[], max: number) => JSON.stringify({ rows: rows.slice(0, max), ...(rows.length > max ? { more_rows: true } : {}) });

/** The model's arguments as bind values; they never replace the server's own names (:APP_USER, …). */
const modelBinds = (values: Record<string, string | null>) =>
  Object.fromEntries(Object.entries(values).map(([k, v]) => [k.toUpperCase(), v]).filter(([k]) => !RESERVED_BINDS.has(k as string)));

/** A link to a page: checked against the prepared pages, the URL built by pgkiln (with the checksum). */
function navigate(ctx: PageContext, p: PreparedTool, input: Record<string, unknown>, extras: TurnExtras): AgentOutcome {
  for (const k of Object.keys(input)) if (!['page', 'label', 'items'].includes(k)) return { content: `Unknown argument "${k}".`, isError: true };
  const pageNo = input.page;
  if (!Number.isInteger(pageNo) || !(p.tool.pages ?? []).includes(pageNo as number)) return { content: `The page is one of: ${(p.tool.pages ?? []).join(', ')}.`, isError: true };
  const items = p.pages!.get(pageNo as number);
  if (!items) return { content: `The user may not open page ${pageNo}: offer something else.`, isError: true, refused: true };
  const label = typeof input.label === 'string' ? input.label.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  if (!label) return { content: 'The label is the link text.', isError: true };
  const list = input.items ?? [];
  if (!Array.isArray(list) || list.length > MAX_LINK_ITEMS) return { content: `"items" is a list of at most ${MAX_LINK_ITEMS} {name, value}.`, isError: true };
  const values: Record<string, string> = {};
  for (const x of list) {
    if (!isObj(x) || typeof x.name !== 'string' || typeof x.value !== 'string' || Object.keys(x).some((k) => k !== 'name' && k !== 'value'))
      return { content: 'Each item is {"name": …, "value": …}.', isError: true };
    const name = x.name.toUpperCase();
    if (!items.has(name)) return { content: `Page ${pageNo} has no item ${x.name}.`, isError: true };
    if (x.value.length > 4000 || x.value.includes('\0')) return { content: `The value of ${x.name} is too long.`, isError: true };
    values[name] = x.value;
  }
  // as pageHref (links.ts), but the model's values are never substituted (&ITEM.): they go in as they are
  const params = new URLSearchParams();
  for (const k of Object.keys(values).sort()) params.set(k, values[k]);
  if (Object.keys(values).length) {
    params.set('cs', urlChecksum(ctx.app.id, pageNo as number, ctx.user, values));
    ctx.userBound = true;
  }
  const q = params.toString();
  const url = `${ctx.base}/${pageNo}${q ? `?${q}` : ''}`;
  const dialog = ctx.app.pages.find((x) => x.page_no === pageNo)?.mode === 'modal';
  if (extras.links.length < 5) extras.links.push({ label, url, dialog });
  return { content: JSON.stringify({ shown: true, page: pageNo, label }) };
}

/** Run one of an agent's tools; errors become a message for the model. */
export async function runAgentTool(ctx: PageContext, p: PreparedTool, input: Record<string, unknown>, extras: TurnExtras, rest: (def: ToolDef, input: Record<string, unknown>) => Promise<ToolOutcome>): Promise<AgentOutcome> {
  const { tool } = p;
  if (tool.type === 'navigate') return navigate(ctx, p, input, extras);
  if (tool.type === 'rest') return rest({ ...asToolDef(tool), type: 'rest', source: tool.source }, input);
  const checked = checkArgs(asToolDef(tool), input);
  if ('error' in checked) return { content: checked.error, isError: true };
  if (tool.type === 'javascript') {
    if (extras.actions.length < 5) extras.actions.push({ action: tool.action!, args: checked.values });
    return { content: 'The action will run in the user\'s browser after your answer.' };
  }
  const max = tool.max_rows ?? DEFAULT_ROWS;
  const timeout = `${tool.timeout_s ?? DEFAULT_TIMEOUT_S}s`;
  try {
    const rows = await appTx(txContext(ctx), async (c) => {
      await c.query(`select set_config('statement_timeout', $1, true)`, [timeout]);
      if (tool.type === 'sql') {
        // a query tool never changes data: the whole transaction is read-only (functions it calls included)
        await c.query('set transaction read only');
        const sql = applyBinds(stripSemicolon(tool.sql!), { ...bindValues(ctx), ...modelBinds(checked.values) });
        return (await c.query(`select * from (\n${sql}\n) "__ai" limit ${max + 1}`)).rows;
      }
      // function: named arguments (parameter names in lower case), the values as escaped untyped literals
      const args = Object.entries(checked.values).map(([k, v]) => `${pg.escapeIdentifier(k.toLowerCase())} => ${literal(v)}`);
      return (await c.query(`select * from ${tool.function}(${args.join(', ')}) limit ${max + 1}`)).rows;
    });
    return { content: rowsJson(rows, max) };
  } catch (e) {
    return { content: await publicError(ctx, e, `AI tool ${tool.name}`), isError: true };
  }
}

// ---------------------------------------------------------------- the log

const MAX_ARG_CHARS = 4000;
let lastPurge = 0;

/** Log a tool call (meta.ai_tool_call) and write it to the page's debug messages. */
export async function logToolCall(
  ctx: PageContext, regionId: number, agent: string | null, tool: string, type: string, input: Record<string, unknown>, out: AgentOutcome, ms: number,
) {
  const status = out.refused ? 'refused' : out.isError ? 'error' : 'ok';
  let args = JSON.stringify(input ?? {});
  if (args.length > MAX_ARG_CHARS) args = JSON.stringify({ cut_off: args.slice(0, MAX_ARG_CHARS) });
  dbg(ctx, 4, 'ai', () => `AI tool ${tool} (${type}${agent ? `, agent ${agent}` : ''}) ${args} → ${status} in ${Math.round(ms)} ms${out.isError ? `: ${out.content.slice(0, 300)}` : ''}`);
  try {
    await owner.query(
      `insert into meta.ai_tool_call (app_id, page_no, region_id, username, agent, tool, type, arguments, status, duration_ms, message)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [ctx.app.id, ctx.page.page_no, regionId, ctx.user, agent, tool.slice(0, 64), type, args, status, Math.round(ms), out.isError ? out.content.slice(0, 500) : null],
    );
    if (Date.now() - lastPurge > 3_600_000) {
      lastPurge = Date.now();
      await owner.query(`delete from meta.ai_tool_call where at < now() - interval '30 days'`);
    }
  } catch {
    // the log must not fail the conversation
  }
}
