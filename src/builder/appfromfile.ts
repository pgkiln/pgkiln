import type { FastifyInstance, FastifyReply } from 'fastify';
import pg from 'pg';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import {
  COLUMN_TYPES,
  columnName,
  createTableSql,
  LoadError,
  LoadFailed,
  loadRows,
  parseFile,
  suggestColumns,
  type LoadResult,
  type NewColumn,
  type Sheet,
} from '../dataload.ts';
import { readMultipart } from '../runtime/files.ts';
import type { Session } from '../session.ts';
import { MAX_MB, preview, resultHtml } from './dataload.ts';
import { buildAppFromSheets, MAX_SHEETS, parseBook, sheetsForm, type BuiltBook, type NamedSheet } from './appsheets.ts';
import { appWizardRoutes, PASTED } from './appwizard.ts';
import { finishGeneratedApp, checkNewApp, createApp, createAppError, reservedSchema, type CheckedApp } from './newapp.ts';
import { currentWorkspace } from './workspaces.ts';
import { BASE, csrf, developer, input, region, select, send, shell, type Body, type Req } from './ui.ts';
import { scopedTx as tx } from './i18n.ts';

// Create → From a file (APEX: Create App from a File). Step 1 uploads a
// CSV/TSV, Excel .xlsx, JSON or XML file (parsed by src/dataload.ts, the
// Data Workshop's code: type inference, size and row limits); step 2 shows
// a preview with the proposed application, table and column names and
// types, all editable; its POST creates, in one owner transaction, the
// application (its own role and schema, as the blank application wizard
// does: newapp.ts), the table with an identity primary key in the app's
// schema, loads the rows (per-row errors as in Load Data), and generates
// the pages with meta.generate_page (migration 047): a report and form, and
// optionally a dashboard chart and a faceted search page, each with a
// navigation entry. Plain forms: no JavaScript needed. The file is kept as a
// temporary file of the builder session between the steps.
// A workbook with several sheets (or a JSON object with several arrays)
// becomes several tables: appsheets.ts. Pasted data (appwizard.ts) is kept as
// a temporary file too and takes the same steps.

export const ITEM = 'APP_FROM_FILE';
const SAMPLE = 3;

/** "employee-list_2026.xlsx" → "Employee list 2026" */
export function appNameFor(filename: string) {
  const base = filename.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '').replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Imported data';
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/** "Employee list 2026.xlsx" → "employee-list-2026" (a free alias: -2, -3, … when taken) */
export async function aliasFor(filename: string) {
  let alias =
    filename
      .replace(/^.*[\\/]/, '')
      .replace(/\.[^.]*$/, '')
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'imported';
  if (!/^[a-z]/.test(alias)) alias = `app-${alias}`;
  const taken = new Set(
    (await owner.query<{ alias: string }>(`select alias from meta.app where alias = $1 or alias like $2`, [alias, `${alias}-%`])).rows.map((r) => r.alias),
  );
  let free = alias;
  for (let n = 2; taken.has(free); n++) free = `${alias}-${n}`;
  return free;
}

/** "Employee list 2026.xlsx" → "employee_list_2026" */
export const tableNameFor = (filename: string) => columnName(filename.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, ''), new Set(['id']));

async function uploaded(s: Session, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return owner.one<{ filename: string; content: Buffer; mime_type: string | null }>('select filename, content, mime_type from meta.temp_file where id = $1 and session_id = $2 and item_name = $3', [id, s.id, ITEM]);
}

export const check = (name: string, label: string, on: boolean, help = '') =>
  html`<div class="field"><label class="check"><input type="checkbox" name="${name}" value="true"${on ? raw(' checked') : ''}> ${label}</label>${help ? html`<small class="help">${help}</small>` : ''}</div>`;

/** The columns of the new table from the step 2 form (an empty name skips the file column). */
export function chosenColumns(sheet: Sheet, b: Body): NewColumn[] {
  return sheet.headers
    .map((_, index) => ({ index, name: String(b[`name_${index}`] ?? '').trim(), type: String(b[`type_${index}`] ?? 'text') as NewColumn['type'] }))
    .filter((x) => x.name);
}

interface CatalogColumn {
  column_name: string;
  kind: string;
  is_pk: boolean;
  distinct_values: number | null;
}

/** The column a dashboard counts the rows by: text, then yes/no, then a date, with a few values that repeat (from the statistics). */
export function groupColumn(catalog: CatalogColumn[], rows: number) {
  const rank = { text: 1, boolean: 2, date: 3 } as Record<string, number>;
  return catalog
    .filter((x) => !x.is_pk && rank[x.kind] && x.distinct_values !== null && x.distinct_values >= 2 && x.distinct_values <= 50 && x.distinct_values < rows)
    .sort((a, b) => rank[a.kind] - rank[b.kind])[0]?.column_name ?? null;
}

interface Built {
  app: { id: number; alias: string; existingAccount: boolean };
  table: string;
  result: LoadResult;
  pages: { page: number; label: string }[];
  notes: string[];
}

/** Create the application, the table, the rows and the pages, in one transaction (nothing is left behind when a step fails). */
export async function buildAppFromFile(checked: CheckedApp, sheet: Sheet, b: Body): Promise<Built> {
  const tableName = String(b.table ?? '').trim();
  const cols = chosenColumns(sheet, b);
  if (!cols.length) throw new LoadError(tx('aff.give_at_least_one_column'));
  // the table goes into the app's schema; createTableSql checks the names and the types
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(tableName)) throw new LoadError(tx('aff.table_name_a_lower_case'));
  const table = `${checked.schema}.${tableName}`;
  const ddl = createTableSql(table, cols);
  const headers = b.h !== '0';
  return owner.tx(async (c) => {
    const app = await createApp(c, checked).catch((e) => {
      throw new LoadError(createAppError(e, checked.alias));
    });
    await c.query(ddl).catch((e) => {
      throw new LoadError((e as { code?: string }).code === '42P07' ? tx('aff.table_exists', { table }) : (e as Error).message);
    });
    // explicit grants too: an existing schema may have other default privileges
    const T = (await c.query('select $1::regclass::text as t', [table])).rows[0].t as string;
    const R = pg.escapeIdentifier(checked.role);
    await c.query(`grant select, insert, update, delete on ${T} to ${R}`);
    await c.query(`grant usage, select on all sequences in schema ${pg.escapeIdentifier(checked.schema)} to ${R}`);
    const result = await loadRows(c, sheet, {
      table,
      mode: 'append',
      columns: cols.map((x) => ({ index: x.index, column: x.name })),
      skipErrors: b.skip_errors === 'true',
      firstRow: headers && (sheet.format === 'csv' || sheet.format === 'xlsx') ? 2 : 1,
    });
    // statistics, so the faceted search proposes columns with few values
    await c.query(`analyze ${T}`);

    const pages: Built['pages'] = [];
    const notes: string[] = [];
    const generate = async (kind: string, page: number, options: Record<string, unknown>) => {
      await c.query('select meta.generate_page($1, $2, $3::regclass, $4, $5::jsonb)', [checked.alias, kind, T, page, JSON.stringify(options)]);
    };
    const { label, singular } = (await c.query('select meta.wizard_table_label($1::regclass) as label, meta.wizard_table_label($1::regclass, false) as singular', [T])).rows[0] as { label: string; singular: string };
    await generate('report_form', 2, { form_page: 3 });
    pages.push({ page: 2, label }, { page: 3, label: `${singular} form` });
    let next = 4;
    // the statistics tell which columns group the rows: a few values, repeated (not a name per row)
    const rows = result.inserted;
    const catalog = (await c.query<CatalogColumn>('select column_name, kind, is_pk, distinct_values from meta.wizard_catalog($1::regclass)', [T])).rows;
    const repeated = (col: CatalogColumn) => col.distinct_values !== null && col.distinct_values >= 2 && col.distinct_values <= 50 && col.distinct_values < rows;
    if (b.chart === 'true') {
      const group = groupColumn(catalog, rows);
      if (!group) notes.push(tx('aff.no_dashboard'));
      else {
        await generate('chart', next, { label: 'Dashboard', icon: 'chart', nav: true, label_column: group, function: 'count', value_column: null });
        pages.push({ page: next++, label: `Dashboard (rows per ${group})` });
      }
    }
    if (b.facets === 'true') {
      const d = (await c.query('select meta.wizard_defaults($1, $2::regclass) as d', ['facets', T])).rows[0].d;
      // ranges for numbers and dates; text only when its values repeat
      const facets = ((d.facets ?? []) as string[]).filter((f) => {
        const col = catalog.find((x) => x.column_name === f);
        return col && (col.kind !== 'text' || repeated(col));
      });
      if (!facets.length) notes.push(tx('aff.no_facets'));
      else {
        await generate('facets', next, { label: `Search ${label.toLowerCase()}`, icon: 'filter', nav: true, facets });
        pages.push({ page: next++, label: `Faceted search (${facets.join(', ')})` });
      }
    }
    await finishGeneratedApp(c, app.id, { description: checked.description });
    return { app: { id: app.id, alias: checked.alias, existingAccount: app.existingAccount }, table: T, result, pages, notes };
  });
}

export interface Created {
  app: { id: number; alias: string; existingAccount: boolean };
  tables?: { table: string; result: LoadResult }[];
  foreignKeys?: string[];
  pages: { page: number; label: string }[];
  notes: string[];
}

/** The result page of the create application wizards: the tables and rows, skipped rows, foreign keys and pages. */
export function createdHtml(built: Created | Built, adminUser: string, another: string) {
  const tables = 'table' in built ? [{ table: built.table, result: built.result }] : (built.tables ?? []);
  const errors = tables.flatMap((t) => t.result.errors.map((e) => ({ ...e, table: t.table })));
  const loaded = tables.map((t) => (t.result.failed ? tx('aff.loaded_skipped', { table: t.table, n: t.result.inserted, skipped: t.result.failed }) : tx('aff.loaded', { table: t.table, n: t.result.inserted }))).join(' ');
  return html`<h1>${tx('aff.application_created')}</h1>
      <div class="alert alert-success" role="status">${tx('aff.created', { alias: built.app.alias })} ${loaded}${
        built.app.existingAccount ? ` ${tx('aff.existing_account', { user: adminUser })}` : ''}</div>
      ${errors.length
        ? region(tx('aff.skipped_rows'), html`<div class="table-wrap"><table class="report"><thead><tr>${tables.length > 1 ? html`<th>${tx('aff.table')}</th>` : ''}<th class="num">${tx('aff.row')}</th><th>${tx('aff.error')}</th></tr></thead>
            <tbody>${errors.map((e) => html`<tr>${tables.length > 1 ? html`<td>${e.table}</td>` : ''}<td class="num">${e.row}</td><td>${e.message}</td></tr>`)}</tbody></table></div>
            ${tables.some((t) => t.result.failed > t.result.errors.length) ? html`<p class="muted">${tx('aff.the_first_errors_are_shown')}</p>` : ''}`)
        : ''}
      ${'foreignKeys' in built && built.foreignKeys?.length ? region(tx('aff.foreign_keys'), html`<ul>${built.foreignKeys.map((x) => html`<li>${x}</li>`)}</ul>`) : ''}
      ${region(tx('aff.pages'), html`<ul>${built.pages.map((p) => html`<li>${tx('aff.page_item', { n: p.page, label: p.label })}</li>`)}</ul>
        ${built.notes.map((n) => html`<p class="muted">${n}</p>`)}`)}
      <div class="buttons u-mt1">
        <a class="btn btn-hot" href="${BASE}/apps/${built.app.id}">${icon('edit')} ${tx('aff.edit_the_application')}</a>
        <a class="btn btn-run" href="/a/${built.app.alias}" target="_blank" rel="noopener">${icon('play')} ${tx('aff.run')}</a>
        <a class="btn" href="${another}">${icon('plus')} ${tx('aff.create_another')}</a>
      </div>`;
}

export async function appFromFileRoutes(app: FastifyInstance) {
  const page = (s: Session, reply: FastifyReply, main: Raw) =>
    send(reply, s, shell(s, tx('aff.create_application_from_a_file'), [[tx('aff.app_builder'), BASE], [tx('aff.create'), `${BASE}/create`], [tx('aff.from_a_file')]], html`<div class="ab-narrow">${main}</div>`));

  const uploadForm = (s: Session, error?: string) =>
    html`<h1>${tx('aff.create_an_application_from_a')}</h1>
      <p class="muted">${tx.rich('aff.intro', { sheets: MAX_SHEETS, mb: MAX_MB, paste: html`<a href="${BASE}/create/paste">${tx('aff.paste_data')}</a>`, tables: html`<a href="${BASE}/create/tables">${tx('aff.start_from_existing_tables')}</a>` })}</p>
      ${region(tx('aff.file'), html`${error ? html`<div class="alert alert-error" role="alert">${error}</div>` : ''}
        <form method="post" action="${BASE}/create/file" enctype="multipart/form-data">${csrf(s)}
          <div class="form-grid">
            <div class="field"><label class="label" for="f_file">${tx('aff.file')}</label>
              <input type="file" id="f_file" name="file" accept=".csv,.tsv,.txt,.xlsx,.json,.jsonl,.xml,text/csv,application/json,application/xml,text/xml" required></div>
            <div class="field"><span class="label" aria-hidden="true"></span>
              <label class="check"><input type="checkbox" name="headers" value="true" checked> ${tx('aff.first_row_contains_column_names')}</label></div>
          </div>
          <div class="buttons"><a class="btn" href="${BASE}/create">${tx('aff.cancel')}</a><button class="btn btn-hot">${icon('upload')} ${tx('aff.next')}</button></div>
        </form>`)}`;

  // step 1: the file
  app.get(`${BASE}/create/file`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    return page(s, reply, uploadForm(s));
  });

  app.post(`${BASE}/create/file`, async (req: Req, reply) => {
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
    if (file.truncated) return fail(tx('aff.too_large', { mb: MAX_MB }));
    const headers = req.body?.headers === 'true';
    try {
      const sheets = await parseBook(file.filename, file.data, { headers });
      if (!sheets.some((x) => x.rows.length)) throw new LoadError(tx('aff.the_file_has_column_names'));
    } catch (e) {
      if (e instanceof LoadError) return fail(e.message);
      throw e;
    }
    const r = await owner.one(
      `insert into meta.temp_file (session_id, item_name, filename, mime_type, size, content) values ($1, $2, $3, $4, $5, $6) returning id`,
      [s.id, ITEM, file.filename.replace(/^.*[\\/]/, '').slice(0, 200), file.mimetype, file.data.length, file.data],
    );
    return reply.redirect(`${BASE}/create/file/${r!.id}?h=${headers ? '1' : '0'}`, 303);
  });

  // step 2: preview, the application, the table and the pages
  const settings = async (req: Req, reply: FastifyReply, s: Session, b: Body | null, message: Raw | '' = '') => {
    const f = await uploaded(s, req.params.id);
    if (!f) return reply.redirect(`${BASE}/create/file`);
    const headers = (b?.h ?? req.query.h) !== '0';
    let sheets: NamedSheet[];
    try {
      sheets = await parseBook(f.filename, f.content, { headers });
    } catch (e) {
      if (e instanceof LoadError) return page(s, reply, uploadForm(s, e.message));
      throw e;
    }
    const sheet = sheets[0];
    const again = f.mime_type === PASTED ? html`<a href="${BASE}/create/paste">${tx('aff.paste_other_data')}</a>` : html`<a href="${BASE}/create/file">${tx('aff.choose_another_file')}</a>`;
    const schemas = (await owner.query(`select nspname from pg_namespace where nspname !~ '^pg_' and nspname not in ('information_schema', 'meta') order by 1`)).rows;
    const v = (k: string, d: string) => (b ? (b[k] ?? '') : d);
    const appRegion = region(tx('aff.application'), html`<div class="form-grid">
          ${input('name', tx('aff.name'), v('name', appNameFor(f.filename)), { required: true })}
          ${input('alias', tx('aff.alias_url'), v('alias', await aliasFor(f.filename)), { required: true, help: tx('aff.lowercase_e_g_inventory_a') })}
          ${select('schema', tx('aff.parsing_schema'), v('schema', ''), [['', tx('aff.new_schema_named_after_the')], ...schemas.map((r): [string, string] => [r.nspname, r.nspname])],
            sheets.length > 1 ? tx('aff.schema_help_n') : tx('aff.schema_help_1'))}
          ${select('authentication', tx('aff.authentication'), v('authentication', 'app_users'), [['app_users', tx('aff.app_users_login_page')], ['none', tx('aff.none_public')]])}
          ${input('admin_user', tx('aff.first_user'), v('admin_user', ''), { placeholder: tx('aff.e_g_your_name'), help: tx('aff.gets_the_admin_role_an') })}
          ${input('admin_password', tx('aff.password'), '', { type: 'password', auto: 'new-password', help: tx('aff.for_a_new_account_at') })}
        </div>`);
    if (sheets.length > 1) {
      return page(s, reply, html`<h1>${tx('aff.create_an_application_from_a')}</h1>
        ${message}
        <p class="muted">${tx(sheet.format === 'json' ? 'aff.arrays_info' : 'aff.sheets_info', { file: f.filename, n: sheets.length, list: sheets.map((x) => tx('aff.sheet_rows', { name: x.name, n: x.rows.length })).join(', ') })} ${again}</p>
        <form method="post" action="${BASE}/create/file/${req.params.id}">${csrf(s)}<input type="hidden" name="h" value="${headers ? '1' : '0'}">
        ${appRegion}
        <div class="u-spacer"></div>
        ${sheetsForm(sheets, b)}
        <div class="u-spacer"></div>
        ${region(tx('aff.pages'), html`<p class="muted u-mt0">${tx('aff.page_1_is_the_home')}</p>
          ${check('chart', tx('aff.dashboard_a_chart_per_table'), b ? b.chart === 'true' : true)}
          ${check('skip_errors', tx('aff.skip_rows_with_errors_otherwise'), v('skip_errors', '') === 'true')}`)}
        <div class="buttons"><a class="btn" href="${BASE}/create">${tx('aff.cancel')}</a><button class="btn btn-hot" name="action" value="create">${tx('aff.create_application')}</button></div>
        </form>`);
    }
    const suggested = suggestColumns(sheet);
    const info = `${tx('aff.info', { file: f.filename, rows: sheet.rows.length, cols: sheet.headers.length })}${
      sheet.format === 'xlsx' ? ', Excel' : sheet.format === 'json' ? ', JSON' : sheet.format === 'xml' ? tx('aff.xml_rows', { path: `<${sheet.rowPath}>` }) : tx('aff.delimiter', { d: sheet.delimiter === '\t' ? tx('aff.tab') : `“${sheet.delimiter}”` })
    }`;
    const sample = (i: number) =>
      sheet.rows
        .map((r) => r[i])
        .filter((x): x is string => x !== null)
        .slice(0, SAMPLE)
        .map((x) => (x.length > 30 ? `${x.slice(0, 30)}…` : x))
        .join(' · ');
    const main = html`<h1>${tx('aff.create_an_application_from_a')}</h1>
      ${message}
      ${region(tx('aff.preview'), html`<p class="muted">${info}${sheet.rows.length > 10 ? ` ${tx('aff.first_10')}` : ''}. ${again}</p>${preview(sheet)}`)}
      <div class="u-spacer"></div>
      <form method="post" action="${BASE}/create/file/${req.params.id}">${csrf(s)}<input type="hidden" name="h" value="${headers ? '1' : '0'}">
      ${appRegion}
      <div class="u-spacer"></div>
      ${region(tx('aff.table'), html`<div class="form-grid">
          ${input('table', tx('aff.table_name'), v('table', tableNameFor(f.filename)), { required: true, help: tx('aff.in_the_application_s_schema') })}
        </div>
        <div class="table-wrap"><table class="report ff-cols"><thead><tr><th scope="col">${tx('aff.file_column')}</th><th scope="col">${tx('aff.values')}</th><th scope="col">${tx('aff.col_name_head')}</th><th scope="col">${tx('aff.type')}</th></tr></thead><tbody>
          ${suggested.map((c) => {
            const type = v(`type_${c.index}`, c.type);
            return html`<tr><td>${sheet.headers[c.index]}</td><td class="muted small ff-sample">${sample(c.index)}</td>
              <td><input name="name_${c.index}" value="${v(`name_${c.index}`, c.name)}" aria-label="${tx('aff.col_name_for', { col: sheet.headers[c.index] })}"></td>
              <td><select name="type_${c.index}" aria-label="${tx('aff.type_of', { col: sheet.headers[c.index] })}">${COLUMN_TYPES.map((t) => html`<option value="${t}"${t === type ? raw(' selected') : ''}>${t}</option>`)}</select></td></tr>`;
          })}
        </tbody></table></div>
        ${check('skip_errors', tx('aff.skip_rows_with_errors_otherwise'), v('skip_errors', '') === 'true')}`)}
      <div class="u-spacer"></div>
      ${region(tx('aff.pages'), html`<p class="muted u-mt0">${tx('aff.page_1_is_the_home_2')}</p>
        ${check('chart', tx('aff.dashboard_a_chart_with_the'), b ? b.chart === 'true' : true)}
        ${check('facets', tx('aff.faceted_search_a_report_with'), b ? b.facets === 'true' : true)}`)}
      <div class="buttons"><a class="btn" href="${BASE}/create">${tx('aff.cancel')}</a><button class="btn btn-hot">${tx('aff.create_application')}</button></div>
      </form>`;
    return page(s, reply, main);
  };

  app.get(`${BASE}/create/file/:id`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    return settings(req, reply, s, null);
  });

  // step 3: create everything
  app.post(`${BASE}/create/file/:id`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const f = await uploaded(s, req.params.id);
    if (!f) return reply.redirect(`${BASE}/create/file`, 303);
    const b = req.body ?? {};
    const failed = (message: Raw) => {
      reply.code(422);
      return settings(req, reply, s, b, message);
    };
    if (b.action === 'preview') return settings(req, reply, s, b);
    let built: Built | BuiltBook;
    try {
      if (reservedSchema(String(b.schema ?? ''))) throw new LoadError(tx('aff.bad_schema', { schema: String(b.schema) }));
      const checked = await checkNewApp(b, currentWorkspace(s)).catch((e) => {
        throw new LoadError((e as Error).message);
      });
      const sheets = await parseBook(f.filename, f.content, { headers: b.h !== '0' });
      built = sheets.length > 1 ? await buildAppFromSheets(checked, sheets, b) : await buildAppFromFile(checked, sheets[0], b);
    } catch (e) {
      if (e instanceof LoadFailed) return failed(resultHtml(e.result, true));
      if (e instanceof LoadError || (e as { code?: string }).code) return failed(html`<div class="alert alert-error" role="alert">${(e as Error).message}</div>`);
      throw e;
    }
    await owner.query('delete from meta.temp_file where id = $1', [req.params.id]);
    const main = createdHtml(built, String(b.admin_user ?? '').trim(), f.mime_type === PASTED ? `${BASE}/create/paste` : `${BASE}/create/file`);
    return page(s, reply, main);
  });

  await appWizardRoutes(app);
}
