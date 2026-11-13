import type { FastifyInstance, FastifyReply } from 'fastify';
import { rlsHint } from './rls-hint.ts';
import { owner } from '../db.ts';
import { esc, html, raw, type Raw } from '../html.ts';
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
import { appWorkspace, currentWorkspace, workshopDb } from './workspaces.ts';
import { scopedTx, tr, translatorFor, type BuilderTranslate } from './i18n.ts';

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
  html`<p class="u-mt1"><a class="btn" href="${BASE}/sql/load?definition=${row.id}">${icon('upload')} ${scopedTx('dl.load_with_def')}</a></p>`;

/** The data load definitions of the current workspace's applications. */
async function definitions(s: Session) {
  return (
    await owner.query<{ id: number; app_id: number; app_name: string; name: string; table_name: string }>(
      `select d.id, d.app_id, a.name as app_name, d.name, d.table_name from meta.data_load_def d join meta.app a on a.id = d.app_id
        where meta.app_workspace(a.id) = $1 order by a.name, d.name`,
      [currentWorkspace(s)],
    )
  ).rows;
}

async function definition(s: Session, id: unknown) {
  if (!/^\d+$/.test(String(id ?? ''))) return undefined;
  return owner.one<DataLoadDefinition & { id: number; app_id: number }>(
    'select * from meta.data_load_def where id = $1 and meta.app_workspace(app_id) = $2',
    [id, currentWorkspace(s)],
  );
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

export function resultHtml(r: LoadResult, failed: boolean, tx: BuilderTranslate = translatorFor('en')) {
  const errors = r.errors.length
    ? html`<div class="table-wrap"><table class="report"><thead><tr><th class="num">${tx('dl.row')}</th><th>${tx('dl.error')}</th></tr></thead>
        <tbody>${r.errors.map((e) => html`<tr><td class="num">${e.row}</td><td>${e.message}</td></tr>`)}</tbody></table></div>
        ${r.failed > r.errors.length ? html`<p class="muted">${tx('dl.first_errors', { n: r.errors.length })}</p>` : ''}`
    : '';
  const summary = failed
    ? html`<div class="alert alert-error" role="alert">${tx('dl.failed', { n: `${r.failed}${r.errors.length >= 100 ? '+' : ''}` })}</div>`
    : html`<div class="alert alert-success" role="status">${r.table}: ${tx('dl.inserted', { n: r.inserted })}${r.updated ? `, ${tx('dl.updated', { n: r.updated })}` : ''}${r.failed ? `, ${tx('dl.skipped', { n: r.failed })}` : ''}.</div>`;
  return html`${summary}${errors}`;
}

export async function dataLoadRoutes(app: FastifyInstance) {
  const page = (s: Session, reply: FastifyReply, main: Raw) =>
    send(reply, s, shell(s, tr(s)('sql.tool.load'), [[tr(s)('rail.sql_workshop'), `${BASE}/sql`], [tr(s)('sql.tool.load')]], html`<h1 class="u-mb1">${tr(s)('rail.sql_workshop')}</h1>${workshopTabs('load', s)}${main}`, 'sql'));

  // step 1: choose a file
  app.get(`${BASE}/sql/load`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    return page(s, reply, await uploadForm(s, undefined, req.query.definition));
  });

  const uploadForm = async (s: Session, error?: string, chosen?: string) => {
    const defs = await definitions(s);
    const tx = tr(s);
    return region(
      tx('dl.from_file'),
      html`${error ? html`<div class="alert alert-error" role="alert">${error}</div>` : ''}
      <p class="muted">${tx('dl.intro', { mb: MAX_MB })}
        ${tx.rich('dl.intro_unload', { link: raw(`<a href="${BASE}/sql/unload">${esc(tx('sql.tool.unload'))}</a>`) })}</p>
      <form method="post" enctype="multipart/form-data">${csrf(s)}
        <div class="form-grid">
          <div class="field"><label class="label" for="f_file">${tx('dl.file')}</label>
            <input type="file" id="f_file" name="file" accept=".csv,.tsv,.txt,.xlsx,.json,.jsonl,.xml,text/csv,application/json,application/xml,text/xml" required></div>
          <div class="field"><span class="label" aria-hidden="true"></span>
            <label class="check"><input type="checkbox" name="headers" value="true" checked> ${tx('dl.headers')}</label></div>
          <div class="field"><label class="label" for="f_row_tag">${tx('dl.row_tag')}</label>
            <input id="f_row_tag" name="row_tag" placeholder="${tx('dl.row_tag_ph')}">
            <small class="help">${tx('dl.row_tag_help')}</small></div>
          <div class="field"><label class="label" for="f_definition">${tx('comp.data_load_def')}</label>
            <select id="f_definition" name="definition"><option value="">${tx('dl.no_definition')}</option>${defs.map(
              (d) => html`<option value="${d.id}"${String(d.id) === chosen ? raw(' selected') : ''}>${d.app_name} · ${d.name} → ${d.table_name}</option>`,
            )}</select>
            <small class="help">${tx('dl.definition_help')}</small></div>
        </div>
        <div class="buttons"><button class="btn btn-hot">${icon('upload')} ${tx('dl.next')}</button></div>
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
    if (!file) return page(s, reply, await uploadForm(s, tr(s)('dl.e.no_file')));
    if (file.truncated) return page(s, reply, await uploadForm(s, tr(s)('dl.e.too_large', { mb: MAX_MB })));
    const def = await definition(s, req.body?.definition);
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
    const def = await definition(s, req.query.d ?? req.body?.d);
    let sheet: Sheet;
    try {
      sheet = def
        ? await parseFile(f.filename, f.content, { headers: def.headers, format: def.format, rowTag: def.row_tag })
        : await parseFile(f.filename, f.content, { headers, rowTag });
    } catch (e) {
      if (e instanceof LoadError) return page(s, reply, await uploadForm(s, e.message));
      throw e;
    }
    const tx = tr(s);
    const action = `${BASE}/sql/load/${req.params.id}`;
    const hidden = html`${csrf(s)}<input type="hidden" name="h" value="${headers ? '1' : '0'}"><input type="hidden" name="rt" value="${rowTag}">`;
    const info = `${f.filename}: ${tx('dl.info', { rows: sheet.rows.length, columns: sheet.headers.length })}${
      sheet.format === 'xlsx' ? ', Excel' : sheet.format === 'json' ? ', JSON' : sheet.format === 'xml' ? `, ${tx('dl.xml_rows', { path: `<${sheet.rowPath}>` })}` : `, ${tx('dl.delimiter', { d: sheet.delimiter === '\t' ? tx('dl.tab') : `“${sheet.delimiter}”` })}`
    }`;
    const firstShown = sheet.rows.length > PREVIEW_ROWS ? ` ${tx('dl.first_shown', { n: PREVIEW_ROWS })}` : '';
    const anotherFile = html`<a href="${BASE}/sql/load">${tx('dl.another_file')}</a>`;
    if (def) {
      let mapped: Sheet = sheet;
      let problem = '';
      try {
        if (def.columns?.length) mapped = applyMapping(sheet, def.columns).sheet;
      } catch (e) {
        if (!(e instanceof LoadError)) throw e;
        problem = e.message;
      }
      const defHtml = html`<p>${tx.rich('dl.def_into', { def: raw(`<a href="${BASE}/apps/${def.app_id}/shared?c=data_load_def-${def.id}">${esc(def.name)}</a>`), table: raw(`<b>${esc(def.table_name)}</b>`), mode: def.mode })}${def.skip_errors ? `, ${tx('dl.def_skipping')}` : ''}.
          ${def.columns?.length ? '' : ` ${tx('dl.def_by_name')}`}</p>
        ${problem ? html`<div class="alert alert-error" role="alert">${problem}</div>` : html`<p class="muted">${mapped.rows.length > PREVIEW_ROWS ? tx('dl.after_mapping_first', { n: PREVIEW_ROWS }) : tx('dl.after_mapping')}</p>${preview(mapped)}`}
        <form method="post" action="${action}">${hidden}<input type="hidden" name="target" value="definition"><input type="hidden" name="d" value="${def.id}">
          <div class="buttons"><button class="btn btn-hot"${problem ? raw(' disabled') : ''}>${icon('upload')} ${tx('dl.load_into', { table: def.table_name })}</button></div></form>`;
      return page(
        s,
        reply,
        html`${result}
          ${region(tx('dl.preview'), html`<p class="muted">${info}${firstShown}. ${anotherFile}</p>${preview(sheet)}`)}
          <div class="u-spacer"></div>
          ${region(tx('dl.load_with', { name: def.name }), defHtml)}`,
      );
    }
    const skip = html`<div class="field"><span class="label" aria-hidden="true"></span><label class="check"><input type="checkbox" name="skip_errors" value="true"> ${tx('dl.skip_errors')}</label></div>`;

    const newCols = suggestColumns(sheet);
    const newTable = html`<form method="post" action="${action}">${hidden}<input type="hidden" name="target" value="new">
      <div class="form-grid"><div class="field"><label class="label" for="f_new_table">${tx('dl.table_name')}</label>
        <input id="f_new_table" name="new_table" value="${tableName(f.filename)}" required>
        <small class="help">${tx.code('dl.table_name_help')}</small></div></div>
      <div class="table-wrap"><table class="report"><thead><tr><th>${tx('dl.file_column')}</th><th>${tx('dl.column_name')}</th><th>${tx('dl.type')}</th></tr></thead><tbody>
        ${newCols.map((c) => html`<tr><td>${sheet.headers[c.index]}</td>
          <td><input name="name_${c.index}" value="${c.name}" aria-label="${tx('dl.aria_name', { column: sheet.headers[c.index] })}"></td>
          <td><select name="type_${c.index}" aria-label="${tx('dl.aria_type', { column: sheet.headers[c.index] })}">${COLUMN_TYPES.map((t) => html`<option${t === c.type ? raw(' selected') : ''}>${t}</option>`)}</select></td></tr>`)}
      </tbody></table></div>
      ${skip}
      <div class="buttons"><button class="btn btn-hot">${tx('dl.create_and_load')}</button></div></form>`;

    const db = await workshopDb(s);
    const tables = (
      await db.query(
        `select c.oid::regclass::text as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.relkind in ('r', 'p') and n.nspname !~ '^pg_' and n.nspname not in ('information_schema', 'meta')
            and has_table_privilege(c.oid, 'INSERT') order by 1`,
      )
    ).rows.map((r) => r.name as string);
    const chosen = tables.find((t) => t === (req.query.table ?? req.body?.table));
    const apps = (await owner.query<{ id: number; name: string }>('select id, name from meta.app where meta.app_workspace(id) = $1 order by name', [currentWorkspace(s)])).rows;
    let mapping: Raw | '' = '';
    if (chosen) {
      const cols = await db.tx((c) => tableColumns(c, chosen));
      const auto = autoMap(sheet.headers, cols);
      const hasPk = cols.some((c) => c.pk);
      mapping = html`<form method="post" action="${action}">${hidden}<input type="hidden" name="target" value="existing"><input type="hidden" name="table" value="${chosen}">
        <div class="table-wrap"><table class="report"><thead><tr><th>${tx('dl.file_column')}</th><th>${tx('dl.table_column')}</th></tr></thead><tbody>
          ${sheet.headers.map((h, i) => {
            const cur = auto.find((m) => m.index === i)?.column ?? '';
            return html`<tr><td>${h}</td><td><select name="map_${i}" aria-label="${tx('dl.aria_map', { column: h })}"><option value="">${tx('dl.skip')}</option>${cols
              .filter((c) => !c.generated)
              .map((c) => html`<option value="${c.name}"${c.name === cur ? raw(' selected') : ''}>${c.name} (${c.type}${c.pk ? `, ${tx('dl.key')}` : ''})</option>`)}</select></td></tr>`;
          })}
        </tbody></table></div>
        <fieldset class="field"><legend class="label">${tx('dl.mode')}</legend><div class="radio-group">
          <label class="check"><input type="radio" name="mode" value="append" checked> ${tx('dl.mode_append')}</label>
          <label class="check"><input type="radio" name="mode" value="merge"${hasPk ? '' : raw(' disabled')}> ${tx('dl.mode_merge')}</label>
          <label class="check"><input type="radio" name="mode" value="replace"> ${tx('dl.mode_replace')}</label>
        </div></fieldset>
        ${skip}
        <div class="buttons"><button class="btn btn-hot">${tx('dl.load_into', { table: chosen })}</button></div>
        <details class="u-mt1"><summary>${tx('dl.save_mapping')}</summary>
          <p class="muted">${tx('dl.save_mapping_help')}</p>
          <div class="form-grid">
            <div class="field"><label class="label" for="f_def_app">${tx('rm.application')}</label>
              <select id="f_def_app" name="def_app">${apps.map((a) => html`<option value="${a.id}">${a.name}</option>`)}</select></div>
            <div class="field"><label class="label" for="f_def_name">${tx('dl.name')}</label><input id="f_def_name" name="def_name" placeholder="${tx('rm.eg', { example: defName(f.filename) })}"></div>
          </div>
          <div class="buttons"><button class="btn" name="target" value="save_definition">${icon('check')} ${tx('dl.save_definition')}</button></div>
        </details></form>`;
    }
    const existing = html`<form method="get" action="${action}" class="search u-mwnone">
        <input type="hidden" name="h" value="${headers ? '1' : '0'}"><input type="hidden" name="rt" value="${rowTag}">
        <select name="table" aria-label="${tx('dl.table')}"><option value="">${tx('dl.choose_table')}</option>${tables.map((t) => html`<option${t === chosen ? raw(' selected') : ''}>${t}</option>`)}</select>
        <button class="btn">${tx('dl.map_columns')}</button></form>${mapping}`;

    return page(
      s,
      reply,
      html`${result}
        ${region(tx('dl.preview'), html`<p class="muted">${info}${firstShown}. ${anotherFile}</p>${preview(sheet)}`)}
        <div class="columns u-mt1">
          ${region(tx('dl.into_new'), newTable)}
          ${region(tx('dl.into_existing'), existing)}
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
        if (!/^\d{1,9}$/.test(String(b.def_app ?? '')) || (await appWorkspace(String(b.def_app))) !== currentWorkspace(s)) throw new LoadError(tr(s)('rm.e.choose_app'));
        const r = await owner.one(
          `insert into meta.data_load_def (app_id, name, table_name, format, headers, row_tag, mode, skip_errors, columns)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id, app_id`,
          [b.def_app, name, b.table, format, headers, format === 'xml' && !(sheet instanceof Error) ? sheet.rowPath : null, mode, b.skip_errors === 'true', JSON.stringify(columns)],
        );
        flash(s, tr(s)('dl.def_saved', { name }));
        return back(reply, s, `${BASE}/apps/${r!.app_id}/shared?c=data_load_def-${r!.id}`);
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (!(e instanceof LoadError) && !code?.startsWith('23') && code !== '22P02') throw e;
        reply.code(422);
        return targetPage(req, reply, s, html`<div class="alert alert-error" role="alert">${tr(s)('dl.def_not_saved', {
          reason: code === '23505' ? tr(s)('dl.def_exists', { name }) : (e as Error).message })}</div>`);
      }
    }
    let result: LoadResult | undefined;
    let error: string | undefined;
    let failed = false;
    try {
      const def = b.target === 'definition' ? await definition(s, b.d) : undefined;
      const sheet = def ? null : await parseFile(f.filename, f.content, { headers, rowTag });
      const opts = { skipErrors: b.skip_errors === 'true', firstRow: headers && sheet && (sheet.format === 'csv' || sheet.format === 'xlsx') ? 2 : 1 };
      result = await (await workshopDb(s)).tx(async (c) => {
        if (def) return loadWithDefinition(c, def, f);
        if (!sheet) throw new LoadError(tr(s)('dl.e.def_gone'));
        if (b.target === 'new') {
          const cols: NewColumn[] = sheet.headers
            .map((_, index) => ({ index, name: (b[`name_${index}`] ?? '').trim(), type: (b[`type_${index}`] ?? 'text') as NewColumn['type'] }))
            .filter((x) => x.name);
          if (!cols.length) throw new LoadError(tr(s)('dl.e.no_columns'));
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
        html`${resultHtml(result, false, tr(s))}${await rlsHint(s, `${BASE}/sql/load`, result.errors.map((x) => x.message))}<div class="buttons">
          <a class="btn btn-hot" href="${BASE}/sql/objects?o=${encodeURIComponent(result.table)}">${icon('table')} ${tr(s)('dl.view', { table: result.table })}</a>
          <a class="btn" href="${BASE}/sql/load">${icon('upload')} ${tr(s)('dl.load_another')}</a></div>`,
      );
    }
    reply.code(422);
    // (sprint 186) row level security or a grant refused the developer login: why, and what to do
    const hint = await rlsHint(s, `${BASE}/sql/load`, [error, ...(result?.errors ?? []).map((x) => x.message)]);
    return targetPage(req, reply, s, html`${result ? resultHtml(result, true, tr(s)) : html`<div class="alert alert-error" role="alert">${error}</div>`}${hint}`);
  });
}
