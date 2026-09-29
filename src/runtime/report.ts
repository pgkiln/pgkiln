import pg from 'pg';
import { applyBinds, literal } from '../binds.ts';
import { savepoint } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import type { Region } from '../metadata.ts';
import { pageAllowed } from './authz.ts';
import { bindValues, publicError, stripSemicolon, type PageContext } from './context.ts';
import { heading } from './items.ts';
import { linkAttrs } from './links.ts';

// Interactive report: the developer's SELECT is wrapped as a subquery and the
// end user's search, filters, sort and paging are applied around it. User
// input only ever becomes escaped literals, quoted identifiers of columns
// that exist in the result, whitelisted operators, or integers.

const NUMERIC_OIDS = new Set([20, 21, 23, 26, 700, 701, 1700]);
const TIMESTAMP_OIDS = new Set([1114, 1184]);
export const PAGE_SIZES = [5, 10, 15, 25, 50, 100];
const CSV_MAX_ROWS = 100_000;

export const OPERATORS: Record<string, { label: string; sql: (col: string, v: string) => string; noValue?: boolean }> = {
  eq: { label: '=', sql: (c, v) => `${c} = ${literal(v)}` },
  ne: { label: '≠', sql: (c, v) => `${c} is distinct from ${literal(v)}` },
  contains: { label: 'contains', sql: (c, v) => `${c}::text ilike ${literal(`%${escapeLike(v)}%`)}` },
  not_contains: { label: 'does not contain', sql: (c, v) => `coalesce(${c}::text, '') not ilike ${literal(`%${escapeLike(v)}%`)}` },
  gt: { label: '>', sql: (c, v) => `${c} > ${literal(v)}` },
  ge: { label: '≥', sql: (c, v) => `${c} >= ${literal(v)}` },
  lt: { label: '<', sql: (c, v) => `${c} < ${literal(v)}` },
  le: { label: '≤', sql: (c, v) => `${c} <= ${literal(v)}` },
  null: { label: 'is empty', sql: (c) => `${c} is null`, noValue: true },
  not_null: { label: 'is not empty', sql: (c) => `${c} is not null`, noValue: true },
};

const escapeLike = (v: string) => v.replace(/[\\%_]/g, '\\$&');

interface Filter {
  column: string;
  op: string;
  value: string;
  raw: string;
}

export interface ReportState {
  search: string;
  sort: number;
  desc: boolean;
  page: number;
  size: number;
  filters: Filter[];
}

export const key = (r: Region, k: string) => `r${r.id}_${k}`;

export function reportState(ctx: PageContext, r: Region): ReportState {
  const p = ctx.params;
  const size = parseInt(p.get(key(r, 'n')) ?? '', 10) || Number(r.config.page_size) || 15;
  return {
    search: (p.get(key(r, 'q')) ?? '').trim(),
    sort: r.config.sortable === false ? 0 : Math.max(0, Math.min(1000, parseInt(p.get(key(r, 's')) ?? '0', 10) || 0)),
    desc: p.get(key(r, 'd')) === 'desc',
    page: Math.max(1, parseInt(p.get(key(r, 'p')) ?? '1', 10) || 1),
    size: Math.max(1, Math.min(500, size)),
    filters: p.getAll(key(r, 'f')).flatMap((raw) => {
      const [column, op, ...rest] = raw.split('|');
      return column && OPERATORS[op] ? [{ column, op, value: rest.join('|'), raw }] : [];
    }),
  };
}

/**
 * The filter form submits r<id>_fc/_fo/_fv; fold them into a r<id>_f entry.
 * Returns the normalised query string when a redirect is needed.
 */
export function normaliseReportParams(params: URLSearchParams): string | null {
  let changed = false;
  for (const k of [...params.keys()]) {
    const m = /^r(\d+)_fc$/.exec(k);
    if (!m) continue;
    const id = m[1];
    const col = params.get(k) ?? '';
    const op = params.get(`r${id}_fo`) ?? 'eq';
    const val = params.get(`r${id}_fv`) ?? '';
    for (const x of ['fc', 'fo', 'fv', 'p']) params.delete(`r${id}_${x}`);
    if (col && OPERATORS[op]) params.append(`r${id}_f`, `${col}|${op}|${val}`);
    changed = true;
  }
  return changed ? params.toString() : null;
}

export function regionUrl(ctx: PageContext, r: Region, change: (p: URLSearchParams) => void) {
  const p = new URLSearchParams(ctx.params);
  for (const k of ['clear', 'cs', 'dialog']) p.delete(k);
  change(p);
  const q = p.toString();
  return `${ctx.base}/${ctx.page.page_no}${q ? `?${q}` : ''}${ctx.dialog ? `${q ? '&' : '?'}dialog=1` : ''}`;
}

/** Faceted search selections for a report: ?r<id>_x_<column>=value (repeatable). */
export function facetSelections(ctx: PageContext, r: Region, except?: string) {
  const out = new Map<string, string[]>();
  const prefix = `r${r.id}_x_`;
  for (const k of new Set(ctx.params.keys()))
    if (k.startsWith(prefix) && k.slice(prefix.length) !== except) {
      const values = ctx.params.getAll(k).filter((v) => v !== '');
      if (values.length) out.set(k.slice(prefix.length), values);
    }
  return out;
}

export const facetCondition = (col: string, values: string[]) =>
  `"__q".${pg.escapeIdentifier(col)}::text in (${values.map((v) => literal(v)).join(', ')})`;

export async function columnsOf(ctx: PageContext, src: string) {
  const c = ctx.client!;
  const res = await savepoint(c, () => c.query(`select * from (\n${src}\n) "__q" limit 0`));
  return res.fields.map((f) => f.name);
}

export async function buildSql(ctx: PageContext, r: Region, st: ReportState, mode: 'page' | 'csv') {
  const src = stripSemicolon(applyBinds(r.source ?? 'select 1', bindValues(ctx)));
  const where: string[] = [];
  if (st.search) where.push(`"__q"::text ilike ${literal(`%${escapeLike(st.search)}%`)}`);
  const facets = facetSelections(ctx, r);
  if (st.filters.length || facets.size) {
    const cols = new Set(await columnsOf(ctx, src));
    for (const f of st.filters)
      if (cols.has(f.column)) where.push(OPERATORS[f.op].sql(`"__q".${pg.escapeIdentifier(f.column)}`, f.value));
    for (const [col, values] of facets)
      if (cols.has(col)) where.push(facetCondition(col, values));
  }
  let sql = `select "__q".*${mode === 'page' ? ', count(*) over () as "__total"' : ''} from (\n${src}\n) "__q"`;
  if (where.length) sql += ` where ${where.join(' and ')}`;
  if (st.sort) sql += ` order by ${st.sort} ${st.desc ? 'desc' : 'asc'} nulls last`;
  sql += mode === 'page' ? ` limit ${st.size} offset ${(st.page - 1) * st.size}` : ` limit ${CSV_MAX_ROWS}`;
  return sql;
}

export function cell(v: unknown, typeOid?: number) {
  if (v === null || v === undefined) return '';
  // "2026-09-29 16:06:23.900333+00" -> "2026-09-29 16:06"
  if (typeOid && TIMESTAMP_OIDS.has(typeOid)) return String(v).slice(0, 16);
  if (typeof v === 'boolean') return v ? '✓' : '✗';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export const visibleColumns = (r: Region, fields: pg.FieldDef[]) => {
  const hidden = new Set<string>((r.config.hidden ?? []).map((h: string) => h.toLowerCase()));
  return fields.map((f, i) => ({ f, i })).filter(({ f }) => !hidden.has(f.name.toLowerCase()) && !f.name.startsWith('__'));
};

export const headingOf = (r: Region, name: string) => r.config.headings?.[name] ?? heading(name);

/** CSV download (Actions → Download). Cells that look like formulas are neutralised. */
export async function reportCsv(ctx: PageContext, r: Region) {
  const st = reportState(ctx, r);
  const c = ctx.client!;
  const res = await savepoint(c, async () => c.query({ text: await buildSql(ctx, r, st, 'csv'), rowMode: 'array' }));
  const cols = visibleColumns(r, res.fields);
  const esc = (s: string, numeric: boolean) => {
    if (!numeric && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.map(({ f }) => esc(headingOf(r, f.name), false)).join(',')];
  for (const row of res.rows)
    lines.push(cols.map(({ f, i }) => esc(cell(row[i], f.dataTypeID), NUMERIC_OIDS.has(f.dataTypeID))).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

export async function renderReport(ctx: PageContext, r: Region, filterItems: Raw[]) {
  const c = ctx.client!;
  const st = reportState(ctx, r);
  const searchable = r.config.searchable !== false;
  const interactive = r.config.interactive !== false && searchable;

  let res: pg.QueryResult<any[]>;
  let pageNo = st.page;
  let failure: string | null = null;
  try {
    const run = async (p: number) => savepoint(c, async () => c.query({ text: await buildSql(ctx, r, { ...st, page: p }, 'page'), rowMode: 'array' }));
    res = await run(pageNo);
    if (res.rows.length === 0 && pageNo > 1) res = await run((pageNo = 1));
  } catch (e) {
    failure = await publicError(ctx, e, `report "${r.title ?? r.id}"`);
    res = { rows: [], fields: [] } as any;
  }

  const fields = res.fields.slice(0, -1);
  const total = res.rows.length ? Number(res.rows[0][fields.length]) : 0;
  const cols = visibleColumns(r, fields);
  const link = r.config.link as { column: string; page: number; items?: Record<string, string> } | undefined;
  const linkIdx = link && (await pageAllowed(ctx, link.page)) ? fields.findIndex((f) => f.name.toLowerCase() === link.column.toLowerCase()) : -1;
  const pre = new Set<string>((r.config.preformatted ?? []).map((x: string) => x.toLowerCase()));

  const rowItems = (row: unknown[]) => {
    const items: Record<string, string> = {};
    for (const [k, v] of Object.entries(link!.items ?? {}))
      items[k] = v.replace(/#([A-Za-z0-9_]+)#/g, (m, col: string) => {
        const i = fields.findIndex((f) => f.name.toLowerCase() === col.toLowerCase());
        return i === -1 ? m : cell(row[i]);
      });
    return items;
  };

  const header = cols.map(({ f, i }) => {
    const pos = i + 1;
    const cls = NUMERIC_OIDS.has(f.dataTypeID) ? 'num' : null;
    const label = headingOf(r, f.name);
    if (r.config.sortable === false) return html`<th scope="col" class="${cls}">${label}</th>`;
    const active = st.sort === pos;
    const href = regionUrl(ctx, r, (p) => {
      p.set(key(r, 's'), String(pos));
      if (active && !st.desc) p.set(key(r, 'd'), 'desc');
      else p.delete(key(r, 'd'));
      p.delete(key(r, 'p'));
    });
    return html`<th scope="col" class="${cls}" aria-sort="${active ? (st.desc ? 'descending' : 'ascending') : 'none'}"><a href="${href}">${label}<span class="sort-ind" aria-hidden="true">${active ? (st.desc ? '▼' : '▲') : ''}</span></a></th>`;
  });

  const body = res.rows.map(
    (row) =>
      html`<tr>${cols.map(({ f, i }) => {
        const text = cell(row[i], f.dataTypeID);
        const cls = [NUMERIC_OIDS.has(f.dataTypeID) ? 'num' : '', pre.has(f.name.toLowerCase()) ? 'pre' : ''].filter(Boolean).join(' ') || null;
        const label = headingOf(r, f.name);
        return i === linkIdx
          ? html`<td class="${cls}" data-label="${label}"><a ${linkAttrs(ctx, link!.page, rowItems(row))}>${text || 'Edit'}</a></td>`
          : html`<td class="${cls}" data-label="${label}">${text}</td>`;
      })}</tr>`,
  );

  // ---- toolbar: filter items, search, Actions menu ----
  const searchForm = `rs${r.id}`;
  const filterForm = `rf${r.id}`;
  const hiddenInputs = (except: string[]) =>
    [...ctx.params.entries()]
      .filter(([k]) => !except.includes(k) && !['clear', 'cs'].includes(k))
      .map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`);
  const action = `${ctx.base}/${ctx.page.page_no}`;
  if (searchable) {
    ctx.detached.push(html`<form id="${searchForm}" method="get" action="${action}">${hiddenInputs([key(r, 'q'), key(r, 'p')])}${ctx.dialog ? html`<input type="hidden" name="dialog" value="1">` : ''}</form>`);
  }
  if (interactive) {
    ctx.detached.push(html`<form id="${filterForm}" method="get" action="${action}">${hiddenInputs([key(r, 'p')])}</form>`);
  }

  const chips = st.filters.map((f) => {
    const href = regionUrl(ctx, r, (p) => {
      const rest = p.getAll(key(r, 'f')).filter((x) => x !== f.raw);
      p.delete(key(r, 'f'));
      rest.forEach((x) => p.append(key(r, 'f'), x));
      p.delete(key(r, 'p'));
    });
    const op = OPERATORS[f.op];
    return html`<span class="chip">${headingOf(r, f.column)} ${op.label}${op.noValue ? '' : html` <b>${f.value}</b>`}
      <a href="${href}" aria-label="Remove filter">×</a></span>`;
  });
  if (st.search)
    chips.unshift(
      html`<span class="chip">Search <b>${st.search}</b> <a href="${regionUrl(ctx, r, (p) => { p.delete(key(r, 'q')); p.delete(key(r, 'p')); })}" aria-label="Clear search">×</a></span>`,
    );

  const actionsMenu = interactive
    ? html`<details class="menu actions-menu">
        <summary class="btn">Actions <span aria-hidden="true">▾</span></summary>
        <div class="menu-panel">
          <div class="menu-section">
            <strong>Filter</strong>
            <div class="filter-row">
              <select name="${key(r, 'fc')}" form="${filterForm}" aria-label="Column">${cols.map(({ f }) => html`<option value="${f.name}">${headingOf(r, f.name)}</option>`)}</select>
              <select name="${key(r, 'fo')}" form="${filterForm}" aria-label="Operator">${Object.entries(OPERATORS).map(([k, o]) => html`<option value="${k}"${k === 'contains' ? raw(' selected') : ''}>${o.label}</option>`)}</select>
              <input name="${key(r, 'fv')}" form="${filterForm}" aria-label="Value" placeholder="Value">
              <button class="btn btn-hot" form="${filterForm}">Apply</button>
            </div>
          </div>
          ${r.config.sortable === false
            ? ''
            : html`<div class="menu-section"><strong>Sort</strong>
                <div class="seg">${cols.map(({ f, i }) => {
                  const pos = i + 1;
                  const active = st.sort === pos;
                  const href = regionUrl(ctx, r, (p) => {
                    p.set(key(r, 's'), String(pos));
                    if (active && !st.desc) p.set(key(r, 'd'), 'desc');
                    else p.delete(key(r, 'd'));
                    p.delete(key(r, 'p'));
                  });
                  return html`<a href="${href}"${active ? raw(' aria-current="true"') : ''}>${headingOf(r, f.name)}${active ? (st.desc ? ' ▼' : ' ▲') : ''}</a>`;
                })}</div>
              </div>`}
          <div class="menu-section"><strong>Rows per page</strong>
            <div class="seg">${PAGE_SIZES.map((n) =>
              html`<a href="${regionUrl(ctx, r, (p) => { p.set(key(r, 'n'), String(n)); p.delete(key(r, 'p')); })}"${n === st.size ? raw(' aria-current="true"') : ''}>${n}</a>`)}</div>
          </div>
          <div class="menu-section menu-links">
            <a href="${regionUrl(ctx, r, (p) => p.set(key(r, 'csv'), '1'))}" download>⤓ Download CSV</a>
            <a href="${regionUrl(ctx, r, (p) => { for (const k of [...p.keys()]) if (k.startsWith(`r${r.id}_`)) p.delete(k); })}">↺ Reset report</a>
          </div>
        </div>
      </details>`
    : '';

  const toolbar =
    searchable || filterItems.length
      ? html`<div class="report-toolbar">
          ${filterItems}
          ${searchable
            ? html`<div class="search" role="search">
                <input type="search" name="${key(r, 'q')}" value="${st.search}" placeholder="Search all columns…" form="${searchForm}" aria-label="Search ${r.title ?? 'report'}">
                <button class="btn" form="${searchForm}">Go</button>
                ${actionsMenu}
              </div>`
            : ''}
        </div>
        ${chips.length ? html`<div class="chips">${chips}</div>` : ''}`
      : '';

  // Keep the toolbar only when a search or filter may be the cause, so it can be removed.
  if (failure) return html`${st.filters.length || st.search ? toolbar : ''}<div class="alert alert-error" role="alert">${failure}</div>`;

  const from = total ? (pageNo - 1) * st.size + 1 : 0;
  const to = Math.min(total, pageNo * st.size);
  const empty = r.config.empty ?? 'No data found';
  return html`${toolbar}
    <div class="table-wrap"><table class="report${r.config.mobile === 'scroll' ? '' : ' report-reflow'}">
      <thead><tr>${header}</tr></thead>
      <tbody>${body.length ? body : html`<tr><td colspan="${cols.length || 1}" class="empty">${empty}</td></tr>`}</tbody>
    </table></div>
    ${total > st.size || pageNo > 1
      ? html`<nav class="pager" aria-label="Pagination">
          <span>${from}–${to} of ${total}</span>
          ${pageNo > 1 ? html`<a class="btn" href="${regionUrl(ctx, r, (p) => p.set(key(r, 'p'), String(pageNo - 1)))}">‹ Previous</a>` : ''}
          ${to < total ? html`<a class="btn" href="${regionUrl(ctx, r, (p) => p.set(key(r, 'p'), String(pageNo + 1)))}">Next ›</a>` : ''}
        </nav>`
      : total && searchable
        ? html`<div class="pager"><span>${total} row${total === 1 ? '' : 's'}</span></div>`
        : ''}`;
}
