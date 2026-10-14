import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { esc, html, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { documentShell } from '../layout.ts';
import { senderAllowed, sendWith, type MailService } from '../mail/mail.ts';
import { clientIp, getSession, logActivity, saveState, takeFlash, type Session } from '../session.ts';
import { publicUrl } from '../sso.ts';
import { back, BASE, builderHead, csrf, flash, THEME_COOKIE, validTheme, type Req } from './ui.ts';

// "Find my workspace" on the builder's sign-in page (migration 096; APEX: Find
// My Workspace): a developer who forgot which workspace to sign in to enters
// their e-mail address, and the developer accounts with that address get a
// mail with their user name and workspaces. The page says the same whatever
// the address, the mail goes out after the answer (no timing difference), and
// requests are limited per address and per IP address. It is offered only
// when administrators chose a mail service for the builder (Workspace
// utilities → Mail services → Builder mail).

const PER_IP_HOUR = 10;
const PER_ADDRESS_HOUR = 3;
export const EMAIL = /^[^@\s<>"(),;:\\]+@[^@\s<>"(),;:\\]+\.[^@\s<>"(),;:\\]+$/;

/** The builder's mail service and From address, when set up and usable; null otherwise. */
export async function builderMail(): Promise<{ service: MailService; from: string } | null> {
  const rows = (await owner.query<{ name: string; value: string }>(`select name, value from meta.setting where name in ('builder_mail_service', 'builder_mail_from')`)).rows;
  const get = (k: string) => rows.find((r) => r.name === k)?.value ?? '';
  const service = get('builder_mail_service') ? await owner.one<MailService>('select * from meta.mail_service where name = $1 and enabled', [get('builder_mail_service')]) : undefined;
  const from = get('builder_mail_from');
  return service && from && senderAllowed(service.senders, from) ? { service, from } : null;
}

/** The mail for one address: each account with it, and its workspaces. */
export async function workspacesMail(email: string): Promise<{ to: string; subject: string; text: string; html: string } | null> {
  const accounts = (await owner.query<{ username: string; admin: boolean; workspaces: string[] }>(
    `select d.username, d.is_admin as admin,
            coalesce((select array_agg(w.name order by w.id = 1 desc, lower(w.name)) from meta.workspace w
                       where d.is_admin or exists (select 1 from meta.workspace_member m where m.workspace_id = w.id and m.username = d.username)), '{}') as workspaces
       from meta.developer d where lower(d.email) = lower($1) order by d.username`, [email])).rows;
  if (!accounts.length) return null;
  const signIn = `${publicUrl()}${BASE}/login`;
  const lines = accounts.map((a) => `${a.username}${a.admin ? ' (administrator: every workspace)' : ''}\n${a.workspaces.length ? a.workspaces.map((w) => `  - ${w}`).join('\n') : '  (no workspace yet: ask an administrator)'}`);
  const text = `You asked which pgkiln workspaces you can sign in to.\n\n${lines.join('\n\n')}\n\nSign in at ${signIn}\n\nIf you didn't ask, you can ignore this mail: nothing was changed.`;
  const body = `<p>You asked which pgkiln workspaces you can sign in to.</p>${accounts.map((a) => `<p><b>${esc(a.username)}</b>${a.admin ? ' (administrator: every workspace)' : ''}</p><ul>${a.workspaces.length ? a.workspaces.map((w) => `<li>${esc(w)}</li>`).join('') : '<li>No workspace yet: ask an administrator.</li>'}</ul>`).join('')}<p>Sign in at <a href="${esc(signIn)}">${esc(signIn)}</a></p><p>If you didn't ask, you can ignore this mail: nothing was changed.</p>`;
  return { to: email, subject: 'Your pgkiln workspaces', text, html: body };
}

const page = (s: Session, theme: ReturnType<typeof validTheme>, body: Raw) =>
  documentShell(
    'Find my workspace · Builder',
    html`<main class="signin">
      <section class="signin-hero" aria-label="pgkiln">
        <span class="signin-logo" aria-hidden="true">pg</span>
        <h1 class="signin-title">pgkiln</h1>
        <p class="signin-tagline">Build data applications on PostgreSQL, in SQL you can trust</p>
      </section>
      <section class="signin-panel"><div class="signin-form">${body}
        <nav class="signin-actions" aria-label="Quick actions"><a href="${BASE}/login">${icon('arrow-left')} Back to sign in</a></nav></div></section>
    </main>`,
    'login-body ide-login signin-body',
    {},
    builderHead(),
    { theme: theme ?? 'dark' },
  );

export async function findWorkspaceRoutes(app: FastifyInstance) {
  app.get(`${BASE}/find-workspace`, async (req: Req, reply) => {
    const s = await getSession(req, reply, null, BASE);
    const done = takeFlash(s);
    const error = takeFlash(s, '__ERROR');
    await saveState(s);
    const mail = await builderMail();
    const theme = validTheme(req.cookies?.[THEME_COOKIE]);
    const body = !mail
      ? html`<h2>Find my workspace</h2><p class="muted u-mt0">This installation doesn't send mail to developers. Ask an administrator which workspaces you belong to; or sign in with your user name and password only: the workspace is optional.</p>`
      : done
        ? html`<h2>Check your mail</h2><div class="alert alert-success" role="status">${done}</div>`
        : html`<h2>Find my workspace</h2>
          <p class="muted u-mt0">Enter the e-mail address of your developer account: we send you your user name and the workspaces you can sign in to.</p>
          ${error ? html`<div class="alert alert-error" role="alert">${error}</div>` : ''}
          <form method="post" action="${BASE}/find-workspace">${csrf(s)}
            <div class="field signin-field"><label class="sr-only" for="f_email">E-mail address</label>
              <div class="signin-input">${icon('at')}<input id="f_email" name="email" type="email" placeholder="E-mail address" required autocomplete="email" maxlength="254"></div></div>
            <button class="btn btn-hot signin-submit">Send</button>
          </form>`;
    return reply.type('text/html').send(page(s, theme, body));
  });

  app.post(`${BASE}/find-workspace`, async (req: Req, reply) => {
    const s = await getSession(req, reply, null, BASE);
    const to = `${BASE}/find-workspace`;
    if (req.body?.__csrf !== s.csrf_token) {
      flash(s, 'Your session expired. Please try again.', 'error');
      return back(reply, s, to);
    }
    const email = String(req.body?.email ?? '').trim().slice(0, 254);
    if (!EMAIL.test(email)) {
      flash(s, 'Enter an e-mail address, e.g. ann@example.com.', 'error');
      return back(reply, s, to);
    }
    const ip = clientIp(req);
    const mail = await builderMail();
    // the same limits and the same answer for every address
    const recent = await owner.one<{ by_ip: number; by_address: number }>(
      `select count(*) filter (where ip = $1)::int as by_ip, count(*) filter (where lower(detail) = lower($2))::int as by_address
         from meta.activity_log where event = 'find_workspace' and app_id is null and at > now() - interval '1 hour'`, [ip, email]);
    const limited = !!recent && (recent.by_ip >= PER_IP_HOUR || recent.by_address >= PER_ADDRESS_HOUR);
    await logActivity({ appId: null, username: null, event: 'find_workspace', ip, detail: email.toLowerCase() });
    if (mail && !limited)
      // after the answer: the time it takes never tells whether an account has the address
      setImmediate(() => {
        workspacesMail(email)
          .then((m) => (m ? sendWith(mail.service, { from: mail.from, to: [m.to], cc: [], bcc: [], replyTo: null, subject: m.subject, text: m.text, html: m.html, attachments: [] }) : null))
          .catch((e) => console.error('find my workspace: the mail was not sent:', (e as Error).message));
      });
    flash(s, `If a developer account has the address ${email}, it gets a mail with its user name and workspaces in a few minutes. No mail? Ask an administrator.`);
    return back(reply, s, to);
  });
}

