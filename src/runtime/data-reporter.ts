import pg from 'pg';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { appTx, savepoint } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import type { Region } from '../metadata.ts';
import { logActivity, saveState } from '../session.ts';
import { checkPageAccess, computeVisibility, Forbidden, isAuthorized } from './authz.ts';
import { renderChartBody, REPORT_CHART_KINDS, type ChartKind } from './charts.ts';
import { publicError, type PageContext } from './context.ts';
import { heading } from './items.ts';
import { AGGREGATES, cell, isNumeric, OPERATORS, opLabel, regionUrl } from './report.ts';
import { loadContext, simplePage, txContext, type Req } from './routes.ts';

// Data Reporter (APEX 26.1): business users build their own reports in the
// running application from the data sources the developer offers in the
// region's settings:
//
//   config: {
//     "sources": [{"id": "employees", "label": "Employees", "description": "…",
//                  "schema": "hr", "table": "emp",
//                  "columns": [{"name": "ename", "label": "Name"}, {"name": "sal", "label": "Salary", "format": "FML999G990D00"}]}],
//     "sharing": true,            // users may share reports with everyone (default true)
//     "share_authz": "SCHEME",    // …but only users that pass this scheme (default: every signed-in user)
//     "page_size": 25
//   }
//
// A report is a definition (Def): the source, the columns, filters, group by
// columns with totals (count, sum, average, minimum, maximum), sort and an
// optional chart. It comes from the editor's GET form (dr<id>_* parameters,
// so it works without JavaScript and links can be shared) or from a saved
// report (meta.data_reports), and is always checked against the source's
// offered columns that the application's role can actually read before it
// runs. The query runs as the application's database role, so grants and row
// level security apply. Identifiers are only the developer's schema/table
// names and the offered column names, always quoted; values are escaped
// literals; operators and functions come from whitelists.

export interface SourceColumn {
  name: string;
  label?: string;
  format?: string;
}
export interface Source {
  id: string;
  label?: string;
  description?: string;
  schema: string;
  table: string;
  columns: SourceColumn[];
}
export interface Def {
  source: string;
  columns: string[];
  filters: { column: string; op: string; value: string }[];
  group: string[];
  aggregates: { fn: string; column: string }[];
  sort: { column: string; desc: boolean }[];
  chart: string | null;
}

export const LIMITS = { columns: 50, filters: 5, group: 3, aggregates: 5, sort: 3, value: 200 };
export const SOURCE_ID = /^[a-z][a-z0-9_]{0,39}$/;
export const RESERVED_SCHEMAS = /^(pg_.*|information_schema|meta)$/i;
const MAX_GROUPS = 1000;
const MAX_CHART_LABELS = 50;
const MAX_PAGE = 10_000;
const DEFAULT_PAGE_SIZE = 25;

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** The sources of a region's settings, leaving out malformed entries. */
export function sourcesOf(r: { config: Record<string, any> }): Source[] {
  const list = Array.isArray(r.config.sources) ? r.config.sources : [];
  const out: Source[] = [];
  for (const s of list) {
    if (!s || typeof s !== 'object' || !SOURCE_ID.test(str(s.id)) || !str(s.schema) || !str(s.table) || out.some((x) => x.id === s.id)) continue;
    // never pgapex's own or the system's tables
    if (RESERVED_SCHEMAS.test(s.schema)) continue;
    const columns = (Array.isArray(s.columns) ? s.columns : []).filter((c: any) => c && typeof c === 'object' && str(c.name));
    out.push({ id: s.id, label: str(s.label) || undefined, description: str(s.description) || undefined, schema: s.schema, table: s.table, columns });
  }
  return out;
}

/** A column a user may use: offered by the developer and readable now. */
export interface Col {
  name: string;
  label: string;
  format?: string;
  type: number;
}

const objectSql = (s: Source) => `${pg.escapeIdentifier(s.schema)}.${pg.escapeIdentifier(s.table)}`;
const q = (col: string) => `"__q".${pg.escapeIdentifier(col)}`;

/**
 * The offered columns of a source that exist in the table or view, with
 * their types, read as the application's role (no access: an error).
 */
export async function availableColumns(c: pg.PoolClient, s: Source, tr: (x: string) => string = (x) => x): Promise<Map<string, Col>> {
  const res = await savepoint(c, () => c.query(`select * from ${objectSql(s)} limit 0`));
  const types = new Map(res.fields.map((f) => [f.name, f.dataTypeID]));
  const out = new Map<string, Col>();
  for (const sc of s.columns)
    if (types.has(sc.name) && !out.has(sc.name))
      out.set(sc.name, { name: sc.name, label: tr(sc.label || heading(sc.name)), format: sc.format || undefined, type: types.get(sc.name)! });
  return out;
}

/** The loose definition in the editor's parameters (checked later by checkDef). */
export function defFromParams(p: URLSearchParams, prefix: string): Record<string, unknown> {
  const all = (k: string) => p.getAll(`${prefix}${k}`);
  const zip = <T>(a: string[], f: (x: string, i: number) => T) => a.map(f);
  const fo = all('fo');
  const fv = all('fv');
  const ac = all('ac');
  const sd = all('sd');
  return {
    source: p.get(`${prefix}src`) ?? '',
    columns: all('col'),
    filters: zip(all('fc'), (column, i) => ({ column, op: fo[i] ?? '', value: fv[i] ?? '' })),
    group: all('g'),
    aggregates: zip(all('af'), (fn, i) => ({ fn, column: ac[i] ?? '' })),
    sort: zip(all('sc'), (column, i) => ({ column, desc: sd[i] === 'desc' })),
    chart: p.get(`${prefix}ch`) ?? '',
  };
}

/** The editor's parameters of a definition. */
export function defParams(def: Def, prefix: string) {
  const p = new URLSearchParams();
  p.set(`${prefix}src`, def.source);
  for (const c of def.columns) p.append(`${prefix}col`, c);
  for (const f of def.filters) p.append(`${prefix}fc`, f.column), p.append(`${prefix}fo`, f.op), p.append(`${prefix}fv`, f.value);
  for (const g of def.group) p.append(`${prefix}g`, g);
  for (const a of def.aggregates) p.append(`${prefix}af`, a.fn), p.append(`${prefix}ac`, a.column);
  for (const s of def.sort) p.append(`${prefix}sc`, s.column), p.append(`${prefix}sd`, s.desc ? 'desc' : 'asc');
  if (def.chart) p.set(`${prefix}ch`, def.chart);
  return p;
}

/**
 * A definition with only what the columns allow: offered, readable columns,
 * whitelisted operators and functions, numeric columns for sum and average,
 * bounded counts and lengths. Anything else is dropped.
 */
export function checkDef(loose: any, sourceId: string, cols: Map<string, Col>): Def {
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  const isCol = (c: unknown): c is string => typeof c === 'string' && cols.has(c);
  const uniq = (xs: string[]) => [...new Set(xs)];
  const columns = uniq(arr(loose?.columns).filter(isCol)).slice(0, LIMITS.columns);
  const filters = arr(loose?.filters)
    .filter((f: any) => f && isCol(f.column) && Object.hasOwn(OPERATORS, str(f.op)))
    .map((f: any) => ({ column: f.column as string, op: f.op as string, value: OPERATORS[f.op].noValue ? '' : str(f.value).replace(/\0/g, '').slice(0, LIMITS.value) }))
    .filter((f) => OPERATORS[f.op].noValue || f.value !== '')
    .slice(0, LIMITS.filters);
  const group = uniq(arr(loose?.group).filter(isCol)).slice(0, LIMITS.group);
  const aggregates: Def['aggregates'] = [];
  for (const a of arr(loose?.aggregates)) {
    const fn = str(a?.fn);
    const column = str(a?.column);
    if (!Object.hasOwn(AGGREGATES, fn)) continue;
    if (column === '' ? fn !== 'count' : !isCol(column) || (AGGREGATES[fn].numeric && !isNumeric(cols.get(column)!.type))) continue;
    if (aggregates.some((x) => x.fn === fn && x.column === column) || aggregates.length >= LIMITS.aggregates) continue;
    aggregates.push({ fn, column });
  }
  const grouped = group.length > 0 || aggregates.length > 0;
  const measures = measuresOf({ group, aggregates });
  const sort: Def['sort'] = [];
  for (const s of arr(loose?.sort)) {
    const column = str(s?.column);
    const ok = /^#[1-9]$/.test(column) ? grouped && Number(column.slice(1)) <= measures.length : isCol(column) && (!grouped || group.includes(column));
    if (ok && !sort.some((x) => x.column === column) && sort.length < LIMITS.sort) sort.push({ column, desc: s.desc === true });
  }
  const chart = group.length && (REPORT_CHART_KINDS as string[]).includes(str(loose?.chart)) ? str(loose.chart) : null;
  return { source: sourceId, columns, filters, group, aggregates, sort, chart };
}

/** The totals a grouped report shows: the chosen ones, or the number of rows. */
const measuresOf = (d: Pick<Def, 'group' | 'aggregates'>) => (d.aggregates.length ? d.aggregates : d.group.length ? [{ fn: 'count', column: '' }] : []);

const measureSql = (a: { fn: string; column: string }) => (a.column ? AGGREGATES[a.fn].sql(q(a.column)) : 'count(*)');

/** The query of a definition: grouped (with totals) or the rows of one page. */
export function reportQuery(s: Source, def: Def, cols: Map<string, Col>, page = 1, size = DEFAULT_PAGE_SIZE) {
  const where = def.filters.map((f) => OPERATORS[f.op].sql(q(f.column), f.value));
  const from = `from ${objectSql(s)} "__q"${where.length ? ` where ${where.join(' and ')}` : ''}`;
  const measures = measuresOf(def);
  if (def.group.length || measures.length) {
    const select = [...def.group.map(q), ...measures.map(measureSql)];
    const order = def.sort.length
      ? def.sort.map((x) => `${x.column.startsWith('#') ? def.group.length + Number(x.column.slice(1)) : def.group.indexOf(x.column) + 1}${x.desc ? ' desc' : ''} nulls last`)
      : def.group.map((_, i) => `${i + 1} nulls last`);
    return {
      grouped: true,
      text: `select ${select.join(', ')} ${from}${def.group.length ? ` group by ${def.group.map((_, i) => i + 1).join(', ')}` : ''}${order.length ? ` order by ${order.join(', ')}` : ''} limit ${MAX_GROUPS + 1}`,
    };
  }
  const shown = def.columns.length ? def.columns : [...cols.keys()];
  const order = def.sort.map((x) => `${q(x.column)}${x.desc ? ' desc' : ''} nulls last`);
  return {
    grouped: false,
    text: `select ${shown.map(q).join(', ')} ${from}${order.length ? ` order by ${order.join(', ')}` : ''} limit ${size + 1} offset ${(page - 1) * size}`,
  };
}

/** The chart's query: the first group column as the label, numeric totals as the series. */
export function chartQuery(s: Source, def: Def, cols: Map<string, Col>) {
  const where = def.filters.map((f) => OPERATORS[f.op].sql(q(f.column), f.value));
  // counts, sums and averages are numbers; a minimum or maximum only of a numeric column
  const series = measuresOf(def).filter((a) => a.fn === 'count' || (a.column !== '' && isNumeric(cols.get(a.column)!.type)));
  if (!def.group.length || !series.length) return null;
  return {
    series,
    text: `select coalesce(${q(def.group[0])}::text, '—'), ${series.map(measureSql).join(', ')}
             from ${objectSql(s)} "__q"${where.length ? ` where ${where.join(' and ')}` : ''}
            group by 1 order by 1 limit ${MAX_CHART_LABELS + 1}`,
  };
}

// ---------------------------------------------------------------- rendering

interface Saved {
  id: number;
  region_id: number;
  username: string;
  name: string;
  description: string | null;
  shared: boolean;
  definition: any;
  own: boolean;
}

export const prefixOf = (r: { id: number }) => `dr${r.id}_`;

/** May the current user share reports of this region? */
export async function mayShare(ctx: PageContext, r: Region) {
  if (ctx.user === 'nobody' || r.config.sharing === false) return false;
  return typeof r.config.share_authz === 'string' && r.config.share_authz ? isAuthorized(ctx, r.config.share_authz) : true;
}

const pageSize = (r: Region) => {
  const n = Number(r.config.page_size);
  return Number.isInteger(n) && n >= 5 && n <= 200 ? n : DEFAULT_PAGE_SIZE;
};

/** A link to this page with the region's own parameters replaced. */
function url(ctx: PageContext, r: Region, own: URLSearchParams | null) {
  const prefix = prefixOf(r);
  return regionUrl(ctx, r, (p) => {
    for (const k of [...p.keys()]) if (k.startsWith(prefix)) p.delete(k);
    if (own) for (const [k, v] of own) p.append(k, v);
  });
}

const sel = (name: string, form: string, label: string, options: [string, string][], current: string, id?: string) =>
  html`<select name="${name}" form="${form}"${id ? raw(` id="${id}"`) : ''} aria-label="${label}">${options.map(([v, l]) => html`<option value="${v}"${v === current ? raw(' selected') : ''}>${l}</option>`)}</select>`;

/** The Data Reporter region: the list of reports, or one report with its editor. */
export async function renderDataReporter(ctx: PageContext, r: Region): Promise<Raw> {
  const t = ctx.locale.t;
  const c = ctx.client!;
  const prefix = prefixOf(r);
  const sources = sourcesOf(r);
  if (!sources.length) return html`<p class="empty">${t('reporter.no_sources')}</p>`;
  const openId = Number(ctx.params.get(`${prefix}open`));
  let saved: Saved | undefined;
  if (Number.isInteger(openId) && openId > 0) {
    saved = (await savepoint(c, () => c.query<Saved>('select * from meta.data_reports where id = $1 and region_id = $2', [openId, r.id]))).rows[0];
    if (!saved) return html`<div class="alert alert-error" role="alert">${t('reporter.not_found')}</div>${await home(ctx, r, sources)}`;
  }
  const edited = ctx.params.has(`${prefix}src`);
  const sourceId = edited ? ctx.params.get(`${prefix}src`)! : saved ? str(saved.definition?.source) : '';
  if (!sourceId) return home(ctx, r, sources);
  const source = sources.find((s) => s.id === sourceId);
  if (!source) return html`<div class="alert alert-error" role="alert">${t('reporter.unknown_source')}</div>${await home(ctx, r, sources)}`;
  let cols: Map<string, Col>;
  try {
    cols = await availableColumns(c, source, ctx.locale.tr);
  } catch (e) {
    return html`<div class="alert alert-error" role="alert">${await publicError(ctx, e, `data reporter "${r.title ?? r.id}" source ${source.id}`)}</div>${await home(ctx, r, sources)}`;
  }
  const def = checkDef(edited ? defFromParams(ctx.params, prefix) : saved!.definition, source.id, cols);
  return reportView(ctx, r, source, cols, def, saved, edited);
}

/** The reports the user may open, and a form to start a new one. */
async function home(ctx: PageContext, r: Region, sources: Source[]): Promise<Raw> {
  const t = ctx.locale.t;
  const c = ctx.client!;
  const prefix = prefixOf(r);
  const reports = (
    await savepoint(c, () =>
      c.query<Saved>('select id, name, description, username, shared, own, definition from meta.data_reports where region_id = $1 order by own desc, lower(name), id', [r.id]),
    )
  ).rows;
  const labelOf = (id: string) => {
    const s = sources.find((x) => x.id === id);
    return s ? ctx.locale.tr(s.label || heading(s.table)) : id;
  };
  const list = (rows: Saved[]) =>
    html`<ul class="reporter-list">${rows.map((x) => html`<li>
      <a href="${url(ctx, r, new URLSearchParams([[`${prefix}open`, String(x.id)]]))}">${x.name}</a>
      <span class="muted">${labelOf(str(x.definition?.source))}${x.own ? '' : html` · ${t('reporter.by', { user: x.username })}`}</span>${x.own && x.shared ? html` <span class="tag">${t('reporter.shared_tag')}</span>` : ''}
      ${x.description ? html`<p class="muted reporter-desc">${x.description}</p>` : ''}
    </li>`)}</ul>`;
  const mine = reports.filter((x) => x.own);
  const others = reports.filter((x) => !x.own);
  const form = `drn${r.id}`;
  const keep = [...ctx.params.entries()].filter(([k]) => !k.startsWith(prefix) && !['clear', 'cs'].includes(k));
  ctx.detached.push(html`<form id="${form}" method="get" action="${ctx.base}/${ctx.page.page_no}">${keep.map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}</form>`);
  return html`<div class="reporter">
    <div class="reporter-new">
      <label class="label" for="${form}_src">${t('reporter.new')}</label>
      <div class="reporter-row">
        ${sel(`${prefix}src`, form, t('reporter.source'), sources.map((s) => [s.id, ctx.locale.tr(s.label || heading(s.table))]), sources[0].id, `${form}_src`)}
        <button class="btn btn-hot" form="${form}">${t('reporter.create')}</button>
      </div>
      ${sources.some((s) => s.description) ? html`<dl class="reporter-sources">${sources.filter((s) => s.description).map((s) => html`<dt>${ctx.locale.tr(s.label || heading(s.table))}</dt><dd>${ctx.locale.tr(s.description!)}</dd>`)}</dl>` : ''}
    </div>
    ${ctx.user !== 'nobody' ? html`<h3 class="reporter-h">${t('reporter.my_reports')}</h3>${mine.length ? list(mine) : html`<p class="muted">${t('reporter.no_reports')}</p>`}` : ''}
    ${others.length ? html`<h3 class="reporter-h">${t('reporter.shared_reports')}</h3>${list(others)}` : ''}
  </div>`;
}

async function reportView(ctx: PageContext, r: Region, source: Source, cols: Map<string, Col>, def: Def, saved: Saved | undefined, edited: boolean): Promise<Raw> {
  const t = ctx.locale.t;
  const prefix = prefixOf(r);
  const form = `dre${r.id}`;
  const fid = (n: string) => `${form}_${n}`;
  const colOptions: [string, string][] = [...cols.values()].map((x) => [x.name, x.label]);
  const none: [string, string] = ['', t('report.none')];
  const measures = measuresOf(def);
  const measureLabel = (a: { fn: string; column: string }) => (a.column ? `${t(`agg.${a.fn}`)}: ${cols.get(a.column)!.label}` : t('reporter.count_rows'));

  // ---- the editor: one GET form (detached, the page itself is a POST form)
  const keep = [...ctx.params.entries()].filter(([k]) => !k.startsWith(prefix) && !['clear', 'cs'].includes(k));
  ctx.detached.push(html`<form id="${form}" method="get" action="${ctx.base}/${ctx.page.page_no}">${keep.map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
    <input type="hidden" name="${prefix}src" value="${source.id}">${saved ? html`<input type="hidden" name="${prefix}open" value="${saved.id}">` : ''}</form>`);
  const rows = <T>(current: T[], max: number, blank: T) => [...current, ...(current.length < max ? [blank] : [])];
  const shownCols = def.columns.length ? def.columns : def.group.length || def.aggregates.length ? [] : [...cols.keys()];
  const editor = html`<details class="reporter-editor"${!saved || edited ? raw(' open') : ''}>
    <summary>${t('reporter.edit')}</summary>
    <fieldset class="reporter-set"><legend>${t('reporter.columns')}</legend>
      <div class="reporter-checks">${[...cols.values()].map((x) => html`<label class="check"><input type="checkbox" name="${prefix}col" value="${x.name}" form="${form}"${shownCols.includes(x.name) ? raw(' checked') : ''}> ${x.label}</label>`)}</div>
    </fieldset>
    <fieldset class="reporter-set"><legend>${t('reporter.filters')}</legend>
      ${rows(def.filters, LIMITS.filters, { column: '', op: 'eq', value: '' }).map((f) => html`<div class="reporter-row">
        ${sel(`${prefix}fc`, form, t('report.column'), [none, ...colOptions], f.column)}
        ${sel(`${prefix}fo`, form, t('report.operator'), Object.keys(OPERATORS).map((k) => [k, opLabel(t, k)]), f.op)}
        <input name="${prefix}fv" form="${form}" value="${f.value}" maxlength="${LIMITS.value}" aria-label="${t('report.value')}" placeholder="${t('report.value')}">
      </div>`)}
    </fieldset>
    <fieldset class="reporter-set"><legend>${t('reporter.group')}</legend>
      <div class="reporter-row">${rows(def.group, LIMITS.group, '').map((g) => sel(`${prefix}g`, form, t('reporter.group'), [none, ...colOptions], g))}</div>
    </fieldset>
    <fieldset class="reporter-set"><legend>${t('reporter.aggregates')}</legend>
      ${rows(def.aggregates, LIMITS.aggregates, { fn: '', column: '' }).map((a) => html`<div class="reporter-row">
        ${sel(`${prefix}af`, form, t('report.function'), [none, ...Object.keys(AGGREGATES).map((k): [string, string] => [k, t(`agg.${k}`)])], a.fn)}
        ${sel(`${prefix}ac`, form, t('report.column'), [['', t('reporter.all_rows')], ...colOptions], a.column)}
      </div>`)}
      <small class="help">${t('reporter.aggregates_help')}</small>
    </fieldset>
    <fieldset class="reporter-set"><legend>${t('report.sort')}</legend>
      ${rows(def.sort, LIMITS.sort, { column: '', desc: false }).map((s) => html`<div class="reporter-row">
        ${sel(`${prefix}sc`, form, t('report.column'), [none, ...colOptions, ...measures.map((a, i): [string, string] => [`#${i + 1}`, measureLabel(a)])], s.column)}
        ${sel(`${prefix}sd`, form, t('report.sort'), [['asc', t('report.sort_asc')], ['desc', t('report.sort_desc')]], s.desc ? 'desc' : 'asc')}
      </div>`)}
    </fieldset>
    <fieldset class="reporter-set"><legend>${t('report.chart')}</legend>
      <div class="reporter-row">${sel(`${prefix}ch`, form, t('report.chart_type'), [['', t('reporter.no_chart')], ...REPORT_CHART_KINDS.map((k): [string, string] => [k, t(`chart.${k}`)])], def.chart ?? '', fid('chart'))}</div>
      <small class="help">${t('reporter.chart_help')}</small>
    </fieldset>
    <div class="buttons"><button class="btn btn-hot" form="${form}">${t('reporter.run')}</button></div>
  </details>`;

  // ---- the result
  const title = saved ? saved.name : ctx.locale.tr(source.label || heading(source.table));
  const result = await runReport(ctx, r, source, cols, def, measureLabel, title);

  // ---- saving (signed-in users)
  let save: Raw | '' = '';
  if (ctx.user !== 'nobody') {
    const share = await mayShare(ctx, r);
    const own = saved?.own ? saved : undefined;
    const sform = `drs${r.id}`;
    const base = `${ctx.base}/${ctx.page.page_no}/reporter/${r.id}`;
    const csrf = html`<input type="hidden" name="__csrf" value="${ctx.session.csrf_token}">`;
    ctx.detached.push(html`<form id="${sform}" method="post" action="${base}/save">${csrf}<input type="hidden" name="params" value="${defParams(def, prefix).toString()}">${own ? html`<input type="hidden" name="rep" value="${own.id}">` : ''}</form>`);
    if (own) ctx.detached.push(html`<form id="drd${r.id}" method="post" action="${base}/delete">${csrf}<input type="hidden" name="rep" value="${own.id}"></form>`);
    save = html`<fieldset class="reporter-set reporter-save"><legend>${own ? t('reporter.save_changes') : t('reporter.save_report')}</legend>
      <div class="reporter-row">
        <label class="label" for="${fid('name')}">${t('report.name')}</label>
        <input id="${fid('name')}" name="name" form="${sform}" required maxlength="80" value="${own?.name ?? ''}">
      </div>
      <div class="reporter-row">
        <label class="label" for="${fid('desc')}">${t('reporter.description')}</label>
        <input id="${fid('desc')}" name="description" form="${sform}" maxlength="500" value="${own?.description ?? ''}">
      </div>
      ${share ? html`<label class="check"><input type="checkbox" name="shared" value="true" form="${sform}"${own?.shared ? raw(' checked') : ''}> ${t('reporter.share')}</label>` : ''}
      <div class="buttons">
        <button class="btn btn-hot" form="${sform}" name="mode" value="save">${t('report.save')}</button>
        ${own ? html`<button class="btn" form="${sform}" name="mode" value="new">${t('reporter.save_as_new')}</button>
          <button class="btn btn-danger" form="drd${r.id}" data-confirm="${t('reporter.delete_confirm', { name: own.name })}">${t('reporter.delete')}</button>` : ''}
      </div>
    </fieldset>`;
  }

  return html`<div class="reporter">
    <div class="reporter-head">
      <a href="${url(ctx, r, null)}">‹ ${t('reporter.back')}</a>
      <h3 class="reporter-title">${title}</h3>
      <span class="muted">${saved ? html`${ctx.locale.tr(source.label || heading(source.table))}${saved.own ? '' : html` · ${t('reporter.by', { user: saved.username })}`}${saved.shared ? html` <span class="tag">${t('reporter.shared_tag')}</span>` : ''}` : ''}</span>
      ${saved?.description ? html`<p class="muted reporter-desc">${saved.description}</p>` : ''}
    </div>
    ${editor}
    ${result}
    ${save}
  </div>`;
}

async function runReport(ctx: PageContext, r: Region, source: Source, cols: Map<string, Col>, def: Def, measureLabel: (a: { fn: string; column: string }) => string, title: string): Promise<Raw> {
  const t = ctx.locale.t;
  const c = ctx.client!;
  const prefix = prefixOf(r);
  const size = pageSize(r);
  const pg0 = Number(ctx.params.get(`${prefix}pg`));
  const page = Number.isInteger(pg0) && pg0 > 1 ? Math.min(pg0, MAX_PAGE) : 1;
  const fmtOf = (name: string) => ctx.locale.masked(cols.get(name)?.format);
  try {
    const query = reportQuery(source, def, cols, page, size);
    const res = await savepoint(c, () => c.query({ text: query.text, rowMode: 'array' }));
    let chart: Raw | '' = '';
    const cq = def.chart ? chartQuery(source, def, cols) : null;
    if (cq) {
      const ch = await savepoint(c, () => c.query({ text: cq.text, rowMode: 'array' }));
      const fields = [{ name: cols.get(def.group[0])!.label }, ...cq.series.map((a) => ({ name: measureLabel(a) }))];
      if (ch.rows.length)
        chart = html`<div class="reporter-chart">${renderChartBody(def.chart as ChartKind, title, ch.rows.slice(0, MAX_CHART_LABELS), fields, ctx.css, ctx.locale.lang, t)}</div>
          ${ch.rows.length > MAX_CHART_LABELS ? html`<p class="muted">${t('report.chart_truncated', { labels: MAX_CHART_LABELS })}</p>` : ''}`;
    }
    let heads: { label: string; num: boolean; fmt: ReturnType<typeof fmtOf> }[];
    if (query.grouped) {
      heads = [
        ...def.group.map((g) => ({ label: cols.get(g)!.label, num: isNumeric(cols.get(g)!.type), fmt: fmtOf(g) })),
        ...measuresOf(def).map((a, i) => ({ label: measureLabel(a), num: isNumeric(res.fields[def.group.length + i].dataTypeID), fmt: a.fn === 'count' || !a.column ? ctx.locale.format : fmtOf(a.column) })),
      ];
    } else {
      const shown = def.columns.length ? def.columns : [...cols.keys()];
      heads = shown.map((n) => ({ label: cols.get(n)!.label, num: isNumeric(cols.get(n)!.type), fmt: fmtOf(n) }));
    }
    const limit = query.grouped ? MAX_GROUPS : size;
    const rows = res.rows.slice(0, limit);
    const more = res.rows.length > limit;
    const table = html`<div class="table-wrap"><table class="report report-reflow reporter-table" aria-label="${t('reporter.result')}">
      <thead><tr>${heads.map((h) => html`<th scope="col" class="${h.num ? 'num' : null}">${h.label}</th>`)}</tr></thead>
      <tbody>${rows.length
        ? rows.map((row) => html`<tr>${row.map((v: unknown, i: number) => html`<td class="${heads[i].num ? 'num' : null}" data-label="${heads[i].label}">${cell(v, res.fields[i].dataTypeID, heads[i].fmt)}</td>`)}</tr>`)
        : html`<tr><td colspan="${heads.length}" class="empty">${r.config.empty ?? t('report.no_data')}</td></tr>`}</tbody>
    </table></div>`;
    let pager: Raw | '' = '';
    if (query.grouped) {
      if (more) pager = html`<p class="muted">${t('report.view_truncated', { rows: MAX_GROUPS })}</p>`;
    } else if (more || page > 1) {
      const go = (n: number) => url(ctx, r, (() => {
        const own = new URLSearchParams([...ctx.params].filter(([k]) => k.startsWith(prefix) && k !== `${prefix}pg`));
        if (n > 1) own.set(`${prefix}pg`, String(n));
        return own;
      })());
      const from = (page - 1) * size + 1;
      pager = html`<nav class="pager" aria-label="${t('report.pagination')}">
        <span>${t('report.range_open', { from: rows.length ? from : 0, to: from + rows.length - 1 })}</span>
        ${page > 1 ? html`<a class="btn" href="${go(page - 1)}">‹ ${t('report.previous')}</a>` : ''}
        ${more && page < MAX_PAGE ? html`<a class="btn" href="${go(page + 1)}">${t('report.next')} ›</a>` : ''}
      </nav>`;
    }
    return html`<div class="reporter-result">${chart}${table}${pager}</div>`;
  } catch (e) {
    return html`<div class="alert alert-error" role="alert">${await publicError(ctx, e, `data reporter "${r.title ?? r.id}"`)}</div>`;
  }
}

// ---------------------------------------------------------------- saving and deleting

export async function dataReporterRoutes(app: FastifyInstance) {
  /** Shared checks: CSRF, a signed-in user, the region visible on the page; back to the page afterwards. */
  const action = async (req: Req, reply: FastifyReply, run: (ctx: PageContext, r: Region) => Promise<{ message: string; back: URLSearchParams }>) => {
    const ctx = await loadContext(req, reply);
    if (!ctx) return;
    const body = req.body ?? {};
    const refuse = (detail: string) => {
      logActivity({ appId: ctx.app.id, pageNo: ctx.page.page_no, username: ctx.user, event: 'forbidden', ip: ctx.ip, detail });
      return simplePage(reply, 403, ctx.locale.t('error.access_denied'), ctx.locale.t(detail.includes('csrf') ? 'error.session_reload' : 'error.report_unavailable'), `${ctx.base}/${ctx.page.page_no}`, ctx.locale);
    };
    if (typeof body.__csrf !== 'string' || body.__csrf !== ctx.session.csrf_token) return refuse('data reporter: csrf');
    if (ctx.user === 'nobody') return refuse('data reporter: not signed in');
    const r = ctx.page.regions.find((x) => x.id === Number(req.params.id) && x.type === 'data_reporter');
    if (!r) return refuse(`data reporter: region ${req.params.id} on page ${ctx.page.page_no}`);
    let back = new URLSearchParams();
    try {
      const out = await appTx(txContext(ctx), async (c) => {
        ctx.client = c;
        await checkPageAccess(ctx);
        const vis = await computeVisibility(ctx);
        if (!vis.regions.has(r.id)) throw new Forbidden(ctx.locale.t('error.report_unavailable'));
        return run(ctx, r);
      });
      ctx.session.state.__FLASH = out.message;
      back = out.back;
    } catch (e) {
      if (e instanceof Forbidden) return refuse(`data reporter: region ${r.id} on page ${ctx.page.page_no}`);
      ctx.session.state.__FLASH = await publicError(ctx, e, 'data reporter');
      // back to the report as it was, so nothing is lost
      const params = new URLSearchParams(typeof body.params === 'string' ? body.params.slice(0, 8000) : '');
      for (const [k, v] of params) if (k.startsWith(prefixOf(r))) back.append(k, v);
      if (/^\d{1,9}$/.test(String(body.rep ?? ''))) back.set(`${prefixOf(r)}open`, String(body.rep));
    }
    await saveState(ctx.session);
    const q = back.toString();
    return reply.redirect(`${ctx.base}/${ctx.page.page_no}${q ? `?${q}` : ''}`, 303);
  };

  app.post('/a/:alias/:page/reporter/:id/save', async (req: Req, reply) =>
    action(req, reply, async (ctx, r) => {
      const t = ctx.locale.t;
      const b = req.body ?? {};
      const prefix = prefixOf(r);
      const params = new URLSearchParams(typeof b.params === 'string' ? b.params.slice(0, 8000) : '');
      const source = sourcesOf(r).find((s) => s.id === params.get(`${prefix}src`));
      if (!source) throw new Forbidden('source');
      const cols = await availableColumns(ctx.client!, source);
      const def = checkDef(defFromParams(params, prefix), source.id, cols);
      const rep = b.mode !== 'new' && /^\d{1,9}$/.test(String(b.rep ?? '')) ? Number(b.rep) : null;
      const name = String(b.name ?? '').trim().slice(0, 80);
      if (!name) {
        const back = defParams(def, prefix);
        if (rep) back.set(`${prefix}open`, String(rep));
        return { message: t('reporter.name_required'), back };
      }
      const shared = b.shared === 'true' && (await mayShare(ctx, r));
      const description = String(b.description ?? '').trim().slice(0, 500);
      const id = (
        await ctx.client!.query<{ id: number }>('select meta.save_data_report($1, $2, $3, $4, $5::jsonb, $6) as id', [r.id, rep, name, description, JSON.stringify(def), shared])
      ).rows[0].id;
      return { message: t('reporter.saved', { name }), back: new URLSearchParams([[`${prefix}open`, String(id)]]) };
    }),
  );

  app.post('/a/:alias/:page/reporter/:id/delete', async (req: Req, reply) =>
    action(req, reply, async (ctx) => {
      const id = /^\d{1,9}$/.test(String(req.body?.rep ?? '')) ? Number(req.body!.rep) : 0;
      const done = (await ctx.client!.query<{ d: boolean }>('select meta.delete_data_report($1) as d', [id])).rows[0].d;
      return { message: ctx.locale.t(done ? 'reporter.deleted' : 'reporter.not_found'), back: new URLSearchParams() };
    }),
  );
}
