// URL region (APEX: URL region): another site's page in the region, in a
// sandboxed iframe.
//
// The region's source is the URL. Its origin must be written out in the
// source (https://host[:port], or a path on this server): an item can't
// choose the host. &ITEM. substitutions are allowed after the origin and are
// URL-encoded. The page's Content-Security-Policy gets frame-src for exactly
// the origins of its URL regions (security.ts), so nothing else can be framed.
// The site itself decides whether it may be framed (X-Frame-Options,
// frame-ancestors): the region has a link to open it in a new tab as well.
//
// Attributes: {"height": 480, "sandbox": ["allow-scripts", ...] | false,
// "fullscreen": true}.
import { html, type Raw } from '../html.ts';
import type { Region } from '../metadata.ts';
import { substitute, type PageContext } from './context.ts';

/** The sandbox flags a region may give its frame. */
export const SANDBOX_FLAGS = [
  'allow-scripts', 'allow-forms', 'allow-popups', 'allow-same-origin', 'allow-downloads', 'allow-modals', 'allow-popups-to-escape-sandbox',
] as const;
const DEFAULT_SANDBOX = ['allow-scripts', 'allow-forms', 'allow-popups', 'allow-same-origin'];
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/i;

export interface UrlRegionConfig {
  height?: number;
  sandbox?: string[] | false;
  fullscreen?: boolean;
}

/**
 * The origin a URL region frames: { origin } for an https URL (http only for
 * localhost), { origin: null } for a path on this server, or { error }.
 */
export function urlTarget(source: string | null | undefined): { origin: string | null } | { error: string } {
  const s = (source ?? '').trim();
  if (!s) return { error: 'A URL region needs a URL in its source.' };
  if (/^\/(?![/\\])/.test(s)) return { origin: null };
  // the scheme and host are literal: no &ITEM. before the path
  const m = /^(https?):\/\/([^/?#&\\\s]+)(?=[/?#]|$)/i.exec(s);
  if (!m) return { error: 'A URL region needs an https:// URL (or a path on this server starting with /); its host can\'t come from an item.' };
  let u: URL;
  try {
    u = new URL(`${m[1]}://${m[2]}/`);
  } catch {
    return { error: 'The URL of this region is not valid.' };
  }
  if (u.username || u.password) return { error: 'A URL region\'s URL can\'t contain a user name or password.' };
  if (u.protocol === 'http:' && !LOCAL.test(u.hostname)) return { error: 'A URL region needs an https:// URL (http:// only for localhost).' };
  return { origin: u.origin };
}

/** The checks of a region's attributes (the builder shows them; the runtime ignores what fails). */
export function urlConfigProblem(config: unknown): string | null {
  const c = (config ?? {}) as UrlRegionConfig;
  if (c.height !== undefined && !(Number.isInteger(c.height) && c.height >= 100 && c.height <= 4000)) return 'height: a whole number of pixels from 100 to 4000.';
  if (c.sandbox !== undefined && c.sandbox !== false) {
    if (!Array.isArray(c.sandbox)) return 'sandbox: a list of flags, or false for no sandbox.';
    const bad = c.sandbox.filter((f) => !(SANDBOX_FLAGS as readonly string[]).includes(f));
    if (bad.length) return `sandbox: unknown flag ${bad[0]} (allowed: ${SANDBOX_FLAGS.join(', ')}).`;
  }
  return null;
}

/** The origins the page's URL regions frame (for the Content-Security-Policy's frame-src). */
export function frameOrigins(regions: Region[]) {
  const out = new Set<string>();
  for (const r of regions) {
    if (r.type !== 'url') continue;
    const t = urlTarget(r.source);
    if (!('error' in t) && t.origin) out.add(t.origin);
  }
  return out;
}

export function renderUrlRegion(ctx: PageContext, r: Region): Raw {
  const t = ctx.locale.t;
  const target = urlTarget(r.source);
  if ('error' in target) return html`<div class="alert alert-error" role="alert">${target.error}</div>`;
  const url = substitute((r.source ?? '').trim(), ctx, encodeURIComponent);
  // the substituted URL still goes to the same origin (substitutions are encoded, but check anyway)
  const resolved = new URL(url, 'https://same.origin.invalid');
  if (target.origin ? resolved.origin !== target.origin : resolved.origin !== 'https://same.origin.invalid')
    return html`<div class="alert alert-error" role="alert">The URL of this region is not valid.</div>`;
  const c = (r.config ?? {}) as UrlRegionConfig;
  const problem = urlConfigProblem(c);
  const height = !problem && c.height ? c.height : 480;
  const sandbox = !problem && c.sandbox === false ? null : (!problem && Array.isArray(c.sandbox) ? c.sandbox : DEFAULT_SANDBOX).join(' ');
  const cls = `url-frame ${ctx.css.cls(`height:${height}px`)}`;
  return html`<iframe class="${cls}" src="${url}" title="${r.title ?? t('region.url_frame')}" loading="lazy" referrerpolicy="strict-origin-when-cross-origin"${
    sandbox === null ? '' : html` sandbox="${sandbox}"`}${c.fullscreen === true ? html` allowfullscreen` : ''}></iframe>
    <p class="url-open"><a href="${url}" target="_blank" rel="noopener noreferrer">${t('region.url_open')}</a></p>`;
}
