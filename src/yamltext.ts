// The "text" style of the directory export (APEX 26.1: APEXlang, human-
// readable application files): each component as YAML instead of JSON, with
// SQL, PL/pgSQL and templates inline as literal blocks, so a region with its
// query, a process with its code, is one file a reviewer reads top to bottom.
//
// The writer emits a strict subset of YAML 1.2 that any YAML tool reads, and
// the reader reads exactly that subset back (no dependency, no tags, anchors,
// flow collections or multi-document files):
//   - block mappings (`key: value`, nested by two spaces) and block sequences
//     (`- value`, at the same indentation as their key);
//   - scalars: null, true, false, numbers as JSON writes them, plain strings
//     that can't be mistaken for anything else, double-quoted strings with
//     JSON escapes, and literal blocks (`|2-`, `|2`, `|2+`) for multi-line text;
//   - `{}` and `[]` for empty collections; `#` comment lines are skipped.
// Keys are written in sorted order, like the JSON style. toText → fromText
// returns the same JSON value (test/yamltext.test.ts checks every HR file).

const RESERVED = /^(?:null|~|true|false|yes|no|on|off|y|n|\.inf|-\.inf|\.nan)$/i;
const NUMBERISH = /^[-+]?(?:\d|\.\d)|^0[xob]/i;
const PLAIN = /^[A-Za-z_/][A-Za-z0-9_ ./()&$:,'-]*$/;

/** A string that reads back as itself without quotes. */
function plainSafe(s: string) {
  return (
    s.length > 0 &&
    s.length <= 200 &&
    PLAIN.test(s) &&
    !RESERVED.test(s) &&
    !NUMBERISH.test(s) &&
    !s.endsWith(' ') &&
    !s.includes(': ') &&
    !s.endsWith(':') &&
    !s.includes(' #')
  );
}

const quote = (s: string) => JSON.stringify(s).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/** Text a literal block can carry: lines without control characters (tabs are fine) or a CR. */
const blockSafe = (s: string) => s.includes('\n') && !/[\u0000-\u0008\u000b-\u001f\u007f\u0085\u2028\u2029\ufeff]/.test(s);

function scalar(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'number') return Number.isFinite(v) ? JSON.stringify(v) : 'null';
  const s = String(v);
  return plainSafe(s) ? s : quote(s);
}

const KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const key = (k: string) => (KEY.test(k) && !RESERVED.test(k) && k.length <= 200 ? k : quote(k));

/** A literal block: the indentation is given (2), the chomping keeps the exact trailing newlines. */
function block(s: string, indent: string) {
  const trailing = /\n*$/.exec(s)![0].length;
  const chomp = trailing === 0 ? '-' : trailing === 1 ? '' : '+';
  const body = trailing === 0 ? s : s.slice(0, -1);
  return `|2${chomp}\n${body.split('\n').map((line) => (line ? indent + '  ' + line : '')).join('\n')}`;
}

function emit(v: unknown, indent: string, out: string[]) {
  // called for a value under a key or a dash: writes the lines after it
  if (Array.isArray(v)) {
    for (const x of v) {
      if (x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length) {
        // "- key: value" with the rest of the mapping under it
        const lines: string[] = [];
        mapping(x as Record<string, unknown>, indent + '  ', lines);
        out.push(`${indent}- ${lines[0].slice(indent.length + 2)}`, ...lines.slice(1));
      } else if (Array.isArray(x) && x.length) {
        out.push(`${indent}-`);
        emit(x, indent + '  ', out);
      } else out.push(`${indent}- ${inline(x, indent + '  ')}`);
    }
  } else mapping(v as Record<string, unknown>, indent, out);
}

/** A value that fits after "key: " or "- " (scalars, empty collections, literal blocks). */
function inline(v: unknown, indent: string) {
  if (Array.isArray(v)) return '[]';
  if (v && typeof v === 'object') return '{}';
  if (typeof v === 'string' && blockSafe(v)) return block(v, indent.slice(2));
  return scalar(v);
}

function mapping(o: Record<string, unknown>, indent: string, out: string[]) {
  for (const k of Object.keys(o).sort()) {
    const v = o[k];
    if (v === undefined) continue;
    const nonEmpty = (Array.isArray(v) && v.length) || (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length);
    if (nonEmpty) {
      out.push(`${indent}${key(k)}:`);
      emit(v, Array.isArray(v) ? indent : indent + '  ', out);
    } else out.push(`${indent}${key(k)}: ${inline(v, indent + '  ')}`);
  }
}

/** A JSON value as text (a mapping or a sequence at the top; a scalar as one line). */
export function toText(v: unknown): string {
  const out: string[] = [];
  if (Array.isArray(v) ? v.length : v && typeof v === 'object' && Object.keys(v).length) emit(v, '', out);
  else out.push(inline(v, '  '));
  return out.join('\n') + '\n';
}

// ------------------------------------------------------------------ reading

class TextError extends Error {}

interface Line {
  no: number;
  indent: number;
  text: string;
}

/** The text back as the JSON value; `where` names the file in errors. */
export function fromText(src: string, where = 'text'): unknown {
  const raw = src.replace(/\r\n/g, '\n').split('\n');
  // the file's own final newline is not an empty line of the last value
  if (raw.length > 1 && raw[raw.length - 1] === '') raw.pop();
  let i = 0;
  const fail = (msg: string, no = i + 1): never => {
    throw new TextError(`${where}, line ${no}: ${msg}`);
  };
  const indentOf = (s: string) => /^ */.exec(s)![0].length;
  /** The next line with content (comments and blank lines skipped), without consuming it. */
  const peek = (): Line | null => {
    while (i < raw.length) {
      const s = raw[i];
      if (/^\s*(#.*)?$/.test(s)) {
        i++;
        continue;
      }
      if (/^\t| \t/.test(s.slice(0, indentOf(s) + 1))) fail('tabs are not allowed for indentation');
      return { no: i + 1, indent: indentOf(s), text: s.slice(indentOf(s)) };
    }
    return null;
  };

  function readScalar(t: string, no: number, indent: number): unknown {
    if (t === 'null' || t === '~') return null;
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === '{}') return {};
    if (t === '[]') return [];
    if (/^-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?$/.test(t)) return Number(t);
    if (t.startsWith('"')) {
      try {
        return JSON.parse(t);
      } catch {
        fail('a double-quoted string must use JSON escapes and end on its line', no);
      }
    }
    const m = /^\|(\d)?([-+]?)$/.exec(t);
    if (m) return readBlock(indent, m[1] ? Number(m[1]) : null, m[2]);
    if (/^[|>'&*!%@`[{]/.test(t)) fail(`this YAML is outside the subset pgapex reads: ${t.slice(0, 20)}`, no);
    if (!plainSafe(t)) fail(`a text like ${quote(t.slice(0, 40))} must be in double quotes`, no);
    return t;
  }

  /** A literal block whose lines are indented more than `parent`. */
  function readBlock(parent: number, given: number | null, chomp: string) {
    const lines: string[] = [];
    let indent = given !== null ? parent + given : -1;
    while (i < raw.length) {
      const s = raw[i];
      if (s.trim() === '') {
        // a line of spaces inside the text keeps the spaces beyond the block's indentation
        lines.push(indent >= 0 && s.length > indent ? s.slice(indent) : '');
        i++;
        continue;
      }
      const n = indentOf(s);
      if (indent < 0) indent = n;
      if (n < indent || n <= parent) break;
      lines.push(s.slice(indent));
      i++;
    }
    // trailing empty lines belong to the block only as chomping says
    let end = lines.length;
    while (end > 0 && lines[end - 1] === '') end--;
    const body = lines.slice(0, end).join('\n');
    const extra = lines.length - end;
    if (chomp === '-') return body;
    if (chomp === '+') return body + '\n'.repeat(extra + 1);
    return body + '\n';
  }

  function readValue(indent: number): unknown {
    const l = peek();
    if (!l || l.indent < indent) fail('a value is missing');
    return l!.text.startsWith('- ') || l!.text === '-' ? readSeq(l!.indent) : readMap(l!.indent);
  }

  function readSeq(indent: number): unknown[] {
    const out: unknown[] = [];
    for (let l = peek(); l && l.indent === indent && (l.text.startsWith('- ') || l.text === '-'); l = peek()) {
      i++;
      const rest = l.text === '-' ? '' : l.text.slice(2);
      if (rest === '') out.push(readValue(indent + 1));
      else if (/^("(?:[^"\\]|\\.)*"|[^\s"#][^#]*?):(\s|$)/.test(rest) && !/^\|/.test(rest)) {
        // "- key: value": a mapping whose first key is on the dash's line
        i--;
        raw[i] = ' '.repeat(indent + 2) + rest;
        out.push(readMap(indent + 2));
      } else out.push(readScalar(rest, l.no, indent));
    }
    return out;
  }

  function readMap(indent: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (let l = peek(); l && l.indent === indent; l = peek()) {
      if (l.text.startsWith('- ')) fail('a list item where a key was expected', l.no);
      const m = /^("(?:[^"\\]|\\.)*"|[^\s"#][^:#]*?):(?: (.*))?$/.exec(l.text);
      if (!m) fail(`expected "key: value"`, l.no);
      let k = m![1];
      if (k.startsWith('"')) k = JSON.parse(k);
      if (Object.prototype.hasOwnProperty.call(out, k)) fail(`the key "${k}" appears twice`, l.no);
      i++;
      const rest = (m![2] ?? '').replace(/\s+#.*$/, '').trim();
      let v: unknown;
      if (rest === '') {
        // a nested mapping (indented) or a sequence (at the same indentation or indented)
        const next = peek();
        v = next && next.indent >= indent && (next.text.startsWith('- ') || next.text === '-') ? readSeq(next.indent) : next && next.indent > indent ? readMap(next.indent) : null;
      } else v = readScalar(m![2].startsWith('"') ? m![2].trim() : rest, l.no, indent);
      Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
    }
    return out;
  }

  const first = peek();
  if (!first) return null;
  if (first.indent !== 0) fail('the first line must not be indented', first.no);
  let v: unknown;
  if (first.text.startsWith('- ') || first.text === '-') v = readSeq(0);
  else if (/^("(?:[^"\\]|\\.)*"|[^\s"#][^:#]*?):(\s|$)/.test(first.text)) v = readMap(0);
  else {
    i++;
    v = readScalar(first.text, first.no, 0);
  }
  const rest = peek();
  if (rest) fail('unexpected indentation or content', rest.no);
  return v;
}
