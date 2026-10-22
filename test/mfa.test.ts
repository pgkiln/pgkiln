// Sprint 126 (SEC-2, SEC-6): two-factor sign-in for developers. TOTP per RFC 6238, the second step at sign-in,
// recovery codes, the policy with its two-administrator rule, an administrator's reset, and the command line.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
process.env.PGKILN_SECRET_KEY ||= 'test-only-secret-key-0123456789abcdef';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { base32, matchTotp, mfaPolicy, setPolicy, stepNow, totpAt, unbase32, setPasskeySignin } from '../src/mfa.ts';
import { Browser } from './helpers.ts';

const DEV = 'mfa126_dev';
const A1 = 'mfa126_a1';
const A2 = 'mfa126_a2';
const PW = 'Mfa126-password!';
let app: FastifyInstance;

async function cleanup() {
  await owner.query('delete from meta.developer where username = any($1)', [[DEV, A1, A2]]);
  await setPolicy('off', 7);
  await setPasskeySignin(true); // the policy form without the checkbox turns it off
}

async function signIn(b: Browser, username: string, password = PW) {
  await b.get('/builder/login');
  return b.submit('/builder/login', { username, password });
}

/** Add an authenticator app through the Security page; returns its secret. */
async function enrol(b: Browser) {
  await b.get('/builder/security');
  await b.submit('/builder/security/totp/start', {});
  const page = (await b.get('/builder/security')).body;
  const secret = /class="mfa-secret">([A-Z2-7 ]+)</.exec(page)![1].replace(/ /g, '');
  const r = await b.submit('/builder/security/totp/confirm', { name: 'Phone', code: totpAt(unbase32(secret), stepNow()) });
  assert.equal(r.headers.location, '/builder/security#codes');
  const codes = [...(await b.get('/builder/security')).body.matchAll(/<li><code>([a-z0-9]{5}-[a-z0-9]{5})<\/code><\/li>/g)].map((m) => m[1]);
  assert.equal(codes.length, 10, 'ten recovery codes shown once');
  await b.submit('/builder/security/codes/confirm', { saved: '1' });
  return { secret, codes };
}

before(async () => {
  await cleanup();
  for (const [u, adm] of [[DEV, false], [A1, true], [A2, true]] as const)
    await owner.query('insert into meta.developer (username, password_hash, is_admin) values ($1, meta.hash_password($2), $3)', [u, PW, adm]);
  app = await buildApp({ logger: false });
});
after(async () => {
  await cleanup();
  await app.close();
  await closePools();
});

describe('TOTP (RFC 6238)', () => {
  test('the RFC test vectors (SHA-1, 8 digits)', () => {
    const key = Buffer.from('12345678901234567890');
    for (const [time, code] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037']] as const)
      assert.equal(totpAt(key, Math.floor(time / 30), 8), code, String(time));
  });
  test('base32 round trip, one step either side, no replay', () => {
    const key = Buffer.from('12345678901234567890');
    assert.equal(base32(key), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    assert.deepEqual(unbase32('gezd gnbv gy3t qojq gezd gnbv gy3t qojq'), key);
    const now = 1000;
    assert.equal(matchTotp(key, totpAt(key, 999), null, now), 999);
    assert.equal(matchTotp(key, totpAt(key, 1001), null, now), 1001);
    assert.equal(matchTotp(key, totpAt(key, 998), null, now), null, 'two steps old');
    assert.equal(matchTotp(key, totpAt(key, 1000), 1000, now), null, 'already used');
    assert.equal(matchTotp(key, 'abcdef', null, now), null);
  });
});

describe('two-factor sign-in for developers', () => {
  let secret = '';
  let codes: string[] = [];

  test('a developer adds an authenticator app; the secret is stored encrypted', async () => {
    const b = new Browser(app);
    await signIn(b, DEV);
    assert.match((await b.get('/builder/security')).body, /Add an authenticator app/);
    ({ secret, codes } = await enrol(b));
    const row = await owner.one<{ secret_enc: string }>('select secret_enc from meta.developer_factor where username = $1', [DEV]);
    assert.ok(row && !row.secret_enc.includes(secret), 'not in plain text');
    const kept = await owner.one<{ n: number }>('select count(*)::int as n from meta.developer_recovery_code where username = $1 and confirmed', [DEV]);
    assert.equal(kept!.n, 10);
    assert.match((await b.get('/builder/developers')).body, new RegExp(`${DEV}[\\s\\S]*?Two-factor|Two-factor[\\s\\S]*?${DEV}`));
  });

  test('a wrong code while adding is refused', async () => {
    const b = new Browser(app);
    await signIn(b, A1);
    await b.get('/builder/security');
    await b.submit('/builder/security/totp/start', {});
    await b.get('/builder/security');
    await b.submit('/builder/security/totp/confirm', { name: 'x', code: '000000' });
    assert.equal((await owner.one<{ n: number }>('select count(*)::int as n from meta.developer_factor where username = $1', [A1]))!.n, 0);
  });

  test('sign-in asks for the code; the password alone is not enough', async () => {
    const b = new Browser(app);
    const r = await signIn(b, DEV);
    assert.equal(r.headers.location, '/builder/login/2fa');
    assert.equal((await b.get('/builder/apps')).statusCode, 302, 'no session yet');
    const page = (await b.get('/builder/login/2fa')).body;
    assert.match(page, /Two-factor sign-in/);
    await b.submit('/builder/login/2fa', { code: '123456' });
    assert.match((await b.get('/builder/login/2fa')).body, /not right/);
    const ok = await b.submit('/builder/login/2fa', { code: totpAt(unbase32(secret), stepNow() + 1) });
    assert.equal(ok.statusCode, 303);
    assert.equal((await b.get('/builder/apps')).statusCode, 200);
  });

  test('a code works only once', async () => {
    const b = new Browser(app);
    await signIn(b, DEV);
    await b.get('/builder/login/2fa');
    await b.submit('/builder/login/2fa', { code: totpAt(unbase32(secret), stepNow() + 1) });
    assert.notEqual((await b.get('/builder/apps')).statusCode, 200);
  });

  test('a recovery code signs in once and leads to the Security page', async () => {
    const b = new Browser(app);
    await signIn(b, DEV);
    await b.get('/builder/login/2fa');
    const r = await b.submit('/builder/login/2fa', { code: codes[0].toUpperCase() });
    assert.equal(r.headers.location, '/builder/security');
    assert.match((await b.get('/builder/security')).body, /Unused recovery codes: 9/);
    const c = new Browser(app);
    await signIn(c, DEV);
    await c.get('/builder/login/2fa');
    await c.submit('/builder/login/2fa', { code: codes[0] });
    assert.notEqual((await c.get('/builder/apps')).statusCode, 200, 'used up');
  });

  test('the pending sign-in can\'t be used without the password step', async () => {
    const b = new Browser(app);
    await b.get('/builder/login');
    const r = await b.submit('/builder/login/2fa', { code: totpAt(unbase32(secret), stepNow()) });
    assert.equal(r.headers.location, '/builder/login');
  });

  test('the policy needs two administrators with a second factor', async () => {
    const a1 = new Browser(app);
    await signIn(a1, A1);
    await a1.get('/builder/instance');
    await a1.submit('/builder/instance/mfa', { policy: 'admins', grace_days: '7' });
    assert.equal((await mfaPolicy()).policy, 'off');
    await enrol(a1);
    const a2 = new Browser(app);
    await signIn(a2, A2);
    await enrol(a2);
    await a1.get('/builder/instance');
    await a1.submit('/builder/instance/mfa', { policy: 'admins', grace_days: '7' });
    assert.equal((await mfaPolicy()).policy, 'admins');
    // now neither may drop their only app, be demoted or removed
    const f = await owner.one<{ id: number }>('select id from meta.developer_factor where username = $1', [A2]);
    await a2.get('/builder/security');
    await a2.submit(`/builder/security/factor/${f!.id}/delete`, { [`password_${f!.id}`]: PW });
    assert.ok(await owner.one('select 1 from meta.developer_factor where id = $1', [f!.id]), 'still there');
    await a1.get('/builder/developers');
    await a1.submit('/builder/developers/admin', { username: A2, is_admin: 'false' });
    assert.equal((await owner.one<{ is_admin: boolean }>('select is_admin from meta.developer where username = $1', [A2]))!.is_admin, true);
  });

  test('an administrator during the grace period sees the banner; a developer does not', async () => {
    const admin = new Browser(app);
    await signIn(admin, 'admin', 'admin');
    // (sprint 128) the default password: changed first, on Developers (which shows the banner too)
    assert.equal((await admin.get('/builder/apps')).headers.location, '/builder/developers');
    const page = (await admin.get('/builder/developers')).body;
    assert.match(page, /Two-factor sign-in is required/);
    assert.match(page, /change the default password before you continue/);
    const b = new Browser(app);
    await signIn(b, DEV);
    await b.get('/builder/login/2fa');
    await b.submit('/builder/login/2fa', { code: codes[1] });
    assert.doesNotMatch((await b.get('/builder/apps')).body, /Two-factor sign-in is required/);
  });

  test('after the grace period only the Security page', async () => {
    await owner.query(`update meta.setting set value = (now() - interval '8 days')::text where name = 'mfa_required_since'`);
    const admin = new Browser(app);
    await signIn(admin, 'admin', 'admin');
    // the default password first (sprint 128), with no loop between the two pages
    assert.equal((await admin.get('/builder/security')).headers.location, '/builder/developers');
    assert.equal((await admin.get('/builder/developers')).statusCode, 200);
    // with a password of their own: only the Security page
    await admin.submit('/builder/developers/password', { current: 'admin', password: 'Admin-own-password-128' });
    try {
      const r = await admin.get('/builder/apps');
      assert.equal(r.statusCode, 302);
      assert.equal(r.headers.location, '/builder/security');
      assert.equal((await admin.get('/builder/security')).statusCode, 200);
    } finally {
      await owner.query(`update meta.developer set password_hash = meta.hash_password('admin') where username = 'admin'`);
    }
    await setPolicy('off', 7);
  });

  test('an administrator resets another developer: needs a reason, ends their sessions, logged', async () => {
    const a1 = new Browser(app);
    await signIn(a1, A1);
    await a1.get('/builder/login/2fa');
    const sec = await owner.one<{ secret_enc: string }>('select secret_enc from meta.developer_factor where username = $1', [A1]);
    const { decryptSecret } = await import('../src/secrets.ts');
    await a1.submit('/builder/login/2fa', { code: totpAt(unbase32(decryptSecret(sec!.secret_enc)), stepNow() + 1) });
    await a1.get('/builder/developers');
    assert.equal((await a1.submit('/builder/developers/reset-2fa', { username: DEV })).statusCode, 303);
    assert.ok(await owner.one('select 1 from meta.developer_factor where username = $1', [DEV]), 'no reason: nothing happens');
    await a1.get('/builder/developers');
    await a1.submit('/builder/developers/reset-2fa', { username: DEV, [`reason_${DEV}`]: 'lost phone' });
    assert.equal(await owner.one('select 1 from meta.developer_factor where username = $1', [DEV]), undefined);
    assert.equal(await owner.one('select 1 from meta.developer_recovery_code where username = $1', [DEV]), undefined);
    assert.ok(await owner.one(`select 1 from meta.activity_log where event = '2fa_reset' and detail like $1`, [`${DEV}: lost phone`]));
    const dev = new Browser(app);
    assert.equal((await signIn(dev, DEV)).headers.location !== '/builder/login/2fa', true, 'password only again');
  });

  test('a developer can\'t reset another developer', async () => {
    const b = new Browser(app);
    await signIn(b, DEV);
    await b.get('/builder/developers');
    assert.equal((await b.submit('/builder/developers/reset-2fa', { username: A2, reason: 'x' })).statusCode, 403);
    await b.get('/builder/developers');
    assert.equal((await b.submit('/builder/instance/mfa', { policy: 'off', grace_days: '7' })).statusCode, 403);
  });
});
