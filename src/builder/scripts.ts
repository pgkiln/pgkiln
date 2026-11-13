import type { FastifyInstance, FastifyReply } from 'fastify';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { readMultipart } from '../runtime/files.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import { runScript, splitScript, type ScriptRun, type StatementResult } from '../sqlscript.ts';
import { clearCompletions } from './code-editor.ts';
import { back, BASE, csrf, developer, flash, region, send, shell, workshopTabs, type Body, type Req } from './ui.ts';
import { currentWorkspace, sessionSchema, workshopDb } from './workspaces.ts';
import { auditRun } from './owner-connection.ts';
import { tr, translatorFor, type BuilderTranslate } from './i18n.ts';

// SQL Workshop → SQL Scripts: saved scripts (create, edit, upload, download,
// delete), run with a result per statement (stop at the first error or go on,
// optionally in one transaction), and the run history. Scripts run on the
// owner connection, like the SQL Worksheet, on a connection of their own that is
// closed afterwards (a script may SET ROLE or change settings). Scripts and runs belong
// to the current workspace; an isolated workspace's run on its developer login (090).

/** Largest script (upload or editor), in MB. */
export const SCRIPT_MAX_MB = 5;
/** Runs kept in the history (the oldest go first). */
const KEEP_RUNS = 500;

export interface RunRequest {
  scriptId: number | null;
  name: string;
  content: string;
  stopOnError: boolean;
  transaction: boolean;
}

/** Run a script, record the run (history + activity log) and return the run's id. */
export async function runAndRecord(s: Session, ip: string, r: RunRequest): Promise<{ id: string; run: ScriptRun }> {
  const statements = splitScript(r.content);
  const db = await workshopDb(s, { raw: true });
  const schema = await sessionSchema(s, db);
  const c = await db.pool.connect();
  let run: ScriptRun;
  try {
    // (sprint 61) the session's schema first in the search path (the SQL Workshop home)
    if (schema) await c.query(`select set_config('search_path', $1, false)`, [`"${schema.replace(/"/g, '""')}", public`]);
    run = await runScript(c, statements, { stopOnError: r.stopOnError, transaction: r.transaction });
  } finally {
    // never hand a connection back to the pool after arbitrary SQL (SET ROLE, search_path, temp tables)
    c.release(true);
  }
  clearCompletions(); // the script may have changed tables or grants
  // (sprint 185, NX-S1) on the Owner connection: every statement into meta.owner_sql_audit
  await auditRun(s, 'scripts', run.results.map((x) => ({
    sql: statements[x.n - 1]?.sql ?? x.sql, status: x.status, rows: x.rows, error: x.error, ms: x.ms })));
  const saved = await owner.one<{ id: string }>(
    `insert into meta.sql_script_run (script_id, script_name, run_by, elapsed_ms, stop_on_error, transactional, statements, succeeded, failed, rolled_back, results, workspace_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
    [r.scriptId, r.name, s.username, run.ms, r.stopOnError, r.transaction, run.statements, run.succeeded, run.failed, run.rolledBack,
      JSON.stringify(run.commitError ? [...run.results, { n: 0, line: 0, sql: 'COMMIT', status: 'error', error: run.commitError, ms: 0 }] : run.results),
      currentWorkspace(s)],
  );
  await owner.query(
    `delete from meta.sql_script_run where workspace_id = $2
        and id <= (select id from meta.sql_script_run where workspace_id = $2 order by id desc offset $1 limit 1)`,
    [KEEP_RUNS, currentWorkspace(s)],
  );
  await logActivity({
    username: s.username,
    event: 'sql_script',
    ip,
    elapsedMs: run.ms,
    detail: `${r.name}: ${run.statements} statement(s), ${run.succeeded} ok, ${run.failed} failed${run.rolledBack ? ', rolled back' : ''}`,
  });
  return { id: saved!.id, run };
}

const bytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const when = (t: string | Date) => String(t instanceof Date ? t.toISOString() : t).replace('T', ' ').slice(0, 19);

/** A safe download file name for a script name. */
export const scriptFileName = (name: string) => `${name.replace(/\.sql$/i, '').replace(/[^\w.-]+/g, '_').replace(/^[._]+/, '').slice(0, 100) || 'script'}.sql`;

function statusTag(tx: BuilderTranslate, r: Pick<StatementResult, 'status'>) {
  const [cls, label] =
    r.status === 'ok' ? ['tag tag-ok', 'OK'] : r.status === 'error' ? ['tag tag-error', tx('scr.error')] : r.status === 'skipped' ? ['tag tag-warning', tx('scr.skipped')] : ['tag', tx('scr.not_run')];
  return html`<span class="${cls}">${label}</span>`;
}

function runSummary(tx: BuilderTranslate, run: { statements: number; succeeded: number; failed: number; rolled_back?: boolean; transactional?: boolean; stop_on_error?: boolean }) {
  const ok = run.failed === 0;
  const rest = run.statements - run.succeeded - run.failed;
  return html`<div class="alert ${ok ? 'alert-success' : 'alert-error'}" role="${ok ? 'status' : 'alert'}">
    ${rest > 0 ? tx('scr.summary_rest', { n: run.statements, ok: run.succeeded, failed: run.failed, rest }) : tx('scr.summary', { n: run.statements, ok: run.succeeded, failed: run.failed })}
    ${run.rolled_back ? html` <strong>${tx('scr.rolled_back_note')}</strong>` : ''}</div>`;
}

export function resultsHtml(results: StatementResult[], tx: BuilderTranslate = translatorFor('en')) {
  if (!results.length) return html`<p class="muted">${tx('scr.no_statements')}</p>`;
  return html`<ol class="script-results">${results.map(
    (r) => html`<li class="script-result">
      <div class="script-result-head">${statusTag(tx, r)} <strong>#${r.n || '-'}</strong>
        <span class="muted small">${r.line ? tx('scr.line', { line: r.line }) : ''}${r.status === 'ok' ? ` · ${r.command ?? tx('scr.done')}${r.rows !== null && r.rows !== undefined ? `, ${tx('scr.rows', { n: r.rows })}` : ''}` : ''}${r.status === 'ok' || r.status === 'error' ? ` · ${r.ms} ms` : ''}</span></div>
      <details class="script-sql"><summary><code>${r.sql.length > 120 ? `${r.sql.slice(0, 120).replace(/\s+/g, ' ')}…` : r.sql.replace(/\s+/g, ' ')}</code></summary><pre class="source" data-code-view="sql" tabindex="0" aria-label="${tx('sm.statement')}">${r.sql}</pre></details>
      ${r.error ? html`<div class="alert ${r.status === 'error' ? 'alert-error' : 'alert-note'}">${r.error}</div>` : ''}
      ${r.columns?.length
        ? html`<div class="table-wrap"><table class="report"><thead><tr>${r.columns.map((c) => html`<th>${c}</th>`)}</tr></thead>
            <tbody>${(r.sample ?? []).map((row) => html`<tr>${row.map((v) => html`<td>${v === null ? html`<span class="null">null</span>` : v}</td>`)}</tr>`)}</tbody></table></div>
            ${r.rows && r.sample && r.rows > r.sample.length ? html`<p class="muted small">${tx('scr.first_rows', { shown: r.sample.length, n: r.rows })}</p>` : ''}`
        : ''}
    </li>`,
  )}</ol>`;
}

/** Run options (radio + checkbox), shared by the script editor and Quick SQL. */
export const runOptions = (b: Body = {}, tx: BuilderTranslate = translatorFor('en')) => html`<fieldset class="field"><legend class="label">${tx('scr.when_fails')}</legend><div class="radio-group">
    <label class="check"><input type="radio" name="on_error" value="stop"${b.on_error !== 'continue' ? raw(' checked') : ''}> ${tx('scr.stop')}</label>
    <label class="check"><input type="radio" name="on_error" value="continue"${b.on_error === 'continue' ? raw(' checked') : ''}> ${tx('scr.continue')}</label></div></fieldset>
  <div class="field"><label class="check"><input type="checkbox" name="transaction" value="true"${b.transaction === 'true' ? raw(' checked') : ''}> ${tx('scr.one_tx')}</label></div>`;

export async function scriptRoutes(app: FastifyInstance) {
  const page = (s: Session, reply: FastifyReply, title: string, crumbs: [string, string?][], main: Raw) =>
    send(reply, s, shell(s, title, [[tr(s)('rail.sql_workshop'), `${BASE}/sql`], ...crumbs], html`<h1 class="u-mb1">${tr(s)('rail.sql_workshop')}</h1>${workshopTabs('scripts', s)}${main}`, 'sql'));

  const historyTable = (tx: BuilderTranslate, runs: any[], withName: boolean) =>
    runs.length
      ? html`<div class="table-wrap"><table class="report"><thead><tr><th>${tx('scr.col.started')}</th>${withName ? html`<th>${tx('scr.col.script')}</th>` : ''}<th>${tx('scr.col.by')}</th><th class="num">${tx('scr.col.statements')}</th><th class="num">${tx('scr.col.failed')}</th><th class="num">ms</th><th>${tx('scr.col.result')}</th></tr></thead><tbody>
          ${runs.map((r) => html`<tr><td><a href="${BASE}/sql/scripts/runs/${r.id}">${when(r.started_at)}</a></td>${withName ? html`<td>${r.script_name}</td>` : ''}<td>${r.run_by}</td>
            <td class="num">${r.statements}</td><td class="num">${r.failed}</td><td class="num">${r.elapsed_ms}</td>
            <td>${r.failed ? html`<span class="tag tag-error">${r.rolled_back ? tx('scr.rolled_back') : tx('scr.errors')}</span>` : html`<span class="tag tag-ok">OK</span>`}</td></tr>`)}
        </tbody></table></div>`
      : html`<p class="muted">${tx('scr.no_runs')}</p>`;

  // ------------------------------------------------------------ list
  app.get(`${BASE}/sql/scripts`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const scripts = (
      await owner.query(
        `select s.id, s.name, s.description, octet_length(s.content) as size, s.updated_at, s.updated_by,
                r.started_at as last_run, r.failed as last_failed
           from meta.sql_script s
           left join lateral (select started_at, failed from meta.sql_script_run x where x.script_id = s.id order by x.id desc limit 1) r on true
          where s.workspace_id = $1
          order by lower(s.name)`,
        [currentWorkspace(s)],
      )
    ).rows;
    const runs = (await owner.query('select * from meta.sql_script_run where workspace_id = $1 order by id desc limit 20', [currentWorkspace(s)])).rows;
    const tx = tr(s);
    const list = scripts.length
      ? html`<div class="table-wrap"><table class="report"><thead><tr><th>${tx('scr.col.script')}</th><th>${tx('scr.col.updated')}</th><th class="num">${tx('scr.col.size')}</th><th>${tx('scr.col.last_run')}</th><th>${tx('scr.col.open')}</th></tr></thead><tbody>
          ${scripts.map((x) => html`<tr><td><a href="${BASE}/sql/scripts/${x.id}">${x.name}</a>${x.description ? html`<br><span class="muted small">${x.description}</span>` : ''}</td>
            <td>${when(x.updated_at)}${x.updated_by ? html` <span class="muted small">${tx('scr.by', { user: x.updated_by })}</span>` : ''}</td><td class="num">${bytes(Number(x.size))}</td>
            <td>${x.last_run ? html`${when(x.last_run)} ${x.last_failed ? html`<span class="tag tag-error">${tx('scr.errors')}</span>` : html`<span class="tag tag-ok">OK</span>`}` : html`<span class="muted">${tx('scr.never')}</span>`}</td>
            <td><a class="btn btn-sm" href="${BASE}/sql/worksheet?script=${x.id}">${icon('code')} ${tx('scr.worksheet')}</a> <a class="btn btn-sm" href="${BASE}/sql/scripts/${x.id}/download">${icon('download')} ${tx('scr.download')}</a></td></tr>`)}
        </tbody></table></div>`
      : html`<p class="muted">${tx('scr.none_yet')}</p>`;
    return page(
      s,
      reply,
      tx('sql.tool.scripts'),
      [[tx('sql.tool.scripts')]],
      html`<div class="buttons u-mb1"><a class="btn btn-hot" href="${BASE}/sql/scripts/new">${icon('plus')} ${tx('scr.create')}</a>
          <a class="btn" href="${BASE}/sql/quick">${icon('bolt')} ${tx('sql.tool.quicksql')}</a></div>
        ${region(tx('scr.scripts'), list, html`<span class="count">${scripts.length}</span>`)}
        <div class="u-spacer"></div>
        ${region(tx('scr.upload_title'), html`<form method="post" action="${BASE}/sql/scripts/upload" enctype="multipart/form-data">${csrf(s)}
            <div class="form-grid"><div class="field"><label class="label" for="f_script_file">${tx('scr.file', { mb: SCRIPT_MAX_MB })}</label>
              <input type="file" id="f_script_file" name="file" accept=".sql,.txt,text/plain,application/sql" required></div></div>
            <div class="buttons"><button class="btn">${icon('upload')} ${tx('scr.upload')}</button></div></form>`)}
        <div class="u-spacer"></div>
        ${region(tx('scr.recent_runs'), historyTable(tx, runs, true))}`,
    );
  });

  // ------------------------------------------------------------ editor
  const editor = async (req: Req, reply: FastifyReply, s: Session, row: any, error?: string) => {
    const isNew = !row.id;
    const action = isNew ? `${BASE}/sql/scripts` : `${BASE}/sql/scripts/${row.id}`;
    const runs = isNew ? [] : (await owner.query('select * from meta.sql_script_run where script_id = $1 order by id desc limit 20', [row.id])).rows;
    const statements = row.content ? splitScript(row.content).length : 0;
    const tx = tr(s);
    const form = html`<form method="post" action="${action}">${csrf(s)}
        ${error ? html`<div class="alert alert-error" role="alert">${error}</div>` : ''}
        <div class="form-grid">
          <div class="field"><label class="label" for="f_name">${tx('scr.name')}</label><input id="f_name" name="name" value="${row.name ?? ''}" required maxlength="200"></div>
          <div class="field"><label class="label" for="f_description">${tx('scr.description')}</label><input id="f_description" name="description" value="${row.description ?? ''}"></div>
        </div>
        <div class="field"><label class="label" for="f_content">${tx('scr.col.script')}</label>
          <textarea id="f_content" name="content" class="code sql-editor" rows="18" spellcheck="false" data-code="plpgsql">${row.content ?? ''}</textarea>
          <small class="help">${tx('scr.content_help')}${statements ? ` ${tx('scr.statements', { n: statements })}` : ''}</small></div>
        ${runOptions(req.body ?? {}, tx)}
        <div class="buttons"><button class="btn" name="action" value="save">${icon('check')} ${tx('scr.save')}</button>
          <button class="btn btn-hot" name="action" value="run">${icon('play')} ${tx('scr.save_run')}</button></div>
      </form>`;
    const extras = isNew
      ? ''
      : html`<div class="buttons u-mt1"><a class="btn" href="${BASE}/sql/scripts/${row.id}/download">${icon('download')} ${tx('scr.download')}</a></div>
        <form method="post" action="${BASE}/sql/scripts/${row.id}/delete" class="danger-zone">${csrf(s)}<button class="btn btn-danger" data-confirm="${tx('scr.delete_confirm')}">${tx('scr.delete')}</button></form>`;
    return page(
      s,
      reply,
      isNew ? tx('scr.new') : row.name,
      [[tx('sql.tool.scripts'), `${BASE}/sql/scripts`], [isNew ? tx('scr.new') : row.name]],
      html`${region(isNew ? tx('scr.new') : tx('scr.script_title', { name: row.name }), html`${form}${extras}`)}
        ${isNew ? '' : html`<div class="u-spacer"></div>${region(tx('scr.runs'), historyTable(tx, runs, false))}`}`,
    );
  };

  app.get(`${BASE}/sql/scripts/new`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    return editor(req, reply, s, { name: '', content: '-- statements end with a semicolon\nselect current_user;\n' });
  });

  app.get(`${BASE}/sql/scripts/:id`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const row = /^\d+$/.test(req.params.id) ? await owner.one('select * from meta.sql_script where id = $1 and workspace_id = $2', [req.params.id, currentWorkspace(s)]) : undefined;
    if (!row) return reply.code(404).send('Not found');
    return editor(req, reply, s, row);
  });

  /** Save (create or update); with action=run, run it and show the results. */
  const save = async (req: Req, reply: FastifyReply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = req.body ?? {};
    const id = req.params.id;
    if (id && !/^\d+$/.test(id)) return reply.code(404).send('Not found');
    const name = (b.name ?? '').trim();
    const content = (b.content ?? '').replace(/\r\n/g, '\n');
    const row = { id: id ? Number(id) : undefined, name, description: b.description ?? '', content };
    if (!name || name.length > 200) {
      reply.code(422);
      return editor(req, reply, s, row, tr(s)('scr.err.name'));
    }
    if (Buffer.byteLength(content) > SCRIPT_MAX_MB * 1024 * 1024) {
      reply.code(422);
      return editor(req, reply, s, row, tr(s)('scr.err.size', { mb: SCRIPT_MAX_MB }));
    }
    let scriptId: number;
    try {
      if (id) {
        const r = await owner.one(
          'update meta.sql_script set name = $2, description = nullif($3, \'\'), content = $4, updated_by = $5, updated_at = now() where id = $1 and workspace_id = $6 returning id',
          [id, name, b.description ?? '', content, s.username, currentWorkspace(s)],
        );
        if (!r) return reply.code(404).send('Not found');
        scriptId = r.id;
      } else {
        const r = await owner.one(
          `insert into meta.sql_script (name, description, content, created_by, updated_by, workspace_id) values ($1, nullif($2, ''), $3, $4, $4, $5) returning id`,
          [name, b.description ?? '', content, s.username, currentWorkspace(s)],
        );
        scriptId = r!.id;
      }
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        reply.code(422);
        return editor(req, reply, s, row, tr(s)('scr.err.exists', { name }));
      }
      throw e;
    }
    if (b.action === 'run') {
      const { id: runId } = await runAndRecord(s, clientIp(req), {
        scriptId,
        name,
        content,
        stopOnError: b.on_error !== 'continue',
        transaction: b.transaction === 'true',
      });
      return back(reply, s, `${BASE}/sql/scripts/runs/${runId}`);
    }
    flash(s, tr(s)('scr.saved', { name }));
    return back(reply, s, `${BASE}/sql/scripts/${scriptId}`);
  };
  app.post(`${BASE}/sql/scripts`, save);
  app.post(`${BASE}/sql/scripts/:id`, save);

  app.post(`${BASE}/sql/scripts/:id/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    if (!/^\d+$/.test(req.params.id)) return reply.code(404).send('Not found');
    const r = await owner.tx(async (c) => {
      const own = (await c.query('select 1 from meta.sql_script where id = $1 and workspace_id = $2', [req.params.id, currentWorkspace(s)])).rowCount;
      if (!own) return undefined;
      await c.query('delete from meta.sql_script_run where script_id = $1', [req.params.id]);
      return (await c.query('delete from meta.sql_script where id = $1 returning name', [req.params.id])).rows[0];
    });
    if (r) flash(s, tr(s)('scr.deleted', { name: r.name }));
    return back(reply, s, `${BASE}/sql/scripts`);
  });

  app.get(`${BASE}/sql/scripts/:id/download`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const row = /^\d+$/.test(req.params.id) ? await owner.one('select name, content from meta.sql_script where id = $1 and workspace_id = $2', [req.params.id, currentWorkspace(s)]) : undefined;
    if (!row) return reply.code(404).send('Not found');
    return reply
      .header('content-type', 'application/sql; charset=utf-8')
      .header('content-disposition', `attachment; filename="${scriptFileName(row.name)}"`)
      .send(row.content);
  });

  app.post(`${BASE}/sql/scripts/upload`, async (req: Req, reply) => {
    let file;
    if (req.isMultipart()) {
      const parsed = await readMultipart(req, SCRIPT_MAX_MB);
      req.body = parsed.body as Body;
      file = parsed.files.get('file');
    }
    const s = await developer(req, reply);
    if (!s) return;
    const fail = (message: string) => {
      flash(s, message, 'error');
      return back(reply, s, `${BASE}/sql/scripts`);
    };
    const tx = tr(s);
    if (!file) return fail(tx('scr.err.choose'));
    if (file.truncated) return fail(tx('scr.err.file_size', { mb: SCRIPT_MAX_MB }));
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(file.data).replace(/^﻿/, '').replace(/\r\n/g, '\n');
    } catch {
      return fail(tx('scr.err.utf8'));
    }
    if (content.includes('\0')) return fail(tx('scr.err.text'));
    const base = file.filename.replace(/^.*[\\/]/, '').replace(/\.sql$/i, '').slice(0, 180) || 'script';
    let name = base;
    for (let n = 2; await owner.one('select 1 from meta.sql_script where name = $1 and workspace_id = $2', [name, currentWorkspace(s)]); n++) name = `${base} (${n})`;
    const r = await owner.one(`insert into meta.sql_script (name, content, created_by, updated_by, workspace_id) values ($1, $2, $3, $3, $4) returning id`, [name, content, s.username, currentWorkspace(s)]);
    flash(s, tx('scr.uploaded', { name }));
    return back(reply, s, `${BASE}/sql/scripts/${r!.id}`);
  });

  // ------------------------------------------------------------ results
  app.get(`${BASE}/sql/scripts/runs/:run`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const run = /^\d+$/.test(req.params.run) ? await owner.one('select * from meta.sql_script_run where id = $1 and workspace_id = $2', [req.params.run, currentWorkspace(s)]) : undefined;
    if (!run) return reply.code(404).send('Not found');
    const exists = run.script_id ? await owner.one('select id from meta.sql_script where id = $1', [run.script_id]) : undefined;
    const tx = tr(s);
    const options = `${run.stop_on_error ? tx('scr.opt.stop') : tx('scr.opt.continue')}${run.transactional ? `, ${tx('scr.opt.one_tx')}` : ''}`;
    return page(
      s,
      reply,
      tx('scr.results_title'),
      [[tx('sql.tool.scripts'), `${BASE}/sql/scripts`], ...(exists ? [[run.script_name, `${BASE}/sql/scripts/${run.script_id}`] as [string, string]] : []), [tx('scr.results')]],
      region(
        tx('scr.results_of', { name: run.script_name }),
        html`<p class="muted">${tx('scr.run_by', { user: run.run_by, time: when(run.started_at), ms: run.elapsed_ms, options })}</p>
          ${runSummary(tx, run)}
          ${resultsHtml(run.results, tx)}
          ${exists ? html`<div class="buttons u-mt1"><a class="btn" href="${BASE}/sql/scripts/${run.script_id}">${icon('edit')} ${tx('scr.edit')}</a></div>` : ''}`,
      ),
    );
  });
}
