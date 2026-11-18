import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { recordChanges } from '../changelog.ts';
import { owner } from '../db.ts';
import { html } from '../html.ts';
import { icon } from '../icons.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import { back, BASE, csrf, developer, flash, region, send, shell, workshopTabs, type Req } from './ui.ts';
import { currentWorkspace, usableSchemas, workshopDb } from './workspaces.ts';
import { SYSTEM_SCHEMAS } from './object-browser.ts';
import { tr } from './i18n.ts';

// (sprint 228; migration 186) SQL Workshop › Recycle Bin (Oracle: the recycle bin, FLASHBACK TABLE … TO BEFORE DROP,
// PURGE). "Drop to the recycle bin" renames a table to BIN$<random> in its own schema instead of dropping it; the
// rename runs on the SQL Workshop's connection (the developer login, or the owner when chosen), so only someone who
// may drop the table can. Its rows, indexes, constraints, triggers, grants and the views on it stay. Restore renames it
// back (or to another name when the original is taken again); Purge drops it. meta.recycle_bin remembers the original
// name per workspace; the table is found by its oid (a rename keeps it). BIN$ tables are left out of the navigator.

export const BIN = `${BASE}/sql/recycle-bin`;
export const isBinName = (name: string) => /^BIN\$[a-z0-9]{8,40}$/.test(name);
const binName = () => `BIN$${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
const NAME = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
const q = (n: string) => pg.escapeIdentifier(n);

interface BinRow { id: string; schema_name: string; original_name: string; bin_name: string; table_oid: number; dropped_by: string | null; dropped_at: Date }

/** The workspace's recycle bin, each with its table as the SQL Workshop sees it now (gone: purged elsewhere, forgotten). */
async function binContents(s: Session) {
  const rows = (await owner.query<BinRow>('select id::text, schema_name, original_name, bin_name, table_oid, dropped_by, dropped_at from meta.recycle_bin where workspace_id = $1 order by dropped_at desc', [currentWorkspace(s)])).rows;
  if (!rows.length) return [];
  const db = await workshopDb(s);
  const live = new Map((await db.query<{ oid: number; schema: string; name: string; size: string; rows: string }>(
    `select c.oid::int as oid, n.nspname as schema, c.relname as name, pg_size_pretty(pg_total_relation_size(c.oid)) as size, greatest(c.reltuples, 0)::bigint::text as rows
       from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid = any($1::oid[])`, [rows.map((r) => r.table_oid)])).rows.map((r) => [r.oid, r]));
  const gone = rows.filter((r) => { const t = live.get(Number(r.table_oid)); return !t || t.name !== r.bin_name || t.schema !== r.schema_name; });
  if (gone.length) await owner.query('delete from meta.recycle_bin where id = any($1::bigint[])', [gone.map((r) => r.id)]);
  return rows.filter((r) => !gone.includes(r)).map((r) => ({ ...r, ...live.get(Number(r.table_oid))! }));
}

async function binPage(s: Session) {
  const tx = tr(s);
  const list = await binContents(s);
  const when = (d: Date) => new Date(d).toISOString().slice(0, 16).replace('T', ' ');
  const table = list.length
    ? html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>${tx('rb.col.table')}</th><th>${tx('rb.col.dropped')}</th><th class="num">${tx('rb.col.rows')}</th><th class="num">${tx('rb.col.size')}</th><th>${tx('rb.col.bin_name')}</th><th></th></tr></thead><tbody>
      ${list.map((r) => html`<tr>
        <td data-label="${tx('rb.col.table')}" class="wrap-anywhere"><b>${r.schema_name}.${r.original_name}</b></td>
        <td data-label="${tx('rb.col.dropped')}">${when(r.dropped_at)}${r.dropped_by ? html` <span class="muted">${r.dropped_by}</span>` : ''}</td>
        <td class="num" data-label="${tx('rb.col.rows')}">${r.rows}</td>
        <td class="num" data-label="${tx('rb.col.size')}">${r.size}</td>
        <td data-label="${tx('rb.col.bin_name')}"><code class="small">${r.bin_name}</code></td>
        <td><div class="buttons u-m0">
          <form method="post" action="${BIN}/${r.id}/restore" class="search u-m0 u-mwnone">${csrf(s)}
            <input name="name" value="${r.original_name}" aria-label="${tx('rb.restore_as', { name: r.original_name })}" maxlength="63" pattern="[A-Za-z_][A-Za-z0-9_$]{0,62}">
            <button class="btn btn-sm">${icon('history')} ${tx('rb.restore')}</button></form>
          <form method="post" action="${BIN}/${r.id}/purge" class="u-inline">${csrf(s)}<button class="btn btn-sm btn-danger" data-confirm="${tx('rb.purge_confirm', { name: `${r.schema_name}.${r.original_name}` })}">${icon('trash')} ${tx('rb.purge')}</button></form>
        </div></td></tr>`)}
      </tbody></table></div>
      <form method="post" action="${BIN}/purge-all" class="buttons">${csrf(s)}<button class="btn btn-danger" data-confirm="${tx('rb.purge_all_confirm', { n: list.length })}">${icon('trash')} ${tx('rb.purge_all')}</button></form>`
    : html`<p class="muted">${tx('rb.empty')}</p>`;
  const main = html`<h1 class="u-mb1">${tx('rail.sql_workshop')}</h1>${workshopTabs('recycle', s)}
    <p class="muted">${tx('rb.intro')}</p>
    ${region(tx('sql.tool.recycle'), table)}`;
  return shell(s, tx('sql.tool.recycle'), [[tx('rail.sql_workshop'), `${BASE}/sql`], [tx('sql.tool.recycle')]], main, 'sql');
}

/** A table of a schema the SQL Workshop may use, by its schema and name: its oid, or null. */
async function tableOid(s: Session, schema: unknown, name: unknown) {
  if (typeof schema !== 'string' || typeof name !== 'string' || SYSTEM_SCHEMAS.includes(schema) || isBinName(name)) return null;
  const db = await workshopDb(s);
  if (!(await usableSchemas(db)).includes(schema)) return null;
  return (await db.one<{ oid: number }>(
    `select c.oid::int as oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and c.relname = $2 and c.relkind in ('r', 'p') and not c.relispartition`, [schema, name]))?.oid ?? null;
}

/** Run one statement on the SQL Workshop's connection: null, or the error's message. */
async function run(s: Session, sql: string) {
  const db = await workshopDb(s);
  try {
    await db.tx(async (c) => {
      await c.query(sql);
    });
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

async function oneOf(s: Session, id: unknown) {
  if (!/^\d{1,18}$/.test(String(id ?? ''))) return null;
  return (await owner.one<BinRow>('select id::text, schema_name, original_name, bin_name, table_oid, dropped_by, dropped_at from meta.recycle_bin where id = $1 and workspace_id = $2', [id, currentWorkspace(s)])) ?? null;
}

export async function recycleBinRoutes(app: FastifyInstance) {
  app.get(BIN, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    return send(reply, s, await binPage(s));
  });

  // from a table's menu: confirm first (the menu's entries are links)
  app.get(`${BIN}/drop`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const tx = tr(s);
    const { schema, name } = (req.query ?? {}) as Record<string, string>;
    if (!(await tableOid(s, schema, name))) return reply.code(404).send('Not found');
    const main = html`<h1 class="u-mb1">${tx('rail.sql_workshop')}</h1>${workshopTabs('recycle', s)}
      ${region(tx('rb.drop_title', { name: `${schema}.${name}` }), html`<p>${tx('rb.drop_help')}</p>
        <form method="post" action="${BIN}/drop" class="buttons">${csrf(s)}<input type="hidden" name="schema" value="${schema}"><input type="hidden" name="name" value="${name}">
          <a class="btn" href="${BASE}/sql/objects?${new URLSearchParams({ schema })}">${tx('rb.cancel')}</a>
          <button class="btn btn-danger">${icon('trash')} ${tx('rb.drop_btn')}</button></form>`)}`;
    return send(reply, s, shell(s, tx('sql.tool.recycle'), [[tx('rail.sql_workshop'), `${BASE}/sql`], [tx('sql.tool.recycle'), BIN], [tx('rb.drop')]], main, 'sql'));
  });

  app.post(`${BIN}/drop`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const tx = tr(s);
    const schema = String(req.body?.schema ?? '');
    const name = String(req.body?.name ?? '');
    const oid = await tableOid(s, schema, name);
    if (!oid) return reply.code(404).send('Not found');
    const bin = binName();
    const sql = `alter table ${q(schema)}.${q(name)} rename to ${q(bin)}`;
    const error = await run(s, sql);
    if (error) {
      flash(s, tx('rb.failed', { error }), 'error');
      return back(reply, s, `${BASE}/sql/objects?${new URLSearchParams({ schema })}`);
    }
    await owner.query('insert into meta.recycle_bin (workspace_id, schema_name, original_name, bin_name, table_oid, dropped_by) values ($1, $2, $3, $4, $5, $6)',
      [currentWorkspace(s), schema, name, bin, oid, s.username]);
    await recordChanges({ workspaceId: currentWorkspace(s), author: s.username ?? '?', source: 'table', statements: [sql], defaultSchema: schema, name: `recycle_${name}`.toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 60) });
    await logActivity({ username: s.username, event: 'sql_command', ip: clientIp(req), detail: `recycle bin: ${schema}.${name} → ${bin}` });
    flash(s, tx('rb.dropped', { name: `${schema}.${name}` }));
    return back(reply, s, BIN);
  });

  app.post(`${BIN}/:id/restore`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const tx = tr(s);
    const r = await oneOf(s, req.params.id);
    if (!r) return reply.code(404).send('Not found');
    const name = String(req.body?.name ?? '').trim() || r.original_name;
    if (!NAME.test(name) || isBinName(name)) {
      flash(s, tx('rb.bad_name'), 'error');
      return back(reply, s, BIN);
    }
    const sql = `alter table ${q(r.schema_name)}.${q(r.bin_name)} rename to ${q(name)}`;
    const error = await run(s, sql);
    if (error) flash(s, /already exists/.test(error) ? tx('rb.name_taken', { name: `${r.schema_name}.${name}` }) : tx('rb.failed', { error }), 'error');
    else {
      await owner.query('delete from meta.recycle_bin where id = $1', [r.id]);
      await recordChanges({ workspaceId: currentWorkspace(s), author: s.username ?? '?', source: 'table', statements: [sql], defaultSchema: r.schema_name, name: `restore_${name}`.toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 60) });
      await logActivity({ username: s.username, event: 'sql_command', ip: clientIp(req), detail: `recycle bin: ${r.bin_name} restored as ${r.schema_name}.${name}` });
      flash(s, tx('rb.restored', { name: `${r.schema_name}.${name}` }));
    }
    return back(reply, s, BIN);
  });

  const purge = async (s: Session, r: BinRow) => {
    const error = await run(s, `drop table ${q(r.schema_name)}.${q(r.bin_name)}`);
    if (!error) await owner.query('delete from meta.recycle_bin where id = $1', [r.id]);
    return error;
  };

  app.post(`${BIN}/:id/purge`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const tx = tr(s);
    const r = await oneOf(s, req.params.id);
    if (!r) return reply.code(404).send('Not found');
    const error = await purge(s, r);
    if (error) flash(s, tx('rb.purge_failed', { name: `${r.schema_name}.${r.original_name}`, error }), 'error');
    else {
      await logActivity({ username: s.username, event: 'sql_command', ip: clientIp(req), detail: `recycle bin: ${r.schema_name}.${r.original_name} (${r.bin_name}) purged` });
      flash(s, tx('rb.purged', { name: `${r.schema_name}.${r.original_name}` }));
    }
    return back(reply, s, BIN);
  });

  app.post(`${BIN}/purge-all`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const tx = tr(s);
    let done = 0;
    const failed: string[] = [];
    for (const r of await binContents(s)) {
      if (await purge(s, r)) failed.push(`${r.schema_name}.${r.original_name}`);
      else done++;
    }
    await logActivity({ username: s.username, event: 'sql_command', ip: clientIp(req), detail: `recycle bin: ${done} purged${failed.length ? `, ${failed.length} not` : ''}` });
    flash(s, failed.length ? tx('rb.purged_some', { n: done, list: failed.join(', ') }) : tx('rb.purged_all', { n: done }), failed.length ? 'error' : 'ok');
    return back(reply, s, BIN);
  });
}
