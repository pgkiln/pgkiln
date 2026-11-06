import type { FastifyInstance, FastifyReply } from 'fastify';
import pg from 'pg';
import { PageCss } from '../css.ts';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { isNumeric } from '../runtime/report.ts';
import { renderChartBody, type ChartKind } from '../runtime/charts.ts';
import type { Session } from '../session.ts';
import { unloadStatement } from '../unload.ts';
import { back, BASE, csrf, developer, flash, region, send, shell, workshopTabs, type Body, type Req } from './ui.ts';
import { currentWorkspace, sessionSchema, workshopDb } from './workspaces.ts';
import { tr, translatorFor, type BuilderKey, type BuilderTranslate } from './i18n.ts';

// (sprint 97, Database Actions DA-6: Create Chart and Charts) A query drawn as a chart with pgkiln's own
// server-rendered charts (src/runtime/charts.ts): the worksheet's Chart tab draws the last query, guessing the label
// column (the first text or date column) and the value columns (the numbers); saved charts (meta.sql_chart,
// migration 110) are listed under SQL Workshop → Charts, the ones on the dashboard drawn there. A saved chart's
// SELECT runs read-only, with a statement timeout and at most 500 rows, as the workshop's connection.

export const SQL_CHART_KINDS: [ChartKind, BuilderKey][] = [['bar', 'ch.kind.bar'], ['column', 'ch.kind.column'], ['stacked', 'ch.kind.stacked'], ['line', 'ch.kind.line'], ['area', 'ch.kind.area'], ['donut', 'ch.kind.donut'], ['pie', 'ch.kind.pie'], ['scatter', 'ch.kind.scatter']];
const MAX_ROWS = 500;

export interface ChartSpec { kind: ChartKind; label: string; values: string[] }

/** The columns to draw: the ones asked for when they exist, else a label (first non-number) and the numbers. */
export function chartSpec(columns: string[], numeric: boolean[], asked: Partial<ChartSpec> = {}): ChartSpec | null {
  const kind = SQL_CHART_KINDS.some(([k]) => k === asked.kind) ? asked.kind! : 'bar';
  const label = asked.label && columns.includes(asked.label) ? asked.label : (columns.find((_, i) => !numeric[i]) ?? columns[0]);
  const wanted = (asked.values ?? []).filter((v) => columns.includes(v) && v !== label);
  const values = wanted.length ? wanted : columns.filter((c, i) => numeric[i] && c !== label);
  return label && values.length ? { kind, label, values } : null;
}

/** A chart of rows (text values from the worksheet, or values from a query), with the rules for the page's <style>. */
export function drawChart(title: string, columns: string[], rows: unknown[][], spec: ChartSpec): { body: Raw; css: string } {
  const css = new PageCss();
  const li = columns.indexOf(spec.label);
  const vi = spec.values.map((v) => columns.indexOf(v));
  const data = rows.map((r) => [r[li] === null || r[li] === undefined ? '' : String(r[li]), ...vi.map((i) => (r[i] === null || r[i] === undefined || r[i] === '' ? null : Number(r[i])))]);
  const body = renderChartBody(spec.kind, title, data, [{ name: spec.label }, ...spec.values.map((name) => ({ name }))], css);
  return { body, css: css.text };
}

/** The controls of a chart (type, label column, value columns), named chart_*. */
export function chartControls(columns: string[], spec: ChartSpec, idPrefix = 'ch', tx: BuilderTranslate = translatorFor('en')): Raw {
  return html`<div class="ch-controls">
    <label><span>${tx('ch.type')}</span><select name="chart_kind" id="${idPrefix}-kind">${SQL_CHART_KINDS.map(([k, label]) => html`<option value="${k}"${k === spec.kind ? raw(' selected') : ''}>${tx(label)}</option>`)}</select></label>
    <label><span>${tx('ch.labels')}</span><select name="chart_label" id="${idPrefix}-label">${columns.map((c) => html`<option value="${c}"${c === spec.label ? raw(' selected') : ''}>${c}</option>`)}</select></label>
    <fieldset><legend>${tx('ch.values')}</legend>${columns.map((c) => html`<label class="check"><input type="checkbox" name="chart_values" value="${c}"${spec.values.includes(c) ? raw(' checked') : ''}> ${c}</label>`)}</fieldset>
  </div>`;
}

const list = (v: unknown) => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v]).map(String);
export const askedSpec = (b: Body): Partial<ChartSpec> => ({ kind: b.chart_kind as ChartKind, label: typeof b.chart_label === 'string' ? b.chart_label : undefined, values: list(b.chart_values) });

interface SavedChart { id: number; name: string; sql: string; kind: ChartKind; label_col: string; value_cols: string[]; on_dashboard: boolean; created_by: string | null; updated_at: string }

/** A saved chart's SELECT, run read-only: columns, which are numbers, and the rows. */
async function runChart(s: Session, sql: string) {
  const db = await workshopDb(s);
  const schema = await sessionSchema(s, db);
  const c = await db.pool.connect();
  try {
    await c.query('begin transaction read only');
    await c.query(`select set_config('statement_timeout', '10s', true)`);
    if (schema) await c.query(`select set_config('search_path', $1, true)`, [`${pg.escapeIdentifier(schema)}, public`]);
    const res = await c.query({ text: `select * from (${unloadStatement(sql)}\n) chart_rows limit ${MAX_ROWS}`, rowMode: 'array' });
    return { columns: res.fields.map((f) => f.name), numeric: res.fields.map((f) => isNumeric(f.dataTypeID)), rows: res.rows as unknown[][] };
  } finally {
    await c.query('rollback').catch(() => {});
    c.release(true);
  }
}

async function chartCard(s: Session, ch: SavedChart, full = false): Promise<{ body: Raw; css: string }> {
  const tx = tr(s);
  try {
    const r = await runChart(s, ch.sql);
    const spec = chartSpec(r.columns, r.numeric, { kind: ch.kind, label: ch.label_col, values: ch.value_cols });
    if (!spec) return { body: html`<p class="muted">${tx('ch.no_number')}</p>`, css: '' };
    const d = drawChart(ch.name, r.columns, r.rows, spec);
    return { body: html`${d.body}${full ? html`<p class="muted small">${r.rows.length === MAX_ROWS ? tx('ch.rows_first', { n: MAX_ROWS }) : r.rows.length === 1 ? tx('ch.row_one') : tx('ch.rows', { n: r.rows.length })}</p>` : ''}`, css: d.css };
  } catch (e) {
    return { body: html`<p class="alert alert-error">${(e as Error).message}</p>`, css: '' };
  }
}

const style = (nonce: string, css: string) => (css ? html`<style nonce="${nonce}">${raw(css.replace(/</g, ''))}</style>` : '');

export async function sqlChartRoutes(app: FastifyInstance) {
  // the list and the dashboard
  app.get(`${BASE}/sql/charts`, async (req: Req, reply: FastifyReply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const charts = (await owner.query<SavedChart>('select * from meta.sql_chart where workspace_id = $1 order by lower(name)', [currentWorkspace(s)])).rows;
    const tx = tr(s);
    let css = '';
    const cards: Raw[] = [];
    for (const ch of charts.filter((c) => c.on_dashboard)) {
      const card = await chartCard(s, ch);
      css += `\n${card.css}`;
      cards.push(html`<section class="ch-card"><h2><a href="${BASE}/sql/charts/${ch.id}">${ch.name}</a></h2>${card.body}</section>`);
    }
    const kindLabel = (k: string) => { const x = SQL_CHART_KINDS.find(([kk]) => kk === k); return x ? tx(x[1]) : k; };
    const main = html`<h1 class="u-mb1">${tx('sql.tool.charts')}</h1>${workshopTabs('charts', s)}${style(req.cspNonce, css)}
      <p class="muted">${tx.rich('ch.intro', { worksheet: html`<a href="${BASE}/sql/worksheet">${tx('sql.tool.worksheet')}</a>` })}</p>
      ${cards.length ? html`<div class="ch-dashboard">${cards}</div>` : ''}
      ${region(tx('ch.all'), charts.length ? html`<div class="table-wrap"><table class="report"><thead><tr><th>${tx('ch.chart')}</th><th>${tx('ch.type')}</th><th>${tx('ch.on_dashboard_col')}</th><th>${tx('ch.changed')}</th></tr></thead><tbody>
        ${charts.map((c) => html`<tr><td><a href="${BASE}/sql/charts/${c.id}">${c.name}</a></td><td>${kindLabel(c.kind)}</td><td>${c.on_dashboard ? tx('ch.yes') : tx('ch.no')}</td>
          <td>${new Date(c.updated_at).toISOString().slice(0, 16).replace('T', ' ')}${c.created_by ? html` <span class="muted small">${tx('scr.by', { user: c.created_by })}</span>` : ''}</td></tr>`)}</tbody></table></div>`
        : html`<p class="muted">${tx('ch.none_yet')}</p>`)}`;
    return send(reply, s, shell(s, tx('sql.tool.charts'), [[tx('rail.sql_workshop'), `${BASE}/sql`], [tx('sql.tool.charts')]], main, 'sql'));
  });

  // one chart: drawn, with its settings
  app.get(`${BASE}/sql/charts/:id`, async (req: Req, reply: FastifyReply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const ch = /^\d{1,9}$/.test(String(req.params.id)) ? await owner.one<SavedChart>('select * from meta.sql_chart where id = $1 and workspace_id = $2', [req.params.id, currentWorkspace(s)]) : undefined;
    if (!ch) return reply.code(404).send('Not found');
    const card = await chartCard(s, ch, true);
    const tx = tr(s);
    let controls: Raw | '' = '';
    try {
      const r = await runChart(s, ch.sql);
      const spec = chartSpec(r.columns, r.numeric, { kind: ch.kind, label: ch.label_col, values: ch.value_cols });
      if (spec) controls = chartControls(r.columns, spec, 'sch', tx);
    } catch {
      controls = '';
    }
    const main = html`<h1 class="u-mb1">${ch.name}</h1>${workshopTabs('charts', s)}${style(req.cspNonce, card.css)}
      <div class="ch-view">${card.body}</div>
      <form method="post" action="${BASE}/sql/charts/${ch.id}" class="ch-edit">${csrf(s)}
        <div class="field"><label class="label" for="ch-name">${tx('scr.name')}</label><input id="ch-name" name="name" value="${ch.name}" maxlength="120" required></div>
        ${controls}
        <label class="check"><input type="checkbox" name="on_dashboard"${ch.on_dashboard ? raw(' checked') : ''}> ${tx('ch.on_dashboard')}</label>
        <details class="u-mt1"><summary>${tx('ch.query')}</summary><pre class="source" data-code-view="sql" tabindex="0" aria-label="${tx('ch.query')}">${ch.sql}</pre></details>
        <div class="buttons"><button class="btn btn-hot" name="action" value="save">${icon('save')} ${tx('scr.save')}</button>
          <button class="btn" name="action" value="worksheet">${icon('code')} ${tx('ch.open_worksheet')}</button>
          <button class="btn btn-danger" name="action" value="delete" data-confirm="${tx('ch.delete_confirm', { name: ch.name })}">${icon('trash')} ${tx('scr.delete')}</button></div>
      </form>`;
    return send(reply, s, shell(s, ch.name, [[tx('rail.sql_workshop'), `${BASE}/sql`], [tx('sql.tool.charts'), `${BASE}/sql/charts`], [ch.name]], main, 'sql'));
  });

  // save a chart from the worksheet (a new one), or change, open or delete a saved one
  const save = async (req: Req, reply: FastifyReply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = req.body ?? {};
    const ws = currentWorkspace(s);
    const tx = tr(s);
    const id = req.params?.id;
    const name = String(b.name ?? b.chart_name ?? '').trim();
    const asked = askedSpec(b);
    const kind = SQL_CHART_KINDS.some(([k]) => k === asked.kind) ? asked.kind! : 'bar';
    if (id !== undefined) {
      const ch = /^\d{1,9}$/.test(String(id)) ? await owner.one<SavedChart>('select * from meta.sql_chart where id = $1 and workspace_id = $2', [id, ws]) : undefined;
      if (!ch) return reply.code(404).send('Not found');
      if (b.action === 'delete') {
        await owner.query('delete from meta.sql_chart where id = $1', [ch.id]);
        flash(s, tx('ch.deleted', { name: ch.name }));
        return back(reply, s, `${BASE}/sql/charts`);
      }
      if (b.action === 'worksheet') {
        s.state.__SQLDRAFT = ch.sql;
        return back(reply, s, `${BASE}/sql/worksheet`);
      }
      if (!name || name.length > 120) {
        flash(s, tx('ch.err.name'), 'error');
        return back(reply, s, `${BASE}/sql/charts/${ch.id}`);
      }
      try {
        await owner.query(`update meta.sql_chart set name = $2, kind = $3, label_col = $4, value_cols = $5, on_dashboard = $6, updated_at = now() where id = $1`,
          [ch.id, name, kind, asked.label ?? ch.label_col, asked.values?.length ? asked.values : ch.value_cols, b.on_dashboard === 'on']);
      } catch (e) {
        if ((e as { code?: string }).code !== '23505') throw e;
        flash(s, tx('ch.err.exists', { name }), 'error');
        return back(reply, s, `${BASE}/sql/charts/${ch.id}`);
      }
      flash(s, tx('ch.saved', { name }));
      return back(reply, s, `${BASE}/sql/charts/${ch.id}`);
    }
    let sql = '';
    try {
      sql = unloadStatement(String(b.chart_sql ?? ''));
    } catch {
      flash(s, tx('ch.err.select'), 'error');
      return back(reply, s, `${BASE}/sql/worksheet`);
    }
    if (!name || name.length > 120) {
      flash(s, tx('ch.err.name_new'), 'error');
      return back(reply, s, `${BASE}/sql/worksheet`);
    }
    try {
      const r = await owner.one<{ id: number }>(
        `insert into meta.sql_chart (workspace_id, name, sql, kind, label_col, value_cols, created_by) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [ws, name, sql, kind, asked.label ?? '', asked.values ?? [], s.username]);
      flash(s, tx('ch.saved_new', { name }));
      return back(reply, s, `${BASE}/sql/charts/${r!.id}`);
    } catch (e) {
      if ((e as { code?: string }).code !== '23505') throw e;
      flash(s, tx('ch.err.exists', { name }), 'error');
      return back(reply, s, `${BASE}/sql/worksheet`);
    }
  };
  app.post(`${BASE}/sql/charts`, save);
  app.post(`${BASE}/sql/charts/:id`, save);
}
