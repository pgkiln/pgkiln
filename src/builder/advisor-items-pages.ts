// (sprint 241, MG-10, MG-13, MG-15) Advisor checks of item placeholders, the page template No navigation and
// meta.set_auth_user. Called from advisor.ts structureFindings (metadata only: no SQL is run).

import type { AppRows, Finding } from './advisor.ts';
import { NULL_CHOICE_TYPES, PLACEHOLDER_TYPES } from '../runtime/item-texts.ts';

/** meta.set_auth_user named in SQL (not in a comment's words only: good enough for a hint) */
const SET_AUTH_USER = /\bmeta\s*\.\s*set_auth_user\s*\(/i;

export function itemPageFindings(x: AppRows): Finding[] {
  const out: Finding[] = [];
  const entryOf = (kind: string, id: number) => x.byKey.get(`${kind}-${id}`) ?? null;
  for (const { kind, row } of x.all) {
    if ((row.build_option ?? '') === 'COMMENTED_OUT') continue;
    // a placeholder the item's type never shows
    if (kind === 'item' && typeof row.placeholder === 'string' && row.placeholder.trim()) {
      const type = row.type === 'autocomplete' ? 'combobox' : row.type;
      if (!PLACEHOLDER_TYPES.has(type) && !NULL_CHOICE_TYPES.has(type))
        out.push({ severity: 'info', entry: entryOf(kind, row.id), field: 'Value placeholder',
          message: `A ${row.type} item shows no placeholder: it is used by text, number, e-mail, telephone, URL, password, textarea, date, combobox and location items, and as the empty choice of select lists.` });
      else if (NULL_CHOICE_TYPES.has(type) && row.config?.null_label === false)
        out.push({ severity: 'info', entry: entryOf(kind, row.id), field: 'Value placeholder',
          message: 'The list has no empty choice ({"null_label": false}), so its placeholder is never shown.' });
    }
    // meta.set_auth_user outside custom authentication's post-authentication code always fails
    for (const [name, value] of Object.entries(row)) {
      if (typeof value !== 'string' || !SET_AUTH_USER.test(value)) continue;
      out.push({ severity: 'error', entry: entryOf(kind, row.id), field: name,
        message: 'meta.set_auth_user works only in the post-authentication code of a custom authentication scheme (Application settings → Security), while a user signs in: here it raises an error.' });
      break;
    }
  }
  const app = x.app ?? {};
  if (typeof app.custom_auth_post_code === 'string' && SET_AUTH_USER.test(app.custom_auth_post_code) && app.authentication !== 'custom')
    out.push({ severity: 'warning', entry: null, field: 'Authentication → Post-authentication',
      message: 'The post-authentication code calls meta.set_auth_user, but the application doesn\'t use custom authentication, so the code never runs.' });
  // No navigation on a modal page: a dialog never shows the page's header or menu
  for (const p of x.pages)
    if (p.page_template === 'no_navigation' && p.mode === 'modal')
      out.push({ severity: 'info', entry: null, field: `Page ${p.page_no} → Page template`,
        message: 'A modal dialog shows no header, navigation menu or title bar anyway: the template No navigation changes nothing here.' });
  return out;
}
