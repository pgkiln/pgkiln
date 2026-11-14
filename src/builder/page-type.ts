// (sprint 193, NX-F3) A page's type for the Pages report (APEX: Pages report → Type: Interactive Report, Form,
// Faceted Search, …). pgkiln keeps no type on a page: it is derived from the page's regions.
//
// The rule, in this order:
//   1. no regions: blank
//   2. a login region: login
//   3. a faceted search or smart filters region beside a report, cards, map or classic report: facets / smart_filters
//   4. the main region is the first region (by sequence) that shows content: not a breadcrumb, help text,
//      region display selector or static content
//   5. two charts or more and the main region is a chart, cards, metric content or a template component: dashboard
//   6. otherwise the main region's type (report, grid, form, chart, cards, calendar, map, tree, …)
//   7. only static content (and decorations): static
import type { BuilderKey } from './i18n.ts';

const DECORATION = new Set(['breadcrumb', 'help_text', 'display_selector', 'static']);
const FILTERED = new Set(['report', 'cards', 'map', 'classic_report']);
const DASHBOARD_PARTS = new Set(['chart', 'cards', 'dynamic', 'template_component']);

/** The page types the rule gives, in the order of the report's Type filter. */
export const PAGE_TYPES = [
  'report', 'classic_report', 'grid', 'form', 'facets', 'smart_filters', 'dashboard', 'chart', 'cards', 'calendar', 'map',
  'tree', 'tasks', 'workflows', 'workflow_diagram', 'template_component', 'list', 'search', 'data_reporter', 'form_designer',
  'ai_assistant', 'plugin', 'url', 'dynamic', 'login', 'static', 'blank',
] as const;
export type PageType = (typeof PAGE_TYPES)[number];

export function pageType(regions: readonly { type: string; seq?: number | null; id?: number }[]): PageType {
  if (!regions.length) return 'blank';
  const sorted = [...regions].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || (a.id ?? 0) - (b.id ?? 0));
  const types = new Set(sorted.map((r) => r.type));
  if (types.has('login')) return 'login';
  const filtered = sorted.some((r) => FILTERED.has(r.type));
  if (filtered && types.has('facets')) return 'facets';
  if (filtered && types.has('smart_filters')) return 'smart_filters';
  const main = sorted.find((r) => !DECORATION.has(r.type));
  if (!main) return 'static';
  if (sorted.filter((r) => r.type === 'chart').length >= 2 && DASHBOARD_PARTS.has(main.type)) return 'dashboard';
  return ((PAGE_TYPES as readonly string[]).includes(main.type) ? main.type : 'static') as PageType;
}

/** The builder's words for a page type (the region type names the App Gallery uses, Dashboard and Blank). */
export function pageTypeKey(t: PageType): BuilderKey {
  if (t === 'dashboard') return 'wiz.kind.dashboard';
  if (t === 'blank') return 'app.type.blank';
  return `gallery.region.${t}` as BuilderKey;
}
