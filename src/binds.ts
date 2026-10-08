import pg from 'pg';

// Bind variables (:P1_NAME, :APP_USER) in developer SQL are replaced by
// escaped, untyped string literals. Postgres resolves an untyped literal from
// its context ('10' compared to an int column becomes an int), which mirrors
// APEX's string session state + Oracle implicit conversion, and makes
// patterns like `:P1_X is null or col = :P1_X` work, which fail with $n
// parameters ("could not determine data type of parameter").
//
// The scanner skips string literals, dollar quotes, quoted identifiers,
// comments and :: casts, so only real bind references are replaced.

export type BindValues = Record<string, string | null | undefined>;

/** Bind names the server sets (see bindValues in runtime/context.ts); input from outside never sets them. */
export const RESERVED_BINDS = new Set(['APP_USER', 'APP_ID', 'APP_ALIAS', 'APP_SESSION', 'APP_PAGE_ID', 'REQUEST', 'APP_LANGUAGE']);

const IDENT_START = /[A-Za-z_]/;
const IDENT_CHAR = /[A-Za-z0-9_]/;

export function literal(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return 'NULL';
  if (value.includes('\0')) throw new Error('Session state value contains a NUL byte');
  return pg.escapeLiteral(value);
}

/** Names of all bind variables referenced in `sql`, upper-cased. */
export function bindNames(sql: string): string[] {
  const names = new Set<string>();
  substitute(sql, (name) => {
    names.add(name);
    return '';
  });
  return [...names];
}

/** Replace every :NAME with the literal for values[NAME] (NULL if unset). */
export function applyBinds(sql: string, values: BindValues): string {
  return substitute(sql, (name) => literal(values[name]));
}

/**
 * When a comment, quoted string or identifier, or dollar-quoted body starts
 * at sql[i], the index just past its end; otherwise null.
 */
export function skipQuoted(sql: string, i: number): number | null {
  const n = sql.length;
  const c = sql[i];
  const next = sql[i + 1];
  // -- line comment
  if (c === '-' && next === '-') {
    const end = sql.indexOf('\n', i);
    return end === -1 ? n : end;
  }
  // /* block comment */ (Postgres allows nesting)
  if (c === '/' && next === '*') {
    let depth = 0;
    let j = i;
    while (j < n) {
      if (sql[j] === '/' && sql[j + 1] === '*') {
        depth++;
        j += 2;
      } else if (sql[j] === '*' && sql[j + 1] === '/') {
        depth--;
        j += 2;
        if (depth === 0) break;
      } else j++;
    }
    return j;
  }
  // 'string' (incl. E'...' where backslash escapes a quote) and "identifier"
  if (c === "'" || c === '"') {
    const backslashEscapes = c === "'" && (sql[i - 1] === 'E' || sql[i - 1] === 'e');
    let j = i + 1;
    while (j < n) {
      if (backslashEscapes && sql[j] === '\\') {
        j += 2;
        continue;
      }
      if (sql[j] === c) {
        if (sql[j + 1] === c) {
          j += 2;
          continue;
        }
        break;
      }
      j++;
    }
    return Math.min(n, j + 1);
  }
  // $tag$ dollar quoting $tag$
  if (c === '$') {
    const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
    if (m) {
      const tag = m[0];
      const end = sql.indexOf(tag, i + tag.length);
      return end === -1 ? n : end + tag.length;
    }
  }
  return null;
}

/** The statements of a script, split at semicolons outside comments, strings and dollar quotes. */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  while (i < sql.length) {
    const end = skipQuoted(sql, i);
    if (end !== null) {
      i = end;
      continue;
    }
    if (sql[i] === ';') {
      out.push(sql.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  out.push(sql.slice(start));
  // leading comments go (so the statement starts with its keyword); one of only comments isn't a statement
  return out.map((x) => x.replace(/^(\s*(--[^\n]*(\n|$)|\/\*[\s\S]*?\*\/))*\s*/, '').trim()).filter(Boolean);
}

function substitute(sql: string, replace: (name: string) => string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    const end = skipQuoted(sql, i);
    if (end !== null) {
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    // :: cast
    if (c === ':' && next === ':') {
      out += '::';
      i += 2;
      continue;
    }
    // :NAME bind (but not :=, or slices like arr[1:2])
    if (c === ':' && next !== undefined && IDENT_START.test(next)) {
      let j = i + 1;
      while (j < n && IDENT_CHAR.test(sql[j])) j++;
      out += replace(sql.slice(i + 1, j).toUpperCase());
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Query parameters ($1, $2, …) collected while a statement is built: user
 * input (search terms, facet values, range bounds) is sent separately from
 * the SQL text and never parsed as SQL.
 */
export class SqlParams {
  readonly values: unknown[] = [];
  /** The placeholder for a value; a cast keeps its type clear to Postgres. */
  add(value: unknown, cast?: string): string {
    if (typeof value === 'string' && value.includes('\0')) throw new Error('A query parameter contains a NUL byte');
    this.values.push(value);
    return `$${this.values.length}${cast ? `::${cast}` : ''}`;
  }
}

/** pg query values: undefined when there are none (so the simple protocol is used as before). */
export const queryValues = (values: unknown[] | undefined) => (values?.length ? values : undefined);
