import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw } from '../html.ts';
import { icon } from '../icons.ts';
import { senderAllowed, serviceSettings, verifyService, type MailService } from '../mail/mail.ts';
import { deliver, MailError, PROVIDER_LABELS, PROVIDERS, settingsProblems, verifyConnection, type Provider, type ServiceSettings } from '../mail/providers.ts';
import { decryptSecret, encryptSecret, secretKeyConfigured } from '../secrets.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import { isAdmin } from './locks.ts';
import { back, BASE, csrf, developer, flash, input, region, select, send, shell, type Req } from './ui.ts';
import { scopedTx as tx } from './i18n.ts';

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

const SECRET_LABEL = (p: Provider): string => ({
  smtp: tx('ml.password_or_the_client_secret'), graph: tx('ml.client_secret'), ses: tx('ml.secret_access_key'), resend: tx('ml.api_key'),
  postmark: tx('ml.server_token'), sendgrid: tx('ml.api_key'), mailgun: tx('ml.api_key'), log: tx('ml.secret_not_used'),
})[p];

/** What each provider is, for the choice of a new service. */
export const PROVIDER_TEXT = (p: Provider): [icon: string, text: string] => ({
  smtp: ['send', tx('ml.any_smtp_server_or_relay')],
  graph: ['building', tx('ml.microsoft_365_through_the_graph')],
  ses: ['database', tx('ml.amazon_simple_email_service_api')],
  resend: ['send', tx('ml.resend_s_http_api_with')],
  postmark: ['send', tx('ml.postmark_s_http_api_with')],
  sendgrid: ['send', tx('ml.sendgrid_s_http_api_with')],
  mailgun: ['send', tx('ml.mailgun_s_http_api_with')],
  log: ['list', tx('ml.for_development_and_demos_the')],
} as Record<Provider, [string, string]>)[p];

/** Step 1 of a new service: choose the provider. */
function providerChoice() {
  return html`<div class="ab-tiles ab-tiles-wrap">${PROVIDERS.map((p) =>
    html`<a class="ab-tile" href="${BASE}/mail/new?provider=${p}"><span class="ab-tile-icon">${icon(PROVIDER_TEXT(p)[0])}</span><strong>${PROVIDER_LABELS[p]}</strong><span>${PROVIDER_TEXT(p)[1]}</span></a>`)}</div>`;
}

/**
 * The settings of one provider only, in groups (a new service, or an existing one switching provider).
 * (sprint 118) `ws`: a workspace's own service: no name (it is the workspace's), no base URL or token URL
 * (the providers' own APIs only), and the checks go to the workspace's page.
 */
export function serviceForm(x: Partial<MailService> & { has_secret?: boolean }, provider: Provider, action: string, csrfField: ReturnType<typeof csrf>, isNew: boolean,
  tried: { ok: boolean; text: string; to?: string; from?: string } | null = null, ws: { id: number } | null = null) {
  const checkAction = ws ? `${BASE}/workspaces/${ws.id}/mail/check` : `${BASE}/mail/check`;
  const s: ServiceSettings = x.provider === provider ? x.settings ?? {} : { default_from: x.settings?.default_from };
  const group = (legend: string, body: unknown, help?: string) =>
    html`<fieldset class="prop-group"><legend>${legend}</legend>${help ? html`<p class="muted u-mt0">${help}</p>` : ''}${body}</fieldset>`;
  const oauth = (scope: string) => html`<div class="form-grid">
      ${input('tenant_id', tx('ml.tenant_id_microsoft_entra'), s.tenant_id, { placeholder: tx('ml.contoso_onmicrosoft_com_or_its') })}
      ${input('client_id', tx('ml.client_application_id'), s.client_id)}
      ${ws ? '' : input('token_url', tx('ml.token_url'), s.token_url, { placeholder: tx('ml.empty_microsoft_entra_of_the'), help: tx('ml.another_identity_provider_s_token') })}
      ${input('scope', tx('ml.scope'), s.scope, { placeholder: `empty: ${scope}` })}
    </div>`;
  const settings =
    provider === 'smtp'
      ? html`${group(tx('ml.smtp_server'), html`<div class="form-grid">
          ${input('host', tx('ml.host'), s.host, { required: true, placeholder: 'smtp.office365.com' })}
          ${input('port', tx('ml.port'), s.port ?? '', { type: 'number', placeholder: '587', help: tx('ml.empty_587_starttls_or_465') })}
          ${select('security', tx('ml.security'), s.security ?? 'starttls', [['starttls', tx('ml.starttls_required')], ['tls', tx('ml.tls_from_the_start_port')], ['none', tx('ml.none_a_local_relay_only')]])}
          ${select('auth', tx('ml.sign_in'), s.auth ?? 'password', [['password', tx('ml.user_name_and_password')], ['oauth2', tx('ml.oauth2_xoauth2_client_credentials')], ['none', tx('ml.none')]],
            'Microsoft 365 no longer takes passwords for SMTP: choose OAuth2 with an Entra application (SMTP.SendAsApp), or the Microsoft 365 (Graph) provider.')}
          ${input('username', tx('ml.user_name'), s.username, { placeholder: tx('ml.the_mailbox_e_g_noreply') })}
        </div>${check('tls_verify', tx('ml.check_the_server_s_certificate'), s.tls_verify !== false, tx('ml.switch_off_only_for_a'))}`)}
        <details class="prop-group prop-group-more"${s.auth === 'oauth2' ? raw(' open') : ''}><summary>OAuth2 sign-in <span class="muted">${tx('ml.only_with_sign_in_oauth2')}</span></summary>${oauth('https://outlook.office365.com/.default')}</details>`
      : provider === 'graph'
        ? group(tx('ml.microsoft_entra_application'), html`${oauth('https://graph.microsoft.com/.default')}
            ${check('save_to_sent_items', tx('ml.keep_a_copy_in_the'), s.save_to_sent_items === true)}`,
          'An application in Microsoft Entra with a client secret and the application permission Mail.Send, limited to the sending mailboxes.')
        : provider === 'ses'
          ? group(tx('ml.amazon_ses'), html`<div class="form-grid">
              ${input('region', tx('ml.aws_region'), s.region, { required: true, placeholder: tx('ml.eu_west_1') })}
              ${input('access_key_id', tx('ml.access_key_id'), s.access_key_id, { required: true })}</div>`,
            'An IAM user allowed ses:SendEmail; the From addresses must be verified identities in SES.')
          : provider === 'mailgun'
            ? group(tx('ml.mailgun'), html`<div class="form-grid">
                ${input('domain', tx('ml.sending_domain'), s.domain, { required: true, placeholder: 'mg.example.com' })}
                ${select('mailgun_region', tx('ml.region'), s.mailgun_region ?? 'us', [['us', 'US'], ['eu', 'EU']])}</div>`)
            : provider === 'postmark'
              ? group(tx('ml.postmark'), html`<div class="form-grid">${input('message_stream', tx('ml.message_stream'), s.message_stream, { placeholder: 'outbound' })}</div>`)
              : '';
  const secret = provider === 'log' ? '' : group(SECRET_LABEL(provider), html`
      ${input('secret', SECRET_LABEL(provider), '', { type: 'password', auto: 'new-password',
        help: x.has_secret && x.provider === provider ? 'A secret is stored (encrypted). It is never shown; type a new one to replace it.' : tx('ml.stored_encrypted_never_shown_again') })}
      ${x.has_secret ? check('remove_secret', tx('ml.remove_the_stored_secret'), false) : ''}
      ${secretKeyConfigured() ? '' : html`<div class="alert alert-error" role="alert">${tx.code('ml.no_secret_key')}</div>`}`);
  const viaHttp = provider !== 'smtp' && provider !== 'log' && !ws;
  return html`<form method="post" action="${action}" class="mail-service-form">${csrfField}
    <input type="hidden" name="provider" value="${provider}">
    ${group(tx('ml.service'), html`<div class="form-grid">
      ${isNew && !ws ? input('name', tx('ml.name'), '', { required: true, placeholder: tx('ml.e_g_office365'), help: tx('ml.upper_case_letters_digits_and') }) : ''}
      ${input('description', tx('ml.description'), x.description)}
    </div>${check('enabled', tx('ml.enabled'), x.enabled !== false, 'A disabled service sends nothing: mail stays queued until it is enabled, or fails after its retries.')}`)}
    ${group(tx('ml.senders'), html`<div class="form-grid">
      ${input('senders', tx('ml.allowed_senders'), (x.senders ?? []).join(', '), { required: true, placeholder: tx('ml.noreply_example_com_example_com'),
        help: tx('ml.the_from_addresses_this_service') })}
      ${input('default_from', tx('ml.default_from_address'), s.default_from, { placeholder: tx('ml.noreply_example_com'), help: tx('ml.for_applications_that_set_none') })}
    </div>`)}
    ${settings}
    ${secret}
    ${viaHttp ? html`<details class="prop-group prop-group-more"${s.base_url ? raw(' open') : ''}><summary>${tx('ml.advanced')}</summary><div class="form-grid">
      ${input('base_url', tx('ml.api_base_url'), s.base_url, { placeholder: tx('ml.empty_the_provider_s_own'), help: tx('ml.a_gateway_or_proxy_that') })}</div></details>` : ''}
    ${group(tx('ml.check_before_saving'), html`
      ${x.id ? html`<input type="hidden" name="service_id" value="${x.id}">` : ''}
      <div class="buttons mail-check-buttons"><button class="btn" formaction="${checkAction}" formnovalidate name="check" value="connection">${icon('play')} ${tx('ml.test_connection')}</button></div>
      <div class="form-grid">
        ${input('test_to', tx('ml.send_a_test_mail_to'), tried?.to ?? '', { type: 'email', placeholder: tx('ml.you_example_com') })}
        ${input('test_from', tx('ml.from'), tried?.from ?? s.default_from ?? (x.senders ?? []).find((a) => !a.startsWith('@')) ?? '', { type: 'email', help: tx('ml.one_of_the_allowed_senders') })}
      </div>
      <div class="buttons mail-check-buttons"><button class="btn" formaction="${checkAction}" formnovalidate name="check" value="send">${icon('send')} ${tx('ml.send_test_mail')}</button></div>
      <div class="mail-check-result" role="status" aria-live="polite">${tried ? html`<div class="alert ${tried.ok ? 'alert-success' : 'alert-error'}">${tried.text}</div>` : ''}</div>`,
      x.has_secret ? tx('ml.check_help_secret') : tx('ml.check_help'))}
    <div class="buttons">${isNew && !ws ? html`<a class="btn" href="${BASE}/mail/new">${tx('ml.choose_another_provider')}</a>` : ''}<button class="btn btn-hot">${isNew ? tx('ml.add_service') : tx('ml.save')}</button></div>
  </form>`;
}

/** The form's values for the chosen provider, as typed (not checked). */
export function parseForm(b: Record<string, string | undefined>) {
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
export function formValues(b: Record<string, string | undefined>, hasSecret: boolean, opts: { connection?: boolean; workspace?: boolean } = {}) {
  const v = parseForm(b);
  // (sprint 118) a workspace's own service: the providers' own APIs only
  if (opts.workspace) {
    delete v.settings.base_url;
    delete v.settings.token_url;
  }
  if (!opts.connection || v.senders.length) {
    if (!v.senders.length) throw new Error(tx('ml.name_at_least_one_allowed'));
    const bad = v.senders.find((x) => !SENDER.test(x));
    if (bad) throw new Error(`"${bad}" is not an address or @domain.`);
    const from = v.settings.default_from;
    if (from && (!ADDRESS.test(from) || !senderAllowed(v.senders, from))) throw new Error(tx('ml.the_default_from_address_must'));
  }
  const problems = settingsProblems(v.provider, v.settings, hasSecret || !!b.secret);
  if (problems.length) throw new Error(problems.join(' '));
  return v;
}

const STATUS_CLASS: Record<string, string> = { sent: ' tag-ok', queued: '', sending: '', error: ' tag-error', cancelled: '' };

const mailTable = (rows: any[], withApp: boolean, actions?: (m: any) => unknown) => html`<div class="table-wrap"><table class="report report-reflow">
  <thead><tr><th>${tx('ml.queued_utc')}</th>${withApp ? html`<th>${tx('ml.application')}</th>` : ''}<th>${tx('ml.to')}</th><th>${tx('ml.subject')}</th><th>${tx('ml.from')}</th><th class="num">${tx('ml.attempts')}</th><th>${tx('ml.status')}</th>${actions ? html`<th>${tx('ml.actions')}</th>` : ''}</tr></thead>
  <tbody>${rows.length ? rows.map((m) => html`<tr>
    <td data-label="${tx('ml.queued')}">${when(m.created_at)}</td>${withApp ? html`<td data-label="${tx('ml.application')}">${m.app ?? ''}</td>` : ''}
    <td data-label="${tx('ml.to')}" class="u-break">${[...m.to_addresses, ...m.cc_addresses].join(', ')}${m.bcc_addresses.length ? html` <span class="muted">+${m.bcc_addresses.length} bcc</span>` : ''}</td>
    <td data-label="${tx('ml.subject')}" class="u-break">${m.subject}${m.template ? html` <span class="muted">(${m.template})</span>` : ''}</td>
    <td data-label="${tx('ml.from')}" class="u-break">${m.from_address ?? ''}</td>
    <td class="num" data-label="${tx('ml.attempts')}">${m.attempts}</td>
    <td data-label="${tx('ml.status')}"><span class="tag${STATUS_CLASS[m.status] ?? ''}">${m.status}</span>${m.sent_at ? html` <span class="muted">${when(m.sent_at)}</span>` : ''}${m.message ? html`<br><span class="muted u-break">${m.message}</span>` : ''}</td>
    ${actions ? html`<td data-label="${tx('ml.actions')}">${actions(m)}</td>` : ''}</tr>`)
    : html`<tr><td colspan="${7 + (withApp ? 1 : 0) + (actions ? 1 : 0)}" class="empty">${tx('ml.no_mail_yet')}</td></tr>`}</tbody></table></div>`;

async function adminOnly(s: Session, reply: any, title: string) {
  if (await isAdmin(s.username)) return true;
  const main = html`<h1 class="u-mb1">${title}</h1><div class="alert alert-error" role="alert">${tx('ml.only_administrators_configure_mail_services')}</div>`;
  await send(reply.code(403), s, shell(s, title, [[tx('ml.app_builder'), BASE], [tx('ml.workspace_utilities'), `${BASE}/utilities`], [title]], main));
  return false;
}

const MAIL_COLUMNS = 'q.id, q.app_id, q.to_addresses, q.cc_addresses, q.bcc_addresses, q.subject, q.template, q.from_address, q.attempts, q.status, q.message, q.created_at, q.sent_at';

/**
 * Test connection / Send test mail with the settings as filled in (the stored secret when none is typed).
 * (sprint 118) `workspaceId`: a workspace's own service, with the checks of serviceSettings().
 */
export async function runCheck(b: Record<string, string | undefined>, stored: MailService | null, username: string | null, workspaceId: number | null = null): Promise<{ ok: boolean; text: string }> {
  const typed = parseForm(b);
  const to = String(b.test_to ?? '').trim();
  const from = String(b.test_from ?? '').trim();
  try {
    const sameProvider = stored?.provider === typed.provider;
    const v = formValues(b, !!(sameProvider && stored?.secret_enc), { connection: b.check !== 'send', workspace: workspaceId !== null });
    let secret: string | null = b.secret || null;
    if (!secret && sameProvider && stored?.secret_enc) {
      try {
        secret = decryptSecret(stored.secret_enc);
      } catch (e) {
        throw new MailError(tx('ml.secret_unreadable', { error: (e as Error).message }), false);
      }
    }
    const svc = { name: stored?.name ?? 'new', provider: v.provider, settings: v.settings, workspace_id: workspaceId };
    if (b.check === 'send') {
      if (!ADDRESS.test(to)) throw new MailError(tx('ml.test_to_missing'), false);
      if (!ADDRESS.test(from) || !senderAllowed(v.senders, from)) throw new MailError(tx('ml.from_not_allowed'), false);
      const pid = await deliver(v.provider, await serviceSettings(svc), secret, {
        from, to: [to], cc: [], bcc: [], replyTo: null, subject: `pgkiln: test of a mail service (${PROVIDER_LABELS[v.provider]})`,
        text: `This is a test of a pgkiln mail service${stored ? ` (${stored.name})` : ''}, sent from the App Builder by ${username}.`, html: null, attachments: [],
      });
      return { ok: true, text: pid ? tx('ml.test_handed_id', { provider: PROVIDER_LABELS[v.provider], id: pid, to }) : tx('ml.test_handed', { provider: PROVIDER_LABELS[v.provider], to }) };
    }
    return { ok: true, text: await verifyService(svc, secret) };
  } catch (e) {
    return { ok: false, text: e instanceof MailError || !(e instanceof TypeError) ? (e as Error).message : tx('ml.the_check_failed') };
  }
}

export async function mailRoutes(app: FastifyInstance) {
  app.get(`${BASE}/mail`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply, tx('ml.mail_services')))) return;
    const services = (await owner.query(`select s.id, s.name, s.description, s.provider, s.senders, s.enabled, s.secret_enc is not null as has_secret,
        (select string_agg(a.alias, ', ' order by a.alias) from meta.app_mail_service x join meta.app a on a.id = x.app_id where x.service_id = s.id) as apps,
        (select w.name from meta.workspace w where w.id = s.workspace_id) as workspace
      from meta.mail_service s order by s.workspace_id is not null, s.name`)).rows;
    const recent = (await owner.query(`select ${MAIL_COLUMNS}, a.alias as app from meta.mail_queue q left join meta.app a on a.id = q.app_id order by q.id desc limit 100`)).rows;
    const main = html`
      <div class="title-row"><h1>${tx('ml.mail_services')}</h1></div>
      <p class="muted u-mt0">${tx.code('ml.intro', { process: tx('ml.send_e_mail') })}</p>
      ${region(tx('ml.services'), html`<div class="table-wrap"><table class="report report-reflow">
          <thead><tr><th>${tx('ml.service')}</th><th>${tx('ml.provider')}</th><th>${tx('ml.senders')}</th><th>${tx('ml.secret')}</th><th>${tx('ml.applications')}</th><th>${tx('ml.status')}</th></tr></thead>
          <tbody>${services.length ? services.map((x) => html`<tr>
            <td data-label="${tx('ml.service')}"><a href="${BASE}/mail/${x.id}">${x.name}</a>${x.description ? html` <span class="muted">${x.description}</span>` : ''}</td>
            <td data-label="${tx('ml.provider')}">${PROVIDER_LABELS[x.provider as Provider]}</td>
            <td data-label="${tx('ml.senders')}" class="u-break">${x.senders.join(', ')}</td>
            <td data-label="${tx('ml.secret')}">${x.has_secret ? 'stored (encrypted)' : x.provider === 'log' ? '–' : html`<b>missing</b>`}</td>
            <td data-label="${tx('ml.applications')}">${x.workspace ? html`<span class="tag">workspace ${x.workspace}</span> ` : ''}${x.apps ?? (x.workspace ? html`<span class="muted">${tx('ml.its_applications_without_a_service')}</span>` : html`<span class="muted">none</span>`)}</td>
            <td data-label="${tx('ml.status')}">${x.enabled ? 'enabled' : html`<b>disabled</b>`}</td></tr>`)
            : html`<tr><td colspan="6" class="empty">${tx('ml.no_mail_services_yet')}</td></tr>`}</tbody></table></div>`,
        html`<a class="btn btn-sm btn-hot" href="${BASE}/mail/new">${icon('plus')} ${tx('ml.add_service')}</a>`)}
      ${await builderMailRegion(s, services)}
      ${region(tx('ml.recent_mail'), mailTable(recent, true))}`;
    return send(reply, s, shell(s, tx('ml.mail_services'), [[tx('ml.app_builder'), BASE], [tx('ml.workspace_utilities'), `${BASE}/utilities`], [tx('ml.mail_services')]], main));
  });

  // (096) the builder's own mail ("Find my workspace"): a service and a From address it may send as
  app.post(`${BASE}/mail/builder`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply, tx('ml.mail_services')))) return;
    const name = String(req.body?.service ?? '');
    const from = String(req.body?.from ?? '').trim();
    try {
      if (!name) await owner.query(`delete from meta.setting where name in ('builder_mail_service', 'builder_mail_from')`);
      else {
        const svc = await owner.one<{ senders: string[] }>('select senders from meta.mail_service where name = $1', [name]);
        if (!svc) throw new Error(tx('ml.choose_one_of_the_mail'));
        if (!/^[^@\s<>"]+@[^@\s<>"]+$/.test(from)) throw new Error(tx('ml.the_from_address_is_an'));
        if (!senderAllowed(svc.senders, from)) throw new Error(tx('ml.may_not_send_as', { name, from }));
        await owner.tx(async (c) => {
          for (const [k, v] of [['builder_mail_service', name], ['builder_mail_from', from]])
            await c.query('insert into meta.setting (name, value) values ($1, $2) on conflict (name) do update set value = excluded.value', [k, v]);
        });
      }
      await logActivity({ appId: null, username: s.username, event: 'mail_service', ip: clientIp(req), detail: name ? `builder mail: ${name} as ${from}` : 'builder mail: none' });
      flash(s, name ? tx('ml.builder_mail_saved_find_my') : tx('ml.the_builder_sends_no_mail'));
    } catch (e) {
      flash(s, (e as Error).message, 'error');
    }
    return back(reply, s, `${BASE}/mail#builder-mail`);
  });

  // a new service: choose the provider, then its settings only
  app.get(`${BASE}/mail/new`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply, tx('ml.mail_services')))) return;
    const provider = (PROVIDERS as readonly string[]).includes(String(req.query.provider)) ? (req.query.provider as Provider) : null;
    const main = html`<div class="title-row"><h1>${tx('ml.add_a_mail_service')}</h1></div>
      ${provider
        ? html`<p class="muted u-mt0">Step 2 of 2: <b>${PROVIDER_LABELS[provider]}</b>. ${PROVIDER_TEXT(provider)[1]}</p>
            <div class="mail-form-page">${region(tx('ml.settings'), serviceForm({}, provider, `${BASE}/mail`, csrf(s), true))}</div>`
        : html`<p class="muted u-mt0">${tx('ml.step_1_of_2_how')}</p>${providerChoice()}`}`;
    return send(reply, s, shell(s, tx('ml.add_a_mail_service'), [[tx('ml.app_builder'), BASE], [tx('ml.workspace_utilities'), `${BASE}/utilities`], [tx('ml.mail_services'), `${BASE}/mail`], [tx('ml.add')]], main));
  });

  app.post(`${BASE}/mail`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply, tx('ml.mail_services')))) return;
    const b = req.body ?? {};
    try {
      const name = (b.name ?? '').trim().toUpperCase();
      if (!/^[A-Z][A-Z0-9_]{0,59}$/.test(name)) throw new Error(tx('ml.the_name_is_upper_case'));
      const v = formValues(b, false);
      const secret = b.secret ? encryptSecret(b.secret) : null;
      const r = await owner.one(
        `insert into meta.mail_service (name, description, provider, settings, senders, enabled, secret_enc) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [name, v.description, v.provider, JSON.stringify(v.settings), v.senders, v.enabled, secret]);
      flash(s, tx('ml.mail_service_added_choose_the'));
      return back(reply, s, `${BASE}/mail/${r.id}`);
    } catch (e) {
      flash(s, (e as Error).message.includes('mail_service_name_key') ? 'A service with this name exists already.' : (e as Error).message, 'error');
      return back(reply, s, `${BASE}/mail/new?provider=${encodeURIComponent(String(b.provider ?? ''))}`);
    }
  });

  app.get(`${BASE}/mail/:id(^\\d+$)`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply, tx('ml.mail_services')))) return;
    const x = await owner.one<MailService & { has_secret: boolean }>(
      'select id, name, description, provider, settings, senders, enabled, workspace_id, secret_enc is not null as has_secret from meta.mail_service where id = $1', [req.params.id]);
    if (!x) return reply.code(404).send('Not found');
    const provider = (PROVIDERS as readonly string[]).includes(String(req.query.provider)) ? (req.query.provider as Provider) : x.provider;
    // (sprint 118) a workspace's own service serves that workspace's applications only
    const apps = (await owner.query(`select a.id, a.alias, a.name, x.service_id, x.from_address, x.max_per_day, o.name as other
      from meta.app a left join meta.app_mail_service x on x.app_id = a.id left join meta.mail_service o on o.id = x.service_id and o.id <> $1
      where $2::int is null or meta.app_workspace(a.id) = $2
      order by a.alias`, [x.id, x.workspace_id ?? null])).rows;
    const recent = (await owner.query(`select ${MAIL_COLUMNS}, a.alias as app from meta.mail_queue q left join meta.app a on a.id = q.app_id
       where q.service = $1 or q.app_id in (select app_id from meta.app_mail_service where service_id = $2) order by q.id desc limit 50`, [x.name, x.id])).rows;
    const main = html`
      <div class="title-row"><h1 class="mail-name">${x.name}</h1></div>
      <div class="mail-form-page">
        ${region(tx('ml.settings'), html`
          <form method="get" class="provider-switch">${select('provider', tx('ml.provider'), provider, PROVIDERS.map((p): [string, string] => [p, PROVIDER_LABELS[p]]),
            provider !== x.provider ? tx('ml.not_saved_yet_fill_in') : undefined)}<button class="btn btn-sm">${tx('ml.change')}</button></form>
          ${serviceForm(x, provider, `${BASE}/mail/${x.id}`, csrf(s), false)}
          <form method="post" action="${BASE}/mail/${x.id}/delete" class="danger-zone">${csrf(s)}
            <button class="btn btn-danger" data-confirm="${tx('ml.delete_confirm', { name: x.name })}">${tx('ml.delete_service')}</button></form>`)}
      </div>
      ${region(tx('ml.applications'), html`<p class="muted u-mt0">${tx('ml.the_applications_that_send_through')}</p>
        <form method="post" action="${BASE}/mail/${x.id}/apps">${csrf(s)}
        <div class="table-wrap"><table class="report report-reflow"><thead><tr><th>${tx('ml.application')}</th><th>${tx('ml.sends_through_this_service')}</th><th>${tx('ml.from_address')}</th><th>${tx('ml.mails_per_day')}</th></tr></thead>
        <tbody>${apps.length ? apps.map((a) => html`<tr>
          <td data-label="${tx('ml.application')}">${a.name} <span class="muted">${a.alias}</span></td>
          <td data-label="${tx('ml.sends_through_this_service')}"><label class="check"><input type="checkbox" name="allow" value="${a.id}"${a.service_id === x.id ? raw(' checked') : ''}> yes</label>${a.other ? html` <span class="muted">now: ${a.other}</span>` : ''}</td>
          <td data-label="${tx('ml.from_address')}"><input type="email" name="from_${a.id}" value="${a.service_id === x.id ? a.from_address ?? '' : ''}" aria-label="${tx('ml.aria_from', { app: a.alias })}"></td>
          <td data-label="${tx('ml.mails_per_day')}"><input type="number" min="0" name="max_${a.id}" value="${a.service_id === x.id ? a.max_per_day ?? '' : ''}" aria-label="${tx('ml.aria_max', { app: a.alias })}"></td></tr>`)
          : html`<tr><td colspan="4" class="empty">${tx('ml.no_applications')}</td></tr>`}</tbody></table></div>
        <div class="buttons"><button class="btn btn-hot">${tx('ml.save')}</button></div></form>`)}
      ${region(tx('ml.recent_mail'), mailTable(recent, true))}`;
    return send(reply, s, shell(s, x.name, [[tx('ml.app_builder'), BASE], [tx('ml.workspace_utilities'), `${BASE}/utilities`], [tx('ml.mail_services'), `${BASE}/mail`], [x.name]], main));
  });

  app.post(`${BASE}/mail/:id(^\\d+$)`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply, tx('ml.mail_services')))) return;
    const b = req.body ?? {};
    try {
      const old = await owner.one<{ has_secret: boolean }>('select secret_enc is not null as has_secret from meta.mail_service where id = $1', [req.params.id]);
      if (!old) throw new Error(tx('ml.not_found'));
      const v = formValues(b, old.has_secret && b.remove_secret !== 'true');
      const secret = b.secret ? encryptSecret(b.secret) : null;
      await owner.query(
        `update meta.mail_service set description = $2, provider = $3, settings = $4, senders = $5, enabled = $6, updated_at = now(),
                secret_enc = case when $8 then null when $7::text is null then secret_enc else $7 end
          where id = $1`,
        [req.params.id, v.description, v.provider, JSON.stringify(v.settings), v.senders, v.enabled, secret, b.remove_secret === 'true' && !b.secret]);
      flash(s, tx('ml.mail_service_saved'));
    } catch (e) {
      flash(s, (e as Error).message, 'error');
    }
    return back(reply, s, `${BASE}/mail/${req.params.id}`);
  });

  app.post(`${BASE}/mail/:id(^\\d+$)/apps`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply, tx('ml.mail_services')))) return;
    const b = req.body as Record<string, string | string[] | undefined>;
    const allow = new Set([b.allow ?? []].flat().map(Number).filter(Number.isInteger));
    try {
      const service = await owner.one<{ senders: string[]; workspace_id: number | null }>('select senders, workspace_id from meta.mail_service where id = $1', [req.params.id]);
      if (!service) throw new Error(tx('ml.not_found'));
      await owner.tx(async (c) => {
        // (sprint 118) a workspace's own service: that workspace's applications only
        const apps = (await c.query<{ id: number }>('select id from meta.app where $1::int is null or meta.app_workspace(id) = $1', [service.workspace_id])).rows.map((a) => a.id);
        await c.query('delete from meta.app_mail_service where service_id = $1 and not (app_id = any($2::int[]))', [req.params.id, [...allow]]);
        for (const id of apps.filter((a) => allow.has(a))) {
          const from = String(b[`from_${id}`] ?? '').trim() || null;
          if (from && (!ADDRESS.test(from) || !senderAllowed(service.senders, from))) throw new Error(`${from} is not an address this service may send as.`);
          const max = String(b[`max_${id}`] ?? '').trim();
          if (max && !(Number.isInteger(Number(max)) && Number(max) >= 0)) throw new Error(tx('ml.mails_per_day_a_whole'));
          await c.query(
            `insert into meta.app_mail_service (app_id, service_id, from_address, max_per_day) values ($1, $2, $3, $4)
             on conflict (app_id) do update set service_id = excluded.service_id, from_address = excluded.from_address, max_per_day = excluded.max_per_day`,
            [id, req.params.id, from, max ? Number(max) : null]);
        }
      });
      flash(s, tx('ml.applications_saved'));
    } catch (e) {
      flash(s, (e as Error).message, 'error');
    }
    return back(reply, s, `${BASE}/mail/${req.params.id}`);
  });

  // Test connection / Send test mail: the settings as filled in, not saved (the stored secret when none is typed).
  // JSON for builder.js; without JavaScript the form comes back with its values (the secret must be typed again).
  app.post(`${BASE}/mail/check`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply, tx('ml.mail_services')))) return;
    const b = (req.body ?? {}) as Record<string, string | undefined>;
    const id = /^\d{1,9}$/.test(b.service_id ?? '') ? Number(b.service_id) : null;
    const stored = id ? await owner.one<MailService>('select * from meta.mail_service where id = $1', [id]) : null;
    if (id && !stored) return reply.code(404).send('Not found');
    const typed = parseForm(b);
    const to = String(b.test_to ?? '').trim();
    const from = String(b.test_from ?? '').trim();
    const result = await runCheck(b, stored ?? null, s.username, stored?.workspace_id ?? null);
    await logActivity({ username: s.username, event: 'mail_check', ip: clientIp(req), detail: `${b.check === 'send' ? 'send' : 'connection'} ${typed.provider}${stored ? ` ${stored.name}` : ''}: ${result.ok ? 'ok' : 'failed'}` });
    if (String(req.headers.accept ?? '').includes('application/json')) return reply.header('cache-control', 'no-store').send(result);
    const x = { id: stored?.id, name: stored?.name, description: typed.description, provider: typed.provider, settings: typed.settings, senders: typed.senders, enabled: typed.enabled,
      has_secret: !!(stored?.secret_enc && stored.provider === typed.provider) };
    const main = html`<div class="title-row"><h1>${stored ? stored.name : tx('ml.add_a_mail_service')}</h1></div>
      <div class="mail-form-page">${region(tx('ml.settings'), serviceForm(x, typed.provider, stored ? `${BASE}/mail/${stored.id}` : `${BASE}/mail`, csrf(s), !stored, { ...result, to, from }))}</div>`;
    return send(reply, s, shell(s, tx('ml.mail_service'), [[tx('ml.app_builder'), BASE], [tx('ml.workspace_utilities'), `${BASE}/utilities`], [tx('ml.mail_services'), `${BASE}/mail`], [stored?.name ?? tx('ml.add')]], main));
  });

  app.post(`${BASE}/mail/:id(^\\d+$)/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOnly(s, reply, tx('ml.mail_services')))) return;
    await owner.query('delete from meta.mail_service where id = $1', [req.params.id]);
    flash(s, tx('ml.mail_service_deleted'));
    return back(reply, s, `${BASE}/mail`);
  });

  // ---------------------------------------------------------------- per application (developers)
  app.get(`${BASE}/apps/:id(^\\d+$)/mail`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await owner.one<{ id: number; alias: string; name: string }>('select id, alias, name from meta.app where id = $1', [req.params.id]);
    if (!a) return reply.code(404).send('Not found');
    // the application's service, else (sprint 118) its workspace's own
    const service = await owner.one(`select s.name, s.provider, s.enabled, x.from_address, x.max_per_day, s.settings->>'default_from' as default_from
      from meta.mail_service s left join meta.app_mail_service x on x.app_id = $1 and x.service_id = s.id where s.id = meta.mail_service_for_app($1)`, [a.id]);
    const today = (await owner.one(`select count(*)::int as n from meta.mail_queue where app_id = $1 and created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' and status <> 'cancelled'`, [a.id])).n;
    const status = String(req.query.status ?? '');
    const rows = (await owner.query(`select ${MAIL_COLUMNS} from meta.mail_queue q where q.app_id = $1 and ($2 = '' or q.status = $2) order by q.id desc limit 200`, [a.id, status])).rows;
    const admin = await isAdmin(s.username);
    const action = (m: any) => m.status === 'error' || m.status === 'cancelled'
      ? html`<form method="post" action="${BASE}/apps/${a.id}/mail/${m.id}/retry">${csrf(s)}<button class="btn btn-sm">${tx('ml.send_again')}</button></form>`
      : m.status === 'queued' ? html`<form method="post" action="${BASE}/apps/${a.id}/mail/${m.id}/cancel">${csrf(s)}<button class="btn btn-sm">${tx('ml.cancel')}</button></form>` : '';
    const main = html`
      <div class="title-row"><h1 class="mail-name">Mail · ${a.name}</h1></div>
      <p class="muted u-mt0">${tx.code('ml.queue_intro')} ${service
        ? tx.rich(service.max_per_day !== null ? 'ml.sends_through_max' : 'ml.sends_through', { service: html`<b>${service.name}</b>`, provider: `${PROVIDER_LABELS[service.provider as Provider]}${service.enabled ? '' : `, ${tx('ml.disabled_l')}`}`, from: service.from_address ?? service.default_from ?? html`<i>${tx('ml.no_from_address')}</i>`, today, max: service.max_per_day ?? '' })
        : admin ? tx.rich('ml.no_service_admin', { none: html`<b>${tx('ml.it_may_not_send_mail')}</b>`, link: html`<a href="${BASE}/mail">${tx('ml.mail_services')}</a>` }) : tx.rich('ml.no_service', { none: html`<b>${tx('ml.it_may_not_send_mail')}</b>` })}</p>
      <form method="get" class="u-mb1">${select('status', tx('ml.status'), status, [['', tx('ml.all')], ['queued', tx('ml.queued')], ['sending', tx('ml.sending')], ['sent', tx('ml.sent')], ['error', tx('ml.error')], ['cancelled', tx('ml.cancelled')]])}<button class="btn btn-sm">${tx('ml.show')}</button></form>
      ${region(tx('ml.mail'), mailTable(rows, false, action))}`;
    return send(reply, s, shell(s, tx('ml.mail_of', { app: a.name }), [[tx('ml.app_builder'), BASE], [a.name, `${BASE}/apps/${a.id}`], [tx('ml.activity'), `${BASE}/apps/${a.id}/activity`], [tx('ml.mail')]], main));
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
    flash(s, r.rowCount ? (to === 'queued' ? tx('ml.the_mail_is_queued_again') : tx('ml.the_mail_is_cancelled')) : tx('ml.the_mail_has_changed_meanwhile'), r.rowCount ? 'ok' : 'error');
    return back(reply, s, `${BASE}/apps/${req.params.id}/mail`);
  };
  app.post(`${BASE}/apps/:id(^\\d+$)/mail/:mid(^\\d+$)/retry`, change('queued', ['error', 'cancelled']));
  app.post(`${BASE}/apps/:id(^\\d+$)/mail/:mid(^\\d+$)/cancel`, change('cancelled', ['queued']));
}

/** (096) Mail services → Builder mail: the service and From address of the builder's own mail. */
async function builderMailRegion(s: Session, services: { name: string; enabled: boolean }[]) {
  const set = Object.fromEntries((await owner.query<{ name: string; value: string }>(`select name, value from meta.setting where name in ('builder_mail_service', 'builder_mail_from')`)).rows.map((r) => [r.name, r.value]));
  return region(tx('ml.builder_mail'), html`<form method="post" action="${BASE}/mail/builder">${csrf(s)}
    <p class="muted u-mt0">${tx.rich('ml.builder_intro', { find: html`<b>${tx('ml.find_my_workspace')}</b>` })}</p>
    <div class="form-grid">
      ${select('service', tx('ml.service'), set.builder_mail_service ?? '', [['', tx('ml.none')], ...services.map((x) => [x.name, `${x.name}${x.enabled ? '' : ' (disabled)'}`] as [string, string])])}
      ${input('from', tx('ml.from_address'), set.builder_mail_from ?? '', { type: 'email', placeholder: tx('ml.pgkiln_example_com'), help: tx('ml.one_of_the_service_s') })}
    </div>
    <div class="buttons"><button class="btn">${tx('ml.save')}</button></div></form>`, '', 'builder-mail');
}
