// Account self-service: own password, expiry and first-use change, admin
// password reset, preferences (theme, language).
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { clearAccountSettings } from '../src/accounts.ts';
import { buildApp } from '../src/app.ts';
import { roleHints, roleHintsHtml } from '../src/builder/users.ts';
import { closePools, owner } from '../src/db.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
const created: string[] = [];

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
});

after(async () => {
  for (const u of created) {
    await owner.query('delete from meta.activity_log where lower(username) = lower($1)', [u]);
    await owner.query('delete from meta.account where username = $1', [u]);
  }
  await owner.query(`update meta.setting set value = '0' where name = 'password_lifetime_days'`);
  await app.close();
  await closePools();
});

beforeEach(() => clearAccountSettings());

/** A fresh account with access to HR (password "correct-horse-1"). */
async function account(opts: { mustChange?: boolean; email?: boolean } = {}) {
  const u = `acc_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  created.push(u);
  const r = await owner.one(
    `insert into meta.account (username, password_hash, must_change_password, email)
     values ($1, meta.hash_password('correct-horse-1'), $2, $3) returning id`,
    [u, !!opts.mustChange, opts.email === false ? null : `${u}@example.com`],
  );
  await owner.query(`insert into meta.app_access (app_id, account_id, roles) values ($1, $2, '{}')`, [appId, r.id]);
  return u;
}

describe('own password', () => {
  test('a user changes their password on My account; other sessions end', async () => {
    const u = await account();
    const other = new Browser(app);
    assert.equal((await other.login(u, 'correct-horse-1')).statusCode, 303);
    const b = new Browser(app);
    await b.login(u, 'correct-horse-1');
    const page = await b.get('/a/hr/account');
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /Change password/);
    assert.equal((await b.submit('/a/hr/account/password', { password: 'wrong', new_password: 'new-horse-22', confirm_password: 'new-horse-22' })).statusCode, 401);
    await b.get('/a/hr/account');
    assert.equal((await b.submit('/a/hr/account/password', { password: 'correct-horse-1', new_password: 'new-horse-22', confirm_password: 'other' })).statusCode, 422, 'mismatch');
    await b.get('/a/hr/account');
    assert.equal((await b.submit('/a/hr/account/password', { password: 'correct-horse-1', new_password: 'short', confirm_password: 'short' })).statusCode, 422, 'policy');
    await b.get('/a/hr/account');
    assert.equal((await b.submit('/a/hr/account/password', { password: 'correct-horse-1', new_password: `x${u}x-99`, confirm_password: `x${u}x-99` })).statusCode, 422, 'contains username');
    await b.get('/a/hr/account');
    const ok = await b.submit('/a/hr/account/password', { password: 'correct-horse-1', new_password: 'new-horse-22', confirm_password: 'new-horse-22' });
    assert.equal(ok.statusCode, 303);
    assert.match((await b.get('/a/hr/account')).body, /Your password was changed/);
    assert.equal((await b.get('/a/hr/1')).statusCode, 200, 'this session stays');
    assert.equal((await other.get('/a/hr/1')).statusCode, 302, 'the other session ended');
    assert.equal((await new Browser(app).login(u, 'correct-horse-1')).statusCode, 401, 'old password');
    assert.equal((await new Browser(app).login(u, 'new-horse-22')).statusCode, 303, 'new password');
  });

  test('My account needs a signed-in user and a CSRF token', async () => {
    const anon = new Browser(app);
    assert.equal((await anon.get('/a/hr/account')).statusCode, 302);
    const u = await account();
    const b = new Browser(app);
    await b.login(u, 'correct-horse-1');
    const res = await b.post('/a/hr/account/password', { __csrf: 'forged', password: 'correct-horse-1', new_password: 'new-horse-22', confirm_password: 'new-horse-22' });
    assert.equal(res.statusCode, 303);
    assert.equal((await new Browser(app).login(u, 'correct-horse-1')).statusCode, 303, 'password unchanged');
  });
});

describe('expiry and first use', () => {
  test('"change on first use" asks for a new password before signing in', async () => {
    const u = await account({ mustChange: true });
    const b = new Browser(app);
    const res = await b.login(u, 'correct-horse-1');
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /Change your password/);
    assert.equal((await b.get('/a/hr/1')).statusCode, 302, 'not signed in yet');
    // the change form needs the current password again
    assert.equal((await b.submit('/a/hr/password', { username: u, password: 'nope', new_password: 'fresh-horse-3', confirm_password: 'fresh-horse-3' })).statusCode, 401);
    const bad = await b.submit('/a/hr/password', { username: u, password: 'correct-horse-1', new_password: 'correct-horse-1', confirm_password: 'correct-horse-1' });
    assert.equal(bad.statusCode, 422, 'must differ');
    const done = await b.submit('/a/hr/password', { username: u, password: 'correct-horse-1', new_password: 'fresh-horse-3', confirm_password: 'fresh-horse-3' });
    assert.equal(done.statusCode, 303);
    assert.equal((await b.get('/a/hr/1')).statusCode, 200, 'signed in');
    assert.equal((await owner.one('select must_change_password from meta.account where username = $1', [u])).must_change_password, false);
  });

  test('passwords expire after the configured lifetime', async () => {
    const u = await account();
    await owner.query(`update meta.setting set value = '30' where name = 'password_lifetime_days'`);
    await owner.query(`update meta.account set password_changed_at = now() - interval '31 days' where username = $1`, [u]);
    const b = new Browser(app);
    assert.match((await b.login(u, 'correct-horse-1')).body, /Change your password/);
    await owner.query(`update meta.account set password_changed_at = now() - interval '10 days' where username = $1`, [u]);
    assert.equal((await owner.one('select meta.password_days_left($1) as d', [u])).d, 20);
    assert.equal((await new Browser(app).login(u, 'correct-horse-1')).statusCode, 303);
    await owner.query(`update meta.setting set value = '0' where name = 'password_lifetime_days'`);
  });

  test('admin reset requires a change; expire and unexpire', async () => {
    const u = await account();
    await owner.query(`select meta.set_password($1, 'admin-set-pw-1')`, [u]);
    assert.match((await new Browser(app).login(u, 'admin-set-pw-1')).body, /Change your password/);
    await owner.query('select meta.unexpire_password($1)', [u]);
    assert.equal((await new Browser(app).login(u, 'admin-set-pw-1')).statusCode, 303);
    await owner.query('select meta.expire_password($1)', [u]);
    assert.match((await new Browser(app).login(u, 'admin-set-pw-1')).body, /Change your password/);
    await assert.rejects(owner.query(`set local role pgapex_runtime; select meta.set_password('king', 'x')`), /permission denied/);
  });
});

describe('no e-mail features', () => {
  // pgkiln doesn't send mail (owner decision, sprint 6): there is no
  // "forgot password" link or page, and no mail tables.
  test('the login page has no forgot-password link and the old pages are gone', async () => {
    const b = new Browser(app);
    const login = await b.get('/a/hr/login');
    assert.doesNotMatch(login.body, /forgot/i);
    assert.equal((await b.get('/a/hr/forgot')).statusCode, 404);
    assert.equal((await b.get('/a/hr/reset?token=x')).statusCode, 404);
  });

  test('the mail and password-reset objects do not exist', async () => {
    const r = await owner.one(`select to_regclass('meta.mail_queue') as q, to_regclass('meta.email_template') as t,
                                      to_regclass('meta.password_reset') as r, to_regprocedure('meta.send_mail(text,text,text,text,text,text,text,text)') as f`);
    assert.deepEqual(r, { q: null, t: null, r: null, f: null });
  });
});

describe('preferences', () => {
  test('theme and language are saved on the account and applied at sign-in', async () => {
    const u = await account();
    const b = new Browser(app);
    await b.login(u, 'correct-horse-1');
    await b.get('/a/hr/account');
    assert.equal((await b.submit('/a/hr/account', { theme: 'dark', language: 'nl' })).statusCode, 303);
    const page = await b.get('/a/hr/1');
    assert.match(page.body, /<html lang="nl" data-theme="dark">/);
    assert.match(page.body, /Mijn meldingen/, 'translated');
    const acc = await owner.one('select theme_pref, language from meta.account where username = $1', [u]);
    assert.deepEqual(acc, { theme_pref: 'dark', language: 'nl' });
    const again = new Browser(app);
    await again.login(u, 'correct-horse-1');
    assert.match((await again.get('/a/hr/1')).body, /<html lang="nl" data-theme="dark">/, 'from the account at the next sign-in');
  });

  test('the quick theme switch redirects only within the app and respects the app setting', async () => {
    const b = new Browser(app);
    await b.login('allen');
    await b.get('/a/hr/1');
    const res = await b.submit('/a/hr/account/theme', { theme: 'light', next: 'https://evil.example/' });
    assert.equal(res.headers.location, '/a/hr/1');
    assert.match((await b.get('/a/hr/1')).body, /data-theme="light"/);
    await b.submit('/a/hr/account/theme', { theme: 'bogus', next: '/a/hr/2' });
    assert.match((await b.get('/a/hr/1')).body, /data-theme="light"/, 'invalid values ignored');
    await owner.query(`update meta.app set theme = theme || '{"user_choice": false, "mode": "dark"}' where id = $1`, [appId]);
    try {
      const page = (await b.get('/a/hr/1')).body;
      assert.match(page, /data-theme="dark"/, 'the app decides');
      assert.doesNotMatch(page, /theme-switch/);
    } finally {
      await owner.query(`update meta.app set theme = theme - 'user_choice' - 'mode' where id = $1`, [appId]);
      await owner.query(`update meta.account set theme_pref = 'auto' where username = 'allen'`);
    }
  });

  test('the builder suggests the roles an app actually checks', async () => {
    const hints = (await roleHints([appId])).get(appId) ?? [];
    const admin = hints.find((h) => h.role === 'admin');
    assert.ok(admin, `admin is suggested: ${JSON.stringify(hints)}`);
    assert.ok(admin.sources.length > 0);
    const html = String(roleHintsHtml(hints));
    assert.match(html, /data-add-role="admin"/);
    assert.match(String(roleHintsHtml([])), /doesn't check any roles/);
  });
});
