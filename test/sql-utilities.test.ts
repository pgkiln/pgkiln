// Sprint 62: SQL Workshop → Utilities: the tiles, Object Reports over the
// schemas the workshop's connection may use, About Database and the Database
// Monitor (administrators).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { Browser } from './helpers.ts';
import { OBJECT_REPORTS } from '../src/builder/sql-utilities.ts';

const SCHEMA = 'su62';
const DEV = 'su62_dev';
const DEV_PW = 'Su62-dev-password!';

let app: FastifyInstance;
let admin: Browser;
let dev: Browser;

async function cleanup() {
  await owner.query(`drop schema if exists ${SCHEMA} cascade`);
  await owner.query('delete from meta.developer where username = $1', [DEV]);
}

async function signIn(b: Browser, username: string, password: string) {
  await b.get('/builder/login');
  return b.submit('/builder/login', { username, password });
}

before(async () => {
  await cleanup();
  await owner.query(`
    create schema ${SCHEMA};
    create table ${SCHEMA}.parent (id int primary key);
    comment on table ${SCHEMA}.parent is 'Parents';
    create table ${SCHEMA}.child (id int primary key, parent_id int references ${SCHEMA}.parent);
    create table ${SCHEMA}.child_ok (id int primary key, parent_id int references ${SCHEMA}.parent);
    create index on ${SCHEMA}.child_ok (parent_id);
    create table ${SCHEMA}.nokey (x text);
    create table ${SCHEMA}.locked (id int primary key);
    alter table ${SCHEMA}.locked enable row level security;
    grant select on ${SCHEMA}.nokey to public;`);
  app = await buildApp({ logger: false });
  await owner.query(`insert into meta.developer (username, password_hash, is_admin) values ($1, meta.hash_password($2), false)`, [DEV, DEV_PW]);
  admin = new Browser(app);
  await signIn(admin, 'admin', 'admin');
  dev = new Browser(app);
  await signIn(dev, DEV, DEV_PW);
});
after(async () => {
  await cleanup();
  await app.close();
  await closePools();
});

describe('SQL Workshop utilities', () => {
  test('the Utilities page: the tools, and the Database Monitor only for administrators', async () => {
    const page = (await admin.get('/builder/sql/utilities')).body;
    for (const href of ['/builder/sql/load', '/builder/sql/unload', '/builder/sql/ddl', '/builder/sql/compare', '/builder/sql/utilities/reports', '/builder/sql/utilities/about', '/builder/sql/monitor'])
      assert.match(page, new RegExp(`href="${href}"`), href);
    assert.match((await admin.get('/builder/sql')).body, /href="\/builder\/sql\/utilities"/, 'the home tile');
    const devPage = (await dev.get('/builder/sql/utilities')).body;
    assert.doesNotMatch(devPage, /sql\/monitor/);
    assert.equal((await dev.get('/builder/sql/utilities/monitor')).statusCode, 403);
  });

  test('every object report runs', async () => {
    for (const [key, r] of Object.entries(OBJECT_REPORTS)) {
      const res = await admin.get(`/builder/sql/utilities/reports?r=${key}`);
      assert.equal(res.statusCode, 200, key);
      assert.match(res.body, new RegExp(r.title), key);
      assert.doesNotMatch(res.body, /The report failed/, key);
    }
    assert.equal((await admin.get('/builder/sql/utilities/reports?r=constructor')).statusCode, 404);
    assert.equal((await admin.get('/builder/sql/utilities/reports?r=__proto__')).statusCode, 404);
  });

  test('the reports find what they say', async () => {
    const report = async (key: string) => (await admin.get(`/builder/sql/utilities/reports?r=${key}`)).body;
    const noPk = await report('no-primary-key');
    assert.match(noPk, /su62\.nokey/);
    assert.doesNotMatch(noPk, /su62\.parent</);
    const fk = await report('unindexed-foreign-keys');
    assert.match(fk, /su62\.child</);
    assert.match(fk, /create index on su62\.child \(parent_id\)/);
    assert.doesNotMatch(fk, /su62\.child_ok/);
    assert.match(await report('rls-without-policies'), /su62\.locked/);
    assert.match(await report('public-grants'), /su62\.nokey/);
    const comments = await report('no-comments');
    assert.match(comments, /su62\.child</);
    assert.doesNotMatch(comments, /su62\.parent</);
    assert.doesNotMatch(await report('no-primary-key'), /meta\./, 'never pgkiln\'s own tables');
  });

  test('About Database and the Database Monitor', async () => {
    const about = (await admin.get('/builder/sql/utilities/about')).body;
    assert.match(about, /PostgreSQL/);
    assert.match(about, /server_encoding/);
    assert.match(about, /plpgsql/);
    assert.match(about, /su62/);
    // (sprint 102) the Database Monitor is SQL Workshop › SQL Monitor now
    const monitor = await admin.get('/builder/sql/utilities/monitor');
    assert.equal(monitor.statusCode, 301);
    assert.equal(monitor.headers.location, '/builder/sql/monitor');
  });
});
