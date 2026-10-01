import { applyBinds } from '../binds.ts';
import { savepoint } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import type { Region } from '../metadata.ts';
import { pageAllowed } from './authz.ts';
import { bindValues, publicError, stripSemicolon, toState, type PageContext } from './context.ts';
import { pageHref } from './links.ts';
import { key, parseArea, regionUrl } from './report.ts';
import { tileAttribution, tileUrl } from '../maptiles.ts';

// Map region (APEX: Map region). The SELECT returns, per row, a position
// (columns lat and lng, latitude and longitude, or location as "lat,lng")
// and optionally title, body and geojson (a GeoJSON geometry or feature for
// lines and areas), and weight (for a heat map). config:
//   {"link": {"page": 5, "items": {"P5_ID": "#id#"}}, "height": "small|medium|large", "zoom": 12,
//    "layer": "markers|heat", "report": <id of a report region on the page>}
// layer "heat" draws the points as a heat map (weighted by the weight column).
// With "report", users can filter that report to the map's visible area
// (r<id>_bb=south,west,north,east; see report.ts areaCondition).
// The map is drawn in the browser by Leaflet (public/app.js, /static/vendor/leaflet/),
// with tiles from MAP_TILE_URL (OpenStreetMap by default; the CSP allows its origin).

const MAX_ROWS = 5000;
const num = (v: unknown) => (v === null || v === undefined || v === '' ? NaN : Number(v));
const LOCATION = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

export async function renderMap(ctx: PageContext, r: Region): Promise<Raw> {
  let rows: Record<string, unknown>[];
  try {
    const sql = stripSemicolon(applyBinds(r.source ?? '', bindValues(ctx)));
    const c = ctx.client!;
    rows = (await savepoint(c, () => c.query(`select * from (\n${sql}\n) "__m" limit ${MAX_ROWS}`))).rows;
  } catch (e) {
    return html`<div class="alert alert-error" role="alert">${await publicError(ctx, e, `map "${r.title ?? r.id}"`)}</div>`;
  }
  const link = r.config.link as { page: number; items?: Record<string, string> } | undefined;
  const linkOk = link ? await pageAllowed(ctx, link.page) : false;
  const col = (row: Record<string, unknown>, name: string) => {
    const k = Object.keys(row).find((x) => x.toLowerCase() === name);
    return k === undefined ? undefined : row[k];
  };
  const points: { lat: number; lng: number; title: string; body: string; href: string | null; weight: number }[] = [];
  const shapes: unknown[] = [];
  for (const row of rows) {
    let lat = num(col(row, 'lat') ?? col(row, 'latitude'));
    let lng = num(col(row, 'lng') ?? col(row, 'lon') ?? col(row, 'longitude'));
    const loc = LOCATION.exec(String(col(row, 'location') ?? ''));
    if ((Number.isNaN(lat) || Number.isNaN(lng)) && loc) [lat, lng] = [Number(loc[1]), Number(loc[2])];
    const title = toState(col(row, 'title')) ?? '';
    const body = toState(col(row, 'body')) ?? '';
    let href: string | null = null;
    if (linkOk && link) {
      const items: Record<string, string> = {};
      for (const [k, v] of Object.entries(link.items ?? {}))
        items[k] = v.replace(/#([A-Za-z0-9_]+)#/g, (m, c: string) => toState(col(row, c.toLowerCase())) ?? m);
      href = pageHref(ctx, link.page, items);
    }
    const geo = col(row, 'geojson');
    if (geo) {
      const g = typeof geo === 'string' ? safeJson(geo) : geo;
      if (g && typeof g === 'object') shapes.push({ type: 'Feature', geometry: (g as { type: string }).type === 'Feature' ? (g as { geometry: unknown }).geometry : g, properties: { title, body, href } });
    }
    const w = num(col(row, 'weight'));
    const weight = Number.isFinite(w) && w > 0 ? w : Number.isNaN(w) ? 1 : 0;
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) points.push({ lat, lng, title, body, href, weight });
  }
  if (!points.length && !shapes.length) return html`<p class="empty">${r.config.empty ?? ctx.locale.t('report.no_data')}</p>`;
  const height = ['small', 'large'].includes(r.config.height) ? r.config.height : 'medium';
  const t = ctx.locale.t;
  // the report this map filters: a visible report region on the same page
  const report = ctx.page.regions.find((x) => x.id === Number(r.config.report) && x.type === 'report' && ctx.vis?.regions.has(x.id));
  const filter = report && {
    // __BB__ is replaced by the visible area in the browser
    url: regionUrl(ctx, report, (p) => {
      p.set(key(report, 'bb'), '__BB__');
      p.delete(key(report, 'p'));
    }),
    clear: regionUrl(ctx, report, (p) => {
      p.delete(key(report, 'bb'));
      p.delete(key(report, 'p'));
    }),
    area: parseArea(ctx.params.get(key(report, 'bb'))),
    label: t('map.filter'),
    clearLabel: t('map.filter_clear'),
  };
  const data = {
    tiles: tileUrl(),
    attribution: tileAttribution(),
    zoom: Number.isInteger(r.config.zoom) ? Math.max(1, Math.min(19, r.config.zoom)) : null,
    open: t('map.open'),
    layer: r.config.layer === 'heat' ? 'heat' : 'markers',
    legend: [t('map.fewer'), t('map.more')],
    filter: filter || null,
    points,
    shapes,
  };
  return html`<div class="map map-${height}" data-map role="region" aria-label="${r.title ?? 'Map'}"></div>
    <script type="application/json" class="map-data">${raw(JSON.stringify(data).replace(/</g, '\\u003c'))}</script>
    <details class="map-list"><summary>${ctx.locale.t('map.list', { n: points.length })}</summary>
      <ul>${points.map((p) => html`<li>${p.href ? html`<a href="${p.href}">${p.title || `${p.lat}, ${p.lng}`}</a>` : p.title || `${p.lat}, ${p.lng}`}${p.body ? html` <span class="muted">${p.body}</span>` : ''}</li>`)}</ul>
    </details>`;
}

function safeJson(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** The stylesheet and script a page with a map needs. */
export const mapHead = (ctx: PageContext): Raw | '' =>
  ctx.page.regions.some((r) => r.type === 'map' && ctx.vis?.regions.has(r.id))
    ? html`<link rel="stylesheet" href="/static/vendor/leaflet/leaflet.css"><script src="/static/vendor/leaflet/leaflet.js" defer></script>`
    : '';
