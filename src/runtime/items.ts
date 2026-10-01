import { applyBinds } from '../binds.ts';
import { icon } from '../icons.ts';
import { savepoint } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import type { Item } from '../metadata.ts';
import { bindValues, publicError, stripSemicolon, toState, type PageContext } from './context.ts';
import { canPreview, fileInfo, fileList, fileUrl, formatSize, isMultiple, maxFiles, removals } from './files.ts';

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
export async function lovOptions(ctx: PageContext, lov: string | null): Promise<LovOption[]> {
  if (!lov?.trim()) return [];
  const shared = /^LOV:([A-Z0-9_]+)$/i.exec(lov.trim());
  if (shared) {
    const def = ctx.app.lovs.find((l) => l.name === shared[1].toUpperCase());
    if (!def) throw new Error(`Shared list of values ${shared[1]} does not exist.`);
    lov = def.query;
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
  const c = ctx.client!;
  const res = await savepoint(c, () => c.query({ text: stripSemicolon(applyBinds(lov, bindValues(ctx))), rowMode: 'array' }));
  return res.rows.map((r: unknown[]) => ({ display: toState(r[0]) ?? '', value: toState(r.length > 1 ? r[1] : r[0]) ?? '' }));
}

const LOV_TYPES = new Set(['select', 'radio', 'checkbox_group', 'multiselect', 'popup_lov']);
const hasLov = (item: Item) => LOV_TYPES.has(item.type) || (item.type === 'display' && !!item.lov);
export const MULTI_VALUE = new Set(['checkbox_group', 'multiselect']);
/** Multi-value items store their values colon-separated, as in APEX. */
export const splitValues = (v: string) => (v ? v.split(':') : []);

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
      options = await lovOptions(ctx, item.lov);
    } catch (e) {
      lovError = html`<small class="error">${await publicError(ctx, e, `list of values of ${item.name}`)}</small>`;
    }
  }

  let control: Raw;
  let useLegend = false;
  if (item.type === 'file') {
    control = await fileControl(ctx, item, editable, aria);
  } else if (!editable) {
    let shown = value;
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
      case 'popup_lov':
        // a select list; app.js adds a search box that filters the options
        control = html`<select id="${id}" name="${id}" data-searchable${aria}>
          <option value="">${item.config?.null_label ?? ctx.locale.t('lov.none')}</option>
          ${options.map((o) => html`<option value="${o.value}"${o.value === value ? raw(' selected') : ''}>${o.display}</option>`)}
        </select>`;
        break;
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
        control = html`<input type="datetime-local" id="${id}" name="${id}" value="${value.slice(0, 16).replace(' ', 'T')}"${aria}>`;
        break;
      case 'location':
        // "lat,lng"; app.js fills it from the device (geolocation) with the button
        control = html`<div class="input-with-button"><input type="text" id="${id}" name="${id}" value="${value}" inputmode="decimal" placeholder="52.01160,4.35710"${aria}>
          <button type="button" class="btn" data-locate="${id}">${icon('map')} ${ctx.locale.t('item.locate')}</button></div>`;
        break;
      default: {
        const typed: Record<string, string> = { number: 'number', date: 'date', password: 'password', email: 'email', tel: 'tel', url: 'url' };
        const type = typed[item.type] ?? 'text';
        const shown = item.type === 'password' ? '' : value;
        // inputmode/autocomplete give phones the right keyboard
        const extra =
          type === 'number' ? ' step="any" inputmode="decimal"'
          : type === 'password' ? ' autocomplete="new-password"'
          : type === 'email' ? ' autocomplete="email" inputmode="email"'
          : type === 'tel' ? ' autocomplete="tel" inputmode="tel"'
          : type === 'url' ? ' inputmode="url"'
          : '';
        control = html`<input type="${type}" id="${id}" name="${id}" value="${shown}"${raw(extra)}${aria}>`;
        // {"scan": true}: a button that reads a barcode or QR code with the camera (where the browser can: app.js)
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
      item.config?.wide || item.type === 'textarea' ? 'data-wide' : '',
    ]
      .filter(Boolean)
      .map((a) => ` ${a}`)
      .join(''),
  );
  const tag = useLegend ? 'fieldset' : 'div';
  return html`${raw(`<${tag}`)} class="field field-${item.type}${error ? ' has-error' : ''}${editable ? '' : ' readonly'}" data-item="${item.name}"${attrs}>
    ${labelHtml}${control}${lovError}
    ${item.help ? html`<small class="help" id="${id}_help">${item.help}</small>` : ''}
    ${error ? html`<small class="error" id="${id}_error">${error}</small>` : ''}
  ${raw(`</${tag}>`)}`;
}

/**
 * A file item: the stored (or just uploaded) file with a preview for images,
 * a remove option, and the file input.
 */
/** The <input type="file"> of a file item, with its accept, capture and max_px attributes. */
function fileInput(item: Item, aria: Raw) {
  const conf = (item.config ?? {}) as { accept?: string; capture?: string; max_px?: number };
  // capture: open the camera on phones ("environment" = the back camera); max_px: photos are made smaller before upload (app.js)
  const capture = conf.capture === 'user' || conf.capture === 'environment' ? raw(` capture="${conf.capture}"`) : '';
  const maxPx = Number(conf.max_px) >= 200 && Number(conf.max_px) <= 8000 ? raw(` data-max-px="${Math.round(Number(conf.max_px))}"`) : '';
  const multiple = isMultiple(item) ? raw(' multiple') : '';
  return html`<input type="file" id="${item.name}" name="${item.name}"${conf.accept ? raw(` accept="${String(conf.accept).replace(/[^\w/*.,+ -]/g, '')}"`) : ''}${multiple}${capture}${maxPx}${aria}>`;
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
  return html`${list}${fileInput(item, aria)}<small class="help">${t('file.max_files', { max: String(maxFiles(item)) })}</small>`;
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
  return html`${current}${fileInput(item, aria)}`;
}

export async function renderItems(ctx: PageContext, items: Item[], hidden: Set<string> = new Set()) {
  const out: Raw[] = [];
  for (const i of items) {
    const r = await renderItem(ctx, i, hidden.has(i.name));
    if (r) out.push(r);
  }
  return out;
}
