import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw } from '../html.ts';
import { clientIp, logActivity } from '../session.ts';
import { appOr404 } from './forms.ts';
import { appHeader, back, BASE, csrf, developer, flash, region, select, send, shell, type Req } from './ui.ts';

// Application → Availability (APEX: Application Availability and Build Status,
// migration 083): who may use the running application, the message they see
// otherwise, and whether the builder may change it (Run only). Allowed on a
// Run only application (src/builder/locks.ts), logged as "availability".

const MODES: [string, string][] = [
  ['available', 'Available'],
  ['developers', 'Available to developers only'],
  ['restricted', 'Restricted to the users below (and developers)'],
  ['unavailable', 'Unavailable'],
];

export async function availabilityRoutes(app: FastifyInstance) {
  app.get(`${BASE}/apps/:id(^\\d+$)/availability`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOr404(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const body = region('Availability', html`<form method="post" action="${BASE}/apps/${a.id}/availability">${csrf(s)}
      <p class="muted u-mt0">Who may use the running application. Developers are those signed in to the builder in the same browser
        (they see the developer toolbar). Pages, file downloads, REST modules and the REST API follow this setting; automations,
        workflows, background jobs and queued mail keep running. It belongs to this installation: exports leave it out and an
        import over the application keeps it.</p>
      <div class="form-grid">
        ${select('availability', 'Status', a.availability, MODES)}
        <div class="field" data-wide><label class="label" for="f_message">Message</label>
          <textarea id="f_message" name="message" rows="3" maxlength="2000">${a.availability_message ?? ''}</textarea>
          <small class="help">Shown when the application is unavailable or for developers only, e.g. "We are upgrading the application; back at 14:00." Empty: a standard message in the user's language.</small></div>
        <div class="field" data-wide><label class="label" for="f_users">Users (restricted)</label>
          <textarea id="f_users" name="users" rows="2">${(a.availability_users ?? []).join(', ')}</textarea>
          <small class="help">User names separated by commas or spaces. They sign in as usual; others get "not available to your account".</small></div>
        ${select('build_status', 'Build status', a.build_status, [['run_and_build', 'Run and build'], ['run_only', 'Run only']],
          'Run only: the builder refuses changes to the application (pages, shared components, settings, restores) until it is set back here. pgkiln import --replace still deploys it.')}
      </div>
      <div class="buttons"><button class="btn btn-hot">Save</button></div></form>`);
    const main = html`${appHeader(a, 'settings')}<div class="ide-body">${body}</div>`;
    return send(reply, s, shell(s, `${a.name} availability`, [['App Builder', BASE], [a.name, `${BASE}/apps/${a.id}`], ['Availability']], main));
  });

  app.post(`${BASE}/apps/:id(^\\d+$)/availability`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = req.body ?? {};
    const mode = MODES.some(([v]) => v === b.availability) ? b.availability : 'available';
    const users = [...new Set(String(b.users ?? '').split(/[\s,;]+/).map((u) => u.trim()).filter(Boolean))];
    if (users.some((u) => u.length > 100 || /[:\s]/.test(u))) {
      flash(s, 'User names are at most 100 characters, without spaces or colons.', 'error');
      return back(reply, s, `${BASE}/apps/${req.params.id}/availability`);
    }
    const build = b.build_status === 'run_only' ? 'run_only' : 'run_and_build';
    const r = await owner.query(
      `update meta.app set availability = $2, availability_message = $3, availability_users = $4, build_status = $5, updated_at = now() where id = $1`,
      [req.params.id, mode, String(b.message ?? '').trim().slice(0, 2000) || null, users, build]);
    if (r.rowCount) await logActivity({ appId: Number(req.params.id), username: s.username, event: 'availability', ip: clientIp(req), detail: `${mode}, ${build}` });
    flash(s, r.rowCount ? 'Availability saved.' : 'Not found.', r.rowCount ? 'ok' : 'error');
    return back(reply, s, `${BASE}/apps/${req.params.id}/availability`);
  });
}

/** A badge for an application that is not simply available, or Run only. */
export const availabilityBadge = (a: { id: number; availability?: string; build_status?: string }) =>
  a.availability && a.availability !== 'available' || a.build_status === 'run_only'
    ? html`<a class="tag tag-warning availability-badge" href="${BASE}/apps/${a.id}/availability">${[
        a.availability && a.availability !== 'available' ? MODES.find(([v]) => v === a.availability)?.[1] : null,
        a.build_status === 'run_only' ? 'Run only' : null,
      ].filter(Boolean).join(' · ')}</a>`
    : raw('');
