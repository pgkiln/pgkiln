import { applyBinds } from '../binds.ts';
import { icon } from '../icons.ts';
import { templateClasses } from './template-options.ts';
import { savepoint } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import type { Item } from '../metadata.ts';
import { bindValues, publicError, stripSemicolon, toState, type PageContext } from './context.ts';
import { canPreview, fileInfo, fileList, fileUrl, formatSize, isMultiple, maxFiles, removals } from './files.ts';
import { restSql } from './rest-sources.ts';
import { markdownHtml, sanitizeHtml } from '../richtext.ts';
import { qrSvg, type Ecc } from '../qrcode.ts';
import { formatNumber, isPlainNumber, maskError } from '../numformat.ts';

const TRUTHY = new Set(['true', 't', 'on', '1', 'yes', 'y']);
export const isTruthy = (v: string | null | undefined) => !!v && TRUTHY.has(v.toLowerCase());

export const heading = (name: string) =>
  name.replace(/_/g, ' ').replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());

export interface LovOption {
  display: string;
  value: string;
}

/**
 * List of values: a SELECT returning (display, return), the static form
 * 'STATIC:Display;Return,Other;OTHER' (a lone entry is used for both), or a
 * shared list of values 'LOV:NAME'.
 */
export async function lovOptions(ctx: PageContext, lov: string | null, max = LOV_MAX_ROWS): Promise<LovOption[]> {
  const src = await lovSource(ctx, lov);
  if (!src) return [];
  if (Array.isArray(src)) return src;
  const c = ctx.client!;
  // at most `max` rows (an item's config.max_rows), so a big table can't flood the page
  const sql = `select * from (\n${src}\n) "__l" limit ${max}`;
  const res = await savepoint(c, () => c.query({ text: sql, rowMode: 'array' }));
  return res.rows.map((r: unknown[]) => ({ display: toState(r[0]) ?? '', value: toState(r.length > 1 ? r[1] : r[0]) ?? '' }));
}

/** A list of values as static options, or as SQL with the binds applied (null: none). */
async function lovSource(ctx: PageContext, lov: string | null): Promise<LovOption[] | string | null> {
  if (!lov?.trim()) return null;
  const shared = /^LOV:([A-Z0-9_]+)$/i.exec(lov.trim());
  if (shared) {
    const def = ctx.app.lovs.find((l) => l.name === shared[1].toUpperCase());
    if (!def) throw new Error(`Shared list of values ${shared[1]} does not exist.`);
    // a REST data source: the query reads its rows from the CTE "rest"
    lov = def.rest_source ? await restSql(ctx, def.rest_source, undefined, def.query) : def.query;
  }
  if (/^STATIC:/i.test(lov))
    return lov
      .slice(7)
      .split(',')
      .filter((s) => s.trim())
      .map((entry) => {
        const [display, value = display] = entry.split(';');
        return { display: display.trim(), value: value.trim() };
      });
  return stripSemicolon(applyBinds(lov, bindValues(ctx)));
}

/**
 * The LOV query with its columns renamed "c0", "c1", … (so a filter never
 * depends on the developer's column names) and the original headings.
 */
async function lovColumns(ctx: PageContext, sql: string) {
  const c = ctx.client!;
  const probe = await savepoint(c, () => c.query({ text: `select * from (\n${sql}\n) "__l" limit 0`, rowMode: 'array' }));
  const names = probe.fields.map((f: { name: string }) => f.name);
  const from = `(\n${sql}\n) "__l"(${names.map((_: string, i: number) => `"c${i}"`).join(', ')})`;
  return { names, from };
}

/** Rows of a popup LOV's dialog: at most 100 per page. */
export const POPUP_PAGE_MAX = 100;
export const popupPageSize = (item: Item, asked?: unknown) => {
  const n = Math.floor(Number(asked ?? item.config?.page_size ?? 25));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, POPUP_PAGE_MAX) : 25;
};

export interface LovPage {
  headings: string[];
  rows: { value: string; display: string; columns: string[] }[];
  more: boolean;
}

/**
 * Search a popup LOV: the term (a parameter, never SQL text) matched with
 * ILIKE against the display column and any extra columns (the return column
 * is the second one), one page of `size` rows.
 */
export async function searchLov(ctx: PageContext, item: Item, term: string, page: number, size: number): Promise<LovPage> {
  const src = await lovSource(ctx, item.lov);
  const q = term.trim().toLowerCase();
  const offset = Math.max(0, page) * size;
  if (!src) return { headings: [], rows: [], more: false };
  if (Array.isArray(src)) {
    const hits = src.filter((o) => !q || o.display.toLowerCase().includes(q));
    return {
      headings: [item.label ?? heading(item.name)],
      rows: hits.slice(offset, offset + size).map((o) => ({ ...o, columns: [o.display] })),
      more: hits.length > offset + size,
    };
  }
  const c = ctx.client!;
  const { names, from } = await lovColumns(ctx, src);
  const shown = names.map((_: string, i: number) => i).filter((i: number) => i !== 1 || names.length === 1);
  const where = q ? `where ${shown.map((i: number) => `"c${i}"::text ilike $1`).join(' or ')}` : '';
  const pattern = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const res = await savepoint(c, () =>
    c.query({ text: `select * from ${from} ${where} offset ${offset} limit ${size + 1}`, values: q ? [pattern] : [], rowMode: 'array' }),
  );
  const rows = res.rows.slice(0, size).map((r: unknown[]) => ({
    display: toState(r[0]) ?? '',
    value: toState(r.length > 1 ? r[1] : r[0]) ?? '',
    columns: shown.map((i: number) => toState(r[i]) ?? ''),
  }));
  return { headings: shown.map((i: number) => (i === 0 ? (item.label ?? heading(item.name)) : ctx.locale.tr(heading(names[i])))), rows, more: res.rows.length > size };
}

/** The LOV entry with this return value (a bind parameter), or null when the LOV doesn't return it. */
export async function lovLookup(ctx: PageContext, item: Item, value: string): Promise<LovOption | null> {
  const src = await lovSource(ctx, item.lov);
  if (!src) return null;
  if (Array.isArray(src)) return src.find((o) => o.value === value) ?? null;
  const c = ctx.client!;
  const { names, from } = await lovColumns(ctx, src);
  const ret = names.length > 1 ? 'c1' : 'c0';
  const res = await savepoint(c, () => c.query({ text: `select "c0", "${ret}" from ${from} where "${ret}"::text = $1 limit 1`, values: [value], rowMode: 'array' }));
  const r = res.rows[0] as unknown[] | undefined;
  return r ? { display: toState(r[0]) ?? '', value: toState(r[1]) ?? '' } : null;
}

/** Rows a list of values reads when its item sets no config.max_rows (1 to 50,000). */
export const LOV_MAX_ROWS = 5000;
export const lovMax = (item: Item) => {
  const n = Math.floor(Number(item.config?.max_rows));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 50_000) : LOV_MAX_ROWS;
};

const LOV_TYPES = new Set(['select', 'radio', 'checkbox_group', 'multiselect', 'popup_lov', 'combobox']);
const hasLov = (item: Item) => LOV_TYPES.has(item.type) || (item.type === 'display' && !!item.lov);
export const MULTI_VALUE = new Set(['checkbox_group', 'multiselect']);
/** Multi-value items store their values colon-separated, as in APEX. */
export const splitValues = (v: string) => (v ? v.split(':') : []);

/** A combobox holds several values (colon-separated) unless {"multiple": false}. */
export const comboMultiple = (item: Item) => item.config?.multiple !== false;
/** The highest star of a rating item ({"max": 5}, 3 to 10). */
export const ratingMax = (item: Item) => Math.min(Math.max(Math.round(Number(item.config?.max)) || 5, 3), 10);
/** A date range item's value "from:to" (ISO dates, either may be empty). */
export const splitRange = (v: string | null | undefined): [string, string] => {
  const [from = '', to = ''] = (v ?? '').split(':');
  return [from, to];
};

/** A number or display item's number format mask ({"format_mask": "999G990D00"}), when it is a valid one. */
export function itemMask(item: Item): string | null {
  if (item.type !== 'number' && item.type !== 'display') return null;
  const m = typeof item.config?.format_mask === 'string' ? item.config.format_mask.trim() : '';
  return m && !maskError(m) ? m : null;
}

/** The value as the item shows it: a number with the item's mask; anything else (e.g. text typed in error) as it is. */
function maskedValue(ctx: PageContext, item: Item, value: string) {
  const m = itemMask(item);
  if (!m || !value || !isPlainNumber(value)) return value;
  return formatNumber(value, m, ctx.locale.numbers) ?? value;
}

/** "lat,lng" with decimals */
const LOCATION = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

/** Render one item (field wrapper included). Hidden items are never rendered. */
export async function renderItem(ctx: PageContext, item: Item, hiddenByDa = false): Promise<Raw | ''> {
  if (item.type === 'hidden' || !ctx.vis!.items.has(item.name)) return '';
  const value = ctx.session.state[item.name] ?? item.default_value ?? '';
  const id = item.name;
  const error = ctx.errors.items[item.name];
  const editable = ctx.vis!.editable.has(item.name);
  const label = item.label ?? ctx.locale.tr(heading(item.name));
  const described = [item.help ? `${id}_help` : '', error ? `${id}_error` : ''].filter(Boolean).join(' ') || null;
  const aria = raw(
    `${described ? ` aria-describedby="${described}"` : ''}${error ? ' aria-invalid="true"' : ''}${item.required && editable ? ' aria-required="true"' : ''}`,
  );

  let options: LovOption[] = [];
  let lovError: Raw | '' = '';
  if (hasLov(item)) {
    try {
      options = await lovOptions(ctx, item.lov, lovMax(item));
    } catch (e) {
      lovError = html`<small class="error">${await publicError(ctx, e, `list of values of ${item.name}`)}</small>`;
    }
    // a popup LOV's value may be beyond the rows the page reads: look it up
    if (item.type === 'popup_lov' && value && !lovError && !options.some((o) => o.value === value)) {
      const current = await lovLookup(ctx, item, value).catch(() => null);
      if (current) options = [current, ...options];
    }
  }

  let control: Raw;
  let useLegend = false;
  if (item.type === 'file') {
    control = await fileControl(ctx, item, editable, aria);
  } else if (item.type === 'qrcode') {
    control = qrControl(ctx, item, value);
  } else if (!editable && (item.type === 'richtext' || item.type === 'markdown')) {
    // rebuilt from the allow-list every time: the value may come from the table, not from this form
    control = html`<div class="display-value rich-text" id="${id}">${raw((item.type === 'markdown' ? markdownHtml(value) : sanitizeHtml(value)) || ' ')}</div>`;
  } else if (!editable && item.type === 'rating') {
    const n = /^\d+$/.test(value) ? Math.min(Number(value), ratingMax(item)) : 0;
    control = n
      ? html`<div class="display-value rating-value" id="${id}"><span aria-hidden="true">${'★'.repeat(n)}<span class="rating-off">${'★'.repeat(ratingMax(item) - n)}</span></span><span class="sr-only">${ctx.locale.t('item.rating_of', { n, max: ratingMax(item) })}</span></div>`
      : html`<div class="display-value" id="${id}"> </div>`;
  } else if (!editable && item.type === 'combobox') {
    const values = comboMultiple(item) ? splitValues(value) : value ? [value] : [];
    control = html`<div class="display-value" id="${id}">${values.length ? values.map((v) => html`<span class="tag">${options.find((o) => o.value === v)?.display ?? v}</span> `) : ' '}</div>`;
  } else if (!editable && item.type === 'daterange') {
    const [from, to] = splitRange(value);
    control = html`<div class="display-value" id="${id}">${value ? `${from} – ${to}` : ' '}</div>`;
  } else if (!editable) {
    let shown = maskedValue(ctx, item, value);
    if (hasLov(item))
      shown = MULTI_VALUE.has(item.type)
        ? splitValues(value).map((v) => options.find((o) => o.value === v)?.display ?? v).join(', ')
        : (options.find((o) => o.value === value)?.display ?? value);
    if (item.type === 'checkbox' || item.type === 'switch') shown = isTruthy(value) ? ctx.locale.t('item.yes') : ctx.locale.t('item.no');
    if (item.type === 'password') shown = value ? '••••••••' : '';
    const at = item.type === 'location' ? LOCATION.exec(value) : null;
    control = at
      ? html`<div class="display-value" id="${id}">${value} <a href="https://www.openstreetmap.org/?mlat=${at[1]}&amp;mlon=${at[2]}#map=17/${at[1]}/${at[2]}" target="_blank" rel="noopener noreferrer">${ctx.locale.t('item.show_map')}</a></div>`
      : html`<div class="display-value" id="${id}">${shown || ' '}</div>`;
  } else {
    switch (item.type) {
      case 'textarea':
        control = html`<textarea id="${id}" name="${id}" rows="${item.config?.rows ?? 4}"${aria}>${value}</textarea>`;
        break;
      case 'checkbox':
      case 'switch':
        control = html`<label class="check${item.type === 'switch' ? ' switch' : ''}"><input type="checkbox" id="${id}" name="${id}" value="true"${
          item.type === 'switch' ? raw(' role="switch"') : ''
        }${isTruthy(value) ? raw(' checked') : ''}${aria}><span>${label}</span></label>`;
        break;
      case 'checkbox_group': {
        useLegend = true;
        const selected = new Set(splitValues(value));
        control = html`<div class="radio-group">${options.map(
          (o, i) =>
            html`<label class="check"><input type="checkbox" id="${i === 0 ? id : `${id}_${i}`}" name="${id}" value="${o.value}"${selected.has(o.value) ? raw(' checked') : ''}${aria}> ${o.display}</label>`,
        )}</div>`;
        break;
      }
      case 'multiselect': {
        const selected = new Set(splitValues(value));
        control = html`<select id="${id}" name="${id}" multiple size="${Math.min(Math.max(options.length, 3), 8)}"${aria}>
          ${options.map((o) => html`<option value="${o.value}"${selected.has(o.value) ? raw(' selected') : ''}>${o.display}</option>`)}
        </select>`;
        break;
      }
      case 'popup_lov': {
        // a select list (the LOV's first max_rows rows) that works without JavaScript; app.js
        // turns it into a field with a button that searches the whole LOV on the server
        const t = ctx.locale.t;
        control = html`<select id="${id}" name="${id}" data-popup-lov="${ctx.base}/${ctx.page.page_no}/lov/${id}/search" data-search-label="${t('lov.search')}" data-choose-label="${t('lov.choose')}" data-close-label="${t('lov.close')}" data-more-label="${t('lov.more')}" data-none-label="${t('lov.no_rows')}"${aria}>
          <option value="">${item.config?.null_label ?? t('lov.none')}</option>
          ${options.map((o) => html`<option value="${o.value}"${o.value === value ? raw(' selected') : ''}>${o.display}</option>`)}
        </select>`;
        break;
      }
      case 'color':
        control = html`<input type="color" id="${id}" name="${id}" value="${/^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'}"${aria}>`;
        break;
      case 'select':
        control = html`<select id="${id}" name="${id}"${aria}>
          ${item.config?.null_label === false ? '' : html`<option value="">${item.config?.null_label ?? ctx.locale.t('lov.none')}</option>`}
          ${options.map((o) => html`<option value="${o.value}"${o.value === value ? raw(' selected') : ''}>${o.display}</option>`)}
        </select>`;
        break;
      case 'radio':
        useLegend = true;
        control = html`<div class="radio-group">${options.map(
          (o, i) =>
            html`<label class="check"><input type="radio" id="${i === 0 ? id : `${id}_${i}`}" name="${id}" value="${o.value}"${o.value === value ? raw(' checked') : ''}${aria}> ${o.display}</label>`,
        )}</div>`;
        break;
      case 'datetime':
        // a date alone (e.g. from a calendar's create link) is midnight
        control = html`<input type="datetime-local" id="${id}" name="${id}" value="${/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00` : value.slice(0, 16).replace(' ', 'T')}"${aria}>`;
        break;
      case 'richtext':
      case 'markdown': {
        // a plain textarea (HTML or Markdown) that works without JavaScript; app.js adds the
        // toolbar (and, for rich text, an editable area in place of the textarea)
        const rich = item.type === 'richtext';
        const t = ctx.locale.t;
        const tool = (cmd: string, key: string, glyph: string) =>
          html`<button type="button" class="btn rte-btn" data-cmd="${cmd}" title="${t(key)}"><span aria-hidden="true">${glyph}</span><span class="sr-only">${t(key)}</span></button>`;
        control = html`<div class="rte" data-${rich ? 'richtext' : 'markdown'}="${id}">
          <div class="rte-toolbar" role="toolbar" aria-label="${t('editor.toolbar')}" aria-controls="${id}" hidden>
            ${tool('bold', 'editor.bold', 'B')}${tool('italic', 'editor.italic', 'I')}${rich ? tool('underline', 'editor.underline', 'U') : ''}${tool('strike', 'editor.strike', 'S')}
            ${tool('heading', 'editor.heading', 'H')}${rich ? tool('paragraph', 'editor.paragraph', '¶') : ''}${tool('bullets', 'editor.bullets', '•')}${tool('numbers', 'editor.numbers', '1.')}
            ${tool('quote', 'editor.quote', '❝')}${tool('code', 'editor.code', '</>')}
            <button type="button" class="btn rte-btn" data-cmd="link" data-prompt="${t('editor.link_prompt')}" title="${t('editor.link')}"><span aria-hidden="true">↗</span><span class="sr-only">${t('editor.link')}</span></button>
            ${rich ? html`${tool('unlink', 'editor.unlink', '⊘')}${tool('clear', 'editor.clear', 'Tx')}` : ''}
          </div>
          <textarea id="${id}" name="${id}" rows="${item.config?.rows ?? 8}"${aria}>${rich ? sanitizeHtml(value) : value}</textarea>
          <small class="help rte-hint">${t(rich ? 'item.richtext_hint' : 'item.markdown_hint')}</small>
        </div>`;
        break;
      }
      case 'rating': {
        // radio buttons (keyboard and screen readers as usual); CSS draws them as stars
        useLegend = true;
        const max = ratingMax(item);
        const stars = [];
        for (let n = 1; n <= max; n++)
          stars.push(
            html`<input type="radio" id="${n === 1 ? id : `${id}_${n}`}" name="${id}" value="${n}"${value === String(n) ? raw(' checked') : ''}${aria}><label class="star" for="${n === 1 ? id : `${id}_${n}`}"><span aria-hidden="true">★</span><span class="sr-only">${ctx.locale.t('item.rating_of', { n, max })}</span></label>`,
          );
        // the "no rating" choice comes first, so CSS can dim the stars after the checked one (it is shown last)
        control = html`<div class="rating">${
          item.required
            ? ''
            : html`<input type="radio" id="${id}_0" name="${id}" value=""${value === '' ? raw(' checked') : ''}${aria}><label class="rating-clear" for="${id}_0">${ctx.locale.t('item.rating_none')}</label>`
        }${stars}</div>`;
        break;
      }
      case 'combobox': {
        // free text with suggestions (a datalist); app.js turns a multiple combobox into tags
        const multiple = comboMultiple(item);
        control = html`<div class="combobox"${multiple ? html` data-tags="${id}" data-remove-label="${ctx.locale.t('item.tag_remove')}"` : ''}>
          <input type="text" id="${id}" name="${id}" value="${value}" list="${id}_list" autocomplete="off"${aria}>
          <datalist id="${id}_list">${options.map((o) => html`<option value="${o.value}">${o.display === o.value ? '' : o.display}</option>`)}</datalist>
          ${multiple ? html`<small class="help tags-hint">${ctx.locale.t('item.tags_hint')}</small>` : ''}
        </div>`;
        break;
      }
      case 'daterange': {
        // two date inputs with the same name: posted in order, stored as "from:to"
        useLegend = true;
        const [from, to] = splitRange(value);
        const t = ctx.locale.t;
        control = html`<div class="date-range" data-range="${id}">
          <span class="range-part"><label class="sub" for="${id}">${t('item.range_from')}</label><input type="date" id="${id}" name="${id}" value="${from}"${to ? html` max="${to}"` : ''}${aria}></span>
          <span class="range-part"><label class="sub" for="${id}_TO">${t('item.range_to')}</label><input type="date" id="${id}_TO" name="${id}" value="${to}"${from ? html` min="${from}"` : ''}${aria}></span>
        </div>`;
        break;
      }
      case 'location':
        // "lat,lng"; app.js fills it from the device (geolocation) with the button
        control = html`<div class="input-with-button"><input type="text" id="${id}" name="${id}" value="${value}" inputmode="decimal" placeholder="52.01160,4.35710"${aria}>
          <button type="button" class="btn" data-locate="${id}">${icon('map')} ${ctx.locale.t('item.locate')}</button></div>`;
        break;
      default: {
        const typed: Record<string, string> = { number: 'number', date: 'date', password: 'password', email: 'email', tel: 'tel', url: 'url' };
        // a number with a format mask is text in the language's notation (1.234,50), read back on submit
        const masked = !!itemMask(item);
        const type = masked ? 'text' : (typed[item.type] ?? 'text');
        const shown = item.type === 'password' ? '' : masked ? maskedValue(ctx, item, value) : value;
        // inputmode/autocomplete give phones the right keyboard
        const extra =
          masked ? ' inputmode="decimal" autocomplete="off"'
          : type === 'number' ? ' step="any" inputmode="decimal"'
          : type === 'password' ? ' autocomplete="new-password"'
          : type === 'email' ? ' autocomplete="email" inputmode="email"'
          : type === 'tel' ? ' autocomplete="tel" inputmode="tel"'
          : type === 'url' ? ' inputmode="url"'
          : '';
        control = html`<input type="${type}" id="${id}" name="${id}" value="${shown}"${raw(extra)}${aria}>`;
        // {"scan": true}: a button that reads a barcode or QR code with the camera (where the browser can: app.js)
        // {"reveal": true}: a button that shows the password while typing (app.js shows the button)
        if (item.type === 'password' && item.config?.reveal)
          control = html`<div class="input-with-button">${control}<button type="button" class="btn" data-reveal="${id}" aria-controls="${id}" aria-pressed="false" data-hide="${ctx.locale.t('item.password_hide')}" hidden>${ctx.locale.t('item.password_show')}</button></div>`;
        if (item.config?.scan && type === 'text')
          control = html`<div class="input-with-button">${control}<button type="button" class="btn" data-scan="${id}" hidden>${icon('scan')} ${ctx.locale.t('item.scan')}</button></div>`;
      }
    }
  }

  const isCheck = editable && (item.type === 'checkbox' || item.type === 'switch');
  const labelHtml = isCheck
    ? html`<span class="label" aria-hidden="true"></span>`
    : useLegend
      ? html`<legend class="label">${label}${item.required ? html`<span class="req" aria-hidden="true">*</span>` : ''}</legend>`
      : html`<label class="label" for="${id}">${label}${item.required && editable ? html`<span class="req" aria-hidden="true">*</span>` : ''}</label>`;
  const attrs = raw(
    [
      item.config?.submit_on_change ? 'data-submit-on-change' : '',
      item.config?.cascade_parents ? `data-cascade="${String(item.config.cascade_parents).replace(/[^A-Z0-9_,]/gi, '')}"` : '',
      hiddenByDa ? 'hidden' : '',
      item.config?.wide || item.type === 'textarea' || item.type === 'richtext' || item.type === 'markdown' || templateClasses('item', item.template_options).includes(' to-stretch') ? 'data-wide' : '',
    ]
      .filter(Boolean)
      .map((a) => ` ${a}`)
      .join(''),
  );
  const tag = useLegend ? 'fieldset' : 'div';
  return html`${raw(`<${tag}`)} class="field field-${item.type}${error ? ' has-error' : ''}${editable ? '' : ' readonly'}${templateClasses('item', item.template_options)}" data-item="${item.name}"${attrs}>
    ${labelHtml}${control}${lovError}
    ${item.help ? html`<small class="help" id="${id}_help">${item.help}</small>` : ''}
    ${error ? html`<small class="error" id="${id}_error">${error}</small>` : ''}
  ${raw(`</${tag}>`)}`;
}

/** A QR code of the item's value ({"ecc": "L|M|Q|H", "size": 200}), drawn on the server as SVG. */
function qrControl(ctx: PageContext, item: Item, value: string) {
  if (!value) return html`<div class="display-value" id="${item.name}"> </div>`;
  const ecc: Ecc = ['L', 'M', 'Q', 'H'].includes(item.config?.ecc) ? item.config.ecc : 'M';
  const size = Number(item.config?.size) || undefined;
  const svg = value.length <= 2000 ? qrSvg(value, { ecc, px: size, label: ctx.locale.t('item.qr_label', { value: value.slice(0, 200) }) }) : null;
  if (!svg) return html`<div class="display-value" id="${item.name}"><small class="error">${ctx.locale.t('item.qr_too_long')}</small></div>`;
  return html`<div class="qr" id="${item.name}">${raw(svg)}${item.config?.show_value ? html`<small class="help">${value}</small>` : ''}</div>`;
}

/**
 * A file item: the stored (or just uploaded) file with a preview for images,
 * a remove option, and the file input.
 */
/** The <input type="file"> of a file item, with its accept, capture and max_px attributes. */
function fileInput(ctx: PageContext, item: Item, aria: Raw) {
  const conf = (item.config ?? {}) as { accept?: string; capture?: string; max_px?: number };
  // capture: open the camera on phones ("environment" = the back camera); max_px: photos are made smaller before upload (app.js)
  const capture = conf.capture === 'user' || conf.capture === 'environment' ? raw(` capture="${conf.capture}"`) : '';
  const maxPx = Number(conf.max_px) >= 200 && Number(conf.max_px) <= 8000 ? raw(` data-max-px="${Math.round(Number(conf.max_px))}"`) : '';
  const multiple = isMultiple(item) ? raw(' multiple') : '';
  // data-drop: app.js turns the field into a drop zone that also takes pasted files, with this hint
  const drop = ctx.locale.t(isMultiple(item) ? 'file.drop_many' : 'file.drop');
  return html`<input type="file" id="${item.name}" name="${item.name}"${conf.accept ? raw(` accept="${String(conf.accept).replace(/[^\w/*.,+ -]/g, '')}"`) : ''}${multiple}${capture}${maxPx} data-drop="${drop}"${aria}>`;
}

/** A multiple file item: its files (stored and new), each with a remove box, and the file input. */
async function fileListControl(ctx: PageContext, item: Item, editable: boolean, aria: Raw) {
  const t = ctx.locale.t;
  let files;
  try {
    files = await fileList(ctx, item);
  } catch (e) {
    return html`<small class="error">${await publicError(ctx, e, `files of ${item.name}`)}</small>`;
  }
  const ticked = new Set(removals(ctx, item));
  const list = files.length
    ? html`<ul class="file-list">${files.map(
        (f) => html`<li>
          ${canPreview(f) ? html`<img class="file-thumb" src="${fileUrl(ctx, item, f, true)}" alt="">` : ''}
          <span><a href="${fileUrl(ctx, item, f)}" download>${f.filename}</a> <small class="help">${formatSize(f.size)}${f.pending ? ` · ${t('file.new')}` : ''}</small></span>
          ${editable ? html`<label class="check"><input type="checkbox" name="${item.name}__REMOVE" value="${f.key}"${ticked.has(f.key) ? raw(' checked') : ''}> ${t('file.remove')}</label>` : ''}
        </li>`,
      )}</ul>`
    : '';
  if (!editable) return html`<div class="display-value" id="${item.name}">${list || t('file.none')}</div>`;
  return html`${list}${fileInput(ctx, item, aria)}<small class="help">${t('file.max_files', { max: String(maxFiles(item)) })}</small>`;
}

async function fileControl(ctx: PageContext, item: Item, editable: boolean, aria: Raw) {
  if (isMultiple(item)) return fileListControl(ctx, item, editable, aria);
  const t = ctx.locale.t;
  const id = item.name;
  let f;
  try {
    f = await fileInfo(ctx, item);
  } catch (e) {
    return html`<small class="error">${await publicError(ctx, e, `file of ${item.name}`)}</small>`;
  }
  const current = f
    ? html`<div class="file-current">
        ${canPreview(f) ? html`<img class="file-preview" src="${fileUrl(ctx, item, f, true)}" alt="">` : ''}
        <span><a href="${fileUrl(ctx, item, f)}" download>${f.filename}</a> <small class="help">${formatSize(f.size)}${f.pending ? ` · ${t('file.new')}` : ''}</small></span>
        ${editable && !f.pending ? html`<label class="check"><input type="checkbox" name="${id}__REMOVE" value="true"> ${t('file.remove')}</label>` : ''}
      </div>`
    : '';
  if (!editable) return html`<div class="display-value" id="${id}">${current || t('file.none')}</div>`;
  return html`${current}${fileInput(ctx, item, aria)}`;
}

export async function renderItems(ctx: PageContext, items: Item[], hidden: Set<string> = new Set()) {
  const out: Raw[] = [];
  for (const i of items) {
    const r = await renderItem(ctx, i, hidden.has(i.name));
    if (r) out.push(r);
  }
  return out;
}
