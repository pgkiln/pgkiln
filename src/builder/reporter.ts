import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { heading } from '../runtime/items.ts';
import { RESERVED_SCHEMAS, SOURCE_ID, sourcesOf, type Source, type SourceColumn } from '../runtime/data-reporter.ts';
import type { Session } from '../session.ts';
import { back, BASE, csrf, developer, flash, type Req } from './ui.ts';

// Page designer → a Data Reporter region → Settings: the data sources the
// region offers (tables and views, which of their columns, labels and format
// masks) and who may share reports. Saving replaces only the keys this form
// knows (sources, sharing, share_authz, page_size, empty).

type Config = Record<string, any>;
type Body = Record<string, string | undefined>;

export const MAX_SOURCES = 20;

/** A table or view the builder may offer: its schema, name and columns (in table order). */
export interface DbObject {
  oid: number;
  schema: string;
  table: string;
  columns: { name: string; type: string }[];
}

const OBJECTS_SQL = `
  select c.oid::int as oid, n.nspname as schema, c.relname as table,
         coalesce(json_agg(json_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod)) order by a.attnum)
                  filter (where a.attnum > 0), '[]') as columns
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    left join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
   where c.relkind in ('r', 'p', 'v', 'm') and n.nspname !~ '^pg_' and n.nspname not in ('information_schema', 'meta')`;

/** A table or view by schema and name (null: not there, or a reserved schema). */
export async function findObject(schema: string, table: string): Promise<DbObject | null> {
  if (RESERVED_SCHEMAS.test(schema)) return null;
  return (await owner.one<DbObject>(`${OBJECTS_SQL} and n.nspname = $1 and c.relname = $2 group by 1, 2, 3`, [schema, table])) ?? null;
}

async function objectByOid(oid: number): Promise<DbObject | null> {
  return (await owner.one<DbObject>(`${OBJECTS_SQL} and c.oid = $1 group by 1, 2, 3`, [oid])) ?? null;
}

/** The tables and views to choose from, with whether the application's role may read them. */
async function objectList(dbRole: string | null) {
  return (
    await owner.query<{ oid: number; name: string; access: boolean }>(
      `select c.oid::int as oid, format('%I.%I', n.nspname, c.relname) as name,
              $1::text is null or not exists (select 1 from pg_roles where rolname = $1) or has_table_privilege($1, c.oid, 'select') as access
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r', 'p', 'v', 'm') and n.nspname !~ '^pg_' and n.nspname not in ('information_schema', 'meta')
        order by 2`,
      [dbRole],
    )
  ).rows;
}

const clip = (v: string | undefined, max: number) => (v ?? '').trim().slice(0, max);

/**
 * The region's settings from the form. Columns must exist in the source's
 * table or view (looked up by `lookup`); a new source is a table or view
 * outside pgkiln's and the system's schemas, with all its columns offered
 * except binary ones.
 */
export async function mergeReporterSettings(
  config: Config, b: Body, a: { authz: Set<string> },
  lookup: { byName: (schema: string, table: string) => Promise<DbObject | null>; byOid: (oid: number) => Promise<DbObject | null> } = { byName: findObject, byOid: objectByOid },
): Promise<{ config: Config; errors: string[] }> {
  const out: Config = { ...config };
  const errors: string[] = [];
  const size = Number(b.page_size);
  if (b.page_size && Number.isInteger(size) && size >= 5 && size <= 200 && size !== 25) out.page_size = size;
  else delete out.page_size;
  const empty = clip(b.empty, 200);
  if (empty) out.empty = empty;
  else delete out.empty;
  delete out.sharing;
  delete out.share_authz;
  if (b.sharing === 'off') out.sharing = false;
  else if (b.sharing?.startsWith('authz:') && a.authz.has(b.sharing.slice(6).toUpperCase())) out.share_authz = b.sharing.slice(6);

  const sources: Source[] = [];
  const existing = sourcesOf({ config });
  for (let i = 0; i < existing.length; i++) {
    const s = existing.find((x) => x.id === b[`s${i}_key`]);
    if (!s || sources.some((x) => x.id === s.id)) continue;
    if (b[`s${i}_remove`] === 'true') continue;
    const obj = await lookup.byName(s.schema, s.table);
    const names = new Set(obj?.columns.map((c) => c.name));
    const columns: SourceColumn[] = [];
    for (let j = 0; j < 500 && b[`s${i}_col_${j}`] !== undefined; j++) {
      const name = b[`s${i}_col_${j}`]!;
      if (b[`s${i}_on_${j}`] !== 'true' || columns.some((c) => c.name === name)) continue;
      // a column the table no longer has may stay offered (it is skipped at run time), but none can be added
      if (!names.has(name) && !s.columns.some((c) => c.name === name)) continue;
      const label = clip(b[`s${i}_label_${j}`], 80);
      const format = clip(b[`s${i}_fmt_${j}`], 40);
      columns.push({ name, ...(label ? { label } : {}), ...(format ? { format } : {}) });
    }
    if (!columns.length) errors.push(`Data source ${s.id} offers no columns.`);
    const label = clip(b[`s${i}_label`], 80);
    const description = clip(b[`s${i}_description`], 300);
    sources.push({ id: s.id, ...(label ? { label } : {}), ...(description ? { description } : {}), schema: s.schema, table: s.table, columns });
  }

  if (b.new_object) {
    const obj = /^\d{1,10}$/.test(b.new_object) ? await lookup.byOid(Number(b.new_object)) : null;
    if (!obj || RESERVED_SCHEMAS.test(obj.schema)) errors.push('Choose a table or view for the new data source.');
    else if (sources.length >= MAX_SOURCES) errors.push(`A region offers at most ${MAX_SOURCES} data sources.`);
    else {
      let id = clip(b.new_id, 40).toLowerCase();
      if (id && !SOURCE_ID.test(id)) {
        errors.push(`"${id}" is not a valid static id: lower case letters, digits and _, starting with a letter.`);
        id = '';
      }
      if (id && sources.some((s) => s.id === id)) {
        errors.push(`There is already a data source ${id}.`);
        id = '';
      }
      if (!id) {
        const base = (obj.table.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^[^a-z]+/, '') || 'source').slice(0, 36);
        id = base;
        for (let n = 2; sources.some((s) => s.id === id); n++) id = `${base}_${n}`;
      }
      const label = clip(b.new_label, 80) || heading(obj.table);
      const columns = obj.columns.filter((c) => c.type !== 'bytea').map((c) => ({ name: c.name, label: heading(c.name) }));
      sources.push({ id, label, schema: obj.schema, table: obj.table, columns });
    }
  }
  if (sources.length) out.sources = sources;
  else delete out.sources;
  return { config: out, errors };
}

const opt = (value: string, label: string, current: string) => html`<option value="${value}"${value === current ? raw(' selected') : ''}>${label}</option>`;

/** The settings form under a Data Reporter region in the page designer. */
export async function reporterSettingsForm(pageId: number, appId: number, r: { id: number; config: Config }, s: Session): Promise<Raw> {
  const cfg = r.config ?? {};
  const id = (n: string) => `rr_${r.id}_${n}`;
  const app = await owner.one<{ db_role: string | null }>('select db_role from meta.app where id = $1', [appId]);
  const schemes = (await owner.query<{ name: string }>('select name from meta.authz_scheme where app_id = $1 order by name', [appId])).rows.map((x) => x.name);
  const objects = await objectList(app?.db_role ?? null);
  const sources = sourcesOf({ config: cfg });
  const sharing = cfg.sharing === false ? 'off' : typeof cfg.share_authz === 'string' && cfg.share_authz ? `authz:${cfg.share_authz}` : '';
  const sourceSets = await Promise.all(
    sources.map(async (src, i) => {
      const obj = await findObject(src.schema, src.table);
      const offered = new Map(src.columns.map((c) => [c.name, c]));
      const all = [...(obj?.columns ?? []).map((c) => ({ name: c.name, type: c.type, missing: false })),
        ...src.columns.filter((c) => !obj?.columns.some((x) => x.name === c.name)).map((c) => ({ name: c.name, type: '', missing: true }))];
      const readable = obj ? objects.find((o) => o.oid === obj.oid)?.access : undefined;
      return html`<fieldset class="prop-group"><legend>${src.label || src.id} <span class="muted">(${src.schema}.${src.table})</span></legend>
        <input type="hidden" name="s${i}_key" value="${src.id}">
        ${!obj ? html`<div class="alert alert-error" role="alert">The table or view ${src.schema}.${src.table} does not exist (any more).</div>` : ''}
        ${obj && readable === false ? html`<div class="alert alert-error" role="alert">The application's database role may not read ${src.schema}.${src.table}: grant it SELECT.</div>` : ''}
        <div class="form-grid">
          <div class="field"><label class="label" for="${id(`s${i}_id`)}">Static id</label><input id="${id(`s${i}_id`)}" value="${src.id}" readonly></div>
          <div class="field"><label class="label" for="${id(`s${i}_label`)}">Label</label><input id="${id(`s${i}_label`)}" name="s${i}_label" maxlength="80" value="${src.label ?? ''}" placeholder="${heading(src.table)}"></div>
          <div class="field" data-wide><label class="label" for="${id(`s${i}_description`)}">Description (shown to users)</label><input id="${id(`s${i}_description`)}" name="s${i}_description" maxlength="300" value="${src.description ?? ''}"></div>
        </div>
        <div class="table-wrap"><table class="report report-reflow"><thead><tr><th scope="col">Offer</th><th scope="col">Column</th><th scope="col">Label</th><th scope="col">Format mask</th></tr></thead><tbody>
          ${all.map((c, j) => {
            const o = offered.get(c.name);
            return html`<tr>
              <td data-label="Offer"><input type="hidden" name="s${i}_col_${j}" value="${c.name}"><input type="checkbox" name="s${i}_on_${j}" value="true"${o ? raw(' checked') : ''} aria-label="Offer ${c.name}"></td>
              <td data-label="Column"><code>${c.name}</code> <span class="muted">${c.type}</span>${c.missing ? html` <span class="tag tag-error">not in the table</span>` : ''}</td>
              <td data-label="Label"><input name="s${i}_label_${j}" maxlength="80" value="${o?.label ?? ''}" placeholder="${heading(c.name)}" aria-label="Label of ${c.name}"></td>
              <td data-label="Format mask"><input name="s${i}_fmt_${j}" maxlength="40" value="${o?.format ?? ''}" placeholder="FML999G990D00" aria-label="Format mask of ${c.name}"></td>
            </tr>`;
          })}
        </tbody></table></div>
        <div class="field"><label class="check"><input type="checkbox" name="s${i}_remove" value="true"> Remove this data source (users' reports on it stop working)</label></div>
      </fieldset>`;
    }),
  );
  return html`<h3 class="u-mt15">Data Reporter settings</h3>
    <p class="muted u-mt0">Signed-in users build their own reports from the data sources below: they pick offered columns, filter, group with totals, sort and draw a chart, and save reports privately or shared. Reports run as the application's database role, so grants and row level security apply.</p>
    <form method="post" action="${BASE}/pages/${pageId}/region/${r.id}/reporter" class="component-form">${csrf(s)}
      <fieldset class="prop-group"><legend>Reports</legend><div class="form-grid">
        <div class="field"><label class="label" for="${id('sharing')}">Who may share reports</label>
          <select id="${id('sharing')}" name="sharing">${opt('', 'Every signed-in user', sharing)}${opt('off', 'Nobody (private reports only)', sharing)}${schemes.map((n) => opt(`authz:${n}`, `Authorization: ${n}`, sharing))}</select></div>
        <div class="field"><label class="label" for="${id('page_size')}">Rows per page</label>
          <input id="${id('page_size')}" name="page_size" type="number" min="5" max="200" value="${cfg.page_size ?? ''}" placeholder="25"></div>
        <div class="field" data-wide><label class="label" for="${id('empty')}">Text when there are no rows</label>
          <input id="${id('empty')}" name="empty" maxlength="200" value="${cfg.empty ?? ''}" placeholder="No data found"></div>
      </div></fieldset>
      ${sourceSets}
      <fieldset class="prop-group"><legend>Add a data source</legend><div class="form-grid">
        <div class="field" data-wide><label class="label" for="${id('new_object')}">Table or view</label>
          <select id="${id('new_object')}" name="new_object"><option value="">- none -</option>${objects.map((o) => html`<option value="${o.oid}">${o.name}${o.access ? '' : ' (no access for the app role)'}</option>`)}</select></div>
        <div class="field"><label class="label" for="${id('new_id')}">Static id</label><input id="${id('new_id')}" name="new_id" maxlength="40" pattern="[a-z][a-z0-9_]*" placeholder="from the name"></div>
        <div class="field"><label class="label" for="${id('new_label')}">Label</label><input id="${id('new_label')}" name="new_label" maxlength="80"></div>
      </div>
      <small class="help">All columns are offered at first (except binary ones); untick those users should not see. Prefer a view that shows exactly what business users may report on.</small></fieldset>
      <div class="buttons"><button class="btn btn-hot">Save Data Reporter settings</button></div>
    </form>`;
}

export async function reporterBuilderRoutes(app: FastifyInstance) {
  app.post(`${BASE}/pages/:pid/region/:rid/reporter`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const { pid, rid } = req.params as { pid: string; rid: string };
    const r = /^\d{1,9}$/.test(pid) && /^\d{1,9}$/.test(rid)
      ? await owner.one<{ id: number; config: Config; app_id: number }>(
          `select r.id, r.config, p.app_id from meta.region r join meta.page p on p.id = r.page_id where r.id = $1 and r.page_id = $2 and r.type = 'data_reporter'`, [rid, pid])
      : undefined;
    if (!r) return reply.code(404).send('Not found');
    const schemes = (await owner.query<{ name: string }>('select name from meta.authz_scheme where app_id = $1', [r.app_id])).rows;
    const { config, errors } = await mergeReporterSettings(r.config ?? {}, (req.body ?? {}) as Body, { authz: new Set(schemes.map((x) => x.name.toUpperCase())) });
    await owner.query('update meta.region set config = $2 where id = $1', [r.id, JSON.stringify(config)]);
    if (errors.length) flash(s, errors.join(' '), 'error');
    else flash(s, 'Settings saved.');
    return back(reply, s, `${BASE}/pages/${pid}?c=region-${rid}`);
  });
}
