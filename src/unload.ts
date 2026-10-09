import type pg from 'pg';
import type { Client } from './db.ts';
import { csvField, DOWNLOAD_MAX_ROWS, isNumeric, xlsxCell } from './runtime/report.ts';
import { splitScript } from './sqlscript.ts';
import { esc, XLSX_TYPE, XlsxWriter, xlsxWidths, type XlsxCell } from './xlsx.ts';

// SQL Workshop → Unload Data (APEX's Data Workshop → Unload Data): a table,
// a view or a query to CSV, JSON, Excel or XML. The rows come from a cursor
// (DECLARE … FETCH), a batch at a time, and each batch is written out before
// the next is read, so memory stays flat whatever the size (the same scheme
// as streamed report downloads, up to DOWNLOAD_MAX_ROWS). Values arrive as
// Postgres's own text (no JavaScript conversion), so numbers, timestamps and
// bytea are exact. The builder runs it in a read-only transaction with a
// statement timeout (builder/unload.ts).

export type UnloadFormat = 'csv' | 'json' | 'xlsx' | 'xml';
export const UNLOAD_FORMATS: UnloadFormat[] = ['csv', 'json', 'xlsx', 'xml'];

export interface UnloadOptions {
  format: UnloadFormat;
  /** CSV */
  delimiter: string;
  enclosure: string;
  header: boolean;
  /** CSV: a UTF-8 byte order mark (Excel then reads UTF-8) */
  bom: boolean;
  /** XML: the root element and the element of each row */
  rootTag: string;
  rowTag: string;
  /** Excel: the sheet name */
  sheet: string;
}

export const DEFAULT_UNLOAD: UnloadOptions = { format: 'csv', delimiter: ',', enclosure: '"', header: true, bom: true, rootTag: 'ROWSET', rowTag: 'ROW', sheet: 'Data' };

export const CSV_DELIMITERS: Record<string, string> = { comma: ',', semicolon: ';', tab: '\t', pipe: '|' };
export const CSV_ENCLOSURES: Record<string, string> = { double: '"', single: "'" };

export const UNLOAD_TYPES: Record<UnloadFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  json: 'application/json; charset=utf-8',
  xlsx: XLSX_TYPE,
  xml: 'application/xml; charset=utf-8',
};

export class UnloadError extends Error {}

/** Rows fetched from the cursor at a time. */
const BATCH = 1000;
/** Excel's sheet holds 1,048,576 rows, one of them the heading. */
const XLSX_MAX_ROWS = 1_048_575;

/** An element name the developer chose (XML root / row): a plain XML name, not starting with "xml". */
export const validTag = (s: string) => /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(s) && !/^xml/i.test(s);

/** A column name as an XML element name: other characters become _, and it starts with a letter or _. */
export function xmlName(col: string) {
  let n = col.replace(/[^A-Za-z0-9_.-]/g, '_');
  if (!/^[A-Za-z_]/.test(n) || /^xml/i.test(n)) n = `_${n}`;
  return n;
}

/**
 * The statement to unload: exactly one SELECT (or WITH / VALUES / TABLE)
 * statement; a trailing semicolon and leading comments are dropped. Anything
 * else is refused (the read-only transaction is a second line of defence).
 */
export function unloadStatement(sql: string): string {
  const statements = splitScript(sql);
  if (statements.length !== 1 || statements[0].psql) throw new UnloadError('Enter exactly one SELECT statement.');
  const s = statements[0].sql;
  if (!/^\(*\s*(select|with|values|table)\b/i.test(s)) throw new UnloadError('Only a SELECT (or WITH … SELECT) statement can be unloaded.');
  return s;
}

/** Postgres text values for every type: no parsing into JavaScript values. */
const RAW_TYPES = { getTypeParser: () => (v: string) => v } as unknown as pg.CustomTypesConfig;

const BOOL = 16;
const JSON_OIDS = new Set([114, 3802]);
const JSON_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;

/** A value (Postgres text) as JSON: numbers stay numbers, json stays json, booleans are true/false. */
export function jsonValue(v: string | null, oid: number) {
  if (v === null) return 'null';
  if (oid === BOOL) return v === 't' ? 'true' : 'false';
  if (JSON_OIDS.has(oid)) return v;
  if (isNumeric(oid) && JSON_NUMBER.test(v)) return v;
  return JSON.stringify(v);
}

/** A value as text for CSV and XML (booleans as true/false). */
const textValue = (v: string, oid: number) => (oid === BOOL ? (v === 't' ? 'true' : 'false') : v);

/** A value as an Excel cell (numbers, booleans and dates keep their type). */
const excelValue = (v: string | null, oid: number): XlsxCell => (v === null ? null : oid === BOOL ? v === 't' : xlsxCell(v, oid));

/** XML element text; a carriage return becomes &#13; so a parser doesn't normalise it away. */
const xmlText = (s: string) => esc(s).replace(/\r/g, '&#13;');

type Row = (string | null)[];

/** The output of one format: a beginning, each batch of rows, an end. */
interface Encoder {
  start(rows: Row[]): string | Uint8Array[];
  rows(rows: Row[]): string | Uint8Array[];
  end(): string | Uint8Array[];
}

function encoder(o: UnloadOptions, fields: pg.FieldDef[]): Encoder {
  const names = fields.map((f) => f.name);
  const oids = fields.map((f) => f.dataTypeID);
  switch (o.format) {
    case 'csv': {
      const line = (cells: string[]) => `${cells.join(o.delimiter)}\r\n`;
      const field = (v: string | null, i: number) => (v === null ? '' : csvField(textValue(v, oids[i]), isNumeric(oids[i]), o.delimiter, o.enclosure));
      const rows = (rows: Row[]) => rows.map((r) => line(r.map(field))).join('');
      return {
        start: (first) => `${o.bom ? '﻿' : ''}${o.header ? line(names.map((n) => csvField(n, false, o.delimiter, o.enclosure))) : ''}${rows(first)}`,
        rows,
        end: () => '',
      };
    }
    case 'json': {
      const keys = names.map((n) => JSON.stringify(n));
      let n = 0;
      const rows = (rows: Row[]) => rows.map((r) => `${n++ ? ',' : ''}\n{${r.map((v, i) => `${keys[i]}:${jsonValue(v, oids[i])}`).join(',')}}`).join('');
      return { start: (first) => `[${rows(first)}`, rows, end: () => (n ? '\n]\n' : ']\n') };
    }
    case 'xml': {
      const tags = names.map(xmlName);
      const rows = (rows: Row[]) =>
        rows
          .map((r) => ` <${o.rowTag}>${r.map((v, i) => (v === null ? '' : `<${tags[i]}>${xmlText(textValue(v, oids[i]))}</${tags[i]}>`)).join('')}</${o.rowTag}>\n`)
          .join('');
      return {
        start: (first) => `<?xml version="1.0" encoding="UTF-8"?>\n<${o.rootTag}>\n${rows(first)}`,
        rows,
        end: () => `</${o.rootTag}>\n`,
      };
    }
    case 'xlsx': {
      let pending: Uint8Array[] = [];
      let xlsx: XlsxWriter;
      const cells = (rows: Row[]) => rows.map((r) => r.map((v, i) => excelValue(v, oids[i])));
      const take = () => pending.splice(0);
      return {
        start: (first) => {
          const data = cells(first);
          xlsx = new XlsxWriter((chunk) => pending.push(chunk), o.sheet, names, xlsxWidths(names, data.slice(0, 500)));
          xlsx.rows(data);
          return take();
        },
        rows: (rows) => {
          xlsx.rows(cells(rows));
          return take();
        },
        end: () => {
          xlsx.end();
          const out = take();
          pending = [];
          return out;
        },
      };
    }
  }
}

/**
 * Open the cursor for `sql` on `c` (which must be inside a transaction) and
 * read the first batch, so a failing query fails before anything is sent.
 * Returns the columns and `send`, which writes the whole file through `write`
 * (awaited: back pressure) and closes the cursor. At most `maxRows` rows.
 */
export async function openUnload(c: Client, sql: string, o: UnloadOptions, maxRows = DOWNLOAD_MAX_ROWS) {
  const limit = Math.max(1, Math.min(maxRows, o.format === 'xlsx' ? XLSX_MAX_ROWS : maxRows));
  const cursor = 'pgkiln_unload';
  await c.query(`declare ${cursor} no scroll cursor for ${sql}`);
  let left = limit;
  const next = async (): Promise<pg.QueryResult<Row>> => {
    const n = Math.min(BATCH, left);
    const res = await c.query<Row>({ text: `fetch ${n} from ${cursor}`, rowMode: 'array', types: RAW_TYPES });
    left -= res.rows.length;
    return res;
  };
  const first = await next();
  const fields = first.fields;
  return {
    fields,
    async send(write: (chunk: string | Uint8Array) => Promise<void>) {
      const enc = encoder(o, fields);
      const out = async (x: string | Uint8Array[]) => {
        if (typeof x === 'string') {
          if (x) await write(x);
        } else for (const chunk of x) await write(chunk);
      };
      await out(enc.start(first.rows));
      let got = first.rows.length;
      while (got === BATCH && left > 0) {
        const res = await next();
        got = res.rows.length;
        await out(enc.rows(res.rows));
      }
      await c.query(`close ${cursor}`);
      await out(enc.end());
    },
  };
}

/** A whole unload in memory (tests, small results). */
export async function unloadToBuffer(c: Client, sql: string, o: UnloadOptions, maxRows?: number) {
  const chunks: Buffer[] = [];
  const u = await openUnload(c, sql, o, maxRows);
  await u.send(async (chunk) => {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
  });
  return Buffer.concat(chunks);
}
