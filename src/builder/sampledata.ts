import type { FastifyInstance, FastifyReply } from 'fastify';
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

// SQL Workshop → Sample Data (APEX 26.1: Data Generator): generate realistic
// rows for one or more tables of a schema (src/sampledata.ts). Step 1 picks a
// schema, step 2 its tables (GET forms), step 3 is the generator form: rows
// per table, and per column a generator, its options and a percentage of
// nulls, all proposed from the catalog. The form posts (CSRF) to preview
// (insert and roll back), insert (one transaction, parents first), download
// as SQL or CSV, or save the definition (meta.data_generator) to rerun.
// Runs on a connection of its own as the owner, like SQL Commands, with a
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

async function saved(id: unknown) {
  if (!/^\d{1,9}$/.test(String(id ?? ''))) return undefined;
  return owner.one<Saved>('select * from meta.data_generator where id = $1', [id]);
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

const generatorHelp = html`<details class="sd-help u-mt1"><summary>Generators and their options</summary>
  <dl class="sd-help-list">${Object.entries(GENERATORS).map(
    ([k, label]) => html`<dt>${label}</dt><dd>${OPTION_HELP[k as keyof typeof GENERATORS] ?? (k === 'foreign_key' ? 'a random existing parent row; parents generated in the same run are inserted first' : k === 'skip' ? 'not inserted: the column default, identity or null' : 'no options')}</dd>`,
  )}</dl></details>`;

export async function sampleDataRoutes(app: FastifyInstance) {
  const page = (s: Session, reply: FastifyReply, title: string, main: Raw, code = 200) => {
    reply.code(code);
    return send(
      reply,
      s,
      shell(s, title, [['SQL Workshop', `${BASE}/sql`], ['Sample Data', title === 'Sample Data' ? undefined : sdUrl], ...(title === 'Sample Data' ? [] : ([[title]] as [string][]))], html`<h1 class="u-mb1">SQL Workshop</h1>${workshopTabs('sample')}${main}`, 'sql'),
    );
  };

  const intro = html`<p class="muted">Generate realistic rows for the tables of a schema: names, e-mail addresses, dates and numbers in a range, values from a list,
    foreign keys that pick existing parent rows. Preview them, insert them in one transaction (parents first) or download them as SQL or CSV.
    Runs as the builder's owner connection, like <a href="${BASE}/sql">SQL Commands</a>.</p>`;

  // ------------------------------------------------------------ step 1 and 2: schema and tables
  const start = async (s: Session, reply: FastifyReply, schema: string | undefined) => {
    const all = await schemas(owner.pool);
    const gens = (await owner.query<Saved & { updated_at: string; updated_by: string }>('select id, name, description, schema_name, tables, updated_at, updated_by from meta.data_generator order by lower(name)')).rows;
    const savedList = gens.length
      ? html`<ul class="sd-saved">${gens.map(
          (g) => html`<li><a href="${sdUrl}/${g.id}">${g.name}</a> <span class="muted small">${g.schema_name}: ${g.tables.map((t) => `${t.table} (${t.rows})`).join(', ')}</span>
            ${g.description ? html`<br><span class="muted small">${g.description}</span>` : ''}</li>`,
        )}</ul>`
      : html`<p class="muted">No saved generators yet: generate rows below, then save the definition to run it again.</p>`;
    const chosen = schema && allowedSchema(schema) && all.some((x) => x.name === schema) ? schema : '';
    const schemaForm = html`<form method="get" action="${sdUrl}" class="unload-pick">
        <label class="label" for="f_schema">Schema</label>
        <select id="f_schema" name="schema" required><option value="">- choose a schema -</option>${all.map(
          (x) => html`<option value="${x.name}"${x.name === chosen ? raw(' selected') : ''}>${x.name} (${x.tables} table${x.tables === 1 ? '' : 's'})</option>`,
        )}</select>
        <button class="btn">Choose</button></form>`;
    let tablesForm: Raw | '' = '';
    if (chosen) {
      const tables = await schemaTables(owner.pool, chosen);
      tablesForm = html`<form method="get" action="${sdUrl}" class="u-mt1"><input type="hidden" name="schema" value="${chosen}">
        <fieldset class="prop-group"><legend>Tables of ${chosen}</legend><div class="qb-pick">${tables.map(
          (t) => html`<label class="check"><input type="checkbox" name="t" value="${t.name}"> ${t.name} <span class="muted small">${t.estimate >= 0 ? `~${t.estimate.toLocaleString('en')} rows` : ''}</span></label>`,
        )}</div></fieldset>
        <div class="buttons"><button class="btn btn-hot">${icon('layers')} Propose generators</button></div></form>`;
    } else if (schema) tablesForm = html`<div class="alert alert-error" role="alert">Choose a schema of your own: not meta, information_schema or pg_*.</div>`;
    return page(
      s,
      reply,
      'Sample Data',
      html`${intro}${region('New generator', html`${schemaForm}${tablesForm}`)}<div class="u-spacer"></div>${region('Saved generators', savedList, html`<span class="count">${gens.length}</span>`)}`,
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
  const describeAll = async (def: GeneratorDef) => {
    const out: { info: TableInfo; spec: TableSpec }[] = [];
    const missing: string[] = [];
    for (const t of def.tables) {
      const info = await describe(owner.pool, def.schema, t.table);
      if (!info) {
        missing.push(t.table);
        continue;
      }
      const spec = tableSpec(info, DEFAULT_ROWS, t, undefined, await nextValues(owner.pool, info));
      out.push({ info, spec: { ...spec, rows: Number.isInteger(t.rows) ? t.rows : DEFAULT_ROWS } });
    }
    return { tables: out, missing };
  };

  const editor = async (s: Session, reply: FastifyReply, st: FormState, code = 200) => {
    const { tables, missing } = await describeAll(st.def);
    const title = st.id ? (st.name ?? 'Generator') : 'New generator';
    const columnRow = (i: number, j: number, c: ColumnInfo, spec: TableSpec) => {
      const cs = spec.columns.find((x) => x.column === c.name)!;
      const id = `${i}_${j}`;
      return html`<div class="sd-col">
        <div class="sd-col-name"><strong>${c.name}</strong><span class="muted small">${notes(c)}</span><input type="hidden" name="c_${id}" value="${c.name}"></div>
        <div class="sd-col-gen"><select name="g_${id}" aria-label="${c.name}: generator">${Object.entries(GENERATORS).map(
          ([k, label]) => html`<option value="${k}"${cs.generator === k ? raw(' selected') : ''}>${label}</option>`,
        )}</select></div>
        <div class="sd-col-opt"><input name="o_${id}" value="${cs.options}" maxlength="4000" aria-label="${c.name}: options" placeholder="options" spellcheck="false"></div>
        <div class="sd-col-nulls"><input type="number" name="n_${id}" value="${cs.nulls}" min="0" max="100" step="1" aria-label="${c.name}: % nulls"><span class="muted small" aria-hidden="true">% null</span></div>
      </div>`;
    };
    const tableRegions = tables.map(
      ({ info, spec }, i) => html`<fieldset class="prop-group sd-table"><legend>${info.schema}.${info.name}</legend>
        <input type="hidden" name="t" value="${info.name}">
        <div class="field sd-rows"><label class="label" for="f_rows_${i}">Rows</label>
          <input type="number" id="f_rows_${i}" name="rows_${i}" value="${spec.rows}" min="0" max="${MAX_ROWS()}" step="1" required></div>
        <div class="sd-cols">${info.columns.map((c, j) => columnRow(i, j, c, spec))}</div></fieldset>`,
    );
    const tablesLink = `${sdUrl}?schema=${encodeURIComponent(st.def.schema)}`;
    const form = html`<form method="post" action="${sdUrl}">${csrf(s)}
        <input type="hidden" name="schema" value="${st.def.schema}">${st.id ? html`<input type="hidden" name="id" value="${st.id}">` : ''}
        ${st.error ? html`<div class="alert alert-error" role="alert">${st.error}</div>` : ''}
        ${missing.length ? html`<div class="alert alert-note">Not found any more, left out: ${missing.join(', ')}.</div>` : ''}
        <div class="form-grid">
          <div class="field"><label class="label" for="f_seed">Seed</label>
            <input type="number" id="f_seed" name="seed" value="${st.def.seed ?? ''}" min="0" max="4294967295" step="1">
            <small class="help">The same seed gives the same rows (for the same tables and parent rows). Empty: a new seed each run; a preview fills it in, so Insert then adds the rows you saw.</small></div>
          <div class="field"><span class="label">Schema</span><p>${st.def.schema} <a class="small" href="${tablesLink}">change tables</a></p></div>
        </div>
        ${tableRegions}
        ${generatorHelp}
        <div class="buttons u-mt1">
          <button class="btn" name="action" value="preview">${icon('search')} Preview</button>
          <button class="btn btn-hot" name="action" value="insert">${icon('play')} Insert rows</button>
          <button class="btn" name="action" value="sql">${icon('download')} Download SQL</button>
          <button class="btn" name="action" value="csv">${icon('download')} Download CSV</button></div>
        <fieldset class="prop-group u-mt1"><legend>Save the definition</legend><div class="form-grid">
          <div class="field"><label class="label" for="f_name">Name</label><input id="f_name" name="name" value="${st.name ?? ''}" maxlength="100"></div>
          <div class="field"><label class="label" for="f_description">Description</label><input id="f_description" name="description" value="${st.description ?? ''}" maxlength="1000"></div>
        </div><div class="buttons"><button class="btn" name="action" value="save">${icon('check')} ${st.id ? 'Save' : 'Save as new generator'}</button></div></fieldset>
      </form>`;
    const del = st.id
      ? html`<form method="post" action="${sdUrl}/${st.id}/delete" class="danger-zone">${csrf(s)}<button class="btn btn-danger" data-confirm="Delete this generator definition? Rows already inserted stay.">Delete generator</button></form>`
      : '';
    return page(s, reply, title, html`${intro}${st.result ? html`${st.result}<div class="u-spacer"></div>` : ''}${region(title, html`${form}${del}`)}`, code);
  };

  const sampleTable = (columns: string[], rows: (string | null)[][]) =>
    html`<div class="table-wrap"><table class="report"><thead><tr>${columns.map((c) => html`<th>${c}</th>`)}</tr></thead>
      <tbody>${rows.map((r) => html`<tr>${r.map((v) => html`<td>${v === null ? html`<span class="null">null</span>` : v}</td>`)}</tr>`)}</tbody></table></div>`;

  const resultHtml = (r: RunResult, committed: boolean) =>
    region(
      committed ? 'Inserted' : 'Preview',
      html`<div class="alert ${committed ? 'alert-success' : 'alert-note'}" role="status">
          ${r.tables.map((t) => `${t.table}: ${t.rows} row(s)`).join(', ')}${committed ? ' inserted' : html`. <strong>Rolled back: nothing was saved.</strong>`} (seed ${r.seed}).</div>
        ${r.tables.map((t) => html`<h3 class="u-mt1">${t.table} <span class="muted small">${t.rows > PREVIEW_ROWS ? `first ${PREVIEW_ROWS} of ${t.rows}` : ''}</span></h3>${t.rows ? sampleTable(t.columns, t.sample) : html`<p class="muted">No rows.</p>`}`)}`,
    );

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
    const g = await saved(req.params.id);
    if (!g) return reply.code(404).send('Not found');
    return editor(s, reply, { id: g.id, name: g.name, description: g.description ?? '', def: cleanDef({ schema: g.schema_name, seed: g.seed, tables: g.tables }) });
  });

  app.post(sdUrl, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = req.body ?? {};
    const def = defFromBody(b);
    const g = b.id ? await saved(b.id) : undefined;
    if (b.id && !g) return reply.code(404).send('Not found');
    const st: FormState = { def, id: g?.id, name: (b.name ?? '').trim(), description: (b.description ?? '').trim() };
    const refuse = (error: string) => editor(s, reply, { ...st, error }, 422);
    const action = b.action ?? 'preview';

    if (action === 'save') {
      if (!st.name) return refuse('Give the generator a name to save it.');
      if (st.name.length > 100 || (st.description ?? '').length > 1000) return refuse('The name is at most 100 characters, the description 1000.');
      if (!allowedSchema(def.schema)) return refuse('Choose a schema of your own: not meta, information_schema or pg_*.');
      const { tables } = await describeAll(def);
      if (!tables.length) return refuse('Choose at least one table.');
      const json = JSON.stringify(tables.map(({ spec }) => spec));
      try {
        const id = g
          ? (await owner.one('update meta.data_generator set name = $2, description = $3, schema_name = $4, seed = $5, tables = $6, updated_by = $7, updated_at = now() where id = $1 returning id', [g.id, st.name, st.description || null, def.schema, def.seed, json, s.username])).id
          : (await owner.one('insert into meta.data_generator (name, description, schema_name, seed, tables, created_by, updated_by) values ($1, $2, $3, $4, $5, $6, $6) returning id', [st.name, st.description || null, def.schema, def.seed, json, s.username])).id;
        flash(s, `Generator ${st.name} saved.`);
        return back(reply, s, `${sdUrl}/${id}`);
      } catch (e) {
        if ((e as { code?: string }).code === '23505') return refuse(`A generator named ${st.name} exists already.`);
        throw e;
      }
    }
    if (!['preview', 'insert', 'sql', 'csv'].includes(action)) return refuse('Unknown action.');

    const p = await plan(owner.pool, def);
    if (p.problems.length) return refuse(p.problems.join(' '));
    const seed = def.seed ?? randomSeed();
    st.def = { ...def, seed };

    if (action === 'sql' || action === 'csv') {
      let generated;
      try {
        generated = await generateAll(owner.pool, p.tables, seed);
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
    const c = await owner.pool.connect();
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
        `${action === 'insert' ? 'Nothing was inserted: the transaction was rolled back. ' : ''}${err.table ? `${err.table}: ` : ''}${err.message}${err.detail ? ` (${err.detail})` : ''}`,
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
    return editor(s, reply, { ...st, result: resultHtml(result, action === 'insert') });
  });

  app.post(`${sdUrl}/:id/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const g = await saved(req.params.id);
    if (!g) return reply.code(404).send('Not found');
    await owner.query('delete from meta.data_generator where id = $1', [g.id]);
    flash(s, `Generator ${g.name} deleted.`);
    return back(reply, s, sdUrl);
  });
}
