import { PageCss } from '../css.ts';
import { forgetRemember, issueRemember, useRemember } from '../remember.ts';
import { appDirectories, ldapAuthenticate, LdapError, resolveLdapAccount } from '../ldap.ts';
import { finishSamlSignIn, samlMetadata, startSamlSignIn } from '../saml.ts';
import { dbAuthenticate } from '../dbauth.ts';
import { headerValue, HeaderAuthError, peerAddress, resolveHeaderAccount, trustedPeer } from '../headerauth.ts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { applyBinds } from '../binds.ts';
import { appTx, runtime, savepoint } from '../db.ts';
import { html } from '../html.ts';
import { documentShell } from '../layout.ts';
import { accountRoles, loadApp, loadPage, type App, type Page, type Region } from '../metadata.ts';
import { passwordDaysLeft, passwordProblem } from '../accounts.ts';
import { english, type Translate } from '../i18n.ts';
import { checksumValid, LOGIN_WINDOW_MINUTES, urlChecksum } from '../security.ts';
import { enabledProviders, finishSignIn, loadProvider, ssoAccess, SsoError, startSignIn, type SsoResult } from '../sso.ts';
import { clientIp, createSession, destroySession, getSession, loginThrottled, logActivity, saveState, takeFlash, type Session } from '../session.ts';
import { checkPageAccess, computeVisibility, Forbidden, isAuthorized } from './authz.ts';
import { bindValues, publicError, stripSemicolon, toState, writeOut, type PageContext } from './context.ts';
import { clearPageItems, fetchForms, ProcessFailed, runAppProcesses, runProcesses, runSql, validate, ValidationFailed } from './engine.ts';
import { branchTarget, ComputationFailed, runComputations } from './logic.ts';
import { comboMultiple, MULTI_VALUE, popupPageSize, renderItem, searchLov } from './items.ts';
import { cleanRichText } from '../richtext.ts';
import { applyUploads, fileRoutes, readMultipart, type Upload } from './files.ts';
import { renderRegion } from './regions.ts';
import { moveCalendarEvent } from './calendar.ts';
import { openDownload, reportParams, normaliseReportParams, selectionOf } from './report.ts';
import { invalidatePage, lazyOf } from './region-cache.ts';
import { applyRowSelection, mastersOf } from './master-detail.ts';
import { currentLayout, layoutJson, layoutParam, parseLayout, storeLayout } from './grid-layout.ts';
import { layoutFromForm, statePart } from './grid.ts';
import { PassThrough } from 'node:stream';
import { reportPdf } from './pdf.ts';
import { renderDocument } from './documents.ts';
import { pwaHead } from './pwa.ts';
import { resolveLocale, THEME_COOKIE, translateApp, translatePage, type Locale } from './locale.ts';
import { chrome, dialogClosePage, languagePicker, renderPage } from './render.ts';

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

type Params = { alias: string; page?: string; id?: string; item?: string; sid?: string };
type Body = Record<string, string | undefined>;
export type Req = FastifyRequest<{ Params: Params; Body: Body }>;

const list = (s: string | null | undefined) => (s ?? '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);

export function simplePage(reply: FastifyReply, code: number, title: string, message: string, back?: string, locale?: Locale) {
  const t = locale?.t ?? english;
  return reply
    .code(code)
    .type('text/html')
    .send(
      documentShell(
        title,
        html`<main class="t-error"><div class="card"><h1>${title}</h1><p>${message}</p>${back ? html`<p><a class="btn" href="${back}">${t('common.back')}</a></p>` : ''}</div></main>`,
        'login-body',
        {},
        '',
        rootAttrs(locale),
      ),
    );
}

export const rootAttrs = (locale?: Locale) => (locale ? { lang: locale.lang, dir: locale.dir, theme: locale.theme } : {});

/** Load an app with its texts in the request's language. */
export async function appWithLocale(req: FastifyRequest, alias: string, session?: Session) {
  const app = await loadApp(alias);
  if (!app) return undefined;
  const locale = await resolveLocale(req, app, session);
  if (locale.lang !== app.language) translateApp(app, locale.tr);
  return { app, locale };
}

export const safeNext = (app: App, next: string | undefined) =>
  next && next.startsWith(`/a/${app.alias}/`) && !/[\\\r\n]/.test(next) && !next.includes('//') ? next : `/a/${app.alias}/${app.home_page}`;

/**
 * Finish a successful sign-in (password or SSO): replace the session (no
 * session fixation), resolve the user's roles for this app (plus roles from
 * identity-provider groups), log it and run the "after login" processes.
 */
interface SignInOptions {
  extraRoles?: string[];
  detail?: string;
  /** "Remember me" was checked (or the sign-in came from a remembered one) */
  remember?: boolean;
  /** identity-provider groups, kept with a remembered sign-in */
  groups?: string[];
  method?: string;
  /** a remembered sign-in keeps the expiry of the original one */
  rememberUntil?: Date;
}

/** Sign-in: replace the session with one for the user and run the after-login processes. */
export async function signIn(req: FastifyRequest, reply: FastifyReply, a: App, oldSession: Session, username: string, opts: SignInOptions = {}) {
  const { extraRoles = [], detail } = opts;
  const base = `/a/${a.alias}`;
  const roles = [...new Set([...(await accountRoles(a.id, username)), ...extraRoles.map((r) => r.toLowerCase())])].sort();
  await destroySession(reply, oldSession, base);
  const s = await createSession(reply, a.id, base, username, roles);
  logActivity({ appId: a.id, username, event: 'login', ip: clientIp(req), detail });
  // the account's preferences: light/dark and language
  const pref = await runtime.one<{ theme_pref: string; language: string | null }>(
    'select theme_pref, language from meta.account where lower(username) = lower($1)', [username]);
  if (pref) {
    s.state.__THEME = pref.theme_pref;
    if (pref.language) s.state.__LANG = pref.language;
    if (a.theme?.user_choice !== false) reply.setCookie(THEME_COOKIE, pref.theme_pref, { path: '/', sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true', maxAge: 365 * 86400 });
  }
  await saveState(s);

  if (a.app_processes.some((p) => p.point === 'after_login')) {
    const home = (await loadPage(a.id, a.home_page)) ?? ({ page_no: a.home_page, items: [], regions: [], buttons: [], dynamic_actions: [], validations: [], processes: [], computations: [], branches: [] } as unknown as Page);
    const ctx: PageContext = {
      app: a, page: home, session: s, base, params: new URLSearchParams(), request: '', user: username,
      roles, ip: clientIp(req), errors: { page: [], items: {} }, messages: [],
      dialog: false, authzCache: new Map(), detached: [], css: new PageCss(), nonce: req.cspNonce, locale: await resolveLocale(req, a, s),
    };
    await appTx(txContext(ctx), async (c) => {
      ctx.client = c;
      await runAppProcesses(ctx, 'after_login');
    });
    await saveState(s);
  }
  if (opts.remember) await issueRemember(req, reply, a, username, { groups: opts.groups, method: opts.method, expiresAt: opts.rememberUntil });
  return s;
}

export async function completeLogin(req: FastifyRequest, reply: FastifyReply, a: App, oldSession: Session, username: string, opts: SignInOptions & { next?: string } = {}) {
  await signIn(req, reply, a, oldSession, username, opts);
  return reply.redirect(safeNext(a, opts.next), 303);
}

/**
 * HTTP-header authentication: the session for the user the trusted proxy names,
 * or null after sending an error page. The session is bound to the header value:
 * a missing or changed header ends it.
 */
async function headerSession(req: FastifyRequest, reply: FastifyReply, a: App, session: Session, locale: Locale, json: boolean): Promise<Session | null> {
  const ip = clientIp(req);
  const base = `/a/${a.alias}`;
  const t = locale.t;
  const refuse = async (code: number, title: string, message: string, detail: string, username?: string, endSession = true) => {
    if (endSession && session.username) {
      logActivity({ appId: a.id, username: session.username, event: 'logout', ip, detail: `header: ${detail}` });
      await destroySession(reply, session, base);
    }
    await logActivity({ appId: a.id, username: username ?? null, event: 'login_failed', ip, detail: `header: ${detail}` });
    if (json) reply.code(code).send({ error: message });
    else simplePage(reply, code, title, message, undefined, locale);
    return null;
  };
  const peer = peerAddress(req);
  if (!trustedPeer(peer)) return refuse(403, t('login.sso_failed'), t('login.header_untrusted'), `untrusted peer ${peer ?? '?'}`, undefined, false);
  const value = headerValue(req, a);
  if (value === undefined) return refuse(401, t('login.sso_failed'), t('login.header_missing'), 'no user header');
  if (value === null) return refuse(400, t('login.sso_failed'), t('login.header_invalid'), 'invalid user header');
  if (session.username && session.state.__HEADER_USER === value) return session;
  if (session.username) logActivity({ appId: a.id, username: session.username, event: 'logout', ip, detail: 'header: user header changed' });
  let account: string;
  try {
    account = await resolveHeaderAccount(a, value);
  } catch (e) {
    if (!(e instanceof HeaderAuthError)) throw e;
    return refuse(403, t('login.no_access_title'), t(e.key, { user: value }), e.key === 'login.no_account' ? 'no account' : 'account disabled', value);
  }
  const access = await ssoAccess(a.id, account, []);
  if (!access.allowed) return refuse(403, t('login.no_access_title'), t('login.no_access', { user: account, app: a.name }), 'no access', account);
  const s = await signIn(req, reply, a, session, account, { method: 'header', detail: 'header' });
  s.state.__HEADER_USER = value;
  await saveState(s);
  return s;
}

export const txContext = (ctx: PageContext) => ({
  appId: ctx.app.id,
  alias: ctx.app.alias,
  dbRole: ctx.app.db_role,
  appUser: ctx.user,
  sessionId: ctx.session.id,
  lang: ctx.locale.lang,
});

/** Load app, page, session and user; handles 404 and the login redirect. */
export async function loadContext(req: Req, reply: FastifyReply, { json = false, pageNo: fixedPage }: { json?: boolean; pageNo?: 'home' } = {}): Promise<PageContext | null> {
  const app = await loadApp(req.params.alias);
  if (!app) return simplePage(reply, 404, english('error.not_found'), english('error.app_not_found', { app: req.params.alias })), null;
  const base = `/a/${app.alias}`;
  let session = await getSession(req, reply, app.id, base);
  // the session ended, but the browser was remembered: sign in again silently (a new token each time)
  if (app.authentication === 'app_users' && !session.username) {
    const remembered = await useRemember(req, reply, app);
    if (remembered)
      session = await signIn(req, reply, app, session, remembered.username, {
        extraRoles: remembered.roles, groups: remembered.groups, method: remembered.method,
        remember: true, rememberUntil: remembered.expiresAt, detail: 'remember me',
      });
  }
  const langBefore = session.state.__LANG;
  let locale = await resolveLocale(req, app, session);
  if (session.state.__LANG !== langBefore) await saveState(session);
  if (app.authentication === 'header') {
    const s = await headerSession(req, reply, app, session, locale, json);
    if (!s) return null;
    if (s !== session) locale = await resolveLocale(req, app, s);
    session = s;
  }
  if (locale.lang !== app.language) translateApp(app, locale.tr);
  const pageNo = fixedPage === 'home' ? app.home_page : Number(req.params.page);
  const page = Number.isInteger(pageNo) && pageNo > 0 ? await loadPage(app.id, pageNo) : undefined;
  if (!page) return simplePage(reply, 404, locale.t('error.not_found'), locale.t('error.page_not_found', { page: req.params.page, app: app.name }), base, locale), null;
  if (locale.lang !== app.language) translatePage(page, locale.tr);
  const user = app.authentication === 'none' ? 'nobody' : (session.username ?? 'nobody');

  if (app.authentication !== 'none' && (page.requires_auth || fixedPage) && !session.username) {
    if (json) reply.code(401).send({ error: locale.t('error.session_ended') });
    else reply.redirect(`${base}/login?next=${encodeURIComponent(req.url)}`);
    return null;
  }
  return {
    app,
    page,
    session,
    base,
    params: new URLSearchParams(req.url.split('?')[1] ?? ''),
    request: '',
    user,
    roles: app.authentication === 'none' ? [] : (session.roles ?? []),
    ip: clientIp(req),
    errors: { page: [], items: {} },
    messages: [],
    dialog: false,
    authzCache: new Map(),
    detached: [],
    css: new PageCss(),
    nonce: req.cspNonce,
    locale,
  };
}

async function forbidden(ctx: PageContext, reply: FastifyReply, message: string, detail: string) {
  logActivity({ appId: ctx.app.id, pageNo: ctx.page.page_no, username: ctx.user, event: 'forbidden', ip: ctx.ip, detail });
  const t = ctx.locale.t;
  const main = html`<div class="t-titlebar"><h1>${t('error.access_denied')}</h1></div>
    <div class="t-content"><div class="alert alert-error" role="alert">${message}</div>
    <p><a class="btn" href="${ctx.base}/${ctx.app.home_page}">${t('common.home')}</a></p></div>`;
  ctx.vis = { regions: new Set(), items: new Set(), editable: new Set(), buttons: new Map(), dynamicActions: new Set() };
  const body = await appTx(txContext(ctx), async (c) => {
    ctx.client = c;
    return chrome(ctx, main, t('error.access_denied'));
  });
  return reply.code(403).type('text/html').send(body);
}

/**
 * Items can be set through the URL (?P3_EMPNO=7839), which first clears all
 * items of the target page, as does ?clear=1. On pages with protection =
 * 'checksum' the values must carry the checksum the runtime generated.
 */
function applyUrlItems(ctx: PageContext): boolean {
  const names = new Set(ctx.page.items.map((i) => i.name));
  const provided = [...ctx.params.entries()].filter(([k]) => names.has(k.toUpperCase()));
  if (provided.length && ctx.page.protection === 'checksum') {
    const items = Object.fromEntries(provided.map(([k, v]) => [k.toUpperCase(), v]));
    if (!checksumValid(urlChecksum(ctx.app.id, ctx.page.page_no, ctx.user, items), ctx.params.get('cs') ?? undefined)) return false;
  }
  if (!provided.length && !ctx.params.has('clear')) return true;
  clearPageItems(ctx);
  for (const [k, v] of provided) ctx.session.state[k.toUpperCase()] = v === '' ? null : v;
  return true;
}

/** Copy submitted values into session state, for editable items only. */
function applyPostedItems(ctx: PageContext, body: Body, only?: string[]) {
  const selectionItems = new Set(ctx.page.regions.flatMap((r) => selectionOf(ctx.page, r)?.item ?? []));
  for (const item of ctx.page.items) {
    if (!ctx.vis!.editable.has(item.name) || item.type === 'file') continue;
    if (only && !only.includes(item.name)) continue;
    const raw = body[item.name] as string | string[] | undefined;
    if (MULTI_VALUE.has(item.type) || selectionItems.has(item.name)) {
      const values = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((v) => v !== '');
      ctx.session.state[item.name] = values.length ? values.join(':') : null;
      continue;
    }
    if (item.type === 'daterange') {
      // two date inputs with the item's name (or "from:to" from a dynamic action); format checked in validate()
      const parts = (Array.isArray(raw) ? raw : raw ? String(raw).split(':') : []).map((v) => String(v).trim());
      ctx.session.state[item.name] = parts.some(Boolean) ? (parts.length === 1 ? `${parts[0]}:` : parts.join(':')) : null;
      continue;
    }
    if (item.type === 'combobox' && comboMultiple(item)) {
      // tags: colon-separated, trimmed, each once
      const tags = [...new Set((Array.isArray(raw) ? raw : [raw ?? '']).flatMap((v) => String(v).split(':')).map((v) => v.trim()).filter(Boolean))];
      ctx.session.state[item.name] = tags.length ? tags.join(':') : null;
      continue;
    }
    const posted = Array.isArray(raw) ? raw[raw.length - 1] : raw;
    if (item.type === 'richtext') ctx.session.state[item.name] = cleanRichText(posted) || null;
    else if (item.type === 'markdown') ctx.session.state[item.name] = posted ? String(posted).replace(/\r\n?/g, '\n') : null;
    else if (item.type === 'checkbox' || item.type === 'switch') ctx.session.state[item.name] = posted === 'true' ? 'true' : 'false';
    else if (item.type === 'password' && !posted) continue;
    else ctx.session.state[item.name] = posted === undefined || posted === '' ? null : String(posted);
  }
}

async function renderResponse(ctx: PageContext, reply: FastifyReply, code = 200) {
  const body = await appTx(txContext(ctx), async (c) => {
    ctx.client = c;
    ctx.authzCache.clear();
    await computeVisibility(ctx);
    return renderPage(ctx);
  });
  await saveState(ctx.session);
  return reply.code(code).type('text/html').send(body);
}

export async function runtimeRoutes(app: FastifyInstance) {
  app.get<{ Params: Params }>('/a/:alias', async (req, reply) => {
    const a = await loadApp(req.params.alias);
    if (!a) return simplePage(reply, 404, english('error.not_found'), english('error.app_not_found', { app: req.params.alias }));
    return reply.redirect(`/a/${a.alias}/${a.home_page}`);
  });

  // ---------------------------------------------------------------- show page
  app.get('/a/:alias/:page', async (req: Req, reply) => {
    const started = performance.now();
    const ctx = await loadContext(req, reply);
    if (!ctx) return;
    ctx.dialog = ctx.params.get('dialog') === '1';

    const normalised = normaliseReportParams(ctx.params);
    if (normalised !== null) return reply.redirect(`${ctx.base}/${ctx.page.page_no}${normalised ? `?${normalised}` : ''}`);

    if (!applyUrlItems(ctx)) return forbidden(ctx, reply, ctx.locale.t('error.checksum'), `checksum error: ${req.url}`);
    // a master grid's selected row (signed link) into its item
    applyRowSelection(ctx);
    const flash = takeFlash(ctx.session);
    if (flash) ctx.messages.push(flash);
    const flashError = takeFlash(ctx.session, '__FLASH_ERROR');
    if (flashError) ctx.errors.page.push(flashError);
    // Actions → Download CSV / Excel / PDF: r<region id>_csv=1, _xlsx=1 or _pdf=1
    const downloadKey = [...ctx.params.keys()].find((k) => /^r\d+_(csv|xlsx|pdf)$/.test(k));
    // a document template: ?doc=NAME (see documents.ts)
    const docName = ctx.params.get('doc');

    let result: { html?: string; streamed?: boolean; file?: Buffer; type?: string; name?: string; redirect?: string };
    try {
      result = await appTx(txContext(ctx), async (c) => {
        ctx.client = c;
        await checkPageAccess(ctx);
        await runAppProcesses(ctx, 'before_page');
        // before header (as in APEX): branches, then computations and processes
        if (!docName && !downloadKey) {
          const to = await branchTarget(ctx, 'before_header');
          if (to) return { redirect: to };
        }
        await fetchForms(ctx);
        await runComputations(ctx, 'before_header');
        try {
          await runProcesses(ctx, 'load');
        } catch (e) {
          ctx.errors.page.push((e as Error).message);
        }
        await computeVisibility(ctx);
        if (docName) return renderDocument(ctx, docName);
        if (downloadKey) {
          const format = downloadKey.slice(downloadKey.indexOf('_') + 1);
          const region = ctx.page.regions.find((r) => `r${r.id}_${format}` === downloadKey && r.type === 'report' && ctx.vis!.regions.has(r.id));
          if (!region) throw new Forbidden(ctx.locale.t('error.report_unavailable'));
          const name = (region.title ?? 'report').replace(/[^\w-]+/g, '_');
          if (format === 'pdf') return { file: await reportPdf(ctx, region), type: 'application/pdf', name: `${name}.pdf` };
          // CSV and Excel stream from a cursor while the transaction is open
          const send = await openDownload(ctx, region, format as 'csv' | 'xlsx');
          const out = new PassThrough();
          reply
            .header('content-disposition', `attachment; filename="${name}.${format}"`)
            .header('cache-control', 'private, no-store')
            .type(format === 'xlsx' ? XLSX_TYPE : 'text/csv; charset=utf-8')
            .send(out);
          try {
            await send((chunk) => writeOut(out, chunk));
            out.end();
          } catch (e) {
            // the client went away, or the query failed after the first rows: the download ends short
            req.log.warn({ err: e }, 'report download stopped');
            out.destroy();
          }
          return { streamed: true };
        }
        return { html: await renderPage(ctx) };
      });
    } catch (e) {
      if (e instanceof Forbidden) return forbidden(ctx, reply, e.message, `page ${ctx.page.page_no}`);
      throw e;
    }
    await saveState(ctx.session);
    if (result.redirect) return reply.redirect(result.redirect, 303);
    logActivity({ appId: ctx.app.id, pageNo: ctx.page.page_no, username: ctx.user, event: 'page_view', ip: ctx.ip, elapsedMs: Math.round(performance.now() - started) });
    if (result.streamed) return reply;
    if (result.file)
      return reply.header('content-disposition', `attachment; filename="${result.name}"`).header('cache-control', 'private, no-store').type(result.type!).send(result.file);
    return reply.type('text/html').send(result.html);
  });

  // ---------------------------------------------------------------- submit page
  app.post('/a/:alias/:page', async (req: Req, reply) => {
    // a page with file items posts multipart/form-data
    let files = new Map<string, Upload[]>();
    if (req.isMultipart()) {
      const parsed = await readMultipart(req);
      req.body = parsed.body as Body;
      files = parsed.lists;
    }
    const ctx = await loadContext(req, reply);
    if (!ctx) return;
    const body = req.body ?? {};
    ctx.body = body;
    ctx.dialog = body.__dialog === '1';
    const self = `${ctx.base}/${ctx.page.page_no}${ctx.dialog ? '?dialog=1' : ''}`;
    if (body.__csrf !== ctx.session.csrf_token)
      return simplePage(reply, 403, ctx.locale.t('error.session_changed_title'), ctx.locale.t('error.session_changed'), self, ctx.locale);
    // Every page form carries a submission id. A form sent again (an offline queue resending after a
    // dropped connection, a double click) is not processed twice in the same session.
    const submitId = typeof body.__submit_id === 'string' && /^[0-9a-f-]{36}$/.test(body.__submit_id) ? body.__submit_id : null;
    const submitted = (ctx.session.state.__SUBMITS ?? '').split(',').filter(Boolean);
    if (submitId && submitted.includes(submitId)) {
      ctx.session.state.__FLASH = ctx.locale.t('pwa.already_sent');
      await saveState(ctx.session);
      return reply.redirect(self, 303);
    }
    const remember = () => {
      if (submitId) ctx.session.state.__SUBMITS = [...submitted, submitId].slice(-50).join(',');
    };
    // the record each form was opened for (signed when the page was rendered; see render.ts formKeys)
    for (const r of ctx.page.regions) {
      if (r.type !== 'form' || !r.pk_item) continue;
      const pk = body[`__pk_${r.id}`];
      const cs = body[`__pkcs_${r.id}`];
      if (typeof pk === 'string' && typeof cs === 'string' && checksumValid(urlChecksum(ctx.app.id, ctx.page.page_no, ctx.user, { [`F${r.id}`]: pk }), cs))
        ctx.session.state[r.pk_item] = pk === '' ? null : pk;
    }

    let messages: string[] = [];
    let button;
    let branchTo: string | null = null;
    let snapshot: Session['state'] = {};
    try {
      button = await appTx(txContext(ctx), async (c) => {
        ctx.client = c;
        await checkPageAccess(ctx);
        await runAppProcesses(ctx, 'before_page');
        // Visibility is decided on the state the page was rendered with,
        // BEFORE the posted values are applied.
        const vis = await computeVisibility(ctx);
        const requested = body.__request ?? '';
        const pressed = requested ? vis.buttons.get(requested) : undefined;
        if (requested && pressed?.action !== 'submit') throw new Forbidden(ctx.locale.t('error.action_unavailable'));
        applyPostedItems(ctx, body);
        await applyUploads(ctx, files, body, txContext);
        if (Object.keys(ctx.errors.items).length) throw new ValidationFailed(ctx.errors);
        if (!pressed) return undefined;
        ctx.request = pressed.name;
        snapshot = { ...ctx.session.state };
        try {
          await runComputations(ctx, 'after_submit');
        } catch (e) {
          if (e instanceof ComputationFailed) throw new ProcessFailed(e.message, null);
          throw e;
        }
        if (ctx.request !== 'DELETE') await validate(ctx);
        messages = await runProcesses(ctx, 'submit');
        // after processing: the first branch that applies; else the button's target page
        branchTo = await branchTarget(ctx, 'after_processing');
        return pressed;
      });
    } catch (e) {
      if (e instanceof Forbidden) return forbidden(ctx, reply, e.message, `forged or unavailable request "${body.__request}" on page ${ctx.page.page_no}`);
      if (e instanceof ValidationFailed) ctx.errors = e.errors;
      else if (e instanceof ProcessFailed) {
        ctx.session.state = { ...snapshot };
        if (e.item) ctx.errors.items[e.item] = e.message;
        else ctx.errors.page.push(e.message);
      } else throw e;
      return renderResponse(ctx, reply, 422);
    }

    // the page's cached regions may show what the submit changed
    invalidatePage(ctx.app.id, ctx.page.page_no);
    // A plain submit (e.g. a select list with submit_on_change) just stores state.
    remember();
    if (!button) {
      await saveState(ctx.session);
      return reply.redirect(self, 303);
    }
    if (messages.length) ctx.session.state.__FLASH = messages.join(' ');
    await saveState(ctx.session);
    if (ctx.dialog) return reply.type('text/html').send(dialogClosePage(ctx));
    return reply.redirect(branchTo ?? (button.target_page ? `${ctx.base}/${button.target_page}` : self), 303);
  });

  // ---------------------------------------------------------------- file downloads
  fileRoutes(app, loadContext, txContext, forbidden);

  // ---------------------------------------------------------------- dynamic actions (AJAX)
  app.post('/a/:alias/:page/da/:id', async (req: Req, reply) => {
    const ctx = await loadContext(req, reply, { json: true });
    if (!ctx) return;
    const body = req.body ?? {};
    if (body.__csrf !== ctx.session.csrf_token) return reply.code(403).send({ error: ctx.locale.t('error.session_reload') });
    ctx.params = new URLSearchParams(body.__url_params ?? '');
    try {
      const result = await appTx(txContext(ctx), async (c) => {
        ctx.client = c;
        await checkPageAccess(ctx);
        let vis = await computeVisibility(ctx);
        const da = ctx.page.dynamic_actions.find((d) => d.id === Number(req.params.id));
        if (!da || !vis.dynamicActions.has(da.id)) throw new Forbidden(ctx.locale.t('error.unknown_da'));
        applyPostedItems(ctx, body, list(da.items_to_submit));
        const out: { items: Record<string, string>; itemsHtml: Record<string, string>; regions: Record<string, string>; css?: string } = { items: {}, itemsHtml: {}, regions: {} };
        const affected = list(da.affected_items).filter((n) => vis.items.has(n));
        switch (da.action) {
          case 'set_value': {
            const sql = stripSemicolon(applyBinds(da.code ?? 'select null', bindValues(ctx)));
            const row = (await savepoint(c, () => c.query({ text: sql, rowMode: 'array' }))).rows[0] ?? [];
            affected.forEach((n, i) => (ctx.session.state[n] = toState(row[i])));
            break;
          }
          case 'execute_sql':
            await savepoint(c, () => runSql(ctx, da.code ?? ''));
            break;
          case 'refresh_region': {
            vis = await computeVisibility(ctx);
            // a refresh shows current data: a cached region is rendered anew (and cached again)
            ctx.cacheRefresh = true;
            const r = ctx.page.regions.find((x) => x.id === da.affected_region_id);
            if (r) out.regions[r.id] = (await renderRegion(ctx, r)).toString();
            out.css = ctx.css.text;
            break;
          }
          case 'refresh_item':
            vis = await computeVisibility(ctx);
            for (const n of affected) out.itemsHtml[n] = (await renderItem(ctx, ctx.page.items.find((i) => i.name === n)!)).toString();
            break;
        }
        for (const n of affected) out.items[n] = ctx.session.state[n] ?? '';
        return out;
      });
      await saveState(ctx.session);
      return reply.send(result);
    } catch (e) {
      if (e instanceof Forbidden) return reply.code(403).send({ error: e.message });
      return reply.code(400).send({ error: await publicError(ctx, e, 'dynamic action') });
    }
  });

  // ---------------------------------------------------------------- lazy regions
  // A region with config.lazy, fetched by app.js once the page shows: the
  // page's query string (report paging, filters) comes along. Page access,
  // the region's condition and authorization are checked as for the page;
  // session state is only read (several regions load at the same time).
  // A detail region (master-detail.ts) is fetched the same way after a row
  // of its master grid was selected: the signed selection in the query
  // string goes into the master's item first (and is kept in the session).
  app.get('/a/:alias/:page/region/:id', async (req: Req, reply) => {
    const ctx = await loadContext(req, reply, { json: true });
    if (!ctx) return;
    ctx.params.delete('cs');
    ctx.dialog = ctx.params.get('dialog') === '1';
    reply.header('cache-control', 'private, no-store');
    let selected = false;
    try {
      const out = await appTx(txContext(ctx), async (c) => {
        ctx.client = c;
        await checkPageAccess(ctx);
        const r = ctx.page.regions.find((x) => x.id === Number(req.params.id));
        const masters = r ? mastersOf(ctx.page, r) : [];
        if (masters.length) selected = applyRowSelection(ctx);
        const vis = await computeVisibility(ctx);
        const detail = masters.some((m) => vis.regions.has(m.id));
        if (!r || !(lazyOf(r) || detail) || !vis.regions.has(r.id)) throw new Forbidden(ctx.locale.t('error.access_denied'));
        ctx.loadNow = r.id;
        const markup = (await renderRegion(ctx, r)).toString();
        return { html: markup, css: ctx.css.text, detached: ctx.detached.map(String).join('') };
      });
      if (selected) await saveState(ctx.session);
      return reply.send(out);
    } catch (e) {
      if (e instanceof Forbidden) return reply.code(403).send({ error: e.message });
      return reply.code(400).send({ error: await publicError(ctx, e, 'region') });
    }
  });

  // ---------------------------------------------------------------- saved reports
  // Actions → Saved reports. Back to the page with the report's parameters.
  const savedReport = async (req: Req, reply: FastifyReply, run: (ctx: PageContext, regionId: number, params: URLSearchParams) => Promise<string>) => {
    const ctx = await loadContext(req, reply);
    if (!ctx) return;
    const body = req.body ?? {};
    if (body.__csrf !== ctx.session.csrf_token) return forbidden(ctx, reply, ctx.locale.t('error.session_reload'), 'saved report: csrf');
    if (ctx.user === 'nobody') return forbidden(ctx, reply, ctx.locale.t('error.access_denied'), 'saved report: not signed in');
    const regionId = Number(req.params.id);
    const region = ctx.page.regions.find((r) => r.id === regionId && (r.type === 'report' || r.type === 'grid'));
    // only the report's own parameters come back
    const params = region ? reportParams(region, new URLSearchParams(body.params ?? '')) : new URLSearchParams();
    try {
      const message = await appTx(txContext(ctx), async (c) => {
        ctx.client = c;
        await checkPageAccess(ctx);
        const vis = await computeVisibility(ctx);
        if (!region || !vis.regions.has(region.id) || region.config.saved_reports === false) throw new Forbidden(ctx.locale.t('error.report_unavailable'));
        return run(ctx, region.id, params);
      });
      ctx.session.state.__FLASH = message;
    } catch (e) {
      if (e instanceof Forbidden) return forbidden(ctx, reply, e.message, `saved report on page ${ctx.page.page_no}`);
      ctx.session.state.__FLASH = await publicError(ctx, e, 'saved report');
    }
    await saveState(ctx.session);
    const q = params.toString();
    return reply.redirect(`${ctx.base}/${ctx.page.page_no}${q ? `?${q}` : ''}`, 303);
  };

  app.post('/a/:alias/:page/report/:id/save', async (req: Req, reply) =>
    savedReport(req, reply, async (ctx, regionId, params) => {
      const t = ctx.locale.t;
      const name = (req.body?.name ?? '').trim().slice(0, 80);
      if (!name) return t('report.name_required');
      const region = ctx.page.regions.find((r) => r.id === regionId)!;
      const pub = req.body?.public === 'true' && typeof region.config.public_reports === 'string' && (await isAuthorized(ctx, region.config.public_reports));
      // a grid report keeps the user's column layout too
      if (region.type === 'grid') params.set(layoutParam(region), layoutJson((await currentLayout(ctx, region)).layout));
      else params.delete(layoutParam(region));
      await ctx.client!.query('select meta.save_report($1, $2, $3, $4)', [regionId, name, params.toString(), pub]);
      return t('report.saved', { name });
    }),
  );

  app.post('/a/:alias/:page/report/:id/saved/:sid/delete', async (req: Req, reply) =>
    savedReport(req, reply, async (ctx) => {
      await ctx.client!.query('select meta.delete_saved_report($1)', [Number(req.params.sid) || 0]);
      return ctx.locale.t('report.saved_deleted');
    }),
  );

  // ---------------------------------------------------------------- grid layout and grid reports
  // Actions → Columns (or app.js after dragging or resizing a column): the
  // user's own column layout of a grid; Reset goes back to the developer's.
  // Applying a saved grid report makes its layout the user's. Any user who
  // can see the grid may arrange it (the public user in the session only).
  const gridAction = async (req: Req, reply: FastifyReply, run: (ctx: PageContext, r: Region, back: URLSearchParams) => Promise<string | null>) => {
    const ctx = await loadContext(req, reply);
    if (!ctx) return;
    const body = req.body ?? {};
    const json = /application\/json/.test(String(req.headers.accept ?? ''));
    const refuse = async (detail: string) => {
      await logActivity({ appId: ctx.app.id, pageNo: ctx.page.page_no, username: ctx.user, event: 'forbidden', ip: ctx.ip, detail });
      return json ? reply.code(403).send({ error: ctx.locale.t('error.access_denied') }) : forbidden(ctx, reply, ctx.locale.t('error.access_denied'), detail);
    };
    if (body.__csrf !== ctx.session.csrf_token)
      return json ? reply.code(403).send({ error: ctx.locale.t('error.session_reload') }) : forbidden(ctx, reply, ctx.locale.t('error.session_reload'), 'grid layout: csrf');
    const r = ctx.page.regions.find((x) => x.id === Number(req.params.id) && x.type === 'grid');
    // back to the page with the reports' and grids' own parameters only
    ctx.params = new URLSearchParams(typeof body.params === 'string' ? body.params.slice(0, 8000) : '');
    const back = statePart(ctx);
    let message: string | null = null;
    try {
      message = await appTx(txContext(ctx), async (c) => {
        ctx.client = c;
        await checkPageAccess(ctx);
        const vis = await computeVisibility(ctx);
        if (!r || !vis.regions.has(r.id) || r.config.actions === false) throw new Forbidden(ctx.locale.t('error.access_denied'));
        return run(ctx, r, back);
      });
    } catch (e) {
      if (e instanceof Forbidden) return refuse(`grid layout: region ${req.params.id} on page ${ctx.page.page_no}`);
      message = await publicError(ctx, e, 'grid layout');
      if (json) return reply.code(400).send({ error: message });
    }
    if (json) {
      await saveState(ctx.session);
      return reply.send({ ok: true });
    }
    if (message) ctx.session.state.__FLASH = message;
    await saveState(ctx.session);
    const q = back.toString();
    return reply.redirect(`${ctx.base}/${ctx.page.page_no}${q ? `?${q}` : ''}`, 303);
  };

  app.post('/a/:alias/:page/grid/:id/layout', async (req: Req, reply) =>
    gridAction(req, reply, async (ctx, r) => {
      const body = req.body ?? {};
      // app.js posts the layout as JSON; the Columns form posts one field per column
      const layout = typeof body.layout === 'string' ? parseLayout(body.layout) : layoutFromForm(body);
      if (!layout) throw new Forbidden('layout');
      await storeLayout(ctx, r, layout);
      return null;
    }),
  );

  app.post('/a/:alias/:page/grid/:id/layout/reset', async (req: Req, reply) =>
    gridAction(req, reply, async (ctx, r, back) => {
      await storeLayout(ctx, r, null);
      for (const k of [...back.keys()]) if (k.startsWith(`r${r.id}_`)) back.delete(k);
      return null;
    }),
  );

  app.post('/a/:alias/:page/grid/:id/saved/:sid/apply', async (req: Req, reply) =>
    gridAction(req, reply, async (ctx, r, back) => {
      const c = ctx.client!;
      // own or public reports of this grid only (the view shows no one else's)
      const row = (
        await c.query<{ params: string }>(`select params from meta.saved_reports where id = $1 and region_id = $2 and kind = 'report'`, [Number(req.params.sid) || 0, r.id])
      ).rows[0];
      if (!row) throw new Forbidden('saved report');
      const saved = new URLSearchParams(row.params);
      await storeLayout(ctx, r, parseLayout(saved.get(layoutParam(r))));
      for (const k of [...back.keys()]) if (k.startsWith(`r${r.id}_`)) back.delete(k);
      for (const [k, v] of saved) if (k.startsWith(`r${r.id}_`) && k !== layoutParam(r) && !/_(p|dup|sel|selcs)$/.test(k)) back.append(k, v);
      return null;
    }),
  );

  // Cascading list of values: re-render a select after its parent changed.
  app.post('/a/:alias/:page/lov/:item', async (req: Req, reply) => {
    const ctx = await loadContext(req, reply, { json: true });
    if (!ctx) return;
    const body = req.body ?? {};
    if (body.__csrf !== ctx.session.csrf_token) return reply.code(403).send({ error: ctx.locale.t('error.session_reload') });
    try {
      const out = await appTx(txContext(ctx), async (c) => {
        ctx.client = c;
        await checkPageAccess(ctx);
        const vis = await computeVisibility(ctx);
        const item = ctx.page.items.find((i) => i.name === req.params.item && i.config?.cascade_parents);
        if (!item || !vis.editable.has(item.name)) throw new Forbidden(ctx.locale.t('error.unknown_item'));
        applyPostedItems(ctx, body, list(item.config.cascade_parents));
        ctx.session.state[item.name] = null; // the old value may not be in the new list
        return { html: (await renderItem(ctx, item)).toString() };
      });
      await saveState(ctx.session);
      return reply.send(out);
    } catch (e) {
      if (e instanceof Forbidden) return reply.code(403).send({ error: e.message });
      return reply.code(400).send({ error: await publicError(ctx, e, 'list of values') });
    }
  });

  // Popup LOV search: one page of the item's own list of values, matched on the
  // server. Page access and the item's condition and authorization are checked
  // as for the page; a cascading LOV reads its parents' posted values (not saved).
  app.post('/a/:alias/:page/lov/:item/search', async (req: Req, reply) => {
    const ctx = await loadContext(req, reply, { json: true });
    if (!ctx) return;
    const body = req.body ?? {};
    if (body.__csrf !== ctx.session.csrf_token) return reply.code(403).send({ error: ctx.locale.t('error.session_reload') });
    reply.header('cache-control', 'private, no-store');
    try {
      const out = await appTx(txContext(ctx), async (c) => {
        ctx.client = c;
        await checkPageAccess(ctx);
        const vis = await computeVisibility(ctx);
        const item = ctx.page.items.find((i) => i.name === req.params.item && i.type === 'popup_lov');
        if (!item || !vis.editable.has(item.name)) throw new Forbidden(ctx.locale.t('error.unknown_item'));
        if (item.config?.cascade_parents) applyPostedItems(ctx, body, list(item.config.cascade_parents));
        const page = Math.min(Math.max(Math.floor(Number(body.p)) || 0, 0), 10_000);
        return searchLov(ctx, item, String(body.q ?? '').slice(0, 200), page, popupPageSize(item, body.n));
      });
      return reply.send(out);
    } catch (e) {
      if (e instanceof Forbidden) return reply.code(403).send({ error: e.message });
      return reply.code(400).send({ error: await publicError(ctx, e, 'list of values') });
    }
  });

  // Calendar drag and drop (calendar.ts): move an event, answer with the re-rendered region.
  app.post('/a/:alias/:page/calendar/:id/move', async (req: Req, reply) => {
    const ctx = await loadContext(req, reply, { json: true });
    if (!ctx) return;
    const body = req.body ?? {};
    if (body.__csrf !== ctx.session.csrf_token) return reply.code(403).send({ error: ctx.locale.t('error.session_reload') });
    ctx.params = new URLSearchParams(typeof body.__url_params === 'string' ? body.__url_params : '');
    const key = typeof body.key === 'string' ? body.key : '';
    const to = typeof body.to === 'string' ? body.to : '';
    try {
      const out = await appTx(txContext(ctx), async (c) => {
        ctx.client = c;
        await checkPageAccess(ctx);
        const vis = await computeVisibility(ctx);
        const r = ctx.page.regions.find((x) => x.id === Number(req.params.id) && x.type === 'calendar');
        if (!r || !vis.regions.has(r.id) || !key || key.length > 200) throw new Forbidden(ctx.locale.t('calendar.cannot_move'));
        const moved = await moveCalendarEvent(ctx, r, key, to);
        await computeVisibility(ctx);
        return {
          region: (await renderRegion(ctx, r)).toString(),
          css: ctx.css.text,
          message: ctx.locale.t('calendar.moved', { title: moved.title, date: moved.start }),
        };
      });
      await saveState(ctx.session);
      await logActivity({ appId: ctx.app.id, pageNo: ctx.page.page_no, username: ctx.user, event: 'calendar_move', ip: ctx.ip, detail: `region ${req.params.id}, key ${key} to ${to}` });
      return reply.send(out);
    } catch (e) {
      if (e instanceof Forbidden) {
        await logActivity({ appId: ctx.app.id, pageNo: ctx.page.page_no, username: ctx.user, event: 'forbidden', ip: ctx.ip, detail: `calendar move: region ${req.params.id}` });
        return reply.code(403).send({ error: e.message });
      }
      if (e instanceof RangeError) return reply.code(400).send({ error: e.message });
      return reply.code(400).send({ error: await publicError(ctx, e, 'calendar move') });
    }
  });

  // ---------------------------------------------------------------- login / logout
  const loginPage = async (app: App, locale: Locale, session: Session, next: string, error?: string) => {
    const t = locale.t;
    // database accounts: the role name and password form only
    const dbAuth = app.authentication === 'database';
    if (dbAuth) app = { ...app, local_login: true, remember_me_days: null };
    const providers = dbAuth ? [] : await enabledProviders(app.sso_providers ?? []);
    const nextQs = next ? `?next=${encodeURIComponent(next)}` : '';
    return documentShell(
      `${t('login.title')} · ${app.name}`,
      html`<main class="login">
        <div class="card login-card">
          <h1>${app.name}</h1>
          ${error ? html`<div class="alert alert-error" role="alert">${error}</div>` : ''}
          ${((f) => (f ? html`<div class="alert alert-success" role="status">${f}</div>` : ''))(takeFlash(session))}
          ${providers.length
            ? html`<div class="sso-buttons">${providers.map(
                (pr) => html`<a class="btn${app.local_login ? '' : ' btn-hot'}" href="/a/${app.alias}/sso/${pr.name}${nextQs}">${t('login.with', { provider: pr.display_name })}</a>`,
              )}</div>${app.local_login ? html`<div class="or" role="separator"><span>${t('login.or')}</span></div>` : ''}`
            : ''}
          ${app.local_login
            ? html`<form method="post" class="login-form">
                <input type="hidden" name="__csrf" value="${session.csrf_token}">
                <input type="hidden" name="next" value="${next}">
                <div class="field"><label class="label" for="username">${t('login.username')}</label><input id="username" name="username" autocomplete="username" autofocus required maxlength="100"></div>
                <div class="field"><label class="label" for="password">${t('login.password')}</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="200"></div>
                ${app.remember_me_days ? html`<label class="check"><input type="checkbox" name="remember" value="true"> ${t('login.remember', { days: app.remember_me_days })}</label>` : ''}
                <button class="btn btn-hot">${t('login.submit')}</button>
              </form>`
            : providers.length ? '' : html`<p>${t('login.none')}</p>`}
          ${languagePicker(app, locale, `/a/${app.alias}/login${nextQs}`)}
        </div>
      </main>`,
      'login-body',
      {},
      pwaHead(app),
      rootAttrs(locale),
    );
  };

  /** Change an expired password (or one that must change at first use) before signing in. */
  const expiredPage = (app: App, locale: Locale, session: Session, username: string, next: string, error?: string) => {
    const t = locale.t;
    return documentShell(
      `${t('password.expired.title')} · ${app.name}`,
      html`<main class="login">
        <div class="card login-card">
          <h1>${t('password.expired.title')}</h1>
          ${error ? html`<div class="alert alert-error" role="alert">${error}</div>` : html`<p class="muted">${t('password.expired.text')}</p>`}
          <form method="post" action="/a/${app.alias}/password" class="login-form">
            <input type="hidden" name="__csrf" value="${session.csrf_token}">
            <input type="hidden" name="next" value="${next}">
            <div class="field"><label class="label" for="username">${t('login.username')}</label><input id="username" name="username" value="${username}" autocomplete="username" readonly></div>
            <div class="field"><label class="label" for="password">${t('password.current')}</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="200" autofocus></div>
            <div class="field"><label class="label" for="new_password">${t('password.new')}</label><input id="new_password" name="new_password" type="password" autocomplete="new-password" required maxlength="200"></div>
            <div class="field"><label class="label" for="confirm_password">${t('password.confirm')}</label><input id="confirm_password" name="confirm_password" type="password" autocomplete="new-password" required maxlength="200"></div>
            <button class="btn btn-hot">${t('password.change')}</button>
          </form>
        </div>
      </main>`,
      'login-body',
      {},
      '',
      rootAttrs(locale),
    );
  };

  /** Common start of the sign-in POST handlers: app, session, CSRF, throttling. */
  const loginRequest = async (req: Req, reply: FastifyReply) => {
    const loaded = await appWithLocale(req, req.params.alias);
    if (!loaded) return simplePage(reply, 404, english('error.not_found'), english('error.app_not_found', { app: req.params.alias })), null;
    const { app: a, locale } = loaded;
    const session = await getSession(req, reply, a.id, `/a/${a.alias}`);
    const { username = '', next } = req.body ?? {};
    const ip = clientIp(req);
    const fail = async (msg: string, code = 401) => reply.code(code).type('text/html').send(await loginPage(a, locale, session, safeNext(a, next), msg));
    if (req.body?.__csrf !== session.csrf_token) return fail(locale.t('login.expired_session'), 403), null;
    if (a.authentication === 'header') return fail(locale.t('login.method_unavailable'), 403), null;
    if (!a.local_login && a.authentication !== 'database') return fail(locale.t('login.password_disabled'), 403), null;
    // a NUL byte can't be a user name (and PostgreSQL text refuses it)
    if (username.includes('\0')) return fail(locale.t('login.invalid'), 400), null;
    if (await loginThrottled(a.id, username, ip)) {
      logActivity({ appId: a.id, username, event: 'login_locked', ip });
      return fail(locale.t('login.throttled', { minutes: LOGIN_WINDOW_MINUTES }), 429), null;
    }
    return { a, locale, session, username: username.slice(0, 100), next, ip, fail };
  };

  app.get<{ Params: Params; Querystring: { next?: string } }>('/a/:alias/login', async (req, reply) => {
    const a0 = await loadApp(req.params.alias);
    if (!a0) return simplePage(reply, 404, english('error.not_found'), english('error.app_not_found', { app: req.params.alias }));
    if (a0.authentication === 'none') return reply.redirect(`/a/${a0.alias}`);
    // header authentication has no sign-in form: the proxy signs the user in on any page
    if (a0.authentication === 'header') return reply.redirect(safeNext(a0, req.query.next));
    const session = await getSession(req, reply, a0.id, `/a/${a0.alias}`);
    const { app: a, locale } = (await appWithLocale(req, req.params.alias, session))!;
    const body = await loginPage(a, locale, session, safeNext(a, req.query.next));
    await saveState(session);
    return reply.type('text/html').send(body);
  });

  app.post('/a/:alias/login', async (req: Req, reply) => {
    const r0 = await loginRequest(req, reply);
    if (!r0) return;
    const { a, locale, session, username, next, ip, fail } = r0;
    const password = (req.body?.password ?? '').slice(0, 200);
    const remember = req.body?.remember === 'true';
    if (a.authentication === 'database') {
      // database accounts: a connection attempt as the role checks the password (never logged)
      const r = await dbAuthenticate(a, username, password);
      if (!r.ok) {
        await logActivity({ appId: a.id, username, event: 'login_failed', ip, detail: `database: ${r.detail}` });
        return fail(r.reason === 'unavailable' ? locale.t('login.db_unavailable') : locale.t('login.invalid'), r.reason === 'unavailable' ? 503 : 401);
      }
      return completeLogin(req, reply, a, session, r.role, { next, method: 'database', detail: 'database' });
    }
    const r = await runtime.one<{ username: string | null }>('select meta.authenticate($1, $2, $3) as username', [a.id, username, password]);
    if (!r?.username) {
      // not a local password: the app's LDAP directories, in order
      let unreachable = false;
      for (const d of await appDirectories(a.ldap_directories)) {
        let user;
        try {
          user = await ldapAuthenticate(d, username, password);
        } catch (e) {
          req.log.warn({ err: e, directory: d.name }, 'ldap sign-in failed');
          unreachable = true;
          continue;
        }
        if (!user) continue;
        let account: string;
        try {
          account = await resolveLdapAccount(d, user);
        } catch (e) {
          if (!(e instanceof LdapError)) throw e;
          logActivity({ appId: a.id, username, event: 'login_failed', ip, detail: `ldap:${d.name}: ${e.message}` });
          return fail(e.message, 403);
        }
        const access = await ssoAccess(a.id, account, user.groups);
        if (!access.allowed) {
          logActivity({ appId: a.id, username: account, event: 'login_failed', ip, detail: `ldap:${d.name}: no access` });
          return fail(locale.t('login.no_access', { user: account, app: a.name }), 403);
        }
        return completeLogin(req, reply, a, session, account, {
          next, remember, extraRoles: access.roles, groups: user.groups, method: `ldap:${d.name}`, detail: `ldap:${d.name}`,
        });
      }
      await logActivity({ appId: a.id, username, event: 'login_failed', ip, detail: unreachable ? 'ldap unreachable' : undefined });
      return fail(unreachable ? locale.t('login.ldap_unavailable') : locale.t('login.invalid'));
    }
    if ((await passwordDaysLeft(r.username)) === 0) {
      logActivity({ appId: a.id, username: r.username, event: 'password_expired', ip });
      return reply.type('text/html').send(expiredPage(a, locale, session, r.username, safeNext(a, next)));
    }
    return completeLogin(req, reply, a, session, r.username, { next, remember });
  });

  app.post('/a/:alias/password', async (req: Req, reply) => {
    const r0 = await loginRequest(req, reply);
    if (!r0) return;
    const { a, locale, session, username, next, ip } = r0;
    if (a.authentication === 'database') return reply.code(403).type('text/html').send(await loginPage(a, locale, session, safeNext(a, next), locale.t('login.method_unavailable')));
    const b = req.body ?? {};
    const again = (msg: string, code = 422) => reply.code(code).type('text/html').send(expiredPage(a, locale, session, username, safeNext(a, next), msg));
    if (b.new_password !== b.confirm_password) return again(locale.t('password.mismatch'));
    const problem = await passwordProblem(b.new_password, { username, t: locale.t });
    if (problem) return again(problem);
    let ok = false;
    try {
      ok = !!(await runtime.one('select meta.change_password($1, $2, $3, $4) as ok', [a.id, username, (b.password ?? '').slice(0, 200), b.new_password]))?.ok;
    } catch (e) {
      if ((e as { code?: string }).code === 'P0001') return again(locale.t('password.same_as_old'));
      throw e;
    }
    if (!ok) {
      await logActivity({ appId: a.id, username, event: 'login_failed', ip, detail: 'password change' });
      return again(locale.t('password.wrong_current'), 401);
    }
    logActivity({ appId: a.id, username, event: 'password_changed', ip });
    const canonical = (await runtime.one<{ username: string }>('select username from meta.account where lower(username) = lower($1)', [username]))!.username;
    return completeLogin(req, reply, a, session, canonical, { next });
  });

  // ---------------------------------------------------------------- single sign-on (OpenID Connect)
  const SSO_COOKIE = 'pgapex_sso';

  app.get<{ Params: { alias: string; provider: string }; Querystring: { next?: string } }>('/a/:alias/sso/:provider', async (req, reply) => {
    const loaded = await appWithLocale(req, req.params.alias);
    if (!loaded) return simplePage(reply, 404, english('error.not_found'), english('error.app_not_found', { app: req.params.alias }));
    const { app: a, locale } = loaded;
    const p = a.authentication === 'app_users' && a.sso_providers.includes(req.params.provider) ? await loadProvider(req.params.provider) : undefined;
    if (!p) return simplePage(reply, 404, locale.t('error.not_found'), locale.t('login.method_unavailable'), `/a/${a.alias}/login`, locale);
    try {
      const { url, browserKey } = p.protocol === 'saml' ? await startSamlSignIn(p, a.id, safeNext(a, req.query.next)) : await startSignIn(p, a.id, safeNext(a, req.query.next));
      reply.setCookie(SSO_COOKIE, browserKey, { path: '/sso', httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true', maxAge: 600 });
      return reply.redirect(url);
    } catch (e) {
      req.log.warn({ err: e }, 'sso start failed');
      return simplePage(reply, 502, locale.t('login.unavailable_title'), locale.t('login.sso_unavailable', { provider: p.display_name }), `/a/${a.alias}/login`, locale);
    }
  });

  app.get<{ Params: { provider: string } }>('/sso/callback/:provider', async (req, reply) => {
    const ip = clientIp(req);
    const p = await loadProvider(req.params.provider);
    if (!p || p.protocol !== 'oidc') return simplePage(reply, 404, english('error.not_found'), english('login.unknown_provider'));
    const browserKey = req.cookies[SSO_COOKIE];
    reply.clearCookie(SSO_COOKIE, { path: '/sso' });
    let result;
    try {
      result = await finishSignIn(p, new URLSearchParams(req.url.split('?')[1] ?? ''), browserKey);
    } catch (e) {
      const msg = e instanceof SsoError ? e.message : english('login.sso_incomplete');
      if (!(e instanceof SsoError)) req.log.warn({ err: e }, 'sso callback failed');
      logActivity({ event: 'login_failed', ip, detail: `sso:${p.name}: ${msg}` });
      return simplePage(reply, 403, english('login.sso_failed'), msg);
    }
    return finishSso(req, reply, p, result, ip);
  });

  /** The end of a single sign-on (OpenID Connect or SAML): the app's access rules, then the session. */
  const finishSso = async (req: FastifyRequest, reply: FastifyReply, p: { name: string }, result: SsoResult, ip: string) => {
    const alias = (await runtime.one<{ alias: string }>('select alias from meta.app where id = $1', [result.appId]))?.alias;
    const loaded = alias ? await appWithLocale(req, alias) : undefined;
    if (!loaded || loaded.app.authentication !== 'app_users' || !loaded.app.sso_providers.includes(p.name)) return simplePage(reply, 403, english('login.sso_failed'), english('login.method_unavailable'));
    const { app: a, locale } = loaded;
    const access = await ssoAccess(a.id, result.username, result.groups);
    if (!access.allowed) {
      logActivity({ appId: a.id, username: result.username, event: 'login_failed', ip, detail: `sso:${p.name}: no access` });
      return simplePage(reply, 403, locale.t('login.no_access_title'), locale.t('login.no_access', { user: result.username, app: a.name }), `/a/${a.alias}/login`, locale);
    }
    const session = await getSession(req, reply, a.id, `/a/${a.alias}`);
    return completeLogin(req, reply, a, session, result.username, { extraRoles: access.roles, next: result.next ?? undefined, detail: `sso:${p.name}` });
  };

  // SAML: the IdP posts the response cross-site, where SameSite=Lax cookies aren't sent; post it on
  // (same-site) so the browser-binding cookie comes along. app.js submits the form at once.
  app.post<{ Params: { provider: string } }>('/sso/saml/:provider', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, string>;
    return reply.type('text/html').send(
      documentShell(english('login.sso_continue'), html`<main class="login"><div class="login-card">
        <form method="post" action="/sso/saml/${req.params.provider}/finish" data-autosubmit>
          <input type="hidden" name="SAMLResponse" value="${String(b.SAMLResponse ?? '').slice(0, 500_000)}">
          <input type="hidden" name="RelayState" value="${String(b.RelayState ?? '').slice(0, 200)}">
          <p>${english('login.sso_continue')}</p>
          <button class="btn btn-hot">${english('dialog.continue')}</button>
        </form></div></main>`, 'login-body'),
    );
  });

  app.post<{ Params: { provider: string } }>('/sso/saml/:provider/finish', async (req, reply) => {
    const ip = clientIp(req);
    const p = await loadProvider(req.params.provider);
    if (!p || p.protocol !== 'saml') return simplePage(reply, 404, english('error.not_found'), english('login.unknown_provider'));
    const browserKey = req.cookies[SSO_COOKIE];
    reply.clearCookie(SSO_COOKIE, { path: '/sso' });
    let result;
    try {
      result = await finishSamlSignIn(p, (req.body ?? {}) as Record<string, string>, browserKey);
    } catch (e) {
      const msg = e instanceof SsoError ? e.message : english('login.sso_incomplete');
      if (!(e instanceof SsoError)) req.log.warn({ err: e }, 'saml sign-in failed');
      logActivity({ event: 'login_failed', ip, detail: `saml:${p.name}: ${msg}` });
      return simplePage(reply, 403, english('login.sso_failed'), msg);
    }
    return finishSso(req, reply, p, result, ip);
  });

  app.get<{ Params: { provider: string } }>('/sso/saml/:provider/metadata', async (req, reply) => {
    const p = await loadProvider(req.params.provider);
    if (!p || p.protocol !== 'saml') return simplePage(reply, 404, english('error.not_found'), english('login.unknown_provider'));
    return reply.type('application/samlmetadata+xml').send(samlMetadata(p));
  });

  // Sign-out is a POST with a CSRF token (a GET could be triggered by any site).
  app.post('/a/:alias/logout', async (req: Req, reply) => {
    const a = await loadApp(req.params.alias);
    if (!a) return simplePage(reply, 404, english('error.not_found'), english('error.app_not_found', { app: req.params.alias }));
    const base = `/a/${a.alias}`;
    const session = await getSession(req, reply, a.id, base);
    if (req.body?.__csrf !== session.csrf_token) return reply.redirect(`${base}/${a.home_page}`, 303);
    if (session.username) logActivity({ appId: a.id, username: session.username, event: 'logout', ip: clientIp(req) });
    await forgetRemember(req, reply, a);
    await destroySession(reply, session, base);
    if (a.authentication === 'header') {
      // the proxy would sign the user in again at once: go to its sign-out page, if any
      if (a.logout_url) return reply.redirect(a.logout_url, 303);
      const loaded = await appWithLocale(req, a.alias);
      return simplePage(reply, 200, loaded?.locale.t('login.sign_out') ?? 'Sign out', loaded?.locale.t('login.signed_out') ?? 'You are signed out.', undefined, loaded?.locale);
    }
    return reply.redirect(`${base}/login`, 303);
  });
}

