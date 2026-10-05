// Database-account authentication (sprint 30, APEX "Database Accounts"): an
// app with authentication 'database' signs users in with a PostgreSQL login
// role and its password, checked by a short connection as that role.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
const alias = 'dbauth-fn30';
const ANN = 'pgapex_f30_ann';
const BOB = 'pgapex_f30_bob';
const GROUP = 'pgapex_f30_group';

before(async () => {
  app = await buildApp({ logger: false });
  for (const r of [ANN, BOB, GROUP]) await owner.query(`drop role if exists ${r}`);
  await owner.query(`create role ${ANN} login password 'Ann-pw-30!'`);
  await owner.query(`create role ${BOB} login password 'Bob-pw-30!'`);
  await owner.query(`create role ${GROUP} nologin`);
  await owner.query(`grant ${GROUP} to ${BOB}`);
  appId = (await owner.one(`insert into meta.app (alias, name, authentication, db_auth_roles) values ($1, 'Database sign-in', 'database', $2) returning id`, [alias, [ANN]])).id;
  const page = (await owner.one(`insert into meta.page (app_id, page_no, name) values ($1, 1, 'Home') returning id`, [appId])).id;
  await owner.query(`insert into meta.region (page_id, title, type, source) values ($1, 'Who', 'static', '<p>Signed in as &APP_USER.</p>')`, [page]);
});

after(async () => {
  await owner.query('delete from meta.app where id = $1', [appId]);
  for (const r of [ANN, BOB, GROUP]) await owner.query(`drop role if exists ${r}`);
  await app.close();
  await closePools();
});

const signIn = async (user: string, password: string) => {
  const b = new Browser(app);
  await b.get(`/a/${alias}/login`);
  return { b, res: await b.submit(`/a/${alias}/login`, { username: user, password }) };
};

describe('database accounts', () => {
  test('the login page has the role name and password form, without remember me or SSO', async () => {
    const page = (await new Browser(app).get(`/a/${alias}/login`)).body;
    assert.match(page, /name="username"/);
    assert.match(page, /name="password"/);
    assert.doesNotMatch(page, /name="remember"/);
    assert.doesNotMatch(page, /\/sso\//);
  });

  test('a listed role signs in with its password; the app user is the role name', async () => {
    const { b, res } = await signIn(ANN, 'Ann-pw-30!');
    assert.equal(res.statusCode, 303);
    const home = await b.get(`/a/${alias}/1`);
    assert.equal(home.statusCode, 200);
    assert.match(home.body, new RegExp(`Signed in as ${ANN}`));
    const log = await owner.one(`select event, detail from meta.activity_log where app_id = $1 and username = $2 order by id desc limit 1`, [appId, ANN]);
    assert.deepEqual(log, { event: 'login', detail: 'database' });
  });

  test('members of the membership role sign in too', async () => {
    assert.equal((await signIn(BOB, 'Bob-pw-30!')).res.statusCode, 401, 'not listed, no membership role yet');
    await owner.query('update meta.app set db_auth_member_of = $2 where id = $1', [appId, GROUP]);
    try {
      const { b, res } = await signIn(BOB, 'Bob-pw-30!');
      assert.equal(res.statusCode, 303);
      assert.match((await b.get(`/a/${alias}/1`)).body, new RegExp(`Signed in as ${BOB}`));
      // the list still works next to the membership role
      assert.equal((await signIn(ANN, 'Ann-pw-30!')).res.statusCode, 303);
    } finally {
      await owner.query('update meta.app set db_auth_member_of = null where id = $1', [appId]);
    }
  });

  test('the builder saves the type, the roles and the membership role', async () => {
    const b = new Browser(app);
    await b.get('/builder/login');
    assert.equal((await b.post('/builder/login', { __csrf: b.lastCsrf, username: 'admin', password: 'admin' })).statusCode, 303);
    const form = await b.get(`/builder/apps/${appId}/settings`);
    assert.match(form.body, /<option value="database" selected>Database accounts/);
    const saved = await b.post(`/builder/apps/${appId}/settings`, {
      __csrf: b.lastCsrf, name: 'Database sign-in', alias, home_page: '1', authentication: 'database',
      db_auth_roles: ` ${ANN}, ${BOB}, ${ANN}, bad\u0001name `, db_auth_member_of: GROUP,
    });
    assert.equal(saved.statusCode, 303);
    assert.deepEqual(await owner.one('select authentication, db_auth_roles, db_auth_member_of from meta.app where id = $1', [appId]),
      { authentication: 'database', db_auth_roles: [ANN, BOB], db_auth_member_of: GROUP });
    await owner.query('update meta.app set db_auth_roles = $2, db_auth_member_of = null where id = $1', [appId, [ANN]]);
  });
});
