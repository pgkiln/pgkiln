// Sprint 127 (SEC-2 part 2): passkeys for developers and trusted browsers. A software authenticator (an EC
// P-256 or Ed25519 key made here) answers the server's WebAuthn options the way a browser would.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { setPolicy, setTrustDays } from '../src/mfa.ts';
import { cborDecode, relyingParty, verifyAssertion, verifyRegistration, WebAuthnError } from '../src/webauthn.ts';
import { Browser } from './helpers.ts';

const DEV = 'pk127_dev';
const PW = 'Pk127-password!';
const ORIGIN = 'http://localhost:80';
let app: FastifyInstance;

// ------------------------------------------------------------------ a small CBOR encoder (for the test only)

function cbor(v: unknown): Buffer {
  const head = (major: number, n: number) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
    const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
  };
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error('unsupported');
}

const b64u = (b: Buffer) => b.toString('base64url');
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest();

class Authenticator {
  readonly id: Buffer;
  readonly priv: KeyObject;
  readonly pub: KeyObject;
  count = 0;
  constructor(readonly kind: 'es256' | 'ed25519' = 'es256', readonly counts = true) {
    this.id = Buffer.from(Array.from({ length: 16 }, () => Math.floor(Math.random() * 256)));
    const k = kind === 'es256' ? generateKeyPairSync('ec', { namedCurve: 'P-256' }) : generateKeyPairSync('ed25519');
    this.priv = k.privateKey;
    this.pub = k.publicKey;
  }
  cose() {
    const j = this.pub.export({ format: 'jwk' });
    return this.kind === 'es256'
      ? new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(j.x!, 'base64url')], [-3, Buffer.from(j.y!, 'base64url')]])
      : new Map<number, unknown>([[1, 1], [3, -8], [-1, 6], [-2, Buffer.from(j.x!, 'base64url')]]);
  }
  authData(rpId: string, attested: boolean, flags = 0x05) {
    const c = Buffer.alloc(4);
    c.writeUInt32BE(this.counts ? ++this.count : 0);
    const parts: Buffer[] = [sha(rpId), Buffer.from([flags | (attested ? 0x40 : 0)]), c];
    if (attested) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(this.id.length);
      parts.push(Buffer.alloc(16), len, this.id, cbor(this.cose()));
    }
    return Buffer.concat(parts);
  }
  create(challenge: string, origin = ORIGIN, rpId = 'localhost') {
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin }));
    const attestationObject = cbor(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', this.authData(rpId, true)]]));
    return { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject) };
  }
  get(challenge: string, origin = ORIGIN, rpId = 'localhost') {
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin }));
    const authenticatorData = this.authData(rpId, false);
    const data = Buffer.concat([authenticatorData, sha(clientDataJSON)]);
    const signature = this.kind === 'es256' ? sign('sha256', data, this.priv) : sign(null, data, this.priv);
    return { credentialId: b64u(this.id), clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authenticatorData), signature: b64u(signature) };
  }
}

async function signIn(b: Browser, username = DEV, password = PW) {
  await b.get('/builder/login');
  return b.submit('/builder/login', { username, password });
}

/** Ask the server for options (as builder.js does) and return them. */
async function options(b: Browser, url: string) {
  const r = await b.request('POST', url, { __csrf: b.lastCsrf });
  assert.equal(r.statusCode, 200, r.body);
  return JSON.parse(r.body);
}

before(async () => {
  await owner.query('delete from meta.developer where username = $1', [DEV]);
  await owner.query('insert into meta.developer (username, password_hash) values ($1, meta.hash_password($2))', [DEV, PW]);
  app = await buildApp({ logger: false });
});
after(async () => {
  await owner.query('delete from meta.developer where username = $1', [DEV]);
  await setTrustDays(0);
  await setPolicy('off', 7);
  await app.close();
  await closePools();
});

describe('WebAuthn checks', () => {
  const exp = { challenge: 'Y2hhbGxlbmdl', origin: ORIGIN, rpId: 'localhost' };

  test('a registration and an assertion, ES256 and Ed25519', () => {
    for (const kind of ['es256', 'ed25519'] as const) {
      const a = new Authenticator(kind);
      const reg = verifyRegistration(a.create(exp.challenge), exp);
      assert.equal(reg.credentialId, b64u(a.id));
      assert.equal(reg.alg, kind === 'es256' ? -7 : -8);
      const r = verifyAssertion(a.get(exp.challenge), { alg: reg.alg, jwk: reg.jwk, signCount: reg.signCount }, exp);
      assert.equal(r.signCount, 2);
    }
  });

  test('wrong challenge, origin, relying party, type or signature are refused', () => {
    const a = new Authenticator();
    const reg = verifyRegistration(a.create(exp.challenge), exp);
    const stored = { alg: reg.alg, jwk: reg.jwk, signCount: reg.signCount };
    assert.throws(() => verifyRegistration(a.create('b3RoZXI'), exp), WebAuthnError, 'challenge');
    assert.throws(() => verifyRegistration(a.create(exp.challenge, 'https://evil.example'), exp), /origin/);
    assert.throws(() => verifyRegistration(a.create(exp.challenge, ORIGIN, 'evil.example'), exp), /another site/);
    assert.throws(() => verifyAssertion({ ...a.get(exp.challenge), clientDataJSON: a.create(exp.challenge).clientDataJSON }, stored, exp), /webauthn.get/);
    const other = new Authenticator();
    assert.throws(() => verifyAssertion(other.get(exp.challenge), stored, exp), /signature/);
    const bad = a.get(exp.challenge);
    assert.throws(() => verifyAssertion({ ...bad, signature: b64u(Buffer.alloc(70)) }, stored, exp), WebAuthnError);
  });

  test('the signature counter must go up; 0 and 0 means none is kept', () => {
    const a = new Authenticator();
    const reg = verifyRegistration(a.create(exp.challenge), exp);
    assert.throws(() => verifyAssertion(a.get(exp.challenge), { alg: reg.alg, jwk: reg.jwk, signCount: 50 }, exp), /counter/);
    const synced = new Authenticator('es256', false);
    const r2 = verifyRegistration(synced.create(exp.challenge), exp);
    assert.equal(verifyAssertion(synced.get(exp.challenge), { alg: r2.alg, jwk: r2.jwk, signCount: 0 }, exp).signCount, 0);
  });

  test('CBOR: bad input throws a WebAuthnError, never hangs', () => {
    for (const b of [Buffer.from([0x5f]), Buffer.from([0x59, 0xff, 0xff]), Buffer.from([0xbb, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff]), Buffer.alloc(0)])
      assert.throws(() => cborDecode(b), WebAuthnError);
    let deep = Buffer.from([0x01]);
    for (let i = 0; i < 40; i++) deep = Buffer.concat([Buffer.from([0x81]), deep]);
    assert.throws(() => cborDecode(deep), /deep/);
  });

  test('the relying party: the browser\'s host, or PUBLIC_URL, and PGKILN_RP_ID only as a parent domain', () => {
    const keep = { pub: process.env.PUBLIC_URL, rp: process.env.PGKILN_RP_ID };
    try {
      delete process.env.PUBLIC_URL;
      delete process.env.PGKILN_RP_ID;
      assert.deepEqual(relyingParty({ protocol: 'http', host: 'localhost:3100' }), { rpId: 'localhost', origin: 'http://localhost:3100' });
      process.env.PUBLIC_URL = 'https://builder.example.com';
      assert.deepEqual(relyingParty({ protocol: 'http', host: 'attacker.test' }), { rpId: 'builder.example.com', origin: 'https://builder.example.com' });
      process.env.PGKILN_RP_ID = 'example.com';
      assert.equal(relyingParty({ protocol: 'http', host: 'x' }).rpId, 'example.com');
      process.env.PGKILN_RP_ID = 'other.org';
      assert.equal(relyingParty({ protocol: 'http', host: 'x' }).rpId, 'builder.example.com', 'not a parent domain: ignored');
    } finally {
      if (keep.pub === undefined) delete process.env.PUBLIC_URL; else process.env.PUBLIC_URL = keep.pub;
      if (keep.rp === undefined) delete process.env.PGKILN_RP_ID; else process.env.PGKILN_RP_ID = keep.rp;
    }
  });
});

describe('passkeys for developers', () => {
  const key = new Authenticator();
  let codes: string[] = [];

  test('a developer adds a passkey on the Security page; recovery codes follow', async () => {
    const b = new Browser(app);
    await signIn(b);
    const page = (await b.get('/builder/security')).body;
    assert.match(page, /data-passkey="\/builder\/security\/passkey\/options"/);
    assert.match(page, /<button[^>]*hidden[^>]*data-passkey=/, 'hidden until builder.js finds WebAuthn');
    const o = await options(b, '/builder/security/passkey/options');
    assert.equal(o.rp.id, 'localhost');
    assert.ok(!JSON.stringify(o.user.id).includes(DEV), 'the user handle is not the user name');
    const r = await b.submit('/builder/security/passkey', { pk_name: 'Laptop', ...key.create(o.challenge), transports: 'internal,hybrid' });
    assert.equal(r.headers.location, '/builder/security#codes');
    const row = await owner.one<{ kind: string; name: string; transports: string[]; secret_enc: string | null }>('select kind, name, transports, secret_enc from meta.developer_factor where username = $1', [DEV]);
    assert.deepEqual([row!.kind, row!.name, row!.transports, row!.secret_enc], ['passkey', 'Laptop', ['internal', 'hybrid'], null]);
    const shown = (await b.get('/builder/security')).body;
    codes = [...shown.matchAll(/<li><code>([a-z0-9]{5}-[a-z0-9]{5})<\/code><\/li>/g)].map((m) => m[1]);
    assert.equal(codes.length, 10);
    await b.submit('/builder/security/codes/confirm', { saved: '1' });
  });

  test('the challenge works once, and only for its purpose', async () => {
    const b = new Browser(app);
    await signIn(b);
    await b.get('/builder/login/2fa');
    await b.submit('/builder/login/2fa', { code: codes[0] });
    await b.get('/builder/security');
    const o = await options(b, '/builder/security/passkey/options');
    const other = new Authenticator();
    const answer = other.create(o.challenge);
    await b.submit('/builder/security/passkey', { pk_name: 'x', ...answer });
    await b.get('/builder/security');
    await b.submit('/builder/security/passkey', { pk_name: 'y', ...answer });
    assert.equal((await owner.one<{ n: number }>('select count(*)::int as n from meta.developer_factor where username = $1', [DEV]))!.n, 2, 'the replay added nothing');
    await owner.query(`delete from meta.developer_factor where username = $1 and name = 'x'`, [DEV]);
  });

  test('sign-in: the second step offers the passkey and accepts it', async () => {
    const b = new Browser(app);
    const r = await signIn(b);
    assert.equal(r.headers.location, '/builder/login/2fa');
    const page = (await b.get('/builder/login/2fa')).body;
    assert.match(page, /data-passkey-submit="\/builder\/login\/2fa\/passkey"/);
    const o = await options(b, '/builder/login/2fa/passkey/options');
    assert.deepEqual(o.allow.map((a: { id: string }) => a.id), [b64u(key.id)]);
    const ok = await b.submit('/builder/login/2fa/passkey', key.get(o.challenge));
    assert.equal(ok.statusCode, 303);
    assert.equal((await b.get('/builder/apps')).statusCode, 200);
    assert.ok(await owner.one(`select 1 from meta.activity_log where username = $1 and event = 'login' and detail = 'builder 2fa (passkey)'`, [DEV]));
  });

  test('a replayed or foreign answer is refused and counts as a failed sign-in', async () => {
    const b = new Browser(app);
    await signIn(b);
    await b.get('/builder/login/2fa');
    const o = await options(b, '/builder/login/2fa/passkey/options');
    const answer = key.get(o.challenge);
    await b.submit('/builder/login/2fa/passkey', { ...answer, signature: new Authenticator().get(o.challenge).signature });
    assert.notEqual((await b.get('/builder/apps')).statusCode, 200);
    await b.get('/builder/login/2fa');
    await b.submit('/builder/login/2fa/passkey', answer);
    assert.notEqual((await b.get('/builder/apps')).statusCode, 200, 'the challenge was used up');
    assert.ok(await owner.one(`select 1 from meta.activity_log where username = $1 and event = 'login_failed' and detail like 'builder 2fa passkey:%'`, [DEV]));
    const c = new Browser(app);
    await c.get('/builder/login');
    assert.equal((await c.request('POST', '/builder/login/2fa/passkey/options', { __csrf: c.lastCsrf })).statusCode, 403, 'not without the password step');
  });

  test('trusted browsers: off by default; on, the second step is skipped until forgotten', async () => {
    const b = new Browser(app);
    await signIn(b);
    assert.doesNotMatch((await b.get('/builder/login/2fa')).body, /Trust this browser/);
    await setTrustDays(30);
    const page = (await b.get('/builder/login/2fa')).body;
    assert.match(page, /Trust this browser for 30 days/);
    const o = await options(b, '/builder/login/2fa/passkey/options');
    await b.submit('/builder/login/2fa/passkey', { ...key.get(o.challenge), trust: '1' });
    assert.ok(b.cookies.get('pgkiln_btrust'));
    const stored = await owner.one<{ token_hash: string }>('select token_hash from meta.developer_trusted_browser where username = $1', [DEV]);
    assert.ok(stored && stored.token_hash !== b.cookies.get('pgkiln_btrust'), 'only the hash is stored');
    // a new sign-in in the same browser: straight in
    await b.submit('/builder/logout', {});
    const again = await signIn(b);
    assert.notEqual(again.headers.location, '/builder/login/2fa');
    assert.equal((await b.get('/builder/apps')).statusCode, 200);
    // another browser still gets the second step
    assert.equal((await signIn(new Browser(app))).headers.location, '/builder/login/2fa');
    // forgotten on the Security page
    await b.get('/builder/security');
    await b.submit('/builder/security/forget-browsers', {});
    await b.submit('/builder/logout', {});
    assert.equal((await signIn(b)).headers.location, '/builder/login/2fa');
  });

  test('turning trust off stops trusted browsers at once', async () => {
    const b = new Browser(app);
    await signIn(b);
    await b.get('/builder/login/2fa');
    const o = await options(b, '/builder/login/2fa/passkey/options');
    await b.submit('/builder/login/2fa/passkey', { ...key.get(o.challenge), trust: '1' });
    await setTrustDays(0);
    await b.get('/builder/apps');
    await b.submit('/builder/logout', {});
    assert.equal((await signIn(b)).headers.location, '/builder/login/2fa');
  });

  test('removing the passkey asks for the password and removes the codes when it was the last factor', async () => {
    const b = new Browser(app);
    await signIn(b);
    await b.get('/builder/login/2fa');
    await b.submit('/builder/login/2fa', { code: codes[1] });
    const f = await owner.one<{ id: number }>('select id from meta.developer_factor where username = $1', [DEV]);
    await b.get('/builder/security');
    await b.submit(`/builder/security/factor/${f!.id}/delete`, { [`password_${f!.id}`]: PW });
    assert.equal(await owner.one('select 1 from meta.developer_factor where username = $1', [DEV]), undefined);
    assert.equal(await owner.one('select 1 from meta.developer_recovery_code where username = $1', [DEV]), undefined);
  });
});
