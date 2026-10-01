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
    const titles = d.points.map((p: any) => p.title).sort();
    assert.deepEqual(titles, ['ACCOUNTING', 'OPERATIONS', 'RESEARCH', 'SALES', 'Scott']);
    const scott = d.points.find((p: any) => p.title === 'Scott');
    assert.deepEqual([scott.lat, scott.lng], [52.0116, 4.3571], 'from "lat,lng" text');
    assert.match(d.points.find((p: any) => p.title === 'SALES').href, /\/a\/hr\/5\?.*P5_DEPTNO=30/);
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
      assert.ok(mapData(page).points.some((p: any) => p.title.toLowerCase() === '</script><b>x'));
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
