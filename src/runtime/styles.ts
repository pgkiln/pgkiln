// Theme Roller style variants (APEX: theme styles). An application keeps
// several named styles in meta.app.theme.styles; one is the default
// (theme.style) and, when theme.style_choice is on, each user may pick
// another (My account / the user menu; kept in meta.account_style).
//
// Security: a style's values come from fixed lists (hex colours, keys of
// FONTS / FONT_SIZES / RADII). Only those constants and checked hex values
// are written into the page's nonce'd <style>; a style's name is shown as
// escaped HTML and never reaches CSS. Stored values are checked again here
// when the CSS is made, so a hand-edited theme cannot inject CSS.

import type { App } from '../metadata.ts';
import type { Session } from '../session.ts';

export const HEX = /^#[0-9a-f]{6}$/i;
export const STYLE_NAME = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,29}$/;
export const MAX_STYLES = 10;

/** Font families (key → label and CSS font stack). */
export const FONTS: Record<string, { label: string; css: string }> = {
  system: { label: 'System (default)', css: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  humanist: { label: 'Humanist sans', css: '"Segoe UI", Candara, "Trebuchet MS", "Noto Sans", sans-serif' },
  geometric: { label: 'Geometric sans', css: '"Avenir Next", Avenir, Montserrat, "Century Gothic", "Helvetica Neue", Arial, sans-serif' },
  serif: { label: 'Serif', css: 'Charter, "Bitstream Charter", Cambria, Georgia, "Times New Roman", serif' },
  rounded: { label: 'Rounded', css: 'ui-rounded, "SF Pro Rounded", "Hiragino Maru Gothic ProN", Quicksand, Nunito, system-ui, sans-serif' },
  mono: { label: 'Monospace', css: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
};
/** Base font sizes. */
export const FONT_SIZES: Record<string, { label: string; css: string }> = {
  small: { label: 'Small (14 px)', css: '14px' },
  medium: { label: 'Medium (15 px, default)', css: '15px' },
  large: { label: 'Large (16 px)', css: '16px' },
  xlarge: { label: 'Extra large (17 px)', css: '17px' },
};
/** Corner radius of regions, buttons and fields. */
export const RADII: Record<string, { label: string; css: string }> = {
  none: { label: 'Square (0)', css: '0px' },
  small: { label: 'Small (4 px)', css: '4px' },
  medium: { label: 'Medium (8 px, default)', css: '8px' },
  large: { label: 'Large (14 px)', css: '14px' },
};

export interface StyleVariant {
  name: string;
  accent?: string;
  header?: string;
  font?: string;
  font_size?: string;
  radius?: string;
}

const own = (o: Record<string, unknown>, k: unknown) => typeof k === 'string' && Object.hasOwn(o, k);

/**
 * Check one style variant (from the builder's form or a stored theme).
 * Returns the clean variant or a message. Empty values mean "as the base".
 */
export function parseStyle(v: Record<string, unknown>): StyleVariant | string {
  const name = typeof v.name === 'string' ? v.name.trim() : '';
  if (!STYLE_NAME.test(name)) return 'Name: 1 to 30 letters, digits, spaces, - or _, starting with a letter or digit.';
  const out: StyleVariant = { name };
  for (const k of ['accent', 'header'] as const) {
    const x = v[k];
    if (x === undefined || x === null || x === '') continue;
    if (typeof x !== 'string' || !HEX.test(x)) return `${k === 'accent' ? 'Accent' : 'Header'} colour: #rrggbb.`;
    out[k] = x.toLowerCase();
  }
  for (const [k, list, label] of [['font', FONTS, 'Font'], ['font_size', FONT_SIZES, 'Font size'], ['radius', RADII, 'Corners']] as const) {
    const x = v[k];
    if (x === undefined || x === null || x === '') continue;
    if (!own(list, x)) return `${label}: choose from ${Object.keys(list).join(', ')}.`;
    out[k] = x as string;
  }
  return out;
}

/** The application's valid style variants (invalid stored entries are skipped). */
export function appStyles(theme: App['theme'] | undefined): StyleVariant[] {
  const list = Array.isArray(theme?.styles) ? theme.styles : [];
  const out: StyleVariant[] = [];
  for (const s of list.slice(0, MAX_STYLES)) {
    if (!s || typeof s !== 'object') continue;
    const p = parseStyle(s as Record<string, unknown>);
    if (typeof p !== 'string' && !out.some((o) => o.name.toLowerCase() === p.name.toLowerCase())) out.push(p);
  }
  return out;
}

/** Whether users of the app may choose a style (there is something to choose from). */
export const styleChoice = (app: Pick<App, 'theme'>) => app.theme?.style_choice === true && appStyles(app.theme).length > 0;

/**
 * The style variant for this request: the user's choice (when allowed and the
 * style still exists; '' = the base colours), else the app's default, else none.
 */
export function chosenStyle(app: Pick<App, 'theme'>, session: Pick<Session, 'state'> | undefined): StyleVariant | null {
  const styles = appStyles(app.theme);
  const find = (n: unknown) => (typeof n === 'string' ? styles.find((s) => s.name === n) : undefined);
  if (styleChoice(app)) {
    const mine = session?.state.__STYLE;
    if (mine === '') return null;
    const s = find(mine);
    if (s) return s;
  }
  return find(app.theme?.style) ?? null;
}

/** The name of the style in use ('' = the base colours). */
export const chosenStyleName = (app: Pick<App, 'theme'>, session: Pick<Session, 'state'> | undefined) => chosenStyle(app, session)?.name ?? '';

/** Whether `name` may be chosen by a user of the app ('' = the base colours). */
export const choosable = (app: Pick<App, 'theme'>, name: unknown): name is string =>
  styleChoice(app) && typeof name === 'string' && (name === '' || appStyles(app.theme).some((s) => s.name === name));

const colourVars = (accent?: string, header?: string) => {
  const vars: string[] = [];
  if (accent && HEX.test(accent)) vars.push(`--accent:${accent};--accent-soft:color-mix(in srgb, ${accent} 14%, var(--surface))`);
  if (header && HEX.test(header)) vars.push(`--header:${header};`);
  return vars;
};

/**
 * The theme's CSS: the base colours (Settings → Theme), then the style
 * variant in use. Only checked hex values and constants from the lists above.
 */
export function themeCss(theme: App['theme'] | undefined, style: StyleVariant | null): string {
  const out: string[] = [];
  const base = colourVars(theme?.accent, theme?.header);
  if (base.length) out.push(`:root{${base.join('')}}`);
  if (style) {
    const colours = colourVars(style.accent, style.header);
    if (colours.length) out.push(`:root{${colours.join('')}}`);
    const all: string[] = [];
    if (style.font && own(FONTS, style.font)) all.push(`--font:${FONTS[style.font].css};`);
    if (style.font_size && own(FONT_SIZES, style.font_size)) all.push(`--font-size:${FONT_SIZES[style.font_size].css};`);
    if (style.radius && own(RADII, style.radius)) all.push(`--radius:${RADII[style.radius].css};`);
    if (all.length) out.push(`:root{${all.join('')}}`);
  }
  return out.join('');
}
