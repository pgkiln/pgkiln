// NX-S3 (the default password and two-factor sign-in on a public installation) and NX-U2 (the login page picker
// lists the pages that can be one).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { defaultPasswords, forgetAttention, instanceChecks, publicInstance } from '../src/instance-checks.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let hr = 0;
const PUB = 'http://pgkiln.example.com';
const withPublic = async <T>(fn: () => Promise<T>): Promise<T> => {
  const keep = process.env.PUBLIC_URL;
  process.env.PUBLIC_URL = PUB;
  forgetAttention();
  try {
    return await fn();
  } finally {
    if (keep === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = keep;
    forgetAttention();
  }
};
const signIn = async (username: string, password: string) => {
  const b = new Browser(app);
  await b.get('/builder/login');
  await b.submit('/builder/login', { username, password });
  return b;
};

before(async () => {
  app = await buildApp({ logger: false });
  hr = (await owner.one(`select id from meta.app where alias = 'hr'`))!.id;
  await owner.query(`delete from meta.developer where username = 'nxs3_dev'`);
});
after(async () => {
  await owner.query(`delete from meta.developer where username = 'nxs3_dev'`);
  await owner.query(`delete from meta.page where app_id = $1 and page_no in (9701, 9702)`, [hr]);
  await app.close();
  await closePools();
});

describe('NX-S3: the default password on a public installation', () => {
  test('public means PUBLIC_URL names another computer', () => {
    for (const u of [undefined, '', 'not a url', 'http://localhost:3100', 'http://127.0.0.1:3100', 'http://dev.localhost', 'http://[::1]:3100'])
      assert.equal(publicInstance(u), false, String(u));
    for (const u of ['https://pgkiln.example.com', 'http://10.0.0.5:3100', 'https://apps.vargar.eu'])
      assert.equal(publicInstance(u), true, u);
  });

  test('the default passwords are "admin" and the user name; a real password is not one', async () => {
    await owner.query(`insert into meta.developer (username, password_hash, is_admin) values ('nxs3_dev', meta.hash_password('nxs3_dev'), false)`);
    try {
      const weak = await defaultPasswords();
      assert.ok(weak.includes('admin'), 'admin / admin, as installed');
      assert.ok(weak.includes('nxs3_dev'), 'the password is the user name');
      await owner.query(`update meta.developer set password_hash = meta.hash_password('a much longer passphrase 42') where username = 'nxs3_dev'`);
      assert.ok(!(await defaultPasswords()).includes('nxs3_dev'));
    } finally {
      await owner.query(`delete from meta.developer where username = 'nxs3_dev'`);
    }
  });

  test('locally: a banner, and the builder works; publicly: only the password form until it is changed', async () => {
    const local = await signIn('admin', 'admin');
    assert.equal((await local.get(`/builder/apps/${hr}`)).statusCode, 200);
    await withPublic(async () => {
      const b = await signIn('admin', 'admin');
      for (const url of ['/builder', `/builder/apps/${hr}`, '/builder/sql/worksheet', '/builder/instance']) {
        const res = await b.get(url);
        assert.equal(res.statusCode, 302, url);
        assert.equal(res.headers.location, '/builder/developers', url);
      }
      const dev = await b.get('/builder/developers');
      assert.equal(dev.statusCode, 200);
      assert.match(dev.body, /choose a new password to continue/);
    });
  });

  test('the lockout checks: an error for the default password and a warning for administrators without two-factor, only when public', async () => {
    const keys = (cs: { key: string }[]) => cs.map((c) => c.key);
    assert.ok(!keys(await instanceChecks(null)).includes('default_password'));
    await withPublic(async () => {
      const checks = await instanceChecks(null);
      const weak = checks.find((c) => c.key === 'default_password');
      assert.equal(weak?.level, 'error');
      assert.match(weak!.detail, /admin/);
      const policy = (await owner.one(`select value from meta.setting where name = 'mfa_required'`))?.value ?? 'off';
      if (policy !== 'admins' && policy !== 'all') assert.equal(checks.find((c) => c.key === 'admin_mfa')?.level, 'warning');
    });
  });

  test('the server refuses to start on a public address while a default password is left', async () => {
    const out = await new Promise<{ code: number | null; text: string }>((resolve) => {
      const p = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
        env: { ...process.env, PUBLIC_URL: 'https://pgkiln.example.com', PORT: '0', AUTOMATIONS: 'off', WORKFLOWS: 'off', BACKGROUND_PROCESSES: 'off', WEBHOOKS: 'off', EMBEDDINGS: 'off' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let text = '';
      p.stdout.on('data', (d) => (text += d));
      p.stderr.on('data', (d) => (text += d));
      const t = setTimeout(() => p.kill('SIGKILL'), 60_000);
      p.on('exit', (code) => {
        clearTimeout(t);
        resolve({ code, text });
      });
    });
    assert.equal(out.code, 1, out.text.slice(0, 500));
    assert.match(out.text, /is a public address, and admin still signs in with the default password/);
  });
});

describe('NX-U2: the login page picker', () => {
  test('lists public pages with a Login region, keeps the current choice with its problem, and counts the rest', async () => {
    await owner.query(`delete from meta.page where app_id = $1 and page_no in (9701, 9702)`, [hr]);
    const good = (await owner.one(`insert into meta.page (app_id, page_no, name, requires_auth) values ($1, 9701, 'Sign in here', false) returning id`, [hr]))!.id;
    await owner.query(`insert into meta.region (page_id, type, title) values ($1, 'login', 'Sign in')`, [good]);
    await owner.query(`insert into meta.page (app_id, page_no, name, requires_auth) values ($1, 9702, 'Public, no login', false)`, [hr]);
    const keep = (await owner.one('select login_page from meta.app where id = $1', [hr]))!.login_page;
    try {
      const b = await signIn('admin', 'admin');
      const pick = async () => /<select id="f_login_page"[\s\S]*?<\/select>/.exec((await b.get(`/builder/apps/${hr}/settings?tab=signin`)).body)?.[0] ?? '';
      let sel = await pick();
      assert.match(sel, /<option value="9701"[^>]*>9701 Sign in here<\/option>/);
      assert.doesNotMatch(sel, /value="9702"/, 'no Login region');
      assert.doesNotMatch(sel, /requires sign-in: not usable/);
      const total = (await owner.one('select count(*)::int as n from meta.page where app_id = $1', [hr]))!.n;
      const body = (await b.get(`/builder/apps/${hr}/settings?tab=signin`)).body;
      assert.match(body, new RegExp(`${total - 1} pages need sign-in or have no Login region and aren&#39;t listed`));
      // a current choice that isn't usable stays listed, with why
      await owner.query('update meta.app set login_page = 9702 where id = $1', [hr]);
      sel = await pick();
      assert.match(sel, /<option value="9702" selected>9702 Public, no login \(no Login region: not usable\)<\/option>/);
    } finally {
      await owner.query('update meta.app set login_page = $2 where id = $1', [hr, keep]);
    }
  });
});
