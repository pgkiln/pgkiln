// (sprint 154, CD-2) A component's server-side condition in words, in the builder's language: the Page
// Designer's tree shows it on the condition badge ("When the request is SAVE, CREATE").
import { CONDITION_TYPES, type Condition } from '../metadata.ts';
import type { BuilderKey, BuilderTranslate } from './i18n.ts';

const TYPES = new Set<string>(CONDITION_TYPES);

/**
 * A row's server-side condition: a dynamic action's server_condition_*, a condition_type / condition_expr /
 * condition_value (processes, items, validations…), or a region's or button's `condition` (SQL without a type).
 * Null when there is none. A dynamic action's client-side condition_type isn't one.
 */
export function serverCondition(row: any): Condition | null {
  if (!row) return null;
  if (row.server_condition_type) return { condition_type: row.server_condition_type, condition_expr: row.server_condition_expr ?? null, condition_value: row.server_condition_value ?? null };
  if (row.condition_type && TYPES.has(row.condition_type))
    return { condition_type: row.condition_type, condition_expr: row.condition_expr ?? row.condition ?? null, condition_value: row.condition_value ?? null };
  if (typeof row.condition === 'string' && row.condition.trim()) return { condition_type: 'sql', condition_expr: row.condition, condition_value: null };
  return null;
}

const listOf = (v: string | null, sep: string) => (v ?? '').split(sep).map((x) => x.trim()).filter(Boolean).join(', ');

/** The condition in words, e.g. "When P3_JOB is one of CLERK, ANALYST". */
export function conditionWords(tx: BuilderTranslate, c: Condition): string {
  const type = c.condition_type ?? 'always';
  const item = (c.condition_expr ?? '').trim();
  const value = type === 'item_in_list' || type === 'item_not_in_list' ? listOf(c.condition_value, ':')
    : /^(request|page|language)_/.test(type) && !/dialog/.test(type) ? listOf(c.condition_value, ',')
    : (c.condition_value ?? '').trim();
  return tx(`cond.${type}` as BuilderKey, { item, value });
}

const NAME = '([A-Z][A-Z0-9_]*)';
const LIT = "'((?:[^']|'')*)'";
const unq = (s: string) => s.replace(/''/g, "'");
const lits = (s: string) => [...s.matchAll(/'((?:[^']|'')*)'/g)].map((m) => unq(m[1]));

/**
 * (154) The declarative type a SQL condition can be, or null: `:P3_X is not null` → item_not_null,
 * `:REQUEST in ('SAVE', 'CREATE')` → request_in, `:P3_JOB = 'CLERK'` → item_equals… Only whole conditions of one
 * bind and literals; anything else stays SQL. (The Advisor suggests it.) Negations (<>, not in) aren't offered: in SQL
 * an empty item makes them null (false), while the declarative types count an empty item as different.
 */
export function declarativeCondition(sql: string | null | undefined): Condition | null {
  const s = (sql ?? '').trim().replace(/;+$/, '').trim().replace(/\s+/g, ' ');
  let m: RegExpExecArray | null;
  const c = (condition_type: Condition['condition_type'], condition_expr: string | null, condition_value: string | null): Condition => ({ condition_type, condition_expr, condition_value });
  if ((m = new RegExp(`^:${NAME} is (not )?null$`, 'i').exec(s))) {
    if (m[1].toUpperCase() !== m[1]) return null;
    return c(m[2] ? 'item_not_null' : 'item_null', m[1], null);
  }
  if ((m = new RegExp(`^:${NAME} = ${LIT}$`).exec(s))) {
    if (m[1] === 'REQUEST') return /^[A-Z][A-Z0-9_]*$/.test(m[2]) ? c('request_in', null, m[2]) : null;
    return m[2] === '' ? null : c('item_equals', m[1], unq(m[2]));
  }
  if ((m = new RegExp(`^:${NAME} in \\((${LIT}(?: ?, ?${LIT})*)\\)$`, 'i').exec(s))) {
    if (m[1].toUpperCase() !== m[1]) return null;
    const values = lits(m[2]);
    if (m[1] === 'REQUEST') return values.every((v) => /^[A-Z][A-Z0-9_]*$/.test(v)) ? c('request_in', null, values.join(',')) : null;
    return values.some((v) => v.includes(':') || v === '') ? null : c('item_in_list', m[1], values.join(':'));
  }
  return null;
}
