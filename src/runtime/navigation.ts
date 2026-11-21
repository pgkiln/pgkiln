// (sprint 249, MG-22) Where the user came from, and branches whose target page is an item's value.
//
// Each page the user views (not in a dialog, not a download, not the service worker's prefetch) is noted in the
// session: the page and the URL it was opened with (its report page, sort, signed items). The page before the
// current one is the built-in &APP_PREVIOUS_PAGE. (:APP_PREVIOUS_PAGE), and its URL &APP_PREVIOUS_URL.; inside a
// modal dialog it is the page below. A page viewed again (a submit that comes back, another report page) keeps
// the page it came from. APEX has no such built-in.
//
// A branch of target type "item" reads its target page from an item (meta.branch.target_item, migration 205): a
// page number or alias of this application. It must be a page the user may open (authorization, sign-in), else
// the branch goes to the page itself. When it is the previous page and the branch sets no items, the browser goes
// back to that page as it was opened (APP_PREVIOUS_URL), so a list keeps its search, page and selection.

import type { Branch, PageSummary } from '../metadata.ts';
import { pageAllowed } from './authz.ts';
import { dbg, LAST_PAGE, LAST_URL, PREV_PAGE, PREV_URL, previousPage, type PageContext } from './context.ts';

/** Query parameters a noted URL leaves out: one-shot actions, not the state of the page. */
const ONE_SHOT = /^(dialog|clear|doc|r\d+_(csv|xlsx|pdf))$/;

/** Note a page view (show page, after the page is rendered): this page becomes the last one. */
export function notePageView(ctx: PageContext) {
  if (ctx.dialog || ctx.page.page_no === 0) return;
  const params = new URLSearchParams();
  for (const [k, v] of ctx.params) if (!ONE_SHOT.test(k)) params.append(k, v);
  const q = params.toString();
  const url = `${ctx.base}/${ctx.page.page_no}${q ? `?${q}` : ''}`;
  const state = ctx.session.state;
  const page = String(ctx.page.page_no);
  if (state[LAST_PAGE] !== page) {
    if (state[LAST_PAGE]) {
      state[PREV_PAGE] = state[LAST_PAGE];
      state[PREV_URL] = state[LAST_URL] ?? null;
    }
    state[LAST_PAGE] = page;
  }
  state[LAST_URL] = url.length <= 2000 ? url : `${ctx.base}/${page}`;
}

/** A page of the application by number or alias (not the global page 0). */
function findPage(ctx: PageContext, value: string): PageSummary | undefined {
  if (/^\d{1,9}$/.test(value)) return ctx.app.pages.find((p) => p.page_no === Number(value) && p.page_no !== 0);
  const alias = value.toLowerCase();
  return ctx.app.pages.find((p) => p.alias && p.alias.toLowerCase() === alias && p.page_no !== 0);
}

/**
 * An item branch's target: the page its item names, checked; else this page. `url`: go back to the previous
 * page as it was opened (the branch sets no items and the item names that page).
 */
export async function itemTarget(ctx: PageContext, b: Branch, values: Record<string, string | null | undefined>): Promise<{ page: number; url?: string }> {
  const name = (b.target_item ?? '').toUpperCase();
  const value = (values[name] ?? '').trim();
  const page = value ? findPage(ctx, value) : undefined;
  if (!page || !(await pageAllowed(ctx, page.page_no))) {
    dbg(ctx, 4, 'branch', `branch "${b.name}": ${name} = ${JSON.stringify(value.slice(0, 50))} is not a page this user may open: this page instead`);
    return { page: ctx.page.page_no };
  }
  const prev = previousPage(ctx.session.state, ctx.page.page_no);
  const noItems = !Object.keys(b.target_items ?? {}).length;
  const prefix = `${ctx.base}/${page.page_no}`;
  if (noItems && prev.page === String(page.page_no) && prev.url && (prev.url === prefix || prev.url.startsWith(`${prefix}?`)))
    return { page: page.page_no, url: prev.url };
  return { page: page.page_no };
}
