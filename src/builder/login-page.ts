import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw } from '../html.ts';
import { back, BASE, developer, flash, type Req } from './ui.ts';

// Application settings → Sign-in methods (migration 087): the application's
// own login page (APEX: the login page, usually 9999) and "Forgot password?".
// "Create login page" adds a minimal public page with a login region and
// makes it the login page.

interface AppRow {
  id: number;
  name: string;
  authentication: string;
  local_login: boolean;
  login_page: number | null;
  password_reset: boolean;
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
    </div>`;
}

/** Save them (with the rest of the settings form). */
export async function saveLoginSettings(appId: string, b: Record<string, string | undefined>) {
  const page = b.login_page?.trim() ? Number(b.login_page) : null;
  if (page !== null && !(await owner.one('select 1 from meta.page where app_id = $1 and page_no = $2', [appId, page]))) throw new Error(`Login page: there is no page ${b.login_page}.`);
  await owner.query('update meta.app set login_page = $2, password_reset = $3 where id = $1', [appId, page, b.password_reset === 'true']);
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
