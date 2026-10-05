import pg from 'pg';
import { runtime } from '../db.ts';

// Spatial filtering on the server (APEX: spatial queries of the map region).
// A report that a map region filters can be narrowed to the map's visible
// area (r<id>_bb=south,west,north,east) or to the places within a distance of
// a point (r<id>_near=lat,lng,km). With PostGIS installed and a geometry or
// geography column in the report, the condition uses PostGIS (ST_Intersects
// with an envelope, ST_DWithin on geography, so in metres); otherwise plain
// latitude/longitude columns (or location text "lat,lng") are compared with
// numbers: a bounding box, and the haversine distance for "near".
// Every number in the SQL is parsed from the URL first; no URL text reaches it.

/** A map's visible area: south, west, north, east (west > east when it spans the antimeridian). */
export interface MapArea {
  s: number;
  w: number;
  n: number;
  e: number;
}

/** Places within km kilometres of lat/lng. */
export interface Near {
  lat: number;
  lng: number;
  km: number;
}

const NUMBER = /^\s*-?\d{1,3}(\.\d{1,8})?\s*$/;
/** half the earth's circumference: every place is nearer than this */
export const MAX_KM = 20038;
/** the mean earth radius in km (IUGG), as PostGIS uses for geography distances on a sphere */
const EARTH_KM = 6371.0088;

/** "south,west,north,east" → a map area, or null when it isn't one. */
export function parseArea(v: string | null): MapArea | null {
  const parts = (v ?? '').split(',');
  if (parts.length !== 4 || parts.some((x) => !NUMBER.test(x))) return null;
  const [s, w, n, e] = parts.map(Number);
  return Math.abs(s) <= 90 && Math.abs(n) <= 90 && s <= n && Math.abs(w) <= 180 && Math.abs(e) <= 180 ? { s, w, n, e } : null;
}

/** "lat,lng,km" → a point and a distance, or null when it isn't one. */
export function parseNear(v: string | null): Near | null {
  const parts = (v ?? '').split(',');
  if (parts.length !== 3 || !NUMBER.test(parts[0]) || !NUMBER.test(parts[1]) || !/^\s*\d{1,5}(\.\d{1,3})?\s*$/.test(parts[2])) return null;
  const [lat, lng, km] = parts.map(Number);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && km > 0 && km <= MAX_KM ? { lat, lng, km } : null;
}

/**
 * The columns a report's rows have their position in, as for a map region:
 * lat/lng (or latitude/longitude, lon), or location as "lat,lng" text.
 */
export type Position = { lat: string; lng: string } | { location: string };
export function positionColumns(names: string[]): Position | null {
  const find = (...want: string[]) => names.find((n) => want.includes(n.toLowerCase()));
  const lat = find('lat', 'latitude');
  const lng = find('lng', 'lon', 'longitude');
  if (lat && lng) return { lat, lng };
  const location = find('location');
  return location ? { location } : null;
}

const LOCATION_RE = `'^\\s*-?\\d{1,2}(\\.\\d+)?\\s*,\\s*-?\\d{1,3}(\\.\\d+)?\\s*$'`;
const col = (name: string, alias: string) => `${alias}.${pg.escapeIdentifier(name)}`;

/** SQL expressions for a row's latitude and longitude (float8; null when the location text isn't a place). */
export function positionSql(pos: Position, alias = '"__q"'): [string, string] {
  if ('lat' in pos) return [`(${col(pos.lat, alias)})::float8`, `(${col(pos.lng, alias)})::float8`];
  const loc = col(pos.location, alias);
  return [1, 2].map((i) => `(case when ${loc}::text ~ ${LOCATION_RE} then trim(split_part(${loc}::text, ',', ${i}))::float8 end)`) as [string, string];
}

/** SQL for "the row lies in the area" from latitude/longitude columns. */
export function areaCondition(area: MapArea, pos: Position, alias = '"__q"') {
  const [lat, lng] = positionSql(pos, alias);
  const lngIn = area.w <= area.e ? `${lng} between ${area.w} and ${area.e}` : `(${lng} >= ${area.w} or ${lng} <= ${area.e})`;
  return `(${lat} between ${area.s} and ${area.n} and ${lngIn})`;
}

/**
 * The smallest area around a circle (lat/lng ± km), for a cheap first test
 * before the exact distance; null when it reaches a pole (every longitude).
 */
export function nearArea(near: Near): MapArea | null {
  const dLat = (near.km / EARTH_KM) * (180 / Math.PI);
  const s = near.lat - dLat;
  const n = near.lat + dLat;
  if (s <= -90 || n >= 90) return null;
  // the widest longitude span of the circle (at the latitude where it touches its meridians)
  const ratio = Math.sin(near.km / EARTH_KM) / Math.cos((near.lat * Math.PI) / 180);
  if (ratio >= 1) return null;
  const dLng = Math.asin(ratio) * (180 / Math.PI);
  const round = (v: number, up: boolean) => (up ? Math.ceil(v * 1e6) : Math.floor(v * 1e6)) / 1e6;
  const wrap = (v: number) => (v > 180 ? v - 360 : v < -180 ? v + 360 : v);
  return dLng >= 180
    ? { s: round(s, false), w: -180, n: round(n, true), e: 180 }
    : { s: round(s, false), w: round(wrap(near.lng - dLng), false), n: round(n, true), e: round(wrap(near.lng + dLng), true) };
}

/** SQL for "the row lies within near.km of the point" from latitude/longitude columns (haversine). */
export function nearCondition(near: Near, pos: Position, alias = '"__q"') {
  const [lat, lng] = positionSql(pos, alias);
  const box = nearArea(near);
  const r = (x: string) => `radians(${x})`;
  const hav = `power(sin((${r(lat)} - ${r(String(near.lat))}) / 2), 2) + cos(${r(String(near.lat))}) * cos(${r(lat)}) * power(sin((${r(lng)} - ${r(String(near.lng))}) / 2), 2)`;
  const distance = `(2 * ${EARTH_KM} * asin(sqrt(least(1, ${hav}))))`;
  const inBox = box ? `${areaCondition(box, pos, alias)} and ` : `${lat} is not null and ${lng} is not null and `;
  return `(${inBox}${distance} <= ${near.km})`;
}

// ---------------------------------------------------------------- PostGIS

/** The installed PostGIS: the schema of its functions and its types' oids. */
export interface PostGis {
  schema: string;
  version: string;
  geometry: number | null;
  geography: number | null;
}

let cached: { at: number; value: PostGis | null } | null = null;
let forced: PostGis | null | undefined;
const TTL_MS = 60_000;

/** PostGIS when the extension is installed in the database (looked up once a minute), else null. */
export async function postgis(): Promise<PostGis | null> {
  if (forced !== undefined) return forced;
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
  const row = await runtime.one<{ schema: string; version: string; geometry: number | null; geography: number | null }>(
    `select n.nspname as schema, e.extversion as version,
            (select t.oid::int from pg_type t where t.typname = 'geometry' and t.typnamespace = e.extnamespace) as geometry,
            (select t.oid::int from pg_type t where t.typname = 'geography' and t.typnamespace = e.extnamespace) as geography
       from pg_extension e join pg_namespace n on n.oid = e.extnamespace
      where e.extname = 'postgis'`,
  );
  const value = row ? { schema: row.schema, version: row.version, geometry: row.geometry ?? null, geography: row.geography ?? null } : null;
  cached = { at: Date.now(), value };
  return value;
}

/** Tests: pretend PostGIS is (or isn't) installed; undefined looks it up again. */
export function setPostgis(v: PostGis | null | undefined) {
  forced = v;
  cached = null;
}

export type SpatialColumn = { name: string; kind: 'geometry' | 'geography' };
const PREFERRED = ['geom', 'geometry', 'geog', 'geography', 'the_geom', 'shape', 'location'];

/** The report's geometry or geography column (one named geom, geometry, … first), or null. */
export function spatialColumn(cols: Map<string, number>, g: PostGis | null): SpatialColumn | null {
  if (!g) return null;
  const kindOf = (oid: number): SpatialColumn['kind'] | null => (oid === g.geometry ? 'geometry' : oid === g.geography ? 'geography' : null);
  const all = [...cols].flatMap(([name, oid]): SpatialColumn[] => {
    const kind = kindOf(oid);
    return kind ? [{ name, kind }] : [];
  });
  return all.find((c) => PREFERRED.includes(c.name.toLowerCase())) ?? all[0] ?? null;
}

const fn = (g: PostGis, name: string) => `${pg.escapeIdentifier(g.schema)}.${name}`;
const geographyType = (g: PostGis) => `${pg.escapeIdentifier(g.schema)}.geography`;

/** WGS 84 envelopes for an area (two across the antimeridian). */
function envelopes(g: PostGis, a: MapArea) {
  const env = (w: number, e: number) => `${fn(g, 'st_makeenvelope')}(${w}, ${a.s}, ${e}, ${a.n}, 4326)`;
  return a.w <= a.e ? [env(a.w, a.e)] : [env(a.w, 180), env(-180, a.e)];
}

/**
 * PostGIS SQL for "the row's shape touches the area". Geometry columns are
 * expected in WGS 84 (SRID 4326), as GeoJSON and the map use; geography is.
 */
export function postgisAreaCondition(g: PostGis, c: SpatialColumn, area: MapArea, alias = '"__q"') {
  const column = col(c.name, alias);
  const parts = envelopes(g, area).map((env) => `${fn(g, 'st_intersects')}(${column}, ${c.kind === 'geography' ? `${env}::${geographyType(g)}` : env})`);
  return parts.length === 1 ? parts[0] : `(${parts.join(' or ')})`;
}

/** PostGIS SQL for "the row's shape is within near.km of the point" (on the spheroid, in metres). */
export function postgisNearCondition(g: PostGis, c: SpatialColumn, near: Near, alias = '"__q"') {
  const column = col(c.name, alias);
  const point = `${fn(g, 'st_setsrid')}(${fn(g, 'st_makepoint')}(${near.lng}, ${near.lat}), 4326)::${geographyType(g)}`;
  return `${fn(g, 'st_dwithin')}(${c.kind === 'geography' ? column : `${column}::${geographyType(g)}`}, ${point}, ${near.km * 1000})`;
}

/**
 * The WHERE conditions for a map area and/or a distance, from a report's
 * columns (name → type oid): PostGIS when it is installed and the report has
 * a geometry or geography column, else latitude/longitude. `ok` is false when
 * a filter was asked for but the report has neither.
 */
export function spatialConditions(f: { area: MapArea | null; near: Near | null }, cols: Map<string, number>, g: PostGis | null, alias = '"__q"') {
  if (!f.area && !f.near) return { where: [] as string[], ok: true, postgis: false };
  const shape = spatialColumn(cols, g);
  if (shape && g) {
    const where = [];
    if (f.area) where.push(postgisAreaCondition(g, shape, f.area, alias));
    if (f.near) where.push(postgisNearCondition(g, shape, f.near, alias));
    return { where, ok: true, postgis: true };
  }
  const pos = positionColumns([...cols.keys()]);
  if (!pos) return { where: [] as string[], ok: false, postgis: false };
  const where = [];
  if (f.area) where.push(areaCondition(f.area, pos, alias));
  if (f.near) where.push(nearCondition(f.near, pos, alias));
  return { where, ok: true, postgis: false };
}

/** The SELECT list that adds a GeoJSON column for a map layer's geometry or geography column. */
export function geoJsonSelect(g: PostGis, c: SpatialColumn, alias = '"__m"') {
  return `${alias}.*, ${fn(g, 'st_asgeojson')}(${col(c.name, alias)}) as "__geojson"`;
}
