// Push notifications (src/push.ts, migration 074): the encryption against
// RFC 8291's example, VAPID tokens, the subscription checks, and the whole
// path through a local push service: subscribe, meta.send_push, delivery.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, hkdfSync } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { decodeProtectedHeader, importJWK, jwtVerify } from 'jose';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { encryptPayload, generateVapidKeys, pushTick, subscriptionProblem, vapidHeader } from '../src/push.ts';
import { processProblems } from '../src/runtime/processes.ts';
import { Browser } from './helpers.ts';

const u = (s: string) => Buffer.from(s, 'base64url');

// RFC 8291 section 5 and appendix A
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  message:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

/** The receiving side of RFC 8291, written separately from the sender. */
function decrypt(message: Buffer, uaPrivate: string, auth: string) {
  const salt = message.subarray(0, 16);
  const idlen = message[20];
  const asPublic = message.subarray(21, 21 + idlen);
  const ua = createECDH('prime256v1');
  ua.setPrivateKey(u(uaPrivate));
  const secret = ua.computeSecret(asPublic);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', secret, u(auth), info, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const ct = message.subarray(21 + idlen);
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2, 'last record delimiter');
  return plain.subarray(0, -1).toString('utf8');
}

describe('push notifications: encryption (RFC 8291)', () => {
  test('the example of RFC 8291 section 5, byte for byte', () => {
    const out = encryptPayload(Buffer.from(RFC.plaintext), RFC.uaPublic, RFC.auth, { privateKey: RFC.asPrivate }, u(RFC.salt));
    assert.equal(out.toString('base64url'), RFC.message);
  });

  test('a random message decrypts with the device key', () => {
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const auth = Buffer.alloc(16, 7).toString('base64url');
    const text = JSON.stringify({ title: 'Approval needed', body: 'Ünïcödé ✓', url: '/a/x/5' });
    const out = encryptPayload(Buffer.from(text), ua.getPublicKey().toString('base64url'), auth);
    assert.equal(decrypt(out, ua.getPrivateKey().toString('base64url'), auth), text);
    assert.equal(out.readUInt32BE(16), 4096);
  });

  test('bad subscription keys and a too large payload are refused', () => {
    assert.throws(() => encryptPayload(Buffer.from('x'), 'AAAA', RFC.auth));
    assert.throws(() => encryptPayload(Buffer.alloc(5000), RFC.uaPublic, RFC.auth), /too large/);
  });
});

describe('push notifications: VAPID (RFC 8292)', () => {
  test('a token for the push service origin, signed with the app key', async () => {
    const keys = generateVapidKeys();
    assert.match(keys.publicKey, /^[A-Za-z0-9_-]{87}$/);
    const header = await vapidHeader('https://fcm.googleapis.com/fcm/send/abc', keys);
    const m = /^vapid t=([^,]+), k=([A-Za-z0-9_-]+)$/.exec(header)!;
    assert.ok(m);
    assert.equal(m[2], keys.publicKey);
    assert.equal(decodeProtectedHeader(m[1]).alg, 'ES256');
    const pub = u(keys.publicKey);
    const key = await importJWK({ kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, 'ES256');
    const { payload } = await jwtVerify(m[1], key, { audience: 'https://fcm.googleapis.com' });
    assert.ok(payload.exp! - Date.now() / 1000 <= 24 * 3600);
    assert.match(String(payload.sub), /^(mailto:|https:\/\/)/);
  });
});

describe('push notifications: subscriptions from browsers', () => {
  const ok = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc:def', p256dh: RFC.uaPublic, auth: RFC.auth };
  test('a push service subscription is accepted', () => {
    assert.equal(subscriptionProblem(ok), null);
    assert.equal(subscriptionProblem({ ...ok, endpoint: 'https://wns2-par02p.notify.windows.com/w/?token=x' }), null);
  });
  test('other hosts, http, credentials and bad keys are refused (SSRF)', (t) => {
    // as in production: no private test host
    const priv = process.env.PGKILN_PUSH_PRIVATE_HOSTS;
    delete process.env.PGKILN_PUSH_PRIVATE_HOSTS;
    t.after(() => {
      if (priv !== undefined) process.env.PGKILN_PUSH_PRIVATE_HOSTS = priv;
    });
    for (const endpoint of ['https://evil.example.com/x', 'http://fcm.googleapis.com/x', 'https://127.0.0.1/x', 'https://u:p@fcm.googleapis.com/x',
      'https://fcm.googleapis.com.evil.com/x', 'https://notify.windows.com.evil.com/', 'file:///etc/passwd', 'https://x'.padEnd(1100, 'x')])
      assert.ok(subscriptionProblem({ ...ok, endpoint }), endpoint);
    assert.ok(subscriptionProblem({ ...ok, p256dh: 'A'.repeat(87) }));
    assert.ok(subscriptionProblem({ ...ok, auth: 'short' }));
    assert.ok(subscriptionProblem({ ...ok, endpoint: 42 }));
    // a private test host allows plain http for that host only
    process.env.PGKILN_PUSH_PRIVATE_HOSTS = '127.0.0.1';
    assert.equal(subscriptionProblem({ ...ok, endpoint: 'http://127.0.0.1:9/x' }), null);
    assert.ok(subscriptionProblem({ ...ok, endpoint: 'http://fcm.googleapis.com/x' }));
    delete process.env.PGKILN_PUSH_PRIVATE_HOSTS;
  });
});

// ---------------------------------------------------------------- through a local push service

let app: FastifyInstance;
let appId: number;
let server: http.Server;
let port = 0;
/** what the push service answers next, and what it received */
let answer = 201;
const received: { url: string; headers: http.IncomingHttpHeaders; body: Buffer }[] = [];
const device = createECDH('prime256v1');
device.generateKeys();
const deviceAuth = Buffer.alloc(16, 3).toString('base64url');
const env = { ...process.env };

before(async () => {
  process.env.PGKILN_PUSH_PRIVATE_HOSTS = '127.0.0.1';
  process.env.PGKILN_SECRET_KEY ??= 'push-test-secret-key-0123456789abcdefghij';
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(answer).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  await owner.query('update meta.app set pwa = true, pwa_push = true where id = $1', [appId]);
  // keys another test file created under its own PGKILN_SECRET_KEY can't be decrypted with this one
  await owner.query('delete from meta.push_key where app_id = $1', [appId]);
});

after(async () => {
  await owner.query('update meta.app set pwa_push = false where id = $1', [appId]);
  await owner.query('delete from meta.push_subscription where app_id = $1', [appId]);
  await owner.query('delete from meta.push_message where app_id = $1', [appId]);
  await owner.query('delete from meta.push_key where app_id = $1', [appId]);
  await owner.query(`update meta.account set active = true where username = 'allen'`);
  process.env = env;
  await app?.close();
  server?.close();
  await closePools();
});

/** meta.send_push as application code of HR calls it. */
async function sendPush(sql: string, params: unknown[] = []) {
  return owner.tx(async (c) => {
    await c.query(`select set_config('pgkiln.app_id', $1, true), set_config('pgkiln.app_user', 'king', true)`, [String(appId)]);
    return (await c.query(sql, params)).rows[0];
  });
}

/** The message and the user's devices, for a failure message. */
const pushState = async (id: string) =>
  JSON.stringify({
    message: await owner.one(`select status, devices, delivered, message, attempts from meta.push_message where id = $1`, [id]),
    devices: (await owner.query(`select endpoint, failures from meta.push_subscription where app_id = $1 and username = 'scott'`, [appId])).rows,
  });

const endpoint = (n: string) => `http://127.0.0.1:${port}/push/${n}`;
const subscription = (n: string) => ({ endpoint: endpoint(n), p256dh: device.getPublicKey().toString('base64url'), auth: deviceAuth });

describe('push notifications: subscribing on a device', () => {
  test('the page carries the key and the user; My account has the switch', async () => {
    const b = new Browser(app);
    await b.login('scott');
    const res = await b.get('/a/hr/account');
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /data-push="[A-Za-z0-9_-]{87}"/);
    assert.match(res.body, /data-push-user="scott"/);
    assert.match(res.body, /data-push-section/);
    assert.match(res.body, /"push.turn_on":/);
    // the key is public; the private key never reaches a page or an export
    const key = await owner.one('select private_key from meta.push_key where app_id = $1', [appId]);
    assert.match(key.private_key, /^v1:/);
    assert.doesNotMatch(JSON.stringify((await owner.one(`select meta.export_app('hr') as d`)).d), /push_key|private_key|push_subscription/);
  });

  test('subscribe: signed in, with the CSRF token, a push service endpoint and valid keys', async () => {
    const anon = new Browser(app);
    await anon.get('/a/hr/login');
    assert.notEqual((await anon.submit('/a/hr/push/subscribe', subscription('anon'))).statusCode, 200);

    const b = new Browser(app);
    await b.login('scott');
    await b.get('/a/hr/account');
    assert.equal((await b.post('/a/hr/push/subscribe', { ...subscription('x'), __csrf: 'wrong' })).statusCode, 403);
    assert.equal((await b.submit('/a/hr/push/subscribe', { ...subscription('x'), endpoint: 'https://evil.example.com/x' })).statusCode, 422);
    assert.equal((await b.submit('/a/hr/push/subscribe', { ...subscription('x'), endpoint: 'http://10.0.0.1/x' })).statusCode, 422);
    assert.equal((await b.submit('/a/hr/push/subscribe', { ...subscription('x'), p256dh: 'nope' })).statusCode, 422);
    assert.equal((await b.submit('/a/hr/push/subscribe', { ...subscription('x'), key: 'B'.repeat(87) })).statusCode, 409);
    assert.equal(await owner.one('select count(*)::int as n from meta.push_subscription where app_id = $1', [appId]).then((r) => r.n), 0);

    const ok = await b.submit('/a/hr/push/subscribe', subscription('scott-phone'));
    assert.equal(ok.statusCode, 200, ok.body);
    const row = await owner.one('select username, endpoint from meta.push_subscription where app_id = $1', [appId]);
    assert.deepEqual(row, { username: 'scott', endpoint: endpoint('scott-phone') });
    assert.equal(await sendPush(`select meta.has_push_subscription('SCOTT') as h`).then((r) => r.h), true);
    assert.equal(await sendPush(`select meta.has_push_subscription('blake') as h`).then((r) => r.h), false);
  });

  test('the same device subscribed by another user belongs to that user from then on', async () => {
    const b = new Browser(app);
    await b.login('blake');
    await b.get('/a/hr/account');
    assert.equal((await b.submit('/a/hr/push/subscribe', subscription('shared-tablet'))).statusCode, 200);
    const c = new Browser(app);
    await c.login('jones');
    await c.get('/a/hr/account');
    assert.equal((await c.submit('/a/hr/push/subscribe', subscription('shared-tablet'))).statusCode, 200);
    assert.equal((await owner.one('select username from meta.push_subscription where endpoint = $1', [endpoint('shared-tablet')])).username, 'jones');
    // unsubscribe: only one's own device
    await b.get('/a/hr/account');
    await b.submit('/a/hr/push/unsubscribe', { endpoint: endpoint('shared-tablet') });
    assert.ok(await owner.one('select 1 from meta.push_subscription where endpoint = $1', [endpoint('shared-tablet')]));
    await c.get('/a/hr/account');
    assert.equal((await c.submit('/a/hr/push/unsubscribe', { endpoint: endpoint('shared-tablet') })).statusCode, 200);
    assert.equal(await owner.one('select 1 from meta.push_subscription where endpoint = $1', [endpoint('shared-tablet')]), undefined);
  });

  test('an app without push notifications refuses subscriptions and has no key on its pages', async () => {
    await owner.query('update meta.app set pwa_push = false where id = $1', [appId]);
    try {
      const b = new Browser(app);
      await b.login('scott');
      const page = await b.get('/a/hr/account');
      assert.doesNotMatch(page.body, /data-push=/);
      assert.equal((await b.submit('/a/hr/push/subscribe', subscription('off'))).statusCode, 404);
      await assert.rejects(sendPush(`select meta.send_push('scott', 'Hi')`), /push notifications are off/);
    } finally {
      await owner.query('update meta.app set pwa_push = true where id = $1', [appId]);
    }
  });
});

describe('push notifications: sending', () => {
  test('meta.send_push checks its arguments', async () => {
    await assert.rejects(sendPush(`select meta.send_push('scott', '')`), /title is required/);
    await assert.rejects(sendPush(`select meta.send_push('scott', 'Hi', null, 999)`), /page 999 does not exist/);
    await assert.rejects(sendPush(`select meta.send_push('scott', 'Hi', p_tag => 'a b')`), /tag/);
    await assert.rejects(sendPush(`select meta.send_push('scott', 'Hi', p_urgency => 'now')`), /urgency/);
    await assert.rejects(sendPush(`select meta.send_push('scott', 'Hi', p_items => '{"P3_EMPNO": "1"}')`), /with a page/);
    await assert.rejects(owner.query(`select meta.send_push('scott', 'Hi')`), /no current application/);
  });

  test('a notification reaches the device: encrypted, signed with the app key, a link signed for the recipient', async () => {
    received.length = 0;
    answer = 201;
    const { id } = await sendPush(`select meta.send_push('scott', 'Leave request', 'Blake asks for 3 days', 3, '{"P3_EMPNO": "7788"}', 'leave-12', 'high', 600) as id`);
    await pushTick();
    assert.equal(received.length, 1, await pushState(id));
    const r = received[0];
    assert.equal(r.url, '/push/scott-phone');
    assert.equal(r.headers['content-encoding'], 'aes128gcm');
    assert.equal(r.headers.ttl, '600');
    assert.equal(r.headers.urgency, 'high');
    assert.equal(r.headers.topic, 'leave-12');
    const m = /^vapid t=([^,]+), k=([A-Za-z0-9_-]{87})$/.exec(String(r.headers.authorization))!;
    assert.ok(m, String(r.headers.authorization));
    const pub = Buffer.from(m[2], 'base64url');
    const key = await importJWK({ kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, 'ES256');
    await jwtVerify(m[1], key, { audience: `http://127.0.0.1:${port}` });
    const payload = JSON.parse(decrypt(r.body, device.getPrivateKey().toString('base64url'), deviceAuth));
    assert.equal(payload.title, 'Leave request');
    assert.equal(payload.body, 'Blake asks for 3 days');
    assert.equal(payload.tag, 'leave-12');
    const cs = (await owner.one(`select meta.url_checksum($1, 3, 'scott', '{"P3_EMPNO": "7788"}') as cs`, [appId])).cs;
    assert.equal(payload.url, `/a/hr/3?P3_EMPNO=7788&cs=${cs}`);
    const msg = await owner.one('select status, devices, delivered, requested_by from meta.push_message where id = $1', [id]);
    assert.deepEqual(msg, { status: 'sent', devices: 1, delivered: 1, requested_by: 'king' });
  });

  test('a rolled back transaction sends nothing; a user without a device gets "no_device"', async () => {
    received.length = 0;
    await assert.rejects(
      owner.tx(async (c) => {
        await c.query(`select set_config('pgkiln.app_id', $1, true)`, [String(appId)]);
        await c.query(`select meta.send_push('scott', 'Never')`);
        throw new Error('rollback');
      }),
      /rollback/,
    );
    const { id } = await sendPush(`select meta.send_push('allen', 'Nobody listens') as id`);
    await pushTick();
    assert.equal(received.length, 0);
    assert.equal((await owner.one('select status from meta.push_message where id = $1', [id])).status, 'no_device');
  });

  test('a device the push service no longer knows (410) is removed; a busy service is tried again later', async () => {
    answer = 503;
    const { id } = await sendPush(`select meta.send_push('scott', 'Busy') as id`);
    await pushTick();
    let msg = await owner.one('select status, attempts, not_before > now() as later from meta.push_message where id = $1', [id]);
    assert.deepEqual(msg, { status: 'queued', attempts: 1, later: true });
    answer = 410;
    await owner.query('update meta.push_message set not_before = now() where id = $1', [id]);
    await pushTick();
    msg = await owner.one('select status from meta.push_message where id = $1', [id]);
    assert.equal(msg.status, 'no_device');
    assert.equal(await owner.one('select 1 from meta.push_subscription where endpoint = $1', [endpoint('scott-phone')]), undefined);
    answer = 201;
  });

  test('a deactivated account, or removed access, ends its subscriptions', async () => {
    const b = new Browser(app);
    await b.login('allen');
    await b.get('/a/hr/account');
    assert.equal((await b.submit('/a/hr/push/subscribe', subscription('allen-1'))).statusCode, 200);
    await owner.query(`update meta.account set active = false where username = 'allen'`);
    assert.equal(await owner.one('select 1 from meta.push_subscription where endpoint = $1', [endpoint('allen-1')]), undefined);
    await owner.query(`update meta.account set active = true where username = 'allen'`);
  });

  test('the send_push process configuration is checked', () => {
    assert.deepEqual(processProblems('send_push', { to: '&P5_OWNER.', title: 'Hi', page: 5, items: { P5_ID: '&P5_ID.' }, urgency: 'high' }), []);
    assert.equal(processProblems('send_push', {}).length, 2);
    assert.ok(processProblems('send_push', { to: 'x', title: 'y', items: { P5_ID: '1' } }).some((p) => /needs a "page"/.test(p)));
    assert.ok(processProblems('send_push', { to: 'x', title: 'y', urgency: 'now' }).length);
  });
});
