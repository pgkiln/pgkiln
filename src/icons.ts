import { html } from './html.ts';

// Names available in public/icons.svg (for navigation entries, cards, builder).
export const ICONS = [
  'home', 'users', 'user', 'building', 'chart', 'table', 'list', 'calendar', 'shield', 'history',
  'settings', 'org', 'grid', 'file', 'check', 'menu', 'logout', 'plus', 'download', 'filter',
  'database', 'code', 'activity', 'inbox', 'close', 'chevron', 'edit', 'layers', 'bolt', 'key', 'play', 'upload', 'printer', 'clock', 'search', 'alert', 'map', 'scan', 'cloud-off',
  // 0.30: more line icons (APEX: Font APEX)
  'arrow-up', 'arrow-down', 'arrow-left', 'arrow-right', 'chevron-down', 'chevron-up', 'chevron-left', 'external',
  'refresh', 'undo', 'redo', 'compass', 'info', 'help', 'check-circle', 'x-circle', 'plus-circle', 'minus', 'ban',
  'power', 'trash', 'copy', 'save', 'share', 'send', 'link', 'paperclip', 'lock', 'unlock', 'eye', 'eye-off', 'bell',
  'star', 'heart', 'bookmark', 'tag', 'flag', 'pin', 'globe', 'hash', 'at', 'chat', 'comments', 'phone', 'megaphone',
  'folder', 'archive', 'image', 'camera', 'video', 'book', 'clipboard', 'note', 'qr', 'barcode', 'briefcase', 'cart',
  'credit-card', 'wallet', 'coins', 'percent', 'calculator', 'receipt', 'truck', 'box', 'store', 'factory', 'target',
  'trophy', 'gift', 'id-card', 'user-plus', 'graduation', 'lightbulb', 'pie-chart', 'line-chart', 'trend-up',
  'trend-down', 'kanban', 'dashboard', 'sliders', 'server', 'cloud', 'wifi', 'cpu', 'tool', 'car', 'plane', 'route',
  'home-heart', 'hospital', 'heart-pulse', 'leaf', 'sun', 'moon', 'droplet', 'thermometer',
] as const;

export function icon(name: string | null | undefined, cls = 'icon') {
  if (!name || !(ICONS as readonly string[]).includes(name)) return '';
  return html`<svg class="${cls}" aria-hidden="true" focusable="false"><use href="/static/icons.svg#${name}"></use></svg>`;
}
