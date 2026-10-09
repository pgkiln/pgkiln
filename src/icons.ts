import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
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

// (0.31) Beyond these: the Lucide icon set (lucide-static, ISC, about 1,600 line icons in the same
// 24×24 stroke style; APEX: Font APEX), each served on its own as /static/icon/<name>.svg, and
// modifiers after the name like Font APEX's ("users lg", "fa-refresh fa-spin", "truck flip-h success").
// Font APEX names work where Lucide has an icon of that name ("fa-users" → users).

const LUCIDE_DIR = join(dirname(createRequire(import.meta.url).resolve('lucide-static/package.json')), 'icons');
export const LUCIDE_VERSION: string = JSON.parse(readFileSync(join(LUCIDE_DIR, '..', 'package.json'), 'utf8')).version;
let lucide: Set<string> | null = null;
/** The names of the Lucide icons (read once). */
export function lucideNames(): Set<string> {
  lucide ??= new Set(readdirSync(LUCIDE_DIR).filter((f) => f.endsWith('.svg')).map((f) => f.slice(0, -4)));
  return lucide;
}
let tags: Record<string, string[]> | null = null;
/** Lucide's search words per icon. */
export function lucideTags(): Record<string, string[]> {
  tags ??= JSON.parse(readFileSync(join(LUCIDE_DIR, '..', 'tags.json'), 'utf8')) as Record<string, string[]>;
  return tags;
}

/** A Lucide icon as a one-symbol sprite (id "i"), drawn by the same .icon CSS as pgkiln's own; null when there is none. */
export function lucideSymbol(name: string): string | null {
  if (!/^[a-z0-9-]{1,60}$/.test(name) || !lucideNames().has(name)) return null;
  const svg = readFileSync(join(LUCIDE_DIR, `${name}.svg`), 'utf8');
  const inner = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(svg.replace(/<!--[\s\S]*?-->/g, ''))?.[1] ?? '';
  return `<!-- Lucide ${LUCIDE_VERSION}, ISC License, https://lucide.dev/license -->\n<svg xmlns="http://www.w3.org/2000/svg"><symbol id="i" viewBox="0 0 24 24">${inner.trim()}</symbol></svg>\n`;
}

/** Modifiers (with or without Font APEX's fa- prefix) → their classes. */
const MODIFIERS: Record<string, string> = {
  xs: 'icon-xs', sm: 'icon-sm', lg: 'icon-lg', '2x': 'icon-2x', '3x': 'icon-3x', '4x': 'icon-4x',
  spin: 'icon-spin', pulse: 'icon-pulse',
  'rotate-90': 'icon-rotate-90', 'rotate-180': 'icon-rotate-180', 'rotate-270': 'icon-rotate-270',
  'flip-h': 'icon-flip-h', 'flip-horizontal': 'icon-flip-h', 'flip-v': 'icon-flip-v', 'flip-vertical': 'icon-flip-v',
  success: 'icon-success', warning: 'icon-warning', danger: 'icon-danger', info: 'icon-info', muted: 'icon-muted',
};
export const ICON_MODIFIERS = Object.keys(MODIFIERS);

/** An icon value: its name, where it comes from and its modifier classes; null when it names no icon. */
export function iconParts(value: string | null | undefined): { name: string; set: 'pgapex' | 'lucide'; classes: string[] } | null {
  if (!value) return null;
  const tokens = String(value).trim().toLowerCase().split(/\s+/).slice(0, 8).map((t) => (t.startsWith('fa-') ? t.slice(3) : t)).filter((t) => t && t !== 'fa');
  const name = tokens.find((t) => !(t in MODIFIERS));
  if (!name) return null;
  const set = (ICONS as readonly string[]).includes(name) ? 'pgapex' : lucideNames().has(name) ? 'lucide' : null;
  if (!set) return null;
  return { name, set, classes: [...new Set(tokens.filter((t) => t !== name && t in MODIFIERS).map((t) => MODIFIERS[t]))] };
}

/** Whether a value names an icon (pgkiln's or Lucide's, with or without modifiers). */
export const isIcon = (value: string | null | undefined) => !!iconParts(value);

export function icon(name: string | null | undefined, cls = 'icon') {
  const p = iconParts(name);
  if (!p) return '';
  const href = p.set === 'pgapex' ? `/static/icons.svg#${p.name}` : `/static/icon/${p.name}.svg?v=${LUCIDE_VERSION}#i`;
  return html`<svg class="${[cls, ...p.classes].join(' ')}" aria-hidden="true" focusable="false"><use href="${href}"></use></svg>`;
}

/** Lucide icons for a search: exact name, then names starting with it, containing it, then search words. */
export function searchIcons(query: string, limit = 60): string[] {
  const q = query.trim().toLowerCase().replace(/^fa-/, '').replace(/\s+/g, '-');
  if (q.length < 2) return [];
  const words = lucideTags();
  const rank = (n: string) =>
    n === q ? 0 : n.startsWith(q) ? 1 : n.includes(q) ? 2 : (words[n] ?? []).some((w) => w.toLowerCase().includes(q.replace(/-/g, ' '))) ? 3 : 9;
  return [...lucideNames()]
    .map((n) => [n, rank(n)] as const)
    .filter(([, r]) => r < 9)
    .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit)
    .map(([n]) => n);
}
