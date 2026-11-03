import OpenAI from 'openai';
import { owner } from '../db.ts';
import { openAiError } from './openai.ts';
import { baseUrlFor, checkDailyLimit, logUsage, serviceForApp, serviceKey, type CallInfo } from './service.ts';
import { AiError } from './types.ts';

// (sprint 136, AP-1; APEX: Vector Providers, APEX_AI.GET_VECTOR_EMBEDDINGS) Vector providers turn text into an
// embedding. They are a JSON list in meta.app (vector_providers, migration 136), exported with the application:
//
//  - ai_service: an AI service of the installation (OpenAI, Gemini, or any OpenAI-compatible endpoint such as
//    Ollama) and an embedding model (text-embedding-3-small, gemini-embedding-001, nomic-embed-text …), called with
//    the official openai SDK's embeddings API. The key stays in meta.ai_service (encrypted, write-only, never
//    exported); the application must be allowed to use the service and its daily limits apply; every call is
//    logged in meta.ai_usage (source "embedding": tokens, model, duration, never the text).
//  - function: a SQL or PL/pgSQL function (text → vector, real[] or float8[]), called by meta.embed() as the
//    role that runs the query (security invoker), so its grants apply.
//
// The dimensions are part of the definition: every embedding is checked against them, and the builder checks
// them against the vector column (vector(n)) a search configuration or a vector column helper uses.

export type VectorProviderType = 'ai_service' | 'function';
export const VECTOR_PROVIDER_TYPES: VectorProviderType[] = ['ai_service', 'function'];

export interface VectorProvider {
  name: string;
  description?: string;
  type: VectorProviderType;
  /** ai_service: the AI service's name */
  service?: string;
  /** ai_service: the embedding model, exactly as the provider names it */
  model?: string;
  dimensions: number;
  /** function: schema.name */
  function?: string;
  /** ai_service: texts per request (background embedding; default 64) */
  batch_size?: number;
  /** ai_service: requests per minute (background embedding; default 60) */
  per_minute?: number;
}

export const PROVIDER_NAME = /^[A-Z][A-Z0-9_]{0,59}$/;
const SERVICE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,59}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/;
export const FUNCTION_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}\.[A-Za-z_][A-Za-z0-9_]{0,62}$/;
/** pgvector's vector type takes up to 16,000 dimensions (an HNSW index up to 2,000). */
export const MAX_DIMENSIONS = 16_000;
export const HNSW_MAX_DIMENSIONS = 2_000;
export const DEFAULT_BATCH = 64;
export const DEFAULT_PER_MINUTE = 60;
/** Characters of one text sent to a provider (longer texts are cut). */
export const MAX_TEXT_CHARS = 20_000;

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const intIn = (v: unknown, min: number, max: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

/** Problems with one vector provider (builder and runtime). */
export function vectorProviderProblems(p: unknown): string[] {
  if (!isObj(p)) return ['A vector provider is an object.'];
  const what = `Vector provider ${typeof p.name === 'string' ? p.name : '?'}`;
  const out: string[] = [];
  if (typeof p.name !== 'string' || !PROVIDER_NAME.test(p.name)) out.push(`${what}: the name (static ID) is upper case letters, digits and _ (e.g. DOC_EMBEDDINGS).`);
  if (!VECTOR_PROVIDER_TYPES.includes(p.type)) out.push(`${what}: the type is ai_service or function.`);
  if (p.description !== undefined && p.description !== null && (typeof p.description !== 'string' || p.description.length > 500)) out.push(`${what}: the description is text (at most 500 characters).`);
  if (!intIn(p.dimensions, 1, MAX_DIMENSIONS)) out.push(`${what}: the dimensions are a whole number from 1 to ${MAX_DIMENSIONS}.`);
  if (p.type === 'ai_service') {
    if (typeof p.service !== 'string' || !SERVICE_NAME.test(p.service)) out.push(`${what}: choose an AI service.`);
    if (typeof p.model !== 'string' || !MODEL.test(p.model)) out.push(`${what}: the embedding model is its name, e.g. text-embedding-3-small or nomic-embed-text.`);
    if (p.function !== undefined) out.push(`${what}: an AI service provider has no function.`);
  }
  if (p.type === 'function') {
    if (typeof p.function !== 'string' || !FUNCTION_NAME.test(p.function)) out.push(`${what}: the function is schema.name, e.g. sales.embed.`);
    if (p.service !== undefined || p.model !== undefined) out.push(`${what}: a function provider has no AI service or model.`);
  }
  if (p.batch_size !== undefined && !intIn(p.batch_size, 1, 2048)) out.push(`${what}: texts per request 1 to 2048.`);
  if (p.per_minute !== undefined && !intIn(p.per_minute, 1, 10_000)) out.push(`${what}: requests per minute 1 to 10000.`);
  return out;
}

/** Problems with an application's list: each entry, and names used twice. */
export function vectorProvidersProblems(list: unknown): string[] {
  if (!Array.isArray(list)) return ['Vector providers are a list.'];
  const out: string[] = [];
  const names = new Set<string>();
  for (const p of list) {
    out.push(...vectorProviderProblems(p));
    if (isObj(p) && typeof p.name === 'string') {
      if (names.has(p.name)) out.push(`Vector provider ${p.name} is defined twice.`);
      names.add(p.name);
    }
  }
  return out;
}

/** The application's vector providers (the owner reads them: the builder may have changed them a moment ago). */
export async function loadVectorProviders(appId: number): Promise<VectorProvider[]> {
  const r = await owner.one<{ vector_providers: unknown }>('select vector_providers from meta.app where id = $1', [appId]);
  return Array.isArray(r?.vector_providers) ? (r!.vector_providers as VectorProvider[]) : [];
}

/** One valid provider of an application by its static ID, or an AiError. */
export async function vectorProviderFor(appId: number, name: string): Promise<VectorProvider> {
  const p = (await loadVectorProviders(appId)).find((x) => x.name === String(name ?? '').toUpperCase());
  if (!p) throw new AiError('config', `There is no vector provider ${String(name ?? '').toUpperCase()} (Shared Components → Vector providers).`);
  const problems = vectorProviderProblems(p);
  if (problems.length) throw new AiError('config', problems.join(' '));
  return p;
}

/** A vector as pgvector's text input: [0.1,0.2,…] (numbers only). */
export function vectorLiteral(v: number[]): string {
  if (!Array.isArray(v) || !v.length || v.some((x) => typeof x !== 'number' || !Number.isFinite(x))) throw new AiError('output', 'The embedding is not a list of numbers.');
  return `[${v.join(',')}]`;
}

/** A client, a pool or pgkiln's Db: something that runs a query with parameters. */
type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export interface EmbedInfo extends Pick<CallInfo, 'appId' | 'pageNo' | 'user' | 'debug'> {
  appId: number;
}

/**
 * Embed texts with a provider: one vector per text, each with the provider's dimensions. A function provider
 * runs through meta.embed() on `client` (the caller's role and transaction); an AI service is called here.
 */
export async function embedTexts(p: VectorProvider, texts: string[], info: EmbedInfo, client?: Queryable): Promise<number[][]> {
  if (!texts.length) return [];
  const input = texts.map((t) => String(t ?? '').slice(0, MAX_TEXT_CHARS));
  if (p.type === 'function') {
    if (!client) throw new AiError('config', `Vector provider ${p.name}: a function provider needs a database connection.`);
    const rows = (await client.query('select meta.embed(t, $2, $3) as v from unnest($1::text[]) with ordinality u(t, n) order by n', [input, p.name, info.appId])).rows;
    return rows.map((r: { v: number[] | null }) => {
      if (!Array.isArray(r.v)) throw new AiError('output', `Vector provider ${p.name}: the function returned no embedding.`);
      return r.v.map(Number);
    });
  }
  const { service: s, limits } = await serviceForApp(p.service!, info.appId);
  if (s.provider === 'anthropic') throw new AiError('config', `AI service ${s.name} is a Claude service: Claude has no embeddings API (use an OpenAI, Gemini or OpenAI-compatible service).`);
  const call: CallInfo = { ...info, source: 'embedding' };
  await checkDailyLimit(s, limits, call, p.model!);
  const client2 = new OpenAI({ apiKey: serviceKey(s), baseURL: baseUrlFor(s) || undefined, timeout: s.timeout_s * 1000, maxRetries: 1 });
  const t0 = performance.now();
  info.debug?.(6, `vector provider ${p.name}: ${input.length} text(s) to AI service ${s.name} (${s.provider}, ${p.model})`);
  let tokens = 0;
  try {
    let res: OpenAI.CreateEmbeddingResponse;
    try {
      res = await client2.embeddings.create({
        model: p.model!,
        input,
        encoding_format: 'float',
        // OpenAI's text-embedding-3 models shorten their vectors to the dimensions asked for
        ...(s.provider === 'openai' && /^text-embedding-3/.test(p.model!) ? { dimensions: p.dimensions } : {}),
      });
    } catch (e) {
      throw openAiError(e);
    }
    tokens = res.usage?.prompt_tokens ?? 0;
    const data = [...(res.data ?? [])].sort((a, b) => a.index - b.index);
    if (data.length !== input.length) throw new AiError('output', `The AI service sent ${data.length} embeddings for ${input.length} texts.`);
    const out = data.map((d) => (Array.isArray(d.embedding) ? d.embedding.map(Number) : []));
    for (const v of out) {
      if (v.length !== p.dimensions)
        throw new AiError('output', `Vector provider ${p.name}: the model returned ${v.length} dimensions, the provider says ${p.dimensions} (change the provider's dimensions).`);
      if (v.some((x) => !Number.isFinite(x))) throw new AiError('output', 'The embedding is not a list of numbers.');
    }
    await logUsage(call, { service: s, model: res.model || p.model!, inputTokens: tokens, outputTokens: 0, ms: performance.now() - t0, status: 'ok', message: null });
    return out;
  } catch (e) {
    const err = e instanceof AiError ? e : new AiError('server', 'The embedding request failed.');
    await logUsage(call, { service: s, model: p.model!, inputTokens: tokens, outputTokens: 0, ms: performance.now() - t0, status: 'error', message: err.kind + (err.status ? ` ${err.status}` : '') });
    info.debug?.(1, `vector provider ${p.name}: ${err.kind}: ${err.message}`);
    throw err;
  }
}

// ---------------------------------------------------------------- the search text's embedding

/** Search texts embedded recently (per server process, AI service providers only): a search as you type asks again. */
const recent = new Map<string, { at: number; v: number[] }>();
const RECENT_MAX = 500;
const RECENT_MS = 10 * 60_000;

/** The embedding of one search text (AI service providers: kept a few minutes in this process's memory). */
export async function embedQuery(p: VectorProvider, text: string, info: EmbedInfo, client?: Queryable): Promise<number[]> {
  if (p.type === 'function') return (await embedTexts(p, [text], info, client))[0];
  const key = JSON.stringify([info.appId, p.name, p.service, p.model, p.dimensions, text]);
  const hit = recent.get(key);
  if (hit && Date.now() - hit.at < RECENT_MS) return hit.v;
  const [v] = await embedTexts(p, [text], info, client);
  if (recent.size >= RECENT_MAX) recent.delete(recent.keys().next().value!);
  recent.set(key, { at: Date.now(), v });
  return v;
}

/** Forget the remembered search texts (tests; a provider that changed). */
export const forgetQueries = () => recent.clear();
