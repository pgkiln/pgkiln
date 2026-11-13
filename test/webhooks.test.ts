// Sprint 177 part 2: inbound webhooks (migration 161). A REST handler of type webhook checks the signature on the
// raw body, stores the event once per event id, answers at once, and its PL/pgSQL block runs afterwards as the
// application's role, with retries.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';

process.env.PGKILN_SECRET_KEY = 'test-only-secret-key-0123456789abcdef';
process.env.QUEUE_RETRY_S = '60';

const { buildApp } = await import('../src/app.ts');
const { closePools, owner } = await import('../src/db.ts');
const { encryptSecret } = await import('../src/secrets.ts');
const wh = await import('../src/webhooks.ts');
const { handlerProblems, openApi } = await import('../src/runtime/rest.ts');

let app: FastifyInstance;
let appId: number;
const alias = 'hooks-s177';
const ROLE = 'pgkiln_hooks_s177';
const SCHEMA = 'hooks_s177';
const SECRET = 'whsec_test_5177_do_not_use';
const BASE = `/a/${alias}/rest/in`;

const hmac = (body: string | Buffer, secret = SECRET) => createHmac('sha256', secret).update(body).digest('hex');
const stripeSig = (body: string, t = Math.floor(Date.now() / 1000), secret = SECRET) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
const post = (path: string, payload: string | Buffer, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: `${BASE}/${path}`, payload, headers: { 'content-type': 'application/json', ...headers } });
const github = (body: string, more: Record<string, string> = {}) => post('github', body, { 'x-hub-signature-256': `sha256=${hmac(body)}`, ...more });
const events = async () => (await owner.query('select * from meta.webhook_event where app_id = $1 order by id', [appId])).rows;
const seen = async () => (await owner.query(`select * from ${SCHEMA}.seen order by id`)).rows;
const due = () => owner.query(`update meta.webhook_event set next_attempt_at = now() where app_id = $1 and state = 'retry'`, [appId]);

const HANDLERS = [
  { method: 'POST', path: 'github', type: 'webhook', auth: 'public',
    source: `insert into ${SCHEMA}.seen (kind, ref, body, who, role, event) values ('github', :REF, :BODY, meta.app_user(), current_user, meta.webhook_event());
             if :FAIL = 'yes' then raise exception 'cannot process %', :REF; end if;
             if :FAIL = 'once' and (meta.webhook_event()->>'attempt')::int = 1 then raise exception 'not yet'; end if`,
    webhook: { scheme: 'hmac-sha256', credential: 'HOOK_SECRET', header: 'X-Hub-Signature-256', prefix: 'sha256=', event_id: 'header:X-GitHub-Delivery', headers: ['X-GitHub-Event', 'Authorization'].slice(0, 1), max_attempts: 3 } },
  { method: 'POST', path: 'stripe', type: 'webhook', auth: 'public',
    source: `insert into ${SCHEMA}.seen (kind, ref, body, who, role, event) values ('stripe', :ID, :BODY, meta.app_user(), current_user, meta.webhook_event())`,
    webhook: { scheme: 'stripe', credential: 'HOOK_SECRET', event_id: 'body:id', tolerance_s: 300, retention_days: 2 } },
  { method: 'POST', path: 'b64', type: 'webhook', auth: 'public', status: 200,
    source: `insert into ${SCHEMA}.seen (kind, ref, body, who, role, event) values ('b64', null, :BODY, meta.app_user(), current_user, meta.webhook_event())`,
    webhook: { scheme: 'hmac-sha256', credential: 'HOOK_SECRET', encoding: 'base64', max_bytes: 2000 } },
  { method: 'POST', path: 'nosecret', type: 'webhook', auth: 'public', source: 'null', webhook: { scheme: 'hmac-sha256', credential: 'HOOK_EMPTY' } },
  { method: 'POST', path: 'echo', type: 'plpgsql', auth: 'public', source: `perform meta.rest_reply(jsonb_build_object('n', :N, 'body', :BODY), 200)` },
];

before(async () => {
  app = await buildApp({ logger: false });
  await owner.query(`drop schema if exists ${SCHEMA} cascade`);
  await owner.query(`delete from meta.app where alias = $1`, [alias]);
  await owner.query(`drop role if exists ${ROLE}`);
  await owner.query(`create role ${ROLE} nologin`);
  await owner.query(`grant ${ROLE} to pgkiln_runtime`);
  await owner.query(`create schema ${SCHEMA}`);
  await owner.query(`grant usage on schema ${SCHEMA} to ${ROLE}`);
  await owner.query(`create table ${SCHEMA}.seen (id serial primary key, kind text, ref text, body text, who text, role text, event jsonb)`);
  await owner.query(`grant select, insert on ${SCHEMA}.seen to ${ROLE}`);
  await owner.query(`grant usage on sequence ${SCHEMA}.seen_id_seq to ${ROLE}`);
  appId = (await owner.one(`insert into meta.app (alias, name, authentication, db_role) values ($1, 'Webhook test', 'none', $2) returning id`, [alias, ROLE])).id;
  await owner.query(`insert into meta.web_credential (app_id, name, type, secret_enc) values ($1, 'HOOK_SECRET', 'bearer', $2), ($1, 'HOOK_EMPTY', 'bearer', null)`, [appId, encryptSecret(SECRET)]);
  assert.deepEqual(handlerProblems(HANDLERS), []);
  await owner.query(`insert into meta.rest_module (app_id, name, title, handlers) values ($1, 'in', 'Inbound', $2::jsonb)`, [appId, JSON.stringify(HANDLERS)]);
});

beforeEach(async () => {
  await owner.query('delete from meta.webhook_event where app_id = $1', [appId]);
  await owner.query(`truncate ${SCHEMA}.seen`);
});

after(async () => {
  await wh.stopWebhookRunner();
  await owner.query('delete from meta.app where id = $1', [appId]);
  await owner.query(`drop schema if exists ${SCHEMA} cascade`);
  await owner.query(`drop role if exists ${ROLE}`);
  await app.close();
  await closePools();
});

describe('sprint 177: a webhook handler receives first and processes later', () => {
  test('a signed request is stored and answered 202; the block runs afterwards as the application\'s role', async () => {
    const body = '{"ref": "refs/heads/main",  "n": 1}';
    const res = await github(body, { 'x-github-delivery': 'd-1', 'x-github-event': 'push', 'x-other': 'dropped' });
    assert.equal(res.statusCode, 202, res.body);
    assert.deepEqual(res.json(), { status: 'accepted' });
    let [ev] = await events();
    assert.equal(ev.state, 'received');
    assert.equal(ev.module, 'in');
    assert.equal(ev.path, 'github');
    assert.equal(ev.event_key, 'd-1');
    assert.equal(ev.body.toString(), body, 'the raw bytes, as sent');
    assert.equal(ev.content_type, 'application/json');
    assert.deepEqual(ev.headers, { 'x-github-event': 'push' }, 'only the headers the handler keeps, never the signature');
    assert.deepEqual(await seen(), [], 'not processed in the request');
    assert.deepEqual(await wh.webhookTick(), [String(ev.id)]);
    [ev] = await events();
    assert.equal(ev.state, 'done');
    assert.equal(ev.attempts, 1);
    assert.ok(ev.processed_at);
    const [row] = await seen();
    assert.equal(row.ref, 'refs/heads/main');
    assert.equal(row.body, body);
    assert.equal(row.who, 'nobody');
    assert.equal(row.role, ROLE);
    assert.equal(row.event.event_id, 'd-1');
    assert.equal(row.event.attempt, 1);
    assert.equal(row.event.headers['x-github-event'], 'push');
    assert.equal(Number(row.event.id), Number(ev.id));
    assert.deepEqual(await wh.webhookTick(), []);
  });

  test('an event id seen before answers 200 and does nothing', async () => {
    const body = '{"ref": "a"}';
    assert.equal((await github(body, { 'x-github-delivery': 'same' })).statusCode, 202);
    const again = await github(body, { 'x-github-delivery': 'same' });
    assert.equal(again.statusCode, 200);
    assert.deepEqual(again.json(), { status: 'duplicate' });
    // after it was processed too, and with another body
    await wh.webhookTick();
    assert.equal((await github('{"ref": "b"}', { 'x-github-delivery': 'same' })).statusCode, 200);
    assert.equal((await events()).length, 1);
    await wh.webhookTick();
    assert.equal((await seen()).length, 1);
    // another id, and requests without one, are events of their own
    assert.equal((await github(body, { 'x-github-delivery': 'other' })).statusCode, 202);
    assert.equal((await github(body)).statusCode, 202);
    assert.equal((await github(body)).statusCode, 202);
    assert.equal((await events()).length, 4);
    // the same id for another handler is not a duplicate
    const s = '{"id": "same", "type": "x"}';
    assert.equal((await post('stripe', s, { 'stripe-signature': stripeSig(s) })).statusCode, 202);
  });

  test('Stripe signatures: t.body signed, the event id from the body', async () => {
    const body = '{"id": "evt_1", "type": "payment_intent.succeeded"}';
    const res = await post('stripe', body, { 'stripe-signature': `${stripeSig(body)},v0=ignored` });
    assert.equal(res.statusCode, 202, res.body);
    // a rotated secret: any v1 that matches
    const two = `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)},v1=${stripeSig('{"id": "evt_2"}').split('v1=')[1]}`;
    assert.equal((await post('stripe', '{"id": "evt_2"}', { 'stripe-signature': two })).statusCode, 202);
    await wh.webhookTick();
    const rows = await seen();
    assert.deepEqual(rows.map((r) => r.ref), ['evt_1', 'evt_2']);
    const [ev] = await events();
    assert.equal(ev.event_key, 'evt_1');
    const days = (new Date(ev.purge_after).getTime() - new Date(ev.received_at).getTime()) / 86_400_000;
    assert.ok(Math.abs(days - 2) < 0.01, 'the handler\'s retention');
  });

  test('base64 signatures, any content type, the handler\'s status', async () => {
    const xml = '<?xml version="1.0"?><order id="7"/>';
    const sig = createHmac('sha256', SECRET).update(xml).digest('base64');
    const res = await post('b64', xml, { 'content-type': 'text/xml', 'x-signature': sig });
    assert.equal(res.statusCode, 200, res.body);
    const bin = Buffer.from([0, 1, 2, 255, 254]);
    assert.equal((await post('b64', bin, { 'content-type': 'application/octet-stream', 'x-signature': createHmac('sha256', SECRET).update(bin).digest('base64url') })).statusCode, 200);
    // no body at all
    assert.equal((await app.inject({ method: 'POST', url: `${BASE}/b64`, headers: { 'x-signature': createHmac('sha256', SECRET).update('').digest('base64') } })).statusCode, 200);
    await wh.webhookTick();
    const rows = await seen();
    assert.equal(rows[0].body, xml);
    assert.equal(rows[0].event.content_type, 'text/xml');
    assert.equal(rows[1].body, null, 'a binary body is not text');
    assert.equal(rows[2].body, null);
    assert.ok((await events())[1].body.equals(bin));
  });

  test('a block that raises is tried again with backoff, then the event is failed', async () => {
    assert.equal((await github('{"ref": "r1", "fail": "yes"}', { 'x-github-delivery': 'f-1' })).statusCode, 202);
    await wh.webhookTick();
    let [ev] = await events();
    assert.equal(ev.state, 'retry');
    assert.equal(ev.attempts, 1);
    assert.match(ev.error, /cannot process r1/);
    const wait = (new Date(ev.next_attempt_at).getTime() - Date.now()) / 1000;
    assert.ok(wait > 40 && wait < 80, `about 60 s, got ${wait}`);
    assert.deepEqual(await wh.webhookTick(), [], 'not due yet');
    for (let i = 0; i < 4; i++) {
      await due();
      await wh.webhookTick();
    }
    [ev] = await events();
    assert.equal(ev.state, 'failed');
    assert.equal(ev.attempts, 3, 'the handler\'s max_attempts');
    assert.deepEqual(await seen(), [], 'each failed attempt was rolled back');
    const logged = await owner.one(`select detail from meta.activity_log where app_id = $1 and event = 'error' order by id desc limit 1`, [appId]);
    assert.match(logged.detail, /webhook in\/github: event \d+ failed/);
    // a failure that passes
    assert.equal((await github('{"ref": "r2", "fail": "once"}', { 'x-github-delivery': 'f-2' })).statusCode, 202);
    await wh.webhookTick();
    await due();
    await wh.webhookTick();
    const last = (await events()).at(-1);
    assert.equal(last.state, 'done');
    assert.equal(last.attempts, 2);
    assert.equal(last.error, null);
    assert.deepEqual((await seen()).map((r) => r.ref), ['r2']);
  });

  test('a server that stopped loses its lease; two passes process an event once', async () => {
    for (let i = 0; i < 5; i++) await github(`{"ref": "c${i}"}`, { 'x-github-delivery': `c-${i}` });
    const [first] = await events();
    await owner.query(`update meta.webhook_event set state = 'running', attempts = 1, worker = 'gone:1', lease_until = now() + interval '1 minute' where id = $1`, [first.id]);
    await Promise.all([wh.webhookTick(), wh.webhookTick(), wh.webhookTick()]);
    assert.deepEqual((await seen()).map((r) => r.ref).sort(), ['c1', 'c2', 'c3', 'c4']);
    await owner.query(`update meta.webhook_event set lease_until = now() - interval '1 second' where id = $1`, [first.id]);
    await wh.webhookTick();
    assert.equal((await seen()).length, 5);
    assert.equal((await events())[0].attempts, 2);
  });

  test('NOTIFY wakes the runner; events past their retention are purged; a removed handler fails its events', async () => {
    await wh.startWebhookRunner();
    await github('{"ref": "now"}', { 'x-github-delivery': 'n-1' });
    const t0 = Date.now();
    while (!(await seen()).length && Date.now() - t0 < 5000) await new Promise((x) => setTimeout(x, 25));
    assert.equal((await seen()).length, 1);
    assert.ok(Date.now() - t0 < 3000);
    await wh.stopWebhookRunner();
    await owner.query(`update meta.webhook_event set purge_after = now() - interval '1 minute' where app_id = $1`, [appId]);
    await wh.purgeWebhookEvents(true);
    assert.equal((await events()).length, 0);
    await owner.query(`insert into meta.webhook_event (app_id, module, path, body) values ($1, 'in', 'gone', 'x')`, [appId]);
    await wh.webhookTick();
    const [ev] = await events();
    assert.equal(ev.state, 'failed');
    assert.match(ev.error, /no longer exists/);
  });

  test('other handlers of the module parse their bodies as before', async () => {
    const res = await post('echo', '{"n": 5}');
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), { n: '5', body: '{"n":5}' });
    assert.equal((await post('echo', '{broken')).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: `${BASE}/echo`, payload: 'n=6', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).json().n, '6');
    assert.equal((await post('echo', '<x/>', { 'content-type': 'text/xml' })).statusCode, 415);
  });

  test('the definition: problems, the OpenAPI document', () => {
    const bad = (h: Record<string, unknown>) => handlerProblems([{ method: 'POST', path: 'x', type: 'webhook', source: 'null', ...h }]).join(' ');
    assert.match(bad({}), /needs "webhook"/);
    assert.match(bad({ method: 'GET', webhook: { scheme: 'hmac-sha256', credential: 'X' } }), /answers POST/);
    assert.match(bad({ webhook: { scheme: 'md5', credential: 'X' } }), /webhook\.scheme/);
    assert.match(bad({ webhook: { scheme: 'stripe' } }), /webhook\.credential/);
    assert.match(bad({ webhook: { scheme: 'stripe', credential: 'X', header: 'Cookie' } }), /webhook\.header/);
    assert.match(bad({ webhook: { scheme: 'stripe', credential: 'X', event_id: 'id' } }), /event_id/);
    assert.match(bad({ webhook: { scheme: 'stripe', credential: 'X', event_id: 'body:items[*].id' } }), /event_id/);
    assert.match(bad({ webhook: { scheme: 'stripe', credential: 'X', headers: ['Authorization'] } }), /webhook\.headers/);
    assert.match(bad({ webhook: { scheme: 'stripe', credential: 'X', retention_days: 0 } }), /retention_days/);
    assert.match(bad({ webhook: { scheme: 'stripe', credential: 'X', max_bytes: 5_000_000 } }), /max_bytes/);
    assert.match(bad({ webhook: { scheme: 'stripe', credential: 'X' }, roles: ['manager'] }), /no roles or parameters/);
    assert.match(handlerProblems([{ method: 'POST', path: 'x', type: 'sql', source: 'select 1', webhook: {} }]).join(' '), /belongs to a handler of type webhook/);
    const doc = openApi({ alias, name: 'T' }, { name: 'in', title: 'In', description: null, handlers: HANDLERS as never }) as any;
    assert.deepEqual(doc.paths['/github'].post.security, []);
  });
});
