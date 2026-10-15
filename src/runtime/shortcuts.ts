import { esc } from '../html.ts';
import { publicError, type PageContext } from './context.ts';
import { computeValue } from './logic.ts';

// Shortcuts (migration 103; APEX: Shared Components → Shortcuts). "NAME" (an
// upper-case name in double quotes) in a static region's content, an item's
// help text and a button's or menu entry's confirm message is replaced by the
// application's shortcut of that name, before &ITEM. substitutions. Other
// quoted words (class="NAV" with no shortcut NAV) stay as they are.
//
//   text           the value; escaped where it goes into HTML
//   html           the value as HTML
//   function_body  PL/pgSQL returning the text (HTML), run once per request
//                  as the application's role

const NAME = /"([A-Z][A-Z0-9_]{0,59})"/g;

/** A shortcut's text (html: as it goes into HTML), computed once per request; null: no such shortcut. */
async function valueOf(ctx: PageContext, name: string, asHtml: boolean): Promise<string | null> {
  const s = ctx.app.shortcuts?.find((x) => x.name === name);
  if (!s) return null;
  if (s.type === 'text') return asHtml ? esc(s.value) : s.value;
  if (s.type === 'html') return s.value;
  const cache = (ctx.shortcutValues ??= new Map());
  if (!cache.has(name)) {
    try {
      cache.set(name, (await computeValue(ctx, { type: 'function_body', expression: s.value })) ?? '');
    } catch (e) {
      ctx.errors.page.push(await publicError(ctx, e, `shortcut "${name}"`));
      cache.set(name, '');
    }
  }
  return cache.get(name)!;
}

/** The text with its "NAME" shortcuts replaced (as HTML or as plain text). */
export async function expandShortcuts(ctx: PageContext, text: string, as: 'html' | 'text'): Promise<string> {
  if (!ctx.app.shortcuts?.length || !text.includes('"')) return text;
  const names = new Set([...text.matchAll(NAME)].map((m) => m[1]));
  const values = new Map<string, string | null>();
  for (const n of names) values.set(n, await valueOf(ctx, n, as === 'html'));
  return text.replace(NAME, (m, n: string) => values.get(n) ?? m);
}
