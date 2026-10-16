import pg from 'pg';

// (sprint 95, Database Actions DA-8: the Table Properties dialog) A table as a definition the builder's form edits:
// columns (type, not null, default, identity, comment), primary key, unique keys, foreign keys, checks, indexes, the
// table's comment, row level security and, for a new table, partitioning. readTable() reads one from the catalog;
// tableSql() gives the CREATE statements for a new table or the ALTER statements that turn the old definition into
// the new one; checkTable() says what is wrong with a definition before any SQL is made. Pure apart from readTable.

export interface ColumnDef {
  name: string;
  /** the column's name in the table as read (empty: a new column) */
  orig: string;
  type: string;
  notNull: boolean;
  default: string;
  identity: '' | 'always' | 'by default';
  /** a stored generated column's expression (read only here) */
  generated: string;
  comment: string;
  pk: boolean;
}
export interface KeyDef { name: string; columns: string }
export interface ForeignKeyDef { name: string; columns: string; refTable: string; refColumns: string; onDelete: string }
export interface CheckDef { name: string; expr: string }
export interface IndexDef { name: string; columns: string; unique: boolean; /** an index the form can't express (another method, a WHERE): kept as it is */ fixed?: string }
export interface TableDef {
  schema: string;
  name: string;
  comment: string;
  columns: ColumnDef[];
  pkName: string;
  uniques: KeyDef[];
  fks: ForeignKeyDef[];
  checks: CheckDef[];
  indexes: IndexDef[];
  rls: boolean;
  forceRls: boolean;
  /** new tables only: range | list | hash and the key */
  partitionBy: '' | 'range' | 'list' | 'hash';
  partitionKey: string;
}

export const ON_DELETE = ['no action', 'restrict', 'cascade', 'set null', 'set default'] as const;
export const NAME_RE = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
/** A type: a name (a few words allowed: double precision, timestamp with time zone), a size, array brackets, a schema. */
export const TYPE_RE = /^([a-z_][a-z0-9_]*\.)?[a-z_][a-z0-9_ ]{0,40}(\(\d{1,4}(,\s?\d{1,4})?\))?( with(out)? time zone)?(\[\])*$/i;

const ident = (n: string) => (/^[a-z_][a-z0-9_$]*$/.test(n) && !RESERVED.has(n) ? n : pg.escapeIdentifier(n));
const RESERVED = new Set(['all', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc', 'case', 'cast', 'check', 'collate', 'column', 'constraint', 'create', 'default', 'desc', 'distinct', 'do', 'else', 'end', 'except', 'false', 'for', 'foreign', 'from', 'grant', 'group', 'having', 'in', 'into', 'limit', 'not', 'null', 'offset', 'on', 'only', 'or', 'order', 'primary', 'references', 'select', 'table', 'then', 'to', 'true', 'union', 'unique', 'user', 'using', 'when', 'where', 'with']);
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
/** "a, b" → the quoted names */
const names = (list: string) => list.split(',').map((x) => x.trim()).filter(Boolean);
const quoteList = (list: string) => names(list).map(ident).join(', ');

export const emptyTable = (schema: string): TableDef => ({
  schema, name: '', comment: '', columns: [], pkName: '', uniques: [], fks: [], checks: [], indexes: [], rls: false, forceRls: false, partitionBy: '', partitionKey: '',
});

type Q = { query: <T extends pg.QueryResultRow = any>(sql: string, params?: unknown[]) => Promise<pg.QueryResult<T>> };

/** A table as the form shows it; null when `ref` is no table. */
export async function readTable(db: Q, ref: string): Promise<TableDef | null> {
  const t = (await db.query<{ oid: number; schema: string; name: string; comment: string | null; rls: boolean; force: boolean }>(
    `select c.oid, n.nspname as schema, c.relname as name, obj_description(c.oid, 'pg_class') as comment, c.relrowsecurity as rls, c.relforcerowsecurity as force
       from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid = to_regclass($1) and c.relkind in ('r', 'p')`, [ref])).rows[0];
  if (!t) return null;
  const cols = (await db.query<{ name: string; type: string; notnull: boolean; def: string | null; identity: string; generated: string; comment: string | null }>(
    `select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as notnull, pg_get_expr(d.adbin, d.adrelid) as def,
            a.attidentity as identity, a.attgenerated as generated, col_description(a.attrelid, a.attnum) as comment
       from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where a.attrelid = $1 and a.attnum > 0 and not a.attisdropped order by a.attnum`, [t.oid])).rows;
  const cons = (await db.query<{ name: string; type: string; cols: string[]; ref: string | null; refcols: string[] | null; deltype: string; def: string }>(
    `select k.conname as name, k.contype as type,
            array(select a.attname from unnest(k.conkey) with ordinality u(n, i) join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.n order by u.i)::text[] as cols,
            k.confrelid::regclass::text as ref,
            array(select a.attname from unnest(k.confkey) with ordinality u(n, i) join pg_attribute a on a.attrelid = k.confrelid and a.attnum = u.n order by u.i)::text[] as refcols,
            k.confdeltype as deltype, pg_get_constraintdef(k.oid) as def
       from pg_constraint k where k.conrelid = $1 and k.contype in ('p', 'u', 'f', 'c') order by k.conname`, [t.oid])).rows;
  const idx = (await db.query<{ name: string; def: string; unique: boolean }>(
    `select i.relname as name, pg_get_indexdef(x.indexrelid) as def, x.indisunique as unique
       from pg_index x join pg_class i on i.oid = x.indexrelid
      where x.indrelid = $1 and not exists (select 1 from pg_constraint k where k.conindid = x.indexrelid) order by i.relname`, [t.oid])).rows;
  const pk = cons.find((k) => k.type === 'p');
  const DEL: Record<string, string> = { a: 'no action', r: 'restrict', c: 'cascade', n: 'set null', d: 'set default' };
  return {
    schema: t.schema,
    name: t.name,
    comment: t.comment ?? '',
    columns: cols.map((c) => ({
      name: c.name, orig: c.name, type: c.type, notNull: c.notnull, default: c.generated === 's' || c.identity ? '' : (c.def ?? ''),
      identity: c.identity === 'a' ? 'always' : c.identity === 'd' ? 'by default' : '', generated: c.generated === 's' ? (c.def ?? '') : '',
      comment: c.comment ?? '', pk: !!pk?.cols.includes(c.name),
    })),
    pkName: pk?.name ?? '',
    uniques: cons.filter((k) => k.type === 'u').map((k) => ({ name: k.name, columns: k.cols.join(', ') })),
    fks: cons.filter((k) => k.type === 'f').map((k) => ({ name: k.name, columns: k.cols.join(', '), refTable: k.ref ?? '', refColumns: (k.refcols ?? []).join(', '), onDelete: DEL[k.deltype] ?? 'no action' })),
    checks: cons.filter((k) => k.type === 'c').map((k) => ({ name: k.name, expr: /^CHECK \(([\s\S]*)\)( NOT VALID)?$/.exec(k.def)?.[1] ?? k.def })),
    indexes: idx.map((i) => {
      const m = /^CREATE (UNIQUE )?INDEX \S+ ON \S+ USING btree \(([\s\S]*)\)$/.exec(i.def);
      return m ? { name: i.name, columns: m[2], unique: !!m[1] } : { name: i.name, columns: '', unique: i.unique, fixed: i.def };
    }),
    rls: t.rls,
    forceRls: t.force,
    partitionBy: '',
    partitionKey: '',
  };
}

/** An expression the form takes (a default, a check, index columns, a partition key): one expression, no statements. */
const expressionOk = (e: string, max = 500) => e.length <= max && !/;|--|\/\*/.test(e);

/** What is wrong with a definition (empty: nothing). */
export function checkTable(def: TableDef, old: TableDef | null): string[] {
  const errors: string[] = [];
  if (!NAME_RE.test(def.name)) errors.push('The table needs a name: a letter or _ followed by letters, digits, _ or $.');
  if (!def.columns.length) errors.push('A table needs at least one column.');
  const seen = new Set<string>();
  for (const c of def.columns) {
    if (!NAME_RE.test(c.name)) errors.push(`Column “${c.name}”: a name is a letter or _ followed by letters, digits, _ or $.`);
    else if (seen.has(c.name)) errors.push(`Column ${c.name} is there twice.`);
    seen.add(c.name);
    if (!TYPE_RE.test(c.type)) errors.push(`Column ${c.name}: a type is a name with an optional size, e.g. text, numeric(9,2), varchar(40), int[].`);
    if (c.default && !expressionOk(c.default)) errors.push(`Column ${c.name}: a default is one expression (at most 500 characters, without ; or comments).`);
    if (c.default && c.identity) errors.push(`Column ${c.name}: an identity column has no default.`);
    if (c.comment.length > 2000) errors.push(`Column ${c.name}: a comment has at most 2,000 characters.`);
    const was = old?.columns.find((o) => o.orig && o.orig === c.orig);
    if (was && was.generated !== c.generated) errors.push(`Column ${c.name}: a generated column's expression can't be changed here.`);
  }
  const has = (list: string) => names(list).every((n) => seen.has(n)) && names(list).length > 0;
  for (const k of def.uniques) if (!NAME_RE.test(k.name) || !has(k.columns)) errors.push(`Unique key ${k.name || '(no name)'}: a name and columns of the table.`);
  for (const f of def.fks) {
    if (!NAME_RE.test(f.name) || !has(f.columns)) errors.push(`Foreign key ${f.name || '(no name)'}: a name and columns of the table.`);
    if (!f.refTable) errors.push(`Foreign key ${f.name}: choose the table it refers to.`);
    if (f.refColumns && !names(f.refColumns).every((n) => NAME_RE.test(n))) errors.push(`Foreign key ${f.name}: the columns it refers to are names.`);
    if (!(ON_DELETE as readonly string[]).includes(f.onDelete)) errors.push(`Foreign key ${f.name}: an unknown ON DELETE.`);
  }
  for (const k of def.checks) if (!NAME_RE.test(k.name) || !k.expr || !expressionOk(k.expr)) errors.push(`Check ${k.name || '(no name)'}: a name and one expression (without ; or comments).`);
  for (const i of def.indexes) if (!i.fixed && (!NAME_RE.test(i.name) || !i.columns || !expressionOk(i.columns))) errors.push(`Index ${i.name || '(no name)'}: a name and its columns or expressions (without ; or comments).`);
  if (def.partitionBy && (!def.partitionKey || !expressionOk(def.partitionKey, 200))) errors.push('Partitioning needs a key: columns or an expression.');
  if (def.comment.length > 2000) errors.push('A comment has at most 2,000 characters.');
  return errors;
}

const columnSql = (c: ColumnDef) =>
  `${ident(c.name)} ${c.type}${c.identity ? ` generated ${c.identity} as identity` : ''}${c.generated ? ` generated always as (${c.generated}) stored` : ''}${c.default ? ` default ${c.default}` : ''}${c.notNull && !c.pk ? ' not null' : ''}`;

/** The statements that make `def`: CREATE for a new table (old null), else ALTER from old to def. */
export function tableSql(def: TableDef, old: TableDef | null): string[] {
  const q = `${ident(def.schema)}.${ident(def.name)}`;
  const out: string[] = [];
  const pkCols = def.columns.filter((c) => c.pk).map((c) => ident(c.name));
  const fkSql = (f: ForeignKeyDef) => `constraint ${ident(f.name)} foreign key (${quoteList(f.columns)}) references ${f.refTable}${f.refColumns ? ` (${quoteList(f.refColumns)})` : ''}${f.onDelete !== 'no action' ? ` on delete ${f.onDelete}` : ''}`;
  const indexSql = (i: IndexDef) => `create ${i.unique ? 'unique ' : ''}index ${ident(i.name)} on ${q} (${i.columns});`;
  const comments = (from: TableDef | null) => {
    if ((from?.comment ?? '') !== def.comment) out.push(`comment on table ${q} is ${def.comment ? lit(def.comment) : 'null'};`);
    for (const c of def.columns) {
      const was = from?.columns.find((o) => o.orig && o.orig === c.orig);
      if ((was?.comment ?? '') !== c.comment) out.push(`comment on column ${q}.${ident(c.name)} is ${c.comment ? lit(c.comment) : 'null'};`);
    }
  };
  const rls = (from: TableDef | null) => {
    if ((from?.rls ?? false) !== def.rls) out.push(`alter table ${q} ${def.rls ? 'enable' : 'disable'} row level security;`);
    if ((from?.forceRls ?? false) !== def.forceRls) out.push(`alter table ${q} ${def.forceRls ? '' : 'no '}force row level security;`);
  };

  if (!old) {
    const lines = [
      ...def.columns.map(columnSql),
      ...(pkCols.length ? [`${def.pkName ? `constraint ${ident(def.pkName)} ` : ''}primary key (${pkCols.join(', ')})`] : []),
      ...def.uniques.map((k) => `constraint ${ident(k.name)} unique (${quoteList(k.columns)})`),
      ...def.checks.map((k) => `constraint ${ident(k.name)} check (${k.expr})`),
      ...def.fks.map(fkSql),
    ];
    out.push(`create table ${q} (\n  ${lines.join(',\n  ')}\n)${def.partitionBy ? ` partition by ${def.partitionBy} (${def.partitionKey})` : ''};`);
    for (const i of def.indexes) if (!i.fixed) out.push(indexSql(i));
    comments(null);
    rls(null);
    return out;
  }

  const oq = `${ident(old.schema)}.${ident(old.name)}`;
  if (old.name !== def.name) out.push(`alter table ${oq} rename to ${ident(def.name)};`);
  const same = <T extends { name: string }>(a: T, b: T | undefined, key: (x: T) => string) => !!b && key(a) === key(b);
  // constraints and indexes that go or change first, then the columns, then what is added
  const keyOf = (k: KeyDef) => names(k.columns).join(',');
  const fkOf = (f: ForeignKeyDef) => [names(f.columns).join(','), f.refTable, names(f.refColumns).join(','), f.onDelete].join('|');
  const ixOf = (i: IndexDef) => `${i.unique}|${i.columns.replace(/\s+/g, ' ').trim()}`;
  const oldPk = old.columns.filter((c) => c.pk).map((c) => c.orig);
  const newPk = def.columns.filter((c) => c.pk).map((c) => c.orig || c.name);
  const pkChanged = oldPk.join(',') !== newPk.join(',') || def.columns.some((c) => c.pk && !c.orig);
  if (pkChanged && old.pkName) out.push(`alter table ${q} drop constraint ${ident(old.pkName)};`);
  for (const k of old.uniques) if (!same(k, def.uniques.find((x) => x.name === k.name), keyOf)) out.push(`alter table ${q} drop constraint ${ident(k.name)};`);
  for (const k of old.checks) if (!same(k, def.checks.find((x) => x.name === k.name), (x) => x.expr.trim())) out.push(`alter table ${q} drop constraint ${ident(k.name)};`);
  for (const f of old.fks) if (!same(f, def.fks.find((x) => x.name === f.name), fkOf)) out.push(`alter table ${q} drop constraint ${ident(f.name)};`);
  for (const i of old.indexes) if (!i.fixed && !same(i, def.indexes.find((x) => x.name === i.name), ixOf)) out.push(`drop index ${ident(def.schema)}.${ident(i.name)};`);
  for (const c of old.columns) if (!def.columns.some((n) => n.orig === c.orig)) out.push(`alter table ${q} drop column ${ident(c.orig)};`);
  for (const c of def.columns) {
    const was = old.columns.find((o) => o.orig && o.orig === c.orig);
    if (!was) {
      out.push(`alter table ${q} add column ${columnSql(c)};`);
      continue;
    }
    const col = ident(c.name);
    if (was.name !== c.name) out.push(`alter table ${q} rename column ${ident(was.name)} to ${col};`);
    const parts: string[] = [];
    if (was.type !== c.type) parts.push(`alter column ${col} type ${c.type} using ${col}::${c.type}`);
    if (was.default !== c.default) parts.push(c.default ? `alter column ${col} set default ${c.default}` : `alter column ${col} drop default`);
    if (was.identity !== c.identity) {
      if (!c.identity) parts.push(`alter column ${col} drop identity`);
      else if (!was.identity) parts.push(`alter column ${col} add generated ${c.identity} as identity`);
      else parts.push(`alter column ${col} set generated ${c.identity}`);
    }
    // a primary key's columns are not null whatever the box says
    const wantNotNull = c.notNull || c.pk;
    if (wantNotNull !== was.notNull) parts.push(`alter column ${col} ${wantNotNull ? 'set' : 'drop'} not null`);
    if (parts.length) out.push(`alter table ${q}\n  ${parts.join(',\n  ')};`);
  }
  if (pkChanged && newPk.length) out.push(`alter table ${q} add ${def.pkName && def.pkName !== old.pkName ? `constraint ${ident(def.pkName)} ` : old.pkName ? `constraint ${ident(old.pkName)} ` : ''}primary key (${def.columns.filter((c) => c.pk).map((c) => ident(c.name)).join(', ')});`);
  for (const k of def.uniques) if (!same(k, old.uniques.find((x) => x.name === k.name), keyOf)) out.push(`alter table ${q} add constraint ${ident(k.name)} unique (${quoteList(k.columns)});`);
  for (const k of def.checks) if (!same(k, old.checks.find((x) => x.name === k.name), (x) => x.expr.trim())) out.push(`alter table ${q} add constraint ${ident(k.name)} check (${k.expr});`);
  for (const f of def.fks) if (!same(f, old.fks.find((x) => x.name === f.name), fkOf)) out.push(`alter table ${q} add ${fkSql(f)};`);
  for (const i of def.indexes) if (!i.fixed && !same(i, old.indexes.find((x) => x.name === i.name), ixOf)) out.push(indexSql(i));
  comments(old);
  rls(old);
  return out;
}
