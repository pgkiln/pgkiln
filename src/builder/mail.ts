import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw } from '../html.ts';
import { icon } from '../icons.ts';
import { senderAllowed, sendWith, type MailService } from '../mail/mail.ts';
import { MailError, PROVIDER_LABELS, PROVIDERS, settingsProblems, type Provider, type ServiceSettings } from '../mail/providers.ts';
import { encryptSecret, secretKeyConfigured } from '../secrets.ts';
import type { Session } from '../session.ts';
import { isAdmin } from './locks.ts';
import { back, BASE, csrf, developer, flash, input, region, select, send, shell, type Req } from './ui.ts';

// Workspace utilities → Mail services (administrators): the mail services of
// this installation (SMTP with a password or OAuth2, Microsoft Graph, Amazon
// SES, Resend, Postmark, SendGrid, Mailgun, or log only), the From addresses
// each may send as, which applications send through it (with their From
// address and a daily limit), a test, and the recent mail. Applications →
// Activity → Mail (developers): the application's mail, with retry and
// cancel. Secrets are encrypted (src/secrets.ts) and never sent back to the
// browser.

const TEST_RESULT = '__MAILTEST';
const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const SENDER = /^(@|[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

const check = (name: string, label: string, on: boolean, help?: string) =>
  html`<div class="field"><label class="check"><input type="checkbox" name="${name}" value="true"${on ? raw(' checked') : ''}> ${label}</label>${help ? html`<small class="help">${help}</small>` : ''}</div>`;
const when = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 19).replace('T', ' ') : '');

const SECRET_LABEL: Record<Provider, string> = {
  smtp: 'Password, or the client secret (OAuth2)', graph: 'Client secret', ses: 'Secret access key', resend: 'API key',
  postmark: 'Server token', sendgrid: 'API key', mailgun: 'API key', log: 'Secret (not used)',
};

function serviceForm(x: Partial<MailService> & { has_secret?: boolean }, action: string, csrfField: ReturnType<typeof csrf>, isNew: boolean) {
  const s: ServiceSettings = x.settings ?? {};
  const provider = (x.provider ?? 'smtp') as Provider;
  return html`<form method="post" action="${action}">${csrfField}
    <fieldset class="prop-group"><legend>Service</legend><div class="form-grid">
      ${isNew ? input('name', 'Name', '', { required: true, placeholder: 'e.g. OFFICE365', help: 'Upper case letters, digits and _.' }) : ''}
      ${input('description', 'Description', x.description)}
      ${select('provider', 'Provider', provider, PROVIDERS.map((p): [string, string] => [p, PROVIDER_LABELS[p]]),
        'Which fields apply depends on the provider (see the help under each). Mail, with its recipients and contents, is handed to this provider.')}
      ${input('senders', 'Allowed senders', (x.senders ?? []).join(', '), { required: true, placeholder: 'noreply@example.com, @example.com',
        help: 'The From addresses this service may send as: an address, or @domain for every address of a domain (the provider must accept them too).' })}
      ${input('default_from', 'Default From address', s.default_from, { placeholder: 'noreply@example.com', help: 'For applications that set none.' })}
    </div>${check('enabled', 'Enabled', x.enabled !== false, 'A disabled service sends nothing: mail stays queued until it is enabled, or fails after its retries.')}</fieldset>
    <fieldset class="prop-group"><legend>SMTP</legend><div class="form-grid">
      ${input('host', 'Host', s.host, { placeholder: 'smtp.office365.com' })}
      ${input('port', 'Port', s.port ?? '', { type: 'number', placeholder: '587', help: 'Empty: 587 (STARTTLS) or 465 (TLS).' })}
      ${select('security', 'Security', s.security ?? 'starttls', [['starttls', 'STARTTLS (required)'], ['tls', 'TLS from the start (port 465)'], ['none', 'None (a local relay only)']])}
      ${select('auth', 'Sign-in', s.auth ?? 'password', [['password', 'User name and password'], ['oauth2', 'OAuth2 (XOAUTH2, client credentials)'], ['none', 'None']],
        'Microsoft 365 no longer takes passwords for SMTP: choose OAuth2 with an Entra application (SMTP.SendAsApp), or the Graph provider.')}
      ${input('username', 'User name', s.username, { placeholder: 'the mailbox, e.g. noreply@example.com' })}
    </div>${check('tls_verify', 'Check the server\'s certificate', s.tls_verify !== false, 'Switch off only for a relay with a self-signed certificate on your own network.')}</fieldset>
    <fieldset class="prop-group"><legend>OAuth2 and Microsoft Graph</legend><div class="form-grid">
      ${input('tenant_id', 'Tenant ID (Microsoft Entra)', s.tenant_id)}
      ${input('client_id', 'Client (application) ID', s.client_id)}
      ${input('token_url', 'Token URL', s.token_url, { placeholder: 'empty: Microsoft Entra of the tenant', help: 'Another identity provider\'s token endpoint (client credentials grant), e.g. Google\'s.' })}
      ${input('scope', 'Scope', s.scope, { placeholder: 'empty: Exchange Online (SMTP) or Microsoft Graph' })}
    </div>${check('save_to_sent_items', 'Graph: keep a copy in the mailbox\'s Sent Items', s.save_to_sent_items === true)}</fieldset>
    <fieldset class="prop-group"><legend>Amazon SES, Mailgun, Postmark</legend><div class="form-grid">
      ${input('region', 'AWS region (SES)', s.region, { placeholder: 'eu-west-1' })}
      ${input('access_key_id', 'Access key ID (SES)', s.access_key_id)}
      ${input('domain', 'Sending domain (Mailgun)', s.domain, { placeholder: 'mg.example.com' })}
      ${select('mailgun_region', 'Region (Mailgun)', s.mailgun_region ?? 'us', [['us', 'US'], ['eu', 'EU']])}
      ${input('message_stream', 'Message stream (Postmark)', s.message_stream, { placeholder: 'outbound' })}
      ${input('base_url', 'API base URL', s.base_url, { placeholder: 'empty: the provider\'s own API', help: 'A gateway or proxy that speaks the provider\'s API. Administrators only.' })}
    </div></fieldset>
    <fieldset class="prop-group"><legend>Secret</legend>
      ${input('secret', SECRET_LABEL[provider], '', { type: 'password', auto: 'new-password',
        help: x.has_secret ? 'A secret is stored (encrypted). It is never shown; type a new one to replace it.' : 'Password, client secret, API key or secret access key, by provider. Stored encrypted; never shown again.' })}
      ${x.has_secret ? check('remove_secret', 'Remove the stored secret', false) : ''}
      ${secretKeyConfigured() ? '' : html`<div class="alert alert-error" role="alert">The server has no <code>PGKILN_SECRET_KEY</code>: secrets can't be stored until it is set.</div>`}
    </fieldset>
    <div class="buttons"><button class="btn btn-hot">${isNew ? 'Add service' : 'Save'}</button></div>
  </form>`;
}

/** The form's settings for the chosen provider, checked; throws with a message. */
function formValues(b: Record<string, string | undefined>, hasSecret: boolean) {
  const provider = (PROVIDERS as readonly string[]).includes(b.provider ?? '') ? (b.provider as Provider) : 'smtp';
  const t = (k: string) => (b[k] ?? '').trim() || undefined;
  const senders = [...new Set((b.senders ?? '').split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))];
  if (!senders.length) throw new Error('Name at least one allowed sender (an address, or @domain).');
  const bad = senders.find((x) => !SENDER.test(x));
  if (bad) throw new Error(`"${bad}" is not an address or @domain.`);
  const defaultFrom = t('default_from');
  if (defaultFrom && (!ADDRESS.test(defaultFrom) || !senderAllowed(senders, defaultFrom))) throw new Error('The default From address must be an address the service may send as.');
  const port = t('port') ? Number(t('port')) : undefined;
  const s: ServiceSettings = { default_from: defaultFrom, base_url: t('base_url') };
  if (provider === 'smtp')
    Object.assign(s, {
      host: t('host'), port, security: ['tls', 'none'].includes(b.security ?? '') ? b.security : 'starttls',
      auth: ['oauth2', 'none'].includes(b.auth ?? '') ? b.auth : 'password', username: t('username'), tls_verify: b.tls_verify === 'true',
      ...(b.auth === 'oauth2' ? { tenant_id: t('tenant_id'), client_id: t('client_id'), token_url: t('token_url'), scope: t('scope') } : {}),
    });
  if (provider === 'graph') Object.assign(s, { tenant_id: t('tenant_id'), client_id: t('client_id'), token_url: t('token_url'), scope: t('scope'), save_to_sent_items: b.save_to_sent_items === 'true' });
  if (provider === 'ses') Object.assign(s, { region: t('region'), access_key_id: t('access_key_id') });
  if (provider === 'mailgun') Object.assign(s, { domain: t('domain'), mailgun_region: b.mailgun_region === 'eu' ? 'eu' : 'us' });
  if (provider === 'postmark') Object.assign(s, { message_stream: t('message_stream') });
  for (const k of Object.keys(s) as (keyof ServiceSettings)[]) if (s[k] === undefined) delete s[k];
  const problems = settingsProblems(provider, s, hasSecret || !!b.secret);
  if (problems.length) throw new Error(problems.join(' '));
  return { provider, settings: s, senders, description: t('description') ?? null, enabled: b.enabled === 'true' };
}

const STATUS_CLASS: Record<string, string> = { sent: ' tag-ok', queued: '', sending: '', error: ' tag-error', cancelled: '' };

const mailTable = (rows: any[], withApp: boolean, actions?: (m: any) => unknown) => html`<div class="table-wrap"><table class="report report-reflow">
  <thead><tr><th>Queued (UTC)</th>${withApp ? html`<th>Application</th>` : ''}<th>To</th><th>Subject</th><th>From</th><th class="num">Attempts</th><th>Status</th>${actions ? html`<th>Actions</th>` : ''}</tr></thead>
  <tbody>${rows.length ? rows.map((m) => html`<tr>
    <td data-label="Queued">${when(m.created_at)}</td>${withApp ? html`<td data-label="Application">${m.app ?? ''}</td>` : ''}
    <td data-label="To" class="u-break">${[...m.to_addresses, ...m.cc_addresses].join(', ')}${m.bcc_addresses.length ? html` <span class="muted">+${m.bcc_addresses.length} bcc</span>` : ''}</td>
    <td data-label="Subject" class="u-break">${m.subject}${m.template ? html` <span class="muted">(${m.template})</span>` : ''}</td>
    <td data-label="From" class="u-break">${m.from_address ?? ''}</td>
    <td class="num" data-label="Attempts">${m.attempts}</td>
    <td data-label="Status"><span class="tag${STATUS_CLASS[m.status] ?? ''}">${m.status}</span>${m.sent_at ? html` <span class="muted">${when(m.sent_at)}</span>` : ''}${m.message ? html`<br><span class="muted u-break">${m.message}</span>` : ''}</td>
    ${actions ? html`<td data-label="Actions">${actions(m)}</td>` : ''}</tr>`)
    : html`<tr><td colspan="${7 + (withApp ? 1 : 0) + (actions ? 1 : 0)}" class="empty">No mail yet.</td></tr>`}</tbody></table></div>`;

async function adminOnly(s: Session, reply: any, title: string) {
  if (await isAdmin(s.username)) return true;
  const main = html`<h1 class="u-mb1">${title}</h1><div class="alert alert-error" role="alert">Only administrators configure mail services.</div>`;
  await send(reply.code(403), s, shell(s, title, [['App Builder', BASE], ['Workspace utilities', `${BASE}/utilities`], [title]], main));
  return false;
}

const MAIL_COLUMNS = 'q.id, q.app_id, q.to_addresses, q.cc_addresses, q.bcc_addresses, q.subject, q.template, q.from_address, q.attempts, q.status, q.message, q.created_at, q.sent_at';

export async function mailRoutes(app: FastifyInstance) {
  app.get(`${BASE}/mail`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply, 'Mail services'))) return;
    const services = (await owner.query(`select s.id, s.name, s.description, s.provider, s.senders, s.enabled, s.secret_enc is not null as has_secret,
        (select string_agg(a.alias, ', ' order by a.alias) from meta.app_mail_service x join meta.app a on a.id = x.app_id where x.service_id = s.id) as apps
      from meta.mail_service s order by s.name`)).rows;
    const recent = (await owner.query(`select ${MAIL_COLUMNS}, a.alias as app from meta.mail_queue q left join meta.app a on a.id = q.app_id order by q.id desc limit 100`)).rows;
    const main = html`
      <div class="title-row"><h1>Mail services</h1></div>
      <p class="muted u-mt0">How the applications of this installation send e-mail (<code>meta.send_mail()</code> from SQL, the <b>Send e-mail</b> process, e-mail templates). Mail is queued in the application's transaction and sent by the server after it commits. Choose the service of each application on the service's page.</p>
      <div class="columns wide-left">
        ${region('Services', html`<div class="table-wrap"><table class="report report-reflow">
          <thead><tr><th>Service</th><th>Provider</th><th>Senders</th><th>Secret</th><th>Applications</th><th>Status</th></tr></thead>
          <tbody>${services.length ? services.map((x) => html`<tr>
            <td data-label="Service"><a href="${BASE}/mail/${x.id}">${x.name}</a>${x.description ? html` <span class="muted">${x.description}</span>` : ''}</td>
            <td data-label="Provider">${PROVIDER_LABELS[x.provider as Provider]}</td>
            <td data-label="Senders" class="u-break">${x.senders.join(', ')}</td>
            <td data-label="Secret">${x.has_secret ? 'stored (encrypted)' : x.provider === 'log' ? '–' : html`<b>missing</b>`}</td>
            <td data-label="Applications">${x.apps ?? html`<span class="muted">none</span>`}</td>
            <td data-label="Status">${x.enabled ? 'enabled' : html`<b>disabled</b>`}</td></tr>`)
            : html`<tr><td colspan="6" class="empty">No mail services yet.</td></tr>`}</tbody></table></div>`)}
        ${region('Add service', serviceForm({}, `${BASE}/mail`, csrf(s), true))}
      </div>
      ${region('Recent mail', mailTable(recent, true))}`;
    return send(reply, s, shell(s, 'Mail services', [['App Builder', BASE], ['Workspace utilities', `${BASE}/utilities`], ['Mail services']], main));
  });

  app.post(`${BASE}/mail`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply, 'Mail services'))) return;
    const b = req.body ?? {};
    try {
      const name = (b.name ?? '').trim().toUpperCase();
      if (!/^[A-Z][A-Z0-9_]{0,59}$/.test(name)) throw new Error('The name is upper case letters, digits and _ (e.g. OFFICE365).');
      const v = formValues(b, false);
      const secret = b.secret ? encryptSecret(b.secret) : null;
      const r = await owner.one(
        `insert into meta.mail_service (name, description, provider, settings, senders, enabled, secret_enc) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [name, v.description, v.provider, JSON.stringify(v.settings), v.senders, v.enabled, secret]);
      flash(s, 'Mail service added. Choose the applications that send through it below, and test it.');
      return back(reply, s, `${BASE}/mail/${r.id}`);
    } catch (e) {
      flash(s, (e as Error).message.includes('mail_service_name_key') ? 'A service with this name exists already.' : (e as Error).message, 'error');
      return back(reply, s, `${BASE}/mail`);
    }
  });

  app.get(`${BASE}/mail/:id(^\\d+$)`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply, 'Mail services'))) return;
    const x = await owner.one<MailService & { has_secret: boolean }>(
      'select id, name, description, provider, settings, senders, enabled, secret_enc is not null as has_secret from meta.mail_service where id = $1', [req.params.id]);
    if (!x) return reply.code(404).send('Not found');
    const apps = (await owner.query(`select a.id, a.alias, a.name, x.service_id, x.from_address, x.max_per_day, o.name as other
      from meta.app a left join meta.app_mail_service x on x.app_id = a.id left join meta.mail_service o on o.id = x.service_id and o.id <> $1
      order by a.alias`, [x.id])).rows;
    let test: { ok: boolean; text: string } | null = null;
    try {
      const t = JSON.parse(s.state[TEST_RESULT] ?? 'null');
      if (t?.id === x.id) test = t;
    } catch {
      // ignored
    }
    delete s.state[TEST_RESULT];
    const recent = (await owner.query(`select ${MAIL_COLUMNS}, a.alias as app from meta.mail_queue q left join meta.app a on a.id = q.app_id
       where q.service = $1 or q.app_id in (select app_id from meta.app_mail_service where service_id = $2) order by q.id desc limit 50`, [x.name, x.id])).rows;
    const main = html`
      <div class="title-row"><h1 class="mail-name">${x.name}</h1></div>
      <div class="columns wide-left">
        ${region('Settings', html`${serviceForm(x, `${BASE}/mail/${x.id}`, csrf(s), false)}
          <form method="post" action="${BASE}/mail/${x.id}/delete" class="danger-zone">${csrf(s)}
            <button class="btn btn-danger" data-confirm="Delete mail service ${x.name}? Its applications can't send mail until they get another one.">Delete service</button></form>`)}
        ${region('Test', html`
          <p class="muted u-mt0">Sends a short message now, through this service (not through the queue).</p>
          <form method="post" action="${BASE}/mail/${x.id}/test">${csrf(s)}<div class="form-grid">
            ${input('to', 'To', '', { type: 'email', required: true })}
            ${input('from', 'From', x.settings?.default_from ?? x.senders.find((a) => !a.startsWith('@')) ?? '', { type: 'email', required: true })}
            </div><div class="buttons"><button class="btn">${icon('send')} Send test</button></div></form>
          ${test ? html`<div class="alert ${test.ok ? 'alert-success' : 'alert-error'}" role="status">${test.text}</div>` : ''}`)}
      </div>
      ${region('Applications', html`<p class="muted u-mt0">The applications that send through this service (each application has one), their From address (empty: the service's default) and a limit per day (UTC; empty: none). An application with another service shows it.</p>
        <form method="post" action="${BASE}/mail/${x.id}/apps">${csrf(s)}
        <div class="table-wrap"><table class="report report-reflow"><thead><tr><th>Application</th><th>Sends through this service</th><th>From address</th><th>Mails per day</th></tr></thead>
        <tbody>${apps.length ? apps.map((a) => html`<tr>
          <td data-label="Application">${a.name} <span class="muted">${a.alias}</span></td>
          <td data-label="Sends through this service"><label class="check"><input type="checkbox" name="allow" value="${a.id}"${a.service_id === x.id ? raw(' checked') : ''}> yes</label>${a.other ? html` <span class="muted">now: ${a.other}</span>` : ''}</td>
          <td data-label="From address"><input type="email" name="from_${a.id}" value="${a.service_id === x.id ? a.from_address ?? '' : ''}" aria-label="From address for ${a.alias}"></td>
          <td data-label="Mails per day"><input type="number" min="0" name="max_${a.id}" value="${a.service_id === x.id ? a.max_per_day ?? '' : ''}" aria-label="Mails per day for ${a.alias}"></td></tr>`)
          : html`<tr><td colspan="4" class="empty">No applications.</td></tr>`}</tbody></table></div>
        <div class="buttons"><button class="btn btn-hot">Save</button></div></form>`)}
      ${region('Recent mail', mailTable(recent, true))}`;
    return send(reply, s, shell(s, x.name, [['App Builder', BASE], ['Workspace utilities', `${BASE}/utilities`], ['Mail services', `${BASE}/mail`], [x.name]], main));
  });

  app.post(`${BASE}/mail/:id(^\\d+$)`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply, 'Mail services'))) return;
    const b = req.body ?? {};
    try {
      const old = await owner.one<{ has_secret: boolean }>('select secret_enc is not null as has_secret from meta.mail_service where id = $1', [req.params.id]);
      if (!old) throw new Error('Not found.');
      const v = formValues(b, old.has_secret && b.remove_secret !== 'true');
      const secret = b.secret ? encryptSecret(b.secret) : null;
      await owner.query(
        `update meta.mail_service set description = $2, provider = $3, settings = $4, senders = $5, enabled = $6, updated_at = now(),
                secret_enc = case when $8 then null when $7::text is null then secret_enc else $7 end
          where id = $1`,
        [req.params.id, v.description, v.provider, JSON.stringify(v.settings), v.senders, v.enabled, secret, b.remove_secret === 'true' && !b.secret]);
      flash(s, 'Mail service saved.');
    } catch (e) {
      flash(s, (e as Error).message, 'error');
    }
    return back(reply, s, `${BASE}/mail/${req.params.id}`);
  });

  app.post(`${BASE}/mail/:id(^\\d+$)/apps`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply, 'Mail services'))) return;
    const b = req.body as Record<string, string | string[] | undefined>;
    const allow = new Set([b.allow ?? []].flat().map(Number).filter(Number.isInteger));
    try {
      const service = await owner.one<{ senders: string[] }>('select senders from meta.mail_service where id = $1', [req.params.id]);
      if (!service) throw new Error('Not found.');
      await owner.tx(async (c) => {
        const apps = (await c.query<{ id: number }>('select id from meta.app')).rows.map((a) => a.id);
        await c.query('delete from meta.app_mail_service where service_id = $1 and not (app_id = any($2::int[]))', [req.params.id, [...allow]]);
        for (const id of apps.filter((a) => allow.has(a))) {
          const from = String(b[`from_${id}`] ?? '').trim() || null;
          if (from && (!ADDRESS.test(from) || !senderAllowed(service.senders, from))) throw new Error(`${from} is not an address this service may send as.`);
          const max = String(b[`max_${id}`] ?? '').trim();
          if (max && !(Number.isInteger(Number(max)) && Number(max) >= 0)) throw new Error('Mails per day: a whole number of 0 or more (empty: no limit).');
          await c.query(
            `insert into meta.app_mail_service (app_id, service_id, from_address, max_per_day) values ($1, $2, $3, $4)
             on conflict (app_id) do update set service_id = excluded.service_id, from_address = excluded.from_address, max_per_day = excluded.max_per_day`,
            [id, req.params.id, from, max ? Number(max) : null]);
        }
      });
      flash(s, 'Applications saved.');
    } catch (e) {
      flash(s, (e as Error).message, 'error');
    }
    return back(reply, s, `${BASE}/mail/${req.params.id}`);
  });

  app.post(`${BASE}/mail/:id(^\\d+$)/test`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply, 'Mail services'))) return;
    const x = await owner.one<MailService>('select * from meta.mail_service where id = $1', [req.params.id]);
    if (!x) return reply.code(404).send('Not found');
    const to = String(req.body?.to ?? '').trim();
    const from = String(req.body?.from ?? '').trim();
    let result: { id: number; ok: boolean; text: string };
    try {
      if (!ADDRESS.test(to) || !ADDRESS.test(from)) throw new MailError('Give a To and a From address.', false);
      const id = await sendWith({ ...x, enabled: true }, {
        from, to: [to], cc: [], bcc: [], replyTo: null, subject: `pgkiln: test of mail service ${x.name}`,
        text: `This is a test of the mail service ${x.name}, sent from the App Builder by ${s.username}.`,
        html: null, attachments: [],
      });
      result = { id: x.id, ok: true, text: `Sent${id ? ` (the provider's id: ${id})` : ''}. Check the mailbox of ${to}.` };
    } catch (e) {
      result = { id: x.id, ok: false, text: e instanceof MailError ? e.message : 'The test failed.' };
    }
    s.state[TEST_RESULT] = JSON.stringify(result);
    return back(reply, s, `${BASE}/mail/${x.id}`);
  });

  app.post(`${BASE}/mail/:id(^\\d+$)/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply, 'Mail services'))) return;
    await owner.query('delete from meta.mail_service where id = $1', [req.params.id]);
    flash(s, 'Mail service deleted.');
    return back(reply, s, `${BASE}/mail`);
  });

  // ---------------------------------------------------------------- per application (developers)
  app.get(`${BASE}/apps/:id(^\\d+$)/mail`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await owner.one<{ id: number; alias: string; name: string }>('select id, alias, name from meta.app where id = $1', [req.params.id]);
    if (!a) return reply.code(404).send('Not found');
    const service = await owner.one(`select s.name, s.provider, s.enabled, x.from_address, x.max_per_day, s.settings->>'default_from' as default_from
      from meta.app_mail_service x join meta.mail_service s on s.id = x.service_id where x.app_id = $1`, [a.id]);
    const today = (await owner.one(`select count(*)::int as n from meta.mail_queue where app_id = $1 and created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' and status <> 'cancelled'`, [a.id])).n;
    const status = String(req.query.status ?? '');
    const rows = (await owner.query(`select ${MAIL_COLUMNS} from meta.mail_queue q where q.app_id = $1 and ($2 = '' or q.status = $2) order by q.id desc limit 200`, [a.id, status])).rows;
    const admin = await isAdmin(s.username);
    const action = (m: any) => m.status === 'error' || m.status === 'cancelled'
      ? html`<form method="post" action="${BASE}/apps/${a.id}/mail/${m.id}/retry">${csrf(s)}<button class="btn btn-sm">Send again</button></form>`
      : m.status === 'queued' ? html`<form method="post" action="${BASE}/apps/${a.id}/mail/${m.id}/cancel">${csrf(s)}<button class="btn btn-sm">Cancel</button></form>` : '';
    const main = html`
      <div class="title-row"><h1 class="mail-name">Mail · ${a.name}</h1></div>
      <p class="muted u-mt0">The mail this application queued (<code>meta.send_mail()</code>, the Send e-mail process), kept 30 days. ${service
        ? html`It sends through <b>${service.name}</b> (${PROVIDER_LABELS[service.provider as Provider]}${service.enabled ? '' : ', disabled'}) as ${service.from_address ?? service.default_from ?? html`<i>no From address</i>`}; today: ${today}${service.max_per_day !== null ? ` of ${service.max_per_day}` : ''}.`
        : html`<b>It may not send mail yet</b>: an administrator chooses its mail service${admin ? html` under <a href="${BASE}/mail">Mail services</a>` : ''}.`}</p>
      <form method="get" class="u-mb1">${select('status', 'Status', status, [['', 'All'], ['queued', 'Queued'], ['sending', 'Sending'], ['sent', 'Sent'], ['error', 'Error'], ['cancelled', 'Cancelled']])}<button class="btn btn-sm">Show</button></form>
      ${region('Mail', mailTable(rows, false, action))}`;
    return send(reply, s, shell(s, `Mail · ${a.name}`, [['App Builder', BASE], [a.name, `${BASE}/apps/${a.id}`], ['Activity', `${BASE}/apps/${a.id}/activity`], ['Mail']], main));
  });

  const change = (to: 'queued' | 'cancelled', from: string[]) => async (req: Req, reply: any) => {
    const s = await developer(req, reply);
    if (!s) return;
    const r = await owner.query(
      `update meta.mail_queue set status = $3, attempts = case when $3 = 'queued' then 0 else attempts end, not_before = now(),
              message = case when $3 = 'cancelled' then 'Cancelled by ' || $4 else message end
        where id = $1 and app_id = $2 and status = any($5::text[])`,
      [req.params.mid, req.params.id, to, s.username, from]);
    if (r.rowCount && to === 'queued') await owner.query(`select pg_notify('pgkiln_mail', $1)`, [String(req.params.mid)]);
    flash(s, r.rowCount ? (to === 'queued' ? 'The mail is queued again.' : 'The mail is cancelled.') : 'The mail has changed meanwhile.', r.rowCount ? 'ok' : 'error');
    return back(reply, s, `${BASE}/apps/${req.params.id}/mail`);
  };
  app.post(`${BASE}/apps/:id(^\\d+$)/mail/:mid(^\\d+$)/retry`, change('queued', ['error', 'cancelled']));
  app.post(`${BASE}/apps/:id(^\\d+$)/mail/:mid(^\\d+$)/cancel`, change('cancelled', ['queued']));
}
