// (sprint 234, AX-12; APEX: the page template's Slot list) The display positions of a page, in APEX's order, and
// which of them a page template renders. Used by the runtime (render.ts), the Page Designer's layout and rendering
// tree (designer.ts) and the Advisor.

/** Every display position, in the order of APEX's Slot list (left and right are the side columns of 099). */
export const PAGE_POSITIONS = [
  'banner', 'after_logo', 'before_navigation_bar', 'after_navigation_bar', 'top_navigation', 'breadcrumb',
  'full_width', 'left', 'body', 'right', 'footer', 'dialogs',
] as const;
export type PagePosition = (typeof PAGE_POSITIONS)[number];

/** The positions in the application's header (and the bar under it): only a page template with a header has them. */
export const HEADER_POSITIONS: readonly string[] = ['after_logo', 'before_navigation_bar', 'after_navigation_bar', 'top_navigation'];

/** The page templates with the application's header and navigation (minimal has neither; a modal page is a dialog). */
const HEADER_TEMPLATES = new Set(['standard', 'left_side_column', 'right_side_column']);

/** The side column a page template has: left, right or none. */
export const sideOf = (template: string | null | undefined) =>
  template === 'left_side_column' ? 'left' : template === 'right_side_column' ? 'right' : null;

/**
 * Whether a page has a display position: the header positions need a page template with a header and a page that is
 * not modal; left and right only the side-column template of that side (elsewhere their regions show in the body);
 * every other position every page. The Global Page (page 0) has them all: its regions are part of every page.
 */
export function pageHasPosition(page: { page_no?: number | null; page_template?: string | null; mode?: string | null }, pos: string): boolean {
  if (Number(page.page_no) === 0) return true;
  if (HEADER_POSITIONS.includes(pos)) return HEADER_TEMPLATES.has(page.page_template ?? 'standard') && page.mode !== 'modal';
  if (pos === 'left' || pos === 'right') return sideOf(page.page_template) === pos;
  return (PAGE_POSITIONS as readonly string[]).includes(pos);
}

/** A region at a position its page doesn't have: left and right show in the body; the header positions not at all. */
export const positionDropped = (page: Parameters<typeof pageHasPosition>[0], pos: string) =>
  HEADER_POSITIONS.includes(pos) && !pageHasPosition(page, pos);
