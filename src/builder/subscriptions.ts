import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import {
  APP_TYPE_LABELS, inSync, isKind, KINDS, offers, publish, refresh, subscribe, subscribersOf, subscriptionOf, subscriptionsOf,
  SubscriptionError, unsubscribe, type AppType, type Kind,
} from '../subscriptions.ts';
import { appHeader, back, BASE, csrf, developer, flash, region, send, shell, type Req } from './ui.ts';

// Shared Components → Subscriptions (APEX: subscribed shared components; 26.1
// theme and library applications). An application subscribes to a component
// of a library application (or to a theme application's theme); refreshing
// copies the master's definition again. A theme or library application lists
// its subscribers and publishes a component to them (applications locked by
// another developer are skipped).

const appRow = async (id: string) => (/^\d{1,9}$/.test(id) ? owner.one('select id, name, alias, app_type from meta.app where id = $1', [id]) : undefined);

const TYPE_HELP: Record<AppType, string> = {
  standard: 'An ordinary application.',
  theme: 'Its theme (colours, navigation, Theme Roller styles) and template components are offered to other applications.',
  library: 'Its lists of values, authorization schemes, build options, template components and lists are offered to other applications.',
  boilerplate: 'A starting point: Create application can copy it.',
};

const what = (kind: Kind, name: string) => (kind === 'theme' ? 'Theme' : `${KINDS[kind].label} ${name}`);

/** Another developer's application lock (page 0): such applications are not changed by publishing. */
const lockedByOther = (username: string) => async (appId: number) =>
  !!(await owner.one(`select 1 from meta.builder_lock where app_id = $1 and page_no = 0 and locked_by <> $2`, [appId, username]));

/** A note under a shared component in Shared Components: where it comes from, or who subscribes to it. */
export async function subscriptionNote(appId: number, kind: string, row: any, s: Session): Promise<Raw | ''> {
  if (!isKind(kind) || kind === 'theme') return '';
  const name = String(row[KINDS[kind].key] ?? '');
  const sub = await subscriptionOf(appId, kind, name);
  const subscribers = (await owner.one<{ n: number }>('select count(*)::int as n from meta.subscription where master_app_id = $1 and kind = $2 and name = $3', [appId, kind, name]))!.n;
  if (!sub && !subscribers) return '';
  const hidden = html`<input type="hidden" name="kind" value="${kind}"><input type="hidden" name="name" value="${name}">`;
  return html`<section class="used-in"><h3>Subscription</h3>
    ${sub
      ? html`<p class="u-mt0">Subscribed from <a href="${BASE}/apps/${sub.master_app_id}/subscriptions">${sub.master_name}</a>${sub.refreshed_at ? `, refreshed ${sub.refreshed_at.slice(0, 16)}` : ''}.
          Changes made here are overwritten by the next refresh.</p>
          <form method="post" action="${BASE}/apps/${appId}/subscriptions/refresh" class="u-inline">${csrf(s)}${hidden}<button class="btn btn-sm">Refresh from ${sub.master_name}</button></form>`
      : ''}
    ${subscribers
      ? html`<p>${subscribers} application${subscribers === 1 ? ' subscribes' : 's subscribe'} to this ${KINDS[kind].label.toLowerCase()}.</p>
          <form method="post" action="${BASE}/apps/${appId}/subscriptions/publish" class="u-inline">${csrf(s)}${hidden}<button class="btn btn-sm">Publish to subscribers</button></form>
          <a class="btn btn-sm" href="${BASE}/apps/${appId}/subscriptions">Subscribers…</a>`
      : ''}
  </section>`;
}

export async function subscriptionRoutes(app: FastifyInstance) {
  app.get(`${BASE}/apps/:id/subscriptions`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appRow(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const [subs, subscribers, offered] = await Promise.all([subscriptionsOf(a.id), subscribersOf(a.id), offers(a.id)]);
    const sync = await Promise.all(subs.map((x) => inSync(x)));
    const subSync = await Promise.all(subscribers.map((x) => inSync(x)));
    const hidden = (kind: string, name: string) => html`<input type="hidden" name="kind" value="${kind}"><input type="hidden" name="name" value="${name}">`;
    const state = (ok: boolean) => (ok ? html`<span class="badge">in sync</span>` : html`<span class="badge badge-warn">differs</span>`);
    const groups = new Map<number, typeof offered>();
    for (const o of offered) groups.set(o.master.id, [...(groups.get(o.master.id) ?? []), o]);
    const published = [...new Map(subscribers.map((x) => [`${x.kind}|${x.name}`, x])).values()];

    const main = html`${appHeader(a, 'shared')}<div class="ide-body">
      ${region('Application type', html`<p class="u-mt0"><b>${APP_TYPE_LABELS[a.app_type as AppType] ?? a.app_type}</b>: ${TYPE_HELP[a.app_type as AppType] ?? ''}
          Change it under <a href="${BASE}/apps/${a.id}/settings">Settings</a>.</p>`)}
      ${region('Subscriptions', html`
        <p class="muted u-mt0">Components of this application that are copies of a component in a theme or library application.
          Refreshing copies the master's definition again, replacing changes made here.</p>
        ${subs.length
          ? html`<div class="table-wrap"><table class="report"><thead><tr><th>Component</th><th>From</th><th>Refreshed</th><th>State</th><th>Actions</th></tr></thead><tbody>
              ${subs.map((x, i) => html`<tr><td>${what(x.kind, x.name)}</td><td><a href="${BASE}/apps/${x.master_app_id}/subscriptions">${x.master_name}</a></td>
                <td>${x.refreshed_at ? x.refreshed_at.slice(0, 16) : '—'}</td><td>${state(sync[i])}</td>
                <td><form method="post" action="${BASE}/apps/${a.id}/subscriptions/refresh" class="u-inline">${csrf(s)}${hidden(x.kind, x.name)}<button class="btn btn-sm">Refresh</button></form>
                  <form method="post" action="${BASE}/apps/${a.id}/subscriptions/unsubscribe" class="u-inline">${csrf(s)}${hidden(x.kind, x.name)}<button class="btn btn-sm" data-confirm="Unsubscribe? The component stays as it is.">Unsubscribe</button></form></td></tr>`)}
            </tbody></table></div>
            <form method="post" action="${BASE}/apps/${a.id}/subscriptions/refresh">${csrf(s)}<div class="buttons"><button class="btn">Refresh all</button></div></form>`
          : html`<p class="muted">No subscriptions.</p>`}
        <h3>Subscribe</h3>
        ${offered.length
          ? html`<form method="post" action="${BASE}/apps/${a.id}/subscriptions">${csrf(s)}
              <div class="field"><label class="label" for="f_component">Component</label>
                <select id="f_component" name="component" required><option value="">- choose -</option>
                  ${[...groups.values()].map((list) => html`<optgroup label="${list[0].master.name} (${APP_TYPE_LABELS[list[0].master.app_type]})">
                    ${list.map((o) => html`<option value="${o.master.id}|${o.kind}|${o.name}">${what(o.kind, o.name)}</option>`)}</optgroup>`)}
                </select>
                <small class="help">The component is copied now. A component of this application with the same name is replaced.</small></div>
              <div class="buttons"><button class="btn btn-hot">Subscribe</button></div></form>`
          : html`<p class="muted">No theme or library applications offer components. Set an application's type under its Settings.</p>`}`)}
      ${a.app_type === 'theme' || a.app_type === 'library' || subscribers.length
        ? region('Subscribers', subscribers.length
            ? html`<div class="table-wrap"><table class="report"><thead><tr><th>Component</th><th>Application</th><th>Refreshed</th><th>State</th></tr></thead><tbody>
                ${subscribers.map((x, i) => html`<tr><td>${what(x.kind, x.name)}</td><td><a href="${BASE}/apps/${x.app_id}/subscriptions">${x.app_name}</a></td>
                  <td>${x.refreshed_at ? x.refreshed_at.slice(0, 16) : '—'}</td><td>${state(subSync[i])}</td></tr>`)}
              </tbody></table></div>
              <h3>Publish</h3>
              <p class="muted u-mt0">Publishing refreshes every subscriber of a component with this application's version. Applications locked by another developer are skipped.</p>
              <div class="buttons publish-buttons">${published.map((x) => html`<form method="post" action="${BASE}/apps/${a.id}/subscriptions/publish" class="u-inline">${csrf(s)}${hidden(x.kind, x.name)}
                <button class="btn btn-sm">${icon('upload')} ${what(x.kind, x.name)}</button></form>`)}</div>`
            : html`<p class="muted">No application subscribes to this application's components yet.</p>`)
        : ''}
    </div>`;
    return send(reply, s, shell(s, `${a.name} subscriptions`, [['App Builder', BASE], [a.name, `${BASE}/apps/${a.id}`], ['Shared Components', `${BASE}/apps/${a.id}/shared`], ['Subscriptions']], main));
  });

  const target = (id: number) => `${BASE}/apps/${id}/subscriptions`;
  const handle = async (req: Req, reply: any, s: Session, appId: number, fn: () => Promise<string>) => {
    try {
      flash(s, await fn());
    } catch (e) {
      if (!(e instanceof SubscriptionError)) throw e;
      flash(s, e.message, 'error');
    }
    // back to the shared component the form was on, else the Subscriptions page
    const from = new RegExp(`/builder/apps/${appId}/shared\\?c=[a-z_]+-\\d{1,9}$`).exec(String(req.headers.referer ?? ''))?.[0];
    return back(reply, s, from ?? target(appId));
  };

  app.post(`${BASE}/apps/:id/subscriptions`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appRow(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const v = String(req.body?.component ?? '');
    const m = /^(\d{1,9})\|([a-z_]+)\|(.*)$/s.exec(v);
    return handle(req, reply, s, a.id, async () => {
      if (!m) throw new SubscriptionError('Choose a component.');
      await subscribe(a.id, Number(m[1]), m[2], m[3], s.username!);
      await logActivity({ appId: a.id, username: s.username, event: 'subscription', ip: clientIp(req), detail: `subscribed ${m[2]} ${m[3]} from application ${m[1]}` });
      return `Subscribed: ${isKind(m[2]) ? what(m[2], m[3]) : m[2]} copied.`;
    });
  });

  app.post(`${BASE}/apps/:id/subscriptions/refresh`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appRow(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const kind = req.body?.kind ? String(req.body.kind) : null;
    const name = kind ? String(req.body?.name ?? '') : null;
    return handle(req, reply, s, a.id, async () => {
      const n = await refresh(a.id, kind, name, s.username!);
      await logActivity({ appId: a.id, username: s.username, event: 'subscription', ip: clientIp(req), detail: kind ? `refreshed ${kind} ${name}` : `refreshed ${n} subscriptions` });
      return kind && isKind(kind) ? `${what(kind, name ?? '')} refreshed.` : `${n} subscription${n === 1 ? '' : 's'} refreshed.`;
    });
  });

  app.post(`${BASE}/apps/:id/subscriptions/unsubscribe`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appRow(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    return handle(req, reply, s, a.id, async () => {
      if (!(await unsubscribe(a.id, String(req.body?.kind ?? ''), String(req.body?.name ?? '')))) throw new SubscriptionError('Not subscribed.');
      return 'Unsubscribed: the component stays as it is.';
    });
  });

  app.post(`${BASE}/apps/:id/subscriptions/publish`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appRow(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const kind = String(req.body?.kind ?? ''), name = String(req.body?.name ?? '');
    return handle(req, reply, s, a.id, async () => {
      const r = await publish(a.id, kind, name, s.username!, lockedByOther(s.username!));
      await logActivity({ appId: a.id, username: s.username, event: 'subscription', ip: clientIp(req), detail: `published ${kind} ${name} to ${r.done.length} applications${r.skipped.length ? `, skipped locked ${r.skipped.join(', ')}` : ''}` });
      if (!r.done.length && !r.skipped.length) throw new SubscriptionError('No application subscribes to it.');
      return `Published to ${r.done.length} application${r.done.length === 1 ? '' : 's'}${r.skipped.length ? `; ${r.skipped.length} skipped (locked by another developer)` : ''}.`;
    });
  });
}
