// (sprint 246, MG-19, migration 203) The JSON form region (json_form): a form drawn from a JSON schema.
//
// The region's Source is a SELECT, run as the application's role, that returns one row: the JSON schema (a column
// named "schema", else the first) and the current answers (a column named "value", else the second). The schema's
// properties become fields (text, textarea, number, integer, date, time, date and time, e-mail, URL, select list,
// radio group, checkbox group, yes/no, repeating rows and groups of fields) in the order of its x-order; required,
// enum / oneOf, minimum / maximum, minLength / maxLength, minItems / maxItems, readOnly and default are honoured.
//
// The answers post as one JSON value into a page item (the region's {"item": "P3_ANSWERS"}, a hidden item), checked
// on the server against the schema before any process runs: a value outside an enum, of the wrong type, out of range
// or missing is refused and shown at its field, like an item validation. Everything the schema says (titles,
// descriptions, labels of an enum) is text: escaped by html``. Without JavaScript the form works as is, repeating rows
// included (a few empty rows under the others, a Remove box per row); app.js adds Add and Remove buttons.
import { applyBinds } from '../binds.ts';
import { savepoint } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import type { Region } from '../metadata.ts';
import { bindValues, publicError, stripSemicolon, type PageContext } from './context.ts';

/** The kinds of field a schema property becomes. */
export type JfKind = 'text' | 'textarea' | 'number' | 'integer' | 'date' | 'time' | 'datetime' | 'email' | 'url'
  | 'select' | 'radio' | 'checkboxes' | 'boolean' | 'rows' | 'group' | 'other';

export interface JfOption { value: string | number | boolean; label: string }

export interface JfField {
  key: string;
  title: string;
  description: string | null;
  placeholder: string | null;
  kind: JfKind;
  required: boolean;
  readOnly: boolean;
  /** a number of the field's position in the schema: ids of its inputs */
  uid: number;
  options?: JfOption[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  default?: unknown;
  /** a group's fields, or the fields of each repeated row */
  fields?: JfField[];
}

/** Limits that keep a schema (the developer's) and a submit (the user's) bounded. */
const MAX_FIELDS = 300;
const MAX_DEPTH = 4;
const MAX_OPTIONS = 500;
const MAX_ROWS = 500;
/** a text answer without a maxLength of its own */
const MAX_TEXT = 20000;
/** the empty rows a repeating field shows without JavaScript (the region's {"empty_rows": n}) */
const EMPTY_ROWS = 2;

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 1000): string | null => (typeof v === 'string' && v.trim() ? v.slice(0, max) : null);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const count = (v: unknown): number | undefined => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : undefined);
const primitive = (v: unknown): v is string | number | boolean => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean';

/** The choices of a property: oneOf/anyOf with const and title, else enum with x-enum-labels (or enumNames). */
function optionsOf(s: Record<string, any>): JfOption[] | undefined {
  const list = Array.isArray(s.oneOf) ? s.oneOf : Array.isArray(s.anyOf) ? s.anyOf : null;
  if (list && list.some((o: unknown) => isObj(o) && 'const' in o)) {
    return list.filter((o: unknown): o is Record<string, any> => isObj(o) && primitive(o.const)).slice(0, MAX_OPTIONS)
      .map((o: Record<string, any>) => ({ value: o.const, label: str(o.title, 200) ?? String(o.const) }));
  }
  if (Array.isArray(s.enum)) {
    const labels = Array.isArray(s['x-enum-labels']) ? s['x-enum-labels'] : Array.isArray(s.enumNames) ? s.enumNames : [];
    return s.enum.slice(0, MAX_OPTIONS).flatMap((v: unknown, i: number) => (primitive(v) ? [{ value: v, label: str(labels[i], 200) ?? String(v) }] : []));
  }
  return undefined;
}

/** The type a property declares (the first non-null of a list such as ["string", "null"]). */
function typeOf(s: Record<string, any>): string | null {
  if (typeof s.type === 'string') return s.type;
  if (Array.isArray(s.type)) return s.type.find((t: unknown) => typeof t === 'string' && t !== 'null') ?? null;
  return null;
}

/** The order of an object's properties: its x-order (a list of names), then each property's numeric x-order, then as written. */
function orderedKeys(s: Record<string, any>): string[] {
  const props = isObj(s.properties) ? s.properties : {};
  const keys = Object.keys(props);
  const listed = Array.isArray(s['x-order']) ? s['x-order'].filter((k: unknown): k is string => typeof k === 'string' && k in props) : [];
  const rank = (k: string) => {
    const i = listed.indexOf(k);
    if (i >= 0) return i;
    const own = isObj(props[k]) ? num(props[k]['x-order']) : undefined;
    return own !== undefined ? listed.length + own : Number.MAX_SAFE_INTEGER;
  };
  return keys.map((k, i) => ({ k, i })).sort((a, b) => rank(a.k) - rank(b.k) || a.i - b.i).map((x) => x.k);
}

/** A JSON schema (an object with properties) as the form's fields. Anything else gives no fields. */
export function parseSchema(schema: unknown): JfField[] {
  let uid = 0;
  const walk = (s: Record<string, any>, depth: number, inRow: boolean): JfField[] => {
    const props = isObj(s.properties) ? s.properties : {};
    const required = new Set(Array.isArray(s.required) ? s.required.filter((k: unknown) => typeof k === 'string') : []);
    const out: JfField[] = [];
    for (const key of orderedKeys(s)) {
      if (uid >= MAX_FIELDS || key.length > 200) break;
      const p = props[key];
      if (!isObj(p)) continue;
      const f: JfField = {
        key, uid: uid++, kind: 'other',
        title: str(p.title, 300) ?? key,
        description: str(p.description, 2000),
        placeholder: str(p['x-placeholder'], 200),
        required: required.has(key),
        readOnly: p.readOnly === true,
        minimum: num(p.minimum), maximum: num(p.maximum), exclusiveMinimum: num(p.exclusiveMinimum), exclusiveMaximum: num(p.exclusiveMaximum),
        minLength: count(p.minLength), maxLength: count(p.maxLength), minItems: count(p.minItems), maxItems: count(p.maxItems),
        default: p.default,
      };
      const type = typeOf(p);
      const widget = typeof p['x-widget'] === 'string' ? p['x-widget'] : null;
      const options = optionsOf(p);
      if (type === 'array') {
        const items = isObj(p.items) ? p.items : {};
        const choices = optionsOf(items);
        if (choices) Object.assign(f, { kind: 'checkboxes', options: choices });
        else if (typeOf(items) === 'object' && !inRow && depth < MAX_DEPTH) Object.assign(f, { kind: 'rows', fields: walk(items, depth + 1, true) });
      } else if (type === 'object') {
        if (depth < MAX_DEPTH) Object.assign(f, { kind: 'group', fields: walk(p, depth + 1, inRow) });
      } else if (options && (type === null || ['string', 'number', 'integer', 'boolean'].includes(type))) {
        Object.assign(f, { kind: widget === 'radio' ? 'radio' : 'select', options });
      } else if (type === 'boolean') f.kind = 'boolean';
      else if (type === 'integer') f.kind = 'integer';
      else if (type === 'number') f.kind = 'number';
      else if (type === 'string') {
        const format = typeof p.format === 'string' ? p.format : '';
        f.kind = format === 'date' ? 'date' : format === 'time' ? 'time' : format === 'date-time' ? 'datetime' : format === 'email' ? 'email'
          : format === 'uri' || format === 'url' ? 'url' : widget === 'textarea' || format === 'textarea' ? 'textarea' : 'text';
      }
      out.push(f);
    }
    return out;
  };
  return isObj(schema) ? walk(schema, 0, false) : [];
}

// ---------------------------------------------------------------- the region's source and target

/** A column value as JSON: jsonb/json arrive parsed, text is parsed here (a value that isn't JSON is left out). */
function asJson(v: unknown): unknown {
  if (typeof v !== 'string') return v ?? undefined;
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
}

/** The schema and the current answers: one row of the region's SELECT, as the application's role (the page's transaction). */
export async function loadJsonForm(ctx: PageContext, r: Region): Promise<{ schema: unknown; value: unknown; hasValue: boolean }> {
  const c = ctx.client!;
  const sql = `select * from (\n${stripSemicolon(applyBinds(r.source ?? '', bindValues(ctx)))}\n) "__r" limit 1`;
  const res = await savepoint(c, () => c.query(sql));
  const row = res.rows[0] as Record<string, unknown> | undefined;
  if (!row) return { schema: undefined, value: undefined, hasValue: false };
  const names = res.fields.map((f) => f.name);
  const schemaCol = names.includes('schema') ? 'schema' : names[0];
  const valueCol = names.includes('value') ? 'value' : names.find((n) => n !== schemaCol);
  return { schema: asJson(row[schemaCol]), value: valueCol ? asJson(row[valueCol]) : undefined, hasValue: !!valueCol };
}

/**
 * The page item the form writes, when the user may change the answers: the region is shown and not read-only (its
 * Read Only condition, {"read_only": true}), and the item is shown and either a hidden item (written by the server
 * only) or one the user may change. Null: the form is shown read-only and a submit leaves the item alone.
 */
export function jsonFormTarget(ctx: PageContext, r: Region): string | null {
  const name = typeof r.config?.item === 'string' ? r.config.item : null;
  const vis = ctx.vis;
  if (!name || r.config?.read_only === true || !vis || !vis.regions.has(r.id) || vis.readonly?.has(r.id)) return null;
  const item = ctx.page.items.find((i) => i.name === name);
  if (!item || !vis.items.has(name)) return null;
  return item.type === 'hidden' || vis.editable.has(name) ? name : null;
}

// ---------------------------------------------------------------- field names

/** The posted name of a field: jf<region>:<key>/<key>/<row>/<key>, each key URI-encoded (a "/" in a key stays apart). */
const fieldName = (prefix: string, key: string) => `${prefix}${encodeURIComponent(key)}`;
const rootPrefix = (r: Region) => `jf${r.id}:`;
const REMOVE = '#remove';

type Body = Record<string, unknown>;
const posted = (body: Body, name: string): string | undefined => {
  const v = body[name];
  const last = Array.isArray(v) ? v[v.length - 1] : v;
  return typeof last === 'string' ? last : undefined;
};
const postedAll = (body: Body, name: string): string[] => {
  const v = body[name];
  return (Array.isArray(v) ? v : v === undefined ? [] : [v]).filter((x): x is string => typeof x === 'string' && x !== '');
};

// ---------------------------------------------------------------- the answers from a submit

const NUMBER = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** A choice posted as text: the option's own value (a number stays a number), else the text (the check refuses it). */
const choice = (f: JfField, v: string) => f.options?.find((o) => String(o.value) === v)?.value ?? v;

/**
 * The answers a submit posted, as one JSON value built from the schema: only its fields are read (any other posted
 * name is ignored). Text that isn't a number in a number field, or a value outside a list, is kept as typed so the
 * page can show it again with the error; checkJsonForm refuses it. Read-only fields and properties the form can't
 * show keep the current answer.
 */
export function answersFromBody(fields: JfField[], body: Body, prefix: string, current: unknown): Record<string, unknown> {
  const now = isObj(current) ? current : {};
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const name = fieldName(prefix, f.key);
    if (f.readOnly || f.kind === 'other') {
      if (now[f.key] !== undefined) out[f.key] = now[f.key];
      continue;
    }
    switch (f.kind) {
      case 'boolean':
        out[f.key] = posted(body, name) === 'true';
        break;
      case 'checkboxes':
        out[f.key] = [...new Set(postedAll(body, name))].slice(0, MAX_OPTIONS).map((v) => choice(f, v));
        break;
      case 'group':
        out[f.key] = answersFromBody(f.fields!, body, `${name}/`, now[f.key]);
        break;
      case 'rows': {
        // the rows posted (indexes may have gaps: rows removed in the browser); a removed or empty row is left out
        const head = `${name}/`;
        const indexes = new Set<number>();
        for (const k of Object.keys(body)) {
          if (!k.startsWith(head)) continue;
          const m = /^(\d{1,4})\//.exec(k.slice(head.length));
          if (m) indexes.add(Number(m[1]));
          if (indexes.size > MAX_ROWS) break;
        }
        const was = Array.isArray(now[f.key]) ? (now[f.key] as unknown[]) : [];
        const rows: Record<string, unknown>[] = [];
        for (const i of [...indexes].sort((a, b) => a - b)) {
          const rowPrefix = `${head}${i}/`;
          if (posted(body, `${rowPrefix}${REMOVE}`) !== undefined) continue;
          const row = answersFromBody(f.fields!, body, rowPrefix, was[i]);
          if (!rowEmpty(f.fields!, row)) rows.push(row);
        }
        out[f.key] = rows;
        break;
      }
      default: {
        let v = posted(body, name);
        if (v === undefined) break;
        v = f.kind === 'textarea' ? v.replace(/\r\n?/g, '\n') : v.trim();
        if (v === '') break;
        if (f.kind === 'number' || f.kind === 'integer') out[f.key] = NUMBER.test(v) ? Number(v) : v;
        else if (f.kind === 'select' || f.kind === 'radio') out[f.key] = choice(f, v);
        else out[f.key] = v;
      }
    }
  }
  return out;
}

/** A row nobody filled in (the empty rows shown without JavaScript): no text, no choice, no box ticked. */
function rowEmpty(fields: JfField[], row: Record<string, unknown>): boolean {
  return fields.every((f) => {
    if (f.readOnly || f.kind === 'other') return true;
    const v = row[f.key];
    if (f.kind === 'group') return rowEmpty(f.fields!, isObj(v) ? v : {});
    return v === undefined || v === false || (Array.isArray(v) && !v.length);
  });
}

// ---------------------------------------------------------------- the check against the schema

type T = PageContext['locale']['t'];

const validDate = (d: string) => {
  const t = Date.parse(`${d}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d;
};
const TIME = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,6})?)?$/;
const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,255}\.[^\s@<>".]{1,63}$/;
function validUrl(v: string) {
  try {
    const u = new URL(v);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !!u.hostname;
  } catch {
    return false;
  }
}

/**
 * The answers checked against the schema's fields: the error of each field that fails, by its posted name. Only the
 * fields the user can change are checked (read-only ones and properties the form can't show keep what was stored).
 */
export function checkJsonForm(fields: JfField[], value: unknown, prefix: string, t: T, errors: Record<string, string> = {}): Record<string, string> {
  const obj = isObj(value) ? value : {};
  for (const f of fields) {
    if (f.readOnly || f.kind === 'other') continue;
    const name = fieldName(prefix, f.key);
    const label = f.title;
    const fail = (key: string, params: Record<string, string | number> = {}) => {
      errors[name] ??= t(key as never, { label, ...params });
    };
    const v = obj[f.key];
    const missing = v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length && f.kind !== 'group');
    if (missing) {
      if (f.required && f.kind !== 'boolean') fail('error.required');
      else if (f.minItems && (f.kind === 'rows' || f.kind === 'checkboxes')) fail(f.kind === 'rows' ? 'jsonform.min_rows' : 'jsonform.min_items', { min: f.minItems });
      continue;
    }
    switch (f.kind) {
      case 'boolean':
        if (typeof v !== 'boolean') fail('jsonform.wrong_type');
        break;
      case 'number':
      case 'integer':
        if (typeof v !== 'number' || !Number.isFinite(v)) fail('error.not_number');
        else if (f.kind === 'integer' && !Number.isSafeInteger(v)) fail('jsonform.not_integer');
        else if ((f.minimum !== undefined && v < f.minimum) || (f.exclusiveMinimum !== undefined && v <= f.exclusiveMinimum))
          fail('jsonform.too_small', { min: f.minimum ?? f.exclusiveMinimum! });
        else if ((f.maximum !== undefined && v > f.maximum) || (f.exclusiveMaximum !== undefined && v >= f.exclusiveMaximum))
          fail('jsonform.too_large', { max: f.maximum ?? f.exclusiveMaximum! });
        break;
      case 'select':
      case 'radio':
        if (!f.options!.some((o) => o.value === v)) fail('error.lov_value');
        break;
      case 'checkboxes':
        if (!Array.isArray(v) || !v.every((x) => f.options!.some((o) => o.value === x)) || new Set(v).size !== v.length) fail('error.lov_value');
        else if (f.minItems !== undefined && v.length < f.minItems) fail('jsonform.min_items', { min: f.minItems });
        else if (f.maxItems !== undefined && v.length > f.maxItems) fail('jsonform.max_items', { max: f.maxItems });
        break;
      case 'group':
        if (!isObj(v)) fail('jsonform.wrong_type');
        else checkJsonForm(f.fields!, v, `${name}/`, t, errors);
        break;
      case 'rows':
        if (!Array.isArray(v) || v.length > MAX_ROWS || !v.every(isObj)) fail('jsonform.wrong_type');
        else {
          if (f.minItems !== undefined && v.length < f.minItems) fail('jsonform.min_rows', { min: f.minItems });
          else if (f.maxItems !== undefined && v.length > f.maxItems) fail('jsonform.max_rows', { max: f.maxItems });
          v.forEach((row, i) => checkJsonForm(f.fields!, row, `${name}/${i}/`, t, errors));
        }
        break;
      default: {
        if (typeof v !== 'string') {
          fail('jsonform.wrong_type');
          break;
        }
        const max = f.maxLength ?? MAX_TEXT;
        if ([...v].length > max) fail('jsonform.too_long', { max });
        else if (f.minLength !== undefined && [...v].length < f.minLength) fail('jsonform.too_short', { min: f.minLength });
        else if (f.kind === 'date' && !validDate(v)) fail('error.not_date');
        else if (f.kind === 'time' && !TIME.test(v)) fail('jsonform.not_time');
        else if (f.kind === 'datetime' && !(validDate(v.slice(0, 10)) && /^T/.test(v.slice(10)) && TIME.test(v.slice(11)))) fail('jsonform.not_datetime');
        else if (f.kind === 'email' && !EMAIL.test(v)) fail('jsonform.not_email');
        else if (f.kind === 'url' && !validUrl(v)) fail('jsonform.not_url');
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------- submit

/**
 * (submit, after the posted items) Each JSON form the user may change: its answers built from the posted fields and
 * stored in its item as JSON text; the check's errors kept for validate(), which shows them at their fields. The
 * schema is read again (as the application's role), so nothing about the form comes from the browser.
 */
export async function applyJsonForms(ctx: PageContext, body: Body) {
  for (const r of ctx.page.regions) {
    if (r.type !== 'json_form') continue;
    const item = jsonFormTarget(ctx, r);
    if (!item) continue;
    let loaded;
    try {
      loaded = await loadJsonForm(ctx, r);
    } catch (e) {
      (ctx.jsonFormErrors ??= { page: [], items: {} }).page.push(await publicError(ctx, e, `JSON form "${r.title ?? r.id}"`));
      continue;
    }
    const fields = parseSchema(loaded.schema);
    const current = loaded.hasValue ? loaded.value : asJson(ctx.session.state[item]);
    const answers = answersFromBody(fields, body, rootPrefix(r), current);
    ctx.session.state[item] = JSON.stringify(answers);
    const errors = checkJsonForm(fields, answers, rootPrefix(r), ctx.locale.t);
    if (Object.keys(errors).length) Object.assign((ctx.jsonFormErrors ??= { page: [], items: {} }).items, errors);
  }
}

// ---------------------------------------------------------------- rendering

type Values = Record<string, unknown>;

/** The text an answer shows as when the form is read-only. */
function shownValue(ctx: PageContext, f: JfField, v: unknown): string {
  if (v === undefined || v === null || v === '') return '';
  const label = (x: unknown) => f.options?.find((o) => o.value === x)?.label ?? (primitive(x) ? String(x) : JSON.stringify(x));
  if (f.kind === 'boolean') return v === true ? ctx.locale.t('item.yes') : v === false ? ctx.locale.t('item.no') : String(v);
  if (f.kind === 'checkboxes') return Array.isArray(v) ? v.map(label).join(', ') : label(v);
  if (f.kind === 'select' || f.kind === 'radio') return label(v);
  if (f.kind === 'datetime' && typeof v === 'string') return v.replace('T', ' ').slice(0, 16);
  return primitive(v) ? String(v) : JSON.stringify(v);
}

interface RenderState {
  ctx: PageContext;
  r: Region;
  editable: boolean;
  emptyRows: number;
}

/** The id of a field's input: the region, the field's place in the schema and (in a repeated row) the row. */
const idOf = (s: RenderState, f: JfField, row: string) => `jf${s.r.id}_${f.uid}${row}`;

function renderFields(s: RenderState, fields: JfField[], values: Values, prefix: string, row: string): Raw[] {
  return fields.map((f) => renderField(s, f, values[f.key], fieldName(prefix, f.key), row));
}

function renderField(s: RenderState, f: JfField, v: unknown, name: string, row: string): Raw {
  const { ctx } = s;
  const t = ctx.locale.t;
  const id = idOf(s, f, row);
  const error = s.editable ? ctx.errors.items[name] : undefined;
  const editable = s.editable && !f.readOnly && f.kind !== 'other';
  const described = [f.description ? `${id}_help` : '', error ? `${id}_error` : ''].filter(Boolean).join(' ');
  const aria = raw(`${described ? ` aria-describedby="${described}"` : ''}${error ? ' aria-invalid="true"' : ''}${f.required && editable ? ' aria-required="true"' : ''}`);
  const req = f.required && editable ? html`<span class="req" aria-hidden="true">*</span>` : '';
  const help = f.description ? html`<small class="help" id="${id}_help">${f.description}</small>` : '';
  const err = error ? html`<small class="error" id="${id}_error">${error}</small>` : '';
  const cls = (extra = '') => `field jf-field field-jf-${f.kind}${error ? ' has-error' : ''}${editable ? '' : ' readonly'}${extra}`;
  const wide = f.kind === 'textarea' || f.kind === 'rows' || f.kind === 'group' || f.kind === 'checkboxes' ? raw(' data-wide') : '';

  if (f.kind === 'group') {
    const inner = isObj(v) ? v : {};
    return html`<fieldset class="${cls()}"${wide}><legend class="label jf-legend">${f.title}</legend>${help}
      <div class="form-grid">${renderFields(s, f.fields!, inner, `${name}/`, row)}</div>${err}</fieldset>`;
  }
  if (f.kind === 'rows') return renderRows(s, f, v, name, { id, help, err, cls: cls(), wide });

  if (!editable) {
    return html`<div class="${cls()}"${wide}><label class="label" for="${id}">${f.title}</label>
      <div class="display-value" id="${id}">${shownValue(ctx, f, v) || ' '}</div>${help}</div>`;
  }
  const text = v === undefined || v === null ? '' : primitive(v) ? String(v) : JSON.stringify(v);
  const ph = f.placeholder ? html` placeholder="${f.placeholder}"` : '';
  const range = html`${f.minimum !== undefined ? html` min="${f.minimum}"` : ''}${f.maximum !== undefined ? html` max="${f.maximum}"` : ''}`;
  const len = f.maxLength !== undefined ? html` maxlength="${f.maxLength}"` : '';
  let control: Raw;
  let legend = false;
  switch (f.kind) {
    case 'boolean':
      return html`<div class="${cls()}"><span class="label" aria-hidden="true"></span><label class="check"><input type="checkbox" id="${id}" name="${name}" value="true"${
        v === true ? raw(' checked') : ''}${aria}><span>${f.title}</span></label>${help}${err}</div>`;
    case 'textarea':
      control = html`<textarea id="${id}" name="${name}" rows="4"${len}${ph}${aria}>${text}</textarea>`;
      break;
    case 'select':
      control = html`<select id="${id}" name="${name}"${aria}><option value="">${f.placeholder ?? t('lov.none')}</option>${
        f.options!.map((o) => html`<option value="${String(o.value)}"${String(o.value) === text && text !== '' ? raw(' selected') : ''}>${o.label}</option>`)}</select>`;
      break;
    case 'radio':
      legend = true;
      control = html`<div class="radio-group">${f.options!.map((o, i) => html`<label class="check"><input type="radio" id="${i ? `${id}_${i}` : id}" name="${name}" value="${String(o.value)}"${
        String(o.value) === text && text !== '' ? raw(' checked') : ''}${aria}> ${o.label}</label>`)}</div>`;
      break;
    case 'checkboxes': {
      legend = true;
      const chosen = new Set((Array.isArray(v) ? v : []).map((x) => String(x)));
      control = html`<div class="radio-group">${f.options!.map((o, i) => html`<label class="check"><input type="checkbox" id="${i ? `${id}_${i}` : id}" name="${name}" value="${String(o.value)}"${
        chosen.has(String(o.value)) ? raw(' checked') : ''}${aria}> ${o.label}</label>`)}</div>`;
      break;
    }
    case 'number':
    case 'integer':
      control = html`<input type="number" id="${id}" name="${name}" value="${text}" step="${f.kind === 'integer' ? '1' : 'any'}" inputmode="${f.kind === 'integer' ? 'numeric' : 'decimal'}"${range}${ph}${aria}>`;
      break;
    case 'datetime':
      control = html`<input type="datetime-local" id="${id}" name="${name}" value="${text.slice(0, 16)}"${aria}>`;
      break;
    default: {
      const type = ({ date: 'date', time: 'time', email: 'email', url: 'url' } as Record<string, string>)[f.kind] ?? 'text';
      const extra = type === 'email' ? raw(' autocomplete="email" inputmode="email"') : type === 'url' ? raw(' inputmode="url"') : '';
      control = html`<input type="${type}" id="${id}" name="${name}" value="${text}"${len}${extra}${ph}${aria}>`;
    }
  }
  const labelHtml = legend
    ? html`<legend class="label">${f.title}${req}</legend>`
    : html`<label class="label" for="${id}">${f.title}${req}</label>`;
  const tag = legend ? 'fieldset' : 'div';
  return html`${raw(`<${tag}`)} class="${cls()}"${wide}>${labelHtml}${control}${help}${err}${raw(`</${tag}>`)}`;
}

/**
 * Repeating rows: each row a fieldset of its fields with a Remove box (without JavaScript the row goes on submit;
 * app.js makes it a button that takes the row away at once). Without JavaScript a few empty rows follow (inside
 * <noscript>, so they aren't there when app.js offers Add a row, which copies the <template>).
 */
function renderRows(s: RenderState, f: JfField, v: unknown, name: string, parts: { id: string; help: Raw | ''; err: Raw | ''; cls: string; wide: Raw | '' }): Raw {
  const t = s.ctx.locale.t;
  const rows = (Array.isArray(v) ? v : []).filter(isObj);
  const editable = s.editable && !f.readOnly;
  const row = (values: Values, i: string, n: string) => html`<fieldset class="jf-row" data-jf-row>
      <legend class="jf-row-title">${t('jsonform.row', { n })}</legend>
      <div class="form-grid">${renderFields(editable ? s : { ...s, editable: false }, f.fields!, values, `${name}/${i}/`, `_${i}`)}</div>
      ${editable ? html`<div class="jf-row-actions"><label class="check jf-remove"><input type="checkbox" name="${name}/${i}/${REMOVE}" value="1"> ${t('jsonform.remove_row')}</label>
        <button type="button" class="btn btn-sm jf-remove-btn" data-jf-remove hidden>${t('jsonform.remove_row')}</button></div>` : ''}
    </fieldset>`;
  const shown = rows.map((x, i) => row(x, String(i), String(i + 1)));
  if (!editable) {
    return html`<fieldset class="${parts.cls}"${parts.wide}><legend class="label jf-legend">${f.title}</legend>${parts.help}
      <div class="jf-rows">${shown.length ? shown : html`<p class="muted jf-empty">${t('jsonform.no_rows')}</p>`}</div></fieldset>`;
  }
  const blank: Raw[] = [];
  for (let k = 0; k < s.emptyRows; k++) blank.push(row({}, String(rows.length + k), String(rows.length + k + 1)));
  return html`<fieldset class="${parts.cls}"${parts.wide} data-jf-rows data-jf-next="${rows.length + s.emptyRows}" data-jf-row-label="${t('jsonform.row', { n: '{n}' })}"><legend class="label jf-legend">${f.title}${
    f.required ? html`<span class="req" aria-hidden="true">*</span>` : ''}</legend>${parts.help}${parts.err}
    <div class="jf-rows" data-jf-list>${shown}<noscript>${blank}</noscript></div>
    <template data-jf-template>${row({}, '__i__', '__n__')}</template>
    <button type="button" class="btn jf-add" data-jf-add hidden>${t('jsonform.add_row')}</button>
  </fieldset>`;
}

/** The JSON form region: the schema's fields with the current answers (those just posted, after a failed submit). */
export async function renderJsonForm(ctx: PageContext, r: Region): Promise<Raw> {
  let loaded;
  try {
    loaded = await loadJsonForm(ctx, r);
  } catch (e) {
    return html`<div class="alert alert-error" role="alert">${await publicError(ctx, e, `JSON form "${r.title ?? r.id}"`)}</div>`;
  }
  const fields = parseSchema(loaded.schema);
  if (!fields.length) return html`<p class="empty">${ctx.locale.t('jsonform.no_schema')}</p>`;
  const target = jsonFormTarget(ctx, r);
  const name = typeof r.config?.item === 'string' ? r.config.item : null;
  // after a failed submit the answers just posted; else the SELECT's value (a SELECT without one: the item's)
  const fromState = name ? asJson(ctx.session.state[name]) : undefined;
  let value = (ctx.body && target && fromState !== undefined) || !loaded.hasValue ? fromState : loaded.value;
  // a new form (no answers yet) starts with the schema's defaults
  if ((value === undefined || value === null) && target) value = defaults(fields);
  const emptyRows = Number.isInteger(r.config?.empty_rows) ? Math.max(0, Math.min(10, r.config.empty_rows)) : EMPTY_ROWS;
  const s: RenderState = { ctx, r, editable: !!target, emptyRows };
  const intro = isObj(loaded.schema) ? str(loaded.schema.description, 2000) : null;
  return html`<div class="json-form" data-json-form="${r.id}">${intro ? html`<p class="jf-intro">${intro}</p>` : ''}
    <div class="form-grid">${renderFields(s, fields, isObj(value) ? value : {}, rootPrefix(r), '')}</div></div>`;
}

/** The schema's default values (a new form). */
function defaults(fields: JfField[]): Values {
  const out: Values = {};
  for (const f of fields) {
    if (f.kind === 'group') out[f.key] = defaults(f.fields!);
    else if (f.default !== undefined) out[f.key] = f.default;
  }
  return out;
}
