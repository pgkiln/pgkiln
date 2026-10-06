import { owner, type Client } from './db.ts';
import { purgeUnpacked, unpackForSql } from './unpack.ts';
import { call, invoke, loadCredential } from './websources.ts';
import { WebError, type WebResponse } from './webclient.ts';

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
// the response size limit (PGAPEX_REST_MAX_BYTES) and the app's web
// credentials, whose secrets are decrypted only for the request and never
// stored with it. A response with any status code is "ok" (the status code
// is kept, like apex_web_service.g_status_code); "error" means no response.

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
}

export interface RequestResult {
  status: 'ok' | 'error';
  statusCode: number | null;
  url: string | null;
  headers: Record<string, string> | null;
  body: Buffer | null;
  message: string | null;
}

/** Requests per scheduler pass, and how many run at the same time. */
const PER_PASS = 50;
const PARALLEL = 5;
/** Finished requests are kept this long, and at most this many per application. */
const KEEP_HOURS = 24;
const KEEP_PER_APP = 500;

/** Header names that may carry a secret: dropped when a redirect leaves the origin. */
const SECRETISH = /auth|cookie|token|secret|key|session|password/i;

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
          .filter(([k, v]) => typeof v === 'string' && !/[\r\n\0]/.test(v) && /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(k))
          .map(([k, v]) => [k.toLowerCase(), v]),
      );
      const credential = r.credential ? await loadCredential(appId, r.credential) : null;
      res = await call({
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
    return { status: 'error', statusCode: (e as WebError).status ?? null, url: null, headers: null, body: null, message: message.slice(0, 2000) };
  }
}

/**
 * The requests the current transaction queued (a page process): made now,
 * their results written in the same transaction. `onRequest` reports each
 * (debug messages).
 */
export async function runPending(c: Client, appId: number, onRequest?: (r: PendingRequest, res: RequestResult, ms: number) => void) {
  const taken = (await c.query<PendingRequest>('select * from meta.web_request_take(5)')).rows;
  for (const r of taken) {
    const t0 = Date.now();
    const res = await execute(appId, r);
    await unpackForSql(res.body); // a zip or .xlsx response, for meta.zip_entry / meta.parse_data
    await c.query('select meta.web_request_done($1, $2, $3, $4, $5::jsonb, $6, $7)', [
      r.id, res.status, res.statusCode, res.url, res.headers ? JSON.stringify(res.headers) : null, res.body, res.message,
    ]);
    onRequest?.(r, res, Date.now() - t0);
  }
  return taken.length;
}

async function finish(id: string, res: RequestResult) {
  await unpackForSql(res.body);
  await owner.query(
    `update meta.web_request_log set status = $2, finished_at = now(), status_code = $3, response_url = $4, response_headers = $5::jsonb,
            response_body = $6, message = $7 where id = $1 and status = 'running'`,
    [id, res.status, res.statusCode, res.url, res.headers ? JSON.stringify(res.headers) : null, res.body, res.message],
  );
}

let lastPurge = 0;

/** Remove old requests (at most every 5 minutes, unless forced). */
export async function purgeWebRequests(force = false) {
  if (!force && Date.now() - lastPurge < 5 * 60_000) return;
  lastPurge = Date.now();
  // a server that stopped while a request ran, or requests nobody runs (scheduler off)
  await owner.query(
    `update meta.web_request_log set status = 'error', finished_at = now(), message = 'The request was interrupted (the server stopped while it ran).'
      where status = 'running' and started_at < now() - interval '15 minutes'`,
  );
  await owner.query(
    `update meta.web_request_log set status = 'error', finished_at = now(), message = 'The request was not run within 24 hours (is the scheduler switched off? AUTOMATIONS=off).'
      where status = 'queued' and requested_at < now() - interval '${KEEP_HOURS} hours'`,
  );
  await owner.query(`delete from meta.web_request_log where finished_at < now() - interval '${KEEP_HOURS} hours'`);
  await owner.query(
    `delete from meta.web_request_log l using (
       select id, row_number() over (partition by app_id order by id desc) as n from meta.web_request_log where status in ('ok', 'error')
     ) x where l.id = x.id and x.n > ${KEEP_PER_APP}`,
  );
}

/**
 * One scheduler pass: claim committed queued requests (FOR UPDATE SKIP
 * LOCKED, so several servers don't take the same one) and make them, a few
 * at a time. Returns the ids made.
 */
export async function webRequestTick(): Promise<string[]> {
  const claimed = (
    await owner.query<PendingRequest & { app_id: number }>(
      `update meta.web_request_log l set status = 'running', started_at = now()
        where l.id in (select id from meta.web_request_log where status = 'queued' order by id for update skip locked limit ${PER_PASS})
        returning l.id, l.app_id, l.source, l.params, l.url, l.method, l.headers, l.body, l.credential, l.timeout_s`,
    )
  ).rows.sort((a, b) => Number(a.id) - Number(b.id));
  const queue = [...claimed];
  const worker = async () => {
    for (let r = queue.shift(); r; r = queue.shift()) await finish(r.id, await execute(r.app_id, r));
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, worker));
  await purgeWebRequests();
  await purgeUnpacked();
  return claimed.map((r) => r.id);
}
