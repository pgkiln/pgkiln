import { REPORT_CHART_KINDS } from './charts.ts';
import { ComputeError, computeNameOk, computeSql } from './compute.ts';
import { AGGREGATES, HIGHLIGHT_COLORS, MAX_COMPUTATIONS, OPERATORS } from './report.ts';

// (sprint 112) What "Ask in your own words" may do to an interactive report
// (APEX 26.1/26.2: AI interactive reports). An answer, from the AI service's
// structured output or from the built-in phrase parser (ir-phrases.ts), is a
// RawPlan: filters, highlights, a search, a sort, a control break,
// aggregates, group by, a pivot, a chart and computed columns. checkPlan()
// keeps only what the report allows (its shown columns, whitelisted
// operators, functions, chart types and colors, short values, computed
// expressions that parse with the same validator as Actions → Compute) and
// applyPlan() turns it into the report's ordinary URL parameters, the same
// ones the Actions menu sets. The report's own code builds the SQL from them.
//
// The settings in force are shown as chips (chipsOf): each one is a URL
// parameter value of the report, so a chip can be edited or removed
// (editChip, removeChip) and nothing else is stored.

export type Kind = 'number' | 'date' | 'text' | 'boolean';

/** A column the user may use: shown (not in "hidden"), by name, heading and kind; pos = ORDER BY position. */
export interface Column {
  name: string;
  label: string;
  kind: Kind;
  /** position in the report's query (ORDER BY n); 0 when not known */
  pos: number;
  /** a computed column (r<id>_c): other computed columns can't use it */
  computed?: boolean;
}

/** An answer as it comes from the AI service or the parser, before it is checked. */
export interface RawPlan {
  reset?: boolean;
  filters?: { column: string; operator: string; value: string }[];
  highlights?: { column: string; operator: string; value: string; color: string }[];
  search?: string;
  sort_column?: string;
  sort_descending?: boolean;
  control_break?: string;
  aggregates?: { function: string; column: string }[];
  group_by?: string[];
  group_functions?: { function: string; column: string }[];
  pivot?: { row: string; column: string; function: string; value: string } | null;
  chart?: { type: string; label: string; function: string; value: string } | null;
  computed_columns?: { name: string; expression: string }[];
}

export interface Agg {
  fn: string;
  column: string;
}

/** A checked answer: only the report's columns, whitelisted operators and functions, valid expressions. */
export interface Plan {
  reset: boolean;
  filters: { column: string; operator: string; value: string }[];
  highlights: { column: string; operator: string; value: string; color: string }[];
  search: string;
  sort: Column | null;
  desc: boolean;
  breakCol: string | null;
  aggregates: Agg[];
  groupBy: string[];
  groupFunctions: Agg[];
  pivot: { row: string; column: string; fn: string; value: string } | null;
  chart: { kind: string; label: string; fn: string; value: string } | null;
  computed: { name: string; expr: string }[];
}

export const MAX_FILTERS = 5;
const MAX_HIGHLIGHTS = 5;
const MAX_AGGREGATES = 5;
const MAX_GROUP_COLUMNS = 3;
const MAX_GROUP_FUNCTIONS = 6;
export const MAX_VALUE = 200;

const text = (v: unknown, max = MAX_VALUE) => (typeof v === 'string' ? v.replace(/[\r\n\0]+/g, ' ').trim().slice(0, max) : '');

/** Does the function suit the column (sum and avg need numbers)? */
const fnFits = (fn: string, col: Column | undefined) => !!col && Object.hasOwn(AGGREGATES, fn) && (!AGGREGATES[fn].numeric || col.kind === 'number');

/** A computed expression's kind, roughly: text when it joins or quotes text, else a number. */
const exprKind = (expr: string): Kind => (/\|\||'|\b(upper|lower|initcap|trim|substr|left|right|replace|concat)\s*\(/i.test(expr) ? 'text' : 'number');

/**
 * The answer checked against the report's shown columns. fieldCount is the
 * number of columns of the report's query (hidden ones included), so a new
 * computed column's sort position is known.
 */
export function checkPlan(json: unknown, columns: Column[], fieldCount = columns.reduce((n, c) => Math.max(n, c.pos), 0)): Plan {
  const a = (json && typeof json === 'object' ? json : {}) as RawPlan;
  const byName = new Map(columns.map((c) => [c.name, c]));
  const list = <T>(v: unknown): T[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);

  // computed columns first: the rest of the answer may use them
  const source = columns.filter((c) => !c.computed).map((c) => c.name);
  const computed: Plan['computed'] = [];
  let next = fieldCount;
  for (const c of list<{ name: unknown; expression: unknown }>(a.computed_columns).slice(0, MAX_COMPUTATIONS)) {
    const name = text(c.name, 40);
    const expr = text(c.expression, 500);
    if (!name || !expr || !computeNameOk(name)) continue;
    const taken = columns.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (taken && !taken.computed) continue;
    try {
      computeSql(expr, source);
    } catch (e) {
      if (e instanceof ComputeError) continue;
      throw e;
    }
    computed.push({ name, expr });
    // a replaced computed column moves to the end: its position isn't known, so it can't be sorted on here
    byName.set(name, { name, label: name, kind: exprKind(expr), pos: taken ? 0 : ++next, computed: true });
  }
  const col = (v: unknown) => (typeof v === 'string' ? byName.get(v) : undefined);

  const filters = list<{ column: unknown; operator: unknown; value: unknown }>(a.filters)
    .filter((f) => col(f.column) && typeof f.operator === 'string' && Object.hasOwn(OPERATORS, f.operator) && typeof f.value === 'string')
    .slice(0, MAX_FILTERS)
    .map((f) => ({ column: f.column as string, operator: f.operator as string, value: OPERATORS[f.operator as string].noValue ? '' : text(f.value) }))
    .filter((f) => OPERATORS[f.operator].noValue || f.value !== '');
  const highlights = list<{ column: unknown; operator: unknown; value: unknown; color: unknown }>(a.highlights)
    .filter((h) => col(h.column) && typeof h.operator === 'string' && Object.hasOwn(OPERATORS, h.operator) && typeof h.value === 'string')
    .slice(0, MAX_HIGHLIGHTS)
    .map((h) => ({
      column: h.column as string, operator: h.operator as string, value: OPERATORS[h.operator as string].noValue ? '' : text(h.value),
      color: typeof h.color === 'string' && HIGHLIGHT_COLORS.includes(h.color) ? h.color : 'yellow',
    }))
    .filter((h) => OPERATORS[h.operator].noValue || h.value !== '');
  const sortCol = col(a.sort_column);
  const aggs = (v: unknown, max: number) =>
    list<{ function: unknown; column: unknown }>(v)
      .filter((x) => typeof x.function === 'string' && fnFits(x.function, col(x.column)))
      .map((x) => ({ fn: x.function as string, column: x.column as string }))
      .filter((x, i, all) => all.findIndex((y) => y.fn === x.fn && y.column === x.column) === i)
      .slice(0, max);
  const groupBy = [...new Set((Array.isArray(a.group_by) ? a.group_by : []).filter((g) => col(g)) as string[])].slice(0, MAX_GROUP_COLUMNS);
  const pv = a.pivot && typeof a.pivot === 'object' ? a.pivot : null;
  const ch = a.chart && typeof a.chart === 'object' ? a.chart : null;
  return {
    reset: a.reset === true,
    filters,
    highlights,
    search: text(a.search),
    sort: sortCol && sortCol.pos > 0 ? sortCol : null,
    desc: a.sort_descending === true,
    breakCol: col(a.control_break)?.name ?? null,
    aggregates: aggs(a.aggregates, MAX_AGGREGATES),
    groupBy,
    groupFunctions: groupBy.length ? aggs(a.group_functions, MAX_GROUP_FUNCTIONS) : [],
    pivot: pv && col(pv.row) && col(pv.column) && pv.row !== pv.column && typeof pv.function === 'string' && fnFits(pv.function, col(pv.value))
      ? { row: pv.row, column: pv.column, fn: pv.function, value: pv.value }
      : null,
    chart: ch && typeof ch.type === 'string' && (REPORT_CHART_KINDS as string[]).includes(ch.type) && col(ch.label) && typeof ch.function === 'string' && fnFits(ch.function, col(ch.value))
      ? { kind: ch.type, label: ch.label, fn: ch.function, value: ch.value }
      : null,
    computed,
  };
}

export const planIsEmpty = (p: Plan) =>
  !p.reset && !p.filters.length && !p.highlights.length && !p.search && !p.sort && !p.breakCol && !p.aggregates.length && !p.groupBy.length && !p.pivot && !p.chart && !p.computed.length;

/** The report's own settings (URL parameter suffixes) that a plan, a reset or the chips change. */
export const SETTING_KEYS = ['f', 'q', 'qc', 's', 'd', 'b', 'a', 'h', 'c', 'g', 'ga', 'pv', 'ch', 'v', 'x', 'bb', 'near'];

/**
 * Apply a checked plan to the page's URL parameters: a filter on a column
 * replaces that column's filters; sort, control break, group by, pivot and
 * chart replace theirs; highlights, aggregates and computed columns add up
 * (a computed column of the same name is replaced). The page and keyset go.
 */
export function applyPlan(params: URLSearchParams, rid: number, plan: Plan) {
  const k = (x: string) => `r${rid}_${x}`;
  const replaceAll = (name: string, keep: (v: string) => boolean, add: string[]) => {
    const rest = params.getAll(k(name)).filter(keep);
    params.delete(k(name));
    for (const v of [...rest, ...add]) params.append(k(name), v);
  };
  if (plan.reset) for (const x of SETTING_KEYS) params.delete(k(x));
  if (plan.computed.length) {
    const names = new Set(plan.computed.map((c) => c.name.toLowerCase()));
    const all = [...params.getAll(k('c')).filter((v) => !names.has(v.split('|')[0].toLowerCase())), ...plan.computed.map((c) => `${c.name}|${c.expr}`)];
    params.delete(k('c'));
    for (const v of all.slice(-MAX_COMPUTATIONS)) params.append(k('c'), v);
  }
  if (plan.filters.length) {
    const cols = new Set(plan.filters.map((f) => f.column));
    replaceAll('f', (v) => !cols.has(v.split('|')[0]), plan.filters.map((f) => `${f.column}|${f.operator}|${f.value}`));
  }
  if (plan.highlights.length) {
    const add = plan.highlights.map((h) => `${h.column}|${h.operator}|${h.color}|${h.value}`);
    replaceAll('h', (v) => !add.includes(v), add);
  }
  if (plan.search) {
    params.set(k('q'), plan.search);
    params.delete(k('qc'));
  }
  if (plan.sort) {
    params.set(k('s'), String(plan.sort.pos));
    if (plan.desc) params.set(k('d'), 'desc');
    else params.delete(k('d'));
  }
  if (plan.breakCol) params.set(k('b'), plan.breakCol);
  if (plan.aggregates.length) {
    const add = plan.aggregates.map((x) => `${x.fn}|${x.column}`);
    replaceAll('a', (v) => !add.includes(v), add);
  }
  if (plan.groupBy.length) {
    params.delete(k('g'));
    params.delete(k('ga'));
    for (const g of plan.groupBy) params.append(k('g'), g);
    for (const x of plan.groupFunctions) params.append(k('ga'), `${x.fn}|${x.column}`);
    params.set(k('v'), 'group');
  }
  if (plan.pivot) {
    params.set(k('pv'), `${plan.pivot.row}|${plan.pivot.column}|${plan.pivot.fn}|${plan.pivot.value}`);
    params.set(k('v'), 'pivot');
  }
  if (plan.chart) {
    params.set(k('ch'), `${plan.chart.kind}|${plan.chart.label}|${plan.chart.fn}|${plan.chart.value}`);
    params.set(k('v'), 'chart');
  }
  params.delete(k('p'));
  params.delete(k('k'));
}

// ------------------------------------------------------------------ chips

export type Chip =
  | { kind: 'search'; key: string; value: string; column: string | null }
  | { kind: 'filter'; key: string; raw: string; column: string; op: string; value: string }
  | { kind: 'highlight'; key: string; raw: string; column: string; op: string; color: string; value: string }
  | { kind: 'sort'; key: string; pos: number; desc: boolean }
  | { kind: 'break'; key: string; column: string }
  | { kind: 'aggregate'; key: string; raw: string; fn: string; column: string }
  | { kind: 'compute'; key: string; raw: string; name: string; expr: string }
  | { kind: 'group'; key: string; column: string }
  | { kind: 'groupfn'; key: string; raw: string; fn: string; column: string }
  | { kind: 'pivot'; key: string; row: string; column: string; fn: string; value: string }
  | { kind: 'chart'; key: string; type: string; label: string; fn: string; value: string }
  | { kind: 'hide'; key: string; column: string }
  | { kind: 'area'; key: string }
  | { kind: 'near'; key: string };

const MAX_CHIPS = 60;

/** The report's settings in the URL as chips (what reportState() reads, in the same limits). */
export function chipsOf(params: URLSearchParams, rid: number): Chip[] {
  const k = (x: string) => `r${rid}_${x}`;
  const out: Chip[] = [];
  const q = (params.get(k('q')) ?? '').trim();
  if (q) out.push({ kind: 'search', key: `q:${q}`, value: q, column: (params.get(k('qc')) ?? '').trim() || null });
  for (const raw of params.getAll(k('f'))) {
    const [column, op, ...rest] = raw.split('|');
    if (column && Object.hasOwn(OPERATORS, op)) out.push({ kind: 'filter', key: `f:${raw}`, raw, column, op, value: rest.join('|') });
  }
  const s = parseInt(params.get(k('s')) ?? '', 10);
  if (s > 0 && s <= 1000) out.push({ kind: 'sort', key: `s:${s}:${params.get(k('d')) === 'desc' ? 'd' : 'a'}`, pos: s, desc: params.get(k('d')) === 'desc' });
  const b = params.get(k('b'));
  if (b) out.push({ kind: 'break', key: `b:${b}`, column: b });
  for (const raw of params.getAll(k('a')).slice(0, 20)) {
    const [fn, column] = raw.split('|');
    if (Object.hasOwn(AGGREGATES, fn) && column) out.push({ kind: 'aggregate', key: `a:${raw}`, raw, fn, column });
  }
  for (const raw of params.getAll(k('h')).slice(0, 10)) {
    const [column, op, color, ...rest] = raw.split('|');
    if (column && Object.hasOwn(OPERATORS, op) && HIGHLIGHT_COLORS.includes(color)) out.push({ kind: 'highlight', key: `h:${raw}`, raw, column, op, color, value: rest.join('|') });
  }
  for (const raw of params.getAll(k('c')).slice(0, MAX_COMPUTATIONS)) {
    const [name, ...rest] = raw.split('|');
    if (name && computeNameOk(name) && rest.length) out.push({ kind: 'compute', key: `c:${raw}`, raw, name, expr: rest.join('|') });
  }
  const groups = params.getAll(k('g')).filter(Boolean).slice(0, MAX_GROUP_COLUMNS);
  for (const g of groups) out.push({ kind: 'group', key: `g:${g}`, column: g });
  if (groups.length)
    for (const raw of params.getAll(k('ga')).slice(0, MAX_GROUP_FUNCTIONS)) {
      const [fn, column] = raw.split('|');
      if (Object.hasOwn(AGGREGATES, fn) && column) out.push({ kind: 'groupfn', key: `ga:${raw}`, raw, fn, column });
    }
  const [row, column, fn, value] = (params.get(k('pv')) ?? '').split('|');
  if (row && column && Object.hasOwn(AGGREGATES, fn) && value) out.push({ kind: 'pivot', key: `pv:${params.get(k('pv'))}`, row, column, fn, value });
  const [type, label, cfn, cvalue] = (params.get(k('ch')) ?? '').split('|');
  if ((REPORT_CHART_KINDS as string[]).includes(type) && label && Object.hasOwn(AGGREGATES, cfn) && cvalue) out.push({ kind: 'chart', key: `ch:${params.get(k('ch'))}`, type, label, fn: cfn, value: cvalue });
  for (const x of params.getAll(k('x')).filter(Boolean).slice(0, 100)) out.push({ kind: 'hide', key: `x:${x}`, column: x });
  if (params.get(k('bb'))) out.push({ kind: 'area', key: 'bb' });
  if (params.get(k('near'))) out.push({ kind: 'near', key: 'near' });
  return out.slice(0, MAX_CHIPS);
}

/** Take one value out of a repeated parameter. */
function dropValue(params: URLSearchParams, name: string, raw: string) {
  const rest = params.getAll(name);
  const i = rest.indexOf(raw);
  if (i >= 0) rest.splice(i, 1);
  params.delete(name);
  for (const v of rest) params.append(name, v);
}

/** Replace one value of a repeated parameter in place (keeping the order). */
function swapValue(params: URLSearchParams, name: string, raw: string, next: string) {
  const all = params.getAll(name);
  const i = all.indexOf(raw);
  if (i < 0) return;
  all[i] = next;
  params.delete(name);
  for (const v of [...new Set(all)]) params.append(name, v);
}

const leaveView = (params: URLSearchParams, rid: number, view: string) => {
  if (params.get(`r${rid}_v`) === view) params.delete(`r${rid}_v`);
};

export function removeChip(params: URLSearchParams, rid: number, chip: Chip) {
  const k = (x: string) => `r${rid}_${x}`;
  switch (chip.kind) {
    case 'search': params.delete(k('q')); params.delete(k('qc')); break;
    case 'filter': dropValue(params, k('f'), chip.raw); break;
    case 'highlight': dropValue(params, k('h'), chip.raw); break;
    case 'aggregate': dropValue(params, k('a'), chip.raw); break;
    case 'compute': dropValue(params, k('c'), chip.raw); break;
    case 'groupfn': dropValue(params, k('ga'), chip.raw); break;
    case 'sort': params.delete(k('s')); params.delete(k('d')); break;
    case 'break': params.delete(k('b')); break;
    case 'group':
      dropValue(params, k('g'), chip.column);
      // the last group column takes its functions and the view with it
      if (!params.getAll(k('g')).filter(Boolean).length) (params.delete(k('ga')), leaveView(params, rid, 'group'));
      break;
    case 'pivot': params.delete(k('pv')); leaveView(params, rid, 'pivot'); break;
    case 'chart': params.delete(k('ch')); leaveView(params, rid, 'chart'); break;
    case 'hide': dropValue(params, k('x'), chip.column); break;
    case 'area': params.delete(k('bb')); break;
    case 'near': params.delete(k('near')); break;
  }
  params.delete(k('p'));
  params.delete(k('k'));
}

/** A chip edit that isn't allowed: a tampered form (403), or a mistake the user can fix (a message). */
export class ChipRefused extends Error {
  constructor(message: string, readonly tampered: boolean) {
    super(message);
  }
}

/**
 * Change one chip with the edit form's fields (e<i>_a … e<i>_e as a, b, c, d,
 * e). Every column must be one the user may use, every operator, function,
 * color and chart type one of the report's own, and an expression must parse.
 */
export function editChip(params: URLSearchParams, rid: number, chip: Chip, f: Record<'a' | 'b' | 'c' | 'd' | 'e', string>, columns: Column[], needsNumber: (fn: string) => string) {
  const k = (x: string) => `r${rid}_${x}`;
  const byName = new Map(columns.map((c) => [c.name, c]));
  const tampered = (what: string) => new ChipRefused(what, true);
  const column = (v: string, sourceOnly = false) => {
    const c = byName.get(v);
    if (!c || (sourceOnly && c.computed)) throw tampered(`column ${v.slice(0, 63)}`);
    return c;
  };
  const operator = (v: string) => {
    if (!Object.hasOwn(OPERATORS, v)) throw tampered(`operator ${v.slice(0, 20)}`);
    return v;
  };
  const fn = (v: string, c: Column) => {
    if (!Object.hasOwn(AGGREGATES, v)) throw tampered(`function ${v.slice(0, 20)}`);
    if (!fnFits(v, c)) throw new ChipRefused(needsNumber(v), false);
    return v;
  };
  const value = (op: string, v: string) => (OPERATORS[op].noValue ? '' : text(v));
  switch (chip.kind) {
    case 'search': {
      const v = text(f.a);
      if (v) params.set(k('q'), v);
      else params.delete(k('q'));
      break;
    }
    case 'filter': {
      const op = operator(f.b);
      swapValue(params, k('f'), chip.raw, `${column(f.a).name}|${op}|${value(op, f.c)}`);
      break;
    }
    case 'highlight': {
      const op = operator(f.b);
      if (!HIGHLIGHT_COLORS.includes(f.d)) throw tampered(`color ${f.d.slice(0, 20)}`);
      swapValue(params, k('h'), chip.raw, `${column(f.a).name}|${op}|${f.d}|${value(op, f.c)}`);
      break;
    }
    case 'sort': {
      const c = column(f.a);
      if (!c.pos) throw new ChipRefused(c.name, false);
      params.set(k('s'), String(c.pos));
      if (f.b === 'desc') params.set(k('d'), 'desc');
      else if (f.b === 'asc' || f.b === '') params.delete(k('d'));
      else throw tampered(`direction ${f.b.slice(0, 20)}`);
      break;
    }
    case 'break': params.set(k('b'), column(f.a).name); break;
    case 'aggregate': {
      const c = column(f.b);
      swapValue(params, k('a'), chip.raw, `${fn(f.a, c)}|${c.name}`);
      break;
    }
    case 'groupfn': {
      const c = column(f.b);
      swapValue(params, k('ga'), chip.raw, `${fn(f.a, c)}|${c.name}`);
      break;
    }
    case 'group': swapValue(params, k('g'), chip.column, column(f.a).name); break;
    case 'pivot': {
      const row = column(f.a).name;
      const col = column(f.b).name;
      if (row === col) throw new ChipRefused(row, false);
      const v = column(f.d);
      params.set(k('pv'), `${row}|${col}|${fn(f.c, v)}|${v.name}`);
      break;
    }
    case 'chart': {
      if (!(REPORT_CHART_KINDS as string[]).includes(f.a)) throw tampered(`chart type ${f.a.slice(0, 20)}`);
      const label = column(f.b).name;
      const v = column(f.d);
      params.set(k('ch'), `${f.a}|${label}|${fn(f.c, v)}|${v.name}`);
      break;
    }
    case 'compute': {
      const name = text(f.a, 40);
      const expr = text(f.b, 500);
      if (!name || !computeNameOk(name)) throw new ChipRefused(name || '?', false);
      const clash = columns.find((c) => !c.computed && c.name.toLowerCase() === name.toLowerCase());
      if (clash) throw new ChipRefused(`There is already a column ${name}.`, false);
      try {
        computeSql(expr, columns.filter((c) => !c.computed).map((c) => c.name));
      } catch (e) {
        if (e instanceof ComputeError) throw new ChipRefused(`${name}: ${e.message}`, false);
        throw e;
      }
      const others = params.getAll(k('c')).filter((v) => v !== chip.raw && v.split('|')[0].toLowerCase() === name.toLowerCase());
      for (const o of others) dropValue(params, k('c'), o);
      swapValue(params, k('c'), chip.raw, `${name}|${expr}`);
      break;
    }
    default:
      throw tampered(`chip ${chip.kind} can't be edited`);
  }
  params.delete(k('p'));
  params.delete(k('k'));
}
