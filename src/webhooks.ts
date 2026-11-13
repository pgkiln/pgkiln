import { createHmac, timingSafeEqual } from 'node:crypto';
import { hostname } from 'node:os';
import pg from 'pg';
import { RESERVED_BINDS, type BindValues } from './binds.ts';
import { owner, runtime } from './db.ts';
import { backoffS, retryBaseS, retryCapS, startQueueRunner, type QueueRunner } from './queue-runner.ts';
import { DO_TAG, runPlpgsql, setBinds } from './runtime/rest-handlers.ts';
import { decryptSecret } from './secrets.ts';
import { logActivity } from './session.ts';
import { loadCredential, parsePath, valueAt } from './websources.ts';
import { withAppDb } from './workspace-db.ts';

// (sprint 177, migration 161) Inbound webhooks: REST module handlers of type "webhook".
//
//   {"method": "POST", "path": "payments", "type": "webhook", "source": "<PL/pgSQL block>",
//    "webhook": {"scheme": "hmac-sha256", "credential": "SHOP_WEBHOOK", "header": "X-Hub-Signature-256",
//                "encoding": "hex", "prefix": "sha256=", "event_id": "header:X-GitHub-Delivery",
//                "headers": ["x-github-event"], "retention_days": 30, "max_attempts": 5}}
//   {"…": "…", "webhook": {"scheme": "stripe", "credential": "STRIPE_WEBHOOK", "tolerance_s": 300, "event_id": "body:id"}}
//
// Receiving (runtime/rest.ts calls receive()): the signature is checked on the raw bytes of the body with the
// secret of the named web credential (decrypted for the check only), compared in constant time; then the event
// is stored (meta.webhook_event) unless its id was seen before for this handler, and the request is answered at
// once. Nothing of a refused request is stored; the refusal is logged without the signature.
//
// Processing (webhookTick; startWebhookRunner listens for NOTIFY pgkiln_webhook_event and polls): each event is
// claimed with FOR UPDATE SKIP LOCKED and a lease, and the handler's block runs as the application's database
// role on the application's runtime connection, in a transaction of its own, with :BODY (the body as text), the
// fields of a JSON body as binds and meta.webhook_event(). A block that raises is tried again (backoff as the
// web request outbox), then the event is "failed"; the builder can re-process it.

export type WebhookScheme = 'hmac-sha256' | 'stripe';
export const WEBHOOK_SCHEMES: WebhookScheme[] = ['hmac-sha256', 'stripe'];
export interface WebhookConfig {
  scheme: WebhookScheme;
  /** the web credential (of the application or its workspace) whose secret signs the requests */
  credential: string;
  /** the header with the signature (hmac-sha256: default X-Signature; stripe: Stripe-Signature) */
  header?: string;
  /** hmac-sha256: how the signature is written (default hex) */
  encoding?: 'hex' | 'base64';
  /** hmac-sha256: text before the signature, e.g. sha256= */
  prefix?: string;
  /** stripe: how far the signed timestamp may be from now, in seconds (default 300) */
  tolerance_s?: number;
  /** where the sender's event id is: body:<path> (a field of the JSON body) or header:<name> */
  event_id?: string;
  /** request headers kept with the event (lower case) */
  headers?: string[];
  /** events are removed this many days after they were received (default 30) */
  retention_days?: number;
  /** how often the block runs for an event before it is failed (default 5) */
  max_attempts?: number;
  /** the largest body in bytes (default and at most MAX_BODY) */
  max_bytes?: number;
}

/** The largest webhook body: the content type parser's limit (runtime/rest.ts). */
export const MAX_BODY = 1024 * 1024;
export const DEFAULT_RETENTION_DAYS = 30;
export const DEFAULT_EVENT_ATTEMPTS = 5;
export const DEFAULT_TOLERANCE_S = 300;
const HEADER = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;
/** Headers never kept with an event: credentials. */
const NEVER_KEPT = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie']);
const WORKER = `${hostname()}:${process.pid}`;

export const signatureHeader = (w: Pick<WebhookConfig, 'scheme' | 'header'>) => (w.header || (w.scheme === 'stripe' ? 'Stripe-Signature' : 'X-Signature')).toLowerCase();

const int = (v: unknown, min: number, max: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

/** Problems in a webhook handler (for handlerProblems), or []. */
export function webhookProblems(h: { method?: unknown; source?: unknown; webhook?: unknown }): string[] {
  const out: string[] = [];
  if (h.method !== 'POST') out.push('a webhook handler answers POST.');
  if (typeof h.source === 'string' && h.source.includes(DO_TAG)) out.push(`a PL/pgSQL block may not contain ${DO_TAG}.`);
  const w = h.webhook as Partial<WebhookConfig> | undefined;
  if (!w || typeof w !== 'object' || Array.isArray(w)) return [...out, 'a webhook handler needs "webhook": {"scheme", "credential", …}.'];
  if (!WEBHOOK_SCHEMES.includes(w.scheme as WebhookScheme)) out.push(`"webhook.scheme" is one of ${WEBHOOK_SCHEMES.join(', ')}.`);
  if (typeof w.credential !== 'string' || !/^[A-Z][A-Z0-9_]{0,59}$/i.test(w.credential)) out.push('"webhook.credential" is the name of the web credential with the signing secret.');
  if (w.header !== undefined && (typeof w.header !== 'string' || !HEADER.test(w.header) || NEVER_KEPT.has(w.header.toLowerCase()))) out.push('"webhook.header" is the name of the header with the signature, e.g. X-Hub-Signature-256.');
  if (w.encoding !== undefined && w.encoding !== 'hex' && w.encoding !== 'base64') out.push('"webhook.encoding" is hex or base64.');
  // eslint-disable-next-line no-control-regex
  if (w.prefix !== undefined && (typeof w.prefix !== 'string' || w.prefix.length > 40 || /[^\x21-\x7e]/.test(w.prefix))) out.push('"webhook.prefix" is at most 40 printable characters, e.g. sha256=.');
  if (w.tolerance_s !== undefined && !int(w.tolerance_s, 1, 86400)) out.push('"webhook.tolerance_s" is 1 to 86400 seconds.');
  if (w.event_id !== undefined) {
    const m = typeof w.event_id === 'string' ? /^(body|header):(.+)$/.exec(w.event_id) : null;
    if (!m) out.push('"webhook.event_id" is body:<path> (e.g. body:id) or header:<name> (e.g. header:X-GitHub-Delivery).');
    else if (m[1] === 'header' && (!HEADER.test(m[2]) || NEVER_KEPT.has(m[2].toLowerCase()))) out.push('"webhook.event_id": the header\'s name is not valid.');
    else if (m[1] === 'body') try {
      if (m[2].length > 200 || parsePath(m[2]).some((s) => s === '*')) throw new Error('one value');
    } catch {
      out.push('"webhook.event_id": the path names one field of the JSON body, e.g. body:id or body:data.object.id.');
    }
  }
  if (w.headers !== undefined && !(Array.isArray(w.headers) && w.headers.length <= 20 && w.headers.every((x) => typeof x === 'string' && HEADER.test(x) && !NEVER_KEPT.has(x.toLowerCase()))))
    out.push('"webhook.headers" is a list of at most 20 header names to keep with the event (not Authorization or Cookie).');
  if (w.retention_days !== undefined && !int(w.retention_days, 1, 365)) out.push('"webhook.retention_days" is 1 to 365.');
  if (w.max_attempts !== undefined && !int(w.max_attempts, 1, 20)) out.push('"webhook.max_attempts" is 1 to 20.');
  if (w.max_bytes !== undefined && !int(w.max_bytes, 1, MAX_BODY)) out.push(`"webhook.max_bytes" is 1 to ${MAX_BODY}.`);
  return out;
}

type Headers = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);

/** Compare two digests in constant time (false for another length, after a comparison of the same cost). */
function sameDigest(given: Buffer, expected: Buffer) {
  if (given.length !== expected.length) {
    timingSafeEqual(expected, expected);
    return false;
  }
  return timingSafeEqual(given, expected);
}

/**
 * Check a request's signature on the raw bytes of its body. Returns null when it is right, else why not (for
 * the log: never the signature or the secret).
 */
export function signatureProblem(w: WebhookConfig, secret: string, raw: Buffer, headers: Headers, now = Date.now()): string | null {
  const value = one(headers[signatureHeader(w)]);
  if (value === undefined || value === '') return 'no signature header';
  if (value.length > 2000) return 'malformed signature';
  if (w.scheme === 'stripe') {
    // t=<unix seconds>,v1=<hex>[,v1=<hex>…] (other schemes, e.g. v0, are ignored): the HMAC of "<t>.<body>"
    let t: string | undefined;
    const v1: string[] = [];
    for (const part of value.split(',')) {
      const eq = part.indexOf('=');
      const k = part.slice(0, eq).trim();
      const v = part.slice(eq + 1).trim();
      if (eq < 0) continue;
      if (k === 't') t = v;
      else if (k === 'v1') v1.push(v);
    }
    if (!t || !/^\d{1,12}$/.test(t) || !v1.length) return 'malformed signature';
    const expected = createHmac('sha256', secret).update(`${t}.`).update(raw).digest();
    let ok = false;
    for (const sig of v1.slice(0, 10)) if (sameDigest(/^[0-9a-f]{64}$/i.test(sig) ? Buffer.from(sig, 'hex') : Buffer.alloc(0), expected)) ok = true;
    if (!ok) return 'signature mismatch';
    // checked after the signature: only a signed timestamp says anything
    if (Math.abs(now / 1000 - Number(t)) > (w.tolerance_s ?? DEFAULT_TOLERANCE_S)) return 'timestamp outside the tolerance';
    return null;
  }
  const prefix = w.prefix ?? '';
  if (!value.startsWith(prefix)) return 'malformed signature';
  const sig = value.slice(prefix.length).trim();
  const given = (w.encoding ?? 'hex') === 'hex'
    ? (/^[0-9a-f]{64}$/i.test(sig) ? Buffer.from(sig, 'hex') : Buffer.alloc(0))
    : (/^[A-Za-z0-9+/_-]{43}=?$/.test(sig) ? Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64') : Buffer.alloc(0));
  return sameDigest(given, createHmac('sha256', secret).update(raw).digest()) ? null : 'signature mismatch';
}

/** The body as text when it is valid UTF-8 without NUL bytes, else null. */
export function bodyText(raw: Buffer): string | null {
  if (raw.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    return null;
  }
}

/** The sender's event id of a request, or null (none configured, or the request has none). Throws for one that is no id. */
export function eventKey(w: WebhookConfig, raw: Buffer, headers: Headers): string | null {
  const m = /^(body|header):(.+)$/.exec(w.event_id ?? '');
  if (!m) return null;
  let v: unknown;
  if (m[1] === 'header') v = one(headers[m[2].toLowerCase()]);
  else {
    try {
      v = valueAt(JSON.parse(bodyText(raw) ?? ''), m[2]);
    } catch {
      v = undefined;
    }
  }
  if (v === undefined || v === null || v === '') return null;
  if ((typeof v !== 'string' && typeof v !== 'number') || String(v).length > 255) throw new WebhookRefused(400, 'The event id is not a text of at most 255 characters.', 'event id not usable');
  return String(v);
}

export class WebhookRefused extends Error {
  constructor(readonly status: number, message: string, readonly reason: string) {
    super(message);
  }
}

export interface Received {
  /** false: this event id was received before for the handler (nothing stored) */
  stored: boolean;
  id: string | null;
}

/**
 * Receive a webhook request for a handler: check its signature, then store the event unless its id is known.
 * Throws WebhookRefused (401: the signature; 413; 400; 503: no secret) with nothing stored.
 */
export async function receive(o: { appId: number; module: string; path: string; webhook: WebhookConfig; raw: Buffer; headers: Headers; contentType: string | null; now?: number }): Promise<Received> {
  const w = o.webhook;
  if (o.raw.length > Math.min(w.max_bytes ?? MAX_BODY, MAX_BODY)) throw new WebhookRefused(413, 'The body is too large.', 'body too large');
  let secret: string;
  try {
    const c = await loadCredential(o.appId, w.credential);
    if (!c.secret_enc) throw new Error('no secret');
    secret = decryptSecret(c.secret_enc);
    if (!secret) throw new Error('no secret');
  } catch {
    // no secret, no check: never accept unsigned
    throw new WebhookRefused(503, 'This webhook is not set up yet.', `web credential ${w.credential} has no usable secret`);
  }
  const problem = signatureProblem(w, secret, o.raw, o.headers, o.now);
  if (problem) throw new WebhookRefused(401, 'The signature is not valid.', problem);
  const key = eventKey(w, o.raw, o.headers);
  const sig = signatureHeader(w);
  const kept: Record<string, string> = {};
  for (const name of (w.headers ?? []).map((x) => x.toLowerCase())) {
    const v = one(o.headers[name]);
    if (v !== undefined && name !== sig && !NEVER_KEPT.has(name)) kept[name] = v.slice(0, 2000);
  }
  const row = await owner.one<{ id: string }>(
    `insert into meta.webhook_event (app_id, module, path, event_key, headers, content_type, body, purge_after, max_attempts)
     values ($1, $2, $3, $4, $5::jsonb, $6, $7, now() + make_interval(days => $8::int), $9)
     on conflict (app_id, module, path, event_key) do nothing returning id::text`,
    [o.appId, o.module, o.path, key, JSON.stringify(kept), o.contentType?.slice(0, 200) ?? null, o.raw, w.retention_days ?? DEFAULT_RETENTION_DAYS, w.max_attempts ?? DEFAULT_EVENT_ATTEMPTS],
  );
  if (!row) return { stored: false, id: null };
  await owner.query(`select pg_notify('pgkiln_webhook_event', '')`);
  return { stored: true, id: row.id };
}

// ---------------------------------------------------------------- processing

interface EventRow {
  id: string;
  app_id: number;
  db_role: string | null;
  module: string;
  path: string;
  event_key: string | null;
  headers: Record<string, string>;
  content_type: string | null;
  body: Buffer;
  received_at: string;
  attempts: number;
  max_attempts: number;
}

/** Thrown for an event that can't be processed however often it is tried. */
class Unprocessable extends Error {}

/** Run the handler's block for an event, as the application's role (never the owner, a superuser or a role that bypasses RLS). */
async function processEvent(ev: EventRow) {
  const mod = await owner.one<{ handlers: { method: string; path: string; type: string; source: string }[]; enabled: boolean }>(
    'select handlers, enabled from meta.rest_module where app_id = $1 and name = $2', [ev.app_id, ev.module]);
  const h = (Array.isArray(mod?.handlers) ? mod.handlers : []).find((x) => x.type === 'webhook' && x.method === 'POST' && x.path === ev.path);
  if (!h || typeof h.source !== 'string') throw new Unprocessable('The webhook handler no longer exists.');
  const text = bodyText(ev.body);
  const binds: BindValues = {};
  if (text !== null) {
    try {
      const json: unknown = JSON.parse(text);
      if (json && typeof json === 'object' && !Array.isArray(json))
        for (const [k, v] of Object.entries(json)) binds[k.toUpperCase()] = v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v);
    } catch {
      // not JSON: only :BODY
    }
  }
  for (const k of Object.keys(binds)) if (RESERVED_BINDS.has(k) || binds[k]?.includes('\0')) delete binds[k];
  Object.assign(binds, { BODY: text, EVENT_ID: ev.event_key, APP_USER: 'nobody', APP_ID: String(ev.app_id), APP_SESSION: null, APP_PAGE_ID: null, REQUEST: null });
  const event = { id: Number(ev.id), event_id: ev.event_key, received_at: ev.received_at, attempt: ev.attempts, content_type: ev.content_type, headers: ev.headers };
  await withAppDb(ev.app_id, () => runtime.tx(async (c) => {
    await c.query(
      `select set_config('pgkiln.app_id', $1, true), set_config('pgkiln.app_user', 'nobody', true), set_config('pgkiln.session_id', '', true),
              set_config('request.jwt.claims', '', true), set_config('statement_timeout', $2, true), set_config('pgkiln_webhook.event', $3, true)`,
      [String(ev.app_id), process.env.STATEMENT_TIMEOUT ?? '30s', JSON.stringify(event)],
    );
    await setBinds(c, binds);
    if (ev.db_role) await c.query(`set local role ${pg.escapeIdentifier(ev.db_role)}`);
    const role = (await c.query(
      `select r.rolsuper or r.rolbypassrls or pg_has_role(current_user, n.nspowner, 'MEMBER') as bad
         from pg_roles r, pg_namespace n where r.rolname = current_user and n.nspname = 'meta'`)).rows[0];
    if (!role || role.bad) throw new Unprocessable('The handler would run as a role that bypasses row level security or owns pgkiln: refused. Give the application its own database role.');
    await runPlpgsql(c, h.source);
  }));
}

let lastPurge = 0;

/** Remove the events whose retention ended (at most every 5 minutes, unless forced). */
export async function purgeWebhookEvents(force = false) {
  if (!force && Date.now() - lastPurge < 5 * 60_000) return;
  lastPurge = Date.now();
  await owner.query(`delete from meta.webhook_event where purge_after < now() and state <> 'running'`);
}

/** One pass: the events that are due, one after the other in the order received. Returns the ids processed. */
/** Events per pass; (sprint 180) a full pass is followed by another at once. */
export const WEBHOOK_PER_PASS = 100;

export async function webhookTick(max = WEBHOOK_PER_PASS): Promise<string[]> {
  // a server that stopped while it processed an event: the next attempt, or failed
  await owner.query(
    `update meta.webhook_event set state = case when attempts >= max_attempts then 'failed' else 'retry' end,
            next_attempt_at = case when attempts >= max_attempts then null else now() end, lease_until = null,
            error = 'The server stopped while it processed the event.'
      where state = 'running' and lease_until < now()`);
  const done: string[] = [];
  for (let n = 0; n < max; n++) {
    const ev = await owner.one<EventRow>(
      `update meta.webhook_event e set state = 'running', attempts = e.attempts + 1, worker = $1, lease_until = now() + interval '5 minutes'
         from meta.app a
        where a.id = e.app_id and e.id = (
          select q.id from meta.webhook_event q where q.state in ('received', 'retry') and coalesce(q.next_attempt_at, '-infinity') <= now()
             -- (sprint 180) a disabled module's events wait until it is enabled again (a removed module's fail below)
             and not exists (select 1 from meta.rest_module m where m.app_id = q.app_id and m.name = q.module and not m.enabled)
           order by q.id for update skip locked limit 1)
        returning e.id::text, e.app_id, a.db_role, e.module, e.path, e.event_key, e.headers, e.content_type, e.body,
                  to_char(e.received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as received_at, e.attempts, e.max_attempts`,
      [WORKER]);
    if (!ev) break;
    done.push(ev.id);
    let error: string | null = null;
    let final = true;
    try {
      await processEvent(ev);
    } catch (e) {
      const err = e as pg.DatabaseError;
      error = `${err.code ? `[${err.code}] ` : ''}${err.message || String(e)}`.slice(0, 2000);
      final = e instanceof Unprocessable || ev.attempts >= ev.max_attempts;
    }
    await owner.query(
      `update meta.webhook_event set state = $2, error = $3, lease_until = null, processed_at = case when $2 in ('done', 'failed') then now() end,
              next_attempt_at = case when $2 = 'retry' then now() + make_interval(secs => $4::int) end
        where id = $1 and state = 'running' and worker = $5 and attempts = $6`,
      [ev.id, error === null ? 'done' : final ? 'failed' : 'retry', error, Math.ceil(backoffS(ev.attempts, retryBaseS(), retryCapS())), WORKER, ev.attempts]);
    if (error !== null && final)
      await logActivity({ appId: ev.app_id, username: 'nobody', event: 'error', ip: 'background', detail: `webhook ${ev.module}/${ev.path}: event ${ev.id} failed: ${error}`.slice(0, 2000) }).catch(() => {});
  }
  await purgeWebhookEvents();
  return done;
}

/** Seconds until the next retry of an enabled module falls due (null: none waits). */
export async function webhookNextDueS(): Promise<number | null> {
  const r = await owner.one<{ s: number | null }>(`select extract(epoch from min(q.next_attempt_at) - now())::float8 as s from meta.webhook_event q
      where q.state = 'retry' and not exists (select 1 from meta.rest_module m where m.app_id = q.app_id and m.name = q.module and not m.enabled)`);
  return r?.s === null || r?.s === undefined ? null : Math.max(0, r.s);
}

let runner: QueueRunner | undefined;

/** Process events as they arrive (NOTIFY pgkiln_webhook_event) and when a retry falls due; polls as the fallback. Off with WEBHOOKS=off. */
export async function startWebhookRunner() {
  if (process.env.WEBHOOKS === 'off' || runner) return;
  runner = await startQueueRunner({ channel: 'pgkiln_webhook_event', label: 'webhook events', tick: () => webhookTick(), more: (r) => (r as string[]).length >= WEBHOOK_PER_PASS, nextDueS: webhookNextDueS, pollS: 15 });
}

export async function stopWebhookRunner() {
  await runner?.stop();
  runner = undefined;
}
