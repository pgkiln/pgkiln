import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { APP_MFA, type AppMfa } from '../account-mfa.ts';
import { html, raw } from '../html.ts';
import { secretKeyConfigured } from '../secrets.ts';
import { back, BASE, developer, flash, type Req } from './ui.ts';

// Application settings → Sign-in methods (migration 087): the application's
// own login page (APEX: the login page, usually 9999) and "Forgot password?".
// "Create login page" adds a minimal public page with a login region and
// makes it the login page. (sprint 130, SEC-3) Two-factor sign-in for the
// application's users: off, optional, required, or required for some roles.

interface AppRow {
  id: number;
  name: string;
  authentication: string;
  local_login: boolean;
  login_page: number | null;
  password_reset: boolean;
  mfa: AppMfa;
  mfa_roles: string[];
}

/** The fields in the settings form. */
export async function loginSettingsFields(a: AppRow) {
  const pages = (await owner.query<{ page_no: number; name: string; requires_auth: boolean }>(
    'select page_no, name, requires_auth from meta.page where app_id = $1 order by page_no', [a.id],
  )).rows;
  const mail = await owner.one<{ service: string | null; enabled: boolean | null; from_address: string | null }>(
    `select s.name as service, s.enabled, ams.from_address
       from meta.app_mail_service ams join meta.mail_service s on s.id = ams.service_id where ams.app_id = $1`, [a.id],
  );
  const mailOk = !!(mail?.enabled && mail.from_address?.trim());
  const opt = (v: string, label: string, cur: string) => html`<option value="${v}"${v === cur ? raw(' selected') : ''}>${label}</option>`;
  const current = a.login_page ? String(a.login_page) : '';
  return html`<div class="form-grid">
      <div class="field"><label class="label" for="f_login_page">Login page</label>
        <select id="f_login_page" name="login_page">${opt('', '- the built-in sign-in page -', current)}${pages.map((p) =>
          opt(String(p.page_no), `${p.page_no} ${p.name}${p.requires_auth ? ' (requires sign-in: not usable)' : ''}`, current))}</select>
        <small class="help">A page of the application with a <em>Login</em> region replaces the built-in sign-in page (APEX: the login page). It must not require authentication; with page template <em>Minimal</em> it has no header and navigation.
          <button class="link-button" formaction="${BASE}/apps/${a.id}/login-page">Create a login page</button></small></div>
      <div class="field"><span class="label" aria-hidden="true"></span><label class="check"><input type="checkbox" name="password_reset" value="true"${a.password_reset ? raw(' checked') : ''}> Offer "Forgot password?"</label>
        <small class="help">Users with a password and an e-mail address in the user directory get a link to choose a new password (single-use, valid for 30 minutes).
          ${mailOk
            ? html`Sent through mail service ${mail!.service} as ${mail!.from_address}.`
            : html`<strong>Not offered yet:</strong> the application needs an enabled mail service with a From address (Workspace utilities → Mail services).`}
          Only for the user directory's own passwords: not for LDAP, single sign-on, database accounts or custom authentication.</small></div>
    </div>
    <h3 id="two-factor">Two-factor sign-in</h3>
    <div class="form-grid">
      <div class="field"><label class="label" for="f_mfa">Second step</label>
        <select id="f_mfa" name="mfa" aria-describedby="f_mfa_help">${(APP_MFA as string[]).map((m) => opt(m, MFA_LABELS[m as AppMfa], a.mfa))}</select>
        <small class="help" id="f_mfa_help">After the password (or an LDAP directory), users give a code from an authenticator app or a recovery code. They add the app on <em>My account</em>, or while signing in when it is required. An identity provider asks for its own second factor. Accounts share their apps across applications.
          ${secretKeyConfigured() ? '' : html`<strong>Not available yet:</strong> the server needs <code>PGKILN_SECRET_KEY</code> to keep the apps' secrets.`}</small></div>
      <div class="field"><label class="label" for="f_mfa_roles">Required for roles</label>
        <input id="f_mfa_roles" name="mfa_roles" value="${(a.mfa_roles ?? []).join(', ')}" placeholder="admin, manager" aria-describedby="f_mfa_roles_help">
        <small class="help" id="f_mfa_roles_help">With <em>Required for some roles</em>: users with one of these roles must use it, others may.</small></div>
    </div>`;
}

const MFA_LABELS: Record<AppMfa, string> = { off: 'Off', optional: 'Optional (users may add an app)', required: 'Required', roles: 'Required for some roles' };

/** Save them (with the rest of the settings form). */
export async function saveLoginSettings(appId: string, b: Record<string, string | undefined>) {
  const page = b.login_page?.trim() ? Number(b.login_page) : null;
  if (page !== null && !(await owner.one('select 1 from meta.page where app_id = $1 and page_no = $2', [appId, page]))) throw new Error(`Login page: there is no page ${b.login_page}.`);
  const mfa = (APP_MFA as string[]).includes(b.mfa ?? '') ? (b.mfa as AppMfa) : 'off';
  const roles = [...new Set((b.mfa_roles ?? '').split(',').map((r) => r.trim().toLowerCase()).filter(Boolean))];
  if (roles.some((r) => r.length > 100)) throw new Error('Two-factor sign-in: a role name is too long.');
  if (mfa === 'roles' && !roles.length) throw new Error('Two-factor sign-in: name the roles that must use it.');
  // without the instance key, users could not add an app: requiring one would lock them out
  if ((mfa === 'required' || mfa === 'roles') && !secretKeyConfigured()) throw new Error('Two-factor sign-in: the server needs PGKILN_SECRET_KEY before it can be required.');
  await owner.query('update meta.app set login_page = $2, password_reset = $3, mfa = $4, mfa_roles = $5 where id = $1',
    [appId, page, b.password_reset === 'true', mfa, roles]);
}

export async function loginPageRoutes(app: FastifyInstance) {
  // Create a login page: page 9999 (or the next free number), public, minimal, with a login region
  app.post(`${BASE}/apps/:id/login-page`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await owner.one<{ id: number; name: string }>('select id, name from meta.app where id = $1', [req.params.id]);
    if (!a) return reply.code(404).send('Not found');
    try {
      const { page, no } = await owner.tx(async (c) => {
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
      });
      flash(s, `Page ${no} "Login" created and made the login page. Add regions around the sign-in form in the Page Designer.`);
      return back(reply, s, `${BASE}/pages/${page}`);
    } catch (e) {
      flash(s, (e as Error).message, 'error');
      return back(reply, s, `${BASE}/apps/${req.params.id}/settings`);
    }
  });
}
