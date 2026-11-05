// Sprint 159 (CD-6; APEX: map layers Lines, Polygons, Extruded Polygons): shape layers with a style (fixed or per row),
// only checked colours and numbers reach the page, extruded polygons shaded by their height, and the Page Designer's
// map settings keep the kind and the style.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { shapeStyle } from '../src/runtime/maps.ts';
import { mergeMapSettings } from '../src/builder/region-settings.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
const alias = 'maps-s159';
const ROLE = 'pgkiln_s159_maps';
const square = (x: number, y: number) => JSON.stringify({ type: 'Polygon', coordinates: [[[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1], [x, y]]] });

before(async () => {
  app = await buildApp({ logger: false });
  await owner.query(`delete from meta.app where alias = $1`, [alias]);
  await owner.query(`drop role if exists ${ROLE}`);
  await owner.query(`create role ${ROLE} nologin`);
  await owner.query(`grant ${ROLE} to pgkiln_runtime`);
  const appId = (await owner.one(`insert into meta.app (alias, name, authentication, db_role) values ($1, 'Maps', 'none', $2) returning id`, [alias, ROLE])).id;
  const p = (await owner.one(`insert into meta.page (app_id, page_no, name, requires_auth) values ($1, 1, 'Home', false) returning id`, [appId])).id;
  const polygons = `select 'North' as title, '${square(4, 52)}' as geojson, '#b42318' as fill_color, 10 as height, 52.5 as lat, 4.5 as lng
    union all select 'South', '${square(5, 51)}', 'red; x', 30, null, null`;
  const config = {
    layer: 'extruded', style: { fill_color: '#2e5c8a', stroke_color: '#1b2230', stroke_width: 2, opacity: 0.6 },
    layers: [{ name: 'Roads', layer: 'lines', style: { stroke_color: '#000000', stroke_width: 3, opacity: 1.5 }, source: `select 'A1' as title, '${JSON.stringify({ type: 'LineString', coordinates: [[4, 52], [5, 51]] })}' as geojson` }],
  };
  await owner.query(`insert into meta.region (page_id, seq, title, type, source, config) values ($1, 1, 'Areas', 'map', $2, $3)`, [p, polygons, JSON.stringify(config)]);
});
after(async () => {
  await owner.query(`delete from meta.app where alias = $1`, [alias]);
  await owner.query(`drop role if exists ${ROLE}`);
  await app.close();
  await closePools();
});

describe('map layers (CD-6)', () => {
  test('shape layers: style per layer and per row, extruded shaded by height, no markers', async () => {
    const body = (await new Browser(app).get(`/a/${alias}/1`)).body;
    const data = JSON.parse(/<script type="application\/json" class="map-data">([\s\S]*?)<\/script>/.exec(body)![1]);
    const [areas, roads] = data.layers;
    assert.equal(areas.kind, 'extruded');
    assert.equal(areas.points.length, 0, 'a shape layer draws only shapes (the row\'s lat / lng is not a marker)');
    const north = areas.shapes.find((f: any) => f.properties.title === 'North').properties;
    const south = areas.shapes.find((f: any) => f.properties.title === 'South').properties;
    assert.equal(north.style.fill_color, '#b42318', 'the row\'s own colour');
    assert.equal(south.style.fill_color, '#2e5c8a', 'a colour that isn\'t #rrggbb: the layer\'s');
    assert.deepEqual([north.height, south.height], [10, 30]);
    assert.ok(north.style.opacity < south.style.opacity, 'higher is stronger');
    assert.deepEqual([north.style.opacity, south.style.opacity], [0.2, 0.9]);
    assert.equal(roads.kind, 'lines');
    assert.deepEqual(roads.shapes[0].properties.style, { stroke_color: '#000000', stroke_width: 3 }, 'an opacity above 1 is left out');
  });

  test('only checked colours and numbers make a style', () => {
    assert.deepEqual(shapeStyle({ fill_color: 'url(x)', stroke_color: '#ABCDEF', stroke_width: '4', opacity: -1, extra: 'x' }), { stroke_color: '#ABCDEF', stroke_width: 4 });
    assert.deepEqual(shapeStyle(null), {});
  });

  test('the Page Designer\'s map settings keep the kind and the style', () => {
    const out = mergeMapSettings({}, { layer: 'polygons', style_fill_color: '#00ff00', style_opacity: '0.4', layers: '1', layer0_source: 'select 1', layer0_layer: 'lines', layer0_stroke_width: '2' } as any,
      { pages: new Set(), reports: new Set() } as any);
    assert.equal(out.layer, 'polygons');
    assert.deepEqual(out.style, { fill_color: '#00ff00', opacity: 0.4 });
    assert.deepEqual([out.layers[0].layer, out.layers[0].style], ['lines', { stroke_width: 2 }]);
    assert.equal(mergeMapSettings({}, { layer: 'bogus' } as any, { pages: new Set(), reports: new Set() } as any).layer, undefined);
  });
});
