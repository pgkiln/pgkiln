// Object storage for file items (APEX 26.1: File Browse items can store files
// in object storage). A file item with config.object_store keeps its files in
// an S3-compatible bucket (Amazon S3, MinIO, Cloudflare R2, Wasabi, OCI's S3
// compatibility API, …) instead of a bytea column: the item's source column
// holds the object's key. Requests are signed with AWS Signature Version 4
// using a web credential of type aws_sigv4 (access key id in "user name",
// secret access key as the secret, the region in "scope"), and go through
// the server's web client, so the host allow-list and the private-address
// checks apply (src/webclient.ts).
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { decryptSecret } from './secrets.ts';
import { WebError, webRequest } from './webclient.ts';
import { credentialValidFor, loadCredential } from './websources.ts';

export interface ObjectStoreConfig {
  /** the bucket's URL: https://s3.eu-west-1.amazonaws.com/my-bucket, https://my-bucket.s3.amazonaws.com, http://minio:9000/my-bucket */
  url: string;
  /** a web credential of type aws_sigv4 */
  credential: string;
  /** keys start with this, e.g. "photos/" */
  prefix?: string;
}

/** The item's object store, or null when it stores files in the database. */
export function objectStoreOf(config: Record<string, any> | null | undefined): ObjectStoreConfig | null {
  const o = config?.object_store;
  return o && typeof o === 'object' && typeof o.url === 'string' && typeof o.credential === 'string' ? (o as ObjectStoreConfig) : null;
}

/** What's wrong with an object_store configuration, or null. */
export function objectStoreProblem(o: unknown): string | null {
  if (o === undefined || o === null) return null;
  if (typeof o !== 'object') return 'object_store: {"url": "https://…/bucket", "credential": "NAME", "prefix": "folder/"}.';
  const c = o as Record<string, unknown>;
  try {
    const u = new URL(String(c.url));
    if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error();
  } catch {
    return 'object_store.url: the bucket\'s http(s) URL, without user, query or fragment.';
  }
  if (typeof c.credential !== 'string' || !/^[A-Z][A-Z0-9_]{0,59}$/i.test(c.credential)) return 'object_store.credential: the name of a web credential of type aws_sigv4.';
  if (c.prefix !== undefined && (typeof c.prefix !== 'string' || !/^[A-Za-z0-9!_.*'()/-]{0,200}$/.test(c.prefix) || c.prefix.includes('..') || c.prefix.startsWith('/')))
    return 'object_store.prefix: letters, digits and / _ . - ! * \' ( ), e.g. "photos/".';
  return null;
}

/** A new key for a file: prefix, a random id, the file's name. */
export function newObjectKey(o: ObjectStoreConfig, filename: string) {
  const safe = filename.normalize('NFKD').replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(-100) || 'file';
  return `${o.prefix ?? ''}${randomUUID()}/${safe}`;
}

// ---------------------------------------------------------------- Signature Version 4

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();
/** RFC 3986 encoding, as SigV4 wants it (also for !'()*). */
const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface SignInput {
  method: string;
  url: URL;
  headers: Record<string, string>;
  payloadHash: string;
  accessKey: string;
  secretKey: string;
  region: string;
  service?: string;
  /** yyyymmddThhmmssZ */
  amzDate: string;
}

/** The Authorization header of an AWS Signature Version 4 request (headers must include host and x-amz-date). */
export function signV4(i: SignInput) {
  const service = i.service ?? 's3';
  const date = i.amzDate.slice(0, 8);
  const headers = Object.entries(i.headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')] as const).sort(([a], [b]) => (a < b ? -1 : 1));
  const signedHeaders = headers.map(([k]) => k).join(';');
  const query = [...i.url.searchParams].map(([k, v]) => [rfc3986(k), rfc3986(v)]).sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
  // S3: the path as given (already encoded once), not normalised
  const canonical = [i.method.toUpperCase(), i.url.pathname || '/', query, headers.map(([k, v]) => `${k}:${v}\n`).join(''), signedHeaders, i.payloadHash].join('\n');
  const scope = `${date}/${i.region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', i.amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${i.secretKey}`, date), i.region), service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${i.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

// ---------------------------------------------------------------- requests


async function credentialFor(appId: number, name: string) {
  const c = await loadCredential(appId, name);
  if (c.type !== 'aws_sigv4') throw new WebError(`Web credential ${c.name} is not of type aws_sigv4 (an object store needs an access key).`);
  if (!c.secret_enc || !c.username) throw new WebError(`Web credential ${c.name} has no access key yet: enter it in the builder (Shared Components → Web credentials).`);
  return c;
}

/** The object's URL: the bucket URL and the key, each segment encoded. */
export const objectUrl = (o: ObjectStoreConfig, key: string) => `${o.url.replace(/\/+$/, '')}/${key.split('/').map(rfc3986).join('/')}`;

async function send(appId: number, o: ObjectStoreConfig, method: 'PUT' | 'GET' | 'DELETE', key: string, body?: Buffer, contentType?: string) {
  const cred = await credentialFor(appId, o.credential);
  const url = new URL(objectUrl(o, key));
  if (!credentialValidFor(cred, url.toString())) throw new WebError(`Web credential ${cred.name} is not valid for ${url.origin}.`);
  const payloadHash = sha256(body ?? '');
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const headers: Record<string, string> = {
    host: url.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    ...(body ? { 'content-type': contentType || 'application/octet-stream', 'content-length': String(body.length) } : {}),
  };
  const authorization = signV4({ method, url, headers, payloadHash, accessKey: cred.username!, secretKey: decryptSecret(cred.secret_enc!), region: cred.scope || 'us-east-1', amzDate });
  const res = await webRequest(url.toString(), {
    method,
    headers: { ...Object.fromEntries(Object.entries(headers).filter(([k]) => k !== 'host')), authorization, 'accept-encoding': 'identity' },
    secretHeaders: ['authorization'],
    body,
    timeoutMs: 60_000,
    maxBytes: method === 'GET' ? Number(process.env.MAX_UPLOAD_MB ?? 10) * 1024 * 1024 + 1024 : 100_000,
    allowLarge: true,
  });
  return res;
}

/** Store a file; returns its key. */
export async function putObject(appId: number, o: ObjectStoreConfig, filename: string, content: Buffer, mime: string) {
  const key = newObjectKey(o, filename);
  const res = await send(appId, o, 'PUT', key, content, mime);
  if (res.status < 200 || res.status >= 300) throw new WebError(`The object store refused the file (HTTP ${res.status}).`, res.status);
  return key;
}

/** A stored file's content, or null when it is not there. */
export async function getObject(appId: number, o: ObjectStoreConfig, key: string) {
  const res = await send(appId, o, 'GET', key);
  if (res.status === 404) return null;
  if (res.status < 200 || res.status >= 300) throw new WebError(`The object store did not return the file (HTTP ${res.status}).`, res.status);
  return res.body;
}

/** Remove a stored file (a missing one is fine). */
export async function deleteObject(appId: number, o: ObjectStoreConfig, key: string) {
  const res = await send(appId, o, 'DELETE', key);
  if (res.status !== 404 && (res.status < 200 || res.status >= 300)) throw new WebError(`The object store did not remove the file (HTTP ${res.status}).`, res.status);
}

