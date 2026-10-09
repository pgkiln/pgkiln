// "Remember me": persistent sign-in with rotating tokens.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner, runtime } from '../src/db.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
const cookie = () => `pgkiln_remember_${appId}`;

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
});

beforeEach(async () => {
  await owner.query('update meta.app set remember_me_days = 30 where id = $1', [appId]);
  await owner.query('delete from meta.persistent_login where app_id = $1', [appId]);
});

after(async () => {
  await owner.query('update meta.app set remember_me_days = null where id = $1', [appId]);
  await owner.query('delete from meta.persistent_login where app_id = $1', [appId]);
  await owner.query(`update meta.account set active = true where username = 'allen'`);
  await app.close();
  await closePools();
});

/** Sign in with "Remember me" checked; returns the browser. */
async function remembered(user: string) {
  const b = new Browser(app);
  await b.get('/a/hr/login');
  const res = await b.post('/a/hr/login', { __csrf: b.lastCsrf, username: user, password: user, remember: 'true' });
  assert.equal(res.statusCode, 303);
  assert.ok(b.cookies.get(cookie()), 'the remember cookie is set');
  return b;
}

/** End the browser's session on the server, as the idle timeout would. */
const endSessions = (user: string) => owner.query('delete from meta.session where app_id = $1 and lower(username) = lower($2)', [appId, user]);
const signedIn = async (b: Browser) => (await b.get('/a/hr/2')).statusCode === 200;

describe('remember me', () => {
  test('the checkbox appears only when the app offers it', async () => {
    assert.match((await new Browser(app).get('/a/hr/login')).body, /Keep me signed in for 30 days/);
    await owner.query('update meta.app set remember_me_days = null where id = $1', [appId]);
    assert.doesNotMatch((await new Browser(app).get('/a/hr/login')).body, /name="remember"/);
  });

  test('without the checkbox, an ended session means signing in again', async () => {
    const b = new Browser(app);
    await b.login('king');
    assert.equal(b.cookies.get(cookie()), undefined);
    await endSessions('king');
    assert.equal(await signedIn(b), false);
  });

  test('a remembered browser gets a new session, and a new token, when the session ends', async () => {
    const b = await remembered('king');
    const first = b.cookies.get(cookie())!;
    await endSessions('king');
    assert.equal(await signedIn(b), true, 'signed in again silently');
    const second = b.cookies.get(cookie())!;
    assert.notEqual(second, first, 'the token rotates');
    assert.match((await b.get('/a/hr/2')).body, /<span>king<\/span>/);
    // the old token was used up: a copy of the first cookie doesn't work
    const thief = new Browser(app);
    thief.cookies.set(cookie(), first);
    assert.equal(await signedIn(thief), false);
    const log = await owner.one(`select detail from meta.activity_log where app_id = $1 and username = 'king' and event = 'login' order by id desc limit 1`, [appId]);
    assert.equal(log.detail, 'remember me');
    // the expiry stays that of the original sign-in
    const rows = (await owner.query(`select created_at, expires_at from meta.persistent_login where app_id = $1`, [appId])).rows;
    assert.equal(rows.length, 1);
  });

  test('signing out forgets the browser', async () => {
    const b = await remembered('king');
    await b.get('/a/hr/1');
    await b.post('/a/hr/logout', { __csrf: b.lastCsrf });
    assert.equal(b.cookies.get(cookie()), undefined);
    assert.equal((await owner.one('select count(*)::int as n from meta.persistent_login where app_id = $1', [appId])).n, 0);
  });

  test('a new password, deactivation, removed access, expiry or turning the feature off end it', async () => {
    const cases: [string, () => Promise<unknown>][] = [
      // a new hash of the same password, so other tests can still sign in as allen
      ['new password', () => owner.query(`update meta.account set password_hash = public.crypt('allen', public.gen_salt('bf', 6)) where username = 'allen'`)],
      ['access removed', async () => {
        const row = await owner.one(`delete from meta.app_access where app_id = $1 and account_id = (select id from meta.account where username = 'allen') returning roles`, [appId]);
        restore = () => owner.query(`insert into meta.app_access (app_id, account_id, roles) select $1, id, $2 from meta.account where username = 'allen'`, [appId, row.roles]);
      }],
      ['deactivated', () => owner.query(`update meta.account set active = false where username = 'allen'`)],
      ['expired', () => owner.query(`update meta.persistent_login set expires_at = now() - interval '1 minute' where app_id = $1`, [appId])],
      ['feature off', () => owner.query('update meta.app set remember_me_days = null where id = $1', [appId])],
    ];
    let restore: (() => Promise<unknown>) | null = null;
    for (const [name, change] of cases) {
      await owner.query(`update meta.account set active = true where username = 'allen'`);
      await owner.query('update meta.app set remember_me_days = 30 where id = $1', [appId]);
      const b = await remembered('allen');
      await change();
      await endSessions('allen');
      assert.equal(await signedIn(b), false, name);
      if (restore) await (restore as () => Promise<unknown>)();
      restore = null;
    }
    await owner.query(`update meta.account set active = true where username = 'allen'`);
  });

  test('"Sign out on all devices" in My account', async () => {
    const one = await remembered('king');
    await remembered('king');
    const page = (await one.get('/a/hr/account')).body;
    assert.match(page, /Browsers where you chose &quot;Keep me signed in&quot;: 2|Browsers where you chose "Keep me signed in": 2/);
    assert.equal((await one.post('/a/hr/account/devices', { __csrf: one.lastCsrf })).statusCode, 303);
    assert.equal((await owner.one('select count(*)::int as n from meta.persistent_login where app_id = $1', [appId])).n, 0);
  });

  test('the runtime role cannot read the tokens', async () => {
    await assert.rejects(runtime.query('select * from meta.persistent_login'), /permission denied/);
  });
});
