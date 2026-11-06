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
import { tr, type BuilderKey, type BuilderTranslate } from './i18n.ts';

// (sprint 103, Database Actions DA-16: Data Pump) SQL Workshop › Schema Export / Import, for administrators: pg_dump of a
// schema (custom or plain, definitions and/or data, tables in or out) and pg_restore of an archive into a new or
// existing schema, as background jobs with their logs, sizes and timing; files are kept for PGKILN_DUMP_KEEP_DAYS.
// The work: src/datapump.ts (jobs, pg_dump, pg_restore) and src/dumpscript.ts (the import's script runner).

const URL_BASE = `${BASE}/sql/data-pump`;
const jobUrl = (id: number) => `${URL_BASE}/job/${id}`;
const crumbs = (tx: BuilderTranslate, ...more: [string, string?][]): [string, string?][] => [[tx('rail.sql_workshop'), `${BASE}/sql`], [tx('sql.tool.datapump'), more.length ? URL_BASE : undefined], ...more];
const many = (v: unknown) => ([] as string[]).concat((v as string | string[] | undefined) ?? []);
const CONTENT: [Content, BuilderKey][] = [['all', 'dp.content.all'], ['definitions', 'dp.content.definitions'], ['data', 'dp.content.data']];
const contentLabel = (tx: BuilderTranslate, c: unknown) => { const x = CONTENT.find(([k]) => k === c); return x ? tx(x[1]) : ''; };

/** An administrator's session; others get a 403 page. */
async function admin(req: Req, reply: FastifyReply) {
  const s = await developer(req, reply);
  if (!s) return null;
  if (await isAdmin(s.username)) return s;
  const tx = tr(s);
  const main = html`<h1 class="u-mb1">${tx('sql.tool.datapump')}</h1><div class="alert alert-error" role="alert">${tx('dp.admins_only')}</div>`;
  await send(reply.code(403), s, shell(s, tx('sql.tool.datapump'), crumbs(tx), main, 'sql'));
  return null;
}

const page = (reply: FastifyReply, s: Session, title: string, trail: [string, string?][], body: Raw, code = 200) =>
  send(reply.code(code), s, shell(s, title, crumbs(tr(s), ...trail), html`<h1 class="u-mb1">${tr(s)('rail.sql_workshop')}</h1>${workshopTabs('datapump', s)}${body}`, 'sql'));

export const size = (n: number | null) =>
  n === null ? '' : n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`;

const STATUS: Record<Job['status'], string> = { uploaded: 'tag-info', running: 'tag-warning', succeeded: 'tag-ok', failed: 'tag-error', cancelled: '' };
const status = (tx: BuilderTranslate, j: Job) => html`<span class="tag ${STATUS[j.status]}">${tx.dyn(`dp.status.${j.status}`, j.status)}</span>`;
const what = (tx: BuilderTranslate, j: Job) =>
  j.kind === 'export'
    ? html`${tx.rich('dp.what.export', { schema: html`<strong>${j.schema_name ?? ''}</strong>` })}${(j.options.format as string) === 'plain' ? ` ${tx('dp.plain_sql')}` : ''}`
    : j.status === 'uploaded'
      ? tx.rich('dp.what.upload', { file: html`<strong class="u-break">${j.original_name ?? ''}</strong>` })
      : tx.rich('dp.what.import', { schema: html`<strong>${j.schema_name ?? ''}</strong>`, target: html`<strong>${j.target_schema ?? ''}</strong>` });

/** Can this job's file be imported? (an export in custom format, or an upload; while its file is kept) */
const importable = (j: Job) =>
  j.file_live && ((j.kind === 'export' && j.status === 'succeeded' && j.options.format !== 'plain') || (j.kind === 'import' && !j.source_job && j.status !== 'running'));

const toolNote = (tx: BuilderTranslate, t: ToolState) =>
  t.ok
    ? html`<p class="muted small">${tx(KEEP_DAYS === 1 ? 'dp.tools_one' : 'dp.tools', { version: t.tools.version, server: String(t.server), n: KEEP_DAYS })}</p>`
    : html`<div class="alert alert-warning" role="alert"><strong>${tx('dp.need_tools')}</strong> ${t.reason}${t.found.length ? html` ${tx('dp.found', { list: t.found.join('; ') })}` : ''}</div>`;

async function listPage(reply: FastifyReply, s: Session) {
  const [jobs, tools] = await Promise.all([listJobs(), findTools()]);
  const tx = tr(s);
  const L = { job: tx('dp.col.job'), what: tx('dp.col.what'), status: tx('sm.col.state'), size: tx('scr.col.size'), started: tx('scr.col.started'), seconds: tx('dp.col.seconds'), by: tx('scr.col.by') };
  const body = html`<div class="ide-head-title u-mb1"><div><h2 class="u-m0">${tx('sql.tool.datapump')}</h2><span class="muted small">${tx('dp.intro')}</span></div>
      <div class="buttons ide-head-actions"><a class="btn btn-hot" href="${URL_BASE}/export">${icon('download')} ${tx('dp.export_schema')}</a> <a class="btn" href="${URL_BASE}/import">${icon('upload')} ${tx('dp.import')}</a></div></div>
    ${toolNote(tx, tools)}
    ${region(tx('dp.jobs'), html`<div class="table-wrap"><table class="report report-reflow dp-jobs"><thead><tr><th>${L.job}</th><th>${L.what}</th><th>${L.status}</th><th class="num">${L.size}</th><th>${L.started}</th><th class="num">${L.seconds}</th><th>${L.by}</th></tr></thead>
      <tbody>${jobs.length ? jobs.map((j) => html`<tr>
        <td data-label="${L.job}"><a href="${jobUrl(j.id)}">#${String(j.id)}</a></td>
        <td data-label="${L.what}" class="u-break">${what(tx, j)}</td>
        <td data-label="${L.status}">${status(tx, j)}</td>
        <td data-label="${L.size}" class="num">${size(j.bytes)}${j.file_name && !j.file_live ? '' : j.bytes !== null && !j.file_name ? html` <span class="muted small">(${tx('dp.removed')})</span>` : ''}</td>
        <td data-label="${L.started}">${j.started_at ?? j.created_at}</td>
        <td data-label="${L.seconds}" class="num">${j.seconds === null ? '' : String(j.seconds)}</td>
        <td data-label="${L.by}" class="u-break">${j.username}</td></tr>`)
        : html`<tr><td colspan="7" class="empty">${tx('dp.no_jobs')}</td></tr>`}</tbody></table></div>`)}`;
  return page(reply, s, tx('sql.tool.datapump'), [], body);
}

async function exportPage(reply: FastifyReply, s: Session, q: Record<string, string | string[] | undefined>, errors: string[] = []) {
  const schemas = await exportableSchemas();
  const tx = tr(s);
  const schema = schemas.includes(String(q.schema ?? '')) ? String(q.schema) : '';
  const tables = schema ? await schemaTables(schema) : [];
  const mode = ['all', 'only', 'except'].includes(String(q.mode)) ? String(q.mode) : 'all';
  const picked = new Set(many(q.t));
  const format = q.format === 'plain' ? 'plain' : 'custom';
  const content = CONTENT.some(([c]) => c === q.content) ? String(q.content) : 'all';
  const privileges = q.schema === undefined || q.privileges === '1';
  const body = html`${toolNote(tx, await findTools())}
    ${errors.length ? html`<div class="alert alert-error" role="alert">${errors.map((e) => html`<div>${e}</div>`)}</div>` : ''}
    <form method="get" action="${URL_BASE}/export" class="u-mb1"><div class="form-grid"><div class="field"><label class="label" for="dp-schema">${tx('sm.schema')}</label>
      <select id="dp-schema" name="schema" required><option value="">${tx('ddl.choose_schema')}</option>${schemas.map((x) => html`<option value="${x}"${x === schema ? raw(' selected') : ''}>${x}</option>`)}</select></div></div>
      <div class="buttons"><button class="btn">${icon('table')} ${tx('ul.choose')}</button></div></form>
    ${schema ? region(tx('dp.export_of', { schema }), html`<form method="post" action="${URL_BASE}/export">${csrf(s)}<input type="hidden" name="schema" value="${schema}">
      <fieldset class="prop-group"><legend>${tx('cl.format')}</legend><div class="form-grid">
        <label class="check"><input type="radio" name="format" value="custom"${format === 'custom' ? raw(' checked') : ''}> ${tx('dp.fmt.custom')}</label>
        <label class="check"><input type="radio" name="format" value="plain"${format === 'plain' ? raw(' checked') : ''}> ${tx('dp.fmt.plain')}</label></div></fieldset>
      <fieldset class="prop-group"><legend>${tx('dp.content')}</legend><div class="form-grid">
        ${CONTENT.map(([c, label]) => html`<label class="check"><input type="radio" name="content" value="${c}"${content === c ? raw(' checked') : ''}> ${tx(label)}</label>`)}
        <label class="check"><input type="checkbox" name="privileges" value="1"${privileges ? raw(' checked') : ''}> ${tx('ddl.grants')}</label></div></fieldset>
      <fieldset class="prop-group"><legend>${tx('dp.tables')}</legend>
        <div class="form-grid">${([['all', 'dp.mode.all'], ['only', 'dp.mode.only'], ['except', 'dp.mode.except']] as [string, BuilderKey][]).map(([m, label]) =>
          html`<label class="check"><input type="radio" name="mode" value="${m}"${mode === m ? raw(' checked') : ''}> ${tx(label)}</label>`)}</div>
        ${tables.length ? html`<div class="dp-tables">${tables.map((t) => html`<label class="check u-break"><input type="checkbox" name="t" value="${t}"${picked.has(t) ? raw(' checked') : ''}> ${t}</label>`)}</div>`
          : html`<p class="muted">${tx('dp.no_tables')}</p>`}
        <p class="muted small">${tx('dp.some_tables_note')}</p></fieldset>
      <div class="buttons"><button class="btn btn-hot">${icon('download')} ${tx('dp.start_export')}</button></div></form>`) : ''}`;
  return page(reply, s, tx('dp.export_schema'), [[tx('dp.export')]], body, errors.length ? 422 : 200);
}

async function importPage(reply: FastifyReply, s: Session) {
  const files = (await listJobs()).filter(importable);
  const tx = tr(s);
  const L = { job: tx('dp.col.job'), file: tx('dp.col.file'), size: tx('scr.col.size'), made: tx('dp.col.made') };
  const body = html`${toolNote(tx, await findTools())}
    ${region(tx('dp.upload_title'), html`<form method="post" action="${URL_BASE}/upload" enctype="multipart/form-data">${csrf(s)}
      <div class="form-grid"><div class="field"><label class="label" for="dp-file">${tx('dp.upload_label', { mb: String(uploadMaxMb()) })}</label>
        <input type="file" id="dp-file" name="file" required></div></div>
      <div class="buttons"><button class="btn btn-hot">${icon('upload')} ${tx('scr.upload')}</button></div></form>
      <p class="muted small">${tx('dp.upload_note')}</p>`)}
    ${region(tx('dp.or_export'), html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>${L.job}</th><th>${L.file}</th><th class="num">${L.size}</th><th>${L.made}</th><th></th></tr></thead>
      <tbody>${files.length ? files.map((j) => html`<tr><td data-label="${L.job}"><a href="${jobUrl(j.id)}">#${String(j.id)}</a></td><td data-label="${L.file}" class="u-break">${what(tx, j)}</td>
        <td data-label="${L.size}" class="num">${size(j.bytes)}</td><td data-label="${L.made}">${j.finished_at ?? j.created_at}</td>
        <td><a class="btn btn-sm" href="${jobUrl(j.id)}/import">${icon('upload')} ${tx('dp.import_dots')}</a></td></tr>`)
        : html`<tr><td colspan="5" class="empty">${tx('dp.no_exports')}</td></tr>`}</tbody></table></div>`)}`;
  return page(reply, s, tx('dp.import'), [[tx('dp.import')]], body);
}

async function importForm(reply: FastifyReply, s: Session, j: Job, body: Body = {}, errors: string[] = []) {
  const tx = tr(s);
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
        <dt>${tx('sm.schema')}</dt><dd>${toc.schemas.join(', ') || '-'}${toc.schemaEntry ? '' : html` <span class="muted small">${tx('dp.no_create_schema')}</span>`}</dd>
        <dt>${tx('su.tables')}</dt><dd class="u-break">${tables.length ? tables.join(', ') : html`<span class="muted">${tx('dp.none')}</span>`}${rows ? html` <span class="muted small">${tx('dp.data_of', { n: String(rows) })}</span>` : ''}</dd></dl>
      <div class="table-wrap"><table class="report"><thead><tr><th>${tx('dp.object_type')}</th><th class="num">${tx('dp.entries')}</th></tr></thead>
        <tbody>${toc.counts.map(([d, n]) => html`<tr><td>${d.toLowerCase()}</td><td class="num">${String(n)}</td></tr>`)}</tbody></table></div>`;
    if (problem) schema = '';
  } catch (e) {
    preview = html`<div class="alert alert-error" role="alert">${(e as Error).message}</div>`;
  }
  const target = body.target ?? schema;
  const content = CONTENT.some(([c]) => c === body.content) ? body.content! : 'all';
  const form = schema ? region(tx('dp.import_into'), html`<form method="post" action="${jobUrl(j.id)}/import">${csrf(s)}
      <div class="form-grid"><div class="field"><label class="label" for="dp-target">${tx('sm.schema')}</label>
        <input id="dp-target" name="target" value="${target}" required maxlength="63" pattern="[A-Za-z_][A-Za-z0-9_$]{0,62}" autocomplete="off" spellcheck="false">
        <span class="help muted small">${tx('dp.target_help', { schema })}</span></div></div>
      <fieldset class="prop-group"><legend>${tx('dp.content')}</legend><div class="form-grid">
        ${CONTENT.map(([c, label]) => html`<label class="check"><input type="radio" name="content" value="${c}"${content === c ? raw(' checked') : ''}> ${tx(label)}</label>`)}
        <label class="check"><input type="checkbox" name="clean" value="1"${body.clean === '1' ? raw(' checked') : ''}> ${tx('dp.clean')}</label>
        <label class="check"><input type="checkbox" name="privileges" value="1"${body.target === undefined || body.privileges === '1' ? raw(' checked') : ''}> ${tx('ddl.grants')}</label></div></fieldset>
      <p class="muted small">${tx('dp.one_tx_note', { schema })}</p>
      <div class="buttons"><button class="btn btn-hot">${icon('upload')} ${tx('dp.start_import')}</button></div></form>`) : '';
  const main = html`${errors.length ? html`<div class="alert alert-error" role="alert">${errors.map((e) => html`<div>${e}</div>`)}</div>` : ''}
    ${region(tx('dp.holds', { file: j.original_name ?? j.file_name ?? '' }), preview)}${form}`;
  return page(reply, s, tx('dp.import'), [[tx('dp.job', { id: j.id }), jobUrl(j.id)], [tx('dp.import')]], main, errors.length ? 422 : 200);
}

async function jobPage(reply: FastifyReply, s: Session, j: Job) {
  const o = j.options;
  const tx = tr(s);
  const exportOpts = () => [
    tx('dp.opt.format', { format: String(o.format) }), contentLabel(tx, o.content), ...(o.privileges ? [tx('ddl.grants')] : []),
  ].join(', ') + ((o.tables as string[])?.length ? `; ${tx('dp.opt.only', { list: (o.tables as string[]).join(', ') })}` : '') + ((o.exclude as string[])?.length ? `; ${tx('dp.opt.without', { list: (o.exclude as string[]).join(', ') })}` : '');
  const importOpts = () => [contentLabel(tx, o.content), ...(o.clean ? [tx('dp.opt.cleaned')] : []), ...(o.privileges ? [tx('ddl.grants')] : [])].join(', ');
  const facts: [string, Raw | string][] = [
    [tx('sm.col.state'), html`${status(tx, j)}${j.error ? html` <span class="u-break">${j.error}</span>` : ''}`],
    [tx('scr.col.by'), j.username],
    [tx('dp.created'), j.created_at],
    ...(j.started_at ? [[tx('scr.col.started'), j.started_at] as [string, string]] : []),
    ...(j.finished_at ? [[tx('dp.finished'), `${j.finished_at} (${j.seconds} s)`] as [string, string]] : []),
    ...(j.kind === 'export' ? [[tx('dp.options'), exportOpts()] as [string, string]] : []),
    ...(j.kind === 'import' && j.target_schema ? [[tx('dp.options'), importOpts()] as [string, string]] : []),
    ...(j.source_job ? [[tx('cl.col.from'), html`<a href="${jobUrl(j.source_job)}">${tx('dp.job_lower', { id: String(j.source_job) })}</a>`] as [string, Raw]] : []),
    [tx('dp.col.file'), j.file_live ? html`${j.original_name ?? j.file_name ?? ''} · ${size(j.bytes)} · ${tx('dp.kept_until', { time: j.expires_at ?? '' })}` : j.file_name || j.bytes === null ? html`<span class="muted">${tx('dp.none')}</span>` : html`<span class="muted">${tx('dp.removed')} (${size(j.bytes)})</span>`],
  ];
  const actions = html`<div class="buttons">
    ${j.status === 'running' ? html`<a class="btn" href="${jobUrl(j.id)}">${icon('refresh')} ${tx('sm.refresh')}</a>
      <form method="post" action="${jobUrl(j.id)}/cancel" class="inline">${csrf(s)}<button class="btn">${icon('close')} ${tx('sm.cancel')}</button></form>` : ''}
    ${j.file_live && j.kind === 'export' && j.status === 'succeeded' ? html`<a class="btn btn-hot" href="${jobUrl(j.id)}/download">${icon('download')} ${tx('scr.download')}</a>` : ''}
    ${importable(j) ? html`<a class="btn" href="${jobUrl(j.id)}/import">${icon('upload')} ${tx('dp.import_dots')}</a>` : ''}
    ${j.status !== 'running' ? html`<form method="post" action="${jobUrl(j.id)}/delete" class="inline">${csrf(s)}<button class="btn btn-danger">${icon('trash')} ${j.file_live ? tx('dp.delete_with_file') : tx('scr.delete')}</button></form>` : ''}</div>`;
  const body = html`${region(tx('dp.job_kind', { id: j.id, kind: tx.dyn(`dp.kind.${j.kind}`, j.kind) }), html`<p>${what(tx, j)}</p><dl class="dp-facts">${facts.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>${actions}`)}
    ${region(tx('dp.log'), j.log ? html`<pre class="ddl wrap-pre dp-log">${j.log}</pre>` : html`<p class="muted">${j.status === 'running' ? tx('dp.nothing_logged_yet') : tx('dp.nothing_logged')}</p>`)}`;
  return page(reply, s, tx('dp.job', { id: j.id }), [[tx('dp.job', { id: j.id })]], body);
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
    if (b.mode === 'only' && !o.tables.length) return exportPage(reply, s, { ...b, t: [] } as never, [tr(s)('dp.err.check_tables')]);
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
      flash(session, tr(session)('dp.err.choose_file'), 'error');
      return back(reply, session, `${URL_BASE}/import`);
    }
    if (saved.truncated || !saved.bytes) {
      await rm(filePath(saved.name), { force: true });
      flash(session, saved.truncated ? tr(session)('dp.err.too_large', { mb: uploadMaxMb() }) : tr(session)('dp.err.empty'), 'error');
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
    if (!importable(x.j)) return importForm(reply, x.s, x.j, b, [tr(x.s)('dp.err.not_importable')]);
    const target = String(b.target ?? '').trim();
    if (!SCHEMA_NAME.test(target)) return importForm(reply, x.s, x.j, b, [tr(x.s)('dp.err.schema_name')]);
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
    flash(x.s, cancelJob(x.j.id) ? tr(x.s)('dp.cancelling') : tr(x.s)('dp.not_running'), 'ok');
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
    flash(x.s, tr(x.s)('dp.deleted', { id: x.j.id }));
    return back(reply, x.s, URL_BASE);
  });
}
