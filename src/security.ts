import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { owner } from './db.ts';

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
 * another user. Must match meta.url_checksum() in 001_meta.sql.
 */
export function urlChecksum(appId: number, pageNo: number, user: string, items: Record<string, string>) {
  const norm = Object.fromEntries(Object.entries(items).map(([k, v]) => [k.toUpperCase(), v ?? '']));
  const canonical = Object.keys(norm)
    .sort()
    .map((k) => `${k}=${norm[k]}`)
    .join('&');
  return createHmac('sha256', urlSecret).update(`${appId}:${pageNo}:${user.toLowerCase()}:${canonical}`).digest('hex').slice(0, 32);
}

export function checksumValid(expected: string, given: string | undefined) {
  if (!given || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}

export const newToken = () => randomBytes(32).toString('base64url');
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');


// Login throttling: failures per user and per IP address in a sliding window.
export const LOGIN_WINDOW_MINUTES = Number(process.env.LOGIN_WINDOW_MINUTES ?? 15);
export const LOGIN_MAX_FAILURES_PER_USER = Number(process.env.LOGIN_MAX_FAILURES_PER_USER ?? 5);
export const LOGIN_MAX_FAILURES_PER_IP = Number(process.env.LOGIN_MAX_FAILURES_PER_IP ?? 50);

declare module 'fastify' {
  interface FastifyRequest {
    /** The CSP nonce of this response: the only inline <style> allowed carries it. */
    cspNonce: string;
  }
}

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
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    const type = String(reply.getHeader('content-type') ?? '');
    if (type.startsWith('text/html')) {
      // No inline scripts and no inline styles: behaviour lives in /static/app.js,
      // styling in /static/app.css. The only <style> a page has (theme colours,
      // chart geometry) carries this response's nonce; style="" attributes are refused.
      reply.header(
        'Content-Security-Policy',
        `default-src 'self'; script-src 'self'; style-src 'self' 'nonce-${req.cspNonce}'; img-src 'self' data:; ` +
          "frame-ancestors 'self'; form-action 'self'; base-uri 'none'; object-src 'none'",
      );
      // Pages contain user data: never cache them (e.g. back button after sign-out).
      reply.header('Cache-Control', 'no-store');
    }
    if (process.env.COOKIE_SECURE === 'true') reply.header('Strict-Transport-Security', 'max-age=31536000');
    return payload;
  });
}
