import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import {
  APP_TYPE_LABELS, groupsOffered, inSync, isKind, KINDS, offers, publish, refresh, subscribe, subscribersOf, subscriptionOf, subscriptionsOf,
  SubscriptionError, subscribeGroup, unsubscribe, type AppType, type Kind,
} from '../subscriptions.ts';
import { appHeader, back, BASE, csrf, developer, flash, region, send, shell, type Req } from './ui.ts';
import { scopedTx as tx } from './i18n.ts';

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
  reporting: 'Made by App Builder → Data Reporter on datasets of the workspace: its users build, publish and share reports.',
};

const kindLabel = (kind: Kind) => tx.dyn(`sub.k.${kind}`, KINDS[kind].label);
const typeLabel = (t: AppType) => tx.dyn(`st.type.${t}`, APP_TYPE_LABELS[t] ?? t);
const what = (kind: Kind, name: string) => (kind === 'theme' ? tx('sub.theme') : tx('sub.what', { kind: kindLabel(kind), name }));

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
  return html`<section class="used-in"><h3>${tx('sub.subscription')}</h3>
    ${sub
      ? html`<p class="u-mt0">${((m) => (sub.refreshed_at ? tx.rich('sub.subscribed_from_at', { master: m, at: sub.refreshed_at.slice(0, 16) }) : tx.rich('sub.subscribed_from', { master: m })))(html`<a href="${BASE}/apps/${sub.master_app_id}/subscriptions">${sub.master_name}</a>`)}</p>
          <form method="post" action="${BASE}/apps/${appId}/subscriptions/refresh" class="u-inline">${csrf(s)}${hidden}<button class="btn btn-sm">${tx('sub.refresh_from', { master: sub.master_name })}</button></form>`
      : ''}
    ${subscribers
      ? html`<p>${subscribers === 1 ? tx('sub.subscribers_1', { kind: kindLabel(kind).toLowerCase() }) : tx('sub.subscribers_n', { n: subscribers, kind: kindLabel(kind).toLowerCase() })}</p>
          <form method="post" action="${BASE}/apps/${appId}/subscriptions/publish" class="u-inline">${csrf(s)}${hidden}<button class="btn btn-sm">${tx('sub.publish_to_subscribers')}</button></form>
          <a class="btn btn-sm" href="${BASE}/apps/${appId}/subscriptions">${tx('sub.subscribers')}</a>`
      : ''}
  </section>`;
}

export async function subscriptionRoutes(app: FastifyInstance) {
  app.get(`${BASE}/apps/:id/subscriptions`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appRow(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const [subs, subscribers, offered, groupList] = await Promise.all([subscriptionsOf(a.id), subscribersOf(a.id), offers(a.id), groupsOffered(a.id)]);
    const sync = await Promise.all(subs.map((x) => inSync(x)));
    const subSync = await Promise.all(subscribers.map((x) => inSync(x)));
    const hidden = (kind: string, name: string) => html`<input type="hidden" name="kind" value="${kind}"><input type="hidden" name="name" value="${name}">`;
    const state = (ok: boolean) => (ok ? html`<span class="badge">${tx('sub.in_sync')}</span>` : html`<span class="badge badge-warn">differs</span>`);
    const groups = new Map<number, typeof offered>();
    for (const o of offered) groups.set(o.master.id, [...(groups.get(o.master.id) ?? []), o]);
    const published = [...new Map(subscribers.map((x) => [`${x.kind}|${x.name}`, x])).values()];

    const main = html`${appHeader(a, 'shared', s)}<div class="ide-body">
      ${region(tx('sub.application_type'), html`<p class="u-mt0">${tx.rich('sub.type_line', { type: html`<b>${typeLabel(a.app_type as AppType)}</b>`, help: tx.dyn(`sub.th.${a.app_type}`, TYPE_HELP[a.app_type as AppType] ?? ''), settings: html`<a href="${BASE}/apps/${a.id}/settings">${tx('sub.settings')}</a>` })}</p>`)}
      ${region(tx('sub.subscriptions'), html`
        <p class="muted u-mt0">${tx('sub.components_of_this_application_that')}</p>
        ${subs.length
          ? html`<div class="table-wrap"><table class="report"><thead><tr><th>${tx('sub.component')}</th><th>${tx('sub.from')}</th><th>${tx('sub.refreshed')}</th><th>${tx('sub.state')}</th><th>${tx('sub.actions')}</th></tr></thead><tbody>
              ${subs.map((x, i) => html`<tr><td>${what(x.kind, x.name)}</td><td><a href="${BASE}/apps/${x.master_app_id}/subscriptions">${x.master_name}</a></td>
                <td>${x.refreshed_at ? x.refreshed_at.slice(0, 16) : '—'}</td><td>${state(sync[i])}</td>
                <td><form method="post" action="${BASE}/apps/${a.id}/subscriptions/refresh" class="u-inline">${csrf(s)}${hidden(x.kind, x.name)}<button class="btn btn-sm">${tx('sub.refresh')}</button></form>
                  <form method="post" action="${BASE}/apps/${a.id}/subscriptions/unsubscribe" class="u-inline">${csrf(s)}${hidden(x.kind, x.name)}<button class="btn btn-sm" data-confirm="${tx('sub.unsubscribe_the_component_stays_as')}">${tx('sub.unsubscribe')}</button></form></td></tr>`)}
            </tbody></table></div>
            <form method="post" action="${BASE}/apps/${a.id}/subscriptions/refresh">${csrf(s)}<div class="buttons"><button class="btn">${tx('sub.refresh_all')}</button></div></form>`
          : html`<p class="muted">${tx('sub.no_subscriptions')}</p>`}
        <h3>${tx('sub.subscribe')}</h3>
        ${offered.length
          ? html`<form method="post" action="${BASE}/apps/${a.id}/subscriptions">${csrf(s)}
              <div class="field"><label class="label" for="f_component">${tx('sub.component')}</label>
                <select id="f_component" name="component" required><option value="">${tx('sub.choose_dash')}</option>
                  ${[...groups.values()].map((list) => html`<optgroup label="${list[0].master.name} (${typeLabel(list[0].master.app_type)})">
                    ${list.map((o) => html`<option value="${o.master.id}|${o.kind}|${o.name}">${what(o.kind, o.name)}</option>`)}</optgroup>`)}
                </select>
                <small class="help">${tx('sub.the_component_is_copied_now')}</small></div>
              <div class="buttons"><button class="btn btn-hot">${tx('sub.subscribe')}</button></div></form>`
          : html`<p class="muted">${tx('sub.no_theme_or_library_applications')}</p>`}
        ${groupList.length
          ? html`<h3>${tx('sub.subscribe_to_a_component_group')}</h3>
            <form method="post" action="${BASE}/apps/${a.id}/subscriptions/group">${csrf(s)}
              <div class="field"><label class="label" for="f_group">${tx('sub.component_group')}</label>
                <select id="f_group" name="group" required><option value="">${tx('sub.choose_dash')}</option>
                  ${groupList.map((g) => html`<option value="${g.master_id}|${g.name}">${g.master_name}: ${g.name} (${g.members.length})</option>`)}
                </select>
                <small class="help">${tx('sub.every_component_of_the_group')}</small></div>
              <div class="buttons"><button class="btn btn-hot">${tx('sub.subscribe_to_the_group')}</button></div></form>`
          : ''}`)}
      ${a.app_type === 'theme' || a.app_type === 'library' || subscribers.length
        ? region(tx('sub.subscribers_2'), subscribers.length
            ? html`<div class="table-wrap"><table class="report"><thead><tr><th>${tx('sub.component')}</th><th>${tx('sub.application')}</th><th>${tx('sub.refreshed')}</th><th>${tx('sub.state')}</th></tr></thead><tbody>
                ${subscribers.map((x, i) => html`<tr><td>${what(x.kind, x.name)}</td><td><a href="${BASE}/apps/${x.app_id}/subscriptions">${x.app_name}</a></td>
                  <td>${x.refreshed_at ? x.refreshed_at.slice(0, 16) : '—'}</td><td>${state(subSync[i])}</td></tr>`)}
              </tbody></table></div>
              <h3>${tx('sub.publish')}</h3>
              <p class="muted u-mt0">${tx('sub.publishing_refreshes_every_subscriber_of')}</p>
              <div class="buttons publish-buttons">${published.map((x) => html`<form method="post" action="${BASE}/apps/${a.id}/subscriptions/publish" class="u-inline">${csrf(s)}${hidden(x.kind, x.name)}
                <button class="btn btn-sm">${icon('upload')} ${what(x.kind, x.name)}</button></form>`)}</div>`
            : html`<p class="muted">${tx('sub.no_application_subscribes_to_this')}</p>`)
        : ''}
    </div>`;
    return send(reply, s, shell(s, tx('sub.title', { app: a.name }), [[tx('sub.app_builder'), BASE], [a.name, `${BASE}/apps/${a.id}`], [tx('sub.shared_components'), `${BASE}/apps/${a.id}/shared`], [tx('sub.subscriptions')]], main));
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
      if (!m) throw new SubscriptionError(tx('sub.choose_component'));
      await subscribe(a.id, Number(m[1]), m[2], m[3], s.username!);
      await logActivity({ appId: a.id, username: s.username, event: 'subscription', ip: clientIp(req), detail: `subscribed ${m[2]} ${m[3]} from application ${m[1]}` });
      return tx('sub.subscribed', { what: isKind(m[2]) ? what(m[2], m[3]) : m[2] });
    });
  });

  // (105) all the components of a master's component group
  app.post(`${BASE}/apps/:id/subscriptions/group`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appRow(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const m = /^(\d{1,9})\|(.{1,60})$/s.exec(String(req.body?.group ?? ''));
    return handle(req, reply, s, a.id, async () => {
      if (!m) throw new SubscriptionError(tx('sub.choose_group'));
      if (!(await groupsOffered(a.id)).some((g) => g.master_id === Number(m[1]) && g.name === m[2])) throw new SubscriptionError(tx('sub.choose_group'));
      const { done, skipped } = await subscribeGroup(a.id, Number(m[1]), m[2], s.username!);
      await logActivity({ appId: a.id, username: s.username, event: 'subscription', ip: clientIp(req), detail: `subscribed component group ${m[2]} from application ${m[1]}: ${done.join(', ')}` });
      const one = done.length === 1;
      return skipped.length ? tx(one ? 'sub.subscribed_group_skipped_1' : 'sub.subscribed_group_skipped', { group: m[2], n: done.length, skipped: skipped.join(', ') }) : tx(one ? 'sub.subscribed_group_1' : 'sub.subscribed_group', { group: m[2], n: done.length });
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
      if (!(await unsubscribe(a.id, String(req.body?.kind ?? ''), String(req.body?.name ?? '')))) throw new SubscriptionError(tx('sub.not_subscribed'));
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
      if (!r.done.length && !r.skipped.length) throw new SubscriptionError(tx('sub.no_subscriber'));
      const one = r.done.length === 1;
      return r.skipped.length ? tx(one ? 'sub.published_skipped_1' : 'sub.published_skipped', { n: r.done.length, skipped: r.skipped.length }) : tx(one ? 'sub.published_1' : 'sub.published', { n: r.done.length });
    });
  });
}
