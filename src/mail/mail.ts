// Sending the mail queued from SQL (migration 081: meta.send_mail and
// friends). After the transaction that queued a mail commits, NOTIFY
// pgkiln_mail wakes the listener; the scheduler (src/automations.ts) is the
// fallback. Each pass claims queued mails (FOR UPDATE SKIP LOCKED, so several
// servers share the work), sends them through the application's mail service,
// and records the outcome. A failure that may pass (network, 429, 5xx, an
// SMTP 4xx) is tried again after 1, 4, 16 and 64 minutes; the fifth failure,
// or a refusal, marks the mail "error". A server that stopped while sending
// gives its mails back after 10 minutes. Sent and failed mails are kept 30
// days. Services are read through the owner pool: application code never
// sees their secrets.
import pg from 'pg';
import { owner } from '../db.ts';
import { decryptSecret } from '../secrets.ts';
import { deliver, MailError, type OutgoingMail, type Provider, type ServiceSettings } from './providers.ts';

export interface MailService {
  id: number;
  name: string;
  description: string | null;
  provider: Provider;
  settings: ServiceSettings;
  secret_enc: string | null;
  senders: string[];
  enabled: boolean;
}

const PER_PASS = 20;
const PARALLEL = 3;
export const ATTEMPTS = 5;
const KEEP_DAYS = 30;

/** May the service send as this address? (user@example.com, or @example.com for the whole domain) */
export function senderAllowed(senders: string[], from: string) {
  const f = from.toLowerCase();
  return senders.some((s) => s.toLowerCase() === f || (s.startsWith('@') && f.endsWith(s.toLowerCase())));
}

/** Send one message through a service now (the worker, and the builder's test). Returns the provider's id. */
export async function sendWith(service: MailService, m: OutgoingMail) {
  if (!service.enabled) throw new MailError(`Mail service ${service.name} is disabled.`, false);
  if (!senderAllowed(service.senders, m.from)) throw new MailError(`Mail service ${service.name} may not send as ${m.from}.`, false);
  let secret: string | null = null;
  try {
    secret = service.secret_enc ? decryptSecret(service.secret_enc) : null;
  } catch (e) {
    throw new MailError(`The secret of mail service ${service.name} can't be read: ${(e as Error).message}`, false);
  }
  return deliver(service.provider, service.settings ?? {}, secret, m);
}

interface Claimed {
  id: string;
  app_id: number;
  from_address: string;
  reply_to: string | null;
  to_addresses: string[];
  cc_addresses: string[];
  bcc_addresses: string[];
  subject: string;
  body_text: string | null;
  body_html: string | null;
  attempts: number;
}

async function sendOne(m: Claimed) {
  const service = await owner.one<MailService>(
    `select s.* from meta.app_mail_service x join meta.mail_service s on s.id = x.service_id where x.app_id = $1`, [m.app_id]);
  try {
    if (!service) throw new MailError('The application has no mail service any more.', false);
    const attachments = (await owner.query<{ filename: string; mime: string; content: Buffer }>(
      'select filename, mime, content from meta.mail_attachment where mail_id = $1 order by id', [m.id])).rows;
    const id = await sendWith(service, {
      from: m.from_address, to: m.to_addresses, cc: m.cc_addresses, bcc: m.bcc_addresses, replyTo: m.reply_to,
      subject: m.subject, text: m.body_text, html: m.body_html, attachments,
    });
    await owner.query(`update meta.mail_queue set status = 'sent', sent_at = now(), provider_id = $2, service = $3, message = null where id = $1`,
      [m.id, id ? String(id).slice(0, 500) : null, service.name]);
  } catch (e) {
    const retry = e instanceof MailError ? e.retry : true;
    const message = (e as Error).message.slice(0, 2000);
    if (retry && m.attempts < ATTEMPTS)
      await owner.query(`update meta.mail_queue set status = 'queued', not_before = now() + make_interval(mins => $2), message = $3, service = $4 where id = $1`,
        [m.id, 4 ** (m.attempts - 1), message, service?.name ?? null]);
    else await owner.query(`update meta.mail_queue set status = 'error', message = $2, service = $3 where id = $1`, [m.id, message, service?.name ?? null]);
  }
}

/** One pass: claim queued mails, send them, forget old ones. Returns the ids handled. */
export async function mailTick(): Promise<string[]> {
  const claimed = (
    await owner.query<Claimed>(
      `update meta.mail_queue m set status = 'sending', attempts = attempts + 1, not_before = now()
        where m.id in (select id from meta.mail_queue where status = 'queued' and not_before <= now()
                        order by id for update skip locked limit ${PER_PASS})
        returning m.id, m.app_id, m.from_address, m.reply_to, m.to_addresses, m.cc_addresses, m.bcc_addresses,
                  m.subject, m.body_text, m.body_html, m.attempts`,
    )
  ).rows.sort((a, b) => Number(a.id) - Number(b.id));
  const queue = [...claimed];
  const worker = async () => {
    for (let m = queue.shift(); m; m = queue.shift()) {
      try {
        await sendOne(m);
      } catch (e) {
        await owner.query(`update meta.mail_queue set status = 'error', message = $2 where id = $1`, [m.id, (e as Error).message.slice(0, 2000)]).catch(() => {});
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, worker));
  // a server that stopped while sending: its mails go back to the queue after 10 minutes
  await owner.query(`update meta.mail_queue set status = 'queued' where status = 'sending' and not_before < now() - interval '10 minutes' and attempts < ${ATTEMPTS}`);
  await owner.query(`update meta.mail_queue set status = 'error', message = coalesce(message, 'Stopped while sending.') where status = 'sending' and not_before < now() - interval '10 minutes'`);
  await owner.query(`delete from meta.mail_queue where created_at < now() - interval '${KEEP_DAYS} days' and status in ('sent', 'error', 'cancelled')`);
  return claimed.map((m) => m.id);
}

let listener: pg.Client | undefined;

/** Send soon after a transaction that queued mail commits (NOTIFY pgkiln_mail); the scheduler is the fallback. */
export async function startMailListener() {
  if (process.env.AUTOMATIONS === 'off' || listener) return;
  let busy = false;
  let again = false;
  const run = async () => {
    if (busy) return void (again = true);
    busy = true;
    try {
      do {
        again = false;
        await mailTick();
      } while (again);
    } catch (e) {
      console.error('mail:', (e as Error).message);
    } finally {
      busy = false;
    }
  };
  try {
    listener = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await listener.connect();
    listener.on('notification', () => void run());
    listener.on('error', (e) => console.error('mail listener:', e.message));
    await listener.query('listen pgkiln_mail');
  } catch (e) {
    console.error('mail: no listener, the scheduler sends the mail:', (e as Error).message);
  }
}
