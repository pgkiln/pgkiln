// Rich text and Markdown for the `richtext` and `markdown` items (APEX: Rich
// Text Editor, Markdown Editor). Everything is made safe on the server:
//
//   sanitizeHtml()  rebuilds HTML from an allow-list. Text is always
//                   escaped; only the tags below survive, with no attributes
//                   except a link's href (http, https, mailto, tel or a
//                   relative URL). Scripts, styles, event handlers,
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
]);
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

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', colon: ':', tab: '\t', newline: '\n' };

/** Decode character references (named ones of the small set above, decimal and hex). */
export function decodeEntities(s: string) {
  if (!s.includes('&')) return s;
  return s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]{2,8}));?/g, (m, dec, hex, name) => {
    if (name) return NAMED[name.toLowerCase()] ?? m;
    const cp = dec ? Number(dec) : parseInt(hex, 16);
    return cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : '�';
  });
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

const ATTR = /[\s/]*([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"?|'([^']*)'?|([^\s>]*)))?/y;

/** Rebuild HTML from the allow-list (see the top of this file). */
export function sanitizeHtml(input: string | null | undefined): string {
  const s = String(input ?? '').replace(/\0/g, '');
  const lower = s.replace(/[A-Z]+/g, (c) => c.toLowerCase()); // ASCII only: same length, same indexes
  const out: string[] = [];
  const open: string[] = [];
  let skip: string[] = []; // drop-content tags we are inside of
  let i = 0;
  const text = (t: string) => {
    if (!skip.length && t) out.push(esc(decodeEntities(t)));
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
    if (VOID.has(name)) {
      out.push(`<${name}>`);
      continue;
    }
    if (open.length >= MAX_DEPTH) continue;
    if (name === 'a') {
      const href = attrs.href === undefined ? null : safeHref(attrs.href);
      if (href === null || open.includes('a')) continue; // no link: keep the text
      out.push(`<a href="${esc(href)}" rel="noopener noreferrer nofollow">`);
    } else out.push(`<${name}>`);
    open.push(name);
  }
  while (open.length) out.push(`</${open.pop()}>`);
  return out.join('');
}

/** The text of sanitised HTML (for "is it empty?"). */
export const htmlText = (h: string) => decodeEntities(h.replace(/<[^>]*>/g, ''));

/** Sanitised rich text, or '' when it has no text (an empty editor posts "<br>" or "<p></p>"). */
export function cleanRichText(input: string | null | undefined): string {
  const h = sanitizeHtml(input);
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
