import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw } from '../html.ts';
import { testDirectory, type Directory } from '../ldap.ts';
import { administrator, back, BASE, csrf, flash, input, region, send, shell, type Req } from './ui.ts';
import { builderSignInRegion } from './builder-sso.ts';
import { tr, type BuilderTranslate } from './i18n.ts';

// Users → LDAP directories: the directories an application's password form
// can check (enabled per app under Settings → Sign-in methods). The bind
// password is write-only: it is never sent back to the browser.

const check = (name: string, label: string, on: boolean, help?: string) =>
  html`<div class="field"><label class="check"><input type="checkbox" name="${name}" value="true"${on ? raw(' checked') : ''}> ${label}</label>${help ? html`<small class="help">${help}</small>` : ''}</div>`;

function directoryForm(tx: BuilderTranslate, d: Partial<Directory> & { has_password?: boolean }, action: string, csrfField: ReturnType<typeof csrf>, isNew: boolean) {
  return html`<form method="post" action="${action}">${csrfField}
    <fieldset class="prop-group"><legend>${tx('ldap.server')}</legend><div class="form-grid">
      ${isNew ? input('name', tx('ldap.name'), '', { required: true, help: tx('ldap.name_help') }) : ''}
      ${input('display_name', tx('ldap.display_name'), d.display_name, { required: true })}
      ${input('url', tx('ldap.url'), d.url, { required: true, placeholder: 'ldaps://ldap.example.com or ldap://…:389', help: tx('ldap.url_help') })}
      ${input('bind_dn', tx('ldap.bind_dn'), d.bind_dn, { placeholder: 'cn=pgkiln,ou=services,dc=example,dc=org', help: tx('ldap.bind_dn_help') })}
      ${input('bind_password', tx('ldap.bind_password'), '', { type: 'password', auto: 'new-password', help: d.has_password ? tx('ldap.password_stored') : '' })}
    </div>
    ${check('start_tls', tx('ldap.start_tls'), !!d.start_tls)}
    ${check('tls_verify', tx('ldap.tls_verify'), d.tls_verify !== false, tx('ldap.tls_verify_help'))}
    ${!isNew && d.has_password ? check('remove_password', tx('ldap.remove_password'), false) : ''}
    </fieldset>
    <fieldset class="prop-group"><legend>${tx('ldap.users')}</legend><div class="form-grid">
      ${input('user_base', tx('ldap.user_base'), d.user_base, { required: true, placeholder: 'ou=people,dc=example,dc=org' })}
      ${input('user_filter', tx('ldap.user_filter'), d.user_filter ?? '(uid={username})', { help: tx('ldap.user_filter_help', { ad: '(sAMAccountName={username})' }) })}
      ${input('username_attribute', tx('ldap.username_attr'), d.username_attribute ?? 'uid', { help: tx('ldap.username_attr_help') })}
      ${input('display_name_attribute', tx('ldap.display_attr'), d.display_name_attribute ?? 'cn')}
      ${input('email_attribute', tx('ldap.email_attr'), d.email_attribute ?? 'mail')}
    </div>
    ${check('auto_create', tx('ldap.auto_create'), !!d.auto_create, tx('ldap.auto_create_help'))}
    </fieldset>
    <fieldset class="prop-group"><legend>${tx('ldap.groups')}</legend><div class="form-grid">
      ${input('group_attribute', tx('ldap.group_attr'), d.group_attribute ?? 'memberOf', { help: tx('ldap.group_attr_help') })}
      ${input('group_base', tx('ldap.group_base'), d.group_base, { placeholder: 'ou=groups,dc=example,dc=org', help: tx('ldap.group_base_help') })}
      ${input('group_filter', tx('ldap.group_filter'), d.group_filter ?? '(|(member={dn})(uniqueMember={dn}))', { help: tx('ldap.group_filter_help') })}
      ${input('group_name_attribute', tx('ldap.group_name_attr'), d.group_name_attribute ?? 'cn')}
    </div></fieldset>
    ${check('enabled', tx('ldap.enabled'), d.enabled !== false)}
    <div class="buttons"><button class="btn btn-hot">${isNew ? tx('ldap.add') : tx('ldap.save')}</button></div>
  </form>`;
}

const values = (b: Record<string, string | undefined>) => [
  b.display_name?.trim(), b.url?.trim(), b.start_tls === 'true', b.tls_verify === 'true', b.bind_dn?.trim() || null,
  b.user_base?.trim(), b.user_filter?.trim() || '(uid={username})', b.username_attribute?.trim() || 'uid',
  b.display_name_attribute?.trim() || null, b.email_attribute?.trim() || null, b.group_attribute?.trim() || null,
  b.group_base?.trim() || null, b.group_filter?.trim() || null, b.group_name_attribute?.trim() || 'cn',
  b.auto_create === 'true', b.enabled === 'true',
];
const COLUMNS = 'display_name, url, start_tls, tls_verify, bind_dn, user_base, user_filter, username_attribute, display_name_attribute, email_attribute, group_attribute, group_base, group_filter, group_name_attribute, auto_create, enabled';

export async function ldapRoutes(app: FastifyInstance) {
  app.get(`${BASE}/users/directories`, async (req: Req, reply) => {
    const s = await administrator(req, reply, 'LDAP directories');
    if (!s) return;
    const rows = (await owner.query(`select id, name, display_name, url, enabled, auto_create,
        (select count(*) from meta.ldap_identity i where i.directory_id = d.id)::int as linked,
        (select string_agg(a.alias, ', ' order by a.alias) from meta.app a where d.name = any(a.ldap_directories)) as apps
      from meta.ldap_directory d order by display_name`)).rows;
    const tx = tr(s);
    const main = html`
      <div class="title-row"><h1>${tx('ldap.title')}</h1></div>
      <p class="muted u-mt0">${tx.rich('ldap.intro', { where: html`<b>${tx('ldap.where')}</b>`, access: html`<b>${tx('ldap.access')}</b>` })}</p>
      <div class="columns wide-left">
        ${region(tx('ldap.directories'), html`<div class="table-wrap"><table class="report report-reflow">
          <thead><tr><th>${tx('ldap.col.directory')}</th><th>${tx('ldap.url')}</th><th>${tx('ldap.col.used_by')}</th><th>${tx('ldap.col.linked')}</th><th>${tx('ldap.col.status')}</th></tr></thead>
          <tbody>${rows.length ? rows.map((r) => html`<tr>
            <td data-label="${tx('ldap.col.directory')}"><a href="${BASE}/users/directories/${r.id}">${r.display_name}</a> <span class="muted">${r.name}</span></td>
            <td data-label="${tx('ldap.url')}">${r.url}</td>
            <td data-label="${tx('ldap.col.used_by')}">${r.apps ?? html`<span class="muted">${tx('ldap.no_apps')}</span>`}</td>
            <td data-label="${tx('ldap.col.linked')}">${r.linked}</td>
            <td data-label="${tx('ldap.col.status')}">${r.enabled ? tx('ldap.status_enabled') : html`<b>${tx('ldap.status_disabled')}</b>`}${r.auto_create ? ` · ${tx('ldap.status_auto')}` : ''}</td>
          </tr>`) : html`<tr><td colspan="5" class="empty">${tx('ldap.none')}</td></tr>`}</tbody></table></div>`)}
        ${region(tx('ldap.add'), directoryForm(tx, {}, `${BASE}/users/directories`, csrf(s), true))}
      </div>`;
    return send(reply, s, shell(s, tx('ldap.title'), [[tx('wu.users'), `${BASE}/users`], [tx('ldap.title')]], main, 'users'));
  });

  app.post(`${BASE}/users/directories`, async (req: Req, reply) => {
    const s = await administrator(req, reply, 'LDAP directories');
    if (!s) return;
    const b = req.body ?? {};
    try {
      const r = await owner.one(
        `insert into meta.ldap_directory (name, ${COLUMNS}, bind_password)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) returning id`,
        [b.name?.trim().toLowerCase(), ...values(b), b.bind_password || null],
      );
      flash(s, tr(s)('ldap.added'));
      return back(reply, s, `${BASE}/users/directories/${r.id}`);
    } catch (e) {
      flash(s, (e as Error).message, 'error');
      return back(reply, s, `${BASE}/users/directories`);
    }
  });

  app.get(`${BASE}/users/directories/:id`, async (req: Req, reply) => {
    const s = await administrator(req, reply, 'LDAP directories');
    if (!s) return;
    const d = /^\d+$/.test(req.params.id) ? await owner.one('select *, bind_password is not null as has_password from meta.ldap_directory where id = $1', [req.params.id]) : undefined;
    if (!d) return reply.code(404).send('Not found');
    delete d.bind_password; // never sent to the browser
    const tx = tr(s);
    const main = html`
      <div class="title-row"><h1>${d.display_name}</h1></div>
      <div class="columns wide-left">
        ${region(tx('ldap.settings'), html`${directoryForm(tx, d, `${BASE}/users/directories/${d.id}`, csrf(s), false)}
          <form method="post" action="${BASE}/users/directories/${d.id}/delete" class="danger-zone">${csrf(s)}
            <button class="btn btn-danger" data-confirm="${tx('ldap.delete_confirm', { name: d.display_name })}">${tx('ldap.delete')}</button></form>`)}
        ${region(tx('ldap.test'), html`
          <p class="muted u-mt0">${tx('ldap.test_intro')}</p>
          <form method="post" action="${BASE}/users/directories/${d.id}/test" class="search u-mwnone">${csrf(s)}
            <input name="username" placeholder="${tx('ldap.test_username')}" aria-label="${tx('ldap.test_username_label')}" maxlength="100">
            <button class="btn">${tx('ldap.test_btn')}</button></form>`)}
        ${await builderSignInRegion(s, 'directory', d)}
      </div>`;
    return send(reply, s, shell(s, d.display_name, [[tx('wu.users'), `${BASE}/users`], [tx('ldap.title'), `${BASE}/users/directories`], [d.display_name]], main, 'users'));
  });

  app.post(`${BASE}/users/directories/:id`, async (req: Req, reply) => {
    const s = await administrator(req, reply, 'LDAP directories');
    if (!s) return;
    const b = req.body ?? {};
    try {
      await owner.query(
        `update meta.ldap_directory set (${COLUMNS}) = ($2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17),
                bind_password = case when $19 then null when $18::text is null then bind_password else $18 end
          where id = $1`,
        [req.params.id, ...values(b), b.bind_password || null, b.remove_password === 'true'],
      );
      flash(s, tr(s)('ldap.saved'));
    } catch (e) {
      flash(s, (e as Error).message, 'error');
    }
    return back(reply, s, `${BASE}/users/directories/${req.params.id}`);
  });

  app.post(`${BASE}/users/directories/:id/test`, async (req: Req, reply) => {
    const s = await administrator(req, reply, 'LDAP directories');
    if (!s) return;
    const d = /^\d+$/.test(req.params.id) ? await owner.one<Directory>('select * from meta.ldap_directory where id = $1', [req.params.id]) : undefined;
    if (!d) return reply.code(404).send('Not found');
    try {
      flash(s, await testDirectory(d, (req.body?.username ?? '').trim().slice(0, 100) || undefined));
    } catch (e) {
      flash(s, tr(s)('ldap.test_failed', { error: (e as Error).message }), 'error');
    }
    return back(reply, s, `${BASE}/users/directories/${d.id}`);
  });

  app.post(`${BASE}/users/directories/:id/delete`, async (req: Req, reply) => {
    const s = await administrator(req, reply, 'LDAP directories');
    if (!s) return;
    const d = await owner.one('delete from meta.ldap_directory where id = $1 returning name', [req.params.id]);
    // and from the applications that used it
    if (d) await owner.query('update meta.app set ldap_directories = array_remove(ldap_directories, $1) where $1 = any(ldap_directories)', [d.name]);
    flash(s, tr(s)('ldap.deleted'));
    return back(reply, s, `${BASE}/users/directories`);
  });
}
