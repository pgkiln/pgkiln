// Sprint 130 (SEC-3, part 1): two-factor sign-in for application users, per application and per role. The card's
// "done when": HR set to "required for roles: admin" makes king add an authenticator app at his next sign-in and then
// give a code, while scott (no admin role) signs in with his password. Recovery codes, remembered and shared
// sign-ins, My account, the builder's settings, Users (reset) and the Advisor.
process.env.PGKILN_SECRET_KEY ??= 'test-only-secret-key-0123456789abcdef';
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { stepNow, totpAt, unbase32 } from '../src/mfa.ts';
import { advise } from '../src/builder/advisor.ts';
import { saveLoginSettings } from '../src/builder/login-page.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;

const clearFactors = () => owner.query(`delete from meta.account_factor where account_id in (select id from meta.account where username in ('king', 'scott'))`)
  .then(() => owner.query(`delete from meta.account_recovery_code where account_id in (select id from meta.account where username in ('king', 'scott'))`));
const setMfa = (mfa: string, roles: string[] = []) => owner.query('update meta.app set mfa = $2, mfa_roles = $3 where id = $1', [appId, mfa, roles]);
const unlock = (user: string) => owner.query(`insert into meta.activity_log (username, event, detail) values ($1, 'login_unlocked', 'test')`, [user]);

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
});

beforeEach(async () => {
  await clearFactors();
  await setMfa('off');
  await unlock('king');
  await unlock('scott');
});

after(async () => {
  await clearFactors();
  await setMfa('off');
  await owner.query('update meta.app set remember_me_days = null where id = $1', [appId]);
  await owner.query('delete from meta.persistent_login where app_id = $1', [appId]);
  await app.close();
  await closePools();
});

const signedIn = async (b: Browser) => (await b.get('/a/hr/2')).statusCode === 200;
const code = (secret: string, offset = 0) => totpAt(unbase32(secret), stepNow() + offset);

/** king signs in with his password and adds an app while signing in; returns the browser, the secret and the recovery codes. */
async function enrolKing() {
  const b = new Browser(app);
  const res = await b.login('king');
  assert.equal(res.statusCode, 303);
  assert.equal(res.headers.location, '/a/hr/login/2fa');
  const page = await b.get('/a/hr/login/2fa');
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Set up two-factor sign-in/);
  assert.match(page.body, /<svg/, 'a QR code');
  const secret = page.body.match(/<code class="mfa-secret">([A-Z2-7 ]+)<\/code>/)![1].replace(/ /g, '');
  assert.equal(await signedIn(b), false, 'no session before the second step');
  const wrong = await b.post('/a/hr/login/2fa', { __csrf: b.lastCsrf, code: '000000' === code(secret) ? '111111' : '000000' });
  assert.equal(wrong.statusCode, 401);
  const shown = await b.post('/a/hr/login/2fa', { __csrf: b.lastCsrf, code: code(secret) });
  assert.equal(shown.statusCode, 200);
  const codes = [...shown.body.matchAll(/<li><code>([a-z0-9]{5}-[a-z0-9]{5})<\/code><\/li>/g)].map((m) => m[1]);
  assert.equal(codes.length, 10, 'ten recovery codes, shown once');
  const done = await b.post('/a/hr/login/2fa/done', { __csrf: b.lastCsrf, saved: '1' });
  assert.equal(done.statusCode, 303);
  assert.equal(await signedIn(b), true);
  return { b, secret, codes };
}

describe('two-factor sign-in for application users', () => {
  test('required for the admin role: king adds an app and gives a code; scott signs in with his password', async () => {
    await setMfa('roles', ['admin']);
    const { secret } = await enrolKing();
    const log = await owner.one(`select detail from meta.activity_log where app_id = $1 and username = 'king' and event = 'login' order by id desc limit 1`, [appId]);
    assert.equal(log.detail, 'password 2fa (new app)');

    const scott = new Browser(app);
    assert.notEqual((await scott.login('scott')).headers.location, '/a/hr/login/2fa');
    assert.equal(await signedIn(scott), true, 'no second step for scott');

    // the next sign-in: a code; the code of a step already used is refused
    const b = new Browser(app);
    assert.equal((await b.login('king')).headers.location, '/a/hr/login/2fa');
    const page = await b.get('/a/hr/login/2fa');
    assert.match(page.body, /authenticator app, or one of your recovery codes/);
    assert.doesNotMatch(page.body, /mfa-secret/, 'no new app');
    assert.equal((await b.post('/a/hr/login/2fa', { __csrf: b.lastCsrf, code: code(secret) })).statusCode, 401, 'the same step once');
    const ok = await b.post('/a/hr/login/2fa', { __csrf: b.lastCsrf, code: code(secret, 1) });
    assert.equal(ok.statusCode, 303);
    assert.equal(await signedIn(b), true);
  });

  test('a recovery code signs in once and leads to My account', async () => {
    await setMfa('required');
    const { codes } = await enrolKing();
    const b = new Browser(app);
    await b.login('king');
    await b.get('/a/hr/login/2fa');
    const res = await b.post('/a/hr/login/2fa', { __csrf: b.lastCsrf, code: codes[0].toUpperCase() });
    assert.equal(res.statusCode, 303);
    assert.equal(res.headers.location, '/a/hr/account#two-step');
    const account = await b.get('/a/hr/account');
    assert.match(account.body, /Recovery codes left: 9/);
    const again = new Browser(app);
    await again.login('king');
    await again.get('/a/hr/login/2fa');
    assert.equal((await again.post('/a/hr/login/2fa', { __csrf: again.lastCsrf, code: codes[0] })).statusCode, 401, 'used up');
  });

  test('wrong codes count as failed sign-ins: the account locks', async () => {
    await setMfa('required');
    await enrolKing();
    await unlock('king');
    const b = new Browser(app);
    await b.login('king');
    await b.get('/a/hr/login/2fa');
    let last = 0;
    for (let i = 0; i < 12 && last !== 429; i++) last = (await b.post('/a/hr/login/2fa', { __csrf: b.lastCsrf, code: 'abcde-fghjk' })).statusCode;
    assert.equal(last, 429);
    await unlock('king');
  });

  test('optional: only users who added an app give a code; off: nobody does', async () => {
    await setMfa('optional');
    const scott = new Browser(app);
    await scott.login('scott');
    assert.equal(await signedIn(scott), true);
    // scott adds an app on My account
    const account = await scott.get('/a/hr/account');
    assert.match(account.body, /Add an authenticator app/);
    await scott.post('/a/hr/account/2fa/start', { __csrf: scott.lastCsrf });
    const setup = await scott.get('/a/hr/account');
    const secret = setup.body.match(/<code class="mfa-secret">([A-Z2-7 ]+)<\/code>/)![1].replace(/ /g, '');
    assert.equal((await scott.post('/a/hr/account/2fa/confirm', { __csrf: scott.lastCsrf, name: 'Phone', code: code(secret) })).statusCode, 303);
    const shown = await scott.get('/a/hr/account');
    assert.match(shown.body, /<strong>Phone<\/strong>/);
    assert.equal([...shown.body.matchAll(/<li><code>[a-z0-9]{5}-[a-z0-9]{5}<\/code><\/li>/g)].length, 10);
    await scott.post('/a/hr/account/2fa/codes/confirm', { __csrf: scott.lastCsrf, saved: '1' });

    const again = new Browser(app);
    assert.equal((await again.login('scott')).headers.location, '/a/hr/login/2fa');
    await setMfa('off');
    const off = new Browser(app);
    await off.login('scott');
    assert.equal(await signedIn(off), true, 'off: no second step, even with an app');
    assert.doesNotMatch((await off.get('/a/hr/account')).body, /id="two-step"/);

    // removing the app needs a code
    await setMfa('optional');
    const id = (await owner.one(`select f.id from meta.account_factor f join meta.account a on a.id = f.account_id where a.username = 'scott'`)).id;
    await owner.query('update meta.account_factor set last_step = null where id = $1', [id]);
    await scott.get('/a/hr/account');
    await scott.post(`/a/hr/account/2fa/${id}/delete`, { __csrf: scott.lastCsrf, code: '000000' === code(secret) ? '111111' : '000000' });
    assert.ok(await owner.one('select 1 as ok from meta.account_factor where id = $1', [id]), 'a wrong code removes nothing');
    await scott.post(`/a/hr/account/2fa/${id}/delete`, { __csrf: scott.lastCsrf, code: code(secret) });
    assert.equal(await owner.one('select 1 as ok from meta.account_factor where id = $1', [id]), undefined);
    assert.equal((await owner.one(`select count(*)::int as n from meta.account_recovery_code r join meta.account a on a.id = r.account_id where a.username = 'scott'`)).n, 0, 'the codes go with the last app');
  });

  test('the last app stays while the application requires it', async () => {
    await setMfa('roles', ['admin']);
    const { b, secret } = await enrolKing();
    const id = (await owner.one(`select f.id from meta.account_factor f join meta.account a on a.id = f.account_id where a.username = 'king'`)).id;
    await b.get('/a/hr/account');
    await b.post(`/a/hr/account/2fa/${id}/delete`, { __csrf: b.lastCsrf, code: code(secret, 1) });
    assert.ok(await owner.one('select 1 as ok from meta.account_factor where id = $1', [id]));
    assert.match((await b.get('/a/hr/account')).body, /add another app before you remove this one/);
  });

  test('a remembered sign-in made with only a password does not skip the second step', async () => {
    await owner.query('update meta.app set remember_me_days = 30 where id = $1', [appId]);
    await owner.query('delete from meta.persistent_login where app_id = $1', [appId]);
    const old = new Browser(app);
    await old.get('/a/hr/login');
    await old.post('/a/hr/login', { __csrf: old.lastCsrf, username: 'king', password: 'king', remember: 'true' });
    assert.equal(await signedIn(old), true);
    // then the application requires a second step, and king adds an app
    await setMfa('required');
    const { secret } = await enrolKing();
    await owner.query(`delete from meta.session where app_id = $1 and username = 'king'`, [appId]);
    assert.equal(await signedIn(old), false, 'the old remembered sign-in had no second step');

    // one made with the second step does
    await owner.query(`update meta.account_factor set last_step = null where account_id = (select id from meta.account where username = 'king')`);
    const fresh = new Browser(app);
    await fresh.get('/a/hr/login');
    await fresh.post('/a/hr/login', { __csrf: fresh.lastCsrf, username: 'king', password: 'king', remember: 'true' });
    await fresh.get('/a/hr/login/2fa');
    assert.equal((await fresh.post('/a/hr/login/2fa', { __csrf: fresh.lastCsrf, code: code(secret) })).statusCode, 303);
    assert.equal((await owner.one(`select method from meta.persistent_login where app_id = $1 order by id desc limit 1`, [appId])).method, 'password+2fa');
    await owner.query(`delete from meta.session where app_id = $1 and username = 'king'`, [appId]);
    assert.equal(await signedIn(fresh), true);
    await owner.query('update meta.app set remember_me_days = null where id = $1', [appId]);
  });

  test('the second step expires and needs the session it started in', async () => {
    await setMfa('required');
    const b = new Browser(app);
    await b.login('king');
    const other = new Browser(app);
    const page = await other.get('/a/hr/login/2fa');
    assert.equal(page.statusCode, 410, 'another browser has nothing pending');
    const sid = (await owner.one(`select id from meta.session where app_id = $1 and state ? '__MFA' order by created_at desc limit 1`, [appId])).id;
    await owner.query(`update meta.session set state = jsonb_set(state, '{__MFA}', to_jsonb(jsonb_set((state->>'__MFA')::jsonb, '{at}', '0')::text)) where id = $1`, [sid]);
    assert.equal((await b.get('/a/hr/login/2fa')).statusCode, 410);
  });
});

describe('the builder', () => {
  const builder = async () => {
    const b = new Browser(app);
    await b.get('/builder/login');
    assert.equal((await b.submit('/builder/login', { username: 'admin', password: 'admin' })).statusCode, 303);
    return b;
  };

  test('Application settings: the second step, with roles', async () => {
    const b = await builder();
    const page = await b.get(`/builder/apps/${appId}/settings?tab=signin`);
    assert.match(page.body, /<select id="f_mfa" name="mfa"/);
    await assert.rejects(saveLoginSettings(String(appId), { mfa: 'roles', mfa_roles: ' ' }), /name the roles/);
    await saveLoginSettings(String(appId), { mfa: 'roles', mfa_roles: 'Admin, manager, admin' });
    const row = await owner.one('select mfa, mfa_roles from meta.app where id = $1', [appId]);
    assert.deepEqual([row.mfa, row.mfa_roles], ['roles', ['admin', 'manager']]);
    await saveLoginSettings(String(appId), { mfa: 'bogus' });
    assert.equal((await owner.one('select mfa from meta.app where id = $1', [appId])).mfa, 'off');
    // without the instance key, requiring it would lock users out
    const key = process.env.PGKILN_SECRET_KEY;
    delete process.env.PGKILN_SECRET_KEY;
    try {
      await assert.rejects(saveLoginSettings(String(appId), { mfa: 'required' }), /PGKILN_SECRET_KEY/);
    } finally {
      process.env.PGKILN_SECRET_KEY = key;
    }
  });

  test('Users: who has an app, and a reset with a reason', async () => {
    await setMfa('required');
    const { b: king } = await enrolKing();
    const b = await builder();
    assert.match((await b.get('/builder/users?q=king')).body, /Two-factor[\s\S]*on/);
    const kingId = (await owner.one(`select id from meta.account where username = 'king'`)).id;
    const detail = await b.get(`/builder/users/${kingId}`);
    assert.match(detail.body, /Authenticator apps: 1\. Recovery codes left: 10\./);
    await b.submit(`/builder/users/${kingId}/reset-2fa`, { reason: '' });
    assert.ok(await owner.one('select 1 as ok from meta.account_factor where account_id = $1', [kingId]), 'no reason, no reset');
    const res = await b.submit(`/builder/users/${kingId}/reset-2fa`, { reason: 'lost phone' });
    assert.equal(res.statusCode, 303);
    assert.equal(await owner.one('select 1 as ok from meta.account_factor where account_id = $1', [kingId]), undefined);
    assert.equal(await signedIn(king), false, 'signed out');
    const log = await owner.one(`select detail from meta.activity_log where event = '2fa_reset' and username = 'king' order by id desc limit 1`);
    assert.equal(log.detail, 'by admin: lost phone');
    // the next sign-in adds a new app
    assert.equal((await new Browser(app).login('king')).headers.location, '/a/hr/login/2fa');
  });

  test('the Advisor warns when users with the admin role sign in with only a password', async () => {
    const field = 'Application settings → Two-factor sign-in';
    assert.ok((await advise(appId)).findings.some((f) => f.field === field));
    await setMfa('roles', ['admin']);
    assert.ok(!(await advise(appId)).findings.some((f) => f.field === field));
  });
});
