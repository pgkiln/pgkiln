// (sprint 242, MG-16) Keys left out of hand-written application files take the column's default.
//
// meta.import_app() reads each component with jsonb_populate_record(null::meta.<table>, …): a key that is absent
// becomes NULL, and a NOT NULL column (app.debug, page.protection …) then fails with a raw constraint error. An
// export always writes every column, so this only bites files written by hand (or by a generator). Before an import,
// fillDefaults() gives every component the defaults of the columns its file leaves out, read from the catalog
// (pg_attrdef), so there is no hand list to keep up to date:
//  - only a key that is ABSENT is filled; a key that is present with null stays null (and fails as before when the
//    column is NOT NULL), so "I want no value" and "I did not say" stay different;
//  - only constant defaults ('checksum', false, 10, '{}'::jsonb …): never a sequence, now() or another function;
//  - never a column the export leaves out on purpose (ids, the installation's state such as build_status or
//    availability, secrets): those stay as meta.import_app() and replace.ts treat them.
// Each filled key is reported (the import's result, the Advisor's notes), with the file it was missing from.
// A NOT NULL column without a default that is missing still fails, but explainNotNull() turns the constraint error
// into one that names the file, the component and the key. fillFiles() does the same to the files themselves, so
// diff_app shows no change for a key whose default equals the exported value.
import { ACTIONS_DIR, APP_COMPUTATIONS_DIR, NAMED, PAGE_PARTS, SINGLE, sourceOf, stableJson, type Doc, type FileMap } from './appfiles.ts';
import { fromText, toText } from './yamltext.ts';
import { UsageError } from './cli/apps.ts';
import { formatProblems, normalizeConditionKeys, normalizeConditionRow } from './import-errors.ts';

/** table → column → its default (as JSON), for the columns an import fills when a file leaves them out. */
export type ColumnDefaults = Record<string, Record<string, unknown>>;

/** Keys filled from the column defaults, per file (or component, for a document without files). */
export interface FilledKeys {
  where: string;
  /** the file, relative to the application directory, when the document was read from files */
  file: string | null;
  keys: string[];
}

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

/** Doc sections of one row per component → table. */
const SECTIONS: [section: string, table: string][] = [
  ...NAMED.map(([section, , table]) => [section, table] as [string, string]),
  ['app_processes', 'app_process'],
  ['app_computations', 'app_computation'],
  ['group_roles', 'app_group_role'],
  ['text_messages', 'text_message'],
  ['dynamic_translations', 'dynamic_translation'],
  ['translations', 'translation'],
  ['nav', 'nav_entry'],
  ['list_entries', 'list_entry'],
  ['automation_actions', 'automation_action'],
  ['static_files', 'static_file'],
];

/** Every table an export writes rows of. */
export const TABLES = [...new Set(['app', 'page', ...SECTIONS.map(([, t]) => t), ...PAGE_PARTS.map(([, , t]) => t)])];

/** Columns an import never fills: ids and references (the importer sets them), and what meta.export_app() leaves out. */
const NEVER = new Set(['id', 'app_id', 'page_id', 'parent_id', 'region_id', 'affected_region_id']);
/**
 * Columns whose default is the open value for access: a component must give them, so a key that is left out never
 * widens access. Absent (or null) refuses the import, naming the file, the component and the key.
 * Older exports: `since` lists the keys a pgkiln that had the column always wrote with it (added in the same migration
 * or later). A component that has none of them was written before the column existed (an export of an older pgkiln):
 * it gets the default, as meta.import_app gave it before (the trigger of 117, the NULL path), with the meaning that
 * version had (no MFA before 132, no module roles before 117). No `since`: the column is as old as its table, so every
 * export has it.
 */
export const MUST_GIVE: Record<string, Record<string, { why: string; since?: string[] }>> = {
  rest_module: {
    // (117) roles came with templates
    roles: { why: 'its default, no roles, lets any token call the module', since: ['templates'] },
    enabled: { why: 'its default serves the module\'s endpoints' },
  },
  web_credential: { valid_for: { why: 'its default, no URLs, sends the credential to any URL' } },
  app: {
    // (132) mfa and mfa_roles, and every application column added after them (133 … 189)
    mfa: { why: 'its default, off, signs users in with a password only', since: APP_SINCE_132('mfa') },
    mfa_roles: { why: 'its default, no roles, asks no role for a second factor', since: APP_SINCE_132('mfa_roles') },
    local_login: { why: 'its default allows signing in with a password of the application' },
  },
};

function APP_SINCE_132(self: string) {
  return ['mfa', 'mfa_roles', 'mfa_email', 'api_self_tokens', 'vector_providers', 'json_sources', 'notifications', 'pwa_prefetch_hours',
    'session_idle_minutes', 'passkey_signin', 'remember_username'].filter((k) => k !== self);
}

/** Whether a MUST_GIVE key of this row is held back from its default: the row was written by a pgkiln that had it. */
function mustGive(table: string, row: object, key: string) {
  const rule = MUST_GIVE[table]?.[key];
  if (!rule) return false;
  return !rule.since || rule.since.some((k) => has(row, k));
}

const NOT_EXPORTED: Record<string, string[]> = {
  app: ['created_at', 'updated_at', 'availability', 'availability_message', 'availability_users', 'build_status'],
  automation: ['next_run_at', 'last_run_at', 'last_status', 'code'],
  web_credential: ['secret_enc', 'password_enc', 'refresh_token_enc', 'token_refreshed_at'],
  rest_source: ['sync_next_at', 'sync_last_at', 'sync_last_status'],
  static_file: ['content', 'updated_at'],
};

/** A constant default: literals and casts only (no function call such as nextval(), now() or gen_random_uuid()). */
export function isConstantDefault(expr: string) {
  const bare = expr.replace(/'(?:[^']|'')*'/g, "''");
  return !/[A-Za-z_][A-Za-z0-9_$]*\s*\(/.test(bare) && !/\bnextval\b/i.test(bare);
}

/** The constant column defaults of the tables an export writes, from the catalog (one query to evaluate them). */
export async function loadColumnDefaults(db: Q): Promise<ColumnDefaults> {
  const cols = (await db.query(
    `select c.relname as t, a.attname as c, pg_get_expr(d.adbin, d.adrelid) as expr
       from pg_attribute a
       join pg_class c on c.oid = a.attrelid
       join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'meta'
       join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where c.relkind = 'r' and c.relname = any($1) and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
      order by 1, 2`,
    [TABLES],
  )).rows as { t: string; c: string; expr: string }[];
  const use = cols.filter((r) => !NEVER.has(r.c) && !(NOT_EXPORTED[r.t] ?? []).includes(r.c) && isConstantDefault(r.expr));
  const out: ColumnDefaults = {};
  if (!use.length) return out;
  // the expressions are the catalog's own (pgkiln's migrations), constants only: evaluated as they are
  const values = (await db.query(`select ${use.map((r, i) => `to_jsonb(${r.expr}) as v${i}`).join(', ')}`)).rows[0];
  use.forEach((r, i) => {
    const v = values[`v${i}`];
    if (v !== null && v !== undefined) (out[r.t] ??= {})[r.c] = v;
  });
  return out;
}

const has = (row: object, key: string) => Object.prototype.hasOwnProperty.call(row, key);

/** Fills the absent keys of one row; the keys it filled. */
function fillRow(row: unknown, defaults: Record<string, unknown> | undefined, skip: (key: string) => boolean = () => false): string[] {
  if (!row || typeof row !== 'object' || Array.isArray(row) || !defaults) return [];
  // decided on the row as given, before any key is added (a skip may look at other keys)
  const filled = Object.keys(defaults).filter((key) => !has(row, key) && !skip(key));
  for (const key of filled) (row as Record<string, unknown>)[key] = structuredClone(defaults[key]);
  return filled;
}

const nameOf = (row: any) => String(row?.name ?? row?.static_id ?? row?.label ?? row?.title ?? row?.item_name ?? row?.source ?? '').slice(0, 80);
const kindOf = (table: string) => table.replace(/_/g, ' ');

/**
 * Every component row of a document, with its table and a readable label. (sprint 251) scope: what holds the row (its
 * page, or the application), for the unique keys checked in src/import-errors.ts.
 */
export function* rowsOf(doc: Doc): Generator<{ table: string; row: any; label: string; scope: object | null }> {
  if (doc?.app && typeof doc.app === 'object') yield { table: 'app', row: doc.app, label: 'application', scope: null };
  for (const [section, table] of SECTIONS)
    if (Array.isArray(doc?.[section])) for (const row of doc[section]) yield { table, row, label: `${kindOf(table)} ${nameOf(row)}`.trim(), scope: null };
  if (Array.isArray(doc?.pages))
    for (const page of doc.pages) {
      if (!page || typeof page !== 'object') continue;
      const p = `page ${page.page_no ?? '?'}`;
      yield { table: 'page', row: page, label: p, scope: null };
      for (const [section, , table] of PAGE_PARTS)
        if (Array.isArray(page[section]))
          for (const row of page[section]) yield { table, row, label: `${p}, ${kindOf(table)} ${table === 'region' ? String(row?.title ?? row?.static_id ?? '') : nameOf(row)}`.trim(), scope: page };
    }
}

/**
 * Gives every component of the document the column defaults of the keys it leaves out (in place). Returns what it
 * filled, per file (filesToDoc's documents) or component; nothing for an export, which has every key.
 */
export function fillDefaults(doc: Doc, defaults: ColumnDefaults): FilledKeys[] {
  // (sprint 251, MG-28) `condition_expr` on a region or button, `condition` elsewhere: the table's own key
  const both = normalizeConditionKeys(doc);
  if (both.length) throw new UsageError(formatProblems(both));
  // the keys a file must give (MUST_GIVE): absent or null refuses the import before anything is written
  const refused: string[] = [];
  for (const { table, row, label } of rowsOf(doc)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    for (const [key, { why }] of Object.entries(MUST_GIVE[table] ?? {}))
      if (has(row, key) ? row[key] === null : mustGive(table, row, key)) {
        const file = sourceOf(row);
        refused.push(`${file ? `${file} (${label})` : label}: "${key}" is ${has(row, key) ? 'null' : 'missing'} (meta.${table}.${key}: ${why})`);
      }
  }
  if (refused.length)
    throw new UsageError(`${refused.slice(0, 5).join('; ')}${refused.length > 5 ? ` (and ${refused.length - 5} more)` : ''}. ` +
      'Give the key a value: a key whose default would widen access is never filled from the default.');
  const byWhere = new Map<string, FilledKeys>();
  for (const { table, row, label } of rowsOf(doc)) {
    const keys = fillRow(row, defaults[table], (k) => mustGive(table, row, k));
    if (!keys.length) continue;
    const file = sourceOf(row) ?? null;
    const where = file ?? label;
    const entry = byWhere.get(where) ?? { where, file, keys: [] };
    for (const k of keys) if (!entry.keys.includes(k)) entry.keys.push(k);
    byWhere.set(where, entry);
  }
  return [...byWhere.values()].sort((a, b) => (a.where < b.where ? -1 : a.where > b.where ? 1 : 0));
}

/** The filled keys as text lines (empty when none). */
export function formatFilled(filled: FilledKeys[] | undefined) {
  if (!filled?.length) return '';
  return `Filled from column defaults (keys the files leave out):\n` +
    filled.map((f) => `  ${f.where}: ${f.keys.join(', ')}\n`).join('');
}

/**
 * A NOT NULL violation of meta.import_app() as an error naming the component, its file and the key, or null when
 * the error is something else (or no row of the document can be blamed).
 */
export function explainNotNull(e: unknown, doc: Doc): string | null {
  const err = e as { code?: string; schema?: string; table?: string; column?: string };
  if (err?.code !== '23502' || err.schema !== 'meta' || !err.table || !err.column) return null;
  const culprits: string[] = [];
  for (const { table, row, label } of rowsOf(doc)) {
    if (table !== err.table || !row || typeof row !== 'object') continue;
    const missing = !has(row, err.column);
    if (!missing && row[err.column] !== null) continue;
    const file = sourceOf(row);
    culprits.push(`${file ? `${file} (${label})` : label}: "${err.column}" is ${missing ? 'missing' : 'null'}`);
  }
  if (!culprits.length) return null;
  const more = culprits.length > 5 ? ` (and ${culprits.length - 5} more)` : '';
  return `${culprits.slice(0, 5).join('; ')}${more}: meta.${err.table}.${err.column} may not be null. Give the key a value ` +
    `(a key that is left out takes the column's default, when it has one; a key given as null stays null)`;
}

// ------------------------------------------------------------------ the files themselves (diff)

/** What a file of the "dir" layout holds: one row, an array of rows, a tree (children), or trees by list. */
type Shape = { table: string; kind: 'record' | 'rows' | 'tree' | 'trees' };

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** What a file of an application directory holds (its table), or null for a file that is not a component. */
export function shapeOf(path: string): Shape | null {
  const p = path.replace(/\.yaml$/, '.json');
  if (p === 'app.json') return { table: 'app', kind: 'record' };
  if (p === 'navigation.json') return { table: 'nav_entry', kind: 'tree' };
  if (p === 'shared/list-entries.json') return { table: 'list_entry', kind: 'trees' };
  for (const [section, single] of SINGLE) if (p === single) return { table: SECTIONS.find(([s]) => s === section)![1], kind: 'rows' };
  if (/^globalization\/translations\/[^/]+\.json$/.test(p)) return { table: 'translation', kind: 'rows' };
  if (/^pages\/[^/]+\/page\.json$/.test(p)) return { table: 'page', kind: 'record' };
  for (const [, sub, table] of PAGE_PARTS) if (new RegExp(`^pages/[^/]+/${esc(sub)}/[^/.]+\\.json$`).test(p)) return { table, kind: 'record' };
  if (new RegExp(`^${esc(ACTIONS_DIR)}/[^/]+/[^/.]+\\.json$`).test(p)) return { table: 'automation_action', kind: 'record' };
  if (new RegExp(`^${esc(APP_COMPUTATIONS_DIR)}/[^/.]+\\.json$`).test(p)) return { table: 'app_computation', kind: 'record' };
  if (/^shared\/app-processes\/[^/.]+\.json$/.test(p)) return { table: 'app_process', kind: 'record' };
  for (const [, dir, table] of NAMED) if (new RegExp(`^${esc(dir)}/[^/.]+\\.json$`).test(p)) return { table, kind: 'record' };
  return null;
}

/**
 * The files with the keys each component leaves out filled from the column defaults, as an import would read them
 * (a column kept in a sibling file <base>.<column>.<ext> is not left out). Files that leave nothing out are returned
 * as they are; the others are written again in their own format (JSON or YAML).
 */
export function fillFiles(files: FileMap, defaults: ColumnDefaults): FileMap {
  const out: FileMap = new Map(files);
  // <dir>/<base>.<column> of every sibling code (or binary) file
  const siblings = new Set([...files.keys()].map((f) => /^(.*\/)?([^/.]+)\.([a-z_][a-z0-9_]*)\.[a-z0-9]+$/.exec(f)).filter((m) => !!m).map((m) => `${m![1] ?? ''}${m![2]}.${m![3]}`));
  for (const [path, buf] of files) {
    if (!/\.(json|yaml)$/.test(path) || path === 'pgkiln.json') continue;
    const shape = shapeOf(path);
    if (!shape || !defaults[shape.table]) continue;
    let value: unknown;
    try {
      value = path.endsWith('.yaml') ? fromText(buf.toString('utf8'), path) : JSON.parse(buf.toString('utf8'));
    } catch {
      continue; // the import reports it
    }
    const d = defaults[shape.table];
    let changed = false;
    const fill = (row: unknown, skip?: (k: string) => boolean) => {
      // (sprint 251) the other condition key compares as the table's own (a conflict is left for the import to refuse)
      if (normalizeConditionRow(shape.table, row) === 'changed') changed = true;
      if (row && typeof row === 'object' && fillRow(row, d, (k) => !!skip?.(k) || mustGive(shape.table, row, k)).length) changed = true;
    };
    const tree = (rows: unknown) => {
      if (Array.isArray(rows)) for (const r of rows) {
        fill(r, (k) => k === 'children');
        if (r && typeof r === 'object') tree((r as any).children);
      }
    };
    if (shape.kind === 'record') {
      const base = path.replace(/\.(json|yaml)$/, '');
      fill(value, (k) => siblings.has(`${base}.${k}`));
    } else if (shape.kind === 'rows') {
      if (Array.isArray(value)) for (const r of value) fill(r);
    } else if (shape.kind === 'tree') tree(value);
    else if (value && typeof value === 'object') for (const rows of Object.values(value)) tree(rows);
    if (changed) out.set(path, Buffer.from(path.endsWith('.yaml') ? toText(value) : stableJson(value), 'utf8'));
  }
  return out;
}
