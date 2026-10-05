// Instance settings (src/instance.ts, Workspace utilities → Instance settings):
// precedence (builder, environment, default), the administrators' page, the
// effect on sign-in throttling, and a configuration overview without secrets.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { INSTANCE_SETTINGS, instanceSetting, origin, refreshInstanceSettings, saveInstanceSettings } from '../src/instance.ts';
import { Browser } from './helpers.ts';

const KEYS = INSTANCE_SETTINGS.map((s) => s.key);
const DEV = 'inst_test_dev';
let app: FastifyInstance;

before(async () => {
  app = await buildApp({ logger: false });
  await owner.query('delete from meta.setting where name = any($1)', [KEYS]);
  await owner.query(`insert into meta.developer (username, password_hash, is_admin) values ($1, meta.hash_password('Inst-test-password!'), false) on conflict do nothing`, [DEV]);
  await refreshInstanceSettings(true);
});
after(async () => {
  await owner.query('delete from meta.setting where name = any($1)', [KEYS]);
  await owner.query('delete from meta.developer where username = $1', [DEV]);
  await owner.query(`delete from meta.activity_log where username = 'inst_nobody'`);
  await app.close();
  await closePools();
});

const admin = async () => {
  const b = new Browser(app);
  await b.get('/builder/login');
  await b.submit('/builder/login', { username: 'admin', password: 'admin' });
  return b;
};

describe('instance settings', () => {
  test('the builder\'s value wins over the environment, which wins over the default; bad values are ignored', async () => {
    const saved = process.env.SESSION_IDLE_MINUTES;
    try {
      delete process.env.SESSION_IDLE_MINUTES;
      assert.equal(instanceSetting('session_idle_minutes'), 60);
      assert.equal(origin('session_idle_minutes'), 'default');
      process.env.SESSION_IDLE_MINUTES = '30';
      assert.equal(instanceSetting('session_idle_minutes'), 30);
      assert.equal(origin('session_idle_minutes'), 'environment');
      process.env.SESSION_IDLE_MINUTES = '2'; // below the minimum
      assert.equal(instanceSetting('session_idle_minutes'), 60);
      assert.equal(await saveInstanceSettings({ session_idle_minutes: '45' }), null);
      assert.equal(instanceSetting('session_idle_minutes'), 45);
      assert.equal(origin('session_idle_minutes'), 'builder');
      await owner.query(`update meta.setting set value = 'x' where name = 'session_idle_minutes'`);
      await refreshInstanceSettings(true);
      assert.equal(instanceSetting('session_idle_minutes'), 60, 'a hand-edited bad value falls back');
      assert.match(String(await saveInstanceSettings({ session_max_hours: '0' })), /Maximum session length.*1 to 168/);
      assert.equal(await saveInstanceSettings({}), null);
      assert.equal((await owner.query('select 1 from meta.setting where name = any($1)', [KEYS])).rowCount, 0, 'empty values remove the rows');
    } finally {
      if (saved === undefined) delete process.env.SESSION_IDLE_MINUTES;
      else process.env.SESSION_IDLE_MINUTES = saved;
    }
  });

  test('administrators only; CSRF; the page shows where each value comes from and no secrets', async () => {
    const dev = new Browser(app);
    await dev.get('/builder/login');
    await dev.submit('/builder/login', { username: DEV, password: 'Inst-test-password!' });
    assert.equal((await dev.get('/builder/instance')).statusCode, 403);
    await dev.get('/builder');
    assert.equal((await dev.submit('/builder/instance', { session_idle_minutes: '10' })).statusCode, 403);
    const b = await admin();
    const page = (await b.get('/builder/instance')).body;
    assert.match(page, /Session idle time \(minutes\)/);
    assert.match(page, /<code>DATABASE_URL<\/code><\/td><td data-label="Value">set \(hidden\)/);
    const password = new URL(process.env.DATABASE_URL!).password;
    if (password) assert.ok(!page.includes(`:${password}@`), 'no connection password');
    if (process.env.API_JWT_SECRET) assert.ok(!page.includes(process.env.API_JWT_SECRET));
    assert.match((await b.get('/builder/utilities')).body, /href="\/builder\/instance"/);
    assert.equal((await b.post('/builder/instance', { __csrf: 'forged', session_idle_minutes: '10' })).statusCode, 403);
    await b.submit('/builder/instance', { session_idle_minutes: '9999' });
    assert.match((await b.get('/builder/instance')).body, /Session idle time \(minutes\): a whole number from 5 to 1440/);
    await b.submit('/builder/instance', { session_idle_minutes: '90' });
    assert.equal((await owner.one(`select value from meta.setting where name = 'session_idle_minutes'`)).value, '90');
    assert.match((await b.get('/builder/instance')).body, /In effect: <b>90<\/b> \(set here/);
    await b.submit('/builder/instance', {});
  });

  test('sign-in throttling follows the setting', async () => {
    await saveInstanceSettings({ login_max_failures_user: '2' });
    try {
      const b = new Browser(app);
      for (let i = 0; i < 2; i++) {
        await b.get('/a/hr/login');
        await b.submit('/a/hr/login', { username: 'inst_nobody', password: 'wrong' });
      }
      await b.get('/a/hr/login');
      const res = await b.submit('/a/hr/login', { username: 'inst_nobody', password: 'wrong' });
      assert.equal(res.statusCode, 429);
    } finally {
      await saveInstanceSettings({});
    }
  });
});
