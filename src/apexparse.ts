// (sprint 182, CD-1/CD-4 leftover) Reading an Oracle APEX application export in the SQL format
// (f100.sql, or the files of a split export) as text. The file is a PL/SQL script of calls such as
//
//   wwv_flow_imp_page.create_page_validation(
//    p_id=>wwv_flow_imp.id(13695404843417934)
//   ,p_validation_name=>'P3_SAL is numeric'
//   ,p_validation_type=>'ITEM_IS_NUMERIC'
//   ,p_error_message=>'#LABEL# must be numeric.'
//   );
//
// It is untrusted input and is never run: a tokenizer reads its string literals (with '' escapes,
// q'[…]' quoting and unistr('\00e9')), numbers and names, and every call to a wwv_* package becomes
// an ApexCall with its named arguments evaluated as far as an export needs: wwv_flow_imp.id(…) and
// wwv_flow_api.id(…) are ApexIds, wwv_flow_string.join(wwv_flow_t_varchar2('a', 'b')) is 'a\nb',
// || concatenates, nvl(x, 'default') takes the default when x is something only APEX knows
// (wwv_flow_application_install.get_schema). Everything else is ignored. src/apeximport.ts maps the
// calls to a pgkiln application.

/** A component id: wwv_flow_imp.id(123). */
export class ApexId {
  constructor(readonly id: string) {}
  toString() {
    return this.id;
  }
}

export type ApexValue = string | number | boolean | null | undefined | ApexId | ApexValue[];

export interface ApexCall {
  /** the package without its prefix's version: wwv_flow_imp_page, wwv_flow_imp_shared, wwv_flow_api … (lower case) */
  pkg: string;
  /** the procedure, lower case: create_page_item */
  method: string;
  /** named arguments by their lower-case name (p_name); positional ones as $1, $2 … */
  args: Record<string, ApexValue>;
  /** the line the call starts on */
  line: number;
}

export class ApexParseError extends Error {
  constructor(message: string, readonly line: number) {
    super(`line ${line}: ${message}`);
  }
}

/** The largest export the parser reads (characters). */
export const MAX_EXPORT_CHARS = 64 * 1024 * 1024;

type Tok =
  | { t: 'str'; v: string; line: number }
  | { t: 'num'; v: number; line: number }
  | { t: 'id'; v: string; line: number }
  | { t: 'op'; v: string; line: number };

const Q_CLOSE: Record<string, string> = { '[': ']', '(': ')', '{': '}', '<': '>' };
// SQL*Plus commands an export has between its PL/SQL blocks (a prompt may hold an apostrophe)
const SQLPLUS = /^(prompt|pro|set|whenever|rem|remark|spool|define|undefine|column|col|timing|exit|quit|@@?)(\s|$)/i;

function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  const n = text.length;
  let i = 0;
  let line = 1;
  let depth = 0;
  let lineStart = true;
  while (i < n) {
    const c = text[i];
    if (c === '\n') {
      line++;
      i++;
      lineStart = true;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || c === '﻿') {
      i++;
      continue;
    }
    if (lineStart && depth === 0) {
      lineStart = false;
      const eol = text.indexOf('\n', i);
      const rest = text.slice(i, eol < 0 ? n : eol);
      if (SQLPLUS.test(rest)) {
        i = eol < 0 ? n : eol;
        continue;
      }
    }
    lineStart = false;
    // comments
    if (c === '-' && text[i + 1] === '-') {
      const eol = text.indexOf('\n', i);
      i = eol < 0 ? n : eol;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) throw new ApexParseError('a comment that is not closed', line);
      for (let k = i; k < end; k++) if (text[k] === '\n') line++;
      i = end + 2;
      continue;
    }
    // q'[ … ]' (optionally Nq'…')
    if ((c === 'q' || c === 'Q' || ((c === 'n' || c === 'N') && (text[i + 1] === 'q' || text[i + 1] === 'Q'))) && !/[A-Za-z0-9_$#]/.test(text[i - 1] ?? '')) {
      const qi = c === 'n' || c === 'N' ? i + 1 : i;
      if (text[qi + 1] === "'" && qi + 2 < n) {
        const open = text[qi + 2];
        const close = Q_CLOSE[open] ?? open;
        const start = qi + 3;
        let k = start;
        while (k < n && !(text[k] === close && text[k + 1] === "'")) k++;
        if (k >= n) throw new ApexParseError(`a q'${open}…${close}' string that is not closed`, line);
        const v = text.slice(start, k);
        out.push({ t: 'str', v, line });
        for (const ch of v) if (ch === '\n') line++;
        i = k + 2;
        continue;
      }
    }
    // '…' with '' for a quote (optionally N'…')
    if (c === "'" || ((c === 'n' || c === 'N') && text[i + 1] === "'" && !/[A-Za-z0-9_$#]/.test(text[i - 1] ?? ''))) {
      const startLine = line;
      let k = c === "'" ? i + 1 : i + 2;
      let v = '';
      for (;;) {
        const q = text.indexOf("'", k);
        if (q < 0) throw new ApexParseError('a string that is not closed', startLine);
        v += text.slice(k, q);
        if (text[q + 1] === "'") {
          v += "'";
          k = q + 2;
          continue;
        }
        k = q + 1;
        break;
      }
      for (const ch of v) if (ch === '\n') line++;
      out.push({ t: 'str', v, line: startLine });
      i = k;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
      const m = /^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?/.exec(text.slice(i, i + 64))!;
      // ids are larger than a double holds exactly (13700000000000207): keep long integers as text
      if (/^[0-9]{16,}$/.test(m[0])) out.push({ t: 'str', v: m[0], line });
      else out.push({ t: 'num', v: Number(m[0]), line });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let k = i + 1;
      while (k < n && /[A-Za-z0-9_$#]/.test(text[k])) k++;
      out.push({ t: 'id', v: text.slice(i, k).toLowerCase(), line });
      i = k;
      continue;
    }
    if (c === '"') {
      const end = text.indexOf('"', i + 1);
      if (end < 0) throw new ApexParseError('a quoted name that is not closed', line);
      out.push({ t: 'id', v: text.slice(i + 1, end), line });
      i = end + 1;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (two === '=>' || two === '||' || two === ':=') {
      out.push({ t: 'op', v: two, line });
      i += 2;
      continue;
    }
    if (c === '(') depth++;
    if (c === ')') depth = Math.max(0, depth - 1);
    out.push({ t: 'op', v: c, line });
    i++;
  }
  return out;
}

/** unistr('caf\00e9') → café (UTF-16 code units, \\ for a backslash) */
export function unistr(s: string) {
  return s.replace(/\\\\|\\([0-9a-fA-F]{4})/g, (m, hex) => (hex ? String.fromCharCode(parseInt(hex, 16)) : '\\'));
}

const UNKNOWN = undefined;

class Parser {
  private p = 0;
  // nested calls and parentheses: a crafted file can't run the stack out
  private nesting = 0;
  constructor(private readonly toks: Tok[]) {}

  calls(): ApexCall[] {
    const out: ApexCall[] = [];
    const toks = this.toks;
    while (this.p < toks.length) {
      const t = toks[this.p];
      // a call to a wwv_ package: name(.name)* (
      if (t.t === 'id' && t.v.startsWith('wwv_')) {
        const start = this.p;
        const chain = this.chain();
        if (this.peekOp('(') && chain.length >= 2) {
          const args = this.args();
          out.push({ pkg: chain.slice(0, -1).join('.'), method: chain[chain.length - 1], args, line: t.line });
          continue;
        }
        if (this.p === start) this.p++;
        continue;
      }
      this.p++;
    }
    return out;
  }

  private peekOp(v: string) {
    const t = this.toks[this.p];
    return t?.t === 'op' && t.v === v;
  }

  private expectOp(v: string) {
    const t = this.toks[this.p];
    if (!(t?.t === 'op' && t.v === v)) throw new ApexParseError(`expected "${v}"`, t?.line ?? this.toks[this.toks.length - 1]?.line ?? 1);
    this.p++;
  }

  /** name(.name)* */
  private chain() {
    const parts: string[] = [];
    while (this.toks[this.p]?.t === 'id') {
      parts.push((this.toks[this.p] as { v: string }).v);
      this.p++;
      if (this.peekOp('.') && this.toks[this.p + 1]?.t === 'id') this.p++;
      else break;
    }
    return parts;
  }

  /** ( p_a=>v, p_b=>v, … ) or positional values */
  private args(): Record<string, ApexValue> {
    this.expectOp('(');
    const args: Record<string, ApexValue> = {};
    let pos = 0;
    if (this.peekOp(')')) {
      this.p++;
      return args;
    }
    for (;;) {
      const t = this.toks[this.p];
      const next = this.toks[this.p + 1];
      if (t?.t === 'id' && next?.t === 'op' && next.v === '=>') {
        this.p += 2;
        args[t.v] = this.value();
      } else args[`$${++pos}`] = this.value();
      if (this.peekOp(',')) {
        this.p++;
        continue;
      }
      this.expectOp(')');
      return args;
    }
  }

  private value(): ApexValue {
    if (++this.nesting > 100) throw new ApexParseError('calls or parentheses nested too deeply', this.toks[this.p]?.line ?? 1);
    try {
      return this.valueInner();
    } finally {
      this.nesting--;
    }
  }

  private valueInner(): ApexValue {
    let v = this.term();
    for (;;) {
      if (this.peekOp('||')) {
        this.p++;
        const r = this.term();
        v = `${text(v)}${text(r)}`;
        continue;
      }
      if (this.peekOp('+') || this.peekOp('-') || this.peekOp('*') || this.peekOp('/')) {
        const op = (this.toks[this.p] as { v: string }).v;
        this.p++;
        const r = this.term();
        // wwv_flow_api.id(1)+wwv_flow_api.g_id_offset: the id
        if (typeof v === 'number' && typeof r === 'number') v = op === '+' ? v + r : op === '-' ? v - r : op === '*' ? v * r : v / r;
        continue;
      }
      return v;
    }
  }

  private term(): ApexValue {
    const t = this.toks[this.p];
    if (!t) throw new ApexParseError('the file ends inside a call', this.toks[this.toks.length - 1]?.line ?? 1);
    if (t.t === 'str') {
      this.p++;
      return t.v;
    }
    if (t.t === 'num') {
      this.p++;
      return t.v;
    }
    if (t.t === 'op' && t.v === '-') {
      this.p++;
      const v = this.term();
      return typeof v === 'number' ? -v : v;
    }
    if (t.t === 'op' && t.v === '(') {
      this.p++;
      const v = this.value();
      this.expectOp(')');
      return v;
    }
    if (t.t === 'id') {
      if (t.v === 'true' || t.v === 'false') {
        this.p++;
        return t.v === 'true';
      }
      if (t.v === 'null') {
        this.p++;
        return null;
      }
      const chain = this.chain();
      if (this.peekOp('(')) {
        const args = this.args();
        let v = call(chain, args);
        // (sprint 190) APEX 26.2: a method on the value, wwv_flow_t_plugin_attributes(…).to_clob: the value itself
        while (this.peekOp('.') && this.toks[this.p + 1]?.t === 'id') {
          this.p += 2;
          if (this.peekOp('(')) this.args();
        }
        return v;
      }
      return UNKNOWN;
    }
    throw new ApexParseError(`unexpected "${t.v}"`, t.line);
  }
}

const text = (v: ApexValue): string => (v === null || v === undefined ? '' : Array.isArray(v) ? v.map(text).join('\n') : String(v));

/** The few functions an export uses in its arguments. */
function call(chain: string[], args: Record<string, ApexValue>): ApexValue {
  const name = chain[chain.length - 1];
  const pos = Object.keys(args).filter((k) => k.startsWith('$')).map((k) => args[k]);
  if (name === 'id' && chain.length > 1) return new ApexId(text(pos[0]));
  if (name === 'join') return Array.isArray(pos[0]) ? pos[0].map(text).join(pos.length > 1 ? text(pos[1]) : '\n') : text(pos[0]);
  if (/^wwv_flow_t_/.test(name) || name === 'table') return pos;
  if (name === 'nvl' || name === 'coalesce') return pos.find((v) => v !== undefined && v !== null) ?? null;
  if (name === 'unistr') return unistr(text(pos[0]));
  if (name === 'chr') return typeof pos[0] === 'number' ? String.fromCharCode(pos[0]) : UNKNOWN;
  if (name === 'to_date' || name === 'to_timestamp' || name === 'to_clob' || name === 'to_number') return pos[0];
  return UNKNOWN;
}

/** Every call to a wwv_* package in an APEX SQL export, in file order. Throws ApexParseError on a broken file. */
export function parseApexCalls(source: string): ApexCall[] {
  if (source.length > MAX_EXPORT_CHARS) throw new ApexParseError(`the export is larger than ${MAX_EXPORT_CHARS / 1024 / 1024} MB`, 1);
  return new Parser(tokenize(source)).calls();
}

/** The files of a split export (application/…/*.sql) in the order APEX's install.sql runs them; others last, by path. */
export function joinSplitExport(files: Map<string, string>) {
  const names = [...files.keys()].filter((p) => /\.sql$/i.test(p));
  const install = names.filter((p) => /(^|\/)install\.sql$/i.test(p)).sort((a, b) => a.length - b.length)[0];
  const order: string[] = [];
  if (install) {
    const base = install.slice(0, install.length - 'install.sql'.length);
    for (const m of files.get(install)!.matchAll(/^\s*@@?\s*(\S+\.sql)\s*$/gim)) {
      const p = base + m[1].replace(/^\.\//, '');
      if (files.has(p) && !order.includes(p)) order.push(p);
    }
  }
  for (const p of names.sort()) if (p !== install && !order.includes(p)) order.push(p);
  return order.map((p) => files.get(p)!).join('\n/\n');
}
