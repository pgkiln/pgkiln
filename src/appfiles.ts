// The "dir" layout of an application export: one file per component, for
// git. It is a lossless re-arrangement of the pgapex/2 document that
// meta.export_app() returns (docToFiles), and back (filesToDoc), so
// meta.import_app() stays the only importer.
//
// Rules (see docs/guide/18-cli.md):
// - JSON with sorted keys, two-space indent, LF, a trailing newline.
// - No database ids anywhere: components are named by a *static id*, a
//   key derived from their name (or title) that is unique among their
//   siblings. A file is named <seq>-<key>.json; references between
//   components (an item's region, a facet region's report, a navigation
//   entry's parent) use keys instead of ids.
// - Long or multi-line code (SQL, PL/pgSQL, templates) moves to a sibling
//   file <base>.<column>.<ext>; the column is then left out of the JSON.
// - Binary values (logos, the PWA icon) are written as binary files.
// - Sections and columns this file does not know travel unchanged
//   (columns in the component's JSON, unknown sections in extra/).

import { zipSync, type Zippable } from 'fflate';

export type Doc = Record<string, any>;
/** posix path relative to the application directory → contents */
export type FileMap = Map<string, Buffer>;

export const LAYOUT = 1;
export const MARKER = 'pgapex.json';

// ------------------------------------------------------------------ helpers

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

/** Deterministic JSON text: sorted keys, two spaces, trailing newline. */
export const stableJson = (v: unknown) => JSON.stringify(sortKeys(v), null, 2) + '\n';

/** A file-name-safe key: lower case ASCII letters, digits and dashes. */
export function slug(s: unknown) {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '');
}

/** Keys for rows in their order: slug of the name, -2, -3 … for duplicates. */
export function uniqueKeys<T>(rows: T[], name: (row: T) => unknown, fallback = 'item') {
  const seen = new Set<string>();
  return rows.map((r) => {
    const base = slug(name(r)) || fallback;
    let key = base;
    for (let n = 2; seen.has(key); n++) key = `${base}-${n}`;
    seen.add(key);
    return key;
  });
}

/** Sortable, dash-free prefix for a sequence number: 0010, m0005 (negative), none. */
export function seqPrefix(seq: unknown) {
  if (typeof seq !== 'number' || !Number.isFinite(seq)) return 'none';
  return (seq < 0 ? 'm' : '') + String(Math.abs(Math.trunc(seq))).padStart(4, '0');
}

/** The static id of a region (unique on its page): from its title, else its type. */
export function regionKeys(regions: { title?: unknown; type?: unknown }[]) {
  return uniqueKeys(regions, (r) => slug(r.title) || slug(r.type), 'region');
}

const SEQ_SORT = (a: { row: any; base: string }, b: { row: any; base: string }) =>
  (a.row.seq ?? 0) - (b.row.seq ?? 0) || (a.base < b.base ? -1 : a.base > b.base ? 1 : 0);

function sniff(b: Buffer) {
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
  if (b.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (/^\s*(<\?xml|<svg)/.test(b.subarray(0, 100).toString('utf8'))) return 'svg';
  return 'bin';
}

// Code columns that move to a sibling file when they are long or multi-line.
const CODE: Record<string, Record<string, string>> = {
  region: { source: 'sql', condition: 'sql' },
  item: { default_value: 'sql', readonly_condition: 'sql' },
  button: { condition: 'sql', badge_query: 'sql' },
  dynamic_action: { code: 'sql' },
  validation: { expression: 'sql' },
  process: { code: 'sql' },
  computation: { expression: 'sql', condition_expr: 'sql' },
  branch: { condition_expr: 'sql' },
  app_process: { code: 'sql' },
  authz_scheme: { value: 'sql' },
  lov: { query: 'sql' },
  automation: { query: 'sql', code: 'sql' },
  document_template: { query: 'sql', template: 'html' },
  task_definition: { action_code: 'sql' },
  template_component: { template: 'html', wrapper: 'html' },
  rest_source: { body: 'json' },
};
const isLong = (v: unknown): v is string => typeof v === 'string' && (v.includes('\n') || v.length > 60);
const codeExt = (table: string, column: string, row: any) =>
  table === 'region' && column === 'source' && row.type === 'static' ? 'html' : CODE[table][column];

class Writer {
  files: FileMap = new Map();
  text(path: string, s: string) {
    this.files.set(path, Buffer.from(s, 'utf8'));
  }
  json(path: string, v: unknown) {
    this.text(path, stableJson(v));
  }
  /** <dir>/<base>.json plus <base>.<column>.<ext> for long code columns. */
  record(dir: string, base: string, table: string, row: Record<string, any>) {
    const r = { ...row };
    for (const column of Object.keys(CODE[table] ?? {})) {
      if (isLong(r[column])) {
        this.text(`${dir}/${base}.${column}.${codeExt(table, column, r)}`, r[column] + '\n');
        delete r[column];
      }
    }
    this.json(`${dir}/${base}.json`, r);
  }
}

// ------------------------------------------------------------------ sections

/** Shared components with a unique name: one file each. */
const NAMED: [section: string, dir: string, table: string][] = [
  ['authz_schemes', 'shared/authorizations', 'authz_scheme'],
  ['app_items', 'shared/app-items', 'app_item'],
  ['lovs', 'shared/lovs', 'lov'],
  ['report_layouts', 'shared/report-layouts', 'report_layout'],
  ['automations', 'shared/automations', 'automation'],
  ['document_templates', 'shared/document-templates', 'document_template'],
  ['task_definitions', 'shared/task-definitions', 'task_definition'],
  ['workflow_definitions', 'shared/workflow-definitions', 'workflow_definition'],
  ['rest_modules', 'shared/rest-modules', 'rest_module'],
  ['template_components', 'shared/template-components', 'template_component'],
  ['build_options', 'shared/build-options', 'build_option'],
  ['web_credentials', 'shared/web-credentials', 'web_credential'],
  ['rest_sources', 'shared/rest-sources', 'rest_source'],
  ['data_load_definitions', 'shared/data-load-definitions', 'data_load_def'],
];

/** Components of a page: [array in the document, directory, table, key source]. */
const PAGE_PARTS: [section: string, dir: string, table: string, key: (r: any) => unknown][] = [
  ['regions', 'regions', 'region', () => null], // keys from regionKeys()
  ['items', 'items', 'item', (r) => r.name],
  ['buttons', 'buttons', 'button', (r) => r.name || r.label],
  ['dynamic_actions', 'dynamic-actions', 'dynamic_action', (r) => r.name || `${r.event ?? ''} ${r.action ?? ''}`],
  ['validations', 'validations', 'validation', (r) => r.name || r.item_name],
  ['processes', 'processes', 'process', (r) => r.name || r.type],
  ['computations', 'computations', 'computation', (r) => `${r.item_name ?? ''} ${r.point ?? ''}`],
  ['branches', 'branches', 'branch', (r) => r.name],
];

/** Single files: [section, path, sort columns]. */
const SINGLE: [section: string, path: string, sort: string[]][] = [
  ['group_roles', 'shared/group-roles.json', ['group_name', 'role']],
  ['text_messages', 'globalization/text-messages.json', ['name', 'language']],
];

const KNOWN = new Set(['format', 'app', 'app_processes', 'translations', 'nav', 'pages', ...NAMED.map((n) => n[0]), ...SINGLE.map((s) => s[0])]);

const byColumns = (cols: string[]) => (a: any, b: any) => {
  for (const c of cols) {
    const x = String(a[c] ?? ''), y = String(b[c] ?? '');
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
};

// ------------------------------------------------------------------ doc → files

export function docToFiles(doc: Doc): FileMap {
  if (doc?.format !== 'pgapex/2') throw new Error(`unsupported export format ${doc?.format ?? '(none)'}`);
  const w = new Writer();
  w.json(MARKER, { format: doc.format, layout: LAYOUT });

  const app = { ...doc.app };
  if (typeof app.pwa_icon === 'string' && app.pwa_icon.startsWith('\\x')) {
    const bin = Buffer.from(app.pwa_icon.slice(2), 'hex');
    w.files.set(`app.pwa_icon.${sniff(bin)}`, bin);
    delete app.pwa_icon;
  }
  w.json('app.json', app);

  for (const [section, dir, table] of NAMED) {
    const rows: any[] = doc[section] ?? [];
    const keys = uniqueKeys(rows, (r) => (table === 'template_component' ? r.static_id : r.name), table);
    rows.forEach((row, i) => {
      const r = { ...row };
      if (table === 'report_layout' && typeof r.logo === 'string') {
        const bin = Buffer.from(r.logo.replace(/\s+/g, ''), 'base64');
        w.files.set(`${dir}/${keys[i]}.logo.${sniff(bin)}`, bin);
        delete r.logo;
      }
      w.record(dir, keys[i], table, r);
    });
  }

  const procs: any[] = doc.app_processes ?? [];
  uniqueKeys(procs, (r) => r.name, 'process').forEach((k, i) => w.record('shared/app-processes', `${seqPrefix(procs[i].seq)}-${k}`, 'app_process', procs[i]));

  for (const [section, path, sort] of SINGLE) w.json(path, [...(doc[section] ?? [])].sort(byColumns(sort)));

  const byLang = new Map<string, any[]>();
  for (const t of doc.translations ?? []) {
    const lang = String(t.language ?? '');
    byLang.set(lang, [...(byLang.get(lang) ?? []), t]);
  }
  for (const [lang, rows] of byLang) w.json(`globalization/translations/${slug(lang) || 'none'}.json`, rows.sort(byColumns(['source'])));

  w.json('navigation.json', navTree(doc.nav ?? []));

  for (const page of doc.pages ?? []) writePage(w, page);

  for (const section of Object.keys(doc).filter((k) => !KNOWN.has(k)).sort()) w.json(`extra/${section}.json`, doc[section]);
  return w.files;
}

/** Navigation as a tree: children nested, ordered by sequence and label; no ids. */
function navTree(nav: any[]) {
  const byParent = new Map<unknown, any[]>();
  for (const n of nav) byParent.set(n.parent_id ?? null, [...(byParent.get(n.parent_id ?? null) ?? []), n]);
  const ids = new Set(nav.map((n) => n.id));
  const build = (parent: unknown): any[] =>
    (byParent.get(parent) ?? [])
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || byColumns(['label'])(a, b))
      .map((n) => {
        const { id, parent_id, ...rest } = n;
        const children = build(id);
        return children.length ? { ...rest, children } : rest;
      });
  // entries whose parent is missing would otherwise vanish: list them at the top
  const orphans = nav.filter((n) => n.parent_id != null && !ids.has(n.parent_id)).map((n) => n.parent_id);
  return [...build(null), ...[...new Set(orphans)].flatMap(build)];
}

function writePage(w: Writer, page: any) {
  const dir = `pages/${seqPrefix(page.page_no)}-${slug(page.name) || 'page'}`;
  const regions: any[] = page.regions ?? [];
  const rkeys = regionKeys(regions);
  const keyOf = new Map<unknown, string>(regions.map((r, i) => [r.id, rkeys[i]]));
  const ref = (id: unknown) => (id == null ? null : (keyOf.get(id) ?? id));

  const meta = { ...page };
  for (const [section] of PAGE_PARTS) delete meta[section];
  // arrays this file does not know yet stay in page.json, with region references as keys
  for (const [k, v] of Object.entries(meta)) if (Array.isArray(v)) meta[k] = v.map((row) => toRefs(row, ref));
  w.json(`${dir}/page.json`, meta);

  regions.forEach((r, i) => {
    const { id, ...row } = r;
    if (row.config && typeof row.config === 'object' && typeof row.config.report === 'number' && keyOf.has(row.config.report))
      row.config = { ...row.config, report: keyOf.get(row.config.report) };
    w.record(`${dir}/regions`, `${seqPrefix(r.seq)}-${rkeys[i]}`, 'region', row);
  });
  for (const [section, sub, table, key] of PAGE_PARTS.slice(1)) {
    const rows: any[] = page[section] ?? [];
    uniqueKeys(rows, key, table).forEach((k, i) => w.record(`${dir}/${sub}`, `${seqPrefix(rows[i].seq)}-${k}`, table, toRefs(rows[i], ref)));
  }
}

/** region_id / affected_region_id → region / affected_region (static ids). */
function toRefs(row: any, ref: (id: unknown) => unknown) {
  if (!row || typeof row !== 'object') return row;
  const { region_id, affected_region_id, ...rest } = row;
  if ('region_id' in row) rest.region = ref(region_id);
  if ('affected_region_id' in row) rest.affected_region = ref(affected_region_id);
  return rest;
}

/** The reverse of toRefs. */
function fromRefs(row: any, deref: (key: unknown) => unknown) {
  if (!row || typeof row !== 'object') return row;
  const { region, affected_region, ...rest } = row;
  if ('region' in row) rest.region_id = deref(region);
  if ('affected_region' in row) rest.affected_region_id = deref(affected_region);
  return rest;
}

// ------------------------------------------------------------------ files → doc

/** Records in one directory: <base>.json merged with its <base>.<column>.<ext> files. */
function readRecords(files: FileMap, dir: string) {
  const prefix = dir + '/';
  const recs = new Map<string, { base: string; row: any; extra: [string, Buffer][] }>();
  const others: [string, string, Buffer][] = [];
  for (const [path, buf] of files) {
    if (!path.startsWith(prefix)) continue;
    const name = path.slice(prefix.length);
    if (name.includes('/')) continue;
    const m = /^([^.]+)\.json$/.exec(name);
    if (m) recs.set(m[1], { base: m[1], row: parseJson(path, buf), extra: [] });
    else others.push([path, name, buf]);
  }
  for (const [path, name, buf] of others) {
    const m = /^([^.]+)\.([a-z_][a-z0-9_]*)\.[a-z0-9]+$/.exec(name);
    const rec = m && recs.get(m[1]);
    if (!m || !rec) throw new Error(`${path}: not part of a component (expected <name>.json, or <name>.<column>.<ext> next to it)`);
    rec.extra.push([m[2], buf]);
  }
  return [...recs.values()];
}

const parseJson = (path: string, buf: Buffer) => {
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (e) {
    throw new Error(`${path}: ${(e as Error).message}`);
  }
};

/** File contents → column value: text without the one trailing newline the writer adds. */
function codeValue(buf: Buffer) {
  const s = buf.toString('utf8');
  return s.endsWith('\n') ? s.slice(0, -1) : s;
}

function mergeCode(rec: { row: any; extra: [string, Buffer][] }) {
  for (const [column, buf] of rec.extra) rec.row[column] = codeValue(buf);
  return rec.row;
}

const keyFromBase = (base: string) => base.slice(base.indexOf('-') + 1);

export function filesToDoc(files: FileMap): Doc {
  const marker = files.get(MARKER);
  if (!marker) throw new Error(`${MARKER} not found: not a pgapex application directory`);
  const m = parseJson(MARKER, marker);
  if (m.format !== 'pgapex/2') throw new Error(`unsupported export format ${m.format ?? '(none)'}`);
  if (typeof m.layout === 'number' && m.layout > LAYOUT) throw new Error(`directory layout ${m.layout} is newer than this pgapex understands (${LAYOUT})`);
  const read = (path: string, dflt: unknown = []) => (files.has(path) ? parseJson(path, files.get(path)!) : dflt);

  const doc: Doc = { format: 'pgapex/2' };
  if (!files.has('app.json')) throw new Error('app.json not found');
  doc.app = read('app.json');
  for (const [path, buf] of files)
    if (/^app\.pwa_icon\.[a-z0-9]+$/.test(path)) doc.app.pwa_icon = '\\x' + buf.toString('hex');

  for (const [section, dir, table] of NAMED) {
    doc[section] = readRecords(files, dir)
      .sort((a, b) => (a.base < b.base ? -1 : 1))
      .map((rec) => {
        if (table === 'report_layout') {
          const logo = rec.extra.find(([c]) => c === 'logo');
          if (logo) {
            rec.row.logo = logo[1].toString('base64');
            rec.extra = rec.extra.filter(([c]) => c !== 'logo');
          }
        }
        return mergeCode(rec);
      });
  }
  doc.app_processes = readRecords(files, 'shared/app-processes').sort(SEQ_SORT).map(mergeCode);
  for (const [section, path] of SINGLE) doc[section] = read(path);
  doc.translations = [...files.keys()]
    .filter((p) => /^globalization\/translations\/[^/]+\.json$/.test(p))
    .sort()
    .flatMap((p) => read(p));

  let navId = 0;
  const flat: any[] = [];
  const walk = (entries: any[], parent: number | null) => {
    for (const e of entries) {
      const { children, ...row } = e;
      const id = ++navId;
      flat.push({ ...row, id, parent_id: parent });
      walk(children ?? [], id);
    }
  };
  walk(read('navigation.json'), null);
  doc.nav = flat;

  const pageDirs = [...new Set([...files.keys()].map((p) => /^pages\/([^/]+)\//.exec(p)?.[1]).filter((d): d is string => !!d))].sort();
  let regionId = 0;
  doc.pages = pageDirs
    .map((d) => {
      const dir = `pages/${d}`;
      if (!files.has(`${dir}/page.json`)) throw new Error(`${dir}/page.json not found`);
      const page = read(`${dir}/page.json`);
      const regions = readRecords(files, `${dir}/regions`).sort(SEQ_SORT);
      const idOf = new Map<string, number>(regions.map((r) => [keyFromBase(r.base), ++regionId]));
      const deref = (path: string, key: unknown) => {
        if (key == null || typeof key === 'number') return key ?? null;
        const id = idOf.get(String(key));
        if (id === undefined) throw new Error(`${path}: no region "${key}" on this page`);
        return id;
      };
      page.regions = regions.map((rec) => {
        const row = mergeCode(rec);
        if (row.config && typeof row.config.report === 'string')
          row.config = { ...row.config, report: deref(`${dir}/regions/${rec.base}.json`, row.config.report) };
        return { id: idOf.get(keyFromBase(rec.base)), ...row };
      });
      for (const [section, sub] of PAGE_PARTS.slice(1))
        page[section] = readRecords(files, `${dir}/${sub}`)
          .sort(SEQ_SORT)
          .map((rec) => fromRefs(mergeCode(rec), (key) => deref(`${dir}/${sub}/${rec.base}.json`, key)));
      for (const [k, v] of Object.entries(page))
        if (Array.isArray(v) && !PAGE_PARTS.some(([section]) => section === k)) page[k] = v.map((row) => fromRefs(row, (key) => deref(`${dir}/page.json`, key)));
      return page;
    })
    .sort((a, b) => (a.page_no ?? 0) - (b.page_no ?? 0));

  for (const p of [...files.keys()].sort()) {
    const x = /^extra\/([a-z0-9_]+)\.json$/.exec(p);
    if (x) doc[x[1]] = read(p);
  }
  return doc;
}

/** The files as a zip with one folder (deterministic: fixed timestamps, sorted entries). */
export function filesToZip(files: FileMap, folder: string): Uint8Array {
  const entries: Zippable = {};
  for (const path of [...files.keys()].sort()) entries[`${folder}/${path}`] = [files.get(path)!, { mtime: new Date('2000-01-01T00:00:00Z') }];
  return zipSync(entries, { level: 6 });
}
