import type { FastifyInstance } from 'fastify';
import { browserSecurityChanged, check, headersFor, REFERRERS, settingsOf, type BrowserSecurity } from '../browser-security.ts';
import { owner } from '../db.ts';
import { html } from '../html.ts';
import { clientIp, logActivity } from '../session.ts';
import { tr, type BuilderTranslate } from './i18n.ts';
import { back, BASE, csrf, developer, flash, region, select, type Req } from './ui.ts';

// (sprint 188, NX-S4; migration 168) Settings → Security → Browser security (APEX: Security Attributes → Browser
// Security): who may show the application in a frame, the referrer policy, search engines and extra response headers.
// Its own form, so a refused value doesn't keep the rest of the settings from being saved. src/browser-security.ts
// checks the values and makes the headers.

const textarea = (name: string, label: string, value: string, help: string, placeholder = '') =>
  html`<div class="field" data-wide><label class="label" for="f_${name}">${label}</label>
    <textarea id="f_${name}" name="${name}" rows="3" spellcheck="false" placeholder="${placeholder}">${value}</textarea>
    <small class="help">${help}</small></div>`;

/** The region on the Security tab. */
export function browserSecuritySection(a: { id: number; browser_security: unknown }, s: Parameters<typeof csrf>[0], tx: BuilderTranslate) {
  const b = settingsOf(a.browser_security);
  return region(tx('bs.title'), html`<form method="post" action="${BASE}/apps/${a.id}/settings/browser" id="browser-security">${csrf(s)}
    <p class="muted u-mt0">${tx('bs.intro')}</p>
    <div class="form-grid">
      ${select('embed', tx('bs.embed'), b.embed, [['same_origin', tx('bs.embed.same_origin')], ['deny', tx('bs.embed.deny')], ['origins', tx('bs.embed.origins')]], tx('bs.embed_help'))}
      ${select('referrer', tx('bs.referrer'), b.referrer, REFERRERS.map((r): [string, string] => [r, r === 'same-origin' ? tx('bs.referrer_default', { policy: r }) : r]), tx('bs.referrer_help'))}
      ${select('robots', tx('bs.robots'), b.robots, [['auto', tx('bs.robots.auto')], ['index', tx('bs.robots.index')], ['noindex', tx('bs.robots.noindex')]], tx('bs.robots_help'))}
    </div>
    ${textarea('embed_origins', tx('bs.origins'), b.embed_origins.join('\n'), tx('bs.origins_help'), 'https://portal.example.com')}
    ${textarea('headers', tx('bs.headers'), b.headers.map((h) => `${h.name}: ${h.value}`).join('\n'), tx('bs.headers_help'), 'X-Team: sales')}
    <div class="buttons"><button class="btn">${tx('bs.save')}</button></div></form>`, '', 'browser-security-region');
}

/** The checklist's lines: what the application's pages send. */
export function browserSecurityChecklist(a: { browser_security: unknown; authentication: string }, tx: BuilderTranslate) {
  const b: BrowserSecurity = settingsOf(a.browser_security);
  const h = headersFor(b, a.authentication !== 'none');
  const embed = b.embed === 'origins' ? tx('bs.ck.embed_origins', { origins: b.embed_origins.join(', ') }) : tx(b.embed === 'deny' ? 'bs.ck.embed_deny' : 'bs.ck.embed_same');
  const lines = [`Content-Security-Policy: … frame-ancestors ${h.frameAncestors}; …`, ...Object.entries(h.headers).map(([k, v]) => `${k}: ${v}`)];
  return html`<li>${b.embed === 'origins' ? '•' : '✓'} ${embed}</li>
    <li>${h.headers['X-Robots-Tag'] ? `✓ ${tx('bs.ck.noindex')}` : `• ${tx('bs.ck.index')}`}</li>
    <li><details><summary>${tx('bs.ck.headers')}</summary><pre class="code u-mt0">${lines.join('\n')}</pre></details></li>`;
}

export async function browserSecurityRoutes(app: FastifyInstance) {
  app.post(`${BASE}/apps/:id/settings/browser`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const tx = tr(s);
    const a = await owner.one<{ id: number; alias: string }>('select id, alias from meta.app where id = $1', [Number(req.params.id) || 0]);
    if (!a) return reply.code(404).send('Not found');
    const b = req.body ?? {};
    const { settings, problems } = check({ embed: b.embed, embed_origins: b.embed_origins, referrer: b.referrer, robots: b.robots, headers: b.headers });
    if (problems.length) flash(s, tx('bs.refused', { problems: problems.join(' ') }), 'error');
    else {
      await owner.query('update meta.app set browser_security = $2::jsonb, updated_at = now() where id = $1', [a.id, JSON.stringify(settings)]);
      browserSecurityChanged();
      await logActivity({ appId: a.id, username: s.username, event: 'app_browser_security', ip: clientIp(req),
        detail: `embed ${settings.embed}${settings.embed_origins.length ? ` (${settings.embed_origins.join(' ')})` : ''}, referrer ${settings.referrer}, robots ${settings.robots}, ${settings.headers.length} header(s)` });
      flash(s, tx('bs.saved'));
    }
    return back(reply, s, `${BASE}/apps/${a.id}/settings?tab=security#browser-security-region`);
  });
}
