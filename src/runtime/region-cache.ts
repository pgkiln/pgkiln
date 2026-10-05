import { createHash } from 'node:crypto';
import { raw, type Raw } from '../html.ts';
import type { Region } from '../metadata.ts';
import { PageCss } from '../css.ts';
import { bindValues, type PageContext } from './context.ts';

// Region caching and lazy loading (like APEX's region "Server Cache" and
// "Lazy Loading").
//
// config.cache = {"scope": "user" | "session" | "all", "seconds": 300} keeps a
// region's rendered HTML in this server's memory. The key always holds the
// application, page, region definition, language, time zone, the user's roles, the
// request's query string, the values of the items and built-in substitutions
// the region refers to and of its own items, and, per scope, the user name or
// the session; so a cached region never crosses applications, and never
// crosses users or sessions where its scope says it must not. The session's
// CSRF token is stored as a placeholder and filled in per request, and a
// region whose links carry per-user checksums is not stored for all users.
// A submit of the page drops its cached regions (invalidatePage).
//
// config.lazy = true sends a placeholder; app.js fetches the region from
// GET /a/:alias/:page/region/:id once the page shows. Without JavaScript
// the placeholder is a link that renders the page with the region (r<id>_load=1).

/** Region types that can be cached or loaded lazily (no form state of their own). */
export const DEFERRABLE = new Set<Region['type']>(['report', 'chart', 'cards', 'dynamic', 'tree', 'template_component']);

export interface CacheSetting {
  scope: 'user' | 'session' | 'all';
  seconds: number;
}

/** The region's cache setting, or null (no cache, or not a cacheable type). Durations are 1 s to 1 day. */
export function cacheOf(r: Region): CacheSetting | null {
  const c = r.config?.cache;
  if (!c || typeof c !== 'object' || !DEFERRABLE.has(r.type)) return null;
  const seconds = Math.floor(Number(c.seconds));
  if (!['user', 'session', 'all'].includes(c.scope) || !Number.isFinite(seconds) || seconds < 1) return null;
  return { scope: c.scope, seconds: Math.min(seconds, 86_400) };
}

/** Whether the region is loaded after the page shows. */
export const lazyOf = (r: Region) => r.config?.lazy === true && DEFERRABLE.has(r.type);

const MAX_ENTRIES = Math.max(0, Number(process.env.REGION_CACHE_MAX_ENTRIES ?? 1000) || 0);
const MAX_BYTES = Math.max(0, Number(process.env.REGION_CACHE_MAX_MB ?? 64) || 0) * 1024 * 1024;
/** One region larger than this is not cached. */
const ENTRY_MAX_BYTES = Math.min(2 * 1024 * 1024, MAX_BYTES);
const CSRF_MARK = '\u0000csrf\u0000';

interface Entry {
  appId: number;
  pageNo: number;
  expires: number;
  body: string;
  css: [string, string][];
  detached: string[];
  bytes: number;
}

const store = new Map<string, Entry>();
let bytes = 0;

function drop(key: string) {
  const e = store.get(key);
  if (!e) return;
  store.delete(key);
  bytes -= e.bytes;
}

/** The cache key of a region for this request (a SHA-256 over everything its HTML depends on). */
export function cacheKey(ctx: PageContext, r: Region, setting: CacheSetting) {
  const binds = bindValues(ctx);
  const text = `${r.source ?? ''}\n${r.title ?? ''}\n${JSON.stringify(r.config)}`.toUpperCase();
  const used = Object.keys(binds)
    .filter((k) => text.includes(k.toUpperCase()))
    .sort()
    .map((k) => [k, binds[k] ?? null]);
  const own = ctx.page.items.filter((i) => i.region_id === r.id).map((i) => [i.name, ctx.session.state[i.name] ?? null]);
  const params = [...ctx.params].filter(([k]) => !/^r\d+_load$/.test(k)).sort(([a, x], [b, y]) => (a + '\u0000' + x < b + '\u0000' + y ? -1 : 1));
  const who =
    setting.scope === 'session' ? ['session', ctx.session.id, ctx.user]
    : setting.scope === 'user' ? ['user', ctx.user]
    : ['all', ctx.user === 'nobody'];
  const parts = [
    ctx.app.id, ctx.page.page_no, r, ctx.locale.lang, ctx.locale.timeZone, ctx.dialog, who, [...ctx.roles].sort(),
    [...(ctx.vis?.regions ?? [])].sort((a, b) => a - b), params, used, own,
  ];
  return `${ctx.app.id}:${ctx.page.page_no}:${r.id}:${createHash('sha256').update(JSON.stringify(parts)).digest('base64url')}`;
}

/** A cached region for this request: its body, with its styles and detached forms added to the page. */
export function useCached(ctx: PageContext, key: string): Raw | null {
  const e = store.get(key);
  if (!e) return null;
  if (e.expires <= Date.now()) {
    drop(key);
    return null;
  }
  // most recently used last (the oldest is dropped first)
  store.delete(key);
  store.set(key, e);
  const fill = (s: string) => s.split(CSRF_MARK).join(ctx.session.csrf_token);
  ctx.css.addAll(e.css);
  for (const d of e.detached) ctx.detached.push(raw(fill(d)));
  return raw(fill(e.body));
}

/**
 * Render a region's body, keeping it in the cache when that is safe: no
 * errors, not too large, and (for all users) no per-user links.
 */
export async function renderCaching(ctx: PageContext, r: Region, setting: CacheSetting, key: string, render: () => Promise<Raw>): Promise<Raw> {
  const outerCss = ctx.css;
  const css = new PageCss();
  const detachedFrom = ctx.detached.length;
  const errorsBefore = ctx.errors.page.length;
  const userBound = ctx.userBound;
  ctx.css = css;
  ctx.userBound = false;
  let body: Raw;
  try {
    body = await render();
  } finally {
    ctx.css = outerCss;
  }
  outerCss.addAll(css.entries());
  const perUser = ctx.userBound;
  ctx.userBound = userBound || perUser;
  const text = body.toString();
  const detached = ctx.detached.slice(detachedFrom).map(String);
  const failed = ctx.errors.page.length > errorsBefore || text.includes('alert-error');
  if (!MAX_ENTRIES || failed || (setting.scope === 'all' && perUser)) return body;
  const token = ctx.session.csrf_token;
  const hide = (s: string) => (token ? s.split(token).join(CSRF_MARK) : s);
  const entry: Entry = {
    appId: ctx.app.id, pageNo: ctx.page.page_no, expires: Date.now() + setting.seconds * 1000,
    body: hide(text), css: css.entries(), detached: detached.map(hide), bytes: 0,
  };
  entry.bytes = 2 * (entry.body.length + entry.detached.reduce((n, d) => n + d.length, 0) + entry.css.reduce((n, [a, b]) => n + a.length + b.length, 0)) + key.length + 200;
  if (entry.bytes > ENTRY_MAX_BYTES) return body;
  drop(key);
  store.set(key, entry);
  bytes += entry.bytes;
  for (const k of store.keys()) {
    if (store.size <= MAX_ENTRIES && bytes <= MAX_BYTES) break;
    drop(k);
  }
  return body;
}

/** Drop the cached regions of a page (after a submit of it). */
export function invalidatePage(appId: number, pageNo: number) {
  for (const [k, e] of store) if (e.appId === appId && e.pageNo === pageNo) drop(k);
}

/** Drop every cached region (tests). */
export function clearRegionCache() {
  store.clear();
  bytes = 0;
}

/** Entries and bytes in the cache (tests, diagnostics). */
export const regionCacheStats = () => ({ entries: store.size, bytes });
