// (sprint 192, NX-F5) "From Oracle to pgkiln": which database objects an imported APEX application uses, and which
// of them the target PostgreSQL schema doesn't have yet.
//
// An APEX export holds no tables, views, sequences, packages or data: they move with ora2pg (chapter 11). The importer
// (src/apeximport.ts) records per report entry what it uses (`uses`): tables and views from region sources,
// table-based regions, forms, grids, lists of values, chart series, cards, calendars and DML in PL/SQL; columns where it
// knows them (form items, grid columns, lists of values on a table, chart, card, calendar and facet columns of a
// one-table query); sequences (seq.nextval); and PL/SQL routines (Invoke API, pkg.proc(...) calls). apexCheck() then
// reads only the target database's catalogue (pg_catalog: nothing of the export runs) and notes what is missing on
// each entry (`missing`, a note, so the Team Development issues name it too). A package routine that ora2pg already
// converted (PACKAGE_AS_SCHEMA 1: schema pkg, function proc; 0: pkg_proc) is pointed at instead of "port this".

import { codeMask } from './oracle-sql.ts';

export interface Uses {
  /** schema.table (or table without a schema) */
  tables: string[];
  /** schema.table.column */
  columns: string[];
  /** schema.sequence */
  sequences: string[];
  /** pkg.proc or proc, as the APEX code names them (lower case) */
  routines: string[];
}

export const emptyUses = (): Uses => ({ tables: [], columns: [], sequences: [], routines: [] });

const KEYWORDS = new Set([
  'select', 'from', 'where', 'group', 'order', 'by', 'having', 'join', 'inner', 'left', 'right', 'full', 'outer', 'cross',
  'natural', 'on', 'using', 'union', 'all', 'minus', 'except', 'intersect', 'connect', 'start', 'with', 'fetch', 'offset',
  'limit', 'for', 'pivot', 'unpivot', 'model', 'partition', 'window', 'as', 'set', 'values', 'returning', 'return', 'into',
  'then', 'else', 'end', 'when', 'and', 'or', 'not', 'lateral', 'table', 'only', 'sample', 'loop', 'begin', 'is', 'in',
  'case', 'if', 'elsif', 'exception', 'declare', 'log', 'errors', 'nocycle', 'prior', 'distinct', 'unique', 'top',
]);
/** Oracle and APEX objects: not the application's own (no PostgreSQL table to make) */
const SYSTEM = /^(dual|sys|apex_[a-z0-9_$#]*|wwv_[a-z0-9_$#]*|htp|htf|owa|owa_[a-z_]+|dbms_[a-z_]+|utl_[a-z_]+|user_[a-z_]+|all_[a-z_]+|dba_[a-z_]+|v\$[a-z_]+|nls_[a-z_]+|json_[a-z_]+|xml[a-z_]*|standard|ctx_[a-z_]+|sdo_[a-z_]+|apex)$/;
/** functions whose argument list has FROM inside (extract(year from d), trim(x from y) …) */
const FROM_FUNCTIONS = new Set(['extract', 'trim', 'substring', 'overlay', 'position', 'cast']);

type Tok = { t: string; kind: 'word' | 'punct'; at: number };

/** "EMP" (quoted, upper case) is Oracle's EMP: read as emp (the mask would blank it) */
const unquote = (sql: string) => sql.replace(/"([A-Z_][A-Z0-9_$#]*)"/g, (_, n: string) => ` ${n.toLowerCase()} `);

function tokens(sql: string): Tok[] {
  const out: Tok[] = [];
  const re = /([A-Za-z_][A-Za-z0-9_$#]*(?:\s*\.\s*[A-Za-z_][A-Za-z0-9_$#]*)*)|(:[A-Za-z_][\w$#]*)|(&[A-Za-z_][\w$#]*\.)|(\d+(?:\.\d+)?)|([(),;])|(\S)/g;
  for (const m of codeMask(unquote(sql)).matchAll(re)) {
    if (m[1]) out.push({ t: m[1].replace(/\s+/g, '').toLowerCase(), kind: 'word', at: m.index! });
    else out.push({ t: m[5] ?? m[0], kind: 'punct', at: m.index! });
  }
  return out;
}

/**
 * The tables, sequences and routine calls a SQL or PL/SQL text names (lower case, as written: unqualified names stay
 * unqualified). Static: a reading of FROM/JOIN lists and DML targets, not a parser; good enough for a check that a
 * person reads.
 */
export function sqlObjects(sql: string | null | undefined): { tables: string[]; sequences: string[]; routines: string[] } {
  const o = scanSql(sql);
  return { tables: o.tables, sequences: o.sequences, routines: o.routines };
}

/**
 * (sprint 192) Unqualified table names of a query qualified with the schema: in APEX they are the parsing schema's,
 * and an application's role in pgkiln has no search_path of its own. n: how many were qualified.
 */
export function qualifyTables(sql: string, schema: string): { sql: string; n: number } {
  if (!schema || !/^[a-z_][a-z0-9_$]*$/.test(schema)) return { sql, n: 0 };
  const at = scanSql(sql).unqualified;
  let text = sql;
  for (const [pos, len] of [...at].sort((a, b) => b[0] - a[0])) text = `${text.slice(0, pos)}${schema}.${text.slice(pos, pos + len).replace(/^"|"$/g, '').toLowerCase()}${text.slice(pos + len)}`;
  return { sql: text, n: at.length };
}

function scanSql(sql: string | null | undefined): { tables: string[]; sequences: string[]; routines: string[]; unqualified: [number, number][] } {
  const unqualified: [number, number][] = [];
  const tables = new Set<string>();
  const sequences = new Set<string>();
  const routines = new Set<string>();
  if (!sql || sql.length > 200_000) return { tables: [], sequences: [], routines: [], unqualified };
  const masked = codeMask(unquote(sql));
  const ctes = new Set<string>();
  for (const m of masked.matchAll(/\b([A-Za-z_][\w$#]*)\s*(?:\([^()]*\))?\s+as\s*(?:not\s+)?(?:materialized\s+)?\(/gi)) ctes.add(m[1].toLowerCase());
  const tk = tokens(sql);
  const stack: string[] = [];
  const isName = (x: Tok | undefined) => !!x && x.kind === 'word' && !KEYWORDS.has(x.t.split('.')[0]) && !/\.(nextval|currval)$/.test(x.t);
  const table = (x: Tok) => {
    const name = x.t;
    if (/^(sys\.)?dual$/.test(name)) return;
    if (!name.includes('.') && ctes.has(name)) return;
    if (name.split('.').length > 2) return;
    tables.add(name);
    // APEX's own views (apex_collections …) stay unqualified: no schema has them
    if (!name.includes('.') && !/^apex_/.test(name)) {
      const from = sql[x.at - 1] === '"' ? x.at - 1 : x.at;
      unqualified.push([from, sql.slice(from).match(/^"?[A-Za-z_][\w$#]*"?/)![0].length]);
    }
  };
  /** the table list after FROM (comma joins) or the one table after JOIN/UPDATE/INTO */
  const tableList = (i: number, list: boolean) => {
    for (;;) {
      const x = tk[i];
      if (!isName(x) || (list && tk[i + 1]?.t === '(')) return;
      table(x);
      i++;
      if (tk[i]?.t === 'as') i++;
      if (isName(tk[i]) && tk[i + 1]?.t !== '(') i++; // an alias
      if (!list || tk[i]?.t !== ',') return;
      i++;
    }
  };
  for (let i = 0; i < tk.length; i++) {
    const x = tk[i];
    if (x.t === '(') {
      stack.push(tk[i - 1]?.kind === 'word' ? tk[i - 1].t : '');
      continue;
    }
    if (x.t === ')') {
      stack.pop();
      continue;
    }
    if (x.kind !== 'word') continue;
    const prev = tk[i - 1]?.t;
    const m = /^(?:([a-z_][\w$#]*)\.)?([a-z_][\w$#]*)\.(nextval|currval)$/.exec(x.t);
    if (m) {
      if (!SYSTEM.test(m[2])) sequences.add(m[1] ? `${m[1]}.${m[2]}` : m[2]);
      continue;
    }
    if (x.t === 'from' && !FROM_FUNCTIONS.has(stack[stack.length - 1] ?? '')) tableList(i + 1, true);
    else if (x.t === 'join') {
      if (tk[i + 2]?.t !== '(') tableList(i + 1, false);
    }
    else if (x.t === 'update' && prev !== 'for' && prev !== 'do' && prev !== 'of' && tk[i + 1]?.t !== 'set') tableList(i + 1, false);
    else if (x.t === 'into' && (prev === 'insert' || prev === 'merge' || prev === 'all')) tableList(i + 1, false);
    else if (x.t === 'using' && tk.slice(Math.max(0, i - 12), i).some((y) => y.t === 'merge')) tableList(i + 1, false);
    else if (x.t.includes('.') && (tk[i + 1]?.t === '(' || ((tk[i + 1]?.t === ';' || tk[i + 1] === undefined) && /^(;|begin|then|else|loop)?$/.test(prev ?? '')))) {
      // pkg.proc(…) or schema.pkg.proc(…); a bare "pkg.proc;" statement
      const parts = x.t.split('.');
      if (parts.length > 3 || parts.some((p) => SYSTEM.test(p))) continue;
      if (prev === 'from' || prev === 'join') continue;
      routines.add(parts.slice(-2).join('.'));
    }
  }
  return { tables: [...tables], sequences: [...sequences], routines: [...routines], unqualified };
}

/**
 * The column a region reads from its query, as schema.table.column, when the query reads exactly one table and doesn't
 * make a column of that name itself (an alias): else null (not checked).
 */
export function soleTableColumn(sql: string | null | undefined, column: string, qualify: (t: string) => string): string | null {
  if (!sql || !column) return null;
  const col = column.toLowerCase();
  if (!/^[a-z_][a-z0-9_$#]*$/.test(col)) return null;
  const o = sqlObjects(sql);
  if (o.tables.length !== 1) return null;
  const masked = codeMask(unquote(sql)).toLowerCase();
  if (/\bunion\b|\bminus\b|\bexcept\b|\bintersect\b/.test(masked)) return null;
  const esc = col.replace(/\$/g, '\\$');
  // "… as col", ") col," "' col" (an expression named col): the query makes it
  if (new RegExp(`\\bas\\s+${esc}\\b|[)'\\d]\\s*${esc}\\s*(,|\\bfrom\\b)|\\|\\|[^,]*\\s${esc}\\s*(,|\\bfrom\\b)`).test(masked)) return null;
  return `${qualify(o.tables[0])}.${col}`;
}

// ------------------------------------------------------------------ the check against a database

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export interface CheckEntry {
  kind: string;
  page: number | null;
  name: string;
  uses?: Uses;
  missing?: string[];
  hints?: string[];
  notes: string[];
  port: boolean;
}

export interface MissingObject {
  type: 'table' | 'apex_view' | 'column' | 'sequence' | 'routine';
  name: string;
  /** components that use it: "page 3 region Employees" */
  usedBy: string[];
}

export interface CheckResult {
  /** the schema unqualified names were looked up in ('' : the search path) */
  schema: string;
  /** how many distinct objects of each type the application uses */
  used: { tables: number; columns: number; sequences: number; routines: number };
  missing: MissingObject[];
  /** routines the application calls that exist in PostgreSQL (ported, or converted by ora2pg): name → the function found */
  found: { name: string; as: string; usedBy: string[] }[];
}

const KINDS: Record<string, string> = { lov: 'list of values', authorization: 'authorization scheme', dynamic_action: 'dynamic action' };
const who = (e: CheckEntry) => `${e.page !== null ? `page ${e.page} ` : ''}${KINDS[e.kind] ?? e.kind} ${e.name}`;

/**
 * Looks every object the report's entries use up in the target database's catalogue (read only) and adds `missing`,
 * `hints` and a note to the entries concerned. Unqualified names are looked up in `schema` ('' : the search path).
 */
export async function apexCheck(db: Queryable, report: { entries: CheckEntry[]; application: { schema: string } }, opts: { schema?: string | null } = {}): Promise<CheckResult> {
  const schema = (opts.schema ?? report.application.schema ?? '').trim().toLowerCase();
  const q = (n: string) => (n.includes('.') || !schema ? n : `${schema}.${n}`);
  const users = { tables: new Map<string, CheckEntry[]>(), columns: new Map<string, CheckEntry[]>(), sequences: new Map<string, CheckEntry[]>(), routines: new Map<string, CheckEntry[]>() };
  const put = (m: Map<string, CheckEntry[]>, k: string, e: CheckEntry) => m.set(k, [...(m.get(k) ?? []).filter((x) => x !== e), e]);
  for (const e of report.entries) {
    if (!e.uses) continue;
    for (const t of e.uses.tables) put(users.tables, q(t), e);
    for (const c of e.uses.columns) put(users.columns, c.split('.').length === 2 ? q(c.split('.')[0]) + '.' + c.split('.')[1] : c, e);
    for (const s of e.uses.sequences) put(users.sequences, q(s), e);
    for (const r of e.uses.routines) put(users.routines, r, e);
  }
  // the catalogue: relations (tables, views, materialized views, foreign tables), their columns, sequences, routines
  const path = schema ? [schema] : ((await db.query('select current_schemas(false) as s')).rows[0]?.s ?? []);
  const split = (n: string) => (n.includes('.') ? n.split('.') : [null, n]) as [string | null, string];
  const rels = new Set<string>();
  const unq = new Map<string, string>(); // name without a schema → schema.name, through the search path ('' schema)
  const relNames = [...new Set([...users.tables.keys(), ...[...users.columns.keys()].map((c) => c.split('.').slice(0, -1).join('.'))])];
  if (relNames.length) {
    const r = await db.query(
      `select n.nspname as s, c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r','v','m','f','p') and c.relname = any($1::text[])`, [relNames.map((x) => split(x)[1])]);
    for (const row of r.rows) rels.add(`${row.s}.${row.t}`);
    for (const p of [...path].reverse()) for (const row of r.rows) if (row.s === p) unq.set(row.t, `${row.s}.${row.t}`);
  }
  const rel = (n: string) => (n.includes('.') ? (rels.has(n) ? n : null) : unq.get(n) ?? null);
  const cols = new Set<string>();
  const colRels = [...new Set([...users.columns.keys()].map((c) => rel(c.split('.').slice(0, -1).join('.'))).filter(Boolean))] as string[];
  if (colRels.length) {
    const r = await db.query(
      `select n.nspname || '.' || c.relname || '.' || a.attname as k from pg_attribute a join pg_class c on c.oid = a.attrelid
         join pg_namespace n on n.oid = c.relnamespace where a.attnum > 0 and not a.attisdropped and (n.nspname || '.' || c.relname) = any($1::text[])`, [colRels]);
    for (const row of r.rows) cols.add(row.k);
  }
  const seqs = new Set<string>();
  const sequnq = new Map<string, string>();
  if (users.sequences.size) {
    const r = await db.query(`select n.nspname as s, c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind = 'S' and c.relname = any($1::text[])`,
      [[...users.sequences.keys()].map((x) => split(x)[1])]);
    for (const row of r.rows) seqs.add(`${row.s}.${row.t}`);
    for (const p of [...path].reverse()) for (const row of r.rows) if (row.s === p) sequnq.set(row.t, `${row.s}.${row.t}`);
  }
  // routines: pkg.proc as schema pkg, function proc (ora2pg PACKAGE_AS_SCHEMA 1, the default) or pkg_proc in the
  // application's schema (PACKAGE_AS_SCHEMA 0); proc alone in the schema
  const procs = new Map<string, string>(); // schema.name → schema.name(args)
  if (users.routines.size) {
    const names = new Set<string>();
    for (const r of users.routines.keys()) {
      const [p, f] = split(r);
      names.add(f);
      if (p) names.add(`${p}_${f}`);
    }
    const r = await db.query(
      `select n.nspname as s, p.proname as f, pg_get_function_identity_arguments(p.oid) as a from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.proname = any($1::text[]) and n.nspname not in ('pg_catalog', 'information_schema') order by 1, 2, 3`, [[...names]]);
    for (const row of r.rows) if (!procs.has(`${row.s}.${row.f}`)) procs.set(`${row.s}.${row.f}`, `${row.s}.${row.f}(${row.a})`);
  }
  const routineAt = (r: string): string | null => {
    const [p, f] = split(r);
    const schemas = schema ? [schema, ...path.filter((x: string) => x !== schema)] : path;
    if (p) return procs.get(`${p}.${f}`) ?? schemas.map((s: string) => procs.get(`${s}.${p}_${f}`)).find(Boolean) ?? null;
    return schemas.map((s: string) => procs.get(`${s}.${f}`)).find(Boolean) ?? null;
  };

  const missing: MissingObject[] = [];
  const found: CheckResult['found'] = [];
  const miss = (type: MissingObject['type'], name: string, es: CheckEntry[], text: string) => {
    missing.push({ type, name, usedBy: es.map(who) });
    for (const e of es) {
      e.missing = [...new Set([...(e.missing ?? []), `${type} ${name}`])];
      if (!e.notes.includes(text)) e.notes.push(text);
    }
  };
  const apexViews = new Map<string, CheckEntry[]>();
  for (const [t, es] of users.tables) {
    if (rel(t)) continue;
    const last = t.split('.').pop()!;
    // APEX's own views (apex_applications, apex_workspace_apex_users …): ora2pg doesn't move them
    if (/^apex_/.test(last)) for (const e of es) put(apexViews, last, e);
    else miss('table', t, es, `missing in PostgreSQL: table or view ${t} (move it with ora2pg, chapter 11)`);
  }
  for (const [v, es] of apexViews) miss('apex_view', v, es, `APEX view ${v} is not in PostgreSQL: rebuild this on your own tables or pgkiln's (meta.*, chapter 9)`);
  for (const [c, es] of users.columns) {
    const parts = c.split('.');
    if (/^apex_/.test(parts[parts.length - 2])) continue;
    const r = rel(parts.slice(0, -1).join('.'));
    if (r && !cols.has(`${r}.${parts[parts.length - 1]}`)) miss('column', c, es, `missing in PostgreSQL: column ${c}`);
  }
  for (const [s, es] of users.sequences) if (!(s.includes('.') ? seqs.has(s) : sequnq.has(s))) miss('sequence', s, es, `missing in PostgreSQL: sequence ${s}`);
  for (const [r, es] of users.routines) {
    const at = routineAt(r);
    if (at) {
      found.push({ name: r, as: at, usedBy: es.map(who) });
      for (const e of es) {
        const hint = `${r} exists in PostgreSQL as ${at}${at.split('(')[0] !== r ? ' (as ora2pg converts it)' : ''}: call it there and check the conversion`;
        e.hints = [...new Set([...(e.hints ?? []), hint])];
        if (!e.notes.includes(hint)) e.notes.push(hint);
      }
    } else miss('routine', r, es, `missing in PostgreSQL: function or procedure ${r} (ora2pg TYPE PACKAGE/PROCEDURE/FUNCTION, then port it)`);
  }
  const order = { table: 0, apex_view: 1, column: 2, sequence: 3, routine: 4 };
  missing.sort((a, b) => order[a.type] - order[b.type] || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  found.sort((a, b) => (a.name < b.name ? -1 : 1));
  return {
    schema,
    used: { tables: users.tables.size, columns: users.columns.size, sequences: users.sequences.size, routines: users.routines.size },
    missing,
    found,
  };
}

/** The check as text for the command line. */
export function checkText(c: CheckResult): string {
  const u = c.used;
  let out = `\nDatabase objects (schema ${c.schema || '(search path)'}): the application uses ${u.tables} table(s) or view(s), ${u.columns} column(s), ${u.sequences} sequence(s), ${u.routines} PL/SQL routine(s).\n`;
  if (!c.missing.length) out += 'Nothing is missing.\n';
  else {
    out += `Missing in PostgreSQL (${c.missing.length}):\n`;
    for (const m of c.missing) out += `  ${m.type.replace('_', ' ').padEnd(9)} ${m.name}  (${m.usedBy.slice(0, 3).join('; ')}${m.usedBy.length > 3 ? `; ${m.usedBy.length - 3} more` : ''})\n`;
  }
  if (c.found.length) {
    out += 'PL/SQL routines that exist in PostgreSQL:\n';
    for (const f of c.found) out += `  ${f.name} → ${f.as}\n`;
  }
  return out;
}
