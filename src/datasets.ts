import pg from 'pg';
import { heading } from './runtime/items.ts';
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

// ---------------------------------------------------------------- the catalog

/** A table or view of a schema with its columns (name and type, in table order). */
export interface CatalogObject {
  name: string;
  kind: 'table' | 'view';
  columns: { name: string; type: string; numeric: boolean }[];
}
/** A foreign key between two tables of the schema: table(columns) references ref(refColumns). */
export interface CatalogFk {
  table: string;
  columns: string[];
  ref: string;
  refColumns: string[];
}

type Queryable = { query: <T extends pg.QueryResultRow = any>(sql: string, params?: unknown[]) => Promise<pg.QueryResult<T>> };

/** The tables and views of a schema with their columns, and the foreign keys inside it (read as the given connection). */
export async function readSchemaCatalog(db: Queryable, schema: string): Promise<{ objects: CatalogObject[]; fks: CatalogFk[] }> {
  if (RESERVED.test(schema)) return { objects: [], fks: [] };
  const objects = (
    await db.query<CatalogObject>(
      `select c.relname as name, case when c.relkind in ('v', 'm') then 'view' else 'table' end as kind,
              coalesce(json_agg(json_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod),
                                                  'numeric', t.typcategory = 'N') order by a.attnum)
                       filter (where a.attnum > 0), '[]') as columns
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         left join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
         left join pg_type t on t.oid = a.atttypid
        where n.nspname = $1 and c.relkind in ('r', 'p', 'v', 'm') and has_schema_privilege(n.oid, 'USAGE')
        group by c.relname, c.relkind order by c.relname`,
      [schema],
    )
  ).rows;
  const fks = (
    await db.query<CatalogFk>(
      `select c.relname as table, f.relname as ref,
              array(select a.attname::text from unnest(k.conkey) with ordinality u(n, i) join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.n order by u.i) as columns,
              array(select a.attname::text from unnest(k.confkey) with ordinality u(n, i) join pg_attribute a on a.attrelid = k.confrelid and a.attnum = u.n order by u.i) as "refColumns"
         from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_class f on f.oid = k.confrelid
        where k.contype = 'f' and c.relnamespace = $1::regnamespace and f.relnamespace = $1::regnamespace
        order by c.relname, k.conname`,
      [schema],
    )
  ).rows;
  return { objects, fks };
}

/** The catalog as checkDataset() wants it. */
export const catalogOf = (objects: CatalogObject[]): Catalog => new Map(objects.map((o) => [o.name, new Set(o.columns.map((c) => c.name))]));

/**
 * The join of a table to one of the earlier tables, proposed from foreign keys (either direction; the first match).
 * null: no foreign key links it to them.
 */
export function proposeJoin(table: string, earlier: DatasetTable[], fks: CatalogFk[]): DatasetJoin | null {
  for (const t of earlier) {
    // this table references the earlier one (a child joined to its parent)
    const out = fks.find((f) => f.table === table && f.ref === t.table);
    if (out) return { to: t.alias, type: 'left', on: out.columns.map((c, i) => ({ column: c, ref: out.refColumns[i] })).slice(0, DATASET_LIMITS.joinColumns) };
    // the earlier one references this table (a parent joined to the child before it)
    const back = fks.find((f) => f.table === t.table && f.ref === table);
    if (back) return { to: t.alias, type: 'left', on: back.refColumns.map((c, i) => ({ column: c, ref: back.columns[i] })).slice(0, DATASET_LIMITS.joinColumns) };
  }
  return null;
}

/**
 * A new dataset on tables and views of a schema: joins proposed from foreign keys (a table without one joins to
 * nothing and is reported), every column except binary ones, labelled from its name; numeric columns get a number mask.
 */
export function proposeDataset(name: string, label: string, schema: string, tableNames: string[], cat: { objects: CatalogObject[]; fks: CatalogFk[] }): { dataset: Dataset; errors: string[] } {
  const errors: string[] = [];
  const tables: DatasetTable[] = [];
  // the tables in the order chosen, but a table that joins to none of the earlier ones waits for the others
  const pending = tableNames.filter((t, i) => tableNames.indexOf(t) === i && cat.objects.some((o) => o.name === t)).slice(0, DATASET_LIMITS.tables);
  let progress = true;
  while (pending.length && progress) {
    progress = false;
    for (let i = 0; i < pending.length; i++) {
      const table = pending[i];
      const alias = `t${tables.length + 1}`;
      if (!tables.length) tables.push({ alias, table });
      else {
        const join = proposeJoin(table, tables, cat.fks);
        if (!join) continue;
        tables.push({ alias, table, join });
      }
      pending.splice(i, 1);
      i--;
      progress = true;
    }
  }
  for (const t of pending) errors.push(`No foreign key links ${t} to the other tables: add it on the dataset's page with a join of your own.`);
  const taken = new Set<string>();
  const columns: DatasetColumn[] = [];
  for (const t of tables) {
    const obj = cat.objects.find((o) => o.name === t.table)!;
    // a join column of a later table repeats the earlier one's: offered once
    const joined = new Set(t.join?.on.map((p) => p.column) ?? []);
    for (const c of obj.columns) {
      if (c.type === 'bytea' || joined.has(c.name) || columns.length >= DATASET_LIMITS.columns) continue;
      const n = freeColumnName(taken, t.table, c.name);
      taken.add(n);
      columns.push({ name: n, table: t.alias, column: c.name, label: heading(c.name), ...(c.numeric && /^(numeric|real|double|money)/.test(c.type) ? { format: '999G999G990D00' } : {}) });
    }
  }
  return { dataset: { name, label: label || name, schema, tables, columns, filters: [] }, errors };
}

// ---------------------------------------------------------------- storage

export interface DatasetRow {
  id: number;
  workspace_id: number;
  name: string;
  label: string;
  description: string | null;
  schema_name: string;
  tables: DatasetTable[];
  columns: DatasetColumn[];
  filters: DatasetFilter[];
  updated_at: string;
  updated_by: string | null;
}

/** The datasets of a workspace (name order). */
export async function workspaceDatasets(db: Queryable, workspaceId: number): Promise<DatasetRow[]> {
  return (await db.query<DatasetRow>('select * from meta.dataset where workspace_id = $1 order by name', [workspaceId])).rows;
}

/** Insert or replace a checked dataset of a workspace (by name); returns its id. */
export async function storeDataset(db: Queryable, workspaceId: number, d: Dataset, by: string | null, opts: { replace?: boolean } = {}): Promise<number> {
  const vals = [workspaceId, d.name, d.label, d.description ?? null, d.schema, JSON.stringify(d.tables), JSON.stringify(d.columns), JSON.stringify(d.filters), by];
  const res = await db.query<{ id: number }>(
    `insert into meta.dataset (workspace_id, name, label, description, schema_name, tables, columns, filters, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
     on conflict (workspace_id, name) do ${opts.replace === false ? 'nothing' : `update
       set label = excluded.label, description = excluded.description, schema_name = excluded.schema_name, tables = excluded.tables,
           columns = excluded.columns, filters = excluded.filters, updated_by = excluded.updated_by, updated_at = now()`}
     returning id`,
    vals,
  );
  return res.rows[0]?.id ?? 0;
}

/**
 * The datasets an application offers, by name, as definitions (read through the runtime's own login: row level
 * security shows an isolated workspace's login its own workspace's datasets only).
 */
export async function appDatasets(db: Queryable, appId: number, names: string[]): Promise<Map<string, Dataset>> {
  if (!names.length) return new Map();
  const rows = (
    await db.query(
      `select name, label, description, schema_name, tables, columns, filters from meta.dataset
        where workspace_id = meta.dataset_workspace($1) and name = any($2::text[])`,
      [appId, names],
    )
  ).rows;
  return new Map(rows.map((r) => [r.name as string, datasetOf(r)]));
}
