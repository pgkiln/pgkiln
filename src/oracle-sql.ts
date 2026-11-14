// (sprint 187, NX-F1) Common Oracle SQL rewritten as PostgreSQL by the APEX importer (src/apeximport.ts).
//
// Only rewrites that keep the meaning are made, and only in code: string literals ('…', q'[…]'), quoted
// identifiers and comments are never touched.
//
//   nvl(a, b)                       coalesce(a, b)
//   nvl2(a, b, c)                   (case when a is not null then b else c end)
//   decode(e, s1, r1, …, [else])    (case when e is not distinct from s1 then r1 … else … end): DECODE treats two
//                                   nulls as equal, IS NOT DISTINCT FROM does too
//   sysdate                         localtimestamp(0)   (a DATE has seconds, no fraction, no time zone)
//   systimestamp                    current_timestamp
//   … from dual / from sys.dual     (left out: PostgreSQL selects without FROM)
//   seq.nextval, seq.currval        nextval('seq'), currval('seq')
//   v('P1_X'), nv('P1_X')           :P1_X  (a bind: pgkiln binds page items by name)
//   minus (before select or ()       except
//   "ORDER_TOTAL" (quoted, upper case) order_total  (sprint 192: Oracle folds unquoted names to upper case, so "EMP" is
//                                   EMP; ora2pg and PostgreSQL fold to lower case. A PostgreSQL keyword stays quoted:
//                                   "ORDER" → "order". Mixed-case names such as "Series 1" are left as they are.)
//
// What stays for a person (oracleisms() in the importer still names it): ROWNUM, (+) outer joins, CONNECT BY,
// LISTAGG, INSTR, TO_NUMBER without a format, SUBSTR from the end, and the APEX and Oracle packages.

/** The text with string literals, quoted identifiers and comments blanked out (same length, same positions). */
export function codeMask(sql: string): string {
  const out = sql.split('');
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end < 0 ? sql.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end < 0 ? sql.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if ((c === 'q' || c === 'Q') && next === "'" && i + 2 < sql.length && !/[\w$#]/.test(sql[i - 1] ?? '')) {
      // q'[ … ]' (also { }, ( ), < > and any other character as its own pair)
      const open = sql[i + 2];
      const close = ({ '[': ']', '{': '}', '(': ')', '<': '>' } as Record<string, string>)[open] ?? open;
      const end = sql.indexOf(`${close}'`, i + 3);
      const stop = end < 0 ? sql.length : end + 2;
      blank(i + 1, stop);
      i = stop;
    } else if (c === "'") {
      let k = i + 1;
      while (k < sql.length) {
        if (sql[k] === "'" && sql[k + 1] === "'") k += 2;
        else if (sql[k] === "'") break;
        else k++;
      }
      blank(i + 1, k);
      i = k + 1;
    } else if (c === '"') {
      const end = sql.indexOf('"', i + 1);
      const stop = end < 0 ? sql.length : end + 1;
      blank(i + 1, stop - 1);
      i = stop;
    } else i++;
  }
  return out.join('');
}

/** The position of the parenthesis that closes the one at open (in the mask), or -1. */
function closing(mask: string, open: number): number {
  let depth = 0;
  for (let k = open; k < mask.length; k++) {
    if (mask[k] === '(') depth++;
    else if (mask[k] === ')' && --depth === 0) return k;
  }
  return -1;
}

/** The arguments between open and close, split at top-level commas (taken from the original text). */
function args(sql: string, mask: string, open: number, close: number): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = open + 1;
  for (let k = open + 1; k < close; k++) {
    if (mask[k] === '(') depth++;
    else if (mask[k] === ')') depth--;
    else if (mask[k] === ',' && depth === 0) {
      out.push(sql.slice(from, k).trim());
      from = k + 1;
    }
  }
  out.push(sql.slice(from, close).trim());
  return out;
}

type Call = (a: string[]) => string | null;

const CALLS: Record<string, [string, Call]> = {
  nvl: ['nvl → coalesce', (a) => (a.length === 2 ? `coalesce(${a[0]}, ${a[1]})` : null)],
  nvl2: ['nvl2 → case', (a) => (a.length === 3 ? `(case when ${a[0]} is not null then ${a[1]} else ${a[2]} end)` : null)],
  decode: ['decode → case', (a) => {
    if (a.length < 3) return null;
    const [e, ...rest] = a;
    const whens: string[] = [];
    for (let k = 0; k + 1 < rest.length; k += 2) whens.push(`when ${e} is not distinct from ${rest[k]} then ${rest[k + 1]}`);
    return `(case ${whens.join(' ')}${rest.length % 2 ? ` else ${rest[rest.length - 1]}` : ''} end)`;
  }],
};

const WORDS: [RegExp, string, string | ((m: RegExpExecArray) => string)][] = [
  [/(?<![\w$#.])sysdate(?![\w$#])/gi, 'sysdate → localtimestamp(0)', 'localtimestamp(0)'],
  [/(?<![\w$#.])systimestamp(?![\w$#])/gi, 'systimestamp → current_timestamp', 'current_timestamp'],
  [/\s+from\s+(?:sys\.)?dual(?![\w$#])/gi, 'from dual left out', ''],
  [/(?<![\w$#.])((?:[a-z_][\w$#]*\.)?[a-z_][\w$#]*)\s*\.\s*(nextval|currval)(?![\w$#])/gi, 'sequence.nextval → nextval()',
    (m) => `${m[2].toLowerCase()}('${m[1].toLowerCase()}')`],
  [/(?<![\w$#.])minus(?=\s*(?:select\b|\())/gi, 'minus → except', 'except'],
];

/** Rewrite the common Oracle SQL in sql; done lists what was rewritten (empty: nothing). */
export function translateOracle(sql: string | null | undefined): { sql: string; done: string[] } {
  if (!sql) return { sql: sql ?? '', done: [] };
  let text = sql;
  const done = new Set<string>();
  // v('P1_X') first: its argument is a literal, so the mask can't see it
  {
    const mask = codeMask(text);
    const re = /(?<![\w$#.])n?v\s*\(\s*'([A-Za-z][\w$#]{0,127})'\s*\)/gi;
    let m: RegExpExecArray | null;
    const parts: [number, number, string][] = [];
    // only where the v is code (the mask keeps code as it is and blanks literals and comments)
    while ((m = re.exec(text))) if (mask[m.index] === text[m.index]) parts.push([m.index, m.index + m[0].length, `:${m[1].toUpperCase()}`]);
    for (const [a, b, r] of parts.reverse()) text = text.slice(0, a) + r + text.slice(b);
    if (parts.length) done.add("v('ITEM') → :ITEM");
  }
  // nvl, nvl2, decode: innermost last is fine, as each pass recomputes the mask; a bounded number of passes
  for (let pass = 0; pass < 500; pass++) {
    const mask = codeMask(text);
    const re = /(?<![\w$#.])(nvl2|nvl|decode)\s*\(/gi;
    let m: RegExpExecArray | null;
    let changed = false;
    while ((m = re.exec(mask))) {
      const name = m[1].toLowerCase();
      const open = m.index + m[0].length - 1;
      const close = closing(mask, open);
      if (close < 0) continue;
      const replacement = CALLS[name][1](args(text, mask, open, close));
      if (replacement === null) continue;
      text = text.slice(0, m.index) + replacement + text.slice(close + 1);
      done.add(CALLS[name][0]);
      changed = true;
      break;
    }
    if (!changed) break;
  }
  for (const [re, label, to] of WORDS) {
    const mask = codeMask(text);
    const parts: [number, number, string][] = [];
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    // matched in the mask (code is the same there), so a word inside a literal or a comment never matches
    while ((m = re.exec(mask))) parts.push([m.index, m.index + m[0].length, typeof to === 'string' ? to : to(m)]);
    for (const [a, b, r] of parts.reverse()) text = text.slice(0, a) + r + text.slice(b);
    if (parts.length) done.add(label);
  }
  // (sprint 192) "UPPER_CASE" quoted names: the same name as Oracle's unquoted one, lower case as ora2pg makes it
  {
    const mask = codeMask(text);
    const re = /"([A-Z_][A-Z0-9_$#]{0,127})"/g;
    const parts: [number, number, string][] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      // a quoted name in code: the mask keeps its quotes and blanks what is between them
      if (mask[m.index] !== '"' || mask[m.index + m[0].length - 1] !== '"' || mask.slice(m.index + 1, m.index + m[0].length - 1).trim()) continue;
      const low = m[1].toLowerCase();
      parts.push([m.index, m.index + m[0].length, /^[a-z_][a-z0-9_]*$/.test(low) && !PG_RESERVED.has(low) ? low : `"${low}"`]);
    }
    for (const [a, b, rep] of parts.reverse()) text = text.slice(0, a) + rep + text.slice(b);
    if (parts.length) done.add('"NAME" → name (lower case)');
  }
  return { sql: text, done: [...done] };
}

/** PostgreSQL's reserved key words (and those that can't be a column or table name): kept quoted. */
const PG_RESERVED = new Set(('all analyse analyze and any array as asc asymmetric authorization binary both case cast check collate collation column ' +
  'concurrently constraint create cross current_catalog current_date current_role current_schema current_time current_timestamp ' +
  'current_user default deferrable desc distinct do else end except false fetch for foreign freeze from full grant group having ilike ' +
  'in initially inner intersect into is isnull join lateral leading left like limit localtime localtimestamp natural not notnull null ' +
  'offset on only or order outer overlaps placing primary references returning right select session_user similar some symmetric ' +
  'system_user table tablesample then to trailing true union unique user using variadic verbose when where window with').split(' '));
