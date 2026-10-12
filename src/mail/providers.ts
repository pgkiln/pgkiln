// Mail providers (migration 081): one way to hand a message over per
// provider, behind one interface.
//
//  - smtp:     any SMTP server (nodemailer), with a user name and password
//              or OAuth2 (SASL XOAUTH2; a client-credentials token, e.g. from
//              Microsoft Entra for Exchange Online, or Google Workspace);
//  - graph:    Microsoft Graph sendMail, with an Entra application's client
//              credentials (application permission Mail.Send);
//  - ses:      Amazon SES (API v2, the raw MIME message), signed with
//              Signature Version 4;
//  - resend, postmark, sendgrid, mailgun: their HTTP APIs with an API key;
//  - log:      sends nothing: the server's log shows the message (development).
//
// Secrets (password, client secret, API key, AWS secret key) come decrypted
// from service.ts and never appear in errors. A MailError says whether trying
// again later may help (network problems, 429, 5xx) or not (rejected).
import { createHash } from 'node:crypto';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { signV4 } from '../objectstore.ts';

export const PROVIDERS = ['smtp', 'graph', 'ses', 'resend', 'postmark', 'sendgrid', 'mailgun', 'log'] as const;
export type Provider = (typeof PROVIDERS)[number];

export const PROVIDER_LABELS: Record<Provider, string> = {
  smtp: 'SMTP (password or OAuth2)',
  graph: 'Microsoft 365 (Graph API)',
  ses: 'Amazon SES',
  resend: 'Resend',
  postmark: 'Postmark',
  sendgrid: 'SendGrid',
  mailgun: 'Mailgun',
  log: 'Log only (development: nothing is sent)',
};

export interface Attachment {
  filename: string;
  mime: string;
  content: Buffer;
}

export interface OutgoingMail {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string | null;
  subject: string;
  text: string | null;
  html: string | null;
  attachments: Attachment[];
}

export interface ServiceSettings {
  // smtp
  host?: string;
  port?: number;
  security?: 'tls' | 'starttls' | 'none';
  auth?: 'none' | 'password' | 'oauth2';
  username?: string;
  tls_verify?: boolean;
  // OAuth2 client credentials (smtp with auth oauth2, graph)
  tenant_id?: string;
  client_id?: string;
  token_url?: string;
  scope?: string;
  // graph
  save_to_sent_items?: boolean;
  // ses
  region?: string;
  access_key_id?: string;
  // mailgun
  domain?: string;
  mailgun_region?: 'us' | 'eu';
  // postmark
  message_stream?: string;
  // the API's address instead of the provider's own (administrators only; a proxy, or tests)
  base_url?: string;
  default_from?: string;
}

export class MailError extends Error {
  constructor(message: string, readonly retry: boolean) {
    super(message);
  }
}

const TIMEOUT_MS = 30_000;
const base = (s: ServiceSettings, own: string) => (s.base_url || own).replace(/\/+$/, '');

/** The problems of a service's settings for its provider (the builder shows them). */
export function settingsProblems(provider: Provider, s: ServiceSettings, hasSecret: boolean): string[] {
  const out: string[] = [];
  const need = (v: unknown, what: string) => (typeof v === 'string' && v.trim() ? null : out.push(`${what} is required.`));
  if (s.base_url && !/^https?:\/\/[^\s]+$/i.test(s.base_url)) out.push('The base URL starts with http:// or https://.');
  switch (provider) {
    case 'smtp':
      need(s.host, 'The SMTP host');
      if (s.port !== undefined && !(Number.isInteger(s.port) && s.port > 0 && s.port < 65536)) out.push('The port is 1 to 65535.');
      if ((s.auth ?? 'password') !== 'none') need(s.username, 'The user name');
      if (s.auth === 'oauth2') {
        need(s.client_id, 'The client (application) ID');
        if (!s.token_url && !s.tenant_id) out.push('The tenant ID (Microsoft Entra) or a token URL is required.');
      }
      if ((s.auth ?? 'password') !== 'none' && !hasSecret) out.push(s.auth === 'oauth2' ? 'The client secret is required.' : 'The password is required.');
      break;
    case 'graph':
      need(s.tenant_id, 'The tenant ID');
      need(s.client_id, 'The client (application) ID');
      if (!hasSecret) out.push('The client secret is required.');
      break;
    case 'ses':
      need(s.region, 'The AWS region');
      need(s.access_key_id, 'The access key ID');
      if (s.region && !/^[a-z]{2}(-[a-z]+)+-\d$/.test(s.region)) out.push('The region is like eu-west-1.');
      if (!hasSecret) out.push('The secret access key is required.');
      break;
    case 'mailgun':
      need(s.domain, 'The sending domain');
      if (!hasSecret) out.push('The API key is required.');
      break;
    case 'resend':
    case 'postmark':
    case 'sendgrid':
      if (!hasSecret) out.push(provider === 'postmark' ? 'The server token is required.' : 'The API key is required.');
      break;
  }
  return out;
}

// ---------------------------------------------------------------- HTTP

async function http(url: string, init: { method?: string; headers: Record<string, string>; body?: string | FormData }) {
  let res: Response;
  try {
    res = await fetch(url, { method: init.method ?? 'POST', headers: init.headers, body: init.body, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new MailError(`The mail service did not answer (${(e as Error).name === 'TimeoutError' ? 'timed out' : (e as Error).message}).`, true);
  }
  const text = (await res.text().catch(() => '')).slice(0, 2000);
  if (!res.ok) {
    let detail = text;
    try {
      const j = JSON.parse(text);
      detail = j.message ?? j.Message ?? j.error?.message ?? j.errors?.[0]?.message ?? j.error_description ?? j.error ?? text;
    } catch {
      // not JSON
    }
    throw new MailError(`The mail service refused the message (HTTP ${res.status}): ${String(detail).slice(0, 500)}`, res.status === 408 || res.status === 429 || res.status >= 500);
  }
  return { res, text };
}

const json = (text: string) => {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
};

// ---------------------------------------------------------------- OAuth2 client credentials

const tokens = new Map<string, { token: string; until: number }>();

/** An access token by the client credentials grant, cached until shortly before it expires. */
export async function clientCredentialsToken(tokenUrl: string, clientId: string, secret: string, scope: string): Promise<string> {
  const key = createHash('sha256').update(JSON.stringify([tokenUrl, clientId, secret, scope])).digest('hex');
  const hit = tokens.get(key);
  if (hit && hit.until > Date.now()) return hit.token;
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: secret, scope }).toString();
  let r;
  try {
    r = await http(tokenUrl, { headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
  } catch (e) {
    throw new MailError(`No access token: ${(e as Error).message}`, (e as MailError).retry ?? true);
  }
  const j = json(r.text);
  if (typeof j.access_token !== 'string') throw new MailError('No access token: the token endpoint answered without one.', false);
  tokens.set(key, { token: j.access_token, until: Date.now() + Math.max(60, Number(j.expires_in) || 3600) * 1000 - 60_000 });
  return j.access_token;
}

/** Forget cached tokens (tests; a changed secret gets a new key anyway). */
export const clearTokens = () => tokens.clear();

const entraTokenUrl = (s: ServiceSettings) => s.token_url || `https://login.microsoftonline.com/${encodeURIComponent(s.tenant_id ?? '')}/oauth2/v2.0/token`;

// ---------------------------------------------------------------- providers

const b64 = (b: Buffer) => b.toString('base64');

async function smtp(m: OutgoingMail, s: ServiceSettings, secret: string | null) {
  const security = s.security ?? 'starttls';
  const auth = s.auth ?? 'password';
  let authOpt: Record<string, unknown> | undefined;
  if (auth === 'password') authOpt = { user: s.username, pass: secret ?? '' };
  else if (auth === 'oauth2')
    authOpt = {
      type: 'OAuth2',
      user: s.username,
      accessToken: await clientCredentialsToken(entraTokenUrl(s), s.client_id ?? '', secret ?? '', s.scope || 'https://outlook.office365.com/.default'),
    };
  const transport = nodemailer.createTransport({
    host: s.host,
    port: s.port ?? (security === 'tls' ? 465 : 587),
    secure: security === 'tls',
    requireTLS: security === 'starttls',
    ignoreTLS: security === 'none',
    auth: authOpt as never,
    tls: { rejectUnauthorized: s.tls_verify !== false },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: TIMEOUT_MS,
    disableFileAccess: true,
    disableUrlAccess: true,
  } as never);
  try {
    const info = await transport.sendMail({
      from: m.from, to: m.to, cc: m.cc, bcc: m.bcc, replyTo: m.replyTo ?? undefined, subject: m.subject,
      text: m.text ?? undefined, html: m.html ?? undefined,
      attachments: m.attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.mime })),
      disableFileAccess: true, disableUrlAccess: true,
    });
    return info.messageId as string;
  } catch (e) {
    const err = e as { responseCode?: number; code?: string; response?: string; message: string };
    // 4xx: try again later; 5xx and authentication: rejected
    const retry = err.responseCode ? err.responseCode < 500 : !['EAUTH', 'EENVELOPE', 'EMESSAGE'].includes(err.code ?? '');
    throw new MailError(`The SMTP server refused the message: ${(err.response ?? err.message).slice(0, 500)}`, retry);
  } finally {
    transport.close();
  }
}

async function graph(m: OutgoingMail, s: ServiceSettings, secret: string | null) {
  const token = await clientCredentialsToken(entraTokenUrl(s), s.client_id ?? '', secret ?? '', s.scope || 'https://graph.microsoft.com/.default');
  const who = (list: string[]) => list.map((address) => ({ emailAddress: { address } }));
  const message = {
    subject: m.subject,
    body: m.html !== null ? { contentType: 'HTML', content: m.html } : { contentType: 'Text', content: m.text ?? '' },
    toRecipients: who(m.to),
    ccRecipients: who(m.cc),
    bccRecipients: who(m.bcc),
    ...(m.replyTo ? { replyTo: who([m.replyTo]) } : {}),
    attachments: m.attachments.map((a) => ({ '@odata.type': '#microsoft.graph.fileAttachment', name: a.filename, contentType: a.mime, contentBytes: b64(a.content) })),
  };
  await http(`${base(s, 'https://graph.microsoft.com')}/v1.0/users/${encodeURIComponent(m.from)}/sendMail`, {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ message, saveToSentItems: s.save_to_sent_items === true }),
  });
  // Graph answers 202 without an id
  return null;
}

/** The message as MIME (SES raw messages). Bcc stays out of the headers; the envelope carries it. */
export async function mime(m: OutgoingMail): Promise<Buffer> {
  const composer = new MailComposer({
    from: m.from, to: m.to, cc: m.cc, replyTo: m.replyTo ?? undefined, subject: m.subject,
    text: m.text ?? undefined, html: m.html ?? undefined,
    attachments: m.attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.mime })),
    disableFileAccess: true, disableUrlAccess: true,
  } as never);
  return new Promise((resolve, reject) => composer.compile().build((err: Error | null, out: Buffer) => (err ? reject(err) : resolve(out))));
}

async function ses(m: OutgoingMail, s: ServiceSettings, secret: string | null) {
  const region = s.region ?? '';
  const url = new URL(`${base(s, `https://email.${region}.amazonaws.com`)}/v2/email/outbound-emails`);
  const body = JSON.stringify({
    FromEmailAddress: m.from,
    Destination: { ToAddresses: m.to, CcAddresses: m.cc, BccAddresses: m.bcc },
    ...(m.replyTo ? { ReplyToAddresses: [m.replyTo] } : {}),
    Content: { Raw: { Data: b64(await mime(m)) } },
  });
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const headers: Record<string, string> = { host: url.host, 'x-amz-date': amzDate, 'content-type': 'application/json' };
  headers.authorization = signV4({
    method: 'POST', url, headers, payloadHash: createHash('sha256').update(body).digest('hex'),
    accessKey: s.access_key_id ?? '', secretKey: secret ?? '', region, service: 'ses', amzDate,
  });
  delete headers.host;
  const r = await http(url.toString(), { headers, body });
  return (json(r.text).MessageId as string | undefined) ?? null;
}

async function resend(m: OutgoingMail, s: ServiceSettings, secret: string | null) {
  const r = await http(`${base(s, 'https://api.resend.com')}/emails`, {
    headers: { authorization: `Bearer ${secret ?? ''}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: m.from, to: m.to, cc: m.cc.length ? m.cc : undefined, bcc: m.bcc.length ? m.bcc : undefined,
      reply_to: m.replyTo ?? undefined, subject: m.subject, html: m.html ?? undefined, text: m.text ?? undefined,
      attachments: m.attachments.length ? m.attachments.map((a) => ({ filename: a.filename, content: b64(a.content), content_type: a.mime })) : undefined,
    }),
  });
  return (json(r.text).id as string | undefined) ?? null;
}

async function postmark(m: OutgoingMail, s: ServiceSettings, secret: string | null) {
  const r = await http(`${base(s, 'https://api.postmarkapp.com')}/email`, {
    headers: { 'x-postmark-server-token': secret ?? '', 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      From: m.from, To: m.to.join(','), Cc: m.cc.join(',') || undefined, Bcc: m.bcc.join(',') || undefined, ReplyTo: m.replyTo ?? undefined,
      Subject: m.subject, HtmlBody: m.html ?? undefined, TextBody: m.text ?? undefined, MessageStream: s.message_stream || 'outbound',
      Attachments: m.attachments.map((a) => ({ Name: a.filename, Content: b64(a.content), ContentType: a.mime })),
    }),
  });
  return (json(r.text).MessageID as string | undefined) ?? null;
}

async function sendgrid(m: OutgoingMail, s: ServiceSettings, secret: string | null) {
  const who = (list: string[]) => (list.length ? list.map((email) => ({ email })) : undefined);
  const content = [
    ...(m.text !== null ? [{ type: 'text/plain', value: m.text }] : []),
    ...(m.html !== null ? [{ type: 'text/html', value: m.html }] : []),
  ];
  const r = await http(`${base(s, 'https://api.sendgrid.com')}/v3/mail/send`, {
    headers: { authorization: `Bearer ${secret ?? ''}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: who(m.to), cc: who(m.cc), bcc: who(m.bcc) }],
      from: { email: m.from }, reply_to: m.replyTo ? { email: m.replyTo } : undefined, subject: m.subject, content,
      attachments: m.attachments.length ? m.attachments.map((a) => ({ content: b64(a.content), filename: a.filename, type: a.mime, disposition: 'attachment' })) : undefined,
    }),
  });
  return r.res.headers.get('x-message-id');
}

async function mailgun(m: OutgoingMail, s: ServiceSettings, secret: string | null) {
  const form = new FormData();
  form.append('from', m.from);
  for (const a of m.to) form.append('to', a);
  for (const a of m.cc) form.append('cc', a);
  for (const a of m.bcc) form.append('bcc', a);
  form.append('subject', m.subject);
  if (m.text !== null) form.append('text', m.text);
  if (m.html !== null) form.append('html', m.html);
  if (m.replyTo) form.append('h:Reply-To', m.replyTo);
  for (const a of m.attachments) form.append('attachment', new Blob([new Uint8Array(a.content)], { type: a.mime }), a.filename);
  const own = s.mailgun_region === 'eu' ? 'https://api.eu.mailgun.net' : 'https://api.mailgun.net';
  const r = await http(`${base(s, own)}/v3/${encodeURIComponent(s.domain ?? '')}/messages`, {
    headers: { authorization: `Basic ${Buffer.from(`api:${secret ?? ''}`).toString('base64')}` },
    body: form,
  });
  return (json(r.text).id as string | undefined) ?? null;
}

/** Hand the message to the provider; returns the provider's id of it (when it gives one). */
export async function deliver(provider: Provider, settings: ServiceSettings, secret: string | null, m: OutgoingMail): Promise<string | null> {
  switch (provider) {
    case 'smtp': return smtp(m, settings, secret);
    case 'graph': return graph(m, settings, secret);
    case 'ses': return ses(m, settings, secret);
    case 'resend': return resend(m, settings, secret);
    case 'postmark': return postmark(m, settings, secret);
    case 'sendgrid': return sendgrid(m, settings, secret);
    case 'mailgun': return mailgun(m, settings, secret);
    case 'log':
      console.log(`mail (log only): from ${m.from} to ${[...m.to, ...m.cc, ...m.bcc].join(', ')}: ${m.subject} (${m.attachments.length} attachment(s))`);
      return null;
  }
}

// ---------------------------------------------------------------- connection checks

/** A signed GET to the SES API (the account, to check a key without sending). */
async function sesGet(s: ServiceSettings, secret: string | null, path: string) {
  const region = s.region ?? '';
  const url = new URL(`${base(s, `https://email.${region}.amazonaws.com`)}${path}`);
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const headers: Record<string, string> = { host: url.host, 'x-amz-date': amzDate };
  headers.authorization = signV4({
    method: 'GET', url, headers, payloadHash: createHash('sha256').update('').digest('hex'),
    accessKey: s.access_key_id ?? '', secretKey: secret ?? '', region, service: 'ses', amzDate,
  });
  delete headers.host;
  return http(url.toString(), { method: 'GET', headers });
}

/**
 * Check a service's settings without sending: connect and sign in (SMTP), get a
 * token (Graph), or make a read-only call that needs the key (the HTTP APIs).
 * Returns what was checked; throws a MailError with the reason.
 */
export async function verifyConnection(provider: Provider, s: ServiceSettings, secret: string | null): Promise<string> {
  switch (provider) {
    case 'smtp': {
      const security = s.security ?? 'starttls';
      const auth = s.auth ?? 'password';
      const transport = nodemailer.createTransport({
        host: s.host, port: s.port ?? (security === 'tls' ? 465 : 587), secure: security === 'tls', requireTLS: security === 'starttls', ignoreTLS: security === 'none',
        auth: (auth === 'password' ? { user: s.username, pass: secret ?? '' }
          : auth === 'oauth2' ? { type: 'OAuth2', user: s.username, accessToken: await clientCredentialsToken(entraTokenUrl(s), s.client_id ?? '', secret ?? '', s.scope || 'https://outlook.office365.com/.default') }
          : undefined) as never,
        tls: { rejectUnauthorized: s.tls_verify !== false }, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: TIMEOUT_MS,
      } as never);
      try {
        await transport.verify();
      } catch (e) {
        const err = e as { response?: string; message: string; code?: string };
        throw new MailError(`The SMTP server ${s.host}: ${(err.response ?? err.message).slice(0, 500)}`, false);
      } finally {
        transport.close();
      }
      return `Connected to ${s.host}:${s.port ?? (security === 'tls' ? 465 : 587)}${security === 'none' ? '' : ` with ${security === 'tls' ? 'TLS' : 'STARTTLS'}`}${
        auth === 'none' ? '' : ` and signed in as ${s.username}${auth === 'oauth2' ? ' with OAuth2' : ''}`}.`;
    }
    case 'graph':
      await clientCredentialsToken(entraTokenUrl(s), s.client_id ?? '', secret ?? '', s.scope || 'https://graph.microsoft.com/.default');
      return 'Microsoft Entra issued an access token for Microsoft Graph. Whether the application may send as a mailbox (Mail.Send) shows when you send a test mail.';
    case 'ses': {
      const j = json((await sesGet(s, secret, '/v2/email/account')).text);
      const quota = j.SendQuota ? ` ${j.SendQuota.SentLast24Hours ?? 0} of ${j.SendQuota.Max24HourSend ?? '?'} mails sent in the last 24 hours.` : '';
      return `Signed in to Amazon SES in ${s.region}: sending is ${j.SendingEnabled === false ? 'DISABLED' : 'enabled'}, ${
        j.ProductionAccessEnabled ? 'production access' : 'sandbox (only to verified addresses)'}.${quota}`;
    }
    case 'resend': {
      try {
        const j = json((await http(`${base(s, 'https://api.resend.com')}/domains`, { method: 'GET', headers: { authorization: `Bearer ${secret ?? ''}` } })).text);
        return `The API key is valid; ${Array.isArray(j.data) ? `${j.data.length} domain(s): ${j.data.map((d: { name: string; status: string }) => `${d.name} (${d.status})`).join(', ')}` : 'its domains could not be listed'}.`;
      } catch (e) {
        // a key that may only send can't list domains: it is valid all the same
        if (/restricted/i.test((e as Error).message)) return 'The API key is valid (it may only send mail).';
        throw e;
      }
    }
    case 'postmark': {
      const j = json((await http(`${base(s, 'https://api.postmarkapp.com')}/server`, { method: 'GET', headers: { 'x-postmark-server-token': secret ?? '', accept: 'application/json' } })).text);
      return `The server token is valid: Postmark server "${j.Name ?? '?'}".`;
    }
    case 'sendgrid': {
      const j = json((await http(`${base(s, 'https://api.sendgrid.com')}/v3/scopes`, { method: 'GET', headers: { authorization: `Bearer ${secret ?? ''}` } })).text);
      if (Array.isArray(j.scopes) && !j.scopes.includes('mail.send')) throw new MailError('The API key is valid but may not send mail (it lacks the mail.send scope).', false);
      return 'The API key is valid and may send mail.';
    }
    case 'mailgun': {
      const own = s.mailgun_region === 'eu' ? 'https://api.eu.mailgun.net' : 'https://api.mailgun.net';
      const j = json((await http(`${base(s, own)}/v3/domains/${encodeURIComponent(s.domain ?? '')}`, {
        method: 'GET', headers: { authorization: `Basic ${Buffer.from(`api:${secret ?? ''}`).toString('base64')}` } })).text);
      return `The API key is valid: domain ${s.domain} is ${j.domain?.state ?? 'known'}.`;
    }
    case 'log':
      return 'Log only: there is nothing to connect to; mail goes to the server\'s log.';
  }
}
