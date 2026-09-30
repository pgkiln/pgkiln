import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html } from '../html.ts';
import { icon } from '../icons.ts';
import { readMultipart } from '../runtime/files.ts';
import { layoutPreview, type PdfLayout } from '../runtime/pdf.ts';
import type { Session } from '../session.ts';
import { back, BASE, csrf, developer, flash, type Body, type Req } from './ui.ts';

// Shared Components → Report layouts: the logo and the preview. The other
// settings are edited with the generic component form (components.ts).

const LOGO_MAX_MB = 2;

/** PNG or JPEG, by its first bytes (the browser's MIME type is not trusted). */
export function imageType(b: Buffer): 'image/png' | 'image/jpeg' | null {
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  return null;
}

/** Logo and preview forms under a layout's settings. */
export function layoutExtras(appId: number, row: { id: number; logo: Buffer | null }, s: Session) {
  const base = `${BASE}/apps/${appId}/shared/report_layout/${row.id}`;
  return html`<fieldset class="prop-group" style="margin-top:1.25rem"><legend>Logo image</legend>
      ${row.logo ? html`<p><img src="${base}/logo" alt="Logo of this layout" class="layout-logo"></p>` : html`<p class="muted">No logo. It prints at the top right of the first page.</p>`}
      <form method="post" action="${base}/logo" enctype="multipart/form-data" class="search" style="max-width:none">${csrf(s)}
        <input type="file" name="logo" accept="image/png,image/jpeg" aria-label="Logo (PNG or JPEG)">
        <button class="btn">${icon('upload')} Upload</button>
        ${row.logo ? html`<button class="btn" name="remove" value="1">Remove logo</button>` : ''}
      </form>
    </fieldset>
    <div class="buttons"><a class="btn" href="${base}/preview" target="_blank" rel="noopener">${icon('printer')} Preview PDF</a></div>`;
}

export async function layoutRoutes(app: FastifyInstance) {
  const find = (appId: string, id: string) =>
    /^\d+$/.test(appId) && /^\d+$/.test(id)
      ? owner.one<PdfLayout & { id: number; logo_mime: string | null }>(
          `select l.*, l.font_size::float8 as font_size from meta.report_layout l where l.id = $1 and l.app_id = $2`,
          [id, appId],
        )
      : Promise.resolve(undefined);

  app.post(`${BASE}/apps/:id/shared/report_layout/:cid/logo`, async (req: Req, reply) => {
    let file;
    if (req.isMultipart()) {
      const parsed = await readMultipart(req, LOGO_MAX_MB);
      req.body = parsed.body as Body;
      file = parsed.files.get('logo');
    }
    const s = await developer(req, reply);
    if (!s) return;
    const { id, cid } = req.params as { id: string; cid: string };
    const target = `${BASE}/apps/${id}/shared?c=report_layout-${cid}`;
    if (!(await find(id, cid))) return reply.code(404).send('Not found');
    if (req.body?.remove === '1') {
      await owner.query('update meta.report_layout set logo = null, logo_mime = null where id = $1 and app_id = $2', [cid, id]);
      flash(s, 'Logo removed.');
      return back(reply, s, target);
    }
    const type = file && !file.truncated ? imageType(file.data) : null;
    if (!file) flash(s, 'Choose a PNG or JPEG file.', 'error');
    else if (file.truncated) flash(s, `The logo is larger than ${LOGO_MAX_MB} MB.`, 'error');
    else if (!type) flash(s, 'The logo must be a PNG or JPEG image.', 'error');
    else {
      await owner.query('update meta.report_layout set logo = $3, logo_mime = $4 where id = $1 and app_id = $2', [cid, id, file.data, type]);
      flash(s, 'Logo saved.');
    }
    return back(reply, s, target);
  });

  app.get(`${BASE}/apps/:id/shared/report_layout/:cid/logo`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const { id, cid } = req.params as { id: string; cid: string };
    const l = await find(id, cid);
    if (!l?.logo || !l.logo_mime) return reply.code(404).send('Not found');
    return reply.header('cache-control', 'private, no-store').header('x-content-type-options', 'nosniff').type(l.logo_mime).send(l.logo);
  });

  app.get(`${BASE}/apps/:id/shared/report_layout/:cid/preview`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const { id, cid } = req.params as { id: string; cid: string };
    const l = await find(id, cid);
    if (!l) return reply.code(404).send('Not found');
    const a = await owner.one<{ name: string }>('select name from meta.app where id = $1', [id]);
    const pdf = await layoutPreview(l, a?.name ?? 'Application', s.username ?? 'developer');
    return reply
      .header('content-disposition', `inline; filename="${l.name}-preview.pdf"`)
      .header('cache-control', 'private, no-store')
      .type('application/pdf')
      .send(pdf);
  });
}
