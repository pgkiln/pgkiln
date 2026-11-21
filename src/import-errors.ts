// (sprint 251, MG-28) Import errors that name the file, the component and the key.
//
// meta.import_app() reads each component with jsonb_populate_record(null::meta.<table>, …) and inserts it: a value
// that is not of the column's type, two components with the same unique key or a value a check constraint refuses
// fails with PostgreSQL's own message ("invalid input syntax for type integer: "&P11_BACK."", "duplicate key value
// violates unique constraint "item_page_id_name_key"", "… violates check constraint "process_point_check"") and
// nothing says which of a few hundred files holds it. This module checks a document against what the catalog says
// about meta's tables (the column types, the check constraints that list their allowed values, the conditions of
// meta.condition_ok and the unique keys) and turns such an error into one that names the file, the component, the
// key, its value and, for a list, the allowed values:
//  - checkImportDoc(doc, schema): every problem of the document it can see without importing (also `pgkiln advise
//    --offline`, with the snapshot of the schema in import-schema.json, so no database is needed);
//  - explainImportError(e, doc, …): the import's error explained, or null when it is something else;
//  - normalizeConditionKeys(doc): a region's or button's SQL condition is `condition`, every other component's is
//    `condition_expr`; a file may use either, and the import gives the column the one it doesn't have.
// What a message shows comes from the document (the importer's own files) and from meta's catalog (column types,
// constraint names and their allowed values): never from the error's DETAIL or from another row, so a conflict with
// a component of another application or workspace says that there is one, not what it holds.
import { readFileSync } from 'node:fs';
import type { Doc } from './appfiles.ts';
import { sourceOf } from './appfiles.ts';
import { rowsOf, TABLES } from './import-defaults.ts';

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

/** What an import must know about meta's tables to check a document; from the catalog (or import-schema.json). */
export interface ImportSchema {
  /** table → column → type, for the columns of a type a JSON value can fail to cast to (integer, numeric, boolean) */
  types: Record<string, Record<string, string>>;
  /** check constraints that list a column's allowed values: col = ANY (ARRAY[…]) */
  enums: { name: string; table: string; column: string; values: string[] }[];
  /** check constraints that call meta.condition_ok(type, expression, value) */
  conditions: { name: string; table: string; type: string; expr: string; value: string; implicitSql: boolean }[];
  /** the condition types meta.condition_ok knows */
  conditionTypes: string[];
  /** unique keys (constraints and unique indexes on columns, not expressions or partial ones) */
  uniques: { name: string; table: string; columns: string[] }[];
}

export interface ImportProblem {
  /** the file (relative to the application directory), when the document was read from files */
  file: string | null;
  /** the component, e.g. "page 3, process Start onboarding" */
  label: string;
  table: string;
  key: string;
  /** what refuses it: a constraint name, or "type" for a value of the wrong type */
  rule: string;
  message: string;
  /** the page number of a page's component (for the Advisor's report) */
  pageNo: number | null;
  /** the message names the files itself (two components with one unique key) */
  whole?: boolean;
}

const CAST_TYPES = new Set(['smallint', 'integer', 'bigint', 'numeric', 'real', 'double precision', 'boolean']);

// ------------------------------------------------------------------ the catalog

/** The schema facts of meta's exported tables, from the catalog. */
export async function loadImportSchema(db: Q): Promise<ImportSchema> {
  const types: ImportSchema['types'] = {};
  for (const r of (await db.query(
    `select c.relname as t, a.attname as c, regexp_replace(format_type(a.atttypid, null), '\\(.*$', '') as type
       from pg_attribute a join pg_class c on c.oid = a.attrelid
      where c.relnamespace = 'meta'::regnamespace and c.relkind = 'r' and c.relname = any($1) and a.attnum > 0 and not a.attisdropped
      order by 1, 2`, [TABLES])).rows as { t: string; c: string; type: string }[])
    if (CAST_TYPES.has(r.type)) (types[r.t] ??= {})[r.c] = r.type;
  const enums: ImportSchema['enums'] = [];
  const conditions: ImportSchema['conditions'] = [];
  for (const r of (await db.query(
    `select c.relname as t, k.conname as name, pg_get_constraintdef(k.oid) as def
       from pg_constraint k join pg_class c on c.oid = k.conrelid
      where k.contype = 'c' and c.relnamespace = 'meta'::regnamespace and c.relname = any($1) order by 1, 2`, [TABLES])).rows as { t: string; name: string; def: string }[]) {
    const e = parseEnumCheck(r.def);
    if (e) enums.push({ name: r.name, table: r.t, ...e });
    const c = parseConditionCheck(r.def);
    if (c) conditions.push({ name: r.name, table: r.t, ...c });
  }
  const fn = (await db.query(`select pg_get_functiondef('meta.condition_ok(text, text, text)'::regprocedure) as def`)).rows[0]?.def ?? '';
  const uniques = (await db.query(
    `select c.relname as t, i.relname as name,
            array(select a.attname::text from unnest(x.indkey::int2[]) with ordinality k(n, o)
                    join pg_attribute a on a.attrelid = c.oid and a.attnum = k.n order by k.o) as columns
       from pg_index x join pg_class c on c.oid = x.indrelid join pg_class i on i.oid = x.indexrelid
      where c.relnamespace = 'meta'::regnamespace and c.relname = any($1) and x.indisunique and not x.indisprimary
        and x.indpred is null and x.indexprs is null
      order by 1, 2`, [TABLES])).rows.map((r: any) => ({ name: r.name, table: r.t, columns: r.columns as string[] }));
  return { types, enums, conditions, conditionTypes: conditionTypesOf(fn), uniques };
}

/** `col = ANY (ARRAY['a'::text, …])`, alone or as `col IS NULL OR …`: the column and its values; else null. */
export function parseEnumCheck(def: string): { column: string; values: string[] } | null {
  const m = /^CHECK \(+(?:"?(\w+)"? IS NULL\) OR \(+)?\(?"?(\w+)"?\)?(?:::\w+)? = ANY \(\(?ARRAY\[(.*)\]\)?(?:::\w+(?:\[\])?)?\)\)+$/s.exec(def.trim());
  if (!m || (m[1] && m[1] !== m[2])) return null;
  const values: string[] = [];
  // 'a'::text, 'b''c'::text … or numbers
  const re = /\s*(?:'((?:[^']|'')*)'(?:::[\w ]+)?|(-?\d+(?:\.\d+)?))\s*(,|$)/y;
  let v: RegExpExecArray | null;
  while (re.lastIndex < m[3].length && (v = re.exec(m[3]))) values.push(v[1] !== undefined ? v[1].replace(/''/g, "'") : v[2]);
  if (re.lastIndex !== m[3].length) return null;
  return values.length ? { column: m[2], values } : null;
}

/** `meta.condition_ok(type, expr, value)`, with a region's and a button's COALESCE(type, 'sql' when there is SQL). */
export function parseConditionCheck(def: string): { type: string; expr: string; value: string; implicitSql: boolean } | null {
  const m = /^CHECK \(meta\.condition_ok\((COALESCE\()?"?(\w+)"?[\s\S]*,\s*"?(\w+)"?,\s*"?(\w+)"?\)\)$/.exec(def.trim());
  return m ? { type: m[2], expr: m[3], value: m[4], implicitSql: !!m[1] } : null;
}

/** The condition types of meta.condition_ok's definition (its `p_type in (…)` lists). */
export function conditionTypesOf(fn: string): string[] {
  const out: string[] = [];
  for (const m of fn.matchAll(/p_type in \(([^)]*)\)/g)) for (const v of m[1].matchAll(/'([a-z_]+)'/g)) if (!out.includes(v[1])) out.push(v[1]);
  return out;
}

let snapshot: ImportSchema | null = null;
/** The schema of this pgkiln's migrations, without a database (`pgkiln advise --offline`): src/import-schema.json. */
export function bundledImportSchema(): ImportSchema {
  // written by scripts/import-schema.ts; test/import-errors.test.ts compares it with the catalog
  snapshot ??= JSON.parse(readFileSync(new URL('./import-schema.json', import.meta.url), 'utf8')) as ImportSchema;
  return snapshot;
}

// ------------------------------------------------------------------ condition / condition_expr

/** The key of a component's SQL condition: `condition` on these tables, `condition_expr` on the others that have one. */
export const CONDITION_KEY: Record<string, 'condition' | 'condition_expr'> = {
  region: 'condition', button: 'condition', list_entry: 'condition', automation_action: 'condition',
  item: 'condition_expr', process: 'condition_expr', validation: 'condition_expr', computation: 'condition_expr',
  app_computation: 'condition_expr', branch: 'condition_expr',
};

/**
 * Gives each component its table's condition key when the file uses the other one (in place); export keeps writing
 * the table's own. Returns the components that give both, with different values (the import refuses them).
 */
export function normalizeConditionKeys(doc: Doc): ImportProblem[] {
  const problems: ImportProblem[] = [];
  for (const { table, row, label, scope } of rowsOf(doc)) {
    const r = normalizeConditionRow(table, row);
    if (r && r !== 'changed') problems.push(problem(row, table, label, scope, r.key, 'condition', r.message));
  }
  return problems;
}

/** One row's condition key; a conflict when both keys hold different values. Whether it changed the row. */
export function normalizeConditionRow(table: string, row: any): { key: string; message: string } | null | 'changed' {
  const canon = CONDITION_KEY[table];
  if (!canon || !row || typeof row !== 'object' || Array.isArray(row)) return null;
  const alias = canon === 'condition' ? 'condition_expr' : 'condition';
  if (!Object.prototype.hasOwnProperty.call(row, alias)) return null;
  const given = row[alias];
  const own = row[canon];
  if (own === undefined || own === null || own === '' || own === given) row[canon] = given;
  else if (given !== null && given !== '')
    return { key: alias, message: `gives both "${canon}" and "${alias}" with different values: a ${kind(table)}'s SQL condition is "${canon}" ("${alias}" is read as "${canon}"), give one of them` };
  delete row[alias];
  return 'changed';
}

// ------------------------------------------------------------------ meta.condition_ok in JavaScript

const ITEM = /^[A-Z][A-Z0-9_]*$/;
const SQL_TYPES = ['sql', 'exists', 'not_exists', 'function_body'];
const ITEM_TYPES = ['item_null', 'item_not_null', 'item_zero', 'item_not_zero', 'item_null_or_zero', 'item_not_null_or_zero', 'item_equals', 'item_not_equals'];

/**
 * Whether meta.condition_ok(type, expr, value) holds, and what it wants when it doesn't (null: it holds). A type this
 * mirror doesn't know but the catalog does is taken as fine (test/import-errors.test.ts compares the two).
 */
export function conditionProblem(type: string | null, expr: unknown, value: unknown, known: string[]): string | null {
  if (type === null || type === undefined) return null;
  const e = expr === null || expr === undefined ? '' : String(expr);
  const v = value === null || value === undefined ? '' : String(value);
  const item = 'the item\'s name (upper case, e.g. P3_ID)';
  if (SQL_TYPES.includes(type)) return e.trim() !== '' ? null : 'needs the SQL';
  if (ITEM_TYPES.includes(type)) return ITEM.test(e) ? null : `needs ${item} as the expression`;
  if (type === 'item_equals_item' || type === 'item_not_equals_item')
    return ITEM.test(e) && /^ *[A-Z][A-Z0-9_]* *$/.test(v) ? null : `needs ${item} as the expression and the other item's name as the value`;
  if (type === 'item_in_list' || type === 'item_not_in_list')
    return ITEM.test(e) && v !== '' && v.length <= 4000 ? null : `needs ${item} as the expression and the list (at most 4000 characters) as the value`;
  if (type === 'item_contains')
    return ITEM.test(e) && v.trim() !== '' && v.length <= 4000 && !v.includes(':') ? null : `needs ${item} as the expression and a value without ":" (at most 4000 characters)`;
  if (type === 'item_contains_any')
    return ITEM.test(e) && /[^:\s]/.test(v) && v.length <= 4000 ? null : `needs ${item} as the expression and the values (at most 4000 characters)`;
  if (type === 'request_in' || type === 'request_not_in')
    return /^ *[A-Z][A-Z0-9_]* *(, *[A-Z][A-Z0-9_]* *)*$/.test(v) ? null : 'needs the button names (upper case, separated by commas) as the value';
  if (type === 'page_in' || type === 'page_not_in') return /^ *[0-9]{1,9} *(, *[0-9]{1,9} *)*$/.test(v) ? null : 'needs page numbers separated by commas as the value';
  if (type === 'language_in' || type === 'language_not_in')
    return /^ *[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})? *(, *[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})? *)*$/.test(v) ? null : 'needs language codes separated by commas (e.g. en, nl-BE) as the value';
  if (['page_is_dialog', 'page_is_not_dialog', 'user_signed_in', 'user_public', 'always', 'never'].includes(type)) return null;
  if (known.includes(type)) return null;
  return `is not a condition type; the condition types are ${known.join(', ')}`;
}

// ------------------------------------------------------------------ values of a column's type

const INT = /^\s*[+-]?(?:\d+(?:_\d+)*|0[xX][0-9a-fA-F]+(?:_[0-9a-fA-F]+)*|0[oO][0-7]+(?:_[0-7]+)*|0[bB][01]+(?:_[01]+)*)\s*$/;
const NUM = /^\s*[+-]?(?:(?:\d+(?:_\d+)*)(?:\.(?:\d+(?:_\d+)*)?)?|\.\d+(?:_\d+)*)(?:[eE][+-]?\d+)?\s*$/;
const SPECIAL = /^\s*[+-]?(?:nan|inf|infinity)\s*$/i;
const RANGE: Record<string, bigint> = { smallint: 32767n, integer: 2147483647n, bigint: 9223372036854775807n };

/** The text PostgreSQL casts a JSON value from (jsonb_populate_record): a string as it is, anything else as JSON. */
const textOf = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

/** Whether jsonb_populate_record accepts the JSON value for a column of the type (null: it does), and why not. */
export function castProblem(type: string, v: unknown): 'syntax' | 'range' | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return 'syntax';
  const s = textOf(v);
  if (type === 'boolean') {
    if (typeof v === 'boolean') return null;
    const b = s.trim().toLowerCase();
    if (b === '1' || b === '0') return null;
    const words = ['true', 'false', 'yes', 'no', 'on', 'off'];
    return b && words.some((w) => w.startsWith(b)) && b !== 'o' ? null : 'syntax';
  }
  if (typeof v === 'boolean') return 'syntax';
  if (type in RANGE) {
    if (!INT.test(s)) return 'syntax';
    const t = s.trim().replace(/_/g, '');
    const neg = t.startsWith('-');
    const n = BigInt(t.replace(/^[+-]/, ''));
    return n > RANGE[type] + (neg ? 1n : 0n) ? 'range' : null;
  }
  // numeric takes 0x1F and 1_000 (PostgreSQL 16+); a float takes 0x1F (strtod) but no underscores
  if ((type === 'real' || type === 'double precision') && s.includes('_')) return 'syntax';
  return INT.test(s) || NUM.test(s) || SPECIAL.test(s) ? null : 'syntax';
}

// ------------------------------------------------------------------ checking a document

const kind = (table: string) => table.replace(/_/g, ' ');
const plural = (k: string) => (/(ch|sh|s|x)$/.test(k) ? `${k}es` : `${k}s`);
const show = (v: unknown) => (typeof v === 'string' ? JSON.stringify(v.length > 80 ? `${v.slice(0, 80)}…` : v) : JSON.stringify(v));
const pageNoOf = (scope: object | null, table: string, row: any) => {
  const n = Number((table === 'page' ? row : scope as any)?.page_no);
  return scope || table === 'page' ? (Number.isFinite(n) ? n : null) : null;
};

function problem(row: any, table: string, label: string, scope: object | null, key: string, rule: string, message: string): ImportProblem {
  return { file: sourceOf(row) ?? null, label, table, key, rule, message, pageNo: pageNoOf(scope, table, row) };
}

const TAKES: Record<string, string> = {
  smallint: 'a whole number', integer: 'a whole number', bigint: 'a whole number', numeric: 'a number', real: 'a number',
  'double precision': 'a number', boolean: 'true or false',
};

/** A hint for a substitution or bind variable where a number is expected. */
function castHint(v: unknown) {
  if (typeof v !== 'string') return '';
  if (/&[A-Z][A-Z0-9_$#]*\./.test(v) || /^:[A-Z][A-Z0-9_$#]*$/.test(v.trim()))
    return ' A substitution (&ITEM.) or bind variable (:ITEM) is not evaluated in this property: give the value itself.';
  return '';
}

/** What an allowed-values check wants, with the tables that have the value when this one doesn't (a process point). */
function enumHint(schema: ImportSchema, table: string, column: string, value: string, values: string[]) {
  const lower = values.find((x) => x.toLowerCase() === value.toLowerCase().trim());
  if (lower) return ` Did you mean "${lower}"?`;
  const POINTS: Record<string, string> = { before_header: 'load', after_header: 'load', on_load: 'load', after_submit: 'submit', on_submit: 'submit', on_demand: 'ajax' };
  const others = [...new Set(schema.enums.filter((e) => e.table !== table && e.column === column && e.values.includes(value)).map((e) => kind(e.table)))];
  let hint = '';
  if (others.length) hint += ` "${value}" is the ${column} of ${others.map(plural).join(', ').replace(/, ([^,]*)$/, ' and $1')}, not of a ${kind(table)}.`;
  if (table === 'process' && column === 'point' && POINTS[value] && values.includes(POINTS[value]))
    hint += ` A process that runs ${POINTS[value] === 'load' ? 'when the page is shown' : POINTS[value] === 'submit' ? 'when the page is submitted' : 'when JavaScript calls it'} has point "${POINTS[value]}".`;
  return hint;
}

/** Every problem of the document the schema shows, without importing it. The document is not changed. */
export function checkImportDoc(doc: Doc, schema: ImportSchema): ImportProblem[] {
  const out: ImportProblem[] = [];
  const enums = new Map<string, ImportSchema['enums']>();
  for (const e of schema.enums) enums.set(e.table, [...(enums.get(e.table) ?? []), e]);
  const conds = new Map<string, ImportSchema['conditions']>();
  for (const c of schema.conditions) conds.set(c.table, [...(conds.get(c.table) ?? []), c]);
  const uniques = new Map<string, Map<string, ImportProblem[]>>();
  for (const { table, row, label, scope } of rowsOf(doc)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const at = (key: string, rule: string, message: string) => out.push(problem(row, table, label, scope, key, rule, message));
    // values of the column's type
    for (const [col, type] of Object.entries(schema.types[table] ?? {})) {
      if (!(col in row)) continue;
      const p = castProblem(type, row[col]);
      if (p === 'syntax') at(col, 'type', `"${col}" is ${show(row[col])}: meta.${table}.${col} takes ${TAKES[type] ?? `a ${type}`}.${castHint(row[col])}`);
      else if (p === 'range') at(col, 'type', `"${col}" is ${show(row[col])}, out of range for meta.${table}.${col} (${type}).`);
    }
    // allowed values
    for (const e of enums.get(table) ?? []) {
      const v = row[e.column];
      if (v === null || v === undefined || (typeof v !== 'object' && e.values.includes(textOf(v)))) continue;
      at(e.column, e.name, `"${e.column}" is ${show(v)}; meta.${table}.${e.column} allows ${e.values.join(', ')}.${enumHint(schema, table, e.column, textOf(v), e.values)}`);
    }
    // conditions (meta.condition_ok)
    for (const c of conds.get(table) ?? []) {
      const expr = row[c.expr];
      let type: unknown = row[c.type];
      if ((type === null || type === undefined) && c.implicitSql && expr !== null && expr !== undefined && String(expr).trim() !== '') type = 'sql';
      if (type !== null && type !== undefined && typeof type !== 'string') continue; // the type check above reports it
      const why = conditionProblem((type as string | undefined) ?? null, expr, row[c.value], schema.conditionTypes);
      if (why) at(c.type, c.name, `"${c.type}" is ${show(type)}: it ${why} ("${c.expr}"${row[c.expr] != null ? ` is ${show(row[c.expr])}` : ' is empty'}${row[c.value] != null ? `, "${c.value}" is ${show(row[c.value])}` : ''}).`);
    }
    // unique keys within the document (the database's own rows can only be seen by the import)
    for (const u of schema.uniques) {
      if (u.table !== table) continue;
      const cols = u.columns.filter((c) => c !== 'app_id' && c !== 'page_id');
      if (!cols.length || cols.some((c) => c === 'id' || c.endsWith('_id') || !(c in row) || row[c] === null || row[c] === undefined)) continue;
      // a page's key is the page; the application's components have one scope
      const key = `${u.name}\u0000${cols.map((c) => textOf(row[c])).join('\u0000')}`;
      const byScope = uniques.get(key) ?? new Map<string, ImportProblem[]>();
      uniques.set(key, byScope);
      const s = scope ? `page ${String((scope as any).page_no)}#${pagesIndex(doc, scope)}` : 'app';
      byScope.set(s, [...(byScope.get(s) ?? []), problem(row, table, label, scope, cols.join(', '), u.name,
        cols.map((c) => `${cols.length > 1 ? `"${c}" ` : ''}${show(row[c])}`).join(', '))]);
    }
  }
  for (const [key, byScope] of uniques) {
    const name = key.split('\u0000')[0];
    for (const same of byScope.values()) {
      if (same.length < 2) continue;
      const first = same[0];
      const where = same.map((p) => (p.file ? `${p.file} (${p.label})` : p.label));
      const scope = first.pageNo !== null && first.table !== 'page' ? ` on page ${first.pageNo}` : ' in the application';
      const cols = first.key.split(', ');
      out.push({
        ...first, whole: true,
        message: `${same.length} ${plural(kind(first.table))} have the ${cols.length > 1 ? `${cols.join(', ')}` : cols[0]} ${first.message}${scope}: ` +
          `${where.join(' and ')}; the unique key ${name} allows one. Rename or remove one of them.`,
      });
    }
  }
  return out;
}

const pageIdx = new WeakMap<object, number>();
function pagesIndex(doc: Doc, page: object) {
  if (!pageIdx.has(page)) (doc.pages as object[]).forEach((p, i) => pageIdx.set(p, i));
  return pageIdx.get(page) ?? -1;
}

/** A problem as one line: the file and component first. */
export function formatProblem(p: ImportProblem) {
  return p.whole ? p.message : `${p.file ? `${p.file} (${p.label})` : p.label}: ${p.message}`;
}

/** Problems as an error text (at most ten, then how many more). */
export function formatProblems(problems: ImportProblem[], lead = 'The import was refused, nothing changed') {
  const lines = problems.slice(0, 10).map((p) => `  - ${formatProblem(p)}`);
  if (problems.length > 10) lines.push(`  (and ${problems.length - 10} more)`);
  return `${lead}:\n${lines.join('\n')}`;
}

// ------------------------------------------------------------------ explaining an import's error

const CAST = /^invalid input syntax for type ([a-z ]+): "([\s\S]*)"$/;
const RANGE_MSG = /^value "([\s\S]*)" is out of range for type ([a-z ]+)$/;

/**
 * An error of meta.import_app() (or of an import --replace) as a text that names the file, the component and the key,
 * or null when it is none of these (the caller rethrows it). With db, a check constraint that doesn't list values is
 * evaluated on the document's rows of its table to find the one that fails (run it after the import's rollback).
 * Never uses the error's DETAIL, which may show another application's row.
 */
export async function explainImportError(e: unknown, doc: Doc, o: { schema?: ImportSchema; db?: Q } = {}): Promise<string | null> {
  const err = e as { code?: string; message?: string; schema?: string; table?: string; constraint?: string };
  if (!err || typeof err !== 'object' || !err.code || !doc || typeof doc !== 'object') return null;
  if (err.code === '23502') {
    const { explainNotNull } = await import('./import-defaults.ts');
    return explainNotNull(e, doc);
  }
  if (!['22P02', '22003', '22007', '22008', '23505', '23514'].includes(err.code)) return null;
  let schema = o.schema;
  if (!schema) {
    try {
      schema = o.db ? await loadImportSchema(o.db) : bundledImportSchema();
    } catch {
      schema = bundledImportSchema();
    }
  }
  const all = checkImportDoc(doc, schema);
  let relevant: ImportProblem[] = [];
  const msg = String(err.message ?? '');
  if (err.code === '23505' || err.code === '23514') {
    if (err.schema && err.schema !== 'meta') return null;
    relevant = all.filter((p) => p.rule === err.constraint);
    if (!relevant.length && err.code === '23514' && err.table && err.constraint && o.db) relevant = await failingRows(o.db, doc, err.table, err.constraint);
    if (!relevant.length) {
      const what = err.table ? `${/^[aeiou]/.test(err.table) ? 'an' : 'a'} ${kind(err.table)}` : 'a component';
      const lead = err.code === '23505'
        ? `${what} has the same ${uniqueColumns(schema, err.constraint)} as one that is already in the database (unique key ${err.constraint}); ` +
          'none of the files has it twice. Give it another value'
        : `${what} is refused by the check constraint ${err.constraint}${err.table ? ` of meta.${err.table}` : ''}`;
      return all.length ? formatProblems(all, lead) : `${lead}.`;
    }
  } else {
    // a value that doesn't cast: the error names the type and the value, not the column
    const m = CAST.exec(msg) ?? null;
    const r = RANGE_MSG.exec(msg);
    const type = m ? m[1] : r ? r[2] : null;
    const literal = m ? m[2] : r ? r[1] : null;
    if (type === null || literal === null) return null;
    relevant = all.filter((p) => p.rule === 'type' && literal === textOf(valueAt(doc, p)));
    if (!relevant.length) relevant = byValue(doc, literal, `is not a valid ${type} value`);
    if (!relevant.length) return null;
  }
  const rest = all.filter((p) => !relevant.includes(p));
  return formatProblems([...relevant, ...rest]);
}

function uniqueColumns(schema: ImportSchema, name: string | undefined) {
  const u = schema.uniques.find((x) => x.name === name);
  const cols = u?.columns.filter((c) => c !== 'app_id' && c !== 'page_id') ?? [];
  return cols.length ? cols.join(', ') : 'key';
}

/** The value a problem names (its row's key), for matching a cast error's text. */
function valueAt(doc: Doc, p: ImportProblem) {
  for (const { table, row, label } of rowsOf(doc)) if (table === p.table && label === p.label && (sourceOf(row) ?? null) === p.file && p.key in row) return row[p.key];
  return undefined;
}

/** The keys of the document whose value is this text (a cast error of a type the schema doesn't list: a date …). */
function byValue(doc: Doc, literal: string, why: string): ImportProblem[] {
  const out: ImportProblem[] = [];
  for (const { table, row, label, scope } of rowsOf(doc)) {
    if (!row || typeof row !== 'object') continue;
    for (const [k, v] of Object.entries(row))
      if (v !== null && typeof v !== 'object' && textOf(v) === literal && k !== 'name' && k !== 'label' && k !== 'title')
        out.push(problem(row, table, label, scope, k, 'type', `"${k}" is ${show(v)}, which ${why} for meta.${table}.${k}.${castHint(v)}`));
  }
  return out.slice(0, 10);
}

/**
 * The document's rows of a table that a check constraint refuses, evaluated by PostgreSQL itself (each row read with
 * jsonb_populate_record, as meta.import_app does). The constraint is meta's own (its name is looked up in the
 * catalog, never taken as SQL); a row that doesn't even read is skipped (its cast error is reported elsewhere).
 */
async function failingRows(db: Q, doc: Doc, table: string, constraint: string): Promise<ImportProblem[]> {
  if (!TABLES.includes(table)) return [];
  const def = (await db.query(
    `select pg_get_constraintdef(k.oid) as def from pg_constraint k join pg_class c on c.oid = k.conrelid
      where c.relnamespace = 'meta'::regnamespace and c.relname = $1 and k.conname = $2 and k.contype = 'c'`, [table, constraint]).catch(() => ({ rows: [] }))).rows[0]?.def as string | undefined;
  const expr = def ? /^CHECK \(([\s\S]*)\)$/.exec(def)?.[1] : undefined;
  if (!expr) return [];
  const cols = [...new Set([...expr.matchAll(/"?\b([a-z_][a-z0-9_]*)\b"?/g)].map((m) => m[1]))];
  const out: ImportProblem[] = [];
  for (const { table: t, row, label, scope } of rowsOf(doc)) {
    if (t !== table || !row || typeof row !== 'object') continue;
    const ok = await db.query(`select (${expr}) is not false as ok from jsonb_populate_record(null::meta.${table}, $1::jsonb) as r`, [JSON.stringify(row)])
      .then((r) => r.rows[0]?.ok !== false, () => true);
    if (ok) continue;
    const given = cols.filter((c) => c in row && row[c] !== null).map((c) => `"${c}" is ${show(row[c])}`);
    out.push(problem(row, table, label, scope, cols.find((c) => c in row) ?? '', constraint,
      `refused by meta.${table}'s check ${constraint}: ${def}${given.length ? ` (${given.join(', ')})` : ''}.`));
    if (out.length >= 10) break;
  }
  return out;
}
