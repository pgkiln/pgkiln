import pg from 'pg';
import { applyBinds, literal } from '../binds.ts';
import { savepoint, type Client } from '../db.ts';
import type { Process, Region } from '../metadata.ts';
import { isAuthorized } from './authz.ts';
import { gridDml } from './grid.ts';
import { esc } from '../html.ts';
import { bindValues, publicError, stripSemicolon, substitute, toState, type Errors, type PageContext } from './context.ts';

const ident = pg.escapeIdentifier;

export class ValidationFailed extends Error {
  constructor(readonly errors: Errors) {
    super('Validation failed');
  }
}

/** Resolve a developer-supplied table name to a safely quoted identifier. */
async function resolveTable(c: Client, name: string) {
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
    const items = formItems(ctx, r);
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

export async function validate(ctx: PageContext) {
  const c = ctx.client!;
  const errors: Errors = { page: [], items: {} };
  const state = ctx.session.state;
  const vis = ctx.vis!;
  const fail = (itemName: string | null, msg: string) => {
    if (itemName && vis.items.has(itemName) && !errors.items[itemName]) errors.items[itemName] = msg;
    else errors.page.push(msg);
  };

  for (const i of ctx.page.items)
    if (i.required && vis.editable.has(i.name) && (state[i.name] ?? null) === null) fail(i.name, ctx.locale.t('error.required', { label: i.label ?? i.name }));

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
  const columns = formItems(ctx, r).filter(
    (i) =>
      i.source_column !== r.pk_column &&
      i.type !== 'display' &&
      ctx.vis!.items.has(i.name) &&
      (i.type === 'hidden' || ctx.vis!.editable.has(i.name)),
  );

  if (op === 'insert') {
    // Only non-null values: omitted columns get their DEFAULT.
    const set = columns.filter((i) => (state[i.name] ?? null) !== null);
    const sql = set.length
      ? `insert into ${table} (${set.map((i) => ident(i.source_column!)).join(', ')}) values (${set.map((i) => literal(state[i.name])).join(', ')}) returning ${pkCol}`
      : `insert into ${table} default values returning ${pkCol}`;
    const res = await c.query({ text: sql, rowMode: 'array' });
    state[r.pk_item] = toState(res.rows[0][0]);
    return p.success_message ?? ctx.locale.t('form.created');
  }

  if (pk === null) throw new Error(ctx.locale.t('form.no_record'));
  if (op === 'update') {
    if (columns.length) {
      const res = await c.query(
        `update ${table} set ${columns.map((i) => `${ident(i.source_column!)} = ${literal(state[i.name])}`).join(', ')} where ${pkCol} = ${literal(pk)}`,
      );
      if (res.rowCount !== 1) throw new Error(ctx.locale.t('form.changed'));
    }
    return p.success_message ?? ctx.locale.t('form.saved');
  }

  const res = await c.query(`delete from ${table} where ${pkCol} = ${literal(pk)}`);
  if (res.rowCount !== 1) throw new Error(ctx.locale.t('form.changed'));
  clearPageItems(ctx);
  return p.success_message ?? ctx.locale.t('form.deleted');
}

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
        : p.type === 'send_email' ? (await sendEmail(ctx, p), p.success_message)
        : (await runSql(ctx, p.code ?? '', names), p.success_message);
      if (msg) messages.push(msg);
    } catch (e) {
      throw new ProcessFailed(await publicError(ctx, e, `process "${p.name}"`), errorItem(ctx, e));
    }
  }
  return messages;
}

/**
 * "Send e-mail" process (APEX: Send E-Mail): queued in the page's
 * transaction, so it's only sent when the page's processing succeeds.
 */
async function sendEmail(ctx: PageContext, p: Process) {
  const c = p.config ?? {};
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? substitute(v, ctx, (x) => x) : null);
  if (c.template) {
    const placeholders = Object.fromEntries(Object.entries(c.placeholders ?? {}).map(([k, v]) => [k, text(v) ?? '']));
    await ctx.client!.query('select meta.send_mail_template($1, $2, $3, $4, $5, $6, $7)', [
      c.template, placeholders, text(c.to), text(c.from), text(c.cc), text(c.bcc), text(c.reply_to),
    ]);
    return;
  }
  const html = typeof c.body_html === 'string' && c.body_html.trim() ? substitute(c.body_html, ctx, esc) : null;
  await ctx.client!.query('select meta.send_mail($1, $2, $3, $4, $5, $6, $7, $8)', [
    text(c.to), text(c.subject) ?? '', text(c.body), html, text(c.from), text(c.cc), text(c.bcc), text(c.reply_to),
  ]);
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
