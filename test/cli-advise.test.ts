// Sprint 144 (AP-10; APEX 26.2: APEXlang static analysis, the Working Copy APIs): `pgkiln advise` checks an export
// (rolled back) or an application with the Advisor and reports text, JSON or SARIF with each finding at its file;
// the security checks (writing without sign-in or a scheme, unrestricted protection, long sessions);
// `pgkiln working-copy` and `pgkiln lock` / `unlock`, and the same through the MCP server's tools.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { root } from '../src/env.ts';
import '../src/env.ts';
import { closePools, owner } from '../src/db.ts';
import { fileOf, fails } from '../src/cli/advise.ts';
import { handle } from '../src/cli/mcp.ts';

const tmp = mkdtempSync(join(tmpdir(), 'pgkiln-advise-'));
const A = 'adv144';
let appId: number;

function cli(...args: string[]) {
  const r = spawnSync(process.execPath, [join(root, 'bin/pgkiln.js'), ...args], { cwd: tmp, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
async function mcp(name: string, args: Record<string, unknown>) {
  const r: any = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const text = r.result.content[0].text as string;
  if (r.result.isError) throw new Error(text);
  return text;
}

before(async () => {
  await owner.query(`delete from meta.app where alias like $1`, [`${A}%`]);
  appId = (await owner.one(`insert into meta.app (alias, name, authentication) values ($1, 'Advise 144', 'app_users') returning id`, [A])).id;
  await owner.query(`insert into meta.authz_scheme (app_id, name, type, value) values ($1, 'ADMIN', 'role', 'admin')`, [appId]);
  // page 1: public, writes data; page 2: signed in, writes data, no scheme, a region with an unknown column;
  // page 3: unrestricted with an item; page 4: writes data behind a scheme (no finding)
  const page = async (no: number, name: string, auth: boolean, extra: Record<string, unknown> = {}) =>
    (await owner.one(`insert into meta.page (app_id, page_no, name, requires_auth, protection, authz) values ($1, $2, $3, $4, $5, $6) returning id`,
      [appId, no, name, auth, extra.protection ?? 'checksum', extra.authz ?? null])).id as number;
  const p1 = await page(1, 'Sign up', false);
  const p2 = await page(2, 'Orders', true);
  const p3 = await page(3, 'Lookup', true, { protection: 'unrestricted' });
  const p4 = await page(4, 'Admin', true, { authz: 'ADMIN' });
  await owner.query(`insert into meta.process (page_id, seq, name, type, code) values ($1, 10, 'Store sign up', 'sql', 'update meta.app set name = name where false'),
    ($2, 10, 'Save order', 'sql', 'update meta.app set name = name where false'), ($2, 20, 'Read only', 'sql', 'select 1'), ($3, 10, 'Delete it', 'sql', 'delete from meta.app where false'), ($4, 10, 'Purge', 'sql', 'delete from meta.app where false')`, [p1, p2, p3, p4]);
  await owner.query(`insert into meta.region (page_id, seq, title, type, source) values ($1, 10, 'Order list', 'report', 'select no_such_column from meta.app')`, [p2]);
  await owner.query(`insert into meta.item (page_id, seq, name, type) values ($1, 10, 'P3_ID', 'text')`, [p3]);
});

after(async () => {
  await owner.query(`delete from meta.app where alias like $1`, [`${A}%`]);
  await owner.query(`delete from meta.setting where name = 'session_idle_minutes'`);
  rmSync(tmp, { recursive: true, force: true });
  await closePools();
});

describe('pgkiln advise', () => {
  test('a finding at its file: the component in its page folder, else the page, a shared component, the application', () => {
    const files = ['app.yaml', 'pages/0002-orders/page.yaml', 'pages/0002-orders/regions/0010-order-list.yaml', 'pages/0002-orders/regions/0010-order-list.sql', 'shared/lovs/jobs.yaml'];
    assert.equal(fileOf(files, { pageNo: 2, kind: 'region', label: 'Order list' }), 'pages/0002-orders/regions/0010-order-list.yaml');
    assert.equal(fileOf(files, { pageNo: 2, kind: 'page', label: 'Page 2: Orders' }), 'pages/0002-orders/page.yaml');
    assert.equal(fileOf(files, { pageNo: 2, kind: 'item', label: 'P2_GONE' }), 'pages/0002-orders/page.yaml');
    assert.equal(fileOf(files, { pageNo: null, kind: 'lov', label: 'JOBS' }), 'shared/lovs/jobs.yaml');
    assert.equal(fileOf(files, { pageNo: null, kind: null, label: '' }), 'app.yaml');
    assert.equal(fileOf(files, { pageNo: 9, kind: 'page', label: 'Page 9' }), null);
    assert.equal(fails([{ severity: 'warning' } as never], 'error'), false);
    assert.equal(fails([{ severity: 'warning' } as never], 'warning'), true);
    assert.equal(fails([{ severity: 'error' } as never], 'never'), false);
  });

  test('an application: the SQL errors and the security checks, with exit codes per --fail-on', async () => {
    const r = cli('advise', A);
    assert.equal(r.code, 1, r.err);
    assert.match(r.out, /ERROR\s+page 2, region Order list \(Source\): column "no_such_column" does not exist/);
    assert.match(r.out, /WARNING\s+Page 1: Sign up \(Security → Authentication\): Page 1 needs no sign-in, and its process Store sign up writes data/);
    assert.match(r.out, /INFO\s+Page 2: Orders \(Security → Authorization scheme\): Page 2 writes data \(Save order\) with no authorization scheme/);
    assert.doesNotMatch(r.out, /Read only/, 'a sql process without DML writes nothing');
    assert.match(r.out, /WARNING\s+Page 3: Lookup \(Security → Page protection\): Page 3 is unrestricted: a link can set its items without a checksum, and the page writes data/);
    assert.doesNotMatch(r.out, /Page 4/, 'behind a scheme');
    assert.match(r.out, /adv144: \d+ SQL fragment\(s\) checked; 1 error\(s\), 2 warning\(s\), 2 note\(s\)\./);
    assert.equal(cli('advise', A, '--fail-on', 'never').code, 0);
    // without the error: warnings fail only from --fail-on warning
    await owner.query(`update meta.region set source = 'select alias from meta.app' where title = 'Order list'`);
    try {
      assert.equal(cli('advise', A).code, 0);
      assert.equal(cli('advise', A, '--fail-on', 'warning').code, 1);
    } finally {
      await owner.query(`update meta.region set source = 'select no_such_column from meta.app' where title = 'Order list'`);
    }
    assert.equal(cli('advise', A, '--format', 'xml').code, 2);
    assert.equal(cli('advise', A, '--fail-on', 'sometimes').code, 2);
    assert.equal(cli('advise', 'no_such_app').code, 2);
    assert.equal(cli('advise', './missing-dir').code, 2);
  });

  test('long sessions are a warning', async () => {
    await owner.query(`insert into meta.setting (name, value) values ('session_idle_minutes', '600') on conflict (name) do update set value = excluded.value`);
    try {
      assert.match(cli('advise', A, '--fail-on', 'never').out, /WARNING\s+application \(Instance settings → Session idle time\): Sessions end after 600 minutes/);
    } finally {
      await owner.query(`delete from meta.setting where name = 'session_idle_minutes'`);
    }
  });

  test('an export: checked in a transaction that is rolled back; SARIF at the files, JSON counts', async () => {
    const dir = join(tmp, 'apps', A);
    assert.equal(cli('export', A, '--format', 'text', '-o', dir).code, 0);
    const before = (await owner.one(`select count(*)::int as n, max(id) as m from meta.app`));
    const sarif = cli('advise', join('apps', A), '--format', 'sarif', '-o', 'advise.sarif');
    assert.equal(sarif.code, 1);
    assert.match(sarif.err, /1 error\(s\), 2 warning\(s\), 2 note\(s\); report in advise\.sarif/);
    const after = (await owner.one(`select count(*)::int as n, max(id) as m from meta.app`));
    assert.deepEqual(after, before, 'nothing was imported');
    assert.equal((await owner.one(`select count(*)::int as n from meta.app where alias like 'advise-%'`)).n, 0);
    const doc = JSON.parse((await import('node:fs')).readFileSync(join(tmp, 'advise.sarif'), 'utf8'));
    assert.equal(doc.version, '2.1.0');
    const run = doc.runs[0];
    assert.equal(run.tool.driver.name, 'pgkiln advise');
    const err = run.results.find((x: any) => x.level === 'error');
    assert.equal(err.locations[0].physicalLocation.artifactLocation.uri, `apps/${A}/pages/0002-orders/regions/0010-order-list.yaml`);
    assert.ok(existsSync(join(tmp, err.locations[0].physicalLocation.artifactLocation.uri)));
    assert.equal(err.ruleId, 'pgkiln/region/source');
    assert.ok(run.tool.driver.rules.some((x: any) => x.id === err.ruleId));
    const warn = run.results.find((x: any) => /needs no sign-in/.test(x.message.text));
    assert.equal(warn.level, 'warning');
    assert.equal(warn.locations[0].physicalLocation.artifactLocation.uri, `apps/${A}/pages/0001-sign-up/page.yaml`);
    assert.ok(run.results.some((x: any) => x.level === 'note'));
    const json = JSON.parse(cli('advise', join('apps', A), '--format', 'json', '--fail-on', 'never').out);
    assert.deepEqual(json.counts, { error: 1, warning: 2, info: 2 });
    // an alias with --base: the paths of the export kept in the repository
    const base = JSON.parse(cli('advise', A, '--format', 'json', '--base', `apps/${A}`).out);
    assert.equal(base.findings.find((f: any) => f.severity === 'error').file, `apps/${A}/pages/0002-orders/regions/0010-order-list.yaml`);
  });
});

// (sprint 147, AP-10 leftover) --offline: an export's files alone, no database
const NO_DB = { DATABASE_URL: 'postgres://none:none@127.0.0.1:1/none', RUNTIME_DATABASE_URL: 'postgres://none:none@127.0.0.1:1/none' };
function offline(...args: string[]) {
  const r = spawnSync(process.execPath, [join(root, 'bin/pgkiln.js'), 'advise', '--offline', ...args], { cwd: tmp, encoding: 'utf8', env: { ...process.env, ...NO_DB } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('pgkiln advise --offline', () => {
  test('an export without a database: the same references and security findings, no SQL, at the same files', async () => {
    const dir = join(tmp, 'apps', `${A}off`);
    assert.equal(cli('export', A, '--format', 'text', '-o', dir).code, 0);
    const online = JSON.parse(cli('advise', join('apps', `${A}off`), '--format', 'json', '--fail-on', 'never').out);
    const r = offline(join('apps', `${A}off`), '--format', 'json');
    assert.equal(r.code, 0, r.err);
    const json = JSON.parse(r.out);
    assert.equal(json.offline, true);
    assert.equal(json.counts.error, 0, 'SQL is not planned offline');
    const key = (f: any) => `${f.severity} ${f.where} ${f.field} ${f.message} ${f.file}`;
    const sqlFree = online.findings.filter((f: any) => !/no_such_column|Instance settings/.test(`${f.message} ${f.field}`)).map(key).sort();
    assert.deepEqual(json.findings.map(key).sort(), sqlFree);
    assert.ok(json.findings.some((f: any) => /needs no sign-in/.test(f.message) && f.file === `apps/${A}off/pages/0001-sign-up/page.yaml`));
    assert.equal(offline(join('apps', `${A}off`), '--fail-on', 'warning').code, 1);
    assert.match(offline(join('apps', `${A}off`)).out, /checked offline \(references and security; SQL not planned without a database\)/);
  });

  test('broken references in a JSON export: login page, page group, branch, workflow, grid, JSON source', () => {
    const doc = {
      format: 'pgkiln/2',
      app: { alias: 'off147', name: 'Offline', login_page: 9, json_sources: [{ name: 'BAD' }] },
      pages: [{
        page_no: 1, name: 'One', requires_auth: true, protection: 'checksum', page_group: 'NOPE',
        regions: [{ id: 501, seq: 10, title: 'Lines', type: 'grid' }],
        items: [{ seq: 10, name: 'P1_PICK', type: 'select' }],
        processes: [{ seq: 10, name: 'Start', type: 'workflow', config: { definition: 'NO_SUCH_FLOW' } }],
        branches: [{ seq: 10, target_type: 'page', target_page: 88 }],
      }],
      lovs: [], authz_schemes: [],
    };
    writeFileSync(join(tmp, 'off147.json'), JSON.stringify(doc));
    const r = offline('off147.json', '--format', 'json', '--fail-on', 'never');
    assert.equal(r.code, 0, r.err);
    const text = JSON.parse(r.out).findings.map((f: any) => `${f.severity}: ${f.field}: ${f.message}`).join('\n');
    assert.match(text, /error: Application settings → Login page: Page 9 doesn't exist/);
    assert.match(text, /warning: Page 1 → Page group: Page group NOPE doesn't exist/);
    assert.match(text, /error: Page: Page 88 doesn't exist/);
    assert.match(text, /error: Configuration: Workflow definition NO_SUCH_FLOW doesn't exist/);
    assert.match(text, /error: Source: A grid needs a table/);
    assert.match(text, /warning: List of values: A select item needs a list of values/);
    assert.match(text, /error: JSON source BAD:/);
    assert.equal(offline('off147.json').code, 1, 'errors fail the run');
  });

  test('--offline needs an export; a file that is not an application export is refused', () => {
    assert.match(offline(A).err, /not found \(--offline checks an export/);
    writeFileSync(join(tmp, 'notapp.json'), '{"format": "pgkiln/2", "pages": []}');
    const r = offline('notapp.json');
    assert.notEqual(r.code, 0);
    assert.match(r.err, /not an application export/);
  });

  test('MCP: advise_app with offline and a path', async () => {
    const text = await mcp('advise_app', { path: join(tmp, 'off147.json'), offline: true });
    assert.match(text, /Page 9 doesn't exist/);
    assert.match(text, /checked offline/);
    await assert.rejects(mcp('advise_app', { alias: A, offline: true }), /offline needs a path/);
  });
});

describe('pgkiln working-copy, lock and unlock', () => {
  test('create, compare, a conflict needs a choice, a lock refuses the merge, merge, delete', async () => {
    const made = cli('working-copy', 'create', A, 'ci copy', '--as', 'admin');
    assert.equal(made.code, 0, made.err);
    assert.match(made.out, /Working copy ci copy of adv144: application adv144-ci-copy \(\d+\)/);
    const copy = 'adv144-ci-copy';
    assert.match(cli('working-copy', 'list', A).out, /adv144-ci-copy\tci copy\tby admin/);
    assert.match(cli('working-copy', 'compare', copy).out, /nothing to merge/);
    assert.equal(cli('working-copy', 'create', copy, 'nested').code, 1, 'no copy of a copy');
    // a conflict: page 2's title changed on both sides
    await owner.query(`update meta.page set title = 'In the copy' where page_no = 2 and app_id = (select id from meta.app where alias = $1)`, [copy]);
    await owner.query(`update meta.page set title = 'In the main' where page_no = 2 and app_id = $1`, [appId]);
    const cmp = cli('working-copy', 'compare', copy);
    assert.equal(cmp.code, 1);
    assert.match(cmp.out, /CONFLICT Page 2 +\[pages\/0002\/page\]/);
    const refused = cli('working-copy', 'merge', copy, '--as', 'admin');
    assert.equal(refused.code, 1);
    assert.match(refused.err, /1 conflict\(s\): choose the copy's or the main version[\s\S]*\[pages\/0002\/page\]/);
    // another developer's lock on the page refuses the merge
    assert.equal(cli('lock', A, '--page', '2', '--as', 'scott', '--note', 'release').code, 0);
    assert.equal(cli('lock', A, '--page', '2', '--as', 'admin').code, 1, 'already locked');
    const locked = cli('working-copy', 'merge', copy, '--take', 'pages/0002/page', '--as', 'admin');
    assert.equal(locked.code, 1);
    assert.match(locked.err, /locked by scott[\s\S]*refused until it is unlocked/);
    assert.equal(cli('unlock', A, '--page', '2', '--as', 'admin').code, 1, 'not their lock');
    const broken = cli('unlock', A, '--page', '2', '--as', 'admin', '--force');
    assert.equal(broken.code, 0);
    assert.match(broken.out, /scott's lock was broken/);
    assert.ok(await owner.one(`select 1 as ok from meta.activity_log where app_id = $1 and event = 'lock_broken' and username = 'admin'`, [appId]));
    assert.equal(cli('working-copy', 'merge', copy, '--take', 'pages/9999/page', '--as', 'admin').code, 1, 'not a conflict');
    const merged = cli('working-copy', 'merge', copy, '--take', 'pages/0002/page', '--as', 'admin');
    assert.equal(merged.code, 0, merged.err);
    assert.equal((await owner.one(`select title from meta.page where app_id = $1 and page_no = 2`, [appId])).title, 'In the copy');
    assert.ok(await owner.one(`select 1 as ok from meta.activity_log where app_id = $1 and event = 'working_copy' and detail like 'merged ci copy%'`, [appId]));
    assert.equal(cli('working-copy', 'delete', A).code, 1, 'only a working copy is deleted');
    assert.equal(cli('working-copy', 'delete', copy, '--as', 'admin').code, 0);
    assert.equal((await owner.one(`select count(*)::int as n from meta.app where alias = $1`, [copy])).n, 0);
    assert.equal(cli('working-copy', 'rename', A, 'x').code, 2);
    assert.equal(cli('working-copy', 'merge', copy, '--prefer', 'both').code, 2);
  });
});

describe('MCP: advise_app, working_copy, lock_app', () => {
  test('the Advisor, a working copy with prefer, a lock', async () => {
    assert.match(await mcp('advise_app', { alias: A }), /ERROR\s+page 2, region Order list/);
    await assert.rejects(mcp('advise_app', {}), /give an alias or a path/);
    assert.match(await mcp('working_copy', { action: 'create', alias: A, name: 'agent', developer: 'admin' }), /application adv144-agent/);
    await owner.query(`update meta.page set title = 'Agent copy' where page_no = 3 and app_id = (select id from meta.app where alias = 'adv144-agent')`);
    await owner.query(`update meta.page set title = 'Agent main' where page_no = 3 and app_id = $1`, [appId]);
    assert.match(await mcp('working_copy', { action: 'compare', alias: 'adv144-agent' }), /CONFLICT Page 3/);
    await assert.rejects(mcp('working_copy', { action: 'merge', alias: 'adv144-agent' }), /conflict/);
    assert.match(await mcp('working_copy', { action: 'merge', alias: 'adv144-agent', prefer: 'main' }), /Merged adv144-agent into adv144/);
    assert.equal((await owner.one(`select title from meta.page where app_id = $1 and page_no = 3`, [appId])).title, 'Agent main');
    assert.match(await mcp('lock_app', { alias: A, developer: 'admin', note: 'agent at work' }), /adv144 is locked by admin/);
    assert.ok(await owner.one(`select 1 as ok from meta.builder_lock where app_id = $1 and page_no = 0 and locked_by = 'admin' and note = 'agent at work'`, [appId]));
    await assert.rejects(mcp('lock_app', { alias: A, unlock: true }), /Only admin unlocks it/);
    assert.match(await mcp('lock_app', { alias: A, unlock: true, developer: 'admin' }), /Unlocked/);
    assert.match(await mcp('working_copy', { action: 'delete', alias: 'adv144-agent' }), /Deleted working copy agent/);
  });
});
