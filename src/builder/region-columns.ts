// (sprint 205, AX-1; APEX: the Columns node of a report, grid, cards or calendar region) A region's columns in the
// Page Designer: a Columns node in the tree under the region, one child per column of its query (in the query's order,
// then the columns its settings name that the query no longer returns), and the property editor for one column or
// several.
//
// The settings stay where they always were, in the region's config JSON (the Attributes tab edits the same keys), so
// exports, application files, import and diff_app are unchanged:
//   report, classic_report  headings, formats, column_options (Display), hidden, pdf.columns, pdf.widths, link
//   grid                    headings, hidden, readonly, columns.<name>.required / lov / validation / validation_message
//   cards                   formats (title, subtitle, body, badge)
//   calendar                none: the columns are read by their names (start_date, end_date, title)
//
// The property editor is form#pd-form posting to /builder/pages/:pid/region/:rid/columns (the toolbar's Save, also
// without JavaScript). Each field carries the value it was drawn with (was_<key>); only fields whose value changed are
// applied, so several columns can be edited at once: a field shows the value they share, or "Mixed" (mixed_<key>),
// which leaves each column's own value. Heading, link, validation and the condition are a single column's only.
//
// (sprint 210, AX-1; APEX: a column's Server-side Condition and Security → Authorization Scheme) Report, classic report,
// grid and cards columns also have a Condition and an Authorization: config.column_access.<name> = {condition_type,
// condition_expr, condition_value, authz}, the catalogue of regions and items. The runtime leaves a column that fails
// them out of the region's source (src/runtime/column-access.ts).
import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { formatMaskError } from '../runtime/format.ts';
import { heading } from '../runtime/items.ts';
import { COLUMN_OPTIONS } from '../runtime/template-options.ts';
import { CONDITION_TYPES } from '../metadata.ts';
import type { Session } from '../session.ts';
import { tr } from './i18n.ts';
import { linkItemsText, parseLinkItems, reportColumns } from './report-settings.ts';
import { back, BASE, csrf, designerUrl, developer, flash, type Req } from './ui.ts';
import { designSql } from './websources.ts';

/** The region types with a Columns node in the tree. */
export const COLUMN_REGION_TYPES: ReadonlySet<string> = new Set(['report', 'classic_report', 'grid', 'cards', 'calendar']);

type Config = Record<string, any>;
type Tx = ReturnType<typeof tr>;
export interface RegionColumn { name: string; type: string | null; stale: boolean }
export interface ColumnList { columns: RegionColumn[]; error?: string }
interface RegionRow { id: number; type: string; source: string | null; rest_source?: string | null; config: Config | null }

const keysOf = (o: unknown) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o) : []);
const strings = (a: unknown) => (Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : []);
const lowerHas = (list: unknown, name: string) => strings(list).some((x) => x.toLowerCase() === name.toLowerCase());

/** The column names a region's settings name (per type): kept in the list when the query no longer returns them. */
export function configuredColumns(type: string, cfg: Config): string[] {
  switch (type) {
    case 'report':
    case 'classic_report':
      return [...strings(cfg.hidden), ...keysOf(cfg.headings), ...keysOf(cfg.formats), ...keysOf(cfg.column_options), ...strings(cfg.pdf?.columns), ...keysOf(cfg.pdf?.widths), ...keysOf(cfg.column_access)];
    case 'grid':
      return [...strings(cfg.hidden), ...strings(cfg.readonly), ...keysOf(cfg.headings), ...keysOf(cfg.columns), ...keysOf(cfg.column_access)];
    case 'cards':
      return [...keysOf(cfg.formats), ...keysOf(cfg.column_access)];
    default:
      return [];
  }
}

const typeNames = new Map<number, string>();
async function namesOfTypes(oids: number[]) {
  const missing = [...new Set(oids)].filter((o) => !typeNames.has(o));
  if (missing.length) {
    for (const t of (await owner.query<{ oid: number; name: string }>('select oid::int as oid, format_type(oid, null) as name from pg_type where oid = any($1::oid[])', [missing])).rows)
      typeNames.set(t.oid, t.name);
  }
  return typeNames;
}

/** A region's columns as the Attributes tab gets them: the query's (limit 0, as the app's role), then the stale ones. */
export async function regionColumns(appId: number, r: RegionRow): Promise<ColumnList> {
  const cols = await reportColumns(appId, await designSql(appId, r));
  const names = 'columns' in cols ? cols.columns : [];
  const oids = 'columns' in cols ? cols.types ?? [] : [];
  const types = await namesOfTypes(oids);
  const known = new Set(names);
  const stale = [...new Set(configuredColumns(r.type, r.config ?? {}))].filter((n) => !known.has(n));
  return {
    columns: [...names.map((name, i) => ({ name, type: types.get(oids[i]) ?? null, stale: false })), ...stale.map((name) => ({ name, type: null, stale: true }))],
    ...('error' in cols ? { error: cols.error } : {}),
  };
}

// ---------------------------------------------------------------- the properties of a column

interface Allowed { pages: { page_no: number; name: string }[]; lovs: string[]; authz: string[] }
type Group = 'heading' | 'appearance' | 'link' | 'editing' | 'validation' | 'printing' | 'condition' | 'security';
interface Field {
  key: string;
  group: Group;
  kind: 'text' | 'bool' | 'select' | 'number' | 'textarea';
  /** a single column's only (not offered when several are selected) */
  single?: boolean;
  label: (tx: Tx) => string;
  help?: (tx: Tx) => string;
  placeholder?: (name: string) => string;
  options?: (tx: Tx, cfg: Config, a: Allowed) => [string, string][];
  get: (cfg: Config, name: string, all: string[]) => string;
}

const printed = (cfg: Config, name: string) =>
  Array.isArray(cfg.pdf?.columns) && cfg.pdf.columns.length ? lowerHas(cfg.pdf.columns, name) : !lowerHas(cfg.hidden, name);
const linkOf = (cfg: Config, name: string) => (cfg.link && typeof cfg.link === 'object' && cfg.link.column === name ? cfg.link : null);

const HEADING: Field = { key: 'heading', group: 'heading', kind: 'text', single: true, label: (tx) => tx('rpt.heading'), placeholder: (n) => heading(n), get: (c, n) => String(c.headings?.[n] ?? '') };
const SHOWN: Field = { key: 'shown', group: 'appearance', kind: 'bool', label: (tx) => tx('rpt.shown'), get: (c, n) => String(!lowerHas(c.hidden, n)) };
const FORMAT: Field = { key: 'format', group: 'appearance', kind: 'text', label: (tx) => tx('rpt.format_mask'), help: (tx) => tx('rpt.format_masks_numbers_like_999g999g990d00'), placeholder: () => '999G990D00', get: (c, n) => String(c.formats?.[n] ?? '') };
const DISPLAY: Field = {
  key: 'display', group: 'appearance', kind: 'select', label: (tx) => tx('rpt.display'),
  options: (tx) => [['', tx('rpt.normal')], ...COLUMN_OPTIONS.map((o): [string, string] => [o.cls, o.label])],
  get: (c, n) => { const l = c.column_options?.[n]; return Array.isArray(l) && typeof l[0] === 'string' ? l[0] : ''; },
};
const LINK_PAGE: Field = {
  key: 'link_page', group: 'link', kind: 'select', single: true, label: (tx) => tx('rpt.to_page'), help: (tx) => tx('pdc.link_help'),
  options: (tx, _c, a) => [['', tx('rpt.no_link')], ...a.pages.map((p): [string, string] => [String(p.page_no), `${p.page_no}. ${p.name}`])],
  get: (c, n) => String(linkOf(c, n)?.page ?? ''),
};
const LINK_ITEMS: Field = { key: 'link_items', group: 'link', kind: 'text', single: true, label: (tx) => tx('rpt.set_items'), help: (tx) => tx('rpt.item_column_comma_separated_column'), placeholder: (n) => `P3_ID=#${n}#`, get: (c, n) => linkItemsText(linkOf(c, n)?.items) };
const PRINT: Field = { key: 'print', group: 'printing', kind: 'bool', label: (tx) => tx('rpt.in_pdf'), get: (c, n) => String(printed(c, n)) };
const WIDTH: Field = { key: 'width', group: 'printing', kind: 'number', label: (tx) => tx('rpt.pdf_width_mm'), get: (c, n) => String(c.pdf?.widths?.[n] ?? '') };
const READONLY: Field = { key: 'readonly', group: 'editing', kind: 'bool', label: (tx) => tx('rs.read_only'), get: (c, n) => String(lowerHas(c.readonly, n)) };
const REQUIRED: Field = { key: 'required', group: 'editing', kind: 'bool', label: (tx) => tx('rs.required'), get: (c, n) => String(!!c.columns?.[n]?.required) };
const LOV: Field = {
  key: 'lov', group: 'editing', kind: 'select', label: (tx) => tx('rs.edit_as'), help: (tx) => tx('rs.edit_as_picks_a_shared'),
  options: (tx, c, a) => {
    const custom = [...new Set(keysOf(c.columns).map((n) => c.columns[n]?.lov).filter((l): l is string => typeof l === 'string' && !a.lovs.some((x) => `LOV:${x}` === l.toUpperCase())))];
    return [['', tx('rs.text_field')], ...a.lovs.map((l): [string, string] => [`LOV:${l}`, l]), ...custom.map((l): [string, string] => [l, `custom: ${l.length > 40 ? `${l.slice(0, 40)}…` : l}`])];
  },
  get: (c, n) => String(c.columns?.[n]?.lov ?? ''),
};
const VALIDATION: Field = { key: 'validation', group: 'validation', kind: 'textarea', single: true, label: (tx) => tx('rs.valid_when'), help: (tx) => tx('rs.col_validations_help'), placeholder: (n) => `:${n.toUpperCase()} is not null`, get: (c, n) => String(c.columns?.[n]?.validation ?? '') };
const access = (c: Config, n: string, k: string) => {
  const a = c.column_access?.[n];
  return a && typeof a === 'object' && typeof a[k] === 'string' ? (a[k] as string) : '';
};
// (sprint 210) the condition of regions and items (meta.condition_ok), and an authorization scheme
const COND_TYPE: Field = {
  key: 'condition_type', group: 'condition', kind: 'select', single: true, label: (tx) => tx('pdc.condition_type'), help: (tx) => tx('pdc.condition_help'),
  options: (tx) => [['', tx('pdz.none')], ...CONDITION_TYPES.map((t): [string, string] => [t, `${tx.dyn(`cond.${t}`, t, { item: 'ITEM', value: '…' })} (${t})`])],
  get: (c, n) => access(c, n, 'condition_type'),
};
const COND_EXPR: Field = { key: 'condition_expr', group: 'condition', kind: 'textarea', single: true, label: (tx) => tx('pdc.condition_expr'), help: (tx) => tx('pdc.condition_expr_help'), get: (c, n) => access(c, n, 'condition_expr') };
const COND_VALUE: Field = { key: 'condition_value', group: 'condition', kind: 'text', single: true, label: (tx) => tx('pdc.condition_value'), get: (c, n) => access(c, n, 'condition_value') };
const AUTHZ: Field = {
  key: 'authz', group: 'security', kind: 'select', label: (tx) => tx('pdz.authorization_scheme'), help: (tx) => tx('pdc.authz_help'),
  options: (tx, _c, a) => [['', tx('pdz.none')], ...['MUST_NOT_BE_PUBLIC_USER', ...a.authz].flatMap((n): [string, string][] => [[n, n], [`!${n}`, tx('pdz.not_authz', { name: n })]])],
  get: (c, n) => access(c, n, 'authz'),
};
const ACCESS = [COND_TYPE, COND_EXPR, COND_VALUE, AUTHZ];

const VALIDATION_MESSAGE: Field = { key: 'validation_message', group: 'validation', kind: 'text', single: true, label: (tx) => tx('rs.error_message'), get: (c, n) => String(c.columns?.[n]?.validation_message ?? '') };

/** The properties of a region type's columns, in the property editor's order. */
export const COLUMN_FIELDS: Record<string, Field[]> = {
  report: [HEADING, SHOWN, FORMAT, DISPLAY, LINK_PAGE, LINK_ITEMS, PRINT, WIDTH, ...ACCESS],
  classic_report: [HEADING, SHOWN, FORMAT, DISPLAY, LINK_PAGE, LINK_ITEMS, ...ACCESS],
  grid: [HEADING, SHOWN, READONLY, REQUIRED, LOV, VALIDATION, VALIDATION_MESSAGE, ...ACCESS],
  cards: [FORMAT, ...ACCESS],
  calendar: [],
};

/** What a calendar or cards region reads a column as (by its name). */
const ROLES: Record<string, string[]> = { calendar: ['start_date', 'end_date', 'title'], cards: ['title', 'subtitle', 'body', 'badge', 'icon'] };

/**
 * The region's config after a change of columns `names`: `changes` holds the fields to apply (key → posted value);
 * `all` is every column of the region (for the PDF's column list). Problems are fields that were not applied.
 */
export function mergeColumnSettings(type: string, config: Config, names: string[], all: string[], changes: Record<string, string>,
  a: { pages: Set<number>; lovs: Set<string>; authz?: Set<string>; conditionOk?: boolean }): { config: Config; problems: string[] } {
  const out: Config = structuredClone(config ?? {});
  const problems: string[] = [];
  const has = (k: string) => Object.prototype.hasOwnProperty.call(changes, k) && (COLUMN_FIELDS[type] ?? []).some((f) => f.key === k && (!f.single || names.length === 1));
  const map = (k: string) => (out[k] && typeof out[k] === 'object' && !Array.isArray(out[k]) ? out[k] : (out[k] = {}));
  const tidy = (k: string) => {
    const v = out[k];
    if (v !== undefined && ((Array.isArray(v) && !v.length) || (v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length))) delete out[k];
  };
  const setIn = (k: string, n: string, v: unknown) => {
    const m = map(k);
    if (v === undefined) delete m[n];
    else m[n] = v;
    tidy(k);
  };
  const listSet = (k: string, n: string, on: boolean) => {
    const list = strings(out[k]).filter((x) => x.toLowerCase() !== n.toLowerCase());
    if (on) list.push(n);
    out[k] = list;
    tidy(k);
  };
  const col = (n: string) => {
    const cols = map('columns');
    return (cols[n] && typeof cols[n] === 'object' ? cols[n] : (cols[n] = {})) as Config;
  };
  const tidyCol = (n: string) => {
    if (out.columns?.[n] && !Object.keys(out.columns[n]).length) delete out.columns[n];
    tidy('columns');
  };
  // (sprint 210) config.column_access.<name>: the condition (checked by meta.condition_ok: conditionOk) and authorization
  const setAccess = (n: string, k: string, v: string | undefined) => {
    const m = map('column_access');
    const cur = m[n] && typeof m[n] === 'object' && !Array.isArray(m[n]) ? (m[n] as Config) : (m[n] = {});
    if (v) cur[k] = v;
    else delete cur[k];
    if (!Object.keys(cur).length) delete m[n];
    tidy('column_access');
  };
  const schemes = a.authz ?? new Set<string>();
  for (const n of names) {
    if (has('condition_type') || has('condition_expr') || has('condition_value')) {
      const t = (changes.condition_type ?? '').trim();
      if (t && (!(CONDITION_TYPES as readonly string[]).includes(t) || a.conditionOk === false)) problems.push(`${n}: ${t}`);
      else {
        setAccess(n, 'condition_type', t || undefined);
        setAccess(n, 'condition_expr', t ? (changes.condition_expr ?? '').trim().slice(0, 4000) || undefined : undefined);
        setAccess(n, 'condition_value', t ? (changes.condition_value ?? '').trim().slice(0, 4000) || undefined : undefined);
      }
    }
    if (has('authz')) {
      const v = changes.authz.trim().toUpperCase();
      const name = v.replace(/^!/, '');
      if (v && name !== 'MUST_NOT_BE_PUBLIC_USER' && !schemes.has(name)) problems.push(`${n}: ${changes.authz.trim().slice(0, 63)}`);
      else setAccess(n, 'authz', v || undefined);
    }
    if (has('heading')) setIn('headings', n, changes.heading.trim().slice(0, 255) || undefined);
    if (has('format')) {
      const mask = changes.format.trim().slice(0, 64);
      const e = mask ? formatMaskError(mask) : null;
      if (e) problems.push(`${n}: ${e}`);
      else setIn('formats', n, mask || undefined);
    }
    if (has('display')) setIn('column_options', n, COLUMN_OPTIONS.some((o) => o.cls === changes.display) ? [changes.display] : undefined);
    if (has('shown')) listSet('hidden', n, changes.shown !== 'true');
    if (has('readonly')) listSet('readonly', n, changes.readonly === 'true');
    if (has('required')) {
      if (changes.required === 'true') col(n).required = true;
      else if (out.columns?.[n]) delete out.columns[n].required;
      tidyCol(n);
    }
    if (has('lov')) {
      const v = changes.lov.trim();
      const shared = /^LOV:([A-Z0-9_]+)$/i.exec(v);
      const now = out.columns?.[n]?.lov;
      if (shared && a.lovs.has(shared[1].toUpperCase())) col(n).lov = `LOV:${shared[1].toUpperCase()}`;
      else if (!v) { if (out.columns?.[n]) delete out.columns[n].lov; }
      // a custom list of values (SQL) is kept as it is, never set from here
      else if (v !== now) problems.push(`${n}: ${v}`);
      tidyCol(n);
    }
    if (has('validation') || has('validation_message')) {
      const v = (changes.validation ?? '').trim().slice(0, 4000);
      const m = (changes.validation_message ?? '').trim().slice(0, 500);
      if (v) col(n).validation = v;
      else if (out.columns?.[n]) delete out.columns[n].validation;
      if (v && m) col(n).validation_message = m;
      else if (out.columns?.[n]) delete out.columns[n].validation_message;
      tidyCol(n);
    }
    if (has('width')) {
      const w = Math.floor(Number(changes.width));
      const pdf = map('pdf');
      if (changes.width.trim() && w > 0 && w <= 500) (pdf.widths && typeof pdf.widths === 'object' ? pdf.widths : (pdf.widths = {}))[n] = w;
      else if (pdf.widths) delete pdf.widths[n];
      if (pdf.widths && !Object.keys(pdf.widths).length) delete pdf.widths;
      tidy('pdf');
    }
    if (has('link_page') || has('link_items')) {
      const page = Number(changes.link_page);
      const items = parseLinkItems(changes.link_items);
      if (!(changes.link_page ?? '').trim()) {
        if (linkOf(out, n)) delete out.link;
      } else if (!a.pages.has(page)) problems.push(`${n}: ${changes.link_page}`);
      else {
        // the report's one link moves to this column; its other keys (icon) stay
        const { items: _old, ...rest } = (out.link && typeof out.link === 'object' ? out.link : {}) as Config;
        out.link = { ...rest, column: n, page, ...(Object.keys(items).length ? { items } : {}) };
      }
    }
  }
  // the PDF prints the shown columns unless its own list differs (as the Attributes tab keeps it)
  if (has('print') || (has('shown') && Array.isArray(out.pdf?.columns))) {
    const hidden = new Set(strings(out.hidden).map((x) => x.toLowerCase()));
    const before = Array.isArray(config?.pdf?.columns) && config.pdf.columns.length ? new Set(strings(config.pdf.columns).map((x) => x.toLowerCase())) : new Set(all.filter((x) => !hidden.has(x.toLowerCase())).map((x) => x.toLowerCase()));
    if (has('print'))
      for (const n of names) {
        if (changes.print === 'true') before.add(n.toLowerCase());
        else before.delete(n.toLowerCase());
      }
    const list = all.filter((x) => before.has(x.toLowerCase()));
    const shown = all.filter((x) => !hidden.has(x.toLowerCase()));
    const pdf = map('pdf');
    if (list.length === shown.length && list.every((x) => !hidden.has(x.toLowerCase()))) delete pdf.columns;
    else pdf.columns = list;
    tidy('pdf');
  }
  return { config: out, problems };
}

/** The value columns `names` share in a field, or null when they differ. */
const shared = (f: Field, cfg: Config, names: string[], all: string[]) => {
  const values = new Set(names.map((n) => f.get(cfg, n, all)));
  return values.size === 1 ? [...values][0] : null;
};

/**
 * The property editor of columns `names` of region r (one or several): form#`formId` posting to the columns route.
 * `hasForm` false: the region type has no settings per column (the toolbar shows no Save).
 */
export async function columnProperties(o: { s: Session; appId: number; pageId: number; pageNo: number; region: RegionRow & { title: string | null }; names: string[]; list: ColumnList; formId: string }): Promise<{ body: Raw; hasForm: boolean }> {
  const { s, region: r, names, list, formId } = o;
  const tx = tr(s);
  const cfg = r.config ?? {};
  const all = list.columns.map((c) => c.name);
  const many = names.length > 1;
  const fields = (COLUMN_FIELDS[r.type] ?? []).filter((f) => !many || !f.single);
  const [pages, lovs, authz] = await Promise.all([
    owner.query<{ page_no: number; name: string }>('select page_no, name from meta.page where app_id = $1 order by page_no', [o.appId]).then((x) => x.rows),
    r.type === 'grid' ? owner.query<{ name: string }>('select name from meta.lov where app_id = $1 order by name', [o.appId]).then((x) => x.rows.map((l) => l.name)) : Promise.resolve([] as string[]),
    owner.query<{ name: string }>('select name from meta.authz_scheme where app_id = $1 order by name', [o.appId]).then((x) => x.rows.map((l) => l.name)),
  ]);
  const allowed: Allowed = { pages, lovs, authz };
  const cols = names.map((n) => list.columns.find((c) => c.name === n)!);
  const regionLink = designerUrl(o.appId, o.pageNo, `c=region-${r.id}`);
  const info = html`<fieldset class="prop-group"><legend>${tx('pdc.identification')}</legend>
    <dl class="pd-colinfo">
      <dt>${many ? tx('pdc.names') : tx('pdc.name')}</dt><dd>${cols.map((c, i) => html`${i ? ', ' : ''}<code>${c.name}</code>${c.stale ? html` <span class="tag tag-error">${tx('rs.not_in_query')}</span>` : ''}`)}</dd>
      ${many ? '' : html`<dt>${tx('pdc.data_type')}</dt><dd>${cols[0].type ?? '-'}</dd>`}
      ${!many && ROLES[r.type] ? html`<dt>${tx('pdc.role')}</dt><dd>${ROLES[r.type].includes(cols[0].name) ? tx.dyn(`pdc.role.${cols[0].name}`, cols[0].name) : tx('pdc.role.none', { name: `#${cols[0].name}#` })}</dd>` : ''}
      <dt>${tx('pdc.region')}</dt><dd><a href="${regionLink}">${r.title ?? r.type}</a></dd>
    </dl></fieldset>`;
  if (!fields.length) return { body: html`${info}<p class="muted">${tx('pdc.no_settings')}</p>${chooser(o, tx)}`, hasForm: false };

  const control = (f: Field) => {
    const value = shared(f, cfg, names, all);
    const mixed = value === null;
    const id = `f_col_${f.key}`;
    const keep = html`<input type="hidden" name="was_${f.key}" value="${value ?? ''}">${mixed ? html`<input type="hidden" name="mixed_${f.key}" value="1">` : ''}`;
    const help = f.help ? html`<small class="help">${f.help(tx)}</small>` : '';
    if (f.kind === 'bool' && !many)
      return html`<div class="field"><span class="label" aria-hidden="true"></span><label class="check"><input type="checkbox" id="${id}" name="${f.key}" value="true"${value === 'true' ? raw(' checked') : ''}> ${f.label(tx)}</label>${keep}${help}</div>`;
    const opts: [string, string][] = f.kind === 'bool' ? [['true', tx('pdc.yes')], ['false', tx('pdc.no')]] : f.kind === 'select' ? f.options!(tx, cfg, allowed) : [];
    const ph = mixed ? tx('pdc.mixed_text') : many || !f.placeholder ? '' : f.placeholder(names[0]);
    const ctl = f.kind === 'bool' || f.kind === 'select'
      ? html`<select id="${id}" name="${f.key}">${mixed ? html`<option value="__mixed__" selected>${tx('pdc.mixed')}</option>` : ''}${opts.map(([v, l]) => html`<option value="${v}"${!mixed && v === value ? raw(' selected') : ''}>${l}</option>`)}${!mixed && value && !opts.some(([v]) => v === value) ? html`<option value="${value}" selected>${value}</option>` : ''}</select>`
      : f.kind === 'textarea'
        ? html`<textarea id="${id}" name="${f.key}" rows="3" maxlength="4000" spellcheck="false" placeholder="${ph}">${value ?? ''}</textarea>`
        : html`<input id="${id}" name="${f.key}"${f.kind === 'number' ? raw(' type="number" min="0" max="500"') : ''} value="${value ?? ''}" placeholder="${ph}"${f.key === 'heading' ? raw(' maxlength="255"') : f.key === 'format' ? raw(' maxlength="64" class="code"') : ''}>`;
    return html`<div class="field"${f.kind === 'textarea' || f.key === 'link_items' ? raw(' data-wide') : ''}><label class="label" for="${id}">${f.label(tx)}</label>${ctl}${keep}${help}</div>`;
  };
  const groups = (['heading', 'appearance', 'link', 'editing', 'validation', 'printing', 'condition', 'security'] as const)
    .map((g) => [g, fields.filter((f) => f.group === g)] as const)
    .filter(([, list]) => list.length)
    .map(([g, list]) => html`<fieldset class="prop-group"><legend>${tx.dyn(`pdc.group.${g}`, g)}</legend><div class="form-grid">${list.map(control)}</div></fieldset>`);
  return {
    body: html`<form method="post" action="${BASE}/pages/${o.pageId}/region/${r.id}/columns" class="component-form" id="${formId}">${csrf(s)}
        ${names.map((n) => html`<input type="hidden" name="col" value="${n}">`)}
        ${many ? html`<p class="muted u-mt0">${tx('pdc.shared_help', { n: names.length })}</p>` : ''}
        ${info}${groups}
      </form>${chooser(o, tx)}`,
    hasForm: true,
  };
}

/** Select several columns of the region (a GET form: also without JavaScript); in the tree Ctrl+click does the same. */
function chooser(o: { appId: number; pageNo: number; region: RegionRow; names: string[]; list: ColumnList }, tx: Tx) {
  if (o.list.columns.length < 2) return '';
  return html`<details class="pd-colpick"${o.names.length > 1 ? raw(' open') : ''}><summary>${icon('check')} ${tx('pdc.select_columns')}</summary>
    <form method="get" action="${designerUrl(o.appId, o.pageNo)}" class="pd-colpick-form">
      <input type="hidden" name="c" value="column-${o.region.id}">
      <p class="help">${tx('pdc.select_help')}</p>
      <fieldset><legend class="sr-only">${tx('pdc.select_columns')}</legend>
        ${o.list.columns.map((c) => html`<label class="check"><input type="checkbox" name="col" value="${c.name}"${o.names.includes(c.name) ? raw(' checked') : ''}> <code>${c.name}</code></label>`)}
      </fieldset>
      <button class="btn btn-sm">${tx('pdc.select')}</button>
    </form></details>`;
}

// ---------------------------------------------------------------- route

/** The selected column names of ?col= (one or several), in the region's order; unknown names left out. */
export function selectedColumns(q: unknown, list: ColumnList): string[] {
  const wanted = new Set(([] as unknown[]).concat(q ?? []).filter((x): x is string => typeof x === 'string'));
  return list.columns.map((c) => c.name).filter((n) => wanted.has(n));
}

export async function regionColumnRoutes(app: FastifyInstance) {
  app.post(`${BASE}/pages/:pid/region/:rid/columns`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const { pid, rid } = req.params as { pid: string; rid: string };
    const r = /^\d{1,9}$/.test(pid) && /^\d{1,9}$/.test(rid)
      ? await owner.one(`select r.id, r.type, r.source, r.rest_source, r.config, p.app_id from meta.region r join meta.page p on p.id = r.page_id where r.id = $1 and r.page_id = $2`, [rid, pid])
      : undefined;
    if (!r || !COLUMN_REGION_TYPES.has(r.type)) return reply.code(404).send('Not found');
    const tx = tr(s);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const list = await regionColumns(r.app_id, r);
    const posted = [...new Set(([] as unknown[]).concat(b.col ?? []).filter((x): x is string => typeof x === 'string'))].slice(0, 500);
    const names = selectedColumns(posted, list);
    const to = (cols: string[]) => `${BASE}/pages/${pid}?c=column-${rid}${cols.map((n) => `&col=${encodeURIComponent(n)}`).join('')}`;
    const unknown = posted.filter((n) => !names.includes(n));
    if (!names.length || unknown.length) {
      flash(s, tx('pdc.unknown', { name: (unknown[0] ?? '').slice(0, 63) }), 'error');
      return back(reply, s, names.length ? to(names) : `${BASE}/pages/${pid}?c=region-${rid}`);
    }
    // only the fields whose value changed (was_<key>); a "Mixed" field is left as it is
    const changes: Record<string, string> = {};
    for (const f of COLUMN_FIELDS[r.type] ?? []) {
      if (f.single && names.length > 1) continue;
      const sent = b[f.key];
      // an unticked checkbox isn't sent: false, when the form drew it (was_<key>)
      const v = typeof sent === 'string' ? sent : sent === undefined && f.kind === 'bool' && names.length === 1 && typeof b[`was_${f.key}`] === 'string' ? 'false' : undefined;
      if (v === undefined || v === '__mixed__') continue;
      if (b[`mixed_${f.key}`] === '1' && v === '') continue;
      if (typeof b[`was_${f.key}`] === 'string' && b[`was_${f.key}`] === v && b[`mixed_${f.key}`] !== '1') continue;
      changes[f.key] = v.slice(0, 4000);
    }
    // a link's page and items, and a validation and its message, go together
    for (const pair of [['link_page', 'link_items'], ['validation', 'validation_message'], ['condition_type', 'condition_expr', 'condition_value']])
      if (pair.some((k) => k in changes)) for (const k of pair) changes[k] = typeof b[k] === 'string' ? (b[k] as string).slice(0, 4000) : '';
    const [pages, lovs, schemes] = await Promise.all([
      owner.query('select page_no from meta.page where app_id = $1', [r.app_id]),
      owner.query('select name from meta.lov where app_id = $1', [r.app_id]),
      owner.query('select name from meta.authz_scheme where app_id = $1', [r.app_id]),
    ]);
    // (sprint 210) a column's condition is checked as every component's is (meta.condition_ok)
    const conditionOk = 'condition_type' in changes && changes.condition_type.trim()
      ? (await owner.one<{ ok: boolean }>('select meta.condition_ok($1, $2, $3) as ok', [changes.condition_type.trim(), (changes.condition_expr ?? '').trim() || null, (changes.condition_value ?? '').trim() || null]))?.ok === true
      : true;
    // the PDF's column list: the query's columns (and those selected)
    const all = list.columns.filter((c) => !c.stale || names.includes(c.name)).map((c) => c.name);
    const { config, problems } = mergeColumnSettings(r.type, r.config ?? {}, names, all, changes,
      { pages: new Set(pages.rows.map((x) => x.page_no)), lovs: new Set(lovs.rows.map((x) => String(x.name).toUpperCase())), authz: new Set(schemes.rows.map((x) => String(x.name).toUpperCase())), conditionOk });
    if (Object.keys(changes).length) await owner.query('update meta.region set config = $2 where id = $1', [r.id, JSON.stringify(config)]);
    if (problems.length) flash(s, tx('pdc.saved_without', { problems: problems.join('; ') }), 'error');
    else flash(s, names.length === 1 ? tx('pdc.saved', { name: names[0] }) : tx('pdc.saved_n', { n: names.length }));
    return back(reply, s, to(names));
  });
}
