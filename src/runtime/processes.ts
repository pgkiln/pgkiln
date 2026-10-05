import { zipSync, type Zippable } from 'fflate';
import { applyBinds } from '../binds.ts';
import type { Process } from '../metadata.ts';
import { bindValues, stripSemicolon, substitute, toState, type PageContext } from './context.ts';

// Declarative page processes of migration 039: download (a file from a
// query), workflow (start / terminate / retry) and the configuration checks
// of chains. They run inside the request's transaction as the application's
// database role, like every other process; item values reach SQL as escaped
// literals (binds) or query parameters, never as SQL text.

// ---------------------------------------------------------------- download

export interface Download {
  content: Buffer;
  name: string;
  type: string;
  inline: boolean;
}

interface DownloadConfig {
  content_column?: string;
  filename_column?: string;
  mime_column?: string;
  /** several rows: the name of the zip file (&ITEM. substitutions) */
  zip_name?: string;
  /** one row of a type a browser shows (images, PDF): "inline" opens it */
  disposition?: 'attachment' | 'inline';
}

/** Types a browser may show inline (sandboxed); everything else is an attachment. */
export const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']);
export const DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;
export const DOWNLOAD_MAX_FILES = 1000;
const COLUMN = /^[a-z_][a-z0-9_$]{0,62}$/;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
// already compressed: stored in the zip as they are
const COMPRESSED = /^(image\/(png|jpeg|gif|webp)|application\/(pdf|zip|gzip|x-7z-compressed)|video\/|audio\/)/;

/** A file name that is safe in a header and in a zip: no paths, no control characters. */
export function safeFileName(name: unknown, fallback = 'download') {
  const s = String(name ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f/\\:*?"<>|]+/g, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 200);
  return s || fallback;
}

/** A MIME type as sent, or application/octet-stream when it doesn't look like one. */
export function safeMime(mime: unknown) {
  const m = String(mime ?? '').trim().toLowerCase().split(';')[0].trim();
  return MIME.test(m) ? m : 'application/octet-stream';
}

export function downloadProblems(conf: unknown): string[] {
  const c = (conf ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  for (const k of ['content_column', 'filename_column', 'mime_column'])
    if (c[k] !== undefined && !(typeof c[k] === 'string' && COLUMN.test(c[k] as string))) out.push(`"${k}" is a column name of the query.`);
  if (c.zip_name !== undefined && typeof c.zip_name !== 'string') out.push('"zip_name" is a file name.');
  if (c.disposition !== undefined && !['attachment', 'inline'].includes(c.disposition as string)) out.push('"disposition" is attachment or inline.');
  return out;
}

const asBuffer = (v: unknown) =>
  v === null || v === undefined ? null : Buffer.isBuffer(v) ? v : Buffer.from(typeof v === 'object' ? JSON.stringify(v) : String(v), 'utf8');

/**
 * download: the process's query returns the file: its content (bytea, or
 * text as UTF-8), its name and its MIME type, by column name (config) or
 * else the first three columns. One row is sent as it is; several rows go
 * into one zip file. The rows are read from a cursor, so the size limits
 * stop a large result early.
 */
export async function downloadFile(ctx: PageContext, p: Process): Promise<Download> {
  const t = ctx.locale.t;
  const conf = (p.config ?? {}) as DownloadConfig;
  const problems = downloadProblems(conf);
  if (problems.length) throw new Error(`Process "${p.name}": ${problems.join(' ')}`);
  const sql = stripSemicolon(applyBinds(p.code ?? '', bindValues(ctx)));
  if (!sql) throw new Error(`Process "${p.name}" needs a query in its code.`);
  const c = ctx.client!;
  const cursor = `pgapex_download_${p.id}`;
  const files: { content: Buffer; name: string; type: string }[] = [];
  let bytes = 0;
  await c.query(`declare ${cursor} no scroll cursor for ${sql}`);
  try {
    for (;;) {
      const res = await c.query(`fetch 20 from ${cursor}`);
      if (!res.rows.length) break;
      const names = res.fields.map((f) => f.name);
      const col = (wanted: string | undefined, fallback: number) => (wanted ? names.indexOf(wanted) : fallback < names.length ? fallback : -1);
      const [ci, ni, mi] = [col(conf.content_column, 0), col(conf.filename_column, 1), col(conf.mime_column, 2)];
      if (ci < 0) throw new Error(`Process "${p.name}": the query has no column ${conf.content_column}.`);
      for (const row of res.rows) {
        const content = asBuffer(row[names[ci]]);
        if (!content) continue;
        bytes += content.length;
        if (files.length >= DOWNLOAD_MAX_FILES || bytes > DOWNLOAD_MAX_BYTES) throw new Error(t('download.too_large'));
        files.push({
          content,
          name: safeFileName(ni >= 0 ? row[names[ni]] : null, `file${files.length + 1}`),
          type: safeMime(mi >= 0 ? row[names[mi]] : null),
        });
      }
    }
  } finally {
    await c.query(`close ${cursor}`).catch(() => {});
  }
  if (!files.length) throw new Error(t('download.none'));
  if (files.length === 1) {
    const f = files[0];
    return { ...f, inline: conf.disposition === 'inline' && INLINE_TYPES.has(f.type) };
  }
  // several files: one zip; names made unique ("a.pdf", "a (2).pdf")
  const zip: Zippable = {};
  const used = new Set<string>();
  for (const f of files) {
    let name = f.name;
    for (let n = 2; used.has(name.toLowerCase()); n++) {
      const dot = f.name.lastIndexOf('.');
      name = dot > 0 ? `${f.name.slice(0, dot)} (${n})${f.name.slice(dot)}` : `${f.name} (${n})`;
    }
    used.add(name.toLowerCase());
    zip[name] = [new Uint8Array(f.content.buffer, f.content.byteOffset, f.content.length), { level: COMPRESSED.test(f.type) ? 0 : 6 }];
  }
  let zipName = safeFileName(substitute(conf.zip_name ?? '', ctx, (x) => x), 'download');
  if (!/\.zip$/i.test(zipName)) zipName += '.zip';
  return { content: Buffer.from(zipSync(zip)), name: zipName, type: 'application/zip', inline: false };
}

/** Content-Disposition with an ASCII fallback and the UTF-8 name (RFC 6266 / 5987). */
export function disposition(type: 'inline' | 'attachment', filename: string) {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const utf8 = encodeURIComponent(filename).replace(/['()*!]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/** Headers of a download: never sniffed, sandboxed, not cached. */
export function downloadHeaders(d: Download): Record<string, string> {
  return {
    'content-type': d.type,
    'content-disposition': disposition(d.inline ? 'inline' : 'attachment', d.name),
    'x-content-type-options': 'nosniff',
    // sandboxed unless it's a PDF shown inline (the browser's PDF viewer refuses to run sandboxed)
    'content-security-policy': `default-src 'none'; img-src 'self'; style-src 'unsafe-inline'${d.inline && d.type === 'application/pdf' ? '' : '; sandbox'}`,
    'cache-control': 'private, no-store',
  };
}

// ---------------------------------------------------------------- chains

export interface ChainConfig {
  /** queue the chain as a background job (meta.process_job) */
  background?: boolean;
  /** background: the item that receives the job's id */
  status_item?: string;
}

const ITEM = /^[A-Z][A-Z0-9_]*$/;

export function chainProblems(conf: unknown): string[] {
  const c = (conf ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  if (c.background !== undefined && typeof c.background !== 'boolean') out.push('"background" is true or false.');
  if (c.status_item !== undefined && !(typeof c.status_item === 'string' && ITEM.test(c.status_item))) out.push('"status_item" is an item name like P5_JOB_ID.');
  return out;
}

/** Process types a background chain can run (nothing that needs the request: forms, grids, uploads, files). */
export const BACKGROUND_TYPES = new Set<Process['type']>(['sql', 'invoke_api', 'workflow', 'chain']);

// ---------------------------------------------------------------- workflows

interface WorkflowConfig {
  action?: 'start' | 'terminate' | 'retry';
  definition?: string;
  version?: string;
  detail_pk?: string;
  variables?: Record<string, string>;
  id_item?: string;
  instance?: string;
  comment?: string;
}

export function workflowProblems(conf: unknown): string[] {
  const c = (conf ?? {}) as Record<string, any>;
  const out: string[] = [];
  const action = c.action ?? 'start';
  if (!['start', 'terminate', 'retry'].includes(action)) out.push('"action" is start, terminate or retry.');
  if (action === 'start') {
    if (typeof c.definition !== 'string' || !ITEM.test(c.definition.toUpperCase())) out.push('"definition" names a workflow definition, e.g. ONBOARDING.');
    if (c.version !== undefined && !(typeof c.version === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,29}$/.test(c.version))) out.push('"version" is a version label (empty: the active version).');
    if (c.detail_pk !== undefined && typeof c.detail_pk !== 'string') out.push('"detail_pk" is text, e.g. "&P5_ID.".');
    if (c.variables !== undefined && (typeof c.variables !== 'object' || Array.isArray(c.variables) || c.variables === null || Object.values(c.variables).some((v) => typeof v !== 'string')))
      out.push('"variables" maps variable names to values, e.g. {"AMOUNT": "&P5_AMOUNT."}.');
    if (c.id_item !== undefined && !(typeof c.id_item === 'string' && ITEM.test(c.id_item))) out.push('"id_item" is an item name.');
  } else {
    if (typeof c.instance !== 'string' || !c.instance) out.push('"instance" is the workflow id, e.g. "&P5_WORKFLOW_ID.".');
    if (c.comment !== undefined && typeof c.comment !== 'string') out.push('"comment" is text.');
  }
  return out;
}

/**
 * workflow: start a workflow (meta.start_workflow_version) with variables
 * from items, or terminate / retry an instance (whose id an item holds). The
 * database functions check that the user may (initiator or administrator).
 */
export async function workflowProcess(ctx: PageContext, p: Process, assignable: Set<string>): Promise<string | null> {
  const conf = (p.config ?? {}) as WorkflowConfig;
  const problems = workflowProblems(conf);
  if (problems.length) throw new Error(`Process "${p.name}": ${problems.join(' ')}`);
  const c = ctx.client!;
  const value = (s: string | undefined) => (s === undefined ? null : substitute(s, ctx, (x) => x));
  const action = conf.action ?? 'start';
  if (action === 'start') {
    const vars = Object.fromEntries(Object.entries(conf.variables ?? {}).map(([k, v]) => [k.toUpperCase(), value(v) || null]));
    const res = await c.query('select meta.start_workflow_version($1, $2, $3, $4::jsonb)::text as id', [
      conf.definition, conf.version ?? null, value(conf.detail_pk) || null, JSON.stringify(vars),
    ]);
    const id = res.rows[0].id as string;
    if (conf.id_item) {
      const name = conf.id_item.toUpperCase();
      if (!assignable.has(name)) throw new Error(`Process "${p.name}": ${name} is not an item of this page or an application item.`);
      ctx.session.state[name] = toState(id);
    }
    return p.success_message ?? ctx.locale.t('workflow.started', { id });
  }
  const id = (value(conf.instance) ?? '').trim();
  if (!/^\d{1,18}$/.test(id)) throw new Error(ctx.locale.t('workflow.no_instance'));
  if (action === 'terminate') await c.query('select meta.terminate_workflow($1::bigint, $2)', [id, value(conf.comment) || null]);
  else await c.query('select meta.retry_workflow($1::bigint)', [id]);
  return p.success_message ?? ctx.locale.t(action === 'terminate' ? 'workflow.terminated' : 'workflow.retried', { id });
}

/** Problems with a process's configuration (builder), by type. */
export function processProblems(type: string, conf: unknown): string[] {
  if (type === 'download') return downloadProblems(conf);
  if (type === 'chain') return chainProblems(conf);
  if (type === 'workflow') return workflowProblems(conf);
  return [];
}
