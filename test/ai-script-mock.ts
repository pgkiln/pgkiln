// A scripted stand-in for the Claude and OpenAI APIs for conversations with
// tools (no real API calls in tests): each request takes the next scripted
// reply — a text answer, tool calls, a refusal or an HTTP error. Claude's
// Messages API is a server-sent event stream under <base>/claude/v1/messages
// (a tool reply also carries a thinking block, to check that the history is
// sent back unchanged); OpenAI's Chat Completions under
// <base>/openai/v1/chat/completions.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type Reply =
  | { text: string; stop?: 'end_turn' | 'max_tokens' }
  | { tools: { name: string; input: Record<string, unknown> }[] }
  | { refusal: true }
  | { status: number };

export interface Seen {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

export interface ScriptMock {
  base: string;
  seen: Seen[];
  /** replies for the next requests, in order; when empty: {text: 'OK.'} */
  script: Reply[];
  close(): Promise<void>;
}

let ids = 0;

export async function startScriptMock(): Promise<ScriptMock> {
  const mock: ScriptMock = { base: '', seen: [], script: [], close: async () => {} };
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
      const reply: Reply = mock.script.shift() ?? { text: 'OK.' };
      if ('status' in reply) {
        res.writeHead(reply.status, { 'content-type': 'application/json', 'x-should-retry': 'false' });
        return res.end(JSON.stringify({ type: 'error', error: { type: 'mock_error', message: 'mock error' } }));
      }
      const model = body?.model ?? 'mock';
      if (path === '/claude/v1/messages') {
        const events: [string, unknown][] = [
          ['message_start', { type: 'message_start', message: { id: `msg_${++ids}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } }],
        ];
        let stop = 'end_turn';
        if ('text' in reply) {
          stop = reply.stop ?? 'end_turn';
          events.push(
            ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
            ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply.text } }],
            ['content_block_stop', { type: 'content_block_stop', index: 0 }],
          );
        } else if ('tools' in reply) {
          stop = 'tool_use';
          events.push(
            ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }],
            ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: `sig-${ids}` } }],
            ['content_block_stop', { type: 'content_block_stop', index: 0 }],
          );
          reply.tools.forEach((t, i) => {
            events.push(
              ['content_block_start', { type: 'content_block_start', index: i + 1, content_block: { type: 'tool_use', id: `toolu_${++ids}`, name: t.name, input: {} } }],
              ['content_block_delta', { type: 'content_block_delta', index: i + 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify(t.input) } }],
              ['content_block_stop', { type: 'content_block_stop', index: i + 1 }],
            );
          });
        } else stop = 'refusal';
        events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } }], ['message_stop', { type: 'message_stop' }]);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        return res.end();
      }
      if (path === '/openai/v1/chat/completions') {
        const message: Record<string, unknown> = { role: 'assistant', content: null, refusal: null };
        let finish = 'stop';
        if ('text' in reply) {
          message.content = reply.text;
          if (reply.stop === 'max_tokens') finish = 'length';
        } else if ('tools' in reply) {
          finish = 'tool_calls';
          message.tool_calls = reply.tools.map((t) => ({ id: `call_${++ids}`, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.input) } }));
        } else message.refusal = 'I can\'t help with that.';
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          id: `chatcmpl-${++ids}`, object: 'chat.completion', created: 0, model,
          choices: [{ index: 0, finish_reason: finish, message }],
          usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
        }));
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
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
