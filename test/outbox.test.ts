// Sprint 177 part 1: meta.web_request as an outbox (migration 160): retries with backoff, the final "gave up"
// status, callbacks as the application's role, NOTIFY delivery, leases, ordering keys and idempotency keys.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import '../src/env.ts';

process.env.PGKILN_SECRET_KEY = 'test-only-secret-key-0123456789abcdef';
process.env.PGKILN_REST_ALLOWED_HOSTS = '127.0.0.1,localhost';
process.env.PGKILN_REST_PRIVATE_HOSTS = '127.0.0.1';
process.env.QUEUE_RETRY_S = '60';

const { closePools, owner, runtime } = await import('../src/db.ts');
const wr = await import('../src/webrequests.ts');
const { backoffS } = await import('../src/queue-runner.ts');

let appId: number;
let mock: http.Server;
let mockBase = '';
let closedBase = '';
const alias = 'outbox-s177';
const ROLE = 'pgkiln_outbox_s177';
const SCHEMA = 'outbox_s177';
const seen: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
/** how the mock answers a path: a list of statuses, the last one repeats */
const plan = new Map<string, number[]>();
const hits = (path: string) => seen.filter((s) => s.url.split('?')[0] === path);

/** SQL as the test app's code: its role, meta.app_id() set. */
const asApp = <T>(fn: (q: (sql: string, params?: unknown[]) => Promise<any[]>) => Promise<T>) =>
  runtime.tx(async (c) => {
    await c.query(`select set_config('pgkiln.app_id', $1, true), set_config('pgkiln.app_user', 'ann', true)`, [String(appId)]);
    await c.query(`set local role ${ROLE}`);
    return fn(async (sql, params = []) => (await c.query(sql, params)).rows);
  });
const queue = async (sql: string, params: unknown[] = []) => String((await asApp((q) => q(`select ${sql} as id`, params)))[0].id);
const row = (id: string) => owner.one<any>('select * from meta.web_request_log where id = $1', [id]);
const due = (id?: string) => owner.query(`update meta.web_request_log set next_attempt_at = now() where status = 'retry' ${id ? 'and id = $1' : ''}`, id ? [id] : []);
const log = async () => (await owner.query(`select msg from ${SCHEMA}.log order by id`)).rows.map((r) => r.msg as string);

before(async () => {
  mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      const path = req.url!.split('?')[0];
      const statuses = plan.get(path) ?? [200];
      const status = statuses.length > 1 ? statuses.shift()! : statuses[0];
      res.writeHead(status, { 'content-type': 'application/json', ...(status === 429 ? { 'retry-after': '120' } : {}) });
      res.end(JSON.stringify({ status, path }));
    });
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  mockBase = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
  // a port nothing listens on
  const closed = http.createServer();
  await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
  closedBase = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
  await new Promise((r) => closed.close(r));

  await owner.query(`drop schema if exists ${SCHEMA} cascade`);
  await owner.query(`delete from meta.app where alias = $1`, [alias]);
  await owner.query(`drop role if exists ${ROLE}`);
  await owner.query(`create role ${ROLE} nologin`);
  await owner.query(`grant ${ROLE} to pgkiln_runtime`);
  await owner.query(`create schema ${SCHEMA}`);
  await owner.query(`grant usage on schema ${SCHEMA} to ${ROLE}`);
  await owner.query(`create table ${SCHEMA}.log (id serial primary key, msg text)`);
  await owner.query(`grant select, insert on ${SCHEMA}.log to ${ROLE}`);
  await owner.query(`grant usage on sequence ${SCHEMA}.log_id_seq to ${ROLE}`);
  // the callback: who runs it, for which request, with which outcome
  await owner.query(`create function ${SCHEMA}.sent(p_id bigint) returns void language plpgsql as $$
    declare r jsonb := meta.web_response(p_id);
    begin
      insert into ${SCHEMA}.log (msg) values (format('%s %s %s by %s as %s', r->>'status', coalesce(r->>'status_code', '-'), r->>'attempts', meta.app_user(), current_user));
    end $$`);
  await owner.query(`create function ${SCHEMA}.broken(p_id bigint) returns void language plpgsql as $$
    begin
      insert into ${SCHEMA}.log (msg) values ('broken ran');
      raise exception 'the callback failed on purpose';
    end $$`);
  await owner.query(`create function ${SCHEMA}.not_mine(p_id bigint) returns void language sql as 'select 1'`);
  await owner.query(`revoke execute on function ${SCHEMA}.not_mine(bigint) from public`);
  await owner.query(`create function ${SCHEMA}.two_args(p_id bigint, p_x text) returns void language sql as 'select 1'`);
  appId = (await owner.one(`insert into meta.app (alias, name, authentication, db_role) values ($1, 'Outbox test', 'none', $2) returning id`, [alias, ROLE])).id;
});

beforeEach(async () => {
  await owner.query('delete from meta.web_request_log where app_id = $1', [appId]);
  await owner.query(`truncate ${SCHEMA}.log`);
  seen.length = 0;
  plan.clear();
});

after(async () => {
  await wr.stopWebRequestRunner();
  await owner.query('delete from meta.app where id = $1', [appId]);
  await owner.query(`drop schema if exists ${SCHEMA} cascade`);
  await owner.query(`drop role if exists ${ROLE}`);
  mock.close();
  await closePools();
});

describe('sprint 177: retries of a queued web request', () => {
  test('a 503 waits for its next attempt (backoff), then succeeds', async () => {
    plan.set('/flaky', [503, 503, 200]);
    const id = await queue(`meta.web_request($1, 'POST', '{"n":1}')`, [`${mockBase}/flaky`]);
    await wr.webRequestTick();
    let r = await row(id);
    assert.equal(r.status, 'retry');
    assert.equal(r.attempts, 1);
    assert.equal(r.status_code, 503);
    assert.match(r.message, /503/);
    const wait = (new Date(r.next_attempt_at).getTime() - Date.now()) / 1000;
    assert.ok(wait > 40 && wait < 80, `first backoff about 60 s, got ${wait}`);
    assert.equal((await asApp((q) => q('select meta.web_response($1) as r', [id])))[0].r.status, 'retry');
    // not due yet: nothing happens
    await wr.webRequestTick();
    assert.equal(hits('/flaky').length, 1);
    await due(id);
    await wr.webRequestTick();
    r = await row(id);
    assert.equal(r.status, 'retry');
    assert.equal(r.attempts, 2);
    const wait2 = (new Date(r.next_attempt_at).getTime() - Date.now()) / 1000;
    assert.ok(wait2 > 90 && wait2 < 150, `second backoff about 120 s, got ${wait2}`);
    await due(id);
    await wr.webRequestTick();
    r = await row(id);
    assert.equal(r.status, 'ok');
    assert.equal(r.status_code, 200);
    assert.equal(r.attempts, 3);
    assert.equal(r.next_attempt_at, null);
    assert.equal(hits('/flaky').length, 3);
  });

  test('every attempt failed: gave up after max_attempts, with the last answer', async () => {
    plan.set('/down', [500]);
    const id = await queue(`meta.web_request($1, p_max_attempts => 2)`, [`${mockBase}/down`]);
    await wr.webRequestTick();
    assert.equal((await row(id)).status, 'retry');
    await due(id);
    await wr.webRequestTick();
    const r = await row(id);
    assert.equal(r.status, 'gave_up');
    assert.equal(r.attempts, 2);
    assert.equal(r.status_code, 500);
    assert.ok(r.finished_at);
    await due();
    await wr.webRequestTick();
    assert.equal(hits('/down').length, 2);
    const res = (await asApp((q) => q('select meta.web_response($1) as r', [id])))[0].r;
    assert.equal(res.status, 'gave_up');
    assert.equal(res.attempts, 2);
    assert.equal(res.max_attempts, 2);
  });

  test('the default is 5 attempts; the backoff doubles and is capped', async () => {
    assert.equal(wr.DEFAULT_ATTEMPTS, 5);
    assert.equal(backoffS(1, 30, 3600, 0.5), 30);
    assert.equal(backoffS(2, 30, 3600, 0.5), 60);
    assert.equal(backoffS(4, 30, 3600, 0.5), 240);
    assert.equal(backoffS(12, 30, 3600, 0.5), 3600);
    assert.ok(backoffS(3, 30, 3600, 0) > 95.9 && backoffS(3, 30, 3600, 1) < 144.1);
    plan.set('/down5', [502]);
    const id = await queue(`meta.web_request($1)`, [`${mockBase}/down5`]);
    for (let i = 0; i < 7; i++) {
      await wr.webRequestTick();
      await due(id);
    }
    assert.equal((await row(id)).status, 'gave_up');
    assert.equal(hits('/down5').length, 5);
  });

  test('a 4xx answer is final (ok with its status code): not retried', async () => {
    plan.set('/gone', [404]);
    const id = await queue(`meta.web_request($1)`, [`${mockBase}/gone`]);
    await wr.webRequestTick();
    const r = await row(id);
    assert.equal(r.status, 'ok');
    assert.equal(r.status_code, 404);
    assert.equal(r.attempts, 1);
  });

  test('429 is retried, honouring Retry-After (within the cap)', async () => {
    plan.set('/busy', [429, 200]);
    const id = await queue(`meta.web_request($1)`, [`${mockBase}/busy`]);
    await wr.webRequestTick();
    const r = await row(id);
    assert.equal(r.status, 'retry');
    const wait = (new Date(r.next_attempt_at).getTime() - Date.now()) / 1000;
    assert.ok(wait > 110 && wait < 130, `Retry-After: 120, got ${wait}`);
    assert.equal(wr.retryAfterS('7'), 7);
    assert.equal(wr.retryAfterS(new Date(Date.now() + 30_000).toUTCString()), 30);
    assert.equal(wr.retryAfterS('soon'), null);
    // a Retry-After beyond the cap waits the cap
    process.env.QUEUE_RETRY_MAX_S = '50';
    try {
      const o = wr.outcome({ status: 'ok', statusCode: 429, url: null, headers: { 'retry-after': '100000' }, body: null, message: null }, 1, 5);
      assert.deepEqual(o, { status: 'retry', nextS: 50 });
    } finally {
      delete process.env.QUEUE_RETRY_MAX_S;
    }
  });

  test('a service that can\'t be reached is retried; a refused host is an error at once', async () => {
    const unreachable = await queue(`meta.web_request($1, p_max_attempts => 2)`, [`${closedBase}/x`]);
    const refused = await queue(`meta.web_request('http://10.1.2.3/x')`);
    const notListed = await queue(`meta.web_request('https://not-allowed.example.org/x')`);
    await wr.webRequestTick();
    let r = await row(unreachable);
    assert.equal(r.status, 'retry');
    assert.match(r.message, /could not be reached/);
    for (const id of [refused, notListed]) {
      r = await row(id);
      assert.equal(r.status, 'error', r.message);
      assert.equal(r.attempts, 1);
      assert.equal(r.next_attempt_at, null);
    }
    await due();
    await wr.webRequestTick();
    assert.equal((await row(unreachable)).status, 'gave_up');
    assert.equal((await row(refused)).attempts, 1);
  });

  test('a server that stopped loses its lease: the request is attempted again, or given up', async () => {
    const id = await queue(`meta.web_request($1, p_max_attempts => 2)`, [`${mockBase}/lease`]);
    // as if another server claimed it and stopped
    await owner.query(`update meta.web_request_log set status = 'running', attempts = 1, worker = 'gone:1', lease_until = now() + interval '1 minute' where id = $1`, [id]);
    await wr.webRequestTick();
    assert.equal(hits('/lease').length, 0, 'the lease still holds');
    await owner.query(`update meta.web_request_log set lease_until = now() - interval '1 second' where id = $1`, [id]);
    await wr.webRequestTick();
    let r = await row(id);
    assert.equal(r.status, 'ok');
    assert.equal(r.attempts, 2);
    assert.equal(hits('/lease').length, 1);
    // out of attempts when the lease ends: given up, not sent again
    const id2 = await queue(`meta.web_request($1, p_max_attempts => 1)`, [`${mockBase}/lease2`]);
    await owner.query(`update meta.web_request_log set status = 'running', attempts = 1, worker = 'gone:1', lease_until = now() - interval '1 second' where id = $1`, [id2]);
    await wr.webRequestTick();
    r = await row(id2);
    assert.equal(r.status, 'gave_up');
    assert.equal(hits('/lease2').length, 0);
  });

  test('two passes at the same time make a request once', async () => {
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push(await queue(`meta.web_request($1)`, [`${mockBase}/once?n=${i}`]));
    await Promise.all([wr.webRequestTick(), wr.webRequestTick(), wr.webRequestTick()]);
    assert.equal(hits('/once').length, 6);
    for (const id of ids) assert.equal((await row(id)).attempts, 1);
  });

  test('a waiting request can be cancelled by its application; a finished one can\'t', async () => {
    plan.set('/c', [503]);
    const id = await queue(`meta.web_request($1)`, [`${mockBase}/c`]);
    await wr.webRequestTick();
    assert.equal((await asApp((q) => q('select meta.web_request_cancel($1) as ok', [id])))[0].ok, true);
    assert.equal((await row(id)).status, 'cancelled');
    await due();
    await wr.webRequestTick();
    assert.equal(hits('/c').length, 1);
    assert.equal((await asApp((q) => q('select meta.web_request_cancel($1) as ok', [id])))[0].ok, false);
  });
});

describe('sprint 177: the callback of a web request', () => {
  test('called once when the request succeeds, as the application\'s role and the queueing user', async () => {
    const id = await queue(`meta.web_request($1, 'POST', '{}', p_callback => '${SCHEMA}.sent')`, [`${mockBase}/cb`]);
    assert.equal((await row(id)).callback, `${SCHEMA}.sent`);
    await wr.webRequestTick();
    const r = await row(id);
    assert.equal(r.status, 'ok');
    assert.equal(r.callback_state, 'done');
    assert.deepEqual(await log(), [`ok 200 1 by ann as ${ROLE}`]);
    await wr.webRequestTick();
    assert.equal((await log()).length, 1);
    assert.equal(hits('/cb').length, 1);
  });

  test('called when the request gave up, not between the attempts', async () => {
    plan.set('/cbdown', [503]);
    const id = await queue(`meta.web_request($1, p_callback => '${SCHEMA}.sent', p_max_attempts => 2)`, [`${mockBase}/cbdown`]);
    await wr.webRequestTick();
    assert.deepEqual(await log(), []);
    assert.equal((await row(id)).callback_state, null);
    await due(id);
    await wr.webRequestTick();
    assert.deepEqual(await log(), [`gave_up 503 2 by ann as ${ROLE}`]);
  });

  test('a callback that raises is called again, then failed; the request is never sent again', async () => {
    const id = await queue(`meta.web_request($1, 'POST', '{}', p_callback => '${SCHEMA}.broken')`, [`${mockBase}/cbfail`]);
    await wr.webRequestTick();
    let r = await row(id);
    assert.equal(r.status, 'ok');
    assert.equal(r.callback_state, 'pending');
    assert.equal(r.callback_attempts, 1);
    assert.match(r.callback_error, /failed on purpose/);
    assert.ok(new Date(r.callback_next_at).getTime() > Date.now() + 30_000);
    for (let i = 0; i < 4; i++) {
      await owner.query(`update meta.web_request_log set callback_next_at = now() where id = $1 and callback_state = 'pending'`, [id]);
      await wr.webRequestTick();
    }
    r = await row(id);
    assert.equal(r.callback_state, 'failed');
    assert.equal(r.callback_attempts, wr.CALLBACK_ATTEMPTS);
    assert.equal(r.status, 'ok');
    assert.equal(hits('/cbfail').length, 1, 'the HTTP call was made once');
    // its insert was rolled back with each failed call
    assert.deepEqual(await log(), []);
    const res = (await asApp((q) => q('select meta.web_response($1) as r', [id])))[0].r;
    assert.equal(res.callback_state, 'failed');
    assert.match(res.callback_error, /failed on purpose/);
    const logged = await owner.one(`select detail from meta.activity_log where app_id = $1 and event = 'error' order by id desc limit 1`, [appId]);
    assert.match(logged.detail, /callback .*broken failed/);
  });

  test('the callback is a function (bigint) the application\'s role may execute', async () => {
    const bad = async (name: string, re: RegExp) =>
      assert.rejects(queue(`meta.web_request($1, p_callback => $2)`, [`${mockBase}/x`, name]), re, name);
    await bad(`${SCHEMA}.nope`, /does not exist, or the application's database role may not execute/);
    await bad(`${SCHEMA}.not_mine`, /may not execute/);
    await bad(`${SCHEMA}.two_args`, /does not exist/);
    await bad('sent', /schema\.function/);
    await bad(`${SCHEMA}.sent(bigint)`, /schema\.function/);
    await bad(`${SCHEMA}.sent; drop table ${SCHEMA}.log`, /schema\.function/);
    await bad(`"${SCHEMA}"."sent"`, /schema\.function/);
    await bad('meta.web_response', /not of meta/);
    await bad('pg_catalog.pg_sleep', /not of pg_catalog/);
    assert.equal((await owner.one('select count(*)::int as n from meta.web_request_log where app_id = $1', [appId])).n, 0);
  });
});

describe('sprint 177: ordering and idempotency keys', () => {
  test('requests with the same ordering key go out one at a time, in the order queued', async () => {
    plan.set('/o1', [503, 200]);
    const a1 = await queue(`meta.web_request($1, 'POST', 'a1', p_ordering_key => 'order-7')`, [`${mockBase}/o1`]);
    const a2 = await queue(`meta.web_request($1, 'POST', 'a2', p_ordering_key => 'order-7')`, [`${mockBase}/o2`]);
    const a3 = await queue(`meta.web_request($1, 'POST', 'a3', p_ordering_key => 'order-7')`, [`${mockBase}/o3`]);
    const b1 = await queue(`meta.web_request($1, 'POST', 'b1', p_ordering_key => 'order-8')`, [`${mockBase}/o4`]);
    const free = await queue(`meta.web_request($1, 'POST', 'free')`, [`${mockBase}/o5`]);
    await wr.webRequestTick();
    // the first of order-7 waits for a retry and holds the later ones back; the other key and the keyless one went out
    assert.equal((await row(a1)).status, 'retry');
    assert.equal((await row(a2)).status, 'queued');
    assert.equal((await row(a3)).status, 'queued');
    assert.equal((await row(b1)).status, 'ok');
    assert.equal((await row(free)).status, 'ok');
    assert.deepEqual(seen.map((s) => s.body).sort(), ['a1', 'b1', 'free']);
    await wr.webRequestTick();
    assert.equal(hits('/o2').length, 0);
    await due(a1);
    await wr.webRequestTick();
    assert.deepEqual(seen.map((s) => s.body).slice(3), ['a1', 'a2', 'a3']);
    for (const id of [a1, a2, a3]) assert.equal((await row(id)).status, 'ok');
  });

  test('a request that gave up lets the next one of its key through', async () => {
    plan.set('/g1', [500]);
    const a1 = await queue(`meta.web_request($1, p_ordering_key => 'k', p_max_attempts => 1)`, [`${mockBase}/g1`]);
    const a2 = await queue(`meta.web_request($1, p_ordering_key => 'k')`, [`${mockBase}/g2`]);
    await wr.webRequestTick();
    assert.equal((await row(a1)).status, 'gave_up');
    assert.equal((await row(a2)).status, 'ok');
  });

  test('the idempotency key is the same on every attempt', async () => {
    plan.set('/i1', [503, 503, 200]);
    const id = await queue(`meta.web_request($1, 'POST', '{}')`, [`${mockBase}/i1`]);
    const own = await queue(`meta.web_request($1, 'PUT', '{}', p_idempotency_key => 'order-7-shipped', p_idempotency_header => 'X-Request-Id')`, [`${mockBase}/i2`]);
    const get = await queue(`meta.web_request($1)`, [`${mockBase}/i3`]);
    const off = await queue(`meta.web_request($1, 'POST', '{}', p_idempotency_header => null)`, [`${mockBase}/i4`]);
    const mine = await queue(`meta.web_request($1, 'POST', '{}', '{"Idempotency-Key": "set-by-caller"}')`, [`${mockBase}/i5`]);
    for (let i = 0; i < 3; i++) {
      await wr.webRequestTick();
      await due();
    }
    const keys = hits('/i1').map((s) => s.headers['idempotency-key']);
    assert.equal(keys.length, 3);
    assert.match(String(keys[0]), /^[0-9a-f-]{36}$/);
    assert.equal(new Set(keys).size, 1);
    assert.equal((await row(id)).idempotency_key, keys[0]);
    assert.equal(hits('/i2')[0].headers['x-request-id'], 'order-7-shipped');
    assert.equal(hits('/i2')[0].headers['idempotency-key'], undefined);
    assert.equal(hits('/i3')[0].headers['idempotency-key'], undefined, 'a GET gets no generated key');
    assert.equal(hits('/i4')[0].headers['idempotency-key'], undefined);
    assert.equal(hits('/i5')[0].headers['idempotency-key'], 'set-by-caller');
    assert.equal((await row(own)).idempotency_key, 'order-7-shipped');
    assert.equal((await row(get)).idempotency_key, null);
    assert.equal((await row(off)).idempotency_key, null);
    assert.ok(mine);
    await assert.rejects(queue(`meta.web_request($1, p_idempotency_key => E'a\\nb')`, [`${mockBase}/x`]), /printable ASCII/);
    await assert.rejects(queue(`meta.web_request($1, p_idempotency_key => 'k', p_idempotency_header => 'Authorization')`, [`${mockBase}/x`]), /can't be the header/);
    await assert.rejects(queue(`meta.web_request($1, p_max_attempts => 21)`, [`${mockBase}/x`]), /1 to 20/);
  });
});

describe('sprint 177: delivery when queued', () => {
  test('NOTIFY wakes the runner: delivered and called back without a scheduler pass', async () => {
    await wr.startWebRequestRunner();
    const id = await queue(`meta.web_request($1, 'POST', '{}', p_callback => '${SCHEMA}.sent')`, [`${mockBase}/now`]);
    const t0 = Date.now();
    let r = await row(id);
    while (r.callback_state !== 'done' && Date.now() - t0 < 5000) {
      await new Promise((x) => setTimeout(x, 25));
      r = await row(id);
    }
    assert.equal(r.status, 'ok');
    assert.equal(r.callback_state, 'done');
    assert.ok(Date.now() - t0 < 3000, `delivered in ${Date.now() - t0} ms`);
    await wr.stopWebRequestRunner();
  });

  test('a request queued in a transaction that rolls back is never made', async () => {
    await assert.rejects(asApp(async (q) => {
      await q(`select meta.web_request($1, 'POST', '{}')`, [`${mockBase}/rolled-back`]);
      throw new Error('rollback');
    }), /rollback/);
    await wr.webRequestTick();
    assert.equal(hits('/rolled-back').length, 0);
  });
});
