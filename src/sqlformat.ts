import { skipQuoted } from './binds.ts';

// (sprint 93, Database Actions DA-9) Format SQL for the worksheet (Ctrl+F7): keywords in one case, each clause
// of a query on its own line (SELECT, FROM, WHERE, GROUP BY, …), joins indented, AND / OR of a condition and the
// columns of a select list one per line, subqueries indented. Strings, quoted identifiers, dollar-quoted bodies
// and comments are kept as they are; everything else is re-spaced. It is a layout aid, not a parser: SQL it
// doesn't understand keeps its words and order.

const KEYWORDS = new Set(`
  select from where and or not in is null like ilike between exists as on join inner left right full outer cross natural
  using group by order having limit offset fetch first next rows row only union all intersect except distinct case when
  then else end insert into values update set delete returning with recursive create table view materialized index
  replace drop alter add column constraint primary key foreign references unique check default cascade restrict
  truncate grant revoke to begin commit rollback do language function procedure returns return true false asc desc
  nulls last over partition window filter lateral any some array cast interval if conflict nothing merge matched
  explain analyze schema sequence trigger policy for each execute`.trim().split(/\s+/));

/** Clauses that start a line in a query; two-word ones are matched as their first word plus the next. */
const CLAUSES = new Set(['select', 'from', 'where', 'having', 'limit', 'offset', 'fetch', 'union', 'intersect', 'except', 'window', 'returning', 'values', 'set', 'with', 'insert', 'update', 'delete', 'on conflict']);
const TWO_WORD = new Set(['group by', 'order by', 'partition by', 'on conflict', 'union all']);
const JOIN_START = new Set(['join', 'inner', 'left', 'right', 'full', 'cross', 'natural']);

type Tok = { t: 'ws' | 'word' | 'quoted' | 'comment' | 'punct' | 'num'; v: string };

function tokens(sql: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (/\s/.test(c)) {
      let j = i + 1;
      while (j < sql.length && /\s/.test(sql[j])) j++;
      out.push({ t: 'ws', v: sql.slice(i, j) });
      i = j;
      continue;
    }
    const prev = i > 0 ? sql[i - 1] : '';
    if (!(c === '$' && /[A-Za-z0-9_]/.test(prev))) {
      const end = skipQuoted(sql, i);
      if (end !== null && end > i) {
        out.push({ t: c === '-' || c === '/' ? 'comment' : 'quoted', v: sql.slice(i, end) });
        i = end;
        continue;
      }
    }
    if (/[A-Za-z_\u0080-￿]/.test(c)) {
      let j = i + 1;
      while (j < sql.length && /[A-Za-z0-9_$\u0080-￿]/.test(sql[j])) j++;
      // E'…' strings: the E belongs to the string
      if ((sql[j] === "'") && j === i + 1 && /[eE]/.test(c)) {
        const end = skipQuoted(sql, j)!;
        out.push({ t: 'quoted', v: sql.slice(i, end) });
        i = end;
        continue;
      }
      out.push({ t: 'word', v: sql.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < sql.length && /[0-9.eE_]/.test(sql[j])) j++;
      out.push({ t: 'num', v: sql.slice(i, j) });
      i = j;
      continue;
    }
    // $1 parameters
    const param = c === '$' ? /^\$\d+/.exec(sql.slice(i, i + 12)) : null;
    if (param) {
      out.push({ t: 'num', v: param[0] });
      i += param[0].length;
      continue;
    }
    // operators of several characters stay together (::, <=, <>, ->>, ||, :=)
    const op = /^(::|->>|->|#>>|#>|<=|>=|<>|!=|\|\||:=|=>)/.exec(sql.slice(i, i + 3));
    out.push({ t: 'punct', v: op ? op[0] : c });
    i += op ? op[0].length : 1;
  }
  return out;
}

export function formatSql(sql: string, keywordCase: 'upper' | 'lower' = 'lower'): string {
  const toks = tokens(sql).filter((t) => t.t !== 'ws');
  const kw = (w: string) => (keywordCase === 'upper' ? w.toUpperCase() : w.toLowerCase());
  interface Frame { query: boolean; base: number; clause: string; between: boolean }
  const frames: Frame[] = [{ query: true, base: 0, clause: '', between: false }];
  let out = '';
  let line = ''; // the current line
  let glue = false; // the next token sticks to the last one (a unary minus)
  const flush = () => {
    out += `${line.replace(/\s+$/, '')}\n`;
    line = '';
  };
  const newline = (indent: number) => {
    if (line.trim()) flush();
    line = ' '.repeat(Math.max(0, indent));
  };
  const put = (s: string, space = true) => {
    if (glue) {
      glue = false;
      line += s;
      return;
    }
    if (space && line.trim() && !/[\s(]$/.test(line) && !/^[,).;:[\]]/.test(s) && !line.endsWith('::') && !line.endsWith('.')) line += ' ';
    else if (!line.trim() && line.length === 0) line = ' '.repeat(frames[frames.length - 1].base);
    line += s;
  };
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    const f = frames[frames.length - 1];
    const lower = t.v.toLowerCase();
    if (t.t === 'comment') {
      put(t.v);
      if (t.v.startsWith('--')) newline(f.base);
      continue;
    }
    if (t.t === 'word' && KEYWORDS.has(lower)) {
      const nextWord = toks.slice(k + 1).find((x) => x.t !== 'comment');
      const two = nextWord && nextWord.t === 'word' ? `${lower} ${nextWord.v.toLowerCase()}` : '';
      if (f.query && TWO_WORD.has(two) && two !== 'partition by') {
        newline(f.base);
        put(`${kw(lower)} ${kw(nextWord!.v.toLowerCase())}`);
        f.clause = two;
        k = toks.indexOf(nextWord!);
        continue;
      }
      if (f.query && CLAUSES.has(lower) && !(lower === 'set' && f.clause !== 'update') && !(lower === 'values' && f.clause === 'values')) {
        if ((out || line.trim()) && !line.endsWith('(')) newline(f.base);
        put(kw(lower));
        f.clause = lower;
        f.between = false;
        continue;
      }
      if (f.query && JOIN_START.has(lower)) {
        const prevWord = [...toks.slice(0, k)].reverse().find((x) => x.t !== 'comment');
        const afterJoinWord = prevWord?.t === 'word' && /^(inner|left|right|full|cross|natural|outer)$/i.test(prevWord.v);
        // left( and right( are functions; JOIN right after INNER / LEFT … stays on its line
        const starts = lower === 'join' ? !afterJoinWord : !!nextWord && /^(join|outer|inner)$/i.test(nextWord.v);
        if (starts && !afterJoinWord) {
          newline(f.base + 2);
          put(kw(lower));
          f.clause = 'from';
          continue;
        }
      }
      if (f.query && (lower === 'and' || lower === 'or') && ['where', 'having', 'from'].includes(f.clause)) {
        if (lower === 'and' && f.between) {
          f.between = false;
          put(kw(lower));
          continue;
        }
        newline(f.base + (f.clause === 'from' ? 4 : 2) + (lower === 'and' ? 1 : 2));
        put(kw(lower));
        continue;
      }
      if (lower === 'between') f.between = true;
      put(kw(lower));
      continue;
    }
    if (t.t === 'punct') {
      if (t.v === '(') {
        const next = toks.slice(k + 1).find((x) => x.t !== 'comment');
        const sub = !!next && next.t === 'word' && /^(select|with|values)$/i.test(next.v);
        const prevTok = toks[k - 1];
        const before = toks[k - 2];
        const named = before?.t === 'word' && /^(into|table|view|index|on|using|references|function|procedure|type)$/i.test(before.v);
        const fn = !!prevTok && (prevTok.t === 'word' || prevTok.t === 'quoted') && !named
          && (!KEYWORDS.has(prevTok.v.toLowerCase()) || /^(left|right|replace|cast|any|some)$/i.test(prevTok.v));
        put('(', !fn);
        frames.push({ query: sub, base: sub ? line.length : f.base, clause: '', between: false });
        continue;
      }
      if (t.v === ')') {
        if (frames.length > 1) frames.pop();
        put(')', false);
        continue;
      }
      if (t.v === ',') {
        put(',', false);
        if (f.query && f.clause === 'select') newline(f.base + 7);
        else if (f.query && (f.clause === 'group by' || f.clause === 'order by')) newline(f.base + 9);
        continue;
      }
      if (t.v === ';') {
        put(';', false);
        flush();
        out += '\n';
        frames.splice(1);
        frames[0].clause = '';
        continue;
      }
      if (t.v === '.' || t.v === '::') {
        line += t.v;
        continue;
      }
      const prevTok = toks[k - 1];
      const unary = (t.v === '-' || t.v === '+') && (!prevTok || prevTok.t === 'punct' && prevTok.v !== ')' || (prevTok.t === 'word' && KEYWORDS.has(prevTok.v.toLowerCase())));
      put(t.v);
      if (unary) glue = true;
      continue;
    }
    // a word after "." or "::" sticks to it
    if (line.endsWith('.') || line.endsWith('::')) line += t.v;
    else put(t.v);
  }
  if (line.trim()) flush();
  return out.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + (sql.trimEnd().endsWith(';') ? '\n' : '');
}
