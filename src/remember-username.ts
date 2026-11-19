import type { FastifyReply, FastifyRequest } from 'fastify';

// (sprint 231, AX-13; APEX: the login page's "Remember username", P9999_REMEMBER, and
// apex_authentication.send_login_username_cookie) The sign-in form's "Remember username": after a successful
// sign-in with the box checked, a cookie of the application's path keeps the user name that was typed, and the
// sign-in form (built-in page or Login region) is filled in with it, the box checked. Unchecked, the cookie is
// removed. It holds nothing secret (the name only, never a token); it is HttpOnly anyway, since only the server
// reads it, SameSite=Lax and Secure behind HTTPS (COOKIE_SECURE). meta.app.remember_username (migration 189)
// turns the box off; the cookie is then neither read nor set. "Keep me signed in" is remember.ts.

export const usernameCookie = (appId: number) => `pgkiln_user_${appId}`;
const DAYS = 180;
const MAX = 100;

interface UsernameApp {
  id: number;
  alias: string;
  remember_username?: boolean | null;
}

/** The application offers "Remember username" (on unless turned off). */
export const remembersUsername = (a: UsernameApp) => a.remember_username !== false;

/** A user name fit for the field: one line, at most 100 characters, nothing else (the form escapes it). */
const clean = (v: unknown) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX) : '');

/** The remembered user name of this browser, or undefined. */
export function rememberedUsername(req: FastifyRequest, a: UsernameApp): string | undefined {
  if (!remembersUsername(a)) return undefined;
  return clean(req.cookies?.[usernameCookie(a.id)]) || undefined;
}

/** After a successful sign-in: keep the typed user name when the box was checked, else forget it. */
export function rememberUsernameChoice(reply: FastifyReply, a: UsernameApp, typed: string, checked: boolean) {
  if (!remembersUsername(a)) return;
  const name = clean(typed);
  const path = `/a/${a.alias}`;
  if (checked && name)
    reply.setCookie(usernameCookie(a.id), name, { path, httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true', maxAge: DAYS * 86400 });
  else reply.clearCookie(usernameCookie(a.id), { path });
}
