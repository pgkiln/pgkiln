// Sprint 131 (SEC-3, part 2): passkeys for application users (on My account and while signing in), a code by e-mail
// at the second step for users who have another factor, step-up (an authorization scheme that asks for a recent second
// step) and REST API tokens: only after a two-factor sign-in for users who must use one. The card's "done when": HR
// with "Required for roles: admin" and a salary page behind step-up asks king for his code again after 15 minutes.
process.env.PGKILN_SECRET_KEY ??= 'test-only-secret-key-0123456789abcdef';
process.env.API_JWT_SECRET ??= 'ci-only-api-secret-not-for-production-0123456789';
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { jwtVerify } from 'jose';
import '../src/env.ts';
import { accountId, addAccountTotp, MFA_AT } from '../src/account-mfa.ts';
import { issueApiToken, jwtSecret } from '../src/api.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { newTotpSecret, stepNow, totpAt, unbase32 } from '../src/mfa.ts';
import { Authenticator } from './authenticator.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
let pageNo: number;
let oldAuthz: string | null;
let oldEmail: string | null;
const SERVICE = 'T_S131_MAIL';
const SCHEME = 'T_S131_STEPUP';

const users = ['king', 'scott'];
const clearFactors = async () => {
  await owner.query(`delete from meta.account_factor where account_id in (select id from meta.account where username = any($1))`, [users]);
  await owner.query(`delete from meta.account_recovery_code where account_id in (select id from meta.account where username = any($1))`, [users]);
};
const setMfa = (mfa: string, roles: string[] = [], email = false) =>
  owner.query('update meta.app set mfa = $2, mfa_roles = $3, mfa_email = $4 where id = $1', [appId, mfa, roles, email]);
const unlock = (user: string) => owner.query(`insert into meta.activity_log (username, event, detail) values ($1, 'login_unlocked', 'test')`, [user]);
const signedIn = async (b: Browser) => (await b.get('/a/hr/2')).statusCode === 200;

/** Ask the server for WebAuthn options (as app.js does). */
async function options(b: Browser, url: string) {
  const r = await b.request('POST', url, { __csrf: b.lastCsrf });
  assert.equal(r.statusCode, 200, r.body);
  return JSON.parse(r.body);
}

/** king (signed in) adds a passkey on My account and confirms his recovery codes. */
async function passkeyOnAccount(b: Browser, key: Authenticator) {
  await b.get('/a/hr/account');
  const o = await options(b, '/a/hr/account/2fa/passkey/options');
  assert.equal(o.mode, 'create');
  assert.equal(o.rp.id, 'localhost');
  assert.notEqual(o.user.id, 'king', 'the user handle is not the user name');
  const added = await b.post('/a/hr/account/2fa/passkey', { __csrf: b.lastCsrf, pk_name: 'Laptop', ...key.create(o.challenge), transports: 'internal' });
  assert.equal(added.statusCode, 303);
  const account = await b.get('/a/hr/account');
  assert.match(account.body, /Laptop/);
  assert.match(account.body, /mfa-codes/, 'the first factor brings recovery codes');
  await b.post('/a/hr/account/2fa/codes/confirm', { __csrf: b.lastCsrf, saved: '1' });
}

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  // a page that needs step-up: HR's page 2 behind a role scheme with "second step within 15 minutes"
  pageNo = 2;
  oldAuthz = (await owner.one('select authz from meta.page where app_id = $1 and page_no = $2', [appId, pageNo])).authz;
  oldEmail = (await owner.one(`select email from meta.account where username = 'king'`)).email;
  await owner.query(`update meta.account set email = 'king@example.com' where username = 'king'`);
  await owner.query('delete from meta.authz_scheme where app_id = $1 and name = $2', [appId, SCHEME]);
  await owner.query(`insert into meta.authz_scheme (app_id, name, type, value, mfa_minutes) values ($1, $2, 'role', 'admin', 15)`, [appId, SCHEME]);
  await owner.query('delete from meta.mail_service where name = $1', [SERVICE]);
  const id = (await owner.one(`insert into meta.mail_service (name, provider, senders) values ($1, 'log', '{@example.com}') returning id`, [SERVICE])).id;
  await owner.query(`insert into meta.app_mail_service (app_id, service_id, from_address) values ($1, $2, 'hr@example.com')
                     on conflict (app_id) do update set service_id = excluded.service_id, from_address = excluded.from_address`, [appId, id]);
});

beforeEach(async () => {
  await clearFactors();
  await setMfa('off');
  for (const u of users) await unlock(u);
  await owner.query(`delete from meta.mail_queue where template = 'SIGNIN_CODE'`);
});

after(async () => {
  await clearFactors();
  await setMfa('off');
  await owner.query('update meta.page set authz = $3 where app_id = $1 and page_no = $2', [appId, pageNo, oldAuthz]);
  await owner.query('update meta.app set api_self_tokens = false where id = $1', [appId]);
  await owner.query('delete from meta.authz_scheme where app_id = $1 and name = $2', [appId, SCHEME]);
  await owner.query(`delete from meta.mail_queue where template = 'SIGNIN_CODE'`);
  await owner.query('delete from meta.app_mail_service where app_id = $1 and service_id = (select id from meta.mail_service where name = $2)', [appId, SERVICE]);
  await owner.query('delete from meta.mail_service where name = $1', [SERVICE]);
  await owner.query(`update meta.account set email = $1 where username = 'king'`, [oldEmail]);
  await app.close();
  await closePools();
});

describe('passkeys for application users', () => {
  test('added on My account, then the second step with the passkey; a replayed answer is refused', async () => {
    await setMfa('optional');
    const key = new Authenticator();
    const b = new Browser(app);
    await b.login('king');
    assert.equal(await signedIn(b), true, 'optional, no factor yet: no second step');
    await passkeyOnAccount(b, key);

    const c = new Browser(app);
    assert.equal((await c.login('king')).headers.location, '/a/hr/login/2fa');
    const page = await c.get('/a/hr/login/2fa');
    assert.match(page.body, /data-passkey="\/a\/hr\/login\/2fa\/passkey\/options"/);
    const o = await options(c, '/a/hr/login/2fa/passkey/options');
    assert.equal(o.mode, 'get');
    assert.equal(o.allow.length, 1);
    const answer = key.get(o.challenge);
    const ok = await c.post('/a/hr/login/2fa/passkey', { __csrf: c.lastCsrf, ...answer });
    assert.equal(ok.statusCode, 303);
    assert.equal(await signedIn(c), true);
    const log = await owner.one(`select detail from meta.activity_log where app_id = $1 and username = 'king' and event = 'login' order by id desc limit 1`, [appId]);
    assert.equal(log.detail, 'password 2fa (passkey)');

    // the same answer again (its challenge is used up, its counter old)
    const d = new Browser(app);
    await d.login('king');
    await d.get('/a/hr/login/2fa');
    await options(d, '/a/hr/login/2fa/passkey/options');
    assert.equal((await d.post('/a/hr/login/2fa/passkey', { __csrf: d.lastCsrf, ...answer })).statusCode, 401);
    assert.equal(await signedIn(d), false);
  });

  test('required: a user adds a passkey as the first factor while signing in', async () => {
    await setMfa('required');
    const key = new Authenticator('ed25519');
    const b = new Browser(app);
    await b.login('king');
    const page = await b.get('/a/hr/login/2fa');
    assert.match(page.body, /mfa-secret/, 'an authenticator app');
    assert.match(page.body, /data-passkey="\/a\/hr\/login\/2fa\/passkey\/new\/options"/, 'or a passkey');
    const o = await options(b, '/a/hr/login/2fa/passkey/new/options');
    const shown = await b.post('/a/hr/login/2fa/passkey/new', { __csrf: b.lastCsrf, ...key.create(o.challenge) });
    assert.equal(shown.statusCode, 200);
    assert.equal([...shown.body.matchAll(/<li><code>([a-z0-9]{5}-[a-z0-9]{5})<\/code><\/li>/g)].length, 10);
    assert.equal(await signedIn(b), false, 'not before the codes are confirmed');
    assert.equal((await b.post('/a/hr/login/2fa/done', { __csrf: b.lastCsrf, saved: '1' })).statusCode, 303);
    assert.equal(await signedIn(b), true);
    const f = await owner.one(`select kind, rp_id from meta.account_factor where account_id = (select id from meta.account where username = 'king')`);
    assert.deepEqual([f.kind, f.rp_id], ['passkey', 'localhost']);
  });

  test('removing a passkey asks for a code', async () => {
    await setMfa('optional');
    const b = new Browser(app);
    await b.login('king');
    await passkeyOnAccount(b, new Authenticator());
    const id = (await owner.one(`select id from meta.account_factor where account_id = (select id from meta.account where username = 'king')`)).id;
    await b.get('/a/hr/account');
    await b.post(`/a/hr/account/2fa/${id}/delete`, { __csrf: b.lastCsrf, code: '000000' });
    assert.ok(await owner.one('select 1 as ok from meta.account_factor where id = $1', [id]), 'a wrong code keeps it');
  });
});

describe('a code by e-mail', () => {
  const kingWithApp = async () => {
    const secret = newTotpSecret();
    await addAccountTotp((await accountId('king'))!, 'Phone', secret, stepNow() - 5);
    return secret;
  };
  const mailedCode = async () => {
    const m = await owner.one(`select to_addresses, subject, body_text from meta.mail_queue where template = 'SIGNIN_CODE' order by id desc limit 1`);
    assert.deepEqual(m.to_addresses, ['king@example.com']);
    assert.match(m.subject, /sign-in code/);
    return /\b(\d{6})\b/.exec(m.body_text)![1];
  };

  test('offered to a user with an app when the application allows it; the code signs in once', async () => {
    await kingWithApp();
    await setMfa('optional');
    const b = new Browser(app);
    await b.login('king');
    assert.doesNotMatch((await b.get('/a/hr/login/2fa')).body, /E-mail me a code/, 'off by default');
    await setMfa('optional', [], true);
    assert.match((await b.get('/a/hr/login/2fa')).body, /E-mail me a code/);
    const sent = await b.post('/a/hr/login/2fa/email', { __csrf: b.lastCsrf });
    assert.equal(sent.statusCode, 200);
    assert.match(sent.body, /We sent a code to your e-mail address/);
    assert.doesNotMatch(sent.body, /king@example\.com/, 'the address is not shown');
    const code = await mailedCode();
    assert.equal((await b.post('/a/hr/login/2fa', { __csrf: b.lastCsrf, code })).statusCode, 303);
    assert.equal(await signedIn(b), true);
    const log = await owner.one(`select detail from meta.activity_log where app_id = $1 and username = 'king' and event = 'login' order by id desc limit 1`, [appId]);
    assert.equal(log.detail, 'password 2fa (e-mail code)');

    // the next sign-in: the old mailed code is no code at all
    const c = new Browser(app);
    await c.login('king');
    await c.get('/a/hr/login/2fa');
    assert.equal((await c.post('/a/hr/login/2fa', { __csrf: c.lastCsrf, code })).statusCode, 401);
  });

  test('never the only factor: not offered while a user adds their first one', async () => {
    await setMfa('required', [], true);
    const b = new Browser(app);
    await b.login('king');
    assert.doesNotMatch((await b.get('/a/hr/login/2fa')).body, /E-mail me a code/);
    assert.equal((await b.post('/a/hr/login/2fa/email', { __csrf: b.lastCsrf })).statusCode, 410);
    assert.equal((await owner.one(`select count(*)::int as n from meta.mail_queue where template = 'SIGNIN_CODE'`)).n, 0);
  });

  test('at most three per sign-in', async () => {
    await kingWithApp();
    await setMfa('optional', [], true);
    const b = new Browser(app);
    await b.login('king');
    await b.get('/a/hr/login/2fa');
    for (let i = 0; i < 3; i++) assert.equal((await b.post('/a/hr/login/2fa/email', { __csrf: b.lastCsrf })).statusCode, 200);
    const fourth = await b.post('/a/hr/login/2fa/email', { __csrf: b.lastCsrf });
    assert.equal(fourth.statusCode, 429);
    assert.doesNotMatch(fourth.body, /E-mail me a code/);
    assert.equal((await owner.one(`select count(*)::int as n from meta.mail_queue where template = 'SIGNIN_CODE'`)).n, 3);
  });
});

describe('step-up: a page that asks for the second step again', () => {
  // king's sessions in HR (this test's browser has the latest)
  const ageSecondStep = async (minutes: number) => {
    await owner.query(`update meta.session set state = jsonb_set(state, $2, to_jsonb($3::bigint)) where app_id = $1 and username = 'king'`,
      [appId, `{${MFA_AT}}`, Date.now() - minutes * 60_000]);
  };

  test('king (admin) gives his code again after 15 minutes; scott is refused; nobody without a factor gets in', async () => {
    await owner.query('update meta.page set authz = $3 where app_id = $1 and page_no = $2', [appId, pageNo, SCHEME]);
    try {
      await setMfa('roles', ['admin']);
      const secret = newTotpSecret();
      await addAccountTotp((await accountId('king'))!, 'Phone', secret, stepNow() - 5);
      const b = new Browser(app);
      await b.login('king');
      await b.get('/a/hr/login/2fa');
      assert.equal((await b.post('/a/hr/login/2fa', { __csrf: b.lastCsrf, code: totpAt(unbase32(secret), stepNow()) })).statusCode, 303);
      assert.equal((await b.get(`/a/hr/${pageNo}`)).statusCode, 200, 'right after the second step');

      await ageSecondStep(16);
      const asked = await b.get(`/a/hr/${pageNo}?x=1`);
      assert.equal(asked.statusCode, 303);
      assert.equal(asked.headers.location, `/a/hr/login/2fa?next=${encodeURIComponent(`/a/hr/${pageNo}?x=1`)}`);
      const page = await b.get(String(asked.headers.location));
      assert.equal(page.statusCode, 200);
      assert.match(page.body, /Confirm it(’|'|&#39;)s you/);
      const back = await b.post('/a/hr/login/2fa', { __csrf: b.lastCsrf, code: totpAt(unbase32(secret), stepNow() + 1) });
      assert.equal(back.statusCode, 303);
      assert.equal(back.headers.location, `/a/hr/${pageNo}?x=1`);
      assert.equal((await b.get(`/a/hr/${pageNo}`)).statusCode, 200);
      assert.ok(await owner.one(`select 1 as ok from meta.activity_log where app_id = $1 and username = 'king' and event = '2fa_stepup'`, [appId]));

      // scott has no admin role: refused, not asked
      const s = new Browser(app);
      await s.login('scott');
      assert.equal((await s.get(`/a/hr/${pageNo}`)).statusCode, 403);
    } finally {
      await owner.query('update meta.page set authz = $3 where app_id = $1 and page_no = $2', [appId, pageNo, oldAuthz]);
    }
  });

  test('a user without a factor is told to add one', async () => {
    await owner.query('update meta.page set authz = $3 where app_id = $1 and page_no = $2', [appId, pageNo, SCHEME]);
    try {
      await setMfa('optional');
      const b = new Browser(app);
      await b.login('king');
      const asked = await b.get(`/a/hr/${pageNo}`);
      assert.equal(asked.statusCode, 303);
      const page = await b.get(String(asked.headers.location));
      assert.equal(page.statusCode, 403);
      assert.match(page.body, /Add an authenticator app or a passkey on My account/);
    } finally {
      await owner.query('update meta.page set authz = $3 where app_id = $1 and page_no = $2', [appId, pageNo, oldAuthz]);
    }
  });
});

describe('REST API tokens and two-factor sign-in', () => {
  test('the builder issues no token for a user who must use two-factor sign-in; they create their own after a second step', async () => {
    await setMfa('roles', ['admin']);
    await assert.rejects(issueApiToken(appId, 'king', 1), /requires two-factor sign-in/);
    assert.ok((await issueApiToken(appId, 'scott', 1)).token, 'scott (no admin) still gets one');
    assert.ok((await issueApiToken(appId, 'king', 1, { internal: true })).token, 'Try it keeps working');

    await owner.query('update meta.app set api_self_tokens = true where id = $1', [appId]);
    const secret = newTotpSecret();
    await addAccountTotp((await accountId('king'))!, 'Phone', secret, stepNow() - 5);
    const b = new Browser(app);
    await b.login('king');
    await b.get('/a/hr/login/2fa');
    await b.post('/a/hr/login/2fa', { __csrf: b.lastCsrf, code: totpAt(unbase32(secret), stepNow()) });
    const account = await b.get('/a/hr/account');
    assert.match(account.body, /REST API token/);
    const made = await b.post('/a/hr/account/token', { __csrf: b.lastCsrf, hours: '2' });
    assert.equal(made.statusCode, 303);
    const shown = await b.get('/a/hr/account');
    const token = /<textarea id="api_token"[^>]*>([^<]+)<\/textarea>/.exec(shown.body)?.[1];
    assert.ok(token, 'shown once');
    const { payload } = await jwtVerify(token!, jwtSecret());
    assert.equal(payload.app_user, 'king');
    assert.doesNotMatch((await b.get('/a/hr/account')).body, /id="api_token"/, 'only once');

    // an old second step: asked again first
    await owner.query(`update meta.session set state = state - $2 where app_id = $1 and username = 'king'`, [appId, MFA_AT]);
    const again = await b.post('/a/hr/account/token', { __csrf: b.lastCsrf, hours: '2' });
    assert.equal(again.statusCode, 303);
    assert.match(String(again.headers.location), /^\/a\/hr\/login\/2fa\?next=/);
  });

  test('off by default: no section and no token', async () => {
    await owner.query('update meta.app set api_self_tokens = false where id = $1', [appId]);
    const b = new Browser(app);
    await b.login('scott');
    assert.doesNotMatch((await b.get('/a/hr/account')).body, /REST API token/);
    const r = await b.post('/a/hr/account/token', { __csrf: b.lastCsrf, hours: '2' });
    assert.equal(r.statusCode, 303);
    assert.doesNotMatch((await b.get('/a/hr/account')).body, /id="api_token"/);
  });
});
