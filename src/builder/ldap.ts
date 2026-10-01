import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw } from '../html.ts';
import { testDirectory, type Directory } from '../ldap.ts';
import { back, BASE, csrf, developer, flash, input, region, send, shell, type Req } from './ui.ts';

// Users → LDAP directories: the directories an application's password form
// can check (enabled per app under Settings → Sign-in methods). The bind
// password is write-only: it is never sent back to the browser.

const check = (name: string, label: string, on: boolean, help?: string) =>
  html`<div class="field"><label class="check"><input type="checkbox" name="${name}" value="true"${on ? raw(' checked') : ''}> ${label}</label>${help ? html`<small class="help">${help}</small>` : ''}</div>`;

function directoryForm(d: Partial<Directory> & { has_password?: boolean }, action: string, csrfField: ReturnType<typeof csrf>, isNew: boolean) {
  return html`<form method="post" action="${action}">${csrfField}
    <fieldset class="prop-group"><legend>Server</legend><div class="form-grid">
      ${isNew ? input('name', 'Name', '', { required: true, help: 'lowercase, e.g. corp or ad' }) : ''}
      ${input('display_name', 'Display name', d.display_name, { required: true })}
      ${input('url', 'URL', d.url, { required: true, placeholder: 'ldaps://ldap.example.com or ldap://…:389', help: 'ldaps:// (TLS) or ldap://, with StartTLS below. Plain ldap:// sends passwords unencrypted.' })}
      ${input('bind_dn', 'Service account DN', d.bind_dn, { placeholder: 'cn=pgapex,ou=services,dc=example,dc=org', help: 'Searches users (and groups). Empty: an anonymous search.' })}
      ${input('bind_password', 'Service account password', '', { type: 'password', auto: 'new-password', help: d.has_password ? 'A password is stored. Leave empty to keep it.' : '' })}
    </div>
    ${check('start_tls', 'StartTLS (for ldap:// URLs)', !!d.start_tls)}
    ${check('tls_verify', 'Verify the server certificate', d.tls_verify !== false, 'Turn off only for test servers with self-signed certificates.')}
    ${!isNew && d.has_password ? check('remove_password', 'Remove the stored password (anonymous search)', false) : ''}
    </fieldset>
    <fieldset class="prop-group"><legend>Users</legend><div class="form-grid">
      ${input('user_base', 'User search base', d.user_base, { required: true, placeholder: 'ou=people,dc=example,dc=org' })}
      ${input('user_filter', 'User filter', d.user_filter ?? '(uid={username})', { help: '{username} is replaced by the escaped username. Active Directory: (sAMAccountName={username})' })}
      ${input('username_attribute', 'Username attribute', d.username_attribute ?? 'uid', { help: 'The pgapex username; AD: sAMAccountName' })}
      ${input('display_name_attribute', 'Display name attribute', d.display_name_attribute ?? 'cn')}
      ${input('email_attribute', 'E-mail attribute', d.email_attribute ?? 'mail')}
    </div>
    ${check('auto_create', 'Create accounts automatically on first sign-in', !!d.auto_create, 'Otherwise only people with an existing account (same username) can sign in.')}
    </fieldset>
    <fieldset class="prop-group"><legend>Groups (mapped to roles under each app's Access control)</legend><div class="form-grid">
      ${input('group_attribute', 'Group attribute of the user', d.group_attribute ?? 'memberOf', { help: 'Group DNs; the first value of each is the group name. Empty: not used.' })}
      ${input('group_base', 'Group search base', d.group_base, { placeholder: 'ou=groups,dc=example,dc=org', help: 'Optional: search groups as well.' })}
      ${input('group_filter', 'Group filter', d.group_filter ?? '(|(member={dn})(uniqueMember={dn}))', { help: '{dn}: the user\'s DN, {username}: the username (both escaped).' })}
      ${input('group_name_attribute', 'Group name attribute', d.group_name_attribute ?? 'cn')}
    </div></fieldset>
    ${check('enabled', 'Enabled', d.enabled !== false)}
    <div class="buttons"><button class="btn btn-hot">${isNew ? 'Add directory' : 'Save'}</button></div>
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
    const s = await developer(req, reply);
    if (!s) return;
    const rows = (await owner.query(`select id, name, display_name, url, enabled, auto_create,
        (select count(*) from meta.ldap_identity i where i.directory_id = d.id)::int as linked,
        (select string_agg(a.alias, ', ' order by a.alias) from meta.app a where d.name = any(a.ldap_directories)) as apps
      from meta.ldap_directory d order by display_name`)).rows;
    const main = html`
      <div class="title-row"><h1>LDAP directories</h1></div>
      <p class="muted u-mt0">OpenLDAP, Active Directory and other LDAP servers. An application's sign-in form checks local passwords first, then the directories enabled under <b>Settings → Sign-in methods</b>. Directory groups map to roles under each application's <b>Access control</b>.</p>
      <div class="columns wide-left">
        ${region('Directories', html`<div class="table-wrap"><table class="report report-reflow">
          <thead><tr><th>Directory</th><th>URL</th><th>Used by</th><th>Linked accounts</th><th>Status</th></tr></thead>
          <tbody>${rows.length ? rows.map((r) => html`<tr>
            <td data-label="Directory"><a href="${BASE}/users/directories/${r.id}">${r.display_name}</a> <span class="muted">${r.name}</span></td>
            <td data-label="URL">${r.url}</td>
            <td data-label="Used by">${r.apps ?? html`<span class="muted">no apps</span>`}</td>
            <td data-label="Linked accounts">${r.linked}</td>
            <td data-label="Status">${r.enabled ? 'enabled' : html`<b>disabled</b>`}${r.auto_create ? ' · auto-create' : ''}</td>
          </tr>`) : html`<tr><td colspan="5" class="empty">No LDAP directories yet.</td></tr>`}</tbody></table></div>`)}
        ${region('Add directory', directoryForm({}, `${BASE}/users/directories`, csrf(s), true))}
      </div>`;
    return send(reply, s, shell(s, 'LDAP directories', [['Users', `${BASE}/users`], ['LDAP directories']], main, 'users'));
  });

  app.post(`${BASE}/users/directories`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = req.body ?? {};
    try {
      const r = await owner.one(
        `insert into meta.ldap_directory (name, ${COLUMNS}, bind_password)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) returning id`,
        [b.name?.trim().toLowerCase(), ...values(b), b.bind_password || null],
      );
      flash(s, 'Directory added. Test the connection, then enable it for an application.');
      return back(reply, s, `${BASE}/users/directories/${r.id}`);
    } catch (e) {
      flash(s, (e as Error).message, 'error');
      return back(reply, s, `${BASE}/users/directories`);
    }
  });

  app.get(`${BASE}/users/directories/:id`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const d = /^\d+$/.test(req.params.id) ? await owner.one('select *, bind_password is not null as has_password from meta.ldap_directory where id = $1', [req.params.id]) : undefined;
    if (!d) return reply.code(404).send('Not found');
    delete d.bind_password; // never sent to the browser
    const main = html`
      <div class="title-row"><h1>${d.display_name}</h1></div>
      <div class="columns wide-left">
        ${region('Settings', html`${directoryForm(d, `${BASE}/users/directories/${d.id}`, csrf(s), false)}
          <form method="post" action="${BASE}/users/directories/${d.id}/delete" class="danger-zone">${csrf(s)}
            <button class="btn btn-danger" data-confirm="Delete ${d.display_name}? Links to accounts are removed; accounts stay.">Delete directory</button></form>`)}
        ${region('Test connection', html`
          <p class="muted u-mt0">Connects, binds as the service account (or anonymously) and checks the search base; with a username, looks the user up with the filter. No password is checked.</p>
          <form method="post" action="${BASE}/users/directories/${d.id}/test" class="search u-mwnone">${csrf(s)}
            <input name="username" placeholder="Username (optional)" aria-label="Username to look up" maxlength="100">
            <button class="btn">Test</button></form>`)}
      </div>`;
    return send(reply, s, shell(s, d.display_name, [['Users', `${BASE}/users`], ['LDAP directories', `${BASE}/users/directories`], [d.display_name]], main, 'users'));
  });

  app.post(`${BASE}/users/directories/:id`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = req.body ?? {};
    try {
      await owner.query(
        `update meta.ldap_directory set (${COLUMNS}) = ($2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17),
                bind_password = case when $19 then null when $18::text is null then bind_password else $18 end
          where id = $1`,
        [req.params.id, ...values(b), b.bind_password || null, b.remove_password === 'true'],
      );
      flash(s, 'Directory saved.');
    } catch (e) {
      flash(s, (e as Error).message, 'error');
    }
    return back(reply, s, `${BASE}/users/directories/${req.params.id}`);
  });

  app.post(`${BASE}/users/directories/:id/test`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const d = /^\d+$/.test(req.params.id) ? await owner.one<Directory>('select * from meta.ldap_directory where id = $1', [req.params.id]) : undefined;
    if (!d) return reply.code(404).send('Not found');
    try {
      flash(s, await testDirectory(d, (req.body?.username ?? '').trim().slice(0, 100) || undefined));
    } catch (e) {
      flash(s, `The test failed: ${(e as Error).message}`, 'error');
    }
    return back(reply, s, `${BASE}/users/directories/${d.id}`);
  });

  app.post(`${BASE}/users/directories/:id/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const d = await owner.one('delete from meta.ldap_directory where id = $1 returning name', [req.params.id]);
    // and from the applications that used it
    if (d) await owner.query('update meta.app set ldap_directories = array_remove(ldap_directories, $1) where $1 = any(ldap_directories)', [d.name]);
    flash(s, 'Directory deleted.');
    return back(reply, s, `${BASE}/users/directories`);
  });
}
