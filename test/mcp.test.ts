// `pgapex mcp` (src/cli/mcp.ts): the MCP server for AI coding agents. The
// protocol over a real child process, the read tools on the HR example, and
// the export → edit → diff → import round trip on a copy.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { root } from '../src/env.ts';
import { closePools, owner } from '../src/db.ts';

const tmp = mkdtempSync(join(tmpdir(), 'pgapex-mcp-'));
const COPY = 'hr_mcp_copy';
let server: ChildProcessWithoutNullStreams;
const waiting = new Map<number, (msg: any) => void>();
let nextId = 1;

function rpc(method: string, params?: unknown): Promise<any> {
  const id = nextId++;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

/** Calls a tool; returns its text, or throws with the text of a tool error. */
async function call(name: string, args: Record<string, unknown> = {}) {
  const r = await rpc('tools/call', { name, arguments: args });
  assert.ok(r.result, JSON.stringify(r));
  const text = r.result.content[0].text as string;
  if (r.result.isError) throw new Error(text);
  return text;
}

before(async () => {
  await owner.query('delete from meta.app where alias = $1', [COPY]);
  server = spawn(process.execPath, [join(root, 'bin/pgapex.js'), 'mcp'], { cwd: tmp });
  createInterface({ input: server.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
  });
});
after(async () => {
  server.stdin.end();
  await new Promise((r) => server.once('exit', r));
  await owner.query('delete from meta.app where alias = $1', [COPY]);
  rmSync(tmp, { recursive: true, force: true });
  await closePools();
});

describe('pgapex mcp: protocol', () => {
  test('initialize names the server, offers tools and explains the workflow', async () => {
    const r = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(r.result.protocolVersion, '2025-06-18');
    assert.equal(r.result.serverInfo.name, 'pgapex');
    assert.ok(r.result.capabilities.tools);
    assert.match(r.result.instructions, /export_app/);
    // an unknown version gets the newest one the server speaks
    const old = await rpc('initialize', { protocolVersion: '1999-01-01' });
    assert.equal(old.result.protocolVersion, '2025-06-18');
  });

  test('notifications get no answer; unknown methods and tools are errors', async () => {
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    assert.deepEqual((await rpc('ping')).result, {});
    assert.equal((await rpc('resources/list')).error.code, -32601);
    assert.equal((await rpc('tools/call', { name: 'nope', arguments: {} })).error.code, -32602);
  });

  test('tools/list: every tool has a schema, and only export and import may write', async () => {
    const { tools } = (await rpc('tools/list')).result;
    const names = tools.map((t: any) => t.name);
    for (const n of ['list_apps', 'app_overview', 'get_page', 'read_app_files', 'export_app', 'diff_app', 'import_app', 'describe_schema', 'run_query', 'search_docs', 'recent_errors'])
      assert.ok(names.includes(n), n);
    for (const t of tools) {
      assert.equal(t.inputSchema.type, 'object', t.name);
      assert.ok(t.description.length > 20, t.name);
    }
    assert.deepEqual(tools.filter((t: any) => !t.annotations.readOnlyHint).map((t: any) => t.name).sort(), ['export_app', 'import_app']);
    assert.equal(tools.find((t: any) => t.name === 'import_app').annotations.destructiveHint, true);
  });

  test('a bad argument is a tool error the agent can read', async () => {
    await assert.rejects(call('get_page', { alias: 'hr', page: 'x' }), /page must be a positive whole number/);
    await assert.rejects(call('get_page', { alias: 'no_such_app', page: 1 }), /application no_such_app not found/);
    await assert.rejects(call('get_page', { alias: 'hr', page: 999 }), /has no page 999/);
  });
});

describe('pgapex mcp: reading an application', () => {
  test('list_apps and app_overview', async () => {
    assert.match(await call('list_apps'), /"alias": "hr"/);
    const o = await call('app_overview', { alias: 'hr' });
    assert.match(o, /=== app\.yaml/);
    assert.match(o, /"name": "Employees Form"/);
    assert.match(o, /pages\/0003-employees-form\/page\.yaml/);
  });

  test('get_page shows the page first, then every component with its code inline', async () => {
    const p = await call('get_page', { alias: 'hr', page: 3 });
    assert.match(p, /^=== pages\/0003-employees-form\/page\.yaml/);
    assert.match(p, /items\/\d+-p3_ename\.yaml/);
    assert.match(p, /buttons\//);
  });

  test('read_app_files by prefix and by path', async () => {
    assert.match(await call('read_app_files', { alias: 'hr', prefix: 'shared/lovs/' }), /=== shared\/lovs\//);
    assert.match(await call('read_app_files', { alias: 'hr', paths: ['navigation.yaml'] }), /=== navigation\.yaml/);
    await assert.rejects(call('read_app_files', { alias: 'hr', paths: ['nope.yaml'] }), /no such file/);
  });

  test('describe_schema lists objects and describes a table with its policies', async () => {
    const all = await call('describe_schema', {});
    assert.match(all, /^hr$/m);
    assert.doesNotMatch(all, /^meta$/m, 'pgapex itself only on request');
    const emp = JSON.parse(await call('describe_schema', { table: 'hr.leave_request' }));
    assert.ok(emp.columns.some((c: any) => c.column === 'empno'));
    assert.ok(emp.policies.length > 0);
    await assert.rejects(call('describe_schema', { table: 'hr.nope' }), /no table or view/);
  });

  test('run_query returns rows and hides secrets', async () => {
    const r = JSON.parse(await call('run_query', { sql: 'select empno, ename from hr.emp order by empno', max_rows: 3 }));
    assert.deepEqual(r.columns, ['empno', 'ename']);
    assert.equal(r.shown, 3);
    const acc = JSON.parse(await call('run_query', { sql: `select username, password_hash from meta.account where password_hash is not null limit 1` }));
    assert.equal(acc.rows[0].password_hash, '(hidden)');
  });

  test('search_docs and recent_errors', async () => {
    assert.match(await call('search_docs', { query: 'cascading lov' }), /docs\/guide\/05-items\.md/);
    assert.match(await call('search_docs', { query: 'zzzqqq' }), /No section/);
    await call('recent_errors', { alias: 'hr', limit: 5 });
  });
});

describe('pgapex mcp: export, edit, diff, import', () => {
  test('a copy goes through the whole round trip', async () => {
    // export the example and import it as a copy
    assert.match(await call('export_app', { alias: 'hr', path: 'hr' }), /Exported hr to/);
    assert.ok(readdirSync(join(tmp, 'hr')).includes('pgapex.json'));
    assert.match(await call('import_app', { path: 'hr', alias: COPY }), new RegExp(`Imported ${COPY}`));
    await assert.rejects(call('import_app', { path: 'hr', alias: COPY }), /exists: use --replace/);

    // the default directory is apps/<alias>
    assert.match(await call('export_app', { alias: COPY }), new RegExp(`apps/${COPY}/`));
    const dir = join(tmp, 'apps', COPY);
    assert.equal(await call('diff_app', { alias: COPY }), 'No differences.\n');

    // edit a page title the way an agent would, with a file tool
    const pageDir = readdirSync(join(dir, 'pages')).find((d) => d.startsWith('0003-'))!;
    const file = join(dir, 'pages', pageDir, 'page.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace(/^title: .*$/m, 'title: Edited by an agent'));
    const diff = await call('diff_app', { alias: COPY });
    assert.match(diff, /^M pages\/0003-[^/]+\/page\.yaml/m);
    assert.match(diff, /\+title: Edited by an agent/);

    assert.match(await call('import_app', { alias: COPY, replace: true }), new RegExp(`Replaced ${COPY}`));
    const row = await owner.one(`select p.title from meta.page p join meta.app a on a.id = p.app_id where a.alias = $1 and p.page_no = 3`, [COPY]);
    assert.equal(row.title, 'Edited by an agent');
    assert.equal(await call('diff_app', { alias: COPY }), 'No differences.\n');
    // the source application is untouched
    const hr = await owner.one(`select p.title from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 3`);
    assert.notEqual(hr.title, 'Edited by an agent');
  });

  test('export_app refuses a directory that is not an export', async () => {
    writeFileSync(join(tmp, 'notes.txt'), 'mine');
    await assert.rejects(call('export_app', { alias: 'hr', path: '.' }), /refusing to write into it/);
    assert.equal(readFileSync(join(tmp, 'notes.txt'), 'utf8'), 'mine');
  });
});
