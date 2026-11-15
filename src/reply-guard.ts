// (sprint 200) A handler that sends its reply itself and then returns nothing.
//
// Fastify answers an async handler that resolves to undefined with reply.send(undefined) unless the reply is already
// "sent", and a reply counts as sent only once the response has ended: while an async onSend hook still runs (the
// application's browser security, src/security.ts, reads the database on a cache miss) it is not. Such a handler
// (`simplePage(reply, …); return;`, `if (!ctx) return;` after loadContext answered) so started a second, empty send
// of the same reply, and whichever onSend chain finished first was written: now and then a page with the right
// status and an empty body (seen as a flaky 503 of an application without a database role).
//
// The guard notes, in the first onSend hook, that a reply's send has begun, and turns an async handler's undefined
// (or null: `if (!ctx) return null;`) into `return reply` (Fastify's documented way: it waits for the response) when
// it has. Handlers that return their payload, or `reply`, are unchanged; so is one that returns nothing before
// anything was sent.
import type { FastifyInstance, FastifyReply } from 'fastify';

const sending = new WeakSet<FastifyReply>();

/** Register before every other onSend hook and before the routes. */
export function replyGuard(app: FastifyInstance) {
  app.addHook('onSend', (_req, reply, payload, done) => {
    sending.add(reply);
    done(null, payload);
  });
  app.addHook('onRoute', (opts) => {
    const handler = opts.handler as (this: unknown, ...a: unknown[]) => unknown;
    opts.handler = function (this: unknown, req, reply) {
      const r = handler.call(this, req, reply);
      if (!r || typeof (r as Promise<unknown>).then !== 'function') return r;
      return (r as Promise<unknown>).then((v) => ((v === undefined || v === null) && sending.has(reply) && !reply.sent ? reply : v));
    } as typeof opts.handler;
  });
}
