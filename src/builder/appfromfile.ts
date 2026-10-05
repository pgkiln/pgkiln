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
import { checkNewApp, createApp, createAppError, reservedSchema, type CheckedApp } from './newapp.ts';
import { BASE, csrf, developer, input, region, select, send, shell, type Body, type Req } from './ui.ts';

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

const ITEM = 'APP_FROM_FILE';
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
  return owner.one<{ filename: string; content: Buffer }>('select filename, content from meta.temp_file where id = $1 and session_id = $2 and item_name = $3', [id, s.id, ITEM]);
}

const check = (name: string, label: string, on: boolean, help = '') =>
  html`<div class="field"><label class="check"><input type="checkbox" name="${name}" value="true"${on ? raw(' checked') : ''}> ${label}</label>${help ? html`<small class="help">${help}</small>` : ''}</div>`;

/** The columns of the new table from the step 2 form (an empty name skips the file column). */
export function chosenColumns(sheet: Sheet, b: Body): NewColumn[] {
  return sheet.headers
    .map((_, index) => ({ index, name: String(b[`name_${index}`] ?? '').trim(), type: String(b[`type_${index}`] ?? 'text') as NewColumn['type'] }))
    .filter((x) => x.name);
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
  if (!cols.length) throw new LoadError('Give at least one column a name.');
  // the table goes into the app's schema; createTableSql checks the names and the types
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(tableName)) throw new LoadError('Table name: a lower-case name (letters, digits and _) without a schema; the table goes into the application\'s schema.');
  const table = `${checked.schema}.${tableName}`;
  const ddl = createTableSql(table, cols);
  const headers = b.h !== '0';
  return owner.tx(async (c) => {
    const app = await createApp(c, checked).catch((e) => {
      throw new LoadError(createAppError(e, checked.alias));
    });
    await c.query(ddl).catch((e) => {
      throw new LoadError((e as { code?: string }).code === '42P07' ? `The table ${table} already exists: choose another name.` : (e as Error).message);
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
    const label = (await c.query(`select meta.wizard_label($1) as l`, [tableName])).rows[0].l as string;
    await generate('report_form', 2, { form_page: 3, label });
    pages.push({ page: 2, label }, { page: 3, label: `${label} form` });
    let next = 4;
    if (b.chart === 'true') {
      const d = (await c.query('select meta.wizard_defaults($1, $2::regclass) as d', ['chart', T])).rows[0].d;
      if (!d.label_column || d.label_column === 'id') notes.push('No dashboard: the table has no column to group the rows by (text, yes/no or date).');
      else {
        await generate('chart', next, { label: 'Dashboard', icon: 'chart', nav: true });
        pages.push({ page: next++, label: `Dashboard (rows per ${d.label_column})` });
      }
    }
    if (b.facets === 'true') {
      const d = (await c.query('select meta.wizard_defaults($1, $2::regclass) as d', ['facets', T])).rows[0].d;
      if (!d.facets?.length) notes.push('No faceted search: no column suits a filter.');
      else {
        await generate('facets', next, { label: `Search ${label.toLowerCase()}`, icon: 'filter', nav: true });
        pages.push({ page: next++, label: `Faceted search (${d.facets.join(', ')})` });
      }
    }
    return { app: { id: app.id, alias: checked.alias, existingAccount: app.existingAccount }, table: T, result, pages, notes };
  });
}

export async function appFromFileRoutes(app: FastifyInstance) {
  const page = (s: Session, reply: FastifyReply, main: Raw) =>
    send(reply, s, shell(s, 'Create application from a file', [['App Builder', BASE], ['Create', `${BASE}/create`], ['From a file']], html`<div class="ab-narrow">${main}</div>`));

  const uploadForm = (s: Session, error?: string) =>
    html`<h1>Create an application from a file</h1>
      <p class="muted">Upload a spreadsheet: CSV or TSV (UTF-8 or Windows-1252; the delimiter is detected), Excel .xlsx (the first sheet), JSON (an array of objects) or XML, up to ${MAX_MB} MB.
        Next you check the proposed table and its columns. The application gets its own schema and database role, a table with the rows, a report and form, and optionally a dashboard and a faceted search.</p>
      ${region('File', html`${error ? html`<div class="alert alert-error" role="alert">${error}</div>` : ''}
        <form method="post" action="${BASE}/create/file" enctype="multipart/form-data">${csrf(s)}
          <div class="form-grid">
            <div class="field"><label class="label" for="f_file">File</label>
              <input type="file" id="f_file" name="file" accept=".csv,.tsv,.txt,.xlsx,.json,.jsonl,.xml,text/csv,application/json,application/xml,text/xml" required></div>
            <div class="field"><span class="label" aria-hidden="true"></span>
              <label class="check"><input type="checkbox" name="headers" value="true" checked> First row contains column names</label></div>
          </div>
          <div class="buttons"><a class="btn" href="${BASE}/create">Cancel</a><button class="btn btn-hot">${icon('upload')} Next</button></div>
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
    if (!file) return fail('Choose a file.');
    if (file.truncated) return fail(`The file is larger than ${MAX_MB} MB.`);
    const headers = req.body?.headers === 'true';
    try {
      const sheet = await parseFile(file.filename, file.data, { headers });
      if (!sheet.rows.length) throw new LoadError('The file has column names but no rows.');
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
    let sheet: Sheet;
    try {
      sheet = await parseFile(f.filename, f.content, { headers });
    } catch (e) {
      if (e instanceof LoadError) return page(s, reply, uploadForm(s, e.message));
      throw e;
    }
    const schemas = (await owner.query(`select nspname from pg_namespace where nspname !~ '^pg_' and nspname not in ('information_schema', 'meta') order by 1`)).rows;
    const suggested = suggestColumns(sheet);
    const v = (k: string, d: string) => (b ? (b[k] ?? '') : d);
    const info = `${f.filename}: ${sheet.rows.length} row(s), ${sheet.headers.length} column(s)${
      sheet.format === 'xlsx' ? ', Excel' : sheet.format === 'json' ? ', JSON' : sheet.format === 'xml' ? `, XML rows <${sheet.rowPath}>` : `, delimiter ${sheet.delimiter === '\t' ? 'tab' : `“${sheet.delimiter}”`}`
    }`;
    const sample = (i: number) =>
      sheet.rows
        .map((r) => r[i])
        .filter((x): x is string => x !== null)
        .slice(0, SAMPLE)
        .map((x) => (x.length > 30 ? `${x.slice(0, 30)}…` : x))
        .join(' · ');
    const main = html`<h1>Create an application from a file</h1>
      ${message}
      ${region('Preview', html`<p class="muted">${info}${sheet.rows.length > 10 ? ' (first 10 shown)' : ''}. <a href="${BASE}/create/file">Choose another file</a></p>${preview(sheet)}`)}
      <div class="u-spacer"></div>
      <form method="post" action="${BASE}/create/file/${req.params.id}">${csrf(s)}<input type="hidden" name="h" value="${headers ? '1' : '0'}">
      ${region('Application', html`<div class="form-grid">
          ${input('name', 'Name', v('name', appNameFor(f.filename)), { required: true })}
          ${input('alias', 'Alias (URL)', v('alias', await aliasFor(f.filename)), { required: true, help: 'lowercase, e.g. inventory → /a/inventory' })}
          ${select('schema', 'Parsing schema', v('schema', ''), [['', '- new schema named after the alias -'], ...schemas.map((r): [string, string] => [r.nspname, r.nspname])],
            'A database role app_<alias> is created with access to this schema only; the app runs as that role. The table is created in this schema.')}
          ${select('authentication', 'Authentication', v('authentication', 'app_users'), [['app_users', 'App users (login page)'], ['none', 'None (public)']])}
          ${input('admin_user', 'First user', v('admin_user', ''), { placeholder: 'e.g. your name', help: 'Gets the admin role. An existing account in Users is reused.' })}
          ${input('admin_password', 'Password', '', { type: 'password', auto: 'new-password', help: 'For a new account; at least 8 characters.' })}
        </div>`)}
      <div class="u-spacer"></div>
      ${region('Table', html`<div class="form-grid">
          ${input('table', 'Table name', v('table', tableNameFor(f.filename)), { required: true, help: 'In the application\'s schema; the table gets an identity primary key id.' })}
        </div>
        <div class="table-wrap"><table class="report"><thead><tr><th scope="col">File column</th><th scope="col">Values</th><th scope="col">Column name (empty = skip)</th><th scope="col">Type</th></tr></thead><tbody>
          ${suggested.map((c) => {
            const type = v(`type_${c.index}`, c.type);
            return html`<tr><td>${sheet.headers[c.index]}</td><td class="muted small">${sample(c.index)}</td>
              <td><input name="name_${c.index}" value="${v(`name_${c.index}`, c.name)}" aria-label="Column name for ${sheet.headers[c.index]}"></td>
              <td><select name="type_${c.index}" aria-label="Type of ${sheet.headers[c.index]}">${COLUMN_TYPES.map((t) => html`<option value="${t}"${t === type ? raw(' selected') : ''}>${t}</option>`)}</select></td></tr>`;
          })}
        </tbody></table></div>
        ${check('skip_errors', 'Skip rows with errors (otherwise nothing is created when a row fails)', v('skip_errors', '') === 'true')}`)}
      <div class="u-spacer"></div>
      ${region('Pages', html`<p class="muted u-mt0">Page 1 is the Home page; page 2 an interactive report of the table with a modal form (page 3) to create, change and delete rows. Each page gets a navigation entry. More pages can be added later with the page wizards.</p>
        ${check('chart', 'Dashboard: a chart with the number of rows per value of a text, yes/no or date column', b ? b.chart === 'true' : true)}
        ${check('facets', 'Faceted search: a report with a filter panel (values with counts, ranges and a search field)', b ? b.facets === 'true' : true)}`)}
      <div class="buttons"><a class="btn" href="${BASE}/create">Cancel</a><button class="btn btn-hot">Create application</button></div>
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
    let built: Built;
    try {
      if (reservedSchema(String(b.schema ?? ''))) throw new LoadError(`The schema ${b.schema} can't be the parsing schema of an application.`);
      const checked = await checkNewApp(b).catch((e) => {
        throw new LoadError((e as Error).message);
      });
      const sheet = await parseFile(f.filename, f.content, { headers: b.h !== '0' });
      built = await buildAppFromFile(checked, sheet, b);
    } catch (e) {
      if (e instanceof LoadFailed) return failed(resultHtml(e.result, true));
      if (e instanceof LoadError || (e as { code?: string }).code) return failed(html`<div class="alert alert-error" role="alert">${(e as Error).message}</div>`);
      throw e;
    }
    await owner.query('delete from meta.temp_file where id = $1', [req.params.id]);
    const r = built.result;
    const main = html`<h1>Application created</h1>
      <div class="alert alert-success" role="status">Application ${built.app.alias} created. ${built.table}: ${r.inserted} row(s) loaded${r.failed ? `, ${r.failed} skipped` : ''}.${
        built.app.existingAccount ? ` The existing account ${String(b.admin_user ?? '').trim()} got the admin role (its password was not changed).` : ''}</div>
      ${r.errors.length
        ? region('Skipped rows', html`<div class="table-wrap"><table class="report"><thead><tr><th class="num">Row</th><th>Error</th></tr></thead>
            <tbody>${r.errors.map((e) => html`<tr><td class="num">${e.row}</td><td>${e.message}</td></tr>`)}</tbody></table></div>
            ${r.failed > r.errors.length ? html`<p class="muted">The first ${r.errors.length} errors are shown.</p>` : ''}`)
        : ''}
      ${region('Pages', html`<ul>${built.pages.map((p) => html`<li>Page ${p.page}: ${p.label}</li>`)}</ul>
        ${built.notes.map((n) => html`<p class="muted">${n}</p>`)}`)}
      <div class="buttons u-mt1">
        <a class="btn btn-hot" href="${BASE}/apps/${built.app.id}">${icon('edit')} Edit the application</a>
        <a class="btn btn-run" href="/a/${built.app.alias}" target="_blank" rel="noopener">${icon('play')} Run</a>
        <a class="btn" href="${BASE}/create/file">${icon('upload')} Create another</a>
      </div>`;
    return page(s, reply, main);
  });
}
