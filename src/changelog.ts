import { owner } from './db.ts';

// (sprint 106, Database Actions DA-17; migration 118) A Liquibase-style change log: the DDL a developer runs from
// the SQL Worksheet, Table Properties and Schema Comparison is recorded as change sets (meta.change_set: author,
// time, SQL, schema, where it came from, a number per schema). SQL Workshop › Change Log (builder/changelog.ts)
// lists them per schema and writes them as migration files: plain SQL, a Liquibase formatted SQL changelog
// (--liquibase formatted sql, --changeset author:id) or Flyway versioned migrations (V0001__add_bonus.sql).

/** (sprint 180) external: DDL of another tool, recorded by the event triggers of migration 163 */
export type ChangeSource = 'worksheet' | 'table' | 'compare' | 'external';

export interface ChangeSet {
  id: number;
  workspace_id: number;
  schema_name: string;
  seq: number;
  name: string;
  author: string;
  source: ChangeSource;
  sql: string;
  object_name: string | null;
  created_at: string;
  exported_at: string | null;
  /** (sprint 175; migration 157) the SQL that undoes the change set: its rollback block in migration files */
  rollback_sql?: string | null;
}

/** Statements that change a schema's definition (as their first keyword says). */
const DDL = /^(create|alter|drop|comment|grant|revoke)\b/i;
/** DDL that is not about a schema: roles, databases, tablespaces, the server's settings, temporary objects. */
const NOT_SCHEMA = /^(create|alter|drop)\s+(or\s+replace\s+)?(role|user|group|database|tablespace|system|server|user\s+mapping|subscription|publication|event\s+trigger)\b|^(create|alter)\s+(global\s+|local\s+)?(temp|temporary|unlogged\s+temp)\b|^alter\s+(system|default\s+privileges\s+for\s+role)\b|^(grant|revoke)\s+(?![\s\S]*\bon\b)/i;
const LEAD = /^(\s*(--[^\n]*(\n|$)|\/\*[\s\S]*?\*\/))*\s*/;

const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const unquote = (s: string) => (s.startsWith('"') ? s.slice(1, -1).replace(/""/g, '"') : s.toLowerCase());

/** Whether a statement is schema DDL a change log keeps. */
export function isSchemaDdl(sql: string): boolean {
  const s = sql.replace(LEAD, '');
  return DDL.test(s) && !NOT_SCHEMA.test(s);
}

/** The schema and object a DDL statement is about: the first qualified name in it, else the default schema. */
export function ddlTarget(sql: string, defaultSchema: string): { schema: string; object: string | null } {
  const s = sql.replace(LEAD, '');
  const m = new RegExp(`(${IDENT})\\s*\\.\\s*(${IDENT})`).exec(s.replace(/'(?:[^']|'')*'/g, "''"));
  if (m && !/^\d/.test(m[1])) return { schema: unquote(m[1]), object: unquote(m[2]) };
  const bare = new RegExp(`^(?:create|alter|drop)\\s+(?:or\\s+replace\\s+)?(?:unique\\s+)?(?:materialized\\s+)?(?:table|view|index|sequence|function|procedure|type|domain|trigger|policy)\\s+(?:concurrently\\s+)?(?:if\\s+(?:not\\s+)?exists\\s+)?(${IDENT})`, 'i').exec(s);
  return { schema: defaultSchema, object: bare ? unquote(bare[1]) : null };
}

/** A change set's name from its first statement: add_bonus, drop_bonus, create_orders, create_index_orders_ix, … */
export function changeName(sql: string): string {
  const s = sql.replace(LEAD, '').replace(/\s+/g, ' ');
  const clean = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'change';
  const col = new RegExp(`^alter table (?:if exists )?(?:only )?${IDENT}(?:\\.${IDENT})? (add|drop) (?:column )?(?:if (?:not )?exists )?(${IDENT})`, 'i').exec(s);
  if (col && !/^(constraint|primary|unique|foreign|check)$/i.test(col[2])) return clean(`${col[1]}_${unquote(col[2])}`);
  const kind = new RegExp(`^(create|alter|drop)(?: or replace)?(?: unique)?(?: materialized)? (table|view|index|sequence|function|procedure|type|domain|trigger|policy|schema|extension)(?: concurrently)?(?: if (?:not )?exists)? (${IDENT})(?:\\s*\\.\\s*(${IDENT}))?`, 'i').exec(s);
  const { object } = ddlTarget(sql, '');
  if (kind) return clean(`${kind[1]}_${kind[2].toLowerCase() === 'table' ? '' : `${kind[2]}_`}${unquote(kind[4] ?? kind[3])}`);
  const verb = /^(comment|grant|revoke)\b/i.exec(s);
  return clean(`${verb ? verb[1] : 'change'}_${object ?? ''}`);
}

/**
 * (sprint 175) The statement that undoes a DDL statement, when that is plain from its text: what was created is
 * dropped, an added column or constraint is dropped. Null for anything else (a drop, a changed type, a function
 * that replaced another, a comment or a grant that may have replaced an earlier one, IF NOT EXISTS, which may
 * have created nothing): the developer writes that rollback.
 */
export function rollbackFor(sql: string): string | null {
  const s = sql.replace(LEAD, '').replace(/;\s*$/, '');
  if (/\bif\s+not\s+exists\b/i.test(s.replace(/'(?:[^']|'')*'/g, "''"))) return null;
  const name = String.raw`(${IDENT}(?:\s*\.\s*${IDENT})?)`;
  const created = new RegExp(`^create\\s+(unique\\s+)?(materialized\\s+)?(table|view|index|sequence|schema|type|domain)\\s+(concurrently\\s+)?(?:if\\s+not\\s+exists\\s+)?${name}`, 'i').exec(s);
  if (created) {
    const kind = `${created[2] ? 'materialized ' : ''}${created[3].toLowerCase()}`;
    // an index is made in its table's schema: the name alone would be looked up on the search path
    if (kind === 'index') {
      const on = new RegExp(`\\son\\s+(?:only\\s+)?(${IDENT})\\s*\\.\\s*${IDENT}`, 'i').exec(s);
      const bare = !/\./.test(created[5].replace(/"(?:[^"]|"")*"/g, ''));
      return `drop index ${on && bare ? `${on[1]}.` : ''}${created[5]}`;
    }
    return `drop ${kind} ${created[5]}`;
  }
  const table = new RegExp(`^alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?${name}\\s+add\\s+(.*)$`, 'is').exec(s);
  if (table) {
    // one ADD only: with several actions the inverse is not plain
    const rest = table[2];
    let depth = 0;
    for (const ch of rest.replace(/'(?:[^']|'')*'/g, "''")) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === ',' && depth === 0) return null;
    }
    const constraint = new RegExp(`^constraint\\s+(${IDENT})`, 'i').exec(rest);
    if (constraint) return `alter table ${table[1]} drop constraint ${constraint[1]}`;
    if (/^(primary|unique|foreign|check|exclude)\b/i.test(rest)) return null; // a constraint without a name
    const column = new RegExp(`^(?:column\\s+)?(?:if\\s+not\\s+exists\\s+)?(${IDENT})`, 'i').exec(rest);
    return column ? `alter table ${table[1]} drop column ${column[1]}` : null;
  }
  return null;
}

/** The rollback of a change set's statements: each one's inverse, last first; null when one has none. */
export function rollbackOf(statements: string[]): string | null {
  const out: string[] = [];
  for (const st of statements) {
    const r = rollbackFor(st);
    if (!r) return null;
    out.unshift(r);
  }
  return out.length ? joinStatements(out) : null;
}

/** The SQL of statements as one script, each ending with a semicolon. */
export const joinStatements = (statements: string[]) => statements.map((x) => x.trim().replace(/;*\s*$/, ';')).join('\n\n');

/**
 * Record statements that ran as change sets: those that are schema DDL, grouped by schema (one change set per
 * schema, in the order they ran). Never fails the caller: a recording error is logged.
 */
export async function recordChanges(opts: { workspaceId: number; author: string; source: ChangeSource; statements: string[]; defaultSchema: string; name?: string }) {
  const groups = new Map<string, { sql: string[]; object: string | null }>();
  for (const st of opts.statements) {
    if (!isSchemaDdl(st)) continue;
    const t = ddlTarget(st, opts.defaultSchema);
    const g = groups.get(t.schema) ?? { sql: [], object: t.object };
    g.sql.push(st);
    groups.set(t.schema, g);
  }
  const ids: number[] = [];
  try {
    for (const [schema, g] of groups) {
      const sql = joinStatements(g.sql);
      const r = await owner.one<{ id: number }>(
        `insert into meta.change_set (workspace_id, schema_name, name, author, source, sql, object_name, rollback_sql) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [opts.workspaceId, schema.slice(0, 63), opts.name ?? changeName(g.sql[0]), opts.author, opts.source, sql.slice(0, 1_000_000), g.object?.slice(0, 63) ?? null,
          sql.length <= 1_000_000 ? rollbackOf(g.sql) : null]);
      ids.push(r!.id);
    }
  } catch (e) {
    console.error('change log: could not record a change set:', (e as Error).message);
  }
  return ids;
}

/** Flyway's file name of a change set: V0001__add_bonus.sql. */
export const flywayName = (c: Pick<ChangeSet, 'seq' | 'name'>) => `V${String(c.seq).padStart(4, '0')}__${c.name}.sql`;
/** (sprint 175) Flyway's undo migration of a change set with a rollback: U0001__add_bonus.sql. */
export const flywayUndoName = (c: Pick<ChangeSet, 'seq' | 'name'>) => `U${String(c.seq).padStart(4, '0')}__${c.name}.sql`;
const rollbackText = (c: ChangeSet) => (c.rollback_sql ?? '').trim();
/** Each line of a rollback behind a prefix (a comment in plain SQL, Liquibase's --rollback). */
const prefixed = (text: string, prefix: string) => text.split(/\r?\n/).filter((l) => l.trim()).map((l) => `${prefix}${l}`).join('\n');

const header = (c: ChangeSet) => `-- ${c.schema_name} #${c.seq} ${c.name}: ${c.author}, ${c.created_at.slice(0, 19).replace('T', ' ')} (${c.source})`;

/** Change sets as plain SQL: one script, a comment before each. */
export const plainScript = (list: ChangeSet[]) =>
  `${list.map((c) => `${header(c)}\n${c.sql.trim()}\n${rollbackText(c) ? `-- rollback:\n${prefixed(rollbackText(c), '--   ')}\n` : ''}`).join('\n')}`;

/** Change sets as a Liquibase formatted SQL changelog. */
export function liquibaseChangelog(list: ChangeSet[]): string {
  const author = (a: string) => a.replace(/[\s:]+/g, '_') || 'pgkiln';
  return `--liquibase formatted sql\n\n${list.map((c) =>
    `--changeset ${author(c.author)}:${String(c.seq).padStart(4, '0')}-${c.name}\n--comment: ${c.schema_name}, ${c.source}, ${c.created_at.slice(0, 19).replace('T', ' ')}\n${c.sql.trim()}\n${rollbackText(c) ? `${prefixed(rollbackText(c), '--rollback ')}\n` : ''}`).join('\n')}`;
}

/** A Flyway migration file of one change set. */
export const flywayFile = (c: ChangeSet) => `${header(c)}\n${c.sql.trim()}\n`;
/** (sprint 175) The Flyway undo migration of a change set, or null without a rollback. */
export const flywayUndoFile = (c: ChangeSet) => (rollbackText(c) ? `${header(c)} (undo)\n${rollbackText(c)}\n` : null);
