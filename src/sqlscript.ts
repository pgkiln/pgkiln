import type pg from 'pg';
import { skipQuoted } from './binds.ts';
import type { Client } from './db.ts';

// SQL scripts (SQL Workshop → SQL Scripts): a script is split into its
// statements, which run one after another on one connection, with a result
// per statement. Used by the builder only (as the owner connection).

export interface ScriptStatement {
  /** the statement text, without the closing semicolon and leading comments */
  sql: string;
  /** 1-based line of the statement's first character in the script */
  line: number;
  /** a psql meta-command (\set, \i, …): reported, not run */
  psql?: boolean;
}

const IDENT = /[A-Za-z0-9_$]/;
const WORD_START = /[A-Za-z_]/;

/**
 * Split a script into statements at semicolons outside comments, strings,
 * quoted identifiers and dollar quotes. Also handled: SQL-standard function
 * bodies (BEGIN ATOMIC … END, whose statements end with semicolons),
 * identifiers containing $ (a$b$ is not a dollar quote), and psql
 * meta-commands on their own line (\connect, \set …), which end at the line
 * break and are returned with `psql: true`.
 */
export function splitScript(script: string): ScriptStatement[] {
  const out: ScriptStatement[] = [];
  const n = script.length;
  let start = 0;
  let i = 0;
  let atomic = 0; // nesting inside BEGIN ATOMIC … END
  let prevWord = '';
  let empty = true; // only whitespace and comments since `start`

  const push = (end: number) => {
    const raw = script.slice(start, end);
    // leading comments and blanks go, so the statement starts with its keyword
    let lead = 0;
    for (;;) {
      while (lead < raw.length && /\s/.test(raw[lead])) lead++;
      if (!(raw.startsWith('--', lead) || raw.startsWith('/*', lead))) break;
      lead = skipQuoted(raw, lead)!;
    }
    const sql = raw.slice(lead).trim();
    if (sql) out.push({ sql, line: lineAt(script, start + lead) });
  };

  while (i < n) {
    const c = script[i];
    const prev = i > 0 ? script[i - 1] : '';
    // $ inside an identifier (a$b$) does not open a dollar quote
    if (!(c === '$' && IDENT.test(prev))) {
      const end = skipQuoted(script, i);
      if (end !== null) {
        if (!(c === '-' || c === '/')) empty = false;
        i = end;
        continue;
      }
    }
    if (empty && c === '\\' && atLineStart(script, i)) {
      push(i); // nothing but comments before it
      const eol = script.indexOf('\n', i);
      const end = eol === -1 ? n : eol;
      out.push({ sql: script.slice(i, end).trim(), line: lineAt(script, i), psql: true });
      start = i = end;
      continue;
    }
    if (WORD_START.test(c) && !IDENT.test(prev)) {
      let j = i + 1;
      while (j < n && IDENT.test(script[j])) j++;
      const word = script.slice(i, j).toLowerCase();
      if (atomic > 0) {
        if (word === 'begin' || word === 'case') atomic++;
        else if (word === 'end') atomic--;
      } else if (word === 'atomic' && prevWord === 'begin') atomic = 1;
      prevWord = word;
      empty = false;
      i = j;
      continue;
    }
    if (c === ';' && atomic === 0) {
      push(i);
      start = i + 1;
      prevWord = '';
      empty = true;
    } else if (!/\s/.test(c)) empty = false;
    i++;
  }
  push(n);
  return out;
}

function atLineStart(s: string, i: number) {
  for (let j = i - 1; j >= 0; j--) {
    if (s[j] === '\n') return true;
    if (s[j] !== ' ' && s[j] !== '\t' && s[j] !== '\r') return false;
  }
  return true;
}

function lineAt(s: string, i: number) {
  let line = 1;
  for (let j = 0; j < i; j++) if (s.charCodeAt(j) === 10) line++;
  return line;
}

// ---------------------------------------------------------------- running

export interface RunOptions {
  /** stop at the first failing statement (default), or run the rest too */
  stopOnError?: boolean;
  /** run all statements in one transaction: with stopOnError, a failure rolls everything back */
  transaction?: boolean;
  /** rows kept per statement for the results (default 10) */
  sampleRows?: number;
}

export interface StatementResult {
  n: number;
  line: number;
  /** the statement (shortened) */
  sql: string;
  status: 'ok' | 'error' | 'skipped' | 'not_run';
  command?: string;
  rows?: number | null;
  columns?: string[];
  sample?: (string | null)[][];
  error?: string;
  ms: number;
}

export interface ScriptRun {
  statements: number;
  succeeded: number;
  failed: number;
  /** the transaction was rolled back (transaction + stopOnError, after a failure) */
  rolledBack: boolean;
  /** the error of COMMIT (e.g. a deferred constraint) */
  commitError?: string;
  ms: number;
  results: StatementResult[];
}

const MAX_SQL = 4000;
const MAX_VALUE = 500;

const cell = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = Buffer.isBuffer(v) ? `\\x${v.subarray(0, MAX_VALUE).toString('hex')}` : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > MAX_VALUE ? `${s.slice(0, MAX_VALUE)}…` : s;
};

/**
 * Run the statements on `c` (a connection of its own: the caller destroys it
 * afterwards, since a script may change session settings or the role).
 */
export async function runScript(c: Client, statements: ScriptStatement[], opts: RunOptions = {}): Promise<ScriptRun> {
  const stopOnError = opts.stopOnError !== false;
  const sampleRows = opts.sampleRows ?? 10;
  const started = performance.now();
  const results: StatementResult[] = statements.map((s, k) => ({
    n: k + 1,
    line: s.line,
    sql: s.sql.length > MAX_SQL ? `${s.sql.slice(0, MAX_SQL)}…` : s.sql,
    status: 'not_run',
    ms: 0,
  }));
  let failed = 0;
  let rolledBack = false;
  let commitError: string | undefined;
  if (opts.transaction) await c.query('begin');
  for (const [k, s] of statements.entries()) {
    const r = results[k];
    if (s.psql) {
      r.status = 'skipped';
      r.error = 'psql meta-commands are not supported; the line was skipped.';
      continue;
    }
    const t0 = performance.now();
    const sp = opts.transaction && !stopOnError;
    try {
      if (sp) await c.query('savepoint pgkiln_script');
      const out = (await c.query({ text: s.sql, rowMode: 'array' })) as pg.QueryResult<unknown[]> | pg.QueryResult<unknown[]>[];
      const res = Array.isArray(out) ? out[out.length - 1] : out;
      if (sp) await c.query('release savepoint pgkiln_script');
      r.status = 'ok';
      r.command = res.command ?? undefined;
      r.rows = res.rowCount;
      if (res.fields?.length) {
        r.columns = res.fields.map((f) => f.name);
        r.sample = (res.rows ?? []).slice(0, sampleRows).map((row) => row.map(cell));
      }
    } catch (e) {
      r.status = 'error';
      const err = e as pg.DatabaseError;
      r.error = `${err.message}${err.code ? ` (${err.code})` : ''}`;
      failed++;
      if (sp) await c.query('rollback to savepoint pgkiln_script').catch(() => {});
    }
    r.ms = Math.round(performance.now() - t0);
    if (r.status === 'error' && stopOnError) break;
  }
  if (opts.transaction) {
    if (failed && stopOnError) {
      await c.query('rollback').catch(() => {});
      rolledBack = true;
    } else {
      try {
        await c.query('commit');
      } catch (e) {
        // e.g. a deferred constraint
        commitError = (e as Error).message;
        failed++;
        rolledBack = true;
      }
    }
  }
  return {
    statements: statements.length,
    succeeded: results.filter((r) => r.status === 'ok').length,
    failed,
    rolledBack,
    commitError,
    ms: Math.round(performance.now() - started),
    results,
  };
}
