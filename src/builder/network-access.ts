import type { FastifyInstance, FastifyReply } from 'fastify';
import { owner } from '../db.ts';
import { html, raw } from '../html.ts';
import { icon } from '../icons.ts';
import { parseHostList, scopeForWorkspace } from '../network-acl.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import { matches, restHosts, scopeProblem, urlProblem } from '../webclient.ts';
import { clearResponseCache } from '../websources.ts';
import { isAdmin } from './locks.ts';
import { back, BASE, csrf, developer, flash, input, region, send, shell, type Req } from './ui.ts';
import { workspaceAdmin } from './workspaces.ts';

// (sprint 118, WS-9; APEX 26.2 workspace network ACLs) Administration →
// Network access: the installation's allow-list (PGKILN_REST_ALLOWED_HOSTS,
// read-only: the server's environment), a workspace's own network access list
// (meta.workspace.network_restricted / network_hosts, src/network-acl.ts),
// "would this URL be called?", and the recent refusals. Administrators see and
// change every workspace's list; a workspace administrator their current
// workspace's only.

const id = (v: unknown) => (/^\d{1,9}$/.test(String(v ?? '')) ? Number(v) : null);

/** The workspace this developer may manage here (?ws=, else the current one; administrators: any), or null. */
async function manageable(s: Session, wanted: unknown): Promise<{ admin: boolean; workspace: number } | null> {
  const admin = await isAdmin(s.username);
  // ?ws= or the current workspace; a workspace administrator only one they administer
  const ws = id(wanted) ?? s.workspace?.id ?? (admin ? 1 : null);
  if (!ws || !(await workspaceAdmin(s.username, ws))) return null;
  return { admin, workspace: ws };
}

async function refuse(s: Session, reply: FastifyReply) {
  const main = html`<h1 class="u-mb1">Network access</h1><div class="alert alert-error" role="alert">Only administrators and workspace administrators manage network access.</div>`;
  await send(reply.code(403), s, shell(s, 'Network access', [['Administration'], ['Network access']], main, 'users'));
}

const when = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '');
const entries = (list: string[]) => (list.length ? html`<ul class="host-list">${list.map((h) => html`<li><code>${h}</code></li>`)}</ul>` : html`<p class="muted">None.</p>`);

export async function networkAccessRoutes(app: FastifyInstance) {
  app.get(`${BASE}/network`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const m = await manageable(s, req.query.ws);
    if (!m) return refuse(s, reply);
    const w = await owner.one<{ id: number; name: string; network_restricted: boolean; network_hosts: string[] }>(
      'select id, name, network_restricted, network_hosts from meta.workspace where id = $1', [m.workspace]);
    if (!w) return reply.code(404).send('Not found');
    const inst = restHosts();
    const [all, refusals] = await Promise.all([
      m.admin ? owner.query('select id, name, network_restricted, cardinality(network_hosts)::int as n from meta.workspace order by id = 1 desc, lower(name)').then((r) => r.rows) : [],
      owner.query(
        `select r.at, r.what, r.host, r.url, r.list, r.message, a.alias from meta.network_refusal r left join meta.app a on a.id = r.app_id
          where r.workspace_id = $1 order by r.id desc limit 100`, [w.id]).then((r) => r.rows),
    ]);
    // entries the installation's list never lets through (they narrow nothing: worth a warning)
    const unreachable = w.network_hosts.filter((h) => {
      const host = h.replace(/^\*\./, 'x.');
      try {
        return !matches([...inst.allowed, ...inst.private], new URL(`https://${host}`)) && !inst.allowed.includes('*');
      } catch {
        return false;
      }
    });
    const tryUrl = String(req.query.url ?? '').trim().slice(0, 2000);
    let verdict: { ok: boolean; text: string } | null = null;
    if (tryUrl) {
      let url: URL | null = null;
      try {
        url = new URL(tryUrl);
      } catch {
        verdict = { ok: false, text: 'The URL is not valid.' };
      }
      if (url) {
        const scope = await scopeForWorkspace(w.id, 'check');
        const problem = urlProblem(url) ?? scopeProblem(scope, url);
        verdict = problem ? { ok: false, text: problem } : { ok: true, text: `${url.host} may be called by this workspace's applications (the address it resolves to is checked when the call is made).` };
      }
    }
    const main = html`
      <div class="title-row"><h1>Network access</h1></div>
      <p class="muted u-mt0">Which web services the applications may call: <code>meta.web_request</code>, REST data sources, the Invoke API process and workflow step, web credential token endpoints, object storage and REST source catalogs. The installation's list applies to every workspace; a workspace's own list can only narrow it, never widen it. Private and loopback addresses stay refused unless the installation allows them, whatever a workspace lists.</p>
      <div class="columns wide-left">
        ${region(`Workspace ${w.name}`, html`<form method="post" action="${BASE}/network">${csrf(s)}<input type="hidden" name="ws" value="${w.id}">
            <fieldset class="field"><legend class="label">Outgoing calls of this workspace's applications</legend><div class="radio-group">
              <label class="check"><input type="radio" name="restricted" value="false"${w.network_restricted ? '' : raw(' checked')}> Any host the installation allows</label>
              <label class="check"><input type="radio" name="restricted" value="true"${w.network_restricted ? raw(' checked') : ''}> Only the hosts below (and the installation must allow them too)</label>
            </div></fieldset>
            <div class="field"><label class="label" for="f_hosts">Hosts</label>
              <textarea id="f_hosts" name="hosts" rows="6" spellcheck="false">${w.network_hosts.join('\n')}</textarea>
              <small class="help">One per line: <code>api.example.com</code>, <code>*.example.com</code> for its subdomains, <code>api.example.com:8443</code> for one port only. No scheme or path. Restricted with no hosts: no outgoing calls at all.</small></div>
            ${unreachable.length ? html`<div class="alert alert-warning" role="status">Not on the installation's list, so never reachable: ${unreachable.join(', ')}.</div>` : ''}
            <div class="buttons"><button class="btn btn-hot">Save</button></div></form>`, '', 'workspace-list')}
        ${region('Installation', html`<p class="muted u-mt0">Set in the server's environment by its administrators (<code>PGKILN_REST_ALLOWED_HOSTS</code>).</p>
            ${inst.allowed.includes('*') ? html`<p>Any public host (<code>*</code>).</p>` : entries(inst.allowed)}
            ${m.admin ? html`<h3 class="u-mt1">Private hosts</h3><p class="muted small">Hosts on private or loopback addresses that may be called (<code>PGKILN_REST_PRIVATE_HOSTS</code>).</p>${entries(inst.private)}` : ''}`)}
      </div>
      ${region('Check a URL', html`<form method="get" action="${BASE}/network" class="search u-mwnone">
          <input type="hidden" name="ws" value="${w.id}">
          ${input('url', 'URL', tryUrl, { type: 'url', placeholder: 'https://api.example.com/v1/items' })}
          <div class="buttons"><button class="btn">${icon('search')} Check</button></div></form>
        <div role="status">${verdict ? html`<div class="alert ${verdict.ok ? 'alert-success' : 'alert-error'}">${verdict.text}</div>` : ''}</div>
        <p class="muted small">Nothing is called: this applies the lists to the URL as they are now.</p>`)}
      ${m.admin ? region('Workspaces', html`<div class="table-wrap"><table class="report report-reflow">
          <thead><tr><th>Workspace</th><th>Outgoing calls</th></tr></thead>
          <tbody>${all.map((x) => html`<tr><td data-label="Workspace"><a href="${BASE}/network?ws=${x.id}">${x.name}</a></td>
            <td data-label="Outgoing calls">${x.network_restricted ? html`<span class="tag">${icon('lock')} ${x.n} host${x.n === 1 ? '' : 's'}</span>` : html`<span class="muted">the installation's list</span>`}</td></tr>`)}</tbody></table></div>`) : ''}
      ${region('Refused calls', html`<p class="muted u-mt0">The last 100 calls of this workspace that a list refused (kept 7 days). The application's debug log has them too.</p>
        <div class="table-wrap"><table class="report report-reflow">
        <thead><tr><th>When (UTC)</th><th>Application</th><th>Call</th><th>Host</th><th>Refused by</th></tr></thead>
        <tbody>${refusals.length ? refusals.map((r) => html`<tr><td data-label="When">${when(r.at)}</td><td data-label="Application">${r.alias ?? html`<span class="muted">–</span>`}</td>
            <td data-label="Call" class="u-break">${r.what}<br><span class="muted small">${r.url ?? ''}</span></td>
            <td data-label="Host" class="u-break"><code>${r.host}</code></td>
            <td data-label="Refused by">${r.list === 'workspace' ? 'the workspace\'s list' : 'the installation\'s list'}</td></tr>`)
          : html`<tr><td colspan="5" class="empty">No refused calls.</td></tr>`}</tbody></table></div>`, '', 'refusals')}`;
    return send(reply, s, shell(s, 'Network access', [['Administration'], ['Network access']], main, 'users'));
  });

  app.post(`${BASE}/network`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const m = await manageable(s, req.body?.ws);
    if (!m) return refuse(s, reply);
    const target = `${BASE}/network?ws=${m.workspace}`;
    try {
      const hosts = parseHostList(String(req.body?.hosts ?? ''));
      const restricted = req.body?.restricted === 'true';
      const r = await owner.query('update meta.workspace set network_restricted = $2, network_hosts = $3 where id = $1', [m.workspace, restricted, hosts]);
      if (!r.rowCount) return reply.code(404).send('Not found');
      // cached REST responses were fetched under the old list
      clearResponseCache();
      await logActivity({ appId: null, username: s.username, event: 'workspace', ip: clientIp(req),
        detail: `network access of workspace ${m.workspace}: ${restricted ? `only ${hosts.join(', ') || 'no hosts'}` : 'the installation\'s list'}`.slice(0, 1000) });
      flash(s, restricted ? `Saved: this workspace's applications call ${hosts.length ? 'only these hosts' : 'no hosts at all'}.` : 'Saved: the installation\'s list applies.');
    } catch (e) {
      flash(s, (e as Error).message, 'error');
    }
    return back(reply, s, target);
  });
}
