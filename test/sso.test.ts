// Single sign-on (OpenID Connect) tests against a mock identity provider
// that runs in-process: discovery, JWKS, and a token endpoint that checks
// the client secret, the redirect URI and PKCE.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner, runtime } from '../src/db.ts';

let app: FastifyInstance;
let idp: FastifyInstance;
let issuer = '';
let appId: number;
const CLIENT_ID = 'pgapex-test';
const SECRET = 'test-secret';
const keys = await generateKeyPair('RS256');
const otherKeys = await generateKeyPair('RS256');

interface Grant {
  challenge: string;
  redirectUri: string;
  claims: JWTPayload;
  sign?: 'other-key';
}
const grants = new Map<string, Grant>();

class Browser {
  cookies = new Map<string, string>();
  lastCsrf = '';
  async request(method: 'GET' | 'POST', url: string, form?: Record<string, string>) {
    const res = await app.inject({
      method,
      url,
      payload: form ? new URLSearchParams(form).toString() : undefined,
      headers: {
        cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
    });
    for (const c of res.cookies as { name: string; value: string; expires?: Date }[]) {
      if (!c.value || (c.expires && c.expires.getTime() < Date.now())) this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    const m = /name="__csrf" value="([^"]+)"/.exec(res.body);
    if (m) this.lastCsrf = m[1];
    return res;
  }
  get(url: string) {
    return this.request('GET', url);
  }
}

/** Start SSO in pgapex, let the "user" authenticate at the mock IdP, and return the callback URL. */
async function startLogin(b: Browser) {
  const start = await b.get('/a/hr/sso/mock?next=/a/hr/1');
  assert.equal(start.statusCode, 302, start.body.slice(0, 200));
  const auth = new URL(String(start.headers.location));
  assert.equal(auth.origin + auth.pathname, `${issuer}/authorize`);
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  return auth;
}

async function ssoLogin(b: Browser, claims: JWTPayload, tweak: { nonce?: string; state?: string; sign?: 'other-key' } = {}) {
  const auth = await startLogin(b);
  const code = randomBytes(12).toString('hex');
  grants.set(code, {
    challenge: auth.searchParams.get('code_challenge')!,
    redirectUri: auth.searchParams.get('redirect_uri')!,
    claims: { nonce: tweak.nonce ?? auth.searchParams.get('nonce')!, ...claims },
    sign: tweak.sign,
  });
  return b.get(`/sso/callback/mock?${new URLSearchParams({ code, state: tweak.state ?? auth.searchParams.get('state')! })}`);
}

before(async () => {
  idp = Fastify();
  await idp.register(formbody);
  idp.get('/.well-known/openid-configuration', async () => ({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    token_endpoint_auth_methods_supported: ['client_secret_basic'],
  }));
  idp.get('/jwks', async () => ({ keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }] }));
  idp.post('/token', async (req, reply) => {
    const body = req.body as Record<string, string>;
    const basic = Buffer.from(String(req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString();
    if (basic !== `${CLIENT_ID}:${SECRET}`) return reply.code(401).send({ error: 'invalid_client' });
    const g = grants.get(body.code);
    grants.delete(body.code);
    if (!g) return reply.code(400).send({ error: 'invalid_grant' });
    if (body.redirect_uri !== g.redirectUri) return reply.code(400).send({ error: 'invalid_grant' });
    const challenge = createHash('sha256').update(body.code_verifier ?? '').digest('base64url');
    if (challenge !== g.challenge) return reply.code(400).send({ error: 'invalid_grant', error_description: 'PKCE' });
    const id_token = await new SignJWT({ ...g.claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(String(g.claims.iss ?? issuer))
      .setAudience(String(g.claims.aud ?? CLIENT_ID))
      .setIssuedAt()
      .setExpirationTime(Number(g.claims.exp ?? Math.floor(Date.now() / 1000) + 300))
      .sign(g.sign === 'other-key' ? otherKeys.privateKey : keys.privateKey);
    return { access_token: 'x', token_type: 'Bearer', id_token };
  });
  await idp.listen({ port: 0, host: '127.0.0.1' });
  issuer = `http://127.0.0.1:${(idp.server.address() as AddressInfo).port}`;

  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  await owner.query(
    `insert into meta.auth_provider (name, display_name, issuer, client_id, client_secret, groups_claim)
     values ('mock', 'Mock IdP', $1, $2, $3, 'groups')`,
    [issuer, CLIENT_ID, SECRET],
  );
  await owner.query(`update meta.app set sso_providers = '{mock}' where id = $1`, [appId]);
  await owner.query(`insert into meta.app_group_role (app_id, group_name, role) values ($1, 'hr-admins', 'admin')`, [appId]);
});

after(async () => {
  await owner.query(`delete from meta.account where username like 'sso\\_%'`);
  await owner.query(`delete from meta.auth_provider where name = 'mock'`);
  await owner.query(`update meta.app set sso_providers = '{}', local_login = true where id = $1`, [appId]);
  await owner.query(`delete from meta.app_group_role where app_id = $1`, [appId]);
  await owner.query(`delete from meta.activity_log where detail like 'sso:mock%'`);
  await app.close();
  await idp.close();
  await closePools();
});

describe('single sign-on (OpenID Connect)', () => {
  test('the login page offers the provider', async () => {
    const res = await new Browser().get('/a/hr/login');
    assert.match(res.body, /Sign in with Mock IdP/);
  });

  test('an existing account signs in and is linked by subject', async () => {
    const b = new Browser();
    const res = await ssoLogin(b, { sub: 'sub-king', preferred_username: 'king' });
    assert.equal(res.statusCode, 303, res.body.slice(0, 300));
    assert.equal(res.headers.location, '/a/hr/1');
    assert.equal((await b.get('/a/hr/9')).statusCode, 200, 'king keeps his admin role');
    const link = await owner.one(`select a.username from meta.account_identity i join meta.account a on a.id = i.account_id where i.subject = 'sub-king'`);
    assert.equal(link.username, 'king');
  });

  test('a linked account cannot be taken over by another subject with the same username', async () => {
    const res = await ssoLogin(new Browser(), { sub: 'sub-attacker', preferred_username: 'king' });
    assert.equal(res.statusCode, 403);
    assert.match(res.body, /already linked/);
  });

  test('unknown users are refused unless auto-create is on; groups map to roles', async () => {
    const refused = await ssoLogin(new Browser(), { sub: 'sub-new', preferred_username: 'sso_newbie', groups: ['hr-admins'] });
    assert.equal(refused.statusCode, 403);
    assert.match(refused.body, /no account/);
    await owner.query(`update meta.auth_provider set auto_create = true where name = 'mock'`);
    try {
      const b = new Browser();
      const ok = await ssoLogin(b, { sub: 'sub-new', preferred_username: 'sso_newbie', name: 'New Bie', groups: ['/hr-admins'] });
      assert.equal(ok.statusCode, 303, ok.body.slice(0, 300));
      assert.equal((await b.get('/a/hr/9')).statusCode, 200, 'admin via group mapping');
      const acc = await owner.one(`select display_name, password_hash from meta.account where username = 'sso_newbie'`);
      assert.equal(acc.display_name, 'New Bie');
      assert.equal(acc.password_hash, null, 'SSO-created accounts have no password');
    } finally {
      await owner.query(`update meta.auth_provider set auto_create = false where name = 'mock'`);
    }
  });

  test('accounts without access and without mapped groups are refused', async () => {
    await owner.query(`insert into meta.account (username) values ('sso_outsider')`);
    const res = await ssoLogin(new Browser(), { sub: 'sub-outsider', preferred_username: 'sso_outsider', groups: ['other-team'] });
    assert.equal(res.statusCode, 403);
    assert.match(res.body, /no access/);
  });

  test('tokens with a wrong nonce, audience, issuer, signature or expiry are rejected', async () => {
    const cases: [string, JWTPayload, { nonce?: string; sign?: 'other-key' }][] = [
      ['nonce', { sub: 'sub-king', preferred_username: 'king' }, { nonce: 'forged' }],
      ['audience', { sub: 'sub-king', preferred_username: 'king', aud: 'another-client' }, {}],
      ['issuer', { sub: 'sub-king', preferred_username: 'king', iss: 'https://evil.example' }, {}],
      ['signature', { sub: 'sub-king', preferred_username: 'king' }, { sign: 'other-key' }],
      ['expiry', { sub: 'sub-king', preferred_username: 'king', exp: Math.floor(Date.now() / 1000) - 3600 }, {}],
    ];
    for (const [what, claims, tweak] of cases) {
      const res = await ssoLogin(new Browser(), claims, tweak);
      assert.equal(res.statusCode, 403, `bad ${what} must be rejected`);
    }
  });

  test('a callback cannot be replayed or completed in another browser (login CSRF)', async () => {
    const victim = new Browser();
    const attacker = new Browser();
    const auth = await startLogin(attacker);
    const code = randomBytes(12).toString('hex');
    grants.set(code, {
      challenge: auth.searchParams.get('code_challenge')!,
      redirectUri: auth.searchParams.get('redirect_uri')!,
      claims: { sub: 'sub-king', preferred_username: 'king', nonce: auth.searchParams.get('nonce')! },
    });
    const url = `/sso/callback/mock?${new URLSearchParams({ code, state: auth.searchParams.get('state')! })}`;
    const res = await victim.get(url);
    assert.equal(res.statusCode, 403);
    assert.match(res.body, /another browser/);
    // the state was consumed: the attacker can't use it either
    assert.equal((await attacker.get(url)).statusCode, 403);
  });

  test('roles from groups are stored on the session only', async () => {
    const b = new Browser();
    await owner.query(`insert into meta.account (username) values ('sso_member') on conflict do nothing`);
    await ssoLogin(b, { sub: 'sub-member', preferred_username: 'sso_member', groups: ['hr-admins'] });
    const s = await runtime.one(`select roles from meta.session where username = 'sso_member' order by created_at desc limit 1`);
    assert.deepEqual(s.roles, ['admin']);
    const access = await owner.one(`select count(*)::int as n from meta.app_access aa join meta.account a on a.id = aa.account_id where a.username = 'sso_member'`);
    assert.equal(access.n, 0, 'no permanent access row was created');
  });

  test('password sign-in can be switched off per application', async () => {
    await owner.query(`update meta.app set local_login = false where id = $1`, [appId]);
    try {
      const b = new Browser();
      const page = await b.get('/a/hr/login');
      assert.doesNotMatch(page.body, /name="password"/);
      const res = await b.request('POST', '/a/hr/login', { __csrf: b.lastCsrf, username: 'king', password: 'king' });
      assert.equal(res.statusCode, 403);
    } finally {
      await owner.query(`update meta.app set local_login = true where id = $1`, [appId]);
    }
  });
});
