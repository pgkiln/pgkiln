import type { FastifyInstance, FastifyReply } from 'fastify';
import pg from 'pg';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { LoadError } from '../dataload.ts';
import type { Session } from '../session.ts';
import { aliasFor, check, ITEM, type Created } from './appfromfile.ts';
import { addDashboard, parseBook } from './appsheets.ts';
import { finishGeneratedApp, checkNewApp, createApp, createAppError, featuresFrom, FEATURES, reservedSchema, startFromBoilerplate, DEFAULT_APP_ICON, type CheckedApp, type Features } from './newapp.ts';
import { currentWorkspace } from './workspaces.ts';
import { back, BASE, csrf, developer, flash, input, region, select, send, shell, type Body, type Req } from './ui.ts';
import { iconPicker } from './forms.ts';
import { inWorkspaceSql } from './workspaces.ts';
import { BASE_STYLES } from '../runtime/styles.ts';
import { LANGUAGE_NAMES } from '../i18n.ts';
import { secretKeyConfigured } from '../secrets.ts';
import { appPublicKey } from '../push.ts';

// Two more ways into the create application wizard:
// - From pasted data (APEX: Create App from a File → Copy and Paste): CSV or
//   TSV text in a textarea (the delimiter is detected as for files). The text
//   is kept as a temporary file of the builder session (mime type PASTED)
//   and takes the steps of "From a file" (appfromfile.ts).
// - From existing tables (APEX: Create Application with pages on existing
//   tables): pick the tables and views of a schema; the new application gets
//   that schema as its parsing schema (and its role the grants of newapp.ts),
//   a report and form per table (meta.generate_page, migration 047; a report
//   only for views and tables without a single-column primary key), navigation
//   and an optional dashboard. All in one owner transaction.

/** The mime type of a temporary file holding pasted data. */
export const PASTED = 'text/x-pgkiln-pasted';
const MAX_TABLES = 40;
const MAX_PASTE = 4 * 1024 * 1024;

/** "Sales 2026!" → "Sales 2026.csv" (a file name for the pasted data, which names the app and table) */
export const pastedName = (title: string) =>
  `${(title.normalize('NFC').replace(/[^\p{L}\p{N} _-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Pasted data')}.csv`;

interface Relation {
  relname: string;
  kind: 'table' | 'view';
  pk: string | null;
  /** the planner's estimate (null: never analyzed) */
  rows: string | null;
  /** (sprint 73) a date or timestamp column for a calendar */
  calendar: boolean;
  /** (sprint 73) a table with a foreign key to this one, for master-detail */
  detail: boolean;
}

/** The tables, partitioned tables, views and materialized views of a schema (not partitions). */
export async function schemaRelations(schema: string): Promise<Relation[]> {
  return (
    await owner.query<Relation>(
      `select c.relname, case when c.relkind in ('v', 'm') then 'view' else 'table' end as kind,
              meta.wizard_pk(c.oid) as pk, case when c.reltuples >= 0 then c.reltuples::bigint end as rows,
              meta.wizard_defaults('calendar', c.oid) ->> 'start' is not null as calendar,
              meta.wizard_pk(c.oid) is not null and meta.wizard_defaults('master_detail', c.oid) ->> 'detail' is not null as detail
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1 and c.relkind in ('r', 'p', 'v', 'm') and not c.relispartition
        order by c.relkind in ('v', 'm'), c.relname`,
      [schema],
    )
  ).rows;
}

/** The schemas an application can be built on: not pgkiln's or the system's. */
const appSchemas = async () =>
  (await owner.query<{ nspname: string }>(`select nspname from pg_namespace where nspname !~ '^pg_' and nspname not in ('information_schema', 'meta') order by 1`)).rows.map(
    (r) => r.nspname,
  );

/** (sprint 73) The page types of the Create Application wizard (APEX: Add Page), per table. */
export const PAGE_KINDS: Record<string, string> = {
  report_form: 'Interactive report with form',
  facets: 'Faceted search',
  cards: 'Cards',
  calendar: 'Calendar',
  master_detail: 'Master detail',
  grid: 'Interactive grid',
  report: 'Report',
  '': 'No page',
};
/** More rows than this: an interactive grid (paged) instead of a report and form by default. */
export const LARGE_TABLE = 100_000;

/** The page types a table or view can have. */
export function kindsFor(r: Relation): string[] {
  const keyed = r.kind === 'table' && !!r.pk;
  return Object.keys(PAGE_KINDS).filter((k) =>
    k === 'report_form' || k === 'grid' ? keyed : k === 'master_detail' ? keyed && r.detail : k === 'calendar' ? r.calendar : true,
  );
}
/** The proposed page type: a report and form; a grid for a large table; a report for a view or a table without a single-column key. */
export const defaultKind = (r: Relation) => (r.kind === 'table' && r.pk ? (Number(r.rows ?? 0) > LARGE_TABLE ? 'grid' : 'report_form') : 'report');

export interface Plan {
  rel: Relation;
  kind: string;
}

/** Create the application on existing tables and views (each with its page type) and the features, in one transaction. */
export async function buildAppFromTables(checked: CheckedApp, plans: Plan[], chart: boolean, features: Partial<Features> = {}): Promise<Created> {
  plans = plans.filter((p) => p.kind);
  if (plans.length > MAX_TABLES) throw new LoadError(`Choose at most ${MAX_TABLES} tables and views.`);
  for (const p of plans) if (!kindsFor(p.rel).includes(p.kind)) throw new LoadError(`${p.rel.relname} can't have the page type ${PAGE_KINDS[p.kind] ?? p.kind}.`);
  return owner.tx(async (c) => {
    const app = await createApp(c, checked).catch((e) => {
      throw new LoadError(createAppError(e, checked.alias));
    });
    const pages: Created['pages'] = [];
    const notes: string[] = [];
    const tables: string[] = [];
    let next = 2;
    const generate = (kind: string, T: string, page: number, options: Record<string, unknown>) =>
      c.query('select meta.generate_page($1, $2, $3::regclass, $4, $5::jsonb)', [checked.alias, kind, T, page, JSON.stringify(options)]);
    for (const { rel: r, kind } of plans) {
      const T = `${pg.escapeIdentifier(checked.schema)}.${pg.escapeIdentifier(r.relname)}`;
      tables.push(T);
      // (097) Employees for the report and the menu, Employee for the form
      const { plural, singular } = (await c.query('select meta.wizard_table_label($1::regclass) as plural, meta.wizard_table_label($1::regclass, false) as singular', [T])).rows[0];
      const withForm = !!r.pk && r.kind === 'table';
      if (kind === 'report_form' || (withForm && ['facets', 'cards', 'calendar'].includes(kind))) {
        await generate(kind, T, next, { form_page: next + 1 });
        pages.push({ page: next, label: `${plural} (${PAGE_KINDS[kind].toLowerCase()})` }, { page: next + 1, label: `${singular} form` });
        next += 2;
      } else if (kind !== 'report') {
        await generate(kind, T, next, {});
        pages.push({ page: next, label: `${plural} (${PAGE_KINDS[kind].toLowerCase()})` });
        next += 1;
      } else {
        // a report of the rows (no form: a view, or no single-column primary key)
        const page = (await c.query(`select meta.wizard_new_page(a, $2, $3, a.home_page) as id from meta.app a where a.alias = $1`, [checked.alias, next, plural])).rows[0].id;
        await c.query(
          `insert into meta.region (page_id, seq, title, type, source, config)
           select $1, 10, $2, 'report', w ->> 'source',
                  jsonb_build_object('headings', w -> 'headings')
                  || case when jsonb_array_length(w -> 'hidden') > 0 then jsonb_build_object('hidden', w -> 'hidden') else '{}' end
                  || case when w -> 'formats' <> '{}' then jsonb_build_object('formats', w -> 'formats') else '{}' end
             from meta.wizard_report($3::regclass) w`,
          [page, plural, T],
        );
        await c.query(`select meta.wizard_nav(a, $2, 'table', $3) from meta.app a where a.alias = $1`, [checked.alias, plural, next]);
        pages.push({ page: next, label: `${plural} (report)` });
        next += 1;
      }
    }
    if (chart && tables.length) {
      const skipped: string[] = [];
      const dash = await addDashboard(c, checked.alias, tables, next, skipped);
      if (dash) pages.push(dash);
      else notes.push('No dashboard: no table has a foreign key, or a text, yes/no or date column whose statistics show a few values that repeat (ANALYZE the tables first).');
      if (skipped.length)
        notes.push(`Not on the dashboard: ${skipped.map((t) => t.replace(/^.*\./, '').replace(/"/g, '')).join(', ')} (row level security: the application's role may see none of the rows).`);
    }
    await finishGeneratedApp(c, app.id, { description: checked.description, features, notes });
    return { app: { id: app.id, alias: checked.alias, existingAccount: app.existingAccount }, pages, notes };
  });
}

export async function appWizardRoutes(app: FastifyInstance) {
  const page = (s: Session, reply: FastifyReply, title: string, crumb: string, main: Raw) =>
    send(reply, s, shell(s, title, [['App Builder', BASE], ['Create', `${BASE}/create`], [crumb]], html`<div class="ab-narrow">${main}</div>`));

  // ---------------------------------------------------------------- pasted data
  const pasteForm = (s: Session, b: Body = {}, error?: string) =>
    html`<h1>Create an application from pasted data</h1>
      <p class="muted">Paste rows copied from a spreadsheet, or CSV or TSV text: the delimiter (tab, comma, semicolon or |) is detected. Next you check the proposed table and its columns, as for a file.
        <a href="${BASE}/create/file">Upload a file</a> instead.</p>
      ${region('Data', html`${error ? html`<div class="alert alert-error" role="alert">${error}</div>` : ''}
        <form method="post" action="${BASE}/create/paste">${csrf(s)}
          <div class="form-grid">
            ${input('title', 'Name', b.title ?? 'Pasted data', { help: 'Names the application and the table (you can change both in the next step).' })}
            <div class="field" data-wide><label class="label" for="f_data">Data</label>
              <textarea id="f_data" name="data" class="code" rows="12" required spellcheck="false" placeholder="name,city,joined&#10;Ann,Utrecht,2026-01-05">${b.data ?? ''}</textarea></div>
            <div class="field"><label class="check"><input type="checkbox" name="headers" value="true"${b.headers === undefined || b.headers === 'true' ? raw(' checked') : ''}> First row contains column names</label></div>
          </div>
          <div class="buttons"><a class="btn" href="${BASE}/create">Cancel</a><button class="btn btn-hot">${icon('upload')} Next</button></div>
        </form>`)}`;

  app.get(`${BASE}/create/paste`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    return page(s, reply, 'Create application from pasted data', 'Pasted data', pasteForm(s));
  });

  app.post(`${BASE}/create/paste`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = req.body ?? {};
    const fail = (message: string) => {
      reply.code(422);
      return page(s, reply, 'Create application from pasted data', 'Pasted data', pasteForm(s, { ...b, headers: b.headers === 'true' ? 'true' : 'false' }, message));
    };
    const text = typeof b.data === 'string' ? b.data : '';
    if (!text.trim()) return fail('Paste the data.');
    const data = Buffer.from(text, 'utf8');
    if (data.length > MAX_PASTE) return fail(`At most ${MAX_PASTE / 1024 / 1024} MB of text can be pasted; upload a file instead.`);
    const filename = pastedName(String(b.title ?? ''));
    const headers = b.headers === 'true';
    try {
      // read as delimited text whatever it looks like
      const sheets = await parseBook(filename, data, { headers });
      if (sheets[0].format !== 'csv') throw new LoadError('Paste delimited text (CSV or TSV); upload JSON, XML or Excel files with From a file.');
      if (!sheets[0].rows.length) throw new LoadError('The data has column names but no rows.');
    } catch (e) {
      if (e instanceof LoadError) return fail(e.message);
      throw e;
    }
    const r = await owner.one(
      `insert into meta.temp_file (session_id, item_name, filename, mime_type, size, content) values ($1, $2, $3, $4, $5, $6) returning id`,
      [s.id, ITEM, filename, PASTED, data.length, data],
    );
    return reply.redirect(`${BASE}/create/file/${r!.id}?h=${headers ? '1' : '0'}`, 303);
  });

  // ---------------------------------------------------------------- the Create Application wizard
  // (sprint 73) One page like APEX's: name, icon and description; appearance; the pages (with a schema:
  // a page type per table and view); features; settings; a boilerplate under Advanced. Choosing a schema
  // reloads the page with its tables (a GET form of its own, so nothing typed is sent in a URL).
  app.get(`${BASE}/create`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const schema = typeof req.query.schema === 'string' ? req.query.schema : '';
    return createPage(s, reply, schema, null);
  });

  // the earlier address of "From existing tables"
  app.get(`${BASE}/create/tables`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const schema = typeof req.query.schema === 'string' ? req.query.schema : '';
    return createPage(s, reply, schema, null);
  });

  const create = async (req: Req, reply: FastifyReply, fromTables = false) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = req.body ?? {};
    const schema = String(b.schema ?? '');
    const failed = async (message: string) => {
      reply.code(422);
      return createPage(s, reply, schema, b, html`<div class="alert alert-error" role="alert">${message}</div>`);
    };
    let built: Created;
    let pushKey = false;
    try {
      if (schema && (reservedSchema(schema) || !(await appSchemas()).includes(schema))) throw new LoadError('Choose one of the schemas in the list.');
      const checked = await checkNewApp({ ...b, schema }, currentWorkspace(s)).catch((e) => {
        throw new LoadError((e as Error).message);
      });
      const features = featuresFrom(b, b.features === '1');
      const boilerplate = /^\d{1,9}$/.test(b.boilerplate ?? '') ? Number(b.boilerplate) : null;
      if (boilerplate && !(await boilerplates(s)).some((x) => x.id === boilerplate)) throw new LoadError('Choose a boilerplate application (an application of type Boilerplate).');
      // the tables of the form: only names of this schema's tables and views count (looked up again, never used as SQL)
      const relations = schema ? await schemaRelations(schema) : [];
      const plans: Plan[] = [];
      for (const [k, v] of Object.entries(b)) {
        const m = /^t_(\d+)$/.exec(k);
        const rel = m && relations.find((r) => r.relname === String(v));
        if (!rel) continue;
        // a page type per table; a ticked table of the earlier form gets the proposed one
        const kind = b[`k_${m![1]}`] === undefined ? defaultKind(rel) : String(b[`k_${m![1]}`]);
        if (kind) plans.push({ rel, kind });
      }
      const askedTables = fromTables || b.tables === '1' || Object.keys(b).some((k) => /^t_\d+$/.test(k));
      if (askedTables && !plans.length) throw new LoadError('Choose at least one table or view.');
      if (plans.length && boilerplate) throw new LoadError('A boilerplate application brings its own pages: choose no tables, or no boilerplate.');
      if (plans.length) built = await buildAppFromTables(checked, plans, b.chart === 'true', features);
      else {
        built = await owner.tx(async (c) => {
          const made = await createApp(c, checked).catch((e) => {
            throw new LoadError(createAppError(e, checked.alias));
          });
          const notes: string[] = [];
          if (boilerplate) await startFromBoilerplate(c, made.id, checked, boilerplate);
          else await finishGeneratedApp(c, made.id, { description: checked.description, features, notes });
          return { app: { id: made.id, alias: checked.alias, existingAccount: made.existingAccount }, pages: [], notes };
        });
      }
      pushKey = features.push;
    } catch (e) {
      if (e instanceof LoadError || (e as { code?: string }).code) return failed((e as Error).message);
      throw e;
    }
    // the push key of the new application, after the commit
    if (pushKey && secretKeyConfigured()) await appPublicKey(built.app.id).catch(() => undefined);
    // (sprint 73, APEX: straight to the new application's home) the result as a message on its page
    const pages = built.pages.length ? ` with ${built.pages.length} page(s) besides Home` : '';
    const account = built.app.existingAccount ? ` The existing account ${String(b.admin_user ?? '').trim()} got the admin role (its password was not changed).` : '';
    flash(s, `Application ${built.app.alias} created${pages}.${account}${built.notes.length ? ` ${built.notes.join(' ')}` : ''}`);
    return back(reply, s, `${BASE}/apps/${built.app.id}`);
  };
  app.post(`${BASE}/apps`, (req: Req, reply) => create(req, reply));
  app.post(`${BASE}/create/tables`, (req: Req, reply) => create(req, reply, true));
}

/** The workspace's boilerplate applications (Advanced → Start from). */
const boilerplates = async (s: Session) =>
  (await owner.query<{ id: number; name: string }>(`select id, name from meta.app a where app_type = 'boilerplate' and ${inWorkspaceSql('a', 1)} order by lower(name), id`, [currentWorkspace(s)])).rows;

/** Other ways to start (APEX: the Create Application wizard's sources). */
const SOURCES: [string, string, string, string][] = [
  ['create/file', 'upload', 'From a file', 'CSV, Excel, JSON or XML: a table per sheet with its rows'],
  ['create/paste', 'file', 'From pasted data', 'Rows copied from a spreadsheet, or CSV text'],
  ['blueprints', 'layers', 'From a blueprint', 'Tables, pages, menu and sample rows described once (or drafted by AI)'],
  ['gallery', 'grid', 'From the App Gallery', 'A starter application'],
];

async function createPage(s: Session, reply: FastifyReply, schema: string, b: Body | null, message: Raw | '' = '') {
  const schemas = await appSchemas();
  const known = schemas.includes(schema);
  const relations = known ? await schemaRelations(schema) : [];
  const bp = await boilerplates(s);
  const v = (k: string, d: string) => (b ? String(b[k] ?? '') : d);
  const features = featuresFrom(b ?? {}, !!b && b.features === '1');
  // (sprint 73) the name proposed from the schema is selected on first focus, so typing replaces it (app.js data-select-once)
  const suggested = known ? schema.replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase()) : '';
  const kindOf = (r: Relation, i: number) => (b ? (b[`t_${i}`] === r.relname ? (b[`k_${i}`] === undefined ? defaultKind(r) : String(b[`k_${i}`])) : '') : defaultKind(r));
  const rows = (r: Relation) => (r.rows === null ? 'not analyzed' : `about ${Number(r.rows).toLocaleString('en')} row(s)`);
  const main = html`<div class="ab-narrow create-app">
    <h1>Create an application</h1>
    <nav class="create-sources" aria-label="Other ways to start">${SOURCES.map(
      ([path, ic, label, help]) => html`<a class="create-source" href="${BASE}/${path}">${icon(ic)}<span><b>${label}</b><small class="muted">${help}</small></span></a>`,
    )}</nav>
    ${message}
    ${schema && !known && !message ? html`<div class="alert alert-error" role="alert">Choose one of the schemas in the list.</div>` : ''}
    ${region('Data', html`<form method="get" action="${BASE}/create" class="create-schema">
      <div class="form-grid">${select('schema', 'Pages on the tables of', schema, [['', '- a new, empty schema (Home only) -'], ...schemas.map((x): [string, string] => [x, x])],
        'The application\'s parsing schema. Choose a schema to get a page per table and view; a new schema is named after the alias.')}</div>
      <div class="buttons"><button class="btn">${icon('search')} Show its tables</button></div></form>`)}
    <form method="post" action="${BASE}/apps" data-progress="Creating the application and its pages…">${csrf(s)}
      <input type="hidden" name="schema" value="${known ? schema : ''}"><input type="hidden" name="features" value="1">
      ${known ? html`<input type="hidden" name="tables" value="1">` : ''}
      ${region('Application', html`<div class="form-grid">
        <div class="field"><label class="label" for="f_name">Name</label>
          <input id="f_name" name="name" value="${v('name', suggested)}" required data-select-once></div>
        ${input('description', 'Description', v('description', ''), { placeholder: 'One line for the home and About pages' })}
        ${iconPicker('f_icon', 'icon', 'Icon', v('icon', DEFAULT_APP_ICON))}
      </div>`)}
      ${region('Appearance', html`<div class="form-grid">
        ${select('base', 'Theme style', v('base', 'iris'), [['iris', 'Iris (light body, dark header and menu)'], ['lavender', 'Lavender (rounded, indigo)'], ['standard', 'Standard (blue, navy header)']])}
        ${select('nav', 'Navigation', v('nav', 'side'), [['side', 'Side menu'], ['top', 'Top menu']])}
        ${input('accent', 'Accent colour', v('accent', BASE_STYLES.iris.accent), { type: 'color', help: 'Of the theme style; the default stores nothing.' })}
      </div>`)}
      ${region('Pages', html`<ul class="aw-pages">
        <li><span class="aw-page-kind">${icon('home')} Home</span><span class="muted">a hero with the name and icon, and a card per page</span></li>
        ${known
          ? relations.length
            ? relations.map((r, i) => html`<li><input type="hidden" name="t_${i}" value="${r.relname}">
                <label class="aw-page-kind" for="f_k_${i}">${icon(r.kind === 'view' ? 'eye' : 'table')} ${r.relname}</label>
                <select id="f_k_${i}" name="k_${i}">${kindsFor(r).map((k) => html`<option value="${k}"${k === kindOf(r, i) ? raw(' selected') : ''}>${PAGE_KINDS[k]}</option>`)}</select>
                <small class="muted">${r.kind === 'view' ? 'view' : rows(r)}${r.kind === 'table' && !r.pk ? ', no single-column key: no form' : ''}${Number(r.rows ?? 0) > LARGE_TABLE ? ': a paged grid' : ''}</small></li>`)
            : html`<li class="muted">${schema} has no tables or views.</li>`
          : html`<li class="muted">Choose a schema under Data for a page per table, or add pages with the page wizards later.</li>`}
      </ul>
      ${known ? check('chart', 'Dashboard: a chart per table with the number of rows per parent row (a foreign key) or per value of a column whose values repeat', b ? b.chart === 'true' : true) : ''}`)}
      ${region('Features', html`<div class="aw-features">${FEATURES.map(([k, label, help]) => check(`f_${k}`, label, features[k], help))}</div>`)}
      ${region('Settings', html`<div class="form-grid">
        ${input('alias', 'Alias (URL)', v('alias', known ? await aliasFor(schema) : ''), { required: true, help: 'lowercase, e.g. inventory → /a/inventory' })}
        ${select('authentication', 'Authentication', v('authentication', 'app_users'), [['app_users', 'App users (login page)'], ['none', 'None (public)']])}
        ${input('admin_user', 'First user', v('admin_user', ''), { placeholder: 'e.g. your name', help: 'Gets the admin role. An existing account in Users is reused.' })}
        ${input('admin_password', 'Password', '', { type: 'password', auto: 'new-password', help: 'For a new account; at least 8 characters.' })}
        ${select('language', 'Language', v('language', 'en'), Object.entries(LANGUAGE_NAMES).map(([code, name]): [string, string] => [code, `${name} (${code})`]))}
      </div>`)}
      ${!known && bp.length
        ? html`<details class="region region-standard aw-advanced"><summary class="region-header"><h2>Advanced</h2></summary><div class="region-body"><div class="form-grid">
            ${select('boilerplate', 'Start from', v('boilerplate', ''), [['', '- a blank application -'], ...bp.map((x): [string, string] => [String(x.id), `${x.name} (boilerplate)`])],
              'A boilerplate application\'s pages, shared components and settings are copied; the new application keeps its own name, alias, role and authentication.')}
          </div></div></details>`
        : ''}
      <div class="buttons"><a class="btn" href="${BASE}">Cancel</a><button class="btn btn-hot">Create application</button></div>
    </form>
  </div>`;
  return send(reply, s, shell(s, 'Create application', [['App Builder', BASE], ['Create']], main));
}
