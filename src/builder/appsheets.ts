import pg from 'pg';
import readXlsxFile from 'read-excel-file/node';
import { owner, type Client } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import {
  cellText,
  COLUMN_TYPES,
  columnName,
  inferType,
  LoadError,
  loadRows,
  MAX_ROWS,
  parseFile,
  parseJson,
  tableSheet,
  type ColumnType,
  type LoadResult,
  type NewColumn,
  type Sheet,
} from '../dataload.ts';
import { preview } from './dataload.ts';
import { finishGeneratedApp, createApp, createAppError, type CheckedApp } from './newapp.ts';
import { groupColumn } from './appfromfile.ts';
import { region, type Body } from './ui.ts';
import { scopedTx as tx } from './i18n.ts';

// Create → From a file with several sheets or tables (APEX: Create App from a
// File, several sheets). An Excel workbook with several sheets, or a JSON
// object with several arrays of objects, becomes several tables: the step 2
// form (appfromfile.ts) shows one section per sheet, to include or leave out
// the sheet and to edit its table name, primary key, column names and types.
// Foreign keys are proposed where a column matches another table's key (by
// name and type; ticked when every value is found), and the developer can
// untick them. Everything is created in one owner transaction: the app (its
// own role and schema), the tables, the rows, the foreign keys (added after
// the rows, so the sheet order doesn't matter), a report and form per table,
// navigation, and an optional dashboard with a chart per table.

export interface NamedSheet extends Sheet {
  name: string;
}

export const MAX_SHEETS = 20;
const MAX_CHARTS = 6;
const INT_TYPES: ColumnType[] = ['integer', 'bigint'];

const isZip = (data: Buffer) => data.length > 3 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04;
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** "categories" → "category", "addresses" → "address", "employees" → "employee" */
export function singular(name: string) {
  if (/ies$/.test(name)) return name.replace(/ies$/, 'y');
  if (/(s|x|z|ch|sh)es$/.test(name)) return name.replace(/es$/, '');
  if (/[^s]s$/.test(name)) return name.slice(0, -1);
  return name;
}

/**
 * Every sheet of an Excel workbook (the empty ones are left out), every array
 * of objects of a JSON object ({"departments": [...], "employees": [...]}), or
 * the one table of any other file (parseFile).
 */
export async function parseBook(filename: string, data: Buffer, { headers = true }: { headers?: boolean } = {}): Promise<NamedSheet[]> {
  const base = filename.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '') || 'data';
  if (/\.xlsx$/i.test(filename) || isZip(data)) {
    let book;
    try {
      book = await readXlsxFile<string>(data, { parseNumber: (s) => s, trim: true });
    } catch (e) {
      throw new LoadError(tx('ash.bad_xlsx', { error: (e as Error).message }));
    }
    const sheets: NamedSheet[] = [];
    let total = 0;
    for (const s of book) {
      const rows = s.data.map((r) => r.map(cellText));
      if (!rows.some((r) => r.some((v) => v !== null))) continue;
      let sheet: Sheet;
      try {
        sheet = tableSheet('xlsx', rows, headers);
      } catch (e) {
        if (e instanceof LoadError) throw new LoadError(tx('ash.sheet_error', { sheet: s.sheet, error: e.message }));
        throw e;
      }
      if (!sheet.rows.length) continue;
      total += sheet.rows.length;
      sheets.push({ ...sheet, name: s.sheet });
    }
    if (sheets.length > MAX_SHEETS) throw new LoadError(tx('ash.too_many_sheets', { n: sheets.length, max: MAX_SHEETS }));
    if (total > MAX_ROWS) throw new LoadError(tx('ash.too_many_rows_wb', { n: total, max: MAX_ROWS }));
    if (!sheets.length) throw new LoadError(tx('ash.the_file_has_column_names'));
    return sheets;
  }
  if (/\.json$/i.test(filename) || /^\s*\{/.test(data.subarray(0, 64).toString('utf8').replace(/^﻿/, ''))) {
    let doc: unknown;
    try {
      doc = data.includes(0) ? null : JSON.parse(new TextDecoder('utf-8').decode(data).replace(/^﻿/, ''));
    } catch {
      doc = null; // JSON Lines or not JSON: parseFile says what is wrong
    }
    if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
      const arrays = Object.entries(doc).filter(
        ([, v]) => Array.isArray(v) && v.length && v.every((r) => r && typeof r === 'object' && !Array.isArray(r)),
      ) as [string, unknown[]][];
      if (arrays.length > 1) {
        if (arrays.length > MAX_SHEETS) throw new LoadError(tx('ash.too_many_arrays', { n: arrays.length, max: MAX_SHEETS }));
        const total = arrays.reduce((n, [, v]) => n + v.length, 0);
        if (total > MAX_ROWS) throw new LoadError(tx('ash.too_many_rows', { n: total, max: MAX_ROWS }));
        return arrays.map(([name, v]) => ({ ...parseJson(JSON.stringify(v)), name }));
      }
    }
  }
  return [{ ...(await parseFile(filename, data, { headers })), name: base }];
}

// ---------------------------------------------------------------- the plan

export interface TablePlan {
  /** the sheet's index */
  k: number;
  sheet: NamedSheet;
  on: boolean;
  table: string;
  /** chosen columns (an empty name skips a file column) */
  cols: NewColumn[];
  /** the file column that is the primary key (null: a new identity column id) */
  key: number | null;
}

export interface ForeignKey {
  from: number;
  /** the file column of the "from" sheet */
  col: number;
  to: number;
  /** values of the column that the other table's key doesn't have */
  missing: number;
}

/** The form's values for a sheet: field names s<k>_… when there are several sheets. */
export const field = (k: number, name: string) => `s${k}_${name}`;

/** The file column proposed as the primary key: id, code, <table>_id, <table>_code or <table>_no with a value in every row, all different. */
export function proposeKey(sheet: Sheet, table: string): number | null {
  const one = singular(table);
  const names = ['id', 'code', `${table}id`, `${one}id`, `${table}code`, `${one}code`, `${table}no`, `${one}no`, `${one}number`].map(squash);
  for (const name of names) {
    const i = sheet.headers.findIndex((h) => squash(h) === name);
    if (i < 0) continue;
    const values = sheet.rows.map((r) => r[i]?.trim() ?? null);
    const type = inferType(values);
    if (values.some((v) => v === null) || new Set(values).size !== values.length) continue;
    if (INT_TYPES.includes(type) || type === 'text') return i;
  }
  return null;
}

/** The proposed tables, keys, column names and types for every sheet, as form values. */
export function proposal(sheets: NamedSheet[]): Record<string, string> {
  const out: Record<string, string> = {};
  const tables = new Set<string>();
  for (const [k, sheet] of sheets.entries()) {
    const table = columnName(sheet.name, tables);
    const key = proposeKey(sheet, table);
    const types = sheet.headers.map((_, i) => inferType(sheet.rows.map((r) => r[i])));
    const keyIdentity = key !== null && INT_TYPES.includes(types[key]);
    // the key column is named first, so a file column "id" keeps its name when it is the key
    const used = new Set<string>(keyIdentity ? [] : ['id']);
    const order = key === null ? sheet.headers.map((_, i) => i) : [key, ...sheet.headers.map((_, i) => i).filter((i) => i !== key)];
    for (const i of order) {
      out[field(k, `name_${i}`)] = columnName(sheet.headers[i], used);
      out[field(k, `type_${i}`)] = types[i];
    }
    out[field(k, 'on')] = 'true';
    out[field(k, 'table')] = table;
    out[field(k, 'key')] = key === null ? '' : String(key);
  }
  return out;
}

/** The plan from the form's values (posted, or the proposal). */
export function planFrom(sheets: NamedSheet[], v: (name: string) => string): TablePlan[] {
  return sheets.map((sheet, k) => {
    const cols = sheet.headers
      .map((_, index) => ({ index, name: v(field(k, `name_${index}`)).trim(), type: (v(field(k, `type_${index}`)) || 'text') as ColumnType }))
      .filter((c) => c.name);
    const keyText = v(field(k, 'key'));
    const key = /^\d+$/.test(keyText) && cols.some((c) => c.index === Number(keyText)) ? Number(keyText) : null;
    return { k, sheet, on: v(field(k, 'on')) === 'true', table: v(field(k, 'table')).trim(), cols, key };
  });
}

const keyCol = (p: TablePlan) => (p.key === null ? null : p.cols.find((c) => c.index === p.key)!);
const identityKey = (p: TablePlan) => {
  const c = keyCol(p);
  return !!c && INT_TYPES.includes(c.type);
};
const intValue = (v: string) => (/^[-+]?\d+$/.test(v.trim()) ? String(BigInt(v.trim())) : v.trim());

/**
 * Foreign keys: a column whose name is the other table's key column (dept_id),
 * or the other table's (singular) name with the key column's name
 * (department_id, department_code), or the singular name alone (department),
 * with a compatible type. One proposal per column; never the table itself.
 */
export function proposeForeignKeys(plans: TablePlan[]): ForeignKey[] {
  const out: ForeignKey[] = [];
  const on = plans.filter((p) => p.on);
  for (const a of on) {
    for (const col of a.cols) {
      if (col.index === a.key) continue;
      for (const b of on) {
        const key = keyCol(b);
        if (b === a || !key) continue;
        const names = new Set([`${b.table}${key.name}`, `${singular(b.table)}${key.name}`, singular(b.table)].map(squash));
        if (key.name !== 'id') names.add(squash(key.name));
        if (!names.has(squash(col.name))) continue;
        const ints = INT_TYPES.includes(col.type) && INT_TYPES.includes(key.type);
        if (!ints && col.type !== key.type) continue;
        const norm = (v: string) => (ints ? intValue(v) : v.trim());
        const have = new Set(b.sheet.rows.map((r) => r[key.index]).filter((x): x is string => x !== null).map(norm));
        const missing = a.sheet.rows.filter((r) => r[col.index] !== null && !have.has(norm(r[col.index]!))).length;
        out.push({ from: a.k, col: col.index, to: b.k, missing });
        break;
      }
    }
  }
  return out;
}

const fkName = (f: ForeignKey) => `fk_${f.from}_${f.col}`;
/** A proposed foreign key is ticked by default when every value is found. */
export function fkChecked(f: ForeignKey, b: Body | null) {
  if (b && b[`fkp_${f.from}_${f.col}`] === String(f.to)) return b[fkName(f)] === String(f.to);
  return f.missing === 0;
}

/** CREATE TABLE for a planned table: an integer key column becomes an identity primary key; another key is unique and not null next to a new identity id. */
export function plannedTableSql(schema: string, p: TablePlan) {
  const valid = /^[a-z_][a-z0-9_]{0,62}$/;
  const where = tx('ash.sheet', { name: p.sheet.name });
  if (!valid.test(p.table)) throw new LoadError(tx('ash.bad_table_name', { where }));
  if (!p.cols.length) throw new LoadError(tx('ash.no_columns', { where }));
  for (const c of p.cols) {
    if (!valid.test(c.name)) throw new LoadError(tx('ash.bad_column', { where, col: c.name }));
    if (!COLUMN_TYPES.includes(c.type)) throw new LoadError(tx('ash.bad_type', { where, type: c.type }));
  }
  if (new Set(p.cols.map((c) => c.name)).size !== p.cols.length) throw new LoadError(tx('ash.dup_columns', { where }));
  const ident = pg.escapeIdentifier;
  const defs: string[] = [];
  if (!identityKey(p)) {
    if (p.cols.some((c) => c.name === 'id')) throw new LoadError(tx('ash.id_taken', { where }));
    defs.push('id bigint generated by default as identity primary key');
  }
  for (const c of p.cols) {
    if (c.index === p.key) defs.push(identityKey(p) ? `${ident(c.name)} bigint generated by default as identity primary key` : `${ident(c.name)} ${c.type} not null unique`);
    else defs.push(`${ident(c.name)} ${c.type}`);
  }
  return `create table ${ident(schema)}.${ident(p.table)} (\n  ${defs.join(',\n  ')}\n)`;
}

// ---------------------------------------------------------------- creating

export interface BuiltBook {
  app: { id: number; alias: string; existingAccount: boolean };
  tables: { table: string; result: LoadResult }[];
  foreignKeys: string[];
  pages: { page: number; label: string }[];
  notes: string[];
}

interface Catalog {
  column_name: string;
  kind: string;
  is_pk: boolean;
  distinct_values: number | null;
  fk_table: string | null;
}

/** (sprint 79) A number column that holds an amount: a dashboard sums it (Salary by Department). */
const AMOUNT = /(^|_)(sal|salary|salaries|amount|amt|total|price|cost|costs|revenue|value|budget|balance|fee|fees|pay|wage|wages)(_|$)/i;

interface ChartPlan {
  table: string;
  group: string;
  /** count, or sum of `value` */
  fn: 'count' | 'sum';
  value: string | null;
  kind: 'donut' | 'line' | 'bar';
}

/**
 * (sprint 79, GEN-6) How a table is charted: by its first foreign key that says something, else a text,
 * yes/no or date column whose values repeat; the sum of an amount column when there is one, else the
 * number of rows; a donut for six groups or fewer, a line for dates, else a sorted bar. A grouping that
 * says nothing (one group, or every group the same) is skipped.
 */
async function chartPlan(c: Client, table: string, catalog: Catalog[], rows: number): Promise<ChartPlan | null> {
  const amount = catalog.find((x) => x.kind === 'number' && !x.is_pk && !x.fk_table && AMOUNT.test(x.column_name))?.column_name ?? null;
  const groups = [...catalog.filter((x) => x.fk_table && !x.is_pk).map((x) => x.column_name), groupColumn(catalog, rows)].filter(
    (g, i, all): g is string => !!g && all.indexOf(g) === i,
  );
  for (const group of groups) {
    for (const value of amount ? [amount, null] : [null]) {
      const measure = value ? `sum(${pg.escapeIdentifier(value)})` : 'count(*)';
      const spread = (
        await c.query<{ groups: number; lo: string | null; hi: string | null }>(
          `select count(*)::int as groups, min(v)::text as lo, max(v)::text as hi from (select ${pg.escapeIdentifier(group)} as g, ${measure} as v from ${table} group by 1) x`,
        )
      ).rows[0];
      if (spread.groups < 2 || spread.lo === spread.hi) continue;
      const kind = catalog.find((x) => x.column_name === group)?.kind === 'date' ? 'line' : spread.groups <= 6 ? 'donut' : 'bar';
      return { table, group, fn: value ? 'sum' : 'count', value, kind };
    }
  }
  return null;
}

/**
 * A dashboard page: a chart per table (at most six) with the number of rows per
 * parent row (the first foreign key), or per value of a text, yes/no or date
 * column whose values repeat (from the statistics). Null when no table has one.
 * (097) Tables with row level security are left out (the application's role may
 * see none of their rows: an empty chart); the charts are titled "Employees by
 * Manager", and the Dashboard comes right after Home in the navigation menu.
 */
export async function addDashboard(c: Client, alias: string, tables: string[], page: number, skipped: string[] = []): Promise<{ page: number; label: string } | null> {
  const picks: ChartPlan[] = [];
  for (const t of tables) {
    if (picks.length >= MAX_CHARTS) break;
    const rel = (await c.query('select relrowsecurity as rls, greatest(reltuples, 0) as n from pg_class where oid = $1::regclass', [t])).rows[0];
    if (rel.rls) {
      skipped.push(t);
      continue;
    }
    const catalog = (await c.query<Catalog>('select column_name, kind, is_pk, distinct_values, fk_table::text from meta.wizard_catalog($1::regclass)', [t])).rows;
    const plan = await chartPlan(c, t, catalog, Number(rel.n));
    if (plan) picks.push(plan);
  }
  if (!picks.length) return null;
  const generate = (p: ChartPlan, no: number, nav: boolean) =>
    c.query<{ id: number }>('select meta.generate_page($1, \'chart\', $2::regclass, $3, $4::jsonb) as id', [
      alias, p.table, no,
      JSON.stringify({ label: 'Dashboard', icon: 'chart', nav, label_column: p.group, function: p.fn, value_column: p.value, chart: p.kind }),
    ]);
  // Employees by Manager; a sum: Salary by Department
  const title = async (p: ChartPlan) =>
    (await c.query(`select coalesce(meta.wizard_column_label($1::regclass, $3), meta.wizard_table_label($1::regclass)) || ' by ' || meta.wizard_column_label($1::regclass, $2) as t`, [p.table, p.group, p.value])).rows[0].t as string;
  const dash = (await generate(picks[0], page, true)).rows[0].id;
  await c.query('update meta.region set title = $2 where page_id = $1', [dash, await title(picks[0])]);
  for (const [n, p] of picks.slice(1).entries()) {
    // generated on a page of its own, then moved onto the dashboard
    const spare = (await c.query('select max(page_no) + 1000 as n from meta.page where app_id = (select id from meta.app where alias = $1)', [alias])).rows[0].n as number;
    const tmp = (await generate(p, spare, false)).rows[0].id;
    await c.query('update meta.region set page_id = $2, seq = $3, title = $4 where page_id = $1', [tmp, dash, (n + 2) * 10, await title(p)]);
    await c.query('delete from meta.page where id = $1', [tmp]);
  }
  if (picks.length > 1) await c.query('update meta.region set columns = 6 where page_id = $1', [dash]);
  // right after Home (the first top-level entry)
  await c.query(
    `update meta.nav_entry e set seq = coalesce((select min(seq) from meta.nav_entry h where h.app_id = e.app_id and h.parent_id is null and h.target_page = a.home_page), 0) + 1
       from meta.app a where a.alias = $1 and e.app_id = a.id and e.parent_id is null and e.target_page = $2`,
    [alias, page],
  );
  return { page, label: `Dashboard (${(await Promise.all(picks.map((p) => title(p)))).join(', ')})` };
}

/** Create the application, the tables, the rows, the foreign keys and the pages, in one transaction. */
export async function buildAppFromSheets(checked: CheckedApp, sheets: NamedSheet[], b: Body): Promise<BuiltBook> {
  const v = (name: string) => String(b[name] ?? '');
  const plans = planFrom(sheets, v).filter((p) => p.on);
  if (!plans.length) throw new LoadError(tx('ash.choose_at_least_one_sheet'));
  const ddl = plans.map((p) => plannedTableSql(checked.schema, p));
  if (new Set(plans.map((p) => p.table)).size !== plans.length) throw new LoadError(tx('ash.each_sheet_needs_a_table'));
  // only proposed foreign keys can be chosen (recomputed from the posted names and types)
  const fks = proposeForeignKeys(plans).filter((f) => v(fkName(f)) === String(f.to));
  const headers = b.h !== '0';
  return owner.tx(async (c) => {
    const app = await createApp(c, checked).catch((e) => {
      throw new LoadError(createAppError(e, checked.alias));
    });
    const R = pg.escapeIdentifier(checked.role);
    const qualified = new Map<number, string>();
    const tables: BuiltBook['tables'] = [];
    for (const [n, p] of plans.entries()) {
      await c.query(ddl[n]).catch((e) => {
        throw new LoadError((e as { code?: string }).code === '42P07' ? tx('ash.table_exists', { table: `${checked.schema}.${p.table}` }) : (e as Error).message);
      });
      const T = (await c.query('select $1::regclass::text as t', [`${pg.escapeIdentifier(checked.schema)}.${pg.escapeIdentifier(p.table)}`])).rows[0].t as string;
      qualified.set(p.k, T);
      await c.query(`grant select, insert, update, delete on ${T} to ${R}`);
      const result = await loadRows(c, p.sheet, {
        table: T,
        mode: 'append',
        columns: p.cols.map((x) => ({ index: x.index, column: x.name })),
        skipErrors: b.skip_errors === 'true',
        firstRow: headers && p.sheet.format === 'xlsx' ? 2 : 1,
      });
      if (identityKey(p)) {
        // the identity continues after the loaded keys
        const k = pg.escapeIdentifier(keyCol(p)!.name);
        await c.query(`select setval(pg_get_serial_sequence($1, $2), coalesce((select max(${k}) from ${T}), 1), (select max(${k}) from ${T}) is not null)`, [T, keyCol(p)!.name]);
      }
      tables.push({ table: T, result });
    }
    await c.query(`grant usage, select on all sequences in schema ${pg.escapeIdentifier(checked.schema)} to ${R}`);
    // the foreign keys after the rows: the sheets can come in any order
    const foreignKeys: string[] = [];
    for (const f of fks) {
      const a = plans.find((p) => p.k === f.from)!;
      const to = plans.find((p) => p.k === f.to)!;
      const col = a.cols.find((x) => x.index === f.col)!.name;
      const key = keyCol(to)!.name;
      const A = qualified.get(f.from)!;
      const B = qualified.get(f.to)!;
      const ident = pg.escapeIdentifier;
      await c.query(`create index on ${A} (${ident(col)})`);
      await c.query(`alter table ${A} add foreign key (${ident(col)}) references ${B} (${ident(key)})`).catch((e) => {
        throw new LoadError(tx('ash.fk_failed', { fk: `${a.table}.${col} → ${to.table}.${key}`, error: (e as { detail?: string }).detail ?? (e as Error).message }));
      });
      foreignKeys.push(`${a.table}.${col} → ${to.table}.${key}`);
    }
    for (const T of qualified.values()) await c.query(`analyze ${T}`);

    const pages: BuiltBook['pages'] = [];
    const notes: string[] = [];
    let next = 2;
    for (const p of plans) {
      const T = qualified.get(p.k)!;
      const { label, singular } = (await c.query('select meta.wizard_table_label($1::regclass) as label, meta.wizard_table_label($1::regclass, false) as singular', [T])).rows[0] as { label: string; singular: string };
      await c.query('select meta.generate_page($1, $2, $3::regclass, $4, $5::jsonb)', [checked.alias, 'report_form', T, next, JSON.stringify({ form_page: next + 1 })]);
      pages.push({ page: next, label }, { page: next + 1, label: `${singular} form` });
      next += 2;
    }
    if (b.chart === 'true') {
      const dash = await addDashboard(c, checked.alias, [...qualified.values()], next);
      if (dash) pages.push(dash);
      else notes.push(tx('ash.no_dashboard'));
    }
    await finishGeneratedApp(c, app.id, { description: checked.description });
    return { app: { id: app.id, alias: checked.alias, existingAccount: app.existingAccount }, tables, foreignKeys, pages, notes };
  });
}

// ---------------------------------------------------------------- the form

const SAMPLE = 3;
const sample = (sheet: Sheet, i: number) =>
  sheet.rows
    .map((r) => r[i])
    .filter((x): x is string => x !== null)
    .slice(0, SAMPLE)
    .map((x) => (x.length > 30 ? `${x.slice(0, 30)}…` : x))
    .join(' · ');

const checkbox = (name: string, value: string, on: boolean, label: Raw | string) =>
  html`<label class="check"><input type="checkbox" name="${name}" value="${value}"${on ? raw(' checked') : ''}> ${label}</label>`;

/** Step 2 for several sheets: a section per sheet and the proposed foreign keys (inside the caller's form). */
export function sheetsForm(sheets: NamedSheet[], b: Body | null): Raw {
  const proposed = proposal(sheets);
  const v = (name: string) => (b ? String(b[name] ?? '') : (proposed[name] ?? ''));
  const plans = planFrom(sheets, v);
  const fks = proposeForeignKeys(plans);
  const sections = sheets.map((sheet, k) => {
    const id = field(k, 'table');
    return region(
      tx('ash.sheet', { name: sheet.name }),
      html`<div class="field">${checkbox(field(k, 'on'), 'true', v(field(k, 'on')) === 'true', tx('ash.create_from_sheet', { rows: sheet.rows.length, cols: sheet.headers.length }))}</div>
        <div class="form-grid">
          <div class="field"><label class="label" for="f_${id}">${tx('ash.table_name')}</label><input id="f_${id}" name="${id}" value="${v(id)}"></div>
          <div class="field"><label class="label" for="f_${field(k, 'key')}">${tx('ash.primary_key')}</label>
            <select id="f_${field(k, 'key')}" name="${field(k, 'key')}">${[['', tx('ash.a_new_column_id_identity')], ...sheet.headers.map((h, i): [string, string] => [String(i), h])].map(
              ([value, label]) => html`<option value="${value}"${v(field(k, 'key')) === value ? raw(' selected') : ''}>${label}</option>`,
            )}</select>
            <small class="help">${tx('ash.a_whole_number_key_column')}</small></div>
        </div>
        <div class="table-wrap"><table class="report ff-cols"><thead><tr><th scope="col">${tx('ash.file_column')}</th><th scope="col">${tx('ash.values')}</th><th scope="col">${tx('ash.col_name_head')}</th><th scope="col">${tx('ash.type')}</th></tr></thead><tbody>
          ${sheet.headers.map((h, i) => {
            const type = v(field(k, `type_${i}`));
            return html`<tr><td>${h}</td><td class="muted small ff-sample">${sample(sheet, i)}</td>
              <td><input name="${field(k, `name_${i}`)}" value="${v(field(k, `name_${i}`))}" aria-label="${tx('ash.col_name_for', { col: h, sheet: sheet.name })}"></td>
              <td><select name="${field(k, `type_${i}`)}" aria-label="${tx('ash.type_of', { col: h, sheet: sheet.name })}">${COLUMN_TYPES.map((t) => html`<option value="${t}"${t === type ? raw(' selected') : ''}>${t}</option>`)}</select></td></tr>`;
          })}
        </tbody></table></div>
        <details class="ff-preview"><summary>Preview${sheet.rows.length > 10 ? ' (first 10 rows)' : ''}</summary>${preview(sheet)}</details>`,
    );
  });
  const name = (k: number, i: number) => `${v(field(k, 'table'))}.${v(field(k, `name_${i}`))}`;
  const keyName = (k: number) => {
    const p = plans[k];
    return `${p.table}.${p.cols.find((c) => c.index === p.key)?.name}`;
  };
  const fkList = fks.length
    ? html`<ul class="ff-fks">${fks.map(
        (f) => html`<li><input type="hidden" name="fkp_${f.from}_${f.col}" value="${String(f.to)}">${checkbox(fkName(f), String(f.to), fkChecked(f, b), html`${name(f.from, f.col)} → ${keyName(f.to)}`)}
          ${f.missing ? html`<small class="help">${tx('ash.missing', { n: f.missing, key: keyName(f.to) })}</small>` : ''}</li>`,
      )}</ul>`
    : html`<p class="muted">${tx('ash.no_column_matches_another_table')}</p>`;
  return html`${sections.map((x) => html`${x}<div class="u-spacer"></div>`)}
    ${region(tx('ash.foreign_keys'), html`<p class="muted u-mt0">${tx('ash.fk_intro')}</p>
      ${fkList}
      <div class="buttons"><button class="btn" name="action" value="preview">${tx('ash.update_the_proposals')}</button></div>`)}`;
}
