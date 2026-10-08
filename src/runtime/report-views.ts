import pg from 'pg';
import { literal } from '../binds.ts';
import { savepoint } from '../db.ts';
import { html, type Raw } from '../html.ts';
import type { Region } from '../metadata.ts';
import { renderChartBody, type ChartKind } from './charts.ts';
import { publicError, type PageContext } from './context.ts';
import { aggregateFormat, AGGREGATES, cell, columnFormats, filtered, headingOf, isNumeric, q, type ReportState } from './report.ts';

// The other views of an interactive report (APEX: Group By, Pivot, Chart),
// chosen with ?r<id>_v=group|pivot|chart. Each runs one aggregate query
// over all filtered rows (search, filters, facets and computed columns
// included). Column names come from the result of the report's own query;
// functions from the AGGREGATES whitelist.

export type View = 'report' | 'group' | 'pivot' | 'chart';
export const VIEWS: View[] = ['report', 'group', 'pivot', 'chart'];

const MAX_GROUPS = 1000;
const MAX_PIVOT_VALUES = 30;
const MAX_CHART_LABELS = 50;

/** fn(column) when the function suits the column's type, else null. */
function aggSql(fn: string, column: string, cols: Map<string, number>) {
  const a = AGGREGATES[fn];
  if (!a || !cols.has(column) || (a.numeric && !isNumeric(cols.get(column)!))) return null;
  return a.sql(q(column));
}

const notice = (text: string) => html`<p class="muted view-note">${text}</p>`;

async function groupBy(ctx: PageContext, r: Region, st: ReportState): Promise<Raw> {
  const t = ctx.locale.t;
  const { src, where, userCols: cols, values } = await filtered(ctx, r, st);
  const groupCols = st.groupBy.columns.filter((c) => cols.has(c));
  if (!groupCols.length) return notice(t('report.view_not_set'));
  const fns = st.groupBy.functions.flatMap((f) => {
    const sql = aggSql(f.fn, f.column, cols);
    return sql ? [{ ...f, sql }] : [];
  });
  const measures = [{ label: t('report.rows'), sql: 'count(*)' }, ...fns.map((f) => ({ label: `${t(`agg.${f.fn}`)}: ${headingOf(r, f.column, ctx.locale.tr)}`, sql: f.sql }))];
  const c = ctx.client!;
  const res = await savepoint(c, () =>
    c.query({
      text: `select ${groupCols.map(q).join(', ')}, ${measures.map((m) => m.sql).join(', ')}
               from (\n${src}\n) "__q"${where}
              group by ${groupCols.map((_, i) => i + 1).join(', ')}
              order by ${groupCols.map((_, i) => `${i + 1} nulls last`).join(', ')}
              limit ${MAX_GROUPS + 1}`,
      values,
      rowMode: 'array',
    }),
  );
  const rows = res.rows.slice(0, MAX_GROUPS);
  // group columns and sums, averages, minimums and maximums keep their column's format mask
  const fmtOf = columnFormats(ctx, r);
  const fmts = [...groupCols.map((col) => fmtOf(col)), ctx.locale.format, ...fns.map((f) => aggregateFormat(f.fn, f.column, fmtOf, ctx.locale.format))];
  const num = (i: number) => isNumeric(res.fields[i].dataTypeID);
  const heads = [...groupCols.map((col) => headingOf(r, col, ctx.locale.tr)), ...measures.map((m) => m.label)];
  return html`<div class="table-wrap"><table class="report report-reflow report-group">
      <caption class="sr-only">${t('report.view_group')}</caption>
      <thead><tr>${heads.map((h, i) => html`<th scope="col" class="${num(i) ? 'num' : null}">${h}</th>`)}</tr></thead>
      <tbody>${rows.length
        ? rows.map((row) => html`<tr>${row.map((v, i) => html`<td class="${num(i) ? 'num' : null}" data-label="${heads[i]}">${cell(v, res.fields[i].dataTypeID, fmts[i]) || (i < groupCols.length ? '—' : '')}</td>`)}</tr>`)
        : html`<tr><td colspan="${heads.length}" class="empty">${r.config.empty ?? t('report.no_data')}</td></tr>`}</tbody>
    </table></div>
    ${res.rows.length > MAX_GROUPS ? notice(t('report.view_truncated', { rows: MAX_GROUPS })) : ''}`;
}

async function pivot(ctx: PageContext, r: Region, st: ReportState): Promise<Raw> {
  const t = ctx.locale.t;
  const pv = st.pivot;
  const { src, where, userCols: cols, values: params } = await filtered(ctx, r, st);
  const measure = pv && cols.has(pv.row) && cols.has(pv.column) ? aggSql(pv.fn, pv.value, cols) : null;
  if (!pv || !measure) return notice(t('report.view_not_set'));
  const c = ctx.client!;
  const values = (
    await savepoint(c, () =>
      c.query<{ v: string | null }>({ text: `select distinct ${q(pv.column)}::text as v from (\n${src}\n) "__q"${where} order by 1 nulls last limit ${MAX_PIVOT_VALUES + 1}`, values: params }),
    )
  ).rows.map((x) => x.v);
  const shown = values.slice(0, MAX_PIVOT_VALUES);
  // fn(case when <pivot value> then value end): the same result as a FILTER clause, for every whitelisted function
  const cellSql = (cond: string) => AGGREGATES[pv.fn].sql(`case when ${cond} then ${q(pv.value)} end`);
  const conds = shown.map((v) => (v === null ? `${q(pv.column)} is null` : `${q(pv.column)}::text = ${literal(v)}`));
  const res = await savepoint(c, () =>
    c.query({
      text: `select ${q(pv.row)}, ${conds.map(cellSql).join(', ')}${conds.length ? ', ' : ''}${measure}
               from (\n${src}\n) "__q"${where}
              group by 1 order by 1 nulls last limit ${MAX_GROUPS + 1}`,
      values: params,
      rowMode: 'array',
    }),
  );
  const rows = res.rows.slice(0, MAX_GROUPS);
  const fmtOf = columnFormats(ctx, r);
  const rowFmt = fmtOf(pv.row);
  const valueFmt = aggregateFormat(pv.fn, pv.value, fmtOf, ctx.locale.format);
  const heads = [headingOf(r, pv.row, ctx.locale.tr), ...shown.map((v) => v ?? '—'), t('report.total')];
  const num = (i: number) => i > 0 && isNumeric(res.fields[i].dataTypeID);
  return html`<p class="muted view-note">${t(`agg.${pv.fn}`)}: ${headingOf(r, pv.value, ctx.locale.tr)} · ${headingOf(r, pv.column, ctx.locale.tr)}</p>
    <div class="table-wrap"><table class="report report-pivot">
      <caption class="sr-only">${t('report.view_pivot')}</caption>
      <thead><tr>${heads.map((h, i) => html`<th scope="col" class="${i > 0 ? 'num' : null}">${h}</th>`)}</tr></thead>
      <tbody>${rows.length
        ? rows.map((row) => html`<tr>${row.map((v, i) =>
            i === 0 ? html`<th scope="row">${cell(v, res.fields[0].dataTypeID, rowFmt) || '—'}</th>` : html`<td class="${num(i) ? 'num' : null}">${cell(v, res.fields[i].dataTypeID, valueFmt)}</td>`)}</tr>`)
        : html`<tr><td colspan="${heads.length}" class="empty">${r.config.empty ?? t('report.no_data')}</td></tr>`}</tbody>
    </table></div>
    ${values.length > MAX_PIVOT_VALUES ? notice(t('report.pivot_truncated', { values: MAX_PIVOT_VALUES })) : ''}
    ${res.rows.length > MAX_GROUPS ? notice(t('report.view_truncated', { rows: MAX_GROUPS })) : ''}`;
}

async function chart(ctx: PageContext, r: Region, st: ReportState): Promise<Raw> {
  const t = ctx.locale.t;
  const ch = st.chart;
  const { src, where, userCols: cols, values } = await filtered(ctx, r, st);
  const measure = ch && cols.has(ch.label) ? aggSql(ch.fn, ch.value, cols) : null;
  if (!ch || !measure) return notice(t('report.view_not_set'));
  const series = `${t(`agg.${ch.fn}`)}: ${headingOf(r, ch.value, ctx.locale.tr)}`;
  const c = ctx.client!;
  const res = await savepoint(c, () =>
    c.query({
      text: `select coalesce(${q(ch.label)}::text, '—') as ${pg.escapeIdentifier(headingOf(r, ch.label, ctx.locale.tr))}, ${measure} as ${pg.escapeIdentifier(series)}
               from (\n${src}\n) "__q"${where}
              group by 1 order by 1 limit ${MAX_CHART_LABELS + 1}`,
      values,
      rowMode: 'array',
    }),
  );
  if (!res.rows.length) return html`<p class="empty">${r.config.empty ?? t('report.no_data')}</p>`;
  return html`${renderChartBody(ch.kind as ChartKind, r.title ?? '', res.rows.slice(0, MAX_CHART_LABELS), res.fields, ctx.css, ctx.locale.lang, t)}
    ${res.rows.length > MAX_CHART_LABELS ? notice(t('report.chart_truncated', { labels: MAX_CHART_LABELS })) : ''}`;
}

/** The group by, pivot or chart view of a report region. */
export async function renderView(ctx: PageContext, r: Region, st: ReportState): Promise<Raw> {
  try {
    if (st.view === 'group') return await groupBy(ctx, r, st);
    if (st.view === 'pivot') return await pivot(ctx, r, st);
    return await chart(ctx, r, st);
  } catch (e) {
    return html`<div class="alert alert-error" role="alert">${await publicError(ctx, e, `report "${r.title ?? r.id}"`)}</div>`;
  }
}
