import pg from 'pg';
import type { Client } from './db.ts';

// Blueprints (migration 063; APEX 26.1: Blueprints, spec-driven
// development): a JSON document that describes a new application, checked
// here (checkBlueprint) and turned into SQL (blueprintSql) and an
// application (buildBlueprint, inside the builder's owner transaction).
//
//   {"blueprint": 1,
//    "name": "Projects", "alias": "projects", "schema": "projects", "authentication": "app_users",
//    "tables": [
//      {"name": "project", "label": "Projects", "columns": [
//         {"name": "name", "type": "text", "required": true, "unique": true},
//         {"name": "status", "type": "text", "values": ["Open", "Closed"]},
//         {"name": "budget", "type": "number"}]},
//      {"name": "task", "columns": [
//         {"name": "project_id", "references": "project", "required": true},
//         {"name": "title", "type": "text", "required": true},
//         {"name": "due", "type": "date"}, {"name": "done", "type": "boolean"}]}],
//    "pages": [{"type": "report_form", "table": "project", "page": 2, "form_page": 3, "label": "Projects"},
//              {"type": "calendar", "table": "task", "page": 4, "label": "Due tasks"},
//              {"type": "blank", "page": 5, "label": "About", "text": "…"}],
//    "dashboard": true,
//    "navigation": [{"label": "Projects", "page": 2, "icon": "table"}],
//    "sample_data": [{"table": "project", "columns": ["id", "name", "status"], "rows": [[1, "Website", "Open"]]}]}
//
// Every table gets an "id" identity primary key; a column with "references"
// is a bigint foreign key to that table's id (with an index). Names are
// checked and always quoted; values (allowed values, sample rows) are
// literals or query parameters. Without "pages", each table gets a report
// and form; without "navigation", the pages' own menu entries stay.

export const COLUMN_TYPES: Record<string, string> = {
  text: 'text', integer: 'bigint', number: 'numeric', date: 'date', timestamp: 'timestamptz', boolean: 'boolean',
};
export const PAGE_TYPES = ['report_form', 'grid', 'form', 'cards', 'calendar', 'chart', 'map', 'facets', 'master_detail', 'blank'] as const;
export const LIMITS = { tables: 30, columns: 50, pages: 50, rows: 200, values: 50 };
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const ALIAS = /^[a-z][a-z0-9_-]{0,49}$/;

export interface BpColumn {
  name: string;
  type: keyof typeof COLUMN_TYPES;
  required: boolean;
  unique: boolean;
  values: string[];
  references: string | null;
}

export interface BpTable {
  name: string;
  label: string | null;
  columns: BpColumn[];
}

export interface BpPage {
  type: (typeof PAGE_TYPES)[number];
  table: string | null;
  page: number;
  form_page: number | null;
  label: string;
  icon: string | null;
  text: string | null;
}

export interface Blueprint {
  name: string;
  alias: string;
  schema: string;
  authentication: 'app_users' | 'none';
  tables: BpTable[];
  pages: BpPage[];
  dashboard: boolean;
  navigation: { label: string; page: number; icon: string | null }[] | null;
  sample_data: { table: string; columns: string[]; rows: (string | number | boolean | null)[][] }[];
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** The blueprint checked and normalised, or the problems (a blueprint with problems is never built). */
export function checkBlueprint(input: unknown): { blueprint: Blueprint | null; problems: string[] } {
  const p: string[] = [];
  if (!isObj(input)) return { blueprint: null, problems: ['A blueprint is a JSON object.'] };
  const b = input;
  if (b.blueprint !== undefined && b.blueprint !== 1) p.push('"blueprint": 1 is the only version.');
  const name = text(b.name, 100);
  if (!name) p.push('"name": the application\'s name.');
  const alias = typeof b.alias === 'string' ? b.alias.trim().toLowerCase() : '';
  if (!ALIAS.test(alias)) p.push('"alias": starts with a letter; a-z, 0-9, _ and -; at most 50 characters.');
  const schema = typeof b.schema === 'string' && b.schema.trim() ? b.schema.trim() : alias.replace(/-/g, '_');
  if (!NAME.test(schema) || /^pg_/.test(schema) || ['meta', 'information_schema', 'public'].includes(schema)) p.push(`"schema": ${schema || '(none)'} can't be an application's schema (a-z, 0-9, _; not meta, public, information_schema or pg_*).`);
  const authentication = b.authentication === undefined || b.authentication === 'app_users' ? 'app_users' : b.authentication === 'none' ? 'none' : null;
  if (!authentication) p.push('"authentication": "app_users" (a login page) or "none".');

  const tables: BpTable[] = [];
  if (!Array.isArray(b.tables) || !b.tables.length || b.tables.length > LIMITS.tables) p.push(`"tables": a list of 1 to ${LIMITS.tables} tables.`);
  const tableNames = new Set((Array.isArray(b.tables) ? b.tables : []).map((t: any) => (isObj(t) && typeof t.name === 'string' ? t.name : '')));
  for (const [i, t] of (Array.isArray(b.tables) ? b.tables.slice(0, LIMITS.tables) : []).entries()) {
    const what = `table ${isObj(t) && typeof t.name === 'string' ? `"${t.name}"` : i + 1}`;
    if (!isObj(t) || typeof t.name !== 'string' || !NAME.test(t.name)) {
      p.push(`${what}: "name" (a-z, 0-9, _; starting with a letter).`);
      continue;
    }
    if (tables.some((x) => x.name === t.name)) p.push(`${what}: the name is used twice.`);
    const columns: BpColumn[] = [];
    if (!Array.isArray(t.columns) || !t.columns.length || t.columns.length > LIMITS.columns) p.push(`${what}: "columns", 1 to ${LIMITS.columns}.`);
    for (const [j, c] of (Array.isArray(t.columns) ? t.columns.slice(0, LIMITS.columns) : []).entries()) {
      const cw = `${what}, column ${isObj(c) && typeof c.name === 'string' ? `"${c.name}"` : j + 1}`;
      if (!isObj(c) || typeof c.name !== 'string' || !NAME.test(c.name) || c.name === 'id') {
        p.push(`${cw}: "name" (a-z, 0-9, _; not "id": every table gets an id).`);
        continue;
      }
      if (columns.some((x) => x.name === c.name)) p.push(`${cw}: the name is used twice.`);
      const references = typeof c.references === 'string' && c.references ? c.references : null;
      if (references && !tableNames.has(references)) p.push(`${cw}: "references" names a table of the blueprint.`);
      const type = (references ? 'integer' : c.type ?? 'text') as BpColumn['type'];
      if (!Object.hasOwn(COLUMN_TYPES, type)) p.push(`${cw}: "type" is one of ${Object.keys(COLUMN_TYPES).join(', ')}.`);
      const values = Array.isArray(c.values) ? c.values : [];
      if (values.length > LIMITS.values || values.some((v: unknown) => typeof v !== 'string' || !v || v.length > 100)) p.push(`${cw}: "values" is a list of at most ${LIMITS.values} texts.`);
      if (values.length && type !== 'text') p.push(`${cw}: "values" is for text columns.`);
      for (const k of ['required', 'unique'] as const) if (c[k] !== undefined && typeof c[k] !== 'boolean') p.push(`${cw}: "${k}" is true or false.`);
      columns.push({ name: c.name, type, required: c.required === true, unique: c.unique === true, values: values.filter((v: unknown) => typeof v === 'string'), references });
    }
    tables.push({ name: t.name, label: text(t.label, 80), columns });
  }
  // a cycle of required references can't be filled
  const order = tableOrder(tables);
  if (!order) p.push('The tables\' references form a cycle: make one of them not required, or remove it.');

  const pages: BpPage[] = [];
  const used = new Set<number>([1]);
  const pageNo = (v: unknown, what: string) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 2 || n > 99999) {
      p.push(`${what}: page numbers are 2 to 99999 (page 1 is Home).`);
      return 0;
    }
    if (used.has(n)) p.push(`${what}: page ${n} is used twice.`);
    used.add(n);
    return n;
  };
  if (b.pages !== undefined && (!Array.isArray(b.pages) || b.pages.length > LIMITS.pages)) p.push(`"pages": a list of at most ${LIMITS.pages} pages.`);
  const pageList = Array.isArray(b.pages) && b.pages.length
    ? b.pages.slice(0, LIMITS.pages)
    : tables.map((t, i) => ({ type: 'report_form', table: t.name, page: 2 + i * 2, form_page: 3 + i * 2, label: t.label ?? undefined }));
  for (const [i, x] of pageList.entries()) {
    const what = `page ${i + 1}`;
    if (!isObj(x) || !(PAGE_TYPES as readonly string[]).includes(x.type)) {
      p.push(`${what}: "type" is one of ${PAGE_TYPES.join(', ')}.`);
      continue;
    }
    const table = x.type === 'blank' ? null : typeof x.table === 'string' ? x.table : '';
    if (table !== null && !tableNames.has(table)) p.push(`${what}: "table" names a table of the blueprint.`);
    const page = pageNo(x.page, what);
    const form_page = x.type === 'report_form' ? pageNo(x.form_page ?? page + 1, `${what} (form)`) : null;
    if (x.type === 'blank' && x.text !== undefined && typeof x.text !== 'string') p.push(`${what}: "text" is text.`);
    pages.push({
      type: x.type, table, page, form_page,
      label: text(x.label, 80) ?? (table ? tables.find((t) => t.name === table)?.label ?? label(table) : `Page ${page}`),
      icon: typeof x.icon === 'string' && /^[a-z-]{1,30}$/.test(x.icon) ? x.icon : null,
      text: typeof x.text === 'string' ? x.text.slice(0, 5000) : null,
    });
  }
  if (b.dashboard !== undefined && typeof b.dashboard !== 'boolean') p.push('"dashboard" is true or false.');
  const dashboard = b.dashboard === true;
  if (dashboard) pageNo(Math.max(...used) + 1, 'the dashboard');

  let navigation: Blueprint['navigation'] = null;
  if (b.navigation !== undefined && b.navigation !== null) {
    if (!Array.isArray(b.navigation) || b.navigation.length > LIMITS.pages) p.push(`"navigation": a list of at most ${LIMITS.pages} entries.`);
    else
      navigation = b.navigation.flatMap((n: any, i: number) => {
        if (!isObj(n) || !text(n.label, 80) || !Number.isInteger(n.page) || (!used.has(n.page))) {
          p.push(`navigation ${i + 1}: {"label": "…", "page": a page of the blueprint (or 1)}.`);
          return [];
        }
        return [{ label: text(n.label, 80)!, page: n.page, icon: typeof n.icon === 'string' && /^[a-z-]{1,30}$/.test(n.icon) ? n.icon : null }];
      });
  }

  const sample_data: Blueprint['sample_data'] = [];
  if (b.sample_data !== undefined && !Array.isArray(b.sample_data)) p.push('"sample_data": a list of {"table", "columns", "rows"}.');
  for (const [i, d] of (Array.isArray(b.sample_data) ? b.sample_data : []).entries()) {
    const what = `sample_data ${i + 1}`;
    const t = isObj(d) ? tables.find((x) => x.name === d.table) : undefined;
    if (!t) {
      p.push(`${what}: "table" names a table of the blueprint.`);
      continue;
    }
    const cols = Array.isArray(d.columns) ? d.columns : [];
    if (!cols.length || cols.some((c: unknown) => typeof c !== 'string' || (c !== 'id' && !t.columns.some((x) => x.name === c))) || new Set(cols).size !== cols.length)
      p.push(`${what}: "columns" are columns of ${t.name} (or id), each once.`);
    const rows = Array.isArray(d.rows) ? d.rows : [];
    if (rows.length > LIMITS.rows) p.push(`${what}: at most ${LIMITS.rows} rows.`);
    if (rows.some((r: unknown) => !Array.isArray(r) || r.length !== cols.length || r.some((v) => v !== null && !['string', 'number', 'boolean'].includes(typeof v) || (typeof v === 'string' && v.length > 2000))))
      p.push(`${what}: each row is a list of ${cols.length} values (text, numbers, true/false or null).`);
    sample_data.push({ table: t.name, columns: cols, rows: rows.slice(0, LIMITS.rows) });
  }
  if (p.length) return { blueprint: null, problems: p };
  return { blueprint: { name: name!, alias, schema, authentication: authentication!, tables, pages, dashboard, navigation, sample_data }, problems: [] };
}

/** order_line → Order Line (like meta.wizard_label). */
export const label = (name: string) => name.split('_').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

/** Tables in an order that creates (and fills) referenced tables first; null for a cycle of required references. */
export function tableOrder(tables: BpTable[]): BpTable[] | null {
  const out: BpTable[] = [];
  const done = new Set<string>();
  let left = [...tables];
  while (left.length) {
    const ready = left.filter((t) => t.columns.every((c) => !c.references || c.references === t.name || done.has(c.references) || !c.required));
    // prefer tables whose references are all there; optional references to later tables are added afterwards
    const strict = ready.filter((t) => t.columns.every((c) => !c.references || c.references === t.name || done.has(c.references)));
    const next = strict.length ? strict : ready;
    if (!next.length) return null;
    const t = next[0];
    out.push(t);
    done.add(t.name);
    left = left.filter((x) => x !== t);
  }
  return out;
}

const ident = pg.escapeIdentifier;

/** The SQL that creates the tables: tables first, then foreign keys and indexes. */
export function blueprintSql(bp: Blueprint): string[] {
  const S = ident(bp.schema);
  const out: string[] = [];
  for (const t of tableOrder(bp.tables) ?? bp.tables) {
    const cols = [
      '  id bigint generated by default as identity primary key',
      ...t.columns.map((c) => `  ${ident(c.name)} ${COLUMN_TYPES[c.type]}${c.required ? ' not null' : ''}${c.unique ? ' unique' : ''}` +
        (c.values.length ? ` check (${ident(c.name)} in (${c.values.map((v) => pg.escapeLiteral(v)).join(', ')}))` : '')),
    ];
    out.push(`create table ${S}.${ident(t.name)} (\n${cols.join(',\n')}\n)`);
  }
  for (const t of bp.tables)
    for (const c of t.columns.filter((x) => x.references)) {
      out.push(`alter table ${S}.${ident(t.name)} add foreign key (${ident(c.name)}) references ${S}.${ident(c.references!)} (id)`);
      out.push(`create index on ${S}.${ident(t.name)} (${ident(c.name)})`);
    }
  return out;
}

/**
 * Create the tables, rows and pages of a checked blueprint for an application
 * that createApp() just made (inside the same owner transaction).
 */
export async function buildBlueprint(c: Client, bp: Blueprint, role: string, generate: { dashboard: (tables: string[], page: number) => Promise<unknown> }) {
  const S = ident(bp.schema);
  const exists = (await c.query(`select count(*)::int as n from pg_class k join pg_namespace n on n.oid = k.relnamespace where n.nspname = $1 and k.relname = any ($2)`,
    [bp.schema, bp.tables.map((t) => t.name)])).rows[0].n;
  if (exists) throw new Error(`The schema ${bp.schema} already has tables of the blueprint: choose another schema or other names.`);
  for (const sql of blueprintSql(bp)) await c.query(sql);
  await c.query(`grant select, insert, update, delete on all tables in schema ${S} to ${ident(role)}`);
  await c.query(`grant usage, select on all sequences in schema ${S} to ${ident(role)}`);
  // sample rows, referenced tables first; ids given in the rows keep the identity after them
  let rows = 0;
  const order = tableOrder(bp.tables) ?? bp.tables;
  for (const t of order)
    for (const d of bp.sample_data.filter((x) => x.table === t.name)) {
      for (const r of d.rows) {
        const types = d.columns.map((col) => (col === 'id' ? 'bigint' : COLUMN_TYPES[t.columns.find((x) => x.name === col)!.type]));
        await c.query(`insert into ${S}.${ident(t.name)} (${d.columns.map(ident).join(', ')}) overriding system value values (${d.columns.map((_, i) => `$${i + 1}::${types[i]}`).join(', ')})`,
          r.map((v) => (v === null ? null : String(v))));
        rows++;
      }
      if (d.columns.includes('id'))
        await c.query(`select setval(pg_get_serial_sequence($1, 'id'), coalesce((select max(id) from ${S}.${ident(t.name)}), 1), (select max(id) from ${S}.${ident(t.name)}) is not null)`, [`${S}.${ident(t.name)}`]);
    }
  for (const t of bp.tables) await c.query(`analyze ${S}.${ident(t.name)}`);
  const qualified = (t: string) => `${S}.${ident(t)}`;
  const appId = (await c.query('select id from meta.app where alias = $1', [bp.alias])).rows[0].id as number;
  for (const p of bp.pages) {
    if (p.type === 'blank') {
      const id = (await c.query('insert into meta.page (app_id, page_no, name, title) values ($1, $2, $3, $3) returning id', [appId, p.page, p.label])).rows[0].id;
      await c.query(`insert into meta.region (page_id, seq, title, type, source) values ($1, 10, $2, 'static', $3)`, [id, p.label, p.text ? `<p>${escHtml(p.text).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>')}</p>` : '']);
      await c.query(`insert into meta.nav_entry (app_id, seq, label, icon, target_page) values ($1, (select coalesce(max(seq), 0) + 10 from meta.nav_entry where app_id = $1), $2, $3, $4)`, [appId, p.label, p.icon ?? 'file', p.page]);
      continue;
    }
    const options: Record<string, unknown> = { label: p.label };
    if (p.icon) options.icon = p.icon;
    if (p.type === 'report_form') {
      options.form_page = p.form_page;
      options.icon ??= 'table';
    }
    if (p.type === 'grid') options.icon ??= 'grid';
    await c.query('select meta.generate_page($1, $2, $3::regclass, $4, $5::jsonb)', [bp.alias, p.type, qualified(p.table!), p.page, JSON.stringify(options)]);
  }
  if (bp.dashboard) {
    const page = Math.max(1, ...bp.pages.flatMap((p) => [p.page, p.form_page ?? 0])) + 1;
    await generate.dashboard(bp.tables.map((t) => qualified(t.name)), page);
  }
  if (bp.navigation) {
    await c.query('delete from meta.nav_entry where app_id = $1', [appId]);
    for (const [i, n] of bp.navigation.entries())
      await c.query('insert into meta.nav_entry (app_id, seq, label, icon, target_page) values ($1, $2, $3, $4, $5)', [appId, (i + 1) * 10, n.label, n.icon, n.page]);
  }
  return { appId, rows };
}

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A strict JSON schema of a blueprint, for an AI draft (optional parts as empty values). */
export function blueprintJsonSchema() {
  const str = { type: 'string' };
  return {
    type: 'object',
    properties: {
      name: str, alias: { type: 'string', description: 'lower case: a-z, 0-9, _ and -' }, schema: { type: 'string', description: 'lower case: a-z, 0-9, _' },
      tables: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'singular, lower case with _' }, label: { type: 'string', description: 'plural, for menus' },
            columns: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'lower case with _; never id (every table gets an id)' },
                  type: { type: 'string', enum: Object.keys(COLUMN_TYPES) },
                  required: { type: 'boolean' }, unique: { type: 'boolean' },
                  values: { type: 'array', items: str, description: 'allowed values of a text column, or empty' },
                  references: { type: 'string', description: 'the table this column refers to (its id), or empty' },
                },
                required: ['name', 'type', 'required', 'unique', 'values', 'references'],
                additionalProperties: false,
              },
            },
          },
          required: ['name', 'label', 'columns'],
          additionalProperties: false,
        },
      },
      pages: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: [...PAGE_TYPES] },
            table: { type: 'string', description: 'a table of the blueprint; empty for blank' },
            page: { type: 'integer', description: '2 or more, unique' },
            form_page: { type: ['integer', 'null'], description: 'report_form only: the form\'s page number' },
            label: str, text: { type: 'string', description: 'blank pages: their text; otherwise empty' },
          },
          required: ['type', 'table', 'page', 'form_page', 'label', 'text'],
          additionalProperties: false,
        },
      },
      dashboard: { type: 'boolean' },
      sample_data: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            table: str, columns: { type: 'array', items: str, description: 'include id when other rows refer to these' },
            rows: { type: 'array', items: { type: 'array', items: { type: ['string', 'number', 'boolean', 'null'] } } },
          },
          required: ['table', 'columns', 'rows'],
          additionalProperties: false,
        },
      },
    },
    required: ['name', 'alias', 'schema', 'tables', 'pages', 'dashboard', 'sample_data'],
    additionalProperties: false,
  };
}

/** An AI draft in blueprint form (empty optional parts left out), ready for the editor. */
export function fromDraft(json: any): Record<string, unknown> {
  const out: Record<string, unknown> = { blueprint: 1, name: json?.name, alias: json?.alias, schema: json?.schema, authentication: 'app_users' };
  out.tables = (Array.isArray(json?.tables) ? json.tables : []).map((t: any) => ({
    name: t?.name, ...(t?.label ? { label: t.label } : {}),
    columns: (Array.isArray(t?.columns) ? t.columns : []).map((c: any) => ({
      name: c?.name,
      ...(c?.references ? { references: c.references } : { type: c?.type }),
      ...(c?.required ? { required: true } : {}), ...(c?.unique ? { unique: true } : {}),
      ...(Array.isArray(c?.values) && c.values.length ? { values: c.values } : {}),
    })),
  }));
  out.pages = (Array.isArray(json?.pages) ? json.pages : []).map((p: any) => ({
    type: p?.type, ...(p?.type === 'blank' ? {} : { table: p?.table }), page: p?.page,
    ...(p?.type === 'report_form' ? { form_page: p?.form_page } : {}), label: p?.label, ...(p?.type === 'blank' && p?.text ? { text: p.text } : {}),
  }));
  if (json?.dashboard) out.dashboard = true;
  if (Array.isArray(json?.sample_data) && json.sample_data.length) out.sample_data = json.sample_data;
  return out;
}
