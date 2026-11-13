import { html, type Raw } from '../html.ts';
import type { Session } from '../session.ts';
import { isAdmin } from './locks.ts';
import { ownerChosen, REASON_MAX } from './owner-connection.ts';
import { tr } from './i18n.ts';
import { BASE, csrf } from './ui.ts';

// (sprint 186) Since sprint 185 the SQL Workshop runs as the workspace's developer login. It doesn't own the tables
// the owner made, so row level security (or a missing grant) refuses its inserts, updates and deletes with
// PostgreSQL's own message. The tools (SQL Commands, SQL Scripts, Sample Data, Load Data) show this hint after that
// message: why it happens and what to do. Administrators get the Owner connection one click (and a reason) away.

/** PostgreSQL's messages for a refusal by row level security or by the object's privileges (SQLSTATE 42501). */
export const RLS_REFUSAL = /row-level security policy|permission denied for (?:table|relation|view|materialized view|sequence|schema|function)\b/i;

/** Whether one of the texts is such a refusal. */
export const isRlsRefusal = (texts: (string | null | undefined)[]) => texts.some((t) => typeof t === 'string' && RLS_REFUSAL.test(t));

/**
 * The hint after a refusal, or '' (no refusal, or on the Owner connection, where it is a real one).
 * to: the SQL Workshop page to come back to after switching to the Owner connection.
 */
export async function rlsHint(s: Session, to: string, texts: (string | null | undefined)[]): Promise<Raw | ''> {
  if (!isRlsRefusal(texts) || (await ownerChosen(s))) return '';
  const tx = tr(s);
  const admin = await isAdmin(s.username);
  return html`<div class="alert alert-note rls-hint" role="note"><p class="u-m0">${tx('ws.rls_hint')}</p>${admin
    ? html`<form method="post" action="${BASE}/sql/run-as" class="search u-mwnone u-mt1">${csrf(s)}<input type="hidden" name="as" value="owner"><input type="hidden" name="to" value="${to}">
        <div class="field"><label class="label" for="f_rls_reason">${tx('ws.rls_reason')}</label><input id="f_rls_reason" name="reason" maxlength="${REASON_MAX}" required></div>
        <button class="btn u-selfend">${tx('ws.rls_owner')}</button></form>`
    : html`<p class="u-m0 small">${tx('ws.rls_ask_admin')}</p>`}</div>`;
}
