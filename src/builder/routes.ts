import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import pg from 'pg';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { documentShell } from '../layout.ts';
import { passwordProblem } from '../accounts.ts';
import {
  clientIp,
  createSession,
  destroySession,
  getSession,
  loginThrottled,
  logActivity,
  saveState,
  takeFlash,
  type Session,
} from '../session.ts';
import { COMPONENTS, ICON_OPTIONS, parseFields, type ComponentSpec, type Field } from './components.ts';

import { APP_COLORS, appHeader, back, BASE, csrf, developer, flash, input, region, select, send, shell, workshopTabs, type Body, type Req } from './ui.ts';
import { endSessions, grantAccess, roleHints, roleHintsHtml, splitRoles } from './users.ts';

interface Lookups {
  regions: { id: number; title: string | null; type: string }[];
  pages: { page_no: number; name: string }[];
  authz: string[];
  nav: { id: number; label: string }[];
}

async function lookups(appId: number, pageId?: number): Promise<Lookups> {
  const [regions, pages, authz, nav] = await Promise.all([
    pageId ? owner.query('select id, title, type from meta.region where page_id = $1 order by seq, id', [pageId]) : Promise.resolve({ rows: [] }),
    owner.query('select page_no, name from meta.page where app_id = $1 order by page_no', [appId]),
    owner.query('select name from meta.authz_scheme where app_id = $1 order by name', [appId]),
    owner.query('select id, label from meta.nav_entry where app_id = $1 order by seq, id', [appId]),
  ]);
  return { regions: regions.rows, pages: pages.rows, authz: authz.rows.map((r) => r.name), nav: nav.rows };
}

/** Property editor for one component, grouped like APEX's property editor. */
function componentForm(spec: ComponentSpec, kind: string, row: any, lk: Lookups, action: string, s: Session, submit: string) {
  const field = (f: Field) => {
    const v = row?.[f.name];
    const help = f.help ? html`<small class="help">${f.help}</small>` : '';
    const id = `f_${kind}_${f.name}`;
    let control: Raw;
    const opts = (list: [string, string][]) =>
      html`<select id="${id}" name="${f.name}">${list.map(([val, label]) => html`<option value="${val}"${String(v ?? '') === val ? raw(' selected') : ''}>${label}</option>`)}</select>`;
    switch (f.kind) {
      case 'bool':
        return html`<div class="field"><span class="label" aria-hidden="true"></span><label class="check"><input type="checkbox" name="${f.name}" value="true"${v ? raw(' checked') : ''}> ${f.label}</label>${help}</div>`;
      case 'select':
        control = opts(f.options!.map((o) => [o, o || '- none -']));
        break;
      case 'icon':
        control = opts(ICON_OPTIONS.map((o) => [o, o || '- none -']));
        break;
      case 'region':
        control = opts([['', '- none (page level) -'], ...lk.regions.map((r): [string, string] => [String(r.id), `${r.title ?? '(untitled)'} (${r.type})`])]);
        break;
      case 'page':
        control = opts([['', '- none -'], ...lk.pages.map((p): [string, string] => [String(p.page_no), `${p.page_no}. ${p.name}`])]);
        break;
      case 'nav':
        control = opts([['', '- top level -'], ...lk.nav.filter((n) => n.id !== row?.id).map((n): [string, string] => [String(n.id), n.label])]);
        break;
      case 'authz': {
        const names = ['MUST_NOT_BE_PUBLIC_USER', ...lk.authz];
        const list: [string, string][] = [['', '- none -'], ...names.flatMap((n): [string, string][] => [[n, n], [`!${n}`, `Not ${n}`]])];
        if (v && !list.some(([x]) => x === v)) list.push([v, `${v} (missing!)`]);
        control = opts(list);
        break;
      }
      case 'code':
        control = html`<textarea id="${id}" name="${f.name}" class="code" rows="${f.wide ? 7 : 2}" spellcheck="false">${v ?? ''}</textarea>`;
        break;
      case 'json': {
        const text = v && typeof v === 'object' && Object.keys(v).length ? JSON.stringify(v, null, 2) : '';
        control = html`<textarea id="${id}" name="${f.name}" class="code" rows="${f.wide ? 4 : 2}" spellcheck="false">${text}</textarea>`;
        break;
      }
      default:
        control = html`<input id="${id}" name="${f.name}" type="${f.kind === 'int' ? 'number' : 'text'}" value="${v ?? ''}">`;
    }
    return html`<div class="field"${f.wide ? raw(' data-wide') : ''}><label class="label" for="${id}">${f.label}</label>${control}${help}</div>`;
  };
  const groups = [...new Set(spec.fields.map((f) => f.group ?? ''))];
  return html`<form method="post" action="${action}" class="component-form">
    ${csrf(s)}
    ${groups.map((g) => html`<fieldset class="prop-group">${g ? html`<legend>${g}</legend>` : ''}<div class="form-grid">${spec.fields.filter((f) => (f.group ?? '') === g).map(field)}</div></fieldset>`)}
    <div class="buttons"><button class="btn btn-hot">${submit}</button></div>
  </form>`;
}

async function saveComponent(kind: string, parentCol: 'page_id' | 'app_id', parentId: string, cid: string | undefined, body: Body) {
  const spec = COMPONENTS[kind];
  const values = parseFields(spec, body);
  if (cid) {
    const cols = Object.keys(values);
    const res = await owner.query(
      `update ${spec.table} set ${cols.map((c, i) => `${c} = $${i + 3}`).join(', ')} where id = $1 and ${parentCol} = $2`,
      [cid, parentId, ...Object.values(values)],
    );
    if (res.rowCount !== 1) throw new Error('Component not found');
    return Number(cid);
  }
  // On create, empty values are left out so column defaults apply.
  const set = Object.entries(values).filter(([, v]) => v !== null);
  const r = await owner.one(
    `insert into ${spec.table} (${parentCol}${set.map(([c]) => `, ${c}`).join('')}) values ($1${set.map((_, i) => `, $${i + 2}`).join('')}) returning id`,
    [parentId, ...set.map(([, v]) => v)],
  );
  return r.id as number;
}

// ------------------------------------------------------------------ routes

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
        'login-body',
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

  // ---------------------------------------------------------------- workspace home
  app.get(BASE, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const [apps, schemas] = await Promise.all([
      owner.query(`select a.*, (select count(*) from meta.page p where p.app_id = a.id)::int as pages,
                          (select count(*) from meta.activity_log l where l.app_id = a.id and l.event = 'page_view' and l.at > now() - interval '1 day')::int as views
                     from meta.app a order by a.name`),
      owner.query(`select nspname from pg_namespace where nspname !~ '^pg_' and nspname not in ('information_schema', 'meta') order by 1`),
    ]);
    const main = html`
      <div class="title-row"><h1>App Builder</h1></div>
      <div class="tiles">
        <a class="tile" href="#create"><span class="tile-icon">${icon('plus')}</span><span><strong>Create application</strong><small>Start from a table or blank</small></span></a>
        <a class="tile" href="${BASE}/sql"><span class="tile-icon">${icon('database')}</span><span><strong>SQL Workshop</strong><small>Run SQL, browse objects</small></span></a>
        <a class="tile" href="#import"><span class="tile-icon">${icon('download')}</span><span><strong>Import</strong><small>From an export JSON</small></span></a>
      </div>
      <div class="app-cards">
        ${apps.rows.length
          ? apps.rows.map((a, i) => html`<article class="app-card">
              <div style="display:flex;gap:.75rem;align-items:center">
                <span class="app-icon" style="background:${APP_COLORS[i % APP_COLORS.length]}">${a.name.slice(0, 1).toUpperCase()}</span>
                <div><h3><a href="${BASE}/apps/${a.id}">${a.name}</a></h3><div class="meta">/a/${a.alias} · ${a.pages} pages · ${a.views} views today</div></div>
              </div>
              <div class="meta">${a.authentication === 'none' ? 'Public' : 'App users'} · role ${a.db_role ?? '(owner!)'}${a.debug ? ' · debug' : ''}</div>
              <div class="buttons"><a class="btn" href="${BASE}/apps/${a.id}">${icon('edit')} Edit</a><a class="btn" href="/a/${a.alias}" target="_blank" rel="noopener">${icon('play')} Run</a></div>
            </article>`)
          : html`<p class="muted">No applications yet.</p>`}
      </div>
      <div class="columns">
        <section class="region region-standard" id="create"><header class="region-header"><h2>Create application</h2></header><div class="region-body">
          <form method="post" action="${BASE}/apps">${csrf(s)}
            <div class="form-grid">
              ${input('name', 'Name', '', { required: true })}
              ${input('alias', 'Alias (URL)', '', { required: true, help: 'lowercase, e.g. inventory → /a/inventory' })}
              ${select('schema', 'Parsing schema', '', [['', '- new schema named after the alias -'], ...schemas.rows.map((r): [string, string] => [r.nspname, r.nspname])],
                'A database role app_<alias> is created with access to this schema only; the app runs as that role.')}
              ${select('authentication', 'Authentication', 'app_users', [['app_users', 'App users (login page)'], ['none', 'None (public)']])}
              ${input('admin_user', 'First user', '', { placeholder: 'e.g. your name', help: 'Gets the admin role. An existing account in Users is reused.' })}
              ${input('admin_password', 'Password', '', { type: 'password', auto: 'new-password', help: 'For a new account; at least 8 characters.' })}
            </div>
            <div class="buttons"><button class="btn btn-hot">Create application</button></div>
          </form></div></section>
        <section class="region region-standard" id="import"><header class="region-header"><h2>Import application</h2></header><div class="region-body">
          <form method="post" action="${BASE}/import">${csrf(s)}
            <div class="field" data-wide><label class="label" for="f_doc">Export JSON</label><textarea id="f_doc" name="doc" class="code" rows="7" required></textarea></div>
            ${input('alias', 'New alias (optional)', '')}
            <div class="buttons"><button class="btn btn-hot">Import</button></div>
          </form></div></section>
      </div>`;
    return send(reply, s, shell(s, 'App Builder', [['App Builder']], main));
  });

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
      return back(reply, s, BASE);
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
      return back(reply, s, BASE);
    }
  });

  // ---------------------------------------------------------------- app home
  const appOr404 = async (id: string) => owner.one('select * from meta.app where id = $1', [id]);


  app.get(`${BASE}/apps/:id`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOr404(req.params.id);
    if (!a) return reply.code(404).send('Not found');
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
          <p class="muted" style="margin-top:0">"Report and form" generates an interactive report and a modal form with create/update/delete; "Interactive grid" generates one editable grid page. Both add a menu entry.</p>
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
        ${region('Security checklist', html`<ul class="checklist">
          <li>${a.db_role ? '✓' : '✗'} Runs as a dedicated database role ${a.db_role ? html`(<code>${a.db_role}</code>)` : html`<b>(runs as the runtime connection)</b>`}</li>
          <li>${a.authentication !== 'none' ? '✓' : '•'} ${a.authentication !== 'none' ? 'Users must sign in' : 'Public application'}</li>
          ${a.authentication !== 'none' ? html`<li>Sign-in: ${[a.local_login ? 'password' : '', ...a.sso_providers].filter(Boolean).join(', ') || html`<b>no method enabled</b>`}; access: ${a.access_control === 'any_user' ? 'any active account' : 'listed accounts only'}</li>` : ''}
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
                date_format = $14, timestamp_format = $15, updated_at = now() where id = $1`,
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
         b.timestamp_format?.trim() || null],
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

  // ---------------------------------------------------------------- shared components
  const SHARED = ['nav_entry', 'authz_scheme', 'lov', 'app_item', 'app_process'];

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
    } else if (selKind && SHARED.includes(selKind)) {
      const spec = COMPONENTS[selKind];
      const row = rows[selKind].find((r) => String(r.id) === selId);
      editor = row
        ? region(`${spec.label}: ${spec.summary(row)}`, html`${componentForm(spec, selKind, row, lk, `${BASE}/apps/${a.id}/shared/${selKind}/${row.id}`, s, 'Save')}
            <form method="post" action="${BASE}/apps/${a.id}/shared/${selKind}/${row.id}/delete" class="danger-zone">${csrf(s)}<button class="btn btn-danger" data-confirm="Delete this ${spec.label.toLowerCase()}?">Delete</button></form>`)
        : html`<p>Not found.</p>`;
    } else {
      const accounts = (await owner.query('select username from meta.account where active order by lower(username) limit 2000')).rows;
      const appHints = (await roleHints([a.id])).get(a.id) ?? [];
      const groupRoles = (await owner.query('select group_name, role from meta.app_group_role where app_id = $1 order by 1, 2', [a.id])).rows;
      const groupMap = html`<h3>Identity-provider groups → roles</h3>
        <p class="muted" style="margin-top:0">With single sign-on, members of these groups get the role in this app, and may sign in even without being listed above.</p>
        ${groupRoles.length
          ? html`<div class="chips">${groupRoles.map((g) => html`<span class="chip">${g.group_name} → <b>${g.role}</b>
              <form method="post" action="${BASE}/apps/${a.id}/groups/delete" style="display:inline">${csrf(s)}<input type="hidden" name="group_name" value="${g.group_name}"><input type="hidden" name="role" value="${g.role}"><button class="link-button" aria-label="Remove mapping ${g.group_name} to ${g.role}">×</button></form></span>`)}</div>`
          : html`<p class="muted">No group mappings.</p>`}
        <form method="post" action="${BASE}/apps/${a.id}/groups">${csrf(s)}
          <div class="form-grid">${input('group_name', 'Group (as in the token)', '', { required: true, placeholder: 'e.g. hr-managers' })}${input('role', 'Role in this app', '', { required: true, placeholder: 'e.g. manager' })}</div>
          <div class="buttons"><button class="btn">Add mapping</button></div>
        </form>`;
      editor = region('Access control', html`
        <form method="post" action="${BASE}/apps/${a.id}/access" class="search" style="max-width:none;margin-bottom:1rem">${csrf(s)}
          ${select('access_control', 'Who may sign in', a.access_control, [
            ['assigned', 'Only accounts listed below (role-based access)'],
            ['any_user', 'Any active account in the directory'],
          ])}
          <button class="btn" style="align-self:end">Save</button>
        </form>
        <p class="muted">Accounts live in the <a href="${BASE}/users">user directory</a>; here you grant them access to <b>${a.name}</b> and assign roles, which authorization schemes and <code>meta.has_role()</code> check. Role changes apply at the user's next sign-in (their sessions in this app end).</p>
        <div class="table-wrap"><table class="report report-reflow"><thead><tr><th>Account</th><th>Roles in this app</th><th>Last sign-in</th><th></th></tr></thead><tbody>
          ${users.length
            ? users.map((u) => html`<tr>
                <td data-label="Account"><a href="${BASE}/users/${u.id}">${u.username}</a>${u.display_name ? html` <span class="muted">${u.display_name}</span>` : ''}${u.active ? '' : html` <b>(inactive)</b>`}</td>
                <td data-label="Roles"><form method="post" action="${BASE}/apps/${a.id}/access/${u.id}" class="search roles-form" style="margin:0;max-width:none">${csrf(s)}
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
            kind === 'nav_entry' && r.target_page ? html`<span class="kind">p${r.target_page}</span>` : kind === 'authz_scheme' ? html`<span class="kind">${r.type}</span>` : kind === 'app_process' ? html`<span class="kind">${r.point}</span>` : ''
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
        ${region('Page views by page (7 days)', html`<div class="table-wrap"><table class="report"><thead><tr><th class="num">Page</th><th>Name</th><th class="num">Views</th><th class="num">Avg ms</th><th class="num">Max ms</th></tr></thead>
          <tbody>${byPage.rows.map((r) => html`<tr><td class="num">${r.page_no}</td><td>${r.name}</td><td class="num">${r.views}</td><td class="num">${r.avg_ms}</td><td class="num">${r.max_ms}</td></tr>`)}</tbody></table></div>`)}
        ${region('Recent events', html`<p class="muted" style="margin-top:0">${req.query.all === '1' ? html`Showing all events. <a href="?">Hide page views</a>` : html`Sign-ins, denials and errors. <a href="?all=1">Include page views</a>`}</p>
          <div class="table-wrap"><table class="report"><thead><tr><th>When</th><th>Event</th><th>User</th><th class="num">Page</th><th>IP</th><th>Detail</th></tr></thead>
          <tbody>${events.rows.map((r) => html`<tr><td>${String(r.at).slice(0, 19)}</td><td><span class="ev ev-${r.event}">${r.event}</span></td><td>${r.username}</td><td class="num">${r.page_no}</td><td>${r.ip}</td><td title="${r.detail}">${r.detail}</td></tr>`)}</tbody></table></div>`)}
      </div>`;
    return send(reply, s, shell(s, 'Activity', [['App Builder', BASE], [a.name, `${BASE}/apps/${a.id}`], ['Activity']], main));
  });

  // ---------------------------------------------------------------- page designer
  const PAGE_KINDS = ['region', 'item', 'button', 'dynamic_action', 'validation', 'process'];

  app.get(`${BASE}/pages/:pid`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const p = await owner.one('select p.*, a.alias, a.name as app_name from meta.page p join meta.app a on a.id = p.app_id where p.id = $1', [req.params.pid]);
    if (!p) return reply.code(404).send('Not found');
    const rows: Record<string, any[]> = {};
    for (const kind of PAGE_KINDS) rows[kind] = (await owner.query(`select * from ${COMPONENTS[kind].table} where page_id = $1 order by seq, id`, [p.id])).rows;
    const lk = await lookups(p.app_id, p.id);
    const sel = req.query.c ?? '';
    const newKind = req.query.new;
    const url = (q: string) => `${BASE}/pages/${p.id}?${q}`;
    const cur = (key: string) => (sel === key ? raw(' aria-current="page"') : '');
    const tags = (r: any) => html`${r.authz ? html` <span class="tag" title="Authorization">${r.authz}</span>` : ''}${r.condition || r.readonly_condition ? html` <span class="tag" title="Condition">cond</span>` : ''}`;
    const node = (kind: string, r: any, label: string, extra: Raw | string = '') =>
      html`<li><a href="${url(`c=${kind}-${r.id}`)}"${cur(`${kind}-${r.id}`)}>${icon(COMPONENTS[kind].icon)}<span>${label}</span>${tags(r)}<span class="kind">${extra}</span></a></li>`;
    const addLink = (kind: string, label: string, extra = '') => html`<a href="${url(`new=${kind}${extra}`)}">＋ ${label}</a>`;

    const regionNodes = rows.region.map((r) => html`<li><a href="${url(`c=region-${r.id}`)}"${cur(`region-${r.id}`)}>${icon('layers')}<span>${r.title ?? '(untitled)'}</span>${tags(r)}<span class="kind">${r.type}</span></a>
      <ul>
        ${rows.item.filter((i) => i.region_id === r.id).map((i) => node('item', i, i.name, i.type))}
        ${rows.button.filter((b) => b.region_id === r.id).map((b) => node('button', b, b.name, b.action))}
        <li class="group">${addLink('item', 'item', `&region=${r.id}`)} ${addLink('button', 'button', `&region=${r.id}`)}</li>
      </ul></li>`);

    const tree = html`<ul class="tree">
      <li><a href="${url('c=page')}"${cur('page') || (sel === '' && !newKind ? raw(' aria-current="page"') : '')}>${icon('file')}<span>Page ${p.page_no}: ${p.name}</span>${tags(p)}</a></li>
      <li class="group">Rendering ${addLink('region', 'Region')}</li>
      ${regionNodes}
      <li class="group">Page-level items &amp; buttons ${addLink('item', 'item')}</li>
      ${rows.item.filter((i) => i.region_id === null).map((i) => node('item', i, i.name, i.type))}
      ${rows.button.filter((b) => b.region_id === null).map((b) => node('button', b, b.name, b.action))}
      <li class="group">Dynamic actions ${addLink('dynamic_action', 'Add')}</li>
      ${rows.dynamic_action.map((d) => node('dynamic_action', d, d.name, `${d.event} → ${d.action}`))}
      <li class="group">Validations ${addLink('validation', 'Add')}</li>
      ${rows.validation.map((v) => node('validation', v, v.name, v.type))}
      <li class="group">Processes ${addLink('process', 'Add')}</li>
      ${rows.process.map((x) => node('process', x, x.name, x.when_button ?? x.point))}
    </ul>`;

    let editor: Raw;
    const [kind, cid] = sel.split('-');
    if (newKind && PAGE_KINDS.includes(newKind)) {
      const spec = COMPONENTS[newKind];
      const lastSeq = Math.max(0, ...rows[newKind].map((r) => r.seq));
      const defaults = { seq: lastSeq + 10, ...spec.defaults, region_id: req.query.region ? Number(req.query.region) : null };
      editor = region(`New ${spec.label.toLowerCase()}`, componentForm(spec, newKind, defaults, lk, `${BASE}/pages/${p.id}/c/${newKind}`, s, `Create ${spec.label.toLowerCase()}`));
    } else if (kind && kind !== 'page' && PAGE_KINDS.includes(kind)) {
      const spec = COMPONENTS[kind];
      const row = rows[kind].find((r) => String(r.id) === cid);
      editor = row
        ? region(`${spec.label}: ${spec.summary(row)}`, html`${componentForm(spec, kind, row, lk, `${BASE}/pages/${p.id}/c/${kind}/${row.id}`, s, 'Save')}
            <form method="post" action="${BASE}/pages/${p.id}/c/${kind}/${row.id}/delete" class="danger-zone">${csrf(s)}
              <button class="btn btn-danger" data-confirm="Delete this ${spec.label.toLowerCase()}?">Delete ${spec.label.toLowerCase()}</button></form>`)
        : html`<p>Component not found.</p>`;
    } else {
      editor = html`${region('Page', html`
        <form method="post" action="${BASE}/pages/${p.id}">${csrf(s)}
          <fieldset class="prop-group"><legend>Identification</legend><div class="form-grid">
            ${input('page_no', 'Page number', p.page_no, { type: 'number', required: true })}
            ${input('name', 'Name', p.name, { required: true })}
            ${input('title', 'Title', p.title, { help: 'Supports &ITEM. substitutions.' })}
          </div></fieldset>
          <fieldset class="prop-group"><legend>Appearance</legend><div class="form-grid">
            ${select('mode', 'Page mode', p.mode, [['normal', 'Normal'], ['modal', 'Modal dialog']])}
            ${select('parent_page', 'Breadcrumb parent', p.parent_page ?? '', [['', '- none -'], ...lk.pages.filter((x) => x.page_no !== p.page_no).map((x): [string, string] => [String(x.page_no), `${x.page_no}. ${x.name}`])])}
          </div></fieldset>
          <fieldset class="prop-group"><legend>Security</legend><div class="form-grid">
            <div class="field"><span class="label" aria-hidden="true"></span><label class="check"><input type="checkbox" name="requires_auth" value="true"${p.requires_auth ? raw(' checked') : ''}> Requires authentication</label></div>
            ${select('authz', 'Authorization scheme', p.authz ?? '', [['', '- none -'], ...['MUST_NOT_BE_PUBLIC_USER', ...lk.authz].flatMap((n): [string, string][] => [[n, n], [`!${n}`, `Not ${n}`]])])}
            ${select('protection', 'Page access protection', p.protection, [['checksum', 'Arguments must have checksum'], ['unrestricted', 'Unrestricted']],
              'With checksum, item values in the URL (?P3_ID=…) are only accepted from links the runtime generated.')}
          </div></fieldset>
          <div class="buttons"><button class="btn btn-hot">Save page</button></div>
        </form>
        <form method="post" action="${BASE}/pages/${p.id}/delete" class="danger-zone">${csrf(s)}
          <button class="btn btn-danger" data-confirm="Delete page ${p.page_no} and all its components?">Delete page</button></form>`)}
        <div style="height:1rem"></div>
        ${region('Cheat sheet', html`<div class="cheat">
          <p><code>:P1_ITEM</code> binds an item value in any SQL (always escaped). <code>:APP_USER</code>, <code>:APP_PAGE_ID</code>, <code>:REQUEST</code> are built in.</p>
          <p><code>&amp;P1_ITEM.</code> substitutes into titles, static HTML and link targets (HTML-escaped).</p>
          <p>In SQL, PL/pgSQL and RLS policies: <code>meta.app_user()</code>, <code>meta.has_role('admin')</code>, <code>meta.v('P1_ITEM')</code>, <code>meta.page_url(3, '{"P3_ID": 7}')</code>.</p>
          <p>A PL/pgSQL <code>raise exception 'Message' using column = 'sal'</code> shows the message on the item whose source column is <code>sal</code>.</p>
        </div>`)}`;
    }

    const main = html`
      <div class="title-row"><h1>Page ${p.page_no}: ${p.name}</h1>
        <div class="buttons">
          ${p.page_no > 1 ? html`<a class="btn" href="${BASE}/apps/${p.app_id}">‹ All pages</a>` : ''}
          <a class="btn btn-hot" href="/a/${p.alias}/${p.page_no}" target="_blank" rel="noopener">${icon('play')} Run page</a>
        </div></div>
      <div class="designer">
        <aside class="region region-standard" aria-label="Page components">${tree}</aside>
        <div>${editor}</div>
      </div>`;
    return send(reply, s, shell(s, `Page ${p.page_no}`, [['App Builder', BASE], [p.app_name, `${BASE}/apps/${p.app_id}`], [`Page ${p.page_no}`]], main));
  });

  app.post(`${BASE}/pages/:pid`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = req.body ?? {};
    try {
      await owner.query(
        `update meta.page set page_no = $2, name = $3, title = $4, requires_auth = $5, mode = $6, parent_page = $7, authz = $8, protection = $9 where id = $1`,
        [req.params.pid, Number(b.page_no), b.name?.trim(), b.title?.trim() || null, b.requires_auth === 'true', b.mode, b.parent_page ? Number(b.parent_page) : null, b.authz || null, b.protection],
      );
      flash(s, 'Page saved.');
    } catch (e) {
      flash(s, (e as Error).message, 'error');
    }
    return back(reply, s, `${BASE}/pages/${req.params.pid}?c=page`);
  });

  app.post(`${BASE}/pages/:pid/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const p = await owner.one('delete from meta.page where id = $1 returning app_id', [req.params.pid]);
    flash(s, 'Page deleted.');
    return back(reply, s, p ? `${BASE}/apps/${p.app_id}` : BASE);
  });

  app.post(`${BASE}/pages/:pid/c/:kind/:cid?`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const { pid, kind, cid } = req.params;
    if (!PAGE_KINDS.includes(kind)) return reply.code(404).send('Unknown component type');
    try {
      const id = await saveComponent(kind, 'page_id', pid, cid, req.body ?? {});
      flash(s, `${COMPONENTS[kind].label} saved.`);
      return back(reply, s, `${BASE}/pages/${pid}?c=${kind}-${id}`);
    } catch (e) {
      flash(s, (e as Error).message, 'error');
      return back(reply, s, `${BASE}/pages/${pid}?${cid ? `c=${kind}-${cid}` : `new=${kind}`}`);
    }
  });

  app.post(`${BASE}/pages/:pid/c/:kind/:cid/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const { pid, kind, cid } = req.params;
    if (!PAGE_KINDS.includes(kind)) return reply.code(404).send('Unknown component type');
    await owner.query(`delete from ${COMPONENTS[kind].table} where id = $1 and page_id = $2`, [cid, pid]);
    flash(s, `${COMPONENTS[kind].label} deleted.`);
    return back(reply, s, `${BASE}/pages/${pid}`);
  });

  // ---------------------------------------------------------------- SQL workshop
  const resultTable = (res: pg.QueryResult<any[]>, limit = 500) => {
    const rows = (res.rows ?? []).slice(0, limit);
    return html`<div class="table-wrap"><table class="report"><thead><tr>${res.fields.map((f) => html`<th>${f.name}</th>`)}</tr></thead>
      <tbody>${rows.map((r) => html`<tr>${r.map((v) => html`<td>${v === null ? html`<span class="null">null</span>` : typeof v === 'object' ? JSON.stringify(v) : String(v)}</td>`)}</tr>`)}</tbody></table></div>`;
  };

  const sqlWorkshop = async (req: Req, reply: FastifyReply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const sql = req.body?.sql ?? '';
    let result: Raw | '' = '';
    if (req.method === 'POST' && sql.trim()) {
      const started = performance.now();
      try {
        const out = await owner.pool.query({ text: sql, rowMode: 'array' });
        const res = Array.isArray(out) ? out[out.length - 1] : out;
        const ms = (performance.now() - started).toFixed(0);
        result = res.fields?.length
          ? html`<p class="muted">${res.rowCount} row(s) in ${ms} ms${res.rows.length > 500 ? ' (showing 500)' : ''}</p>${resultTable(res)}`
          : html`<div class="alert alert-success">${res.command ?? 'Statement'} completed${res.rowCount !== null ? `, ${res.rowCount} row(s)` : ''} in ${ms} ms.</div>`;
      } catch (e) {
        result = html`<div class="alert alert-error"><strong>Error:</strong> ${(e as Error).message}</div>`;
      }
    }
    const main = html`<h1 style="margin-bottom:1rem">SQL Workshop</h1>${workshopTabs('sql')}
      <p class="muted">Runs as the builder's owner connection (not as an application role). Multiple statements are allowed; results of the last one are shown.</p>
      <form method="post">${csrf(s)}
        <textarea name="sql" class="code sql-editor" rows="12" spellcheck="false" aria-label="SQL">${sql || 'select * from hr.emp;'}</textarea>
        <div class="buttons"><button class="btn btn-hot">${icon('play')} Run (Ctrl+Enter)</button></div>
      </form>
      <div style="margin-top:1rem">${result}</div>`;
    return send(reply, s, shell(s, 'SQL Workshop', [['SQL Workshop']], main, 'sql'));
  };
  app.get(`${BASE}/sql`, sqlWorkshop);
  app.post(`${BASE}/sql`, sqlWorkshop);

  app.get(`${BASE}/sql/objects`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const objects = (
      await owner.query(
        `select n.nspname as schema, c.relname as name, c.oid::regclass::text as qname,
                case c.relkind when 'r' then 'table' when 'p' then 'table' when 'v' then 'view' when 'm' then 'view' end as kind,
                c.relrowsecurity as rls
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.relkind in ('r', 'p', 'v', 'm') and n.nspname !~ '^pg_' and n.nspname not in ('information_schema')
         union all
         select n.nspname, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', p.oid::regprocedure::text, 'function', false
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname !~ '^pg_' and n.nspname not in ('information_schema') and p.prokind in ('f', 'p')
          order by 1, 4 desc, 2`,
      )
    ).rows;
    const o = req.query.o;
    const selected = objects.find((x) => x.qname === o);
    let detail: Raw = html`<p class="muted">Select a table, view or function.</p>`;
    if (selected) {
      if (selected.kind === 'function') {
        const src = await owner.one('select pg_get_functiondef($1::regprocedure) as def', [selected.qname]);
        detail = region(selected.qname, html`<pre class="source">${src.def}</pre>`);
      } else {
        const [cols, policies, grants, data] = await Promise.all([
          owner.query(
            `select a.attname as column, format_type(a.atttypid, a.atttypmod) as type, not a.attnotnull as nullable,
                    pg_get_expr(d.adbin, d.adrelid) as "default"
               from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
              where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped order by a.attnum`,
            [selected.qname],
          ),
          owner.query('select policyname as policy, cmd, roles::text, qual as using, with_check from pg_policies where schemaname = $1 and tablename = $2', [selected.schema, selected.name]),
          owner.query(
            `select grantee, string_agg(privilege_type, ', ' order by privilege_type) as privileges
               from information_schema.role_table_grants where table_schema = $1 and table_name = $2 group by grantee order by grantee`,
            [selected.schema, selected.name],
          ),
          owner.pool.query({ text: `select * from ${selected.qname} limit 25`, rowMode: 'array' }).catch((e) => e as Error),
        ]);
        const asArray = (r: pg.QueryResult) => ({ ...r, rows: r.rows.map((x) => Object.values(x)) }) as unknown as pg.QueryResult<any[]>;
        detail = html`${region(`${selected.kind === 'view' ? 'View' : 'Table'} ${selected.qname}`, resultTable(asArray(cols)),
            html`<span class="count">${selected.rls ? 'row level security ON' : 'no RLS'}</span>`)}
          <div style="height:1rem"></div>
          ${region('Row level security policies', policies.rowCount ? resultTable(asArray(policies)) : html`<p class="muted">No policies.</p>`)}
          <div style="height:1rem"></div>
          ${region('Grants', resultTable(asArray(grants)))}
          <div style="height:1rem"></div>
          ${region('Data (first 25 rows)', data instanceof Error ? html`<div class="alert alert-error">${data.message}</div>` : resultTable(data))}`;
      }
    }
    let lastSchema = '';
    const list = html`<ul class="tree">${objects.map((x) => {
      const header = x.schema !== lastSchema ? html`<li class="group">${(lastSchema = x.schema)}</li>` : '';
      return html`${header}<li><a href="?o=${encodeURIComponent(x.qname)}"${x.qname === o ? raw(' aria-current="page"') : ''}>${icon(x.kind === 'function' ? 'code' : x.kind === 'view' ? 'layers' : 'table')}<span>${x.name}</span>${x.rls ? html`<span class="tag">RLS</span>` : ''}</a></li>`;
    })}</ul>`;
    const main = html`<h1 style="margin-bottom:1rem">SQL Workshop</h1>${workshopTabs('objects')}
      <div class="designer"><aside class="region region-standard" aria-label="Database objects">${list}</aside><div>${detail}</div></div>`;
    return send(reply, s, shell(s, 'Object Browser', [['SQL Workshop', `${BASE}/sql`], ['Object Browser']], main, 'sql'));
  });

  // ---------------------------------------------------------------- developers
  app.get(`${BASE}/developers`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const devs = (await owner.query('select username from meta.developer order by 1')).rows;
    const main = html`<h1 style="margin-bottom:1rem">Developers</h1>
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
