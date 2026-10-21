import type { Column, Plan } from './ir-plan.ts';
import { CUSTOM_RANGE, facetKeys, facetParamNames, isFacetParam, rangeValue, validBound, type FacetDef, type FacetFilter } from './facet-state.ts';

// (sprint 122, WS-5) "Ask in your own words" on faceted search and smart
// filters (APEX 26.2: natural language for faceted search and smart filters).
// A condition that a facet on the page can hold is set on that facet instead
// of becoming a report filter, so the facet shows it (checked values, a chosen
// range, a smart filter chip) and its counts follow:
//
//   job is clerk, job is analyst    a checkbox facet: its values (one or more)
//   job is not clerk                ... excluded, when the facet allows exclude
//   salary between 1000 and 3000    a range facet with custom ranges: from / to (at least, at most)
//   rating at least 4               a star facet: "4 stars & up"
//
// Anything else (greater than, contains, a facet without custom ranges, a
// column without a facet) stays a report filter. The facets are those of the
// page's faceted search and smart filters regions on the report (columns
// checked there); values and bounds become the facets' own URL parameters,
// which facet-state.ts reads as query parameters, never SQL text.

/** Take the conditions the report's facets can hold out of the plan (plan.filters keeps the rest). */
export function facetSettings(plan: Plan, defs: Map<string, FacetDef>, columns: Column[]): FacetFilter[] {
  const out: FacetFilter[] = [];
  const taken = new Set<string>();
  const byColumn = new Map<string, Plan['filters']>();
  for (const f of plan.filters) if (defs.has(f.column)) byColumn.set(f.column, [...(byColumn.get(f.column) ?? []), f]);
  for (const [column, list] of byColumn) {
    const def = defs.get(column)!;
    const ops = new Set(list.map((f) => f.operator));
    let s: FacetFilter | null = null;
    if (def.type === 'checkbox') {
      const values = [...new Set(list.map((f) => f.value))].filter((v) => v !== '');
      if (values.length === list.length && ops.size === 1 && (ops.has('eq') || (ops.has('ne') && def.exclude)))
        s = { column, kind: 'values', values, exclude: ops.has('ne') };
    } else if (def.type === 'star') {
      const n = Number(list[0].value);
      if (list.length === 1 && ops.has('ge') && Number.isInteger(n) && n >= 1 && n <= def.max) s = { column, kind: 'range', from: String(n), to: '', custom: false };
    } else if (def.custom) {
      const kind = columns.find((c) => c.name === column)?.kind;
      const from = list.find((f) => f.operator === 'ge')?.value ?? '';
      const to = list.find((f) => f.operator === 'le')?.value ?? '';
      if ((kind === 'number' || kind === 'date') && list.length <= 2 && [...ops].every((o) => o === 'ge' || o === 'le') && ops.size === list.length && validBound(from, kind) && validBound(to, kind))
        s = { column, kind: 'range', from, to, custom: true };
    }
    if (s) (out.push(s), taken.add(column));
  }
  plan.filters = plan.filters.filter((f) => !taken.has(f.column));
  return out;
}

/** Set each facet as given (replacing what that facet had). */
export function applyFacetSettings(params: URLSearchParams, rid: number, settings: FacetFilter[]) {
  const k = facetKeys(rid);
  for (const s of settings) {
    for (const n of facetParamNames(rid, s.column)) params.delete(n);
    if (s.kind === 'values') {
      for (const v of s.values) params.append(k.values + s.column, v);
      if (s.exclude) params.set(k.exclude + s.column, '1');
    } else if (!s.custom) params.set(k.range + s.column, rangeValue(s));
    else {
      params.set(k.range + s.column, CUSTOM_RANGE);
      if (s.from) params.set(k.from + s.column, s.from);
      if (s.to) params.set(k.to + s.column, s.to);
    }
  }
  if (settings.length) params.delete(`r${rid}_p`);
}

/** "Start over" clears the report's facets too. */
export function clearFacets(params: URLSearchParams, rid: number) {
  for (const n of [...new Set(params.keys())]) if (isFacetParam(rid, n)) params.delete(n);
}
