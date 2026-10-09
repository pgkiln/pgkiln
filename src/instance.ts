import { owner } from './db.ts';

// Instance settings (APEX: instance administration → instance settings):
// values administrators change in the builder (Workspace utilities →
// Instance settings) instead of in environment variables. Each setting is
// read from meta.setting, else from its environment variable, else its
// default. The values are cached per server process and read again every
// 30 seconds (and at once in the process that saved them), so a change
// reaches every server within half a minute.

export interface InstanceSetting {
  key: InstanceKey;
  env: string;
  label: string;
  help: string;
  default: number;
  min: number;
  max: number;
}

export const INSTANCE_SETTINGS: readonly InstanceSetting[] = [
  { key: 'session_idle_minutes', env: 'SESSION_IDLE_MINUTES', label: 'Session idle time (minutes)', help: 'A session without requests for this long ends (builder and applications).', default: 60, min: 5, max: 1440 },
  { key: 'session_max_hours', env: 'SESSION_MAX_HOURS', label: 'Maximum session length (hours)', help: 'A session ends this long after the sign-in, however active.', default: 8, min: 1, max: 168 },
  { key: 'login_window_minutes', env: 'LOGIN_WINDOW_MINUTES', label: 'Sign-in throttling window (minutes)', help: 'How far back failed sign-ins count, and how long a throttled user waits.', default: 15, min: 1, max: 1440 },
  { key: 'login_max_failures_user', env: 'LOGIN_MAX_FAILURES_PER_USER', label: 'Failed sign-ins per user', help: 'Failures for one username within the window before it is throttled.', default: 5, min: 1, max: 1000 },
  { key: 'login_max_failures_ip', env: 'LOGIN_MAX_FAILURES_PER_IP', label: 'Failed sign-ins per IP address', help: 'Failures from one address within the window before it is throttled.', default: 50, min: 1, max: 100000 },
];

export type InstanceKey = 'session_idle_minutes' | 'session_max_hours' | 'login_window_minutes' | 'login_max_failures_user' | 'login_max_failures_ip';

const REFRESH_MS = 30_000;
let stored = new Map<string, string>();
let loadedAt = 0;
let loading: Promise<void> | null = null;

/** The setting's value from the environment (when a whole number in range) or its default. */
function fromEnv(s: InstanceSetting) {
  const raw = process.env[s.env];
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isInteger(n) && n >= s.min && n <= s.max ? n : s.default;
}

/** Where the value in effect comes from. */
export function origin(key: InstanceKey): 'builder' | 'environment' | 'default' {
  const s = INSTANCE_SETTINGS.find((x) => x.key === key)!;
  if (valid(s, stored.get(key)) !== null) return 'builder';
  const raw = process.env[s.env];
  return raw !== undefined && raw.trim() !== '' && fromEnv(s) === Number(raw) ? 'environment' : 'default';
}

function valid(s: InstanceSetting, v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= s.min && n <= s.max ? n : null;
}

/** Read meta.setting again when the cache is older than 30 s (callers that can wait). */
export async function refreshInstanceSettings(force = false) {
  if (!force && Date.now() - loadedAt < REFRESH_MS) return;
  loading ??= owner
    .query<{ name: string; value: string }>('select name, value from meta.setting where name = any($1)', [INSTANCE_SETTINGS.map((s) => s.key)])
    .then((r) => {
      stored = new Map(r.rows.map((x) => [x.name, x.value]));
      loadedAt = Date.now();
    })
    .catch(() => {
      // keep the last values (an older database without the table keeps the defaults)
      loadedAt = Date.now();
    })
    .finally(() => {
      loading = null;
    });
  await loading;
}

/** The value in effect (synchronous: the cached value; the cache refreshes in the background). */
export function instanceSetting(key: InstanceKey): number {
  if (Date.now() - loadedAt >= REFRESH_MS) void refreshInstanceSettings();
  const s = INSTANCE_SETTINGS.find((x) => x.key === key)!;
  return valid(s, stored.get(key)) ?? fromEnv(s);
}

/** Save the builder's values ('' = back to the environment or default). Returns a message for a bad value. */
export async function saveInstanceSettings(values: Record<string, string | undefined>): Promise<string | null> {
  const writes: [string, string | null][] = [];
  for (const s of INSTANCE_SETTINGS) {
    const v = (values[s.key] ?? '').trim();
    if (v === '') {
      writes.push([s.key, null]);
      continue;
    }
    if (valid(s, v) === null) return `${s.label}: a whole number from ${s.min} to ${s.max}.`;
    writes.push([s.key, String(Number(v))]);
  }
  await owner.tx(async (c) => {
    for (const [k, v] of writes) {
      if (v === null) await c.query('delete from meta.setting where name = $1', [k]);
      else await c.query('insert into meta.setting (name, value) values ($1, $2) on conflict (name) do update set value = excluded.value', [k, v]);
    }
  });
  await refreshInstanceSettings(true);
  return null;
}

// ---------------------------------------------------------------- the configuration overview

/** Environment variables shown on the Instance settings page (secrets only as "set"). */
export const CONFIGURATION: readonly { env: string; secret?: boolean; default: string; help: string }[] = [
  { env: 'PORT', default: '3100', help: 'HTTP port' },
  { env: 'HOST', default: '127.0.0.1', help: 'Address the server listens on' },
  { env: 'PUBLIC_URL', default: '(none)', help: 'The public address (single sign-on redirects, links)' },
  { env: 'DATABASE_URL', secret: true, default: '(none)', help: 'Owner connection (migrations, builder, SQL Workshop)' },
  { env: 'RUNTIME_DATABASE_URL', secret: true, default: 'DATABASE_URL', help: 'Least-privilege connection that runs applications' },
  { env: 'COOKIE_SECURE', default: 'false', help: 'Cookies only over HTTPS' },
  { env: 'TRUST_PROXY', default: 'false', help: 'Client addresses from a reverse proxy' },
  { env: 'MIGRATE_ON_START', default: 'false', help: 'Apply missing migrations when the server starts' },
  { env: 'AUTOMATIONS', default: 'on', help: 'This server runs automations' },
  { env: 'WORKFLOWS', default: 'on', help: 'This server runs workflows' },
  { env: 'BACKGROUND_PROCESSES', default: 'on', help: 'This server runs background execution chains' },
  { env: 'PGKILN_REST_ALLOWED_HOSTS', default: '(none)', help: 'Hosts REST data sources may call' },
  { env: 'PGKILN_REST_PRIVATE_HOSTS', default: '(none)', help: 'Hosts that may resolve to private addresses' },
  { env: 'PGKILN_SECRET_KEY', secret: true, default: '(none)', help: 'Encrypts web credential secrets and AI keys' },
  { env: 'API_URL', default: '(none)', help: 'PostgREST address (REST API pages)' },
  { env: 'API_JWT_SECRET', secret: true, default: '(none)', help: 'Signs REST API tokens' },
  { env: 'ANTHROPIC_API_KEY', secret: true, default: '(none)', help: 'Default key of Claude AI services' },
  { env: 'OPENAI_API_KEY', secret: true, default: '(none)', help: 'Default key of OpenAI AI services' },
  { env: 'MAP_TILE_URL', default: 'OpenStreetMap', help: 'Tile server of map regions' },
  { env: 'LOG_LEVEL', default: 'info', help: 'Server log level' },
];

/** A configuration value as the page shows it: secrets never, only whether they are set. */
export function configurationValue(c: (typeof CONFIGURATION)[number]): { value: string; set: boolean } {
  const raw = process.env[c.env];
  const set = raw !== undefined && raw !== '';
  if (!set) return { value: c.default, set };
  return { value: c.secret ? 'set (hidden)' : raw.length > 200 ? `${raw.slice(0, 200)}…` : raw, set };
}
