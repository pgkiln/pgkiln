// Sprint 70: treemap, sunburst and timeline charts. The hierarchy from
// node_id / parent_id (cycles and unknown parents become roots), the squarified
// layout, the markup of each kind, drill-down links and the data tables.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree, renderChartBody, squarify } from '../src/runtime/charts.ts';
import { PageCss } from '../src/css.ts';
import { raw } from '../src/html.ts';

const tree = [['Sales', 0, 's', null], ['North', 30, 'n', 's'], ['South', 10, 'so', 's'], ['IT', 20, 'it', null], ['Loop A', 5, 'a', 'b'], ['Loop B', 5, 'b', 'a']];
const fields = [{ name: 'Name' }, { name: 'Amount' }, { name: 'node_id' }, { name: 'parent_id' }];

describe('hierarchy charts', () => {
  test('buildTree: totals include children; a cycle or an unknown parent makes a root', () => {
    const roots = buildTree(tree, fields);
    const by = Object.fromEntries(roots.map((r) => [r.label, r.total]));
    assert.equal(by.Sales, 40);
    assert.equal(by.IT, 20);
    assert.equal(roots.find((r) => r.label === 'Sales')!.children.map((c) => c.label).join(), 'North,South');
    // the loop: one of the two becomes a root holding the other
    assert.equal(roots.filter((r) => r.label.startsWith('Loop')).length, 1);
    assert.equal(roots.find((r) => r.label.startsWith('Loop'))!.total, 10);
    // without node_id the label is the id; negative and empty values count as 0
    const flat = buildTree([['A', 3], ['B', -2], ['C', null]], [{ name: 'L' }, { name: 'V' }]);
    assert.deepEqual(flat.map((r) => [r.label, r.total]), [['A', 3]]);
  });

  test('squarify fills the area exactly, largest first, within bounds', () => {
    const box = { x: 0, y: 0, w: 160, h: 100 };
    const out = squarify([{ total: 6 }, { total: 6 }, { total: 4 }, { total: 3 }, { total: 2 }, { total: 2 }, { total: 1 }], box);
    const area = out.reduce((a, r) => a + r.w * r.h, 0);
    assert.ok(Math.abs(area - 16000) < 1e-6, String(area));
    for (const r of out) assert.ok(r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= 160 + 1e-9 && r.y + r.h <= 100 + 1e-9, JSON.stringify(r));
    assert.ok(Math.abs(out[0].w * out[0].h - 6 * (16000 / 24)) < 1e-6);
    assert.deepEqual(squarify([{ total: 0 }], box), []);
  });

  test('treemap: a group per top-level node with its children; leaves link; a data table', () => {
    const html = renderChartBody('treemap', 'Money', tree, fields, new PageCss(), 'en', undefined, { link: (i) => raw(`href="/x/${i}"`) }).toString();
    assert.match(html, /<figure class="chart chart-treemap" aria-label="Money"><div class="treemap">/);
    assert.match(html, /<div class="tm-group s1 x\w+"><span class="tm-title">Sales<\/span>/);
    assert.match(html, /<a class="tm-cell x\w+ drill" href="\/x\/1" data-tip="Sales › North: 30 \(42\.9%\)">/);
    assert.match(html, /tm-cell tm-leaf s2 /, 'a top-level node without children is a cell of its own');
    assert.match(html, /<th scope="col">parent<\/th>/);
    assert.match(html, /<tr><th scope="row"><a href="\/x\/2">South<\/a><\/th><td>Sales<\/td><td class="num">10<\/td><td class="num">10<\/td><\/tr>/);
  });

  test('sunburst: rings by depth, the total in the centre, a legend of the top level', () => {
    const html = renderChartBody('sunburst', 'Money', tree, fields, new PageCss(), 'en').toString();
    assert.equal((html.match(/<path class="sb /g) ?? []).length, 6);
    assert.match(html, /<path class="sb s1 d2" d="M[\d.,]+ A/);
    assert.match(html, /<div class="donut-center"><b>70<\/b><span>Total<\/span><\/div>/);
    assert.deepEqual([...html.matchAll(/<span class="lg-label">([^<]+)<\/span>/g)].map((m) => m[1]), ['Sales', 'IT', 'Loop B'], 'the loop: Loop B holds Loop A');
    // one root with children: its children are the top level, its name in the centre
    const one = renderChartBody('sunburst', 'x', [['All', 0, 'r', null], ['A', 2, 'a', 'r'], ['B', 2, 'b', 'r']], fields, new PageCss()).toString();
    assert.match(one, /<span>All<\/span>/);
    assert.match(renderChartBody('treemap', 'x', [['A']], [{ name: 'A' }], new PageCss()).toString(), /needs a label column and a numeric column/);
  });
});

describe('timeline', () => {
  const rows = [
    ['Kick-off', '2026-01-05', null, 'Team A'],
    ['Build', '2026-01-06', '2026-02-20', 'Team A'],
    ['Review', '2026-01-07', null, 'Team A'],
    ['Launch', '2026-03-02', null, 'Team B'],
  ];
  const tf = [{ name: 'What' }, { name: 'Start' }, { name: 'End' }, { name: 'series' }];

  test('a lane per series; overlapping items get rows; bars with an end, points without', () => {
    const html = renderChartBody('timeline', 'Plan', rows, tf, new PageCss(), 'en').toString();
    assert.deepEqual([...html.matchAll(/<span class="timeline-name">([^<]+)<\/span>/g)].map((m) => m[1]), ['Team A', 'Team B']);
    assert.equal((html.match(/class="tl-item /g) ?? []).length, 1);
    assert.equal((html.match(/class="tl-point /g) ?? []).length, 3);
    assert.match(html, /data-tip="Team A · Build: Jan 6, 2026 – Feb 20, 2026"/);
    // three overlapping items in Team A: three rows
    assert.match(html, /<div class="timeline-lane s1">[\s\S]*?<div class="timeline-plot x\w+">/);
    const css = new PageCss();
    renderChartBody('timeline', 'Plan', rows, tf, css, 'en');
    assert.match(css.text, /height:5\.7rem/);
    assert.match(html, /<th scope="col">series<\/th>/);
  });

  test('no series: one lane without a name; no start: the message', () => {
    const html = renderChartBody('timeline', 'x', [['A', '2026-01-01', '2026-01-03']], tf.slice(0, 3), new PageCss()).toString();
    assert.doesNotMatch(html, /timeline-name/);
    assert.match(html, /tl-item/);
    assert.match(renderChartBody('timeline', 'x', [['A', 'not a date']], tf.slice(0, 2), new PageCss()).toString(), /A timeline needs a label column and a start date/);
  });
});
