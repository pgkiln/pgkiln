// The download process's {"export": "<format>"} (migration 086, APEX:
// APEX_DATA_EXPORT): the process's query returns rows, and the file is
// those rows as CSV, JSON, XML or HTML (meta.data_export, in SQL) or as
// Excel or PDF (made here, as the report downloads make them).
import { applyBinds } from '../binds.ts';
import { savepoint } from '../db.ts';
import type { Process } from '../metadata.ts';
import { writeXlsx, XLSX_TYPE, type XlsxCell } from '../xlsx.ts';
import { bindValues, stripSemicolon, substitute, type PageContext } from './context.ts';
import { heading } from './items.ts';
import { layoutFor, printable, tablePdf } from './pdf.ts';
import { cell, isNumeric, xlsxCell } from './report.ts';
import { safeFileName, type Download } from './processes.ts';

export const EXPORT_FORMATS = ['csv', 'json', 'xml', 'html', 'xlsx', 'pdf'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
const TYPES: Record<ExportFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html; charset=utf-8',
  xlsx: XLSX_TYPE,
  pdf: 'application/pdf',
};
/** Excel and PDF hold at most this many rows (the rest is left out, with a note in the PDF). */
export const EXPORT_MAX_ROWS = 100_000;

export interface ExportConfig {
  export?: ExportFormat;
  /** the file's name without extension (&ITEM. substitutions); default: the process name */
  file_name?: string;
  /** the title of an HTML or PDF file (&ITEM. substitutions) */
  title?: string;
  /** a report layout for the PDF (Shared Components → Report layouts) */
  layout?: string;
  /** CSV: the separator (one character) */
  separator?: string;
}

export function exportProblems(c: ExportConfig): string[] {
  const out: string[] = [];
  if (c.export !== undefined && !EXPORT_FORMATS.includes(c.export)) out.push(`"export" is one of ${EXPORT_FORMATS.join(', ')}.`);
  for (const k of ['file_name', 'title', 'layout'] as const) if (c[k] !== undefined && typeof c[k] !== 'string') out.push(`"${k}" is text.`);
  if (c.separator !== undefined && !(typeof c.separator === 'string' && /^[^"\r\n]$/.test(c.separator))) out.push('"separator" is one character.');
  return out;
}

/** The process's rows as a file in the configured format. */
export async function exportDownload(ctx: PageContext, p: Process, conf: ExportConfig): Promise<Download> {
  const format = conf.export!;
  const sql = stripSemicolon(applyBinds(p.code ?? '', bindValues(ctx)));
  if (!sql) throw new Error(`Process "${p.name}" needs a query in its code.`);
  const text = (s: string | undefined) => (s ? substitute(s, ctx, (v) => v) : '');
  const name = `${safeFileName(text(conf.file_name) || p.name.toLowerCase(), 'export')}.${format}`;
  const title = text(conf.title) || p.name;
  const c = ctx.client!;
  if (format !== 'xlsx' && format !== 'pdf') {
    const opts = { title: format === 'html' ? title : undefined, separator: conf.separator };
    const r = await savepoint(c, () => c.query<{ f: Buffer }>('select meta.data_export($1, $2, $3) as f', [sql, format, JSON.stringify(opts)]));
    return { content: r.rows[0].f, name, type: TYPES[format], inline: false };
  }
  const res = await savepoint(c, () => c.query({ text: `select * from (\n${sql}\n) "__x" limit ${EXPORT_MAX_ROWS + 1}`, rowMode: 'array' }));
  const fields = res.fields;
  const rows = res.rows as unknown[][];
  const truncated = rows.length > EXPORT_MAX_ROWS;
  if (truncated) rows.length = EXPORT_MAX_ROWS;
  const headings = fields.map((f) => ctx.locale.tr(heading(f.name)));
  if (format === 'xlsx') {
    const cells: XlsxCell[][] = rows.map((r) => r.map((v, i) => xlsxCell(v, fields[i].dataTypeID)));
    return { content: writeXlsx({ name: title, headings, rows: cells }), name, type: TYPES.xlsx, inline: false };
  }
  const t = ctx.locale.t;
  const layout = await layoutFor(ctx.app.id, conf.layout);
  const now = new Date().toISOString();
  const content = await tablePdf(
    {
      title: printable(title),
      header: printable(`${ctx.app.name} · ${now.slice(0, 16).replace('T', ' ')} UTC · ${ctx.user}`),
      footer: printable(title),
      filters: [],
      note: null,
      endNote: () => (truncated ? printable(t('pdf.truncated', { rows: String(EXPORT_MAX_ROWS) })) : null),
      headings: headings.map(printable),
      rows: rows.map((r) => r.map((v, i) => printable(typeof v === 'boolean' ? (v ? t('item.yes') : t('item.no')) : cell(v, fields[i].dataTypeID)))),
      align: fields.map((f) => (isNumeric(f.dataTypeID) ? 'right' : 'left')),
      widths: fields.map(() => null),
      noData: t('report.no_data'),
      pageLabel: (page, pages) => t('pdf.page', { page: String(page), pages: String(pages) }),
      info: { Title: printable(title), Author: ctx.user },
    },
    layout,
  );
  return { content, name, type: TYPES.pdf, inline: false };
}
