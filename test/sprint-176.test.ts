// Sprint 176 (parity leftover DA-3; migration 158): share links for query results. The worksheet's Query Result has
// Share: the SELECT is kept behind a random token (meta.sql_share) and /builder/sql/shared/<token> runs it again,
// read-only, for a developer of the same workspace. The maker (or an administrator) renames, extends and stops it.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { MAX_SHARES, shareTitle, shareToken } from '../src/builder/sql-shares.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
const S = 'sh176';
const DEV = 'sh176_dev';
const PW = 'Sh176-dev-password!';
const SQL = `select region, amount from ${S}.sale order by region`;

const clean = async () => {
  await owner.query(`delete from meta.sql_share where created_by in ('admin', $1) and (sql like '%sh176%' or title like 'sh176%')`, [DEV]);
  await owner.query(`delete from meta.developer where username = $1`, [DEV]);
};
before(async () => {
  app = await buildApp({ logger: false });
  await owner.query(`drop schema if exists ${S} cascade; create schema ${S}; create table ${S}.sale (region text, amount numeric);
    insert into ${S}.sale values ('North', 100), ('South', 250.5), ('West', null)`);
  await clean();
  await owner.query(`insert into meta.developer (username, password_hash, is_admin) values ($1, meta.hash_password($2), false)`, [DEV, PW]);
});
after(async () => {
  await clean();
  await owner.query(`drop schema if exists ${S} cascade`);
  await app.close();
  await closePools();
});
const builder = async (username = 'admin', password = 'admin') => {
  const b = new Browser(app);
  await b.get('/builder/login');
  assert.equal((await b.submit('/builder/login', { username, password })).statusCode, 303);
  await b.get('/builder/sql/worksheet');
  return b;
};
const share = async (b: Browser, query = SQL, extra: Record<string, string> = {}) => {
  const res = await b.submit('/builder/sql/shared', { query, ...extra });
  assert.equal(res.statusCode, 303);
  return String(res.headers.location);
};

describe('share links for query results (DA-3)', () => {
  test('a token is 32 URL-safe characters, never the same twice; a title is the query on one line', () => {
    const a = shareToken();
    assert.match(a, /^[A-Za-z0-9_-]{32}$/);
    assert.notEqual(a, shareToken());
    assert.equal(shareTitle('select 1\n  from x'), 'select 1 from x');
    assert.equal(shareTitle(`select ${'x'.repeat(200)}`).length, 80);
  });

  test('the worksheet offers Share for a SELECT; the link shows the result, the query and its own address', async () => {
    const b = await builder();
    const page = (await b.submit('/builder/sql/worksheet', { sql: SQL, mode: 'statement' })).body;
    assert.match(page, /<button class="btn btn-sm" form="ws-dl" formaction="\/builder\/sql\/shared"/);
    assert.match(page, /href="\/builder\/sql\/shared"/, 'the list is in the worksheet\'s menu');
    const dml = (await b.submit('/builder/sql/worksheet', { sql: `update ${S}.sale set amount = amount returning region`, mode: 'statement' })).body;
    assert.doesNotMatch(dml, /formaction="\/builder\/sql\/shared"/, 'not one SELECT: nothing to share');
    const to = await share(b);
    assert.match(to, /^\/builder\/sql\/shared\/[A-Za-z0-9_-]{32}$/);
    const row = (await owner.one(`select title, sql, created_by, round(extract(epoch from expires_at - created_at) / 86400)::int as days from meta.sql_share where token = $1`, [to.split('/').pop()]))!;
    assert.deepEqual(row, { title: SQL, sql: SQL, created_by: 'admin', days: 7 });
    const res = await b.get(to);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['referrer-policy'], 'same-origin', 'the token is not sent to another site');
    assert.match(String(res.headers['cache-control']), /no-store/);
    assert.match(res.body, /<td>North<\/td><td class="num">100<\/td>/);
    assert.match(res.body, /<td>West<\/td><td class="num"><span class="null">\(null\)<\/span><\/td>/);
    assert.match(res.body, new RegExp(`readonly value="[^"]*${to}"`));
    assert.match(res.body, /Shared by admin on /);
    // the rows are read when the link opens, not when it was made
    await owner.query(`insert into ${S}.sale values ('East', 5)`);
    assert.match((await b.get(to)).body, /<td>East<\/td>/);
    await owner.query(`delete from ${S}.sale where region = 'East'`);
  });

  test('a name and a number of days when sharing; the maker renames and extends, opens it in the worksheet and stops it', async () => {
    const b = await builder();
    const to = await share(b, `${SQL};`, { title: 'sh176 sales', days: '30' });
    const token = to.split('/').pop();
    const days = async () => (await owner.one(`select round(extract(epoch from expires_at - now()) / 86400)::int as d from meta.sql_share where token = $1`, [token]))?.d;
    assert.equal(await days(), 30);
    assert.match((await b.get('/builder/sql/shared')).body, new RegExp(`<a href="${to}">sh176 sales</a>`));
    await b.get(to);
    await b.submit(to, { action: 'save', title: 'sh176 renamed', days: '' });
    assert.equal(await days(), 30, 'the end stays without a choice');
    await b.submit(to, { action: 'save', title: 'sh176 renamed', days: '1' });
    assert.equal(await days(), 1);
    assert.match((await b.get(to)).body, /<h1 class="u-mb1">sh176 renamed<\/h1>/);
    assert.equal((await b.submit(to, { action: 'save', title: ' ' })).statusCode, 303);
    assert.equal((await owner.one('select title from meta.sql_share where token = $1', [token]))!.title, 'sh176 renamed', 'an empty name is refused');
    const open = await b.submit(to, { action: 'worksheet' });
    assert.equal(open.headers.location, '/builder/sql/worksheet');
    assert.match((await b.get('/builder/sql/worksheet')).body, new RegExp(`select region, amount from ${S}\\.sale order by region`));
    await b.get(to);
    assert.equal((await b.submit(to, { action: 'stop' })).headers.location, '/builder/sql/shared');
    assert.equal((await b.get(to)).statusCode, 404);
  });

  test('another developer of the workspace reads it and opens it in the worksheet, but cannot change or stop it', async () => {
    const admin = await builder();
    const to = await share(admin, SQL, { title: 'sh176 for others' });
    const dev = await builder(DEV, PW);
    const page = await dev.get(to);
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /<td>South<\/td>/);
    assert.doesNotMatch(page.body, /value="stop"|name="title"/, 'no controls for a reader');
    assert.equal((await dev.submit(to, { action: 'worksheet' })).headers.location, '/builder/sql/worksheet');
    assert.equal((await dev.submit(to, { action: 'stop' })).statusCode, 403);
    assert.equal((await dev.submit(to, { action: 'save', title: 'sh176 taken' })).statusCode, 403);
    assert.equal((await owner.one('select title from meta.sql_share where token = $1', [to.split('/').pop()]))!.title, 'sh176 for others');
    const list = (await dev.get('/builder/sql/shared')).body;
    assert.match(list, /sh176 for others/);
    // the developer's own link: theirs to stop, and the administrator's too
    const own = await share(dev, SQL, { title: 'sh176 by dev' });
    await admin.get(own);
    assert.equal((await admin.submit(own, { action: 'stop' })).statusCode, 303);
    assert.equal((await dev.get(own)).statusCode, 404);
  });

  test('an ended link, an unknown token and a statement that is not one SELECT', async () => {
    const b = await builder();
    const to = await share(b, SQL, { title: 'sh176 ended' });
    await owner.query(`update meta.sql_share set expires_at = now() - interval '1 second' where token = $1`, [to.split('/').pop()]);
    assert.equal((await b.get(to)).statusCode, 404);
    assert.doesNotMatch((await b.get('/builder/sql/shared')).body, /sh176 ended/);
    assert.equal((await b.get(`/builder/sql/shared/${'a'.repeat(32)}`)).statusCode, 404);
    assert.equal((await b.get('/builder/sql/shared/short')).statusCode, 404);
    // sharing again removes the ended ones
    await share(b, SQL, { title: 'sh176 fresh' });
    assert.equal(await owner.one(`select 1 as x from meta.sql_share where title = 'sh176 ended'`), undefined);
    const count = async () => (await owner.one(`select count(*)::int as n from meta.sql_share`))!.n;
    const before = await count();
    for (const query of [`delete from ${S}.sale`, 'select 1; select 2', '', `select ${'1'.repeat(20001)}`]) {
      const res = await b.submit('/builder/sql/shared', { query });
      assert.equal(res.headers.location, '/builder/sql/worksheet', query.slice(0, 30));
    }
    assert.equal(await count(), before, 'nothing was shared');
    // a query that fails now says so on the link's page
    const gone = await share(b, `select * from ${S}.nothing_here`, { title: 'sh176 gone' });
    const page = await b.get(gone);
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /class="alert alert-error">[^<]*nothing_here/);
    assert.ok(MAX_SHARES >= 100);
  });
});
