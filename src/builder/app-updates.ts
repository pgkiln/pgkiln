import type { FastifyInstance, FastifyRequest } from 'fastify';
import { owner } from '../db.ts';
import type { Session } from '../session.ts';
import { BASE } from './ui.ts';

// (sprint 116, WS-12) Who changed an application last: the App Builder list's
// Updated by (APEX: Applications report, Updated By). developer() notes a
// builder POST under /apps/:id or /pages/:pid that passed its checks; after
// the handler, a success (status below 400) records the developer and the
// time in meta.app_change (migration 125). A Create or Import that redirects
// to the new application records it too. A redirect with an error message,
// locks, comments and actions that change nothing are not changes.

/** Builder POSTs under an application that don't change it. */
const NOT_A_CHANGE = /^\/apps\/\d+\/(lock|unlock|comments(\/\d+\/delete)?|feedback\/\d+|mail\/\d+\/(cancel|retry)|pwa\/push-test|rest-sources\/\d+\/test|shared\/automation\/\d+\/run|working-copies)$|^\/pages\/\d+\/region\/\d+\/ai-filter$/;
/** Builder POSTs that create an application and redirect to it. */
const CREATES = /^\/(apps|import|create(\/[a-z]+(\/\d+)?)?|gallery\/(samples|starters)\/[\w-]+|blueprints\/create|working-copies)$/;

const noted = new WeakMap<FastifyRequest, { appId: number | null; s: Session & { username: string }; error: unknown }>();

/** Called by developer() for a POST that may change an application (appId) or create one (null). */
export function noteChange(req: FastifyRequest, s: Session & { username: string }, appId: number | null) {
  const rel = req.url.split('?')[0].slice(BASE.length);
  if (appId !== null ? NOT_A_CHANGE.test(rel) : !CREATES.test(rel)) return;
  // an error message of an earlier request may still wait to be shown: only a new one is a refusal
  noted.set(req, { appId, s, error: s.state.__ERROR });
}

/** Record the change after a successful response. */
export async function recordChange(appId: number, username: string) {
  await owner.query(
    `insert into meta.app_change (app_id, updated_by, updated_at) select id, $2, now() from meta.app where id = $1
     on conflict (app_id) do update set updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    [appId, username.slice(0, 200)],
  );
}

export function appUpdateHooks(app: FastifyInstance) {
  // onSend, not onResponse: recorded before the response goes out, so the next request sees it
  app.addHook('onSend', async (req, reply, payload) => {
    const n = noted.get(req);
    // a refusal: an error status, or a redirect with an error message (flash(s, …, 'error'))
    if (!n || reply.statusCode >= 400 || (n.s.state.__ERROR && n.s.state.__ERROR !== n.error)) return payload;
    noted.delete(req);
    let appId = n.appId;
    if (appId === null) {
      // a Create or Import: the application it redirected to
      const m = reply.statusCode >= 300 && reply.statusCode < 400 ? new RegExp(`^${BASE}/apps/(\\d{1,9})(?:[/?#]|$)`).exec(String(reply.getHeader('location') ?? '')) : null;
      if (!m) return payload;
      appId = Number(m[1]);
    }
    await recordChange(appId, n.s.username).catch((err) => req.log.warn({ err }, 'app_change not recorded'));
    return payload;
  });
}
