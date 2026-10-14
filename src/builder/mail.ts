import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw } from '../html.ts';
import { icon } from '../icons.ts';
import { senderAllowed, sendWith, type MailService } from '../mail/mail.ts';
import { deliver, MailError, PROVIDER_LABELS, PROVIDERS, settingsProblems, verifyConnection, type Provider, type ServiceSettings } from '../mail/providers.ts';
import { decryptSecret, encryptSecret, secretKeyConfigured } from '../secrets.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
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

const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const SENDER = /^(@|[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

const check = (name: string, label: string, on: boolean, help?: string) =>
  html`<div class="field"><label class="check"><input type="checkbox" name="${name}" value="true"${on ? raw(' checked') : ''}> ${label}</label>${help ? html`<small class="help">${help}</small>` : ''}</div>`;
const when = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 19).replace('T', ' ') : '');

const SECRET_LABEL: Record<Provider, string> = {
  smtp: 'Password, or the client secret (OAuth2)', graph: 'Client secret', ses: 'Secret access key', resend: 'API key',
  postmark: 'Server token', sendgrid: 'API key', mailgun: 'API key', log: 'Secret (not used)',
};

/** What each provider is, for the choice of a new service. */
const PROVIDER_TEXT: Record<Provider, [icon: string, text: string]> = {
  smtp: ['send', 'Any SMTP server or relay. Sign in with a password, or with OAuth2 (Exchange Online, Google Workspace).'],
  graph: ['building', 'Microsoft 365 through the Graph API, as an Entra application with Mail.Send.'],
  ses: ['database', 'Amazon Simple Email Service (API v2), with an IAM access key.'],
  resend: ['send', 'Resend\'s HTTP API, with an API key.'],
  postmark: ['send', 'Postmark\'s HTTP API, with a server token.'],
  sendgrid: ['send', 'SendGrid\'s HTTP API, with an API key.'],
  mailgun: ['send', 'Mailgun\'s HTTP API, with an API key and a sending domain.'],
  log: ['list', 'For development and demos: the server writes each mail to its log and sends nothing.'],
};

/** Step 1 of a new service: choose the provider. */
function providerChoice() {
  return html`<div class="ab-tiles ab-tiles-wrap">${PROVIDERS.map((p) =>
    html`<a class="ab-tile" href="${BASE}/mail/new?provider=${p}"><span class="ab-tile-icon">${icon(PROVIDER_TEXT[p][0])}</span><strong>${PROVIDER_LABELS[p]}</strong><span>${PROVIDER_TEXT[p][1]}</span></a>`)}</div>`;
}

/** The settings of one provider only, in groups (a new service, or an existing one switching provider). */
function serviceForm(x: Partial<MailService> & { has_secret?: boolean }, provider: Provider, action: string, csrfField: ReturnType<typeof csrf>, isNew: boolean,
  tried: { ok: boolean; text: string; to?: string; from?: string } | null = null) {
  const s: ServiceSettings = x.provider === provider ? x.settings ?? {} : { default_from: x.settings?.default_from };
  const group = (legend: string, body: unknown, help?: string) =>
    html`<fieldset class="prop-group"><legend>${legend}</legend>${help ? html`<p class="muted u-mt0">${help}</p>` : ''}${body}</fieldset>`;
  const oauth = (scope: string) => html`<div class="form-grid">
      ${input('tenant_id', 'Tenant ID (Microsoft Entra)', s.tenant_id, { placeholder: 'contoso.onmicrosoft.com or its GUID' })}
      ${input('client_id', 'Client (application) ID', s.client_id)}
      ${input('token_url', 'Token URL', s.token_url, { placeholder: 'empty: Microsoft Entra of the tenant', help: 'Another identity provider\'s token endpoint (client credentials grant), e.g. Google\'s.' })}
      ${input('scope', 'Scope', s.scope, { placeholder: `empty: ${scope}` })}
    </div>`;
  const settings =
    provider === 'smtp'
      ? html`${group('SMTP server', html`<div class="form-grid">
          ${input('host', 'Host', s.host, { required: true, placeholder: 'smtp.office365.com' })}
          ${input('port', 'Port', s.port ?? '', { type: 'number', placeholder: '587', help: 'Empty: 587 (STARTTLS) or 465 (TLS).' })}
          ${select('security', 'Security', s.security ?? 'starttls', [['starttls', 'STARTTLS (required)'], ['tls', 'TLS from the start (port 465)'], ['none', 'None (a local relay only)']])}
          ${select('auth', 'Sign-in', s.auth ?? 'password', [['password', 'User name and password'], ['oauth2', 'OAuth2 (XOAUTH2, client credentials)'], ['none', 'None']],
            'Microsoft 365 no longer takes passwords for SMTP: choose OAuth2 with an Entra application (SMTP.SendAsApp), or the Microsoft 365 (Graph) provider.')}
          ${input('username', 'User name', s.username, { placeholder: 'the mailbox, e.g. noreply@example.com' })}
        </div>${check('tls_verify', 'Check the server\'s certificate', s.tls_verify !== false, 'Switch off only for a relay with a self-signed certificate on your own network.')}`)}
        <details class="prop-group prop-group-more"${s.auth === 'oauth2' ? raw(' open') : ''}><summary>OAuth2 sign-in <span class="muted">(only with Sign-in: OAuth2)</span></summary>${oauth('https://outlook.office365.com/.default')}</details>`
      : provider === 'graph'
        ? group('Microsoft Entra application', html`${oauth('https://graph.microsoft.com/.default')}
            ${check('save_to_sent_items', 'Keep a copy in the mailbox\'s Sent Items', s.save_to_sent_items === true)}`,
          'An application in Microsoft Entra with a client secret and the application permission Mail.Send, limited to the sending mailboxes.')
        : provider === 'ses'
          ? group('Amazon SES', html`<div class="form-grid">
              ${input('region', 'AWS region', s.region, { required: true, placeholder: 'eu-west-1' })}
              ${input('access_key_id', 'Access key ID', s.access_key_id, { required: true })}</div>`,
            'An IAM user allowed ses:SendEmail; the From addresses must be verified identities in SES.')
          : provider === 'mailgun'
            ? group('Mailgun', html`<div class="form-grid">
                ${input('domain', 'Sending domain', s.domain, { required: true, placeholder: 'mg.example.com' })}
                ${select('mailgun_region', 'Region', s.mailgun_region ?? 'us', [['us', 'US'], ['eu', 'EU']])}</div>`)
            : provider === 'postmark'
              ? group('Postmark', html`<div class="form-grid">${input('message_stream', 'Message stream', s.message_stream, { placeholder: 'outbound' })}</div>`)
              : '';
  const secret = provider === 'log' ? '' : group(SECRET_LABEL[provider], html`
      ${input('secret', SECRET_LABEL[provider], '', { type: 'password', auto: 'new-password',
        help: x.has_secret && x.provider === provider ? 'A secret is stored (encrypted). It is never shown; type a new one to replace it.' : 'Stored encrypted; never shown again.' })}
      ${x.has_secret ? check('remove_secret', 'Remove the stored secret', false) : ''}
      ${secretKeyConfigured() ? '' : html`<div class="alert alert-error" role="alert">The server has no <code>PGKILN_SECRET_KEY</code>: secrets can't be stored until it is set.</div>`}`);
  const viaHttp = provider !== 'smtp' && provider !== 'log';
  return html`<form method="post" action="${action}" class="mail-service-form">${csrfField}
    <input type="hidden" name="provider" value="${provider}">
    ${group('Service', html`<div class="form-grid">
      ${isNew ? input('name', 'Name', '', { required: true, placeholder: 'e.g. OFFICE365', help: 'Upper case letters, digits and _.' }) : ''}
      ${input('description', 'Description', x.description)}
    </div>${check('enabled', 'Enabled', x.enabled !== false, 'A disabled service sends nothing: mail stays queued until it is enabled, or fails after its retries.')}`)}
    ${group('Senders', html`<div class="form-grid">
      ${input('senders', 'Allowed senders', (x.senders ?? []).join(', '), { required: true, placeholder: 'noreply@example.com, @example.com',
        help: 'The From addresses this service may send as: an address, or @domain for every address of a domain (the provider must accept them too).' })}
      ${input('default_from', 'Default From address', s.default_from, { placeholder: 'noreply@example.com', help: 'For applications that set none.' })}
    </div>`)}
    ${settings}
    ${secret}
    ${viaHttp ? html`<details class="prop-group prop-group-more"${s.base_url ? raw(' open') : ''}><summary>Advanced</summary><div class="form-grid">
      ${input('base_url', 'API base URL', s.base_url, { placeholder: 'empty: the provider\'s own API', help: 'A gateway or proxy that speaks the provider\'s API. Administrators only.' })}</div></details>` : ''}
    ${group('Check before saving', html`
      ${x.id ? html`<input type="hidden" name="service_id" value="${x.id}">` : ''}
      <div class="buttons mail-check-buttons"><button class="btn" formaction="${BASE}/mail/check" formnovalidate name="check" value="connection">${icon('play')} Test connection</button></div>
      <div class="form-grid">
        ${input('test_to', 'Send a test mail to', tried?.to ?? '', { type: 'email', placeholder: 'you@example.com' })}
        ${input('test_from', 'From', tried?.from ?? s.default_from ?? (x.senders ?? []).find((a) => !a.startsWith('@')) ?? '', { type: 'email', help: 'One of the allowed senders.' })}
      </div>
      <div class="buttons mail-check-buttons"><button class="btn" formaction="${BASE}/mail/check" formnovalidate name="check" value="send">${icon('send')} Send test mail</button></div>
      <div class="mail-check-result" role="status" aria-live="polite">${tried ? html`<div class="alert ${tried.ok ? 'alert-success' : 'alert-error'}">${tried.text}</div>` : ''}</div>`,
      `Uses the settings above as they are filled in, without saving them.${x.has_secret ? ' An empty secret field uses the stored secret.' : ''} Test connection signs in (SMTP) or makes a read-only call with the key; a test mail is really sent.`)}
    <div class="buttons">${isNew ? html`<a class="btn" href="${BASE}/mail/new">Choose another provider</a>` : ''}<button class="btn btn-hot">${isNew ? 'Add service' : 'Save'}</button></div>
  </form>`;
}

/** The form's values for the chosen provider, as typed (not checked). */
function parseForm(b: Record<string, string | undefined>) {
  const provider = (PROVIDERS as readonly string[]).includes(b.provider ?? '') ? (b.provider as Provider) : 'smtp';
  const t = (k: string) => (b[k] ?? '').trim() || undefined;
  const senders = [...new Set((b.senders ?? '').split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))];
  const defaultFrom = t('default_from');
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
  return { provider, settings: s, senders, description: t('description') ?? null, enabled: b.enabled === 'true' };
}

/**
 * The form's values, checked; throws with a message. A check of the connection
 * (opts.connection) needs the provider's settings only, not yet the senders.
 */
function formValues(b: Record<string, string | undefined>, hasSecret: boolean, opts: { connection?: boolean } = {}) {
  const v = parseForm(b);
  if (!opts.connection || v.senders.length) {
    if (!v.senders.length) throw new Error('Name at least one allowed sender (an address, or @domain).');
    const bad = v.senders.find((x) => !SENDER.test(x));
    if (bad) throw new Error(`"${bad}" is not an address or @domain.`);
    const from = v.settings.default_from;
    if (from && (!ADDRESS.test(from) || !senderAllowed(v.senders, from))) throw new Error('The default From address must be an address the service may send as.');
  }
  const problems = settingsProblems(v.provider, v.settings, hasSecret || !!b.secret);
  if (problems.length) throw new Error(problems.join(' '));
  return v;
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
      ${region('Services', html`<div class="table-wrap"><table class="report report-reflow">
          <thead><tr><th>Service</th><th>Provider</th><th>Senders</th><th>Secret</th><th>Applications</th><th>Status</th></tr></thead>
          <tbody>${services.length ? services.map((x) => html`<tr>
            <td data-label="Service"><a href="${BASE}/mail/${x.id}">${x.name}</a>${x.description ? html` <span class="muted">${x.description}</span>` : ''}</td>
            <td data-label="Provider">${PROVIDER_LABELS[x.provider as Provider]}</td>
            <td data-label="Senders" class="u-break">${x.senders.join(', ')}</td>
            <td data-label="Secret">${x.has_secret ? 'stored (encrypted)' : x.provider === 'log' ? '–' : html`<b>missing</b>`}</td>
            <td data-label="Applications">${x.apps ?? html`<span class="muted">none</span>`}</td>
            <td data-label="Status">${x.enabled ? 'enabled' : html`<b>disabled</b>`}</td></tr>`)
            : html`<tr><td colspan="6" class="empty">No mail services yet.</td></tr>`}</tbody></table></div>`,
        html`<a class="btn btn-sm btn-hot" href="${BASE}/mail/new">${icon('plus')} Add service</a>`)}
      ${await builderMailRegion(s, services)}
      ${region('Recent mail', mailTable(recent, true))}`;
    return send(reply, s, shell(s, 'Mail services', [['App Builder', BASE], ['Workspace utilities', `${BASE}/utilities`], ['Mail services']], main));
  });

  // (096) the builder's own mail ("Find my workspace"): a service and a From address it may send as
  app.post(`${BASE}/mail/builder`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply, 'Mail services'))) return;
    const name = String(req.body?.service ?? '');
    const from = String(req.body?.from ?? '').trim();
    try {
      if (!name) await owner.query(`delete from meta.setting where name in ('builder_mail_service', 'builder_mail_from')`);
      else {
        const svc = await owner.one<{ senders: string[] }>('select senders from meta.mail_service where name = $1', [name]);
        if (!svc) throw new Error('Choose one of the mail services.');
        if (!/^[^@\s<>"]+@[^@\s<>"]+$/.test(from)) throw new Error('The From address is an e-mail address, e.g. pgkiln@example.com.');
        if (!senderAllowed(svc.senders, from)) throw new Error(`The service ${name} may not send as ${from}: add it to its senders first.`);
        await owner.tx(async (c) => {
          for (const [k, v] of [['builder_mail_service', name], ['builder_mail_from', from]])
            await c.query('insert into meta.setting (name, value) values ($1, $2) on conflict (name) do update set value = excluded.value', [k, v]);
        });
      }
      await logActivity({ appId: null, username: s.username, event: 'mail_service', ip: clientIp(req), detail: name ? `builder mail: ${name} as ${from}` : 'builder mail: none' });
      flash(s, name ? 'Builder mail saved: "Find my workspace" sends through it.' : 'The builder sends no mail now.');
    } catch (e) {
      flash(s, (e as Error).message, 'error');
    }
    return back(reply, s, `${BASE}/mail#builder-mail`);
  });

  // a new service: choose the provider, then its settings only
  app.get(`${BASE}/mail/new`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply, 'Mail services'))) return;
    const provider = (PROVIDERS as readonly string[]).includes(String(req.query.provider)) ? (req.query.provider as Provider) : null;
    const main = html`<div class="title-row"><h1>Add a mail service</h1></div>
      ${provider
        ? html`<p class="muted u-mt0">Step 2 of 2: <b>${PROVIDER_LABELS[provider]}</b>. ${PROVIDER_TEXT[provider][1]}</p>
            <div class="mail-form-page">${region('Settings', serviceForm({}, provider, `${BASE}/mail`, csrf(s), true))}</div>`
        : html`<p class="muted u-mt0">Step 1 of 2: how should the applications send mail?</p>${providerChoice()}`}`;
    return send(reply, s, shell(s, 'Add a mail service', [['App Builder', BASE], ['Workspace utilities', `${BASE}/utilities`], ['Mail services', `${BASE}/mail`], ['Add']], main));
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
      return back(reply, s, `${BASE}/mail/new?provider=${encodeURIComponent(String(b.provider ?? ''))}`);
    }
  });

  app.get(`${BASE}/mail/:id(^\\d+$)`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply, 'Mail services'))) return;
    const x = await owner.one<MailService & { has_secret: boolean }>(
      'select id, name, description, provider, settings, senders, enabled, secret_enc is not null as has_secret from meta.mail_service where id = $1', [req.params.id]);
    if (!x) return reply.code(404).send('Not found');
    const provider = (PROVIDERS as readonly string[]).includes(String(req.query.provider)) ? (req.query.provider as Provider) : x.provider;
    const apps = (await owner.query(`select a.id, a.alias, a.name, x.service_id, x.from_address, x.max_per_day, o.name as other
      from meta.app a left join meta.app_mail_service x on x.app_id = a.id left join meta.mail_service o on o.id = x.service_id and o.id <> $1
      order by a.alias`, [x.id])).rows;
    const recent = (await owner.query(`select ${MAIL_COLUMNS}, a.alias as app from meta.mail_queue q left join meta.app a on a.id = q.app_id
       where q.service = $1 or q.app_id in (select app_id from meta.app_mail_service where service_id = $2) order by q.id desc limit 50`, [x.name, x.id])).rows;
    const main = html`
      <div class="title-row"><h1 class="mail-name">${x.name}</h1></div>
      <div class="mail-form-page">
        ${region('Settings', html`
          <form method="get" class="provider-switch">${select('provider', 'Provider', provider, PROVIDERS.map((p): [string, string] => [p, PROVIDER_LABELS[p]]),
            provider !== x.provider ? 'Not saved yet: fill in the settings below and save to switch.' : undefined)}<button class="btn btn-sm">Change</button></form>
          ${serviceForm(x, provider, `${BASE}/mail/${x.id}`, csrf(s), false)}
          <form method="post" action="${BASE}/mail/${x.id}/delete" class="danger-zone">${csrf(s)}
            <button class="btn btn-danger" data-confirm="Delete mail service ${x.name}? Its applications can't send mail until they get another one.">Delete service</button></form>`)}
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

  // Test connection / Send test mail: the settings as filled in, not saved (the stored secret when none is typed).
  // JSON for builder.js; without JavaScript the form comes back with its values (the secret must be typed again).
  app.post(`${BASE}/mail/check`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply, 'Mail services'))) return;
    const b = (req.body ?? {}) as Record<string, string | undefined>;
    const id = /^\d{1,9}$/.test(b.service_id ?? '') ? Number(b.service_id) : null;
    const stored = id ? await owner.one<MailService>('select * from meta.mail_service where id = $1', [id]) : null;
    if (id && !stored) return reply.code(404).send('Not found');
    const typed = parseForm(b);
    const to = String(b.test_to ?? '').trim();
    const from = String(b.test_from ?? '').trim();
    let result: { ok: boolean; text: string };
    try {
      const sameProvider = stored?.provider === typed.provider;
      const v = formValues(b, !!(sameProvider && stored?.secret_enc), { connection: b.check !== 'send' });
      let secret: string | null = b.secret || null;
      if (!secret && sameProvider && stored?.secret_enc) {
        try {
          secret = decryptSecret(stored.secret_enc);
        } catch (e) {
          throw new MailError(`The stored secret can't be read: ${(e as Error).message}`, false);
        }
      }
      if (b.check === 'send') {
        if (!ADDRESS.test(to)) throw new MailError('Give the address to send the test mail to.', false);
        if (!ADDRESS.test(from) || !senderAllowed(v.senders, from)) throw new MailError('The From address must be one of the allowed senders.', false);
        const pid = await deliver(v.provider, v.settings, secret, {
          from, to: [to], cc: [], bcc: [], replyTo: null, subject: `pgkiln: test of a mail service (${PROVIDER_LABELS[v.provider]})`,
          text: `This is a test of a pgkiln mail service${stored ? ` (${stored.name})` : ''}, sent from the App Builder by ${s.username}.`, html: null, attachments: [],
        });
        result = { ok: true, text: `The test mail was handed to ${PROVIDER_LABELS[v.provider]}${pid ? ` (its id: ${pid})` : ''}. Check the mailbox of ${to}.` };
      } else result = { ok: true, text: await verifyConnection(v.provider, v.settings, secret) };
    } catch (e) {
      result = { ok: false, text: e instanceof MailError || !(e instanceof TypeError) ? (e as Error).message : 'The check failed.' };
    }
    await logActivity({ username: s.username, event: 'mail_check', ip: clientIp(req), detail: `${b.check === 'send' ? 'send' : 'connection'} ${typed.provider}${stored ? ` ${stored.name}` : ''}: ${result.ok ? 'ok' : 'failed'}` });
    if (String(req.headers.accept ?? '').includes('application/json')) return reply.header('cache-control', 'no-store').send(result);
    const x = { id: stored?.id, name: stored?.name, description: typed.description, provider: typed.provider, settings: typed.settings, senders: typed.senders, enabled: typed.enabled,
      has_secret: !!(stored?.secret_enc && stored.provider === typed.provider) };
    const main = html`<div class="title-row"><h1>${stored ? stored.name : 'Add a mail service'}</h1></div>
      <div class="mail-form-page">${region('Settings', serviceForm(x, typed.provider, stored ? `${BASE}/mail/${stored.id}` : `${BASE}/mail`, csrf(s), !stored, { ...result, to, from }))}</div>`;
    return send(reply, s, shell(s, 'Mail service', [['App Builder', BASE], ['Workspace utilities', `${BASE}/utilities`], ['Mail services', `${BASE}/mail`], [stored?.name ?? 'Add']], main));
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

/** (096) Mail services → Builder mail: the service and From address of the builder's own mail. */
async function builderMailRegion(s: Session, services: { name: string; enabled: boolean }[]) {
  const set = Object.fromEntries((await owner.query<{ name: string; value: string }>(`select name, value from meta.setting where name in ('builder_mail_service', 'builder_mail_from')`)).rows.map((r) => [r.name, r.value]));
  return region('Builder mail', html`<form method="post" action="${BASE}/mail/builder">${csrf(s)}
    <p class="muted u-mt0">The service the builder itself sends through: <b>Find my workspace</b> on the sign-in page mails developers their workspaces (to the address on their account). None: the builder sends no mail.</p>
    <div class="form-grid">
      ${select('service', 'Service', set.builder_mail_service ?? '', [['', 'None'], ...services.map((x) => [x.name, `${x.name}${x.enabled ? '' : ' (disabled)'}`] as [string, string])])}
      ${input('from', 'From address', set.builder_mail_from ?? '', { type: 'email', placeholder: 'pgkiln@example.com', help: 'One of the service\'s senders.' })}
    </div>
    <div class="buttons"><button class="btn">Save</button></div></form>`, '', 'builder-mail');
}
