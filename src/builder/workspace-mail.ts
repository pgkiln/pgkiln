import type { FastifyInstance, FastifyReply } from 'fastify';
import { owner } from '../db.ts';
import { html } from '../html.ts';
import type { MailService } from '../mail/mail.ts';
import { PROVIDER_LABELS, PROVIDERS, type Provider } from '../mail/providers.ts';
import { encryptSecret } from '../secrets.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import { formValues, parseForm, PROVIDER_TEXT, runCheck, serviceForm } from './mail.ts';
import { back, BASE, csrf, developer, flash, region, select, send, shell, type Req } from './ui.ts';
import { workspaceAdmin } from './workspaces.ts';

// (sprint 118, WS-9; APEX 26.1 workspace-level SMTP credentials) A workspace's
// own mail service, managed by its administrators on /builder/workspaces/:id/mail:
// a meta.mail_service row with workspace_id (one per workspace), named
// WORKSPACE_<id>. Its applications that an administrator gave no service send
// through it. The secret is encrypted with PGKILN_SECRET_KEY like a web
// credential's, write-only (never shown, never exported). It has no base URL
// or token URL (the providers' own APIs only), and its SMTP host must be on the
// installation's allow-list and the workspace's network access list
// (src/mail/mail.ts serviceSettings, checked again on every send).

type Service = MailService & { has_secret: boolean };

async function wsAdminOnly(s: Session, reply: FastifyReply, wsId: string) {
  if (await workspaceAdmin(s.username, wsId)) return true;
  const main = html`<h1 class="u-mb1">Workspace mail service</h1><div class="alert alert-error" role="alert">Only the workspace's administrators manage its mail service.</div>`;
  await send(reply.code(403), s, shell(s, 'Workspace mail service', [['Administration'], ['Workspace mail service']], main, 'users'));
  return false;
}

const serviceOf = (wsId: number | string) =>
  owner.one<Service>('select *, secret_enc is not null as has_secret from meta.mail_service where workspace_id = $1', [wsId]);

export async function workspaceMailRoutes(app: FastifyInstance) {
  const page = async (s: Session, req: Req, reply: FastifyReply, tried: { ok: boolean; text: string; to?: string; from?: string } | null = null, typed?: ReturnType<typeof parseForm>) => {
    const w = await owner.one<{ id: number; name: string }>('select id, name from meta.workspace where id = $1', [req.params.id]);
    if (!w) return reply.code(404).send('Not found');
    const x = await serviceOf(w.id);
    const wanted = String(req.query.provider ?? typed?.provider ?? '');
    const provider: Provider = (PROVIDERS as readonly string[]).includes(wanted) ? (wanted as Provider) : x?.provider ?? 'smtp';
    const users = (await owner.query<{ alias: string; own: string | null }>(
      `select a.alias, (select s.name from meta.app_mail_service m join meta.mail_service s on s.id = m.service_id where m.app_id = a.id) as own
         from meta.app a where meta.app_workspace(a.id) = $1 order by a.alias`, [w.id])).rows;
    const shown = typed ? { ...x, description: typed.description, provider: typed.provider, settings: typed.settings, senders: typed.senders, enabled: typed.enabled } : x ?? {};
    const main = html`
      <div class="title-row"><h1>Mail service · ${w.name}</h1></div>
      <p class="muted u-mt0">This workspace's own mail service: its applications that an administrator gave no service of their own send through it (<code>meta.send_mail()</code>, the Send e-mail process). The secret is stored encrypted and never shown again. It uses the provider's own API; an SMTP server must be on the installation's allow-list and this workspace's <a href="${BASE}/network">network access</a> list.</p>
      <div class="mail-form-page">
        ${region('Settings', html`
          <form method="get" class="provider-switch">${select('provider', 'Provider', provider, PROVIDERS.map((p): [string, string] => [p, PROVIDER_LABELS[p]]),
            x && provider !== x.provider ? 'Not saved yet: fill in the settings below and save to switch.' : PROVIDER_TEXT[provider][1])}<button class="btn btn-sm">Change</button></form>
          ${serviceForm(shown, provider, `${BASE}/workspaces/${w.id}/mail`, csrf(s), !x, tried, { id: w.id })}
          ${x ? html`<form method="post" action="${BASE}/workspaces/${w.id}/mail/delete" class="danger-zone">${csrf(s)}
            <button class="btn btn-danger" data-confirm="Delete this workspace's mail service? Its applications without a service of their own can't send mail then.">Delete service</button></form>` : ''}`)}
      </div>
      ${region('Applications', html`<div class="table-wrap"><table class="report report-reflow">
        <thead><tr><th>Application</th><th>Sends through</th></tr></thead>
        <tbody>${users.length ? users.map((a) => html`<tr><td data-label="Application">${a.alias}</td>
            <td data-label="Sends through">${a.own ? html`${a.own} <span class="muted">(chosen by an administrator)</span>` : x ? 'this service' : html`<span class="muted">nothing yet</span>`}</td></tr>`)
          : html`<tr><td colspan="2" class="empty">No applications.</td></tr>`}</tbody></table></div>`)}`;
    return send(reply, s, shell(s, `Mail service · ${w.name}`, [['Administration'], [w.name, `${BASE}/workspaces/${w.id}`], ['Mail service']], main, 'users'));
  };

  app.get(`${BASE}/workspaces/:id(^\\d{1,9}$)/mail`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await wsAdminOnly(s, reply, req.params.id))) return;
    return page(s, req, reply);
  });

  app.post(`${BASE}/workspaces/:id(^\\d{1,9}$)/mail`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await wsAdminOnly(s, reply, req.params.id))) return;
    const w = await owner.one<{ id: number }>('select id from meta.workspace where id = $1', [req.params.id]);
    if (!w) return reply.code(404).send('Not found');
    const b = (req.body ?? {}) as Record<string, string | undefined>;
    try {
      const old = await serviceOf(w.id);
      const v = formValues(b, !!old?.has_secret && b.remove_secret !== 'true' && old.provider === parseForm(b).provider, { workspace: true });
      const secret = b.secret ? encryptSecret(b.secret) : null;
      if (old)
        await owner.query(
          `update meta.mail_service set description = $2, provider = $3, settings = $4, senders = $5, enabled = $6, updated_at = now(),
                  secret_enc = case when $8 then null when $7::text is null then secret_enc else $7 end
            where id = $1 and workspace_id = $9`,
          [old.id, v.description, v.provider, JSON.stringify(v.settings), v.senders, v.enabled, secret, b.remove_secret === 'true' && !b.secret, w.id]);
      else
        await owner.query(
          `insert into meta.mail_service (name, description, provider, settings, senders, enabled, secret_enc, workspace_id) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [`WORKSPACE_${w.id}`, v.description, v.provider, JSON.stringify(v.settings), v.senders, v.enabled, secret, w.id]);
      await logActivity({ appId: null, username: s.username, event: 'mail_service', ip: clientIp(req), detail: `${old ? 'changed' : 'added'} the mail service of workspace ${w.id} (${v.provider})` });
      flash(s, old ? 'Mail service saved.' : 'Mail service added: send a test mail to check it.');
    } catch (e) {
      flash(s, (e as Error).message.includes('mail_service_name_key') ? `A service named WORKSPACE_${w.id} exists already: an administrator renames it first.` : (e as Error).message, 'error');
    }
    return back(reply, s, `${BASE}/workspaces/${w.id}/mail`);
  });

  // Test connection / Send test mail, through the same checks as sending (JSON for builder.js; else the page again)
  app.post(`${BASE}/workspaces/:id(^\\d{1,9}$)/mail/check`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await wsAdminOnly(s, reply, req.params.id))) return;
    const w = await owner.one<{ id: number }>('select id from meta.workspace where id = $1', [req.params.id]);
    if (!w) return reply.code(404).send('Not found');
    const b = (req.body ?? {}) as Record<string, string | undefined>;
    // only this workspace's stored secret (never another service's, whatever service_id says)
    const stored = await serviceOf(w.id);
    const result = await runCheck(b, stored ?? null, s.username, w.id);
    await logActivity({ username: s.username, event: 'mail_check', ip: clientIp(req), detail: `${b.check === 'send' ? 'send' : 'connection'} workspace ${w.id}: ${result.ok ? 'ok' : 'failed'}` });
    if (String(req.headers.accept ?? '').includes('application/json')) return reply.header('cache-control', 'no-store').send(result);
    return page(s, req, reply, { ...result, to: String(b.test_to ?? '').trim(), from: String(b.test_from ?? '').trim() }, parseForm(b));
  });

  app.post(`${BASE}/workspaces/:id(^\\d{1,9}$)/mail/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await wsAdminOnly(s, reply, req.params.id))) return;
    const r = await owner.query('delete from meta.mail_service where workspace_id = $1', [req.params.id]);
    await logActivity({ appId: null, username: s.username, event: 'mail_service', ip: clientIp(req), detail: `deleted the mail service of workspace ${req.params.id}` });
    flash(s, r.rowCount ? 'Mail service deleted.' : 'There was no mail service.');
    return back(reply, s, `${BASE}/workspaces/${req.params.id}/mail`);
  });
}
