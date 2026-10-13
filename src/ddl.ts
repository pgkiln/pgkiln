import pg from 'pg';

// DDL of one schema, read from the catalog (APEX: SQL Workshop → Utilities →
// Generate DDL), and the comparison of two schemas (Schema Comparison).
//
// Every object becomes one entry: its kind, a key (kind and name, a
// function's name with its argument types, a constraint's or policy's table
// and name) and its DDL. readSchema() runs with search_path set to the
// schema: the server's pg_get_*def functions then leave the schema's own
// names unqualified, and so does this code, so the DDL of schema A also
// creates the same objects in schema B (with search_path = B), and two
// schemas compare by their DDL text. A script for one schema
// (ddlScript) puts the schema in search_path at its top.
//
// The order of a script: types and domains, sequences, procedural functions
// (check_function_bodies off), tables, SQL-standard functions (their bodies
// are parsed at once, so after the tables), views and materialized views in
// dependency order, constraints, foreign keys, indexes, triggers, row level
// security and policies, sequence ownership, comments, grants.
//
// Objects that belong to an extension are left out. Read-only: nothing is run.

export type Kind =
  | 'type' | 'domain' | 'sequence' | 'table' | 'function' | 'view' | 'materialized view'
  | 'constraint' | 'foreign key' | 'index' | 'trigger' | 'rls' | 'policy' | 'sequence owner' | 'comment' | 'grant';

export const KINDS: Kind[] = ['type', 'domain', 'sequence', 'table', 'function', 'view', 'materialized view', 'constraint', 'foreign key', 'index', 'trigger', 'rls', 'policy', 'sequence owner', 'comment', 'grant'];

/** The object types a developer picks (comments and grants are options of their own). */
export const OBJECT_TYPES = ['types', 'sequences', 'tables', 'views', 'functions', 'triggers', 'policies'] as const;
export type ObjectType = (typeof OBJECT_TYPES)[number];

const TYPE_OF: Record<Kind, ObjectType | 'comments' | 'grants'> = {
  type: 'types', domain: 'types', sequence: 'sequences', 'sequence owner': 'sequences', table: 'tables', constraint: 'tables', 'foreign key': 'tables', index: 'tables',
  function: 'functions', view: 'views', 'materialized view': 'views', trigger: 'triggers', rls: 'policies', policy: 'policies', comment: 'comments', grant: 'grants',
};

export interface DdlObject {
  kind: Kind;
  /** kind and name: unique in a schema, the same for the same object in another schema */
  key: string;
  /** the object's name as shown (a table, "table.constraint", "f(int)") */
  name: string;
  ddl: string;
  /** the order within its kind (views: by dependency) */
  order: number;
  /** a table's columns, for column-level changes in a comparison */
  columns?: Column[];
  /** what a comparison looks at, when not the DDL itself (a table: its columns in name order) */
  compareAs?: string;
  /** the table a constraint, index, trigger, policy or comment belongs to */
  table?: string;
}

interface Column {
  name: string;
  type: string;
  notNull: boolean;
  default: string | null;
  definition: string;
}

// names are quoted like quote_ident(): only when needed (keywords from pg_get_keywords(), read once)
let keywords: Set<string> | null = null;
const id = (name: string) => (/^[a-z_][a-z0-9_$]*$/.test(name) && !keywords?.has(name) ? name : pg.escapeIdentifier(name));
const PLURAL: Partial<Record<Kind, string>> = { index: 'indexes', rls: 'row level security', policy: 'policies', 'sequence owner': 'sequence ownership', 'foreign key': 'foreign keys' };
const heading = (k: Kind) => PLURAL[k] ?? `${k}s`;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const end = (s: string) => (s.trimEnd().endsWith(';') ? s.trimEnd() : `${s.trimEnd()};`);

/** The schemas a developer can pick: not PostgreSQL's own, not pgkiln's metadata. */
export async function userSchemas(c: { query: (sql: string) => Promise<{ rows: { name: string }[] }> }, opts: { usable?: boolean } = {}) {
  const r = await c.query(
    `select nspname as name from pg_namespace
      where nspname !~ '^pg_' and nspname not in ('information_schema', 'meta')
        and not exists (select 1 from pg_depend d where d.classid = 'pg_namespace'::regclass and d.objid = pg_namespace.oid and d.deptype = 'e')
        ${opts.usable ? `and has_schema_privilege(oid, 'USAGE')` : ''}
      order by 1`,
  );
  return r.rows.map((x) => x.name);
}

/** Every object of the schema (in a read-only transaction of its own: search_path is set for it). */
export async function readSchema(db: pg.Pool | pg.ClientBase, schema: string): Promise<DdlObject[]> {
  const pooled = db instanceof pg.Pool;
  const c = pooled ? await db.connect() : db;
  try {
    await c.query('begin read only');
    keywords ??= new Set((await c.query<{ w: string }>(`select word as w from pg_get_keywords() where catcode <> 'U'`)).rows.map((x) => x.w));
    const ns = (await c.query<{ oid: number }>('select oid from pg_namespace where nspname = $1', [schema])).rows[0];
    if (!ns) throw new Error(`There is no schema "${schema}".`);
    await c.query(`select set_config('search_path', $1, true)`, [`${id(schema)}, pg_catalog`]);
    const out = await read(c, ns.oid, schema);
    await c.query('rollback');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    if (pooled) (c as pg.PoolClient).release();
  }
}

// not an extension's member
const notExt = (cls: string, col = 'oid') =>
  `not exists (select 1 from pg_depend d where d.classid = '${cls}'::regclass and d.objid = ${col} and d.deptype = 'e')`;

async function read(c: pg.ClientBase, ns: number, schema: string): Promise<DdlObject[]> {
  // pg_get_functiondef and pg_get_indexdef name the schema whatever search_path says: leave it out
  const own = `${pg.escapeIdentifier(schema) === `"${schema}"` && /^[a-z_][a-z0-9_$]*$/.test(schema) ? schema : pg.escapeIdentifier(schema)}.`;
  const unqualify = (sql: string, before: RegExp) => sql.replace(before, (m) => m.replace(own, ''));
  const out: DdlObject[] = [];
  const add = (o: Omit<DdlObject, 'order'> & { order?: number }) => out.push({ order: 0, ...o });
  const q = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = [ns]) => (await c.query<T>(sql, params)).rows;

  // ---- types: enums and composite types; domains
  for (const t of await q<{ name: string; labels: string[] | null; attrs: string | null }>(
    `select t.typname as name,
            case when t.typtype = 'e' then array(select e.enumlabel::text from pg_enum e where e.enumtypid = t.oid order by e.enumsortorder) end as labels,
            case when t.typtype = 'c' then (select string_agg(quote_ident(a.attname) || ' ' || format_type(a.atttypid, a.atttypmod), ', ' order by a.attnum)
                                             from pg_attribute a where a.attrelid = t.typrelid and a.attnum > 0 and not a.attisdropped) end as attrs
       from pg_type t
      where t.typnamespace = $1 and (t.typtype = 'e' or (t.typtype = 'c' and (select relkind from pg_class where oid = t.typrelid) = 'c'))
        and ${notExt('pg_type', 't.oid')}
      order by 1`,
  ))
    add({ kind: 'type', key: `type:${t.name}`, name: t.name, ddl: t.labels ? `create type ${id(t.name)} as enum (${t.labels.map(lit).join(', ')});` : `create type ${id(t.name)} as (${t.attrs ?? ''});` });

  for (const d of await q<{ name: string; base: string; collation: string | null; def: string | null; notnull: boolean; checks: string[] }>(
    `select t.typname as name, format_type(t.typbasetype, t.typtypmod) as base,
            case when t.typcollation <> 0 and t.typcollation <> (select typcollation from pg_type b where b.oid = t.typbasetype)
                 then (select quote_ident(collname) from pg_collation where oid = t.typcollation) end as collation,
            t.typdefault as def, t.typnotnull as notnull,
            array(select 'constraint ' || quote_ident(k.conname) || ' ' || pg_get_constraintdef(k.oid) from pg_constraint k where k.contypid = t.oid order by k.conname) as checks
       from pg_type t where t.typnamespace = $1 and t.typtype = 'd' and ${notExt('pg_type', 't.oid')} order by 1`,
  ))
    add({
      kind: 'domain', key: `domain:${d.name}`, name: d.name,
      ddl: `create domain ${id(d.name)} as ${d.base}${d.collation ? ` collate ${d.collation}` : ''}${d.def !== null ? ` default ${d.def}` : ''}${d.notnull ? ' not null' : ''}${d.checks.map((k) => `\n  ${k}`).join('')};`,
    });

  // ---- sequences: not those of identity columns (the column creates them)
  for (const s of await q<{ name: string; type: string; inc: string; min: string; max: string; start: string; cache: string; cycle: boolean; owner: string | null }>(
    `select c.relname as name, format_type(s.seqtypid, null) as type, s.seqincrement::text as inc, s.seqmin::text as min, s.seqmax::text as max,
            s.seqstart::text as start, s.seqcache::text as cache, s.seqcycle as cycle,
            (select quote_ident(t.relname) || '.' || quote_ident(a.attname)
               from pg_depend d join pg_class t on t.oid = d.refobjid join pg_attribute a on a.attrelid = t.oid and a.attnum = d.refobjsubid
              where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.refclassid = 'pg_class'::regclass and d.deptype = 'a' and t.relnamespace = $1) as owner
       from pg_class c join pg_sequence s on s.seqrelid = c.oid
      where c.relnamespace = $1 and c.relkind = 'S' and ${notExt('pg_class', 'c.oid')}
        and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'i')
      order by 1`,
  )) {
    add({ kind: 'sequence', key: `sequence:${s.name}`, name: s.name, ddl: `create sequence ${id(s.name)} as ${s.type} increment by ${s.inc} minvalue ${s.min} maxvalue ${s.max} start with ${s.start} cache ${s.cache}${s.cycle ? ' cycle' : ''};` });
    if (s.owner) add({ kind: 'sequence owner', key: `sequence owner:${s.name}`, name: s.name, ddl: `alter sequence ${id(s.name)} owned by ${s.owner};` });
  }

  // ---- tables (partitioned ones before their partitions)
  const tables = await q<{ oid: number; name: string; kind: string; unlogged: boolean; partkey: string | null; parent: string | null; bound: string | null; rls: boolean; force: boolean; options: string[] | null }>(
    `select c.oid, c.relname as name, c.relkind as kind, c.relpersistence = 'u' as unlogged,
            case when c.relkind = 'p' then pg_get_partkeydef(c.oid) end as partkey,
            (select p.relname from pg_inherits i join pg_class p on p.oid = i.inhparent where i.inhrelid = c.oid and c.relispartition) as parent,
            case when c.relispartition then pg_get_expr(c.relpartbound, c.oid) end as bound,
            c.relrowsecurity as rls, c.relforcerowsecurity as force, c.reloptions as options
       from pg_class c where c.relnamespace = $1 and c.relkind in ('r', 'p') and ${notExt('pg_class', 'c.oid')}
      order by c.relispartition, c.relname`,
  );
  for (const t of tables) {
    const cols = await q<{ name: string; type: string; notnull: boolean; def: string | null; identity: string; generated: string; collation: string | null; inherited: boolean }>(
      `select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as notnull,
              pg_get_expr(d.adbin, d.adrelid) as def, a.attidentity as identity, a.attgenerated as generated, a.attislocal = false as inherited,
              case when a.attcollation <> 0 and a.attcollation <> (select typcollation from pg_type where oid = a.atttypid)
                   then (select quote_ident(collname) from pg_collation where oid = a.attcollation) end as collation
         from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        where a.attrelid = $1 and a.attnum > 0 and not a.attisdropped order by a.attnum`,
      [t.oid],
    );
    const columns: Column[] = cols.map((x) => {
      const def = x.generated === 's' ? null : x.def;
      const parts = [
        `${id(x.name)} ${x.type}`,
        x.collation ? `collate ${x.collation}` : '',
        x.generated === 's' ? `generated always as (${x.def}) stored` : '',
        x.identity === 'a' ? 'generated always as identity' : x.identity === 'd' ? 'generated by default as identity' : '',
        def !== null && !x.identity ? `default ${def}` : '',
        x.notnull ? 'not null' : '',
      ].filter(Boolean);
      return { name: x.name, type: x.type, notNull: x.notnull, default: x.identity ? `identity ${x.identity}` : x.generated === 's' ? `generated ${x.def}` : def, definition: parts.join(' ') };
    });
    const opts = t.options?.length ? ` with (${t.options.join(', ')})` : '';
    const ddl = t.parent
      ? `create${t.unlogged ? ' unlogged' : ''} table ${id(t.name)} partition of ${id(t.parent)} ${t.bound}${t.partkey ? ` partition by ${t.partkey}` : ''}${opts};`
      : `create${t.unlogged ? ' unlogged' : ''} table ${id(t.name)} (\n${columns.map((x) => `  ${x.definition}`).join(',\n')}\n)${t.partkey ? ` partition by ${t.partkey}` : ''}${opts};`;
    // a comparison ignores the order of the columns
    const compareAs = t.parent ? undefined : ddl.replace(/\(\n[\s\S]*\n\)/, `(\n${columns.map((x) => `  ${x.definition}`).sort().join(',\n')}\n)`);
    add({ kind: 'table', key: `table:${t.name}`, name: t.name, ddl, columns: t.parent ? undefined : columns, compareAs });
    if (t.rls || t.force)
      add({ kind: 'rls', key: `rls:${t.name}`, name: t.name, table: t.name,
            ddl: [t.rls ? `alter table ${id(t.name)} enable row level security;` : '', t.force ? `alter table ${id(t.name)} force row level security;` : ''].filter(Boolean).join('\n') });
  }

  // ---- constraints (a partition's inherited ones come with it)
  for (const k of await q<{ table: string; name: string; type: string; def: string }>(
    `select t.relname as table, k.conname as name, k.contype as type, pg_get_constraintdef(k.oid) as def
       from pg_constraint k join pg_class t on t.oid = k.conrelid
      where t.relnamespace = $1 and t.relkind in ('r', 'p') and k.contype in ('p', 'u', 'c', 'x', 'f') and k.conislocal and ${notExt('pg_class', 't.oid')}
        and (k.conparentid = 0 or k.conparentid is null)
      order by t.relname, k.contype, k.conname`,
  ))
    add({
      kind: k.type === 'f' ? 'foreign key' : 'constraint', key: `${k.type === 'f' ? 'foreign key' : 'constraint'}:${k.table}.${k.name}`, name: `${k.table}.${k.name}`, table: k.table,
      ddl: `alter table ${id(k.table)} add constraint ${id(k.name)} ${k.def};`,
    });

  // ---- indexes that no constraint makes, not on partitions (the partitioned table's index makes them)
  for (const i of await q<{ table: string; name: string; def: string }>(
    `select t.relname as table, ic.relname as name, pg_get_indexdef(ic.oid) as def
       from pg_index x join pg_class ic on ic.oid = x.indexrelid join pg_class t on t.oid = x.indrelid
      where t.relnamespace = $1 and t.relkind in ('r', 'p', 'm') and not exists (select 1 from pg_constraint k where k.conindid = ic.oid and k.contype in ('p', 'u', 'x'))
        and not t.relispartition and ${notExt('pg_class', 't.oid')}
      order by t.relname, ic.relname`,
  ))
    add({ kind: 'index', key: `index:${i.name}`, name: i.name, table: i.table, ddl: `${unqualify(i.def, / ON (ONLY )?\S+ USING /)};` });

  // ---- functions and procedures (SQL-standard bodies after the tables)
  for (const f of await q<{ sig: string; def: string; atomic: boolean }>(
    `select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig, pg_get_functiondef(p.oid) as def, p.prosqlbody is not null as atomic
       from pg_proc p where p.pronamespace = $1 and p.prokind in ('f', 'p', 'w') and ${notExt('pg_proc', 'p.oid')}
      order by 1`,
  ))
    add({ kind: 'function', key: `function:${f.sig}`, name: f.sig, ddl: end(unqualify(f.def, /^CREATE OR REPLACE (FUNCTION|PROCEDURE) \S+?\(/)), order: f.atomic ? 1 : 0 });

  // ---- views and materialized views, in dependency order
  const views = await q<{ oid: number; name: string; kind: string; def: string; options: string[] | null; deps: number[] }>(
    `select c.oid, c.relname as name, c.relkind as kind, pg_get_viewdef(c.oid, true) as def, c.reloptions as options,
            array(select distinct d.refobjid::int from pg_rewrite r join pg_depend d on d.classid = 'pg_rewrite'::regclass and d.objid = r.oid
                   where r.ev_class = c.oid and d.refobjid <> c.oid and d.refclassid = 'pg_class'::regclass) as deps
       from pg_class c where c.relnamespace = $1 and c.relkind in ('v', 'm') and ${notExt('pg_class', 'c.oid')}
      order by c.relname`,
  );
  const position = new Map<number, number>();
  const visit = (v: (typeof views)[number], seen: Set<number>): number => {
    if (position.has(v.oid)) return position.get(v.oid)!;
    if (seen.has(v.oid)) return 0;
    seen.add(v.oid);
    const after = Math.max(0, ...v.deps.map((d) => views.find((x) => x.oid === d)).filter((x): x is (typeof views)[number] => !!x).map((x) => visit(x, seen) + 1));
    position.set(v.oid, after);
    return after;
  };
  for (const v of views) {
    const opts = v.options?.length ? ` with (${v.options.join(', ')})` : '';
    const body = v.def.trim().replace(/;$/, '');
    add({
      kind: v.kind === 'm' ? 'materialized view' : 'view', key: `${v.kind === 'm' ? 'materialized view' : 'view'}:${v.name}`, name: v.name, order: visit(v, new Set()),
      ddl: v.kind === 'm' ? `create materialized view ${id(v.name)}${opts} as\n${body}\nwith no data;` : `create or replace view ${id(v.name)}${opts} as\n${body};`,
    });
  }

  // ---- triggers
  for (const t of await q<{ table: string; name: string; def: string }>(
    `select c.relname as table, g.tgname as name, pg_get_triggerdef(g.oid, true) as def
       from pg_trigger g join pg_class c on c.oid = g.tgrelid
      where c.relnamespace = $1 and not g.tgisinternal and g.tgparentid = 0 and ${notExt('pg_class', 'c.oid')}
      order by 1, 2`,
  ))
    add({ kind: 'trigger', key: `trigger:${t.table}.${t.name}`, name: `${t.table}.${t.name}`, table: t.table, ddl: `${t.def};` });

  // ---- row level security policies
  for (const p of await q<{ table: string; name: string; permissive: boolean; cmd: string; roles: string[]; using: string | null; check: string | null }>(
    `select c.relname as table, p.polname as name, p.polpermissive as permissive, p.polcmd::text as cmd,
            array(select case when r = 0 then 'public' else quote_ident(pg_get_userbyid(r)) end from unnest(p.polroles) r order by 1) as roles,
            pg_get_expr(p.polqual, p.polrelid) as using, pg_get_expr(p.polwithcheck, p.polrelid) as check
       from pg_policy p join pg_class c on c.oid = p.polrelid where c.relnamespace = $1 order by 1, 2`,
  )) {
    const cmd = { r: 'select', a: 'insert', w: 'update', d: 'delete', '*': 'all' }[p.cmd] ?? 'all';
    add({
      kind: 'policy', key: `policy:${p.table}.${p.name}`, name: `${p.table}.${p.name}`, table: p.table,
      ddl: `create policy ${id(p.name)} on ${id(p.table)} as ${p.permissive ? 'permissive' : 'restrictive'} for ${cmd} to ${p.roles.join(', ')}${p.using ? `\n  using (${p.using})` : ''}${p.check ? `\n  with check (${p.check})` : ''};`,
    });
  }

  // ---- comments
  for (const m of await q<{ what: string; target: string; text: string }>(
    `select case c.relkind when 'v' then 'view' when 'm' then 'materialized view' when 'S' then 'sequence' else 'table' end as what,
            quote_ident(c.relname) as target, d.description as text
       from pg_description d join pg_class c on c.oid = d.objoid and d.classoid = 'pg_class'::regclass and d.objsubid = 0
      where c.relnamespace = $1 and c.relkind in ('r', 'p', 'v', 'm', 'S') and ${notExt('pg_class', 'c.oid')}
     union all
     select 'column', quote_ident(c.relname) || '.' || quote_ident(a.attname), d.description
       from pg_description d join pg_class c on c.oid = d.objoid and d.classoid = 'pg_class'::regclass
       join pg_attribute a on a.attrelid = c.oid and a.attnum = d.objsubid
      where c.relnamespace = $1 and d.objsubid > 0 and ${notExt('pg_class', 'c.oid')}
     union all
     select case p.prokind when 'p' then 'procedure' else 'function' end, quote_ident(p.proname) || '(' || pg_get_function_identity_arguments(p.oid) || ')', d.description
       from pg_description d join pg_proc p on p.oid = d.objoid and d.classoid = 'pg_proc'::regclass
      where p.pronamespace = $1 and ${notExt('pg_proc', 'p.oid')}
     union all
     select case t.typtype when 'd' then 'domain' else 'type' end, quote_ident(t.typname), d.description
       from pg_description d join pg_type t on t.oid = d.objoid and d.classoid = 'pg_type'::regclass
      where t.typnamespace = $1 and ${notExt('pg_type', 't.oid')}
     order by 1, 2`,
  ))
    add({ kind: 'comment', key: `comment:${m.what} ${m.target}`, name: `${m.what} ${m.target}`, ddl: `comment on ${m.what} ${m.target} is ${lit(m.text)};` });

  // ---- functions that PUBLIC may not run (by default it may): the revoke comes first
  for (const f of await q<{ what: string; sig: string }>(
    `select case p.prokind when 'p' then 'procedure' else 'function' end as what,
            quote_ident(p.proname) || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig
       from pg_proc p
      where p.pronamespace = $1 and p.proacl is not null and ${notExt('pg_proc', 'p.oid')}
        and not exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')
      order by 2`,
  ))
    add({ kind: 'grant', key: `grant:${f.what} ${f.sig} public`, name: `${f.what} ${f.sig} not to public`, ddl: `revoke execute on ${f.what} ${f.sig} from public;` });

  // ---- grants (owners' own privileges are not repeated)
  for (const g of await q<{ what: string; target: string; grantee: string; privs: string[]; grantable: boolean }>(
    `select x.what, x.target, case when a.grantee = 0 then 'public' else quote_ident(pg_get_userbyid(a.grantee)) end as grantee,
            array_agg(a.privilege_type order by a.privilege_type) as privs, bool_and(a.is_grantable) as grantable
       from (select case when c.relkind = 'S' then 'sequence' else 'table' end as what, quote_ident(c.relname) as target, c.relacl as acl, c.relowner as owner
               from pg_class c where c.relnamespace = $1 and c.relkind in ('r', 'p', 'v', 'm', 'S') and c.relacl is not null and ${notExt('pg_class', 'c.oid')}
             union all
             select case p.prokind when 'p' then 'procedure' else 'function' end, quote_ident(p.proname) || '(' || pg_get_function_identity_arguments(p.oid) || ')', p.proacl, p.proowner
               from pg_proc p where p.pronamespace = $1 and p.proacl is not null and ${notExt('pg_proc', 'p.oid')}) x,
            aclexplode(x.acl) a
      where a.grantee <> x.owner
      group by x.what, x.target, a.grantee
      order by 1, 2, 3`,
  ))
    add({ kind: 'grant', key: `grant:${g.what} ${g.target} ${g.grantee}`, name: `${g.what} ${g.target} to ${g.grantee}`, ddl: `grant ${g.privs.join(', ').toLowerCase()} on ${g.what === 'table' ? 'table ' : g.what === 'sequence' ? 'sequence ' : `${g.what} `}${g.target} to ${g.grantee}${g.grantable ? ' with grant option' : ''};` });

  return out;
}

/** Order objects for a script. */
export function scriptOrder(objects: DdlObject[]) {
  const rank = (o: DdlObject) => {
    if (o.kind === 'function') return o.order === 0 ? KINDS.indexOf('sequence') + 0.5 : KINDS.indexOf('table') + 0.5;
    return KINDS.indexOf(o.kind);
  };
  return [...objects].sort((a, b) => rank(a) - rank(b) || a.order - b.order || a.key.localeCompare(b.key));
}

/** Keep the chosen object types (and comments, grants when asked). */
export function pick(objects: DdlObject[], types: Set<string>, o: { comments: boolean; grants: boolean }) {
  return objects.filter((x) => {
    const t = TYPE_OF[x.kind];
    if (t === 'comments') return o.comments;
    if (t === 'grants') return o.grants;
    return types.has(t);
  });
}

const HEADER = (title: string, schema: string) => `-- ${title}
-- Generated by pgkiln on ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC. Review before running.
set check_function_bodies = off;
create schema if not exists ${id(schema)};
set search_path = ${id(schema)}, pg_catalog;
`;

/** A script that creates the objects in the schema. */
export function ddlScript(schema: string, objects: DdlObject[]) {
  let last = '';
  const parts = scriptOrder(objects).map((o) => {
    const head = o.kind !== last ? `\n-- ${heading(o.kind)}\n` : '';
    last = o.kind;
    return `${head}${o.ddl}`;
  });
  return `${HEADER(`DDL of schema ${schema}`, schema)}${parts.join('\n')}\n`;
}

// ---------------------------------------------------------------- comparison

export interface Difference {
  key: string;
  kind: Kind;
  name: string;
  /** in the source only, the target only, or in both but different */
  state: 'source' | 'target' | 'different';
  source?: string;
  target?: string;
}

export function compare(source: DdlObject[], target: DdlObject[]): { differences: Difference[]; same: number } {
  const t = new Map(target.map((x) => [x.key, x]));
  const s = new Map(source.map((x) => [x.key, x]));
  const differences: Difference[] = [];
  let same = 0;
  for (const a of source) {
    const b = t.get(a.key);
    if (!b) differences.push({ key: a.key, kind: a.kind, name: a.name, state: 'source', source: a.ddl });
    else if ((a.compareAs ?? a.ddl) !== (b.compareAs ?? b.ddl)) differences.push({ key: a.key, kind: a.kind, name: a.name, state: 'different', source: a.ddl, target: b.ddl });
    else same++;
  }
  for (const b of target) if (!s.has(b.key)) differences.push({ key: b.key, kind: b.kind, name: b.name, state: 'target', target: b.ddl });
  const rank = (d: Difference) => KINDS.indexOf(d.kind);
  differences.sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key));
  return { differences, same };
}

/** Drop statements of an object, for a change script. */
function dropOf(o: DdlObject): string | null {
  switch (o.kind) {
    case 'type': return `drop type ${id(o.name)};`;
    case 'domain': return `drop domain ${id(o.name)};`;
    case 'sequence': return `drop sequence ${id(o.name)};`;
    case 'table': return `drop table ${id(o.name)};`;
    case 'view': return `drop view ${id(o.name)};`;
    case 'materialized view': return `drop materialized view ${id(o.name)};`;
    case 'function': return `drop routine ${o.name.replace(/^([^(]+)/, (m) => id(m))};`;
    case 'constraint':
    case 'foreign key': return `alter table ${id(o.table!)} drop constraint ${id(o.name.slice(o.table!.length + 1))};`;
    case 'index': return `drop index ${id(o.name)};`;
    case 'trigger': return `drop trigger ${id(o.name.slice(o.table!.length + 1))} on ${id(o.table!)};`;
    case 'policy': return `drop policy ${id(o.name.slice(o.table!.length + 1))} on ${id(o.table!)};`;
    case 'rls': return `alter table ${id(o.table!)} disable row level security;\nalter table ${id(o.table!)} no force row level security;`;
    case 'sequence owner': return `alter sequence ${id(o.name)} owned by none;`;
    case 'comment': return `comment on ${o.name} is null;`;
    case 'grant': {
      const r = /^revoke (.+) on (.+) from public;$/s.exec(o.ddl);
      if (r) return `grant ${r[1]} on ${r[2]} to public;`;
      const m = /^grant (.+) on (.+) to (\S+?)( with grant option)?;$/s.exec(o.ddl);
      return m ? `revoke ${m[1]} on ${m[2]} from ${m[3]};` : null;
    }
  }
  return null;
}

/** A table's changes, column by column (the rest of a table: its constraints, indexes … are objects of their own). */
function alterTable(a: DdlObject, b: DdlObject): { sql: string[]; review: string[] } {
  const sql: string[] = [];
  const review: string[] = [];
  const t = id(a.name);
  if (!a.columns || !b.columns) return { sql, review: [`-- table ${a.name} differs (partitioning or options): compare by hand.`] };
  const bc = new Map(b.columns.map((x) => [x.name, x]));
  const ac = new Map(a.columns.map((x) => [x.name, x]));
  for (const x of a.columns) {
    const y = bc.get(x.name);
    if (!y) {
      sql.push(`alter table ${t} add column ${x.definition};`);
      continue;
    }
    if (x.definition === y.definition) continue;
    if (x.default?.startsWith('identity') || y.default?.startsWith('identity') || x.default?.startsWith('generated') || y.default?.startsWith('generated')) {
      review.push(`-- column ${a.name}.${x.name}: ${y.definition}  →  ${x.definition} (identity or generated: change by hand)`);
      continue;
    }
    if (x.type !== y.type) sql.push(`alter table ${t} alter column ${id(x.name)} type ${x.type};`);
    if (x.default !== y.default) sql.push(x.default === null ? `alter table ${t} alter column ${id(x.name)} drop default;` : `alter table ${t} alter column ${id(x.name)} set default ${x.default};`);
    if (x.notNull !== y.notNull) sql.push(`alter table ${t} alter column ${id(x.name)} ${x.notNull ? 'set' : 'drop'} not null;`);
    if (x.definition.includes(' collate ') || y.definition.includes(' collate ')) review.push(`-- column ${a.name}.${x.name}: the collation differs`);
  }
  for (const y of b.columns) if (!ac.has(y.name)) review.push(`-- alter table ${t} drop column ${id(y.name)};`);
  if (a.columns.map((x) => x.name).filter((n) => bc.has(n)).join() !== b.columns.map((x) => x.name).filter((n) => ac.has(n)).join())
    review.push(`-- table ${a.name}: the columns are in another order (not changed)`);
  return { sql, review };
}

/**
 * A script that makes the target schema like the source: what the source has and the target hasn't
 * is created, what differs is replaced (functions and views in place, constraints, indexes, triggers,
 * policies, grants and materialized views dropped and created again, tables column by column), and
 * what only the target has is dropped, commented out: review it. Types, domains and sequences that
 * differ are left for review (tables may use them).
 */
export function changeScript(sourceName: string, targetName: string, source: DdlObject[], target: DdlObject[]) {
  const { differences } = compare(source, target);
  const s = new Map(source.map((x) => [x.key, x]));
  const t = new Map(target.map((x) => [x.key, x]));
  const create: DdlObject[] = [];
  const first: string[] = [];
  const alters: string[] = [];
  const reviews: string[] = [];
  const gone: string[] = [];
  const comment = (sql: string) => sql.split('\n').map((l) => `-- ${l}`).join('\n');
  for (const d of differences) {
    const a = s.get(d.key);
    const b = t.get(d.key);
    if (d.state === 'source') create.push(a!);
    else if (d.state === 'target') {
      const sql = dropOf(b!);
      if (sql) gone.push(comment(sql));
    } else if (a!.kind === 'table') {
      const r = alterTable(a!, b!);
      alters.push(...r.sql);
      reviews.push(...r.review);
    } else if (a!.kind === 'function' || a!.kind === 'view' || a!.kind === 'comment' || a!.kind === 'sequence owner') {
      create.push(a!);
    } else if (a!.kind === 'type' || a!.kind === 'domain' || a!.kind === 'sequence') {
      reviews.push(`-- ${a!.kind} ${a!.name} differs; in ${targetName}:`, comment(b!.ddl), `-- in ${sourceName}:`, comment(a!.ddl));
    } else {
      const sql = dropOf(b!);
      if (sql) first.push(sql);
      create.push(a!);
    }
  }
  const lines = [HEADER(`Make schema ${targetName} like ${sourceName}`, targetName).replace(/create schema if not exists [^\n]+\n/, '')];
  if (!differences.length) lines.push('-- the schemas are the same: nothing to change');
  if (first.length) lines.push('-- replaced objects: the old ones first', ...first);
  if (alters.length) lines.push('', '-- changed tables', ...alters);
  let last = '';
  for (const o of scriptOrder(create)) {
    if (o.kind !== last) lines.push('', `-- ${heading(o.kind)}`);
    last = o.kind;
    lines.push(o.ddl);
  }
  if (reviews.length) lines.push('', '-- review: not changed by this script', ...reviews);
  if (gone.length) lines.push('', `-- only in ${targetName}: dropped when you remove the comment marks`, ...gone);
  return `${lines.join('\n')}\n`;
}
