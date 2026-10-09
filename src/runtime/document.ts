import PDFDocument from 'pdfkit';
import { existsSync } from 'node:fs';
import { DATE_OID, type Formatter } from './format.ts';
import { PAPER, printable, textOn, type PdfLayout } from './pdf.ts';

// Document templates (APEX: Document Generator): letters, invoices,
// certificates, employee sheets. A template is a small subset of HTML with
// Mustache-style tags, filled with the rows of a SQL query, and drawn as a
// PDF with a report layout (paper, margins, font size, colors, logo, footer).
//
// Tags (every value is HTML-escaped; there is no "raw" tag):
//   {{name}}  {{order.customer}}  {{.}}          a value (dotted path; "." = the current item)
//   {{amount|number:2}}  {{hiredate|date}}       with a filter: number[:decimals], date, datetime,
//                                                upper, lower, default:text
//   {{#lines}}…{{/lines}}                        a list (repeated), an object (entered) or a flag
//   {{^lines}}…{{/lines}}                        when empty / false
//   {{@index}}                                   the position in the current list (1, 2, …)
//   {{! a comment }}
// Data: the query's first row at the top level, all rows as "rows"; json and
// jsonb columns (e.g. json_agg(...) for invoice lines) become lists and
// objects. Built in: APP_USER, APP_NAME, TODAY, NOW.
//
// HTML: h1–h4, p, div, span, br, b/strong, i/em, u, small, a, ul/ol/li, hr,
// table (thead/tbody/tfoot, tr, th, td; width="30%" on the first row,
// align, colspan, class="plain" for no lines), img src="logo" (the layout's
// logo; width="40mm"), class="page-break" (on div or hr), align="right|center"
// on blocks and cells, class="muted" (grey) and class="right" / "center".
// Anything else is shown as its text.

// ------------------------------------------------------------------ template

export class TemplateError extends Error {}

type Ctx = unknown[];
interface Tok {
  kind: 'text' | 'var' | 'open' | 'inverted' | 'close';
  value: string;
  pos: number;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function tokenize(tpl: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < tpl.length) {
    const start = tpl.indexOf('{{', i);
    if (start === -1) {
      out.push({ kind: 'text', value: tpl.slice(i), pos: i });
      break;
    }
    if (start > i) out.push({ kind: 'text', value: tpl.slice(i, start), pos: i });
    const end = tpl.indexOf('}}', start + 2);
    if (end === -1) throw new TemplateError(`A tag that starts at position ${start} is not closed with }}.`);
    const raw = tpl.slice(start + 2, end).trim();
    i = end + 2;
    if (raw.startsWith('!')) continue;
    if (raw.startsWith('#')) out.push({ kind: 'open', value: raw.slice(1).trim(), pos: start });
    else if (raw.startsWith('^')) out.push({ kind: 'inverted', value: raw.slice(1).trim(), pos: start });
    else if (raw.startsWith('/')) out.push({ kind: 'close', value: raw.slice(1).trim(), pos: start });
    else if (raw.startsWith('{') || raw.startsWith('&')) throw new TemplateError(`Unescaped output ({{${raw}}}) is not supported: every value is escaped.`);
    else out.push({ kind: 'var', value: raw, pos: start });
  }
  return out;
}

type Node = { t: 'text'; v: string } | { t: 'var'; name: string; filters: [string, string?][] } | { t: 'section'; name: string; inverted: boolean; body: Node[] };

function parse(tokens: Tok[]): Node[] {
  const root: Node[] = [];
  const stack: { name: string; body: Node[]; pos: number }[] = [{ name: '', body: root, pos: 0 }];
  for (const tk of tokens) {
    const body = stack[stack.length - 1].body;
    if (tk.kind === 'text') body.push({ t: 'text', v: tk.value });
    else if (tk.kind === 'var') {
      const [name, ...filters] = tk.value.split('|').map((x) => x.trim());
      if (!name) throw new TemplateError(`An empty tag at position ${tk.pos}.`);
      body.push({ t: 'var', name, filters: filters.map((f) => { const [fn, ...arg] = f.split(':'); return [fn.trim(), arg.length ? arg.join(':') : undefined]; }) });
    } else if (tk.kind === 'open' || tk.kind === 'inverted') {
      const sec: Node = { t: 'section', name: tk.value, inverted: tk.kind === 'inverted', body: [] };
      body.push(sec);
      stack.push({ name: tk.value, body: sec.body, pos: tk.pos });
      if (stack.length > 20) throw new TemplateError('Sections are nested more than 20 deep.');
    } else {
      const top = stack.pop()!;
      if (!top.name || top.name !== tk.value) throw new TemplateError(`{{/${tk.value}}} at position ${tk.pos} closes ${top.name ? `{{#${top.name}}}` : 'nothing'}.`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`{{#${stack[stack.length - 1].name}}} is not closed.`);
  return root;
}

function lookup(stack: Ctx, path: string): unknown {
  if (path === '.') return stack[stack.length - 1];
  const parts = path.split('.');
  for (let i = stack.length - 1; i >= 0; i--) {
    const frame = stack[i];
    if (frame && typeof frame === 'object' && !Array.isArray(frame) && parts[0] in (frame as object)) {
      let v: unknown = frame;
      for (const p of parts) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[p] : undefined;
      return v;
    }
  }
  return undefined;
}

export interface TemplateOptions {
  fmt?: Formatter;
  lang?: string;
}

function format(v: unknown, filters: [string, string?][], o: TemplateOptions): string {
  let out: unknown = v;
  for (const [fn, arg] of filters) {
    switch (fn) {
      case 'number': {
        const n = typeof out === 'number' ? out : Number(out);
        if (out === null || out === undefined || out === '' || Number.isNaN(n)) break;
        const d = arg === undefined ? undefined : Math.min(Math.max(Number(arg) || 0, 0), 10);
        out = new Intl.NumberFormat(o.lang ?? 'en', d === undefined ? { maximumFractionDigits: 10 } : { minimumFractionDigits: d, maximumFractionDigits: d }).format(n);
        break;
      }
      case 'date':
      case 'datetime':
        if (out !== null && out !== undefined && out !== '') out = o.fmt?.(String(out), fn === 'date' ? DATE_OID : 1184) ?? String(out).slice(0, fn === 'date' ? 10 : 16).replace('T', ' ');
        break;
      case 'upper':
        out = out === null || out === undefined ? out : String(out).toUpperCase();
        break;
      case 'lower':
        out = out === null || out === undefined ? out : String(out).toLowerCase();
        break;
      case 'default':
        if (out === null || out === undefined || out === '') out = arg ?? '';
        break;
      default:
        throw new TemplateError(`Unknown filter "${fn}". Filters: number, date, datetime, upper, lower, default.`);
    }
  }
  if (out === null || out === undefined) return '';
  if (typeof out === 'boolean') return out ? 'Yes' : 'No';
  if (typeof out === 'object') return JSON.stringify(out);
  return String(out);
}

const truthy = (v: unknown) => !(v === null || v === undefined || v === false || v === '' || v === 0 || (Array.isArray(v) && v.length === 0));

function render(nodes: Node[], stack: Ctx, o: TemplateOptions, depth = 0): string {
  let out = '';
  for (const n of nodes) {
    if (n.t === 'text') out += n.v;
    else if (n.t === 'var') out += esc(format(n.name === '@index' ? lookup(stack, '@index') : lookup(stack, n.name), n.filters, o));
    else {
      const v = lookup(stack, n.name);
      if (n.inverted) {
        if (!truthy(v)) out += render(n.body, stack, o, depth + 1);
      } else if (Array.isArray(v)) {
        if (v.length > 10_000) throw new TemplateError(`{{#${n.name}}} has more than 10,000 items.`);
        v.forEach((item, i) => (out += render(n.body, [...stack, { '@index': i + 1 }, item], o, depth + 1)));
      } else if (truthy(v)) out += render(n.body, typeof v === 'object' ? [...stack, v] : stack, o, depth + 1);
    }
    if (out.length > 5_000_000) throw new TemplateError('The document is larger than 5 MB.');
  }
  return out;
}

/** Fill a template with data; the result is HTML in which every value is escaped. */
export function fillTemplate(template: string, data: Record<string, unknown>, o: TemplateOptions = {}) {
  return render(parse(tokenize(template)), [data], o);
}

/** Problems in a template's tags (for the builder), or null. */
export function templateProblem(template: string): string | null {
  try {
    const check = (nodes: Node[]) => {
      for (const n of nodes) {
        if (n.t === 'var') format('1', n.filters, {});
        if (n.t === 'section') check(n.body);
      }
    };
    check(parse(tokenize(template)));
    return null;
  } catch (e) {
    if (e instanceof TemplateError) return e.message;
    throw e;
  }
}

// ------------------------------------------------------------------ HTML subset

export interface El {
  tag: string;
  attrs: Record<string, string>;
  children: (El | string)[];
}

const VOID = new Set(['br', 'hr', 'img']);
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', euro: '€', copy: '©', hellip: '…', ndash: '–', mdash: '—' };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m));

/** A tolerant parser for the supported HTML: tags, attributes, text and entities. */
export function parseHtml(html: string): El {
  const root: El = { tag: 'root', attrs: {}, children: [] };
  const stack: El[] = [root];
  const re = /<!--[\s\S]*?-->|<\/\s*([a-z0-9]+)\s*>|<([a-z0-9]+)((?:\s+[a-z_:][-a-z0-9_:.]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>|([^<]+|<)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const top = stack[stack.length - 1];
    if (m[0].startsWith('<!--')) continue;
    if (m[1]) {
      const tag = m[1].toLowerCase();
      const at = stack.map((e) => e.tag).lastIndexOf(tag);
      if (at > 0) stack.length = at;
    } else if (m[2]) {
      const tag = m[2].toLowerCase();
      const attrs: Record<string, string> = {};
      for (const a of m[3].matchAll(/([a-z_:][-a-z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gi))
        attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? '');
      const el: El = { tag, attrs, children: [] };
      top.children.push(el);
      if (!VOID.has(tag)) stack.push(el);
    } else top.children.push(decode(m[4]));
  }
  return root;
}

// ------------------------------------------------------------------ PDF

const FONT = process.env.PDF_FONT && existsSync(process.env.PDF_FONT) ? process.env.PDF_FONT : null;
const FONT_BOLD = process.env.PDF_FONT_BOLD && existsSync(process.env.PDF_FONT_BOLD) ? process.env.PDF_FONT_BOLD : FONT;
const MM = 72 / 25.4;
const PAD = 3;
const BLOCK = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'table', 'hr', 'img', 'blockquote', 'section', 'header', 'footer', 'address']);
const HEADING: Record<string, number> = { h1: 2.1, h2: 1.6, h3: 1.3, h4: 1.1 };
const MAX_IMAGE = 2 * 1024 * 1024;

interface Run {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  muted: boolean;
  scale: number;
  link?: string;
}

const classes = (el: El) => new Set((el.attrs.class ?? '').split(/\s+/).filter(Boolean));
const alignOf = (el: El, inherited: 'left' | 'center' | 'right' = 'left'): 'left' | 'center' | 'right' => {
  const a = (el.attrs.align ?? '').toLowerCase();
  const c = classes(el);
  return a === 'right' || c.has('right') ? 'right' : a === 'center' || c.has('center') ? 'center' : a === 'left' ? 'left' : inherited;
};

/** The inline text of an element as styled runs (whitespace collapsed as in HTML). */
function runsOf(nodes: (El | string)[], style: Omit<Run, 'text'>, out: Run[] = []): Run[] {
  for (const n of nodes) {
    if (typeof n === 'string') {
      const text = n.replace(/[ \t\r\n]+/g, ' ');
      if (text) out.push({ ...style, text });
      continue;
    }
    if (n.tag === 'br') {
      out.push({ ...style, text: '\n' });
      continue;
    }
    const c = classes(n);
    const s = { ...style };
    if (n.tag === 'b' || n.tag === 'strong' || n.tag === 'th') s.bold = true;
    if (n.tag === 'i' || n.tag === 'em') s.italic = true;
    if (n.tag === 'u') s.underline = true;
    if (n.tag === 'small') s.scale *= 0.85;
    if (c.has('muted')) s.muted = true;
    if (n.tag === 'a' && /^(https?:|mailto:)/i.test(n.attrs.href ?? '')) s.link = n.attrs.href;
    // a block inside inline content (e.g. a <p> in a table cell) starts a new line
    if (BLOCK.has(n.tag) && out.length && !out[out.length - 1].text.endsWith('\n')) out.push({ ...style, text: '\n' });
    runsOf(n.children, s, out);
  }
  return out;
}

/** Runs without leading/trailing blanks and without blanks around line breaks. */
function tidy(runs: Run[]): Run[] {
  const out = runs.map((r) => ({ ...r }));
  for (let i = 0; i < out.length; i++) {
    const prevEndsBlank = i === 0 || /[\s\n]$/.test(out[i - 1].text);
    if (prevEndsBlank) out[i].text = out[i].text.replace(/^ +/, '');
    out[i].text = out[i].text.replace(/ +\n/g, '\n').replace(/\n +/g, '\n');
  }
  // (a no-break space is content: <p>&nbsp;</p> is an empty line, as in a browser)
  while (out.length && !out[out.length - 1].text.replace(/[ \n]/g, '')) out.pop();
  if (out.length) out[out.length - 1].text = out[out.length - 1].text.replace(/[ \n]+$/, '');
  return out.filter((r) => r.text);
}

export interface DocumentInput {
  html: string;
  layout: PdfLayout;
  title: string;
  author: string;
  /** footer text and page label */
  footer: string;
  pageLabel: (page: number, pages: number) => string;
}

/** Draw the filled template as a PDF. */
export async function documentPdf(input: DocumentInput): Promise<Buffer> {
  const { layout } = input;
  const margin = layout.margin_mm * MM;
  const base = Math.max(layout.font_size, 5) * 1.15; // documents read at a slightly larger size than tables
  const [pw, ph] = PAPER[layout.paper] ?? PAPER.A4;
  const landscape = layout.orientation === 'landscape';
  const [pageW, pageH] = landscape ? [ph, pw] : [pw, ph];
  const usable = pageW - 2 * margin;
  const footerHeight = base + 8;
  const bottom = () => pageH - margin - footerHeight;
  const doc = new PDFDocument({ size: [pw, ph], layout: landscape ? 'landscape' : 'portrait', margin, bufferPages: true, info: { Title: input.title, Author: input.author, Creator: 'pgkiln' } });
  // text that runs past the footer goes onto a new page at the top margin
  doc.page.margins.bottom = margin + footerHeight;
  doc.on('pageAdded', () => (doc.page.margins.bottom = margin + footerHeight));
  const chunks: Buffer[] = [];
  doc.on('data', (b: Buffer) => chunks.push(b));
  const finished = new Promise<void>((resolve, reject) => {
    doc.on('end', resolve);
    doc.on('error', reject);
  });

  const font = (bold: boolean, italic: boolean) => {
    if (FONT) return doc.font(bold && FONT_BOLD ? FONT_BOLD : FONT);
    return doc.font(bold ? (italic ? 'Helvetica-BoldOblique' : 'Helvetica-Bold') : italic ? 'Helvetica-Oblique' : 'Helvetica');
  };
  const ensure = (h: number) => {
    if (doc.y + h > bottom()) {
      doc.addPage();
      doc.y = margin;
    }
  };

  /** Write runs as one paragraph at x with width; continued text keeps the styles inline. */
  const writeRuns = (runs: Run[], x: number, width: number, size: number, align: 'left' | 'center' | 'right', color = layout.text_color, y?: number) => {
    const list = tidy(runs);
    if (!list.length) return;
    list.forEach((r, i) => {
      font(r.bold, r.italic).fontSize(size * r.scale).fillColor(r.muted ? '#666666' : r.link ? '#0b57d0' : color);
      const opts = { continued: i < list.length - 1, underline: r.underline || !!r.link, align, width, link: r.link ?? null, lineGap: size * 0.15 };
      const text = printable(r.text);
      if (i === 0) doc.text(text, x, y ?? doc.y, opts);
      else doc.text(text, opts);
    });
  };
  const plain = (runs: Run[]) => tidy(runs).map((r) => r.text).join('');

  const image = (el: El, x: number, width: number, align: 'left' | 'center' | 'right') => {
    let data: Buffer | null = null;
    const src = el.attrs.src ?? '';
    if (src === 'logo') data = layout.logo;
    else {
      const m = /^data:image\/(png|jpe?g);base64,([a-z0-9+/=\s]+)$/i.exec(src);
      if (m) data = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
    }
    if (!data || data.length > MAX_IMAGE) return;
    const wAttr = /^(\d+(?:\.\d+)?)(mm|%)?$/.exec(el.attrs.width ?? '');
    const w = Math.min(wAttr ? (wAttr[2] === '%' ? (Number(wAttr[1]) / 100) * width : wAttr[2] === 'mm' ? Number(wAttr[1]) * MM : Number(wAttr[1]) * 0.75) : layout.logo_width_mm * MM, width);
    try {
      const img = (doc as unknown as { openImage(src: Buffer): { width: number; height: number } }).openImage(data);
      const h = (img.height / img.width) * w;
      ensure(h);
      const ix = align === 'right' ? x + width - w : align === 'center' ? x + (width - w) / 2 : x;
      doc.image(img as unknown as Buffer, ix, doc.y, { width: w });
      doc.y += h + base * 0.4;
    } catch {
      // not a PNG/JPEG: left out
    }
  };

  const table = (el: El, x: number, width: number) => {
    const rows: { cells: El[]; head: boolean }[] = [];
    const collect = (e: El, head: boolean) => {
      for (const c of e.children)
        if (typeof c !== 'string') {
          if (c.tag === 'tr') rows.push({ cells: c.children.filter((k): k is El => typeof k !== 'string' && (k.tag === 'td' || k.tag === 'th')), head: head || c.children.every((k) => typeof k === 'string' || k.tag === 'th') });
          else if (c.tag === 'thead') collect(c, true);
          else if (c.tag === 'tbody' || c.tag === 'tfoot') collect(c, false);
        }
    };
    collect(el, false);
    if (!rows.length) return;
    const lines = !classes(el).has('plain');
    const ncols = Math.max(...rows.map((r) => r.cells.reduce((n, c) => n + Math.max(1, Math.min(Number(c.attrs.colspan) || 1, 20)), 0)));
    // widths from the first row's width="30%" / "40mm", the rest shared
    const fixed: (number | null)[] = Array(ncols).fill(null);
    let ci = 0;
    for (const c of rows[0].cells) {
      const m = /^(\d+(?:\.\d+)?)(%|mm)?$/.exec(c.attrs.width ?? '');
      if (m && (Number(c.attrs.colspan) || 1) === 1) fixed[ci] = m[2] === 'mm' ? Number(m[1]) * MM : (Number(m[1]) / 100) * width;
      ci += Math.max(1, Number(c.attrs.colspan) || 1);
    }
    const fixedTotal = fixed.reduce<number>((a, w) => a + (w ?? 0), 0);
    const free = fixed.filter((w) => w === null).length;
    const share = free ? Math.max(width - fixedTotal, 20 * free) / free : 0;
    let widths = fixed.map((w) => w ?? share);
    const sum = widths.reduce((a, b) => a + b, 0);
    if (sum > width) widths = widths.map((w) => (w * width) / sum);
    const headRows = rows.filter((r, i) => r.head && rows.slice(0, i).every((p) => p.head));

    const layoutRow = (r: { cells: El[]; head: boolean }) => {
      let col = 0;
      return r.cells.map((c) => {
        const span = Math.max(1, Math.min(Number(c.attrs.colspan) || 1, ncols - col));
        const w = widths.slice(col, col + span).reduce((a, b) => a + b, 0);
        const cx = x + widths.slice(0, col).reduce((a, b) => a + b, 0);
        col += span;
        const runs = runsOf(c.children, { bold: c.tag === 'th' || r.head, italic: false, underline: false, muted: false, scale: 1 });
        const align = alignOf(c, c.tag === 'th' && !r.head ? 'left' : 'left');
        font(c.tag === 'th' || r.head, false).fontSize(base);
        const h = doc.heightOfString(printable(plain(runs)) || ' ', { width: w - 2 * PAD, lineGap: base * 0.15 }) + 2 * PAD;
        return { runs, cx, w, align, h };
      });
    };
    const drawRow = (r: { cells: El[]; head: boolean }) => {
      const cells = layoutRow(r);
      const h = Math.max(base + 2 * PAD, ...cells.map((c) => c.h));
      return {
        h,
        draw: (y: number) => {
          if (r.head && lines) doc.rect(x, y, widths.reduce((a, b) => a + b, 0), h).fill(layout.heading_color);
          for (const c of cells) writeRuns(c.runs, c.cx + PAD, c.w - 2 * PAD, base, c.align, r.head && lines ? textOn(layout.heading_color, layout.text_color) : layout.text_color, y + PAD);
          if (lines) doc.moveTo(x, y + h).lineTo(x + widths.reduce((a, b) => a + b, 0), y + h).lineWidth(0.4).strokeColor('#c9ced6').stroke();
        },
      };
    };
    let y = doc.y;
    rows.forEach((r) => {
      const row = drawRow(r);
      if (y + row.h > bottom()) {
        doc.addPage();
        y = margin;
        // the header rows again on the new page
        if (!headRows.includes(r))
          for (const hr of headRows) {
            const hrow = drawRow(hr);
            hrow.draw(y);
            y += hrow.h;
          }
      }
      row.draw(y);
      y += row.h;
    });
    doc.x = x;
    doc.y = y + base * 0.6;
  };

  const block = (nodes: (El | string)[], x: number, width: number, align: 'left' | 'center' | 'right') => {
    let pending: (El | string)[] = [];
    const flush = () => {
      const runs = runsOf(pending, { bold: false, italic: false, underline: false, muted: false, scale: 1 });
      pending = [];
      if (!tidy(runs).length) return;
      ensure(base * 1.4);
      writeRuns(runs, x, width, base, align);
      doc.y += base * 0.5;
    };
    for (const n of nodes) {
      if (typeof n === 'string' || !BLOCK.has(n.tag)) {
        pending.push(n);
        continue;
      }
      flush();
      const c = classes(n);
      if (c.has('page-break')) {
        doc.addPage();
        doc.y = margin;
        if (n.tag === 'hr') continue;
      }
      const a = alignOf(n, align);
      switch (n.tag) {
        case 'h1':
        case 'h2':
        case 'h3':
        case 'h4': {
          const size = base * HEADING[n.tag];
          ensure(size * 2.4);
          doc.y += n.tag === 'h1' ? 0 : size * 0.3;
          writeRuns(runsOf(n.children, { bold: true, italic: false, underline: false, muted: false, scale: 1 }), x, width, size, a);
          doc.y += size * 0.35;
          break;
        }
        case 'p':
          ensure(base * 1.4);
          writeRuns(runsOf(n.children, { bold: false, italic: false, underline: false, muted: c.has('muted'), scale: 1 }), x, width, base, a);
          doc.y += base * 0.6;
          break;
        case 'ul':
        case 'ol': {
          let i = 0;
          for (const li of n.children) {
            if (typeof li === 'string' || li.tag !== 'li') continue;
            i++;
            ensure(base * 1.4);
            const y = doc.y;
            font(false, false).fontSize(base).fillColor(layout.text_color).text(n.tag === 'ol' ? `${i}.` : '•', x + 4, y, { width: 14, align: 'right' });
            doc.y = y;
            const inner = li.children.some((k) => typeof k !== 'string' && BLOCK.has(k.tag));
            if (inner) block(li.children, x + 22, width - 22, a);
            else writeRuns(runsOf(li.children, { bold: false, italic: false, underline: false, muted: false, scale: 1 }), x + 22, width - 22, base, a, layout.text_color, y);
            doc.y += base * 0.25;
          }
          doc.y += base * 0.4;
          break;
        }
        case 'hr':
          ensure(base);
          doc.moveTo(x, doc.y + 2).lineTo(x + width, doc.y + 2).lineWidth(0.6).strokeColor('#c9ced6').stroke();
          doc.y += base * 0.8;
          break;
        case 'img':
          image(n, x, width, a);
          break;
        case 'table':
          table(n, x, width);
          break;
        case 'blockquote':
          block(n.children, x + 18, width - 18, a);
          break;
        default:
          // div, section, li outside a list, …: their content, in order
          block(n.children, x, width, a);
      }
    }
    flush();
  };

  doc.y = margin;
  block(parseHtml(input.html).children, margin, usable, 'left');

  // the footer on every page: the layout's footer text and "page n of m"
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    const saved = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    font(false, false).fontSize(Math.max(layout.font_size - 1, 5)).fillColor('#777777');
    const fy = pageH - margin - footerHeight + 8;
    doc.text(printable(input.footer.replace(/\s*\n\s*/g, ' ')), margin, fy, { width: usable * 0.7, lineBreak: false, ellipsis: true });
    doc.text(input.pageLabel(i + 1, range.count), margin + usable * 0.7, fy, { width: usable * 0.3, align: 'right', lineBreak: false });
    doc.page.margins.bottom = saved;
  }
  doc.end();
  await finished;
  return Buffer.concat(chunks);
}


// ------------------------------------------------------------------ in an application

export interface DocumentTemplate {
  id: number;
  name: string;
  description: string | null;
  query: string;
  template: string;
  layout: string | null;
  filename: string | null;
  authz: string | null;
}

const MAX_ROWS = Number(process.env.DOCUMENT_MAX_ROWS ?? 10_000);

/** The data of a template: its query's first row at the top level, all rows as "rows", plus built-ins. */
export async function documentData(c: { query: (q: { text: string }) => Promise<{ rows: Record<string, unknown>[] }> }, sql: string, builtIns: Record<string, string>) {
  const res = await c.query({ text: `select * from (\n${sql}\n) "__d" limit ${MAX_ROWS}` });
  return { ...builtIns, ...(res.rows[0] ?? {}), rows: res.rows };
}

/** A file name from the template's pattern (or name): letters, digits, - and _ only. */
export const documentFilename = (pattern: string) => `${pattern.replace(/\.pdf$/i, '').replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 100) || 'document'}.pdf`;
