import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { appPublicKey, newAppKeys } from '../push.ts';
import { secretKeyConfigured } from '../secrets.ts';
import { html, raw } from '../html.ts';
import { readMultipart } from '../runtime/files.ts';
import { back, BASE, csrf, developer, flash, input, type Body, type Req } from './ui.ts';
import type { Session } from '../session.ts';
import { scopedTx as tx } from './i18n.ts';

// App → Settings → Progressive Web App: installable, offline pages, the
// offline form queue, the icon (src/runtime/pwa.ts serves the rest), and
// push notifications (074; src/push.ts): devices, a test, new keys.

const ICON_MAX_MB = 1;

/** A PNG's width and height, or null when it isn't a PNG. */
export function pngSize(data: Buffer): { width: number; height: number } | null {
  if (data.length < 24 || data.readUInt32BE(0) !== 0x89504e47 || data.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

/** Devices and the last week's notifications of an app. */
async function pushStats(appId: number) {
  return (await owner.one<{ devices: number; users: number; sent: number; no_device: number; failed: number; waiting: number }>(
    `select (select count(*)::int from meta.push_subscription where app_id = $1) as devices,
            (select count(distinct lower(username))::int from meta.push_subscription where app_id = $1) as users,
            count(*) filter (where status = 'sent')::int as sent, count(*) filter (where status = 'no_device')::int as no_device,
            count(*) filter (where status = 'error')::int as failed, count(*) filter (where status in ('queued', 'sending'))::int as waiting
       from meta.push_message where app_id = $1`,
    [appId],
  ))!;
}

export async function pwaSection(a: { id: number; alias: string; pwa: boolean; pwa_short_name: string | null; pwa_offline_pages: boolean; pwa_prefetch_hours: number | null; pwa_offline_submit: boolean; pwa_push: boolean; has_icon: boolean }, s: Session) {
  const check = (name: string, label: string, on: boolean, help: string) =>
    html`<div class="field"><label class="check"><input type="checkbox" name="${name}" value="true"${on ? raw(' checked') : ''}> ${label}</label><small class="help">${help}</small></div>`;
  const stats = a.pwa && a.pwa_push ? await pushStats(a.id) : null;
  return html`<form method="post" action="${BASE}/apps/${a.id}/pwa" enctype="multipart/form-data">${csrf(s)}
    ${check('pwa', tx('pwa.installable'), a.pwa, tx('pwa.installable_help'))}
    <div class="form-grid">
      ${input('pwa_short_name', tx('pwa.short_name'), a.pwa_short_name ?? '', { placeholder: tx('pwa.short_name_ph') })}
    </div>
    ${check('pwa_offline_pages', tx('pwa.offline_pages'), a.pwa_offline_pages, tx('pwa.offline_pages_help'))}
    ${check('pwa_prefetch', tx('pwa.prefetch'), a.pwa_prefetch_hours !== null, tx('pwa.prefetch_help'))}
    <div class="form-grid">
      ${input('pwa_prefetch_hours', tx('pwa.prefetch_hours'), a.pwa_prefetch_hours ?? 12, { type: 'number', help: tx('pwa.prefetch_hours_help') })}
    </div>
    ${check('pwa_offline_submit', tx('pwa.offline_submit'), a.pwa_offline_submit, tx('pwa.offline_submit_help'))}
    ${check('pwa_push', tx('pwa.push'), a.pwa_push, tx('pwa.push_help'))}
    <div class="field" data-wide><label class="label" for="f_pwa_icon">${tx('pwa.icon')}</label>
      <div class="u-row">${a.has_icon || a.pwa ? html`<img class="pwa-icon-preview" src="/a/${a.alias}/icon-192.png" alt="${tx('pwa.icon_alt')}" width="48" height="48">` : ''}
        <input type="file" id="f_pwa_icon" name="icon" accept="image/png"></div>
      <small class="help">${a.has_icon ? html`${tx('pwa.icon_stored')} <label class="check u-inline"><input type="checkbox" name="remove_icon" value="true"> ${tx('pwa.remove_icon')}</label>` : tx('pwa.no_icon')}</small></div>
    <div class="buttons"><button class="btn btn-hot">${tx('common.save')}</button></div>
  </form>
  ${stats
    ? html`<h3>${tx('pwa.push')}</h3>
      <p class="muted">${tx('pwa.stats_devices', { devices: stats.devices, users: stats.users })} ${tx(stats.waiting ? 'pwa.stats_week_waiting' : 'pwa.stats_week', { sent: stats.sent, no_device: stats.no_device, failed: stats.failed, waiting: stats.waiting })}</p>
      <form method="post" action="${BASE}/apps/${a.id}/pwa/push-test" class="u-row">${csrf(s)}
        ${input('push_user', tx('pwa.test_to'), s.username ?? '', { placeholder: tx('pwa.user_name') })}
        <div class="buttons"><button class="btn">${tx('pwa.send_test')}</button></div>
      </form>
      <form method="post" action="${BASE}/apps/${a.id}/pwa/push-keys">${csrf(s)}
        <div class="buttons"><button class="btn btn-danger">${tx('pwa.new_keys')}</button></div>
        <small class="help">${tx('pwa.new_keys_help')}</small>
      </form>`
    : ''}`;
}

export async function pwaBuilderRoutes(app: FastifyInstance) {
  app.post(`${BASE}/apps/:id/pwa`, async (req: Req, reply) => {
    let file;
    if (req.isMultipart()) {
      const parsed = await readMultipart(req, ICON_MAX_MB);
      req.body = parsed.body as Body;
      file = parsed.files.get('icon');
    }
    const s = await developer(req, reply);
    if (!s) return;
    const id = req.params.id;
    const target = `${BASE}/apps/${id}/settings?tab=pwa`;
    const a = /^\d+$/.test(id) ? await owner.one('select id from meta.app where id = $1', [id]) : undefined;
    if (!a) return reply.code(404).send('Not found');
    const b = req.body ?? {};
    let icon: Buffer | null | undefined; // undefined: keep
    if (b.remove_icon === 'true') icon = null;
    if (file && file.data.length) {
      const size = file.truncated ? null : pngSize(file.data);
      if (!size) {
        flash(s, file.truncated ? tx('pwa.icon_too_large', { mb: ICON_MAX_MB }) : tx('pwa.icon_not_png'), 'error');
        return back(reply, s, target);
      }
      if (size.width !== size.height || size.width < 512) {
        flash(s, tx('pwa.icon_size', { width: size.width, height: size.height }), 'error');
        return back(reply, s, target);
      }
      icon = file.data;
    }
    const push = b.pwa_push === 'true';
    if (push && !secretKeyConfigured()) {
      flash(s, tx('pwa.push_needs_key'), 'error');
      return back(reply, s, target);
    }
    // (168) every navigation page offline: only with visited pages kept, every 1 to 168 hours
    const hours = Number(b.pwa_prefetch_hours ?? 12);
    if (b.pwa_prefetch === 'true' && (!Number.isInteger(hours) || hours < 1 || hours > 168)) {
      flash(s, tx('pwa.prefetch_hours_range'), 'error');
      return back(reply, s, target);
    }
    const prefetch = b.pwa_prefetch === 'true' && b.pwa_offline_pages === 'true' ? hours : null;
    await owner.query(
      `update meta.app set pwa = $2, pwa_short_name = $3, pwa_offline_pages = $4, pwa_offline_submit = $5,
              pwa_icon = case when $7 then $6 else pwa_icon end, pwa_push = $8, pwa_prefetch_hours = $9, updated_at = now() where id = $1`,
      [id, b.pwa === 'true', (b.pwa_short_name ?? '').trim().slice(0, 30) || null, b.pwa_offline_pages === 'true', b.pwa_offline_submit === 'true', icon ?? null, icon !== undefined, push, prefetch],
    );
    if (push) await appPublicKey(Number(id));
    flash(s, push && b.pwa !== 'true' ? tx('pwa.saved_not_installable') : tx('pwa.saved'));
    return back(reply, s, target);
  });

  app.post(`${BASE}/apps/:id/pwa/push-test`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const id = req.params.id;
    const target = `${BASE}/apps/${id}/settings?tab=pwa`;
    const a = /^\d+$/.test(id) ? await owner.one<{ id: number; name: string }>('select id, name from meta.app where id = $1', [id]) : undefined;
    if (!a) return reply.code(404).send('Not found');
    const user = String(req.body?.push_user ?? '').trim();
    try {
      // as application code would: meta.send_push checks everything (the app has notifications on, the user name)
      await owner.tx(async (c) => {
        await c.query(`select set_config('pgkiln.app_id', $1, true), set_config('pgkiln.app_user', $2, true)`, [String(a.id), s.username ?? 'builder']);
        await c.query(`select meta.send_push($1, $2, $3)`, [user, `Test notification · ${a.name}`.slice(0, 200), 'Sent from the App Builder.']);
      });
    } catch (e) {
      flash(s, (e as Error).message.replace(/^meta\.send_push: /, ''), 'error');
      return back(reply, s, target);
    }
    const devices = (await owner.one<{ n: number }>('select count(*)::int as n from meta.push_subscription where app_id = $1 and lower(username) = lower($2)', [a.id, user]))!.n;
    flash(s, devices ? tx('pwa.test_queued', { n: devices, user }) : tx('pwa.test_no_device', { user }), devices ? 'ok' : 'error');
    return back(reply, s, target);
  });

  app.post(`${BASE}/apps/:id/pwa/push-keys`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const id = req.params.id;
    if (!/^\d+$/.test(id) || !(await owner.one('select 1 from meta.app where id = $1', [id]))) return reply.code(404).send('Not found');
    await newAppKeys(Number(id));
    flash(s, tx('pwa.keys_made'));
    return back(reply, s, `${BASE}/apps/${id}/settings?tab=pwa`);
  });
}
