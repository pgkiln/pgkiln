// (sprint 230, migration 188, AX-9, AX-10, AX-11) The region's property groups in the Page Designer's property editor, in
// APEX's order: Identification, Source, Layout, Appearance, Accessibility, Advanced, Header and Footer, Server-side
// Condition, Read Only, Security, Server Cache, Customization, Configuration, Comments, Audit Information (the
// region's type adds its own groups on the Attributes tab). components.ts places these lists in the region's spec;
// what each does on the page is src/runtime/region-props.ts. The labels have keys pe.region.<field> and the groups
// pe.group.<group> in src/builder/i18n/* (forms.ts componentForm); the help texts are English, like every other.
import { owner } from '../db.ts';
import { CONDITION_TYPES } from '../metadata.ts';
import { attributesProblem, classListProblem, domIdOk } from '../runtime/region-props.ts';
import type { Field } from './components.ts';

const COLUMNS = ['', ...Array.from({ length: 12 }, (_, i) => String(i + 1))];
const CONDITION_HELP = 'The region\'s items are read-only while this condition holds (also its sub regions\' items), and an interactive grid in it has no Save. '
  + 'The same types as a server-side condition: sql (a boolean expression, e.g. :P3_STATUS = \'CLOSED\'), exists, item_not_null (P3_ID in Expression) …; '
  + 'a broken SQL condition makes the items read-only.';
const ATTRS_HELP = 'name="value" pairs, e.g. data-kind="summary" aria-describedby="P3_HELP" title="&P3_NAME.": data-*, aria-* (not aria-label: '
  + 'use Accessibility → Landmark Label), title, lang, dir, tabindex and translate. Values may use &ITEM. (escaped). Event handlers (on…) and style are refused: '
  + 'the Content-Security-Policy runs no inline code; use dynamic actions and CSS Classes.';

/** Layout: Start New Row and Column (before Column Span). */
export const REGION_LAYOUT_FIELDS: Field[] = [
  { name: 'new_row', label: 'Start new row', kind: 'bool', group: 'Layout',
    help: '(APEX: Start New Row) The region begins a new row of the 12-column grid. Off: it goes beside the region before it while they fit in 12 columns.' },
  { name: 'grid_column', label: 'Column', kind: 'select', options: COLUMNS, emptyLabel: 'Automatic', group: 'Layout',
    help: '(APEX: Column) The column (1-12) the region starts in, e.g. 4 leaves three empty columns before it, or a gap between two regions side by side. Automatic: right after the region before it.' },
];
/** Layout: the row's and the column's classes and attributes (after Column Span). */
export const REGION_GRID_CLASS_FIELDS: Field[] = [
  { name: 'row_css_classes', label: 'Row CSS classes', kind: 'text', group: 'Layout',
    help: '(APEX: Row CSS Classes) Classes of the row this region starts (with Start new row): the row is then an element of its own, <div class="t-row …">, holding the regions up to the next one that starts a new row.' },
  { name: 'column_css_classes', label: 'Column CSS classes', kind: 'text', group: 'Layout',
    help: '(APEX: Column CSS Classes) Classes of the region\'s grid column. In pgkiln\'s grid the column is the region\'s own element, so these go on it, with the CSS Classes of Appearance.' },
  { name: 'column_attributes', label: 'Column attributes', kind: 'text', group: 'Layout', help: `(APEX: Column Attributes) Attributes of the region's grid column (its element). ${ATTRS_HELP}` },
];
/** Appearance after the Template and its options. */
export const REGION_APPEARANCE_FIELDS: Field[] = [
  { name: 'css_classes', label: 'CSS classes', kind: 'text', group: 'Appearance',
    help: '(APEX: CSS Classes) Classes of your own (application CSS, theme styles) on the region\'s element, besides the template options: letters, digits, _ and -, separated by spaces.' },
  { name: 'icon', label: 'Icon', kind: 'icon', group: 'Appearance',
    help: '(APEX: Icon) Shown before the title by the templates with a title (standard, collapsible, title bar, inline dialog and drawer) and as the hero template\'s large icon.' },
  { name: 'render_components', label: 'Render components', kind: 'select', options: ['', 'above', 'below'], emptyLabel: 'Below content', group: 'Appearance',
    help: '(APEX: Render Components) Where the region\'s items show: above or below its content (static content, a chart, a map …). A form\'s items are its content.' },
];
/** Accessibility, Advanced, Header and Footer. */
export const REGION_MORE_FIELDS: Field[] = [
  { name: 'use_landmark', label: 'Use landmark', kind: 'bool', group: 'Accessibility', valueBy: (r) => r.use_landmark !== false,
    help: '(APEX: Use Landmark) A titled region is a landmark (role region) that screen readers list. Off: it isn\'t (decoration, a region inside another landmark).' },
  { name: 'landmark_type', label: 'Landmark type', kind: 'select', options: ['', 'region', 'navigation', 'search', 'complementary', 'banner', 'contentinfo', 'main'], emptyLabel: 'Template default', group: 'Accessibility',
    help: '(APEX: Landmark Type) The ARIA role: navigation (links), search (a search form), complementary (a side column), banner / contentinfo / main (at most one of each per page, and the page has its own).' },
  { name: 'landmark_label', label: 'Landmark label', kind: 'text', group: 'Accessibility',
    help: '(APEX: Landmark Label) The name screen readers give the landmark (aria-label), when it should not be the title, or the region has none. &ITEM. substitutions.' },
  { name: 'dom_id', label: 'HTML DOM ID', kind: 'text', group: 'Advanced',
    help: '(APEX: HTML DOM ID) An id for CSS and JavaScript (#my-region): the region\'s content gets it (the region\'s own element is R<id>, which pgkiln\'s scripts use, and has data-static-id). Letters, digits, _ and -, starting with a letter; not R<number> or an item\'s name.' },
  { name: 'custom_attributes', label: 'Custom attributes', kind: 'text', group: 'Advanced', help: `(APEX: Custom Attributes) Attributes of the region's element. ${ATTRS_HELP}` },
  { name: 'display_selector', label: 'Region display selector', kind: 'bool', group: 'Advanced', config: true,
    valueBy: (r) => r.config?.display_selector === true || (typeof r.config?.display_selector === 'string' && r.config.display_selector.trim() !== ''),
    help: '(APEX: Region Display Selector) The region is a tab of the page\'s display selector region (settings {"display_selector": true}).' },
  { name: 'display_selector_tab', label: 'Display selector tab name', kind: 'text', group: 'Advanced', config: true,
    valueBy: (r) => (typeof r.config?.display_selector === 'string' ? r.config.display_selector : ''),
    help: 'The tab\'s name when it should not be the title; regions with the same tab name share one tab (a smart filters region and its report).' },
  { name: 'title_no_translate', label: 'Exclude title from translation', kind: 'bool', group: 'Advanced',
    help: '(APEX: Exclude Title from Translation) The title stays as it is in every language (a name, a code) and is left out of the texts to translate.' },
  { name: 'header_text', label: 'Header text', kind: 'code', wide: true, group: 'Header and footer',
    help: '(APEX: Header Text) HTML above the region\'s content, as static content: &ITEM. substitutions are escaped, shortcuts ("NAME") expanded; scripts and inline styles don\'t run (Content-Security-Policy). Translated with the application.' },
  { name: 'footer_text', label: 'Footer text', kind: 'code', wide: true, group: 'Header and footer',
    help: '(APEX: Footer Text) HTML below the region\'s content, as the header text.' },
];
/** Read Only (after the server-side condition). */
export const REGION_READ_ONLY_FIELDS: Field[] = [
  { name: 'readonly_type', label: 'Read only: type', kind: 'select', options: ['', ...CONDITION_TYPES], group: 'Read only', help: CONDITION_HELP },
  { name: 'readonly_expr', label: 'Read only: expression / item', kind: 'code', group: 'Read only', help: 'e.g. :P3_STATUS = \'CLOSED\' (sql) · P3_ID (item_not_null)' },
  { name: 'readonly_value', label: 'Read only: value', kind: 'text', group: 'Read only', help: 'item_equals: the value · request_in: SAVE,CREATE …' },
];

/** Server Cache (on the Attributes tab, shown here), Customization (after Security). */
export const REGION_LATE_FIELDS: Field[] = [
  { name: 'server_cache', label: 'Caching', kind: 'text', group: 'Server cache', virtual: true,
    valueBy: (r) => {
      const c = r.config?.cache;
      const lazy = r.config?.lazy === true ? ', lazy loading' : '';
      return c && typeof c === 'object' && c.scope ? `${c.scope === 'all' ? 'for all users' : `per ${c.scope}`}, ${Number(c.seconds) || 300} s${lazy}` : `none${lazy}`;
    },
    help: '(APEX: Server Cache) Set on the Attributes tab (Server cache): per user, per session or for all users with the same roles, for a number of seconds; a submit of the page empties it.' },
  { name: 'customization', label: 'Customization', kind: 'select', options: ['', 'shown', 'hidden'], emptyLabel: 'Not customizable', group: 'Customization',
    help: '(APEX: Customization) Users may show or hide the region on the page\'s Customize link (under the page): shown or hidden until they choose. Their choice is a user preference; the public user sees the default.' },
  { name: 'customization_name', label: 'Customized option name', kind: 'text', group: 'Customization',
    help: '(APEX: Customized Option Name) The region\'s name on the Customize link (default: its title).' },
];

/** Comments and Audit Information (read-only: created and last changed, on and by). */
export const REGION_AUDIT_FIELDS: Field[] = [
  { name: 'comments', label: 'Comments', kind: 'textarea', wide: true, group: 'Comments', help: '(APEX: Comments) Notes for developers; not shown on the page.' },
  ...([['created_on', 'Created on'], ['created_by', 'Created by'], ['updated_on', 'Last updated on'], ['updated_by', 'Last updated by']] as const).map(([name, label]): Field => ({
    name, label, kind: 'text', group: 'Audit information', virtual: true,
    valueBy: (r) => r.__audit?.[name] ?? '',
    ...(name === 'created_on' ? { help: '(APEX: Audit Information) Kept by the builder since version 0.111 (an older region has none until it changes); not exported: an import --replace keeps a region\'s creation.' } : {}),
  })),
];

/** The new properties' checks (the database checks them too). */
export function regionPropsProblem(v: Record<string, any>): string | null {
  if (v.dom_id && !domIdOk(v.dom_id)) return 'HTML DOM ID: letters, digits, _ and -, starting with a letter; not R<number> or an item\'s name (all capitals).';
  return classListProblem('Row CSS classes', v.row_css_classes) ?? classListProblem('Column CSS classes', v.column_css_classes) ?? classListProblem('CSS classes', v.css_classes)
    ?? attributesProblem('Custom attributes', v.custom_attributes) ?? attributesProblem('Column attributes', v.column_attributes);
}

/** Before saving: the display selector's two fields become its one key; the class lists' spaces are tidied. */
export function regionPropsBeforeSave(v: Record<string, any>) {
  const cfg = v.__config as Record<string, unknown> | undefined;
  if (cfg && 'display_selector' in cfg) {
    const tab = typeof cfg.display_selector_tab === 'string' ? cfg.display_selector_tab.trim().slice(0, 60) : '';
    cfg.display_selector = cfg.display_selector === true ? (tab || true) : null;
    delete cfg.display_selector_tab;
  }
  for (const k of ['row_css_classes', 'column_css_classes', 'css_classes'])
    if (typeof v[k] === 'string') v[k] = v[k].trim().split(/\s+/).join(' ') || null;
  // Use Landmark: on is the default (null)
  if (v.use_landmark === true) v.use_landmark = null;
  for (const k of ['new_row', 'title_no_translate']) if (v[k] === false) v[k] = null;
}

/** The regions' Audit Information as row.__audit (the property editor's read-only fields). */
export async function withRegionAudit(rows: { id: number; __audit?: unknown }[]) {
  if (!rows.length) return;
  const audit = (await owner.query(`select region_id, to_char(created_on, 'YYYY-MM-DD HH24:MI') as created_on, created_by, to_char(updated_on, 'YYYY-MM-DD HH24:MI') as updated_on, updated_by
                                  from meta.region_audit where region_id = any($1)`, [rows.map((r) => r.id)])).rows;
  const by = new Map(audit.map((a) => [a.region_id, a]));
  for (const r of rows) r.__audit = by.get(r.id) ?? null;
}

/**
 * After a builder request that changed application `appId` (app-updates.ts): the developer of the region changes it
 * made (the trigger of migration 188 notes when, the request who). Only rows of the last minute without a developer.
 */
export async function stampRegionAudit(appId: number, username: string) {
  const who = username.slice(0, 200);
  await owner.query(
    `update meta.region_audit a set updated_by = $2, created_by = case when a.created_by is null and a.created_on = a.updated_on then $2 else a.created_by end
       from meta.region r join meta.page p on p.id = r.page_id
      where a.region_id = r.id and p.app_id = $1 and a.updated_by is null and a.updated_on > now() - interval '1 minute'`,
    [appId, who],
  );
}
