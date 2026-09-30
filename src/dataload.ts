import pg from 'pg';
import { readSheet } from 'read-excel-file/node';
import { savepoint, type Client } from './db.ts';

// Data loading: CSV/TSV and XLSX files into a table. Used by the SQL
// Workshop (as the owner) and by the data_load page process (as the
// application's role, so row level security and grants apply).

const ident = pg.escapeIdentifier;

export interface Sheet {
  format: 'csv' | 'xlsx';
  delimiter?: string;
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

function cellText(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) {
    const iso = v.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.replace('T', ' ').replace(/\.000Z$|Z$/, '');
  }
  return String(v);
}

/** Parse an uploaded file; the first row holds the column headings unless `headers` is false. */
export async function parseFile(filename: string, data: Buffer, { headers = true } = {}): Promise<Sheet> {
  let format: Sheet['format'] = 'csv';
  let delimiter: string | undefined;
  let table: (string | null)[][];
  if (/\.xlsx$/i.test(filename) || isZip(data)) {
    format = 'xlsx';
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
  table = table.filter((r) => r.some((v) => v !== null));
  if (!table.length) throw new LoadError('The file contains no data.');
  const width = Math.max(...table.map((r) => r.length));
  const head = headers ? table.shift()! : [];
  const names = Array.from({ length: width }, (_, i) => (head[i] ?? '').trim() || `column_${i + 1}`);
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

// ---------------------------------------------------------------- loading

export type LoadMode = 'append' | 'replace' | 'merge';

export interface LoadOptions {
  /** a table name that resolves with regclass */
  table: string;
  /** file column index → table column */
  columns: { index: number; column: string }[];
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
  const insert = async (rows: (string | null)[][]) => {
    const values = rows.map((_, r) => `(${opts.columns.map((_, i) => `$${r * width + i + 1}`).join(', ')})`).join(', ');
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
