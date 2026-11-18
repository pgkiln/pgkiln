// Sprint 225 (parity: Workspaces, "Missing: developers created by a workspace administrator"): a workspace's
// administrators create builder accounts that belong to their workspace only (never installation administrators)
// and remove those who belong to no other workspace.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let ws: number;
let other: number;
const ADMIN = 'wd225admin';
const MEMBER = 'wd225member';
const SHARED = 'wd225shared';
const PW = 'a-long-password-225';

const wipe = async () => {
  await owner.query(`delete from meta.developer where username like 'wd225%' or username like 'nd225%'`);
  await owner.query(`delete from meta.workspace where name like 'WD225%'`);
};
before(async () => {
  app = await buildApp({ logger: false });
  await wipe();
  ws = (await owner.one(`insert into meta.workspace (name) values ('WD225 Team') returning id`)).id;
  other = (await owner.one(`insert into meta.workspace (name) values ('WD225 Other') returning id`)).id;
  for (const u of [ADMIN, MEMBER, SHARED]) await owner.query(`insert into meta.developer (username, password_hash, is_admin) values ($1, meta.hash_password($2), false)`, [u, PW]);
  await owner.query(`delete from meta.workspace_member where username like 'wd225%'`);
  await owner.query(`insert into meta.workspace_member (workspace_id, username, is_admin) values ($1, $2, true), ($1, $3, false), ($1, $4, false), ($5, $4, false)`, [ws, ADMIN, MEMBER, SHARED, other]);
});
after(async () => {
  await wipe();
  await app.close();
  await closePools();
});

const signIn = async (username: string, password = PW) => {
  const b = new Browser(app);
  await b.get('/builder/login');
  assert.equal((await b.submit('/builder/login', { username, password })).statusCode, 303, username);
  await b.get(`/builder/workspaces/${ws}`);
  return b;
};
const membership = async (u: string) => (await owner.query('select workspace_id, is_admin from meta.workspace_member where username = $1 order by workspace_id', [u])).rows;
const messages = async (b: Browser, url: string) => [...(await b.get(url)).body.matchAll(/<div class="alert alert-(?:error|success)"[^>]*>([\s\S]*?)<\/div>/g)].map((m) => m[1]).join(' | ');

describe('a workspace administrator', () => {
  test('creates a developer of the workspace only, who signs in there; never an installation administrator', async () => {
    const b = await signIn(ADMIN);
    const page = (await b.get(`/builder/workspaces/${ws}`)).body;
    assert.match(page, /Create a developer/);
    const r = await b.submit(`/builder/workspaces/${ws}/developers/new`, { nd_username: 'nd225a', nd_password: 'another-long-pass-1', nd_email: 'nd225a@example.com', is_admin: 'true' });
    assert.equal(r.statusCode, 303);
    assert.match(await messages(b, `/builder/workspaces/${ws}`), /Developer nd225a created/);
    assert.deepEqual(await owner.one('select is_admin, email from meta.developer where username = $1', ['nd225a']), { is_admin: false, email: 'nd225a@example.com' });
    assert.deepEqual(await membership('nd225a'), [{ workspace_id: ws, is_admin: false }]);
    // as a workspace administrator
    await b.get(`/builder/workspaces/${ws}`);
    await b.submit(`/builder/workspaces/${ws}/developers/new`, { nd_username: 'nd225b', nd_password: 'another-long-pass-2', nd_ws_admin: 'true' });
    assert.deepEqual(await membership('nd225b'), [{ workspace_id: ws, is_admin: true }]);
    const n = await signIn('nd225a', 'another-long-pass-1');
    assert.match((await n.get('/builder/apps')).body, /WD225 Team/);
  });

  test('a bad name, a short password, a taken name or a bad e-mail is refused', async () => {
    const b = await signIn(ADMIN);
    const before = (await owner.one('select count(*)::int as n from meta.developer')).n;
    for (const [form, msg] of [
      [{ nd_username: 'x', nd_password: 'another-long-pass-9' }, /user name is 2 to 60/],
      [{ nd_username: '<b>x</b>', nd_password: 'another-long-pass-9' }, /user name is 2 to 60/],
      [{ nd_username: 'nd225c', nd_password: 'short' }, /at least 12/],
      [{ nd_username: 'ND225A', nd_password: 'another-long-pass-9' }, /is taken/],
      [{ nd_username: 'nd225c', nd_password: 'another-long-pass-9', nd_email: 'not-an-email' }, /e-mail|email/i],
    ] as [Record<string, string>, RegExp][]) {
      await b.get(`/builder/workspaces/${ws}`);
      await b.submit(`/builder/workspaces/${ws}/developers/new`, form);
      assert.match(await messages(b, `/builder/workspaces/${ws}`), msg, JSON.stringify(form));
    }
    assert.equal((await owner.one('select count(*)::int as n from meta.developer')).n, before);
  });

  test('removes a developer of this workspace alone; not one of another workspace too, not an administrator, not themselves', async () => {
    const b = await signIn(ADMIN);
    const page = (await b.get(`/builder/workspaces/${ws}`)).body;
    const options = [...(page.match(/<select[^>]*name="rd_username"[\s\S]*?<\/select>/)?.[0] ?? '').matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(options.includes(MEMBER) && options.includes("nd225a"), options.join(","));
    assert.ok(!options.includes(SHARED) && !options.includes(ADMIN) && !options.includes('admin'));
    for (const who of [SHARED, ADMIN, 'admin']) {
      await b.get(`/builder/workspaces/${ws}`);
      await b.submit(`/builder/workspaces/${ws}/developers/remove`, { rd_username: who });
      assert.ok(await owner.one('select 1 from meta.developer where username = $1', [who]), who);
    }
    await b.get(`/builder/workspaces/${ws}`);
    await b.submit(`/builder/workspaces/${ws}/developers/remove`, { rd_username: 'nd225a' });
    assert.equal(await owner.one('select 1 from meta.developer where username = $1', ['nd225a']), undefined);
    assert.equal((await owner.one(`select count(*)::int as n from meta.session where app_id is null and username = 'nd225a'`)).n, 0);
  });
});

describe('everyone else', () => {
  test('a developer of the workspace who is not its administrator can\'t create or remove', async () => {
    const b = await signIn(MEMBER);
    await b.get('/builder/apps');
    const r0 = await b.submit(`/builder/workspaces/${ws}/developers/new`, { nd_username: "nd225m", nd_password: "another-long-pass-3" });
    assert.equal(r0.statusCode, 403, String(r0.headers.location));
    assert.equal((await b.submit(`/builder/workspaces/${ws}/developers/remove`, { rd_username: 'nd225b' })).statusCode, 403);
    assert.equal(await owner.one('select 1 from meta.developer where username = $1', ['nd225m']), undefined);
    assert.ok(await owner.one('select 1 from meta.developer where username = $1', ['nd225b']));
  });
});
