// Component settings (migration 105; APEX: Shared Components → Component
// Settings): an application's defaults for its built-in component types, used
// where a component sets nothing itself. Every value is bounded here, so a
// hand-edited or imported setting can't make a page read without limits.

export interface ComponentSettings {
  report_rows?: number;
  grid_rows?: number;
  popup_lov_rows?: number;
  lov_max_rows?: number;
  rating_max?: number;
}
export type ComponentSetting = keyof ComponentSettings;

export const COMPONENT_SETTINGS: { key: ComponentSetting; label: string; group: string; min: number; max: number; def: number; help: string }[] = [
  { key: 'report_rows', label: 'Rows per page', group: 'Reports', min: 1, max: 1000, def: 15, help: 'Of a classic or interactive report without its own page size (users can still choose).' },
  { key: 'grid_rows', label: 'Rows per page', group: 'Interactive grids', min: 1, max: 200, def: 25, help: 'Of an interactive grid without its own page size.' },
  { key: 'popup_lov_rows', label: 'Rows per page', group: 'Popup lists of values', min: 1, max: 100, def: 25, help: 'In a popup list of values\' dialog, for items without their own page size.' },
  { key: 'lov_max_rows', label: 'Maximum rows', group: 'Lists of values', min: 1, max: 50_000, def: 5000, help: 'Rows a select list, radio group, checkbox group or popup list reads, for items without their own maximum.' },
  { key: 'rating_max', label: 'Stars', group: 'Star ratings', min: 3, max: 10, def: 5, help: 'Of a star rating item without its own maximum.' },
];

/** The value of a setting: the application's (bounded), else the built-in default. */
export function componentSetting(settings: ComponentSettings | null | undefined, key: ComponentSetting): number {
  const spec = COMPONENT_SETTINGS.find((s) => s.key === key)!;
  const n = Math.floor(Number(settings?.[key]));
  return Number.isFinite(n) && n >= spec.min && n <= spec.max ? n : spec.def;
}

/** The settings from the builder's form: whole numbers within bounds; empty leaves a setting at its default. */
export function componentSettingsFrom(form: Record<string, unknown>): { settings: ComponentSettings; problems: string[] } {
  const settings: ComponentSettings = {};
  const problems: string[] = [];
  for (const s of COMPONENT_SETTINGS) {
    const raw = String(form[s.key] ?? '').trim();
    if (raw === '') continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < s.min || n > s.max) problems.push(`${s.group}, ${s.label}: a whole number from ${s.min} to ${s.max.toLocaleString('en')}.`);
    else settings[s.key] = n;
  }
  return { settings, problems };
}
