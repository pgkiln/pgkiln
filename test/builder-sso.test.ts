// Sprint 129 (SEC-1): signing in to the builder through an identity provider (OpenID Connect against an
// in-process mock provider, as in sso.test.ts), linking developers by subject, creating them from groups,
// the administrators group, linking from the Security page, a workspace that requires single sign-on,
// break-glass administrators and `pgkiln admin builder-sign-in password`.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { clearSsoOnly, ssoRequired } from '../src/devsso.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let idp: FastifyInstance;
let issuer = '';
let providerId = 0;
let wsId = 0;
const CLIENT_ID = 'pgkiln-builder-test';
const SECRET = 'builder-secret';
const PW = 'Bsso129-password!';
const keys = await generateKeyPair('RS256');
const grants = new Map<string, { challenge: string; redirectUri: string; claims: JWTPayload }>();

/** At the mock provider: the "user" signs in with these claims; returns the callback response. */
async function atProvider(b: Browser, start: { headers: Record<string, unknown>; statusCode: number; body: string }, claims: JWTPayload) {
  assert.ok([302, 303].includes(start.statusCode), start.body.slice(0, 300));
  const auth = new URL(String(start.headers.location));
  assert.equal(auth.origin + auth.pathname, `${issuer}/authorize`);
  const code = randomBytes(12).toString('hex');
  grants.set(code, { challenge: auth.searchParams.get('code_challenge')!, redirectUri: auth.searchParams.get('redirect_uri')!, claims: { nonce: auth.searchParams.get('nonce')!, ...claims } });
  return b.get(`/sso/callback/bmock?${new URLSearchParams({ code, state: auth.searchParams.get('state')! })}`);
}
const ssoSignIn = async (b: Browser, claims: JWTPayload, next = '') => atProvider(b, await b.get(`/builder/sso/bmock${next}`), claims);

async function passwordSignIn(b: Browser, username: string, password = PW) {
  await b.get('/builder/login');
  return b.submit('/builder/login', { username, password });
}
const setProvider = (cols: Record<string, unknown>) =>
  owner.query(`update meta.auth_provider set ${Object.keys(cols).map((k, i) => `${k} = $${i + 2}`).join(', ')} where id = $1`, [providerId, ...Object.values(cols)]);

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
    const id_token = await new SignJWT({ ...g.claims }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(issuer).setAudience(CLIENT_ID)
      .setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) + 300).sign(keys.privateKey);
    return { access_token: 'x', token_type: 'Bearer', id_token };
  });
  await idp.listen({ port: 0, host: '127.0.0.1' });
  issuer = `http://127.0.0.1:${(idp.server.address() as AddressInfo).port}`;

  await cleanup();
  app = await buildApp({ logger: false });
  providerId = (await owner.one(
    `insert into meta.auth_provider (name, display_name, issuer, client_id, client_secret, groups_claim) values ('bmock', 'Mock Builder IdP', $1, $2, $3, 'groups') returning id`,
    [issuer, CLIENT_ID, SECRET],
  )).id;
  for (const [u, adm] of [['bsso_dev', false], ['bsso_admin', true], ['bsso_glass', true]] as const)
    await owner.query('insert into meta.developer (username, password_hash, is_admin) values ($1, meta.hash_password($2), $3)', [u, PW, adm]);
  wsId = (await owner.one(`insert into meta.workspace (name) values ('bsso ws') returning id`)).id;
  await owner.query(`insert into meta.workspace_member (workspace_id, username) values ($1, 'bsso_dev'), ($1, 'bsso_glass')`, [wsId]);
});

async function cleanup() {
  await owner.query(`delete from meta.workspace where name = 'bsso ws'`);
  await owner.query(`delete from meta.developer where username like 'bsso\\_%'`);
  await owner.query(`delete from meta.auth_provider where name = 'bmock'`);
  await owner.query(`delete from meta.activity_log where app_id is null and (event = 'login_failed' or detail like 'builder sso:bmock%')`);
}

after(async () => {
  await cleanup();
  await app.close();
  await idp.close();
  await closePools();
});

describe('builder sign-in through an identity provider (sprint 129)', () => {
  test('the sign-in page offers the provider only when it signs developers in', async () => {
    assert.doesNotMatch((await new Browser(app).get('/builder/login')).body, /Sign in with Mock Builder IdP/);
    assert.equal((await new Browser(app).get('/builder/sso/bmock')).statusCode, 404);
    await setProvider({ builder: true });
    assert.match((await new Browser(app).get('/builder/login')).body, /href="\/builder\/sso\/bmock">.*Sign in with Mock Builder IdP/s);
  });

  test('an unknown person is refused unless developers are created, and only from the developers group', async () => {
    let r = await ssoSignIn(new Browser(app), { sub: 'sub-new-1', preferred_username: 'bsso_new', groups: ['staff'] });
    assert.equal(r.statusCode, 403);
    assert.match(r.body, /There is no developer/);
    await setProvider({ builder_auto_create: true, builder_group: 'pgkiln-devs' });
    r = await ssoSignIn(new Browser(app), { sub: 'sub-new-1', preferred_username: 'bsso_new', groups: ['staff'] });
    assert.equal(r.statusCode, 403, 'not in the developers group');
    const b = new Browser(app);
    r = await ssoSignIn(b, { sub: 'sub-new-1', preferred_username: 'bsso_new', email: 'new@example.org', groups: ['pgkiln-devs'] }, '?next=/builder/developers');
    assert.equal(r.statusCode, 303, r.body.slice(0, 300));
    assert.equal(r.headers.location, '/builder/developers');
    const d = await owner.one(`select is_admin, email from meta.developer where username = 'bsso_new'`);
    assert.deepEqual(d, { is_admin: false, email: 'new@example.org' });
    assert.equal((await b.get('/builder/developers')).statusCode, 200, 'signed in');
    // the subject finds the developer, whatever name the provider sends later
    r = await ssoSignIn(new Browser(app), { sub: 'sub-new-1', preferred_username: 'someone_else', groups: ['pgkiln-devs'] });
    assert.equal(r.statusCode, 303);
    assert.equal((await owner.one(`select count(*)::int as n from meta.developer where username = 'someone_else'`)).n, 0);
    assert.ok(await owner.one(`select 1 from meta.activity_log where event = 'login' and username = 'bsso_new' and detail = 'builder sso:bmock'`));
  });

  test('the administrators group decides who is an administrator, at every sign-in; break-glass is never demoted', async () => {
    await setProvider({ builder_admin_group: 'pgkiln-admins' });
    await ssoSignIn(new Browser(app), { sub: 'sub-new-1', preferred_username: 'bsso_new', groups: ['pgkiln-devs', 'pgkiln-admins'] });
    assert.equal((await owner.one(`select is_admin from meta.developer where username = 'bsso_new'`)).is_admin, true);
    await ssoSignIn(new Browser(app), { sub: 'sub-new-1', preferred_username: 'bsso_new', groups: ['pgkiln-devs'] });
    assert.equal((await owner.one(`select is_admin from meta.developer where username = 'bsso_new'`)).is_admin, false);
    await owner.query(`update meta.developer set break_glass = true where username = 'bsso_glass'`);
    await owner.query(`insert into meta.developer_identity (provider_id, subject, username) values ($1, 'sub-glass', 'bsso_glass')`, [providerId]);
    await ssoSignIn(new Browser(app), { sub: 'sub-glass', preferred_username: 'bsso_glass', groups: [] });
    assert.equal((await owner.one(`select is_admin from meta.developer where username = 'bsso_glass'`)).is_admin, true);
    // nor the instance's last administrator
    await owner.query(`update meta.developer set break_glass = false where username = 'bsso_glass'`);
    const others = (await owner.query(`select username from meta.developer where is_admin and username <> 'bsso_glass'`)).rows.map((r) => r.username);
    await owner.query('update meta.developer set is_admin = false where username = any($1)', [others]);
    try {
      await ssoSignIn(new Browser(app), { sub: 'sub-glass', preferred_username: 'bsso_glass', groups: [] });
      assert.equal((await owner.one(`select is_admin from meta.developer where username = 'bsso_glass'`)).is_admin, true, 'the last administrator');
    } finally {
      await owner.query('update meta.developer set is_admin = true where username = any($1)', [others]);
      await owner.query(`update meta.developer set break_glass = true where username = 'bsso_glass'`);
    }
    await setProvider({ builder_admin_group: null });
  });

  test('an existing developer is linked by name only when the provider allows it, never a break-glass one', async () => {
    let r = await ssoSignIn(new Browser(app), { sub: 'sub-admin', preferred_username: 'bsso_admin', groups: ['pgkiln-devs'] });
    assert.equal(r.statusCode, 403);
    assert.match(r.body, /exists but is not linked/);
    await setProvider({ builder_link_existing: true });
    await owner.query(`delete from meta.developer_identity where username = 'bsso_glass'`);
    r = await ssoSignIn(new Browser(app), { sub: 'sub-glass-2', preferred_username: 'bsso_glass', groups: [] });
    assert.equal(r.statusCode, 403, 'break-glass developers link themselves');
    // an e-mail address as the user name links only when it is verified
    await setProvider({ username_claim: 'email' });
    await owner.query(`insert into meta.developer (username, password_hash, is_admin) values ('bsso_mail@example.org', meta.hash_password($1), false)`, [PW]);
    r = await ssoSignIn(new Browser(app), { sub: 'sub-mail', email: 'bsso_mail@example.org' });
    assert.equal(r.statusCode, 403, 'email_verified missing');
    r = await ssoSignIn(new Browser(app), { sub: 'sub-mail', email: 'bsso_mail@example.org', email_verified: true });
    assert.equal(r.statusCode, 303);
    await setProvider({ username_claim: 'preferred_username', builder_link_existing: false });
  });

  test('a developer links the identity on the Security page, signed in', async () => {
    const b = new Browser(app);
    await passwordSignIn(b, 'bsso_dev');
    const page = (await b.get('/builder/security')).body;
    assert.match(page, /Link Mock Builder IdP/);
    const r = await atProvider(b, await b.submit('/builder/security/link/bmock', {}), { sub: 'sub-dev', preferred_username: 'whatever' });
    assert.equal(r.statusCode, 303, r.body.slice(0, 300));
    assert.equal(r.headers.location, '/builder/security?linked=bmock');
    assert.match((await b.get('/builder/security?linked=bmock')).body, /Mock Builder IdP is linked/);
    const c = new Browser(app);
    assert.equal((await ssoSignIn(c, { sub: 'sub-dev', preferred_username: 'whatever' })).statusCode, 303);
    assert.match((await c.get('/builder/developers')).body, /bsso_dev \(you\)/);
    // the same identity can't be linked to a second developer
    const a = new Browser(app);
    await passwordSignIn(a, 'bsso_admin');
    await a.get('/builder/security');
    const again = await atProvider(a, await a.submit('/builder/security/link/bmock', {}), { sub: 'sub-dev', preferred_username: 'whatever' });
    assert.equal(again.statusCode, 403);
    assert.match(again.body, /linked to another developer/);
  });

  test('a workspace requires single sign-on: only with a break-glass administrator; the password is refused, except break-glass', async () => {
    await owner.query(`update meta.developer set break_glass = false`);
    const a = new Browser(app);
    await passwordSignIn(a, 'bsso_admin');
    await a.get(`/builder/workspaces/${wsId}`);
    let r = await a.submit(`/builder/workspaces/${wsId}/sso`, { sso_only: 'true' });
    assert.match(String((await a.get(`/builder/workspaces/${wsId}`)).body), /Make an administrator break-glass first/);
    assert.equal((await owner.one('select sso_only from meta.workspace where id = $1', [wsId])).sso_only, false);
    // on the Developers page
    await a.get('/builder/developers');
    r = await a.submit('/builder/developers/break-glass', { username: 'bsso_dev', break_glass: 'true' });
    assert.equal((await owner.one(`select break_glass from meta.developer where username = 'bsso_dev'`)).break_glass, false, 'administrators only');
    await a.submit('/builder/developers/break-glass', { username: 'bsso_glass', break_glass: 'true' });
    assert.equal((await owner.one(`select break_glass from meta.developer where username = 'bsso_glass'`)).break_glass, true);
    // the administrator has no identity (and is not break-glass): would lock themselves out
    await a.get(`/builder/workspaces/${wsId}`);
    await a.submit(`/builder/workspaces/${wsId}/sso`, { sso_only: 'true' });
    assert.equal((await owner.one('select sso_only from meta.workspace where id = $1', [wsId])).sso_only, false);
    const g = new Browser(app);
    await passwordSignIn(g, 'bsso_glass');
    await g.get(`/builder/workspaces/${wsId}`);
    r = await g.submit(`/builder/workspaces/${wsId}/sso`, { sso_only: 'true' });
    assert.equal(r.statusCode, 303);
    assert.equal((await owner.one('select sso_only from meta.workspace where id = $1', [wsId])).sso_only, true);

    assert.equal(await ssoRequired('bsso_dev'), true);
    assert.equal(await ssoRequired('bsso_glass'), false, 'break-glass');
    r = await passwordSignIn(new Browser(app), 'bsso_dev');
    assert.equal(r.headers.location, '/builder/login');
    assert.ok(await owner.one(`select 1 from meta.activity_log where event = 'login_failed' and username = 'bsso_dev' and detail = 'builder: single sign-on required'`));
    r = await passwordSignIn(new Browser(app), 'bsso_glass');
    assert.equal(r.headers.location, '/builder/home');
    assert.equal((await ssoSignIn(new Browser(app), { sub: 'sub-dev', preferred_username: 'whatever' })).statusCode, 303, 'single sign-on works');

    // the last break-glass administrator stays while a workspace requires single sign-on; so does the last identity
    await a.get('/builder/developers');
    await a.submit('/builder/developers/break-glass', { username: 'bsso_glass', break_glass: 'false' });
    assert.equal((await owner.one(`select break_glass from meta.developer where username = 'bsso_glass'`)).break_glass, true);
    const id = (await owner.one(`select id from meta.developer_identity where username = 'bsso_dev'`)).id;
    const d = new Browser(app);
    await ssoSignIn(d, { sub: 'sub-dev', preferred_username: 'whatever' });
    await d.get('/builder/security');
    await d.submit(`/builder/developers/identity/${id}/unlink`, {});
    assert.ok(await owner.one('select 1 from meta.developer_identity where id = $1', [id]), 'the last identity stays');

    // the command line's way back
    assert.ok((await clearSsoOnly()) >= 1);
    assert.equal(await ssoRequired('bsso_dev'), false);
    await d.get('/builder/security');
    await d.submit(`/builder/developers/identity/${id}/unlink`, {});
    assert.equal(await owner.one('select 1 from meta.developer_identity where id = $1', [id]), undefined);
  });

  test('administrators turn builder sign-in on per provider and see the linked developers', async () => {
    const a = new Browser(app);
    await passwordSignIn(a, 'bsso_glass');
    const page = (await a.get(`/builder/users/providers/${providerId}`)).body;
    assert.match(page, /Builder sign-in/);
    assert.match(page, /bsso_new/);
    await a.submit(`/builder/users/providers/${providerId}/builder`, { builder_auto_create: 'true' });
    const p = await owner.one('select builder, builder_auto_create, builder_group from meta.auth_provider where id = $1', [providerId]);
    assert.deepEqual(p, { builder: false, builder_auto_create: true, builder_group: null });
    assert.equal((await new Browser(app).get('/builder/sso/bmock')).statusCode, 404, 'off: the start is gone');
  });
});

describe('(sprint 132, SEC-4) multi-factor sign-in at the provider, for developers', () => {
  test('Require multi-factor refuses a developer whose token says only "pwd"', async () => {
    await setProvider({ builder: true, builder_group: null, mfa_required: true });
    try {
      const r = await ssoSignIn(new Browser(app), { sub: 'sub-new-1', preferred_username: 'bsso_new', groups: ['pgkiln-devs'], amr: ['pwd'] });
      assert.equal(r.statusCode, 403);
      assert.match(r.body, /did not confirm a second factor/);
      const ok = await ssoSignIn(new Browser(app), { sub: 'sub-new-1', preferred_username: 'bsso_new', groups: ['pgkiln-devs'], amr: ['pwd', 'mfa'] });
      assert.equal(ok.statusCode, 303, ok.body.slice(0, 300));
      let row;
      // written after the response
      for (let i = 0; i < 20 && !row; i++, await new Promise((r) => setTimeout(r, 50)))
        row = await owner.one(`select 1 as ok from meta.activity_log where event = 'login' and username = 'bsso_new' and detail = 'builder sso:bmock (mfa)'`);
      assert.ok(row);
    } finally {
      await setProvider({ mfa_required: false });
    }
  });

  test("pgkiln's own second step after the provider: a developer with an authenticator app gives a code", async () => {
    process.env.PGKILN_SECRET_KEY ??= 'test-only-secret-key-0123456789abcdef';
    const { addTotp, stepNow, totpAt, unbase32 } = await import('../src/mfa.ts');
    const SECRET = 'JBSWY3DPEHPK3PXP';
    await addTotp('bsso_new', 'Phone', SECRET, stepNow() - 10);
    await setProvider({ builder: true, local_second_step: true });
    try {
      const b = new Browser(app);
      const r = await ssoSignIn(b, { sub: 'sub-new-1', preferred_username: 'bsso_new', groups: ['pgkiln-devs'] }, '?next=/builder/developers');
      assert.equal(r.statusCode, 303);
      assert.equal(r.headers.location, '/builder/login/2fa');
      assert.notEqual((await b.get('/builder/developers')).statusCode, 200, 'not signed in yet');
      await b.get('/builder/login/2fa');
      const done = await b.submit('/builder/login/2fa', { code: totpAt(unbase32(SECRET), stepNow()) });
      assert.equal(done.headers.location, '/builder/developers');
      assert.equal((await b.get('/builder/developers')).statusCode, 200);
    } finally {
      await setProvider({ local_second_step: false });
      await owner.query(`delete from meta.developer_factor where username = 'bsso_new'`);
    }
  });
});
