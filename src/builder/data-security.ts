import type { FastifyInstance, FastifyReply } from 'fastify';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { owner } from '../db.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import { back, BASE, csrf, developer, flash, send, shell, workshopTabs, type Body, type Req } from './ui.ts';
import { SYSTEM_SCHEMAS } from './object-browser.ts';
import { clearCompletions } from './code-editor.ts';
import { roleHints, splitRoles } from './users.ts';
import { currentWorkspace, inWorkspaceSql, usableSchemas, workshopDb } from './workspaces.ts';
import { joinStatements, recordChanges } from '../changelog.ts';
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
  const chk = (x: boolean) => (x ? raw(' checked') : '');
  const all = cur.columns.map((c) => c.name);
  const v = def.view;
  const masked = new Set(maskedColumns(v));
  const objUrl = `${BASE}/sql/objects?${new URLSearchParams({ schema: cur.schema, k: 'table', o: opts.ref })}`;
  const policyUrl = `${BASE}/sql/objects/action?${new URLSearchParams({ schema: cur.schema, k: 'table', o: opts.ref, do: 'policy' })}`;
  const rows = html`<div class="table-wrap"><table class="report ds-table"><caption class="sr-only">Database roles and columns</caption>
    <thead><tr><th scope="col">Database role</th>${all.map((c) => html`<th scope="col"><code>${c}</code>${masked.has(c) ? html` <span class="badge" title="Masked in ${v.name}">masked</span>` : ''}</th>`)}</tr></thead>
    <tbody>${cur.grants.length ? def.grants.map((g, i) => {
      const info = cur.grants[i];
      return html`<tr><th scope="row"><code>${g.role === 'PUBLIC' ? 'PUBLIC' : g.role}</code>${info.apps.length ? html`<br><small class="muted">runs ${info.apps.join(', ')}</small>` : ''}</th>
        ${all.map((c, j) => html`<td class="ds-cell"><label class="check"><input type="checkbox" name="g.${i}.s.${j}"${chk(g.select.includes(c))}> read</label>
          <label class="check"><input type="checkbox" name="g.${i}.u.${j}"${chk(g.update.includes(c))}> update</label></td>`)}</tr>`;
    }) : html`<tr><td colspan="${all.length + 1}" class="muted">No database role has privileges on this table, and no application of the workspace runs with a database role.</td></tr>`}</tbody></table></div>
    ${cur.excluded.length ? html`<p class="muted small">Not in the matrix, because column privileges can't restrict them: ${cur.excluded.map((x) => html`<code>${x.role}</code> (${x.why}) `)}</p>` : ''}`;
  const maskRows = html`<div class="table-wrap"><table class="report ds-table"><caption class="sr-only">Masks per column</caption>
    <thead><tr><th scope="col">Column</th><th scope="col">Mask</th>${v.roles.map((r) => html`<th scope="col">${r} sees it</th>`)}<th scope="col">Everyone else sees it</th></tr></thead>
    <tbody>${all.map((c, j) => {
      const m = v.cols[c];
      return html`<tr><th scope="row"><code>${c}</code> <small class="muted">${cur.columns[j].type}</small></th>
        <td><select name="m.${j}.mask" aria-label="Mask of ${c}"><option value="">Not masked</option>${MASKS.map((x) => html`<option value="${x}"${m?.mask === x ? raw(' selected') : ''}>${MASK_LABELS[x]}</option>`)}</select></td>
        ${v.roles.map((r, k) => html`<td class="ds-c"><input type="checkbox" aria-label="${r} sees ${c}" name="m.${j}.see.${k}"${chk(!!m && sees(v, c, r))}></td>`)}
        <td class="ds-c"><input type="checkbox" aria-label="Everyone else sees ${c}" name="m.${j}.others"${chk(!!m && m.others)}></td></tr>`;
    })}</tbody></table></div>`;
  return html`<form method="post" action="${BASE}/sql/objects/security" class="ds">${csrf(s)}
    <input type="hidden" name="ref" value="${opts.ref}"><input type="hidden" name="shown_roles" value="${v.roles.join(', ')}">
    ${opts.errors.length ? html`<div class="alert alert-error" role="alert"><ul>${opts.errors.map((e) => html`<li>${e}</li>`)}</ul></div>` : ''}
    <section class="ds-section"><h2>${icon('shield')} Rows</h2>
      <p>Row level security is <strong>${cur.rls ? (cur.forceRls ? 'on, also for the owner' : 'on') : 'off'}</strong>${cur.rls ? '' : ': every role that may read the table reads every row'}.
        <a href="${BASE}/sql/objects/table?${new URLSearchParams({ o: opts.ref })}">Table Properties</a> switches it on; <a href="${policyUrl}">Add policy</a> writes one in the worksheet.</p>
      ${cur.policies.length ? html`<div class="table-wrap"><table class="report"><thead><tr><th>Policy</th><th>Command</th><th>Roles</th><th>Using</th><th>With check</th></tr></thead><tbody>
        ${cur.policies.map((p) => html`<tr><td>${p.name}${p.permissive === 'RESTRICTIVE' ? html` <span class="badge">restrictive</span>` : ''}</td><td>${p.command}</td><td><code>${p.roles}</code></td><td><code>${p.using ?? ''}</code></td><td><code>${p.check ?? ''}</code></td></tr>`)}</tbody></table></div>`
        : html`<p class="muted">No policies${cur.rls ? ': with row level security on, the roles below read no rows at all' : ''}.</p>`}
    </section>
    <section class="ds-section"><h2>${icon('table')} Columns</h2>
      <p class="muted">What each database role may read and update, per column. A column a role may not read is refused by PostgreSQL whoever sends the query: pages, REST handlers, AutoREST, AI tools, MCP or psql.</p>
      ${rows}
    </section>
    <section class="ds-section"><h2>${icon('eye')} Values</h2>
      <p class="muted">Masked columns show their value only to the application roles you tick (<code>meta.has_role()</code> of the signed-in user); others see the mask. The masks live in a view next to the table that the roles above read instead of the table.</p>
      <label class="check"><input type="checkbox" name="view"${chk(v.enabled)}> Masking view</label>
      <div class="form-grid">
        <div class="field"><label class="label" for="ds-view">View name</label><input id="ds-view" name="view_name" value="${v.name}" autocomplete="off" spellcheck="false"></div>
        <div class="field"><label class="label" for="ds-roles">Application roles</label><input id="ds-roles" name="roles" value="${v.roles.join(', ')}" autocomplete="off" spellcheck="false">
          <small class="help">Comma-separated. Changed roles get their column in the table below after Preview SQL.</small></div>
      </div>
      ${maskRows}
    </section>
    <section class="ds-section"><h2>${icon('code')} SQL</h2>
      ${opts.warnings.length ? html`<div class="alert alert-warning" role="status"><ul>${opts.warnings.map((w) => html`<li>${w}</li>`)}</ul></div>` : ''}
      ${opts.sql.length ? html`<pre class="source" data-code-view="sql" tabindex="0" aria-label="SQL">${opts.sql.join(';\n\n')};</pre>` : html`<p class="muted">No changes: the table's security is as the form shows it.</p>`}
      ${opts.output}
    </section>
    <div class="buttons">
      <button class="btn" name="mode" value="preview">${icon('eye')} Preview SQL</button>
      <button class="btn btn-hot" name="mode" value="apply">${icon('check')} Apply</button>
      <button class="btn" name="mode" value="worksheet">${icon('code')} Open in the worksheet</button>
      <a class="btn" href="${objUrl}">Cancel</a>
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
      flash(s, 'Review the statements and run them: nothing has been changed yet.');
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
        flash(s, `Changed the security of ${cur.schema}.${cur.table}: ${sql.length} statement${sql.length === 1 ? '' : 's'}.`);
        return back(reply, s, `${BASE}/sql/objects/security?${new URLSearchParams({ o: ref })}`);
      }
      output = html`<div class="alert alert-error" role="alert"><p><strong>Nothing was changed</strong>: the statements ran in one transaction, which was rolled back.</p><p>${failed}</p><pre class="source" data-code-view="sql" tabindex="0" aria-label="Failed statement">${at}</pre></div>`;
    }
  }
  const title = `Security of ${cur.schema}.${cur.table}`;
  const objUrl = `${BASE}/sql/objects?${new URLSearchParams({ schema: cur.schema, k: 'table', o: ref })}`;
  const main = html`<h1 class="u-mb1">${title}</h1>${workshopTabs('objects', s)}${form(s, cur, def, { ref, sql, warnings, errors, output })}`;
  return send(reply, s, shell(s, title, [['SQL Workshop', `${BASE}/sql`], ['Object Browser', `${BASE}/sql/objects`], [`${cur.schema}.${cur.table}`, objUrl], ['Security']], main, 'sql'));
}

export async function dataSecurityRoutes(app: FastifyInstance) {
  app.get(`${BASE}/sql/objects/security`, page);
  app.post(`${BASE}/sql/objects/security`, page);
}

