import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  catalogOf, checkDataset, DATASET_LIMITS, DATASET_NAME, datasetFile, datasetOf, datasetSql, proposeDataset, proposeJoin, readDatasetFile,
  readSchemaCatalog, storeDataset, workspaceDatasets, type Dataset, type DatasetRow,
} from '../datasets.ts';
import { owner, type Db } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { createReportingApp, MAX_REPORTING_DATASETS, reportingApps } from '../reporting-app.ts';
import { readMultipart } from '../runtime/files.ts';
import { heading } from '../runtime/items.ts';
import { opLabel, OPERATORS } from '../runtime/report.ts';
import { english } from '../i18n.ts';
import { logActivity, clientIp, type Session } from '../session.ts';
import { checkNewApp, createAppError } from './newapp.ts';
import { back, BASE, csrf, developer, flash, input, region, send, shell, type Body, type Req } from './ui.ts';
import { currentWorkspace, usableSchemas, workshopDb } from './workspaces.ts';

// (sprint 110, migration 120) App Builder → Data Reporter (/builder/reporter; APEX 26.1: Data Reporter as a
// workspace tool): the workspace's datasets (tables and views of one schema, joins proposed from foreign keys,
// the columns business users may see with labels, format masks and descriptions, a row filter), their files
// (pgkiln-dataset/1: download one or all, import), and reporting applications made from them (two clicks: Create
// reporting application on a dataset, then Create). Every developer of the workspace manages them; the catalog is
// read through the SQL Workshop's connection (an isolated workspace's own login), and a dataset is checked
// against it before it is saved.

const root = `${BASE}/reporter`;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const PREVIEW_ROWS = 10;
const crumbs = (extra: [string, string?][] = []): [string, string?][] => [['App Builder', BASE], ['Data Reporter', root], ...extra];
const when = (d: string | Date | null) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '');

const page = (s: Session, reply: FastifyReply, title: string, extra: [string, string?][], main: Raw) =>
  send(reply, s, shell(s, title, crumbs(extra), html`<div class="ab-narrow dataset-page">${main}</div>`, 'reporter'));

/** A dataset of the current workspace by id (null: none, or another workspace's). */
async function datasetRow(s: Session, id: string): Promise<DatasetRow | null> {
  if (!/^\d{1,12}$/.test(id)) return null;
  return (await owner.one<DatasetRow>('select * from meta.dataset where id = $1 and workspace_id = $2', [id, currentWorkspace(s)])) ?? null;
}

/** A schema the developer's SQL Workshop connection may use, or null. */
async function usableSchema(db: Db, schema: string) {
  return schema && (await usableSchemas(db)).includes(schema) ? schema : null;
}

/** "deptno = deptno, x = y" → join column pairs (this table's column = the earlier table's). */
export function parseOn(text: string) {
  return text
    .split(',')
    .map((p) => p.split('=').map((x) => x.trim()))
    .filter((p) => p.length === 2 && p[0] && p[1])
    .map(([column, ref]) => ({ column, ref }))
    .slice(0, DATASET_LIMITS.joinColumns);
}

/** The dataset of the edit form (loose: checkDataset() does the checking). */
export function datasetFromForm(d: Dataset, b: Body, cat: Awaited<ReturnType<typeof readSchemaCatalog>>): Record<string, unknown> {
  const tables: any[] = [];
  for (let i = 0; i < DATASET_LIMITS.tables && b[`t${i}_alias`] !== undefined; i++) {
    const old = d.tables.find((t) => t.alias === b[`t${i}_alias`]);
    if (!old || b[`t${i}_remove`] === 'true') continue;
    tables.push(i === 0 || !tables.length ? { alias: old.alias, table: old.table } : {
      alias: old.alias, table: old.table,
      join: { to: String(b[`t${i}_to`] ?? ''), type: b[`t${i}_type`] === 'inner' ? 'inner' : 'left', on: parseOn(String(b[`t${i}_on`] ?? '')) },
    });
  }
  const added = String(b.new_table ?? '');
  if (added && cat.objects.some((o) => o.name === added) && tables.length < DATASET_LIMITS.tables) {
    let n = 1;
    while (tables.some((t) => t.alias === `t${n}`) || d.tables.some((t) => t.alias === `t${n}`)) n++;
    const on = parseOn(String(b.new_on ?? ''));
    const join = tables.length
      ? on.length ? { to: String(b.new_to || tables[0].alias), type: 'left', on } : proposeJoin(added, tables, cat.fks)
      : undefined;
    tables.push({ alias: `t${n}`, table: added, ...(join ? { join } : {}) });
  }
  const columns: any[] = [];
  for (let j = 0; j < 1000 && b[`c${j}_ref`] !== undefined; j++) {
    if (b[`c${j}_on`] !== 'true') continue;
    const [alias, ...rest] = String(b[`c${j}_ref`]).split('.');
    columns.push({ table: alias, column: rest.join('.'), name: b[`c${j}_name`], label: b[`c${j}_label`], format: b[`c${j}_format`], description: b[`c${j}_desc`] });
  }
  // a table added just now: its columns are offered at once (except the join's and binary ones)
  const fresh = tables.find((t) => !d.tables.some((x) => x.alias === t.alias));
  if (fresh) {
    const taken = new Set(columns.map((c) => String(c.name ?? '')));
    const skip = new Set((fresh.join?.on ?? []).map((p: { column: string }) => p.column));
    for (const c of cat.objects.find((o) => o.name === fresh.table)?.columns ?? []) {
      if (c.type === 'bytea' || skip.has(c.name)) continue;
      let name = c.name.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^[^a-z]+/, '').slice(0, 40) || 'col';
      if (taken.has(name)) name = `${fresh.table}_${name}`.toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 40);
      taken.add(name);
      columns.push({ table: fresh.alias, column: c.name, name, label: heading(c.name) });
    }
  }
  const filters: any[] = [];
  for (let k = 0; k < DATASET_LIMITS.filters; k++) {
    const ref = String(b[`f${k}_col`] ?? '');
    if (!ref) continue;
    const [alias, ...rest] = ref.split('.');
    filters.push({ table: alias, column: rest.join('.'), op: b[`f${k}_op`], value: b[`f${k}_value`] ?? '' });
  }
  return { name: d.name, label: b.label, description: b.description, schema: d.schema, tables, columns, filters };
}

/** The first rows of a dataset, read only, through the SQL Workshop's connection (a timeout; errors as text). */
async function preview(db: Db, d: Dataset): Promise<{ fields: string[]; rows: unknown[][] } | { error: string }> {
  if (!d.columns.length) return { error: 'The dataset offers no columns.' };
  try {
    return await db.tx(async (c) => {
      await c.query('set transaction read only');
      await c.query(`set local statement_timeout = 5000`);
      const r = await c.query({ text: `select * from (${datasetSql(d)}) "__q" limit ${PREVIEW_ROWS}`, rowMode: 'array' });
      return { fields: r.fields.map((f) => f.name), rows: r.rows };
    });
  } catch (e) {
    return { error: (e as Error).message };
  }
}

const cellText = (v: unknown) => (v === null || v === undefined ? '' : v instanceof Date ? v.toISOString().slice(0, 19).replace('T', ' ') : typeof v === 'object' ? JSON.stringify(v) : String(v));

export async function datasetRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- the home: datasets and reporting applications
  app.get(root, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const ws = currentWorkspace(s);
    const sets = await workspaceDatasets(owner, ws);
    const apps = await reportingApps(ws);
    const main = html`<div class="title-row"><h1>Data Reporter</h1>
        <div class="buttons"><a class="btn btn-hot" href="${root}/datasets/new">${icon('plus')} New dataset</a><a class="btn" href="${root}/import">${icon('upload')} Import</a>${sets.length ? html`<a class="btn" href="${root}/export">${icon('download')} Export all</a>` : ''}</div></div>
      <p class="muted u-mt0">Datasets are trusted views of ${s.workspace?.name ?? 'this workspace'}'s data for business users: tables and views of one schema, joined, with the columns they may see, labels, format masks and descriptions, and a row filter. A reporting application on one or more datasets lets its users build, save, publish and share reports; every report runs as the application's database role, so grants and row level security apply.</p>
      ${region('Datasets', html`<div class="table-wrap"><table class="report report-reflow">
        <thead><tr><th scope="col">Dataset</th><th scope="col">Schema</th><th scope="col">Tables and views</th><th scope="col" class="num">Columns</th><th scope="col">Updated (UTC)</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${sets.length ? sets.map((d) => html`<tr>
          <td data-label="Dataset"><a href="${root}/datasets/${d.id}">${d.label}</a> <code>${d.name}</code>${d.description ? html`<br><span class="muted small">${d.description.slice(0, 160)}</span>` : ''}</td>
          <td data-label="Schema"><code>${d.schema_name}</code></td>
          <td data-label="Tables and views">${d.tables.map((t) => t.table).join(', ')}</td>
          <td class="num" data-label="Columns">${d.columns.length}</td>
          <td data-label="Updated (UTC)">${when(d.updated_at)}${d.updated_by ? html` <span class="muted">${d.updated_by}</span>` : ''}</td>
          <td data-label=""><a class="btn" href="${root}/apps/new?dataset=${encodeURIComponent(d.name)}">${icon('plus')} Create reporting application</a></td>
        </tr>`) : html`<tr><td colspan="6" class="empty">No datasets yet: create one on tables and views of a schema, or import a dataset file.</td></tr>`}</tbody></table></div>`)}
      ${region('Reporting applications', html`<div class="table-wrap"><table class="report report-reflow">
        <thead><tr><th scope="col">Application</th><th scope="col">Datasets</th><th scope="col" class="num">Users</th><th scope="col" class="num">Published reports</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${apps.length ? apps.map((a) => html`<tr>
          <td data-label="Application"><a href="${BASE}/apps/${a.id}">${a.name}</a> <code>${a.alias}</code></td>
          <td data-label="Datasets">${a.datasets.join(', ')}</td>
          <td class="num" data-label="Users">${a.users}</td>
          <td class="num" data-label="Published reports">${a.reports}</td>
          <td data-label=""><a class="btn" href="/a/${a.alias}/">${icon('play')} Run</a> <a class="btn" href="${BASE}/apps/${a.id}/shared">${icon('users')} Users and roles</a></td>
        </tr>`) : html`<tr><td colspan="5" class="empty">No reporting applications yet: choose Create reporting application on a dataset.</td></tr>`}</tbody></table></div>
        <p class="muted small">Roles: <b>viewer</b> runs published reports (every user with access), <b>editor</b> also builds, saves, publishes and unpublishes reports, <b>administrator</b> also unpublishes and deletes anyone's. Give accounts access and roles under Users and roles.</p>`)}`;
    return page(s, reply, 'Data Reporter', [], main);
  });

  // ---------------------------------------------------------------- a new dataset: schema, then tables and views
  app.get(`${root}/datasets/new`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const db = await workshopDb(s);
    const schemas = await usableSchemas(db);
    const schema = await usableSchema(db, String(req.query.schema ?? ''));
    const cat = schema ? await readSchemaCatalog(db, schema) : null;
    const main = html`<h1>New dataset</h1>
      ${region('1. Schema', html`<form method="get" action="${root}/datasets/new" class="search u-mwnone">
        <label class="label" for="f_schema">Schema</label>
        <select id="f_schema" name="schema">${schemas.map((n) => html`<option${n === schema ? raw(' selected') : ''}>${n}</option>`)}</select>
        <button class="btn">Show its tables and views</button></form>`)}
      ${cat ? region('2. Tables and views', html`<form method="post" action="${root}/datasets">${csrf(s)}<input type="hidden" name="schema" value="${schema}">
        <div class="form-grid">
          ${input('name', 'Name', '', { required: true, placeholder: 'e.g. sales', help: 'Lower case letters, digits and _ (at most 40): reports and files use it. It can\'t be changed later.' })}
          ${input('label', 'Label', '', { placeholder: 'e.g. Sales', help: 'What business users see.' })}
        </div>
        <fieldset class="prop-group"><legend>Tables and views (the first is the main one)</legend>
          ${cat.objects.length ? html`<div class="dataset-checks">${cat.objects.map((o) => html`<label class="check"><input type="checkbox" name="tables" value="${o.name}"> ${o.name} <span class="muted">${o.kind}, ${o.columns.length} columns</span></label>`)}</div>`
            : html`<p class="muted">The schema has no tables or views you may use.</p>`}
          <small class="help">Joins are proposed from foreign keys; every column is offered at first, labelled from its name. You change all of it on the next page.</small>
        </fieldset>
        <div class="buttons"><a class="btn" href="${root}">Cancel</a><button class="btn btn-hot">${icon('plus')} Create dataset</button></div></form>`) : ''}`;
    return page(s, reply, 'New dataset', [['New dataset']], main);
  });

  app.post(`${root}/datasets`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = req.body ?? {};
    const db = await workshopDb(s);
    const schema = await usableSchema(db, String(b.schema ?? ''));
    const name = String(b.name ?? '').trim().toLowerCase();
    const again = (msg: string) => (flash(s, msg, 'error'), back(reply, s, `${root}/datasets/new${schema ? `?schema=${encodeURIComponent(schema)}` : ''}`));
    if (!schema) return again('Choose one of the schemas in the list.');
    if (!DATASET_NAME.test(name)) return again(`"${name}" is not a valid dataset name: lower case letters, digits and _, starting with a letter (at most 40).`);
    const raw = (req.body as unknown as Record<string, unknown>)?.tables;
    const chosen = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(String);
    if (!chosen.length) return again('Choose at least one table or view.');
    const cat = await readSchemaCatalog(db, schema);
    const proposed = proposeDataset(name, String(b.label ?? '').trim(), schema, chosen, cat);
    const { dataset, errors } = checkDataset(proposed.dataset, catalogOf(cat.objects));
    if (errors.length || !dataset.tables.length) return again([...proposed.errors, ...errors].join(' ') || 'The dataset is not valid.');
    const exists = await owner.one('select 1 from meta.dataset where workspace_id = $1 and name = $2', [currentWorkspace(s), name]);
    if (exists) return again(`There is already a dataset ${name}.`);
    const id = await storeDataset(owner, currentWorkspace(s), dataset, s.username, { replace: false });
    logActivity({ appId: null, username: s.username, event: 'dataset_create', ip: clientIp(req), detail: `${name} on ${schema}` });
    flash(s, proposed.errors.length ? `Dataset ${name} created. ${proposed.errors.join(' ')}` : `Dataset ${name} created: check its columns and labels.`, proposed.errors.length ? 'error' : 'ok');
    return back(reply, s, `${root}/datasets/${id}`);
  });

  // ---------------------------------------------------------------- a dataset
  app.get(`${root}/datasets/:id`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const row = await datasetRow(s, req.params.id);
    if (!row) return reply.code(404).send('Not found');
    const d = datasetOf(row);
    const db = await workshopDb(s);
    const cat = await readSchemaCatalog(db, d.schema);
    const { errors } = checkDataset({ ...d }, catalogOf(cat.objects));
    const used = (await reportingApps(currentWorkspace(s))).filter((a) => a.datasets.includes(d.name));
    const objCols = (table: string) => cat.objects.find((o) => o.name === table)?.columns ?? [];
    // every column of the dataset's tables: the offered ones first (in their order), then the others
    const rows: { ref: string; alias: string; table: string; column: string; type: string; c?: Dataset['columns'][number] }[] = [];
    for (const c of d.columns) {
      const t = d.tables.find((x) => x.alias === c.table)!;
      rows.push({ ref: `${c.table}.${c.column}`, alias: c.table, table: t.table, column: c.column, type: objCols(t.table).find((x) => x.name === c.column)?.type ?? '', c });
    }
    for (const t of d.tables)
      for (const col of objCols(t.table))
        if (!d.columns.some((c) => c.table === t.alias && c.column === col.name)) rows.push({ ref: `${t.alias}.${col.name}`, alias: t.alias, table: t.table, column: col.name, type: col.type });
    const colOptions = d.tables.flatMap((t) => objCols(t.table).map((c): [string, string] => [`${t.alias}.${c.name}`, `${t.alias} ${t.table}.${c.name}`]));
    const shown = req.query.preview === '1' ? await preview(db, d) : null;
    const opt = (v: string, l: string, cur: string) => html`<option value="${v}"${v === cur ? raw(' selected') : ''}>${l}</option>`;
    const main = html`<div class="title-row"><h1>${d.label} <code>${d.name}</code></h1>
        <div class="buttons"><a class="btn" href="${root}/datasets/${row.id}/export">${icon('download')} Download</a><a class="btn btn-hot" href="${root}/apps/new?dataset=${encodeURIComponent(d.name)}">${icon('plus')} Create reporting application</a></div></div>
      <p class="muted u-mt0">On schema <code>${d.schema}</code>${used.length ? html` · used by ${used.map((a, i) => html`${i ? ', ' : ''}<a href="${BASE}/apps/${a.id}">${a.name}</a>`)}` : ''} · updated ${when(row.updated_at)} (UTC)${row.updated_by ? ` by ${row.updated_by}` : ''}</p>
      ${errors.length ? html`<div class="alert alert-error" role="alert"><b>The dataset doesn't match the database (any more):</b><ul>${errors.map((e) => html`<li>${e}</li>`)}</ul></div>` : ''}
      <form method="post" action="${root}/datasets/${row.id}">${csrf(s)}
      ${region('Dataset', html`<div class="form-grid">
        ${input('label', 'Label', d.label, { required: true })}
        <div class="field" data-wide><label class="label" for="f_description">Description (shown to users)</label><input id="f_description" name="description" maxlength="${DATASET_LIMITS.description}" value="${d.description ?? ''}"></div>
      </div>`)}
      ${region('Tables and views', html`<div class="table-wrap"><table class="report report-reflow">
        <thead><tr><th scope="col">Alias</th><th scope="col">Table or view</th><th scope="col">Joins to</th><th scope="col">Join</th><th scope="col">On (column = its column)</th><th scope="col">Remove</th></tr></thead><tbody>
        ${d.tables.map((t, i) => html`<tr>
          <td data-label="Alias"><code>${t.alias}</code><input type="hidden" name="t${i}_alias" value="${t.alias}"></td>
          <td data-label="Table or view"><code>${t.table}</code></td>
          ${i === 0 ? html`<td data-label="Joins to" colspan="3"><span class="muted">the main table</span></td>` : html`
          <td data-label="Joins to"><select name="t${i}_to" aria-label="${t.table} joins to">${d.tables.slice(0, i).map((x) => opt(x.alias, `${x.alias} ${x.table}`, t.join?.to ?? ''))}</select></td>
          <td data-label="Join"><select name="t${i}_type" aria-label="Join type of ${t.table}">${opt('left', 'Left (keep rows without a match)', t.join?.type ?? 'left')}${opt('inner', 'Inner (only matching rows)', t.join?.type ?? 'left')}</select></td>
          <td data-label="On"><input name="t${i}_on" value="${t.join?.on.map((p) => `${p.column} = ${p.ref}`).join(', ') ?? ''}" aria-label="Join columns of ${t.table}" placeholder="deptno = deptno"></td>`}
          <td data-label="Remove">${i === 0 ? '' : html`<input type="checkbox" name="t${i}_remove" value="true" aria-label="Remove ${t.table}">`}</td>
        </tr>`)}</tbody></table></div>
        ${d.tables.length < DATASET_LIMITS.tables ? html`<div class="form-grid">
          <div class="field"><label class="label" for="f_new_table">Add a table or view</label><select id="f_new_table" name="new_table"><option value="">- none -</option>${cat.objects.map((o) => html`<option value="${o.name}">${o.name} (${o.kind})</option>`)}</select></div>
          <div class="field"><label class="label" for="f_new_to">Joined to</label><select id="f_new_to" name="new_to">${d.tables.map((x) => opt(x.alias, `${x.alias} ${x.table}`, ''))}</select></div>
          <div class="field"><label class="label" for="f_new_on">On</label><input id="f_new_on" name="new_on" placeholder="from a foreign key"><small class="help">Empty: proposed from a foreign key.</small></div>
        </div>` : ''}`)}
      ${region('Columns', html`<p class="muted u-mt0">Business users see only the offered columns, under their labels. The name is how reports refer to a column: changing it breaks saved reports that use it.</p>
        <div class="table-wrap"><table class="report report-reflow dataset-columns">
        <thead><tr><th scope="col">Offer</th><th scope="col">Column</th><th scope="col">Name</th><th scope="col">Label</th><th scope="col">Format mask</th><th scope="col">Description</th></tr></thead><tbody>
        ${rows.map((r, j) => html`<tr>
          <td data-label="Offer"><input type="hidden" name="c${j}_ref" value="${r.ref}"><input type="checkbox" name="c${j}_on" value="true"${r.c ? raw(' checked') : ''} aria-label="Offer ${r.table}.${r.column}"></td>
          <td data-label="Column"><code>${r.alias}.${r.column}</code> <span class="muted">${r.type}</span></td>
          <td data-label="Name"><input name="c${j}_name" maxlength="40" value="${r.c?.name ?? r.column.toLowerCase()}" aria-label="Name of ${r.table}.${r.column}"></td>
          <td data-label="Label"><input name="c${j}_label" maxlength="${DATASET_LIMITS.label}" value="${r.c?.label ?? ''}" placeholder="${heading(r.column)}" aria-label="Label of ${r.table}.${r.column}"></td>
          <td data-label="Format mask"><input name="c${j}_format" maxlength="${DATASET_LIMITS.format}" value="${r.c?.format ?? ''}" placeholder="999G990D00" aria-label="Format mask of ${r.table}.${r.column}"></td>
          <td data-label="Description"><input name="c${j}_desc" maxlength="${DATASET_LIMITS.columnDescription}" value="${r.c?.description ?? ''}" aria-label="Description of ${r.table}.${r.column}"></td>
        </tr>`)}</tbody></table></div>`)}
      ${region('Row filter', html`<p class="muted u-mt0">Only rows that match every condition are in the dataset (on top of the application role's row level security).</p>
        ${Array.from({ length: DATASET_LIMITS.filters }, (_, k) => {
          const f = d.filters[k];
          return html`<div class="dataset-filter">
            <select name="f${k}_col" aria-label="Filter ${k + 1}: column">${opt('', '- none -', '')}${colOptions.map(([v, l]) => opt(v, l, f ? `${f.table}.${f.column}` : ''))}</select>
            <select name="f${k}_op" aria-label="Filter ${k + 1}: operator">${Object.keys(OPERATORS).map((o) => opt(o, opLabel(english, o), f?.op ?? 'eq'))}</select>
            <input name="f${k}_value" maxlength="${DATASET_LIMITS.value}" value="${f?.value ?? ''}" aria-label="Filter ${k + 1}: value" placeholder="value">
          </div>`;
        })}`)}
      <div class="buttons"><button class="btn btn-hot">${icon('save')} Save dataset</button></div>
      </form>
      ${region('Query and preview', html`<p class="muted u-mt0">The query reports run on (as the application's role). The preview runs it read only through your SQL Workshop connection.</p>
        <pre class="code" data-code-view="sql">${datasetSql(d)}</pre>
        <p><a class="btn" href="${root}/datasets/${row.id}?preview=1#preview">${icon('play')} Preview ${PREVIEW_ROWS} rows</a></p>
        ${shown ? 'error' in shown ? html`<div class="alert alert-error" role="alert" id="preview">${shown.error}</div>` : html`<div class="table-wrap" id="preview"><table class="report report-reflow"><thead><tr>${shown.fields.map((f) => html`<th scope="col">${d.columns.find((c) => c.name === f)?.label ?? f}</th>`)}</tr></thead>
          <tbody>${shown.rows.length ? shown.rows.map((r) => html`<tr>${r.map((v, i) => html`<td data-label="${shown.fields[i]}">${cellText(v)}</td>`)}</tr>`) : html`<tr><td colspan="${shown.fields.length}" class="empty">No rows.</td></tr>`}</tbody></table></div>` : ''}`)}
      ${region('Delete', html`<form method="post" action="${root}/datasets/${row.id}/delete">${csrf(s)}
        <p class="muted u-mt0">${used.length ? `Reporting applications using it (${used.map((a) => a.name).join(', ')}) lose this data source: their reports on it stop working.` : 'No reporting application uses it.'}</p>
        <button class="btn btn-danger" data-confirm="Delete the dataset ${d.name}?">${icon('trash')} Delete dataset</button></form>`)}`;
    return page(s, reply, d.label, [[d.label]], main);
  });

  app.post(`${root}/datasets/:id`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const row = await datasetRow(s, req.params.id);
    if (!row) return reply.code(404).send('Not found');
    const d = datasetOf(row);
    const db = await workshopDb(s);
    if (!(await usableSchema(db, d.schema))) {
      flash(s, `Your SQL Workshop connection may not use the schema ${d.schema}.`, 'error');
      return back(reply, s, `${root}/datasets/${row.id}`);
    }
    const cat = await readSchemaCatalog(db, d.schema);
    const { dataset, errors } = checkDataset(datasetFromForm(d, req.body ?? {}, cat), catalogOf(cat.objects));
    if (!dataset.tables.length || !dataset.columns.length) {
      flash(s, [...errors, 'A dataset needs a table and at least one offered column: nothing was saved.'].join(' '), 'error');
      return back(reply, s, `${root}/datasets/${row.id}`);
    }
    await storeDataset(owner, row.workspace_id, dataset, s.username);
    logActivity({ appId: null, username: s.username, event: 'dataset_save', ip: clientIp(req), detail: dataset.name });
    flash(s, errors.length ? `Saved, but: ${errors.join(' ')}` : 'Dataset saved.', errors.length ? 'error' : 'ok');
    return back(reply, s, `${root}/datasets/${row.id}`);
  });

  app.post(`${root}/datasets/:id/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const row = await datasetRow(s, req.params.id);
    if (!row) return reply.code(404).send('Not found');
    await owner.query('delete from meta.dataset where id = $1', [row.id]);
    logActivity({ appId: null, username: s.username, event: 'dataset_delete', ip: clientIp(req), detail: row.name });
    flash(s, `Dataset ${row.name} deleted.`);
    return back(reply, s, root);
  });

  // ---------------------------------------------------------------- files
  const download = (reply: FastifyReply, name: string, list: Dataset[]) =>
    reply.type('application/json').header('content-disposition', `attachment; filename="${name}.dataset.json"`).send(datasetFile(list));

  app.get(`${root}/datasets/:id/export`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const row = await datasetRow(s, req.params.id);
    if (!row) return reply.code(404).send('Not found');
    return download(reply, row.name, [datasetOf(row)]);
  });

  app.get(`${root}/export`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const list = (await workspaceDatasets(owner, currentWorkspace(s))).map(datasetOf);
    return download(reply, 'datasets', list);
  });

  app.get(`${root}/import`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const main = html`<h1>Import datasets</h1>
      ${region('A dataset file', html`<form method="post" action="${root}/import" enctype="multipart/form-data">${csrf(s)}
        <p class="muted u-mt0">A file downloaded from a Data Reporter (<code>*.dataset.json</code>, format pgkiln-dataset/1), with one dataset or several. Each is checked against this installation's database: its schema, tables, views and columns must exist here.</p>
        <div class="form-grid">
          <div class="field"><label class="label" for="f_file">File</label><input id="f_file" type="file" name="file" accept=".json,application/json"></div>
          <div class="field" data-wide><label class="label" for="f_text">Or paste it</label><textarea id="f_text" name="text" class="code" rows="5" spellcheck="false"></textarea></div>
          <div class="field"><label class="check"><input type="checkbox" name="replace" value="true"> Replace datasets with the same name</label></div>
        </div>
        <div class="buttons"><a class="btn" href="${root}">Cancel</a><button class="btn btn-hot">${icon('upload')} Import</button></div></form>`)}`;
    return page(s, reply, 'Import datasets', [['Import']], main);
  });

  app.post(`${root}/import`, async (req: Req, reply) => {
    // a multipart form: the session and CSRF token are checked after reading it
    let text = '';
    let tooLarge = false;
    if (req.isMultipart()) {
      const parsed = await readMultipart(req, MAX_FILE_BYTES / 1024 / 1024);
      req.body = parsed.body as Body;
      const f = parsed.files.get('file');
      if (f?.truncated) tooLarge = true;
      else if (f) text = f.data.toString('utf8');
    }
    const s = await developer(req, reply);
    if (!s) return;
    const fail = (msg: string) => (flash(s, msg, 'error'), back(reply, s, `${root}/import`));
    if (tooLarge) return fail('The file is larger than 2 MB.');
    if (!text.trim()) text = String(req.body?.text ?? '');
    if (!text.trim()) return fail('Choose a file or paste one.');
    let list: any[];
    try {
      list = readDatasetFile(text);
    } catch (e) {
      return fail((e as Error).message);
    }
    const db = await workshopDb(s);
    const schemas = await usableSchemas(db);
    const ws = currentWorkspace(s);
    const replace = req.body?.replace === 'true';
    const lines: string[] = [];
    try {
      await owner.tx(async (c) => {
        const cats = new Map<string, Awaited<ReturnType<typeof readSchemaCatalog>>>();
        for (const loose of list) {
          const schema = typeof loose?.schema === 'string' ? loose.schema : '';
          const name = typeof loose?.name === 'string' ? loose.name : '?';
          if (!schemas.includes(schema)) throw new Error(`Dataset ${name}: the schema "${schema}" doesn't exist here, or your SQL Workshop connection may not use it.`);
          if (!cats.has(schema)) cats.set(schema, await readSchemaCatalog(db, schema));
          const { dataset, errors } = checkDataset(loose, catalogOf(cats.get(schema)!.objects));
          if (errors.length || !dataset.columns.length) throw new Error(`Dataset ${name}: ${errors.join(' ') || 'it offers no columns.'}`);
          const exists = (await c.query('select 1 from meta.dataset where workspace_id = $1 and name = $2', [ws, dataset.name])).rowCount;
          if (exists && !replace) {
            lines.push(`${dataset.name}: kept (same name)`);
            continue;
          }
          await storeDataset(c, ws, dataset, s.username);
          lines.push(`${dataset.name}: ${exists ? 'replaced' : 'added'}`);
        }
      });
    } catch (e) {
      return fail(`Nothing was imported. ${(e as Error).message}`);
    }
    logActivity({ appId: null, username: s.username, event: 'dataset_import', ip: clientIp(req), detail: lines.join('; ') });
    flash(s, `Imported: ${lines.join('; ')}.`);
    return back(reply, s, root);
  });

  // ---------------------------------------------------------------- create a reporting application
  const appForm = async (s: Session, b: Body & { datasets?: string | string[] }, sets: DatasetRow[], error?: string) => {
    const chosen = new Set(Array.isArray(b.datasets) ? b.datasets : b.datasets ? [b.datasets] : []);
    return html`<h1>Create a reporting application</h1>
      ${error ? html`<div class="alert alert-error" role="alert">${error}</div>` : ''}
      <form method="post" action="${root}/apps">${csrf(s)}
      ${region('Application', html`<div class="form-grid">
        ${input('name', 'Name', b.name ?? '', { required: true })}
        ${input('alias', 'Alias', b.alias ?? '', { required: true, help: 'Its address: /a/<alias>. Its database role is app_<alias>, which may only read the datasets\' tables and views.' })}
        ${input('admin_user', 'First administrator', b.admin_user ?? s.username ?? '', { required: true, help: 'An account of the user directory (users sign in with their workspace accounts).' })}
        ${input('admin_password', 'Password', '', { type: 'password', auto: 'new-password', help: 'Only for a new account.' })}
      </div>`)}
      ${region('Datasets', html`<div class="dataset-checks">${sets.map((d) => html`<label class="check"><input type="checkbox" name="datasets" value="${d.name}"${chosen.has(d.name) ? raw(' checked') : ''}> ${d.label} <code>${d.name}</code> <span class="muted">${d.schema_name}: ${d.tables.map((t) => t.table).join(', ')}</span></label>`)}</div>
        <small class="help">The first dataset's schema is the application's parsing schema.</small>`)}
      <div class="buttons"><a class="btn" href="${root}">Cancel</a><button class="btn btn-hot">${icon('plus')} Create</button></div></form>`;
  };

  app.get(`${root}/apps/new`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const sets = await workspaceDatasets(owner, currentWorkspace(s));
    if (!sets.length) {
      flash(s, 'Create a dataset first.', 'error');
      return back(reply, s, root);
    }
    const first = sets.find((d) => d.name === req.query.dataset) ?? sets[0];
    const base = first.name.replace(/_/g, '-').slice(0, 40);
    return page(s, reply, 'Create reporting application', [['Create reporting application']],
      await appForm(s, { name: `${first.label} reports`, alias: `${base}-reports`, datasets: first.name }, sets));
  });

  app.post(`${root}/apps`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = (req.body ?? {}) as Body & { datasets?: string | string[] };
    const sets = await workspaceDatasets(owner, currentWorkspace(s));
    const names = Array.isArray(b.datasets) ? b.datasets : b.datasets ? [b.datasets] : [];
    const chosen = names.map((n) => sets.find((d) => d.name === n)).filter((d): d is DatasetRow => !!d);
    const failed = async (msg: string) => {
      reply.code(422);
      return page(s, reply, 'Create reporting application', [['Create reporting application']], await appForm(s, b, sets, msg));
    };
    if (!chosen.length) return failed('Choose at least one dataset.');
    if (chosen.length > MAX_REPORTING_DATASETS) return failed(`Choose at most ${MAX_REPORTING_DATASETS} datasets.`);
    let created: { id: number; existingAccount: boolean };
    let alias = '';
    try {
      const checked = await checkNewApp({ name: b.name, alias: b.alias, schema: chosen[0].schema_name, authentication: 'app_users', admin_user: b.admin_user, admin_password: b.admin_password }, currentWorkspace(s));
      alias = checked.alias;
      created = await owner.tx((c) => createReportingApp(c, checked, chosen));
    } catch (e) {
      return failed(createAppError(e, alias || String(b.alias ?? '')));
    }
    logActivity({ appId: created.id, username: s.username, event: 'app_create', ip: clientIp(req), detail: `reporting application on ${chosen.map((d) => d.name).join(', ')}` });
    flash(s, `Reporting application ${b.name} created: run it at /a/${alias}/, and give accounts access and the roles viewer, editor or administrator under Users and roles.`);
    return back(reply, s, root);
  });
}
