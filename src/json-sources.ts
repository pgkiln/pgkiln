import pg from 'pg';

// (sprint 142, AP-8; APEX: Shared Components → JSON Sources, and JSON Duality Views)
//
// A JSON source describes a jsonb column with a data profile: columns at paths in the documents, and arrays (of
// objects, or of values) with columns of their own. It is a JSON list in meta.app (json_sources, migration 142),
// exported with the application. From it the builder makes views in the table's schema:
//
//   <view>            the table's key columns and one column per path, typed (a value that doesn't read as the
//                     type shows NULL); an UPDATE writes only the changed paths (meta.json_source_write), so keys
//                     the profile doesn't know about stay;
//   <array view>      per array: the table's key columns, row_key (stable while other elements change), position
//                     and the element's columns; UPDATE, INSERT and DELETE change one element.
//
// Regions (forms, reports, grids, master-detail), REST and MCP use the views like tables. documentViewDdl makes a
// document view of a table and its child tables (APEX's JSON Duality View).

export const JSON_TYPES = ['text', 'integer', 'bigint', 'numeric', 'boolean', 'date', 'timestamp', 'timestamptz', 'jsonb'] as const;
export type JsonType = (typeof JSON_TYPES)[number];

export interface JsonColumn { name: string; path: string[]; type: JsonType; readonly?: boolean }
export interface JsonArray { name: string; path: string[]; view: string; columns: JsonColumn[] }
export interface JsonSource {
  name: string;
  description?: string;
  schema: string;
  table: string;
  key: string[];
  column: string;
  view: string;
  /** a table of documents: the view also adds and deletes the table's rows */
  rows?: boolean;
  columns: JsonColumn[];
  arrays: JsonArray[];
}

export const STATIC_ID = /^[A-Z][A-Z0-9_]{0,59}$/;
export const NAME = /^[a-z_][a-z0-9_]{0,62}$/;
export const ROW_KEY = 'row_key';
export const POSITION = 'position';
const MAX_DEPTH = 4;
const MAX_COLUMNS = 200;

export const ident = (n: string) => (NAME.test(n) && !RESERVED.has(n) ? n : pg.escapeIdentifier(n));
// words that can't be a bare column name (PostgreSQL's reserved key words that look like data names)
const RESERVED = new Set(['all', 'and', 'any', 'array', 'as', 'asc', 'both', 'case', 'cast', 'check', 'column', 'constraint', 'create', 'default', 'desc', 'distinct', 'do', 'else', 'end', 'false', 'for', 'foreign', 'from', 'grant', 'group', 'having', 'in', 'into', 'leading', 'limit', 'not', 'null', 'offset', 'on', 'only', 'or', 'order', 'primary', 'references', 'select', 'table', 'then', 'to', 'true', 'union', 'unique', 'user', 'using', 'when', 'where', 'with', 'position']);
const lit = (s: string) => pg.escapeLiteral(s);
const pathSql = (path: string[]) => (path.length ? `array[${path.map(lit).join(', ')}]` : 'array[]::text[]');

/** The SQL of one column read from a jsonb expression. */
export function columnSql(doc: string, c: JsonColumn) {
  const p = pathSql(c.path);
  if (c.type === 'jsonb') return `${doc} #> ${p}`;
  if (c.type === 'text') return `${doc} #>> ${p}`;
  return `case when meta.input_ok(${doc} #>> ${p}, '${c.type}') then (${doc} #>> ${p})::${c.type} end`;
}

/**
 * (142, AP-8) JSON path columns: config.json_columns [{"name", "column", "path", "type"}] add a column read from a
 * json or jsonb column of the source at a path ("address.city", "skills.0.name"; numbers index arrays), typed (a value
 * that doesn't read as the type is NULL). They come before the user's computations, so search, filters, sorting,
 * aggregates and downloads treat them as columns. Names and types are checked; the path is a literal.
 */
export function withJsonColumns(r: { config?: Record<string, any> | null }, src: string) {
  const list = Array.isArray(r.config?.json_columns) ? (r.config!.json_columns as { name?: unknown; column?: unknown; path?: unknown; type?: unknown }[]) : [];
  const exprs: string[] = [];
  for (const j of list) {
    if (!j || typeof j.name !== 'string' || !NAME.test(j.name) || typeof j.column !== 'string' || !j.column) continue;
    const type = (JSON_TYPES as readonly string[]).includes(String(j.type ?? 'text')) ? (String(j.type ?? 'text') as JsonType) : 'text';
    const path = Array.isArray(j.path) ? j.path.map(String) : String(j.path ?? '').split('.').filter((k) => k !== '');
    exprs.push(`${columnSql(`"__j".${pg.escapeIdentifier(j.column)}::jsonb`, { name: j.name, path, type })} as ${pg.escapeIdentifier(j.name)}`);
  }
  return exprs.length ? `select "__j".*, ${exprs.join(', ')} from (\n${src}\n) "__j"` : src;
}

/** "city=profile:address.city:text; first=profile:skills.0.name" ⇄ config.json_columns (bad entries left out). */
export function parseJsonColumns(text: string | undefined): { name: string; column: string; path: string; type: JsonType }[] {
  const out: { name: string; column: string; path: string; type: JsonType }[] = [];
  for (const part of (text ?? '').split(';')) {
    const m = /^\s*([a-z_][a-z0-9_]{0,62})\s*=\s*([^:\s]+)\s*:\s*([^:]*?)\s*(?::\s*([a-z]+)\s*)?$/.exec(part);
    if (!m || out.some((x) => x.name === m[1])) continue;
    const type = (JSON_TYPES as readonly string[]).includes(m[4] ?? 'text') ? ((m[4] ?? 'text') as JsonType) : 'text';
    out.push({ name: m[1], column: m[2], path: m[3], type });
  }
  return out;
}

export const jsonColumnsText = (v: unknown) =>
  Array.isArray(v) ? v.map((j: any) => `${j.name}=${j.column}:${Array.isArray(j.path) ? j.path.join('.') : j.path ?? ''}${j.type && j.type !== 'text' ? `:${j.type}` : ''}`).join('; ') : '';

// ---------------------------------------------------------------- checks

function pathProblem(path: unknown): string | null {
  if (!Array.isArray(path) || path.length > MAX_DEPTH + 2) return 'a path is a list of up to 6 keys';
  for (const k of path) if (typeof k !== 'string' || !k.length || k.length > 200) return 'each key of a path is 1 to 200 characters';
  return null;
}

function columnsProblems(cols: unknown, where: string, taken: Set<string>, allowEmptyPath: boolean): string[] {
  const out: string[] = [];
  if (!Array.isArray(cols)) return [`${where}: the columns are a list.`];
  if (cols.length > MAX_COLUMNS) out.push(`${where}: at most ${MAX_COLUMNS} columns.`);
  const names = new Set(taken);
  for (const c of cols as JsonColumn[]) {
    if (!c || typeof c !== 'object') {
      out.push(`${where}: a column is an object with a name, a path and a type.`);
      continue;
    }
    if (typeof c.name !== 'string' || !NAME.test(c.name)) out.push(`${where}: column name "${String(c.name)}" is lower case letters, digits and _, starting with a letter or _.`);
    else if (names.has(c.name)) out.push(`${where}: there are two columns ${c.name}${taken.has(c.name) ? ' (a key column or a column the view adds itself)' : ''}.`);
    else names.add(c.name);
    const pp = pathProblem(c.path);
    if (pp) out.push(`${where}, column ${c.name}: ${pp}.`);
    else if (!allowEmptyPath && !c.path.length) out.push(`${where}, column ${c.name}: the path names at least one key.`);
    if (!(JSON_TYPES as readonly string[]).includes(c.type)) out.push(`${where}, column ${c.name}: the type is one of ${JSON_TYPES.join(', ')}.`);
  }
  return out;
}

/** Problems with a JSON source's definition (empty: fine). The catalog is checked by the builder. */
export function jsonSourceProblems(x: JsonSource): string[] {
  const out: string[] = [];
  if (typeof x.name !== 'string' || !STATIC_ID.test(x.name)) out.push('The name (static ID) is upper case letters, digits and _, starting with a letter, e.g. EMP_PROFILE.');
  for (const [what, v] of [['schema', x.schema], ['table', x.table], ['jsonb column', x.column]] as const)
    if (typeof v !== 'string' || !v || v.length > 63) out.push(`The ${what} is a name of 1 to 63 characters.`);
  if (typeof x.view !== 'string' || !NAME.test(x.view)) out.push('The view name is lower case letters, digits and _, e.g. emp_profile.');
  if (!Array.isArray(x.key) || !x.key.length || x.key.some((k) => typeof k !== 'string' || !k)) out.push('The table needs a primary key (the views use it to find the row).');
  if (x.description != null && (typeof x.description !== 'string' || x.description.length > 500)) out.push('The description is at most 500 characters.');
  const key = new Set(Array.isArray(x.key) ? x.key : []);
  out.push(...columnsProblems(x.columns, 'The view', key, false));
  if (!Array.isArray(x.arrays)) out.push('The arrays are a list.');
  else {
    const views = new Set([x.view]);
    for (const a of x.arrays) {
      const at = `Array ${a?.name ?? '?'}`;
      if (!a || typeof a.name !== 'string' || !NAME.test(a.name)) out.push(`${at}: the name is lower case letters, digits and _.`);
      const pp = pathProblem(a?.path);
      if (pp || !a.path.length) out.push(`${at}: ${pp ?? 'the path names at least one key'}.`);
      if (typeof a?.view !== 'string' || !NAME.test(a.view)) out.push(`${at}: the view name is lower case letters, digits and _.`);
      else if (views.has(a.view)) out.push(`${at}: the view ${a.view} is used twice.`);
      else views.add(a.view);
      out.push(...columnsProblems(a?.columns, at, new Set([...key, ROW_KEY, POSITION]), true));
    }
  }
  return out;
}

// ---------------------------------------------------------------- the data profile from sample documents

interface Seen { types: Set<string>; ints: boolean; dates: boolean; stamps: boolean; count: number; objKeys?: Map<string, Seen>; elems?: Seen }
const newSeen = (): Seen => ({ types: new Set(), ints: true, dates: true, stamps: true, count: 0 });
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const STAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)?$/;

function observe(s: Seen, v: unknown, depth: number) {
  s.count++;
  if (v === null) return;
  if (Array.isArray(v)) {
    s.types.add('array');
    if (depth < MAX_DEPTH) for (const e of v) observe((s.elems ??= newSeen()), e, depth + 1);
    return;
  }
  if (typeof v === 'object') {
    s.types.add('object');
    if (depth < MAX_DEPTH) for (const [k, x] of Object.entries(v as object)) {
      s.objKeys ??= new Map();
      if (!s.objKeys.has(k)) s.objKeys.set(k, newSeen());
      observe(s.objKeys.get(k)!, x, depth + 1);
    }
    return;
  }
  s.types.add(typeof v);
  if (typeof v === 'number' && !Number.isInteger(v)) s.ints = false;
  if (typeof v === 'string') {
    if (!DATE.test(v)) s.dates = false;
    if (!STAMP.test(v)) s.stamps = false;
  }
}

function typeOf(s: Seen): JsonType {
  const t = [...s.types];
  if (t.length !== 1) return t.every((x) => x === 'number') ? 'numeric' : t.some((x) => x === 'object' || x === 'array') ? 'jsonb' : 'text';
  switch (t[0]) {
    case 'number': return s.ints ? 'integer' : 'numeric';
    case 'boolean': return 'boolean';
    case 'string': return s.dates ? 'date' : s.stamps ? 'timestamptz' : 'text';
    default: return 'jsonb';
  }
}

const snake = (k: string) => k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, '_$1') || 'value';

function uniqueName(base: string, taken: Set<string>) {
  let n = base.slice(0, 60);
  for (let i = 2; taken.has(n) || RESERVED.has(n); i++) n = `${base.slice(0, 56)}_${i}`;
  taken.add(n);
  return n;
}

/** Columns for the keys of an object (nested objects flattened into a_b, arrays of objects collected apart). */
function flatten(s: Seen, prefix: string[], taken: Set<string>, arrays: { path: string[]; s: Seen }[], depth: number): JsonColumn[] {
  const out: JsonColumn[] = [];
  for (const [k, x] of s.objKeys ?? []) {
    const path = [...prefix, k];
    const only = [...x.types];
    if (only.length === 1 && only[0] === 'object' && x.objKeys?.size && depth < MAX_DEPTH) {
      out.push(...flatten(x, path, taken, arrays, depth + 1));
    } else if (only.length === 1 && only[0] === 'array' && x.elems && x.elems.types.size) {
      arrays.push({ path, s: x.elems });
    } else {
      out.push({ name: uniqueName(snake(path.join('_')), taken), path, type: typeOf(x) });
    }
  }
  return out;
}

/**
 * A data profile from sample documents: a column per scalar path (nested objects flattened, a_b), an array view per
 * array (of objects: a column per key; of values: one column "value"). Arrays inside array elements stay jsonb.
 */
export function proposeProfile(docs: unknown[], o: { key: string[]; view: string }): { columns: JsonColumn[]; arrays: JsonArray[] } {
  const root = newSeen();
  for (const d of docs) if (d && typeof d === 'object' && !Array.isArray(d)) observe(root, d, 0);
  const found: { path: string[]; s: Seen }[] = [];
  const columns = flatten(root, [], new Set([...o.key]), found, 0);
  const views = new Set([o.view]);
  const arrays = found.map(({ path, s }): JsonArray => {
    const name = snake(path.join('_'));
    const view = uniqueName(`${o.view}_${name}`.slice(0, 63), views);
    const taken = new Set([...o.key, ROW_KEY, POSITION]);
    const objects = [...s.types].every((t) => t === 'object');
    const cols = objects
      ? [...(s.objKeys ?? new Map<string, Seen>())].map(([k, x]): JsonColumn => ({ name: uniqueName(snake(k), taken), path: [k], type: typeOf(x) }))
      : [{ name: 'value', path: [], type: typeOf(s) }];
    return { name, path, view, columns: cols };
  });
  return { columns, arrays };
}

// ---------------------------------------------------------------- DDL

export interface Grant { grantee: string; privileges: string[] }

const triggerArg = (o: object) => lit(JSON.stringify(o));
const grantsSql = (view: string, grants: Grant[]) =>
  grants.filter((g) => g.privileges.length).map((g) => `grant ${g.privileges.join(', ')} on ${view} to ${g.grantee === 'PUBLIC' ? 'public' : pg.escapeIdentifier(g.grantee)}`);

/**
 * The statements that (re)make a source's views: drop each, create it security_invoker, its INSTEAD OF trigger,
 * a comment, and the table's grants (SELECT, INSERT, UPDATE, DELETE) on the view.
 */
export function jsonSourceDdl(x: JsonSource, o: { app: string; grants: Grant[]; replace: boolean }): string[] {
  const table = `${ident(x.schema)}.${ident(x.table)}`;
  const keySel = x.key.map((k) => `t.${ident(k)}`).join(', ');
  const doc = `t.${ident(x.column)}`;
  const out: string[] = [];
  const view = `${ident(x.schema)}.${ident(x.view)}`;
  const arrays = x.arrays.map((a) => ({ a, view: `${ident(x.schema)}.${ident(a.view)}` }));
  if (o.replace) for (const v of [...arrays.map((y) => y.view), view]) out.push(`drop view if exists ${v}`);
  const cols = x.columns.map((c) => `${columnSql(doc, c)} as ${ident(c.name)}`);
  out.push(`create view ${view} with (security_invoker = true) as\nselect ${[keySel, ...cols].join(',\n       ')}\n  from ${table} t`);
  out.push(`comment on view ${view} is ${lit(`JSON source ${x.name} of application ${o.app}: ${x.schema}.${x.table}.${x.column} (made by pgkiln; Shared Components → JSON sources makes it again)`)}`);
  out.push(`create trigger json_source_write\n  instead of insert or update or delete on ${view}\n  for each row execute function meta.json_source_write(${triggerArg({
    name: x.name, schema: x.schema, table: x.table, key: x.key, column: x.column, rows: !!x.rows,
    columns: x.columns.map((c) => ({ name: c.name, path: c.path, ...(c.readonly ? { readonly: true } : {}) })),
  })})`);
  out.push(...grantsSql(view, o.grants));
  for (const { a, view: av } of arrays) {
    const arr = `${doc} #> ${pathSql(a.path)}`;
    const ecols = a.columns.map((c) => `${columnSql('e.v', c)} as ${ident(c.name)}`);
    out.push(`create view ${av} with (security_invoker = true) as\nselect ${[keySel, `k.key as ${ROW_KEY}`, `k.idx + 1 as ${POSITION}`, ...ecols].join(',\n       ')}\n  from ${table} t\n  cross join lateral meta.jsonb_element_keys(${arr}) k\n  cross join lateral (select (${arr}) -> k.idx as v) e`);
    out.push(`comment on view ${av} is ${lit(`JSON source ${x.name} of application ${o.app}: the array ${a.path.join('.')} of ${x.schema}.${x.table}.${x.column}, one row per element (made by pgkiln)`)}`);
    out.push(`create trigger json_source_write\n  instead of insert or update or delete on ${av}\n  for each row execute function meta.json_array_write(${triggerArg({
      name: x.name, schema: x.schema, table: x.table, key: x.key, column: x.column, array: a.path, row_key: ROW_KEY, position: POSITION,
      columns: a.columns.map((c) => ({ name: c.name, path: c.path, ...(c.readonly ? { readonly: true } : {}) })),
    })})`);
    out.push(...grantsSql(av, o.grants));
  }
  return out;
}

export interface Child { name: string; schema: string; table: string; key: string[]; fk: [string, string][]; omit?: string[] }

/**
 * A document view (APEX: JSON Duality View): the table's key and a jsonb document of the row with its children (a
 * list per child table, by foreign key, without the foreign key columns). Writing the document updates the row,
 * upserts the children it lists and deletes the ones it leaves out (meta.json_document_write).
 */
export function documentViewDdl(o: { schema: string; table: string; key: string[]; view: string; document: string; children: Child[]; omit: string[]; grants: Grant[] }): string[] {
  const table = `${ident(o.schema)}.${ident(o.table)}`;
  const view = `${ident(o.schema)}.${ident(o.view)}`;
  const omit = o.omit.map((c) => ` - ${lit(c)}`).join('');
  const kids = o.children.map((c, i) => {
    const alias = `c${i + 1}`;
    const drop = [...c.fk.map(([col]) => col), ...(c.omit ?? [])].map((col) => ` - ${lit(col)}`).join('');
    const on = c.fk.map(([col, parent]) => `${alias}.${ident(col)} = t.${ident(parent)}`).join(' and ');
    const order = c.key.map((k) => `${alias}.${ident(k)}`).join(', ');
    return `${lit(c.name)}, coalesce((select jsonb_agg(to_jsonb(${alias})${drop} order by ${order}) from ${ident(c.schema)}.${ident(c.table)} ${alias} where ${on}), '[]'::jsonb)`;
  });
  const docSql = kids.length ? `(to_jsonb(t)${omit}) || jsonb_build_object(\n           ${kids.join(',\n           ')})` : `to_jsonb(t)${omit}`;
  return [
    `create view ${view} with (security_invoker = true) as\nselect ${o.key.map((k) => `t.${ident(k)}`).join(', ')},\n       ${docSql} as ${ident(o.document)}\n  from ${table} t`,
    `comment on view ${view} is ${lit(`Document view of ${o.schema}.${o.table}${o.children.length ? ` with ${o.children.map((c) => `${c.schema}.${c.table}`).join(', ')}` : ''} (made by pgkiln: SQL Workshop › Table Properties › Document view)`)}`,
    `create trigger json_document_write\n  instead of insert or update or delete on ${view}\n  for each row execute function meta.json_document_write(${triggerArg({
      schema: o.schema, table: o.table, key: o.key, document: o.document,
      children: o.children.map((c) => ({ name: c.name, schema: c.schema, table: c.table, key: c.key, fk: c.fk })),
    })})`,
    ...grantsSql(view, o.grants),
  ];
}

// ---------------------------------------------------------------- catalog helpers

type Q = { query: <T extends pg.QueryResultRow = any>(sql: string, params?: unknown[]) => Promise<pg.QueryResult<T>> };

/** The primary key columns of a table, in order (empty: none). */
export async function primaryKey(db: Q, schema: string, table: string): Promise<string[]> {
  return (await db.query<{ n: string }>(
    `select a.attname as n from pg_index i join pg_class c on c.oid = i.indrelid join pg_namespace s on s.oid = c.relnamespace
       cross join lateral unnest(i.indkey::int2[]) with ordinality k(attnum, ord)
       join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
      where s.nspname = $1 and c.relname = $2 and i.indisprimary order by k.ord`, [schema, table])).rows.map((r) => r.n);
}

/** Who has SELECT, INSERT, UPDATE or DELETE on a table (PUBLIC included), for the same grants on its views. */
export async function tableGrants(db: Q, schema: string, table: string): Promise<Grant[]> {
  const rows = (await db.query<{ grantee: string; privileges: string[] }>(
    `select case when x.grantee = 0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end as grantee,
            array_agg(lower(x.privilege_type) order by x.privilege_type) as privileges
       from pg_class c join pg_namespace s on s.oid = c.relnamespace, aclexplode(c.relacl) x
      where s.nspname = $1 and c.relname = $2 and x.privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE') and x.grantee <> c.relowner
      group by 1 order by 1`, [schema, table])).rows;
  return rows;
}

/** A sample of a column's documents (objects only), for proposing a profile. */
export async function sampleDocuments(db: Q, schema: string, table: string, column: string, limit = 200): Promise<unknown[]> {
  return (await db.query<{ d: unknown }>(
    `select ${ident(column)} as d from ${ident(schema)}.${ident(table)} where jsonb_typeof(${ident(column)}::jsonb) = 'object' limit ${Math.max(1, Math.min(1000, limit | 0))}`)).rows.map((r) => r.d);
}

/** The child tables of a table: foreign keys that reference it, with the child's primary key. */
export async function childTables(db: Q, schema: string, table: string): Promise<Child[]> {
  const rows = (await db.query<{ schema: string; table: string; fk: [string, string][] }>(
    `select cs.nspname as schema, cc.relname as table,
            array(select array[ca.attname::text, pa.attname::text]
                    from unnest(f.conkey, f.confkey) with ordinality u(ck, pk, ord)
                    join pg_attribute ca on ca.attrelid = f.conrelid and ca.attnum = u.ck
                    join pg_attribute pa on pa.attrelid = f.confrelid and pa.attnum = u.pk order by u.ord) as fk
       from pg_constraint f join pg_class pc on pc.oid = f.confrelid join pg_namespace ps on ps.oid = pc.relnamespace
       join pg_class cc on cc.oid = f.conrelid join pg_namespace cs on cs.oid = cc.relnamespace
      where f.contype = 'f' and ps.nspname = $1 and pc.relname = $2 and f.conrelid <> f.confrelid
      order by cs.nspname, cc.relname, f.conname`, [schema, table])).rows;
  const out: Child[] = [];
  const names = new Set<string>();
  for (const r of rows) {
    const key = await primaryKey(db, r.schema, r.table);
    if (!key.length) continue;
    let name = r.table;
    for (let i = 2; names.has(name); i++) name = `${r.table}_${i}`;
    names.add(name);
    out.push({ name, schema: r.schema, table: r.table, key, fk: r.fk });
  }
  return out;
}
