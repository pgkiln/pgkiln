import { runtime } from './db.ts';

// (sprint 188, NX-S4; migration 168) Browser security per application (APEX: Security Attributes → Browser Security):
// frame embedding, the referrer policy, search engines and extra response headers, for the responses of /a/<alias>/.
// meta.app.browser_security holds the choices; check() is the form's and the import's check, headersFor() what
// src/security.ts sends. Pages keep Cache-Control: no-store: they carry the session's CSRF token.

export type Embed = 'same_origin' | 'deny' | 'origins';
export type Referrer = 'same-origin' | 'strict-origin-when-cross-origin' | 'strict-origin' | 'no-referrer';
export type Robots = 'auto' | 'index' | 'noindex';

export interface BrowserSecurity {
  embed: Embed;
  embed_origins: string[];
  referrer: Referrer;
  robots: Robots;
  headers: { name: string; value: string }[];
}

export const EMBEDS: Embed[] = ['same_origin', 'deny', 'origins'];
export const REFERRERS: Referrer[] = ['same-origin', 'strict-origin-when-cross-origin', 'strict-origin', 'no-referrer'];
export const ROBOTS: Robots[] = ['auto', 'index', 'noindex'];
export const MAX_ORIGINS = 10;
export const MAX_HEADERS = 20;

/** Headers pgkiln sets for security or for the protocol: an application can't set or weaken them. */
export const RESERVED_HEADERS = new Set([
  'content-security-policy', 'content-security-policy-report-only', 'x-content-type-options', 'x-frame-options', 'referrer-policy',
  'permissions-policy', 'strict-transport-security', 'cache-control', 'pragma', 'expires', 'set-cookie', 'x-robots-tag',
  'content-type', 'content-length', 'content-encoding', 'content-disposition', 'transfer-encoding', 'connection', 'location',
  'host', 'vary', 'access-control-allow-origin', 'access-control-allow-credentials', 'access-control-allow-headers',
  'access-control-allow-methods', 'cross-origin-opener-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy',
  'etag', 'last-modified', 'www-authenticate', 'server', 'date', 'upgrade', 'keep-alive', 'trailer', 'te', 'proxy-authenticate',
]);

const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,62}$/;
/** An https origin: scheme, host and an optional port; no path, query, user or wildcard. */
const ORIGIN = /^https:\/\/[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+(:[0-9]{1,5})?$/;

export const DEFAULTS: BrowserSecurity = { embed: 'same_origin', embed_origins: [], referrer: 'same-origin', robots: 'auto', headers: [] };

/** The stored object as settings, every unknown or bad value replaced by its default (what the server sends). */
export function settingsOf(v: unknown): BrowserSecurity {
  const o = (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  const pick = <T extends string>(x: unknown, list: T[], d: T) => (list.includes(x as T) ? (x as T) : d);
  const origins = Array.isArray(o.embed_origins) ? o.embed_origins.filter((x): x is string => typeof x === 'string' && ORIGIN.test(x)).slice(0, MAX_ORIGINS) : [];
  const headers = Array.isArray(o.headers)
    ? o.headers.filter((h): h is { name: string; value: string } => !!h && typeof h === 'object' && headerProblem((h as any).name, (h as any).value) === null)
      .slice(0, MAX_HEADERS).map((h) => ({ name: h.name, value: h.value }))
    : [];
  const embed = pick(o.embed, EMBEDS, 'same_origin');
  return { embed: embed === 'origins' && !origins.length ? 'same_origin' : embed, embed_origins: origins, referrer: pick(o.referrer, REFERRERS, 'same-origin'), robots: pick(o.robots, ROBOTS, 'auto'), headers };
}

/** Why a header can't be sent (null: it can). */
export function headerProblem(name: unknown, value: unknown): string | null {
  if (typeof name !== 'string' || !HEADER_NAME.test(name)) return `"${String(name).slice(0, 40)}" is not a header name (letters, digits and -, starting with a letter).`;
  if (RESERVED_HEADERS.has(name.toLowerCase())) return `${name} is set by pgkiln for security or by the protocol: it can't be changed per application.`;
  if (typeof value !== 'string' || value.length > 1000) return `The value of ${name} is not a text of at most 1000 characters.`;
  if (/[\r\n\0]/.test(value)) return `The value of ${name} may not contain line breaks.`;
  return null;
}

/** The form's values checked: the settings to store, or the problems (nothing is stored then). */
export function check(input: { embed?: unknown; embed_origins?: unknown; referrer?: unknown; robots?: unknown; headers?: unknown }): { settings: BrowserSecurity; problems: string[] } {
  const problems: string[] = [];
  const embed = String(input.embed ?? 'same_origin');
  if (!EMBEDS.includes(embed as Embed)) problems.push('Choose how the application may be embedded.');
  const originsText = Array.isArray(input.embed_origins) ? input.embed_origins.join('\n') : String(input.embed_origins ?? '');
  const origins = originsText.split(/[\s,]+/).map((x) => x.trim().toLowerCase().replace(/\/+$/, '')).filter(Boolean);
  for (const o of origins) if (!ORIGIN.test(o)) problems.push(`${o.slice(0, 100)} is not an https origin (https://host or https://host:port, no path).`);
  if (origins.length > MAX_ORIGINS) problems.push(`At most ${MAX_ORIGINS} origins.`);
  if (embed === 'origins' && !origins.length) problems.push('Name the origins that may embed the application.');
  const referrer = String(input.referrer ?? 'same-origin');
  if (!REFERRERS.includes(referrer as Referrer)) problems.push('Choose a referrer policy.');
  const robots = String(input.robots ?? 'auto');
  if (!ROBOTS.includes(robots as Robots)) problems.push('Choose what search engines may do.');
  const headers: { name: string; value: string }[] = [];
  const raw = Array.isArray(input.headers)
    ? input.headers
    : String(input.headers ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
        const i = l.indexOf(':');
        return i < 0 ? { name: l, value: '' } : { name: l.slice(0, i).trim(), value: l.slice(i + 1).trim() };
      });
  const seen = new Set<string>();
  for (const h of raw as { name?: unknown; value?: unknown }[]) {
    const p = headerProblem(h?.name, h?.value);
    if (p) problems.push(p);
    else if (seen.has(String(h.name).toLowerCase())) problems.push(`${h.name} is listed twice.`);
    else {
      seen.add(String(h.name).toLowerCase());
      headers.push({ name: String(h.name), value: String(h.value) });
    }
  }
  if (headers.length > MAX_HEADERS) problems.push(`At most ${MAX_HEADERS} headers.`);
  return { settings: { embed: embed as Embed, embed_origins: [...new Set(origins)], referrer: referrer as Referrer, robots: robots as Robots, headers }, problems };
}

/** What the responses of an application send: frame-ancestors for the CSP, and the headers (name → value). */
export function headersFor(s: BrowserSecurity, signIn: boolean): { frameAncestors: string; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  for (const h of s.headers) headers[h.name] = h.value;
  headers['Referrer-Policy'] = s.referrer;
  let frameAncestors = "'self'";
  if (s.embed === 'deny') {
    frameAncestors = "'none'";
    headers['X-Frame-Options'] = 'DENY';
  } else if (s.embed === 'origins') {
    // X-Frame-Options can't list origins: browsers that know frame-ancestors use it; the header is left out
    frameAncestors = `'self' ${s.embed_origins.join(' ')}`;
  } else headers['X-Frame-Options'] = 'SAMEORIGIN';
  if (s.robots === 'noindex' || (s.robots === 'auto' && signIn)) headers['X-Robots-Tag'] = 'noindex, nofollow';
  return { frameAncestors, headers };
}

const TTL_MS = Number(process.env.PGKILN_APP_CACHE_MS ?? 5000);
const cache = new Map<string, { at: number; v: { settings: BrowserSecurity; signIn: boolean } | null }>();

/** An application's browser security by alias (a few seconds cached; null: no such application). */
export async function browserSecurityOf(alias: string): Promise<{ settings: BrowserSecurity; signIn: boolean } | null> {
  const hit = cache.get(alias);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v;
  const row = await runtime.one<{ browser_security: unknown; authentication: string }>(
    'select browser_security, authentication from meta.app where alias = $1', [alias]).catch(() => undefined);
  const v = row ? { settings: settingsOf(row.browser_security), signIn: row.authentication !== 'none' } : null;
  if (cache.size > 1000) cache.clear();
  cache.set(alias, { at: Date.now(), v });
  return v;
}

/** Forget the cache (after Settings saved, and in tests). */
export const browserSecurityChanged = () => cache.clear();
