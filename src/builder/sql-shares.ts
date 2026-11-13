import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import pg from 'pg';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { isNumeric } from '../runtime/report.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import { cellText, GRID_VALUE } from '../sqlworksheet.ts';
import { publicUrl } from '../sso.ts';
import { unloadStatement } from '../unload.ts';
import { back, BASE, csrf, developer, flash, region, send, shell, workshopTabs, type Req } from './ui.ts';
import { isAdmin } from './locks.ts';
import { currentWorkspace, sessionSchema, usableSchemas, workshopDb } from './workspaces.ts';
import { tr } from './i18n.ts';

// (sprint 176, Database Actions DA-3: share a query result) The worksheet's Query Result has Share: the query (one
// SELECT, as Unload Data takes it) is kept behind a random token (meta.sql_share, migration 158) and the link
// /builder/sql/shared/<token> shows its result to a developer of the same workspace. The link holds the SELECT,
// never its rows: it runs again, read-only and with a statement timeout, as the connection of the developer who
// opens it, so a link never shows more than its reader may select. A link ends on its expiry date, or when its
// maker or an administrator stops sharing.

export const SHARE_DAYS = [1, 7, 30, 90] as const;
const SHARE_ROWS = 500;
/** Links a workspace can have at one time: the oldest expired ones are removed first, then sharing is refused. */
export const MAX_SHARES = 500;

interface Share { id: number; workspace_id: number; token: string; title: string; sql: string; schema_name: string | null; created_by: string; created_at: string; expires_at: string }

export const shareToken = () => randomBytes(24).toString('base64url');
export const shareUrl = (token: string) => `${publicUrl()}${BASE}/sql/shared/${token}`;
/** A link's title when none is given: the query on one line. */
export const shareTitle = (sql: string) => { const x = sql.replace(/\s+/g, ' ').trim(); return x.length > 80 ? `${x.slice(0, 79)}…` : x; };
const days = (v: unknown) => (SHARE_DAYS as readonly number[]).includes(Number(v)) ? Number(v) : 7;
const stamp = (d: string) => new Date(d).toISOString().slice(0, 16).replace('T', ' ');

/** The shared SELECT as the reader's connection: read-only, 30 seconds, the first rows. */
async function runShare(s: Session, sh: Share) {
  const db = await workshopDb(s);
  const schema = sh.schema_name && (await usableSchemas(db)).includes(sh.schema_name) ? sh.schema_name : await sessionSchema(s, db);
  const c = await db.pool.connect();
  try {
    await c.query('begin transaction read only');
    await c.query(`select set_config('statement_timeout', '30s', true)`);
    if (schema) await c.query(`select set_config('search_path', $1, true)`, [`${pg.escapeIdentifier(schema)}, public`]);
    const res = await c.query({ text: `select * from (${unloadStatement(sh.sql)}\n) shared_rows limit ${SHARE_ROWS + 1}`, rowMode: 'array' });
    const rows = (res.rows as unknown[][]).slice(0, SHARE_ROWS).map((row) => row.map((v) => cellText(v, GRID_VALUE)));
    return { columns: res.fields.map((f) => f.name), numeric: res.fields.map((f) => isNumeric(f.dataTypeID)), rows, more: res.rows.length > SHARE_ROWS };
  } finally {
    await c.query('rollback').catch(() => {});
    c.release(true);
  }
}

/** A link of the session's workspace that has not ended, by its token. */
const findShare = async (s: Session, token: unknown) =>
  /^[A-Za-z0-9_-]{32}$/.test(String(token))
    ? owner.one<Share>('select * from meta.sql_share where token = $1 and workspace_id = $2 and expires_at > now()', [token, currentWorkspace(s)])
    : undefined;

export async function sqlShareRoutes(app: FastifyInstance) {
  // the workspace's links
  app.get(`${BASE}/sql/shared`, async (req: Req, reply: FastifyReply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const tx = tr(s);
    const admin = await isAdmin(s.username);
    const shares = (await owner.query<Share>('select * from meta.sql_share where workspace_id = $1 and expires_at > now() order by created_at desc', [currentWorkspace(s)])).rows;
    const main = html`<h1 class="u-mb1">${tx('sh.title')}</h1>${workshopTabs('sql', s)}
      <p class="muted">${tx.rich('sh.intro', { worksheet: html`<a href="${BASE}/sql/worksheet">${tx('sql.tool.worksheet')}</a>` })}</p>
      ${region(tx('sh.links'), shares.length
        ? html`<div class="table-wrap rep-fit"><table class="report"><thead><tr><th>${tx('sh.query')}</th><th>${tx('sh.shared_by')}</th><th class="col-low">${tx('sh.created')}</th><th>${tx('sh.ends')}</th><th><span class="sr-only">${tx('sh.actions')}</span></th></tr></thead><tbody>
          ${shares.map((sh) => html`<tr><td><a href="${BASE}/sql/shared/${sh.token}">${sh.title}</a></td><td>${sh.created_by}</td><td class="col-low">${stamp(sh.created_at)}</td><td>${stamp(sh.expires_at)}</td>
            <td>${admin || sh.created_by === s.username ? html`<form method="post" action="${BASE}/sql/shared/${sh.token}" class="inline-form">${csrf(s)}<button class="btn btn-sm" name="action" value="stop">${tx('sh.stop')}</button></form>` : ''}</td></tr>`)}</tbody></table></div>`
        : html`<p class="muted">${tx('sh.none_yet')}</p>`)}`;
    return send(reply, s, shell(s, tx('sh.title'), [[tx('rail.sql_workshop'), `${BASE}/sql`], [tx('sh.title')]], main, 'sql'));
  });

  // share the worksheet's query: a new link
  app.post(`${BASE}/sql/shared`, async (req: Req, reply: FastifyReply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const tx = tr(s);
    const ws = currentWorkspace(s);
    let sql = '';
    try {
      sql = unloadStatement(String(req.body?.query ?? ''));
    } catch {
      sql = '';
    }
    if (!sql || sql.length > 20000) {
      flash(s, tx('sh.err.select'), 'error');
      return back(reply, s, `${BASE}/sql/worksheet`);
    }
    await owner.query('delete from meta.sql_share where workspace_id = $1 and expires_at <= now()', [ws]);
    if ((await owner.one<{ n: number }>('select count(*)::int as n from meta.sql_share where workspace_id = $1', [ws]))!.n >= MAX_SHARES) {
      flash(s, tx('sh.err.too_many', { n: MAX_SHARES }), 'error');
      return back(reply, s, `${BASE}/sql/shared`);
    }
    const db = await workshopDb(s);
    const token = shareToken();
    const title = String(req.body?.title ?? '').trim().slice(0, 120) || shareTitle(sql);
    await owner.query(
      `insert into meta.sql_share (workspace_id, token, title, sql, schema_name, created_by, expires_at) values ($1, $2, $3, $4, $5, $6, now() + make_interval(days => $7))`,
      [ws, token, title, sql, await sessionSchema(s, db), s.username, days(req.body?.days)]);
    await logActivity({ username: s.username, event: 'sql_share', ip: clientIp(req), detail: `shared: ${title}` });
    flash(s, tx('sh.created_flash'));
    return back(reply, s, `${BASE}/sql/shared/${token}`);
  });

  // a link: the result, as the reader may see it
  app.get(`${BASE}/sql/shared/:token`, async (req: Req, reply: FastifyReply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const sh = await findShare(s, req.params.token);
    if (!sh) return reply.code(404).send('Not found');
    const tx = tr(s);
    const mine = sh.created_by === s.username || (await isAdmin(s.username));
    let result: Raw;
    try {
      const r = await runShare(s, sh);
      result = html`<p class="muted small">${r.rows.length === 1 ? tx('ws.rows_one', { n: 1 }) : tx('ws.rows', { n: r.rows.length })}${r.more ? html` · ${tx('sh.first_rows', { n: SHARE_ROWS })}` : ''}</p>
        <div class="table-wrap sh-grid"><table class="report"><thead><tr><th scope="col" class="ws-rownum">#</th>${r.columns.map((c, k) => html`<th scope="col"${r.numeric[k] ? raw(' class="num"') : ''}>${c}</th>`)}</tr></thead>
        <tbody>${r.rows.map((row, k) => html`<tr><td class="ws-rownum">${k + 1}</td>${row.map((v, i) => html`<td${r.numeric[i] ? raw(' class="num"') : ''}>${v === null ? html`<span class="null">(null)</span>` : v}</td>`)}</tr>`)}</tbody></table></div>`;
    } catch (e) {
      result = html`<p class="alert alert-error">${(e as Error).message}</p>`;
    }
    const main = html`<h1 class="u-mb1">${sh.title}</h1>${workshopTabs('sql', s)}
      <p class="muted">${tx('sh.by_line', { user: sh.created_by, created: stamp(sh.created_at), ends: stamp(sh.expires_at) })} ${tx('sh.runs_as_you')}</p>
      ${result}
      <details class="u-mt1"><summary>${tx('ch.query')}</summary><pre class="source" data-code-view="sql" tabindex="0" aria-label="${tx('ch.query')}">${sh.sql}</pre></details>
      <form method="post" action="${BASE}/sql/shared/${sh.token}" class="sh-edit u-mt1">${csrf(s)}
        <div class="field"><label class="label" for="sh-link">${tx('sh.link')}</label><input id="sh-link" class="sh-link" readonly value="${shareUrl(sh.token)}">
          <small class="help">${tx('sh.link_help')}</small></div>
        ${mine ? html`<div class="field"><label class="label" for="sh-title">${tx('sh.name')}</label><input id="sh-title" name="title" value="${sh.title}" maxlength="120" required></div>
          <div class="field"><label class="label" for="sh-days">${tx('sh.extend')}</label><select id="sh-days" name="days"><option value="">${tx('sh.keep_end')}</option>${SHARE_DAYS.map((d) => html`<option value="${d}">${d === 1 ? tx('sh.day_one') : tx('sh.days', { n: d })}</option>`)}</select></div>` : ''}
        <div class="buttons">${mine ? html`<button class="btn btn-hot" name="action" value="save">${icon('save')} ${tx('scr.save')}</button>` : ''}
          <button class="btn" name="action" value="worksheet">${icon('code')} ${tx('ch.open_worksheet')}</button>
          ${mine ? html`<button class="btn btn-danger" name="action" value="stop" data-confirm="${tx('sh.stop_confirm')}">${icon('trash')} ${tx('sh.stop')}</button>` : ''}
          <a class="btn" href="${BASE}/sql/shared">${tx('sh.all_links')}</a></div>
      </form>`;
    reply.header('Cache-Control', 'private, no-store'); // (Referrer-Policy is same-origin on every page: the token stays here)
    return send(reply, s, shell(s, sh.title, [[tx('rail.sql_workshop'), `${BASE}/sql`], [tx('sh.title'), `${BASE}/sql/shared`], [sh.title]], main, 'sql'));
  });

  // a link's name and end, Open in the worksheet, Stop sharing
  app.post(`${BASE}/sql/shared/:token`, async (req: Req, reply: FastifyReply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const sh = await findShare(s, req.params.token);
    if (!sh) return reply.code(404).send('Not found');
    const tx = tr(s);
    const action = req.body?.action;
    if (action === 'worksheet') {
      s.state.__SQLDRAFT = sh.sql;
      return back(reply, s, `${BASE}/sql/worksheet`);
    }
    if (sh.created_by !== s.username && !(await isAdmin(s.username))) return reply.code(403).send(tx('sh.err.not_yours'));
    if (action === 'stop') {
      await owner.query('delete from meta.sql_share where id = $1', [sh.id]);
      await logActivity({ username: s.username, event: 'sql_share', ip: clientIp(req), detail: `stopped sharing: ${sh.title}` });
      flash(s, tx('sh.stopped'));
      return back(reply, s, `${BASE}/sql/shared`);
    }
    const title = String(req.body?.title ?? '').trim();
    if (!title || title.length > 120) {
      flash(s, tx('sh.err.name'), 'error');
      return back(reply, s, `${BASE}/sql/shared/${sh.token}`);
    }
    const extend = req.body?.days ? days(req.body.days) : null;
    await owner.query(`update meta.sql_share set title = $2, expires_at = case when $3::int is null then expires_at else now() + make_interval(days => $3::int) end where id = $1`, [sh.id, title, extend]);
    flash(s, tx('sh.saved'));
    return back(reply, s, `${BASE}/sql/shared/${sh.token}`);
  });
}
