import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  archiveSchema, cancelJob, DumpError, DUMP_DIR, exportableSchemas, filePath, findTools, getJob, KEEP_DAYS, listJobs, readJobFile, readToc,
  schemaTables, SCHEMA_NAME, startExport, startImport, deleteJob, uploadMaxMb, uploadJob, jobFile, type Content, type Job, type ToolState,
} from '../datapump.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import { isAdmin } from './locks.ts';
import { back, BASE, csrf, developer, flash, region, send, shell, workshopTabs, type Body, type Req } from './ui.ts';

// (sprint 103, Database Actions DA-16: Data Pump) SQL Workshop › Schema Export / Import, for administrators: pg_dump of a
// schema (custom or plain, definitions and/or data, tables in or out) and pg_restore of an archive into a new or
// existing schema, as background jobs with their logs, sizes and timing; files are kept for PGKILN_DUMP_KEEP_DAYS.
// The work: src/datapump.ts (jobs, pg_dump, pg_restore) and src/dumpscript.ts (the import's script runner).

const URL_BASE = `${BASE}/sql/data-pump`;
const TITLE = 'Schema Export / Import';
const jobUrl = (id: number) => `${URL_BASE}/job/${id}`;
const crumbs = (...more: [string, string?][]): [string, string?][] => [['SQL Workshop', `${BASE}/sql`], [TITLE, more.length ? URL_BASE : undefined], ...more];
const many = (v: unknown) => ([] as string[]).concat((v as string | string[] | undefined) ?? []);
const CONTENT: [Content, string][] = [['all', 'Definitions and data'], ['definitions', 'Definitions only'], ['data', 'Data only']];

/** An administrator's session; others get a 403 page. */
async function admin(req: Req, reply: FastifyReply) {
  const s = await developer(req, reply);
  if (!s) return null;
  if (await isAdmin(s.username)) return s;
  const main = html`<h1 class="u-mb1">${TITLE}</h1><div class="alert alert-error" role="alert">Only administrators export and import schemas: an export holds every row of a schema, an import runs its SQL as pgkiln's owner role.</div>`;
  await send(reply.code(403), s, shell(s, TITLE, crumbs(), main, 'sql'));
  return null;
}

const page = (reply: FastifyReply, s: Session, title: string, trail: [string, string?][], body: Raw, code = 200) =>
  send(reply.code(code), s, shell(s, title, crumbs(...trail), html`<h1 class="u-mb1">SQL Workshop</h1>${workshopTabs('datapump')}${body}`, 'sql'));

export const size = (n: number | null) =>
  n === null ? '' : n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`;

const STATUS: Record<Job['status'], [string, string]> = {
  uploaded: ['tag-info', 'uploaded'], running: ['tag-warning', 'running'], succeeded: ['tag-ok', 'succeeded'], failed: ['tag-error', 'failed'], cancelled: ['', 'cancelled'],
};
const status = (j: Job) => html`<span class="tag ${STATUS[j.status][0]}">${STATUS[j.status][1]}</span>`;
const what = (j: Job) =>
  j.kind === 'export'
    ? html`Export of <strong>${j.schema_name ?? ''}</strong>${(j.options.format as string) === 'plain' ? ' (plain SQL)' : ''}`
    : j.status === 'uploaded'
      ? html`Upload <strong class="u-break">${j.original_name ?? ''}</strong>`
      : html`Import of <strong>${j.schema_name ?? ''}</strong> into <strong>${j.target_schema ?? ''}</strong>`;

/** Can this job's file be imported? (an export in custom format, or an upload; while its file is kept) */
const importable = (j: Job) =>
  j.file_live && ((j.kind === 'export' && j.status === 'succeeded' && j.options.format !== 'plain') || (j.kind === 'import' && !j.source_job && j.status !== 'running'));

const toolNote = (t: ToolState) =>
  t.ok
    ? html`<p class="muted small">${t.tools.version} and pg_restore for a PostgreSQL ${String(t.server)} server. Files are kept ${String(KEEP_DAYS)} day${KEEP_DAYS === 1 ? '' : 's'} in the dump directory.</p>`
    : html`<div class="alert alert-warning" role="alert"><strong>Export and import need pg_dump and pg_restore.</strong> ${t.reason}${t.found.length ? html` Found: ${t.found.join('; ')}.` : ''}</div>`;

async function listPage(reply: FastifyReply, s: Session) {
  const [jobs, tools] = await Promise.all([listJobs(), findTools()]);
  const body = html`<div class="ide-head-title u-mb1"><div><h2 class="u-m0">${TITLE}</h2><span class="muted small">A schema to a file with pg_dump, and a file into a schema with pg_restore (Data Pump), as background jobs.</span></div>
      <div class="buttons ide-head-actions"><a class="btn btn-hot" href="${URL_BASE}/export">${icon('download')} Export a schema</a> <a class="btn" href="${URL_BASE}/import">${icon('upload')} Import</a></div></div>
    ${toolNote(tools)}
    ${region('Jobs', html`<div class="table-wrap"><table class="report report-reflow dp-jobs"><thead><tr><th>Job</th><th>What</th><th>Status</th><th class="num">Size</th><th>Started</th><th class="num">Seconds</th><th>By</th></tr></thead>
      <tbody>${jobs.length ? jobs.map((j) => html`<tr>
        <td data-label="Job"><a href="${jobUrl(j.id)}">#${String(j.id)}</a></td>
        <td data-label="What" class="u-break">${what(j)}</td>
        <td data-label="Status">${status(j)}</td>
        <td data-label="Size" class="num">${size(j.bytes)}${j.file_name && !j.file_live ? '' : j.bytes !== null && !j.file_name ? html` <span class="muted small">(removed)</span>` : ''}</td>
        <td data-label="Started">${j.started_at ?? j.created_at}</td>
        <td data-label="Seconds" class="num">${j.seconds === null ? '' : String(j.seconds)}</td>
        <td data-label="By" class="u-break">${j.username}</td></tr>`)
        : html`<tr><td colspan="7" class="empty">No exports or imports yet.</td></tr>`}</tbody></table></div>`)}`;
  return page(reply, s, TITLE, [], body);
}

async function exportPage(reply: FastifyReply, s: Session, q: Record<string, string | string[] | undefined>, errors: string[] = []) {
  const schemas = await exportableSchemas();
  const schema = schemas.includes(String(q.schema ?? '')) ? String(q.schema) : '';
  const tables = schema ? await schemaTables(schema) : [];
  const mode = ['all', 'only', 'except'].includes(String(q.mode)) ? String(q.mode) : 'all';
  const picked = new Set(many(q.t));
  const format = q.format === 'plain' ? 'plain' : 'custom';
  const content = CONTENT.some(([c]) => c === q.content) ? String(q.content) : 'all';
  const privileges = q.schema === undefined || q.privileges === '1';
  const body = html`${toolNote(await findTools())}
    ${errors.length ? html`<div class="alert alert-error" role="alert">${errors.map((e) => html`<div>${e}</div>`)}</div>` : ''}
    <form method="get" action="${URL_BASE}/export" class="u-mb1"><div class="form-grid"><div class="field"><label class="label" for="dp-schema">Schema</label>
      <select id="dp-schema" name="schema" required><option value="">- choose a schema -</option>${schemas.map((x) => html`<option value="${x}"${x === schema ? raw(' selected') : ''}>${x}</option>`)}</select></div></div>
      <div class="buttons"><button class="btn">${icon('table')} Choose</button></div></form>
    ${schema ? region(`Export ${schema}`, html`<form method="post" action="${URL_BASE}/export">${csrf(s)}<input type="hidden" name="schema" value="${schema}">
      <fieldset class="prop-group"><legend>Format</legend><div class="form-grid">
        <label class="check"><input type="radio" name="format" value="custom"${format === 'custom' ? raw(' checked') : ''}> Custom (compressed; imports here with pg_restore)</label>
        <label class="check"><input type="radio" name="format" value="plain"${format === 'plain' ? raw(' checked') : ''}> Plain SQL (for psql; not imported here)</label></div></fieldset>
      <fieldset class="prop-group"><legend>Content</legend><div class="form-grid">
        ${CONTENT.map(([c, label]) => html`<label class="check"><input type="radio" name="content" value="${c}"${content === c ? raw(' checked') : ''}> ${label}</label>`)}
        <label class="check"><input type="checkbox" name="privileges" value="1"${privileges ? raw(' checked') : ''}> Grants</label></div></fieldset>
      <fieldset class="prop-group"><legend>Tables, views and sequences</legend>
        <div class="form-grid">${[['all', 'The whole schema'], ['only', 'Only the checked ones'], ['except', 'All but the checked ones']].map(([m, label]) =>
          html`<label class="check"><input type="radio" name="mode" value="${m}"${mode === m ? raw(' checked') : ''}> ${label}</label>`)}</div>
        ${tables.length ? html`<div class="dp-tables">${tables.map((t) => html`<label class="check u-break"><input type="checkbox" name="t" value="${t}"${picked.has(t) ? raw(' checked') : ''}> ${t}</label>`)}</div>`
          : html`<p class="muted">The schema has no tables, views or sequences.</p>`}
        <p class="muted small">Only some tables: the file has no CREATE SCHEMA, and functions, types and the other objects of the schema stay out.</p></fieldset>
      <div class="buttons"><button class="btn btn-hot">${icon('download')} Start the export</button></div></form>`) : ''}`;
  return page(reply, s, 'Export a schema', [['Export']], body, errors.length ? 422 : 200);
}

async function importPage(reply: FastifyReply, s: Session) {
  const files = (await listJobs()).filter(importable);
  const body = html`${toolNote(await findTools())}
    ${region('Upload a dump', html`<form method="post" action="${URL_BASE}/upload" enctype="multipart/form-data">${csrf(s)}
      <div class="form-grid"><div class="field"><label class="label" for="dp-file">A custom or tar archive of one schema (pg_dump -Fc or -Ft), up to ${String(uploadMaxMb())} MB</label>
        <input type="file" id="dp-file" name="file" required></div></div>
      <div class="buttons"><button class="btn btn-hot">${icon('upload')} Upload</button></div></form>
      <p class="muted small">The next page shows what the archive holds before anything runs. A dump is code: its functions and triggers run as pgkiln's owner role, so import only dumps you trust.</p>`)}
    ${region('Or an export of this server', html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>Job</th><th>File</th><th class="num">Size</th><th>Made</th><th></th></tr></thead>
      <tbody>${files.length ? files.map((j) => html`<tr><td data-label="Job"><a href="${jobUrl(j.id)}">#${String(j.id)}</a></td><td data-label="File" class="u-break">${what(j)}</td>
        <td data-label="Size" class="num">${size(j.bytes)}</td><td data-label="Made">${j.finished_at ?? j.created_at}</td>
        <td><a class="btn btn-sm" href="${jobUrl(j.id)}/import">${icon('upload')} Import…</a></td></tr>`)
        : html`<tr><td colspan="5" class="empty">No exports in custom format are kept.</td></tr>`}</tbody></table></div>`)}`;
  return page(reply, s, 'Import', [['Import']], body);
}

async function importForm(reply: FastifyReply, s: Session, j: Job, body: Body = {}, errors: string[] = []) {
  let preview: Raw;
  let schema = '';
  try {
    const toc = await readToc(jobFile(j)!);
    let problem = '';
    try {
      schema = archiveSchema(toc);
    } catch (e) {
      problem = (e as Error).message;
    }
    const tables = toc.entries.filter((e) => e.desc === 'TABLE').map((e) => e.name);
    const rows = toc.entries.filter((e) => e.desc === 'TABLE DATA').length;
    preview = html`${problem ? html`<div class="alert alert-error" role="alert">${problem}</div>` : ''}
      <dl class="dp-facts">${toc.header.filter(([k]) => /^(Archive created at|dbname|Format|Dumped from database version|Dumped by pg_dump version)$/.test(k)).map(([k, v]) => html`<dt>${k}</dt><dd class="u-break">${v}</dd>`)}
        <dt>Schema</dt><dd>${toc.schemas.join(', ') || '-'}${toc.schemaEntry ? '' : html` <span class="muted small">(some tables: no CREATE SCHEMA)</span>`}</dd>
        <dt>Tables</dt><dd class="u-break">${tables.length ? tables.join(', ') : html`<span class="muted">none</span>`}${rows ? html` <span class="muted small">(data of ${String(rows)})</span>` : ''}</dd></dl>
      <div class="table-wrap"><table class="report"><thead><tr><th>Object type</th><th class="num">Entries</th></tr></thead>
        <tbody>${toc.counts.map(([d, n]) => html`<tr><td>${d.toLowerCase()}</td><td class="num">${String(n)}</td></tr>`)}</tbody></table></div>`;
    if (problem) schema = '';
  } catch (e) {
    preview = html`<div class="alert alert-error" role="alert">${(e as Error).message}</div>`;
  }
  const target = body.target ?? schema;
  const content = CONTENT.some(([c]) => c === body.content) ? body.content! : 'all';
  const form = schema ? region('Import into', html`<form method="post" action="${jobUrl(j.id)}/import">${csrf(s)}
      <div class="form-grid"><div class="field"><label class="label" for="dp-target">Schema</label>
        <input id="dp-target" name="target" value="${target}" required maxlength="63" pattern="[A-Za-z_][A-Za-z0-9_$]{0,62}" autocomplete="off" spellcheck="false">
        <span class="help muted small">A new schema is created; into an existing one, the dump's objects are added (or replaced, below). A name other than ${schema} renames the dump's schema in the same transaction.</span></div></div>
      <fieldset class="prop-group"><legend>Content</legend><div class="form-grid">
        ${CONTENT.map(([c, label]) => html`<label class="check"><input type="radio" name="content" value="${c}"${content === c ? raw(' checked') : ''}> ${label}</label>`)}
        <label class="check"><input type="checkbox" name="clean" value="1"${body.clean === '1' ? raw(' checked') : ''}> Drop the dump's objects in the schema first</label>
        <label class="check"><input type="checkbox" name="privileges" value="1"${body.target === undefined || body.privileges === '1' ? raw(' checked') : ''}> Grants</label></div></fieldset>
      <p class="muted small">Everything runs in one transaction: an error rolls it all back. Objects are owned by pgkiln's owner role. Names inside PL/pgSQL bodies are text: after a rename they still say ${schema}.</p>
      <div class="buttons"><button class="btn btn-hot">${icon('upload')} Start the import</button></div></form>`) : '';
  const main = html`${errors.length ? html`<div class="alert alert-error" role="alert">${errors.map((e) => html`<div>${e}</div>`)}</div>` : ''}
    ${region(`What ${j.original_name ?? j.file_name ?? ''} holds`, preview)}${form}`;
  return page(reply, s, 'Import', [[`Job #${j.id}`, jobUrl(j.id)], ['Import']], main, errors.length ? 422 : 200);
}

async function jobPage(reply: FastifyReply, s: Session, j: Job) {
  const o = j.options;
  const facts: [string, Raw | string][] = [
    ['Status', html`${status(j)}${j.error ? html` <span class="u-break">${j.error}</span>` : ''}`],
    ['By', j.username],
    ['Created', j.created_at],
    ...(j.started_at ? [['Started', j.started_at] as [string, string]] : []),
    ...(j.finished_at ? [['Finished', `${j.finished_at} (${j.seconds} s)`] as [string, string]] : []),
    ...(j.kind === 'export' ? [['Options', `${o.format} format, ${CONTENT.find(([c]) => c === o.content)?.[1].toLowerCase() ?? ''}${o.privileges ? ', grants' : ''}${(o.tables as string[])?.length ? `; only ${(o.tables as string[]).join(', ')}` : ''}${(o.exclude as string[])?.length ? `; without ${(o.exclude as string[]).join(', ')}` : ''}`] as [string, string]] : []),
    ...(j.kind === 'import' && j.target_schema ? [['Options', `${CONTENT.find(([c]) => c === o.content)?.[1].toLowerCase() ?? ''}${o.clean ? ', existing objects dropped first' : ''}${o.privileges ? ', grants' : ''}`] as [string, string]] : []),
    ...(j.source_job ? [['From', html`<a href="${jobUrl(j.source_job)}">job #${String(j.source_job)}</a>`] as [string, Raw]] : []),
    ['File', j.file_live ? html`${j.original_name ?? j.file_name ?? ''} · ${size(j.bytes)} · kept until ${j.expires_at ?? ''}` : j.file_name || j.bytes === null ? html`<span class="muted">none</span>` : html`<span class="muted">removed (${size(j.bytes)})</span>`],
  ];
  const actions = html`<div class="buttons">
    ${j.status === 'running' ? html`<a class="btn" href="${jobUrl(j.id)}">${icon('refresh')} Refresh</a>
      <form method="post" action="${jobUrl(j.id)}/cancel" class="inline">${csrf(s)}<button class="btn">${icon('close')} Cancel</button></form>` : ''}
    ${j.file_live && j.kind === 'export' && j.status === 'succeeded' ? html`<a class="btn btn-hot" href="${jobUrl(j.id)}/download">${icon('download')} Download</a>` : ''}
    ${importable(j) ? html`<a class="btn" href="${jobUrl(j.id)}/import">${icon('upload')} Import…</a>` : ''}
    ${j.status !== 'running' ? html`<form method="post" action="${jobUrl(j.id)}/delete" class="inline">${csrf(s)}<button class="btn btn-danger">${icon('trash')} Delete${j.file_live ? ' with its file' : ''}</button></form>` : ''}</div>`;
  const body = html`${region(`Job #${j.id}: ${j.kind}`, html`<p>${what(j)}</p><dl class="dp-facts">${facts.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>${actions}`)}
    ${region('Log', j.log ? html`<pre class="ddl wrap-pre dp-log">${j.log}</pre>` : html`<p class="muted">Nothing logged${j.status === 'running' ? ' yet' : ''}.</p>`)}`;
  return page(reply, s, `Job #${j.id}`, [[`Job #${j.id}`]], body);
}

const exportOptions = (b: Body) => {
  const tables = many((b as Record<string, unknown>).t);
  return {
    format: b.format === 'plain' ? ('plain' as const) : ('custom' as const),
    content: (CONTENT.some(([c]) => c === b.content) ? b.content : 'all') as Content,
    tables: b.mode === 'only' ? tables : [],
    exclude: b.mode === 'except' ? tables : [],
    privileges: b.privileges === '1',
  };
};

export async function dataPumpRoutes(app: FastifyInstance) {
  app.get(URL_BASE, async (req: Req, reply) => {
    const s = await admin(req, reply);
    return s && listPage(reply, s);
  });

  app.get(`${URL_BASE}/export`, async (req: Req, reply) => {
    const s = await admin(req, reply);
    return s && exportPage(reply, s, req.query ?? {});
  });

  app.post(`${URL_BASE}/export`, async (req: Req, reply) => {
    const s = await admin(req, reply);
    if (!s) return;
    const b = req.body ?? {};
    const o = exportOptions(b);
    if (b.mode === 'only' && !o.tables.length) return exportPage(reply, s, { ...b, t: [] } as never, ['Check the tables to export.']);
    try {
      const id = await startExport(s.username!, String(b.schema ?? ''), o);
      await logActivity({ username: s.username, event: 'schema_export', ip: clientIp(req), detail: `${b.schema}: job ${id}` });
      return reply.redirect(jobUrl(id), 303);
    } catch (e) {
      if (!(e instanceof DumpError)) throw e;
      return exportPage(reply, s, b as never, [e.message]);
    }
  });

  app.get(`${URL_BASE}/import`, async (req: Req, reply) => {
    const s = await admin(req, reply);
    return s && importPage(reply, s);
  });

  // the file is streamed to the dump directory (never held in memory); the CSRF token comes before it in the form
  app.post(`${URL_BASE}/upload`, async (req: Req, reply) => {
    if (!req.isMultipart()) return reply.code(415).send('Send the file as multipart/form-data.');
    const body: Body = {};
    let saved: { name: string; original: string; bytes: number; truncated: boolean } | null = null;
    let s: Session | null = null;
    for await (const part of req.parts({ limits: { fileSize: uploadMaxMb() * 1024 * 1024, files: 1 } })) {
      if (part.type !== 'file') {
        body[part.fieldname] = String(part.value ?? '');
        continue;
      }
      if (!s) {
        req.body = body;
        s = await admin(req, reply);
        if (!s) {
          part.file.resume();
          return reply;
        }
      }
      if (part.fieldname !== 'file' || !part.filename || saved) {
        part.file.resume();
        continue;
      }
      await mkdir(DUMP_DIR, { recursive: true, mode: 0o700 });
      const name = `upload-${Date.now()}-${randomBytes(6).toString('hex')}.dump`;
      let bytes = 0;
      part.file.on('data', (c: Buffer) => (bytes += c.length));
      await pipeline(part.file, createWriteStream(filePath(name), { mode: 0o600 }));
      saved = { name, original: part.filename.replace(/[\u0000-\u001f]/g, '').slice(0, 255), bytes, truncated: part.file.truncated };
    }
    if (!s) {
      req.body = body;
      s = await admin(req, reply);
      if (!s) return reply;
    }
    const session = s as Session;
    if (!saved) {
      flash(session, 'Choose a file.', 'error');
      return back(reply, session, `${URL_BASE}/import`);
    }
    if (saved.truncated || !saved.bytes) {
      await rm(filePath(saved.name), { force: true });
      flash(session, saved.truncated ? `The file is larger than ${uploadMaxMb()} MB (PGKILN_DUMP_MAX_MB).` : 'The file is empty.', 'error');
      return back(reply, session, `${URL_BASE}/import`);
    }
    const id = await uploadJob(session.username!, saved.name, saved.original, saved.bytes);
    await logActivity({ username: session.username, event: 'schema_upload', ip: clientIp(req), detail: `${saved.original}: job ${id}` });
    return reply.redirect(`${jobUrl(id)}/import`, 303);
  });

  const withJob = async (req: Req, reply: FastifyReply) => {
    const s = await admin(req, reply);
    if (!s) return null;
    const j = await getJob(req.params.id);
    if (!j) {
      reply.code(404).send('Not found');
      return null;
    }
    return { s, j };
  };

  app.get(`${URL_BASE}/job/:id`, async (req: Req, reply) => {
    const x = await withJob(req, reply);
    return x && jobPage(reply, x.s, x.j);
  });

  app.get(`${URL_BASE}/job/:id/import`, async (req: Req, reply) => {
    const x = await withJob(req, reply);
    if (!x) return;
    if (!importable(x.j)) return reply.redirect(jobUrl(x.j.id));
    return importForm(reply, x.s, x.j);
  });

  app.post(`${URL_BASE}/job/:id/import`, async (req: Req, reply) => {
    const x = await withJob(req, reply);
    if (!x) return;
    const b = req.body ?? {};
    if (!importable(x.j)) return importForm(reply, x.s, x.j, b, ['This file can\'t be imported (any more).']);
    const target = String(b.target ?? '').trim();
    if (!SCHEMA_NAME.test(target)) return importForm(reply, x.s, x.j, b, ['The schema: letters, digits, _ and $, up to 63, not starting with a digit.']);
    try {
      const id = await startImport(x.s.username!, x.j, {
        target, content: (CONTENT.some(([c]) => c === b.content) ? b.content : 'all') as Content, clean: b.clean === '1', privileges: b.privileges === '1',
      });
      await logActivity({ username: x.s.username, event: 'schema_import', ip: clientIp(req), detail: `job ${x.j.id} into ${target}: job ${id}` });
      return reply.redirect(jobUrl(id), 303);
    } catch (e) {
      if (!(e instanceof DumpError)) throw e;
      return importForm(reply, x.s, x.j, b, [e.message]);
    }
  });

  app.get(`${URL_BASE}/job/:id/download`, async (req: Req, reply) => {
    const x = await withJob(req, reply);
    if (!x) return;
    const j = x.j;
    if (!j.file_live || j.kind !== 'export' || j.status !== 'succeeded') return reply.code(404).send('Not found');
    const plain = j.options.format === 'plain';
    const name = `${(j.schema_name ?? 'schema').replace(/[^A-Za-z0-9_-]/g, '_')}-${j.created_at.slice(0, 10)}.${plain ? 'sql' : 'dump'}`;
    await logActivity({ username: x.s.username, event: 'schema_download', ip: clientIp(req), detail: `job ${j.id}` });
    return reply
      .header('content-type', plain ? 'application/sql; charset=utf-8' : 'application/octet-stream')
      .header('content-disposition', `attachment; filename="${name}"`)
      .header('cache-control', 'no-store')
      .header('content-length', String(j.bytes ?? ''))
      .send(readJobFile(j));
  });

  app.post(`${URL_BASE}/job/:id/cancel`, async (req: Req, reply) => {
    const x = await withJob(req, reply);
    if (!x) return;
    flash(x.s, cancelJob(x.j.id) ? 'Cancelling the job.' : 'The job doesn\'t run on this server (any more).', 'ok');
    return back(reply, x.s, jobUrl(x.j.id));
  });

  app.post(`${URL_BASE}/job/:id/delete`, async (req: Req, reply) => {
    const x = await withJob(req, reply);
    if (!x) return;
    try {
      await deleteJob(x.j);
    } catch (e) {
      if (!(e instanceof DumpError)) throw e;
      flash(x.s, e.message, 'error');
      return back(reply, x.s, jobUrl(x.j.id));
    }
    flash(x.s, `Job #${x.j.id} deleted.`);
    return back(reply, x.s, URL_BASE);
  });
}
