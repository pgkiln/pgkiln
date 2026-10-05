import pg from 'pg';
import { literal } from '../binds.ts';
import { savepoint, type Client } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import type { Button, Process, Region } from '../metadata.ts';
import { checksumValid, urlChecksum } from '../security.ts';
import { isAuthorized, pageAllowed } from './authz.ts';
import { publicError, toState, type PageContext } from './context.ts';
import { arrange, cleanLayout, currentLayout, defaultLayout, layoutJson, layoutParam, MAX_FROZEN, MAX_WIDTH, MIN_WIDTH, parseLayout, type GridLayout, type Placed } from './grid-layout.ts';
import { lovOptions, type LovOption } from './items.ts';
import { fillItems, linkAttrs } from './links.ts';
import { detailsOf, masterColumnOf, masterItemOf, selectHref, selectRowOf } from './master-detail.ts';
import { aggregateRows, AGGREGATES, buildSql, cell, headingOf, key, pageInfo, pagerNav, regionUrl, reportParams, reportState, visibleColumns, type ReportState } from './report.ts';

// Interactive grid: an editable report on one table (APEX's Interactive
// Grid). The region's SELECT must include the table's primary key column.
//
//   config: {"page_size": 25,
//            "allow": {"insert": true, "update": true, "delete": true},
//            "columns": {"deptno": {"lov": "LOV:DEPARTMENTS"}, "sal": {"required": true}},
//            "readonly": ["hiredate"],
//            "aggregates": {"sal": ["sum", "avg"], "empno": "count"},
//            "layout": {"order": ["ename", "sal"], "hidden": ["comm"], "widths": {"ename": 180}, "frozen": 1},
//            "row_actions": {"edit": {"page": 3, "items": {"P3_EMPNO": "#empno#"}}, "duplicate": true,
//                            "delete": true, "links": [{"label": "Reviews", "page": 20, "items": {...}}]},
//            "select_row": {"column": "deptno", "item": "P27_DEPTNO"},   (a master grid, see master-detail.ts)
//            "master": {"item": "P27_DEPTNO", "column": "deptno"},      (a detail grid)
//            "actions": true, "saved_reports": true, "public_reports": "ADMIN"}
//
// Aggregates are computed in the database over every row of the search (not
// only the page). The layout is the developer's default; each user arranges
// their own (Actions → Columns, or drag and resize with JavaScript), kept per
// user (grid-layout.ts) and in saved grid reports. Input names keep the
// query's column positions (c<n>), whatever order the columns are shown in.
//
// Saved by a process of type 'grid_dml' for the region, which runs when the
// grid's own Save button (request GRID_SAVE_<region id>) is pressed.
//
// Security: each existing row posts its primary key together with an HMAC
// bound to app, page, user and region, so the browser cannot redirect an
// update or delete to another row. Only columns of the table that are not
// the key, generated, identity-always or read-only are writable. RLS and
// grants of the app role apply as always.

const ident = pg.escapeIdentifier;
const NUMERIC = new Set([20, 21, 23, 26, 700, 701, 1700]);

export const saveRequest = (r: Region) => `GRID_SAVE_${r.id}`;

/** The synthetic Save button of a grid region (see authz.computeVisibility). */
export const saveButton = (r: Region): Button => ({
  id: -r.id, region_id: r.id, seq: 0, name: saveRequest(r), label: 'Save', action: 'submit',
  target_page: null, target_items: {}, condition: null, authz: null, hot: true, confirm: null,
});

const allow = (r: Region, op: 'insert' | 'update' | 'delete') => r.config.allow?.[op] !== false;

interface GridColumn {
  name: string;
  typeOid: number;
  editable: boolean;
  required: boolean;
  options?: LovOption[];
}

async function writableColumns(c: Client, r: Region) {
  const res = await savepoint(c, () =>
    c.query(
      `select attname from pg_attribute
        where attrelid = $1::regclass and attnum > 0 and not attisdropped
          and attgenerated = '' and attidentity <> 'a'`,
      [r.table_name],
    ),
  );
  const readonly = new Set<string>((r.config.readonly ?? []).map((x: string) => x.toLowerCase()));
  // a detail grid's master column gets the master's value on new rows, and is never edited
  const master = masterColumnOf(r)?.toLowerCase();
  return new Set(res.rows.map((x) => x.attname as string).filter((n) => n !== r.pk_column && !readonly.has(n.toLowerCase()) && n.toLowerCase() !== master));
}

const rowToken = (ctx: PageContext, r: Region, pk: string) => urlChecksum(ctx.app.id, ctx.page.page_no, ctx.user, { [`G${r.id}`]: pk });

// ---------------------------------------------------------------- render

function control(col: GridColumn, name: string, value: string, label: string) {
  const aria = raw(` aria-label="${label.replace(/"/g, '&quot;')}"`);
  if (col.options)
    return html`<select name="${name}"${aria}><option value=""></option>${col.options.map(
      (o) => html`<option value="${o.value}"${o.value === value ? raw(' selected') : ''}>${o.display}</option>`,
    )}</select>`;
  if (col.typeOid === 16)
    return html`<input type="checkbox" name="${name}" value="true"${value === 'true' ? raw(' checked') : ''}${aria}>`;
  if (NUMERIC.has(col.typeOid)) return html`<input type="number" step="any" inputmode="decimal" name="${name}" value="${value}"${aria}>`;
  if (col.typeOid === 1082) return html`<input type="date" name="${name}" value="${value}"${aria}>`;
  if (col.typeOid === 1114 || col.typeOid === 1184)
    return html`<input type="datetime-local" name="${name}" value="${value.slice(0, 16).replace(' ', 'T')}"${aria}>`;
  return html`<input type="text" name="${name}" value="${value}"${aria}>`;
}

/** Width of each leading column (master selection, delete, row actions), see app.css .grid-lead. */
const LEAD_WIDTH = 44;

/**
 * The grid's aggregates: the developer's (config.aggregates: {"sal": ["sum", "avg"]})
 * and the user's (r<id>_a=fn|column from Actions → Aggregate), each once.
 */
export function gridAggregates(r: Region, st: ReportState) {
  const out: { fn: string; column: string; raw: string; own: boolean }[] = [];
  const add = (fn: string, column: string, own: boolean) => {
    if (AGGREGATES[fn] && column && !out.some((a) => a.fn === fn && a.column === column)) out.push({ fn, column, raw: `${fn}|${column}`, own });
  };
  const cfg = r.config.aggregates;
  if (cfg && typeof cfg === 'object' && !Array.isArray(cfg))
    for (const [column, fns] of Object.entries(cfg as Record<string, unknown>)) for (const fn of [fns].flat()) if (typeof fn === 'string') add(fn, column, false);
  for (const a of st.aggregates) add(a.fn, a.column, true);
  return out.slice(0, 20);
}

interface RowLink {
  label?: string;
  page: number;
  items?: Record<string, string>;
}

/** config.row_actions: {"edit": {page, items}, "duplicate": true, "delete": true, "links": [{label, page, items}]} */
function rowActionsOf(r: Region): { edit: RowLink | null; duplicate: boolean; delete: boolean; links: RowLink[] } | null {
  const ra = r.config.row_actions;
  if (!ra || typeof ra !== 'object') return null;
  const link = (x: any): RowLink | null => (x && Number.isInteger(Number(x.page)) ? { label: typeof x.label === 'string' ? x.label : undefined, page: Number(x.page), items: x.items && typeof x.items === 'object' ? x.items : undefined } : null);
  return {
    edit: link(ra.edit),
    duplicate: ra.duplicate !== false,
    delete: ra.delete !== false,
    links: (Array.isArray(ra.links) ? ra.links : []).map(link).filter((x: RowLink | null): x is RowLink => !!x?.label).slice(0, 10),
  };
}

export async function renderGrid(ctx: PageContext, r: Region): Promise<Raw> {
  const c = ctx.client!;
  const t = ctx.locale.t;
  const tr = ctx.locale.tr;
  if (!r.table_name || !r.pk_column) return html`<div class="alert alert-error">Grid regions need a table and a primary key column.</div>`;
  const base = reportState(ctx, r);
  const st = { ...base, size: Math.max(1, Math.min(200, Number(r.config.page_size) || 25)), breakCol: null, view: 'report' as const };
  const aggs = gridAggregates(r, st);
  let res: pg.QueryResult<any[]>;
  let writable: Set<string>;
  let agg: Awaited<ReturnType<typeof aggregateRows>> = null;
  try {
    writable = await writableColumns(c, r);
    res = await savepoint(c, async () => c.query({ ...(await buildSql(ctx, r, st, 'page')), rowMode: 'array' }));
  } catch (e) {
    return html`<div class="alert alert-error" role="alert">${await publicError(ctx, e, `grid "${r.title ?? r.id}"`)}</div>`;
  }
  const totalIdx = res.fields.findIndex((f) => f.name === '__total');
  const fields = res.fields.slice(0, totalIdx);
  const info = pageInfo(r, st, res.rows, totalIdx);
  const pkIdx = fields.findIndex((f) => f.name === r.pk_column);
  if (pkIdx === -1) return html`<div class="alert alert-error">The grid query must select the primary key column ${r.pk_column}.</div>`;
  if (aggs.length)
    try {
      agg = await aggregateRows(ctx, r, { ...st, aggregates: aggs }, (col) => NUMERIC.has(fields.find((f) => f.name === col)?.dataTypeID ?? 0));
    } catch (e) {
      return html`<div class="alert alert-error" role="alert">${await publicError(ctx, e, `grid "${r.title ?? r.id}" aggregates`)}</div>`;
    }

  // Without a grid_dml process the grid is read-only (no Save/Add/Delete).
  const savable = ctx.vis!.buttons.has(saveRequest(r));
  const cfg = r.config.columns ?? {};
  const cols: (GridColumn & { idx: number; ci: number })[] = [];
  for (const { f, i } of visibleColumns(r, fields)) {
    const col: GridColumn & { idx: number; ci: number } = {
      name: f.name, typeOid: f.dataTypeID, idx: i, ci: cols.length,
      editable: savable && writable.has(f.name) && allow(r, 'update'),
      required: !!cfg[f.name]?.required,
    };
    if (cfg[f.name]?.lov) col.options = await lovOptions(ctx, cfg[f.name].lov).catch(() => []);
    cols.push(col);
  }
  const insertable = savable && allow(r, 'insert') && cols.some((x) => writable.has(x.name));
  const deletable = savable && allow(r, 'delete');
  const g = `g${r.id}`;
  const posted = ctx.body && Object.keys(ctx.body).some((k) => k.startsWith(`${g}_`)) ? ctx.body : null;
  const postedByPk = new Map<string, number>();
  if (posted) for (const k of Object.keys(posted)) {
    const m = new RegExp(`^${g}_(\\d+)_pk$`).exec(k);
    if (m) postedByPk.set(String(posted[k]), Number(m[1]));
  }
  const pv = (k: string) => {
    const v = posted?.[k];
    return Array.isArray(v) ? String(v[v.length - 1]) : v === undefined ? undefined : String(v);
  };

  // master-detail: this grid selects rows for detail regions; or it follows a master
  const select = selectRowOf(ctx.page, r);
  const selIdx = select ? fields.findIndex((f) => f.name.toLowerCase() === select.column.toLowerCase()) : -1;
  const selected = select ? ctx.session.state[select.item] ?? null : null;
  const details = select ? detailsOf(ctx.page, r, ctx.vis!.regions) : [];
  const masterCol = masterColumnOf(r);
  const masterValue = masterItemOf(r) ? ctx.session.state[masterItemOf(r)!] ?? '' : '';

  // row actions: edit and custom links go only to pages this user may open
  const actions = rowActionsOf(r);
  const pageOk = new Map<number, boolean>();
  for (const l of [actions?.edit, ...(actions?.links ?? [])]) if (l && !pageOk.has(l.page)) pageOk.set(l.page, await pageAllowed(ctx, l.page));
  const editLink = actions?.edit && pageOk.get(actions.edit.page) ? actions.edit : null;
  const extraLinks = (actions?.links ?? []).filter((l) => pageOk.get(l.page));
  const canDuplicate = !!actions?.duplicate && insertable;
  const canDelete = !!actions?.delete && deletable;
  const hasActions = !!(editLink || extraLinks.length || canDuplicate || canDelete);

  // layout: order, hidden, widths, frozen; the leading columns come first and freeze along
  const { layout, own: ownLayout } = await currentLayout(ctx, r);
  const leads = [select && selIdx >= 0 ? 'pick' : null, deletable ? 'sel' : null, hasActions ? 'act' : null].filter(Boolean) as string[];
  const placed = arrange(cols, layout, leads.length * LEAD_WIDTH);
  const frozenAny = placed.some((p) => p.frozen);
  const lastFrozen = placed.reduce((n, p, i) => (p.frozen ? i : n), -1);
  const leadCls = (k: string) => {
    const at = leads.indexOf(k);
    return ['grid-lead', `grid-${k}`, frozenAny ? `grid-frozen ${ctx.css.cls(`left:${at * LEAD_WIDTH}px`)}` : ''].filter(Boolean).join(' ');
  };
  const colCls = (p: Placed<(typeof cols)[number]>, pi: number, extra: string | null = null) =>
    [
      extra,
      p.width ? `grid-sized ${ctx.css.cls(`width:${p.width}px;min-width:${p.width}px;max-width:${p.width}px`)}` : '',
      p.frozen ? `grid-frozen ${ctx.css.cls(`left:${p.left}px`)}` : '',
      pi === lastFrozen ? 'grid-frozen-last' : '',
    ].filter(Boolean).join(' ') || null;
  const hiddenAttr = (p: Placed<unknown>) => (p.hidden ? raw(' hidden') : '');
  const label = (name: string) => headingOf(r, name, tr);

  const header = placed.map(
    (p, pi) => html`<th scope="col" class="${colCls(p, pi, NUMERIC.has(p.col.typeOid) ? 'num' : null)}" data-col="${p.col.ci}" data-col-name="${p.col.name}"${hiddenAttr(p)}>${label(p.col.name)}${p.col.required ? html`<span class="req" aria-hidden="true">*</span>` : ''}<span class="grid-resize" aria-hidden="true"></span></th>`,
  );
  const leadHeads = leads.map((k) =>
    k === 'pick' ? html`<th scope="col" class="${leadCls(k)}"><span class="sr-only">${t('grid.select')}</span></th>`
    : k === 'sel' ? html`<th scope="col" class="${leadCls(k)} grid-sel"><span class="sr-only">${t('grid.delete')}</span>${icon('close')}</th>`
    : html`<th scope="col" class="${leadCls(k)}"><span class="sr-only">${t('grid.row_actions')}</span></th>`,
  );

  const rowItems = (row: unknown[], items: Record<string, string> | undefined) =>
    fillItems(items, (col) => {
      const i = fields.findIndex((f) => f.name.toLowerCase() === col.toLowerCase());
      return i === -1 ? undefined : (toState(row[i]) ?? '');
    });

  const rows = info.rows.map((row, i) => {
    const pk = toState(row[pkIdx]) ?? '';
    const pi = postedByPk.get(pk);
    const orig: Record<string, string> = {};
    const cells = placed.map((p, pIdx) => {
      const col = p.col;
      const dbValue = toState(row[col.idx]) ?? '';
      orig[col.ci] = dbValue;
      const lbl = label(col.name);
      if (!col.editable) return html`<td class="${colCls(p, pIdx, NUMERIC.has(col.typeOid) ? 'num' : null)}" data-col="${col.ci}" data-label="${lbl}"${hiddenAttr(p)}>${cell(row[col.idx], col.typeOid, ctx.locale.format)}</td>`;
      const name = `${g}_${i}_c${col.ci}`;
      const value = pi !== undefined ? (col.typeOid === 16 ? (pv(`${g}_${pi}_c${col.ci}`) === 'true' ? 'true' : 'false') : (pv(`${g}_${pi}_c${col.ci}`) ?? dbValue)) : dbValue;
      return html`<td class="${colCls(p, pIdx)}" data-col="${col.ci}" data-label="${lbl}"${hiddenAttr(p)}>${control(col, name, value, `${lbl}, row ${i + 1}`)}</td>`;
    });
    const deleted = pi !== undefined && pv(`${g}_${pi}_del`) === 'true';
    const selValue = selIdx >= 0 ? toState(row[selIdx]) ?? '' : null;
    const isSelected = selValue !== null && selected !== null && selValue === selected;
    const lead = leads.map((k) => {
      if (k === 'pick')
        return html`<td class="${leadCls(k)}" data-label="${t('grid.select')}"><a class="grid-pick-link" href="${selectHref(ctx, r, selValue!, details)}" data-grid-select="${details.map((d) => d.id).join(',')}" data-grid-leave${isSelected ? raw(' aria-current="true"') : ''}><span class="grid-radio" aria-hidden="true"></span><span class="sr-only">${t('grid.select_row', { row: i + 1 })}</span></a></td>`;
      if (k === 'sel')
        return html`<td class="${leadCls(k)} grid-sel" data-label="${t('grid.delete')}"><label class="check"><input type="checkbox" id="${g}_${i}_del" name="${g}_${i}_del" value="true"${deleted ? raw(' checked') : ''}><span class="sr-only">${t('grid.delete_row', { row: i + 1 })}</span></label></td>`;
      return html`<td class="${leadCls(k)}" data-label="${t('grid.row_actions')}"><details class="menu row-menu">
        <summary class="btn btn-small" aria-label="${t('grid.row_actions_for', { row: i + 1 })}"><span aria-hidden="true">⋮</span></summary>
        <div class="menu-panel menu-links">
          ${editLink ? html`<a ${linkAttrs(ctx, editLink.page, rowItems(row, editLink.items))}>${icon('edit')} ${editLink.label ? tr(editLink.label) : t('report.edit')}</a>` : ''}
          ${canDuplicate ? html`<a href="${regionUrl(ctx, r, (q) => q.set(key(r, 'dup'), pk))}" data-grid-dup="${i}" data-grid-leave>${icon('plus')} ${t('grid.duplicate')}</a>` : ''}
          ${canDelete ? html`<label for="${g}_${i}_del" data-grid-del>${icon('close')} ${t('grid.delete_toggle')}</label>` : ''}
          ${extraLinks.map((l) => html`<a ${linkAttrs(ctx, l.page, rowItems(row, l.items))}>${tr(l.label!)}</a>`)}
        </div></details></td>`;
    });
    const cls = [deleted ? 'deleted' : '', isSelected ? 'is-selected' : ''].filter(Boolean).join(' ') || null;
    return html`<tr class="${cls}" data-row="${i}">
      ${lead}
      ${cells}
      ${savable ? html`<td hidden><input type="hidden" name="${g}_${i}_pk" value="${pk}"><input type="hidden" name="${g}_${i}_cs" value="${rowToken(ctx, r, pk)}"><input type="hidden" name="${g}_${i}_orig" value="${JSON.stringify(orig)}"></td>` : ''}
    </tr>`;
  });

  // New rows: re-show posted ones after a failed save, a duplicated row, plus a blank template.
  const newRow = (j: number, values: Record<number, string> = {}) =>
    html`<tr class="grid-new" data-new-row="${j}">
      ${leads.map((k) => html`<td class="${leadCls(k)}${k === 'sel' ? ' grid-sel' : ''}" data-label="${k === 'sel' ? t('grid.new') : ''}">${k === 'sel' ? html`<span class="badge-pill">${t('grid.new')}</span>` : ''}</td>`)}
      ${placed.map((p, pIdx) => {
        const col = p.col;
        const lbl = label(col.name);
        if (masterCol && col.name === masterCol) return html`<td class="${colCls(p, pIdx)}" data-col="${col.ci}" data-label="${lbl}"${hiddenAttr(p)}>${masterValue}</td>`;
        return writable.has(col.name)
          ? html`<td class="${colCls(p, pIdx)}" data-col="${col.ci}" data-label="${lbl}"${hiddenAttr(p)}>${control({ ...col, editable: true }, `${g}_n${j}_c${col.ci}`, values[col.ci] ?? '', `${lbl}, new row`)}</td>`
          : html`<td class="${colCls(p, pIdx)}" data-col="${col.ci}" data-label="${lbl}"${hiddenAttr(p)}></td>`;
      })}
    </tr>`;
  const postedNew: Raw[] = [];
  const usedNew = posted ? newRowIndexes(posted, g) : [];
  if (posted)
    for (const j of usedNew) {
      const values: Record<number, string> = {};
      cols.forEach((col) => (values[col.ci] = pv(`${g}_n${j}_c${col.ci}`) ?? ''));
      if (Object.values(values).some((v) => v !== '' && v !== 'false')) postedNew.push(newRow(j, values));
    }
  let nextNew = usedNew.length ? Math.max(...usedNew) + 1 : 0;
  // Duplicate without JavaScript (r<id>_dup=<key>): a row of this page as a new row
  const dup = canDuplicate && !posted ? ctx.params.get(key(r, 'dup')) : null;
  const dupRow = dup !== null ? info.rows.find((row) => (toState(row[pkIdx]) ?? '') === dup) : undefined;
  if (dupRow) {
    const values: Record<number, string> = {};
    for (const col of cols) if (writable.has(col.name)) values[col.ci] = toState(dupRow[col.idx]) ?? '';
    postedNew.push(newRow(nextNew++, values));
  }

  // the aggregates under their columns (over all rows of the search, not only this page)
  const footer = agg && cols.length
    ? (() => {
        const firstShown = placed.findIndex((p) => !p.hidden);
        return html`<tfoot><tr class="agg-row total">
          ${leads.map((k) => html`<td class="${leadCls(k)}"></td>`)}
          ${placed.map((p, pIdx) => {
            const parts = agg!.aggs.flatMap((a, ai) => (a.column === p.col.name ? [`${t(`agg.${a.fn}`)}: ${cell(agg!.total[ai], agg!.types[ai], ctx.locale.format)}`] : []));
            const text = [pIdx === firstShown ? t('report.total') : '', ...parts].filter(Boolean).join(' · ');
            return html`<td class="${colCls(p, pIdx, parts.length && NUMERIC.has(p.col.typeOid) ? 'num' : null)}" data-col="${p.col.ci}" data-label="${parts.length ? label(p.col.name) : ''}"${hiddenAttr(p)}>${text}</td>`;
          })}
        </tr></tfoot>`;
      })()
    : '';

  const searchForm = `rs${r.id}`;
  ctx.detached.push(
    html`<form id="${searchForm}" method="get" action="${ctx.base}/${ctx.page.page_no}">${[...ctx.params.entries()]
      .filter(([k]) => ![key(r, 'q'), key(r, 'p'), key(r, 'dup'), 'clear', 'cs'].includes(k))
      .map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}</form>`,
  );
  const menu = r.config.actions === false ? '' : await actionsMenu(ctx, r, cols, placed, layout, ownLayout, aggs);
  const chips = aggs.filter((a) => a.own).map((a) => html`<span class="chip">${t(`agg.${a.fn}`)}: <b>${label(a.column)}</b>
      <a href="${regionUrl(ctx, r, (p) => {
        const rest = p.getAll(key(r, 'a')).filter((x) => x !== a.raw);
        p.delete(key(r, 'a'));
        rest.forEach((x) => p.append(key(r, 'a'), x));
      })}" aria-label="${t('report.remove')}" data-grid-leave>×</a></span>`);

  return html`<div class="grid${frozenAny ? ' grid-has-frozen' : ''}" data-grid="${g}"${details.length ? raw(` data-grid-details="${details.map((d) => d.id).join(',')}"`) : ''}>
    <div class="report-toolbar grid-toolbar">
      <div class="search" role="search">
        <input type="search" name="${key(r, 'q')}" value="${st.search}" placeholder="${t('report.search_placeholder')}" form="${searchForm}" aria-label="${t('report.search')} ${r.title ?? ''}">
        <button class="btn" form="${searchForm}">${t('report.go')}</button>
        ${menu}
      </div>
      <div class="buttons">
        ${insertable ? html`<button type="button" class="btn" data-grid-add="${g}">${icon('plus')} ${t('grid.add_row')}</button>` : ''}
        ${savable ? html`<button type="submit" class="btn btn-hot" name="__request" value="${saveRequest(r)}">${t('grid.save')}</button>` : ''}
      </div>
    </div>
    ${chips.length ? html`<div class="chips">${chips}</div>` : ''}
    <div class="table-wrap"><table class="report report-reflow grid-table">
      <thead><tr>${leadHeads}${header}</tr></thead>
      <tbody>${rows}${postedNew}</tbody>
      ${insertable ? html`<tbody class="grid-template">${newRow(nextNew)}</tbody>` : ''}
      ${footer}
    </table></div>
    ${pagerNav(ctx, r, info, raw(' data-grid-leave'))}
  </div>`;
}

/** The grid's Actions menu: columns (order, shown, width, frozen), aggregates, saved reports, reset. */
async function actionsMenu(
  ctx: PageContext, r: Region, cols: (GridColumn & { ci: number })[], placed: Placed<GridColumn & { ci: number }>[],
  layout: GridLayout, ownLayout: boolean, aggs: ReturnType<typeof gridAggregates>,
) {
  const t = ctx.locale.t;
  const label = (name: string) => headingOf(r, name, ctx.locale.tr);
  const csrf = html`<input type="hidden" name="__csrf" value="${ctx.session.csrf_token}">`;
  const here = statePart(ctx).toString();
  const base = `${ctx.base}/${ctx.page.page_no}/grid/${r.id}`;
  const layoutForm = `rl${r.id}`;
  const resetForm = `rr${r.id}`;
  const aggForm = `ra${r.id}`;
  ctx.detached.push(html`<form id="${layoutForm}" method="post" action="${base}/layout">${csrf}<input type="hidden" name="params" value="${here}"><input type="hidden" name="n" value="${placed.length}"></form>`);
  ctx.detached.push(html`<form id="${resetForm}" method="post" action="${base}/layout/reset">${csrf}<input type="hidden" name="params" value="${here}"></form>`);
  ctx.detached.push(
    html`<form id="${aggForm}" method="get" action="${ctx.base}/${ctx.page.page_no}">${[...ctx.params.entries()]
      .filter(([k]) => ![key(r, 'p'), key(r, 'dup'), 'clear', 'cs'].includes(k))
      .map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}</form>`,
  );
  const columnRows = placed.map((p, i) => html`<tr>
      <th scope="row">${label(p.col.name)}<input type="hidden" name="col_${i}" value="${p.col.name}" form="${layoutForm}"></th>
      <td><input type="checkbox" name="show_${i}" value="true" form="${layoutForm}"${p.hidden ? '' : raw(' checked')} aria-label="${t('grid.show_column', { column: label(p.col.name) })}"></td>
      <td><input type="number" name="pos_${i}" value="${i + 1}" min="1" max="${placed.length}" form="${layoutForm}" aria-label="${t('grid.column_position', { column: label(p.col.name) })}"></td>
      <td><input type="number" name="width_${i}" value="${layout.widths[p.col.name] ?? ''}" min="${MIN_WIDTH}" max="${MAX_WIDTH}" step="10" placeholder="${t('grid.auto')}" form="${layoutForm}" aria-label="${t('grid.column_width', { column: label(p.col.name) })}"></td>
    </tr>`);
  const saved = await gridSavedReports(ctx, r, layout);
  return html`<details class="menu actions-menu grid-actions-menu">
    <summary class="btn">${t('report.actions')} <span aria-hidden="true">▾</span></summary>
    <div class="menu-panel">
      <div class="menu-section">
        <strong>${t('grid.columns')}</strong>
        <div class="table-wrap"><table class="grid-columns-form">
          <thead><tr><th scope="col">${t('report.column')}</th><th scope="col">${t('grid.shown')}</th><th scope="col">${t('grid.position')}</th><th scope="col">${t('grid.width')}</th></tr></thead>
          <tbody>${columnRows}</tbody>
        </table></div>
        <div class="filter-row">
          <label class="grid-freeze-label" for="${layoutForm}_frozen">${t('grid.freeze')}</label>
          <select id="${layoutForm}_frozen" name="frozen" form="${layoutForm}">${Array.from({ length: Math.min(MAX_FROZEN, cols.length) + 1 }, (_, n) => html`<option value="${n}"${n === layout.frozen ? raw(' selected') : ''}>${n}</option>`)}</select>
          <button class="btn btn-hot" form="${layoutForm}">${t('report.apply')}</button>
          <button class="btn" form="${resetForm}"${ownLayout || reportParams(r, ctx.params).size ? '' : raw(' disabled')}>${t('report.reset')}</button>
        </div>
        <small class="help">${t('grid.columns_help')}</small>
      </div>
      <div class="menu-section">
        <strong>${t('report.aggregate')}</strong>
        <div class="filter-row">
          <select name="${key(r, 'af')}" form="${aggForm}" aria-label="${t('report.function')}">${Object.keys(AGGREGATES).map((fn) => html`<option value="${fn}">${t(`agg.${fn}`)}</option>`)}</select>
          <select name="${key(r, 'ac')}" form="${aggForm}" aria-label="${t('report.column')}">${cols.map((c) => html`<option value="${c.name}">${label(c.name)}</option>`)}</select>
          <button class="btn" form="${aggForm}" data-grid-leave>${t('report.apply')}</button>
        </div>
        ${aggs.some((a) => !a.own) ? html`<small class="help">${t('grid.default_aggregates', { list: aggs.filter((a) => !a.own).map((a) => `${t(`agg.${a.fn}`)} ${label(a.column)}`).join(', ') })}</small>` : ''}
      </div>
      ${saved ?? ''}
    </div>
  </details>`;
}

/** The page's report and grid state (r<n>_* parameters) without one-off ones: where to come back to. */
export function statePart(ctx: PageContext, drop?: Region) {
  const out = new URLSearchParams();
  for (const [k, v] of ctx.params) {
    if (!/^r\d+_/.test(k) || /_(csv|xlsx|pdf|load|dup)$/.test(k)) continue;
    if (drop && k.startsWith(`r${drop.id}_`)) continue;
    out.append(k, v);
  }
  return out;
}

/** Actions → Saved reports of a grid: its parameters plus the column layout (r<id>_lay). */
async function gridSavedReports(ctx: PageContext, r: Region, layout: GridLayout) {
  if (ctx.user === 'nobody' || r.config.saved_reports === false) return null;
  const t = ctx.locale.t;
  const c = ctx.client!;
  const list = (
    await savepoint(c, () =>
      c.query<{ id: number; name: string; public: boolean; own: boolean; params: string }>(
        `select id, name, public, own, params from meta.saved_reports where region_id = $1 and kind = 'report' order by public desc, lower(name)`,
        [r.id],
      ),
    )
  ).rows;
  const current = reportParams(r, ctx.params);
  current.delete(key(r, 'dup'));
  current.set(layoutParam(r), layoutJson(layout));
  const same = (params: string) => {
    const p = new URLSearchParams(params);
    const lay = parseLayout(p.get(layoutParam(r)));
    p.delete(layoutParam(r));
    const cur = new URLSearchParams(current);
    cur.delete(layoutParam(r));
    return p.toString() === cur.toString() && layoutJson(lay ?? defaultLayout(r)) === layoutJson(layout);
  };
  const mayPublish = typeof r.config.public_reports === 'string' && (await isAuthorized(ctx, r.config.public_reports));
  const base = `${ctx.base}/${ctx.page.page_no}`;
  const csrf = html`<input type="hidden" name="__csrf" value="${ctx.session.csrf_token}">`;
  const here = statePart(ctx, r).toString();
  const saveForm = `rsv${r.id}`;
  ctx.detached.push(html`<form id="${saveForm}" method="post" action="${base}/report/${r.id}/save">${csrf}<input type="hidden" name="params" value="${current.toString()}"></form>`);
  for (const x of list) {
    ctx.detached.push(html`<form id="rsa${r.id}_${x.id}" method="post" action="${base}/grid/${r.id}/saved/${x.id}/apply">${csrf}<input type="hidden" name="params" value="${here}"></form>`);
    if (x.own) ctx.detached.push(html`<form id="rsd${r.id}_${x.id}" method="post" action="${base}/report/${r.id}/saved/${x.id}/delete">${csrf}<input type="hidden" name="params" value="${current.toString()}"></form>`);
  }
  return html`<div class="menu-section">
      <strong>${t('report.saved_reports')}</strong>
      ${list.length
        ? html`<ul class="saved-reports">${list.map((x) => html`<li>
            <button class="link-button" form="rsa${r.id}_${x.id}"${same(x.params) ? raw(' aria-current="true"') : ''}>${x.name}</button>${x.public ? html` <span class="tag">${t('report.public_tag')}</span>` : ''}
            ${x.own ? html`<button class="link-button" form="rsd${r.id}_${x.id}" data-confirm="${t('report.delete_saved_confirm', { name: x.name })}" aria-label="${t('report.delete_saved')} ${x.name}">×</button>` : ''}
          </li>`)}</ul>`
        : ''}
      <div class="filter-row">
        <input name="name" form="${saveForm}" required maxlength="80" aria-label="${t('report.name')}" placeholder="${t('report.save_as')}">
        ${mayPublish ? html`<label class="check"><input type="checkbox" name="public" value="true" form="${saveForm}"> ${t('report.public')}</label>` : ''}
        <button class="btn" form="${saveForm}">${t('report.save')}</button>
      </div>
    </div>`;
}

/** A layout from the Columns form: shown, position and width per column, frozen count. */
export function layoutFromForm(b: Record<string, string | undefined>): GridLayout {
  const n = Math.min(Math.max(0, Number(b.n) || 0), 200);
  const cols = Array.from({ length: n }, (_, i) => ({
    name: (b[`col_${i}`] ?? '').trim(),
    shown: b[`show_${i}`] === 'true',
    pos: Number(b[`pos_${i}`]),
    width: b[`width_${i}`]?.trim() ? Number(b[`width_${i}`]) : null,
    i,
  })).filter((c) => c.name);
  // a position that is not a number keeps the column where it was; ties: the earlier one first
  cols.sort((a, b) => (Number.isFinite(a.pos) ? a.pos : a.i + 1) - (Number.isFinite(b.pos) ? b.pos : b.i + 1) || a.i - b.i);
  return cleanLayout({
    order: cols.map((c) => c.name),
    hidden: cols.filter((c) => !c.shown).map((c) => c.name),
    widths: Object.fromEntries(cols.filter((c) => c.width !== null && Number.isFinite(c.width)).map((c) => [c.name, c.width])),
    frozen: b.frozen,
  });
}

function newRowIndexes(body: Record<string, unknown>, g: string) {
  const out = new Set<number>();
  for (const k of Object.keys(body)) {
    const m = new RegExp(`^${g}_n(\\d+)_c\\d+$`).exec(k);
    if (m) out.add(Number(m[1]));
  }
  return [...out].sort((a, b) => a - b);
}

// ---------------------------------------------------------------- save (grid_dml)

export async function gridDml(ctx: PageContext, p: Process): Promise<string | null> {
  const c = ctx.client!;
  const r = ctx.page.regions.find((x) => x.id === p.region_id && x.type === 'grid');
  if (!r?.table_name || !r.pk_column) throw new Error(`Process "${p.name}" needs a grid region with a table and primary key.`);
  if (!ctx.vis!.regions.has(r.id)) return null;
  const body = ctx.body ?? {};
  const g = `g${r.id}`;
  const one = (k: string) => {
    const v = body[k];
    return Array.isArray(v) ? String(v[v.length - 1]) : v === undefined ? undefined : String(v);
  };

  // Rebuild the column list the same way the grid was rendered.
  const src = await savepoint(c, async () => c.query({ ...(await buildSql(ctx, r, { ...reportState(ctx, r), page: 1, size: 1 }, 'page')), rowMode: 'array' }));
  const cols = visibleColumns(r, src.fields.slice(0, -1)).map(({ f }) => f);
  const writable = await writableColumns(c, r);
  const table = (await c.query('select $1::regclass::text as t', [r.table_name])).rows[0].t as string;
  const pkCol = ident(r.pk_column);
  const required = (name: string) => !!r.config.columns?.[name]?.required;
  const norm = (ci: number, v: string | undefined) => (cols[ci].dataTypeID === 16 ? (v === 'true' ? 'true' : 'false') : v ?? '');

  const errors: string[] = [];
  let inserted = 0, updated = 0, deleted = 0;
  const attempt = async (label: string, fn: () => Promise<void>) => {
    try {
      await savepoint(c, fn);
    } catch (e) {
      errors.push(`${label}: ${e instanceof Error && !(e as pg.DatabaseError).code ? e.message : await publicError(ctx, e, 'grid save')}`);
    }
  };

  // existing rows
  for (const k of Object.keys(body)) {
    const m = new RegExp(`^${g}_(\\d+)_pk$`).exec(k);
    if (!m) continue;
    const i = m[1];
    const pk = one(k) ?? '';
    if (!checksumValid(rowToken(ctx, r, pk), one(`${g}_${i}_cs`))) {
      errors.push(ctx.locale.t('grid.row_changed', { row: Number(i) + 1 }));
      continue;
    }
    if (one(`${g}_${i}_del`) === 'true') {
      if (!allow(r, 'delete')) continue;
      await attempt(ctx.locale.t('grid.row', { row: Number(i) + 1 }), async () => {
        const res = await c.query(`delete from ${table} where ${pkCol} = ${literal(pk)}`);
        if (res.rowCount !== 1) throw new Error(ctx.locale.t('form.changed'));
        deleted++;
      });
      continue;
    }
    if (!allow(r, 'update')) continue;
    let orig: Record<string, string> = {};
    try {
      orig = JSON.parse(one(`${g}_${i}_orig`) ?? '{}');
    } catch {
      /* treat every column as changed */
    }
    const sets: string[] = [];
    cols.forEach((col, ci) => {
      if (!writable.has(col.name)) return;
      const v = norm(ci, one(`${g}_${i}_c${ci}`));
      if (v === (orig[ci] ?? null)) return;
      if (required(col.name) && v === '') errors.push(ctx.locale.t('grid.required', { row: Number(i) + 1, label: headingOf(r, col.name, ctx.locale.tr) }));
      sets.push(`${ident(col.name)} = ${literal(v === '' ? null : v)}`);
    });
    if (!sets.length) continue;
    await attempt(ctx.locale.t('grid.row', { row: Number(i) + 1 }), async () => {
      const res = await c.query(`update ${table} set ${sets.join(', ')} where ${pkCol} = ${literal(pk)}`);
      if (res.rowCount !== 1) throw new Error(ctx.locale.t('form.changed'));
      updated++;
    });
  }

  // new rows
  // a detail grid's new rows belong to the selected master row
  const masterCol = masterColumnOf(r);
  const masterValue = masterItemOf(r) ? ctx.session.state[masterItemOf(r)!] ?? null : null;
  if (allow(r, 'insert'))
    for (const j of newRowIndexes(body, g)) {
      const values: [string, string][] = [];
      cols.forEach((col, ci) => {
        if (!writable.has(col.name)) return;
        const v = norm(ci, one(`${g}_n${j}_c${ci}`));
        if (v !== '' && !(col.dataTypeID === 16 && v === 'false')) values.push([col.name, v]);
      });
      if (!values.length) continue; // blank template row
      if (masterCol) {
        if (masterValue === null) {
          errors.push(ctx.locale.t('grid.select_master'));
          continue;
        }
        values.push([masterCol, masterValue]);
      }
      const missing = cols.filter((col) => required(col.name) && !values.some(([n]) => n === col.name));
      if (missing.length) {
        errors.push(ctx.locale.t('grid.new_required', { labels: missing.map((col) => headingOf(r, col.name, ctx.locale.tr)).join(', ') }));
        continue;
      }
      await attempt(ctx.locale.t('grid.new_row'), async () => {
        await c.query(`insert into ${table} (${values.map(([n]) => ident(n)).join(', ')}) values (${values.map(([, v]) => literal(v)).join(', ')})`);
        inserted++;
      });
    }

  if (errors.length) throw new Error(errors.join(' '));
  const t = ctx.locale.t;
  const parts = [inserted && t('grid.added', { n: inserted }), updated && t('grid.updated', { n: updated }), deleted && t('grid.deleted', { n: deleted })].filter(Boolean);
  return p.success_message ?? (parts.length ? t('grid.saved_parts', { parts: parts.join(', ') }) : t('grid.no_changes'));
}
