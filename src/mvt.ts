// Mapbox Vector Tiles (MVT 2.1, https://github.com/mapbox/vector-tile-spec):
// a map layer's places, lines and areas for one web-mercator tile, encoded as
// protocol buffers. The map region serves them for layers with "tiles": true
// (src/runtime/maps.ts); app.js draws them, and any MVT client (MapLibre,
// QGIS, OpenLayers) can read them too. No dependency: the encoding is small.

export const EXTENT = 4096;

export interface TileFeature {
  /** GeoJSON geometry in WGS 84 (Point, MultiPoint, LineString, MultiLineString, Polygon, MultiPolygon) */
  geometry: { type: string; coordinates: any };
  properties: Record<string, string | number | boolean | null>;
}

/** The tile's area in WGS 84 (south, west, north, east), widened by `buffer` (a fraction of the tile). */
export function tileArea(z: number, x: number, y: number, buffer = 0) {
  const n = 2 ** z;
  const lng = (t: number) => (t / n) * 360 - 180;
  const lat = (t: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * t) / n))) * 180) / Math.PI;
  const clampLat = (v: number) => Math.max(-85.0511, Math.min(85.0511, v));
  return {
    s: clampLat(lat(y + 1 + buffer)),
    n: clampLat(lat(y - buffer)),
    w: Math.max(-180, lng(x - buffer)),
    e: Math.min(180, lng(x + 1 + buffer)),
  };
}

/** A position in the tile's coordinates (0…EXTENT), web mercator. */
export function project(z: number, x: number, y: number, lng: number, lat: number): [number, number] {
  const n = 2 ** z;
  const la = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  const px = ((lng + 180) / 360) * n;
  const py = ((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2) * n;
  return [Math.round((px - x) * EXTENT), Math.round((py - y) * EXTENT)];
}

// ---------------------------------------------------------------- protocol buffers

class Writer {
  bytes: number[] = [];
  varint(v: number) {
    let n = Math.floor(v);
    while (n > 127) {
      this.bytes.push((n & 127) | 128);
      n = Math.floor(n / 128);
    }
    this.bytes.push(n);
  }
  key(field: number, wire: number) {
    this.varint((field << 3) | wire);
  }
  bytesField(field: number, data: number[] | Uint8Array) {
    this.key(field, 2);
    this.varint(data.length);
    for (const b of data) this.bytes.push(b);
  }
  string(field: number, s: string) {
    this.bytesField(field, new TextEncoder().encode(s));
  }
  packed(field: number, values: number[]) {
    const w = new Writer();
    for (const v of values) w.varint(v);
    this.bytesField(field, w.bytes);
  }
  double(field: number, v: number) {
    this.key(field, 1);
    const b = Buffer.alloc(8);
    b.writeDoubleLE(v);
    for (const x of b) this.bytes.push(x);
  }
}

const zigzag = (n: number) => (n << 1) ^ (n >> 31);
const command = (id: number, count: number) => (id & 7) | (count << 3);

/** Geometry commands for rings or lines (closed rings get ClosePath). */
function pathCommands(paths: [number, number][][], closed: boolean) {
  const out: number[] = [];
  let cx = 0;
  let cy = 0;
  for (const raw of paths) {
    // drop repeated points; a ring's closing point is implied by ClosePath
    const pts = raw.filter((p, i) => i === 0 || p[0] !== raw[i - 1][0] || p[1] !== raw[i - 1][1]);
    if (closed && pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
    if (pts.length < (closed ? 3 : 2)) continue;
    out.push(command(1, 1), zigzag(pts[0][0] - cx), zigzag(pts[0][1] - cy));
    [cx, cy] = pts[0];
    out.push(command(2, pts.length - 1));
    for (const [px, py] of pts.slice(1)) {
      out.push(zigzag(px - cx), zigzag(py - cy));
      [cx, cy] = [px, py];
    }
    if (closed) out.push(command(7, 1));
  }
  return out;
}

/** Twice the signed area of a ring in tile coordinates (y down): exterior rings must be positive. */
const ringArea = (r: [number, number][]) => r.reduce((a, p, i) => a + p[0] * r[(i + 1) % r.length][1] - r[(i + 1) % r.length][0] * p[1], 0);
const oriented = (r: [number, number][], positive: boolean) => ((ringArea(r) > 0) === positive ? r : [...r].reverse());

/** One feature's type and geometry commands, or null when it has none in this tile. */
function encodeGeometry(f: TileFeature, proj: (lng: number, lat: number) => [number, number]): [number, number[]] | null {
  const g = f.geometry;
  const pt = (c: unknown): [number, number] | null => (Array.isArray(c) && Number.isFinite(Number(c[0])) && Number.isFinite(Number(c[1])) ? proj(Number(c[0]), Number(c[1])) : null);
  const line = (cs: unknown) => (Array.isArray(cs) ? cs.map(pt).filter((p): p is [number, number] => !!p) : []);
  switch (g?.type) {
    case 'Point':
    case 'MultiPoint': {
      const pts = (g.type === 'Point' ? [g.coordinates] : g.coordinates ?? []).map(pt).filter((p: [number, number] | null): p is [number, number] => !!p);
      if (!pts.length) return null;
      const out = [command(1, pts.length)];
      let [cx, cy] = [0, 0];
      for (const [px, py] of pts) {
        out.push(zigzag(px - cx), zigzag(py - cy));
        [cx, cy] = [px, py];
      }
      return [1, out];
    }
    case 'LineString':
    case 'MultiLineString': {
      const cmds = pathCommands(g.type === 'LineString' ? [line(g.coordinates)] : (g.coordinates ?? []).map(line), false);
      return cmds.length ? [2, cmds] : null;
    }
    case 'Polygon':
    case 'MultiPolygon': {
      const polys: unknown[][] = g.type === 'Polygon' ? [g.coordinates] : g.coordinates ?? [];
      const rings = polys.flatMap((poly) => (Array.isArray(poly) ? poly.map((r, i) => oriented(line(r), i === 0)) : []));
      const cmds = pathCommands(rings, true);
      return cmds.length ? [3, cmds] : null;
    }
    default:
      return null;
  }
}

/** One layer of a vector tile, as the tile's bytes. */
export function encodeTile(layer: string, z: number, x: number, y: number, features: TileFeature[]): Buffer {
  const keys: string[] = [];
  const values: (string | number | boolean)[] = [];
  const keyIndex = new Map<string, number>();
  const valueIndex = new Map<string, number>();
  const lw = new Writer();
  lw.varint((15 << 3) | 0);
  lw.varint(2);
  lw.string(1, layer);
  const proj = (lng: number, lat: number) => project(z, x, y, lng, lat);
  let id = 0;
  for (const f of features) {
    const geom = encodeGeometry(f, proj);
    if (!geom) continue;
    const tags: number[] = [];
    for (const [k, v] of Object.entries(f.properties)) {
      if (v === null || v === undefined || v === '') continue;
      if (!keyIndex.has(k)) keyIndex.set(k, keys.push(k) - 1);
      const vk = `${typeof v}:${v}`;
      if (!valueIndex.has(vk)) valueIndex.set(vk, values.push(v) - 1);
      tags.push(keyIndex.get(k)!, valueIndex.get(vk)!);
    }
    const fw = new Writer();
    fw.key(1, 0);
    fw.varint(++id);
    if (tags.length) fw.packed(2, tags);
    fw.key(3, 0);
    fw.varint(geom[0]);
    fw.packed(4, geom[1]);
    lw.bytesField(2, fw.bytes);
  }
  for (const k of keys) lw.string(3, k);
  for (const v of values) {
    const vw = new Writer();
    if (typeof v === 'string') vw.string(1, v);
    else if (typeof v === 'boolean') {
      vw.key(7, 0);
      vw.varint(v ? 1 : 0);
    } else vw.double(3, v);
    lw.bytesField(4, vw.bytes);
  }
  lw.key(5, 0);
  lw.varint(EXTENT);
  const tw = new Writer();
  tw.bytesField(3, lw.bytes);
  return Buffer.from(tw.bytes);
}
