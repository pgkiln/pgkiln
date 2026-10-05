// Map and tree regions (the HR example: page 4 has the offices on a map,
// page 8 the reporting lines as a tree). The map in a real browser is in
// test/e2e/maps.test.ts.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { tileOrigin } from '../src/maptiles.ts';
import { areaCondition, parseArea, positionColumns } from '../src/runtime/report.ts';
import { layerDefs, layerSql } from '../src/runtime/maps.ts';
import { advise } from '../src/builder/advisor.ts';
import {
  geoJsonSelect, nearArea, nearCondition, parseNear, postgis, postgisAreaCondition, postgisNearCondition, setPostgis, spatialColumn, spatialConditions, type PostGis,
} from '../src/runtime/spatial.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let king: Browser;

before(async () => {
  app = await buildApp({ logger: false });
  king = new Browser(app);
  await king.login('king');
});

after(async () => {
  await owner.query(`update hr.emp set work_location = null where empno = 7788`);
  await app.close();
  await closePools();
});

const mapData = (page: string) => JSON.parse(/<script type="application\/json" class="map-data">([^<]*)<\/script>/.exec(page)![1]);

describe('map region', () => {
  test('places from lat/lng and location columns, links, a list without script, Leaflet only on map pages', async () => {
    await owner.query(`update hr.emp set work_location = '52.01160, 4.35710' where empno = 7788`);
    const res = await king.get('/a/hr/4');
    const page = res.body;
    assert.match(page, /<div class="map[^"]*" data-map/);
    const d = mapData(page);
    const titles = d.layers[0].points.map((p: any) => p.title).sort();
    assert.deepEqual(titles, ['ACCOUNTING', 'OPERATIONS', 'RESEARCH', 'SALES', 'Scott']);
    const scott = d.layers[0].points.find((p: any) => p.title === 'Scott');
    assert.deepEqual([scott.lat, scott.lng], [52.0116, 4.3571], 'from "lat,lng" text');
    assert.match(d.layers[0].points.find((p: any) => p.title === 'SALES').href, /\/a\/hr\/5\?.*P5_DEPTNO=30/);
    assert.match(page, /<details class="map-list">/);
    assert.match(page, /<link rel="stylesheet" href="\/static\/vendor\/leaflet\/leaflet.css">/);
    assert.match(page, /<script src="\/static\/vendor\/leaflet\/leaflet.js" defer><\/script>/);
    assert.ok(res.headers['content-security-policy']!.toString().includes(`img-src 'self' data: ${tileOrigin()}`));
    assert.doesNotMatch((await king.get('/a/hr/2')).body, /leaflet/, 'no Leaflet on pages without a map');
    assert.equal((await king.get('/static/vendor/leaflet/leaflet.js')).statusCode, 200);
  });

  test('the JSON in the page cannot close the script element', async () => {
    await owner.query(`update hr.emp set work_location = '1,1' where empno = 7788`);
    await owner.query(`update hr.emp set ename = '</script><b>x' where empno = 7788`);
    try {
      const page = (await king.get('/a/hr/4')).body;
      assert.doesNotMatch(page, /<\/script><b>x/i);
      assert.ok(mapData(page).layers[0].points.some((p: any) => p.title.toLowerCase() === '</script><b>x'));
    } finally {
      await owner.query(`update hr.emp set ename = 'SCOTT', work_location = null where empno = 7788`);
    }
  });

  test('the tile origin', () => {
    assert.equal(tileOrigin(), 'https://tile.openstreetmap.org');
    const was = process.env.MAP_TILE_URL;
    process.env.MAP_TILE_URL = 'https://{s}.tiles.example.com:8443/x/{z}/{x}/{y}.png';
    try {
      assert.equal(tileOrigin(), 'https://*.tiles.example.com:8443');
    } finally {
      if (was === undefined) delete process.env.MAP_TILE_URL;
      else process.env.MAP_TILE_URL = was;
    }
  });
});

describe('heat maps and filtering a report by the map area (page 16)', () => {
  const reportId = async () =>
    (await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 16 and r.type = 'report'`)).id as number;
  const maps = (page: string) => [...page.matchAll(/<script type="application\/json" class="map-data">([^<]*)<\/script>/g)].map((m) => JSON.parse(m[1]));
  const names = (page: string) => [...page.matchAll(/<td[^>]*>(ALLEN|WARD|MARTIN|BLAKE|TURNER|JAMES|KING|CLARK|MILLER|JONES|FORD|SMITH|SCOTT|ADAMS)<\/td>/g)].map((m) => m[1]).sort();

  test('a heat map layer carries the weights; markers are the default', async () => {
    const [heat, offices] = maps((await king.get('/a/hr/16')).body);
    assert.equal(heat.layers[0].kind, 'heat');
    assert.equal(heat.layers[0].points.length, 14);
    assert.ok(heat.layers[0].points.some((p: any) => p.weight === 5000), 'weighted by salary');
    assert.deepEqual(heat.legend, ['Fewer', 'More']);
    assert.equal(offices.layers[0].kind, 'markers');
  });

  test('the map that filters the report gets its URL; the area filters the rows and shows a chip', async () => {
    const id = await reportId();
    const all = (await king.get('/a/hr/16')).body;
    const f = maps(all)[1].filter;
    assert.match(f.url, new RegExp(`^/a/hr/16\\?r${id}_bb=__BB__$`));
    assert.equal(f.area, null);
    assert.equal(maps(all)[0].filter, null, 'the heat map filters nothing');
    assert.doesNotMatch(all, /Map area/);
    // around Chicago
    const page = (await king.get(`/a/hr/16?r${id}_bb=${encodeURIComponent('40,-89,43,-86')}`)).body;
    assert.deepEqual(names(page), ['ALLEN', 'BLAKE', 'JAMES', 'MARTIN', 'TURNER', 'WARD']);
    assert.match(page, /<span class="chip">Map area/);
    assert.deepEqual(maps(page)[1].filter.area, { s: 40, w: -89, n: 43, e: -86 });
    assert.match(maps(page)[1].filter.clear, /^\/a\/hr\/16$/);
  });

  test('areas that are not areas are ignored', async () => {
    const id = await reportId();
    for (const bb of ['abc', '1,2,3', '91,0,92,1', '10,0,5,1', "40,-89,43,-86); delete from hr.emp; --", '40,-89,43,1e3']) {
      const page = (await king.get(`/a/hr/16?r${id}_bb=${encodeURIComponent(bb)}`)).body;
      assert.equal(names(page).length, 10, bb);
      assert.doesNotMatch(page, /Map area|alert-error/, bb);
    }
    assert.equal(parseArea('-10.5,170,10,-170')?.w, 170);
  });

  test('position columns: lat/lng, latitude/longitude, location text; across the antimeridian', async () => {
    assert.deepEqual(positionColumns(['ID', 'Latitude', 'LON']), { lat: 'Latitude', lng: 'LON' });
    assert.deepEqual(positionColumns(['id', 'location']), { location: 'location' });
    assert.equal(positionColumns(['id', 'lat']), null);
    const pick = async (cols: string, values: string, area: string, pos: any) =>
      (await owner.query(`select "__q".id from (select * from (values ${values}) v (${cols})) "__q" where ${areaCondition(parseArea(area)!, pos)} order by 1`)).rows.map((r) => r.id);
    assert.deepEqual(await pick('id, location', `(1, '52.01, 4.35'), (2, 'not a place'), (3, null), (4, '40.7,-74.0')`, '50,0,55,10', { location: 'location' }), [1]);
    assert.deepEqual(await pick('id, lat, lng', '(1, 0, 179), (2, 0, -179), (3, 0, 0)', '-5,170,5,-170', { lat: 'lat', lng: 'lng' }), [1, 2]);
  });

  test('a report without position columns: the chip says the area does not filter it', async () => {
    const id = await reportId();
    const before = (await owner.one('select source from meta.region where id = $1', [id])).source;
    await owner.query(`update meta.region set source = 'select empno, ename from hr.emp' where id = $1`, [id]);
    try {
      const page = (await king.get(`/a/hr/16?r${id}_bb=${encodeURIComponent('40,-89,43,-86')}`)).body;
      assert.match(page, /<span class="chip chip-error" title="This report has no lat\/lng or location columns/);
      assert.equal(names(page).length, 10, 'not filtered');
    } finally {
      await owner.query('update meta.region set source = $2 where id = $1', [id, before]);
    }
  });
});

describe('several layers, clustering and the distance filter (page 33)', () => {
  const ids = async () =>
    (await owner.query(`select r.id, r.type from meta.region r join meta.page p on p.id = r.page_id join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 33 order by r.seq`)).rows as { id: number; type: string }[];

  test('one map, a layer per query: names, kinds, clustering, colours, lines and areas, the heat map off at first', async () => {
    const page = (await king.get('/a/hr/33')).body;
    const d = mapData(page);
    assert.deepEqual(d.layers.map((l: any) => [l.name, l.kind, l.cluster, l.hidden, l.color]), [
      ['Visits', 'markers', true, false, 1],
      ['Offices', 'markers', false, false, 2],
      ['Sales areas', 'markers', false, false, 3],
      ['Visit density', 'heat', false, true, 4],
    ]);
    assert.equal(d.layers[0].points.length, 80);
    assert.equal(d.layers[1].points.length, 4);
    assert.match(d.layers[1].points.find((p: any) => p.title === 'SALES').href, /\/a\/hr\/5\?.*P5_DEPTNO=30/, "a layer's own link");
    assert.equal(d.layers[0].points[0].href, null, 'the first layer has no link');
    assert.deepEqual(d.layers[2].shapes.map((s: any) => s.geometry.type).sort(), ['LineString', 'LineString', 'LineString', 'Polygon', 'Polygon', 'Polygon', 'Polygon']);
    assert.equal(d.layers[3].points.length, 80);
    assert.equal(d.layersLabel, 'Layers');
    assert.equal(d.clusterLabel, '{n} places: zoom in');
    // without script: a list per layer with places
    assert.match(page, /<summary>Visits: 80 place\(s\) as a list<\/summary>/);
    assert.match(page, /<summary>Offices: 4 place\(s\) as a list<\/summary>/);
    assert.doesNotMatch(page, /<summary>Sales areas:/, 'a layer of lines and areas only has no list');
  });

  test('the layer names are translated', async () => {
    const nl = new Browser(app);
    await nl.login('king');
    const d = mapData((await nl.get('/a/hr/33?lang=nl')).body);
    assert.deepEqual(d.layers.map((l: any) => l.name), ['Bezoeken', 'Kantoren', 'Verkoopgebieden', 'Bezoekdichtheid']);
    assert.equal(d.layersLabel, 'Lagen');
  });

  test('the distance filter: near the centre, on the server, with a chip; nonsense is ignored', async () => {
    const [map, report] = await ids();
    assert.equal(map.type, 'map');
    const all = (await king.get('/a/hr/33')).body;
    const f = mapData(all).filter;
    assert.equal(f.mode, 'distance');
    assert.match(f.url, new RegExp(`^/a/hr/33\\?r${report.id}_near=__NEAR__$`));
    assert.equal(f.label, 'Show places within {km} km of the centre');
    assert.equal(f.near, null);
    // within 150 km of Chicago: only the Chicago office's visits
    const near = (await king.get(`/a/hr/33?r${report.id}_near=${encodeURIComponent('41.8781,-87.6298,150')}&r${report.id}_n=100`)).body;
    assert.match(near, /<span class="chip">Within 150 km/);
    const offices = [...near.matchAll(/<td[^>]*>(Chicago|Boston|New York|Dallas)<\/td>/g)].map((m) => m[1]);
    assert.ok(offices.length > 0 && offices.every((o) => o === 'Chicago'), offices.join());
    const expected = (await owner.one(`select count(*)::int as n from hr.field_visit where 2 * 6371.0088 * asin(sqrt(power(sin(radians(lat - 41.8781) / 2), 2) + cos(radians(41.8781)) * cos(radians(lat)) * power(sin(radians(lng + 87.6298) / 2), 2))) <= 150`)).n;
    assert.equal(offices.length, expected, 'the rows are the haversine count');
    assert.ok(expected > 0 && expected < 20);
    assert.deepEqual(mapData(near).filter.near, { lat: 41.8781, lng: -87.6298, km: 150 });
    assert.doesNotMatch(mapData(near).filter.clear, /_near=/);
    for (const bad of ['1,2', '91,0,10', '0,0,0', '0,0,-5', '0,0,99999', "0,0,10); delete from hr.emp; --", '0,0,1e3'])
      assert.doesNotMatch((await king.get(`/a/hr/33?r${report.id}_near=${encodeURIComponent(bad)}`)).body, /Within|alert-error/, bad);
  });

  test('a failing layer shows its error, the other layers still draw', async () => {
    const [map] = await ids();
    const before = (await owner.one('select config from meta.region where id = $1', [map.id])).config;
    const config = { ...before, layers: [...before.layers, { name: 'Broken', source: 'select nope from nowhere' }] };
    await owner.query('update meta.region set config = $2 where id = $1', [map.id, JSON.stringify(config)]);
    try {
      const page = (await king.get('/a/hr/33')).body;
      assert.match(page, /<div class="alert alert-error" role="alert">/);
      assert.equal(mapData(page).layers.length, 4);
    } finally {
      await owner.query('update meta.region set config = $2 where id = $1', [map.id, JSON.stringify(before)]);
    }
  });

  test("the Advisor checks each layer's query", async () => {
    const [map] = await ids();
    const r = await owner.one('select r.config, p.app_id from meta.region r join meta.page p on p.id = r.page_id where r.id = $1', [map.id]);
    const layerFindings = async () => (await advise(r.app_id)).findings.filter((f) => f.field.startsWith('Layer '));
    assert.deepEqual(await layerFindings(), [], 'the example layers are fine');
    await owner.query('update meta.region set config = $2 where id = $1', [map.id, JSON.stringify({ ...r.config, layers: [...r.config.layers, { name: 'Broken', source: 'select nope from nowhere' }] })]);
    try {
      const [f] = await layerFindings();
      assert.equal(f.field, 'Layer "Broken" query');
      assert.equal(f.severity, 'error');
      assert.match(f.message, /nowhere/);
    } finally {
      await owner.query('update meta.region set config = $2 where id = $1', [map.id, JSON.stringify(r.config)]);
    }
  });

  test('layer definitions: the region query first, at most seven more, empty queries skipped', () => {
    const r: any = { id: 1, title: 'Places', source: 'select 1', config: { cluster: true, layers: [{ source: ' ' }, ...Array.from({ length: 9 }, (_, i) => ({ name: `L${i}`, source: 'select 2', layer: i ? 'markers' : 'heat', link: { page: 'x' } }))] } };
    const defs = layerDefs(r);
    assert.equal(defs.length, 8);
    assert.deepEqual([defs[0].name, defs[0].cluster, defs[1].name, defs[1].kind, defs[1].link], ['Places', true, 'L0', 'heat', undefined]);
  });

  test('distance on latitude/longitude: haversine, a bounding box first, poles and the antimeridian', async () => {
    assert.deepEqual(parseNear('52.1,4.3,25'), { lat: 52.1, lng: 4.3, km: 25 });
    assert.deepEqual(parseNear(' -33.9 , 151.2 , 0.5 '), { lat: -33.9, lng: 151.2, km: 0.5 });
    for (const bad of [null, '', '1,2', '1,2,3,4', '91,0,1', '0,181,1', '0,0,0', '0,0,20039', 'a,b,c', '0,0,1e3']) assert.equal(parseNear(bad), null, String(bad));
    const box = nearArea({ lat: 0, lng: 179.5, km: 100 })!;
    assert.ok(box.w > 0 && box.e < 0, 'across the antimeridian: west > east');
    assert.equal(nearArea({ lat: 89.5, lng: 0, km: 100 }), null, 'a circle over the pole: no box');
    const pick = async (values: string, near: string, pos: any = { lat: 'lat', lng: 'lng' }, cols = 'id, lat, lng') =>
      (await owner.query(`select "__q".id from (select * from (values ${values}) v (${cols})) "__q" where ${nearCondition(parseNear(near)!, pos)} order by 1`)).rows.map((r) => r.id);
    // Amsterdam–Rotterdam is about 57 km, Amsterdam–Paris about 430 km
    const cities = `(1, 52.3676, 4.9041), (2, 51.9244, 4.4777), (3, 48.8566, 2.3522), (4, null, null)`;
    assert.deepEqual(await pick(cities, '52.3676,4.9041,50'), [1]);
    assert.deepEqual(await pick(cities, '52.3676,4.9041,60'), [1, 2]);
    assert.deepEqual(await pick(cities, '52.3676,4.9041,500'), [1, 2, 3]);
    assert.deepEqual(await pick('(1, 0, 179.9), (2, 0, -179.9), (3, 0, 170)', '0,180,50'), [1, 2]);
    assert.deepEqual(await pick('(1, 89.9, 0), (2, 89.9, 180), (3, 80, 0)', '90,0,100'), [1, 2]);
    assert.deepEqual(await pick(`(1, '52.3676, 4.9041'), (2, 'nowhere'), (3, '51.9244,4.4777')`, '52.3676,4.9041,100', { location: 'location' }, 'id, location'), [1, 3]);
  });
});

describe('PostGIS (generated SQL; the dev and CI databases have no PostGIS)', () => {
  const gis: PostGis = { schema: 'gis', version: '3.5.2', geometry: 9001, geography: 9002 };
  after(() => setPostgis(undefined));

  test('detected from pg_extension', async () => {
    setPostgis(undefined);
    const installed = (await owner.query(`select 1 from pg_extension where extname = 'postgis'`)).rowCount === 1;
    const found = await postgis();
    assert.equal(found !== null, installed);
    if (found) assert.ok(found.geometry && found.geography && found.schema);
    setPostgis(gis);
    assert.equal(await postgis(), gis);
    setPostgis(undefined);
  });

  test('the geometry or geography column: geom, geography, … first, else the first of the types', () => {
    assert.deepEqual(spatialColumn(new Map([['id', 23], ['shape_b', 9001], ['geog', 9002]]), gis), { name: 'geog', kind: 'geography' });
    assert.deepEqual(spatialColumn(new Map([['id', 23], ['outline', 9001]]), gis), { name: 'outline', kind: 'geometry' });
    assert.equal(spatialColumn(new Map([['id', 23], ['geom', 25]]), gis), null);
    assert.equal(spatialColumn(new Map([['geom', 9001]]), null), null, 'no PostGIS: no spatial column');
  });

  test('area: ST_Intersects with a WGS 84 envelope (two across the antimeridian), geography cast', () => {
    const geom = { name: 'geom', kind: 'geometry' as const };
    assert.equal(postgisAreaCondition(gis, geom, parseArea('40,-89,43,-86')!), '"gis".st_intersects("__q"."geom", "gis".st_makeenvelope(-89, 40, -86, 43, 4326))');
    assert.equal(
      postgisAreaCondition(gis, { name: 'Geog', kind: 'geography' }, parseArea('-5,170,5,-170')!),
      '("gis".st_intersects("__q"."Geog", "gis".st_makeenvelope(170, -5, 180, 5, 4326)::"gis".geography) or "gis".st_intersects("__q"."Geog", "gis".st_makeenvelope(-180, -5, -170, 5, 4326)::"gis".geography))',
    );
  });

  test('distance: ST_DWithin on geography in metres', () => {
    const near = parseNear('41.88,-87.63,25')!;
    assert.equal(
      postgisNearCondition(gis, { name: 'geom', kind: 'geometry' }, near),
      '"gis".st_dwithin("__q"."geom"::"gis".geography, "gis".st_setsrid("gis".st_makepoint(-87.63, 41.88), 4326)::"gis".geography, 25000)',
    );
    assert.match(postgisNearCondition(gis, { name: 'g', kind: 'geography' }, near), /^"gis"\.st_dwithin\("__q"\."g", /);
  });

  test('identifiers are quoted: a schema or column name cannot break out', () => {
    const odd: PostGis = { ...gis, schema: 'my"gis' };
    const sql = postgisAreaCondition(odd, { name: 'a"b', kind: 'geometry' }, parseArea('0,0,1,1')!);
    assert.equal(sql, '"my""gis".st_intersects("__q"."a""b", "my""gis".st_makeenvelope(0, 0, 1, 1, 4326))');
  });

  test('PostGIS when the report has a spatial column, else latitude/longitude, else not ok', () => {
    const f = { area: parseArea('40,-89,43,-86'), near: parseNear('41.88,-87.63,25') };
    const withGeom = spatialConditions(f, new Map([['lat', 701], ['lng', 701], ['geom', 9001]]), gis);
    assert.equal(withGeom.postgis, true);
    assert.match(withGeom.where[0], /st_intersects/);
    assert.match(withGeom.where[1], /st_dwithin/);
    const plain = spatialConditions(f, new Map([['lat', 701], ['lng', 701], ['geom', 9001]]), null);
    assert.equal(plain.postgis, false, 'PostGIS not installed: lat/lng');
    assert.match(plain.where[1], /asin\(sqrt/);
    assert.deepEqual(spatialConditions(f, new Map([['id', 23]]), gis), { where: [], ok: false, postgis: false });
    assert.deepEqual(spatialConditions({ area: null, near: null }, new Map(), gis), { where: [], ok: true, postgis: false });
  });

  // only where PostGIS is installed (e.g. a postgis/postgis container); skipped on the dev and CI databases
  test('with a real PostGIS: the report filtered on a geometry column, a layer from a geometry column', async (t) => {
    setPostgis(undefined);
    if (!(await postgis())) return t.skip('PostGIS is not installed');
    const rows = (await owner.query(`select r.id, r.type, r.source, r.config from meta.region r join meta.page p on p.id = r.page_id join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 33 order by r.seq`)).rows;
    const [map, report] = rows;
    try {
      // no lat/lng columns: only PostGIS can filter
      await owner.query('update meta.region set source = $2 where id = $1', [report.id, `select v.customer, initcap(d.loc) as office, st_setsrid(st_makepoint(v.lng, v.lat), 4326) as geom from hr.field_visit v join hr.dept d using (deptno)`]);
      await owner.query('update meta.region set source = $2 where id = $1', [map.id, `select customer as title, st_setsrid(st_makepoint(lng, lat), 4326)::geography as geog from hr.field_visit`]);
      const expected = (await owner.one(`select count(*)::int as n from hr.field_visit where st_dwithin(st_makepoint(lng, lat)::geography, st_makepoint(-87.6298, 41.8781)::geography, 150000)`)).n;
      const page = (await king.get(`/a/hr/33?r${report.id}_near=${encodeURIComponent('41.8781,-87.6298,150')}&r${report.id}_n=100`)).body;
      assert.doesNotMatch(page, /chip-error|alert-error/);
      assert.equal([...page.matchAll(/<td[^>]*>Chicago<\/td>/g)].length, expected);
      assert.doesNotMatch(page, /<td[^>]*>(Boston|Dallas|New York)<\/td>/);
      const area = (await king.get(`/a/hr/33?r${report.id}_bb=${encodeURIComponent('40,-89,43,-86')}&r${report.id}_n=100`)).body;
      assert.doesNotMatch(area, /<td[^>]*>(Boston|Dallas|New York)<\/td>/);
      assert.ok(/<td[^>]*>Chicago<\/td>/.test(area));
      const d = mapData(page);
      assert.equal(d.layers[0].points.length, 80, 'points from a geography column');
      assert.equal(d.layers[0].shapes.length, 0);
    } finally {
      for (const r of [map, report]) await owner.query('update meta.region set source = $2 where id = $1', [r.id, r.source]);
    }
  });

  test("a map layer's geometry becomes GeoJSON on the server", () => {
    assert.equal(geoJsonSelect(gis, { name: 'geom', kind: 'geometry' }), '"__m".*, "gis".st_asgeojson("__m"."geom") as "__geojson"');
    const fields = [{ name: 'title', dataTypeID: 25 }, { name: 'geom', dataTypeID: 9001 }];
    assert.equal(layerSql('select x', gis, fields), 'select "__m".*, "gis".st_asgeojson("__m"."geom") as "__geojson" from (\nselect x\n) "__m" limit 5000');
    assert.equal(layerSql('select x', null, fields), 'select * from (\nselect x\n) "__m" limit 5000', 'no PostGIS');
    assert.equal(layerSql('select x', gis, [...fields, { name: 'GeoJSON', dataTypeID: 25 }]), 'select * from (\nselect x\n) "__m" limit 5000', 'its own geojson column wins');
  });
});

describe('tree region', () => {
  test('nested from parent ids, the first levels open, nodes linked', async () => {
    const page = (await king.get('/a/hr/8')).body;
    const tree = page.slice(page.indexOf('class="tree-view'));
    assert.match(tree, /King · President/);
    // King > Jones > Ford > Smith: Jones's list sits inside King's details
    const king_ = tree.indexOf('King · President');
    const jones = tree.indexOf('Jones · Manager');
    const smith = tree.indexOf('Smith · Clerk');
    assert.ok(king_ < jones && jones < smith);
    assert.match(tree, /<details open>[\s\S]*?King · President/);
    assert.match(tree, /href="\/a\/hr\/3\?[^"]*P3_EMPNO=7839/);
  });
});
