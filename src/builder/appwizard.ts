import type { FastifyInstance, FastifyReply } from 'fastify';
import pg from 'pg';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { LoadError } from '../dataload.ts';
import type { Session } from '../session.ts';
import { aliasFor, check, createdHtml, ITEM, type Created } from './appfromfile.ts';
import { addDashboard, parseBook } from './appsheets.ts';
import { checkNewApp, createApp, createAppError, reservedSchema, type CheckedApp } from './newapp.ts';
import { BASE, csrf, developer, input, region, select, send, shell, type Body, type Req } from './ui.ts';

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
export const PASTED = 'text/x-pgapex-pasted';
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
}

/** The tables, partitioned tables, views and materialized views of a schema (not partitions). */
export async function schemaRelations(schema: string): Promise<Relation[]> {
  return (
    await owner.query<Relation>(
      `select c.relname, case when c.relkind in ('v', 'm') then 'view' else 'table' end as kind,
              meta.wizard_pk(c.oid) as pk, case when c.reltuples >= 0 then c.reltuples::bigint end as rows
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1 and c.relkind in ('r', 'p', 'v', 'm') and not c.relispartition
        order by c.relkind in ('v', 'm'), c.relname`,
      [schema],
    )
  ).rows;
}

/** The schemas an application can be built on: not pgapex's or the system's. */
const appSchemas = async () =>
  (await owner.query<{ nspname: string }>(`select nspname from pg_namespace where nspname !~ '^pg_' and nspname not in ('information_schema', 'meta') order by 1`)).rows.map(
    (r) => r.nspname,
  );

/** Create the application on existing tables and views, in one transaction. */
export async function buildAppFromTables(checked: CheckedApp, relations: Relation[], chart: boolean): Promise<Created> {
  if (!relations.length) throw new LoadError('Choose at least one table or view.');
  if (relations.length > MAX_TABLES) throw new LoadError(`Choose at most ${MAX_TABLES} tables and views.`);
  return owner.tx(async (c) => {
    const app = await createApp(c, checked).catch((e) => {
      throw new LoadError(createAppError(e, checked.alias));
    });
    const pages: Created['pages'] = [];
    const notes: string[] = [];
    const tables: string[] = [];
    let next = 2;
    for (const r of relations) {
      const T = `${pg.escapeIdentifier(checked.schema)}.${pg.escapeIdentifier(r.relname)}`;
      tables.push(T);
      const label = (await c.query('select meta.wizard_label($1) as l', [r.relname])).rows[0].l as string;
      if (r.kind === 'table' && r.pk) {
        await c.query('select meta.generate_page($1, $2, $3::regclass, $4, $5::jsonb)', [checked.alias, 'report_form', T, next, JSON.stringify({ form_page: next + 1, label })]);
        pages.push({ page: next, label }, { page: next + 1, label: `${label} form` });
        next += 2;
      } else {
        // a report of the rows (no form: a view, or no single-column primary key)
        const page = (await c.query(`select meta.wizard_new_page(a, $2, $3, a.home_page) as id from meta.app a where a.alias = $1`, [checked.alias, next, label])).rows[0].id;
        await c.query(
          `insert into meta.region (page_id, seq, title, type, source)
           select $1, 10, $2, 'report', format(E'select %s\\n  from %s', string_agg(quote_ident(column_name), ', ' order by ordinal), meta.wizard_qname($3::regclass))
             from meta.wizard_catalog($3::regclass) where kind <> 'binary'`,
          [page, label, T],
        );
        await c.query(`select meta.wizard_nav(a, $2, 'table', $3) from meta.app a where a.alias = $1`, [checked.alias, label, next]);
        pages.push({ page: next, label: `${label} (report)` });
        next += 1;
      }
    }
    if (chart) {
      const dash = await addDashboard(c, checked.alias, tables, next);
      if (dash) pages.push(dash);
      else notes.push('No dashboard: no table has a foreign key, or a text, yes/no or date column whose statistics show a few values that repeat (ANALYZE the tables first).');
    }
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

  // ---------------------------------------------------------------- existing tables
  const tablesForm = async (s: Session, schema: string, b: Body | null, message: Raw | '' = '') => {
    const schemas = await appSchemas();
    const known = schemas.includes(schema);
    const relations = known ? await schemaRelations(schema) : [];
    const v = (k: string, d: string) => (b ? String(b[k] ?? '') : d);
    const chosen = (r: Relation, i: number) => (b ? b[`t_${i}`] === r.relname : r.kind === 'table');
    return html`<h1>Create an application from existing tables</h1>
      <p class="muted">Pick the tables and views of a schema. The application gets the schema as its parsing schema and a database role app_&lt;alias&gt; with access to the schema's tables; each table gets an interactive report with a modal form (a view, or a table without a single-column primary key, gets a report), and a navigation entry.</p>
      ${message}
      ${region('Schema', html`<form method="get" action="${BASE}/create/tables">
        <div class="form-grid">${select('schema', 'Schema', schema, [['', '- choose a schema -'], ...schemas.map((x): [string, string] => [x, x])])}</div>
        <div class="buttons"><button class="btn">${icon('search')} Show its tables</button></div></form>`)}
      ${known
        ? html`<div class="u-spacer"></div><form method="post" action="${BASE}/create/tables">${csrf(s)}<input type="hidden" name="schema" value="${schema}">
          ${region(`Tables and views of ${schema}`, relations.length
            ? html`<ul class="aw-tables">${relations.map(
                (r, i) => html`<li><label class="check"><input type="checkbox" name="t_${i}" value="${r.relname}"${chosen(r, i) ? raw(' checked') : ''}> ${r.relname}</label>
                  <small class="muted">${r.kind === 'view' ? 'view: a report' : `${r.rows === null ? '' : `about ${r.rows} row(s), `}${r.pk ? 'a report and form' : 'no single-column primary key: a report'}`}</small></li>`,
              )}</ul>`
            : html`<p class="muted">This schema has no tables or views.</p>`)}
          <div class="u-spacer"></div>
          ${region('Application', html`<div class="form-grid">
            ${input('name', 'Name', v('name', schema.replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase())), { required: true })}
            ${input('alias', 'Alias (URL)', v('alias', await aliasFor(schema)), { required: true, help: 'lowercase, e.g. inventory → /a/inventory' })}
            ${select('authentication', 'Authentication', v('authentication', 'app_users'), [['app_users', 'App users (login page)'], ['none', 'None (public)']])}
            ${input('admin_user', 'First user', v('admin_user', ''), { placeholder: 'e.g. your name', help: 'Gets the admin role. An existing account in Users is reused.' })}
            ${input('admin_password', 'Password', '', { type: 'password', auto: 'new-password', help: 'For a new account; at least 8 characters.' })}
          </div>`)}
          <div class="u-spacer"></div>
          ${region('Pages', html`${check('chart', 'Dashboard: a chart per table with the number of rows per parent row (a foreign key) or per value of a column whose values repeat', b ? b.chart === 'true' : true)}`)}
          <div class="buttons"><a class="btn" href="${BASE}/create">Cancel</a><button class="btn btn-hot">Create application</button></div>
        </form>`
        : schema
          ? html`<div class="alert alert-error" role="alert">Choose one of the schemas in the list.</div>`
          : ''}`;
  };

  app.get(`${BASE}/create/tables`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const schema = typeof req.query.schema === 'string' ? req.query.schema : '';
    return page(s, reply, 'Create application from existing tables', 'Existing tables', await tablesForm(s, schema, null));
  });

  app.post(`${BASE}/create/tables`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = req.body ?? {};
    const schema = String(b.schema ?? '');
    const failed = async (message: string) => {
      reply.code(422);
      return page(s, reply, 'Create application from existing tables', 'Existing tables',
        await tablesForm(s, schema, b, html`<div class="alert alert-error" role="alert">${message}</div>`));
    };
    let built: Created;
    try {
      if (!schema || reservedSchema(schema) || !(await appSchemas()).includes(schema)) throw new LoadError('Choose one of the schemas in the list.');
      const checked = await checkNewApp({ ...b, schema }).catch((e) => {
        throw new LoadError((e as Error).message);
      });
      // only names of this schema's tables and views count (looked up again, never used as SQL)
      const relations = await schemaRelations(schema);
      const picked = new Set(Object.entries(b).filter(([k]) => /^t_\d+$/.test(k)).map(([, x]) => String(x)));
      built = await buildAppFromTables(checked, relations.filter((r) => picked.has(r.relname)), b.chart === 'true');
    } catch (e) {
      if (e instanceof LoadError || (e as { code?: string }).code) return failed((e as Error).message);
      throw e;
    }
    return page(s, reply, 'Create application from existing tables', 'Existing tables', createdHtml(built, String(b.admin_user ?? '').trim(), `${BASE}/create/tables`));
  });
}
