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
//
// Drill-down: with a link (config.link), every mark is an <a> to a page with
// item values from its row (checksummed URLs, built by the caller), and the
// data table carries the same links for the keyboard. Marks that are not
// focusable themselves (SVG slices, line hit areas) take tabindex="-1": the
// data table or the legend is their keyboard path.
//
// A Gantt chart is the exception to "label + numeric series": label, start and
// end columns (dates or timestamps), plus optional progress, task_id and
// depends_on columns by name; it has its own time axis and data table.

export type ChartKind = 'bar' | 'column' | 'stacked' | 'line' | 'area' | 'combo' | 'scatter' | 'donut' | 'pie' | 'bubble' | 'gauge' | 'funnel' | 'radar' | 'gantt' | 'pyramid' | 'polar';
export const CHART_KINDS: ChartKind[] = ['bar', 'column', 'stacked', 'line', 'area', 'combo', 'scatter', 'donut', 'pie', 'bubble', 'gauge', 'funnel', 'radar', 'gantt', 'pyramid', 'polar'];

/** A gauge's scale and thresholds (config.gauge): warning above critical means low values are bad. */
export interface GaugeConfig {
  min?: number;
  max?: number;
  warning?: number;
  critical?: number;
}

export interface ChartOptions {
  /** Drill-down: the href attributes for row i (series si, or null for the whole row), or null for no link. */
  link?: (i: number, si: number | null) => Raw | null;
  /** columns only the link uses: left out of the series */
  hidden?: string[];
  gauge?: GaugeConfig;
  /** values in labels, tips and the data table (a format mask, see numformat.ts); axes stay compact */
  format?: (v: number) => string;
  /** a Gantt chart's "today" line (milliseconds, wall clock as UTC); default now */
  now?: number;
}
/** The interactive report's chart view has one series with text labels: no stacked, combo or scatter. */
export const REPORT_CHART_KINDS: ChartKind[] = ['bar', 'column', 'line', 'area', 'donut', 'pie'];

interface Series {
  name: string;
  values: number[];
}

let link: ChartOptions['link'];
/** A mark: an <a> when the chart drills down (row i, series si), else `tag` (focusable when asked). */
function mark(tag: 'div' | 'span', i: number, si: number | null, cls: string, tip: string | null, inner: unknown, focusable = true, namedByContent = false): Raw {
  const href = link?.(i, si) ?? null;
  // a drill link with visible text is named by that text; elsewhere the tip is the name (role img: a labelled graphic)
  const tipAttr = tip === null ? '' : href && namedByContent ? html` data-tip="${tip}"` : html` data-tip="${tip}" aria-label="${tip}"`;
  if (href) return html`<a class="${cls} drill" ${href}${tipAttr}${focusable ? '' : raw(' tabindex="-1"')}>${inner}</a>`;
  const role = tip === null ? '' : raw(' role="img"');
  return tag === 'div'
    ? html`<div class="${cls}"${role}${tipAttr}${focusable ? raw(' tabindex="0"') : ''}>${inner}</div>`
    : html`<span class="${cls}"${role}${tipAttr}${focusable ? raw(' tabindex="0"') : ''}>${inner}</span>`;
}

const MAX_SERIES = 8;
// Set per chart (rendering is synchronous): the page's stylesheet for the geometry
// classes, and the number formats of the request's language.
let css = new PageCss();
let fmt: { format: (v: number) => string } = new Intl.NumberFormat('en', { maximumFractionDigits: 2 });
let compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
let texts = {
  table: 'Data table',
  other: 'Other',
  label: 'Label',
  noSeries: 'The chart query must return a label column and at least one numeric column.',
  noScatter: 'A scatter chart needs a numeric first column (the x value).',
  noBubble: 'A bubble chart needs a label column and three numeric columns: x, y and size.',
  noRadar: 'A radar chart needs at least three rows, one per axis.',
  good: 'On target',
  warning: 'Warning',
  critical: 'Critical',
  ofFirst: 'of the first stage',
  size: 'size',
  noGantt: 'A Gantt chart needs a label column, a start date and an end date (milestones may leave the end empty).',
  noData: 'No data to show.',
  today: 'Today',
};
let chartLang = 'en';
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

function parse(rows: unknown[][], fields: { name: string }[], hidden: string[] = []) {
  const labels = rows.map((r) => cell(r[0]));
  const skip = new Set(hidden.map((h) => h.toLowerCase()));
  const series: Series[] = fields
    .map((f, i) => ({ f, i }))
    .slice(1)
    .filter(({ f }) => !skip.has(f.name.toLowerCase()))
    .slice(0, MAX_SERIES)
    .map(({ f, i }) => ({ name: f.name, values: rows.map((r) => Number(r[i]) || 0) }));
  return { labels, series };
}

function legend(series: Series[]) {
  if (series.length < 2) return '';
  return html`<ul class="chart-legend">${series.map((s, i) => html`<li><span class="swatch s${i + 1}"></span>${s.name}</li>`)}</ul>`;
}

function dataTable(title: string, labels: string[], series: Series[], labelHeading: string, wholeRows = false) {
  return html`<details class="chart-data"><summary>${texts.table}</summary>
    <div class="table-wrap"><table class="report">
      <caption class="sr-only">${title}</caption>
      <thead><tr><th scope="col">${labelHeading}</th>${series.map((s) => html`<th scope="col" class="num">${s.name}</th>`)}</tr></thead>
      <tbody>${labels.map((l, i) => {
        // one series (or a chart of whole rows): the label links; several: each value links with its series
        const rowLink = series.length === 1 || wholeRows ? link?.(i, wholeRows ? null : 0) : null;
        return html`<tr><th scope="row">${rowLink ? html`<a ${rowLink}>${l}</a>` : l}</th>${series.map((s, si) => {
          const cellLink = series.length > 1 && !wholeRows ? link?.(i, si) : null;
          return html`<td class="num">${cellLink ? html`<a ${cellLink}>${fmt.format(s.values[i])}</a>` : fmt.format(s.values[i])}</td>`;
        })}</tr>`;
      })}</tbody>
    </table></div></details>`;
}

const tip = (label: string, series: Series[], i: number) =>
  series.length === 1 ? `${label}: ${fmt.format(series[0].values[i])}` : `${label} · ${series.map((s) => `${s.name}: ${fmt.format(s.values[i])}`).join(' · ')}`;

// ---------------------------------------------------------------- bar (horizontal)
function bar(labels: string[], series: Series[]) {
  const all = series.flatMap((s) => s.values);
  const max = Math.max(...all.map(Math.abs), 1);
  const multi = series.length > 1;
  return html`<div class="chart-bar${multi ? ' multi' : ''}">${labels.map((l, i) => {
    const inner = html`<span class="bar-label" title="${l}">${l}</span>
      <span class="bar-stack">${series.map((s, si) => {
        const b = html`<span class="bar s${si + 1} ${css.cls(`width:${pct((Math.abs(s.values[i]) / max) * 100)}`)}"></span>`;
        // several series: each bar is its own link
        return multi && link ? mark('span', i, si, 'bar-track', `${l} · ${s.name}: ${fmt.format(s.values[i])}`, b, false) : html`<span class="bar-track">${b}</span>`;
      })}</span>
      <span class="bar-value">${multi ? '' : fmt.format(series[0].values[i])}</span>`;
    return !multi && link ? mark('div', i, 0, 'bar-row', tip(l, series, i), inner) : html`<div class="bar-row" data-tip="${tip(l, series, i)}">${inner}</div>`;
  })}</div>`;
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
    <div class="chart-cols">${labels.map((l, i) => {
      const multi = series.length > 1;
      const inner = html`${series.map((s, si) => {
        const v = s.values[i];
        const top = y(Math.max(v, 0));
        const bottom = y(Math.min(v, 0));
        const col = html`<span class="col s${si + 1}${v < 0 ? ' neg' : ''} ${css.cls(`bottom:${pct(bottom)};height:${pct(top - bottom)}`)}"></span>`;
        return multi && link ? mark('span', i, si, 'col-slot', `${l} · ${s.name}: ${fmt.format(v)}`, col, false) : html`<span class="col-slot">${col}</span>`;
      })}${!multi && labels.length <= 12
        ? html`<span class="col-value ${css.cls(`bottom:${pct(Math.max(y(series[0].values[i]), zero))}`)}">${compact.format(series[0].values[i])}</span>`
        : ''}`;
      return multi ? html`<div class="col-group" role="img" data-tip="${tip(l, series, i)}" tabindex="0" aria-label="${tip(l, series, i)}">${inner}</div>` : mark('div', i, 0, 'col-group', tip(l, series, i), inner);
    })}</div>
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
        const cls = `col seg${edge} s${si + 1} ${css.cls(`bottom:${pct(y(from))};height:${pct(y(from + Math.abs(v)) - y(from))}`)}`;
        return link ? mark('span', i, si, cls, `${l} · ${s.name}: ${fmt.format(v)}`, '', false) : html`<span class="${cls}"></span>`;
      });
      return html`<div class="col-group" role="img" data-tip="${tip(l, series, i)}" tabindex="0" aria-label="${tip(l, series, i)}"><span class="col-slot stack">${segments}</span></div>`;
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
        const cls = `hit ${css.cls(`left:${(x(i) - w / 2).toFixed(3)}%;width:${w.toFixed(3)}%`)}`;
        if (link) return mark('div', i, series.length === 1 ? 0 : null, cls, tip(l, series, i), html`<span class="guide"></span>`, false);
        return html`<div class="${cls}" data-tip="${tip(l, series, i)}"><span class="guide"></span></div>`;
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
      return mark('div', i, series.length === 1 ? 0 : null, 'col-group', tip(l, series, i), html`<span class="col-slot"><span class="col s1${v < 0 ? ' neg' : ''} ${css.cls(`bottom:${pct(bottom)};height:${pct(top - bottom)}`)}"></span></span>`);
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
        return mark('span', i, si, `pt s${si + 1} ${css.cls(`left:${pct(x(xs[i]))};bottom:${pct(y(s.values[i]))}`)}`, t, '');
      }),
    )}
  </div><div class="chart-xs" aria-hidden="true">${xScale.ticks.map(
    (t) => html`<span class="${css.cls(`left:${pct(x(t))}`)}">${compact.format(t)}</span>`,
  )}</div>`;
}

// ---------------------------------------------------------------- donut / pie
function donut(labels: string[], series: Series[], pie: boolean) {
  // Part-to-whole of the first series; more than 6 slices fold into "Other".
  let entries = labels.map((l, i) => ({ label: l, value: Math.max(0, series[0].values[i]), i })).filter((e) => e.value > 0);
  if (entries.length > 6) {
    entries.sort((a, b) => b.value - a.value);
    const rest = entries.slice(5).reduce((a, e) => a + e.value, 0);
    // "Other" is no row: it has no link
    entries = [...entries.slice(0, 5), { label: texts.other, value: rest, i: -1 }];
  }
  const href = (e: { i: number }) => (e.i >= 0 ? (link?.(e.i, 0) ?? null) : null);
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
    let arc = html`<circle class="slice s${i + 1}" cx="21" cy="21" r="${R}" stroke-dasharray="${dash} ${100 * scale - dash}" stroke-dashoffset="${offset}"><title>${e.label}: ${fmt.format(e.value)} (${((e.value / total) * 100).toFixed(1)}%)</title></circle>`;
    // a slice links too (by mouse); the legend below is the keyboard path
    const h = href(e);
    if (h) arc = html`<a class="drill" ${h} tabindex="-1">${arc}</a>`;
    offset -= len * scale;
    return arc;
  });
  return html`<div class="chart-donut">
    <div class="donut-figure">
      <svg viewBox="0 0 42 42" aria-hidden="true">${arcs}</svg>
      ${pie ? '' : html`<div class="donut-center"><b>${compact.format(total)}</b><span>${series[0].name}</span></div>`}
    </div>
    <ul class="chart-legend donut-legend">${entries.map((e, i) => {
      const inner = html`<span class="swatch s${i + 1}"></span><span class="lg-label">${e.label}</span><span class="lg-value">${fmt.format(e.value)} · ${((e.value / total) * 100).toFixed(0)}%</span>`;
      const h = href(e);
      return html`<li data-tip="${e.label}: ${fmt.format(e.value)}">${h ? html`<a class="drill" ${h}>${inner}</a>` : inner}</li>`;
    })}</ul>
  </div>`;
}

// ---------------------------------------------------------------- bubble
function bubble(labels: string[], series: Series[]) {
  // label, x, y, size: one series (slot 1); the area of a bubble is proportional to its size
  if (series.length < 3) return html`<p class="empty">${texts.noBubble}</p>`;
  const [xs, ys, zs] = series;
  const xScale = niceScale(Math.min(...xs.values), Math.max(...xs.values), false);
  const scale = niceScale(Math.min(...ys.values), Math.max(...ys.values), false);
  const { y, grid } = yAxis(scale);
  const x = (v: number) => ((v - xScale.lo) / (xScale.hi - xScale.lo)) * 100;
  const zMax = Math.max(...zs.values.map(Math.abs), 1e-9);
  const MAX_R = 22;
  const MIN_R = 4;
  // the largest first, so smaller bubbles stay on top and can be pointed at
  const order = labels.map((_, i) => i).sort((a, b) => Math.abs(zs.values[b]) - Math.abs(zs.values[a]));
  return html`<div class="chart-plot scatter-plot bubble-plot">
    ${grid}
    ${order.map((i) => {
      const r = Math.max(MIN_R, MAX_R * Math.sqrt(Math.abs(zs.values[i]) / zMax));
      const t = `${labels[i]} · ${xs.name}: ${fmt.format(xs.values[i])} · ${ys.name}: ${fmt.format(ys.values[i])} · ${zs.name}: ${fmt.format(zs.values[i])}`;
      const geo = css.cls(`left:${pct(x(xs.values[i]))};bottom:${pct(y(ys.values[i]))};width:${(2 * r).toFixed(1)}px;height:${(2 * r).toFixed(1)}px;margin:0 0 -${r.toFixed(1)}px -${r.toFixed(1)}px`);
      return mark('span', i, null, `bubble s1 ${geo}`, t, '');
    })}
  </div><div class="chart-xs" aria-hidden="true">${xScale.ticks.map(
    (t) => html`<span class="${css.cls(`left:${pct(x(t))}`)}">${compact.format(t)}</span>`,
  )}</div><p class="chart-axes">${xs.name} → · ${ys.name} ↑ · ${texts.size}: ${zs.name}</p>`;
}

// ---------------------------------------------------------------- gauge
type Status = 'good' | 'warning' | 'critical';

/** The status of a value against the thresholds: warning above critical means low values are bad. */
export function gaugeStatus(v: number, g: GaugeConfig): Status | null {
  const { warning: w, critical: c } = g;
  if (w === undefined && c === undefined) return null;
  const down = w !== undefined && c !== undefined && w > c;
  const hit = (th: number | undefined) => th !== undefined && (down ? v <= th : v >= th);
  return hit(c) ? 'critical' : hit(w) ? 'warning' : 'good';
}

function gauge(labels: string[], series: Series[], g: GaugeConfig) {
  // One gauge per row (up to 12): the value of the first series on a half circle from min to max.
  const values = series[0].values.slice(0, 12);
  const min = Number.isFinite(g.min) ? g.min! : 0;
  const top = Math.max(...values, g.warning ?? -Infinity, g.critical ?? -Infinity);
  const max = Number.isFinite(g.max) && g.max! > min ? g.max! : niceScale(min, top > min ? top : min + 1).hi;
  const at = (v: number) => Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100));
  const ARC = 'M10,50 A40,40 0 0 1 90,50';
  // the threshold bands, as a thin ring outside the track
  const bands: { from: number; to: number; status: Status }[] = [];
  const status0 = gaugeStatus(min, g);
  if (status0) {
    const cuts = [g.warning, g.critical].filter((x): x is number => x !== undefined && x > min && x < max).sort((a, b) => a - b);
    let from = min;
    for (const cut of [...cuts, max]) {
      bands.push({ from, to: cut, status: gaugeStatus((from + cut) / 2, g)! });
      from = cut;
    }
  }
  const ring = bands.map(
    (b) => html`<path class="gauge-band status-${b.status}" d="M5,50 A45,45 0 0 1 95,50" pathLength="100" stroke-dasharray="${(at(b.to) - at(b.from)).toFixed(3)} 200" stroke-dashoffset="${(-at(b.from)).toFixed(3)}"></path>`,
  );
  return html`<div class="chart-gauges">${values.map((v, i) => {
    const status = gaugeStatus(v, g);
    const t = `${labels[i]}: ${fmt.format(v)}${status ? ` · ${texts[status]}` : ''}`;
    const inner = html`<span class="gauge-figure">
        <svg viewBox="0 0 100 56" aria-hidden="true">
          ${ring}
          <path class="gauge-track" d="${ARC}" pathLength="100"></path>
          <path class="gauge-value ${status ? `status-${status}` : 's1'}" d="${ARC}" pathLength="100" stroke-dasharray="${Math.max(at(v), 0.5).toFixed(3)} 200"></path>
        </svg>
        <span class="gauge-number">${compact.format(v)}</span>
      </span>
      <span class="gauge-scale" aria-hidden="true"><span>${compact.format(min)}</span><span>${compact.format(max)}</span></span>
      <span class="gauge-label">${labels[i]}</span>
      ${status ? html`<span class="gauge-status status-${status}"><span class="status-icon" aria-hidden="true">${status === 'good' ? '✓' : '!'}</span>${texts[status]}</span>` : ''}`;
    return mark('div', i, 0, 'gauge', t, inner, true, true);
  })}</div>`;
}

// ---------------------------------------------------------------- funnel
function funnel(labels: string[], series: Series[]) {
  // Stages in the query's order, centred bars of one hue; the share of the first stage on the right.
  const values = series[0].values.map((v) => Math.max(0, v));
  const max = Math.max(...values, 1e-9);
  const first = values[0] || 0;
  return html`<div class="chart-funnel">${labels.map((l, i) => {
    const share = first ? `${((values[i] / first) * 100).toFixed(0)}%` : '';
    const t = `${l}: ${fmt.format(series[0].values[i])}${share && i ? ` · ${share} ${texts.ofFirst}` : ''}`;
    return mark('div', i, 0, 'funnel-row', t, html`<span class="bar-label" title="${l}">${l}</span>
      <span class="funnel-track"><span class="funnel-bar s1 ${css.cls(`width:${pct((values[i] / max) * 100)}`)}"></span></span>
      <span class="bar-value">${fmt.format(series[0].values[i])}${i && share ? html` <small>${share}</small>` : ''}</span>`);
  })}</div>`;
}

// ---------------------------------------------------------------- radar
function radar(labels: string[], series: Series[]) {
  // One axis per row (3-12), one polygon per series, rings at the value axis' ticks.
  const n = Math.min(labels.length, 12);
  if (n < 3) return html`<p class="empty">${texts.noRadar}</p>`;
  const all = series.flatMap((s) => s.values.slice(0, n));
  const scale = niceScale(0, Math.max(...all, 0));
  const R = 34;
  const point = (k: number, v: number) => {
    const a = (2 * Math.PI * k) / n - Math.PI / 2; // the first axis points up
    const r = (Math.max(0, v - scale.lo) / (scale.hi - scale.lo)) * R;
    return [50 + r * Math.cos(a), 50 + r * Math.sin(a)];
  };
  const poly = (vs: number[]) => vs.map((v, k) => point(k, v).map((c) => c.toFixed(3)).join(',')).join(' ');
  const rings = scale.ticks.filter((t) => t > 0).map((t) => html`<polygon class="radar-ring" points="${poly(Array(n).fill(t))}"></polygon>`);
  const spokes = Array.from({ length: n }, (_, k) => {
    const [x, y] = point(k, scale.hi);
    return html`<line class="radar-spoke" x1="50" y1="50" x2="${x.toFixed(3)}" y2="${y.toFixed(3)}"></line>`;
  });
  const shapes = series.map(
    (s, si) => html`<polygon class="radar-area s${si + 1}" points="${poly(s.values.slice(0, n))}"></polygon>${s.values.slice(0, n).map((v, k) => {
      const [x, y] = point(k, v);
      return html`<circle class="radar-dot s${si + 1}" cx="${x.toFixed(3)}" cy="${y.toFixed(3)}" r="1.3"></circle>`;
    })}`,
  );
  const axisLabels = labels.slice(0, n).map((l, k) => {
    const [x, y] = point(k, scale.hi * 1.2);
    const side = Math.abs(x - 50) < 2 ? 'mid' : x < 50 ? 'left' : 'right';
    return mark('span', k, series.length === 1 ? 0 : null, `radar-label ${side} ${css.cls(`left:${pct(x)};top:${pct(y)}`)}`, tip(l, series, k), l);
  });
  const ticks = scale.ticks.filter((t) => t > 0).map((t) => {
    const [, y] = point(0, t);
    return html`<span class="radar-tick ${css.cls(`top:${pct(y)}`)}">${compact.format(t)}</span>`;
  });
  return html`<div class="chart-radar"><div class="radar-figure">
    <svg viewBox="0 0 100 100" aria-hidden="true">${rings}${spokes}${shapes}</svg>
    <span aria-hidden="true">${ticks}</span>
    ${axisLabels}
  </div></div>`;
}

// ---------------------------------------------------------------- pyramid
function pyramid(labels: string[], series: Series[]) {
  // Two series: back-to-back bars (a population pyramid), the first to the left.
  if (series.length >= 2) return population(labels, series.slice(0, 2));
  // One series: a triangle cut into segments from the top (the first row) down,
  // each segment's area in proportion to its value; more than 8 fold into "Other".
  let entries = labels.map((l, i) => ({ label: l, value: Math.max(0, series[0].values[i]), i })).filter((e) => e.value > 0);
  if (!entries.length) return html`<p class="empty">${texts.noData}</p>`;
  if (entries.length > 8) entries = [...entries.slice(0, 7), { label: texts.other, value: entries.slice(7).reduce((a, e) => a + e.value, 0), i: -1 }];
  const href = (e: { i: number }) => (e.i >= 0 ? (link?.(e.i, 0) ?? null) : null);
  const total = entries.reduce((a, e) => a + e.value, 0);
  // the area of the triangle above height h grows with h², so a share c ends at sqrt(c)
  let cum = 0;
  const share = (e: { value: number }) => `${((e.value / total) * 100).toFixed(0)}%`;
  const segments = entries.map((e, k) => {
    const h0 = Math.sqrt(cum / total) * 100;
    cum += e.value;
    const h1 = Math.sqrt(cum / total) * 100;
    const pts = [[50 - h0 / 2, h0], [50 + h0 / 2, h0], [50 + h1 / 2, h1], [50 - h1 / 2, h1]].map((p) => p.map((c) => c.toFixed(3)).join(',')).join(' ');
    let seg = html`<polygon class="pyramid-seg s${k + 1}" points="${pts}" vector-effect="non-scaling-stroke"><title>${e.label}: ${fmt.format(e.value)} (${share(e)})</title></polygon>`;
    const h = href(e);
    if (h) seg = html`<a class="drill" ${h} tabindex="-1">${seg}</a>`;
    return seg;
  });
  return html`<div class="chart-donut chart-pyramid-body">
    <div class="pyramid-figure"><svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${segments}</svg></div>
    <ul class="chart-legend donut-legend">${entries.map((e, k) => {
      const inner = html`<span class="swatch s${k + 1}"></span><span class="lg-label">${e.label}</span><span class="lg-value">${fmt.format(e.value)} · ${share(e)}</span>`;
      const h = href(e);
      return html`<li data-tip="${e.label}: ${fmt.format(e.value)}">${h ? html`<a class="drill" ${h}>${inner}</a>` : inner}</li>`;
    })}</ul>
  </div>`;
}

function population(labels: string[], series: Series[]) {
  // Rows top to bottom in the query's order (sort the oldest group first); one scale for
  // both sides. Negative values count as their size, so data with one side negative works too.
  const max = Math.max(...series.flatMap((s) => s.values.map(Math.abs)), 1e-9);
  const side = (i: number, si: number) => {
    const v = series[si].values[i];
    const b = html`<span class="pop-bar s${si + 1} ${css.cls(`width:${pct((Math.abs(v) / max) * 100)}`)}"></span>`;
    return mark('span', i, si, `pop-track ${si ? 'right' : 'left'}`, `${labels[i]} · ${series[si].name}: ${fmt.format(v)}`, b);
  };
  return html`<div class="chart-population">${labels.map(
    (l, i) => html`<div class="pop-row">${side(i, 0)}<span class="pop-label" title="${l}">${l}</span>${side(i, 1)}</div>`,
  )}<div class="pop-row pop-scale" aria-hidden="true"><span class="pop-track left"><span>${compact.format(max)}</span><span>0</span></span><span class="pop-label"></span><span class="pop-track right"><span>0</span><span>${compact.format(max)}</span></span></div></div>`;
}

// ---------------------------------------------------------------- polar
function polar(labels: string[], series: Series[]) {
  // A polar area (rose) chart: one equal sector per row (up to 24) from 12 o'clock
  // clockwise, split between the series; the radius grows linearly with the value.
  const n = Math.min(labels.length, 24);
  const m = series.length;
  const scale = niceScale(0, Math.max(...series.flatMap((s) => s.values.slice(0, n)), 0));
  const R = 36;
  const at = (a: number, r: number) => [50 + r * Math.cos(a), 50 + r * Math.sin(a)].map((c) => c.toFixed(3)).join(',');
  const radius = (v: number) => (Math.max(0, v) / scale.hi) * R;
  const slice = (2 * Math.PI) / n;
  const start = (k: number) => -Math.PI / 2 + k * slice;
  const sectors = labels.slice(0, n).map((l, k) =>
    series.map((s, si) => {
      const v = s.values[k];
      const r = radius(v);
      if (r <= 0) return '';
      const a0 = start(k) + (si * slice) / m;
      const a1 = a0 + slice / m;
      const shape =
        a1 - a0 >= 2 * Math.PI - 1e-9
          ? html`<circle class="polar-sector s${si + 1}" cx="50" cy="50" r="${r.toFixed(3)}"><title>${tip(l, [s], k)}</title></circle>`
          : html`<path class="polar-sector s${si + 1}" d="${`M50,50 L${at(a0, r)} A${r.toFixed(3)},${r.toFixed(3)} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${at(a1, r)} Z`}"><title>${m === 1 ? tip(l, series, k) : `${l} · ${s.name}: ${fmt.format(v)}`}</title></path>`;
      const h = link?.(k, si) ?? null;
      return h ? html`<a class="drill" ${h} tabindex="-1">${shape}</a>` : shape;
    }),
  );
  const rings = scale.ticks.filter((t) => t > 0).map((t) => html`<circle class="radar-ring" cx="50" cy="50" r="${radius(t).toFixed(3)}"></circle>`);
  const spokes = n > 1 ? labels.slice(0, n).map((_, k) => html`<line class="radar-spoke" x1="50" y1="50" x2="${at(start(k), R).split(',')[0]}" y2="${at(start(k), R).split(',')[1]}"></line>`) : '';
  const axisLabels = labels.slice(0, n).map((l, k) => {
    const a = start(k) + slice / 2;
    const x = 50 + (R + 6) * Math.cos(a);
    const y = 50 + (R + 6) * Math.sin(a);
    const sideCls = Math.abs(x - 50) < 2 ? 'mid' : x < 50 ? 'left' : 'right';
    return mark('span', k, m === 1 ? 0 : null, `radar-label ${sideCls} ${css.cls(`left:${pct(x)};top:${pct(y)}`)}`, tip(l, series, k), l);
  });
  const ticks = scale.ticks.filter((t) => t > 0).map((t) => html`<span class="radar-tick ${css.cls(`top:${pct(50 - radius(t))}`)}">${compact.format(t)}</span>`);
  return html`<div class="chart-radar"><div class="radar-figure">
    <svg viewBox="0 0 100 100" aria-hidden="true">${rings}${sectors}${spokes}</svg>
    <span aria-hidden="true">${ticks}</span>
    ${axisLabels}
  </div></div>`;
}

// ---------------------------------------------------------------- gantt
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * A date or timestamp from the database (the pg driver hands them over as text) in
 * milliseconds, its wall clock read as UTC: timestamptz values are already in the
 * session's time zone, so every row and the axis use the same clock. NaN when it is none.
 */
export function wallClock(v: unknown): number {
  if (v === null || v === undefined || v === '') return NaN;
  if (v instanceof Date) return v.getTime();
  const m = /^(\d{4,})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?)?/.exec(String(v).trim());
  if (!m) return NaN;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0), m[7] ? Math.round(Number(m[7]) * 1000) : 0);
  return Number.isFinite(t) ? t : NaN;
}

/**
 * The wall clock time in a time zone as "UTC" milliseconds, like wallClock() reads the
 * timestamps a query returns (the session's TimeZone): a Gantt chart's "today" line.
 */
export function wallClockIn(zone: string | null | undefined, at = new Date()): number {
  try {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone: zone || 'UTC', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
        .formatToParts(at)
        .map((x) => [x.type, x.value]),
    );
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  } catch {
    return at.getTime();
  }
}

type Unit = 'hour' | 'day' | 'week' | 'month' | 'year';
const STEPS: [Unit, number, number][] = [
  ['hour', 1, HOUR], ['hour', 2, 2 * HOUR], ['hour', 3, 3 * HOUR], ['hour', 6, 6 * HOUR], ['hour', 12, 12 * HOUR],
  ['day', 1, DAY], ['day', 2, 2 * DAY], ['week', 1, 7 * DAY], ['week', 2, 14 * DAY],
  ['month', 1, 30 * DAY], ['month', 2, 61 * DAY], ['month', 3, 91 * DAY], ['month', 6, 182 * DAY],
  ['year', 1, 365 * DAY], ['year', 2, 730 * DAY], ['year', 5, 1826 * DAY], ['year', 10, 3652 * DAY], ['year', 25, 9131 * DAY], ['year', 100, 36524 * DAY],
];

/** The time axis: the range snapped to whole units, and at most ~10 ticks on unit boundaries. */
export function timeScale(lo: number, hi: number) {
  if (hi <= lo) {
    lo -= DAY / 2;
    hi += DAY / 2;
  }
  // hours only within about a day and a half (their labels show no date)
  const [unit, step] = STEPS.find(([u, , ms]) => (hi - lo) / ms <= 10 && (u !== 'hour' || hi - lo <= 1.5 * DAY)) ?? STEPS[STEPS.length - 1];
  const floor = (t: number) => {
    const d = new Date(t);
    const y = d.getUTCFullYear();
    const mo = d.getUTCMonth();
    const day = d.getUTCDate();
    switch (unit) {
      case 'hour':
        return Date.UTC(y, mo, day, Math.floor(d.getUTCHours() / step) * step);
      case 'day':
        return Date.UTC(y, mo, day);
      case 'week':
        return Date.UTC(y, mo, day - ((d.getUTCDay() + 6) % 7)); // Monday
      case 'month':
        return Date.UTC(y, Math.floor(mo / step) * step, 1);
      default:
        return Date.UTC(Math.floor(y / step) * step, 0, 1);
    }
  };
  const next = (t: number) => {
    const d = new Date(t);
    if (unit === 'hour') return t + step * HOUR;
    if (unit === 'day') return t + step * DAY;
    if (unit === 'week') return t + step * 7 * DAY;
    if (unit === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + step, 1);
    return Date.UTC(d.getUTCFullYear() + step, 0, 1);
  };
  const ticks = [floor(lo)];
  while (ticks[ticks.length - 1] < hi) ticks.push(next(ticks[ticks.length - 1]));
  return { lo: ticks[0], hi: ticks[ticks.length - 1], ticks, unit };
}

function dateFormat(opts: Intl.DateTimeFormatOptions) {
  try {
    return new Intl.DateTimeFormat(chartLang, { ...opts, timeZone: 'UTC' });
  } catch {
    return new Intl.DateTimeFormat('en', { ...opts, timeZone: 'UTC' });
  }
}

function gantt(title: string, rows: unknown[][], fields: { name: string }[], now: number) {
  // label, start, end (empty or equal to the start: a milestone); optional columns by name:
  // progress (0-100), task_id and depends_on (ids of the tasks it waits for: "3" or "3,4")
  if (fields.length < 3) return html`<p class="empty">${texts.noGantt}</p>`;
  const col = (name: string) => fields.findIndex((f, i) => i > 2 && f.name.toLowerCase() === name);
  const [cProgress, cId, cDeps] = [col('progress'), col('task_id'), col('depends_on')];
  const tasks = rows
    .map((r, i) => {
      const start = wallClock(r[1]);
      const end = wallClock(r[2]);
      const p = cProgress >= 0 && r[cProgress] !== null && r[cProgress] !== '' ? Number(r[cProgress]) : NaN;
      return { i, label: cell(r[0]), start, end: Number.isFinite(end) && end > start ? end : start, progress: Number.isFinite(p) ? Math.max(0, Math.min(100, p)) : null };
    })
    .filter((t) => Number.isFinite(t.start));
  if (!tasks.length) return html`<p class="empty">${texts.noGantt}</p>`;
  const first = Math.min(...tasks.map((t) => t.start));
  const last = Math.max(...tasks.map((t) => t.end));
  // a little room on the right, so a milestone on the last day is not cut in half
  const scale = timeScale(first, last + Math.max((last - first) * 0.03, HOUR));
  const x = (t: number) => ((t - scale.lo) / (scale.hi - scale.lo)) * 100;
  const n = tasks.length;
  // a date, with its time when it is not midnight
  const dateOnly = dateFormat({ dateStyle: 'medium' });
  const dateTime = dateFormat({ dateStyle: 'medium', timeStyle: 'short' });
  const when = { format: (t: number) => (t % DAY ? dateTime.format(t) : dateOnly.format(t)) };
  const tickFmt = dateFormat(
    scale.unit === 'hour' ? { hour: '2-digit', minute: '2-digit' } : scale.unit === 'month' ? { month: 'short', year: '2-digit' } : scale.unit === 'year' ? { year: 'numeric' } : { day: 'numeric', month: 'short' },
  );
  const span = (t: (typeof tasks)[number]) => (t.end > t.start ? `${when.format(t.start)} – ${when.format(t.end)}` : when.format(t.start));
  const tipOf = (t: (typeof tasks)[number]) => `${t.label}: ${span(t)}${t.progress === null ? '' : ` · ${fmt.format(t.progress)}%`}`;

  // dependencies: from the end of each task it waits for to its start (elbow lines in row units)
  const byId = new Map<string, number>();
  if (cId >= 0) tasks.forEach((t, k) => byId.set(cell(rows[t.i][cId]), k));
  const deps: [number, number][] = [];
  if (cId >= 0 && cDeps >= 0)
    tasks.forEach((t, k) => {
      for (const id of cell(rows[t.i][cDeps]).replace(/[{}"]/g, '').split(/[,;\s]+/)) {
        const from = id ? byId.get(id) : undefined;
        if (from !== undefined && from !== k) deps.push([from, k]);
      }
    });
  const lines = deps.map(([a, b]) => {
    const xa = x(tasks[a].end);
    const xb = x(tasks[b].start);
    const elbow = Math.min(xa + 1.2, 100);
    return html`<path class="gantt-dep" d="${`M${xa.toFixed(3)},${a + 0.5} H${elbow.toFixed(3)} V${b + 0.5} H${xb.toFixed(3)}`}" vector-effect="non-scaling-stroke"></path>`;
  });
  const arrows = [...new Set(deps.map(([, b]) => b))].map(
    (b) => html`<span class="gantt-arrow ${css.cls(`left:${pct(x(tasks[b].start))};top:${pct(((b + 0.5) / n) * 100)}`)}"></span>`,
  );

  const lanes = tasks.map((t) => {
    if (t.end === t.start) return html`<div class="gantt-lane">${mark('span', t.i, null, `gantt-milestone s1 ${css.cls(`left:${pct(x(t.start))}`)}`, tipOf(t), '')}</div>`;
    const geo = css.cls(`left:${pct(x(t.start))};width:${pct(x(t.end) - x(t.start))}`);
    const done = t.progress === null ? '' : html`<span class="gantt-progress ${css.cls(`width:${pct(t.progress)}`)}"></span>`;
    return html`<div class="gantt-lane">${mark('span', t.i, null, `gantt-bar s1${t.progress === null ? '' : ' partial'} ${geo}`, tipOf(t), done)}</div>`;
  });
  const everyTick = Math.ceil(scale.ticks.length / 8);
  const today = now >= scale.lo && now <= scale.hi ? html`<span class="gantt-today ${css.cls(`left:${pct(x(now))}`)}" title="${texts.today}"></span>` : '';
  const head = (k: number) => fields[k]?.name ?? '';
  return html`<div class="gantt">
    <span class="gantt-corner">${head(0)}</span>
    <div class="gantt-axis" aria-hidden="true">${scale.ticks.slice(0, -1).map(
      // every other shown label is "odd": hidden on narrow screens (app.css)
      (t, k) => html`<span class="${k % everyTick ? 'skip ' : (k / everyTick) % 2 ? 'odd ' : ''}${css.cls(`left:${pct(x(t))}`)}">${tickFmt.format(t)}</span>`,
    )}</div>
    <ul class="gantt-labels" aria-hidden="true">${tasks.map((t) => html`<li title="${t.label}">${t.label}</li>`)}</ul>
    <div class="gantt-plot">
      ${scale.ticks.map((t) => html`<span class="gantt-grid ${css.cls(`left:${pct(x(t))}`)}" aria-hidden="true"></span>`)}
      ${today}
      ${lines.length ? html`<svg class="gantt-deps" viewBox="0 0 100 ${n}" preserveAspectRatio="none" aria-hidden="true">${lines}</svg>${arrows}` : ''}
      ${lanes}
    </div>
  </div>
  <details class="chart-data"><summary>${texts.table}</summary>
    <div class="table-wrap"><table class="report">
      <caption class="sr-only">${title}</caption>
      <thead><tr><th scope="col">${head(0)}</th><th scope="col">${head(1)}</th><th scope="col">${head(2)}</th>${cProgress >= 0 ? html`<th scope="col" class="num">${head(cProgress)}</th>` : ''}${cDeps >= 0 ? html`<th scope="col">${head(cDeps)}</th>` : ''}</tr></thead>
      <tbody>${tasks.map((t) => {
        const l = link?.(t.i, null);
        return html`<tr><th scope="row">${l ? html`<a ${l}>${t.label}</a>` : t.label}</th><td>${when.format(t.start)}</td><td>${t.end > t.start ? when.format(t.end) : ''}</td>${cProgress >= 0 ? html`<td class="num">${t.progress === null ? '' : `${fmt.format(t.progress)}%`}</td>` : ''}${cDeps >= 0 ? html`<td>${cell(rows[t.i][cDeps])}</td>` : ''}</tr>`;
      })}</tbody>
    </table></div></details>`;
}

/** A chart's markup; its geometry goes into `sheet` as classes (no inline styles: see css.ts). */
export function renderChartBody(kind: ChartKind, title: string, rows: unknown[][], fields: { name: string }[], sheet: PageCss, lang = 'en', t?: Translate, opts: ChartOptions = {}): Raw {
  css = sheet;
  chartLang = lang;
  link = opts.link;
  if (opts.format) fmt = { format: opts.format };
  try {
    const intl = new Intl.NumberFormat(lang, { maximumFractionDigits: 2 });
    if (!opts.format) fmt = intl;
    compact = new Intl.NumberFormat(lang, { notation: 'compact', maximumFractionDigits: 1 });
  } catch {
    // unknown locale: keep the previous formats
  }
  if (t)
    texts = {
      ...texts, table: t('chart.table'), other: t('chart.other'), label: t('chart.label'), noBubble: t('chart.no_bubble'), noRadar: t('chart.no_radar'),
      good: t('chart.status_good'), warning: t('chart.status_warning'), critical: t('chart.status_critical'), ofFirst: t('chart.of_first'), size: t('chart.size'),
      noGantt: t('chart.no_gantt'), noData: t('chart.no_data'), today: t('chart.today'),
    };
  // a Gantt chart reads its date columns itself (its series are not numbers)
  if (kind === 'gantt')
    return html`<figure class="chart chart-gantt" aria-label="${title}">${gantt(title, rows, fields, opts.now ?? Date.now())}</figure>`;
  const { labels, series } = parse(rows, fields, opts.hidden);
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
    case 'bubble':
      body = bubble(labels, series);
      break;
    case 'gauge':
      body = gauge(labels, series, opts.gauge ?? {});
      break;
    case 'funnel':
      body = funnel(labels, series);
      break;
    case 'radar':
      body = radar(labels, series);
      break;
    case 'pyramid':
      body = pyramid(labels, series);
      break;
    case 'polar':
      body = polar(labels, series);
      break;
    default:
      body = bar(labels, series);
  }
  return html`<figure class="chart chart-${kind}" aria-label="${title}">
    ${['donut', 'pie', 'bubble', 'gauge', 'funnel'].includes(kind) || (kind === 'pyramid' && series.length < 2) ? '' : legend(kind === 'pyramid' ? series.slice(0, 2) : series)}
    ${body}
    ${dataTable(title, labels, kind === 'gauge' || kind === 'funnel' ? series.slice(0, 1) : kind === 'pyramid' ? series.slice(0, 2) : series, fields[0]?.name ?? texts.label, kind === 'bubble')}
  </figure>`;
}
