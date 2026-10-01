import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { owner } from '../db.ts';
import { html, raw } from '../html.ts';
import { icon } from '../icons.ts';
import { pwaSection } from './pwa.ts';
import { documentShell } from '../layout.ts';
import { passwordProblem } from '../accounts.ts';
import { clientIp, createSession, destroySession, getSession, loginThrottled, logActivity, saveState, takeFlash } from '../session.ts';
import { ICON_OPTIONS } from './components.ts';
import { APP_COLORS, appHeader, back, BASE, builderHead, csrf, developer, flash, input, region, select, send, shell, THEME_COOKIE, validTheme, type Req } from './ui.ts';
import { appOr404 } from './forms.ts';
import { docToFiles, filesToZip } from '../appfiles.ts';
import { homeRoutes, rememberApp } from './home.ts';

// Builder pages: sign-in, workspace and app home, settings, activity and
// developers. Shared Components, the page designer and the SQL Workshop
// are in shared.ts, designer.ts and sql.ts.

export async function builderRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- login
  app.get(`${BASE}/login`, async (req: Req, reply) => {
    const s = await getSession(req, reply, null, BASE);
    if (s.username) return reply.redirect(BASE);
    const error = takeFlash(s, '__ERROR');
    await saveState(s);
    return reply.type('text/html').send(
      documentShell(
        'Sign in · Builder',
        html`<main class="login"><form method="post" class="card login-card">
          <h1>pgapex Builder</h1>
          ${error ? html`<div class="alert alert-error" role="alert">${error}</div>` : ''}
          ${csrf(s)}
          ${input('username', 'Username', '', { required: true, auto: 'username' })}
          ${input('password', 'Password', '', { type: 'password', required: true, auto: 'current-password' })}
          <button class="btn btn-hot">Sign in</button>
        </form></main>`,
        'login-body ide-login',
        {},
        builderHead(),
        { theme: validTheme(req.cookies?.[THEME_COOKIE]) ?? 'dark' },
      ),
    );
  });

  app.post(`${BASE}/login`, async (req: Req, reply) => {
    const s = await getSession(req, reply, null, BASE);
    const { username = '', password = '' } = req.body ?? {};
    const ip = clientIp(req);
    if (req.body?.__csrf !== s.csrf_token) {
      flash(s, 'Your session expired. Please try again.', 'error');
      return back(reply, s, `${BASE}/login`);
    }
    if (await loginThrottled(null, username, ip)) {
      logActivity({ username, event: 'login_locked', ip, detail: 'builder' });
      flash(s, 'Too many failed sign-in attempts. Try again later.', 'error');
      return back(reply, s, `${BASE}/login`);
    }
    // bcrypt always runs (dummy salt for unknown users) so timing does not reveal accounts
    const dev = await owner.one(
      `select d.username
         from (select $1::text as u) x
         left join meta.developer d on d.username = x.u
        where crypt($2, coalesce(d.password_hash, gen_salt('bf', 10))) = d.password_hash`,
      [username, password],
    );
    if (!dev) {
      await logActivity({ username: username.slice(0, 100), event: 'login_failed', ip, detail: 'builder' });
      flash(s, 'Invalid username or password.', 'error');
      return back(reply, s, `${BASE}/login`);
    }
    await destroySession(reply, s, BASE);
    const ns = await createSession(reply, null, BASE, dev.username);
    // the builder theme chosen earlier on this device
    const theme = validTheme(req.cookies?.[THEME_COOKIE]);
    if (theme) {
      ns.state.__BTHEME = theme;
      await saveState(ns);
    }
    logActivity({ username: dev.username, event: 'login', ip, detail: 'builder' });
    if (password === 'admin' || password === dev.username) {
      ns.state.__WEAK = '1';
      await saveState(ns);
    }
    return reply.redirect(BASE, 303);
  });

  app.post(`${BASE}/logout`, async (req: Req, reply) => {
    const s = await getSession(req, reply, null, BASE);
    if (req.body?.__csrf === s.csrf_token) await destroySession(reply, s, BASE);
    return reply.redirect(`${BASE}/login`, 303);
  });

  // The builder's light/dark theme (the developer's menu in the icon rail).
  app.post(`${BASE}/theme`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const theme = validTheme(req.body?.theme);
    if (!theme) return reply.code(400).send('Unknown theme');
    s.state.__BTHEME = theme;
    reply.setCookie(THEME_COOKIE, theme, { path: BASE, httpOnly: true, sameSite: 'lax', maxAge: 365 * 24 * 3600, secure: process.env.COOKIE_SECURE === 'true' });
    const ref = String(req.headers.referer ?? '');
    const back_to = (() => {
      try {
        const u = new URL(ref);
        return u.host === req.headers.host && u.pathname.startsWith(BASE) ? u.pathname + u.search : BASE;
      } catch {
        return BASE;
      }
    })();
    return back(reply, s, back_to);
  });

  // the workspace pages (App Builder home, Create, Import, Dashboard, Utilities) are in home.ts
  await homeRoutes(app);

  app.post(`${BASE}/apps`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = req.body ?? {};
    try {
      const alias = (b.alias ?? '').trim().toLowerCase();
      if (!/^[a-z][a-z0-9_-]*$/.test(alias)) throw new Error('The alias must start with a letter and contain only a-z, 0-9, _ and -.');
      let existingAccount = false;
      if (b.authentication !== 'none') {
        if (!b.admin_user?.trim()) throw new Error('Apps with a login page need a first user.');
        const known = await owner.one('select 1 from meta.account where lower(username) = lower($1)', [b.admin_user.trim()]);
        const problem = known ? null : await passwordProblem(b.admin_password);
        if (problem) throw new Error(problem);
      }
      const id = await owner.tx(async (c) => {
        const schema = b.schema?.trim() || alias.replace(/-/g, '_');
        const role = `app_${alias.replace(/-/g, '_')}`;
        const S = pg.escapeIdentifier(schema);
        const R = pg.escapeIdentifier(role);
        // The parsing schema: a role that can only use this schema.
        await c.query(`create schema if not exists ${S}`);
        if (!(await c.query('select 1 from pg_roles where rolname = $1', [role])).rowCount) await c.query(`create role ${R} nologin`);
        await c.query(`grant ${R} to pgapex_runtime`);
        await c.query(`grant usage on schema ${S} to ${R}`);
        await c.query(`grant select, insert, update, delete on all tables in schema ${S} to ${R}`);
        await c.query(`grant usage, select on all sequences in schema ${S} to ${R}`);
        await c.query(`grant execute on all functions in schema ${S} to ${R}`);
        await c.query(`alter default privileges in schema ${S} grant select, insert, update, delete on tables to ${R}`);
        await c.query(`alter default privileges in schema ${S} grant usage, select on sequences to ${R}`);
        await c.query(`alter default privileges in schema ${S} grant execute on functions to ${R}`);

        const a = await c.query('insert into meta.app (alias, name, authentication, db_role) values ($1, $2, $3, $4) returning id', [alias, b.name?.trim(), b.authentication ?? 'app_users', role]);
        const appId = a.rows[0].id;
        const p = await c.query(`insert into meta.page (app_id, page_no, name, title) values ($1, 1, 'Home', 'Home') returning id`, [appId]);
        await c.query(`insert into meta.region (page_id, title, type, source) values ($1, 'Welcome', 'static', '<p>Hello, &APP_USER.! Edit this page in the builder.</p>')`, [p.rows[0].id]);
        await c.query(`insert into meta.nav_entry (app_id, seq, label, icon, target_page) values ($1, 1, 'Home', 'home', 1)`, [appId]);
        await c.query(`insert into meta.authz_scheme (app_id, name, type, value, error_message) values ($1, 'ADMIN', 'role', 'admin', 'Only administrators can access this page.')`, [appId]);
        if (b.authentication !== 'none') {
          // an existing account just gets access; otherwise create it
          const existing = await c.query('select id from meta.account where lower(username) = lower($1)', [b.admin_user!.trim()]);
          const accountId = existing.rows[0]?.id
            ?? (await c.query('insert into meta.account (username, password_hash) values ($1, meta.hash_password($2)) returning id', [b.admin_user!.trim(), b.admin_password])).rows[0].id;
          await c.query(`insert into meta.app_access (app_id, account_id, roles) values ($1, $2, '{admin}')`, [appId, accountId]);
          existingAccount = !!existing.rowCount;
        }
        return appId;
      });
      flash(s, existingAccount
        ? `Application created. The existing account ${b.admin_user!.trim()} got the admin role (its password was not changed).`
        : 'Application created.');
      return back(reply, s, `${BASE}/apps/${id}`);
    } catch (e) {
      flash(s, (e as Error).message, 'error');
      return back(reply, s, `${BASE}/create`);
    }
  });

  app.post(`${BASE}/import`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    try {
      const doc = JSON.parse(req.body?.doc ?? '');
      const r = await owner.one('select meta.import_app($1::jsonb, $2) as id', [JSON.stringify(doc), req.body?.alias?.trim() || null]);
      flash(s, 'Application imported. Check its database role and users under Settings / Shared Components.');
      return back(reply, s, `${BASE}/apps/${r.id}`);
    } catch (e) {
      flash(s, `Import failed: ${(e as Error).message}`, 'error');
      return back(reply, s, `${BASE}/import`);
    }
  });

  // ---------------------------------------------------------------- app home


  app.get(`${BASE}/apps/:id`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOr404(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    rememberApp(s, a.id);
    const [pages, tables] = await Promise.all([
      owner.query(
        `select p.*, (select count(*) from meta.region r where r.page_id = p.id)::int as regions,
                (select count(*) from meta.item i where i.page_id = p.id)::int as items,
                (select count(*) from meta.dynamic_action d where d.page_id = p.id)::int as das,
                (select count(*) from meta.process x where x.page_id = p.id)::int as processes
           from meta.page p where p.app_id = $1 order by p.page_no`,
        [a.id],
      ),
      owner.query(
        `select c.oid::regclass::text as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.relkind in ('r', 'p', 'v') and n.nspname !~ '^pg_' and n.nspname not in ('information_schema', 'meta')
          order by 1`,
      ),
    ]);
    const nextPage = Math.max(0, ...pages.rows.map((p) => p.page_no)) + 1;

    const main = html`
      ${appHeader(a, 'pages')}
      ${region('Pages', html`<div class="table-wrap"><table class="report">
          <thead><tr><th class="num">Page</th><th>Name</th><th>Mode</th><th class="num">Regions</th><th class="num">Items</th><th class="num">DAs</th><th class="num">Processes</th><th>Authorization</th><th>Protection</th><th></th></tr></thead>
          <tbody>${pages.rows.map((p) => html`<tr>
            <td class="num">${p.page_no}</td><td><a href="${BASE}/pages/${p.id}">${p.name}</a></td><td>${p.mode}</td>
            <td class="num">${p.regions}</td><td class="num">${p.items}</td><td class="num">${p.das}</td><td class="num">${p.processes}</td>
            <td>${p.requires_auth ? (p.authz ?? '—') : 'public'}</td><td>${p.protection}</td>
            <td><a href="/a/${a.alias}/${p.page_no}" target="_blank" rel="noopener">Run ▸</a></td></tr>`)}</tbody>
        </table></div>`)}
      <div class="columns">
        ${region('Create pages from a table', html`
          <p class="muted u-mt0">"Report and form" generates an interactive report and a modal form with create/update/delete; "Interactive grid" generates one editable grid page. Both add a menu entry.</p>
          <form method="post" action="${BASE}/apps/${a.id}/wizard">${csrf(s)}
            <div class="form-grid">
              ${select('kind', 'Page type', 'report_form', [['report_form', 'Report and form'], ['grid', 'Interactive grid']])}
              ${select('table', 'Table or view', '', tables.rows.map((t) => t.t))}
              ${input('label', 'Label', '', { placeholder: 'defaults to the table name' })}
              ${input('report_page', 'Page number', nextPage, { type: 'number', required: true })}
              ${input('form_page', 'Form page (report and form)', nextPage + 1, { type: 'number' })}
              ${select('icon', 'Menu icon', 'table', ICON_OPTIONS.filter(Boolean))}
            </div>
            <div class="buttons"><button class="btn btn-hot">Generate pages</button></div>
          </form>`)}
        ${region('Create blank page', html`
          <form method="post" action="${BASE}/apps/${a.id}/pages">${csrf(s)}
            <div class="form-grid">
              ${input('page_no', 'Page number', nextPage, { type: 'number', required: true })}
              ${input('name', 'Name', '', { required: true })}
              ${select('mode', 'Mode', 'normal', ['normal', 'modal'])}
              ${input('parent_page', 'Breadcrumb parent', a.home_page, { type: 'number' })}
            </div>
            <div class="buttons"><button class="btn btn-hot">Create page</button></div>
          </form>`)}
      </div>`;
    return send(reply, s, shell(s, a.name, [['App Builder', BASE], [a.name]], main));
  });

  app.post(`${BASE}/apps/:id/wizard`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = req.body ?? {};
    try {
      await owner.tx(async (c) => {
        const a = await c.query('select alias from meta.app where id = $1', [req.params.id]);
        if (b.kind === 'grid')
          await c.query('select meta.generate_grid($1, $2::regclass, $3, $4, $5)', [a.rows[0].alias, b.table, Number(b.report_page), b.label?.trim() || null, b.icon || 'grid']);
        else
          await c.query('select meta.generate_crud($1, $2::regclass, $3, $4, $5, $6)', [
            a.rows[0].alias, b.table, Number(b.report_page), Number(b.form_page), b.label?.trim() || null, b.icon || 'table',
          ]);
      });
      flash(s, b.kind === 'grid'
        ? `Grid page ${b.report_page} created for ${b.table}. Make sure the app's database role has privileges on it.`
        : `Pages ${b.report_page} and ${b.form_page} created for ${b.table}. Make sure the app's database role has privileges on it.`);
    } catch (e) {
      flash(s, (e as Error).message, 'error');
    }
    return back(reply, s, `${BASE}/apps/${req.params.id}`);
  });

  app.post(`${BASE}/apps/:id/pages`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = req.body ?? {};
    try {
      const p = await owner.one(
        'insert into meta.page (app_id, page_no, name, title, mode, parent_page) values ($1, $2, $3, $3, $4, $5) returning id',
        [req.params.id, Number(b.page_no), b.name?.trim(), b.mode === 'modal' ? 'modal' : 'normal', b.parent_page ? Number(b.parent_page) : null],
      );
      flash(s, 'Page created.');
      return back(reply, s, `${BASE}/pages/${p.id}`);
    } catch (e) {
      flash(s, (e as Error).message, 'error');
      return back(reply, s, `${BASE}/apps/${req.params.id}`);
    }
  });

  app.get(`${BASE}/apps/:id/export`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOr404(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const r = await owner.one('select meta.export_app($1) as doc', [a.alias]);
    // ?format=dir: one file per component, as `pgapex export --format dir` writes it (docs/guide/18-cli.md)
    if (req.query?.format === 'dir')
      return reply
        .header('content-disposition', `attachment; filename="${a.alias}.pgapex.zip"`)
        .type('application/zip')
        .send(Buffer.from(filesToZip(docToFiles(r.doc), a.alias)));
    return reply
      .header('content-disposition', `attachment; filename="${a.alias}.pgapex.json"`)
      .type('application/json')
      .send(JSON.stringify(r.doc, null, 2));
  });

  // ---------------------------------------------------------------- settings
  app.get(`${BASE}/apps/:id/settings`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOr404(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const providers = (await owner.query('select name, display_name, enabled from meta.auth_provider order by display_name')).rows;
    const directories = (await owner.query('select name, display_name, enabled from meta.ldap_directory order by display_name')).rows;
    const main = html`${appHeader(a, 'settings')}
      <div class="columns">
        ${region('Application settings', html`
          <form method="post" action="${BASE}/apps/${a.id}/settings">${csrf(s)}
            <div class="form-grid">
              ${input('name', 'Name', a.name, { required: true })}
              ${input('alias', 'Alias', a.alias, { required: true })}
              ${input('home_page', 'Home page', a.home_page, { type: 'number' })}
            </div>
            <h3>Security</h3>
            <div class="form-grid">
              ${select('authentication', 'Authentication', a.authentication, [['app_users', 'App users (login page)'], ['none', 'None (public)']])}
              ${input('db_role', 'Database role (parsing schema)', a.db_role, { help: 'All application SQL runs as this role (SET LOCAL ROLE), so grants and row level security apply. Leave empty only for trusted internal apps.' })}
              <div class="field"><span class="label" aria-hidden="true"></span><label class="check"><input type="checkbox" name="debug" value="true"${a.debug ? raw(' checked') : ''}> Debug mode</label>
                <small class="help">Shows database error details to end users. Development only.</small></div>
            </div>
            <h3>Sign-in methods</h3>
            <div class="field"><label class="check"><input type="checkbox" name="local_login" value="true"${a.local_login ? raw(' checked') : ''}> Username and password</label></div>
            ${directories.length
              ? directories.map((d) => html`<div class="field"><label class="check"><input type="checkbox" name="ldap_directories" value="${d.name}"${a.ldap_directories.includes(d.name) ? raw(' checked') : ''}> Passwords from LDAP: ${d.display_name}${d.enabled ? '' : ' (disabled)'}</label></div>`)
              : html`<p class="muted">No LDAP directories configured. <a href="${BASE}/users/directories">Add one</a> to check passwords against LDAP or Active Directory.</p>`}
            <small class="help">LDAP passwords are checked by the username and password form, after local accounts, so keep that method on.</small>
            <div class="form-grid">${input('remember_me_days', '"Keep me signed in" for (days)', a.remember_me_days ?? '', { type: 'number', placeholder: 'empty: not offered', help: 'Offers a checkbox on the sign-in form (APEX: persistent authentication). The browser stays signed in for this many days after the sign-in, also when the session ends; signing out, a new password, deactivation or removed access ends it. 1 to 365.' })}</div>
            ${providers.length
              ? providers.map((pr) => html`<div class="field"><label class="check"><input type="checkbox" name="sso_providers" value="${pr.name}"${a.sso_providers.includes(pr.name) ? raw(' checked') : ''}> Sign in with ${pr.display_name}${pr.enabled ? '' : ' (disabled)'}</label></div>`)
              : html`<p class="muted">No identity providers configured. <a href="${BASE}/users/providers">Add one</a> for single sign-on.</p>`}
            <h3>Theme</h3>
            <div class="form-grid">
              ${input('accent', 'Accent colour', a.theme?.accent ?? '#0b63c5', { type: 'color' })}
              ${input('header', 'Header colour', a.theme?.header ?? '#13294b', { type: 'color' })}
              ${select('nav', 'Navigation menu', a.theme?.nav ?? 'side', [['side', 'Side (collapsible)'], ['top', 'Top bar']], 'On tablets and phones the menu is always a drawer.')}
              ${select('mode', 'Theme style', a.theme?.mode ?? 'auto', [['auto', 'Automatic (light or dark, following the device)'], ['light', 'Light'], ['dark', 'Dark']])}
            </div>
            <div class="field"><label class="check"><input type="checkbox" name="user_choice" value="true"${a.theme?.user_choice !== false ? raw(' checked') : ''}> Users may choose light or dark</label>
              <small class="help">Adds a switch to the user menu and My account; the choice is saved on the account (APEX: "Enable End Users to Choose Theme Style").</small></div>
            <h3>Globalization</h3>
            <div class="form-grid">
              ${input('language', 'Primary language', a.language, { help: 'The language the app is built in, e.g. en, nl, de, en-GB.' })}
              ${input('languages', 'Translated languages', (a.languages ?? []).join(', '), { placeholder: 'e.g. nl, de', help: 'Comma separated. Translate texts under Shared Components → Globalization.' })}
              ${select('language_from', 'Language derived from', a.language_from, [['browser', 'Browser (Accept-Language)'], ['user', 'User preference, then browser'], ['primary', 'Always the primary language']], 'Users can also switch with ?lang=xx or the picker on the login page.')}
              ${input('date_format', 'Date format', a.date_format, { placeholder: 'e.g. DD-MM-YYYY (empty: per language)', help: 'Masks: YYYY YY MM MON MONTH DD DY DAY HH24 HH MI SS AM' })}
              ${input('timestamp_format', 'Date and time format', a.timestamp_format, { placeholder: 'e.g. DD-MM-YYYY HH24:MI' })}
            </div>
            <div class="buttons"><button class="btn btn-hot">Save settings</button></div>
          </form>
          <form method="post" action="${BASE}/apps/${a.id}/delete" class="danger-zone">${csrf(s)}
            <button class="btn btn-danger" data-confirm="Delete application ${a.name} and all its pages?">Delete application</button>
          </form>`)}
        ${region('Progressive Web App', pwaSection({ ...a, has_icon: !!(await owner.one('select pwa_icon is not null as h from meta.app where id = $1', [a.id]))?.h }, s))}
        ${region('Security checklist', html`<ul class="checklist">
          <li>${a.db_role ? '✓' : '✗'} Runs as a dedicated database role ${a.db_role ? html`(<code>${a.db_role}</code>)` : html`<b>(runs as the runtime connection)</b>`}</li>
          <li>${a.authentication !== 'none' ? '✓' : '•'} ${a.authentication !== 'none' ? 'Users must sign in' : 'Public application'}</li>
          ${a.authentication !== 'none' ? html`<li>Sign-in: ${[a.local_login ? 'password' : '', ...a.ldap_directories.map((d: string) => `LDAP ${d}`), ...a.sso_providers].filter(Boolean).join(', ') || html`<b>no method enabled</b>`}; access: ${a.access_control === 'any_user' ? 'any active account' : 'listed accounts only'}</li>` : ''}
          <li>${a.debug ? '✗ Debug mode is on: error details are shown to users' : '✓ Debug mode is off'}</li>
          <li>Pages without checksum protection: ${(await owner.one("select count(*)::int as n from meta.page where app_id = $1 and protection = 'unrestricted'", [a.id])).n}</li>
          <li>Public pages: ${(await owner.one('select count(*)::int as n from meta.page where app_id = $1 and not requires_auth', [a.id])).n}</li>
        </ul>`)}
      </div>`;
    return send(reply, s, shell(s, `${a.name} settings`, [['App Builder', BASE], [a.name, `${BASE}/apps/${a.id}`], ['Settings']], main));
  });

  app.post(`${BASE}/apps/:id/settings`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = req.body ?? {};
    try {
      await owner.query(
        `update meta.app set name = $2, alias = $3, home_page = $4, authentication = $5, db_role = $6, debug = $7, theme = $8,
                local_login = $9, sso_providers = $10, language = $11, languages = $12, language_from = $13,
                date_format = $14, timestamp_format = $15, remember_me_days = $16, ldap_directories = $17, updated_at = now() where id = $1`,
        [req.params.id, b.name?.trim(), b.alias?.trim().toLowerCase(), Number(b.home_page) || 1, b.authentication, b.db_role?.trim() || null, b.debug === 'true',
         JSON.stringify({
           accent: /^#[0-9a-f]{6}$/i.test(b.accent ?? '') ? b.accent : undefined,
           header: /^#[0-9a-f]{6}$/i.test(b.header ?? '') ? b.header : undefined,
           nav: b.nav === 'top' ? 'top' : 'side',
           mode: ['light', 'dark'].includes(b.mode ?? '') ? b.mode : 'auto',
           user_choice: b.user_choice === 'true',
         }),
         b.local_login === 'true',
         ([] as string[]).concat((b.sso_providers as unknown as string | string[] | undefined) ?? []).filter(Boolean),
         b.language?.trim().toLowerCase() || 'en',
         [...new Set((b.languages ?? '').split(',').map((l) => l.trim().toLowerCase()).filter((l) => /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(l) && l !== (b.language?.trim().toLowerCase() || 'en')))],
         ['primary', 'user'].includes(b.language_from ?? '') ? b.language_from : 'browser',
         b.date_format?.trim() || null,
         b.timestamp_format?.trim() || null,
         Number.isInteger(Number(b.remember_me_days)) && Number(b.remember_me_days) >= 1 && Number(b.remember_me_days) <= 365 ? Number(b.remember_me_days) : null,
         ([] as string[]).concat((b.ldap_directories as unknown as string | string[] | undefined) ?? []).filter(Boolean)],
      );
      flash(s, 'Settings saved.');
    } catch (e) {
      flash(s, (e as Error).message, 'error');
    }
    return back(reply, s, `${BASE}/apps/${req.params.id}/settings`);
  });

  app.post(`${BASE}/apps/:id/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    await owner.query('delete from meta.app where id = $1', [req.params.id]);
    flash(s, 'Application deleted.');
    return back(reply, s, BASE);
  });

  // ---------------------------------------------------------------- activity
  app.get(`${BASE}/apps/:id/activity`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOr404(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const [stats, byPage, events] = await Promise.all([
      owner.one(
        `select count(*) filter (where event = 'page_view')::int as views,
                count(distinct username) filter (where event = 'page_view')::int as users,
                coalesce(round(avg(elapsed_ms) filter (where event = 'page_view')), 0)::int as avg_ms,
                count(*) filter (where event in ('login_failed', 'login_locked'))::int as failures,
                count(*) filter (where event in ('forbidden', 'error'))::int as problems
           from meta.activity_log where app_id = $1 and at > now() - interval '1 day'`,
        [a.id],
      ),
      owner.query(
        `select l.page_no, p.name, count(*)::int as views, round(avg(elapsed_ms))::int as avg_ms, max(elapsed_ms) as max_ms
           from meta.activity_log l left join meta.page p on p.app_id = l.app_id and p.page_no = l.page_no
          where l.app_id = $1 and l.event = 'page_view' and l.at > now() - interval '7 days'
          group by 1, 2 order by 3 desc`,
        [a.id],
      ),
      owner.query(
        `select id, at, event, username, page_no, ip, elapsed_ms, detail from meta.activity_log
          where app_id = $1 and (event <> 'page_view' or $2) order by id desc limit 100`,
        [a.id, req.query.all === '1'],
      ),
    ]);
    const main = html`${appHeader(a, 'activity')}
      <div class="stat-grid">
        <div class="stat"><b>${stats.views}</b><span>page views (24h)</span></div>
        <div class="stat"><b>${stats.users}</b><span>distinct users (24h)</span></div>
        <div class="stat"><b>${stats.avg_ms} ms</b><span>average page time</span></div>
        <div class="stat"><b>${stats.failures}</b><span>failed / locked sign-ins (24h)</span></div>
        <div class="stat"><b>${stats.problems}</b><span>errors / access denied (24h)</span></div>
      </div>
      <div class="columns">
        <p><a class="btn" href="${BASE}/apps/${a.id}/top-sql">${icon('database')} Top SQL</a> <span class="muted">the slowest statements of this application's database role</span></p>
        ${region('Page views by page (7 days)', html`<div class="table-wrap"><table class="report"><thead><tr><th class="num">Page</th><th>Name</th><th class="num">Views</th><th class="num">Avg ms</th><th class="num">Max ms</th></tr></thead>
          <tbody>${byPage.rows.map((r) => html`<tr><td class="num">${r.page_no}</td><td>${r.name}</td><td class="num">${r.views}</td><td class="num">${r.avg_ms}</td><td class="num">${r.max_ms}</td></tr>`)}</tbody></table></div>`)}
        ${region('Recent events', html`<p class="muted u-mt0">${req.query.all === '1' ? html`Showing all events. <a href="?">Hide page views</a>` : html`Sign-ins, denials and errors. <a href="?all=1">Include page views</a>`}</p>
          <div class="table-wrap"><table class="report"><thead><tr><th>When</th><th>Event</th><th>User</th><th class="num">Page</th><th>IP</th><th>Detail</th></tr></thead>
          <tbody>${events.rows.map((r) => html`<tr><td>${String(r.at).slice(0, 19)}</td><td><span class="ev ev-${r.event}">${r.event}</span></td><td>${r.username}</td><td class="num">${r.page_no}</td><td>${r.ip}</td><td title="${r.detail}">${r.detail}</td></tr>`)}</tbody></table></div>`)}
      </div>`;
    return send(reply, s, shell(s, 'Activity', [['App Builder', BASE], [a.name, `${BASE}/apps/${a.id}`], ['Activity']], main));
  });

  // ---------------------------------------------------------------- developers
  app.get(`${BASE}/developers`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const devs = (await owner.query('select username from meta.developer order by 1')).rows;
    const main = html`<h1 class="u-mb1">Developers</h1>
      <div class="columns">
        ${region('Change your password', html`<form method="post" action="${BASE}/developers/password">${csrf(s)}
          <div class="form-grid">
            ${input('current', 'Current password', '', { type: 'password', required: true, auto: 'current-password' })}
            ${input('password', 'New password', '', { type: 'password', required: true, auto: 'new-password', help: 'At least 8 characters.' })}
          </div>
          <div class="buttons"><button class="btn btn-hot">Change password</button></div></form>`)}
        ${region('Developer accounts', html`
          <table class="report"><thead><tr><th>Username</th><th></th></tr></thead><tbody>
            ${devs.map((d) => html`<tr><td>${d.username}${d.username === s.username ? ' (you)' : ''}</td><td>${d.username === s.username ? '' : html`
              <form method="post" action="${BASE}/developers/delete">${csrf(s)}<input type="hidden" name="username" value="${d.username}"><button class="link-button" data-confirm="Remove developer ${d.username}?">Remove</button></form>`}</td></tr>`)}
          </tbody></table>
          <h3>Add developer</h3>
          <form method="post" action="${BASE}/developers">${csrf(s)}
            <div class="form-grid">${input('username', 'Username', '', { required: true })}${input('password', 'Password', '', { type: 'password', required: true, auto: 'new-password' })}</div>
            <div class="buttons"><button class="btn btn-hot">Add developer</button></div>
          </form>`)}
      </div>`;
    return send(reply, s, shell(s, 'Developers', [['Developers']], main, 'developers'));
  });

  app.post(`${BASE}/developers`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    try {
      const problem = await passwordProblem(req.body?.password);
      if (problem) throw new Error(problem);
      await owner.query('insert into meta.developer (username, password_hash) values ($1, meta.hash_password($2))', [req.body?.username?.trim(), req.body?.password]);
      flash(s, 'Developer added.');
    } catch (e) {
      flash(s, (e as Error).message, 'error');
    }
    return back(reply, s, `${BASE}/developers`);
  });

  app.post(`${BASE}/developers/password`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    try {
      const problem = await passwordProblem(req.body?.password);
      if (problem) throw new Error(problem);
      const r = await owner.query(
        `update meta.developer set password_hash = meta.hash_password($3)
          where username = $1 and password_hash = crypt($2, password_hash)`,
        [s.username, req.body?.current ?? '', req.body?.password],
      );
      if (r.rowCount !== 1) throw new Error('The current password is not correct.');
      // End all other builder sessions of this developer.
      await owner.query('delete from meta.session where app_id is null and username = $1 and id <> $2', [s.username, s.id]);
      delete s.state.__WEAK;
      flash(s, 'Password changed.');
    } catch (e) {
      flash(s, (e as Error).message, 'error');
    }
    return back(reply, s, `${BASE}/developers`);
  });

  app.post(`${BASE}/developers/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    if (req.body?.username && req.body.username !== s.username) {
      await owner.query('delete from meta.developer where username = $1', [req.body.username]);
      await owner.query('delete from meta.session where app_id is null and username = $1', [req.body.username]);
      flash(s, 'Developer removed.');
    }
    return back(reply, s, `${BASE}/developers`);
  });
}
