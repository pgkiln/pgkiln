import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { instanceSetting } from './instance.ts';
import { owner } from './db.ts';
import { tileOrigin } from './maptiles.ts';

let urlSecret = '';

/** Load instance secrets with the owner connection (the runtime role cannot read them). */
export async function loadSecrets() {
  const row = await owner.one(`select value from meta.instance_setting where name = 'url_secret'`);
  if (!row) throw new Error('meta.instance_setting.url_secret missing: run npm run db:migrate');
  urlSecret = row.value;
}

/**
 * Checksum for item values passed in a URL (session state protection).
 * Bound to app, page and user, so a link cannot be edited or reused by
 * another user. Must match meta.url_checksum() (075_security_review.sql).
 * Every name and value carries its length in bytes, so a value containing
 * "&NAME=" can't stand for two items.
 */
export function urlChecksum(appId: number, pageNo: number, user: string, items: Record<string, string>) {
  const norm = Object.fromEntries(Object.entries(items).map(([k, v]) => [k.toUpperCase(), v ?? '']));
  const part = (s: string) => `${Buffer.byteLength(s)}:${s}`;
  const canonical = Object.keys(norm)
    .sort()
    .map((k) => `${part(k)}=${part(norm[k])}`)
    .join('&');
  return createHmac('sha256', urlSecret).update(`v2:${appId}:${pageNo}:${user.toLowerCase()}:${canonical}`).digest('hex').slice(0, 32);
}

/** A signature for a value the server hands out in a URL and reads back (e.g. a report's keyset position). */
export function signText(scope: string, text: string) {
  return createHmac('sha256', urlSecret).update(`${scope}\n${text}`).digest('base64url').slice(0, 22);
}

export function checksumValid(expected: string, given: string | undefined) {
  if (!given || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}

/**
 * Which X-Forwarded-For entries to believe (TRUST_PROXY). "true" means one proxy: the address that proxy
 * saw (the last entry) is the client, so a client can't put a made-up address in front of it and dodge the
 * per-IP sign-in throttling. A number is that many proxies in a row; addresses or subnets (comma separated)
 * trust exactly those proxies. Anything else: no proxy, the socket's address.
 */
export function trustProxySetting(v: string | undefined): boolean | string | ((addr: string, hop: number) => boolean) {
  const t = (v ?? '').trim();
  // hop 0 is the socket's peer, hop 1 the address it forwarded, …: believe that many proxies
  const hops = t === 'true' ? 1 : /^\d{1,2}$/.test(t) ? Number(t) : null;
  if (hops !== null) return hops > 0 ? (_addr: string, hop: number) => hop < hops : false;
  if (/^[0-9a-f.:/,\s]+$/i.test(t) && /[.:]/.test(t)) return t.split(',').map((x) => x.trim()).filter(Boolean).join(',');
  return false;
}

export const newToken = () => randomBytes(32).toString('base64url');
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');


// Login throttling: failures per user and per IP address in a sliding window
// (instance settings: the builder's value, else LOGIN_* environment variables, else defaults).
export const loginWindowMinutes = () => instanceSetting('login_window_minutes');
export const loginMaxFailuresPerUser = () => instanceSetting('login_max_failures_user');
export const loginMaxFailuresPerIp = () => instanceSetting('login_max_failures_ip');

declare module 'fastify' {
  interface FastifyRequest {
    /** The CSP nonce of this response: the only inline <style> allowed carries it. */
    cspNonce: string;
  }
}

// map regions load their tiles from this origin (MAP_TILE_URL)
const MAP_TILES = tileOrigin();

/** Security headers for every response. */
export function securityHeaders(app: FastifyInstance) {
  app.decorateRequest('cspNonce', '');
  app.addHook('onRequest', async (req) => {
    req.cspNonce = randomBytes(18).toString('base64');
  });
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('X-Frame-Options', 'SAMEORIGIN');
    // the app's own pages may use the camera (photos, scanning) and the position (location items); nothing else may
    reply.header('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(self)');
    const type = String(reply.getHeader('content-type') ?? '');
    if (type.startsWith('text/html')) {
      // No inline scripts and no inline styles: behaviour lives in /static/app.js,
      // styling in /static/app.css. The only <style> a page has (theme colours,
      // chart geometry) carries this response's nonce; style="" attributes are refused.
      reply.header(
        'Content-Security-Policy',
        `default-src 'self'; script-src 'self'; style-src 'self' 'nonce-${req.cspNonce}'; img-src 'self' data:${MAP_TILES ? ` ${MAP_TILES}` : ''}; ` +
          "frame-ancestors 'self'; form-action 'self'; base-uri 'none'; object-src 'none'",
      );
      // Pages contain user data: never cache them (e.g. back button after sign-out).
      reply.header('Cache-Control', 'no-store');
    }
    if (process.env.COOKIE_SECURE === 'true') reply.header('Strict-Transport-Security', 'max-age=31536000');
    return payload;
  });
}
