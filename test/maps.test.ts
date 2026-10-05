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
