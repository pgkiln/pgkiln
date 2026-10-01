import type { PageCss } from '../css.ts';
import type pg from 'pg';
import type { BindValues } from '../binds.ts';
import type { Client } from '../db.ts';
import type { Raw } from '../html.ts';
import type { App, Button, Page } from '../metadata.ts';
import type { Locale } from './locale.ts';
import { english, type Translate } from '../i18n.ts';
import { logActivity, type Session } from '../session.ts';

export interface Errors {
  page: string[];
  items: Record<string, string>;
}

/** What the current user may see and change on this page (see authz.ts). */
export interface Visibility {
  regions: Set<number>;
  items: Set<string>;
  /** visible, not hidden/display, not read-only: the only items a POST may set */
  editable: Set<string>;
  buttons: Map<string, Button>;
  dynamicActions: Set<number>;
}

export interface PageContext {
  app: App;
  page: Page;
  session: Session;
  base: string; // "/a/<alias>"
  params: URLSearchParams; // query string of the current request
  request: string;
  user: string;
  roles: string[];
  ip: string;
  errors: Errors;
  messages: string[];
  /** rendered inside a modal dialog (iframe) */
  dialog: boolean;
  client?: Client;
  vis?: Visibility;
  authzCache: Map<string, boolean>;
  /** Forms rendered after the main page <form> (report search/filter boxes). */
  detached: Raw[];
  /** data-dependent styles (chart geometry): one nonce'd <style> in the page head */
  css: PageCss;
  /** the response's CSP nonce */
  nonce: string;
  /** The submitted form (POST), e.g. for grid rows. */
  body?: Record<string, unknown>;
  /** language, texts and theme of this request */
  locale: Locale;
}

/** Session state plus the built-in substitution strings. */
export function bindValues(ctx: PageContext): BindValues {
  return {
    ...ctx.session.state,
    APP_USER: ctx.user,
    APP_ID: String(ctx.app.id),
    APP_ALIAS: ctx.app.alias,
    APP_PAGE_ID: String(ctx.page.page_no),
    APP_SESSION: ctx.session.id,
    REQUEST: ctx.request,
    APP_LANGUAGE: ctx.locale.lang,
  };
}

/** Replace &NAME. substitution strings (APEX syntax); `encode` escapes each value. */
export function substitute(text: string, ctx: PageContext, encode: (v: string) => string) {
  const values = bindValues(ctx);
  return text.replace(/&([A-Za-z][A-Za-z0-9_]*(?:\$[A-Za-z0-9_.-]+?)?)\./g, (m, name: string) => {
    const upper = name.toUpperCase();
    if (upper.startsWith('APP_TEXT$')) {
      const msg = ctx.locale.messages[upper.slice(9)];
      return msg === undefined ? m : encode(msg);
    }
    const v = values[upper];
    return v === undefined ? m : encode(v ?? '');
  });
}

/** Convert a value returned by Postgres into its session-state string form. */
export function toState(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function stripSemicolon(sql: string) {
  return sql.trim().replace(/;+\s*$/, '');
}

const FRIENDLY: Record<string, (e: pg.DatabaseError, t: Translate) => string> = {
  '23505': (e, t) => t('error.duplicate', { detail: e.constraint ? ` (${e.constraint})` : '' }),
  '23503': (e, t) =>
    e.detail?.includes('still referenced')
      ? t('error.referenced', { detail: e.table ? ` (${e.table})` : '' })
      : t('error.missing_reference'),
  '23502': (e, t) => t('error.not_null', { column: e.column ?? t('error.not_null_any') }),
  '23514': (e, t) => t('error.check', { rule: e.constraint ?? 'check' }),
  // exclusion constraints, e.g. no overlapping date ranges (btree_gist)
  '23P01': (e, t) => t('error.check', { rule: e.constraint ?? 'exclusion' }),
  '22P02': (_, t) => t('error.format'),
  '22007': (_, t) => t('error.datetime'),
  '22008': (_, t) => t('error.datetime_range'),
  '22003': (_, t) => t('error.number_range'),
  '42501': (_, t) => t('error.permission'),
};

/**
 * The message an end user may see for an error. Messages raised on purpose
 * (RAISE EXCEPTION in PL/pgSQL, errcode P0001, or our own Error objects) are
 * shown as-is; common constraint errors get friendly text; anything else is
 * logged and replaced by a reference number unless the app is in debug mode.
 */
export async function publicError(ctx: Pick<PageContext, 'app' | 'page' | 'user' | 'ip'> & { locale?: Locale }, e: unknown, where: string) {
  const t = ctx.locale?.t ?? english;
  const err = e as pg.DatabaseError;
  if (!err.code) return err.message;
  if (err.code === 'P0001') return err.message;
  const friendly = FRIENDLY[err.code]?.(err, t);
  if (ctx.app.debug) return `${where}: ${err.message}`;
  if (friendly) return friendly;
  const ref = await logActivity({
    appId: ctx.app.id,
    pageNo: ctx.page?.page_no,
    username: ctx.user,
    event: 'error',
    ip: ctx.ip,
    detail: `${where}: [${err.code}] ${err.message}`,
  });
  return ref ? t('error.reference', { ref }) : t('error.unexpected');
}
