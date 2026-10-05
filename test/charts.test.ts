// Chart markup (src/runtime/charts.ts): each kind's geometry is classes in the
// page stylesheet, never style attributes, and every chart keeps its data
// table and tooltips. The charts in a real browser are in test/e2e/responsive.test.ts.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PageCss } from '../src/css.ts';
import { raw } from '../src/html.ts';
import { CHART_KINDS, gaugeStatus, niceScale, renderChartBody, timeScale, wallClock, wallClockIn, type ChartKind, type ChartOptions } from '../src/runtime/charts.ts';

const fields = (...names: string[]) => names.map((name) => ({ name }));
const render = (kind: ChartKind, rows: unknown[][], f = fields('label', 'A', 'B'), opts: ChartOptions = {}) => {
  const sheet = new PageCss();
  return { body: String(renderChartBody(kind, 'Title', rows, f, sheet, 'en', undefined, opts)), sheet };
};
/** A drill-down link per point: /p?row=i&s=series (null: the whole row). */
const drill: ChartOptions['link'] = (i, si) => raw(`href="/p?row=${i}&amp;s=${si}"`);
/** The declarations behind the classes on elements matching `re` (group 1 = the class list). */
const decls = (body: string, sheet: PageCss, re: RegExp) => {
  const rules = new Map(sheet.text.split('\n').map((l) => [/^\.(\w+)\{/.exec(l)![1], /\{(.*)\}$/.exec(l)![1]]));
  return [...body.matchAll(re)].map((m) => m[1].split(' ').map((c) => rules.get(c)).filter(Boolean).join(';'));
};
const rows = [['North', 3, 2], ['South', -1, 4], ['East', 0, 1]];

describe('chart kinds', () => {
  test('every kind: no style attributes, a data table, tooltips, escaped labels', () => {
    for (const kind of CHART_KINDS) {
      // (a bubble chart needs x, y and size; a radar three axes)
      // (a Gantt chart reads dates: start and end)
      const data = kind === 'gantt' ? [['<img src=x>', '2026-01-01', '2026-01-05', 3], ['2', '2026-01-03', '2026-01-09', 5], ['3', '2026-01-09', null, 7]] : [['<img src=x>', 1, 2, 3], ['2', 3, 4, 5], ['3', 5, 6, 7]];
      const { body } = render(kind, data, fields('label', 'A', 'B', 'C'));
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

describe('sprint 26: bubble, gauge, funnel and radar charts', () => {
  test('bubble: x, y and size columns; the area grows with the size; larger bubbles drawn first', () => {
    const { body, sheet } = render('bubble', [['a', 1, 10, 4], ['b', 2, 20, 1]], fields('label', 'X', 'Y', 'Size'));
    const geo = decls(body, sheet, /class="bubble s1 ([^"]+)"/g);
    assert.equal(geo.length, 2);
    assert.match(geo[0], /width:44\.0px;height:44\.0px/, 'the largest: the full radius of 22px');
    assert.match(geo[1], /width:22\.0px/, 'a quarter of the size: half the radius');
    assert.match(body, /data-tip="a · X: 1 · Y: 10 · Size: 4"/);
    assert.match(body, /size: Size/);
    assert.match(render('bubble', [['a', 1, 2]]).body, /needs a label column and three numeric columns/);
  });

  test('gauge: thresholds give a status with an icon and a label, never colour alone', () => {
    assert.equal(gaugeStatus(50, {}), null);
    assert.equal(gaugeStatus(50, { warning: 80, critical: 100 }), 'good');
    assert.equal(gaugeStatus(85, { warning: 80, critical: 100 }), 'warning');
    assert.equal(gaugeStatus(100, { warning: 80, critical: 100 }), 'critical');
    // warning above critical: low values are bad
    assert.equal(gaugeStatus(30, { warning: 50, critical: 20 }), 'warning');
    assert.equal(gaugeStatus(10, { warning: 50, critical: 20 }), 'critical');
    assert.equal(gaugeStatus(60, { warning: 50, critical: 20 }), 'good');
    const { body } = render('gauge', [['North', 90], ['South', 40]], fields('label', 'Used'), { gauge: { min: 0, max: 120, warning: 80, critical: 100 } });
    assert.equal(body.match(/class="gauge"/g)?.length, 2);
    assert.match(body, /<span class="gauge-status status-warning"><span class="status-icon" aria-hidden="true">!<\/span>Warning<\/span>/);
    assert.match(body, /gauge-value status-good/);
    assert.match(body, /stroke-dasharray="75\.000 200"/, '90 of 0..120');
    assert.equal(body.match(/class="gauge-band /g)?.length, 6, 'three bands per gauge');
    assert.match(body, /<span>120<\/span>/);
    assert.doesNotMatch(render('gauge', [['a', 5]], fields('label', 'A')).body, /gauge-status/, 'no thresholds, no status');
  });

  test('funnel: stages in query order, bars relative to the largest, the share of the first stage', () => {
    const { body, sheet } = render('funnel', [['Leads', 200], ['Offers', 50], ['Won', 20]], fields('stage', 'N'));
    assert.deepEqual(decls(body, sheet, /class="funnel-bar s1 ([^"]+)"/g), ['width:100.000%', 'width:25.000%', 'width:10.000%']);
    assert.match(body, /data-tip="Won: 20 · 10% of the first stage"/);
    assert.doesNotMatch(body, /chart-legend/);
  });

  test('radar: one axis per row, one polygon per series, at least three axes', () => {
    const { body } = render('radar', [['a', 1, 2], ['b', 2, 2], ['c', 3, 2], ['d', 4, 2]]);
    assert.equal(body.match(/<polygon class="radar-area s\d"/g)?.length, 2);
    assert.equal(body.match(/<line class="radar-spoke"/g)?.length, 4);
    assert.equal(body.match(/class="radar-label /g)?.length, 4);
    assert.match(body, /<span class="swatch s2"><\/span>B/);
    assert.match(render('radar', [['a', 1], ['b', 2]], fields('label', 'A')).body, /at least three rows/);
  });
});

describe('sprint 26: drill-down links', () => {
  test('one series: each mark is a link to its row; the data table links the labels', () => {
    for (const kind of ['bar', 'column', 'line', 'area', 'combo', 'funnel', 'gauge'] as ChartKind[]) {
      const { body } = render(kind, [['a', 1], ['b', 2]], fields('label', 'A'), { link: drill });
      assert.match(body, /<a class="[^"]*drill"[^>]*href="\/p\?row=1&amp;s=(0|null)"/, kind);
      assert.match(body, /<th scope="row"><a href="\/p\?row=0&amp;s=0">a<\/a><\/th>/, `${kind}: data table`);
    }
  });

  test('several series: each value links with its series, in the marks and in the data table', () => {
    for (const kind of ['bar', 'column', 'stacked', 'scatter', 'radar'] as ChartKind[]) {
      const { body } = render(kind, [[1, 1, 2], [2, 3, 4], [3, 5, 6]], fields('label', 'A', 'B'), { link: drill });
      assert.match(body, /<td class="num"><a href="\/p\?row=1&amp;s=1">4<\/a><\/td>/, kind);
      if (kind !== 'radar') assert.match(body, /href="\/p\?row=2&amp;s=1"[^>]*data-tip=/, `${kind}: marks`);
    }
  });

  test('a bubble links its whole row; pie slices link, "Other" does not; hidden columns are no series', () => {
    const bubble = render('bubble', [['a', 1, 2, 3]], fields('label', 'X', 'Y', 'Z'), { link: drill }).body;
    assert.match(bubble, /<a class="bubble s1 \w+ drill" href="\/p\?row=0&amp;s=null"/);
    const rows = Array.from({ length: 8 }, (_, i) => [`r${i}`, 10 - i]);
    const pie = render('pie', rows, fields('label', 'A'), { link: drill }).body;
    assert.match(pie, /<a class="drill" href="\/p\?row=0&amp;s=0" tabindex="-1"><circle/);
    assert.match(pie, /<li data-tip="Other: [^"]*"><span class="swatch/, '"Other" has no link');
    const hidden = render('column', [['a', 1, 77]], fields('label', 'A', 'id'), { link: drill, hidden: ['ID'] }).body;
    assert.doesNotMatch(hidden, />id<|77/);
  });

  test('marks without a drill-down stay focusable for their tooltips', () => {
    const { body } = render('funnel', [['a', 1]], fields('label', 'A'));
    assert.match(body, /<div class="funnel-row" data-tip="a: 1" aria-label="a: 1" tabindex="0">/);
    assert.doesNotMatch(body, /<a /);
  });
});

describe('sprint 33: Gantt, pyramid and polar charts', () => {
  const NOW = wallClock('2026-03-04');
  const tasks = [
    ['Design', '2026-03-02', '2026-03-06', 100, 1, null],
    ['Build', '2026-03-09', '2026-03-20', 40, 2, '1'],
    ['Test', '2026-03-16 12:00', '2026-03-27', null, 3, '{1,2}'],
    ['Go live', '2026-03-30', null, null, 4, '3'],
    ['No start', null, '2026-03-30', null, 5, null],
  ];
  const ganttFields = fields('task', 'starts', 'ends', 'progress', 'task_id', 'depends_on');

  test('wallClock: dates and timestamps (with or without a zone) as their wall clock; NaN otherwise', () => {
    assert.equal(wallClock('2026-03-02'), Date.UTC(2026, 2, 2));
    assert.equal(wallClock('2026-03-02 09:30:00'), Date.UTC(2026, 2, 2, 9, 30));
    assert.equal(wallClock('2026-03-02 09:30:00.5+02'), Date.UTC(2026, 2, 2, 9, 30, 0, 500));
    assert.equal(wallClock('2026-03-02T09:30'), Date.UTC(2026, 2, 2, 9, 30));
    for (const v of [null, '', 'soon', 42]) assert.ok(Number.isNaN(wallClock(v)), String(v));
  });

  test('timeScale: whole units, at most about ten ticks', () => {
    const days = timeScale(Date.UTC(2026, 2, 2, 10), Date.UTC(2026, 2, 6, 15));
    assert.equal(days.unit, 'day');
    assert.equal(days.lo, Date.UTC(2026, 2, 2));
    assert.equal(days.hi, Date.UTC(2026, 2, 7));
    const weeks = timeScale(Date.UTC(2026, 2, 4), Date.UTC(2026, 3, 20));
    assert.equal(weeks.unit, 'week');
    assert.equal(new Date(weeks.lo).getUTCDay(), 1, 'weeks start on Monday');
    const months = timeScale(Date.UTC(2026, 0, 15), Date.UTC(2026, 9, 1));
    assert.equal(months.unit, 'month');
    assert.equal(months.lo, Date.UTC(2026, 0, 1));
    assert.ok(timeScale(Date.UTC(1990, 0, 1), Date.UTC(2026, 0, 1)).ticks.length <= 11);
    assert.equal(timeScale(Date.UTC(2026, 2, 2, 8), Date.UTC(2026, 2, 2, 17)).unit, 'hour');
    const one = timeScale(Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 1));
    assert.ok(one.lo < Date.UTC(2026, 0, 1) && one.hi > Date.UTC(2026, 0, 1), 'a single moment gets room around it');
  });

  test('gantt: a bar per task from start to end, progress, milestones, rows without a start left out', () => {
    const { body, sheet } = render('gantt', tasks, ganttFields, { now: NOW });
    const bars = decls(body, sheet, /class="gantt-bar s1(?: partial)? ([^"]+)"/g);
    assert.equal(bars.length, 3);
    // bars keep their order and grow with their length: Build (11 days) is longer than Design (4)
    const width = (d: string) => Number(/width:([\d.]+)%/.exec(d)![1]);
    const left = (d: string) => Number(/left:([\d.]+)%/.exec(d)![1]);
    assert.ok(width(bars[1]) > width(bars[0]) * 2.5);
    assert.ok(left(bars[0]) < left(bars[1]) && left(bars[1]) < left(bars[2]));
    assert.deepEqual(decls(body, sheet, /class="gantt-progress ([^"]+)"/g), ['width:100.000%', 'width:40.000%']);
    assert.equal(body.match(/class="gantt-milestone s1 /g)?.length, 1, 'no end: a milestone');
    assert.doesNotMatch(body, /No start/, 'a row without a start is left out');
    assert.match(body, /data-tip="Build: Mar 9, 2026 – Mar 20, 2026 · 40%"/);
    assert.match(body, /data-tip="Test: Mar 16, 2026, 12:00 PM – Mar 27, 2026"/, 'times when a row has one');
    assert.match(body, /<span class="gantt-today \w+" title="Today">/);
    assert.doesNotMatch(render('gantt', tasks, ganttFields, { now: wallClock('2027-01-01') }).body, /gantt-today/, 'today outside the range: no line');
    assert.match(body, /<span class="gantt-corner">task<\/span>/);
    assert.match(body, /<th scope="col">starts<\/th><th scope="col">ends<\/th><th scope="col" class="num">progress<\/th><th scope="col">depends_on<\/th>/);
  });

  test("gantt: today is the wall clock in the session's time zone", () => {
    const at = new Date(Date.UTC(2026, 2, 10, 23, 30));
    assert.equal(wallClockIn('UTC', at), Date.UTC(2026, 2, 10, 23, 30));
    assert.equal(wallClockIn('Europe/Amsterdam', at), Date.UTC(2026, 2, 11, 0, 30), 'already the next day in Amsterdam');
    assert.equal(wallClockIn('America/New_York', at), Date.UTC(2026, 2, 10, 19, 30));
    assert.equal(wallClockIn(null, at), at.getTime(), 'no zone: UTC');
    assert.equal(wallClockIn('Not/AZone', at), at.getTime(), 'an unknown zone: UTC');
  });

  test('gantt: dependencies from the end of a task to the start of the one that waits for it', () => {
    const { body } = render('gantt', tasks, ganttFields, { now: NOW });
    // Build after Design, Test after Design and Build, Go live after Test
    assert.equal(body.match(/<path class="gantt-dep"/g)?.length, 4);
    assert.match(body, /<svg class="gantt-deps" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true">/);
    assert.match(body, /d="M[\d.]+,0\.5 H[\d.]+ V1\.5 H[\d.]+"/, 'row 0 to row 1');
    assert.equal(body.match(/class="gantt-arrow /g)?.length, 3, 'one arrow per task that waits');
    // no task_id/depends_on columns: no lines
    assert.doesNotMatch(render('gantt', tasks.map((r) => r.slice(0, 4)), fields('task', 'starts', 'ends', 'progress'), { now: NOW }).body, /gantt-dep/);
    // unknown ids and self-references are ignored
    assert.doesNotMatch(render('gantt', [['a', '2026-01-01', '2026-01-02', 1, 1, '1,9']], fields('t', 's', 'e', 'progress', 'task_id', 'depends_on')).body, /gantt-dep/);
  });

  test('gantt: drill-down per task (the whole row), and the data table links the task', () => {
    const { body } = render('gantt', tasks, ganttFields, { now: NOW, link: drill });
    assert.match(body, /<a class="gantt-bar s1 partial \w+ drill" href="\/p\?row=1&amp;s=null"/);
    assert.match(body, /<a class="gantt-milestone s1 \w+ drill" href="\/p\?row=3&amp;s=null"/);
    assert.match(body, /<th scope="row"><a href="\/p\?row=0&amp;s=null">Design<\/a><\/th>/);
  });

  test('gantt: no usable start dates, or too few columns: a message', () => {
    assert.match(render('gantt', [['a', 'x', 'y']], fields('t', 's', 'e')).body, /needs a label column, a start date and an end date/);
    assert.match(render('gantt', [['a', '2026-01-01']], fields('t', 's')).body, /needs a label column/);
  });

  test('pyramid: one series as segments from the top whose areas follow the values; more than 8 fold into "Other"', () => {
    const { body } = render('pyramid', [['Top', 1], ['Middle', 3], ['Zero', 0], ['Base', 5]], fields('level', 'N'));
    // shares 1/9, 4/9, 9/9: the segments end at heights sqrt(c) = 1/3, 2/3 and 1
    assert.match(body, /<polygon class="pyramid-seg s1" points="50\.000,0\.000 50\.000,0\.000 66\.667,33\.333 33\.333,33\.333"/);
    assert.match(body, /<polygon class="pyramid-seg s2" points="33\.333,33\.333 66\.667,33\.333 83\.333,66\.667 16\.667,66\.667"/);
    assert.equal(body.match(/class="pyramid-seg /g)?.length, 3, 'zero values get no segment');
    assert.match(body, /<span class="lg-label">Base<\/span><span class="lg-value">5 · 56%<\/span>/);
    const many = render('pyramid', Array.from({ length: 10 }, (_, i) => [`r${i}`, 1]), fields('l', 'N'), { link: drill }).body;
    assert.equal(many.match(/class="pyramid-seg /g)?.length, 8);
    assert.match(many, /<li data-tip="Other: 3"><span class="swatch s8">/, '"Other" has no link');
    assert.match(many, /<a class="drill" href="\/p\?row=0&amp;s=0" tabindex="-1"><polygon/);
    assert.match(render('pyramid', [['a', 0]], fields('l', 'N')).body, /No data to show/);
  });

  test('pyramid: two series back to back on one scale (negative values count as their size)', () => {
    const { body, sheet } = render('pyramid', [['60+', 2, -4], ['0-19', 8, 6]], fields('age', 'Men', 'Women'), { link: drill });
    assert.deepEqual(decls(body, sheet, /class="pop-bar s\d ([^"]+)"/g), ['width:25.000%', 'width:50.000%', 'width:100.000%', 'width:75.000%']);
    assert.match(body, /<span class="swatch s2"><\/span>Women/, 'a legend');
    assert.match(body, /<a class="pop-track right drill" href="\/p\?row=0&amp;s=1"/);
    assert.match(body, /<td class="num"><a href="\/p\?row=1&amp;s=1">6<\/a><\/td>/);
  });

  test('polar: equal sectors per row, the radius follows the value; several series share a row\'s sector', () => {
    const one = render('polar', [['a', 1], ['b', 2], ['c', 0], ['d', 4]], fields('l', 'N'), { link: drill }).body;
    assert.equal(one.match(/class="polar-sector s1"/g)?.length, 3, 'zero values get no sector');
    // four rows: quarters from 12 o'clock; d (4 of 0..4) reaches the full radius 36
    assert.match(one, /d="M50,50 L14\.000,50\.000 A36\.000,36\.000 0 0 1 50\.000,14\.000 Z"/);
    assert.equal(one.match(/<line class="radar-spoke"/g)?.length, 4);
    assert.match(one, /<a class="drill" href="\/p\?row=1&amp;s=0" tabindex="-1"><path class="polar-sector s1"/);
    assert.match(one, /<a class="radar-label [^"]+ drill" href="\/p\?row=0&amp;s=0"/, 'labels: the keyboard path');
    const two = render('polar', [['a', 1, 2], ['b', 2, 2]], fields('l', 'A', 'B')).body;
    assert.equal(two.match(/class="polar-sector s2"/g)?.length, 2);
    assert.match(two, /<span class="swatch s2"><\/span>B/);
    assert.match(render('polar', [['all', 5]], fields('l', 'A')).body, /<circle class="polar-sector s1" cx="50" cy="50" r="36\.000">/, 'one row: a full circle');
  });
});
