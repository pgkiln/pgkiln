// Sprint 61: the builder's screens like APEX's. The sign-in page with a
// workspace and "Remember workspace and username"; the Administration menu,
// the workspace message and environment banner (091) and workspace
// utilization; the SQL Workshop home with the session's schema; application
// groups (092); cross-application reports.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { Browser } from './helpers.ts';
import { REPORTS } from '../src/builder/cross-app.ts';

const DEV = 'apex61_dev';
const DEV_PW = 'Apex61-dev-password!';
const WS = 'APEX61 Workspace';
const SCHEMA = 'apex61_schema';

let app: FastifyInstance;
let admin: Browser;
let dev: Browser;
let wsId: number;

async function cleanup() {
  await owner.query('delete from meta.workspace where name = $1', [WS]);
  await owner.query('delete from meta.developer where username = $1', [DEV]);
  await owner.query(`delete from meta.app_group where name like 'APEX61%'`);
  await owner.query(`update meta.workspace set message = null, banner_label = null, banner_color = 'blue' where id = 1`);
  await owner.query(`drop schema if exists ${SCHEMA} cascade`);
}

async function signIn(b: Browser, username: string, password: string, extra: Record<string, string> = {}) {
  await b.get('/builder/login');
  return b.submit('/builder/login', { username, password, ...extra });
}

before(async () => {
  await cleanup();
  app = await buildApp({ logger: false });
  await owner.query(`insert into meta.developer (username, password_hash, is_admin) values ($1, meta.hash_password($2), false)`, [DEV, DEV_PW]);
  wsId = (await owner.one(`insert into meta.workspace (name) values ($1) returning id`, [WS])).id;
  // only in the test workspace (a developer added by SQL also joins Default)
  await owner.query('delete from meta.workspace_member where username = $1', [DEV]);
  await owner.query('insert into meta.workspace_member (workspace_id, username) values ($1, $2)', [wsId, DEV]);
  await owner.query(`create schema ${SCHEMA}`);
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

describe('the sign-in page', () => {
  test('a workspace, username and password; the workspace becomes the current one', async () => {
    const page = (await new Browser(app).get('/builder/login')).body;
    for (const id of ['f_workspace', 'f_username', 'f_password']) assert.match(page, new RegExp(`id="${id}"`));
    assert.match(page, /Remember workspace and username/);
    assert.match(page, /data-reveal="f_password"/);
    const b = new Browser(app);
    const res = await signIn(b, DEV, DEV_PW, { workspace: WS.toLowerCase() });
    assert.equal(res.statusCode, 303);
    assert.match((await b.get('/builder')).body, new RegExp(`title="Workspace">[\\s\\S]*?${WS}`));
  });

  test('a workspace the developer is not in gets the same answer as a wrong password', async () => {
    const b = new Browser(app);
    await signIn(b, DEV, DEV_PW, { workspace: 'Default' });
    const page = (await b.get('/builder/login')).body;
    assert.match(page, /Invalid workspace, username or password/);
    assert.equal((await b.get('/builder')).statusCode, 302, 'not signed in');
    await signIn(b, DEV, 'wrong', { workspace: WS });
    assert.match((await b.get('/builder/login')).body, /Invalid workspace, username or password/);
  });

  test('"Remember workspace and username" fills them in next time; unticked forgets them', async () => {
    const b = new Browser(app);
    await signIn(b, DEV, DEV_PW, { workspace: WS, remember: '1' });
    assert.ok(b.cookies.get('pgkiln_bsignin'), 'the cookie');
    await b.get('/builder');
    await b.submit('/builder/logout', {});
    const page = (await b.get('/builder/login')).body;
    assert.match(page, new RegExp(`id="f_workspace"[^>]*value="${WS}"`));
    assert.match(page, new RegExp(`id="f_username"[^>]*value="${DEV}"`));
    assert.match(page, /name="remember" value="1" checked/);
    await signIn(b, DEV, DEV_PW, { workspace: WS });
    assert.ok(!b.cookies.get('pgkiln_bsignin'), 'forgotten');
  });

  test('after signing in: a builder page only (no other site)', async () => {
    const b = new Browser(app);
    let res = await signIn(b, DEV, DEV_PW, { next: '/builder/utilities' });
    assert.equal(res.headers.location, '/builder/utilities');
    for (const next of ['https://evil.example/', '//evil.example', '/a/hr/1', '/builder/../a']) {
      const c = new Browser(app);
      res = await signIn(c, DEV, DEV_PW, { next });
      assert.equal(res.headers.location, '/builder/home', next);
    }
  });
});

describe('Administration: message, banner, utilization', () => {
  test('administrators and workspace administrators set them; they show on the builder', async () => {
    await admin.get('/builder/workspaces/1');
    await admin.submit('/builder/workspaces/1/service', { message: 'Upgrade <b>tonight</b>', banner_label: 'TEST', banner_color: 'red' });
    const home = (await admin.get('/builder')).body;
    assert.match(home, /class="ide-banner ide-banner-red"[^>]*>TEST</);
    assert.match(home, /Upgrade &lt;b&gt;tonight&lt;\/b&gt;/, 'escaped');
    // a colour outside the list falls back to blue; a long label is refused
    await admin.submit('/builder/workspaces/1/service', { message: '', banner_label: 'TEST', banner_color: 'url(x)' });
    assert.match((await admin.get('/builder')).body, /ide-banner-blue/);
    await admin.submit('/builder/workspaces/1/service', { banner_label: 'x'.repeat(41) });
    assert.match((await admin.get('/builder/workspaces/1')).body, /at most 40 characters/);
    // a developer who is not its administrator can't
    await dev.get('/builder');
    assert.equal((await dev.submit(`/builder/workspaces/${wsId}/service`, { message: 'hi' })).statusCode, 403);
    await owner.query('update meta.workspace_member set is_admin = true where workspace_id = $1 and username = $2', [wsId, DEV]);
    await dev.get('/builder');
    assert.equal((await dev.submit(`/builder/workspaces/${wsId}/service`, { message: 'From the workspace administrator', banner_label: 'DEV' })).statusCode, 303);
    assert.match((await dev.get('/builder')).body, /From the workspace administrator/);
    await owner.query('update meta.workspace_member set is_admin = false where workspace_id = $1 and username = $2', [wsId, DEV]);
  });

  test('the Administration menu and workspace utilization', async () => {
    const home = (await admin.get('/builder')).body;
    assert.match(home, /class="menu rail-user rail-admin"/);
    assert.match(home, /href="\/builder\/workspaces\/\d+\/utilization"/);
    const util = await admin.get('/builder/workspaces/1/utilization');
    assert.equal(util.statusCode, 200);
    assert.match(util.body, /HR Demo/);
    await dev.get('/builder');
    assert.equal((await dev.get('/builder/workspaces/1/utilization')).statusCode, 403);
  });
});

describe('the SQL Workshop home', () => {
  test('tiles, recent commands (one\'s own) and scripts; SQL Commands moved to /sql/commands', async () => {
    await admin.get('/builder/sql/commands');
    await admin.submit('/builder/sql/commands', { sql: 'select 61 as apex_sprint' });
    const home = (await admin.get('/builder/sql')).body;
    assert.match(home, /Recently created tables/);
    assert.match(home, /Recent SQL commands[\s\S]*select 61 as apex_sprint/);
    const id = /href="\/builder\/sql\/worksheet\?recent=(\d+)"/.exec(home)![1];
    assert.match((await admin.get(`/builder/sql/commands?recent=${id}`)).body, />select 61 as apex_sprint</);
    // another developer's command isn't loaded
    assert.doesNotMatch((await dev.get(`/builder/sql/commands?recent=${id}`)).body, /apex_sprint/);
    assert.doesNotMatch((await dev.get('/builder/sql')).body, /apex_sprint/);
  });

  test('the session schema goes first in the search path; unknown schemas are refused', async () => {
    await admin.get('/builder/sql');
    assert.equal((await admin.submit('/builder/sql/schema', { schema: SCHEMA })).statusCode, 303);
    await admin.get('/builder/sql/commands');
    const out = (await admin.submit('/builder/sql/commands', { sql: 'select current_schemas(false)::text as path' })).body;
    assert.match(out, new RegExp(`\\{${SCHEMA},public\\}`));
    await admin.get('/builder/sql');
    assert.equal((await admin.submit('/builder/sql/schema', { schema: 'no_such_schema' })).statusCode, 404);
    assert.equal((await admin.submit('/builder/sql/schema', { schema: 'meta' })).statusCode, 404);
    await admin.submit('/builder/sql/schema', { schema: '' });
  });
});

describe('application groups', () => {
  test('add, assign, filter the home; only this workspace\'s groups and applications', async () => {
    await admin.get('/builder/app-groups');
    await admin.submit('/builder/app-groups', { name: 'APEX61 <People>', description: 'x' });
    const g = await owner.one('select id from meta.app_group where name = $1 and workspace_id = 1', ['APEX61 <People>']);
    assert.ok(g);
    assert.match((await admin.get('/builder/app-groups')).body, /APEX61 &lt;People&gt;/);
    const hr = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
    await admin.submit('/builder/app-groups/assign', { [`app_${hr}`]: String(g.id) });
    assert.equal((await owner.one('select group_id from meta.app_group_member where app_id = $1', [hr])).group_id, g.id);
    assert.match((await admin.get(`/builder?group=${g.id}`)).body, /HR Demo/);
    // a group of another workspace, or an application of another one, is ignored
    const other = (await owner.one(`insert into meta.app_group (workspace_id, name) values ($1, 'APEX61 other') returning id`, [wsId])).id;
    await admin.submit('/builder/app-groups/assign', { [`app_${hr}`]: String(other) });
    assert.equal((await owner.one('select group_id from meta.app_group_member where app_id = $1', [hr])).group_id, g.id);
    await dev.get('/builder/app-groups');
    await dev.submit('/builder/app-groups/assign', { [`app_${hr}`]: String(other) });
    assert.equal((await owner.one('select group_id from meta.app_group_member where app_id = $1', [hr])).group_id, g.id);
    assert.equal((await dev.submit(`/builder/app-groups/${g.id}/delete`, {})).statusCode, 404, 'not the developer\'s workspace');
    await admin.submit(`/builder/app-groups/${g.id}/delete`, {});
    assert.equal(await owner.one('select 1 as ok from meta.app_group_member where app_id = $1', [hr]), undefined);
    await admin.get(`/builder?group=`);
  });
});

describe('cross-application reports', () => {
  test('every report renders for the current workspace; unknown ones are 404', async () => {
    for (const k of Object.keys(REPORTS)) {
      const res = await admin.get(`/builder/utilities/reports/${k}`);
      assert.equal(res.statusCode, 200, k);
    }
    assert.match((await admin.get('/builder/utilities/reports/attributes')).body, /HR Demo/);
    assert.doesNotMatch((await dev.get('/builder/utilities/reports/attributes')).body, /HR Demo/, 'another workspace\'s application');
    assert.equal((await admin.get('/builder/utilities/reports/__proto__')).statusCode, 404);
    assert.equal((await admin.get('/builder/utilities/reports/nope')).statusCode, 404);
    assert.match((await admin.get('/builder/utilities')).body, /Cross Application Reports/);
  });
});
