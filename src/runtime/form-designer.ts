import pg from 'pg';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { appTx, savepoint } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import type { Region } from '../metadata.ts';
import { logActivity, saveState } from '../session.ts';
import { checkPageAccess, computeVisibility, Forbidden, isAuthorized } from './authz.ts';
import { publicError, type PageContext } from './context.ts';
import { appDateMask, appDateReader, dateField, heading, lovContains, lovOptions } from './items.ts';
import { RESERVED_SCHEMAS, SOURCE_ID } from './data-reporter.ts';
import { cell, isNumeric, regionUrl } from './report.ts';
import { loadContext, simplePage, txContext, type Req } from './routes.ts';

// Form Designer (sprint 85, migration 106): the application's administrators
// build their own data entry forms in the running application, on the tables
// and views the developer offers in the region's settings:
//
//   config: {
//     "sources": [{"id": "orders", "label": "Orders", "description": "…",
//                  "schema": "sales", "table": "orders", "key": "id",
//                  "columns": [{"name": "customer", "label": "Customer"}, {"name": "status", "lov": "LOV:ORDER_STATUS"}],
//                  "insert": true, "update": true, "delete": false}],
//     "design_authz": "ADMIN",    // who may design forms (an authorization scheme; none: nobody)
//     "page_size": 25
//   }
//
// A user form (meta.user_forms) is a definition (FormDef): the source, its
// fields (an offered column each, with a label, help, required, display and a
// default for new rows), the columns of its row list and what users may do
// (add, change, delete rows: at most what the source allows). Published forms
// are used by everyone who can see the region; drafts only by designers.
//
// Every definition is checked against the source's offered columns that the
// application's role can read before it renders or saves (checkFormDef), so a
// forged definition reaches nothing else. Rows are read and written as the
// application's database role: grants and row level security apply. The
// identifiers are only the developer's schema, table and column names, always
// quoted; values are always parameters. A changed row is detected by a hash
// of its fields' values when the form was opened (lost update detection).

export interface FdColumn {
  name: string;
  label?: string;
  /** a shared list of values ("LOV:NAME") or a static one ("STATIC:…"): the field may be a select list or radio group */
  lov?: string;
}
export interface FdSource {
  id: string;
  label?: string;
  description?: string;
  schema: string;
  table: string;
  /** the column that identifies a row: needed to change and delete rows */
  key?: string;
  columns: FdColumn[];
  insert: boolean;
  update: boolean;
  delete: boolean;
}
export const DISPLAYS = ['auto', 'textarea', 'select', 'radio'] as const;
export type Display = (typeof DISPLAYS)[number];
export interface Field {
  column: string;
  label: string;
  help: string;
  required: boolean;
  display: Display;
  default: string;
}
export interface FormDef {
  source: string;
  fields: Field[];
  list: string[];
  actions: { insert: boolean; update: boolean; delete: boolean };
}

export const FD_LIMITS = { fields: 40, list: 8, label: 80, help: 300, default: 200, value: 4000 };
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE = 10_000;
const TEXT_OIDS = new Set([25, 1043, 1042]);
const DATE = 1082;
const TIMESTAMPS = new Set([1114, 1184]);
const BOOL = 16;
// binary, JSON and other values that no plain field edits
const NOT_EDITABLE = new Set([17, 114, 3802, 142]);

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const clip = (v: unknown, max: number) => str(v).replace(/\0/g, '').trim().slice(0, max);

/** The sources of a region's settings, leaving out malformed entries and pgkiln's and the system's schemas. */
export function fdSourcesOf(r: { config: Record<string, any> }): FdSource[] {
  const list = Array.isArray(r.config.sources) ? r.config.sources : [];
  const out: FdSource[] = [];
  for (const s of list) {
    if (!s || typeof s !== 'object' || !SOURCE_ID.test(str(s.id)) || !str(s.schema) || !str(s.table) || out.some((x) => x.id === s.id)) continue;
    if (RESERVED_SCHEMAS.test(s.schema)) continue;
    const columns: FdColumn[] = (Array.isArray(s.columns) ? s.columns : [])
      .filter((c: any) => c && typeof c === 'object' && str(c.name))
      .map((c: any) => ({ name: c.name, ...(str(c.label) ? { label: c.label } : {}), ...(/^(LOV:[A-Z0-9_]+|STATIC:.+)$/is.test(str(c.lov)) ? { lov: c.lov } : {}) }));
    const key = str(s.key) || undefined;
    out.push({
      id: s.id, label: str(s.label) || undefined, description: str(s.description) || undefined, schema: s.schema, table: s.table, key, columns,
      insert: s.insert !== false, update: !!key && s.update !== false, delete: !!key && s.delete === true,
    });
  }
  return out;
}

/** An offered column that exists and the application's role can read, with its type. */
export interface FdCol {
  name: string;
  label: string;
  type: number;
  lov?: string;
}

const objectSql = (s: FdSource) => `${pg.escapeIdentifier(s.schema)}.${pg.escapeIdentifier(s.table)}`;
const id = pg.escapeIdentifier;

/** The offered columns of a source (and whether its key exists), read as the application's role (no access: an error). */
export async function fdColumns(c: pg.PoolClient, s: FdSource, tr: (x: string) => string = (x) => x) {
  const res = await savepoint(c, () => c.query(`select * from ${objectSql(s)} limit 0`));
  const types = new Map(res.fields.map((f) => [f.name, f.dataTypeID]));
  const cols = new Map<string, FdCol>();
  for (const sc of s.columns)
    if (types.has(sc.name) && !cols.has(sc.name) && !NOT_EDITABLE.has(types.get(sc.name)!))
      cols.set(sc.name, { name: sc.name, label: tr(sc.label || heading(sc.name)), type: types.get(sc.name)!, ...(sc.lov ? { lov: sc.lov } : {}) });
  return { cols, key: s.key && types.has(s.key) ? s.key : null };
}

/** The displays a column allows: a text area for text, a select list or radio group with a list of values. */
export const displaysOf = (col: FdCol): Display[] => ['auto', ...(TEXT_OIDS.has(col.type) && !col.lov ? ['textarea' as const] : []), ...(col.lov ? ['select' as const, 'radio' as const] : [])];

/**
 * A definition with only what the source allows: offered, readable columns,
 * a display the column's type allows, bounded counts and lengths, actions the
 * source allows (changing and deleting need its key). Anything else is dropped.
 */
export function checkFormDef(loose: any, source: FdSource, cols: Map<string, FdCol>, key: string | null): FormDef {
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  const fields: Field[] = [];
  for (const f of arr(loose?.fields)) {
    const col = cols.get(str(f?.column));
    if (!col || fields.some((x) => x.column === col.name) || fields.length >= FD_LIMITS.fields) continue;
    const display = displaysOf(col).includes(f.display) ? (f.display as Display) : col.lov ? 'select' : 'auto';
    fields.push({ column: col.name, label: clip(f.label, FD_LIMITS.label), help: clip(f.help, FD_LIMITS.help), required: f.required === true, display, default: clip(f.default, FD_LIMITS.default) });
  }
  const list = key ? [...new Set(arr(loose?.list).filter((c): c is string => typeof c === 'string' && cols.has(c)))].slice(0, FD_LIMITS.list) : [];
  const a = loose?.actions ?? {};
  const actions = {
    insert: source.insert && a.insert === true && fields.length > 0,
    update: source.update && !!key && a.update === true && fields.length > 0,
    delete: source.delete && !!key && a.delete === true,
  };
  return { source: source.id, fields, list, actions };
}

// ---------------------------------------------------------------- values

/** A field's value as the text a form shows (from the column's value as text). */
function shownValue(type: number, v: string | null) {
  if (v === null) return '';
  if (TIMESTAMPS.has(type)) return v.slice(0, 16).replace(' ', 'T');
  return v;
}

/**
 * A posted value for a column: '' is null; a date in the application's date
 * format (or YYYY-MM-DD) as YYYY-MM-DD; a checkbox as true or false. Other
 * text goes to the database as a parameter, which refuses what its type can't take.
 */
export function postedValue(ctx: PageContext, col: FdCol, raw: unknown): string | null {
  if (col.type === BOOL) return raw === 'true' ? 'true' : 'false';
  const v = str(Array.isArray(raw) ? raw[0] : raw).replace(/\0/g, '').slice(0, FD_LIMITS.value);
  if (!v.trim()) return null;
  if (col.type === DATE) return appDateReader(ctx)(v.trim()) ?? v.trim();
  if (isNumeric(col.type) || TIMESTAMPS.has(col.type)) return v.trim();
  return v;
}

/** The text of a field's values and their hash (lost update detection), in the order of the fields. */
const valuesSql = (def: FormDef) => def.fields.map((f) => `${id(f.column)}::text`).join(', ');
const hashSql = (def: FormDef) => `md5(jsonb_build_array(${valuesSql(def)})::text)`;

// ---------------------------------------------------------------- rendering

interface StoredForm {
  id: number;
  region_id: number;
  name: string;
  description: string | null;
  published: boolean;
  definition: any;
  updated_by: string;
  updated_at: string | Date;
}

export const fdPrefix = (r: { id: number }) => `fd${r.id}_`;

/** May the current user design forms in this region? Only users that pass its authorization scheme. */
export async function mayDesign(ctx: PageContext, r: Region) {
  if (ctx.user === 'nobody') return false;
  const scheme = r.config.design_authz;
  return typeof scheme === 'string' && scheme.trim() !== '' && isAuthorized(ctx, scheme);
}

const pageSize = (r: Region) => {
  const n = Number(r.config.page_size);
  return Number.isInteger(n) && n >= 5 && n <= 200 ? n : DEFAULT_PAGE_SIZE;
};

/** A link to this page with the region's own parameters replaced. */
function url(ctx: PageContext, r: Region, own: [string, string][]) {
  const prefix = fdPrefix(r);
  return regionUrl(ctx, r, (p) => {
    for (const k of [...p.keys()]) if (k.startsWith(prefix)) p.delete(k);
    for (const [k, v] of own) p.append(`${prefix}${k}`, v);
  });
}

const sourceLabel = (ctx: PageContext, s: FdSource) => ctx.locale.tr(s.label || heading(s.table));
const alert = (msg: string | Raw) => html`<div class="alert alert-error" role="alert">${msg}</div>`;

/** A draft kept in the session when saving a row failed: the typed values come back with the message. */
interface Draft {
  form: number;
  row: string;
  values: Record<string, string>;
  error: string;
}
const draftKey = (r: { id: number }) => `__FD_${r.id}`;

/** The Form Designer region: the list of forms, a form's rows, a row's form, or (designers) a form's design. */
export async function renderFormDesigner(ctx: PageContext, r: Region): Promise<Raw> {
  const t = ctx.locale.t;
  const c = ctx.client!;
  const prefix = fdPrefix(r);
  const sources = fdSourcesOf(r);
  if (!sources.length) return html`<p class="empty">${t('formdesigner.no_sources')}</p>`;
  const designer = await mayDesign(ctx, r);
  const draft = (() => {
    const raw = ctx.session.state[draftKey(r)];
    if (!raw) return null;
    delete ctx.session.state[draftKey(r)];
    try { return JSON.parse(raw) as Draft; } catch { return null; }
  })();

  // a form's design (designers only)
  const design = ctx.params.get(`${prefix}design`);
  if (design && designer) {
    if (design === 'new') {
      const source = sources.find((s) => s.id === ctx.params.get(`${prefix}src`)) ?? sources[0];
      return designView(ctx, r, source, undefined);
    }
    const form = await loadForm(ctx, r, Number(design), true);
    const source = form && sources.find((s) => s.id === str(form.definition?.source));
    if (!form || !source) return html`${alert(t('formdesigner.form_not_found'))}${await home(ctx, r, sources, designer)}`;
    return designView(ctx, r, source, form);
  }

  const formId = Number(ctx.params.get(`${prefix}form`));
  if (!Number.isInteger(formId) || formId <= 0) return home(ctx, r, sources, designer);
  const form = await loadForm(ctx, r, formId, designer);
  if (!form) return html`${alert(t('formdesigner.form_not_found'))}${await home(ctx, r, sources, designer)}`;
  const source = sources.find((s) => s.id === str(form.definition?.source));
  if (!source) return html`${alert(t('formdesigner.unknown_source'))}${await home(ctx, r, sources, designer)}`;
  let cols: Map<string, FdCol>, key: string | null;
  try {
    ({ cols, key } = await fdColumns(c, source, ctx.locale.tr));
  } catch (e) {
    return html`${alert(await publicError(ctx, e, `form designer "${r.title ?? r.id}" source ${source.id}`))}${await home(ctx, r, sources, designer)}`;
  }
  const def = checkFormDef(form.definition, source, cols, key);
  const row = ctx.params.get(`${prefix}row`);
  const mine = draft && draft.form === form.id ? draft : null;
  if (row === 'new' || (row === null && !def.list.length && def.actions.insert)) {
    if (!def.actions.insert) return html`${alert(t('formdesigner.not_allowed'))}${await rowsView(ctx, r, form, source, cols, key, def, designer)}`;
    return rowView(ctx, r, form, source, cols, key, def, null, mine && mine.row === '' ? mine : null, designer);
  }
  if (row !== null && key && (def.actions.update || def.actions.delete)) return rowView(ctx, r, form, source, cols, key, def, row.slice(0, 200), mine && mine.row === row ? mine : null, designer);
  return rowsView(ctx, r, form, source, cols, key, def, designer);
}

async function loadForm(ctx: PageContext, r: Region, formId: number, drafts: boolean) {
  if (!Number.isInteger(formId) || formId <= 0 || formId > 2 ** 31 - 1) return undefined;
  const c = ctx.client!;
  const form = (await savepoint(c, () => c.query<StoredForm>('select * from meta.user_forms where id = $1 and region_id = $2', [formId, r.id]))).rows[0];
  return form && (form.published || drafts) ? form : undefined;
}

/** The forms of the region as cards (drafts for designers only), and for designers "New form". */
async function home(ctx: PageContext, r: Region, sources: FdSource[], designer: boolean): Promise<Raw> {
  const t = ctx.locale.t;
  const c = ctx.client!;
  const prefix = fdPrefix(r);
  const forms = (await savepoint(c, () => c.query<StoredForm>(
    `select * from meta.user_forms where region_id = $1 and (published or $2) order by lower(name), id`, [r.id, designer]))).rows;
  let start: Raw | '' = '';
  if (designer) {
    const form = `fdn${r.id}`;
    const keep = [...ctx.params.entries()].filter(([k]) => !k.startsWith(prefix) && !['clear', 'cs'].includes(k));
    ctx.detached.push(html`<form id="${form}" method="get" action="${ctx.base}/${ctx.page.page_no}">${keep.map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}<input type="hidden" name="${prefix}design" value="new"></form>`);
    start = html`<div class="reporter-new fd-new">
      <label class="label" for="${form}_src">${t('formdesigner.new')}</label>
      <div class="reporter-row">
        <select id="${form}_src" name="${prefix}src" form="${form}">${sources.map((s) => html`<option value="${s.id}">${sourceLabel(ctx, s)}</option>`)}</select>
        <button class="btn btn-hot" form="${form}">${t('formdesigner.create')}</button>
      </div></div>`;
  }
  const label = (f: StoredForm) => {
    const s = sources.find((x) => x.id === str(f.definition?.source));
    return s ? sourceLabel(ctx, s) : '';
  };
  return html`<div class="reporter fd">
    ${forms.length
      ? html`<ul class="reporter-cards fd-cards">${forms.map((f) => html`<li><a class="reporter-card" href="${url(ctx, r, [['form', String(f.id)]])}">
          <strong>${f.name}${f.published ? '' : html` <span class="tag">${t('formdesigner.draft')}</span>`}</strong>
          ${f.description ? html`<span class="muted">${f.description}</span>` : ''}
          ${designer ? html`<span class="reporter-card-meta">${label(f)}</span>` : ''}</a>
          ${designer ? html`<a class="fd-design-link" href="${url(ctx, r, [['design', String(f.id)]])}">${icon('settings')} ${t('formdesigner.design')}<span class="sr-only">: ${f.name}</span></a>` : ''}</li>`)}</ul>`
      : html`<p class="empty">${t('formdesigner.no_forms')}</p>`}
    ${start}
  </div>`;
}

const head = (ctx: PageContext, r: Region, form: StoredForm, designer: boolean, back: [string, string][] = []) => {
  const t = ctx.locale.t;
  return html`<div class="reporter-head">
    <a href="${url(ctx, r, back)}">‹ ${back.length ? form.name : t('formdesigner.back')}</a>
    <h3 class="reporter-title">${form.name}${form.published ? '' : html` <span class="tag">${t('formdesigner.draft')}</span>`}</h3>
    ${designer ? html`<a href="${url(ctx, r, [['design', String(form.id)]])}">${icon('settings')} ${t('formdesigner.design')}</a>` : ''}
    ${form.description ? html`<p class="muted reporter-desc">${form.description}</p>` : ''}
  </div>`;
};

/** A form's row list (its list columns, paged) with Add and an Edit link per row. */
async function rowsView(ctx: PageContext, r: Region, form: StoredForm, source: FdSource, cols: Map<string, FdCol>, key: string | null, def: FormDef, designer: boolean): Promise<Raw> {
  const t = ctx.locale.t;
  const c = ctx.client!;
  const prefix = fdPrefix(r);
  const add = def.actions.insert ? html`<p><a class="btn btn-hot" href="${url(ctx, r, [['form', String(form.id)], ['row', 'new']])}">${icon('plus')} ${t('formdesigner.add')}</a></p>` : '';
  if (!def.fields.length) return html`<div class="reporter fd">${head(ctx, r, form, designer)}<p class="empty">${t('formdesigner.nothing')}</p></div>`;
  if (!def.list.length || !key) return html`<div class="reporter fd">${head(ctx, r, form, designer)}${add}</div>`;
  const size = pageSize(r);
  const pg0 = Number(ctx.params.get(`${prefix}pg`));
  const page = Number.isInteger(pg0) && pg0 > 1 ? Math.min(pg0, MAX_PAGE) : 1;
  const editable = def.actions.update || def.actions.delete;
  let table: Raw;
  try {
    const res = await savepoint(c, () => c.query({
      text: `select ${id(key)}::text, ${def.list.map(id).join(', ')} from ${objectSql(source)} order by ${id(key)} desc limit ${size + 1} offset ${(page - 1) * size}`,
      rowMode: 'array',
    }));
    const rows = res.rows.slice(0, size);
    const more = res.rows.length > size;
    const heads = def.list.map((n) => ({ label: def.fields.find((f) => f.column === n)?.label || cols.get(n)!.label, num: isNumeric(cols.get(n)!.type) }));
    const go = (n: number) => url(ctx, r, [['form', String(form.id)], ...(n > 1 ? [['pg', String(n)] as [string, string]] : [])]);
    table = html`<div class="table-wrap"><table class="report report-reflow fd-rows" aria-label="${t('formdesigner.rows', { form: form.name })}">
      <thead><tr>${heads.map((h) => html`<th scope="col" class="${h.num ? 'num' : null}">${h.label}</th>`)}${editable ? html`<th scope="col"><span class="sr-only">${t('formdesigner.edit_row')}</span></th>` : ''}</tr></thead>
      <tbody>${rows.length
        ? rows.map((row: unknown[]) => html`<tr>${row.slice(1).map((v, i) => html`<td class="${heads[i].num ? 'num' : null}" data-label="${heads[i].label}">${cell(v, res.fields[i + 1].dataTypeID, ctx.locale.format)}</td>`)}${editable
            ? html`<td><a href="${url(ctx, r, [['form', String(form.id)], ['row', String(row[0])]])}">${icon('edit')} ${t('formdesigner.edit_row')}</a></td>` : ''}</tr>`)
        : html`<tr><td colspan="${heads.length + (editable ? 1 : 0)}" class="empty">${r.config.empty ?? t('report.no_data')}</td></tr>`}</tbody>
    </table></div>
    ${more || page > 1 ? html`<nav class="pager" aria-label="${t('report.pagination')}">
      ${page > 1 ? html`<a class="btn" href="${go(page - 1)}">‹ ${t('report.previous')}</a>` : ''}
      ${more && page < MAX_PAGE ? html`<a class="btn" href="${go(page + 1)}">${t('report.next')} ›</a>` : ''}</nav>` : ''}`;
  } catch (e) {
    table = alert(await publicError(ctx, e, `form designer "${r.title ?? r.id}" rows`));
  }
  return html`<div class="reporter fd">${head(ctx, r, form, designer)}${add}${table}</div>`;
}

/** One row's form: a new row (rowKey null) or an existing one; Save, Delete, Cancel. */
async function rowView(ctx: PageContext, r: Region, form: StoredForm, source: FdSource, cols: Map<string, FdCol>, key: string | null, def: FormDef, rowKey: string | null, draft: Draft | null, designer: boolean): Promise<Raw> {
  const t = ctx.locale.t;
  const c = ctx.client!;
  const back: [string, string][] = def.list.length ? [['form', String(form.id)]] : [];
  let values: Record<string, string> = {};
  let version = '';
  if (rowKey !== null && key) {
    let row: (string | null)[] | undefined;
    try {
      row = (await savepoint(c, () => c.query({
        text: `select ${hashSql(def)}, ${valuesSql(def)} from ${objectSql(source)} where ${id(key)} = $1 limit 1`, values: [rowKey], rowMode: 'array',
      }))).rows[0];
    } catch {
      // a key that isn't a value of the key's type
      row = undefined;
    }
    if (!row) return html`${alert(t('formdesigner.row_not_found'))}${await rowsView(ctx, r, form, source, cols, key, def, designer)}`;
    version = row[0] ?? '';
    def.fields.forEach((f, i) => (values[f.column] = shownValue(cols.get(f.column)!.type, row[i + 1])));
  } else {
    for (const f of def.fields) values[f.column] = f.default;
  }
  if (draft) values = { ...values, ...draft.values };

  const fid = `fdr${r.id}`;
  const action = `${ctx.base}/${ctx.page.page_no}/formdesigner/${r.id}/row`;
  ctx.detached.push(html`<form id="${fid}" method="post" action="${action}"><input type="hidden" name="__csrf" value="${ctx.session.csrf_token}">
    <input type="hidden" name="form" value="${form.id}"><input type="hidden" name="row" value="${rowKey ?? ''}"><input type="hidden" name="version" value="${version}"></form>`);
  const fields = await Promise.all(def.fields.map(async (f, i) => {
    const col = cols.get(f.column)!;
    const fieldId = `${fid}_${i}`;
    const name = `c:${f.column}`;
    const label = f.label || col.label;
    const v = values[f.column] ?? '';
    const help = f.help ? html`<small class="help" id="${fieldId}_help">${f.help}</small>` : '';
    const described = f.help ? raw(` aria-describedby="${fieldId}_help"`) : '';
    const req = f.required ? raw(' required') : '';
    const lbl = html`<label class="label" for="${fieldId}">${label}${f.required ? html` <span class="required" aria-hidden="true">*</span>` : ''}</label>`;
    if (col.type === BOOL)
      return html`<div class="field"><label class="check"><input type="checkbox" id="${fieldId}" name="${name}" value="true" form="${fid}"${v === 'true' ? raw(' checked') : ''}${described}> ${label}</label>${help}</div>`;
    if ((f.display === 'select' || f.display === 'radio') && col.lov) {
      let options: { display: string; value: string }[] = [];
      try {
        options = await lovOptions(ctx, col.lov);
      } catch (e) {
        return html`<div class="field">${lbl}${alert(await publicError(ctx, e, `form designer list of values ${col.lov}`))}</div>`;
      }
      if (f.display === 'radio')
        return html`<fieldset class="field fd-radios"${described}><legend class="label">${label}${f.required ? html` <span class="required" aria-hidden="true">*</span>` : ''}</legend>
          ${options.map((o, j) => html`<label class="check"><input type="radio" id="${j ? `${fieldId}_${j}` : fieldId}" name="${name}" value="${o.value}" form="${fid}"${o.value === v ? raw(' checked') : ''}${j === 0 ? req : ''}> ${o.display}</label>`)}${help}</fieldset>`;
      return html`<div class="field">${lbl}<select id="${fieldId}" name="${name}" form="${fid}"${req}${described}><option value="">${t('formdesigner.choose')}</option>${options.map((o) => html`<option value="${o.value}"${o.value === v ? raw(' selected') : ''}>${o.display}</option>`)}</select>${help}</div>`;
    }
    let control: Raw;
    if (col.type === DATE) control = dateField(ctx, { id: fieldId, iso: v, typed: v, mask: appDateMask(ctx), attrs: html` name="${name}" form="${fid}"${req}${described}` });
    else if (TIMESTAMPS.has(col.type)) control = html`<input type="datetime-local" id="${fieldId}" name="${name}" form="${fid}" value="${v}"${req}${described}>`;
    else if (isNumeric(col.type)) control = html`<input type="number" step="any" inputmode="decimal" id="${fieldId}" name="${name}" form="${fid}" value="${v}"${req}${described}>`;
    else if (f.display === 'textarea') control = html`<textarea id="${fieldId}" name="${name}" form="${fid}" rows="4" maxlength="${FD_LIMITS.value}"${req}${described}>${v}</textarea>`;
    else control = html`<input type="text" id="${fieldId}" name="${name}" form="${fid}" value="${v}" maxlength="${FD_LIMITS.value}"${req}${described}>`;
    return html`<div class="field"${f.display === 'textarea' ? raw(' data-wide') : ''}>${lbl}${control}${help}</div>`;
  }));
  const canSave = rowKey === null ? def.actions.insert : def.actions.update;
  return html`<div class="reporter fd">
    ${head(ctx, r, form, designer, back)}
    ${draft?.error ? alert(draft.error) : ''}
    <div class="form-grid fd-form">${fields}</div>
    <div class="buttons">
      ${canSave ? html`<button class="btn btn-hot" form="${fid}" name="mode" value="save">${t('formdesigner.save')}</button>` : ''}
      ${rowKey !== null && def.actions.delete ? html`<button class="btn btn-danger" form="${fid}" name="mode" value="delete" formnovalidate data-confirm="${t('formdesigner.delete_confirm')}">${t('formdesigner.delete')}</button>` : ''}
      <a class="btn" href="${url(ctx, r, back)}">${t('formdesigner.cancel')}</a>
    </div>
  </div>`;
}

/** The designer: the form's name, description, published, actions, and a row per offered column. */
async function designView(ctx: PageContext, r: Region, source: FdSource, form: StoredForm | undefined): Promise<Raw> {
  const t = ctx.locale.t;
  const c = ctx.client!;
  let cols: Map<string, FdCol>, key: string | null;
  try {
    ({ cols, key } = await fdColumns(c, source, ctx.locale.tr));
  } catch (e) {
    return alert(await publicError(ctx, e, `form designer "${r.title ?? r.id}" source ${source.id}`));
  }
  const def = form
    ? checkFormDef(form.definition, source, cols, key)
    : checkFormDef({ fields: [...cols.values()].filter((x) => x.name !== key).map((x) => ({ column: x.name })), list: [...cols.keys()].filter((x) => x !== key).slice(0, 4), actions: { insert: true, update: true } }, source, cols, key);
  const fid = `fdd${r.id}`;
  const base = `${ctx.base}/${ctx.page.page_no}/formdesigner/${r.id}`;
  const csrf = html`<input type="hidden" name="__csrf" value="${ctx.session.csrf_token}">`;
  ctx.detached.push(html`<form id="${fid}" method="post" action="${base}/design">${csrf}<input type="hidden" name="src" value="${source.id}">${form ? html`<input type="hidden" name="form" value="${form.id}">` : ''}</form>`);
  if (form) ctx.detached.push(html`<form id="fdx${r.id}" method="post" action="${base}/delete">${csrf}<input type="hidden" name="form" value="${form.id}"></form>`);
  const x = (n: string) => `${fid}_${n}`;
  // the form's fields first (in their order), then the other offered columns
  const ordered = [...def.fields.map((f) => f.column), ...[...cols.keys()].filter((n) => !def.fields.some((f) => f.column === n))];
  const rows = ordered.map((n, j) => {
    const col = cols.get(n)!;
    const f = def.fields.find((y) => y.column === n);
    const opts = displaysOf(col);
    return html`<tr>
      <td data-label="${t('formdesigner.field_on')}"><input type="hidden" name="col_${j}" value="${n}"><input type="checkbox" name="on_${j}" value="true" form="${fid}"${f ? raw(' checked') : ''} aria-label="${t('formdesigner.field_on')}: ${col.label}"></td>
      <td data-label="${t('formdesigner.column')}">${col.label}${n === key ? html` <span class="tag">${t('formdesigner.key')}</span>` : ''}</td>
      <td data-label="${t('formdesigner.order')}"><input type="number" name="seq_${j}" form="${fid}" min="1" max="999" value="${(j + 1) * 10}" class="fd-seq" aria-label="${t('formdesigner.order')}: ${col.label}"></td>
      <td data-label="${t('formdesigner.label')}"><input name="label_${j}" form="${fid}" maxlength="${FD_LIMITS.label}" value="${f?.label ?? ''}" placeholder="${col.label}" aria-label="${t('formdesigner.label')}: ${col.label}"></td>
      <td data-label="${t('formdesigner.help')}"><input name="help_${j}" form="${fid}" maxlength="${FD_LIMITS.help}" value="${f?.help ?? ''}" aria-label="${t('formdesigner.help')}: ${col.label}"></td>
      <td data-label="${t('formdesigner.required_short')}">${col.type === BOOL ? '' : html`<input type="checkbox" name="req_${j}" value="true" form="${fid}"${f?.required ? raw(' checked') : ''} aria-label="${t('formdesigner.required_short')}: ${col.label}">`}</td>
      <td data-label="${t('formdesigner.display')}">${opts.length > 1
        ? html`<select name="disp_${j}" form="${fid}" aria-label="${t('formdesigner.display')}: ${col.label}">${opts.map((d) => html`<option value="${d}"${(f?.display ?? (col.lov ? 'select' : 'auto')) === d ? raw(' selected') : ''}>${t(`formdesigner.display_${d}`)}</option>`)}</select>`
        : html`<input type="hidden" name="disp_${j}" value="auto" form="${fid}">${t('formdesigner.display_auto')}`}</td>
      <td data-label="${t('formdesigner.default')}"><input name="def_${j}" form="${fid}" maxlength="${FD_LIMITS.default}" value="${f?.default ?? ''}" aria-label="${t('formdesigner.default')}: ${col.label}"></td>
      <td data-label="${t('formdesigner.in_list')}">${key ? html`<input type="checkbox" name="list_${j}" value="true" form="${fid}"${def.list.includes(n) ? raw(' checked') : ''} aria-label="${t('formdesigner.in_list')}: ${col.label}">` : ''}</td>
    </tr>`;
  });
  const action = (k: 'insert' | 'update' | 'delete') =>
    source[k] ? html`<label class="check"><input type="checkbox" name="allow_${k}" value="true" form="${fid}"${def.actions[k] || (!form && k !== 'delete' && source[k]) ? raw(' checked') : ''}> ${t(`formdesigner.allow_${k}`)}</label>` : '';
  return html`<div class="reporter fd fd-designer">
    <div class="reporter-head">
      <a href="${url(ctx, r, form ? [['form', String(form.id)]] : [])}">‹ ${form ? form.name : t('formdesigner.back')}</a>
      <h3 class="reporter-title">${form ? t('formdesigner.design_of', { name: form.name }) : t('formdesigner.new')}</h3>
      <span class="muted">${sourceLabel(ctx, source)}${form ? html` · ${t('formdesigner.changed_by', { user: form.updated_by, date: String(form.updated_at instanceof Date ? form.updated_at.toISOString() : form.updated_at).slice(0, 10) })}` : ''}</span>
    </div>
    <div class="form-grid">
      <div class="field"><label class="label" for="${x('name')}">${t('formdesigner.name')}</label><input id="${x('name')}" name="name" form="${fid}" required maxlength="80" value="${form?.name ?? ''}"></div>
      <div class="field" data-wide><label class="label" for="${x('desc')}">${t('formdesigner.description')}</label><input id="${x('desc')}" name="description" form="${fid}" maxlength="500" value="${form?.description ?? ''}"></div>
    </div>
    <fieldset class="reporter-set"><legend>${t('formdesigner.actions')}</legend>
      <div class="reporter-checks">${action('insert')}${action('update')}${action('delete')}</div>
      <small class="help">${t('formdesigner.list_help')}</small>
    </fieldset>
    <fieldset class="reporter-set"><legend>${t('formdesigner.fields')}</legend>
      <div class="table-wrap"><table class="report report-reflow fd-fields"><thead><tr>
        <th scope="col">${t('formdesigner.field_on')}</th><th scope="col">${t('formdesigner.column')}</th><th scope="col">${t('formdesigner.order')}</th>
        <th scope="col">${t('formdesigner.label')}</th><th scope="col">${t('formdesigner.help')}</th><th scope="col">${t('formdesigner.required_short')}</th>
        <th scope="col">${t('formdesigner.display')}</th><th scope="col">${t('formdesigner.default')}</th><th scope="col">${t('formdesigner.in_list')}</th>
      </tr></thead><tbody>${rows}</tbody></table></div>
    </fieldset>
    <label class="check"><input type="checkbox" name="published" value="true" form="${fid}"${form?.published ? raw(' checked') : ''}> ${t('formdesigner.published')}</label>
    <div class="buttons">
      <button class="btn btn-hot" form="${fid}">${t('formdesigner.save_form')}</button>
      ${form ? html`<button class="btn btn-danger" form="fdx${r.id}" data-confirm="${t('formdesigner.delete_form_confirm', { name: form.name })}">${t('formdesigner.delete_form')}</button>` : ''}
    </div>
  </div>`;
}

/** The designer's posted form as a loose definition (checked by checkFormDef). */
export function formDefFromBody(b: Record<string, unknown>, sourceId: string) {
  const items: { seq: number; j: number; field: Record<string, unknown> }[] = [];
  const list: string[] = [];
  for (let j = 0; j < 500 && typeof b[`col_${j}`] === 'string'; j++) {
    const column = b[`col_${j}`] as string;
    if (b[`list_${j}`] === 'true') list.push(column);
    if (b[`on_${j}`] !== 'true') continue;
    const seq = Number(b[`seq_${j}`]);
    items.push({ seq: Number.isFinite(seq) ? seq : (j + 1) * 10, j, field: { column, label: b[`label_${j}`], help: b[`help_${j}`], required: b[`req_${j}`] === 'true', display: b[`disp_${j}`], default: b[`def_${j}`] } });
  }
  items.sort((a, z) => a.seq - z.seq || a.j - z.j);
  return { source: sourceId, fields: items.map((x) => x.field), list, actions: { insert: b.allow_insert === 'true', update: b.allow_update === 'true', delete: b.allow_delete === 'true' } };
}

// ---------------------------------------------------------------- saving

class UserError extends Error {}

export async function formDesignerRoutes(app: FastifyInstance) {
  /** Shared checks: CSRF, the region visible on the page; back to the page afterwards. */
  const action = async (
    req: Req, reply: FastifyReply, opts: { design: boolean },
    run: (ctx: PageContext, r: Region) => Promise<{ message: string; back: [string, string][]; error?: boolean }>,
    onError?: (ctx: PageContext, r: Region, message: string) => [string, string][],
  ) => {
    const ctx = await loadContext(req, reply);
    if (!ctx) return;
    const body = req.body ?? {};
    const refuse = (detail: string) => {
      logActivity({ appId: ctx.app.id, pageNo: ctx.page.page_no, username: ctx.user, event: 'forbidden', ip: ctx.ip, detail });
      return simplePage(reply, 403, ctx.locale.t('error.access_denied'), ctx.locale.t(detail.includes('csrf') ? 'error.session_reload' : 'error.report_unavailable'), `${ctx.base}/${ctx.page.page_no}`, ctx.locale);
    };
    if (typeof body.__csrf !== 'string' || body.__csrf !== ctx.session.csrf_token) return refuse('form designer: csrf');
    const r = ctx.page.regions.find((x) => x.id === Number(req.params.id) && x.type === 'form_designer');
    if (!r) return refuse(`form designer: region ${req.params.id} on page ${ctx.page.page_no}`);
    let back: [string, string][] = [];
    try {
      const out = await appTx(txContext(ctx), async (c) => {
        ctx.client = c;
        await checkPageAccess(ctx);
        const vis = await computeVisibility(ctx);
        if (!vis.regions.has(r.id)) throw new Forbidden('region');
        if (opts.design && !(await mayDesign(ctx, r))) throw new Forbidden('designer');
        return run(ctx, r);
      });
      ctx.session.state[out.error ? '__FLASH_ERROR' : '__FLASH'] = out.message;
      back = out.back;
    } catch (e) {
      if (e instanceof Forbidden) return refuse(`form designer: ${e.message} ${r.id} on page ${ctx.page.page_no}`);
      const message = e instanceof UserError ? e.message : await publicError(ctx, e, 'form designer');
      back = onError ? onError(ctx, r, message) : [];
      if (!onError) ctx.session.state.__FLASH_ERROR = message;
    }
    await saveState(ctx.session);
    const p = new URLSearchParams(back.map(([k, v]) => [`${fdPrefix(r)}${k}`, v]));
    const q = p.toString();
    return reply.redirect(`${ctx.base}/${ctx.page.page_no}${q ? `?${q}` : ''}`, 303);
  };

  const formIdOf = (v: unknown) => (/^\d{1,9}$/.test(String(v ?? '')) ? Number(v) : 0);

  // a row: add, change or delete
  app.post('/a/:alias/:page/formdesigner/:id/row', async (req: Req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const formId = formIdOf(b.form);
    const rowKey = str(b.row).slice(0, 200);
    const posted: Record<string, string> = {};
    for (const [k, v] of Object.entries(b)) if (k.startsWith('c:') && Object.keys(posted).length < FD_LIMITS.fields + 10) posted[k.slice(2)] = str(Array.isArray(v) ? v[0] : v).slice(0, FD_LIMITS.value);
    return action(req, reply, { design: false }, async (ctx, r) => {
      const t = ctx.locale.t;
      const c = ctx.client!;
      const designer = await mayDesign(ctx, r);
      const form = await loadForm(ctx, r, formId, designer);
      const source = form && fdSourcesOf(r).find((s) => s.id === str(form.definition?.source));
      if (!form || !source) throw new UserError(t('formdesigner.form_not_found'));
      const { cols, key } = await fdColumns(c, source);
      const def = checkFormDef(form.definition, source, cols, key);
      const label = (f: Field) => f.label || ctx.locale.tr(source.columns.find((x) => x.name === f.column)?.label || heading(f.column));
      const back: [string, string][] = def.list.length ? [['form', String(form.id)]] : def.actions.insert ? [['form', String(form.id)], ['row', 'new']] : [];
      const obj = objectSql(source);

      if (b.mode === 'delete') {
        if (!def.actions.delete || !key || !rowKey) throw new UserError(t('formdesigner.not_allowed'));
        const n = (await savepoint(c, () => c.query(`delete from ${obj} where ${id(key)} = $1`, [rowKey]))).rowCount;
        if (!n) throw new UserError(t('formdesigner.row_not_found'));
        logActivity({ appId: ctx.app.id, pageNo: ctx.page.page_no, username: ctx.user, event: 'form_designer', ip: ctx.ip, detail: `form ${form.id}: deleted a row of ${source.schema}.${source.table}` });
        return { message: t('formdesigner.deleted_row'), back: def.list.length ? [['form', String(form.id)]] : [] };
      }

      const isNew = rowKey === '';
      if (isNew ? !def.actions.insert : !def.actions.update || !key) throw new UserError(t('formdesigner.not_allowed'));
      // the form's fields only: the values the user typed, checked
      const errors: string[] = [];
      const values: (string | null)[] = [];
      for (const f of def.fields) {
        const col = cols.get(f.column)!;
        const v = postedValue(ctx, col, posted[f.column]);
        if (f.required && col.type !== BOOL && v === null) errors.push(t('formdesigner.required', { field: label(f) }));
        else if (v !== null && col.lov && (f.display === 'select' || f.display === 'radio') && !(await lovContains(ctx, col.lov, [v]))) errors.push(t('formdesigner.not_in_list', { field: label(f) }));
        values.push(v);
      }
      if (errors.length) throw new UserError(errors.join(' '));
      if (isNew) {
        await savepoint(c, () => c.query(`insert into ${obj} (${def.fields.map((f) => id(f.column)).join(', ')}) values (${values.map((_, i) => `$${i + 1}`).join(', ')})`, values));
      } else {
        const n = (await savepoint(c, () => c.query(
          `update ${obj} set ${def.fields.map((f, i) => `${id(f.column)} = $${i + 1}`).join(', ')}
            where ${id(key!)} = $${values.length + 1} and ${hashSql(def)} = $${values.length + 2}`, [...values, rowKey, str(b.version)]))).rowCount;
        if (!n) {
          // gone (or hidden), changed meanwhile, or not ours to change (row level security)
          const now = (await savepoint(c, () => c.query({ text: `select ${hashSql(def)} from ${obj} where ${id(key!)} = $1 limit 1`, values: [rowKey], rowMode: 'array' }))).rows[0];
          throw new UserError(t(!now ? 'formdesigner.row_not_found' : now[0] === str(b.version) ? 'formdesigner.not_allowed' : 'formdesigner.changed'));
        }
      }
      logActivity({ appId: ctx.app.id, pageNo: ctx.page.page_no, username: ctx.user, event: 'form_designer', ip: ctx.ip, detail: `form ${form.id}: ${isNew ? 'added' : 'changed'} a row of ${source.schema}.${source.table}` });
      return { message: t('formdesigner.saved_row'), back };
    }, (ctx, r, message) => {
      // back to the row's form with what was typed, and the message
      const draft: Draft = { form: formId, row: rowKey, values: posted, error: message };
      const raw = JSON.stringify(draft);
      if (raw.length <= 64_000) ctx.session.state[draftKey(r)] = raw;
      else ctx.session.state.__FLASH_ERROR = message;
      return formId ? [['form', String(formId)], ['row', rowKey || 'new']] : [];
    });
  });

  // a form's design: save (new or existing)
  app.post('/a/:alias/:page/formdesigner/:id/design', async (req: Req, reply) =>
    action(req, reply, { design: true }, async (ctx, r) => {
      const t = ctx.locale.t;
      const c = ctx.client!;
      const b = (req.body ?? {}) as Record<string, unknown>;
      const source = fdSourcesOf(r).find((s) => s.id === str(b.src));
      if (!source) throw new UserError(t('formdesigner.unknown_source'));
      const existing = formIdOf(b.form) || null;
      const back: [string, string][] = existing ? [['design', String(existing)]] : [['design', 'new'], ['src', source.id]];
      const { cols, key } = await fdColumns(c, source);
      const def = checkFormDef(formDefFromBody(b, source.id), source, cols, key);
      const name = clip(b.name, 80);
      if (!name) return { message: t('formdesigner.name_required'), back, error: true };
      if (!def.fields.length) return { message: t('formdesigner.no_fields'), back, error: true };
      const formId = (await c.query<{ id: number }>('select meta.save_user_form($1, $2, $3, $4, $5::jsonb, $6) as id',
        [r.id, existing, name, clip(b.description, 500), JSON.stringify(def), b.published === 'true'])).rows[0].id;
      logActivity({ appId: ctx.app.id, pageNo: ctx.page.page_no, username: ctx.user, event: 'form_designer', ip: ctx.ip, detail: `form ${formId} "${name}" saved` });
      return { message: t('formdesigner.form_saved', { name }), back: [['form', String(formId)]] };
    }),
  );

  app.post('/a/:alias/:page/formdesigner/:id/delete', async (req: Req, reply) =>
    action(req, reply, { design: true }, async (ctx, r) => {
      const formId = formIdOf(req.body?.form);
      const done = (await ctx.client!.query<{ d: boolean }>('select meta.delete_user_form($1, $2) as d', [r.id, formId])).rows[0].d;
      if (done) logActivity({ appId: ctx.app.id, pageNo: ctx.page.page_no, username: ctx.user, event: 'form_designer', ip: ctx.ip, detail: `form ${formId} deleted` });
      return { message: ctx.locale.t(done ? 'formdesigner.form_deleted' : 'formdesigner.form_not_found'), back: [] };
    }),
  );
}
