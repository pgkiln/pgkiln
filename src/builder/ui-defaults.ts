import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw } from '../html.ts';
import { icon } from '../icons.ts';
import { back, BASE, csrf, developer, flash, region, send, shell, type Body, type Req } from './ui.ts';
import { usableSchemas, workshopDb } from './workspaces.ts';

// (sprint 138, AP-5) UI defaults (APEX: Attribute Dictionary / Table UI
// Defaults): per table column a label, format mask, help text, alignment and
// list of values, in meta.ui_default (migration 138). The page wizards and the
// Create Application wizard take the label from meta.wizard_column_label (a UI
// default wins); a form item a wizard makes also gets the mask, help and list
// of values (the meta.item trigger of migration 138). "Seed from comments" fills
// the columns without a UI default from their COMMENT ON: a short comment (60
// characters at most) as the label, a longer one as the help text.
//
// The tables are those the workspace's SQL Workshop connection can see
// (workshopDb: an isolated workspace's own schemas); a table or column name
// from a request is only used after it was found in that catalog.

export const ALIGNMENTS = ['', 'start', 'center', 'end'] as const;
/** Format masks: numbers (999G990D00, FML…) and dates (DD.MM.YYYY HH24:MI); the database checks the same. */
export const MASK = /^[A-Za-z0-9GDLSCFM.,:/ -]{1,60}$/;
const MAX_COLUMNS = 400;

interface Column {
  name: string;
  type: string;
  comment: string | null;
  wizard: string;
  d: { label: string | null; format_mask: string | null; help: string | null; alignment: string | null; lov: string | null; updated_by: string | null; updated_at: string | null } | null;
}

/** A table the session's catalog can see: [schema, table], or null. */
async function findTable(s: Parameters<typeof workshopDb>[0], schema: unknown, table: unknown) {
  if (typeof schema !== 'string' || typeof table !== 'string' || !schema || !table) return null;
  const db = await workshopDb(s);
  if (!(await usableSchemas(db)).includes(schema)) return null;
  const r = await db.one<{ oid: number }>(
    `select c.oid::int as oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relname = $2 and c.relkind in ('r', 'p', 'v', 'm', 'f')`, [schema, table]);
  return r ? { schema, table, oid: r.oid } : null;
}

async function columnsOf(oid: number, schema: string, table: string): Promise<Column[]> {
  const cols = (await owner.query(
    `select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, col_description(a.attrelid, a.attnum) as comment,
            meta.wizard_column_label(a.attrelid::regclass, a.attname) as wizard
       from pg_attribute a where a.attrelid = $1 and a.attnum > 0 and not a.attisdropped order by a.attnum limit ${MAX_COLUMNS}`, [oid])).rows;
  const defaults = new Map((await owner.query(
    `select column_name, label, format_mask, help, alignment, lov, updated_by, updated_at::text from meta.ui_default where schema_name = $1 and table_name = $2`,
    [schema, table])).rows.map((r) => [r.column_name, r]));
  return cols.map((c) => ({ ...c, d: defaults.get(c.name) ?? null }));
}

const trim = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

export async function uiDefaultRoutes(app: FastifyInstance) {
  app.get(`${BASE}/ui-defaults`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const db = await workshopDb(s);
    const schemas = await usableSchemas(db);
    const q = req.query ?? {};
    const schema = typeof q.schema === 'string' && schemas.includes(q.schema) ? q.schema : '';
    const tables = schema
      ? (await db.query<{ name: string; n: number }>(
          `select c.relname as name, (select count(*) from meta.ui_default d where d.schema_name = $1 and d.table_name = c.relname)::int as n
             from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and c.relkind in ('r', 'p', 'v', 'm', 'f') and not c.relispartition order by 1`,
          [schema])).rows
      : [];
    const t = schema ? await findTable(s, schema, q.table) : null;
    const counts = (await owner.query<{ schema_name: string; n: number }>('select schema_name, count(*)::int as n from meta.ui_default group by 1')).rows;
    const pick = html`<form method="get" class="util-filters">
        <div class="field"><label class="label" for="f_schema">Schema</label><select id="f_schema" name="schema"><option value="">Choose a schema</option>
          ${schemas.map((n) => html`<option value="${n}"${n === schema ? raw(' selected') : ''}>${n}${counts.find((c) => c.schema_name === n) ? ` (${counts.find((c) => c.schema_name === n)!.n})` : ''}</option>`)}</select></div>
        ${schema ? html`<div class="field"><label class="label" for="f_table">Table or view</label><select id="f_table" name="table"><option value="">Choose a table</option>
          ${tables.map((x) => html`<option value="${x.name}"${x.name === t?.table ? raw(' selected') : ''}>${x.name}${x.n ? ` (${x.n})` : ''}</option>`)}</select></div>` : ''}
        <div class="buttons"><button class="btn btn-sm">${icon('table')} Show</button></div></form>`;
    let body = html`${pick}`;
    if (t) {
      const cols = await columnsOf(t.oid, t.schema, t.table);
      body = html`${pick}
        <form method="post" action="${BASE}/ui-defaults">${csrf(s)}<input type="hidden" name="schema" value="${t.schema}"><input type="hidden" name="table" value="${t.table}">
          <div class="table-wrap"><table class="table ui-defaults"><thead><tr><th scope="col">Column</th><th scope="col">Label</th><th scope="col">Format mask</th><th scope="col">Alignment</th><th scope="col">Help</th><th scope="col">List of values</th></tr></thead><tbody>
          ${cols.map((c, i) => html`<tr>
            <td data-label="Column"><code>${c.name}</code><br><span class="muted small">${c.type}</span><input type="hidden" name="c.${i}.name" value="${c.name}"></td>
            <td data-label="Label"><input id="f_l${i}" aria-label="Label of ${c.name}" name="c.${i}.label" value="${c.d?.label ?? ''}" maxlength="200" placeholder="${c.wizard}"></td>
            <td data-label="Format mask"><input id="f_m${i}" aria-label="Format mask of ${c.name}" name="c.${i}.format_mask" value="${c.d?.format_mask ?? ''}" maxlength="60" placeholder="${/numeric|integer|bigint|smallint|real|double/.test(c.type) ? '999G990D00' : /date|time/.test(c.type) ? 'DD.MM.YYYY' : ''}"></td>
            <td data-label="Alignment"><select id="f_a${i}" aria-label="Alignment of ${c.name}" name="c.${i}.alignment">${ALIGNMENTS.map((x) => html`<option value="${x}"${(c.d?.alignment ?? '') === x ? raw(' selected') : ''}>${x || '–'}</option>`)}</select></td>
            <td data-label="Help"><textarea id="f_h${i}" aria-label="Help of ${c.name}" name="c.${i}.help" rows="1" maxlength="4000">${c.d?.help ?? ''}</textarea></td>
            <td data-label="List of values"><input id="f_v${i}" aria-label="List of values of ${c.name}" name="c.${i}.lov" value="${c.d?.lov ?? ''}" maxlength="4000" placeholder="LOV:NAME"></td>
          </tr>`)}</tbody></table></div>
          <div class="buttons"><button class="btn btn-hot" name="mode" value="save">${icon('save')} Save</button>
            <button class="btn" name="mode" value="seed">${icon('edit')} Seed from comments</button></div>
          <p class="muted small">An empty row has no UI default. The placeholder of a label shows what the wizards use without one. Lists of values: <code>LOV:NAME</code> (a shared list of values of the application), <code>STATIC:Yes;Y,No;N</code> or a query (<code>select name d, id r from sales.status</code>).</p>
        </form>`;
    }
    const main = html`<h1 class="u-mb1">UI defaults</h1>
      ${region('UI defaults per column', html`<p class="muted u-mt0">Label, format mask, help text, alignment and list of values per table column (APEX: Attribute Dictionary). The page wizards and the Create Application wizard use the label for every generated report heading and form item, and a generated form item also gets the format mask, help and list of values. They apply to pages generated after the change, in every application.</p>${body}`)}`;
    return send(reply, s, shell(s, 'UI defaults', [['App Builder', BASE], ['Workspace utilities', `${BASE}/utilities`], ['UI defaults']], main));
  });

  app.post(`${BASE}/ui-defaults`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b: Body = req.body ?? {};
    const t = await findTable(s, b.schema, b.table);
    if (!t) return reply.code(404).send('Not found');
    const to = `${BASE}/ui-defaults?${new URLSearchParams({ schema: t.schema, table: t.table })}`;
    const cols = await columnsOf(t.oid, t.schema, t.table);
    const known = new Map(cols.map((c) => [c.name, c]));
    try {
      if (b.mode === 'seed') {
        // columns without a UI default: a short comment is the label, a longer one the help text
        let n = 0;
        for (const c of cols) {
          if (c.d || !c.comment?.trim()) continue;
          const text = c.comment.trim();
          const short = text.length <= 60 && !text.includes('\n');
          await owner.query(
            `insert into meta.ui_default (schema_name, table_name, column_name, label, help, updated_by) values ($1, $2, $3, $4, $5, $6) on conflict do nothing`,
            [t.schema, t.table, c.name, short ? text : null, short ? null : text.slice(0, 4000), s.username]);
          n++;
        }
        flash(s, n ? `UI defaults of ${n} column${n === 1 ? '' : 's'} made from their comments.` : 'No column without a UI default has a comment.');
        return back(reply, s, to);
      }
      const rows: { name: string; label: string | null; mask: string | null; help: string | null; align: string | null; lov: string | null }[] = [];
      for (let i = 0; i < MAX_COLUMNS; i++) {
        const name = b[`c.${i}.name`];
        if (typeof name !== 'string' || !known.has(name)) continue;
        const mask = trim(b[`c.${i}.format_mask`], 60);
        if (mask && !MASK.test(mask)) throw new Error(`Format mask of ${name}: letters, digits and . , : / - only (e.g. 999G990D00 or DD.MM.YYYY).`);
        const align = trim(b[`c.${i}.alignment`], 10);
        if (align && !(ALIGNMENTS as readonly string[]).includes(align)) throw new Error(`Alignment of ${name}: start, center or end.`);
        rows.push({ name, label: trim(b[`c.${i}.label`], 200), mask, help: trim(b[`c.${i}.help`], 4000), align, lov: trim(b[`c.${i}.lov`], 4000) });
      }
      await owner.tx(async (c) => {
        for (const r of rows) {
          const before = known.get(r.name)!.d;
          if (!r.label && !r.mask && !r.help && !r.align && !r.lov) {
            if (before) await c.query('delete from meta.ui_default where schema_name = $1 and table_name = $2 and column_name = $3', [t.schema, t.table, r.name]);
            continue;
          }
          if (before && before.label === r.label && before.format_mask === r.mask && before.help === r.help && before.alignment === r.align && before.lov === r.lov) continue;
          await c.query(
            `insert into meta.ui_default (schema_name, table_name, column_name, label, format_mask, help, alignment, lov, updated_by)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             on conflict (schema_name, table_name, column_name) do update set label = excluded.label, format_mask = excluded.format_mask, help = excluded.help,
               alignment = excluded.alignment, lov = excluded.lov, updated_by = excluded.updated_by, updated_at = now()`,
            [t.schema, t.table, r.name, r.label, r.mask, r.help, r.align, r.lov, s.username]);
        }
      });
      flash(s, `UI defaults of ${t.schema}.${t.table} saved.`);
    } catch (e) {
      flash(s, (e as Error).message, 'error');
    }
    return back(reply, s, to);
  });
}
