import { existsSync } from 'node:fs';
import PDFDocument from 'pdfkit';
import type { Region } from '../metadata.ts';
import { savepoint } from '../db.ts';
import type { PageContext } from './context.ts';
import { buildSql, cell, facetSelections, headingOf, isNumeric, OPERATORS, reportState, visibleColumns } from './report.ts';

// Report printing: Actions → Download PDF. The same query, filters, sort
// and visibility as the report on screen (and as the CSV download).
//
// The standard PDF fonts cover Western European text (Windows-1252). For
// other scripts set PDF_FONT (and PDF_FONT_BOLD) to TrueType fonts, e.g.
// DejaVuSans.ttf / DejaVuSans-Bold.ttf.

const PDF_MAX_ROWS = Number(process.env.PDF_MAX_ROWS ?? 5000);
const FONT = process.env.PDF_FONT && existsSync(process.env.PDF_FONT) ? process.env.PDF_FONT : null;
const FONT_BOLD = process.env.PDF_FONT_BOLD && existsSync(process.env.PDF_FONT_BOLD) ? process.env.PDF_FONT_BOLD : FONT;

const MARGIN = 36;
const SIZE = 8.5;
const PAD = 3;
const MAX_CELL_HEIGHT = 160;
const A4 = { portrait: 595.28 - 2 * MARGIN, landscape: 841.89 - 2 * MARGIN };

// characters the standard fonts can show (Windows-1252)
const CP1252 = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
const printable = (s: string) =>
  FONT ? s : s.replace(/[^\x20-\x7e\xa0-\xff]/g, (ch) => (CP1252.has(ch) ? ch : ch === '\n' || ch === '\t' ? ' ' : ch === '✓' ? 'Yes' : ch === '✗' ? 'No' : '?'));

/** The report as a PDF (A4; landscape when the columns don't fit upright). */
export async function reportPdf(ctx: PageContext, r: Region): Promise<Buffer> {
  const t = ctx.locale.t;
  const st = reportState(ctx, r);
  const c = ctx.client!;
  const res = await savepoint(c, async () => c.query({ text: await buildSql(ctx, r, st, 'pdf'), rowMode: 'array' }));
  const cols = visibleColumns(r, res.fields);
  const headings = cols.map(({ f }) => printable(headingOf(r, f.name, ctx.locale.tr)));
  const rows = res.rows.slice(0, PDF_MAX_ROWS).map((row) =>
    cols.map(({ f, i }) => {
      const v = row[i];
      return printable(typeof v === 'boolean' ? (v ? t('item.yes') : t('item.no')) : cell(v, f.dataTypeID, ctx.locale.format));
    }),
  );
  const numeric = cols.map(({ f }) => isNumeric(f.dataTypeID));
  const title = printable(r.title ?? ctx.page.title ?? ctx.page.name);

  // no page yet: the orientation depends on the column widths
  const doc = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true, autoFirstPage: false, info: { Title: title, Author: ctx.user, Creator: 'pgapex' } });
  const chunks: Buffer[] = [];
  doc.on('data', (b: Buffer) => chunks.push(b));
  const finished = new Promise<void>((resolve, reject) => {
    doc.on('end', resolve);
    doc.on('error', reject);
  });
  const regular = () => (FONT ? doc.font(FONT) : doc.font('Helvetica'));
  const bold = () => (FONT_BOLD ? doc.font(FONT_BOLD) : doc.font('Helvetica-Bold'));

  // column widths: natural width (heading and the first 200 rows), capped,
  // then scaled down to the page; text wraps inside the cell
  doc.fontSize(SIZE);
  const natural = headings.map((h, ci) => {
    bold();
    let w = doc.widthOfString(h);
    regular();
    for (const row of rows.slice(0, 200)) w = Math.max(w, doc.widthOfString(row[ci]));
    return Math.min(Math.max(w + 2 * PAD + 1, 28), 220);
  });
  const total = natural.reduce((a, b) => a + b, 0) || 1;
  const landscape = total > A4.portrait;
  const usable = landscape ? A4.landscape : A4.portrait;
  const widths = total > usable ? natural.map((w) => (w * usable) / total) : natural;
  const newPage = () => doc.addPage({ size: 'A4', layout: landscape ? 'landscape' : 'portrait', margin: MARGIN });
  newPage();
  const bottom = () => doc.page.height - MARGIN - 14;

  // title block
  bold().fontSize(14).fillColor('#111').text(title, MARGIN, MARGIN);
  const filters = [
    ...st.filters.map((f) => `${printable(headingOf(r, f.column, ctx.locale.tr))} ${OPERATORS[f.op]?.label ?? f.op} ${OPERATORS[f.op]?.noValue ? '' : printable(f.value)}`.trim()),
    ...[...facetSelections(ctx, r)].map(([col, values]) => `${printable(headingOf(r, col, ctx.locale.tr))}: ${printable(values.join(', '))}`),
    ...(st.search ? [`${t('report.search')}: "${printable(st.search)}"`] : []),
  ];
  regular().fontSize(SIZE).fillColor('#555');
  doc.text(printable(`${ctx.app.name} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · ${ctx.user}`));
  if (filters.length) doc.text(`${t('facets.title')}: ${filters.join('; ')}`, { width: usable });
  if (res.rows.length > PDF_MAX_ROWS) doc.text(t('pdf.truncated', { rows: String(PDF_MAX_ROWS) }));
  doc.moveDown(0.8);

  const rowHeight = (cells: string[], font: () => unknown) => {
    font();
    doc.fontSize(SIZE);
    return Math.min(Math.max(...cells.map((v, ci) => doc.heightOfString(v || ' ', { width: widths[ci] - 2 * PAD }))), MAX_CELL_HEIGHT) + 2 * PAD;
  };
  const drawRow = (cells: string[], y: number, h: number, head: boolean, shade: boolean) => {
    if (head) doc.rect(MARGIN, y, widths.reduce((a, b) => a + b, 0), h).fill('#e8ecf2');
    else if (shade) doc.rect(MARGIN, y, widths.reduce((a, b) => a + b, 0), h).fill('#f6f7f9');
    (head ? bold : regular)();
    doc.fontSize(SIZE).fillColor('#111');
    let x = MARGIN;
    cells.forEach((v, ci) => {
      doc.text(v, x + PAD, y + PAD, { width: widths[ci] - 2 * PAD, height: h - 2 * PAD, align: numeric[ci] && !head ? 'right' : 'left', ellipsis: true, lineBreak: true });
      x += widths[ci];
    });
    doc.moveTo(MARGIN, y + h).lineTo(x, y + h).lineWidth(0.4).strokeColor('#c9ced6').stroke();
  };

  const headHeight = rowHeight(headings, bold);
  let y = doc.y;
  drawRow(headings, y, headHeight, true, false);
  y += headHeight;
  if (!rows.length) {
    regular().fontSize(SIZE).fillColor('#555').text(t('report.no_data'), MARGIN, y + PAD);
  }
  rows.forEach((cells, ri) => {
    const h = rowHeight(cells, regular);
    if (y + h > bottom()) {
      newPage();
      y = MARGIN;
      drawRow(headings, y, headHeight, true, false);
      y += headHeight;
    }
    drawRow(cells, y, h, false, ri % 2 === 1);
    y += h;
  });

  // footer on every page: title and "page n of m"
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    const saved = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // writing below the margin must not add pages
    regular().fontSize(7.5).fillColor('#777');
    const fy = doc.page.height - MARGIN + 4;
    doc.text(title, MARGIN, fy, { width: doc.page.width / 2, lineBreak: false, ellipsis: true });
    doc.text(t('pdf.page', { page: String(i + 1), pages: String(range.count) }), doc.page.width / 2, fy, {
      width: doc.page.width / 2 - MARGIN,
      align: 'right',
      lineBreak: false,
    });
    doc.page.margins.bottom = saved;
  }
  doc.end();
  await finished;
  return Buffer.concat(chunks);
}
