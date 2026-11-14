// (sprint 193, NX-F3) Page aliases: /a/<app>/<alias> opens a page as /a/<app>/<number> does (APEX: Page Alias).
//
// The rules are the database's too (migration 170: meta.page_alias_check, meta.page_alias_reserved,
// meta.page_alias_free); test/page-alias.test.ts keeps the two lists equal and checks that every path
// segment the runtime registers under /a/:alias/ is reserved here.

/** Path segments of /a/<app>/… the runtime uses itself (routes.ts and friends): never a page alias. */
export const RESERVED_PAGE_ALIASES: readonly string[] = [
  'account', 'autorest', 'login', 'logout', 'notifications', 'offline', 'password', 'push',
  'reports', 'rest', 'session', 'sso', 'static', 'tasks', 'telemetry', 'tz', 'workflows',
  'workspace-files',
];

export const PAGE_ALIAS_MAX = 64;
const SHAPE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export type AliasProblem = 'length' | 'format' | 'numeric' | 'reserved';

/** Why an alias can't be used (uniqueness is the database's), or null. */
export function pageAliasProblem(alias: string): AliasProblem | null {
  if (!alias || alias.length > PAGE_ALIAS_MAX) return 'length';
  if (!SHAPE.test(alias)) return 'format';
  if (/^[0-9]+$/.test(alias)) return 'numeric';
  if (RESERVED_PAGE_ALIASES.includes(alias)) return 'reserved';
  return null;
}

/** The alias a page name suggests, as meta.page_alias_slug does (lower case, accents dropped, hyphens). */
export function aliasFromName(name: string): string {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * The page number a URL's page segment names: a number, or the alias of one of the application's pages
 * (only its own: `pages` is the application's list). Anything else is undefined (404).
 */
export function pageOfSegment(segment: string, pages: readonly { page_no: number; alias?: string | null }[]): number | undefined {
  if (/^[0-9]{1,9}$/.test(segment)) return Number(segment);
  if (segment.length > PAGE_ALIAS_MAX || !SHAPE.test(segment)) return undefined;
  return pages.find((p) => p.alias === segment)?.page_no;
}
