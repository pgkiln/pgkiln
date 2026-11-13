// Sprint 178 (parity leftovers). CD-6: a map layer can be left out of the legend (it is then always drawn), and the
// legend shows a shape layer's own colour.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { layerDefs } from '../src/runtime/maps.ts';
import { mergeMapSettings, type Allowed } from '../src/builder/region-settings.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
const alias = 'maps-s178';
const ROLE = 'pgkiln_s178_maps';
const square = (x: number, y: number) => JSON.stringify({ type: 'Polygon', coordinates: [[[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1], [x, y]]] });
const line = JSON.stringify({ type: 'LineString', coordinates: [[4, 52], [5, 51]] });
const config = {
  name: 'Parks', layer: 'polygons', style: { fill_color: '#1f7a4d', stroke_color: '#145233' },
  layers: [
    { name: 'Routes', layer: 'lines', no_legend: true, hidden: true, style: { stroke_color: '#c2541b', fill_color: '#000000' }, source: `select 'A1' as title, '${line}' as geojson` },
    { name: 'Shops', source: 'select 52.1 as lat, 4.5 as lng, \'Shop\' as title' },
    { name: 'Plain', layer: 'lines', source: `select 'B2' as title, '${line}' as geojson` },
  ],
};

before(async () => {
  app = await buildApp({ logger: false });
  await owner.query(`delete from meta.app where alias = $1`, [alias]);
  await owner.query(`drop role if exists ${ROLE}`);
  await owner.query(`create role ${ROLE} nologin`);
  await owner.query(`grant ${ROLE} to pgkiln_runtime`);
  const appId = (await owner.one(`insert into meta.app (alias, name, authentication, db_role) values ($1, 'Maps', 'none', $2) returning id`, [alias, ROLE])).id;
  const p = (await owner.one(`insert into meta.page (app_id, page_no, name, requires_auth) values ($1, 1, 'Home', false) returning id`, [appId])).id;
  await owner.query(`insert into meta.region (page_id, seq, title, type, source, config) values ($1, 1, 'Areas', 'map', $2, $3)`,
    [p, `select 'North' as title, '${square(4, 52)}' as geojson`, JSON.stringify(config)]);
});
after(async () => {
  await owner.query(`delete from meta.app where alias = $1`, [alias]);
  await owner.query(`drop role if exists ${ROLE}`);
  await app.close();
  await closePools();
});

describe('sprint 178: map layers and the legend (CD-6)', () => {
  test('a layer left out of the legend is always drawn; the page says which layers the legend lists, in their own colour', async () => {
    const body = (await new Browser(app).get(`/a/${alias}/1`)).body;
    const data = JSON.parse(/<script type="application\/json" class="map-data">([\s\S]*?)<\/script>/.exec(body)![1]);
    const [parks, routes, shops, plain] = data.layers;
    assert.deepEqual([parks.legend, routes.legend, shops.legend, plain.legend], [true, false, true, true]);
    assert.equal(routes.hidden, false, 'not in the legend, so it can\'t start switched off');
    assert.equal(parks.swatch, '#1f7a4d', 'polygons: the fill colour');
    assert.equal(routes.swatch, '#c2541b', 'lines: the line colour');
    assert.equal(shops.swatch, undefined, 'markers keep the map\'s own colours');
    assert.equal(plain.swatch, undefined, 'no style: the map\'s own colour');
  });

  test('layerDefs: legend is on unless the layer says no_legend', () => {
    const defs = layerDefs({ title: 'Areas', source: 'select 1', config: { ...config, no_legend: true } } as never);
    assert.deepEqual(defs.map((d) => d.legend), [false, false, true, true]);
    assert.deepEqual(layerDefs({ title: 'M', source: 'select 1', config: { no_legend: 'true' } } as never).map((d) => d.legend), [true], 'only the boolean');
  });

  test('the Page Designer\'s map settings keep "leave out of the legend"; such a layer is not off at first', () => {
    const allowed: Allowed = { pages: new Set([1]), lovs: new Set(), reports: new Map() };
    const merged = mergeMapSettings({}, {
      no_legend: 'true', layers: '1',
      layer0_source: 'select 1', layer0_name: 'Routes', layer0_layer: 'lines', layer0_no_legend: 'true', layer0_hidden: 'true',
      layer1_source: 'select 2', layer1_name: 'Shops', layer1_hidden: 'true', layer1_no_legend: 'yes',
    }, allowed);
    assert.equal(merged.no_legend, true);
    assert.deepEqual(merged.layers, [{ name: 'Routes', source: 'select 1', layer: 'lines', no_legend: true }, { name: 'Shops', source: 'select 2', hidden: true }]);
    assert.equal(mergeMapSettings({ no_legend: true }, {}, allowed).no_legend, undefined);
  });
});
