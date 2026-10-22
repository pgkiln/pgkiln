import { tr, translatorFor, type BuilderTranslate } from './i18n.ts';
import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { appAllowed } from './workspaces.ts';
import { html, raw } from '../html.ts';
import { accountSettings, clearAccountSettings, passwordProblem } from '../accounts.ts';
import { accountCodesLeft, accountFactors, resetAccountFactors } from '../account-mfa.ts';
import { icon } from '../icons.ts';
import { clientIp, logActivity } from '../session.ts';
import { loginMaxFailuresPerUser, loginWindowMinutes } from '../security.ts';
import { acsUrl, metadataUrl, spEntityId } from '../saml.ts';
import { discover, publicUrl, redirectUri } from '../sso.ts';
import { builderSignInRegion } from './builder-sso.ts';
import { administrator, back, BASE, csrf, developer, flash, input, region, select, send, shell, type Req } from './ui.ts';

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
export function roleHintsHtml(hints: RoleHint[], label?: string, tx: BuilderTranslate = translatorFor('en')) {
  if (!hints.length)
    return html`<small class="help role-hints">${tx.rich('us.hints_none', { fn: html`<code>meta.has_role()</code>` })}</small>`;
  return html`<small class="help role-hints">${label ?? tx('us.hints_label')}: ${hints.map(
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
    const tx = tr(s);
    const q = (req.query.q ?? '').trim();
    const users = (
      await owner.query(
        `select a.*, coalesce((select jsonb_agg(jsonb_build_object('alias', p.alias, 'roles', aa.roles) order by p.alias)
                                 from meta.app_access aa join meta.app p on p.id = aa.app_id where aa.account_id = a.id), '[]') as apps,
                exists (select 1 from meta.account_factor f where f.account_id = a.id) as mfa
           from meta.account a
          where $1 = '' or a.username ilike '%' || $1 || '%' or a.display_name ilike '%' || $1 || '%' or a.email ilike '%' || $1 || '%'
          order by lower(a.username)
          limit 500`,
        [q],
      )
    ).rows;
    const cfg = await accountSettings();
    const main = html`
      <div class="title-row"><h1>${tx('us.title')}</h1><div class="buttons"><a class="btn" href="${BASE}/users/providers">${tx('us.providers_btn')}</a> <a class="btn" href="${BASE}/users/directories">${tx('us.ldap_btn')}</a></div></div>
      <p class="muted u-mt0">${tx.rich('us.intro', { where: html`<b>${tx('us.access_path')}</b>` })}</p>
      <div class="columns wide-left">
        ${region(tx('us.accounts'), html`
          <form method="get" class="search u-mb075 u-mwnone" role="search">
            <input type="search" name="q" value="${q}" placeholder="${tx('us.search_ph')}" aria-label="${tx('us.search_label')}"><button class="btn">${tx('us.search')}</button>
          </form>
          <div class="table-wrap"><table class="report report-reflow">
            <thead><tr><th>${tx('us.username')}</th><th>${tx('us.name')}</th><th>${tx('us.apps_roles')}</th><th>${tx('us.signin')}</th><th>${tx('mfa.column')}</th><th>${tx('us.status')}</th></tr></thead>
            <tbody>${users.length
              ? users.map((u) => html`<tr>
                  <td data-label="${tx('us.username')}"><a href="${BASE}/users/${u.id}">${u.username}</a></td>
                  <td data-label="${tx('us.name')}">${u.display_name ?? ''}${u.email ? html`<div class="muted">${u.email}</div>` : ''}</td>
                  <td data-label="${tx('us.applications')}">${u.apps.length ? u.apps.map((x: any) => html`<span class="chip">${x.alias}${x.roles.length ? `: ${x.roles.join(', ')}` : ''}</span> `) : html`<span class="muted">${tx('us.none')}</span>`}</td>
                  <td data-label="${tx('us.signin')}">${u.password_hash ? tx('us.password') : html`<span class="muted">${tx('us.no_password')}</span>`}</td>
                  <td data-label="${tx('mfa.column')}">${u.mfa ? html`${icon('lock')} ${tx('mfa.on')}` : html`<span class="muted">${tx('mfa.off')}</span>`}</td>
                  <td data-label="${tx('us.status')}">${u.active ? tx('us.active') : html`<b>${tx('us.inactive')}</b>`}${u.last_login_at ? html`<div class="muted">${tx('us.last', { at: String(u.last_login_at).slice(0, 16) })}</div>` : ''}</td>
                </tr>`)
              : html`<tr><td colspan="6" class="empty">${tx('us.no_accounts')}</td></tr>`}</tbody>
          </table></div>`)}
        ${region(tx('us.create'), html`
          <form method="post" action="${BASE}/users">${csrf(s)}
            ${input('username', tx('us.username'), '', { required: true, help: tx('us.username_help') })}
            ${input('display_name', tx('us.name'), '')}
            ${input('email', tx('us.email'), '', { type: 'email' })}
            ${input('password', tx('us.password_label'), '', { type: 'password', auto: 'new-password', help: tx('us.password_help') })}
            <div class="field"><label class="check"><input type="checkbox" name="must_change" value="true" checked> ${tx('us.must_change')}</label></div>
            <div class="buttons"><button class="btn btn-hot">${tx('us.create')}</button></div>
          </form>`)}
        ${region(tx('us.settings'), html`
          <form method="post" action="${BASE}/users/settings">${csrf(s)}
            <div class="form-grid">
              ${input('password_min_length', tx('us.min_length'), cfg.minLength, { type: 'number' })}
              ${input('password_lifetime_days', tx('us.lifetime'), cfg.lifetimeDays, { type: 'number', help: tx('us.lifetime_help') })}
            </div>
            <div class="field"><label class="check"><input type="checkbox" name="password_require_mixed" value="true"${cfg.requireMixed ? raw(' checked') : ''}> ${tx('us.mixed')}</label></div>
            <p class="muted">${tx('us.policy_note', { minutes: loginWindowMinutes(), failures: loginMaxFailuresPerUser() })}</p>
            <div class="buttons"><button class="btn">${tx('us.save_settings')}</button></div>
          </form>`, '', 'account-settings')}
      </div>`;
    return send(reply, s, shell(s, tx('us.title'), [['Users']], main, 'users'));
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
      flash(s, tr(s)('us.created'));
      return back(reply, s, `${BASE}/users/${r.id}`);
    } catch (e) {
      flash(s, /account_username_key/.test((e as Error).message) ? tr(s)('us.exists') : (e as Error).message, 'error');
      return back(reply, s, `${BASE}/users`);
    }
  });

  app.post(`${BASE}/users/settings`, async (req: Req, reply) => {
    const s = await administrator(req, reply, 'Password policy');
    if (!s) return;
    const b = req.body ?? {};
    const n = (v: string | undefined, min: number, max: number) => String(Math.min(max, Math.max(min, Math.round(Number(v) || 0))));
    await owner.query(
      `insert into meta.setting (name, value) values ('password_min_length', $1), ('password_lifetime_days', $2), ('password_require_mixed', $3)
       on conflict (name) do update set value = excluded.value`,
      [n(b.password_min_length, 6, 128), n(b.password_lifetime_days, 0, 3650), b.password_require_mixed === 'true' ? 'true' : 'false'],
    );
    clearAccountSettings();
    flash(s, tr(s)('us.settings_saved'));
    return back(reply, s, `${BASE}/users`);
  });

  // ---------------------------------------------------------------- one account
  app.get(`${BASE}/users/:id(^\\d+$)`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const tx = tr(s);
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
    const [factors, codes] = await Promise.all([accountFactors(u.id), accountCodesLeft(u.id)]);
    const main = html`
      <div class="title-row"><h1>${u.username}</h1></div>
      <div class="columns">
        ${region(tx('us.details'), html`
          <form method="post" action="${BASE}/users/${u.id}">${csrf(s)}
            <div class="form-grid">
              ${input('display_name', tx('us.name'), u.display_name)}
              ${input('email', tx('us.email'), u.email, { type: 'email' })}
            </div>
            <div class="field u-mt075"><label class="check"><input type="checkbox" name="active" value="true"${u.active ? raw(' checked') : ''}> ${tx('us.active_label')}</label>
              <small class="help">${tx('us.active_help')}</small></div>
            <div class="buttons"><button class="btn btn-hot">${tx('us.save')}</button></div>
          </form>
          <h3>${tx('us.password_title')}</h3>
          <ul class="checklist">
            <li>${u.password_hash ? (u.password_changed_at ? tx('us.set_on', { date: String(u.password_changed_at).slice(0, 10) }) : tx('us.set')) : tx('us.sso_only')}</li>
            ${u.must_change_password ? html`<li><b>${tx('us.must_next')}</b></li>` : u.days_left !== null ? html`<li>${tx('us.expires', { n: u.days_left })}</li>` : ''}
            ${fails ? html`<li>${tx('us.fails', { n: fails })}</li>` : ''}
          </ul>
          <div class="buttons">
            ${u.password_hash ? html`<form method="post" action="${BASE}/users/${u.id}/expire">${csrf(s)}<input type="hidden" name="expire" value="${u.must_change_password ? '0' : '1'}"><button class="btn">${u.must_change_password ? tx('us.unexpire') : tx('us.expire')}</button></form>` : ''}
            <form method="post" action="${BASE}/users/${u.id}/unlock">${csrf(s)}<button class="btn"${fails ? '' : raw(' disabled')}>${tx('us.unlock')}</button></form>
          </div>
          <form method="post" action="${BASE}/users/${u.id}/password" class="danger-zone">${csrf(s)}
            <div class="form-grid">${input('password', u.password_hash ? tx('us.new_password') : tx('us.set_password_label'), '', { type: 'password', auto: 'new-password', help: tx('us.ends_sessions') })}</div>
            <div class="field"><label class="check"><input type="checkbox" name="must_change" value="true" checked> ${tx('us.must_change')}</label></div>
            <div class="buttons"><button class="btn">${tx('us.set_password')}</button>
              ${u.password_hash ? html`<button class="btn" name="remove" value="1" data-confirm="${tx('us.remove_confirm')}">${tx('us.remove_password')}</button>` : ''}</div>
          </form>
          <h3 id="two-factor">${tx('us.mfa_title')}</h3>
          <p>${factors.length ? tx('us.mfa_status', { n: factors.length, codes }) : tx('us.mfa_none')}</p>
          ${factors.length
            ? html`<form method="post" action="${BASE}/users/${u.id}/reset-2fa" class="danger-zone">${csrf(s)}
                <div class="form-grid">${input('reason', tx('mfa.reason'), '', { required: true, help: tx('us.mfa_reset_help', { user: u.username }) })}</div>
                <div class="buttons"><button class="btn btn-danger">${tx('mfa.reset_btn')}</button></div></form>`
            : ''}
          <form method="post" action="${BASE}/users/${u.id}/delete" class="danger-zone">${csrf(s)}
            <button class="btn btn-danger" data-confirm="${tx('us.delete_confirm', { user: u.username })}">${tx('us.delete')}</button>
          </form>`)}
        ${region(tx('us.app_access'), html`
          <div class="table-wrap"><table class="report report-reflow"><thead><tr><th>${tx('us.application')}</th><th>${tx('us.roles')}</th><th></th></tr></thead><tbody>
            ${access.rows.length
              ? access.rows.map((a) => html`<tr>
                  <td data-label="${tx('us.application')}"><a href="${BASE}/apps/${a.app_id}/shared">${a.name}</a> <span class="muted">/a/${a.alias}</span></td>
                  <td data-label="${tx('us.roles')}"><form method="post" action="${BASE}/users/${u.id}/access/${a.app_id}" class="search roles-form u-m0 u-mwnone">${csrf(s)}
                    <input name="roles" value="${a.roles.join(', ')}" aria-label="${tx('us.roles_in', { app: a.name })}" placeholder="${tx('us.roles_ph', { example: (hints.get(a.app_id) ?? []).slice(0, 2).map((h) => h.role).join(', ') || 'admin' })}"><button class="btn">${tx('us.save')}</button>
                    ${roleHintsHtml(hints.get(a.app_id) ?? [], undefined, tx)}</form></td>
                  <td data-label=""><form method="post" action="${BASE}/users/${u.id}/access/${a.app_id}/revoke">${csrf(s)}<button class="link-button" data-confirm="${tx('us.revoke_confirm', { app: a.name })}">${tx('us.revoke')}</button></form></td>
                </tr>`)
              : html`<tr><td colspan="3" class="empty">${tx('us.no_access')}</td></tr>`}
          </tbody></table></div>
          ${apps.rows.length
            ? html`<h3>${tx('us.grant')}</h3>
              <form method="post" action="${BASE}/users/${u.id}/access">${csrf(s)}
                <div class="form-grid">
                  ${select('app_id', tx('us.application'), '', apps.rows.map((a): [string, string] => [String(a.id), a.name]))}
                  <div class="field"><label class="label" for="f_roles">${tx('us.roles')}</label>
                    <input id="f_roles" name="roles" placeholder="${tx('us.roles_comma')}">
                    ${apps.rows.map((a) => html`<div data-hints-for="${a.id}">${roleHintsHtml(hints.get(a.id) ?? [], tx('us.hints_app', { app: a.name }), tx)}</div>`)}
                  </div>
                </div>
                <div class="buttons"><button class="btn btn-hot">${tx('us.grant')}</button></div>
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
    flash(s, tr(s)('us.saved'));
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
      flash(s, tr(s)(b.remove === '1' ? 'us.pw_removed' : 'us.pw_set'));
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
    flash(s, tr(s)(req.body?.expire === '1' ? 'us.pw_expired' : 'us.pw_unexpired'));
    return back(reply, s, `${BASE}/users/${req.params.id}`);
  });

  app.post(`${BASE}/users/:id(^\\d+$)/unlock`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const acc = await owner.one('select username from meta.account where id = $1', [req.params.id]);
    if (acc) await owner.query(`insert into meta.activity_log (username, event, detail) values ($1, 'login_unlocked', $2)`, [acc.username, `by ${s.username}`]);
    flash(s, tr(s)('us.unlocked'));
    return back(reply, s, `${BASE}/users/${req.params.id}`);
  });

  // (sprint 130, SEC-3) remove an account's authenticator apps and recovery codes (a lost phone), with a reason
  app.post(`${BASE}/users/:id(^\\d+$)/reset-2fa`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const tx = tr(s);
    const reason = String(req.body?.reason ?? '').trim().slice(0, 200);
    const acc = await owner.one<{ id: number; username: string }>('select id, username from meta.account where id = $1', [req.params.id]);
    if (!acc) return reply.code(404).send('Not found');
    if (!reason) {
      flash(s, tx('us.mfa_reason_needed'), 'error');
      return back(reply, s, `${BASE}/users/${acc.id}#two-factor`);
    }
    await resetAccountFactors(acc.id);
    await logActivity({ username: acc.username, event: '2fa_reset', ip: clientIp(req), detail: `by ${s.username}: ${reason}` });
    flash(s, tx('us.mfa_reset_done', { user: acc.username }));
    return back(reply, s, `${BASE}/users/${acc.id}`);
  });

  app.post(`${BASE}/users/:id(^\\d+$)/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    await endSessions(req.params.id);
    await owner.query('delete from meta.account where id = $1', [req.params.id]);
    flash(s, tr(s)('us.deleted'));
    return back(reply, s, `${BASE}/users`);
  });

  app.post(`${BASE}/users/:id(^\\d+$)/access`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    // only applications of the developer's workspaces (workspaces.ts)
    if (!/^\d{1,9}$/.test(String(req.body?.app_id ?? '')) || !(await appAllowed(s, req.body?.app_id ?? ''))) return reply.code(404).send('Not found');
    await grantAccess(req.body?.app_id ?? '', req.params.id, splitRoles(req.body?.roles));
    flash(s, tr(s)('us.granted'));
    return back(reply, s, `${BASE}/users/${req.params.id}`);
  });

  app.post(`${BASE}/users/:id(^\\d+$)/access/:appId`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    // only applications of the developer's workspaces (workspaces.ts)
    if (!/^\d{1,9}$/.test(String(req.params.appId)) || !(await appAllowed(s, req.params.appId))) return reply.code(404).send('Not found');
    await grantAccess(req.params.appId, req.params.id, splitRoles(req.body?.roles));
    flash(s, tr(s)('us.roles_saved'));
    return back(reply, s, `${BASE}/users/${req.params.id}`);
  });

  app.post(`${BASE}/users/:id(^\\d+$)/access/:appId/revoke`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    // only applications of the developer's workspaces (workspaces.ts)
    if (!/^\d{1,9}$/.test(String(req.params.appId)) || !(await appAllowed(s, req.params.appId))) return reply.code(404).send('Not found');
    await owner.query('delete from meta.app_access where account_id = $1 and app_id = $2', [req.params.id, req.params.appId]);
    await endSessions(req.params.id, req.params.appId);
    flash(s, tr(s)('us.revoked'));
    return back(reply, s, `${BASE}/users/${req.params.id}`);
  });

  // ---------------------------------------------------------------- identity providers (OpenID Connect)
  const providerForm = (pr: any, action: string, csrfField: ReturnType<typeof csrf>, isNew: boolean, tx: BuilderTranslate) => html`
    <form method="post" action="${action}">${csrfField}
      <div class="form-grid">
        ${isNew ? input('name', tx('idp.name'), '', { required: true, help: tx('idp.name_help') }) : ''}
        ${isNew ? select('protocol', tx('idp.protocol'), 'oidc', [['oidc', 'OpenID Connect'], ['saml', 'SAML 2.0']]) : html`<div class="field"><span class="label">${tx('idp.protocol')}</span><span>${pr.protocol === 'saml' ? 'SAML 2.0' : 'OpenID Connect'}</span></div>`}
        ${input('display_name', tx('idp.label'), pr.display_name, { required: true, help: tx('idp.label_help') })}
        ${input('issuer', tx('idp.issuer'), pr.issuer, { required: true, help: tx('idp.issuer_help') })}
        ${input('client_id', tx('idp.client_id'), pr.client_id, { help: tx('idp.client_id_help') })}
        ${input('idp_sso_url', tx('idp.sso_url'), pr.idp_sso_url, { type: 'url', help: tx('idp.sso_url_help') })}
        <div class="field" data-wide><label class="label" for="f_idp_cert">${tx('idp.cert')}</label>
          <textarea id="f_idp_cert" name="idp_cert" rows="4" placeholder="-----BEGIN CERTIFICATE-----">${pr.idp_cert ?? ''}</textarea>
          <small class="help">${tx('idp.cert_help')}</small></div>
        ${input('client_secret', tx('idp.secret'), '', { type: 'password', auto: 'new-password', help: pr.has_secret ? tx('idp.secret_kept') : tx('idp.secret_public') })}
        ${input('scopes', tx('idp.scopes'), pr.scopes ?? 'openid profile email')}
        ${input('username_claim', tx('idp.username_claim'), pr.username_claim ?? 'preferred_username', { help: tx('idp.username_claim_help') })}
        ${input('groups_claim', tx('idp.groups_claim'), pr.groups_claim ?? 'groups', { help: tx('idp.groups_claim_help') })}
      </div>
      <div class="field u-mt075"><label class="check"><input type="checkbox" name="auto_create" value="true"${pr.auto_create ? raw(' checked') : ''}> ${tx('idp.auto_create')}</label>
        <small class="help">${tx('idp.auto_create_help')}</small></div>
      <div class="field"><label class="check"><input type="checkbox" name="link_existing" value="true"${pr.link_existing ? raw(' checked') : ''}> ${tx('idp.link')}</label>
        <small class="help">${tx('idp.link_help')}</small></div>
      <div class="field"><label class="check"><input type="checkbox" name="enabled" value="true"${pr.enabled !== false ? raw(' checked') : ''}> ${tx('idp.enabled')}</label></div>
      ${!isNew && pr.has_secret ? html`<div class="field"><label class="check"><input type="checkbox" name="remove_secret" value="true"> ${tx('idp.remove_secret')}</label></div>` : ''}
      <div class="buttons"><button class="btn btn-hot">${isNew ? tx('idp.add') : tx('us.save')}</button></div>
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
    const s = await administrator(req, reply, 'Identity providers');
    if (!s) return;
    const tx = tr(s);
    const rows = (await owner.query(`select id, name, display_name, issuer, enabled, auto_create, link_existing,
        (select count(*) from meta.account_identity i where i.provider_id = p.id)::int as linked,
        (select string_agg(a.alias, ', ' order by a.alias) from meta.app a where p.name = any(a.sso_providers)) as apps
      from meta.auth_provider p order by display_name`)).rows;
    const main = html`
      <div class="title-row"><h1>${tx('idp.title')}</h1></div>
      <p class="muted u-mt0">${tx.rich('idp.intro', { where: html`<b>${tx('idp.where')}</b>` })}</p>
      <div class="columns wide-left">
        ${region(tx('idp.providers'), html`<div class="table-wrap"><table class="report report-reflow">
          <thead><tr><th>${tx('idp.provider')}</th><th>${tx('idp.issuer_col')}</th><th>${tx('idp.used_by')}</th><th>${tx('idp.linked')}</th><th>${tx('us.status')}</th></tr></thead>
          <tbody>${rows.length ? rows.map((r) => html`<tr>
            <td data-label="${tx('idp.provider')}"><a href="${BASE}/users/providers/${r.id}">${r.display_name}</a> <span class="muted">${r.name}</span></td>
            <td data-label="${tx('idp.issuer_col')}">${r.issuer}</td>
            <td data-label="${tx('idp.used_by')}">${r.apps ?? html`<span class="muted">${tx('idp.no_apps')}</span>`}</td>
            <td data-label="${tx('idp.linked')}">${r.linked}</td>
            <td data-label="${tx('us.status')}">${r.enabled ? tx('idp.enabled_s') : html`<b>${tx('idp.disabled_s')}</b>`}${r.auto_create ? ` · ${tx('idp.auto_s')}` : ''}${r.link_existing ? ` · ${tx('idp.links_s')}` : ''}</td>
          </tr>`) : html`<tr><td colspan="5" class="empty">${tx('idp.none')}</td></tr>`}</tbody></table></div>`)}
        ${region(tx('idp.add'), providerForm({}, `${BASE}/users/providers`, csrf(s), true, tx))}
      </div>`;
    return send(reply, s, shell(s, tx('idp.title'), [['Users', `${BASE}/users`], [tx('idp.title')]], main, 'users'));
  });

  app.post(`${BASE}/users/providers`, async (req: Req, reply) => {
    const s = await administrator(req, reply, 'Identity providers');
    if (!s) return;
    const b = req.body ?? {};
    try {
      const r = await owner.one(
        `insert into meta.auth_provider (name, display_name, issuer, client_id, scopes, username_claim, groups_claim, auto_create, enabled, idp_sso_url, idp_cert, link_existing, protocol, client_secret)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning id`,
        [b.name?.trim().toLowerCase(), ...providerValues(b, protocolOf(b.protocol), b.name?.trim().toLowerCase() ?? ''), protocolOf(b.protocol), b.client_secret || null],
      );
      flash(s, tr(s)('idp.added'));
      return back(reply, s, `${BASE}/users/providers/${r.id}`);
    } catch (e) {
      flash(s, (e as Error).message, 'error');
      return back(reply, s, `${BASE}/users/providers`);
    }
  });

  app.get(`${BASE}/users/providers/:id`, async (req: Req, reply) => {
    const s = await administrator(req, reply, 'Identity providers');
    if (!s) return;
    const tx = tr(s);
    const pr = await owner.one('select *, client_secret is not null as has_secret from meta.auth_provider where id = $1', [req.params.id]);
    if (!pr) return reply.code(404).send('Not found');
    delete pr.client_secret; // never sent to the browser
    const main = html`
      <div class="title-row"><h1>${pr.display_name}</h1></div>
      <div class="columns wide-left">
        ${region(tx('idp.settings'), html`${providerForm(pr, `${BASE}/users/providers/${pr.id}`, csrf(s), false, tx)}
          <form method="post" action="${BASE}/users/providers/${pr.id}/delete" class="danger-zone">${csrf(s)}
            <button class="btn btn-danger" data-confirm="${tx('idp.delete_confirm', { name: pr.display_name })}">${tx('idp.delete')}</button></form>`)}
        ${pr.protocol === 'saml' ? region(tx('idp.register_idp'), html`
          <p>${tx('idp.sp_metadata')}</p>
          <p><a href="${metadataUrl(pr)}"><code>${metadataUrl(pr)}</code></a></p>
          <p>${tx.rich('idp.by_hand', { entity: html`<code>${spEntityId(pr)}</code>`, acs: html`<code>${acsUrl(pr)}</code>` })}</p>
          <p class="muted">${tx.rich('idp.saml_note', { env: html`<code>PUBLIC_URL</code>`, claim: html`<code>${pr.groups_claim}</code>` })}</p>`) : region(tx('idp.register'), html`
          <p>${tx('idp.redirect')}</p>
          <p><code>${redirectUri(pr)}</code></p>
          <p class="muted">${tx.rich('idp.public_url', { env: html`<code>PUBLIC_URL</code>` })}</p>
          <p>${tx.rich('idp.grant', { type: html`<b>${tx('idp.auth_code')}</b>`, scopes: html`<code>${pr.scopes}</code>`, claim: html`<code>${pr.groups_claim}</code>` })}</p>
          <form method="post" action="${BASE}/users/providers/${pr.id}/test">${csrf(s)}<button class="btn">${tx('idp.test')}</button></form>`)}
        ${await builderSignInRegion(s, 'provider', pr)}
      </div>`;
    return send(reply, s, shell(s, pr.display_name, [['Users', `${BASE}/users`], [tx('idp.title'), `${BASE}/users/providers`], [pr.display_name]], main, 'users'));
  });

  app.post(`${BASE}/users/providers/:id`, async (req: Req, reply) => {
    const s = await administrator(req, reply, 'Identity providers');
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
      flash(s, tr(s)('idp.saved'));
    } catch (e) {
      flash(s, (e as Error).message, 'error');
    }
    return back(reply, s, `${BASE}/users/providers/${req.params.id}`);
  });

  app.post(`${BASE}/users/providers/:id/test`, async (req: Req, reply) => {
    const s = await administrator(req, reply, 'Identity providers');
    if (!s) return;
    const pr = await owner.one('select issuer from meta.auth_provider where id = $1', [req.params.id]);
    try {
      const doc = await discover(pr.issuer);
      flash(s, tr(s)('idp.works', { url: doc.authorization_endpoint }));
    } catch (e) {
      flash(s, tr(s)('idp.failed', { error: (e as Error).message }), 'error');
    }
    return back(reply, s, `${BASE}/users/providers/${req.params.id}`);
  });

  app.post(`${BASE}/users/providers/:id/delete`, async (req: Req, reply) => {
    const s = await administrator(req, reply, 'Identity providers');
    if (!s) return;
    await owner.query('delete from meta.auth_provider where id = $1', [req.params.id]);
    flash(s, tr(s)('idp.deleted'));
    return back(reply, s, `${BASE}/users/providers`);
  });
}
