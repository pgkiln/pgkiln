import type { FastifyInstance, FastifyReply } from 'fastify';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import { back, BASE, csrf, developer, flash, type Req } from './ui.ts';

// Page locks, the application lock and developer comments (APEX: page locks,
// application lock in 26.1, developer comments). A developer locks a page
// (page_no) or the whole application (page_no 0); other developers can't
// change it in the builder until it is unlocked. Administrators (developers
// with is_admin) can break another developer's lock; that is logged.
// The check runs in developer() for every builder POST under /apps/:id and
// /pages/:pid (see blockingLock), except the lock and comment routes.
// Comments belong to an application or one of its pages; their authors (and
// administrators) can delete them. Neither travels with an export.

export interface Lock {
  app_id: number;
  page_no: number;
  locked_by: string;
  locked_at: string;
  note: string | null;
}

export const isAdmin = async (username: string | null | undefined) =>
  !!username && !!(await owner.one<{ ok: boolean }>('select is_admin as ok from meta.developer where username = $1', [username]))?.ok;

/** The locks of an application: the application lock (page_no 0) and page locks. */
export const appLocks = async (appId: number) =>
  (await owner.query<Lock>('select app_id, page_no, locked_by, locked_at::text, note from meta.builder_lock where app_id = $1 order by page_no', [appId])).rows;

/** Builder POSTs that are allowed on a locked page or application (locking, unlocking, comments). */
const EXEMPT = /^\/apps\/\d+\/(lock|unlock|comments(\/\d+\/delete)?)$/;

/** The application (and page) a builder URL under /apps/:id or /pages/:pid is about, or null. */
export async function appOfPath(path: string): Promise<{ appId: number; pageNo: number | null; pageId: number | null } | null> {
  const rel = path.split('?')[0].slice(BASE.length);
  const app = /^\/apps\/(\d{1,9})(\/|$)/.exec(rel);
  if (app) return { appId: Number(app[1]), pageNo: null, pageId: null };
  const page = /^\/pages\/(\d{1,9})(\/|$)/.exec(rel);
  if (!page) return null;
  const p = await owner.one<{ app_id: number; page_no: number }>('select app_id, page_no from meta.page where id = $1', [Number(page[1])]);
  return p ? { appId: p.app_id, pageNo: p.page_no, pageId: Number(page[1]) } : null;
}

/**
 * The lock of another developer that stops this request from changing an
 * application or page, or null. pageNo null: an application-level change.
 */
export async function blockingLock(username: string, path: string): Promise<{ lock: Lock; appId: number; pageId: number | null } | null> {
  const rel = path.split('?')[0].slice(BASE.length);
  if (EXEMPT.test(rel)) return null;
  const target = await appOfPath(path);
  if (!target) return null;
  const { appId, pageNo, pageId } = target;
  const lock = await owner.one<Lock>(
    `select app_id, page_no, locked_by, locked_at::text, note from meta.builder_lock
      where app_id = $1 and (page_no = 0 or page_no = $2) and locked_by <> $3 order by page_no limit 1`,
    [appId, pageNo ?? -1, username],
  );
  return lock ? { lock, appId, pageId } : null;
}

export const lockText = (l: Pick<Lock, 'page_no' | 'locked_by' | 'locked_at' | 'note'>) =>
  `${l.page_no ? `Page ${l.page_no}` : 'The application'} is locked by ${l.locked_by} since ${l.locked_at.slice(0, 16)}${l.note ? ` (${l.note})` : ''}.`;

/** Refuse a change to a locked page or application: a JSON error or a message on the page it came from. */
export async function refuseLocked(req: Req, reply: FastifyReply, s: Session, hit: NonNullable<Awaited<ReturnType<typeof blockingLock>>>) {
  const message = `${lockText(hit.lock)} Changes are refused until it is unlocked.`;
  if (String(req.headers.accept ?? '').includes('application/json')) return reply.code(423).send({ ok: false, error: message });
  flash(s, message, 'error');
  return back(reply, s, hit.pageId ? `${BASE}/pages/${hit.pageId}` : `${BASE}/apps/${hit.appId}`);
}

/** Lock status, lock/unlock form and the comments of an application (pageNo 0) or a page. */
export async function lockPanel(s: Session, appId: number, pageNo: number, opts: { headings?: boolean } = {}): Promise<Raw> {
  const [locks, comments, admin] = await Promise.all([
    appLocks(appId),
    owner.query('select id, author, body, created_at::text from meta.dev_comment where app_id = $1 and page_no = $2 order by created_at desc, id desc limit 200', [appId, pageNo]),
    isAdmin(s.username),
  ]);
  const own = locks.find((l) => l.page_no === pageNo);
  const appLock = pageNo ? locks.find((l) => l.page_no === 0) : undefined;
  const what = pageNo ? `page ${pageNo}` : 'the application';
  const hidden = html`<input type="hidden" name="page_no" value="${pageNo}">`;
  const lockState = own
    ? html`<p class="lock-state">${icon('key')} <span>${lockText(own)}</span></p>
        ${own.locked_by === s.username || admin
          ? html`<form method="post" action="${BASE}/apps/${appId}/unlock">${csrf(s)}${hidden}
              <button class="btn"${own.locked_by !== s.username ? raw(` data-confirm="Break ${own.locked_by}'s lock on ${what}?"`) : ''}>${own.locked_by === s.username ? 'Unlock' : 'Break lock (administrator)'}</button></form>`
          : html`<p class="muted">Only ${own.locked_by} or an administrator can unlock it.</p>`}`
    : html`<p class="muted">Not locked: every developer can change ${what}.</p>
        <form method="post" action="${BASE}/apps/${appId}/lock" class="search u-mwnone">${csrf(s)}${hidden}
          <label class="sr-only" for="lock-note-${pageNo}">Note</label>
          <input id="lock-note-${pageNo}" name="note" maxlength="500" placeholder="Note (optional), e.g. reworking the form">
          <button class="btn">${icon('key')} Lock ${what}</button></form>`;
  return html`<div class="lock-panel">
    ${opts.headings === false ? '' : html`<h3>Lock</h3>`}
    ${appLock && appLock.locked_by !== s.username ? html`<div class="alert alert-error" role="status">${lockText(appLock)}</div>` : ''}
    ${lockState}
    <h3>Comments</h3>
    <form method="post" action="${BASE}/apps/${appId}/comments">${csrf(s)}${hidden}
      <div class="field"><label class="label" for="comment-${pageNo}">Add a comment on ${what}</label>
        <textarea id="comment-${pageNo}" name="body" rows="3" maxlength="4000" required></textarea></div>
      <div class="buttons"><button class="btn">Add comment</button></div>
    </form>
    ${comments.rows.length
      ? html`<ul class="dev-comments">${comments.rows.map((c) => html`<li>
          <div class="dev-comment-head"><b>${c.author}</b> <span class="muted">${String(c.created_at).slice(0, 16)}</span>
            ${c.author === s.username || admin
              ? html`<form method="post" action="${BASE}/apps/${appId}/comments/${c.id}/delete" class="u-inline">${csrf(s)}<button class="link-button" data-confirm="Delete this comment?">Delete</button></form>`
              : ''}</div>
          <p class="dev-comment-body">${c.body}</p></li>`)}</ul>`
      : html`<p class="muted">No comments yet.</p>`}
  </div>`;
}

const pageNoOf = (v: string | undefined) => (/^\d{1,9}$/.test(v ?? '') ? Number(v) : null);

/** Where to go back to after a lock or comment change. */
async function backTo(appId: number, pageNo: number) {
  if (!pageNo) return `${BASE}/apps/${appId}`;
  const p = await owner.one('select id from meta.page where app_id = $1 and page_no = $2', [appId, pageNo]);
  return p ? `${BASE}/pages/${p.id}?c=page` : `${BASE}/apps/${appId}`;
}

export async function lockRoutes(app: FastifyInstance) {
  const target = async (req: Req) => {
    const appId = pageNoOf(req.params.id);
    const pageNo = pageNoOf(req.body?.page_no ?? '0');
    if (appId === null || pageNo === null || !(await owner.one('select 1 as ok from meta.app where id = $1', [appId]))) return null;
    if (pageNo && !(await owner.one('select 1 as ok from meta.page where app_id = $1 and page_no = $2', [appId, pageNo]))) return null;
    return { appId, pageNo };
  };

  app.post(`${BASE}/apps/:id/lock`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const t = await target(req);
    if (!t) return reply.code(404).send('Not found');
    const note = (req.body?.note ?? '').trim().slice(0, 500) || null;
    const r = await owner.query(
      `insert into meta.builder_lock (app_id, page_no, locked_by, note) values ($1, $2, $3, $4) on conflict (app_id, page_no) do nothing`,
      [t.appId, t.pageNo, s.username, note],
    );
    if (r.rowCount) flash(s, `${t.pageNo ? `Page ${t.pageNo}` : 'The application'} is locked: other developers can't change it until you unlock it.`);
    else flash(s, 'It is already locked.', 'error');
    return back(reply, s, await backTo(t.appId, t.pageNo));
  });

  app.post(`${BASE}/apps/:id/unlock`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const t = await target(req);
    if (!t) return reply.code(404).send('Not found');
    const lock = await owner.one<Lock>('select app_id, page_no, locked_by, locked_at::text, note from meta.builder_lock where app_id = $1 and page_no = $2', [t.appId, t.pageNo]);
    if (!lock) {
      flash(s, 'It is not locked.');
    } else if (lock.locked_by !== s.username && !(await isAdmin(s.username))) {
      return reply.code(403).send('Only the developer who locked it or an administrator can unlock it.');
    } else {
      await owner.query('delete from meta.builder_lock where app_id = $1 and page_no = $2', [t.appId, t.pageNo]);
      if (lock.locked_by !== s.username)
        await logActivity({ appId: t.appId, pageNo: t.pageNo || null, username: s.username, event: 'lock_broken', ip: clientIp(req), detail: `builder: lock of ${lock.locked_by}` });
      flash(s, lock.locked_by === s.username ? 'Unlocked.' : `${lock.locked_by}'s lock was broken.`);
    }
    return back(reply, s, await backTo(t.appId, t.pageNo));
  });

  app.post(`${BASE}/apps/:id/comments`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const t = await target(req);
    if (!t) return reply.code(404).send('Not found');
    const body = (req.body?.body ?? '').trim();
    if (!body || body.length > 4000) flash(s, 'A comment has 1 to 4000 characters.', 'error');
    else {
      await owner.query('insert into meta.dev_comment (app_id, page_no, author, body) values ($1, $2, $3, $4)', [t.appId, t.pageNo, s.username, body]);
      flash(s, 'Comment added.');
    }
    return back(reply, s, await backTo(t.appId, t.pageNo));
  });

  app.post(`${BASE}/apps/:id/comments/:cid/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const c = /^\d{1,9}$/.test(req.params.id) && /^\d{1,9}$/.test(req.params.cid)
      ? await owner.one('select id, app_id, page_no, author from meta.dev_comment where id = $1 and app_id = $2', [req.params.cid, req.params.id])
      : undefined;
    if (!c) return reply.code(404).send('Not found');
    if (c.author !== s.username && !(await isAdmin(s.username))) return reply.code(403).send('Only the author or an administrator can delete a comment.');
    await owner.query('delete from meta.dev_comment where id = $1', [c.id]);
    flash(s, 'Comment deleted.');
    return back(reply, s, await backTo(c.app_id, c.page_no));
  });
}
