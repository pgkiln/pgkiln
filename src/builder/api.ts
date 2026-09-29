import type { FastifyInstance } from 'fastify';
import { apiRoleProblem, apiStatus, apiUrl, issueApiToken, MAX_TOKEN_HOURS } from '../api.ts';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import { appHeader, back, BASE, csrf, developer, flash, input, region, send, shell, type Req } from './ui.ts';

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

async function apiPage(s: Session, a: any, issued?: { token: string; username: string; expiresInHours: number }) {
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
        <p class="muted" style="margin-top:0">PostgREST runs next to pgapex and serves the <code>${API_SCHEMA}</code> schema over HTTP. Requests carry a JWT whose <code>role</code> claim is this application’s API role; row level security uses the same <code>meta.app_user()</code> and <code>meta.has_role()</code> as the web pages.</p>
        <form method="post" action="${BASE}/apps/${a.id}/api">${csrf(s)}
          <div class="form-grid">
            ${input('api_role', 'API database role', role, { placeholder: 'e.g. hr_api', help: 'Grant it only the api schema’s views and functions, and grant it to pgapex_authenticator. Empty disables tokens for this app.' })}
          </div>
          <div class="buttons"><button class="btn btn-hot">Save</button></div>
        </form>
        <ul class="checklist" style="margin-top:1rem">
          ${check(status.ok, html`PostgREST at <code>${url}</code>: ${status.ok ? status.detail : html`<b>not reachable</b> (${status.detail})`}`)}
          ${role ? check(!problem, problem ?? html`<code>${role}</code> is a dedicated role`) : check(false, 'No API role: tokens can’t be issued')}
          ${role && !problem ? check(!!granted?.ok, granted?.ok ? html`pgapex_authenticator may switch to <code>${role}</code>` : html`<b>run</b> <code>grant ${role} to pgapex_authenticator;</code>`) : ''}
        </ul>`)}
      ${region('Issue a token', html`
        <p class="muted" style="margin-top:0">For development and trusted scripts. The token acts as the account in this application until it expires. Roles are read at each request, and deactivating the account or revoking its access stops the token at once (PostgREST’s pre-request check <code>meta.api_check</code>). To invalidate all tokens, change <code>API_JWT_SECRET</code>.</p>
        <form method="post" action="${BASE}/apps/${a.id}/api/token">${csrf(s)}
          <div class="form-grid">
            ${input('username', 'Account', issued?.username ?? '', { required: true, auto: 'off' })}
            ${input('hours', 'Valid for (hours)', issued?.expiresInHours ?? 8, { type: 'number', help: `1 to ${MAX_TOKEN_HOURS}.` })}
          </div>
          <div class="buttons"><button class="btn btn-hot"${role && !problem ? '' : raw(' disabled')}>Issue token</button></div>
        </form>
        ${issued ? html`<div class="field" data-wide style="margin-top:1rem"><label class="label" for="api_token">Token for ${issued.username} (shown once, valid ${issued.expiresInHours} h)</label>
          <textarea id="api_token" class="code" rows="4" readonly spellcheck="false">${issued.token}</textarea></div>` : ''}`)}
    </div>
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
      flash(s, role ? `API role set to ${role}.` : 'API role removed; new tokens can’t be issued.');
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
}
