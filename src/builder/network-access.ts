import type { FastifyInstance, FastifyReply } from 'fastify';
import { owner } from '../db.ts';
import { html, raw } from '../html.ts';
import { icon } from '../icons.ts';
import { parseHostList, scopeForWorkspace } from '../network-acl.ts';
import { serverUrl, type RemoteServer } from '../remote-servers.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import { matches, restHosts, scopeProblem, urlProblem } from '../webclient.ts';
import { clearResponseCache } from '../websources.ts';
import { isAdmin } from './locks.ts';
import { back, BASE, csrf, developer, flash, input, region, send, shell, type Req } from './ui.ts';
import { workspaceAdmin } from './workspaces.ts';
import { tr } from './i18n.ts';

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
  const tx = tr(s);
  const main = html`<h1 class="u-mb1">${tx('na.title')}</h1><div class="alert alert-error" role="alert">${tx('na.refused')}</div>`;
  await send(reply.code(403), s, shell(s, tx('na.title'), [[tx('rail.admin')], [tx('na.title')]], main, 'users'));
}

const when = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '');
const entries = (list: string[], none: string) => (list.length ? html`<ul class="host-list">${list.map((h) => html`<li><code>${h}</code></li>`)}</ul>` : html`<p class="muted">${none}</p>`);

export async function networkAccessRoutes(app: FastifyInstance) {
  app.get(`${BASE}/network`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const m = await manageable(s, req.query.ws);
    if (!m) return refuse(s, reply);
    const tx = tr(s);
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
    // (141) the hosts the workspace's remote servers stand for now, and whether a call to them would pass
    const scopeNow = await scopeForWorkspace(w.id, 'check');
    const servers = (await owner.query<RemoteServer>('select * from meta.remote_server where workspace_id = $1 order by static_id', [w.id])).rows.map((x) => {
      const u = serverUrl(x);
      let host = '';
      let problem: string | null = u.problem;
      if (u.url)
        try {
          const url = new URL(u.url);
          host = url.host;
          problem = urlProblem(url) ?? scopeProblem(scopeNow, url);
        } catch {
          problem = 'not a valid URL';
        }
      return { ...x, url: u.url, from: u.from, host, problem };
    });
    const serversOf = (entry: string) => servers.filter((x) => x.host && (() => {
      try {
        return matches([entry], new URL(`https://${x.host}`));
      } catch {
        return false;
      }
    })()).map((x) => x.static_id);
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
        verdict = { ok: false, text: tx('na.url_invalid') };
      }
      if (url) {
        const scope = await scopeForWorkspace(w.id, 'check');
        const problem = urlProblem(url) ?? scopeProblem(scope, url);
        verdict = problem ? { ok: false, text: problem } : { ok: true, text: tx('na.url_ok', { host: url.host }) };
      }
    }
    const main = html`
      <div class="title-row"><h1>${tx('na.title')}</h1></div>
      <p class="muted u-mt0">${tx.rich('na.intro', { web_request: html`<code>meta.web_request</code>` })}</p>
      <div class="columns wide-left">
        ${region(tx('na.workspace', { name: w.name }), html`<form method="post" action="${BASE}/network">${csrf(s)}<input type="hidden" name="ws" value="${w.id}">
            <fieldset class="field"><legend class="label">${tx('na.outgoing')}</legend><div class="radio-group">
              <label class="check"><input type="radio" name="restricted" value="false"${w.network_restricted ? '' : raw(' checked')}> ${tx('na.any_host')}</label>
              <label class="check"><input type="radio" name="restricted" value="true"${w.network_restricted ? raw(' checked') : ''}> ${tx('na.only_hosts')}</label>
            </div></fieldset>
            <div class="field"><label class="label" for="f_hosts">${tx('na.hosts')}</label>
              <textarea id="f_hosts" name="hosts" rows="6" spellcheck="false">${w.network_hosts.join('\n')}</textarea>
              <small class="help">${tx.rich('na.hosts_help', { a: html`<code>api.example.com</code>`, b: html`<code>*.example.com</code>`, c: html`<code>api.example.com:8443</code>` })}</small></div>
            ${unreachable.length ? html`<div class="alert alert-warning" role="status">${tx('na.unreachable', { hosts: unreachable.join(', ') })}</div>` : ''}
            ${w.network_hosts.some((h) => serversOf(h).length) ? html`<p class="muted small">${tx('na.servers_on_hosts', { list: w.network_hosts.filter((h) => serversOf(h).length).map((h) => `${h} (${serversOf(h).join(', ')})`).join('; ') })}</p>` : ''}
            <div class="buttons"><button class="btn btn-hot">${tx('na.save')}</button></div></form>`, '', 'workspace-list')}
        ${region(tx('na.installation'), html`<p class="muted u-mt0">${tx.rich('na.installation_note', { env: html`<code>PGKILN_REST_ALLOWED_HOSTS</code>` })}</p>
            ${inst.allowed.includes('*') ? html`<p>${tx.rich('na.any_public', { star: html`<code>*</code>` })}</p>` : entries(inst.allowed, tx('na.none'))}
            ${m.admin ? html`<h3 class="u-mt1">${tx('na.private')}</h3><p class="muted small">${tx.rich('na.private_note', { env: html`<code>PGKILN_REST_PRIVATE_HOSTS</code>` })}</p>${entries(inst.private, tx('na.none'))}` : ''}`)}
      </div>
      ${region(tx('na.servers'), html`<p class="muted u-mt0">${tx.rich('na.servers_intro', { link: html`<a href="${BASE}/remote-servers">${tx('na.servers_link')}</a>` })}</p>
        <div class="table-wrap"><table class="report report-reflow">
        <thead><tr><th>${tx('na.col.server')}</th><th>${tx('na.col.host')}</th><th>${tx('na.col.from')}</th><th>${tx('na.col.called')}</th></tr></thead>
        <tbody>${servers.length ? servers.map((x) => html`<tr><td data-label="${tx('na.col.server')}">${x.static_id}</td>
            <td data-label="${tx('na.col.host')}" class="u-break">${x.host ? html`<code>${x.host}</code>` : html`<span class="muted">${tx('na.host_none')}</span>`}</td>
            <td data-label="${tx('na.col.from')}">${x.from === 'env' ? x.env_var : x.from === 'stored' ? tx('na.base_url') : ''}</td>
            <td data-label="${tx('na.col.called')}">${x.problem ? html`<span class="tag tag-error">${tx('na.no')}</span> <span class="muted small">${x.problem}</span>` : html`<span class="tag tag-ok">${tx('na.yes')}</span>`}</td></tr>`)
          : html`<tr><td colspan="4" class="empty">${tx('na.no_servers')}</td></tr>`}</tbody></table></div>`, '', 'servers')}
      ${region(tx('na.check'), html`<form method="get" action="${BASE}/network" class="search u-mwnone">
          <input type="hidden" name="ws" value="${w.id}">
          ${input('url', tx('na.url'), tryUrl, { type: 'url', placeholder: 'https://api.example.com/v1/items' })}
          <div class="buttons"><button class="btn">${icon('search')} ${tx('na.check_btn')}</button></div></form>
        <div role="status">${verdict ? html`<div class="alert ${verdict.ok ? 'alert-success' : 'alert-error'}">${verdict.text}</div>` : ''}</div>
        <p class="muted small">${tx('na.check_note')}</p>`)}
      ${m.admin ? region(tx('na.workspaces'), html`<div class="table-wrap"><table class="report report-reflow">
          <thead><tr><th>${tx('na.col.workspace')}</th><th>${tx('na.col.outgoing')}</th></tr></thead>
          <tbody>${all.map((x) => html`<tr><td data-label="${tx('na.col.workspace')}"><a href="${BASE}/network?ws=${x.id}">${x.name}</a></td>
            <td data-label="${tx('na.col.outgoing')}">${x.network_restricted ? html`<span class="tag">${icon('lock')} ${tx(x.n === 1 ? 'na.n_hosts_one' : 'na.n_hosts', { n: x.n })}</span>` : html`<span class="muted">${tx('na.inst_list')}</span>`}</td></tr>`)}</tbody></table></div>`) : ''}
      ${region(tx('na.refusals'), html`<p class="muted u-mt0">${tx('na.refusals_intro')}</p>
        <div class="table-wrap"><table class="report report-reflow">
        <thead><tr><th>${tx('na.col.when')}</th><th>${tx('na.col.app')}</th><th>${tx('na.col.call')}</th><th>${tx('na.col.host')}</th><th>${tx('na.col.refused_by')}</th></tr></thead>
        <tbody>${refusals.length ? refusals.map((r) => html`<tr><td data-label="${tx('na.col.when_short')}">${when(r.at)}</td><td data-label="${tx('na.col.app')}">${r.alias ?? html`<span class="muted">–</span>`}</td>
            <td data-label="${tx('na.col.call')}" class="u-break">${r.what}<br><span class="muted small">${r.url ?? ''}</span></td>
            <td data-label="${tx('na.col.host')}" class="u-break"><code>${r.host}</code></td>
            <td data-label="${tx('na.col.refused_by')}">${r.list === 'workspace' ? tx('na.ws_list') : tx('na.inst_list')}</td></tr>`)
          : html`<tr><td colspan="5" class="empty">${tx('na.no_refusals')}</td></tr>`}</tbody></table></div>`, '', 'refusals')}`;
    return send(reply, s, shell(s, tx('na.title'), [[tx('rail.admin')], [tx('na.title')]], main, 'users'));
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
      flash(s, tr(s)(restricted ? (hosts.length ? 'na.saved_only' : 'na.saved_none') : 'na.saved_inst'));
    } catch (e) {
      flash(s, (e as Error).message, 'error');
    }
    return back(reply, s, target);
  });
}
