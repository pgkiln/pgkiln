import type { FastifyInstance } from 'fastify';
import { designSql } from './websources.ts';
import pg from 'pg';
import { applyBinds } from '../binds.ts';
import { owner } from '../db.ts';
import { html, raw } from '../html.ts';
import { formatMaskError } from '../runtime/format.ts';
import { heading } from '../runtime/items.ts';
import type { Session } from '../session.ts';
import { back, BASE, csrf, developer, flash, type Req } from './ui.ts';

// Page designer → a report region → Report settings: the most used keys of
// the region's "config" JSON as a form (columns, link, paging, PDF, saved
// reports). Saving merges them into the JSON and leaves other keys alone.

const PAGE_SIZES = ['5', '10', '15', '25', '50', '100'];

/** The column names of a report's query: run with limit 0, as the app's role, then rolled back. */
export async function reportColumns(appId: number, source: string | null): Promise<{ columns: string[] } | { error: string }> {
  if (!source?.trim()) return { error: 'The region has no source query yet.' };
  const c = await owner.pool.connect();
  try {
    await c.query('begin');
    await c.query(`set local statement_timeout = '5s'`);
    await c.query(`select set_config('pgapex.app_id', $1, true)`, [String(appId)]);
    const role = (await c.query('select db_role from meta.app where id = $1', [appId])).rows[0]?.db_role;
    if (role) await c.query(`set local role ${pg.escapeIdentifier(role)}`);
    const sql = applyBinds(source.trim().replace(/;+\s*$/, ''), {});
    const res = await c.query(`select * from (\n${sql}\n) "__q" limit 0`);
    return { columns: res.fields.map((f) => f.name).filter((n) => !n.startsWith('__')) };
  } catch (e) {
    return { error: (e as Error).message };
  } finally {
    await c.query('rollback').catch(() => {});
    c.release();
  }
}

/** "P3_ID=#id#, P3_X=a=b" → { P3_ID: '#id#', P3_X: 'a=b' } (item names upper case). */
export function parseLinkItems(text: string | undefined): Record<string, string> {
  return Object.fromEntries(
    (text ?? '')
      .split(',')
      .map((x) => x.split('='))
      .filter(([k, v]) => k?.trim() && v !== undefined)
      .map(([k, ...v]) => [k.trim().toUpperCase(), v.join('=').trim()]),
  );
}

export const linkItemsText = (items: Record<string, string> | undefined) => (items ? Object.entries(items).map(([k, v]) => `${k}=${v}`).join(', ') : '');

interface ReportConfig {
  page_size?: number;
  pagination?: 'range';
  keyset?: string[];
  max_rows?: number;
  lazy?: boolean;
  cache?: { scope: 'user' | 'session' | 'all'; seconds: number };
  searchable?: boolean;
  sortable?: boolean;
  interactive?: boolean;
  mobile?: string;
  empty?: string;
  hidden?: string[];
  headings?: Record<string, string>;
  formats?: Record<string, string>;
  link?: { column: string; page: number; items?: Record<string, string> };
  saved_reports?: boolean;
  public_reports?: string;
  pdf?: { layout?: string; columns?: string[]; widths?: Record<string, number>; align?: Record<string, string> };
  selection?: { column: string; item: string };
  [k: string]: unknown;
}

/** The Report settings form of a report region. */
export async function reportSettingsForm(pageId: number, appId: number, r: { id: number; source: string | null; config: ReportConfig }, s: Session) {
  const cfg = r.config ?? {};
  const cols = await reportColumns(appId, await designSql(appId, r));
  const [layouts, schemes, pages, items] = await Promise.all([
    owner.query('select name, is_default from meta.report_layout where app_id = $1 order by name', [appId]),
    owner.query('select name from meta.authz_scheme where app_id = $1 order by name', [appId]),
    owner.query('select page_no, name from meta.page where app_id = $1 order by page_no', [appId]),
    owner.query('select name, type from meta.item where page_id = $1 order by name', [pageId]),
  ]);
  const id = (n: string) => `rs_${r.id}_${n}`;
  const check = (name: string, label: string, on: boolean) =>
    html`<div class="field"><span class="label" aria-hidden="true"></span><label class="check"><input type="checkbox" name="${name}" value="true"${on ? raw(' checked') : ''}> ${label}</label></div>`;
  const opt = (value: string, label: string, current: unknown) => html`<option value="${value}"${String(current ?? '') === value ? raw(' selected') : ''}>${label}</option>`;

  const names = 'columns' in cols ? cols.columns : [];
  // columns in the settings that the query no longer returns stay visible, so they can be cleared
  const known = new Set(names);
  const stale = [...new Set([...(cfg.hidden ?? []), ...Object.keys(cfg.headings ?? {}), ...Object.keys(cfg.formats ?? {}), ...(cfg.pdf?.columns ?? [])])].filter((n) => !known.has(n));
  const all = [...names, ...stale];
  const hidden = new Set((cfg.hidden ?? []).map((h) => h.toLowerCase()));
  const printed = cfg.pdf?.columns?.length ? new Set(cfg.pdf.columns.map((c) => c.toLowerCase())) : null;

  const columnRows = all.map((n, i) => html`<tr>
      <td data-label="Column"><code>${n}</code>${known.has(n) ? '' : html` <span class="tag tag-error">not in the query</span>`}<input type="hidden" name="col_${i}" value="${n}"></td>
      <td data-label="Heading"><input name="heading_${i}" value="${cfg.headings?.[n] ?? ''}" placeholder="${heading(n)}" aria-label="Heading of ${n}"></td>
      <td data-label="Format mask"><input name="fmt_${i}" value="${cfg.formats?.[n] ?? ''}" placeholder="e.g. 999G990D00" aria-label="Format mask of ${n}" class="u-mw10"></td>
      <td data-label="Shown"><input type="checkbox" name="shown_${i}" value="true"${hidden.has(n.toLowerCase()) ? '' : raw(' checked')} aria-label="Show ${n}"></td>
      <td data-label="In PDF"><input type="checkbox" name="print_${i}" value="true"${(printed ? printed.has(n.toLowerCase()) : !hidden.has(n.toLowerCase())) ? raw(' checked') : ''} aria-label="Print ${n}"></td>
      <td data-label="PDF width (mm)"><input name="width_${i}" type="number" min="0" max="500" value="${cfg.pdf?.widths?.[n] ?? ''}" aria-label="PDF width of ${n}" class="u-mw6"></td>
    </tr>`);

  const linkItems = linkItemsText(cfg.link?.items);
  return html`<h3 class="u-mt15">Report settings</h3>
    <p class="muted u-mt0">These fields write the region's settings JSON above (other keys are kept).</p>
    ${'error' in cols ? html`<div class="alert alert-error" role="alert">The columns could not be read: ${cols.error}</div>` : ''}
    <form method="post" action="${BASE}/pages/${pageId}/region/${r.id}/report-settings" class="component-form">${csrf(s)}
      <input type="hidden" name="n" value="${all.length}">
      <fieldset class="prop-group"><legend>Behaviour</legend><div class="form-grid">
        <div class="field"><label class="label" for="${id('page_size')}">Rows per page</label>
          <select id="${id('page_size')}" name="page_size">${PAGE_SIZES.map((n) => opt(n, n, cfg.page_size ?? 15))}</select></div>
        <div class="field"><label class="label" for="${id('mobile')}">On phones</label>
          <select id="${id('mobile')}" name="mobile">${opt('reflow', 'Cards (reflow)', cfg.mobile ?? 'reflow')}${opt('scroll', 'Scrolling table', cfg.mobile)}</select></div>
        <div class="field" data-wide><label class="label" for="${id('empty')}">Text when there are no rows</label>
          <input id="${id('empty')}" name="empty" value="${cfg.empty ?? ''}" placeholder="No data found"></div>
        ${check('searchable', 'Search box', cfg.searchable !== false)}
        ${check('interactive', 'Actions menu (filters, break, aggregates, downloads…)', cfg.interactive !== false)}
        ${check('sortable', 'Sortable', cfg.sortable !== false)}
        ${check('saved_reports', 'Users may save reports', cfg.saved_reports !== false)}
        <div class="field"><label class="label" for="${id('public')}">Who may save public reports</label>
          <select id="${id('public')}" name="public_reports">${opt('', '- nobody -', cfg.public_reports)}${schemes.rows.map((x) => opt(x.name, x.name, cfg.public_reports))}</select></div>
      </div></fieldset>
      <fieldset class="prop-group"><legend>Large tables</legend><div class="form-grid">
        <div class="field"><label class="label" for="${id('pagination')}">Pagination</label>
          <select id="${id('pagination')}" name="pagination">${opt('', 'Rows X–Y of Z (counts the total)', cfg.pagination)}${opt('range', 'Row ranges X–Y (no total)', cfg.pagination)}</select>
          <small class="help">Row ranges skip counting the rows: use them for large tables.</small></div>
        <div class="field"><label class="label" for="${id('keyset')}">Keyset columns</label>
          <input id="${id('keyset')}" name="keyset" value="${(cfg.keyset ?? []).join(', ')}" placeholder="e.g. id">
          <small class="help">With row ranges: columns that make a row unique (comma separated, indexed). Next and Previous then continue after the last row instead of skipping rows (fast deep pages).</small></div>
        <div class="field"><label class="label" for="${id('max_rows')}">Maximum row count</label>
          <input id="${id('max_rows')}" name="max_rows" type="number" min="1" max="1000000" value="${cfg.max_rows ?? ''}" placeholder="no maximum">
          <small class="help">The report (and its downloads) reads at most this many rows.</small></div>
        ${check('lazy', 'Load after the page shows (lazy loading)', cfg.lazy === true)}
        <div class="field"><label class="label" for="${id('cache_scope')}">Cache</label>
          <select id="${id('cache_scope')}" name="cache_scope">${opt('', '- no cache -', cfg.cache?.scope)}${opt('user', 'Per user', cfg.cache?.scope)}${opt('session', 'Per session', cfg.cache?.scope)}${opt('all', 'For all users (with the same roles)', cfg.cache?.scope)}</select></div>
        <div class="field"><label class="label" for="${id('cache_seconds')}">Cache for (seconds)</label>
          <input id="${id('cache_seconds')}" name="cache_seconds" type="number" min="1" max="86400" value="${cfg.cache?.seconds ?? ''}" placeholder="300">
          <small class="help">A submit of the page empties its cache.</small></div>
      </div></fieldset>
      <fieldset class="prop-group"><legend>Columns</legend>
        ${all.length
          ? html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>Column</th><th>Heading</th><th>Format mask</th><th>Shown</th><th>In PDF</th><th>PDF width (mm)</th></tr></thead><tbody>${columnRows}</tbody></table></div>`
          : html`<p class="muted">No columns yet.</p>`}
        <small class="help">Format masks: numbers like 999G999G990D00, FML999G990D00 (currency), 990D0% or 0000 (G and D are the language's separators); dates like DD-MON-YYYY. Empty: the application's formats. Excel and CSV downloads keep the raw values.</small>
      </fieldset>
      <fieldset class="prop-group"><legend>Link</legend><div class="form-grid">
        <div class="field"><label class="label" for="${id('link_column')}">Link column</label>
          <select id="${id('link_column')}" name="link_column">${opt('', '- no link -', cfg.link?.column)}${all.map((n) => opt(n, n, cfg.link?.column))}</select></div>
        <div class="field"><label class="label" for="${id('link_page')}">To page</label>
          <select id="${id('link_page')}" name="link_page">${opt('', '- choose -', cfg.link?.page)}${pages.rows.map((p) => opt(String(p.page_no), `${p.page_no}. ${p.name}`, cfg.link?.page))}</select></div>
        <div class="field" data-wide><label class="label" for="${id('link_items')}">Set items</label>
          <input id="${id('link_items')}" name="link_items" value="${linkItems}" placeholder="P3_ID=#id#">
          <small class="help">ITEM=#column#, comma separated; #column# is replaced by the row's value.</small></div>
      </div></fieldset>
      <fieldset class="prop-group"><legend>Row selection</legend><div class="form-grid">
        <div class="field"><label class="label" for="${id('sel_column')}">Value column</label>
          <select id="${id('sel_column')}" name="sel_column">${opt('', '- no row selection -', cfg.selection?.column)}${all.map((n) => opt(n, n, cfg.selection?.column))}</select></div>
        <div class="field"><label class="label" for="${id('sel_item')}">Into item</label>
          <select id="${id('sel_item')}" name="sel_item">${opt('', '- choose -', cfg.selection?.item)}${items.rows.map((x) => opt(x.name, `${x.name} (${x.type})`, cfg.selection?.item))}</select>
          <small class="help">A checkbox per row; on submit the checked rows' values reach the item, colon separated (e.g. 7839:7902). Usually a hidden item. Treat the values as user input in your process.</small></div>
      </div></fieldset>
      <fieldset class="prop-group"><legend>PDF</legend><div class="form-grid">
        <div class="field"><label class="label" for="${id('layout')}">Report layout</label>
          <select id="${id('layout')}" name="pdf_layout">${opt('', layouts.rows.some((l) => l.is_default) ? '- the default layout -' : '- built-in -', cfg.pdf?.layout)}${layouts.rows.map((l) => opt(l.name, l.name + (l.is_default ? ' (default)' : ''), cfg.pdf?.layout))}</select>
          <small class="help">Layouts are under Shared Components → Report layouts.</small></div>
      </div></fieldset>
      <div class="buttons"><button class="btn btn-hot">Save report settings</button></div>
    </form>`;
}

/** The region's config after the Report settings form: known keys replaced, defaults left out. */
export function mergeReportSettings(config: ReportConfig, b: Record<string, string | undefined>, pages: Set<number>, layouts: Set<string>, schemes: Set<string>, items: Set<string> = new Set()): ReportConfig {
  const out: ReportConfig = { ...config };
  const set = <K extends keyof ReportConfig>(k: K, v: ReportConfig[K] | undefined) => {
    if (v === undefined) delete out[k];
    else out[k] = v;
  };
  const size = Number(b.page_size);
  set('page_size', PAGE_SIZES.includes(String(size)) && size !== 15 ? size : undefined);
  set('mobile', b.mobile === 'scroll' ? 'scroll' : undefined);
  set('pagination', b.pagination === 'range' ? 'range' : undefined);
  const keyset = (b.keyset ?? '').split(',').map((c) => c.trim()).filter((c) => c && c.length <= 63).slice(0, 4);
  set('keyset', keyset.length ? keyset : undefined);
  const max = Math.floor(Number(b.max_rows));
  set('max_rows', b.max_rows?.trim() && max >= 1 ? Math.min(max, 1_000_000) : undefined);
  set('lazy', b.lazy === 'true' ? true : undefined);
  const scope = b.cache_scope;
  const seconds = Math.floor(Number(b.cache_seconds || 300));
  set('cache', scope === 'user' || scope === 'session' || scope === 'all' ? { scope, seconds: Math.min(Math.max(seconds || 300, 1), 86_400) } : undefined);
  set('empty', b.empty?.trim() || undefined);
  set('searchable', b.searchable === 'true' ? undefined : false);
  set('interactive', b.interactive === 'true' ? undefined : false);
  set('sortable', b.sortable === 'true' ? undefined : false);
  set('saved_reports', b.saved_reports === 'true' ? undefined : false);
  set('public_reports', b.public_reports && schemes.has(b.public_reports) ? b.public_reports : undefined);

  const n = Math.min(Number(b.n) || 0, 500);
  const cols = Array.from({ length: n }, (_, i) => ({
    name: (b[`col_${i}`] ?? '').trim(),
    heading: (b[`heading_${i}`] ?? '').trim(),
    shown: b[`shown_${i}`] === 'true',
    print: b[`print_${i}`] === 'true',
    width: Number(b[`width_${i}`]),
    format: (b[`fmt_${i}`] ?? '').trim().slice(0, 64),
  })).filter((c) => c.name);
  const headings = Object.fromEntries(cols.filter((c) => c.heading).map((c) => [c.name, c.heading]));
  set('headings', Object.keys(headings).length ? headings : undefined);
  // masks that aren't valid are left out (reportSettingsProblems names them)
  const formats = Object.fromEntries(cols.filter((c) => c.format && !formatMaskError(c.format)).map((c) => [c.name, c.format]));
  set('formats', Object.keys(formats).length ? formats : undefined);
  const hidden = cols.filter((c) => !c.shown).map((c) => c.name);
  set('hidden', hidden.length ? hidden : undefined);

  const pdf = { ...(config.pdf ?? {}) };
  const printed = cols.filter((c) => c.print).map((c) => c.name);
  // the PDF prints what's on screen unless the choice differs
  const same = printed.length === cols.filter((c) => c.shown).length && printed.every((p) => cols.find((c) => c.name === p)!.shown);
  if (same) delete pdf.columns;
  else pdf.columns = printed;
  const widths = Object.fromEntries(cols.filter((c) => c.width > 0 && c.width <= 500).map((c) => [c.name, c.width]));
  if (Object.keys(widths).length) pdf.widths = widths;
  else delete pdf.widths;
  if (b.pdf_layout && layouts.has(b.pdf_layout)) pdf.layout = b.pdf_layout;
  else delete pdf.layout;
  set('pdf', Object.keys(pdf).length ? pdf : undefined);

  const page = Number(b.link_page);
  if (b.link_column && cols.some((c) => c.name === b.link_column) && pages.has(page)) {
    const items = parseLinkItems(b.link_items);
    set('link', { column: b.link_column, page, ...(Object.keys(items).length ? { items } : {}) });
  } else set('link', undefined);
  set('selection', b.sel_column && cols.some((c) => c.name === b.sel_column) && b.sel_item && items.has(b.sel_item) ? { column: b.sel_column, item: b.sel_item } : undefined);
  return out;
}

/** The format masks in the Report settings form that are not valid: "sal: reason". */
export function formatProblems(b: Record<string, string | undefined>) {
  const n = Math.min(Number(b.n) || 0, 500);
  return Array.from({ length: n }, (_, i) => [(b[`col_${i}`] ?? '').trim(), (b[`fmt_${i}`] ?? '').trim()] as const)
    .flatMap(([col, mask]) => {
      const e = col && mask ? formatMaskError(mask) : null;
      return e ? [`${col}: ${e}`] : [];
    });
}

export async function reportSettingsRoutes(app: FastifyInstance) {
  app.post(`${BASE}/pages/:pid/region/:rid/report-settings`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const { pid, rid } = req.params as { pid: string; rid: string };
    const r = /^\d+$/.test(pid) && /^\d+$/.test(rid)
      ? await owner.one(`select r.id, r.config, p.app_id from meta.region r join meta.page p on p.id = r.page_id where r.id = $1 and r.page_id = $2 and r.type = 'report'`, [rid, pid])
      : undefined;
    if (!r) return reply.code(404).send('Not found');
    const [pages, layouts, schemes, items] = await Promise.all([
      owner.query('select page_no from meta.page where app_id = $1', [r.app_id]),
      owner.query('select name from meta.report_layout where app_id = $1', [r.app_id]),
      owner.query('select name from meta.authz_scheme where app_id = $1', [r.app_id]),
      owner.query('select name from meta.item where page_id = $1', [pid]),
    ]);
    const config = mergeReportSettings(
      r.config ?? {},
      (req.body ?? {}) as Record<string, string | undefined>,
      new Set(pages.rows.map((x) => x.page_no)),
      new Set(layouts.rows.map((x) => x.name)),
      new Set(schemes.rows.map((x) => x.name)),
      new Set(items.rows.map((x) => x.name)),
    );
    await owner.query('update meta.region set config = $2 where id = $1', [r.id, JSON.stringify(config)]);
    const bad = formatProblems((req.body ?? {}) as Record<string, string | undefined>);
    if (bad.length) flash(s, `Report settings saved, without these format masks: ${bad.join('; ')}.`, 'error');
    else flash(s, 'Report settings saved.');
    return back(reply, s, `${BASE}/pages/${pid}?c=region-${rid}`);
  });
}
