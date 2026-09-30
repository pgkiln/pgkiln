import pg from 'pg';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { literal } from '../binds.ts';
import { appTx, savepoint } from '../db.ts';
import type { Item, Region } from '../metadata.ts';
import { checksumValid, urlChecksum } from '../security.ts';
import { checkPageAccess, Forbidden } from './authz.ts';
import type { PageContext } from './context.ts';
import { resolveTable } from './engine.ts';

// File upload items (APEX "File Browse").
//
// An upload becomes a temporary file of the session (meta.save_temp_file)
// and the item's value its id. A form region then saves it into the item's
// bytea source column (file name and MIME type into config.filename_column
// and config.mime_column); pages without such a column read it from
// meta.temp_files in a process.
//
// Downloads go through the application's database role, so row level
// security applies, and their URLs carry a checksum bound to the user.

const ident = pg.escapeIdentifier;

export const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB ?? 10);
/** Types shown in the browser (images as previews); anything else is downloaded. */
const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']);
/** Item value that removes the stored file on save. */
export const REMOVE = 'REMOVE';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Upload {
  filename: string;
  mimetype: string;
  data: Buffer;
  truncated: boolean;
}

export interface FileInfo {
  filename: string;
  mime: string;
  size: number;
  /** download key: the record's primary key, or temp:<uuid> */
  key: string;
  pending: boolean;
}

interface FileConfig {
  filename_column?: string;
  mime_column?: string;
  max_mb?: number;
  accept?: string;
}
const cfg = (item: Item) => (item.config ?? {}) as FileConfig;
export const maxMb = (item: Item) => Math.min(Number(cfg(item).max_mb) || MAX_UPLOAD_MB, MAX_UPLOAD_MB);

/** Read a multipart body: fields as for urlencoded bodies, plus the files. */
export async function readMultipart(req: FastifyRequest) {
  const body: Record<string, string | string[]> = {};
  const files = new Map<string, Upload>();
  for await (const part of req.parts()) {
    if (part.type === 'file') {
      const data = await part.toBuffer();
      if (part.filename) files.set(part.fieldname, { filename: part.filename, mimetype: part.mimetype, data, truncated: part.file.truncated });
    } else {
      const v = String(part.value ?? '');
      const prev = body[part.fieldname];
      body[part.fieldname] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
    }
  }
  return { body, files };
}

/** Does the file match the item's accept list ("image/*,.pdf")? */
function accepted(item: Item, u: Upload) {
  const accept = cfg(item).accept?.trim();
  if (!accept) return true;
  const name = u.filename.toLowerCase();
  const mime = u.mimetype.toLowerCase();
  return accept
    .toLowerCase()
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean)
    .some((a) => (a.startsWith('.') ? name.endsWith(a) : a.endsWith('/*') ? mime.startsWith(a.slice(0, -1)) : mime === a));
}

/**
 * Store the uploads of editable file items as temporary files and set the
 * items to their ids; "<ITEM>__REMOVE" marks a stored file for removal.
 */
export async function applyUploads(ctx: PageContext, files: Map<string, Upload>, body: Record<string, unknown>, tx: Tx) {
  for (const item of ctx.page.items) {
    if (item.type !== 'file' || !ctx.vis!.editable.has(item.name)) continue;
    const u = files.get(item.name);
    if (u) {
      if (u.truncated || u.data.length > maxMb(item) * 1024 * 1024) {
        ctx.errors.items[item.name] = ctx.locale.t('file.too_large', { max: String(maxMb(item)) });
        continue;
      }
      if (!accepted(item, u)) {
        ctx.errors.items[item.name] = ctx.locale.t('file.wrong_type');
        continue;
      }
      const filename = u.filename.replace(/^.*[\\/]/, '').replace(/[\u0000-\u001f"]/g, '_') || 'file';
      // committed on its own, so the upload survives a validation error
      const r = await appTx(tx(ctx), (c) => c.query('select meta.save_temp_file($1, $2, $3, $4) as id', [item.name, filename, u.mimetype || 'application/octet-stream', u.data]));
      ctx.session.state[item.name] = r.rows[0].id;
    } else if (body[`${item.name}__REMOVE`] === 'true') {
      ctx.session.state[item.name] = formRegion(ctx, item) ? REMOVE : null;
    }
  }
}

/** The form region whose table stores this item's file, if any. */
export function formRegion(ctx: PageContext, item: Item): Region | undefined {
  if (!item.source_column) return undefined;
  const r = ctx.page.regions.find((x) => x.id === item.region_id);
  return r?.type === 'form' && r.table_name && r.pk_column && r.pk_item ? r : undefined;
}

export const isTempId = (v: string | null | undefined): v is string => !!v && UUID.test(v);

async function tempInfo(ctx: PageContext, id: string): Promise<FileInfo | null> {
  const r = await ctx.client!.query('select filename, mime_type, size from meta.temp_files where id = $1', [id]);
  const f = r.rows[0];
  return f ? { filename: f.filename, mime: f.mime_type, size: f.size, key: `temp:${id}`, pending: true } : null;
}

/** Columns that describe a stored file (content, name, type). */
function fileColumns(item: Item, content: 'size' | 'content') {
  const c = cfg(item);
  return [
    content === 'size' ? `octet_length(${ident(item.source_column!)})` : ident(item.source_column!),
    c.filename_column ? `${ident(c.filename_column)}::text` : 'null::text',
    c.mime_column ? `${ident(c.mime_column)}::text` : 'null::text',
  ].join(', ');
}

/** What the item currently shows: a new upload, or the file stored in the record. */
export async function fileInfo(ctx: PageContext, item: Item): Promise<FileInfo | null> {
  const value = ctx.session.state[item.name];
  const c = ctx.client!;
  if (isTempId(value)) return savepoint(c, () => tempInfo(ctx, value));
  const r = formRegion(ctx, item);
  const pk = r ? ctx.session.state[r.pk_item!] : null;
  if (!r || pk === null || pk === undefined || value === REMOVE) return null;
  const res = await savepoint(c, async () =>
    c.query({ text: `select ${fileColumns(item, 'size')} from ${await resolveTable(c, r.table_name!)} where ${ident(r.pk_column!)} = ${literal(pk)}`, rowMode: 'array' }),
  );
  const [size, filename, mime] = res.rows[0] ?? [];
  if (size === null || size === undefined) return null;
  return { filename: filename ?? `${item.name.toLowerCase()}`, mime: mime ?? 'application/octet-stream', size: Number(size), key: String(pk), pending: false };
}

export const canPreview = (f: FileInfo) => f.mime.startsWith('image/') && INLINE.has(f.mime);

export function fileUrl(ctx: PageContext, item: Item, f: FileInfo, inline = false) {
  const cs = urlChecksum(ctx.app.id, ctx.page.page_no, ctx.user, { __FILE: item.name, __KEY: f.key });
  const q = new URLSearchParams({ k: f.key, cs, ...(inline ? { inline: '1' } : {}) });
  return `${ctx.base}/${ctx.page.page_no}/file/${item.name}?${q}`;
}

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Content-Disposition with an ASCII fallback and the UTF-8 name (RFC 6266). */
function disposition(type: 'inline' | 'attachment', filename: string) {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

type Loader = (req: any, reply: FastifyReply) => Promise<PageContext | null>;
type Tx = (ctx: PageContext) => Parameters<typeof appTx>[0];

export function fileRoutes(app: FastifyInstance, loadContext: Loader, txContext: Tx, forbidden: (ctx: PageContext, reply: FastifyReply, message: string, detail: string) => unknown) {
  app.get<{ Params: { alias: string; page: string; item: string }; Querystring: { k?: string; cs?: string; inline?: string } }>(
    '/a/:alias/:page/file/:item',
    async (req, reply) => {
      const ctx = await loadContext(req, reply);
      if (!ctx) return;
      const name = req.params.item.toUpperCase();
      const key = req.query.k ?? '';
      const item = ctx.page.items.find((i) => i.name === name && i.type === 'file');
      if (!item || !checksumValid(urlChecksum(ctx.app.id, ctx.page.page_no, ctx.user, { __FILE: name, __KEY: key }), req.query.cs))
        return forbidden(ctx, reply, ctx.locale.t('error.checksum'), `file download checksum error: ${req.url}`);
      let file: { content: Buffer; filename: string; mime: string } | null;
      try {
        file = await appTx(txContext(ctx), async (c) => {
          ctx.client = c;
          await checkPageAccess(ctx);
          if (key.startsWith('temp:')) {
            const r = await c.query('select content, filename, mime_type as mime from meta.temp_files where id = $1', [key.slice(5)]);
            return r.rows[0] ?? null;
          }
          const region = formRegion(ctx, item);
          if (!region) return null;
          const r = await c.query({
            text: `select ${fileColumns(item, 'content')} from ${await resolveTable(c, region.table_name!)} where ${ident(region.pk_column!)} = ${literal(key)}`,
            rowMode: 'array',
          });
          const [content, filename, mime] = r.rows[0] ?? [];
          return content ? { content, filename: filename ?? name.toLowerCase(), mime: mime ?? 'application/octet-stream' } : null;
        });
      } catch (e) {
        if (e instanceof Forbidden) return forbidden(ctx, reply, e.message, `file download on page ${ctx.page.page_no}`);
        throw e;
      }
      // Not found and hidden by row level security look the same.
      if (!file) return reply.code(404).type('text/plain').send(ctx.locale.t('file.none'));
      const inline = req.query.inline === '1' && INLINE.has(file.mime);
      return reply
        .header('content-disposition', disposition(inline ? 'inline' : 'attachment', file.filename))
        // sandboxed unless it's a PDF (the browser's PDF viewer refuses to run sandboxed)
        .header('content-security-policy', `default-src 'none'; img-src 'self'; style-src 'unsafe-inline'${inline && file.mime === 'application/pdf' ? '' : '; sandbox'}`)
        .header('cache-control', 'private, no-store')
        .type(inline ? file.mime : 'application/octet-stream')
        .send(file.content);
    },
  );
}
