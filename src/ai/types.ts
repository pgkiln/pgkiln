// The provider interface of pgapex's AI features (src/ai/): one request in,
// one answer out, whatever the provider. Providers live in anthropic.ts
// (Claude, with the official @anthropic-ai/sdk) and openai.ts (the official
// openai SDK); service.ts picks one for an AI service and adds the checks,
// limits and the usage log.

export type ProviderName = 'anthropic' | 'openai';

export interface ProviderConfig {
  /** the model, exactly as the developer entered it (never changed or downgraded) */
  model: string;
  apiKey: string;
  /** a proxy, gateway or (in tests) a mock server; administrators only */
  baseUrl?: string | null;
  timeoutMs: number;
  maxTokens: number;
  /** Claude: thinking depth; null leaves the model's default */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  /** Claude: server-side refusal fallbacks ("default": Anthropic's recommended model per refusal category) */
  refusalFallback?: boolean;
}

export interface GenerateRequest {
  system?: string | null;
  prompt: string;
  /** structured output: a JSON schema of an object; the answer is then that JSON */
  schema?: Record<string, unknown> | null;
  /** at most this many output tokens (never above the service's maximum) */
  maxTokens?: number;
}

export interface GenerateResult {
  text: string;
  /** the answer parsed, for a schema */
  json?: unknown;
  /** the model that answered (a refusal fallback may differ from the configured one) */
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** the answer reached the output limit (text answers are kept; structured ones fail) */
  truncated: boolean;
}

export interface AiProvider {
  generate(req: GenerateRequest): Promise<GenerateResult>;
}

/** What went wrong, in a form an application user may see (no secrets, no provider internals). */
export type AiErrorKind =
  | 'config' // no key, unknown service, not allowed for the app, disabled
  | 'limit' // the app's daily request or token limit
  | 'auth' // the provider refused the key
  | 'rate_limit'
  | 'timeout'
  | 'connection'
  | 'bad_request' // e.g. an unknown model, a schema the provider can't use
  | 'server' // the provider failed (5xx, overloaded)
  | 'refused' // the model declined (safety)
  | 'output'; // the answer was not what was asked for (no JSON, truncated)

export class AiError extends Error {
  /** like a RAISE EXCEPTION: publicError() shows the message itself (it names nothing secret) */
  readonly code = 'P0001';
  constructor(readonly kind: AiErrorKind, message: string, readonly status?: number) {
    super(message);
  }
}

export const isAiError = (e: unknown): e is AiError => e instanceof AiError;
