// Chart markup (src/runtime/charts.ts): each kind's geometry is classes in the
// page stylesheet, never style attributes, and every chart keeps its data
// table and tooltips. The charts in a real browser are in test/e2e/responsive.test.ts.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PageCss } from '../src/css.ts';
import { CHART_KINDS, niceScale, renderChartBody, type ChartKind } from '../src/runtime/charts.ts';

const fields = (...names: string[]) => names.map((name) => ({ name }));
const render = (kind: ChartKind, rows: unknown[][], f = fields('label', 'A', 'B')) => {
  const sheet = new PageCss();
  return { body: String(renderChartBody(kind, 'Title', rows, f, sheet)), sheet };
};
/** The declarations behind the classes on elements matching `re` (group 1 = the class list). */
const decls = (body: string, sheet: PageCss, re: RegExp) => {
  const rules = new Map(sheet.text.split('\n').map((l) => [/^\.(\w+)\{/.exec(l)![1], /\{(.*)\}$/.exec(l)![1]]));
  return [...body.matchAll(re)].map((m) => m[1].split(' ').map((c) => rules.get(c)).filter(Boolean).join(';'));
};
const rows = [['North', 3, 2], ['South', -1, 4], ['East', 0, 1]];

describe('chart kinds', () => {
  test('every kind: no style attributes, a data table, tooltips, escaped labels', () => {
    for (const kind of CHART_KINDS) {
      const { body } = render(kind, [['<img src=x>', 1, 2], ['2', 3, 4]]);
      assert.doesNotMatch(body, /\sstyle=/, kind);
      assert.doesNotMatch(body, /<img src=x>/, kind);
      assert.match(body, new RegExp(`<figure class="chart chart-${kind}"`), kind);
      assert.match(body, /<summary>Data table<\/summary>/, kind);
      assert.match(body, /data-tip="/, kind);
    }
  });

  test('stacked: positives stack up from zero, negatives down, rounded at the outer ends', () => {
    const { body, sheet } = render('stacked', rows);
    // scale 0..5 from the sums (North 3 + 2), -1 below: niceScale(-1, 5) = -1..5
    assert.deepEqual(niceScale(-1, 5).lo, -1);
    const segs = decls(body, sheet, /class="col seg[^"]*? s\d ([^"]+)"/g);
    assert.equal(segs.length, 5, 'zero values get no segment');
    assert.deepEqual(segs.slice(0, 2), ['bottom:16.667%;height:50.000%', 'bottom:66.667%;height:33.333%'], 'North: 0→3, 3→5');
    assert.deepEqual(segs[2], 'bottom:0.000%;height:16.667%', 'South: the negative value hangs below zero');
    assert.match(body, /class="col seg top s2 /);
    assert.match(body, /class="col seg neg s1 /);
    assert.match(body, /<span class="swatch s2"><\/span>B/, 'a legend');
  });

  test('combo: the first series as columns, the others as lines through the column centres', () => {
    const { body } = render('combo', [['a', 1, 2], ['b', 3, 4]]);
    assert.equal(body.match(/class="col s1/g)?.length, 2);
    assert.doesNotMatch(body, /class="col s2/);
    assert.match(body, /<path class="line s2" d="M25\.000,[\d.]+ L75\.000,[\d.]+"/);
    assert.match(body, /data-tip="a · A: 1 · B: 2"/);
  });

  test('scatter: x from the label column, rows without a numeric x left out, its own x ticks', () => {
    const { body, sheet } = render('scatter', [[10, 5, 1], ['n/a', 1, 1], [20, 15, 2], [null, 3, 3]], fields('Years', 'Pay', 'Bonus'));
    assert.equal(body.match(/class="pt s1 /g)?.length, 2);
    assert.equal(body.match(/class="pt s2 /g)?.length, 2);
    assert.match(body, /data-tip="Pay · Years: 20 · 15"/);
    const pts = decls(body, sheet, /class="pt s1 ([^"]+)"/g);
    // x 10..20 (not from zero), y 0..15 (from the values 1..15 of both series)
    assert.deepEqual(pts, ['left:0.000%;bottom:33.333%', 'left:100.000%;bottom:100.000%']);
    assert.match(body, /<div class="chart-xs" aria-hidden="true"><span class="\w+">10<\/span>/);
    assert.match(render('scatter', [['a', 1, 1]]).body, /needs a numeric first column/);
  });

  test('pie: a filled circle (half-length dashes), no centre total, the donut legend', () => {
    const { body } = render('pie', [['a', 1], ['b', 3]], fields('label', 'A'));
    // slices keep the query's order, from 12 o'clock
    assert.match(body, /r="7\.9577" stroke-dasharray="12\.5 37\.5" stroke-dashoffset="12\.5"/);
    assert.match(body, /r="7\.9577" stroke-dasharray="37\.5 12\.5" stroke-dashoffset="0"/);
    assert.doesNotMatch(body, /donut-center/);
    assert.match(body, /<span class="lg-label">b<\/span><span class="lg-value">3 · 75%<\/span>/);
    assert.match(render('donut', [['a', 1], ['b', 3]], fields('label', 'A')).body, /donut-center/);
  });

  test('niceScale: value axes include zero, a scatter axis need not; one value is centred', () => {
    assert.deepEqual(niceScale(1980, 1987), { lo: 0, hi: 2000, ticks: [0, 500, 1000, 1500, 2000] });
    assert.deepEqual(niceScale(1980, 1987, false), { lo: 1980, hi: 1988, ticks: [1980, 1982, 1984, 1986, 1988] });
    const one = niceScale(50, 50, false);
    assert.ok(one.lo < 50 && one.hi > 50);
  });
});
