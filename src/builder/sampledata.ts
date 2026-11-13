import type { FastifyInstance, FastifyReply } from 'fastify';
import { rlsHint } from './rls-hint.ts';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import {
  allowedSchema,
  cleanDef,
  csvDownload,
  describe,
  fileName,
  generateAll,
  GENERATORS,
  insertRows,
  MAX_ROWS,
  MAX_TABLES,
  nextValues,
  OPTION_HELP,
  plan,
  PREVIEW_ROWS,
  randomSeed,
  SampleDataError,
  schemas,
  schemaTables,
  sqlScript,
  tableSpec,
  type ColumnInfo,
  type GeneratorDef,
  type RunResult,
  type TableInfo,
  type TableSpec,
} from '../sampledata.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import { back, BASE, csrf, developer, flash, region, send, shell, workshopTabs, type Body, type Req } from './ui.ts';
import { currentWorkspace, workshopDb } from './workspaces.ts';
import { tr, type BuilderTranslate } from './i18n.ts';

// SQL Workshop → Sample Data (APEX 26.1: Data Generator): generate realistic
// rows for one or more tables of a schema (src/sampledata.ts). Step 1 picks a
// schema, step 2 its tables (GET forms), step 3 is the generator form: rows
// per table, and per column a generator, its options and a percentage of
// nulls, all proposed from the catalog. The form posts (CSRF) to preview
// (insert and roll back), insert (one transaction, parents first), download
// as SQL or CSV, or save the definition (meta.data_generator) to rerun.
// Runs on a connection of its own as the owner, like the SQL Worksheet, with a
// statement timeout; the connection is closed afterwards. No JavaScript needed.

/** The statement timeout of a run (PostgreSQL interval syntax). */
const timeout = () => process.env.SAMPLE_DATA_STATEMENT_TIMEOUT || '5min';
const DEFAULT_ROWS = 20;

const list = (v: unknown) => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v]).map(String);
const sdUrl = `${BASE}/sql/sample-data`;

interface Saved {
  id: number;
  name: string;
  description: string | null;
  schema_name: string;
  seed: string | null;
  tables: TableSpec[];
}

async function saved(s: Session, id: unknown) {
  if (!/^\d{1,9}$/.test(String(id ?? ''))) return undefined;
  return owner.one<Saved>('select * from meta.data_generator where id = $1 and workspace_id = $2', [id, currentWorkspace(s)]);
}

/** The definition posted by the generator form (never trusted: plan() checks it against the catalog). */
export function defFromBody(b: Body): GeneratorDef {
  const tables = list(b.t).slice(0, MAX_TABLES);
  return cleanDef({
    schema: b.schema ?? '',
    seed: (b.seed ?? '').trim(),
    tables: tables.map((table, i) => {
      const columns = [];
      for (let j = 0; j < 2000 && b[`c_${i}_${j}`] !== undefined; j++)
        columns.push({ column: b[`c_${i}_${j}`], generator: b[`g_${i}_${j}`], options: b[`o_${i}_${j}`] ?? '', nulls: b[`n_${i}_${j}`] ?? '0' });
      return { table, rows: (b[`rows_${i}`] ?? '').trim() === '' ? NaN : Number(b[`rows_${i}`]), columns };
    }),
  });
}

/** What the generator form shows next to a column: its type and the constraints that matter. */
function notes(c: ColumnInfo) {
  const n: string[] = [c.type];
  if (c.auto) n.push(c.auto === 'identity' ? `identity${c.noInsert ? ' (always)' : ''}` : c.auto === 'generated' ? 'generated column' : 'serial');
  if (c.notNull) n.push('not null');
  if (c.unique) n.push('unique');
  if (c.fk) n.push(`→ ${c.fk.refSchema}.${c.fk.refTable}(${c.fk.refColumns.join(', ')})`);
  if (c.default && !c.auto) n.push(`default ${c.default.length > 40 ? `${c.default.slice(0, 40)}…` : c.default}`);
  if (c.min !== null || c.max !== null) n.push(`check ${c.min ?? ''}..${c.max ?? ''}`);
  if (c.after) n.push(`check ≥ ${c.after.column}`);
  return n.join(' · ');
}

/** (sprint 162) a generator's name and its options' help in the builder's language (sd.gen.<kind>, sd.opt.<kind>) */
const genLabel = (tx: BuilderTranslate, k: string, label: string) => tx.dyn(`sd.gen.${k}`, label);
const generatorHelp = (tx: BuilderTranslate) => html`<details class="sd-help u-mt1"><summary>${tx('sd.help')}</summary>
  <dl class="sd-help-list">${Object.entries(GENERATORS).map(
    ([k, label]) => html`<dt>${genLabel(tx, k, label)}</dt><dd>${tx.dyn(`sd.opt.${k}`, OPTION_HELP[k as keyof typeof GENERATORS] ?? (k === 'foreign_key' ? 'a random existing parent row; parents generated in the same run are inserted first' : k === 'skip' ? 'not inserted: the column default, identity or null' : 'no options'))}</dd>`,
  )}</dl></details>`;

export async function sampleDataRoutes(app: FastifyInstance) {
  const page = (s: Session, reply: FastifyReply, title: string, main: Raw, code = 200) => {
    reply.code(code);
    const tx = tr(s);
    const home = tx('sql.tool.sample');
    return send(
      reply,
      s,
      shell(s, title, [[tx('rail.sql_workshop'), `${BASE}/sql`], [home, title === home ? undefined : sdUrl], ...(title === home ? [] : ([[title]] as [string][]))], html`<h1 class="u-mb1">${tx('rail.sql_workshop')}</h1>${workshopTabs('sample', s)}${main}`, 'sql'),
    );
  };

  const introOf = (tx: BuilderTranslate) => html`<p class="muted">${tx.rich('sd.intro', { worksheet: html`<a href="${BASE}/sql/worksheet">${tx('sql.tool.worksheet')}</a>` })}</p>`;

  // ------------------------------------------------------------ step 1 and 2: schema and tables
  const start = async (s: Session, reply: FastifyReply, schema: string | undefined) => {
    const db = await workshopDb(s);
    const tx = tr(s);
    const all = (await schemas(db.pool)).filter((x) => db === owner || x.usable);
    const gens = (await owner.query<Saved & { updated_at: string; updated_by: string }>('select id, name, description, schema_name, tables, updated_at, updated_by from meta.data_generator where workspace_id = $1 order by lower(name)', [currentWorkspace(s)])).rows;
    const savedList = gens.length
      ? html`<ul class="sd-saved">${gens.map(
          (g) => html`<li><a href="${sdUrl}/${g.id}">${g.name}</a> <span class="muted small">${g.schema_name}: ${g.tables.map((t) => `${t.table} (${t.rows})`).join(', ')}</span>
            ${g.description ? html`<br><span class="muted small">${g.description}</span>` : ''}</li>`,
        )}</ul>`
      : html`<p class="muted">${tx('sd.none_saved')}</p>`;
    const chosen = schema && allowedSchema(schema) && all.some((x) => x.name === schema) ? schema : '';
    const schemaForm = html`<form method="get" action="${sdUrl}" class="unload-pick">
        <label class="label" for="f_schema">${tx('sm.schema')}</label>
        <select id="f_schema" name="schema" required><option value="">${tx('ddl.choose_schema')}</option>${all.map(
          (x) => html`<option value="${x.name}"${x.name === chosen ? raw(' selected') : ''}>${x.name} (${x.tables === 1 ? tx('sd.table_one') : tx('sd.tables_n', { n: x.tables })})</option>`,
        )}</select>
        <button class="btn">${tx('ul.choose')}</button></form>`;
    let tablesForm: Raw | '' = '';
    if (chosen) {
      const tables = await schemaTables(db.pool, chosen);
      tablesForm = html`<form method="get" action="${sdUrl}" class="u-mt1"><input type="hidden" name="schema" value="${chosen}">
        <fieldset class="prop-group"><legend>${tx('sd.tables_of', { schema: chosen })}</legend><div class="qb-pick">${tables.map(
          (t) => html`<label class="check"><input type="checkbox" name="t" value="${t.name}"> ${t.name} <span class="muted small">${t.estimate >= 0 ? tx('sd.about_rows', { n: t.estimate.toLocaleString('en') }) : ''}</span></label>`,
        )}</div></fieldset>
        <div class="buttons"><button class="btn btn-hot">${icon('layers')} ${tx('sd.propose')}</button></div></form>`;
    } else if (schema) tablesForm = html`<div class="alert alert-error" role="alert">${tx('sd.own_schema')}</div>`;
    return page(
      s,
      reply,
      tx('sql.tool.sample'),
      html`${introOf(tx)}${region(tx('sd.new'), html`${schemaForm}${tablesForm}`)}<div class="u-spacer"></div>${region(tx('sd.saved_title'), savedList, html`<span class="count">${gens.length}</span>`)}`,
    );
  };

  // ------------------------------------------------------------ step 3: the generator form
  interface FormState {
    def: GeneratorDef;
    id?: number;
    name?: string;
    description?: string;
    error?: string;
    result?: Raw;
  }

  /** The tables of a definition with their catalog info; specs proposed for columns the definition doesn't mention. */
  const describeAll = async (s: Session, def: GeneratorDef) => {
    const db = (await workshopDb(s)).pool;
    const out: { info: TableInfo; spec: TableSpec }[] = [];
    const missing: string[] = [];
    for (const t of def.tables) {
      const info = await describe(db, def.schema, t.table);
      if (!info) {
        missing.push(t.table);
        continue;
      }
      const spec = tableSpec(info, DEFAULT_ROWS, t, undefined, await nextValues(db, info));
      out.push({ info, spec: { ...spec, rows: Number.isInteger(t.rows) ? t.rows : DEFAULT_ROWS } });
    }
    return { tables: out, missing };
  };

  const editor = async (s: Session, reply: FastifyReply, st: FormState, code = 200) => {
    const { tables, missing } = await describeAll(s, st.def);
    const tx = tr(s);
    const title = st.id ? (st.name ?? tx('sd.generator')) : tx('sd.new');
    const columnRow = (i: number, j: number, c: ColumnInfo, spec: TableSpec) => {
      const cs = spec.columns.find((x) => x.column === c.name)!;
      const id = `${i}_${j}`;
      return html`<div class="sd-col">
        <div class="sd-col-name"><strong>${c.name}</strong><span class="muted small">${notes(c)}</span><input type="hidden" name="c_${id}" value="${c.name}"></div>
        <div class="sd-col-gen"><select name="g_${id}" aria-label="${tx('sd.col_generator', { column: c.name })}">${Object.entries(GENERATORS).map(
          ([k, label]) => html`<option value="${k}"${cs.generator === k ? raw(' selected') : ''}>${genLabel(tx, k, label)}</option>`,
        )}</select></div>
        <div class="sd-col-opt"><input name="o_${id}" value="${cs.options}" maxlength="4000" aria-label="${tx('sd.col_options', { column: c.name })}" placeholder="${tx('sd.options')}" spellcheck="false"></div>
        <div class="sd-col-nulls"><input type="number" name="n_${id}" value="${cs.nulls}" min="0" max="100" step="1" aria-label="${tx('sd.col_nulls', { column: c.name })}"><span class="muted small" aria-hidden="true">${tx('sd.pct_null')}</span></div>
      </div>`;
    };
    const tableRegions = tables.map(
      ({ info, spec }, i) => html`<fieldset class="prop-group sd-table"><legend>${info.schema}.${info.name}</legend>
        <input type="hidden" name="t" value="${info.name}">
        <div class="field sd-rows"><label class="label" for="f_rows_${i}">${tx('sm.col.rows')}</label>
          <input type="number" id="f_rows_${i}" name="rows_${i}" value="${spec.rows}" min="0" max="${MAX_ROWS()}" step="1" required></div>
        <div class="sd-cols">${info.columns.map((c, j) => columnRow(i, j, c, spec))}</div></fieldset>`,
    );
    const tablesLink = `${sdUrl}?schema=${encodeURIComponent(st.def.schema)}`;
    // (sprint 186) row level security or a grant refused the developer login's insert: why, and what to do
    const hint = await rlsHint(s, sdUrl, [st.error]);
    const form = html`<form method="post" action="${sdUrl}">${csrf(s)}
        <input type="hidden" name="schema" value="${st.def.schema}">${st.id ? html`<input type="hidden" name="id" value="${st.id}">` : ''}
        ${st.error ? html`<div class="alert alert-error" role="alert">${st.error}</div>${hint}` : ''}
        ${missing.length ? html`<div class="alert alert-note">${tx('sd.missing', { tables: missing.join(', ') })}</div>` : ''}
        <div class="form-grid">
          <div class="field"><label class="label" for="f_seed">${tx('sd.seed')}</label>
            <input type="number" id="f_seed" name="seed" value="${st.def.seed ?? ''}" min="0" max="4294967295" step="1">
            <small class="help">${tx('sd.seed_help')}</small></div>
          <div class="field"><span class="label">${tx('sm.schema')}</span><p>${st.def.schema} <a class="small" href="${tablesLink}">${tx('sd.change_tables')}</a></p></div>
        </div>
        ${tableRegions}
        ${generatorHelp(tx)}
        <div class="buttons u-mt1">
          <button class="btn" name="action" value="preview">${icon('search')} ${tx('sd.preview')}</button>
          <button class="btn btn-hot" name="action" value="insert">${icon('play')} ${tx('sd.insert')}</button>
          <button class="btn" name="action" value="sql">${icon('download')} ${tx('sd.download_sql')}</button>
          <button class="btn" name="action" value="csv">${icon('download')} ${tx('sd.download_csv')}</button></div>
        <fieldset class="prop-group u-mt1"><legend>${tx('sd.save_def')}</legend><div class="form-grid">
          <div class="field"><label class="label" for="f_name">${tx('scr.name')}</label><input id="f_name" name="name" value="${st.name ?? ''}" maxlength="100"></div>
          <div class="field"><label class="label" for="f_description">${tx('scr.description')}</label><input id="f_description" name="description" value="${st.description ?? ''}" maxlength="1000"></div>
        </div><div class="buttons"><button class="btn" name="action" value="save">${icon('check')} ${st.id ? tx('scr.save') : tx('sd.save_new')}</button></div></fieldset>
      </form>`;
    const del = st.id
      ? html`<form method="post" action="${sdUrl}/${st.id}/delete" class="danger-zone">${csrf(s)}<button class="btn btn-danger" data-confirm="${tx('sd.delete_confirm')}">${tx('sd.delete')}</button></form>`
      : '';
    return page(s, reply, title, html`${introOf(tx)}${st.result ? html`${st.result}<div class="u-spacer"></div>` : ''}${region(title, html`${form}${del}`)}`, code);
  };

  const sampleTable = (columns: string[], rows: (string | null)[][]) =>
    html`<div class="table-wrap"><table class="report"><thead><tr>${columns.map((c) => html`<th>${c}</th>`)}</tr></thead>
      <tbody>${rows.map((r) => html`<tr>${r.map((v) => html`<td>${v === null ? html`<span class="null">null</span>` : v.length > 200 ? `${v.slice(0, 200)}…` : v}</td>`)}</tr>`)}</tbody></table></div>`;

  const resultHtml = (tx: BuilderTranslate, r: RunResult, committed: boolean) => {
    const counts = r.tables.map((t) => `${t.table}: ${tx('scr.rows', { n: t.rows })}`).join(', ');
    return region(
      committed ? tx('sd.inserted') : tx('sd.preview'),
      html`<div class="alert ${committed ? 'alert-success' : 'alert-note'}" role="status">
          ${committed ? tx('sd.inserted_counts', { counts, seed: r.seed }) : html`${counts}. <strong>${tx('sd.rolled_back')}</strong> (${tx('sd.seed_is', { seed: r.seed })}).`}</div>
        ${r.tables.map((t) => html`<h3 class="u-mt1">${t.table} <span class="muted small">${t.rows > PREVIEW_ROWS ? tx('sd.first_of', { shown: PREVIEW_ROWS, n: t.rows }) : ''}</span></h3>${t.rows ? sampleTable(t.columns, t.sample) : html`<p class="muted">${tx('sd.no_rows')}</p>`}`)}`,
    );
  };

  // ------------------------------------------------------------ routes
  app.get(sdUrl, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const q = req.query as Record<string, unknown>;
    const tables = list(q.t);
    if (!q.schema || !tables.length || !allowedSchema(String(q.schema))) return start(s, reply, q.schema ? String(q.schema) : undefined);
    return editor(s, reply, { def: cleanDef({ schema: String(q.schema), seed: null, tables: tables.map((table) => ({ table, rows: DEFAULT_ROWS, columns: [] })) }) });
  });

  app.get(`${sdUrl}/:id`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const g = await saved(s, req.params.id);
    if (!g) return reply.code(404).send('Not found');
    return editor(s, reply, { id: g.id, name: g.name, description: g.description ?? '', def: cleanDef({ schema: g.schema_name, seed: g.seed, tables: g.tables }) });
  });

  app.post(sdUrl, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = req.body ?? {};
    const def = defFromBody(b);
    const g = b.id ? await saved(s, b.id) : undefined;
    if (b.id && !g) return reply.code(404).send('Not found');
    const st: FormState = { def, id: g?.id, name: (b.name ?? '').trim(), description: (b.description ?? '').trim() };
    const refuse = (error: string) => editor(s, reply, { ...st, error }, 422);
    const action = b.action ?? 'preview';

    if (action === 'save') {
      if (!st.name) return refuse(tr(s)('sd.err.name'));
      if (st.name.length > 100 || (st.description ?? '').length > 1000) return refuse(tr(s)('sd.err.length'));
      if (!allowedSchema(def.schema)) return refuse(tr(s)('sd.own_schema'));
      const { tables } = await describeAll(s, def);
      if (!tables.length) return refuse(tr(s)('sd.err.table'));
      const json = JSON.stringify(tables.map(({ spec }) => spec));
      try {
        const id = g
          ? (await owner.one('update meta.data_generator set name = $2, description = $3, schema_name = $4, seed = $5, tables = $6, updated_by = $7, updated_at = now() where id = $1 returning id', [g.id, st.name, st.description || null, def.schema, def.seed, json, s.username])).id
          : (await owner.one('insert into meta.data_generator (name, description, schema_name, seed, tables, created_by, updated_by, workspace_id) values ($1, $2, $3, $4, $5, $6, $6, $7) returning id', [st.name, st.description || null, def.schema, def.seed, json, s.username, currentWorkspace(s)])).id;
        flash(s, tr(s)('sd.saved', { name: st.name }));
        return back(reply, s, `${sdUrl}/${id}`);
      } catch (e) {
        if ((e as { code?: string }).code === '23505') return refuse(`A generator named ${st.name} exists already.`);
        throw e;
      }
    }
    if (!['preview', 'insert', 'sql', 'csv'].includes(action)) return refuse(tr(s)('sd.err.action'));

    const db = await workshopDb(s);
    const p = await plan(db.pool, def);
    if (p.problems.length) return refuse(p.problems.join(' '));
    const seed = def.seed ?? randomSeed();
    st.def = { ...def, seed };

    if (action === 'sql' || action === 'csv') {
      let generated;
      try {
        generated = await generateAll(db.pool, p.tables, seed);
      } catch (e) {
        if (e instanceof SampleDataError) return refuse(e.message);
        throw e;
      }
      if (action === 'sql') {
        const name = st.name || 'sample-data';
        return reply
          .header('content-disposition', `attachment; filename="${fileName(name)}.sql"`)
          .header('cache-control', 'private, no-store')
          .type('application/sql; charset=utf-8')
          .send(sqlScript(st.def, seed, generated, name));
      }
      const file = csvDownload(generated);
      return reply.header('content-disposition', `attachment; filename="${file.name}"`).header('cache-control', 'private, no-store').type(file.type).send(file.body);
    }

    // preview and insert: the same run, rolled back or committed
    const started = performance.now();
    const c = await db.pool.connect();
    let result: RunResult;
    try {
      await c.query('begin');
      await c.query(`select set_config('statement_timeout', $1, true)`, [timeout()]);
      result = await insertRows(c, p.tables, seed);
      await c.query(action === 'insert' ? 'commit' : 'rollback');
    } catch (e) {
      await c.query('rollback').catch(() => {});
      const err = e as { message: string; detail?: string; table?: string };
      return refuse(
        `${action === 'insert' ? `${tr(s)('sd.nothing_inserted')} ` : ''}${err.table ? `${err.table}: ` : ''}${err.message}${err.detail ? ` (${err.detail})` : ''}`,
      );
    } finally {
      // a connection of its own, closed: triggers may have changed settings
      c.release(true);
    }
    if (action === 'insert')
      await logActivity({
        username: s.username,
        event: 'sample_data',
        ip: clientIp(req),
        elapsedMs: Math.round(performance.now() - started),
        detail: `${def.schema}, seed ${seed}: ${result.tables.map((t) => `${t.table} ${t.rows}`).join(', ')}`.slice(0, 2000),
      });
    return editor(s, reply, { ...st, result: resultHtml(tr(s), result, action === 'insert') });
  });

  app.post(`${sdUrl}/:id/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const g = await saved(s, req.params.id);
    if (!g) return reply.code(404).send('Not found');
    await owner.query('delete from meta.data_generator where id = $1', [g.id]);
    flash(s, tr(s)('sd.deleted', { name: g.name }));
    return back(reply, s, sdUrl);
  });
}
