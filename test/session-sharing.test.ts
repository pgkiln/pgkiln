// Session sharing between applications (067, src/sharedlogin.ts): one
// sign-in for the applications of a group, each with its own access check;
// signing out of one signs out of all; idle, inactive and other groups.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { Browser } from './helpers.ts';

const APPS = ['ss-one', 'ss-two', 'ss-other'];
const USERS = ['ss_ann', 'ss_bob'];
const PW = 'Shared-sign-in-1';
let app: FastifyInstance;

async function cleanup() {
  await owner.query('delete from meta.app where alias = any($1)', [APPS]);
  await owner.query('delete from meta.account where username = any($1)', [USERS]);
}

before(async () => {
  await cleanup();
  app = await buildApp({ logger: false });
  for (const [alias, group] of [['ss-one', 'ss_group'], ['ss-two', 'ss_group'], ['ss-other', 'ss_else']]) {
    const id = (await owner.one(`insert into meta.app (alias, name, authentication, session_group) values ($1, $1, 'app_users', $2) returning id`, [alias, group])).id;
    const page = (await owner.one(`insert into meta.page (app_id, page_no, name, title) values ($1, 1, 'Home', 'Home') returning id`, [id])).id;
    await owner.query(`insert into meta.region (page_id, title, type, source) values ($1, 'Hi', 'static', '<p>Hello &APP_USER.</p>')`, [page]);
  }
  for (const u of USERS) await owner.query(`insert into meta.account (username, password_hash) values ($1, meta.hash_password($2))`, [u, PW]);
  // ann may use all three; bob only ss-one
  await owner.query(`insert into meta.app_access (app_id, account_id, roles)
    select a.id, ac.id, '{}' from meta.app a, meta.account ac where a.alias = any($1) and ac.username = 'ss_ann'`, [APPS]);
  await owner.query(`insert into meta.app_access (app_id, account_id, roles)
    select a.id, ac.id, '{}' from meta.app a, meta.account ac where a.alias = 'ss-one' and ac.username = 'ss_bob'`);
});
after(async () => {
  await owner.query(`delete from meta.shared_login where session_group in ('ss_group', 'ss_else')`);
  await cleanup();
  await app.close();
  await closePools();
});

const signedIn = async (b: Browser, alias: string) => {
  const r = await b.get(`/a/${alias}/1`);
  return r.statusCode === 200 && r.body.includes('Hello ss_');
};

describe('session sharing', () => {
  test('signing in to one application of the group opens the others; another group is not shared', async () => {
    const b = new Browser(app);
    assert.equal(await signedIn(b, 'ss-two'), false);
    await b.login('ss_ann', PW, 'ss-one');
    assert.ok(b.cookies.has('pgapex_share_ss_group'), 'the group cookie');
    assert.equal(await signedIn(b, 'ss-one'), true);
    assert.equal(await signedIn(b, 'ss-two'), true, 'no new sign-in for the same group');
    assert.equal(await signedIn(b, 'ss-other'), false, 'another group signs in on its own');
    const log = await owner.one(`select detail from meta.activity_log where event = 'login' and username = 'ss_ann' and app_id = (select id from meta.app where alias = 'ss-two') order by id desc limit 1`);
    assert.equal(log.detail, 'shared sign-in');
  });

  test("each application checks its own access", async () => {
    const b = new Browser(app);
    await b.login('ss_bob', PW, 'ss-one');
    assert.equal(await signedIn(b, 'ss-one'), true);
    const r = await b.get('/a/ss-two/1');
    assert.equal(r.statusCode, 302);
    assert.match(String(r.headers.location), /^\/a\/ss-two\/login/);
  });

  test('signing out of one application signs out of all of the group', async () => {
    const b = new Browser(app);
    await b.login('ss_ann', PW, 'ss-one');
    assert.equal(await signedIn(b, 'ss-two'), true);
    await b.get('/a/ss-two/1');
    const count = async () => (await owner.one(`select count(*)::int as n from meta.shared_login where account_id = (select id from meta.account where username = 'ss_ann')`)).n;
    const before = await count();
    assert.equal((await b.submit('/a/ss-two/logout', {})).statusCode, 303);
    assert.equal(await signedIn(b, 'ss-one'), false, 'the other application\'s session ended too');
    assert.equal(await signedIn(b, 'ss-two'), false);
    assert.equal(await count(), before - 1, 'this browser\'s shared sign-in is gone');
    assert.ok(!b.cookies.has('pgapex_share_ss_group'), 'the group cookie is cleared');
  });

  test('an idle shared sign-in, a deactivated account and a forged cookie are refused', async () => {
    const b = new Browser(app);
    await b.login('ss_ann', PW, 'ss-one');
    await owner.query(`update meta.shared_login set last_seen = now() - interval '2 days' where account_id = (select id from meta.account where username = 'ss_ann')`);
    assert.equal(await signedIn(b, 'ss-two'), false, 'idle');
    const c = new Browser(app);
    await c.login('ss_ann', PW, 'ss-one');
    await owner.query(`update meta.account set active = false where username = 'ss_ann'`);
    try {
      assert.equal(await signedIn(c, 'ss-two'), false, 'deactivated');
    } finally {
      await owner.query(`update meta.account set active = true where username = 'ss_ann'`);
    }
    const d = new Browser(app);
    d.cookies.set('pgapex_share_ss_group', 'forged-token');
    assert.equal(await signedIn(d, 'ss-two'), false, 'forged');
    // a cookie of another group does not open this one
    const e = new Browser(app);
    await e.login('ss_ann', PW, 'ss-other');
    e.cookies.set('pgapex_share_ss_group', e.cookies.get('pgapex_share_ss_else')!);
    assert.equal(await signedIn(e, 'ss-two'), false, 'the token belongs to another group');
  });

  test('the builder saves the group from the settings page; bad names are dropped', async () => {
    const dev = new Browser(app);
    await dev.get('/builder/login');
    await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
    const id = (await owner.one(`select id from meta.app where alias = 'ss-other'`)).id;
    const page = (await dev.get(`/builder/apps/${id}/settings`)).body;
    assert.match(page, /name="session_group" type="text" value="ss_else"/);
    const form = { name: 'ss-other', alias: 'ss-other', home_page: '1', authentication: 'app_users', nav: 'side', mode: 'auto', local_login: 'true', language: 'en', language_from: 'browser' };
    await dev.submit(`/builder/apps/${id}/settings`, { ...form, session_group: 'SS_Group' });
    assert.equal((await owner.one('select session_group from meta.app where id = $1', [id])).session_group, 'ss_group', 'lower case');
    await dev.get(`/builder/apps/${id}/settings`);
    await dev.submit(`/builder/apps/${id}/settings`, { ...form, session_group: 'x; drop' });
    assert.equal((await owner.one('select session_group from meta.app where id = $1', [id])).session_group, null);
    await owner.query(`update meta.app set session_group = 'ss_else' where id = $1`, [id]);
  });
});
