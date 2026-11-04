import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { owner, sharedRuntime } from '../db.ts';
import { scopeForWorkspace } from '../network-acl.ts';
import { signText } from '../security.ts';
import { webRequest } from '../webclient.ts';
import { VERSION } from '../release-check.ts';
import { anyOwnCollector, appOf, appIdOf, instanceTelemetry, onTelemetryConfig, refreshTelemetry, workspaceTelemetry, type InstanceTelemetry } from './config.ts';
import {
  BUCKETS, count, counters, histograms, meteringSince, now, outside, redactText, sanitizeSql, setSink,
  type Attr, type Attrs, type LogRecord, type Span, type Trace,
} from './trace.ts';

// (sprint 139, AP-6) Sending: a queue per destination (the instance's
// collector, "ws:<id>" for a workspace's own), sent as OTLP/HTTP JSON every
// few seconds or when a batch is full. A queue that can't keep up drops the
// oldest (counted in pgkiln.telemetry.dropped); a collector that is down
// costs a failed request per batch, never a request of a user. The instance's
// collector is the administrator's (any address, usually a Collector on the
// same network); a workspace's own goes through webclient.ts with the
// workspace's network access list and the installation's allow-list, like a
// workspace's mail service.

const BATCH = 512;
const MAX_QUEUE = 8192;
const FLUSH_MS = Number(process.env.OTEL_BSP_SCHEDULE_DELAY ?? 5000);
const TIMEOUT_MS = Number(process.env.OTEL_EXPORTER_OTLP_TIMEOUT ?? 10_000);

interface Destination {
  key: string;
  /** null: the instance's */
  workspaceId: number | null;
  values: boolean;
}

interface Queued {
  span: Span;
  trace: Trace;
  values: boolean;
}

export interface DestinationStatus {
  sent: number;
  dropped: number;
  lastOkAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
}

const spanQueues = new Map<string, Queued[]>();
const logQueues = new Map<string, { r: LogRecord; values: boolean }[]>();
const status = new Map<string, DestinationStatus>();
export const destinationStatus = (key: string): DestinationStatus =>
  status.get(key) ?? { sent: 0, dropped: 0, lastOkAt: null, lastError: null, lastErrorAt: null };

function note(key: string, ok: boolean, n: number, error?: string) {
  const s = { ...destinationStatus(key) };
  if (ok) {
    s.sent += n;
    s.lastOkAt = Date.now();
  } else {
    s.dropped += n;
    s.lastError = (error ?? 'failed').slice(0, 300);
    s.lastErrorAt = Date.now();
  }
  status.set(key, s);
}

/** Where a trace (or log) of an application goes. */
function destinations(appId: number | null | undefined, alias: string | undefined, signal: 'traces' | 'logs'): Destination[] {
  const t = instanceTelemetry();
  const id = appId ?? appIdOf(alias);
  const ws = workspaceTelemetry(appOf(id)?.[1]);
  if (ws?.mode === 'off') return [];
  const out: Destination[] = [];
  if (t.enabled && t[signal]) out.push({ key: 'instance', workspaceId: null, values: t.values });
  if (ws?.mode === 'own' && ws.endpoint) out.push({ key: `ws:${ws.id}`, workspaceId: ws.id, values: ws.values });
  return out;
}

function enqueue<T>(queues: Map<string, T[]>, key: string, items: T[]) {
  let q = queues.get(key);
  if (!q) queues.set(key, (q = []));
  q.push(...items);
  if (q.length > MAX_QUEUE) {
    const n = q.length - MAX_QUEUE;
    q.splice(0, n);
    note(key, false, n, 'queue full: the collector is slower than the server');
    count('pgkiln.telemetry.dropped', { destination: key }, n);
  }
  if (q.length >= BATCH) void flush();
}

function finish(t: Trace) {
  // a span with an error (a REST call answered 500) keeps its trace whatever the sample ratio
  if (!t.error && t.spans.some((s) => s.error !== undefined)) t.error = true;
  if (!t.sampled && !t.error) return;
  for (const d of destinations(t.appId, t.alias, 'traces'))
    enqueue(spanQueues, d.key, t.spans.filter((s) => s.end !== undefined).map((span) => ({ span, trace: t, values: d.values })));
  if (t.dropped) count('pgkiln.telemetry.dropped', { destination: 'spans per trace' }, t.dropped);
}

function late(t: Trace, s: Span) {
  if (!t.sampled && !t.error) return;
  for (const d of destinations(t.appId, t.alias, 'traces')) enqueue(spanQueues, d.key, [{ span: s, trace: t, values: d.values }]);
}

/** (src/telemetry/http.ts relay) spans a page reported, for its trace (sampled: the page only asks when it was). */
export function browserSpans(traceId: string, alias: string, spans: Span[]) {
  const t: Trace = { id: traceId, sampled: true, spans, dropped: 0, error: false, alias, ended: true };
  for (const s of spans) s.spanId = randomBytes(8).toString('hex');
  for (const d of destinations(undefined, alias, 'traces')) enqueue(spanQueues, d.key, spans.map((span) => ({ span, trace: t, values: d.values })));
}

function log(r: LogRecord) {
  for (const d of destinations(r.appId, undefined, 'logs')) enqueue(logQueues, d.key, [{ r, values: d.values }]);
}

/** May the trace's page send a browser span? Known once the application is (loadContext). */
async function app(t: Trace) {
  if (!instanceTelemetry().browser) return;
  if (appOf(t.appId) === undefined) await refreshTelemetry(true);
  t.browser = destinations(t.appId, t.alias, 'traces').length > 0;
}

// ---------------------------------------------------------------- OTLP JSON

const nanos = (ms: number) => (BigInt(Math.floor(ms)) * 1_000_000n + BigInt(Math.round((ms % 1) * 1e6))).toString();

function value(v: Attr) {
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  return { stringValue: v };
}
const attributes = (a: Attrs) => Object.entries(a).filter(([, v]) => v !== null && v !== undefined).map(([key, v]) => ({ key, value: value(v as Attr) }));

/** The enduser.id of a user name under the instance's rule. */
export function userAttr(user: string | null | undefined, mode = instanceTelemetry().user): string | null {
  if (!user || mode === 'none') return null;
  return mode === 'name' ? user : `u:${signText('otel-user', user.toLowerCase())}`;
}

function resource(t: InstanceTelemetry, workspaceId: number | null) {
  return {
    attributes: attributes({
      'service.name': t.serviceName,
      'service.version': VERSION,
      'service.instance.id': `${hostname()}:${process.pid}`,
      'host.name': hostname(),
      ...(workspaceId == null ? t.resource : { 'pgkiln.workspace.id': workspaceId }),
    }),
  };
}

const SCOPE = () => ({ name: 'pgkiln', version: VERSION });

/** One span as OTLP JSON for a destination with or without values. */
export function encodeSpan(q: Queued) {
  const s = q.span;
  const attrs: Attrs = { ...s.attrs };
  if (s.sql !== undefined) attrs['db.query.text'] = q.values ? s.sql.slice(0, 4000) : sanitizeSql(s.sql);
  if (q.values && s.vals) Object.assign(attrs, s.vals);
  if (s === q.trace.spans[0]) {
    const u = userAttr(q.trace.user);
    if (u) attrs['enduser.id'] = u;
    if (q.trace.dropped) attrs['pgkiln.spans_dropped'] = q.trace.dropped;
  }
  return {
    traceId: s.traceId,
    spanId: s.spanId,
    ...(s.parentId ? { parentSpanId: s.parentId } : {}),
    name: s.name,
    kind: s.kind,
    startTimeUnixNano: nanos(s.start),
    endTimeUnixNano: nanos(s.end ?? s.start),
    attributes: attributes(attrs),
    status: s.error !== undefined ? { code: 2, message: q.values ? s.error : redactText(s.error) } : { code: 0 },
  };
}

const SEVERITY = { INFO: 9, WARN: 13, ERROR: 17 } as const;

export function encodeLog(r: LogRecord, values: boolean) {
  const attrs: Attrs = { ...r.attrs };
  const u = userAttr(r.user);
  if (u) attrs['enduser.id'] = u;
  const detail = r.detail ? (values ? r.detail : redactText(r.detail)) : '';
  return {
    timeUnixNano: nanos(r.time),
    observedTimeUnixNano: nanos(r.time),
    severityNumber: SEVERITY[r.severity],
    severityText: r.severity,
    body: { stringValue: detail ? `${r.body}: ${detail}` : r.body },
    attributes: attributes(attrs),
    ...(r.traceId ? { traceId: r.traceId, spanId: r.spanId } : {}),
  };
}

// ---------------------------------------------------------------- sending

async function post(url: string, headers: Record<string, string>, workspaceId: number | null, body: string) {
  const h = { ...headers, 'content-type': 'application/json' };
  if (workspaceId == null) {
    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', headers: h, body, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' });
    } catch (e) {
      // fetch says "fetch failed"; the cause says why (ECONNREFUSED, a certificate, the timeout)
      const cause = (e as { cause?: { code?: string; message?: string } }).cause;
      throw new Error(cause?.code ?? cause?.message ?? (e as Error).message);
    }
    await res.arrayBuffer().catch(() => undefined);
    if (!res.ok) throw new Error(`the collector answered HTTP ${res.status}`);
    return;
  }
  const scope = await scopeForWorkspace(workspaceId, 'OpenTelemetry collector');
  if (!scope) throw new Error('the workspace is gone');
  const res = await webRequest(url, { method: 'POST', headers: h, body, scope, timeoutMs: TIMEOUT_MS, secretHeaders: Object.keys(headers).map((k) => k.toLowerCase()) });
  if (res.status < 200 || res.status >= 300) throw new Error(`the collector answered HTTP ${res.status}`);
}

function target(key: string, signal: 'traces' | 'logs' | 'metrics') {
  const t = instanceTelemetry();
  if (key === 'instance') return { url: t.urls[signal], headers: t.headers, workspaceId: null as number | null };
  const id = Number(key.slice(3));
  const ws = workspaceTelemetry(id);
  return ws?.endpoint ? { url: `${ws.endpoint.replace(/\/+$/, '')}/v1/${signal}`, headers: ws.headers, workspaceId: id } : null;
}

let flushing: Promise<void> | null = null;

/** Send what is queued (also on shutdown and in tests). */
export function flush(): Promise<void> {
  if (flushing) return flushing;
  // cleared after the assignment (the body may finish at once, before ??= would have stored it)
  flushing = outside(async () => {
    await Promise.resolve();
    try {
      const t = instanceTelemetry();
      for (const [key, q] of spanQueues) {
        while (q.length) {
          const batch = q.splice(0, BATCH);
          const to = target(key, 'traces');
          if (!to) continue;
          const body = JSON.stringify({ resourceSpans: [{ resource: resource(t, to.workspaceId), scopeSpans: [{ scope: SCOPE(), spans: batch.map(encodeSpan) }] }] });
          try {
            await post(to.url, to.headers, to.workspaceId, body);
            note(key, true, batch.length);
          } catch (e) {
            note(key, false, batch.length, (e as Error).message);
            count('pgkiln.telemetry.dropped', { destination: key }, batch.length);
          }
        }
      }
      for (const [key, q] of logQueues) {
        while (q.length) {
          const batch = q.splice(0, BATCH);
          const to = target(key, 'logs');
          if (!to) continue;
          const body = JSON.stringify({ resourceLogs: [{ resource: resource(t, to.workspaceId), scopeLogs: [{ scope: SCOPE(), logRecords: batch.map((x) => encodeLog(x.r, x.values)) }] }] });
          try {
            await post(to.url, to.headers, to.workspaceId, body);
            note(key, true, batch.length);
          } catch (e) {
            note(key, false, batch.length, (e as Error).message);
          }
        }
      }
    } finally {
      flushing = null;
    }
  });
  return flushing;
}

// ---------------------------------------------------------------- metrics

interface Gauge { name: string; labels: Record<string, string>; value: number; unit?: string }
let gaugeCache: { at: number; rows: Gauge[] } | null = null;

/** The levels read when metrics are collected: queues, workflows, connections, memory (cached 15 s). */
export async function gauges(): Promise<Gauge[]> {
  if (gaugeCache && Date.now() - gaugeCache.at < 15_000) return gaugeCache.rows;
  const rows: Gauge[] = [];
  await outside(async () => {
    try {
      const r = await owner.one<Record<string, number>>(`select
          (select count(*) from meta.mail_queue where status = 'queued')::int as mail_queued,
          (select count(*) from meta.mail_queue where status = 'error' and created_at > now() - interval '1 day')::int as mail_failed,
          (select count(*) from meta.process_job where state = 'queued')::int as jobs_queued,
          (select count(*) from meta.process_job where state = 'running')::int as jobs_running,
          (select count(*) from meta.workflow where state = 'active')::int as wf_active,
          (select count(*) from meta.workflow where state = 'waiting')::int as wf_waiting,
          (select count(*) from meta.workflow where state = 'faulted')::int as wf_faulted,
          (select count(*) from meta.ai_request where status in ('queued', 'running'))::int as ai_pending,
          (select count(*) from meta.embedding_queue)::int as embeddings`);
      if (r) {
        rows.push(
          { name: 'pgkiln.mail.queue', labels: { status: 'queued' }, value: r.mail_queued },
          { name: 'pgkiln.mail.queue', labels: { status: 'failed_1d' }, value: r.mail_failed },
          { name: 'pgkiln.jobs.queue', labels: { state: 'queued' }, value: r.jobs_queued },
          { name: 'pgkiln.jobs.queue', labels: { state: 'running' }, value: r.jobs_running },
          { name: 'pgkiln.workflows', labels: { state: 'active' }, value: r.wf_active },
          { name: 'pgkiln.workflows', labels: { state: 'waiting' }, value: r.wf_waiting },
          { name: 'pgkiln.workflows', labels: { state: 'faulted' }, value: r.wf_faulted },
          { name: 'pgkiln.ai.requests.pending', labels: {}, value: r.ai_pending },
          { name: 'pgkiln.embeddings.queue', labels: {}, value: r.embeddings },
        );
      }
    } catch {
      // the database is away: the other metrics still go out
    }
  });
  for (const [pool, db] of [['builder', owner], ['runtime', sharedRuntime]] as const) {
    rows.push(
      { name: 'pgkiln.db.pool.connections', labels: { pool, state: 'total' }, value: db.pool.totalCount },
      { name: 'pgkiln.db.pool.connections', labels: { pool, state: 'idle' }, value: db.pool.idleCount },
      { name: 'pgkiln.db.pool.connections', labels: { pool, state: 'waiting' }, value: db.pool.waitingCount },
    );
  }
  rows.push(
    { name: 'process.memory.rss', labels: {}, value: process.memoryUsage().rss, unit: 'By' },
    { name: 'process.uptime', labels: {}, value: Math.round(process.uptime()), unit: 's' },
  );
  gaugeCache = { at: Date.now(), rows };
  return rows;
}

/** Counters, histograms and gauges as an OTLP metrics request body. */
export async function metricsBody() {
  const t = instanceTelemetry();
  const at = nanos(now());
  const since = nanos(meteringSince);
  const by = new Map<string, unknown[]>();
  const push = (name: string, point: unknown) => by.set(name, [...(by.get(name) ?? []), point]);
  for (const c of counters.values()) push(c.name, { attributes: attributes(c.labels), startTimeUnixNano: since, timeUnixNano: at, asDouble: c.value });
  const metrics: unknown[] = [...by].map(([name, dataPoints]) => ({ name, sum: { dataPoints, aggregationTemporality: 2, isMonotonic: true } }));
  const hs = new Map<string, unknown[]>();
  for (const h of histograms.values()) {
    const over = h.count - h.buckets.reduce((a, b) => a + b, 0);
    hs.set(h.name, [...(hs.get(h.name) ?? []), {
      attributes: attributes(h.labels), startTimeUnixNano: since, timeUnixNano: at,
      count: String(h.count), sum: h.sum, bucketCounts: [...h.buckets, over].map(String), explicitBounds: BUCKETS,
    }]);
  }
  for (const [name, dataPoints] of hs) metrics.push({ name, unit: 'ms', histogram: { dataPoints, aggregationTemporality: 2 } });
  const gs = new Map<string, { unit?: string; points: unknown[] }>();
  for (const g of await gauges()) {
    const e = gs.get(g.name) ?? { unit: g.unit, points: [] };
    e.points.push({ attributes: attributes(g.labels), timeUnixNano: at, asDouble: g.value });
    gs.set(g.name, e);
  }
  for (const [name, e] of gs) metrics.push({ name, ...(e.unit ? { unit: e.unit } : {}), gauge: { dataPoints: e.points } });
  return { resourceMetrics: [{ resource: resource(t, null), scopeMetrics: [{ scope: SCOPE(), metrics }] }] };
}

export async function exportMetrics() {
  const t = instanceTelemetry();
  if (!t.enabled || !t.metrics) return;
  await outside(async () => {
    try {
      await post(t.urls.metrics, t.headers, null, JSON.stringify(await metricsBody()));
      note('instance', true, 1);
    } catch (e) {
      note('instance', false, 0, (e as Error).message);
    }
  });
}

const promName = (n: string) => n.replace(/[^a-zA-Z0-9_]/g, '_');
const promLabels = (l: Record<string, string>, extra = '') => {
  const parts = Object.entries(l).map(([k, v]) => `${promName(k)}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`);
  if (extra) parts.push(extra);
  return parts.length ? `{${parts.join(',')}}` : '';
};

/** The Prometheus text format (GET /metrics). */
export async function prometheusText(): Promise<string> {
  const lines: string[] = [];
  const typed = new Set<string>();
  const type = (name: string, kind: string) => {
    if (!typed.has(name)) lines.push(`# TYPE ${name} ${kind}`), typed.add(name);
  };
  for (const c of [...counters.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const n = `${promName(c.name)}_total`;
    type(n, 'counter');
    lines.push(`${n}${promLabels(c.labels)} ${c.value}`);
  }
  for (const h of [...histograms.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const n = `${promName(h.name)}_milliseconds`;
    type(n, 'histogram');
    let cum = 0;
    BUCKETS.forEach((b, i) => {
      cum += h.buckets[i];
      lines.push(`${n}_bucket${promLabels(h.labels, `le="${b}"`)} ${cum}`);
    });
    lines.push(`${n}_bucket${promLabels(h.labels, 'le="+Inf"')} ${h.count}`, `${n}_sum${promLabels(h.labels)} ${h.sum}`, `${n}_count${promLabels(h.labels)} ${h.count}`);
  }
  for (const g of await gauges()) {
    const n = promName(g.name) + (g.unit === 'By' ? '_bytes' : g.unit === 's' ? '_seconds' : '');
    type(n, 'gauge');
    lines.push(`${n}${promLabels(g.labels)} ${g.value}`);
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------- start

let flushTimer: NodeJS.Timeout | null = null;
let metricsTimer: NodeJS.Timeout | null = null;
let metricsEvery = 0;

function timers() {
  const t = instanceTelemetry();
  if (!flushTimer) {
    flushTimer = setInterval(() => void flush(), FLUSH_MS);
    flushTimer.unref();
  }
  const want = t.enabled && t.metrics ? t.intervalMs : 0;
  if (want !== metricsEvery) {
    if (metricsTimer) clearInterval(metricsTimer);
    metricsTimer = null;
    metricsEvery = want;
    if (want) {
      metricsTimer = setInterval(() => void exportMetrics(), want);
      metricsTimer.unref();
    }
  }
}

/** Plug the exporter in (src/app.ts); the settings are read at once and every 30 s. */
export async function startTelemetry() {
  setSink({
    tracing: () => {
      const t = instanceTelemetry();
      return (t.enabled && t.traces) || anyOwnCollector();
    },
    metering: () => {
      const t = instanceTelemetry();
      return (t.enabled && t.metrics) || t.prometheus;
    },
    logging: () => {
      const t = instanceTelemetry();
      return (t.enabled && t.logs) || anyOwnCollector();
    },
    finish,
    late,
    log,
    app,
  });
  onTelemetryConfig(timers);
  await refreshTelemetry(true);
}

/** Stop the timers and send what is left (tests, shutdown). */
export async function stopTelemetry() {
  if (flushTimer) clearInterval(flushTimer);
  if (metricsTimer) clearInterval(metricsTimer);
  flushTimer = metricsTimer = null;
  metricsEvery = 0;
  await flush();
}

/** (the builder's Send a test span) One span to a collector now: null when it took it, else the problem. */
export async function sendTest(workspaceId: number | null): Promise<string | null> {
  const key = workspaceId == null ? 'instance' : `ws:${workspaceId}`;
  await refreshTelemetry(true);
  if (workspaceId == null && !instanceTelemetry().endpoint) return 'No collector URL is set.';
  const to = target(key, 'traces');
  if (!to) return 'No collector URL is set.';
  const end = now();
  const span: Span = { traceId: randomBytes(16).toString('hex'), spanId: randomBytes(8).toString('hex'), name: 'pgkiln test span', kind: 1, start: end - 1, end, attrs: { 'pgkiln.test': true } };
  const trace: Trace = { id: span.traceId, sampled: true, spans: [span], dropped: 0, error: false, ended: true };
  const body = JSON.stringify({ resourceSpans: [{ resource: resource(instanceTelemetry(), to.workspaceId), scopeSpans: [{ scope: SCOPE(), spans: [encodeSpan({ span, trace, values: false })] }] }] });
  try {
    await outside(() => post(to.url, to.headers, to.workspaceId, body));
    note(key, true, 1);
    return null;
  } catch (e) {
    const m = (e as Error & { cause?: Error }).cause?.message ?? (e as Error).message;
    note(key, false, 1, m);
    return m;
  }
}
