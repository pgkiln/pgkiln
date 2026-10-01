import type { FastifyInstance, FastifyReply } from 'fastify';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import {
  autoMap,
  COLUMN_TYPES,
  createTableSql,
  LoadError,
  LoadFailed,
  loadRows,
  parseFile,
  suggestColumns,
  tableColumns,
  type LoadMode,
  type LoadResult,
  type NewColumn,
  type Sheet,
} from '../dataload.ts';
import { readMultipart } from '../runtime/files.ts';
import type { Session } from '../session.ts';
import { BASE, csrf, developer, region, send, shell, workshopTabs, type Body, type Req } from './ui.ts';

// SQL Workshop → Load Data: upload a CSV/TSV/XLSX file, preview it, and load
// it into a new table (column types inferred) or an existing one (columns
// mapped by name, append / replace / merge). Runs on the owner connection,
// like SQL Commands. The file is kept as a temporary file of the builder
// session between the steps.

const MAX_MB = Number(process.env.DATA_LOAD_MAX_MB ?? 50);
const PREVIEW_ROWS = 10;

async function uploaded(s: Session, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return owner.one<{ filename: string; content: Buffer }>('select filename, content from meta.temp_file where id = $1 and session_id = $2', [id, s.id]);
}

const tableName = (filename: string) =>
  `public.${
    filename
      .replace(/\.[^.]*$/, '')
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/^(\d)/, 't_$1')
      .slice(0, 50) || 'imported_data'
  }`;

function preview(sheet: Sheet) {
  return html`<div class="table-wrap"><table class="report"><thead><tr>${sheet.headers.map((h) => html`<th>${h}</th>`)}</tr></thead>
    <tbody>${sheet.rows.slice(0, PREVIEW_ROWS).map((r) => html`<tr>${r.map((v) => html`<td>${v === null ? html`<span class="null">null</span>` : v}</td>`)}</tr>`)}</tbody></table></div>`;
}

function resultHtml(r: LoadResult, failed: boolean) {
  const errors = r.errors.length
    ? html`<div class="table-wrap"><table class="report"><thead><tr><th class="num">Row</th><th>Error</th></tr></thead>
        <tbody>${r.errors.map((e) => html`<tr><td class="num">${e.row}</td><td>${e.message}</td></tr>`)}</tbody></table></div>
        ${r.failed > r.errors.length ? html`<p class="muted">The first ${r.errors.length} errors are shown.</p>` : ''}`
    : '';
  const summary = failed
    ? html`<div class="alert alert-error" role="alert">${r.failed}${r.errors.length >= 100 ? '+' : ''} row(s) could not be loaded, so nothing was loaded. Fix the file, or tick “Skip rows with errors”.</div>`
    : html`<div class="alert alert-success" role="status">${r.table}: ${r.inserted} row(s) inserted${r.updated ? `, ${r.updated} updated` : ''}${r.failed ? `, ${r.failed} skipped` : ''}.</div>`;
  return html`${summary}${errors}`;
}

export async function dataLoadRoutes(app: FastifyInstance) {
  const page = (s: Session, reply: FastifyReply, main: Raw) =>
    send(reply, s, shell(s, 'Load Data', [['SQL Workshop', `${BASE}/sql`], ['Load Data']], html`<h1 class="u-mb1">SQL Workshop</h1>${workshopTabs('load')}${main}`, 'sql'));

  // step 1: choose a file
  app.get(`${BASE}/sql/load`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    return page(s, reply, uploadForm(s));
  });

  const uploadForm = (s: Session, error?: string) =>
    region(
      'Load data from a file',
      html`${error ? html`<div class="alert alert-error" role="alert">${error}</div>` : ''}
      <p class="muted">CSV or TSV (UTF-8 or Windows-1252; the delimiter is detected), Excel .xlsx (the first sheet) or JSON (an array of objects, or JSON Lines), up to ${MAX_MB} MB.
        Next you choose a new or existing table. Loading runs as the builder's owner connection.</p>
      <form method="post" enctype="multipart/form-data">${csrf(s)}
        <div class="form-grid">
          <div class="field"><label class="label" for="f_file">File</label>
            <input type="file" id="f_file" name="file" accept=".csv,.tsv,.txt,.xlsx,.json,.jsonl,text/csv,application/json" required></div>
          <div class="field"><span class="label" aria-hidden="true"></span>
            <label class="check"><input type="checkbox" name="headers" value="true" checked> First row contains column names</label></div>
        </div>
        <div class="buttons"><button class="btn btn-hot">${icon('upload')} Next</button></div>
      </form>`,
    );

  app.post(`${BASE}/sql/load`, async (req: Req, reply) => {
    let file;
    if (req.isMultipart()) {
      const parsed = await readMultipart(req, MAX_MB);
      req.body = parsed.body as Body;
      file = parsed.files.get('file');
    }
    const s = await developer(req, reply);
    if (!s) return;
    if (!file) return page(s, reply, uploadForm(s, 'Choose a file.'));
    if (file.truncated) return page(s, reply, uploadForm(s, `The file is larger than ${MAX_MB} MB.`));
    try {
      await parseFile(file.filename, file.data, { headers: req.body?.headers === 'true' });
    } catch (e) {
      if (e instanceof LoadError) return page(s, reply, uploadForm(s, e.message));
      throw e;
    }
    const r = await owner.one(
      `insert into meta.temp_file (session_id, item_name, filename, mime_type, size, content) values ($1, 'DATA_LOAD', $2, $3, $4, $5) returning id`,
      [s.id, file.filename.replace(/^.*[\\/]/, ''), file.mimetype, file.data.length, file.data],
    );
    return reply.redirect(`${BASE}/sql/load/${r!.id}?h=${req.body?.headers === 'true' ? 1 : 0}`, 303);
  });

  // step 2: preview, choose the target
  const targetPage = async (req: Req, reply: FastifyReply, s: Session, result: Raw | '' = '') => {
    const f = await uploaded(s, req.params.id);
    if (!f) return reply.redirect(`${BASE}/sql/load`);
    const headers = (req.query.h ?? req.body?.h) !== '0';
    let sheet: Sheet;
    try {
      sheet = await parseFile(f.filename, f.content, { headers });
    } catch (e) {
      if (e instanceof LoadError) return page(s, reply, uploadForm(s, e.message));
      throw e;
    }
    const action = `${BASE}/sql/load/${req.params.id}`;
    const hidden = html`${csrf(s)}<input type="hidden" name="h" value="${headers ? '1' : '0'}">`;
    const skip = html`<div class="field"><span class="label" aria-hidden="true"></span><label class="check"><input type="checkbox" name="skip_errors" value="true"> Skip rows with errors (otherwise nothing is loaded when a row fails)</label></div>`;

    const newCols = suggestColumns(sheet);
    const newTable = html`<form method="post" action="${action}">${hidden}<input type="hidden" name="target" value="new">
      <div class="form-grid"><div class="field"><label class="label" for="f_new_table">Table name</label>
        <input id="f_new_table" name="new_table" value="${tableName(f.filename)}" required>
        <small class="help">schema.table; the table gets an identity primary key <code>id</code>.</small></div></div>
      <div class="table-wrap"><table class="report"><thead><tr><th>File column</th><th>Column name (empty = skip)</th><th>Type</th></tr></thead><tbody>
        ${newCols.map((c) => html`<tr><td>${sheet.headers[c.index]}</td>
          <td><input name="name_${c.index}" value="${c.name}" aria-label="Column name for ${sheet.headers[c.index]}"></td>
          <td><select name="type_${c.index}" aria-label="Type of ${sheet.headers[c.index]}">${COLUMN_TYPES.map((t) => html`<option${t === c.type ? raw(' selected') : ''}>${t}</option>`)}</select></td></tr>`)}
      </tbody></table></div>
      ${skip}
      <div class="buttons"><button class="btn btn-hot">Create table and load</button></div></form>`;

    const tables = (
      await owner.query(
        `select c.oid::regclass::text as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.relkind in ('r', 'p') and n.nspname !~ '^pg_' and n.nspname not in ('information_schema', 'meta') order by 1`,
      )
    ).rows.map((r) => r.name as string);
    const chosen = tables.find((t) => t === (req.query.table ?? req.body?.table));
    let mapping: Raw | '' = '';
    if (chosen) {
      const cols = await owner.tx((c) => tableColumns(c, chosen));
      const auto = autoMap(sheet.headers, cols);
      const hasPk = cols.some((c) => c.pk);
      mapping = html`<form method="post" action="${action}">${hidden}<input type="hidden" name="target" value="existing"><input type="hidden" name="table" value="${chosen}">
        <div class="table-wrap"><table class="report"><thead><tr><th>File column</th><th>Table column</th></tr></thead><tbody>
          ${sheet.headers.map((h, i) => {
            const cur = auto.find((m) => m.index === i)?.column ?? '';
            return html`<tr><td>${h}</td><td><select name="map_${i}" aria-label="Table column for ${h}"><option value="">- skip -</option>${cols
              .filter((c) => !c.generated)
              .map((c) => html`<option value="${c.name}"${c.name === cur ? raw(' selected') : ''}>${c.name} (${c.type}${c.pk ? ', key' : ''})</option>`)}</select></td></tr>`;
          })}
        </tbody></table></div>
        <fieldset class="field"><legend class="label">Mode</legend><div class="radio-group">
          <label class="check"><input type="radio" name="mode" value="append" checked> Append: insert all rows</label>
          <label class="check"><input type="radio" name="mode" value="merge"${hasPk ? '' : raw(' disabled')}> Merge: update rows with the same primary key, insert the others</label>
          <label class="check"><input type="radio" name="mode" value="replace"> Replace: delete all rows first</label>
        </div></fieldset>
        ${skip}
        <div class="buttons"><button class="btn btn-hot">Load into ${chosen}</button></div></form>`;
    }
    const existing = html`<form method="get" action="${action}" class="search u-mwnone">
        <input type="hidden" name="h" value="${headers ? '1' : '0'}">
        <select name="table" aria-label="Table"><option value="">- choose a table -</option>${tables.map((t) => html`<option${t === chosen ? raw(' selected') : ''}>${t}</option>`)}</select>
        <button class="btn">Map columns</button></form>${mapping}`;

    const info = `${f.filename}: ${sheet.rows.length} row(s), ${sheet.headers.length} column(s)${sheet.format === 'xlsx' ? ', Excel' : sheet.format === 'json' ? ', JSON' : `, delimiter ${sheet.delimiter === '\t' ? 'tab' : `“${sheet.delimiter}”`}`}`;
    return page(
      s,
      reply,
      html`${result}
        ${region(`Preview`, html`<p class="muted">${info}${sheet.rows.length > PREVIEW_ROWS ? ` (first ${PREVIEW_ROWS} shown)` : ''}. <a href="${BASE}/sql/load">Choose another file</a></p>${preview(sheet)}`)}
        <div class="columns u-mt1">
          ${region('Load into a new table', newTable)}
          ${region('Load into an existing table', existing)}
        </div>`,
    );
  };

  app.get(`${BASE}/sql/load/:id`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    return targetPage(req, reply, s);
  });

  // step 3: load
  app.post(`${BASE}/sql/load/:id`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const f = await uploaded(s, req.params.id);
    if (!f) return reply.redirect(`${BASE}/sql/load`);
    const b = req.body ?? {};
    const headers = b.h !== '0';
    let result: LoadResult | undefined;
    let error: string | undefined;
    let failed = false;
    try {
      const sheet = await parseFile(f.filename, f.content, { headers });
      const opts = { skipErrors: b.skip_errors === 'true', firstRow: headers ? 2 : 1 };
      result = await owner.tx(async (c) => {
        if (b.target === 'new') {
          const cols: NewColumn[] = sheet.headers
            .map((_, index) => ({ index, name: (b[`name_${index}`] ?? '').trim(), type: (b[`type_${index}`] ?? 'text') as NewColumn['type'] }))
            .filter((x) => x.name);
          if (!cols.length) throw new LoadError('Give at least one column a name.');
          await c.query(createTableSql((b.new_table ?? '').trim(), cols));
          const table = (b.new_table ?? '').trim();
          return loadRows(c, sheet, { ...opts, table, mode: 'append', columns: cols.map((x) => ({ index: x.index, column: x.name })) });
        }
        const columns = sheet.headers.flatMap((_, index) => (b[`map_${index}`] ? [{ index, column: b[`map_${index}`]! }] : []));
        const mode = (['append', 'replace', 'merge'].includes(b.mode ?? '') ? b.mode : 'append') as LoadMode;
        return loadRows(c, sheet, { ...opts, table: b.table ?? '', mode, columns });
      });
    } catch (e) {
      if (e instanceof LoadFailed) {
        result = e.result;
        failed = true;
      } else if (e instanceof LoadError || (e as { code?: string }).code) error = (e as Error).message;
      else throw e;
    }
    if (result && !failed) {
      await owner.query('delete from meta.temp_file where id = $1', [req.params.id]);
      return page(
        s,
        reply,
        html`${resultHtml(result, false)}<div class="buttons">
          <a class="btn btn-hot" href="${BASE}/sql/objects?o=${encodeURIComponent(result.table)}">${icon('table')} View ${result.table}</a>
          <a class="btn" href="${BASE}/sql/load">${icon('upload')} Load another file</a></div>`,
      );
    }
    reply.code(422);
    return targetPage(req, reply, s, result ? resultHtml(result, true) : html`<div class="alert alert-error" role="alert">${error}</div>`);
  });
}
