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

function substitute(sql: string, replace: (name: string) => string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];

    // -- line comment
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      out += sql.slice(i, stop);
      i = stop;
      continue;
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
      out += sql.slice(i, j);
      i = j;
      continue;
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
      out += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    // $tag$ dollar quoting $tag$
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? n : end + tag.length;
        out += sql.slice(i, stop);
        i = stop;
        continue;
      }
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
