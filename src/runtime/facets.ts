import { applyBinds, literal } from '../binds.ts';
import pg from 'pg';
import { savepoint } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import type { Region } from '../metadata.ts';
import { bindValues, publicError, stripSemicolon, toState, type PageContext } from './context.ts';
import { heading } from './items.ts';
import { columnsOf, facetCondition, facetSelections, regionUrl } from './report.ts';

// Faceted search (APEX 19.2+): a region that filters a report region with
// checkbox facets showing live counts. The counts of each facet take the
// search and all *other* facets into account.
//   config: {"report": <report region id>,
//            "facets": [{"column": "job", "label": "Job"}, {"column": "department"}]}
// Selections travel in the report's URL parameters (?r<id>_x_<column>=…).

export async function renderFacets(ctx: PageContext, r: Region): Promise<Raw> {
  const report = ctx.page.regions.find((x) => x.id === Number(r.config.report) && x.type === 'report');
  if (!report) return html`<div class="alert alert-error">Set config.report to the id of a report region on this page.</div>`;
  if (!ctx.vis!.regions.has(report.id)) return html``;
  const facets = (r.config.facets ?? []) as { column: string; label?: string; limit?: number }[];
  const c = ctx.client!;
  const src = stripSemicolon(applyBinds(report.source ?? 'select 1', bindValues(ctx)));
  let cols: Set<string>;
  try {
    cols = new Set(await columnsOf(ctx, src));
  } catch (e) {
    return html`<div class="alert alert-error" role="alert">${await publicError(ctx, e, 'faceted search')}</div>`;
  }
  const search = (ctx.params.get(`r${report.id}_q`) ?? '').trim();
  const formId = `ff${r.id}`;
  const groups: Raw[] = [];

  for (const f of facets) {
    if (!cols.has(f.column)) continue;
    const others = facetSelections(ctx, report, f.column);
    const where = [...others].filter(([col]) => cols.has(col)).map(([col, v]) => facetCondition(col, v));
    if (search) where.push(`"__q"::text ilike ${literal(`%${search.replace(/[\\%_]/g, '\\$&')}%`)}`);
    const col = `"__q".${pg.escapeIdentifier(f.column)}`;
    let values: { v: string | null; n: number }[] = [];
    try {
      const res = await savepoint(c, () =>
        c.query(
          `select ${col}::text as v, count(*)::int as n from (\n${src}\n) "__q"
           ${where.length ? `where ${where.join(' and ')}` : ''}
           group by 1 order by 2 desc, 1 limit ${Math.min(Number(f.limit) || 12, 50)}`,
        ),
      );
      values = res.rows;
    } catch (e) {
      groups.push(html`<div class="alert alert-error">${await publicError(ctx, e, `facet ${f.column}`)}</div>`);
      continue;
    }
    const selected = new Set(ctx.params.getAll(`r${report.id}_x_${f.column}`));
    // keep selected values visible even when their count dropped to 0
    for (const s of selected) if (!values.some((x) => x.v === s)) values.push({ v: s, n: 0 });
    const label = f.label ?? ctx.locale.tr(heading(f.column));
    groups.push(html`<fieldset class="facet">
      <legend>${label}${selected.size
        ? html` <a class="facet-clear" href="${regionUrl(ctx, report, (p) => { p.delete(`r${report.id}_x_${f.column}`); p.delete(`r${report.id}_p`); })}">${ctx.locale.t('facets.clear')}</a>`
        : ''}</legend>
      ${values
        .filter((x) => x.v !== null)
        .map((x) => html`<label class="check facet-value"><input type="checkbox" form="${formId}" name="r${report.id}_x_${f.column}" value="${x.v}"${selected.has(x.v!) ? raw(' checked') : ''} data-facet>
          <span class="facet-label">${toState(x.v)}</span><span class="facet-count">${x.n}</span></label>`)}
    </fieldset>`);
  }

  // GET form with every other parameter preserved (facet boxes use form=)
  const keep = [...ctx.params.entries()].filter(([k]) => !k.startsWith(`r${report.id}_x_`) && ![`r${report.id}_p`, 'clear', 'cs'].includes(k));
  ctx.detached.push(
    html`<form id="${formId}" method="get" action="${ctx.base}/${ctx.page.page_no}">${keep.map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}</form>`,
  );
  const any = facetSelections(ctx, report).size > 0;
  return html`<div class="facets">
    ${groups}
    <div class="buttons facet-actions">
      <button class="btn btn-hot" form="${formId}">${ctx.locale.t('report.apply')}</button>
      ${any ? html`<a class="btn" href="${regionUrl(ctx, report, (p) => { for (const k of [...p.keys()]) if (k.startsWith(`r${report.id}_x_`)) p.delete(k); })}">${ctx.locale.t('report.reset')}</a>` : ''}
    </div>
  </div>`;
}
