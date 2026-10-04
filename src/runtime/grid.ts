import pg from 'pg';
import { literal } from '../binds.ts';
import { savepoint, type Client } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import type { Button, Process, Region } from '../metadata.ts';
import { checksumValid, urlChecksum } from '../security.ts';
import { publicError, toState, type PageContext } from './context.ts';
import { lovOptions, type LovOption } from './items.ts';
import { buildSql, cell, headingOf, key, pageInfo, pagerNav, regionUrl, reportState, visibleColumns } from './report.ts';

// Interactive grid: an editable report on one table (APEX's Interactive
// Grid). The region's SELECT must include the table's primary key column.
//
//   config: {"page_size": 25,
//            "allow": {"insert": true, "update": true, "delete": true},
//            "columns": {"deptno": {"lov": "LOV:DEPARTMENTS"}, "sal": {"required": true}},
//            "readonly": ["hiredate"]}
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
  return new Set(res.rows.map((x) => x.attname as string).filter((n) => n !== r.pk_column && !readonly.has(n.toLowerCase())));
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

export async function renderGrid(ctx: PageContext, r: Region): Promise<Raw> {
  const c = ctx.client!;
  if (!r.table_name || !r.pk_column) return html`<div class="alert alert-error">Grid regions need a table and a primary key column.</div>`;
  const st = { ...reportState(ctx, r), size: Math.max(1, Math.min(200, Number(r.config.page_size) || 25)) };
  let res: pg.QueryResult<any[]>;
  let writable: Set<string>;
  try {
    writable = await writableColumns(c, r);
    res = await savepoint(c, async () => c.query({ ...(await buildSql(ctx, r, st, 'page')), rowMode: 'array' }));
  } catch (e) {
    return html`<div class="alert alert-error" role="alert">${await publicError(ctx, e, `grid "${r.title ?? r.id}"`)}</div>`;
  }
  const fields = res.fields.slice(0, -1);
  const info = pageInfo(r, st, res.rows, fields.length);
  const pkIdx = fields.findIndex((f) => f.name === r.pk_column);
  if (pkIdx === -1) return html`<div class="alert alert-error">The grid query must select the primary key column ${r.pk_column}.</div>`;

  // Without a grid_dml process the grid is read-only (no Save/Add/Delete).
  const savable = ctx.vis!.buttons.has(saveRequest(r));
  const cfg = r.config.columns ?? {};
  const cols: (GridColumn & { idx: number })[] = [];
  for (const { f, i } of visibleColumns(r, fields)) {
    const col: GridColumn & { idx: number } = {
      name: f.name, typeOid: f.dataTypeID, idx: i,
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

  const header = cols.map(
    (col) => html`<th scope="col" class="${NUMERIC.has(col.typeOid) ? 'num' : null}">${headingOf(r, col.name, ctx.locale.tr)}${col.required ? html`<span class="req" aria-hidden="true">*</span>` : ''}</th>`,
  );

  const rows = info.rows.map((row, i) => {
    const pk = toState(row[pkIdx]) ?? '';
    const pi = postedByPk.get(pk);
    const orig: Record<string, string> = {};
    const cells = cols.map((col, ci) => {
      const dbValue = toState(row[col.idx]) ?? '';
      orig[ci] = dbValue;
      const label = headingOf(r, col.name, ctx.locale.tr);
      if (!col.editable) return html`<td class="${NUMERIC.has(col.typeOid) ? 'num' : null}" data-label="${label}">${cell(row[col.idx], col.typeOid, ctx.locale.format)}</td>`;
      const name = `${g}_${i}_c${ci}`;
      const value = pi !== undefined ? (col.typeOid === 16 ? (pv(`${g}_${pi}_c${ci}`) === 'true' ? 'true' : 'false') : (pv(`${g}_${pi}_c${ci}`) ?? dbValue)) : dbValue;
      return html`<td data-label="${label}">${control(col, name, value, `${label}, row ${i + 1}`)}</td>`;
    });
    const deleted = pi !== undefined && pv(`${g}_${pi}_del`) === 'true';
    return html`<tr class="${deleted ? 'deleted' : null}">
      ${deletable ? html`<td class="grid-sel" data-label="${ctx.locale.t('grid.delete')}"><label class="check"><input type="checkbox" name="${g}_${i}_del" value="true"${deleted ? raw(' checked') : ''}><span class="sr-only">${ctx.locale.t('grid.delete_row', { row: i + 1 })}</span></label></td>` : ''}
      ${cells}
      ${savable ? html`<td hidden><input type="hidden" name="${g}_${i}_pk" value="${pk}"><input type="hidden" name="${g}_${i}_cs" value="${rowToken(ctx, r, pk)}"><input type="hidden" name="${g}_${i}_orig" value="${JSON.stringify(orig)}"></td>` : ''}
    </tr>`;
  });

  // New rows: re-show posted ones after a failed save, plus a blank template.
  const newRow = (j: number, values: Record<number, string> = {}) =>
    html`<tr class="grid-new" data-new-row="${j}">
      ${deletable ? html`<td class="grid-sel" data-label="${ctx.locale.t('grid.new')}"><span class="badge-pill">${ctx.locale.t('grid.new')}</span></td>` : ''}
      ${cols.map((col, ci) => {
        const label = headingOf(r, col.name, ctx.locale.tr);
        return writable.has(col.name)
          ? html`<td data-label="${label}">${control({ ...col, editable: true }, `${g}_n${j}_c${ci}`, values[ci] ?? '', `${label}, new row`)}</td>`
          : html`<td data-label="${label}"></td>`;
      })}
    </tr>`;
  const postedNew: Raw[] = [];
  if (posted)
    for (const j of newRowIndexes(posted, g)) {
      const values: Record<number, string> = {};
      cols.forEach((_, ci) => (values[ci] = pv(`${g}_n${j}_c${ci}`) ?? ''));
      if (Object.values(values).some((v) => v !== '' && v !== 'false')) postedNew.push(newRow(j, values));
    }

  const searchForm = `rs${r.id}`;
  ctx.detached.push(
    html`<form id="${searchForm}" method="get" action="${ctx.base}/${ctx.page.page_no}">${[...ctx.params.entries()]
      .filter(([k]) => ![key(r, 'q'), key(r, 'p'), 'clear', 'cs'].includes(k))
      .map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}</form>`,
  );

  return html`<div class="grid" data-grid="${g}">
    <div class="report-toolbar grid-toolbar">
      <div class="search" role="search">
        <input type="search" name="${key(r, 'q')}" value="${st.search}" placeholder="${ctx.locale.t('report.search_placeholder')}" form="${searchForm}" aria-label="${ctx.locale.t('report.search')} ${r.title ?? ''}">
        <button class="btn" form="${searchForm}">${ctx.locale.t('report.go')}</button>
      </div>
      <div class="buttons">
        ${insertable ? html`<button type="button" class="btn" data-grid-add="${g}">${icon('plus')} ${ctx.locale.t('grid.add_row')}</button>` : ''}
        ${savable ? html`<button type="submit" class="btn btn-hot" name="__request" value="${saveRequest(r)}">${ctx.locale.t('grid.save')}</button>` : ''}
      </div>
    </div>
    <div class="table-wrap"><table class="report report-reflow grid-table">
      <thead><tr>${deletable ? html`<th scope="col" class="grid-sel"><span class="sr-only">${ctx.locale.t('grid.delete')}</span>${icon('close')}</th>` : ''}${header}</tr></thead>
      <tbody>${rows}${postedNew}</tbody>
      ${insertable ? html`<tbody class="grid-template">${newRow(postedNew.length ? Math.max(...newRowIndexes(posted!, g)) + 1 : 0)}</tbody>` : ''}
    </table></div>
    ${pagerNav(ctx, r, info, raw(' data-grid-leave'))}
  </div>`;
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
  if (allow(r, 'insert'))
    for (const j of newRowIndexes(body, g)) {
      const values: [string, string][] = [];
      cols.forEach((col, ci) => {
        if (!writable.has(col.name)) return;
        const v = norm(ci, one(`${g}_n${j}_c${ci}`));
        if (v !== '' && !(col.dataTypeID === 16 && v === 'false')) values.push([col.name, v]);
      });
      if (!values.length) continue; // blank template row
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
