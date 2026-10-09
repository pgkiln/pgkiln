import { createCipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';
import pg from 'pg';
import { importJWK, SignJWT } from 'jose';
import { owner } from './db.ts';
import { decryptSecret, encryptSecret } from './secrets.ts';
import { list, webRequest, WebError, type HostLists } from './webclient.ts';

// Push notifications (APEX: APEX_PWA.SEND_PUSH_NOTIFICATION; migration 074).
//
// meta.send_push() queues a message in meta.push_message; this file sends it
// to every device (meta.push_subscription) of the user: the payload is
// encrypted for the device (RFC 8291, aes128gcm) and the request carries a
// VAPID token signed with the application's key (RFC 8292). Nothing beyond
// node:crypto and jose (already used for OpenID Connect).
//
// The endpoint URL comes from the browser, so it is checked like every
// outgoing call (src/webclient.ts), against a list of its own: the push
// services of the browsers (PGAPEX_PUSH_HOSTS replaces it), https only,
// public addresses only (PGAPEX_PUSH_PRIVATE_HOSTS: tests).
//
// The sender runs when NOTIFY pgapex_push arrives (meta.send_push, after the
// caller commits) and on every scheduler pass; rows are claimed with
// SKIP LOCKED, so several servers can run it.

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url');
const unb64u = (s: string) => Buffer.from(s, 'base64url');

// ---------------------------------------------------------------- keys

export interface VapidKeys {
  /** uncompressed P-256 point (65 bytes), base64url */
  publicKey: string;
  /** 32 bytes, base64url */
  privateKey: string;
}

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

/** The application's public key; a key pair is made the first time. */
export async function appPublicKey(appId: number): Promise<string> {
  const row = await owner.one<{ public_key: string }>('select public_key from meta.push_key where app_id = $1', [appId]);
  if (row) return row.public_key;
  const k = generateVapidKeys();
  await owner.query('insert into meta.push_key (app_id, public_key, private_key) values ($1, $2, $3) on conflict (app_id) do nothing', [
    appId, k.publicKey, encryptSecret(k.privateKey),
  ]);
  return (await owner.one<{ public_key: string }>('select public_key from meta.push_key where app_id = $1', [appId]))!.public_key;
}

/** New keys: every device has to turn notifications on again, so its subscriptions are removed. */
export async function newAppKeys(appId: number) {
  const k = generateVapidKeys();
  await owner.tx(async (c) => {
    await c.query('delete from meta.push_subscription where app_id = $1', [appId]);
    await c.query(
      `insert into meta.push_key (app_id, public_key, private_key) values ($1, $2, $3)
       on conflict (app_id) do update set public_key = excluded.public_key, private_key = excluded.private_key, created_at = now()`,
      [appId, k.publicKey, encryptSecret(k.privateKey)],
    );
  });
  return k.publicKey;
}

async function appKeys(appId: number): Promise<VapidKeys | null> {
  const row = await owner.one<{ public_key: string; private_key: string }>('select public_key, private_key from meta.push_key where app_id = $1', [appId]);
  return row ? { publicKey: row.public_key, privateKey: decryptSecret(row.private_key) } : null;
}

// ---------------------------------------------------------------- RFC 8291: message encryption

/** RFC 8188 record size of the one record sent */
const RECORD_SIZE = 4096;

/**
 * The encrypted body (aes128gcm) of `payload` for a subscription's keys.
 * `sender` and `salt` are for tests (RFC 8291 section 5); else random.
 */
export function encryptPayload(payload: Buffer, p256dh: string, auth: string, sender?: { privateKey: string }, salt: Buffer = randomBytes(16)): Buffer {
  const uaPublic = unb64u(p256dh);
  const authSecret = unb64u(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length !== 16) throw new Error('The subscription keys are not valid.');
  const as = createECDH('prime256v1');
  if (sender) as.setPrivateKey(unb64u(sender.privateKey));
  else as.generateKeys();
  const asPublic = as.getPublicKey();
  const ecdhSecret = as.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  // one record: the payload, then the delimiter 0x02 of the last record (no padding)
  const c = createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([c.update(Buffer.concat([payload, Buffer.from([2])])), c.final(), c.getAuthTag()]);
  if (ct.length > RECORD_SIZE) throw new Error('The notification is too large.');
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, ct]);
}

// ---------------------------------------------------------------- RFC 8292: VAPID

/** Contact for the push services (RFC 8292 "sub"): PGAPEX_PUSH_SUBJECT, else PUBLIC_URL when https. */
export function vapidSubject() {
  const s = process.env.PGAPEX_PUSH_SUBJECT?.trim();
  if (s && /^(mailto:|https:\/\/)\S+$/.test(s)) return s;
  const pub = process.env.PUBLIC_URL?.trim();
  if (pub && pub.startsWith('https://')) return pub;
  return 'mailto:pgkiln@localhost';
}

export async function vapidHeader(endpoint: string, keys: VapidKeys, now = Date.now()) {
  const pub = unb64u(keys.publicKey);
  const key = await importJWK({ kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: keys.privateKey }, 'ES256');
  const jwt = await new SignJWT({})
    .setProtectedHeader({ typ: 'JWT', alg: 'ES256' })
    .setAudience(new URL(endpoint).origin)
    .setExpirationTime(Math.floor(now / 1000) + 12 * 3600)
    .setSubject(vapidSubject())
    .sign(key);
  return `vapid t=${jwt}, k=${keys.publicKey}`;
}

// ---------------------------------------------------------------- endpoints

/** The browsers' push services. */
export const DEFAULT_PUSH_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com', '*.notify.windows.com'];

export const pushHosts = (): HostLists => ({
  allowed: process.env.PGAPEX_PUSH_HOSTS ? list(process.env.PGAPEX_PUSH_HOSTS) : DEFAULT_PUSH_HOSTS,
  private: list(process.env.PGAPEX_PUSH_PRIVATE_HOSTS),
});

/** Why a subscription from a browser can't be kept (null: it can). */
export function subscriptionProblem(s: { endpoint?: unknown; p256dh?: unknown; auth?: unknown }): string | null {
  if (typeof s.endpoint !== 'string' || s.endpoint.length > 1000) return 'The endpoint is missing or too long.';
  let url: URL;
  try {
    url = new URL(s.endpoint);
  } catch {
    return 'The endpoint is not a URL.';
  }
  const hosts = pushHosts();
  const host = url.hostname.toLowerCase();
  const on = (entries: string[]) => entries.some((e) => (e.startsWith('*.') ? host.endsWith(e.slice(1)) : host === e.replace(/:\d+$/, '')));
  // https only; plain http just for a host of PGAPEX_PUSH_PRIVATE_HOSTS (a test push service)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && on(hosts.private))) return 'The endpoint must be an https URL.';
  if (url.username || url.password || url.hash) return 'The endpoint is not a push service URL.';
  if (!on([...hosts.allowed, ...hosts.private])) return `The push service ${url.host} is not on the server's list (PGAPEX_PUSH_HOSTS).`;
  if (typeof s.p256dh !== 'string' || !/^[A-Za-z0-9_-]{87}$/.test(s.p256dh) || unb64u(s.p256dh)[0] !== 4) return 'The key p256dh is not valid.';
  if (typeof s.auth !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(s.auth)) return 'The key auth is not valid.';
  return null;
}

// ---------------------------------------------------------------- sending

export interface PushPayload {
  title: string;
  body?: string | null;
  url?: string | null;
  tag?: string | null;
}

interface Subscription {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type DeliveryResult = 'ok' | 'gone' | 'retry' | 'error';

/** Send one message to one device. */
export async function deliver(sub: Subscription, keys: VapidKeys, payload: PushPayload, opts: { ttl: number; urgency: string; tag?: string | null }): Promise<{ result: DeliveryResult; message?: string }> {
  try {
    const body = encryptPayload(Buffer.from(JSON.stringify(payload)), sub.p256dh, sub.auth);
    const res = await webRequest(sub.endpoint, {
      method: 'POST',
      headers: {
        authorization: await vapidHeader(sub.endpoint, keys),
        ttl: String(opts.ttl),
        urgency: opts.urgency,
        ...(opts.tag ? { topic: opts.tag } : {}),
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        'content-length': String(body.length),
      },
      secretHeaders: ['authorization'],
      body,
      timeoutMs: 10_000,
      maxBytes: 64_000,
      hosts: pushHosts(),
    });
    if (res.status >= 200 && res.status < 300) return { result: 'ok' };
    // gone, or made with other keys (new keys, or the browser's own reset)
    if (res.status === 404 || res.status === 410 || res.status === 403) return { result: 'gone', message: `HTTP ${res.status}` };
    if (res.status === 429 || res.status >= 500) return { result: 'retry', message: `HTTP ${res.status}` };
    return { result: 'error', message: `HTTP ${res.status} ${res.body.toString('utf8', 0, 200)}`.trim() };
  } catch (e) {
    return { result: e instanceof WebError && /allow-list|private/.test(e.message) ? 'error' : 'retry', message: (e as Error).message };
  }
}

/** Messages per pass, devices at the same time, attempts before giving up. */
const PER_PASS = 50;
const PARALLEL = 5;
const ATTEMPTS = 3;
const KEEP_DAYS = 7;

interface Claimed {
  id: string;
  app_id: number;
  username: string;
  title: string;
  body: string | null;
  url: string | null;
  tag: string | null;
  urgency: string;
  ttl_s: number;
  attempts: number;
}

async function sendMessage(m: Claimed) {
  const finish = (status: string, devices: number, delivered: number, message: string | null) =>
    owner.query(
      `update meta.push_message set status = $2, devices = $3, delivered = $4, message = $5, sent_at = case when $2 = 'sent' then now() end where id = $1`,
      [m.id, status, devices, delivered, message],
    );
  const subs = (
    await owner.query<Subscription>(
      `select s.id, s.endpoint, s.p256dh, s.auth from meta.push_subscription s
         join meta.app a on a.id = s.app_id and a.pwa and a.pwa_push
        where s.app_id = $1 and lower(s.username) = lower($2) order by s.id`,
      [m.app_id, m.username],
    )
  ).rows;
  if (!subs.length) return finish('no_device', 0, 0, null);
  let keys: VapidKeys | null;
  try {
    keys = await appKeys(m.app_id);
  } catch (e) {
    return finish('error', subs.length, 0, (e as Error).message);
  }
  if (!keys) return finish('no_device', 0, 0, 'The application has no keys (no device turned notifications on).');
  const payload: PushPayload = { title: m.title, body: m.body, url: m.url, tag: m.tag };
  const results = await Promise.all(subs.map((s) => deliver(s, keys!, payload, { ttl: m.ttl_s, urgency: m.urgency, tag: m.tag }).then((r) => ({ s, ...r }))));
  for (const r of results) {
    if (r.result === 'ok') await owner.query('update meta.push_subscription set last_sent_at = now(), failures = 0 where id = $1', [r.s.id]);
    else if (r.result === 'gone') await owner.query('delete from meta.push_subscription where id = $1', [r.s.id]);
    else {
      // a device that keeps failing is dropped
      const f = await owner.one<{ failures: number }>('update meta.push_subscription set failures = failures + 1 where id = $1 returning failures', [r.s.id]);
      if (f && f.failures >= 10) await owner.query('delete from meta.push_subscription where id = $1', [r.s.id]);
    }
  }
  const delivered = results.filter((r) => r.result === 'ok').length;
  const problem = results.find((r) => r.result !== 'ok')?.message ?? null;
  if (delivered) return finish('sent', subs.length, delivered, problem);
  // nothing arrived: try again later (sending again to the devices that did get it would show it twice)
  if (results.some((r) => r.result === 'retry') && m.attempts < ATTEMPTS) {
    await owner.query(
      `update meta.push_message set status = 'queued', not_before = now() + make_interval(secs => $2), message = $3 where id = $1`,
      [m.id, 30 * 4 ** (m.attempts - 1), problem],
    );
    return;
  }
  return finish(results.every((r) => r.result === 'gone') ? 'no_device' : 'error', subs.length, 0, problem);
}

/** One pass: claim queued messages, send them, forget old ones. Returns the ids handled. */
export async function pushTick(): Promise<string[]> {
  const claimed = (
    await owner.query<Claimed>(
      `update meta.push_message m set status = 'sending', attempts = attempts + 1, not_before = now()
        where m.id in (select id from meta.push_message where status = 'queued' and not_before <= now()
                        order by id for update skip locked limit ${PER_PASS})
        returning m.id, m.app_id, m.username, m.title, m.body, m.url, m.tag, m.urgency, m.ttl_s, m.attempts`,
    )
  ).rows.sort((a, b) => Number(a.id) - Number(b.id));
  const queue = [...claimed];
  const worker = async () => {
    for (let m = queue.shift(); m; m = queue.shift()) {
      try {
        await sendMessage(m);
      } catch (e) {
        await owner.query(`update meta.push_message set status = 'error', message = $2 where id = $1`, [m.id, (e as Error).message]);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, worker));
  // a server that stopped while sending: its messages go back to the queue after 10 minutes
  await owner.query(`update meta.push_message set status = 'queued' where status = 'sending' and not_before < now() - interval '10 minutes' and attempts < ${ATTEMPTS}`);
  await owner.query(`delete from meta.push_message where requested_at < now() - interval '${KEEP_DAYS} days'`);
  return claimed.map((m) => m.id);
}

let listener: pg.Client | undefined;

/** Send soon after meta.send_push commits (NOTIFY pgapex_push); the scheduler (src/automations.ts) is the fallback. */
export async function startPushListener() {
  if (process.env.AUTOMATIONS === 'off' || listener) return;
  let busy = false;
  let again = false;
  const run = async () => {
    if (busy) return void (again = true);
    busy = true;
    try {
      do {
        again = false;
        await pushTick();
      } while (again);
    } catch (e) {
      console.error('push notifications:', (e as Error).message);
    } finally {
      busy = false;
    }
  };
  try {
    listener = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await listener.connect();
    listener.on('notification', () => void run());
    listener.on('error', (e) => console.error('push listener:', e.message));
    await listener.query('listen pgapex_push');
  } catch (e) {
    console.error('push notifications: no listener, the scheduler sends them:', (e as Error).message);
  }
}
