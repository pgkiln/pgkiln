import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw } from '../html.ts';
import { readMultipart } from '../runtime/files.ts';
import { back, BASE, csrf, developer, flash, input, type Body, type Req } from './ui.ts';
import type { Session } from '../session.ts';

// App → Settings → Progressive Web App: installable, offline pages, the
// offline form queue, the icon (src/runtime/pwa.ts serves the rest).

const ICON_MAX_MB = 1;

/** A PNG's width and height, or null when it isn't a PNG. */
export function pngSize(data: Buffer): { width: number; height: number } | null {
  if (data.length < 24 || data.readUInt32BE(0) !== 0x89504e47 || data.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

export function pwaSection(a: { id: number; alias: string; pwa: boolean; pwa_short_name: string | null; pwa_offline_pages: boolean; pwa_offline_submit: boolean; has_icon: boolean }, s: Session) {
  const check = (name: string, label: string, on: boolean, help: string) =>
    html`<div class="field"><label class="check"><input type="checkbox" name="${name}" value="true"${on ? raw(' checked') : ''}> ${label}</label><small class="help">${help}</small></div>`;
  return html`<form method="post" action="${BASE}/apps/${a.id}/pwa" enctype="multipart/form-data">${csrf(s)}
    ${check('pwa', 'Installable (Progressive Web App)', a.pwa, 'Phones and computers can install the app: its own icon, full screen, and the app works on with a bad or no connection.')}
    <div class="form-grid">
      ${input('pwa_short_name', 'Name under the icon', a.pwa_short_name ?? '', { placeholder: 'at most 12 characters work best' })}
    </div>
    ${check('pwa_offline_pages', 'Keep visited pages on the device for offline use', a.pwa_offline_pages, 'The pages a user opened are shown when there is no connection. They contain personal data: they are removed when someone signs in or out on the device.')}
    ${check('pwa_offline_submit', 'Keep forms sent without a connection, and send them later', a.pwa_offline_submit, 'For field work: forms (with photos) are kept on the device and sent when the connection is back, under the same user, at most once.')}
    <div class="field" data-wide><label class="label" for="f_pwa_icon">Icon (PNG, square, at least 512 × 512)</label>
      <div class="u-row">${a.has_icon || a.pwa ? html`<img class="pwa-icon-preview" src="/a/${a.alias}/icon-192.png" alt="The app's icon" width="48" height="48">` : ''}
        <input type="file" id="f_pwa_icon" name="icon" accept="image/png"></div>
      <small class="help">${a.has_icon ? html`An icon is stored. <label class="check u-inline"><input type="checkbox" name="remove_icon" value="true"> Remove it</label>` : 'Without one, the app gets a tile with its initial in the accent colour.'}</small></div>
    <div class="buttons"><button class="btn btn-hot">Save</button></div>
  </form>`;
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
    await owner.query(
      `update meta.app set pwa = $2, pwa_short_name = $3, pwa_offline_pages = $4, pwa_offline_submit = $5,
              pwa_icon = case when $7 then $6 else pwa_icon end, updated_at = now() where id = $1`,
      [id, b.pwa === 'true', (b.pwa_short_name ?? '').trim().slice(0, 30) || null, b.pwa_offline_pages === 'true', b.pwa_offline_submit === 'true', icon ?? null, icon !== undefined],
    );
    flash(s, 'Progressive Web App settings saved.');
    return back(reply, s, target);
  });
}
