import { existsSync } from 'node:fs';
import PDFDocument from 'pdfkit';
import type pg from 'pg';
import type { Region } from '../metadata.ts';
import { runtime, savepoint } from '../db.ts';
import { substitute, type PageContext } from './context.ts';
import { describeFacetFilter, facetFilters, reportFacetDefs } from './facet-state.ts';
import { buildSql, cell, headingOf, isNumeric, OPERATORS, reportState, visibleColumns } from './report.ts';

// Report printing: Actions → Download PDF. The same query, filters, sort
// and visibility as the report on screen (and as the CSV download), drawn
// with a report layout (Shared Components → Report layouts): paper,
// orientation, font size, margins, texts, colors and a logo.
//
// The standard PDF fonts cover Western European text (Windows-1252). For
// other scripts set PDF_FONT (and PDF_FONT_BOLD) to TrueType fonts, e.g.
// DejaVuSans.ttf / DejaVuSans-Bold.ttf.

const PDF_MAX_ROWS = Number(process.env.PDF_MAX_ROWS ?? 5000);
const FONT = process.env.PDF_FONT && existsSync(process.env.PDF_FONT) ? process.env.PDF_FONT : null;
const FONT_BOLD = process.env.PDF_FONT_BOLD && existsSync(process.env.PDF_FONT_BOLD) ? process.env.PDF_FONT_BOLD : FONT;

const MM = 72 / 25.4;
const PAD = 3;
const MAX_CELL_HEIGHT = 160;
/** portrait width × height in points */
export const PAPER: Record<string, [number, number]> = {
  A3: [841.89, 1190.55],
  A4: [595.28, 841.89],
  A5: [419.53, 595.28],
  LETTER: [612, 792],
  LEGAL: [612, 1008],
};

export interface PdfLayout {
  name?: string;
  paper: string;
  orientation: 'auto' | 'portrait' | 'landscape';
  font_size: number;
  margin_mm: number;
  title: string | null;
  header: string | null;
  footer: string | null;
  show_filters: boolean;
  full_width: boolean;
  heading_color: string;
  stripe_color: string | null;
  text_color: string;
  logo: Buffer | null;
  logo_width_mm: number;
}

/** The built-in look, used when an application has no report layouts. */
export const BUILT_IN: PdfLayout = {
  paper: 'A4',
  orientation: 'auto',
  font_size: 8.5,
  margin_mm: 13,
  title: '&REPORT_TITLE.',
  header: null,
  footer: null,
  show_filters: true,
  full_width: false,
  heading_color: '#e8ecf2',
  stripe_color: '#f6f7f9',
  text_color: '#111111',
  logo: null,
  logo_width_mm: 30,
};

export type Align = 'left' | 'center' | 'right';

/** What a report region may say about printing: {"pdf": {...}} in its settings. */
interface RegionPdf {
  layout?: string;
  columns?: string[];
  /** column widths in millimetres */
  widths?: Record<string, number>;
  align?: Record<string, Align>;
}

/** A printable table, already formatted as text. */
export interface PdfTable {
  title: string;
  header: string;
  footer: string;
  filters: string[];
  note: string | null;
  headings: string[];
  rows: string[][];
  align: Align[];
  /** fixed widths in points (null = from the content) */
  widths: (number | null)[];
  noData: string;
  pageLabel: (page: number, pages: number) => string;
  info: { Title: string; Author: string };
}

// characters the standard fonts can show (Windows-1252)
const CP1252 = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
export const printable = (s: string) =>
  FONT ? s : s.replace(/[^\x20-\x7e\xa0-\xff\n]/g, (ch) => (CP1252.has(ch) ? ch : ch === '\t' ? ' ' : ch === '✓' ? 'Yes' : ch === '✗' ? 'No' : '?'));
const oneLine = (s: string) => s.replace(/\s*\n\s*/g, ' ');

/** Readable text on a background: white on dark colors, the layout's text color otherwise. */
export function textOn(background: string, text: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(background.slice(i, i + 2), 16) / 255);
  const lum = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lum(r) + 0.7152 * lum(g) + 0.0722 * lum(b) < 0.4 ? '#ffffff' : text;
}

/** The layout a report prints with: its own, else the app's default, else the built-in one. */
export async function layoutFor(appId: number, name: string | undefined): Promise<PdfLayout> {
  const res = await runtime.query<PdfLayout>(
    `select name, paper, orientation, font_size::float8 as font_size, margin_mm, title, header, footer, show_filters, full_width,
            heading_color, stripe_color, text_color, logo, logo_width_mm
       from meta.report_layout
      where app_id = $1 and (name = upper($2) or is_default)
      order by (name = upper($2)) desc nulls last
      limit 1`,
    [appId, name ?? null],
  );
  return res.rows[0] ?? BUILT_IN;
}

/** Layout texts: &REPORT_TITLE., &APP_NAME., &DATE., &TIMESTAMP. plus the usual substitutions. */
export function layoutText(text: string, extra: Record<string, string>, ctx?: PageContext) {
  const replaced = text.replace(/&(REPORT_TITLE|APP_NAME|DATE|TIMESTAMP)\./gi, (_m, n: string) => extra[n.toUpperCase()] ?? '');
  return ctx ? substitute(replaced, ctx, (v) => v) : replaced;
}

/** The columns a report prints, in order: its "pdf.columns", or those on screen. */
function printColumns(r: Region, fields: pg.FieldDef[]) {
  const wanted = (r.config.pdf as RegionPdf | undefined)?.columns;
  if (!Array.isArray(wanted) || !wanted.length) return visibleColumns(r, fields);
  const byName = new Map(fields.map((f, i) => [f.name.toLowerCase(), { f, i }]));
  return wanted.flatMap((n) => {
    const c = typeof n === 'string' ? byName.get(n.toLowerCase()) : undefined;
    return c && !c.f.name.startsWith('__') ? [c] : [];
  });
}

/** The report as a PDF, with its report layout. */
export async function reportPdf(ctx: PageContext, r: Region): Promise<Buffer> {
  const t = ctx.locale.t;
  const st = reportState(ctx, r);
  const cfg = (r.config.pdf ?? {}) as RegionPdf;
  const layout = await layoutFor(ctx.app.id, typeof cfg.layout === 'string' ? cfg.layout : undefined);
  const c = ctx.client!;
  const res = await savepoint(c, async () => c.query({ ...(await buildSql(ctx, r, st, 'pdf')), rowMode: 'array' }));
  const cols = printColumns(r, res.fields);
  const lower = (m: Record<string, unknown> | undefined) => new Map(Object.entries(m ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const widths = lower(cfg.widths);
  const aligns = lower(cfg.align);
  const now = new Date().toISOString();
  const reportTitle = r.title ?? ctx.page.title ?? ctx.page.name;
  const extra = { REPORT_TITLE: reportTitle, APP_NAME: ctx.app.name, DATE: now.slice(0, 10), TIMESTAMP: `${now.slice(0, 16).replace('T', ' ')} UTC` };
  const text = (s: string) => printable(layoutText(s, extra, ctx));
  const title = text(layout.title ?? '&REPORT_TITLE.');
  const filters = layout.show_filters
    ? [
        ...st.filters.map((f) => `${headingOf(r, f.column, ctx.locale.tr)} ${OPERATORS[f.op]?.label ?? f.op} ${OPERATORS[f.op]?.noValue ? '' : f.value}`.trim()),
        ...(() => {
          const defs = reportFacetDefs(ctx.page.regions, r.id, ctx.vis?.regions);
          return facetFilters(ctx.params, r.id, defs).map((f) => describeFacetFilter(f, defs.get(f.column)?.label ?? headingOf(r, f.column, ctx.locale.tr), t, defs.get(f.column)));
        })(),
        ...(st.search ? [`${t('report.search')}: "${st.search}"`] : []),
      ].map((s) => printable(oneLine(s)))
    : [];
  return tablePdf(
    {
      title,
      header: layout.header === null ? printable(`${ctx.app.name} · ${extra.TIMESTAMP} · ${ctx.user}`) : text(layout.header),
      footer: layout.footer === null ? title : text(layout.footer),
      filters: filters.length ? [`${t('facets.title')}: ${filters.join('; ')}`] : [],
      note: res.rows.length > PDF_MAX_ROWS ? t('pdf.truncated', { rows: String(PDF_MAX_ROWS) }) : null,
      headings: cols.map(({ f }) => printable(oneLine(headingOf(r, f.name, ctx.locale.tr)))),
      rows: res.rows.slice(0, PDF_MAX_ROWS).map((row) =>
        cols.map(({ f, i }) => {
          const v = row[i];
          return printable(typeof v === 'boolean' ? (v ? t('item.yes') : t('item.no')) : cell(v, f.dataTypeID, ctx.locale.format));
        }),
      ),
      align: cols.map(({ f }) => {
        const a = aligns.get(f.name.toLowerCase());
        return a === 'left' || a === 'center' || a === 'right' ? a : isNumeric(f.dataTypeID) ? 'right' : 'left';
      }),
      widths: cols.map(({ f }) => {
        const w = Number(widths.get(f.name.toLowerCase()));
        return w > 0 ? Math.min(w, 500) * MM : null;
      }),
      noData: t('report.no_data'),
      pageLabel: (page, pages) => t('pdf.page', { page: String(page), pages: String(pages) }),
      info: { Title: title, Author: ctx.user },
    },
    layout,
  );
}

/** Draw a table as a PDF: title block, repeated headings, footer and page numbers. */
export async function tablePdf(tb: PdfTable, layout: PdfLayout): Promise<Buffer> {
  const margin = layout.margin_mm * MM;
  const size = layout.font_size;
  const [pw, ph] = PAPER[layout.paper] ?? PAPER.A4;
  const doc = new PDFDocument({ size: [pw, ph], margin, bufferPages: true, autoFirstPage: false, info: { ...tb.info, Creator: 'pgapex' } });
  const chunks: Buffer[] = [];
  doc.on('data', (b: Buffer) => chunks.push(b));
  const finished = new Promise<void>((resolve, reject) => {
    doc.on('end', resolve);
    doc.on('error', reject);
  });
  const regular = () => (FONT ? doc.font(FONT) : doc.font('Helvetica'));
  const bold = () => (FONT_BOLD ? doc.font(FONT_BOLD) : doc.font('Helvetica-Bold'));

  // column widths: fixed ones as given; the others from the heading and the
  // first 200 rows (capped), scaled down to the page; text wraps in the cell
  doc.fontSize(size);
  const natural = tb.headings.map((h, ci) => {
    const fixed = tb.widths[ci];
    if (fixed) return fixed;
    bold();
    let w = doc.widthOfString(h);
    regular();
    for (const row of tb.rows.slice(0, 200)) w = Math.max(w, ...row[ci].split('\n').map((line) => doc.widthOfString(line)));
    return Math.min(Math.max(w + 2 * PAD + 1, 28), 220 * (size / 8.5));
  });
  const total = natural.reduce((a, b) => a + b, 0) || 1;
  const landscape = layout.orientation === 'landscape' || (layout.orientation === 'auto' && total > pw - 2 * margin);
  const [pageW, pageH] = landscape ? [ph, pw] : [pw, ph];
  const usable = pageW - 2 * margin;
  let widths = natural;
  if (total > usable) {
    // shrink the content-sized columns first; fixed widths only when that is not enough
    const fixedTotal = tb.widths.reduce<number>((a, w) => a + (w ?? 0), 0);
    const free = total - fixedTotal;
    widths =
      fixedTotal < usable && free > 0
        ? natural.map((w, ci) => (tb.widths[ci] ? w : (w * (usable - fixedTotal)) / free))
        : natural.map((w) => (w * usable) / total);
  } else if (layout.full_width) {
    // widen the content-sized columns to fill the page
    const fixedTotal = tb.widths.reduce<number>((a, w) => a + (w ?? 0), 0);
    const free = total - fixedTotal;
    widths = free > 0 ? natural.map((w, ci) => (tb.widths[ci] ? w : (w * (usable - fixedTotal)) / free)) : natural;
  }
  const tableWidth = widths.reduce((a, b) => a + b, 0);
  const newPage = () => doc.addPage({ size: [pw, ph], layout: landscape ? 'landscape' : 'portrait', margin });
  newPage();
  const footerHeight = size + 6;
  const bottom = () => pageH - margin - footerHeight;

  // title block, with the logo at the top right
  let logoBottom = margin;
  let textWidth = usable;
  if (layout.logo) {
    const lw = Math.min(layout.logo_width_mm * MM, usable / 2);
    try {
      // openImage is missing from @types/pdfkit
      const img = (doc as unknown as { openImage(src: Buffer): { width: number; height: number } }).openImage(layout.logo);
      const lh = (img.height / img.width) * lw;
      doc.image(img as unknown as Buffer, margin + usable - lw, margin, { width: lw });
      logoBottom = margin + lh;
      textWidth = usable - lw - 12;
    } catch {
      // not a readable PNG/JPEG: print without it
    }
  }
  bold().fontSize(size + 5.5).fillColor(layout.text_color).text(tb.title, margin, margin, { width: textWidth });
  regular().fontSize(size).fillColor('#555555');
  if (tb.header) doc.text(tb.header, { width: textWidth });
  for (const line of tb.filters) doc.text(line, { width: textWidth });
  if (tb.note) doc.text(tb.note, { width: textWidth });
  doc.y = Math.max(doc.y, logoBottom);
  doc.moveDown(0.8);

  const rowHeight = (cells: string[], font: () => unknown) => {
    font();
    doc.fontSize(size);
    return Math.min(Math.max(...cells.map((v, ci) => doc.heightOfString(v || ' ', { width: widths[ci] - 2 * PAD }))), MAX_CELL_HEIGHT) + 2 * PAD;
  };
  const drawRow = (cells: string[], y: number, h: number, head: boolean, shade: boolean) => {
    if (head) doc.rect(margin, y, tableWidth, h).fill(layout.heading_color);
    else if (shade && layout.stripe_color) doc.rect(margin, y, tableWidth, h).fill(layout.stripe_color);
    (head ? bold : regular)();
    doc.fontSize(size).fillColor(head ? textOn(layout.heading_color, layout.text_color) : layout.text_color);
    let x = margin;
    cells.forEach((v, ci) => {
      doc.text(v, x + PAD, y + PAD, { width: widths[ci] - 2 * PAD, height: h - 2 * PAD, align: tb.align[ci], ellipsis: true, lineBreak: true });
      x += widths[ci];
    });
    doc.moveTo(margin, y + h).lineTo(x, y + h).lineWidth(0.4).strokeColor('#c9ced6').stroke();
  };

  if (tb.headings.length) {
    const headHeight = rowHeight(tb.headings, bold);
    let y = doc.y;
    drawRow(tb.headings, y, headHeight, true, false);
    y += headHeight;
    if (!tb.rows.length) regular().fontSize(size).fillColor('#555555').text(tb.noData, margin, y + PAD);
    tb.rows.forEach((cells, ri) => {
      const h = rowHeight(cells, regular);
      if (y + h > bottom()) {
        newPage();
        y = margin;
        drawRow(tb.headings, y, headHeight, true, false);
        y += headHeight;
      }
      drawRow(cells, y, h, false, ri % 2 === 1);
      y += h;
    });
  } else regular().fontSize(size).fillColor('#555555').text(tb.noData, margin, doc.y);

  // footer on every page: the footer text and "page n of m"
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    const saved = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // writing below the margin must not add pages
    regular().fontSize(Math.max(size - 1, 5)).fillColor('#777777');
    const fy = pageH - margin - footerHeight + 6;
    doc.text(oneLine(tb.footer), margin, fy, { width: usable * 0.7, lineBreak: false, ellipsis: true });
    doc.text(tb.pageLabel(i + 1, range.count), margin + usable * 0.7, fy, { width: usable * 0.3, align: 'right', lineBreak: false });
    doc.page.margins.bottom = saved;
  }
  doc.end();
  await finished;
  return Buffer.concat(chunks);
}

/** A sample report in a layout (Shared Components → Report layouts → Preview). */
export function layoutPreview(layout: PdfLayout, appName: string, user: string) {
  const now = new Date().toISOString();
  const extra = { REPORT_TITLE: 'Orders (sample)', APP_NAME: appName, DATE: now.slice(0, 10), TIMESTAMP: `${now.slice(0, 16).replace('T', ' ')} UTC` };
  // items and &APP_USER. have no session here: show the names
  const text = (s: string) => printable(layoutText(s, extra).replace(/&APP_USER\./gi, user));
  const title = text(layout.title ?? '&REPORT_TITLE.');
  // made-up sample rows, so the preview shows the layout without any application's data
  const customers = ['Acme', 'Globex', 'Initech', 'Umbrella', 'Hooli', 'Stark', 'Wayne', 'Wonka', 'Tyrell', 'Soylent'];
  const statuses = ['Open', 'Shipped', 'Invoiced', 'Paid'];
  const rows = Array.from({ length: 60 }, (_, i) => [
    String(1001 + i),
    `${customers[i % customers.length]}${i >= customers.length ? ` ${Math.floor(i / customers.length) + 1}` : ''}`,
    statuses[i % statuses.length],
    `2026-0${(i % 9) + 1}-1${i % 10}`,
    (80 + ((i * 1371) % 9200) / 3).toFixed(2),
    ['North', 'South', 'East', 'West'][i % 4],
  ]);
  return tablePdf(
    {
      title,
      header: layout.header === null ? printable(`${appName} · ${extra.TIMESTAMP} · ${user}`) : text(layout.header),
      footer: layout.footer === null ? title : text(layout.footer),
      filters: layout.show_filters ? ['Filters: Region = North (example)'] : [],
      note: null,
      headings: ['Order', 'Customer', 'Status', 'Ordered', 'Amount', 'Region'],
      rows,
      align: ['right', 'left', 'left', 'left', 'right', 'left'],
      widths: [null, null, null, null, null, null],
      noData: 'No data found',
      pageLabel: (p, n) => `Page ${p} of ${n}`,
      info: { Title: title, Author: user },
    },
    layout,
  );
}
