import Anthropic from '@anthropic-ai/sdk';
import { AiError, type AiProvider, type GenerateRequest, type GenerateResult, type ProviderConfig } from './types.ts';

// Claude through the official SDK. One user turn, an optional system prompt,
// optionally a structured output (output_config.format, a JSON schema). The
// model is the one the developer configured: thinking is adaptive on current
// models and `effort` sets its depth. Server-side refusal fallbacks
// ("default": Anthropic picks the fallback model per refusal category) are on
// unless the service turns them off. The answer is streamed (long answers
// don't hit HTTP time limits) and collected with finalMessage().

/** The beta that enables `fallbacks: "default"`. */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export class ClaudeProvider implements AiProvider {
  private readonly client: Anthropic;
  constructor(private readonly conf: ProviderConfig) {
    this.client = new Anthropic({
      apiKey: conf.apiKey,
      // never an ANTHROPIC_AUTH_TOKEN or a local profile: only the service's (or the server's) key
      authToken: null,
      baseURL: conf.baseUrl || undefined,
      timeout: conf.timeoutMs,
      maxRetries: 1,
    });
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const { conf } = this;
    const outputConfig: Anthropic.Beta.BetaOutputConfig = {};
    if (conf.effort) outputConfig.effort = conf.effort;
    if (req.schema) outputConfig.format = { type: 'json_schema', schema: req.schema };
    const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
      model: conf.model,
      max_tokens: Math.min(req.maxTokens ?? conf.maxTokens, conf.maxTokens),
      messages: [{ role: 'user', content: req.prompt }],
      ...(req.system ? { system: req.system } : {}),
      ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
      ...(conf.refusalFallback ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
    };
    let msg: Anthropic.Beta.BetaMessage;
    try {
      msg = await this.client.beta.messages.stream(params).finalMessage();
    } catch (e) {
      throw claudeError(e);
    }
    const usage = { inputTokens: (msg.usage.input_tokens ?? 0) + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0), outputTokens: msg.usage.output_tokens ?? 0 };
    // a refusal (after any fallback) carries no answer to use
    if (msg.stop_reason === 'refusal')
      throw Object.assign(new AiError('refused', 'The AI model declined to answer this request.'), { usage, model: msg.model });
    const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    return { text, model: msg.model, ...usage, truncated: msg.stop_reason === 'max_tokens' };
  }
}

/** The SDK's typed errors, most specific first, as messages a user may see. */
export function claudeError(e: unknown): AiError {
  if (e instanceof AiError) return e;
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError)
    return new AiError('auth', 'The AI service refused the API key (check the key of the AI service).', e.status);
  if (e instanceof Anthropic.RateLimitError) return new AiError('rate_limit', 'The AI service is busy (rate limit): try again in a moment.', 429);
  if (e instanceof Anthropic.NotFoundError) return new AiError('bad_request', 'The AI service does not know the model (check the model name of the AI service).', 404);
  if (e instanceof Anthropic.BadRequestError || e instanceof Anthropic.UnprocessableEntityError)
    return new AiError('bad_request', 'The AI service could not process the request (check the model, the output limit and the JSON schema).', e.status);
  if (e instanceof Anthropic.InternalServerError) return new AiError('server', 'The AI service failed: try again later.', e.status);
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new AiError('timeout', 'The AI service did not answer in time.');
  if (e instanceof Anthropic.APIConnectionError) return new AiError('connection', 'The AI service could not be reached.');
  if (e instanceof Anthropic.APIError) return new AiError('server', `The AI service answered with an error${e.status ? ` (HTTP ${e.status})` : ''}.`, e.status);
  return new AiError('server', 'The AI request failed.');
}
