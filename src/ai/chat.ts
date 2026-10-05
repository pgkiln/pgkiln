import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { owner } from '../db.ts';
import { decryptSecret } from '../secrets.ts';
import { claudeError } from './anthropic.ts';
import { openAiError } from './openai.ts';
import { envKeyName, MAX_PROMPT_CHARS, MAX_SYSTEM_CHARS, serviceForApp, usageToday, type AiService } from './service.ts';
import { AiError } from './types.ts';

// Conversations with tools (AI assistant regions, src/runtime/assistant.ts):
// a history of messages in the provider's own format, a new user message,
// and tools the model may call. The loop runs here: the model answers or
// asks for tools; the caller runs them (runTool) and their results go back,
// until the model answers in text or the round limit is reached.
//
// Built on the AI services of migration 060 (src/ai/service.ts): the service
// must be allowed for the application, its daily limits are checked before
// every call to the provider, and every call is logged in meta.ai_usage
// (tokens, model, duration; never the text).
//
// Claude: the official SDK, streamed (finalMessage), tools with strict: true
// and tool_choice auto (forced tool use is refused by current models), the
// service's effort, server-side refusal fallbacks. The assistant's content
// is appended to the history unchanged (thinking blocks included): the
// history only ever grows, as the API expects. OpenAI: Chat Completions with
// strict function tools.

export interface ChatTool {
  name: string;
  description: string;
  /** a strict JSON schema of an object: every property required, additionalProperties false */
  parameters: Record<string, unknown>;
}

export interface ToolOutcome {
  content: string;
  isError?: boolean;
}

export interface ChatRequest {
  system: string;
  /** the conversation so far, in the provider's format (from an earlier ChatResult) */
  history: unknown[];
  /** the new user message (may hold delimited data) */
  message: string;
  tools: ChatTool[];
  /** at most this many rounds of tool calls (then the model must answer) */
  maxRounds: number;
  runTool(name: string, input: Record<string, unknown>): Promise<ToolOutcome>;
}

export interface ChatResult {
  /** the whole conversation, to keep for the next message */
  history: unknown[];
  text: string;
  tools: { name: string; ok: boolean }[];
  model: string;
  truncated: boolean;
}

export interface ChatInfo {
  appId: number;
  pageNo?: number | null;
  user?: string | null;
  source: string;
  debug?: (level: number, text: string) => void;
}

/** Tool results are cut to this many characters (the model sees that they were). */
export const MAX_TOOL_RESULT_CHARS = 20_000;

function apiKey(s: AiService) {
  let key: string | undefined;
  try {
    key = s.api_key_enc ? decryptSecret(s.api_key_enc) : process.env[envKeyName(s.provider)];
  } catch (e) {
    throw new AiError('config', `AI service ${s.name}: ${(e as Error).message}`);
  }
  if (!key) throw new AiError('config', `AI service ${s.name} has no API key (enter one in the builder, or set ${envKeyName(s.provider)} on the server).`);
  return key;
}

async function logUsage(info: ChatInfo, s: AiService, u: { model: string; input: number; output: number; ms: number; status: string; message: string | null }) {
  try {
    await owner.query(
      `insert into meta.ai_usage (app_id, page_no, username, service_id, service, provider, model, source, input_tokens, output_tokens, duration_ms, status, message)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [info.appId, info.pageNo ?? null, info.user ?? null, s.id, s.name, s.provider, u.model.slice(0, 200), info.source, u.input, u.output, Math.round(u.ms), u.status, u.message?.slice(0, 500) ?? null],
    );
  } catch {
    // the log must not fail the call
  }
}

const clip = (text: string) => (text.length > MAX_TOOL_RESULT_CHARS ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n[cut off: the result was longer]` : text);

/** One provider call: the daily limits first, then the call, then the usage log. */
async function metered<T extends { model: string; input: number; output: number }>(
  s: AiService, limits: { max_requests: number | null; max_tokens: string | null } | null, info: ChatInfo, call: () => Promise<T>,
): Promise<T> {
  if (limits && (limits.max_requests !== null || limits.max_tokens !== null)) {
    const today = await usageToday(info.appId, s.id);
    if ((limits.max_requests !== null && today.requests >= limits.max_requests) || (limits.max_tokens !== null && today.tokens >= Number(limits.max_tokens))) {
      await logUsage(info, s, { model: s.model, input: 0, output: 0, ms: 0, status: 'limited', message: 'daily limit' });
      throw new AiError('limit', `This application has reached its daily limit for AI service ${s.name}: try again tomorrow.`);
    }
  }
  const t0 = performance.now();
  try {
    const r = await call();
    await logUsage(info, s, { model: r.model, input: r.input, output: r.output, ms: performance.now() - t0, status: 'ok', message: null });
    info.debug?.(6, `AI answer from ${r.model}: ${r.input} input + ${r.output} output tokens in ${Math.round(performance.now() - t0)} ms`);
    return r;
  } catch (e) {
    const err = e instanceof AiError ? e : new AiError('server', 'The AI request failed.');
    const extra = e as { usage?: { input: number; output: number }; model?: string };
    await logUsage(info, s, {
      model: extra.model ?? s.model, input: extra.usage?.input ?? 0, output: extra.usage?.output ?? 0, ms: performance.now() - t0,
      status: err.kind === 'refused' ? 'refused' : 'error', message: err.kind + (err.status ? ` ${err.status}` : ''),
    });
    info.debug?.(1, `AI service ${s.name}: ${err.kind}: ${err.message}`);
    throw err;
  }
}

const TOO_MANY_ROUNDS = 'The assistant needed more steps than it may take for one question: ask a simpler question, or start a new conversation.';

async function claudeChat(s: AiService, limits: Parameters<typeof metered>[1], req: ChatRequest, info: ChatInfo): Promise<ChatResult> {
  const client = new Anthropic({ apiKey: apiKey(s), authToken: null, baseURL: s.base_url || undefined, timeout: s.timeout_s * 1000, maxRetries: 1 });
  const messages = [...(req.history as Anthropic.Beta.BetaMessageParam[]), { role: 'user', content: req.message } as Anthropic.Beta.BetaMessageParam];
  const tools: Anthropic.Beta.BetaTool[] = req.tools.map((t) => ({
    name: t.name, description: t.description, strict: true, input_schema: t.parameters as Anthropic.Beta.BetaTool.InputSchema,
  }));
  const used: ChatResult['tools'] = [];
  for (let round = 0; ; round++) {
    const msg = await metered(s, limits, info, async () => {
      let m: Anthropic.Beta.BetaMessage;
      try {
        m = await client.beta.messages.stream({
          model: s.model,
          max_tokens: s.max_tokens,
          system: req.system,
          messages,
          ...(tools.length ? { tools } : {}),
          ...(s.effort ? { output_config: { effort: s.effort } } : {}),
          ...(s.refusal_fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
        }).finalMessage();
      } catch (e) {
        throw claudeError(e);
      }
      const usage = { input: (m.usage.input_tokens ?? 0) + (m.usage.cache_read_input_tokens ?? 0) + (m.usage.cache_creation_input_tokens ?? 0), output: m.usage.output_tokens ?? 0 };
      if (m.stop_reason === 'refusal') throw Object.assign(new AiError('refused', 'The AI model declined to answer this request.'), { usage, model: m.model });
      return { m, model: m.model, ...usage };
    });
    const m = msg.m;
    const calls = m.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    if (m.stop_reason === 'max_tokens' && calls.length)
      throw new AiError('output', 'The AI answer was cut off at the output limit (raise the service\'s maximum output tokens).');
    messages.push({ role: 'assistant', content: m.content as Anthropic.Beta.BetaContentBlockParam[] });
    if (m.stop_reason !== 'tool_use' || !calls.length) {
      const text = m.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
      return { history: messages, text, tools: used, model: m.model, truncated: m.stop_reason === 'max_tokens' };
    }
    if (round >= req.maxRounds) throw new AiError('output', TOO_MANY_ROUNDS);
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const call of calls) {
      const out = await req.runTool(call.name, (call.input ?? {}) as Record<string, unknown>);
      used.push({ name: call.name, ok: !out.isError });
      results.push({ type: 'tool_result', tool_use_id: call.id, content: clip(out.content), ...(out.isError ? { is_error: true } : {}) });
    }
    messages.push({ role: 'user', content: results });
  }
}

async function openAiChat(s: AiService, limits: Parameters<typeof metered>[1], req: ChatRequest, info: ChatInfo): Promise<ChatResult> {
  const client = new OpenAI({ apiKey: apiKey(s), baseURL: s.base_url || undefined, timeout: s.timeout_s * 1000, maxRetries: 1 });
  const messages = [...(req.history as OpenAI.Chat.ChatCompletionMessageParam[]), { role: 'user', content: req.message } as OpenAI.Chat.ChatCompletionMessageParam];
  const tools: OpenAI.Chat.ChatCompletionTool[] = req.tools.map((t) => ({
    type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters, strict: true },
  }));
  const used: ChatResult['tools'] = [];
  for (let round = 0; ; round++) {
    const res = await metered(s, limits, info, async () => {
      let r: OpenAI.Chat.ChatCompletion;
      try {
        r = await client.chat.completions.create({
          model: s.model,
          // the system prompt is sent with each request, not kept in the history
          messages: [{ role: 'system', content: req.system }, ...messages],
          max_completion_tokens: s.max_tokens,
          ...(tools.length ? { tools } : {}),
        });
      } catch (e) {
        throw openAiError(e);
      }
      const usage = { input: r.usage?.prompt_tokens ?? 0, output: r.usage?.completion_tokens ?? 0 };
      const choice = r.choices?.[0];
      if (!choice) throw Object.assign(new AiError('output', 'The AI service sent no answer.'), { usage, model: r.model });
      if (choice.message?.refusal || choice.finish_reason === 'content_filter')
        throw Object.assign(new AiError('refused', 'The AI model declined to answer this request.'), { usage, model: r.model });
      return { choice, model: r.model || s.model, ...usage };
    });
    const { choice } = res;
    const calls = (choice.message.tool_calls ?? []).filter((c): c is OpenAI.Chat.ChatCompletionMessageFunctionToolCall => c.type === 'function');
    if (choice.finish_reason === 'length' && calls.length)
      throw new AiError('output', 'The AI answer was cut off at the output limit (raise the service\'s maximum output tokens).');
    messages.push({ role: 'assistant', content: choice.message.content ?? null, ...(calls.length ? { tool_calls: calls } : {}) });
    if (!calls.length) return { history: messages, text: (choice.message.content ?? '').trim(), tools: used, model: res.model, truncated: choice.finish_reason === 'length' };
    if (round >= req.maxRounds) throw new AiError('output', TOO_MANY_ROUNDS);
    for (const call of calls) {
      let input: Record<string, unknown>;
      let out: ToolOutcome;
      try {
        input = JSON.parse(call.function.arguments || '{}');
        out = input && typeof input === 'object' && !Array.isArray(input) ? await req.runTool(call.function.name, input) : { content: 'The arguments are not a JSON object.', isError: true };
      } catch {
        out = { content: 'The arguments are not valid JSON.', isError: true };
      }
      used.push({ name: call.function.name, ok: !out.isError });
      messages.push({ role: 'tool', tool_call_id: call.id, content: clip(out.isError ? `Error: ${out.content}` : out.content) });
    }
  }
}

/**
 * One question in a conversation: the model's answer after any tool calls,
 * and the history to keep. Throws an AiError a user may see; then nothing of
 * this question should be kept (the history stays as it was).
 */
export async function chat(serviceName: string, req: ChatRequest, info: ChatInfo): Promise<ChatResult> {
  const { service: s, limits } = await serviceForApp(serviceName, info.appId);
  if (!req.message.trim()) throw new AiError('config', 'The message is empty.');
  if (req.message.length > MAX_PROMPT_CHARS || req.system.length > MAX_SYSTEM_CHARS)
    throw new AiError('config', `The message is too long (at most ${MAX_PROMPT_CHARS} characters, the system prompt ${MAX_SYSTEM_CHARS}).`);
  info.debug?.(6, `AI service ${s.name} (${s.provider}, ${s.model}), ${req.tools.length} tool(s), ${req.history.length} earlier message(s)`);
  return s.provider === 'anthropic' ? claudeChat(s, limits, req, info) : openAiChat(s, limits, req, info);
}

/** The provider of a service an application may use (to start a conversation in its format). */
export async function chatProvider(serviceName: string, appId: number) {
  return (await serviceForApp(serviceName, appId)).service.provider;
}
