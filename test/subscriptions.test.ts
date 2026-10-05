// Application types and subscriptions (migration 056, src/subscriptions.ts,
// src/builder/subscriptions.ts): subscribing to a library application's
// components and a theme application's theme, refresh, publish, the builder
// pages, and creating an application from a boilerplate.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { inSync, offers, publish, refresh, subscribe, SubscriptionError, unsubscribe } from '../src/subscriptions.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let dev: Browser;
let lib: number, theme: number, user: number;

const P = 'sub-t';
const blank = async (alias: string, type = 'standard') =>
  (await owner.one(`insert into meta.app (alias, name, app_type) values ($1, $2, $3) returning id`, [alias, `App ${alias}`, type])).id as number;
const lovQuery = async (appId: number, name: string) => (await owner.one('select query from meta.lov where app_id = $1 and name = $2', [appId, name]))?.query;

before(async () => {
  app = await buildApp({ logger: false });
  dev = new Browser(app);
  await dev.get('/builder/login');
  await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
  await owner.query(`delete from meta.app where alias like $1`, [`${P}%`]);
  lib = await blank(`${P}-lib`, 'library');
  theme = await blank(`${P}-theme`, 'theme');
  user = await blank(`${P}-user`);
  await owner.query(`insert into meta.lov (app_id, name, query) values ($1, 'COLOURS', 'select ''red'' as d, 1 as r')`, [lib]);
  await owner.query(`insert into meta.authz_scheme (app_id, name, type, value, error_message) values ($1, 'MANAGERS', 'role', 'manager', 'Managers only.')`, [lib]);
  await owner.query(`insert into meta.list (app_id, name, type) values ($1, 'LINKS', 'static')`, [lib]);
  const parent = (await owner.one(`insert into meta.list_entry (app_id, list_name, seq, label, target_url) values ($1, 'LINKS', 10, 'Docs', 'https://example.com/') returning id`, [lib])).id;
  await owner.query(`insert into meta.list_entry (app_id, list_name, parent_id, seq, label, target_page) values ($1, 'LINKS', $2, 10, 'Child', 1)`, [lib, parent]);
  await owner.query(`update meta.app set theme = '{"accent": "#112233", "styles": [{"name": "Ocean", "accent": "#0b7285"}]}' where id = $1`, [theme]);
});
after(async () => {
  await owner.query(`delete from meta.app where alias like $1`, [`${P}%`]);
  await app.close();
  await closePools();
});

describe('subscriptions', () => {
  test('offers come from theme and library applications only', async () => {
    const list = await offers(user);
    const keys = list.filter((o) => o.master.id === lib || o.master.id === theme).map((o) => `${o.master.id}:${o.kind}:${o.name}`);
    assert.ok(keys.includes(`${lib}:lov:COLOURS`));
    assert.ok(keys.includes(`${lib}:authz_scheme:MANAGERS`));
    assert.ok(keys.includes(`${theme}:theme:`));
    assert.ok(!keys.some((k) => k.startsWith(`${theme}:lov`)), 'a theme application offers no lists of values');
    assert.ok(!list.some((o) => o.master.id === user), 'a standard application offers nothing');
  });

  test('subscribe copies; refresh and publish bring the master’s changes; local changes are overwritten', async () => {
    await subscribe(user, lib, 'lov', 'COLOURS', 'admin');
    assert.equal(await lovQuery(user, 'COLOURS'), "select 'red' as d, 1 as r");
    const sub = { app_id: user, kind: 'lov' as const, name: 'COLOURS', master_app_id: lib };
    assert.equal(await inSync(sub), true);
    await owner.query(`update meta.lov set query = 'select ''blue'' as d, 2 as r' where app_id = $1 and name = 'COLOURS'`, [lib]);
    assert.equal(await inSync(sub), false);
    assert.equal(await refresh(user, 'lov', 'COLOURS', 'admin'), 1);
    assert.match(await lovQuery(user, 'COLOURS'), /blue/);

    await owner.query(`update meta.lov set query = 'select ''local'' as d, 3 as r' where app_id = $1 and name = 'COLOURS'`, [user]);
    await owner.query(`update meta.lov set query = 'select ''green'' as d, 4 as r' where app_id = $1 and name = 'COLOURS'`, [lib]);
    const r = await publish(lib, 'lov', 'COLOURS', 'admin');
    assert.deepEqual(r, { done: [user], skipped: [] });
    assert.match(await lovQuery(user, 'COLOURS'), /green/);
    // a locked subscriber is skipped
    const r2 = await publish(lib, 'lov', 'COLOURS', 'admin', async (id) => id === user);
    assert.deepEqual(r2, { done: [], skipped: [user] });
  });

  test('a list comes with its entries (nested), a theme with its styles; refresh all', async () => {
    await subscribe(user, lib, 'list', 'LINKS', 'admin');
    const entries = (await owner.query(`select e.label, p.label as parent from meta.list_entry e left join meta.list_entry p on p.id = e.parent_id where e.app_id = $1 and e.list_name = 'LINKS' order by e.id`, [user])).rows;
    assert.deepEqual(entries, [{ label: 'Docs', parent: null }, { label: 'Child', parent: 'Docs' }]);
    assert.equal(await inSync({ app_id: user, kind: 'list', name: 'LINKS', master_app_id: lib }), true);
    await owner.query(`update meta.list_entry set label = 'Manual' where app_id = $1 and label = 'Docs'`, [lib]);
    assert.equal(await inSync({ app_id: user, kind: 'list', name: 'LINKS', master_app_id: lib }), false);

    await subscribe(user, theme, 'theme', 'ignored', 'admin');
    assert.equal((await owner.one('select theme->>$2 as v from meta.app where id = $1', [user, 'accent'])).v, '#112233');
    await owner.query(`update meta.app set theme = theme || '{"accent": "#445566"}' where id = $1`, [theme]);
    assert.ok((await refresh(user, null, null, 'admin')) >= 3);
    assert.equal((await owner.one('select theme->>$2 as v from meta.app where id = $1', [user, 'accent'])).v, '#445566');
    assert.equal((await owner.one(`select count(*)::int as n from meta.list_entry where app_id = $1 and label = 'Manual'`, [user])).n, 1);
  });

  test('wrong masters, kinds and missing components are refused; unsubscribing keeps the component', async () => {
    await assert.rejects(subscribe(user, theme, 'lov', 'COLOURS', 'admin'), SubscriptionError);
    await assert.rejects(subscribe(user, user, 'lov', 'COLOURS', 'admin'), SubscriptionError);
    await assert.rejects(subscribe(user, lib, 'page', 'x', 'admin'), SubscriptionError);
    await assert.rejects(subscribe(user, lib, 'lov', 'NO_SUCH', 'admin'), /no longer exists/);
    await subscribe(user, lib, 'authz_scheme', 'MANAGERS', 'admin');
    await owner.query(`delete from meta.authz_scheme where app_id = $1 and name = 'MANAGERS'`, [lib]);
    await assert.rejects(refresh(user, 'authz_scheme', 'MANAGERS', 'admin'), /no longer exists/);
    assert.ok(await unsubscribe(user, 'authz_scheme', 'MANAGERS'));
    assert.ok(await owner.one(`select 1 from meta.authz_scheme where app_id = $1 and name = 'MANAGERS'`, [user]));
    await assert.rejects(refresh(user, 'authz_scheme', 'MANAGERS', 'admin'), /Not subscribed/);
  });
});

describe('subscriptions in the builder', () => {
  test('the page lists offers, subscribes, refreshes; the master publishes; settings set the type', async () => {
    const other = await blank(`${P}-ui`);
    let page = await dev.get(`/builder/apps/${other}/subscriptions`);
    assert.equal(page.statusCode, 200);
    assert.match(page.body, new RegExp(`<option value="${lib}\\|lov\\|COLOURS">List of values COLOURS</option>`));
    let res = await dev.submit(`/builder/apps/${other}/subscriptions`, { component: `${lib}|lov|COLOURS` });
    assert.equal(res.statusCode, 303);
    assert.match(await lovQuery(other, 'COLOURS'), /green/);
    page = await dev.get(`/builder/apps/${other}/subscriptions`);
    assert.match(page.body, /in sync/);

    // the shared component shows where it comes from
    const lovId = (await owner.one(`select id from meta.lov where app_id = $1 and name = 'COLOURS'`, [other])).id;
    assert.match((await dev.get(`/builder/apps/${other}/shared?c=lov-${lovId}`)).body, /Subscribed from <a href="\/builder\/apps\/\d+\/subscriptions">App sub-t-lib<\/a>/);
    const libLov = (await owner.one(`select id from meta.lov where app_id = $1 and name = 'COLOURS'`, [lib])).id;
    assert.match((await dev.get(`/builder/apps/${lib}/shared?c=lov-${libLov}`)).body, /Publish to subscribers/);

    await owner.query(`update meta.lov set query = 'select ''purple'' as d, 5 as r' where app_id = $1 and name = 'COLOURS'`, [lib]);
    page = await dev.get(`/builder/apps/${lib}/subscriptions`);
    assert.match(page.body, /differs/);
    res = await dev.submit(`/builder/apps/${lib}/subscriptions/publish`, { kind: 'lov', name: 'COLOURS' });
    assert.match(await lovQuery(other, 'COLOURS'), /purple/);

    // the application type in Settings
    page = await dev.get(`/builder/apps/${other}/settings`);
    assert.match(page.body, /<option value="library">Library application<\/option>/);
  });

  test('Create application starts from a boilerplate', async () => {
    const bp = await blank(`${P}-bp`, 'boilerplate');
    await owner.query(`insert into meta.page (app_id, page_no, name, title) values ($1, 1, 'Start', 'Start'), ($1, 7, 'Reports', 'Reports')`, [bp]);
    await owner.query(`insert into meta.lov (app_id, name, query) values ($1, 'STATUS', 'select 1 as d, 1 as r')`, [bp]);
    const page = await dev.get('/builder/create');
    assert.match(page.body, new RegExp(`<option value="${bp}">App ${P}-bp \\(boilerplate\\)</option>`));
    const alias = `${P}-from-bp`;
    try {
      await dev.submit('/builder/apps', { name: 'From boilerplate', alias, schema: '', authentication: 'none', boilerplate: String(bp) });
      const a = await owner.one('select id, name, app_type, db_role, authentication from meta.app where alias = $1', [alias]);
      assert.ok(a, 'created');
      assert.deepEqual({ name: a.name, app_type: a.app_type, db_role: a.db_role, authentication: a.authentication }, {
        name: 'From boilerplate', app_type: 'standard', db_role: `app_${alias.replace(/-/g, '_')}`, authentication: 'none',
      });
      assert.deepEqual((await owner.query('select page_no from meta.page where app_id = $1 order by 1', [a.id])).rows.map((r) => r.page_no), [1, 7]);
      assert.ok(await lovQuery(a.id, 'STATUS'));
      // a standard application is not a boilerplate
      await dev.submit('/builder/apps', { name: 'Not', alias: `${P}-not-bp`, schema: '', authentication: 'none', boilerplate: String(user) });
      assert.equal(await owner.one('select 1 from meta.app where alias = $1', [`${P}-not-bp`]), undefined);
    } finally {
      await owner.query('delete from meta.app where alias = $1', [alias]);
      for (const sch of [alias, `${P}-not-bp`].map((x) => x.replace(/-/g, '_'))) {
        await owner.query(`drop schema if exists ${sch} cascade`);
        if ((await owner.query('select 1 from pg_roles where rolname = $1', [`app_${sch}`])).rowCount) {
          await owner.query(`drop owned by app_${sch}`);
          await owner.query(`drop role app_${sch}`);
        }
      }
    }
  });
});
