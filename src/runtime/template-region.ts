import { applyBinds } from '../binds.ts';
import { savepoint } from '../db.ts';
import { html, raw } from '../html.ts';
import type { Region } from '../metadata.ts';
import { bindValues, publicError, stripSemicolon, type PageContext } from './context.ts';
import { cell } from './report.ts';
import {
  attributeValues, compiled, componentsOf, LAYOUT_CLASSES, MAX_ROWS, renderInstances, rowLinker, rowLookup, TemplateError, type Lookup, type TcUse,
} from './template-components.ts';

// Region type "template_component": a template component (Shared
// Components) rendered for each row of the region's query, or once without
// a query. Region config:
//   {"component": "status_badge",          the component's static id
//    "attributes": {"LABEL": "#status#"},  custom attribute values (#col#, &ITEM.)
//    "display": "each" | "multiple",       multiple: all rows inside the component's wrapper
//    "link": {"page": 3, "items": {"P3_ID": "#id#"}},   → #LINK#
//    "max_rows": 50, "empty": "No data"}

export interface TemplateRegionConfig extends TcUse {
  display?: 'each' | 'multiple';
  link?: { page: number; items?: Record<string, string> };
  max_rows?: number;
  empty?: string;
}

export async function renderTemplateRegion(ctx: PageContext, r: Region) {
  const cfg = r.config as TemplateRegionConfig;
  const t = ctx.locale.t;
  const c = cfg.component ? (await componentsOf(ctx)).get(cfg.component) : undefined;
  if (!c) return html`<div class="alert alert-error" role="alert">${t('tc.missing', { name: cfg.component ?? '' })}</div>`;
  let comp;
  try {
    comp = compiled(c);
  } catch (e) {
    if (!(e instanceof TemplateError)) throw e;
    return html`<div class="alert alert-error" role="alert">${t('tc.invalid', { name: c.name })}${ctx.app.debug ? ` ${e.message}` : ''}</div>`;
  }

  const attrs = attributeValues(c, cfg);
  const modal = new Set<string>();
  const linker = await rowLinker(ctx, cfg.link, modal);
  const lookups: Lookup[] = [];
  if (r.source?.trim()) {
    const max = Math.max(1, Math.min(MAX_ROWS, Number(cfg.max_rows) || MAX_ROWS));
    let res;
    try {
      const sql = stripSemicolon(applyBinds(r.source, bindValues(ctx)));
      res = await savepoint(ctx.client!, () => ctx.client!.query({ text: `select * from (\n${sql}\n) "__q" limit ${max}`, rowMode: 'array' }));
    } catch (e) {
      return html`<div class="alert alert-error" role="alert">${await publicError(ctx, e, `region "${r.title ?? r.id}"`)}</div>`;
    }
    if (!res.rows.length) return html`<p class="empty">${cfg.empty ? ctx.locale.tr(cfg.empty) : t('report.no_data')}</p>`;
    res.rows.forEach((row: unknown[], n: number) => {
      const columns = new Map(res.fields.map((f, j) => [f.name.toUpperCase(), cell(row[j], f.dataTypeID, ctx.locale.format)]));
      const plain = new Map(res.fields.map((f, j) => [f.name.toUpperCase(), cell(row[j])]));
      lookups.push(rowLookup(ctx, attrs, columns, { APEX$ROW_NUM: String(n + 1), LINK: linker?.((x) => plain.get(x)) }));
    });
  } else {
    // no query: one instance from the attributes alone
    lookups.push(rowLookup(ctx, attrs, new Map(), { APEX$ROW_NUM: '1', LINK: linker?.(() => undefined) }));
  }
  const wrapperLookup = rowLookup(ctx, attrs, new Map(), { APEX$ROW_COUNT: String(lookups.length) });
  const layout = (c.css_classes ?? []).filter((k) => (LAYOUT_CLASSES as readonly string[]).includes(k));
  const cls = ['tc-region', ...(layout.length ? layout : ['tc-list'])].join(' ');
  return html`<div class="${cls}">${raw(renderInstances(comp, lookups, wrapperLookup, cfg.display === 'multiple', modal))}</div>`;
}
