// (sprint 248, MG-21) Custom authentication with the password hashes of another system: a hash query returns the
// stored hash (Django pbkdf2_sha256$ / pbkdf2_sha1$, bcrypt $2a$/$2b$/$2y$, Django's bcrypt$ and bcrypt_sha256$),
// the server checks the password (src/password-hashes.ts); meta.make_password_hash writes such hashes.
// The fixtures were made by Django 5.2 (make_password), PHP 8 (password_hash) and Python's bcrypt.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { parseHash, verifyPasswordHash, type BcryptFn } from '../src/password-hashes.ts';
import { Browser } from './helpers.ts';

const PW = 'Sesam-öpen 248!';
const FIXTURES = {
  django_sha256: 'pbkdf2_sha256$1000000$hJzAIDUrCSiJucZQg4tPRu$0FJ2x16eQgCWhzzAQtGjZ3bx2OV2oG0Efj196z0BoMg=',
  django_sha1: 'pbkdf2_sha1$1000000$PlPpjYJGqkAbDg9vs8kXi2$wz9zbbxer44NOG5mSvUejMILMOk=',
  django_bcrypt_sha256: 'bcrypt_sha256$$2b$12$oZIuWaaydkzehoUrSwa4/uUgbrUFVyVLZD2XgGItcDwelo5kyGFN2',
  django_bcrypt: 'bcrypt$$2b$12$EBl94v0F9lKilqgHeptrruGDn8lnCvZ7tFSAcUhdISQKqyiM3S/D6',
  php: '$2y$04$/3uW4oD7c59yQvpUY207hOQNBR4W4TmrjusUFUK1fpS9JYpTBkR1.',
  python_bcrypt: '$2b$04$bvs7o6KL0n75Mts6kGpLuOHAS3bGt2QQzpCMYJpERWdWxsS48TRy2',
};
const bcrypt: BcryptFn = async (p, h) => (await owner.one('select public.crypt($1::text, $2::text) as h', [p, h])).h;

let app: FastifyInstance;
let appId: number;
const alias = 'hash-auth-248';
const ROLE = 'pgkiln_s248_hash';
const SCHEMA = 's248_hash';
const QUERY = `select password from ${SCHEMA}.auth_user where username = lower(p_username) and is_active`;

before(async () => {
  app = await buildApp({ logger: false });
  await owner.query(`drop schema if exists ${SCHEMA} cascade`);
  await owner.query(`drop role if exists ${ROLE}`);
  await owner.query(`create role ${ROLE} nologin`);
  await owner.query(`grant ${ROLE} to pgkiln_runtime`);
  await owner.query(`create schema ${SCHEMA}`);
  await owner.query(`grant usage on schema ${SCHEMA} to ${ROLE}`);
  // Django's auth_user, with the hashes it wrote
  await owner.query(`create table ${SCHEMA}.auth_user (username text primary key, password text not null, is_active boolean not null default true, last_login timestamptz)`);
  await owner.query(`insert into ${SCHEMA}.auth_user (username, password) select * from unnest($1::text[], $2::text[])`, [Object.keys(FIXTURES), Object.values(FIXTURES)]);
  await owner.query(`insert into ${SCHEMA}.auth_user (username, password, is_active) values ('argon', '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA', true), ('broken', 'pbkdf2_sha256$1000$salt$notbase64!', true), ('gone', $1, false)`, [FIXTURES.php]);
  await owner.query(`grant select, update on ${SCHEMA}.auth_user to ${ROLE}`);
  appId = (await owner.one(`insert into meta.app (alias, name, authentication, db_role, custom_auth_hash_query) values ($1, 'Hash sign-in', 'custom', $2, $3) returning id`, [alias, ROLE, QUERY])).id;
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
const lastDetail = async (user: string) =>
  (await owner.one(`select event, detail from meta.activity_log where app_id = $1 and lower(username) = lower($2) and event like 'login%' order by id desc limit 1`, [appId, user]));
const clearLog = () => owner.query('delete from meta.activity_log where app_id = $1', [appId]);

describe('password hashes of other systems (src/password-hashes.ts)', () => {
  test('parseHash: the formats, normalised; argon2 and $2x$ unsupported; broken ones malformed', () => {
    assert.deepEqual({ ...parseHash(FIXTURES.django_sha256), hash: undefined }, { kind: 'pbkdf2', digest: 'sha256', iterations: 1000000, salt: 'hJzAIDUrCSiJucZQg4tPRu', hash: undefined });
    assert.equal((parseHash(FIXTURES.django_sha1) as { digest: string }).digest, 'sha1');
    assert.deepEqual(parseHash(FIXTURES.php), { kind: 'bcrypt', cost: 4, hash: FIXTURES.php.replace('$2y$', '$2a$'), sha256: false });
    assert.deepEqual(parseHash(FIXTURES.django_bcrypt_sha256), { kind: 'bcrypt', cost: 12, hash: FIXTURES.django_bcrypt_sha256.slice('bcrypt_sha256$'.length).replace('$2b$', '$2a$'), sha256: true });
    for (const h of ['$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA', 'argon2$argon2id$v=19$m=102400,t=2,p=8$c2FsdA$aGFzaA']) assert.match((parseHash(h) as { reason: string }).reason, /argon2 hashes are not supported/);
    assert.equal(parseHash('$2x$04$bvs7o6KL0n75Mts6kGpLuOHAS3bGt2QQzpCMYJpERWdWxsS48TRy2').kind, 'unsupported');
    assert.equal(parseHash('md5$abc$def').kind, 'unsupported');
    for (const h of ['', 'pbkdf2_sha256$0$s$aGFzaA==', 'pbkdf2_sha256$99999999$s$aGFzaA==', 'pbkdf2_sha256$1000$s$aGFzaA==', 'pbkdf2_sha256$1000$salt', '$2b$31$bvs7o6KL0n75Mts6kGpLuOHAS3bGt2QQzpCMYJpERWdWxsS48TRy2', '$2b$04$short', 'bcrypt$nope', 'x'.repeat(1001)])
      assert.equal(parseHash(h).kind, 'malformed', h);
    assert.equal(parseHash('pbkdf2_sha256$1000$s$aGFzaA==').kind, 'malformed', 'a key of the wrong length');
  });

  test('verifyPasswordHash: each format accepts the right password only', async () => {
    for (const [name, h] of Object.entries(FIXTURES)) {
      assert.equal((await verifyPasswordHash(h, PW, bcrypt)).ok, true, name);
      assert.equal((await verifyPasswordHash(h, `${PW}x`, bcrypt)).ok, false, name);
    }
    const bad = await verifyPasswordHash('$argon2id$v=19$m=1,t=1,p=1$c2FsdA$aGFzaA', PW, bcrypt, { kind: 'pbkdf2', digest: 'sha256', iterations: 1000 });
    assert.equal(bad.ok, false);
    assert.match((bad as { reason: string }).reason, /argon2/);
  });

  test('meta.make_password_hash writes hashes the check (and Django, PHP) accept', async () => {
    const django = (await owner.one(`select meta.make_password_hash($1, 'pbkdf2_sha256', 1000) as h`, [PW])).h as string;
    assert.match(django, /^pbkdf2_sha256\$1000\$[A-Za-z0-9]{22}\$[A-Za-z0-9+/]{43}=$/);
    assert.equal((await verifyPasswordHash(django, PW, bcrypt)).ok, true);
    const sha1 = (await owner.one(`select meta.make_password_hash($1, 'PBKDF2_SHA1', 2000) as h`, [PW])).h as string;
    assert.match(sha1, /^pbkdf2_sha1\$2000\$/);
    assert.equal((await verifyPasswordHash(sha1, PW, bcrypt)).ok, true);
    const bf = (await owner.one(`select meta.make_password_hash($1, p_cost => 4) as h`, [PW])).h as string;
    assert.match(bf, /^\$2a\$04\$/);
    assert.equal((await verifyPasswordHash(bf, PW, bcrypt)).ok, true);
    assert.equal((await verifyPasswordHash(bf, 'nope', bcrypt)).ok, false);
    for (const [args, msg] of [[`'', 'bcrypt'`, /empty/], [`'x', 'argon2id'`, /unknown format/], [`'x', 'bcrypt', 3`, /cost/], [`'x', 'pbkdf2_sha256', 10`, /iterations/]] as const)
      await assert.rejects(owner.query(`select meta.make_password_hash(${args})`), msg);
  });
});

describe('custom authentication: hash query', () => {
  test('each format signs in with the right password, as the app user typed; a wrong one is refused', async () => {
    for (const user of Object.keys(FIXTURES)) {
      const { b, res } = await signIn(user, PW);
      assert.equal(res.statusCode, 303, user);
      assert.match((await b.get(`/a/${alias}/1`)).body, new RegExp(`Signed in as ${user}`));
      assert.deepEqual(await lastDetail(user), { event: 'login', detail: 'custom' });
      const wrong = await signIn(user, 'Sesam-open 248!');
      assert.equal(wrong.res.statusCode, 401, user);
      assert.deepEqual(await lastDetail(user), { event: 'login_failed', detail: 'custom: hash query: wrong password' });
    }
    await clearLog();
  });

  test('unknown, inactive, argon2 and malformed users: the same refusal, the reason only in the activity log', async () => {
    const answers = new Set<string>();
    for (const [user, detail] of [['nobody-here', /unknown user/], ['gone', /unknown user/], ['argon', /argon2 hashes are not supported/], ['broken', /not base64/]] as const) {
      const { res } = await signIn(user, PW);
      assert.equal(res.statusCode, 401, user);
      answers.add(res.body.replace(/name="__csrf" value="[^"]*"/g, '').replace(/value="[^"]*"/g, ''));
      const log = await lastDetail(user);
      assert.equal(log.event, 'login_failed');
      assert.match(log.detail, detail);
    }
    assert.equal(answers.size, 1, 'one answer for all');
    await clearLog();
  });

  test('a function body takes precedence over the hash query; post-authentication code runs after it', async () => {
    await owner.query('update meta.app set custom_auth_code = $2 where id = $1', [appId, 'return false;']);
    try {
      assert.equal((await signIn('php', PW)).res.statusCode, 401);
    } finally {
      await owner.query('update meta.app set custom_auth_code = null where id = $1', [appId]);
    }
    await owner.query('update meta.app set custom_auth_post_code = $2 where id = $1', [appId, `update ${SCHEMA}.auth_user set last_login = now() where username = lower(p_username);\nperform meta.set_auth_user(lower(p_username));`]);
    try {
      const { b, res } = await signIn('PHP', PW);
      assert.equal(res.statusCode, 303);
      assert.match((await b.get(`/a/${alias}/1`)).body, /Signed in as php/);
      assert.ok((await owner.one(`select last_login from ${SCHEMA}.auth_user where username = 'php'`)).last_login);
    } finally {
      await owner.query('update meta.app set custom_auth_post_code = null where id = $1', [appId]);
      await clearLog();
    }
  });

  test('a query that fails or returns more than one row refuses everybody, the error by its SQLSTATE only', async () => {
    for (const [q, detail] of [[`select password from ${SCHEMA}.nope where username = p_username`, /hash query failed \(42P01\)/], [`select password from ${SCHEMA}.auth_user`, /more than one row/], [`select 1/0 from ${SCHEMA}.auth_user where username = p_username`, /hash query failed/]] as const) {
      await owner.query('update meta.app set custom_auth_hash_query = $2 where id = $1', [appId, q]);
      assert.equal((await signIn('php', PW)).res.statusCode, 401, q);
      assert.match((await lastDetail('php')).detail, detail);
    }
    await owner.query('update meta.app set custom_auth_hash_query = $2 where id = $1', [appId, `${QUERY};`]);
    assert.equal((await signIn('php', PW)).res.statusCode, 303, 'a trailing semicolon is fine');
    await clearLog();
  });

  test('the builder shows and saves the hash query; it travels with the application', async () => {
    const b = new Browser(app);
    await b.get('/builder/login');
    assert.equal((await b.post('/builder/login', { __csrf: b.lastCsrf, username: 'admin', password: 'admin' })).statusCode, 303);
    const settings = (await b.get(`/builder/apps/${appId}/settings`)).body;
    assert.match(settings, /name="custom_auth_hash_query"[^>]*>select password from/);
    assert.match(settings, /password hash query/);
    const a = await owner.one('select * from meta.app where id = $1', [appId]);
    const res = await b.submit(`/builder/apps/${appId}/settings`, {
      name: a.name, alias: a.alias, home_page: '1', authentication: 'custom', db_role: ROLE, language: 'en', language_from: 'browser',
      custom_auth_hash_query: `  ${QUERY} and true  `,
    });
    assert.equal(res.statusCode, 303);
    assert.equal((await owner.one('select custom_auth_hash_query from meta.app where id = $1', [appId])).custom_auth_hash_query, `${QUERY} and true`);
    const doc = (await owner.one('select meta.export_app($1) as d', [alias])).d;
    assert.equal(doc.app.custom_auth_hash_query, `${QUERY} and true`);
    await owner.query('update meta.app set custom_auth_hash_query = $2 where id = $1', [appId, QUERY]);
    await clearLog();
  });
});
