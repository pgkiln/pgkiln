// OAuth clients (client credentials) for the REST API: the SQL API, the
// token endpoint, secret rotation with a grace period, revocation, and
// what a client token may do in the database (as PostgREST would run it).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { jwtVerify } from 'jose';
import '../src/env.ts';
import { jwtSecret } from '../src/api.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let client: { client_id: string; client_secret: string };
const NAME = `test-sync-${Date.now()}`;

before(async () => {
  app = await buildApp({ logger: false });
  client = (await owner.one(`select * from meta.oauth_create_client('hr', $1, '{Manager}', 'test client', 15)`, [NAME]))!;
});

after(async () => {
  await owner.query(`delete from meta.api_client where name like 'test-%'`);
  await owner.query(`delete from meta.activity_log where event like 'oauth%' and (username like 'client:%' or detail like '%test-%')`);
  await app.close();
  await closePools();
});

const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
const token = (headers: Record<string, string>, form: Record<string, string>) =>
  app.inject({ method: 'POST', url: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, payload: new URLSearchParams(form).toString() });

/** Run SQL the way PostgREST does for a verified token, then roll back. */
async function asApi<T>(claims: Record<string, unknown>, sql: string): Promise<T[]> {
  const c = await owner.pool.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    await c.query(`set local role ${claims.role}`);
    return (await c.query(sql)).rows;
  } finally {
    await c.query('rollback').catch(() => {});
    c.release();
  }
}

describe('OAuth clients', () => {
  test('the secret is stored hashed; roles are normalised', async () => {
    const row = await owner.one('select secret_hash, roles, token_minutes from meta.api_client where client_id = $1', [client.client_id]);
    assert.notEqual(row.secret_hash, client.client_secret);
    assert.equal(row.secret_hash.length, 64);
    assert.deepEqual(row.roles, ['manager']);
    assert.ok(client.client_secret.length >= 43);
  });

  test('client credentials with HTTP Basic or form fields give a short-lived token', async () => {
    for (const res of [
      await token({ authorization: basic(client.client_id, client.client_secret) }, { grant_type: 'client_credentials' }),
      await token({}, { grant_type: 'client_credentials', client_id: client.client_id, client_secret: client.client_secret }),
    ]) {
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.headers['cache-control'], 'no-store');
      const body = res.json();
      assert.equal(body.token_type, 'bearer');
      assert.equal(body.expires_in, 15 * 60);
      const { payload } = await jwtVerify(body.access_token, jwtSecret());
      assert.equal(payload.role, 'hr_api');
      assert.equal(payload.app, 'hr');
      assert.equal(payload.app_user, `client:${NAME}`);
      assert.equal(payload.client_id, client.client_id);
      assert.ok(!('roles' in payload), 'roles are read live, not from the token');
      assert.ok(payload.exp! - payload.iat! === 15 * 60);
    }
    const used = await owner.one('select last_used_at from meta.api_client where client_id = $1', [client.client_id]);
    assert.ok(used.last_used_at);
  });

  test('wrong secrets, unknown clients and other grant types are refused (RFC 6749 errors)', async () => {
    const wrong = await token({ authorization: basic(client.client_id, 'nope') }, { grant_type: 'client_credentials' });
    assert.equal(wrong.statusCode, 401);
    assert.equal(wrong.json().error, 'invalid_client');
    assert.match(String(wrong.headers['www-authenticate']), /^Basic/);
    assert.equal((await token({ authorization: basic('unknown', 'x') }, { grant_type: 'client_credentials' })).statusCode, 401);
    const grant = await token({ authorization: basic(client.client_id, client.client_secret) }, { grant_type: 'password', username: 'king', password: 'king' });
    assert.equal(grant.statusCode, 400);
    assert.equal(grant.json().error, 'unsupported_grant_type');
    assert.equal((await token({}, { grant_type: 'client_credentials' })).statusCode, 401, 'no credentials');
  });

  test('rotation: the old secret works during the grace period only', async () => {
    const c = await owner.one(`select * from meta.oauth_create_client('hr', $1)`, [`test-rotate-${Date.now()}`]);
    const fresh = (await owner.one(`select meta.oauth_rotate_secret($1) as s`, [c.client_id])).s;
    const ok = (secret: string) => token({ authorization: basic(c.client_id, secret) }, { grant_type: 'client_credentials' }).then((r) => r.statusCode);
    assert.equal(await ok(fresh), 200);
    assert.equal(await ok(c.client_secret), 200, 'old secret during the grace period');
    await owner.query(`update meta.api_client set previous_valid_until = now() - interval '1 second' where client_id = $1`, [c.client_id]);
    assert.equal(await ok(c.client_secret), 401, 'old secret after the grace period');
    const immediate = (await owner.one(`select meta.oauth_rotate_secret($1, '0') as s`, [c.client_id])).s;
    assert.equal(await ok(fresh), 401, 'no grace: the previous secret stops at once');
    assert.equal(await ok(immediate), 200);
  });

  test('in the database a client token acts as client:<name> with the client roles, read live', async () => {
    const claims = { role: 'hr_api', app: 'hr', app_user: `client:${NAME}`, client_id: client.client_id };
    const [r] = await asApi<any>(claims, `select meta.app_user() as u, meta.has_role('manager') as m, meta.has_role('admin') as a`);
    assert.deepEqual(r, { u: `client:${NAME}`, m: true, a: false });
    await asApi(claims, 'select meta.api_check()');
    const [forged] = await asApi<any>({ ...claims, roles: ['admin'] }, `select meta.has_role('admin') as a`);
    assert.equal(forged.a, false, 'a roles claim does not count for client tokens');
    await owner.query(`select meta.oauth_grant_role($1, 'admin')`, [client.client_id]);
    assert.equal((await asApi<any>(claims, `select meta.has_role('admin') as a`))[0].a, true, 'granted roles apply at once');
    await owner.query(`select meta.oauth_revoke_role($1, 'admin')`, [client.client_id]);
  });

  test('revoking a client stops its tokens and its token requests at once', async () => {
    const c = await owner.one(`select * from meta.oauth_create_client('hr', $1, '{manager}')`, [`test-revoke-${Date.now()}`]);
    const claims = { role: 'hr_api', app: 'hr', app_user: 'client:x', client_id: c.client_id };
    await asApi(claims, 'select meta.api_check()');
    await owner.query('select meta.oauth_revoke_client($1)', [c.client_id]);
    await assert.rejects(asApi(claims, 'select meta.api_check()'), (e: any) => e.code === 'PT401');
    assert.equal((await asApi<any>(claims, `select meta.has_role('manager') as m`))[0].m, false);
    assert.equal((await token({ authorization: basic(c.client_id, c.client_secret) }, { grant_type: 'client_credentials' })).statusCode, 401);
    await assert.rejects(asApi({ ...claims, client_id: client.client_id, app: 'nope' }, 'select meta.api_check()'), (e: any) => e.code === 'PT401', 'wrong app');
  });

  test('the OAuth functions are for the owner only', async () => {
    const c = await owner.pool.connect();
    try {
      await c.query('begin');
      await c.query('set local role hr_api');
      await assert.rejects(c.query(`select * from meta.oauth_create_client('hr', 'test-evil')`), /permission denied/);
    } finally {
      await c.query('rollback');
      c.release();
    }
  });

  test('builder: create shows the secret once; rotate and revoke', async () => {
    const b = new Browser(app);
    await b.get('/builder/login');
    await b.submit('/builder/login', { username: 'admin', password: 'admin' });
    const appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
    await b.get(`/builder/apps/${appId}/api`);
    const name = `test-ui-${Date.now()}`;
    const created = await b.submit(`/builder/apps/${appId}/api/clients`, { name, roles: 'manager', token_minutes: '30' });
    assert.equal(created.statusCode, 200);
    const secret = /id="oauth_secret" class="code" readonly value="([^"]+)"/.exec(created.body)?.[1];
    assert.ok(secret, 'secret shown');
    const row = await owner.one('select id, client_id, token_minutes from meta.api_client where name = $1', [name]);
    assert.equal(row.token_minutes, 30);
    assert.equal((await token({ authorization: basic(row.client_id, secret!) }, { grant_type: 'client_credentials' })).statusCode, 200);
    const page = await b.get(`/builder/apps/${appId}/api`);
    assert.ok(!page.body.includes(secret!), 'not shown again');
    await b.submit(`/builder/apps/${appId}/api/clients/${row.id}/active`, { active: 'false' });
    assert.equal((await owner.one('select active from meta.api_client where id = $1', [row.id])).active, false);
  });
});
