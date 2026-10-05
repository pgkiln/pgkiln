// A small, safe XML reader for data loading (no dependency).
//
// Safe by construction against XXE and entity expansion ("billion laughs"):
// a document type declaration (<!DOCTYPE …>) is refused, so no external or
// internal entities can be declared; only the five predefined entities and
// character references are understood. Nesting depth, the number of
// elements, attributes per element and name lengths are limited, and the
// reader never fetches anything. It is a non-validating reader of
// well-formed XML 1.0: elements, attributes, text, CDATA, comments and
// processing instructions (skipped). Namespace prefixes are dropped from
// names (local names are used).

export class XmlError extends Error {}

export interface XmlLimits {
  /** deepest element nesting (default 100) */
  maxDepth?: number;
  /** elements in the document (default 5,000,000) */
  maxElements?: number;
  /** attributes on one element (default 256) */
  maxAttributes?: number;
  /** characters in an element or attribute name (default 256) */
  maxName?: number;
}

export interface XmlHandler {
  open(name: string, attrs: [string, string][], depth: number): void;
  text(text: string): void;
  close(name: string, depth: number): void;
}

// a name: no white space or markup characters, not starting with a digit, "." or "-" (lenient on the exact XML name classes)
const NAME = /[^\s<>/=!?"'&;,()[\]{}|^`~*+\\0-9.-][^\s<>/=!?"'&;,()[\]{}|^`~*+\\]*/y;
const PREDEFINED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

const local = (name: string) => name.slice(name.indexOf(':') + 1);

/** Read a document, calling the handler for each element and text run. Throws XmlError. */
export function scanXml(xml: string, h: XmlHandler, limits: XmlLimits = {}) {
  const maxDepth = limits.maxDepth ?? 100;
  const maxElements = limits.maxElements ?? 5_000_000;
  const maxAttributes = limits.maxAttributes ?? 256;
  const maxName = limits.maxName ?? 256;
  const n = xml.length;
  const stack: string[] = [];
  let i = 0;
  let elements = 0;
  let rootDone = false;

  const fail = (message: string, at = i): never => {
    let line = 1;
    let col = 1;
    for (let k = 0; k < at && k < n; k++) {
      if (xml.charCodeAt(k) === 10) {
        line++;
        col = 1;
      } else col++;
    }
    throw new XmlError(`${message} (line ${line}, column ${col})`);
  };

  const decode = (s: string, at: number) => {
    if (!s.includes('&')) return s;
    return s.replace(/&([^;&\s]{0,32});?/g, (m, ref: string) => {
      if (!m.endsWith(';')) fail('An "&" must start an entity such as &amp;', at);
      if (ref[0] === '#') {
        const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : /^\d+$/.test(ref.slice(1)) ? parseInt(ref.slice(1), 10) : NaN;
        const ok = code === 0x9 || code === 0xa || code === 0xd || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff);
        if (!ok || !/^#(x[0-9a-fA-F]+|\d+)$/.test(ref)) fail(`Invalid character reference &${ref};`, at);
        return String.fromCodePoint(code);
      }
      if (!(ref in PREDEFINED)) fail(`Undefined entity &${ref}; (only &lt; &gt; &amp; &quot; &apos; and character references are allowed)`, at);
      return PREDEFINED[ref];
    });
  };

  const name = () => {
    NAME.lastIndex = i;
    const m = NAME.exec(xml);
    if (!m) fail('A name was expected');
    if (m![0].length > maxName) fail(`A name is longer than ${maxName} characters`);
    i += m![0].length;
    return m![0];
  };
  const space = () => {
    while (i < n && (xml[i] === ' ' || xml[i] === '\t' || xml[i] === '\n' || xml[i] === '\r')) i++;
  };

  while (i < n) {
    if (xml[i] !== '<') {
      // text
      const end = xml.indexOf('<', i);
      const stop = end === -1 ? n : end;
      const raw = xml.slice(i, stop);
      if (!stack.length) {
        if (raw.trim()) fail(rootDone ? 'Text after the root element' : 'Text before the root element');
      } else {
        if (raw.includes(']]>')) fail('"]]>" is not allowed in text');
        h.text(decode(raw, i));
      }
      i = stop;
      continue;
    }
    if (xml.startsWith('<!--', i)) {
      const end = xml.indexOf('-->', i + 4);
      if (end === -1) fail('Unterminated comment');
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', i)) {
      if (!stack.length) fail('CDATA outside the root element');
      const end = xml.indexOf(']]>', i + 9);
      if (end === -1) fail('Unterminated CDATA section');
      h.text(xml.slice(i + 9, end));
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<!', i)) {
      if (/^<!DOCTYPE/i.test(xml.slice(i, i + 9))) fail('XML with a document type declaration (<!DOCTYPE>) is not accepted: DTDs and entity declarations are not allowed');
      fail('Unexpected "<!"');
    }
    if (xml.startsWith('<?', i)) {
      const end = xml.indexOf('?>', i + 2);
      if (end === -1) fail('Unterminated processing instruction');
      i = end + 2;
      continue;
    }
    if (xml.startsWith('</', i)) {
      i += 2;
      const tag = name();
      space();
      if (xml[i] !== '>') fail('">" expected');
      i++;
      const open = stack.pop();
      if (open !== tag) fail(open ? `</${tag}> does not close <${open}>` : `</${tag}> has no start tag`);
      h.close(local(tag), stack.length + 1);
      if (!stack.length) rootDone = true;
      continue;
    }
    // start tag
    const at = i;
    i++;
    if (rootDone) fail('Only one root element is allowed');
    const tag = name();
    const attrs: [string, string][] = [];
    const seen = new Set<string>();
    for (;;) {
      const before = i;
      space();
      if (xml[i] === '>' || xml.startsWith('/>', i)) break;
      if (i === before) fail('Space expected between attributes');
      const an = name();
      space();
      if (xml[i] !== '=') fail('"=" expected after an attribute name');
      i++;
      space();
      const q = xml[i];
      if (q !== '"' && q !== "'") fail('An attribute value must be quoted');
      const end = xml.indexOf(q, i + 1);
      if (end === -1) fail('Unterminated attribute value');
      const raw = xml.slice(i + 1, end);
      if (raw.includes('<')) fail('"<" is not allowed in an attribute value');
      if (seen.has(an)) fail(`Duplicate attribute ${an}`);
      seen.add(an);
      if (seen.size > maxAttributes) fail(`More than ${maxAttributes} attributes on one element`);
      // namespace declarations are not data
      if (an !== 'xmlns' && !an.startsWith('xmlns:')) attrs.push([local(an), decode(raw, i).replace(/[\t\n\r]/g, ' ')]);
      i = end + 1;
    }
    if (++elements > maxElements) fail(`More than ${maxElements} elements`, at);
    if (stack.length + 1 > maxDepth) fail(`Elements are nested deeper than ${maxDepth} levels`, at);
    const selfClosing = xml[i] === '/';
    i += selfClosing ? 2 : 1;
    h.open(local(tag), attrs, stack.length + 1);
    if (selfClosing) {
      h.close(local(tag), stack.length + 1);
      if (!stack.length) rootDone = true;
    } else stack.push(tag);
  }
  if (stack.length) fail(`<${stack[stack.length - 1]}> is not closed`, n);
  if (!rootDone) fail('The document has no root element', n);
}

export interface XmlTable {
  /** the path of the row elements, e.g. "employees/employee" */
  rowPath: string;
  headers: string[];
  rows: (string | null)[][];
}

/**
 * The rows of a document: one per repeating element. The row element is
 * `rowTag` (a name, or a path ending in it: "employees/employee"), or the
 * element path that occurs most often among elements with children or
 * attributes. Columns are the row's attributes ("@id"), child elements
 * ("name") and deeper elements by path ("address/city"); a row element with
 * text only is one column named after it.
 */
export function xmlTable(xml: string, rowTag?: string | null, opts: XmlLimits & { maxRows?: number } = {}): XmlTable {
  const maxRows = opts.maxRows ?? Infinity;
  let rowPath: string;
  if (rowTag?.trim()) {
    rowPath = rowTag.trim().replace(/^\/+|\/+$/g, '');
    if (!/^[^/\s]+(\/[^/\s]+)*$/.test(rowPath)) throw new XmlError(`"${rowTag}" is not an element name or path`);
  } else {
    // first pass: count element paths
    const counts = new Map<string, { n: number; rich: boolean; depth: number }>();
    const path: string[] = [];
    const rich: boolean[] = [];
    scanXml(
      xml,
      {
        open(name, attrs) {
          if (rich.length) rich[rich.length - 1] = true;
          path.push(name);
          rich.push(attrs.length > 0);
        },
        text() {},
        close() {
          const p = path.join('/');
          const c = counts.get(p) ?? { n: 0, rich: false, depth: path.length };
          c.n++;
          c.rich ||= rich[rich.length - 1];
          counts.set(p, c);
          path.pop();
          rich.pop();
        },
      },
      opts,
    );
    const all = [...counts].filter(([, c]) => c.depth > 1);
    const pick = (list: typeof all) => list.sort((a, b) => b[1].n - a[1].n || a[1].depth - b[1].depth)[0];
    const best = pick(all.filter(([, c]) => c.rich)) ?? pick(all) ?? [...counts][0];
    rowPath = best[0].split('/').slice(1).join('/') || best[0];
  }
  const want = rowPath.split('/').map(local);

  const headers: string[] = [];
  const index = new Map<string, number>();
  const rows: (string | null)[][] = [];
  const path: string[] = [];
  let rowDepth = 0; // depth of the current row element (0: not in a row)
  let row: Map<string, string> | null = null;
  let texts: string[] = []; // text of the open elements inside the row
  const col = (key: string) => {
    if (!index.has(key)) {
      index.set(key, headers.length);
      headers.push(key);
    }
  };
  const matches = () => want.length <= path.length && want.every((w, k) => path[path.length - want.length + k] === w);

  scanXml(
    xml,
    {
      open(name, attrs, depth) {
        path.push(name);
        if (!row && matches()) {
          rowDepth = depth;
          row = new Map();
          texts = [''];
          for (const [a, v] of attrs) {
            col(`@${a}`);
            row.set(`@${a}`, v);
          }
          return;
        }
        if (row) {
          texts.push('');
          const rel = path.slice(rowDepth).join('/');
          for (const [a, v] of attrs) {
            const key = `${rel}/@${a}`;
            col(key);
            if (!row.has(key)) row.set(key, v);
          }
        }
      },
      text(t) {
        if (row) texts[texts.length - 1] += t;
      },
      close(name, depth) {
        if (row) {
          const t = texts.pop()!.trim();
          if (depth === rowDepth) {
            // a row element with text only: one column
            if (t && !row.size) {
              col(name);
              row.set(name, t);
            }
            if (rows.length >= maxRows) throw new XmlError(`The file has more than ${maxRows} rows`);
            rows.push(headers.map((h) => row!.get(h) ?? null));
            row = null;
            rowDepth = 0;
          } else {
            const rel = path.slice(rowDepth).join('/');
            // elements with children are containers; their own text is ignored
            if (!headersWithPrefix(index, `${rel}/`)) {
              col(rel);
              if (t && !row.has(rel)) row.set(rel, t);
            }
          }
        }
        path.pop();
      },
    },
    opts,
  );
  if (!rows.length) throw new XmlError(`No <${want[want.length - 1]}> elements were found`);
  // rows read before a column first appeared are shorter
  return { rowPath, headers, rows: rows.map((r) => (r.length < headers.length ? [...r, ...Array(headers.length - r.length).fill(null)] : r)) };
}

function headersWithPrefix(index: Map<string, number>, prefix: string) {
  for (const k of index.keys()) if (k.startsWith(prefix)) return true;
  return false;
}
