import { applyBinds, queryValues, SqlParams } from '../binds.ts';
import pg from 'pg';
import { savepoint } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import type { Region } from '../metadata.ts';
import { bindValues, publicError, stripSemicolon, toState, type PageContext } from './context.ts';
import { heading } from './items.ts';
import { fieldsOf, regionUrl } from './report.ts';
import {
  CUSTOM_RANGE, facetDefs, facetFilters, facetKeys, facetParamNames, facetWhere, rangeKind, rangeLabel, rangeSql, rangeValue,
  reportFacetDefs, searchSql, type FacetDef,
} from './facet-state.ts';
import { resolveRestRegion } from './rest-sources.ts';

// Faceted search (APEX 19.2+): a region that filters a report region with
// facets showing live counts. The counts of each facet take the search and
// all *other* facets into account.
//   config: {"report": <report region id>, "search": true,
//            "facets": [{"column": "job", "label": "Job", "exclude": true},
//                       {"column": "sal", "type": "range", "ranges": [{"to": 1000}, {"from": 1000, "to": 3000}, {"from": 3000}]},
//                       {"column": "hiredate", "type": "range"},          (no ranges: from/to fields)
//                       {"column": "rating", "type": "star", "max": 5}]}
// Selections travel in the report's URL parameters (facet-state.ts).

/** What the facets of a region count over: the report's query, its columns and the filters in force. */
export interface FacetSource {
  report: Region;
  src: string;
  cols: Map<string, number>;
  /** every facet that may filter the report (of all filter regions on the page) */
  all: Map<string, FacetDef>;
  search: string;
}

/** The report a facets or smart filters region filters, or a message why there is none (null: the report isn't shown). */
export async function facetSource(ctx: PageContext, r: Region): Promise<FacetSource | Raw | null> {
  const report = ctx.page.regions.find((x) => x.id === Number(r.config.report) && x.type === 'report');
  if (!report) return html`<div class="alert alert-error">${ctx.locale.t('facets.no_report')}</div>`;
  if (!ctx.vis!.regions.has(report.id)) return null;
  try {
    await resolveRestRegion(ctx, report);
    const src = stripSemicolon(applyBinds(report.source ?? 'select 1', bindValues(ctx)));
    const cols = new Map((await fieldsOf(ctx, src)).map((f) => [f.name, f.dataTypeID] as [string, number]));
    return { report, src, cols, all: reportFacetDefs(ctx.page.regions, report.id, ctx.vis?.regions), search: (ctx.params.get(`r${report.id}_q`) ?? '').trim() };
  } catch (e) {
    return html`<div class="alert alert-error" role="alert">${await publicError(ctx, e, r.type === 'facets' ? 'faceted search' : 'smart filters')}</div>`;
  }
}

export const isFacetSource = (x: FacetSource | Raw | null): x is FacetSource => x !== null && 'report' in x;

const col = (name: string) => `"__q".${pg.escapeIdentifier(name)}`;

/** The search and every other facet's filter, as conditions (their values in p). */
function othersWhere(ctx: PageContext, fs: FacetSource, except: string, p: SqlParams, withSearch = true) {
  const where = facetWhere(ctx.params, fs.report.id, fs.all, fs.cols, p, except);
  if (withSearch && fs.search) where.unshift(searchSql(fs.search, p));
  return where;
}

/**
 * The most frequent values of a checkbox facet with their counts. With
 * `match`: only values containing it, counted without the search (a smart
 * filter suggestion replaces the search term).
 */
export async function valueCounts(ctx: PageContext, fs: FacetSource, f: FacetDef, limit: number, match?: string) {
  const p = new SqlParams();
  const where = othersWhere(ctx, fs, f.column, p, match === undefined);
  where.push(`${col(f.column)} is not null`);
  if (match !== undefined) where.push(`${col(f.column)}::text ilike ${p.add(`%${match.replace(/[\\%_]/g, '\\$&')}%`, 'text')}`);
  const c = ctx.client!;
  const res = await savepoint(c, () =>
    c.query<{ v: string; n: number }>({
      text: `select ${col(f.column)}::text as v, count(*)::int as n from (\n${fs.src}\n) "__q"
              where ${where.join(' and ')}
              group by 1 order by 2 desc, 1 limit ${Math.max(1, Math.min(limit, 50))}`,
      values: queryValues(p.values),
    }),
  );
  return res.rows;
}

/** The number of rows in each predefined range of a range or star facet (null when the column is no number or date). */
export async function rangeCounts(ctx: PageContext, fs: FacetSource, f: FacetDef): Promise<number[] | null> {
  const p = new SqlParams();
  const conds = f.ranges.map((x) => rangeSql(col(f.column), fs.cols.get(f.column), x, p));
  if (!rangeKind(fs.cols.get(f.column)) || conds.some((x) => x === null)) return null;
  if (!conds.length) return [];
  const where = othersWhere(ctx, fs, f.column, p);
  const c = ctx.client!;
  const res = await savepoint(c, () =>
    c.query({
      text: `select ${conds.map((x) => `count(*) filter (where ${x})::int`).join(', ')} from (\n${fs.src}\n) "__q"${where.length ? ` where ${where.join(' and ')}` : ''}`,
      values: queryValues(p.values),
      rowMode: 'array',
    }),
  );
  return res.rows[0] as number[];
}

export const facetLabel = (ctx: PageContext, f: FacetDef) => f.label ?? ctx.locale.tr(heading(f.column));

/** A star rating drawn with stars, read as "4 stars and up". */
export function starLabel(ctx: PageContext, f: FacetDef, n: number) {
  return html`<span class="facet-stars" aria-hidden="true">${'★'.repeat(n)}<span class="facet-stars-off">${'★'.repeat(Math.max(0, f.max - n))}</span></span><span class="sr-only">${ctx.locale.t(n === 1 ? 'facets.star_up' : 'facets.stars_up', { n: String(n) })}</span>`;
}

export async function renderFacets(ctx: PageContext, r: Region): Promise<Raw> {
  const fs = await facetSource(ctx, r);
  if (!isFacetSource(fs)) return fs ?? html``;
  const { report } = fs;
  const t = ctx.locale.t;
  const k = facetKeys(report.id);
  const formId = `ff${r.id}`;
  const defs = facetDefs(r.config).filter((f) => fs.cols.has(f.column));
  const active = new Set(facetFilters(ctx.params, report.id, fs.all).map((f) => f.column));
  const groups: Raw[] = [];
  const clearLink = (f: FacetDef) =>
    active.has(f.column)
      ? html` <a class="facet-clear" href="${regionUrl(ctx, report, (p) => { for (const n of facetParamNames(report.id, f.column)) p.delete(n); p.delete(`r${report.id}_p`); })}" aria-label="${t('facets.clear_one', { facet: facetLabel(ctx, f) })}">${t('facets.clear_short')}</a>`
      : '';

  // the search facet: the report's own search, in the facet panel
  if (r.config.search === true) {
    groups.push(html`<div class="facet facet-search">
      <label class="facet-search-label" for="${formId}_q">${t('report.search')}</label>
      <input type="search" id="${formId}_q" name="r${report.id}_q" form="${formId}" value="${fs.search}" placeholder="${t('report.search_placeholder')}" maxlength="200">
    </div>`);
  }

  for (const f of defs) {
    const label = facetLabel(ctx, f);
    if (f.type === 'checkbox') {
      let values: { v: string; n: number }[];
      try {
        values = await valueCounts(ctx, fs, f, Number(f.limit) || 12);
      } catch (e) {
        groups.push(html`<div class="alert alert-error">${await publicError(ctx, e, `facet ${f.column}`)}</div>`);
        continue;
      }
      const selected = new Set(ctx.params.getAll(k.values + f.column));
      // keep selected values visible even when their count dropped to 0
      for (const s of selected) if (s && !values.some((x) => x.v === s)) values.push({ v: s, n: 0 });
      const excluded = f.exclude && ctx.params.get(k.exclude + f.column) === '1';
      groups.push(html`<fieldset class="facet${excluded ? ' facet-excluded' : ''}">
        <legend>${label}${clearLink(f)}</legend>
        ${values.map((x) => html`<label class="check facet-value"><input type="checkbox" form="${formId}" name="${k.values}${f.column}" value="${x.v}"${selected.has(x.v) ? raw(' checked') : ''} data-facet>
            <span class="facet-label">${toState(x.v)}</span><span class="facet-count">${x.n}</span></label>`)}
        ${f.exclude
          ? html`<label class="check facet-exclude"><input type="checkbox" form="${formId}" name="${k.exclude}${f.column}" value="1"${excluded ? raw(' checked') : ''} data-facet> ${t('facets.exclude')}</label>`
          : ''}
      </fieldset>`);
      continue;
    }

    // range and star facets: one choice (radio buttons), and for a range facet maybe its own from/to
    let counts: number[] | null;
    try {
      counts = await rangeCounts(ctx, fs, f);
    } catch (e) {
      groups.push(html`<div class="alert alert-error">${await publicError(ctx, e, `facet ${f.column}`)}</div>`);
      continue;
    }
    const kind = rangeKind(fs.cols.get(f.column));
    if (counts === null || !kind) {
      groups.push(html`<div class="alert alert-error">${t('facets.not_range', { facet: label })}</div>`);
      continue;
    }
    const chosen = ctx.params.get(k.range + f.column) ?? '';
    const from = ctx.params.get(k.from + f.column) ?? '';
    const to = ctx.params.get(k.to + f.column) ?? '';
    const isCustom = f.custom && (chosen === CUSTOM_RANGE || (!chosen && (from !== '' || to !== '')));
    const name = k.range + f.column;
    const radio = (value: string, on: boolean, body: Raw | string, n?: number) =>
      html`<label class="check facet-value"><input type="radio" form="${formId}" name="${name}" value="${value}"${on ? raw(' checked') : ''}${value === CUSTOM_RANGE ? raw(' data-facet-custom') : raw(' data-facet')}>
        <span class="facet-label">${body}</span>${n === undefined ? '' : html`<span class="facet-count">${n}</span>`}</label>`;
    const fid = `${formId}_${f.column.replace(/[^A-Za-z0-9_]/g, '_')}`;
    const input = (which: 'from' | 'to', value: string) =>
      html`<label class="sr-only" for="${fid}_${which}">${label}: ${t(`facets.${which}`)}</label>
        <input id="${fid}_${which}" type="${kind === 'date' ? 'date' : 'number'}"${kind === 'number' ? raw(' step="any"') : ''} form="${formId}" name="${which === 'from' ? k.from : k.to}${f.column}" value="${isCustom ? value : ''}" placeholder="${t(`facets.${which}`)}">`;
    groups.push(html`<fieldset class="facet facet-range">
      <legend>${label}${clearLink(f)}</legend>
      ${f.ranges.length ? radio('', !chosen && !isCustom, t('facets.any')) : ''}
      ${f.ranges.map((x, i) => radio(rangeValue(x), chosen === rangeValue(x), f.type === 'star' ? starLabel(ctx, f, Number(x.from)) : rangeLabel(x, t), counts![i]))}
      ${f.custom
        ? html`${f.ranges.length ? radio(CUSTOM_RANGE, isCustom, t('facets.custom')) : ''}
          <div class="facet-custom" data-facet-range="${name}">
            ${input('from', from)}<span aria-hidden="true">–</span>${input('to', to)}
            <button class="btn" form="${formId}">${t('report.apply')}</button>
          </div>`
        : ''}
    </fieldset>`);
  }

  // GET form with every other parameter preserved (facet fields use form=)
  const own = new Set(defs.flatMap((f) => facetParamNames(report.id, f.column)));
  const drop = new Set([`r${report.id}_p`, 'clear', 'cs', ...(r.config.search === true ? [`r${report.id}_q`] : [])]);
  const keep = [...ctx.params.entries()].filter(([name]) => !own.has(name) && !drop.has(name));
  ctx.detached.push(
    html`<form id="${formId}" method="get" action="${ctx.base}/${ctx.page.page_no}">${keep.map(([name, v]) => html`<input type="hidden" name="${name}" value="${v}">`)}</form>`,
  );
  const any = defs.some((f) => active.has(f.column)) || (r.config.search === true && fs.search !== '');
  return html`<div class="facets">
    ${groups}
    <div class="buttons facet-actions">
      <button class="btn btn-hot" form="${formId}">${t('report.apply')}</button>
      ${any ? html`<a class="btn" href="${regionUrl(ctx, report, (p) => { for (const n of [...p.keys()]) if (own.has(n)) p.delete(n); for (const n of drop) p.delete(n); })}">${t('report.reset')}</a>` : ''}
    </div>
  </div>`;
}
