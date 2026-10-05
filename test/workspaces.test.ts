// Workspaces (064, src/builder/workspaces.ts): the Default workspace, the
// administrators' Workspaces pages, the current workspace in the builder
// session, scoped lists, refused applications outside a developer's
// workspaces, new, imported and copied applications in the right workspace.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { Browser } from './helpers.ts';

const DEV = 'ws_test_dev';
const DEV_PW = 'Ws-test-dev-password!';
const NEW_DEV = 'ws_test_new_dev';
const WS = ['WS Test Alpha', 'WS Test Beta', 'WS Test Empty'];
const ALIASES = ['ws-test-a', 'ws-test-b', 'ws-test-imp', 'ws-test-a-copy1'];

let app: FastifyInstance;
let admin: Browser;
let dev: Browser;
let hrId: number;

async function cleanup() {
  await owner.query('delete from meta.app where alias = any($1)', [ALIASES]);
  for (const a of ALIASES) {
    const n = a.replace(/-/g, '_');
    await owner.query(`drop schema if exists ${n} cascade`);
    await owner.query(`drop owned by ${'app_' + n} cascade`).catch(() => {});
    await owner.query(`drop role if exists ${'app_' + n}`);
  }
  await owner.query('delete from meta.workspace where name = any($1)', [WS]);
  await owner.query('delete from meta.developer where username = any($1)', [[DEV, NEW_DEV]]);
}

async function signIn(b: Browser, username: string, password: string) {
  await b.get('/builder/login');
  return b.submit('/builder/login', { username, password });
}

const wsId = async (name: string) => (await owner.one('select id from meta.workspace where name = $1', [name])).id as number;
const appWs = async (alias: string) => (await owner.one('select meta.app_workspace(id) as ws from meta.app where alias = $1', [alias])).ws as number;

before(async () => {
  await cleanup();
  app = await buildApp({ logger: false });
  await owner.query(`insert into meta.developer (username, password_hash, is_admin) values ($1, meta.hash_password($2), false)`, [DEV, DEV_PW]);
  admin = new Browser(app);
  await signIn(admin, 'admin', 'admin');
  dev = new Browser(app);
  await signIn(dev, DEV, DEV_PW);
  hrId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
});
after(async () => {
  await cleanup();
  await app.close();
  await closePools();
});

describe('workspaces', () => {
  test('the Default workspace holds existing applications; new developers join it', async () => {
    assert.equal((await owner.one('select name from meta.workspace where id = 1')).name, 'Default');
    assert.equal(await appWs('hr'), 1);
    assert.ok(await owner.one('select 1 as ok from meta.workspace_member where workspace_id = 1 and username = $1', [DEV]), 'a developer added by SQL is in Default');
    await assert.rejects(owner.query('delete from meta.workspace where id = 1'), /cannot be deleted/);
  });

  test('only administrators manage workspaces', async () => {
    assert.equal((await dev.get('/builder/workspaces')).statusCode, 403);
    await dev.get('/builder');
    assert.equal((await dev.submit('/builder/workspaces', { name: 'WS Test Nope' })).statusCode, 403);
    assert.ok(!(await owner.one(`select 1 as ok from meta.workspace where name = 'WS Test Nope'`)));
    // CSRF
    assert.equal((await admin.post('/builder/workspaces', { name: WS[0] })).statusCode, 403);
    assert.match((await admin.get('/builder/utilities')).body, /href="\/builder\/workspaces"/);
    assert.doesNotMatch((await dev.get('/builder/utilities')).body, /href="\/builder\/workspaces"/);
  });

  test('administrators add workspaces and become their first developer', async () => {
    await admin.get('/builder/workspaces');
    for (const name of WS) assert.equal((await admin.submit('/builder/workspaces', { name, description: `${name} test` })).statusCode, 303);
    const alpha = await wsId(WS[0]);
    assert.ok(await owner.one('select 1 as ok from meta.workspace_member where workspace_id = $1 and username = $2', [alpha, 'admin']));
    // names are unique (case-insensitive) and checked
    await admin.get('/builder/workspaces');
    await admin.submit('/builder/workspaces', { name: WS[0].toUpperCase() });
    assert.match((await admin.get('/builder/workspaces')).body, /A workspace with this name exists already/);
    await admin.submit('/builder/workspaces', { name: ' ' });
    assert.match((await admin.get('/builder/workspaces')).body, /1 to 60 characters/);
    const list = (await admin.get('/builder/workspaces')).body;
    for (const name of ['Default', ...WS]) assert.ok(list.includes(`>${name}</a>`), name);
    assert.match((await admin.get(`/builder/workspaces/${alpha}`)).body, new RegExp(`<h1>${WS[0]}</h1>`));
  });

  test('applications are created in the current workspace; switching needs CSRF and membership', async () => {
    const alpha = await wsId(WS[0]);
    const beta = await wsId(WS[1]);
    // the administrator switches to Alpha and creates an application there
    await admin.get('/builder');
    assert.equal((await admin.post('/builder/workspace', { workspace: String(alpha) })).statusCode, 403, 'CSRF');
    assert.equal((await admin.submit('/builder/workspace', { workspace: String(alpha) })).statusCode, 303);
    assert.match((await admin.get('/builder')).body, new RegExp(`title="Workspace">[\\s\\S]*?${WS[0]}`));
    await admin.get('/builder/create');
    assert.equal((await admin.submit('/builder/apps', { name: 'WS test A', alias: 'ws-test-a', authentication: 'none' })).statusCode, 303);
    assert.equal(await appWs('ws-test-a'), alpha);
    // the home list shows the current workspace only
    const home = (await admin.get('/builder?q=')).body;
    assert.ok(home.includes('>WS test A<') || home.includes('WS test A'), 'own workspace app listed');
    assert.ok(!home.includes(`href="/builder/apps/${hrId}"`), 'Default apps are not listed in Alpha');
    // Beta gets another
    await admin.submit('/builder/workspace', { workspace: String(beta) });
    await admin.get('/builder/create');
    await admin.submit('/builder/apps', { name: 'WS test B', alias: 'ws-test-b', authentication: 'none' });
    assert.equal(await appWs('ws-test-b'), beta);
    // the developer (Default only) can't switch to Alpha
    await dev.get('/builder');
    assert.equal((await dev.submit('/builder/workspace', { workspace: String(alpha) })).statusCode, 404);
    await admin.submit('/builder/workspace', { workspace: '1' });
  });

  test('applications outside the developer\'s workspaces are refused (GET and POST, apps and pages)', async () => {
    const a = (await owner.one(`select id from meta.app where alias = 'ws-test-a'`)).id;
    const page = (await owner.one('select id from meta.page where app_id = $1 and page_no = 1', [a])).id;
    for (const url of [`/builder/apps/${a}`, `/builder/apps/${a}/shared`, `/builder/apps/${a}/settings`, `/builder/pages/${page}`, `/builder/pages/${page}?c=page`]) {
      assert.equal((await dev.get(url)).statusCode, 404, url);
    }
    await dev.get('/builder');
    assert.equal((await dev.submit(`/builder/pages/${page}/delete`, {})).statusCode, 404);
    assert.equal((await dev.submit(`/builder/apps/${a}/delete`, {})).statusCode, 404);
    assert.ok(await owner.one('select 1 as ok from meta.page where id = $1', [page]), 'the page is still there');
    // the home list doesn't show it; the developer's own workspace still works
    assert.ok(!(await dev.get('/builder?q=ws-test')).body.includes(`href="/builder/apps/${a}"`));
    assert.equal((await dev.get(`/builder/apps/${hrId}`)).statusCode, 200);
    // the administrator sees it from any workspace, which becomes the current one
    assert.equal((await admin.get(`/builder/apps/${a}`)).statusCode, 200);
    assert.match((await admin.get('/builder')).body, new RegExp(`title="Workspace">[\\s\\S]*?${WS[0]}`));
    await admin.submit('/builder/workspace', { workspace: '1' });
  });

  test('members: added developers see the workspace and can switch; a developer without a workspace can\'t create', async () => {
    const alpha = await wsId(WS[0]);
    const a = (await owner.one(`select id from meta.app where alias = 'ws-test-a'`)).id;
    await admin.get(`/builder/workspaces/${alpha}`);
    assert.equal((await admin.submit(`/builder/workspaces/${alpha}/members`, { member: ['admin', DEV, 'no-such-developer'] })).statusCode, 303);
    assert.deepEqual((await owner.query('select username from meta.workspace_member where workspace_id = $1 order by 1', [alpha])).rows.map((r) => r.username), ['admin', DEV]);
    assert.equal((await dev.get(`/builder/apps/${a}`)).statusCode, 200);
    const menu = (await dev.get('/builder')).body;
    assert.match(menu, /action="\/builder\/workspace"/, 'the switcher shows for several workspaces');
    // only in Alpha now: Default's application is refused
    await admin.submit(`/builder/workspaces/1/members`, { member: ['admin'] });
    assert.equal((await dev.get(`/builder/apps/${hrId}`)).statusCode, 404);
    // no workspace at all: nothing listed, nothing created
    await admin.get(`/builder/workspaces/${alpha}`);
    await admin.submit(`/builder/workspaces/${alpha}/members`, { member: ['admin'] });
    assert.match((await dev.get('/builder')).body, /No applications yet/);
    await dev.get('/builder/create');
    await dev.submit('/builder/apps', { name: 'Nope', alias: 'ws-test-nope', authentication: 'none' });
    assert.match((await dev.get('/builder/create')).body, /not a developer of any workspace/);
    assert.ok(!(await owner.one(`select 1 as ok from meta.app where alias = 'ws-test-nope'`)));
    // back to Default for the other tests
    await owner.query(`insert into meta.workspace_member (workspace_id, username) select 1, username from meta.developer on conflict do nothing`);
  });

  test('imports go into the current workspace; working copies follow their main application', async () => {
    const beta = await wsId(WS[1]);
    const doc = (await owner.one(`select meta.export_app('ws-test-b') as d`)).d;
    await admin.get('/builder');
    await admin.submit('/builder/workspace', { workspace: String(beta) });
    await admin.get('/builder/import');
    assert.equal((await admin.submit('/builder/import', { doc: JSON.stringify(doc), alias: 'ws-test-imp' })).statusCode, 303);
    assert.equal(await appWs('ws-test-imp'), beta);
    assert.ok(!JSON.stringify(doc).includes('workspace'), 'the export carries no workspace');
    const a = (await owner.one(`select id from meta.app where alias = 'ws-test-a'`)).id;
    await admin.get(`/builder/apps/${a}/working-copies`);
    assert.equal((await admin.submit('/builder/working-copies', { main_app_id: String(a), name: 'copy1' })).statusCode, 303);
    assert.equal(await appWs('ws-test-a-copy1'), await wsId(WS[0]));
    await admin.submit('/builder/workspace', { workspace: '1' });
  });

  test('moving applications, deleting workspaces', async () => {
    const beta = await wsId(WS[1]);
    const empty = await wsId(WS[2]);
    const b = (await owner.one(`select id from meta.app where alias = 'ws-test-b'`)).id;
    await admin.get(`/builder/workspaces/${beta}`);
    // a workspace with applications can't be deleted
    await admin.submit(`/builder/workspaces/${beta}/delete`, {});
    assert.match((await admin.get(`/builder/workspaces/${beta}`)).body, /Move the applications of this workspace/);
    // moving checks the source workspace
    assert.equal((await admin.submit(`/builder/workspaces/${empty}/move`, { app: String(b), to: '1' })).statusCode, 404);
    assert.equal((await admin.submit(`/builder/workspaces/${beta}/move`, { app: String(b), to: String(empty) })).statusCode, 303);
    assert.equal(await appWs('ws-test-b'), empty);
    // non-administrators can't move or delete
    await dev.get('/builder');
    assert.equal((await dev.submit(`/builder/workspaces/${empty}/move`, { app: String(b), to: '1' })).statusCode, 403);
    assert.equal((await dev.submit(`/builder/workspaces/${empty}/delete`, {})).statusCode, 403);
    // Default can't be deleted; an empty workspace can
    await admin.submit('/builder/workspaces/1/delete', {});
    assert.ok(await owner.one('select 1 as ok from meta.workspace where id = 1'));
    await admin.submit(`/builder/workspaces/${empty}/move`, { app: String(b), to: String(beta) });
    await admin.submit(`/builder/workspaces/${empty}/delete`, {});
    assert.ok(!(await owner.one('select 1 as ok from meta.workspace where id = $1', [empty])));
  });

  test('a developer added in the builder joins the administrator\'s current workspace', async () => {
    const alpha = await wsId(WS[0]);
    await admin.get('/builder');
    await admin.submit('/builder/workspace', { workspace: String(alpha) });
    await admin.get('/builder/developers');
    await admin.submit('/builder/developers', { username: NEW_DEV, password: 'Ws-new-dev-password!' });
    assert.deepEqual((await owner.query('select workspace_id from meta.workspace_member where username = $1', [NEW_DEV])).rows.map((r) => r.workspace_id), [alpha]);
    await admin.submit('/builder/workspace', { workspace: '1' });
  });

  test('subscriptions only offer theme and library applications of the same workspace', async () => {
    const { offers } = await import('../src/subscriptions.ts');
    const a = (await owner.one(`select id from meta.app where alias = 'ws-test-a'`)).id;
    const b = (await owner.one(`select id from meta.app where alias = 'ws-test-b'`)).id;
    await owner.query(`update meta.app set app_type = 'theme' where id = $1`, [b]);
    assert.ok(!(await offers(a)).some((o) => o.master.id === b), 'another workspace\'s theme is not offered');
    const { subscribe } = await import('../src/subscriptions.ts');
    await assert.rejects(subscribe(a, b, 'theme', '', 'admin'), /Choose another application/);
    await owner.query(`update meta.app set app_type = 'standard' where id = $1`, [b]);
  });
});
