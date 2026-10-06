import type { FastifyInstance, FastifyReply } from 'fastify';
import { owner } from '../db.ts';
import { html } from '../html.ts';
import type { App } from '../metadata.ts';
import { appPublicKey, subscriptionProblem } from '../push.ts';
import { logActivity } from '../session.ts';
import type { PageContext } from './context.ts';
import { loadContext, type Req } from './routes.ts';

// Push notifications in the running application (migration 074, src/push.ts):
// app.js asks the browser for a subscription (My account, or the dynamic
// action push_subscribe: both after a click, as browsers require) and posts
// it here. The application's public key reaches the page as data-push.

/** Whether the app offers notifications. */
export const pushOn = (a: Pick<App, 'pwa' | 'pwa_push'>) => a.pwa && a.pwa_push;

/** <body> data attributes: the application server key and the user, for signed-in users. */
export async function pushBody(a: Pick<App, 'id' | 'pwa' | 'pwa_push'>, username: string | null | undefined): Promise<Record<string, string>> {
  if (!pushOn(a) || !username) return {};
  try {
    return { 'data-push': await appPublicKey(a.id), 'data-push-user': username.toLowerCase() };
  } catch (e) {
    // no key yet and no PGAPEX_SECRET_KEY to store one: the page works, without notifications
    console.error('push notifications:', (e as Error).message);
    return {};
  }
}

/** My account → Notifications: the switch for this device (app.js fills it in; without JavaScript it says why not). */
export async function pushSection(ctx: PageContext) {
  if (!pushOn(ctx.app)) return '';
  const t = ctx.locale.t;
  const n = (await owner.one<{ n: number }>('select count(*)::int as n from meta.push_subscription where app_id = $1 and lower(username) = lower($2)', [ctx.app.id, ctx.user]))?.n ?? 0;
  return html`<section class="region region-standard col-6" data-push-section><header class="region-header"><h2>${t('push.title')}</h2></header><div class="region-body">
    <p class="muted u-mt0">${t('push.help')} ${t('push.devices', { n })}</p>
    <p data-push-status role="status">${t('push.unsupported')}</p>
    <div class="buttons"><button type="button" class="btn btn-hot" data-push-toggle hidden>${t('push.turn_on')}</button></div>
  </div></section>`;
}

export async function pushRoutes(app: FastifyInstance) {
  const context = async (req: Req, reply: FastifyReply) => {
    const ctx = await loadContext(req, reply, { json: true, pageNo: 'home' });
    if (!ctx) return null;
    if (req.body?.__csrf !== ctx.session.csrf_token) return void reply.code(403).send({ error: ctx.locale.t('error.session_reload') }), null;
    if (!pushOn(ctx.app)) return void reply.code(404).send({ error: 'Push notifications are off for this application.' }), null;
    if (!ctx.session.username) return void reply.code(401).send({ error: ctx.locale.t('error.session_reload') }), null;
    return ctx;
  };

  app.post('/a/:alias/push/subscribe', async (req: Req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const b = req.body ?? {};
    const problem = subscriptionProblem(b);
    if (problem) return reply.code(422).send({ error: problem });
    // made with the current key? (a page from before "New keys" would subscribe with the old one)
    if (b.key !== undefined && b.key !== (await appPublicKey(ctx.app.id))) return reply.code(409).send({ error: 'The application has new keys: reload the page.' });
    const ua = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 300) : null;
    // one endpoint is one device: whoever subscribes it last owns it
    await owner.query(
      `insert into meta.push_subscription (app_id, username, endpoint, p256dh, auth, user_agent) values ($1, $2, $3, $4, $5, $6)
       on conflict (endpoint) do update set app_id = excluded.app_id, username = excluded.username, p256dh = excluded.p256dh,
              auth = excluded.auth, user_agent = excluded.user_agent, failures = 0,
              created_at = case when meta.push_subscription.username = excluded.username and meta.push_subscription.app_id = excluded.app_id
                                then meta.push_subscription.created_at else now() end`,
      [ctx.app.id, ctx.session.username, b.endpoint, b.p256dh, b.auth, ua],
    );
    logActivity({ appId: ctx.app.id, username: ctx.session.username, event: 'push', ip: ctx.ip, detail: 'notifications on' });
    return reply.send({ ok: true });
  });

  app.post('/a/:alias/push/unsubscribe', async (req: Req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const endpoint = req.body?.endpoint;
    if (typeof endpoint !== 'string') return reply.code(422).send({ error: 'The endpoint is missing.' });
    await owner.query('delete from meta.push_subscription where endpoint = $1 and app_id = $2 and lower(username) = lower($3)', [endpoint, ctx.app.id, ctx.session.username]);
    logActivity({ appId: ctx.app.id, username: ctx.session.username, event: 'push', ip: ctx.ip, detail: 'notifications off' });
    return reply.send({ ok: true });
  });
}
