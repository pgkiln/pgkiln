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

export type ChartKind = 'bar' | 'column' | 'line' | 'area' | 'donut';
export const CHART_KINDS: ChartKind[] = ['bar', 'column', 'line', 'area', 'donut'];

interface Series {
  name: string;
  values: number[];
}

const MAX_SERIES = 8;
const fmt = new Intl.NumberFormat('en', { maximumFractionDigits: 2 });
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const pct = (v: number) => `${Math.max(0, Math.min(100, v)).toFixed(3)}%`;

/** Round axis bounds and 4-6 clean ticks (0, 1,000, 2,000, …). */
export function niceScale(min: number, max: number) {
  const lo = Math.min(0, min);
  const hi = Math.max(0, max);
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
  return html`<details class="chart-data"><summary>Data table</summary>
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
        (s, si) => html`<span class="bar-track"><span class="bar s${si + 1}" style="width:${pct((Math.abs(s.values[i]) / max) * 100)}"></span></span>`,
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
      (t) => html`<div class="gridline${t === 0 ? ' baseline' : ''}" style="bottom:${pct(y(t))}"><span>${compact.format(t)}</span></div>`,
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
        return html`<span class="col-slot"><span class="col s${si + 1}${v < 0 ? ' neg' : ''}" style="bottom:${pct(bottom)};height:${pct(top - bottom)}"></span></span>`;
      })}${series.length === 1 && labels.length <= 12
        ? html`<span class="col-value" style="bottom:${pct(Math.max(y(series[0].values[i]), zero))}">${compact.format(series[0].values[i])}</span>`
        : ''}</div>`,
    )}</div>
  </div>${xLabels(labels)}`;
}

// ---------------------------------------------------------------- line / area
function line(labels: string[], series: Series[], area: boolean) {
  const all = series.flatMap((s) => s.values);
  const scale = niceScale(Math.min(...all), Math.max(...all));
  const { y, grid } = yAxis(scale);
  const n = labels.length;
  const x = (i: number) => (n === 1 ? 50 : (i / (n - 1)) * 100);
  const H = 100;
  const paths = series.map((s, si) => {
    const pts = s.values.map((v, i) => `${x(i).toFixed(3)},${(H - y(v)).toFixed(3)}`);
    const d = `M${pts.join(' L')}`;
    const fill = area ? html`<path class="area s${si + 1}" d="${`${d} L${x(n - 1)},${H - y(Math.max(scale.lo, 0))} L${x(0)},${H - y(Math.max(scale.lo, 0))} Z`}"></path>` : '';
    return html`${fill}<path class="line s${si + 1}" d="${d}" vector-effect="non-scaling-stroke"></path>`;
  });
  // End markers + a direct label for the last value of each series (<= 4 series).
  const ends = series.map(
    (s, si) => html`<span class="dot s${si + 1}" style="left:${pct(x(n - 1))};bottom:${pct(y(s.values[n - 1]))}"></span>`,
  );
  return html`<div class="chart-plot line-plot">
    ${grid}
    <svg class="chart-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${paths}</svg>
    ${ends}
    <div class="chart-hits">${labels.map(
      // each hit area is centred on its point (the plot clips the outer halves)
      (l, i) => {
        const w = n === 1 ? 100 : 100 / (n - 1);
        return html`<div class="hit" style="left:${(x(i) - w / 2).toFixed(3)}%;width:${w.toFixed(3)}%" data-tip="${tip(l, series, i)}"><span class="guide"></span></div>`;
      },
    )}</div>
  </div>${xLabels(labels)}`;
}

// ---------------------------------------------------------------- donut
function donut(labels: string[], series: Series[]) {
  // Part-to-whole of the first series; more than 6 slices fold into "Other".
  let entries = labels.map((l, i) => ({ label: l, value: Math.max(0, series[0].values[i]) })).filter((e) => e.value > 0);
  if (entries.length > 6) {
    entries.sort((a, b) => b.value - a.value);
    const rest = entries.slice(5).reduce((a, e) => a + e.value, 0);
    entries = [...entries.slice(0, 5), { label: 'Other', value: rest }];
  }
  const total = entries.reduce((a, e) => a + e.value, 0) || 1;
  const R = 15.9155; // circumference 100
  let offset = 25; // start at 12 o'clock
  const gap = entries.length > 1 ? 0.6 : 0; // surface gap between slices
  const arcs = entries.map((e, i) => {
    const len = (e.value / total) * 100;
    const arc = html`<circle class="slice s${i + 1}" cx="21" cy="21" r="${R}" stroke-dasharray="${Math.max(len - gap, 0.1)} ${100 - Math.max(len - gap, 0.1)}" stroke-dashoffset="${offset}"><title>${e.label}: ${fmt.format(e.value)} (${((e.value / total) * 100).toFixed(1)}%)</title></circle>`;
    offset -= len;
    return arc;
  });
  return html`<div class="chart-donut">
    <div class="donut-figure">
      <svg viewBox="0 0 42 42" aria-hidden="true">${arcs}</svg>
      <div class="donut-center"><b>${compact.format(total)}</b><span>${series[0].name}</span></div>
    </div>
    <ul class="chart-legend donut-legend">${entries.map(
      (e, i) => html`<li data-tip="${e.label}: ${fmt.format(e.value)}"><span class="swatch s${i + 1}"></span><span class="lg-label">${e.label}</span><span class="lg-value">${fmt.format(e.value)} · ${((e.value / total) * 100).toFixed(0)}%</span></li>`,
    )}</ul>
  </div>`;
}

export function renderChartBody(kind: ChartKind, title: string, rows: unknown[][], fields: { name: string }[]): Raw {
  const { labels, series } = parse(rows, fields);
  if (!series.length) return html`<p class="empty">The chart query must return a label column and at least one numeric column.</p>`;
  let body: Raw;
  switch (kind) {
    case 'column':
      body = column(labels, series);
      break;
    case 'line':
    case 'area':
      body = line(labels, series, kind === 'area');
      break;
    case 'donut':
      body = donut(labels, series);
      break;
    default:
      body = bar(labels, series);
  }
  return html`<figure class="chart chart-${kind}" aria-label="${title}">
    ${kind === 'donut' ? '' : legend(series)}
    ${body}
    ${dataTable(title, labels, series, fields[0]?.name ?? 'Label')}
  </figure>`;
}
