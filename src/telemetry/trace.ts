import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

// (sprint 139, AP-6) Traces, logs and metrics for OpenTelemetry, without the
// OpenTelemetry SDK: this file keeps the current trace of an async call chain
// (AsyncLocalStorage), makes spans, and counts metrics. src/telemetry/export.ts
// decides where a finished trace goes (the instance's collector, a workspace's
// own) and sends it as OTLP/HTTP JSON; src/telemetry/http.ts starts a trace per
// request.
//
// A trace's spans are kept in memory until its root span ends, so the decision
// what to send is made once per trace, with everything known: the application
// (its workspace's setting), whether something failed (failed traces are always
// sent, whatever the sample ratio). Values (SQL statements with their literals,
// bind values, query strings, item values) are kept apart from the other
// attributes and only encoded for a destination that asked for them.
//
// Nothing here runs when no destination is configured: without a current trace
// a span helper just calls its function.

export type Attr = string | number | boolean;
export type Attrs = Record<string, Attr | null | undefined>;

export const SPAN_KIND = { internal: 1, server: 2, client: 3 } as const;

export interface Span {
  traceId: string;
  spanId: string;
  parentId?: string;
  name: string;
  kind: number;
  /** epoch milliseconds (fractions kept) */
  start: number;
  end?: number;
  attrs: Attrs;
  /** attributes that carry values: only sent where values are included */
  vals?: Attrs;
  /** a SQL statement as run: sent as is with values, with its literals replaced by ? otherwise */
  sql?: string;
  error?: string;
}

export interface Trace {
  id: string;
  /** the head sampling decision (a trace with an error is sent anyway) */
  sampled: boolean;
  spans: Span[];
  dropped: number;
  error: boolean;
  /** the application the trace is about (the URL's alias, then loadContext's id) */
  appId?: number;
  alias?: string;
  user?: string;
  ended: boolean;
  /** (src/telemetry/export.ts) decided when the application is known: a browser span may follow */
  browser?: boolean;
}

export interface Ctx {
  trace: Trace;
  span: Span;
}

export interface LogRecord {
  time: number;
  severity: 'INFO' | 'WARN' | 'ERROR';
  body: string;
  attrs: Attrs;
  /** the detail (an error message): values in it are hidden unless the destination includes values */
  detail?: string;
  appId?: number | null;
  user?: string | null;
  traceId?: string;
  spanId?: string;
}

/** What src/telemetry/export.ts plugs in. */
export interface Sink {
  /** a destination for traces exists (cached, synchronous) */
  tracing(): boolean;
  /** metrics are kept (OTLP metrics or /metrics) */
  metering(): boolean;
  /** a destination for logs exists */
  logging(): boolean;
  /** a root span ended */
  finish(t: Trace): void;
  /** a span that ended after its trace was sent (a late child) */
  late(t: Trace, s: Span): void;
  log(r: LogRecord): void;
  /** the trace's application became known (browser spans) */
  app(t: Trace): void | Promise<void>;
}

const NONE: Sink = {
  tracing: () => false,
  metering: () => false,
  logging: () => false,
  finish() {},
  late() {},
  log() {},
  app() {},
};
let sink: Sink = NONE;
export const setSink = (s: Sink | null) => (sink = s ?? NONE);
export const tracingOn = () => sink.tracing();
export const meteringOn = () => sink.metering();

/** At most this many spans per trace (a loop of SQL statements): the rest are counted, not kept. */
export const MAX_SPANS = 1000;
const MAX_TEXT = 4000;

const als = new AsyncLocalStorage<Ctx>();
export const currentCtx = () => als.getStore();
/** Run fn with ctx as the current trace (Fastify hooks: als.run with their done callback). */
export const runIn = <T>(ctx: Ctx, fn: () => T) => als.run(ctx, fn);
/** Run fn outside any trace (the exporter's own work must not trace itself). */
export const outside = <T>(fn: () => T): T => als.exit(fn);

export const now = () => performance.timeOrigin + performance.now();
const hex = (bytes: number) => randomBytes(bytes).toString('hex');

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** An incoming W3C traceparent header: the caller's trace id, its span and whether it sampled. */
export function parseTraceparent(v: unknown): { traceId: string; spanId: string; sampled: boolean } | null {
  const m = typeof v === 'string' ? TRACEPARENT.exec(v.trim().toLowerCase()) : null;
  if (!m || /^0+$/.test(m[1]) || /^0+$/.test(m[2])) return null;
  return { traceId: m[1], spanId: m[2], sampled: (parseInt(m[3], 16) & 1) === 1 };
}

let sampleRatio = 1;
/** The head sampling ratio (0 … 1) for traces that start here. */
export const setSampleRatio = (r: number) => (sampleRatio = Number.isFinite(r) ? Math.min(Math.max(r, 0), 1) : 1);

/** Start a trace (a request, a background job). Null when no destination wants traces. */
export function startTrace(name: string, kind: number, attrs: Attrs = {}, parent?: string | null): Ctx | null {
  if (!sink.tracing()) return null;
  const remote = parseTraceparent(parent);
  const trace: Trace = {
    id: remote?.traceId ?? hex(16),
    sampled: remote ? remote.sampled : Math.random() < sampleRatio,
    spans: [],
    dropped: 0,
    error: false,
    ended: false,
  };
  const span: Span = { traceId: trace.id, spanId: hex(8), parentId: remote?.spanId, name, kind, start: now(), attrs: { ...attrs } };
  trace.spans.push(span);
  return { trace, span };
}

/** End a trace's root span and hand the trace over. */
export function endTrace(ctx: Ctx, attrs: Attrs = {}, error?: string) {
  if (ctx.trace.ended) return;
  Object.assign(ctx.span.attrs, attrs);
  if (error) fail(ctx, error);
  ctx.span.end = now();
  ctx.trace.ended = true;
  sink.finish(ctx.trace);
}

function fail(ctx: Ctx, message: string) {
  ctx.span.error = message.slice(0, 500);
  ctx.trace.error = true;
}

function child(ctx: Ctx, name: string, kind: number, attrs: Attrs, start = now()): Ctx {
  const span: Span = { traceId: ctx.trace.id, spanId: hex(8), parentId: ctx.span.spanId, name, kind, start, attrs: { ...attrs } };
  if (ctx.trace.spans.length < MAX_SPANS) ctx.trace.spans.push(span);
  else ctx.trace.dropped++;
  return { trace: ctx.trace, span };
}

function close(ctx: Ctx, error?: unknown) {
  ctx.span.end ??= now();
  if (error !== undefined) fail(ctx, error instanceof Error ? error.message : String(error));
  // a child that ends after its trace was handed over (fire-and-forget work) goes on its own
  if (ctx.trace.ended && ctx.trace.spans.includes(ctx.span)) sink.late(ctx.trace, ctx.span);
}

/** Run fn in a child span of the current trace (just fn when there is none). An exception marks the span. */
export async function withSpan<T>(name: string, attrs: Attrs, fn: (span: Span | null) => Promise<T>, kind: number = SPAN_KIND.internal): Promise<T> {
  const ctx = als.getStore();
  if (!ctx) return fn(null);
  const c = child(ctx, name, kind, attrs);
  try {
    const result = await als.run(c, () => fn(c.span));
    close(c);
    return result;
  } catch (e) {
    close(c, e);
    throw e;
  }
}

/** A span of the current trace, or (background work) the root of a trace of its own. */
export async function rootSpan<T>(name: string, attrs: Attrs, fn: (span: Span | null) => Promise<T>): Promise<T> {
  if (als.getStore()) return withSpan(name, attrs, fn);
  const ctx = startTrace(name, SPAN_KIND.internal, attrs);
  if (!ctx) return fn(null);
  try {
    const result = await als.run(ctx, () => fn(ctx.span));
    endTrace(ctx);
    return result;
  } catch (e) {
    endTrace(ctx, {}, e instanceof Error ? e.message : String(e));
    throw e;
  }
}

/** A span that already happened (an AI call timed by its caller), as a child of the current span. */
export function recordSpan(name: string, o: { ms: number; attrs?: Attrs; vals?: Attrs; error?: string | null; kind?: number }) {
  const ctx = als.getStore();
  if (!ctx) return;
  const end = now();
  const c = child(ctx, name, o.kind ?? SPAN_KIND.client, o.attrs ?? {}, end - Math.max(o.ms, 0));
  if (o.vals) c.span.vals = { ...o.vals };
  c.span.end = end;
  close(c, o.error ?? undefined);
}

/** Add attributes (and value attributes) to the current span. */
export function setAttrs(attrs: Attrs, vals?: Attrs) {
  const ctx = als.getStore();
  if (!ctx) return;
  Object.assign(ctx.span.attrs, attrs);
  if (vals) ctx.span.vals = { ...ctx.span.vals, ...vals };
}

/** Mark the current span as failed (an error handled without an exception: an HTTP 5xx). */
export function markError(message: string) {
  const ctx = als.getStore();
  if (ctx) fail(ctx, message);
}

/** The application of the current trace (its workspace decides where the trace goes) and the page's user. */
export function traceApp(a: { appId: number; alias?: string; page?: number | string; user?: string }) {
  const ctx = als.getStore();
  if (!ctx) return;
  const t = ctx.trace;
  t.appId = a.appId;
  if (a.alias) t.alias = a.alias;
  if (a.user) t.user = a.user;
  const root = t.spans[0];
  if (root) {
    root.attrs['pgkiln.app.id'] = a.appId;
    if (a.alias) root.attrs['pgkiln.app.alias'] = a.alias;
    if (a.page !== undefined) root.attrs['pgkiln.page'] = String(a.page);
  }
  return sink.app(t);
}

/** The traceparent header for an outgoing request made in the current span. */
export function traceparent(): string | null {
  const ctx = als.getStore();
  return ctx ? `00-${ctx.trace.id}-${ctx.span.spanId}-${ctx.trace.sampled || ctx.trace.error ? '01' : '00'}` : null;
}

/** A log record, tied to the current span when there is one. */
export function emitLog(r: Omit<LogRecord, 'time' | 'traceId' | 'spanId'>) {
  if (!sink.logging()) return;
  const ctx = als.getStore();
  sink.log({ ...r, time: now(), traceId: ctx?.trace.id, spanId: ctx?.span.spanId });
}

// ---------------------------------------------------------------- values kept out

/**
 * A SQL statement without its values: string literals (also E'' and U&''),
 * dollar-quoted strings that aren't function bodies, and numbers become ?.
 * Comments go. Identifiers in double quotes stay.
 */
export function sanitizeSql(sql: string): string {
  let out = '';
  let i = 0;
  const n = Math.min(sql.length, 20_000);
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      out += ' ';
      continue;
    }
    if (ch === '"') {
      const end = sql.indexOf('"', i + 1);
      const stop = end < 0 ? n : end + 1;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "'" || ((ch === 'E' || ch === 'e') && next === "'" && !/[\w$]/.test(sql[i - 1] ?? ''))) {
      i += ch === "'" ? 1 : 2;
      const escapes = ch !== "'";
      while (i < n) {
        if (escapes && sql[i] === '\\') i += 2;
        else if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") break;
        else i++;
      }
      i++;
      out += '?';
      continue;
    }
    if (ch === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 70));
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length);
        const stop = end < 0 ? n : end + m[0].length;
        // a function body (create function … as $$ … $$, do $$ … $$) is code, not a value
        const before = out.slice(-40).toLowerCase();
        out += /\b(as|do)\s*$/.test(before) ? sql.slice(i, stop) : '?';
        i = stop;
        continue;
      }
      if (/\d/.test(next ?? '')) {
        // a parameter ($1)
        let j = i + 1;
        while (j < n && /\d/.test(sql[j])) j++;
        out += sql.slice(i, j);
        i = j;
        continue;
      }
    }
    if (/\d/.test(ch) && !/[\w$.]/.test(sql[i - 1] ?? '')) {
      let j = i;
      while (j < n && /[\d.eE_]/.test(sql[j])) j++;
      out += '?';
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

/** A message without the values it may quote: 'strings', Key (col)=(value), e-mail addresses, long numbers. */
export function redactText(s: string): string {
  return s
    .replace(/'(?:[^']|'')*'/g, "'?'")
    .replace(/=\((?:[^()]|\([^()]*\))*\)/g, '=(?)')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '?@?')
    .replace(/\b\d{4,}\b/g, '?')
    .slice(0, MAX_TEXT);
}

// ---------------------------------------------------------------- SQL statements as spans

const TX_CONTROL = /^\s*(begin|commit|rollback|savepoint|release|start\s+transaction|end)\b/i;

function operation(sql: string) {
  const m = /^\s*(?:\/\*[\s\S]*?\*\/\s*|--[^\n]*\n\s*)*([a-z]+)/i.exec(sql);
  return (m?.[1] ?? 'SQL').toUpperCase();
}

/**
 * Every statement on any pg client becomes a span of the current trace (pools
 * call Client#query too). Transaction control is left out; cursors and COPY
 * (submittables) are left alone. Without a current trace nothing changes.
 */
function patchPg() {
  const proto = pg.Client.prototype as unknown as { query: (...a: unknown[]) => unknown; __pgkilnTraced?: boolean };
  if (proto.__pgkilnTraced) return;
  proto.__pgkilnTraced = true;
  const original = proto.query;
  proto.query = function (this: pg.Client & { connectionParameters?: { host?: string; port?: number; database?: string } }, ...args: unknown[]) {
    const ctx = als.getStore();
    const [config, values, cb] = args as [unknown, unknown, unknown];
    const text = typeof config === 'string' ? config : (config as { text?: unknown } | null)?.text;
    if (!ctx || typeof text !== 'string' || TX_CONTROL.test(text) || typeof (config as { submit?: unknown })?.submit === 'function' || typeof (config as { callback?: unknown })?.callback === 'function')
      return original.apply(this, args);
    const op = operation(text);
    const p = this.connectionParameters;
    const c = child(ctx, op, SPAN_KIND.client, {
      'db.system.name': 'postgresql',
      'db.operation.name': op,
      'db.namespace': p?.database ?? null,
      'server.address': p?.host ?? null,
      'server.port': p?.port ?? null,
    });
    c.span.sql = text.slice(0, 20_000);
    const params = Array.isArray(values) ? values : (config as { values?: unknown })?.values;
    if (Array.isArray(params) && params.length)
      c.span.vals = Object.fromEntries(params.slice(0, 50).map((v, i) => [`db.query.parameter.${i + 1}`, v === null || v === undefined ? 'null' : String(typeof v === 'object' && !Buffer.isBuffer(v) ? JSON.stringify(v) : v).slice(0, 500)]));
    const finish = (err: unknown, res?: { rowCount?: number | null }) => {
      if (res && typeof res.rowCount === 'number') c.span.attrs['db.response.returned_rows'] = res.rowCount;
      if (err) {
        const code = (err as { code?: string }).code;
        if (code) c.span.attrs['db.response.status_code'] = code;
        c.span.attrs['error.type'] = code ?? 'error';
      }
      close(c, err ? err : undefined);
    };
    const callback = typeof values === 'function' ? values : typeof cb === 'function' ? cb : null;
    if (callback) {
      const wrapped = (err: unknown, res: unknown) => {
        finish(err, res as { rowCount?: number });
        (callback as (e: unknown, r: unknown) => void)(err, res);
      };
      return typeof values === 'function' ? original.call(this, config, wrapped) : original.call(this, config, values, wrapped);
    }
    const result = original.apply(this, args) as Promise<{ rowCount?: number }> | undefined;
    result?.then?.((r) => finish(null, r), (e) => finish(e));
    return result;
  };
}
patchPg();

// ---------------------------------------------------------------- metrics

export type Labels = Record<string, string>;
interface Counter { name: string; labels: Labels; value: number }
interface Histogram { name: string; labels: Labels; count: number; sum: number; buckets: number[] }

/** Request durations (ms): the histogram's upper bounds. */
export const BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const MAX_SERIES = 5000;

export const counters = new Map<string, Counter>();
export const histograms = new Map<string, Histogram>();
/** When the counters started (OTLP cumulative sums need it). */
export const meteringSince = now();

const key = (name: string, labels: Labels) => `${name}${JSON.stringify(Object.entries(labels).sort())}`;

/** Add to a counter (when metrics are kept). */
export function count(name: string, labels: Labels, n = 1) {
  if (!sink.metering() || !(n > 0)) return;
  const k = key(name, labels);
  const c = counters.get(k);
  if (c) c.value += n;
  else if (counters.size < MAX_SERIES) counters.set(k, { name, labels, value: n });
}

/** Add a duration (ms) to a histogram (when metrics are kept). */
export function observe(name: string, labels: Labels, ms: number) {
  if (!sink.metering() || !Number.isFinite(ms)) return;
  const k = key(name, labels);
  let h = histograms.get(k);
  if (!h) {
    if (histograms.size >= MAX_SERIES) return;
    h = { name, labels, count: 0, sum: 0, buckets: BUCKETS.map(() => 0) };
    histograms.set(k, h);
  }
  h.count++;
  h.sum += ms;
  const i = BUCKETS.findIndex((b) => ms <= b);
  if (i >= 0) h.buckets[i]++;
}
