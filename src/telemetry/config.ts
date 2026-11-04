import { owner } from '../db.ts';
import { decryptSecret, encryptSecret } from '../secrets.ts';
import { hashToken } from '../security.ts';
import { outside, setSampleRatio } from './trace.ts';

// (sprint 139, AP-6) Where telemetry goes. The instance's collector is set on
// Workspace utilities → OpenTelemetry (meta.setting otel_*), else by the
// standard OTEL_* environment variables; each workspace may switch its
// applications off or add a collector of its own (meta.workspace.telemetry*,
// migration 139). Read every 30 seconds like the other instance settings.

export type UserMode = 'hashed' | 'name' | 'none';
export type Origin = 'builder' | 'environment' | 'default';

export interface InstanceTelemetry {
  enabled: boolean;
  /** the OTLP/HTTP base URL (…:4318); per-signal URLs below */
  endpoint: string;
  urls: { traces: string; logs: string; metrics: string };
  headers: Record<string, string>;
  /** header names only (the page never shows the values) */
  headerNames: string[];
  serviceName: string;
  resource: Record<string, string>;
  sample: number;
  user: UserMode;
  values: boolean;
  traces: boolean;
  logs: boolean;
  metrics: boolean;
  /** builder requests are traced too (applications only by default) */
  builder: boolean;
  /** pages send a span per page load and Ajax call (relayed by pgkiln) */
  browser: boolean;
  /** GET /metrics in the Prometheus format */
  prometheus: boolean;
  prometheusTokenHash: string | null;
  intervalMs: number;
  /** OTEL_EXPORTER_OTLP_PROTOCOL asks for something other than http/json */
  protocolWarning: string | null;
  origin: Record<string, Origin>;
}

export type WorkspaceMode = 'instance' | 'off' | 'own';

export interface WorkspaceTelemetry {
  id: number;
  mode: WorkspaceMode;
  endpoint: string | null;
  headers: Record<string, string>;
  values: boolean;
}

/** The builder's keys in meta.setting. */
export const KEYS = ['otel_enabled', 'otel_endpoint', 'otel_headers_enc', 'otel_service_name', 'otel_sample', 'otel_user', 'otel_values',
  'otel_traces', 'otel_logs', 'otel_metrics', 'otel_builder', 'otel_browser', 'metrics_endpoint', 'metrics_token_hash'] as const;
type Key = (typeof KEYS)[number];

const REFRESH_MS = 30_000;
let stored = new Map<string, string>();
let workspaces = new Map<number, WorkspaceTelemetry>();
/** application id → [alias, workspace id] */
let apps = new Map<number, [string, number | null]>();
let aliases = new Map<string, number>();
let loadedAt = 0;
let loading: Promise<void> | null = null;
let current: InstanceTelemetry | null = null;
let listeners: (() => void)[] = [];
/** Called after every reload (src/telemetry/export.ts: timers). */
export const onTelemetryConfig = (fn: () => void) => listeners.push(fn);

const env = (name: string) => {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? undefined : v.trim();
};
const bool = (v: string | undefined) => (v === undefined ? undefined : /^(true|on|1|yes)$/i.test(v) ? true : /^(false|off|0|no)$/i.test(v) ? false : undefined);

/** "k=v,k2=v2" (OTEL_EXPORTER_OTLP_HEADERS, OTEL_RESOURCE_ATTRIBUTES): values URL-decoded. */
export function parsePairs(s: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (s ?? '').split(/[,\n]/)) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    let v = part.slice(i + 1).trim();
    try {
      v = decodeURIComponent(v);
    } catch {
      // kept as written
    }
    if (/^[A-Za-z0-9._-]{1,100}$/.test(k) && v.length <= 4000 && !/[\r\n]/.test(v)) out[k] = v;
  }
  return out;
}

/** An OTLP/HTTP URL: http or https, no fragment. Null when fine, else the problem. */
export function endpointProblem(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'not a URL';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'only http and https';
  if (u.hash) return 'no fragment (#) in the URL';
  if (u.username || u.password) return 'no user name or password in the URL (use a header)';
  return null;
}

/** The signal's URL: the base with /v1/<signal> appended (OTLP/HTTP's rule for OTEL_EXPORTER_OTLP_ENDPOINT). */
export const signalUrl = (base: string, signal: 'traces' | 'logs' | 'metrics') => `${base.replace(/\/+$/, '')}/v1/${signal}`;

function sampleFromEnv(): number | undefined {
  const sampler = env('OTEL_TRACES_SAMPLER')?.toLowerCase();
  if (sampler === 'always_off' || sampler === 'parentbased_always_off') return 0;
  if (sampler === 'always_on' || sampler === 'parentbased_always_on') return 1;
  const arg = Number(env('OTEL_TRACES_SAMPLER_ARG'));
  return sampler?.includes('traceidratio') && arg >= 0 && arg <= 1 ? arg : undefined;
}

function build(): InstanceTelemetry {
  const origin: Record<string, Origin> = {};
  const pick = <T>(key: Key, fromStore: (v: string) => T | undefined, fromEnv: T | undefined, dflt: T): T => {
    const s = stored.get(key);
    const v = s === undefined ? undefined : fromStore(s);
    if (v !== undefined) return (origin[key] = 'builder'), v;
    if (fromEnv !== undefined) return (origin[key] = 'environment'), fromEnv;
    origin[key] = 'default';
    return dflt;
  };
  const envEndpoint = env('OTEL_EXPORTER_OTLP_ENDPOINT');
  const endpoint = pick('otel_endpoint', (v) => (endpointProblem(v) ? undefined : v), envEndpoint && !endpointProblem(envEndpoint) ? envEndpoint : undefined, '');
  const disabled = bool(env('OTEL_SDK_DISABLED')) === true;
  const enabled = !disabled && !!endpoint && pick('otel_enabled', bool, envEndpoint ? true : undefined, false);
  let headers: Record<string, string> = {};
  const enc = stored.get('otel_headers_enc');
  if (enc) {
    try {
      headers = parsePairs(decryptSecret(enc));
      origin.otel_headers_enc = 'builder';
    } catch {
      origin.otel_headers_enc = 'builder';
    }
  } else if (env('OTEL_EXPORTER_OTLP_HEADERS')) {
    headers = parsePairs(env('OTEL_EXPORTER_OTLP_HEADERS'));
    origin.otel_headers_enc = 'environment';
  } else origin.otel_headers_enc = 'default';
  const notNone = (name: string) => (env(name)?.toLowerCase() === 'none' ? false : undefined);
  const protocol = env('OTEL_EXPORTER_OTLP_PROTOCOL');
  const t: InstanceTelemetry = {
    enabled,
    endpoint,
    urls: {
      traces: env('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT') && origin.otel_endpoint !== 'builder' ? env('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT')! : signalUrl(endpoint, 'traces'),
      logs: env('OTEL_EXPORTER_OTLP_LOGS_ENDPOINT') && origin.otel_endpoint !== 'builder' ? env('OTEL_EXPORTER_OTLP_LOGS_ENDPOINT')! : signalUrl(endpoint, 'logs'),
      metrics: env('OTEL_EXPORTER_OTLP_METRICS_ENDPOINT') && origin.otel_endpoint !== 'builder' ? env('OTEL_EXPORTER_OTLP_METRICS_ENDPOINT')! : signalUrl(endpoint, 'metrics'),
    },
    headers,
    headerNames: Object.keys(headers),
    serviceName: pick('otel_service_name', (v) => (/^[\w .:/-]{1,100}$/.test(v) ? v : undefined), env('OTEL_SERVICE_NAME'), 'pgkiln'),
    resource: parsePairs(env('OTEL_RESOURCE_ATTRIBUTES')),
    sample: pick('otel_sample', (v) => (Number(v) >= 0 && Number(v) <= 1 ? Number(v) : undefined), sampleFromEnv(), 1),
    user: pick('otel_user', (v) => (['hashed', 'name', 'none'].includes(v) ? (v as UserMode) : undefined), undefined, 'hashed'),
    values: pick('otel_values', bool, undefined, false),
    traces: pick('otel_traces', bool, notNone('OTEL_TRACES_EXPORTER'), true),
    logs: pick('otel_logs', bool, notNone('OTEL_LOGS_EXPORTER'), true),
    metrics: pick('otel_metrics', bool, notNone('OTEL_METRICS_EXPORTER'), true),
    builder: pick('otel_builder', bool, undefined, false),
    browser: pick('otel_browser', bool, undefined, false),
    prometheus: pick('metrics_endpoint', bool, bool(env('PGKILN_METRICS')), false),
    prometheusTokenHash: stored.get('metrics_token_hash') ?? (env('PGKILN_METRICS_TOKEN') ? hashToken(env('PGKILN_METRICS_TOKEN')!) : null),
    intervalMs: Math.min(Math.max(Number(env('OTEL_METRIC_EXPORT_INTERVAL') ?? 60_000) || 60_000, 5_000), 3_600_000),
    protocolWarning: protocol && protocol !== 'http/json'
      ? `OTEL_EXPORTER_OTLP_PROTOCOL is ${protocol}: pgkiln sends OTLP over HTTP as JSON (http/json), which every OpenTelemetry Collector accepts on port 4318.`
      : null,
    origin,
  };
  return t;
}

/** Read the settings, workspaces and applications again when older than 30 s (or at once). */
export async function refreshTelemetry(force = false) {
  if (!force && Date.now() - loadedAt < REFRESH_MS) return;
  loading ??= outside(async () => {
    await Promise.resolve();
    try {
      const [s, w, a] = await Promise.all([
        owner.query<{ name: string; value: string }>('select name, value from meta.setting where name = any($1)', [KEYS]),
        owner.query<{ id: number; telemetry: WorkspaceMode; telemetry_endpoint: string | null; telemetry_headers_enc: string | null; telemetry_values: boolean }>(
          `select id, telemetry, telemetry_endpoint, telemetry_headers_enc, telemetry_values from meta.workspace where telemetry <> 'instance'`),
        owner.query<{ id: number; alias: string; ws: number | null }>('select a.id, a.alias, meta.app_workspace(a.id) as ws from meta.app a'),
      ]);
      stored = new Map(s.rows.map((x) => [x.name, x.value]));
      workspaces = new Map(w.rows.map((x) => {
        let headers: Record<string, string> = {};
        try {
          headers = x.telemetry_headers_enc ? parsePairs(decryptSecret(x.telemetry_headers_enc)) : {};
        } catch {
          // an unreadable secret: sent without it (the page says so)
        }
        return [x.id, { id: x.id, mode: x.telemetry, endpoint: x.telemetry_endpoint, headers, values: x.telemetry_values }];
      }));
      apps = new Map(a.rows.map((x) => [x.id, [x.alias, x.ws]]));
      aliases = new Map(a.rows.map((x) => [x.alias.toLowerCase(), x.id]));
    } catch {
      // an older database (no columns yet) or none at all: keep what we had
    } finally {
      loadedAt = Date.now();
      current = build();
      setSampleRatio(current.sample);
      for (const fn of listeners) fn();
      loading = null;
    }
  });
  await loading;
}

/** The instance's settings in effect (synchronous; refreshed in the background). */
export function instanceTelemetry(): InstanceTelemetry {
  if (Date.now() - loadedAt >= REFRESH_MS) void refreshTelemetry();
  return (current ??= build());
}

/** A workspace's own setting (instance mode when it has none). */
export const workspaceTelemetry = (id: number | null | undefined): WorkspaceTelemetry | null => (id == null ? null : workspaces.get(id) ?? null);
/** Some workspace sends to a collector of its own. */
export const anyOwnCollector = () => [...workspaces.values()].some((w) => w.mode === 'own' && !!w.endpoint);
export const appOf = (id: number | null | undefined) => (id == null ? undefined : apps.get(id));
export const appIdOf = (alias: string | undefined) => (alias ? aliases.get(alias.toLowerCase()) : undefined);

// ---------------------------------------------------------------- saving (the builder)

export interface InstanceForm {
  enabled?: string;
  endpoint?: string;
  headers?: string;
  remove_headers?: string;
  service_name?: string;
  sample?: string;
  user?: string;
  values?: string;
  traces?: string;
  logs?: string;
  metrics?: string;
  builder?: string;
  browser?: string;
  prometheus?: string;
}

/** Save the instance's settings. Returns a problem, or null. Empty text fields go back to the environment or default. */
export async function saveInstanceTelemetry(f: InstanceForm): Promise<string | null> {
  const endpoint = (f.endpoint ?? '').trim();
  if (endpoint && endpointProblem(endpoint)) return `Collector URL: ${endpointProblem(endpoint)}.`;
  if (f.enabled === 'true' && !endpoint && !instanceTelemetry().endpoint) return 'Give the collector\'s URL to switch exporting on.';
  const serviceName = (f.service_name ?? '').trim();
  if (serviceName && !/^[\w .:/-]{1,100}$/.test(serviceName)) return 'Service name: letters, digits, spaces and . _ : / - (at most 100).';
  const sample = (f.sample ?? '').trim();
  if (sample && !(Number(sample) >= 0 && Number(sample) <= 1)) return 'Sample ratio: a number from 0 to 1.';
  const user = f.user ?? 'hashed';
  if (!['hashed', 'name', 'none'].includes(user)) return 'Unknown choice for the user.';
  const headers = (f.headers ?? '').trim();
  if (headers && !Object.keys(parsePairs(headers)).length) return 'Headers: name=value, one per line or comma separated.';
  const yes = (v: string | undefined) => (v === 'true' ? 'true' : 'false');
  const writes: [Key, string | null][] = [
    ['otel_enabled', yes(f.enabled)],
    ['otel_endpoint', endpoint || null],
    ['otel_service_name', serviceName || null],
    ['otel_sample', sample ? String(Number(sample)) : null],
    ['otel_user', user],
    ['otel_values', yes(f.values)],
    ['otel_traces', yes(f.traces)],
    ['otel_logs', yes(f.logs)],
    ['otel_metrics', yes(f.metrics)],
    ['otel_builder', yes(f.builder)],
    ['otel_browser', yes(f.browser)],
    ['metrics_endpoint', yes(f.prometheus)],
  ];
  if (headers) writes.push(['otel_headers_enc', encryptSecret(headers)]);
  else if (f.remove_headers === 'true') writes.push(['otel_headers_enc', null]);
  await owner.tx(async (c) => {
    for (const [k, v] of writes) {
      if (v === null) await c.query('delete from meta.setting where name = $1', [k]);
      else await c.query('insert into meta.setting (name, value) values ($1, $2) on conflict (name) do update set value = excluded.value', [k, v]);
    }
  });
  await refreshTelemetry(true);
  return null;
}

/** A new token for /metrics (shown once; only its hash is kept), or null to remove it. */
export async function setMetricsToken(token: string | null) {
  if (token) await owner.query(`insert into meta.setting (name, value) values ('metrics_token_hash', $1) on conflict (name) do update set value = excluded.value`, [hashToken(token)]);
  else await owner.query(`delete from meta.setting where name = 'metrics_token_hash'`);
  await refreshTelemetry(true);
}

export interface WorkspaceForm {
  mode?: string;
  endpoint?: string;
  headers?: string;
  remove_headers?: string;
  values?: string;
}

/** Save a workspace's setting. Returns a problem, or null. */
export async function saveWorkspaceTelemetry(wsId: number, f: WorkspaceForm): Promise<string | null> {
  const mode = f.mode ?? 'instance';
  if (!['instance', 'off', 'own'].includes(mode)) return 'Unknown choice.';
  const endpoint = (f.endpoint ?? '').trim();
  if (endpoint && endpointProblem(endpoint)) return `Collector URL: ${endpointProblem(endpoint)}.`;
  if (mode === 'own' && !endpoint) return 'Give the URL of the workspace\'s own collector.';
  const headers = (f.headers ?? '').trim();
  if (headers && !Object.keys(parsePairs(headers)).length) return 'Headers: name=value, one per line or comma separated.';
  await owner.query(
    `update meta.workspace set telemetry = $2, telemetry_endpoint = $3, telemetry_values = $4,
            telemetry_headers_enc = case when $5::text is not null then $5 when $6 then null else telemetry_headers_enc end
      where id = $1`,
    [wsId, mode, endpoint || null, f.values === 'true', headers ? encryptSecret(headers) : null, f.remove_headers === 'true'],
  );
  await refreshTelemetry(true);
  return null;
}
