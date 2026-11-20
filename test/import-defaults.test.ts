// (sprint 242, MG-16) Keys left out of hand-written application files take the column defaults on import
// (src/import-defaults.ts): round trip export → strip keys → diff (no change) → import → export.
import '../src/env.ts';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { root } from '../src/env.ts';
import { docToFiles, filesToDoc, stableJson, type FileMap } from '../src/appfiles.ts';
import { exportDoc, importDoc, withDb } from '../src/cli/apps.ts';
import { compareFiles } from '../src/cli/diff.ts';
import { writeDir } from '../src/cli/files.ts';
import { fillDefaults, fillFiles, isConstantDefault, loadColumnDefaults, MUST_GIVE, shapeOf, type ColumnDefaults } from '../src/import-defaults.ts';
import { fromText, toText } from '../src/yamltext.ts';
import { closePools, owner } from '../src/db.ts';
import { buildApp } from '../src/app.ts';
import { Browser } from './helpers.ts';

const ALIAS = 'hr_mg16';
const BUILDER_ALIAS = 'hr_mg16_builder';
const tmp = mkdtempSync(join(tmpdir(), 'pgkiln-mg16-'));
let defaults: ColumnDefaults;
let exported: FileMap;

const yaml = (files: FileMap, path: string) => fromText(files.get(path)!.toString('utf8'), path) as any;
const put = (files: FileMap, path: string, v: unknown) => files.set(path, Buffer.from(toText(v), 'utf8'));

/** The files with every key that equals its column default left out (what a hand-written file may look like). */
function strip(files: FileMap) {
  const out: FileMap = new Map(files);
  let n = 0;
  const drop = (row: any, d: Record<string, unknown>) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return;
    for (const [k, v] of Object.entries(d)) if (k in row && isDeepStrictEqual(row[k], v)) { delete row[k]; n++; }
    if (Array.isArray(row.children)) for (const c of row.children) drop(c, d);
  };
  for (const path of files.keys()) {
    const shape = shapeOf(path);
    if (!shape || !path.endsWith('.yaml') || !defaults[shape.table]) continue;
    const v = yaml(files, path);
    if (shape.kind === 'record') drop(v, defaults[shape.table]);
    else if (shape.kind === 'trees') for (const rows of Object.values(v)) for (const r of rows as any[]) drop(r, defaults[shape.table]);
    else for (const r of v) drop(r, defaults[shape.table]);
    put(out, path, v);
  }
  return { files: out, stripped: n };
}

before(async () => {
  await withDb(async (db) => {
    await db.query('delete from meta.app where alias = $1', [ALIAS]);
    defaults = await loadColumnDefaults(db);
    exported = docToFiles(await exportDoc(db, 'hr'), 'text');
    await importDoc(db, filesToDoc(exported), { alias: ALIAS, replace: false });
    exported = docToFiles(await exportDoc(db, ALIAS), 'text');
  });
});
after(async () => {
  await withDb((db) => db.query('delete from meta.app where alias = any($1)', [[ALIAS, BUILDER_ALIAS, `${BUILDER_ALIAS}_x`]]));
  rmSync(tmp, { recursive: true, force: true });
  await closePools();
});

describe('sprint 242 MG-16: keys left out of the files take the column defaults', () => {
  test('constant defaults only, from the catalog; never ids, sequences or what the export leaves out', () => {
    assert.ok(isConstantDefault(`'checksum'::text`) && isConstantDefault('false') && isConstantDefault(`'{}'::jsonb`) && isConstantDefault(`'a(b)'::text`));
    assert.ok(!isConstantDefault(`nextval('meta.app_id_seq'::regclass)`) && !isConstantDefault('now()') && !isConstantDefault('gen_random_uuid()'));
    assert.equal(defaults.app.debug, false);
    assert.equal(defaults.page.protection, 'checksum');
    assert.equal(defaults.page.requires_auth, true);
    assert.equal(defaults.item.seq, 10);
    for (const t of Object.values(defaults)) assert.ok(!('id' in t) && !('app_id' in t) && !('created_at' in t));
    assert.ok(!('build_status' in defaults.app) && !('availability' in defaults.app));
    // the open value for access is never a default to fill
    for (const [t, cols] of Object.entries(MUST_GIVE)) for (const c of Object.keys(cols)) assert.ok(!(c in (defaults[t] ?? {})), `${t}.${c}`);
  });

  test('an export has every key: nothing is filled', () => {
    assert.deepEqual(fillDefaults(filesToDoc(exported), defaults), []);
    assert.equal(compareFiles(exported, fillFiles(exported, defaults)).length, 0);
  });

  test('round trip: strip keys, diff shows no change, import fills them, export is the same', async () => {
    const { files, stripped } = strip(exported);
    assert.ok(stripped > 100, `stripped ${stripped} keys`);
    assert.equal(yaml(files, 'app.yaml').debug, undefined);
    const home = [...files.keys()].find((p) => /^pages\/[^/]+\/page\.yaml$/.test(p) && yaml(exported, p).protection === 'checksum')!;
    assert.equal(yaml(files, home).protection, undefined);
    // the raw files differ; filled as the import fills them, they don't
    assert.ok(compareFiles(exported, files).length > 0);
    assert.deepEqual(compareFiles(exported, fillFiles(files, defaults)), []);

    // pgkiln diff on a directory: no differences (exit code 0)
    const dir = join(tmp, 'stripped');
    writeDir(dir, files);
    const r = spawnSync(process.execPath, [join(root, 'bin/pgkiln.js'), 'diff', ALIAS, dir, '--name-only'], { cwd: tmp, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);

    const result = await withDb((db) => importDoc(db, filesToDoc(files), { alias: ALIAS, replace: true }));
    assert.equal(result.committed, true);
    const app = result.filled.find((f) => f.file === 'app.yaml');
    assert.ok(app?.keys.includes('debug'), JSON.stringify(result.filled.slice(0, 3)));
    assert.ok(result.filled.find((f) => f.file === home)?.keys.includes('protection'));
    assert.deepEqual(compareFiles(exported, docToFiles(await withDb((db) => exportDoc(db, ALIAS)), 'text')), []);
  });

  test('a key present with null stays null: a NOT NULL column refuses it, naming the file and the key', async () => {
    const files: FileMap = new Map(exported);
    const page = [...files.keys()].find((p) => /^pages\/[^/]+\/page\.yaml$/.test(p))!;
    put(files, page, { ...yaml(files, page), protection: null });
    const doc = filesToDoc(files);
    assert.ok(!fillDefaults(doc, defaults).some((f) => f.keys.includes('protection')));
    await assert.rejects(
      withDb((db) => importDoc(db, filesToDoc(files), { alias: ALIAS, replace: true })),
      (e: Error) => e.message.includes(page) && e.message.includes('"protection" is null') && e.message.includes("meta.page.protection may not be null"),
    );
  });

  test('a required key without a default that is missing: the error names the file, the component and the key', async () => {
    const files: FileMap = new Map(exported);
    const lov = [...files.keys()].find((p) => p.startsWith('shared/lovs/') && p.endsWith('.yaml'))!;
    const { query: _q, ...rest } = yaml(files, lov);
    put(files, lov, rest);
    await assert.rejects(
      withDb((db) => importDoc(db, filesToDoc(files), { alias: ALIAS, replace: true })),
      (e: Error) => e.message.includes(lov) && e.message.includes(`lov ${rest.name}`) && e.message.includes('"query" is missing'),
    );
  });

  test('the Advisor notes the filled keys, with their file', async () => {
    const files: FileMap = new Map(exported);
    const { debug: _d, ...app } = yaml(files, 'app.yaml');
    put(files, 'app.yaml', app);
    const dir = join(tmp, 'advise');
    writeDir(dir, files);
    process.env.RUNTIME_DATABASE_URL ??= process.env.DATABASE_URL;
    const { adviseTarget } = await import('../src/cli/advise.ts');
    const r = await withDb((db) => adviseTarget(db, dir));
    const note = r.findings.find((f) => f.file === 'app.yaml' && f.severity === 'info' && f.field === 'debug');
    assert.ok(note, JSON.stringify(r.findings.filter((f) => f.severity === 'info').slice(0, 5)));
    assert.match(note.message, /column default/);
  });

  test('a JSON document (no files) is filled too, labelled by component', () => {
    const doc = JSON.parse(stableJson(filesToDoc(exported)));
    delete doc.pages[0].protection;
    const filled = fillDefaults(doc, defaults);
    assert.equal(doc.pages[0].protection, 'checksum');
    assert.deepEqual(filled, [{ where: `page ${doc.pages[0].page_no}`, file: null, keys: ['protection'] }]);
  });

  test('the builder\'s Import (a JSON document) fills left-out keys too', async () => {
    const app = await buildApp({ logger: false });
    try {
      const doc = JSON.parse(stableJson(filesToDoc(exported)));
      delete doc.app.debug;
      for (const p of doc.pages) delete p.protection;
      const dev = new Browser(app);
      await dev.get('/builder/login');
      await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
      await dev.get('/builder/import');
      await dev.submit('/builder/import', { doc: JSON.stringify(doc), alias: BUILDER_ALIAS });
      const r = await owner.one<{ debug: boolean; n: number }>(
        `select a.debug, (select count(*)::int from meta.page p where p.app_id = a.id and p.protection is null) as n from meta.app a where a.alias = $1`, [BUILDER_ALIAS]);
      assert.deepEqual(r, { debug: false, n: 0 });
      // (lead review) a key whose default would widen access is refused, not filled
      const open = JSON.parse(stableJson(filesToDoc(exported)));
      delete open.app.local_login;
      await dev.get('/builder/import');
      await dev.submit('/builder/import', { doc: JSON.stringify(open), alias: `${BUILDER_ALIAS}_x` });
      assert.equal((await owner.query('select 1 from meta.app where alias = $1', [`${BUILDER_ALIAS}_x`])).rowCount, 0);
    } finally {
      await app.close();
    }
  });
});
