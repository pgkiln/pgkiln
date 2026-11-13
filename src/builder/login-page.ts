import type { FastifyInstance } from 'fastify';
import { owner, type Client } from '../db.ts';
import { APP_MFA, EMAIL_CODE_MINUTES, EMAIL_CODES_PER_HOUR, type AppMfa } from '../account-mfa.ts';
import { html, raw } from '../html.ts';
import { secretKeyConfigured } from '../secrets.ts';
import { back, BASE, developer, flash, type Req } from './ui.ts';
import { scopedTx as tx } from './i18n.ts';

// Application settings → Sign-in methods (migration 087): the application's
// own login page (APEX: the login page, usually 9999) and "Forgot password?".
// "Create login page" adds a minimal public page with a login region and
// makes it the login page. (sprint 130, SEC-3) Two-factor sign-in for the
// application's users: off, optional, required, or required for some roles. (sprint 131) A code by e-mail.

interface AppRow {
  id: number;
  name: string;
  authentication: string;
  local_login: boolean;
  login_page: number | null;
  password_reset: boolean;
  mfa: AppMfa;
  mfa_roles: string[];
  mfa_email: boolean;
}

/** The fields in the settings form: the sign-in page, and two-factor sign-in (each placed by the settings page). */
export async function loginSettingsFields(a: AppRow) {
  // (NX-U2) only pages that can be the sign-in page: public, with a Login region; the current choice stays listed
  const pages = (await owner.query<{ page_no: number; name: string; requires_auth: boolean; login: boolean }>(
    `select p.page_no, p.name, p.requires_auth, exists (select 1 from meta.region r where r.page_id = p.id and r.type = 'login') as login
       from meta.page p where p.app_id = $1 order by p.page_no`, [a.id],
  )).rows;
  const usable = (p: { requires_auth: boolean; login: boolean }) => !p.requires_auth && p.login;
  const left = pages.filter((p) => !usable(p) && String(p.page_no) !== String(a.login_page ?? '')).length;
  const mail = await owner.one<{ service: string | null; enabled: boolean | null; from_address: string | null }>(
    `select s.name as service, s.enabled, ams.from_address
       from meta.app_mail_service ams join meta.mail_service s on s.id = ams.service_id where ams.app_id = $1`, [a.id],
  );
  const mailOk = !!(mail?.enabled && mail.from_address?.trim());
  const noMail = html`<strong>${tx('lgp.not_offered_yet')}</strong> the application needs an enabled mail service with a From address (Workspace utilities → Mail services).`;
  const opt = (v: string, label: string, cur: string) => html`<option value="${v}"${v === cur ? raw(' selected') : ''}>${label}</option>`;
  const current = a.login_page ? String(a.login_page) : '';
  const page = html`<div class="form-grid">
      <div class="field"><label class="label" for="f_login_page">${tx('lgp.login_page')}</label>
        <select id="f_login_page" name="login_page">${opt('', tx('lgp.the_built_in_sign_in'), current)}${pages.filter((p) => usable(p) || String(p.page_no) === current).map((p) =>
          opt(String(p.page_no), p.requires_auth ? tx('lgp.requires_signin', { page: `${p.page_no} ${p.name}` }) : !p.login ? tx('lgp.no_login_region', { page: `${p.page_no} ${p.name}` }) : `${p.page_no} ${p.name}`, current))}</select>
        <small class="help">${left ? html`${tx(left === 1 ? 'lgp.left_out_one' : 'lgp.left_out', { n: left })} ` : ''}${tx.rich('lgp.page_help', { login: html`<em>${tx('lgp.login')}</em>`, minimal: html`<em>${tx('lgp.minimal')}</em>` })}
          <button class="link-button" formaction="${BASE}/apps/${a.id}/login-page">${tx('lgp.create_a_login_page')}</button></small></div>
    </div>
    <div class="field"><label class="check"><input type="checkbox" name="password_reset" value="true"${a.password_reset ? raw(' checked') : ''}> ${tx('lgp.offer_forgot_password')}</label>
      <small class="help">${tx('lgp.reset_help')}
        ${mailOk ? tx('lgp.sent_through', { service: mail!.service, from: mail!.from_address ?? '' }) : noMail}</small></div>`;
  const twoFactor = html`<div class="form-grid">
      <div class="field"><label class="label" for="f_mfa">${tx('lgp.second_step')}</label>
        <select id="f_mfa" name="mfa" aria-describedby="f_mfa_help">${(APP_MFA as string[]).map((m) => opt(m, MFA_LABELS()[m as AppMfa], a.mfa))}</select>
        <small class="help" id="f_mfa_help">${tx.rich('lgp.mfa_help', { account: html`<em>${tx('lgp.my_account')}</em>` })}
          ${secretKeyConfigured() ? '' : tx.rich('lgp.needs_key', { na: html`<strong>${tx('lgp.not_available_yet')}</strong>`, key: html`<code>PGKILN_SECRET_KEY</code>` })}</small></div>
      <div class="field"><label class="label" for="f_mfa_roles">${tx('lgp.required_for_roles')}</label>
        <input id="f_mfa_roles" name="mfa_roles" value="${(a.mfa_roles ?? []).join(', ')}" placeholder="${tx('lgp.admin_manager')}" aria-describedby="f_mfa_roles_help">
        <small class="help" id="f_mfa_roles_help">${tx.rich('lgp.roles_help', { some: html`<em>${tx('lgp.required_for_some_roles')}</em>` })}</small></div>
    </div>
    <div class="field"><label class="check"><input type="checkbox" name="mfa_email" value="true"${a.mfa_email ? raw(' checked') : ''}> ${tx('lgp.offer_a_code_by_e')}</label>
      <small class="help">${tx('lgp.email_help', { minutes: EMAIL_CODE_MINUTES, per_hour: EMAIL_CODES_PER_HOUR })}
        ${mailOk ? '' : noMail}</small></div>
    <p class="muted small">${tx.rich('lgp.passkeys_note', { mfa: html`<em>${tx('lgp.multi_factor_sign_in')}</em>`, within: html`<em>${tx('lgp.second_step_within_minutes')}</em>` })}</p>`;
  return { page, twoFactor };
}

const MFA_LABELS = (): Record<AppMfa, string> => ({ off: tx('lgp.off'), optional: tx('lgp.optional_users_may_add_an'), required: tx('lgp.required'), roles: tx('lgp.required_for_some_roles') });

/** Save them (with the rest of the settings form). */
export async function saveLoginSettings(appId: string, b: Record<string, string | undefined>) {
  const page = b.login_page?.trim() ? Number(b.login_page) : null;
  if (page !== null && !(await owner.one('select 1 from meta.page where app_id = $1 and page_no = $2', [appId, page]))) throw new Error(tx('lgp.no_page', { n: String(b.login_page) }));
  const mfa = (APP_MFA as string[]).includes(b.mfa ?? '') ? (b.mfa as AppMfa) : 'off';
  const roles = [...new Set((b.mfa_roles ?? '').split(',').map((r) => r.trim().toLowerCase()).filter(Boolean))];
  if (roles.some((r) => r.length > 100)) throw new Error(tx('lgp.two_factor_sign_in_a'));
  if (mfa === 'roles' && !roles.length) throw new Error(tx('lgp.two_factor_sign_in_name'));
  // without the instance key, users could not add an app: requiring one would lock them out
  if ((mfa === 'required' || mfa === 'roles') && !secretKeyConfigured()) throw new Error(tx('lgp.two_factor_sign_in_the'));
  await owner.query('update meta.app set login_page = $2, password_reset = $3, mfa = $4, mfa_roles = $5, mfa_email = $6 where id = $1',
    [appId, page, b.password_reset === 'true', mfa, roles, b.mfa_email === 'true']);
}

/** Page 9999 (or the next free number), public, minimal, with a login region, made the login page. (137) Also Add feature → Login page. */
export async function createLoginPage(c: Client, a: { id: number; name: string }) {
  const n = (await c.query<{ n: number }>(
    `select case when not exists (select 1 from meta.page where app_id = $1 and page_no = 9999) then 9999
                 else (select max(page_no) + 1 from meta.page where app_id = $1) end as n`, [a.id],
  )).rows[0].n;
  const id = (await c.query<{ id: number }>(
    `insert into meta.page (app_id, page_no, name, title, requires_auth, page_template) values ($1, $2, 'Login', $3, false, 'minimal') returning id`,
    [a.id, n, a.name],
  )).rows[0].id;
  await c.query(`insert into meta.region (page_id, seq, title, type, template) values ($1, 10, $2, 'login', 'standard')`, [id, a.name]);
  await c.query('update meta.app set login_page = $2, updated_at = now() where id = $1', [a.id, n]);
  return { page: id, no: n };
}

export async function loginPageRoutes(app: FastifyInstance) {
  // Create a login page: page 9999 (or the next free number), public, minimal, with a login region
  app.post(`${BASE}/apps/:id/login-page`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await owner.one<{ id: number; name: string }>('select id, name from meta.app where id = $1', [req.params.id]);
    if (!a) return reply.code(404).send('Not found');
    try {
      const { page, no } = await owner.tx((c) => createLoginPage(c, a));
      flash(s, tx('lgp.created', { n: no }));
      return back(reply, s, `${BASE}/pages/${page}`);
    } catch (e) {
      flash(s, (e as Error).message, 'error');
      return back(reply, s, `${BASE}/apps/${req.params.id}/settings`);
    }
  });
}
