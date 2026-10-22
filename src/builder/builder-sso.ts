import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import { breakGlassAdmins, builderSources, identitiesOf, ssoRequired } from '../devsso.ts';
import { isAdmin } from './locks.ts';
import { tr } from './i18n.ts';
import { administrator, back, BASE, csrf, developer, flash, input, region, type Req } from './ui.ts';

// (sprint 129, SEC-1) Builder sign-in through identity providers and LDAP directories (devsso.ts):
//  * Users → Identity providers / LDAP directories → "Builder sign-in": on or off, creating developers,
//    linking existing ones, the groups; the developers linked there;
//  * Security: the developer's own identities, "Link" for each provider, "Unlink";
//  * Developers: break-glass administrators (they may use the pgkiln password where a workspace
//    requires single sign-on).

type Kind = 'provider' | 'directory';
const TABLE = { provider: 'meta.auth_provider', directory: 'meta.ldap_directory' } as const;
const COLUMN = { provider: 'provider_id', directory: 'directory_id' } as const;
const PATH = { provider: 'providers', directory: 'directories' } as const;

const check = (name: string, label: string, on: boolean, help?: string) =>
  html`<div class="field"><label class="check"><input type="checkbox" name="${name}" value="true"${on ? raw(' checked') : ''}> ${label}</label>${help ? html`<small class="help">${help}</small>` : ''}</div>`;

/** The "Builder sign-in" region of a provider's or directory's page. */
export async function builderSignInRegion(s: Session, kind: Kind, row: { id: number; builder: boolean; builder_auto_create: boolean; builder_link_existing: boolean; builder_group: string | null; builder_admin_group: string | null }): Promise<Raw> {
  const tx = tr(s);
  const linked = (await owner.query<{ id: number; username: string; linked_at: string }>(
    `select id, username, linked_at from meta.developer_identity where ${COLUMN[kind]} = $1 order by username`, [row.id])).rows;
  return region(tx('bsso.title'), html`<p class="muted u-mt0">${tx('bsso.intro')}</p>
    <form method="post" action="${BASE}/users/${PATH[kind]}/${row.id}/builder">${csrf(s)}
      ${check('builder', tx('bsso.on'), row.builder, tx('bsso.on_help'))}
      ${check('builder_auto_create', tx('bsso.auto_create'), row.builder_auto_create, tx('bsso.auto_create_help'))}
      ${check('builder_link_existing', tx('bsso.link_existing'), row.builder_link_existing, tx('bsso.link_existing_help'))}
      <div class="form-grid">
        ${input('builder_group', tx('bsso.group'), row.builder_group ?? '', { help: tx('bsso.group_help') })}
        ${input('builder_admin_group', tx('bsso.admin_group'), row.builder_admin_group ?? '', { help: tx('bsso.admin_group_help') })}
      </div>
      <div class="buttons"><button class="btn">${tx('bsso.save')}</button></div></form>
    <h3>${tx('bsso.linked')}</h3>
    ${linked.length
      ? html`<ul class="plain-list">${linked.map((l) => html`<li>${icon('user')} ${l.username} <span class="muted small">${String(l.linked_at).slice(0, 10)}</span>
          <form method="post" action="${BASE}/developers/identity/${l.id}/unlink" class="u-inline">${csrf(s)}<button class="link-button" data-confirm="${tx('bsso.unlink_confirm', { user: l.username })}">${tx('bsso.unlink')}</button></form></li>`)}</ul>`
      : html`<p class="muted">${tx('bsso.none_linked')}</p>`}`, '', 'builder-sign-in');
}

/** The Security page's region: the developer's identities, and the providers to link. */
export async function identitiesRegion(s: Session, linkedNow: string | undefined): Promise<Raw | ''> {
  const tx = tr(s);
  const [mine, sources] = await Promise.all([identitiesOf(s.username!), builderSources()]);
  if (!mine.length && !sources.providers.length && !sources.directories.length) return '';
  const linkable = sources.providers.filter((p) => !mine.some((m) => m.kind === 'provider' && m.source === p.name));
  const linked = linkedNow ? mine.find((m) => m.kind === 'provider' && m.source === linkedNow) : undefined;
  return region(tx('bsso.yours'), html`<p class="muted u-mt0">${tx('bsso.yours_intro')}</p>
    ${linked ? html`<div class="alert alert-success" role="status">${tx('bsso.linked_now', { provider: linked.display_name })}</div>` : ''}
    ${mine.length
      ? html`<ul class="plain-list">${mine.map((m) => html`<li>${icon(m.kind === 'provider' ? 'log-in' : 'server')} ${m.display_name} <span class="muted small">${String(m.linked_at).slice(0, 10)}</span>
          <form method="post" action="${BASE}/developers/identity/${m.id}/unlink" class="u-inline">${csrf(s)}<button class="link-button" data-confirm="${tx('bsso.unlink_mine_confirm', { provider: m.display_name })}">${tx('bsso.unlink')}</button></form></li>`)}</ul>`
      : html`<p class="muted">${tx('bsso.none_yours')}</p>`}
    ${linkable.map((p) => html`<form method="post" action="${BASE}/security/link/${p.name}" class="u-inline">${csrf(s)}<button class="btn">${icon('link')} ${tx('bsso.link', { provider: p.display_name })}</button></form> `)}
    ${sources.directories.length ? html`<p class="muted small">${tx('bsso.directories_note')}</p>` : ''}`, '', 'identities');
}

/** Would this change leave a workspace that requires single sign-on without a break-glass administrator? */
export async function leavesNoBreakGlass(username: string) {
  if (!(await owner.one('select 1 as ok from meta.workspace where sso_only limit 1'))) return false;
  const left = (await breakGlassAdmins()).filter((u) => u !== username);
  return left.length === 0;
}

export async function builderSsoRoutes(app: FastifyInstance) {
  for (const kind of ['provider', 'directory'] as Kind[])
    app.post(`${BASE}/users/${PATH[kind]}/:id(^\\d{1,9}$)/builder`, async (req: Req, reply) => {
      const s = await administrator(req, reply, kind === 'provider' ? 'Identity providers' : 'LDAP directories');
      if (!s) return;
      const b = req.body ?? {};
      const group = (v: unknown) => String(v ?? '').trim().slice(0, 200) || null;
      const on = b.builder === 'true';
      const r = await owner.one<{ name: string }>(
        `update ${TABLE[kind]} set builder = $2, builder_auto_create = $3, builder_link_existing = $4, builder_group = $5, builder_admin_group = $6
          where id = $1 returning name`,
        [req.params.id, on, b.builder_auto_create === 'true', b.builder_link_existing === 'true', group(b.builder_group), group(b.builder_admin_group)],
      );
      if (!r) return reply.code(404).send('Not found');
      await logActivity({ username: s.username, event: 'sso_policy', ip: clientIp(req), detail: `${kind} ${r.name}: builder sign-in ${on ? 'on' : 'off'}` });
      flash(s, tr(s)('bsso.saved'));
      return back(reply, s, `${BASE}/users/${PATH[kind]}/${req.params.id}#builder-sign-in`);
    });

  // unlinking: the developer's own identity, or any for an administrator
  app.post(`${BASE}/developers/identity/:id(^\\d{1,9}$)/unlink`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const tx = tr(s);
    const i = await owner.one<{ username: string; provider_id: number | null; directory_id: number | null }>('select username, provider_id, directory_id from meta.developer_identity where id = $1', [req.params.id]);
    const admin = await isAdmin(s.username);
    if (!i || (i.username !== s.username && !admin)) return reply.code(404).send('Not found');
    const where = i.username === s.username ? `${BASE}/security#identities` : `${BASE}/users/${i.provider_id ? 'providers' : 'directories'}/${i.provider_id ?? i.directory_id}#builder-sign-in`;
    // the last identity of a developer who must use single sign-on: they could not sign in any more
    const only = await owner.one<{ n: number }>('select count(*)::int as n from meta.developer_identity where username = $1', [i.username]);
    if (only!.n <= 1 && (await ssoRequired(i.username))) {
      flash(s, tx('bsso.keep_one'), 'error');
      return back(reply, s, where);
    }
    await owner.query('delete from meta.developer_identity where id = $1', [req.params.id]);
    await logActivity({ username: s.username, event: 'sso_unlinked', ip: clientIp(req), detail: `${i.username}: ${i.provider_id ? `provider ${i.provider_id}` : `directory ${i.directory_id}`}` });
    flash(s, tx('bsso.unlinked'));
    return back(reply, s, where);
  });

  // break-glass: administrators only, for administrators
  app.post(`${BASE}/developers/break-glass`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    if (!(await isAdmin(s.username))) return reply.code(403).send('Only administrators change break-glass access.');
    const tx = tr(s);
    const username = String(req.body?.username ?? '');
    const on = req.body?.break_glass === 'true';
    const d = await owner.one<{ is_admin: boolean }>('select is_admin from meta.developer where username = $1', [username]);
    if (!d) return reply.code(404).send('Not found');
    if (on && !d.is_admin) {
      flash(s, tx('bsso.break_glass_admins'), 'error');
      return back(reply, s, `${BASE}/developers`);
    }
    if (!on && (await leavesNoBreakGlass(username))) {
      flash(s, tx('bsso.keep_break_glass'), 'error');
      return back(reply, s, `${BASE}/developers`);
    }
    await owner.query('update meta.developer set break_glass = $2 where username = $1', [username, on]);
    await logActivity({ username: s.username, event: 'sso_policy', ip: clientIp(req), detail: `${username}: break-glass ${on ? 'on' : 'off'}` });
    flash(s, tx(on ? 'bsso.break_glass_on' : 'bsso.break_glass_off', { user: username }));
    return back(reply, s, `${BASE}/developers`);
  });
}
