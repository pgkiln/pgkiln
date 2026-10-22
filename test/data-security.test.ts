// Sprint 119 (WS-13: data security per table). SQL Workshop › a table › Security: database roles × columns and masked
// values per application role, written as GRANT / REVOKE and a masking view (src/datasec.ts). The card's "done when":
// hiding a column from a role makes it masked in the application, in AutoREST, in a REST handler, in an AI tool's
// query and in the MCP server's run_query, because they all run as the application's role with the same identity.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { issueApiToken } from '../src/api.ts';
import { appTx, closePools, owner } from '../src/db.ts';
import {
  checkSecurity, columnSql, configComment, currentDef, maskRoleName, parseConfig, readSecurity, securitySql, type TableSecurity,
} from '../src/datasec.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
const S = 'ds119';
const M = maskRoleName(S);
const token: Record<string, string> = {};

const dropAll = async () => {
  await owner.query(`delete from meta.rest_object where app_id = $1 and schema_name = $2`, [appId, S]);
  await owner.query(`delete from meta.rest_module where app_id = $1 and name = 'm119'`, [appId]);
  await owner.query(`delete from meta.session where token_hash like 'ds119-%'`);
  await owner.query(`drop schema if exists ${S} cascade`);
  if ((await owner.query(`select from pg_roles where rolname = $1`, [M])).rowCount) await owner.query(`drop owned by ${M}; drop role ${M}`);
};

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  for (const u of ['king', 'allen']) token[u] = (await issueApiToken(appId, u, 1)).token;
  await dropAll();
  await owner.query(`
    create schema ${S};
    grant usage on schema ${S} to hr_app;
    create table ${S}.pay (id int primary key, owner text not null, amount numeric, iban text);
    insert into ${S}.pay values (1, 'king', 5000, 'NL91ABNA0417164300'), (2, 'allen', 1600, 'NL20INGB0001234567');
    grant select, update on ${S}.pay to hr_app;
    alter table ${S}.pay enable row level security;
    create policy own on ${S}.pay using (owner = meta.app_user() or meta.has_role('manager'));
  `);
});

after(async () => {
  await dropAll();
  await app.close();
  await closePools();
});

const builder = async () => {
  const b = new Browser(app);
  await b.get('/builder/login');
  assert.equal((await b.submit('/builder/login', { username: 'admin', password: 'admin' })).statusCode, 303);
  return b;
};

const read = async () => (await readSecurity(owner, `${S}.pay`, [{ role: 'hr_app', alias: 'hr' }], ['manager']))!;

describe('definitions', () => {
  test('a masking role per schema, cut with a hash when the name would be too long', () => {
    assert.equal(maskRoleName('sales'), 'sales_masking');
    const long = maskRoleName('s'.repeat(60));
    assert.ok(Buffer.byteLength(long) <= 63 && long.endsWith('_masking'));
    assert.notEqual(maskRoleName(`${'s'.repeat(59)}a`), maskRoleName(`${'s'.repeat(59)}b`));
  });

  test('the configuration in the view comment: read back as written, refused when it names another table or is broken', () => {
    const c = { table: 'pay', roles: ['manager'], cols: { amount: { mask: 'null' as const, see: ['manager'], others: false } } };
    assert.deepEqual(parseConfig(configComment(c), 'pay'), c);
    assert.equal(parseConfig(configComment(c), 'other'), null);
    assert.equal(parseConfig('pgkiln masking view of pay: {not json', 'pay'), null);
    assert.equal(parseConfig('a view', 'pay'), null);
    // roles that aren't in the list, or aren't roles, are dropped; an unknown mask becomes null
    const odd = parseConfig(`pgkiln masking view of pay: ${JSON.stringify({ table: 'pay', roles: ['manager', "x'); drop table y; --"], cols: { amount: { mask: 'evil', see: ['manager', 'clerk'] } } })}`, 'pay');
    assert.deepEqual(odd, { table: 'pay', roles: ['manager'], cols: { amount: { mask: 'null', see: ['manager'], others: false } } });
  });

  test('a column\'s SQL: roles as literals, names as identifiers', () => {
    assert.equal(columnSql('id', ['manager'], undefined), 't."id"');
    assert.equal(columnSql('amount', ['manager'], { mask: 'null', see: ['manager'], others: false }),
      `case when (select meta.has_role('manager')) then t."amount" end as "amount"`);
    assert.equal(columnSql('iban', [], { mask: 'partial', see: [], others: false }),
      `case when false then t."iban"::text else '***' || right(t."iban"::text, 4) end as "iban"`);
    assert.match(columnSql('x"y', ["o'brien"], { mask: 'stars', see: [], others: true }), /not \(\(select meta\.has_role\('o''brien'\)\)\).*as "x""y"$/);
    // seen by everyone: no mask at all
    assert.equal(columnSql('id', ['manager'], { mask: 'stars', see: ['manager'], others: true }), 't."id"');
  });

  test('checks: roles and columns of the table only, a free view name, valid application roles', async () => {
    const cur = await read();
    const def = currentDef(cur);
    def.grants.push({ role: 'postgres', select: ['id'], update: [] });
    def.view = { enabled: true, name: 'pay', roles: ['Manager'], cols: { nope: { mask: 'null', see: ['clerk'], others: false } } };
    const errors = checkSecurity(def, cur, ['pay']);
    assert.ok(errors.some((e) => /postgres is not a database role/.test(e)), errors.join('\n'));
    assert.ok(errors.some((e) => /nope is not a column/.test(e)));
    assert.ok(errors.some((e) => /other than the table/.test(e)));
    assert.ok(errors.some((e) => /"Manager" is not a valid application role/.test(e)));
    assert.ok(errors.some((e) => /A role that sees nope is not in the list/.test(e)));
  });

  test('the owner and roles that bypass row level security are left out of the matrix', async () => {
    const cur: TableSecurity = await read();
    assert.deepEqual(cur.grants.map((g) => g.role), ['hr_app']);
    assert.deepEqual(cur.grants[0].apps, ['hr']);
    assert.ok(cur.excluded.every((x) => x.role !== 'hr_app'));
    assert.deepEqual(securitySql(currentDef(cur), cur).statements, [], 'the current state needs no statements');
  });
});

describe('builder and every client', () => {
  test('Security page: preview, apply, and the same identity in pages, AI tools, AutoREST, REST handlers and MCP', async () => {
    const b = await builder();
    const url = `/builder/sql/objects/security?o=${S}.pay`;
    const page = await b.get(url);
    assert.equal(page.statusCode, 200, page.body);
    assert.match(page.body, /Security of ds119\.pay/);
    assert.match(page.body, /runs hr/);
    assert.match(page.body, /using|own/);
    assert.match((await b.get(`/builder/sql/objects?schema=${S}&k=table&o=${S}.pay`)).body, /href="\/builder\/sql\/objects\/security\?o=ds119\.pay"/, 'the Object Browser links to it');
    // hr_app reads id and owner only; amount for managers, iban as *** + last 4 for everyone. The matrix lists every
    // application's role of the workspace, so find hr_app's row rather than assuming it is the first.
    const roles = [...page.body.matchAll(/<th scope="row"><code>([^<]+)<\/code>/g)].map((m) => m[1]);
    const g = roles.indexOf('hr_app');
    assert.ok(g >= 0, roles.join(', '));
    const form = {
      ref: `${S}.pay`, shown_roles: 'manager',
      [`g.${g}.s.0`]: 'on', [`g.${g}.s.1`]: 'on', [`g.${g}.u.1`]: 'on',
      view: 'on', view_name: 'pay_masked', roles: 'manager',
      'm.2.mask': 'null', 'm.2.see.0': 'on', 'm.3.mask': 'partial',
    };
    const preview = await b.submit('/builder/sql/objects/security', { ...form, mode: 'preview' });
    assert.equal(preview.statusCode, 200);
    assert.match(preview.body, /revoke select on &quot;ds119&quot;\.&quot;pay&quot; from &quot;hr_app&quot;|revoke select on "ds119"\."pay" from "hr_app"/);
    assert.match(preview.body, /create view/);
    assert.equal((await owner.query(`select from pg_class where relname = 'pay_masked'`)).rowCount, 0, 'a preview changes nothing');
    const applied = await b.submit('/builder/sql/objects/security', { ...form, mode: 'apply' });
    assert.equal(applied.statusCode, 303, applied.body);
    const priv = (col: string, p = 'select') => owner.one(`select has_column_privilege('hr_app', '${S}.pay', $1, $2) as ok`, [col, p]).then((r) => r.ok);
    assert.equal(await priv('amount'), false);
    assert.equal(await priv('owner'), true);
    assert.equal(await priv('owner', 'update'), true);
    assert.equal(await priv('amount', 'update'), false);
    assert.match((await owner.one(`select count(*)::int as n from meta.change_set where name = 'security_pay'`)).n.toString(), /^[1-9]/, 'recorded in the change log');
    assert.match((await b.get(url)).body, /No changes: the table's security is as the form shows it|masked/);

    // pages and AI tools: appTx as the signed-in user (row level security inside the view too)
    const session = async (user: string, roles: string[]) =>
      (await owner.one(`insert into meta.session (token_hash, app_id, username, roles) values ('ds119-' || gen_random_uuid(), $1, $2, $3) returning id`, [appId, user, roles])).id as string;
    const sessions: Record<string, string> = { allen: await session('allen', []), king: await session('king', ['admin', 'manager']) };
    const asUser = (user: string) => appTx({ appId, alias: 'hr', dbRole: 'hr_app', appUser: user, sessionId: sessions[user] }, async (c) => (await c.query(`select id, amount, iban from ${S}.pay_masked order by id`)).rows);
    assert.deepEqual(await asUser('allen'), [{ id: 2, amount: null, iban: '***4567' }]);
    assert.deepEqual((await asUser('king')).map((r) => [r.id, r.amount, r.iban]), [[1, '5000', '***4300'], [2, '1600', '***4567']]);
    await assert.rejects(appTx({ appId, alias: 'hr', dbRole: 'hr_app', appUser: 'king', sessionId: sessions.king }, (c) => c.query(`select amount from ${S}.pay`)), /permission denied/);

    // AutoREST of the view and of the table
    for (const [name, alias] of [['pay_masked', 'paym'], ['pay', 'payraw']])
      await owner.query(`insert into meta.rest_object (app_id, schema_name, object_name, alias, methods, auth, roles) values ($1, $2, $3, $4, '{GET}', 'token', '{}')`, [appId, S, name, alias]);
    const ar = (path: string, who: string) => app.inject({ method: 'GET', url: `/a/hr/autorest/${path}`, headers: { authorization: `Bearer ${token[who]}` } });
    const allenRest = await ar('paym/', 'allen');
    assert.equal(allenRest.statusCode, 200, allenRest.body);
    assert.deepEqual(allenRest.json().items.map((r: any) => [r.id, r.amount, r.iban]), [[2, null, '***4567']]);
    assert.notEqual((await ar('paym/', 'king')).json().items[0].amount, null, 'a manager sees the amount');
    const raw = await ar('payraw/', 'king');
    assert.ok(raw.statusCode !== 200 || raw.json().items.every((r: any) => !('amount' in r)), 'the table itself never shows the revoked column');

    // a REST handler
    await owner.query(`insert into meta.rest_module (app_id, name, title, roles, handlers) values ($1, 'm119', 'M119', '{}', $2)`,
      [appId, JSON.stringify([{ method: 'GET', path: 'pay', type: 'collection', source: `select id, amount from ${S}.pay_masked order by id` }])]);
    const handler = (who: string) => app.inject({ method: 'GET', url: '/a/hr/rest/m119/pay', headers: { authorization: `Bearer ${token[who]}` } });
    const h = await handler('allen');
    assert.equal(h.statusCode, 200, h.body);
    assert.deepEqual(h.json().items, [{ id: 2, amount: null }]);
    assert.notEqual((await handler('king')).json().items[0].amount, null);

    // the MCP server's run_query, scoped to the application and a user
    const { readOnlyQuery, queryIdentity } = await import('../src/cli/mcp.ts');
    const { withDb } = await import('../src/cli/apps.ts');
    await withDb(async (db) => {
      const q = `select id, amount from ${S}.pay_masked order by id`;
      assert.deepEqual((await readOnlyQuery(db, q, 10, await queryIdentity(db, 'hr', 'allen'))).rows, [{ id: 2, amount: null }]);
      assert.equal((await readOnlyQuery(db, q, 10, await queryIdentity(db, 'hr', 'king'))).rows.length, 2);
      assert.deepEqual((await readOnlyQuery(db, q, 10, await queryIdentity(db, 'hr', undefined))).rows, [], 'nobody: no rows under the policy');
      await assert.rejects(readOnlyQuery(db, `select amount from ${S}.pay`, 10, await queryIdentity(db, 'hr', 'king')), /permission denied/);
      assert.equal((await readOnlyQuery(db, `select amount from ${S}.pay`, 10)).rows.length, 2, 'without an identity: the owner');
      await assert.rejects(queryIdentity(db, 'no_such_app', 'king'), /no application/);
    });

    // switching the view off drops it; the column privileges stay as they are
    const off = await b.submit('/builder/sql/objects/security', { ref: `${S}.pay`, shown_roles: 'manager', [`g.${g}.s.0`]: 'on', [`g.${g}.s.1`]: 'on', [`g.${g}.u.1`]: 'on', view_name: 'pay_masked', roles: 'manager', mode: 'apply' });
    assert.equal(off.statusCode, 303, off.body);
    assert.equal((await owner.query(`select from pg_class where relname = 'pay_masked' and relnamespace = '${S}'::regnamespace`)).rowCount, 0);
    assert.equal(await priv('amount'), false);
  });
});
