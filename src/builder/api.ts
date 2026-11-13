import type { FastifyInstance } from 'fastify';
import { apiRoleProblem, apiStatus, apiUrl, issueApiToken, MAX_TOKEN_HOURS } from '../api.ts';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import { publicUrl } from '../sso.ts';
import { icon } from '../icons.ts';
import { appHeader, back, BASE, csrf, developer, flash, input, region, send, shell, type Req } from './ui.ts';
import { roleHints, roleHintsHtml, splitRoles } from './users.ts';
import { scopedTx as tx } from './i18n.ts';

// Per-application REST API page: the database role API tokens use, what
// PostgREST exposes to it, and developer-issued tokens for trying it out.

export const API_SCHEMA = 'api';

async function endpoints(role: string) {
  return (
    await owner.query(
      `select c.relname as name, case c.relkind when 'v' then 'view' when 'm' then 'view' else 'table' end as kind,
              concat_ws(', ', case when has_table_privilege($1, c.oid, 'select') then 'GET' end,
                              case when has_table_privilege($1, c.oid, 'insert') then 'POST' end,
                              case when has_table_privilege($1, c.oid, 'update') then 'PATCH' end,
                              case when has_table_privilege($1, c.oid, 'delete') then 'DELETE' end) as methods
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $2 and c.relkind in ('r', 'p', 'v', 'm')
       union all
       select p.proname, 'function', case when has_function_privilege($1, p.oid, 'execute') then 'POST' else '' end
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = $2 and p.prokind = 'f'
        order by 2 desc, 1`,
      [role, API_SCHEMA],
    )
  ).rows;
}

interface NewSecret {
  name: string;
  clientId: string;
  secret: string;
  rotated: boolean;
  graceHours?: number;
}

/** OAuth clients: list, create, rotate, revoke (client credentials, see src/oauth.ts). */
async function clientsRegion(s: Session, a: any, secret?: NewSecret, usable = true) {
  const clients = (
    await owner.query(
      `select id, name, description, client_id, roles, rest_modules, token_minutes, active, secret_changed_at, last_used_at,
              previous_valid_until > now() as grace, previous_valid_until
         from meta.api_client where app_id = $1 order by name`,
      [a.id],
    )
  ).rows;
  const hints = (await roleHints([a.id])).get(a.id) ?? [];
  // (sprint 178) the application's REST modules: a client can be limited to some of them
  const modules = (await owner.query<{ name: string }>('select name from meta.rest_module where app_id = $1 order by name', [a.id])).rows.map((m) => m.name);
  const tokenUrl = `${publicUrl()}/oauth/token`;
  const when = (d: Date | string | null) => (d ? (d instanceof Date ? d.toISOString() : String(d)).slice(0, 16).replace('T', ' ') : '');
  const action = (c: any, path: string, label: string, extra: Raw | '' = '', cls = 'btn') =>
    html`<form method="post" action="${BASE}/apps/${a.id}/api/clients/${c.id}/${path}" class="inline-form">${csrf(s)}${extra}<button class="${cls}">${label}</button></form>`;
  const createForm = html`<form method="post" action="${BASE}/apps/${a.id}/api/clients">${csrf(s)}
        <div class="form-grid">
          ${input('name', tx('apip.name'), '', { required: true, placeholder: tx('apip.e_g_payroll_sync'), help: tx('apip.lower_case_letters_digits') })}
          ${input('token_minutes', tx('apip.token_lifetime_minutes'), 60, { type: 'number', help: tx('apip.5_to_1440') })}
          <div class="field"><label class="label" for="f_roles">${tx('apip.roles')}</label><input id="f_roles" name="roles" placeholder="${tx('apip.comma_separated_or_pick_below')}">${roleHintsHtml(hints)}</div>
          ${input('description', tx('apip.description'), '', { placeholder: tx('apip.who_uses_it') })}
        </div>
        <div class="buttons"><button class="btn btn-hot"${usable ? '' : raw(' disabled')}>${tx('apip.create_client')}</button></div>
      </form>`;
  return region(
    'OAuth clients',
    html`<p class="muted u-mt0">${tx.rich('apip.oauth_intro', { ords: html`<code>oauth.create_client</code>`, url: html`<code>${tokenUrl}</code>`, grant: html`<code>grant_type=client_credentials</code>`, client: html`<code>client:&lt;name&gt;</code>` })}</p>
      ${secret
        ? html`<div class="alert alert-success" role="status">${secret.rotated ? tx('apip.new_secret_for', { name: secret.name }) : tx('apip.client_created', { name: secret.name })}. ${tx('apip.copy_now')}${
            secret.rotated && secret.graceHours ? ` ${tx('apip.grace', { n: secret.graceHours })}` : ''}</div>
          <div class="form-grid">
            <div class="field"><label class="label" for="oauth_id">${tx('apip.client_id')}</label><input id="oauth_id" class="code" readonly value="${secret.clientId}"></div>
            <div class="field"><label class="label" for="oauth_secret">${tx('apip.client_secret')}</label><input id="oauth_secret" class="code" readonly value="${secret.secret}"></div>
          </div>
          <pre class="source">curl -u '${secret.clientId}:${secret.secret}' -d grant_type=client_credentials ${tokenUrl}</pre>`
        : ''}
      ${clients.length
        ? html`<div class="table-wrap"><table class="report report-reflow api-clients"><thead><tr><th>${tx('apip.client')}</th><th>${tx('apip.roles')}</th><th class="num">${tx('apip.token')}</th><th>${tx('apip.secret_changed')}</th><th>${tx('apip.last_used')}</th><th><span class="sr-only">${tx('apip.actions')}</span></th></tr></thead><tbody>
            ${clients.map((c) => html`<tr${c.active ? '' : raw(' class="muted"')}>
              <td data-label="${tx('apip.client')}"><strong>${c.name}</strong>${c.active ? '' : html` <span class="tag">revoked</span>`}<br><code class="small">${c.client_id}</code>${c.description ? html`<br><small class="help">${c.description}</small>` : ''}</td>
              <td data-label="${tx('apip.roles')}"><form method="post" action="${BASE}/apps/${a.id}/api/clients/${c.id}/roles" class="search roles-form u-m0 u-mwnone">${csrf(s)}
                <input name="roles" value="${c.roles.join(', ')}" aria-label="${tx('apip.aria_roles', { name: c.name })}" placeholder="${tx('apip.no_roles')}"><button class="btn btn-sm">${tx('apip.save')}</button>${roleHintsHtml(hints, tx('apip.add'))}</form>
                ${modules.length || c.rest_modules ? html`<form method="post" action="${BASE}/apps/${a.id}/api/clients/${c.id}/modules" class="search roles-form u-m0 u-mwnone u-mt1">${csrf(s)}
                <input name="modules" value="${(c.rest_modules ?? []).join(', ')}" aria-label="${tx('apip.aria_modules', { name: c.name })}" placeholder="${tx('apip.modules_ph')}"><button class="btn btn-sm">${tx('apip.save')}</button>
                <small class="help">${tx('apip.modules_help', { modules: modules.join(', ') || '–' })}</small></form>` : ''}</td>
              <td class="num" data-label="${tx('apip.token')}">${tx('apip.minutes', { n: c.token_minutes })}</td>
              <td data-label="${tx('apip.secret_changed')}">${when(c.secret_changed_at)}${c.grace ? html`<br><small class="help">${tx('apip.old_valid_until', { when: when(c.previous_valid_until) })}</small>` : ''}</td>
              <td data-label="${tx('apip.last_used')}">${when(c.last_used_at) || html`<span class="muted">${tx('apip.never')}</span>`}</td>
              <td class="actions"><div class="api-client-actions">
                ${action(c, 'rotate', tx('apip.new_secret'), html`<select name="grace" aria-label="${tx('apip.keep_the_old_secret')}"><option value="24">${tx('apip.old_24h')}</option><option value="168">${tx('apip.old_7d')}</option><option value="0">${tx('apip.old_now')}</option></select>`, 'btn btn-sm')}
                ${action(c, 'active', c.active ? tx('apip.revoke') : tx('apip.reactivate'), html`<input type="hidden" name="active" value="${c.active ? 'false' : 'true'}">`, 'btn btn-sm')}
                ${action(c, 'delete', tx('apip.delete'), '', 'btn btn-sm btn-danger')}
              </div></td></tr>`)}
          </tbody></table></div>
          <details class="api-new u-mt1"><summary class="btn">${icon('plus')} ${tx('apip.new_client')}</summary><div class="api-new-body">${createForm}</div></details>`
        : html`<p class="muted">${tx('apip.no_clients_yet')}</p>${createForm}`}`,
    html`<span class="count">${clients.length}</span>`,
  );
}

async function apiPage(s: Session, a: any, issued?: { token: string; username: string; expiresInHours: number }, secret?: NewSecret) {
  const role: string | null = a.api_role;
  const [status, problem, granted, eps] = await Promise.all([
    apiStatus(),
    role ? apiRoleProblem(role) : Promise.resolve(null),
    role ? owner.one(`select pg_has_role('pgkiln_authenticator', r.oid, 'MEMBER') as ok from pg_roles r where r.rolname = $1`, [role]) : Promise.resolve(null),
    role ? endpoints(role).catch(() => []) : Promise.resolve([]),
  ]);
  const url = apiUrl();
  const token = issued ? issued.token : '$TOKEN';
  const firstView = eps.find((e) => e.kind !== 'function' && e.methods.includes('GET'))?.name ?? 'employees';
  const examples = [
    `curl ${url}/${firstView} -H "Authorization: Bearer ${token}"`,
    `curl "${url}/${firstView}?select=*&limit=10&order=id.desc" -H "Authorization: Bearer ${token}"`,
    ...eps.filter((e) => e.kind === 'function' && e.methods).slice(0, 1).map((e) =>
      `curl -X POST ${url}/rpc/${e.name} -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" -d '{ … }'`),
  ].join('\n');

  const pill = (ok: boolean, text: Raw | string) => html`<li class="${ok ? 'is-ok' : 'is-bad'}"><span aria-hidden="true">${ok ? '✓' : '✗'}</span> <span class="sr-only">${ok ? tx('apip.ok') : tx('apip.problem')}</span>${text}</li>`;
  const main = html`${appHeader(a, 'api', s)}
    <p class="muted api-intro">${tx.rich('apip.intro', { schema: html`<code>${API_SCHEMA}</code>`, role: html`<code>role</code>`, user: html`<code>meta.app_user()</code>`, has: html`<code>meta.has_role()</code>` })}</p>
    <ul class="api-status" aria-label="${tx('apip.status')}">
      ${pill(status.ok, html`${tx.rich('apip.at', { url: html`<code>${url}</code>` })} ${status.ok ? status.detail : html`<b>${tx('apip.not_reachable')}</b> (${status.detail})`}`)}
      ${role ? pill(!problem, problem ?? tx.rich('apip.dedicated', { role: html`<code>${role}</code>` })) : pill(false, tx('apip.no_role'))}
      ${role && !problem ? pill(!!granted?.ok, granted?.ok ? tx.rich('apip.may_switch', { role: html`<code>${role}</code>` }) : tx.rich('apip.run_grant', { run: html`<b>${tx('apip.run')}</b>`, sql: html`<code>grant ${role} to pgkiln_authenticator;</code>` })) : ''}
    </ul>
    <div class="columns api-top">
      ${region(tx('apip.setup'), html`<form method="post" action="${BASE}/apps/${a.id}/api">${csrf(s)}
          ${input('api_role', tx('apip.api_database_role'), role, { placeholder: tx('apip.e_g_myapp_api'), help: tx('apip.grant_it_only_the_api') })}
          <div class="field"><label class="check"><input type="checkbox" name="api_self_tokens" value="true"${a.api_self_tokens ? raw(' checked') : ''}> ${tx('apip.users_create_their_own_tokens')}</label>
            <small class="help">${tx.rich('apip.self_help', { account: html`<em>${tx('apip.my_account')}</em>` })}</small></div>
          <div class="buttons"><button class="btn btn-hot">${tx('apip.save')}</button></div>
        </form>`)}
      ${region(tx('apip.issue_a_token'), html`<p class="muted u-mt0">${tx.code('apip.for_development_and_trusted_scripts')}</p>
        <form method="post" action="${BASE}/apps/${a.id}/api/token">${csrf(s)}
          <div class="form-grid">
            ${input('username', tx('apip.account'), issued?.username ?? '', { required: true, auto: 'off' })}
            ${input('hours', tx('apip.valid_for_hours'), issued?.expiresInHours ?? 8, { type: 'number', help: `1 to ${MAX_TOKEN_HOURS}.` })}
          </div>
          <div class="buttons"><button class="btn btn-hot"${!problem ? '' : raw(' disabled')}>${tx('apip.issue_token')}</button></div>
        </form>
        ${issued ? html`<div class="field u-mt1" data-wide><label class="label" for="api_token">Token for ${issued.username} (shown once, valid ${issued.expiresInHours} h)</label>
          <textarea id="api_token" class="code" rows="4" readonly spellcheck="false">${issued.token}</textarea></div>` : ''}`)}
    </div>
    ${region(tx('apip.endpoints'), html`${eps.length
      ? html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>${tx('apip.path')}</th><th>${tx('apip.kind')}</th><th>${tx('apip.methods_for', { role: role ?? '' })}</th></tr></thead>
          <tbody>${eps.map((e) => html`<tr><td data-label="${tx('apip.path')}"><code>/${e.kind === 'function' ? 'rpc/' : ''}${e.name}</code></td><td data-label="${tx('apip.kind')}">${e.kind}</td><td data-label="${tx('apip.methods')}">${e.methods || html`<span class="muted">${tx('apip.none')}</span>`}</td></tr>`)}</tbody></table></div>`
      : html`<p class="muted u-mt0">${tx.rich(role ? 'apip.nothing_yet' : 'apip.nothing_yet_no_role', { schema: html`<code>${API_SCHEMA}</code>` })}</p>`}
      <h3 class="api-sub">${tx('apip.try_it')}</h3>
      <pre class="source">${examples}</pre>
      <p class="muted small">${tx.rich('apip.reload', { sql: html`<code>notify pgrst, 'reload schema';</code>`, link: html`<a href="${url}/" target="_blank" rel="noopener">${url}/</a>` })}</p>`,
      html`<span class="count">${eps.length}</span>`)}
    ${await clientsRegion(s, a, secret, !problem)}`;
  return shell(s, `${a.name} REST API`, [[tx('apip.app_builder'), BASE], [a.name, `${BASE}/apps/${a.id}`], [tx('apip.rest_api')]], main);
}

export async function apiRoutes(app: FastifyInstance) {
  const appOr404 = async (id: string) => owner.one('select * from meta.app where id = $1', [id]);

  app.get(`${BASE}/apps/:id/api`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOr404(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    return send(reply, s, await apiPage(s, a));
  });

  app.post(`${BASE}/apps/:id/api`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const role = req.body?.api_role?.trim() || null;
    try {
      const problem = role ? await apiRoleProblem(role) : null;
      if (problem) throw new Error(problem);
      await owner.query('update meta.app set api_role = $2, api_self_tokens = $3, updated_at = now() where id = $1', [req.params.id, role, req.body?.api_self_tokens === 'true']);
      flash(s, role ? `API role set to ${role}.` : 'API role removed; new tokens work for the REST modules pgkiln serves only.');
    } catch (e) {
      flash(s, (e as Error).message, 'error');
    }
    return back(reply, s, `${BASE}/apps/${req.params.id}/api`);
  });

  // Renders the page directly (no redirect) so the token is never stored in the session.
  app.post(`${BASE}/apps/:id/api/token`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOr404(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    try {
      const issued = await issueApiToken(a.id, req.body?.username?.trim() ?? '', Number(req.body?.hours) || 8);
      await logActivity({ appId: a.id, username: issued.username, event: 'api_token', ip: clientIp(req), detail: `issued by ${s.username}, ${issued.expiresInHours} h` });
      return send(reply.header('cache-control', 'no-store'), s, await apiPage(s, a, issued));
    } catch (e) {
      flash(s, (e as Error).message, 'error');
      return back(reply, s, `${BASE}/apps/${a.id}/api`);
    }
  });

  // ---------------------------------------------------------------- OAuth clients
  // Pages with a new secret are rendered directly, never stored in the session.
  app.post(`${BASE}/apps/:id/api/clients`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOr404(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const b = req.body ?? {};
    try {
      const name = (b.name ?? '').trim().toLowerCase();
      const r = await owner.one(`select * from meta.oauth_create_client($1, $2, $3, $4, $5)`, [
        a.alias, name, splitRoles(b.roles ?? ''), b.description?.trim() || null, Number(b.token_minutes) || 60,
      ]);
      await logActivity({ appId: a.id, username: s.username, event: 'oauth_client', ip: clientIp(req), detail: `created ${name}` });
      return send(reply.header('cache-control', 'no-store'), s, await apiPage(s, a, undefined, { name, clientId: r.client_id, secret: r.client_secret, rotated: false }));
    } catch (e) {
      const err = e as { code?: string; message: string };
      flash(s, err.code === '23505' ? 'A client with this name already exists.' : err.code === '23514' ? tx('apip.check_the_name_lower_case') : err.message, 'error');
      return back(reply, s, `${BASE}/apps/${a.id}/api`);
    }
  });

  const clientOf = (appId: string, cid: string) =>
    owner.one('select id, name, client_id from meta.api_client where id = $1 and app_id = $2', [cid, appId]);

  app.post(`${BASE}/apps/:id/api/clients/:cid/rotate`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOr404(req.params.id);
    const c = a && (await clientOf(req.params.id, req.params.cid));
    if (!a || !c) return reply.code(404).send('Not found');
    const grace = [0, 24, 168].includes(Number(req.body?.grace)) ? Number(req.body?.grace) : 24;
    const r = await owner.one(`select meta.oauth_rotate_secret($1, make_interval(hours => $2)) as secret`, [c.client_id, grace]);
    await logActivity({ appId: a.id, username: s.username, event: 'oauth_client', ip: clientIp(req), detail: `new secret for ${c.name}, old valid ${grace} h` });
    return send(reply.header('cache-control', 'no-store'), s, await apiPage(s, a, undefined, { name: c.name, clientId: c.client_id, secret: r.secret, rotated: true, graceHours: grace }));
  });

  app.post(`${BASE}/apps/:id/api/clients/:cid/:op`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const c = await clientOf(req.params.id, req.params.cid);
    if (!c) return reply.code(404).send('Not found');
    const op = req.params.op;
    if (op === 'active') {
      const active = req.body?.active === 'true';
      await owner.query('update meta.api_client set active = $2 where id = $1', [c.id, active]);
      flash(s, active ? `${c.name} can get tokens again.` : `${c.name} is revoked: its tokens stop working now.`);
    } else if (op === 'roles') {
      await owner.query('update meta.api_client set roles = $2 where id = $1', [c.id, splitRoles(req.body?.roles ?? '')]);
      flash(s, tx('apip.roles_saved', { name: c.name }));
    } else if (op === 'modules') {
      // (sprint 178, migration 162) limit the client to REST modules of this application (blank: no limit)
      const names = [...new Set(String(req.body?.modules ?? '').split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))].slice(0, 50);
      const known = new Set((await owner.query<{ name: string }>('select name from meta.rest_module where app_id = $1', [req.params.id])).rows.map((m) => m.name));
      const unknown = names.filter((n) => !known.has(n));
      if (unknown.length) {
        flash(s, tx('apip.modules_unknown', { names: unknown.join(', ').slice(0, 200) }), 'error');
        return back(reply, s, `${BASE}/apps/${req.params.id}/api`);
      }
      await owner.query('update meta.api_client set rest_modules = $2 where id = $1', [c.id, names.length ? names : null]);
      flash(s, names.length ? tx('apip.modules_saved', { name: c.name, modules: names.join(', ') }) : tx('apip.modules_all', { name: c.name }));
    } else if (op === 'delete') {
      await owner.query('delete from meta.api_client where id = $1', [c.id]);
      flash(s, `${c.name} deleted.`);
    } else return reply.code(404).send('Not found');
    await logActivity({ appId: Number(req.params.id), username: s.username, event: 'oauth_client', ip: clientIp(req), detail: `${op} ${c.name}` });
    return back(reply, s, `${BASE}/apps/${req.params.id}/api`);
  });
}
