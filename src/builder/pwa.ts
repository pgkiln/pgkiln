import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { appPublicKey, newAppKeys } from '../push.ts';
import { secretKeyConfigured } from '../secrets.ts';
import { html, raw } from '../html.ts';
import { readMultipart } from '../runtime/files.ts';
import { back, BASE, csrf, developer, flash, input, type Body, type Req } from './ui.ts';
import type { Session } from '../session.ts';

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

export async function pwaSection(a: { id: number; alias: string; pwa: boolean; pwa_short_name: string | null; pwa_offline_pages: boolean; pwa_offline_submit: boolean; pwa_push: boolean; has_icon: boolean }, s: Session) {
  const check = (name: string, label: string, on: boolean, help: string) =>
    html`<div class="field"><label class="check"><input type="checkbox" name="${name}" value="true"${on ? raw(' checked') : ''}> ${label}</label><small class="help">${help}</small></div>`;
  const stats = a.pwa && a.pwa_push ? await pushStats(a.id) : null;
  return html`<form method="post" action="${BASE}/apps/${a.id}/pwa" enctype="multipart/form-data">${csrf(s)}
    ${check('pwa', 'Installable (Progressive Web App)', a.pwa, 'Phones and computers can install the app: its own icon, full screen, and the app works on with a bad or no connection.')}
    <div class="form-grid">
      ${input('pwa_short_name', 'Name under the icon', a.pwa_short_name ?? '', { placeholder: 'at most 12 characters work best' })}
    </div>
    ${check('pwa_offline_pages', 'Keep visited pages on the device for offline use', a.pwa_offline_pages, 'The pages a user opened are shown when there is no connection. They contain personal data: they are removed when someone signs in or out on the device.')}
    ${check('pwa_offline_submit', 'Keep forms sent without a connection, and send them later', a.pwa_offline_submit, 'For field work: forms (with photos) are kept on the device and sent when the connection is back, under the same user, at most once.')}
    ${check('pwa_push', 'Push notifications', a.pwa_push, 'Users turn them on per device under My account (or with the dynamic action push_subscribe); application code sends them with meta.send_push(user, title, body, page, items) or a send_push process. On iPhone and iPad only after the app was added to the home screen. Needs PGKILN_SECRET_KEY: the key that signs them is stored encrypted.')}
    <div class="field" data-wide><label class="label" for="f_pwa_icon">Icon (PNG, square, at least 512 × 512)</label>
      <div class="u-row">${a.has_icon || a.pwa ? html`<img class="pwa-icon-preview" src="/a/${a.alias}/icon-192.png" alt="The app's icon" width="48" height="48">` : ''}
        <input type="file" id="f_pwa_icon" name="icon" accept="image/png"></div>
      <small class="help">${a.has_icon ? html`An icon is stored. <label class="check u-inline"><input type="checkbox" name="remove_icon" value="true"> Remove it</label>` : 'Without one, the app gets a tile with its initial in the accent colour.'}</small></div>
    <div class="buttons"><button class="btn btn-hot">Save</button></div>
  </form>
  ${stats
    ? html`<h3>Push notifications</h3>
      <p class="muted">${stats.devices} device(s) of ${stats.users} user(s) receive notifications. Last 7 days: ${stats.sent} sent, ${stats.no_device} to users without a device, ${stats.failed} failed${stats.waiting ? `, ${stats.waiting} waiting` : ''}.</p>
      <form method="post" action="${BASE}/apps/${a.id}/pwa/push-test" class="u-row">${csrf(s)}
        ${input('push_user', 'Send a test notification to', s.username ?? '', { placeholder: 'user name' })}
        <div class="buttons"><button class="btn">Send test</button></div>
      </form>
      <form method="post" action="${BASE}/apps/${a.id}/pwa/push-keys">${csrf(s)}
        <div class="buttons"><button class="btn btn-danger">New keys</button></div>
        <small class="help">Makes a new key pair (for example after the private key may have leaked). Every device stops receiving notifications until its user turns them on again.</small>
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
    const target = `${BASE}/apps/${id}/settings`;
    const a = /^\d+$/.test(id) ? await owner.one('select id from meta.app where id = $1', [id]) : undefined;
    if (!a) return reply.code(404).send('Not found');
    const b = req.body ?? {};
    let icon: Buffer | null | undefined; // undefined: keep
    if (b.remove_icon === 'true') icon = null;
    if (file && file.data.length) {
      const size = file.truncated ? null : pngSize(file.data);
      if (!size) {
        flash(s, file.truncated ? `The icon is larger than ${ICON_MAX_MB} MB.` : 'The icon must be a PNG image.', 'error');
        return back(reply, s, target);
      }
      if (size.width !== size.height || size.width < 512) {
        flash(s, `The icon must be square and at least 512 × 512 pixels (this one is ${size.width} × ${size.height}).`, 'error');
        return back(reply, s, target);
      }
      icon = file.data;
    }
    const push = b.pwa_push === 'true';
    if (push && !secretKeyConfigured()) {
      flash(s, 'Push notifications need PGKILN_SECRET_KEY in the server\'s environment (the key that signs them is stored encrypted).', 'error');
      return back(reply, s, target);
    }
    await owner.query(
      `update meta.app set pwa = $2, pwa_short_name = $3, pwa_offline_pages = $4, pwa_offline_submit = $5,
              pwa_icon = case when $7 then $6 else pwa_icon end, pwa_push = $8, updated_at = now() where id = $1`,
      [id, b.pwa === 'true', (b.pwa_short_name ?? '').trim().slice(0, 30) || null, b.pwa_offline_pages === 'true', b.pwa_offline_submit === 'true', icon ?? null, icon !== undefined, push],
    );
    if (push) await appPublicKey(Number(id));
    flash(s, push && b.pwa !== 'true' ? 'Saved. Push notifications work only when the app is installable.' : 'Progressive Web App settings saved.');
    return back(reply, s, target);
  });

  app.post(`${BASE}/apps/:id/pwa/push-test`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const id = req.params.id;
    const target = `${BASE}/apps/${id}/settings`;
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
    flash(s, devices ? `Test notification queued for ${devices} device(s) of ${user}.` : `${user} has not turned on notifications on any device (My account → Notifications).`, devices ? 'ok' : 'error');
    return back(reply, s, target);
  });

  app.post(`${BASE}/apps/:id/pwa/push-keys`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const id = req.params.id;
    if (!/^\d+$/.test(id) || !(await owner.one('select 1 from meta.app where id = $1', [id]))) return reply.code(404).send('Not found');
    await newAppKeys(Number(id));
    flash(s, 'New keys made. Users have to turn notifications on again on each device.');
    return back(reply, s, `${BASE}/apps/${id}/settings`);
  });
}
