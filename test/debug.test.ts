// Sprint 33 item 4: debug messages (meta.debug, per-request entries with
// timings, the builder viewer, retention) and the install/upgrade log.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner, runtime } from '../src/db.ts';
import { migrate } from '../src/migrate.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
const alias = 'dbg-s33';
const ROLE = 'pgkiln_dbg_s33';
const SCHEMA = 'dbg_s33';

/** The debug views of the test app (the log is stored after the response: wait for it). */
async function views(min = 1) {
  for (let i = 0; i < 50; i++) {
    const rows = (await owner.query('select * from meta.debug_view where app_id = $1 order by id', [appId])).rows;
    if (rows.length >= min) return rows;
    await new Promise((r) => setTimeout(r, 40));
  }
  return (await owner.query('select * from meta.debug_view where app_id = $1 order by id', [appId])).rows;
}
/** The latest view of a request method (a previous request's log may still be on its way). */
async function viewOf(method: 'GET' | 'POST') {
  for (let i = 0; i < 50; i++) {
    const v = (await owner.query('select * from meta.debug_view where app_id = $1 and method = $2 order by id desc limit 1', [appId, method])).rows[0];
    if (v) return v;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`no ${method} debug view`);
}
const settle = () => new Promise((r) => setTimeout(r, 150));
const messages = async (viewId: string) =>
  (await owner.query('select * from meta.debug_message where view_id = $1 order by seq', [viewId])).rows as { level: number; component: string; message: string; elapsed_ms: string; duration_ms: string | null }[];
const level = (n: number) => owner.query('update meta.app set debug_level = $2 where id = $1', [appId, n]);
const clear = () => owner.query('delete from meta.debug_view where app_id = $1', [appId]);

before(async () => {
  app = await buildApp({ logger: false });
  await owner.query(`drop schema if exists ${SCHEMA} cascade`);
  await owner.query(`drop role if exists ${ROLE}`);
  await owner.query(`create role ${ROLE} nologin`);
  await owner.query(`grant ${ROLE} to pgkiln_runtime`);
  await owner.query(`create schema ${SCHEMA}`);
  await owner.query(`grant usage on schema ${SCHEMA} to ${ROLE}`);
  await owner.query(`create table ${SCHEMA}.log (msg text)`);
  await owner.query(`grant select, insert on ${SCHEMA}.log to ${ROLE}`);
  appId = (await owner.one(`insert into meta.app (alias, name, authentication, db_role) values ($1, 'Debug test', 'none', $2) returning id`, [alias, ROLE])).id;
  const pageId = (await owner.one(`insert into meta.page (app_id, page_no, name, requires_auth) values ($1, 1, 'Home', false) returning id`, [appId])).id;
  const regionId = (await owner.one(`insert into meta.region (page_id, seq, title, type, source) values ($1, 10, 'Form', 'static', '<p>Hello</p>') returning id`, [pageId])).id;
  await owner.query(`insert into meta.region (page_id, seq, title, type, source) values ($1, 20, 'Numbers', 'report', 'select n from generate_series(1, 3) n')`, [pageId]);
  await owner.query(`insert into meta.item (page_id, region_id, seq, name, label, type) values ($1, $2, 1, 'P1_NAME', 'Name', 'text'), ($1, $2, 2, 'P1_SECRET', 'Secret', 'password')`, [pageId, regionId]);
  await owner.query(`insert into meta.button (page_id, region_id, name, label) values ($1, $2, 'SAVE', 'Save'), ($1, $2, 'FAIL', 'Fail')`, [pageId, regionId]);
  await owner.query(
    `insert into meta.process (page_id, seq, name, type, point, code, when_button) values
       ($1, 1, 'Load note', 'sql', 'load', $2, null), ($1, 2, 'Plain notice', 'sql', 'load', $3, null),
       ($1, 3, 'Save', 'sql', 'submit', $4, 'SAVE'), ($1, 4, 'Fail', 'sql', 'submit', $5, 'FAIL')`,
    [pageId,
     "select meta.debug(2, 'loading for ' || meta.app_user()), meta.debug(6, 'trace detail')",
     "do $do$ begin raise notice 'a plain notice'; end $do$",
     `insert into ${SCHEMA}.log values ('saved ' || :P1_NAME); select meta.debug('saving ' || :P1_NAME)`,
     "select meta.debug(1, 'about to fail'); select 1/0"],
  );
});

after(async () => {
  await owner.query('delete from meta.app where id = $1', [appId]);
  await owner.query(`drop schema if exists ${SCHEMA} cascade`);
  await owner.query(`drop role if exists ${ROLE}`);
  await app.close();
  await closePools();
});

describe('meta.debug and per-request debug entries', () => {
  test('debug off: nothing is recorded and meta.debug() is a no-op', async () => {
    await level(0);
    await clear();
    const b = new Browser(app);
    const res = await b.get(`/a/${alias}/1`);
    assert.equal(res.statusCode, 200);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal((await owner.query('select 1 from meta.debug_view where app_id = $1', [appId])).rowCount, 0);
    // outside a request (no setting) the functions return at once
    const r = await runtime.one(`select meta.debug_level() as l, meta.debug_enabled(1) as e, meta.debug(1, 'x')::text as d`);
    assert.deepEqual([r.l, r.e], [0, false]);
  });

  test('level 9: steps with timings, regions, meta.debug messages and notices', async () => {
    await level(9);
    await clear();
    const b = new Browser(app);
    assert.equal((await b.get(`/a/${alias}/1?q=x`)).statusCode, 200);
    const [v] = await views();
    assert.equal(v.method, 'GET');
    assert.equal(v.path, `/a/${alias}/1`, 'the path without the query string');
    assert.equal(v.page_no, 1);
    assert.equal(v.status, 200);
    assert.equal(v.level, 9);
    assert.ok(Number(v.elapsed_ms) > 0);
    const m = await messages(v.id);
    assert.equal(v.entries, m.length);
    const text = m.map((e) => `${e.level} ${e.component}: ${e.message}`).join('\n');
    assert.match(text, /4 request: GET \/a\/dbg-s33\/1 \(parameters: q\)/);
    assert.match(text, /4 page: render page/);
    assert.match(text, /6 region: region "Numbers" \(report\)/);
    assert.match(text, /6 process: process "Load note" \(sql\)/);
    assert.match(text, /2 meta\.debug: loading for nobody/);
    assert.match(text, /6 meta\.debug: trace detail/);
    assert.match(text, /9 sql: notice: a plain notice/);
    assert.match(text, /4 response: status 200/);
    // timed steps carry a duration; elapsed times only go up
    assert.ok(m.find((e) => e.message === 'render page')!.duration_ms !== null);
    const elapsed = m.map((e) => Number(e.elapsed_ms));
    assert.deepEqual(elapsed, [...elapsed].sort((x, y) => x - y));
    assert.ok(!text.includes('=x'), 'URL values are not recorded');
  });

  test('a submit records posted values at level 9, never password values', async () => {
    await clear();
    const b = new Browser(app);
    await b.get(`/a/${alias}/1`);
    await settle();
    await clear();
    const res = await b.submit(`/a/${alias}/1`, { __request: 'SAVE', P1_NAME: 'Ann', P1_SECRET: 's3cret-value' });
    assert.equal(res.statusCode, 303);
    const v = await viewOf('POST');
    const m = await messages(v.id);
    const text = m.map((e) => e.message).join('\n');
    assert.match(text, /P1_NAME posted: "Ann"/);
    assert.match(text, /P1_SECRET posted: \(password, not shown\)/);
    assert.match(text, /saving Ann/);
    assert.match(text, /button SAVE/);
    const all = JSON.stringify(await owner.query('select v.*, m.* from meta.debug_view v join meta.debug_message m on m.view_id = v.id where v.app_id = $1', [appId]));
    assert.ok(!all.includes('s3cret-value'), 'the password is nowhere in the debug tables');
  });

  test('a failing process: the error and the messages before it are kept although the transaction rolls back', async () => {
    const b = new Browser(app);
    await b.get(`/a/${alias}/1`);
    await settle();
    await clear();
    const res = await b.submit(`/a/${alias}/1`, { __request: 'FAIL', P1_NAME: 'Bob' });
    assert.equal(res.statusCode, 422);
    const post = await viewOf('POST');
    assert.equal(post.status, 422);
    const m = await messages(post.id);
    assert.ok(m.some((e) => e.level === 1 && e.component === 'meta.debug' && e.message === 'about to fail'));
    assert.ok(m.some((e) => e.level === 1 && e.component === 'error' && /division by zero/.test(e.message)));
    assert.ok(m.some((e) => e.level === 1 && e.component === 'process' && /rolled back/.test(e.message)));
  });

  test('level 4 leaves out trace entries and item values', async () => {
    await level(4);
    const b = new Browser(app);
    await b.get(`/a/${alias}/1`);
    await settle();
    await clear();
    await b.submit(`/a/${alias}/1`, { __request: 'SAVE', P1_NAME: 'Cy' });
    const v = await viewOf('POST');
    const m = await messages(v.id);
    assert.ok(m.every((e) => e.level <= 4));
    assert.ok(m.some((e) => e.message === 'saving Cy'));
    assert.ok(!m.some((e) => /posted/.test(e.message)));
    await settle();
    await clear();
    await b.get(`/a/${alias}/1`);
    const g = await viewOf('GET');
    const text = (await messages(g.id)).map((e) => e.message).join('\n');
    assert.ok(text.includes('loading for nobody'));
    assert.ok(!text.includes('trace detail'), 'meta.debug(6, …) is above level 4');
    assert.ok(!/region "Numbers"/.test(text));
  });

  test('meta.debug_save only stores for an application in debug, and purges by retention', async () => {
    // saved as recent (a purge running meanwhile would take an old one), aged below
    await level(0);
    const none = await runtime.one(`select meta.debug_save($1, 1, 'u', null, 'GET', '/x', 200, 9, now(), 1, '[]') as id`, [appId]);
    assert.equal(none.id, null);
    await level(9);
    const id = (await runtime.one(`select meta.debug_save($1, 1, 'u', null, 'GET', '/x', 200, 9, now(), 1, $2::jsonb) as id`, [appId, JSON.stringify([{ ms: 1, level: 99, component: 'c', text: 'x'.repeat(5000) }])])).id;
    const m = await messages(id);
    assert.equal(m[0].level, 9, 'levels are clamped to 1–9');
    assert.equal(m[0].message.length, 4000, 'texts are cut at 4000 characters');
    await owner.query(`update meta.debug_view set started_at = now() - interval '30 days' where id = $1`, [id]);
    await owner.query('update meta.app set debug_retention_days = 7 where id = $1', [appId]);
    assert.ok((await runtime.one('select meta.debug_purge() as n')).n >= 1);
    assert.equal((await owner.query('select 1 from meta.debug_view where id = $1', [id])).rowCount, 0);
  });
});

describe('builder: debug viewer and installation log', () => {
  let b: Browser;
  before(async () => {
    b = new Browser(app);
    await b.get('/builder/login');
    await b.post('/builder/login', { __csrf: b.lastCsrf, username: 'admin', password: 'admin' });
  });

  test('the list, a page view and the level settings', async () => {
    await level(9);
    await clear();
    await new Browser(app).get(`/a/${alias}/1`);
    const [v] = await views();
    const list = await b.get(`/builder/apps/${appId}/debug`);
    assert.equal(list.statusCode, 200);
    assert.match(list.body, new RegExp(`/builder/apps/${appId}/debug/${v.id}`));
    assert.match(list.body, /Debug messages are on \(level 9\)/);
    const one = await b.get(`/builder/apps/${appId}/debug/${v.id}`);
    assert.equal(one.statusCode, 200);
    assert.match(one.body, /loading for nobody/);
    assert.match(one.body, /render page/);
    // filtered by page; another page shows nothing
    assert.match((await b.get(`/builder/apps/${appId}/debug?page=2`)).body, /No page views recorded for this filter/);
    // settings
    await b.get(`/builder/apps/${appId}/debug`);
    assert.equal((await b.submit(`/builder/apps/${appId}/debug/settings`, { debug_level: '6', debug_retention_days: '14' })).statusCode, 303);
    const a = await owner.one('select debug_level, debug_retention_days from meta.app where id = $1', [appId]);
    assert.deepEqual([a.debug_level, a.debug_retention_days], [6, 14]);
    await b.get(`/builder/apps/${appId}/debug`);
    await b.submit(`/builder/apps/${appId}/debug/settings`, { debug_level: '5', debug_retention_days: '14' });
    assert.equal((await owner.one('select debug_level from meta.app where id = $1', [appId])).debug_level, 6, 'level 5 is refused');
    // purge
    await b.get(`/builder/apps/${appId}/debug`);
    await b.submit(`/builder/apps/${appId}/debug/purge`, {});
    assert.equal((await owner.query('select 1 from meta.debug_view where app_id = $1', [appId])).rowCount, 0);
  });

  test('the installation page lists runs, migrations and the version', async () => {
    const res = await b.get('/builder/installation');
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /051_debug_messages\.sql/);
    assert.match(res.body, /pgkiln version of this server/);
    assert.match((await b.get('/builder/utilities')).body, /\/builder\/installation/);
  });

  test('migrate() logs a run that applies files, and a failed one with its error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pgkiln-mig-'));
    const tag = `zz_dbg_s33_${process.pid}`;
    try {
      mkdirSync(join(dir, 'db/migrations'), { recursive: true });
      mkdirSync(join(dir, `examples/${tag}`), { recursive: true });
      writeFileSync(join(dir, `examples/${tag}/${tag}_1.sql`), 'select 1;');
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '9.9.9-test' }));
      await migrate({ root: dir, example: tag, log: () => {} });
      writeFileSync(join(dir, `examples/${tag}/${tag}_2.sql`), 'select 1/0;');
      await assert.rejects(migrate({ root: dir, example: tag, log: () => {} }), /division by zero/);
      const runs = (await owner.query(`select * from public.pgkiln_install_log where version = '9.9.9-test' order by id`)).rows;
      assert.equal(runs.length, 2);
      assert.deepEqual([runs[0].kind, runs[0].status, runs[0].applied], ['upgrade', 'ok', [`examples/${tag}/${tag}_1.sql`]]);
      assert.equal(runs[1].status, 'failed');
      assert.match(runs[1].error, new RegExp(`${tag}_2\\.sql: division by zero`));
    } finally {
      await owner.query(`delete from public.pgkiln_seed where name like $1`, [`${tag}%`]);
      await owner.query(`delete from public.pgkiln_install_log where version = '9.9.9-test'`);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
