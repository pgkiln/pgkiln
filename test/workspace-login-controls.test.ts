// Sprint 223 (parity: Workspace preferences, "Missing: the account login controls"; migration 185): a workspace's
// administrators make the installation's sign-in rules stricter for the workspace's applications: fewer failed
// sign-ins per user, a shorter password lifetime, a longer minimum password. Never looser; empty: the installation's.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { appLoginControls, clearAccountSettings, passwordDaysLeft, passwordProblem } from '../src/accounts.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { loginThrottled } from '../src/session.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
let wsId: number;
let otherApp: number;
const created: string[] = [];
const IP = '198.51.100.223';

const reset = () => owner.query('update meta.workspace set login_max_failures = null, password_lifetime_days = null, password_min_length = null where id = $1', [wsId]);
before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  wsId = (await owner.one('select meta.app_workspace($1) as w', [appId])).w;
  // an application of another workspace: the controls are not its
  const ws2 = (await owner.one(`insert into meta.workspace (name) values ('LC223 Other') returning id`)).id;
  otherApp = (await owner.one(`select id from meta.app where alias <> 'hr' and meta.app_workspace(id) = $1 order by id limit 1`, [wsId]))?.id;
  if (otherApp) await owner.query('insert into meta.workspace_app (app_id, workspace_id) values ($1, $2) on conflict (app_id) do update set workspace_id = $2', [otherApp, ws2]);
  await reset();
});
after(async () => {
  await reset();
  if (otherApp) await owner.query('delete from meta.workspace_app where app_id = $1', [otherApp]);
  await owner.query(`delete from meta.workspace where name = 'LC223 Other'`);
  for (const u of created) {
    await owner.query('delete from meta.activity_log where lower(username) = lower($1)', [u]);
    await owner.query('delete from meta.account where username = $1', [u]);
  }
  await owner.query(`update meta.setting set value = '0' where name = 'password_lifetime_days'`);
  clearAccountSettings();
  await app.close();
  await closePools();
});
beforeEach(() => clearAccountSettings());

async function account() {
  const u = `lc223_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  created.push(u);
  const r = await owner.one(`insert into meta.account (username, password_hash) values ($1, meta.hash_password('correct-horse-1')) returning id`, [u]);
  await owner.query(`insert into meta.app_access (app_id, account_id, roles) values ($1, $2, '{}')`, [appId, r.id]);
  return u;
}
const builder = async () => {
  const b = new Browser(app);
  await b.get('/builder/login');
  assert.equal((await b.submit('/builder/login', { username: 'admin', password: 'admin' })).statusCode, 303);
  await b.get(`/builder/workspaces/${wsId}`);
  return b;
};

describe('the workspace page', () => {
  test('its administrators set the controls; empty is the installation\'s; out of range is refused', async () => {
    const b = await builder();
    const page = (await b.get(`/builder/workspaces/${wsId}`)).body;
    assert.match(page, /Account login controls/);
    assert.match(page, /name="login_max_failures"/);
    assert.equal((await b.submit(`/builder/workspaces/${wsId}/login-controls`, { login_max_failures: '3', password_lifetime_days: '30', password_min_length: '14' })).statusCode, 303);
    assert.deepEqual(await owner.one('select login_max_failures, password_lifetime_days, password_min_length from meta.workspace where id = $1', [wsId]),
      { login_max_failures: 3, password_lifetime_days: 30, password_min_length: 14 });
    assert.deepEqual(await appLoginControls(appId), { maxFailures: 3, lifetimeDays: 30, minLength: 14 });
    for (const bad of [{ login_max_failures: '0' }, { password_lifetime_days: '4000' }, { password_min_length: '5' }, { password_min_length: '1e3' }, { login_max_failures: '-1' }]) {
      await b.get(`/builder/workspaces/${wsId}`);
      await b.submit(`/builder/workspaces/${wsId}/login-controls`, { login_max_failures: '3', password_lifetime_days: '30', password_min_length: '14', ...bad });
      assert.equal((await owner.one('select login_max_failures from meta.workspace where id = $1', [wsId])).login_max_failures, 3, JSON.stringify(bad));
    }
    await b.get(`/builder/workspaces/${wsId}`);
    await b.submit(`/builder/workspaces/${wsId}/login-controls`, { login_max_failures: '', password_lifetime_days: '', password_min_length: '' });
    assert.deepEqual(await owner.one('select login_max_failures, password_lifetime_days, password_min_length from meta.workspace where id = $1', [wsId]),
      { login_max_failures: null, password_lifetime_days: null, password_min_length: null });
  });
});

describe('in the workspace\'s applications', () => {
  test('a longer minimum password, only there', async () => {
    await owner.query('update meta.workspace set password_min_length = 16 where id = $1', [wsId]);
    clearAccountSettings();
    assert.match((await passwordProblem('fifteen-chars-1', { appId })) ?? '', /16/);
    assert.equal(await passwordProblem('sixteen-chars-12', { appId }), null);
    assert.equal(await passwordProblem('fifteen-chars-1'), null, 'the installation\'s rule elsewhere');
    if (otherApp) assert.equal(await passwordProblem('fifteen-chars-1', { appId: otherApp }), null);
    // a stricter installation wins over a looser workspace
    await owner.query('update meta.workspace set password_min_length = 6 where id = $1', [wsId]);
    clearAccountSettings();
    assert.match((await passwordProblem('seven77', { appId })) ?? '', /8/);
    // the change form of an application
    await owner.query('update meta.workspace set password_min_length = 16 where id = $1', [wsId]);
    clearAccountSettings();
    const u = await account();
    const br = new Browser(app);
    await br.login(u, 'correct-horse-1');
    await br.get('/a/hr/account');
    const r = await br.submit('/a/hr/account/password', { password: 'correct-horse-1', new_password: 'new-horse-22', confirm_password: 'new-horse-22' });
    assert.equal(r.statusCode, 422);
    assert.match(r.body, /16/);
    await reset();
  });

  test('a shorter password lifetime: the stricter of the installation and the workspace', async () => {
    const u = await account();
    await owner.query(`update meta.account set password_changed_at = now() - interval '20 days' where username = $1`, [u]);
    assert.equal(await passwordDaysLeft(u, appId), null, 'no lifetime anywhere');
    await owner.query('update meta.workspace set password_lifetime_days = 15 where id = $1', [wsId]);
    assert.equal(await passwordDaysLeft(u, appId), 0);
    assert.equal(await passwordDaysLeft(u), null, 'the installation alone: never');
    if (otherApp) assert.equal(await passwordDaysLeft(u, otherApp), null);
    assert.match((await new Browser(app).login(u, 'correct-horse-1')).body, /Change your password/);
    await owner.query(`update meta.setting set value = '10' where name = 'password_lifetime_days'`);
    await owner.query('update meta.workspace set password_lifetime_days = 90 where id = $1', [wsId]);
    assert.equal(await passwordDaysLeft(u, appId), 0, 'the installation\'s 10 days are shorter');
    await owner.query(`update meta.account set password_changed_at = now() - interval '5 days' where username = $1`, [u]);
    assert.equal(await passwordDaysLeft(u, appId), 5);
    await owner.query(`update meta.setting set value = '0' where name = 'password_lifetime_days'`);
    assert.equal(await passwordDaysLeft(u, appId), 85);
    assert.equal((await new Browser(app).login(u, 'correct-horse-1')).statusCode, 303);
    await reset();
  });

  test('fewer failed sign-ins per user before it is refused', async () => {
    const u = await account();
    await owner.query('update meta.workspace set login_max_failures = 2 where id = $1', [wsId]);
    clearAccountSettings();
    assert.equal(await loginThrottled(appId, u, IP), false);
    for (let i = 0; i < 2; i++) await owner.query(`insert into meta.activity_log (app_id, username, event, ip) values ($1, $2, 'login_failed', $3)`, [appId, u, IP]);
    assert.equal(await loginThrottled(appId, u, IP), true);
    assert.equal(await loginThrottled(null, u, IP), false, 'the builder keeps the installation\'s rule');
    // the right password is refused too, while throttled
    const r = await new Browser(app).login(u, 'correct-horse-1');
    assert.notEqual(r.statusCode, 303);
    await owner.query('update meta.workspace set login_max_failures = null where id = $1', [wsId]);
    clearAccountSettings();
    assert.equal(await loginThrottled(appId, u, IP), false, 'the installation allows more');
    await reset();
  });
});
