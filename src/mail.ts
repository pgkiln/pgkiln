import nodemailer from 'nodemailer';
import pg from 'pg';
import { owner } from './db.ts';

// Delivers meta.mail_queue over SMTP (like APEX's mail queue job): woken by
// NOTIFY pgapex_mail and by a timer, several instances can run side by side
// (rows are claimed with FOR UPDATE SKIP LOCKED), failures are retried with
// back-off and end as "failed" after MAIL_MAX_ATTEMPTS.

export interface Transport {
  sendMail(message: Record<string, unknown>): Promise<unknown>;
}

const MAX_ATTEMPTS = () => Math.max(1, Number(process.env.MAIL_MAX_ATTEMPTS ?? 5));
export const mailFrom = () => process.env.MAIL_FROM ?? '';
export const smtpConfigured = () => !!process.env.SMTP_HOST;

let transport: Transport | undefined;

/** Use another transport (tests). */
export function setTransport(t: Transport | undefined) {
  transport = t;
}

function smtp(): Transport | undefined {
  if (transport) return transport;
  if (!smtpConfigured()) return undefined;
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true', // true: TLS from the start (port 465); false: STARTTLS when offered
    requireTLS: process.env.SMTP_REQUIRE_TLS === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD ?? '' } : undefined,
    disableFileAccess: true,
    disableUrlAccess: true,
  }) as Transport;
  return transport;
}

const list = (v: string | null) => (v ? v.split(',').map((a) => a.trim()).filter(Boolean) : undefined);

/**
 * Send what is due now. Returns counts; does nothing (and reports it) when
 * no SMTP server is configured.
 */
export async function pushQueue(limit = 50) {
  const t = smtp();
  if (!t) return { sent: 0, failed: 0, configured: false };
  // rows left "sending" by a crashed instance go back to the queue
  await owner.query(`update meta.mail_queue set status = 'queued' where status = 'sending' and next_attempt_at < now() - interval '10 minutes'`);
  const batch = (
    await owner.query(
      `update meta.mail_queue q set status = 'sending', attempts = attempts + 1, next_attempt_at = now()
        where id in (select id from meta.mail_queue where status = 'queued' and next_attempt_at <= now()
                      order by id limit $1 for update skip locked)
        returning q.*`,
      [limit],
    )
  ).rows;
  let sent = 0;
  let failed = 0;
  for (const m of batch) {
    try {
      const attachments = (await owner.query('select filename, mime_type, content from meta.mail_attachment where mail_id = $1 order by id', [m.id])).rows;
      await t.sendMail({
        from: m.mail_from || mailFrom() || undefined,
        to: list(m.mail_to),
        cc: list(m.mail_cc),
        bcc: list(m.mail_bcc),
        replyTo: list(m.reply_to),
        subject: m.subject,
        text: m.body_text ?? undefined,
        html: m.body_html ?? undefined,
        attachments: attachments.map((a) => ({ filename: a.filename, contentType: a.mime_type, content: a.content })),
        headers: { 'X-Pgapex-Mail-Id': String(m.id) },
      });
      await owner.query(`update meta.mail_queue set status = 'sent', sent_at = now(), last_error = null where id = $1`, [m.id]);
      sent++;
    } catch (e) {
      const final = m.attempts >= MAX_ATTEMPTS();
      await owner.query(
        `update meta.mail_queue set status = $2, last_error = $3,
                next_attempt_at = now() + make_interval(mins => power(2, least(attempts, 8))::int)
          where id = $1`,
        [m.id, final ? 'failed' : 'queued', String((e as Error).message ?? e).slice(0, 1000)],
      );
      failed++;
    }
  }
  return { sent, failed, configured: true };
}

let timer: NodeJS.Timeout | undefined;
let listener: pg.Client | undefined;
let running = false;

async function tick(log: { warn: (o: unknown, msg: string) => void }) {
  if (running) return;
  running = true;
  try {
    let r;
    do r = await pushQueue();
    while (r.sent + r.failed >= 50);
  } catch (e) {
    log.warn({ err: e }, 'mail queue');
  } finally {
    running = false;
  }
}

/** Start delivering mail (server only; tests call pushQueue() directly). */
export async function startMailer(log: { info: (msg: string) => void; warn: (o: unknown, msg: string) => void }) {
  if (!smtpConfigured()) {
    log.info('SMTP_HOST is not set: e-mail stays in the queue (Builder → Mail).');
    return;
  }
  const seconds = Math.max(5, Number(process.env.MAIL_POLL_SECONDS ?? 30));
  timer = setInterval(() => tick(log), seconds * 1000);
  timer.unref();
  try {
    listener = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await listener.connect();
    listener.on('notification', () => setTimeout(() => tick(log), 200)); // after the sending transaction committed
    listener.on('error', (e) => log.warn({ err: e }, 'mail listener'));
    await listener.query('listen pgapex_mail');
  } catch (e) {
    log.warn({ err: e }, 'mail listener (falling back to polling)');
  }
  tick(log);
}

export async function stopMailer() {
  if (timer) clearInterval(timer);
  await listener?.end().catch(() => {});
}
