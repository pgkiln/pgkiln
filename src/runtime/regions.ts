import type { QueryResult } from 'pg';
import { applyBinds } from '../binds.ts';
import { savepoint } from '../db.ts';
import { esc, html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import type { Button, Region } from '../metadata.ts';
import { isAuthorized, pageAllowed } from './authz.ts';
import { bindValues, dbg, publicError, stripSemicolon, substitute, timed, type PageContext } from './context.ts';
import { renderItems } from './items.ts';
import { fillItems, linkAttrs, linkColumns } from './links.ts';
import { renderCalendar } from './calendar.ts';
import { CHART_KINDS, renderChartBody, wallClockIn, type GaugeConfig } from './charts.ts';
import { databaseTimeZone } from './locale.ts';
import { renderFacets } from './facets.ts';
import { renderSmartFilters } from './smart-filters.ts';
import { renderListRegion } from './lists.ts';
import { renderDisplaySelector } from './display-selector.ts';
import { renderGrid } from './grid.ts';
import { masterItemOf, mastersOf } from './master-detail.ts';
import { renderTasks } from './tasks.ts';
import { renderDataReporter } from './data-reporter.ts';
import { renderAssistant } from './assistant.ts';
import { renderAiFilter } from './ai-filter.ts';
import { renderWorkflows } from './workflows.ts';
import { renderMap } from './maps.ts';
import { renderTree } from './tree.ts';
import { renderTemplateRegion } from './template-region.ts';
import { formatNumber, maskError } from '../numformat.ts';
import { cell, columnFormats, maxRows, regionUrl, renderReport } from './report.ts';
import { cacheKey, cacheOf, lazyOf, renderCaching, useCached } from './region-cache.ts';
import { resolveRestRegion } from './rest-sources.ts';
import { templateClasses } from './template-options.ts';
import { renderPluginRegion } from './plugins.ts';

// ---------------------------------------------------------------- buttons

/** A button's badge: the badge query's first value, or the badge text with &ITEM. substitutions. */
async function badgeOf(ctx: PageContext, b: Button): Promise<Raw | ''> {
  let value: string | null = null;
  if (b.badge_query?.trim()) {
    const c = ctx.client!;
    const sql = stripSemicolon(applyBinds(b.badge_query, bindValues(ctx)));
    try {
      const res = await savepoint(c, () => c.query({ text: sql, rowMode: 'array' }));
      const v = res.rows[0]?.[0];
      value = v === null || v === undefined ? null : String(v);
    } catch (e) {
      ctx.errors.page.push(await publicError(ctx, e, `badge of button ${b.name}`));
    }
  } else if (b.badge) value = substitute(b.badge, ctx, (x) => x);
  value = value?.trim().slice(0, 100) || null;
  return value ? html` <span class="btn-badge">${value}</span>` : '';
}

/**
 * A menu button: a <details> dropdown (works without JavaScript) with links
 * to pages (signed item values, only pages the user may open) and submit
 * requests (only those computeVisibility allowed).
 */
async function renderMenu(ctx: PageContext, b: Button, cls: string, badge: Raw | '') {
  const entries = [];
  for (const e of b.menu ?? []) {
    if (!(await isAuthorized(ctx, e.authz))) continue;
    const ic = e.icon ? html`${icon(e.icon)} ` : '';
    const confirm = e.confirm ? raw(` data-confirm="${esc(e.confirm)}"`) : '';
    if (e.page) {
      if (!(await pageAllowed(ctx, e.page))) continue;
      entries.push(html`<a ${linkAttrs(ctx, e.page, e.items ?? {})}${confirm}>${ic}${e.label}</a>`);
    } else if (e.request && ctx.vis!.buttons.get(e.request)?.action === 'submit')
      entries.push(html`<button type="submit" name="__request" value="${e.request}" data-button="${e.request}"${confirm}>${ic}${e.label}</button>`);
  }
  if (!entries.length) return '';
  return html`<details class="menu btn-menu" data-button="${b.name}">
    <summary class="${cls}">${b.label}${badge}${icon('chevron', 'icon btn-caret')}</summary>
    <div class="menu-panel"><div class="menu-section menu-links">${entries}</div></div>
  </details>`;
}

export async function renderButton(ctx: PageContext, b: Button) {
  const cls = `btn${b.hot ? ' btn-hot' : ''}${b.name === 'DELETE' ? ' btn-danger' : ''}${templateClasses('button', b.template_options)}`;
  const confirm = b.confirm ? raw(` data-confirm="${esc(b.confirm)}"`) : '';
  const badge = b.badge || b.badge_query ? await badgeOf(ctx, b) : '';
  if (b.action === 'menu') return renderMenu(ctx, b, cls, badge);
  if (b.action === 'redirect') {
    const target = b.target_page ?? ctx.page.page_no;
    // Cancel/close in a dialog returning to the page that opened it just closes the dialog.
    if (!(await pageAllowed(ctx, target))) return '';
    if (ctx.dialog && !(ctx.app.pages.find((p) => p.page_no === target)?.mode === 'modal'))
      return html`<a class="${cls}" href="${ctx.base}/${target}" data-dialog-cancel>${b.label}${badge}</a>`;
    return html`<a class="${cls}" ${linkAttrs(ctx, target, b.target_items ?? {}, true)}${confirm}>${b.label}${badge}</a>`;
  }
  if (b.action === 'da') return html`<button type="button" class="${cls}" data-button="${b.name}"${confirm}>${b.label}${badge}</button>`;
  // a document template filled with this page's session state (documents.ts)
  if (b.action === 'document' && b.document)
    return html`<a class="${cls}" href="${ctx.base}/${ctx.page.page_no}?${new URLSearchParams({ doc: b.document })}${ctx.dialog ? '&dialog=1' : ''}" download${confirm}>${b.label}${badge}</a>`;
  return html`<button type="submit" class="${cls}" name="__request" value="${b.name}" data-button="${b.name}"${confirm}>${b.label}${badge}</button>`;
}

export async function buttonsFor(ctx: PageContext, regionId: number | null) {
  const out = [];
  for (const b of ctx.vis!.buttons.values()) if (b.region_id === regionId && b.id > 0) out.push(await renderButton(ctx, b));
  return out.some(Boolean) ? html`<div class="buttons">${out}</div>` : '';
}

// ---------------------------------------------------------------- region types

/** Row limits when a region sets no config.max_rows (reports and grids page instead). */
export const DEFAULT_MAX_ROWS = { cards: 500, chart: 1000, dynamic: 1000 } as const;

/**
 * The region's SELECT with at most its row limit (config.max_rows, or the
 * default for its type): one row more is read, so `more` says it was cut off.
 */
async function query(ctx: PageContext, r: Region & { type: keyof typeof DEFAULT_MAX_ROWS }, rowMode?: 'array') {
  const max = maxRows(r, DEFAULT_MAX_ROWS[r.type])!;
  const sql = `select * from (\n${stripSemicolon(applyBinds(r.source ?? '', bindValues(ctx)))}\n) "__r" limit ${max + 1}`;
  const c = ctx.client!;
  const res: QueryResult<any> = rowMode
    ? await savepoint(c, () => c.query({ text: sql, rowMode: 'array' }))
    : await savepoint(c, () => c.query(sql));
  const more = res.rows.length > max;
  if (more) res.rows.length = max;
  return Object.assign(res, { more, max });
}

/** "Showing the first N rows." under a region that was cut off at its row limit. */
const firstRows = (ctx: PageContext, res: { more: boolean; max: number }) =>
  res.more ? html`<p class="region-limit">${ctx.locale.t('region.first_rows', { n: res.max })}</p>` : '';

async function renderChart(ctx: PageContext, r: Region) {
  let res;
  try {
    res = await query(ctx, r as Region & { type: 'chart' }, 'array');
  } catch (e) {
    return html`<div class="alert alert-error" role="alert">${await publicError(ctx, e, `chart "${r.title ?? r.id}"`)}</div>`;
  }
  if (!res.rows.length) return html`<p class="empty">${r.config.empty ?? ctx.locale.t('report.no_data')}</p>`;
  const kind = CHART_KINDS.includes(r.config.kind) ? r.config.kind : 'bar';
  return html`${renderChartBody(kind, r.title ?? '', res.rows, res.fields, ctx.css, ctx.locale.lang, ctx.locale.t, {
    ...(await chartLink(ctx, r, res.rows, res.fields)),
    gauge: gaugeConfig(r.config.gauge),
    ...chartFormat(ctx, r),
    // the query's timestamps are in the session's time zone: so is "today"
    ...(kind === 'gantt' ? { now: wallClockIn(ctx.locale.timeZone ?? (await databaseTimeZone())) } : {}),
  })}${firstRows(ctx, res)}`;
}

/** {"format_mask": "FML999G990"}: the chart's values (labels, tips, data table) with a number format mask. */
function chartFormat(ctx: PageContext, r: Region): { format?: (v: number) => string } {
  const mask = typeof r.config.format_mask === 'string' ? r.config.format_mask.trim() : '';
  if (!mask || maskError(mask)) return {};
  return { format: (v) => formatNumber(v, mask, ctx.locale.numbers) ?? ctx.locale.number.format(v) };
}

/** A gauge's numbers from the region settings (anything else is left out). */
function gaugeConfig(g: unknown): GaugeConfig {
  const out: GaugeConfig = {};
  if (g && typeof g === 'object')
    for (const k of ['min', 'max', 'warning', 'critical'] as const) {
      const v = (g as Record<string, unknown>)[k];
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    }
  return out;
}

/**
 * Drill-down (config.link = {page, items}): each data point links to a page with
 * item values from its row (#column#) and its series (#series#), as checksummed
 * URLs. Columns only the link refers to are not drawn as series.
 */
async function chartLink(ctx: PageContext, r: Region, rows: unknown[][], fields: { name: string }[]) {
  const link = r.config.link as { page: number; items?: Record<string, string> } | undefined;
  if (!link || !Number.isInteger(link.page) || !(await pageAllowed(ctx, link.page))) return {};
  const index = new Map(fields.map((f, i) => [f.name.toLowerCase(), i]));
  const hidden = linkColumns(link.items).filter((c) => index.has(c) && index.get(c)! > 0);
  const shown = fields.map((f, i) => ({ f, i })).slice(1).filter(({ f }) => !hidden.includes(f.name.toLowerCase()));
  const links = new Map<string, Raw>();
  return {
    hidden: hidden.map((c) => fields[index.get(c)!].name),
    link: (i: number, si: number | null) => {
      const key = `${i}:${si}`;
      if (!links.has(key)) {
        const row = rows[i];
        const items = fillItems(link.items, (col) => {
          const at = index.get(col.toLowerCase());
          if (at !== undefined) return cell(row[at]);
          if (col.toLowerCase() === 'series') return si === null ? '' : (shown[si]?.f.name ?? '');
          return undefined;
        });
        links.set(key, linkAttrs(ctx, link.page, items));
      }
      return links.get(key)!;
    },
  };
}

/**
 * Cards: the SELECT provides columns named title, subtitle, body, badge and
 * icon (all optional). config.link works like a report link; config.style
 * "metric" renders KPI tiles.
 */
async function renderCards(ctx: PageContext, r: Region) {
  let rows: Record<string, unknown>[];
  let res;
  try {
    res = await query(ctx, r as Region & { type: 'cards' });
    rows = res.rows;
  } catch (e) {
    return html`<div class="alert alert-error" role="alert">${await publicError(ctx, e, `cards "${r.title ?? r.id}"`)}</div>`;
  }
  if (!rows.length) return html`<p class="empty">${r.config.empty ?? ctx.locale.t('report.no_data')}</p>`;
  const link = r.config.link as { page: number; items?: Record<string, string> } | undefined;
  const linkOk = link ? await pageAllowed(ctx, link.page) : false;
  const metric = r.config.style === 'metric';
  const s = (v: unknown) => (v === null || v === undefined ? '' : cell(v));
  // title, subtitle, body and badge with their format masks ({"formats": {"badge": "FML999G990"}})
  const fmtOf = columnFormats(ctx, r);
  const types = new Map(res.fields.map((f) => [f.name, f.dataTypeID]));
  const shown = (row: Record<string, unknown>, col: string) => {
    const v = row[col];
    return v === null || v === undefined ? '' : cell(v, types.get(col), fmtOf(col));
  };

  const cards = rows.map((row) => {
    const inner = metric
      ? html`<span class="metric-icon">${icon(s(row.icon))}</span>
          <span class="metric-value">${shown(row, 'badge')}</span>
          <span class="metric-label">${shown(row, 'title')}</span>`
      : html`<div class="card-head">
            ${row.icon ? html`<span class="card-icon">${icon(s(row.icon))}</span>` : ''}
            <div class="card-titles"><h3>${shown(row, 'title')}</h3>${row.subtitle ? html`<p class="card-subtitle">${shown(row, 'subtitle')}</p>` : ''}</div>
            ${row.badge !== undefined && row.badge !== null ? html`<span class="badge-pill">${shown(row, 'badge')}</span>` : ''}
          </div>
          ${row.body ? html`<p class="card-body">${shown(row, 'body')}</p>` : ''}`;
    if (linkOk && link) {
      const items = fillItems(link.items, (col) => {
        const key = Object.keys(row).find((x) => x.toLowerCase() === col.toLowerCase());
        return key === undefined ? undefined : s(row[key]);
      });
      return html`<a class="card${metric ? ' metric' : ''}" ${linkAttrs(ctx, link.page, items)}>${inner}</a>`;
    }
    return html`<div class="card${metric ? ' metric' : ''}">${inner}</div>`;
  });
  return html`<div class="cards${metric ? ' cards-metric' : ''}">${cards}</div>${firstRows(ctx, res)}`;
}

/**
 * A lazy region's placeholder: app.js fetches the region once the page shows;
 * without JavaScript the link renders the page with the region (r<id>_load=1).
 */
function lazyPlaceholder(ctx: PageContext, r: Region) {
  const q = new URLSearchParams(ctx.params);
  q.delete('cs');
  if (ctx.dialog) q.set('dialog', '1');
  const fetchUrl = `${ctx.base}/${ctx.page.page_no}/region/${r.id}${q.size ? `?${q}` : ''}`;
  const show = `${regionUrl(ctx, r, (p) => p.set(`r${r.id}_load`, '1'))}#R${r.id}`;
  return html`<div class="region-lazy" data-lazy="${fetchUrl}">
    <a class="region-lazy-link" href="${show}">${ctx.locale.t('region.show', { title: r.title ?? '' }).trim()}</a>
    <span class="region-loading" hidden>${ctx.locale.t('region.loading')}</span>
  </div>`;
}

export async function renderRegion(ctx: PageContext, r: Region, hidden: Set<string> = new Set()) {
  if (!ctx.vis!.regions.has(r.id)) {
    dbg(ctx, 9, 'region', () => `region "${r.title ?? r.id}" (${r.type}) not rendered (authorization or condition)`);
    return '';
  }
  if (ctx.debug?.on(6)) return timed(ctx, 6, 'region', `region "${r.title ?? r.id}" (${r.type})`, () => renderRegionNow(ctx, r, hidden));
  return renderRegionNow(ctx, r, hidden);
}

async function renderRegionNow(ctx: PageContext, r: Region, hidden: Set<string>) {
  let body: Raw | null = null;
  const setting = cacheOf(r);
  const cacheKeyOf = setting ? cacheKey(ctx, r, setting) : null;
  if (cacheKeyOf && !ctx.cacheRefresh) body = useCached(ctx, cacheKeyOf);
  if (body) dbg(ctx, 6, 'region', 'from the region cache');
  if (!body && lazyOf(r) && ctx.loadNow !== r.id && !ctx.params.has(`r${r.id}_load`)) body = lazyPlaceholder(ctx, r);
  if (!body)
    body = setting ? await renderCaching(ctx, r, setting, cacheKeyOf!, () => renderBody(ctx, r, hidden)) : await renderBody(ctx, r, hidden);
  return regionShell(ctx, r, hidden, body);
}

/** The region's content (what the region's type renders), without its frame and buttons. */
async function renderBody(ctx: PageContext, r: Region, hidden: Set<string>): Promise<Raw> {
  const items = ctx.page.items.filter((i) => i.region_id === r.id);
  let body: Raw;
  // a REST data source becomes SQL over its rows (rest-sources.ts)
  let restFailed: Raw | null = null;
  if (r.rest_source && r.type !== 'static' && r.type !== 'form')
    await resolveRestRegion(ctx, r).catch(async (e) => {
      restFailed = html`<div class="alert alert-error" role="alert">${await publicError(ctx, e, `REST data source of region "${r.title ?? r.id}"`)}</div>`;
    });
  // a detail region (master-detail.ts) waits until a row of its master grid is selected
  const masterItem = masterItemOf(r);
  if (!restFailed && masterItem && !ctx.session.state[masterItem] && mastersOf(ctx.page, r).length)
    restFailed = html`<p class="muted grid-detail-hint">${ctx.locale.t('grid.select_master_hint')}</p>`;
  if (restFailed) body = restFailed;
  else switch (r.type) {
    case 'report':
      body = html`${await renderAiFilter(ctx, r)}${await renderReport(ctx, r, await renderItems(ctx, items, hidden))}`;
      break;
    case 'form':
      body = html`<div class="form-grid">${await renderItems(ctx, items, hidden)}</div>`;
      break;
    case 'chart':
      body = await renderChart(ctx, r);
      break;
    case 'cards':
      body = await renderCards(ctx, r);
      break;
    case 'grid':
      body = await renderGrid(ctx, r);
      break;
    case 'calendar':
      body = await renderCalendar(ctx, r);
      break;
    case 'facets':
      body = await renderFacets(ctx, r);
      break;
    case 'smart_filters':
      body = await renderSmartFilters(ctx, r);
      break;
    case 'display_selector':
      body = renderDisplaySelector(ctx, r);
      break;
    case 'list':
      body = await renderListRegion(ctx, r);
      break;
    case 'tasks':
      body = await renderTasks(ctx, r);
      break;
    case 'workflows':
      body = await renderWorkflows(ctx, r);
      break;
    case 'map':
      body = await renderMap(ctx, r);
      break;
    case 'tree':
      body = await renderTree(ctx, r);
      break;
    case 'template_component':
      body = await renderTemplateRegion(ctx, r);
      break;
    case 'plugin':
      body = await renderPluginRegion(ctx, r, renderTemplateRegion);
      break;
    case 'data_reporter':
      body = await renderDataReporter(ctx, r);
      break;
    case 'ai_assistant':
      body = await renderAssistant(ctx, r);
      break;
    case 'dynamic':
      // A SELECT returning HTML (like APEX "PL/SQL Dynamic Content"). The
      // developer's SQL produces trusted markup; escape data with meta.html_escape().
      try {
        const res = await query(ctx, r as Region & { type: 'dynamic' });
        body = raw(res.rows.map((row) => String(Object.values(row)[0] ?? '')).join(''));
      } catch (e) {
        body = html`<div class="alert alert-error" role="alert">${await publicError(ctx, e, `region "${r.title ?? r.id}"`)}</div>`;
      }
      break;
    case 'static': {
      const itemsHtml = await renderItems(ctx, items, hidden);
      body = html`${raw(substitute(r.source ?? '', ctx, esc))}${itemsHtml.length ? html`<div class="form-grid">${itemsHtml}</div>` : ''}`;
      break;
    }
  }
  return body!;
}

async function regionShell(ctx: PageContext, r: Region, hidden: Set<string>, body: Raw) {
  const buttons = await buttonsFor(ctx, r.id);
  const buttonsOnTop = r.type !== 'form' && r.type !== 'static';
  // (a grid renders its own Save button in its toolbar)
  const cls = `region region-${r.type} region-${r.template} col-${r.columns}${templateClasses('region', r.template_options)}`;
  const hiddenAttr = hidden.has(`R${r.id}`) ? raw(' hidden') : '';
  const titleId = `R${r.id}_title`;
  // (0.31) the region's static id, for CSS and JavaScript (the element id stays R<id>)
  const staticAttr = r.static_id ? raw(` data-static-id="${esc(r.static_id)}"`) : '';

  if (r.template === 'plain')
    return html`<section class="${cls}" id="R${r.id}"${staticAttr}${hiddenAttr} aria-label="${r.title}">
      ${buttonsOnTop && buttons ? html`<div class="region-toolbar">${buttons}</div>` : ''}
      ${body}
      ${!buttonsOnTop && buttons ? html`<footer class="region-footer">${buttons}</footer>` : ''}
    </section>`;

  const header = html`<h2 id="${titleId}">${r.title}</h2>${buttonsOnTop ? buttons : ''}`;
  if (r.template === 'collapsible')
    return html`<section class="${cls}" id="R${r.id}"${staticAttr}${hiddenAttr} aria-labelledby="${titleId}">
      <details open><summary class="region-header">${header}</summary>
        <div class="region-body">${body}</div>
        ${!buttonsOnTop && buttons ? html`<footer class="region-footer">${buttons}</footer>` : ''}
      </details></section>`;

  return html`<section class="${cls}" id="R${r.id}"${staticAttr}${hiddenAttr}${r.title ? raw(` aria-labelledby="${titleId}"`) : ''}>
    ${r.title || (buttonsOnTop && buttons) ? html`<header class="region-header">${header}</header>` : ''}
    <div class="region-body">${body}</div>
    ${!buttonsOnTop && buttons ? html`<footer class="region-footer">${buttons}</footer>` : ''}
  </section>`;
}

