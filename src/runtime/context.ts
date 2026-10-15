import type { Download } from './processes.ts';
import type { PassThrough } from 'node:stream';
import type { PageCss } from '../css.ts';
import pg from 'pg';
import type { BindValues } from '../binds.ts';
import { runtime, type Client } from '../db.ts';
import type { Raw } from '../html.ts';
import type { App, Button, Page } from '../metadata.ts';
import type { Locale } from './locale.ts';
import { english, type Translate } from '../i18n.ts';
import { logActivity, type Session } from '../session.ts';
import type { DebugLog } from '../debug.ts';

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
  /** (0.31) tasks for after the current transaction commits or rolls back (txContext, src/db.ts appTx) */
  afterCommit?: (() => Promise<void>)[];
  afterRollback?: (() => Promise<void>)[];
  /** (0.31) objects stored in object storage by this request (a failing process removes its own) */
  objectsPut?: [import('../objectstore.ts').ObjectStoreConfig, string][];
  /** (0.31) the style variant whose condition held for this request (undefined: not checked yet) */
  styleByCondition?: string | null;
  /** The submitted form (POST), e.g. for grid rows. */
  body?: Record<string, unknown>;
  /** language, texts and theme of this request */
  locale: Locale;
  /** set when a link with a per-user checksum was rendered (region caching for all users skips such regions) */
  userBound?: boolean;
  /** render cached regions anew (a dynamic action's Refresh region), storing the new result */
  cacheRefresh?: boolean;
  /** the lazy region the request renders (GET …/region/:id), not as a placeholder */
  loadNow?: number;
  /** the whole page is rendered (renderPage), not one region on its own */
  wholePage?: boolean;
  /** a download process's file, sent instead of the page (processes.ts) */
  download?: Download;
  /** running a background chain (process-jobs.ts): no request, no browser */
  background?: boolean;
  /** debug messages of this request, when the app's debug level is on (src/debug.ts) */
  debug?: DebugLog;
  /** (085) values of an Ajax callback's x01 … x10 parameters, as binds X01 … X10 */
  extraBinds?: Record<string, string | null>;
  /** (079) the developer whose builder session is open in this browser (the developer toolbar), if any */
  devbar?: import('./devbar.ts').Devbar | null;
  /** (078) the origins the response may frame (the request's set; security.ts adds them to the CSP) */
  frameSrc?: Set<string> | null;
  /** (086) the https origins of images the response shows (display image items; security.ts adds them to the CSP) */
  imgSrc?: Set<string> | null;
  /** (076) per form region: the checksum of its row when it was fetched (lost update detection) */
  rowVersions?: Map<number, string>;
}

/** Write a debug message when this request records them (no-op otherwise). */
export function dbg(ctx: { debug?: DebugLog }, level: number, component: string, text: string | (() => string)) {
  if (ctx.debug?.on(level)) ctx.debug.add(level, component, typeof text === 'function' ? text() : text);
}

/** Run `fn` as a timed debug step when this request records level `level`. */
export function timed<T>(ctx: { debug?: DebugLog }, level: number, component: string, text: string | (() => string), fn: () => Promise<T>): Promise<T> {
  if (!ctx.debug?.on(level)) return fn();
  return ctx.debug.time(level, component, typeof text === 'function' ? text() : text, fn);
}

/** Session state plus the built-in substitution strings. */
export function bindValues(ctx: PageContext): BindValues {
  return {
    ...ctx.session.state,
    // (085) :X01 … :X10 of an Ajax callback (never the built-in names below)
    ...ctx.extraBinds,
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
export async function publicError(ctx: Pick<PageContext, 'app' | 'page' | 'user' | 'ip'> & { locale?: Locale; debug?: DebugLog }, e: unknown, where: string) {
  const t = ctx.locale?.t ?? english;
  const err = e as pg.DatabaseError;
  dbg(ctx, 1, 'error', () => `${where}: ${err.code ? `[${err.code}] ` : ''}${err.message}${err.where ? ` (${err.where.split('\n')[0]})` : ''}`);
  const handled = (message: string, internal: boolean, reference: string | null = null) =>
    errorFunction(ctx, { message, original_message: err.message ?? String(e), code: err.code ?? null, constraint: err.constraint ?? null, table: err.table ?? null,
      column: err.column ?? null, detail: err.detail ?? null, hint: err.hint ?? null, component: where, page: ctx.page?.page_no ?? null, user: ctx.user, internal, reference });
  if (!err.code || err.code === 'P0001') return handled(err.message, false);
  const friendly = FRIENDLY[err.code]?.(err, t);
  if (ctx.app.debug) return `${where}: ${err.message}`;
  if (friendly) return handled(friendly, false);
  const ref = await logActivity({
    appId: ctx.app.id,
    pageNo: ctx.page?.page_no,
    username: ctx.user,
    event: 'error',
    ip: ctx.ip,
    detail: `${where}: [${err.code}] ${err.message}`,
  });
  return handled(ref ? t('error.reference', { ref }) : t('error.unexpected'), true, ref ?? null);
}

const ERROR_FUNCTION = /^([A-Za-z_][A-Za-z0-9_$]{0,62})\.([A-Za-z_][A-Za-z0-9_$]{0,62})$/;

/**
 * (085) The application's error handling function (APEX: Error Handling Function):
 * schema.function(jsonb) returns jsonb, called as the application's role in a
 * transaction of its own (2 s), with the message pgkiln would show and what it
 * knows of the error. When it returns {"message": "…"}, that is shown instead;
 * when it returns null or fails, the message stays.
 */
async function errorFunction(ctx: Pick<PageContext, 'app' | 'user'> & { debug?: DebugLog }, info: { message: string } & Record<string, unknown>) {
  const fn = ERROR_FUNCTION.exec(ctx.app.error_function ?? '');
  if (!fn) return info.message;
  try {
    const r = await runtime.tx(async (c) => {
      await c.query(`set local statement_timeout = '2s'`);
      await c.query(`select set_config('pgkiln.app_id', $1, true), set_config('pgkiln.app_user', $2, true)`, [String(ctx.app.id), ctx.user]);
      if (ctx.app.db_role) await c.query(`set local role ${pg.escapeIdentifier(ctx.app.db_role)}`);
      return (await c.query(`select ${pg.escapeIdentifier(fn[1])}.${pg.escapeIdentifier(fn[2])}($1::jsonb) as r`, [JSON.stringify(info)])).rows[0]?.r;
    });
    if (r && typeof r === 'object' && typeof r.message === 'string' && r.message.trim()) return r.message.trim().slice(0, 2000);
  } catch (e) {
    dbg(ctx, 1, 'error', () => `error handling function ${ctx.app.error_function}: ${(e as Error).message}`);
  }
  return info.message;
}

/** Write to a streamed response, waiting while the client is slow; fails once the client is gone. */
export async function writeOut(out: PassThrough, chunk: string | Uint8Array) {
  if (out.destroyed) throw new Error('download aborted');
  if (out.write(chunk)) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      out.off('drain', done);
      out.off('close', done);
      resolve();
    };
    out.on('drain', done);
    out.on('close', done);
  });
  if (out.destroyed) throw new Error('download aborted');
}
