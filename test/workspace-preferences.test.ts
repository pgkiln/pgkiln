// Sprint 62: workspace preferences (093: the SQL Workshop and RESTful services
// on or off per workspace), extension links in the builder's Extensions menu,
// and Workspace utilities → Manage backups across the workspace's applications.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { Browser } from './helpers.ts';

const DEV = 'ws62_dev';
const DEV_PW = 'Ws62-dev-password!';
const WS = 'WS62 Workspace';
const NOTE = 'ws62 test backup';

let app: FastifyInstance;
let admin: Browser;
let dev: Browser;
let wsId: number;
let hrId: number;

async function cleanup() {
  await owner.query('delete from meta.workspace where name = $1', [WS]);
  await owner.query('delete from meta.developer where username = $1', [DEV]);
  await owner.query(`delete from meta.workspace_link where workspace_id = 1 and label like 'WS62%'`);
  await owner.query('update meta.workspace set sql_workshop = true, rest_services = true where id = 1');
  await owner.query(`delete from meta.rest_module where name = 'ws62'`);
  await owner.query('delete from meta.app_backup where note = $1', [NOTE]);
}

async function signIn(b: Browser, username: string, password: string) {
  await b.get('/builder/login');
  return b.submit('/builder/login', { username, password });
}

before(async () => {
  await cleanup();
  app = await buildApp({ logger: false });
  hrId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  await owner.query(`insert into meta.developer (username, password_hash, is_admin) values ($1, meta.hash_password($2), false)`, [DEV, DEV_PW]);
  wsId = (await owner.one(`insert into meta.workspace (name) values ($1) returning id`, [WS])).id;
  await owner.query('delete from meta.workspace_member where username = $1', [DEV]);
  await owner.query('insert into meta.workspace_member (workspace_id, username) values ($1, $2)', [wsId, DEV]);
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

describe('workspace preferences', () => {
  test('the SQL Workshop turned off: refused, not in the rail or the utilities; on again: back', async () => {
    assert.equal((await dev.get('/builder/sql')).statusCode, 200);
    await owner.query('update meta.workspace set sql_workshop = false where id = $1', [wsId]);
    for (const url of ['/builder/sql', '/builder/sql/commands', '/builder/sql/objects', '/builder/sql/scripts', '/builder/sql/quick']) {
      const r = await dev.get(url);
      assert.equal(r.statusCode, 403, url);
      assert.match(r.body, /turned off for the workspace WS62 Workspace/);
    }
    await dev.get('/builder');
    assert.equal((await dev.submit('/builder/sql/commands', { sql: 'select 1' })).statusCode, 403);
    const home = (await dev.get('/builder/utilities')).body;
    assert.doesNotMatch(home, /href="\/builder\/sql"/, 'no rail entry, no tile');
    // another workspace's preference is its own: the admin's current workspace is Default
    assert.equal((await admin.get('/builder/sql')).statusCode, 200);
    await owner.query('update meta.workspace set sql_workshop = true where id = $1', [wsId]);
    assert.equal((await dev.get('/builder/sql/commands')).statusCode, 200);
  });

  test('the form saves both preferences; RESTful services off: the modules answer 404', async () => {
    await owner.query(
      `insert into meta.rest_module (app_id, name, title, handlers) values ($1, 'ws62', 'WS62', $2)`,
      [hrId, JSON.stringify([{ method: 'GET', path: 'one', type: 'item', auth: 'public', source: 'select 1 as n' }])],
    );
    assert.equal((await app.inject({ method: 'GET', url: '/a/hr/rest/ws62/one' })).statusCode, 200);
    const page = (await admin.get('/builder/workspaces/1')).body;
    assert.match(page, /id="preferences"/);
    assert.match(page, /name="sql_workshop" value="true" checked/);
    await admin.submit('/builder/workspaces/1/preferences', { sql_workshop: 'true' });
    const w = await owner.one('select sql_workshop, rest_services from meta.workspace where id = 1');
    assert.deepEqual(w, { sql_workshop: true, rest_services: false });
    assert.equal((await app.inject({ method: 'GET', url: '/a/hr/rest/ws62/one' })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/a/hr/rest/ws62/openapi.json' })).statusCode, 404);
    await admin.submit('/builder/workspaces/1/preferences', { sql_workshop: 'true', rest_services: 'true' });
    assert.equal((await app.inject({ method: 'GET', url: '/a/hr/rest/ws62/one' })).statusCode, 200);
  });
});

describe('extension links', () => {
  test('added on the workspace page, shown in the Extensions menu, deleted', async () => {
    assert.doesNotMatch((await admin.get('/builder')).body, /rail-extensions/);
    await admin.get('/builder/workspaces/1');
    await admin.submit('/builder/workspaces/1/links', { label: 'WS62 Monitoring', url: 'https://grafana.example.com/d/1?x=1&y=2', description: 'Dashboards', position: '1' });
    const home = (await admin.get('/builder')).body;
    assert.match(home, /rail-extensions/);
    assert.match(home, /<a href="https:\/\/grafana\.example\.com\/d\/1\?x=1&amp;y=2" target="_blank" rel="noopener noreferrer" title="Dashboards">/);
    // the developer's current workspace has none
    assert.doesNotMatch((await dev.get('/builder')).body, /WS62 Monitoring/);
    const id = (await owner.one(`select id from meta.workspace_link where label = 'WS62 Monitoring'`)).id;
    await admin.get('/builder/workspaces/1');
    await admin.submit(`/builder/workspaces/1/links/${id}/delete`, {});
    assert.equal(await owner.one(`select 1 from meta.workspace_link where id = $1`, [id]), undefined);
  });

  test('only http(s) URLs and sensible labels; a duplicate label is refused', async () => {
    await admin.get('/builder/workspaces/1');
    for (const url of ['javascript:alert(1)', 'data:text/html,x', '//evil.example', 'https://a b', 'ftp://x']) {
      await admin.submit('/builder/workspaces/1/links', { label: 'WS62 Bad', url });
      assert.equal(await owner.one(`select 1 from meta.workspace_link where label = 'WS62 Bad'`), undefined, url);
    }
    await admin.submit('/builder/workspaces/1/links', { label: ' ', url: 'https://ok.example' });
    await admin.submit('/builder/workspaces/1/links', { label: 'WS62 Wiki', url: 'https://wiki.example' });
    const r = await admin.submit('/builder/workspaces/1/links', { label: 'WS62 Wiki', url: 'https://wiki2.example' });
    assert.equal(r.statusCode, 303);
    assert.match((await admin.get('/builder/workspaces/1')).body, /There is a link WS62 Wiki already/);
    assert.equal(Number((await owner.one(`select count(*) from meta.workspace_link where label like 'WS62%'`)).count), 1);
  });
});

describe('Manage backups', () => {
  test('lists the workspace\'s applications with their backups; backs them all up', async () => {
    const page = (await admin.get('/builder/backups')).body;
    assert.match(page, /Manage backups/);
    assert.match(page, new RegExp(`href="/builder/apps/${hrId}/backups"`));
    const before = Number((await owner.one('select count(*) from meta.app_backup where app_id = $1', [hrId])).count);
    await admin.submit('/builder/backups', { note: NOTE });
    const made = (await owner.query('select app_id from meta.app_backup where note = $1', [NOTE])).rows;
    assert.ok(made.some((r) => r.app_id === hrId), 'HR backed up');
    assert.ok(Number((await owner.one('select count(*) from meta.app_backup where app_id = $1', [hrId])).count) >= Math.min(before + 1, 1));
    // unchanged since: nothing more with "only changed"
    await admin.submit('/builder/backups', { note: NOTE, changed: 'true' });
    assert.equal((await owner.query('select 1 from meta.app_backup where note = $1 and app_id = $2', [NOTE, hrId])).rows.length, 1);
    // the developer's workspace has no applications: HR is not listed
    assert.doesNotMatch((await dev.get('/builder/backups')).body, new RegExp(`/builder/apps/${hrId}/backups`));
    await dev.submit('/builder/backups', { note: NOTE });
    assert.equal((await owner.query('select 1 from meta.app_backup where note = $1 and app_id = $2', [NOTE, hrId])).rows.length, 1);
  });
});
