import type { FastifyInstance, FastifyReply } from 'fastify';
import { joinStatements, recordChanges } from '../changelog.ts';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import {
  JSON_TYPES, POSITION, ROW_KEY, ident, jsonSourceDdl, jsonSourceProblems, primaryKey, proposeProfile, sampleDocuments, tableGrants,
  type JsonArray, type JsonColumn, type JsonSource, type JsonType,
} from '../json-sources.ts';
import type { Session } from '../session.ts';
import { clientIp, logActivity } from '../session.ts';
import { clearCompletions } from './code-editor.ts';
import { appOr404 } from './forms.ts';
import { appHeader, back, BASE, csrf, developer, flash, input, region, send, shell, type Req } from './ui.ts';
import { currentWorkspace, usableSchemas, workshopDb } from './workspaces.ts';
import { scopedTx as tx } from './i18n.ts';

// (sprint 142, AP-8; APEX: Shared Components → Data Sources → JSON Sources)
//
// Shared Components → JSON sources: the application's JSON sources, a JSON list in meta.app (json_sources,
// migration 142) exported with the application. A source is a table's jsonb column with a data profile, proposed
// from sample rows (Propose from the data) and edited here: a column per path (name, type, read only), arrays of
// objects as views of their own. Create views makes the views (src/json-sources.ts) with the developer's SQL
// Workshop connection in one transaction, recorded in the Change Log; Create page makes a form on the view with a
// detail grid per array. The table, its key and its columns are read from the catalog with that connection: only
// tables in the schemas it may use, and only names found there reach the DDL (quoted).

type Body = Record<string, string | string[] | undefined>;
type Db = Awaited<ReturnType<typeof workshopDb>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
const SYSTEM = ['pg_catalog', 'information_schema', 'meta'];

const crumbs = (a: { id: number; name: string }, last?: string): [string, string?][] => [
  [tx('jsrc.app_builder'), BASE], [a.name, `${BASE}/apps/${a.id}`], [tx('jsrc.shared_components'), `${BASE}/apps/${a.id}/shared`],
  ...(last ? [[tx('jsrc.json_sources'), `${BASE}/apps/${a.id}/json-sources`], [last]] as [string, string?][] : [[tx('jsrc.json_sources')]] as [string, string?][]),
];
const listOf = (a: any) => (Array.isArray(a.json_sources) ? a.json_sources : []) as JsonSource[];
const srcUrl = (appId: number, name: string) => `${BASE}/apps/${appId}/json-sources/source?name=${encodeURIComponent(name)}`;
const pathText = (p: string[]) => p.join('.');
const pathFrom = (t: string) => t.trim() === '' || t.trim() === '.' ? [] : t.split('.').map((k) => k.trim());

/** The tables (and their json / jsonb columns) the developer's connection may use. */
async function jsonColumns(db: Db) {
  const schemas = (await usableSchemas(db)).filter((n) => !SYSTEM.includes(n));
  if (!schemas.length) return [];
  return (await db.query<{ schema: string; table: string; column: string }>(
    `select n.nspname as schema, c.relname as table, a.attname as column
       from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_attribute a on a.attrelid = c.oid
      where c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped and a.atttypid in ('jsonb'::regtype, 'json'::regtype)
        and n.nspname = any ($1) and has_table_privilege(c.oid, 'select')
      order by 1, 2, 3`, [schemas])).rows;
}

/** Which of the source's views exist now (and whether they are this source's: their trigger). */
async function viewState(db: Db, x: JsonSource) {
  const names = [x.view, ...x.arrays.map((y) => y.view)];
  const rows = (await db.query<{ n: string; ours: boolean }>(
    `select c.relname as n, exists (select from pg_trigger t where t.tgrelid = c.oid and t.tgname = 'json_source_write') as ours
       from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = $1 and c.relname = any ($2)`, [x.schema, names])).rows;
  return new Map(rows.map((r) => [r.n, r.ours]));
}

function columnsTable(prefix: string, cols: JsonColumn[], extra: number, emptyPath: boolean): Raw {
  const rows = [...cols, ...Array.from({ length: extra }, (): JsonColumn => ({ name: '', path: [], type: 'text' }))];
  return html`<div class="table-wrap"><table class="report js-cols"><thead><tr><th scope="col">${tx('jsrc.column')}</th><th scope="col">${tx('jsrc.path')}</th><th scope="col">${tx('jsrc.type')}</th><th scope="col">${tx('jsrc.read_only')}</th></tr></thead><tbody>
    ${rows.map((c, i) => html`<tr>
      <td><input name="${prefix}.${i}.name" value="${c.name}" class="code" aria-label="${tx('jsrc.aria_name', { n: i + 1 })}" autocomplete="off" spellcheck="false"></td>
      <td><input name="${prefix}.${i}.path" value="${pathText(c.path)}" class="code" aria-label="${tx('jsrc.aria_path', { n: i + 1 })}" autocomplete="off" spellcheck="false"${emptyPath ? html` placeholder="${tx('jsrc.the_element_itself')}"` : ''}></td>
      <td><select name="${prefix}.${i}.type" aria-label="${tx('jsrc.aria_type', { n: i + 1 })}">${JSON_TYPES.map((t) => html`<option${t === c.type ? raw(' selected') : ''}>${t}</option>`)}</select></td>
      <td class="te-c"><input type="checkbox" name="${prefix}.${i}.readonly" aria-label="${tx('jsrc.aria_readonly', { n: i + 1 })}"${c.readonly ? raw(' checked') : ''}></td></tr>`)}
    </tbody></table></div>`;
}

function sourceForm(a: any, s: Session, x: JsonSource, original: string, problems: string[], tables: { schema: string; table: string; column: string }[]): Raw {
  const opts = tables.map((t) => `${t.schema}.${t.table}.${t.column}`);
  const cur = x.schema ? `${x.schema}.${x.table}.${x.column}` : '';
  if (cur && !opts.includes(cur)) opts.unshift(cur);
  return html`${problems.length ? html`<div class="alert alert-error" role="alert"><ul>${problems.map((p) => html`<li>${p}</li>`)}</ul></div>` : ''}
    <form method="post" action="${BASE}/apps/${a.id}/json-sources/source">${csrf(s)}<input type="hidden" name="original" value="${original}">
      <fieldset class="prop-group"><legend>${tx('jsrc.json_source')}</legend><div class="form-grid">
        ${input('name', tx('jsrc.name_static_id'), x.name, { required: true, placeholder: tx('jsrc.e_g_emp_profile'), help: tx('jsrc.upper_case_letters_digits_and') })}
        ${input('description', tx('jsrc.description'), x.description ?? '')}
        <div class="field"><label class="label" for="js-source">${tx('jsrc.table_and_jsonb_column')}</label>
          <select id="js-source" name="source">${opts.length ? opts.map((o) => html`<option${o === cur ? raw(' selected') : ''}>${o}</option>`) : html`<option value="">${tx('jsrc.no_json_table')}</option>`}</select>
          <small class="help">${tx('jsrc.a_column_of_a_table')}</small></div>
        ${input('view', tx('jsrc.view'), x.view, { required: true, placeholder: tx('jsrc.e_g_emp_profile_2'), help: tx('jsrc.made_in_the_table_s') })}
        <div class="field"><label class="check"><input type="checkbox" name="rows"${x.rows ? raw(' checked') : ''}> ${tx('jsrc.the_view_also_adds_and')}</label>
          <small class="help">${tx('jsrc.for_a_table_of_documents')}</small></div>
      </div></fieldset>
      <fieldset class="prop-group"><legend>${tx('jsrc.columns')}</legend>
        <p class="muted u-mt0">${tx.code('jsrc.a_column_per_path_in')}</p>
        ${columnsTable('c', x.columns, 3, false)}</fieldset>
      ${x.arrays.map((y, j) => html`<fieldset class="prop-group"><legend>Array ${y.name}</legend><div class="form-grid">
          ${input(`a.${j}.name`, tx('jsrc.name'), y.name, { required: true })}
          ${input(`a.${j}.path`, tx('jsrc.path'), pathText(y.path), { required: true, help: tx('jsrc.the_array_in_the_document') })}
          ${input(`a.${j}.view`, tx('jsrc.view'), y.view, { required: true, help: tx('jsrc.array_view_help', { rowkey: ROW_KEY, position: POSITION }) })}
          <div class="field"><label class="check"><input type="checkbox" name="a.${j}.drop"> ${tx('jsrc.remove_this_array')}</label></div>
        </div>${columnsTable(`a.${j}.c`, y.columns, 2, true)}</fieldset>`)}
      <fieldset class="prop-group"><legend>${tx('jsrc.add_an_array')}</legend><div class="form-grid">
        ${input(`a.${x.arrays.length}.name`, tx('jsrc.name'), '', { placeholder: tx('jsrc.e_g_skills') })}
        ${input(`a.${x.arrays.length}.path`, tx('jsrc.path'), '', { placeholder: tx('jsrc.e_g_skills') })}
        ${input(`a.${x.arrays.length}.view`, tx('jsrc.view'), '', { placeholder: tx('jsrc.e_g_emp_profile_skills') })}
      </div><small class="help">${tx('jsrc.add_the_array_then_propose')}</small></fieldset>
      <div class="buttons">
        <button class="btn btn-hot" name="mode" value="save">${original ? tx('jsrc.save') : tx('jsrc.add_json_source')}</button>
        <button class="btn" name="mode" value="propose" formnovalidate>${icon('lightbulb')} ${tx('jsrc.propose_from_the_data')}</button>
      </div>
    </form>`;
}

/** The definition from the posted form (names trimmed; empty column rows left out). */
function sourceFrom(b: Body, key: string[]): JsonSource {
  const [schema = '', table = '', column = ''] = (() => {
    const v = one(b.source);
    const i = v.lastIndexOf('.');
    const j = v.indexOf('.');
    return i > j && j > 0 ? [v.slice(0, j), v.slice(j + 1, i), v.slice(i + 1)] : [];
  })();
  const colsFrom = (prefix: string) => {
    const out: JsonColumn[] = [];
    for (let i = 0; i < 400 && b[`${prefix}.${i}.name`] !== undefined; i++) {
      const name = one(b[`${prefix}.${i}.name`]).trim();
      if (!name) continue;
      const type = one(b[`${prefix}.${i}.type`]) as JsonType;
      const c: JsonColumn = { name, path: pathFrom(one(b[`${prefix}.${i}.path`])), type };
      if (one(b[`${prefix}.${i}.readonly`]) === 'on') c.readonly = true;
      out.push(c);
    }
    return out;
  };
  const arrays: JsonArray[] = [];
  for (let j = 0; j < 50 && b[`a.${j}.name`] !== undefined; j++) {
    const name = one(b[`a.${j}.name`]).trim();
    if (!name || one(b[`a.${j}.drop`]) === 'on') continue;
    arrays.push({ name, path: pathFrom(one(b[`a.${j}.path`])), view: one(b[`a.${j}.view`]).trim(), columns: colsFrom(`a.${j}.c`) });
  }
  const x: JsonSource = { name: one(b.name).trim().toUpperCase(), schema, table, key, column, view: one(b.view).trim(), columns: colsFrom('c'), arrays };
  const description = one(b.description).trim().slice(0, 500);
  if (description) x.description = description;
  if (one(b.rows) === 'on') x.rows = true;
  return x;
}

async function update(appId: number, change: (list: JsonSource[]) => string[]) {
  return owner.tx(async (c) => {
    const row = (await c.query<{ json_sources: JsonSource[] }>('select json_sources from meta.app where id = $1 for update', [appId])).rows[0];
    const list = [...(row?.json_sources ?? [])];
    const problems = change(list);
    if (problems.length) return problems;
    await c.query('update meta.app set json_sources = $2, updated_at = now() where id = $1', [appId, JSON.stringify(list)]);
    return [];
  });
}

/** Item type of a column on the generated form. */
const itemType = (t: JsonType) => (({ integer: 'number', bigint: 'number', numeric: 'number', boolean: 'switch', date: 'date', timestamp: 'datetime', timestamptz: 'datetime', jsonb: 'textarea', text: 'text' }) as const)[t];
const label = (n: string) => n.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** A form on the source's view with a detail grid per array; returns the page number. */
export async function createSourcePage(appId: number, x: JsonSource, pageNo: number, title: string) {
  if (x.key.length !== 1) throw new Error(tx('jsrc.create_page_needs_a_table'));
  const key = x.key[0];
  const keyItem = `P${pageNo}_${key.toUpperCase()}`;
  return owner.tx(async (c) => {
    if ((await c.query('select 1 from meta.page where app_id = $1 and page_no = $2', [appId, pageNo])).rows.length) throw new Error(tx('jsrc.page_exists', { n: pageNo }));
    const pageId = (await c.query<{ id: number }>('insert into meta.page (app_id, page_no, name, title) values ($1, $2, $3, $3) returning id', [appId, pageNo, title])).rows[0].id;
    const form = (await c.query<{ id: number }>(
      `insert into meta.region (page_id, seq, title, type, table_name, pk_column, pk_item) values ($1, 10, $2, 'form', $3, $4, $5) returning id`,
      [pageId, title, `${x.schema}.${x.view}`, key, keyItem])).rows[0].id;
    await c.query(`insert into meta.item (page_id, region_id, seq, name, label, type, source_column) values ($1, $2, 10, $3, $4, 'hidden', $5)`, [pageId, form, keyItem, label(key), key]);
    let seq = 20;
    for (const col of x.columns) {
      await c.query(`insert into meta.item (page_id, region_id, seq, name, label, type, source_column, readonly_condition) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [pageId, form, seq, `P${pageNo}_${col.name.toUpperCase()}`.slice(0, 60), label(col.name), itemType(col.type), col.name, col.readonly ? 'true' : null]);
      seq += 10;
    }
    await c.query(`insert into meta.button (page_id, region_id, seq, name, label, action) values ($1, $2, 10, 'SAVE', 'Apply Changes', 'submit')`, [pageId, form]);
    await c.query(`insert into meta.process (page_id, region_id, seq, name, type, point) values ($1, $2, 10, $3, 'form_dml', 'submit')`, [pageId, form, `Process form ${title}`]);
    let rseq = 20;
    for (const y of x.arrays) {
      const cols = [ident(key), ROW_KEY, POSITION, ...y.columns.map((col) => ident(col.name))];
      const grid = (await c.query<{ id: number }>(
        `insert into meta.region (page_id, seq, title, type, table_name, pk_column, source, config) values ($1, $2, $3, 'grid', $4, $5, $6, $7) returning id`,
        [pageId, rseq, label(y.name), `${x.schema}.${y.view}`, ROW_KEY,
          `select ${cols.join(', ')}\n  from ${ident(x.schema)}.${ident(y.view)}\n where ${ident(key)}::text = :${keyItem}\n order by ${POSITION}`,
          JSON.stringify({ master: { item: keyItem, column: key }, readonly: [POSITION], layout: { hidden: [key, ROW_KEY] }, headings: { [POSITION]: '#' }, row_actions: { delete: true } })])).rows[0].id;
      await c.query(`insert into meta.process (page_id, region_id, seq, name, type, point) values ($1, $2, $3, $4, 'grid_dml', 'submit')`, [pageId, grid, rseq, `Save ${label(y.name)}`]);
      rseq += 10;
    }
    return pageNo;
  });
}

export async function jsonSourceRoutes(app: FastifyInstance) {
  const load = async (req: Req, reply: FastifyReply) => {
    const s = await developer(req, reply);
    if (!s) return null;
    const a = await appOr404(req.params.id);
    if (!a) {
      reply.code(404).send('Not found');
      return null;
    }
    return { s, a };
  };

  app.get(`${BASE}/apps/:id(^\\d+$)/json-sources`, async (req: Req, reply) => {
    const ok = await load(req, reply);
    if (!ok) return;
    const { s, a } = ok;
    const list = listOf(a);
    const db = await workshopDb(s);
    const states = await Promise.all(list.map((x) => viewState(db, x).catch(() => new Map<string, boolean>())));
    const main = html`${appHeader(a, 'shared', s)}
      <div class="title-row"><h1>${tx('jsrc.json_sources')}</h1></div>
      <p class="muted u-mt0">${tx('jsrc.a_json_source_describes_a')}</p>
      ${region(tx('jsrc.sources'), html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th scope="col">${tx('jsrc.name')}</th><th scope="col">${tx('jsrc.column')}</th><th scope="col">${tx('jsrc.views')}</th></tr></thead>
        <tbody>${list.length ? list.map((x, i) => html`<tr><td data-label="${tx('jsrc.name')}"><a href="${srcUrl(a.id, x.name)}">${x.name}</a>${x.description ? html` <span class="muted">${x.description}</span>` : ''}</td>
          <td data-label="${tx('jsrc.column')}"><code>${x.schema}.${x.table}.${x.column}</code></td>
          <td data-label="${tx('jsrc.views')}">${[x.view, ...x.arrays.map((y) => y.view)].map((v) => html`<code>${v}</code>${states[i].get(v) ? '' : html` <span class="tag">${tx('jsrc.not_made')}</span>`} `)}</td></tr>`)
          : html`<tr><td colspan="3" class="empty">${tx('jsrc.no_json_sources_yet')}</td></tr>`}</tbody></table></div>
        <p><a class="btn" href="${BASE}/apps/${a.id}/json-sources/source">${icon('plus')} ${tx('jsrc.add_json_source')}</a></p>`)}`;
    return send(reply, s, shell(s, tx('jsrc.json_sources'), crumbs(a), main));
  });

  app.get(`${BASE}/apps/:id(^\\d+$)/json-sources/source`, async (req: Req, reply) => {
    const ok = await load(req, reply);
    if (!ok) return;
    const { s, a } = ok;
    const name = String((req.query as Record<string, unknown>)?.name ?? '').toUpperCase();
    const db = await workshopDb(s);
    const tables = await jsonColumns(db);
    const x: JsonSource | undefined = name
      ? listOf(a).find((y) => y.name === name)
      : { name: '', schema: '', table: '', key: [], column: '', view: '', columns: [], arrays: [] };
    if (!x) return reply.code(404).send('Not found');
    const title = name || 'New JSON source';
    let extra: Raw | '' = '';
    if (name) {
      const st = await viewState(db, x).catch(() => new Map<string, boolean>());
      const made = st.get(x.view) === true;
      const ddl = jsonSourceDdl(x, { app: a.alias, grants: await tableGrants(db, x.schema, x.table).catch(() => []), replace: st.size > 0 });
      extra = html`${region(tx('jsrc.views'), html`
        <p>${made ? html`${icon('check')} The views exist. Make them again after changing the columns.` : tx('jsrc.the_views_are_not_made')}</p>
        <details><summary>DDL</summary><pre class="source te-ddl" data-code-view="sql" tabindex="0" aria-label="DDL">${ddl.map((d) => `${d};`).join('\n\n')}</pre></details>
        <form method="post" action="${BASE}/apps/${a.id}/json-sources/views" class="buttons">${csrf(s)}<input type="hidden" name="name" value="${x.name}">
          <button class="btn btn-hot" name="mode" value="apply">${icon('check')} ${made ? tx('jsrc.make_the_views_again') : tx('jsrc.create_views')}</button>
          <button class="btn" name="mode" value="worksheet">${icon('code')} ${tx('jsrc.open_in_the_sql_worksheet')}</button></form>`)}
        ${made ? region(tx('jsrc.create_page'), html`<form method="post" action="${BASE}/apps/${a.id}/json-sources/page">${csrf(s)}<input type="hidden" name="name" value="${x.name}">
          <p class="muted u-mt0">${tx.rich(x.arrays.length === 0 ? 'jsrc.form_on' : x.arrays.length === 1 ? 'jsrc.form_on_grid' : 'jsrc.form_on_grids', { view: html`<code>${x.view}</code>`, arrays: x.arrays.map((y) => y.name).join(', '), item: html`<code>P<i>n</i>_${(x.key[0] ?? '').toUpperCase()}</code>` })}</p>
          <div class="form-grid">${input('page_no', tx('jsrc.page_number'), '', { type: 'number', required: true })}${input('title', tx('jsrc.title'), x.name.replace(/_/g, ' ').toLowerCase().replace(/^./, (ch) => ch.toUpperCase()), { required: true })}</div>
          <div class="buttons"><button class="btn">${icon('plus')} ${tx('jsrc.create_page')}</button></div></form>`) : ''}
        <form method="post" action="${BASE}/apps/${a.id}/json-sources/source/delete" class="danger-zone">${csrf(s)}<input type="hidden" name="name" value="${x.name}">
          <button class="btn btn-danger" data-confirm="${tx('jsrc.delete_confirm', { name: x.name })}">${tx('jsrc.delete_json_source')}</button></form>`;
    }
    const main = html`${appHeader(a, 'shared', s)}<div class="title-row"><h1>${title}</h1></div>${region(tx('jsrc.json_source'), sourceForm(a, s, x, name, [], tables))}${extra}`;
    return send(reply, s, shell(s, title, crumbs(a, title), main));
  });

  app.post(`${BASE}/apps/:id(^\\d+$)/json-sources/source`, async (req: Req, reply) => {
    const ok = await load(req, reply);
    if (!ok) return;
    const { s, a } = ok;
    const b = (req.body ?? {}) as Body;
    const original = one(b.original).toUpperCase();
    const db = await workshopDb(s);
    const tables = await jsonColumns(db);
    let x = sourceFrom(b, []);
    const errors: string[] = [];
    if (!tables.some((t) => t.schema === x.schema && t.table === x.table && t.column === x.column)) errors.push(tx('jsrc.choose_a_table_and_its'));
    else x.key = await primaryKey(db, x.schema, x.table);
    if (!x.view && x.table) x.view = `${x.table}_${x.column}`.toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 63);
    if (!errors.length && one(b.mode) === 'propose') {
      const p = proposeProfile(await sampleDocuments(db, x.schema, x.table, x.column), { key: x.key, view: x.view });
      // keep what the developer named; add what the data has besides
      const have = new Set(x.columns.map((c) => pathText(c.path)));
      x = { ...x, columns: [...x.columns, ...p.columns.filter((c) => !have.has(pathText(c.path)) && !x.columns.some((y) => y.name === c.name))] };
      for (const pa of p.arrays) {
        const mine = x.arrays.find((y) => pathText(y.path) === pathText(pa.path));
        if (!mine) x.arrays.push(pa);
        else if (!mine.columns.length) mine.columns = pa.columns;
      }
      const title = original || 'New JSON source';
      const main = html`${appHeader(a, 'shared', s)}<div class="title-row"><h1>${title}</h1></div>
        <p class="alert alert-info" role="status">${tx('jsrc.proposed_from_up_to_200')}</p>
        ${region(tx('jsrc.json_source'), sourceForm(a, s, x, original, [], tables))}`;
      return send(reply, s, shell(s, title, crumbs(a, title), main));
    }
    const problems = errors.length ? errors : await update(a.id, (list) => {
      const out = jsonSourceProblems(x);
      const at = original ? list.findIndex((y) => y.name === original) : -1;
      if (original && at < 0) out.push(`JSON source ${original} no longer exists.`);
      if (list.some((y, i) => y.name === x.name && i !== at)) out.push(`A JSON source ${x.name} exists already.`);
      const views = new Map(list.filter((_, i) => i !== at).flatMap((y) => [y.view, ...y.arrays.map((z) => z.view)].map((v) => [`${y.schema}.${v}`, y.name])));
      for (const v of [x.view, ...x.arrays.map((z) => z.view)]) if (views.has(`${x.schema}.${v}`)) out.push(tx('jsrc.view_taken', { view: v, source: views.get(`${x.schema}.${v}`) ?? '' }));
      if (out.length) return out;
      if (at >= 0) list[at] = x;
      else list.push(x);
      return [];
    });
    if (problems.length) {
      const title = original || 'New JSON source';
      const main = html`${appHeader(a, 'shared', s)}<div class="title-row"><h1>${title}</h1></div>${region(tx('jsrc.json_source'), sourceForm(a, s, x, original, problems, tables))}`;
      return send(reply.code(422), s, shell(s, title, crumbs(a, title), main));
    }
    flash(s, tx('jsrc.json_source_saved'));
    return back(reply, s, srcUrl(a.id, x.name));
  });

  app.post(`${BASE}/apps/:id(^\\d+$)/json-sources/source/delete`, async (req: Req, reply) => {
    const ok = await load(req, reply);
    if (!ok) return;
    const { s, a } = ok;
    const name = one((req.body as Body)?.name).toUpperCase();
    await update(a.id, (list) => {
      const at = list.findIndex((y) => y.name === name);
      if (at >= 0) list.splice(at, 1);
      return [];
    });
    flash(s, `JSON source ${name} deleted. Its views stay in the database.`);
    return back(reply, s, `${BASE}/apps/${a.id}/json-sources`);
  });

  // Create views: in one transaction with the developer's SQL Workshop connection, recorded in the Change Log
  app.post(`${BASE}/apps/:id(^\\d+$)/json-sources/views`, async (req: Req, reply) => {
    const ok = await load(req, reply);
    if (!ok) return;
    const { s, a } = ok;
    const b = (req.body ?? {}) as Body;
    const x = listOf(a).find((y) => y.name === one(b.name).toUpperCase());
    if (!x) return reply.code(404).send('Not found');
    const to = srcUrl(a.id, x.name);
    const db = await workshopDb(s);
    // the catalog again: the table must still be one the connection may use, with that column and key
    const tables = await jsonColumns(db);
    const problems = jsonSourceProblems(x);
    if (!tables.some((t) => t.schema === x.schema && t.table === x.table && t.column === x.column)) problems.push(`${x.schema}.${x.table}.${x.column} is not a json or jsonb column this connection may use.`);
    else if ((await primaryKey(db, x.schema, x.table)).join(',') !== x.key.join(',')) problems.push(tx('jsrc.key_changed', { table: `${x.schema}.${x.table}` }));
    const st = problems.length ? new Map() : await viewState(db, x);
    for (const [v, ours] of st) if (!ours) problems.push(`${x.schema}.${v} exists and is not a view of a JSON source: choose another name.`);
    if (problems.length) {
      flash(s, problems.join(' '), 'error');
      return back(reply, s, to);
    }
    const ddl = jsonSourceDdl(x, { app: a.alias, grants: await tableGrants(db, x.schema, x.table), replace: st.size > 0 });
    if (one(b.mode) === 'worksheet') {
      s.state.__SQLDRAFT = `${ddl.join(';\n\n')};`;
      flash(s, tx('jsrc.check_the_statements_then_run'));
      return back(reply, s, `${BASE}/sql/worksheet`);
    }
    const c = await db.pool.connect();
    let failed = '';
    try {
      await c.query('begin');
      for (const d of ddl) await c.query(d);
      await c.query('commit');
    } catch (e) {
      failed = (e as Error).message;
      await c.query('rollback').catch(() => {});
    } finally {
      c.release(true);
    }
    await logActivity({ username: s.username, event: 'sql_command', ip: clientIp(req), detail: ddl.join(';\n').slice(0, 2000) });
    clearCompletions();
    if (failed) {
      flash(s, tx('jsrc.nothing_changed', { error: failed }), 'error');
      return back(reply, s, to);
    }
    await recordChanges({ workspaceId: currentWorkspace(s), author: s.username ?? '?', source: 'table', defaultSchema: x.schema, statements: [joinStatements(ddl)] });
    flash(s, tx('jsrc.views_made', { name: x.name, views: [x.view, ...x.arrays.map((y) => y.view)].join(', ') }));
    return back(reply, s, to);
  });

  app.post(`${BASE}/apps/:id(^\\d+$)/json-sources/page`, async (req: Req, reply) => {
    const ok = await load(req, reply);
    if (!ok) return;
    const { s, a } = ok;
    const b = (req.body ?? {}) as Body;
    const x = listOf(a).find((y) => y.name === one(b.name).toUpperCase());
    if (!x) return reply.code(404).send('Not found');
    const pageNo = Number(one(b.page_no));
    const title = one(b.title).trim().slice(0, 200) || x.name;
    if (!Number.isInteger(pageNo) || pageNo < 1 || pageNo > 99999) {
      flash(s, tx('jsrc.the_page_number_is_a'), 'error');
      return back(reply, s, srcUrl(a.id, x.name));
    }
    try {
      await createSourcePage(a.id, x, pageNo, title);
    } catch (e) {
      flash(s, (e as Error).message, 'error');
      return back(reply, s, srcUrl(a.id, x.name));
    }
    flash(s, x.arrays.length ? tx('jsrc.page_made_grids', { n: pageNo, view: x.view }) : tx('jsrc.page_made', { n: pageNo, view: x.view }));
    return back(reply, s, `${BASE}/apps/${a.id}/pages/${pageNo}`);
  });
}

