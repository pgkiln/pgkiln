import { disposition } from './processes.ts';
import { unpackForSql } from '../unpack.ts';
import pg from 'pg';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { literal } from '../binds.ts';
import { appTx, savepoint } from '../db.ts';
import type { Item, Region } from '../metadata.ts';
import { checksumValid, urlChecksum } from '../security.ts';
import { checkPageAccess, Forbidden } from './authz.ts';
import type { PageContext } from './context.ts';
import { resolveTable } from './engine.ts';
import { deleteObject, getObject, objectStoreOf, putObject, type ObjectStoreConfig } from '../objectstore.ts';

// File upload items (APEX "File Browse").
//
// An upload becomes a temporary file of the session (meta.save_temp_file)
// and the item's value its id. A form region then saves it into the item's
// bytea source column (file name and MIME type into config.filename_column
// and config.mime_column); pages without such a column read it from
// meta.temp_files in a process.
//
// With config.multiple the item takes several files (APEX "Allow Multiple
// Files"). Its value is then a ':'-separated list of temporary file ids; a
// form region saves them as rows of a child table (config.table, with
// config.parent_column referring to the form's record, config.key_column its
// primary key and the item's source column the content), one row per file.
//
// Downloads go through the application's database role, so row level
// security applies, and their URLs carry a checksum bound to the user.
//
// (0.31) With config.object_store the files go to an S3-compatible bucket
// (src/objectstore.ts) when the form is saved, and the source column holds
// the object's key (config.size_column, if any, its size). A replaced or
// removed file's object is deleted once the save committed; an object stored
// for a save that rolled back is deleted again.

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
  multiple?: boolean;
  max_files?: number;
  table?: string;
  parent_column?: string;
  key_column?: string;
  /** (0.31) object storage: the source column holds the object key */
  object_store?: ObjectStoreConfig;
  size_column?: string;
}
const cfg = (item: Item) => (item.config ?? {}) as FileConfig;
export const maxMb = (item: Item) => Math.min(Number(cfg(item).max_mb) || MAX_UPLOAD_MB, MAX_UPLOAD_MB);
/** At most this many files per item (a session keeps 20 temporary files). */
export const MAX_FILES = 10;
export const isMultiple = (item: Item) => item.type === 'file' && cfg(item).multiple === true;
export const maxFiles = (item: Item) => Math.min(Math.max(Math.floor(Number(cfg(item).max_files)) || MAX_FILES, 1), MAX_FILES);
/** The temporary file ids in a multiple file item's value. */
export const tempIds = (v: string | null | undefined) => (v ?? '').split(':').filter(isTempId);
/** The values of the "remove" checkboxes posted for an item. */
export const removals = (ctx: PageContext, item: Item) =>
  [ctx.body?.[`${item.name}__REMOVE`] ?? []].flat().filter((v): v is string => typeof v === 'string' && v !== '');

/** Read a multipart body: fields as for urlencoded bodies, plus the files. */
export async function readMultipart(req: FastifyRequest, maxFileMb = MAX_UPLOAD_MB) {
  const body: Record<string, string | string[]> = {};
  // the first file per field, and all of them (an <input type="file" multiple>)
  const files = new Map<string, Upload>();
  const lists = new Map<string, Upload[]>();
  for await (const part of req.parts({ limits: { fileSize: maxFileMb * 1024 * 1024 } })) {
    if (part.type === 'file') {
      const data = await part.toBuffer();
      if (!part.filename) continue;
      const u = { filename: part.filename, mimetype: part.mimetype, data, truncated: part.file.truncated };
      if (!files.has(part.fieldname)) files.set(part.fieldname, u);
      lists.set(part.fieldname, [...(lists.get(part.fieldname) ?? []), u]);
    } else {
      const v = String(part.value ?? '');
      const prev = body[part.fieldname];
      body[part.fieldname] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
    }
  }
  return { body, files, lists };
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

/** Why an upload is refused, if it is. */
function refusal(ctx: PageContext, item: Item, u: Upload) {
  if (u.truncated || u.data.length > maxMb(item) * 1024 * 1024) return ctx.locale.t('file.too_large', { max: String(maxMb(item)) });
  if (!accepted(item, u)) return ctx.locale.t('file.wrong_type');
  return null;
}

const cleanName = (u: Upload) => u.filename.replace(/^.*[\\/]/, '').replace(/[\u0000-\u001f"]/g, '_') || 'file';

/**
 * Store the uploads of editable file items as temporary files and set the
 * items to their ids; "<ITEM>__REMOVE" marks a stored file for removal.
 */
export async function applyUploads(ctx: PageContext, files: Map<string, Upload[]>, body: Record<string, unknown>, tx: Tx) {
  for (const item of ctx.page.items) {
    if (item.type !== 'file' || !ctx.vis!.editable.has(item.name)) continue;
    if (isMultiple(item)) {
      await applyMultiple(ctx, item, files.get(item.name) ?? [], tx);
      continue;
    }
    const u = files.get(item.name)?.[0];
    if (u) {
      const refused = refusal(ctx, item, u);
      if (refused) {
        ctx.errors.items[item.name] = refused;
        continue;
      }
      // committed on its own, so the upload survives a validation error
      const r = await appTx(tx(ctx), (c) => c.query('select meta.save_temp_file($1, $2, $3, $4) as id', [item.name, cleanName(u), u.mimetype || 'application/octet-stream', u.data]));
      ctx.session.state[item.name] = r.rows[0].id;
      await unpackForSql(u.data); // a zip or .xlsx: readable in SQL (meta.zip_entry, meta.parse_data)
    } else if (body[`${item.name}__REMOVE`] === 'true') {
      ctx.session.state[item.name] = formRegion(ctx, item) ? REMOVE : null;
    }
  }
}

/**
 * A multiple file item: drop the new files whose "remove" box is ticked,
 * then add this request's uploads (all or none) while the item stays within
 * max_files. Ticked stored files are removed by the form's save (formDml).
 */
async function applyMultiple(ctx: PageContext, item: Item, uploads: Upload[], tx: Tx) {
  const t = ctx.locale.t;
  const remove = new Set(removals(ctx, item));
  const pending = tempIds(ctx.session.state[item.name]);
  const dropped = pending.filter((id) => remove.has(`temp:${id}`));
  const kept = pending.filter((id) => !remove.has(`temp:${id}`));
  const added: string[] = [];
  const refused = uploads.map((u) => refusal(ctx, item, u)).find(Boolean);
  if (refused) ctx.errors.items[item.name] = refused;
  else if (uploads.length) {
    const stored = (await storedFiles(ctx, item)).filter((f) => !remove.has(f.key)).length;
    if (stored + kept.length + uploads.length > maxFiles(item)) ctx.errors.items[item.name] = t('file.too_many', { max: String(maxFiles(item)) });
  }
  await appTx(tx(ctx), async (c) => {
    for (const id of dropped) await c.query('select meta.delete_temp_file($1)', [id]);
    if (ctx.errors.items[item.name]) return;
    for (const u of uploads)
      added.push((await c.query('select meta.save_temp_file($1, $2, $3, $4) as id', [item.name, cleanName(u), u.mimetype || 'application/octet-stream', u.data])).rows[0].id);
  });
  ctx.session.state[item.name] = [...kept, ...added].join(':') || null;
  if (added.length) for (const u of uploads) await unpackForSql(u.data);
}

/** The form region whose table stores this item's file, if any. */
export function formRegion(ctx: PageContext, item: Item): Region | undefined {
  if (!item.source_column) return undefined;
  const r = ctx.page.regions.find((x) => x.id === item.region_id);
  return r?.type === 'form' && r.table_name && r.pk_column && r.pk_item ? r : undefined;
}

export const isTempId = (v: string | null | undefined): v is string => !!v && UUID.test(v);

/** Where a multiple file item stores its files: a child table of its form's record. */
export function childTable(ctx: PageContext, item: Item) {
  const c = cfg(item);
  const region = isMultiple(item) && c.table && c.parent_column ? formRegion(ctx, item) : undefined;
  return region ? { region, table: c.table!, parent: c.parent_column!, key: c.key_column || 'id' } : undefined;
}

/** The files a multiple file item has stored for the form's current record. */
export async function storedFiles(ctx: PageContext, item: Item): Promise<FileInfo[]> {
  const child = childTable(ctx, item);
  const pk = child ? ctx.session.state[child.region.pk_item!] : null;
  if (!child || pk === null || pk === undefined) return [];
  const c = ctx.client!;
  const res = await savepoint(c, async () =>
    c.query({
      text: `select ${ident(child.key)}::text, ${fileColumns(item, 'size')} from ${await resolveTable(c, child.table)} where ${ident(child.parent)} = ${literal(pk)} order by ${ident(child.key)}`,
      rowMode: 'array',
    }),
  );
  return res.rows.map(([key, size, filename, mime]) => ({ filename: filename ?? item.name.toLowerCase(), mime: mime ?? 'application/octet-stream', size: Number(size ?? 0), key, pending: false }));
}

/** The files a multiple file item shows: the stored ones, then the new uploads. */
export async function fileList(ctx: PageContext, item: Item): Promise<FileInfo[]> {
  const ids = tempIds(ctx.session.state[item.name]);
  const c = ctx.client!;
  const pending = ids.length
    ? (await savepoint(c, () => c.query('select id, filename, mime_type, size from meta.temp_files where id = any($1::uuid[]) order by created_at, array_position($1::uuid[], id)', [ids]))).rows.map(
        (f) => ({ filename: f.filename, mime: f.mime_type, size: f.size, key: `temp:${f.id}`, pending: true }),
      )
    : [];
  return [...(await storedFiles(ctx, item)), ...pending];
}

/**
 * Save a form's multiple file items into their child tables (after the
 * record's insert or update): one row per new file; ticked files of this
 * record are deleted. On delete, all the record's files are deleted.
 */
export async function saveFileLists(ctx: PageContext, region: Region, op: 'insert' | 'update' | 'delete') {
  const c = ctx.client!;
  const pk = ctx.session.state[region.pk_item!];
  for (const item of ctx.page.items) {
    const child = childTable(ctx, item);
    if (!child || child.region.id !== region.id || pk === null || pk === undefined) continue;
    const table = await resolveTable(c, child.table);
    const parent = `${ident(child.parent)} = ${literal(pk)}`;
    const store = storeOf(item);
    // object storage: the keys of the rows a delete removes, for removing their objects after the commit
    const objectKeys = async (where: string, values: unknown[] = []) =>
      store ? (await c.query({ text: `select ${ident(item.source_column!)}::text from ${table} where ${where}`, values, rowMode: 'array' })).rows.map((r) => r[0]) : [];
    if (op === 'delete') {
      const gone = await objectKeys(parent);
      await c.query(`delete from ${table} where ${parent}`);
      if (store) dropObjects(ctx, store, gone);
      continue;
    }
    if (!ctx.vis!.editable.has(item.name)) continue;
    const keys = removals(ctx, item).filter((k) => !k.startsWith('temp:'));
    if (keys.length) {
      const gone = await objectKeys(`${parent} and ${ident(child.key)}::text = any($1::text[])`, [keys]);
      await c.query(`delete from ${table} where ${parent} and ${ident(child.key)}::text = any($1::text[])`, [keys]);
      if (store) dropObjects(ctx, store, gone);
    }
    const ids = tempIds(ctx.session.state[item.name]);
    if (!ids.length) continue;
    const conf = cfg(item);
    if (store) {
      // each file into the bucket, its key (and name, type, size) into a row
      for (const id of ids) {
        const f = await storeTempFile(ctx, store, id);
        const cols: [string, unknown][] = [[child.parent, pk], [item.source_column!, f.key],
          ...(conf.filename_column ? [[conf.filename_column, f.filename] as [string, unknown]] : []),
          ...(conf.mime_column ? [[conf.mime_column, f.mime] as [string, unknown]] : []),
          ...(conf.size_column ? [[conf.size_column, f.size] as [string, unknown]] : [])];
        await c.query(`insert into ${table} (${cols.map(([k]) => ident(k)).join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, cols.map(([, v]) => v));
        await c.query('select meta.delete_temp_file($1)', [id]);
      }
      ctx.session.state[item.name] = null;
      continue;
    }
    const cols = [ident(child.parent), ident(item.source_column!), ...(conf.filename_column ? [ident(conf.filename_column)] : []), ...(conf.mime_column ? [ident(conf.mime_column)] : [])];
    const vals = [literal(pk), 'content', ...(conf.filename_column ? ['filename'] : []), ...(conf.mime_column ? ['mime_type'] : [])];
    await c.query(`insert into ${table} (${cols.join(', ')}) select ${vals.join(', ')} from meta.temp_files where id = any($1::uuid[]) order by created_at, array_position($1::uuid[], id)`, [ids]);
    for (const id of ids) await c.query('select meta.delete_temp_file($1)', [id]);
    ctx.session.state[item.name] = null;
  }
}

async function tempInfo(ctx: PageContext, id: string): Promise<FileInfo | null> {
  const r = await ctx.client!.query('select filename, mime_type, size from meta.temp_files where id = $1', [id]);
  const f = r.rows[0];
  return f ? { filename: f.filename, mime: f.mime_type, size: f.size, key: `temp:${id}`, pending: true } : null;
}

/** A file item's object store, or null (files in the database). */
export const storeOf = (item: Item) => (item.type === 'file' ? objectStoreOf(item.config) : null);

/**
 * Put one of the session's temporary files into the item's object store
 * (removed again if the transaction rolls back). Returns what the row stores.
 */
export async function storeTempFile(ctx: PageContext, store: ObjectStoreConfig, id: string) {
  const r = await ctx.client!.query<{ content: Buffer; filename: string; mime_type: string; size: number }>('select content, filename, mime_type, size from meta.temp_files where id = $1', [id]);
  const f = r.rows[0];
  if (!f) throw new Error(ctx.locale.t('file.none'));
  const key = await putObject(ctx.app.id, store, f.filename, f.content, f.mime_type);
  (ctx.objectsPut ??= []).push([store, key]);
  ctx.afterRollback?.push(() => deleteObject(ctx.app.id, store, key));
  return { key, filename: f.filename, mime: f.mime_type, size: f.size };
}

/** Remove the objects stored since `mark` (a process that failed: its rows were not written). */
export async function dropObjectsSince(ctx: PageContext, mark: number) {
  for (const [store, key] of ctx.objectsPut?.splice(mark) ?? []) await deleteObject(ctx.app.id, store, key).catch(() => {});
}

/** Delete objects once the transaction committed (a replaced or removed file). */
export function dropObjects(ctx: PageContext, store: ObjectStoreConfig, keys: (string | null | undefined)[]) {
  for (const key of keys) if (key) ctx.afterCommit?.push(() => deleteObject(ctx.app.id, store, key));
}

/** Columns that describe a stored file (content, name, type). */
function fileColumns(item: Item, content: 'size' | 'content') {
  const c = cfg(item);
  // object storage: the column holds the key; the size is in size_column (else unknown: -1)
  const size = storeOf(item)
    ? c.size_column ? `${ident(c.size_column)}::bigint` : `case when ${ident(item.source_column!)} is null then null else -1 end`
    : `octet_length(${ident(item.source_column!)})`;
  return [
    content === 'size' ? size : ident(item.source_column!),
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
  if (bytes < 0) return ''; // object storage without a size column
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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
      // object storage: the column holds the key, the content comes from the bucket (after the row passed RLS)
      const store = storeOf(item);
      const contentOf = async (v: Buffer | string) => (store ? await getObject(ctx.app.id, store, String(v)) : (v as Buffer));
      try {
        file = await appTx(txContext(ctx), async (c) => {
          ctx.client = c;
          await checkPageAccess(ctx);
          if (key.startsWith('temp:')) {
            const r = await c.query('select content, filename, mime_type as mime from meta.temp_files where id = $1', [key.slice(5)]);
            return r.rows[0] ?? null;
          }
          const child = childTable(ctx, item);
          if (child) {
            const r = await c.query({
              text: `select ${fileColumns(item, 'content')} from ${await resolveTable(c, child.table)} where ${ident(child.key)}::text = $1`,
              values: [key],
              rowMode: 'array',
            });
            const [content, filename, mime] = r.rows[0] ?? [];
            const data = content ? await contentOf(content) : null;
            return data ? { content: data, filename: filename ?? name.toLowerCase(), mime: mime ?? 'application/octet-stream' } : null;
          }
          const region = formRegion(ctx, item);
          if (!region || isMultiple(item)) return null;
          const r = await c.query({
            text: `select ${fileColumns(item, 'content')} from ${await resolveTable(c, region.table_name!)} where ${ident(region.pk_column!)} = ${literal(key)}`,
            rowMode: 'array',
          });
          const [content, filename, mime] = r.rows[0] ?? [];
          const data = content ? await contentOf(content) : null;
          return data ? { content: data, filename: filename ?? name.toLowerCase(), mime: mime ?? 'application/octet-stream' } : null;
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
