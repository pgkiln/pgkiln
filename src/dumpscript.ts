import type pg from 'pg';

// (sprint 103, Database Actions DA-16) The SQL script pg_restore writes for one schema (`pg_restore -f -`), read line
// by line and run on one connection, inside the caller's transaction: Schema Import (src/datapump.ts) streams it here
// instead of to psql, so it can run in the same transaction as its schema renames, and so a dump can't reach further
// than its own schema.
//
// What runs:
//   - statements, split like psql splits them: quotes, E'' strings, quoted identifiers, dollar quotes, comments, and
//     SQL-standard function bodies (BEGIN ATOMIC … END) with their own semicolons
//   - COPY … FROM stdin with the data lines after it up to "\.", sent with the COPY protocol in chunks (never the
//     whole table in memory)
//   - psql's \restrict and \unrestrict lines (PostgreSQL 17.6+) are skipped; any other psql meta-command is refused
//
// What is refused (checkStatement), before it reaches the server: statements pg_dump doesn't write for one schema
// (roles, databases, extensions, ALTER SYSTEM, DO, COPY to or from files and programs, SET ROLE, SET SESSION
// AUTHORIZATION, OWNER TO, SET SCHEMA, security labels), and objects created, changed or dropped outside the dump's
// own schema. A dump is still code: functions and triggers in it run as pgkiln's owner role. Import only dumps you
// trust.

export class ScriptError extends Error {
  constructor(message: string, public line?: number) {
    super(line ? `line ${line}: ${message}` : message);
  }
}

export type ScriptEvent =
  | { type: 'sql'; sql: string; line: number }
  | { type: 'copy'; sql: string; line: number }
  | { type: 'data'; text: string }
  | { type: 'copyEnd' };

type State = { q: 'none' } | { q: 's' } | { q: 'e' } | { q: 'd' } | { q: 'dollar'; tag: string } | { q: 'block'; depth: number };

const IDENT_CHAR = /[A-Za-z0-9_$\u0080-￿]/;
const DOLLAR = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;
const ROUTINE = /^create\s+(or\s+replace\s+)?(function|procedure)\b/i;

/** Splits a psql script into statements and COPY data, a line at a time. */
export class ScriptLexer {
  private buf = '';
  private state: State = { q: 'none' };
  private data = false;
  /** BEGIN … END depth in a CREATE FUNCTION / PROCEDURE (SQL-standard bodies) */
  private depth = 0;
  private lineNo = 0;
  private startLine = 0;

  push(line: string): ScriptEvent[] {
    this.lineNo++;
    if (this.data) {
      if (line === '\\.') {
        this.data = false;
        return [{ type: 'copyEnd' }];
      }
      return [{ type: 'data', text: `${line}\n` }];
    }
    const out: ScriptEvent[] = [];
    let i = 0;
    const n = line.length;
    const emit = () => {
      const sql = this.buf.trim();
      this.buf = '';
      this.depth = 0;
      if (!sql || sql === ';') return;
      if (/^copy\b/i.test(sql) && /\bfrom\s+stdin\s*;$/i.test(sql)) {
        out.push({ type: 'copy', sql, line: this.startLine });
        this.data = true;
      } else out.push({ type: 'sql', sql, line: this.startLine });
    };
    while (i < n) {
      const ch = line[i];
      const st = this.state;
      if (st.q === 'none') {
        if (!this.buf.trim()) this.startLine = this.lineNo;
        if (ch === '-' && line[i + 1] === '-') break; // a comment to the end of the line
        if (ch === '/' && line[i + 1] === '*') {
          this.state = { q: 'block', depth: 1 };
          this.buf += ' ';
          i += 2;
          continue;
        }
        if (ch === "'") {
          const prev = this.buf.slice(-1);
          const before = this.buf.slice(-2, -1);
          this.state = /[eE]/.test(prev) && !IDENT_CHAR.test(before) ? { q: 'e' } : { q: 's' };
        } else if (ch === '"') this.state = { q: 'd' };
        else if (ch === '$' && !IDENT_CHAR.test(this.buf.slice(-1))) {
          const m = DOLLAR.exec(line.slice(i));
          if (m) {
            this.state = { q: 'dollar', tag: m[0] };
            this.buf += m[0];
            i += m[0].length;
            continue;
          }
        } else if (ch === '\\') {
          // a psql meta-command: \restrict / \unrestrict (pg_restore 17.6+) on a line of their own are skipped
          if (!this.buf.trim() && /^\\(un)?restrict(\s+\S+)?\s*$/.test(line.slice(i))) return out;
          throw new ScriptError(`psql meta-commands are not run here: ${line.slice(i, i + 20)}`, this.lineNo);
        } else if (ch === ';' && this.depth === 0) {
          this.buf += ';';
          emit();
          i++;
          if (this.data) {
            if (line.slice(i).trim()) throw new ScriptError('COPY data must start on the next line', this.lineNo);
            return out;
          }
          continue;
        } else if (/[A-Za-z_]/.test(ch) && !IDENT_CHAR.test(this.buf.slice(-1))) {
          // a word: BEGIN / CASE / END count in a routine's SQL-standard body
          let j = i;
          while (j < n && IDENT_CHAR.test(line[j])) j++;
          const word = line.slice(i, j).toLowerCase();
          if ((word === 'begin' || word === 'case' || word === 'end') && ROUTINE.test(this.buf.trimStart())) {
            if (word === 'begin') this.depth++;
            else if (word === 'case' && this.depth > 0) this.depth++;
            else if (word === 'end' && this.depth > 0) this.depth--;
          }
          this.buf += line.slice(i, j);
          i = j;
          continue;
        }
        this.buf += ch;
        i++;
        continue;
      }
      if (st.q === 'block') {
        if (ch === '/' && line[i + 1] === '*') {
          st.depth++;
          i += 2;
        } else if (ch === '*' && line[i + 1] === '/') {
          st.depth--;
          i += 2;
          if (st.depth === 0) this.state = { q: 'none' };
        } else i++;
        continue;
      }
      if (st.q === 'dollar') {
        if (ch === '$' && line.startsWith(st.tag, i)) {
          this.buf += st.tag;
          i += st.tag.length;
          this.state = { q: 'none' };
          continue;
        }
        this.buf += ch;
        i++;
        continue;
      }
      // quotes: '' and "" escape themselves; E'' strings also \x
      if (st.q === 'e' && ch === '\\') {
        this.buf += line.slice(i, i + 2);
        i += 2;
        continue;
      }
      const close = st.q === 'd' ? '"' : "'";
      this.buf += ch;
      i++;
      if (ch === close) {
        if (line[i] === close) {
          this.buf += close;
          i++;
        } else this.state = { q: 'none' };
      }
    }
    if (this.state.q !== 'block') this.buf += '\n';
    return out;
  }

  /** The end of the script: what is left must be nothing but whitespace. */
  end() {
    if (this.data) throw new ScriptError('the script ends inside COPY data (no "\\." line)', this.lineNo);
    if (this.state.q !== 'none' && this.state.q !== 'block') throw new ScriptError('the script ends inside a quoted string', this.lineNo);
    if (this.buf.trim()) throw new ScriptError(`the script ends without a semicolon: ${this.buf.trim().slice(0, 60)}`, this.lineNo);
  }
}

// ------------------------------------------------------------------ checks

const ID = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_\u0080-￿][A-Za-z0-9_$\u0080-￿]*)`;
const QN = String.raw`(${ID})\s*\.\s*(${ID})`;
/** an identifier as PostgreSQL stores it */
export const ident = (s: string) => (s.startsWith('"') ? s.slice(1, -1).replace(/""/g, '"') : s.toLowerCase());
const re = (src: string) => new RegExp(src, 'is');

/** GUCs pg_dump and pg_restore set */
const SETTINGS = new Set([
  'statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout', 'transaction_timeout', 'client_encoding',
  'standard_conforming_strings', 'check_function_bodies', 'xmloption', 'client_min_messages', 'row_security',
  'default_tablespace', 'default_table_access_method', 'default_with_oids', 'search_path', 'escape_string_warning',
]);

const OBJECT = String.raw`(?:table|foreign\s+table|view|materialized\s+view|sequence|function|procedure|routine|aggregate|type|domain|index|statistics|collation|text\s+search\s+(?:configuration|dictionary|parser|template)|conversion)`;

const RULES: { re: RegExp; schemaGroup: number; qualified?: boolean }[] = [
  // CREATE [OR REPLACE] [UNLOGGED|RECURSIVE] <object> [IF NOT EXISTS] schema.name
  { re: re(String.raw`^create\s+(?:or\s+replace\s+)?(?:(?:unlogged|recursive)\s+)?${OBJECT}\s+(?:if\s+not\s+exists\s+)?${QN}`), schemaGroup: 1 },
  // CREATE [UNIQUE] INDEX [CONCURRENTLY] [IF NOT EXISTS] name ON [ONLY] schema.table
  { re: re(String.raw`^create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?(?:${ID}\s+)?on\s+(?:only\s+)?${QN}`), schemaGroup: 1 },
  // CREATE [OR REPLACE] [CONSTRAINT] TRIGGER name … ON schema.table
  { re: re(String.raw`^create\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\s+${ID}\s.*?\son\s+${QN}`), schemaGroup: 1 },
  // CREATE / ALTER POLICY name ON schema.table; CREATE RULE name AS ON event TO schema.table
  { re: re(String.raw`^(?:create|alter)\s+policy\s+${ID}\s+on\s+${QN}`), schemaGroup: 1 },
  { re: re(String.raw`^create\s+(?:or\s+replace\s+)?rule\s+${ID}\s+as\s+on\s+\w+\s+to\s+${QN}`), schemaGroup: 1 },
  // ALTER <object> [IF EXISTS] [ONLY] schema.name …
  { re: re(String.raw`^alter\s+${OBJECT}\s+(?:if\s+exists\s+)?(?:only\s+)?${QN}`), schemaGroup: 1 },
  // COMMENT ON CONSTRAINT|TRIGGER|POLICY|RULE name ON [DOMAIN] schema.table; COMMENT ON <kind> schema.name
  { re: re(String.raw`^comment\s+on\s+(?:constraint|trigger|policy|rule)\s+${ID}\s+on\s+(?:domain\s+)?${QN}`), schemaGroup: 1 },
  { re: re(String.raw`^comment\s+on\s+(?:column|${OBJECT})\s+${QN}`), schemaGroup: 1 },
  // GRANT / REVOKE … ON [kind] schema.name
  { re: re(String.raw`^(?:grant|revoke)\s+.+?\s+on\s+(?:table|sequence|function|procedure|routine|type|domain|foreign\s+table)?\s*${QN}`), schemaGroup: 1 },
  // DROP <object> [IF EXISTS] schema.name; DROP TRIGGER|POLICY|RULE [IF EXISTS] name ON schema.table (pg_restore --clean)
  { re: re(String.raw`^drop\s+${OBJECT}\s+(?:if\s+exists\s+)?${QN}`), schemaGroup: 1 },
  { re: re(String.raw`^drop\s+(?:trigger|policy|rule)\s+(?:if\s+exists\s+)?${ID}\s+on\s+${QN}`), schemaGroup: 1 },
  // REFRESH MATERIALIZED VIEW schema.name
  { re: re(String.raw`^refresh\s+materialized\s+view\s+(?:concurrently\s+)?${QN}`), schemaGroup: 1 },
];

/** Why a statement of a dump of `schema` may not run here, or null when it may. */
export function checkStatement(sql: string, schema: string): string | null {
  const s = sql.trim();
  const outside = (name: string) => `it changes an object outside the dump's schema ${schema} (${name})`;
  // settings
  let m = re(String.raw`^set\s+(?:session\s+)?([a-z_]+)\s*(?:=|to)\s*(.*?)\s*;$`).exec(s);
  if (m) {
    const name = m[1].toLowerCase();
    if (!SETTINGS.has(name)) return `SET ${name} is not something a dump sets`;
    if (name === 'search_path' && !/^(''|"")$/.test(m[2])) return 'a dump runs with an empty search_path (names are schema-qualified)';
    return null;
  }
  if (/^select\s+pg_catalog\.set_config\(\s*'search_path'\s*,\s*''\s*,\s*false\s*\)\s*;$/i.test(s)) return null;
  m = /^select\s+pg_catalog\.setval\(\s*'((?:[^']|'')+)'\s*,\s*-?\d+\s*,\s*(?:true|false)\s*\)\s*;$/i.exec(s);
  if (m) {
    const n = re(String.raw`^${QN}$`).exec(m[1].replace(/''/g, "'"));
    if (!n) return 'setval needs a schema-qualified sequence';
    return ident(n[1]) === schema ? null : outside(m[1]);
  }
  // COPY schema.table [(columns)] FROM stdin
  if (/^copy\b/i.test(s)) {
    m = re(String.raw`^copy\s+${QN}\s*(?:\(\s*${ID}(?:\s*,\s*${ID})*\s*\))?\s+from\s+stdin\s*;$`).exec(s);
    if (!m) return 'only COPY … FROM stdin of a schema-qualified table runs here';
    return ident(m[1]) === schema ? null : outside(`${m[1]}.${m[2]}`);
  }
  // the schema itself
  m = re(String.raw`^(?:create\s+schema|comment\s+on\s+schema|drop\s+schema\s+(?:if\s+exists\s+)?)\s*(${ID})`).exec(s);
  if (m) return ident(m[1]) === schema ? null : outside(m[1]);
  m = re(String.raw`^(?:grant|revoke)\s+.+?\s+on\s+schema\s+(${ID})`).exec(s);
  if (m) return ident(m[1]) === schema ? null : outside(m[1]);
  if (/^(grant|revoke)\b/i.test(s) && !/\son\s/i.test(s)) return 'role memberships are not granted from a dump';
  // never: ownership, moving objects to another schema
  if (/^alter\b/i.test(s) && /\bowner\s+to\b/i.test(s)) return 'OWNER TO is not run (pg_restore runs with --no-owner)';
  if (/^alter\b/i.test(s) && /\bset\s+schema\b/i.test(s)) return 'SET SCHEMA would move an object out of the dump\'s schema';
  if (/^create\s+(?:or\s+replace\s+)?(?:temp|temporary)\b/i.test(s)) return 'temporary objects are not part of a dump';
  for (const r of RULES) {
    m = r.re.exec(s);
    if (m) return ident(m[r.schemaGroup]) === schema ? null : outside(`${m[r.schemaGroup]}.${m[r.schemaGroup + 1]}`);
  }
  // schema-level ALTER TABLE … ADD CONSTRAINT and others have matched above; anything else is not from pg_dump
  const head = s.split(/\s+/).slice(0, 3).join(' ').replace(/[;(].*$/, '');
  return `"${head}" is not something pg_dump writes for one schema`;
}

// ------------------------------------------------------------------ COPY FROM STDIN

interface Conn {
  query(text: string): void;
  sendCopyFromChunk(chunk: Buffer): void;
  endCopyFrom(): void;
  sendCopyFail(msg: string): void;
  stream: NodeJS.WritableStream & { writableNeedDrain?: boolean };
}

/** A COPY … FROM STDIN as a pg submittable: write() chunks, then end(). */
class CopyIn {
  callback?: (err: Error | null) => void;
  rows = 0;
  private conn: Conn | null = null;
  private error: Error | null = null;
  private started!: Promise<void>;
  private resolveStart!: () => void;
  private rejectStart!: (e: Error) => void;
  readonly done: Promise<number>;

  constructor(public readonly text: string) {
    this.started = new Promise((res, rej) => {
      this.resolveStart = res;
      this.rejectStart = rej;
    });
    this.started.catch(() => {});
    this.done = new Promise((res, rej) => {
      this.callback = (err) => (err ? rej(err) : res(this.rows));
    });
    this.done.catch(() => {});
  }

  submit(connection: Conn) {
    connection.query(this.text);
  }
  handleCopyInResponse(connection: Conn) {
    this.conn = connection;
    this.resolveStart();
  }
  handleCommandComplete(msg: { text?: string }) {
    const m = /^COPY (\d+)/.exec(msg.text ?? '');
    if (m) this.rows = Number(m[1]);
  }
  handleReadyForQuery() {
    this.callback?.(this.error);
  }
  handleError(err: Error) {
    // pg's client forgets the query on an error: its ReadyForQuery doesn't come here
    this.error = err;
    this.rejectStart(err);
    this.callback?.(err);
  }
  handleRowDescription() {}
  handleDataRow() {}
  handlePortalSuspended() {}
  handleEmptyQuery() {}
  handleCopyData() {}

  async write(chunk: string) {
    await this.started;
    if (this.error) return;
    this.conn!.sendCopyFromChunk(Buffer.from(chunk, 'utf8'));
    if (this.conn!.stream.writableNeedDrain) await new Promise((res) => this.conn!.stream.once('drain', res));
  }
  async end(failure?: string) {
    await this.started.catch(() => {});
    if (this.conn) {
      if (failure && !this.error) this.conn.sendCopyFail(failure);
      else this.conn.endCopyFrom();
    }
    return this.done;
  }
}

export interface ScriptStats {
  statements: number;
  tables: number;
  rows: number;
}

const CHUNK = 256 * 1024;

/**
 * Runs a pg_restore script on `client` (in the caller's transaction): every statement checked against `schema`, COPY
 * data streamed. Throws a ScriptError (the statement's line) on a refused statement or the server's error.
 */
export async function runScript(client: pg.ClientBase, lines: AsyncIterable<string>, schema: string, log: (line: string) => void): Promise<ScriptStats> {
  const lexer = new ScriptLexer();
  const stats: ScriptStats = { statements: 0, tables: 0, rows: 0 };
  let copy: { q: CopyIn; buf: string; sql: string; line: number } | null = null;
  const flush = async () => {
    if (copy && copy.buf) {
      try {
        await copy.q.write(copy.buf);
      } catch (e) {
        throw new ScriptError(`${(e as Error).message} (${copy.sql.slice(0, 80)})`, copy.line);
      }
      copy.buf = '';
    }
  };
  try {
    for await (const line of lines) {
      for (const ev of lexer.push(line)) {
        if (ev.type === 'data') {
          copy!.buf += ev.text;
          if (copy!.buf.length >= CHUNK) await flush();
          continue;
        }
        if (ev.type === 'copyEnd') {
          await flush();
          const c = copy!;
          copy = null;
          try {
            const rows = await c.q.end();
            stats.rows += rows;
            stats.tables++;
            log(`${c.sql.replace(/\s+from\s+stdin\s*;$/i, '').replace(/^copy\s+/i, '')}: ${rows} row${rows === 1 ? '' : 's'}`);
          } catch (e) {
            throw new ScriptError(`${(e as Error).message} (${c.sql.slice(0, 80)})`, c.line);
          }
          continue;
        }
        const refusal = checkStatement(ev.sql, schema);
        if (refusal) throw new ScriptError(`refused: ${refusal}`, ev.line);
        stats.statements++;
        if (ev.type === 'copy') {
          const q = new CopyIn(ev.sql);
          client.query(q as unknown as pg.QueryConfig);
          copy = { q, buf: '', sql: ev.sql, line: ev.line };
          continue;
        }
        try {
          await client.query(ev.sql);
        } catch (e) {
          throw new ScriptError(`${(e as Error).message} (${ev.sql.slice(0, 80).replace(/\s+/g, ' ')})`, ev.line);
        }
      }
    }
    lexer.end();
    return stats;
  } catch (e) {
    if (copy) await copy.q.end(String((e as Error).message).slice(0, 200)).catch(() => {});
    throw e;
  }
}
