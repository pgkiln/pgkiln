// The App Gallery (sprint 61, src/builder/gallery.ts): starter apps open their
// blueprint's review and are created from it; sample apps are installed by
// administrators only; custom apps are the workspace's boilerplates.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { Browser, formFields } from './helpers.ts';

const gallery = JSON.parse(readFileSync(new URL('../examples/gallery/gallery.json', import.meta.url), 'utf8'));
const STARTERS: { key: string; file: string }[] = gallery.starters;
const DEV = 'gal_test_dev';
const DEV_PW = 'Gal-test-dev-password!';

let app: FastifyInstance;
let admin: Browser;
let dev: Browser;

async function cleanup() {
  for (const st of STARTERS) {
    const spec = JSON.parse(readFileSync(new URL(`../examples/gallery/${st.file}`, import.meta.url), 'utf8'));
    await owner.query('delete from meta.app where alias = $1', [spec.alias]);
    await owner.query(`drop schema if exists ${spec.schema} cascade`);
    const role = `app_${spec.alias.replace(/-/g, '_')}`;
    if ((await owner.query('select 1 from pg_roles where rolname = $1', [role])).rowCount) {
      await owner.query(`drop owned by ${role} cascade`).catch(() => {});
      await owner.query(`drop role ${role}`);
    }
  }
  await owner.query(`delete from meta.blueprint where created_by = 'admin' and spec->>'alias' = any($1)`, [STARTERS.map((x) => x.key)]);
  await owner.query(`delete from meta.account where username = 'gal_owner'`);
  await owner.query('delete from meta.developer where username = $1', [DEV]);
}

async function signIn(b: Browser, username: string, password: string) {
  await b.get('/builder/login');
  return b.submit('/builder/login', { username, password });
}

before(async () => {
  await cleanup();
  app = await buildApp({ logger: false });
  await owner.query(`insert into meta.developer (username, password_hash, is_admin) values ($1, meta.hash_password($2), false)`, [DEV, DEV_PW]);
  admin = new Browser(app);
  await signIn(admin, 'admin', 'admin');
  dev = new Browser(app);
  await signIn(dev, DEV, DEV_PW);
});
after(async () => {
  await cleanup();
  await app.close();
  await closePools();
});

describe('App Gallery', () => {
  test('three tabs; the shipped starters; HR shows as installed', async () => {
    const samples = (await admin.get('/builder/gallery')).body;
    assert.match(samples, /<a href="\/builder\/gallery\?tab=samples" aria-current="page">Sample Apps/);
    assert.match(samples, /HR Demo[\s\S]*Installed/);
    const starters = (await admin.get('/builder/gallery?tab=starters')).body;
    for (const st of STARTERS) assert.match(starters, new RegExp(`action="/builder/gallery/starters/${st.key}"`));
    assert.match((await admin.get('/builder/gallery?tab=custom')).body, /No custom apps yet|Create from it/);
    assert.match(samples, /class="rail-link"[^>]*title="App Gallery"|title="App Gallery"/);
  });

  for (const st of STARTERS) {
    test(`starter ${st.key}: review, create, every page renders`, async () => {
      await dev.get('/builder/gallery?tab=starters');
      const review = await dev.submit(`/builder/gallery/starters/${st.key}`, {});
      assert.equal(review.statusCode, 200);
      assert.match(review.body, /name="sig"/, 'the review, ready to create');
      assert.equal(await owner.one(`select 1 as ok from meta.app where alias = $1`, [st.key]), undefined, 'nothing created yet');
      const form = formFields(/<form method="post" action="\/builder\/blueprints\/create">[\s\S]*?<\/form>/.exec(review.body)![0]);
      const made = await dev.submit('/builder/blueprints/create', { ...form, admin_user: 'gal_owner', admin_password: 'Gal-owner-password-1!' });
      assert.equal(made.statusCode, 303, made.body.slice(0, 500));
      const a = await owner.one<{ id: number; ws: number }>('select id, meta.app_workspace(id) as ws from meta.app where alias = $1', [st.key]);
      assert.ok(a, 'created');
      const user = new Browser(app);
      await user.login('gal_owner', 'Gal-owner-password-1!', st.key);
      for (const p of (await owner.query<{ page_no: number }>('select page_no from meta.page where app_id = $1 order by 1', [a.id])).rows) {
        const res = await user.get(`/a/${st.key}/${p.page_no}`);
        assert.equal(res.statusCode, 200, `${st.key} page ${p.page_no}`);
        assert.doesNotMatch(res.body, /class="alert alert-error"/, `${st.key} page ${p.page_no} has no error: ${/class="alert alert-error"[^>]*>([\s\S]{0,300})/.exec(res.body)?.[1]}`);
      }
    });
  }

  test('a starter installed twice: the review says the alias is taken, nothing more is created', async () => {
    await dev.get('/builder/gallery?tab=starters');
    const again = await dev.submit(`/builder/gallery/starters/${STARTERS[0].key}`, {});
    assert.match(again.body, /already exists/);
    assert.doesNotMatch(again.body, /name="sig"/);
  });

  test('sample apps: administrators only, with CSRF; unknown keys are 404', async () => {
    await dev.get('/builder/gallery');
    assert.equal((await dev.submit('/builder/gallery/samples/tasks', {})).statusCode, 403);
    assert.match((await dev.get('/builder/gallery')).body, /An administrator installs it/);
    assert.equal((await admin.post('/builder/gallery/samples/tasks', {})).statusCode, 403, 'CSRF');
    await admin.get('/builder/gallery');
    assert.equal((await admin.submit('/builder/gallery/samples/..%2F..%2Fetc', {})).statusCode, 404);
    assert.equal((await admin.submit('/builder/gallery/starters/nope', {})).statusCode, 404);
    // installing one that exists (HR) is refused without running anything
    await admin.submit('/builder/gallery/samples/hr', {});
    assert.match((await admin.get('/builder/gallery')).body, /was not installed: an application with the alias hr exists already/);
  });
});
