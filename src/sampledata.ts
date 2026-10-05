import pg from 'pg';
import { zipSync, strToU8 } from 'fflate';
import type { Client } from './db.ts';
import { csvField } from './runtime/report.ts';
import {
  CITIES,
  COMPANY_KINDS,
  COMPANY_SUFFIXES,
  COMPANY_WORDS,
  COUNTRIES,
  EMAIL_DOMAINS,
  FIRST_NAMES,
  JOB_TITLES,
  LAST_NAMES,
  STREET_KINDS,
  STREETS,
  WORDS,
} from './sampledata-words.ts';

// SQL Workshop → Sample Data (APEX 26.1: Data Generator, "sample data for
// development"): realistic rows for one or more tables of a schema.
//
// - describe() reads the tables from the catalog: column types, identity /
//   serial / generated columns (skipped), NOT NULL, single-column unique
//   keys, simple CHECK constraints (ranges and value lists), enum labels and
//   foreign keys.
// - propose() suggests a generator per column from its name and type.
// - generateRows() makes the rows, deterministically from a seed: each
//   column has a random stream of its own (seeded by seed, table and column),
//   so changing one column does not change the others.
// - runGenerator() inserts the rows in one transaction, parents before
//   children (foreign keys pick existing parent rows and the rows just
//   inserted), and commits or rolls everything back (preview).
// - sqlScript() / csvFiles() write the rows as INSERT statements or CSV.
//
// Identifiers are always quoted (pg.escapeIdentifier) and values are always
// bound parameters, never SQL text; only the SQL download writes literals
// (pg.escapeLiteral).

export const GENERATORS = {
  skip: 'Skip (default / identity)',
  first_name: 'First name',
  last_name: 'Last name',
  full_name: 'Full name',
  email: 'E-mail address',
  username: 'User name',
  phone: 'Phone number',
  company: 'Company name',
  job_title: 'Job title',
  address: 'Street address',
  postal_code: 'Postal code',
  city: 'City',
  country: 'Country',
  word: 'Word',
  words: 'Words (title)',
  sentence: 'Sentence',
  code: 'Code (pattern)',
  url: 'Web address',
  uuid: 'UUID',
  integer: 'Whole number (range)',
  decimal: 'Decimal number (range)',
  date: 'Date (range)',
  timestamp: 'Timestamp (range)',
  time: 'Time of day (range)',
  boolean: 'Boolean (% true)',
  list: 'Value from a list',
  sequence: 'Sequence (start, step)',
  foreign_key: 'Foreign key (existing parent row)',
  fixed: 'Fixed value',
} as const;
export type GeneratorKind = keyof typeof GENERATORS;
export const isGenerator = (g: unknown): g is GeneratorKind => typeof g === 'string' && Object.hasOwn(GENERATORS, g);

/** What the Options field means per generator (shown as help). */
export const OPTION_HELP: Partial<Record<GeneratorKind, string>> = {
  words: 'number of words, e.g. 1..3',
  sentence: 'number of words, e.g. 4..12',
  code: 'pattern: A letter, a lower-case letter, 9 digit, other characters as typed, e.g. AAA-9999',
  integer: 'min..max, e.g. 1..1000; or another column plus a range, e.g. quantity + 0..10',
  decimal: 'min..max; the decimals of the column or of the numbers, e.g. 0.00..999.99; or column + min..max',
  date: 'from..to, e.g. 2021-01-01..2026-12-31; or another column plus days, e.g. start_date + 0..14',
  timestamp: 'from..to (dates), e.g. 2021-01-01..2026-12-31; or column + min..max days, e.g. created_at + 0..2',
  time: 'from..to, e.g. 08:00..18:00',
  boolean: 'percentage true, e.g. 50',
  list: 'values separated by commas, e.g. NEW, OPEN, CLOSED',
  sequence: 'start or start, step, e.g. 1000, 10',
  fixed: 'the value',
};

export interface ColumnSpec {
  column: string;
  generator: GeneratorKind;
  options: string;
  /** percentage of nulls, 0 to 100 */
  nulls: number;
}
export interface TableSpec {
  table: string;
  rows: number;
  columns: ColumnSpec[];
}
export interface GeneratorDef {
  schema: string;
  /** null: a random seed is chosen for each run */
  seed: number | null;
  tables: TableSpec[];
}

export interface ForeignKey {
  name: string;
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
}
export interface ColumnInfo {
  name: string;
  /** format_type(), e.g. "numeric(9,2)" */
  type: string;
  /** the base type's name (domains resolved), e.g. int4, numeric, varchar, timestamptz */
  base: string;
  /** an array type */
  array: boolean;
  notNull: boolean;
  default: string | null;
  /** why it is skipped by default: identity, generated, serial; null: generated */
  auto: 'identity' | 'generated' | 'serial' | null;
  /** identity GENERATED ALWAYS or a generated column: values can't be inserted at all */
  noInsert: boolean;
  maxLength: number | null;
  precision: number | null;
  scale: number | null;
  /** enum labels or values of a CHECK (col IN (…)) */
  values: string[] | null;
  /** bounds of a CHECK (col >= n …) */
  min: number | null;
  max: number | null;
  /** single-column primary key or unique constraint */
  unique: boolean;
  fk: ForeignKey | null;
  /** a CHECK (this >= other): proposed as other + a range */
  after: { column: string; strict: boolean } | null;
}
export interface TableInfo {
  schema: string;
  name: string;
  /** "schema"."table", quoted */
  qname: string;
  columns: ColumnInfo[];
  fks: ForeignKey[];
  /** estimated rows (pg_class.reltuples, -1 unknown) */
  estimate: number;
}

export class SampleDataError extends Error {}

export const MAX_ROWS = () => Math.max(1, Number(process.env.SAMPLE_DATA_MAX_ROWS) || 100_000);
export const MAX_TABLES = 50;
/** Rows of each table shown in the preview. */
export const PREVIEW_ROWS = 10;
/** Existing values of unique columns and parent keys read at most. */
const EXISTING_LIMIT = 200_000;

/** A schema whose tables can be filled: not pgapex's own (meta), not the system catalogs. */
export const allowedSchema = (s: string) => /^.{1,63}$/s.test(s) && !/^pg_/i.test(s) && !['meta', 'information_schema'].includes(s);

type Db = pg.ClientBase | pg.Pool;

/** Schemas with at least one ordinary table, the allowed ones only. */
export async function schemas(db: Db) {
  return (
    await db.query<{ name: string; tables: number }>(
      `select n.nspname as name, count(*)::int as tables from pg_namespace n join pg_class c on c.relnamespace = n.oid
        where c.relkind in ('r', 'p') and not c.relispartition and n.nspname !~ '^pg_' and n.nspname not in ('meta', 'information_schema')
        group by n.nspname order by n.nspname`,
    )
  ).rows;
}

/** The tables of a schema (not partitions), with an estimated row count. */
export async function schemaTables(db: Db, schema: string) {
  if (!allowedSchema(schema)) return [];
  return (
    await db.query<{ name: string; estimate: number }>(
      `select c.relname as name, c.reltuples::bigint as estimate from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1 and c.relkind in ('r', 'p') and not c.relispartition order by c.relname`,
      [schema],
    )
  ).rows.map((r) => ({ name: r.name, estimate: Number(r.estimate) }));
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** How Postgres prints a column name in a constraint definition. */
const printed = (name: string) => (/^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`);

/** Value list and bounds from a single-column CHECK constraint's definition (simple shapes only). */
const colPattern = (column: string) => `(?<![\\w"$])\\(*${escRe(printed(column))}\\)*(?:::[\\w ]+(?:\\[\\])?\\)*)?`;

/** A two-column CHECK such as end_date >= start_date: the column must not be below `other`. */
export function parseAfter(def: string, column: string, other: string) {
  const [c, o] = [colPattern(column), colPattern(other)];
  const m = new RegExp(`${c}\\s*(>=|>)\\s*${o}`).exec(def) ?? new RegExp(`${o}\\s*(<=|<)\\s*${c}`).exec(def);
  return m ? { column: other, strict: m[1].length === 1 } : null;
}

export function parseCheck(def: string, column: string) {
  const col = colPattern(column);
  const out: { values?: string[]; min?: number; max?: number } = {};
  const list = new RegExp(`${col}\\s*=\\s*ANY\\s*\\(+ARRAY\\[(.*?)\\]`, 'i').exec(def);
  if (list) {
    const quoted = [...list[1].matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
    out.values = quoted.length ? quoted : [...list[1].matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => m[0]);
  }
  for (const m of def.matchAll(new RegExp(`${col}\\s*(>=|>|<=|<)\\s*\\(?'?(-?\\d+(?:\\.\\d+)?)'?`, 'gi'))) {
    const n = Number(m[2]);
    if (m[1] === '>=') out.min = Math.max(out.min ?? -Infinity, n);
    if (m[1] === '>') out.min = Math.max(out.min ?? -Infinity, n + (Number.isInteger(n) ? 1 : 0.01));
    if (m[1] === '<=') out.max = Math.min(out.max ?? Infinity, n);
    if (m[1] === '<') out.max = Math.min(out.max ?? Infinity, n - (Number.isInteger(n) ? 1 : 0.01));
  }
  const len = new RegExp(`(?:char_)?length\\(${col}\\)\\s*(<=|<)\\s*(\\d+)`, 'i').exec(def);
  return { ...out, maxLength: len ? Number(len[2]) - (len[1] === '<' ? 1 : 0) : undefined };
}

/** A table's columns and constraints; undefined when the table is not in an allowed schema. */
export async function describe(db: Db, schema: string, table: string): Promise<TableInfo | undefined> {
  if (!allowedSchema(schema)) return undefined;
  const rel = (
    await db.query<{ oid: number; estimate: number }>(
      `select c.oid, c.reltuples::bigint as estimate from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1 and c.relname = $2 and c.relkind in ('r', 'p') and not c.relispartition`,
      [schema, table],
    )
  ).rows[0];
  if (!rel) return undefined;
  const cols = (
    await db.query(
      `select a.attnum, a.attname as name, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as not_null,
              a.attidentity as identity, a.attgenerated as generated, pg_get_expr(d.adbin, d.adrelid) as default,
              b.typname as base, b.typtype as base_kind, b.oid as base_oid, t.typcategory = 'A' as array,
              case when t.typtype = 'd' then t.typtypmod else a.atttypmod end as typmod,
              (select array_agg(e.enumlabel::text order by e.enumsortorder) from pg_enum e where e.enumtypid = b.oid) as labels
         from pg_attribute a
         join pg_type t on t.oid = a.atttypid
         join pg_type b on b.oid = case when t.typtype = 'd' then t.typbasetype else t.oid end
         left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        where a.attrelid = $1 and a.attnum > 0 and not a.attisdropped order by a.attnum`,
      [rel.oid],
    )
  ).rows;
  const byNum = new Map<number, string>(cols.map((c) => [c.attnum, c.name]));
  const cons = (
    await db.query(
      `select k.conname, k.contype, k.conkey, k.confkey, pg_get_constraintdef(k.oid) as def,
              fn.nspname as ref_schema, fc.relname as ref_table,
              (select array_agg(fa.attname::text order by x.i) from unnest(k.confkey) with ordinality x(n, i)
                 join pg_attribute fa on fa.attrelid = k.confrelid and fa.attnum = x.n) as ref_columns
         from pg_constraint k
         left join pg_class fc on fc.oid = k.confrelid
         left join pg_namespace fn on fn.oid = fc.relnamespace
        where k.conrelid = $1 and k.contype in ('p', 'u', 'c', 'f') order by k.conname`,
      [rel.oid],
    )
  ).rows;
  const fks: ForeignKey[] = cons
    .filter((k) => k.contype === 'f')
    .map((k) => ({ name: k.conname, columns: k.conkey.map((n: number) => byNum.get(n)!), refSchema: k.ref_schema, refTable: k.ref_table, refColumns: k.ref_columns }));
  const columns: ColumnInfo[] = cols.map((c) => {
    const typmod = Number(c.typmod);
    const numeric = c.base === 'numeric' && typmod >= 4;
    const varlen = ['varchar', 'bpchar'].includes(c.base) && typmod >= 4;
    const info: ColumnInfo = {
      name: c.name,
      type: c.type,
      base: c.base,
      array: c.array,
      notNull: c.not_null,
      default: c.default,
      auto: c.identity ? 'identity' : c.generated ? 'generated' : /^nextval\(/i.test(c.default ?? '') ? 'serial' : null,
      noInsert: c.identity === 'a' || !!c.generated,
      maxLength: varlen ? typmod - 4 : null,
      precision: numeric ? ((typmod - 4) >> 16) & 0xffff : null,
      scale: numeric ? (typmod - 4) & 0xffff : null,
      values: c.labels ?? null,
      min: null,
      max: null,
      unique: false,
      fk: null,
      after: null,
    };
    for (const k of cons) {
      if (k.contype === 'c' && k.conkey?.length === 2 && k.conkey.some((n: number) => byNum.get(n) === c.name)) {
        const other = byNum.get(k.conkey.find((n: number) => byNum.get(n) !== c.name))!;
        info.after ??= parseAfter(k.def, c.name, other);
      }
      if (k.conkey?.length !== 1 || byNum.get(k.conkey[0]) !== c.name) continue;
      if (k.contype === 'p' || k.contype === 'u') info.unique = true;
      if (k.contype === 'c') {
        const p = parseCheck(k.def, c.name);
        if (p.values?.length) info.values = p.values;
        if (p.min !== undefined) info.min = Math.max(info.min ?? -Infinity, p.min);
        if (p.max !== undefined) info.max = Math.min(info.max ?? Infinity, p.max);
        if (p.maxLength !== undefined) info.maxLength = Math.min(info.maxLength ?? Infinity, p.maxLength);
      }
    }
    info.fk = fks.find((f) => f.columns.includes(c.name)) ?? null;
    return info;
  });
  return { schema, name: table, qname: `${pg.escapeIdentifier(schema)}.${pg.escapeIdentifier(table)}`, columns, fks, estimate: Number(rel.estimate) };
}

// ------------------------------------------------------------------ proposals

const INT_TYPES: Record<string, [number, number]> = { int2: [-32768, 32767], int4: [-2147483648, 2147483647], int8: [-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER] };
const DEC_TYPES = new Set(['numeric', 'float4', 'float8', 'money']);
const TEXT_TYPES = new Set(['text', 'varchar', 'bpchar', 'citext', 'name']);
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** A generator for a column, from its constraints, type and name. today: the end of date ranges (deterministic tests). */
export function propose(c: ColumnInfo, today = new Date(), nextValue: number | null = null): ColumnSpec {
  const n = c.name.toLowerCase();
  const spec = (generator: GeneratorKind, options = ''): ColumnSpec => ({ column: c.name, generator, options, nulls: 0 });
  if (c.auto) return spec('skip');
  if (c.fk) return spec('foreign_key');
  if (c.array) return spec('skip');
  if (c.values?.length) return spec('list', c.values.join(', '));
  const b = c.base;
  if (b === 'bool') return spec('boolean', /active|enabled|valid|visible/.test(n) ? '80' : '50');
  if (b === 'uuid') return spec('uuid');
  if (c.after && ['date', 'timestamp', 'timestamptz', 'int2', 'int4', 'int8', 'numeric', 'float4', 'float8'].includes(b)) {
    const g = b === 'date' ? 'date' : b.startsWith('timestamp') ? 'timestamp' : INT_TYPES[b] ? 'integer' : 'decimal';
    return spec(g, `${c.after.column} + ${g === 'timestamp' ? (c.after.strict ? '0.01..2' : '0..2') : g === 'decimal' ? (c.after.strict ? '0.01..100' : '0..100') : c.after.strict ? '1..14' : '0..14'}`);
  }
  const lo = (d: number) => (c.min !== null ? Math.max(c.min, d) : d);
  const hi = (d: number) => (c.max !== null ? Math.min(c.max, d) : d);
  if (INT_TYPES[b]) {
    if (c.unique) return spec('sequence', String(Math.max(nextValue ?? 1, c.min ?? 1)));
    const [min, max] =
      /(^|_)age$/.test(n) ? [18, 80]
      : /year/.test(n) ? [today.getUTCFullYear() - 10, today.getUTCFullYear()]
      : /percent|pct/.test(n) ? [0, 100]
      : /rating|score|stars|rank/.test(n) ? [1, 5]
      : /days|duration/.test(n) ? [1, 30]
      : /qty|quantity|count|amount|num/.test(n) ? [1, 100]
      : [1, 1000];
    const [tmin, tmax] = INT_TYPES[b];
    const a = Math.max(tmin, lo(min));
    return spec('integer', `${a}..${Math.max(a, Math.min(tmax, hi(max)))}`);
  }
  if (DEC_TYPES.has(b)) {
    const scale = c.scale ?? 2;
    const cap = c.precision !== null ? 10 ** (c.precision - scale) - 10 ** -scale : Infinity;
    let [min, max] =
      /(^|_)lat(itude)?$/.test(n) ? [-90, 90]
      : /(^|_)(lng|lon|long|longitude)$/.test(n) ? [-180, 180]
      : /percent|pct|rate/.test(n) ? [0, 100]
      : /price|amount|cost|sal|total|fee|wage|budget|comm|pay/.test(n) ? [10, 10000]
      : [0, 1000];
    min = Math.max(lo(min), -cap);
    max = Math.max(min, Math.min(hi(max), cap));
    return spec('decimal', `${min.toFixed(scale)}..${max.toFixed(scale)}`);
  }
  const back = (years: number) => isoDay(new Date(Date.UTC(today.getUTCFullYear() - years, today.getUTCMonth(), today.getUTCDate())));
  if (b === 'date') return spec('date', /birth|dob/.test(n) ? `${back(70)}..${back(18)}` : `${back(5)}..${isoDay(today)}`);
  if (b === 'timestamp' || b === 'timestamptz') return spec('timestamp', `${back(2)}..${isoDay(today)}`);
  if (b === 'time' || b === 'timetz') return spec('time', '08:00..18:00');
  if (b === 'json' || b === 'jsonb') return c.notNull && c.default === null ? spec('fixed', '{}') : spec('skip');
  if (!TEXT_TYPES.has(b)) return spec(c.notNull && c.default === null ? 'fixed' : 'skip', '');
  if (c.maxLength !== null && c.maxLength <= 3) return spec('code', 'A'.repeat(c.maxLength));
  if (/e_?mail/.test(n)) return spec('email');
  if (/first_?name|given_?name|fore_?name|^fname$/.test(n)) return spec('first_name');
  if (/last_?name|sur_?name|family_?name|^lname$/.test(n)) return spec('last_name');
  if (/user_?name|login|^user$|handle|(^|_)by$/.test(n)) return spec('username');
  if (/phone|mobile|^tel|fax/.test(n)) return spec('phone');
  if (/^(name|full_?name|ename|display_?name|contact|contact_?name|person|person_?name|employee_?name|author|owner|assignee|manager)$/.test(n)) return spec('full_name');
  if (/company|employer|organi[sz]ation|vendor|supplier|customer|client/.test(n)) return spec('company');
  if (/job|position|occupation/.test(n)) return spec('job_title');
  if (/city|town|loc(ation)?$/.test(n)) return spec('city');
  if (/country/.test(n)) return spec('country');
  if (/street|address|addr/.test(n)) return spec('address');
  if (/zip|postal|post_?code/.test(n)) return spec('postal_code');
  if (/url|website|homepage|link/.test(n)) return spec('url');
  if (/status|state/.test(n)) return spec('list', 'NEW, ACTIVE, CLOSED');
  if (/priority|severity/.test(n)) return spec('list', 'LOW, MEDIUM, HIGH');
  if (/code|sku|(^|_)ref|(^|_)no$|number/.test(n)) return spec('code', 'AAA-9999');
  if (/desc|comment|note|remark|text|summary|body|reason|message|detail/.test(n)) return spec('sentence', '4..12');
  if (/name|title|label|subject|heading/.test(n)) return spec('words', '1..3');
  return spec('word');
}

/** The next value of a unique integer column (max + 1), for a sequence's start. */
export async function nextValues(db: Db, t: TableInfo) {
  const out = new Map<string, number>();
  for (const c of t.columns.filter((c) => c.unique && INT_TYPES[c.base] && !c.auto && !c.fk)) {
    const r = (await db.query(`select coalesce(max(${pg.escapeIdentifier(c.name)}), 0)::bigint + 1 as n from ${t.qname}`)).rows[0];
    out.set(c.name, Number(r.n));
  }
  return out;
}

/** The proposed definition of a table (existing specs of known columns win). */
export function tableSpec(t: TableInfo, rows: number, saved?: TableSpec, today?: Date, next?: Map<string, number>): TableSpec {
  const old = new Map((saved?.columns ?? []).map((c) => [c.column, c]));
  return {
    table: t.name,
    rows: saved?.rows ?? rows,
    columns: t.columns.map((c) => old.get(c.name) ?? propose(c, today, next?.get(c.name) ?? null)),
  };
}

// ------------------------------------------------------------------ randomness

/** A 32-bit hash of a string (FNV-1a). */
function hash(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A small seeded random generator (mulberry32): numbers in [0, 1). */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Rand = () => number;
const streamOf = (seed: number, ...parts: string[]) => rng(hash(`${seed}\u0000${parts.join('\u0000')}`));
const pick = <T>(r: Rand, list: readonly T[]) => list[Math.floor(r() * list.length)];
const between = (r: Rand, min: number, max: number) => min + Math.floor(r() * (max - min + 1));
const digits = (r: Rand, n: number) => Array.from({ length: n }, () => Math.floor(r() * 10)).join('');
const pad = (n: number, w = 2) => String(n).padStart(w, '0');

// ------------------------------------------------------------------ options

const RANGE = /^\s*(.+?)\s*\.\.\s*(.+?)\s*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
const NUM = /^-?\d+(\.\d+)?$/;

/**
 * A parsed column generator: one value from its random stream, the row's
 * person and the row number. attempt > 0: the value was taken (a unique
 * column): draw again, or for values of the row's person, append a number.
 */
type Make = (r: Rand, row: Person, i: number, attempt: number, values: Map<string, string | null>) => string | null;
interface Person {
  first: string;
  last: string;
}

const listValues = (s: string) =>
  s
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '');

/** "column + min..max": a value relative to another column of the row (end_date after start_date). */
const RELATIVE = /^\s*([A-Za-z_][\w$]*)\s*\+\s*(-?\d+(?:\.\d+)?)\s*\.\.\s*(-?\d+(?:\.\d+)?)\s*$/;

/**
 * The value maker of a column, or an error message for the options. earlier:
 * the generated columns before this one (relative values refer to them).
 */
export function maker(spec: ColumnSpec, c: ColumnInfo, earlier: string[] = []): Make | string {
  const o = spec.options.trim();
  const rel = ['date', 'timestamp', 'integer', 'decimal'].includes(spec.generator) ? RELATIVE.exec(o) : null;
  if (rel) {
    const [, col, a1, z1] = rel;
    const [a, z] = [Number(a1), Number(z1)];
    if (!earlier.includes(col)) return `${col} must be a generated column before ${c.name}`;
    if (z < a) return 'column + min..max with min not above max';
    if (spec.generator === 'integer' && (!Number.isInteger(a) || !Number.isInteger(z))) return 'column + min..max with whole numbers';
    const scale = c.scale ?? (spec.generator === 'decimal' ? Math.max((a1.split('.')[1] ?? '').length, (z1.split('.')[1] ?? '').length) : 0);
    return (r, _p, _i, _attempt, values) => {
      const base = values.get(col);
      if (base === null || base === undefined) return null;
      if (spec.generator === 'integer') return String(Math.trunc(Number(base)) + a + Math.floor(r() * (z - a + 1)));
      if (spec.generator === 'decimal') return (Number(base) + a + r() * (z - a)).toFixed(scale);
      const t = Date.parse(`${base.slice(0, 10)}T${base.length > 10 ? base.slice(11, 19) : '00:00:00'}Z`);
      if (Number.isNaN(t)) return null;
      if (spec.generator === 'date') return isoDay(new Date(t + (Math.floor(a) + Math.floor(r() * (Math.floor(z) - Math.floor(a) + 1))) * 86_400_000));
      return new Date(t + Math.floor((a + r() * (z - a)) * 86_400) * 1000).toISOString().slice(0, 19).replace('T', ' ');
    };
  }
  const cut = (v: string, suffix = '') => (c.maxLength !== null && v.length + suffix.length > c.maxLength ? v.slice(0, Math.max(0, c.maxLength - suffix.length)) : v) + suffix;
  // random text: drawn again for the first retries, then a number is appended
  const text = (f: (r: Rand) => string): Make => (r, _p, _i, attempt) => cut(f(r), attempt >= 10 ? `-${attempt}` : '');
  // text of the row's person: the same person on every retry, so a number is appended at once
  const personal = (f: (p: Person) => string, sep = ' '): Make => (_r, p, _i, attempt) => cut(f(p), attempt ? `${sep}${attempt + 1}` : '');
  const range = () => RANGE.exec(o);
  switch (spec.generator) {
    case 'first_name':
      return personal((p) => p.first);
    case 'last_name':
      return personal((p) => p.last);
    case 'full_name':
      return personal((p) => `${p.first} ${p.last}`);
    case 'email':
      return (r, p, _i, attempt) => {
        const domain = pick(r, EMAIL_DOMAINS);
        return cut(`${slug(p.first)}.${slug(p.last)}${attempt ? attempt + 1 : ''}`, `@${domain}`);
      };
    case 'username':
      return personal((p) => `${slug(p.first).slice(0, 1)}${slug(p.last)}`, '');
    case 'phone':
      return text((r) => `0${digits(r, 2)} ${digits(r, 3)} ${digits(r, 4)}`);
    case 'company':
      return text((r) => `${pick(r, COMPANY_WORDS)} ${pick(r, COMPANY_KINDS)}${r() < 0.6 ? ` ${pick(r, COMPANY_SUFFIXES)}` : ''}`);
    case 'job_title':
      return text((r) => pick(r, JOB_TITLES));
    case 'address':
      return text((r) => `${pick(r, STREETS)} ${pick(r, STREET_KINDS)} ${between(r, 1, 250)}`);
    case 'postal_code':
      return text((r) => `${digits(r, 4)} ${String.fromCharCode(65 + Math.floor(r() * 26), 65 + Math.floor(r() * 26))}`);
    case 'city':
      return text((r) => pick(r, CITIES));
    case 'country':
      return text((r) => pick(r, COUNTRIES));
    case 'word':
      return text((r) => pick(r, WORDS));
    case 'words':
    case 'sentence': {
      const [def1, def2] = spec.generator === 'words' ? [1, 3] : [4, 12];
      const m = o ? range() : null;
      if (o && (!m || !/^\d+$/.test(m[1]) || !/^\d+$/.test(m[2]) || Number(m[1]) < 1 || Number(m[2]) < Number(m[1]) || Number(m[2]) > 200))
        return 'number of words: min..max, e.g. 2..5';
      const [a, z] = m ? [Number(m[1]), Number(m[2])] : [def1, def2];
      const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
      return spec.generator === 'words'
        ? text((r) => Array.from({ length: between(r, a, z) }, () => cap(pick(r, WORDS))).join(' '))
        : text((r) => `${cap(Array.from({ length: between(r, a, z) }, () => pick(r, WORDS)).join(' '))}.`);
    }
    case 'code': {
      const pattern = o || 'AAA-9999';
      if (pattern.length > 100) return 'a pattern of at most 100 characters';
      return text((r) =>
        [...pattern]
          .map((ch) =>
            ch === 'A' ? String.fromCharCode(65 + Math.floor(r() * 26)) : ch === 'a' ? String.fromCharCode(97 + Math.floor(r() * 26)) : ch === '9' ? digits(r, 1) : ch,
          )
          .join(''),
      );
    }
    case 'url':
      return text((r) => `https://www.${pick(r, EMAIL_DOMAINS)}/${pick(r, WORDS)}/${pick(r, WORDS)}`);
    case 'uuid':
      return (r) => {
        const h = Array.from({ length: 32 }, () => Math.floor(r() * 16).toString(16));
        h[12] = '4';
        h[16] = ((parseInt(h[16], 16) & 3) | 8).toString(16);
        const s = h.join('');
        return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
      };
    case 'integer': {
      const m = range();
      if (!m || !/^-?\d+$/.test(m[1]) || !/^-?\d+$/.test(m[2]) || Number(m[2]) < Number(m[1])) return 'min..max with whole numbers, e.g. 1..100 (or column + min..max)';
      const [a, z] = [Number(m[1]), Number(m[2])];
      if (!Number.isSafeInteger(a) || !Number.isSafeInteger(z)) return 'numbers up to 9007199254740991';
      return (r) => String(a + Math.floor(r() * (z - a + 1)));
    }
    case 'decimal': {
      const m = range();
      if (!m || !NUM.test(m[1]) || !NUM.test(m[2]) || Number(m[2]) < Number(m[1])) return 'min..max, e.g. 0.00..999.99 (or column + min..max)';
      const scale = c.scale ?? Math.max((m[1].split('.')[1] ?? '').length, (m[2].split('.')[1] ?? '').length, c.base === 'numeric' ? 0 : 2);
      const [a, z] = [Number(m[1]), Number(m[2])];
      return (r) => {
        const v = a + r() * (z - a);
        return Math.min(z, Math.max(a, Number(v.toFixed(scale)))).toFixed(scale);
      };
    }
    case 'date':
    case 'timestamp': {
      const m = range();
      if (!m || !DATE.test(m[1]) || !DATE.test(m[2])) return 'from..to as YYYY-MM-DD..YYYY-MM-DD, or column + min..max days';
      const a = Date.parse(`${m[1]}T00:00:00Z`);
      const z = Date.parse(`${m[2]}T00:00:00Z`) + (spec.generator === 'timestamp' ? 86_399_000 : 0);
      if (Number.isNaN(a) || Number.isNaN(z) || z < a) return 'from..to: two valid dates, the first not after the second';
      if (spec.generator === 'date') return (r) => isoDay(new Date(a + Math.floor(r() * ((z - a) / 86_400_000 + 1)) * 86_400_000));
      return (r) => new Date(a + Math.floor(r() * ((z - a) / 1000 + 1)) * 1000).toISOString().slice(0, 19).replace('T', ' ');
    }
    case 'time': {
      const m = range();
      const t1 = m && TIME.exec(m[1]);
      const t2 = m && TIME.exec(m[2]);
      const secs = (t: RegExpExecArray) => Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3] ?? 0);
      if (!t1 || !t2 || secs(t2) < secs(t1) || secs(t2) >= 86400 || Number(t1[2]) > 59 || Number(t2[2]) > 59) return 'from..to as HH:MM..HH:MM';
      const [a, z] = [secs(t1), secs(t2)];
      return (r) => {
        const s = between(r, a, z);
        return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
      };
    }
    case 'boolean': {
      const p = o === '' ? 50 : Number(o);
      if (!/^\d+(\.\d+)?$/.test(o || '50') || p > 100) return 'a percentage true from 0 to 100';
      return (r) => (r() * 100 < p ? 'true' : 'false');
    }
    case 'list': {
      const values = listValues(o);
      if (!values.length) return 'values separated by commas';
      return (r) => pick(r, values);
    }
    case 'sequence': {
      const m = /^\s*(-?\d+)\s*(?:,\s*(-?\d+)\s*)?$/.exec(o || '1');
      if (!m || Number(m[2] ?? 1) === 0) return 'start or start, step (whole numbers, step not 0)';
      const [start, step] = [Number(m[1]), Number(m[2] ?? 1)];
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(step)) return 'numbers up to 9007199254740991';
      return (_r, _p, i, attempt) => String(start + (i + attempt) * step);
    }
    case 'fixed':
      return () => o;
    case 'skip':
    case 'foreign_key':
      return () => '';
  }
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[^a-z0-9]/g, '');

// ------------------------------------------------------------------ validation and planning

export interface PlannedTable {
  info: TableInfo;
  spec: TableSpec;
  /** the generated columns (not skipped), in table order */
  columns: ColumnInfo[];
  makers: Map<string, Make>;
  /** foreign keys whose columns are generated with "foreign_key" */
  fks: ForeignKey[];
}

/** Parse a posted or saved definition; never trusts its shape. */
export function cleanDef(v: unknown): GeneratorDef {
  const o = (v ?? {}) as Record<string, unknown>;
  const tables = Array.isArray(o.tables) ? o.tables.slice(0, MAX_TABLES) : [];
  const seed = o.seed === null || o.seed === undefined || o.seed === '' ? null : Number(o.seed);
  return {
    schema: String(o.schema ?? ''),
    seed: seed !== null && Number.isInteger(seed) && seed >= 0 && seed <= 4294967295 ? seed : null,
    tables: tables.map((t: any) => ({
      table: String(t?.table ?? ''),
      rows: Number.isInteger(Number(t?.rows)) ? Number(t.rows) : NaN,
      columns: (Array.isArray(t?.columns) ? t.columns : []).map((c: any) => ({
        column: String(c?.column ?? ''),
        generator: isGenerator(c?.generator) ? c.generator : 'skip',
        options: String(c?.options ?? '').slice(0, 4000),
        nulls: Math.min(100, Math.max(0, Number(c?.nulls) || 0)),
      })),
    })),
  };
}

/**
 * Check a definition against the catalog: the schema and tables exist, row
 * counts are in range, every generator suits its column and its options
 * parse. Returns the tables in dependency order (parents first), or the problems.
 */
export async function plan(db: Db, def: GeneratorDef): Promise<{ tables: PlannedTable[]; problems: string[] }> {
  const problems: string[] = [];
  if (!allowedSchema(def.schema)) return { tables: [], problems: ['Choose a schema of your own: not meta, information_schema or pg_*.'] };
  if (!def.tables.length) return { tables: [], problems: ['Choose at least one table.'] };
  const planned: PlannedTable[] = [];
  let total = 0;
  const seen = new Set<string>();
  for (const spec of def.tables) {
    if (seen.has(spec.table)) continue;
    seen.add(spec.table);
    const info = await describe(db, def.schema, spec.table);
    if (!info) {
      problems.push(`${def.schema}.${spec.table}: no such table.`);
      continue;
    }
    if (!Number.isInteger(spec.rows) || spec.rows < 0) problems.push(`${spec.table}: the number of rows must be a whole number from 0.`);
    total += Number.isInteger(spec.rows) ? spec.rows : 0;
    const specs = new Map(spec.columns.map((c) => [c.column, c]));
    const columns: ColumnInfo[] = [];
    const makers = new Map<string, Make>();
    const earlier: string[] = [];
    for (const c of info.columns) {
      const cs = specs.get(c.name);
      if (!cs || cs.generator === 'skip') {
        if (c.notNull && c.default === null && !c.auto) problems.push(`${spec.table}.${c.name} is NOT NULL without a default: choose a generator.`);
        continue;
      }
      if (c.noInsert) {
        problems.push(`${spec.table}.${c.name} is ${c.auto === 'generated' ? 'a generated column' : 'GENERATED ALWAYS AS IDENTITY'}: it can only be skipped.`);
        continue;
      }
      if (cs.nulls > 0 && c.notNull) problems.push(`${spec.table}.${c.name} is NOT NULL: nulls must be 0%.`);
      if (cs.generator === 'foreign_key' && !c.fk) {
        problems.push(`${spec.table}.${c.name}: “Foreign key” needs a foreign key constraint on the column.`);
        continue;
      }
      const m = maker(cs, c, earlier);
      if (typeof m === 'string') problems.push(`${spec.table}.${c.name} (${GENERATORS[cs.generator]}): ${m}.`);
      else makers.set(c.name, m);
      columns.push(c);
      earlier.push(c.name);
    }
    // a foreign key is generated as a whole: all its columns or none
    const fks = info.fks.filter((f) => f.columns.some((col) => specs.get(col)?.generator === 'foreign_key'));
    for (const f of fks)
      if (!f.columns.every((col) => specs.get(col)?.generator === 'foreign_key'))
        problems.push(`${spec.table}: the foreign key ${f.name} (${f.columns.join(', ')}) needs “Foreign key” on all its columns.`);
    planned.push({ info, spec, columns, makers, fks });
  }
  if (total > MAX_ROWS()) problems.push(`At most ${MAX_ROWS().toLocaleString('en')} rows in one run (SAMPLE_DATA_MAX_ROWS).`);
  return { tables: order(planned), problems };
}

/** Parents before children (foreign keys between the chosen tables); cycles keep the chosen order. */
export function order(tables: PlannedTable[]) {
  const names = new Set(tables.map((t) => t.info.name));
  const done = new Set<string>();
  const out: PlannedTable[] = [];
  const visit = (t: PlannedTable, path: Set<string>) => {
    if (done.has(t.info.name) || path.has(t.info.name)) return;
    path.add(t.info.name);
    for (const f of t.fks)
      if (f.refSchema === t.info.schema && f.refTable !== t.info.name && names.has(f.refTable)) visit(tables.find((x) => x.info.name === f.refTable)!, path);
    path.delete(t.info.name);
    done.add(t.info.name);
    out.push(t);
  };
  for (const t of tables) visit(t, new Set());
  return out;
}

// ------------------------------------------------------------------ generation

type Row = (string | null)[];
export interface GeneratedTable {
  table: string;
  qname: string;
  columns: string[];
  /** numeric columns (CSV: no formula guard) */
  numeric: boolean[];
  rows: Row[];
}

/** Tuples of parent key values that foreign keys pick from, by "schema.table(columns)". */
export type Pools = Map<string, Row[]>;
const poolKey = (f: ForeignKey) => `${f.refSchema}.${f.refTable}(${f.refColumns.join(',')})`;

/** Existing parent key tuples of every foreign key of the plan (not null, at most EXISTING_LIMIT). */
export async function existingPools(db: Db, tables: PlannedTable[]): Promise<Pools> {
  const pools: Pools = new Map();
  for (const t of tables)
    for (const f of t.fks) {
      const key = poolKey(f);
      if (pools.has(key)) continue;
      const cols = f.refColumns.map((c) => pg.escapeIdentifier(c));
      const res = await db.query({
        text: `select distinct ${cols.map((c) => `${c}::text`).join(', ')} from ${pg.escapeIdentifier(f.refSchema)}.${pg.escapeIdentifier(f.refTable)}
                where ${cols.map((c) => `${c} is not null`).join(' and ')} order by ${cols.map((_, i) => i + 1).join(', ')} limit ${EXISTING_LIMIT}`,
        rowMode: 'array',
      });
      pools.set(key, res.rows);
    }
  return pools;
}

/** Existing values of the generated single-column unique keys, to avoid duplicates. */
export async function existingUnique(db: Db, t: PlannedTable) {
  const out = new Map<string, Set<string>>();
  for (const c of t.columns.filter((c) => c.unique)) {
    const col = pg.escapeIdentifier(c.name);
    const res = await db.query({ text: `select ${col}::text from ${t.info.qname} where ${col} is not null limit ${EXISTING_LIMIT}`, rowMode: 'array' });
    out.set(c.name, new Set(res.rows.map((r) => r[0])));
  }
  return out;
}

const NUMERIC_BASES = new Set(['int2', 'int4', 'int8', 'numeric', 'float4', 'float8', 'oid']);

/**
 * The row generator of one table: next(count) gives the next rows. Foreign
 * keys pick from pools (parent key tuples, which may grow between calls);
 * unique columns get values not used yet (retries, then a number appended,
 * then an error). Every column, foreign key and the people of the rows
 * (names, e-mail addresses and user names of one row belong together) have
 * a random stream of their own.
 */
export function rowGenerator(t: PlannedTable, seed: number, pools: Pools, used: Map<string, Set<string>>) {
  const specs = new Map(t.spec.columns.map((c) => [c.column, c]));
  const name = t.info.name;
  const streams = new Map<string, Rand>(t.columns.map((c) => [c.name, streamOf(seed, name, c.name)]));
  const nullStreams = new Map<string, Rand>(t.columns.map((c) => [c.name, streamOf(seed, name, c.name, 'null')]));
  const people = streamOf(seed, name, '\u0001person');
  const fkStreams = new Map(t.fks.map((f) => [f.name, streamOf(seed, name, '\u0001fk', f.name)]));
  const fkOf = new Map<string, ForeignKey>();
  for (const f of t.fks) for (const c of f.columns) fkOf.set(c, f);
  let i = 0;
  return (count: number): Row[] => {
    const out: Row[] = [];
    for (const end = i + count; i < end; i++) {
      const p: Person = { first: pick(people, FIRST_NAMES), last: pick(people, LAST_NAMES) };
      const row: Row = [];
      const values = new Map<string, string | null>();
      const fkRow = new Map<string, Row | null>();
      for (const c of t.columns) {
        const spec = specs.get(c.name)!;
        const isNull = nullStreams.get(c.name)!() * 100 < spec.nulls;
        const f = fkOf.get(c.name);
        if (f) {
          if (!fkRow.has(f.name)) fkRow.set(f.name, pickParent(t, f, pools, fkStreams.get(f.name)!, used, isNull));
          const tuple = fkRow.get(f.name);
          values.set(c.name, tuple ? tuple[f.columns.indexOf(c.name)] : null);
          row.push(values.get(c.name)!);
          continue;
        }
        if (isNull) {
          values.set(c.name, null);
          row.push(null);
          continue;
        }
        const make = t.makers.get(c.name)!;
        const r = streams.get(c.name)!;
        let v = make(r, p, i, 0, values);
        if (c.unique && v !== null) {
          const seen = used.get(c.name) ?? used.set(c.name, new Set()).get(c.name)!;
          for (let k = 1; v !== null && seen.has(v) && k <= 50; k++) v = make(r, p, i, k, values);
          if (v !== null && seen.has(v)) throw new SampleDataError(`${name}.${c.name} is unique, but its generator ran out of new values (row ${i + 1}): widen the range or the list.`);
          if (v !== null) seen.add(v);
        }
        values.set(c.name, v);
        row.push(v);
      }
      out.push(row);
    }
    return out;
  };
}

/** All rows of one table at once. */
export const generateRows = (t: PlannedTable, seed: number, pools: Pools, used: Map<string, Set<string>>) => rowGenerator(t, seed, pools, used)(t.spec.rows);

function pickParent(t: PlannedTable, f: ForeignKey, pools: Pools, r: Rand, used: Map<string, Set<string>>, isNull: boolean): Row | null {
  const nullable = f.columns.every((c) => !t.info.columns.find((x) => x.name === c)!.notNull);
  if (isNull && nullable) return null;
  const pool = pools.get(poolKey(f)) ?? [];
  if (!pool.length) {
    if (nullable) return null;
    throw new SampleDataError(
      `${t.info.name}.${f.columns.join(', ')}: ${f.refSchema}.${f.refTable} has no rows to refer to. Generate ${f.refTable} in the same run (parents are inserted first) or load its rows first.`,
    );
  }
  // a unique foreign key (one-to-one): a parent not used yet
  const uniq = f.columns.length === 1 && t.info.columns.find((x) => x.name === f.columns[0])!.unique;
  if (!uniq) return pool[Math.floor(r() * pool.length)];
  const seen = used.get(f.columns[0]) ?? used.set(f.columns[0], new Set()).get(f.columns[0])!;
  const start = Math.floor(r() * pool.length);
  for (let k = 0; k < pool.length; k++) {
    const tuple = pool[(start + k) % pool.length];
    if (!seen.has(String(tuple[0]))) {
      seen.add(String(tuple[0]));
      return tuple;
    }
  }
  if (nullable) return null;
  throw new SampleDataError(`${t.info.name}.${f.columns[0]} is unique: ${f.refTable} has fewer rows than ${t.info.name} needs.`);
}

/** A random seed for a run without one. */
export const randomSeed = () => Math.floor(Math.random() * 4294967296);

// ------------------------------------------------------------------ run (insert / preview)

/** Postgres text for every type, as in Unload Data. */
const RAW_TYPES = { getTypeParser: () => (v: string) => v } as unknown as pg.CustomTypesConfig;

export interface RunResult {
  seed: number;
  tables: { table: string; rows: number; columns: string[]; sample: Row[] }[];
}

/**
 * Insert the generated rows, table by table in dependency order, on the given
 * connection inside the caller's transaction. Each table's inserted rows
 * (RETURNING) join the parent pools, so children refer to them, identity keys
 * included. Returns the first rows of each table as stored.
 */
export async function insertRows(c: Client, tables: PlannedTable[], seed: number): Promise<RunResult> {
  const pools = await existingPools(c, tables);
  const result: RunResult = { seed, tables: [] };
  for (const t of tables) {
    const used = await existingUnique(c, t);
    const cols = t.columns.map((x) => pg.escapeIdentifier(x.name));
    // foreign keys from later tables (or this one) that refer to this table
    const wanted = tables.flatMap((x) => x.fks).filter((f) => f.refSchema === t.info.schema && f.refTable === t.info.name);
    const entry = { table: t.info.name, rows: 0, columns: [] as string[], sample: [] as Row[] };
    const batch = Math.max(1, Math.min(1000, Math.floor(30000 / Math.max(1, cols.length))));
    const next = rowGenerator(t, seed, pools, used);
    for (let from = 0; from < t.spec.rows; from += batch) {
      const count = Math.min(batch, t.spec.rows - from);
      const rows = next(count);
      const res = cols.length
        ? await c.query({
            text: `insert into ${t.info.qname} (${cols.join(', ')}) values ${rows.map((_, r) => `(${cols.map((_, k) => `$${r * cols.length + k + 1}`).join(', ')})`).join(', ')} returning *`,
            values: rows.flat(),
            rowMode: 'array',
            types: RAW_TYPES,
          })
        : await c.query({ text: `insert into ${t.info.qname} select from generate_series(1, $1::int) returning *`, values: [count], rowMode: 'array', types: RAW_TYPES });
      entry.columns = res.fields.map((f) => f.name);
      entry.rows += res.rowCount ?? 0;
      for (const r of res.rows) if (entry.sample.length < PREVIEW_ROWS) entry.sample.push(r);
      for (const f of wanted) {
        const idx = f.refColumns.map((rc) => entry.columns.indexOf(rc));
        const pool = pools.get(poolKey(f)) ?? pools.set(poolKey(f), []).get(poolKey(f))!;
        for (const r of res.rows as Row[]) if (idx.every((k) => r[k] !== null)) pool.push(idx.map((k) => r[k]));
      }
    }
    result.tables.push(entry);
  }
  return result;
}

/**
 * Generate without inserting (downloads): foreign keys pick existing parent
 * rows and the generated rows of parents whose key columns are generated here
 * (keys from identity or defaults are only known after inserting).
 */
export async function generateAll(db: Db, tables: PlannedTable[], seed: number): Promise<GeneratedTable[]> {
  const pools = await existingPools(db, tables);
  const out: GeneratedTable[] = [];
  for (const t of tables) {
    const used = await existingUnique(db, t);
    const rows = generateRows(t, seed, pools, used);
    const names = t.columns.map((c) => c.name);
    for (const f of tables.flatMap((x) => x.fks).filter((f) => f.refSchema === t.info.schema && f.refTable === t.info.name)) {
      const idx = f.refColumns.map((rc) => names.indexOf(rc));
      if (idx.some((k) => k < 0)) continue;
      const pool = pools.get(poolKey(f)) ?? pools.set(poolKey(f), []).get(poolKey(f))!;
      for (const r of rows) if (idx.every((k) => r[k] !== null)) pool.push(idx.map((k) => r[k]));
    }
    out.push({ table: t.info.name, qname: t.info.qname, columns: names, numeric: t.columns.map((c) => NUMERIC_BASES.has(c.base)), rows });
  }
  return out;
}

// ------------------------------------------------------------------ downloads

/** INSERT statements in one transaction, 100 rows per statement. */
export function sqlScript(def: GeneratorDef, seed: number, tables: GeneratedTable[], name = 'sample data') {
  const lines = [`-- ${name.replace(/[\r\n]+/g, ' ')}: generated by pgapex (SQL Workshop → Sample Data), schema ${def.schema}, seed ${seed}`, 'begin;', ''];
  for (const t of tables) {
    if (!t.rows.length) continue;
    const cols = t.columns.map((c) => pg.escapeIdentifier(c)).join(', ');
    for (let i = 0; i < t.rows.length; i += 100) {
      const chunk = t.rows.slice(i, i + 100);
      lines.push(
        cols ? `insert into ${t.qname} (${cols}) values` : `insert into ${t.qname} select from generate_series(1, ${chunk.length});`,
        ...(cols ? chunk.map((r, k) => `  (${r.map((v) => (v === null ? 'null' : pg.escapeLiteral(v))).join(', ')})${k === chunk.length - 1 ? ';' : ','}`) : []),
      );
    }
    lines.push('');
  }
  lines.push('commit;', '');
  return lines.join('\n');
}

/** One CSV per table (heading row, comma, formula-guarded text as in Unload Data). */
export function csvText(t: GeneratedTable) {
  const line = (cells: string[]) => `${cells.join(',')}\r\n`;
  return line(t.columns.map((c) => csvField(c, false))) + t.rows.map((r) => line(r.map((v, i) => (v === null ? '' : csvField(v, t.numeric[i]))))).join('');
}

/** CSV download: one table → a .csv file; several → a .zip with one .csv per table. */
export function csvDownload(tables: GeneratedTable[]): { name: string; type: string; body: Buffer } {
  if (tables.length === 1) return { name: `${fileName(tables[0].table)}.csv`, type: 'text/csv; charset=utf-8', body: Buffer.from(`﻿${csvText(tables[0])}`) };
  const files: Record<string, Uint8Array> = {};
  for (const t of tables) files[`${fileName(t.table)}.csv`] = strToU8(`﻿${csvText(t)}`);
  return { name: 'sample-data.zip', type: 'application/zip', body: Buffer.from(zipSync(files)) };
}

export const fileName = (s: string) => s.replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 100) || 'data';
