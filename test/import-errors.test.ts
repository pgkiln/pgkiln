// (sprint 251, MG-28) Import errors that name the file, the component and the key (src/import-errors.ts): values of the
// wrong type, two components with one unique key, values a check refuses (allowed values, conditions), `condition` /
// `condition_expr` on either kind of component, `pgkiln advise --offline`, and the schema snapshot it uses.
import '../src/env.ts';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { docToFiles, filesToDoc, type Doc, type FileMap } from '../src/appfiles.ts';
import { exportDoc, importDoc, UsageError, withDb } from '../src/cli/apps.ts';
import { adviseOffline } from '../src/cli/advise.ts';
import { writeDir } from '../src/cli/files.ts';
import { fillFiles, loadColumnDefaults } from '../src/import-defaults.ts';
import {
  bundledImportSchema, castProblem, checkImportDoc, conditionProblem, conditionTypesOf, CONDITION_KEY, explainImportError, formatProblems,
  loadImportSchema, normalizeConditionKeys, parseConditionCheck, parseEnumCheck, type ImportSchema,
} from '../src/import-errors.ts';
import { fromText, toText } from '../src/yamltext.ts';
import { closePools } from '../src/db.ts';

const ALIAS = 'hr_mg28';
const tmp = mkdtempSync(join(tmpdir(), 'pgkiln-mg28-'));
let exported: FileMap;
let live: ImportSchema;

const yaml = (files: FileMap, path: string) => fromText(files.get(path)!.toString('utf8'), path) as any;
const put = (files: FileMap, path: string, v: unknown) => files.set(path, Buffer.from(toText(v), 'utf8'));
const find = (files: FileMap, re: RegExp) => {
  const p = [...files.keys()].find((k) => re.test(k));
  assert.ok(p, `no file ${re}`);
  return p!;
};
/** The exported files with one file changed. */
function edit(path: string, change: (row: any) => void, files: FileMap = new Map(exported)) {
  const v = yaml(files, path);
  change(v);
  put(files, path, v);
  return files;
}
/** The import's error text for these files (an import that succeeds fails the test). */
async function refusal(files: FileMap, replace = false) {
  return withDb(async (db) => {
    try {
      await importDoc(db, filesToDoc(files), { alias: replace ? ALIAS : `${ALIAS}_new`, replace });
    } catch (e) {
      assert.ok(e instanceof UsageError, `a UsageError, not ${(e as Error).message}`);
      return (e as Error).message;
    }
    assert.fail('the import succeeded');
  });
}

before(async () => {
  await withDb(async (db) => {
    await db.query('delete from meta.app where alias = any($1)', [[ALIAS, `${ALIAS}_new`]]);
    live = await loadImportSchema(db);
    await importDoc(db, await exportDoc(db, 'hr'), { alias: ALIAS, replace: false });
    exported = docToFiles(await exportDoc(db, ALIAS), 'text');
  });
});

after(async () => {
  await withDb((db) => db.query('delete from meta.app where alias = any($1)', [[ALIAS, `${ALIAS}_new`]]));
  rmSync(tmp, { recursive: true, force: true });
  await closePools();
});

describe('the catalog', () => {
  test('parses allowed-value checks and conditions', () => {
    assert.deepEqual(parseEnumCheck(`CHECK ((point = ANY (ARRAY['submit'::text, 'load'::text, 'ajax'::text])))`), { column: 'point', values: ['submit', 'load', 'ajax'] });
    assert.deepEqual(parseEnumCheck(`CHECK (("position" = ANY (ARRAY['body'::text, 'it''s'::text])))`), { column: 'position', values: ['body', "it's"] });
    assert.deepEqual(parseEnumCheck('CHECK ((debug_level = ANY (ARRAY[0, 1, 2, 4, 6, 9])))'), { column: 'debug_level', values: ['0', '1', '2', '4', '6', '9'] });
    assert.equal(parseEnumCheck('CHECK (((columns >= 1) AND (columns <= 12)))'), null);
    assert.deepEqual(parseConditionCheck('CHECK (meta.condition_ok(condition_type, condition_expr, condition_value))'),
      { type: 'condition_type', expr: 'condition_expr', value: 'condition_value', implicitSql: false });
    assert.equal(parseConditionCheck(`CHECK (meta.condition_ok(COALESCE(condition_type,\nCASE\n    WHEN (COALESCE(TRIM(BOTH FROM condition), ''::text) <> ''::text) THEN 'sql'::text\n    ELSE NULL::text\nEND), condition, condition_value))`)?.implicitSql, true);
    assert.deepEqual(conditionTypesOf(`when p_type in ('sql', 'exists') then x when p_type in ('always') then true`), ['sql', 'exists', 'always']);
  });

  test('the live catalog has the constraints the messages are about', () => {
    assert.deepEqual(live.enums.find((e) => e.name === 'process_point_check')?.values, ['submit', 'load', 'ajax']);
    assert.ok(live.conditions.some((c) => c.name === 'region_condition_ok' && c.expr === 'condition' && c.implicitSql));
    assert.ok(live.uniques.some((u) => u.name === 'item_page_id_name_key'));
    assert.equal(live.types.button?.target_page, 'integer');
  });

  test('src/import-schema.json (advise --offline) matches the catalog: run npx tsx scripts/import-schema.ts when it does not', () => {
    const snap = bundledImportSchema();
    const fix = ' (src/import-schema.json is out of date: run npx tsx scripts/import-schema.ts)';
    for (const [t, cols] of Object.entries(snap.types)) for (const [c, type] of Object.entries(cols)) assert.equal(live.types[t]?.[c], type, `${t}.${c}${fix}`);
    for (const e of snap.enums) assert.deepEqual(live.enums.find((x) => x.name === e.name && x.table === e.table), e, `${e.name}${fix}`);
    for (const c of snap.conditions) assert.deepEqual(live.conditions.find((x) => x.name === c.name && x.table === c.table), c, `${c.name}${fix}`);
    for (const u of snap.uniques) assert.deepEqual(live.uniques.find((x) => x.name === u.name && x.table === u.table), u, `${u.name}${fix}`);
    assert.deepEqual(snap.conditionTypes, live.conditionTypes, `condition types${fix}`);
  });

  test('CONDITION_KEY is the catalog\'s condition column of each table', async () => {
    const rows = await withDb(async (db) => (await db.query(
      `select table_name as t, column_name as c from information_schema.columns
        where table_schema = 'meta' and column_name in ('condition', 'condition_expr') order by 1`)).rows as { t: string; c: string }[]);
    const exportedTables = rows.filter((r) => live.conditions.some((c) => c.table === r.t) || r.t in CONDITION_KEY);
    for (const r of exportedTables) assert.equal(CONDITION_KEY[r.t], r.c, r.t);
  });
});

describe('the checks mirror PostgreSQL', () => {
  test('casts: castProblem agrees with jsonb_to_record', async () => {
    const values: unknown[] = [12, -3, ' 12 ', '0x1F', '1_000', '12a', '&P11_BACK.', 3.5, '3.0', '3e2', true, false, 'yes', 'Y', 'of', 'o', 't ', '1', '0', '2',
      2, 1, 0, '', ' ', 'NaN', '-Infinity', '.5', '1.', '+7', '99999999999', '2147483647', '-2147483648', '2147483648', [1], { a: 1 }, null];
    const wrong: string[] = [];
    await withDb(async (db) => {
      for (const type of ['integer', 'smallint', 'bigint', 'numeric', 'double precision', 'boolean'])
        for (const v of values) {
          const pg = await db.query(`select v from jsonb_to_record($1::jsonb) as x(v ${type})`, [JSON.stringify({ v })])
            .then(() => null, (e: any) => (e.code === '22003' ? 'range' : 'syntax'));
          // a range error of a float is PostgreSQL's (out of range), the mirror calls it fine: never a false alarm
          if (castProblem(type, v) !== pg) wrong.push(`${type} ${JSON.stringify(v)}: ${castProblem(type, v)} / ${pg}`);
        }
    });
    assert.deepEqual(wrong, []);
  });

  test('conditions: conditionProblem agrees with meta.condition_ok', async () => {
    const types = [...live.conditionTypes, 'nonsense'];
    const exprs = [null, '', ' ', 'P1_X', 'p1_x', 'select 1'];
    const vals = [null, '', 'P1_Y', ' P1_Y ', 'A, B', '1, 2', 'en, nl-BE', 'a:b', 'x'.repeat(4001)];
    await withDb(async (db) => {
      const r = (await db.query(
        `select t, e, v, meta.condition_ok(t, e, v) as ok from unnest($1::text[]) t, unnest($2::text[]) e, unnest($3::text[]) v`, [types, exprs, vals])).rows;
      assert.ok(r.length > 500);
      for (const x of r) assert.equal(conditionProblem(x.t, x.e, x.v, live.conditionTypes) === null, x.ok, `${x.t} / ${x.e} / ${String(x.v).slice(0, 20)}`);
    });
  });

  test('an export has no problems (no false alarms), with the catalog and with the snapshot', () => {
    assert.deepEqual(checkImportDoc(filesToDoc(exported), live).map((p) => p.message), []);
    assert.deepEqual(checkImportDoc(filesToDoc(exported), bundledImportSchema()).map((p) => p.message), []);
  });
});

describe('an import that fails names the file and the key', () => {
  test('a value of the wrong type: the file, the component, the key and the value', async () => {
    const button = find(exported, /^pages\/0002-[^/]+\/buttons\/[^/]+\.yaml$/);
    const msg = await refusal(edit(button, (b) => { b.target_page = '&P11_BACK.'; }));
    assert.match(msg, /nothing changed/);
    assert.ok(msg.includes(`${button} (page 2, button `), msg);
    assert.match(msg, /"target_page" is "&P11_BACK\.": meta\.button\.target_page takes a whole number\. A substitution/);
    assert.doesNotMatch(msg, /invalid input syntax/);
  });

  test('every value of the wrong type at once, on import --replace too', async () => {
    const button = find(exported, /^pages\/0002-[^/]+\/buttons\/[^/]+\.yaml$/);
    const msg = await refusal(edit(button, (b) => { b.seq = 'ten'; b.hot = 'maybe'; }), true);
    assert.match(msg, /"seq" is "ten": meta\.button\.seq takes a whole number/);
    assert.match(msg, /"hot" is "maybe": meta\.button\.hot takes true or false/);
    // nothing changed
    const again = await withDb(async (db) => docToFiles(await exportDoc(db, ALIAS), 'text'));
    assert.deepEqual(yaml(again, button), yaml(exported, button));
  });

  test('two items of one name on a page: both files', async () => {
    const item = find(exported, /^pages\/0003-[^/]+\/items\/[^/]+p3_ename\.yaml$/);
    const files = new Map(exported);
    const twin = item.replace(/p3_ename\.yaml$/, 'p3_ename_copy.yaml');
    files.set(twin, exported.get(item)!);
    const msg = await refusal(files);
    assert.match(msg, /2 items have the name "P3_ENAME" on page 3/);
    assert.ok(msg.includes(item) && msg.includes(twin), msg);
    assert.match(msg, /item_page_id_name_key allows one/);
  });

  test('a value a check refuses: the allowed values, and a point only computations have', async () => {
    const proc = find(exported, /^pages\/0003-[^/]+\/processes\/[^/]+\.yaml$/);
    const msg = await refusal(edit(proc, (p) => { p.point = 'before_header'; }));
    assert.ok(msg.includes(proc), msg);
    assert.match(msg, /"point" is "before_header"; meta\.process\.point allows submit, load, ajax\./);
    assert.match(msg, /is the point of [^.]*computations[^.]*, not of a process\. A process that runs when the page is shown has point "load"/);
    const wrongCase = await refusal(edit(proc, (p) => { p.point = 'Submit'; }));
    assert.match(wrongCase, /Did you mean "submit"\?/);
  });

  test('a condition its type refuses', async () => {
    const button = find(exported, /^pages\/0002-[^/]+\/buttons\/[^/]+\.yaml$/);
    const msg = await refusal(edit(button, (b) => { b.condition_type = 'sql'; b.condition = null; }));
    assert.match(msg, /"condition_type" is "sql": it needs the SQL \("condition" is empty\)/);
    const unknown = await refusal(edit(button, (b) => { b.condition_type = 'item_is_set'; b.condition = 'P2_X'; }));
    assert.match(unknown, /is not a condition type; the condition types are sql, /);
  });

  test('a check without a list of values: PostgreSQL finds the row, the message shows the check', async () => {
    const region = find(exported, /^pages\/0002-[^/]+\/regions\/[^/]+\.yaml$/);
    const msg = await refusal(edit(region, (r) => { r.columns = 15; }));
    assert.ok(msg.includes(region), msg);
    assert.match(msg, /region_columns_check: CHECK .*\("columns" is 15\)/);
  });

  test('a JSON document (no files) names the component', async () => {
    const doc = filesToDoc(edit(find(exported, /^pages\/0002-[^/]+\/buttons\/[^/]+\.yaml$/), (b) => { b.seq = 'ten'; }));
    const plain = JSON.parse(JSON.stringify(doc)) as Doc;
    const msg = await withDb((db) => importDoc(db, plain, { alias: `${ALIAS}_new`, replace: false }).then(() => '', (e) => (e as Error).message));
    assert.match(msg, /^The import was refused, nothing changed:\n {2}- page 2, button [^:]+: "seq" is "ten"/);
  });
});

describe('condition and condition_expr', () => {
  test('a region or button may say condition_expr, an item or process condition: the import gives the table\'s key', async () => {
    const region = find(exported, /^pages\/0002-[^/]+\/regions\/[^/]+\.yaml$/);
    const item = find(exported, /^pages\/0003-[^/]+\/items\/[^/]+p3_ename\.yaml$/);
    let files = edit(region, (r) => { delete r.condition; r.condition_type = 'sql'; r.condition_expr = 'select true'; });
    files = edit(item, (i) => { delete i.condition_expr; i.condition_type = 'item_not_null'; i.condition = 'P3_EMPNO'; }, files);
    // diff compares them as the table's own key
    const filled = fillFiles(files, await withDb((db) => loadColumnDefaults(db)));
    assert.equal(yaml(filled, region).condition, 'select true');
    assert.equal('condition_expr' in yaml(filled, region), false);
    await withDb((db) => importDoc(db, filesToDoc(files), { alias: ALIAS, replace: true }));
    const after = await withDb(async (db) => docToFiles(await exportDoc(db, ALIAS), 'text'));
    // export keeps writing the canonical key
    assert.equal(yaml(after, region).condition, 'select true');
    assert.equal('condition_expr' in yaml(after, region), false);
    assert.equal(yaml(after, item).condition_expr, 'P3_EMPNO');
    assert.equal('condition' in yaml(after, item), false);
    await withDb(async (db) => importDoc(db, filesToDoc(exported), { alias: ALIAS, replace: true }));
  });

  test('both keys with different values are refused, naming the file', async () => {
    const button = find(exported, /^pages\/0002-[^/]+\/buttons\/[^/]+\.yaml$/);
    const msg = await refusal(edit(button, (b) => { b.condition = 'select true'; b.condition_expr = 'select false'; }));
    assert.ok(msg.includes(button), msg);
    assert.match(msg, /gives both "condition" and "condition_expr" with different values/);
    // the same value twice is fine
    const doc = filesToDoc(edit(button, (b) => { b.condition = 'select true'; b.condition_expr = 'select true'; }));
    assert.deepEqual(normalizeConditionKeys(doc), []);
  });
});

describe('pgkiln advise --offline', () => {
  test('reports what the import would refuse, at its file, without a database', async () => {
    const button = find(exported, /^pages\/0002-[^/]+\/buttons\/[^/]+\.yaml$/);
    const proc = find(exported, /^pages\/0003-[^/]+\/processes\/[^/]+\.yaml$/);
    const files = edit(proc, (p) => { p.point = 'after_submit'; }, edit(button, (b) => { b.target_page = '&P11_BACK.'; b.condition_expr = 'select 1'; b.condition = null; b.condition_type = null; }));
    const dir = join(tmp, 'offline');
    writeDir(dir, files);
    const r = await adviseOffline(dir);
    const refused = r.findings.filter((f) => f.message.endsWith('(the import refuses this)'));
    assert.deepEqual(refused.map((f) => [f.file, f.field]).sort(), [[button, 'target_page'], [proc, 'point']].sort());
    assert.ok(refused.every((f) => f.severity === 'error'));
    assert.match(refused.find((f) => f.field === 'point')!.message, /has point "submit"/);
    // a clean export: nothing refused
    const clean = join(tmp, 'clean');
    writeDir(clean, exported);
    assert.equal((await adviseOffline(clean)).findings.filter((f) => f.message.endsWith('(the import refuses this)')).length, 0);
  });
});

describe('messages never show another row', () => {
  test('a unique key that conflicts with a row outside the files: no DETAIL, no other row\'s values', async () => {
    const doc = filesToDoc(exported);
    const err = Object.assign(new Error('duplicate key value violates unique constraint "app_alias_key"'), {
      code: '23505', schema: 'meta', table: 'app', constraint: 'app_alias_key', detail: 'Key (alias)=(other-workspace-secret) already exists.',
    });
    const msg = await explainImportError(err, doc, { schema: live });
    assert.ok(msg);
    assert.doesNotMatch(msg!, /other-workspace-secret|Key \(/);
    assert.match(msg!, /an app has the same alias as one that is already in the database \(unique key app_alias_key\)/);
  });

  test('errors of other schemas or kinds are left alone', async () => {
    const doc = filesToDoc(exported);
    assert.equal(await explainImportError(Object.assign(new Error('x'), { code: '23505', schema: 'hr', constraint: 'emp_pkey' }), doc, { schema: live }), null);
    assert.equal(await explainImportError(Object.assign(new Error('x'), { code: '42601' }), doc, { schema: live }), null);
    assert.equal(await explainImportError(new Error('plain'), doc, { schema: live }), null);
  });

  test('formatProblems keeps the list short', () => {
    const p = { file: 'a.yaml', label: 'x', table: 'item', key: 'k', rule: 'type', message: 'm', pageNo: null };
    const text = formatProblems(Array.from({ length: 12 }, () => p));
    assert.match(text, /\(and 2 more\)$/);
  });
});
