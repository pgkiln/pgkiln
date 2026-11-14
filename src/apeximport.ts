// (sprint 182, CD-1/CD-4 leftover) The APEX importer: an Oracle APEX application export in the SQL
// format (src/apexparse.ts reads it as text, nothing in it runs) becomes a pgkiln/2 document, the
// same document meta.export_app() writes, so the existing import path (meta.import_app(), the
// CLI's importDoc, the builder's Import page) stays the only one that writes meta.* rows.
//
// Mapped: the application (name, alias, language, date format, home page, version), pages (number,
// name, title, normal or modal, public, help), regions (static content, classic and interactive
// reports, forms, interactive grids, breadcrumbs, help text; other types become a static region that
// says what it was), page items (the common item types, form columns and primary keys, lists of
// values, required, help, static defaults; other defaults and sources become computations), buttons
// (submit, redirect to a page with items, dynamic action), validations and processes by the mapping
// in docs/guide/11-from-apex.md, computations, branches, the simple dynamic actions, shared lists of
// values, authorization schemes and the navigation menu. Server-side conditions use pgkiln's
// catalogue of the same types. PL/SQL (bodies, PL/SQL expressions) is carried over as it is and
// flagged "needs porting"; Oracle SQL is kept too, with the Oracle-only constructs it uses named.
//
// Every component gets a line in the report: mapped, mapped with notes, or not mapped (with its
// APEX type), so a developer knows what to finish by hand. Unknown things never fail the import.

import { translateOracle } from './oracle-sql.ts';
import { ApexId, joinSplitExport, parseApexCalls, type ApexCall, type ApexValue } from './apexparse.ts';
import type { Doc } from './appfiles.ts';

// ------------------------------------------------------------------ report

export type ReportStatus = 'mapped' | 'notes' | 'not_mapped';
export type ReportKind =
  | 'application' | 'page' | 'region' | 'item' | 'button' | 'validation' | 'process' | 'computation' | 'branch'
  | 'dynamic_action' | 'lov' | 'authorization' | 'navigation';

export interface ReportEntry {
  kind: ReportKind;
  page: number | null;
  name: string;
  /** the APEX type (NATIVE_FORM_DML, ITEM_IS_NUMERIC …) */
  apexType: string;
  /** the pgkiln type it became */
  target: string | null;
  status: ReportStatus;
  /** PL/SQL or Oracle SQL to port */
  port: boolean;
  notes: string[];
}

export interface ApexReport {
  application: { id: string | null; name: string; alias: string; release: string | null; schema: string };
  entries: ReportEntry[];
  /** APEX calls that hold no component pgkiln imports (method → count), themes and templates left out */
  skipped: Record<string, number>;
  counts: { mapped: number; notes: number; not_mapped: number; port: number };
}

export class NotAnApexExport extends Error {}

const PORT = 'PL/SQL carried over as it is: port it to PL/pgSQL (chapter 11, Porting PL/SQL to PL/pgSQL)';

class Entry implements ReportEntry {
  status: ReportStatus = 'mapped';
  port = false;
  notes: string[] = [];
  constructor(public kind: ReportKind, public page: number | null, public name: string, public apexType: string, public target: string | null = null) {}
  note(text: string) {
    if (!this.notes.includes(text)) this.notes.push(text);
    if (this.status === 'mapped') this.status = 'notes';
    return this;
  }
  plsql() {
    this.port = true;
    return this.note(PORT);
  }
  /** (sprint 187) The SQL with the common Oracle rewritten (src/oracle-sql.ts), noting what was and what is left. */
  oracle<T extends string | null | undefined>(sql: T): T {
    if (!sql) return sql;
    const t = translateOracle(sql);
    if (t.done.length) this.note(`Oracle SQL rewritten: ${t.done.join(', ')}`);
    const found = oracleisms(t.sql);
    if (found.length) {
      this.port = true;
      this.note(`Oracle SQL to check: ${found.join(', ')}`);
    }
    return t.sql as T;
  }
  notMapped(text: string) {
    this.status = 'not_mapped';
    this.target = null;
    if (!this.notes.includes(text)) this.notes.push(text);
    return this;
  }
}

/** Oracle-only constructs in a SQL text (empty: none seen). */
export function oracleisms(sql: string | null | undefined): string[] {
  if (!sql) return [];
  const checks: [RegExp, string][] = [
    [/\bnvl2?\s*\(/i, 'nvl'],
    [/\bdecode\s*\(/i, 'decode'],
    [/\bsysdate\b/i, 'sysdate'],
    [/\bsystimestamp\b/i, 'systimestamp'],
    [/\bfrom\s+(sys\.)?dual\b/i, 'dual'],
    [/\brownum\b/i, 'rownum'],
    [/\(\+\)/, '(+) outer join'],
    [/\bconnect\s+by\b/i, 'connect by'],
    [/\bminus\b/i, 'minus'],
    [/\.\s*(nextval|currval)\b/i, 'sequence.nextval'],
    [/\b(apex_[a-z_]+|htp|htf|owa_util|dbms_[a-z_]+|utl_[a-z_]+)\s*\./i, 'APEX or Oracle packages'],
    [/(^|[^a-z_.])v\s*\(\s*'/i, "v('ITEM')"],
    [/\blistagg\s*\(/i, 'listagg'],
    [/\bto_number\s*\(\s*[^,()]+\)/i, 'to_number without a format'],
    [/\binstr\s*\(/i, 'instr'],
    [/\bsubstr\s*\([^)]*-\s*\d/i, 'substr with a negative position'],
  ];
  return checks.filter(([re, name]) => name && re.test(sql)).map(([, name]) => name);
}

// ------------------------------------------------------------------ small helpers

const MAX_TEXT = 200_000;

type Args = Record<string, ApexValue>;
function str(a: Args, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = a[k];
    if (v === undefined || v === null) continue;
    if (v instanceof ApexId) return v.id;
    const s = Array.isArray(v) ? v.map((x) => (x === null || x === undefined ? '' : String(x))).join('\n') : String(v);
    if (s !== '') return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s;
  }
  return null;
}
/** an id argument: wwv_flow_imp.id(123), or a number */
function ref(a: Args, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = a[k];
    if (v instanceof ApexId) return v.id;
    if (typeof v === 'number') return String(v);
    if (typeof v === 'string' && /^-?\d+$/.test(v)) return v;
  }
  return null;
}
const yes = (a: Args, k: string) => a[k] === true || /^(y|yes|true)$/i.test(String(a[k] ?? ''));
/**
 * (sprint 190) APEX 26.2 writes a component's settings as p_attributes=>wwv_flow_t_plugin_attributes(
 * wwv_flow_t_varchar2('key', 'value', …)).to_clob instead of p_attribute_01 … : key → value (as text).
 */
/**
 * (sprint 190) The 26.2 names of the attributes the importer reads by position (p_attribute_01 …), per component
 * type: position → the key names APEX 26.2 writes for it (the first one present wins).
 */
const ATTRIBUTE_KEYS: Record<string, Record<number, string[]>> = {
  NATIVE_SESSION_STATE: { 1: ['type'], 2: ['item_names', 'items'], 3: ['page_numbers', 'pages'] },
  NATIVE_INVOKE_API: { 1: ['type'], 3: ['package'], 4: ['package_method', 'procedure'] },
  NATIVE_FORM_DML: { 1: ['target_type'] },
  NATIVE_IG_DML: { 1: ['target_type'] },
  NATIVE_CLOSE_WINDOW: { 1: ['items_to_return', 'items'] },
  NATIVE_EXECUTION_CHAIN: { 1: ['run_in_background', 'background'] },
  NATIVE_SEND_EMAIL: { 1: ['from'], 2: ['to'], 3: ['cc'], 4: ['bcc'], 5: ['reply_to'], 6: ['subject'], 7: ['body_plain_text', 'body'], 8: ['body_html'] },
  NATIVE_TEXT_FIELD: { 1: ['subtype'] },
  NATIVE_HIDDEN: { 1: ['value_protected'] },
  NATIVE_SET_VALUE: { 1: ['set_type'], 2: ['static_value', 'value'], 3: ['javascript_expression'], 4: ['sql_statement'], 5: ['plsql_expression'], 6: ['plsql_function_body'], 7: ['items_to_submit'] },
  NATIVE_JAVASCRIPT_CODE: { 1: ['js_code'] },
  NATIVE_EXECUTE_PLSQL_CODE: { 1: ['plsql_code', 'code'], 2: ['items_to_submit'], 3: ['items_to_return'] },
  NATIVE_ALERT: { 1: ['text'] },
  NATIVE_CONFIRM: { 1: ['text'] },
  NATIVE_ADD_CLASS: { 1: ['css_classes', 'class'] },
  NATIVE_REMOVE_CLASS: { 1: ['css_classes', 'class'] },
};
/** An attribute by position: p_attribute_NN of older exports, else its 26.2 name in p_attributes */
export function attributeAt(a: Args, type: string, n: number): string | null {
  const old = str(a, `p_attribute_${String(n).padStart(2, '0')}`);
  if (old !== null) return old;
  const at = attributesOf(a);
  for (const k of ATTRIBUTE_KEYS[type.toUpperCase()]?.[n] ?? []) if (at[k] !== undefined && at[k] !== '') return at[k];
  return null;
}

export function attributesOf(a: Args): Record<string, string> {
  const v = a.p_attributes;
  const list = Array.isArray(v) ? (v.length === 1 && Array.isArray(v[0]) ? v[0] : v) : [];
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < list.length; i += 2) {
    const k = list[i];
    const x = list[i + 1];
    if (typeof k === 'string' && x !== null && x !== undefined) out[k.toLowerCase()] = Array.isArray(x) ? x.map((y) => String(y ?? '')).join('\n') : String(x);
  }
  return out;
}
function num(a: Args, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = a[k];
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN;
    if (Number.isFinite(n)) return n;
  }
  return null;
}
const int = (n: number | null, d: number) => (n === null ? d : Math.max(-1_000_000, Math.min(1_000_000_000, Math.round(n))));

/** An upper-case pgkiln name (item, button, LOV, authorization scheme): ^[A-Z][A-Z0-9_]*$ */
export function upperName(s: string | null | undefined, fallback = 'X') {
  let n = String(s ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  if (!n) n = fallback;
  if (!/^[A-Z]/.test(n)) n = `${fallback}_${n}`.slice(0, 60);
  return n;
}
const isUpperName = (s: string | null | undefined): s is string => !!s && /^[A-Z][A-Z0-9_]*$/.test(s);

/** A region static id: ^[a-z][a-z0-9_-]{0,49}$ */
function staticId(s: string | null | undefined) {
  const k = String(s ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .slice(0, 50)
    .replace(/-+$/, '');
  return k || null;
}

/** An Oracle identifier as PostgreSQL folds it: EMPNO → empno; a quoted mixed-case one stays. */
const ident = (s: string) => (/^[A-Z0-9_$#]+$/.test(s.trim()) ? s.trim().toLowerCase() : s.trim());

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** f?p=&APP_ID.:3:&SESSION.::&DEBUG.:RP,3:P3_ID,P3_X:&P2_ID.,\a,b\ → page 3, items */
export function parseFp(url: string | null | undefined): { page: string; request: string; clear: string; items: Record<string, string> } | null {
  if (!url) return null;
  const m = /^\s*f\?p=([\s\S]*)$/i.exec(url.trim());
  if (!m) return null;
  const query = m[1].replace(/&success_msg=#SUCCESS_MSG#/i, '').replace(/#SUCCESS_MSG#/i, '');
  const parts = query.split(':');
  const app = parts[0] ?? '';
  if (app && !/^&(APP_ID|FLOW_ID)\.$/i.test(app) && !/^\d+$/.test(app)) return null;
  const names = (parts[6] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  // values: comma separated; a value in backslashes may hold commas
  const values: string[] = [];
  const raw = parts.slice(7, parts.length > 8 ? -1 : undefined).join(':');
  let cur = '';
  let quoted = false;
  for (const ch of raw) {
    if (ch === '\\') quoted = !quoted;
    else if (ch === ',' && !quoted) {
      values.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (raw) values.push(cur);
  const items: Record<string, string> = {};
  names.forEach((n, i) => (items[n.toUpperCase()] = values[i] ?? ''));
  return { page: (parts[1] ?? '').trim(), request: (parts[3] ?? '').trim(), clear: (parts[5] ?? '').trim(), items };
}

// ------------------------------------------------------------------ conditions

/** pgkiln's meta.condition_ok in TypeScript, so the import never fails on a condition. */
export function conditionOk(type: string | null, expr: string | null, value: string | null) {
  const item = /^[A-Z][A-Z0-9_]*$/;
  if (!type) return true;
  if (['sql', 'exists', 'not_exists', 'function_body'].includes(type)) return (expr ?? '').trim() !== '';
  if (['item_null', 'item_not_null', 'item_zero', 'item_not_zero', 'item_null_or_zero', 'item_not_null_or_zero', 'item_equals', 'item_not_equals'].includes(type)) return item.test(expr ?? '');
  if (['item_in_list', 'item_not_in_list'].includes(type)) return item.test(expr ?? '') && !!value && value.length <= 4000;
  if (['request_in', 'request_not_in'].includes(type)) return /^ *[A-Z][A-Z0-9_]* *(, *[A-Z][A-Z0-9_]* *)*$/.test(value ?? '');
  if (['page_in', 'page_not_in'].includes(type)) return /^ *[0-9]{1,9} *(, *[0-9]{1,9} *)*$/.test(value ?? '');
  if (['language_in', 'language_not_in'].includes(type)) return /^ *[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})? *(, *[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})? *)*$/.test(value ?? '');
  return ['page_is_dialog', 'page_is_not_dialog', 'user_signed_in', 'user_public', 'always', 'never'].includes(type);
}

export interface Cond {
  condition_type: string | null;
  condition_expr: string | null;
  condition_value: string | null;
}
const NO_COND: Cond = { condition_type: null, condition_expr: null, condition_value: null };

/** APEX server-side condition codes and pgkiln's condition types: [type, where expression 1 goes, where expression 2 goes] */
const CONDITIONS: Record<string, [string, 'expr' | 'value' | null, 'expr' | 'value' | null]> = {
  EXISTS: ['exists', 'expr', null],
  NOT_EXISTS: ['not_exists', 'expr', null],
  SQL_EXPRESSION: ['sql', 'expr', null],
  EXPRESSION: ['sql', 'expr', null],
  PLSQL_EXPRESSION: ['sql', 'expr', null],
  FUNCTION_BODY: ['function_body', 'expr', null],
  PLSQL_FUNCTION_BODY: ['function_body', 'expr', null],
  REQUEST_EQUALS_CONDITION: ['request_in', 'value', null],
  REQUEST_IN_CONDITION: ['request_in', 'value', null],
  REQUEST_NOT_EQUAL_CONDITION: ['request_not_in', 'value', null],
  REQUEST_NOT_IN_CONDITION: ['request_not_in', 'value', null],
  ITEM_IS_NULL: ['item_null', 'expr', null],
  ITEM_IS_NOT_NULL: ['item_not_null', 'expr', null],
  ITEM_IS_ZERO: ['item_zero', 'expr', null],
  ITEM_IS_NOT_ZERO: ['item_not_zero', 'expr', null],
  ITEM_IS_NULL_OR_ZERO: ['item_null_or_zero', 'expr', null],
  ITEM_NOT_NULL_OR_ZERO: ['item_not_null_or_zero', 'expr', null],
  ITEM_IS_NOT_NULL_OR_ZERO: ['item_not_null_or_zero', 'expr', null],
  VAL_OF_ITEM_IN_COND_EQ_COND2: ['item_equals', 'expr', 'value'],
  VAL_OF_ITEM_IN_COND_NOT_EQ_COND2: ['item_not_equals', 'expr', 'value'],
  VALUE_OF_ITEM_IN_CONDITION_IN_COLON_DELIMITED_LIST: ['item_in_list', 'expr', 'value'],
  VALUE_OF_ITEM_IN_CONDITION_NOT_IN_COLON_DELIMITED_LIST: ['item_not_in_list', 'expr', 'value'],
  CURRENT_PAGE_IN_CONDITION: ['page_in', 'value', null],
  CURRENT_PAGE_EQUALS_CONDITION: ['page_in', 'value', null],
  CURRENT_PAGE_NOT_IN_CONDITION: ['page_not_in', 'value', null],
  CURRENT_PAGE_NOT_EQUAL_CONDITION: ['page_not_in', 'value', null],
  USER_IS_NOT_PUBLIC_USER: ['user_signed_in', null, null],
  USER_IS_PUBLIC_USER: ['user_public', null, null],
  CURRENT_LANG_IN_COND1: ['language_in', 'value', null],
  CURRENT_LANG_EQ_COND1: ['language_in', 'value', null],
  CURRENT_LANG_NOT_IN_COND1: ['language_not_in', 'value', null],
  CURRENT_LANG_NOT_EQ_COND1: ['language_not_in', 'value', null],
  NEVER: ['never', null, null],
  ALWAYS: ['always', null, null],
};

/** An APEX server-side condition as pgkiln's (null type: none, or one pgkiln has not: then a note). */
function condition(type: string | null, e1: string | null, e2: string | null, entry: Entry): Cond {
  if (!type) return NO_COND;
  const t = type.toUpperCase();
  const m = CONDITIONS[t];
  if (!m) {
    entry.note(`server-side condition ${t} is not carried over: the component now always shows or runs; set a condition by hand`);
    return NO_COND;
  }
  const out: Cond = { condition_type: m[0], condition_expr: null, condition_value: null };
  const put = (where: 'expr' | 'value' | null, v: string | null) => {
    if (where) out[where === 'expr' ? 'condition_expr' : 'condition_value'] = v;
  };
  put(m[1], e1);
  put(m[2], e2);
  if (m[0].startsWith('request_') && out.condition_value) out.condition_value = out.condition_value.toUpperCase().split(/[,:]/).map((x) => x.trim()).filter(Boolean).join(',');
  if (m[0].startsWith('page_') && out.condition_value) out.condition_value = out.condition_value.split(/[,:]/).map((x) => x.trim()).filter(Boolean).join(',');
  if (m[0].startsWith('language_') && out.condition_value) out.condition_value = out.condition_value.split(/[,:]/).map((x) => x.trim()).filter(Boolean).join(',');
  if (m[0].startsWith('item_') && out.condition_expr) out.condition_expr = out.condition_expr.trim().toUpperCase();
  if (t === 'PLSQL_EXPRESSION' || (t === 'EXPRESSION' && /plsql/i.test(e2 ?? '')) || m[0] === 'function_body') {
    if (t === 'EXPRESSION') out.condition_value = null;
    entry.port = true;
    entry.note(`condition (${t}): ${PORT}`);
  } else if (['sql', 'exists', 'not_exists'].includes(m[0])) {
    if (t === 'EXPRESSION') out.condition_value = null;
    out.condition_expr = entry.oracle(out.condition_expr);
  }
  if (!conditionOk(out.condition_type, out.condition_expr, out.condition_value)) {
    entry.note(`server-side condition ${t} (${[e1, e2].filter(Boolean).join(' / ')}) does not fit pgkiln's ${m[0]}: not carried over`);
    return NO_COND;
  }
  return out;
}

// ------------------------------------------------------------------ type maps

const ITEM_TYPES: Record<string, string> = {
  NATIVE_TEXT_FIELD: 'text',
  NATIVE_TEXTAREA: 'textarea',
  NATIVE_NUMBER_FIELD: 'number',
  NATIVE_DATE_PICKER: 'date',
  NATIVE_DATE_PICKER_APEX: 'date',
  NATIVE_DATE_PICKER_JET: 'date',
  NATIVE_DATE_PICKER_CLASSIC: 'date',
  NATIVE_SELECT_LIST: 'select',
  NATIVE_RADIOGROUP: 'radio',
  NATIVE_CHECKBOX: 'checkbox_group',
  NATIVE_SINGLE_CHECKBOX: 'checkbox',
  NATIVE_YES_NO: 'switch',
  NATIVE_HIDDEN: 'hidden',
  NATIVE_DISPLAY_ONLY: 'display',
  NATIVE_PASSWORD: 'password',
  NATIVE_POPUP_LOV: 'popup_lov',
  NATIVE_SHUTTLE: 'shuttle',
  NATIVE_FILE: 'file',
  NATIVE_RICH_TEXT_EDITOR: 'richtext',
  NATIVE_MARKDOWN_EDITOR: 'markdown',
  NATIVE_STAR_RATING: 'rating',
  NATIVE_COLOR_PICKER: 'color',
  NATIVE_COMBOBOX: 'combobox',
  NATIVE_SELECT_ONE: 'select_one',
  NATIVE_SELECT_MANY: 'select_many',
  NATIVE_AUTO_COMPLETE: 'autocomplete',
  NATIVE_QRCODE: 'qrcode',
  NATIVE_IMAGE_UPLOAD: 'image_upload',
  NATIVE_DISPLAY_IMAGE: 'image',
  NATIVE_PCT_GRAPH: 'percent_graph',
  NATIVE_GEOCODED_ADDRESS: 'address',
  NATIVE_DISPLAY_MAP: 'display_map',
};
const LOV_TYPES = new Set(['select', 'radio', 'checkbox_group', 'popup_lov', 'shuttle', 'select_one', 'select_many', 'combobox', 'display', 'autocomplete']);

const REGION_TYPES: Record<string, string> = {
  NATIVE_STATIC: 'static',
  NATIVE_HTML: 'static',
  NATIVE_SQL_REPORT: 'classic_report',
  NATIVE_IR: 'report',
  NATIVE_FORM: 'form',
  NATIVE_IG: 'grid',
  NATIVE_BREADCRUMB: 'breadcrumb',
  NATIVE_HELP_TEXT: 'help_text',
  // (sprint 190) region types read from a real APEX 26.2 export
  NATIVE_JET_CHART: 'chart',
  NATIVE_CARDS: 'cards',
  NATIVE_CSS_CALENDAR: 'calendar',
  NATIVE_FACETED_SEARCH: 'facets',
  NATIVE_LIST: 'list',
};
const REGION_NAMES: Record<string, string> = {
  NATIVE_JET_CHART: 'chart',
  NATIVE_CARDS: 'cards',
  NATIVE_CSS_CALENDAR: 'calendar',
  NATIVE_MAP_REGION: 'map',
  NATIVE_FACETED_SEARCH: 'faceted search',
  NATIVE_SMART_FILTERS: 'smart filters',
  NATIVE_JSTREE: 'tree',
  NATIVE_LIST: 'list',
  NATIVE_DISPLAY_SELECTOR: 'region display selector',
  NATIVE_PLSQL: 'PL/SQL dynamic content',
  NATIVE_DYNAMIC_CONTENT: 'dynamic content',
  NATIVE_URL: 'URL',
  NATIVE_SEARCH: 'search',
  NATIVE_WORKFLOW_DIAGRAM: 'workflow diagram',
};

const VALIDATION_TYPES: Record<string, { type: string; item: boolean; value?: boolean; plsql?: boolean; sql?: boolean }> = {
  EXISTS: { type: 'exists', item: false, sql: true },
  NOT_EXISTS: { type: 'not_exists', item: false, sql: true },
  SQL_EXPRESSION: { type: 'sql', item: false, sql: true },
  PLSQL_EXPRESSION: { type: 'sql', item: false, plsql: true },
  EXPRESSION: { type: 'sql', item: false, sql: true },
  FUNC_BODY_RETURNING_BOOLEAN: { type: 'function_body', item: false, plsql: true },
  FUNC_BODY_RETURNING_ERR_TEXT: { type: 'function_error', item: false, plsql: true },
  ITEM_NOT_NULL: { type: 'not_null', item: true },
  ITEM_IS_NOT_NULL: { type: 'not_null', item: true },
  ITEM_NOT_NULL_OR_ZERO: { type: 'not_null_or_zero', item: true },
  ITEM_NOT_ZERO: { type: 'not_zero', item: true },
  ITEM_CONTAINS_NO_SPACES: { type: 'no_spaces', item: true },
  ITEM_IS_ALPHANUMERIC: { type: 'alphanumeric', item: true },
  ITEM_IS_NUMERIC: { type: 'numeric', item: true },
  ITEM_IS_DATE: { type: 'valid_date', item: true },
  ITEM_IS_TIMESTAMP: { type: 'valid_timestamp', item: true },
  ITEM_IN_VALIDATION_EQ_STRING2: { type: 'equals', item: true, value: true },
  ITEM_IN_VALIDATION_NOT_EQ_STRING2: { type: 'not_equals', item: true, value: true },
  ITEM_IN_VALIDATION_IN_STRING2: { type: 'in_list', item: true, value: true },
  ITEM_IN_VALIDATION_NOT_IN_STRING2: { type: 'not_in_list', item: true, value: true },
  ITEM_IN_VALIDATION_CONTAINS_ONLY_CHAR_IN_STRING2: { type: 'chars_only', item: true, value: true },
  ITEM_IN_VALIDATION_CONTAINS_AT_LEAST_ONE_CHAR_IN_STRING2: { type: 'chars_any', item: true, value: true },
  ITEM_IN_VALIDATION_CONTAINS_NO_CHAR_IN_STRING2: { type: 'chars_none', item: true, value: true },
  REGULAR_EXPRESSION: { type: 'regex', item: true, value: true },
};

/** Validation and process types the importer maps (for the guide and the tests). */
export const MAPPED_VALIDATION_TYPES = Object.keys(VALIDATION_TYPES);
export const MAPPED_PROCESS_TYPES = [
  'NATIVE_PLSQL', 'NATIVE_FORM_INIT', 'NATIVE_FORM_DML', 'NATIVE_IG_DML', 'NATIVE_SESSION_STATE', 'NATIVE_CLOSE_WINDOW',
  'NATIVE_RESET_PAGINATION', 'NATIVE_SEND_EMAIL', 'NATIVE_INVOKE_API', 'NATIVE_EXECUTION_CHAIN',
];

const DISPLAY_LOCATIONS: Record<string, string> = {
  INLINE_WITH_FIELD_AND_NOTIFICATION: 'inline_and_notification',
  INLINE_WITH_FIELD: 'inline',
  INLINE_IN_NOTIFICATION: 'notification',
  ON_ERROR_PAGE: 'notification',
};

const BUTTON_SLOTS = new Set(['create', 'edit', 'change', 'copy', 'help', 'up', 'previous', 'close', 'delete', 'next']);

const DA_EVENTS: Record<string, string> = {
  change: 'change',
  click: 'click',
  ready: 'load',
  apexafterclosedialog: 'dialog_closed',
  focusin: 'focus',
  focus: 'focus',
  focusout: 'blur',
  blur: 'blur',
  keyup: 'key_release',
  keydown: 'key_down',
  keypress: 'key_press',
  dblclick: 'double_click',
  mouseenter: 'mouse_enter',
  mouseleave: 'mouse_leave',
  select: 'select',
  resize: 'resize',
  scroll: 'scroll',
  unload: 'page_unload',
  apexafterrefresh: 'after_refresh',
  apexbeforerefresh: 'before_refresh',
  apexbeforepagesubmit: 'before_submit',
  custom: 'custom',
};
const DA_CONDITIONS: Record<string, [string, string]> = {
  EQUALS: ['equals', 'not_equals'],
  NOT_EQUALS: ['not_equals', 'equals'],
  GREATER_THAN: ['greater', 'less_equal'],
  GREATER_THAN_OR_EQUAL: ['greater_equal', 'less'],
  LESS_THAN: ['less', 'greater_equal'],
  LESS_THAN_OR_EQUAL: ['less_equal', 'greater'],
  NULL: ['is_null', 'is_not_null'],
  NOT_NULL: ['is_not_null', 'is_null'],
  IN_LIST: ['in_list', 'not_in_list'],
  NOT_IN_LIST: ['not_in_list', 'in_list'],
};
const DA_ACTIONS: Record<string, string> = {
  NATIVE_SHOW: 'show',
  NATIVE_HIDE: 'hide',
  NATIVE_ENABLE: 'enable',
  NATIVE_DISABLE: 'disable',
  NATIVE_SET_VALUE: 'set_value',
  NATIVE_REFRESH: 'refresh_region',
  NATIVE_EXECUTE_PLSQL_CODE: 'execute_sql',
  NATIVE_SUBMIT_PAGE: 'submit',
  NATIVE_DIALOG_CLOSE: 'close_dialog',
  NATIVE_DIALOG_CANCEL: 'cancel_dialog',
  NATIVE_ALERT: 'alert',
  NATIVE_CONFIRM: 'confirm',
  NATIVE_SET_FOCUS: 'set_focus',
  NATIVE_ADD_CLASS: 'add_class',
  NATIVE_REMOVE_CLASS: 'remove_class',
  NATIVE_CLEAR: 'clear',
  NATIVE_CANCEL_EVENT: 'cancel_event',
  NATIVE_OPEN_REGION: 'open_region',
  NATIVE_CLOSE_REGION: 'close_region',
};

// calls that hold nothing an application needs here (themes, templates, the import's own bookkeeping)
const NOISE = /template|theme|^create_icon_bar|^create_user_interface$|^component_(begin|end)$|^import_(begin|end)$|^set_environment$|^remove_|^create_flow$|^create_static_lov_data$|^create_install|^g_|^create_ws_|^create_app_static_file$|^create_language_map$|^set_calling_version$|^create_page_group$|^create_load_table$|^create_password_|^set_/i;
// methods the importer reads (anything else that is a create_* is counted as "not read")
const READ = new Set([
  'create_flow', 'create_page', 'create_page_plug', 'create_report_region', 'create_card', 'create_jet_chart', 'create_jet_chart_series', 'create_page_item', 'create_page_button', 'create_page_validation',
  'create_page_process', 'create_page_computation', 'create_page_branch', 'create_page_da_event', 'create_page_da_action',
  'create_list_of_values', 'create_static_lov_data', 'create_security_scheme', 'create_list', 'create_list_item',
  'create_region_column', 'create_invokeapi_comp_param', 'create_user_interface', 'create_web_source_module',
  'create_worksheet', 'create_authentication', 'import_begin',
]);

// ------------------------------------------------------------------ the mapping

/** The application settings of a new application (the columns' defaults, as an export writes them). */
const APP_DEFAULTS = {
  authentication: 'app_users', access_control: 'assigned', theme: {}, debug: false, debug_level: 0, debug_retention_days: 7,
  local_login: true, sso_providers: [], ldap_directories: [], static_includes: [], app_type: 'standard', nav_list: null,
  navbar_list: null, mfa: 'off', mfa_email: false, mfa_roles: [], pwa: false, pwa_push: false, pwa_offline_pages: false,
  pwa_offline_submit: false, ai_tools: [], ai_agents: [], json_sources: [], vector_providers: [], component_settings: {},
  backups_keep: 25, feedback: false, notifications: false, password_reset: false, api_self_tokens: false,
  session_warning_seconds: 120, header_auto_create: false,
};

export interface ApexImportOptions {
  /** the new application's alias (default: from the export's alias or name) */
  alias?: string | null;
  /** the schema unqualified tables are in (default: the export's parsing schema, lower case; '' for none) */
  schema?: string | null;
  /** the application's database role (default: none; set it in Settings after the import) */
  dbRole?: string | null;
}

interface Comp {
  call: ApexCall;
  page: number;
}

/** The alias for an APEX export: its alias or name, lower case. */
export function apexAlias(alias: string | null, name: string | null, appId: string | null) {
  const base = String(alias || name || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/, '')
    .slice(0, 50);
  return base || `apex-${appId && /^\d+$/.test(appId) ? appId : 'app'}`;
}

/** An APEX SQL export (the text of f100.sql, or the joined files of a split export) as a pgkiln/2 document and the import report. */
export function apexToDoc(source: string, opts: ApexImportOptions = {}): { doc: Doc; report: ApexReport } {
  const calls = parseApexCalls(source);
  const by = (m: string) => calls.filter((c) => c.method === m);
  const flow = by('create_flow')[0];
  const begin = by('import_begin')[0];
  if (!flow && !by('create_page').length) throw new NotAnApexExport('no APEX application in the file (no wwv_flow_imp.create_flow or create_page call): is it an APEX application export in the SQL format?');

  const fa = flow?.args ?? {};
  const appId = str(begin?.args ?? {}, 'p_default_application_id') ?? null;
  const appName = str(fa, 'p_name') ?? (appId ? `Application ${appId}` : 'APEX application');
  const alias = opts.alias?.trim() || apexAlias(str(fa, 'p_alias'), appName, appId);
  const owner = str(fa, 'p_owner') ?? str(begin?.args ?? {}, 'p_default_owner');
  const schema = opts.schema !== undefined && opts.schema !== null ? opts.schema.trim().toLowerCase() : owner ? ident(owner) : '';
  const qualified = (table: string | null, tableOwner?: string | null) => {
    if (!table) return null;
    if (table.includes('.')) return table.split('.').map(ident).join('.');
    const sch = tableOwner && opts.schema == null ? ident(tableOwner) : schema;
    return sch ? `${sch}.${ident(table)}` : ident(table);
  };

  const entries: Entry[] = [];
  const add = (e: Entry) => (entries.push(e), e);
  const skipped: Record<string, number> = {};

  // ---- first pass: components by APEX id, and which page each belongs to
  const comps = new Map<string, Comp>();
  const pageOf = new Map<ApexCall, number>();
  let currentPage = 0;
  let lastLov: ApexCall | null = null;
  const staticLov = new Map<ApexCall, ApexCall[]>();
  for (const c of calls) {
    if (c.method === 'create_page') currentPage = int(num(c.args, 'p_id', 'p_page_id'), 0);
    const pg = num(c.args, 'p_page_id', 'p_flow_step_id');
    const page = c.method === 'create_page' ? currentPage : pg !== null && c.method !== 'create_flow' ? int(pg, currentPage) : currentPage;
    pageOf.set(c, page);
    const id = ref(c.args, 'p_id');
    if (id && c.method !== 'create_page') comps.set(`${c.method}:${id}`, { call: c, page });
    if (c.method === 'create_list_of_values') lastLov = c;
    if (c.method === 'create_static_lov_data') {
      const parentId = ref(c.args, 'p_lov_id');
      const parent = (parentId ? comps.get(`create_list_of_values:${parentId}`)?.call : null) ?? lastLov;
      if (parent) staticLov.set(parent, [...(staticLov.get(parent) ?? []), c]);
    }
    if (!READ.has(c.method) && !NOISE.test(c.method) && /^create_/.test(c.method)) skipped[c.method] = (skipped[c.method] ?? 0) + 1;
  }
  const comp = (method: string, id: string | null) => (id ? comps.get(`${method}:${id}`) ?? null : null);

  // ---- shared lists of values
  const lovs: any[] = [];
  const lovName = new Map<string, string>();
  const usedLov = new Set<string>();
  for (const c of by('create_list_of_values')) {
    const a = c.args;
    const apexName = str(a, 'p_lov_name') ?? 'LOV';
    let name = upperName(apexName, 'LOV');
    for (let n = 2; usedLov.has(name); n++) name = `${upperName(apexName, 'LOV')}_${n}`;
    usedLov.add(name);
    const id = ref(a, 'p_id');
    if (id) lovName.set(id, name);
    lovName.set(`name:${apexName.toUpperCase()}`, name);
    const e = add(new Entry('lov', null, apexName, str(a, 'p_source_type') ?? (staticLov.has(c) ? 'STATIC' : 'SQL'), 'lov'));
    const values = staticLov.get(c);
    let query: string | null = null;
    if (values?.length) query = staticLovQuery(values.sort((x, y) => (num(x.args, 'p_lov_disp_sequence') ?? 0) - (num(y.args, 'p_lov_disp_sequence') ?? 0)).map((v) => [str(v.args, 'p_lov_disp_value') ?? '', str(v.args, 'p_lov_return_value') ?? '']));
    else if (str(a, 'p_query_table')) {
      const ret = str(a, 'p_return_column_name');
      const disp = str(a, 'p_display_column_name') ?? ret;
      if (ret && disp) {
        const sort = str(a, 'p_default_sort_column_name');
        const where = e.oracle(str(a, 'p_query_where'));
        query = `select ${ident(disp)} as d, ${ident(ret)} as r from ${qualified(str(a, 'p_query_table'), str(a, 'p_query_owner'))}${where ? ` where ${where}` : ''}${sort ? ` order by ${ident(sort)}${/^desc/i.test(str(a, 'p_default_sort_direction') ?? '') ? ' desc' : ''}` : ''}`;
      }
    } else if (str(a, 'p_lov_query') && !/^\.\d+\.$/.test(str(a, 'p_lov_query')!)) {
      query = e.oracle(str(a, 'p_lov_query'));
    }
    if (!query) {
      e.notMapped(str(a, 'p_location') === 'WEB_SOURCE' ? 'a list of values on a REST source: give the pgkiln list a REST data source by hand' : 'no query or values found');
      query = "select 'TODO' as d, 'TODO' as r";
      e.status = 'not_mapped';
    }
    lovs.push({ name, query, rest_source: null });
  }

  // ---- authorization schemes (an unknown scheme fails closed in pgkiln: components that name one not created are denied)
  const authzSchemes: any[] = [];
  const authzName = new Map<string, string>();
  const usedAuthz = new Set<string>();
  for (const c of by('create_security_scheme')) {
    const a = c.args;
    const apexName = str(a, 'p_name') ?? 'AUTHZ';
    let name = upperName(apexName, 'AUTHZ');
    for (let n = 2; usedAuthz.has(name); n++) name = `${upperName(apexName, 'AUTHZ')}_${n}`;
    usedAuthz.add(name);
    const id = ref(a, 'p_id');
    if (id) authzName.set(id, name);
    const type = (str(a, 'p_scheme_type') ?? '').toUpperCase();
    const at = attributesOf(a);
    const body = str(a, 'p_attribute_01', 'p_scheme') ?? at.name ?? at.sql_query ?? at.query ?? null;
    const e = add(new Entry('authorization', null, apexName, type || '(none)', 'sql'));
    const msg = str(a, 'p_error_message');
    if ((type === 'NATIVE_EXISTS' || type === 'EXISTS') && body) {
      authzSchemes.push({ name, type: 'sql', value: `exists (${stripSemi(e.oracle(body))})`, error_message: msg });
    } else if ((type === 'NATIVE_NOT_EXISTS' || type === 'NOT_EXISTS') && body) {
      authzSchemes.push({ name, type: 'sql', value: `not exists (${stripSemi(e.oracle(body))})`, error_message: msg });
    } else if ((type === 'NATIVE_IS_IN_GROUP' || type === 'NATIVE_ACL_ROLE') && body) {
      const groups = body.split(/[,:]/).map((x) => x.trim()).filter(Boolean);
      if (groups.length === 1) {
        authzSchemes.push({ name, type: 'role', value: groups[0], error_message: msg });
        e.target = 'role';
      } else authzSchemes.push({ name, type: 'sql', value: groups.map((g) => `meta.has_role(${sqlString(g)})`).join(yes(a, 'p_attribute_02') || /^all$/i.test(at.match ?? '') ? ' and ' : ' or '), error_message: msg });
      e.note('APEX groups or roles became pgkiln application roles of the same name: assign them under Access control');
    } else
      e.notMapped(`${type || 'this type'} is not mapped: create a role or SQL scheme named ${name} by hand; until then the components that use it are denied (fail closed)`);
  }
  const authz = (a: Args, e: Entry): string | null => {
    const raw = str(a, 'p_security_scheme', 'p_required_role', 'p_authorization_scheme');
    if (!raw) return null;
    const neg = raw.startsWith('!');
    const v = neg ? raw.slice(1) : raw;
    if (/^MUST_NOT_BE_PUBLIC_USER$/i.test(v)) return neg ? null : 'MUST_NOT_BE_PUBLIC_USER';
    const name = authzName.get(v) ?? (/^\d+$/.test(v) ? null : upperName(v));
    if (!name) {
      e.note(`authorization scheme ${v} is not in the export: the component names UNKNOWN_SCHEME and is denied until you fix it`);
      return 'UNKNOWN_SCHEME';
    }
    return (neg ? '!' : '') + name;
  };

  // ---- pages
  const pageCalls = by('create_page');
  const pageAlias = new Map<string, number>();
  for (const p of pageCalls) {
    const al = str(p.args, 'p_alias');
    if (al) pageAlias.set(al.toUpperCase(), int(num(p.args, 'p_id', 'p_page_id'), 0));
  }
  const pageNo = (s: string | null) => {
    if (!s) return null;
    if (/^\d+$/.test(s)) return Number(s);
    return pageAlias.get(s.toUpperCase()) ?? null;
  };

  const loginPages = new Set<number>();
  for (const c of by('create_page_process')) {
    const code = str(c.args, 'p_process_sql_clob', 'p_process_sql') ?? '';
    if (/apex_authentication\s*\.\s*login\b|wwv_flow_custom_auth_std\s*\.\s*login\b/i.test(code)) loginPages.add(pageOf.get(c)!);
  }

  const pages: any[] = [];
  const docPage = new Map<number, any>();
  for (const p of pageCalls) {
    const a = p.args;
    const no = int(num(a, 'p_id', 'p_page_id'), 0);
    const name = str(a, 'p_name') ?? `Page ${no}`;
    const mode = (str(a, 'p_page_mode') ?? 'NORMAL').toUpperCase();
    const e = add(new Entry('page', no, name, mode === 'NORMAL' ? 'page' : `page (${mode})`, mode === 'NORMAL' ? 'normal' : 'modal'));
    if (no === 0) {
      e.notMapped('the global page (page 0) has no pgkiln equivalent: put its regions on the pages that need them, or use a template component');
      continue;
    }
    if (loginPages.has(no)) {
      e.notMapped("APEX's login page: pgkiln signs users in itself (an application's login page is a page with a Login region, chapter 8)");
      continue;
    }
    if (no < 0 || docPage.has(no)) {
      e.notMapped('a page number pgkiln cannot use');
      continue;
    }
    if (mode === 'NON_MODAL') e.note('a non-modal dialog became a modal page');
    const help = str(a, 'p_help_text');
    const prot = (str(a, 'p_protection_level') ?? 'C').toUpperCase();
    if (prot === 'D' || prot === 'B') e.note(`page access protection ${prot === 'D' ? 'No URL Access' : 'Arguments must have checksum'} became "checksum"`);
    const page = {
      page_no: no,
      name,
      title: str(a, 'p_step_title') ?? name,
      mode: mode === 'NORMAL' ? 'normal' : 'modal',
      requires_auth: !yes(a, 'p_page_is_public_y_n') && !/^(PUBLIC|NOT_REQUIRED)$/i.test(str(a, 'p_authentication') ?? ''),
      protection: prot === 'U' ? 'unrestricted' : 'checksum',
      dialog_position: 'center',
      dialog_size: 'medium',
      static_includes: [],
      warn_unsaved: yes(a, 'p_warn_on_unsaved_changes'),
      page_template: 'standard',
      help: help && help.length <= 20000 ? help : null,
      authz: authz(a, e),
      parent_page: null,
      regions: [] as any[],
      items: [] as any[],
      buttons: [] as any[],
      dynamic_actions: [] as any[],
      validations: [] as any[],
      processes: [] as any[],
      computations: [] as any[],
      branches: [] as any[],
    };
    if (str(a, 'p_javascript_code') || str(a, 'p_javascript_code_onload') || str(a, 'p_inline_css')) e.note('page JavaScript and CSS are not carried over (put them in a static application file)');
    pages.push(page);
    docPage.set(no, page);
  }
  const pageFor = (c: ApexCall) => docPage.get(pageOf.get(c)!) ?? null;
  const pageNum = (c: ApexCall) => pageOf.get(c) ?? null;

  // ---- regions
  let nextRegionId = 1;
  const regionDoc = new Map<string, { id: number; page: any; row: any }>();
  const regionColumns = new Map<string, ApexCall[]>();
  // (sprint 190) a column without p_region_id belongs to the region written just before it (APEX 26.2 exports)
  const plugsByLine = by('create_page_plug').slice().sort((x, y) => x.line - y.line);
  const plugAbove = (x: ApexCall) => {
    let found: ApexCall | null = null;
    for (const p of plugsByLine) if (p.line < x.line) found = p; else break;
    return found ? ref(found.args, 'p_id') : null;
  };
  for (const c of by('create_region_column')) {
    const r = ref(c.args, 'p_region_id') ?? plugAbove(c);
    if (r) regionColumns.set(r, [...(regionColumns.get(r) ?? []), c]);
  }
  const usedStatic = new Map<any, Set<string>>();
  // (sprint 190) faceted search regions (their report is set after the loop), lists that list regions show
  const facetRegions: { row: any; filtered: string | null; e: Entry }[] = [];
  const usedLists = new Set<string>();
  const listName = (l: ApexCall) => upperName(str(l.args, 'p_name'), 'LIST');
  /** CUSTOMER_ID_L$1 (the display value of a column with a list of values) is the column itself in pgkiln */
  const columnOf = (c: string, e: Entry) => {
    const m = /^(.+)_L\$\d+$/i.exec(c.trim());
    if (m) e.note(`${c} (the display value of a list of values) became the column ${m[1].toLowerCase()} itself: join the lookup table in the query to show its name`);
    return m ? m[1] : c;
  };
  // (sprint 190) what charts, cards and facets need after the loop: the region's APEX arguments, its entry and its SQL
  const regionApex = new Map<string, { a: Args; e: Entry; sql: () => string | null }>();
  // (sprint 190) a classic report can also be a create_report_region call, with its own argument names
  for (const c of by('create_report_region')) {
    const a = c.args;
    const alias: [string, string][] = [['p_plug_name', 'p_name'], ['p_plug_display_sequence', 'p_display_sequence'], ['p_plug_source', 'p_source'],
      ['p_plug_display_point', 'p_display_point'], ['p_plug_grid_column_span', 'p_grid_column_span'], ['p_plug_static_id', 'p_static_id'],
      ['p_plug_display_condition_type', 'p_display_condition_type'], ['p_plug_display_when_condition', 'p_display_when_condition'],
      ['p_plug_display_when_cond2', 'p_display_when_cond2'], ['p_plug_source_type', 'p_source_type']];
    for (const [to, from] of alias) if (a[to] === undefined && a[from] !== undefined) a[to] = a[from];
    if (a.p_plug_source_type === undefined) a.p_plug_source_type = 'NATIVE_SQL_REPORT';
  }
  for (const c of [...by('create_page_plug'), ...by('create_report_region')]) {
    const page = pageFor(c);
    const a = c.args;
    const title = str(a, 'p_plug_name') ?? 'Region';
    const apexType = (str(a, 'p_plug_source_type') ?? 'NATIVE_STATIC').toUpperCase();
    const e = add(new Entry('region', pageNum(c), title, apexType, REGION_TYPES[apexType] ?? 'static'));
    if (!page) {
      e.notMapped('its page was not imported');
      continue;
    }
    const used = usedStatic.get(page) ?? new Set<string>();
    usedStatic.set(page, used);
    let sid = staticId(str(a, 'p_plug_static_id')) ?? staticId(title) ?? 'region';
    for (let n = 2; used.has(sid); n++) sid = `${(staticId(str(a, 'p_plug_static_id')) ?? staticId(title) ?? 'region').slice(0, 45)}-${n}`;
    used.add(sid);
    const span = num(a, 'p_plug_grid_column_span');
    const cond = condition(str(a, 'p_plug_display_condition_type'), str(a, 'p_plug_display_when_condition'), str(a, 'p_plug_display_when_cond2'), e);
    const row: any = {
      id: nextRegionId++,
      seq: int(num(a, 'p_plug_display_sequence'), 10),
      type: REGION_TYPES[apexType] ?? 'static',
      title,
      static_id: sid,
      source: null,
      table_name: null,
      pk_column: null,
      pk_item: null,
      columns: span && span >= 1 && span <= 12 ? span : 12,
      template: 'standard',
      template_options: [],
      config: {},
      position: null,
      condition: cond.condition_expr,
      condition_type: cond.condition_type,
      condition_value: cond.condition_value,
      authz: authz(a, e),
      build_option: null,
      rest_source: null,
    };
    const point = (str(a, 'p_plug_display_point') ?? 'BODY').toUpperCase();
    if (point === 'REGION_POSITION_01') row.position = 'breadcrumb';
    else if (point !== 'BODY' && point !== 'AFTER_HEADER') e.note(`display position ${point} became the body`);
    if (ref(a, 'p_plug_parent_id', 'p_parent_plug_id')) e.note('a sub region: pgkiln places it on the page after its parent');
    const queryType = (str(a, 'p_query_type') ?? '').toUpperCase();
    const tableSource = () => {
      const t = qualified(str(a, 'p_query_table'), str(a, 'p_query_owner'));
      if (!t) return null;
      const where = e.oracle(str(a, 'p_query_where'));
      const order = str(a, 'p_query_order_by');
      return `select * from ${t}${where ? `\n where ${where}` : ''}${order ? `\n order by ${order}` : ''}`;
    };
    const sql = () => {
      const s = queryType === 'TABLE' ? tableSource() : e.oracle(str(a, 'p_plug_source', 'p_query_sql'));
      return s ? stripSemi(s) : null;
    };
    const apexRegionId = ref(a, 'p_id');
    if (apexRegionId) regionApex.set(apexRegionId, { a, e, sql });
    const at = attributesOf(a);
    /** the region's query with its columns given the names a pgkiln region reads */
    const wrap = (cols: [string, string | null | undefined][]) => {
      const base = sql();
      if (!base) return null;
      const sel = cols.filter(([, c]) => c).map(([alias, c]) => `${ident(columnOf(c!, e))} as ${alias}`);
      return `select ${[...sel, 'q.*'].join(', ')}\n  from (${base}) q`;
    };
    switch (row.type) {
      case 'chart': {
        // the series come after the region (create_jet_chart_series): filled in below
        row.source = null;
        break;
      }
      case 'cards': {
        const card = by('create_card').find((x) => ref(x.args, 'p_region_id') === apexRegionId)?.args ?? {};
        row.source = wrap([['title', str(card, 'p_title_column_name')], ['subtitle', str(card, 'p_sub_title_column_name')],
          ['body', str(card, 'p_body_column_name')], ['badge', str(card, 'p_badge_column_name')]]);
        if (/HTML|ADV/i.test(String(card.p_title_adv_formatting ?? '')) || card.p_title_adv_formatting === true || card.p_body_adv_formatting === true)
          e.note('advanced formatting (HTML expressions) of the card is not carried over: plain column values are shown');
        if (str(card, 'p_media_source_type') || str(card, 'p_media_url_column_name')) e.note('card media (images) are not carried over');
        if (!row.source) {
          row.type = 'static';
          row.source = `<p>APEX cards ${escapeHtml(title)}: no query found.</p>`;
          e.notMapped('no query found');
        }
        break;
      }
      case 'calendar': {
        const start = at.start_date_column ?? str(a, 'p_attribute_03');
        row.source = start ? wrap([['start_date', start], ['end_date', at.end_date_column ?? str(a, 'p_attribute_07')], ['title', at.display_column ?? str(a, 'p_attribute_02') ?? start]]) : null;
        if (!row.source) {
          row.type = 'static';
          row.source = `<p>APEX calendar ${escapeHtml(title)}: no query or start date column found.</p>`;
          e.notMapped('no query or start date column found');
        } else {
          const views = (at.additional_calendar_views ?? '').toLowerCase();
          row.config = { views: ['month', 'week', 'day', 'list'].filter((v) => v === 'month' || views.includes(v)) };
          if (at.create_link || at.view_edit_link) e.note('the calendar\'s create and edit links are not carried over: set link and create in its settings');
        }
        break;
      }
      case 'facets': {
        // facets are page items of this region (below); the report it filters is set after every region is known
        row.config = { report: null, facets: [] };
        facetRegions.push({ row, filtered: ref(a, 'p_filtered_region_id'), e });
        break;
      }
      case 'list': {
        const listId = ref(a, 'p_list_id');
        const list = listId ? comp('create_list', listId)?.call : null;
        if (!list) {
          row.type = 'static';
          row.source = `<p>APEX list region ${escapeHtml(title)}: its list is not in the export.</p>`;
          e.notMapped('its list is not in the export');
        } else {
          usedLists.add(listId!);
          const tmpl = (str(a, 'p_list_template_id') ?? '') + ' ' + (str(a, 'p_plug_template') ?? '');
          row.config = { list: listName(list), template: /card|media/i.test(tmpl) ? 'cards' : 'links' };
          e.note('the list template became pgkiln\'s links template: choose another (badges, cards, tabs) in the region settings');
        }
        break;
      }
      case 'static': {
        if (REGION_TYPES[apexType]) {
          row.source = str(a, 'p_plug_source');
          if (/<script\b|\son[a-z]+\s*=/i.test(row.source ?? '')) e.note('inline JavaScript in the HTML: the content security policy blocks it (use a static application file)');
          if (/#[A-Z_]+#/.test(row.source ?? '') || /&[A-Z0-9_]+\./.test(row.source ?? '')) {
            // &ITEM. works the same; #SUBSTITUTIONS# of templates don't
            if (/#[A-Z_]+#/.test(row.source ?? '')) e.note('#…# template substitutions in the HTML are not filled in');
          }
        } else {
          // a type pgkiln has, but with settings the importer does not read, or one it has not: keep the source to see
          const what = REGION_NAMES[apexType] ?? apexType;
          const src = str(a, 'p_plug_source');
          row.source = `<div class="alert alert-info"><p>APEX region <strong>${escapeHtml(title)}</strong> (${escapeHtml(what)}, ${escapeHtml(apexType)}) was not imported: rebuild it with a pgkiln region.</p>${src ? `<pre>${escapeHtml(src)}</pre>` : ''}</div>`;
          row.template = 'plain';
          e.notMapped(`${what} regions are not mapped: a static region with a note (and the APEX source) stands in for it`);
          if (apexType === 'NATIVE_PLSQL') e.port = true;
        }
        break;
      }
      case 'report':
      case 'classic_report': {
        row.source = sql();
        if (!row.source) {
          row.type = 'static';
          row.source = `<p>APEX report ${escapeHtml(title)}: no query found.</p>`;
          e.notMapped('no query found');
        } else if (row.type === 'report') e.note('interactive report settings (columns, saved reports, links) are not carried over: set them in the report settings');
        break;
      }
      case 'form': {
        if (queryType === 'TABLE' || str(a, 'p_query_table')) row.table_name = qualified(str(a, 'p_query_table'), str(a, 'p_query_owner'));
        else e.note('a form on a SQL query or another source: pgkiln forms edit one table: set its table by hand');
        break;
      }
      case 'grid': {
        row.source = sql();
        const cols = regionColumns.get(ref(a, 'p_id') ?? '') ?? [];
        const pk = cols.find((x) => x.args.p_is_primary_key === true || yes(x.args, 'p_is_primary_key'));
        if (queryType === 'TABLE') row.table_name = qualified(str(a, 'p_query_table'), str(a, 'p_query_owner'));
        else {
          const m = /\bfrom\s+([A-Za-z0-9_$#."]+)/i.exec(row.source ?? '');
          if (m) row.table_name = qualified(m[1].replace(/"/g, ''));
          e.note('a grid on a SQL query: check its table (pgkiln saves one table)');
        }
        if (pk) row.pk_column = ident(str(pk.args, 'p_source_expression', 'p_name') ?? '');
        else e.note('no primary key column found: set the grid\'s key column by hand');
        const dbCols = cols.filter((x) => /^DB_COLUMN$/i.test(str(x.args, 'p_source_type') ?? '') && str(x.args, 'p_source_expression'));
        if (queryType === 'TABLE' && dbCols.length) row.source = `select ${dbCols.map((x) => ident(str(x.args, 'p_source_expression')!)).join(', ')}\n  from ${row.table_name}`;
        if (!row.source) row.source = row.table_name ? `select * from ${row.table_name}` : null;
        if (!row.source || !row.table_name) {
          row.type = 'static';
          row.source = `<p>APEX interactive grid ${escapeHtml(title)}: no table or query found.</p>`;
          e.notMapped('no table or query found');
        }
        e.note('grid column settings (labels, lists of values, column validations) are not carried over');
        break;
      }
      case 'breadcrumb':
        row.template = 'plain';
        row.position = 'breadcrumb';
        e.note("pgkiln's breadcrumb comes from each page's breadcrumb parent, not from an APEX breadcrumb: set the pages' parents");
        break;
    }
    page.regions.push(row);
    const id = ref(a, 'p_id');
    if (id) regionDoc.set(id, { id: row.id, page, row });
  }
  const regionId = (id: string | null) => (id ? regionDoc.get(id)?.id ?? null : null);

  // ---- items
  const itemName = new Map<string, string>();
  const itemLabel = new Map<string, string>();
  const itemCalls = by('create_page_item');
  for (const c of itemCalls) {
    const id = ref(c.args, 'p_id');
    const n = (str(c.args, 'p_name') ?? '').toUpperCase();
    if (id && n) itemName.set(id, n);
    if (n) itemLabel.set(n, stripTags(str(c.args, 'p_prompt') ?? n));
  }
  const itemRef = (a: Args, key: string) => {
    const id = ref(a, key);
    if (id) return itemName.get(id) ?? null;
    const s = str(a, key);
    return s && isUpperName(s.toUpperCase()) ? s.toUpperCase() : null;
  };
  const lovOf = (a: Args, e: Entry): string | null => {
    const named = a.p_named_lov;
    if (named instanceof ApexId) {
      const n = lovName.get(named.id);
      if (!n) e.note('its shared list of values is not in the export');
      return n ? `LOV:${n}` : null;
    }
    const nm = str(a, 'p_named_lov');
    if (nm) {
      const n = lovName.get(`name:${nm.toUpperCase()}`);
      if (!n) e.note(`its shared list of values ${nm} is not in the export`);
      return n ? `LOV:${n}` : null;
    }
    const lov = str(a, 'p_lov');
    if (!lov) return null;
    const st = /^STATIC2?:([\s\S]*)$/i.exec(lov.trim());
    if (st) return staticLovText(st[1]);
    return stripSemi(e.oracle(lov));
  };
  /** (sprint 190) A facet item (NATIVE_CHECKBOX, NATIVE_RANGE, NATIVE_SEARCH …) into its region's config */
  const facetOf = (region: any, a: Args, e: Entry) => {
    const type = (str(a, 'p_display_as') ?? '').toUpperCase();
    const column = str(a, 'p_source');
    const label = str(a, 'p_prompt') ?? undefined;
    if (type === 'NATIVE_SEARCH') {
      region.config.search = true;
      e.target = 'facet search';
      return;
    }
    if (!column) {
      e.notMapped('a facet without a column');
      return;
    }
    const f: Record<string, unknown> = { column: ident(column), ...(label ? { label: stripTags(label) } : {}) };
    if (type === 'NATIVE_RANGE') {
      f.type = 'range';
      const lov = /^STATIC2?:([\s\S]*)$/i.exec((str(a, 'p_lov') ?? '').trim());
      const n = (x: string | undefined) => (x !== undefined && /^-?\d+(\.\d+)?$/.test(x.trim()) ? Number(x) : /^\d{4}-\d\d-\d\d$/.test(x?.trim() ?? '') ? x!.trim() : undefined);
      const ranges = (lov?.[1] ?? '').split(',').map((x) => x.split(';')).filter((x) => x.length === 2).map(([l, v]) => {
        const [from, to] = v.split('|');
        return { ...(n(from) !== undefined ? { from: n(from) } : {}), ...(n(to) !== undefined ? { to: n(to) } : {}), label: l.replace(/#G#/g, ',').replace(/#D#/g, '.') };
      }).filter((r) => 'from' in r || 'to' in r).slice(0, 20);
      if (ranges.length) f.ranges = ranges;
      if (attributesOf(a).manual_entry === 'Y' || !ranges.length) f.custom = true;
    } else if (type === 'NATIVE_STAR_RATING') f.type = 'star';
    else if (type === 'NATIVE_CHECKBOX' || type === 'NATIVE_RADIOGROUP' || type === 'NATIVE_SELECT_LIST') {
      if (a.p_fc_exclude_allowed === true || yes(a, 'p_fc_exclude_allowed')) f.exclude = true;
      if (type !== 'NATIVE_CHECKBOX') e.note(`a ${type === 'NATIVE_RADIOGROUP' ? 'radio group' : 'select list'} facet became a checkbox facet`);
      if (str(a, 'p_named_lov') || str(a, 'p_lov')) e.note('the facet shows the column\'s values, not its list of values\' display values');
    } else {
      e.notMapped(`facet type ${type} is not mapped`);
      return;
    }
    if (a.p_fc_show_chart === true && a.p_fc_initial_chart === true) f.chart = 'bar';
    region.config.facets.push(f);
    e.target = `facet ${String(f.type ?? 'checkbox')}`;
  };
  for (const c of itemCalls) {
    const page = pageFor(c);
    const a = c.args;
    const name = (str(a, 'p_name') ?? '').toUpperCase();
    const apexType = (str(a, 'p_display_as') ?? 'NATIVE_TEXT_FIELD').toUpperCase();
    const e = add(new Entry('item', pageNum(c), name || '(no name)', apexType, ITEM_TYPES[apexType] ?? 'text'));
    if (!page) {
      e.notMapped('its page was not imported');
      continue;
    }
    // (sprint 190) an item of a faceted search region is a facet of that region, not a page item
    const facetRegion = regionDoc.get(ref(a, 'p_item_plug_id') ?? '')?.row;
    if (facetRegion?.type === 'facets') {
      facetOf(facetRegion, a, e);
      continue;
    }
    if (!isUpperName(name)) {
      e.notMapped('an item name pgkiln cannot use');
      continue;
    }
    if (page.items.some((x: any) => x.name === name)) {
      e.notMapped('another item of the page has this name');
      continue;
    }
    let type = ITEM_TYPES[apexType];
    if (!type) {
      type = 'text';
      e.note(`${apexType.startsWith('PLUGIN_') ? 'a plug-in item' : `item type ${apexType}`} is not mapped: it became a text field`);
    }
    const config: Record<string, unknown> = {};
    if (type === 'date') {
      const fmt = str(a, 'p_format_mask') ?? '';
      if (/HH|MI/i.test(fmt)) type = 'datetime';
    }
    if (type === 'text') {
      const sub = (attributeAt(a, apexType, 1) ?? '').toUpperCase();
      if (sub === 'EMAIL') type = 'email';
      else if (sub === 'TEL' || sub === 'PHONE') type = 'tel';
      else if (sub === 'URL') type = 'url';
    }
    if (type === 'hidden' && /^n$/i.test(attributeAt(a, apexType, 1) ?? '')) config.value_protected = false;
    e.target = type;
    const sourceType = (str(a, 'p_source_type') ?? '').toUpperCase();
    const fromColumn = sourceType === 'REGION_SOURCE_COLUMN' || sourceType === 'DB_COLUMN';
    const regionApexId = fromColumn ? ref(a, 'p_item_source_plug_id') ?? ref(a, 'p_item_plug_id') : ref(a, 'p_item_plug_id');
    const region = regionApexId ? regionDoc.get(regionApexId) : null;
    if (regionApexId && !region) e.note('its region was not imported: the item is at page level');
    const source = str(a, 'p_source');
    const sourceColumn = fromColumn && source ? ident(source) : null;
    if (fromColumn && region && !['form', 'grid'].includes(region.row.type)) {
      if (sourceType === 'DB_COLUMN') e.note('a column of a legacy APEX form (automatic row fetch): turn the region into a form region');
    }
    if (sourceColumn && region?.row.type === 'form' && (a.p_is_primary_key === true || yes(a, 'p_is_primary_key')) && !region.row.pk_column) {
      region.row.pk_column = sourceColumn;
      region.row.pk_item = name;
    }
    if (!fromColumn && source && sourceType && sourceType !== 'ALWAYS_NULL' && sourceType !== 'NONE') {
      // a source that sets the item: a before header computation (only when the item is empty: APEX's "Only when value in session state is null")
      const comp = sourceComputation(name, sourceType, source, a.p_source_language ?? a.p_source_lang, e);
      if (comp) {
        if (!/^a/i.test(str(a, 'p_source_used') ?? 'S')) Object.assign(comp, { condition_type: 'item_null', condition_expr: name });
        page.computations.push(comp);
        e.note(`its source (${sourceType}) became a before header computation`);
      }
    }
    // a default value: static as it is; others as a computation when the item is empty
    let defaultValue: string | null = null;
    const def = str(a, 'p_item_default');
    if (def) {
      const dt = (str(a, 'p_item_default_type') ?? 'STATIC').toUpperCase();
      if (dt === 'STATIC' || dt === 'STATIC_TEXT_WITH_SUBSTITUTIONS') defaultValue = def;
      else {
        const comp = sourceComputation(name, dt === 'SQL_QUERY' ? 'QUERY' : dt, def, a.p_item_default_language, e);
        if (comp) {
          page.computations.push({ ...comp, condition_type: 'item_null', condition_expr: name });
          e.note(`its default (${dt}) became a before header computation when the item is empty`);
        }
      }
    }
    const lov = lovOf(a, e);
    if (lov && !LOV_TYPES.has(type)) e.note('a list of values on an item type that does not use one');
    const ro = (str(a, 'p_read_only_when_type') ?? '').toUpperCase();
    let readonly: string | null = null;
    if (ro === 'ALWAYS') readonly = 'true';
    else if (ro === 'SQL_EXPRESSION' || ro === 'EXPRESSION') readonly = str(a, 'p_read_only_when');
    else if (ro) e.note(`read-only condition ${ro} is not carried over`);
    const cond = condition(str(a, 'p_display_when_type'), str(a, 'p_display_when'), str(a, 'p_display_when2'), e);
    page.items.push({
      name,
      seq: int(num(a, 'p_item_sequence'), 10),
      region_id: region?.id ?? null,
      label: stripTags(str(a, 'p_prompt') ?? '') || null,
      type,
      lov: lov && LOV_TYPES.has(type) ? lov : null,
      source_column: region && ['form', 'grid'].includes(region.row.type) ? sourceColumn : null,
      default_value: defaultValue,
      required: a.p_is_required === true || yes(a, 'p_is_required'),
      help: str(a, 'p_help_text'),
      readonly_condition: readonly,
      authz: authz(a, e),
      config,
      build_option: null,
      template_options: [],
      ...cond,
    });
  }
  for (const r of regionDoc.values())
    if (r.row.type === 'form' && r.row.table_name && !r.row.pk_column) {
      const e = entries.find((x) => x.kind === 'region' && x.name === r.row.title && x.page === r.page.page_no);
      e?.note('no primary key item found: set the form\'s key column and item by hand');
    }

  // ---- buttons
  const buttonName = new Map<string, string>();
  for (const c of by('create_page_button')) {
    const id = ref(c.args, 'p_id');
    const n = upperName(str(c.args, 'p_button_name'), 'BUTTON');
    if (id) buttonName.set(id, n);
  }
  const buttonRef = (a: Args, key: string) => {
    const id = ref(a, key);
    return id ? buttonName.get(id) ?? null : null;
  };
  for (const c of by('create_page_button')) {
    const page = pageFor(c);
    const a = c.args;
    const name = upperName(str(a, 'p_button_name'), 'BUTTON');
    const action = (str(a, 'p_button_action') ?? 'SUBMIT').toUpperCase();
    const e = add(new Entry('button', pageNum(c), name, action, null));
    if (!page) {
      e.notMapped('its page was not imported');
      continue;
    }
    const row: any = {
      name,
      seq: int(num(a, 'p_button_sequence'), 10),
      label: stripTags(str(a, 'p_button_image_alt') ?? '') || name,
      action: 'submit',
      hot: yes(a, 'p_button_is_hot'),
      region_id: regionId(ref(a, 'p_button_plug_id')),
      target_page: null,
      target_items: {},
      template_options: [],
      slot: null,
      authz: authz(a, e),
      build_option: null,
      confirm: null,
      menu: null,
      badge: null,
      badge_query: null,
      document: null,
    };
    const pos = (str(a, 'p_button_position') ?? '').toUpperCase().replace(/^REGION_TEMPLATE_/, '').toLowerCase();
    if (BUTTON_SLOTS.has(pos)) row.slot = pos;
    if (action === 'SUBMIT') row.action = 'submit';
    else if (action === 'DEFINED_BY_DA') row.action = 'da';
    else if (action === 'REDIRECT_PAGE' || action === 'REDIRECT_URL') {
      const url = str(a, 'p_button_redirect_url');
      const fp = parseFp(url);
      const target = fp ? pageNo(fp.page) : null;
      if (fp && target) {
        row.action = 'redirect';
        row.target_page = target;
        row.target_items = lowerHashes(fp.items);
        if (fp.request || fp.clear) e.note('the request and clear cache of the link are not carried over');
      } else {
        row.action = 'submit';
        e.notMapped(`a link pgkiln cannot follow (${url ?? 'none'}): the button became a submit button; give it a target page by hand`);
      }
    } else e.note(`button action ${action} became submit`);
    const db = (str(a, 'p_database_action') ?? '').toUpperCase();
    const ops: Record<string, string[]> = { INSERT: ['CREATE', 'INSERT', 'ADD'], UPDATE: ['SAVE', 'UPDATE', 'APPLY', 'APPLY_CHANGES'], DELETE: ['DELETE'] };
    if (db && ops[db] && !ops[db].includes(name)) e.note(`database action ${db}: pgkiln's form_dml decides by the button name (${ops[db].join(', ')}); rename the button`);
    if (/^DELETE$/.test(name) && action === 'SUBMIT' && str(a, 'p_confirm_message')) row.confirm = str(a, 'p_confirm_message');
    const cond = condition(str(a, 'p_button_condition_type'), str(a, 'p_button_condition'), str(a, 'p_button_condition2'), e);
    row.condition = cond.condition_expr;
    row.condition_type = cond.condition_type;
    row.condition_value = cond.condition_value;
    e.target = row.action;
    page.buttons.push(row);
  }

  // ---- validations
  for (const c of by('create_page_validation')) {
    const page = pageFor(c);
    const a = c.args;
    const name = str(a, 'p_validation_name') ?? 'Validation';
    const apexType = (str(a, 'p_validation_type') ?? '').toUpperCase();
    const m = VALIDATION_TYPES[apexType];
    const e = add(new Entry('validation', pageNum(c), name, apexType || '(none)', m?.type ?? null));
    if (!page) {
      e.notMapped('its page was not imported');
      continue;
    }
    if (ref(a, 'p_tabular_form_region_id') || ref(a, 'p_associated_column')) {
      e.notMapped('an interactive grid column validation: set it on the grid column in pgkiln (a column\'s validation, chapter 4)');
      continue;
    }
    if (!m) {
      e.notMapped(apexType === 'PLSQL_ERROR' ? 'PL/SQL Error validations are not mapped: raise the error in a function_body validation or a PL/pgSQL function' : `validation type ${apexType || '(none)'} is not mapped`);
      continue;
    }
    const v1 = str(a, 'p_validation');
    const v2 = str(a, 'p_validation2');
    const associated = itemRef(a, 'p_associated_item');
    const row: any = {
      name,
      seq: int(num(a, 'p_validation_sequence'), 10),
      type: m.type,
      message: '',
      item_name: null,
      expression: null,
      when_button: buttonRef(a, 'p_when_button_pressed'),
      always_execute: yes(a, 'p_always_execute'),
      display_location: DISPLAY_LOCATIONS[(str(a, 'p_error_display_location') ?? '').toUpperCase()] ?? 'inline_and_notification',
      authz: authz(a, e),
      build_option: null,
    };
    if ((str(a, 'p_error_display_location') ?? '').toUpperCase() === 'ON_ERROR_PAGE') e.note('"on error page" became a notification at the top of the page');
    if (m.item) {
      row.item_name = (v1 ?? '').trim().toUpperCase() || associated;
      if (m.value) row.expression = v2;
      if (m.type === 'regex') e.note('the regular expression is checked by PostgreSQL (POSIX): check Oracle-only syntax');
    } else {
      row.item_name = associated;
      row.expression = v1 ? stripSemi(v1) : null;
      if (m.plsql || (apexType === 'EXPRESSION' && /plsql/i.test(v2 ?? ''))) e.plsql();
      else row.expression = e.oracle(row.expression);
    }
    if (row.item_name && !isUpperName(row.item_name)) row.item_name = null;
    // #LABEL# is the associated item's label in APEX: fill it in
    let msg = str(a, 'p_error_message') ?? '';
    const label = row.item_name ? itemLabel.get(row.item_name) ?? row.item_name : '';
    msg = msg.replace(/#LABEL#/g, label).replace(/#COLUMN_HEADER#/g, label);
    if (/#[A-Z_]+#/.test(msg)) e.note('#…# substitutions in the message are not filled in (use &ITEM.)');
    row.message = msg || (m.type === 'function_error' ? '' : 'The value is not valid.');
    const okItem = m.item ? isUpperName(row.item_name) : true;
    const okExpr = m.item && !m.value ? true : (row.expression ?? '').trim() !== '';
    if (!okItem || !okExpr) {
      e.notMapped(!okItem ? 'its item is missing' : 'its expression is missing');
      continue;
    }
    const cond = condition(str(a, 'p_validation_condition_type'), str(a, 'p_validation_condition'), str(a, 'p_validation_condition2'), e);
    Object.assign(row, cond);
    page.validations.push(row);
  }

  // ---- processes
  const procName = new Map<string, string>();
  for (const c of by('create_page_process')) {
    const id = ref(c.args, 'p_id');
    if (id) procName.set(id, str(c.args, 'p_process_name') ?? 'Process');
  }
  const apiParams = new Map<string, ApexCall[]>();
  for (const c of by('create_invokeapi_comp_param')) {
    const p = ref(c.args, 'p_page_process_id', 'p_process_id');
    if (p) apiParams.set(p, [...(apiParams.get(p) ?? []), c]);
  }
  const webSourceName = new Map<string, string>();
  for (const c of by('create_web_source_module')) {
    const id = ref(c.args, 'p_id');
    const n = str(c.args, 'p_name');
    if (id && n) webSourceName.set(id, upperName(str(c.args, 'p_static_id') ?? n, 'SOURCE'));
  }
  const usedProcNames = new Map<any, Set<string>>();
  for (const c of by('create_page_process')) {
    const page = pageFor(c);
    const a = c.args;
    let name = str(a, 'p_process_name') ?? 'Process';
    const apexType = (str(a, 'p_process_type') ?? '').toUpperCase();
    const e = add(new Entry('process', pageNum(c), name, apexType || '(none)', null));
    if (!page) {
      e.notMapped('its page was not imported');
      continue;
    }
    const used = usedProcNames.get(page) ?? new Set<string>();
    usedProcNames.set(page, used);
    for (let n = 2; used.has(name); n++) name = `${str(a, 'p_process_name') ?? 'Process'} (${n})`;
    used.add(name);
    const pointCode = (str(a, 'p_process_point') ?? 'AFTER_SUBMIT').toUpperCase();
    const point = pointCode === 'ON_DEMAND' ? 'ajax' : /^(AFTER_SUBMIT|ON_SUBMIT_BEFORE_COMPUTATION|BEFORE_VALIDATION|AFTER_VALIDATION)$/.test(pointCode) ? 'submit' : 'load';
    if (pointCode !== 'AFTER_SUBMIT' && pointCode !== 'BEFORE_HEADER' && pointCode !== 'ON_DEMAND') e.note(`process point ${pointCode} became ${point === 'submit' ? 'after submit (after the validations)' : 'on load'}`);
    const row: any = {
      name,
      seq: int(num(a, 'p_process_sequence'), 10),
      type: null,
      point,
      code: null,
      config: {},
      region_id: regionId(ref(a, 'p_region_id')),
      when_button: buttonRef(a, 'p_process_when_button_id'),
      success_message: str(a, 'p_process_success_message'),
      parent_process: null,
      authz: authz(a, e),
      build_option: null,
    };
    const parent = ref(a, 'p_parent_process_id');
    if (parent) row.parent_process = procName.get(parent) ?? null;
    const at = (n: number) => attributeAt(a, apexType, n);
    const plsqlCode = () => str(a, 'p_process_sql_clob', 'p_process_sql', 'p_process_clob');
    switch (apexType) {
      case 'NATIVE_PLSQL':
      case 'PLSQL': {
        row.type = 'sql';
        row.code = plsqlCode();
        e.plsql();
        if (!row.code) e.notMapped('no code found');
        break;
      }
      case 'NATIVE_FORM_INIT':
        row.type = 'form_init';
        break;
      case 'NATIVE_FORM_DML':
        row.type = 'form_dml';
        if (!row.region_id) e.note('its form region was not found: set the process\'s region');
        if (at(1) && at(1) !== 'REGION_SOURCE') e.note(`target type ${at(1)}: pgkiln's form_dml writes the form region's table`);
        break;
      case 'NATIVE_IG_DML':
        row.type = 'grid_dml';
        if (!row.region_id) e.note('its grid region was not found: set the process\'s region');
        break;
      case 'NATIVE_SESSION_STATE':
      case 'CLEAR_CACHE_FOR_PAGES':
      case 'CLEAR_CACHE_CURRENT_PAGE':
      case 'CLEAR_CACHE_FOR_ITEMS':
      case 'CLEAR_CACHE_FOR_APPS': {
        row.type = 'clear_session_state';
        const what = apexType === 'NATIVE_SESSION_STATE' ? (at(1) ?? '').toUpperCase() : apexType;
        const list = (s: string | null) => (s ?? '').split(/[,:]/).map((x) => x.trim()).filter(Boolean);
        if (what === 'CLEAR_CACHE_CURRENT_PAGE') row.config = { pages: [page.page_no] };
        else if (what === 'CLEAR_CACHE_FOR_PAGES') {
          const pages = list(apexType === 'NATIVE_SESSION_STATE' ? at(3) ?? at(2) : plsqlCode()).map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0);
          row.config = { pages: pages.length ? pages : [page.page_no] };
        } else if (what === 'CLEAR_CACHE_FOR_ITEMS') {
          const items = list(apexType === 'NATIVE_SESSION_STATE' ? at(2) : plsqlCode()).map((x) => x.toUpperCase()).filter(isUpperName);
          if (items.length) row.config = { items };
          else e.notMapped('no items to clear found');
        } else if (/APP|ALL|SESSION/.test(what)) row.config = { all: true };
        else e.notMapped(`clear session state ${what || '(no setting)'} is not mapped`);
        break;
      }
      case 'NATIVE_CLOSE_WINDOW': {
        row.type = 'close_dialog';
        const items = (at(1) ?? '').split(',').map((x) => x.trim().toUpperCase()).filter(isUpperName);
        if (items.length) row.config = { items };
        break;
      }
      case 'NATIVE_RESET_PAGINATION':
      case 'RESET_PAGINATION':
        row.type = 'reset_pagination';
        break;
      case 'NATIVE_SEND_EMAIL': {
        row.type = 'send_email';
        const cfg: Record<string, string> = {};
        const keys: [number, string][] = [[1, 'from'], [2, 'to'], [3, 'cc'], [4, 'bcc'], [5, 'reply_to'], [6, 'subject'], [7, 'body'], [8, 'body_html']];
        for (const [n, k] of keys) if (at(n)) cfg[k] = at(n)!;
        if (!cfg.to) e.notMapped('no recipient found');
        row.config = cfg;
        e.note('check the addresses, subject and bodies; attachments and e-mail templates are not carried over; the application needs a mail service');
        break;
      }
      case 'NATIVE_INVOKE_API': {
        const params = (apiParams.get(ref(a, 'p_id') ?? '') ?? []).sort((x, y) => (num(x.args, 'p_display_sequence') ?? 0) - (num(y.args, 'p_display_sequence') ?? 0));
        const location = (str(a, 'p_location') ?? at(1) ?? '').toUpperCase();
        const valueOf = (p: ApexCall) => {
          const vt = (str(p.args, 'p_value_type') ?? 'STATIC').toUpperCase();
          const v = str(p.args, 'p_value') ?? '';
          return vt === 'ITEM' ? { item: v.toUpperCase() } : vt === 'STATIC' ? { value: v } : { other: vt };
        };
        if (location === 'WEB_SOURCE' || location === 'REMOTE' || ref(a, 'p_web_src_module_id')) {
          row.type = 'invoke_api';
          const src = webSourceName.get(ref(a, 'p_web_src_module_id') ?? '') ?? null;
          const cfg: Record<string, unknown> = { source: src ?? 'TODO' };
          const ps: Record<string, string> = {};
          const items: Record<string, string> = {};
          for (const p of params) {
            const n = str(p.args, 'p_name') ?? '';
            const v = valueOf(p);
            if (/out/i.test(str(p.args, 'p_direction') ?? '') && v.item) items[v.item] = n.toLowerCase();
            else if (v.item) ps[n] = `&${v.item}.`;
            else if (v.value !== undefined) ps[n] = v.value;
            else e.note(`parameter ${n} (${v.other}) is not carried over`);
          }
          if (Object.keys(ps).length) cfg.params = ps;
          if (Object.keys(items).length) cfg.items = items;
          row.config = cfg;
          e.note(`create the REST data source ${src ?? '(its name)'} in pgkiln (Shared Components → REST data sources) with the same parameters`);
        } else if (/^APEX_AUTHENTICATION$/i.test(at(3) ?? str(a, 'p_api_package') ?? '') && /^(LOGIN|SEND_LOGIN_USERNAME_COOKIE|GET_LOGIN_USERNAME_COOKIE|LOGOUT)$/i.test(at(4) ?? str(a, 'p_api_procedure') ?? '')) {
          // (sprint 190) the processes of APEX's own login page: pgkiln's sign-in does this (and remembers the user name)
          e.target = null;
          e.note(`APEX_AUTHENTICATION.${(at(4) ?? str(a, 'p_api_procedure') ?? '').toUpperCase()} is what pgkiln's sign-in does: the process was left out`);
          continue;
        } else {
          row.type = 'sql';
          const pkg = at(3) ?? str(a, 'p_api_package');
          const proc = at(4) ?? str(a, 'p_api_procedure');
          const target = [pkg, proc].filter(Boolean).map((x) => ident(x!)).join('.');
          const args = params
            .filter((p) => !/^out$/i.test(str(p.args, 'p_direction') ?? ''))
            .map((p) => {
              const v = valueOf(p);
              return `${ident(str(p.args, 'p_name') ?? 'p')} => ${v.item ? `:${v.item}` : v.value !== undefined ? sqlString(v.value) : 'null'}`;
            });
          if (!target) e.notMapped('no PL/SQL package or procedure found');
          row.code = `call ${target || 'todo'}(${args.join(', ')})`;
          e.port = true;
          e.note(`calls the PL/SQL API ${target || '(unknown)'}: create a PostgreSQL function or procedure ${target || ''} (a schema for the package)${params.some((p) => /out/i.test(str(p.args, 'p_direction') ?? '')) ? '; OUT parameters: return columns named like the items instead' : ''}`);
        }
        break;
      }
      case 'NATIVE_EXECUTION_CHAIN':
        row.type = 'chain';
        if (yes(a, 'p_attribute_01')) e.note('"run in background" is not carried over: set it in the chain\'s attributes');
        break;
      case 'NATIVE_FORM_FETCH':
      case 'NATIVE_FORM_PROCESS':
      case 'NATIVE_FORM_PAGINATION':
      case 'DML_FETCH_ROW':
      case 'DML_PROCESS_ROW':
        e.notMapped('a legacy APEX form process: make the region a form region (pgkiln: form, form_init and form_dml)');
        break;
      case 'NATIVE_WEB_SERVICE':
        e.notMapped('legacy web service references are not mapped: use an invoke_api process with a REST data source');
        break;
      case 'NATIVE_USER_PREFERENCES':
        e.notMapped('set it up as a user_preferences process (preference and item, chapter 6)');
        break;
      case 'NATIVE_PRINT_REPORT':
        e.notMapped('create a document template, then a print_report process (chapter 6)');
        break;
      case 'NATIVE_GEOCODING':
        e.notMapped('set it up as a server_geocoding process (address and coordinates items)');
        break;
      case 'NATIVE_WORKFLOW':
      case 'NATIVE_HUMAN_TASK_CREATE':
      case 'NATIVE_HUMAN_TASK_MANAGE':
        e.notMapped(`create the ${apexType === 'NATIVE_WORKFLOW' ? 'workflow' : 'task'} definition in pgkiln first, then a ${apexType === 'NATIVE_WORKFLOW' ? 'workflow' : apexType === 'NATIVE_HUMAN_TASK_CREATE' ? 'human_task_create' : 'human_task_manage'} process`);
        break;
      default:
        e.notMapped(apexType.startsWith('PLUGIN_') ? 'a process plug-in: rebuild it as a pgkiln process plug-in or a SQL process' : `process type ${apexType || '(none)'} is not mapped`);
    }
    if (e.status === 'not_mapped' || !row.type) continue;
    if (str(a, 'p_process_error_message')) e.note('its error message is not carried over: pgkiln shows the error the code raises');
    const cond = condition(str(a, 'p_process_when_type'), str(a, 'p_process_when'), str(a, 'p_process_when2'), e);
    Object.assign(row, { condition_expr: cond.condition_expr, condition_type: cond.condition_type, condition_value: cond.condition_value });
    e.target = row.type;
    page.processes.push(row);
  }
  // a parent that was not imported (or no chain): run the child on its own
  for (const page of pages)
    for (const pr of page.processes)
      if (pr.parent_process && !page.processes.some((x: any) => x.name === pr.parent_process && x.type === 'chain')) {
        entries.find((x) => x.kind === 'process' && x.page === page.page_no && x.name === pr.name)?.note(`its execution chain ${pr.parent_process} was not imported: it runs on its own`);
        pr.parent_process = null;
      }

  // ---- computations
  for (const c of by('create_page_computation')) {
    const page = pageFor(c);
    const a = c.args;
    const item = (str(a, 'p_computation_item') ?? '').toUpperCase();
    const apexType = (str(a, 'p_computation_type') ?? '').toUpperCase();
    const e = add(new Entry('computation', pageNum(c), item || '(no item)', apexType || '(none)', null));
    if (!page) {
      e.notMapped('its page was not imported');
      continue;
    }
    if (!isUpperName(item)) {
      e.notMapped('no item');
      continue;
    }
    const comp = sourceComputation(item, apexType, str(a, 'p_computation') ?? '', a.p_computation_language, e);
    if (!comp) continue;
    const pointCode = (str(a, 'p_computation_point') ?? 'BEFORE_HEADER').toUpperCase();
    comp.point = pointCode === 'AFTER_SUBMIT' ? 'after_submit' : 'before_header';
    if (!['AFTER_SUBMIT', 'BEFORE_HEADER'].includes(pointCode)) e.note(`point ${pointCode} became ${comp.point}`);
    comp.seq = int(num(a, 'p_computation_sequence'), 10);
    Object.assign(comp, condition(str(a, 'p_compute_when_type'), str(a, 'p_compute_when'), str(a, 'p_compute_when_text'), e));
    comp.authz = authz(a, e);
    e.target = comp.type;
    page.computations.push(comp);
  }

  // ---- branches
  for (const c of by('create_page_branch')) {
    const page = pageFor(c);
    const a = c.args;
    const name = str(a, 'p_branch_name') ?? 'Branch';
    const apexType = (str(a, 'p_branch_type') ?? 'REDIRECT_URL').toUpperCase();
    const e = add(new Entry('branch', pageNum(c), name, apexType, 'page'));
    if (!page) {
      e.notMapped('its page was not imported');
      continue;
    }
    const pointCode = (str(a, 'p_branch_point') ?? 'AFTER_PROCESSING').toUpperCase();
    const point = pointCode === 'BEFORE_HEADER' ? 'before_header' : 'after_processing';
    if (!['BEFORE_HEADER', 'AFTER_PROCESSING'].includes(pointCode)) e.note(`branch point ${pointCode} became after processing`);
    const row: any = {
      name,
      seq: int(num(a, 'p_branch_sequence'), 10),
      point,
      when_button: point === 'after_processing' ? buttonRef(a, 'p_branch_when_button_id') : null,
      target_type: 'page',
      target_page: null,
      target_items: {},
      target_url: null,
      target_function: null,
      target_app: null,
      authz: authz(a, e),
      build_option: null,
    };
    const action = str(a, 'p_branch_action') ?? '';
    if (/FUNCTION_RETURNING_(URL|PAGE)/.test(apexType)) {
      row.target_type = 'function';
      row.target_function = action;
      e.target = 'function';
      e.plsql();
      e.note('pgkiln\'s function returns a path inside the application (a page number, or 12?view=month), not an f?p URL');
      if (!action.trim()) {
        e.notMapped('no function body found');
        continue;
      }
    } else {
      const fp = parseFp(action);
      const target = fp ? pageNo(fp.page) : /^\s*\d+\s*$/.test(action) ? Number(action) : pageNo(action.trim() || null);
      if (!target || target < 1) {
        e.notMapped(`a target pgkiln cannot follow (${action || 'none'})`);
        continue;
      }
      row.target_page = target;
      if (fp) row.target_items = lowerHashes(fp.items);
    }
    Object.assign(row, condition(str(a, 'p_branch_condition_type'), str(a, 'p_branch_condition'), str(a, 'p_branch_condition_text'), e));
    page.branches.push(row);
  }

  // ---- dynamic actions: one pgkiln row per APEX action, with its event's settings
  const daActions = new Map<string, ApexCall[]>();
  for (const c of by('create_page_da_action')) {
    const ev = ref(c.args, 'p_event_id');
    if (ev) daActions.set(ev, [...(daActions.get(ev) ?? []), c]);
  }
  for (const c of by('create_page_da_event')) {
    const page = pageFor(c);
    const a = c.args;
    const name = str(a, 'p_name') ?? 'Dynamic action';
    const bind = (str(a, 'p_bind_event_type') ?? '').toLowerCase();
    const actions = (daActions.get(ref(a, 'p_id') ?? '') ?? []).sort((x, y) => (num(x.args, 'p_action_sequence') ?? 0) - (num(y.args, 'p_action_sequence') ?? 0));
    const e = add(new Entry('dynamic_action', pageNum(c), name, `${bind || '(no event)'}: ${actions.map((x) => str(x.args, 'p_action') ?? '?').join(', ') || 'no actions'}`, null));
    if (!page) {
      e.notMapped('its page was not imported');
      continue;
    }
    const event = DA_EVENTS[bind];
    if (!event) {
      e.notMapped(`event ${bind || '(none)'} is not mapped`);
      continue;
    }
    // what triggers it
    const tType = (str(a, 'p_triggering_element_type') ?? '').toUpperCase();
    let trigger: string | null = null;
    if (event === 'custom') trigger = str(a, 'p_bind_event_type_custom');
    else if (tType === 'ITEM' || tType === 'COLUMN') trigger = (str(a, 'p_triggering_element') ?? '').toUpperCase().split(',').map((x) => x.trim()).filter(isUpperName).join(',') || null;
    else if (tType === 'BUTTON') trigger = buttonRef(a, 'p_triggering_button_id');
    else if (tType === 'REGION') {
      const r = regionDoc.get(ref(a, 'p_triggering_region_id') ?? '');
      trigger = r ? r.row.static_id : null;
    } else if (tType === 'JQUERY_SELECTOR' || tType === 'JAVASCRIPT_EXPRESSION') {
      e.notMapped(`a ${tType === 'JQUERY_SELECTOR' ? 'jQuery selector' : 'JavaScript expression'} trigger is not mapped: trigger it by item, button or region names`);
      continue;
    }
    if (!trigger && !['load', 'before_submit', 'resize', 'scroll', 'page_unload', 'dialog_closed'].includes(event)) {
      e.notMapped('its triggering element was not found');
      continue;
    }
    const cType = (str(a, 'p_triggering_condition_type') ?? '').toUpperCase();
    const cMap = cType ? DA_CONDITIONS[cType] : null;
    if (cType && !cMap) e.note(`client-side condition ${cType} is not carried over (pgkiln has no JavaScript expressions: use execute_javascript with a registered function)`);
    const sCond = condition(str(a, 'p_display_when_type'), str(a, 'p_display_when_cond'), str(a, 'p_display_when_cond2'), e);
    const targets: string[] = [];
    const rows: any[] = [];
    let n = 0;
    for (const x of actions) {
      const xa = x.args;
      const act = (str(xa, 'p_action') ?? '').toUpperCase();
      let action = DA_ACTIONS[act];
      const falseBranch = /^false$/i.test(str(xa, 'p_event_result') ?? 'TRUE');
      if (!action) {
        e.note(`action ${act} is not mapped${act === 'NATIVE_JAVASCRIPT_CODE' ? ' (inline JavaScript: register a function in a static application file and use execute_javascript)' : ''}`);
        continue;
      }
      if (falseBranch && !cMap) {
        e.note(`the false action ${act} is left out: without a condition it never runs`);
        continue;
      }
      const affType = (str(xa, 'p_affected_elements_type') ?? '').toUpperCase();
      let affectedItems: string | null = null;
      let affectedRegion: number | null = null;
      if (affType === 'ITEM') affectedItems = (str(xa, 'p_affected_elements') ?? '').toUpperCase().split(',').map((s) => s.trim()).filter(isUpperName).join(',') || null;
      else if (affType === 'TRIGGERING_ELEMENT' && (tType === 'ITEM' || tType === 'COLUMN')) affectedItems = trigger;
      else if (affType === 'REGION') affectedRegion = regionId(ref(xa, 'p_affected_region_id'));
      else if (affType === 'BUTTON') affectedItems = buttonRef(xa, 'p_affected_button_id');
      else if (affType && affType !== 'TRIGGERING_ELEMENT') e.note(`affected elements ${affType} of ${act} are not carried over`);
      const at = (k: number) => attributeAt(xa, act, k);
      let code: string | null = null;
      let message: string | null = null;
      let itemsToSubmit: string | null = null;
      let css: string | null = null;
      if (act === 'NATIVE_SET_VALUE') {
        const how = (at(1) ?? 'STATIC_ASSIGNMENT').toUpperCase();
        if (how === 'STATIC_ASSIGNMENT') code = `select ${sqlString(at(2) ?? '')}`;
        else if (how === 'SQL_STATEMENT') {
          code = e.oracle(at(3));
        } else if (how === 'PLSQL_EXPRESSION' || how === 'FUNCTION_BODY') {
          code = how === 'PLSQL_EXPRESSION' ? `select ${at(4) ?? 'null'}` : at(6);
          e.plsql();
        } else {
          e.note(`set value by ${how} is not mapped`);
          continue;
        }
        itemsToSubmit = at(7);
      } else if (act === 'NATIVE_EXECUTE_PLSQL_CODE') {
        code = at(1);
        itemsToSubmit = at(2);
        e.plsql();
        if (at(3)) e.note('items to return: return columns named like the items from the SQL instead');
      } else if (act === 'NATIVE_REFRESH') {
        if (affType === 'ITEM') action = 'refresh_item';
      } else if (act === 'NATIVE_ALERT' || act === 'NATIVE_CONFIRM') message = at(1);
      else if (act === 'NATIVE_ADD_CLASS' || act === 'NATIVE_REMOVE_CLASS') {
        css = (at(1) ?? '').split(/\s+/).filter((x) => /^[a-z][a-z0-9_-]{0,39}$/.test(x)).slice(0, 5).join(' ') || null;
        if (!css) {
          e.note(`${act} without usable class names is left out`);
          continue;
        }
      }
      if (['set_value', 'execute_sql'].includes(action) && !code) {
        e.note(`${act} without code is left out`);
        continue;
      }
      if (itemsToSubmit) itemsToSubmit = itemsToSubmit.toUpperCase().split(',').map((s) => s.trim()).filter(isUpperName).join(',') || null;
      if (yes(xa, 'p_execute_on_page_init') && event !== 'load') e.note(`"fire on initialization" of ${act} is not carried over: add a page load dynamic action`);
      n++;
      targets.push(action);
      rows.push({
        name,
        seq: int(num(a, 'p_event_sequence'), 10) * 100 + n,
        event,
        trigger_element: event === 'load' || event === 'before_submit' ? null : trigger,
        condition_type: cMap ? (falseBranch ? cMap[1] : cMap[0]) : null,
        condition_value: cMap ? str(a, 'p_triggering_expression') : null,
        action,
        affected_items: affectedItems,
        affected_region_id: affectedRegion,
        code,
        items_to_submit: itemsToSubmit,
        message,
        css_classes: css,
        config: null,
        authz: authz(a, e),
        build_option: null,
        server_condition_type: sCond.condition_type,
        server_condition_expr: sCond.condition_expr,
        server_condition_value: sCond.condition_value,
      });
    }
    if (!n) {
      e.notMapped('none of its actions is mapped');
      continue;
    }
    // one row per action: "Name (1)", "Name (2)" when there are several
    rows.forEach((r, i) => page.dynamic_actions.push({ ...r, name: rows.length > 1 ? `${name} (${i + 1})` : name }));
    e.target = [...new Set(targets)].join(', ');
  }

  // ---- (sprint 190) faceted search: the report region it filters
  for (const f of facetRegions) {
    const target = f.filtered ? regionDoc.get(f.filtered)?.row : null;
    if (target?.type === 'classic_report') {
      // pgkiln's facets filter an interactive report: the classic report it filters becomes one
      target.type = 'report';
      f.e.note(`the classic report it filters (${target.title}) became an interactive report: pgkiln's facets filter interactive reports`);
    }
    if (target && target.type === 'report') f.row.config.report = target.id;
    else {
      f.row.type = 'static';
      f.row.source = `<p>APEX faceted search ${escapeHtml(f.row.title)}: the region it filters ${target ? `(${escapeHtml(target.type)}) is not a report` : 'was not imported'}.</p>`;
      f.row.config = {};
      f.e.notMapped(target ? `it filters a ${target.type} region: pgkiln facets filter a report region` : 'the region it filters was not imported');
    }
    if (f.row.type === 'facets' && !f.row.config.facets.length) f.e.note('no facet of it was mapped');
  }

  // ---- (sprint 190) charts: create_jet_chart (type) and its series (source, label, value, aggregate)
  const CHART_KINDS: Record<string, string> = {
    pie: 'pie', donut: 'donut', line: 'line', area: 'area', linewitharea: 'area', scatter: 'scatter', bubble: 'bubble',
    funnel: 'funnel', pyramid: 'pyramid', polar: 'polar', radar: 'radar', dial: 'gauge', range: 'range', boxplot: 'boxplot',
    stock: 'stock', gantt: 'gantt', combo: 'combo',
  };
  for (const ch of by('create_jet_chart')) {
    const ca = ch.args;
    const regionId = ref(ca, 'p_region_id');
    const region = regionId ? regionDoc.get(regionId) : null;
    const apex = regionId ? regionApex.get(regionId) : null;
    if (!region || !apex || region.row.type !== 'chart') continue;
    const e = apex.e;
    const t = (str(ca, 'p_chart_type') ?? 'bar').toLowerCase();
    let kind = CHART_KINDS[t];
    if (t === 'bar') kind = (str(ca, 'p_stack') ?? 'off') === 'on' ? 'stacked' : (str(ca, 'p_orientation') ?? '').toLowerCase() === 'horizontal' ? 'bar' : 'column';
    if (!kind) {
      kind = 'bar';
      e.note(`chart type ${t} became a bar chart`);
    }
    const series = by('create_jet_chart_series').filter((x) => ref(x.args, 'p_chart_id') === ref(ca, 'p_id')).sort((x, y) => (num(x.args, 'p_seq') ?? 0) - (num(y.args, 'p_seq') ?? 0));
    /** one series as a SELECT of label and value; group: the FROM part, to put several series of one source together */
    const one = (sa: Args, i: number) => {
      const label = str(sa, 'p_items_label_column_name');
      const value = str(sa, 'p_items_value_column_name');
      const agg = (str(sa, 'p_aggregate_function') ?? '').toUpperCase();
      const st = (str(sa, 'p_data_source_type') ?? 'REGION_SOURCE').toUpperCase();
      let from: string | null = null;
      if (st === 'TABLE') {
        const tbl = qualified(str(sa, 'p_query_table'), str(sa, 'p_query_owner'));
        const where = e.oracle(str(sa, 'p_query_where'));
        from = tbl ? `${tbl}${where ? ` where ${where}` : ''}` : null;
      } else if (st === 'SQL') {
        const q = e.oracle(str(sa, 'p_data_source'));
        from = q ? `(${stripSemi(q)}) q` : null;
      } else {
        const q = apex.sql();
        from = q ? `(${q}) q` : null;
      }
      if (!from || !label) return null;
      const name = (str(sa, 'p_name') ?? `Series ${i + 1}`).replace(/"/g, '');
      const v = agg && ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'].includes(agg)
        ? `${agg.toLowerCase()}(${value ? ident(columnOf(value, e)) : '*'})`
        : value ? ident(columnOf(value, e)) : null;
      if (!v) return null;
      return { from, label: ident(columnOf(label, e)), value: `${v} as "${name}"`, grouped: !!agg };
    };
    const parts = series.map((x, i) => one(x.args, i)).filter((x): x is NonNullable<typeof x> => !!x);
    if (!parts.length) {
      region.row.type = 'static';
      const src = str(apex.a, 'p_plug_source');
      region.row.source = `<p>APEX chart ${escapeHtml(region.row.title)}: no series with a source, label and value.</p>${src ? `<pre>${escapeHtml(src)}</pre>` : ''}`;
      e.notMapped('no series with a source, label and value');
      continue;
    }
    const first = parts[0];
    const same = parts.filter((x) => x.from === first.from && x.label === first.label && x.grouped === first.grouped);
    if (same.length < series.length) e.note(`${series.length - same.length} of its ${series.length} series ${series.length - same.length === 1 ? 'has' : 'have'} another source or label and ${series.length - same.length === 1 ? 'was' : 'were'} left out`);
    region.row.source = `select ${first.label}, ${same.map((x) => x.value).join(', ')}\n  from ${first.from}${first.grouped ? `\n group by ${first.label}` : ''}\n order by 1`;
    region.row.config = { ...(region.row.config ?? {}), kind };
    e.target = `chart ${kind}`;
  }

  // a chart region without a create_jet_chart (or none of whose series could be read): a note instead
  for (const [rid, r] of regionDoc) {
    if (r.row.type !== 'chart' || r.row.source) continue;
    r.row.type = 'static';
    r.row.template = 'plain';
    const src = str(regionApex.get(rid)?.a ?? {}, 'p_plug_source');
    r.row.source = `<p>APEX chart ${escapeHtml(r.row.title)}: no chart definition with series was found.</p>${src ? `<pre>${escapeHtml(src)}</pre>` : ''}`;
    regionApex.get(rid)?.e.notMapped('no chart definition with series was found');
  }

  // ---- (sprint 190) lists that list regions show (the navigation menu's list is the navigation, below)
  const lists: any[] = [];
  const listEntries: any[] = [];
  const allLists = by('create_list');
  const listAbove = (x: ApexCall) => allLists.filter((l) => l.line < x.line).reduce<ApexCall | null>((m, l) => (!m || l.line > m.line ? l : m), null);
  let nextListEntry = 1;
  for (const l of by('create_list')) {
    const lid = ref(l.args, 'p_id');
    if (!lid || !usedLists.has(lid)) continue;
    const name = listName(l);
    const dynamic = /SQL|PLSQL|FUNCTION/i.test(str(l.args, 'p_list_type') ?? '');
    lists.push({ name, type: 'static', description: dynamic ? 'Imported from APEX: a dynamic list, rebuild its query by hand' : null });
    const ids = new Map<string, number>();
    const mine: any[] = [];
    // an item without p_list_id belongs to the list written just before it (the export writes a list and its items together)
    for (const c of by('create_list_item').filter((x) => ref(x.args, 'p_list_id') === lid || (!ref(x.args, 'p_list_id') && listAbove(x) === l))) {
      const a = c.args;
      const label = str(a, 'p_list_item_link_text') ?? 'Entry';
      const e = add(new Entry('navigation', null, `${name}: ${label}`, 'list entry', 'list_entry'));
      const target = str(a, 'p_list_item_link_target');
      const fp = parseFp(target);
      const page = fp ? pageNo(fp.page) : null;
      const id = nextListEntry++;
      const cid = ref(a, 'p_id');
      if (cid) ids.set(cid, id);
      let url: string | null = null;
      if (!page && target) {
        if (/^https?:\/\//i.test(target)) url = target;
        else e.note(`its link ${target} is not a page of the application: the entry has no target`);
      }
      mine.push({ id, list_name: name, parent_id: ref(a, 'p_parent_list_item_id'), seq: int(num(a, 'p_list_item_display_sequence'), 10), label,
        target_page: page, target_items: fp?.items ?? {}, target_url: url, description: str(a, 'p_list_text_01') ?? null, authz: authz(a, e) });
    }
    for (const x of mine) x.parent_id = x.parent_id ? ids.get(x.parent_id) ?? null : null;
    if (dynamic) add(new Entry('navigation', null, name, 'dynamic list', 'list')).notMapped('a dynamic list (a query): it became an empty static list, rebuild its query by hand');
    listEntries.push(...mine);
  }

  // ---- navigation menu: the list the user interface names, else one called "Navigation Menu"
  const ui = by('create_user_interface')[0];
  const navListId = ui ? ref(ui.args, 'p_navigation_list_id') : null;
  const navList = (navListId ? comp('create_list', navListId)?.call : null) ?? by('create_list').find((l) => /navigation menu/i.test(str(l.args, 'p_name') ?? ''));
  const nav: any[] = [];
  if (navList) {
    const listId = ref(navList.args, 'p_id');
    const navIds = new Map<string, number>();
    let next = 1;
    // (sprint 190) an item without p_list_id is the list's when that list is the one written just before it
    for (const c of by('create_list_item').filter((x) => ref(x.args, 'p_list_id') === listId || (!ref(x.args, 'p_list_id') && listAbove(x) === navList))) {
      const a = c.args;
      const label = str(a, 'p_list_item_link_text') ?? 'Entry';
      const e = add(new Entry('navigation', null, label, 'list entry', 'nav_entry'));
      const fp = parseFp(str(a, 'p_list_item_link_target'));
      const target = fp ? pageNo(fp.page) : null;
      if (str(a, 'p_list_item_link_target') && !target) e.note(`its link ${str(a, 'p_list_item_link_target')} is not a page of the application: the entry has no target`);
      const id = next++;
      const cid = ref(a, 'p_id');
      if (cid) navIds.set(cid, id);
      nav.push({ id, parent_id: ref(a, 'p_parent_list_item_id'), seq: int(num(a, 'p_list_item_display_sequence'), 10), label, icon: null, target_page: target, authz: authz(a, e), build_option: null });
    }
    for (const x of nav) x.parent_id = x.parent_id ? navIds.get(x.parent_id) ?? null : null;
    // parents first: import_app maps parent ids in order
    nav.sort((x, y) => (x.parent_id === null ? 0 : 1) - (y.parent_id === null ? 0 : 1));
  }

  // ---- the application
  const appEntry = add(new Entry('application', null, appName, str(begin?.args ?? {}, 'p_release') ? `APEX ${str(begin!.args, 'p_release')}` : 'APEX', 'app'));
  const language = (str(fa, 'p_flow_language') ?? 'en').toLowerCase();
  const homeFp = parseFp(str(ui?.args ?? {}, 'p_home_url') ?? str(fa, 'p_home_link'));
  const home = homeFp ? pageNo(homeFp.page) : null;
  const version = str(fa, 'p_flow_version');
  const auth = by('create_authentication').map((x) => str(x.args, 'p_scheme_type') ?? str(x.args, 'p_name')).filter(Boolean);
  appEntry.note(`authentication (${auth.join(', ') || 'APEX'}) became pgkiln's user directory: add the users and their roles under Users and Access control`);
  appEntry.note('themes, templates and template options are not carried over: pgkiln uses its own theme');
  if (!opts.dbRole) appEntry.note('set the application\'s database role (Settings) to a role with the grants the parsing schema had');
  const app: Record<string, unknown> = {
    name: appName,
    alias,
    home_page: home && docPage.has(home) ? home : pages[0]?.page_no ?? 1,
    language: /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(language) ? language : 'en',
    languages: [],
    language_from: 'browser',
    date_format: str(fa, 'p_date_format'),
    timestamp_format: str(fa, 'p_timestamp_format'),
    version: version && version.length <= 40 ? version : null,
    db_role: opts.dbRole ?? null,
    ...APP_DEFAULTS,
  };

  const doc: Doc = {
    format: 'pgkiln/2',
    app,
    lovs,
    authz_schemes: authzSchemes,
    nav,
    pages,
    lists,
    list_entries: listEntries,
  };
  const counts = { mapped: 0, notes: 0, not_mapped: 0, port: 0 };
  for (const e of entries) {
    counts[e.status]++;
    if (e.port) counts.port++;
  }
  return {
    doc,
    report: {
      application: { id: appId, name: appName, alias, release: str(begin?.args ?? {}, 'p_release'), schema },
      entries: entries.map((e) => ({ kind: e.kind, page: e.page, name: e.name, apexType: e.apexType, target: e.target, status: e.status, port: e.port, notes: e.notes })),
      skipped,
      counts,
    },
  };
}

/** A computation from an APEX source, default or computation (null: not mapped, with a note). */
function sourceComputation(item: string, apexType: string, expression: string, language: ApexValue, e: Entry): any | null {
  const t = apexType.toUpperCase();
  const plsqlLang = /plsql/i.test(String(language ?? ''));
  const base = { item_name: item, seq: 10, point: 'before_header', expression, condition_type: null, condition_expr: null, condition_value: null, authz: null, build_option: null };
  switch (t) {
    case 'STATIC':
    case 'STATIC_ASSIGNMENT':
      return { ...base, type: 'static' };
    case 'ITEM':
    case 'ITEM_VALUE': {
      const v = expression.trim().toUpperCase();
      if (!isUpperName(v)) {
        e.note(`computation from item ${expression} is not mapped`);
        return null;
      }
      return { ...base, type: 'item', expression: v };
    }
    case 'QUERY':
    case 'SQL_QUERY':
      return { ...base, type: 'sql_query', expression: stripSemi(e.oracle(expression)) };
    case 'SQL_EXPRESSION':
      return { ...base, type: 'sql_expression', expression: e.oracle(expression) };
    case 'EXPRESSION':
      if (plsqlLang) {
        e.plsql();
        return { ...base, type: 'sql_expression' };
      }
      return { ...base, type: 'sql_expression', expression: e.oracle(expression) };
    case 'PLSQL_EXPRESSION':
      e.plsql();
      return { ...base, type: 'sql_expression' };
    case 'FUNCTION_BODY':
    case 'PLSQL_FUNCTION_BODY':
      e.plsql();
      return { ...base, type: 'function_body' };
    default:
      if (e.kind === 'computation') e.notMapped(`computation type ${t || '(none)'} is not mapped`);
      else e.note(`${t} source or default is not carried over`);
      return null;
  }
}

const stripSemi = (s: string) => s.trim().replace(/;\s*$/, '');
const stripTags = (s: string) => s.replace(/<[^>]*>/g, '').trim();

/** #EMPNO# → #empno# in link values (pgkiln names report columns as PostgreSQL does) */
function lowerHashes(items: Record<string, string>) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(items)) if (isUpperName(k)) out[k] = v.replace(/#([A-Z0-9_$]+)#/g, (_, c) => `#${c.toLowerCase()}#`);
  return out;
}

/** A static list as pgkiln's STATIC: text, or a VALUES query when a value holds a comma or a semicolon. */
function staticLovQuery(values: [string, string][]) {
  if (values.every(([d, r]) => !/[,;]/.test(d + r))) return `STATIC:${values.map(([d, r]) => (d === r ? d : `${d};${r}`)).join(',')}`;
  return `select d, r from (values ${values.map(([d, r], i) => `(${sqlString(d)}, ${sqlString(r)}, ${i})`).join(', ')}) v(d, r, n) order by n`;
}
/** APEX's STATIC:Display;Return,… (and STATIC2:) as pgkiln's */
function staticLovText(body: string) {
  return `STATIC:${body}`;
}

// ------------------------------------------------------------------ input files

/** Largest upload / zip content the importer reads. */
export const MAX_APEX_BYTES = 20 * 1024 * 1024;
const MAX_ZIP_TOTAL = 100 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 5000;

/** The export's SQL text from an uploaded or read file: a .sql file, or a .zip of a split export. */
export async function apexSource(data: Buffer): Promise<string> {
  if (data.length > 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04) {
    const { unzipSync } = await import('fflate');
    let count = 0;
    let declared = 0;
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(new Uint8Array(data), {
        filter: (f) => {
          if (!/\.sql$/i.test(f.name)) return false;
          count++;
          declared += f.originalSize;
          if (count > MAX_ZIP_ENTRIES || declared > MAX_ZIP_TOTAL) throw new Error('too large');
          return true;
        },
      });
    } catch (e) {
      throw new NotAnApexExport((e as Error).message === 'too large' ? 'the zip file holds too much' : 'not a valid zip file');
    }
    if (Object.values(entries).reduce((n, b) => n + b.length, 0) > MAX_ZIP_TOTAL) throw new NotAnApexExport('the zip file holds too much');
    const files = new Map(Object.entries(entries).map(([p, b]) => [p, Buffer.from(b).toString('utf8')]));
    if (!files.size) throw new NotAnApexExport('no .sql files in the zip file');
    return joinSplitExport(files);
  }
  return data.toString('utf8');
}

/** The SQL text of a split export directory (all its .sql files, install.sql's order first). */
export async function apexSourceFromDir(dir: string): Promise<string> {
  const { readDir } = await import('./cli/files.ts');
  const files = new Map([...readDir(dir)].filter(([p]) => /\.sql$/i.test(p)).map(([p, b]) => [p, b.toString('utf8')]));
  if (!files.size) throw new NotAnApexExport(`no .sql files in ${dir}`);
  return joinSplitExport(files);
}

// ------------------------------------------------------------------ the report as text

const KIND_LABEL: Record<ReportKind, string> = {
  application: 'application',
  page: 'page',
  region: 'region',
  item: 'item',
  button: 'button',
  validation: 'validation',
  process: 'process',
  computation: 'computation',
  branch: 'branch',
  dynamic_action: 'dynamic action',
  lov: 'list of values',
  authorization: 'authorization scheme',
  navigation: 'navigation entry',
};
export const kindLabel = (k: ReportKind) => KIND_LABEL[k];

/** The report for a terminal: what is not mapped first, then what has notes, then a count of the rest. */
export function reportText(report: ApexReport, { all = false } = {}) {
  const { application: a, counts } = report;
  const line = (e: ReportEntry) =>
    `  ${e.page !== null ? `page ${e.page}`.padEnd(9) : ''.padEnd(9)} ${KIND_LABEL[e.kind]} "${e.name}" (${e.apexType})${e.target ? ` → ${e.target}` : ''}${e.port ? '  [needs porting]' : ''}\n${e.notes.map((n) => `             - ${n}\n`).join('')}`;
  let out = `APEX application ${a.id ?? ''} "${a.name}"${a.release ? ` (APEX ${a.release})` : ''} → ${a.alias}\n`;
  out += `${counts.mapped} mapped, ${counts.notes} mapped with notes, ${counts.not_mapped} not mapped; ${counts.port} need porting (PL/SQL or Oracle SQL)\n`;
  const group = (status: ReportStatus, title: string) => {
    const rows = report.entries.filter((e) => e.status === status);
    if (rows.length) out += `\n${title}\n${rows.map(line).join('')}`;
  };
  group('not_mapped', 'NOT MAPPED');
  group('notes', 'MAPPED WITH NOTES');
  if (all) group('mapped', 'MAPPED');
  const skipped = Object.entries(report.skipped).sort(([x], [y]) => (x < y ? -1 : 1));
  if (skipped.length) out += `\nNOT READ (APEX calls without a pgkiln equivalent here)\n${skipped.map(([m, n]) => `  ${m} ×${n}\n`).join('')}`;
  return out;
}
