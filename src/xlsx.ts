import { strToU8, zipSync } from 'fflate';

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

export function writeXlsx(sheet: XlsxSheet): Buffer {
  const n = sheet.headings.length;
  const widths =
    sheet.widths ??
    sheet.headings.map((h, ci) => {
      let w = h.length;
      for (const row of sheet.rows.slice(0, 500)) w = Math.max(w, displayLength(row[ci]));
      return Math.min(Math.max(w + 2, 8), 60);
    });
  const last = columnName(Math.max(n, 1) - 1);
  const rowsXml = [sheet.headings as XlsxCell[], ...sheet.rows].map(
    (row, ri) => `<row r="${ri + 1}">${row.slice(0, n).map((v, ci) => cellXml(`${columnName(ci)}${ri + 1}`, v, ri === 0)).join('')}</row>`,
  );
  const ws =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<dimension ref="A1:${last}${sheet.rows.length + 1}"/>` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>` +
    (n ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '') +
    `<sheetData>${rowsXml.join('')}</sheetData>` +
    (n ? `<autoFilter ref="A1:${last}${sheet.rows.length + 1}"/>` : '') +
    `</worksheet>`;
  const name = esc(sheetName(sheet.name));
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
        `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    ),
    '_rels/.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    'xl/workbook.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        `<sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets>` +
        (n ? `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${name.replace(/'/g, "''")}'!$A$1:$${last}$${sheet.rows.length + 1}</definedName></definedNames>` : '') +
        `</workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
        `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ),
    // styles: 0 default, 1 bold heading, 2 date, 3 date and time
    'xl/styles.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
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
    ),
    'xl/worksheets/sheet1.xml': strToU8(ws),
  };
  return Buffer.from(zipSync(files, { level: 6 }));
}
