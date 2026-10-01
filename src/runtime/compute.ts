import pg from 'pg';
import { literal } from '../binds.ts';

// Computed columns of an interactive report (APEX: Actions → Data → Compute).
// The end user types a small expression over the report's columns:
//
//   price * quantity * (1 + vat / 100)        upper(name) || ' (' || city || ')'
//
// It is parsed here and turned into SQL that contains only quoted
// identifiers of columns that exist, escaped literals, whitelisted
// operators and whitelisted functions, so it can't reach anything the
// report's own query can't. Division returns numeric and NULL for x / 0.

export class ComputeError extends Error {}

/** Function name → [min args, max args]. */
const FUNCTIONS: Record<string, [number, number]> = {
  abs: [1, 1], ceil: [1, 1], floor: [1, 1], round: [1, 2], trunc: [1, 2], mod: [2, 2], power: [2, 2],
  upper: [1, 1], lower: [1, 1], initcap: [1, 1], length: [1, 1], trim: [1, 1], substr: [2, 3],
  left: [2, 2], right: [2, 2], replace: [3, 3], concat: [1, 10],
  coalesce: [1, 10], nullif: [2, 2], greatest: [1, 10], least: [1, 10],
};
const MAX_LENGTH = 500;
const MAX_DEPTH = 30;

type Token = { t: 'num' | 'str' | 'id' | 'qid' | 'op' | '(' | ')' | ','; v: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (/[0-9.]/.test(ch)) {
      const m = /^(\d+(\.\d*)?|\.\d+)/.exec(src.slice(i));
      if (!m) throw new ComputeError(`Unexpected "${ch}".`);
      out.push({ t: 'num', v: m[0] });
      i += m[0].length;
    } else if (ch === "'") {
      let s = '';
      i++;
      for (;;) {
        if (i >= src.length) throw new ComputeError('A text value is missing its closing quote.');
        if (src[i] === "'") {
          if (src[i + 1] === "'") { s += "'"; i += 2; continue; }
          i++;
          break;
        }
        s += src[i++];
      }
      out.push({ t: 'str', v: s });
    } else if (ch === '"') {
      const end = src.indexOf('"', i + 1);
      if (end === -1) throw new ComputeError('A column name is missing its closing quote.');
      out.push({ t: 'qid', v: src.slice(i + 1, end) });
      i = end + 1;
    } else if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(src.slice(i))!;
      out.push({ t: 'id', v: m[0] });
      i += m[0].length;
    } else if (src.startsWith('||', i)) {
      out.push({ t: 'op', v: '||' });
      i += 2;
    } else if ('+-*/'.includes(ch)) {
      out.push({ t: 'op', v: ch });
      i++;
    } else if (ch === '(' || ch === ')' || ch === ',') {
      out.push({ t: ch, v: ch });
      i++;
    } else throw new ComputeError(`Unexpected "${ch}".`);
  }
  return out;
}

/**
 * The SQL for an expression over the given columns, referenced as
 * <alias>."column". Column names match case-insensitively; quote them
 * ("Total pay") when they aren't plain words.
 */
export function computeSql(expr: string, columns: string[], alias = '"__s"'): string {
  if (!expr.trim()) throw new ComputeError('The expression is empty.');
  if (expr.length > MAX_LENGTH) throw new ComputeError(`The expression is longer than ${MAX_LENGTH} characters.`);
  const tokens = tokenize(expr);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const column = (name: string, exact: boolean) => {
    const found = exact ? columns.find((c) => c === name) : columns.find((c) => c.toLowerCase() === name.toLowerCase());
    if (found === undefined || found.startsWith('__')) throw new ComputeError(`There is no column ${name}.`);
    return `${alias}.${pg.escapeIdentifier(found)}`;
  };

  const binary = (ops: string[], operand: (d: number) => string) => (depth: number): string => {
    let left = operand(depth);
    while (peek()?.t === 'op' && ops.includes(peek().v)) {
      const op = next().v;
      const right = operand(depth);
      // || on text, numeric division without integer truncation and without division by zero errors
      left = op === '/' ? `((${left})::numeric / nullif((${right})::numeric, 0))` : op === '||' ? `(${left})::text || (${right})::text` : `(${left} ${op} ${right})`;
    }
    return left;
  };
  const factor = (depth: number): string => {
    if (depth > MAX_DEPTH) throw new ComputeError('The expression is nested too deeply.');
    const tk = next();
    if (!tk) throw new ComputeError('The expression ends too early.');
    if (tk.t === 'op' && (tk.v === '-' || tk.v === '+')) return `(${tk.v}${factor(depth + 1)})`;
    if (tk.t === 'num') return /\./.test(tk.v) ? `${tk.v}::numeric` : tk.v;
    if (tk.t === 'str') return `${literal(tk.v)}::text`;
    if (tk.t === 'qid') return column(tk.v, true);
    if (tk.t === '(') {
      const inner = sum(depth + 1);
      if (next()?.t !== ')') throw new ComputeError('A closing parenthesis is missing.');
      return `(${inner})`;
    }
    if (tk.t === 'id') {
      if (peek()?.t !== '(') {
        const kw = tk.v.toLowerCase();
        if (kw === 'null') return 'null';
        return column(tk.v, false);
      }
      const fn = tk.v.toLowerCase();
      const arity = FUNCTIONS[fn];
      if (!arity) throw new ComputeError(`Unknown function ${tk.v}. Allowed: ${Object.keys(FUNCTIONS).join(', ')}.`);
      next(); // (
      const args: string[] = [];
      if (peek()?.t !== ')')
        for (;;) {
          args.push(sum(depth + 1));
          if (peek()?.t === ',') { next(); continue; }
          break;
        }
      if (next()?.t !== ')') throw new ComputeError(`A closing parenthesis is missing after ${tk.v}(…).`);
      if (args.length < arity[0] || args.length > arity[1]) throw new ComputeError(`${fn} takes ${arity[0] === arity[1] ? arity[0] : `${arity[0]} to ${arity[1]}`} arguments.`);
      // round/trunc with digits need numeric; substr/left/right need text and integer positions
      if ((fn === 'round' || fn === 'trunc') && args.length === 2) return `${fn}((${args[0]})::numeric, (${args[1]})::int)`;
      if (fn === 'substr' || fn === 'left' || fn === 'right') return `${fn}((${args[0]})::text, ${args.slice(1).map((a) => `(${a})::int`).join(', ')})`;
      if (['upper', 'lower', 'initcap', 'length', 'trim', 'replace'].includes(fn)) return `${fn}(${args.map((a) => `(${a})::text`).join(', ')})`;
      return `${fn}(${args.join(', ')})`;
    }
    throw new ComputeError(`Unexpected "${tk.v}".`);
  };
  const product = binary(['*', '/'], factor);
  const sum = binary(['+', '-', '||'], product);

  const sql = sum(0);
  if (pos < tokens.length) throw new ComputeError(`Unexpected "${tokens[pos].v}".`);
  return sql;
}

export interface Computation {
  name: string;
  expr: string;
  raw: string;
}

/** A valid name for a computed column: shown as its heading, so words and spaces are fine. */
export const computeNameOk = (name: string) => /^[\p{L}\p{N} _\-().%]{1,40}$/u.test(name) && !name.startsWith('__');
