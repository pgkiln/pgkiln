// Sprint 194 (NX-F4, SEC-1): personal builder tokens and the builder's API for the command line and the MCP server.
// The Security page's region, the API's tools, exports and imports with the builder's lock rules, and `pgkiln mcp
// --url` as a real child process against a listening server: a read-only token lists pages and gets a 403 on
// saving one; revoking it stops it at once. (The security properties are in test/security.test.ts too.)
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { root } from '../src/env.ts';
import { bearerOf, createToken, parseScopes, revokeTokensOf, TokenError, type TokenScope } from '../src/builder-tokens.ts';
import { changedPages, toolScope } from '../src/builder/api-v1.ts';
import { RemoteClient } from '../src/cli/mcp.ts';
import { Browser } from './helpers.ts';

const DEV = 'tok194_dev';
const OTHER = 'tok194_other';
const PW = 'Tok194-password!';
const COPY = 'hr-tok194';
let app: FastifyInstance;
let base = '';
const tmp = mkdtempSync(join(tmpdir(), 'pgkiln-tok-'));

async function token(scopes: TokenScope[], o: { username?: string; workspaceId?: number; name?: string; days?: number } = {}) {
  return (await createToken({ username: o.username ?? DEV, workspaceId: o.workspaceId ?? 1, name: o.name ?? `t ${Math.random().toString(36).slice(2, 8)}`, scopes, days: o.days ?? 30 })).token;
}

const api = (t: string | null, method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url: `/builder/api/v1/${path}`, headers: { ...(t ? { authorization: `Bearer ${t}` } : {}), ...headers }, ...(body === undefined ? {} : { payload: body as object }) });
const tool = (t: string, name: string, args: Record<string, unknown> = {}) => api(t, 'POST', `tools/${name}`, args);

before(async () => {
  await owner.query('delete from meta.app where alias = $1', [COPY]);
  await owner.query('delete from meta.developer where username = any($1)', [[DEV, OTHER]]);
  await owner.query('insert into meta.developer (username, password_hash, is_admin) values ($1, meta.hash_password($2), false), ($3, meta.hash_password($2), false)', [DEV, PW, OTHER]);
  app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
after(async () => {
  await owner.query('delete from meta.app where alias = $1', [COPY]);
  await owner.query('delete from meta.developer where username = any($1)', [[DEV, OTHER]]);
  await owner.query(`delete from meta.activity_log where app_id is null and event = 'login_failed' and detail like 'builder%'`);
  rmSync(tmp, { recursive: true, force: true });
  await app.close();
  await closePools();
});

describe('builder tokens: the model', () => {
  test('scopes, the header, names and expiry are checked', async () => {
    assert.deepEqual(parseScopes(['write', 'read']), ['read', 'write']);
    assert.deepEqual(parseScopes('sql, read'), ['read', 'sql']);
    assert.throws(() => parseScopes(['admin']), TokenError);
    assert.equal(bearerOf('Bearer pgkb_abc'), 'pgkb_abc');
    assert.equal(bearerOf('bearer  pgkb_abc '), 'pgkb_abc');
    assert.equal(bearerOf('Basic abc'), null);
    assert.equal(bearerOf(['Bearer x']), null);
    await assert.rejects(createToken({ username: DEV, workspaceId: 1, name: ' ', scopes: ['read'], days: 30 }), TokenError);
    await assert.rejects(createToken({ username: DEV, workspaceId: 1, name: 'x', scopes: [], days: 30 }), TokenError);
    await assert.rejects(createToken({ username: DEV, workspaceId: 1, name: 'x', scopes: ['read'], days: 366 }), /1 to 365/);
    await assert.rejects(createToken({ username: DEV, workspaceId: 1, name: 'x', scopes: ['read'], days: 0 }), TokenError);
    // the table refuses a token for longer than a year, whoever inserts it
    await assert.rejects(owner.query(`insert into meta.builder_token (username, workspace_id, name, token_hash, scopes, expires_at) values ($1, 1, 'forever', repeat('a', 64), '{read}', now() + interval '5 years')`, [DEV]));
    const t = await createToken({ username: DEV, workspaceId: 1, name: 'same name', scopes: ['read'], days: 1 });
    assert.match(t.token, /^pgkb_[A-Za-z0-9_-]{43}$/);
    await assert.rejects(createToken({ username: DEV, workspaceId: 1, name: 'Same Name', scopes: ['read'], days: 1 }), /already have a token named/);
  });

  test('the scope of each tool; files stay on the developer\'s machine', () => {
    assert.equal(toolScope('list_apps', {}), 'read');
    assert.equal(toolScope('get_page', {}), 'read');
    assert.equal(toolScope('run_query', {}), 'sql');
    assert.equal(toolScope('lock_app', {}), 'write');
    assert.equal(toolScope('working_copy', { action: 'compare' }), 'read');
    assert.equal(toolScope('working_copy', { action: 'merge' }), 'write');
    assert.equal(toolScope('import_app', {}), null);
    assert.equal(toolScope('advise_app', { path: 'apps/hr' }), null);
    assert.equal(toolScope('nope', {}), null);
  });

  test('changedPages: the pages whose files differ', async () => {
    const doc = (await owner.one(`select meta.export_app('hr') as d`))!.d;
    assert.deepEqual([...changedPages(doc, doc)], []);
    const changed = structuredClone(doc);
    const p = changed.pages.find((x: { page_no: number }) => x.page_no === 2);
    p.title = `${p.title} (changed)`;
    assert.deepEqual([...changedPages(doc, changed)], [2]);
  });

  test('the remote client wants https (http only to this machine) and a builder token', () => {
    const t = `pgkb_${'a'.repeat(43)}`;
    assert.throws(() => new RemoteClient('http://pgkiln.example.com', t), /https/);
    assert.throws(() => new RemoteClient('https://user:pw@pgkiln.example.com', t), /address only/);
    assert.throws(() => new RemoteClient('https://pgkiln.example.com', 'secret'), /not a builder token/);
    assert.equal(new RemoteClient('https://pgkiln.example.com/builder/', t).base, 'https://pgkiln.example.com');
    assert.equal(new RemoteClient('http://localhost:3100', t).base, 'http://localhost:3100');
  });
});

describe('the builder API', () => {
  test('read: who, the applications, a page, an export; no write, no SQL', async () => {
    const t = await token(['read']);
    const me = await api(t, 'GET', 'me');
    assert.equal(me.statusCode, 200, me.body);
    assert.equal(me.headers['cache-control'], 'no-store');
    const meBody = me.json() as Record<string, unknown>;
    assert.deepEqual({ ...meBody, expires_at: undefined }, { developer: DEV, administrator: false, token: meBody.token, scopes: ['read'], expires_at: undefined, workspace: 'Default' });
    const apps = await tool(t, 'list_apps');
    assert.equal(apps.statusCode, 200, apps.body);
    assert.match(apps.json().text, /alias: hr\b|"alias": "hr"|hr/);
    const page = await tool(t, 'get_page', { alias: 'hr', page: 1 });
    assert.equal(page.statusCode, 200, page.body);
    assert.match(page.json().text, /=== pages\/0001-/);
    const info = JSON.parse((await tool(t, 'pgkiln_info')).json().text);
    assert.equal(info.developer, DEV);
    assert.equal(info.database, undefined, 'not the server\'s database');
    const exp = await api(t, 'GET', 'apps/hr/export');
    assert.equal(exp.statusCode, 200);
    assert.equal(exp.json().doc.app.alias, 'hr');
    // write and sql are refused with a 403 that names the scope
    const imp = await api(t, 'POST', 'apps/hr/import', { doc: exp.json().doc, replace: true });
    assert.equal(imp.statusCode, 403);
    assert.match(imp.json().error, /no write scope/);
    assert.equal((await tool(t, 'run_query', { sql: 'select 1' })).statusCode, 403);
    assert.equal((await tool(t, 'lock_app', { alias: 'hr' })).statusCode, 403);
    // file tools run on the developer's machine
    assert.equal((await tool(t, 'export_app', { alias: 'hr' })).statusCode, 400);
    assert.equal((await tool(t, 'nope')).statusCode, 404);
    // every call is in the activity log with the token's name
    const log = await owner.one<{ n: number }>(`select count(*)::int as n from meta.activity_log where username = $1 and event = 'builder_api' and detail like 'token %: get_page hr'`, [DEV]);
    assert.ok(log!.n >= 1);
    const refused = await owner.one<{ n: number }>(`select count(*)::int as n from meta.activity_log where username = $1 and event = 'forbidden' and detail like '%needs the write scope'`, [DEV]);
    assert.ok(refused!.n >= 1);
  });

  test('sql: read-only queries as the workspace\'s developer login, never the owner', async () => {
    const t = await token(['read', 'sql']);
    const ownerRole = (await owner.one<{ u: string }>('select current_user as u'))!.u;
    const devRole = (await owner.one<{ r: string }>('select dev_role as r from meta.workspace where id = 1'))!.r;
    const r = await tool(t, 'run_query', { sql: 'select current_user as who, session_user as login' });
    assert.equal(r.statusCode, 200, r.body);
    const row = JSON.parse(r.json().text).rows[0];
    assert.equal(row.login, devRole);
    assert.notEqual(row.who, ownerRole);
    // pgkiln's own tables are not the developer login's
    const meta = await tool(t, 'run_query', { sql: 'select count(*) from meta.developer' });
    assert.equal(meta.statusCode, 422);
    assert.match(meta.json().error, /permission denied/);
    // read-only: a write fails
    assert.equal((await tool(t, 'run_query', { sql: 'create table public.tok194_x (id int)' })).statusCode, 422);
    // describe_schema: the schemas the login may use, never meta
    const d = await tool(t, 'describe_schema', {});
    assert.equal(d.statusCode, 200, d.body);
    assert.doesNotMatch(d.json().text, /^meta$/m);
    assert.equal((await tool(t, 'describe_schema', { schema: 'meta' })).statusCode, 422);
    assert.equal((await tool(t, 'describe_schema', { table: 'meta.developer' })).statusCode, 422);
    assert.equal((await tool(t, 'generate_ddl', { schema: 'meta' })).statusCode, 422);
  });

  test('write: a new application lands in the token\'s workspace; an import over it keeps the lock rules', async () => {
    const t = await token(['read', 'write']);
    const doc = (await api(t, 'GET', 'apps/hr/export')).json().doc;
    const made = await api(t, 'POST', `apps/${COPY}/import`, { doc, check: 'off' });
    assert.equal(made.statusCode, 200, made.body);
    assert.equal(made.json().result.committed, true);
    const id = made.json().result.id;
    assert.equal((await owner.one<{ ws: number }>('select meta.app_workspace($1::int) as ws', [id]))!.ws, 1);
    // without replace: the alias is taken
    assert.equal((await api(t, 'POST', `apps/${COPY}/import`, { doc, check: 'off' })).statusCode, 409);
    // another developer locks page 2: an import that changes page 2 is refused, one that doesn't goes through
    await owner.query(`insert into meta.builder_lock (app_id, page_no, locked_by, note) values ($1, 2, $2, 'tok194')`, [id, OTHER]);
    const changed = structuredClone(doc);
    changed.pages.find((x: { page_no: number }) => x.page_no === 2).title = 'Changed by a token';
    const locked = await api(t, 'POST', `apps/${COPY}/import`, { doc: changed, replace: true, check: 'off' });
    assert.equal(locked.statusCode, 409, locked.body);
    assert.match(locked.json().error, /locked by tok194_other/i);
    const other = structuredClone(doc);
    other.pages.find((x: { page_no: number }) => x.page_no === 1).title = 'Page 1 by a token';
    const ok = await api(t, 'POST', `apps/${COPY}/import`, { doc: other, replace: true, check: 'off' });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal((await owner.one(`select title from meta.page where app_id = $1 and page_no = 1`, [id]))!.title, 'Page 1 by a token');
    // the lock of another developer is only broken by an administrator's token
    const br = await tool(t, 'lock_app', { alias: COPY, page: 2, unlock: true, force: true });
    assert.equal(br.statusCode, 422);
    assert.match(br.json().error, /only administrators/);
    // locks and working copies are the token's developer's, whatever the arguments say
    const lk = await tool(t, 'lock_app', { alias: COPY, page: 3, developer: 'someone else' });
    assert.equal(lk.statusCode, 200, lk.body);
    assert.equal((await owner.one(`select locked_by from meta.builder_lock where app_id = $1 and page_no = 3`, [id]))!.locked_by, DEV);
    // a Run only application refuses every import
    await owner.query(`update meta.app set build_status = 'run_only' where id = $1`, [id]);
    const ro = await api(t, 'POST', `apps/${COPY}/import`, { doc: other, replace: true, check: 'off' });
    assert.equal(ro.statusCode, 409);
    assert.match(ro.json().error, /Run only/);
    await owner.query(`update meta.app set build_status = 'run_and_build' where id = $1`, [id]);
    // Updated by: the developer
    assert.equal((await owner.one(`select updated_by from meta.app_change where app_id = $1`, [id]))!.updated_by, DEV);
  });
});

describe('pgkiln mcp --url: the MCP server on a developer\'s machine, through a token', () => {
  let server: ChildProcessWithoutNullStreams;
  const waiting = new Map<number, (msg: any) => void>();
  let nextId = 1;
  let readToken = '';
  const rpc = (method: string, params?: unknown): Promise<any> => {
    const id = nextId++;
    return new Promise((resolve) => {
      waiting.set(id, resolve);
      server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  };
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await rpc('tools/call', { name, arguments: args });
    return { text: r.result.content[0].text as string, error: !!r.result.isError };
  };

  before(async () => {
    readToken = await token(['read'], { name: 'agent on my laptop' });
    // no database for the child: it can only go through the API
    server = spawn(process.execPath, [join(root, 'bin/pgkiln.js'), 'mcp', '--url', base, '--token-env', 'TOK194'], {
      cwd: tmp,
      env: { ...process.env, TOK194: readToken, DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none', RUNTIME_DATABASE_URL: '' },
    });
    createInterface({ input: server.stdout }).on('line', (line) => {
      const msg = JSON.parse(line);
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    });
  });
  after(async () => {
    server.stdin.end();
    await new Promise((r) => server.once('exit', r));
  });

  test('a read-only token lists pages and exports; saving a page is a 403; revoking it stops it at once', async () => {
    assert.ok((await rpc('initialize', { protocolVersion: '2025-06-18' })).result.serverInfo);
    const info = await call('pgkiln_info');
    assert.equal(info.error, false, info.text);
    assert.match(info.text, /agent on my laptop/);
    const overview = await call('app_overview', { alias: 'hr' });
    assert.equal(overview.error, false, overview.text);
    assert.match(overview.text, /=== pages/);
    // export_app writes files here, from the API's export
    const exp = await call('export_app', { alias: 'hr' });
    assert.equal(exp.error, false, exp.text);
    const dir = join(tmp, 'apps', 'hr');
    const pageDir = readdirSync(join(dir, 'pages')).find((d) => d.startsWith('0002-'))!;
    const pageFile = join(dir, 'pages', pageDir, 'page.yaml');
    writeFileSync(pageFile, readFileSync(pageFile, 'utf8').replace(/^title: .*$/m, 'title: Saved by an agent'));
    const diff = await call('diff_app', { alias: 'hr' });
    assert.match(diff.text, /M pages\/0002-/);
    // saving the page: the server answers 403 for a token without the write scope
    const save = await call('import_app', { alias: 'hr', replace: true, only: ['pages/2'] });
    assert.equal(save.error, true);
    assert.match(save.text, /^Error: 403\b.*no write scope/);
    assert.notEqual((await owner.one(`select p.title from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 2`))!.title, 'Saved by an agent');
    // revoked: the next call is refused at once
    await owner.query(`update meta.builder_token set revoked_at = now() where name = 'agent on my laptop' and username = $1`, [DEV]);
    const gone = await call('list_apps');
    assert.equal(gone.error, true);
    assert.match(gone.text, /^Error: 401\b.*revoked/);
  });
});

describe('builder tokens in the builder', () => {
  test('the Security page makes a token once, shows it once and lists it; revoking it ends it', async () => {
    const b = new Browser(app);
    await b.get('/builder/login');
    assert.equal((await b.submit('/builder/login', { username: DEV, password: PW })).statusCode, 303);
    const page = (await b.get('/builder/security')).body;
    assert.match(page, /id="tokens"/);
    assert.match(page, /action="\/builder\/security\/tokens"/);
    assert.doesNotMatch(page, /name="password"/, 'just signed in: no step-up');
    const res = await b.submit('/builder/security/tokens', { name: 'Laptop', days: '7', scopes: ['read', 'write'], workspace: '1' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    const shown = /id="f_new_token"[^>]*value="(pgkb_[^"]+)"/.exec(res.body)?.[1];
    assert.ok(shown, 'the token is shown');
    // shown once: not on the page again, not in the session, the log or the table
    assert.doesNotMatch((await b.get('/builder/security')).body, new RegExp(shown));
    for (const sql of [`select count(*)::int as n from meta.session where state::text like '%' || $1 || '%'`, `select count(*)::int as n from meta.activity_log where detail like '%' || $1 || '%'`, `select count(*)::int as n from meta.builder_token where token_hash = $1 or name = $1`])
      assert.equal((await owner.one(sql, [shown]))!.n, 0, sql);
    const row = (await owner.one<{ id: number; scopes: string[]; days: number }>(`select id::int, scopes, round(extract(epoch from expires_at - created_at) / 86400)::int as days from meta.builder_token where username = $1 and name = 'Laptop'`, [DEV]))!;
    assert.deepEqual([row.scopes, row.days], [['read', 'write'], 7]);
    assert.equal((await api(shown, 'GET', 'me')).statusCode, 200);
    // listed; revoked from the page
    await b.get('/builder/security');
    await b.submit(`/builder/security/tokens/${row.id}/revoke`, {});
    assert.equal((await api(shown, 'GET', 'me')).statusCode, 401);
    // another developer can't revoke it (or see it)
    const t2 = await createToken({ username: DEV, workspaceId: 1, name: 'tok194-second', scopes: ['read'], days: 1 });
    const o = new Browser(app);
    await o.get('/builder/login');
    await o.submit('/builder/login', { username: OTHER, password: PW });
    await o.get('/builder/security');
    assert.doesNotMatch((await o.get('/builder/security')).body, /tok194-second/);
    assert.equal((await o.submit(`/builder/security/tokens/${t2.id}/revoke`, {})).statusCode, 404);
    // an administrator sees every developer's live tokens on Developers and revokes one
    const a = new Browser(app);
    await a.get('/builder/login');
    await a.submit('/builder/login', { username: 'admin', password: 'admin' });
    const devs = (await a.get('/builder/developers')).body;
    assert.match(devs, /Builder tokens of all developers/);
    assert.match(devs, new RegExp(`${DEV}</td>\\s*<td[^>]*>.*tok194-second`));
    await a.submit(`/builder/security/tokens/${t2.id}/revoke`, { back: 'developers' });
    assert.ok((await owner.one(`select revoked_at from meta.builder_token where id = $1`, [t2.id]))!.revoked_at);
  });

  test('revoked when the developer\'s second factors are reset or an administrator sets their password', async () => {
    const t1 = await token(['read']);
    const { resetFactors } = await import('../src/mfa.ts');
    await resetFactors(DEV);
    assert.equal((await api(t1, 'GET', 'me')).statusCode, 401);
    const t2 = await token(['read']);
    await new Promise<void>((resolve, reject) => {
      const p = spawn(process.execPath, [join(root, 'bin/pgkiln.js'), 'users', 'password', DEV, '--developer'], { cwd: root });
      p.stdin.end(`${PW}\n`);
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
    });
    assert.equal((await api(t2, 'GET', 'me')).statusCode, 401);
    const t3 = await token(['read']);
    assert.equal(await revokeTokensOf(DEV, 'test'), 1);
    assert.equal((await api(t3, 'GET', 'me')).statusCode, 401);
  });
});
