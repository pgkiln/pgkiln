import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw } from '../html.ts';
import { passwordProblem } from '../security.ts';
import { back, BASE, csrf, developer, flash, input, region, select, send, shell, type Req } from './ui.ts';

// The workspace user directory (like APEX's workspace users with
// Application Access Control): one account per person, access and roles
// assigned per application.

export const splitRoles = (v: string | undefined) =>
  [...new Set((v ?? '').split(',').map((r) => r.trim().toLowerCase()).filter(Boolean))].sort();

/** End sessions of an account: in one app, or everywhere. Roles are re-read at the next sign-in. */
export async function endSessions(accountId: number | string, appId?: number | string) {
  await owner.query(
    `delete from meta.session s using meta.account a
      where a.id = $1 and s.app_id is not null and lower(s.username) = lower(a.username)
        and ($2::int is null or s.app_id = $2::int)`,
    [accountId, appId ?? null],
  );
}

/** Grant (or update) an account's access to an application. */
export async function grantAccess(appId: number | string, accountId: number | string, roles: string[]) {
  await owner.query(
    `insert into meta.app_access (app_id, account_id, roles) values ($1, $2, $3)
     on conflict (app_id, account_id) do update set roles = excluded.roles`,
    [appId, accountId, roles],
  );
  await endSessions(accountId, appId);
}

export async function usersRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- directory
  app.get(`${BASE}/users`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const q = (req.query.q ?? '').trim();
    const users = (
      await owner.query(
        `select a.*, coalesce((select jsonb_agg(jsonb_build_object('alias', p.alias, 'roles', aa.roles) order by p.alias)
                                 from meta.app_access aa join meta.app p on p.id = aa.app_id where aa.account_id = a.id), '[]') as apps
           from meta.account a
          where $1 = '' or a.username ilike '%' || $1 || '%' or a.display_name ilike '%' || $1 || '%' or a.email ilike '%' || $1 || '%'
          order by lower(a.username)
          limit 500`,
        [q],
      )
    ).rows;
    const main = html`
      <div class="title-row"><h1>Users</h1></div>
      <p class="muted" style="margin-top:0">One account per person. Give accounts access to applications, with roles per application, here or under an application's <b>Shared Components → Access control</b>.</p>
      <div class="columns wide-left">
        ${region('Accounts', html`
          <form method="get" class="search" role="search" style="margin-bottom:.75rem;max-width:none">
            <input type="search" name="q" value="${q}" placeholder="Search name, username or e-mail…" aria-label="Search accounts"><button class="btn">Search</button>
          </form>
          <div class="table-wrap"><table class="report report-reflow">
            <thead><tr><th>Username</th><th>Name</th><th>Applications (roles)</th><th>Sign-in</th><th>Status</th></tr></thead>
            <tbody>${users.length
              ? users.map((u) => html`<tr>
                  <td data-label="Username"><a href="${BASE}/users/${u.id}">${u.username}</a></td>
                  <td data-label="Name">${u.display_name ?? ''}${u.email ? html`<div class="muted">${u.email}</div>` : ''}</td>
                  <td data-label="Applications">${u.apps.length ? u.apps.map((x: any) => html`<span class="chip">${x.alias}${x.roles.length ? `: ${x.roles.join(', ')}` : ''}</span> `) : html`<span class="muted">none</span>`}</td>
                  <td data-label="Sign-in">${u.password_hash ? 'password' : html`<span class="muted">no password</span>`}</td>
                  <td data-label="Status">${u.active ? 'active' : html`<b>inactive</b>`}${u.last_login_at ? html`<div class="muted">last ${String(u.last_login_at).slice(0, 16)}</div>` : ''}</td>
                </tr>`)
              : html`<tr><td colspan="5" class="empty">No accounts found.</td></tr>`}</tbody>
          </table></div>`)}
        ${region('Create account', html`
          <form method="post" action="${BASE}/users">${csrf(s)}
            ${input('username', 'Username', '', { required: true, help: 'No spaces or colons; not case-sensitive.' })}
            ${input('display_name', 'Name', '')}
            ${input('email', 'E-mail', '', { type: 'email' })}
            ${input('password', 'Password', '', { type: 'password', auto: 'new-password', help: 'At least 8 characters. Leave empty for accounts that only sign in through single sign-on.' })}
            <div class="buttons"><button class="btn btn-hot">Create account</button></div>
          </form>`)}
      </div>`;
    return send(reply, s, shell(s, 'Users', [['Users']], main, 'users'));
  });

  app.post(`${BASE}/users`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = req.body ?? {};
    try {
      if (b.password && passwordProblem(b.password)) throw new Error(passwordProblem(b.password)!);
      const r = await owner.one(
        `insert into meta.account (username, display_name, email, password_hash)
         values ($1, $2, $3, case when $4::text is null then null else meta.hash_password($4) end) returning id`,
        [b.username?.trim(), b.display_name?.trim() || null, b.email?.trim() || null, b.password || null],
      );
      flash(s, 'Account created. Now give it access to applications.');
      return back(reply, s, `${BASE}/users/${r.id}`);
    } catch (e) {
      flash(s, /account_username_key/.test((e as Error).message) ? 'An account with that username already exists.' : (e as Error).message, 'error');
      return back(reply, s, `${BASE}/users`);
    }
  });

  // ---------------------------------------------------------------- one account
  app.get(`${BASE}/users/:id`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const u = await owner.one('select * from meta.account where id = $1', [req.params.id]);
    if (!u) return reply.code(404).send('Not found');
    const [access, apps] = await Promise.all([
      owner.query(
        `select aa.app_id, aa.roles, p.alias, p.name from meta.app_access aa join meta.app p on p.id = aa.app_id
          where aa.account_id = $1 order by p.name`,
        [u.id],
      ),
      owner.query(`select id, name, alias from meta.app where id not in (select app_id from meta.app_access where account_id = $1) order by name`, [u.id]),
    ]);
    const main = html`
      <div class="title-row"><h1>${u.username}</h1></div>
      <div class="columns">
        ${region('Details', html`
          <form method="post" action="${BASE}/users/${u.id}">${csrf(s)}
            <div class="form-grid">
              ${input('display_name', 'Name', u.display_name)}
              ${input('email', 'E-mail', u.email, { type: 'email' })}
            </div>
            <div class="field" style="margin-top:.75rem"><label class="check"><input type="checkbox" name="active" value="true"${u.active ? raw(' checked') : ''}> Active</label>
              <small class="help">Inactive accounts can't sign in to any application; deactivating ends their sessions.</small></div>
            <div class="buttons"><button class="btn btn-hot">Save</button></div>
          </form>
          <form method="post" action="${BASE}/users/${u.id}/password" class="danger-zone">${csrf(s)}
            <div class="form-grid">${input('password', u.password_hash ? 'New password' : 'Set a password', '', { type: 'password', auto: 'new-password', help: 'At least 8 characters. Ends the account’s sessions.' })}</div>
            <div class="buttons"><button class="btn">Set password</button>
              ${u.password_hash ? html`<button class="btn" name="remove" value="1" data-confirm="Remove the password? The account can then only sign in through single sign-on.">Remove password</button>` : ''}</div>
          </form>
          <form method="post" action="${BASE}/users/${u.id}/delete" class="danger-zone">${csrf(s)}
            <button class="btn btn-danger" data-confirm="Delete account ${u.username} and all its application access?">Delete account</button>
          </form>`)}
        ${region('Application access', html`
          <div class="table-wrap"><table class="report report-reflow"><thead><tr><th>Application</th><th>Roles</th><th></th></tr></thead><tbody>
            ${access.rows.length
              ? access.rows.map((a) => html`<tr>
                  <td data-label="Application"><a href="${BASE}/apps/${a.app_id}/shared">${a.name}</a> <span class="muted">/a/${a.alias}</span></td>
                  <td data-label="Roles"><form method="post" action="${BASE}/users/${u.id}/access/${a.app_id}" class="search" style="margin:0;max-width:none">${csrf(s)}
                    <input name="roles" value="${a.roles.join(', ')}" aria-label="Roles in ${a.name}" placeholder="no roles"><button class="btn">Save</button></form></td>
                  <td data-label=""><form method="post" action="${BASE}/users/${u.id}/access/${a.app_id}/revoke">${csrf(s)}<button class="link-button" data-confirm="Revoke access to ${a.name}?">Revoke</button></form></td>
                </tr>`)
              : html`<tr><td colspan="3" class="empty">No access to any application yet.</td></tr>`}
          </tbody></table></div>
          ${apps.rows.length
            ? html`<h3>Grant access</h3>
              <form method="post" action="${BASE}/users/${u.id}/access">${csrf(s)}
                <div class="form-grid">
                  ${select('app_id', 'Application', '', apps.rows.map((a): [string, string] => [String(a.id), a.name]))}
                  ${input('roles', 'Roles', '', { placeholder: 'comma separated, e.g. admin, manager' })}
                </div>
                <div class="buttons"><button class="btn btn-hot">Grant access</button></div>
              </form>`
            : ''}`)}
      </div>`;
    return send(reply, s, shell(s, u.username, [['Users', `${BASE}/users`], [u.username]], main, 'users'));
  });

  app.post(`${BASE}/users/:id`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = req.body ?? {};
    await owner.query('update meta.account set display_name = $2, email = $3, active = $4 where id = $1', [
      req.params.id, b.display_name?.trim() || null, b.email?.trim() || null, b.active === 'true',
    ]);
    if (b.active !== 'true') await endSessions(req.params.id);
    flash(s, 'Account saved.');
    return back(reply, s, `${BASE}/users/${req.params.id}`);
  });

  app.post(`${BASE}/users/:id/password`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = req.body ?? {};
    try {
      if (b.remove === '1') await owner.query('update meta.account set password_hash = null where id = $1', [req.params.id]);
      else {
        const problem = passwordProblem(b.password);
        if (problem) throw new Error(problem);
        await owner.query('update meta.account set password_hash = meta.hash_password($2) where id = $1', [req.params.id, b.password]);
      }
      await endSessions(req.params.id);
      flash(s, b.remove === '1' ? 'Password removed.' : 'Password set.');
    } catch (e) {
      flash(s, (e as Error).message, 'error');
    }
    return back(reply, s, `${BASE}/users/${req.params.id}`);
  });

  app.post(`${BASE}/users/:id/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    await endSessions(req.params.id);
    await owner.query('delete from meta.account where id = $1', [req.params.id]);
    flash(s, 'Account deleted.');
    return back(reply, s, `${BASE}/users`);
  });

  app.post(`${BASE}/users/:id/access`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    await grantAccess(req.body?.app_id ?? '', req.params.id, splitRoles(req.body?.roles));
    flash(s, 'Access granted.');
    return back(reply, s, `${BASE}/users/${req.params.id}`);
  });

  app.post(`${BASE}/users/:id/access/:appId`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    await grantAccess(req.params.appId, req.params.id, splitRoles(req.body?.roles));
    flash(s, 'Roles saved. The user gets them at the next sign-in.');
    return back(reply, s, `${BASE}/users/${req.params.id}`);
  });

  app.post(`${BASE}/users/:id/access/:appId/revoke`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    await owner.query('delete from meta.app_access where account_id = $1 and app_id = $2', [req.params.id, req.params.appId]);
    await endSessions(req.params.id, req.params.appId);
    flash(s, 'Access revoked.');
    return back(reply, s, `${BASE}/users/${req.params.id}`);
  });
}
