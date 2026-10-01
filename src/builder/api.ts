import type { FastifyInstance } from 'fastify';
import { apiRoleProblem, apiStatus, apiUrl, issueApiToken, MAX_TOKEN_HOURS } from '../api.ts';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import { publicUrl } from '../sso.ts';
import { appHeader, back, BASE, csrf, developer, flash, input, region, send, shell, type Req } from './ui.ts';
import { roleHints, roleHintsHtml, splitRoles } from './users.ts';

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
      `select id, name, description, client_id, roles, token_minutes, active, secret_changed_at, last_used_at,
              previous_valid_until > now() as grace, previous_valid_until
         from meta.api_client where app_id = $1 order by name`,
      [a.id],
    )
  ).rows;
  const hints = (await roleHints([a.id])).get(a.id) ?? [];
  const tokenUrl = `${publicUrl()}/oauth/token`;
  const when = (d: Date | string | null) => (d ? (d instanceof Date ? d.toISOString() : String(d)).slice(0, 16).replace('T', ' ') : '');
  const action = (c: any, path: string, label: string, extra: Raw | '' = '', cls = 'btn') =>
    html`<form method="post" action="${BASE}/apps/${a.id}/api/clients/${c.id}/${path}" class="inline-form">${csrf(s)}${extra}<button class="${cls}">${label}</button></form>`;
  return region(
    'OAuth clients',
    html`<p class="muted u-mt0">For systems that call the API, like ORDS's <code>oauth.create_client</code>. A client exchanges its id and secret for an access token at
        <code>${tokenUrl}</code> (<code>grant_type=client_credentials</code>) and fetches a new one when it expires, so tokens never need rotating by hand.
        The client acts as <code>client:&lt;name&gt;</code> with the roles below, read at every request; revoking works at once.</p>
      ${secret
        ? html`<div class="alert alert-success" role="status">${secret.rotated ? `New secret for ${secret.name}` : `Client ${secret.name} created`}. Copy the secret now: it is shown only once.${
            secret.rotated && secret.graceHours ? ` The previous secret keeps working for ${secret.graceHours} hours.` : ''}</div>
          <div class="form-grid">
            <div class="field"><label class="label" for="oauth_id">Client ID</label><input id="oauth_id" class="code" readonly value="${secret.clientId}"></div>
            <div class="field"><label class="label" for="oauth_secret">Client secret</label><input id="oauth_secret" class="code" readonly value="${secret.secret}"></div>
          </div>
          <pre class="source">curl -u '${secret.clientId}:${secret.secret}' -d grant_type=client_credentials ${tokenUrl}</pre>`
        : ''}
      ${clients.length
        ? html`<div class="table-wrap"><table class="report"><thead><tr><th>Client</th><th>Roles</th><th>Token</th><th>Secret</th><th>Last used</th><th></th></tr></thead><tbody>
            ${clients.map((c) => html`<tr${c.active ? '' : raw(' class="muted"')}>
              <td data-label="Client"><strong>${c.name}</strong>${c.active ? '' : html` <span class="tag">revoked</span>`}<br><code>${c.client_id}</code>${c.description ? html`<br><small class="help">${c.description}</small>` : ''}</td>
              <td data-label="Roles"><form method="post" action="${BASE}/apps/${a.id}/api/clients/${c.id}/roles" class="search roles-form u-m0 u-mwnone">${csrf(s)}
                <input name="roles" value="${c.roles.join(', ')}" aria-label="Roles of ${c.name}" placeholder="no roles"><button class="btn">Save</button>${roleHintsHtml(hints, 'Add')}</form></td>
              <td data-label="Token">${c.token_minutes} min</td>
              <td data-label="Secret">${when(c.secret_changed_at)}${c.grace ? html`<br><small class="help">old secret valid until ${when(c.previous_valid_until)}</small>` : ''}</td>
              <td data-label="Last used">${when(c.last_used_at) || html`<span class="muted">never</span>`}</td>
              <td class="actions">
                ${action(c, 'rotate', 'New secret', html`<select name="grace" aria-label="Keep the old secret"><option value="24">old valid 24 h</option><option value="168">old valid 7 days</option><option value="0">old invalid now</option></select>`)}
                ${action(c, 'active', c.active ? 'Revoke' : 'Reactivate', html`<input type="hidden" name="active" value="${c.active ? 'false' : 'true'}">`)}
                ${action(c, 'delete', 'Delete', '', 'btn btn-danger')}
              </td></tr>`)}
          </tbody></table></div>`
        : html`<p class="muted">No clients yet.</p>`}
      <form method="post" action="${BASE}/apps/${a.id}/api/clients" class="u-mt1">${csrf(s)}
        <div class="form-grid">
          ${input('name', 'Name', '', { required: true, placeholder: 'e.g. payroll-sync', help: 'Lower case letters, digits, . _ -' })}
          <div class="field"><label class="label" for="f_roles">Roles</label><input id="f_roles" name="roles" placeholder="comma separated, or pick below">${roleHintsHtml(hints)}</div>
          ${input('token_minutes', 'Token lifetime (minutes)', 60, { type: 'number', help: '5 to 1440.' })}
          ${input('description', 'Description', '', { placeholder: 'who uses it' })}
        </div>
        <div class="buttons"><button class="btn btn-hot"${usable ? '' : raw(' disabled')}>Create client</button></div>
      </form>`,
  );
}

async function apiPage(s: Session, a: any, issued?: { token: string; username: string; expiresInHours: number }, secret?: NewSecret) {
  const role: string | null = a.api_role;
  const [status, problem, granted, eps] = await Promise.all([
    apiStatus(),
    role ? apiRoleProblem(role) : Promise.resolve(null),
    role ? owner.one(`select pg_has_role('pgapex_authenticator', r.oid, 'MEMBER') as ok from pg_roles r where r.rolname = $1`, [role]) : Promise.resolve(null),
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

  const check = (ok: boolean, text: Raw | string) => html`<li>${ok ? '✓' : '✗'} ${text}</li>`;
  const main = html`${appHeader(a, 'api')}
    <div class="columns">
      ${region('Setup', html`
        <p class="muted u-mt0">PostgREST runs next to pgapex and serves the <code>${API_SCHEMA}</code> schema over HTTP. Requests carry a JWT whose <code>role</code> claim is this application’s API role; row level security uses the same <code>meta.app_user()</code> and <code>meta.has_role()</code> as the web pages.</p>
        <form method="post" action="${BASE}/apps/${a.id}/api">${csrf(s)}
          <div class="form-grid">
            ${input('api_role', 'API database role', role, { placeholder: 'e.g. myapp_api', help: 'For PostgREST: grant it only the api schema’s views and functions, and grant it to pgapex_authenticator. Empty: tokens work for the REST modules pgapex serves (Shared Components → REST modules) only.' })}
          </div>
          <div class="buttons"><button class="btn btn-hot">Save</button></div>
        </form>
        <ul class="checklist u-mt1">
          ${check(status.ok, html`PostgREST at <code>${url}</code>: ${status.ok ? status.detail : html`<b>not reachable</b> (${status.detail})`}`)}
          ${role ? check(!problem, problem ?? html`<code>${role}</code> is a dedicated role`) : check(false, 'No API role: tokens are for the REST modules pgapex serves only')}
          ${role && !problem ? check(!!granted?.ok, granted?.ok ? html`pgapex_authenticator may switch to <code>${role}</code>` : html`<b>run</b> <code>grant ${role} to pgapex_authenticator;</code>`) : ''}
        </ul>`)}
      ${region('Issue a token', html`
        <p class="muted u-mt0">For development and trusted scripts. The token acts as the account in this application until it expires. Roles are read at each request, and deactivating the account or revoking its access stops the token at once (PostgREST’s pre-request check <code>meta.api_check</code>). To invalidate all tokens, change <code>API_JWT_SECRET</code>.</p>
        <form method="post" action="${BASE}/apps/${a.id}/api/token">${csrf(s)}
          <div class="form-grid">
            ${input('username', 'Account', issued?.username ?? '', { required: true, auto: 'off' })}
            ${input('hours', 'Valid for (hours)', issued?.expiresInHours ?? 8, { type: 'number', help: `1 to ${MAX_TOKEN_HOURS}.` })}
          </div>
          <div class="buttons"><button class="btn btn-hot"${!problem ? '' : raw(' disabled')}>Issue token</button></div>
        </form>
        ${issued ? html`<div class="field u-mt1" data-wide><label class="label" for="api_token">Token for ${issued.username} (shown once, valid ${issued.expiresInHours} h)</label>
          <textarea id="api_token" class="code" rows="4" readonly spellcheck="false">${issued.token}</textarea></div>` : ''}`)}
    </div>
    ${await clientsRegion(s, a, secret, !problem)}
    ${region('Endpoints', eps.length
      ? html`<div class="table-wrap"><table class="report"><thead><tr><th>Path</th><th>Kind</th><th>Methods for ${role}</th></tr></thead>
          <tbody>${eps.map((e) => html`<tr><td><code>/${e.kind === 'function' ? 'rpc/' : ''}${e.name}</code></td><td>${e.kind}</td><td>${e.methods || html`<span class="muted">none</span>`}</td></tr>`)}</tbody></table></div>`
      : html`<p class="muted">Nothing in the <code>${API_SCHEMA}</code> schema yet${role ? '' : ', or no API role set'}. Create views and functions there and grant them to the API role.</p>`)}
    ${region('Try it', html`<pre class="source">${examples}</pre>
      <p class="muted">Schema changes: run <code>notify pgrst, 'reload schema';</code> so PostgREST picks them up. OpenAPI description: <a href="${url}/" target="_blank" rel="noopener">${url}/</a>.</p>`)}`;
  return shell(s, `${a.name} REST API`, [['App Builder', BASE], [a.name, `${BASE}/apps/${a.id}`], ['REST API']], main);
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
      await owner.query('update meta.app set api_role = $2, updated_at = now() where id = $1', [req.params.id, role]);
      flash(s, role ? `API role set to ${role}.` : 'API role removed; new tokens work for the REST modules pgapex serves only.');
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
      flash(s, err.code === '23505' ? 'A client with this name already exists.' : err.code === '23514' ? 'Check the name (lower case letters, digits, . _ -) and the token lifetime (5–1440 minutes).' : err.message, 'error');
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
      flash(s, `Roles of ${c.name} saved.`);
    } else if (op === 'delete') {
      await owner.query('delete from meta.api_client where id = $1', [c.id]);
      flash(s, `${c.name} deleted.`);
    } else return reply.code(404).send('Not found');
    await logActivity({ appId: Number(req.params.id), username: s.username, event: 'oauth_client', ip: clientIp(req), detail: `${op} ${c.name}` });
    return back(reply, s, `${BASE}/apps/${req.params.id}/api`);
  });
}
