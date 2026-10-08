import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw } from '../html.ts';
import { accountSettings, clearAccountSettings, passwordProblem } from '../accounts.ts';
import { loginMaxFailuresPerUser, loginWindowMinutes } from '../security.ts';
import { acsUrl, metadataUrl, spEntityId } from '../saml.ts';
import { discover, publicUrl, redirectUri } from '../sso.ts';
import { back, BASE, csrf, developer, flash, input, region, select, send, shell, type Req } from './ui.ts';

// The workspace user directory (like APEX's workspace users with
// Application Access Control): one account per person, access and roles
// assigned per application.

export interface RoleHint {
  role: string;
  sources: string[];
}

/**
 * The roles an application checks, and where: role-based authorization
 * schemes, meta.has_role('…') in SQL schemes and page components,
 * identity-provider group mappings, and roles already assigned to users.
 * Roles are free text, so this is what makes them discoverable.
 */
export async function roleHints(appIds: number[]): Promise<Map<number, RoleHint[]>> {
  const hasRole = String.raw`has_role\s*\(\s*'([^']+)'\s*\)`;
  const rows = (
    await owner.query<{ app_id: number; role: string; sources: string[] }>(
      `with src as (
         select s.app_id, lower(s.value) as role, 'authorization scheme ' || s.name as source
           from meta.authz_scheme s where s.type = 'role' and s.app_id = any($1)
         union all
         select s.app_id, lower(m[1]), 'authorization scheme ' || s.name
           from meta.authz_scheme s, regexp_matches(s.value, $2, 'gi') m where s.type = 'sql' and s.app_id = any($1)
         union all
         select p.app_id, lower(m[1]), 'SQL on page ' || p.page_no
           from meta.page p
           join lateral (
             select concat_ws(' ', r.source, r.condition) as t from meta.region r where r.page_id = p.id
             union all select concat_ws(' ', b.condition) from meta.button b where b.page_id = p.id
             union all select concat_ws(' ', i.lov, i.readonly_condition) from meta.item i where i.page_id = p.id
             union all select concat_ws(' ', x.code) from meta.process x where x.page_id = p.id
             union all select concat_ws(' ', v.expression) from meta.validation v where v.page_id = p.id
             union all select concat_ws(' ', d.code) from meta.dynamic_action d where d.page_id = p.id
           ) c on true,
           regexp_matches(c.t, $2, 'gi') m
          where p.app_id = any($1)
         union all
         select g.app_id, lower(g.role), 'identity-provider group ' || g.group_name
           from meta.app_group_role g where g.app_id = any($1)
         union all
         select aa.app_id, lower(r), 'assigned to users'
           from meta.app_access aa, unnest(aa.roles) r where aa.app_id = any($1)
       )
       select app_id, role, array_agg(distinct source order by source) as sources
         from src where role <> '' group by 1, 2 order by 1, 2`,
      [appIds, hasRole],
    )
  ).rows;
  const out = new Map<number, RoleHint[]>(appIds.map((id) => [id, []]));
  for (const r of rows) out.get(r.app_id)?.push({ role: r.role, sources: r.sources });
  return out;
}

/** Clickable role suggestions under a roles field (JS adds the role; without JS they're a list). */
export function roleHintsHtml(hints: RoleHint[], label = 'Roles this app checks') {
  if (!hints.length)
    return html`<small class="help role-hints">This app doesn't check any roles yet. Roles only matter where an authorization scheme or <code>meta.has_role()</code> checks them (Shared Components → Authorization schemes).</small>`;
  return html`<small class="help role-hints">${label}: ${hints.map(
    (h) => html`<button type="button" class="chip role-chip" data-add-role="${h.role}" title="${h.sources.join('; ')}">${h.role}</button> `,
  )}</small>`;
}

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
    const cfg = await accountSettings();
    const main = html`
      <div class="title-row"><h1>Users</h1><div class="buttons"><a class="btn" href="${BASE}/users/providers">Identity providers (single sign-on)</a> <a class="btn" href="${BASE}/users/directories">LDAP directories</a></div></div>
      <p class="muted u-mt0">One account per person. Give accounts access to applications, with roles per application, here or under an application's <b>Shared Components → Access control</b>.</p>
      <div class="columns wide-left">
        ${region('Accounts', html`
          <form method="get" class="search u-mb075 u-mwnone" role="search">
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
            <div class="field"><label class="check"><input type="checkbox" name="must_change" value="true" checked> Require change of password on first use</label></div>
            <div class="buttons"><button class="btn btn-hot">Create account</button></div>
          </form>`)}
        ${region('Account settings', html`
          <form method="post" action="${BASE}/users/settings">${csrf(s)}
            <div class="form-grid">
              ${input('password_min_length', 'Minimum password length', cfg.minLength, { type: 'number' })}
              ${input('password_lifetime_days', 'Password lifetime (days)', cfg.lifetimeDays, { type: 'number', help: 'After this many days users must choose a new password at sign-in. 0 = never.' })}
            </div>
            <div class="field"><label class="check"><input type="checkbox" name="password_require_mixed" value="true"${cfg.requireMixed ? raw(' checked') : ''}> Passwords need letters and digits</label></div>
            <p class="muted">Passwords may never contain the username. Sign-in is locked for ${loginWindowMinutes()} minutes after ${loginMaxFailuresPerUser()} failed attempts (Workspace utilities → Instance settings); Unlock on an account lifts it.</p>
            <div class="buttons"><button class="btn">Save settings</button></div>
          </form>`, '', 'account-settings')}
      </div>`;
    return send(reply, s, shell(s, 'Users', [['Users']], main, 'users'));
  });

  app.post(`${BASE}/users`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = req.body ?? {};
    try {
      const problem = b.password ? await passwordProblem(b.password, { username: b.username }) : null;
      if (problem) throw new Error(problem);
      const r = await owner.one(
        `insert into meta.account (username, display_name, email, password_hash, must_change_password)
         values ($1, $2, $3, case when $4::text is null then null else meta.hash_password($4) end, $5 and $4::text is not null) returning id`,
        [b.username?.trim(), b.display_name?.trim() || null, b.email?.trim() || null, b.password || null, b.must_change === 'true'],
      );
      flash(s, 'Account created. Now give it access to applications.');
      return back(reply, s, `${BASE}/users/${r.id}`);
    } catch (e) {
      flash(s, /account_username_key/.test((e as Error).message) ? 'An account with that username already exists.' : (e as Error).message, 'error');
      return back(reply, s, `${BASE}/users`);
    }
  });

  app.post(`${BASE}/users/settings`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = req.body ?? {};
    const n = (v: string | undefined, min: number, max: number) => String(Math.min(max, Math.max(min, Math.round(Number(v) || 0))));
    await owner.query(
      `insert into meta.setting (name, value) values ('password_min_length', $1), ('password_lifetime_days', $2), ('password_require_mixed', $3)
       on conflict (name) do update set value = excluded.value`,
      [n(b.password_min_length, 6, 128), n(b.password_lifetime_days, 0, 3650), b.password_require_mixed === 'true' ? 'true' : 'false'],
    );
    clearAccountSettings();
    flash(s, 'Account settings saved.');
    return back(reply, s, `${BASE}/users`);
  });

  // ---------------------------------------------------------------- one account
  app.get(`${BASE}/users/:id(^\\d+$)`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const u = await owner.one('select *, meta.password_days_left(username) as days_left from meta.account where id = $1', [req.params.id]);
    if (!u) return reply.code(404).send('Not found');
    const fails = (await owner.one(
      `select count(*)::int as n from meta.activity_log l
        where l.event = 'login_failed' and lower(l.username) = lower($1) and l.at > now() - interval '1 hour'
          and l.at > coalesce((select max(x.at) from meta.activity_log x where x.event in ('login', 'login_unlocked') and lower(x.username) = lower($1)), '-infinity')`,
      [u.username])).n;
    const [access, apps] = await Promise.all([
      owner.query(
        `select aa.app_id, aa.roles, p.alias, p.name from meta.app_access aa join meta.app p on p.id = aa.app_id
          where aa.account_id = $1 order by p.name`,
        [u.id],
      ),
      owner.query(`select id, name, alias from meta.app where id not in (select app_id from meta.app_access where account_id = $1) order by name`, [u.id]),
    ]);
    const hints = await roleHints([...access.rows.map((a) => a.app_id), ...apps.rows.map((a) => a.id)]);
    const main = html`
      <div class="title-row"><h1>${u.username}</h1></div>
      <div class="columns">
        ${region('Details', html`
          <form method="post" action="${BASE}/users/${u.id}">${csrf(s)}
            <div class="form-grid">
              ${input('display_name', 'Name', u.display_name)}
              ${input('email', 'E-mail', u.email, { type: 'email' })}
            </div>
            <div class="field u-mt075"><label class="check"><input type="checkbox" name="active" value="true"${u.active ? raw(' checked') : ''}> Active</label>
              <small class="help">Inactive accounts can't sign in to any application; deactivating ends their sessions.</small></div>
            <div class="buttons"><button class="btn btn-hot">Save</button></div>
          </form>
          <h3>Password</h3>
          <ul class="checklist">
            <li>${u.password_hash ? html`Set ${u.password_changed_at ? html`on ${String(u.password_changed_at).slice(0, 10)}` : ''}` : 'No password (single sign-on only)'}</li>
            ${u.must_change_password ? html`<li><b>Must be changed at the next sign-in</b></li>` : u.days_left !== null ? html`<li>Expires in ${u.days_left} day(s)</li>` : ''}
            ${fails ? html`<li>${fails} failed sign-in(s) in the last hour</li>` : ''}
          </ul>
          <div class="buttons">
            ${u.password_hash ? html`<form method="post" action="${BASE}/users/${u.id}/expire">${csrf(s)}<input type="hidden" name="expire" value="${u.must_change_password ? '0' : '1'}"><button class="btn">${u.must_change_password ? 'Unexpire password' : 'Expire password'}</button></form>` : ''}
            <form method="post" action="${BASE}/users/${u.id}/unlock">${csrf(s)}<button class="btn"${fails ? '' : raw(' disabled')}>Unlock sign-in</button></form>
          </div>
          <form method="post" action="${BASE}/users/${u.id}/password" class="danger-zone">${csrf(s)}
            <div class="form-grid">${input('password', u.password_hash ? 'New password' : 'Set a password', '', { type: 'password', auto: 'new-password', help: 'Ends the account’s sessions.' })}</div>
            <div class="field"><label class="check"><input type="checkbox" name="must_change" value="true" checked> Require change of password on first use</label></div>
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
                  <td data-label="Roles"><form method="post" action="${BASE}/users/${u.id}/access/${a.app_id}" class="search roles-form u-m0 u-mwnone">${csrf(s)}
                    <input name="roles" value="${a.roles.join(', ')}" aria-label="Roles in ${a.name}" placeholder="no roles (e.g. ${(hints.get(a.app_id) ?? []).slice(0, 2).map((h) => h.role).join(', ') || 'admin'})"><button class="btn">Save</button>
                    ${roleHintsHtml(hints.get(a.app_id) ?? [])}</form></td>
                  <td data-label=""><form method="post" action="${BASE}/users/${u.id}/access/${a.app_id}/revoke">${csrf(s)}<button class="link-button" data-confirm="Revoke access to ${a.name}?">Revoke</button></form></td>
                </tr>`)
              : html`<tr><td colspan="3" class="empty">No access to any application yet.</td></tr>`}
          </tbody></table></div>
          ${apps.rows.length
            ? html`<h3>Grant access</h3>
              <form method="post" action="${BASE}/users/${u.id}/access">${csrf(s)}
                <div class="form-grid">
                  ${select('app_id', 'Application', '', apps.rows.map((a): [string, string] => [String(a.id), a.name]))}
                  <div class="field"><label class="label" for="f_roles">Roles</label>
                    <input id="f_roles" name="roles" placeholder="comma separated, or pick below">
                    ${apps.rows.map((a) => html`<div data-hints-for="${a.id}">${roleHintsHtml(hints.get(a.id) ?? [], `${a.name} checks`)}</div>`)}
                  </div>
                </div>
                <div class="buttons"><button class="btn btn-hot">Grant access</button></div>
              </form>`
            : ''}`)}
      </div>`;
    return send(reply, s, shell(s, u.username, [['Users', `${BASE}/users`], [u.username]], main, 'users'));
  });

  app.post(`${BASE}/users/:id(^\\d+$)`, async (req: Req, reply) => {
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

  app.post(`${BASE}/users/:id(^\\d+$)/password`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = req.body ?? {};
    try {
      if (b.remove === '1') await owner.query('update meta.account set password_hash = null where id = $1', [req.params.id]);
      else {
        const acc = await owner.one('select username from meta.account where id = $1', [req.params.id]);
        const problem = await passwordProblem(b.password, { username: acc?.username });
        if (problem) throw new Error(problem);
        await owner.query('select meta.set_password($1, $2, $3)', [acc?.username, b.password, b.must_change === 'true']);
      }
      await endSessions(req.params.id);
      flash(s, b.remove === '1' ? 'Password removed.' : 'Password set.');
    } catch (e) {
      flash(s, (e as Error).message, 'error');
    }
    return back(reply, s, `${BASE}/users/${req.params.id}`);
  });

  app.post(`${BASE}/users/:id(^\\d+$)/expire`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const acc = await owner.one('select username from meta.account where id = $1', [req.params.id]);
    if (acc) await owner.query(req.body?.expire === '1' ? 'select meta.expire_password($1)' : 'select meta.unexpire_password($1)', [acc.username]);
    flash(s, req.body?.expire === '1' ? 'Password expired: it must be changed at the next sign-in.' : 'Password no longer expired.');
    return back(reply, s, `${BASE}/users/${req.params.id}`);
  });

  app.post(`${BASE}/users/:id(^\\d+$)/unlock`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const acc = await owner.one('select username from meta.account where id = $1', [req.params.id]);
    if (acc) await owner.query(`insert into meta.activity_log (username, event, detail) values ($1, 'login_unlocked', $2)`, [acc.username, `by ${s.username}`]);
    flash(s, 'Sign-in unlocked.');
    return back(reply, s, `${BASE}/users/${req.params.id}`);
  });

  app.post(`${BASE}/users/:id(^\\d+$)/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    await endSessions(req.params.id);
    await owner.query('delete from meta.account where id = $1', [req.params.id]);
    flash(s, 'Account deleted.');
    return back(reply, s, `${BASE}/users`);
  });

  app.post(`${BASE}/users/:id(^\\d+$)/access`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    await grantAccess(req.body?.app_id ?? '', req.params.id, splitRoles(req.body?.roles));
    flash(s, 'Access granted.');
    return back(reply, s, `${BASE}/users/${req.params.id}`);
  });

  app.post(`${BASE}/users/:id(^\\d+$)/access/:appId`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    await grantAccess(req.params.appId, req.params.id, splitRoles(req.body?.roles));
    flash(s, 'Roles saved. The user gets them at the next sign-in.');
    return back(reply, s, `${BASE}/users/${req.params.id}`);
  });

  app.post(`${BASE}/users/:id(^\\d+$)/access/:appId/revoke`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    await owner.query('delete from meta.app_access where account_id = $1 and app_id = $2', [req.params.id, req.params.appId]);
    await endSessions(req.params.id, req.params.appId);
    flash(s, 'Access revoked.');
    return back(reply, s, `${BASE}/users/${req.params.id}`);
  });

  // ---------------------------------------------------------------- identity providers (OpenID Connect)
  const providerForm = (pr: any, action: string, csrfField: ReturnType<typeof csrf>, isNew: boolean) => html`
    <form method="post" action="${action}">${csrfField}
      <div class="form-grid">
        ${isNew ? input('name', 'Name (in URLs)', '', { required: true, help: 'lowercase, e.g. entra, google, keycloak' }) : ''}
        ${isNew ? select('protocol', 'Protocol', 'oidc', [['oidc', 'OpenID Connect'], ['saml', 'SAML 2.0']]) : html`<div class="field"><span class="label">Protocol</span><span>${pr.protocol === 'saml' ? 'SAML 2.0' : 'OpenID Connect'}</span></div>`}
        ${input('display_name', 'Button label', pr.display_name, { required: true, help: 'Shown as "Sign in with …"' })}
        ${input('issuer', 'Issuer (OIDC: URL; SAML: the IdP entity ID)', pr.issuer, { required: true, help: 'e.g. https://login.microsoftonline.com/<tenant>/v2.0, https://keycloak.example.com/realms/acme, or for SAML the entityID of the IdP metadata' })}
        ${input('client_id', 'Client ID (SAML: pgapex\'s entity ID)', pr.client_id, { help: 'OIDC: required. SAML: empty = the metadata URL of this provider.' })}
        ${input('idp_sso_url', 'SAML: IdP sign-in URL', pr.idp_sso_url, { type: 'url', help: 'The SingleSignOnService location (HTTP-Redirect binding) from the IdP metadata.' })}
        <div class="field" data-wide><label class="label" for="f_idp_cert">SAML: IdP signing certificate (PEM)</label>
          <textarea id="f_idp_cert" name="idp_cert" rows="4" placeholder="-----BEGIN CERTIFICATE-----">${pr.idp_cert ?? ''}</textarea>
          <small class="help">From the IdP metadata (X509Certificate, wrapped in BEGIN/END CERTIFICATE lines). Assertions must be signed with it.</small></div>
        ${input('client_secret', 'Client secret', '', { type: 'password', auto: 'new-password', help: pr.has_secret ? 'A secret is stored. Leave empty to keep it.' : 'Leave empty for a public client (PKCE only).' })}
        ${input('scopes', 'Scopes', pr.scopes ?? 'openid profile email')}
        ${input('username_claim', 'Username claim', pr.username_claim ?? 'preferred_username', { help: 'Use a claim users cannot change themselves (e.g. preferred_username, upn, email). SAML: an attribute name, or nameID.' })}
        ${input('groups_claim', 'Groups claim', pr.groups_claim ?? 'groups', { help: 'Dot paths work, e.g. realm_access.roles' })}
      </div>
      <div class="field u-mt075"><label class="check"><input type="checkbox" name="auto_create" value="true"${pr.auto_create ? raw(' checked') : ''}> Create accounts automatically on first sign-in</label>
        <small class="help">Otherwise only people with an account linked to this provider (or allowed below) can sign in.</small></div>
      <div class="field"><label class="check"><input type="checkbox" name="link_existing" value="true"${pr.link_existing ? raw(' checked') : ''}> Link existing accounts with the same username on their first sign-in</label>
        <small class="help">Only when users can't choose the username claim themselves at this provider: otherwise someone could register the name of an existing account and take it over. With the e-mail claim, only verified addresses link. Turn it off once the accounts are linked.</small></div>
      <div class="field"><label class="check"><input type="checkbox" name="enabled" value="true"${pr.enabled !== false ? raw(' checked') : ''}> Enabled</label></div>
      ${!isNew && pr.has_secret ? html`<div class="field"><label class="check"><input type="checkbox" name="remove_secret" value="true"> Remove the stored client secret</label></div>` : ''}
      <div class="buttons"><button class="btn btn-hot">${isNew ? 'Add provider' : 'Save'}</button></div>
    </form>`;

  /** A PEM certificate: the base64 body alone (as in IdP metadata) gets its BEGIN/END lines. */
  const pem = (v: string | undefined) => {
    const t = (v ?? '').trim();
    if (!t) return null;
    if (t.includes('BEGIN CERTIFICATE')) return t;
    return `-----BEGIN CERTIFICATE-----\n${t.replace(/\s+/g, '').replace(/(.{64})/g, '$1\n').trim()}\n-----END CERTIFICATE-----`;
  };
  const protocolOf = (v: string | undefined) => (v === 'saml' ? 'saml' : 'oidc');
  const providerValues = (b: Record<string, string | undefined>, protocol: string, name: string) => [
    b.display_name?.trim(), protocol === 'saml' ? b.issuer?.trim() : b.issuer?.trim().replace(/\/+$/, ''),
    b.client_id?.trim() || (protocol === 'saml' ? `${publicUrl()}/sso/saml/${name}/metadata` : ''),
    b.scopes?.trim() || 'openid profile email', b.username_claim?.trim() || 'preferred_username', b.groups_claim?.trim() || 'groups',
    b.auto_create === 'true', b.enabled === 'true',
    protocol === 'saml' ? b.idp_sso_url?.trim() || null : null, protocol === 'saml' ? pem(b.idp_cert) : null,
    b.link_existing === 'true',
  ];

  app.get(`${BASE}/users/providers`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const rows = (await owner.query(`select id, name, display_name, issuer, enabled, auto_create, link_existing,
        (select count(*) from meta.account_identity i where i.provider_id = p.id)::int as linked,
        (select string_agg(a.alias, ', ' order by a.alias) from meta.app a where p.name = any(a.sso_providers)) as apps
      from meta.auth_provider p order by display_name`)).rows;
    const main = html`
      <div class="title-row"><h1>Identity providers</h1></div>
      <p class="muted u-mt0">OpenID Connect providers for single sign-on (Microsoft Entra ID, Google, Okta, Keycloak, Auth0, …). Register pgapex at the provider as a web application with the redirect URI shown, then enable the provider per application under <b>Settings → Sign-in methods</b>.</p>
      <div class="columns wide-left">
        ${region('Providers', html`<div class="table-wrap"><table class="report report-reflow">
          <thead><tr><th>Provider</th><th>Issuer</th><th>Used by</th><th>Linked accounts</th><th>Status</th></tr></thead>
          <tbody>${rows.length ? rows.map((r) => html`<tr>
            <td data-label="Provider"><a href="${BASE}/users/providers/${r.id}">${r.display_name}</a> <span class="muted">${r.name}</span></td>
            <td data-label="Issuer">${r.issuer}</td>
            <td data-label="Used by">${r.apps ?? html`<span class="muted">no apps</span>`}</td>
            <td data-label="Linked accounts">${r.linked}</td>
            <td data-label="Status">${r.enabled ? 'enabled' : html`<b>disabled</b>`}${r.auto_create ? ' · auto-create' : ''}${r.link_existing ? ' · links existing accounts' : ''}</td>
          </tr>`) : html`<tr><td colspan="5" class="empty">No identity providers yet.</td></tr>`}</tbody></table></div>`)}
        ${region('Add provider', providerForm({}, `${BASE}/users/providers`, csrf(s), true))}
      </div>`;
    return send(reply, s, shell(s, 'Identity providers', [['Users', `${BASE}/users`], ['Identity providers']], main, 'users'));
  });

  app.post(`${BASE}/users/providers`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = req.body ?? {};
    try {
      const r = await owner.one(
        `insert into meta.auth_provider (name, display_name, issuer, client_id, scopes, username_claim, groups_claim, auto_create, enabled, idp_sso_url, idp_cert, link_existing, protocol, client_secret)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning id`,
        [b.name?.trim().toLowerCase(), ...providerValues(b, protocolOf(b.protocol), b.name?.trim().toLowerCase() ?? ''), protocolOf(b.protocol), b.client_secret || null],
      );
      flash(s, 'Provider added. Register the redirect URI at the provider, then test the connection.');
      return back(reply, s, `${BASE}/users/providers/${r.id}`);
    } catch (e) {
      flash(s, (e as Error).message, 'error');
      return back(reply, s, `${BASE}/users/providers`);
    }
  });

  app.get(`${BASE}/users/providers/:id`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const pr = await owner.one('select *, client_secret is not null as has_secret from meta.auth_provider where id = $1', [req.params.id]);
    if (!pr) return reply.code(404).send('Not found');
    delete pr.client_secret; // never sent to the browser
    const main = html`
      <div class="title-row"><h1>${pr.display_name}</h1></div>
      <div class="columns wide-left">
        ${region('Settings', html`${providerForm(pr, `${BASE}/users/providers/${pr.id}`, csrf(s), false)}
          <form method="post" action="${BASE}/users/providers/${pr.id}/delete" class="danger-zone">${csrf(s)}
            <button class="btn btn-danger" data-confirm="Delete ${pr.display_name}? Linked identities are removed; accounts stay.">Delete provider</button></form>`)}
        ${pr.protocol === 'saml' ? region('Register at the identity provider', html`
          <p>Service provider metadata (import it at the IdP):</p>
          <p><a href="${metadataUrl(pr)}"><code>${metadataUrl(pr)}</code></a></p>
          <p>Or by hand: entity ID <code>${spEntityId(pr)}</code>, assertion consumer service (HTTP-POST) <code>${acsUrl(pr)}</code>.</p>
          <p class="muted">Based on <code>PUBLIC_URL</code>. Sign the assertions; send the groups in the <code>${pr.groups_claim}</code> attribute to map them to roles.</p>`) : region('Register at the provider', html`
          <p>Redirect URI (callback):</p>
          <p><code>${redirectUri(pr)}</code></p>
          <p class="muted">Based on <code>PUBLIC_URL</code>; set it to the address users see (e.g. https://apps.example.com).</p>
          <p>Grant type: <b>authorization code</b> with PKCE. Scopes: <code>${pr.scopes}</code>. Include a <code>${pr.groups_claim}</code> claim in the ID token to map groups to roles.</p>
          <form method="post" action="${BASE}/users/providers/${pr.id}/test">${csrf(s)}<button class="btn">Test discovery</button></form>`)}
      </div>`;
    return send(reply, s, shell(s, pr.display_name, [['Users', `${BASE}/users`], ['Identity providers', `${BASE}/users/providers`], [pr.display_name]], main, 'users'));
  });

  app.post(`${BASE}/users/providers/:id`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = req.body ?? {};
    const current = /^\d+$/.test(req.params.id) ? await owner.one('select name, protocol from meta.auth_provider where id = $1', [req.params.id]) : undefined;
    if (!current) return reply.code(404).send('Not found');
    try {
      await owner.query(
        `update meta.auth_provider set display_name = $2, issuer = $3, client_id = $4, scopes = $5, username_claim = $6,
                groups_claim = $7, auto_create = $8, enabled = $9, idp_sso_url = $10, idp_cert = $11, link_existing = $12,
                client_secret = case when $14 then null when $13::text is null then client_secret else $13 end
          where id = $1`,
        [req.params.id, ...providerValues(b, current.protocol, current.name), b.client_secret || null, b.remove_secret === 'true'],
      );
      flash(s, 'Provider saved.');
    } catch (e) {
      flash(s, (e as Error).message, 'error');
    }
    return back(reply, s, `${BASE}/users/providers/${req.params.id}`);
  });

  app.post(`${BASE}/users/providers/:id/test`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const pr = await owner.one('select issuer from meta.auth_provider where id = $1', [req.params.id]);
    try {
      const doc = await discover(pr.issuer);
      flash(s, `Discovery works. Authorization endpoint: ${doc.authorization_endpoint}`);
    } catch (e) {
      flash(s, `Discovery failed: ${(e as Error).message}`, 'error');
    }
    return back(reply, s, `${BASE}/users/providers/${req.params.id}`);
  });

  app.post(`${BASE}/users/providers/:id/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    await owner.query('delete from meta.auth_provider where id = $1', [req.params.id]);
    flash(s, 'Provider deleted.');
    return back(reply, s, `${BASE}/users/providers`);
  });
}
