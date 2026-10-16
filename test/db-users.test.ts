// Sprint 99 (Database Actions DA-13): Administration → Database Users. The SQL generation (src/dbroles.ts) and
// the pages (src/builder/db-users.ts): list with highlights, create / change with a review of the SQL (the
// password masked), apply in one transaction, drop with reassigning, pgkiln's own roles protected.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner, ownerUrl } from '../src/db.ts';
import { checkPassword, checkRole, dropSql, emptyRole, maskSql, parseSearchPath, PASSWORD_SLOT, roleSql, saslprep, scramVerifier, withVerifier, type RoleSpec } from '../src/dbroles.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
const P = 'dbu99_';
const READER = 'report_reader';
const PASSWORD = 'Rr-secret-99-pw';

async function dropTestRoles() {
  const roles = (await owner.query<{ r: string }>(`select rolname as r from pg_roles where rolname like '${P}%' or rolname = $1`, [READER])).rows;
  for (const { r } of roles) await owner.query(`reassign owned by ${pg.escapeIdentifier(r)} to current_user; drop owned by ${pg.escapeIdentifier(r)}; drop role ${pg.escapeIdentifier(r)}`);
}

before(async () => {
  app = await buildApp({ logger: false });
  await dropTestRoles();
  await owner.query(`drop schema if exists ${P}s cascade; create schema ${P}s`);
});
after(async () => {
  await owner.query(`drop schema if exists ${P}s cascade`);
  await dropTestRoles();
  await owner.query(`delete from meta.activity_log where event = 'db_role' and detail like '%${P}%'`);
  await app.close();
  await closePools();
});
const admin = async () => {
  const b = new Browser(app);
  await b.get('/builder/login');
  assert.equal((await b.submit('/builder/login', { username: 'admin', password: 'admin' })).statusCode, 303);
  return b;
};
/** Can this role sign in with this password? */
async function canSignIn(role: string, password: string) {
  const u = new URL(ownerUrl);
  u.username = role;
  u.password = password;
  const c = new pg.Client({ connectionString: u.toString() });
  try {
    await c.connect();
    return (await c.query('select current_user as u')).rows[0].u === role;
  } catch {
    return false;
  } finally {
    await c.end().catch(() => {});
  }
}
const form = (body: string) => {
  // the hidden fields of the review form (to post them back, like a browser)
  const out: Record<string, string | string[]> = {};
  const f = body.slice(body.lastIndexOf('<form method="post" action="/builder/db-users/save"'));
  for (const m of f.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    const v = m[2].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    if (m[1] === '__csrf') continue;
    const prev = out[m[1]];
    out[m[1]] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
  }
  return out;
};

describe('the SQL of a role (dbroles.ts)', () => {
  const ctx = { database: 'pgkiln', creator: 'pgkiln' };
  const spec = (over: Partial<RoleSpec>): RoleSpec => ({ ...emptyRole('report_reader'), ...over });

  test('create: login, password slot, expiry, limit, membership, search path, schema and default privileges, comment', () => {
    const sql = roleSql(null, spec({
      login: true, password: 'set', validUntil: '2027-10-16', connLimit: 5, memberOf: ['pg_read_all_stats'], searchPath: 'hr, public',
      comment: "Reports' reader", schemas: [{ schema: 'hr', usage: true, create: false, defaults: 'read', existing: 'read' }],
    }), ctx);
    assert.deepEqual(sql, [
      `CREATE ROLE "report_reader" LOGIN PASSWORD ${PASSWORD_SLOT} VALID UNTIL '2027-10-16' CONNECTION LIMIT 5;`,
      'GRANT "pg_read_all_stats" TO "report_reader";',
      'ALTER ROLE "report_reader" IN DATABASE "pgkiln" SET search_path TO "hr", "public";',
      'GRANT USAGE ON SCHEMA "hr" TO "report_reader";',
      'ALTER DEFAULT PRIVILEGES FOR ROLE "pgkiln" IN SCHEMA "hr" GRANT SELECT ON TABLES TO "report_reader";',
      'GRANT SELECT ON ALL TABLES IN SCHEMA "hr" TO "report_reader";',
      `COMMENT ON ROLE "report_reader" IS 'Reports'' reader';`,
    ]);
    assert.match(maskSql(sql), /PASSWORD '\*\*\*\*\*\*\*\*' VALID UNTIL/);
    assert.ok(!maskSql(sql).includes(PASSWORD_SLOT));
    const run = withVerifier(sql, 'SCRAM-SHA-256$4096:abc$def:ghi');
    assert.equal(run[0], `CREATE ROLE "report_reader" LOGIN PASSWORD 'SCRAM-SHA-256$4096:abc$def:ghi' VALID UNTIL '2027-10-16' CONNECTION LIMIT 5;`);
    assert.throws(() => withVerifier(sql, null), /password is needed/);
  });

  test('change: only what differs; revokes, resets, default privileges replaced', () => {
    const was = spec({ login: true, validUntil: '2027-01-01', connLimit: 5, memberOf: ['a', 'b'], searchPath: '"hr", public', comment: 'x',
      schemas: [{ schema: 'hr', usage: true, create: true, defaults: 'write' }, { schema: 'sales', usage: false, create: false, defaults: 'custom' }] });
    assert.deepEqual(roleSql(was, { ...was, password: 'keep' }, ctx), [], 'no change, no statement');
    const sql = roleSql(was, { ...was, login: false, password: 'remove', validUntil: '', connLimit: -1, memberOf: ['b', 'c'], searchPath: '', comment: '',
      schemas: [{ schema: 'hr', usage: true, create: false, defaults: 'none', existing: 'revoke' }, { schema: 'sales', usage: false, create: false, defaults: 'custom' }] }, ctx);
    assert.deepEqual(sql, [
      `ALTER ROLE "report_reader" NOLOGIN PASSWORD NULL VALID UNTIL 'infinity' CONNECTION LIMIT -1;`,
      'GRANT "c" TO "report_reader";',
      'REVOKE "a" FROM "report_reader";',
      'ALTER ROLE "report_reader" IN DATABASE "pgkiln" RESET search_path;',
      'REVOKE CREATE ON SCHEMA "hr" FROM "report_reader";',
      'ALTER DEFAULT PRIVILEGES FOR ROLE "pgkiln" IN SCHEMA "hr" REVOKE ALL ON TABLES FROM "report_reader";',
      'ALTER DEFAULT PRIVILEGES FOR ROLE "pgkiln" IN SCHEMA "hr" REVOKE ALL ON SEQUENCES FROM "report_reader";',
      'REVOKE ALL ON ALL TABLES IN SCHEMA "hr" FROM "report_reader";',
      'REVOKE ALL ON ALL SEQUENCES IN SCHEMA "hr" FROM "report_reader";',
      'COMMENT ON ROLE "report_reader" IS NULL;',
    ]);
  });

  test('names and values are quoted: identifiers with pg\'s escapeIdentifier, literals with escapeLiteral', () => {
    const evil = 'x"; drop role admin; --';
    const sql = roleSql({ ...emptyRole(evil), comment: '' }, { ...emptyRole(evil), comment: "it's \\ fine'; drop table t; --", memberOf: [`g"y`] }, { database: 'd"b', creator: 'c' });
    assert.deepEqual(sql, [`GRANT "g""y" TO "x""; drop role admin; --";`, `COMMENT ON ROLE "x""; drop role admin; --" IS E'it''s \\\\ fine''; drop table t; --';`]);
    assert.deepEqual(dropSql(evil, 'o"wner'), [`REASSIGN OWNED BY "x""; drop role admin; --" TO "o""wner";`, `DROP OWNED BY "x""; drop role admin; --";`, `DROP ROLE "x""; drop role admin; --";`]);
    assert.deepEqual(dropSql('r', null), ['DROP OWNED BY "r";', 'DROP ROLE "r";']);
  });

  test('checks: names, reserved prefixes, dates, limits, search path, memberships, schemas, passwords', () => {
    const o = { isNew: true, grantable: ['readers'], schemas: ['hr'], before: null };
    assert.deepEqual(checkRole(spec({ memberOf: ['readers'], schemas: [{ schema: 'hr', usage: true, create: false, defaults: 'read' }] }), o), []);
    for (const name of ['1abc', 'a b', 'a"b', '', 'x'.repeat(64)]) assert.match(checkRole(spec({ name }), o).join(), /The name starts/, name);
    for (const name of ['pg_x', 'PGKILN_x', 'pgkiln_runtime']) assert.match(checkRole(spec({ name }), o).join(), /reserved/, name);
    assert.match(checkRole(spec({ validUntil: '2027-02-30' }), o).join(), /Valid until/);
    assert.match(checkRole(spec({ validUntil: "2027-01-01' superuser" }), o).join(), /Valid until/);
    assert.match(checkRole(spec({ connLimit: NaN }), o).join(), /connection limit/);
    assert.match(checkRole(spec({ searchPath: 'hr; drop table x' }), o).join(), /search path/);
    assert.match(checkRole(spec({ memberOf: ['pgkiln_runtime'] }), o).join(), /can't be granted/);
    assert.deepEqual(checkRole(spec({ memberOf: ['old'] }), { ...o, isNew: false, before: spec({ memberOf: ['old'] }) }), [], 'an existing membership may stay');
    assert.match(checkRole(spec({ schemas: [{ schema: 'meta', usage: true, create: false, defaults: 'none' }] }), o).join(), /meta/);
    assert.deepEqual(parseSearchPath('"$user", hr ,public'), ['$user', 'hr', 'public']);
    assert.equal(parseSearchPath('hr, x)'), null);
    assert.match(checkPassword('short', 'short').join(), /at least 8/);
    assert.match(checkPassword('long enough', 'long enougH').join(), /differ/);
    assert.deepEqual(checkPassword('long enough', 'long enough'), []);
  });

  test('SCRAM-SHA-256 verifiers PostgreSQL accepts (also with SASLprep)', async () => {
    assert.match(scramVerifier('x'), /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}:[A-Za-z0-9+/=]{44}$/);
    assert.notEqual(scramVerifier('x'), scramVerifier('x'), 'a new salt each time');
    assert.equal(saslprep('I­X'), 'IX');
    assert.equal(saslprep('a b'), 'a b');
    for (const [i, pw] of ['plain-password-1', 'pässwörd-ünïcode'].entries()) {
      const role = `${P}scram${i}`;
      await owner.query(`create role ${role} login password ${pg.escapeLiteral(scramVerifier(pw))}`);
      assert.match((await owner.one(`select rolpassword from pg_authid where rolname = $1`, [role]))!.rolpassword, /^SCRAM-SHA-256\$/);
      assert.equal(await canSignIn(role, pw), true, pw);
      assert.equal(await canSignIn(role, `${pw}x`), false);
    }
  });
});

describe('Database Users pages', () => {
  test('create report_reader (login, valid until next year, usage on hr): the SQL is reviewed with the password masked, then applied', async () => {
    const b = await admin();
    const list = (await b.get('/builder/db-users')).body;
    assert.match(list, /<h1>Database Users<\/h1>/);
    assert.match(list, /href="\/builder\/db-users\/role\/pgkiln_runtime"/);
    assert.doesNotMatch(list, /pg_read_all_data/, 'predefined roles are left out');
    const page = (await b.get('/builder/db-users/new')).body;
    assert.match(page, /name="name"/);
    const i = [...page.matchAll(/name="s\.(\d+)\.name" value="([^"]+)"/g)].find((m) => m[2] === 'hr')![1];
    assert.ok(![...page.matchAll(/name="s\.\d+\.name" value="([^"]+)"/g)].some((m) => ['meta', 'api', 'pgkiln_plugins'].includes(m[1])), 'pgkiln\'s own schemas are not offered');
    const nextYear = `${new Date().getFullYear() + 1}-06-30`;
    const fields = { name: READER, login: '1', password_mode: 'set', valid_until: nextYear, conn_limit: '', search_path: 'hr', comment: 'Reports', [`s.${i}.name`]: 'hr', [`s.${i}.usage`]: '1', [`s.${i}.defaults`]: 'none', [`s.${i}.existing`]: '' };
    const review = await b.submit('/builder/db-users/save', { ...fields, original: '', mode: 'review' });
    assert.equal(review.statusCode, 200);
    assert.match(review.body, new RegExp(`CREATE ROLE &quot;report_reader&quot; LOGIN PASSWORD &#39;\\*{8}&#39; VALID UNTIL &#39;${nextYear}&#39;;`));
    assert.match(review.body, /GRANT USAGE ON SCHEMA &quot;hr&quot; TO &quot;report_reader&quot;;/);
    assert.match(review.body, /id="f_password" name="password" type="password"/);
    assert.equal((await owner.one(`select count(*)::int as n from pg_roles where rolname = $1`, [READER]))!.n, 0, 'nothing happens before Apply');
    const hidden = form(review.body);
    // a wrong confirmation: the review again, nothing created
    const bad = await b.submit('/builder/db-users/save', { ...hidden, mode: 'apply', password: PASSWORD, confirm: 'other-password' });
    assert.equal(bad.statusCode, 422);
    assert.match(bad.body, /differ/);
    assert.ok(!bad.body.includes(PASSWORD), 'the password is not echoed');
    const done = await b.submit('/builder/db-users/save', { ...hidden, mode: 'apply', password: PASSWORD, confirm: PASSWORD });
    assert.equal(done.statusCode, 303, done.body.slice(0, 500));
    const r = (await owner.one(`select rolcanlogin, to_char(rolvaliduntil, 'YYYY-MM-DD') as v, has_schema_privilege(oid, 'hr', 'USAGE') as usage,
                                        shobj_description(oid, 'pg_authid') as comment from pg_roles where rolname = $1`, [READER]))!;
    assert.deepEqual(r, { rolcanlogin: true, v: nextYear, usage: true, comment: 'Reports' });
    assert.equal(await canSignIn(READER, PASSWORD), true);
    const after = (await b.get('/builder/db-users')).body;
    assert.match(after, /Created the role report_reader: 4 statements\./);
    assert.match(after, /href="\/builder\/db-users\/role\/report_reader"><strong>report_reader<\/strong>/);
    const log = (await owner.one(`select detail from meta.activity_log where event = 'db_role' and detail like '%report_reader%' order by id desc limit 1`))!.detail as string;
    assert.match(log, /PASSWORD '\*{8}'/);
    assert.ok(!log.includes(PASSWORD) && !log.includes('SCRAM'), 'neither the password nor its verifier is logged');
    assert.ok(!(await b.get(`/builder/db-users/role/${READER}`)).body.includes('SCRAM-SHA-256$'));
  });

  test('change a role: membership, connection limit, default privileges; Apply refuses statements that changed since the review', async () => {
    await owner.query(`create role ${P}group nologin; create role ${P}edit login`);
    const b = await admin();
    const page = (await b.get(`/builder/db-users/role/${P}edit`)).body;
    assert.match(page, new RegExp(`name="member" value="${P}group"`));
    assert.match(page, /value="keep" checked> Keep the password/);
    const i = [...page.matchAll(/name="s\.(\d+)\.name" value="([^"]+)"/g)].find((m) => m[2] === `${P}s`)![1];
    const fields = { original: `${P}edit`, login: '1', password_mode: 'keep', valid_until: '', conn_limit: '3', search_path: '', comment: '', member: `${P}group`,
      [`s.${i}.name`]: `${P}s`, [`s.${i}.usage`]: '1', [`s.${i}.create`]: '1', [`s.${i}.defaults`]: 'write', [`s.${i}.existing`]: '' };
    const review = await b.submit('/builder/db-users/save', { ...fields, mode: 'review' });
    assert.match(review.body, new RegExp(`ALTER ROLE &quot;${P}edit&quot; CONNECTION LIMIT 3;`));
    assert.match(review.body, new RegExp(`ALTER DEFAULT PRIVILEGES FOR ROLE &quot;pgkiln&quot; IN SCHEMA &quot;${P}s&quot; GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES`));
    assert.doesNotMatch(review.body, /id="f_password"/, 'no password fields when the password is kept');
    const hidden = form(review.body);
    // the form changed after the review (here: another limit): not applied
    const changed = await b.submit('/builder/db-users/save', { ...hidden, conn_limit: '4', mode: 'apply' });
    assert.equal(changed.statusCode, 422);
    assert.match(changed.body, /changed since you reviewed them/);
    assert.equal((await owner.one(`select rolconnlimit from pg_roles where rolname = $1`, [`${P}edit`]))!.rolconnlimit, -1);
    assert.equal((await b.submit('/builder/db-users/save', { ...hidden, mode: 'apply' })).statusCode, 303);
    const r = (await owner.one(`select rolconnlimit, pg_has_role(oid, '${P}group', 'MEMBER') as member, has_schema_privilege(oid, '${P}s', 'CREATE') as create from pg_roles where rolname = $1`, [`${P}edit`]))!;
    assert.deepEqual(r, { rolconnlimit: 3, member: true, create: true });
    await owner.query(`create table ${P}s.later (id serial)`);
    assert.equal((await owner.one(`select has_table_privilege('${P}edit', '${P}s.later', 'INSERT') as ok`))!.ok, true, 'default privileges for new tables');
    // the form reads it back as it is now: no change, nothing to apply
    const again = (await b.get(`/builder/db-users/role/${P}edit`)).body;
    assert.match(again, /<option value="write" selected>Read and write<\/option>/);
    const none = await b.submit('/builder/db-users/save', { ...fields, mode: 'review' });
    assert.match(none.body, /Nothing to change/);
    // a failing statement rolls everything back (a membership that became circular after the review)
    await owner.query(`create role ${P}circle nologin`);
    const fail = await b.submit('/builder/db-users/save', { ...fields, member: [`${P}group`, `${P}circle`], conn_limit: '7', mode: 'review' });
    const h2 = form(fail.body);
    await owner.query(`grant ${P}edit to ${P}circle`);
    const res = await b.submit('/builder/db-users/save', { ...h2, mode: 'apply' });
    assert.equal(res.statusCode, 422);
    assert.match(res.body, /Nothing was changed/);
    assert.match(res.body, new RegExp(`GRANT &quot;${P}circle&quot; TO &quot;${P}edit&quot;;</pre>`), 'the statement that failed');
    assert.equal((await owner.one(`select rolconnlimit from pg_roles where rolname = $1`, [`${P}edit`]))!.rolconnlimit, 3);
  });

  test('highlights: passwords expiring within 30 days, BYPASSRLS, group roles that own objects', async () => {
    await owner.query(`create role ${P}soon login valid until '${new Date(Date.now() + 10 * 86400e3).toISOString().slice(0, 10)}';
      create role ${P}bypass nologin bypassrls; create role ${P}owner nologin; create table ${P}s.owned (id int); alter table ${P}s.owned owner to ${P}owner`);
    const b = await admin();
    const has = async (f: string, role: string) => new RegExp(`role/${role}"`).test((await b.get(`/builder/db-users?f=${f}`)).body);
    assert.equal(await has('expiring', `${P}soon`), true);
    assert.equal(await has('expiring', `${P}edit`), false);
    assert.equal(await has('bypassrls', `${P}bypass`), true);
    assert.equal(await has('owners', `${P}owner`), true);
    assert.equal(await has('owners', `${P}bypass`), false);
    assert.equal(await has('pgkiln', 'pgkiln_runtime'), true);
    const soon = (await b.get('/builder/db-users?f=expiring')).body;
    assert.match(soon, /<span class="tag tag-warning">in (9|10) days<\/span>/);
    assert.match((await b.get(`/builder/db-users?q=${P}BYP`)).body, new RegExp(`role/${P}bypass"`), 'search ignores case');
  });

  test('drop a role: its objects listed, reassigned to another role, then dropped', async () => {
    const b = await admin();
    const page = (await b.get(`/builder/db-users/role/${P}owner/drop`)).body;
    assert.match(page, new RegExp(`owns 1 object in this database`));
    assert.match(page, new RegExp(`table ${P}s.owned`));
    assert.match(page, new RegExp(`REASSIGN OWNED BY &quot;${P}owner&quot; TO &quot;pgkiln&quot;;\nDROP OWNED BY &quot;${P}owner&quot;;\nDROP ROLE &quot;${P}owner&quot;;`));
    const digest = /name="reviewed" value="([^"]+)"/.exec(page)![1];
    // without reassigning, the objects go only with the box ticked
    const noTick = await b.get(`/builder/db-users/role/${P}owner/drop?to=`);
    const d2 = /name="reviewed" value="([^"]+)"/.exec(noTick.body)![1];
    const refused = await b.submit('/builder/db-users/drop', { name: `${P}owner`, to: '', reviewed: d2 });
    assert.match(refused.body, /Tick the box/);
    assert.equal((await b.submit('/builder/db-users/drop', { name: `${P}owner`, to: 'pgkiln', reviewed: digest })).statusCode, 303);
    assert.equal((await owner.one(`select count(*)::int as n from pg_roles where rolname = $1`, [`${P}owner`]))!.n, 0);
    assert.equal((await owner.one(`select tableowner from pg_tables where schemaname = '${P}s' and tablename = 'owned'`))!.tableowner, 'pgkiln');
  });

  test('pgkiln\'s own roles are shown, not changed or dropped; roles applications use are not dropped', async () => {
    const b = await admin();
    for (const role of ['pgkiln_runtime', 'pgkiln_app_code', 'pgkiln']) {
      const page = (await b.get(`/builder/db-users/role/${role}`)).body;
      assert.match(page, /one of pgkiln&#39;s own roles/, role);
      assert.doesNotMatch(page, /action="\/builder\/db-users\/save"/, role);
      assert.equal((await b.get(`/builder/db-users/role/${role}/drop`)).statusCode, 403, role);
    }
    const hrApp = (await owner.one(`select db_role from meta.app where alias = 'hr'`))!.db_role as string;
    const page = (await b.get(`/builder/db-users/role/${hrApp}`)).body;
    assert.match(page, /application hr \(parsing schema\)/);
    assert.match(page, /action="\/builder\/db-users\/save"/, 'it can be changed');
    assert.doesNotMatch(page, /Drop role…/);
    assert.equal((await b.get(`/builder/db-users/role/${hrApp}/drop`)).statusCode, 403);
    assert.equal((await b.submit('/builder/db-users/drop', { name: hrApp, to: '', reviewed: 'x' })).statusCode, 403);
    assert.equal((await owner.one(`select count(*)::int as n from pg_roles where rolname = $1`, [hrApp]))!.n, 1);
  });

  test('the tool is on the Launchpad (Administration) and in the Administration menu, for administrators', async () => {
    const b = await admin();
    const home = (await b.get('/builder/sql')).body;
    assert.match(home, /<a href="\/builder\/db-users">/);
    assert.match(home, /href="\/builder\/db-users">.{0,200}Database users/s);
  });
});
