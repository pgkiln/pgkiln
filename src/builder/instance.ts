import type { FastifyInstance, FastifyReply } from 'fastify';
import { html } from '../html.ts';
import { attention, confirmKeyBackup, forgetAttention, instanceChecks, type Level } from '../instance-checks.ts';
import { relyingParty } from '../webauthn.ts';
import { configurationValue, CONFIGURATION, INSTANCE_SETTINGS, instanceSetting, origin, refreshInstanceSettings, saveInstanceSettings } from '../instance.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import { isAdmin } from './locks.ts';
import { policyRegion } from './security.ts';
import { releaseCheckRegion } from './workspace-home.ts';
import { back, BASE, csrf, developer, flash, region, send, shell, type Req } from './ui.ts';

// Workspace utilities → Instance settings (administrators; APEX: instance
// administration → instance settings): the settings of src/instance.ts, and a
// read-only overview of the server's configuration (secrets only as "set").

const crumbs: [string, string?][] = [['App Builder', BASE], ['Workspace utilities', `${BASE}/utilities`], ['Instance settings']];

async function adminOnly(s: Session, reply: FastifyReply) {
  if (await isAdmin(s.username)) return true;
  const main = html`<h1 class="u-mb1">Instance settings</h1><div class="alert alert-error" role="alert">Only administrators change instance settings.</div>`;
  await send(reply.code(403), s, shell(s, 'Instance settings', crumbs, main));
  return false;
}

const LEVEL_TEXT: Record<Level, string> = { ok: 'OK', info: 'Note', warning: 'Warning', error: 'Error' };

/** (sprint 133, SEC-6) Lockout checks: what could keep people out later (src/instance-checks.ts). */
async function checksRegion(s: Session, rpId: string) {
  const checks = await instanceChecks(rpId);
  const n = attention(checks);
  return region('Lockout checks', html`<p class="muted u-mt0">${n ? `${n} of these need attention.` : 'Nothing needs attention.'}
      The same checks run on the server with <code>pgkiln admin check</code>; <code>--url</code> shows which passkeys a new address would break.</p>
    <ul class="hits findings">${checks.map((c) => html`<li class="finding-${c.level}"><strong>${c.title}</strong><span></span>
      <span class="tag tag-${c.level}">${LEVEL_TEXT[c.level]}</span><span class="hit-snippet">${c.detail}</span>
      ${c.key === 'key_backup' && c.level === 'warning' ? html`<form method="post" action="${BASE}/instance/key-backup" class="u-mt0">${csrf(s)}
        <button class="btn btn-sm">I have a copy of this key</button></form>` : ''}</li>`)}</ul>`, '', 'lockout-checks');
}

const ORIGIN_TEXT = { builder: 'set here', environment: 'environment variable', default: 'default' } as const;

export async function instanceRoutes(app: FastifyInstance) {
  app.get(`${BASE}/instance`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply))) return;
    await refreshInstanceSettings(true);
    const main = html`<h1 class="u-mb1">Instance settings</h1>
      <p class="muted u-mt0">Settings for every application and the builder of this installation. A value set here wins over the
        environment variable; empty uses the environment variable or the default. Other servers of this installation pick up a change within 30 seconds.</p>
      <div class="columns wide-left">
        ${region('Sessions and sign-in', html`<form method="post" action="${BASE}/instance">${csrf(s)}
          <div class="form-grid">${INSTANCE_SETTINGS.map((x) => {
            const from = origin(x.key);
            return html`<div class="field"><label class="label" for="f_${x.key}">${x.label}</label>
              <input id="f_${x.key}" name="${x.key}" type="number" min="${x.min}" max="${x.max}" value="${from === 'builder' ? instanceSetting(x.key) : ''}" placeholder="${instanceSetting(x.key)} (${ORIGIN_TEXT[from]})">
              <small class="help">${x.help} In effect: <b>${instanceSetting(x.key)}</b> (${ORIGIN_TEXT[from]}; <code>${x.env}</code>, default ${x.default}).</small></div>`;
          })}</div>
          <div class="buttons"><button class="btn btn-hot">Save</button></div></form>`)}
        ${await checksRegion(s, relyingParty(req).rpId)}
        ${await releaseCheckRegion(s)}
        ${await policyRegion(s)}
        ${region('Configuration', html`<p class="muted u-mt0">Environment variables of this server (chapter 1 of the guide). Secrets show only whether they are set.</p>
          <div class="table-wrap"><table class="report report-reflow"><thead><tr><th>Variable</th><th>Value</th><th>Purpose</th></tr></thead>
          <tbody>${CONFIGURATION.map((c) => {
            const v = configurationValue(c);
            return html`<tr><td data-label="Variable"><code>${c.env}</code></td><td data-label="Value" class="cell-break">${v.set ? v.value : html`<span class="muted">${v.value}</span>`}</td><td data-label="Purpose">${c.help}</td></tr>`;
          })}</tbody></table></div>`)}
      </div>`;
    return send(reply, s, shell(s, 'Instance settings', crumbs, main));
  });

  app.post(`${BASE}/instance/key-backup`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply))) return;
    const ok = await confirmKeyBackup(s.username!);
    forgetAttention();
    if (ok) await logActivity({ username: s.username, event: 'secret_key', ip: clientIp(req), detail: 'backup confirmed' });
    flash(s, ok ? 'Backup of the instance key confirmed.' : 'PGKILN_SECRET_KEY is not set.', ok ? 'ok' : 'error');
    return back(reply, s, `${BASE}/instance#lockout-checks`);
  });

  app.post(`${BASE}/instance`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply))) return;
    const problem = await saveInstanceSettings(req.body ?? {});
    if (!problem)
      await logActivity({ username: s.username, event: 'instance_settings', ip: clientIp(req), detail: INSTANCE_SETTINGS.map((x) => `${x.key}=${instanceSetting(x.key)}`).join(', ') });
    flash(s, problem ?? 'Instance settings saved.', problem ? 'error' : 'ok');
    return back(reply, s, `${BASE}/instance`);
  });
}
