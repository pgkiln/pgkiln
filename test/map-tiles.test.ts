// Map layers the browser loads by itself (0.31): by the visible area (JSON)
// and as Mapbox Vector Tiles (src/mvt.ts). The HR example's page 41 has
// 20 000 weather stations as tiles and the high ones by the visible area.
// The tiles are decoded here independently of src/mvt.ts (the MVT 2.1
// spec), so the encoder is checked against the format, not against itself.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { encodeTile, EXTENT, project, tileArea } from '../src/mvt.ts';
import { MAX_AREA_ROWS, MAX_TILE_ROWS, parseTile, servedLayer } from '../src/runtime/maps.ts';
import { mergeMapSettings, type Allowed } from '../src/builder/region-settings.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let king: Browser;
let mapId: number;

before(async () => {
  app = await buildApp({ logger: false });
  king = new Browser(app);
  await king.login('king');
  mapId = (await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 41 and r.type = 'map'`)).id;
});

after(async () => {
  await app.close();
  await closePools();
});

// ---------------------------------------------------------------- a small MVT reader (spec 2.1)

type Feature = { id?: number; type: number; tags: number[]; geometry: number[] };
type Layer = { version?: number; name?: string; extent?: number; keys: string[]; values: unknown[]; features: Feature[] };

function readTile(buf: Buffer): Layer[] {
  let pos = 0;
  const varint = () => {
    let r = 0;
    let m = 1;
    let c: number;
    do {
      c = buf[pos++];
      r += (c & 127) * m;
      m *= 128;
    } while (c & 128);
    return r;
  };
  const fields = (end: number, on: (field: number, wire: number) => void) => {
    while (pos < end) {
      const k = varint();
      on(k >> 3, k & 7);
    }
  };
  const len = () => varint() + pos;
  const text = () => {
    const end = len();
    const s = buf.subarray(pos, end).toString('utf8');
    pos = end;
    return s;
  };
  const packed = () => {
    const end = len();
    const out: number[] = [];
    while (pos < end) out.push(varint());
    return out;
  };
  const layers: Layer[] = [];
  fields(buf.length, (f, w) => {
    assert.equal(`${f}/${w}`, '3/2', 'a tile holds layers only');
    const end = len();
    const layer: Layer = { keys: [], values: [], features: [] };
    fields(end, (f, w) => {
      if (f === 15 && w === 0) layer.version = varint();
      else if (f === 1 && w === 2) layer.name = text();
      else if (f === 5 && w === 0) layer.extent = varint();
      else if (f === 3 && w === 2) layer.keys.push(text());
      else if (f === 4 && w === 2) {
        const vend = len();
        fields(vend, (f, w) => {
          if (f === 1 && w === 2) layer.values.push(text());
          else if (f === 3 && w === 1) {
            layer.values.push(buf.readDoubleLE(pos));
            pos += 8;
          } else if (f === 7 && w === 0) layer.values.push(varint() === 1);
          else assert.fail(`value field ${f}/${w}`);
        });
      } else if (f === 2 && w === 2) {
        const fend = len();
        const feature: Feature = { type: 0, tags: [], geometry: [] };
        fields(fend, (f, w) => {
          if (f === 1 && w === 0) feature.id = varint();
          else if (f === 2 && w === 2) feature.tags = packed();
          else if (f === 3 && w === 0) feature.type = varint();
          else if (f === 4 && w === 2) feature.geometry = packed();
          else assert.fail(`feature field ${f}/${w}`);
        });
        layer.features.push(feature);
      } else assert.fail(`layer field ${f}/${w}`);
    });
    layers.push(layer);
  });
  return layers;
}

/** Commands → [command, points][] with absolute positions. */
function commands(g: number[]) {
  const out: [string, [number, number][]][] = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i < g.length; ) {
    const id = g[i] & 7;
    const n = g[i++] >> 3;
    if (id === 7) {
      out.push(['close', []]);
      continue;
    }
    const pts: [number, number][] = [];
    for (let k = 0; k < n; k++) {
      const dx = g[i++];
      const dy = g[i++];
      x += (dx >>> 1) ^ -(dx & 1);
      y += (dy >>> 1) ^ -(dy & 1);
      pts.push([x, y]);
    }
    out.push([id === 1 ? 'move' : 'line', pts]);
  }
  return out;
}

const props = (l: Layer, f: Feature) => Object.fromEntries(Array.from({ length: f.tags.length / 2 }, (_, i) => [l.keys[f.tags[2 * i]], l.values[f.tags[2 * i + 1]]]));
const signedArea = (r: [number, number][]) => r.reduce((a, p, i) => a + p[0] * r[(i + 1) % r.length][1] - r[(i + 1) % r.length][0] * p[1], 0);

// ---------------------------------------------------------------- the encoder

describe('vector tile encoding (src/mvt.ts)', () => {
  test('tile areas and projection: the tile corners are 0 and the extent', () => {
    const a = tileArea(1, 1, 0);
    assert.deepEqual([a.w, a.e, a.n], [0, 180, 85.0511]);
    assert.ok(Math.abs(a.s) < 1e-9);
    assert.deepEqual(project(1, 1, 0, 0, 0), [0, EXTENT]);
    assert.deepEqual(project(1, 1, 0, 180, 85.0511), [EXTENT, 0]);
    const b = tileArea(4, 8, 5, 1 / 16);
    const plain = tileArea(4, 8, 5);
    assert.ok(b.w < plain.w && b.e > plain.e && b.s < plain.s && b.n > plain.n, 'the margin widens the area');
  });

  test('points, lines and polygons (exterior clockwise in tile space, holes the other way), typed values', () => {
    const square = (x0: number, y0: number, d: number) => [[x0, y0], [x0 + d, y0], [x0 + d, y0 + d], [x0, y0 + d], [x0, y0]];
    const buf = encodeTile('places', 0, 0, 0, [
      { geometry: { type: 'Point', coordinates: [0, 0] }, properties: { title: 'Centre', weight: 2.5, open: true, empty: '', none: null } },
      { geometry: { type: 'LineString', coordinates: [[-90, 0], [0, 0], [0, 0], [90, 0]] }, properties: { title: 'Equator' } },
      { geometry: { type: 'Polygon', coordinates: [square(-40, -40, 80), square(-10, -10, 20).reverse()] }, properties: { title: 'Ring' } },
      { geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 1]]] }, properties: { title: 'Not an area' } },
      { geometry: { type: 'Unknown', coordinates: [] }, properties: {} },
    ]);
    const [layer] = readTile(buf);
    assert.equal(layer.version, 2);
    assert.equal(layer.name, 'places');
    assert.equal(layer.extent, EXTENT);
    assert.equal(layer.features.length, 3, 'features without a geometry are left out');
    const [pt, line, poly] = layer.features;
    assert.deepEqual(props(layer, pt), { title: 'Centre', weight: 2.5, open: true }, 'empty and null values are left out');
    assert.equal(pt.type, 1);
    assert.deepEqual(commands(pt.geometry), [['move', [[EXTENT / 2, EXTENT / 2]]]]);
    assert.equal(line.type, 2);
    const lc = commands(line.geometry);
    assert.deepEqual(lc.map((c) => c[0]), ['move', 'line']);
    assert.equal(lc[1][1].length, 2, 'the repeated point is dropped');
    assert.equal(poly.type, 3);
    const pc = commands(poly.geometry);
    assert.deepEqual(pc.map((c) => c[0]), ['move', 'line', 'close', 'move', 'line', 'close']);
    const rings = [[...pc[0][1], ...pc[1][1]], [...pc[3][1], ...pc[4][1]]];
    assert.equal(rings[0].length, 4, 'the closing point is implied by ClosePath');
    assert.ok(signedArea(rings[0]) > 0, 'exterior ring: positive area (clockwise with y down)');
    assert.ok(signedArea(rings[1]) < 0, 'interior ring: negative area');
    assert.equal(new Set(layer.features.map((f) => f.id)).size, 3, 'unique feature ids');
  });

  test('tile addresses: zoom 0…22, x and y within the zoom level', () => {
    assert.deepEqual(parseTile('4', '8', '5.mvt'), { z: 4, x: 8, y: 5 });
    assert.deepEqual(parseTile('0', '0', '0'), { z: 0, x: 0, y: 0 });
    for (const [z, x, y] of [['23', '0', '0'], ['1', '2', '0'], ['1', '0', '2.mvt'], ['-1', '0', '0'], ['1', '0', '0.png'], ['a', '0', '0'], ['1e1', '0', '0'], ['', '', '']])
      assert.equal(parseTile(z, x, y), null, `${z}/${x}/${y}`);
  });
});

// ---------------------------------------------------------------- the HR example

describe('a large map: vector tiles and the visible area (page 41)', () => {
  const base = () => `/a/hr/41/map/${mapId}`;
  const mapData = (page: string) => JSON.parse(/<script type="application\/json" class="map-data">([^<]*)<\/script>/.exec(page)![1]);

  test('the page carries no places for these layers, only where to load them', async () => {
    const page = (await king.get('/a/hr/41')).body;
    const d = mapData(page);
    assert.deepEqual(d.layers.map((l: any) => [l.name, l.points.length, l.cluster]), [['Stations', 0, false], ['High stations', 0, true]]);
    assert.match(d.layers[0].tiles, new RegExp(`^${base()}/tiles/0/\\{z\\}/\\{x\\}/\\{y\\}\\.mvt\\?v=[0-9a-z]+$`));
    assert.equal(d.layers[0].area, undefined);
    assert.equal(d.layers[1].area, `${base()}/layer/1`);
    assert.equal(d.layers[1].tiles, undefined);
    assert.equal(d.zoomIn, 'Not every place is shown: zoom in to see them all');
    assert.doesNotMatch(page, /<summary>Stations:/, 'no list for a vector tile layer');
  });

  test('a vector tile holds the stations in its area (with a margin), with their popups', async () => {
    const res = await king.get(`${base()}/tiles/0/4/8/5.mvt`);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'application/vnd.mapbox-vector-tile');
    assert.equal(res.headers['cache-control'], 'private, max-age=60');
    assert.equal(res.headers['x-pgkiln-truncated'], undefined);
    const [layer] = readTile(res.rawPayload);
    const a = tileArea(4, 8, 5, 1 / 16);
    const { n } = await owner.one('select count(*)::int as n from hr.weather_station where lat between $1 and $2 and lng between $3 and $4', [a.s, a.n, a.w, a.e]);
    assert.ok(n > 100);
    assert.equal(layer.features.length, n);
    for (const f of layer.features) {
      assert.equal(f.type, 1);
      const [[, [[x, y]]]] = commands(f.geometry);
      assert.ok(x >= -EXTENT / 8 && x <= EXTENT * 1.125 && y >= -EXTENT / 8 && y <= EXTENT * 1.125, `${x},${y} near the tile`);
    }
    const p = props(layer, layer.features[0]);
    assert.match(String(p.title), /^Station \d+$/);
    assert.match(String(p.body), /^\d+ m$/);
    // a tile in the ocean is empty but valid
    const empty = await king.get(`${base()}/tiles/0/4/0/0.mvt`);
    assert.equal(empty.statusCode, 200);
    assert.equal(readTile(empty.rawPayload)[0].features.length, 0);
  });

  test('a tile with more rows than the limit holds the limit and says so', async () => {
    const res = await king.get(`${base()}/tiles/0/0/0/0.mvt`);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['x-pgkiln-truncated'], '1');
    assert.equal(readTile(res.rawPayload)[0].features.length, MAX_TILE_ROWS);
  });

  test('the visible area: only the places in it, at most the limit', async () => {
    const res = await king.get(`${base()}/layer/1?bb=45,5,47,8`);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], 'private, no-store');
    const got = JSON.parse(res.body);
    const { n } = await owner.one('select count(*)::int as n from hr.weather_station where elevation > 2000 and lat between 45 and 47 and lng between 5 and 8');
    assert.ok(n > 0);
    assert.equal(got.points.length, n);
    assert.equal(got.truncated, false);
    assert.ok(got.points.every((p: any) => p.lat >= 45 && p.lat <= 47 && p.lng >= 5 && p.lng <= 8));
    const all = JSON.parse((await king.get(`${base()}/layer/1?bb=-90,-180,90,180`)).body);
    assert.equal(all.points.length, MAX_AREA_ROWS);
    assert.equal(all.truncated, true);
    // across the antimeridian (west > east): Europe is outside
    assert.equal(JSON.parse((await king.get(`${base()}/layer/1?bb=-10,170,10,-170`)).body).points.length, 0);
  });

  test('only layers loaded this way, on a visible map region; addresses and areas checked', async () => {
    assert.equal((await king.get(`${base()}/layer/0?bb=45,5,47,8`)).statusCode, 403, 'layer 0 is tiles');
    assert.equal((await king.get(`${base()}/tiles/1/4/8/5.mvt`)).statusCode, 403, 'layer 1 is by area');
    assert.equal((await king.get(`${base()}/tiles/2/4/8/5.mvt`)).statusCode, 403, 'no layer 2');
    assert.equal((await king.get(`${base()}/layer/x?bb=45,5,47,8`)).statusCode, 403);
    assert.equal((await king.get(`${base()}/tiles/0/4/16/5.mvt`)).statusCode, 404);
    for (const bb of ['', '1,2,3', '45,5,47,8) or (1=1', '95,0,96,1', '47,5,45,8'])
      assert.equal((await king.get(`${base()}/layer/1?bb=${encodeURIComponent(bb)}`)).statusCode, 400, bb);
    // a map on another page: not through this page
    const other = (await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 33 and r.type = 'map'`)).id;
    assert.equal((await king.get(`/a/hr/41/map/${other}/tiles/0/4/8/5.mvt`)).statusCode, 403);
    assert.equal((await king.get(`/a/hr/33/map/${other}/tiles/0/4/8/5.mvt`)).statusCode, 403, 'that map has no tile layers');
  });

  test('a layer without a position to filter on says so', async () => {
    const r = (await owner.one('select config from meta.region where id = $1', [mapId])).config;
    try {
      await owner.query('update meta.region set source = $2 where id = $1', [mapId, `select name as title from hr.weather_station`]);
      const res = await king.get(`${base()}/tiles/0/4/8/5.mvt`);
      assert.equal(res.statusCode, 400);
      assert.match(JSON.parse(res.body).error, /no position to filter by the visible area/);
    } finally {
      await owner.query('update meta.region set source = $2, config = $3 where id = $1', [mapId, `select lat, lng, name as title, elevation || ' m' as body from hr.weather_station`, r]);
    }
  });

  test('servedLayer: a layer is served one way only', () => {
    const r = { type: 'map', source: 'select 1', config: { tiles: true, visible_area: true, layers: [{ source: 'select 2', visible_area: true }] } } as any;
    assert.ok(servedLayer(r, 0, 'tiles'));
    assert.equal(servedLayer(r, 0, 'area'), null, 'tiles win over the visible area');
    assert.ok(servedLayer(r, 1, 'area'));
    assert.equal(servedLayer(r, 1, 'tiles'), null);
    assert.equal(servedLayer({ ...r, type: 'report' }, 0, 'tiles'), null);
    assert.equal(servedLayer(r, 1.5, 'area'), null);
  });

  test('builder settings: Load is all rows, the visible area or vector tiles (no clustering with tiles)', () => {
    const allowed: Allowed = { pages: new Set(), lovs: new Set(), reports: new Map() };
    assert.deepEqual(mergeMapSettings({}, { load: 'tiles', cluster: 'true' }, allowed), { tiles: true });
    assert.deepEqual(mergeMapSettings({ tiles: true }, { load: 'area', cluster: 'true' }, allowed), { cluster: true, visible_area: true });
    assert.deepEqual(mergeMapSettings({ visible_area: true }, { load: '' }, allowed), {});
    const cfg = mergeMapSettings({}, { layers: '1', layer0_source: 'select 1', layer0_load: 'tiles', layer0_cluster: 'true', layer1_source: 'select 2', layer1_load: 'area' }, allowed);
    assert.deepEqual(cfg.layers, [{ name: 'Layer 2', source: 'select 1', tiles: true }, { name: 'Layer 3', source: 'select 2', visible_area: true }]);
  });
});
