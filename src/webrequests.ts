import { hostname } from 'node:os';
import pg from 'pg';
import { owner, runtime, type Client } from './db.ts';
import { purgeUnpacked, unpackForSql } from './unpack.ts';
import { call, invoke, loadCredential } from './websources.ts';
import { WebError, type WebResponse } from './webclient.ts';
import { purgeRefusals } from './network-acl.ts';
import { backoffS, retryBaseS, retryCapS, startQueueRunner, type QueueRunner } from './queue-runner.ts';
import { logActivity } from './session.ts';
import { withAppDb } from './workspace-db.ts';

// Web requests from SQL (APEX_WEB_SERVICE; migration 052): application SQL
// queues a request with meta.web_request(url, …) or
// meta.web_request_source(source, params) and reads the result with
// meta.web_response(id). PostgreSQL can't make an HTTP call itself, so the
// server makes it:
//
// - inside a page process: right after each process of type sql (in the
//   same transaction, before the next process), so the next process can
//   read the response (runPending, at most 5 per process);
// - otherwise after the caller commits, on the next pass of the scheduler
//   (webRequestTick from src/automations.ts, every SCHEDULER_INTERVAL_S).
//
// Every call goes through src/websources.ts call()/invoke(): the host
// allow-list, the address checks at connect time, redirects, the time limit,
// the response size limit (PGKILN_REST_MAX_BYTES) and the app's web
// credentials, whose secrets are decrypted only for the request and never
// stored with it. A response with any status code is "ok" (the status code
// is kept, like apex_web_service.g_status_code); "error" means no response.
//
// (sprint 177, migration 160) The queue is an outbox:
//
// - retries: a request the server delivers after the commit is tried up to
//   max_attempts times (default 5). A network error, a 5xx or a 429 answer
//   is worth another attempt: status 'retry' until next_attempt_at
//   (exponential backoff from QUEUE_RETRY_S, a Retry-After header honoured,
//   both capped by QUEUE_RETRY_MAX_S), then 'gave_up'. Any other answer is
//   'ok'; a request that can't be made (the allow-list, a credential) is
//   'error' and never retried. Every attempt goes through execute(), so the
//   allow-list and the address checks apply to each one. A page process's
//   request keeps its one attempt unless the caller gave max_attempts.
// - leases: a claimed request is 'running' until lease_until; a server that
//   stopped loses the lease and the request is attempted again.
// - ordering_key: requests of an application with the same key are claimed
//   only when no earlier one of that key is still queued, running or
//   waiting for a retry.
// - idempotency: the same key in a header on every attempt.
// - callback: schema.function(bigint), called with the request's id once
//   the request is final, as the application's database role on its runtime
//   connection, in a transaction of its own (never the owner's). A callback
//   that raises is tried again (CALLBACK_ATTEMPTS), then 'failed'; the
//   request itself is never sent again.
// - NOTIFY pgkiln_web_request wakes startWebRequestRunner(); the scheduler
//   pass remains as the fallback.

export interface PendingRequest {
  id: string;
  app_id?: number;
  source: string | null;
  params: Record<string, string> | null;
  url: string | null;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  credential: string | null;
  timeout_s: number;
  /** (160) attempts made, this one included */
  attempts?: number;
  /** (160) null: the default (one attempt in a page process, DEFAULT_ATTEMPTS from the queue) */
  max_attempts?: number | null;
  idempotency_key?: string | null;
  idempotency_header?: string | null;
}

export interface RequestResult {
  status: 'ok' | 'error';
  statusCode: number | null;
  url: string | null;
  headers: Record<string, string> | null;
  body: Buffer | null;
  message: string | null;
  /** (160) no answer because the service was not reached or was too slow */
  transient?: boolean;
}

/** Requests per claim, and how many run at the same time. */
const PER_PASS = 50;
const PARALLEL = 5;
/** Finished requests are kept this long (given-up ones longer, to re-queue them), and at most this many per application. */
const KEEP_HOURS = 24;
const KEEP_GAVE_UP_DAYS = 7;
const KEEP_PER_APP = 500;
/** (160) Attempts of a request delivered from the queue when the caller gave none. */
export const DEFAULT_ATTEMPTS = 5;
/** (160) How often a callback that raises is called. */
export const CALLBACK_ATTEMPTS = 3;
const WORKER = `${hostname()}:${process.pid}`;

/** Header names that may carry a secret: dropped when a redirect leaves the origin. */
const SECRETISH = /auth|cookie|token|secret|key|session|password/i;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

function headerObject(h: WebResponse['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) if (v !== undefined) out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
  return out;
}

/** Make one queued request (never throws: a failure is the result). */
export async function execute(appId: number, r: PendingRequest): Promise<RequestResult> {
  try {
    let res: WebResponse;
    if (r.source) {
      // the source's URL, method, headers and credential; parameter values as given (no substitutions)
      res = (await invoke(appId, { source: r.source, params: r.params ?? {} }, () => undefined, `meta.web_request_source(${r.source})`, r.timeout_s)).res;
    } else {
      // checked again here: the row may have been changed in SQL by the owner
      if (!r.url || !/^https?:\/\//i.test(r.url)) throw new WebError('The URL must start with http:// or https://.');
      const headers = Object.fromEntries(
        Object.entries(r.headers ?? {})
          .filter(([k, v]) => typeof v === 'string' && !/[\r\n\0]/.test(v) && HEADER_NAME.test(k))
          .map(([k, v]) => [k.toLowerCase(), v]),
      );
      // (160) the request's idempotency key: the same on every attempt; a header the caller set itself wins
      const idem = r.idempotency_header?.toLowerCase();
      if (idem && r.idempotency_key && HEADER_NAME.test(idem) && !/[\r\n\0]/.test(r.idempotency_key) && !(idem in headers)) headers[idem] = r.idempotency_key;
      const credential = r.credential ? await loadCredential(appId, r.credential) : null;
      res = await call({
        appId,
        what: 'meta.web_request',
        url: r.url,
        method: r.method,
        headers: { accept: '*/*', ...headers },
        body: r.body ?? undefined,
        credential,
        timeoutMs: r.timeout_s * 1000,
        secretHeaders: Object.keys(headers).filter((k) => SECRETISH.test(k)),
      });
    }
    return { status: 'ok', statusCode: res.status, url: res.url, headers: headerObject(res.headers), body: res.body, message: null };
  } catch (e) {
    // WebError messages name no secret; others (e.g. a missing credential) neither
    const message = e instanceof Error ? e.message : String(e);
    return { status: 'error', statusCode: (e as WebError).status ?? null, url: null, headers: null, body: null, message: message.slice(0, 2000), transient: (e as WebError).transient === true };
  }
}

/** The seconds a Retry-After header asks for (a number of seconds or an HTTP date), or null. */
export function retryAfterS(value: string | undefined, now = Date.now()): number | null {
  if (!value) return null;
  if (/^\s*\d{1,9}\s*$/.test(value)) return Number(value);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

export type Outcome = { status: 'ok' | 'error' | 'gave_up' } | { status: 'retry'; nextS: number };

/**
 * (160) What an attempt's result means for the request: final, or another attempt after nextS seconds.
 * Worth another attempt: no answer because the service was unreachable or slow, a 5xx or a 429 answer (also of a
 * credential's token endpoint). Never: an answer with another status (ok), a request that could not be made (error).
 */
export function outcome(res: RequestResult, attempts: number, maxAttempts: number): Outcome {
  const code = res.statusCode;
  const again = res.transient === true || (code !== null && (code >= 500 || code === 429));
  if (!again) return { status: res.status };
  if (attempts >= maxAttempts) return { status: 'gave_up' };
  const asked = Math.min(retryAfterS(res.headers?.['retry-after']) ?? 0, retryCapS());
  return { status: 'retry', nextS: Math.ceil(Math.max(backoffS(attempts, retryBaseS(), retryCapS()), asked)) };
}

const describe = (res: RequestResult, o: Outcome) =>
  res.message ?? (o.status === 'ok' ? null : `The web service answered ${res.statusCode}.`);

/**
 * The requests the current transaction queued (a page process): made now,
 * their results written in the same transaction. `onRequest` reports each
 * (debug messages). (160) A request queued with max_attempts whose attempt
 * failed waits for the server's next attempt after the commit.
 */
export async function runPending(c: Client, appId: number, onRequest?: (r: PendingRequest, res: RequestResult, ms: number) => void) {
  const taken = (await c.query<PendingRequest>('select * from meta.web_request_take(5)')).rows;
  for (const r of taken) {
    const t0 = Date.now();
    const res = await execute(appId, r);
    await unpackForSql(res.body); // a zip or .xlsx response, for meta.zip_entry / meta.parse_data
    const o: Outcome = r.max_attempts == null ? { status: res.status } : outcome(res, r.attempts ?? 1, r.max_attempts);
    await c.query('select meta.web_request_done($1, $2, $3, $4, $5::jsonb, $6, $7, $8)', [
      r.id, o.status, res.statusCode, res.url, res.headers ? JSON.stringify(res.headers) : null, res.body,
      r.max_attempts == null ? res.message : describe(res, o), o.status === 'retry' ? o.nextS : null,
    ]);
    onRequest?.(r, res, Date.now() - t0);
  }
  return taken.length;
}

type Claimed = PendingRequest & { app_id: number; attempts: number; max_attempts: number | null };

async function finish(r: Claimed, res: RequestResult) {
  await unpackForSql(res.body);
  const o = outcome(res, r.attempts, r.max_attempts ?? DEFAULT_ATTEMPTS);
  // only this attempt's own lease: a request another server took over after the lease ended is left alone
  await owner.query(
    `update meta.web_request_log set status = $2, finished_at = case when $2 = 'retry' then null else now() end,
            next_attempt_at = case when $2 = 'retry' then now() + make_interval(secs => $8::int) end, lease_until = null,
            status_code = $3, response_url = $4, response_headers = $5::jsonb, response_body = $6, message = $7,
            callback_state = case when $2 <> 'retry' and callback is not null then 'pending' end
      where id = $1 and status = 'running' and worker = $9 and attempts = $10`,
    [r.id, o.status, res.statusCode, res.url, res.headers ? JSON.stringify(res.headers) : null, res.body, describe(res, o)?.slice(0, 2000) ?? null,
     o.status === 'retry' ? o.nextS : 0, WORKER, r.attempts],
  );
}

let lastPurge = 0;

/** Remove old requests (at most every 5 minutes, unless forced). */
export async function purgeWebRequests(force = false) {
  if (!force && Date.now() - lastPurge < 5 * 60_000) return;
  lastPurge = Date.now();
  // requests from before leases (migration 160) that a stopped server left running
  await owner.query(
    `update meta.web_request_log set status = 'error', finished_at = now(), message = 'The request was interrupted (the server stopped while it ran).'
      where status = 'running' and lease_until is null and started_at < now() - interval '15 minutes'`,
  );
  await owner.query(
    `update meta.web_request_log set status = 'error', finished_at = now(), message = 'The request was not run within 24 hours (is the scheduler switched off? AUTOMATIONS=off).',
            callback_state = case when callback is not null then 'pending' end
      where status = 'queued' and requested_at < now() - interval '${KEEP_HOURS} hours'`,
  );
  // a request whose callback still has to run is kept until it has
  await owner.query(
    `delete from meta.web_request_log
      where coalesce(callback_state, 'done') in ('done', 'failed')
        and ((status in ('ok', 'error', 'cancelled') and finished_at < now() - interval '${KEEP_HOURS} hours')
          or (status = 'gave_up' and finished_at < now() - interval '${KEEP_GAVE_UP_DAYS} days'))`,
  );
  // (sprint 118) refusals of the network access lists: 7 days
  await purgeRefusals();
  await owner.query(
    `delete from meta.web_request_log l using (
       select id, row_number() over (partition by app_id order by id desc) as n from meta.web_request_log
        where status in ('ok', 'error', 'cancelled') and coalesce(callback_state, 'done') in ('done', 'failed')
     ) x where l.id = x.id and x.n > ${KEEP_PER_APP}`,
  );
}

/** Requests whose server stopped while they were in flight: the next attempt, or given up. */
async function releaseExpired() {
  await owner.query(
    `update meta.web_request_log l
        set status = case when l.attempts >= coalesce(l.max_attempts, $1) then 'gave_up' else 'retry' end,
            next_attempt_at = case when l.attempts >= coalesce(l.max_attempts, $1) then null else now() end,
            finished_at = case when l.attempts >= coalesce(l.max_attempts, $1) then now() end,
            callback_state = case when l.attempts >= coalesce(l.max_attempts, $1) and l.callback is not null then 'pending' end,
            lease_until = null, message = 'The server stopped while the request was in flight.'
      where l.status = 'running' and l.lease_until < now()`,
    [DEFAULT_ATTEMPTS],
  );
}

/**
 * Claim committed requests that are due (FOR UPDATE SKIP LOCKED, so several servers don't take the same one),
 * each with a lease. A request with an ordering key is claimed only when no earlier request of its key (and
 * application) is unfinished: they go out one at a time, in the order queued.
 */
async function claim(): Promise<Claimed[]> {
  return (
    await owner.query<Claimed>(
      `update meta.web_request_log l
          set status = 'running', started_at = now(), attempts = l.attempts + 1, worker = $1,
              lease_until = now() + make_interval(secs => l.timeout_s * 2 + 60)
        where l.id in (
          select q.id from meta.web_request_log q
           where q.status in ('queued', 'retry') and coalesce(q.next_attempt_at, '-infinity') <= now()
             and (q.ordering_key is null or not exists (
                   select 1 from meta.web_request_log e
                    where e.app_id = q.app_id and e.ordering_key = q.ordering_key and e.id < q.id and e.status in ('queued', 'running', 'retry')))
           order by q.id for update skip locked limit ${PER_PASS})
        returning l.id::text, l.app_id, l.source, l.params, l.url, l.method, l.headers, l.body, l.credential, l.timeout_s,
                  l.attempts, l.max_attempts, l.idempotency_key, l.idempotency_header`,
      [WORKER],
    )
  ).rows.sort((a, b) => Number(a.id) - Number(b.id));
}

interface Callback {
  id: string;
  app_id: number;
  db_role: string | null;
  callback: string;
  callback_attempts: number;
  requested_by: string | null;
  tenant_id: string | null;
}

const CALLBACK_NAME = /^([a-z_][a-z0-9_]{0,62})\.([a-z_][a-z0-9_]{0,62})$/;

/**
 * Call a finished request's callback: schema.function(id) as the application's database role on the application's
 * runtime connection (an isolated workspace's own), in a transaction of its own. Never as the owner, a superuser
 * or a role that bypasses row level security.
 */
async function runCallback(cb: Callback) {
  const name = CALLBACK_NAME.exec(cb.callback);
  if (!name) throw new Error('The callback is not schema.function.');
  await withAppDb(cb.app_id, () => runtime.tx(async (c) => {
    await c.query(
      `select set_config('pgkiln.app_user', $1, true), set_config('pgkiln.app_id', $2, true), set_config('pgkiln.session_id', '', true),
              set_config('statement_timeout', $3, true), set_config('pgkiln.tenant_id', $4, true)`,
      [cb.requested_by ?? 'nobody', String(cb.app_id), process.env.STATEMENT_TIMEOUT ?? '30s', cb.tenant_id ?? ''],
    );
    if (cb.db_role) await c.query(`set local role ${pg.escapeIdentifier(cb.db_role)}`);
    const role = (await c.query(
      `select r.rolsuper or r.rolbypassrls or pg_has_role(current_user, n.nspowner, 'MEMBER') as bad
         from pg_roles r, pg_namespace n where r.rolname = current_user and n.nspname = 'meta'`)).rows[0];
    if (!role || role.bad) throw new Error('The callback would run as a role that bypasses row level security or owns pgkiln: refused. Give the application its own database role.');
    await c.query(`select ${pg.escapeIdentifier(name[1])}.${pg.escapeIdentifier(name[2])}($1::bigint)`, [cb.id]);
  }));
}

/** Call the callbacks that are due (each claimed with a lease; one that raises waits for its next call). Returns the ids called. */
export async function callbackTick(): Promise<string[]> {
  const due = (
    await owner.query<Callback>(
      `update meta.web_request_log l
          set callback_state = 'running', callback_attempts = l.callback_attempts + 1, callback_lease_until = now() + interval '5 minutes'
         from meta.app a
        where a.id = l.app_id and l.id in (
          select q.id from meta.web_request_log q
           where (q.callback_state = 'pending' and coalesce(q.callback_next_at, '-infinity') <= now())
              or (q.callback_state = 'running' and q.callback_lease_until < now())
           order by q.id for update skip locked limit ${PER_PASS})
        returning l.id::text, l.app_id, a.db_role, l.callback, l.callback_attempts, l.requested_by, l.tenant_id`,
    )
  ).rows.sort((a, b) => Number(a.id) - Number(b.id));
  for (const cb of due) {
    let error: string | null = null;
    if (cb.callback_attempts > CALLBACK_ATTEMPTS) error = 'The server stopped while the callback ran.';
    else {
      try {
        await runCallback(cb);
      } catch (e) {
        error = ((e as Error).message || String(e)).slice(0, 2000);
      }
    }
    const final = error === null || cb.callback_attempts >= CALLBACK_ATTEMPTS;
    await owner.query(
      `update meta.web_request_log set callback_state = $2, callback_error = $3, callback_lease_until = null,
              callback_next_at = case when $2 = 'pending' then now() + make_interval(secs => $4::int) end
        where id = $1 and callback_state = 'running'`,
      [cb.id, error === null ? 'done' : final ? 'failed' : 'pending', error, Math.ceil(backoffS(cb.callback_attempts, retryBaseS(), retryCapS()))],
    );
    if (error !== null && final)
      await logActivity({ appId: cb.app_id, username: cb.requested_by, event: 'error', ip: 'background', detail: `web request ${cb.id}: callback ${cb.callback} failed: ${error}`.slice(0, 2000) }).catch(() => {});
  }
  return due.map((cb) => cb.id);
}

/**
 * One pass: claim the requests that are due and make them, a few at a time, until none is left (so the requests
 * of one ordering key follow each other at once); then the callbacks. Returns the ids of the requests attempted.
 */
export async function webRequestTick(): Promise<string[]> {
  const made: string[] = [];
  await releaseExpired();
  for (let round = 0; round < 20; round++) {
    const queue = await claim();
    if (!queue.length) break;
    made.push(...queue.map((r) => r.id));
    const worker = async () => {
      for (let r = queue.shift(); r; r = queue.shift()) {
        try {
          await finish(r, await execute(r.app_id, r));
        } catch (e) {
          // pgkiln's own failure (the database went away): the lease ends and the request is attempted again
          console.error('web requests:', (e as Error).message);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, worker));
  }
  await callbackTick();
  await purgeWebRequests();
  await purgeUnpacked();
  return made;
}

/** Seconds until the next retry or callback falls due (null: none waits). */
async function nextDueS(): Promise<number | null> {
  const r = await owner.one<{ s: number | null }>(
    `select extract(epoch from least(
              (select min(next_attempt_at) from meta.web_request_log where status = 'retry'),
              (select min(callback_next_at) from meta.web_request_log where callback_state = 'pending')) - now())::float8 as s`);
  return r?.s === null || r?.s === undefined ? null : Math.max(0, r.s);
}

let runner: QueueRunner | undefined;

/**
 * (160) Deliver queued requests as soon as they are committed: listens for NOTIFY pgkiln_web_request and wakes
 * for the next retry; polls as the fallback. Off with AUTOMATIONS=off, like the scheduler pass.
 */
export async function startWebRequestRunner() {
  if (process.env.AUTOMATIONS === 'off' || runner) return;
  runner = await startQueueRunner({ channel: 'pgkiln_web_request', label: 'web requests', tick: webRequestTick, nextDueS, pollS: 15 });
}

export async function stopWebRequestRunner() {
  await runner?.stop();
  runner = undefined;
}
