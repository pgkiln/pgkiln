// Items of migration 086: display image (APEX: Display Image), geocoded
// address (APEX: Geocoded Address) and items kept per user across sessions
// (APEX: Maintain session state: Per User, stored in meta.user_preference).
//
// image   shows the item's value as a picture: an https URL, a path of this
//         server, or a data:image URL. With {"sql": "select photo, photo_mime
//         from hr.emp where id = :P3_ID"} the picture is the first column of
//         the query's first row instead (a BLOB), served by
//         GET /a/<alias>/<page>/image/<item> as the application's role.
// address a text item with a "Check address" button: the installation's
//         geocoder (GEOCODER_URL, src/geocode.ts) offers matching addresses;
//         the one chosen replaces the text and its position goes into
//         {"coordinates_item": "P3_LOCATION"} as "lat,lng".
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { applyBinds, bindNames } from '../binds.ts';
import { appTx, savepoint } from '../db.ts';
import { geocode, geocoderUrl } from '../geocode.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import type { Item } from '../metadata.ts';
import { checkPageAccess, computeVisibility, Forbidden } from './authz.ts';
import { bindValues, dbg, publicError, stripSemicolon, substitute, toState, type PageContext } from './context.ts';

type Loader = (req: any, reply: FastifyReply, opts?: { json?: boolean }) => Promise<PageContext | null>;
type Tx = (ctx: PageContext) => Parameters<typeof appTx>[0];

/** Picture types an image item serves (an SVG only sandboxed, as everything here). */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/svg+xml']);
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/=\s]+$/;

/** A pixel size from the item's config (1–2000), or null. */
const px = (v: unknown) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 && n <= 2000 ? n : null;
};

/** Where an image item's picture comes from: a URL the page may show, or null. */
export function imageUrl(ctx: PageContext, item: Item, value: string): string | null {
  if (typeof item.config?.sql === 'string' && item.config.sql.trim()) {
    // the query's binds: a new value gives a new URL (the picture is never cached)
    const used = bindNames(item.config.sql).map((n) => `${n}=${ctx.session.state[n] ?? ''}`).join('&');
    const v = createHash('sha256').update(used).digest('base64url').slice(0, 12);
    return `${ctx.base}/${ctx.page.page_no}/image/${item.name}?v=${v}`;
  }
  const s = value.trim();
  if (!s) return null;
  if (DATA_IMAGE.test(s)) return s;
  if (/^\/(?![/\\])/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    // the page's Content-Security-Policy allows this picture's origin (and no other)
    ctx.imgSrc?.add(u.origin);
    return u.href;
  } catch {
    return null;
  }
}

/** The picture of an image item, or a blank display value. */
export function imageControl(ctx: PageContext, item: Item, value: string): Raw {
  const src = imageUrl(ctx, item, value);
  if (!src) return html`<div class="display-value" id="${item.name}"> </div>`;
  const alt = typeof item.config?.alt === 'string' ? substitute(item.config.alt, ctx, (v) => v) : (item.label ?? '');
  const w = px(item.config?.width);
  const h = px(item.config?.height);
  return html`<div class="display-image" id="${item.name}"><img src="${src}" alt="${alt}"${w ? raw(` width="${w}"`) : ''}${h ? raw(` height="${h}"`) : ''} loading="lazy" decoding="async"></div>`;
}

/** A text input with a "Check address" button (when the installation has a geocoder). */
export function addressControl(ctx: PageContext, item: Item, value: string, aria: Raw): Raw {
  const id = item.name;
  const input = html`<input type="text" id="${id}" name="${id}" value="${value}" autocomplete="street-address"${aria}>`;
  if (!geocoderUrl()) return input;
  const coords = typeof item.config?.coordinates_item === 'string' && /^[A-Z][A-Z0-9_]*$/.test(item.config.coordinates_item) ? item.config.coordinates_item : '';
  return html`<div class="input-with-button">${input}
      <button type="button" class="btn" data-geocode="${id}" data-url="${ctx.base}/${ctx.page.page_no}/geocode/${id}"${coords ? html` data-coords="${coords}"` : ''} aria-controls="${id}_places">${icon('map')} ${ctx.locale.t('item.check_address')}</button></div>
    <ul class="geocode-places" id="${id}_places" role="listbox" aria-label="${ctx.locale.t('item.address_places')}" hidden></ul>`;
}

// ---------------------------------------------------------------- per-user items

/** Items kept per user across sessions ({"persist": "user"}). */
const persisted = (ctx: PageContext) =>
  ctx.app.authentication === 'none' || !ctx.session.username ? [] : ctx.page.items.filter((i) => i.config?.persist === 'user');

/** Before the page renders: the user's values of persisted items not set in this session. */
export async function loadPreferences(ctx: PageContext) {
  const names = persisted(ctx).map((i) => i.name).filter((n) => ctx.session.state[n] === undefined);
  if (!names.length) return;
  const c = ctx.client!;
  const r = await savepoint(c, () => c.query<{ n: string; v: string | null }>('select n, meta.get_preference(n) as v from unnest($1::text[]) n', [names]));
  for (const { n, v } of r.rows) if (v !== null) ctx.session.state[n] = v;
  dbg(ctx, 6, 'session', `per-user items read: ${names.join(', ')}`);
}

/** After a submit: the user's values of the persisted items the page could change. */
export async function savePreferences(ctx: PageContext) {
  const items = persisted(ctx).filter((i) => ctx.vis?.editable.has(i.name));
  if (!items.length) return;
  const c = ctx.client!;
  await c.query('select meta.set_preference(n, v) from unnest($1::text[], $2::text[]) as x(n, v)', [
    items.map((i) => i.name),
    items.map((i) => toState(ctx.session.state[i.name])),
  ]);
}

// ---------------------------------------------------------------- routes

/** One geocoder request per session and second at most. */
const lastGeocode = new Map<string, number>();

export function dataItemRoutes(app: FastifyInstance, loadContext: Loader, txContext: Tx) {
  app.get('/a/:alias/:page/image/:item', async (req: any, reply) => {
    const ctx = await loadContext(req, reply);
    if (!ctx) return;
    const name = String(req.params.item ?? '').toUpperCase();
    try {
      const file = await appTx(txContext(ctx), async (c) => {
        ctx.client = c;
        await checkPageAccess(ctx);
        await computeVisibility(ctx);
        const item = ctx.page.items.find((i) => i.name === name && i.type === 'image');
        if (!item || !ctx.vis!.items.has(name) || typeof item.config?.sql !== 'string') return null;
        const sql = stripSemicolon(applyBinds(item.config.sql, bindValues(ctx)));
        const r = await savepoint(c, () => c.query({ text: `select * from (\n${sql}\n) "__i" limit 1`, rowMode: 'array' }));
        const [content, mime] = (r.rows[0] ?? []) as [unknown, unknown];
        if (!Buffer.isBuffer(content) || !content.length) return null;
        return { content, mime: String(mime ?? '').toLowerCase().split(';')[0].trim() };
      });
      if (!file) return reply.code(404).header('cache-control', 'no-store').type('text/plain').send('');
      if (file.content.length > IMAGE_MAX_BYTES) return reply.code(413).type('text/plain').send('');
      const type = IMAGE_TYPES.has(file.mime) ? file.mime : sniff(file.content);
      if (!type) return reply.code(415).type('text/plain').send('');
      return reply
        .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
        .header('cache-control', 'private, no-store')
        .type(type)
        .send(file.content);
    } catch (e) {
      if (e instanceof Forbidden) return reply.code(403).type('text/plain').send('');
      req.log.warn({ err: e }, 'image item');
      await publicError(ctx, e, `image of ${name}`);
      return reply.code(500).type('text/plain').send('');
    }
  });

  app.post('/a/:alias/:page/geocode/:item', async (req: any, reply) => {
    const ctx = await loadContext(req, reply, { json: true });
    if (!ctx) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.__csrf !== ctx.session.csrf_token) return reply.code(403).send({ error: ctx.locale.t('error.session_reload') });
    const name = String(req.params.item ?? '').toUpperCase();
    const q = typeof body.q === 'string' ? body.q.trim().slice(0, 300) : '';
    if (!geocoderUrl()) return reply.code(404).send({ error: ctx.locale.t('item.address_error') });
    let item: Item | undefined;
    try {
      await appTx(txContext(ctx), async (c) => {
        ctx.client = c;
        await checkPageAccess(ctx);
        await computeVisibility(ctx);
        item = ctx.page.items.find((i) => i.name === name && i.type === 'address');
        if (!item || !ctx.vis!.editable.has(name)) throw new Forbidden(ctx.locale.t('error.action_unavailable'));
      });
    } catch (e) {
      if (e instanceof Forbidden) return reply.code(403).send({ error: e.message });
      throw e;
    }
    if (q.length < 3) return reply.send({ places: [] });
    const now = Date.now();
    if (now - (lastGeocode.get(ctx.session.id) ?? 0) < 1000) return reply.code(429).send({ error: ctx.locale.t('item.address_error') });
    lastGeocode.set(ctx.session.id, now);
    if (lastGeocode.size > 10_000) for (const [k, t] of lastGeocode) if (now - t > 60_000) lastGeocode.delete(k);
    try {
      const country = typeof item!.config?.country === 'string' ? item!.config.country : null;
      const places = await geocode(q, { language: ctx.locale.lang, country });
      return reply.header('cache-control', 'no-store').send({ places });
    } catch (e) {
      req.log.warn({ err: e }, 'geocoder');
      return reply.code(502).send({ error: ctx.locale.t('item.address_error') });
    }
  });
}

/** The picture type from the first bytes, when the query gave none. */
function sniff(b: Buffer): string | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}
