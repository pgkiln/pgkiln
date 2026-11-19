import { owner } from '../db.ts';
import { BUILTIN_COMPONENTS } from '../runtime/builtin-components.ts';

// (sprint 231, AX-14; APEX: the Page Designer gallery and the region Type list name the Universal Theme's template
// components, Avatar, Badge, Comments, Content Row, Media List, Metric Card and Timeline, next to Cards and Chart)
// Each built-in template component is an entry of its own in the gallery and in a region's Type list. Such an entry
// is a "component type", template_component:<static id>: it is not stored. A region made from it is a
// template_component region whose config.component is the static id (as before, so exports and the APEX importer
// are unchanged), with a sample query that shows the component at once. A region of a built-in component shows the
// component's name as its type (tree, layout, Type list); one of the application's own components stays
// "Template Component" and is chosen on its Attributes tab.

export const COMPONENT_TYPE_PREFIX = 'template_component:';

/** Gallery names and icons of the built-in template components, by component type. */
const ICONS: Record<string, string> = {
  ut_avatar: 'user', ut_badge: 'tag', ut_comments: 'comments', ut_content_row: 'list', ut_media_list: 'image', ut_metric_card: 'trend-up', ut_timeline: 'history',
};
/** APEX's names (Content Row, Media List, Metric Card), whatever the component's own capitalisation. */
const titleCase = (name: string) => name.replace(/\b[a-z]/g, (c) => c.toUpperCase());
export const COMPONENT_TYPE_LABELS: Record<string, [string, string]> = Object.fromEntries(
  BUILTIN_COMPONENTS.map((c) => [`${COMPONENT_TYPE_PREFIX}${c.static_id}`, [titleCase(c.name), ICONS[c.static_id] ?? 'layers']]),
);

/** A new region's sample rows: the columns are the component's attribute names (their defaults are #NAME#). */
const SAMPLES: Record<string, { source: string; multiple: boolean }> = {
  ut_avatar: { multiple: true, source: "select * from (values ('Ada Lovelace', 'AL'), ('Grace Hopper', 'GH'), ('Alan Turing', 'AT')) as v (name, initials)" },
  ut_badge: { multiple: false, source: "select 'Approved' as label, 'success' as state" },
  ut_comments: { multiple: true, source: "select * from (values ('Ada', 'AL', '2026-01-05', 'Edit the query of this region')) as v (\"user\", initials, \"date\", comment)" },
  ut_content_row: { multiple: true, source: "select * from (values ('First row', 'Edit the query of this region', 'today', 'FR', 'New', 'info')) as v (title, description, misc, initials, badge, state)" },
  ut_media_list: { multiple: true, source: "select * from (values ('First item', 'Edit the query of this region', 'FI', 'New', 'info')) as v (title, description, initials, badge, state)" },
  ut_metric_card: { multiple: true, source: "select * from (values ('Orders', '128', '', '+4% on last month', 'up', 'Edit the query of this region')) as v (label, value, unit, change, trend, description)" },
  ut_timeline: { multiple: true, source: "select * from (values ('Created', '2026-01-05', 'Ada', 'Edit the query of this region', 'info')) as v (title, \"when\", who, body, state)" },
};

/** The built-in component a component type stands for (its static id), or null for any other type. */
export function componentOfType(type: unknown): string | null {
  if (typeof type !== 'string' || !type.startsWith(COMPONENT_TYPE_PREFIX)) return null;
  const id = type.slice(COMPONENT_TYPE_PREFIX.length);
  return BUILTIN_COMPONENTS.some((c) => c.static_id === id) ? id : null;
}

export const isComponentType = (type: unknown) => componentOfType(type) !== null;

/** What a new region of a component type starts with: its title, sample query and settings. */
export function newComponentRegion(type: string) {
  const id = componentOfType(type);
  if (!id) return null;
  const sample = SAMPLES[id];
  return {
    title: `New ${COMPONENT_TYPE_LABELS[type][0].toLowerCase()}`,
    source: sample?.source ?? null,
    config: { component: id, ...(sample?.multiple ? { display: 'multiple' } : {}) },
  };
}

/** A region's type as the Page Designer names it: template_component:<id> for a built-in component, else its type. */
export function regionTypeValue(r: { type: string; config?: unknown }): string {
  if (r.type !== 'template_component') return r.type;
  const c = (r.config && typeof r.config === 'object' ? (r.config as Record<string, unknown>).component : undefined);
  const type = `${COMPONENT_TYPE_PREFIX}${String(c ?? '')}`;
  return componentOfType(type) ? type : r.type;
}

/** The region types of the Type list and the gallery: each built-in component right after Template Component. */
export function withComponentTypes(types: readonly string[]): string[] {
  const at = types.indexOf('template_component');
  const extra = Object.keys(COMPONENT_TYPE_LABELS);
  return at < 0 ? [...types] : [...types.slice(0, at + 1), ...extra, ...types.slice(at + 1)];
}

/**
 * The property editor's Type list sent a component type: the region becomes a template_component region of that
 * component. `body.type` is rewritten in place; the component to set (or null) is returned, applied by
 * applyComponentType() after the region and its Attributes tab are saved.
 */
export function takeComponentType(body: Record<string, unknown>): string | null {
  const id = componentOfType(body.type);
  if (!id) return null;
  body.type = 'template_component';
  return id;
}

/**
 * After a save: the region's component as the Type list chose it, when that is a change (a new region, another
 * type before, or another component). Otherwise the Attributes tab's choice stands. Attributes of another
 * component don't carry over (as on the Attributes tab); a new region gets the sample query when it has none.
 */
export async function applyComponentType(pageId: string | number, regionId: number, component: string, before: { type: string; config?: unknown } | null) {
  const was = before ? regionTypeValue(before) : null;
  const type = `${COMPONENT_TYPE_PREFIX}${component}`;
  if (was === type) return;
  const fresh = newComponentRegion(type)!;
  await owner.query(
    `update meta.region
        set config = case when config->>'component' is distinct from $3 then (coalesce(config, '{}'::jsonb) - 'attributes') || $4::jsonb
                          else config end,
            source = case when $5 and nullif(btrim(source), '') is null then $6 else source end
      where id = $1 and page_id = $2`,
    [regionId, pageId, component, JSON.stringify(fresh.config), !before, fresh.source],
  );
}
