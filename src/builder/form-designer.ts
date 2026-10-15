import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { heading } from '../runtime/items.ts';
import { RESERVED_SCHEMAS, SOURCE_ID } from '../runtime/data-reporter.ts';
import { fdSourcesOf, type FdColumn, type FdSource } from '../runtime/form-designer.ts';
import type { Session } from '../session.ts';
import { findObject, objectList, type DbObject } from './reporter.ts';
import { back, BASE, csrf, developer, flash, type Req } from './ui.ts';

// Page designer → a Form Designer region → Settings (sprint 85): the tables
// and views the region offers (which columns forms may show and change, their
// labels and lists of values, the key column, whether forms may add, change
// and delete rows) and who may design forms. Saving replaces only the keys
// this form knows (sources, design_authz, page_size, empty).

type Config = Record<string, any>;
type Body = Record<string, string | undefined>;

export const MAX_FD_SOURCES = 20;

/** The single-column primary key of a table (null: none, or a view). */
export async function primaryKeyOf(schema: string, table: string): Promise<string | null> {
  const row = await owner.one<{ name: string }>(
    `select a.attname as name from pg_index i join pg_class c on c.oid = i.indrelid join pg_namespace n on n.oid = c.relnamespace
       join pg_attribute a on a.attrelid = c.oid and a.attnum = i.indkey[0]
      where i.indisprimary and i.indnatts = 1 and n.nspname = $1 and c.relname = $2`, [schema, table]);
  return row?.name ?? null;
}

const clip = (v: string | undefined, max: number) => (v ?? '').trim().slice(0, max);
const LOV_REF = /^(LOV:[A-Z0-9_]+|STATIC:.+)$/is;

/**
 * The region's settings from the form. Columns and the key must exist in the
 * source's table or view (looked up by `lookup`); a new source is a table or
 * view outside pgkiln's and the system's schemas, with its columns offered
 * except binary and JSON ones, and its primary key as the key. A list of
 * values is a shared one of the application (`lovs`) or STATIC:….
 */
export async function mergeFormDesignerSettings(
  config: Config, b: Body, a: { authz: Set<string>; lovs: Set<string> },
  lookup: { byName: (schema: string, table: string) => Promise<DbObject | null>; byOid: (oid: number) => Promise<DbObject | null>; key: (schema: string, table: string) => Promise<string | null> } =
    { byName: findObject, byOid: objectByOid, key: primaryKeyOf },
): Promise<{ config: Config; errors: string[] }> {
  const out: Config = { ...config };
  const errors: string[] = [];
  const size = Number(b.page_size);
  if (b.page_size && Number.isInteger(size) && size >= 5 && size <= 200 && size !== 25) out.page_size = size;
  else delete out.page_size;
  const empty = clip(b.empty, 200);
  if (empty) out.empty = empty;
  else delete out.empty;
  delete out.design_authz;
  if (b.design_authz && a.authz.has(b.design_authz.toUpperCase())) out.design_authz = b.design_authz;
  else if (b.design_authz) errors.push(`There is no authorization scheme ${b.design_authz}.`);

  const lovOk = (v: string) => LOV_REF.test(v) && (!/^LOV:/i.test(v) || a.lovs.has(v.slice(4).toUpperCase()));
  const sources: FdSource[] = [];
  const existing = fdSourcesOf({ config });
  for (let i = 0; i < existing.length; i++) {
    const s = existing.find((x) => x.id === b[`s${i}_key`]);
    if (!s || sources.some((x) => x.id === s.id)) continue;
    if (b[`s${i}_remove`] === 'true') continue;
    const obj = await lookup.byName(s.schema, s.table);
    const names = new Set(obj?.columns.map((c) => c.name));
    const columns: FdColumn[] = [];
    for (let j = 0; j < 500 && b[`s${i}_col_${j}`] !== undefined; j++) {
      const name = b[`s${i}_col_${j}`]!;
      if (b[`s${i}_on_${j}`] !== 'true' || columns.some((c) => c.name === name)) continue;
      // a column the table no longer has may stay offered (it is skipped at run time), but none can be added
      if (!names.has(name) && !s.columns.some((c) => c.name === name)) continue;
      const label = clip(b[`s${i}_label_${j}`], 80);
      let lov = clip(b[`s${i}_lov_${j}`], 2000);
      if (lov && !lovOk(lov)) {
        errors.push(`${s.id}.${name}: "${lov.slice(0, 60)}" is not a shared list of values of this application (LOV:NAME) or STATIC:Display;value,….`);
        lov = '';
      }
      columns.push({ name, ...(label ? { label } : {}), ...(lov ? { lov } : {}) });
    }
    if (!columns.length) errors.push(`Data source ${s.id} offers no columns.`);
    const key = clip(b[`s${i}_keycol`], 63);
    if (key && !names.has(key)) errors.push(`${s.id}: the key column ${key} is not in ${s.schema}.${s.table}.`);
    const label = clip(b[`s${i}_label`], 80);
    const description = clip(b[`s${i}_description`], 300);
    const hasKey = !!key && names.has(key);
    sources.push({
      id: s.id, ...(label ? { label } : {}), ...(description ? { description } : {}), schema: s.schema, table: s.table,
      ...(hasKey ? { key } : {}), columns, insert: b[`s${i}_insert`] === 'true', update: hasKey && b[`s${i}_update`] === 'true', delete: hasKey && b[`s${i}_delete`] === 'true',
    });
  }

  if (b.new_object) {
    const obj = /^\d{1,10}$/.test(b.new_object) ? await lookup.byOid(Number(b.new_object)) : null;
    if (!obj || RESERVED_SCHEMAS.test(obj.schema)) errors.push('Choose a table or view for the new data source.');
    else if (sources.length >= MAX_FD_SOURCES) errors.push(`A region offers at most ${MAX_FD_SOURCES} data sources.`);
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
      const key = await lookup.key(obj.schema, obj.table);
      const columns = obj.columns.filter((c) => !/^(bytea|json|jsonb|xml)$/.test(c.type)).map((c) => ({ name: c.name, label: heading(c.name) }));
      // adding rows at first; changing them when the table has a key; never deleting until the developer says so
      sources.push({ id, label, schema: obj.schema, table: obj.table, ...(key ? { key } : {}), columns, insert: true, update: !!key, delete: false });
    }
  }
  if (sources.length) out.sources = sources;
  else delete out.sources;
  return { config: out, errors };
}

async function objectByOid(oid: number): Promise<DbObject | null> {
  const row = await owner.one<{ schema: string; table: string }>(`select n.nspname as schema, c.relname as table from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid = $1`, [oid]);
  return row ? findObject(row.schema, row.table) : null;
}

const opt = (value: string, label: string, current: string) => html`<option value="${value}"${value === current ? raw(' selected') : ''}>${label}</option>`;

/** The settings form under a Form Designer region in the page designer. */
export async function formDesignerSettingsForm(pageId: number, appId: number, r: { id: number; config: Config }, s: Session): Promise<Raw> {
  const cfg = r.config ?? {};
  const id = (n: string) => `fds_${r.id}_${n}`;
  const app = await owner.one<{ db_role: string | null }>('select db_role from meta.app where id = $1', [appId]);
  const schemes = (await owner.query<{ name: string }>('select name from meta.authz_scheme where app_id = $1 order by name', [appId])).rows.map((x) => x.name);
  const lovs = (await owner.query<{ name: string }>('select name from meta.lov where app_id = $1 order by name', [appId])).rows.map((x) => x.name);
  const objects = await objectList(app?.db_role ?? null);
  const sources = fdSourcesOf({ config: cfg });
  const designAuthz = typeof cfg.design_authz === 'string' ? cfg.design_authz : '';
  const role = app?.db_role ?? null;
  const sourceSets = await Promise.all(
    sources.map(async (src, i) => {
      const obj = await findObject(src.schema, src.table);
      const offered = new Map(src.columns.map((c) => [c.name, c]));
      const all = [...(obj?.columns ?? []).map((c) => ({ name: c.name, type: c.type, missing: false })),
        ...src.columns.filter((c) => !obj?.columns.some((x) => x.name === c.name)).map((c) => ({ name: c.name, type: '', missing: true }))];
      const privileges = obj && role
        ? await owner.one<{ sel: boolean; ins: boolean; upd: boolean; del: boolean }>(
            `select has_table_privilege($1, $2::oid, 'select') as sel, has_table_privilege($1, $2::oid, 'insert') as ins,
                    has_table_privilege($1, $2::oid, 'update') as upd, has_table_privilege($1, $2::oid, 'delete') as del`, [role, obj.oid])
            .catch(() => undefined)
        : undefined;
      const missing = privileges ? (['sel', 'ins', 'upd', 'del'] as const).filter((k) => !privileges[k] && (k === 'sel' || src[({ ins: 'insert', upd: 'update', del: 'delete' } as const)[k as 'ins' | 'upd' | 'del']])) : [];
      const grant = { sel: 'SELECT', ins: 'INSERT', upd: 'UPDATE', del: 'DELETE' };
      const check = (k: 'insert' | 'update' | 'delete', label: string, needsKey: boolean) =>
        html`<label class="check"><input type="checkbox" name="s${i}_${k}" value="true"${src[k] ? raw(' checked') : ''}> ${label}${needsKey && !src.key ? ' (needs a key column)' : ''}</label>`;
      return html`<fieldset class="prop-group"><legend>${src.label || src.id} <span class="muted">(${src.schema}.${src.table})</span></legend>
        <input type="hidden" name="s${i}_key" value="${src.id}">
        ${!obj ? html`<div class="alert alert-error" role="alert">The table or view ${src.schema}.${src.table} does not exist (any more).</div>` : ''}
        ${missing.length ? html`<div class="alert alert-error" role="alert">The application's database role lacks ${missing.map((k) => grant[k]).join(', ')} on ${src.schema}.${src.table}: grant it, or forms can't do that.</div>` : ''}
        <div class="form-grid">
          <div class="field"><label class="label" for="${id(`s${i}_id`)}">Static id</label><input id="${id(`s${i}_id`)}" value="${src.id}" readonly></div>
          <div class="field"><label class="label" for="${id(`s${i}_label`)}">Label</label><input id="${id(`s${i}_label`)}" name="s${i}_label" maxlength="80" value="${src.label ?? ''}" placeholder="${heading(src.table)}"></div>
          <div class="field" data-wide><label class="label" for="${id(`s${i}_description`)}">Description (shown to designers)</label><input id="${id(`s${i}_description`)}" name="s${i}_description" maxlength="300" value="${src.description ?? ''}"></div>
          <div class="field"><label class="label" for="${id(`s${i}_keycol`)}">Key column (identifies a row)</label>
            <select id="${id(`s${i}_keycol`)}" name="s${i}_keycol"><option value="">- none: forms only add rows -</option>${(obj?.columns ?? []).map((c) => opt(c.name, c.name, src.key ?? ''))}</select></div>
          <div class="field"><span class="label">Forms on it may</span>
            ${check('insert', 'add rows', false)} ${check('update', 'change rows', true)} ${check('delete', 'delete rows', true)}</div>
        </div>
        <div class="table-wrap"><table class="report report-reflow"><thead><tr><th scope="col">Offer</th><th scope="col">Column</th><th scope="col">Label</th><th scope="col">List of values</th></tr></thead><tbody>
          ${all.map((c, j) => {
            const o = offered.get(c.name);
            return html`<tr>
              <td data-label="Offer"><input type="hidden" name="s${i}_col_${j}" value="${c.name}"><input type="checkbox" name="s${i}_on_${j}" value="true"${o ? raw(' checked') : ''} aria-label="Offer ${c.name}"></td>
              <td data-label="Column"><code>${c.name}</code> <span class="muted">${c.type}</span>${c.missing ? html` <span class="tag tag-error">not in the table</span>` : ''}</td>
              <td data-label="Label"><input name="s${i}_label_${j}" maxlength="80" value="${o?.label ?? ''}" placeholder="${heading(c.name)}" aria-label="Label of ${c.name}"></td>
              <td data-label="List of values"><input name="s${i}_lov_${j}" maxlength="2000" value="${o?.lov ?? ''}" placeholder="LOV:NAME" list="${id('lovs')}" aria-label="List of values of ${c.name}"></td>
            </tr>`;
          })}
        </tbody></table></div>
        <div class="field"><label class="check"><input type="checkbox" name="s${i}_remove" value="true"> Remove this data source (forms on it stop working)</label></div>
      </fieldset>`;
    }),
  );
  return html`<h3 class="u-mt15">Form Designer settings</h3>
    <p class="muted u-mt0">Users that pass the designers' authorization scheme build data entry forms on the tables and views below: they pick offered columns, labels, help texts, required fields and defaults, and publish forms for everyone who can see this region. Forms read and write rows as the application's database role, so grants and row level security apply.</p>
    <datalist id="${id('lovs')}">${lovs.map((n) => html`<option value="LOV:${n}">`)}</datalist>
    <form method="post" action="${BASE}/pages/${pageId}/region/${r.id}/form-designer" class="component-form">${csrf(s)}
      <fieldset class="prop-group"><legend>Forms</legend><div class="form-grid">
        <div class="field"><label class="label" for="${id('design_authz')}">Who may design forms</label>
          <select id="${id('design_authz')}" name="design_authz">${opt('', 'Nobody (choose an authorization scheme)', designAuthz)}${schemes.map((n) => opt(n, `Authorization: ${n}`, designAuthz))}</select></div>
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
      <small class="help">All columns are offered at first (except binary and JSON ones), the primary key is the key column, and forms may add and change rows, not delete them. Untick columns designers should not put on forms, such as generated keys and audit columns.</small></fieldset>
      <div class="buttons"><button class="btn btn-hot">Save Form Designer settings</button></div>
    </form>`;
}

export async function formDesignerBuilderRoutes(app: FastifyInstance) {
  app.post(`${BASE}/pages/:pid/region/:rid/form-designer`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const { pid, rid } = req.params as { pid: string; rid: string };
    const r = /^\d{1,9}$/.test(pid) && /^\d{1,9}$/.test(rid)
      ? await owner.one<{ id: number; config: Config; app_id: number }>(
          `select r.id, r.config, p.app_id from meta.region r join meta.page p on p.id = r.page_id where r.id = $1 and r.page_id = $2 and r.type = 'form_designer'`, [rid, pid])
      : undefined;
    if (!r) return reply.code(404).send('Not found');
    const schemes = (await owner.query<{ name: string }>('select name from meta.authz_scheme where app_id = $1', [r.app_id])).rows;
    const lovs = (await owner.query<{ name: string }>('select name from meta.lov where app_id = $1', [r.app_id])).rows;
    const { config, errors } = await mergeFormDesignerSettings(r.config ?? {}, (req.body ?? {}) as Body,
      { authz: new Set(schemes.map((x) => x.name.toUpperCase())), lovs: new Set(lovs.map((x) => x.name.toUpperCase())) });
    await owner.query('update meta.region set config = $2 where id = $1', [r.id, JSON.stringify(config)]);
    if (errors.length) flash(s, errors.join(' '), 'error');
    else flash(s, 'Settings saved.');
    return back(reply, s, `${BASE}/pages/${pid}?c=region-${rid}`);
  });
}
