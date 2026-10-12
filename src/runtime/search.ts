// Search region and search configurations (APEX 22.2: the Search region and
// Shared Components → Search Configurations), migration 080.
//
// A search region searches the configurations it names (all of the
// application's when it names none) with one search field, or with a page
// item's value ({"item": "P1_SEARCH"}), and shows the results grouped per
// configuration, the matched words marked. Each configuration searches:
//
//  - table: a table or view, its columns quoted as identifiers;
//  - sql:   a SELECT (binds allowed), wrapped as a subquery;
//  - list:  the entries of a list (Shared Components → Lists) the user may see.
//
// Every word of the search text must be found in one of the searchable
// columns (ILIKE, % and _ escaped, the text as a query parameter). The
// queries run as the application's role in the page's transaction, each in a
// savepoint, so one configuration that fails shows its error and the others
// still answer. Without JavaScript the field is a GET form; app.js searches
// as the user types (the region endpoint, see routes.ts).
import pg from 'pg';
import { applyBinds } from '../binds.ts';
import { runtime, savepoint } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import type { Region } from '../metadata.ts';
import { bindValues, publicError, stripSemicolon, type PageContext } from './context.ts';
import { fillItems, linkAttrs } from './links.ts';
import { listTree, type ListNode } from './lists.ts';

const ident = pg.escapeIdentifier;

export interface SearchConfig {
  name: string;
  label: string;
  seq: number;
  source_type: 'table' | 'sql' | 'list';
  source: string;
  searchable_columns: string[];
  title_column: string | null;
  subtitle_column: string | null;
  description_column: string | null;
  badge_column: string | null;
  icon: string | null;
  link: { page?: number; items?: Record<string, string> } | null;
  max_results: number;
}

export interface SearchRegionConfig {
  configs?: string[];
  item?: string;
  placeholder?: string;
  min_length?: number;
  empty?: string;
}

/** At most this many words of the search text count. */
const MAX_WORDS = 8;
const MAX_TEXT = 200;
const COLUMN = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
const TABLE = /^([A-Za-z_][A-Za-z0-9_$]{0,62}\.)?[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

/** The columns a configuration names (for the Advisor's check of its source). */
export const configColumns = (c: Pick<SearchConfig, 'title_column' | 'subtitle_column' | 'description_column' | 'badge_column' | 'searchable_columns' | 'icon'>) =>
  [...new Set([c.title_column, c.subtitle_column, c.description_column, c.badge_column, ...(c.searchable_columns ?? []), /^#(.+)#$/.exec(c.icon ?? '')?.[1]]
    .filter((x): x is string => !!x && COLUMN.test(x)))];

/** The words of a search text (at most MAX_WORDS, each once, case kept). */
export function searchWords(text: string | null | undefined) {
  const words = (text ?? '').slice(0, MAX_TEXT).split(/\s+/).map((w) => w.trim()).filter(Boolean);
  return [...new Map(words.map((w) => [w.toLowerCase(), w])).values()].slice(0, MAX_WORDS);
}

/** A word as an ILIKE pattern that matches it anywhere, literally. */
export const likePattern = (word: string) => `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** The parameter of the region's own search field. */
export const searchParam = (r: Region) => `s${r.id}`;

/** Problems of a configuration (the builder shows them; the runtime refuses the configuration). */
export function searchConfigProblems(c: Partial<SearchConfig>): string[] {
  const out: string[] = [];
  const cols = [c.title_column, c.subtitle_column, c.description_column, c.badge_column, ...(c.searchable_columns ?? [])].filter((x): x is string => !!x);
  if (c.source_type !== 'list') {
    for (const col of cols) if (!COLUMN.test(col)) out.push(`"${col}" is not a column name.`);
    if (!c.title_column) out.push('Choose the column that is the title of each result.');
  }
  if (c.source_type === 'sql' && !/^\s*(select|with)\b/i.test(c.source ?? '')) out.push('The source of an SQL query configuration is a SELECT.');
  if (c.source_type === 'table' && !TABLE.test((c.source ?? '').trim())) out.push('The source of a table configuration is a table or view name, e.g. sales.customers.');
  if (c.icon && !/^(#[A-Za-z_][A-Za-z0-9_$]*#|[a-z0-9-]{1,40})$/.test(c.icon)) out.push('The icon is an icon name, or #COLUMN# for a column that holds icon names.');
  if (c.link && (typeof c.link !== 'object' || !Number.isInteger(c.link.page))) out.push('The link is {"page": 3, "items": {"P3_ID": "#ID#"}}.');
  return out;
}

/** The configurations a region searches, in sequence order (components of an excluded build option left out). */
async function configsOf(ctx: PageContext, r: Region): Promise<SearchConfig[]> {
  const conf = (r.config ?? {}) as SearchRegionConfig;
  const names = Array.isArray(conf.configs) ? conf.configs.map((n) => String(n).toUpperCase()) : [];
  return (
    await runtime.query<SearchConfig>(
      `select name, label, seq, source_type, source, searchable_columns, title_column, subtitle_column, description_column,
              badge_column, icon, link, max_results
         from meta.search_config
        where app_id = $1 and meta.build_option_on(app_id, build_option) and (cardinality($2::text[]) = 0 or name = any($2))
        order by seq, name`,
      [ctx.app.id, names],
    )
  ).rows;
}

interface Hit {
  title: string;
  subtitle: string | null;
  description: string | null;
  badge: string | null;
  icon: string | null;
  href: Raw | null;
}

const text = (v: unknown) => (v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** A row's value of a column, case-insensitively. */
function col(row: Record<string, unknown>, name: string | null) {
  if (!name) return null;
  const key = Object.keys(row).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? null : text(row[key]);
}

/** One configuration's results on a table or a query: up to max_results, and whether there are more. */
async function searchRows(ctx: PageContext, c: SearchConfig, words: string[]): Promise<{ hits: Hit[]; more: boolean }> {
  const searched = (c.searchable_columns.length ? c.searchable_columns : [c.title_column, c.subtitle_column, c.description_column]).filter(
    (x): x is string => !!x,
  );
  const conditions = words.map((_, i) => `(${searched.map((s) => `t.${ident(s)}::text ilike $${i + 1} escape '\\'`).join(' or ')})`);
  let from: string;
  if (c.source_type === 'table') {
    const table = (await ctx.client!.query('select $1::regclass::text as t', [c.source])).rows[0].t as string;
    from = `${table} t`;
  } else from = `(${stripSemicolon(applyBinds(c.source, bindValues(ctx)))}) t`;
  const sql = `select t.* from ${from} where ${conditions.join(' and ') || 'true'}${c.title_column ? ` order by t.${ident(c.title_column)}` : ''} limit ${c.max_results + 1}`;
  const res = await ctx.client!.query(sql, words.map(likePattern));
  const rows = res.rows as Record<string, unknown>[];
  const iconCol = /^#(.+)#$/.exec(c.icon ?? '')?.[1] ?? null;
  return {
    more: rows.length > c.max_results,
    hits: rows.slice(0, c.max_results).map((row) => ({
      title: col(row, c.title_column) ?? '',
      subtitle: col(row, c.subtitle_column),
      description: col(row, c.description_column),
      badge: col(row, c.badge_column),
      icon: iconCol ? col(row, iconCol) : c.icon,
      href:
        c.link && Number.isInteger(c.link.page)
          ? linkAttrs(ctx, c.link.page!, fillItems(c.link.items, (name) => col(row, name) ?? undefined))
          : null,
    })),
  };
}

/** One configuration's results on a list: the entries (and their children) the user may see. */
async function searchList(ctx: PageContext, c: SearchConfig, words: string[]): Promise<{ hits: Hit[]; more: boolean }> {
  const nodes = (await listTree(ctx, c.source)) ?? [];
  const flat: ListNode[] = [];
  const walk = (ns: ListNode[]) => ns.forEach((n) => (flat.push(n), walk(n.children)));
  walk(nodes);
  const found = flat.filter((n) => n.href && words.every((w) => `${n.label} ${n.description ?? ''}`.toLowerCase().includes(w.toLowerCase())));
  return {
    more: found.length > c.max_results,
    hits: found.slice(0, c.max_results).map((n) => ({
      title: n.label,
      subtitle: null,
      description: n.description,
      badge: n.badge,
      icon: n.icon ?? c.icon,
      href: html`href="${n.href}"${n.external ? raw(' rel="noopener noreferrer"') : ''}${n.modal ? raw(' data-dialog') : ''}`,
    })),
  };
}

/** The text with the search words marked (<mark>), escaped. */
export function marked(value: string, words: string[]): Raw {
  if (!words.length || !value) return html`${value}`;
  const re = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length).join('|'), 'gi');
  const parts: Raw[] = [];
  let last = 0;
  for (const m of value.matchAll(re)) {
    if (!m[0]) continue;
    parts.push(html`${value.slice(last, m.index)}<mark>${m[0]}</mark>`);
    last = m.index! + m[0].length;
  }
  parts.push(html`${value.slice(last)}`);
  return html`${parts}`;
}

/** The search text of a region: its page item's value, or its own field's. */
export function searchText(ctx: PageContext, r: Region) {
  const conf = (r.config ?? {}) as SearchRegionConfig;
  const item = typeof conf.item === 'string' ? conf.item.toUpperCase() : null;
  return ((item ? ctx.session.state[item] : ctx.params.get(searchParam(r))) ?? '').slice(0, MAX_TEXT);
}

/** The results part of a search region (also what app.js swaps in while the user types). */
async function searchResults(ctx: PageContext, r: Region, query: string): Promise<Raw> {
  const conf = (r.config ?? {}) as SearchRegionConfig;
  const words = searchWords(query);
  const minLength = Number.isInteger(conf.min_length) && conf.min_length! > 0 ? conf.min_length! : 1;
  if (!words.length || query.trim().length < minLength) return html``;
  const groups: Raw[] = [];
  for (const c of await configsOf(ctx, r)) {
    let body: Raw;
    try {
      const problems = searchConfigProblems(c);
      if (problems.length) throw new Error(`Search configuration ${c.name}: ${problems.join(' ')}`);
      const { hits, more } = await savepoint(ctx.client!, () => (c.source_type === 'list' ? searchList(ctx, c, words) : searchRows(ctx, c, words)));
      if (!hits.length) continue;
      body = html`<ul class="search-hits">${hits.map((h) => {
        const inner = html`${h.icon ? html`<span class="search-icon">${icon(h.icon)}</span>` : ''}
          <span class="search-text"><span class="search-title">${marked(h.title, words)}</span>${
            h.subtitle ? html`<span class="search-subtitle">${marked(h.subtitle, words)}</span>` : ''}${
            h.description ? html`<span class="search-description">${marked(h.description, words)}</span>` : ''}</span>
          ${h.badge ? html`<span class="badge-pill">${marked(h.badge, words)}</span>` : ''}`;
        return html`<li>${h.href ? html`<a class="search-hit" ${h.href}>${inner}</a>` : html`<div class="search-hit">${inner}</div>`}</li>`;
      })}</ul>${more ? html`<p class="muted search-more">${ctx.locale.t('region.first_rows', { n: String(c.max_results) })}</p>` : ''}`;
    } catch (e) {
      body = html`<div class="alert alert-error" role="alert">${await publicError(ctx, e, `search configuration ${c.name}`)}</div>`;
    }
    // the label is translated like the page's own texts (Shared Components → Globalization)
    groups.push(html`<section class="search-group"><h3>${ctx.locale.tr(c.label)}</h3>${body}</section>`);
  }
  // (a configuration that failed shows its error as a group of its own)
  return groups.length ? html`${groups}` : html`<p class="muted search-empty">${conf.empty ?? ctx.locale.t('lov.no_rows')}</p>`;
}

export async function renderSearch(ctx: PageContext, r: Region): Promise<Raw> {
  const conf = (r.config ?? {}) as SearchRegionConfig;
  const t = ctx.locale.t;
  const query = searchText(ctx, r);
  const results = html`<div class="search-results" id="R${r.id}_results" aria-live="polite">${await searchResults(ctx, r, query)}</div>`;
  if (typeof conf.item === 'string' && conf.item) return results;
  // its own field: a GET form that keeps the page's other parameters (item values with their checksum)
  const param = searchParam(r);
  const keep = [...ctx.params].filter(([k]) => k !== param);
  const fieldId = `R${r.id}_q`;
  return html`<form method="get" action="${ctx.base}/${ctx.page.page_no}" class="search-form" role="search">
      ${keep.map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
      <label class="label" for="${fieldId}">${t('report.search')}</label>
      <div class="input-with-button">
        <input type="search" id="${fieldId}" name="${param}" value="${query}" maxlength="${MAX_TEXT}" autocomplete="off"
          placeholder="${conf.placeholder ?? t('report.search_placeholder')}" data-search-region="${r.id}">
        <button class="btn">${icon('search')} ${t('report.search')}</button>
      </div>
    </form>
    ${results}`;
}
