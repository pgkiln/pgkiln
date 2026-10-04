import { html, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import type { Region } from '../metadata.ts';
import { publicError, type PageContext } from './context.ts';
import { regionUrl } from './report.ts';
import { describeFacetFilter, facetDefs, facetFilters, facetKeys, facetParamNames, rangeLabel, rangeValue, type FacetDef, type FacetFilter } from './facet-state.ts';
import { facetLabel, facetSource, isFacetSource, rangeCounts, valueCounts } from './facets.ts';

// Smart filters (APEX 22.2+): one search field above a report, with the
// filters in force as chips and suggestions drawn from the facets: values
// that match what was typed, or the most frequent ones. Everything is a GET
// link or form on the report's own URL parameters (facet-state.ts), so it
// works without JavaScript and can be bookmarked.
//   config: {"report": <report region id>, "suggestions": 3, "placeholder": "Search or filter…",
//            "facets": [{"column": "job"}, {"column": "sal", "type": "range", "ranges": [...]}]}

const MAX_SUGGESTIONS = 10;

interface Suggestion {
  f: FacetDef;
  label: Raw | string;
  n: number;
  href: string;
}

export async function renderSmartFilters(ctx: PageContext, r: Region): Promise<Raw> {
  const fs = await facetSource(ctx, r);
  if (!isFacetSource(fs)) return fs ?? html``;
  const { report } = fs;
  const t = ctx.locale.t;
  const k = facetKeys(report.id);
  const qName = `r${report.id}_q`;
  const page = `r${report.id}_p`;
  const formId = `sf${r.id}`;
  const defs = facetDefs(r.config).filter((f) => fs.cols.has(f.column));
  const per = Number.isInteger(r.config.suggestions) ? Math.max(0, Math.min(MAX_SUGGESTIONS, r.config.suggestions)) : 3;
  const filters = facetFilters(ctx.params, report.id, fs.all);
  const own = new Map<string, FacetFilter>(filters.filter((f) => defs.some((d) => d.column === f.column)).map((f) => [f.column, f]));

  // ---- chips: the search term and each filter of this region's facets, each with a remove link
  const chips: Raw[] = [];
  if (fs.search)
    chips.push(html`<li class="chip sf-chip">${t('report.search_chip')}: <b>${fs.search}</b>
      <a href="${regionUrl(ctx, report, (p) => { p.delete(qName); p.delete(page); })}" aria-label="${t('smart.remove', { filter: `${t('report.search_chip')}: ${fs.search}` })}">×</a></li>`);
  for (const f of defs) {
    const x = own.get(f.column);
    if (!x) continue;
    const label = facetLabel(ctx, f);
    if (x.kind === 'values')
      for (const v of x.values) {
        const text = describeFacetFilter({ ...x, values: [v] }, label, t, f);
        chips.push(html`<li class="chip sf-chip${x.exclude ? ' sf-chip-not' : ''}">${text}
          <a href="${regionUrl(ctx, report, (p) => {
            const rest = p.getAll(k.values + f.column).filter((y) => y !== v);
            p.delete(k.values + f.column);
            for (const y of rest) p.append(k.values + f.column, y);
            if (!rest.length) p.delete(k.exclude + f.column);
            p.delete(page);
          })}" aria-label="${t('smart.remove', { filter: text })}">×</a></li>`);
      }
    else {
      const text = describeFacetFilter(x, label, t, f);
      chips.push(html`<li class="chip sf-chip">${text}
        <a href="${regionUrl(ctx, report, (p) => { for (const n of facetParamNames(report.id, f.column)) p.delete(n); p.delete(page); })}" aria-label="${t('smart.remove', { filter: text })}">×</a></li>`);
    }
  }

  // ---- suggestions: values matching the search term (choosing one replaces the term), else the most frequent
  const suggestions: Suggestion[] = [];
  const errors: Raw[] = [];
  if (per > 0)
    for (const f of defs) {
      const label = facetLabel(ctx, f);
      try {
        if (f.type === 'checkbox') {
          const chosen = new Set(ctx.params.getAll(k.values + f.column));
          const rows = await valueCounts(ctx, fs, f, per + chosen.size, fs.search || undefined);
          for (const row of rows.filter((x) => !chosen.has(x.v)).slice(0, per))
            suggestions.push({
              f, label: html`${label}: <b>${row.v}</b>`, n: row.n,
              href: regionUrl(ctx, report, (p) => {
                // a new value of an excluded facet would be excluded too: start the facet afresh
                if (p.get(k.exclude + f.column) === '1') { p.delete(k.values + f.column); p.delete(k.exclude + f.column); }
                p.append(k.values + f.column, row.v);
                if (fs.search) p.delete(qName);
                p.delete(page);
              }),
            });
        } else if (!fs.search && !own.has(f.column)) {
          const counts = await rangeCounts(ctx, fs, f);
          if (!counts) continue;
          f.ranges
            .map((x, i) => ({ x, n: counts[i] }))
            .filter((y) => y.n > 0)
            .slice(0, per)
            .forEach(({ x, n }) =>
              suggestions.push({
                f, label: html`${label}: <b>${rangeLabel(x, t, f)}</b>`, n,
                href: regionUrl(ctx, report, (p) => {
                  for (const name of facetParamNames(report.id, f.column)) p.delete(name);
                  p.set(k.range + f.column, rangeValue(x));
                  p.delete(page);
                }),
              }),
            );
        }
      } catch (e) {
        errors.push(html`<div class="alert alert-error">${await publicError(ctx, e, `smart filter ${f.column}`)}</div>`);
      }
    }

  // GET form: the search term replaces the old one; every other parameter stays
  const keep = [...ctx.params.entries()].filter(([name]) => ![qName, page, 'clear', 'cs'].includes(name));
  ctx.detached.push(
    html`<form id="${formId}" method="get" action="${ctx.base}/${ctx.page.page_no}" role="search">${keep.map(([name, v]) => html`<input type="hidden" name="${name}" value="${v}">`)}</form>`,
  );
  const anyFilter = fs.search !== '' || own.size > 0;
  const placeholder = typeof r.config.placeholder === 'string' && r.config.placeholder ? r.config.placeholder : t('smart.placeholder');
  return html`<div class="smart-filters">
    <div class="sf-bar">
      <span class="sf-icon" aria-hidden="true">${icon('search')}</span>
      ${chips.length ? html`<ul class="sf-chips" aria-label="${t('smart.active')}">${chips}</ul>` : ''}
      <label class="sr-only" for="${formId}_q">${t('report.search')}</label>
      <input type="search" class="sf-input" id="${formId}_q" name="${qName}" form="${formId}" value="${fs.search}" placeholder="${placeholder}" maxlength="200" autocomplete="off">
      <button class="btn" form="${formId}">${t('report.search')}</button>
      ${anyFilter
        ? html`<a class="sf-clear" href="${regionUrl(ctx, report, (p) => { p.delete(qName); p.delete(page); for (const f of defs) for (const n of facetParamNames(report.id, f.column)) p.delete(n); })}">${t('facets.clear')}</a>`
        : ''}
    </div>
    ${suggestions.length
      ? html`<div class="sf-suggestions">
          <span class="sf-suggest-title" id="${formId}_s">${fs.search ? t('smart.matching') : t('smart.suggested')}</span>
          <ul class="sf-chips" aria-labelledby="${formId}_s">${suggestions.map((s) => html`<li><a class="chip chip-suggest" href="${s.href}">${s.label} <span class="facet-count">${s.n}</span></a></li>`)}</ul>
        </div>`
      : fs.search && defs.some((f) => f.type === 'checkbox')
        ? html`<p class="muted sf-none">${t('smart.no_match')}</p>`
        : ''}
    ${errors}
  </div>`;
}
