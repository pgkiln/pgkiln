import pg from 'pg';
import { readSheet } from 'read-excel-file/node';
import { savepoint, type Client } from './db.ts';
import { XmlError, xmlTable } from './xml.ts';

// Data loading: CSV/TSV, XLSX, JSON and XML files into a table. Used by the SQL
// Workshop (as the owner) and by the data_load page process (as the
// application's role, so row level security and grants apply).

const ident = pg.escapeIdentifier;

export interface Sheet {
  format: 'csv' | 'xlsx' | 'json' | 'xml';
  delimiter?: string;
  /** XML: the path of the row elements */
  rowPath?: string;
  headers: string[];
  rows: (string | null)[][];
}

export class LoadError extends Error {}

export const MAX_ROWS = Number(process.env.DATA_LOAD_MAX_ROWS ?? 100_000);
const MAX_ERRORS = 100;

// ---------------------------------------------------------------- parsing

const DELIMITERS = [',', ';', '\t', '|'];

/** The delimiter that splits the first line into the most fields (outside quotes). */
export function detectDelimiter(text: string) {
  const counts = new Map(DELIMITERS.map((d) => [d, 0]));
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    else if (!quoted && counts.has(ch)) counts.set(ch, counts.get(ch)! + 1);
  }
  let best = ',';
  for (const [d, n] of counts) if (n > counts.get(best)!) best = d;
  return best;
}

/** RFC 4180 CSV: quoted fields with "" escapes and line breaks, CRLF or LF. */
export function parseCsv(text: string, delimiter = detectDelimiter(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const endRow = () => {
    row.push(field);
    field = '';
    // skip completely empty lines
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n') endRow();
    else if (ch === '\r') {
      endRow();
      if (text[i + 1] === '\n') i++;
    } else field += ch;
    i++;
  }
  if (field !== '' || row.length) endRow();
  return rows;
}

/** UTF-8 (with or without BOM), falling back to Windows-1252 for older Excel exports. */
function decode(data: Buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data).replace(/^\uFEFF/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(data);
  }
}

const isZip = (data: Buffer) => data.length > 3 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04;

export function cellText(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) {
    const iso = v.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.replace('T', ' ').replace(/\.000Z$|Z$/, '');
  }
  return String(v);
}

/**
 * JSON: an array of objects, an object with one such array (e.g. {"employees": [...]}),
 * or JSON Lines (one object per line). The columns are the keys, in the order they
 * first appear; nested objects and arrays load as JSON text (for json/jsonb columns).
 */
export function parseJson(text: string): Sheet {
  let records: unknown;
  const trimmed = text.trim();
  try {
    records = JSON.parse(trimmed);
  } catch (e) {
    // JSON Lines
    const lines = trimmed.split(/\r?\n/).filter((l) => l.trim());
    try {
      records = lines.map((l) => JSON.parse(l));
    } catch {
      throw new LoadError(`This is not valid JSON: ${(e as Error).message}`);
    }
  }
  if (records && typeof records === 'object' && !Array.isArray(records)) {
    const arrays = Object.values(records).filter(Array.isArray);
    records = arrays.length === 1 ? arrays[0] : [records];
  }
  if (!Array.isArray(records) || !records.length) throw new LoadError('The JSON holds no records (expected an array of objects).');
  if (records.length > MAX_ROWS) throw new LoadError(`The file has ${records.length} rows; at most ${MAX_ROWS} can be loaded at once.`);
  const headers: string[] = [];
  const seen = new Set<string>();
  for (const r of records) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new LoadError('Every JSON record must be an object ({"column": value, …}).');
    for (const k of Object.keys(r)) if (!seen.has(k)) (seen.add(k), headers.push(k));
  }
  const text_ = (v: unknown) => (v === null || v === undefined || v === '' ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));
  return { format: 'json', headers, rows: records.map((r) => headers.map((h) => text_((r as Record<string, unknown>)[h]))) };
}

export type FileFormat = 'auto' | 'csv' | 'xlsx' | 'json' | 'xml';

export interface ParseOptions {
  /** CSV/Excel: the first row holds the column headings (default true) */
  headers?: boolean;
  /** the format, instead of detecting it from the file name and content */
  format?: FileFormat | null;
  /** XML: the repeating row element ("employee" or "employees/employee"); detected when empty */
  rowTag?: string | null;
}

/** XML: rows from a repeating element; DTDs and entities are refused (src/xml.ts). */
export function parseXml(text: string, rowTag?: string | null): Sheet {
  try {
    const t = xmlTable(text, rowTag, { maxRows: MAX_ROWS });
    return { format: 'xml', rowPath: t.rowPath, headers: t.headers, rows: t.rows };
  } catch (e) {
    if (e instanceof XmlError) throw new LoadError(`This is not XML that can be loaded: ${e.message}`);
    throw e;
  }
}

/** Parse an uploaded file; the first row holds the column headings unless `headers` is false. */
export async function parseFile(filename: string, data: Buffer, { headers = true, format = 'auto', rowTag }: ParseOptions = {}): Promise<Sheet> {
  let delimiter: string | undefined;
  let table: (string | null)[][];
  const head = decode(data.subarray(0, 64)).replace(/^\uFEFF/, '');
  const auto = !format || format === 'auto';
  if (format === 'xml' || (auto && (/\.xml$/i.test(filename) || /^\s*<[?!A-Za-z_]/.test(head)))) {
    if (data.includes(0)) throw new LoadError('This is not a text (XML) file.');
    return parseXml(decode(data), rowTag);
  }
  if (format === 'json' || (auto && (/\.(json|jsonl|ndjson)$/i.test(filename) || /^\s*[[{]/.test(head)))) {
    if (data.includes(0)) throw new LoadError('This is not a text (JSON) file.');
    return parseJson(decode(data).replace(/^\uFEFF/, ''));
  }
  let fmt: Sheet['format'] = 'csv';
  if (format === 'xlsx' || (auto && (/\.xlsx$/i.test(filename) || isZip(data)))) {
    fmt = 'xlsx';
    try {
      const sheet = await readSheet<string>(data, { parseNumber: (s) => s, trim: true });
      table = sheet.map((r) => r.map(cellText));
    } catch (e) {
      throw new LoadError(`This is not a readable Excel (.xlsx) file: ${(e as Error).message}`);
    }
  } else {
    if (data.includes(0)) throw new LoadError('This is not a text (CSV) file. Upload CSV, TSV or .xlsx.');
    const text = decode(data);
    delimiter = /\.tsv$/i.test(filename) ? '\t' : detectDelimiter(text);
    table = parseCsv(text, delimiter).map((r) => r.map((v) => (v.trim() === '' ? null : v)));
  }
  return tableSheet(fmt, table, headers, delimiter);
}

/** Rows of cells (CSV or one Excel sheet) as a Sheet: empty rows dropped, the first row as headings when `headers`. */
export function tableSheet(format: Sheet['format'], table: (string | null)[][], headers: boolean, delimiter?: string): Sheet {
  table = table.filter((r) => r.some((v) => v !== null));
  if (!table.length) throw new LoadError('The file contains no data.');
  const width = Math.max(...table.map((r) => r.length));
  const first = headers ? table.shift()! : [];
  const names = Array.from({ length: width }, (_, i) => (first[i] ?? '').trim() || `column_${i + 1}`);
  if (table.length > MAX_ROWS) throw new LoadError(`The file has ${table.length} rows; at most ${MAX_ROWS} can be loaded at once.`);
  return { format, delimiter, headers: names, rows: table.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? null)) };
}

// ---------------------------------------------------------------- new tables

export type ColumnType = 'integer' | 'bigint' | 'numeric' | 'boolean' | 'date' | 'timestamp' | 'text';
export const COLUMN_TYPES: ColumnType[] = ['text', 'integer', 'bigint', 'numeric', 'boolean', 'date', 'timestamp'];

const INT = /^[-+]?\d+$/;
const NUM = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const BOOL = /^(true|false|t|f|yes|no|y|n)$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([+-]\d{2}(:?\d{2})?|Z)?$/;

/** The narrowest type that fits every value in the column (ISO dates only). */
export function inferType(values: (string | null)[]): ColumnType {
  const v = values.filter((x): x is string => x !== null).map((x) => x.trim());
  if (!v.length) return 'text';
  const all = (re: RegExp) => v.every((x) => re.test(x));
  if (all(INT)) return v.every((x) => Math.abs(Number(x)) <= 2_147_483_647) ? 'integer' : 'bigint';
  if (all(NUM)) return 'numeric';
  if (all(BOOL)) return 'boolean';
  if (all(DATE)) return 'date';
  if (v.every((x) => DATE.test(x) || TIMESTAMP.test(x))) return 'timestamp';
  return 'text';
}

/** A lower-case SQL identifier for a column heading ("Hire Date" → hire_date). */
export function columnName(heading: string, used: Set<string>) {
  let name =
    heading
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .replace(/ß/g, 'ss')
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60) || 'column';
  if (/^\d/.test(name)) name = `c_${name}`;
  let unique = name;
  for (let n = 2; used.has(unique); n++) unique = `${name}_${n}`;
  used.add(unique);
  return unique;
}

export interface NewColumn {
  index: number;
  name: string;
  type: ColumnType;
}

/** Suggested columns for a new table. */
export function suggestColumns(sheet: Sheet): NewColumn[] {
  const used = new Set<string>(['id']);
  return sheet.headers.map((h, index) => ({ index, name: columnName(h, used), type: inferType(sheet.rows.map((r) => r[index])) }));
}

/** CREATE TABLE with an identity primary key "id" and the given columns. */
export function createTableSql(table: string, columns: NewColumn[]) {
  const [schema, name] = table.includes('.') ? table.split('.', 2) : ['public', table];
  const valid = /^[a-z_][a-z0-9_]{0,62}$/;
  if (!valid.test(schema) || !valid.test(name)) throw new LoadError('Use a lower-case name: letters, digits and _, optionally with a schema (hr.imported_rows).');
  for (const c of columns) {
    if (!valid.test(c.name) || c.name === 'id') throw new LoadError(`"${c.name}" is not a valid column name.`);
    if (!COLUMN_TYPES.includes(c.type)) throw new LoadError(`Unknown column type ${c.type}.`);
  }
  if (new Set(columns.map((c) => c.name)).size !== columns.length) throw new LoadError('Column names must be unique.');
  return `create table ${ident(schema)}.${ident(name)} (\n  id bigint generated by default as identity primary key${columns.map((c) => `,\n  ${ident(c.name)} ${c.type}`).join('')}\n)`;
}

// ---------------------------------------------------------------- definitions

/** One column of a data load definition: where its value comes from and how it is changed. */
export interface LoadMapping {
  /** the file column (heading, XML element path or @attribute); empty: the default is loaded as a constant */
  source?: string | null;
  /** the table column */
  column: string;
  /** applied in order: trim, upper, lower, initcap, collapse_spaces, digits_only */
  transform?: string[] | string | null;
  /** to_date / to_timestamp / to_number format, e.g. DD.MM.YYYY or 9G999D99 */
  format?: string | null;
  /** used when the value is empty */
  default?: string | null;
}

/** A data load definition (meta.data_load_def). */
export interface DataLoadDefinition {
  name: string;
  table_name: string;
  format: FileFormat;
  headers: boolean;
  row_tag: string | null;
  mode: LoadMode;
  skip_errors: boolean;
  columns: LoadMapping[];
}

export const TRANSFORMS: Record<string, (v: string) => string> = {
  trim: (v) => v.trim(),
  upper: (v) => v.toUpperCase(),
  lower: (v) => v.toLowerCase(),
  initcap: (v) => v.toLowerCase().replace(/(^|[^\p{L}\p{N}])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase()),
  collapse_spaces: (v) => v.replace(/\s+/g, ' ').trim(),
  digits_only: (v) => v.replace(/\D+/g, ''),
};

const transforms = (t: LoadMapping['transform']) => (Array.isArray(t) ? t : t ? String(t).split(/[\s,]+/) : []).filter(Boolean);

/** What is wrong with a definition's columns (JSON from the builder), as messages. */
export function mappingProblems(columns: unknown): string[] {
  if (!Array.isArray(columns)) return ['Columns must be a JSON array: [{"source": "Name", "column": "name"}].'];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const [k, m] of columns.entries()) {
    const at = `Column mapping ${k + 1}`;
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      problems.push(`${at} must be an object.`);
      continue;
    }
    const x = m as Record<string, unknown>;
    for (const key of Object.keys(x)) if (!['source', 'column', 'transform', 'format', 'default'].includes(key)) problems.push(`${at}: unknown key "${key}".`);
    if (typeof x.column !== 'string' || !x.column.trim()) problems.push(`${at} needs a "column".`);
    else if (seen.has(x.column)) problems.push(`${at}: the column ${x.column} is mapped twice.`);
    else seen.add(x.column);
    if ((x.source === undefined || x.source === null || x.source === '') && (x.default === undefined || x.default === null)) problems.push(`${at} needs a "source" or a "default".`);
    for (const t of transforms(x.transform as LoadMapping['transform'])) if (!(t in TRANSFORMS)) problems.push(`${at}: unknown transformation "${t}" (use ${Object.keys(TRANSFORMS).join(', ')}).`);
    for (const key of ['source', 'format', 'default']) if (x[key] !== undefined && x[key] !== null && typeof x[key] !== 'string') problems.push(`${at}: "${key}" must be a string.`);
  }
  return problems;
}

/**
 * Apply a definition's mapping to a parsed file: the transformed values in
 * mapping order, and the columns to load them into. Sources are matched by
 * heading, then ignoring case, spaces and punctuation.
 */
export function applyMapping(sheet: Sheet, mapping: LoadMapping[]): { sheet: Sheet; columns: LoadOptions['columns'] } {
  const problems = mappingProblems(mapping);
  if (problems.length) throw new LoadError(problems.join(' '));
  const squash = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const index = mapping.map((m) => {
    if (!m.source) return -1;
    let i = sheet.headers.indexOf(m.source);
    if (i < 0) i = sheet.headers.findIndex((h) => squash(h) === squash(m.source!));
    if (i < 0) throw new LoadError(`The file has no column "${m.source}" (it has ${sheet.headers.slice(0, 20).join(', ')}${sheet.headers.length > 20 ? ', …' : ''}).`);
    return i;
  });
  const fns = mapping.map((m) => transforms(m.transform).map((t) => TRANSFORMS[t]));
  const rows = sheet.rows.map((r) =>
    mapping.map((m, k) => {
      let v = index[k] < 0 ? null : r[index[k]];
      if (v !== null) for (const f of fns[k]) v = f(v);
      if (v === null || v === '') v = m.default ?? null;
      return v;
    }),
  );
  return {
    sheet: { ...sheet, headers: mapping.map((m) => m.source || m.column), rows },
    columns: mapping.map((m, k) => ({ index: k, column: m.column, format: m.format || null })),
  };
}

/** Parse a file and load it with a definition, inside the caller's transaction. */
export async function loadWithDefinition(c: Client, def: DataLoadDefinition, file: { filename: string; content: Buffer }, opts: Pick<LoadOptions, 'describe'> = {}) {
  const sheet = await parseFile(file.filename, file.content, { headers: def.headers, format: def.format, rowTag: def.row_tag });
  let rows = sheet;
  let columns: LoadOptions['columns'];
  if (def.columns?.length) ({ sheet: rows, columns } = applyMapping(sheet, def.columns));
  else columns = autoMap(sheet.headers, await tableColumns(c, def.table_name));
  if (!columns.length) throw new LoadError(`No file column matches a column of ${def.table_name}.`);
  return loadRows(c, rows, {
    table: def.table_name,
    columns,
    mode: def.mode,
    skipErrors: def.skip_errors,
    firstRow: sheet.format === 'csv' || sheet.format === 'xlsx' ? (def.headers ? 2 : 1) : 1,
    describe: opts.describe,
  });
}

// ---------------------------------------------------------------- loading

export type LoadMode = 'append' | 'replace' | 'merge';

export interface LoadOptions {
  /** a table name that resolves with regclass */
  table: string;
  /** file column index → table column */
  columns: { index: number; column: string; format?: string | null }[];
  mode: LoadMode;
  /** load the good rows and report the others (otherwise nothing is loaded when a row fails) */
  skipErrors: boolean;
  /** file row number of sheet.rows[0], for messages (2 when the file has a heading row) */
  firstRow?: number;
  /** the message shown for a failed row (default: the database error) */
  describe?: (e: unknown) => string | Promise<string>;
}

export interface LoadResult {
  table: string;
  inserted: number;
  updated: number;
  failed: number;
  errors: { row: number; message: string }[];
}

export class LoadFailed extends LoadError {
  constructor(readonly result: LoadResult) {
    super(`${result.failed} row(s) could not be loaded; nothing was loaded.`);
  }
}

/** Columns of a table (in order), and its primary key. */
export async function tableColumns(c: Client, table: string) {
  const res = await c.query(
    `select a.attname as name, format_type(a.atttypid, a.atttypmod) as type,
            coalesce(a.attnum = any(i.indkey), false) as pk,
            a.attidentity = 'a' or a.attgenerated <> '' as generated
       from pg_attribute a
       left join pg_index i on i.indrelid = a.attrelid and i.indisprimary
      where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped
      order by a.attnum`,
    [table],
  );
  return res.rows as { name: string; type: string; pk: boolean; generated: boolean }[];
}

/** Map file headings onto table columns by name ("Hire date" → hiredate or hire_date). */
export function autoMap(headers: string[], columns: { name: string; generated: boolean }[]) {
  const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return headers.flatMap((h, index) => {
    const col = columns.find((c) => !c.generated && (c.name === h || squash(c.name) === squash(h)));
    return col ? [{ index, column: col.name }] : [];
  });
}

/**
 * Load the rows in batches, inside the caller's transaction. A batch that
 * fails is retried row by row to find the bad rows. Without skipErrors,
 * LoadFailed is thrown when any row fails: roll back the transaction.
 */
export async function loadRows(c: Client, sheet: Sheet, opts: LoadOptions): Promise<LoadResult> {
  const table = (await c.query('select $1::regclass::text as t', [opts.table])).rows[0].t as string;
  const result: LoadResult = { table, inserted: 0, updated: 0, failed: 0, errors: [] };
  if (!opts.columns.length) throw new LoadError('Map at least one column.');
  const cols = await tableColumns(c, table);
  for (const m of opts.columns)
    if (!cols.some((x) => x.name === m.column && !x.generated)) throw new LoadError(`Column "${m.column}" does not exist in ${table} or cannot be written.`);
  if (new Set(opts.columns.map((m) => m.column)).size !== opts.columns.length) throw new LoadError('Each table column can be used once.');

  let conflict = '';
  if (opts.mode === 'merge') {
    const key = cols.filter((x) => x.pk).map((x) => x.name);
    if (!key.length || !key.every((k) => opts.columns.some((m) => m.column === k)))
      throw new LoadError(`Merge updates rows by primary key: map ${key.length ? key.join(', ') : '(the table has no primary key)'}.`);
    const rest = opts.columns.filter((m) => !key.includes(m.column));
    conflict = ` on conflict (${key.map(ident).join(', ')}) do ${
      rest.length ? `update set ${rest.map((m) => `${ident(m.column)} = excluded.${ident(m.column)}`).join(', ')}` : 'nothing'
    }`;
  }
  if (opts.mode === 'replace') await c.query(`delete from ${table}`);

  const names = opts.columns.map((m) => ident(m.column)).join(', ');
  const width = opts.columns.length;
  const batchSize = Math.max(1, Math.min(500, Math.floor(30_000 / width)));
  const first = opts.firstRow ?? 1;
  // a format mask converts the text with to_date / to_timestamp / to_number (by the column's type)
  const wrap = opts.columns.map((m) => {
    if (!m.format) return (p: string) => p;
    const type = cols.find((x) => x.name === m.column)!.type;
    const fmt = pg.escapeLiteral(m.format);
    if (type === 'date') return (p: string) => `to_date(${p}, ${fmt})`;
    if (type.startsWith('timestamp')) return (p: string) => `to_timestamp(${p}, ${fmt})`;
    if (/^(numeric|integer|bigint|smallint|real|double precision)/.test(type)) return (p: string) => `to_number(${p}, ${fmt})`;
    throw new LoadError(`A format applies to date, timestamp and number columns; ${m.column} is ${type}.`);
  });
  const insert = async (rows: (string | null)[][]) => {
    const values = rows.map((_, r) => `(${opts.columns.map((_, i) => wrap[i](`$${r * width + i + 1}`)).join(', ')})`).join(', ');
    const params = rows.flatMap((row) => opts.columns.map((m) => row[m.index]));
    const res = await c.query(`insert into ${table} (${names}) values ${values}${conflict} returning (xmax = 0) as inserted`, params);
    for (const r of res.rows) r.inserted ? result.inserted++ : result.updated++;
  };

  for (let start = 0; start < sheet.rows.length; start += batchSize) {
    const batch = sheet.rows.slice(start, start + batchSize);
    try {
      await savepoint(c, () => insert(batch));
    } catch {
      for (const [i, row] of batch.entries()) {
        try {
          await savepoint(c, () => insert([row]));
        } catch (e) {
          result.failed++;
          if (result.errors.length < MAX_ERRORS)
            result.errors.push({ row: first + start + i, message: opts.describe ? await opts.describe(e) : (e as Error).message });
        }
      }
      if (!opts.skipErrors && result.errors.length >= MAX_ERRORS) break;
    }
  }
  if (result.failed && !opts.skipErrors) throw new LoadFailed(result);
  return result;
}
