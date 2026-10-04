import { strToU8, Zip, ZipDeflate } from 'fflate';

// A minimal Excel (.xlsx) writer: one sheet, a bold frozen heading row with
// an autofilter, and typed cells (numbers, booleans, dates and timestamps
// stay numbers/dates in Excel). Text is written as inline strings, which
// Excel never evaluates, so cells that look like formulas are harmless.

export type XlsxCell = string | number | boolean | null | { date: string; time?: boolean };

export interface XlsxSheet {
  name: string;
  headings: string[];
  rows: XlsxCell[][];
  /** Excel column widths in characters (optional; otherwise from the content) */
  widths?: number[];
}

const esc = (s: string) =>
  s
    // characters XML 1.0 does not allow
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export const columnName = (i: number) => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/** "2026-09-30" or "2026-09-30 14:05:00+02" → Excel serial (the wall-clock time as shown). */
export function excelDate(v: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?/.exec(v);
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), 0) + Math.round(parseFloat(m[6] ?? '0') * 1000);
  // Excel day 25569 is 1970-01-01; before 1900-03-01 Excel's calendar is off by one
  const serial = ms / 86_400_000 + 25569;
  return serial >= 61 ? serial : null;
}

const MAX_CELL = 32767;

function cellXml(ref: string, v: XlsxCell, head: boolean): string {
  if (v === null || v === '') return '';
  if (typeof v === 'number') return Number.isFinite(v) ? `<c r="${ref}"><v>${v}</v></c>` : '';
  if (typeof v === 'boolean') return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
  if (typeof v === 'object') {
    const serial = excelDate(v.date);
    if (serial !== null) return `<c r="${ref}" s="${v.time ? 3 : 2}"><v>${serial}</v></c>`;
    v = v.date;
  }
  const text = v.length > MAX_CELL ? v.slice(0, MAX_CELL) : v;
  return `<c r="${ref}" t="inlineStr"${head ? ' s="1"' : ''}><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
}

const displayLength = (v: XlsxCell) =>
  v === null ? 0 : typeof v === 'object' ? (v.time ? 16 : 10) : typeof v === 'boolean' ? 5 : String(v).length;

export function sheetName(name: string) {
  return name.replace(/[[\]:*?/\\]/g, ' ').replace(/^'+|'+$/g, '').trim().slice(0, 31) || 'Sheet1';
}

/** Column widths in characters from the headings and the first rows. */
export function xlsxWidths(headings: string[], rows: XlsxCell[][]) {
  return headings.map((h, ci) => {
    let w = h.length;
    for (const row of rows.slice(0, 500)) w = Math.max(w, displayLength(row[ci]));
    return Math.min(Math.max(w + 2, 8), 60);
  });
}

const XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`;
const STATIC_FILES: Record<string, string> = {
  '[Content_Types].xml':
    `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
  '_rels/.rels':
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  'xl/_rels/workbook.xml.rels':
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  // styles: 0 default, 1 bold heading, 2 date, 3 date and time
  'xl/styles.xml':
    `${XML}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm"/></numFmts>` +
    `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
    `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
    `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
    `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
    `<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
    `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>` +
    `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
};

/**
 * A streaming Excel writer: the sheet is compressed as its rows arrive and
 * each compressed chunk goes to `out`, so a download of a million rows never
 * holds more than one batch of rows (streamed report downloads).
 */
export class XlsxWriter {
  private zip: Zip;
  private sheet: ZipDeflate;
  private n: number;
  private row = 1;
  private name: string;

  constructor(out: (chunk: Uint8Array) => void, name: string, headings: string[], widths: number[]) {
    this.zip = new Zip((err, chunk) => {
      if (err) throw err;
      out(chunk);
    });
    this.n = headings.length;
    this.name = esc(sheetName(name));
    for (const [path, text] of Object.entries(STATIC_FILES)) this.file(path, text);
    this.sheet = new ZipDeflate('xl/worksheets/sheet1.xml', { level: 6 });
    this.zip.add(this.sheet);
    this.sheet.push(
      strToU8(
        `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
          `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
          `<sheetFormatPr defaultRowHeight="15"/>` +
          (this.n ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '') +
          `<sheetData>`,
      ),
    );
    this.rows([headings], true);
  }

  private file(path: string, text: string) {
    const f = new ZipDeflate(path, { level: 6 });
    this.zip.add(f);
    f.push(strToU8(text), true);
  }

  /** Add rows (the cells beyond the headings are left out). */
  rows(rows: XlsxCell[][], head = false) {
    let xml = '';
    for (const row of rows) {
      const r = this.row++;
      xml += `<row r="${r}">${row.slice(0, this.n).map((v, ci) => cellXml(`${columnName(ci)}${r}`, v, head)).join('')}</row>`;
    }
    if (xml) this.sheet.push(strToU8(xml));
  }

  /** Finish the sheet (autofilter over all rows) and the workbook. */
  end() {
    const last = columnName(Math.max(this.n, 1) - 1);
    const height = this.row - 1;
    this.sheet.push(strToU8(`</sheetData>${this.n ? `<autoFilter ref="A1:${last}${height}"/>` : ''}</worksheet>`), true);
    this.file(
      'xl/workbook.xml',
      `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        `<sheets><sheet name="${this.name}" sheetId="1" r:id="rId1"/></sheets>` +
        (this.n ? `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${this.name.replace(/'/g, "''")}'!$A$1:$${last}$${height}</definedName></definedNames>` : '') +
        `</workbook>`,
    );
    this.zip.end();
  }
}

/** A whole sheet in memory (small downloads, tests). */
export function writeXlsx(sheet: XlsxSheet): Buffer {
  const chunks: Uint8Array[] = [];
  const w = new XlsxWriter((c) => chunks.push(c), sheet.name, sheet.headings, sheet.widths ?? xlsxWidths(sheet.headings, sheet.rows));
  w.rows(sheet.rows);
  w.end();
  return Buffer.concat(chunks);
}
