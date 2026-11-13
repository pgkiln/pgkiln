// Sprint 184: code review of 0.94.0. The map legend (CD-6, sprint 178): CR-6 the swatch is the colour a layer is
// drawn in (rows coloured per row, a polygon with only a line colour), CR-7 no Layers legend with a single check box,
// and a heat layer left out of the legend has no heat legend, CR-8 the legend rule in one place (layerDefs), and the
// Page Designer keeps "Off at first" and says when it doesn't apply. The OAuth findings (CR-1..CR-5, CR-9) are in
// test/security.test.ts.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { layerDefs, legendSwatch } from '../src/runtime/maps.ts';
import { mergeMapSettings, type Allowed } from '../src/builder/region-settings.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
const alias = 'maps-s184';
const ROLE = 'pgkiln_s184_maps';
const square = (x: number, y: number) => JSON.stringify({ type: 'Polygon', coordinates: [[[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1], [x, y]]] });
let pageId = 0;
let regionId = 0;

before(async () => {
  app = await buildApp({ logger: false });
  await owner.query(`delete from meta.app where alias = $1`, [alias]);
  await owner.query(`drop role if exists ${ROLE}`);
  await owner.query(`create role ${ROLE} nologin`);
  await owner.query(`grant ${ROLE} to pgkiln_runtime`);
  const appId = (await owner.one(`insert into meta.app (alias, name, authentication, db_role) values ($1, 'Maps 184', 'none', $2) returning id`, [alias, ROLE])).id;
  pageId = (await owner.one(`insert into meta.page (app_id, page_no, name, requires_auth) values ($1, 1, 'Home', false) returning id`, [appId])).id;
});
after(async () => {
  await owner.query(`delete from meta.app where alias = $1`, [alias]);
  await owner.query(`drop role if exists ${ROLE}`);
  await app.close();
  await closePools();
});

/** The map's data on page 1 with this region config and query. */
async function mapData(config: object, source = `select 'A' as title, '${square(4, 52)}' as geojson`) {
  await owner.query('delete from meta.region where page_id = $1', [pageId]);
  regionId = (await owner.one(`insert into meta.region (page_id, seq, title, type, source, config) values ($1, 1, 'Areas', 'map', $2, $3) returning id`, [pageId, source, JSON.stringify(config)])).id;
  const body = (await new Browser(app).get(`/a/${alias}/1`)).body;
  return JSON.parse(/<script type="application\/json" class="map-data">([\s\S]*?)<\/script>/.exec(body)![1]);
}

describe('sprint 184: the map legend (code review of 0.94.0)', () => {
  test('CR-6: rows coloured per row give a split swatch; one colour for all rows is the swatch', async () => {
    const perRow = `select * from (values ('A', '${square(4, 52)}', '#aa0000'), ('B', '${square(6, 52)}', '#00aa00'), ('C', '${square(8, 52)}', '#aa0000')) v(title, geojson, fill_color)`;
    const data = await mapData({ name: 'Areas', layer: 'polygons', style: { fill_color: '#1f7a4d' }, layers: [{ name: 'Shops', source: 'select 52.1 as lat, 4.5 as lng' }] }, perRow);
    assert.equal(data.layers[0].swatch, undefined);
    assert.deepEqual(data.layers[0].swatches, ['#aa0000', '#00aa00'], 'the colours the rows are drawn in, not the style\'s');
    const same = `select * from (values ('A', '${square(4, 52)}', '#aa0000'), ('B', '${square(6, 52)}', '#aa0000')) v(title, geojson, fill_color)`;
    const one = await mapData({ layer: 'polygons', style: { fill_color: '#1f7a4d' }, layers: [{ name: 'Shops', source: 'select 52.1 as lat, 4.5 as lng' }] }, same);
    assert.equal(one.layers[0].swatch, '#aa0000');
    assert.equal(one.layers[0].swatches, undefined);
  });

  test('CR-6: legendSwatch is the fill of areas and the line of lines; a colour the style leaves out is the layer\'s own', () => {
    const f = (style?: object) => ({ type: 'Feature', properties: { style } });
    const def = (kind: string, style = {}, more = {}) => ({ kind, style, tiles: false, visibleArea: false, ...more }) as never;
    assert.deepEqual(legendSwatch(def('polygons', { stroke_color: '#111111' }), [f({ stroke_color: '#111111' })]), {}, 'polygon with only a line colour: filled in the layer\'s colour');
    assert.deepEqual(legendSwatch(def('polygons', { stroke_color: '#111111', fill_color: '#222222' }), [f({ stroke_color: '#111111', fill_color: '#222222' })]), { swatch: '#222222' });
    assert.deepEqual(legendSwatch(def('lines', { fill_color: '#222222' }), [f({ fill_color: '#222222' })]), {}, 'a line has no fill');
    assert.deepEqual(legendSwatch(def('lines', { stroke_color: '#333333' }), [f({ stroke_color: '#333333' }), f({ stroke_color: '#444444' }), f({})]), { swatches: ['#333333', '#444444', ''] });
    assert.deepEqual(legendSwatch(def('extruded', { fill_color: '#555555' }), []), { swatch: '#555555' }, 'no rows: the style');
    assert.deepEqual(legendSwatch(def('polygons', { fill_color: '#555555' }, { tiles: true }), []), {}, 'vector tiles are drawn in the layer\'s colour');
    assert.deepEqual(legendSwatch(def('polygons', { fill_color: '#555555' }, { visibleArea: true }), []), { swatch: '#555555' });
    assert.deepEqual(legendSwatch(def('markers', { fill_color: '#555555' }), [f({ fill_color: '#555555' })]), {});
    const many = ['#000001', '#000002', '#000003', '#000004', '#000005'].map((c) => f({ fill_color: c }));
    assert.equal(legendSwatch(def('polygons'), many).swatches!.length, 4, 'at most four parts');
  });

  test('CR-7, CR-8: no Layers legend for a single listed layer, and then no layer is off at first', async () => {
    const base = layerDefs({ title: 'M', source: 'select 1', config: { layers: [{ name: 'Routes', source: 'select 2', no_legend: true, hidden: true }] } } as never);
    assert.deepEqual(base.map((d) => [d.legend, d.listed, d.hidden]), [[true, false, false], [false, false, false]], 'base layer + one left out: no legend');
    const two = layerDefs({ title: 'M', source: 'select 1', config: { layers: [{ name: 'Routes', source: 'select 2', no_legend: true, hidden: true }, { name: 'Shops', source: 'select 3', hidden: true }] } } as never);
    assert.deepEqual(two.map((d) => [d.listed, d.hidden]), [[true, false], [false, false], [true, true]], 'two listed: the legend, and "off at first" of a listed layer');
    const single = layerDefs({ title: 'M', source: 'select 1', config: { layer: 'heat' } } as never);
    assert.deepEqual(single.map((d) => [d.legend, d.listed]), [[true, false]], 'a lone heat map keeps its heat legend (legend) without a Layers legend');
    const data = await mapData({ name: 'Areas', layers: [{ name: 'Visits', layer: 'heat', no_legend: true, source: 'select 52.1 as lat, 4.5 as lng' }] });
    assert.deepEqual(data.layers.map((l: { legend: boolean; listed: boolean }) => [l.legend, l.listed]), [[true, false], [false, false]]);
  });

  test('CR-8: the Page Designer keeps "Off at first" and says when it does not apply', async () => {
    const allowed: Allowed = { pages: new Set([1]), lovs: new Set(), reports: new Map() };
    const merged = mergeMapSettings({}, { layers: '1', layer0_source: 'select 1', layer0_name: 'Routes', layer0_no_legend: 'true', layer0_hidden: 'true' }, allowed);
    assert.deepEqual(merged.layers, [{ name: 'Routes', source: 'select 1', hidden: true, no_legend: true }]);
    await mapData({ layers: [{ name: 'Routes', source: 'select 52.1 as lat, 4.5 as lng', hidden: true, no_legend: true }, { name: 'Shops', source: 'select 52.2 as lat, 4.6 as lng', hidden: true }] });
    const dev = new Browser(app);
    await dev.get('/builder/login');
    await dev.post('/builder/login', { __csrf: dev.lastCsrf, username: 'admin', password: 'admin' });
    const body = (await dev.get(`/builder/pages/${pageId}?c=region-${regionId}`)).body;
    const hint = /Not used: a layer that isn&#39;t listed in the legend|Not used: a layer that isn't listed in the legend/g;
    assert.equal(body.match(hint)?.length, 1, 'once: Routes (left out); Shops is listed with the region\'s own layer');
    assert.match(body, /name="layer0_hidden" value="true" checked/);
  });
});
