// (sprint 250, MG-24; migration 206) Redirect all mail to one address, for test and acceptance
// installations: the environment variable MAIL_REDIRECT_TO (every mail of the installation) wins over
// the application setting meta.app.mail_redirect_to (that application's mail). Applied when the server
// hands a mail to a provider (sendWith in mail.ts, and the builder's test mail), whatever service it goes
// through: To becomes the one address, Cc and Bcc are dropped, the subject starts with [TEST], the
// original recipients go in X-Original-To/-Cc/-Bcc headers and in a line at the top of the body.
import { owner } from '../db.ts';
import { MailError, type OutgoingMail } from './providers.ts';

/** One plain address (what meta.app.mail_redirect_to's check allows). */
export const REDIRECT_ADDRESS = /^[^\s@,;<>"()[\]]+@[^\s@,;<>"()[\]]+\.[^\s@,;<>"()[\]]+$/;

export interface Redirect {
  to: string;
  /** where it comes from: the environment variable or the application's setting */
  source: 'MAIL_REDIRECT_TO' | 'application';
}

/** MAIL_REDIRECT_TO, checked (a value that is not one address stops all mail rather than letting it out). */
export function envRedirect(env = process.env): Redirect | null {
  const v = env.MAIL_REDIRECT_TO?.trim();
  if (!v) return null;
  if (v.length > 254 || !REDIRECT_ADDRESS.test(v)) throw new MailError(`MAIL_REDIRECT_TO (${v.slice(0, 100)}) is not one e-mail address: no mail is sent until it is.`, false);
  return { to: v, source: 'MAIL_REDIRECT_TO' };
}

/** The redirect of an application's mail now (null: none); appId null: mail of the builder (the environment only). */
export async function redirectFor(appId: number | null): Promise<Redirect | null> {
  const env = envRedirect();
  if (env || appId === null) return env;
  const row = await owner.one<{ mail_redirect_to: string | null }>('select mail_redirect_to from meta.app where id = $1', [appId]);
  const to = row?.mail_redirect_to?.trim();
  if (!to) return null;
  if (!REDIRECT_ADDRESS.test(to)) throw new MailError(`The application's "Redirect all mail to" (${to.slice(0, 100)}) is not one e-mail address.`, false);
  return { to, source: 'application' };
}

const TEST = '[TEST]';
/** A header value: one line, at most 900 characters. */
const oneLine = (s: string) => {
  const v = s.replace(/[\r\n\t\0]+/g, ' ').trim();
  return v.length > 900 ? `${v.slice(0, 897)}...` : v;
};
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The line that tells the reader where the mail would have gone. */
export function redirectNote(m: Pick<OutgoingMail, 'to' | 'cc' | 'bcc'>, r: Redirect) {
  const parts = [`To: ${m.to.join(', ') || '-'}`];
  if (m.cc.length) parts.push(`Cc: ${m.cc.join(', ')}`);
  if (m.bcc.length) parts.push(`Bcc: ${m.bcc.join(', ')}`);
  return `${TEST} Redirected to ${r.to} (${r.source === 'MAIL_REDIRECT_TO' ? 'MAIL_REDIRECT_TO' : 'the application\'s "Redirect all mail to"'}). Originally ${parts.join('; ')}.`;
}

/** The mail as it is sent under a redirect: only to r.to, everything else of it unchanged. */
export function redirectMail(m: OutgoingMail, r: Redirect): OutgoingMail {
  const note = redirectNote(m, r);
  const headers: Record<string, string> = { 'X-Pgkiln-Redirected': oneLine(`${r.source === 'MAIL_REDIRECT_TO' ? 'MAIL_REDIRECT_TO' : 'application'}; to ${r.to}`) };
  headers['X-Original-To'] = oneLine(m.to.join(', ') || '-');
  if (m.cc.length) headers['X-Original-Cc'] = oneLine(m.cc.join(', '));
  if (m.bcc.length) headers['X-Original-Bcc'] = oneLine(m.bcc.join(', '));
  let html = m.html;
  if (html !== null) {
    const p = `<p style="margin:0 0 12px;padding:6px 8px;border:1px solid #c60;background:#fff4e5;color:#000;font:13px sans-serif">${escapeHtml(note)}</p>`;
    // after <body …> when the HTML has one, else in front
    html = /<body\b[^>]*>/i.test(html) ? html.replace(/<body\b[^>]*>/i, (b) => b + p) : p + html;
  }
  const text = m.text !== null ? `${note}\n\n${m.text}` : html === null ? note : null;
  return {
    ...m,
    to: [r.to],
    cc: [],
    bcc: [],
    subject: m.subject.startsWith(TEST) ? m.subject : `${TEST} ${m.subject}`,
    text,
    html,
    // only these headers: nothing of the original mail can name another recipient
    headers,
  };
}
