import pg from 'pg';

// Quick SQL: APEX's indented shorthand for a data model, turned into
// PostgreSQL DDL. Pure functions (no database), unit tested in
// test/quicksql.test.ts.
//
//   # pk: identity                     settings (also: # settings = { pk: "guid", schema: "app" })
//   departments                        a table (not indented)
//     name /nn /unique                 a column (indented under its table)
//     location vc200                   explicit type
//     employees /auditcols             a child table: indented, with columns of its own;
//       name /nn                       gets department_id references departments
//       email /lower [work address]    [comment] → comment on column
//       hired_at                       types inferred from names: *_at → timestamptz
//       status /check active, left /default active
//   view emp_v departments employees   a view joining tables by their foreign keys
//
// Comments: -- to the end of the line.

export interface QuickSqlWarning {
  line: number;
  message: string;
}

export interface QuickSqlColumn {
  name: string;
  type: string;
  notNull: boolean;
  pk: boolean;
  unique: boolean;
  index: boolean;
  default?: string;
  checks: string[];
  references?: string;
  comment?: string;
  line: number;
}

export interface QuickSqlTable {
  name: string;
  parent?: string;
  columns: QuickSqlColumn[];
  auditCols: boolean;
  comment?: string;
  line: number;
}

export interface QuickSqlView {
  name: string;
  tables: string[];
  line: number;
}

export interface QuickSqlSettings {
  pk: 'identity' | 'seq' | 'guid' | 'none';
  schema?: string;
  prefix?: string;
  drop: boolean;
  auditCols: boolean;
  /** varchar columns: text (default) or varchar(n) as written */
  semantics?: string;
}

export interface QuickSqlModel {
  settings: QuickSqlSettings;
  tables: QuickSqlTable[];
  views: QuickSqlView[];
  warnings: QuickSqlWarning[];
}

/** Largest model accepted (lines). */
export const QUICKSQL_MAX_LINES = 5000;

// ---------------------------------------------------------------- names

// PostgreSQL's reserved key words (those that cannot be a column name unquoted)
const RESERVED = new Set(
  ('all analyse analyze and any array as asc asymmetric authorization binary both case cast check collate collation column concurrently constraint create ' +
    'cross current_catalog current_date current_role current_schema current_time current_timestamp current_user default deferrable desc distinct do else end ' +
    'except false fetch for foreign freeze from full grant group having ilike in initially inner intersect into is isnull join lateral leading left like limit ' +
    'localtime localtimestamp natural not notnull null offset on only or order outer overlaps placing primary references returning right select session_user ' +
    'similar some symmetric system_user table tablesample then to trailing true union unique user using variadic verbose when where window with').split(' '),
);

/** A lower-case identifier from Quick SQL words ("Cost Center" → cost_center). */
export function qsName(words: string): string {
  let n = words
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .replace(/[^a-z0-9_$]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 63);
  if (!n) n = 'x';
  if (/^[0-9$]/.test(n)) n = `x_${n}`.slice(0, 63);
  return n;
}

/** The identifier as SQL: quoted only when it has to be. */
export const qid = (name: string) => (/^[a-z_][a-z0-9_$]*$/.test(name) && !RESERVED.has(name) ? name : pg.escapeIdentifier(name));

/** departments → department, categories → category, boxes → box, status → status. */
export function singular(name: string): string {
  if (/ies$/.test(name) && name.length > 4) return name.replace(/ies$/, 'y');
  if (/(ss|us|is)$/.test(name)) return name;
  if (/(ches|shes|xes|zes|sses)$/.test(name)) return name.replace(/es$/, '');
  if (/s$/.test(name) && name.length > 2) return name.slice(0, -1);
  return name;
}

// ---------------------------------------------------------------- types

const TYPE_WORDS: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^(?:vc|varchar2?|nvarchar2?|string)\(?(\d{1,5})\)?$/, (m) => `varchar(${m[1]})`],
  [/^(?:vc|varchar2?|string|nvarchar2?)$/, () => 'text'],
  [/^char\(?(\d{1,4})\)?$/, (m) => `char(${m[1]})`],
  [/^(?:num|number|numeric|decimal)\((\d{1,4})(?:,(\d{1,4}))?\)$/, (m) => `numeric(${m[1]}${m[2] ? `,${m[2]}` : ''})`],
  [/^(?:num|number|numeric|decimal)$/, () => 'numeric'],
  [/^(?:int|integer)$/, () => 'integer'],
  [/^bigint$/, () => 'bigint'],
  [/^smallint$/, () => 'smallint'],
  [/^(?:float|real|double|binary_double|binary_float)$/, () => 'double precision'],
  [/^(?:d|date)$/, () => 'date'],
  [/^(?:ts|timestamp)$/, () => 'timestamp'],
  [/^(?:tstz|tswtz|tswltz|timestamptz)$/, () => 'timestamptz'],
  [/^(?:clob|text|long)$/, () => 'text'],
  [/^(?:blob|bytea|binary|file)$/, () => 'bytea'],
  [/^json$/, () => 'json'],
  [/^jsonb$/, () => 'jsonb'],
  [/^(?:bool|boolean|yn)$/, () => 'boolean'],
  [/^(?:uuid|guid)$/, () => 'uuid'],
  [/^interval$/, () => 'interval'],
  [/^time$/, () => 'time'],
];

function typeWord(word: string): string | null {
  const w = word.toLowerCase();
  for (const [re, f] of TYPE_WORDS) {
    const m = re.exec(w);
    if (m) return f(m);
  }
  return null;
}

/** The type of a column from its name, as APEX's Quick SQL infers it. */
export function inferColumnType(name: string): string {
  if (/_id$/.test(name) || name === 'id') return 'bigint';
  if (/(^|_)(is|has|can)_/.test(name) || /_(yn|flag)$/.test(name) || /^(active|enabled|deleted|archived)$/.test(name)) return 'boolean';
  if (/_at$/.test(name) || /(^|_)(timestamp|ts)$/.test(name)) return 'timestamptz';
  if (/(^|_)(date|dob|birthday)$/.test(name) || /^date_/.test(name) || /_(on|date)$/.test(name) || /^(hired|born|created|updated|due|start|end)$/.test(name))
    return 'date';
  if (/(^|_)(count|qty|quantity|number|no|num|age|year|seq|position|rank|level|priority|pct|percent)$/.test(name)) return /(pct|percent)$/.test(name) ? 'numeric' : 'integer';
  if (/(^|_)(price|amount|amt|cost|salary|sal|total|balance|rate|fee|budget|value|weight|height|width|length|lat|latitude|lon|lng|longitude|score)$/.test(name))
    return 'numeric';
  if (/(^|_)(json|data|payload|settings|config)$/.test(name)) return /(json|payload)$/.test(name) ? 'jsonb' : 'text';
  if (/(^|_)(uuid|guid)$/.test(name)) return 'uuid';
  if (/(^|_)(image|photo|picture|blob|file_content|attachment)$/.test(name)) return 'bytea';
  return 'text';
}

// ---------------------------------------------------------------- parsing

interface Node {
  indent: number;
  line: number;
  text: string;
  comment?: string;
  children: Node[];
}

const SETTING_KEYS = new Set(['pk', 'schema', 'prefix', 'drop', 'auditcols', 'semantics', 'db', 'language', 'apex', 'api', 'compress', 'date', 'genpk', 'inserts', 'longervarchar', 'ondelete', 'overridesettings', 'rowkey', 'rowversion', 'tenantid', 'editionable', 'createdcol', 'createdbycol', 'updatedcol', 'updatedbycol', 'verbose', 'resetsettings']);

function applySetting(st: QuickSqlSettings, key: string, value: string, line: number, warnings: QuickSqlWarning[]) {
  const k = key.toLowerCase().trim();
  const v = value.trim().replace(/^["']|["']$/g, '');
  const yes = /^(true|yes|y|on|1)$/i.test(v);
  switch (k) {
    case 'pk':
      if (/^(identity|seq|guid|none)$/i.test(v)) st.pk = v.toLowerCase() as QuickSqlSettings['pk'];
      else if (/^(trig|trigger|sequence)$/i.test(v)) st.pk = 'seq';
      else warnings.push({ line, message: `pk: use identity, seq, guid or none (not "${v}").` });
      break;
    case 'genpk':
      if (!yes) st.pk = 'none';
      break;
    case 'schema':
      st.schema = v ? qsName(v) : undefined;
      break;
    case 'prefix':
      st.prefix = v ? qsName(v) : undefined;
      break;
    case 'drop':
      st.drop = yes;
      break;
    case 'auditcols':
      st.auditCols = yes;
      break;
    case 'semantics':
      st.semantics = v;
      break;
    default:
      if (!SETTING_KEYS.has(k)) warnings.push({ line, message: `Unknown setting "${key.trim()}" (ignored).` });
  }
}

function parseSettings(text: string, st: QuickSqlSettings, line: number, warnings: QuickSqlWarning[]) {
  const body = text.replace(/^#\s*/, '');
  const obj = /^settings\s*=\s*\{([\s\S]*)\}\s*$/i.exec(body);
  if (obj) {
    for (const part of obj[1].split(',')) {
      if (!part.trim()) continue;
      const m = /^\s*["']?([\w]+)["']?\s*:\s*(.*)$/.exec(part);
      if (m) applySetting(st, m[1], m[2], line, warnings);
      else warnings.push({ line, message: `Cannot read the setting "${part.trim()}".` });
    }
    return;
  }
  const m = /^([\w]+)\s*[:=]\s*(.*)$/.exec(body);
  if (m) applySetting(st, m[1], m[2], line, warnings);
  else warnings.push({ line, message: 'A setting looks like "# pk: identity".' });
}

/** Split "name words type /dir a /dir2 b" into the head and its directives. */
function splitDirectives(text: string): { head: string; dirs: { name: string; arg: string }[] } {
  const parts = text.split(/\s+\/(?=[A-Za-z])/);
  let head = parts.shift()!.trim();
  // a line may start with a directive ("/nn" alone is not valid, but keep it simple)
  if (head.startsWith('/')) {
    parts.unshift(head.slice(1));
    head = '';
  }
  return {
    head,
    dirs: parts.map((p) => {
      const m = /^([A-Za-z_]+)\s*([\s\S]*)$/.exec(p.trim())!;
      return { name: m[1].toLowerCase(), arg: m[2].trim() };
    }),
  };
}

const TABLE_DIRECTIVES_IGNORED = new Set(['api', 'audit', 'compress', 'history', 'insert', 'select', 'soda', 'rest', 'uncomment', 'unique', 'flashback', 'colprefix']);

/** A default value as SQL: functions by name, numbers and booleans as they are, anything else as a string literal. */
function defaultSql(arg: string, type: string): string {
  const a = arg.trim().replace(/^'(.*)'$/s, '$1');
  const low = a.toLowerCase();
  if (/^(sysdate|now|now\(\)|systimestamp|current_timestamp|localtimestamp)$/.test(low)) return type === 'date' ? 'current_date' : 'now()';
  if (/^(current_date|today)$/.test(low)) return 'current_date';
  if (/^(user|current_user)$/.test(low)) return 'current_user';
  if (/^(guid|sys_guid\(\)|gen_random_uuid\(\))$/.test(low)) return 'gen_random_uuid()';
  if (/^-?\d+(\.\d+)?$/.test(a) && !/^(text|varchar|char)/.test(type)) return a;
  if (/^(true|false)$/.test(low) && type === 'boolean') return low;
  if (/^[yn]$/.test(low) && type === 'boolean') return low === 'y' ? 'true' : 'false';
  return pg.escapeLiteral(a);
}

/** A list of check values ("a, b, c" or "'a','b'") as SQL literals. */
function checkValues(arg: string): string[] {
  return arg
    .split(',')
    .map((v) => v.trim().replace(/^'(.*)'$/s, '$1'))
    .filter(Boolean)
    .map((v) => pg.escapeLiteral(v));
}

/** Parse Quick SQL into a model. Never throws: problems become warnings. */
export function parseQuickSql(source: string): QuickSqlModel {
  const warnings: QuickSqlWarning[] = [];
  const settings: QuickSqlSettings = { pk: 'identity', drop: false, auditCols: false };
  const views: QuickSqlView[] = [];
  const roots: Node[] = [];
  const stack: Node[] = [];
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > QUICKSQL_MAX_LINES) {
    warnings.push({ line: QUICKSQL_MAX_LINES + 1, message: `Only the first ${QUICKSQL_MAX_LINES} lines are read.` });
    lines.length = QUICKSQL_MAX_LINES;
  }
  for (const [k, raw] of lines.entries()) {
    const line = k + 1;
    let text = raw.replace(/\t/g, '    ');
    // [comments] (before stripping --, which may appear inside them)
    let comment: string | undefined;
    text = text.replace(/\[([^\]]*)\]/g, (_, c: string) => {
      comment = c.trim();
      return '';
    });
    text = text.replace(/--.*$/, '');
    if (!text.trim()) continue;
    const indent = text.length - text.trimStart().length;
    text = text.trim();
    if (text.startsWith('#')) {
      parseSettings(text, settings, line, warnings);
      continue;
    }
    const view = /^view\s+(\S+)\s+(.+)$/i.exec(text);
    if (view && indent === 0) {
      views.push({ name: qsName(view[1]), tables: view[2].split(/[\s,]+/).filter(Boolean).map(qsName), line });
      continue;
    }
    const node: Node = { indent, line, text, comment, children: [] };
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    if (stack.length) stack[stack.length - 1].children.push(node);
    else roots.push(node);
    stack.push(node);
  }

  const tables: QuickSqlTable[] = [];
  const addTable = (node: Node, parent?: QuickSqlTable) => {
    const { head, dirs } = splitDirectives(node.text);
    const t: QuickSqlTable = { name: qsName(head || 'table'), parent: parent?.name, columns: [], auditCols: settings.auditCols, comment: node.comment, line: node.line };
    for (const d of dirs) {
      if (d.name === 'auditcols' || d.name === 'audit_cols') t.auditCols = true;
      else if (TABLE_DIRECTIVES_IGNORED.has(d.name)) warnings.push({ line: node.line, message: `/${d.name} on a table is not supported by pgkiln's Quick SQL (ignored).` });
      else warnings.push({ line: node.line, message: `Unknown table directive /${d.name} (ignored).` });
    }
    if (tables.some((x) => x.name === t.name)) warnings.push({ line: node.line, message: `Table ${t.name} is defined twice.` });
    tables.push(t);
    if (parent) {
      const fk = `${singular(parent.name)}_id`;
      t.columns.push({ name: fk, type: 'bigint', notNull: false, pk: false, unique: false, index: true, checks: [], references: parent.name, line: node.line });
    }
    for (const child of node.children) {
      if (child.children.length) addTable(child, t);
      else addColumn(t, child);
    }
  };
  const addColumn = (t: QuickSqlTable, node: Node) => {
    const { head, dirs } = splitDirectives(node.text);
    const words = head.split(/\s+/).filter(Boolean);
    let type: string | null = null;
    // the last word (or "num(10, 2)" written with a space) may be a type
    if (words.length > 1) {
      type = typeWord(words[words.length - 1]);
      if (type) words.pop();
    }
    const name = qsName(words.join(' ') || 'column');
    const col: QuickSqlColumn = { name, type: type ?? inferColumnType(name), notNull: false, pk: false, unique: false, index: false, checks: [], comment: node.comment, line: node.line };
    for (const d of dirs) {
      switch (d.name) {
        case 'nn':
        case 'notnull':
        case 'not':
          col.notNull = true;
          break;
        case 'pk':
          col.pk = true;
          break;
        case 'unique':
        case 'uk':
          col.unique = true;
          break;
        case 'idx':
        case 'index':
        case 'indexed':
          col.index = true;
          break;
        case 'fk':
        case 'references':
        case 'reference':
          if (!d.arg) warnings.push({ line: node.line, message: `/${d.name} needs a table name.` });
          else {
            col.references = qsName(d.arg.split(/\s+/)[0]);
            if (!type) col.type = 'bigint';
            col.index = true;
          }
          break;
        case 'check':
        case 'values': {
          const vals = checkValues(d.arg);
          if (vals.length) col.checks.push(`${qid(name)} in (${vals.join(', ')})`);
          else warnings.push({ line: node.line, message: `/${d.name} needs values: /check a, b, c.` });
          break;
        }
        case 'between': {
          const m = /^(-?\d+(?:\.\d+)?)\s+and\s+(-?\d+(?:\.\d+)?)$/i.exec(d.arg);
          if (m) col.checks.push(`${qid(name)} between ${m[1]} and ${m[2]}`);
          else warnings.push({ line: node.line, message: '/between needs two numbers: /between 1 and 10.' });
          break;
        }
        case 'default':
          if (d.arg) col.default = d.arg;
          else warnings.push({ line: node.line, message: '/default needs a value.' });
          break;
        case 'lower':
          col.checks.push(`${qid(name)} = lower(${qid(name)})`);
          break;
        case 'upper':
          col.checks.push(`${qid(name)} = upper(${qid(name)})`);
          break;
        case 'hidden':
        case 'invisible':
          break;
        default:
          warnings.push({ line: node.line, message: `Unknown column directive /${d.name} (ignored).` });
      }
    }
    if (col.default !== undefined) col.default = defaultSql(col.default, col.type);
    if (t.columns.some((c) => c.name === col.name)) {
      // a declared parent key replaces the generated one
      const existing = t.columns.find((c) => c.name === col.name)!;
      if (existing.references && existing.references === t.parent) {
        Object.assign(existing, { ...col, references: col.references ?? existing.references, index: true, type: type ?? existing.type });
        return;
      }
      warnings.push({ line: node.line, message: `Column ${col.name} is defined twice in ${t.name}.` });
      return;
    }
    if (col.name === 'id' && settings.pk !== 'none' && !col.pk) {
      warnings.push({ line: node.line, message: `${t.name}.id is generated as the primary key; the line is ignored.` });
      return;
    }
    t.columns.push(col);
  };
  for (const r of roots) addTable(r);

  // columns named <table>_id refer to that table when it is in the model
  const byName = new Map(tables.map((t) => [t.name, t]));
  for (const t of tables)
    for (const c of t.columns) {
      if (c.references || !/_id$/.test(c.name) || c.pk) continue;
      const base = c.name.slice(0, -3);
      const target = [base, `${base}s`, `${base}es`, base.replace(/y$/, 'ies')].find((n) => byName.has(n) && n !== t.name);
      if (target && c.type === 'bigint') {
        c.references = target;
        c.index = true;
      }
    }
  for (const t of tables)
    for (const c of t.columns)
      if (c.references && !byName.has(c.references)) warnings.push({ line: c.line, message: `${t.name}.${c.name} refers to ${c.references}, which is not in the model (the foreign key assumes it exists).` });
  for (const v of views) for (const n of v.tables) if (!byName.has(n)) warnings.push({ line: v.line, message: `View ${v.name}: table ${n} is not in the model.` });
  if (!tables.length && !views.length) warnings.push({ line: 1, message: 'No tables: write a table name, then its columns indented below it.' });
  return { settings, tables, views, warnings };
}

// ---------------------------------------------------------------- DDL

/** PostgreSQL DDL for a model. */
export function quickSqlDdl(model: QuickSqlModel): string {
  const { settings: st, tables, views } = model;
  const tname = (n: string) => `${st.prefix ? `${st.prefix}_` : ''}${n}`.slice(0, 63);
  const q = (n: string) => (st.schema ? `${qid(st.schema)}.${qid(tname(n))}` : qid(tname(n)));
  const out: string[] = [];
  const created = new Set<string>();
  const later: string[] = [];
  const pkCol = (t: QuickSqlTable) => (st.pk === 'none' ? t.columns.find((c) => c.pk) : t.columns.find((c) => c.pk) ?? { name: 'id', type: st.pk === 'guid' ? 'uuid' : 'bigint' });
  const fkType = (target: string, fallback: string) => {
    const t = tables.find((x) => x.name === target);
    const pk = t && pkCol(t);
    return pk ? pk.type : fallback;
  };
  if (st.drop) {
    for (const v of [...views].reverse()) out.push(`drop view if exists ${q(v.name)};`);
    for (const t of [...tables].reverse()) out.push(`drop table if exists ${q(t.name)} cascade;`);
    out.push('');
  }
  if (st.schema) out.push(`create schema if not exists ${qid(st.schema)};`, '');
  const needsAudit = tables.some((t) => t.auditCols);
  if (needsAudit) {
    const fn = st.schema ? `${qid(st.schema)}.set_audit_columns` : 'set_audit_columns';
    out.push(
      `create or replace function ${fn}() returns trigger language plpgsql as $$`,
      'begin',
      "  if tg_op = 'INSERT' then",
      '    new.created_at := coalesce(new.created_at, now());',
      "    new.created_by := coalesce(new.created_by, nullif(current_setting('pgkiln.app_user', true), ''), current_user);",
      '  end if;',
      '  new.updated_at := now();',
      "  new.updated_by := coalesce(nullif(current_setting('pgkiln.app_user', true), ''), current_user);",
      '  return new;',
      'end',
      '$$;',
      '',
    );
  }
  for (const t of tables) {
    const lines: string[] = [];
    const hasPk = t.columns.some((c) => c.pk);
    if (!hasPk && st.pk === 'identity') lines.push('id bigint generated by default as identity primary key');
    else if (!hasPk && st.pk === 'guid') lines.push('id uuid default gen_random_uuid() primary key');
    else if (!hasPk && st.pk === 'seq') {
      out.push(`create sequence if not exists ${q(`${t.name}_seq`)};`);
      lines.push(`id bigint default nextval('${(st.schema ? `${st.schema}.` : '') + tname(`${t.name}_seq`)}') primary key`);
    }
    const pks = t.columns.filter((c) => c.pk);
    for (const c of t.columns) {
      const type = c.references && !c.pk ? fkType(c.references, c.type) : c.type;
      let def = `${qid(c.name)} ${type}`;
      if (c.notNull && !c.pk) def += ' not null';
      if (c.default !== undefined) def += ` default ${c.default}`;
      if (c.pk && pks.length === 1) def += ' primary key';
      if (c.unique) def += ' unique';
      if (c.references && (created.has(c.references) || c.references === t.name)) def += ` references ${q(c.references)}${c.references === t.parent ? ' on delete cascade' : ''}`;
      else if (c.references) later.push(`alter table ${q(t.name)} add foreign key (${qid(c.name)}) references ${q(c.references)};`);
      for (const ch of c.checks) def += ` check (${ch})`;
      lines.push(def);
    }
    if (pks.length > 1) lines.push(`primary key (${pks.map((c) => qid(c.name)).join(', ')})`);
    if (t.auditCols)
      lines.push('created_at timestamptz not null default now()', 'created_by text', 'updated_at timestamptz', 'updated_by text');
    // align the types under each other
    const width = Math.min(30, Math.max(0, ...lines.map((l) => (/^(\S+) /.exec(l)?.[1].length ?? 0))));
    const pretty = lines.map((l) => {
      const m = /^(\S+) (.*)$/.exec(l);
      return m && !/^primary$/.test(m[1]) ? `${m[1].padEnd(width)} ${m[2]}` : l;
    });
    out.push(`create table ${q(t.name)} (\n    ${pretty.join(',\n    ')}\n);`);
    created.add(t.name);
    for (const c of t.columns) if (c.index && !c.pk && !c.unique) out.push(`create index ${qid(`${tname(t.name)}_${c.name}_idx`.slice(0, 63))} on ${q(t.name)} (${qid(c.name)});`);
    if (t.auditCols) out.push(`create trigger ${qid(`${tname(t.name)}_audit`.slice(0, 63))} before insert or update on ${q(t.name)} for each row execute function ${st.schema ? `${qid(st.schema)}.` : ''}set_audit_columns();`);
    if (t.comment) out.push(`comment on table ${q(t.name)} is ${pg.escapeLiteral(t.comment)};`);
    for (const c of t.columns) if (c.comment) out.push(`comment on column ${q(t.name)}.${qid(c.name)} is ${pg.escapeLiteral(c.comment)};`);
    out.push('');
  }
  if (later.length) out.push(...later, '');
  for (const v of views) {
    const ts = v.tables.map((n) => tables.find((t) => t.name === n)).filter((t): t is QuickSqlTable => !!t);
    if (!ts.length) continue;
    const alias = new Map(ts.map((t, k) => [t.name, `t${k + 1}`]));
    const select: string[] = [];
    for (const t of ts) {
      const a = alias.get(t.name)!;
      const pk = pkCol(t);
      const cols = [...(pk && !t.columns.includes(pk as QuickSqlColumn) ? [pk.name] : []), ...t.columns.map((c) => c.name), ...(t.auditCols ? ['created_at', 'created_by', 'updated_at', 'updated_by'] : [])];
      for (const c of cols) select.push(`${a}.${qid(c)} as ${qid(`${singular(t.name)}_${c}`.slice(0, 63))}`);
    }
    let from = `${q(ts[0].name)} ${alias.get(ts[0].name)}`;
    for (const t of ts.slice(1)) {
      const a = alias.get(t.name)!;
      // a foreign key from t to an earlier table, or from an earlier table to t
      let on: string | undefined;
      for (const u of ts.slice(0, ts.indexOf(t))) {
        const b = alias.get(u.name)!;
        const fk = t.columns.find((c) => c.references === u.name);
        const back = u.columns.find((c) => c.references === t.name);
        const upk = pkCol(u)?.name ?? 'id';
        const tpk = pkCol(t)?.name ?? 'id';
        if (fk) on = `${a}.${qid(fk.name)} = ${b}.${qid(upk)}`;
        else if (back) on = `${b}.${qid(back.name)} = ${a}.${qid(tpk)}`;
        if (on) break;
      }
      from += on ? `\n  left join ${q(t.name)} ${a} on ${on}` : `\n  cross join ${q(t.name)} ${a}`;
    }
    out.push(`create or replace view ${q(v.name)} as\nselect ${select.join(',\n       ')}\n  from ${from};`, '');
  }
  return `${out.join('\n').trim()}\n`;
}

/** Quick SQL → DDL and warnings. */
export function quickSql(source: string) {
  const model = parseQuickSql(source);
  return { ddl: quickSqlDdl(model), warnings: model.warnings, model };
}
