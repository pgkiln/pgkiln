// The App Gallery (sprint 61, sprint 120; src/builder/gallery.ts): starter and
// utility apps open their blueprint's review and are created from it; sample
// apps are installed by administrators only; custom apps are the workspace's
// boilerplates. Every shipped application is installed here and all its pages
// are opened.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { Browser, formFields } from './helpers.ts';
import { BLUEPRINTS, dropBlueprintApp, dropSample, SAMPLES } from './gallery-samples.ts';

const STARTERS = BLUEPRINTS.filter((x) => x.kind === 'starters');
const UTILITIES = BLUEPRINTS.filter((x) => x.kind === 'utilities');
const DEV = 'gal_test_dev';
const DEV_PW = 'Gal-test-dev-password!';

let app: FastifyInstance;
let admin: Browser;
let dev: Browser;

async function cleanup() {
  for (const x of BLUEPRINTS) await dropBlueprintApp(x);
  for (const x of SAMPLES) await dropSample(x);
  await owner.query(`delete from meta.blueprint where created_by = 'admin' and spec->>'alias' = any($1)`, [BLUEPRINTS.map((x) => x.alias)]);
  await owner.query(`delete from meta.account where username = 'gal_owner'`);
  await owner.query('delete from meta.developer where username = $1', [DEV]);
}

async function signIn(b: Browser, username: string, password: string) {
  await b.get('/builder/login');
  return b.submit('/builder/login', { username, password });
}

/** Every page of an application as the given user: 200, no error in a region, nothing in the error log. */
async function everyPageRenders(alias: string, user: Browser) {
  const a = (await owner.one<{ id: number }>('select id from meta.app where alias = $1', [alias]))!;
  const logged = (await owner.one(`select coalesce(max(id), 0) as id from meta.activity_log where app_id = $1`, [a.id])).id;
  const pages = (await owner.query<{ page_no: number }>('select page_no from meta.page where app_id = $1 order by 1', [a.id])).rows;
  assert.ok(pages.length > 1, `${alias} has pages`);
  for (const p of pages) {
    const res = await user.get(`/a/${alias}/${p.page_no}`);
    assert.equal(res.statusCode, 200, `${alias} page ${p.page_no}`);
    assert.doesNotMatch(res.body, /class="alert alert-error"/, `${alias} page ${p.page_no} has no error: ${/class="alert alert-error"[^>]*>([\s\S]{0,300})/.exec(res.body)?.[1]}`);
  }
  const errors = (await owner.query(`select page_no, detail from meta.activity_log where app_id = $1 and event = 'error' and id > $2`, [a.id, logged])).rows;
  assert.deepEqual(errors, [], `${alias}: no errors logged`);
  return pages.map((p) => p.page_no);
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
  test('four tabs with their counts; the shipped samples, starters and utilities; HR shows as installed', async () => {
    const samples = (await admin.get('/builder/gallery')).body;
    assert.match(samples, /<a href="\/builder\/gallery\?tab=samples" aria-current="page">Sample Apps <span class="gal-count">\d+<\/span>/);
    assert.match(samples, /HR Demo[\s\S]*Installed/);
    assert.ok(SAMPLES.length >= 6, 'single-topic samples and the UX Pattern Catalog');
    for (const x of SAMPLES) assert.match(samples, new RegExp(`action="/builder/gallery/samples/${x.key}"`), x.key);
    const starters = (await admin.get('/builder/gallery?tab=starters')).body;
    for (const st of STARTERS) assert.match(starters, new RegExp(`action="/builder/gallery/starters/${st.key}"`));
    const utilities = (await admin.get('/builder/gallery?tab=utilities')).body;
    assert.match(utilities, new RegExp(`aria-current="page">Utility Apps <span class="gal-count">${UTILITIES.length}</span>`));
    assert.ok(UTILITIES.length >= 2);
    for (const u of UTILITIES) assert.match(utilities, new RegExp(`action="/builder/gallery/utilities/${u.key}"`));
    assert.doesNotMatch(utilities, /gallery\/starters\//, 'only the utility apps');
    assert.match((await admin.get('/builder/gallery?tab=custom')).body, /No custom apps yet|Create from it/);
    assert.match(samples, /class="rail-link"[^>]*title="App Gallery"|title="App Gallery"/);
  });

  test('the search works without JavaScript: ?q= keeps the matching apps of the tab', async () => {
    const res = (await admin.get('/builder/gallery?tab=samples&q=drill-down')).body;
    assert.match(res, /action="\/builder\/gallery\/samples\/sample-charts"/);
    assert.doesNotMatch(res, /action="\/builder\/gallery\/samples\/sample-cards"/);
    assert.match(res, /name="q"[^>]*value="drill-down"/);
    assert.match(res, /href="\/builder\/gallery\?tab=utilities&amp;q=drill-down"/, 'the tabs keep the search');
    const words = (await admin.get('/builder/gallery?tab=utilities&q=release%20calendar')).body;
    assert.match(words, /gallery\/utilities\/release-notes/);
    assert.doesNotMatch(words, /gallery\/utilities\/lookup-lists/);
    assert.match((await admin.get('/builder/gallery?tab=starters&q=nothing-like-this')).body, /No app matches <strong>nothing-like-this<\/strong>/);
    assert.match((await admin.get(`/builder/gallery?q=${encodeURIComponent('<script>')}`)).body, /value="&lt;script&gt;"/, 'escaped');
  });

  for (const st of BLUEPRINTS) {
    test(`${st.kind === 'starters' ? 'starter' : 'utility'} ${st.key}: review, create, every page renders`, async () => {
      await dev.get(`/builder/gallery?tab=${st.kind}`);
      const review = await dev.submit(`/builder/gallery/${st.kind}/${st.key}`, {});
      assert.equal(review.statusCode, 200);
      assert.match(review.body, /name="sig"/, 'the review, ready to create');
      assert.equal(await owner.one(`select 1 as ok from meta.app where alias = $1`, [st.alias]), undefined, 'nothing created yet');
      const form = formFields(/<form method="post" action="\/builder\/blueprints\/create">[\s\S]*?<\/form>/.exec(review.body)![0]);
      const made = await dev.submit('/builder/blueprints/create', { ...form, admin_user: 'gal_owner', admin_password: 'Gal-owner-password-1!' });
      assert.equal(made.statusCode, 303, made.body.slice(0, 500));
      const a = await owner.one<{ ws: number }>('select meta.app_workspace(id) as ws from meta.app where alias = $1', [st.alias]);
      assert.ok(a, 'created');
      assert.equal(a.ws, 1, "in the developer's workspace");
      const user = new Browser(app);
      await user.login('gal_owner', 'Gal-owner-password-1!', st.alias);
      await everyPageRenders(st.alias, user);
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
    assert.equal((await dev.submit('/builder/gallery/samples/sample-charts', {})).statusCode, 403);
    assert.match((await dev.get('/builder/gallery')).body, /An administrator installs it/);
    assert.equal((await admin.post('/builder/gallery/samples/tasks', {})).statusCode, 403, 'CSRF');
    await admin.get('/builder/gallery');
    assert.equal((await admin.submit('/builder/gallery/samples/..%2F..%2Fetc', {})).statusCode, 404);
    assert.equal((await admin.submit('/builder/gallery/starters/nope', {})).statusCode, 404);
    assert.equal((await admin.submit('/builder/gallery/utilities/nope', {})).statusCode, 404);
    // installing one that exists (HR) is refused without running anything
    await admin.submit('/builder/gallery/samples/hr', {});
    assert.match((await admin.get('/builder/gallery')).body, /was not installed: an application with the alias hr exists already/);
  });

  for (const x of SAMPLES) {
    test(`sample ${x.key}: an administrator installs it, every page renders for its demo account`, async () => {
      await admin.get('/builder/gallery');
      const res = await admin.submit(`/builder/gallery/samples/${x.key}`, {});
      assert.equal(res.statusCode, 303);
      const a = await owner.one<{ id: number; ws: number }>('select id, meta.app_workspace(id) as ws from meta.app where alias = $1', [x.alias]);
      assert.ok(a, `${x.alias} installed`);
      assert.equal(a.ws, 1, 'in the current workspace');
      assert.equal(res.headers.location, `/builder/apps/${a.id}`);
      assert.match((await admin.get('/builder/gallery')).body, new RegExp(`${x.title}</h2>[\\s\\S]*?Installed[\\s\\S]*?href="/builder/apps/${a.id}"`));
      const user = new Browser(app);
      assert.equal((await user.login('demo', 'demo', x.alias)).statusCode, 303, 'the demo account signs in');
      const pages = await everyPageRenders(x.alias, user);
      assert.ok(pages.includes(1));
      assert.match((await user.get(`/a/${x.alias}/1`)).body, /region-hero|tpl-hero|hero/, 'the home page explains the app');
      // installed twice: refused before anything runs
      await admin.get('/builder/gallery');
      await admin.submit(`/builder/gallery/samples/${x.key}`, {});
      assert.match((await admin.get('/builder/gallery')).body, new RegExp(`was not installed: an application with the alias ${x.alias} exists already`));
    });
  }

  test('a sample whose script fails leaves nothing behind (one transaction)', async () => {
    const x = SAMPLES.find((s) => s.key === 'sample-cards')!;
    await dropSample(x);
    await owner.query(`create schema ${x.schema}`); // the script's "create schema" fails
    try {
      await admin.get('/builder/gallery');
      await admin.submit(`/builder/gallery/samples/${x.key}`, {});
      assert.match((await admin.get('/builder/gallery')).body, new RegExp(`${x.title} was not installed: schema &quot;${x.schema}&quot; already exists`));
      assert.equal(await owner.one('select 1 as ok from meta.app where alias = $1', [x.alias]), undefined);
      assert.equal((await owner.query('select 1 from pg_roles where rolname = $1', [x.role])).rowCount, 0, 'no role either');
      assert.equal((await owner.one('select 1 as ok')).ok, 1, 'the connections are fine afterwards');
    } finally {
      await owner.query(`drop schema if exists ${x.schema} cascade`);
    }
  });

  test('in the sample apps, links open their rows: a calendar event, a card, a drill-down', async () => {
    for (const [alias, page, target, item] of [['sample-calendar', 2, 3, 'P3_TITLE'], ['sample-cards', 2, 3, 'P3_NAME'], ['sample-charts', 7, 8, 'P8_REGION']] as const) {
      if (!(await owner.one('select 1 as ok from meta.app where alias = $1', [alias]))) {
        await admin.get('/builder/gallery');
        assert.equal((await admin.submit(`/builder/gallery/samples/${alias}`, {})).statusCode, 303);
      }
      const u = new Browser(app);
      await u.login('demo', 'demo', alias);
      const body = (await u.get(`/a/${alias}/${page}`)).body;
      const link = new RegExp(`href="(/a/${alias}/${target}\\?P${target}_[A-Z]+=[^"&]+&amp;cs=[0-9a-f]+)"`).exec(body);
      assert.ok(link, `${alias} ${page} links to page ${target}`);
      const res = await u.get(link[1].replace(/&amp;/g, '&'));
      assert.equal(res.statusCode, 200);
      assert.match(res.body, new RegExp(`(name|id)="${item}"[^>]*`), `${alias} ${target} shows ${item}`);
      assert.doesNotMatch(res.body, /class="alert alert-error"/);
    }
  });
});
