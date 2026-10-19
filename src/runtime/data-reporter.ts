import pg from 'pg';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { appDatasets, DATASET_NAME, datasetSql } from '../datasets.ts';
import { appTx, owner, runtime, savepoint } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { english } from '../i18n.ts';
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
//     "page_size": 25,
//     // (sprint 110) a workspace dataset as a source (the builder's Data Reporter): its joined tables, columns,
//     // labels, masks and row filter come from meta.dataset; label and description may be given here too
//     //   "sources": [{"id": "hr", "dataset": "hr"}]
//     "edit_authz": "SCHEME",     // who may build, change and save reports; others only run shared ones (default: everyone)
//     "admin_authz": "SCHEME",    // who may unpublish and delete anyone's reports of the region
//     "publishing": true          // shared reports are "published": a stable URL (/a/<alias>/reports/<id>), pinning
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
  description?: string;
}
export interface Source {
  id: string;
  label?: string;
  description?: string;
  schema: string;
  table: string;
  columns: SourceColumn[];
  /** (sprint 110) the name of a workspace dataset: schema and table are empty until resolveSources() */
  dataset?: string;
  /** (sprint 110) the dataset's SELECT (built by datasetSql from the checked definition) */
  sql?: string;
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
    if (s && typeof s === 'object' && SOURCE_ID.test(str(s.id)) && DATASET_NAME.test(str(s.dataset)) && !out.some((x) => x.id === s.id)) {
      out.push({ id: s.id, label: str(s.label) || undefined, description: str(s.description) || undefined, schema: '', table: '', columns: [], dataset: s.dataset });
      continue;
    }
    if (!s || typeof s !== 'object' || !SOURCE_ID.test(str(s.id)) || !str(s.schema) || !str(s.table) || out.some((x) => x.id === s.id)) continue;
    // never pgkiln's own or the system's tables
    if (RESERVED_SCHEMAS.test(s.schema)) continue;
    const columns = (Array.isArray(s.columns) ? s.columns : []).filter((c: any) => c && typeof c === 'object' && str(c.name));
    out.push({ id: s.id, label: str(s.label) || undefined, description: str(s.description) || undefined, schema: s.schema, table: s.table, columns });
  }
  return out;
}

/**
 * (sprint 110) The region's sources with its datasets filled in (schema, columns with labels, masks and descriptions,
 * the dataset's SELECT); a dataset source whose dataset is gone is left out.
 */
export async function resolveSources(r: { config: Record<string, any> }, appId: number): Promise<Source[]> {
  const list = sourcesOf(r);
  const names = [...new Set(list.map((s) => s.dataset).filter((x): x is string => !!x))];
  if (!names.length) return list;
  const sets = await appDatasets(runtime, appId, names);
  const out: Source[] = [];
  for (const s of list) {
    if (!s.dataset) {
      out.push(s);
      continue;
    }
    const d = sets.get(s.dataset);
    if (!d || !d.columns.length) continue;
    out.push({
      ...s, label: s.label ?? d.label, description: s.description ?? d.description, schema: d.schema, table: d.name, sql: datasetSql(d),
      columns: d.columns.map((c) => ({ name: c.name, ...(c.label ? { label: c.label } : {}), ...(c.format ? { format: c.format } : {}), ...(c.description ? { description: c.description } : {}) })),
    });
  }
  return out;
}

/** A column a user may use: offered by the developer and readable now. */
export interface Col {
  name: string;
  label: string;
  format?: string;
  description?: string;
  type: number;
}

const objectSql = (s: Source) => (s.sql ? `(${s.sql})` : `${pg.escapeIdentifier(s.schema)}.${pg.escapeIdentifier(s.table)}`);
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
      out.set(sc.name, { name: sc.name, label: tr(sc.label || heading(sc.name)), format: sc.format || undefined, description: sc.description ? tr(sc.description) : undefined, type: types.get(sc.name)! });
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

/** (sprint 110) May the current user build, change and save reports of this region (config.edit_authz)? */
export async function mayEdit(ctx: PageContext, r: Region) {
  const a = r.config.edit_authz;
  return typeof a === 'string' && a ? isAuthorized(ctx, a) : true;
}

/** (sprint 110) May the current user unpublish and delete anyone's reports of this region (config.admin_authz)? */
export async function mayModerate(ctx: PageContext, r: Region) {
  const a = r.config.admin_authz;
  return ctx.user !== 'nobody' && typeof a === 'string' && a ? isAuthorized(ctx, a) : false;
}

/** (sprint 110) Shared reports are called published (a stable URL, pins). */
const publishing = (r: Region) => r.config.publishing === true;

/** (sprint 110) A report's stable URL: /a/<alias>/reports/<id> (it opens the report on its page). */
export const reportLink = (ctx: PageContext, id: number) => `${ctx.base}/reports/${id}`;

const MAX_PINS = 20;
const pinsName = (r: Region) => `reporter.pins.${r.id}`;

/** (sprint 110) The published reports the current user pinned in this region (a user preference; with config.publishing). */
async function pinsOf(ctx: PageContext, r: Region): Promise<number[]> {
  if (ctx.user === 'nobody') return [];
  const c = ctx.client!;
  const v = (await savepoint(c, () => c.query<{ v: string | null }>('select meta.get_preference($1) as v', [pinsName(r)]))).rows[0]?.v ?? '';
  return v.split(',').filter((x) => /^\d{1,9}$/.test(x)).map(Number).slice(0, MAX_PINS);
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
  const sources = await resolveSources(r, ctx.app.id);
  if (!sources.length) return html`<p class="empty">${t('reporter.no_sources')}</p>`;
  // (sprint 110) users who may not edit only run saved reports: no editor, no reports of their own
  const edit = await mayEdit(ctx, r);
  const openId = Number(ctx.params.get(`${prefix}open`));
  let saved: Saved | undefined;
  if (Number.isInteger(openId) && openId > 0) {
    saved = (await savepoint(c, () => c.query<Saved>('select * from meta.data_reports where id = $1 and region_id = $2', [openId, r.id]))).rows[0];
    if (!saved) return html`<div class="alert alert-error" role="alert">${t('reporter.not_found')}</div>${await home(ctx, r, sources, edit)}`;
  }
  const edited = edit && ctx.params.has(`${prefix}src`);
  const sourceId = edited ? ctx.params.get(`${prefix}src`)! : saved ? str(saved.definition?.source) : '';
  if (!sourceId) return home(ctx, r, sources, edit);
  const source = sources.find((s) => s.id === sourceId);
  if (!source) return html`<div class="alert alert-error" role="alert">${t('reporter.unknown_source')}</div>${await home(ctx, r, sources, edit)}`;
  let cols: Map<string, Col>;
  try {
    cols = await availableColumns(c, source, ctx.locale.tr);
  } catch (e) {
    return html`<div class="alert alert-error" role="alert">${await publicError(ctx, e, `data reporter "${r.title ?? r.id}" source ${source.id}`)}</div>${await home(ctx, r, sources, edit)}`;
  }
  const def = checkDef(edited ? defFromParams(ctx.params, prefix) : saved!.definition, source.id, cols);
  return reportView(ctx, r, source, cols, def, saved, edited, edit);
}

/**
 * The Data Reporter's welcome page (APEX 26.1): a greeting, the data sources as
 * cards that start a report, a search over the reports, the user's own reports
 * (latest changed first) and the ones others shared. config.welcome = false
 * keeps the compact form (a list of sources and a Start button); welcome_title
 * and welcome_text replace the greeting.
 */
async function home(ctx: PageContext, r: Region, sources: Source[], edit = true): Promise<Raw> {
  const t = ctx.locale.t;
  const c = ctx.client!;
  const prefix = prefixOf(r);
  const q = (ctx.params.get(`${prefix}q`) ?? '').trim().slice(0, 100);
  const all = (
    await savepoint(c, () =>
      c.query<Saved & { updated_at: string }>(
        `select id, name, description, username, shared, own, definition, updated_at from meta.data_reports
          where region_id = $1 and ($2 = '' or position(lower($2) in lower(name || ' ' || coalesce(description, ''))) > 0)
          order by own desc, case when own then updated_at end desc, lower(name), id`, [r.id, q]),
    )
  ).rows;
  // (sprint 110) users who may not edit see the shared (published) reports only
  const reports = edit ? all : all.filter((x) => x.shared);
  const pub = publishing(r);
  const pins = pub ? await pinsOf(ctx, r) : [];
  const sharedTag = pub ? t('reporter.published_tag') : t('reporter.shared_tag');
  const labelOf = (id: string) => {
    const s = sources.find((x) => x.id === id);
    return s ? ctx.locale.tr(s.label || heading(s.table)) : id;
  };
  const list = (rows: (Saved & { updated_at: string })[]) =>
    html`<ul class="reporter-list">${rows.map((x) => html`<li>
      <a href="${url(ctx, r, new URLSearchParams([[`${prefix}open`, String(x.id)]]))}">${x.name}</a>
      <span class="muted">${labelOf(str(x.definition?.source))}${x.own ? html` · ${t('reporter.changed', { date: String(x.updated_at).slice(0, 10) })}` : html` · ${t('reporter.by', { user: x.username })}`}</span>${x.definition?.chart ? html` <span class="tag">${t('reporter.chart_tag')}</span>` : ''}${x.own && x.shared ? html` <span class="tag">${sharedTag}</span>` : ''}
      ${x.description ? html`<p class="muted reporter-desc">${x.description}</p>` : ''}
    </li>`)}</ul>`;
  const pinned = pins.map((id) => reports.find((x) => x.id === id)).filter((x): x is (typeof reports)[number] => !!x);
  const mine = edit ? reports.filter((x) => x.own) : [];
  const others = edit ? reports.filter((x) => !x.own) : reports;
  const keep = [...ctx.params.entries()].filter(([k]) => !k.startsWith(prefix) && !['clear', 'cs'].includes(k));
  const hidden = keep.map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`);
  const lists = html`${pinned.length ? html`<h3 class="reporter-h">${t('reporter.pinned')}</h3>${list(pinned)}` : ''}
    ${edit && ctx.user !== 'nobody' ? html`<h3 class="reporter-h">${t('reporter.my_reports')}</h3>${mine.length ? list(mine) : html`<p class="muted">${q ? t('reporter.no_match') : t('reporter.no_reports')}</p>`}` : ''}
    ${others.length ? html`<h3 class="reporter-h">${pub ? t('reporter.published_reports') : t('reporter.shared_reports')}</h3>${list(others)}`
      : edit ? '' : html`<h3 class="reporter-h">${pub ? t('reporter.published_reports') : t('reporter.shared_reports')}</h3><p class="muted">${q ? t('reporter.no_match') : t('reporter.no_published')}</p>`}`;

  if (r.config.welcome === false) {
    const form = `drn${r.id}`;
    ctx.detached.push(html`<form id="${form}" method="get" action="${ctx.base}/${ctx.page.page_no}">${hidden}</form>`);
    return html`<div class="reporter">
      ${edit ? html`<div class="reporter-new">
        <label class="label" for="${form}_src">${t('reporter.new')}</label>
        <div class="reporter-row">
          ${sel(`${prefix}src`, form, t('reporter.source'), sources.map((s) => [s.id, ctx.locale.tr(s.label || heading(s.table))]), sources[0].id, `${form}_src`)}
          <button class="btn btn-hot" form="${form}">${t('reporter.create')}</button>
        </div>
        ${sources.some((s) => s.description) ? html`<dl class="reporter-sources">${sources.filter((s) => s.description).map((s) => html`<dt>${ctx.locale.tr(s.label || heading(s.table))}</dt><dd>${ctx.locale.tr(s.description!)}</dd>`)}</dl>` : ''}
      </div>` : ''}
      ${lists}
    </div>`;
  }

  const title = typeof r.config.welcome_title === 'string' && r.config.welcome_title.trim() ? ctx.locale.tr(r.config.welcome_title) : t('reporter.welcome_title');
  const text = typeof r.config.welcome_text === 'string' && r.config.welcome_text.trim() ? ctx.locale.tr(r.config.welcome_text) : edit ? t('reporter.welcome_text') : t('reporter.welcome_viewer');
  // the search: a GET form of its own (detached: the region may sit inside the page's form)
  const search = `drq${r.id}`;
  const searchable = q !== '' || reports.length > 6;
  if (searchable) ctx.detached.push(html`<form id="${search}" method="get" action="${ctx.base}/${ctx.page.page_no}" role="search">${hidden}</form>`);
  return html`<div class="reporter reporter-welcome">
    <div class="reporter-hello"><h3 class="reporter-title">${title}</h3><p class="muted">${text}</p></div>
    ${edit ? html`<h3 class="reporter-h">${t('reporter.new')}</h3>
    <ul class="reporter-cards">${sources.map((s) => html`<li><a class="reporter-card" href="${url(ctx, r, new URLSearchParams([[`${prefix}src`, s.id]]))}">
      <strong>${ctx.locale.tr(s.label || heading(s.table))}</strong>
      ${s.description ? html`<span class="muted">${ctx.locale.tr(s.description)}</span>` : ''}
      <span class="reporter-card-meta">${t('reporter.columns_count', { n: s.columns.length })}</span></a></li>`)}</ul>` : ''}
    ${searchable ? html`<div class="reporter-row reporter-search"><input type="search" name="${prefix}q" value="${q}" form="${search}" aria-label="${t('reporter.search')}" placeholder="${t('reporter.search')}"><button class="btn" form="${search}">${t('reporter.search')}</button></div>` : ''}
    ${lists}
  </div>`;
}

async function reportView(ctx: PageContext, r: Region, source: Source, cols: Map<string, Col>, def: Def, saved: Saved | undefined, edited: boolean, edit = true): Promise<Raw> {
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
      <div class="reporter-checks">${[...cols.values()].map((x) => html`<label class="check"><input type="checkbox" name="${prefix}col" value="${x.name}" form="${form}"${shownCols.includes(x.name) ? raw(' checked') : ''}> ${x.label}${x.description ? html` <small class="muted reporter-coldesc">${x.description}</small>` : ''}</label>`)}</div>
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
  const pub = publishing(r);
  if (edit && ctx.user !== 'nobody') {
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
      ${share ? html`<label class="check"><input type="checkbox" name="shared" value="true" form="${sform}"${own?.shared ? raw(' checked') : ''}> ${pub ? t('reporter.publish_on_save') : t('reporter.share')}</label>` : ''}
      <div class="buttons">
        <button class="btn btn-hot" form="${sform}" name="mode" value="save">${t('report.save')}</button>
        ${own ? html`<button class="btn" form="${sform}" name="mode" value="new">${t('reporter.save_as_new')}</button>
          <button class="btn btn-danger" form="drd${r.id}" data-confirm="${t('reporter.delete_confirm', { name: own.name })}">${t('reporter.delete')}</button>` : ''}
      </div>
    </fieldset>`;
  }

  // (sprint 110) a saved report's actions: its stable URL, pin, publish / unpublish, an administrator's unpublish and delete
  let actions: Raw | '' = '';
  if (saved && ctx.user !== 'nobody') {
    const base = `${ctx.base}/${ctx.page.page_no}/reporter/${r.id}`;
    const csrf = html`<input type="hidden" name="__csrf" value="${ctx.session.csrf_token}">`;
    const post = (action: string, mode: string, label: string, cls = 'btn', confirm = '') => {
      const fid2 = `dra${r.id}_${action}_${mode}`;
      ctx.detached.push(html`<form id="${fid2}" method="post" action="${base}/${action}">${csrf}<input type="hidden" name="rep" value="${saved.id}"><input type="hidden" name="mode" value="${mode}"></form>`);
      return html`<button class="${cls}" form="${fid2}"${confirm ? html` data-confirm="${confirm}"` : ''}>${label}</button>`;
    };
    const pins = await pinsOf(ctx, r);
    const moderate = !saved.own && (await mayModerate(ctx, r));
    const buttons: Raw[] = [];
    if (pub && saved.shared) buttons.push(post('pin', pins.includes(saved.id) ? 'unpin' : 'pin', pins.includes(saved.id) ? t('reporter.unpin') : t('reporter.pin')));
    if (pub && saved.own && edit && (saved.shared || (await mayShare(ctx, r)))) buttons.push(post('publish', saved.shared ? 'unpublish' : 'publish', saved.shared ? t('reporter.unpublish') : t('reporter.publish'), saved.shared ? 'btn' : 'btn btn-hot'));
    if (moderate && saved.shared) buttons.push(post('publish', 'unpublish', t('reporter.unpublish')));
    if (moderate) buttons.push(post('delete', 'any', t('reporter.delete'), 'btn btn-danger', t('reporter.delete_confirm', { name: saved.name })));
    const link = pub && saved.shared ? reportLink(ctx, saved.id) : '';
    if (buttons.length || link)
      actions = html`<div class="reporter-actions">
        ${link ? html`<label class="label" for="${fid('link')}">${t('reporter.link')}</label><input id="${fid('link')}" class="reporter-link" readonly value="${link}"> <a href="${link}">${t('reporter.open_link')}</a>` : ''}
        ${buttons.length ? html`<div class="buttons">${buttons}</div>` : ''}
      </div>`;
  }

  return html`<div class="reporter">
    <div class="reporter-head">
      <a href="${url(ctx, r, null)}">‹ ${t('reporter.back')}</a>
      <h3 class="reporter-title">${title}</h3>
      <span class="muted">${saved ? html`${ctx.locale.tr(source.label || heading(source.table))}${saved.own ? '' : html` · ${t('reporter.by', { user: saved.username })}`}${saved.shared ? html` <span class="tag">${pub ? t('reporter.published_tag') : t('reporter.shared_tag')}</span>` : ''}` : ''}</span>
      ${saved?.description ? html`<p class="muted reporter-desc">${saved.description}</p>` : ''}
    </div>
    ${actions}
    ${edit ? editor : ''}
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

/** A report of the region the current user can see (own or shared), through meta.data_reports. */
async function reportOf(ctx: PageContext, r: Region, id: number) {
  if (!id) return undefined;
  return (await ctx.client!.query<{ id: number; name: string; own: boolean; shared: boolean }>('select id, name, own, shared from meta.data_reports where id = $1 and region_id = $2', [id, r.id])).rows[0];
}

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
      if (!(await mayEdit(ctx, r))) throw new Forbidden('edit');
      const source = (await resolveSources(r, ctx.app.id)).find((s) => s.id === params.get(`${prefix}src`));
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
    action(req, reply, async (ctx, r) => {
      const id = /^\d{1,9}$/.test(String(req.body?.rep ?? '')) ? Number(req.body!.rep) : 0;
      const rep = await reportOf(ctx, r, id);
      let done = false;
      if (rep?.own) {
        // (sprint 110) users who may not edit don't delete either
        if (!(await mayEdit(ctx, r))) throw new Forbidden('edit');
        done = (await ctx.client!.query<{ d: boolean }>('select meta.delete_data_report($1) as d', [id])).rows[0].d;
      } else if (rep) {
        // (sprint 110) an administrator of the region deletes anyone's (shared) report
        if (!(await mayModerate(ctx, r))) throw new Forbidden('moderate');
        done = !!(await owner.query('delete from meta.data_report where id = $1 and app_id = $2 and region_id = $3', [id, ctx.app.id, r.id])).rowCount;
      }
      return { message: ctx.locale.t(done ? 'reporter.deleted' : 'reporter.not_found'), back: new URLSearchParams() };
    }),
  );

  // (sprint 110) publish or unpublish a saved report: the owner (who may edit and share), or an administrator of the region (unpublish)
  app.post('/a/:alias/:page/reporter/:id/publish', async (req: Req, reply) =>
    action(req, reply, async (ctx, r) => {
      const t = ctx.locale.t;
      const id = /^\d{1,9}$/.test(String(req.body?.rep ?? '')) ? Number(req.body!.rep) : 0;
      const on = req.body?.mode === 'publish';
      const rep = await reportOf(ctx, r, id);
      if (!rep) return { message: t('reporter.not_found'), back: new URLSearchParams() };
      const allowed = rep.own ? (await mayEdit(ctx, r)) && (!on || (await mayShare(ctx, r))) : !on && (await mayModerate(ctx, r));
      if (!allowed) throw new Forbidden('publish');
      await owner.query('update meta.data_report set shared = $4, updated_at = now() where id = $1 and app_id = $2 and region_id = $3', [id, ctx.app.id, r.id, on]);
      return { message: t(on ? 'reporter.published' : 'reporter.unpublished', { name: rep.name }), back: new URLSearchParams([[`${prefixOf(r)}open`, String(id)]]) };
    }),
  );

  // (sprint 110) pin a shared report to the top of the region's list, or unpin it (a preference of the user)
  app.post('/a/:alias/:page/reporter/:id/pin', async (req: Req, reply) =>
    action(req, reply, async (ctx, r) => {
      const id = /^\d{1,9}$/.test(String(req.body?.rep ?? '')) ? Number(req.body!.rep) : 0;
      const rep = await reportOf(ctx, r, id);
      if (!rep?.shared || !publishing(r)) return { message: ctx.locale.t('reporter.not_found'), back: new URLSearchParams() };
      const pins = (await pinsOf(ctx, r)).filter((x) => x !== id);
      if (req.body?.mode === 'pin') pins.unshift(id);
      await ctx.client!.query('select meta.set_preference($1, $2)', [pinsName(r), pins.slice(0, MAX_PINS).join(',')]);
      return { message: ctx.locale.t(req.body?.mode === 'pin' ? 'reporter.pinned_msg' : 'reporter.unpinned_msg', { name: rep.name }), back: new URLSearchParams([[`${prefixOf(r)}open`, String(id)]]) };
    }),
  );

  // (sprint 110) a report's stable URL: its page with the report open (the page checks who may see it)
  app.get('/a/:alias/reports/:id', async (req: Req, reply) => {
    const id = /^\d{1,9}$/.test(String(req.params.id ?? '')) ? Number(req.params.id) : 0;
    const hit = id
      ? await owner.one<{ page_no: number; region_id: number; alias: string }>(
          `select p.page_no, d.region_id, a.alias from meta.data_report d join meta.app a on a.id = d.app_id
             join meta.region g on g.id = d.region_id join meta.page p on p.id = g.page_id
            where d.id = $1 and a.alias = $2 and d.shared`, [id, req.params.alias])
      : undefined;
    if (!hit) return simplePage(reply, 404, english('error.not_found'), english('reporter.not_found'));
    return reply.redirect(`/a/${encodeURIComponent(hit.alias)}/${hit.page_no}?dr${hit.region_id}_open=${id}`, 303);
  });
}
