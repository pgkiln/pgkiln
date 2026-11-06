import type { FastifyInstance, FastifyReply } from 'fastify';
import { esc, html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { owner } from '../db.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import { back, BASE, csrf, developer, flash, send, shell, workshopTabs, type Body, type Req } from './ui.ts';
import { SYSTEM_SCHEMAS } from './object-browser.ts';
import { clearCompletions } from './code-editor.ts';
import { roleHints, splitRoles } from './users.ts';
import { currentWorkspace, inWorkspaceSql, usableSchemas, workshopDb } from './workspaces.ts';
import { joinStatements, recordChanges } from '../changelog.ts';
import { tr } from './i18n.ts';
import {
  APP_ROLE_RE, checkSecurity, currentDef, MASK_LABELS, MASKS, maskedColumns, readSecurity, securitySql, sees,
  type ColumnMask, type SecurityDef, type TableSecurity,
} from '../datasec.ts';

// (sprint 119, WS-13: data security per table) SQL Workshop › Object Browser › a table › Security: the table's row
// level security policies, a matrix of database roles × columns (read, update) and masked values per application
// role, in one form. Preview SQL shows the GRANT / REVOKE statements and the masking view (src/datasec.ts); Apply runs
// them in one transaction with the workshop's connection and records a change set; Open in the worksheet puts them
// there. Like Table Properties, the statements are made against the catalog as it is at the time of the post.

/** The workspace's applications with a database role, and the application roles they check. */
async function workspaceApps(s: Session) {
  const apps = (await owner.query<{ id: number; alias: string; role: string }>(
    `select a.id, a.alias, a.db_role as role from meta.app a where a.db_role is not null and ${inWorkspaceSql('a', 1)} order by a.alias`,
    [currentWorkspace(s)])).rows;
  const hints = await roleHints(apps.map((a) => a.id));
  const appRoles = [...new Set([...hints.values()].flat().map((h) => h.role))].filter((r) => APP_ROLE_RE.test(r));
  return { appDbRoles: apps.map((a) => ({ role: a.role, alias: a.alias })), appRoles };
}

/** The definition the form posted. Grant rows and columns are matched by index against the catalog's state. */
function fromForm(b: Body, cur: TableSecurity): SecurityDef {
  const on = (k: string) => b[k] === 'on';
  const all = cur.columns.map((c) => c.name);
  const grants = cur.grants.map((g, i) => ({
    role: g.role,
    select: all.filter((_, j) => on(`g.${i}.s.${j}`)),
    update: all.filter((_, j) => on(`g.${i}.u.${j}`)),
  }));
  // the roles the matrix's checkboxes were drawn for (a changed list applies after the next Preview)
  const shown = splitRoles(String(b.shown_roles ?? ''));
  const roles = splitRoles(String(b.roles ?? ''));
  const cols: Record<string, ColumnMask> = {};
  all.forEach((c, j) => {
    const mask = MASKS.find((m) => m === b[`m.${j}.mask`]);
    if (!mask) return;
    cols[c] = { mask, others: on(`m.${j}.others`), see: shown.filter((r, k) => roles.includes(r) && on(`m.${j}.see.${k}`)) };
  });
  return {
    grants,
    view: { enabled: on('view'), name: String(b.view_name ?? '').trim(), roles, cols },
  };
}

function form(s: Session, cur: TableSecurity, def: SecurityDef, opts: { ref: string; sql: string[]; warnings: string[]; errors: string[]; output: Raw | '' }): Raw {
  const tx = tr(s);
  const chk = (x: boolean) => (x ? raw(' checked') : '');
  const all = cur.columns.map((c) => c.name);
  const v = def.view;
  const masked = new Set(maskedColumns(v));
  const objUrl = `${BASE}/sql/objects?${new URLSearchParams({ schema: cur.schema, k: 'table', o: opts.ref })}`;
  const policyUrl = `${BASE}/sql/objects/action?${new URLSearchParams({ schema: cur.schema, k: 'table', o: opts.ref, do: 'policy' })}`;
  const rows = html`<div class="table-wrap"><table class="report ds-table"><caption class="sr-only">${tx('ds.roles_and_columns')}</caption>
    <thead><tr><th scope="col">${tx('ds.db_role')}</th>${all.map((c) => html`<th scope="col"><code>${c}</code>${masked.has(c) ? html` <span class="badge" title="${tx('ds.masked_in', { view: v.name })}">${tx('ds.masked')}</span>` : ''}</th>`)}</tr></thead>
    <tbody>${cur.grants.length ? def.grants.map((g, i) => {
      const info = cur.grants[i];
      return html`<tr><th scope="row"><code>${g.role === 'PUBLIC' ? 'PUBLIC' : g.role}</code>${info.apps.length ? html`<br><small class="muted">${tx('ds.runs', { apps: info.apps.join(', ') })}</small>` : ''}</th>
        ${all.map((c, j) => html`<td class="ds-cell"><label class="check"><input type="checkbox" name="g.${i}.s.${j}"${chk(g.select.includes(c))}> ${tx('ds.read')}</label>
          <label class="check"><input type="checkbox" name="g.${i}.u.${j}"${chk(g.update.includes(c))}> ${tx('ds.update')}</label></td>`)}</tr>`;
    }) : html`<tr><td colspan="${all.length + 1}" class="muted">${tx('ds.no_grants')}</td></tr>`}</tbody></table></div>
    ${cur.excluded.length ? html`<p class="muted small">${tx('ds.excluded')} ${cur.excluded.map((x) => html`<code>${x.role}</code> (${x.why}) `)}</p>` : ''}`;
  const maskRows = html`<div class="table-wrap"><table class="report ds-table"><caption class="sr-only">${tx('ds.masks_per_column')}</caption>
    <thead><tr><th scope="col">${tx('ds.column')}</th><th scope="col">${tx('ds.mask')}</th>${v.roles.map((r) => html`<th scope="col">${tx('ds.role_sees', { role: r })}</th>`)}<th scope="col">${tx('ds.others_see')}</th></tr></thead>
    <tbody>${all.map((c, j) => {
      const m = v.cols[c];
      return html`<tr><th scope="row"><code>${c}</code> <small class="muted">${cur.columns[j].type}</small></th>
        <td><select name="m.${j}.mask" aria-label="${tx('ds.aria_mask', { column: c })}"><option value="">${tx('ds.not_masked')}</option>${MASKS.map((x) => html`<option value="${x}"${m?.mask === x ? raw(' selected') : ''}>${tx.dyn(`ds.mask.${x}`, MASK_LABELS[x])}</option>`)}</select></td>
        ${v.roles.map((r, k) => html`<td class="ds-c"><input type="checkbox" aria-label="${tx('ds.aria_role_sees', { role: r, column: c })}" name="m.${j}.see.${k}"${chk(!!m && sees(v, c, r))}></td>`)}
        <td class="ds-c"><input type="checkbox" aria-label="${tx('ds.aria_others_see', { column: c })}" name="m.${j}.others"${chk(!!m && m.others)}></td></tr>`;
    })}</tbody></table></div>`;
  return html`<form method="post" action="${BASE}/sql/objects/security" class="ds">${csrf(s)}
    <input type="hidden" name="ref" value="${opts.ref}"><input type="hidden" name="shown_roles" value="${v.roles.join(', ')}">
    ${opts.errors.length ? html`<div class="alert alert-error" role="alert"><ul>${opts.errors.map((e) => html`<li>${e}</li>`)}</ul></div>` : ''}
    <section class="ds-section"><h2>${icon('shield')} ${tx('ds.rows')}</h2>
      <p>${tx.rich('ds.rls_is', { state: raw(`<strong>${esc(cur.rls ? (cur.forceRls ? tx('ds.rls_on_owner') : tx('ds.rls_on')) : tx('ds.rls_off'))}</strong>`) })}${cur.rls ? '' : `: ${tx('ds.rls_off_detail')}`}.
        ${tx.rich('ds.rls_how', { props: raw(`<a href="${BASE}/sql/objects/table?${new URLSearchParams({ o: opts.ref })}">${esc(tx('ds.table_properties'))}</a>`), policy: raw(`<a href="${policyUrl}">${esc(tx('ds.add_policy'))}</a>`) })}</p>
      ${cur.policies.length ? html`<div class="table-wrap"><table class="report"><thead><tr><th>${tx('ds.policy')}</th><th>${tx('ds.command')}</th><th>${tx('ds.roles')}</th><th>Using</th><th>With check</th></tr></thead><tbody>
        ${cur.policies.map((p) => html`<tr><td>${p.name}${p.permissive === 'RESTRICTIVE' ? html` <span class="badge">${tx('ds.restrictive')}</span>` : ''}</td><td>${p.command}</td><td><code>${p.roles}</code></td><td><code>${p.using ?? ''}</code></td><td><code>${p.check ?? ''}</code></td></tr>`)}</tbody></table></div>`
        : html`<p class="muted">${cur.rls ? tx('ds.no_policies_rls') : tx('ds.no_policies')}</p>`}
    </section>
    <section class="ds-section"><h2>${icon('table')} ${tx('ds.columns')}</h2>
      <p class="muted">${tx('ds.columns_help')}</p>
      ${rows}
    </section>
    <section class="ds-section"><h2>${icon('eye')} ${tx('ds.values')}</h2>
      <p class="muted">${tx.code('ds.values_help')}</p>
      <label class="check"><input type="checkbox" name="view"${chk(v.enabled)}> ${tx('ds.masking_view')}</label>
      <div class="form-grid">
        <div class="field"><label class="label" for="ds-view">${tx('ds.view_name')}</label><input id="ds-view" name="view_name" value="${v.name}" autocomplete="off" spellcheck="false"></div>
        <div class="field"><label class="label" for="ds-roles">${tx('ds.app_roles')}</label><input id="ds-roles" name="roles" value="${v.roles.join(', ')}" autocomplete="off" spellcheck="false">
          <small class="help">${tx('ds.app_roles_help')}</small></div>
      </div>
      ${maskRows}
    </section>
    <section class="ds-section"><h2>${icon('code')} SQL</h2>
      ${opts.warnings.length ? html`<div class="alert alert-warning" role="status"><ul>${opts.warnings.map((w) => html`<li>${w}</li>`)}</ul></div>` : ''}
      ${opts.sql.length ? html`<pre class="source" data-code-view="sql" tabindex="0" aria-label="SQL">${opts.sql.join(';\n\n')};</pre>` : html`<p class="muted">${tx('ds.no_changes')}</p>`}
      ${opts.output}
    </section>
    <div class="buttons">
      <button class="btn" name="mode" value="preview">${icon('eye')} ${tx('ds.preview_sql')}</button>
      <button class="btn btn-hot" name="mode" value="apply">${icon('check')} ${tx('te.apply')}</button>
      <button class="btn" name="mode" value="worksheet">${icon('code')} ${tx('te.open_ws')}</button>
      <a class="btn" href="${objUrl}">${tx('common.cancel')}</a>
    </div></form>`;
}

async function page(req: Req, reply: FastifyReply) {
  const s = await developer(req, reply);
  if (!s) return;
  const db = await workshopDb(s);
  const isPost = req.method === 'POST';
  const b: Body = isPost ? (req.body ?? {}) : (req.query ?? {});
  const ref = String((isPost ? b.ref : b.o) ?? '');
  const schemas = (await usableSchemas(db)).filter((n) => !SYSTEM_SCHEMAS.includes(n));
  const { appDbRoles, appRoles } = await workspaceApps(s);
  const cur = ref ? await readSecurity(db, ref, appDbRoles, appRoles) : null;
  if (!cur || !schemas.includes(cur.schema)) return reply.code(404).send('Not found');
  let def = currentDef(cur);
  let errors: string[] = [];
  let sql: string[] = [];
  let warnings: string[] = [];
  let output: Raw | '' = '';
  if (isPost) {
    def = fromForm(b, cur);
    const taken = (await db.query<{ n: string }>(`select relname as n from pg_class where relnamespace = $1::regnamespace`, [cur.schema])).rows.map((r) => r.n);
    errors = checkSecurity(def, cur, taken);
    if (!errors.length) ({ statements: sql, warnings } = securitySql(def, cur));
    if (!errors.length && b.mode === 'worksheet') {
      s.state.__SQLDRAFT = sql.length ? `${sql.join(';\n\n')};` : '-- no changes';
      flash(s, tr(s)('te.review'));
      return back(reply, s, `${BASE}/sql/worksheet`);
    }
    if (!errors.length && b.mode === 'apply' && sql.length) {
      const c = await db.pool.connect();
      let failed = '';
      let at = '';
      try {
        await c.query('begin');
        for (const x of sql) {
          at = x;
          await c.query(x);
        }
        await c.query('commit');
      } catch (e) {
        failed = (e as Error).message;
        await c.query('rollback').catch(() => {});
      } finally {
        c.release(true);
      }
      await logActivity({ username: s.username, event: 'sql_command', ip: clientIp(req), detail: sql.join(';\n').slice(0, 2000) });
      clearCompletions();
      if (!failed) {
        await recordChanges({ workspaceId: currentWorkspace(s), author: s.username ?? '?', source: 'table', name: `security_${cur.table}`.slice(0, 63), defaultSchema: cur.schema, statements: [joinStatements(sql)] });
        flash(s, sql.length === 1 ? tr(s)('ds.changed_1', { table: `${cur.schema}.${cur.table}` }) : tr(s)('ds.changed', { table: `${cur.schema}.${cur.table}`, n: sql.length }));
        return back(reply, s, `${BASE}/sql/objects/security?${new URLSearchParams({ o: ref })}`);
      }
      output = html`<div class="alert alert-error" role="alert"><p>${tr(s)('ds.rolled_back')}</p><p>${failed}</p><pre class="source" data-code-view="sql" tabindex="0" aria-label="${tr(s)('ds.failed_statement')}">${at}</pre></div>`;
    }
  }
  const title = tr(s)('ds.title', { table: `${cur.schema}.${cur.table}` });
  const objUrl = `${BASE}/sql/objects?${new URLSearchParams({ schema: cur.schema, k: 'table', o: ref })}`;
  const main = html`<h1 class="u-mb1">${title}</h1>${workshopTabs('objects', s)}${form(s, cur, def, { ref, sql, warnings, errors, output })}`;
  return send(reply, s, shell(s, title, [[tr(s)('rail.sql_workshop'), `${BASE}/sql`], [tr(s)('sql.tool.objects'), `${BASE}/sql/objects`], [`${cur.schema}.${cur.table}`, objUrl], [tr(s)('ds.security')]], main, 'sql'));
}

export async function dataSecurityRoutes(app: FastifyInstance) {
  app.get(`${BASE}/sql/objects/security`, page);
  app.post(`${BASE}/sql/objects/security`, page);
}

