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
import { createApp, createAppError, type CheckedApp } from './newapp.ts';
import { groupColumn } from './appfromfile.ts';
import { region, type Body } from './ui.ts';

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
      throw new LoadError(`This is not a readable Excel (.xlsx) file: ${(e as Error).message}`);
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
        if (e instanceof LoadError) throw new LoadError(`Sheet ${s.sheet}: ${e.message}`);
        throw e;
      }
      if (!sheet.rows.length) continue;
      total += sheet.rows.length;
      sheets.push({ ...sheet, name: s.sheet });
    }
    if (sheets.length > MAX_SHEETS) throw new LoadError(`The workbook has ${sheets.length} sheets with rows; at most ${MAX_SHEETS} become tables at once.`);
    if (total > MAX_ROWS) throw new LoadError(`The workbook has ${total} rows; at most ${MAX_ROWS} can be loaded at once.`);
    if (!sheets.length) throw new LoadError('The file has column names but no rows.');
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
        if (arrays.length > MAX_SHEETS) throw new LoadError(`The JSON has ${arrays.length} arrays; at most ${MAX_SHEETS} become tables at once.`);
        const total = arrays.reduce((n, [, v]) => n + v.length, 0);
        if (total > MAX_ROWS) throw new LoadError(`The file has ${total} rows; at most ${MAX_ROWS} can be loaded at once.`);
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
  const where = `Sheet ${p.sheet.name}`;
  if (!valid.test(p.table)) throw new LoadError(`${where}: the table name must be lower-case (letters, digits and _) without a schema; the table goes into the application's schema.`);
  if (!p.cols.length) throw new LoadError(`${where}: give at least one column a name.`);
  for (const c of p.cols) {
    if (!valid.test(c.name)) throw new LoadError(`${where}: "${c.name}" is not a valid column name.`);
    if (!COLUMN_TYPES.includes(c.type)) throw new LoadError(`${where}: unknown column type ${c.type}.`);
  }
  if (new Set(p.cols.map((c) => c.name)).size !== p.cols.length) throw new LoadError(`${where}: column names must be unique.`);
  const ident = pg.escapeIdentifier;
  const defs: string[] = [];
  if (!identityKey(p)) {
    if (p.cols.some((c) => c.name === 'id')) throw new LoadError(`${where}: "id" is the name of the new key column; rename the file column or choose it as the primary key.`);
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

/**
 * A dashboard page: a chart per table (at most six) with the number of rows per
 * parent row (the first foreign key), or per value of a text, yes/no or date
 * column whose values repeat (from the statistics). Null when no table has one.
 */
export async function addDashboard(c: Client, alias: string, tables: string[], page: number): Promise<{ page: number; label: string } | null> {
  const picks: { table: string; group: string }[] = [];
  for (const t of tables) {
    if (picks.length >= MAX_CHARTS) break;
    const catalog = (await c.query<Catalog>('select column_name, kind, is_pk, distinct_values, fk_table::text from meta.wizard_catalog($1::regclass)', [t])).rows;
    const rows = Number((await c.query('select greatest(reltuples, 0) as n from pg_class where oid = $1::regclass', [t])).rows[0].n);
    const group = catalog.find((x) => x.fk_table && !x.is_pk)?.column_name ?? groupColumn(catalog, rows);
    if (group) picks.push({ table: t, group });
  }
  if (!picks.length) return null;
  const generate = (table: string, group: string, no: number, nav: boolean) =>
    c.query<{ id: number }>('select meta.generate_page($1, \'chart\', $2::regclass, $3, $4::jsonb) as id', [
      alias, table, no,
      JSON.stringify({ label: 'Dashboard', icon: 'chart', nav, label_column: group, function: 'count', value_column: null }),
    ]);
  const title = async (table: string, group: string) =>
    (await c.query(`select meta.wizard_label(relname) || ' per ' || lower(meta.wizard_label(regexp_replace($2, '_(id|no|code)$', ''))) as t from pg_class where oid = $1::regclass`, [table, group])).rows[0].t as string;
  const dash = (await generate(picks[0].table, picks[0].group, page, true)).rows[0].id;
  await c.query('update meta.region set title = $2 where page_id = $1', [dash, await title(picks[0].table, picks[0].group)]);
  for (const [n, p] of picks.slice(1).entries()) {
    // generated on a page of its own, then moved onto the dashboard
    const spare = (await c.query('select max(page_no) + 1000 as n from meta.page where app_id = (select id from meta.app where alias = $1)', [alias])).rows[0].n as number;
    const tmp = (await generate(p.table, p.group, spare, false)).rows[0].id;
    await c.query('update meta.region set page_id = $2, seq = $3, title = $4 where page_id = $1', [tmp, dash, (n + 2) * 10, await title(p.table, p.group)]);
    await c.query('delete from meta.page where id = $1', [tmp]);
  }
  if (picks.length > 1) await c.query('update meta.region set columns = 6 where page_id = $1', [dash]);
  return { page, label: `Dashboard (${picks.map((p) => `${p.table.replace(/^.*\./, '')} per ${p.group}`).join(', ')})` };
}

/** Create the application, the tables, the rows, the foreign keys and the pages, in one transaction. */
export async function buildAppFromSheets(checked: CheckedApp, sheets: NamedSheet[], b: Body): Promise<BuiltBook> {
  const v = (name: string) => String(b[name] ?? '');
  const plans = planFrom(sheets, v).filter((p) => p.on);
  if (!plans.length) throw new LoadError('Choose at least one sheet.');
  const ddl = plans.map((p) => plannedTableSql(checked.schema, p));
  if (new Set(plans.map((p) => p.table)).size !== plans.length) throw new LoadError('Each sheet needs a table name of its own.');
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
        throw new LoadError((e as { code?: string }).code === '42P07' ? `The table ${checked.schema}.${p.table} already exists: choose another name.` : (e as Error).message);
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
        throw new LoadError(`Foreign key ${a.table}.${col} → ${to.table}.${key}: ${(e as { detail?: string }).detail ?? (e as Error).message} Untick it, or fix the data.`);
      });
      foreignKeys.push(`${a.table}.${col} → ${to.table}.${key}`);
    }
    for (const T of qualified.values()) await c.query(`analyze ${T}`);

    const pages: BuiltBook['pages'] = [];
    const notes: string[] = [];
    let next = 2;
    for (const p of plans) {
      const T = qualified.get(p.k)!;
      const label = (await c.query('select meta.wizard_label($1) as l', [p.table])).rows[0].l as string;
      await c.query('select meta.generate_page($1, $2, $3::regclass, $4, $5::jsonb)', [checked.alias, 'report_form', T, next, JSON.stringify({ form_page: next + 1, label })]);
      pages.push({ page: next, label }, { page: next + 1, label: `${label} form` });
      next += 2;
    }
    if (b.chart === 'true') {
      const dash = await addDashboard(c, checked.alias, [...qualified.values()], next);
      if (dash) pages.push(dash);
      else notes.push('No dashboard: no table has a foreign key or a text, yes/no or date column with a few values that repeat, to count the rows by.');
    }
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
      `Sheet ${sheet.name}`,
      html`<div class="field">${checkbox(field(k, 'on'), 'true', v(field(k, 'on')) === 'true', `Create a table from this sheet (${sheet.rows.length} row(s), ${sheet.headers.length} column(s))`)}</div>
        <div class="form-grid">
          <div class="field"><label class="label" for="f_${id}">Table name</label><input id="f_${id}" name="${id}" value="${v(id)}"></div>
          <div class="field"><label class="label" for="f_${field(k, 'key')}">Primary key</label>
            <select id="f_${field(k, 'key')}" name="${field(k, 'key')}">${[['', '- a new column id (identity) -'], ...sheet.headers.map((h, i): [string, string] => [String(i), h])].map(
              ([value, label]) => html`<option value="${value}"${v(field(k, 'key')) === value ? raw(' selected') : ''}>${label}</option>`,
            )}</select>
            <small class="help">A whole-number key column becomes an identity key; another key column is unique, next to a new id.</small></div>
        </div>
        <div class="table-wrap"><table class="report ff-cols"><thead><tr><th scope="col">File column</th><th scope="col">Values</th><th scope="col">Column name (empty = skip)</th><th scope="col">Type</th></tr></thead><tbody>
          ${sheet.headers.map((h, i) => {
            const type = v(field(k, `type_${i}`));
            return html`<tr><td>${h}</td><td class="muted small ff-sample">${sample(sheet, i)}</td>
              <td><input name="${field(k, `name_${i}`)}" value="${v(field(k, `name_${i}`))}" aria-label="Column name for ${h} (${sheet.name})"></td>
              <td><select name="${field(k, `type_${i}`)}" aria-label="Type of ${h} (${sheet.name})">${COLUMN_TYPES.map((t) => html`<option value="${t}"${t === type ? raw(' selected') : ''}>${t}</option>`)}</select></td></tr>`;
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
          ${f.missing ? html`<small class="help">${f.missing} row(s) have a value that ${keyName(f.to)} doesn't have.</small>` : ''}</li>`,
      )}</ul>`
    : html`<p class="muted">No column matches another table's key. A column matches when it is named like the key column (dept_id), or like the other table and its key (department_id, department_code), with the same type.</p>`;
  return html`${sections.map((x) => html`${x}<div class="u-spacer"></div>`)}
    ${region('Foreign keys', html`<p class="muted u-mt0">Proposed where a column matches another table's primary key; ticked when every value is found. Forms get a select list for each foreign key.</p>
      ${fkList}
      <div class="buttons"><button class="btn" name="action" value="preview">Update the proposals</button></div>`)}`;
}
