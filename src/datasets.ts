import pg from 'pg';
import { OPERATORS } from './runtime/report.ts';

// (sprint 110, migration 120) Data Reporter datasets: a reusable, trusted view of a workspace's data for business
// users. A dataset is tables and views of one schema, joined (each table after the first joins to an earlier one on
// column pairs; the builder proposes the pairs from foreign keys), the columns users may see with labels, format
// masks and descriptions, and an optional row filter. Stored in meta.dataset per workspace; a Data Reporter region
// offers one as a source ({"id", "dataset"} in config.sources).
//
// checkDataset() keeps only what is well formed (and, with a catalog, what exists); datasetSql() builds the
// dataset's SELECT: identifiers come only from the checked definition and are always quoted, values are escaped
// literals, operators come from the report filter whitelist. The runtime wraps it as a subquery and runs every
// report on it as the application's database role.

export interface DatasetJoin {
  /** the alias of an earlier table */
  to: string;
  type: 'inner' | 'left';
  /** column of this table = ref column of the earlier table */
  on: { column: string; ref: string }[];
}
export interface DatasetTable {
  alias: string;
  table: string;
  join?: DatasetJoin;
}
export interface DatasetColumn {
  /** the name users and report definitions use (a static id) */
  name: string;
  /** the alias of its table */
  table: string;
  column: string;
  label?: string;
  format?: string;
  description?: string;
}
export interface DatasetFilter {
  table: string;
  column: string;
  op: string;
  value: string;
}
export interface Dataset {
  name: string;
  label: string;
  description?: string;
  schema: string;
  tables: DatasetTable[];
  columns: DatasetColumn[];
  filters: DatasetFilter[];
}

export const DATASET_NAME = /^[a-z][a-z0-9_]{0,39}$/;
export const DATASET_LIMITS = { tables: 10, columns: 200, filters: 5, joinColumns: 4, label: 80, description: 500, columnDescription: 300, format: 40, value: 200 };
const RESERVED = /^(pg_.*|information_schema|meta)$/i;
const ALIAS = /^t[1-9][0-9]?$/;

/** The columns of the schema's tables and views (name → column names), for checks against the catalog. */
export type Catalog = Map<string, Set<string>>;

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const clip = (v: unknown, max: number) => str(v).replace(/\0/g, '').trim().slice(0, max);
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);

/**
 * A dataset with only what is well formed: valid names, joins to earlier tables, columns and filters on its tables,
 * whitelisted operators, bounded counts and lengths. With a catalog, tables and columns must also exist. Anything
 * else is dropped and reported in errors (in words for the developer).
 */
export function checkDataset(loose: any, catalog?: Catalog): { dataset: Dataset; errors: string[] } {
  const errors: string[] = [];
  const name = str(loose?.name).trim().toLowerCase();
  if (!DATASET_NAME.test(name)) errors.push(`"${name}" is not a valid dataset name: lower case letters, digits and _, starting with a letter (at most 40).`);
  const label = clip(loose?.label, DATASET_LIMITS.label) || name;
  const description = clip(loose?.description, DATASET_LIMITS.description) || undefined;
  const schema = str(loose?.schema).trim();
  if (!schema || schema.length > 63 || RESERVED.test(schema)) errors.push(`The schema "${schema}" can't be used for a dataset.`);

  const tables: DatasetTable[] = [];
  const has = (table: string, column: string) => !catalog || !!catalog.get(table)?.has(column);
  for (const t of arr(loose?.tables)) {
    const table = str(t?.table);
    const alias = str(t?.alias);
    if (!table || table.length > 63 || !ALIAS.test(alias) || tables.some((x) => x.alias === alias)) {
      errors.push(`A table entry "${table || '?'}" is not valid.`);
      continue;
    }
    if (catalog && !catalog.has(table)) {
      errors.push(`The table or view ${schema}.${table} does not exist (any more).`);
      continue;
    }
    if (tables.length >= DATASET_LIMITS.tables) {
      errors.push(`A dataset has at most ${DATASET_LIMITS.tables} tables.`);
      break;
    }
    if (!tables.length) {
      tables.push({ alias, table });
      continue;
    }
    const j = t?.join;
    const to = tables.find((x) => x.alias === str(j?.to));
    const on = arr(j?.on)
      .map((p: any) => ({ column: str(p?.column), ref: str(p?.ref) }))
      .filter((p) => p.column && p.ref && to && has(table, p.column) && has(to.table, p.ref))
      .slice(0, DATASET_LIMITS.joinColumns);
    if (!to || !on.length) {
      errors.push(`The table ${table} needs a join to an earlier table on existing columns.`);
      continue;
    }
    tables.push({ alias, table, join: { to: to.alias, type: j?.type === 'inner' ? 'inner' : 'left', on } });
  }
  if (!tables.length) errors.push('A dataset needs at least one table or view.');

  const tableOf = (alias: string) => tables.find((x) => x.alias === alias);
  const columns: DatasetColumn[] = [];
  for (const c of arr(loose?.columns)) {
    const t = tableOf(str(c?.table));
    const column = str(c?.column);
    const cname = str(c?.name).trim().toLowerCase();
    if (!t || !column || !has(t.table, column)) continue;
    if (!DATASET_NAME.test(cname)) {
      errors.push(`"${cname}" is not a valid column name: lower case letters, digits and _, starting with a letter.`);
      continue;
    }
    if (columns.some((x) => x.name === cname)) {
      errors.push(`Two columns are named ${cname}.`);
      continue;
    }
    if (columns.length >= DATASET_LIMITS.columns) break;
    const lbl = clip(c?.label, DATASET_LIMITS.label);
    const format = clip(c?.format, DATASET_LIMITS.format);
    const desc = clip(c?.description, DATASET_LIMITS.columnDescription);
    columns.push({ name: cname, table: t.alias, column, ...(lbl ? { label: lbl } : {}), ...(format ? { format } : {}), ...(desc ? { description: desc } : {}) });
  }

  const filters: DatasetFilter[] = [];
  for (const f of arr(loose?.filters)) {
    const t = tableOf(str(f?.table));
    const column = str(f?.column);
    const op = str(f?.op);
    if (!t || !column || !has(t.table, column) || !Object.hasOwn(OPERATORS, op)) continue;
    const value = OPERATORS[op].noValue ? '' : str(f?.value).replace(/\0/g, '').slice(0, DATASET_LIMITS.value);
    if (!OPERATORS[op].noValue && value === '') continue;
    if (filters.length >= DATASET_LIMITS.filters) break;
    filters.push({ table: t.alias, column, op, value });
  }
  return { dataset: { name, label, ...(description ? { description } : {}), schema, tables, columns, filters }, errors };
}

const id = (s: string) => pg.escapeIdentifier(s);

/** The dataset's SELECT: its columns under their names, from its joined tables, with its row filter. */
export function datasetSql(d: Dataset): string {
  const cols = d.columns.length ? d.columns : [];
  const select = cols.map((c) => `${id(c.table)}.${id(c.column)} as ${id(c.name)}`);
  const from = d.tables
    .map((t, i) =>
      i === 0 || !t.join
        ? `${id(d.schema)}.${id(t.table)} ${id(t.alias)}`
        : `${t.join.type === 'inner' ? 'join' : 'left join'} ${id(d.schema)}.${id(t.table)} ${id(t.alias)} on ${t.join.on.map((p) => `${id(t.alias)}.${id(p.column)} = ${id(t.join!.to)}.${id(p.ref)}`).join(' and ')}`,
    )
    .join(' ');
  const where = d.filters.map((f) => OPERATORS[f.op].sql(`${id(f.table)}.${id(f.column)}`, f.value));
  return `select ${select.length ? select.join(', ') : 'null as "__none"'} from ${from}${where.length ? ` where ${where.join(' and ')}` : ''}`;
}

/** A dataset row of meta.dataset as a definition. */
export const datasetOf = (row: { name: string; label: string; description?: string | null; schema_name: string; tables: unknown; columns: unknown; filters: unknown }) =>
  checkDataset({ name: row.name, label: row.label, description: row.description, schema: row.schema_name, tables: row.tables, columns: row.columns, filters: row.filters }).dataset;

// ---------------------------------------------------------------- files

export const DATASET_FORMAT = 'pgkiln-dataset/1';

/** Datasets as a JSON file. */
export function datasetFile(list: Dataset[]) {
  return `${JSON.stringify({ format: DATASET_FORMAT, datasets: list }, null, 2)}\n`;
}

/** The datasets of a file (one dataset, or {format, datasets}); throws an Error with a message for the developer. */
export function readDatasetFile(text: string): any[] {
  let doc: any;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error('The file is not valid JSON.');
  }
  if (doc && typeof doc === 'object' && doc.format !== undefined && doc.format !== DATASET_FORMAT) throw new Error(`Unknown format "${String(doc.format).slice(0, 40)}": expected ${DATASET_FORMAT}.`);
  const list = Array.isArray(doc?.datasets) ? doc.datasets : doc && typeof doc === 'object' && doc.tables ? [doc] : null;
  if (!list?.length) throw new Error('The file has no datasets.');
  if (list.length > 50) throw new Error('A file has at most 50 datasets.');
  return list;
}

/** A name for a column that the dataset doesn't use yet (from the column's name, or table_column). */
export function freeColumnName(taken: Set<string>, table: string, column: string) {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^[^a-z]+/, '').slice(0, 40);
  let base = norm(column) || 'col';
  if (taken.has(base)) base = norm(`${table}_${column}`) || base;
  let n = base;
  for (let i = 2; taken.has(n); i++) n = `${base.slice(0, 36)}_${i}`;
  return n;
}
