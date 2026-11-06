import type { FastifyInstance, FastifyReply } from 'fastify';
import pg from 'pg';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { LoadError } from '../dataload.ts';
import type { Session } from '../session.ts';
import { aliasFor, check, ITEM, type Created } from './appfromfile.ts';
import { addDashboard, parseBook } from './appsheets.ts';
import { finishGeneratedApp, checkNewApp, createApp, createAppError, featuresFrom, featureText, FEATURES, reservedSchema, startFromBoilerplate, DEFAULT_APP_ICON, type CheckedApp, type Features } from './newapp.ts';
import { currentWorkspace } from './workspaces.ts';
import { back, BASE, csrf, developer, flash, input, region, select, send, shell, type Body, type Req } from './ui.ts';
import { iconPicker } from './forms.ts';
import { inWorkspaceSql } from './workspaces.ts';
import { BASE_STYLES } from '../runtime/styles.ts';
import { LANGUAGE_NAMES } from '../i18n.ts';
import { secretKeyConfigured } from '../secrets.ts';
import { appPublicKey } from '../push.ts';
import { scopedTx as tx } from './i18n.ts';

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
  /** (sprint 78) the friendly name of its pages: Employees */
  label: string;
  kind: 'table' | 'view';
  pk: string | null;
  /** the planner's estimate (null: never analyzed) */
  rows: string | null;
  /** (sprint 73) a date or timestamp column for a calendar */
  calendar: boolean;
  /** (sprint 73) a table with a foreign key to this one, for master-detail */
  detail: boolean;
  /** (sprint 87) row level security is on, with this many policies */
  rls: boolean;
  policies: number;
}

/** The tables, partitioned tables, views and materialized views of a schema (not partitions). */
export async function schemaRelations(schema: string): Promise<Relation[]> {
  return (
    await owner.query<Relation>(
      `select c.relname, meta.wizard_table_label(c.oid) as label, case when c.relkind in ('v', 'm') then 'view' else 'table' end as kind,
              meta.wizard_pk(c.oid) as pk, case when c.reltuples >= 0 then c.reltuples::bigint end as rows,
              meta.wizard_defaults('calendar', c.oid) ->> 'start' is not null as calendar,
              meta.wizard_pk(c.oid) is not null and meta.wizard_defaults('master_detail', c.oid) ->> 'detail' is not null as detail,
              c.relrowsecurity as rls, (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
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
  if (plans.length > MAX_TABLES) throw new LoadError(tx('aw.at_most_tables', { n: MAX_TABLES }));
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
      else notes.push(tx('aw.no_dashboard'));
      if (skipped.length)
        notes.push(tx('aw.not_on_dashboard', { tables: skipped.map((t) => t.replace(/^.*\./, '').replace(/"/g, '')).join(', ') }));
    }
    await finishGeneratedApp(c, app.id, { description: checked.description, features, notes });
    return { app: { id: app.id, alias: checked.alias, existingAccount: app.existingAccount }, pages, notes };
  });
}

export async function appWizardRoutes(app: FastifyInstance) {
  const page = (s: Session, reply: FastifyReply, title: string, crumb: string, main: Raw) =>
    send(reply, s, shell(s, title, [[tx('aw.app_builder'), BASE], [tx('aw.create'), `${BASE}/create`], [crumb]], html`<div class="ab-narrow">${main}</div>`));

  // ---------------------------------------------------------------- pasted data
  const pasteForm = (s: Session, b: Body = {}, error?: string) =>
    html`<h1>${tx('aw.create_an_application_from_pasted')}</h1>
      <p class="muted">${tx.rich('aw.paste_intro', { link: html`<a href="${BASE}/create/file">${tx('aw.upload_a_file')}</a>` })}</p>
      ${region(tx('aw.data'), html`${error ? html`<div class="alert alert-error" role="alert">${error}</div>` : ''}
        <form method="post" action="${BASE}/create/paste">${csrf(s)}
          <div class="form-grid">
            ${input('title', tx('aw.name'), b.title ?? tx('aw.pasted_data'), { help: tx('aw.names_the_application_and_the') })}
            <div class="field" data-wide><label class="label" for="f_data">${tx('aw.data')}</label>
              <textarea id="f_data" name="data" class="code" rows="12" required spellcheck="false" placeholder="name,city,joined&#10;Ann,Utrecht,2026-01-05">${b.data ?? ''}</textarea></div>
            <div class="field"><label class="check"><input type="checkbox" name="headers" value="true"${b.headers === undefined || b.headers === 'true' ? raw(' checked') : ''}> ${tx('aw.first_row_contains_column_names')}</label></div>
          </div>
          <div class="buttons"><a class="btn" href="${BASE}/create">${tx('aw.cancel')}</a><button class="btn btn-hot">${icon('upload')} ${tx('aw.next')}</button></div>
        </form>`)}`;

  app.get(`${BASE}/create/paste`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    return page(s, reply, tx('aw.paste_title'), tx('aw.pasted_data'), pasteForm(s));
  });

  app.post(`${BASE}/create/paste`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = req.body ?? {};
    const fail = (message: string) => {
      reply.code(422);
      return page(s, reply, tx('aw.paste_title'), tx('aw.pasted_data'), pasteForm(s, { ...b, headers: b.headers === 'true' ? 'true' : 'false' }, message));
    };
    const text = typeof b.data === 'string' ? b.data : '';
    if (!text.trim()) return fail(tx('aw.paste_the_data'));
    const data = Buffer.from(text, 'utf8');
    if (data.length > MAX_PASTE) return fail(tx('aw.paste_max', { mb: MAX_PASTE / 1024 / 1024 }));
    const filename = pastedName(String(b.title ?? ''));
    const headers = b.headers === 'true';
    try {
      // read as delimited text whatever it looks like
      const sheets = await parseBook(filename, data, { headers });
      if (sheets[0].format !== 'csv') throw new LoadError(tx('aw.paste_delimited_text_csv_or'));
      if (!sheets[0].rows.length) throw new LoadError(tx('aw.the_data_has_column_names'));
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
      if (schema && (reservedSchema(schema) || !(await appSchemas()).includes(schema))) throw new LoadError(tx('aw.choose_one_of_the_schemas'));
      const checked = await checkNewApp({ ...b, schema }, currentWorkspace(s)).catch((e) => {
        throw new LoadError((e as Error).message);
      });
      const features = featuresFrom(b, b.features === '1');
      const boilerplate = /^\d{1,9}$/.test(b.boilerplate ?? '') ? Number(b.boilerplate) : null;
      if (boilerplate && !(await boilerplates(s)).some((x) => x.id === boilerplate)) throw new LoadError(tx('aw.choose_a_boilerplate_application_an'));
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
      if (askedTables && !plans.length) throw new LoadError(tx('aw.choose_at_least_one_table'));
      if (plans.length && boilerplate) throw new LoadError(tx('aw.a_boilerplate_application_brings_its'));
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
    const created = built.pages.length ? tx('aw.created_pages', { alias: built.app.alias, n: built.pages.length }) : tx('aw.created', { alias: built.app.alias });
    const account = built.app.existingAccount ? ` ${tx('aw.existing_account', { user: String(b.admin_user ?? '').trim() })}` : '';
    flash(s, `${created}${account}${built.notes.length ? ` ${built.notes.join(' ')}` : ''}`);
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

/**
 * (sprint 87) A table's row level security, before the application is created: on with its number
 * of policies, or on without any (the application's role then sees no rows unless it owns the table).
 */
const rlsBadge = (r: Relation) =>
  !r.rls ? ''
  : r.policies > 0
    ? html` <span class="tag aw-rls" title="${r.policies === 1 ? tx('aw.rls_on_1') : tx('aw.rls_on', { n: r.policies })}">${icon('shield')} RLS · ${r.policies}</span>`
    : html` <span class="tag tag-error aw-rls" title="${tx('aw.row_level_security_is_on')}">${icon('shield')} ${tx('aw.rls_no_policies')}</span>`;

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
  const rows = (r: Relation) => (r.rows === null ? tx('aw.not_analyzed') : tx('aw.about_rows', { n: Number(r.rows).toLocaleString('en') }));
  const main = html`<div class="ab-narrow create-app">
    <h1>${tx('aw.create_an_application')}</h1>
    <nav class="create-sources" aria-label="${tx('aw.other_ways_to_start')}">${SOURCES.map(
      ([path, ic, label, help]) => html`<a class="create-source" href="${BASE}/${path}">${icon(ic)}<span><b>${tx.dyn(`aw.src.${path.replace(/^create\//, '')}`, label)}</b><small class="muted">${tx.dyn(`aw.srch.${path.replace(/^create\//, '')}`, help)}</small></span></a>`,
    )}</nav>
    ${message}
    ${schema && !known && !message ? html`<div class="alert alert-error" role="alert">${tx('aw.choose_one_of_the_schemas')}</div>` : ''}
    ${region(tx('aw.data'), html`<form method="get" action="${BASE}/create" class="create-schema">
      <div class="form-grid">${select('schema', tx('aw.pages_on_the_tables_of'), schema, [['', tx('aw.a_new_empty_schema_home')], ...schemas.map((x): [string, string] => [x, x])],
        'The application\'s parsing schema. Choose a schema to get a page per table and view; a new schema is named after the alias.')}</div>
      <div class="buttons"><button class="btn">${icon('search')} ${tx('aw.show_its_tables')}</button></div></form>`)}
    <form method="post" action="${BASE}/apps" data-progress="Creating the application and its pages…">${csrf(s)}
      <input type="hidden" name="features" value="1">
      <div id="aw-schema-fields"><input type="hidden" name="schema" value="${known ? schema : ''}">${known ? html`<input type="hidden" name="tables" value="1">` : ''}</div>
      ${region(tx('aw.application'), html`<div class="form-grid">
        <div class="field"><label class="label" for="f_name">${tx('aw.name')}</label>
          <input id="f_name" name="name" value="${v('name', suggested)}" required data-select-once></div>
        ${input('description', tx('aw.description'), v('description', ''), { placeholder: tx('aw.one_line_for_the_home') })}
        ${iconPicker('f_icon', 'icon', tx('aw.icon'), v('icon', DEFAULT_APP_ICON))}
      </div>`)}
      ${region(tx('aw.appearance'), html`<div class="form-grid">
        ${select('base', tx('aw.theme_style'), v('base', 'iris'), [['iris', tx('aw.iris_light_body_dark_header')], ['lavender', tx('aw.lavender_rounded_indigo')], ['standard', tx('aw.standard_blue_navy_header')]])}
        ${select('nav', tx('aw.navigation'), v('nav', 'side'), [['side', tx('aw.side_menu')], ['top', tx('aw.top_menu')]])}
        ${input('accent', tx('aw.accent_colour'), v('accent', BASE_STYLES.iris.accent), { type: 'color', help: tx('aw.of_the_theme_style_the') })}
      </div>`)}
      ${region(tx('aw.pages'), html`<ul class="aw-pages">
        <li><span class="aw-page-kind">${icon('home')} ${tx('aw.home')}</span><span class="muted">${tx('aw.a_hero_with_the_name')}</span></li>
        ${known
          ? relations.length
            ? relations.map((r, i) => html`<li><input type="hidden" name="t_${i}" value="${r.relname}">
                <label class="aw-page-kind" for="f_k_${i}">${icon(r.kind === 'view' ? 'eye' : 'table')} ${r.label}</label>
                <select id="f_k_${i}" name="k_${i}">${kindsFor(r).map((k) => html`<option value="${k}"${k === kindOf(r, i) ? raw(' selected') : ''}>${tx.dyn(`aw.k.${k || 'none'}`, PAGE_KINDS[k])}</option>`)}</select>
                <small class="muted"><code>${r.relname}</code> · ${r.kind === 'view' ? tx('aw.view') : rows(r)}${r.kind === 'table' && !r.pk ? tx('aw.no_key') : ''}${Number(r.rows ?? 0) > LARGE_TABLE ? tx('aw.paged_grid') : ''}</small>${rlsBadge(r)}</li>`)
            : html`<li class="muted">${tx('aw.no_relations', { schema })}</li>`
          : html`<li class="muted">${tx('aw.choose_a_schema_under_data')}</li>`}
      </ul>
      ${known ? check('chart', tx('aw.dashboard_a_chart_per_table'), b ? b.chart === 'true' : true) : ''}`, '', 'aw-pages')}
      ${region(tx('aw.features'), html`<div class="aw-features">${FEATURES.map(([k, label, help]) => { const [l, h] = featureText(k, label, help); return check(`f_${k}`, l, features[k], h); })}</div>`)}
      ${region(tx('aw.settings'), html`<div class="form-grid">
        <div class="field"><label class="label" for="f_alias">${tx('aw.alias_url')}</label>
          <input id="f_alias" name="alias" value="${v('alias', known ? await aliasFor(schema) : '')}" required pattern="[a-z][a-z0-9_\-]*" maxlength="50" data-derive-from="f_name"${b && b.alias ? raw(' data-edited') : ''}>
          <small class="help">${tx('aw.lowercase_e_g_inventory_a')}</small></div>
        ${select('authentication', tx('aw.authentication'), v('authentication', 'app_users'), [['app_users', tx('aw.app_users_login_page')], ['none', tx('aw.none_public')]])}
        ${input('admin_user', tx('aw.first_user'), v('admin_user', ''), { placeholder: tx('aw.e_g_your_name'), help: tx('aw.gets_the_admin_role_an') })}
        ${input('admin_password', tx('aw.password'), '', { type: 'password', auto: 'new-password', help: tx('aw.for_a_new_account_at') })}
        ${select('language', tx('aw.language'), v('language', 'en'), Object.entries(LANGUAGE_NAMES).map(([code, name]): [string, string] => [code, `${name} (${code})`]))}
      </div>`)}
      ${!known && bp.length
        ? html`<details class="region region-standard aw-advanced"><summary class="region-header"><h2>${tx('aw.advanced')}</h2></summary><div class="region-body"><div class="form-grid">
            ${select('boilerplate', tx('aw.start_from'), v('boilerplate', ''), [['', tx('aw.a_blank_application')], ...bp.map((x): [string, string] => [String(x.id), tx('aw.bp_option', { name: x.name })])],
              'A boilerplate application\'s pages, shared components and settings are copied; the new application keeps its own name, alias, role and authentication.')}
          </div></div></details>`
        : ''}
      <div class="buttons"><a class="btn" href="${BASE}">${tx('aw.cancel')}</a><button class="btn btn-hot">${tx('aw.create_application')}</button></div>
    </form>
  </div>`;
  return send(reply, s, shell(s, tx('aw.create_application'), [[tx('aw.app_builder'), BASE], [tx('aw.create')]], main));
}
