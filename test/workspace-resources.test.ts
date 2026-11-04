// Sprint 141 (AP-7): static workspace files, remote servers and workspace web credentials (migration 141).
// Remote server CRM of the HR example moves every REST data source on it at once; a CSS file of the workspace
// styles two applications; a workspace credential signs a source's requests unless the application has its own
// of that name; catalogs and AI services on a server; the workspace export; the Advisor and the network page.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { joinUrl, resolveSource, serverProblems, serverUrl } from '../src/remote-servers.ts';
import { parseIncludes } from '../src/builder/static-files.ts';
import { clearResponseCache, fetchSource, loadCredential, loadSource, sourceProblems } from '../src/websources.ts';
import { encryptSecret } from '../src/secrets.ts';
import { Browser } from './helpers.ts';

process.env.PGKILN_SECRET_KEY ??= 'test-only-secret-key-0123456789abcdef';

let app: FastifyInstance;
let mock: Server;
let mockBase = '';
const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
const WS = 'S141 Workspace';
const ADMIN = 's141admin';
const DEV = 's141dev';
let ws: number;
let appA: number;
let appB: number;
let hr: number;
let hrWs: number;
let crm: { base_url: string | null } | undefined;
const env = { allowed: process.env.PGKILN_REST_ALLOWED_HOSTS, priv: process.env.PGKILN_REST_PRIVATE_HOSTS };

async function signIn(username: string, workspace?: number) {
  const b = new Browser(app);
  await b.get('/builder/login');
  assert.equal((await b.post('/builder/login', { __csrf: b.lastCsrf, username, password: username === 'admin' ? 'admin' : username })).statusCode, 303);
  await b.get('/builder/home');
  if (workspace) assert.equal((await b.post('/builder/workspace', { __csrf: b.lastCsrf, workspace: String(workspace) })).statusCode, 303);
  await b.get('/builder/home');
  return b;
}

async function cleanup() {
  await owner.query(`delete from meta.app where alias in ('s141a', 's141b', 's141imp')`);
  await owner.query('delete from meta.workspace where name = $1', [WS]);
  await owner.query('delete from meta.developer where username = any($1::text[])', [[ADMIN, DEV]]);
}

before(async () => {
  app = await buildApp({ logger: false });
  await cleanup();
  mock = createServer((req, res) => {
    seen.push({ url: req.url!, headers: req.headers });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"items":[{"id":1,"name":"one"},{"id":2,"name":"two"}]}');
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  mockBase = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
  process.env.PGKILN_REST_ALLOWED_HOSTS = '127.0.0.1';
  process.env.PGKILN_REST_PRIVATE_HOSTS = '127.0.0.1';
  for (const u of [ADMIN, DEV]) await owner.query(`insert into meta.developer (username, password_hash, is_admin) values ($1, meta.hash_password($1), false)`, [u]);
  ws = (await owner.one(`insert into meta.workspace (name) values ($1) returning id`, [WS])).id;
  await owner.query('insert into meta.workspace_member (workspace_id, username, is_admin) values ($1, $2, true), ($1, $3, false)', [ws, ADMIN, DEV]);
  for (const alias of ['s141a', 's141b']) {
    const id = (await owner.one(`insert into meta.app (alias, name, authentication, home_page) values ($1, $1, 'none', 1) returning id`, [alias])).id;
    const page = (await owner.one(`insert into meta.page (app_id, page_no, name, requires_auth) values ($1, 1, 'Home', false) returning id`, [id])).id;
    await owner.query(`insert into meta.region (page_id, seq, title, type, source) values ($1, 10, 'Logo', 'static', '<img src="#WORKSPACE_FILES#logo.png" alt="Logo"> <a href="#APP_FILES#guide.pdf">Guide</a>')`, [page]);
    await owner.query('insert into meta.workspace_app (app_id, workspace_id) values ($1, $2)', [id, ws]);
    if (alias === 's141a') appA = id;
    else appB = id;
  }
  hr = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  hrWs = (await owner.one('select meta.app_workspace($1) as ws', [hr])).ws;
  crm = await owner.one(`select base_url from meta.remote_server where workspace_id = $1 and static_id = 'CRM'`, [hrWs]);
});

after(async () => {
  mock.close();
  if (crm) await owner.query(`update meta.remote_server set base_url = $2 where workspace_id = $1 and static_id = 'CRM'`, [hrWs, crm.base_url]);
  process.env.PGKILN_REST_ALLOWED_HOSTS = env.allowed;
  process.env.PGKILN_REST_PRIVATE_HOSTS = env.priv;
  if (env.allowed === undefined) delete process.env.PGKILN_REST_ALLOWED_HOSTS;
  if (env.priv === undefined) delete process.env.PGKILN_REST_PRIVATE_HOSTS;
  delete process.env.PGKILN_SERVER_S141;
  await cleanup();
  await app.close();
  await closePools();
});

describe('remote servers', () => {
  test('checks: static id, base URL, environment variable (PGKILN_SERVER_ only), credential', () => {
    assert.deepEqual(serverProblems({ static_id: 'CRM', name: 'CRM', base_url: 'https://crm.example.com/api' }), []);
    assert.deepEqual(serverProblems({ static_id: 'CRM', name: 'CRM', env_var: 'PGKILN_SERVER_CRM' }), []);
    for (const bad of [
      { static_id: 'crm', name: 'x', base_url: 'https://a.example.com' },
      { static_id: 'CRM', name: 'x', base_url: 'https://a.example.com/' },
      { static_id: 'CRM', name: 'x', base_url: 'https://a.example.com/?q=1' },
      { static_id: 'CRM', name: 'x', base_url: 'ftp://a.example.com' },
      { static_id: 'CRM', name: 'x', base_url: 'https://user:pw@a.example.com' },
      { static_id: 'CRM', name: 'x', env_var: 'DATABASE_URL' },
      { static_id: 'CRM', name: 'x' },
      { static_id: 'CRM', name: 'x', base_url: 'https://a.example.com', credential: 'lower' },
    ]) assert.ok(serverProblems(bad).length, JSON.stringify(bad));
  });

  test('the environment variable wins when set; paths join the base URL', () => {
    const s = { static_id: 'S141', base_url: 'http://127.0.0.1:1', env_var: 'PGKILN_SERVER_S141' };
    assert.deepEqual(serverUrl(s), { url: 'http://127.0.0.1:1', from: 'stored', problem: null });
    process.env.PGKILN_SERVER_S141 = 'https://prod.example.com/api/';
    assert.deepEqual(serverUrl(s), { url: 'https://prod.example.com/api', from: 'env', problem: null });
    process.env.PGKILN_SERVER_S141 = 'not a url';
    const bad = serverUrl(s);
    assert.equal(bad.url, null);
    assert.doesNotMatch(bad.problem!, /not a url/, 'the value is never repeated');
    delete process.env.PGKILN_SERVER_S141;
    assert.equal(serverUrl({ static_id: 'X', base_url: null, env_var: 'PGKILN_SERVER_S141' }).url, null);
    assert.equal(joinUrl('https://a.example.com/api', '/v1/x?y=1'), 'https://a.example.com/api/v1/x?y=1');
    assert.equal(joinUrl('https://a.example.com/api', ''), 'https://a.example.com/api');
    assert.equal(joinUrl('https://a.example.com/api', 'v1'), 'https://a.example.com/api/v1');
  });

  test('a source on a server: a path after it; a full URL without one', () => {
    assert.deepEqual(sourceProblems({ server: 'CRM', url: '/v1/items/{id}', params: [{ name: 'id', in: 'path' }], columns: [] }), []);
    assert.deepEqual(sourceProblems({ server: 'CRM', url: '', params: [], columns: [] }), []);
    assert.ok(sourceProblems({ server: 'CRM', url: 'https://other.example.com/x', params: [], columns: [] }).length);
    assert.ok(sourceProblems({ server: 'CRM', url: '/a/../b', params: [], columns: [] }).length);
    assert.ok(sourceProblems({ url: '/v1/items', params: [], columns: [] }).length, 'no server: a full URL');
  });

  test('done when: changing CRM moves every REST data source of HR on it at once', async () => {
    const onCrm = (await owner.query<{ name: string }>(`select name from meta.rest_source where app_id = $1 and server = 'CRM' order by name`, [hr])).rows.map((r) => r.name);
    assert.deepEqual(onCrm, ['DEPARTMENT', 'DEPARTMENTS', 'EMPLOYEES_API']);
    for (const n of onCrm) assert.match((await loadSource(hr, n)).url, /^http:\/\/127\.0\.0\.1:3100\/a\/hr\/rest\/v1\//);
    // the workspace's administrator changes one value in the builder
    const admin = await signIn('admin', hrWs);
    const page = await admin.get('/builder/remote-servers');
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /REST data source hr\.DEPARTMENTS/);
    const id = (await owner.one(`select id from meta.remote_server where workspace_id = $1 and static_id = 'CRM'`, [hrWs])).id;
    await admin.get(`/builder/remote-servers?edit=${id}`);
    const res = await admin.submit('/builder/remote-servers', { id: String(id), static_id: 'CRM', name: 'HR API (CRM)', base_url: 'https://crm.example.com', env_var: 'PGKILN_SERVER_CRM', credential: '' });
    assert.equal(res.statusCode, 303);
    const urls = await Promise.all(onCrm.map(async (n) => (await loadSource(hr, n)).url));
    assert.deepEqual(urls, ['https://crm.example.com/a/hr/rest/v1/departments/{deptno}', 'https://crm.example.com/a/hr/rest/v1/departments', 'https://crm.example.com/a/hr/rest/v1/employees']);
    // CRM_CONTACTS keeps its own full URL
    assert.match((await loadSource(hr, 'CRM_CONTACTS')).url, /^http:\/\/127\.0\.0\.1:3100\//);
    await owner.query(`update meta.remote_server set base_url = $2 where id = $1`, [id, crm!.base_url]);
  });

  test('calls: the server\'s URL and its default credential, a workspace credential unless the application has its own', async () => {
    await owner.query(`insert into meta.remote_server (workspace_id, static_id, name, base_url, credential) values ($1, 'S141', 'Mock', $2, 'S141_TOKEN')`, [ws, mockBase]);
    await owner.query(`insert into meta.workspace_credential (workspace_id, name, type, secret_enc) values ($1, 'S141_TOKEN', 'bearer', $2)`, [ws, encryptSecret('workspace-token')]);
    await owner.query(`insert into meta.rest_source (app_id, name, url, server, row_selector) values ($1, 'ITEMS', '/items?x=1', 'S141', 'items')`, [appA]);
    clearResponseCache();
    const src = await loadSource(appA, 'ITEMS');
    assert.equal(src.url, `${mockBase}/items?x=1`);
    assert.equal(src.credential, 'S141_TOKEN');
    assert.deepEqual(await resolveSource(src), src, 'resolving again changes nothing');
    const { json } = await fetchSource(src, {});
    assert.equal((json as any).items.length, 2);
    assert.equal(seen.at(-1)!.headers.authorization, 'Bearer workspace-token');
    // the application's own credential of that name wins
    await owner.query(`insert into meta.web_credential (app_id, name, type, secret_enc) values ($1, 'S141_TOKEN', 'bearer', $2)`, [appA, encryptSecret('app-token')]);
    const c = await loadCredential(appA, 'S141_TOKEN');
    assert.ok(!c.workspace);
    await fetchSource(await loadSource(appA, 'ITEMS'), {});
    assert.equal(seen.at(-1)!.headers.authorization, 'Bearer app-token');
    await owner.query(`delete from meta.web_credential where app_id = $1 and name = 'S141_TOKEN'`, [appA]);
    // an application of another workspace (HR) finds neither
    await assert.rejects(loadCredential(hr, 'S141_TOKEN'), /does not exist/);
    await owner.query(`insert into meta.rest_source (app_id, name, url, server) values ($1, 'S141_ELSEWHERE', '/items', 'S141')`, [hr]);
    try {
      await assert.rejects(loadSource(hr, 'S141_ELSEWHERE'), /Remote server S141 does not exist in this application's workspace/);
    } finally {
      await owner.query(`delete from meta.rest_source where app_id = $1 and name = 'S141_ELSEWHERE'`, [hr]);
    }
  });

  test('the Advisor and an import name a server the workspace lacks; nothing crashes', async () => {
    const { advise } = await import('../src/builder/advisor.ts');
    await owner.query(`insert into meta.rest_source (app_id, name, url, server, credential) values ($1, 'MISSING', '/x', 'NOWHERE', 'NO_SUCH_CRED')`, [appB]);
    const f = (await advise(appB)).findings;
    assert.ok(f.some((x) => x.field === 'Remote server' && /NOWHERE doesn't exist/.test(x.message) && x.severity === 'warning'));
    assert.ok(f.some((x) => x.field === 'Web credential' && /NO_SUCH_CRED/.test(x.message)));
    // an export with the reference imports into a workspace without the server
    const doc = (await owner.one(`select meta.export_app('s141b') as d`)).d;
    assert.equal(doc.rest_sources.find((x: any) => x.name === 'MISSING').server, 'NOWHERE');
    const admin = await signIn(ADMIN, ws);
    await admin.get('/builder/import');
    const res = await admin.submit('/builder/import', { doc: JSON.stringify(doc), alias: 's141imp' });
    assert.equal(res.statusCode, 303);
    const page = await admin.get(String(res.headers.location));
    assert.match(page.body, /remote server NOWHERE, which this workspace doesn&#39;t have/);
    await owner.query(`delete from meta.rest_source where app_id = $1 and name = 'MISSING'`, [appB]);
  });

  test('renaming a server moves this workspace\'s sources and catalogs along; the network page names the host', async () => {
    const admin = await signIn(ADMIN, ws);
    const cat = (await owner.one(`insert into meta.rest_catalog (workspace_id, name, server) values ($1, 'S141 catalog', 'S141') returning id`, [ws])).id;
    await owner.query(`insert into meta.rest_catalog_service (catalog_id, name, path) values ($1, 'GET_ITEMS', '/items')`, [cat]);
    const id = (await owner.one(`select id from meta.remote_server where workspace_id = $1 and static_id = 'S141'`, [ws])).id;
    await admin.get(`/builder/remote-servers?edit=${id}`);
    assert.equal((await admin.submit('/builder/remote-servers', { id: String(id), static_id: 'S141_MOCK', name: 'Mock', base_url: mockBase, credential: 'S141_TOKEN' })).statusCode, 303);
    assert.equal((await owner.one(`select server from meta.rest_source where app_id = $1 and name = 'ITEMS'`, [appA])).server, 'S141_MOCK');
    assert.equal((await owner.one('select server from meta.rest_catalog where id = $1', [cat])).server, 'S141_MOCK');
    // a data source from the catalog's service names the server and the path
    await admin.get(`/builder/apps/${appB}/shared`);
    const svc = (await owner.one('select id from meta.rest_catalog_service where catalog_id = $1', [cat])).id;
    assert.equal((await admin.submit(`/builder/apps/${appB}/rest-sources/from-catalog`, { service: String(svc), name: 'FROM_CAT', credential: '' })).statusCode, 303);
    assert.deepEqual(await owner.one(`select server, url from meta.rest_source where app_id = $1 and name = 'FROM_CAT'`, [appB]), { server: 'S141_MOCK', url: '/items' });
    assert.equal((await loadSource(appB, 'FROM_CAT')).url, `${mockBase}/items`);
    const net = (await admin.get(`/builder/network?ws=${ws}`)).body;
    assert.match(net, /Remote servers/);
    assert.match(net, new RegExp(`<code>127\\.0\\.0\\.1:${new URL(mockBase).port}</code>`));
  });

  test('an AI service on a server takes its URL', async () => {
    const { loadService } = await import('../src/ai/service.ts');
    const sid = (await owner.one(`select id from meta.remote_server where workspace_id = $1 and static_id = 'S141_MOCK'`, [ws])).id;
    await owner.query(`delete from meta.ai_service where name = 'S141_AI'`);
    await owner.query(`insert into meta.ai_service (name, provider, model, server_id, server_path) values ('S141_AI', 'openai_compatible', 'llama3', $1, '/v1')`, [sid]);
    try {
      assert.equal((await loadService('S141_AI'))!.base_url, `${mockBase}/v1`);
      await owner.query(`update meta.remote_server set base_url = 'https://llm.example.com' where id = $1`, [sid]);
      assert.equal((await loadService('S141_AI'))!.base_url, 'https://llm.example.com/v1');
      const page = (await (await signIn('admin')).get(`/builder/ai/${(await owner.one(`select id from meta.ai_service where name = 'S141_AI'`)).id}`)).body;
      assert.match(page, /S141_MOCK \(S141 Workspace\)/);
    } finally {
      await owner.query(`update meta.remote_server set base_url = $2 where id = $1`, [sid, mockBase]);
      await owner.query(`delete from meta.ai_service where name = 'S141_AI'`);
    }
  });
});

describe('static workspace files', () => {
  test('includes: #WORKSPACE_FILES#name and #APP_FILES#name', () => {
    assert.deepEqual(parseIncludes('#WORKSPACE_FILES#brand.css, #APP_FILES#app.js, x.css, #WORKSPACE_FILES#page.html, #WORKSPACE_FILES#../a.js'),
      ['#WORKSPACE_FILES#brand.css', 'app.js', 'x.css']);
  });

  test('done when: a CSS file of the workspace styles two applications', async () => {
    const admin = await signIn(ADMIN, ws);
    assert.equal((await admin.get('/builder/workspace-files')).statusCode, 200);
    const css = Buffer.from('.s141-brand { color: rebeccapurple; }\n');
    const up = await admin.upload('/builder/workspace-files/upload', {}, { file: [{ name: 'brand.css', type: 'text/css', data: css }, { name: 'logo.png', type: 'image/png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }] });
    assert.equal(up.statusCode, 303);
    for (const id of [appA, appB]) {
      await admin.get(`/builder/apps/${id}/static-files`);
      assert.equal((await admin.submit(`/builder/apps/${id}/static-files/includes`, { includes: '#WORKSPACE_FILES#brand.css' })).statusCode, 303);
    }
    assert.match((await admin.get('/builder/workspace-files')).body, /s141a, s141b/);
    for (const alias of ['s141a', 's141b']) {
      const page = (await new Browser(app).get(`/a/${alias}/1`)).body;
      const m = new RegExp(`<link rel="stylesheet" href="/a/${alias}/workspace-files/brand\\.css\\?v=(\\d+)">`).exec(page);
      assert.ok(m, `${alias} loads brand.css`);
      // #WORKSPACE_FILES# and #APP_FILES# in the page's HTML
      assert.match(page, new RegExp(`<img src="/a/${alias}/workspace-files/logo\\.png" alt="Logo">`));
      assert.match(page, new RegExp(`<a href="/a/${alias}/static/guide\\.pdf">`));
      const res = await new Browser(app).get(`/a/${alias}/workspace-files/brand.css?v=${m![1]}`);
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['content-type'], 'text/css; charset=utf-8');
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
      assert.match(String(res.headers['cache-control']), /immutable/);
      assert.equal(res.body, css.toString());
    }
    // a missing file is left out, not linked
    await owner.query(`update meta.app set static_includes = '{#WORKSPACE_FILES#brand.css,#WORKSPACE_FILES#gone.css}' where id = $1`, [appA]);
    assert.doesNotMatch((await new Browser(app).get('/a/s141a/1')).body, /gone\.css/);
    assert.equal((await new Browser(app).get('/a/s141a/workspace-files/gone.css')).statusCode, 404);
  });

  test('written, renamed and deleted in the builder', async () => {
    const admin = await signIn(ADMIN, ws);
    await admin.get('/builder/workspace-files?new=1');
    assert.equal((await admin.submit('/builder/workspace-files/save', { name: 'common.js', content: 'console.log(1);\r\n' })).statusCode, 303);
    assert.equal((await owner.one(`select content from meta.workspace_file where workspace_id = $1 and name = 'common.js'`, [ws])).content.toString(), 'console.log(1);\n');
    await admin.get('/builder/workspace-files?edit=common.js');
    await admin.submit('/builder/workspace-files/save', { original: 'common.js', name: 'shared.js', content: 'console.log(2);' });
    assert.ok(await owner.one(`select 1 from meta.workspace_file where workspace_id = $1 and name = 'shared.js'`, [ws]));
    await admin.get('/builder/workspace-files');
    await admin.submit('/builder/workspace-files/delete', { name: 'shared.js' });
    assert.ok(!(await owner.one(`select 1 from meta.workspace_file where workspace_id = $1 and name = 'shared.js'`, [ws])));
  });
});

describe('workspace web credentials and the workspace export', () => {
  test('the builder stores secrets encrypted and never shows them', async () => {
    const admin = await signIn(ADMIN, ws);
    await admin.get('/builder/workspace-credentials?new=1');
    const res = await admin.submit('/builder/workspace-credentials', { name: 'S141_KEY', type: 'header', header_name: 'X-Api-Key', secret: 'S141-very-secret', valid_for: `${mockBase}/` });
    assert.equal(res.statusCode, 303);
    const row = await owner.one(`select * from meta.workspace_credential where workspace_id = $1 and name = 'S141_KEY'`, [ws]);
    assert.match(row.secret_enc, /^v1:/);
    assert.ok(!row.secret_enc.includes('S141-very-secret'));
    const page = (await admin.get(`/builder/workspace-credentials?edit=${row.id}`)).body;
    assert.doesNotMatch(page, /S141-very-secret/);
    assert.doesNotMatch(page, new RegExp(row.secret_enc.slice(3, 23).replace(/[+/]/g, '.')));
    assert.match(page, /stored \(encrypted\)/);
    // saved again without a secret: the stored one stays; "remove" clears it
    await admin.submit('/builder/workspace-credentials', { id: String(row.id), name: 'S141_KEY', type: 'header', header_name: 'X-Api-Key', valid_for: `${mockBase}/` });
    assert.equal((await owner.one('select secret_enc from meta.workspace_credential where id = $1', [row.id])).secret_enc, row.secret_enc);
    await admin.get(`/builder/workspace-credentials?edit=${row.id}`);
    await admin.submit('/builder/workspace-credentials', { id: String(row.id), name: 'S141_KEY', type: 'header', header_name: 'X-Api-Key', remove_secret: 'true' });
    assert.equal((await owner.one('select secret_enc from meta.workspace_credential where id = $1', [row.id])).secret_enc, null);
  });

  test('export and import: files, servers and credentials (never secrets); an existing server keeps its base URL', async () => {
    const { exportWorkspace, importWorkspace } = await import('../src/workspace-export.ts');
    const doc = await exportWorkspace(ws, ['workspace_files', 'remote_servers', 'web_credentials']);
    assert.deepEqual(doc.workspace_files.map((f: any) => f.name), ['brand.css', 'logo.png']);
    assert.equal(Buffer.from(doc.workspace_files[0].content, 'base64').toString(), '.s141-brand { color: rebeccapurple; }\n');
    assert.deepEqual(doc.remote_servers.map((x: any) => x.static_id), ['S141_MOCK']);
    assert.deepEqual(doc.web_credentials.map((x: any) => x.name), ['S141_KEY', 'S141_TOKEN']);
    assert.doesNotMatch(JSON.stringify(doc), /secret_enc|password_enc|refresh_token_enc|workspace-token|v1:/);
    // into the same workspace again, replacing: the server keeps this installation's URL, the credential its secret
    await owner.query(`update meta.remote_server set base_url = 'https://prod.example.com' where workspace_id = $1 and static_id = 'S141_MOCK'`, [ws]);
    doc.remote_servers[0].name = 'Renamed';
    const r = await owner.tx((c) => importWorkspace(c, ws, doc, ['workspace_files', 'remote_servers', 'web_credentials'], { replace: true, by: 'test' }));
    assert.equal(r.replaced, 5);
    assert.deepEqual(await owner.one(`select name, base_url from meta.remote_server where workspace_id = $1 and static_id = 'S141_MOCK'`, [ws]), { name: 'Renamed', base_url: 'https://prod.example.com' });
    assert.match((await owner.one(`select secret_enc from meta.workspace_credential where workspace_id = $1 and name = 'S141_TOKEN'`, [ws])).secret_enc, /^v1:/);
    await owner.query(`update meta.remote_server set base_url = $2 where workspace_id = $1 and static_id = 'S141_MOCK'`, [ws, mockBase]);
    // a bad file type in a workspace file: nothing is imported
    const bad = { ...doc, workspace_files: [{ name: 'x.html', content: '' }] };
    await assert.rejects(owner.tx((c) => importWorkspace(c, ws, bad, ['workspace_files'], { replace: true, by: 'test' })), /not an allowed name or type/);
  });
});
