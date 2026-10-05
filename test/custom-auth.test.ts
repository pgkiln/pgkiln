// Custom authentication (sprint 31, APEX "Custom" authentication scheme): an
// app with authentication 'custom' signs users in when its own PL/pgSQL (a
// function body or a named function) returns true, run as the app's role.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
const alias = 'custom-auth-f31';
const ROLE = 'pgapex_f31_custom';
const SCHEMA = 'f31_custom';

before(async () => {
  app = await buildApp({ logger: false });
  await owner.query(`drop schema if exists ${SCHEMA} cascade`);
  await owner.query(`drop role if exists ${ROLE}`);
  await owner.query(`create role ${ROLE} nologin`);
  await owner.query(`grant ${ROLE} to pgapex_runtime`);
  await owner.query(`create schema ${SCHEMA}`);
  await owner.query(`grant usage on schema ${SCHEMA} to ${ROLE}`);
  await owner.query(`create table ${SCHEMA}.users (name text primary key, pw_hash text not null, locked boolean not null default false, last_login timestamptz)`);
  await owner.query(`insert into ${SCHEMA}.users (name, pw_hash, locked) values ('carol', crypt('Carol-pw-31!', gen_salt('bf', 4)), false), ('dave', crypt('Dave-pw-31!', gen_salt('bf', 4)), true)`);
  await owner.query(`grant select, update on ${SCHEMA}.users to ${ROLE}`);
  await owner.query(`create function ${SCHEMA}.check_login(p_username text, p_password text) returns boolean language sql security invoker
    as $$ select exists (select 1 from ${SCHEMA}.users where name = p_username and pw_hash = crypt(p_password, pw_hash)) $$`);
  await owner.query(`grant execute on function ${SCHEMA}.check_login(text, text) to ${ROLE}`);
  appId = (
    await owner.one(
      `insert into meta.app (alias, name, authentication, db_role, custom_auth_code) values ($1, 'Custom sign-in', 'custom', $2, $3) returning id`,
      [alias, ROLE, `return exists (select 1 from ${SCHEMA}.users where name = p_username and pw_hash = crypt(p_password, pw_hash));`],
    )
  ).id;
  const page = (await owner.one(`insert into meta.page (app_id, page_no, name) values ($1, 1, 'Home') returning id`, [appId])).id;
  await owner.query(`insert into meta.region (page_id, title, type, source) values ($1, 'Who', 'static', '<p>Signed in as &APP_USER.</p>')`, [page]);
});

after(async () => {
  await owner.query('delete from meta.app where id = $1', [appId]);
  await owner.query(`drop schema if exists ${SCHEMA} cascade`);
  await owner.query(`drop owned by ${ROLE}`);
  await owner.query(`drop role if exists ${ROLE}`);
  await app.close();
  await closePools();
});

const signIn = async (user: string, password: string) => {
  const b = new Browser(app);
  await b.get(`/a/${alias}/login`);
  return { b, res: await b.submit(`/a/${alias}/login`, { username: user, password }) };
};
const clearLog = () => owner.query('delete from meta.activity_log where app_id = $1', [appId]);

describe('custom authentication', () => {
  test('the login page has the user name and password form only', async () => {
    const page = (await new Browser(app).get(`/a/${alias}/login`)).body;
    assert.match(page, /name="username"/);
    assert.match(page, /name="password"/);
    assert.doesNotMatch(page, /name="remember"/);
    assert.doesNotMatch(page, /\/sso\//);
  });

  test('a function body: the right password signs in, the app user is the user name', async () => {
    const { b, res } = await signIn('carol', 'Carol-pw-31!');
    assert.equal(res.statusCode, 303);
    const home = await b.get(`/a/${alias}/1`);
    assert.equal(home.statusCode, 200);
    assert.match(home.body, /Signed in as carol/);
    assert.deepEqual(await owner.one(`select event, detail from meta.activity_log where app_id = $1 and username = 'carol' order by id desc limit 1`, [appId]), { event: 'login', detail: 'custom' });
    const wrong = await signIn('carol', 'nope');
    assert.equal(wrong.res.statusCode, 401);
    assert.equal((await wrong.b.get(`/a/${alias}/1`)).statusCode, 302);
    await clearLog();
  });

  test('a named function takes precedence over the body', async () => {
    await owner.query('update meta.app set custom_auth_function = $2, custom_auth_code = $3 where id = $1', [appId, `${SCHEMA}.check_login`, 'return false;']);
    try {
      assert.equal((await signIn('carol', 'Carol-pw-31!')).res.statusCode, 303);
      assert.equal((await signIn('carol', 'wrong')).res.statusCode, 401);
    } finally {
      await owner.query('update meta.app set custom_auth_function = null, custom_auth_code = $2 where id = $1', [appId, `return exists (select 1 from ${SCHEMA}.users where name = p_username and pw_hash = crypt(p_password, pw_hash));`]);
      await clearLog();
    }
  });

  test('post-authentication code runs as the app user; an exception refuses the sign-in', async () => {
    await owner.query('update meta.app set custom_auth_post_code = $2 where id = $1', [
      appId,
      `begin
         if (select locked from ${SCHEMA}.users where name = p_username) then raise exception 'locked'; end if;
         update ${SCHEMA}.users set last_login = now() where name = meta.app_user();
       end`,
    ]);
    try {
      assert.equal((await signIn('carol', 'Carol-pw-31!')).res.statusCode, 303);
      assert.ok((await owner.one(`select last_login from ${SCHEMA}.users where name = 'carol'`)).last_login, 'post-authentication ran');
      const locked = await signIn('dave', 'Dave-pw-31!');
      assert.equal(locked.res.statusCode, 401);
      assert.equal((await locked.b.get(`/a/${alias}/1`)).statusCode, 302);
      const log = await owner.one(`select detail from meta.activity_log where app_id = $1 and username = 'dave' and event = 'login_failed' order by id desc limit 1`, [appId]);
      assert.match(log.detail, /post-authentication failed/);
    } finally {
      await owner.query('update meta.app set custom_auth_post_code = null where id = $1', [appId]);
      await clearLog();
    }
  });

  test('the builder saves the type, the function, the body and the post-authentication code', async () => {
    const b = new Browser(app);
    await b.get('/builder/login');
    assert.equal((await b.post('/builder/login', { __csrf: b.lastCsrf, username: 'admin', password: 'admin' })).statusCode, 303);
    const settings = await b.get(`/builder/apps/${appId}/settings`);
    assert.match(settings.body, /Custom authentication/);
    assert.match(settings.body, /value="custom" selected/);
    const a = await owner.one('select * from meta.app where id = $1', [appId]);
    const res = await b.submit(`/builder/apps/${appId}/settings`, {
      name: a.name, alias: a.alias, home_page: '1', authentication: 'custom', db_role: ROLE, local_login: 'true', language: 'en', language_from: 'browser',
      custom_auth_function: `${SCHEMA}.check_login`, custom_auth_code: 'return false;', custom_auth_post_code: 'perform 1;',
    });
    assert.equal(res.statusCode, 303);
    const saved = await owner.one('select authentication, custom_auth_function, custom_auth_code, custom_auth_post_code from meta.app where id = $1', [appId]);
    assert.deepEqual(saved, { authentication: 'custom', custom_auth_function: `${SCHEMA}.check_login`, custom_auth_code: 'return false;', custom_auth_post_code: 'perform 1;' });
    // a function name that is not a plain (lower-case) name is refused by the database
    await b.get(`/builder/apps/${appId}/settings`);
    await b.submit(`/builder/apps/${appId}/settings`, { name: a.name, alias: a.alias, home_page: '1', authentication: 'custom', db_role: ROLE, language: 'en', custom_auth_function: 'x; drop table y' });
    assert.equal((await owner.one('select custom_auth_function from meta.app where id = $1', [appId])).custom_auth_function, `${SCHEMA}.check_login`);
    await owner.query('update meta.app set custom_auth_function = null, custom_auth_code = $2, custom_auth_post_code = null where id = $1', [appId, `return exists (select 1 from ${SCHEMA}.users where name = p_username and pw_hash = crypt(p_password, pw_hash));`]);
  });
});
