// LDAP sign-in. Needs an LDAP server (docker compose --profile ldap up -d ldap,
// or the CI service); the tests add the entries they use and skip without one.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { Attribute, Change, Client } from 'ldapts';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner, runtime } from '../src/db.ts';
import { escapeFilter } from '../src/ldap.ts';
import { Browser } from './helpers.ts';

const URL = process.env.LDAP_URL ?? 'ldap://127.0.0.1:3890';
const BASE = process.env.LDAP_BASE ?? 'dc=example,dc=org';
const ADMIN = process.env.LDAP_ADMIN_DN ?? `cn=admin,${BASE}`;
const ADMIN_PASSWORD = process.env.LDAP_ADMIN_PASSWORD ?? 'admin';

let app: FastifyInstance;
let appId: number;
let reachable = false;

/** Add an entry, or (when it exists) reset its password. */
async function upsert(c: Client, dn: string, attrs: Record<string, string | string[]>) {
  try {
    await c.add(dn, attrs);
  } catch (e) {
    if ((e as Error).constructor.name !== 'AlreadyExistsError') throw e;
    if (attrs.userPassword) await c.modify(dn, new Change({ operation: 'replace', modification: new Attribute({ type: 'userPassword', values: [String(attrs.userPassword)] }) }));
  }
}

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  const c = new Client({ url: URL, timeout: 3000, connectTimeout: 3000 });
  try {
    await c.bind(ADMIN, ADMIN_PASSWORD);
    reachable = true;
    await upsert(c, `ou=people,${BASE}`, { objectClass: 'organizationalUnit', ou: 'people' });
    await upsert(c, `ou=groups,${BASE}`, { objectClass: 'organizationalUnit', ou: 'groups' });
    for (const [uid, cn] of [['blake', 'Blake Manager'], ['dora', 'Dora Directory'], ['eve', 'Eve Nogroups']])
      await upsert(c, `uid=${uid},ou=people,${BASE}`, { objectClass: 'inetOrgPerson', uid, cn, sn: cn.split(' ')[1], mail: `${uid}@example.org`, userPassword: `${uid}-ldap` });
    await upsert(c, `cn=hr-managers,ou=groups,${BASE}`, { objectClass: 'groupOfNames', cn: 'hr-managers', member: [`uid=blake,ou=people,${BASE}`, `uid=dora,ou=people,${BASE}`] });
  } catch {
    reachable = false;
  } finally {
    await c.unbind().catch(() => {});
  }
  await cleanup();
  await owner.query(
    `insert into meta.ldap_directory (name, display_name, url, bind_dn, bind_password, user_base, group_base, group_filter)
     values ('test-ldap', 'Test directory', $1, $2, $3, $4, $5, '(member={dn})')`,
    [URL, ADMIN, ADMIN_PASSWORD, `ou=people,${BASE}`, `ou=groups,${BASE}`],
  );
  await owner.query(`update meta.app set ldap_directories = array['test-ldap'] where id = $1`, [appId]);
  await owner.query(`insert into meta.app_group_role (app_id, group_name, role) values ($1, 'hr-managers', 'ldap-manager') on conflict do nothing`, [appId]);
});

async function cleanup() {
  await owner.query(`delete from meta.ldap_directory where name in ('test-ldap', 'down', 'builder-test')`);
  await owner.query(`delete from meta.account where username in ('dora', 'eve')`);
  await owner.query(`update meta.app set ldap_directories = '{}', remember_me_days = null where id = $1`, [appId]);
  await owner.query(`delete from meta.app_group_role where app_id = $1 and group_name = 'hr-managers' and role = 'ldap-manager'`, [appId]);
}

// failed sign-ins (on purpose, and from earlier runs) would trip the throttle
beforeEach(() => owner.query(`delete from meta.activity_log where app_id = $1 and event in ('login_failed', 'login_locked')`, [appId]));

after(async () => {
  await cleanup();
  await app.close();
  await closePools();
});

async function signIn(username: string, password: string, extra: Record<string, string> = {}) {
  const b = new Browser(app);
  await b.get('/a/hr/login');
  const res = await b.post('/a/hr/login', { __csrf: b.lastCsrf, username, password, ...extra });
  return { b, res };
}
const roles = async (b: Browser) => /Roles: ([^<]*)</.exec((await b.get('/a/hr/1')).body)?.[1] ?? '';

describe('LDAP sign-in', () => {
  test('filter values are escaped (RFC 4515)', () => {
    assert.equal(escapeFilter('a*b(c)d\\e\0'), 'a\\2ab\\28c\\29d\\5ce\\00');
  });

  test('an existing account is linked; directory groups add their roles', async (t) => {
    if (!reachable) return t.skip(`no LDAP server at ${URL}`);
    const { b, res } = await signIn('blake', 'blake-ldap');
    assert.equal(res.statusCode, 303);
    const r = await roles(b);
    assert.match(r, /ldap-manager/, 'group-mapped role');
    assert.match(r, /manager/, 'the account\'s own roles stay');
    const link = await owner.one(`select i.subject from meta.ldap_identity i join meta.account a on a.id = i.account_id where a.username = 'blake'`);
    assert.match(link.subject, /^[0-9a-f-]{36}$/, 'linked by entryUUID');
    // the local password still works too
    assert.equal((await signIn('blake', 'blake')).res.statusCode, 303);
  });

  test('without an account: refused, or created when the directory allows it', async (t) => {
    if (!reachable) return t.skip(`no LDAP server at ${URL}`);
    const refused = await signIn('dora', 'dora-ldap');
    assert.equal(refused.res.statusCode, 403);
    assert.match(refused.res.body, /There is no account for &quot;dora&quot;|There is no account for "dora"/);
    await owner.query(`update meta.ldap_directory set auto_create = true where name = 'test-ldap'`);
    const { b, res } = await signIn('dora', 'dora-ldap');
    assert.equal(res.statusCode, 303, 'access through the mapped group');
    assert.match(await roles(b), /ldap-manager/);
    const acc = await owner.one(`select display_name, email, password_hash from meta.account where username = 'dora'`);
    assert.deepEqual(acc, { display_name: 'Dora Directory', email: 'dora@example.org', password_hash: null });
    // eve: created, but no access row and no mapped group
    const eve = await signIn('eve', 'eve-ldap');
    assert.equal(eve.res.statusCode, 403);
    assert.match(eve.res.body, /eve/);
  });

  test('wrong or empty passwords and filter injection are refused', async (t) => {
    if (!reachable) return t.skip(`no LDAP server at ${URL}`);
    for (const [u, p] of [['blake', 'wrong'], ['blake', ''], ['*', 'blake-ldap'], ['blake)(uid=*', 'blake-ldap'], ['dora*', 'dora-ldap']]) {
      const { res } = await signIn(u, p);
      assert.notEqual(res.statusCode, 303, `${u} / ${p}`);
    }
  });

  test('a directory that is down says so; the next one is tried', async (t) => {
    if (!reachable) return t.skip(`no LDAP server at ${URL}`);
    await owner.query(`insert into meta.ldap_directory (name, display_name, url, user_base) values ('down', 'Down', 'ldap://127.0.0.1:1', 'dc=x')`);
    await owner.query(`update meta.app set ldap_directories = array['down'] where id = $1`, [appId]);
    const down = await signIn('blake', 'blake-ldap');
    assert.equal(down.res.statusCode, 401);
    assert.match(down.res.body, /not reachable/);
    await owner.query(`update meta.app set ldap_directories = array['down', 'test-ldap'] where id = $1`, [appId]);
    assert.equal((await signIn('blake', 'blake-ldap')).res.statusCode, 303);
    await owner.query(`update meta.app set ldap_directories = array['test-ldap'] where id = $1`, [appId]);
  });

  test('"Remember me" works for directory sign-ins and keeps the group roles', async (t) => {
    if (!reachable) return t.skip(`no LDAP server at ${URL}`);
    await owner.query('update meta.app set remember_me_days = 7 where id = $1', [appId]);
    const { b } = await signIn('blake', 'blake-ldap', { remember: 'true' });
    await owner.query(`delete from meta.session where app_id = $1 and username = 'blake'`, [appId]);
    assert.match(await roles(b), /ldap-manager/);
    const row = await owner.one(`select method, groups from meta.persistent_login where app_id = $1`, [appId]);
    assert.deepEqual(row, { method: 'ldap:test-ldap', groups: ['hr-managers'] });
    await owner.query('update meta.app set remember_me_days = null where id = $1', [appId]);
  });

  test('the runtime role cannot read directories or links', async () => {
    for (const t of ['meta.ldap_directory', 'meta.ldap_identity']) await assert.rejects(runtime.query(`select * from ${t}`), /permission denied/, t);
  });

  test('the builder adds, tests and enables a directory; the bind password stays write-only', async (t) => {
    const dev = new Browser(app);
    await dev.get('/builder/login');
    await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
    await dev.get('/builder/users/directories');
    const res = await dev.submit('/builder/users/directories', {
      name: 'builder-test', display_name: 'Builder test', url: URL, bind_dn: ADMIN, bind_password: 'super-secret-bind',
      user_base: `ou=people,${BASE}`, user_filter: '(uid={username})', tls_verify: 'true', enabled: 'true',
    });
    assert.equal(res.statusCode, 303);
    const id = /directories\/(\d+)/.exec(String(res.headers.location))![1];
    const page = (await dev.get(`/builder/users/directories/${id}`)).body;
    assert.doesNotMatch(page, /super-secret-bind/);
    assert.match(page, /A password is stored/);
    // saving without a password keeps it
    await dev.submit(`/builder/users/directories/${id}`, { display_name: 'Builder test', url: URL, bind_dn: ADMIN, user_base: `ou=people,${BASE}`, enabled: 'true', tls_verify: 'true' });
    assert.equal((await owner.one('select bind_password from meta.ldap_directory where id = $1', [id])).bind_password, 'super-secret-bind');
    if (reachable) {
      // the real password, then look a user up
      await dev.submit(`/builder/users/directories/${id}`, { display_name: 'Builder test', url: URL, bind_dn: ADMIN, bind_password: ADMIN_PASSWORD, user_base: `ou=people,${BASE}`, enabled: 'true', tls_verify: 'true' });
      await dev.get(`/builder/users/directories/${id}`);
      await dev.submit(`/builder/users/directories/${id}/test`, { username: 'blake' });
      const after = (await dev.get(`/builder/users/directories/${id}`)).body;
      assert.match(after, /Found uid=blake,ou=people/, [...after.matchAll(/class="alert[^"]*"[^>]*>([^<]*)/g)].map((m) => m[1]).join(" | "));
    } else t.diagnostic('LDAP not reachable: connection test skipped');
    // per app, under Settings → Sign-in methods
    assert.match((await dev.get(`/builder/apps/${appId}/settings`)).body, /name="ldap_directories" value="builder-test"/);
    await dev.submit(`/builder/users/directories/${id}/delete`, {});
    assert.equal(await owner.one('select 1 from meta.ldap_directory where id = $1', [id]), undefined);
  });
});
