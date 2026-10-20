// Sprint 116 (WS-14): pgkiln import <dir> --replace --only <path>, a file-level
// import (APEX 26.2: APEXlang file-level import). Only the named page or
// component files change; the rest of the application stays as it is.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { root } from '../src/env.ts';
import { closePools, owner } from '../src/db.ts';
import { mergeOnly, onlyMatcher } from '../src/cli/only.ts';

const tmp = mkdtempSync(join(tmpdir(), 'pgkiln-only-'));
const ALIAS = 'hr_only116';

function cli(...args: string[]) {
  const r = spawnSync(process.execPath, [join(root, 'bin/pgkiln.js'), ...args], { cwd: tmp, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const pageDir = (dir: string, n: number) => join(dir, 'pages', readdirSync(join(dir, 'pages')).find((d) => d.startsWith(`${String(n).padStart(4, '0')}-`))!);
const edit = (file: string, from: RegExp, to: string) => {
  const text = readFileSync(file, 'utf8');
  assert.match(text, from, file);
  writeFileSync(file, text.replace(from, to));
};
const appId = async () => (await owner.one('select id from meta.app where alias = $1', [ALIAS])).id;
const pageTitle = async (n: number) => (await owner.one('select title from meta.page where app_id = $1 and page_no = $2', [await appId(), n]))?.title;
const lovQuery = async () => (await owner.one(`select query from meta.lov where app_id = $1 and name = 'JOBS'`, [await appId()])).query;
const appName = async () => (await owner.one('select name from meta.app where id = $1', [await appId()])).name;

before(async () => {
  await owner.query('delete from meta.app where alias = $1', [ALIAS]);
  assert.equal(cli('export', 'hr', '-o', 'src', '--format', 'text').code, 0);
  assert.equal(cli('import', 'src', '--alias', ALIAS).code, 0);
});
after(async () => {
  await owner.query('delete from meta.app where alias = $1', [ALIAS]);
  rmSync(tmp, { recursive: true, force: true });
  await closePools();
});

describe('pgkiln import --only (file-level import)', () => {
  test('matching: page numbers, files and folders; no paths outside the export', () => {
    const page = onlyMatcher('pages/12');
    assert.ok(page.test('pages/0012-leave-calendar/page.yaml'));
    assert.ok(page.test('pages/0012-renamed/regions/0010-x.yaml'));
    assert.ok(!page.test('pages/0120-other/page.yaml') && !page.test('pages/0012-x'));
    assert.ok(onlyMatcher('12').test('pages/0012-a/page.json'));
    assert.ok(onlyMatcher('./shared/lovs/').test('shared/lovs/jobs.yaml'));
    assert.ok(!onlyMatcher('shared/lovs').test('shared/lovs-x/jobs.yaml'));
    for (const bad of ['../x', '/etc/passwd', 'shared/../../x', '', 'pgkiln.json']) assert.throws(() => onlyMatcher(bad), bad);
    const marker = Buffer.from('{"format":"pgkiln/2","layout":1,"style":"text"}');
    const current = new Map([['pgkiln.json', marker], ['app.yaml', Buffer.from('a')], ['pages/0001-a/page.yaml', Buffer.from('old')]]);
    const incoming = new Map([['pgkiln.json', marker], ['app.yaml', Buffer.from('b')], ['pages/0001-b/page.yaml', Buffer.from('new')]]);
    const m = mergeOnly(current, incoming, ['pages/1']);
    assert.deepEqual([...m.files.keys()].sort(), ['app.yaml', 'pages/0001-b/page.yaml', 'pgkiln.json']);
    assert.equal(m.files.get('app.yaml')!.toString(), 'a', 'not selected: the current file');
    assert.deepEqual(m.changed, ['pages/0001-a/page.yaml', 'pages/0001-b/page.yaml']);
    assert.throws(() => mergeOnly(current, incoming, ['pages/2']), /not in the directory or the application/);
    assert.throws(() => mergeOnly(current, new Map([['pgkiln.json', Buffer.from('{"format":"pgkiln/2","layout":1}')]]), ['pages/1']), /another style/);
  });

  test('--only pages/12 imports that page and nothing else', async () => {
    assert.equal(cli('export', ALIAS, '-o', 'work', '--format', 'text').code, 0);
    const dir = join(tmp, 'work');
    edit(join(pageDir(dir, 12), 'page.yaml'), /^title: .*$/m, 'title: Leave calendar (file-level)');
    edit(join(dir, 'shared/lovs/jobs.yaml'), /Clerk;CLERK/, 'Clerk;CLERK,Intern;INTERN');
    edit(join(dir, 'app.yaml'), /^name: .*$/m, 'name: Not imported');
    const before3 = await pageTitle(3);
    const r = cli('import', 'work', '--alias', ALIAS, '--replace', '--only', 'pages/12');
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /Only page 12: 1 file\(s\) differ/);
    assert.match(r.out, new RegExp(`Replaced ${ALIAS}`));
    assert.equal(await pageTitle(12), 'Leave calendar (file-level)');
    assert.equal(await pageTitle(3), before3);
    assert.doesNotMatch(await lovQuery(), /INTERN/);
    assert.equal(await appName(), 'HR Demo');
    // a shared component file next
    const lov = cli('import', 'work', '--alias', ALIAS, '--replace', '--only', 'shared/lovs/jobs.yaml');
    assert.equal(lov.code, 0, lov.err);
    assert.match(await lovQuery(), /INTERN/);
    assert.equal(await appName(), 'HR Demo');
    // a page missing from the directory is deleted
    rmSync(pageDir(dir, 12), { recursive: true });
    assert.equal(cli('import', 'work', '--alias', ALIAS, '--replace', '--only', 'pages/12', '--only', 'shared/lovs').code, 0);
    assert.equal(await pageTitle(12), undefined);
    assert.ok(await pageTitle(3));
  });

  test('refused: without --replace, from a JSON file, a path in neither, an unknown application; --dry-run changes nothing', async () => {
    assert.equal(cli('export', ALIAS, '-o', 'work2', '--format', 'text').code, 0);
    let r = cli('import', 'work2', '--alias', ALIAS, '--only', 'pages/3');
    assert.equal(r.code, 2);
    assert.match(r.err, /--only needs --replace/);
    writeFileSync(join(tmp, 'app.json'), JSON.stringify((await owner.one('select meta.export_app($1) as d', [ALIAS])).d));
    r = cli('import', 'app.json', '--alias', ALIAS, '--replace', '--only', 'pages/3');
    assert.equal(r.code, 2);
    assert.match(r.err, /directory export or a \.zip/);
    r = cli('import', 'work2', '--alias', ALIAS, '--replace', '--only', 'pages/999');
    assert.equal(r.code, 2);
    assert.match(r.err, /--only page 999: not in the directory or the application/);
    r = cli('import', 'work2', '--alias', ALIAS, '--replace', '--only', '../outside');
    assert.equal(r.code, 2);
    r = cli('import', 'work2', '--alias', 'hr_only116_missing', '--replace', '--only', 'pages/3');
    assert.equal(r.code, 2);
    assert.match(r.err, /application hr_only116_missing not found/);
    edit(join(pageDir(join(tmp, 'work2'), 3), 'page.yaml'), /^title: .*$/m, 'title: Dry run only');
    r = cli('import', 'work2', '--alias', ALIAS, '--replace', '--only', 'pages/3', '--dry-run');
    assert.match(r.out, /Dry run: nothing was imported/, r.err + r.out);
    assert.notEqual(await pageTitle(3), 'Dry run only');
  });
});
