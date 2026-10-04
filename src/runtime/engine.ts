import pg from 'pg';
import { applyBinds, literal } from '../binds.ts';
import { savepoint, type Client } from '../db.ts';
import type { Process, Region } from '../metadata.ts';
import { isAuthorized } from './authz.ts';
import { gridDml } from './grid.ts';
import { formRegion, isMultiple, isTempId, removals, REMOVE, saveFileLists, storedFiles, tempIds } from './files.ts';
import { autoMap, LoadError, LoadFailed, loadRows, parseFile, tableColumns, type LoadMode } from '../dataload.ts';
import { esc } from '../html.ts';
import { invokeApi } from './rest-sources.ts';
import { ratingMax } from './items.ts';
import { bindValues, publicError, stripSemicolon, substitute, toState, type Errors, type PageContext } from './context.ts';

const ident = pg.escapeIdentifier;

export class ValidationFailed extends Error {
  constructor(readonly errors: Errors) {
    super('Validation failed');
  }
}

/** Resolve a developer-supplied table name to a safely quoted identifier. */
export async function resolveTable(c: Client, name: string) {
  const res = await c.query('select $1::regclass::text as t', [name]);
  return res.rows[0].t as string;
}

const formItems = (ctx: PageContext, r: Region) => ctx.page.items.filter((i) => i.region_id === r.id && i.source_column);

export function clearPageItems(ctx: PageContext) {
  for (const i of ctx.page.items) delete ctx.session.state[i.name];
}

/** Names a SQL process may assign: application items and this page's items. */
function assignable(ctx: PageContext) {
  return new Set([...ctx.app.app_items, ...ctx.page.items.map((i) => i.name)]);
}

/**
 * Run developer SQL (one or more statements, binds substituted). If the last
 * statement returns a row, its columns named like assignable items set them.
 */
export async function runSql(ctx: PageContext, code: string, names = assignable(ctx)) {
  const sql = stripSemicolon(applyBinds(code, bindValues(ctx)));
  if (!sql) return;
  const out = await ctx.client!.query(sql);
  const res = Array.isArray(out) ? out[out.length - 1] : out;
  const row = res?.rows?.[0];
  if (row)
    for (const [k, v] of Object.entries(row)) {
      const name = k.toUpperCase();
      if (names.has(name)) ctx.session.state[name] = toState(v);
    }
  return res;
}

/** Automatic row fetch for form regions whose primary-key item has a value. */
export async function fetchForms(ctx: PageContext) {
  const c = ctx.client!;
  for (const r of ctx.page.regions) {
    if (r.type !== 'form' || !r.table_name || !r.pk_column || !r.pk_item) continue;
    const pk = ctx.session.state[r.pk_item];
    if (pk === null || pk === undefined) continue;
    // files are not loaded into session state; the item shows the stored file's name
    const items = formItems(ctx, r).filter((i) => i.type !== 'file');
    for (const f of formItems(ctx, r)) if (f.type === 'file') ctx.session.state[f.name] = null;
    try {
      const table = await savepoint(c, () => resolveTable(c, r.table_name!));
      const cols = items.map((i) => ident(i.source_column!)).join(', ') || ident(r.pk_column);
      const res = await savepoint(c, () =>
        c.query({ text: `select ${cols} from ${table} where ${ident(r.pk_column!)} = ${literal(pk)}`, rowMode: 'array' }),
      );
      if (!res.rows.length) {
        // Not found, or hidden by row level security: behave identically.
        ctx.errors.page.push(ctx.locale.t('form.not_found', { region: r.title ?? ctx.locale.t('form.record') }));
        clearPageItems(ctx);
        continue;
      }
      items.forEach((item, idx) => (ctx.session.state[item.name] = toState(res.rows[0][idx])));
    } catch (e) {
      ctx.errors.page.push(await publicError(ctx, e, `fetch of ${r.title ?? 'form'}`));
    }
  }
}

// ---------------------------------------------------------------- validations

async function storedFileExists(ctx: PageContext, r: Region, column: string) {
  const pk = ctx.session.state[r.pk_item!];
  if (pk === null || pk === undefined) return false;
  const c = ctx.client!;
  const res = await savepoint(c, async () =>
    c.query(`select ${ident(column)} is not null as ok from ${await resolveTable(c, r.table_name!)} where ${ident(r.pk_column!)} = ${literal(pk)}`),
  );
  return res.rows[0]?.ok === true;
}

export async function validate(ctx: PageContext) {
  const c = ctx.client!;
  const errors: Errors = { page: [], items: {} };
  const state = ctx.session.state;
  const vis = ctx.vis!;
  const fail = (itemName: string | null, msg: string) => {
    if (itemName && vis.items.has(itemName) && !errors.items[itemName]) errors.items[itemName] = msg;
    else errors.page.push(msg);
  };

  for (const i of ctx.page.items) {
    if (!i.required || !vis.editable.has(i.name)) continue;
    let missing = (state[i.name] ?? null) === null;
    // a file item keeps the stored file unless a new one is uploaded
    if (isMultiple(i)) {
      const remove = new Set(removals(ctx, i));
      missing = !tempIds(state[i.name]).length && !(await storedFiles(ctx, i)).some((f) => !remove.has(f.key));
    } else if (i.type === 'file') {
      const r = formRegion(ctx, i);
      missing = state[i.name] === REMOVE || (missing && !(r && (await storedFileExists(ctx, r, i.source_column!))));
    }
    if (missing) fail(i.name, ctx.locale.t('error.required', { label: i.label ?? i.name }));
  }
  // a location is "latitude,longitude"; a rating a whole number of stars; a date range "from:to"
  for (const i of ctx.page.items) {
    const v = state[i.name];
    if (!v || !vis.editable.has(i.name) || errors.items[i.name]) continue;
    const label = i.label ?? i.name;
    if (i.type === 'rating' && !(/^\d{1,2}$/.test(v) && Number(v) >= 1 && Number(v) <= ratingMax(i)))
      fail(i.name, ctx.locale.t('error.rating', { label, max: ratingMax(i) }));
    if (i.type === 'daterange') {
      const m = /^(\d{4}-\d{2}-\d{2})?:(\d{4}-\d{2}-\d{2})?$/.exec(v);
      const valid = (d: string | undefined) => {
        const t = d ? Date.parse(`${d}T00:00:00Z`) : 0;
        return !d || (!Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d);
      };
      if (!m || !valid(m[1]) || !valid(m[2])) fail(i.name, ctx.locale.t('error.daterange', { label }));
      else if (m[1] && m[2] && m[1] > m[2]) fail(i.name, ctx.locale.t('error.daterange_order', { label }));
      else if (i.required && (!m[1] || !m[2])) fail(i.name, ctx.locale.t('error.required', { label }));
    }
  }
  for (const i of ctx.page.items) {
    const v = state[i.name];
    if (i.type !== 'location' || !v || !vis.editable.has(i.name) || errors.items[i.name]) continue;
    const m = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(v);
    if (!m || Math.abs(Number(m[1])) > 90 || Math.abs(Number(m[2])) > 180) fail(i.name, ctx.locale.t('error.location', { label: i.label ?? i.name }));
  }

  for (const v of ctx.page.validations) {
    if (v.when_button && v.when_button !== ctx.request) continue;
    if (v.item_name && (!vis.items.has(v.item_name) || errors.items[v.item_name])) continue;
    const value = v.item_name ? (state[v.item_name] ?? null) : null;
    try {
      let ok = true;
      if (v.type === 'not_null') ok = value !== null;
      else if (v.type === 'regex') {
        if (value !== null) ok = (await savepoint(c, () => c.query(`select ${literal(value)} ~ ${literal(v.expression ?? '')} as ok`))).rows[0].ok;
      } else {
        const sql = `select (${stripSemicolon(applyBinds(v.expression ?? 'true', bindValues(ctx)))})::boolean as ok`;
        ok = (await savepoint(c, () => c.query(sql))).rows[0].ok === true;
      }
      if (!ok) fail(v.item_name, v.message);
    } catch (e) {
      fail(v.item_name, `${v.message} (${await publicError(ctx, e, `validation ${v.name}`)})`);
    }
  }

  if (errors.page.length || Object.keys(errors.items).length) throw new ValidationFailed(errors);
}

// ---------------------------------------------------------------- processes

const INSERT = new Set(['CREATE', 'INSERT', 'ADD']);
const UPDATE = new Set(['SAVE', 'UPDATE', 'APPLY', 'APPLY_CHANGES']);

async function formDml(ctx: PageContext, p: Process): Promise<string | null> {
  const c = ctx.client!;
  const r = ctx.page.regions.find((x) => x.id === p.region_id);
  if (!r?.table_name || !r.pk_column || !r.pk_item) throw new Error(`Process "${p.name}" needs a form region with a table and primary key.`);
  if (!ctx.vis!.regions.has(r.id)) return null;
  const op = ctx.request === 'DELETE' ? 'delete' : INSERT.has(ctx.request) ? 'insert' : UPDATE.has(ctx.request) ? 'update' : null;
  if (!op) return null;

  const state = ctx.session.state;
  const table = await resolveTable(c, r.table_name);
  const pkCol = ident(r.pk_column);
  const pk = state[r.pk_item] ?? null;
  // Columns written: items the user may see and that are not read-only
  // (hidden non-key items carry server-set values and are included too).
  // (a multiple file item's source column is in its child table: saveFileLists)
  const columns = formItems(ctx, r).filter(
    (i) =>
      i.source_column !== r.pk_column &&
      !isMultiple(i) &&
      i.type !== 'display' &&
      ctx.vis!.items.has(i.name) &&
      (i.type === 'hidden' || ctx.vis!.editable.has(i.name)),
  );

  // [column, SQL expression] pairs to write; a file item writes the file and
  // its name and type columns, or nothing when no new file was uploaded
  const assignments: [string, string][] = [];
  const uploaded: string[] = [];
  for (const i of columns) {
    const v = state[i.name] ?? null;
    if (i.type !== 'file') {
      if (op === 'update' || v !== null) assignments.push([ident(i.source_column!), literal(v)]);
      continue;
    }
    const conf = (i.config ?? {}) as { filename_column?: string; mime_column?: string };
    const file = (col: string) => `(select ${col} from meta.temp_files where id = ${literal(v)}::uuid)`;
    if (isTempId(v)) {
      uploaded.push(v);
      assignments.push([ident(i.source_column!), file('content')]);
      if (conf.filename_column) assignments.push([ident(conf.filename_column), file('filename')]);
      if (conf.mime_column) assignments.push([ident(conf.mime_column), file('mime_type')]);
    } else if (v === REMOVE && op === 'update') {
      assignments.push([ident(i.source_column!), 'null']);
      if (conf.filename_column) assignments.push([ident(conf.filename_column), 'null']);
      if (conf.mime_column) assignments.push([ident(conf.mime_column), 'null']);
    }
  }
  // saved into the row: the temporary files are no longer needed
  const done = async () => {
    for (const id of uploaded) await c.query('select meta.delete_temp_file($1)', [id]);
    for (const i of columns) if (i.type === 'file') state[i.name] = null;
  };

  if (op === 'insert') {
    // Only non-null values: omitted columns get their DEFAULT.
    const sql = assignments.length
      ? `insert into ${table} (${assignments.map(([col]) => col).join(', ')}) values (${assignments.map(([, v]) => v).join(', ')}) returning ${pkCol}`
      : `insert into ${table} default values returning ${pkCol}`;
    const res = await c.query({ text: sql, rowMode: 'array' });
    state[r.pk_item] = toState(res.rows[0][0]);
    await saveFileLists(ctx, r, 'insert');
    await done();
    return p.success_message ?? ctx.locale.t('form.created');
  }

  if (pk === null) throw new Error(ctx.locale.t('form.no_record'));
  if (op === 'update') {
    if (assignments.length) {
      const res = await c.query(`update ${table} set ${assignments.map(([col, v]) => `${col} = ${v}`).join(', ')} where ${pkCol} = ${literal(pk)}`);
      if (res.rowCount !== 1) throw new Error(ctx.locale.t('form.changed'));
    }
    await saveFileLists(ctx, r, 'update');
    await done();
    return p.success_message ?? ctx.locale.t('form.saved');
  }

  await saveFileLists(ctx, r, 'delete');
  const res = await c.query(`delete from ${table} where ${pkCol} = ${literal(pk)}`);
  if (res.rowCount !== 1) throw new Error(ctx.locale.t('form.changed'));
  clearPageItems(ctx);
  return p.success_message ?? ctx.locale.t('form.deleted');
}

interface DataLoadConfig {
  file_item?: string;
  table?: string;
  mode?: LoadMode;
  skip_errors?: boolean;
  headers?: boolean;
  columns?: Record<string, string>;
}

/**
 * data_load: load the file of a file item into a table, as the app's role.
 * Nothing is loaded when a row fails, unless skip_errors is set.
 */
async function dataLoad(ctx: PageContext, p: Process): Promise<string | null> {
  const t = ctx.locale.t;
  const conf = (p.config ?? {}) as DataLoadConfig;
  const fileItem = conf.file_item?.toUpperCase();
  if (!fileItem || !conf.table) throw new Error(`Process "${p.name}" needs "file_item" and "table" in its configuration.`);
  // shown on the file item (see errorItem)
  const fail = (message: string) => Object.assign(new Error(message), { column: fileItem.toLowerCase() });
  const c = ctx.client!;
  const id = ctx.session.state[fileItem];
  const file = isTempId(id) ? (await c.query('select filename, content from meta.temp_files where id = $1', [id])).rows[0] : undefined;
  if (!file) throw fail(t('load.no_file'));
  const headers = conf.headers !== false;
  try {
    const sheet = await parseFile(file.filename, file.content, { headers });
    const columns = conf.columns
      ? sheet.headers.flatMap((h, index) => (conf.columns![h] ? [{ index, column: conf.columns![h] }] : []))
      : autoMap(sheet.headers, await tableColumns(c, conf.table));
    if (!columns.length) throw fail(t('load.no_columns', { table: conf.table }));
    const r = await loadRows(c, sheet, {
      table: conf.table,
      columns,
      mode: conf.mode ?? 'append',
      skipErrors: !!conf.skip_errors,
      firstRow: headers ? 2 : 1,
      // invalid values and RAISE messages are shown; other errors are logged
      describe: async (e) => {
        const code = (e as pg.DatabaseError).code ?? '';
        return code.startsWith('22') || code === 'P0001' ? (e as Error).message : publicError(ctx, e, `data load of ${conf.table}`);
      },
    });
    await c.query('select meta.delete_temp_file($1)', [id]);
    ctx.session.state[fileItem] = null;
    const counts = { inserted: String(r.inserted), updated: String(r.updated), failed: String(r.failed) };
    const done = p.success_message ? p.success_message.replace(/\{(inserted|updated|failed)\}/g, (_, k: keyof typeof counts) => counts[k]) : t('load.done', counts);
    return r.failed ? `${done} ${t('load.skipped', { ...counts, errors: rowErrors(r.errors) })}` : done;
  } catch (e) {
    if (e instanceof LoadFailed) throw fail(t('load.failed', { failed: String(e.result.failed), errors: rowErrors(e.result.errors) }));
    if (e instanceof LoadError) throw fail(e.message);
    throw e;
  }
}

const rowErrors = (errors: { row: number; message: string }[]) =>
  errors.slice(0, 5).map((e) => `${e.row}: ${e.message.replace(/\.$/, '')}`).join('; ') + (errors.length > 5 ? '; …' : '');

export class ProcessFailed extends Error {
  constructor(message: string, readonly item: string | null) {
    super(message);
  }
}

/**
 * Map a database error onto a form item. PL/pgSQL can target a field with
 *   raise exception '...' using column = 'sal';
 * which matches an item by source column or by item name.
 */
function errorItem(ctx: PageContext, e: unknown) {
  const col = (e as pg.DatabaseError).column?.toLowerCase();
  if (!col) return null;
  const item = ctx.page.items.find((i) => ctx.vis!.items.has(i.name) && (i.source_column?.toLowerCase() === col || i.name.toLowerCase() === col));
  return item?.name ?? null;
}

export async function runProcesses(ctx: PageContext, point: 'submit' | 'load') {
  const messages: string[] = [];
  const names = assignable(ctx);
  for (const p of ctx.page.processes) {
    if (p.point !== point) continue;
    if (p.when_button && p.when_button !== ctx.request) continue;
    // a grid's DML runs on that grid's Save button unless a button is named
    if (p.type === 'grid_dml' && !p.when_button && ctx.request !== `GRID_SAVE_${p.region_id}`) continue;
    if (!(await isAuthorized(ctx, p.authz))) continue;
    try {
      const msg =
        p.type === 'form_dml' ? await formDml(ctx, p)
        : p.type === 'grid_dml' ? await gridDml(ctx, p)
        : p.type === 'data_load' ? await dataLoad(ctx, p)
        : p.type === 'invoke_api' ? await invokeApi(ctx, p, names)
        : (await runSql(ctx, p.code ?? '', names), p.success_message);
      if (msg) messages.push(msg);
    } catch (e) {
      throw new ProcessFailed(await publicError(ctx, e, `process "${p.name}"`), errorItem(ctx, e));
    }
  }
  return messages;
}

/** Application processes (after_login, before_page), in sequence. */
export async function runAppProcesses(ctx: PageContext, point: 'after_login' | 'before_page') {
  for (const p of ctx.app.app_processes) {
    if (p.point !== point || !(await isAuthorized(ctx, p.authz))) continue;
    try {
      await savepoint(ctx.client!, () => runSql(ctx, p.code, new Set(ctx.app.app_items)));
    } catch (e) {
      ctx.errors.page.push(await publicError(ctx, e, `application process "${p.name}"`));
    }
  }
}
