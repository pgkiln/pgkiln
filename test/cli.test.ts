// The pgkiln command line (src/cli) and the directory export (src/appfiles.ts):
// help and exit codes, dir → import → export round trip, diff, import --replace.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { root } from '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { docToFiles, filesToDoc, regionKeys, slug, stableJson } from '../src/appfiles.ts';
import { readDir, readZip } from '../src/cli/files.ts';
import { checkSchema } from '../src/cli/replace.ts';
import { pendingMigrations } from '../src/migrate.ts';
import { Browser } from './helpers.ts';

const tmp = mkdtempSync(join(tmpdir(), 'pgapex-cli-'));
const COPIES = ['hr_cli_rt', 'hr_cli_rep', 'hr_cli_zip', 'hr_cli_txt'];
let app: FastifyInstance;

before(async () => {
  await owner.query('delete from meta.app where alias = any($1)', [COPIES]);
  app = await buildApp({ logger: false });
});
after(async () => {
  await owner.query('delete from meta.app where alias = any($1)', [COPIES]);
  await owner.query(`delete from meta.developer where username = 'cli_dev'`);
  await owner.query(`delete from meta.account where username = 'cli_user'`);
  rmSync(tmp, { recursive: true, force: true });
  await app.close();
  await closePools();
});

/** Run the CLI as a user would (bin/pgkiln.js). */
function cli(...args: string[]) {
  return cliInput('', ...args);
}
function cliInput(input: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [join(root, 'bin/pgkiln.js'), ...args], { cwd: tmp, encoding: 'utf8', input });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** As in test/export.test.ts: no ids, and navigation compared as a set (its order depends on ids). */
function normalise(doc: any) {
  const strip = (x: any) => {
    const { id, parent_id, region_id, affected_region_id, ...rest } = x;
    if (rest.config?.report !== undefined) rest.config = { ...rest.config, report: '(region)' };
    return rest;
  };
  return {
    ...doc,
    app: { ...doc.app, alias: '(alias)' },
    automations: doc.automations.map((a: any) => ({ ...a, enabled: '(any)' })),
    nav: doc.nav.map(strip).map((n: any) => stableJson(n)).sort(),
    list_entries: (doc.list_entries ?? []).map(strip).map((n: any) => stableJson(n)).sort(),
    // the directory sorts these by code point, the database by its collation
    ...Object.fromEntries(['group_roles', 'text_messages', 'translations'].map((k) => [k, doc[k].map((r: any) => stableJson(r)).sort()])),
    pages: doc.pages.map((p: any) => ({
      ...p,
      regions: p.regions.map(strip),
      items: p.items.map(strip),
      buttons: p.buttons.map(strip),
      dynamic_actions: p.dynamic_actions.map(strip),
      validations: p.validations.map(strip),
      processes: p.processes.map(strip),
    })),
  };
}

const exportDoc = async (alias: string) => (await owner.one('select meta.export_app($1) as d', [alias])).d;

describe('pgkiln command line', () => {
  test('the server knows when the database lacks migrations', async () => {
    assert.deepEqual(await pendingMigrations(root), []);
    const fake = join(tmp, 'newer');
    mkdirSync(join(fake, 'db/migrations'), { recursive: true });
    for (const f of readdirSync(join(root, 'db/migrations'))) writeFileSync(join(fake, 'db/migrations', f), '');
    writeFileSync(join(fake, 'db/migrations', '999_newer.sql'), 'select 1');
    assert.deepEqual(await pendingMigrations(fake), ['999_newer.sql']);
  });

  test('help, version and exit codes', () => {
    const help = cli('--help');
    assert.equal(help.code, 0);
    for (const c of ['migrate', 'apps', 'export', 'import', 'diff', 'users']) assert.match(help.out, new RegExp(`^  ${c} `, 'm'));
    assert.equal(cli().code, 2, 'no command is a usage error');
    for (const c of ['migrate', 'apps', 'export', 'import', 'diff', 'users']) {
      const r = cli(c, '--help');
      assert.equal(r.code, 0, `${c} --help`);
      assert.match(r.out, new RegExp(`^Usage: pgkiln ${c}`));
    }
    assert.match(cli('--version').out, /^pgkiln \d+\.\d+\.\d+\n$/);
    const unknown = cli('frobnicate');
    assert.equal(unknown.code, 2);
    assert.match(unknown.err, /unknown command frobnicate/);
    assert.equal(cli('export', 'hr', '--bogus').code, 2, 'unknown option');
    assert.equal(cli('export').code, 2, 'missing argument');
    assert.equal(cli('export', 'hr', '--format', 'xml').code, 2, 'unknown format');
    const missing = cli('export', 'no_such_app');
    assert.equal(missing.code, 3, 'failures exit with 3');
    assert.match(missing.err, /application no_such_app not found/);
    assert.equal(cli('import', join(tmp, 'nothing-here')).code, 2);
    const apps = cli('apps');
    assert.equal(apps.code, 0);
    assert.match(apps.out, /^hr\s+\d+\s+/m);
  });

  test('a directory export is deterministic, readable and free of ids', async () => {
    const dir = join(tmp, 'hr');
    const r = cli('export', 'hr', '--format', 'dir', '--out', dir);
    assert.equal(r.code, 0, r.err);
    const files = readDir(dir);
    for (const p of ['pgapex.json', 'app.json', 'navigation.json', 'shared/lovs/departments.json', 'globalization/text-messages.json', 'shared/template-components/status_badge.json'])
      assert.ok(files.has(p), p);
    const page3 = [...files.keys()].filter((p) => p.startsWith('pages/0003-employees-form/'));
    assert.ok(page3.includes('pages/0003-employees-form/page.json'));
    assert.ok(page3.some((p) => /\/regions\/0010-employees\.json$/.test(p)));
    assert.ok(page3.some((p) => /\/items\/\d{4}-p3_ename\.json$/.test(p)));
    // SQL in sibling files; references by static id
    assert.ok([...files.keys()].some((p) => p.endsWith('.source.sql')));
    const item = JSON.parse(files.get(page3.find((p) => p.endsWith('-p3_ename.json'))!)!.toString());
    assert.equal(item.region, 'employees');
    assert.ok(!('region_id' in item) && !('id' in item));
    for (const [p, buf] of files) {
      if (!/\.(json|sql|html)$/.test(p)) continue;
      const s = buf.toString('utf8');
      assert.ok(s.endsWith('\n'), `${p} ends with a newline`);
      if (p.endsWith('.json')) {
        assert.equal(s, stableJson(JSON.parse(s)), `${p} has sorted keys`);
        // top-level keys only: a report's headings may name a column "id"
        assert.doesNotMatch(s, /^ {2}"(id|parent_id|region_id|affected_region_id|app_id|page_id)":/m, `${p} has no ids`);
      }
    }
    assert.ok(![...files.values()].some((b) => b.toString('utf8').includes('password_hash')), 'no password hashes');
    // the same export again changes nothing
    const again = cli('export', 'hr', '--format', 'dir', '--out', dir);
    assert.match(again.err, /0 written, 0 removed/);
    // stale files are removed, foreign directories refused
    writeFileSync(join(dir, 'pages', 'stale.json'), '{}\n');
    assert.match(cli('export', 'hr', '-f', 'dir', '-o', dir).err, /1 removed/);
    writeFileSync(join(tmp, 'note.txt'), 'x');
    assert.equal(cli('export', 'hr', '-f', 'dir', '-o', tmp).code, 3, 'a non-empty directory that is not an export');
    // JSON format: the export_app document with sorted keys
    const json = cli('export', 'hr');
    assert.equal(json.code, 0);
    assert.equal(json.out, stableJson(await exportDoc('hr')));
  });

  test('directory → import → export gives the original document', async () => {
    const dir = join(tmp, 'hr');
    cli('export', 'hr', '-f', 'dir', '-o', dir);
    const original = await exportDoc('hr');
    // in memory: the layout is lossless
    assert.deepEqual(normalise(filesToDoc(docToFiles(original))), normalise(original));
    const r = cli('import', dir, '--alias', 'hr_cli_rt');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Imported hr_cli_rt \(application \d+\)/);
    const copy = await exportDoc('hr_cli_rt');
    assert.deepEqual(normalise(copy), normalise(original));
    // facets and maps point at the copy's report regions
    const bad = await owner.one(
      `select count(*)::int as n from meta.region r join meta.page p on p.id = r.page_id
        where p.app_id = (select id from meta.app where alias = 'hr_cli_rt') and r.config ? 'report'
          and not exists (select 1 from meta.region r2 where r2.id = (r.config->>'report')::int and r2.page_id = r.page_id)`,
    );
    assert.equal(bad.n, 0);
    // importing over an existing alias needs --replace
    const again = cli('import', dir, '--alias', 'hr_cli_rt');
    assert.equal(again.code, 2);
    assert.match(again.err, /exists: use --replace/);
  });

  test('diff reports what differs, with exit code 1', async () => {
    const dir = join(tmp, 'hr');
    cli('export', 'hr', '-f', 'dir', '-o', dir);
    const same = cli('diff', 'hr', dir);
    assert.equal(same.code, 0, same.out + same.err);
    assert.match(same.err, /No differences/);
    const region = readdirSync(join(dir, 'pages/0002-employees/regions')).find((f) => f.endsWith('.source.sql'))!;
    appendFileSync(join(dir, 'pages/0002-employees/regions', region), '-- changed\n');
    writeFileSync(join(dir, 'shared/app-items/zz_new.json'), stableJson({ name: 'ZZ_NEW', description: null }));
    rmSync(join(dir, 'shared/lovs/departments.json'));
    const d = cli('diff', 'hr', dir);
    assert.equal(d.code, 1);
    assert.match(d.out, new RegExp(`^M pages/0002-employees/regions/${region.replace(/\./g, '\\.')}$`, 'm'));
    assert.match(d.out, /^\+-- changed$/m);
    assert.match(d.out, /^A shared\/app-items\/zz_new\.json$/m);
    assert.match(d.out, /^D shared\/lovs\/departments\.json$/m);
    assert.equal(cli('diff', 'hr', dir, '--name-only').out.split('\n').filter(Boolean).length, 3);
    assert.equal(cli('diff', 'hr', dir, '--quiet').out, '');
    // a JSON export works too
    const file = join(tmp, 'hr.json');
    assert.equal(cli('export', 'hr', '-o', file).code, 0);
    assert.equal(cli('diff', 'hr', file).code, 0);
    cli('export', 'hr', '-f', 'dir', '-o', dir);
  });

  test('the text style (APEXlang-like): YAML with the code inline, lossless, imported and compared like the JSON one', async () => {
    const dir = join(tmp, 'hr-text');
    const r = cli('export', 'hr', '-f', 'text', '-o', dir);
    assert.equal(r.code, 0, r.err);
    const files = readDir(dir);
    assert.deepEqual(JSON.parse(files.get('pgapex.json')!.toString()), { format: 'pgapex/2', layout: 1, style: 'text' });
    const paths = [...files.keys()];
    assert.ok(!paths.some((p) => p.endsWith('.json') && p !== 'pgapex.json' && !p.startsWith('static/')), 'every component is YAML');
    assert.ok(!paths.some((p) => /\.(sql|html)$/.test(p) && !p.startsWith('static/')), 'code is inline, not in sibling files');
    assert.ok(files.has('app.yaml') && files.has('navigation.yaml'));
    const region = paths.find((p) => p.startsWith('pages/0002-employees/regions/') && files.get(p)!.toString().includes('source: |2'))!;
    assert.ok(region, 'a region with its query as a literal block');
    assert.match(files.get(region)!.toString(), /^source: \|2-?\n {2}select /m);
    // lossless in memory, and through the CLI
    const original = await exportDoc('hr');
    assert.deepEqual(normalise(filesToDoc(docToFiles(original, 'text'))), normalise(original));
    const imp = cli('import', dir, '--alias', 'hr_cli_txt');
    assert.equal(imp.code, 0, imp.err);
    assert.deepEqual(normalise(await exportDoc('hr_cli_txt')), normalise(original));
    // diff compares in the directory's style
    const same = cli('diff', 'hr', dir);
    assert.equal(same.code, 0, same.out + same.err);
    writeFileSync(join(dir, region), files.get(region)!.toString().replace(/^source: \|2(-?)\n {2}select /m, 'source: |2$1\n  select 1 as changed, '));
    const d = cli('diff', 'hr', dir);
    assert.equal(d.code, 1);
    assert.match(d.out, new RegExp(`^M ${region.replace(/\./g, '\\.')}$`, 'm'));
    assert.match(d.out, /^\+ {2}select 1 as changed, /m);
  });

  test('a directory may mix JSON and YAML files; the same component twice is refused', () => {
    const doc = { format: 'pgapex/2', app: { alias: 'x', name: 'X' }, lovs: [{ name: 'DEPTS', query: 'select 1' }], pages: [{ page_no: 1, name: 'Home', regions: [{ id: 1, seq: 10, title: 'Main', type: 'static', source: 'x' }] }] };
    const json = docToFiles(doc);
    const text = docToFiles(doc, 'text');
    const mixed = new Map(json);
    mixed.delete('shared/lovs/depts.json');
    mixed.set('shared/lovs/depts.yaml', text.get('shared/lovs/depts.yaml')!);
    mixed.delete('app.json');
    mixed.set('app.yaml', text.get('app.yaml')!);
    assert.deepEqual(filesToDoc(mixed), filesToDoc(json));
    mixed.set('shared/lovs/depts.json', json.get('shared/lovs/depts.json')!);
    assert.throws(() => filesToDoc(mixed), /depts\.json and depts\.yaml are the same component/);
    mixed.delete('shared/lovs/depts.json');
    mixed.set('app.json', json.get('app.json')!);
    assert.throws(() => filesToDoc(mixed), /app\.json and app\.yaml are the same file/);
    // a YAML error names the file and line
    const broken = new Map(text);
    broken.set('shared/lovs/depts.yaml', Buffer.from('name: DEPTS\nname: again\n'));
    assert.throws(() => filesToDoc(broken), /shared\/lovs\/depts\.yaml, line 2: the key "name" appears twice/);
  });

  test('a region with a stored static id is named by it; derived keys keep out of its way', () => {
    assert.deepEqual(
      regionKeys([{ title: 'Employees' }, { title: 'Other', static_id: 'employees' }, { title: 'Employees' }, { title: 'X', static_id: 'Bad Id' }]),
      ['employees-2', 'employees', 'employees-3', 'x'],
    );
    const doc = { format: 'pgapex/2', app: { alias: 'x' }, pages: [{ page_no: 1, name: 'Home',
      regions: [{ id: 7, seq: 10, title: 'Renamed title', static_id: 'staff', type: 'report', source: 'select 1' }, { id: 8, seq: 20, title: 'Map', type: 'map', config: { report: 7 } }],
      items: [{ name: 'P1_X', region_id: 7 }] }] };
    const files = docToFiles(doc);
    assert.ok(files.has('pages/0001-home/regions/0010-staff.json'));
    assert.equal(JSON.parse(files.get('pages/0001-home/regions/0020-map.json')!.toString()).config.report, 'staff');
    assert.equal(JSON.parse(files.get('pages/0001-home/items/none-p1_x.json')!.toString()).region, 'staff', "an item's region by the static id");
    const back = filesToDoc(files);
    assert.equal(back.pages[0].regions[0].static_id, 'staff');
    assert.equal(back.pages[0].regions[1].config.report, back.pages[0].regions[0].id);
  });

  test('import --replace updates in place and keeps installation data', async () => {
    const dir = join(tmp, 'rep');
    cli('export', 'hr', '-f', 'dir', '-o', dir);
    assert.equal(cli('import', dir, '--alias', 'hr_cli_rep', '--replace').code, 0, '--replace of a new alias imports');
    const before = await owner.one(`select id from meta.app where alias = 'hr_cli_rep'`);
    const region = await owner.one(
      `select r.id from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 2 and r.title = 'Employees'`,
      [before.id],
    );
    const account = await owner.one(`select id from meta.account order by id limit 1`);
    await owner.query(`insert into meta.app_access (app_id, account_id, roles) values ($1, $2, '{tester}')`, [before.id, account.id]);
    await owner.query(`insert into meta.saved_report (app_id, region_id, username, name, public, params) values ($1, $2, 'someone', 'Mine', false, '{}')`, [before.id, region.id]);
    await owner.query(`update meta.automation set enabled = true where app_id = $1`, [before.id]);

    // change the files: a region's SQL, a page title; remove a page; app name
    const src = join(dir, 'pages/0002-employees/regions');
    const sql = readdirSync(src).find((f) => f.endsWith('.source.sql'))!;
    writeFileSync(join(src, sql), readFileSync(join(src, sql), 'utf8').replace(/^select/i, 'select /* v2 */'));
    const pageJson = join(dir, 'pages/0004-departments/page.json');
    writeFileSync(pageJson, stableJson({ ...JSON.parse(readFileSync(pageJson, 'utf8')), title: 'Departments v2' }));
    const removed = readdirSync(join(dir, 'pages')).find((d) => d.startsWith('0009-'))!;
    rmSync(join(dir, 'pages', removed), { recursive: true });
    writeFileSync(join(dir, 'app.json'), stableJson({ ...JSON.parse(readFileSync(join(dir, 'app.json'), 'utf8')), name: 'HR v2', alias: 'hr_cli_rep' }));

    assert.equal(cli('diff', 'hr_cli_rep', dir, '--quiet').code, 1);
    const r = cli('import', dir, '--alias', 'hr_cli_rep', '--replace');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Replaced hr_cli_rep/);
    const after = await owner.one(`select id, name, alias from meta.app where alias = 'hr_cli_rep'`);
    assert.equal(after.id, before.id, 'same application id');
    assert.equal(after.name, 'HR v2');
    assert.equal((await owner.one(`select count(*)::int as n from meta.app where alias like 'pgapex-replace-%'`)).n, 0, 'no temporary app left');
    const p2 = await owner.one(
      `select r.id, r.source from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 2 and r.title = 'Employees'`,
      [after.id],
    );
    assert.match(p2.source, /v2/);
    assert.equal((await owner.one(`select title from meta.page where app_id = $1 and page_no = 4`, [after.id])).title, 'Departments v2');
    assert.equal((await owner.one(`select count(*)::int as n from meta.page where app_id = $1 and page_no = 9`, [after.id])).n, 0, 'removed page');
    // kept: access, the saved report (now on the new region), automations' switch
    assert.deepEqual((await owner.one(`select roles from meta.app_access where app_id = $1 and account_id = $2`, [after.id, account.id])).roles, ['tester']);
    assert.equal((await owner.one(`select region_id from meta.saved_report where app_id = $1 and name = 'Mine'`, [after.id])).region_id, p2.id);
    assert.ok((await owner.one(`select bool_and(enabled) as e from meta.automation where app_id = $1`, [after.id])).e);
    // now the database matches the directory
    const d = cli('diff', 'hr_cli_rep', dir);
    assert.equal(d.code, 0, d.out);
    // and replacing with an identical directory is a no-op for the export
    const doc = await exportDoc('hr_cli_rep');
    assert.equal(cli('import', dir, '--alias', 'hr_cli_rep', '--replace').code, 0);
    assert.deepEqual(normalise(await exportDoc('hr_cli_rep')), normalise(doc));
  });

  test('replace knows every table that belongs to an application', async () => {
    await checkSchema(owner.pool);
  });

  test('broken directories are reported', () => {
    const files = docToFiles({ format: 'pgapex/2', app: { alias: 'x' }, pages: [{ page_no: 1, name: 'P', regions: [{ id: 7, seq: 10, title: 'R', type: 'static' }], items: [{ seq: 1, name: 'P1_X', region_id: 7 }] }] });
    assert.ok(files.has('pages/0001-p/regions/0010-r.json'));
    const doc = filesToDoc(files);
    assert.equal(doc.pages[0].items[0].region_id, doc.pages[0].regions[0].id);
    const bad = new Map(files);
    bad.set('pages/0001-p/items/0001-p1_x.json', Buffer.from(stableJson({ seq: 1, name: 'P1_X', region: 'nope' })));
    assert.throws(() => filesToDoc(bad), /no region "nope"/);
    const orphan = new Map(files);
    orphan.set('pages/0001-p/regions/0099-gone.source.sql', Buffer.from('select 1\n'));
    assert.throws(() => filesToDoc(orphan), /not part of a component/);
    const none = new Map(files);
    none.delete('pgapex.json');
    assert.throws(() => filesToDoc(none), /pgapex\.json not found/);
    // keys
    assert.equal(slug("Who's out — été"), 'who-s-out-ete');
    assert.deepEqual(regionKeys([{ title: 'A' }, { title: 'a' }, { title: null, type: 'chart' }]), ['a', 'a-2', 'chart']);
    // code round trip keeps trailing newlines and short values inline
    const code = docToFiles({ format: 'pgapex/2', app: {}, lovs: [{ name: 'L', query: 'select 1\nfrom t\n' }, { name: 'S', query: 'select 2' }] });
    assert.equal(code.get('shared/lovs/l.query.sql')!.toString(), 'select 1\nfrom t\n\n');
    assert.equal(JSON.parse(code.get('shared/lovs/s.json')!.toString()).query, 'select 2');
    assert.deepEqual(filesToDoc(code).lovs, [{ name: 'L', query: 'select 1\nfrom t\n' }, { name: 'S', query: 'select 2' }]);
  });

  test('sections and arrays added by later versions travel along', () => {
    const doc = {
      format: 'pgapex/2', app: { alias: 'x' }, future_things: [{ name: 'a' }],
      pages: [{ page_no: 1, name: 'P', regions: [{ id: 7, seq: 10, title: 'R', type: 'static' }], widgets: [{ region_id: 7, x: 1 }] }],
    };
    const files = docToFiles(doc);
    assert.deepEqual(JSON.parse(files.get('extra/future_things.json')!.toString()), [{ name: 'a' }]);
    assert.deepEqual(JSON.parse(files.get('pages/0001-p/page.json')!.toString()).widgets, [{ region: 'r', x: 1 }]);
    const back = filesToDoc(files);
    assert.deepEqual(back.future_things, [{ name: 'a' }]);
    assert.deepEqual(back.pages[0].widgets, [{ region_id: back.pages[0].regions[0].id, x: 1 }]);
  });

  test('binary values travel as files', () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const doc = { format: 'pgapex/2', app: { pwa_icon: '\\x' + png.toString('hex') }, report_layouts: [{ name: 'Letter', logo: png.toString('base64') }] };
    const files = docToFiles(doc);
    assert.ok(files.get('app.pwa_icon.png')!.equals(png));
    assert.ok(files.get('shared/report-layouts/letter.logo.png')!.equals(png));
    assert.ok(!('logo' in JSON.parse(files.get('shared/report-layouts/letter.json')!.toString())));
    const back = filesToDoc(files);
    assert.equal(back.app.pwa_icon, doc.app.pwa_icon);
    assert.equal(back.report_layouts[0].logo, doc.report_layouts[0].logo);
  });

  test('migrate and users', async () => {
    const m = cli('migrate');
    assert.equal(m.code, 0, m.err);
    assert.match(m.out, /Up to date/);
    assert.equal(cliInput('short\n', 'users', 'add', 'cli_dev', '--developer').code, 3, 'the password policy applies');
    const add = cliInput('cli-dev-Passw0rd\n', 'users', 'add', 'cli_dev', '--developer');
    assert.equal(add.code, 0, add.err);
    assert.doesNotMatch(add.out + add.err, /Passw0rd/, 'never echoes the password');
    assert.match(cli('users', 'list', '--developers').out, /^cli_dev$/m);
    assert.ok((await owner.one(`select password_hash = crypt('cli-dev-Passw0rd', password_hash) as ok from meta.developer where username = 'cli_dev'`)).ok);
    assert.equal(cliInput('cli-dev-Passw0rd2\n', 'users', 'password', 'cli_dev', '--developer').code, 0);
    assert.ok((await owner.one(`select password_hash = crypt('cli-dev-Passw0rd2', password_hash) as ok from meta.developer where username = 'cli_dev'`)).ok);
    const acc = cliInput('cli-user-Passw0rd\n', 'users', 'add', 'cli_user', '--app', 'hr', '--roles', 'Clerk,viewer', '--name', 'CLI User');
    assert.equal(acc.code, 0, acc.err);
    assert.match(cli('users', 'list').out, /^cli_user\tCLI User\thr\(clerk,viewer\)$/m);
    assert.equal(cliInput('x\n', 'users', 'password', 'nobody_here').code, 3);
    assert.equal(cli('users', 'frob').code, 2);
    assert.equal(cliInput('cli-user-Passw0rd\n', 'users', 'add', 'cli_user2', '--roles', 'x').code, 2, '--roles needs --app');
  });

  test('the builder downloads the directory as a zip, and the CLI imports it', async () => {
    const dev = new Browser(app);
    await dev.get('/builder/login');
    await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
    const id = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
    const res = await dev.get(`/builder/apps/${id}/export?format=dir`);
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-disposition']), /hr\.pgapex\.zip/);
    const zip = res.rawPayload;
    const files = readZip(zip);
    assert.deepEqual([...files.keys()].sort(), [...docToFiles(await exportDoc('hr')).keys()].sort());
    const again = await dev.get(`/builder/apps/${id}/export?format=dir`);
    assert.ok(again.rawPayload.equals(zip), 'the zip is deterministic');
    const path = join(tmp, 'hr.zip');
    writeFileSync(path, zip);
    assert.equal(cli('import', path, '--alias', 'hr_cli_zip').code, 0);
    assert.equal(cli('diff', 'hr', path, '--quiet').code, 0);
  });
});
