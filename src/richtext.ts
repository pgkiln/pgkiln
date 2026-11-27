// Rich text and Markdown for the `richtext` and `markdown` items (APEX: Rich
// Text Editor, Markdown Editor). Everything is made safe on the server:
//
//   sanitizeHtml()  rebuilds HTML from an allow-list. Text is always
//                   escaped (named character references stay as they are,
//                   so &ouml; shows ö); only the tags below survive, with no
//                   attributes except a link's href (http, https, mailto, tel
//                   or a relative URL). Simple tables (table, thead, tbody,
//                   tr, th, td; sprint 235) keep their structure: a cell only
//                   in a row, a row only in a table. Scripts, styles, event handlers,
//                   javascript: URLs, comments and unknown tags are dropped
//                   (the contents of script, style, iframe, svg… with them).
//   markdownHtml()  renders a Markdown subset (headings, paragraphs, lists,
//                   quotes, code, links, emphasis); raw HTML in the source
//                   is shown as text. Its output goes through sanitizeHtml().
//
// The output is built from scratch, never copied from the input, so it is
// well-formed and safe however the input is written. No regular expression
// here can backtrack more than a bounded distance (spans are capped).
import { esc } from './html.ts';

const ALLOWED = new Set([
  'p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'del', 'strike', 'sub', 'sup', 'ul', 'ol', 'li',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code', 'a', 'hr', 'div',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  // (sprint 259) for a colour of its own
  'span',
]);
/** (sprint 235) Table parts and the elements each may be directly inside. */
const TABLE_PARENT: Record<string, string[]> = { thead: ['table'], tbody: ['table'], tr: ['table', 'thead', 'tbody'], td: ['tr'], th: ['tr'] };
/** The parts that a new part ends implicitly (a <td> ends the cell before it, a <tr> the row…). */
const TABLE_ENDS: Record<string, string[]> = {
  td: ['td', 'th'], th: ['td', 'th'], tr: ['td', 'th', 'tr'], thead: ['td', 'th', 'tr', 'thead', 'tbody'], tbody: ['td', 'th', 'tr', 'thead', 'tbody'],
};
const TABLE_PARTS = new Set(['table', 'thead', 'tbody', 'tr', 'td', 'th']);
/** Directly inside these, only table parts may open (other tags are dropped, their text kept). */
const TABLE_ONLY = new Set(['table', 'thead', 'tbody', 'tr']);
const VOID = new Set(['br', 'hr']);
/** Tags whose contents are dropped with them. */
const DROP = new Set([
  'script', 'style', 'template', 'iframe', 'object', 'embed', 'noscript', 'svg', 'math', 'title', 'textarea',
  'select', 'noembed', 'noframes', 'xmp', 'plaintext', 'head', 'applet', 'frameset', 'frame',
]);
/** Raw-text tags: their contents end only at the matching end tag. */
const RAWTEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'noembed', 'noframes', 'iframe', 'noscript', 'plaintext']);
/** Dropped tags that have no contents or end tag. */
const DROP_VOID = new Set(['embed', 'frame', 'base', 'link', 'meta', 'img', 'input', 'source', 'track', 'param', 'area', 'col', 'wbr', 'keygen']);
const MAX_DEPTH = 40;

/** (sprint 259) The styles kept from an editor's style attribute: text and background colours, text alignment. */
const STYLE_PROPS = new Set(['color', 'background-color', 'text-align']);

/** #rgb, #rrggbb or rgb(r, g, b) as #rrggbb; anything else: null. */
function cssColor(v: string): string | null {
  const t = v.trim().toLowerCase();
  let m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(t);
  if (m) return `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`;
  if (/^#[0-9a-f]{6}$/.test(t)) return t;
  m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(?:1|1\.0+|0?\.\d+|0)\s*)?\)$/.exec(t);
  if (m && [m[1], m[2], m[3]].every((x) => Number(x) <= 255)) return `#${[m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('')}`;
  return null;
}

/** The safe declarations of a style attribute, e.g. "color:#95a5a6;text-align:center" (or ''). */
export function safeStyle(style: string | undefined): string {
  if (!style) return '';
  const out: string[] = [];
  for (const decl of style.slice(0, 1000).split(';')) {
    const at = decl.indexOf(':');
    if (at < 0) continue;
    const prop = decl.slice(0, at).trim().toLowerCase();
    const val = decl.slice(at + 1).trim().toLowerCase();
    if (!STYLE_PROPS.has(prop) || out.some((d) => d.startsWith(`${prop}:`))) continue;
    const v = prop === 'text-align' ? (['left', 'right', 'center', 'justify'].includes(val) ? val : null) : cssColor(val);
    if (v) out.push(`${prop}:${v}`);
  }
  return out.join(';');
}

/**
 * How kept styles are written: as a page CSS class (css: the page's sheet; the Content-Security-Policy allows no style
 * attributes), or as a style attribute again (keepStyle: the value that is stored and edited).
 */
export interface StyleOutput {
  css?: { cls(declarations: string): string };
  keepStyle?: boolean;
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', colon: ':', tab: '\t', newline: '\n' };

/**
 * (sprint 235) More named references, case-sensitive and with their ";":
 * Latin-1 (&ouml; &eacute; &copy;…) and common typography (&rsquo; &ndash;
 * &hellip; &euro;…). Others that look like a reference are kept as they are
 * in sanitised text, where the browser reads them (see escText).
 */
const LATIN1 = (
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para ' +
  'middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute ' +
  'Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute ' +
  'THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ' +
  'ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml'
).split(' ');
const NAMED_EXACT: Record<string, string> = {
  ...Object.fromEntries(LATIN1.map((n, k) => [n, String.fromCharCode(160 + k)])),
  OElig: '\u0152', oelig: '\u0153', Scaron: '\u0160', scaron: '\u0161', Yuml: '\u0178', fnof: '\u0192', circ: '\u02c6',
  tilde: '\u02dc', ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', zwnj: '\u200c', zwj: '\u200d', lrm: '\u200e', rlm: '\u200f',
  ndash: '\u2013', mdash: '\u2014', lsquo: '\u2018', rsquo: '\u2019', sbquo: '\u201a', ldquo: '\u201c', rdquo: '\u201d',
  bdquo: '\u201e', dagger: '\u2020', Dagger: '\u2021', bull: '\u2022', hellip: '\u2026', permil: '\u2030', prime: '\u2032',
  Prime: '\u2033', lsaquo: '\u2039', rsaquo: '\u203a', oline: '\u203e', euro: '\u20ac', trade: '\u2122', larr: '\u2190',
  uarr: '\u2191', rarr: '\u2192', darr: '\u2193', harr: '\u2194', minus: '\u2212', le: '\u2264', ge: '\u2265', ne: '\u2260',
  asymp: '\u2248', infin: '\u221e', check: '\u2713', hearts: '\u2665',
};

/** Decode character references (named ones of the sets above, decimal and hex). */
export function decodeEntities(s: string) {
  if (!s.includes('&')) return s;
  return s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}))(;?)/g, (m, dec, hex, name, semi) => {
    if (name) {
      if (semi && NAMED_EXACT[name]) return NAMED_EXACT[name];
      // the small set as before: its letters, with or without the ";"
      const letters = /^[a-zA-Z]{2,8}/.exec(name)![0];
      const v = NAMED[letters.toLowerCase()];
      return v === undefined ? m : v + m.slice(1 + letters.length + (letters.length === name.length ? semi.length : 0));
    }
    const cp = dec ? Number(dec) : parseInt(hex, 16);
    return cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : '�';
  });
}

const REF = /&(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|([a-zA-Z][a-zA-Z0-9]{1,31}))(;?)/g;

/**
 * Text as HTML: references decoded and the result escaped, except a named
 * reference we don't know (&alefsym;), which stays as written: in text the
 * browser turns it into a character (never into markup), and an unknown
 * name shows as written, as it did before.
 */
export function escText(t: string) {
  if (!t.includes('&')) return esc(t);
  let out = '';
  let last = 0;
  for (const m of t.matchAll(REF)) {
    out += esc(t.slice(last, m.index));
    const d = decodeEntities(m[0]);
    out += d === m[0] && m[1] && m[2] ? m[0] : esc(d);
    last = m.index + m[0].length;
  }
  return out + esc(t.slice(last));
}

/**
 * A link target that is safe to keep: http(s), mailto, tel, or relative
 * (no scheme). Control characters and white space are removed first, as
 * browsers ignore them ("java\tscript:"). null when it isn't safe.
 */
export function safeHref(value: string): string | null {
  const url = decodeEntities(value).replace(/[\u0000-\u0020\u007f-\u00a0\u00ad\u1680\u180e\u2000-\u200f\u2028-\u202f\u205f-\u2064\u3000\ufeff]/g, '');
  if (!url || url.length > 2000) return null;
  if (/^(https?|mailto|tel):/i.test(url)) return url;
  // anything else with a scheme (javascript:, data:, vbscript:, file:…) is refused;
  // a colon before the first / ? # would be read as one
  if (/^[^/?#]*:/.test(url)) return null;
  return url;
}

/** The innermost open table part, or -1. */
function tablePart(open: string[]) {
  for (let k = open.length - 1; k >= 0; k--) if (TABLE_PARTS.has(open[k])) return k;
  return -1;
}

const ATTR = /[\s/]*([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"?|'([^']*)'?|([^\s>]*)))?/y;

/** Rebuild HTML from the allow-list (see the top of this file). */
export function sanitizeHtml(input: string | null | undefined, styles: StyleOutput = {}): string {
  const s = String(input ?? '').replace(/\0/g, '');
  const lower = s.replace(/[A-Z]+/g, (c) => c.toLowerCase()); // ASCII only: same length, same indexes
  const out: string[] = [];
  const open: string[] = [];
  let skip: string[] = []; // drop-content tags we are inside of
  let i = 0;
  const text = (t: string) => {
    if (!skip.length && t) out.push(escText(t));
  };
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) {
      text(s.slice(i));
      break;
    }
    text(s.slice(i, lt));
    i = lt;
    if (s.startsWith('<!--', i)) {
      const end = s.indexOf('-->', i + 4);
      i = end < 0 ? s.length : end + 3;
      continue;
    }
    if (s[i + 1] === '!' || s[i + 1] === '?') {
      const end = s.indexOf('>', i);
      i = end < 0 ? s.length : end + 1;
      continue;
    }
    const endTag = /^<\/([a-zA-Z][a-zA-Z0-9-]*)/.exec(s.slice(i, i + 40));
    if (endTag) {
      const end = s.indexOf('>', i);
      i = end < 0 ? s.length : end + 1;
      const name = endTag[1].toLowerCase();
      if (skip.length) {
        if (skip[skip.length - 1] === name) skip.pop();
        continue;
      }
      const at = open.lastIndexOf(name);
      if (at >= 0) while (open.length > at) out.push(`</${open.pop()}>`);
      continue;
    }
    const startTag = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(s.slice(i, i + 40));
    if (!startTag) {
      text('<');
      i++;
      continue;
    }
    // the attributes, up to the closing >
    const name = startTag[1].toLowerCase();
    let j = i + startTag[0].length;
    const attrs: Record<string, string> = {};
    for (;;) {
      while (j < s.length && /[\s/]/.test(s[j])) j++;
      if (j >= s.length || s[j] === '>') break;
      ATTR.lastIndex = j;
      const m = ATTR.exec(s);
      if (!m || ATTR.lastIndex === j) {
        j++;
        continue;
      }
      j = ATTR.lastIndex;
      const key = m[1].toLowerCase();
      if (!(key in attrs)) attrs[key] = m[2] ?? m[3] ?? m[4] ?? '';
    }
    // <svg/>, and tags that never have contents, open nothing
    const empty = s[j - 1] === '/' || DROP_VOID.has(name);
    i = j + 1;
    if (skip.length) {
      if (DROP.has(name) && !empty) skip.push(name);
      continue;
    }
    if (DROP_VOID.has(name) || (empty && DROP.has(name) && !RAWTEXT.has(name))) continue;
    if (DROP.has(name)) {
      if (RAWTEXT.has(name)) {
        // contents end at </name, whatever they look like
        const close = lower.indexOf(`</${name}`, i);
        if (close < 0) i = s.length;
        else {
          const end = s.indexOf('>', close);
          i = end < 0 ? s.length : end + 1;
        }
      } else skip = [name];
      continue;
    }
    if (!ALLOWED.has(name)) continue; // unknown tag: keep its text, drop the tag
    // (sprint 235) tables: a part ends the cells and rows before it, and opens only in its place
    if (TABLE_PARENT[name]) {
      let k = tablePart(open);
      while (k >= 0 && TABLE_ENDS[name].includes(open[k])) {
        while (open.length > k) out.push(`</${open.pop()}>`);
        k = tablePart(open);
      }
      if (k < 0 || k !== open.length - 1 || !TABLE_PARENT[name].includes(open[k])) continue;
    } else if (open.length && TABLE_ONLY.has(open[open.length - 1])) continue;
    if (VOID.has(name)) {
      out.push(`<${name}>`);
      continue;
    }
    if (open.length >= MAX_DEPTH) continue;
    if (name === 'a') {
      const href = attrs.href === undefined ? null : safeHref(attrs.href);
      if (href === null || open.includes('a')) continue; // no link: keep the text
      out.push(`<a href="${esc(href)}" rel="noopener noreferrer nofollow">`);
    } else {
      // (sprint 259) an editor's colours and alignment: a page CSS class, or the style attribute again
      const st = styles.css || styles.keepStyle ? safeStyle(attrs.style) : '';
      out.push(!st ? `<${name}>` : styles.css ? `<${name} class="${styles.css.cls(st)}">` : `<${name} style="${st}">`);
    }
    open.push(name);
  }
  while (open.length) out.push(`</${open.pop()}>`);
  return out.join('');
}

/** The text of sanitised HTML (for "is it empty?"). */
export const htmlText = (h: string) => decodeEntities(h.replace(/<[^>]*>/g, ''));

/** Sanitised rich text, or '' when it has no text (an empty editor posts "<br>" or "<p></p>"). */
export function cleanRichText(input: string | null | undefined): string {
  const h = sanitizeHtml(input, { keepStyle: true });
  return htmlText(h).trim() || /<hr>/.test(h) ? h : '';
}

// ---------------------------------------------------------------- Markdown

const MAX_NESTING = 8;

/** Inline Markdown: code, links, emphasis, line breaks. Returns HTML (sanitised later). */
function inline(src: string): string {
  const stash: string[] = [];
  const put = (h: string) => `\u0000${stash.push(h) - 1}\u0000`;
  let t = src.replace(/\u0000/g, '');
  t = t.replace(/(?: {2,64}|\\)\n/g, () => put('<br>\n'));
  t = t.replace(/``([^\n]{1,1000}?)``|`([^`\n]{1,1000})`/g, (_m, a, b) => put(`<code>${esc((a ?? b).trim())}</code>`));
  t = t.replace(/\\([\\`*_{}[\]()#+\-.!~>|])/g, (_m, ch) => put(esc(ch)));
  t = t.replace(/<((?:https?:\/\/|mailto:)[^\s<>]{1,2000})>/g, (_m, url) => put(`<a href="${esc(url)}">${esc(url)}</a>`));
  // (?=(…))\2 matches the URL atomically, and neither part crosses a "[": linear on any input
  t = t.replace(/!?\[([^[\]\n]{0,500})\]\(\s*(?=([^\s()[\]]{1,2000}))\2(?:\s+"[^"\n]{0,300}")?\s*\)/g, (_m, label, url) =>
    put(`<a href="${esc(url)}">${emphasis(esc(label)) || esc(url)}</a>`),
  );
  t = t.replace(/\bhttps?:\/\/[^\s<>\u0000]{1,2000}/g, (url) => {
    const trail = /[.,;:!?)\]'"]+$/.exec(url)?.[0] ?? '';
    const u = url.slice(0, url.length - trail.length);
    return put(`<a href="${esc(u)}">${esc(u)}</a>`) + esc(trail);
  });
  let h = emphasis(esc(t));
  for (let n = 0; n < 5 && h.includes('\u0000'); n++) h = h.replace(/\u0000(\d+)\u0000/g, (_m, k) => stash[Number(k)] ?? '');
  return h;
}

/** **strong**, __strong__, *em*, _em_, ~~del~~ on escaped text (spans of at most 500 characters). */
function emphasis(h: string) {
  return h
    .replace(/\*\*([^*\s](?:[^*]{0,500}?[^*\s])?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w])__([^_\s](?:[^_]{0,500}?[^_\s])?)__(?!\w)/g, '$1<strong>$2</strong>')
    .replace(/\*([^*\s](?:[^*]{0,500}?[^*\s])?)\*/g, '<em>$1</em>')
    .replace(/(^|[^\w])_([^_\s](?:[^_]{0,500}?[^_\s])?)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~\s](?:[^~]{0,500}?[^~\s])?)~~/g, '<del>$1</del>');
}

const LIST_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const FENCE = /^ {0,3}(```|~~~)/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
/** A heading's text without its optional closing #s (no regex: (.*?)[ #]*$ backtracks quadratically). */
function headingText(t: string) {
  let end = t.length;
  while (end > 0 && (t[end - 1] === ' ' || t[end - 1] === '\t')) end--;
  let k = end;
  while (k > 0 && t[k - 1] === '#') k--;
  if (k < end && (k === 0 || t[k - 1] === ' ' || t[k - 1] === '\t')) {
    end = k;
    while (end > 0 && (t[end - 1] === ' ' || t[end - 1] === '\t')) end--;
  }
  return t.slice(0, end);
}
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const blank = (l: string) => !l.trim();

function blocks(lines: string[], depth: number): string {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(fence[1])) code.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const n = heading[1].length;
      out.push(`<h${n}>${inline(headingText(heading[2]))}</h${n}>`);
      i++;
      continue;
    }
    if (RULE.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && !blank(lines[i]) && (QUOTE.test(lines[i]) || inner.length)) {
        const q = QUOTE.exec(lines[i]);
        inner.push(q ? q[1] : lines[i]);
        i++;
      }
      out.push(`<blockquote>${depth < MAX_NESTING ? blocks(inner, depth + 1) : `<p>${inline(inner.join('\n'))}</p>`}</blockquote>`);
      continue;
    }
    const first = LIST_ITEM.exec(line);
    if (first) {
      const ordered = /\d/.test(first[2]);
      const items: string[][] = [];
      const indent = first[1].length;
      while (i < lines.length) {
        const m = LIST_ITEM.exec(lines[i]);
        if (m && m[1].length <= indent && /\d/.test(m[2]) === ordered) {
          items.push([m[3]]);
          i++;
        } else if (!blank(lines[i]) && (/^\s/.test(lines[i]) || !m) && items.length && !HEADING.test(lines[i]) && !FENCE.test(lines[i]) && !QUOTE.test(lines[i]) && !(m && m[1].length <= indent)) {
          // continuation (or a nested list), indented under the item
          items[items.length - 1].push(lines[i].replace(/^ {1,4}|^\t/, ''));
          i++;
        } else if (blank(lines[i]) && i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]) && items.length) {
          items[items.length - 1].push('');
          i++;
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const lis = items.map((it) => {
        const nested = it.slice(1).some((l) => LIST_ITEM.test(l) || blank(l));
        if (!nested || depth >= MAX_NESTING) return `<li>${inline(it.join('\n'))}</li>`;
        // the item's first line, then its nested blocks
        const firstBlank = it.findIndex((l, k) => k > 0 && (LIST_ITEM.test(l) || blank(l)));
        return `<li>${inline(it.slice(0, firstBlank).join('\n'))}${blocks(it.slice(firstBlank), depth + 1)}</li>`;
      });
      out.push(`<${tag}>${lis.join('')}</${tag}>`);
      continue;
    }
    // a paragraph: up to a blank line or the start of another block
    const para: string[] = [];
    while (i < lines.length && !blank(lines[i]) && (!para.length || !(FENCE.test(lines[i]) || HEADING.test(lines[i]) || RULE.test(lines[i]) || QUOTE.test(lines[i]) || LIST_ITEM.test(lines[i]))))
      para.push(lines[i++]);
    out.push(`<p>${inline(para.join('\n'))}</p>`);
  }
  return out.join('\n');
}

/** Markdown → safe HTML. */
export function markdownHtml(src: string | null | undefined): string {
  if (!src) return '';
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  return sanitizeHtml(blocks(lines, 0));
}
