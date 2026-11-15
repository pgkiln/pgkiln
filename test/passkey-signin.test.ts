// Sprint 199 (NX-U6): signing in to an application with a passkey alone (meta.app.passkey_signin, migration 173), and
// the application's look on the sign-in card. The card's "done when": an HR user with a passkey signs in with one tap,
// without typing a username. The checks an attacker would try are in test/security.test.ts ("sprint 199 NX-U6").
process.env.PGKILN_SECRET_KEY ??= 'test-only-secret-key-0123456789abcdef';
process.env.API_JWT_SECRET ??= 'ci-only-api-secret-not-for-production-0123456789';
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { passkeyAlone } from '../src/account-mfa.ts';
import { Authenticator } from './authenticator.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
let saved: { passkey_signin: boolean; mfa: string; mfa_roles: string[]; login_page: number | null; local_login: boolean };

const users = ['king', 'scott'];
const clearFactors = async () => {
  await owner.query(`delete from meta.account_factor where account_id in (select id from meta.account where username = any($1))`, [users]);
  await owner.query(`delete from meta.account_recovery_code where account_id in (select id from meta.account where username = any($1))`, [users]);
};
const unlock = (user: string) => owner.query(`insert into meta.activity_log (username, event, detail) values ($1, 'login_unlocked', 'test')`, [user]);
const set = (cols: Record<string, unknown>) => {
  const keys = Object.keys(cols);
  return owner.query(`update meta.app set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} where id = $1`, [appId, ...keys.map((k) => cols[k])]);
};
const signedIn = async (b: Browser) => (await b.get('/a/hr/2')).statusCode === 200;

async function options(b: Browser, url: string) {
  const r = await b.request('POST', url, { __csrf: b.lastCsrf });
  assert.equal(r.statusCode, 200, r.body);
  return JSON.parse(r.body);
}

/** king signs in with his password and adds a passkey on My account. */
async function addPasskey(key: Authenticator, user = 'king') {
  const b = new Browser(app);
  await b.login(user);
  const account = await b.get('/a/hr/account');
  assert.match(account.body, /data-passkey="\/a\/hr\/account\/2fa\/passkey\/options"/);
  const o = await options(b, '/a/hr/account/2fa/passkey/options');
  assert.equal(o.rk, 'required', 'a passkey that signs in alone is discoverable');
  assert.equal((await b.post('/a/hr/account/2fa/passkey', { __csrf: b.lastCsrf, pk_name: 'Phone', ...key.create(o.challenge) })).statusCode, 303);
  await b.post('/a/hr/account/2fa/codes/confirm', { __csrf: b.lastCsrf, saved: '1' });
}

/** One tap: the sign-in page, the options, the authenticator's answer (user verified). */
async function tap(b: Browser, key: Authenticator, flags = 0x05) {
  await b.get('/a/hr/login');
  const o = await options(b, '/a/hr/login/passkey/options');
  return b.post('/a/hr/login/passkey', { __csrf: b.lastCsrf, next: '', ...key.get(o.challenge, undefined, undefined, flags) });
}

before(async () => {
  app = await buildApp({ logger: false });
  const a = await owner.one(`select id, passkey_signin, mfa, mfa_roles, login_page, local_login from meta.app where alias = 'hr'`);
  appId = a.id;
  saved = a;
});

beforeEach(async () => {
  await clearFactors();
  await set({ passkey_signin: true, mfa: 'off', mfa_roles: [], login_page: null, local_login: true });
  for (const u of users) await unlock(u);
});

after(async () => {
  await clearFactors();
  await set({ passkey_signin: saved.passkey_signin, mfa: saved.mfa, mfa_roles: saved.mfa_roles, login_page: saved.login_page, local_login: saved.local_login });
  await app.close();
  await closePools();
});

describe('sprint 199 NX-U6: signing in with a passkey alone', () => {
  test('only for the user directory with password sign-in, and only when the setting is on', () => {
    assert.equal(passkeyAlone({ authentication: 'app_users', local_login: true, passkey_signin: true }), true);
    assert.equal(passkeyAlone({ authentication: 'app_users', local_login: true, passkey_signin: false }), false);
    assert.equal(passkeyAlone({ authentication: 'app_users', local_login: false, passkey_signin: true }), false);
    for (const authentication of ['database', 'custom', 'header', 'none']) assert.equal(passkeyAlone({ authentication, local_login: true, passkey_signin: true }), false);
  });

  test('the sign-in page: the button above the password fields, hidden until JavaScript shows it; the app\'s mark and colours', async () => {
    await owner.query(`update meta.app set theme = theme || '{"header": "#123456"}'::jsonb where id = $1`, [appId]);
    try {
      const page = (await new Browser(app).get('/a/hr/login')).body;
      const block = page.indexOf('data-passkey-block');
      assert.ok(block > 0, 'the passkey block');
      assert.ok(block < page.indexOf('name="password"'), 'above the password');
      assert.match(page, /<form method="post" action="\/a\/hr\/login\/passkey" class="login-passkey" data-passkey-block hidden>/);
      assert.match(page, /<button type="button" class="btn btn-hot login-passkey-button" hidden data-passkey="\/a\/hr\/login\/passkey\/options"/);
      assert.match(page, /Sign in with a passkey/);
      assert.match(page, /class="login-mark" src="\/a\/hr\/icon-192\.png"/, 'HR is a PWA: its icon');
      assert.match(page, /<style nonce="[^"]+">html:root\{[^}]*--header:#123456/, 'the theme colours');
      assert.doesNotMatch(page, / style="/, 'no style attributes (CSP)');
    } finally {
      await owner.query(`update meta.app set theme = theme - 'header' where id = $1`, [appId]);
    }
    await set({ passkey_signin: false });
    const off = (await new Browser(app).get('/a/hr/login')).body;
    assert.doesNotMatch(off, /data-passkey/);
    assert.match(off, /name="password"/, 'the password form as before');
  });

  test('an application without a PWA icon shows its initial', async () => {
    await set({ pwa: false });
    try {
      assert.match((await new Browser(app).get('/a/hr/login')).body, /<span class="login-mark login-mark-letter" aria-hidden="true">H<\/span>/);
    } finally {
      await set({ pwa: true });
    }
  });

  test('done when: a user with a passkey signs in with one tap, without a username', async () => {
    const key = new Authenticator();
    await addPasskey(key);
    const b = new Browser(app);
    await b.get('/a/hr/login');
    const o = await options(b, '/a/hr/login/passkey/options');
    assert.equal(o.mode, 'get');
    assert.deepEqual(o.allow, [], 'discoverable: the browser offers the passkeys it holds');
    assert.equal(o.uv, 'required');
    assert.equal(o.rpId, 'localhost');
    const res = await b.post('/a/hr/login/passkey', { __csrf: b.lastCsrf, next: '/a/hr/2', ...key.get(o.challenge) });
    assert.equal(res.statusCode, 303, res.body.slice(0, 300));
    assert.equal(res.headers.location, '/a/hr/2');
    assert.equal(await signedIn(b), true);
    const log = await owner.one(`select username, detail from meta.activity_log where app_id = $1 and event = 'login' order by id desc limit 1`, [appId]);
    assert.deepEqual([log.username, log.detail], ['king', 'passkey (user verified)']);
    const s = await owner.one(`select state from meta.session where app_id = $1 and username = 'king' order by created_at desc limit 1`, [appId]);
    assert.equal(s.state.__SIGNIN, 'passkey+2fa');
    assert.ok(Number(s.state.__MFA_AT) > 0, 'the session had a second step');
  });

  test('two-step sign-in required: no second step after a user-verified passkey', async () => {
    const key = new Authenticator('ed25519');
    await set({ mfa: 'optional' });
    await addPasskey(key);
    await set({ mfa: 'required' });
    const pw = new Browser(app);
    assert.equal((await pw.login('king')).headers.location, '/a/hr/login/2fa', 'the password still needs the second step');
    const b = new Browser(app);
    const res = await tap(b, key);
    assert.equal(res.statusCode, 303);
    assert.doesNotMatch(String(res.headers.location), /2fa/);
    assert.equal(await signedIn(b), true);
  });

  test('My account offers passkeys (not authenticator apps) when only passkey sign-in is on', async () => {
    const b = new Browser(app);
    await b.login('king');
    const page = (await b.get('/a/hr/account')).body;
    assert.match(page, /id="two-step"/);
    assert.match(page, /You can also sign in with a passkey alone/);
    assert.doesNotMatch(page, /account\/2fa\/start/, 'no authenticator app without a second step');
    await b.post('/a/hr/account/2fa/start', { __csrf: b.lastCsrf });
    assert.doesNotMatch((await b.get('/a/hr/account')).body, /mfa-secret/);
    await set({ passkey_signin: false });
    assert.doesNotMatch((await b.get('/a/hr/account')).body, /id="two-step"/, 'neither: no section, as before');
  });

  test('the application\'s own login page: the login region\'s button posts a detached form', async () => {
    // a login page of HR's own for this test (page 9199: public, minimal, a Login region)
    const page = 9199;
    await owner.query('delete from meta.page where app_id = $1 and page_no = $2', [appId, page]);
    const pid = (await owner.one(`insert into meta.page (app_id, page_no, name, title, requires_auth, page_template) values ($1, $2, 'Login', 'HR', false, 'minimal') returning id`, [appId, page])).id;
    await owner.query(`insert into meta.region (page_id, seq, title, type, template) values ($1, 10, 'HR', 'login', 'standard')`, [pid]);
    const key = new Authenticator();
    await addPasskey(key);
    await set({ login_page: page });
    try {
      await ownLoginPage(page, key);
    } finally {
      await set({ login_page: null });
      await owner.query('delete from meta.page where id = $1', [pid]);
    }
  });

  async function ownLoginPage(page: number, key: Authenticator) {
    const b = new Browser(app);
    const body = (await b.get(`/a/hr/${page}`)).body;
    assert.match(body, /<form id="pgkiln-login-passkey" method="post" action="\/a\/hr\/login\/passkey"><\/form>/);
    assert.match(body, /<div class="login-passkey" data-passkey-block hidden>/);
    assert.match(body, /data-passkey="\/a\/hr\/login\/passkey\/options" data-passkey-error="[^"]+" form="pgkiln-login-passkey"/);
    await options(b, '/a/hr/login/passkey/options');
    // a failure goes back to the login page with the message
    const bad = await b.post('/a/hr/login/passkey', { __csrf: b.lastCsrf, ...key.get('not-the-challenge') });
    assert.equal(bad.statusCode, 303);
    assert.equal(bad.headers.location, `/a/hr/${page}`);
    assert.match((await b.get(`/a/hr/${page}`)).body, /The passkey did not sign you in/);
    const ok = await b.post('/a/hr/login/passkey', { __csrf: b.lastCsrf, ...key.get((await options(b, '/a/hr/login/passkey/options')).challenge) });
    assert.equal(ok.statusCode, 303);
    assert.equal(await signedIn(b), true);
  }

  test('an expired password: changed with the password first', async () => {
    const key = new Authenticator();
    await addPasskey(key);
    await owner.query(`update meta.account set must_change_password = true where username = 'king'`);
    try {
      const b = new Browser(app);
      const res = await tap(b, key);
      assert.equal(res.statusCode, 403);
      assert.match(res.body, /Your password has expired/);
      assert.equal(await signedIn(b), false);
    } finally {
      await owner.query(`update meta.account set must_change_password = false where username = 'king'`);
    }
  });

  test('exported and imported with the application; an older export imports with it off', async () => {
    const doc = (await owner.one(`select meta.export_app('hr') as d`)).d;
    assert.equal(doc.app.passkey_signin, true);
    delete doc.app.passkey_signin;
    await owner.query(`delete from meta.app where alias = 'hr_s199_old'`);
    try {
      const id = (await owner.one(`select meta.import_app($1::jsonb, 'hr_s199_old') as id`, [JSON.stringify(doc)])).id;
      assert.equal((await owner.one('select passkey_signin from meta.app where id = $1', [id])).passkey_signin, false);
    } finally {
      await owner.query(`delete from meta.app where alias = 'hr_s199_old'`);
    }
  });

  test('Settings → Sign-in: the setting is shown and saved', async () => {
    const dev = new Browser(app);
    await dev.get('/builder/login');
    await dev.post('/builder/login', { __csrf: dev.lastCsrf, username: 'admin', password: 'admin' });
    const page = (await dev.get(`/builder/apps/${appId}/settings?tab=signin`)).body;
    assert.match(page, /<input type="checkbox" name="passkey_signin" value="true" aria-describedby="f_passkey_signin_help" checked>/);
    assert.match(page, /Users may sign in with a passkey alone/);
    const { saveLoginSettings } = await import('../src/builder/login-page.ts');
    await saveLoginSettings(String(appId), { mfa: 'off' });
    assert.equal((await owner.one('select passkey_signin from meta.app where id = $1', [appId])).passkey_signin, false);
    await saveLoginSettings(String(appId), { mfa: 'off', passkey_signin: 'true' });
    assert.equal((await owner.one('select passkey_signin from meta.app where id = $1', [appId])).passkey_signin, true);
  });
});
