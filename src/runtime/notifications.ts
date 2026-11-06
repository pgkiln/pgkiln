import type { FastifyInstance, FastifyReply } from 'fastify';
import { appTx, runtime } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { checkPageAccess, computeVisibility, Forbidden } from './authz.ts';
import { publicError, type PageContext } from './context.ts';
import { listTree, queryBadge, type ListNode } from './lists.ts';
import { buttonBadgeKey } from './regions.ts';
import { chrome, clientTexts } from './render.ts';
import { safeNext } from './signin.ts';
import { saveState, takeFlash } from '../session.ts';
import { loadContext, txContext, type Req } from './routes.ts';

// (sprint 165, migration 154) In-app notifications and live badges (APEX: a notification bell in the
// header, navigation menu badges, badges refreshed with dynamic actions and JavaScript).
//
// Application code adds notifications with meta.notify() or the send_notification process. With
// meta.app.notifications on, signed-in users get a bell in the header: the number of unread
// notifications and the newest ones. Opening one (a POST with the session's CSRF token) marks it read
// and goes to its page (a link signed for the recipient when it was made). /a/<alias>/notifications
// lists them all. Only the user's own notifications of this application are ever read or changed:
// every query has the application's id and the session's user name.
//
// With meta.app.live_badges_s set, the page asks GET /a/<alias>/<page>/live every so many seconds for
// the badges of its navigation menu and bar (list entries), of its buttons with a badge query, and for
// the bell. These requests don't keep an idle session alive (loadContext touch: false).

/** Newest notifications in the bell's menu. */
const BELL_ROWS = 8;
/** Notifications on the notifications page. */
const PAGE_ROWS = 100;

interface Row {
  id: string;
  title: string;
  body: string | null;
  url: string | null;
  icon: string | null;
  created_at: Date | string;
  read_at: Date | string | null;
}

const signedIn = (ctx: PageContext) => ctx.app.authentication !== 'none' && ctx.user !== 'nobody';
/** The bell is shown: notifications on, a signed-in user, a page with the header. */
export const hasBell = (ctx: PageContext) => !!ctx.app.notifications && signedIn(ctx);

async function rows(ctx: PageContext, limit: number): Promise<Row[]> {
  return (
    await runtime.query<Row>(
      `select id::text, title, body, url, icon, created_at, read_at from meta.notification
        where app_id = $1 and lower(username) = lower($2) order by id desc limit $3`,
      [ctx.app.id, ctx.user, limit],
    )
  ).rows;
}

async function unreadCount(ctx: PageContext): Promise<number> {
  const r = await runtime.one<{ n: number }>(
    'select count(*)::int as n from meta.notification where app_id = $1 and lower(username) = lower($2) and read_at is null',
    [ctx.app.id, ctx.user],
  );
  return r?.n ?? 0;
}

const shown = (n: number) => (n > 99 ? '99+' : String(n));

/** A notification's time in the user's language and time zone (the pool gives timestamps as text). */
function when(ctx: PageContext, value: Date | string) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  try {
    return new Intl.DateTimeFormat(ctx.locale.lang, { dateStyle: 'medium', timeStyle: 'short', timeZone: ctx.locale.timeZone ?? undefined }).format(d);
  } catch {
    return d.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/** A notification as a button that opens it (a form: it marks the notification read). */
function entry(ctx: PageContext, r: Row, cls: string): Raw {
  const t = ctx.locale.t;
  return html`<li class="${cls}${r.read_at ? '' : ' is-unread'}"><form method="post" action="${ctx.base}/notifications/${r.id}/open">
      <input type="hidden" name="__csrf" value="${ctx.session.csrf_token}">
      <button class="t-notification">${icon(r.icon ?? 'bell')}<span class="t-notification-text">
        <span class="t-notification-title">${r.read_at ? '' : html`<span class="sr-only">${t('notify.unread_one')}: </span>`}${r.title}</span>
        ${r.body ? html`<span class="t-notification-body">${r.body}</span>` : ''}
        <span class="t-notification-time">${when(ctx, r.created_at)}</span></span></button>
    </form></li>`;
}

/** "Mark all read", back to next. */
function markAllForm(ctx: PageContext, next: string): Raw {
  return html`<form method="post" action="${ctx.base}/notifications/read" class="t-bell-read">
      <input type="hidden" name="__csrf" value="${ctx.session.csrf_token}"><input type="hidden" name="next" value="${next}">
      <button class="link-button">${icon('check')} ${ctx.locale.t('notify.mark_all_read')}</button></form>`;
}

/** The bell's menu: the newest notifications, Mark all read, All notifications. */
async function bellPanel(ctx: PageContext, unread: number): Promise<Raw> {
  const t = ctx.locale.t;
  const list = await rows(ctx, BELL_ROWS);
  return html`<div class="menu-section t-bell-head"><strong>${t('notify.title')}</strong>${unread ? markAllForm(ctx, `${ctx.base}/${ctx.page.page_no}`) : ''}</div>
    ${list.length ? html`<ul class="t-bell-list">${list.map((r) => entry(ctx, r, 't-bell-entry'))}</ul>` : html`<p class="muted t-bell-none">${t('notify.none')}</p>`}
    <div class="menu-section"><a href="${ctx.base}/notifications">${icon('arrow-right')} ${t('notify.all')}</a></div>`;
}

const bellLabel = (ctx: PageContext, unread: number) =>
  unread ? ctx.locale.t(unread === 1 ? 'notify.bell_one' : 'notify.bell_n', { n: unread }) : ctx.locale.t('notify.title');

/** The bell in the header (empty when the application has no notifications or nobody is signed in). */
export async function bellMarkup(ctx: PageContext): Promise<Raw | ''> {
  if (!hasBell(ctx)) return '';
  const unread = await unreadCount(ctx);
  return html`<details class="menu t-bell" data-bell>
      <summary class="icon-button" title="${bellLabel(ctx, unread)}" aria-label="${bellLabel(ctx, unread)}">${icon('bell')}<span class="t-bell-count" data-badge="bell"${unread ? '' : raw(' hidden')}>${unread ? shown(unread) : ''}</span></summary>
      <div class="menu-panel align-right t-bell-panel" data-bell-panel>${await bellPanel(ctx, unread)}</div>
    </details>`;
}

/** Every node of a list tree, depth first. */
const allNodes = (nodes: ListNode[]): ListNode[] => nodes.flatMap((n) => [n, ...allNodes(n.children)]);

export interface LiveState {
  /** data-badge key → its text (null: no badge) */
  badges: Record<string, string | null>;
  bell: { unread: number; label: string; panel: string } | null;
}

/** The page's badges now (navigation menu and bar, buttons with a badge query) and the bell. */
export async function liveState(ctx: PageContext): Promise<LiveState> {
  const badges: Record<string, string | null> = {};
  for (const [list, prefix] of [[ctx.app.nav_list, 'n:'], [ctx.app.navbar_list, 'b:']] as const) {
    if (!list) continue;
    for (const n of allNodes((await listTree(ctx, list)) ?? [])) badges[`${prefix}${n.key}`] = n.badge;
  }
  for (const b of ctx.vis!.buttons.values())
    if (b.badge_query?.trim() && b.id > 0) badges[buttonBadgeKey(b)] = await queryBadge(ctx, b.badge_query, `badge of button ${b.name}`);
  return { badges, bell: null };
}

export async function notificationRoutes(app: FastifyInstance) {
  /** A signed-in user of an application with notifications on (else a 404). */
  const context = async (req: Req, reply: FastifyReply) => {
    const ctx = await loadContext(req, reply, { pageNo: 'home' });
    if (!ctx) return null;
    if (!hasBell(ctx)) {
      reply.code(404).type('text/plain').send('Not found');
      return null;
    }
    return ctx;
  };

  app.get('/a/:alias/notifications', async (req: Req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const t = ctx.locale.t;
    const list = await rows(ctx, PAGE_ROWS);
    const unread = list.some((r) => !r.read_at);
    const flash = takeFlash(ctx.session);
    const main = html`<div class="t-titlebar"><h1>${t('notify.title')}</h1></div>
      <div class="t-content notifications-page">
        <div class="messages" aria-live="polite">${flash ? html`<div class="alert alert-success" role="status">${flash}</div>` : ''}</div>
        <section class="region region-standard"><div class="region-body">
          ${unread ? html`<div class="buttons u-mt0">${markAllForm(ctx, `${ctx.base}/notifications`)}</div>` : ''}
          ${list.length ? html`<ul class="t-notification-list">${list.map((r) => entry(ctx, r, 't-notification-entry'))}</ul>` : html`<p class="muted">${t('notify.none')}</p>`}
        </div></section>
      </div>
      <script type="application/json" id="pgkiln-meta">${raw(JSON.stringify({ csrf: ctx.session.csrf_token, das: [], texts: clientTexts(ctx) }).replace(/</g, '\\u003c'))}</script>`;
    ctx.vis = { regions: new Set(), items: new Set(), editable: new Set(), buttons: new Map(), dynamicActions: new Set() };
    const body = await appTx(txContext(ctx), async (c) => {
      ctx.client = c;
      return chrome(ctx, main, t('notify.title'));
    });
    await saveState(ctx.session);
    return reply.header('cache-control', 'private, no-store').type('text/html').send(body);
  });

  // open a notification: mark it read, go to its page (or the list when it has none)
  app.post('/a/:alias/notifications/:id/open', async (req: Req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    if (req.body?.__csrf !== ctx.session.csrf_token) return reply.redirect(`${ctx.base}/notifications`, 303);
    const id = /^[1-9][0-9]{0,17}$/.test(String(req.params.id)) ? String(req.params.id) : null;
    const row = id
      ? await runtime.one<{ url: string | null }>(
          `update meta.notification set read_at = coalesce(read_at, now())
            where id = $1 and app_id = $2 and lower(username) = lower($3) returning url`,
          [id, ctx.app.id, ctx.user],
        )
      : null;
    if (!row) {
      ctx.session.state.__FLASH = ctx.locale.t('notify.gone');
      await saveState(ctx.session);
      return reply.redirect(`${ctx.base}/notifications`, 303);
    }
    // the link was made under the application's alias then; it goes to the same page now
    const rest = row.url?.replace(/^\/a\/[^/]+\//, '');
    return reply.redirect(rest ? `${ctx.base}/${rest}` : `${ctx.base}/notifications`, 303);
  });

  app.post('/a/:alias/notifications/read', async (req: Req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const next = safeNext(ctx.app, typeof req.body?.next === 'string' ? req.body.next : `${ctx.base}/notifications`);
    if (req.body?.__csrf !== ctx.session.csrf_token) return reply.redirect(next, 303);
    await runtime.query(
      'update meta.notification set read_at = now() where app_id = $1 and lower(username) = lower($2) and read_at is null',
      [ctx.app.id, ctx.user],
    );
    ctx.session.state.__FLASH = ctx.locale.t('notify.marked');
    await saveState(ctx.session);
    return reply.redirect(next, 303);
  });

  // live badges: what the page shows now; never extends the session
  app.get('/a/:alias/:page/live', async (req: Req, reply) => {
    const ctx = await loadContext(req, reply, { json: true, touch: false });
    if (!ctx) return;
    reply.header('cache-control', 'private, no-store');
    if (!ctx.app.live_badges_s) return reply.code(404).send({ error: 'not found' });
    try {
      const state = await appTx(txContext(ctx), async (c) => {
        ctx.client = c;
        await checkPageAccess(ctx);
        ctx.vis = await computeVisibility(ctx);
        return liveState(ctx);
      });
      if (hasBell(ctx)) {
        const unread = await unreadCount(ctx);
        state.bell = { unread, label: bellLabel(ctx, unread), panel: (await bellPanel(ctx, unread)).toString() };
      }
      return reply.send(state);
    } catch (e) {
      if (e instanceof Forbidden) return reply.code(403).send({ error: e.message });
      return reply.code(400).send({ error: await publicError(ctx, e, 'live badges') });
    }
  });
}
