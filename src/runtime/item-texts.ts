// (sprint 241, MG-10, MG-11) An item's label and placeholder as the page shows them.
//
// Labels take &ITEM. substitutions, as region texts and help do: a form whose labels come from
// settings an administrator keeps (&P5_LABEL_PHONE.) needs no static region per field. The values
// are put in unescaped here; the html`` template that shows the label escapes the whole text.
//
// The placeholder (meta.item.placeholder, migration 197; APEX: Value Placeholder) is the hint in an empty
// field, or the text of a select list's empty choice. Also &ITEM. substitutions, escaped the same way.

import type { Item } from '../metadata.ts';
import { substitute, type PageContext } from './context.ts';

/** A name as a heading (P1_FIRST_NAME → "P1 First Name"): the label of an item without one (items.ts exports it too). */
export const heading = (name: string) =>
  name.replace(/_/g, ' ').replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());

const subst = (ctx: PageContext, text: string) => (text.includes('&') || text.includes('#') ? substitute(text, ctx, (v) => v) : text);

/** The label shown (not escaped): its own (translated already) with &ITEM. substitutions, else from the name. */
export const itemLabel = (ctx: PageContext, item: Pick<Item, 'label' | 'name'>) =>
  item.label != null ? subst(ctx, item.label) : ctx.locale.tr(heading(item.name));

/** The field types that show a placeholder in an empty field. */
export const PLACEHOLDER_TYPES = new Set(['text', 'number', 'email', 'tel', 'url', 'password', 'textarea', 'date', 'combobox', 'autocomplete', 'location', 'plugin']);
/** The list types whose empty choice reads the placeholder. */
export const NULL_CHOICE_TYPES = new Set(['select', 'popup_lov', 'select_one']);

/** The placeholder (not escaped; null: none). An item's {"placeholder": …} setting is read too, as before 197. */
export function itemPlaceholder(ctx: PageContext, item: Pick<Item, 'config'> & { placeholder?: string | null }): string | null {
  const p = item.placeholder ?? (typeof item.config?.placeholder === 'string' ? item.config.placeholder : null);
  return p?.trim() ? subst(ctx, p).slice(0, 500) : null;
}
