import { html } from './html.ts';

// Names available in public/icons.svg (for navigation entries, cards, builder).
export const ICONS = [
  'home', 'users', 'user', 'building', 'chart', 'table', 'list', 'calendar', 'shield', 'history',
  'settings', 'org', 'grid', 'file', 'check', 'menu', 'logout', 'plus', 'download', 'filter',
  'database', 'code', 'activity', 'inbox', 'close', 'chevron', 'edit', 'layers', 'bolt', 'key', 'play', 'upload', 'printer', 'clock', 'search', 'alert',
] as const;

export function icon(name: string | null | undefined, cls = 'icon') {
  if (!name || !(ICONS as readonly string[]).includes(name)) return '';
  return html`<svg class="${cls}" aria-hidden="true" focusable="false"><use href="/static/icons.svg#${name}"></use></svg>`;
}
