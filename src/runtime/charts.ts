import { PageCss } from '../css.ts';
import type { Translate } from '../i18n.ts';
import { html, raw, type Raw } from '../html.ts';
import { cell } from './report.ts';

// Server-rendered, responsive charts. The SELECT returns a label column
// followed by one or more numeric series columns (their names are the
// series names):
//   select dname, count(*) as "Employees", sum(sal) as "Payroll" from ...
//
// Text (axes, labels, legend) is HTML positioned in percentages so it stays
// legible at any width; only line/area geometry is SVG (stretched, with
// non-scaling strokes). Every chart carries a data table view, and marks
// have hover/focus tooltips (public/app.js). Colors come from the validated
// categorical palette in app.css (--series-1..8), assigned in fixed order.

export type ChartKind = 'bar' | 'column' | 'stacked' | 'line' | 'area' | 'combo' | 'scatter' | 'donut' | 'pie';
export const CHART_KINDS: ChartKind[] = ['bar', 'column', 'stacked', 'line', 'area', 'combo', 'scatter', 'donut', 'pie'];
/** The interactive report's chart view has one series with text labels: no stacked, combo or scatter. */
export const REPORT_CHART_KINDS: ChartKind[] = ['bar', 'column', 'line', 'area', 'donut', 'pie'];

interface Series {
  name: string;
  values: number[];
}

const MAX_SERIES = 8;
// Set per chart (rendering is synchronous): the page's stylesheet for the geometry
// classes, and the number formats of the request's language.
let css = new PageCss();
let fmt = new Intl.NumberFormat('en', { maximumFractionDigits: 2 });
let compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
let texts = {
  table: 'Data table',
  other: 'Other',
  label: 'Label',
  noSeries: 'The chart query must return a label column and at least one numeric column.',
  noScatter: 'A scatter chart needs a numeric first column (the x value).',
};
const pct = (v: number) => `${Math.max(0, Math.min(100, v)).toFixed(3)}%`;

/** Round axis bounds and 4-6 clean ticks (0, 1,000, 2,000, …). Value axes start at zero; a scatter's need not. */
export function niceScale(min: number, max: number, zero = true) {
  let lo = zero ? Math.min(0, min) : min;
  let hi = zero ? Math.max(0, max) : max;
  if (hi === lo) {
    // one distinct value off zero: centre it
    const pad = Math.abs(hi) / 10 || 1;
    lo -= pad;
    hi += pad;
  }
  const span = hi - lo || 1;
  const raw = span / 5;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= 6)!;
  const niceLo = Math.floor(lo / step) * step;
  const niceHi = Math.ceil(hi / step) * step || step;
  const ticks: number[] = [];
  for (let t = niceLo; t <= niceHi + step / 2; t += step) ticks.push(Math.round(t / step) * step);
  return { lo: niceLo, hi: niceHi, ticks };
}

function parse(rows: unknown[][], fields: { name: string }[]) {
  const labels = rows.map((r) => cell(r[0]));
  const series: Series[] = fields.slice(1, 1 + MAX_SERIES).map((f, i) => ({
    name: f.name,
    values: rows.map((r) => Number(r[i + 1]) || 0),
  }));
  return { labels, series };
}

function legend(series: Series[]) {
  if (series.length < 2) return '';
  return html`<ul class="chart-legend">${series.map((s, i) => html`<li><span class="swatch s${i + 1}"></span>${s.name}</li>`)}</ul>`;
}

function dataTable(title: string, labels: string[], series: Series[], labelHeading: string) {
  return html`<details class="chart-data"><summary>${texts.table}</summary>
    <div class="table-wrap"><table class="report">
      <caption class="sr-only">${title}</caption>
      <thead><tr><th scope="col">${labelHeading}</th>${series.map((s) => html`<th scope="col" class="num">${s.name}</th>`)}</tr></thead>
      <tbody>${labels.map((l, i) => html`<tr><th scope="row">${l}</th>${series.map((s) => html`<td class="num">${fmt.format(s.values[i])}</td>`)}</tr>`)}</tbody>
    </table></div></details>`;
}

const tip = (label: string, series: Series[], i: number) =>
  series.length === 1 ? `${label}: ${fmt.format(series[0].values[i])}` : `${label} · ${series.map((s) => `${s.name}: ${fmt.format(s.values[i])}`).join(' · ')}`;

// ---------------------------------------------------------------- bar (horizontal)
function bar(labels: string[], series: Series[]) {
  const all = series.flatMap((s) => s.values);
  const max = Math.max(...all.map(Math.abs), 1);
  return html`<div class="chart-bar${series.length > 1 ? ' multi' : ''}">${labels.map(
    (l, i) => html`<div class="bar-row" data-tip="${tip(l, series, i)}">
      <span class="bar-label" title="${l}">${l}</span>
      <span class="bar-stack">${series.map(
        (s, si) => html`<span class="bar-track"><span class="bar s${si + 1} ${css.cls(`width:${pct((Math.abs(s.values[i]) / max) * 100)}`)}"></span></span>`,
      )}</span>
      <span class="bar-value">${series.length === 1 ? fmt.format(series[0].values[i]) : ''}</span>
    </div>`,
  )}</div>`;
}

// ---------------------------------------------------------------- shared y axis
function yAxis(scale: ReturnType<typeof niceScale>) {
  const y = (v: number) => ((v - scale.lo) / (scale.hi - scale.lo)) * 100;
  return {
    y,
    grid: html`<div class="chart-grid" aria-hidden="true">${scale.ticks.map(
      (t) => html`<div class="gridline${t === 0 ? ' baseline' : ''} ${css.cls(`bottom:${pct(y(t))}`)}"><span>${compact.format(t)}</span></div>`,
    )}</div>`,
  };
}

function xLabels(labels: string[]) {
  // thin out labels so they never collide: at most ~12 on the axis
  const every = Math.ceil(labels.length / 12);
  return html`<div class="chart-x" aria-hidden="true">${labels.map(
    (l, i) => html`<span${i % every ? raw(' class="skip"') : ''} title="${l}">${l}</span>`,
  )}</div>`;
}

// ---------------------------------------------------------------- column (vertical)
function column(labels: string[], series: Series[]) {
  const all = series.flatMap((s) => s.values);
  const scale = niceScale(Math.min(...all), Math.max(...all));
  const { y, grid } = yAxis(scale);
  const zero = y(0);
  return html`<div class="chart-plot">
    ${grid}
    <div class="chart-cols">${labels.map(
      (l, i) => html`<div class="col-group" data-tip="${tip(l, series, i)}" tabindex="0" aria-label="${tip(l, series, i)}">${series.map((s, si) => {
        const v = s.values[i];
        const top = y(Math.max(v, 0));
        const bottom = y(Math.min(v, 0));
        return html`<span class="col-slot"><span class="col s${si + 1}${v < 0 ? ' neg' : ''} ${css.cls(`bottom:${pct(bottom)};height:${pct(top - bottom)}`)}"></span></span>`;
      })}${series.length === 1 && labels.length <= 12
        ? html`<span class="col-value ${css.cls(`bottom:${pct(Math.max(y(series[0].values[i]), zero))}`)}">${compact.format(series[0].values[i])}</span>`
        : ''}</div>`,
    )}</div>
  </div>${xLabels(labels)}`;
}

// ---------------------------------------------------------------- stacked columns
function stacked(labels: string[], series: Series[]) {
  // Positive values stack up from zero, negative ones down; the scale comes from the sums.
  const sums = (sign: 1 | -1) => labels.map((_, i) => series.reduce((a, s) => a + (Math.sign(s.values[i]) === sign ? s.values[i] : 0), 0));
  const scale = niceScale(Math.min(...sums(-1)), Math.max(...sums(1)));
  const { y, grid } = yAxis(scale);
  return html`<div class="chart-plot">
    ${grid}
    <div class="chart-cols">${labels.map((l, i) => {
      let up = 0;
      let down = 0;
      // the outermost segment on each side gets the rounded end
      const last = (sign: number) => series.reduce((at, s, si) => (Math.sign(s.values[i]) === sign ? si : at), -1);
      const top = last(1);
      const end = last(-1);
      const segments = series.map((s, si) => {
        const v = s.values[i];
        if (!v) return '';
        const from = v > 0 ? up : down + v;
        if (v > 0) up += v;
        else down += v;
        const edge = si === top ? ' top' : si === end ? ' neg' : '';
        return html`<span class="col seg${edge} s${si + 1} ${css.cls(`bottom:${pct(y(from))};height:${pct(y(from + Math.abs(v)) - y(from))}`)}"></span>`;
      });
      return html`<div class="col-group" data-tip="${tip(l, series, i)}" tabindex="0" aria-label="${tip(l, series, i)}"><span class="col-slot stack">${segments}</span></div>`;
    })}</div>
  </div>${xLabels(labels)}`;
}

// ---------------------------------------------------------------- line / area
type Scale = ReturnType<typeof niceScale>;

/** SVG paths and end markers for `series` (colour slots from `first`), at x(i) percent. */
function lineLayer(series: Series[], first: number, n: number, x: (i: number) => number, y: (v: number) => number, scale: Scale, area: boolean) {
  const H = 100;
  const paths = series.map((s, k) => {
    const si = first + k;
    const pts = s.values.map((v, i) => `${x(i).toFixed(3)},${(H - y(v)).toFixed(3)}`);
    const d = `M${pts.join(' L')}`;
    const fill = area ? html`<path class="area s${si + 1}" d="${`${d} L${x(n - 1)},${H - y(Math.max(scale.lo, 0))} L${x(0)},${H - y(Math.max(scale.lo, 0))} Z`}"></path>` : '';
    return html`${fill}<path class="line s${si + 1}" d="${d}" vector-effect="non-scaling-stroke"></path>`;
  });
  // An end marker on the last value of each series.
  const ends = series.map(
    (s, k) => html`<span class="dot s${first + k + 1} ${css.cls(`left:${pct(x(n - 1))};bottom:${pct(y(s.values[n - 1]))}`)}"></span>`,
  );
  return html`<svg class="chart-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${paths}</svg>${ends}`;
}

function line(labels: string[], series: Series[], area: boolean) {
  const all = series.flatMap((s) => s.values);
  const scale = niceScale(Math.min(...all), Math.max(...all));
  const { y, grid } = yAxis(scale);
  const n = labels.length;
  const x = (i: number) => (n === 1 ? 50 : (i / (n - 1)) * 100);
  return html`<div class="chart-plot line-plot">
    ${grid}
    ${lineLayer(series, 0, n, x, y, scale, area)}
    <div class="chart-hits">${labels.map(
      // each hit area is centred on its point (the plot clips the outer halves)
      (l, i) => {
        const w = n === 1 ? 100 : 100 / (n - 1);
        return html`<div class="hit ${css.cls(`left:${(x(i) - w / 2).toFixed(3)}%;width:${w.toFixed(3)}%`)}" data-tip="${tip(l, series, i)}"><span class="guide"></span></div>`;
      },
    )}</div>
  </div>${xLabels(labels)}`;
}

// ---------------------------------------------------------------- combo
function combo(labels: string[], series: Series[]) {
  // The first series as columns, the others as lines through the column centres (one shared axis).
  const all = series.flatMap((s) => s.values);
  const scale = niceScale(Math.min(...all), Math.max(...all));
  const { y, grid } = yAxis(scale);
  const n = labels.length;
  const x = (i: number) => ((i + 0.5) / n) * 100;
  const [bars, ...rest] = series;
  return html`<div class="chart-plot line-plot">
    ${grid}
    <div class="chart-cols">${labels.map((l, i) => {
      const v = bars.values[i];
      const top = y(Math.max(v, 0));
      const bottom = y(Math.min(v, 0));
      return html`<div class="col-group" data-tip="${tip(l, series, i)}" tabindex="0" aria-label="${tip(l, series, i)}"><span class="col-slot"><span class="col s1${v < 0 ? ' neg' : ''} ${css.cls(`bottom:${pct(bottom)};height:${pct(top - bottom)}`)}"></span></span></div>`;
    })}</div>
    ${rest.length ? lineLayer(rest, 1, n, x, y, scale, false) : ''}
  </div>${xLabels(labels)}`;
}

// ---------------------------------------------------------------- scatter
function scatter(rows: unknown[][], fields: { name: string }[], series: Series[]) {
  // The label column is the x value; each series is a y value. Rows without a numeric x are left out.
  const xs = rows.map((r) => (r[0] === null || r[0] === '' ? NaN : Number(r[0])));
  const keep = xs.map((v, i) => i).filter((i) => Number.isFinite(xs[i]));
  if (!keep.length) return html`<p class="empty">${texts.noScatter}</p>`;
  const xScale = niceScale(Math.min(...keep.map((i) => xs[i])), Math.max(...keep.map((i) => xs[i])), false);
  const all = series.flatMap((s) => keep.map((i) => s.values[i]));
  const scale = niceScale(Math.min(...all), Math.max(...all), false);
  const { y, grid } = yAxis(scale);
  const x = (v: number) => ((v - xScale.lo) / (xScale.hi - xScale.lo)) * 100;
  const xName = fields[0]?.name ?? texts.label;
  return html`<div class="chart-plot scatter-plot">
    ${grid}
    ${series.map((s, si) =>
      keep.map((i) => {
        const t = `${s.name} · ${xName}: ${fmt.format(xs[i])} · ${fmt.format(s.values[i])}`;
        return html`<span class="pt s${si + 1} ${css.cls(`left:${pct(x(xs[i]))};bottom:${pct(y(s.values[i]))}`)}" data-tip="${t}" tabindex="0" aria-label="${t}"></span>`;
      }),
    )}
  </div><div class="chart-xs" aria-hidden="true">${xScale.ticks.map(
    (t) => html`<span class="${css.cls(`left:${pct(x(t))}`)}">${compact.format(t)}</span>`,
  )}</div>`;
}

// ---------------------------------------------------------------- donut / pie
function donut(labels: string[], series: Series[], pie: boolean) {
  // Part-to-whole of the first series; more than 6 slices fold into "Other".
  let entries = labels.map((l, i) => ({ label: l, value: Math.max(0, series[0].values[i]) })).filter((e) => e.value > 0);
  if (entries.length > 6) {
    entries.sort((a, b) => b.value - a.value);
    const rest = entries.slice(5).reduce((a, e) => a + e.value, 0);
    entries = [...entries.slice(0, 5), { label: texts.other, value: rest }];
  }
  const total = entries.reduce((a, e) => a + e.value, 0) || 1;
  // A donut is a ring of circumference 100; a pie is a stroke as wide as the
  // radius around a circle of half that, so its lengths are halved.
  const R = pie ? 7.9577 : 15.9155;
  const scale = pie ? 0.5 : 1;
  let offset = 25 * scale; // start at 12 o'clock
  const gap = entries.length > 1 && !pie ? 0.6 : 0; // surface gap between slices
  const arcs = entries.map((e, i) => {
    const len = (e.value / total) * 100;
    const dash = Math.max(len - gap, 0.1) * scale;
    const arc = html`<circle class="slice s${i + 1}" cx="21" cy="21" r="${R}" stroke-dasharray="${dash} ${100 * scale - dash}" stroke-dashoffset="${offset}"><title>${e.label}: ${fmt.format(e.value)} (${((e.value / total) * 100).toFixed(1)}%)</title></circle>`;
    offset -= len * scale;
    return arc;
  });
  return html`<div class="chart-donut">
    <div class="donut-figure">
      <svg viewBox="0 0 42 42" aria-hidden="true">${arcs}</svg>
      ${pie ? '' : html`<div class="donut-center"><b>${compact.format(total)}</b><span>${series[0].name}</span></div>`}
    </div>
    <ul class="chart-legend donut-legend">${entries.map(
      (e, i) => html`<li data-tip="${e.label}: ${fmt.format(e.value)}"><span class="swatch s${i + 1}"></span><span class="lg-label">${e.label}</span><span class="lg-value">${fmt.format(e.value)} · ${((e.value / total) * 100).toFixed(0)}%</span></li>`,
    )}</ul>
  </div>`;
}

/** A chart's markup; its geometry goes into `sheet` as classes (no inline styles: see css.ts). */
export function renderChartBody(kind: ChartKind, title: string, rows: unknown[][], fields: { name: string }[], sheet: PageCss, lang = 'en', t?: Translate): Raw {
  css = sheet;
  try {
    fmt = new Intl.NumberFormat(lang, { maximumFractionDigits: 2 });
    compact = new Intl.NumberFormat(lang, { notation: 'compact', maximumFractionDigits: 1 });
  } catch {
    // unknown locale: keep the previous formats
  }
  if (t) texts = { ...texts, table: t('chart.table'), other: t('chart.other'), label: t('chart.label') };
  const { labels, series } = parse(rows, fields);
  if (!series.length) return html`<p class="empty">${texts.noSeries}</p>`;
  let body: Raw;
  switch (kind) {
    case 'column':
      body = column(labels, series);
      break;
    case 'stacked':
      body = stacked(labels, series);
      break;
    case 'line':
    case 'area':
      body = line(labels, series, kind === 'area');
      break;
    case 'combo':
      body = combo(labels, series);
      break;
    case 'scatter':
      body = scatter(rows, fields, series);
      break;
    case 'donut':
    case 'pie':
      body = donut(labels, series, kind === 'pie');
      break;
    default:
      body = bar(labels, series);
  }
  return html`<figure class="chart chart-${kind}" aria-label="${title}">
    ${kind === 'donut' || kind === 'pie' ? '' : legend(series)}
    ${body}
    ${dataTable(title, labels, series, fields[0]?.name ?? texts.label)}
  </figure>`;
}
