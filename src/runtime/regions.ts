import { applyBinds } from '../binds.ts';
import { savepoint } from '../db.ts';
import { esc, html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import type { Button, Region } from '../metadata.ts';
import { pageAllowed } from './authz.ts';
import { bindValues, publicError, stripSemicolon, substitute, type PageContext } from './context.ts';
import { renderItems } from './items.ts';
import { linkAttrs } from './links.ts';
import { cell, renderReport } from './report.ts';

// ---------------------------------------------------------------- buttons

export async function renderButton(ctx: PageContext, b: Button) {
  const cls = `btn${b.hot ? ' btn-hot' : ''}${b.name === 'DELETE' ? ' btn-danger' : ''}`;
  const confirm = b.confirm ? raw(` data-confirm="${esc(b.confirm)}"`) : '';
  if (b.action === 'redirect') {
    const target = b.target_page ?? ctx.page.page_no;
    // Cancel/close in a dialog returning to the page that opened it just closes the dialog.
    if (!(await pageAllowed(ctx, target))) return '';
    if (ctx.dialog && !(ctx.app.pages.find((p) => p.page_no === target)?.mode === 'modal'))
      return html`<a class="${cls}" href="${ctx.base}/${target}" data-dialog-cancel>${b.label}</a>`;
    return html`<a class="${cls}" ${linkAttrs(ctx, target, b.target_items ?? {}, true)}${confirm}>${b.label}</a>`;
  }
  if (b.action === 'da') return html`<button type="button" class="${cls}" data-button="${b.name}"${confirm}>${b.label}</button>`;
  return html`<button type="submit" class="${cls}" name="__request" value="${b.name}" data-button="${b.name}"${confirm}>${b.label}</button>`;
}

export async function buttonsFor(ctx: PageContext, regionId: number | null) {
  const out = [];
  for (const b of ctx.vis!.buttons.values()) if (b.region_id === regionId) out.push(await renderButton(ctx, b));
  return out.some(Boolean) ? html`<div class="buttons">${out}</div>` : '';
}

// ---------------------------------------------------------------- region types

async function query(ctx: PageContext, r: Region) {
  const sql = stripSemicolon(applyBinds(r.source ?? '', bindValues(ctx)));
  const c = ctx.client!;
  return savepoint(c, () => c.query(sql));
}

async function renderChart(ctx: PageContext, r: Region) {
  let rows: unknown[][];
  try {
    const sql = stripSemicolon(applyBinds(r.source ?? '', bindValues(ctx)));
    rows = (await savepoint(ctx.client!, () => ctx.client!.query({ text: sql, rowMode: 'array' }))).rows;
  } catch (e) {
    return html`<div class="alert alert-error" role="alert">${await publicError(ctx, e, `chart "${r.title ?? r.id}"`)}</div>`;
  }
  if (!rows.length) return html`<p class="empty">${r.config.empty ?? 'No data found'}</p>`;
  const data = rows.map((row) => ({ label: cell(row[0]), value: Number(row[1]) || 0 }));
  const max = Math.max(...data.map((d) => Math.abs(d.value)), 1);
  const fmt = new Intl.NumberFormat('en', { maximumFractionDigits: 2 });
  return html`<figure class="bar-chart" aria-label="${r.title ?? 'Chart'}">
    <table class="sr-only"><caption>${r.title}</caption>${data.map((d) => html`<tr><th scope="row">${d.label}</th><td>${d.value}</td></tr>`)}</table>
    <div aria-hidden="true">${data.map(
      (d) => html`<div class="bar-row">
        <span class="bar-label" title="${d.label}">${d.label}</span>
        <span class="bar-track"><span class="bar" style="width:${((Math.abs(d.value) / max) * 100).toFixed(1)}%"></span></span>
        <span class="bar-value">${fmt.format(d.value)}</span>
      </div>`,
    )}</div>
  </figure>`;
}

/**
 * Cards: the SELECT provides columns named title, subtitle, body, badge and
 * icon (all optional). config.link works like a report link; config.style
 * "metric" renders KPI tiles.
 */
async function renderCards(ctx: PageContext, r: Region) {
  let rows: Record<string, unknown>[];
  try {
    rows = (await query(ctx, r)).rows;
  } catch (e) {
    return html`<div class="alert alert-error" role="alert">${await publicError(ctx, e, `cards "${r.title ?? r.id}"`)}</div>`;
  }
  if (!rows.length) return html`<p class="empty">${r.config.empty ?? 'No data found'}</p>`;
  const link = r.config.link as { page: number; items?: Record<string, string> } | undefined;
  const linkOk = link ? await pageAllowed(ctx, link.page) : false;
  const metric = r.config.style === 'metric';
  const s = (v: unknown) => (v === null || v === undefined ? '' : cell(v));

  const cards = rows.map((row) => {
    const inner = metric
      ? html`<span class="metric-icon">${icon(s(row.icon))}</span>
          <span class="metric-value">${s(row.badge)}</span>
          <span class="metric-label">${s(row.title)}</span>`
      : html`<div class="card-head">
            ${row.icon ? html`<span class="card-icon">${icon(s(row.icon))}</span>` : ''}
            <div class="card-titles"><h3>${s(row.title)}</h3>${row.subtitle ? html`<p class="card-subtitle">${s(row.subtitle)}</p>` : ''}</div>
            ${row.badge !== undefined && row.badge !== null ? html`<span class="badge-pill">${s(row.badge)}</span>` : ''}
          </div>
          ${row.body ? html`<p class="card-body">${s(row.body)}</p>` : ''}`;
    if (linkOk && link) {
      const items: Record<string, string> = {};
      for (const [k, v] of Object.entries(link.items ?? {}))
        items[k] = v.replace(/#([A-Za-z0-9_]+)#/g, (m, col: string) => {
          const key = Object.keys(row).find((x) => x.toLowerCase() === col.toLowerCase());
          return key === undefined ? m : s(row[key]);
        });
      return html`<a class="card${metric ? ' metric' : ''}" ${linkAttrs(ctx, link.page, items)}>${inner}</a>`;
    }
    return html`<div class="card${metric ? ' metric' : ''}">${inner}</div>`;
  });
  return html`<div class="cards${metric ? ' cards-metric' : ''}">${cards}</div>`;
}

export async function renderRegion(ctx: PageContext, r: Region, hidden: Set<string> = new Set()) {
  if (!ctx.vis!.regions.has(r.id)) return '';
  const items = ctx.page.items.filter((i) => i.region_id === r.id);
  let body: Raw;
  switch (r.type) {
    case 'report':
      body = await renderReport(ctx, r, await renderItems(ctx, items, hidden));
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
    case 'static': {
      const itemsHtml = await renderItems(ctx, items, hidden);
      body = html`${raw(substitute(r.source ?? '', ctx, esc))}${itemsHtml.length ? html`<div class="form-grid">${itemsHtml}</div>` : ''}`;
      break;
    }
  }
  const buttons = await buttonsFor(ctx, r.id);
  const buttonsOnTop = r.type !== 'form' && r.type !== 'static';
  const cls = `region region-${r.type} region-${r.template} col-${r.columns}`;
  const hiddenAttr = hidden.has(`R${r.id}`) ? raw(' hidden') : '';
  const titleId = `R${r.id}_title`;

  if (r.template === 'plain')
    return html`<section class="${cls}" id="R${r.id}"${hiddenAttr} aria-label="${r.title}">
      ${buttonsOnTop && buttons ? html`<div class="region-toolbar">${buttons}</div>` : ''}
      ${body}
      ${!buttonsOnTop && buttons ? html`<footer class="region-footer">${buttons}</footer>` : ''}
    </section>`;

  const header = html`<h2 id="${titleId}">${r.title}</h2>${buttonsOnTop ? buttons : ''}`;
  if (r.template === 'collapsible')
    return html`<section class="${cls}" id="R${r.id}"${hiddenAttr} aria-labelledby="${titleId}">
      <details open><summary class="region-header">${header}</summary>
        <div class="region-body">${body}</div>
        ${!buttonsOnTop && buttons ? html`<footer class="region-footer">${buttons}</footer>` : ''}
      </details></section>`;

  return html`<section class="${cls}" id="R${r.id}"${hiddenAttr}${r.title ? raw(` aria-labelledby="${titleId}"`) : ''}>
    ${r.title || (buttonsOnTop && buttons) ? html`<header class="region-header">${header}</header>` : ''}
    <div class="region-body">${body}</div>
    ${!buttonsOnTop && buttons ? html`<footer class="region-footer">${buttons}</footer>` : ''}
  </section>`;
}

