// (sprint 132, SEC-4) Making sure an identity provider really did multi-factor sign-in, against an in-process mock
// OpenID Connect provider: amr / acr checked with "Require multi-factor", acr_values requested, step-up through the
// provider (prompt=login, max_age=0, auth_time), and pgkiln's own second step after the provider.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { provedMfa } from '../src/sso.ts';

let app: FastifyInstance;
let idp: FastifyInstance;
let issuer = '';
let appId: number;
let oldAuthz: string | null;
const PAGE = 2;
const SCHEME = 'SEC132_STEPUP';
const CLIENT_ID = 'pgkiln-mfa-test';
const SECRET = 'mfa-secret';
const keys = await generateKeyPair('RS256');
const grants = new Map<string, { challenge: string; redirectUri: string; claims: JWTPayload }>();

class Browser {
  cookies = new Map<string, string>();
  async get(url: string) {
    const res = await app.inject({ method: 'GET', url, headers: { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
    for (const c of res.cookies as { name: string; value: string; expires?: Date }[]) {
      if (!c.value || (c.expires && c.expires.getTime() < Date.now())) this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    return res;
  }
}

/** The provider answers the authorization request at `auth` with these claims: pgkiln's callback response. */
async function answer(b: Browser, auth: URL, claims: JWTPayload) {
  const code = randomBytes(12).toString('hex');
  grants.set(code, {
    challenge: auth.searchParams.get('code_challenge')!,
    redirectUri: auth.searchParams.get('redirect_uri')!,
    claims: { nonce: auth.searchParams.get('nonce')!, ...claims },
  });
  return b.get(`/sso/callback/mfamock?${new URLSearchParams({ code, state: auth.searchParams.get('state')! })}`);
}

async function signIn(b: Browser, claims: JWTPayload, next = `/a/hr/1`) {
  const start = await b.get(`/a/hr/sso/mfamock?next=${encodeURIComponent(next)}`);
  assert.equal(start.statusCode, 302, start.body.slice(0, 200));
  const auth = new URL(String(start.headers.location));
  return { auth, res: await answer(b, auth, claims) };
}

/** An activity log row (written after the response): asked again for up to a second. */
async function logged(sql: string, params: unknown[] = []) {
  for (let i = 0; i < 20; i++) {
    const r = await owner.one(sql, params);
    if (r) return r;
    await new Promise((r) => setTimeout(r, 50));
  }
  return undefined;
}

const user = (sub: string, extra: JWTPayload = {}): JWTPayload => ({ sub, preferred_username: `mfa_${sub}`, groups: ['mfa-admins'], ...extra });

before(async () => {
  idp = Fastify();
  await idp.register(formbody);
  idp.get('/.well-known/openid-configuration', async () => ({
    issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
    token_endpoint_auth_methods_supported: ['client_secret_basic'],
  }));
  idp.get('/jwks', async () => ({ keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }] }));
  idp.post('/token', async (req, reply) => {
    const body = req.body as Record<string, string>;
    const basic = Buffer.from(String(req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString();
    if (basic !== `${CLIENT_ID}:${SECRET}`) return reply.code(401).send({ error: 'invalid_client' });
    const g = grants.get(body.code);
    grants.delete(body.code);
    if (!g || body.redirect_uri !== g.redirectUri) return reply.code(400).send({ error: 'invalid_grant' });
    if (createHash('sha256').update(body.code_verifier ?? '').digest('base64url') !== g.challenge) return reply.code(400).send({ error: 'invalid_grant' });
    const id_token = await new SignJWT({ ...g.claims }).setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(issuer).setAudience(CLIENT_ID).setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
    return { access_token: 'x', token_type: 'Bearer', id_token };
  });
  await idp.listen({ port: 0, host: '127.0.0.1' });
  issuer = `http://127.0.0.1:${(idp.server.address() as AddressInfo).port}`;

  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  await cleanup();
  await owner.query(
    `insert into meta.auth_provider (name, display_name, issuer, client_id, client_secret, groups_claim, auto_create)
     values ('mfamock', 'MFA IdP', $1, $2, $3, 'groups', true)`, [issuer, CLIENT_ID, SECRET]);
  await owner.query(`update meta.app set sso_providers = array_append(sso_providers, 'mfamock') where id = $1`, [appId]);
  await owner.query(`insert into meta.app_group_role (app_id, group_name, role) values ($1, 'mfa-admins', 'admin') on conflict do nothing`, [appId]);
  oldAuthz = (await owner.one('select authz from meta.page where app_id = $1 and page_no = $2', [appId, PAGE])).authz;
  await owner.query(`insert into meta.authz_scheme (app_id, name, type, value, mfa_minutes) values ($1, $2, 'role', 'admin', 15)`, [appId, SCHEME]);
  await owner.query('update meta.page set authz = $3 where app_id = $1 and page_no = $2', [appId, PAGE, SCHEME]);
});

async function cleanup() {
  await owner.query(`delete from meta.account where username like 'mfa\\_%'`);
  await owner.query(`delete from meta.auth_provider where name = 'mfamock'`);
  await owner.query(`update meta.app set sso_providers = array_remove(sso_providers, 'mfamock'), mfa = 'off' where id = $1`, [appId]);
  await owner.query(`delete from meta.app_group_role where app_id = $1 and group_name = 'mfa-admins'`, [appId]);
  await owner.query('delete from meta.authz_scheme where app_id = $1 and name = $2', [appId, SCHEME]);
}

beforeEach(async () => {
  await owner.query(`update meta.auth_provider set mfa_required = false, mfa_request = null, mfa_values = '{mfa}', local_second_step = false where name = 'mfamock'`);
  await owner.query(`update meta.app set mfa = 'off' where id = $1`, [appId]);
  await owner.query(`delete from meta.activity_log where detail like 'sso:mfamock%'`);
});

after(async () => {
  await owner.query('update meta.page set authz = $3 where app_id = $1 and page_no = $2', [appId, PAGE, oldAuthz]);
  await cleanup();
  await owner.query(`delete from meta.activity_log where detail like 'sso:mfamock%'`);
  await app.close();
  await idp.close();
  await closePools();
});

describe('(sprint 132, SEC-4) the identity provider did multi-factor sign-in', () => {
  test('provedMfa: any accepted amr / acr value', () => {
    const p = { mfa_values: ['mfa', 'urn:acr:gold'] };
    assert.equal(provedMfa(p, ['pwd']), false);
    assert.equal(provedMfa(p, ['pwd', 'mfa']), true);
    assert.equal(provedMfa(p, ['urn:acr:gold']), true);
    assert.equal(provedMfa(p, ['MFA']), false, 'exact values');
    assert.equal(provedMfa({ mfa_values: [] }, ['mfa']), false);
  });

  test('Require multi-factor: amr ["pwd"] is refused, ["pwd","mfa"] signs in; acr_values are requested', async () => {
    await owner.query(`update meta.auth_provider set mfa_required = true, mfa_request = 'urn:acr:mfa  urn:acr:gold' where name = 'mfamock'`);
    const refused = await signIn(new Browser(), user('anna', { amr: ['pwd'] }));
    assert.equal(refused.auth.searchParams.get('acr_values'), 'urn:acr:mfa urn:acr:gold');
    assert.equal(refused.auth.searchParams.get('prompt'), null, 'a sign-in is not a step-up');
    assert.equal(refused.res.statusCode, 403);
    assert.match(refused.res.body, /did not confirm a second factor/);
    assert.equal((await owner.one(`select count(*)::int as n from meta.account where username = 'mfa_anna'`)).n, 0, 'no account was created');
    assert.ok(await logged(`select 1 as ok from meta.activity_log where event = 'login_failed' and detail like 'sso:mfamock: The identity provider did not confirm%'`));

    const b = new Browser();
    const ok = await signIn(b, user('anna', { amr: ['pwd', 'mfa'] }));
    assert.equal(ok.res.statusCode, 303, ok.res.body.slice(0, 300));
    assert.equal(ok.res.headers.location, '/a/hr/1');
    assert.ok(await logged(`select 1 as ok from meta.activity_log where app_id = $1 and username = 'mfa_anna' and event = 'login' and detail = 'sso:mfamock (mfa)'`, [appId]));
  });

  test('an acr value counts too; a claim of the wrong type does not', async () => {
    await owner.query(`update meta.auth_provider set mfa_required = true, mfa_values = '{urn:acr:gold}' where name = 'mfamock'`);
    assert.equal((await signIn(new Browser(), user('bert', { acr: 'urn:acr:gold' }))).res.statusCode, 303);
    assert.equal((await signIn(new Browser(), user('bert', { acr: ['urn:acr:gold'] as never }))).res.statusCode, 403);
    assert.equal((await signIn(new Browser(), user('bert', { amr: 'urn:acr:gold' as never }))).res.statusCode, 403);
  });

  test('a multi-factor sign-in counts for step-up: the page opens at once', async () => {
    const b = new Browser();
    await signIn(b, user('cleo', { amr: ['pwd', 'mfa'] }));
    const page = await b.get(`/a/hr/${PAGE}`);
    assert.equal(page.statusCode, 200, String(page.headers.location));
  });

  test('step-up through the provider: prompt=login, max_age=0, then the page opens', async () => {
    await owner.query(`update meta.auth_provider set mfa_request = 'urn:acr:mfa' where name = 'mfamock'`);
    const b = new Browser();
    await signIn(b, user('dora', { amr: ['pwd'] }));
    const asked = await b.get(`/a/hr/${PAGE}`);
    assert.equal(asked.headers.location, `/a/hr/login/2fa?next=${encodeURIComponent(`/a/hr/${PAGE}`)}`);
    const go = await b.get(String(asked.headers.location));
    assert.equal(go.statusCode, 303, go.body.slice(0, 300));
    const auth = new URL(String(go.headers.location));
    assert.equal(auth.origin + auth.pathname, `${issuer}/authorize`);
    assert.equal(auth.searchParams.get('prompt'), 'login');
    assert.equal(auth.searchParams.get('max_age'), '0');
    assert.equal(auth.searchParams.get('acr_values'), 'urn:acr:mfa');
    const back = await answer(b, auth, user('dora', { amr: ['pwd', 'otp', 'mfa'], auth_time: Math.floor(Date.now() / 1000) }));
    assert.equal(back.statusCode, 303, back.body.slice(0, 300));
    assert.equal(back.headers.location, `/a/hr/${PAGE}`);
    assert.equal((await b.get(`/a/hr/${PAGE}`)).statusCode, 200);
    assert.ok(await owner.one(`select 1 as ok from meta.activity_log where username = 'mfa_dora' and event = '2fa_stepup' and detail = 'sso:mfamock'`));
  });

  test('step-up is refused without a second factor, without a fresh auth_time, or for another identity', async () => {
    const b = new Browser();
    await signIn(b, user('emil', { amr: ['pwd'] }));
    await signIn(new Browser(), user('fien', { amr: ['pwd'] }));
    const stepUp = async (claims: JWTPayload) => {
      const go = await b.get(`/a/hr/login/2fa?next=${encodeURIComponent(`/a/hr/${PAGE}`)}`);
      return answer(b, new URL(String(go.headers.location)), claims);
    };
    const now = Math.floor(Date.now() / 1000);
    assert.equal((await stepUp(user('emil', { amr: ['pwd'], auth_time: now }))).statusCode, 403, 'no second factor');
    assert.equal((await stepUp(user('emil', { amr: ['mfa'] }))).statusCode, 403, 'no auth_time');
    const stale = await stepUp(user('emil', { amr: ['mfa'], auth_time: now - 3600 }));
    assert.equal(stale.statusCode, 403);
    assert.match(stale.body, /did not ask you to sign in again/);
    assert.equal((await stepUp(user('fien', { amr: ['mfa'], auth_time: now }))).statusCode, 403, "another user's identity");
    assert.equal((await stepUp(user('nobody-linked', { amr: ['mfa'], auth_time: now }))).statusCode, 403, 'an identity linked to no account');
    assert.equal((await owner.one(`select count(*)::int as n from meta.account where username = 'mfa_nobody-linked'`)).n, 0, 'a step-up creates no account');
    assert.notEqual((await b.get(`/a/hr/${PAGE}`)).statusCode, 200, 'still not confirmed');
  });

  test("pgkiln's own second step after the provider: the application's rule applies as after a password", async () => {
    await owner.query(`update meta.auth_provider set local_second_step = true where name = 'mfamock'`);
    await owner.query(`update meta.app set mfa = 'required' where id = $1`, [appId]);
    const b = new Browser();
    const { res } = await signIn(b, user('gijs', { amr: ['pwd', 'mfa'] }));
    assert.equal(res.headers.location, '/a/hr/login/2fa', 'enrolment first');
    const page = await b.get('/a/hr/login/2fa');
    assert.equal(page.statusCode, 200);
    // the application's step-up then asks for pgkiln's factor, not the provider
    await owner.query(`update meta.app set mfa = 'off' where id = $1`, [appId]);
    const c = new Browser();
    await signIn(c, user('hans', { amr: ['pwd'] }));
    const go = await c.get(`/a/hr/login/2fa?next=${encodeURIComponent(`/a/hr/${PAGE}`)}`);
    assert.equal(go.statusCode, 403, 'no factor of his own yet: My account');
    assert.doesNotMatch(String(go.headers.location ?? ''), /authorize/);
  });
});
