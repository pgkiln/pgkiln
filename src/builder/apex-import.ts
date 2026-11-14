// (sprint 182, CD-1/CD-4 leftover) App Builder → Import → From Oracle APEX. Step 1 uploads an APEX
// application export in the SQL format (f100.sql, or a .zip of a split export); the file is kept as a
// temporary file of the builder session (meta.temp_file), never run: src/apeximport.ts reads it as
// text. Step 2 shows the import report (what each component becomes, what needs porting, what is not
// mapped) with the alias and the schema of the tables; its POST imports the translated pgkiln/2
// document with meta.import_app(), the same path as the JSON import, into the developer's workspace.
import { importRole } from '../app-role.ts';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { owner } from '../db.ts';
import { html, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { apexSource, apexToDoc, MAX_APEX_BYTES, NotAnApexExport, type ApexReport, type ReportEntry } from '../apeximport.ts';
import { ApexParseError } from '../apexparse.ts';
import { readMultipart } from '../runtime/files.ts';
import type { Session } from '../session.ts';
import { currentWorkspace, placeApp } from './workspaces.ts';
import { BASE, back, csrf, developer, flash, input, region, send, shell, type Body, type Req } from './ui.ts';
import { scopedTx as tx } from './i18n.ts';

export const APEX_ITEM = 'APEX_IMPORT';
const MAX_MB = MAX_APEX_BYTES / 1024 / 1024;

async function uploaded(s: Session, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return owner.one<{ filename: string; content: Buffer }>('select filename, content from meta.temp_file where id = $1 and session_id = $2 and item_name = $3', [id, s.id, APEX_ITEM]);
}

/** The export's report and document, or why the file is not one. */
async function translate(content: Buffer, alias: string | null, schema: string | null) {
  try {
    return apexToDoc(await apexSource(content), { alias, schema });
  } catch (e) {
    if (e instanceof NotAnApexExport || e instanceof ApexParseError) return { error: e.message };
    throw e;
  }
}

const STATUS_TAG: Record<string, string> = { mapped: 'tag-ok', notes: 'tag-warning', not_mapped: 'tag-error' };

function entriesTable(rows: ReportEntry[]) {
  return html`<div class="table-wrap"><table class="report report-reflow"><thead><tr>
      <th scope="col">${tx('apx.col.page')}</th><th scope="col">${tx('apx.col.component')}</th><th scope="col">${tx('apx.col.apex_type')}</th>
      <th scope="col">${tx('apx.col.becomes')}</th><th scope="col">${tx('apx.col.status')}</th><th scope="col">${tx('apx.col.notes')}</th></tr></thead><tbody>
    ${rows.map((e) => html`<tr>
      <td data-label="${tx('apx.col.page')}">${e.page ?? ''}</td>
      <td data-label="${tx('apx.col.component')}">${tx(`apx.kind.${e.kind}`)} <strong>${e.name}</strong></td>
      <td data-label="${tx('apx.col.apex_type')}"><code>${e.apexType}</code></td>
      <td data-label="${tx('apx.col.becomes')}">${e.target ? html`<code>${e.target}</code>` : '–'}</td>
      <td data-label="${tx('apx.col.status')}"><span class="tag ${STATUS_TAG[e.status]}">${tx(`apx.status.${e.status}`)}</span>${e.port ? html` <span class="tag tag-warning">${tx('apx.needs_porting')}</span>` : ''}</td>
      <td data-label="${tx('apx.col.notes')}">${e.notes.length ? html`<ul class="apx-notes">${e.notes.map((n) => html`<li>${n}</li>`)}</ul>` : ''}</td>
    </tr>`)}
    </tbody></table></div>`;
}

/** The import report as a page section (names and notes from the file are escaped like any value). */
export function reportHtml(report: ApexReport): Raw {
  const c = report.counts;
  const open = report.entries.filter((e) => e.status !== 'mapped');
  const done = report.entries.filter((e) => e.status === 'mapped');
  const skipped = Object.entries(report.skipped).sort(([x], [y]) => (x < y ? -1 : 1));
  return html`<p class="apx-summary"><span class="tag tag-ok">${tx('apx.status.mapped')}: ${c.mapped}</span>
      <span class="tag tag-warning">${tx('apx.status.notes')}: ${c.notes}</span>
      <span class="tag tag-error">${tx('apx.status.not_mapped')}: ${c.not_mapped}</span>
      <span class="tag">${tx('apx.needs_porting')}: ${c.port}</span></p>
    ${open.length ? entriesTable(open) : ''}
    ${done.length ? html`<details class="apx-mapped"><summary>${tx('apx.mapped_without_notes', { n: done.length })}</summary>${entriesTable(done)}</details>` : ''}
    ${skipped.length ? html`<details class="apx-skipped"><summary>${tx('apx.not_read', { n: skipped.length })}</summary>
      <ul>${skipped.map(([m, n]) => html`<li><code>${m}</code> × ${n}</li>`)}</ul></details>` : ''}`;
}

export async function apexImportRoutes(app: FastifyInstance) {
  const page = (s: Session, reply: FastifyReply, main: Raw) =>
    send(reply, s, shell(s, tx('apx.title'), [[tx('aff.app_builder'), BASE], [tx('apx.import'), `${BASE}/import`], [tx('apx.from_apex')]], html`<div class="apx">${main}</div>`));

  const uploadForm = (s: Session, error?: string) =>
    html`<h1>${tx('apx.title')}</h1>
      <p class="muted">${tx('apx.intro', { mb: MAX_MB })}</p>
      ${region(tx('apx.file'), html`${error ? html`<div class="alert alert-error" role="alert">${error}</div>` : ''}
        <form method="post" action="${BASE}/import/apex" enctype="multipart/form-data">${csrf(s)}
          <div class="field"><label class="label" for="f_file">${tx('apx.file')}</label>
            <input type="file" id="f_file" name="file" accept=".sql,.zip,application/sql,application/zip,text/plain" required></div>
          <div class="buttons"><a class="btn" href="${BASE}/import">${tx('aff.cancel')}</a><button class="btn btn-hot">${icon('upload')} ${tx('apx.read')}</button></div>
        </form>`)}`;

  app.get(`${BASE}/import/apex`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    return page(s, reply, uploadForm(s));
  });

  // step 1: the file, read once to see that it is an export
  app.post(`${BASE}/import/apex`, async (req: Req, reply) => {
    let file;
    if (req.isMultipart()) {
      const parsed = await readMultipart(req, MAX_MB);
      req.body = parsed.body as Body;
      file = parsed.files.get('file');
    }
    const s = await developer(req, reply);
    if (!s) return;
    const fail = (message: string) => {
      reply.code(422);
      return page(s, reply, uploadForm(s, message));
    };
    if (!file) return fail(tx('aff.choose_file'));
    if (file.truncated || file.data.length > MAX_APEX_BYTES) return fail(tx('aff.too_large', { mb: MAX_MB }));
    const t = await translate(file.data, null, null);
    if ('error' in t) return fail(tx('apx.not_an_export', { reason: t.error! }));
    const r = await owner.one(
      `insert into meta.temp_file (session_id, item_name, filename, mime_type, size, content) values ($1, $2, $3, $4, $5, $6) returning id`,
      [s.id, APEX_ITEM, file.filename.replace(/^.*[\\/]/, '').slice(0, 200), 'application/sql', file.data.length, file.data],
    );
    return reply.redirect(`${BASE}/import/apex/${r!.id}`, 303);
  });

  // step 2: the report, the alias and the schema
  const reportPage = async (req: Req, reply: FastifyReply, s: Session, b: Body | null, message = '') => {
    const f = await uploaded(s, req.params.id);
    if (!f) return reply.redirect(`${BASE}/import/apex`, 303);
    const alias = (b?.alias ?? '').trim() || null;
    const schema = b && b.schema !== undefined ? b.schema.trim() : null;
    const t = await translate(f.content, alias, schema);
    if ('error' in t) return page(s, reply, uploadForm(s, tx('apx.not_an_export', { reason: t.error! })));
    const { report } = t;
    const a = report.application;
    return page(s, reply, html`<h1>${tx('apx.report_title', { name: a.name })}</h1>
      <p class="muted">${f.filename}${a.release ? html` · APEX ${a.release}` : ''}${a.id ? html` · ${tx('apx.apex_app', { id: a.id })}` : ''}</p>
      ${message ? html`<div class="alert alert-error" role="alert">${message}</div>` : ''}
      ${region(tx('apx.report'), reportHtml(report))}
      ${region(tx('apx.import'), html`<form method="post" action="${BASE}/import/apex/${req.params.id}">${csrf(s)}
        <div class="form-grid">
          ${input('alias', tx('apx.alias'), a.alias, { required: true, help: tx('apx.alias_help') })}
          ${input('schema', tx('apx.schema'), schema ?? a.schema, { help: tx('apx.schema_help') })}
        </div>
        <p class="muted">${tx('apx.what_happens')}</p>
        <div class="buttons"><a class="btn" href="${BASE}/import/apex">${tx('apx.another')}</a>
          <button class="btn" name="action" value="preview">${tx('apx.update')}</button>
          <button class="btn btn-hot" name="action" value="import">${icon('upload')} ${tx('apx.import')}</button></div>
      </form>`)}`);
  };

  app.get(`${BASE}/import/apex/:id`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    return reportPage(req, reply, s, null);
  });

  // step 3: import
  app.post(`${BASE}/import/apex/:id`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = req.body ?? {};
    if (b.action !== 'import') return reportPage(req, reply, s, b);
    const f = await uploaded(s, req.params.id);
    if (!f) return reply.redirect(`${BASE}/import/apex`, 303);
    const failed = (message: string) => {
      reply.code(422);
      return reportPage(req, reply, s, b, message);
    };
    const alias = String(b.alias ?? '').trim();
    if (!/^[a-z][a-z0-9_-]*$/.test(alias) || alias.length > 100) return failed(tx('apx.alias_bad'));
    const ws = currentWorkspace(s);
    if (ws < 1) return failed(tx('rte.you_are_not_a_developer'));
    if ((await owner.query('select 1 from meta.app where alias = $1', [alias])).rowCount) return failed(tx('apx.alias_taken', { alias }));
    const t = await translate(f.content, alias, String(b.schema ?? '').trim());
    if ('error' in t) return failed(tx('apx.not_an_export', { reason: t.error! }));
    let id: number;
    let roleNote: string | null = null;
    try {
      id = await owner.tx(async (c) => {
        // (sprint 186, NX-S2) without a parsing schema's role: app_<alias> with rights on the parsing schema
        roleNote = await importRole(c, t.doc as { app?: Record<string, unknown> }, { alias, ws, schema: String(b.schema ?? '').trim() || null });
        const made = (await c.query('select meta.import_app($1::jsonb, $2) as id', [JSON.stringify(t.doc), alias])).rows[0];
        await placeApp(c, made.id, ws);
        return made.id as number;
      });
    } catch (e) {
      return failed(tx('apx.import_failed', { message: (e as Error).message }));
    }
    await owner.query('delete from meta.temp_file where id = $1', [req.params.id]);
    flash(s, `${tx('apx.imported', { alias, port: t.report.counts.port, not_mapped: t.report.counts.not_mapped })}${roleNote ? ` ${roleNote}` : ''}`);
    return back(reply, s, `${BASE}/apps/${id}`);
  });
}
