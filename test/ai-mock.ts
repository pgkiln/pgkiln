// A local stand-in for the Claude and OpenAI APIs (no real API calls in
// tests): Claude's Messages API as a server-sent event stream under
// <base>/claude/v1/messages, OpenAI's Chat Completions under
// <base>/openai/v1/chat/completions. What it answers is set per test.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type MockMode = 'text' | 'refusal' | 'rate' | 'auth' | 'bad' | 'slow' | 'max_tokens' | 'server';

export interface SeenRequest {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

export interface AiMock {
  base: string;
  seen: SeenRequest[];
  /** what the next requests get */
  mode: MockMode;
  /** the answer's text (JSON text for structured outputs) */
  answer: string;
  /** the model the answer claims (default: the requested one) */
  model?: string;
  close(): Promise<void>;
}

const sse = (res: http.ServerResponse, events: [string, unknown][]) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
};

export async function startAiMock(): Promise<AiMock> {
  const mock: AiMock = { base: '', seen: [], mode: 'text', answer: 'A short summary.', close: async () => {} };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body: any = null;
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
      const path = new URL(req.url!, 'http://x').pathname;
      mock.seen.push({ path, headers: req.headers, body });
      const fail = (status: number, type: string) => {
        res.writeHead(status, { 'content-type': 'application/json', 'x-should-retry': 'false' });
        res.end(JSON.stringify({ type: 'error', error: { type, message: `mock ${type}` } }));
      };
      if (mock.mode === 'rate') return fail(429, 'rate_limit_error');
      if (mock.mode === 'auth') return fail(401, 'authentication_error');
      if (mock.mode === 'bad') return fail(400, 'invalid_request_error');
      if (mock.mode === 'server') return fail(500, 'api_error');
      const model = mock.model ?? body?.model ?? 'mock';
      const answer = mock.answer;
      const respond = () => {
        if (path === '/claude/v1/messages') {
          const stop = mock.mode === 'refusal' ? 'refusal' : mock.mode === 'max_tokens' ? 'max_tokens' : 'end_turn';
          return sse(res, [
            ['message_start', { type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 42, output_tokens: 1 } } }],
            ...(mock.mode === 'refusal'
              ? []
              : ([
                  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
                  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer } }],
                  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
                ] as [string, unknown][])),
            ['message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 7 } }],
            ['message_stop', { type: 'message_stop' }],
          ]);
        }
        if (path === '/openai/v1/chat/completions') {
          res.writeHead(200, { 'content-type': 'application/json' });
          const refused = mock.mode === 'refusal';
          return res.end(JSON.stringify({
            id: 'chatcmpl-mock', object: 'chat.completion', created: 0, model,
            choices: [{ index: 0, finish_reason: mock.mode === 'max_tokens' ? 'length' : 'stop', message: { role: 'assistant', content: refused ? null : answer, refusal: refused ? 'I can\'t help with that.' : null } }],
            usage: { prompt_tokens: 30, completion_tokens: 9, total_tokens: 39 },
          }));
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{}');
      };
      if (mock.mode === 'slow') setTimeout(respond, 1500);
      else respond();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  mock.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  mock.close = () => new Promise<void>((r) => {
    server.closeAllConnections();
    server.close(() => r());
  });
  return mock;
}
