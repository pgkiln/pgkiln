// REST API tests (PostgREST alongside pgapex, see docs/guide/13-rest-api.md).
//
// The SQL tests always run: they act like PostgREST (SET ROLE to the API
// role, request.jwt.claims set) and check that the HR policies hold for API
// callers. The HTTP tests need PostgREST at API_URL and skip without it:
//   docker compose --profile api up -d postgrest
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { decodeJwt, SignJWT } from 'jose';
import '../src/env.ts';
import { apiRoleProblem, apiStatus, apiUrl, issueApiToken } from '../src/api.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';

let app: FastifyInstance;
let appId: number;
let postgrest = false;

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  postgrest = (await apiStatus()).ok;
  if (postgrest) await owner.query(`notify pgrst, 'reload schema'`);
});

after(async () => {
  await app.close();
  await closePools();
});

/** Run SQL the way PostgREST does for a verified token, then roll back. */
async function asApi<T>(claims: Record<string, unknown>, fn: (q: (sql: string, params?: unknown[]) => Promise<any[]>) => Promise<T>) {
  const c = await owner.pool.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    await c.query(`set local role ${claims.role}`);
    return await fn(async (sql, params = []) => (await c.query(sql, params)).rows);
  } finally {
    await c.query('rollback').catch(() => {});
    c.release();
  }
}
const claims = (user: string, extra: Record<string, unknown> = {}) => ({ role: 'hr_api', app_user: user, app: 'hr', ...extra });
const nextMonday = () => {
  const d = new Date(Date.now() + 60 * 86400000);
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7));
  return d.toISOString().slice(0, 10);
};

describe('REST API: database', () => {
  test('meta.app_user(), app_id() and has_role() read the JWT claims', async () => {
    await asApi(claims('blake'), async (q) => {
      const [r] = await q(`select meta.app_user() as u, meta.app_id() as a, meta.has_role('manager') as m, meta.has_role('admin') as adm`);
      assert.deepEqual(r, { u: 'blake', a: appId, m: true, adm: false }, 'roles come from the account in the token’s app');
    });
    await asApi(claims('allen', { roles: ['auditor'] }), async (q) => {
      const [r] = await q(`select meta.has_role('AUDITOR') as a, meta.has_role('manager') as m`);
      assert.deepEqual(r, { a: true, m: false }, 'roles in the token count too');
    });
    await asApi({ role: 'hr_api', preferred_username: 'scott', app: 'hr' }, async (q) => {
      assert.equal((await q('select meta.app_user() as u'))[0].u, 'scott', 'identity provider tokens: preferred_username');
    });
    const [none] = (await owner.query(`select meta.app_user() as u, meta.has_role('admin') as a`)).rows;
    assert.deepEqual(none, { u: 'nobody', a: false }, 'no claims outside PostgREST');
  });

  test('the pre-request check rejects inactive accounts, lost access and mismatched tokens', async () => {
    const check = (c: Record<string, unknown>) => asApi(c, (q) => q('select meta.api_check()'));
    await check(claims('allen'));
    await assert.rejects(check(claims('allen', { app: 'nope' })), (e: any) => e.code === 'PT401', 'unknown app');
    await assert.rejects(check({ ...claims('allen'), role: 'pgapex_runtime' }), (e: any) => e.code === 'PT401', 'role is not the app’s API role');
    await assert.rejects(check(claims('ghost')), (e: any) => e.code === 'PT403', 'no such account');
    const user = `api_${Date.now()}`;
    const acc = (await owner.one(`insert into meta.account (username) values ($1) returning id`, [user])).id;
    try {
      await assert.rejects(check(claims(user)), (e: any) => e.code === 'PT403', 'no access');
      await owner.query(`insert into meta.app_access (app_id, account_id, roles) values ($1, $2, '{manager}')`, [appId, acc]);
      await check(claims(user));
      assert.equal((await asApi(claims(user), (q) => q(`select meta.has_role('manager') as m`)))[0].m, true);
      await owner.query(`update meta.app_access set roles = '{}' where account_id = $1`, [acc]);
      assert.equal((await asApi(claims(user), (q) => q(`select meta.has_role('manager') as m`)))[0].m, false, 'role changes apply at once');
      await owner.query('update meta.account set active = false where id = $1', [acc]);
      await assert.rejects(check(claims(user)), (e: any) => e.code === 'PT403', 'inactive');
    } finally {
      await owner.query('delete from meta.account where id = $1', [acc]);
    }
  });

  test('a pgapex session wins over JWT claims', async () => {
    await asApi(claims('king'), async (q) => {
      await q(`select set_config('pgapex.app_user', 'allen', true), set_config('pgapex.session_id', gen_random_uuid()::text, true)`);
      const [r] = await q(`select meta.app_user() as u, meta.has_role('admin') as a`);
      assert.deepEqual(r, { u: 'allen', a: false });
    });
  });

  test('row level security applies to API callers', async () => {
    const own = await asApi(claims('allen'), (q) => q('select distinct employee_id from api.leave_requests'));
    assert.ok(own.every((r) => r.employee_id === 7499), 'allen sees only his own leave');
    const team = await asApi(claims('blake'), (q) => q('select distinct employee_id from api.leave_requests'));
    assert.ok(team.some((r) => r.employee_id !== 7698), 'blake sees his team');
    await asApi(claims('allen'), async (q) => {
      await q('savepoint s');
      await assert.rejects(q('select sal from hr.emp'), /permission denied/, 'no salary through the API role');
      await q('rollback to savepoint s');
      assert.ok(!(await q('select * from api.employees limit 1'))[0].hasOwnProperty('salary'));
    });
  });

  test('leave requests through the API follow the business rules', async () => {
    const start = nextMonday();
    await asApi(claims('allen'), async (q) => {
      const [{ id }] = await q('select api.request_leave($1, $1, $2) as id', [start, 'api test']);
      await q('savepoint s');
      await assert.rejects(q(`select api.decide_leave($1, 'approved')`, [id]), /own leave request/);
      await q('rollback to savepoint s');
      await q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims('blake'))]);
      await q(`select api.decide_leave($1, 'approved', 'ok')`, [id]);
      const [r] = await q('select status, decided_by from api.leave_requests where id = $1', [id]);
      assert.deepEqual(r, { status: 'APPROVED', decided_by: 'blake' });
    });
  });
});

describe('REST API: tokens', () => {
  test('tokens carry the API role, the app and the account, not its roles', async () => {
    const { token, expiresInHours } = await issueApiToken(appId, 'BLAKE', 2);
    const c = decodeJwt(token);
    assert.deepEqual([c.role, c.app_user, c.app, c.roles], ['hr_api', 'blake', 'hr', undefined], 'roles are read live');
    assert.equal(expiresInHours, 2);
    assert.ok(Number(c.exp) - Number(c.iat) === 2 * 3600);
    assert.equal((await issueApiToken(appId, 'allen', 99999)).expiresInHours, 24 * 30, 'lifetime is capped');
  });

  test('tokens are refused for unknown, inactive or unauthorized accounts', async () => {
    await assert.rejects(issueApiToken(appId, 'no-such-user', 1), /no account/);
    const user = `api_${Date.now()}`;
    await owner.query(`insert into meta.account (username, password_hash) values ($1, meta.hash_password('correct-horse'))`, [user]);
    try {
      await assert.rejects(issueApiToken(appId, user, 1), /no access/);
      await owner.query('update meta.account set active = false where username = $1', [user]);
      await assert.rejects(issueApiToken(appId, user, 1), /inactive/);
    } finally {
      await owner.query('delete from meta.account where username = $1', [user]);
    }
  });

  test('roles that bypass row level security cannot be API roles', async () => {
    assert.equal(await apiRoleProblem('hr_api'), null);
    assert.match((await apiRoleProblem('pgapex'))!, /bypasses row level security/);
    assert.match((await apiRoleProblem('pgapex_runtime'))!, /own roles/);
    assert.match((await apiRoleProblem('nope'))!, /no database role/);
    await owner.query(`update meta.app set api_role = 'pgapex' where id = $1`, [appId]);
    try {
      await assert.rejects(issueApiToken(appId, 'king', 1), /bypasses row level security/);
    } finally {
      await owner.query(`update meta.app set api_role = 'hr_api' where id = $1`, [appId]);
    }
  });

  test('the builder issues tokens only to developers, with CSRF, and does not cache them', async () => {
    let cookie = '';
    const req = async (method: 'GET' | 'POST', url: string, form?: Record<string, string>) => {
      const r = await app.inject({
        method, url, payload: form ? new URLSearchParams(form).toString() : undefined,
        headers: { cookie, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      });
      for (const c of r.cookies as { name: string; value: string }[]) cookie = `${c.name}=${c.value}`;
      return r;
    };
    const csrf = (body: string) => /name="__csrf" value="([^"]+)"/.exec(body)![1];
    assert.equal((await req('POST', `/builder/apps/${appId}/api/token`, { username: 'king', hours: '1' })).statusCode, 302, 'not signed in');
    const login = await req('GET', '/builder/login');
    await req('POST', '/builder/login', { __csrf: csrf(login.body), username: 'admin', password: 'admin' });
    const page = await req('GET', `/builder/apps/${appId}/api`);
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /\/rpc\/request_leave/);
    assert.equal((await req('POST', `/builder/apps/${appId}/api/token`, { __csrf: 'wrong', username: 'king', hours: '1' })).statusCode, 403);
    const res = await req('POST', `/builder/apps/${appId}/api/token`, { __csrf: csrf(page.body), username: 'king', hours: '1' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    const token = /id="api_token"[^>]*>([^<]+)</.exec(res.body)?.[1];
    assert.equal(decodeJwt(token!).app_user, 'king');
    await req('POST', `/builder/apps/${appId}/api`, { __csrf: csrf(res.body), api_role: 'pgapex' });
    assert.equal((await owner.one('select api_role from meta.app where id = $1', [appId])).api_role, 'hr_api', 'unsafe role refused');
    await owner.query(`delete from meta.activity_log where event = 'api_token' and app_id = $1`, [appId]);
  });
});

describe('REST API: HTTP (needs PostgREST at API_URL)', () => {
  const get = (path: string, token?: string) =>
    fetch(`${apiUrl()}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

  test('callers see only what the policies allow', async (t) => {
    if (!postgrest) return t.skip('PostgREST is not reachable');
    const { token } = await issueApiToken(appId, 'allen', 1);
    const res = await get('/leave_requests', token);
    assert.equal(res.status, 200);
    const rows = (await res.json()) as { employee_id: number }[];
    assert.ok(rows.every((r) => r.employee_id === 7499));
    const emp = (await (await get('/employees?limit=1', token)).json()) as object[];
    assert.ok(!('salary' in emp[0]), 'no salary');
    assert.equal((await get('/emp', token)).status, 404, 'base tables are not exposed');
  });

  test('deactivating an account stops its tokens at once', async (t) => {
    if (!postgrest) return t.skip('PostgREST is not reachable');
    const user = `api_${Date.now()}`;
    const acc = (await owner.one(`insert into meta.account (username) values ($1) returning id`, [user])).id;
    try {
      await owner.query(`insert into meta.app_access (app_id, account_id) values ($1, $2)`, [appId, acc]);
      const { token } = await issueApiToken(appId, user, 1);
      assert.equal((await get('/employees?limit=1', token)).status, 200);
      await owner.query('update meta.account set active = false where id = $1', [acc]);
      assert.equal((await get('/employees?limit=1', token)).status, 403, 'inactive');
      await owner.query('update meta.account set active = true where id = $1', [acc]);
      await owner.query('delete from meta.app_access where account_id = $1', [acc]);
      assert.equal((await get('/employees?limit=1', token)).status, 403, 'access revoked');
    } finally {
      await owner.query('delete from meta.account where id = $1', [acc]);
    }
  });

  test('missing, forged and expired tokens are rejected', async (t) => {
    if (!postgrest) return t.skip('PostgREST is not reachable');
    assert.equal((await get('/leave_requests')).status, 401, 'anonymous: no privileges');
    const forged = await new SignJWT({ role: 'hr_api', app_user: 'king', app: 'hr' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
      .sign(new TextEncoder().encode('not-the-secret-not-the-secret-not-the-secret'));
    assert.equal((await get('/leave_requests', forged)).status, 401, 'forged');
    const expired = await new SignJWT({ role: 'hr_api', app_user: 'king', app: 'hr' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(new TextEncoder().encode(process.env.API_JWT_SECRET!));
    assert.equal((await get('/leave_requests', expired)).status, 401, 'expired');
  });
});
