import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hashToken } from '../security.ts';
import { cookieName, getSession } from '../session.ts';
import { isAdmin } from '../builder/locks.ts';
import { appIdOf, instanceTelemetry } from './config.ts';
import { prometheusText } from './export.ts';
import { relay } from './browser.ts';
import { count, emitLog, endTrace, meteringOn, observe, runIn, SPAN_KIND, startTrace, tracingOn, type Ctx } from './trace.ts';

// (sprint 139, AP-6) A trace per request (applications; builder requests when
// the instance asks for them), request metrics, GET /metrics (Prometheus) and
// the browser relay POST /a/:alias/telemetry: a page whose trace is sent
// carries a signed <meta name="pgkiln-trace">, and app.js reports the page
// load and its Ajax calls to pgkiln, which turns them into spans of the page's
// trace. No collector address or token ever reaches the browser.

const CTX = Symbol('pgkiln.trace');
const T0 = Symbol('pgkiln.t0');
const ERR = Symbol('pgkiln.error');
type Tagged = FastifyRequest & { [CTX]?: Ctx; [T0]?: number; [ERR]?: string };

const QUIET = /^\/(static\/|healthz$|metrics$|favicon)|^\/a\/[^/]+\/(telemetry|sw\.js|manifest)/;

function appAlias(path: string): string | undefined {
  const m = /^\/a\/([^/?#]{1,100})/.exec(path);
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return undefined;
  }
}

/** The metric label of a request: a known application's alias, "builder" or "other" (never what a URL makes up). */
function appLabel(path: string) {
  const alias = appAlias(path);
  if (alias) return appIdOf(alias) ? alias.toLowerCase() : 'unknown';
  return path.startsWith('/builder') ? 'builder' : 'other';
}

export function telemetryHooks(app: FastifyInstance) {
  app.addHook('onRequest', (req: Tagged, _reply, done) => {
    req[T0] = performance.now();
    const path = req.url.split('?')[0];
    if (QUIET.test(path) || !tracingOn()) return done();
    const alias = appAlias(path);
    const t = instanceTelemetry();
    // builder requests go to the instance's collector only, and only when asked for
    if (!alias && !(path.startsWith('/builder') && t.enabled && t.traces && t.builder)) return done();
    const q = req.url.indexOf('?');
    const ctx = startTrace(`${req.method} ${path.slice(0, 120)}`, SPAN_KIND.server, {
      'http.request.method': req.method,
      'url.path': path.slice(0, 500),
      'url.scheme': req.protocol,
      'server.address': req.hostname,
      'pgkiln.app.alias': alias ?? null,
    }, req.headers.traceparent as string | undefined);
    if (!ctx) return done();
    ctx.trace.alias = alias;
    ctx.span.vals = { 'url.query': q >= 0 ? req.url.slice(q + 1, q + 2001) : null, 'client.address': req.ip };
    req[CTX] = ctx;
    runIn(ctx, done);
  });
  app.addHook('onError', async (req: Tagged, _reply, err) => {
    req[ERR] = err.message;
    emitLog({ severity: 'ERROR', body: 'unhandled error', detail: err.message, attrs: { 'pgkiln.event': 'error', 'url.path': req.url.split('?')[0].slice(0, 500) }, appId: appIdOf(appAlias(req.url)) ?? null });
  });
  app.addHook('onResponse', async (req: Tagged, reply) => {
    const code = reply.statusCode;
    const path = req.url.split('?')[0];
    const route = req.routeOptions?.url;
    if (meteringOn() && !QUIET.test(path) && req[T0] !== undefined)
      observe('pgkiln.http.server.duration', { app: appLabel(path), method: req.method, status_class: `${Math.floor(code / 100)}xx` }, performance.now() - req[T0]);
    const ctx = req[CTX];
    if (!ctx) return;
    if (route) ctx.span.name = `${req.method} ${route}`;
    endTrace(ctx, { 'http.response.status_code': code, 'http.route': route ?? null }, code >= 500 ? req[ERR] ?? `HTTP ${code}` : undefined);
  });
}

// ---------------------------------------------------------------- routes

async function metricsAllowed(req: FastifyRequest, reply: FastifyReply) {
  const t = instanceTelemetry();
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ') && t.prometheusTokenHash) {
    const given = Buffer.from(hashToken(auth.slice(7).trim()));
    const want = Buffer.from(t.prometheusTokenHash);
    if (given.length === want.length && timingSafeEqual(given, want)) return true;
  }
  // an administrator's builder session (the browser)
  if (req.cookies[cookieName(null)]) {
    const s = await getSession(req, reply, null, '/builder');
    if (s.username && (await isAdmin(s.username))) return true;
  }
  return false;
}

export async function telemetryRoutes(app: FastifyInstance) {
  app.get('/metrics', async (req, reply) => {
    if (!instanceTelemetry().prometheus) return reply.code(404).type('text/plain').send('Not found');
    if (!(await metricsAllowed(req, reply)))
      return reply.code(401).header('www-authenticate', 'Bearer realm="pgkiln metrics"').type('text/plain').send('A metrics token or an administrator\'s sign-in is needed.\n');
    return reply.header('cache-control', 'no-store').type('text/plain; version=0.0.4; charset=utf-8').send(await prometheusText());
  });

  app.post('/a/:alias/telemetry', { bodyLimit: 32 * 1024 }, async (req, reply) => {
    const { alias } = req.params as { alias: string };
    if (!instanceTelemetry().browser) return reply.code(404).send();
    let body = req.body as { t?: unknown; spans?: unknown } | string | undefined;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        return reply.code(400).send();
      }
    }
    const kept = relay(alias, (body as { t?: unknown })?.t, (body as { spans?: unknown })?.spans);
    if (kept === null) {
      count('pgkiln.telemetry.refused', { reason: 'browser token' });
      return reply.code(403).send();
    }
    return reply.code(204).send();
  });
}
