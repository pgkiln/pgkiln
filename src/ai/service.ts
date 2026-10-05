import { owner } from '../db.ts';
import { decryptSecret } from '../secrets.ts';
import { ClaudeProvider } from './anthropic.ts';
import { OpenAiProvider } from './openai.ts';
import { AiError, type AiProvider, type GenerateRequest, type GenerateResult, type ProviderName } from './types.ts';

// AI services (migration 060): an administrator configures them in the
// builder (Workspace utilities → AI services) and allows each application
// to use some of them, with optional limits per day. Every call goes
// through generate() here: the service must exist, be enabled and be
// allowed for the application; the daily limits are checked; the provider
// is called; and the call is logged in meta.ai_usage (tokens, model,
// duration, status — never the prompt or the answer). Services and keys
// are read with the owner pool: application code can't read them.

export interface AiService {
  id: number;
  name: string;
  description: string | null;
  provider: ProviderName;
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  refusal_fallback: boolean;
  max_tokens: number;
  timeout_s: number;
  base_url: string | null;
  api_key_enc: string | null;
  enabled: boolean;
}

/** The default model of a new Claude service; OpenAI services name theirs. */
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';

/** Prompt sizes (characters) a request may have, after substitutions. */
export const MAX_PROMPT_CHARS = 200_000;
export const MAX_SYSTEM_CHARS = 50_000;

const ENV_KEY: Record<ProviderName, string> = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' };

export const envKeyName = (p: ProviderName) => ENV_KEY[p];

/** Where the service's key comes from: stored (encrypted), the server's environment, or nowhere. */
export function keySource(s: Pick<AiService, 'provider' | 'api_key_enc'>): 'stored' | 'env' | 'missing' {
  if (s.api_key_enc) return 'stored';
  return process.env[ENV_KEY[s.provider]] ? 'env' : 'missing';
}

export async function loadService(name: string): Promise<AiService | undefined> {
  return owner.one<AiService>('select * from meta.ai_service where name = $1', [name.toUpperCase()]);
}

/** The provider of a service, with its key (decrypted only here, never stored elsewhere). */
export function providerFor(s: AiService): AiProvider {
  let apiKey: string | undefined;
  try {
    apiKey = s.api_key_enc ? decryptSecret(s.api_key_enc) : process.env[ENV_KEY[s.provider]];
  } catch (e) {
    throw new AiError('config', `AI service ${s.name}: ${(e as Error).message}`);
  }
  if (!apiKey) throw new AiError('config', `AI service ${s.name} has no API key (enter one in the builder, or set ${ENV_KEY[s.provider]} on the server).`);
  const conf = {
    model: s.model,
    apiKey,
    baseUrl: s.base_url,
    timeoutMs: s.timeout_s * 1000,
    maxTokens: s.max_tokens,
    effort: s.effort,
    refusalFallback: s.refusal_fallback,
  };
  return s.provider === 'anthropic' ? new ClaudeProvider(conf) : new OpenAiProvider(conf);
}

export interface CallInfo {
  /** null: a test from the builder (no application) */
  appId: number | null;
  pageNo?: number | null;
  user?: string | null;
  source: 'process' | 'dynamic_action' | 'sql' | 'builder';
  /** debug messages of the request (level, text) */
  debug?: (level: number, text: string) => void;
}

interface Usage {
  service: AiService;
  model: string;
  inputTokens: number;
  outputTokens: number;
  ms: number;
  status: 'ok' | 'refused' | 'error' | 'limited';
  message: string | null;
}

async function logUsage(info: CallInfo, u: Usage) {
  try {
    await owner.query(
      `insert into meta.ai_usage (app_id, page_no, username, service_id, service, provider, model, source, input_tokens, output_tokens, duration_ms, status, message)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [info.appId, info.pageNo ?? null, info.user ?? null, u.service.id, u.service.name, u.service.provider, u.model.slice(0, 200), info.source,
       u.inputTokens, u.outputTokens, Math.round(u.ms), u.status, u.message?.slice(0, 500) ?? null],
    );
  } catch {
    // the log must not fail the call (e.g. an application deleted meanwhile)
  }
}

/** Today's (UTC) requests and tokens of an application on a service. */
export async function usageToday(appId: number, serviceId: number) {
  return (await owner.one<{ requests: number; tokens: number }>(
    `select count(*) filter (where status <> 'limited')::int as requests, coalesce(sum(input_tokens + output_tokens), 0)::bigint::float8 as tokens
       from meta.ai_usage where app_id = $1 and service_id = $2 and at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'`,
    [appId, serviceId],
  ))!;
}

/** The service an application may use (by name), or an AiError. */
export async function serviceForApp(name: string, appId: number | null) {
  const s = await loadService(name);
  if (!s || !s.enabled) throw new AiError('config', `AI service ${name.toUpperCase()} does not exist or is switched off.`);
  if (appId === null) return { service: s, limits: null };
  const limits = await owner.one<{ max_requests: number | null; max_tokens: string | null }>(
    'select max_requests, max_tokens from meta.app_ai_service where app_id = $1 and service_id = $2', [appId, s.id]);
  if (!limits) throw new AiError('config', `This application may not use AI service ${s.name} (an administrator allows it under Workspace utilities → AI services).`);
  return { service: s, limits };
}

/**
 * One AI request through a service: checks, daily limits, the call, the
 * usage log. A structured request returns the parsed JSON in `json`.
 * Throws an AiError whose message a user may see.
 */
export async function generate(name: string, req: GenerateRequest, info: CallInfo): Promise<GenerateResult> {
  const { service: s, limits } = await serviceForApp(name, info.appId);
  if (req.prompt.length > MAX_PROMPT_CHARS || (req.system?.length ?? 0) > MAX_SYSTEM_CHARS)
    throw new AiError('config', `The prompt is too long (at most ${MAX_PROMPT_CHARS} characters, the system prompt ${MAX_SYSTEM_CHARS}).`);
  if (!req.prompt.trim()) throw new AiError('config', 'The prompt is empty.');
  if (limits && info.appId !== null && (limits.max_requests !== null || limits.max_tokens !== null)) {
    const today = await usageToday(info.appId, s.id);
    const over = (limits.max_requests !== null && today.requests >= limits.max_requests) || (limits.max_tokens !== null && today.tokens >= Number(limits.max_tokens));
    if (over) {
      await logUsage(info, { service: s, model: s.model, inputTokens: 0, outputTokens: 0, ms: 0, status: 'limited', message: 'daily limit' });
      throw new AiError('limit', `This application has reached its daily limit for AI service ${s.name}: try again tomorrow.`);
    }
  }
  const provider = providerFor(s);
  const t0 = performance.now();
  info.debug?.(6, `AI service ${s.name} (${s.provider}, ${s.model})${req.schema ? ', structured output' : ''}`);
  try {
    const res = await provider.generate(req);
    if (req.schema) {
      if (res.truncated) throw Object.assign(new AiError('output', 'The AI answer was cut off at the output limit (raise the service\'s maximum output tokens).'), { usage: res, model: res.model });
      try {
        res.json = JSON.parse(res.text);
      } catch {
        throw Object.assign(new AiError('output', 'The AI answer was not the JSON that was asked for.'), { usage: res, model: res.model });
      }
      if (!res.json || typeof res.json !== 'object' || Array.isArray(res.json))
        throw Object.assign(new AiError('output', 'The AI answer was not a JSON object.'), { usage: res, model: res.model });
    }
    const ms = performance.now() - t0;
    await logUsage(info, { service: s, model: res.model, inputTokens: res.inputTokens, outputTokens: res.outputTokens, ms, status: 'ok', message: res.truncated ? 'max_tokens' : null });
    info.debug?.(6, `AI answer from ${res.model}: ${res.inputTokens} input + ${res.outputTokens} output tokens in ${Math.round(ms)} ms${res.truncated ? ' (cut off at the output limit)' : ''}`);
    return res;
  } catch (e) {
    const err = e instanceof AiError ? e : new AiError('server', 'The AI request failed.');
    const extra = e as { usage?: { inputTokens: number; outputTokens: number }; model?: string };
    await logUsage(info, {
      service: s,
      model: extra.model ?? s.model,
      inputTokens: extra.usage?.inputTokens ?? 0,
      outputTokens: extra.usage?.outputTokens ?? 0,
      ms: performance.now() - t0,
      status: err.kind === 'refused' ? 'refused' : 'error',
      message: err.kind + (err.status ? ` ${err.status}` : ''),
    });
    info.debug?.(1, `AI service ${s.name}: ${err.kind}: ${err.message}`);
    throw err;
  }
}
