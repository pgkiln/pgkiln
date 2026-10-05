import OpenAI from 'openai';
import { AiError, type AiProvider, type GenerateRequest, type GenerateResult, type ProviderConfig } from './types.ts';

// OpenAI through the official SDK (Chat Completions, which OpenAI-compatible
// gateways also offer). Structured outputs use the JSON schema response
// format with strict: true, so the schema must list every property as
// required and set additionalProperties: false (schemas built from items do).

export class OpenAiProvider implements AiProvider {
  private readonly client: OpenAI;
  constructor(private readonly conf: ProviderConfig) {
    this.client = new OpenAI({
      apiKey: conf.apiKey,
      baseURL: conf.baseUrl || undefined,
      timeout: conf.timeoutMs,
      maxRetries: 1,
    });
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const { conf } = this;
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (req.system) messages.push({ role: 'system', content: req.system });
    messages.push({ role: 'user', content: req.prompt });
    let res: OpenAI.Chat.ChatCompletion;
    try {
      res = await this.client.chat.completions.create({
        model: conf.model,
        messages,
        max_completion_tokens: Math.min(req.maxTokens ?? conf.maxTokens, conf.maxTokens),
        ...(req.schema ? { response_format: { type: 'json_schema' as const, json_schema: { name: 'output', schema: req.schema, strict: true } } } : {}),
      });
    } catch (e) {
      throw openAiError(e);
    }
    const usage = { inputTokens: res.usage?.prompt_tokens ?? 0, outputTokens: res.usage?.completion_tokens ?? 0 };
    const choice = res.choices?.[0];
    if (!choice) throw Object.assign(new AiError('output', 'The AI service sent no answer.'), { usage, model: res.model });
    if (choice.message?.refusal || choice.finish_reason === 'content_filter')
      throw Object.assign(new AiError('refused', 'The AI model declined to answer this request.'), { usage, model: res.model });
    return { text: choice.message?.content ?? '', model: res.model || conf.model, ...usage, truncated: choice.finish_reason === 'length' };
  }
}

/** The SDK's typed errors, most specific first, as messages a user may see. */
export function openAiError(e: unknown): AiError {
  if (e instanceof AiError) return e;
  if (e instanceof OpenAI.AuthenticationError || e instanceof OpenAI.PermissionDeniedError)
    return new AiError('auth', 'The AI service refused the API key (check the key of the AI service).', e.status);
  if (e instanceof OpenAI.RateLimitError) return new AiError('rate_limit', 'The AI service is busy (rate limit): try again in a moment.', 429);
  if (e instanceof OpenAI.NotFoundError) return new AiError('bad_request', 'The AI service does not know the model (check the model name of the AI service).', 404);
  if (e instanceof OpenAI.BadRequestError || e instanceof OpenAI.UnprocessableEntityError)
    return new AiError('bad_request', 'The AI service could not process the request (check the model, the output limit and the JSON schema).', e.status);
  if (e instanceof OpenAI.InternalServerError) return new AiError('server', 'The AI service failed: try again later.', e.status);
  if (e instanceof OpenAI.APIConnectionTimeoutError) return new AiError('timeout', 'The AI service did not answer in time.');
  if (e instanceof OpenAI.APIConnectionError) return new AiError('connection', 'The AI service could not be reached.');
  if (e instanceof OpenAI.APIError) return new AiError('server', `The AI service answered with an error${e.status ? ` (HTTP ${e.status})` : ''}.`, e.status);
  return new AiError('server', 'The AI request failed.');
}
