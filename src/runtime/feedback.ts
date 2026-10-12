// Feedback (APEX: Feedback), migration 084. With the application's feedback
// setting on, the navigation bar links to GET /a/:alias/:page/feedback: a
// form for a comment, an idea or a problem about that page (an optional
// rating), and the user's own earlier feedback with the developers' answers.
// Developers answer in the builder (src/builder/feedback.ts).
//
// The page's own access rules apply (no feedback about a page the user may
// not open). Feedback is stored with the user, page, session and browser
// name; at most FEEDBACK_PER_HOUR per session. Everything shown is escaped.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { appTx, runtime } from '../db.ts';
import { html, raw } from '../html.ts';
import { icon } from '../icons.ts';
import { saveState } from '../session.ts';
import { checkPageAccess, Forbidden } from './authz.ts';
import type { PageContext } from './context.ts';
import type { ListNode } from './lists.ts';
import { chrome } from './render.ts';

type Loader = (req: any, reply: FastifyReply) => Promise<PageContext | null>;
type Tx = (ctx: PageContext) => Parameters<typeof appTx>[0];

const KINDS = ['comment', 'idea', 'problem'] as const;
export const FEEDBACK_PER_HOUR = 10;
const MAX_TEXT = 4000;

/** The navigation bar's Feedback entry (when the application asks for it). */
export function feedbackNode(ctx: PageContext): ListNode | null {
  if (!ctx.app.feedback || ctx.dialog) return null;
  return {
    label: ctx.locale.t('feedback.link'), href: `${ctx.base}/${ctx.page.page_no}/feedback`, modal: false, external: false,
    icon: 'chat', badge: null, description: null, current: false, inTrail: false, children: [],
  };
}

const when = (d: string | Date) => new Date(d).toISOString().slice(0, 16).replace('T', ' ');

export function feedbackRoutes(app: FastifyInstance, loadContext: Loader, txContext: Tx) {
  const page = async (ctx: PageContext, reply: FastifyReply, status: number, notice: { ok: boolean; text: string } | null, draft: { kind?: string; rating?: string; body?: string } = {}) => {
    const t = ctx.locale.t;
    const mine = ctx.user === 'nobody' ? [] : (await runtime.query(
      `select page_no, kind, rating, body, status, response, responded_at, created_at from meta.feedback
        where app_id = $1 and lower(username) = lower($2) order by created_at desc limit 50`, [ctx.app.id, ctx.user])).rows;
    const status_ = (s: string) => t(`feedback.status.${s}` as never);
    const main = html`<div class="t-titlebar"><h1>${t('feedback.title')}</h1></div>
      <div class="t-content feedback-page">
        <div class="messages" aria-live="polite">${notice ? html`<div class="alert ${notice.ok ? 'alert-success' : 'alert-error'}" role="${notice.ok ? 'status' : 'alert'}">${notice.text}</div>` : ''}</div>
        <section class="region region-standard"><div class="region-body">
          <p class="u-mt0">${t('feedback.intro', { page: ctx.page.title ?? ctx.page.name })}</p>
          <form method="post" action="${ctx.base}/${ctx.page.page_no}/feedback" class="feedback-form">
            <input type="hidden" name="__csrf" value="${ctx.session.csrf_token}">
            <fieldset class="field"><legend class="label">${t('feedback.kind')}</legend>
              <div class="choices">${KINDS.map((k) => html`<label class="check"><input type="radio" name="kind" value="${k}"${(draft.kind ?? 'comment') === k ? raw(' checked') : ''}> ${t(`feedback.kind.${k}` as never)}</label>`)}</div>
            </fieldset>
            <div class="field"><label class="label" for="feedback_rating">${t('feedback.rating')}</label>
              <select id="feedback_rating" name="rating"><option value="">–</option>${[5, 4, 3, 2, 1].map((n) =>
                html`<option value="${n}"${draft.rating === String(n) ? raw(' selected') : ''}>${'★'.repeat(n)}</option>`)}</select></div>
            <div class="field" data-wide><label class="label" for="feedback_body">${t('feedback.text')}<span class="req" aria-hidden="true">*</span></label>
              <textarea id="feedback_body" name="body" rows="6" maxlength="${MAX_TEXT}" required>${draft.body ?? ''}</textarea></div>
            <div class="buttons"><a class="btn" href="${ctx.base}/${ctx.page.page_no}">${t('feedback.back')}</a><button class="btn btn-hot">${icon('send')} ${t('feedback.send')}</button></div>
          </form>
        </div></section>
        ${ctx.user === 'nobody' ? '' : html`<section class="region region-standard"><header class="region-header"><h2>${t('feedback.mine')}</h2></header><div class="region-body">
          ${mine.length ? html`<ul class="feedback-list">${mine.map((f) => html`<li>
            <div class="feedback-meta"><span class="tag">${t(`feedback.kind.${f.kind}` as never)}</span> <span class="tag${f.status === 'done' ? ' tag-ok' : ''}">${status_(f.status)}</span>
              <span class="muted">${when(f.created_at)}${f.page_no ? ` · ${t('feedback.page', { page: String(f.page_no) })}` : ''}${f.rating ? ` · ${'★'.repeat(f.rating)}` : ''}</span></div>
            <p class="feedback-body">${f.body}</p>
            ${f.response ? html`<div class="feedback-response"><strong>${t('feedback.response')}</strong><p>${f.response}</p></div>` : ''}
          </li>`)}</ul>` : html`<p class="muted">${t('feedback.none')}</p>`}
        </div></section>`}
      </div>`;
    ctx.vis = { regions: new Set(), items: new Set(), editable: new Set(), buttons: new Map(), dynamicActions: new Set() };
    const body = await appTx(txContext(ctx), async (c) => {
      ctx.client = c;
      return chrome(ctx, main, t('feedback.title'));
    });
    await saveState(ctx.session);
    return reply.code(status).type('text/html').send(body);
  };

  /** The context of a feedback request: the application allows feedback and the user may open the page. */
  const context = async (req: any, reply: FastifyReply) => {
    const ctx = await loadContext(req, reply);
    if (!ctx) return null;
    if (!ctx.app.feedback) {
      reply.code(404).type('text/plain').send('Not found');
      return null;
    }
    try {
      await appTx(txContext(ctx), async (c) => {
        ctx.client = c;
        await checkPageAccess(ctx);
      });
    } catch (e) {
      if (e instanceof Forbidden) {
        reply.code(403).type('text/plain').send(e.message);
        return null;
      }
      throw e;
    }
    return ctx;
  };

  app.get('/a/:alias/:page/feedback', async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    return page(ctx, reply, 200, null);
  });

  app.post('/a/:alias/:page/feedback', async (req: any, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const t = ctx.locale.t;
    const b = req.body ?? {};
    if (b.__csrf !== ctx.session.csrf_token) return page(ctx, reply, 403, { ok: false, text: t('error.session_reload') });
    const kind = (KINDS as readonly string[]).includes(b.kind) ? b.kind : 'comment';
    const rating = /^[1-5]$/.test(String(b.rating ?? '')) ? Number(b.rating) : null;
    const text = String(b.body ?? '').replace(/\r\n?/g, '\n').trim();
    if (!text || text.length > MAX_TEXT) return page(ctx, reply, 422, { ok: false, text: t('feedback.required') }, { kind, rating: b.rating, body: text.slice(0, MAX_TEXT) });
    const recent = (await runtime.one<{ n: number }>(
      `select count(*)::int as n from meta.feedback where app_id = $1 and session_id = $2 and created_at > now() - interval '1 hour'`, [ctx.app.id, ctx.session.id]))!.n;
    if (recent >= FEEDBACK_PER_HOUR) return page(ctx, reply, 429, { ok: false, text: t('feedback.too_many') }, { kind, rating: b.rating, body: text });
    await runtime.query(
      `insert into meta.feedback (app_id, page_no, username, session_id, kind, rating, body, user_agent) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [ctx.app.id, ctx.page.page_no, ctx.user, ctx.session.id, kind, rating, text, String(req.headers['user-agent'] ?? '').slice(0, 300) || null]);
    return page(ctx, reply, 200, { ok: true, text: t('feedback.thanks') });
  });
}
