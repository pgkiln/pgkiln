import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SignJWT } from 'jose';
import { apiRoleProblem, jwtSecret } from './api.ts';
import { owner } from './db.ts';
import { loginMaxFailuresPerIp, loginWindowMinutes } from './security.ts';
import { clientIp, logActivity } from './session.ts';

// OAuth 2.0 client credentials for the REST API (RFC 6749 section 4.4),
// like ORDS: POST /oauth/token with the client id and secret (HTTP Basic
// or form fields) and grant_type=client_credentials returns a short-lived
// JWT that PostgREST accepts. Clients are managed in the builder (REST API
// page) or with meta.oauth_create_client() and friends.

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const same = (a: string | null, b: string) => !!a && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export class OAuthError extends Error {
  constructor(readonly code: 'invalid_request' | 'invalid_client' | 'unsupported_grant_type' | 'invalid_scope', message: string, readonly status = 400) {
    super(message);
  }
}

/** Check a client's id and secret and issue an access token. */
export async function clientToken(clientId: string, clientSecret: string) {
  const c = await owner.one(
    `select c.id, c.name, c.secret_hash, c.previous_secret_hash, c.previous_valid_until > now() as previous_valid,
            c.token_minutes, c.active, a.alias, a.api_role
       from meta.api_client c join meta.app a on a.id = c.app_id
      where c.client_id = $1`,
    [clientId],
  );
  const hash = sha256(clientSecret);
  const valid = !!c && c.active && (same(c.secret_hash, hash) || (c.previous_valid && same(c.previous_secret_hash, hash)));
  if (!valid) throw new OAuthError('invalid_client', 'Unknown client, wrong secret, or the client was revoked.', 401);
  // without an API role the token is for pgkiln's own REST modules only
  const problem = c.api_role ? await apiRoleProblem(c.api_role) : null;
  if (problem) throw new OAuthError('invalid_client', problem, 401);
  await owner.query('update meta.api_client set last_used_at = now() where id = $1', [c.id]);
  const token = await new SignJWT({ ...(c.api_role ? { role: c.api_role } : {}), app: c.alias, app_user: `client:${c.name}`, client_id: clientId })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setJti(randomUUID())
    .setExpirationTime(`${c.token_minutes}m`)
    .sign(jwtSecret());
  return { access_token: token, token_type: 'bearer', expires_in: c.token_minutes * 60, app: c.alias as string };
}

/** Client credentials from HTTP Basic (client_secret_basic) or the body (client_secret_post). */
function credentials(req: FastifyRequest) {
  const body = (req.body ?? {}) as Record<string, string | undefined>;
  const auth = String(req.headers.authorization ?? '');
  if (/^basic /i.test(auth)) {
    const decoded = Buffer.from(auth.slice(6).trim(), 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    if (i < 0) throw new OAuthError('invalid_client', 'Malformed Basic authorization.', 401);
    // RFC 6749 2.3.1: id and secret are form-urlencoded before Basic encoding
    const dec = (s: string) => {
      try {
        return decodeURIComponent(s.replace(/\+/g, ' '));
      } catch {
        return s;
      }
    };
    return { id: dec(decoded.slice(0, i)), secret: dec(decoded.slice(i + 1)) };
  }
  return { id: body.client_id ?? '', secret: body.client_secret ?? '' };
}

async function throttled(ip: string) {
  const r = await owner.one<{ n: number }>(
    `select count(*)::int as n from meta.activity_log where event = 'oauth_failed' and ip = $1 and at > now() - make_interval(mins => $2)`,
    [ip, loginWindowMinutes()],
  );
  return (r?.n ?? 0) >= loginMaxFailuresPerIp();
}

const fail = (reply: FastifyReply, e: OAuthError) => {
  if (e.status === 401) reply.header('www-authenticate', 'Basic realm="pgapex"');
  return reply.code(e.status).header('cache-control', 'no-store').send({ error: e.code, error_description: e.message });
};

export async function oauthRoutes(app: FastifyInstance) {
  app.post('/oauth/token', async (req, reply) => {
    const ip = clientIp(req);
    if (await throttled(ip)) return reply.code(429).header('cache-control', 'no-store').send({ error: 'invalid_client', error_description: 'Too many failed attempts; try again later.' });
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    let id = '';
    try {
      if (body.grant_type !== 'client_credentials') throw new OAuthError('unsupported_grant_type', 'Only grant_type=client_credentials is supported.');
      const cred = credentials(req);
      id = cred.id;
      if (!cred.id || !cred.secret) throw new OAuthError('invalid_client', 'Client authentication is required.', 401);
      const t = await clientToken(cred.id, cred.secret);
      logActivity({ event: 'oauth_token', ip, username: `client:${cred.id}`, detail: t.app });
      return reply.header('cache-control', 'no-store').header('pragma', 'no-cache').send({ access_token: t.access_token, token_type: t.token_type, expires_in: t.expires_in });
    } catch (e) {
      if (!(e instanceof OAuthError)) throw e;
      if (e.code === 'invalid_client') await logActivity({ event: 'oauth_failed', ip, username: `client:${id.slice(0, 60)}`, detail: e.message });
      return fail(reply, e);
    }
  });
}
