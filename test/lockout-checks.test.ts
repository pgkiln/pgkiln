// Sprint 133 (SEC-6 leftovers): the lockout checks on Instance settings and the Workspace home, rotating the
// instance key, and the key backup confirmation.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
process.env.PGKILN_SECRET_KEY ||= 'test-only-secret-key-0123456789abcdef';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import {
  attentionCount, CLOCK_WARN_MS, confirmKeyBackup, databaseClockOffset, encryptedColumns, forgetAttention, instanceChecks, keyBackup,
  passkeysElsewhere, rotateKey, RotateError,
} from '../src/instance-checks.ts';
import { breakGlassAdmins } from '../src/devsso.ts';
import { decryptSecret, encryptSecret, keyFingerprint } from '../src/secrets.ts';
import { Browser } from './helpers.ts';

const A = 'rotate-test-key-A-0123456789abcdefghij';
const B = 'rotate-test-key-B-0123456789abcdefghij';
const C = 'rotate-test-key-C-0123456789abcdefghij';
const SCRATCH = { schema: 'lockout133', table: 'secrets', column: 'v_enc' };
const DEV = 'lock133_dev';
const WS = 'lock133 sso workspace';
let app: FastifyInstance;
let savedBackup: string | undefined;

before(async () => {
  savedBackup = (await owner.one<{ value: string }>(`select value from meta.setting where name = 'secret_key_backup'`))?.value;
  await owner.query('drop schema if exists lockout133 cascade; create schema lockout133; create table lockout133.secrets (id int primary key, v_enc text)');
  await owner.query('delete from meta.developer where username = $1', [DEV]);
  await owner.query(`insert into meta.developer (username, password_hash, is_admin) values ($1, meta.hash_password('Lock133-password!'), false)`, [DEV]);
  await owner.query('delete from meta.workspace where name = $1', [WS]);
  app = await buildApp({ logger: false });
});
after(async () => {
  await owner.query('drop schema if exists lockout133 cascade');
  await owner.query('delete from meta.developer where username = $1', [DEV]);
  await owner.query('delete from meta.workspace where name = $1', [WS]);
  if (savedBackup === undefined) await owner.query(`delete from meta.setting where name = 'secret_key_backup'`);
  else await owner.query(`update meta.setting set value = $1 where name = 'secret_key_backup'`, [savedBackup]);
  await app.close();
  await closePools();
});

describe('rotating the instance key', () => {
  test('every column with an encrypted secret is found', async () => {
    const cols = (await encryptedColumns()).map((c) => `${c.schema}.${c.table}.${c.column}`);
    for (const c of ['meta.developer_factor.secret_enc', 'meta.account_factor.secret_enc', 'meta.web_credential.secret_enc', 'meta.mail_service.secret_enc', 'meta.ai_service.api_key_enc', 'meta.push_key.private_key'])
      assert.ok(cols.includes(c), c);
  });

  test('re-encrypts from the old key to the new one, in one go, and a second run changes nothing', async () => {
    await owner.query('delete from lockout133.secrets');
    await owner.query('insert into lockout133.secrets values (1, $1), (2, $2), (3, null)', [encryptSecret('one', A), encryptSecret('two', A)]);
    const dry = await rotateKey(A, B, { dryRun: true, columns: [SCRATCH] });
    assert.equal(dry[0].rotated, 2);
    assert.equal(decryptSecret((await owner.one('select v_enc from lockout133.secrets where id = 1')).v_enc, A), 'one', 'a dry run changes nothing');
    const done = await rotateKey(A, B, { columns: [SCRATCH] });
    assert.deepEqual(done.map((c) => [c.rotated, c.already]), [[2, 0]]);
    const rows = (await owner.query('select id, v_enc from lockout133.secrets where v_enc is not null order by id')).rows;
    assert.deepEqual(rows.map((r) => decryptSecret(r.v_enc, B)), ['one', 'two']);
    assert.throws(() => decryptSecret(rows[0].v_enc, A));
    const again = await rotateKey(A, B, { columns: [SCRATCH] });
    assert.deepEqual(again.map((c) => [c.rotated, c.already]), [[0, 2]]);
  });

  test('a secret neither key decrypts stops the rotation and nothing changes', async () => {
    await owner.query('delete from lockout133.secrets');
    await owner.query('insert into lockout133.secrets values (1, $1), (2, $2)', [encryptSecret('one', A), encryptSecret('lost', C)]);
    await assert.rejects(rotateKey(A, B, { columns: [SCRATCH] }), (e: Error) => e instanceof RotateError && /neither key.*lockout133\.secrets\.v_enc \(1\)/.test(e.message));
    assert.equal(decryptSecret((await owner.one('select v_enc from lockout133.secrets where id = 1')).v_enc, A), 'one');
  });

  test('refuses short or equal keys', async () => {
    await assert.rejects(rotateKey('short', B, { columns: [SCRATCH] }), /32 characters/);
    await assert.rejects(rotateKey(A, A, { columns: [SCRATCH] }), /the old key/);
  });

  test('a key fingerprint is stable, differs per key and says nothing for no key', () => {
    assert.equal(keyFingerprint(A), keyFingerprint(A));
    assert.notEqual(keyFingerprint(A), keyFingerprint(B));
    assert.match(keyFingerprint(A)!, /^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
    assert.equal(keyFingerprint('short'), null);
  });
});

describe('lockout checks', () => {
  test('the key backup is confirmed per key', async () => {
    await owner.query(`delete from meta.setting where name = 'secret_key_backup'`);
    assert.equal((await instanceChecks(null)).find((c) => c.key === 'key_backup')!.level, 'warning');
    assert.ok(await confirmKeyBackup('tester'));
    assert.equal((await keyBackup())!.fingerprint, keyFingerprint());
    const ok = (await instanceChecks(null)).find((c) => c.key === 'key_backup')!;
    assert.equal(ok.level, 'ok');
    assert.match(ok.detail, /tester confirmed/);
    await owner.query(`update meta.setting set value = jsonb_set(value::jsonb, '{fingerprint}', '"0000-0000-0000-0000"')::text where name = 'secret_key_backup'`);
    assert.match((await instanceChecks(null)).find((c) => c.key === 'key_backup')!.detail, /The key changed/);
  });

  test('the server and database clocks are compared', async () => {
    assert.ok(Math.abs(await databaseClockOffset()) < CLOCK_WARN_MS);
    assert.equal((await instanceChecks(null)).find((c) => c.key === 'clock')!.level, 'ok');
  });

  test('passkeys of another domain, and who has no other factor', async () => {
    const pk = (id: string, rp: string) => owner.query(
      `insert into meta.developer_factor (username, kind, name, credential_id, public_key, alg, rp_id) values ($1, 'passkey', 'Key', $2, '{}', -7, $3)`, [DEV, id, rp]);
    await pk('lock133-a', 'old.lock133.example');
    const mine = () => passkeysElsewhere('new.lock133.example').then((r) => r.find((x) => x.rpId === 'old.lock133.example' && x.who === 'developers'));
    assert.deepEqual(await mine(), { who: 'developers', rpId: 'old.lock133.example', passkeys: 1, people: 1, stranded: 1 });
    await pk('lock133-b', 'new.lock133.example');
    assert.equal((await mine())!.stranded, 0, 'a passkey for the new domain is another factor');
    const check = (await instanceChecks('new.lock133.example')).find((c) => c.key === 'passkey_domain')!;
    assert.match(check.detail, /old\.lock133\.example: 1 passkey of 1 developer/);
    await owner.query('delete from meta.developer_factor where username = $1', [DEV]);
  });

  test('a workspace that requires single sign-on needs a break-glass administrator', async () => {
    assert.equal((await instanceChecks(null)).find((c) => c.key === 'break_glass' && c.detail.includes(WS)), undefined);
    await owner.query('insert into meta.workspace (name, sso_only) values ($1, true)', [WS]);
    const check = (await instanceChecks(null)).find((c) => c.key === 'break_glass')!;
    assert.ok(check.detail.includes(WS));
    assert.equal(check.level === 'error', (await breakGlassAdmins()).length === 0);
    await owner.query('delete from meta.workspace where name = $1', [WS]);
  });

  test('Instance settings lists the checks and confirms a backup; the Workspace home counts them', async () => {
    await owner.query(`delete from meta.setting where name = 'secret_key_backup'`);
    forgetAttention();
    assert.ok((await attentionCount()) >= 1);
    const b = new Browser(app);
    await b.get('/builder/login');
    await b.submit('/builder/login', { username: 'admin', password: 'admin' });
    const home = await b.get('/builder/home');
    assert.equal(home.statusCode, 200);
    assert.match(home.body, /Lockout checks that need attention: \d+\. <a href="\/builder\/instance#lockout-checks">/);
    const page = await b.get('/builder/instance');
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /id="lockout-checks"/);
    assert.match(page.body, /I have a copy of this key/);
    const r = await b.submit('/builder/instance/key-backup', {});
    assert.equal(r.statusCode, 303);
    assert.equal((await keyBackup())!.by, 'admin');
    assert.ok(await owner.one(`select 1 from meta.activity_log where event = 'secret_key' and username = 'admin' and detail = 'backup confirmed'`));
    assert.doesNotMatch((await b.get('/builder/instance')).body, /I have a copy of this key/);
  });
});
