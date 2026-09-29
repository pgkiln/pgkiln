import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw } from '../html.ts';
import { mailFrom, pushQueue, smtpConfigured } from '../mail.ts';
import { back, BASE, csrf, developer, flash, input, region, send, shell, type Req } from './ui.ts';

// Builder → Mail: the mail queue and log (APEX: Manage Instance → Mail
// Queue / Monitor Activity → Mail Log), a test e-mail and "send now".

const STATUSES = ['all', 'queued', 'failed', 'sent'] as const;

export async function mailRoutes(app: FastifyInstance) {
  app.get(`${BASE}/mail`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const status = (STATUSES as readonly string[]).includes(req.query.status ?? '') ? req.query.status : 'all';
    const [counts, mails] = await Promise.all([
      owner.one(
        `select count(*) filter (where status = 'queued')::int as queued, count(*) filter (where status = 'failed')::int as failed,
                count(*) filter (where status = 'sent' and sent_at > now() - interval '1 day')::int as sent_today
           from meta.mail_queue`,
      ),
      owner.query(
        `select q.id, q.created_at, q.status, q.attempts, q.mail_to, q.subject, q.last_error, q.sent_at, q.created_by, q.template, a.alias,
                (select count(*) from meta.mail_attachment m where m.mail_id = q.id)::int as attachments
           from meta.mail_queue q left join meta.app a on a.id = q.app_id
          where $1 = 'all' or q.status = $1
          order by q.id desc limit 200`,
        [status],
      ),
    ]);
    const main = html`
      <div class="title-row"><h1>Mail</h1>
        <div class="buttons"><form method="post" action="${BASE}/mail/push">${csrf(s)}<button class="btn btn-hot"${smtpConfigured() ? '' : raw(' disabled')}>Send queued mail now</button></form></div></div>
      <div class="stat-grid">
        <div class="stat"><b>${counts.queued}</b><span>queued</span></div>
        <div class="stat"><b>${counts.failed}</b><span>failed</span></div>
        <div class="stat"><b>${counts.sent_today}</b><span>sent (24h)</span></div>
      </div>
      <div class="columns wide-left">
        ${region('Queue and log', html`
          <nav class="chips" aria-label="Filter by status" style="margin-bottom:.75rem">${STATUSES.map((st) =>
            html`<a class="chip" href="?status=${st}"${st === status ? raw(' aria-current="page"') : ''}>${st}</a> `)}</nav>
          <div class="table-wrap"><table class="report report-reflow">
            <thead><tr><th>Id</th><th>Created</th><th>App</th><th>To</th><th>Subject</th><th>Status</th><th></th></tr></thead>
            <tbody>${mails.rows.length
              ? mails.rows.map((m) => html`<tr>
                  <td data-label="Id"><a href="${BASE}/mail/${m.id}">${m.id}</a></td>
                  <td data-label="Created">${String(m.created_at).slice(0, 16)}</td>
                  <td data-label="App">${m.alias ?? html`<span class="muted">instance</span>`}</td>
                  <td data-label="To">${m.mail_to}</td>
                  <td data-label="Subject">${m.subject}${m.attachments ? html` <span class="muted">(${m.attachments} attachment${m.attachments > 1 ? 's' : ''})</span>` : ''}</td>
                  <td data-label="Status"><span class="ev ev-${m.status === 'failed' ? 'error' : m.status === 'sent' ? 'login' : 'page_view'}">${m.status}</span>${m.attempts > 1 || m.last_error ? html`<div class="muted" title="${m.last_error}">${m.attempts} attempt(s)${m.last_error ? `: ${String(m.last_error).slice(0, 60)}` : ''}</div>` : ''}</td>
                  <td data-label="">${m.status === 'failed' ? html`<form method="post" action="${BASE}/mail/${m.id}/retry">${csrf(s)}<button class="link-button">Retry</button></form>` : ''}</td>
                </tr>`)
              : html`<tr><td colspan="7" class="empty">No mail.</td></tr>`}</tbody>
          </table></div>`)}
        <div>
          ${region('SMTP server', html`<ul class="checklist">
              <li>${smtpConfigured() ? html`✓ <code>${process.env.SMTP_HOST}:${process.env.SMTP_PORT ?? 587}</code>${process.env.SMTP_SECURE === 'true' ? ' (TLS)' : ''}` : html`✗ <b>Not configured</b>: set <code>SMTP_HOST</code> (and <code>SMTP_PORT</code>, <code>SMTP_USER</code>, <code>SMTP_PASSWORD</code>). Mail stays queued until then.`}</li>
              <li>${mailFrom() ? html`✓ Default sender <code>${mailFrom()}</code>` : html`✗ No default sender: set <code>MAIL_FROM</code>`}</li>
            </ul>
            <p class="muted">Applications send mail with <code>meta.send_mail(to, subject, body)</code>, <code>meta.send_mail_template(…)</code> or a <b>Send e-mail</b> page process. Mail is only sent when the transaction that queued it commits.</p>`)}
          ${region('Send a test e-mail', html`<form method="post" action="${BASE}/mail/test">${csrf(s)}
              ${input('to', 'To', '', { type: 'email', required: true })}
              <div class="buttons"><button class="btn">Queue test e-mail</button></div></form>`)}
          ${region('Clean up', html`<form method="post" action="${BASE}/mail/purge">${csrf(s)}
              <p class="muted" style="margin-top:0">Delete sent mail older than 30 days (and its attachments).</p>
              <div class="buttons"><button class="btn" data-confirm="Delete sent mail older than 30 days?">Delete old mail</button></div></form>`)}
        </div>
      </div>`;
    return send(reply, s, shell(s, 'Mail', [['Mail']], main, 'mail'));
  });

  app.get(`${BASE}/mail/:id`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const m = await owner.one('select q.*, a.alias from meta.mail_queue q left join meta.app a on a.id = q.app_id where q.id = $1', [req.params.id]);
    if (!m) return reply.code(404).send('Not found');
    const files = (await owner.query('select filename, mime_type, length(content) as size from meta.mail_attachment where mail_id = $1 order by id', [m.id])).rows;
    const row = (label: string, v: unknown) => (v ? html`<dt>${label}</dt><dd>${String(v)}</dd>` : '');
    const main = html`<div class="title-row"><h1>Mail ${m.id}</h1></div>
      <div class="columns wide-left">
        ${region(m.subject || '(no subject)', html`
          ${m.body_html ? html`<h3>HTML body (source)</h3><pre class="source">${m.body_html}</pre>` : ''}
          ${m.body_text ? html`<h3>Text body</h3><pre class="source">${m.body_text}</pre>` : ''}`)}
        ${region('Details', html`<dl class="details">
          ${row('Status', m.status)}${row('Attempts', m.attempts)}${row('Last error', m.last_error)}
          ${row('Application', m.alias)}${row('Queued by', m.created_by)}${row('Template', m.template)}
          ${row('From', m.mail_from || mailFrom())}${row('To', m.mail_to)}${row('Cc', m.mail_cc)}${row('Bcc', m.mail_bcc)}${row('Reply-to', m.reply_to)}
          ${row('Created', String(m.created_at).slice(0, 19))}${row('Sent', m.sent_at && String(m.sent_at).slice(0, 19))}
          ${files.length ? html`<dt>Attachments</dt><dd>${files.map((f) => html`<div>${f.filename} <span class="muted">(${f.mime_type}, ${Math.ceil(f.size / 1024)} KB)</span></div>`)}</dd>` : ''}
        </dl>
        <form method="post" action="${BASE}/mail/${m.id}/delete" class="danger-zone">${csrf(s)}<button class="btn btn-danger" data-confirm="Delete this mail?">Delete</button></form>`)}
      </div>`;
    return send(reply, s, shell(s, `Mail ${m.id}`, [['Mail', `${BASE}/mail`], [String(m.id)]], main, 'mail'));
  });

  app.post(`${BASE}/mail/push`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    try {
      const r = await pushQueue();
      if (!r.configured) flash(s, 'No SMTP server configured (SMTP_HOST).', 'error');
      else flash(s, `Sent ${r.sent}, failed ${r.failed}.`, r.failed ? 'error' : 'ok');
    } catch (e) {
      flash(s, (e as Error).message, 'error');
    }
    return back(reply, s, `${BASE}/mail`);
  });

  app.post(`${BASE}/mail/test`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    try {
      await owner.query(`select meta.send_mail($1, 'pgapex test e-mail', $2)`, [
        req.body?.to?.trim() ?? '', `This is a test e-mail from pgapex, sent by ${s.username} at ${new Date().toISOString()}.`,
      ]);
      flash(s, smtpConfigured() ? 'Test e-mail queued; it is sent within seconds.' : 'Test e-mail queued. It is sent once SMTP_HOST is configured.');
    } catch (e) {
      flash(s, (e as Error).message, 'error');
    }
    return back(reply, s, `${BASE}/mail`);
  });

  app.post(`${BASE}/mail/:id/retry`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    await owner.query(`update meta.mail_queue set status = 'queued', attempts = 0, next_attempt_at = now() where id = $1 and status = 'failed'`, [req.params.id]);
    flash(s, 'Mail queued again.');
    return back(reply, s, `${BASE}/mail`);
  });

  app.post(`${BASE}/mail/:id/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    await owner.query('delete from meta.mail_queue where id = $1', [req.params.id]);
    flash(s, 'Mail deleted.');
    return back(reply, s, `${BASE}/mail`);
  });

  app.post(`${BASE}/mail/purge`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const r = await owner.query(`delete from meta.mail_queue where status = 'sent' and sent_at < now() - interval '30 days'`);
    flash(s, `${r.rowCount} mail(s) deleted.`);
    return back(reply, s, `${BASE}/mail`);
  });
}
