import type pg from 'pg';
import { isNumeric } from './runtime/report.ts';
import { parsePlan, planText, type Plan } from './sqlplan.ts';
import { splitScript, type ScriptStatement } from './sqlscript.ts';
import { skipQuoted } from './binds.ts';

// (sprint 91, Database Actions DA-1/DA-2) The SQL Workshop's worksheet: which statements a run takes
// (the one at the cursor, a selection, or all of them), and running them on one connection with a log
// per statement like a script output (psql's command tags, the rows as text, notices, errors with their
// line), the last query's rows for the Query Result grid, and EXPLAIN for the plan tabs. The builder's
// page is src/builder/worksheet.ts.

export type RunMode = 'statement' | 'script' | 'explain' | 'autotrace';

/**
 * The statements a run takes from the worksheet text: a selection (start < end) is split and run whole;
 * otherwise Run Statement, Explain and Autotrace take the statement at the cursor (the one containing it,
 * else the nearest one before it, else the first after it) and Run Script takes all. Without a cursor
 * everything runs (pages without JavaScript, and posts from scripts).
 */
export function pickStatements(text: string, mode: RunMode, cursor?: { start: number; end: number }): ScriptStatement[] {
  if (cursor && cursor.end > cursor.start && cursor.start >= 0 && cursor.end <= text.length) {
    const part = text.slice(cursor.start, cursor.end);
    const lineOffset = lineOf(text, cursor.start) - 1;
    return splitScript(part).map((s) => ({ ...s, line: s.line + lineOffset, start: s.start + cursor.start, end: s.end + cursor.start }));
  }
  const all = splitScript(text);
  if (mode === 'script' || !cursor || !all.length) return all;
  const at = Math.max(0, Math.min(cursor.start, text.length));
  // the statement runs up to its semicolon: a cursor right after it still belongs to it
  const inside = all.find((s) => at >= s.start && at <= s.end + 1);
  if (inside) return [inside];
  const before = all.filter((s) => s.end < at).pop();
  return [before ?? all[0]];
}

/** 1-based line of offset `i`. */
export function lineOf(s: string, i: number) {
  let line = 1;
  for (let j = 0; j < i && j < s.length; j++) if (s.charCodeAt(j) === 10) line++;
  return line;
}

const MODIFIERS = new Set(['or', 'replace', 'unique', 'temp', 'temporary', 'unlogged', 'global', 'local', 'trusted', 'procedural', 'recursive', 'if', 'not', 'exists', 'concurrently', 'default', 'constraint']);

/**
 * A statement's command tag like psql prints it: INSERT 0 1, UPDATE 3, SELECT 14, CREATE TABLE.
 * node-pg keeps only the first word of the server's tag, so DDL takes its object type from the statement.
 */
export function commandTag(sql: string, command: string | null | undefined, rowCount: number | null | undefined): string {
  const cmd = (command ?? '').toUpperCase();
  if (cmd === 'INSERT') return `INSERT 0 ${rowCount ?? 0}`;
  if (['SELECT', 'UPDATE', 'DELETE', 'MERGE', 'FETCH', 'MOVE', 'COPY'].includes(cmd)) return `${cmd} ${rowCount ?? 0}`;
  if (['CREATE', 'ALTER', 'DROP', 'COMMENT', 'GRANT', 'REVOKE'].includes(cmd) || !cmd) {
    const words = sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ').trim().split(/\s+/).map((w) => w.toLowerCase().replace(/[^a-z_]/g, ''));
    const verb = (words[0] || cmd.toLowerCase()).toUpperCase();
    if (!['CREATE', 'ALTER', 'DROP'].includes(verb)) return verb || cmd || 'OK';
    let k = 1;
    while (k < words.length && MODIFIERS.has(words[k])) k++;
    const obj = words[k] ?? '';
    if (!obj) return verb;
    if (obj === 'materialized' || obj === 'foreign' || obj === 'event') return `${verb} ${obj.toUpperCase()} ${(words[k + 1] ?? '').toUpperCase()}`.trim();
    return `${verb} ${obj.toUpperCase()}`;
  }
  return cmd;
}

const MAX_VALUE = 500;

/** A value as text (the grid and the script output): JSON for objects, \x… for bytes; shortened. */
export function cellText(v: unknown, max = MAX_VALUE): string | null {
  if (v === null || v === undefined) return null;
  const s = Buffer.isBuffer(v) ? `\\x${v.subarray(0, max).toString('hex')}` : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
/** (sprint 92) Values in the Query Result grid: whole up to this (a cell shows the start, a click the rest). */
export const GRID_VALUE = 10_000;

/** Rows as a fixed-width text table like psql's (NULL as empty), for the script output. */
export function textTable(columns: string[], rows: (string | null)[][]): string {
  const width = columns.map((c, k) => Math.min(60, Math.max(c.length, ...rows.map((r) => (r[k] ?? '').replace(/\s+/g, ' ').length))));
  const cut = (v: string, w: number) => {
    const one = v.replace(/\s+/g, ' ');
    return one.length > w ? `${one.slice(0, w - 1)}…` : one;
  };
  const line = (cells: string[]) => cells.map((v, k) => ` ${cut(v, width[k]).padEnd(width[k])} `).join('|').trimEnd();
  return [line(columns), width.map((w) => '-'.repeat(w + 2)).join('+'), ...rows.map((r) => line(r.map((v) => v ?? '')))].join('\n');
}

export interface Notice {
  level: string;
  message: string;
  /** (sprint 92) the time it came, HH:MM:SS.mmm */
  at: string;
  /** the statement it came from (1-based) */
  n: number;
}

export interface WorksheetResult {
  n: number;
  line: number;
  sql: string;
  start: number;
  end: number;
  status: 'ok' | 'error' | 'skipped' | 'not_run';
  tag?: string;
  rows?: number | null;
  columns?: string[];
  /** the rows kept for the output (all of them up to the limit for the last query) */
  data?: (string | null)[][];
  /** (sprint 92) which columns are numbers (right-aligned in the grid) */
  numeric?: boolean[];
  /** more rows than kept */
  more?: boolean;
  error?: string;
  /** the error's line in the worksheet and its column */
  errorLine?: number;
  errorColumn?: number;
  ms: number;
}

export interface WorksheetRun {
  results: WorksheetResult[];
  notices: Notice[];
  failed: number;
  ms: number;
  /** the plan text (explain / autotrace) */
  plan?: string;
  /** (sprint 92) the plan as a tree */
  tree?: Plan;
}

/** COPY with the client's stream: the worksheet has no file to read or write. */
export const usesClientCopy = (sql: string) => /^\s*\\?copy\b[\s\S]*\b(from\s+stdin|to\s+stdout)\b/i.test(sql);

export interface RunOptions {
  /** run the rest after a failing statement (Run Script), default: stop */
  continueOnError?: boolean;
  /** rows kept for the last query's grid (default 500) and for the script output of the others (default 50) */
  gridRows?: number;
  logRows?: number;
}

/**
 * Run statements on `c` (a connection of its own, destroyed by the caller: the SQL may change the role or
 * settings). Each statement autocommits, like Database Actions, unless the caller opened a transaction on `c`
 * (sprint 107, the worksheet's transaction mode). Notices are collected per statement.
 */
export async function runStatements(c: pg.ClientBase, text: string, statements: ScriptStatement[], opts: RunOptions = {}): Promise<WorksheetRun> {
  const started = performance.now();
  const notices: Notice[] = [];
  let current = 0;
  const onNotice = (m: { severity?: string; message?: string }) => {
    notices.push({ level: (m.severity ?? 'NOTICE').toUpperCase(), message: m.message ?? '', n: current, at: new Date().toISOString().slice(11, 23) });
  };
  c.on('notice', onNotice);
  const lastQuery = [...statements].reverse().find((s) => !s.psql && /^\s*(\(|select|with|values|table|show|explain|fetch|returning)\b/i.test(s.sql)) ?? statements[statements.length - 1];
  const results: WorksheetResult[] = statements.map((s, k) => ({ n: k + 1, line: s.line, sql: s.sql, start: s.start, end: s.end, status: 'not_run', ms: 0 }));
  let failed = 0;
  try {
    for (const [k, s] of statements.entries()) {
      const r = results[k];
      current = k + 1;
      if (s.psql || usesClientCopy(s.sql)) {
        r.status = 'skipped';
        r.error = s.psql ? 'psql meta-commands are not supported; the line was skipped.' : 'COPY … FROM STDIN / TO STDOUT needs a client stream: use Load Data or Unload Data.';
        continue;
      }
      const t0 = performance.now();
      try {
        const out = (await c.query({ text: s.sql, rowMode: 'array' })) as pg.QueryResult<unknown[]> | pg.QueryResult<unknown[]>[];
        const res = Array.isArray(out) ? out[out.length - 1] : out;
        r.status = 'ok';
        r.tag = commandTag(s.sql, res.command, res.rowCount);
        r.rows = res.rowCount;
        if (res.fields?.length) {
          const keep = s === lastQuery ? (opts.gridRows ?? 500) : (opts.logRows ?? 50);
          const max = s === lastQuery ? GRID_VALUE : MAX_VALUE;
          r.columns = res.fields.map((f) => f.name);
          r.numeric = res.fields.map((f) => isNumeric(f.dataTypeID));
          r.data = (res.rows ?? []).slice(0, keep).map((row) => row.map((v) => cellText(v, max)));
          r.more = (res.rows ?? []).length > keep;
        }
      } catch (e) {
        const err = e as pg.DatabaseError;
        r.status = 'error';
        r.error = `${err.message}${err.code ? ` (${err.code})` : ''}`;
        const pos = Number(err.position);
        if (pos > 0) {
          const before = s.sql.slice(0, pos - 1);
          r.errorLine = s.line + (before.match(/\n/g)?.length ?? 0);
          r.errorColumn = pos - before.lastIndexOf('\n') - 1;
        } else r.errorLine = s.line;
        failed++;
      }
      r.ms = Math.round(performance.now() - t0);
      if (r.status === 'error' && !opts.continueOnError) break;
    }
  } finally {
    c.removeListener('notice', onNotice);
  }
  return { results, notices, failed, ms: Math.round(performance.now() - started) };
}

/**
 * EXPLAIN the statement (Explain Plan: nothing runs) or EXPLAIN ANALYZE it inside a transaction that is
 * rolled back (Autotrace: it runs, its changes don't stay).
 */
export async function explainStatement(c: pg.ClientBase, s: ScriptStatement, analyze: boolean, inTransaction = false): Promise<WorksheetRun> {
  const started = performance.now();
  const r: WorksheetResult = { n: 1, line: s.line, sql: s.sql, start: s.start, end: s.end, status: 'not_run', ms: 0 };
  let plan: string | undefined;
  let tree: Plan | undefined;
  if (s.psql || usesClientCopy(s.sql)) {
    r.status = 'skipped';
    r.error = 'Only SQL statements have a plan.';
  } else {
    try {
      // (sprint 107) in a worksheet's open transaction: a savepoint, so the plan sees the transaction's changes and
      // Autotrace's own are undone while the transaction's stay (a failing EXPLAIN doesn't abort it either)
      await c.query(inTransaction ? 'savepoint pgkiln_explain' : 'begin');
      const out = await c.query<{ 'QUERY PLAN': unknown }>(`explain (format json, ${analyze ? 'analyze, buffers, ' : ''}verbose, costs) ${s.sql}`);
      const json = out.rows[0]?.['QUERY PLAN'];
      tree = parsePlan(typeof json === 'string' ? JSON.parse(json) : json, analyze);
      plan = planText(tree);
      r.status = 'ok';
      r.tag = analyze ? 'EXPLAIN ANALYZE (rolled back)' : 'EXPLAIN';
    } catch (e) {
      const err = e as pg.DatabaseError;
      r.status = 'error';
      r.error = `${err.message}${err.code ? ` (${err.code})` : ''}`;
      r.errorLine = s.line;
    } finally {
      if (inTransaction) await c.query('rollback to savepoint pgkiln_explain').then(() => c.query('release savepoint pgkiln_explain')).catch(() => {});
      else await c.query('rollback').catch(() => {});
    }
  }
  r.ms = Math.round(performance.now() - started);
  return { results: [r], notices: [], failed: r.status === 'error' ? 1 : 0, ms: r.ms, plan, tree };
}

// ---------------------------------------------------------------- (sprint 93, DA-9) substitution variables

/** The &NAME. substitution variables of `sql` (outside strings and comments), upper-cased. */
export function substitutionNames(sql: string): string[] {
  const names = new Set<string>();
  substituteAmp(sql, (n) => {
    names.add(n);
    return '';
  });
  return [...names];
}

/** Replace each &NAME. by its value as text (SQL*Plus and APEX style: the value goes into the statement as it is). */
export function applySubstitutions(sql: string, values: Record<string, string | undefined>): string {
  return substituteAmp(sql, (n) => values[n] ?? '');
}

function substituteAmp(sql: string, f: (name: string) => string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const prev = i > 0 ? sql[i - 1] : '';
    if (!(sql[i] === '$' && /[A-Za-z0-9_]/.test(prev))) {
      const end = skipQuoted(sql, i);
      if (end !== null && end > i) {
        out += sql.slice(i, end);
        i = end;
        continue;
      }
    }
    const m = sql[i] === '&' ? /^&([A-Za-z_][A-Za-z0-9_]{0,62})\./.exec(sql.slice(i, i + 66)) : null;
    if (m) {
      out += f(m[1].toUpperCase());
      i += m[0].length;
      continue;
    }
    out += sql[i++];
  }
  return out;
}
