// Sprint 226 (parity: Charts, "Missing: other Oracle JET types, e.g. a status meter"): a gauge chart's shape: the
// dial (default), a horizontal status meter per row, a full ring, or a status light (LED). Each still says its status
// in words with an icon, never colour alone. HR part 94 shows them on page 24.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools } from '../src/db.ts';
import { PageCss } from '../src/css.ts';
import { renderChartBody, type ChartOptions } from '../src/runtime/charts.ts';
import { mergeChartSettings } from '../src/builder/region-settings.ts';
import { Browser } from './helpers.ts';

const fields = (...names: string[]) => names.map((name) => ({ name }));
const render = (rows: unknown[][], opts: ChartOptions) => {
  const sheet = new PageCss();
  const body = String(renderChartBody('gauge', 'T', rows, fields('label', 'Used'), sheet, 'en', undefined, opts));
  return { body, sheet };
};
const T = { min: 0, max: 120, warning: 80, critical: 100 };

describe('gauge shapes', () => {
  test('a status meter: a bar per row in its status colour, threshold ticks, the number and the status in words', () => {
    const { body } = render([['North', 90], ['South', 40], ['West', 110]], { gauge: { ...T, shape: 'bar' } });
    assert.equal(body.match(/class="meter-row"/g)?.length, 3);
    assert.match(body, /meter-value status-warning/);
    assert.match(body, /meter-value status-good/);
    assert.match(body, /meter-value status-critical/);
    assert.equal(body.match(/class="meter-tick /g)?.length, 6, 'two ticks per row');
    assert.match(body, /<span class="gauge-status status-warning"><span class="status-icon" aria-hidden="true">!<\/span>Warning<\/span>/);
    assert.match(body, /data-tip="North: 90 · Warning"/);
    assert.match(body, /<div class="meter-scale" aria-hidden="true"><span class="meter-scale-range"><span>0<\/span><span>120<\/span><\/span><\/div>/);
    assert.doesNotMatch(body, /class="gauge"/, 'no dials');
  });

  test('a ring: a full circle from min to max; a status light: the status colour, the number inside', () => {
    const ring = render([['North', 90]], { gauge: { ...T, shape: 'circle' } }).body;
    assert.match(ring, /<circle class="gauge-value gauge-ring status-warning" cx="50" cy="50" r="40" pathLength="100" stroke-dasharray="75\.000 200">/);
    assert.match(ring, /gauge-figure gauge-circle/);
    const led = render([['North', 90], ['South', 40]], { gauge: { warning: 80, critical: 100, shape: 'led' } }).body;
    assert.match(led, /<circle class="gauge-light status-warning"/);
    assert.match(led, /<circle class="gauge-light status-good"/);
    assert.match(led, /Warning<\/span>/);
    assert.doesNotMatch(led, /gauge-scale/, 'a light has no scale');
    // without thresholds: the series colour, no status words
    const plain = render([['North', 90]], { gauge: { shape: 'led' } }).body;
    assert.match(plain, /gauge-light s1/);
    assert.doesNotMatch(plain, /gauge-status/);
  });

  test('the dial stays the default; the builder stores a known shape only', () => {
    assert.match(render([['North', 90]], { gauge: T }).body, /M10,50 A40,40 0 0 1 90,50/);
    const a = { pages: new Set(), authz: new Set() } as never;
    assert.deepEqual(mergeChartSettings({}, { kind: 'gauge', gauge_max: '120', gauge_shape: 'bar' }, a).gauge, { max: 120, shape: 'bar' });
    assert.equal(mergeChartSettings({}, { kind: 'gauge', gauge_shape: 'dial' }, a).gauge, undefined);
    assert.equal(mergeChartSettings({}, { kind: 'gauge', gauge_shape: '<script>' }, a).gauge, undefined);
  });
});

describe('HR page 24 (part 94)', () => {
  let app: FastifyInstance;
  before(async () => {
    app = await buildApp({ logger: false });
  });
  after(async () => {
    await app.close();
    await closePools();
  });
  test('the three shapes render, with drill-down links', async () => {
    const b = new Browser(app);
    await b.login('king');
    const page = await b.get('/a/hr/24');
    assert.equal(page.statusCode, 200);
    assert.doesNotMatch(page.body, /alert-error/);
    assert.match(page.body, /Budget used: status meters/);
    assert.match(page.body, /<a class="meter-row drill"/);
    assert.match(page.body, /gauge-figure gauge-circle/);
    assert.match(page.body, /gauge-light status-/);
  });
});
