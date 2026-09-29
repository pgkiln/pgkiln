import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { applyBinds } from '../binds.ts';
import { appTx, runtime, savepoint } from '../db.ts';
import { html } from '../html.ts';
import { documentShell } from '../layout.ts';
import { accountRoles, loadApp, loadPage, type App, type Page } from '../metadata.ts';
import { checksumValid, LOGIN_WINDOW_MINUTES, urlChecksum } from '../security.ts';
import { enabledProviders, finishSignIn, loadProvider, ssoAccess, SsoError, startSignIn } from '../sso.ts';
import { clientIp, createSession, destroySession, getSession, loginThrottled, logActivity, saveState, takeFlash, type Session } from '../session.ts';
import { checkPageAccess, computeVisibility, Forbidden } from './authz.ts';
import { bindValues, publicError, stripSemicolon, toState, type PageContext } from './context.ts';
import { clearPageItems, fetchForms, ProcessFailed, runAppProcesses, runProcesses, runSql, validate, ValidationFailed } from './engine.ts';
import { MULTI_VALUE, renderItem } from './items.ts';
import { renderRegion } from './regions.ts';
import { reportCsv, normaliseReportParams } from './report.ts';
import { chrome, dialogClosePage, renderPage } from './render.ts';

type Params = { alias: string; page?: string; id?: string; item?: string };
type Body = Record<string, string | undefined>;
type Req = FastifyRequest<{ Params: Params; Body: Body }>;

const list = (s: string | null | undefined) => (s ?? '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);

function simplePage(reply: FastifyReply, code: number, title: string, message: string, back?: string) {
  return reply
    .code(code)
    .type('text/html')
    .send(
      documentShell(
        title,
        html`<main class="t-error"><div class="card"><h1>${title}</h1><p>${message}</p>${back ? html`<p><a class="btn" href="${back}">Go back</a></p>` : ''}</div></main>`,
        'login-body',
      ),
    );
}

export const safeNext = (app: App, next: string | undefined) =>
  next && next.startsWith(`/a/${app.alias}/`) && !/[\\\r\n]/.test(next) && !next.includes('//') ? next : `/a/${app.alias}/${app.home_page}`;

/**
 * Finish a successful sign-in (password or SSO): replace the session (no
 * session fixation), resolve the user's roles for this app (plus roles from
 * identity-provider groups), log it and run the "after login" processes.
 */
export async function completeLogin(
  req: FastifyRequest,
  reply: FastifyReply,
  a: App,
  oldSession: Session,
  username: string,
  { extraRoles = [], next, detail }: { extraRoles?: string[]; next?: string; detail?: string } = {},
) {
  const base = `/a/${a.alias}`;
  const roles = [...new Set([...(await accountRoles(a.id, username)), ...extraRoles.map((r) => r.toLowerCase())])].sort();
  await destroySession(reply, oldSession, base);
  const s = await createSession(reply, a.id, base, username, roles);
  logActivity({ appId: a.id, username, event: 'login', ip: clientIp(req), detail });

  if (a.app_processes.some((p) => p.point === 'after_login')) {
    const home = (await loadPage(a.id, a.home_page)) ?? ({ page_no: a.home_page, items: [], regions: [], buttons: [], dynamic_actions: [], validations: [], processes: [] } as unknown as Page);
    const ctx: PageContext = {
      app: a, page: home, session: s, base, params: new URLSearchParams(), request: '', user: username,
      roles, ip: clientIp(req), errors: { page: [], items: {} }, messages: [],
      dialog: false, authzCache: new Map(), detached: [],
    };
    await appTx(txContext(ctx), async (c) => {
      ctx.client = c;
      await runAppProcesses(ctx, 'after_login');
    });
    await saveState(s);
  }
  return reply.redirect(safeNext(a, next), 303);
}

const txContext = (ctx: PageContext) => ({
  appId: ctx.app.id,
  alias: ctx.app.alias,
  dbRole: ctx.app.db_role,
  appUser: ctx.user,
  sessionId: ctx.session.id,
});

/** Load app, page, session and user; handles 404 and the login redirect. */
async function loadContext(req: Req, reply: FastifyReply, { json = false } = {}): Promise<PageContext | null> {
  const app = await loadApp(req.params.alias);
  if (!app) return simplePage(reply, 404, 'Not found', `Application "${req.params.alias}" does not exist.`), null;
  const base = `/a/${app.alias}`;
  const pageNo = Number(req.params.page);
  const page = Number.isInteger(pageNo) && pageNo > 0 ? await loadPage(app.id, pageNo) : undefined;
  if (!page) return simplePage(reply, 404, 'Not found', `Page ${req.params.page} does not exist in ${app.name}.`, base), null;
  const session = await getSession(req, reply, app.id, base);
  const user = app.authentication === 'none' ? 'nobody' : (session.username ?? 'nobody');

  if (app.authentication !== 'none' && page.requires_auth && !session.username) {
    if (json) reply.code(401).send({ error: 'Your session has ended. Please sign in again.' });
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
  };
}

async function forbidden(ctx: PageContext, reply: FastifyReply, message: string, detail: string) {
  logActivity({ appId: ctx.app.id, pageNo: ctx.page.page_no, username: ctx.user, event: 'forbidden', ip: ctx.ip, detail });
  const main = html`<div class="t-titlebar"><h1>Access denied</h1></div>
    <div class="t-content"><div class="alert alert-error" role="alert">${message}</div>
    <p><a class="btn" href="${ctx.base}/${ctx.app.home_page}">Go to the home page</a></p></div>`;
  ctx.vis = { regions: new Set(), items: new Set(), editable: new Set(), buttons: new Map(), dynamicActions: new Set() };
  const body = await appTx(txContext(ctx), async (c) => {
    ctx.client = c;
    return chrome(ctx, main, 'Access denied');
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
  for (const item of ctx.page.items) {
    if (!ctx.vis!.editable.has(item.name)) continue;
    if (only && !only.includes(item.name)) continue;
    const raw = body[item.name] as string | string[] | undefined;
    if (MULTI_VALUE.has(item.type)) {
      const values = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((v) => v !== '');
      ctx.session.state[item.name] = values.length ? values.join(':') : null;
      continue;
    }
    const posted = Array.isArray(raw) ? raw[raw.length - 1] : raw;
    if (item.type === 'checkbox' || item.type === 'switch') ctx.session.state[item.name] = posted === 'true' ? 'true' : 'false';
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
    if (!a) return simplePage(reply, 404, 'Not found', `Application "${req.params.alias}" does not exist.`);
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

    if (!applyUrlItems(ctx)) return forbidden(ctx, reply, 'This link is invalid or has been tampered with (checksum error).', `checksum error: ${req.url}`);
    const flash = takeFlash(ctx.session);
    if (flash) ctx.messages.push(flash);
    const csvKey = [...ctx.params.keys()].find((k) => /^r\d+_csv$/.test(k));

    let result: { html?: string; csv?: string; name?: string };
    try {
      result = await appTx(txContext(ctx), async (c) => {
        ctx.client = c;
        await checkPageAccess(ctx);
        await runAppProcesses(ctx, 'before_page');
        await fetchForms(ctx);
        try {
          await runProcesses(ctx, 'load');
        } catch (e) {
          ctx.errors.page.push((e as Error).message);
        }
        await computeVisibility(ctx);
        if (csvKey) {
          const region = ctx.page.regions.find((r) => `r${r.id}_csv` === csvKey && r.type === 'report' && ctx.vis!.regions.has(r.id));
          if (!region) throw new Forbidden('That report is not available.');
          return { csv: await reportCsv(ctx, region), name: `${(region.title ?? 'report').replace(/[^\w-]+/g, '_')}.csv` };
        }
        return { html: await renderPage(ctx) };
      });
    } catch (e) {
      if (e instanceof Forbidden) return forbidden(ctx, reply, e.message, `page ${ctx.page.page_no}`);
      throw e;
    }
    await saveState(ctx.session);
    logActivity({ appId: ctx.app.id, pageNo: ctx.page.page_no, username: ctx.user, event: 'page_view', ip: ctx.ip, elapsedMs: Math.round(performance.now() - started) });
    if (result.csv !== undefined)
      return reply.header('content-disposition', `attachment; filename="${result.name}"`).type('text/csv; charset=utf-8').send(result.csv);
    return reply.type('text/html').send(result.html);
  });

  // ---------------------------------------------------------------- submit page
  app.post('/a/:alias/:page', async (req: Req, reply) => {
    const ctx = await loadContext(req, reply);
    if (!ctx) return;
    const body = req.body ?? {};
    ctx.body = body;
    ctx.dialog = body.__dialog === '1';
    const self = `${ctx.base}/${ctx.page.page_no}${ctx.dialog ? '?dialog=1' : ''}`;
    if (body.__csrf !== ctx.session.csrf_token)
      return simplePage(reply, 403, 'Session expired', 'Your session changed or expired. Reload the page and try again.', self);

    let messages: string[] = [];
    let button;
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
        if (requested && pressed?.action !== 'submit') throw new Forbidden('That action is not available to you.');
        applyPostedItems(ctx, body);
        if (!pressed) return undefined;
        ctx.request = pressed.name;
        snapshot = { ...ctx.session.state };
        if (ctx.request !== 'DELETE') await validate(ctx);
        messages = await runProcesses(ctx, 'submit');
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

    // A plain submit (e.g. a select list with submit_on_change) just stores state.
    if (!button) {
      await saveState(ctx.session);
      return reply.redirect(self, 303);
    }
    if (messages.length) ctx.session.state.__FLASH = messages.join(' ');
    await saveState(ctx.session);
    if (ctx.dialog) return reply.type('text/html').send(dialogClosePage(ctx));
    return reply.redirect(button.target_page ? `${ctx.base}/${button.target_page}` : self, 303);
  });

  // ---------------------------------------------------------------- dynamic actions (AJAX)
  app.post('/a/:alias/:page/da/:id', async (req: Req, reply) => {
    const ctx = await loadContext(req, reply, { json: true });
    if (!ctx) return;
    const body = req.body ?? {};
    if (body.__csrf !== ctx.session.csrf_token) return reply.code(403).send({ error: 'Session expired; reload the page.' });
    ctx.params = new URLSearchParams(body.__url_params ?? '');
    try {
      const result = await appTx(txContext(ctx), async (c) => {
        ctx.client = c;
        await checkPageAccess(ctx);
        let vis = await computeVisibility(ctx);
        const da = ctx.page.dynamic_actions.find((d) => d.id === Number(req.params.id));
        if (!da || !vis.dynamicActions.has(da.id)) throw new Forbidden('Unknown dynamic action.');
        applyPostedItems(ctx, body, list(da.items_to_submit));
        const out: { items: Record<string, string>; itemsHtml: Record<string, string>; regions: Record<string, string> } = { items: {}, itemsHtml: {}, regions: {} };
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
            const r = ctx.page.regions.find((x) => x.id === da.affected_region_id);
            if (r) out.regions[r.id] = (await renderRegion(ctx, r)).toString();
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

  // Cascading list of values: re-render a select after its parent changed.
  app.post('/a/:alias/:page/lov/:item', async (req: Req, reply) => {
    const ctx = await loadContext(req, reply, { json: true });
    if (!ctx) return;
    const body = req.body ?? {};
    if (body.__csrf !== ctx.session.csrf_token) return reply.code(403).send({ error: 'Session expired; reload the page.' });
    try {
      const out = await appTx(txContext(ctx), async (c) => {
        ctx.client = c;
        await checkPageAccess(ctx);
        const vis = await computeVisibility(ctx);
        const item = ctx.page.items.find((i) => i.name === req.params.item && i.config?.cascade_parents);
        if (!item || !vis.editable.has(item.name)) throw new Forbidden('Unknown item.');
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

  // ---------------------------------------------------------------- login / logout
  const loginPage = async (app: App, session: Session, next: string, error?: string) => {
    const providers = await enabledProviders(app.sso_providers ?? []);
    const nextQs = next ? `?next=${encodeURIComponent(next)}` : '';
    return documentShell(
      `Sign in · ${app.name}`,
      html`<main class="login">
        <div class="card login-card">
          <h1>${app.name}</h1>
          ${error ? html`<div class="alert alert-error" role="alert">${error}</div>` : ''}
          ${providers.length
            ? html`<div class="sso-buttons">${providers.map(
                (pr) => html`<a class="btn${app.local_login ? '' : ' btn-hot'}" href="/a/${app.alias}/sso/${pr.name}${nextQs}">Sign in with ${pr.display_name}</a>`,
              )}</div>${app.local_login ? html`<div class="or" role="separator"><span>or</span></div>` : ''}`
            : ''}
          ${app.local_login
            ? html`<form method="post" class="login-form">
                <input type="hidden" name="__csrf" value="${session.csrf_token}">
                <input type="hidden" name="next" value="${next}">
                <div class="field"><label class="label" for="username">Username</label><input id="username" name="username" autocomplete="username" autofocus required maxlength="100"></div>
                <div class="field"><label class="label" for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="200"></div>
                <button class="btn btn-hot">Sign in</button>
              </form>`
            : providers.length ? '' : html`<p>No sign-in method is configured for this application.</p>`}
        </div>
      </main>`,
      'login-body',
    );
  };

  app.get<{ Params: Params; Querystring: { next?: string } }>('/a/:alias/login', async (req, reply) => {
    const a = await loadApp(req.params.alias);
    if (!a) return simplePage(reply, 404, 'Not found', `Application "${req.params.alias}" does not exist.`);
    if (a.authentication === 'none') return reply.redirect(`/a/${a.alias}`);
    const session = await getSession(req, reply, a.id, `/a/${a.alias}`);
    return reply.type('text/html').send(await loginPage(a, session, safeNext(a, req.query.next)));
  });

  app.post('/a/:alias/login', async (req: Req, reply) => {
    const a = await loadApp(req.params.alias);
    if (!a) return simplePage(reply, 404, 'Not found', `Application "${req.params.alias}" does not exist.`);
    const base = `/a/${a.alias}`;
    const session = await getSession(req, reply, a.id, base);
    const { username = '', password = '', next } = req.body ?? {};
    const ip = clientIp(req);
    const fail = async (msg: string, code = 401) => reply.code(code).type('text/html').send(await loginPage(a, session, safeNext(a, next), msg));

    if (req.body?.__csrf !== session.csrf_token) return fail('Your session expired. Please try again.', 403);
    if (!a.local_login) return fail('Password sign-in is not enabled for this application.', 403);

    if (await loginThrottled(a.id, username, ip)) {
      logActivity({ appId: a.id, username, event: 'login_locked', ip });
      return fail(`Too many failed sign-in attempts. Try again in ${LOGIN_WINDOW_MINUTES} minutes.`, 429);
    }

    const r = await runtime.one<{ username: string | null }>('select meta.authenticate($1, $2, $3) as username', [a.id, username.slice(0, 100), password.slice(0, 200)]);
    if (!r?.username) {
      await logActivity({ appId: a.id, username: username.slice(0, 100), event: 'login_failed', ip });
      return fail('Invalid username or password.');
    }

    return completeLogin(req, reply, a, session, r.username, { next });
  });

  // ---------------------------------------------------------------- single sign-on (OpenID Connect)
  const SSO_COOKIE = 'pgapex_sso';

  app.get<{ Params: { alias: string; provider: string }; Querystring: { next?: string } }>('/a/:alias/sso/:provider', async (req, reply) => {
    const a = await loadApp(req.params.alias);
    if (!a) return simplePage(reply, 404, 'Not found', `Application "${req.params.alias}" does not exist.`);
    const p = a.sso_providers.includes(req.params.provider) ? await loadProvider(req.params.provider) : undefined;
    if (!p) return simplePage(reply, 404, 'Not found', 'This sign-in method is not available.', `/a/${a.alias}/login`);
    try {
      const { url, browserKey } = await startSignIn(p, a.id, safeNext(a, req.query.next));
      reply.setCookie(SSO_COOKIE, browserKey, { path: '/sso', httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true', maxAge: 600 });
      return reply.redirect(url);
    } catch (e) {
      req.log.warn({ err: e }, 'sso start failed');
      return simplePage(reply, 502, 'Sign-in unavailable', `Could not reach ${p.display_name}. Please try again later.`, `/a/${a.alias}/login`);
    }
  });

  app.get<{ Params: { provider: string } }>('/sso/callback/:provider', async (req, reply) => {
    const ip = clientIp(req);
    const p = await loadProvider(req.params.provider);
    if (!p) return simplePage(reply, 404, 'Not found', 'Unknown identity provider.');
    const browserKey = req.cookies[SSO_COOKIE];
    reply.clearCookie(SSO_COOKIE, { path: '/sso' });
    let result;
    try {
      result = await finishSignIn(p, new URLSearchParams(req.url.split('?')[1] ?? ''), browserKey);
    } catch (e) {
      const msg = e instanceof SsoError ? e.message : 'The sign-in could not be completed.';
      if (!(e instanceof SsoError)) req.log.warn({ err: e }, 'sso callback failed');
      logActivity({ event: 'login_failed', ip, detail: `sso:${p.name}: ${msg}` });
      return simplePage(reply, 403, 'Sign-in failed', msg);
    }
    const alias = (await runtime.one<{ alias: string }>('select alias from meta.app where id = $1', [result.appId]))?.alias;
    const a = alias ? await loadApp(alias) : undefined;
    if (!a || !a.sso_providers.includes(p.name)) return simplePage(reply, 403, 'Sign-in failed', 'This sign-in method is not available.');
    const access = await ssoAccess(a.id, result.username, result.groups);
    if (!access.allowed) {
      logActivity({ appId: a.id, username: result.username, event: 'login_failed', ip, detail: `sso:${p.name}: no access` });
      return simplePage(reply, 403, 'No access', `Your account (${result.username}) has no access to ${a.name}. Ask an administrator.`, `/a/${a.alias}/login`);
    }
    const session = await getSession(req, reply, a.id, `/a/${a.alias}`);
    return completeLogin(req, reply, a, session, result.username, { extraRoles: access.roles, next: result.next ?? undefined, detail: `sso:${p.name}` });
  });

  // Sign-out is a POST with a CSRF token (a GET could be triggered by any site).
  app.post('/a/:alias/logout', async (req: Req, reply) => {
    const a = await loadApp(req.params.alias);
    if (!a) return simplePage(reply, 404, 'Not found', `Application "${req.params.alias}" does not exist.`);
    const base = `/a/${a.alias}`;
    const session = await getSession(req, reply, a.id, base);
    if (req.body?.__csrf !== session.csrf_token) return reply.redirect(`${base}/${a.home_page}`, 303);
    if (session.username) logActivity({ appId: a.id, username: session.username, event: 'logout', ip: clientIp(req) });
    await destroySession(reply, session, base);
    return reply.redirect(`${base}/login`, 303);
  });
}

