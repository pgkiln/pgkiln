// (sprint 238, MG-14) Inline dialog regions (templates inline_dialog and inline_drawer) opened by their static id:
//
// - a link to #<static id> (static content, list entries) opens it in app.js; a redirect button with target_region
//   links to #R<id> on its own page (the CSS :target shows it without JavaScript), or to its target page with
//   #<static id>
// - a submit process or branch with open_region: the page that comes back opens it (one-time session value
//   __OPEN_REGION, taken by the next page view, as the success message)
// - a submit that fails (validation, process error) from a button inside an inline dialog, or with an error on an item or
//   grid inside one, shows the page again with that dialog open
//
// An open dialog is rendered with the attribute open (shown without JavaScript) and data-open-region: app.js shows it
// as a modal dialog.

import type { Region } from '../metadata.ts';
import type { PageContext } from './context.ts';

export const STATIC_ID = /^[a-z][a-z0-9_-]{0,49}$/;
/** A link's #<static id> (a list entry's URL) */
export const STATIC_HASH = /^#[a-z][a-z0-9_-]{0,49}$/;

export const isInlineOverlay = (r: Region) => r.template === 'inline_dialog' || r.template === 'inline_drawer';

/** The inline dialog or drawer region of this page with this static id, or undefined. */
export function overlayByStaticId(ctx: PageContext, staticId: string | null | undefined): Region | undefined {
  if (!staticId || !STATIC_ID.test(staticId)) return undefined;
  return ctx.page.regions.find((r) => r.static_id === staticId && isInlineOverlay(r));
}

/** The region and the regions it sits in (sub regions nest one level deep). */
function withParents(ctx: PageContext, id: number | null | undefined): Region[] {
  const out: Region[] = [];
  let r = id == null ? undefined : ctx.page.regions.find((x) => x.id === id);
  while (r && out.length < 5 && !out.includes(r)) {
    out.push(r);
    r = r.parent_id == null ? undefined : ctx.page.regions.find((x) => x.id === r!.parent_id);
  }
  return out;
}

function open(ctx: PageContext, r: Region | undefined) {
  if (r) (ctx.openRegions ??= new Set()).add(r.id);
}

/** Opens the inline dialog region with this static id when this page has one (a process's or branch's open_region). */
export function openByStaticId(ctx: PageContext, staticId: unknown) {
  if (typeof staticId === 'string') open(ctx, overlayByStaticId(ctx, staticId));
}

/**
 * A submit failed: the inline dialog the pressed button sits in, and those holding an item or grid with an error,
 * come back open (the error inside them is where the user was).
 */
export function openAfterError(ctx: PageContext, request: unknown) {
  const regionIds: (number | null | undefined)[] = [];
  if (typeof request === 'string' && request) regionIds.push(ctx.page.buttons.find((b) => b.name === request)?.region_id);
  for (const name of Object.keys(ctx.errors.items)) regionIds.push(ctx.page.items.find((i) => i.name === name)?.region_id);
  for (const key of Object.keys(ctx.gridErrors ?? {})) {
    const m = /^g(\d+)_/.exec(key);
    if (m) regionIds.push(Number(m[1]));
  }
  for (const id of regionIds) for (const r of withParents(ctx, id)) if (isInlineOverlay(r)) open(ctx, r);
}

/**
 * (button target_region) The href that opens an inline dialog: #R<id> when it is on this page (CSS :target without
 * JavaScript), else #<static id> (app.js finds it by its data-static-id, also on another page after the link).
 */
export function overlayHash(ctx: PageContext, staticId: string): string {
  const r = overlayByStaticId(ctx, staticId);
  return r ? `#R${r.id}` : `#${staticId}`;
}
