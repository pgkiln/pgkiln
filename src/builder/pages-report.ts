// (sprint 193, NX-F3) The Pages report of an application's home (/builder/apps/:id): APEX's Pages report with
// Alias, Type, Updated and Updated by, filters (group, mode, type, authorization, lock, changed by) with counts,
// sortable columns and a column chooser kept per developer (meta.developer.page_columns, migration 170).
//
// Type comes from the page's regions (page-type.ts), Updated / Updated by from meta.page_change (src/history.ts
// recordHistory: every recorded change to a page's components, an import, a restore). The counts of regions,
// items, dynamic actions and processes are behind the chooser, hidden by default.
import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import type { Session } from '../session.ts';
import { conditionWords, serverCondition } from './conditions.ts';
import { ago } from './home.ts';
import type { BuilderKey, BuilderTranslate } from './i18n.ts';
import { tr } from './i18n.ts';
import { appLocks, lockText } from './locks.ts';
import { appIssues } from './team.ts';
import { back, BASE, csrf, designerUrl, developer, flash, region, type Req } from './ui.ts';
import { PAGE_TYPES, pageType, pageTypeKey, type PageType } from './page-type.ts';

/** The report's optional columns, in their order; Page and Name are always shown. */
export const PAGE_COLUMNS = ['alias', 'type', 'group', 'mode', 'updated', 'updated_by', 'conditions', 'authz', 'lock', 'protection', 'regions', 'items', 'das', 'processes'] as const;
export type PageColumn = (typeof PAGE_COLUMNS)[number];
/** Shown until a developer chooses: the counts are hidden. */
export const DEFAULT_PAGE_COLUMNS: readonly PageColumn[] = ['alias', 'type', 'group', 'mode', 'updated', 'updated_by', 'conditions', 'authz', 'lock', 'protection'];

const COLUMN_LABEL: Record<PageColumn, BuilderKey> = {
  alias: 'app.col.alias', group: 'app.col.group', mode: 'app.col.mode', type: 'app.col.type', regions: 'app.col.regions', items: 'app.col.items',
  das: 'app.col.das', processes: 'app.col.processes', conditions: 'app.col.conditions', authz: 'app.col.authz', protection: 'app.col.protection',
  lock: 'app.col.lock', updated: 'app.col.updated', updated_by: 'app.col.updated_by',
};
const NUMERIC = new Set<PageColumn>(['regions', 'items', 'das', 'processes']);
/** (UX-8) give way first when the table is narrow (.rep-fit, under 1150 px) */
const LOW = new Set<PageColumn>(['mode', 'protection']);
const colClass = (c: PageColumn) => [NUMERIC.has(c) ? 'num' : '', LOW.has(c) ? 'col-low' : ''].filter(Boolean).join(' ');

/** Sortable columns: page and name ascending, updated newest first. */
const SORTS = ['page', 'name', 'alias', 'group', 'type', 'updated', 'updated_by'] as const;
type Sort = (typeof SORTS)[number];
const descending = (k: Sort) => k === 'updated';

/** The columns a developer chose (unknown names dropped), or the default set. */
export function chosenColumns(stored: unknown): PageColumn[] {
  if (!Array.isArray(stored)) return [...DEFAULT_PAGE_COLUMNS];
  return PAGE_COLUMNS.filter((c) => stored.includes(c));
}

export interface ReportPage {
  id: number;
  page_no: number;
  name: string;
  alias: string;
  page_group: string | null;
  mode: string;
  authz: string | null;
  requires_auth: boolean;
  protection: string;
  regions: number;
  items: number;
  das: number;
  processes: number;
  region_types: { type: string; seq: number; id: number }[];
  updated_at: string | null;
  updated_by: string | null;
  change_source: string | null;
}

/** The filters of the report (query parameters); '' is all. */
export interface PageFilters {
  q: string;
  group: string;
  mode: string;
  type: string;
  authz: string;
  lock: string;
  by: string;
}

const FILTER_KEYS = ['group', 'mode', 'type', 'authz', 'lock', 'by'] as const;
type FilterKey = (typeof FILTER_KEYS)[number];

export function readFilters(query: Record<string, unknown> | undefined): PageFilters {
  const one = (k: string, max = 200) => (typeof query?.[k] === 'string' ? (query[k] as string).trim().slice(0, max) : '');
  return { q: one('q', 100), group: one('group'), mode: one('mode'), type: one('type'), authz: one('authz'), lock: one('lock'), by: one('by') };
}

/** The value a page has for a filter ('-': none). */
function facetValue(p: ReportPage & { type: PageType; locked: boolean }, k: FilterKey): string {
  switch (k) {
    case 'group': return p.page_group ?? '-';
    case 'mode': return p.mode;
    case 'type': return p.type;
    case 'authz': return !p.requires_auth ? 'public' : (p.authz ?? '-');
    case 'lock': return p.locked ? 'locked' : 'unlocked';
    case 'by': return p.updated_by ?? '-';
  }
}

const matchesSearch = (p: ReportPage, q: string) =>
  !q || String(p.page_no) === q || p.name.toLowerCase().includes(q.toLowerCase()) || p.alias.includes(q.toLowerCase());

/** The pages that pass the search and every filter but `skip` (a facet's counts leave out its own filter). */
export function filterPages<T extends ReportPage & { type: PageType; locked: boolean }>(pages: T[], f: PageFilters, skip?: FilterKey): T[] {
  return pages.filter((p) => matchesSearch(p, f.q) && FILTER_KEYS.every((k) => k === skip || !f[k] || facetValue(p, k) === f[k]));
}

/** Sort a copy of the pages by a column. */
export function sortPages<T extends ReportPage & { type: PageType }>(pages: T[], sort: string, typeLabel: (t: PageType) => string): T[] {
  const k = (SORTS as readonly string[]).includes(sort) ? (sort as Sort) : 'page';
  const text = (p: T): string => {
    switch (k) {
      case 'name': return p.name.toLowerCase();
      case 'alias': return p.alias;
      case 'group': return (p.page_group ?? '').toLowerCase();
      case 'type': return typeLabel(p.type).toLowerCase();
      case 'updated_by': return (p.updated_by ?? '').toLowerCase();
      default: return '';
    }
  };
  return [...pages].sort((a, b) => {
    if (k === 'page') return a.page_no - b.page_no;
    if (k === 'updated') {
      // newest first, pages without a recorded change last
      const ta = a.updated_at ? new Date(a.updated_at).getTime() : -Infinity, tb = b.updated_at ? new Date(b.updated_at).getTime() : -Infinity;
      return tb - ta || a.page_no - b.page_no;
    }
    const x = text(a), y = text(b);
    // empty values last
    if (!x !== !y) return x ? -1 : 1;
    return x < y ? -1 : x > y ? 1 : a.page_no - b.page_no;
  });
}

/** The application's pages with their counts, region types and last change. */
export async function reportPages(appId: number): Promise<ReportPage[]> {
  return (await owner.query<ReportPage>(
    `select p.id, p.page_no, p.name, p.alias, p.page_group, p.mode, p.authz, p.requires_auth, p.protection,
            (select count(*) from meta.region r where r.page_id = p.id)::int as regions,
            (select count(*) from meta.item i where i.page_id = p.id)::int as items,
            (select count(*) from meta.dynamic_action d where d.page_id = p.id)::int as das,
            (select count(*) from meta.process x where x.page_id = p.id)::int as processes,
            coalesce((select jsonb_agg(jsonb_build_object('type', r.type, 'seq', r.seq, 'id', r.id)) from meta.region r where r.page_id = p.id), '[]') as region_types,
            c.updated_at::text as updated_at, c.updated_by, c.source as change_source
       from meta.page p left join meta.page_change c on c.app_id = p.app_id and c.page_no = p.page_no
      where p.app_id = $1 order by p.page_no`,
    [appId],
  )).rows;
}

const KIND_LABEL: Record<string, BuilderKey> = { region: 'app.cond.region', item: 'app.cond.item', button: 'app.cond.button', validation: 'app.cond.validation', process: 'app.cond.process', da: 'app.cond.da' };

/** (sprint 183, CD-2) the server-side conditions of each page's components, in words (as the Page Designer's badges) */
async function conditionsPerPage(appId: number, tx: BuilderTranslate) {
  const out = new Map<number, { kind: string; name: string; words: string }[]>();
  for (const r of (await owner.query<{ page_no: number; kind: string; name: string; row: Record<string, unknown> }>(
    `select p.page_no, x.kind, x.name, x.row from meta.page p cross join lateral (
        select 'region' as kind, r.title as name, to_jsonb(r) as row, r.seq as seq from meta.region r where r.page_id = p.id
        union all select 'item', i.name, to_jsonb(i), i.seq from meta.item i where i.page_id = p.id
        union all select 'button', b.name, to_jsonb(b), b.seq from meta.button b where b.page_id = p.id
        union all select 'validation', v.name, to_jsonb(v), v.seq from meta.validation v where v.page_id = p.id
        union all select 'process', pr.name, to_jsonb(pr), pr.seq from meta.process pr where pr.page_id = p.id
        union all select 'da', d.name, to_jsonb(d) - 'condition_type' - 'condition_value', d.seq from meta.dynamic_action d where d.page_id = p.id) x
      where p.app_id = $1 order by p.page_no, x.kind, x.seq`, [appId])).rows) {
    const c = serverCondition(r.row);
    if (!c) continue;
    const list = out.get(r.page_no) ?? [];
    list.push({ kind: r.kind, name: r.name ?? '', words: conditionWords(tx, c) });
    out.set(r.page_no, list);
  }
  return out;
}

/**
 * The search bar, the filters and the report (or the icon view) of an application's pages. Settings: the query
 * string (q, view, sort and the filters); the sort is remembered for the session, the columns per developer.
 */
export async function pagesReport(s: Session & { username?: string | null }, a: { id: number; alias: string }, query: Record<string, unknown> | undefined): Promise<Raw> {
  const tx = tr(s);
  const f = readFilters(query);
  const icons = query?.view === 'icons';
  if (typeof query?.sort === 'string' && (SORTS as readonly string[]).includes(query.sort)) s.state.__PSORT = query.sort;
  const sort: Sort = typeof s.state.__PSORT === 'string' && (SORTS as readonly string[]).includes(s.state.__PSORT) ? (s.state.__PSORT as Sort) : 'page';
  const [rows, groupRows, locks, comments, issues, conds, dev] = await Promise.all([
    reportPages(a.id),
    owner.query<{ name: string }>('select name from meta.page_group where app_id = $1 order by name', [a.id]),
    appLocks(a.id),
    owner.query('select page_no, count(*)::int as n from meta.dev_comment where app_id = $1 group by 1', [a.id]),
    appIssues(a.id),
    conditionsPerPage(a.id, tx),
    s.username ? owner.one<{ page_columns: string[] | null }>('select page_columns from meta.developer where username = $1', [s.username]) : null,
  ]);
  const lockOf = new Map(locks.map((l) => [l.page_no, l]));
  const commentsPerPage = new Map(comments.rows.map((r) => [r.page_no, r.n]));
  const groups = groupRows.rows.map((g) => g.name);
  const grouped = groups.length > 0 || rows.some((p) => p.page_group);
  const typeLabel = (t: PageType) => tx(pageTypeKey(t));
  const modeLabel = (m: string) => (m === 'modal' ? tx('pdz.modal_dialog') : tx('pdz.normal'));
  const pages = rows.map((p) => ({ ...p, type: pageType(p.region_types), locked: lockOf.has(p.page_no) }));
  const shown = sortPages(filterPages(pages, f), sort, typeLabel);
  const columns = chosenColumns(dev?.page_columns ?? null).filter((c) => c !== 'group' || grouped);

  const params = (extra: Record<string, string>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ q: f.q, group: f.group, mode: f.mode, type: f.type, authz: f.authz, lock: f.lock, by: f.by, ...(icons ? { view: 'icons' } : {}), ...extra })) if (v) p.set(k, v);
    const qs = p.toString();
    return qs ? `?${qs}` : '?';
  };

  // ------------------------------------------------------------ filters with counts (APEX: Browse by facets)
  const facet = (k: FilterKey, label: string, options: [string, string][]) => {
    const counts = new Map<string, number>();
    for (const p of filterPages(pages, f, k)) counts.set(facetValue(p, k), (counts.get(facetValue(p, k)) ?? 0) + 1);
    const opts = options.filter(([v]) => counts.has(v) || v === f[k]);
    return html`<div class="field"><label class="label" for="pf_${k}">${label}</label>
      <select id="pf_${k}" name="${k}" data-autosubmit><option value="">${tx('app.filter.all')}</option>${opts.map(([v, l]) =>
        html`<option value="${v}"${v === f[k] ? raw(' selected') : ''}>${l} (${counts.get(v) ?? 0})</option>`)}</select></div>`;
  };
  const authzValues = [...new Set(pages.map((p) => facetValue(p, 'authz')))].filter((v) => v !== 'public' && v !== '-').sort();
  const byValues = [...new Set(pages.map((p) => p.updated_by).filter((v): v is string => !!v))].sort();
  const filtering = FILTER_KEYS.some((k) => f[k]);
  const filters = html`<form method="get" class="pages-filters" aria-label="${tx('app.filters')}">
      ${f.q ? html`<input type="hidden" name="q" value="${f.q}">` : ''}${icons ? html`<input type="hidden" name="view" value="icons">` : ''}
      ${grouped ? facet('group', tx('app.col.group'), [...groups.map((g): [string, string] => [g, g]), ...[...new Set(pages.map((p) => p.page_group).filter((g): g is string => !!g && !groups.includes(g)))].map((g): [string, string] => [g, g]), ['-', tx('app.no_group')]]) : ''}
      ${facet('mode', tx('app.col.mode'), [['normal', tx('pdz.normal')], ['modal', tx('pdz.modal_dialog')]])}
      ${facet('type', tx('app.col.type'), PAGE_TYPES.map((t): [string, string] => [t, typeLabel(t)]))}
      ${facet('authz', tx('app.col.authz'), [['public', tx('app.public')], ['-', tx('app.filter.signin')], ...authzValues.map((v): [string, string] => [v, v])])}
      ${facet('lock', tx('app.col.lock'), [['locked', tx('app.filter.locked')], ['unlocked', tx('app.filter.unlocked')]])}
      ${facet('by', tx('app.col.updated_by'), [...byValues.map((v): [string, string] => [v, v === s.username ? `${v} (${tx('app.you')})` : v]), ['-', tx('app.filter.nobody')]])}
      <div class="pages-filters-actions"><noscript><button class="btn btn-sm">${tx('common.show')}</button></noscript>
        ${filtering ? html`<a class="btn btn-sm" href="${params({ group: '', mode: '', type: '', authz: '', lock: '', by: '' })}">${tx('app.filter.clear')}</a>` : ''}
        <span class="muted small" aria-live="polite">${tx('app.filter.count', { n: shown.length, total: pages.length })}</span></div>
    </form>`;

  // ------------------------------------------------------------ the column chooser (kept per developer)
  const chooser = html`<details class="menu pages-columns"><summary class="btn">${icon('sliders')} ${tx('app.columns')}</summary>
      <div class="menu-panel"><form method="post" action="${BASE}/page-columns" class="pages-columns-form">${csrf(s)}
        <input type="hidden" name="app" value="${a.id}"><input type="hidden" name="back" value="${params({})}">
        <fieldset><legend class="small muted">${tx('app.columns_help')}</legend>
        ${PAGE_COLUMNS.map((c) => html`<label class="check"><input type="checkbox" name="col" value="${c}"${columns.includes(c) || (c === 'group' && !grouped && chosenColumns(dev?.page_columns ?? null).includes('group')) ? raw(' checked') : ''}> ${tx(COLUMN_LABEL[c])}</label>`)}
        </fieldset>
        <div class="buttons"><button class="btn btn-sm">${tx('common.save')}</button><button class="btn btn-sm" name="reset" value="1">${tx('app.columns_reset')}</button></div>
      </form></div></details>`;

  // ------------------------------------------------------------ cells
  const conditionsCell = (n: number) => {
    const list = conds.get(n);
    if (!list?.length) return html`<span class="muted">—</span>`;
    return html`<details class="page-conds"><summary>${tx(list.length === 1 ? 'app.conditions_one' : 'app.conditions', { n: list.length })}</summary>
      <ul class="u-m0">${list.map((x) => html`<li><span class="muted small">${tx(KIND_LABEL[x.kind])}</span> <b>${x.name}</b>: ${x.words}</li>`)}</ul></details>`;
  };
  const by = (p: ReportPage) => (p.updated_by ? (p.updated_by === s.username ? html`${p.updated_by} <span class="muted small">(${tx('app.you')})</span>` : p.updated_by) : p.change_source === 'import' ? html`<span class="muted">${tx('app.by_import')}</span>` : html`<span class="muted">—</span>`);
  const cell = (p: (typeof pages)[number], c: PageColumn): Raw => {
    switch (c) {
      case 'alias': return html`<td><code class="page-alias">${p.alias}</code></td>`;
      case 'group': return html`<td>${p.page_group ?? ''}</td>`;
      case 'mode': return html`<td class="col-low">${modeLabel(p.mode)}</td>`;
      case 'type': return html`<td>${typeLabel(p.type)}</td>`;
      case 'regions': case 'items': case 'das': case 'processes': return html`<td class="num">${p[c]}</td>`;
      case 'conditions': return html`<td>${conditionsCell(p.page_no)}</td>`;
      case 'authz': return html`<td>${p.requires_auth ? (p.authz ?? '—') : tx('app.public')}</td>`;
      case 'protection': return html`<td class="col-low">${p.protection}</td>`;
      case 'lock': {
        const l = lockOf.get(p.page_no);
        return html`<td>${l ? html`<span class="lock-tag" title="${lockText(l)}">${icon('key')}<span>${l.locked_by === s.username ? tx('app.you') : l.locked_by}</span></span>` : '—'}</td>`;
      }
      case 'updated': return html`<td class="nowrap">${p.updated_at ? html`<time datetime="${new Date(p.updated_at).toISOString()}" title="${p.updated_at.slice(0, 16)}">${ago(p.updated_at, Date.now(), tx)}</time>` : html`<span class="muted">—</span>`}</td>`;
      case 'updated_by': return html`<td>${by(p)}</td>`;
    }
  };
  const th = (key: Sort | null, label: string, cls = '') => {
    const attrs = cls ? raw(` class="${cls}"`) : '';
    if (!key) return html`<th${attrs}>${label}</th>`;
    const on = sort === key;
    return html`<th${attrs}${on ? raw(` aria-sort="${descending(key) ? 'descending' : 'ascending'}"`) : ''}><a href="${params({ sort: key })}">${label}${on ? html`<span class="ab-sorted" aria-hidden="true">${descending(key) ? '↓' : '↑'}</span>` : ''}</a></th>`;
  };
  const sortKey = (c: PageColumn): Sort | null => ((SORTS as readonly string[]).includes(c) ? (c as Sort) : null);

  const bar = html`<div class="pages-bar">
      <form method="get" class="search u-mwnone" role="search">${FILTER_KEYS.map((k) => (f[k] ? html`<input type="hidden" name="${k}" value="${f[k]}">` : ''))}${icons ? html`<input type="hidden" name="view" value="icons">` : ''}
        <label class="sr-only" for="f_pq">${tx('app.search_pages')}</label><input id="f_pq" name="q" type="search" value="${f.q}" placeholder="${tx('app.search_placeholder')}" data-filter-rows="pages-rows">
        <button class="btn">${icon('search')}<span class="sr-only">${tx('common.search')}</span></button></form>
      <div class="seg view-toggle" role="group" aria-label="${tx('ab.view')}">
        <a href="${params({ view: '' })}"${icons ? '' : raw(' aria-current="true"')}>${icon('list')} ${tx('ab.view_report')}</a><a href="${params({ view: 'icons' })}"${icons ? raw(' aria-current="true"') : ''}>${icon('grid')} ${tx('app.view_icons')}</a></div>
      ${icons ? '' : chooser}
    </div>`;

  const body = icons
    ? html`<ul class="page-icons" id="pages-rows">${shown.map((p) => html`<li><a href="${designerUrl(a.id, p.page_no)}" class="page-icon"><span class="page-icon-no">${p.page_no}</span><b>${p.name}</b><small class="muted">${typeLabel(p.type)}, ${modeLabel(p.mode)}, ${tx(p.regions === 1 ? 'app.regions_one' : 'app.regions', { n: p.regions })}</small></a></li>`)}</ul>`
    : html`<div class="table-wrap rep-fit"><table class="report pages-report">
        <thead><tr>${th('page', tx('app.col.page'), 'num')}${th('name', tx('ab.col.name'))}${columns.map((c) => th(sortKey(c), tx(COLUMN_LABEL[c]), colClass(c)))}<th class="col-actions"><span class="sr-only">${tx('common.run')}</span></th></tr></thead>
        <tbody id="pages-rows">${shown.map((p) => html`<tr>
          <td class="num">${p.page_no}</td><td><a href="${designerUrl(a.id, p.page_no)}">${p.name}</a>${commentsPerPage.get(p.page_no) ? html` <span class="tag" title="${tx('app.dev_comments')}">${tx(commentsPerPage.get(p.page_no) === 1 ? 'app.comments_one' : 'app.comments', { n: commentsPerPage.get(p.page_no) })}</span>` : ''}${issues.tag(p.page_no)}</td>${columns.map((c) => cell(p, c))}
          <td class="col-actions"><a href="/a/${a.alias}/${p.alias}" target="_blank" rel="noopener">${tx('common.run')} ▸</a></td></tr>`)}</tbody>
      </table></div>`;

  return html`${bar}${region(tx('app.tab.pages'), html`${filters}${body}${f.q && !shown.length ? html`<p class="muted">${tx('app.no_match', { q: f.q })}</p>` : !shown.length ? html`<p class="muted">${tx('app.filter.none')}</p>` : ''}`)}`;
}

export async function pagesReportRoutes(app: FastifyInstance) {
  // the column chooser: kept per developer (not an application change: the URL is not under /apps/:id)
  app.post(`${BASE}/page-columns`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = req.body ?? {};
    const picked = b.reset ? null : PAGE_COLUMNS.filter((c) => [b.col ?? []].flat().includes(c));
    await owner.query('update meta.developer set page_columns = $2 where username = $1', [s.username, picked]);
    flash(s, tr(s)('app.columns_saved'));
    const appId = /^\d{1,9}$/.test(String(b.app ?? '')) ? Number(b.app) : null;
    // back to the same report: only our own query string (filters, sort, view), never another URL
    const qs = typeof b.back === 'string' && /^\?[\w%=&.+*-]*$/.test(b.back) ? b.back : '';
    return back(reply, s, appId ? `${BASE}/apps/${appId}${qs === '?' ? '' : qs}` : `${BASE}/apps`);
  });
}
