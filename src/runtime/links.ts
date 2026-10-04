import { html, raw } from '../html.ts';
import { urlChecksum } from '../security.ts';
import { substitute, type PageContext } from './context.ts';

/**
 * URL of an application page. Item values get a checksum (see
 * security.ts) so pages with protection = 'checksum' can trust them.
 */
export function pageHref(ctx: PageContext, pageNo: number, items: Record<string, string> = {}, clear = false) {
  const values = Object.fromEntries(Object.entries(items).map(([k, v]) => [k.toUpperCase(), substitute(v, ctx, (x) => x)]));
  const params = new URLSearchParams();
  if (clear) params.set('clear', '1');
  for (const k of Object.keys(values).sort()) params.set(k, values[k]);
  if (Object.keys(values).length) params.set('cs', urlChecksum(ctx.app.id, pageNo, ctx.user, values));
  const q = params.toString();
  return `${ctx.base}/${pageNo}${q ? `?${q}` : ''}`;
}

export const isModal = (ctx: PageContext, pageNo: number) => ctx.app.pages.find((p) => p.page_no === pageNo)?.mode === 'modal';

/** href attribute (plus data-dialog for modal targets) for a link to a page. */
export function linkAttrs(ctx: PageContext, pageNo: number, items: Record<string, string> = {}, clear = false) {
  return html`href="${pageHref(ctx, pageNo, items, clear)}"${isModal(ctx, pageNo) ? raw(' data-dialog') : ''}`;
}

/**
 * Link item values with #column# replaced by a row's values (`value` returns
 * undefined for an unknown column, which stays as written).
 */
export function fillItems(items: Record<string, string> | undefined, value: (column: string) => string | undefined) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(items ?? {})) out[k] = v.replace(/#([A-Za-z0-9_$]+)#/g, (m, col: string) => value(col) ?? m);
  return out;
}

/** The columns a link's item values refer to (#column#), lower case. */
export const linkColumns = (items: Record<string, string> | undefined) =>
  [...new Set(Object.values(items ?? {}).flatMap((v) => [...v.matchAll(/#([A-Za-z0-9_$]+)#/g)].map((m) => m[1].toLowerCase())))];
