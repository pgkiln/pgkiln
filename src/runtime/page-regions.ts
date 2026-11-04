// (140) Two region types about the page itself: breadcrumb (APEX: Breadcrumb) shows the page's
// breadcrumb trail, the pages above it by "Breadcrumb parent" (else Home), and help_text (APEX: Help
// Text) shows the page's help text. The page's title bar shows the trail too, unless the page has a
// breadcrumb region of its own.

import { html, raw, type Raw } from '../html.ts';
import type { Region } from '../metadata.ts';
import { markdownHtml } from '../richtext.ts';
import { pageAllowed } from './authz.ts';
import { substitute, type PageContext } from './context.ts';
import { expandShortcuts } from './shortcuts.ts';

/** The pages above the current one (at most six), as links the user may follow. */
export async function breadcrumbLinks(ctx: PageContext): Promise<Raw[]> {
  const trail: { page_no: number; name: string }[] = [];
  let p = ctx.app.pages.find((x) => x.page_no === ctx.page.parent_page);
  for (let guard = 0; p && guard < 6; guard++) {
    trail.unshift(p);
    p = ctx.app.pages.find((x) => x.page_no === p!.parent_page);
  }
  if (!trail.length && ctx.page.page_no !== ctx.app.home_page) {
    const home = ctx.app.pages.find((x) => x.page_no === ctx.app.home_page);
    if (home) trail.push(home);
  }
  const links = [];
  for (const t of trail) if (await pageAllowed(ctx, t.page_no)) links.push(html`<li><a href="${ctx.base}/${t.page_no}">${t.name}</a></li>`);
  return links;
}

/** Whether the page shows a breadcrumb region (then its title bar leaves the trail out). */
export const hasBreadcrumbRegion = (ctx: PageContext) => ctx.page.regions.some((r) => r.type === 'breadcrumb' && ctx.vis?.regions.has(r.id));

/** A breadcrumb region: the trail and ({"current": false} leaves it out) the current page. */
export async function renderBreadcrumbRegion(ctx: PageContext, r: Region): Promise<Raw> {
  const links = await breadcrumbLinks(ctx);
  const title = substitute(ctx.page.title ?? ctx.page.name, ctx, (v) => v);
  const current = r.config?.current === false ? '' : html`<li><span aria-current="page">${title}</span></li>`;
  return html`<nav class="region-crumbs" aria-label="${r.title || ctx.locale.t('region.breadcrumb')}"><ol class="crumbs">${links}${current}</ol></nav>`;
}

/** Markdown's punctuation, escaped in item values put into a help text (they stay text). */
const mdEscape = (v: string) => v.replace(/[\\`*_{}[\]()#+\-.!~>|]/g, '\\$&');

/** A help text region: the page's help text (Markdown with &ITEM. substitutions), else {"empty": "…"} or "No help…". */
export async function renderHelpTextRegion(ctx: PageContext, r: Region): Promise<Raw> {
  const help = ctx.page.help?.trim();
  if (!help) return html`<p class="muted help-text-none">${typeof r.config?.empty === 'string' ? r.config.empty : ctx.locale.t('region.no_help')}</p>`;
  const text = substitute(await expandShortcuts(ctx, help, 'text'), ctx, mdEscape);
  return html`<div class="help-text rich-text">${raw(markdownHtml(text))}</div>`;
}
