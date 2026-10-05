import { appLocks, isAdmin, lockPanel, lockText } from './locks.ts';
import { parseRoleList, validRoleName } from '../dbauth.ts';
import { DEFAULT_HEADER, headerProxiesConfigured } from '../headerauth.ts';
import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw } from '../html.ts';
import { icon } from '../icons.ts';
import { appStyles, BASE_STYLES, baseStyleOf } from '../runtime/styles.ts';
import { APP_TYPE_LABELS, APP_TYPES } from '../subscriptions.ts';
import { pwaSection } from './pwa.ts';
import { documentShell } from '../layout.ts';
import { passwordProblem } from '../accounts.ts';
import { clientIp, createSession, destroySession, getSession, loginThrottled, logActivity, saveState, takeFlash } from '../session.ts';
import { APP_COLORS, appHeader, back, BASE, builderHead, csrf, developer, flash, input, region, select, send, shell, THEME_COOKIE, validTheme, type Req } from './ui.ts';
import { appOr404 } from './forms.ts';
import { docToFiles, filesToZip } from '../appfiles.ts';
import { homeRoutes, rememberApp } from './home.ts';
import { appAllowed, currentWorkspace, placeApp, workspaceRoutes } from './workspaces.ts';
import { saveTimeZoneSettings, timeZoneSettings } from './globalization.ts';
import { WIZARD_KINDS, wizardRoutes, wizardTables } from './wizards.ts';
import { checkNewApp, createApp, createAppError, startFromBoilerplate } from './newapp.ts';
import { appFromFileRoutes } from './appfromfile.ts';

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
  await workspaceRoutes(app);
  await wizardRoutes(app);
  await appFromFileRoutes(app);

  app.post(`${BASE}/apps`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = req.body ?? {};
    try {
      const checked = await checkNewApp(b, currentWorkspace(s));
      const boilerplate = /^\d{1,9}$/.test(b.boilerplate ?? '') ? Number(b.boilerplate) : null;
      if (boilerplate && !(await appAllowed(s, boilerplate))) throw new Error('Choose a boilerplate application (an application of type Boilerplate).');
      const { id, existingAccount } = await owner.tx(async (c) => {
        const made = await createApp(c, checked);
        if (boilerplate) await startFromBoilerplate(c, made.id, checked, boilerplate);
        return made;
      }).catch((e) => {
        throw new Error(createAppError(e, checked.alias));
      });
      flash(s, existingAccount
        ? `Application created. The existing account ${checked.adminUser} got the admin role (its password was not changed).`
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
      const ws = currentWorkspace(s);
      if (ws < 1) throw new Error('you are not a developer of any workspace yet: ask an administrator to add you to one.');
      const doc = JSON.parse(req.body?.doc ?? '');
      const r = await owner.tx(async (c) => {
        const made = (await c.query('select meta.import_app($1::jsonb, $2) as id', [JSON.stringify(doc), req.body?.alias?.trim() || null])).rows[0];
        await placeApp(c, made.id, ws);
        return made;
      });
      // supporting objects are never run on import: the developer reviews them and chooses
      const scripts = (await owner.one('select count(*)::int as n from meta.supporting_script where app_id = $1', [r.id])).n;
      flash(s, `Application imported. Check its database role and users under Settings / Shared Components.${scripts ? ` It has ${scripts} supporting object script(s): they were not run.` : ''}`);
      return back(reply, s, scripts ? `${BASE}/apps/${r.id}/supporting-objects?imported=1` : `${BASE}/apps/${r.id}`);
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
      wizardTables(a.db_role),
    ]);
    const nextPage = Math.max(0, ...pages.rows.map((p) => p.page_no)) + 1;
    const locks = new Map((await appLocks(a.id)).map((l) => [l.page_no, l]));
    const commentsPerPage = new Map((await owner.query('select page_no, count(*)::int as n from meta.dev_comment where app_id = $1 group by 1', [a.id])).rows.map((r) => [r.page_no, r.n]));
    const appLock = locks.get(0);

    const main = html`
      ${appHeader(a, 'pages')}
      ${appLock && appLock.locked_by !== s.username ? html`<div class="alert alert-error" role="status">${icon('key')} ${lockText(appLock)} Changes are refused until it is unlocked.</div>` : ''}
      ${region('Pages', html`<div class="table-wrap"><table class="report">
          <thead><tr><th class="num">Page</th><th>Name</th><th>Mode</th><th class="num">Regions</th><th class="num">Items</th><th class="num">DAs</th><th class="num">Processes</th><th>Authorization</th><th>Protection</th><th>Lock</th><th></th></tr></thead>
          <tbody>${pages.rows.map((p) => html`<tr>
            <td class="num">${p.page_no}</td><td><a href="${BASE}/pages/${p.id}">${p.name}</a>${commentsPerPage.get(p.page_no) ? html` <span class="tag" title="Developer comments">${commentsPerPage.get(p.page_no)} comment${commentsPerPage.get(p.page_no) === 1 ? '' : 's'}</span>` : ''}</td><td>${p.mode}</td>
            <td class="num">${p.regions}</td><td class="num">${p.items}</td><td class="num">${p.das}</td><td class="num">${p.processes}</td>
            <td>${p.requires_auth ? (p.authz ?? '—') : 'public'}</td><td>${p.protection}</td>
            <td>${((l) => (l ? html`<span class="lock-tag" title="${lockText(l)}">${icon('key')}<span>${l.locked_by === s.username ? 'you' : l.locked_by}</span></span>` : '—'))(locks.get(p.page_no))}</td>
            <td><a href="/a/${a.alias}/${p.page_no}" target="_blank" rel="noopener">Run ▸</a></td></tr>`)}</tbody>
        </table></div>`)}
      ${region('Application lock and comments', await lockPanel(s, a.id, 0, { headings: true }))}
      <div class="columns">
        ${region('Create pages from a table', html`
          <p class="muted u-mt0">Choose a page type and a table or view; the next step proposes the columns, key, dates, positions and foreign keys from the database, and creates the page with a menu entry.</p>
          <form method="get" action="${BASE}/apps/${a.id}/wizard">
            <div class="form-grid">
              ${select('kind', 'Page type', 'report_form', WIZARD_KINDS.map(([k, label]): [string, string] => [k, label]))}
              ${select('table', 'Table or view (master table for master detail)', '', tables.map((t): [string, string] => [t.t, t.access ? t.t : `${t.t} (no access for ${a.db_role})`]))}
            </div>
            <div class="buttons"><button class="btn btn-hot">Next</button></div>
          </form>
          <p><a href="${BASE}/apps/${a.id}/ai-pages">Create pages with AI ▸</a> <span class="muted">(describe them in your own words)</span></p>`)}
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
    const lists = (await owner.query('select name from meta.list where app_id = $1 order by name', [a.id])).rows.map((r) => r.name as string);
    const listChoices = (v: string | null, none: string): [string, string][] => [['', none], ...lists.map((n): [string, string] => [n, n]), ...(v && !lists.includes(v) ? [[v, `${v} (missing!)`] as [string, string]] : [])];
    const main = html`${appHeader(a, 'settings')}
      <div class="columns">
        ${region('Application settings', html`
          <form method="post" action="${BASE}/apps/${a.id}/settings">${csrf(s)}
            <div class="form-grid">
              ${input('name', 'Name', a.name, { required: true })}
              ${input('alias', 'Alias', a.alias, { required: true })}
              ${input('home_page', 'Home page', a.home_page, { type: 'number' })}
              ${select('app_type', 'Application type', a.app_type ?? 'standard', APP_TYPES.map((t): [string, string] => [t, APP_TYPE_LABELS[t]]),
                'Theme and library applications offer their theme or shared components to other applications (Shared Components → Subscriptions); Create application can start from a boilerplate application.')}
            </div>
            <h3>Security</h3>
            <div class="form-grid">
              ${select('authentication', 'Authentication', a.authentication, [['app_users', 'App users (login page)'], ['header', 'HTTP header (reverse proxy)'], ['database', 'Database accounts (PostgreSQL roles)'], ['custom', 'Custom (a PL/pgSQL function)'], ['none', 'None (public)']])}
              ${input('db_role', 'Database role (parsing schema)', a.db_role, { help: 'All application SQL runs as this role (SET LOCAL ROLE), so grants and row level security apply. Leave empty only for trusted internal apps.' })}
              <div class="field"><span class="label" aria-hidden="true"></span><label class="check"><input type="checkbox" name="debug" value="true"${a.debug ? raw(' checked') : ''}> Debug mode</label>
                <small class="help">Shows database error details to end users. Development only.</small></div>
              <div class="field"><span class="label">Debug messages</span><span>${a.debug_level ? html`<b>on, level ${a.debug_level}</b>` : 'off'} · <a href="${BASE}/apps/${a.id}/debug">Debug messages</a></span>
                <small class="help">Records every request's steps with timings and the messages of <code>meta.debug(level, text)</code>, kept ${a.debug_retention_days} days.</small></div>
            </div>
            <h3>HTTP header authentication</h3>
            <p class="muted">Only used when Authentication is "HTTP header". A reverse proxy or single sign-on gateway signs users in and passes the user name in a header; pgapex trusts it only from the proxy addresses in <code>PGAPEX_AUTH_HEADER_PROXIES</code>${headerProxiesConfigured() ? '' : html` (<b>not set on this server: header sign-in is refused</b>)`}.</p>
            <div class="form-grid">
              ${input('header_name', 'User name header', a.header_name ?? '', { placeholder: DEFAULT_HEADER, help: 'The request header with the user name (APEX: HTTP Header Variable). Empty: X-Remote-User. A changed or missing header ends the session.' })}
              ${input('logout_url', 'Sign-out URL', a.logout_url ?? '', { placeholder: 'e.g. https://sso.example.com/logout', help: 'Where "Sign out" goes after the session ends, usually the proxy\'s own sign-out page. Empty: a "signed out" page.' })}
            </div>
            <div class="field"><label class="check"><input type="checkbox" name="header_auto_create" value="true"${a.header_auto_create ? raw(' checked') : ''}> Create accounts automatically</label>
              <small class="help">An unknown user name gets a new account with access to this app. Otherwise the account must exist and have access.</small></div>
            <h3>Database accounts</h3>
            <p class="muted">Only used when Authentication is "Database accounts". Users sign in with a PostgreSQL login role and its password, checked by a short connection to this database as that role. Superusers and pgapex's own roles are always refused; with neither field set nobody can sign in.</p>
            <div class="form-grid">
              ${input('db_auth_roles', 'Allowed roles', (a.db_auth_roles ?? []).join(', '), { placeholder: 'e.g. alice, bob', help: 'Login roles that may sign in, comma separated (exact names).' })}
              ${input('db_auth_member_of', 'Or members of role', a.db_auth_member_of ?? '', { placeholder: 'e.g. app_users_group', help: 'Every member of this role may sign in too.' })}
            </div>
            <h3>Custom authentication</h3>
            <p class="muted">Only used when Authentication is "Custom". Your own PL/pgSQL checks the user name and password on the sign-in form, as the application's database role; the password is passed as a parameter and never logged. Failed attempts are throttled like other sign-ins. With neither field set nobody can sign in.</p>
            <div class="form-grid">
              ${input('custom_auth_function', 'Function name', a.custom_auth_function ?? '', { placeholder: 'e.g. app.check_login', help: 'A function (p_username text, p_password text) returns boolean, in lower case, optionally with its schema. The app\'s role needs EXECUTE on it. Takes precedence over the body below.' })}
            </div>
            <div class="field" data-wide><label class="label" for="f_custom_auth_code">Or function body</label>
              <textarea id="f_custom_auth_code" name="custom_auth_code" class="code" rows="6" spellcheck="false" data-code="plpgsql">${a.custom_auth_code ?? ''}</textarea>
              <small class="help">PL/pgSQL with p_username and p_password, returning true for a valid sign-in, e.g. <code>return exists (select 1 from app.users where name = p_username and pw_hash = crypt(p_password, pw_hash));</code></small></div>
            <div class="field" data-wide><label class="label" for="f_custom_auth_post_code">Post-authentication code</label>
              <textarea id="f_custom_auth_post_code" name="custom_auth_post_code" class="code" rows="4" spellcheck="false" data-code="plpgsql">${a.custom_auth_post_code ?? ''}</textarea>
              <small class="help">Optional PL/pgSQL run after a successful check, with p_username (and meta.app_user()), e.g. to record the last sign-in. Raising an exception refuses the sign-in. Application processes "after login" run afterwards as usual.</small></div>
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
              ${select('base', 'Base style', baseStyleOf(a.theme), [['iris', 'Iris (the default for new applications)'], ['standard', 'Standard (pgapex until 0.28)']], 'Colours, corners, font and shadows of the whole application, light and dark. The colours below override its accent and header.')}
              ${input('accent', 'Accent colour', a.theme?.accent ?? BASE_STYLES[baseStyleOf(a.theme)].accent, { type: 'color' })}
              ${input('header', 'Header colour', a.theme?.header ?? BASE_STYLES[baseStyleOf(a.theme)].header, { type: 'color' })}
              ${(['accent_dark', 'header_dark'] as const).map((k) => html`<div class="field"><label class="label" for="f_${k}">${k === 'accent_dark' ? 'Accent colour in dark mode' : 'Header colour in dark mode'}</label>
                <input id="f_${k}" name="${k}" type="color" value="${a.theme?.[k] ?? (k === 'accent_dark' ? '#a59cff' : '#0d0c1a')}">
                <label class="check"><input type="checkbox" name="${k}_own" value="true"${a.theme?.[k] ? raw(' checked') : ''}> Use this colour (else the base style's dark palette)</label></div>`)}
              ${select('nav', 'Navigation menu', a.theme?.nav ?? 'side', [['side', 'Side (collapsible)'], ['top', 'Top bar']], 'On tablets and phones the menu is always a drawer.')}
              ${select('nav_list', 'Navigation menu list', a.nav_list ?? '', listChoices(a.nav_list, '- the navigation entries -'), 'A list (Shared Components → Lists) shown as the navigation menu instead of the navigation entries.')}
              ${select('navbar_list', 'Navigation bar list', a.navbar_list ?? '', listChoices(a.navbar_list, '- none -'), 'A list shown as links in the header, next to the user menu.')}
              ${select('mode', 'Theme style', a.theme?.mode ?? 'auto', [['auto', 'Automatic (light or dark, following the device)'], ['light', 'Light'], ['dark', 'Dark']])}
            </div>
            <div class="field"><label class="check"><input type="checkbox" name="user_choice" value="true"${a.theme?.user_choice !== false ? raw(' checked') : ''}> Users may choose light or dark</label>
              <small class="help">Adds a switch to the user menu and My account; the choice is saved on the account (APEX: "Enable End Users to Choose Theme Style").</small></div>
            <p><a class="btn" href="${BASE}/apps/${a.id}/theme">${icon('settings')} Theme Roller: style variants…</a>
              <span class="muted">${(() => { const n = appStyles(a.theme).length; return n ? `${n} style${n === 1 ? '' : 's'}` : 'no styles yet'; })()}</span></p>
            <h3>Globalization</h3>
            <div class="form-grid">
              ${input('language', 'Primary language', a.language, { help: 'The language the app is built in, e.g. en, nl, de, en-GB.' })}
              ${input('languages', 'Translated languages', (a.languages ?? []).join(', '), { placeholder: 'e.g. nl, de', help: 'Comma separated. Translate texts under Shared Components → Globalization.' })}
              ${select('language_from', 'Language derived from', a.language_from, [['browser', 'Browser (Accept-Language)'], ['user', 'User preference, then browser'], ['primary', 'Always the primary language']], 'Users can also switch with ?lang=xx or the picker on the login page.')}
              ${input('date_format', 'Date format', a.date_format, { placeholder: 'e.g. DD-MM-YYYY (empty: per language)', help: 'Masks: YYYY YY MM MON MONTH DD DY DAY HH24 HH MI SS AM' })}
              ${input('timestamp_format', 'Date and time format', a.timestamp_format, { placeholder: 'e.g. DD-MM-YYYY HH24:MI' })}
            </div>
            ${await timeZoneSettings(a)}
            <div class="buttons"><button class="btn btn-hot">Save settings</button></div>
          </form>
          <form method="post" action="${BASE}/apps/${a.id}/delete" class="danger-zone">${csrf(s)}
            <button class="btn btn-danger" data-confirm="Delete application ${a.name} and all its pages?">Delete application</button>
          </form>`)}
        ${region('Progressive Web App', pwaSection({ ...a, has_icon: !!(await owner.one('select pwa_icon is not null as h from meta.app where id = $1', [a.id]))?.h }, s))}
        ${region('Security checklist', html`<ul class="checklist">
          <li>${a.db_role ? '✓' : '✗'} Runs as a dedicated database role ${a.db_role ? html`(<code>${a.db_role}</code>)` : html`<b>(runs as the runtime connection)</b>`}</li>
          <li>${a.authentication !== 'none' ? '✓' : '•'} ${a.authentication !== 'none' ? 'Users must sign in' : 'Public application'}</li>
          ${a.authentication === 'header' ? html`<li>${headerProxiesConfigured() ? '✓' : '✗'} Sign-in: HTTP header <code>${a.header_name || DEFAULT_HEADER}</code> ${headerProxiesConfigured() ? 'from the proxies in PGAPEX_AUTH_HEADER_PROXIES' : html`<b>refused: PGAPEX_AUTH_HEADER_PROXIES is not set</b>`}; access: ${a.access_control === 'any_user' ? 'any active account' : 'listed accounts only'}${a.header_auto_create ? ', new accounts created automatically' : ''}</li>` : ''}
          ${a.authentication === 'database' ? html`<li>${a.db_auth_roles?.length || a.db_auth_member_of ? '✓' : '✗'} Sign-in: database accounts (${[a.db_auth_roles?.length ? `roles ${a.db_auth_roles.join(', ')}` : '', a.db_auth_member_of ? `members of ${a.db_auth_member_of}` : ''].filter(Boolean).join('; ') || html`<b>no roles allowed</b>`})</li>` : ''}
          ${a.authentication === 'custom' ? html`<li>${a.custom_auth_function || a.custom_auth_code ? '✓' : '✗'} Sign-in: custom ${a.custom_auth_function ? html`function <code>${a.custom_auth_function}</code>` : a.custom_auth_code ? 'function body' : html`<b>no check configured: nobody can sign in</b>`}${a.custom_auth_post_code ? ', with post-authentication code' : ''}</li>` : ''}
          ${a.authentication === 'app_users' ? html`<li>Sign-in: ${[a.local_login ? 'password' : '', ...a.ldap_directories.map((d: string) => `LDAP ${d}`), ...a.sso_providers].filter(Boolean).join(', ') || html`<b>no method enabled</b>`}; access: ${a.access_control === 'any_user' ? 'any active account' : 'listed accounts only'}</li>` : ''}
          <li>${a.debug ? '✗ Debug mode is on: error details are shown to users' : '✓ Debug mode is off'}</li>
          <li>${a.debug_level ? `✗ Debug messages are on (level ${a.debug_level}): every request is recorded` : '✓ Debug messages are off'}</li>
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
        `update meta.app set name = $2, alias = $3, home_page = $4, authentication = $5, db_role = $6, debug = $7,
                -- (053) the Theme Roller's styles stay: only the keys of this form are replaced
                theme = (theme - 'accent' - 'header' - 'nav' - 'mode' - 'user_choice' - 'base' - 'accent_dark' - 'header_dark') || $8::jsonb,
                local_login = $9, sso_providers = $10, language = $11, languages = $12, language_from = $13,
                date_format = $14, timestamp_format = $15, remember_me_days = $16, ldap_directories = $17,
                header_name = $18, header_auto_create = $19, logout_url = $20, db_auth_roles = $21, db_auth_member_of = $22,
                custom_auth_function = $23, custom_auth_code = $24, custom_auth_post_code = $25, nav_list = $26, navbar_list = $27,
                app_type = $28, updated_at = now() where id = $1`,
        [req.params.id, b.name?.trim(), b.alias?.trim().toLowerCase(), Number(b.home_page) || 1, b.authentication, b.db_role?.trim() || null, b.debug === 'true',
         JSON.stringify({
           base: baseStyleOf({ base: b.base }) === 'iris' ? 'iris' : undefined,
           accent_dark: b.accent_dark_own === 'true' && /^#[0-9a-f]{6}$/i.test(b.accent_dark ?? '') ? b.accent_dark!.toLowerCase() : undefined,
           header_dark: b.header_dark_own === 'true' && /^#[0-9a-f]{6}$/i.test(b.header_dark ?? '') ? b.header_dark!.toLowerCase() : undefined,
           // a colour equal to a base style's own is not stored, so changing the base style changes it too
           accent: /^#[0-9a-f]{6}$/i.test(b.accent ?? '') && !Object.values(BASE_STYLES).some((x) => x.accent === b.accent!.toLowerCase()) ? b.accent : undefined,
           header: /^#[0-9a-f]{6}$/i.test(b.header ?? '') && !Object.values(BASE_STYLES).some((x) => x.header === b.header!.toLowerCase()) ? b.header : undefined,
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
         ([] as string[]).concat((b.ldap_directories as unknown as string | string[] | undefined) ?? []).filter(Boolean),
         b.header_name?.trim() || null,
         b.header_auto_create === 'true',
         b.logout_url?.trim() || null,
         ((roles) => (roles.length ? roles : null))(parseRoleList(b.db_auth_roles)),
         validRoleName(b.db_auth_member_of),
         b.custom_auth_function?.trim() || null,
         b.custom_auth_code?.trim() || null,
         b.custom_auth_post_code?.trim() || null,
         b.nav_list?.trim().toUpperCase() || null,
         b.navbar_list?.trim().toUpperCase() || null,
         (APP_TYPES as readonly string[]).includes(b.app_type ?? '') ? b.app_type : 'standard'],
      );
      await saveTimeZoneSettings(req.params.id, b);
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
        <p><a class="btn" href="${BASE}/apps/${a.id}/ai">${icon('bolt')} AI usage</a> <span class="muted">the AI services this application may use, and its requests</span></p>
        <p><a class="btn" href="${BASE}/apps/${a.id}/debug">${icon('list')} Debug messages</a> <span class="muted">${a.debug_level ? `on (level ${a.debug_level}): ` : 'off: '}timed steps of each request and messages from <code>meta.debug()</code></span></p>
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
    const devs = (await owner.query('select username, is_admin from meta.developer order by 1')).rows;
    const admin = devs.some((d) => d.username === s.username && d.is_admin);
    const main = html`<h1 class="u-mb1">Developers</h1>
      <div class="columns">
        ${region('Change your password', html`<form method="post" action="${BASE}/developers/password">${csrf(s)}
          <div class="form-grid">
            ${input('current', 'Current password', '', { type: 'password', required: true, auto: 'current-password' })}
            ${input('password', 'New password', '', { type: 'password', required: true, auto: 'new-password', help: 'At least 8 characters.' })}
          </div>
          <div class="buttons"><button class="btn btn-hot">Change password</button></div></form>`)}
        ${region('Developer accounts', html`
          <p class="muted u-mt0">Administrators add and remove developers and can break other developers' page and application locks.</p>
          <table class="report"><thead><tr><th>Username</th><th>Role</th><th></th></tr></thead><tbody>
            ${devs.map((d) => html`<tr><td>${d.username}${d.username === s.username ? ' (you)' : ''}</td><td>${d.is_admin ? 'Administrator' : 'Developer'}</td><td>${d.username === s.username || !admin ? '' : html`
              <form method="post" action="${BASE}/developers/admin" class="u-inline">${csrf(s)}<input type="hidden" name="username" value="${d.username}"><input type="hidden" name="is_admin" value="${d.is_admin ? 'false' : 'true'}"><button class="link-button">${d.is_admin ? 'Make developer' : 'Make administrator'}</button></form>
              · <form method="post" action="${BASE}/developers/delete" class="u-inline">${csrf(s)}<input type="hidden" name="username" value="${d.username}"><button class="link-button" data-confirm="Remove developer ${d.username}?">Remove</button></form>`}</td></tr>`)}
          </tbody></table>
          ${admin
            ? html`<h3>Add developer</h3>
              <form method="post" action="${BASE}/developers">${csrf(s)}
                <div class="form-grid">${input('username', 'Username', '', { required: true })}${input('password', 'Password', '', { type: 'password', required: true, auto: 'new-password' })}</div>
                <div class="field"><label class="check"><input type="checkbox" name="is_admin" value="true"> Administrator</label></div>
                <div class="buttons"><button class="btn btn-hot">Add developer</button></div>
              </form>`
            : html`<p class="muted">Only administrators add and remove developers.</p>`}`)}
      </div>`;
    return send(reply, s, shell(s, 'Developers', [['Developers']], main, 'developers'));
  });

  app.post(`${BASE}/developers`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    if (!(await isAdmin(s.username))) return reply.code(403).send('Only administrators add developers.');
    try {
      const problem = await passwordProblem(req.body?.password);
      if (problem) throw new Error(problem);
      const ws = currentWorkspace(s);
      await owner.tx(async (c) => {
        await c.query('insert into meta.developer (username, password_hash, is_admin) values ($1, meta.hash_password($2), $3)', [req.body?.username?.trim(), req.body?.password, req.body?.is_admin === 'true']);
        // (064) a new developer works in the current workspace; more on Workspace utilities → Workspaces
        // (the insert trigger put them in Default)
        if (ws > 0 && ws !== 1) {
          await c.query('delete from meta.workspace_member where workspace_id = 1 and username = $1', [req.body?.username?.trim()]);
          await c.query('insert into meta.workspace_member (workspace_id, username) values ($1, $2)', [ws, req.body?.username?.trim()]);
        }
      });
      flash(s, ws > 0 ? `Developer added to workspace ${s.workspace!.name}.` : 'Developer added.');
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

  app.post(`${BASE}/developers/admin`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    if (!(await isAdmin(s.username))) return reply.code(403).send('Only administrators change roles.');
    if (req.body?.username && req.body.username !== s.username) {
      await owner.query('update meta.developer set is_admin = $2 where username = $1', [req.body.username, req.body.is_admin === 'true']);
      flash(s, 'Role changed.');
    }
    return back(reply, s, `${BASE}/developers`);
  });

  app.post(`${BASE}/developers/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    if (!(await isAdmin(s.username))) return reply.code(403).send('Only administrators remove developers.');
    if (req.body?.username && req.body.username !== s.username) {
      await owner.query('delete from meta.developer where username = $1', [req.body.username]);
      await owner.query('delete from meta.session where app_id is null and username = $1', [req.body.username]);
      flash(s, 'Developer removed.');
    }
    return back(reply, s, `${BASE}/developers`);
  });
}
