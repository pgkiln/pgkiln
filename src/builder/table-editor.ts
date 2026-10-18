import type { FastifyInstance, FastifyReply } from 'fastify';
import { esc, html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import { back, BASE, csrf, developer, flash, send, shell, workshopTabs, type Body, type Req } from './ui.ts';
import { SYSTEM_SCHEMAS } from './object-browser.ts';
import { clearCompletions } from './code-editor.ts';
import { currentWorkspace, usableSchemas, workshopDb } from './workspaces.ts';
import { joinStatements, recordChanges } from '../changelog.ts';
import { checkTable, emptyTable, ON_DELETE, readTable, tableSql, type ColumnDef, type TableDef } from '../tabledef.ts';

// (sprint 95, Database Actions DA-8: Table Properties) Create a table, edit one, or start from one as a template, in
// a form: columns (name, type, not null, default, identity, comment, primary key), unique keys, foreign keys,
// checks, indexes, the comment, row level security and, for a new table, partitioning. Preview DDL shows the exact
// CREATE or ALTER statements; Apply runs them in one transaction with the workshop's connection (nothing is
// changed when one fails); Open in the worksheet puts them there to review. The form posts the whole definition;
// readTable() gives the table as it is now, so the statements are always made against the catalog, not against
// what the page showed. Without JavaScript the sections stack and spare empty rows add columns and keys.

const SPARE = 3; // empty rows for new columns, keys, checks and indexes (the page adds more with script)
const TYPES = ['bigint', 'integer', 'smallint', 'numeric', 'numeric(12,2)', 'real', 'double precision', 'text', 'varchar(200)', 'char(1)', 'boolean', 'date',
  'timestamp', 'timestamptz', 'time', 'interval', 'uuid', 'jsonb', 'json', 'bytea', 'inet', 'text[]', 'integer[]'];

const rows = (b: Body, prefix: string) => {
  const ix = [...new Set(Object.keys(b).map((k) => new RegExp(`^${prefix}\\.(\\d{1,3})\\.`).exec(k)?.[1]).filter((x): x is string => !!x))].map(Number).sort((x, y) => x - y);
  return ix.map((i) => (f: string) => String(b[`${prefix}.${i}.${f}`] ?? '').trim());
};

/** The definition the form posted; generated expressions and indexes the form can't edit come from the table as it is. */
function fromForm(b: Body, schema: string, old: TableDef | null): TableDef {
  const def = emptyTable(schema);
  def.name = String(b.name ?? '').trim();
  def.comment = String(b.comment ?? '').trim();
  def.pkName = String(b.pk_name ?? '').trim();
  def.rls = b.rls === 'on';
  def.forceRls = b.force_rls === 'on';
  if (!old) {
    def.partitionBy = (['range', 'list', 'hash'] as const).find((x) => x === b.part_by) ?? '';
    def.partitionKey = def.partitionBy ? String(b.part_key ?? '').trim() : '';
  }
  for (const r of rows(b, 'col')) {
    if (r('drop') === 'on' || (!r('name') && !r('type'))) continue;
    const orig = old?.columns.find((c) => c.orig === r('orig')) ? r('orig') : '';
    const was = old?.columns.find((c) => c.orig === orig);
    const identity = r('identity') === 'always' || r('identity') === 'by default' ? (r('identity') as ColumnDef['identity']) : '';
    def.columns.push({ name: r('name'), orig, type: r('type'), notNull: r('nn') === 'on', default: r('def'), identity, generated: was?.generated ?? '', comment: r('comment'), pk: r('pk') === 'on' });
  }
  for (const r of rows(b, 'uk')) if (r('drop') !== 'on' && (r('name') || r('cols'))) def.uniques.push({ name: r('name'), columns: r('cols') });
  for (const r of rows(b, 'fk')) if (r('drop') !== 'on' && (r('name') || r('cols'))) def.fks.push({ name: r('name'), columns: r('cols'), refTable: r('ref'), refColumns: r('refcols'), onDelete: r('del') || 'no action' });
  for (const r of rows(b, 'ck')) if (r('drop') !== 'on' && (r('name') || r('expr'))) def.checks.push({ name: r('name'), expr: r('expr') });
  for (const r of rows(b, 'ix')) if (r('drop') !== 'on' && (r('name') || r('cols'))) def.indexes.push({ name: r('name'), columns: r('cols'), unique: r('unique') === 'on' });
  // indexes the form can't express stay as they are
  for (const i of old?.indexes ?? []) if (i.fixed) def.indexes.push(i);
  return def;
}

/** A copy of a table under a new name, for "Use as template": new names for its constraints and indexes too. */
function asTemplate(t: TableDef): TableDef {
  const name = `${t.name}_copy`.slice(0, 63);
  const rename = (n: string) => (n.includes(t.name) ? n.replace(t.name, name) : `${n}_copy`).slice(0, 63);
  return {
    ...structuredClone(t), name, pkName: t.pkName ? rename(t.pkName) : '',
    columns: t.columns.map((c) => ({ ...c, orig: '' })),
    uniques: t.uniques.map((k) => ({ ...k, name: rename(k.name) })),
    fks: t.fks.map((k) => ({ ...k, name: rename(k.name) })),
    checks: t.checks.map((k) => ({ ...k, name: rename(k.name) })),
    indexes: t.indexes.filter((i) => !i.fixed).map((i) => ({ ...i, name: rename(i.name) })),
  };
}

async function tables(db: Awaited<ReturnType<typeof workshopDb>>) {
  return (await db.query<{ q: string }>(
    `select c.oid::regclass::text as q from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p') and not c.relispartition and n.nspname !~ '^pg_' and n.nspname <> 'information_schema' and not (n.nspname = any ($1))
        and has_schema_privilege(n.oid, 'USAGE') order by 1 limit 2000`, [SYSTEM_SCHEMAS])).rows.map((r) => r.q);
}

function form(s: Session, def: TableDef, opts: { editing: TableDef | null; schemas: string[]; refTables: string[]; ddl: string[]; errors: string[]; output: Raw | ''; tab: string; ref: string }): Raw {
  const { editing } = opts;
  const chk = (on: boolean) => (on ? raw(' checked') : '');
  const sel = (v: string, cur: string) => (v === cur ? raw(' selected') : '');
  const typeList = html`<datalist id="te-types">${TYPES.map((t) => html`<option value="${t}">`)}</datalist>`;
  const colRow = (c: ColumnDef | null, i: number) => html`<tr class="te-row${c ? '' : ' te-spare'}">
      <td class="te-move"><button type="button" class="btn btn-sm btn-icon" data-te-up title="Move up" hidden>↑</button><button type="button" class="btn btn-sm btn-icon" data-te-down title="Move down" hidden>↓</button></td>
      <td><input type="hidden" name="col.${i}.orig" value="${c?.orig ?? ''}"><input id="te-c${i}-name" aria-label="Name" name="col.${i}.name" value="${c?.name ?? ''}" autocomplete="off" spellcheck="false"></td>
      <td><input id="te-c${i}-type" aria-label="Type" name="col.${i}.type" value="${c?.type ?? ''}" list="te-types" autocomplete="off" spellcheck="false"></td>
      <td class="te-c"><input type="checkbox" aria-label="Primary key" id="te-c${i}-pk" name="col.${i}.pk"${chk(!!c?.pk)}></td>
      <td class="te-c"><input type="checkbox" aria-label="Not null" id="te-c${i}-nn" name="col.${i}.nn"${chk(!!c?.notNull)}></td>
      <td>${c?.generated
        ? html`<code class="te-generated" title="Generated (stored)">= ${c.generated}</code><input type="hidden" name="col.${i}.def" value="">`
        : html`<input id="te-c${i}-def" aria-label="Default" name="col.${i}.def" value="${c?.default ?? ''}" class="code" spellcheck="false">`}</td>
      <td><select id="te-c${i}-id" aria-label="Identity" name="col.${i}.identity"><option value="">-</option><option value="by default"${sel('by default', c?.identity ?? '')}>by default</option><option value="always"${sel('always', c?.identity ?? '')}>always</option></select></td>
      <td><input id="te-c${i}-cm" aria-label="Comment" name="col.${i}.comment" value="${c?.comment ?? ''}"></td>
      <td class="te-c"><label class="te-drop"><input type="checkbox" name="col.${i}.drop"><span>Remove</span></label></td></tr>`;
  const simpleRows = <T,>(list: T[], prefix: string, cells: (x: T | null, i: number) => Raw) =>
    [...list, ...Array<null>(SPARE).fill(null)].map((x, i) => html`<tr class="te-row${x ? '' : ' te-spare'}">${cells(x, i)}<td class="te-c"><label class="te-drop"><input type="checkbox" name="${prefix}.${i}.drop"><span>Remove</span></label></td></tr>`);
  // extra: attributes written by this file (constants, or values escaped with esc())
  const input = (name: string, value: string, label: string, extra = '') => html`<input id="te-${name}" aria-label="${label}" name="${name}" value="${value}" autocomplete="off" spellcheck="false"${extra ? raw(` ${extra}`) : ''}>`;
  const sections: [string, string, Raw][] = [
    ['columns', 'Columns', html`<div class="table-wrap"><table class="report te-table" data-te-grid="col"><thead><tr><th></th><th>Name</th><th>Type</th><th>Key</th><th>Not null</th><th>Default</th><th>Identity</th><th>Comment</th><th></th></tr></thead>
      <tbody>${[...def.columns, ...Array<null>(SPARE).fill(null)].map((c, i) => colRow(c, i))}</tbody></table></div>
      <div class="buttons"><button type="button" class="btn btn-sm" data-te-add="col" hidden>${icon('plus')} Add column</button></div>
      <div class="field u-mt1"><label class="label" for="te-pk_name">Primary key name</label>${input('pk_name', def.pkName, 'Primary key name', `placeholder="${esc(def.name ? `${def.name}_pkey` : 'table_pkey')}"`)}<small class="help">Tick Key on the columns of the primary key.</small></div>`],
    ['keys', 'Unique keys', html`<div class="table-wrap"><table class="report te-table" data-te-grid="uk"><thead><tr><th>Name</th><th>Columns (comma-separated)</th><th></th></tr></thead><tbody>
      ${simpleRows(def.uniques, 'uk', (k, i) => html`<td>${input(`uk.${i}.name`, k?.name ?? '', 'Name')}</td><td>${input(`uk.${i}.cols`, k?.columns ?? '', 'Columns')}</td>`)}</tbody></table></div>`],
    ['fks', 'Foreign keys', html`<div class="table-wrap"><table class="report te-table" data-te-grid="fk"><thead><tr><th>Name</th><th>Columns</th><th>References</th><th>Their columns</th><th>On delete</th><th></th></tr></thead><tbody>
      ${simpleRows(def.fks, 'fk', (f, i) => html`<td>${input(`fk.${i}.name`, f?.name ?? '', 'Name')}</td><td>${input(`fk.${i}.cols`, f?.columns ?? '', 'Columns')}</td>
        <td><select id="te-fk${i}-ref" aria-label="References" name="fk.${i}.ref"><option value="">-</option>${opts.refTables.map((t) => html`<option value="${t}"${sel(t, f?.refTable ?? '')}>${t}</option>`)}</select></td>
        <td>${input(`fk.${i}.refcols`, f?.refColumns ?? '', 'Their columns', 'placeholder="its primary key"')}</td>
        <td><select id="te-fk${i}-del" aria-label="On delete" name="fk.${i}.del">${ON_DELETE.map((d) => html`<option value="${d}"${sel(d, f?.onDelete ?? 'no action')}>${d}</option>`)}</select></td>`)}</tbody></table></div>`],
    ['checks', 'Checks', html`<div class="table-wrap"><table class="report te-table" data-te-grid="ck"><thead><tr><th>Name</th><th>Condition</th><th></th></tr></thead><tbody>
      ${simpleRows(def.checks, 'ck', (k, i) => html`<td>${input(`ck.${i}.name`, k?.name ?? '', 'Name')}</td><td>${input(`ck.${i}.expr`, k?.expr ?? '', 'Condition', 'class="code" placeholder="salary &gt;= 0"')}</td>`)}</tbody></table></div>`],
    ['indexes', 'Indexes', html`<div class="table-wrap"><table class="report te-table" data-te-grid="ix"><thead><tr><th>Name</th><th>Columns or expressions</th><th>Unique</th><th></th></tr></thead><tbody>
      ${simpleRows(def.indexes.filter((i) => !i.fixed), 'ix', (x, i) => html`<td>${input(`ix.${i}.name`, x?.name ?? '', 'Name')}</td><td>${input(`ix.${i}.cols`, x?.columns ?? '', 'Columns', 'class="code" placeholder="lower(name), created_at desc"')}</td>
        <td class="te-c"><input type="checkbox" aria-label="Unique" id="te-ix${i}-u" name="ix.${i}.unique"${chk(!!x?.unique)}></td>`)}</tbody></table></div>
      ${def.indexes.some((i) => i.fixed) ? html`<p class="muted small">Kept as they are (another method or a condition): ${def.indexes.filter((i) => i.fixed).map((i) => html`<code>${i.fixed}</code> `)}</p>` : ''}`],
    ['more', 'Comment and security', html`<div class="field"><label class="label" for="te-comment">Comment</label><textarea id="te-comment" name="comment" rows="2">${def.comment}</textarea></div>
      <label class="check"><input type="checkbox" name="rls"${chk(def.rls)}> Row level security: rows only through policies</label>
      <label class="check"><input type="checkbox" name="force_rls"${chk(def.forceRls)}> Force it for the table's owner too</label>
      ${editing ? '' : html`<fieldset class="prop-group u-mt1"><legend>Partitioning</legend><div class="form-grid">
        <div class="field"><label class="label" for="te-part_by">Partition by</label><select id="te-part_by" name="part_by"><option value="">Not partitioned</option>${(['range', 'list', 'hash'] as const).map((p) => html`<option value="${p}"${sel(p, def.partitionBy)}>${p}</option>`)}</select></div>
        <div class="field"><label class="label" for="te-part_key">Key</label>${input('part_key', def.partitionKey, 'Key', 'class="code" placeholder="created_at"')}</div></div>
        <small class="help">The partitions themselves are tables made with CREATE TABLE … PARTITION OF in the worksheet.</small></fieldset>`}`],
    ['ddl', 'DDL', opts.ddl.length ? html`<pre class="source te-ddl" data-code-view="sql" tabindex="0" aria-label="DDL">${opts.ddl.join('\n\n')}</pre>` : html`<p class="muted">${editing ? 'No changes yet: the table is as the form shows it.' : 'Fill in the table and press Preview DDL.'}</p>`],
    ['output', 'Output', opts.output || html`<p class="muted">Apply shows what happened here.</p>`],
  ];
  const tab = sections.some(([k]) => k === opts.tab) ? opts.tab : opts.errors.length ? 'columns' : 'columns';
  return html`<form method="post" action="${BASE}/sql/objects/table" class="te" data-te-tab="${tab}">${csrf(s)}
    <input type="hidden" name="ref" value="${opts.ref}">${typeList}
    ${opts.errors.length ? html`<div class="alert alert-error" role="alert"><ul>${opts.errors.map((e) => html`<li>${e}</li>`)}</ul></div>` : ''}
    <div class="form-grid te-head">
      <div class="field"><label class="label" for="te-schema">Schema</label>${editing
        ? html`<input id="te-schema" value="${def.schema}" readonly><input type="hidden" name="schema" value="${def.schema}">`
        : html`<select id="te-schema" name="schema">${opts.schemas.map((n) => html`<option value="${n}"${sel(n, def.schema)}>${n}</option>`)}</select>`}</div>
      <div class="field"><label class="label" for="te-name">Table name</label><input id="te-name" name="name" value="${def.name}" required autocomplete="off" spellcheck="false"></div>
    </div>
    <nav class="te-tabs" role="tablist" aria-label="Table properties" hidden>${sections.map(([k, label]) => html`<button type="button" role="tab" aria-selected="${k === tab ? 'true' : 'false'}" data-te-show="${k}">${label}</button>`)}</nav>
    ${sections.map(([k, label, body]) => html`<section class="te-section" data-te-section="${k}"><h2>${label}</h2>${body}</section>`)}
    <div class="buttons te-buttons">
      <button class="btn" name="mode" value="preview">${icon('eye')} Preview DDL</button>
      <button class="btn btn-hot" name="mode" value="apply">${icon('check')} Apply</button>
      <button class="btn" name="mode" value="worksheet">${icon('code')} Open in the worksheet</button>
      <a class="btn" href="${editing ? `${BASE}/sql/objects?${new URLSearchParams({ schema: def.schema, k: 'table', o: opts.ref })}` : `${BASE}/sql/objects?${new URLSearchParams({ schema: def.schema })}`}">Cancel</a>
    </div></form>`;
}

async function page(req: Req, reply: FastifyReply) {
  const s = await developer(req, reply);
  if (!s) return;
  const db = await workshopDb(s);
  const isPost = req.method === 'POST';
  const b: Body = isPost ? (req.body ?? {}) : (req.query ?? {});
  const schemas = (await usableSchemas(db)).filter((n) => !SYSTEM_SCHEMAS.includes(n));
  const refTables = await tables(db);
  // the table being edited, read again from the catalog on every request
  const ref = String((isPost ? b.ref : b.o) ?? '');
  const editing = ref ? await readTable(db, ref) : null;
  if (ref && (!editing || SYSTEM_SCHEMAS.includes(editing.schema) || !schemas.includes(editing.schema))) return reply.code(404).send('Not found');
  let def: TableDef;
  let errors: string[] = [];
  let ddl: string[] = [];
  let output: Raw | '' = '';
  let tab = 'columns';
  if (!isPost) {
    const template = typeof b.template === 'string' && b.template ? await readTable(db, b.template) : null;
    if (b.template && (!template || !schemas.includes(template.schema))) return reply.code(404).send('Not found');
    def = editing ?? (template ? asTemplate(template) : emptyTable(schemas.includes(String(b.schema)) ? String(b.schema) : (schemas[0] ?? 'public')));
  } else {
    const schema = editing ? editing.schema : String(b.schema ?? '');
    if (!schemas.includes(schema)) return reply.code(404).send('Not found');
    def = fromForm(b, schema, editing);
    errors = checkTable(def, editing);
    if (!errors.length) ddl = tableSql(def, editing);
    tab = 'ddl';
    if (!errors.length && b.mode === 'worksheet') {
      s.state.__SQLDRAFT = ddl.join('\n\n') || '-- no changes';
      flash(s, 'Review the statements and run them: nothing has been changed yet.');
      return back(reply, s, `${BASE}/sql/worksheet`);
    }
    if (!errors.length && b.mode === 'apply' && ddl.length) {
      const c = await db.pool.connect();
      let failed = '';
      let at = '';
      try {
        await c.query('begin');
        for (const x of ddl) {
          at = x;
          await c.query(x);
        }
        await c.query('commit');
      } catch (e) {
        failed = (e as Error).message;
        await c.query('rollback').catch(() => {});
      } finally {
        c.release(true);
      }
      await logActivity({ username: s.username, event: 'sql_command', ip: clientIp(req), detail: ddl.join(';\n').slice(0, 2000) });
      clearCompletions();
      if (!failed) {
        // (sprint 106, DA-17) one change set in the change log
        await recordChanges({ workspaceId: currentWorkspace(s), author: s.username ?? '?', source: 'table', defaultSchema: def.schema, statements: [joinStatements(ddl)] });
        flash(s, `${editing ? 'Changed' : 'Created'} ${def.schema}.${def.name}: ${ddl.length} statement${ddl.length === 1 ? '' : 's'}.`);
        const now = await readTable(db, `${pgIdent(def.schema)}.${pgIdent(def.name)}`);
        return back(reply, s, `${BASE}/sql/objects/table?${new URLSearchParams({ o: now ? `${pgIdent(now.schema)}.${pgIdent(now.name)}` : '' })}`);
      }
      output = html`<div class="alert alert-error" role="alert"><p><strong>Nothing was changed</strong>: the statements ran in one transaction, which was rolled back.</p><p>${failed}</p><pre class="source" data-code-view="sql" tabindex="0" aria-label="Failed statement">${at}</pre></div>`;
      tab = 'output';
    }
    if (errors.length) tab = 'columns';
  }
  const title = editing ? `Table ${editing.schema}.${editing.name}` : 'Create table';
  const main = html`<h1 class="u-mb1">${title}</h1>${workshopTabs('objects')}
    ${form(s, def, { editing, schemas, refTables, ddl, errors, output, tab, ref: editing ? ref : '' })}`;
  return send(reply, s, shell(s, title, [['SQL Workshop', `${BASE}/sql`], ['Object Browser', `${BASE}/sql/objects`], [title]], main, 'sql'));
}

const pgIdent = (n: string) => (/^[a-z_][a-z0-9_$]*$/.test(n) ? n : `"${n.replace(/"/g, '""')}"`);

export async function tableEditorRoutes(app: FastifyInstance) {
  app.get(`${BASE}/sql/objects/table`, page);
  app.post(`${BASE}/sql/objects/table`, page);
}
