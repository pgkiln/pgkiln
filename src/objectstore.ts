// Object storage for file items (APEX 26.1: File Browse items can store files
// in object storage). A file item with config.object_store keeps its files in
// an S3-compatible bucket (Amazon S3, MinIO, Cloudflare R2, Wasabi, OCI's S3
// compatibility API, …) instead of a bytea column: the item's source column
// holds the object's key. Requests are signed with AWS Signature Version 4
// using a web credential of type aws_sigv4 (access key id in "user name",
// secret access key as the secret, the region in "scope"), and go through
// the server's web client, so the host allow-list and the private-address
// checks apply (src/webclient.ts).
// (sprint 244, MG-29) "provider": "graph" stores them in OneDrive / SharePoint instead: src/objectstore-graph.ts.
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { decryptSecret } from './secrets.ts';
import { WebError, webRequest } from './webclient.ts';
import { scopeForApp } from './network-acl.ts';
import { credentialValidFor, loadCredential } from './websources.ts';
import { deleteGraph, getGraph, graphProblem, putGraph, type GraphStoreConfig } from './objectstore-graph.ts';
import { owner } from './db.ts';

/** (sprint 253, MG-31) An &ITEM. substitution in object_store.folder / prefix. */
export const SUBST = /&([A-Za-z][A-Za-z0-9_]*)\./g;

/** (sprint 253) The part of a folder / prefix before its first substitution, up to its last "/": every record's subfolder lies below it. */
export function staticPart(path: string | undefined) {
  const s = path ?? '';
  const at = s.search(SUBST);
  return at < 0 ? s : s.slice(0, s.lastIndexOf('/', at) + 1);
}

/**
 * (sprint 253, MG-31) The store with the &ITEM. substitutions of its folder (graph) or prefix (S3) replaced by
 * `value(name)` (session state at upload time). Each value becomes (part of) one path segment: characters the
 * store does not take, "/", "\\", control characters and runs of dots become "_"; an empty value becomes "_".
 */
export function resolveStore(o: ObjectStoreConfig, value: (name: string) => string | null | undefined): ObjectStoreConfig {
  const graph = o.provider === 'graph';
  const path = graph ? o.folder : o.prefix;
  if (!path || !path.match(SUBST)) return o;
  const bad = graph ? /[^\p{L}\p{N} _.()&'+,!#$%@=~-]/gu : /[^A-Za-z0-9!_.*'()-]/g;
  const resolved = path.replace(SUBST, (_, name: string) =>
    String(value(name.toUpperCase()) ?? '').trim().replace(bad, '_').replace(/\.{2,}/g, '_').replace(/\.$/, '_').slice(0, 100) || '_');
  return graph ? { ...o, folder: resolved } : { ...o, prefix: resolved };
}

/** (sprint 244) A store: an S3-compatible bucket (provider "s3", the default) or a OneDrive / SharePoint folder ("graph"). */
export type ObjectStoreConfig = S3StoreConfig | GraphStoreConfig;

export interface S3StoreConfig {
  provider?: 's3';
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
  if (!o || typeof o !== 'object' || typeof o.credential !== 'string') return null;
  if (o.provider === 'graph') return o as GraphStoreConfig;
  return (o.provider === undefined || o.provider === 's3') && typeof o.url === 'string' ? (o as S3StoreConfig) : null;
}

/** What's wrong with an object_store configuration, or null. */
export function objectStoreProblem(o: unknown): string | null {
  if (o === undefined || o === null) return null;
  if (typeof o !== 'object') return 'object_store: {"url": "https://…/bucket", "credential": "NAME", "prefix": "folder/"}.';
  const c = o as Record<string, unknown>;
  // (sprint 244) OneDrive / SharePoint through Microsoft Graph
  if (c.provider === 'graph') return graphProblem(c);
  if (c.provider !== undefined && c.provider !== 's3') return 'object_store.provider: "s3" (an S3-compatible bucket, the default) or "graph" (OneDrive / SharePoint).';
  try {
    const u = new URL(String(c.url));
    if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error();
  } catch {
    return 'object_store.url: the bucket\'s http(s) URL, without user, query or fragment.';
  }
  if (typeof c.credential !== 'string' || !/^[A-Z][A-Z0-9_]{0,59}$/i.test(c.credential)) return 'object_store.credential: the name of a web credential of type aws_sigv4.';
  // (sprint 253) &ITEM. substitutions are checked as a plain segment
  const prefix = typeof c.prefix === 'string' ? c.prefix.replace(SUBST, 'x') : c.prefix;
  if (prefix !== undefined && (typeof prefix !== 'string' || !/^[A-Za-z0-9!_.*'()/-]{0,200}$/.test(prefix) || prefix.includes('..') || prefix.startsWith('/')))
    return 'object_store.prefix: letters, digits and / _ . - ! * \' ( ) and &ITEM. substitutions, e.g. "photos/" or "orders/&P3_ID./".';
  return null;
}

/** A new key for a file: prefix, a random id, the file's name. */
export function newObjectKey(o: S3StoreConfig, filename: string) {
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
export const objectUrl = (o: S3StoreConfig, key: string) => `${o.url.replace(/\/+$/, '')}/${key.split('/').map(rfc3986).join('/')}`;

async function send(appId: number, o: S3StoreConfig, method: 'PUT' | 'GET' | 'DELETE', key: string, body?: Buffer, contentType?: string) {
  // (sprint 253) a key (from the application's table or SQL) stays below the store's prefix (its static part):
  // no other prefix, no dot segment (the URL would resolve it out of the bucket)
  if (!key.startsWith(staticPart(o.prefix)) || key.split('/').some((s) => s === '.' || s === '..'))
    throw new WebError(`The key ${key.slice(0, 200)} is not below the prefix of the object store.`);
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
    // (sprint 118) the workspace's network access list
    scope: await scopeForApp(appId, `object storage (web credential ${cred.name})`),
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
  // checked here too: a configuration may have come in through SQL or an import
  const problem = objectStoreProblem(o);
  if (problem) throw new WebError(problem);
  if (o.provider === 'graph') return putGraph(appId, o, filename, content, mime);
  const key = newObjectKey(o, filename);
  const res = await send(appId, o, 'PUT', key, content, mime);
  if (res.status < 200 || res.status >= 300) throw new WebError(`The object store refused the file (HTTP ${res.status}).`, res.status);
  return key;
}

/** A stored file's content, or null when it is not there. */
export async function getObject(appId: number, o: ObjectStoreConfig, key: string) {
  if (o.provider === 'graph') return getGraph(appId, o, key);
  const res = await send(appId, o, 'GET', key);
  if (res.status === 404) return null;
  if (res.status < 200 || res.status >= 300) throw new WebError(`The object store did not return the file (HTTP ${res.status}).`, res.status);
  return res.body;
}

/** Remove a stored file (a missing one is fine). */
export async function deleteObject(appId: number, o: ObjectStoreConfig, key: string) {
  if (o.provider === 'graph') return deleteGraph(appId, o, key);
  const res = await send(appId, o, 'DELETE', key);
  if (res.status !== 404 && (res.status < 200 || res.status >= 300)) throw new WebError(`The object store did not remove the file (HTTP ${res.status}).`, res.status);
}


/**
 * (sprint 253, MG-30) A file in the object store of the file item `item` of application `appId` (a document
 * template's <img src="stored:ITEM:key">, an attachment of meta.add_mail_attachment_stored), or null when it is not
 * there. Refused: an item that is not a file item of that application, or has no object store; the key must lie in
 * the store (prefix / folder) as for a download.
 */
export async function storedObject(appId: number, item: string, key: string) {
  const r = await owner.one<{ config: Record<string, any> | null }>(
    `select i.config from meta.item i join meta.page p on p.id = i.page_id
      where p.app_id = $1 and i.name = upper($2) and i.type = 'file' and i.config ? 'object_store' order by p.page_no limit 1`, [appId, item.slice(0, 128)]);
  const store = objectStoreOf(r?.config);
  if (!store) throw new WebError(`${item} is not a file item with an object store in this application.`);
  return getObject(appId, store, key);
}
