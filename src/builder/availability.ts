import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw } from '../html.ts';
import { clientIp, logActivity } from '../session.ts';
import { appOr404 } from './forms.ts';
import { appHeader, back, BASE, csrf, developer, flash, region, select, send, shell, type Req } from './ui.ts';
import { scopedTx as tx, type BuilderKey } from './i18n.ts';

// Application → Availability (APEX: Application Availability and Build Status,
// migration 083): who may use the running application, the message they see
// otherwise, and whether the builder may change it (Run only). Allowed on a
// Run only application (src/builder/locks.ts), logged as "availability".

const MODE_KEYS: [string, BuilderKey][] = [
  ['available', 'avl.mode.available'],
  ['developers', 'avl.mode.developers'],
  ['restricted', 'avl.mode.restricted'],
  ['unavailable', 'avl.mode.unavailable'],
];
/** The statuses with their labels in the developer's language. */
const modes = (): [string, string][] => MODE_KEYS.map(([v, k]) => [v, tx(k)]);

export async function availabilityRoutes(app: FastifyInstance) {
  app.get(`${BASE}/apps/:id(^\\d+$)/availability`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOr404(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const body = region(tx('app.head.availability'), html`<form method="post" action="${BASE}/apps/${a.id}/availability">${csrf(s)}
      <p class="muted u-mt0">${tx('avl.intro')}</p>
      <div class="form-grid">
        ${select('availability', tx('avl.status'), a.availability, modes())}
        <div class="field" data-wide><label class="label" for="f_message">${tx('avl.message')}</label>
          <textarea id="f_message" name="message" rows="3" maxlength="2000">${a.availability_message ?? ''}</textarea>
          <small class="help">${tx('avl.message_help')}</small></div>
        <div class="field" data-wide><label class="label" for="f_users">${tx('avl.users')}</label>
          <textarea id="f_users" name="users" rows="2">${(a.availability_users ?? []).join(', ')}</textarea>
          <small class="help">${tx('avl.users_help')}</small></div>
        ${select('build_status', tx('avl.build_status'), a.build_status, [['run_and_build', tx('avl.run_and_build')], ['run_only', tx('avl.run_only')]],
          tx('avl.build_status_help'))}
      </div>
      <div class="buttons"><button class="btn btn-hot">${tx('common.save')}</button></div></form>`);
    const main = html`${appHeader(a, 'settings', s)}<div class="ide-body">${body}</div>`;
    return send(reply, s, shell(s, tx('avl.page_title', { name: a.name }), [[tx('rail.app_builder'), BASE], [a.name, `${BASE}/apps/${a.id}`], [tx('app.head.availability')]], main));
  });

  app.post(`${BASE}/apps/:id(^\\d+$)/availability`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = req.body ?? {};
    const mode = MODE_KEYS.some(([v]) => v === b.availability) ? b.availability : 'available';
    const users = [...new Set(String(b.users ?? '').split(/[\s,;]+/).map((u) => u.trim()).filter(Boolean))];
    if (users.some((u) => u.length > 100 || /[:\s]/.test(u))) {
      flash(s, tx('avl.users_invalid'), 'error');
      return back(reply, s, `${BASE}/apps/${req.params.id}/availability`);
    }
    const build = b.build_status === 'run_only' ? 'run_only' : 'run_and_build';
    const r = await owner.query(
      `update meta.app set availability = $2, availability_message = $3, availability_users = $4, build_status = $5, updated_at = now() where id = $1`,
      [req.params.id, mode, String(b.message ?? '').trim().slice(0, 2000) || null, users, build]);
    if (r.rowCount) await logActivity({ appId: Number(req.params.id), username: s.username, event: 'availability', ip: clientIp(req), detail: `${mode}, ${build}` });
    flash(s, r.rowCount ? tx('avl.saved') : tx('avl.not_found'), r.rowCount ? 'ok' : 'error');
    return back(reply, s, `${BASE}/apps/${req.params.id}/availability`);
  });
}

/** A badge for an application that is not simply available, or Run only. */
export const availabilityBadge = (a: { id: number; availability?: string; build_status?: string }) =>
  a.availability && a.availability !== 'available' || a.build_status === 'run_only'
    ? html`<a class="tag tag-warning availability-badge" href="${BASE}/apps/${a.id}/availability">${[
        a.availability && a.availability !== 'available' ? modes().find(([v]) => v === a.availability)?.[1] : null,
        a.build_status === 'run_only' ? tx('avl.run_only') : null,
      ].filter(Boolean).join(' · ')}</a>`
    : raw('');
