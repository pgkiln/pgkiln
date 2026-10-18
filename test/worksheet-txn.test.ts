// Sprint 107 (Database Actions DA-2): transaction mode in the SQL Worksheet. With Transaction on, a worksheet
// tab keeps its own connection with an open transaction between runs: a SELECT in the same tab sees its
// changes, another session doesn't; Commit and Rollback end it, so do COMMIT / ROLLBACK typed in the editor;
// an error leaves it aborted; an idle timeout rolls it back and the worksheet says so.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { accountRun, findTxn, openTxnCount, outsideTxnOnly, sweepTxns, txnIdleSeconds, type WorksheetTxn } from '../src/worksheet-txn.ts';
import { txnBadge } from '../src/builder/worksheet.ts';
import { Browser } from './helpers.ts';

const S = 'wstx107';
let app: FastifyInstance;

before(async () => {
  app = await buildApp({ logger: false });
  await owner.query(`drop schema if exists ${S} cascade`);
  await owner.query(`create schema ${S}`);
  await owner.query(`create table ${S}.emp (id int primary key, ename text, sal numeric)`);
  await owner.query(`insert into ${S}.emp values (1, 'KING', 5000), (2, 'BLAKE', 2850)`);
});
after(async () => {
  await owner.query(`drop schema if exists ${S} cascade`);
  await app.close();
  await closePools();
});

const builder = async () => {
  const b = new Browser(app);
  await b.get('/builder/login');
  assert.equal((await b.submit('/builder/login', { username: 'admin', password: 'admin' })).statusCode, 303);
  await b.get('/builder/sql/worksheet');
  return b;
};
/** A run in transaction mode (txn=1) or Autocommit, in worksheet tab `tab`. */
const run = (b: Browser, tab: string, sql: string, extra: Record<string, string> = {}) =>
  b.submit('/builder/sql/worksheet', { sql, mode: 'statement', sel_start: '0', sel_end: '0', ws_tab: tab, txn: 'on', ...extra }).then((r) => r.body);
const sal = async () => Number((await owner.one(`select sal from ${S}.emp where id = 1`)).sal);
const badgeOf = (page: string) => /data-ws-txn-badge data-state="(\w+)"[^>]*>([^<]*)</.exec(page)?.slice(1);

describe('worksheet transactions: pieces', () => {
  test('statements PostgreSQL refuses inside a transaction are recognised', () => {
    for (const s of ['vacuum', 'VACUUM ANALYZE t', '-- c\nalter system set work_mem = 1', 'create database x', 'create index concurrently i on t (a)', 'create unique index concurrently on t (a)',
      'drop index concurrently i', 'reindex table concurrently t', 'alter table t detach partition p concurrently', 'prepare transaction \'x\''])
      assert.ok(outsideTxnOnly(s), s);
    for (const s of ['select 1', 'create index i on t (a)', 'update vacuum_log set a = 1', 'alter table t detach partition p', 'refresh materialized view concurrently m'])
      assert.ok(!outsideTxnOnly(s), s);
  });
  test('a run counts its statements and keeps DDL until COMMIT; ROLLBACK drops it', () => {
    const t = { statements: 0, pendingDdl: [] } as unknown as WorksheetTxn;
    assert.deepEqual(accountRun(t, [{ status: 'ok', sql: 'create table a (x int)', tag: 'CREATE TABLE' }, { status: 'ok', sql: 'insert into a values (1)', tag: 'INSERT 0 1' }, { status: 'error', sql: 'x' }]), []);
    assert.equal(t.statements, 2);
    assert.deepEqual(t.pendingDdl, ['create table a (x int)']);
    assert.deepEqual(accountRun(t, [{ status: 'ok', sql: 'rollback to savepoint s', tag: 'ROLLBACK' }]), []);
    assert.equal(t.pendingDdl.length, 1, 'ROLLBACK TO SAVEPOINT keeps the transaction');
    assert.deepEqual(accountRun(t, [{ status: 'ok', sql: 'create view v as select 1', tag: 'CREATE VIEW' }, { status: 'ok', sql: 'commit', tag: 'COMMIT' }, { status: 'ok', sql: 'create table b (x int)', tag: 'CREATE TABLE' }]),
      ['create table a (x int)', 'create view v as select 1']);
    assert.deepEqual(t.pendingDdl, ['create table b (x int)']);
    accountRun(t, [{ status: 'ok', sql: 'rollback', tag: 'ROLLBACK' }]);
    assert.deepEqual(t.pendingDdl, []);
    assert.equal(t.statements, 0);
  });
  test('the badge', () => {
    assert.equal(txnBadge('none', 0, null, null), 'No open transaction');
    assert.equal(txnBadge('open', 1, Date.now(), null), 'Transaction open · 1 statement · under a minute');
    assert.equal(txnBadge('aborted', 3, Date.now() - 125_000, null), 'Transaction failed · 3 statements · 2 min');
    assert.equal(txnBadge('none', 0, null, 'Rolled back.'), 'Rolled back.');
  });
});

describe('worksheet transactions', () => {
  test('the toolbar has the mode, the badge, Commit and Rollback (hidden without JavaScript)', async () => {
    const b = await builder();
    const page = (await b.get('/builder/sql/worksheet')).body;
    assert.match(page, /<span class="ws-txn" data-ws-txn data-state="none"[^>]* hidden>/);
    assert.match(page, /<select name="txn" data-ws-txn-mode[^>]*>\s*<option value="">Autocommit<\/option><option value="on">Transaction<\/option>/);
    assert.match(page, /value="commit" data-ws-txn-commit[^>]* disabled>/);
    assert.match(page, /Each statement commits on its own\./);
  });

  test('done-when: an UPDATE stays in the tab\'s transaction, a SELECT there sees it, another session doesn\'t, Rollback undoes it', async () => {
    const b = await builder();
    const before = await sal();
    const p1 = await run(b, 'tx1', `update ${S}.emp set sal = sal + 1 where id = 1`);
    assert.match(p1, /UPDATE 1/);
    assert.deepEqual(badgeOf(p1), ['open', 'Transaction open · 1 statement · under a minute']);
    assert.match(p1, /<option value="on" selected>Transaction<\/option>/);
    assert.match(p1, /value="commit" data-ws-txn-commit[^>]*>(?!.*disabled)/);
    assert.match(p1, /The statements stay in one transaction until Commit or Rollback; it is rolled back after 5 minutes without a run\./);
    const p2 = await run(b, 'tx1', `select sal from ${S}.emp where id = 1`);
    assert.match(p2, new RegExp(`<td class="num">${before + 1}\\.?0*</td>`), 'the same tab sees its change');
    assert.equal(badgeOf(p2)![1], 'Transaction open · 2 statements · under a minute');
    assert.equal(await sal(), before, 'another session does not');
    // another tab of the same developer is another transaction
    const other = await run(b, 'tx2', `select sal from ${S}.emp where id = 1`);
    assert.match(other, new RegExp(`<td class="num">${before}\\.?0*</td>`));
    await b.submit('/builder/sql/worksheet', { sql: '', mode: 'rollback', ws_tab: 'tx2', txn: 'on' });
    // the badge after a reload: the server's state
    const status = JSON.parse((await b.get('/builder/sql/worksheet/txn?tab=tx1')).body);
    assert.equal(status.state, 'open');
    assert.equal(status.statements, 2);
    const rb = (await b.submit('/builder/sql/worksheet', { sql: 'select 1', mode: 'rollback', ws_tab: 'tx1', txn: 'on' })).body;
    assert.match(rb, /Rolled back \(2 statements undone\)\./);
    assert.deepEqual(badgeOf(rb), ['none', 'No open transaction']);
    assert.equal(await sal(), before);
    assert.equal(findTxn('x', 'tx1'), undefined);
    assert.equal(openTxnCount('admin'), 0);
  });

  test('Commit keeps the changes; Run Script runs in the transaction too', async () => {
    const b = await builder();
    const before = await sal();
    const p = (await b.submit('/builder/sql/worksheet', { sql: `update ${S}.emp set sal = sal + 10 where id = 1;\nupdate ${S}.emp set sal = sal + 10 where id = 1`, mode: 'script', ws_tab: 'tx3', txn: 'on' })).body;
    assert.equal(badgeOf(p)![1], 'Transaction open · 2 statements · under a minute');
    assert.equal(await sal(), before);
    const c = (await b.submit('/builder/sql/worksheet', { sql: '', mode: 'commit', ws_tab: 'tx3', txn: 'on' })).body;
    assert.match(c, /Committed \(2 statements\)\./);
    assert.equal(await sal(), before + 20);
    assert.match((await b.submit('/builder/sql/worksheet', { sql: '', mode: 'commit', ws_tab: 'tx3', txn: 'on' })).body, /This worksheet has no open transaction\./);
  });

  test('COMMIT and ROLLBACK typed in the editor end the transaction; BEGIN inside it only warns', async () => {
    const b = await builder();
    const before = await sal();
    const p = (await b.submit('/builder/sql/worksheet', { sql: `begin;\nupdate ${S}.emp set sal = sal + 1 where id = 1;\ncommit`, mode: 'script', ws_tab: 'tx4', txn: 'on' })).body;
    assert.match(p, /there is already a transaction in progress/);
    assert.match(p, /The transaction ended with the COMMIT or ROLLBACK in the editor; the next run starts a new one\./);
    assert.deepEqual(badgeOf(p), ['none', 'No open transaction']);
    assert.equal(await sal(), before + 1);
    await run(b, 'tx4', `update ${S}.emp set sal = sal + 1 where id = 1`);
    const r = await run(b, 'tx4', 'rollback');
    assert.match(r, /ROLLBACK/);
    assert.equal(findTxn('none', 'tx4'), undefined);
    assert.equal(await sal(), before + 1);
    assert.equal(openTxnCount('admin'), 0);
  });

  test('a failing statement leaves the transaction aborted: Rollback is offered, COMMIT rolls back', async () => {
    const b = await builder();
    const before = await sal();
    await run(b, 'tx5', `update ${S}.emp set sal = sal + 1 where id = 1`);
    const e = await run(b, 'tx5', `select 1 / 0`);
    assert.match(e, /division by zero/);
    assert.deepEqual(badgeOf(e), ['aborted', 'Transaction failed · 1 statement · under a minute']);
    assert.match(e, /A statement failed, so the transaction is aborted: Rollback ends it/);
    assert.match(await run(b, 'tx5', 'select 1'), /current transaction is aborted/);
    const c = (await b.submit('/builder/sql/worksheet', { sql: '', mode: 'commit', ws_tab: 'tx5', txn: 'on' })).body;
    assert.match(c, /The transaction had failed, so COMMIT rolled it back: nothing was saved\./);
    assert.equal(await sal(), before);
  });

  test('done-when: idle past the timeout it is rolled back, and the worksheet says so', async () => {
    const b = await builder();
    const before = await sal();
    await run(b, 'tx6', `update ${S}.emp set sal = sal + 1 where id = 1`);
    await sweepTxns(Date.now() + 60_000);
    assert.equal(JSON.parse((await b.get('/builder/sql/worksheet/txn?tab=tx6')).body).state, 'open', 'not yet');
    await sweepTxns(Date.now() + txnIdleSeconds() * 1000 + 1000);
    assert.equal(await sal(), before);
    const st = JSON.parse((await b.get('/builder/sql/worksheet/txn?tab=tx6')).body);
    assert.equal(st.state, 'none');
    assert.match(st.badge, /The transaction was rolled back after 5 minutes without a run \(1 statement undone\)\./);
    // the page with this tab says so, and the next run says a new one started
    assert.match((await b.get('/builder/sql/worksheet?wstab=tx6')).body, /data-ws-txn-badge data-state="none"[^>]*>The transaction was rolled back after 5 minutes/);
    const again = await run(b, 'tx6', 'select 1');
    assert.match(again, /rolled back after 5 minutes without a run \(1 statement undone\)\. A new transaction started\./);
    await b.submit('/builder/sql/worksheet', { sql: '', mode: 'rollback', ws_tab: 'tx6', txn: 'on' });
  });

  test('Autocommit: a BEGIN left open is rolled back at the end of the run, with a warning', async () => {
    const b = await builder();
    const before = await sal();
    const p = (await b.submit('/builder/sql/worksheet', { sql: `begin;\nupdate ${S}.emp set sal = sal + 1 where id = 1`, mode: 'script', ws_tab: 'tx7' })).body;
    assert.match(p, /The transaction started with BEGIN was still open at the end of the run and was rolled back/);
    assert.equal(await sal(), before);
    // begin … commit in one run still works
    await b.submit('/builder/sql/worksheet', { sql: `begin;\nupdate ${S}.emp set sal = sal + 1 where id = 1;\ncommit`, mode: 'script', ws_tab: 'tx7' });
    assert.equal(await sal(), before + 1);
  });

  test('refusals: Autocommit over an open transaction, another Run as, VACUUM, no tab', async () => {
    const b = await builder();
    await run(b, 'tx8', `update ${S}.emp set sal = sal where id = 1`);
    assert.match((await b.submit('/builder/sql/worksheet', { sql: 'select 1', mode: 'statement', ws_tab: 'tx8' })).body, /This worksheet has an open transaction: Commit or Rollback it first/);
    const hr = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
    assert.match(await run(b, 'tx8', 'select 1', { as_app: String(hr) }), /This worksheet&#39;s transaction runs as the builder&#39;s owner connection: Commit or Rollback it before changing Run as\./);
    const v = await run(b, 'tx8', `select 1;\nvacuum ${S}.emp`, { mode: 'script' });
    assert.match(v, /Line 2: VACUUM can&#39;t run inside a transaction\. Switch the worksheet to Autocommit to run it\./);
    assert.equal(JSON.parse((await b.get('/builder/sql/worksheet/txn?tab=tx8')).body).state, 'open', 'the transaction is intact');
    assert.match((await b.submit('/builder/sql/worksheet', { sql: 'select 1', mode: 'statement', txn: 'on' })).body, /Transaction mode needs JavaScript/);
    await b.submit('/builder/sql/worksheet', { sql: '', mode: 'rollback', ws_tab: 'tx8', txn: 'on' });
  });

  test('Run as an application\'s role inside the transaction; Explain and Autotrace see its changes and keep it open', async () => {
    const b = await builder();
    const hr = await owner.one(`select id, db_role from meta.app where alias = 'hr'`);
    const p = await run(b, 'tx9', 'select current_user as u', { as_app: String(hr.id) });
    assert.match(p, new RegExp(`<td>${hr.db_role}</td>`));
    assert.match(p, new RegExp(`title="Runs as the role ${hr.db_role} of `));
    await b.submit('/builder/sql/worksheet', { sql: '', mode: 'rollback', ws_tab: 'tx9', txn: 'on' });
    await run(b, 'tx10', `create table ${S}.made_in_tx (a int)`);
    const ex = (await b.submit('/builder/sql/worksheet', { sql: `select * from ${S}.made_in_tx`, mode: 'autotrace', ws_tab: 'tx10', txn: 'on' })).body;
    assert.match(ex, /Seq Scan/);
    const st = JSON.parse((await b.get('/builder/sql/worksheet/txn?tab=tx10')).body);
    assert.equal(st.state, 'open');
    assert.equal(st.statements, 1);
    await b.submit('/builder/sql/worksheet', { sql: '', mode: 'rollback', ws_tab: 'tx10', txn: 'on' });
    assert.equal((await owner.one(`select to_regclass('${S}.made_in_tx') as t`)).t, null);
  });

  test('the Change Log gets a transaction\'s DDL at COMMIT, never after a rollback', async () => {
    const b = await builder();
    const count = async () => (await owner.one(`select count(*)::int as n from meta.change_set where sql like '%${S}.cl107%'`)).n;
    const n0 = await count();
    await run(b, 'tx11', `create table ${S}.cl107a (a int)`);
    assert.equal(await count(), n0, 'not while open');
    await b.submit('/builder/sql/worksheet', { sql: '', mode: 'rollback', ws_tab: 'tx11', txn: 'on' });
    assert.equal(await count(), n0);
    await run(b, 'tx11', `create table ${S}.cl107b (a int)`);
    await b.submit('/builder/sql/worksheet', { sql: '', mode: 'commit', ws_tab: 'tx11', txn: 'on' });
    assert.equal(await count(), n0 + 1);
  });

  test('the JSON endpoint ends a tab\'s transaction (closing a tab, switching to Autocommit); signing out rolls back', async () => {
    const b = await builder();
    const before = await sal();
    await run(b, 'tx12', `update ${S}.emp set sal = sal + 1 where id = 1`);
    const r = JSON.parse((await b.submit('/builder/sql/worksheet/txn', { tab: 'tx12', action: 'rollback' })).body);
    assert.equal(r.ok, true);
    assert.equal(r.state, 'none');
    assert.match(r.message, /Rolled back \(1 statement undone\)/);
    assert.equal((await b.submit('/builder/sql/worksheet/txn', { tab: 'Not valid', action: 'rollback' })).statusCode, 400);
    await run(b, 'tx13', `update ${S}.emp set sal = sal + 1 where id = 1`);
    assert.equal(openTxnCount('admin'), 1);
    await b.submit('/builder/logout', {});
    assert.equal(openTxnCount('admin'), 0);
    assert.equal(await sal(), before);
  });

  test('a builder session that expired has its transaction rolled back by the sweeper', async () => {
    const b = await builder();
    const before = await sal();
    await run(b, 'tx14', `update ${S}.emp set sal = sal + 1 where id = 1`);
    assert.equal(openTxnCount('admin'), 1);
    await sweepTxns();
    assert.equal(openTxnCount('admin'), 1, 'alive: kept');
    await owner.query(`update meta.session set last_seen = now() - interval '3 days' where username = 'admin' and app_id is null`);
    await sweepTxns();
    assert.equal(openTxnCount('admin'), 0);
    assert.equal(await sal(), before);
  });
});
