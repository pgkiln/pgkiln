// Template options (APEX: Template Options): a fixed list of CSS classes per
// component type, chosen per region or button in the Page Designer and kept
// in its template_options column. Only classes from these lists are written
// into the page; unknown values (an older export, a hand edit) are ignored.
// The styles are in public/app.css ("template options").

export interface TemplateOption {
  /** the CSS class */
  cls: string;
  label: string;
}

export const REGION_OPTIONS: readonly TemplateOption[] = [
  { cls: 'to-accent', label: 'Accent top border' },
  { cls: 'to-flat', label: 'Flat (no shadow)' },
  { cls: 'to-borderless', label: 'No border or background' },
  { cls: 'to-compact', label: 'Compact (less padding)' },
  { cls: 'to-no-padding', label: 'No body padding' },
  { cls: 'to-scroll', label: 'Scroll the body (at most 24 rem high)' },
  { cls: 'to-stretch', label: 'Stretch to the row height' },
  { cls: 'to-center', label: 'Centre the text' },
  { cls: 'to-hide-header', label: 'Hide the header (kept for screen readers)' },
];

export const BUTTON_OPTIONS: readonly TemplateOption[] = [
  { cls: 'to-small', label: 'Small' },
  { cls: 'to-large', label: 'Large' },
  { cls: 'to-block', label: 'Full width' },
  { cls: 'to-pill', label: 'Pill (rounded ends)' },
  { cls: 'to-outline', label: 'Outline in the accent colour' },
  { cls: 'to-link', label: 'Looks like a link' },
  { cls: 'to-success', label: 'Success (green)' },
  { cls: 'to-danger', label: 'Danger (red)' },
];

/** (066) items: on the item's field wrapper */
export const ITEM_OPTIONS: readonly TemplateOption[] = [
  { cls: 'to-stretch', label: 'Stretch (the whole row)' },
  { cls: 'to-large', label: 'Large field' },
  { cls: 'to-quiet', label: 'Quiet (no border until focused)' },
  { cls: 'to-bold', label: 'Bold value' },
  { cls: 'to-hide-label', label: 'Hide the label (kept for screen readers)' },
];

/** (0.29) report columns: on the column's cells (region config "column_options") */
export const COLUMN_OPTIONS: readonly TemplateOption[] = [
  { cls: 'to-col-bold', label: 'Bold' },
  { cls: 'to-col-muted', label: 'Muted' },
  { cls: 'to-col-nowrap', label: 'No wrapping' },
  { cls: 'to-col-mono', label: 'Monospace' },
  { cls: 'to-col-right', label: 'Right-aligned' },
  { cls: 'to-col-center', label: 'Centred' },
];

export const TEMPLATE_OPTIONS = { region: REGION_OPTIONS, button: BUTTON_OPTIONS, item: ITEM_OPTIONS, column: COLUMN_OPTIONS } as const;

/** The known classes among `chosen`, in the list's order, as " a b" (or ''). */
export function templateClasses(kind: keyof typeof TEMPLATE_OPTIONS, chosen: unknown): string {
  if (!Array.isArray(chosen) || !chosen.length) return '';
  return TEMPLATE_OPTIONS[kind].filter((o) => chosen.includes(o.cls)).map((o) => ` ${o.cls}`).join('');
}
