// Sprint 67: Workspace utilities → Export and import. A workspace's components
// (settings, developers, application groups, extension links, REST source
// catalogs, SQL scripts, blueprints, data generators) as one file, imported
// into another workspace: added, kept or replaced by name, all or nothing.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { describeWorkspaceFile, exportWorkspace, PARTS } from '../src/workspace-export.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let admin: Browser;
let source: number;
let target: number;
const DEV = 's67x_dev';
const DEV_PW = 'S67x-dev-password!';
const NOBODY = 's67x_nobody';

async function cleanup() {
  await owner.query(`delete from meta.workspace where name like 'S67X %'`);
  await owner.query(`delete from meta.app_group where name like 'S67X%'`);
  await owner.query(`delete from meta.developer where username = $1`, [DEV]);
}

const asFile = (doc: unknown) => ({ file: { name: 'ws.workspace.json', type: 'application/json', data: Buffer.from(JSON.stringify(doc)) } });

async function useWorkspace(b: Browser, id: number) {
  await b.get('/builder');
  await b.submit('/builder/workspace', { workspace: String(id) });
}

before(async () => {
  await cleanup();
  app = await buildApp({ logger: false });
  await owner.query(`insert into meta.developer (username, password_hash, is_admin) values ($1, meta.hash_password($2), false)`, [DEV, DEV_PW]);
  source = (await owner.one(`insert into meta.workspace (name, description, message, banner_label, banner_color, sql_workshop) values ('S67X Source', 'Where it comes from', 'Release on Friday', 'TEST', 'orange', false) returning id`)).id;
  target = (await owner.one(`insert into meta.workspace (name) values ('S67X Target') returning id`)).id;
  await owner.query('delete from meta.workspace_member where username = $1', [DEV]);
  await owner.query(`insert into meta.workspace_member (workspace_id, username, is_admin) values ($1, $2, true)`, [source, DEV]);
  await owner.query(`insert into meta.app_group (workspace_id, name, description) values ($1, 'S67X Finance', 'Money'), ($1, 'S67X Empty', null)`, [source]);
  await owner.query(`insert into meta.workspace_link (workspace_id, label, url, description, position) values ($1, 'S67X Wiki', 'https://wiki.example.com/', 'Docs', 5)`, [source]);
  const cat = (await owner.one(`insert into meta.rest_catalog (workspace_id, name, base_url) values ($1, 'S67X Weather', 'https://weather.example.com/v1') returning id`, [source])).id;
  await owner.query(`insert into meta.rest_catalog_service (catalog_id, name, path, params) values ($1, 'S67X_NOW', '/now/{city}', '[{"name": "city", "in": "path", "required": true}]')`, [cat]);
  await owner.query(`insert into meta.sql_script (workspace_id, name, description, content) values ($1, 'S67X cleanup.sql', 'Monthly', 'select 1;')`, [source]);
  await owner.query(`insert into meta.blueprint (workspace_id, name, spec) values ($1, 'S67X Tasks', '{"name": "Tasks", "tables": []}')`, [source]);
  await owner.query(`insert into meta.data_generator (workspace_id, name, schema_name, seed, tables) values ($1, 'S67X gen', 'sales', 42, '[{"table": "orders", "rows": 10}]')`, [source]);
  admin = new Browser(app);
  await admin.get('/builder/login');
  await admin.submit('/builder/login', { username: 'admin', password: 'admin' });
});

after(async () => {
  await cleanup();
  await app.close();
  await closePools();
});

describe('a workspace file', () => {
  let file: any;

  test('export: every component the source workspace has, never its name\'s settings of isolation or passwords', async () => {
    await useWorkspace(admin, source);
    const page = (await admin.get('/builder/workspace-export')).body;
    assert.match(page, /The components of the workspace S67X Source/);
    const res = await admin.submit('/builder/workspace-export', { part: [...PARTS] });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-disposition']), /s67x-source\.workspace\.json/);
    file = JSON.parse(res.body);
    assert.equal(file.format, 'pgkiln-workspace/1');
    assert.equal(file.workspace, 'S67X Source');
    assert.deepEqual(file.settings, { description: 'Where it comes from', message: 'Release on Friday', banner_label: 'TEST', banner_color: 'orange', sql_workshop: false, rest_services: true });
    assert.deepEqual(file.developers, [{ username: DEV, admin: true }]);
    assert.deepEqual(file.app_groups.map((g: any) => g.name), ['S67X Empty', 'S67X Finance']);
    assert.deepEqual(file.extension_links, [{ label: 'S67X Wiki', url: 'https://wiki.example.com/', description: 'Docs', position: 5 }]);
    assert.equal(file.rest_catalogs[0].services[0].path, '/now/{city}');
    assert.deepEqual(file.sql_scripts, [{ name: 'S67X cleanup.sql', description: 'Monthly', content: 'select 1;' }]);
    assert.equal(file.blueprints[0].spec.name, 'Tasks');
    assert.equal(file.data_generators[0].seed, 42);
    assert.doesNotMatch(res.body, /password|isolated|run_role|secret/);
    // only what was asked for
    const some = await exportWorkspace(source, ['sql_scripts']);
    assert.deepEqual(Object.keys(some).filter((k) => (PARTS as readonly string[]).includes(k)), ['sql_scripts']);
    assert.deepEqual(describeWorkspaceFile(file).counts, { settings: 1, developers: 1, app_groups: 2, extension_links: 1, rest_catalogs: 1, sql_scripts: 1, blueprints: 1, data_generators: 1 });
  });

  test('import into another workspace: everything added; the target keeps its own name', async () => {
    await useWorkspace(admin, target);
    file.developers.push({ username: NOBODY, admin: true });
    const res = await admin.upload('/builder/workspace-import', { part: [...PARTS] }, asFile(file));
    assert.equal(res.statusCode, 303);
    const page = (await admin.get('/builder/workspace-export')).body;
    assert.match(page, /Imported into S67X Target/);
    assert.match(page, /Developers: 1 added; 1 not a developer of this installation/);
    assert.match(page, /REST source catalogs: 1 added/);
    const w = await owner.one('select name, message, banner_label, banner_color, sql_workshop from meta.workspace where id = $1', [target]);
    assert.deepEqual(w, { name: 'S67X Target', message: 'Release on Friday', banner_label: 'TEST', banner_color: 'orange', sql_workshop: false });
    assert.deepEqual((await owner.query('select username, is_admin from meta.workspace_member where workspace_id = $1', [target])).rows, [{ username: DEV, is_admin: true }]);
    const counts = await owner.one(
      `select (select count(*)::int from meta.app_group where workspace_id = $1) as groups, (select count(*)::int from meta.workspace_link where workspace_id = $1) as links,
              (select count(*)::int from meta.rest_catalog_service x join meta.rest_catalog c on c.id = x.catalog_id where c.workspace_id = $1) as services,
              (select count(*)::int from meta.sql_script where workspace_id = $1) as scripts, (select count(*)::int from meta.blueprint where workspace_id = $1) as blueprints,
              (select count(*)::int from meta.data_generator where workspace_id = $1) as generators`, [target]);
    assert.deepEqual(counts, { groups: 2, links: 1, services: 1, scripts: 1, blueprints: 1, generators: 1 });
    assert.equal((await owner.one(`select created_by from meta.rest_catalog where workspace_id = $1`, [target])).created_by, 'admin');
    assert.deepEqual(await owner.one(`select schema_name, seed::int, tables from meta.data_generator where workspace_id = $1`, [target]), { schema_name: 'sales', seed: 42, tables: [{ table: 'orders', rows: 10 }] });
  });

  test('again: the same names are kept, or replaced when asked; nothing is deleted', async () => {
    await owner.query(`update meta.sql_script set content = 'select 2;' where workspace_id = $1`, [target]);
    await owner.query(`insert into meta.sql_script (workspace_id, name, content) values ($1, 'S67X own.sql', 'select 3;')`, [target]);
    await admin.get('/builder/workspace-export');
    await admin.upload('/builder/workspace-import', { part: ['sql_scripts', 'extension_links'] }, asFile(file));
    assert.match((await admin.get('/builder/workspace-export')).body, /SQL scripts: 1 kept \(same name\)/);
    assert.equal((await owner.one(`select content from meta.sql_script where workspace_id = $1 and name = 'S67X cleanup.sql'`, [target])).content, 'select 2;');
    await admin.upload('/builder/workspace-import', { part: ['sql_scripts'], replace: 'true' }, asFile(file));
    assert.match((await admin.get('/builder/workspace-export')).body, /SQL scripts: 1 replaced/);
    assert.equal((await owner.one(`select content from meta.sql_script where workspace_id = $1 and name = 'S67X cleanup.sql'`, [target])).content, 'select 1;');
    assert.ok(await owner.one(`select 1 as ok from meta.sql_script where workspace_id = $1 and name = 'S67X own.sql'`, [target]), 'its own script stays');
  });

  test('all or nothing: one bad component and nothing changes', async () => {
    const bad = JSON.parse(JSON.stringify(file));
    bad.sql_scripts = [{ name: 'S67X new.sql', content: 'select 4;' }];
    bad.extension_links = [{ label: 'S67X Bad', url: 'javascript:alert(1)' }];
    await admin.get('/builder/workspace-export');
    await admin.upload('/builder/workspace-import', { part: ['sql_scripts', 'extension_links'] }, asFile(bad));
    assert.match((await admin.get('/builder/workspace-export')).body, /Import failed, nothing was changed: the file has a value this installation refuses/);
    assert.equal(await owner.one(`select 1 as ok from meta.sql_script where name = 'S67X new.sql'`), undefined);
    // a catalog that doesn't pass the checks
    bad.rest_catalogs[0].base_url = 'ftp://x';
    await admin.upload('/builder/workspace-import', { part: ['rest_catalogs'] }, asFile(bad));
    assert.match((await admin.get('/builder/workspace-export')).body, /REST source catalog S67X Weather: The base URL starts with http/);
    // not a workspace file
    await admin.upload('/builder/workspace-import', { part: [...PARTS] }, asFile({ format: 'pgkiln/2', app: {} }));
    assert.match((await admin.get('/builder/workspace-export')).body, /Not a workspace export/);
  });

  test('application groups take this workspace\'s applications by alias', async () => {
    const hr = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
    const before = await owner.one('select group_id from meta.app_group_member where app_id = $1', [hr]);
    try {
      await useWorkspace(admin, 1);
      await admin.get('/builder/workspace-export');
      await admin.upload('/builder/workspace-import', { part: ['app_groups'] }, asFile({ format: 'pgkiln-workspace/1', app_groups: [{ name: 'S67X HR group', apps: ['hr', 'not_there'] }] }));
      assert.match((await admin.get('/builder/workspace-export')).body, /Application groups: 1 added; 1 application\(s\) of this workspace placed in them/);
      assert.equal((await owner.one('select g.name from meta.app_group_member m join meta.app_group g on g.id = m.group_id where m.app_id = $1', [hr])).name, 'S67X HR group');
    } finally {
      await owner.query(`delete from meta.app_group where name = 'S67X HR group'`);
      if (before) await owner.query('insert into meta.app_group_member (app_id, group_id) values ($1, $2) on conflict (app_id) do update set group_id = excluded.group_id', [hr, before.group_id]);
    }
  });

  test('only administrators and the workspace\'s administrators; the tile follows', async () => {
    await owner.query(`update meta.workspace_member set is_admin = false where username = $1 and workspace_id = $2`, [DEV, source]);
    const dev = new Browser(app);
    await dev.get('/builder/login');
    await dev.submit('/builder/login', { username: DEV, password: DEV_PW });
    await useWorkspace(dev, source);
    assert.doesNotMatch((await dev.get('/builder/utilities')).body, /href="\/builder\/workspace-export"/);
    assert.equal((await dev.get('/builder/workspace-export')).statusCode, 403);
    assert.equal((await dev.submit('/builder/workspace-export', { part: [...PARTS] })).statusCode, 403);
    await owner.query(`update meta.workspace_member set is_admin = true where username = $1 and workspace_id = $2`, [DEV, source]);
    assert.match((await dev.get('/builder/utilities')).body, /href="\/builder\/workspace-export"/);
    assert.equal((await dev.get('/builder/workspace-export')).statusCode, 200);
  });
});
