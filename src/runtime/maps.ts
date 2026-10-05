import type pg from 'pg';
import { applyBinds } from '../binds.ts';
import { savepoint } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import type { Region } from '../metadata.ts';
import { pageAllowed } from './authz.ts';
import { bindValues, publicError, stripSemicolon, toState, type PageContext } from './context.ts';
import { pageHref } from './links.ts';
import { key, regionUrl } from './report.ts';
import { geoJsonSelect, parseArea, parseNear, postgis, spatialColumn, type PostGis } from './spatial.ts';
import { tileAttribution, tileUrl } from '../maptiles.ts';

// Map region (APEX: Map region). The SELECT returns, per row, a position
// (columns lat and lng, latitude and longitude, or location as "lat,lng")
// and optionally title, body and geojson (a GeoJSON geometry or feature for
// lines and areas; a GeoJSON point is a place), and weight (for a heat map).
// With PostGIS installed, a geometry or geography column (WGS 84) is turned
// into GeoJSON on the server (ST_AsGeoJSON), so no geojson column is needed.
// config:
//   {"link": {"page": 5, "items": {"P5_ID": "#id#"}}, "height": "small|medium|large", "zoom": 12,
//    "layer": "markers|heat", "cluster": true, "name": "Offices",
//    "layers": [{"name": "Routes", "source": "select …", "layer": "markers|heat", "cluster": true,
//                "link": {…}, "hidden": true}],
//    "report": <id of a report region on the page>, "filter": "area|distance"}
// The region's own query is the first layer; "layers" adds more, each with its
// own query, shown in a legend where users switch them on and off. "cluster"
// groups markers that are close together at the current zoom level (with
// their count; a click zooms in). layer "heat" draws the points as a heat map
// (weighted by the weight column).
// With "report", users can filter that report to the map's visible area
// (r<id>_bb=south,west,north,east) or, with filter "distance", to the places
// within a distance of the map's centre (r<id>_near=lat,lng,km); the report
// runs the condition on the server (see spatial.ts: PostGIS or lat/lng).
// The map is drawn in the browser by Leaflet (public/app.js, /static/vendor/leaflet/),
// with tiles from MAP_TILE_URL (OpenStreetMap by default; the CSP allows its origin).

const MAX_ROWS = 5000;
/** the region's own query and at most this many more layers */
export const MAX_EXTRA_LAYERS = 7;
const num = (v: unknown) => (v === null || v === undefined || v === '' ? NaN : Number(v));
const LOCATION = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

type Link = { page: number; items?: Record<string, string> };
interface Point {
  lat: number;
  lng: number;
  title: string;
  body: string;
  href: string | null;
  weight: number;
}
export interface LayerDef {
  name: string;
  source: string;
  kind: 'markers' | 'heat';
  cluster: boolean;
  link: Link | undefined;
  hidden: boolean;
}

/** The map's layers: the region's own query first, then config.layers (with a query each). */
export function layerDefs(r: Region): LayerDef[] {
  const first: LayerDef = {
    name: typeof r.config.name === 'string' && r.config.name.trim() ? r.config.name.trim() : (r.title ?? 'Map'),
    source: r.source ?? '',
    kind: r.config.layer === 'heat' ? 'heat' : 'markers',
    cluster: r.config.cluster === true,
    link: r.config.link,
    hidden: false,
  };
  const more = (Array.isArray(r.config.layers) ? r.config.layers : [])
    .filter((l: any) => l && typeof l === 'object' && typeof l.source === 'string' && l.source.trim())
    .slice(0, MAX_EXTRA_LAYERS)
    .map((l: any, i: number): LayerDef => ({
      name: typeof l.name === 'string' && l.name.trim() ? l.name.trim() : `Layer ${i + 2}`,
      source: l.source,
      kind: l.layer === 'heat' ? 'heat' : 'markers',
      cluster: l.cluster === true,
      link: l.link && typeof l.link === 'object' && Number.isInteger(l.link.page) ? l.link : undefined,
      hidden: l.hidden === true,
    }));
  return [first, ...more];
}

/** A layer query's SELECT (with a GeoJSON column for a PostGIS geometry when PostGIS is installed). */
export function layerSql(sql: string, g: PostGis | null, fields: { name: string; dataTypeID: number }[] | null) {
  const shape = g && fields && !fields.some((f) => f.name.toLowerCase() === 'geojson') ? spatialColumn(new Map(fields.map((f) => [f.name, f.dataTypeID])), g) : null;
  return `select ${shape && g ? geoJsonSelect(g, shape) : '*'} from (\n${sql}\n) "__m" limit ${MAX_ROWS}`;
}

async function loadLayer(ctx: PageContext, def: LayerDef, g: PostGis | null) {
  const sql = stripSemicolon(applyBinds(def.source, bindValues(ctx)));
  const c = ctx.client!;
  const probe = g ? (await savepoint(c, () => c.query(`select * from (\n${sql}\n) "__m" limit 0`))).fields : null;
  const rows: Record<string, unknown>[] = (await savepoint(c, () => c.query(layerSql(sql, g, probe as pg.FieldDef[] | null)))).rows;
  const link = def.link;
  const linkOk = link ? await pageAllowed(ctx, link.page) : false;
  const col = (row: Record<string, unknown>, name: string) => {
    const k = Object.keys(row).find((x) => x.toLowerCase() === name);
    return k === undefined ? undefined : row[k];
  };
  const points: Point[] = [];
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
        items[k] = String(v).replace(/#([A-Za-z0-9_]+)#/g, (m, c: string) => toState(col(row, c.toLowerCase())) ?? m);
      href = pageHref(ctx, link.page, items);
    }
    const geo = col(row, 'geojson') ?? row.__geojson;
    if (geo) {
      const g = typeof geo === 'string' ? safeJson(geo) : geo;
      const geometry = g && typeof g === 'object' ? ((g as { type: string }).type === 'Feature' ? (g as { geometry: any }).geometry : g) : null;
      if (geometry?.type === 'Point' && Array.isArray(geometry.coordinates) && (Number.isNaN(lat) || Number.isNaN(lng)))
        // a point is a place (a marker, a heat spot, part of a cluster)
        [lng, lat] = geometry.coordinates.map(Number);
      else if (geometry && typeof geometry === 'object') shapes.push({ type: 'Feature', geometry, properties: { title, body, href } });
    }
    const w = num(col(row, 'weight'));
    const weight = Number.isFinite(w) && w > 0 ? w : Number.isNaN(w) ? 1 : 0;
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) points.push({ lat, lng, title, body, href, weight });
  }
  return { points, shapes };
}

export async function renderMap(ctx: PageContext, r: Region): Promise<Raw> {
  const g = await postgis();
  const defs = layerDefs(r);
  const t = ctx.locale.t;
  const layers: { name: string; kind: LayerDef['kind']; cluster: boolean; hidden: boolean; color: number; points: Point[]; shapes: unknown[] }[] = [];
  const errors: Raw[] = [];
  for (const [i, def] of defs.entries()) {
    try {
      const { points, shapes } = await loadLayer(ctx, def, g);
      layers.push({ name: ctx.locale.tr(def.name), kind: def.kind, cluster: def.cluster && def.kind === 'markers', hidden: def.hidden, color: i + 1, points, shapes });
    } catch (e) {
      const where = i ? `map "${r.title ?? r.id}", layer "${def.name}"` : `map "${r.title ?? r.id}"`;
      const alert = html`<div class="alert alert-error" role="alert">${await publicError(ctx, e, where)}</div>`;
      // the region's own query failing fails the map, as for other regions
      if (!i) return alert;
      errors.push(alert);
    }
  }
  if (!layers.some((l) => l.points.length || l.shapes.length)) return html`${errors}<p class="empty">${r.config.empty ?? t('report.no_data')}</p>`;
  const height = ['small', 'large'].includes(r.config.height) ? r.config.height : 'medium';
  // the report this map filters: a visible report region on the same page
  const report = ctx.page.regions.find((x) => x.id === Number(r.config.report) && x.type === 'report' && ctx.vis?.regions.has(x.id));
  const distance = r.config.filter === 'distance';
  const filter = report && {
    mode: distance ? 'distance' : 'area',
    // __BB__ / __NEAR__ is replaced by the visible area / the centre and a distance in the browser
    url: regionUrl(ctx, report, (p) => {
      p.set(key(report, distance ? 'near' : 'bb'), distance ? '__NEAR__' : '__BB__');
      p.delete(key(report, distance ? 'bb' : 'near'));
      p.delete(key(report, 'p'));
    }),
    clear: regionUrl(ctx, report, (p) => {
      p.delete(key(report, 'bb'));
      p.delete(key(report, 'near'));
      p.delete(key(report, 'p'));
    }),
    area: parseArea(ctx.params.get(key(report, 'bb'))),
    near: parseNear(ctx.params.get(key(report, 'near'))),
    label: t(distance ? 'map.near' : 'map.filter'),
    clearLabel: t('map.filter_clear'),
  };
  const data = {
    tiles: tileUrl(),
    attribution: tileAttribution(),
    zoom: Number.isInteger(r.config.zoom) ? Math.max(1, Math.min(19, r.config.zoom)) : null,
    open: t('map.open'),
    legend: [t('map.fewer'), t('map.more')],
    layersLabel: t('map.layers'),
    clusterLabel: t('map.cluster'),
    filter: filter || null,
    layers,
  };
  const several = layers.length > 1;
  const list = (l: (typeof layers)[number]) =>
    html`<details class="map-list"><summary>${several ? `${l.name}: ` : ''}${t('map.list', { n: l.points.length })}</summary>
      <ul>${l.points.map((p) => html`<li>${p.href ? html`<a href="${p.href}">${p.title || `${p.lat}, ${p.lng}`}</a>` : p.title || `${p.lat}, ${p.lng}`}${p.body ? html` <span class="muted">${p.body}</span>` : ''}</li>`)}</ul>
    </details>`;
  return html`${errors}<div class="map map-${height}" data-map role="region" aria-label="${r.title ?? 'Map'}"></div>
    <script type="application/json" class="map-data">${raw(JSON.stringify(data).replace(/</g, '\\u003c'))}</script>
    ${layers.filter((l, i) => !i || l.points.length).map(list)}`;
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
