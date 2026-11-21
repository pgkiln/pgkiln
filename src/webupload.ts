import { call, type CallOptions } from './websources.ts';
import { WebError, type WebResponse } from './webclient.ts';

// (sprint 243, MG-17, migration 200) Binary request bodies: a file sent to a web service (a file API, an upload
// session of Microsoft Graph, an object store with a bearer token). meta.web_request(..., p_body_blob) queues one;
// src/webrequests.ts execute() sends it with sendBinary(). Other server code that sends a file (object storage
// providers) uses sendBinary() too.
//
// Everything goes through websources.call(), so a binary body passes the same checks as a text one: the host
// allow-list (PGKILN_REST_ALLOWED_HOSTS / PGKILN_REST_PRIVATE_HOSTS), the address checks at connect time, the
// workspace's network access list, redirects, and the web credential's "valid for" URLs (OAuth2 tokens renewed
// once on 401). The body's size limit is PGKILN_REST_MAX_UPLOAD_BYTES (default 25 MB), separate from the 1 MB of a
// text body and from the response limit PGKILN_REST_MAX_BYTES.
//
// With chunkBytes the body is PUT in consecutive ranges (Content-Range: bytes a-b/total), as a resumable upload URL
// expects (Graph: createUploadSession, ranges a multiple of 320 KiB, at most 60 MiB). An answer 202 before the last
// range may name the next range the service expects (Graph: {"nextExpectedRanges": ["26-"]}): the next range starts
// there. Any other answer than 202 before the last range ends the upload with that answer (a 200 or 201: the
// service has the whole file already; an error status: the caller's result, retried by the outbox for 5xx/429).

/** The largest binary body (PGKILN_REST_MAX_UPLOAD_BYTES, default 25 MB). */
export const maxUploadBytes = () => {
  const n = Number(process.env.PGKILN_REST_MAX_UPLOAD_BYTES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 25 * 1024 * 1024;
};

/** Range sizes a chunked upload accepts (64 KiB to 60 MiB, as migration 200 checks). */
export const MIN_CHUNK = 65_536;
export const MAX_CHUNK = 62_914_560;

export interface BinaryOptions extends Omit<CallOptions, 'body' | 'method'> {
  /** POST, PUT or PATCH (default PUT); a chunked upload is always PUT */
  method?: string;
  body: Buffer;
  /** the body's media type (default: a content-type in headers, else application/octet-stream) */
  contentType?: string;
  /** PUT the body in ranges of this many bytes */
  chunkBytes?: number | null;
  /** a lower size limit (default and at most maxUploadBytes()) */
  maxBytes?: number;
}

/** The first byte of nextExpectedRanges in a 202 answer (Graph upload sessions), or null. */
export function nextExpected(res: WebResponse): number | null {
  try {
    const json = JSON.parse(res.body.toString('utf8')) as { nextExpectedRanges?: unknown };
    const first = Array.isArray(json?.nextExpectedRanges) ? json.nextExpectedRanges[0] : undefined;
    const m = typeof first === 'string' ? /^(\d+)-/.exec(first) : null;
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Send a binary body (see the top of this file). Throws a WebError when the request can't be made (too large, the
 * allow-list, a credential); an answer with any status code is returned.
 */
export async function sendBinary(o: BinaryOptions): Promise<WebResponse> {
  const limit = Math.min(o.maxBytes ?? maxUploadBytes(), maxUploadBytes());
  if (o.body.length > limit) throw new WebError(`The binary body is larger than ${limit} bytes (PGKILN_REST_MAX_UPLOAD_BYTES).`);
  const method = (o.chunkBytes ? 'PUT' : (o.method ?? 'PUT')).toUpperCase();
  if (!['POST', 'PUT', 'PATCH'].includes(method)) throw new WebError(`A binary body is sent with POST, PUT or PATCH, not ${method}.`);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.headers ?? {})) if (!/^content-(length|range)$/i.test(k)) headers[k.toLowerCase()] = v;
  headers['content-type'] = o.contentType || headers['content-type'] || 'application/octet-stream';
  const send = (body: Buffer, extra: Record<string, string> = {}) =>
    call({ ...o, method, body, headers: { ...headers, 'content-length': String(body.length), ...extra } });
  if (!o.chunkBytes || o.body.length <= o.chunkBytes) return send(o.body);
  if (!Number.isInteger(o.chunkBytes) || o.chunkBytes < MIN_CHUNK || o.chunkBytes > MAX_CHUNK)
    throw new WebError(`The range size is ${MIN_CHUNK} to ${MAX_CHUNK} bytes.`);
  const total = o.body.length;
  let start = 0;
  // at most one request per range, and a few more for ranges the service asks for again
  for (let n = 0, most = Math.ceil(total / o.chunkBytes) + 10; n < most; n++) {
    const end = Math.min(start + o.chunkBytes, total);
    const res = await send(o.body.subarray(start, end), { 'content-range': `bytes ${start}-${end - 1}/${total}` });
    if (end >= total || res.status !== 202) return res;
    const next = nextExpected(res);
    start = next !== null && next < total ? next : end;
  }
  throw new WebError('The upload did not finish: the service kept asking for ranges again.');
}
