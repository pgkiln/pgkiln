import type { FastifyInstance, FastifyReply } from 'fastify';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import {
  applyMapping,
  autoMap,
  COLUMN_TYPES,
  createTableSql,
  LoadError,
  LoadFailed,
  loadRows,
  loadWithDefinition,
  mappingProblems,
  parseFile,
  suggestColumns,
  tableColumns,
  type DataLoadDefinition,
  type LoadMapping,
  type LoadMode,
  type LoadResult,
  type NewColumn,
  type Sheet,
} from '../dataload.ts';
import { readMultipart } from '../runtime/files.ts';
import type { Session } from '../session.ts';
import type { ComponentSpec } from './components.ts';
import { back, BASE, csrf, developer, flash, region, send, shell, workshopTabs, type Body, type Req } from './ui.ts';

// SQL Workshop → Load Data: upload a CSV/TSV/XLSX/JSON/XML file, preview it,
// and load it into a new table (column types inferred) or an existing one
// (columns mapped by name, append / replace / merge), or with a saved data
// load definition (Shared Components). Runs on the owner connection, like SQL
// Commands. The file is kept as a temporary file of the builder session
// between the steps. A mapping can be saved as a data load definition.

/** Shared Components → Data load definitions (meta.data_load_def). */
export const DATA_LOAD_DEF_SPEC: ComponentSpec = {
  table: 'meta.data_load_def',
  scope: 'app',
  label: 'Data load definition',
  plural: 'Data load definitions',
  icon: 'upload',
  summary: (d) => d.name,
  defaults: { format: 'auto', headers: true, mode: 'append', skip_errors: false, columns: [] },
  validate: (v) => {
    if (v.columns === '{}') v.columns = '[]';
    if (!/^[A-Za-z_][A-Za-z0-9_$]*([.][A-Za-z_][A-Za-z0-9_$]*)?$/.test(String(v.table_name ?? ''))) return 'Table: a table name, optionally with its schema (sales.orders).';
    let cols: unknown;
    try {
      cols = JSON.parse(String(v.columns ?? '[]'));
    } catch {
      return 'Columns is not valid JSON.';
    }
    const problems = mappingProblems(cols);
    return problems.length ? problems.join(' ') : null;
  },
  fields: [
    { name: 'name', label: 'Name', kind: 'upper', group: 'Identification', help: 'The data_load process uses it: {"file_item": "P5_FILE", "definition": "NAME"}.' },
    { name: 'description', label: 'Description', kind: 'text', wide: true, group: 'Identification' },
    { name: 'table_name', label: 'Table', kind: 'text', group: 'Target', help: 'schema.table; processes load it as the application\'s role (grants and row level security apply).' },
    { name: 'mode', label: 'Mode', kind: 'select', options: ['append', 'merge', 'replace'], group: 'Target', help: 'merge updates rows with the same primary key; replace deletes all rows first.' },
    { name: 'skip_errors', label: 'Skip rows with errors (otherwise nothing is loaded when a row fails)', kind: 'bool', group: 'Target' },
    { name: 'format', label: 'File format', kind: 'select', options: ['auto', 'csv', 'xlsx', 'json', 'xml'], group: 'File' },
    { name: 'headers', label: 'CSV / Excel: the first row holds the column names', kind: 'bool', group: 'File' },
    { name: 'row_tag', label: 'XML row element', kind: 'text', group: 'File', help: 'The repeating element of a row, e.g. employee or employees/employee. Empty: detected. DTDs and entities are not accepted.' },
    { name: 'columns', label: 'Columns (JSON)', kind: 'json', wide: true, group: 'Columns',
      help: '[{"source": "Hire date", "column": "hiredate", "format": "DD.MM.YYYY"}, {"source": "Name", "column": "ename", "transform": ["trim", "upper"]}, {"column": "status", "default": "NEW"}] · source: the file column (XML: element name, path a/b or @attribute); transform: trim, upper, lower, initcap, collapse_spaces, digits_only; format: to_date / to_timestamp / to_number mask; default: when empty. Empty list: file columns match table columns by name.' },
  ],
};

/** "Load a file with it" on a definition's Shared Components page. */
export const dataLoadDefExtras = (row: { id: number }) =>
  html`<p class="u-mt1"><a class="btn" href="${BASE}/sql/load?definition=${row.id}">${icon('upload')} Load a file with this definition</a></p>`;

async function definitions() {
  return (
    await owner.query<{ id: number; app_id: number; app_name: string; name: string; table_name: string }>(
      'select d.id, d.app_id, a.name as app_name, d.name, d.table_name from meta.data_load_def d join meta.app a on a.id = d.app_id order by a.name, d.name',
    )
  ).rows;
}

async function definition(id: unknown) {
  if (!/^\d+$/.test(String(id ?? ''))) return undefined;
  return owner.one<DataLoadDefinition & { id: number; app_id: number }>('select * from meta.data_load_def where id = $1', [id]);
}

export const MAX_MB = Number(process.env.DATA_LOAD_MAX_MB ?? 50);
const PREVIEW_ROWS = 10;

async function uploaded(s: Session, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return owner.one<{ filename: string; content: Buffer }>('select filename, content from meta.temp_file where id = $1 and session_id = $2', [id, s.id]);
}

const defName = (filename: string) =>
  filename
    .replace(/\.[^.]*$/, '')
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .replace(/^[^A-Z]+|_+$/g, '')
    .slice(0, 50) || 'FILE_LOAD';

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

export function preview(sheet: Sheet) {
  return html`<div class="table-wrap"><table class="report"><thead><tr>${sheet.headers.map((h) => html`<th>${h}</th>`)}</tr></thead>
    <tbody>${sheet.rows.slice(0, PREVIEW_ROWS).map((r) => html`<tr>${r.map((v) => html`<td>${v === null ? html`<span class="null">null</span>` : v}</td>`)}</tr>`)}</tbody></table></div>`;
}

export function resultHtml(r: LoadResult, failed: boolean) {
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
    return page(s, reply, await uploadForm(s, undefined, req.query.definition));
  });

  const uploadForm = async (s: Session, error?: string, chosen?: string) => {
    const defs = await definitions();
    return region(
      'Load data from a file',
      html`${error ? html`<div class="alert alert-error" role="alert">${error}</div>` : ''}
      <p class="muted">CSV or TSV (UTF-8 or Windows-1252; the delimiter is detected), Excel .xlsx (the first sheet), JSON (an array of objects, or JSON Lines) or XML (rows from a repeating element), up to ${MAX_MB} MB.
        Next you choose a new or existing table. Loading runs as the builder's owner connection.
        To download a table or a query as a file, use <a href="${BASE}/sql/unload">Unload Data</a>.</p>
      <form method="post" enctype="multipart/form-data">${csrf(s)}
        <div class="form-grid">
          <div class="field"><label class="label" for="f_file">File</label>
            <input type="file" id="f_file" name="file" accept=".csv,.tsv,.txt,.xlsx,.json,.jsonl,.xml,text/csv,application/json,application/xml,text/xml" required></div>
          <div class="field"><span class="label" aria-hidden="true"></span>
            <label class="check"><input type="checkbox" name="headers" value="true" checked> First row contains column names</label></div>
          <div class="field"><label class="label" for="f_row_tag">XML row element</label>
            <input id="f_row_tag" name="row_tag" placeholder="e.g. employee (empty: detected)">
            <small class="help">XML only. DTDs and entity declarations are not accepted.</small></div>
          <div class="field"><label class="label" for="f_definition">Data load definition</label>
            <select id="f_definition" name="definition"><option value="">- none: choose the table next -</option>${defs.map(
              (d) => html`<option value="${d.id}"${String(d.id) === chosen ? raw(' selected') : ''}>${d.app_name} · ${d.name} → ${d.table_name}</option>`,
            )}</select>
            <small class="help">Shared Components of an application: table, column mapping and transformations.</small></div>
        </div>
        <div class="buttons"><button class="btn btn-hot">${icon('upload')} Next</button></div>
      </form>`,
    );
  };

  app.post(`${BASE}/sql/load`, async (req: Req, reply) => {
    let file;
    if (req.isMultipart()) {
      const parsed = await readMultipart(req, MAX_MB);
      req.body = parsed.body as Body;
      file = parsed.files.get('file');
    }
    const s = await developer(req, reply);
    if (!s) return;
    if (!file) return page(s, reply, await uploadForm(s, 'Choose a file.'));
    if (file.truncated) return page(s, reply, await uploadForm(s, `The file is larger than ${MAX_MB} MB.`));
    const def = await definition(req.body?.definition);
    const rowTag = (req.body?.row_tag ?? '').trim();
    try {
      if (def) await parseFile(file.filename, file.data, { headers: def.headers, format: def.format, rowTag: def.row_tag });
      else await parseFile(file.filename, file.data, { headers: req.body?.headers === 'true', rowTag });
    } catch (e) {
      if (e instanceof LoadError) return page(s, reply, await uploadForm(s, e.message, req.body?.definition));
      throw e;
    }
    const r = await owner.one(
      `insert into meta.temp_file (session_id, item_name, filename, mime_type, size, content) values ($1, 'DATA_LOAD', $2, $3, $4, $5) returning id`,
      [s.id, file.filename.replace(/^.*[\\/]/, ''), file.mimetype, file.data.length, file.data],
    );
    const q = new URLSearchParams({ h: req.body?.headers === 'true' ? '1' : '0', ...(rowTag ? { rt: rowTag } : {}), ...(def ? { d: String(def.id) } : {}) });
    return reply.redirect(`${BASE}/sql/load/${r!.id}?${q}`, 303);
  });

  // step 2: preview, choose the target
  const targetPage = async (req: Req, reply: FastifyReply, s: Session, result: Raw | '' = '') => {
    const f = await uploaded(s, req.params.id);
    if (!f) return reply.redirect(`${BASE}/sql/load`);
    const headers = (req.query.h ?? req.body?.h) !== '0';
    const rowTag = (req.query.rt ?? req.body?.rt ?? '').trim();
    const def = await definition(req.query.d ?? req.body?.d);
    let sheet: Sheet;
    try {
      sheet = def
        ? await parseFile(f.filename, f.content, { headers: def.headers, format: def.format, rowTag: def.row_tag })
        : await parseFile(f.filename, f.content, { headers, rowTag });
    } catch (e) {
      if (e instanceof LoadError) return page(s, reply, await uploadForm(s, e.message));
      throw e;
    }
    const action = `${BASE}/sql/load/${req.params.id}`;
    const hidden = html`${csrf(s)}<input type="hidden" name="h" value="${headers ? '1' : '0'}"><input type="hidden" name="rt" value="${rowTag}">`;
    const info = `${f.filename}: ${sheet.rows.length} row(s), ${sheet.headers.length} column(s)${
      sheet.format === 'xlsx' ? ', Excel' : sheet.format === 'json' ? ', JSON' : sheet.format === 'xml' ? `, XML rows <${sheet.rowPath}>` : `, delimiter ${sheet.delimiter === '\t' ? 'tab' : `“${sheet.delimiter}”`}`
    }`;
    if (def) {
      let mapped: Sheet = sheet;
      let problem = '';
      try {
        if (def.columns?.length) mapped = applyMapping(sheet, def.columns).sheet;
      } catch (e) {
        if (!(e instanceof LoadError)) throw e;
        problem = e.message;
      }
      const defHtml = html`<p>Definition <a href="${BASE}/apps/${def.app_id}/shared?c=data_load_def-${def.id}">${def.name}</a>: into <b>${def.table_name}</b>, mode ${def.mode}${def.skip_errors ? ', skipping rows with errors' : ''}.
          ${def.columns?.length ? '' : ' File columns are matched to table columns by name.'}</p>
        ${problem ? html`<div class="alert alert-error" role="alert">${problem}</div>` : html`<p class="muted">After the mapping and transformations${mapped.rows.length > PREVIEW_ROWS ? ` (first ${PREVIEW_ROWS} rows)` : ''}:</p>${preview(mapped)}`}
        <form method="post" action="${action}">${hidden}<input type="hidden" name="target" value="definition"><input type="hidden" name="d" value="${def.id}">
          <div class="buttons"><button class="btn btn-hot"${problem ? raw(' disabled') : ''}>${icon('upload')} Load into ${def.table_name}</button></div></form>`;
      return page(
        s,
        reply,
        html`${result}
          ${region('Preview', html`<p class="muted">${info}${sheet.rows.length > PREVIEW_ROWS ? ` (first ${PREVIEW_ROWS} shown)` : ''}. <a href="${BASE}/sql/load">Choose another file</a></p>${preview(sheet)}`)}
          <div class="u-spacer"></div>
          ${region(`Load with ${def.name}`, defHtml)}`,
      );
    }
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
    const apps = (await owner.query<{ id: number; name: string }>('select id, name from meta.app order by name')).rows;
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
        <div class="buttons"><button class="btn btn-hot">Load into ${chosen}</button></div>
        <details class="u-mt1"><summary>Save this mapping as a data load definition</summary>
          <p class="muted">For the data_load process of an application, and to load files like this one again.</p>
          <div class="form-grid">
            <div class="field"><label class="label" for="f_def_app">Application</label>
              <select id="f_def_app" name="def_app">${apps.map((a) => html`<option value="${a.id}">${a.name}</option>`)}</select></div>
            <div class="field"><label class="label" for="f_def_name">Name</label><input id="f_def_name" name="def_name" placeholder="e.g. ${defName(f.filename)}"></div>
          </div>
          <div class="buttons"><button class="btn" name="target" value="save_definition">${icon('check')} Save as definition</button></div>
        </details></form>`;
    }
    const existing = html`<form method="get" action="${action}" class="search u-mwnone">
        <input type="hidden" name="h" value="${headers ? '1' : '0'}"><input type="hidden" name="rt" value="${rowTag}">
        <select name="table" aria-label="Table"><option value="">- choose a table -</option>${tables.map((t) => html`<option${t === chosen ? raw(' selected') : ''}>${t}</option>`)}</select>
        <button class="btn">Map columns</button></form>${mapping}`;

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
    const rowTag = (b.rt ?? '').trim();
    if (b.target === 'save_definition') {
      const sheet = await parseFile(f.filename, f.content, { headers, rowTag }).catch((e) => e as Error);
      const columns: LoadMapping[] =
        sheet instanceof Error ? [] : sheet.headers.flatMap((h, index) => (b[`map_${index}`] ? [{ source: h, column: b[`map_${index}`]! }] : []));
      const name = (b.def_name ?? '').trim().toUpperCase() || defName(f.filename);
      const mode = ['append', 'replace', 'merge'].includes(b.mode ?? '') ? b.mode : 'append';
      const format = sheet instanceof Error ? 'auto' : sheet.format;
      try {
        const r = await owner.one(
          `insert into meta.data_load_def (app_id, name, table_name, format, headers, row_tag, mode, skip_errors, columns)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id, app_id`,
          [b.def_app, name, b.table, format, headers, format === 'xml' && !(sheet instanceof Error) ? sheet.rowPath : null, mode, b.skip_errors === 'true', JSON.stringify(columns)],
        );
        flash(s, `Data load definition ${name} saved.`);
        return back(reply, s, `${BASE}/apps/${r!.app_id}/shared?c=data_load_def-${r!.id}`);
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (!code?.startsWith('23') && code !== '22P02') throw e;
        reply.code(422);
        return targetPage(req, reply, s, html`<div class="alert alert-error" role="alert">The definition could not be saved: ${
          code === '23505' ? `the application already has a definition named ${name}.` : (e as Error).message}</div>`);
      }
    }
    let result: LoadResult | undefined;
    let error: string | undefined;
    let failed = false;
    try {
      const def = b.target === 'definition' ? await definition(b.d) : undefined;
      const sheet = def ? null : await parseFile(f.filename, f.content, { headers, rowTag });
      const opts = { skipErrors: b.skip_errors === 'true', firstRow: headers && sheet && (sheet.format === 'csv' || sheet.format === 'xlsx') ? 2 : 1 };
      result = await owner.tx(async (c) => {
        if (def) return loadWithDefinition(c, def, f);
        if (!sheet) throw new LoadError('The data load definition no longer exists.');
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
