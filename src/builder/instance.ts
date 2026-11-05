import type { FastifyInstance, FastifyReply } from 'fastify';
import { html } from '../html.ts';
import { attention, confirmKeyBackup, forgetAttention, instanceChecks } from '../instance-checks.ts';
import { relyingParty } from '../webauthn.ts';
import { configurationValue, CONFIGURATION, INSTANCE_SETTINGS, instanceSetting, origin, refreshInstanceSettings, saveInstanceSettings } from '../instance.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import { isAdmin } from './locks.ts';
import { policyRegion } from './security.ts';
import { releaseCheckRegion } from './workspace-home.ts';
import { back, BASE, csrf, developer, flash, region, send, shell, type Req } from './ui.ts';
import { tr } from './i18n.ts';

// Workspace utilities → Instance settings (administrators; APEX: instance
// administration → instance settings): the settings of src/instance.ts, and a
// read-only overview of the server's configuration (secrets only as "set").

const crumbs = (tx: ReturnType<typeof tr>): [string, string?][] => [[tx('rail.app_builder'), BASE], [tx('admin.utilities'), `${BASE}/utilities`], [tx('ins.title')]];

async function adminOnly(s: Session, reply: FastifyReply) {
  if (await isAdmin(s.username)) return true;
  const tx = tr(s);
  const main = html`<h1 class="u-mb1">${tx('ins.title')}</h1><div class="alert alert-error" role="alert">${tx('ins.refused')}</div>`;
  await send(reply.code(403), s, shell(s, tx('ins.title'), crumbs(tx), main));
  return false;
}



/** (sprint 133, SEC-6) Lockout checks: what could keep people out later (src/instance-checks.ts). */
async function checksRegion(s: Session, rpId: string) {
  const tx = tr(s);
  const checks = await instanceChecks(rpId);
  const n = attention(checks);
  return region(tx('ins.checks'), html`<p class="muted u-mt0">${n ? tx(n === 1 ? 'ins.attention_one' : 'ins.attention', { n }) : tx('ins.nothing')}
      ${tx.rich('ins.checks_cli', { cmd: html`<code>pgkiln admin check</code>`, url: html`<code>--url</code>` })}</p>
    <ul class="hits findings">${checks.map((c) => html`<li class="finding-${c.level}"><strong>${c.title}</strong><span></span>
      <span class="tag tag-${c.level}">${tx(`ins.level.${c.level}` as 'ins.level.ok')}</span><span class="hit-snippet">${c.detail}</span>
      ${c.key === 'key_backup' && c.level === 'warning' ? html`<form method="post" action="${BASE}/instance/key-backup" class="u-mt0">${csrf(s)}
        <button class="btn btn-sm">${tx('ins.have_copy')}</button></form>` : ''}</li>`)}</ul>`, '', 'lockout-checks');
}



export async function instanceRoutes(app: FastifyInstance) {
  app.get(`${BASE}/instance`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply))) return;
    await refreshInstanceSettings(true);
    const tx = tr(s);
    const originText = (o: 'builder' | 'environment' | 'default') => tx(`ins.origin.${o}` as 'ins.origin.builder');
    const main = html`<h1 class="u-mb1">${tx('ins.title')}</h1>
      <p class="muted u-mt0">${tx('ins.intro')}</p>
      <div class="columns wide-left">
        ${region(tx('ins.sessions'), html`<form method="post" action="${BASE}/instance">${csrf(s)}
          <div class="form-grid">${INSTANCE_SETTINGS.map((x) => {
            const from = origin(x.key);
            return html`<div class="field"><label class="label" for="f_${x.key}">${x.label}</label>
              <input id="f_${x.key}" name="${x.key}" type="number" min="${x.min}" max="${x.max}" value="${from === 'builder' ? instanceSetting(x.key) : ''}" placeholder="${instanceSetting(x.key)} (${originText(from)})">
              <small class="help">${x.help} ${tx.rich('ins.in_effect', { value: html`<b>${instanceSetting(x.key)}</b>`, origin: originText(from), env: html`<code>${x.env}</code>`, default: x.default })}</small></div>`;
          })}</div>
          <div class="buttons"><button class="btn btn-hot">${tx('ins.save')}</button></div></form>`)}
        ${await checksRegion(s, relyingParty(req).rpId)}
        ${await releaseCheckRegion(s)}
        ${await policyRegion(s)}
        ${region(tx('ins.configuration'), html`<p class="muted u-mt0">${tx('ins.config_intro')}</p>
          <div class="table-wrap"><table class="report report-reflow"><thead><tr><th>${tx('ins.col.variable')}</th><th>${tx('ins.col.value')}</th><th>${tx('ins.col.purpose')}</th></tr></thead>
          <tbody>${CONFIGURATION.map((c) => {
            const v = configurationValue(c);
            return html`<tr><td data-label="${tx('ins.col.variable')}"><code>${c.env}</code></td><td data-label="${tx('ins.col.value')}" class="cell-break">${v.set ? v.value : html`<span class="muted">${v.value}</span>`}</td><td data-label="${tx('ins.col.purpose')}">${c.help}</td></tr>`;
          })}</tbody></table></div>`)}
      </div>`;
    return send(reply, s, shell(s, tx('ins.title'), crumbs(tx), main));
  });

  app.post(`${BASE}/instance/key-backup`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply))) return;
    const ok = await confirmKeyBackup(s.username!);
    forgetAttention();
    if (ok) await logActivity({ username: s.username, event: 'secret_key', ip: clientIp(req), detail: 'backup confirmed' });
    flash(s, tr(s)(ok ? 'ins.backup_ok' : 'ins.no_key'), ok ? 'ok' : 'error');
    return back(reply, s, `${BASE}/instance#lockout-checks`);
  });

  app.post(`${BASE}/instance`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply))) return;
    const problem = await saveInstanceSettings(req.body ?? {});
    if (!problem)
      await logActivity({ username: s.username, event: 'instance_settings', ip: clientIp(req), detail: INSTANCE_SETTINGS.map((x) => `${x.key}=${instanceSetting(x.key)}`).join(', ') });
    flash(s, problem ?? tr(s)('ins.saved'), problem ? 'error' : 'ok');
    return back(reply, s, `${BASE}/instance`);
  });
}
