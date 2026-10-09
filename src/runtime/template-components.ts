import { runtime } from '../db.ts';
import { esc, raw, type Raw } from '../html.ts';
import type { Region } from '../metadata.ts';
import { pageAllowed } from './authz.ts';
import { bindValues, type PageContext } from './context.ts';
import { isModal, pageHref } from './links.ts';
import { builtinComponents } from './builtin-components.ts';

// Template components (APEX 23.1+): an HTML template with #NAME#
// substitutions and {if}/{case}/{loop} directives, used as a region type
// (template-region.ts) and as a report column template (report.ts).
//
// Templates may come from plug-in files written by someone else, so they
// are held to more than "developer HTML is trusted":
//   - an allow-list of elements and attributes: no <script>, <style>,
//     forms, frames, event handlers, style attributes or data-* attributes
//     (those drive app.js); every attribute value is quoted;
//   - substitutions are always HTML-escaped (there is no raw form), and may
//     only appear in text or inside a quoted attribute value;
//   - a directive block starts and ends in the same place (text, or one
//     attribute value), so leaving a branch out never leaves half a tag;
//   - URLs (href, src, cite) are checked again after substitution: only
//     http(s), mailto, tel and relative URLs; anything else is dropped.
// So whatever the data, the output has exactly the template's elements and
// attributes. Links to pages of the application use the #LINK# placeholder,
// which pgkiln fills with a checksummed URL (links.ts).

export const PLUGIN_FORMAT = 'pgkiln-plugin/1';
/** Layout classes of a component's instances in a region (app.css, "template components"). */
export const LAYOUT_CLASSES = ['tc-list', 'tc-grid', 'tc-inline', 'tc-divided', 'tc-compact'] as const;
export const ATTRIBUTE_TYPES = ['text', 'number', 'select', 'checkbox'] as const;
export const MAX_ROWS = 500;

export interface TcAttribute {
  name: string;
  label?: string;
  type?: (typeof ATTRIBUTE_TYPES)[number];
  default?: string;
  /** a select's values */
  options?: string[];
  help?: string;
}

export interface TemplateComponent {
  id?: number;
  static_id: string;
  name: string;
  description?: string | null;
  version?: string | null;
  template: string;
  wrapper?: string | null;
  css_classes?: string[] | null;
  attributes?: TcAttribute[] | null;
  /** one of pgkiln's own (builtin-components.ts), not the application's */
  builtin?: boolean;
}

/** How a region or report column uses a component (region config, or config.column_templates[col]). */
export interface TcUse {
  component?: string;
  attributes?: Record<string, string>;
}

export class TemplateError extends Error {}

// ---------------------------------------------------------------- the allow-list

const TAGS = new Set([
  'a', 'abbr', 'article', 'aside', 'b', 'bdi', 'blockquote', 'br', 'caption', 'cite', 'code', 'col', 'colgroup', 'data',
  'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5',
  'h6', 'header', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark', 'meter', 'nav', 'ol', 'p', 'pre', 'progress', 'q', 's',
  'samp', 'section', 'small', 'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'time', 'tr', 'u', 'ul', 'var', 'wbr',
]);
const GLOBAL_ATTRS = new Set(['class', 'title', 'lang', 'dir', 'role', 'hidden', 'translate']);
const TAG_ATTRS: Record<string, string[]> = {
  a: ['href', 'target', 'rel', 'hreflang'],
  img: ['src', 'alt', 'width', 'height', 'loading', 'decoding'],
  time: ['datetime'], del: ['datetime', 'cite'], ins: ['datetime', 'cite'], q: ['cite'], blockquote: ['cite'],
  td: ['colspan', 'rowspan', 'headers'], th: ['colspan', 'rowspan', 'headers', 'scope', 'abbr'],
  ol: ['start', 'reversed', 'type'], li: ['value'], details: ['open'], data: ['value'],
  progress: ['value', 'max'], meter: ['value', 'min', 'max', 'low', 'high', 'optimum'], col: ['span'], colgroup: ['span'],
};
const URL_ATTRS = new Set(['href', 'src', 'cite']);
const BOOLEAN_ATTRS = new Set(['hidden', 'open', 'reversed']);

const attrAllowed = (tag: string, attr: string) => GLOBAL_ATTRS.has(attr) || /^aria-[a-z]+$/.test(attr) || (TAG_ATTRS[tag] ?? []).includes(attr);

function attrProblem(tag: string, attr: string) {
  if (/^on/.test(attr)) return `Event handler attributes (${attr}) are not allowed: templates contain no JavaScript.`;
  if (attr === 'style') return 'style attributes are not allowed (the Content-Security-Policy blocks them): use classes.';
  if (/^data-/.test(attr)) return `data-* attributes (${attr}) are not allowed.`;
  return `The attribute ${attr} is not allowed on <${tag}>.`;
}

const ENTITIES: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', colon: ':', tab: '', newline: '', nbsp: ' ' };

/** A URL attribute's value (as written in HTML) is safe: http(s), mailto, tel, or relative; images also data:image/png|jpeg|gif|webp. */
export function urlOk(value: string, attr = 'href') {
  const decoded = value
    .replace(/&#x([0-9a-f]+);?/gi, (_, h: string) => String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff)))
    .replace(/&#(\d+);?/g, (_, d: string) => String.fromCodePoint(Math.min(parseInt(d, 10), 0x10ffff)))
    .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m);
  // browsers ignore whitespace and control characters in a scheme
  const s = decoded.replace(/[\u0000- \u007f- ]/g, '');
  const head = s.split(/[/?#]/)[0];
  if (/&[a-z]+;/i.test(head)) return false; // an entity we don't know, before the first / ? #
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(head)?.[1]?.toLowerCase();
  if (!scheme) return true;
  if (['http', 'https', 'mailto', 'tel'].includes(scheme)) return true;
  return attr === 'src' && /^data:image\/(png|jpeg|gif|webp)[;,]/i.test(s);
}

// ---------------------------------------------------------------- compiling

type Test = { op: '' | '?' | '!'; name: string };
type Node =
  | { t: 'text'; s: string }
  | { t: 'ph'; name: string; mod: string }
  | { t: 'if'; branches: { test: Test; body: Node[] }[]; else: Node[] }
  | { t: 'case'; name: string; whens: { value: string; body: Node[] }[]; otherwise: Node[] }
  | { t: 'loop'; sep: string; name: string; body: Node[] };

type Tok = { k: 'text'; s: string } | { k: 'ph'; name: string; mod: string; ctx: string; at: number } | { k: 'dir'; d: string; arg: string; ctx: string; at: number };

const DIRECTIVES = new Set(['if', 'elsif', 'else', 'endif', 'case', 'when', 'otherwise', 'endcase', 'loop', 'endloop']);
const MODIFIERS = new Set(['', 'HTML', 'ATTR', 'STRIPHTML']);
const NAME = /^[A-Za-z][A-Za-z0-9_$]*$/;
const MAX_DEPTH = 20;
export const MAX_TEMPLATE = 20000;

/** Template text → tokens, checking the HTML on the way. */
function scan(src: string, what: string): Tok[] {
  const toks: Tok[] = [];
  let buf = '';
  let i = 0;
  let attrN = 0;
  const line = (at: number) => src.slice(0, at).split('\n').length;
  const fail = (msg: string, at = i): never => {
    throw new TemplateError(`${what}, line ${line(at)}: ${msg}`);
  };
  const flush = () => {
    if (buf) toks.push({ k: 'text', s: buf });
    buf = '';
  };
  // a placeholder or directive at i (in text, or in the attribute value ctx)
  const token = (ctx: string) => {
    if (src[i] === '#') {
      const m = /^#([A-Za-z][A-Za-z0-9_$]*)(?:!([A-Za-z]+))?#/.exec(src.slice(i, i + 80));
      if (!m) return false;
      const mod = (m[2] ?? '').toUpperCase();
      if (mod === 'RAW') fail(`#${m[1]}!RAW#: raw (unescaped) substitutions are not allowed; values are always escaped.`);
      if (!MODIFIERS.has(mod)) fail(`#${m[1]}!${m[2]}#: unknown modifier (HTML, ATTR or STRIPHTML).`);
      flush();
      toks.push({ k: 'ph', name: m[1].toUpperCase(), mod, ctx, at: i });
      i += m[0].length;
      return true;
    }
    if (src[i] === '{' && /^\{[a-z]+[\s/]/.test(src.slice(i, i + 20))) {
      const m = /^\{([a-z]+)((?:\s[^{}\n]*?)?)\s*\/\}/.exec(src.slice(i, i + 300));
      if (!m) fail('A directive is not closed with /}.');
      if (!DIRECTIVES.has(m![1])) fail(`Unknown directive {${m![1]}/}.`);
      flush();
      toks.push({ k: 'dir', d: m![1], arg: m![2].trim(), ctx, at: i });
      i += m![0].length;
      return true;
    }
    return false;
  };

  while (i < src.length) {
    if (src[i] !== '<') {
      if (!token('text')) buf += src[i++];
      continue;
    }
    if (src.startsWith('<!', i) || src.startsWith('<?', i)) fail('Comments and <!…> declarations are not allowed.');
    const end = /^<\/([a-zA-Z][a-zA-Z0-9]*)\s*>/.exec(src.slice(i, i + 40));
    if (end) {
      if (!TAGS.has(end[1].toLowerCase())) fail(`The element <${end[1].toLowerCase()}> is not allowed.`);
      buf += `</${end[1].toLowerCase()}>`;
      i += end[0].length;
      continue;
    }
    const open = /^<([a-zA-Z][a-zA-Z0-9]*)/.exec(src.slice(i, i + 40));
    if (!open) fail('Write a literal < as &lt;.');
    const tag = open![1].toLowerCase();
    if (!TAGS.has(tag))
      fail(tag === 'script' || tag === 'style' ? `<${tag}> is not allowed: the Content-Security-Policy blocks inline scripts and styles.` : `The element <${tag}> is not allowed.`);
    buf += `<${tag}`;
    i += open![0].length;
    for (;;) {
      while (/\s/.test(src[i] ?? '')) i++;
      if (i >= src.length) fail(`The tag <${tag}> is not closed.`);
      if (src[i] === '>') {
        buf += '>';
        i++;
        break;
      }
      if (src.startsWith('/>', i)) {
        buf += '>';
        i += 2;
        break;
      }
      if (src[i] === '#' || src[i] === '{') fail('Placeholders and directives may only be used in text or inside a quoted attribute value.');
      const a = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(src.slice(i, i + 60));
      if (!a) fail(`Unexpected "${src[i]}" in <${tag}>.`);
      const attr = a![0].toLowerCase();
      if (!attrAllowed(tag, attr)) fail(attrProblem(tag, attr));
      i += a![0].length;
      while (/\s/.test(src[i] ?? '')) i++;
      if (src[i] !== '=') {
        if (!BOOLEAN_ATTRS.has(attr)) fail(`The attribute ${attr} needs a value.`);
        buf += ` ${attr}`;
        continue;
      }
      i++;
      while (/\s/.test(src[i] ?? '')) i++;
      const q = src[i];
      if (q !== '"' && q !== "'") fail(`The value of ${attr} must be in quotes.`);
      i++;
      buf += ` ${attr}=${q}`;
      const ctx = `a${attrN++}`;
      let prefix = '';
      let tokens = false;
      while (i < src.length && src[i] !== q) {
        if (token(ctx)) {
          tokens = true;
          continue;
        }
        if (src[i] === '<' || src[i] === '>') fail(`Write < and > in attribute values as &lt; and &gt;.`);
        if (!tokens) prefix += src[i];
        buf += src[i++];
      }
      if (i >= src.length) fail(`The value of ${attr} is not closed.`);
      buf += q;
      i++;
      // a fixed URL (or the fixed start of one) must be safe already; the rest is checked when rendered
      if (URL_ATTRS.has(attr) && !urlOk(tokens && !/:/.test(prefix) ? 'x' : prefix, attr))
        fail(`${attr}="${prefix}…": only http(s), mailto, tel and relative URLs are allowed (javascript: never).`);
    }
  }
  flush();
  return toks;
}

/** Tokens → a tree of directives; each block stays in one place (text, or one attribute value). */
function build(toks: Tok[], what: string): Node[] {
  let p = 0;
  const fail = (msg: string): never => {
    throw new TemplateError(`${what}: ${msg}`);
  };
  const test = (arg: string, d: string): Test => {
    const m = /^([?!]?)\s*([A-Za-z][A-Za-z0-9_$]*)$/.exec(arg);
    if (!m) fail(`{${d} ${arg}/}: write {${d} NAME/}, {${d} ?NAME/} or {${d} !NAME/}.`);
    return { op: m![1] as Test['op'], name: m![2].toUpperCase() };
  };
  const seq = (stop: string[], depth: number): [Node[], Extract<Tok, { k: 'dir' }> | null] => {
    if (depth > MAX_DEPTH) fail('Directives are nested too deeply.');
    const nodes: Node[] = [];
    while (p < toks.length) {
      const tk = toks[p++];
      if (tk.k === 'text') nodes.push({ t: 'text', s: tk.s });
      else if (tk.k === 'ph') nodes.push({ t: 'ph', name: tk.name, mod: tk.mod });
      else if (stop.includes(tk.d)) return [nodes, tk];
      else {
        const close = (end: Extract<Tok, { k: 'dir' }> | null, want: string) => {
          if (!end) fail(`{${tk.d}/} has no {${want}/}.`);
          if (end!.ctx !== tk.ctx) fail(`{${tk.d}/} and {${end!.d}/} must both be in the text or both in the same attribute value.`);
          return end!;
        };
        if (tk.d === 'if') {
          const branches: { test: Test; body: Node[] }[] = [];
          let t = test(tk.arg, 'if');
          let els: Node[] = [];
          for (;;) {
            const [body, end] = seq(['elsif', 'else', 'endif'], depth + 1);
            const e = close(end, 'endif');
            branches.push({ test: t, body });
            if (e.d === 'elsif') t = test(e.arg, 'elsif');
            else {
              if (e.d === 'else') {
                const [b2, end2] = seq(['endif'], depth + 1);
                close(end2, 'endif');
                els = b2;
              }
              break;
            }
          }
          nodes.push({ t: 'if', branches, else: els });
        } else if (tk.d === 'case') {
          if (!NAME.test(tk.arg)) fail(`{case ${tk.arg}/}: write {case NAME/}.`);
          const [lead, first] = seq(['when', 'otherwise', 'endcase'], depth + 1);
          if (lead.some((n) => n.t !== 'text' || n.s.trim())) fail('Only {when …/} may follow {case …/}.');
          let e = close(first, 'endcase');
          const whens: { value: string; body: Node[] }[] = [];
          let otherwise: Node[] = [];
          while (e.d === 'when') {
            const value = e.arg.replace(/^"(.*)"$/, '$1');
            const [body, end] = seq(['when', 'otherwise', 'endcase'], depth + 1);
            whens.push({ value, body });
            e = close(end, 'endcase');
          }
          if (e.d === 'otherwise') {
            const [body, end] = seq(['endcase'], depth + 1);
            close(end, 'endcase');
            otherwise = body;
          }
          nodes.push({ t: 'case', name: tk.arg.toUpperCase(), whens, otherwise });
        } else if (tk.d === 'loop') {
          const m = /^(?:"([^"]+)"\s+)?([A-Za-z][A-Za-z0-9_$]*)$/.exec(tk.arg);
          if (!m) fail(`{loop ${tk.arg}/}: write {loop NAME/} or {loop "," NAME/}.`);
          const [body, end] = seq(['endloop'], depth + 1);
          close(end, 'endloop');
          nodes.push({ t: 'loop', sep: m![1] ?? ':', name: m![2].toUpperCase(), body });
        } else fail(`{${tk.d}/} without its opening directive.`);
      }
    }
    return [nodes, null];
  };
  const [nodes, stray] = seq([], 0);
  if (stray) fail(`Unexpected {${stray.d}/}.`);
  return nodes;
}

export interface Compiled {
  item: Node[];
  wrapper: Node[] | null;
}

/** Where #APEX$ROWS# is: only in the wrapper's text, once, outside directives. */
function checkRows(nodes: Node[], wrapper: boolean, what: string) {
  const all = (ns: Node[], top: boolean): { top: number; nested: number } => {
    let top_ = 0;
    let nested = 0;
    for (const n of ns) {
      if (n.t === 'ph' && n.name === 'APEX$ROWS') top ? top_++ : nested++;
      const kids = n.t === 'if' ? [...n.branches.map((b) => b.body), n.else] : n.t === 'case' ? [...n.whens.map((w) => w.body), n.otherwise] : n.t === 'loop' ? [n.body] : [];
      for (const k of kids) {
        const r = all(k, false);
        nested += r.top + r.nested;
      }
    }
    return { top: top_, nested };
  };
  const r = all(nodes, true);
  if (!wrapper && r.top + r.nested) throw new TemplateError(`${what}: #APEX$ROWS# belongs in the wrapper.`);
  if (wrapper && (r.top !== 1 || r.nested)) throw new TemplateError(`${what}: the wrapper needs #APEX$ROWS# exactly once, outside directives.`);
}

export function compileTemplate(template: string, wrapper?: string | null): Compiled {
  if (template.length > MAX_TEMPLATE) throw new TemplateError(`Template: longer than ${MAX_TEMPLATE} characters.`);
  if (!template.trim()) throw new TemplateError('Template: it is empty.');
  const item = build(scan(template, 'Template'), 'Template');
  checkRows(item, false, 'Template');
  let w: Node[] | null = null;
  if (wrapper?.trim()) {
    if (wrapper.length > 5000) throw new TemplateError('Wrapper: longer than 5000 characters.');
    const toks = scan(wrapper, 'Wrapper');
    if (toks.some((t) => t.k === 'ph' && t.name === 'APEX$ROWS' && t.ctx !== 'text')) throw new TemplateError('Wrapper: #APEX$ROWS# must be in the text, not in an attribute.');
    w = build(toks, 'Wrapper');
    checkRows(w, true, 'Wrapper');
  }
  return { item, wrapper: w };
}

const cache = new Map<string, Compiled | TemplateError>();

/** Compiled (cached by text); throws TemplateError when the template isn't valid. */
export function compiled(c: Pick<TemplateComponent, 'template' | 'wrapper'>): Compiled {
  const key = `${c.template}\u0000${c.wrapper ?? ''}`;
  let hit = cache.get(key);
  if (!hit) {
    try {
      hit = compileTemplate(c.template, c.wrapper);
    } catch (e) {
      if (!(e instanceof TemplateError)) throw e;
      hit = e;
    }
    if (cache.size > 500) cache.clear();
    cache.set(key, hit);
  }
  if (hit instanceof TemplateError) throw hit;
  return hit;
}

// ---------------------------------------------------------------- checking a whole component

/** What's wrong with a component's attributes list, or null. */
export function attributesProblem(attrs: unknown): string | null {
  if (!Array.isArray(attrs)) return 'Attributes: a JSON list, e.g. [{"name": "STATUS", "label": "Status"}].';
  if (attrs.length > 30) return 'Attributes: at most 30.';
  const seen = new Set<string>();
  for (const a of attrs) {
    if (!a || typeof a !== 'object') return 'Attributes: each one is an object with a name.';
    const name = String(a.name ?? '');
    if (!/^[A-Z][A-Z0-9_]{0,29}$/.test(name)) return `Attribute "${name}": the name is upper case letters, digits and _ (e.g. STATUS).`;
    if (name === 'LINK') return 'Attribute LINK: that name is reserved for the link.';
    if (seen.has(name)) return `Attribute ${name}: listed twice.`;
    seen.add(name);
    if (a.type !== undefined && !(ATTRIBUTE_TYPES as readonly string[]).includes(a.type)) return `Attribute ${name}: the type is text, number, select or checkbox.`;
    if (a.type === 'select' && (!Array.isArray(a.options) || !a.options.length || a.options.some((o: unknown) => typeof o !== 'string')))
      return `Attribute ${name}: a select needs "options", a list of values.`;
    for (const k of ['label', 'default', 'help'])
      if (a[k] !== undefined && a[k] !== null && typeof a[k] !== 'string') return `Attribute ${name}: "${k}" is text.`;
  }
  return null;
}

/** What's wrong with a component (as saved or imported), or null. */
export function componentProblem(c: Partial<TemplateComponent>): string | null {
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(c.static_id ?? '')) return 'Static id: lower case letters, digits and _ (e.g. status_badge).';
  if (!c.name?.trim()) return 'Name: required.';
  for (const k of c.css_classes ?? []) if (!(LAYOUT_CLASSES as readonly string[]).includes(k)) return `CSS class ${k}: choose from ${LAYOUT_CLASSES.join(', ')}.`;
  const ap = attributesProblem(c.attributes ?? []);
  if (ap) return ap;
  try {
    compileTemplate(c.template ?? '', c.wrapper);
  } catch (e) {
    if (e instanceof TemplateError) return e.message;
    throw e;
  }
  return null;
}

/** A plug-in document → a component, or the reason it isn't one. */
export function parsePlugin(doc: unknown): TemplateComponent | string {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return 'A plug-in file is a JSON object.';
  const d = doc as Record<string, any>;
  if (d.format !== PLUGIN_FORMAT) return `Unsupported plug-in format ${JSON.stringify(d.format ?? null)} (expected ${PLUGIN_FORMAT}).`;
  if (d.type !== 'template_component') return `Unsupported plug-in type ${JSON.stringify(d.type ?? null)}.`;
  for (const k of ['static_id', 'name', 'template']) if (typeof d[k] !== 'string') return `"${k}" is missing.`;
  for (const k of ['description', 'version', 'wrapper']) if (d[k] !== undefined && d[k] !== null && typeof d[k] !== 'string') return `"${k}" is text.`;
  if (d.css_classes !== undefined && d.css_classes !== null && !(Array.isArray(d.css_classes) && d.css_classes.every((x: unknown) => typeof x === 'string'))) return '"css_classes" is a list of class names.';
  const c: TemplateComponent = {
    static_id: d.static_id, name: d.name, description: d.description ?? null, version: d.version ?? null,
    template: d.template, wrapper: d.wrapper ?? null, css_classes: d.css_classes ?? [], attributes: d.attributes ?? [],
  };
  return componentProblem(c) ?? c;
}

/** A component as a plug-in document (the same as meta.export_template_component). */
export function pluginDocument(c: TemplateComponent) {
  return {
    format: PLUGIN_FORMAT, type: 'template_component', static_id: c.static_id, name: c.name, description: c.description ?? null,
    version: c.version ?? null, template: c.template, wrapper: c.wrapper ?? null, css_classes: c.css_classes ?? [], attributes: c.attributes ?? [],
  };
}

// ---------------------------------------------------------------- rendering

/** A value's name → its text (undefined: unknown, renders as nothing). */
export type Lookup = (name: string) => string | undefined;

const truthy = (v: string | undefined) => v !== undefined && v !== '' && !/^(n|no|false)$/i.test(v.trim());

function renderNodes(nodes: Node[], get: Lookup, out: string[], rows?: string) {
  for (const n of nodes) {
    switch (n.t) {
      case 'text':
        out.push(n.s);
        break;
      case 'ph': {
        if (n.name === 'APEX$ROWS' && rows !== undefined) {
          out.push(rows); // the rendered rows: markup made by renderNodes itself
          break;
        }
        let v = get(n.name) ?? '';
        if (n.mod === 'STRIPHTML') v = v.replace(/<[^>]*>?/g, '');
        out.push(esc(v));
        break;
      }
      case 'if': {
        const b = n.branches.find(({ test }) => {
          const v = get(test.name);
          return test.op === '?' ? v !== undefined && v !== '' : test.op === '!' ? !truthy(v) : truthy(v);
        });
        renderNodes(b ? b.body : n.else, get, out, rows);
        break;
      }
      case 'case': {
        // {when a,b/}: any of the values, ignoring case
        const v = (get(n.name) ?? '').trim().toLowerCase();
        const w = n.whens.find((x) => x.value.split(',').some((s) => s.trim().toLowerCase() === v));
        renderNodes(w ? w.body : n.otherwise, get, out, rows);
        break;
      }
      case 'loop': {
        const v = get(n.name) ?? '';
        const parts = v === '' ? [] : v.split(n.sep).slice(0, 1000);
        parts.forEach((item, i) => {
          const inner: Lookup = (name) => (name === 'APEX$ITEM' ? item.trim() : name === 'APEX$I' ? String(i + 1) : get(name));
          renderNodes(n.body, inner, out, rows);
        });
        break;
      }
    }
  }
}

/**
 * The second line of defence: the rendered markup's URL attributes are
 * checked after substitution (a value may have been "javascript:…"), and
 * links to modal pages get data-dialog. Tags are whole and every attribute
 * value is quoted (scan() made sure), and substituted values contain no < > " '.
 */
export function finish(markup: string, modal: Set<string> = new Set()) {
  return markup.replace(/<([a-z][a-z0-9]*)(\s[^>]*)?>/g, (whole, tag: string, attrs: string | undefined) => {
    if (!attrs) return whole;
    let dialog = false;
    const kept = attrs.replace(/\s([a-z][a-z0-9-]*)(?:=("[^"]*"|'[^']*'))?/g, (a, name: string, quoted: string | undefined) => {
      if (!quoted || !URL_ATTRS.has(name)) return a;
      const value = quoted.slice(1, -1);
      if (!urlOk(value, name)) return '';
      if (tag === 'a' && name === 'href' && modal.has(value)) dialog = true;
      return a;
    });
    return `<${tag}${kept}${dialog ? ' data-dialog' : ''}>`;
  });
}

/** One instance per lookup, inside the wrapper when there is one and `multiple`. */
export function renderInstances(c: Compiled, rows: Lookup[], wrapperLookup: Lookup, multiple: boolean, modal?: Set<string>): string {
  const items = rows.map((get) => {
    const out: string[] = [];
    renderNodes(c.item, get, out);
    return out.join('');
  });
  if (!(multiple && c.wrapper)) return finish(items.join(''), modal);
  const out: string[] = [];
  renderNodes(c.wrapper, wrapperLookup, out, items.join(''));
  return finish(out.join(''), modal);
}

// ---------------------------------------------------------------- in an application

const loaded = new WeakMap<PageContext, Promise<Map<string, TemplateComponent>>>();

/** The application's components by static id, over the built-in ones (read once per request). */
export function componentsOf(ctx: PageContext) {
  let p = loaded.get(ctx);
  if (!p) {
    p = runtime
      .query('select static_id, name, template, wrapper, css_classes, attributes from meta.template_component where app_id = $1', [ctx.app.id])
      .then((r) => new Map<string, TemplateComponent>([...builtinComponents(), ...r.rows.map((x): [string, TemplateComponent] => [x.static_id, x as TemplateComponent])]));
    loaded.set(ctx, p);
  }
  return p;
}

/** "#COL#" (a row's value) and "&ITEM." (session state) in an attribute value, both as plain text. */
export function fillAttribute(text: string, ctx: PageContext | null, row: Lookup) {
  const state = ctx ? bindValues(ctx) : {};
  return text.replace(/#([A-Za-z][A-Za-z0-9_$]*)#|&([A-Za-z][A-Za-z0-9_]*)\./g, (m, col: string | undefined, item: string | undefined) => {
    if (col) return row(col.toUpperCase()) ?? '';
    const v = state[item!.toUpperCase()];
    return v === undefined ? m : (v ?? '');
  });
}

/** The value of each custom attribute where the component is used (or its default). */
export function attributeValues(c: TemplateComponent, use: TcUse) {
  const out = new Map<string, string>();
  for (const a of c.attributes ?? []) {
    let v = use.attributes?.[a.name] ?? a.default ?? '';
    if (a.type === 'checkbox') v = truthy(v) ? 'Y' : 'N';
    out.set(a.name, String(v));
  }
  return out;
}

/**
 * Lookup for one row: custom attributes first (with #COL# and &ITEM.
 * filled in), then LINK, APEX$ROW_NUM, then the row's columns.
 */
export function rowLookup(ctx: PageContext | null, attrs: Map<string, string>, columns: Map<string, string>, extra: Record<string, string | undefined> = {}): Lookup {
  const col: Lookup = (n) => columns.get(n) ?? extra[n];
  const memo = new Map<string, string>();
  return (name) => {
    if (attrs.has(name)) {
      if (!memo.has(name)) memo.set(name, fillAttribute(attrs.get(name)!, ctx, col));
      return memo.get(name);
    }
    return col(name);
  };
}

/** A {page, items} link for a row ("#col#" in item values), or undefined when the user may not open the page. */
export async function rowLinker(ctx: PageContext, link: { page?: unknown; items?: Record<string, string> } | undefined, modal: Set<string>) {
  const page = Number(link?.page);
  if (!link || !Number.isInteger(page) || !(await pageAllowed(ctx, page))) return undefined;
  return (row: Lookup) => {
    const items: Record<string, string> = {};
    for (const [k, v] of Object.entries(link.items ?? {})) items[k] = String(v).replace(/#([A-Za-z0-9_]+)#/g, (m, c: string) => row(c.toUpperCase()) ?? m);
    const href = pageHref(ctx, page, items);
    if (isModal(ctx, page)) modal.add(esc(href));
    return href;
  };
}

/**
 * Report column templates (region config "column_templates": {"col":
 * {"component": "static_id", "attributes": {...}}}): per column index, a
 * function that renders the cell. The row's values come formatted from the
 * report (text) and raw for links (plain). #LINK# is the report's link.
 */
export async function columnTemplates(
  ctx: PageContext,
  r: Region,
  fields: { name: string; dataTypeID: number }[],
  text: (v: unknown, typeOid: number) => string,
  plain: (v: unknown) => string,
) {
  const out = new Map<number, (row: unknown[], n: number) => Raw>();
  const conf = r.config.column_templates as Record<string, TcUse> | undefined;
  if (!conf || typeof conf !== 'object') return out;
  const comps = await componentsOf(ctx);
  const modal = new Set<string>();
  const link = r.config.link as { page: number; items?: Record<string, string> } | undefined;
  const linker = await rowLinker(ctx, link, modal);
  for (const [col, use] of Object.entries(conf)) {
    const i = fields.findIndex((f) => f.name.toLowerCase() === col.toLowerCase());
    const c = use?.component ? comps.get(use.component) : undefined;
    if (i < 0 || !c) continue;
    let comp: Compiled;
    try {
      comp = compiled(c);
    } catch {
      continue; // an invalid template: the plain value shows
    }
    const attrs = attributeValues(c, use);
    out.set(i, (row, n) => {
      const columns = new Map(fields.map((f, j) => [f.name.toUpperCase(), text(row[j], f.dataTypeID)]));
      const raws = new Map(fields.map((f, j) => [f.name.toUpperCase(), plain(row[j])]));
      const get = rowLookup(ctx, attrs, columns, {
        APEX$ROW_NUM: String(n),
        LINK: linker?.((x) => raws.get(x)),
      });
      return raw(renderInstances(comp, [get], get, false, modal));
    });
  }
  return out;
}
