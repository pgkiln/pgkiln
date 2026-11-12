import type { FastifyInstance, FastifyReply } from 'fastify';
import pg from 'pg';
import { filesToZip } from '../appfiles.ts';
import { flywayFile, flywayName, flywayUndoFile, flywayUndoName, liquibaseChangelog, plainScript, recordChanges, type ChangeSet } from '../changelog.ts';
import { owner } from '../db.ts';
import { changeScript, readSchema, userSchemas } from '../ddl.ts';
import { html, raw } from '../html.ts';
import { icon } from '../icons.ts';
import { splitStatements } from '../binds.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import { back, BASE, csrf, developer, flash, region, send, shell, workshopTabs, type Req } from './ui.ts';
import { currentWorkspace, workshopDb } from './workspaces.ts';
import { tr, type BuilderKey } from './i18n.ts';

// (sprint 106, Database Actions DA-17; migration 118) SQL Workshop › Change Log: the change sets recorded from the
// worksheet, Table Properties and Schema Comparison (src/changelog.ts), per schema of the developer's workspace:
// number, name, author, time, where from, the SQL; whether each is in the latest export of an application of the
// workspace (made before it) and whether it was written to a migration file. Downloads (POST, they mark the change
// sets exported): plain SQL, a Liquibase formatted SQL changelog, Flyway files (V0001__add_bonus.sql; several in a
// zip). Schema Comparison's "Apply and record" runs its change script here, in one transaction, and records it.

export const CHANGES = `${BASE}/sql/changes`;
const NAME = /^[a-z0-9][a-z0-9_]{0,59}$/;
const FORMATS = ['sql', 'liquibase', 'flyway'] as const;
type Format = (typeof FORMATS)[number];

const asFormat = (v: unknown): Format => (FORMATS.includes(v as Format) ? (v as Format) : 'sql');

/** The workspace's change sets of a schema (or one by id). */
async function changeSets(s: Session, where: { schema?: string; id?: number }): Promise<ChangeSet[]> {
  const params: unknown[] = [currentWorkspace(s)];
  let cond = '';
  if (where.schema !== undefined) cond += ` and schema_name = $${params.push(where.schema)}`;
  if (where.id !== undefined) cond += ` and id = $${params.push(where.id)}`;
  return (await owner.query<ChangeSet>(
    `select id::int, workspace_id, schema_name, seq, name, author, source, sql, object_name, created_at::text, exported_at::text, rollback_sql
       from meta.change_set where workspace_id = $1${cond} order by schema_name, seq`, params)).rows;
}

/** Schemas with change sets in the workspace, with their counts. */
async function schemasWithChanges(s: Session) {
  return (await owner.query<{ schema_name: string; n: number; last: string }>(
    `select schema_name, count(*)::int as n, max(created_at)::text as last from meta.change_set where workspace_id = $1 group by 1 order by 1`,
    [currentWorkspace(s)])).rows;
}

/** The latest builder export of each application of the workspace (activity log 'app_export'). */
async function latestExports(s: Session) {
  return (await owner.query<{ id: number; name: string; alias: string; at: string }>(
    `select a.id, a.name, a.alias, max(l.at)::text as at from meta.app a join meta.activity_log l on l.app_id = a.id and l.event = 'app_export'
      where meta.app_workspace(a.id) = $1 group by a.id order by max(l.at) desc`, [currentWorkspace(s)])).rows;
}

const when = (t: string | null) => (t ? t.slice(0, 16).replace('T', ' ') : '');
const SOURCE_LABELS: Record<string, BuilderKey> = { worksheet: 'sql.tool.worksheet', table: 'cl.from.table', compare: 'sql.tool.compare' };

async function listPage(s: Session, q: Record<string, unknown>) {
  const tx = tr(s);
  const schemas = await schemasWithChanges(s);
  const schema = schemas.some((x) => x.schema_name === q.schema) ? String(q.schema) : (schemas[0]?.schema_name ?? '');
  const exportsList = await latestExports(s);
  const exp = exportsList.find((e) => String(e.id) === String(q.app ?? '')) ?? exportsList[0];
  const list = schema ? await changeSets(s, { schema }) : [];
  const inExport = (c: ChangeSet) => !!exp && c.created_at <= exp.at;
  const pending = list.filter((c) => !c.exported_at).length;
  const nav = schemas.length
    ? html`<nav class="settings-tabs" aria-label="${tx('cl.schemas')}">${schemas.map((x) => html`<a href="${CHANGES}?${new URLSearchParams({ schema: x.schema_name, ...(exp ? { app: String(exp.id) } : {}) })}"${x.schema_name === schema ? raw(' aria-current="page"') : ''}>${x.schema_name} <span class="muted small">${x.n}</span></a>`)}</nav>`
    : '';
  const table = list.length
    ? html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>#</th><th>${tx('cl.col.change_set')}</th><th>${tx('cl.col.author')}</th><th>${tx('cl.col.recorded')}</th><th>${tx('cl.col.from')}</th><th>${tx('cl.col.latest_export')}</th><th>${tx('cl.col.migration_file')}</th></tr></thead><tbody>
      ${list.map((c) => html`<tr>
        <td data-label="#">${c.seq}</td>
        <td data-label="${tx('cl.col.change_set')}" class="wrap-anywhere"><details><summary><code>${flywayName(c)}</code>${c.object_name ? html` <span class="muted small">${c.object_name}</span>` : ''}</summary>
          <pre class="source wrap-pre" data-code-view="sql" tabindex="0" aria-label="SQL">${c.sql}</pre>
          <form method="post" action="${CHANGES}/${c.id}" class="search u-mwnone">${csrf(s)}
            <div class="field"><label class="label" for="f_name_${c.id}">${tx('scr.name')}</label><input id="f_name_${c.id}" name="name" value="${c.name}" pattern="[a-z0-9][a-z0-9_]{0,59}" required></div>
            <button class="btn btn-sm u-selfend">${tx('cl.rename')}</button></form>
          <form method="post" action="${CHANGES}/${c.id}/rollback" class="cl-rollback">${csrf(s)}
            <div class="field"><label class="label" for="f_rb_${c.id}">${tx('cl.rollback')}</label>
              <textarea id="f_rb_${c.id}" name="rollback" rows="${Math.min(8, Math.max(2, (c.rollback_sql ?? '').split('\n').length))}" maxlength="1000000" spellcheck="false" class="code">${c.rollback_sql ?? ''}</textarea>
              <small class="help">${tx('cl.rollback_help', { file: flywayUndoName(c) })}</small></div>
            <button class="btn btn-sm">${tx('cl.rollback_save')}</button></form>
          <div class="buttons">
            <form method="post" action="${CHANGES}/${c.id}/download" class="u-inline">${csrf(s)}<button class="btn btn-sm">${icon('download')} ${flywayName(c)}</button>${c.rollback_sql ? html` <button class="btn btn-sm" name="undo" value="1">${icon('download')} ${flywayUndoName(c)}</button>` : ''}</form>
            <form method="post" action="${CHANGES}/${c.id}/delete" class="u-inline">${csrf(s)}<button class="btn btn-sm btn-danger" data-confirm="${tx('cl.delete_confirm', { n: c.seq })}">${icon('trash')} ${tx('scr.delete')}</button></form>
          </div></details></td>
        <td data-label="${tx('cl.col.author')}">${c.author}</td>
        <td data-label="${tx('cl.col.recorded')}">${when(c.created_at)}</td>
        <td data-label="${tx('cl.col.from')}">${SOURCE_LABELS[c.source] ? tx(SOURCE_LABELS[c.source]) : c.source}</td>
        <td data-label="${tx('cl.col.latest_export')}">${exp ? (inExport(c) ? html`<span class="tag">✓ ${tx('cl.in_it')}</span>` : html`<span class="tag tag-warn">${tx('cl.after_it')}</span>`) : html`<span class="muted">—</span>`}</td>
        <td data-label="${tx('cl.col.migration_file')}">${c.exported_at ? tx('cl.written', { time: when(c.exported_at) }) : html`<span class="muted">${tx('cl.not_yet')}</span>`}</td></tr>`)}
      </tbody></table></div>`
    : html`<p class="muted">${tx('cl.none_yet')}</p>`;
  const exportPick = exportsList.length
    ? html`<form method="get" action="${CHANGES}" class="search u-mwnone u-mb1"><input type="hidden" name="schema" value="${schema}">
        <div class="field"><label class="label" for="f_app">${tx('cl.compare_with')}</label><select id="f_app" name="app">${exportsList.map((e) =>
          html`<option value="${e.id}"${e === exp ? raw(' selected') : ''}>${e.name} (${when(e.at)})</option>`)}</select></div>
        <button class="btn u-selfend">${tx('cl.show')}</button></form>
        <p class="muted small u-mt0">${tx.rich('cl.export_note', { after: html`<em>${tx('cl.after_it_title')}</em>` })}</p>`
    : html`<p class="muted small">${tx('cl.no_exports')}</p>`;
  const downloads = list.length
    ? html`<form method="post" action="${CHANGES}/download" class="u-mt1">${csrf(s)}<input type="hidden" name="schema" value="${schema}">
        <div class="form-grid">
          <div class="field"><label class="label" for="f_format">${tx('cl.format')}</label><select id="f_format" name="format">
            <option value="flyway">${tx('cl.format.flyway')}</option>
            <option value="liquibase">${tx('cl.format.liquibase')}</option>
            <option value="sql">${tx('cl.format.sql')}</option></select></div>
          <div class="field"><label class="label" for="f_which">${tx('cl.change_sets')}</label><select id="f_which" name="which">
            <option value="pending">${tx('cl.which.pending', { n: pending })}</option>
            <option value="all">${tx('cl.which.all', { schema, n: list.length })}</option>
            ${exp ? html`<option value="after_export">${tx('cl.which.after', { app: exp.name, n: list.filter((c) => !inExport(c)).length })}</option>` : ''}</select></div>
        </div>
        ${exp ? html`<input type="hidden" name="app" value="${exp.id}">` : ''}
        <div class="buttons"><button class="btn btn-hot">${icon('download')} ${tx('cl.download')}</button></div></form>`
    : '';
  const main = html`<h1 class="u-mb1">${tx('rail.sql_workshop')}</h1>${workshopTabs('changes', s)}
    <p class="muted">${tx('cl.intro')}</p>
    ${nav}
    ${schema ? region(tx('cl.change_sets_of', { schema }), html`${exportPick}${table}${downloads}`) : region(tx('cl.change_sets'), table)}`;
  return shell(s, tx('sql.tool.changes'), [[tx('rail.sql_workshop'), `${BASE}/sql`], [tx('sql.tool.changes')]], main, 'sql');
}

async function oneOr404(req: Req, reply: FastifyReply, s: Session) {
  const id = Number(req.params.id);
  const c = Number.isInteger(id) && id > 0 && id < 2 ** 53 ? (await changeSets(s, { id }))[0] : undefined;
  if (!c) reply.code(404).send('Not found');
  return c;
}

const markExported = (ids: number[]) => owner.query('update meta.change_set set exported_at = now() where id = any($1::bigint[])', [ids]);

/** The download of change sets in a format: one file, or a zip of Flyway files. */
function fileOf(list: ChangeSet[], format: Format, schema: string): { name: string; type: string; body: string | Buffer } {
  if (format === 'flyway') {
    // (sprint 175) a change set with a rollback also gives its undo migration (U0001__name.sql)
    const files = new Map<string, Buffer>();
    for (const c of list) {
      files.set(flywayName(c), Buffer.from(flywayFile(c)));
      const undo = flywayUndoFile(c);
      if (undo) files.set(flywayUndoName(c), Buffer.from(undo));
    }
    if (files.size === 1) return { name: flywayName(list[0]), type: 'application/sql; charset=utf-8', body: flywayFile(list[0]) };
    return { name: `${schema}-migrations.zip`, type: 'application/zip', body: Buffer.from(filesToZip(files, `${schema}-migrations`)) };
  }
  if (format === 'liquibase') return { name: `${schema}.changelog.sql`, type: 'application/sql; charset=utf-8', body: liquibaseChangelog(list) };
  return { name: `${schema}-changes.sql`, type: 'application/sql; charset=utf-8', body: plainScript(list) };
}
const safeName = (n: string) => n.replace(/[^A-Za-z0-9._-]/g, '_');

export async function changeLogRoutes(app: FastifyInstance) {
  app.get(CHANGES, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    return send(reply, s, await listPage(s, req.query ?? {}));
  });

  app.post(`${CHANGES}/download`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = req.body ?? {};
    const schema = String(b.schema ?? '');
    let list = await changeSets(s, { schema });
    if (!list.length) return reply.code(404).send('Not found');
    if (b.which === 'pending') list = list.filter((c) => !c.exported_at);
    else if (b.which === 'after_export') {
      const exp = (await latestExports(s)).find((e) => String(e.id) === String(b.app ?? ''));
      if (exp) list = list.filter((c) => c.created_at > exp.at);
    }
    if (!list.length) {
      flash(s, tr(s)('cl.nothing_to_write'), 'error');
      return back(reply, s, `${CHANGES}?${new URLSearchParams({ schema })}`);
    }
    const format = asFormat(b.format);
    const f = fileOf(list, format, schema);
    await markExported(list.map((c) => c.id));
    await logActivity({ username: s.username, event: 'change_log_export', ip: clientIp(req), detail: `${schema}: ${list.length} change set(s) as ${format}` });
    return reply.header('content-disposition', `attachment; filename="${safeName(f.name)}"`).type(f.type).send(f.body);
  });

  app.post(`${CHANGES}/:id/download`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const c = await oneOr404(req, reply, s);
    if (!c) return;
    const undo = req.body?.undo === '1' ? flywayUndoFile(c) : null;
    if (undo) return reply.header('content-disposition', `attachment; filename="${safeName(flywayUndoName(c))}"`).type('application/sql; charset=utf-8').send(undo);
    await markExported([c.id]);
    return reply.header('content-disposition', `attachment; filename="${safeName(flywayName(c))}"`).type('application/sql; charset=utf-8').send(flywayFile(c));
  });

  // (sprint 175, DA-17) the rollback block of a change set: written, changed or removed (empty). It is text for the
  // migration files; pgkiln never runs it.
  app.post(`${CHANGES}/:id/rollback`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const c = await oneOr404(req, reply, s);
    if (!c) return;
    const text = String(req.body?.rollback ?? '').replace(/\r\n/g, '\n').trim();
    if (text.length > 1_000_000) flash(s, tr(s)('cl.rollback_too_long'), 'error');
    else {
      await owner.query('update meta.change_set set rollback_sql = $2 where id = $1', [c.id, text || null]);
      await logActivity({ username: s.username, event: 'change_log_rollback', ip: clientIp(req), detail: `${c.schema_name} #${c.seq} ${c.name}: ${text ? 'rollback written' : 'rollback removed'}` });
      flash(s, tr(s)(text ? 'cl.rollback_saved' : 'cl.rollback_removed', { n: c.seq }));
    }
    return back(reply, s, `${CHANGES}?${new URLSearchParams({ schema: c.schema_name })}`);
  });

  app.post(`${CHANGES}/:id`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const c = await oneOr404(req, reply, s);
    if (!c) return;
    const name = String(req.body?.name ?? '').trim().toLowerCase();
    if (!NAME.test(name)) flash(s, tr(s)('cl.bad_name'), 'error');
    else {
      await owner.query('update meta.change_set set name = $2 where id = $1', [c.id, name]);
      flash(s, tr(s)('cl.renamed', { n: c.seq, file: flywayName({ seq: c.seq, name }) }));
    }
    return back(reply, s, `${CHANGES}?${new URLSearchParams({ schema: c.schema_name })}`);
  });

  app.post(`${CHANGES}/:id/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const c = await oneOr404(req, reply, s);
    if (!c) return;
    await owner.query('delete from meta.change_set where id = $1', [c.id]);
    await logActivity({ username: s.username, event: 'change_log_delete', ip: clientIp(req), detail: `${c.schema_name} #${c.seq} ${c.name}` });
    flash(s, tr(s)('cl.deleted', { n: c.seq }));
    return back(reply, s, `${CHANGES}?${new URLSearchParams({ schema: c.schema_name })}`);
  });

  // Schema Comparison › Apply and record: the change script that makes the target like the source, run in one
  // transaction on the SQL Workshop's connection, recorded as a change set of the target
  app.post(`${BASE}/sql/compare/apply`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const db = await workshopDb(s);
    const schemas = await userSchemas(db, { usable: db !== owner });
    const source = String(req.body?.source ?? '');
    const target = String(req.body?.target ?? '');
    if (!schemas.includes(source) || !schemas.includes(target) || source === target) return reply.code(404).send('Not found');
    const [a, b] = await Promise.all([readSchema(db.pool, source), readSchema(db.pool, target)]);
    const script = changeScript(source, target, a, b);
    const statements = splitStatements(script);
    const back2 = `${BASE}/sql/compare?${new URLSearchParams({ source, target })}`;
    if (!statements.length) {
      flash(s, tr(s)('cmp.nothing', { source, target }));
      return back(reply, s, back2);
    }
    const c = await db.pool.connect();
    let failed = '';
    try {
      await c.query('begin');
      await c.query(`select set_config('search_path', $1, true)`, [`${pg.escapeIdentifier(target)}, public`]);
      for (const x of statements) await c.query(x);
      await c.query('commit');
    } catch (e) {
      failed = (e as Error).message;
      await c.query('rollback').catch(() => {});
    } finally {
      c.release(true);
    }
    await logActivity({ username: s.username, event: 'sql_command', ip: clientIp(req), detail: `compare apply ${source} → ${target}: ${failed ? `failed: ${failed}` : `${statements.length} statement(s)`}`.slice(0, 2000) });
    if (failed) {
      flash(s, tr(s)('cmp.failed', { error: failed }), 'error');
      return back(reply, s, back2);
    }
    await recordChanges({ workspaceId: currentWorkspace(s), author: s.username ?? '?', source: 'compare', statements, defaultSchema: target, name: `like_${source}`.toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 60) });
    flash(s, tr(s)('cmp.applied', { source, target, n: statements.length }));
    return back(reply, s, `${CHANGES}?${new URLSearchParams({ schema: target })}`);
  });
}
