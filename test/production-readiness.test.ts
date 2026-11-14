// (sprint 191, NX-S6) The production readiness check: a group of the lockout checks when PUBLIC_URL is an https
// address of a public host (or pgkiln admin check --production), every line ok or an error.
import { after, afterEach, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { root } from '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { instanceChecks, productionChecks, productionInstance } from '../src/instance-checks.ts';
import { Browser } from './helpers.ts';

const ENV = ['PUBLIC_URL', 'COOKIE_SECURE', 'PGKILN_REST_ALLOWED_HOSTS', 'PGKILN_SECRET_KEY'] as const;
const saved: Record<string, string | undefined> = {};
let app: FastifyInstance;
const APP = 'nx-s6-debug';

before(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  app = await buildApp({ logger: false });
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
after(async () => {
  await owner.query('delete from meta.app where alias = $1', [APP]);
  await app.close();
  await closePools();
});

const byKey = async (url?: string) => Object.fromEntries((await productionChecks(url)).map((c) => [c.key, c]));

describe('sprint 191 production readiness (NX-S6)', () => {
  test('only an https address of a public host is a production installation', () => {
    assert.equal(productionInstance('https://apps.example.com'), true);
    assert.equal(productionInstance('http://apps.example.com'), false);
    assert.equal(productionInstance('https://localhost:3100'), false);
    assert.equal(productionInstance('https://127.0.0.1'), false);
    assert.equal(productionInstance(undefined), false);
  });

  test('each line is ok or an error: https, secure cookies, outbound hosts, the key, two-factor, passwords, roles, debug', async () => {
    delete process.env.COOKIE_SECURE;
    delete process.env.PGKILN_REST_ALLOWED_HOSTS;
    let c = await byKey('http://apps.example.com');
    assert.equal(c.prod_https.level, 'error');
    assert.equal(c.prod_cookies.level, 'error');
    assert.match(c.prod_cookies.detail, /COOKIE_SECURE=true/);
    assert.equal(c.prod_rest_hosts.level, 'error');
    for (const x of Object.values(c)) assert.ok(x.level === 'ok' || x.level === 'error', `${x.key}: ${x.level}`);
    process.env.COOKIE_SECURE = 'true';
    process.env.PGKILN_REST_ALLOWED_HOSTS = 'api.example.com';
    c = await byKey('https://apps.example.com');
    assert.equal(c.prod_https.level, 'ok');
    assert.equal(c.prod_cookies.level, 'ok');
    assert.equal(c.prod_rest_hosts.level, 'ok');
    assert.match(c.prod_rest_hosts.detail, /api\.example\.com/);
    // an application with debug mode on is named
    await owner.query('delete from meta.app where alias = $1', [APP]);
    await owner.query(`insert into meta.app (alias, name, authentication, db_role, debug) values ($1, 'NX-S6', 'none', (select db_role from meta.app where alias = 'hr'), true)`, [APP]);
    c = await byKey('https://apps.example.com');
    assert.equal(c.prod_debug.level, 'error');
    assert.match(c.prod_debug.detail, new RegExp(`${APP} \\(debug mode\\)`));
    await owner.query('update meta.app set debug = false where alias = $1', [APP]);
    c = await byKey('https://apps.example.com');
    assert.doesNotMatch(c.prod_debug.detail, new RegExp(APP));
    // the instance key: not set is an error, as is a key without a confirmed backup
    delete process.env.PGKILN_SECRET_KEY;
    c = await byKey('https://apps.example.com');
    assert.equal(c.prod_key.level, 'error');
    assert.match(c.prod_key.detail, /not set/);
  });

  test('the group is part of the lockout checks only on a production installation, or when asked', async () => {
    process.env.PUBLIC_URL = 'http://localhost:3100';
    assert.ok(!(await instanceChecks(null)).some((c) => c.group === 'production'));
    assert.ok((await instanceChecks(null, { production: true })).some((c) => c.group === 'production'));
    process.env.PUBLIC_URL = 'https://apps.example.com';
    const list = await instanceChecks(null);
    assert.equal(list[0].group, 'production', 'first: on a live installation it matters most');
    // the public-installation lines of NX-S3 are in the group, not twice
    assert.ok(!list.some((c) => c.key === 'default_password' || c.key === 'admin_mfa'));
  });

  test('pgkiln admin check --production fails a deploy pipeline until every line is ready', () => {
    const run = (env: Record<string, string>) => {
      const r = spawnSync(process.execPath, [join(root, 'bin/pgkiln.js'), 'admin', 'check', '--production'], {
        encoding: 'utf8', env: { ...process.env, PUBLIC_URL: '', COOKIE_SECURE: '', PGKILN_REST_ALLOWED_HOSTS: '', ...env } });
      return { code: r.status, out: r.stdout, err: r.stderr };
    };
    const r = run({});
    assert.equal(r.code, 1, r.err);
    assert.match(r.out, /^Production readiness \(\d+ of 8 ready\)/m);
    assert.match(r.out, /ERROR\s+Secure cookies and HSTS/);
    assert.match(r.out, /^Lockout checks$/m);
    // without --production on a developer's machine: no group
    const plain = spawnSync(process.execPath, [join(root, 'bin/pgkiln.js'), 'admin', 'check'], { encoding: 'utf8', env: { ...process.env, PUBLIC_URL: '' } });
    assert.doesNotMatch(plain.stdout, /Production readiness/);
  });

  test('Instance settings shows the group to administrators', async () => {
    // on a public address a default password leads to Choose a new password (NX-S3): a strong one for this test
    const hash = (await owner.one(`select password_hash from meta.developer where username = 'admin'`))!.password_hash;
    await owner.query(`update meta.developer set password_hash = meta.hash_password('Nx-S6-strong-password!') where username = 'admin'`);
    try {
      process.env.PUBLIC_URL = 'https://apps.example.com';
      const b = new Browser(app);
      await b.get('/builder/login');
      await b.post('/builder/login', { __csrf: b.lastCsrf, username: 'admin', password: 'Nx-S6-strong-password!' });
      const res = await b.get('/builder/instance');
      assert.equal(res.statusCode, 200, String(res.headers.location ?? ''));
      assert.match(res.body, /<h3 id="production-readiness">Production readiness: \d+ of 8 ready<\/h3>/);
      assert.match(res.body, /pgkiln admin check --production/);
      assert.match(res.body, /Secure cookies and HSTS/);
    } finally {
      await owner.query(`update meta.developer set password_hash = $1 where username = 'admin'`, [hash]);
    }
  });
});
