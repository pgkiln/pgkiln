import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { usedInPanel } from './search.ts';
import { documentExtras } from './documents.ts';
import { workflowExtras, workflowForm } from './workflows.ts';
import { restExtras } from './rest.ts';
import { COMPONENTS } from './components.ts';
import { automationExtras } from './automations.ts';
import { layoutExtras } from './layouts.ts';
import { templateExtras, templateImport } from './templates.ts';
import { credentialExtras, restSourceExtras } from './websources.ts';
import { appHeader, back, BASE, csrf, developer, flash, input, region, select, send, shell, type Req } from './ui.ts';
import { endSessions, grantAccess, roleHints, roleHintsHtml, splitRoles } from './users.ts';
import { appOr404, componentForm, lookups, saveComponent } from './forms.ts';

// Shared Components: navigation, authorization schemes, LOVs, application
// items and processes, report layouts, and access control.

export async function sharedRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- shared components
  const SHARED = ['nav_entry', 'authz_scheme', 'build_option', 'lov', 'app_item', 'app_process', 'automation', 'report_layout', 'document_template', 'task_definition', 'workflow_definition', 'rest_module', 'template_component', 'web_credential', 'rest_source'];

  app.get(`${BASE}/apps/:id/shared`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOr404(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const lk = await lookups(a.id);
    const rows: Record<string, any[]> = {};
    for (const kind of SHARED)
      rows[kind] = (await owner.query(`select * from ${COMPONENTS[kind].table} where app_id = $1 order by ${kind === 'nav_entry' ? 'parent_id nulls first, seq, id' : kind === 'app_process' ? 'seq, id' : 'name'}`, [a.id])).rows;
    const users = (
      await owner.query(
        `select ac.id, ac.username, ac.display_name, ac.active, ac.last_login_at, aa.roles
           from meta.app_access aa join meta.account ac on ac.id = aa.account_id
          where aa.app_id = $1 order by lower(ac.username)`,
        [a.id],
      )
    ).rows;

    const [selKind, selId] = (req.query.c ?? '').split('-');
    const newKind = req.query.new;
    let editor: Raw;
    if (newKind && SHARED.includes(newKind)) {
      const spec = COMPONENTS[newKind];
      editor = region(`New ${spec.label.toLowerCase()}`, componentForm(spec, newKind, { seq: 10, ...spec.defaults }, lk, `${BASE}/apps/${a.id}/shared/${newKind}`, s, 'Create'));
      if (newKind === 'template_component') editor = html`${editor}${templateImport(a.id, s)}`;
    } else if (selKind && SHARED.includes(selKind)) {
      const spec = COMPONENTS[selKind];
      const row = rows[selKind].find((r) => String(r.id) === selId);
      // a workflow definition's form edits its development version (src/builder/workflows.ts)
      const [formSpec, formRow] = row && selKind === 'workflow_definition' ? workflowForm(spec, row) : [spec, row];
      editor = row
        ? region(`${spec.label}: ${spec.summary(row)}`, html`${componentForm(formSpec, selKind, formRow, lk, `${BASE}/apps/${a.id}/shared/${selKind}/${row.id}`, s, 'Save')}
            ${selKind === 'report_layout' ? layoutExtras(a.id, row, s) : selKind === 'automation' ? await automationExtras(a.id, row, s) : selKind === 'document_template' ? documentExtras(a.id, row) : selKind === 'workflow_definition' ? await workflowExtras(a.id, row, s, req.query) : selKind === 'rest_module' ? restExtras(a, row) : selKind === 'template_component' ? templateExtras(a.id, row, req.query) : selKind === 'web_credential' ? credentialExtras(a.id, row, s) : selKind === 'rest_source' ? restSourceExtras(a.id, row, s) : ''}
            ${await usedInPanel(a.id, selKind, row)}
            <form method="post" action="${BASE}/apps/${a.id}/shared/${selKind}/${row.id}/delete" class="danger-zone">${csrf(s)}<button class="btn btn-danger" data-confirm="Delete this ${spec.label.toLowerCase()}?">Delete</button></form>`)
        : html`<p>Not found.</p>`;
    } else {
      const accounts = (await owner.query('select username from meta.account where active order by lower(username) limit 2000')).rows;
      const appHints = (await roleHints([a.id])).get(a.id) ?? [];
      const groupRoles = (await owner.query('select group_name, role from meta.app_group_role where app_id = $1 order by 1, 2', [a.id])).rows;
      const groupMap = html`<h3>Identity-provider groups → roles</h3>
        <p class="muted u-mt0">With single sign-on, members of these groups get the role in this app, and may sign in even without being listed above.</p>
        ${groupRoles.length
          ? html`<div class="chips">${groupRoles.map((g) => html`<span class="chip">${g.group_name} → <b>${g.role}</b>
              <form method="post" action="${BASE}/apps/${a.id}/groups/delete" class="u-inline">${csrf(s)}<input type="hidden" name="group_name" value="${g.group_name}"><input type="hidden" name="role" value="${g.role}"><button class="link-button" aria-label="Remove mapping ${g.group_name} to ${g.role}">×</button></form></span>`)}</div>`
          : html`<p class="muted">No group mappings.</p>`}
        <form method="post" action="${BASE}/apps/${a.id}/groups">${csrf(s)}
          <div class="form-grid">${input('group_name', 'Group (as in the token)', '', { required: true, placeholder: 'e.g. hr-managers' })}${input('role', 'Role in this app', '', { required: true, placeholder: 'e.g. manager' })}</div>
          <div class="buttons"><button class="btn">Add mapping</button></div>
        </form>`;
      editor = region('Access control', html`
        <form method="post" action="${BASE}/apps/${a.id}/access" class="search u-mwnone u-mb1">${csrf(s)}
          ${select('access_control', 'Who may sign in', a.access_control, [
            ['assigned', 'Only accounts listed below (role-based access)'],
            ['any_user', 'Any active account in the directory'],
          ])}
          <button class="btn u-selfend">Save</button>
        </form>
        <p class="muted">Accounts live in the <a href="${BASE}/users">user directory</a>; here you grant them access to <b>${a.name}</b> and assign roles, which authorization schemes and <code>meta.has_role()</code> check. Role changes apply at the user's next sign-in (their sessions in this app end).</p>
        <div class="table-wrap"><table class="report report-reflow"><thead><tr><th>Account</th><th>Roles in this app</th><th>Last sign-in</th><th></th></tr></thead><tbody>
          ${users.length
            ? users.map((u) => html`<tr>
                <td data-label="Account"><a href="${BASE}/users/${u.id}">${u.username}</a>${u.display_name ? html` <span class="muted">${u.display_name}</span>` : ''}${u.active ? '' : html` <b>(inactive)</b>`}</td>
                <td data-label="Roles"><form method="post" action="${BASE}/apps/${a.id}/access/${u.id}" class="search roles-form u-m0 u-mwnone">${csrf(s)}
                  <input name="roles" value="${u.roles.join(', ')}" aria-label="Roles of ${u.username}" placeholder="no roles"><button class="btn">Save</button>
                  ${roleHintsHtml(appHints, 'Add')}</form></td>
                <td data-label="Last sign-in">${u.last_login_at ? String(u.last_login_at).slice(0, 16) : '—'}</td>
                <td data-label=""><form method="post" action="${BASE}/apps/${a.id}/access/${u.id}/revoke">${csrf(s)}<button class="link-button" data-confirm="Revoke ${u.username}'s access to ${a.name}?">Revoke</button></form></td>
              </tr>`)
            : html`<tr><td colspan="4" class="empty">No accounts have access yet.</td></tr>`}
        </tbody></table></div>
        ${groupMap}
        <h3>Grant access</h3>
        <form method="post" action="${BASE}/apps/${a.id}/access">${csrf(s)}
          <div class="form-grid">
            <div class="field"><label class="label" for="f_grant_user">Account</label>
              <input id="f_grant_user" name="username" list="accounts-list" required autocomplete="off" placeholder="username">
              <datalist id="accounts-list">${accounts.map((x) => html`<option value="${x.username}"></option>`)}</datalist>
              <small class="help">An existing account. <a href="${BASE}/users">Create accounts in Users.</a></small></div>
            <div class="field"><label class="label" for="f_roles">Roles</label>
              <input id="f_roles" name="roles" placeholder="comma separated, or pick below">
              ${roleHintsHtml(appHints)}</div>
          </div>
          <div class="buttons"><button class="btn btn-hot">Grant access</button></div>
        </form>`);
    }

    const tree = html`<ul class="tree">
      <li class="group">Security</li>
      <li><a href="${BASE}/apps/${a.id}/shared"${!selKind && !newKind ? raw(' aria-current="page"') : ''}>${icon('users')}<span>Access control</span><span class="kind">${users.length}</span></a></li>
      <li class="group">Globalization</li>
      <li><a href="${BASE}/apps/${a.id}/globalization">${icon('file')}<span>Translations and text messages</span><span class="kind">${[a.language, ...(a.languages ?? [])].join(', ')}</span></a></li>
      ${SHARED.map((kind) => {
        const spec = COMPONENTS[kind];
        return html`<li class="group">${spec.plural}<a href="?new=${kind}" aria-label="Add ${spec.label}">＋ Add</a></li>
          ${rows[kind].map((r) => html`<li><a href="?c=${kind}-${r.id}"${selKind === kind && selId === String(r.id) ? raw(' aria-current="page"') : ''}>${icon(kind === 'nav_entry' ? (r.icon ?? 'chevron') : spec.icon)}<span>${r.parent_id ? '↳ ' : ''}${spec.summary(r)}</span>${
            kind === 'nav_entry' && r.target_page ? html`<span class="kind">p${r.target_page}</span>` : kind === 'authz_scheme' ? html`<span class="kind">${r.type}</span>` : kind === 'app_process' ? html`<span class="kind">${r.point}</span>` : kind === 'report_layout' ? html`<span class="kind">${r.paper}${r.is_default ? ' · default' : ''}</span>` : kind === 'automation' ? html`<span class="kind">${r.enabled ? (r.last_status === 'error' ? 'error' : r.schedule) : 'off'}</span>` : kind === 'web_credential' ? html`<span class="kind">${r.type}${r.secret_enc ? '' : ' · no secret'}</span>` : kind === 'rest_source' ? html`<span class="kind">${r.method}</span>` : ''
          }</a></li>`)}`;
      })}
    </ul>`;

    const main = html`${appHeader(a, 'shared')}
      <div class="designer"><aside class="region region-standard">${tree}</aside><div>${editor}</div></div>`;
    return send(reply, s, shell(s, 'Shared Components', [['App Builder', BASE], [a.name, `${BASE}/apps/${a.id}`], ['Shared Components']], main));
  });

  app.post(`${BASE}/apps/:id/shared/:kind/:cid?`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const { id, kind, cid } = req.params;
    if (!SHARED.includes(kind)) return reply.code(404).send('Unknown component type');
    try {
      const newId = await saveComponent(kind, 'app_id', id, cid, req.body ?? {});
      flash(s, `${COMPONENTS[kind].label} saved.`);
      return back(reply, s, `${BASE}/apps/${id}/shared?c=${kind}-${newId}`);
    } catch (e) {
      flash(s, (e as Error).message, 'error');
      return back(reply, s, `${BASE}/apps/${id}/shared?${cid ? `c=${kind}-${cid}` : `new=${kind}`}`);
    }
  });

  app.post(`${BASE}/apps/:id/shared/:kind/:cid/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const { id, kind, cid } = req.params;
    if (!SHARED.includes(kind)) return reply.code(404).send('Unknown component type');
    await owner.query(`delete from ${COMPONENTS[kind].table} where id = $1 and app_id = $2`, [cid, id]);
    flash(s, `${COMPONENTS[kind].label} deleted.`);
    return back(reply, s, `${BASE}/apps/${id}/shared`);
  });

  // ---------------------------------------------------------------- access control
  app.post(`${BASE}/apps/:id/access`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = req.body ?? {};
    try {
      if (b.access_control) {
        await owner.query('update meta.app set access_control = $2 where id = $1', [req.params.id, b.access_control === 'any_user' ? 'any_user' : 'assigned']);
        flash(s, 'Access control saved.');
      } else {
        const acc = await owner.one('select id from meta.account where lower(username) = lower($1)', [b.username?.trim() ?? '']);
        if (!acc) throw new Error(`There is no account "${b.username}". Create it under Users first.`);
        await grantAccess(req.params.id, acc.id, splitRoles(b.roles));
        flash(s, `Access granted to ${b.username}.`);
      }
    } catch (e) {
      flash(s, (e as Error).message, 'error');
    }
    return back(reply, s, `${BASE}/apps/${req.params.id}/shared`);
  });

  app.post(`${BASE}/apps/:id/groups`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = req.body ?? {};
    await owner.query('insert into meta.app_group_role (app_id, group_name, role) values ($1, $2, $3) on conflict do nothing', [
      req.params.id, b.group_name?.trim(), b.role?.trim().toLowerCase(),
    ]);
    flash(s, 'Group mapping added. It applies at the next sign-in.');
    return back(reply, s, `${BASE}/apps/${req.params.id}/shared`);
  });

  app.post(`${BASE}/apps/:id/groups/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    await owner.query('delete from meta.app_group_role where app_id = $1 and group_name = $2 and role = $3', [req.params.id, req.body?.group_name, req.body?.role]);
    flash(s, 'Group mapping removed. It applies at the next sign-in.');
    return back(reply, s, `${BASE}/apps/${req.params.id}/shared`);
  });

  app.post(`${BASE}/apps/:id/access/:accountId`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    await grantAccess(req.params.id, req.params.accountId, splitRoles(req.body?.roles));
    flash(s, 'Roles saved. They apply at the next sign-in.');
    return back(reply, s, `${BASE}/apps/${req.params.id}/shared`);
  });

  app.post(`${BASE}/apps/:id/access/:accountId/revoke`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    await owner.query('delete from meta.app_access where app_id = $1 and account_id = $2', [req.params.id, req.params.accountId]);
    await endSessions(req.params.accountId, req.params.id);
    flash(s, 'Access revoked.');
    return back(reply, s, `${BASE}/apps/${req.params.id}/shared`);
  });

}
