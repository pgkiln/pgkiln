// Sending e-mail (migration 081): the SQL API, templates, the queue and its
// worker, every provider against a mock server (no real mail is sent), the
// send_email process, and the builder's pages.
process.env.PGKILN_SECRET_KEY = 'test-only-secret-key-0123456789abcdef';
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { encryptSecret } from '../src/secrets.ts';
import { mailTick } from '../src/mail/mail.ts';
import { clearTokens, mime } from '../src/mail/providers.ts';
import { Browser } from './helpers.ts';
import { MailMock, TOKEN } from './mail-mock.ts';

let app: FastifyInstance;
let appId: number;
let role: string;
const mock = new MailMock();
const SERVICE = 'T_MAIL';

/** Run SQL as the HR application does: its role, its app id, a user. */
async function asApp<T>(fn: (q: (sql: string, params?: unknown[]) => Promise<any[]>) => Promise<T>, opts: { app?: number; role?: string } = {}) {
  const c = await owner.pool.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('pgkiln.app_id', $1, true), set_config('pgkiln.app_user', 'KING', true)`, [String(opts.app ?? appId)]);
    await c.query(`set local role ${opts.role ?? role}`);
    const r = await fn(async (sql, params) => (await c.query(sql, params)).rows);
    await c.query('commit');
    return r;
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}

async function useService(provider: string, settings: Record<string, unknown>, secret: string | null = 'the-secret', senders = ['@example.com']) {
  await owner.query('delete from meta.mail_service where name = $1', [SERVICE]);
  const id = (await owner.one(
    'insert into meta.mail_service (name, provider, settings, secret_enc, senders) values ($1, $2, $3, $4, $5) returning id',
    [SERVICE, provider, JSON.stringify(settings), secret ? encryptSecret(secret) : null, senders])).id;
  await owner.query(`insert into meta.app_mail_service (app_id, service_id, from_address) values ($1, $2, 'hr@example.com')
                     on conflict (app_id) do update set service_id = excluded.service_id, from_address = excluded.from_address, max_per_day = null`, [appId, id]);
  return id;
}

/** Queue one mail as the application and send the queue; the mail's row afterwards. */
async function sendOne(args: { to?: string; subject?: string; body?: string | null; html?: string | null; cc?: string; bcc?: string; attach?: boolean } = {}) {
  const id = await asApp(async (q) => {
    const [{ id }] = await q('select meta.send_mail($1, $2, $3, $4, null, $5, $6, $7) as id', [
      args.to ?? 'king@example.com', args.subject ?? 'Hello', args.body === undefined ? 'Plain text' : args.body, args.html ?? null, args.cc ?? null, args.bcc ?? null, null]);
    if (args.attach) await q(`select meta.add_mail_attachment($1, convert_to('a,b\n1,2', 'UTF8'), 'data.csv', 'text/csv')`, [id]);
    return id as string;
  });
  await mailTick();
  return owner.one('select * from meta.mail_queue where id = $1', [id]);
}

before(async () => {
  app = await buildApp({ logger: false });
  const a = await owner.one(`select id, db_role from meta.app where alias = 'hr'`);
  appId = a.id;
  role = a.db_role;
  await mock.start();
});

beforeEach(async () => {
  mock.reset();
  clearTokens();
  // each test sends only its own mail
  await owner.query(`update meta.mail_queue set status = 'cancelled' where app_id = $1 and status = 'queued'`, [appId]);
});

after(async () => {
  await owner.query('delete from meta.mail_queue where app_id = $1 and subject like $2', [appId, 'T %']);
  await owner.query('delete from meta.mail_service where name = $1', [SERVICE]);
  await owner.query(`delete from meta.email_template where app_id = $1 and name like 'T_%'`, [appId]);
  await mock.stop();
  await app.close();
  await closePools();
});

describe('mail: SQL API', () => {
  test('meta.send_mail checks its arguments and queues in the caller\'s transaction', async () => {
    await useService('log', {});
    const bad = async (args: unknown[], message: RegExp) =>
      assert.rejects(asApp((q) => q('select meta.send_mail($1, $2, $3, $4, $5, $6, $7, $8)', args)), message);
    await bad(['not-an-address', 'T x', 'b', null, null, null, null, null], /is not an e-mail address/);
    await bad(['a@example.com\r\nBcc: x@evil.example', 'T x', 'b', null, null, null, null, null], /is not an e-mail address/);
    await bad(['a@example.com', 'T x\r\nBcc: x@evil.example', 'b', null, null, null, null, null], /subject is required, on one line/);
    await bad(['a@example.com', 'T x', null, null, null, null, null, null], /plain text or HTML body/);
    await bad(['a@example.com', 'T x', 'b', null, 'boss@other.example', null, null, null], /may not send as boss@other.example/);
    await bad([Array.from({ length: 51 }, (_, i) => `u${i}@example.com`).join(','), 'T x', 'b', null, null, null, null, null], /at most 50 recipients/);
    // a rollback queues nothing
    const before = (await owner.one('select count(*)::int as n from meta.mail_queue where app_id = $1', [appId])).n;
    await assert.rejects(asApp(async (q) => {
      await q(`select meta.send_mail('a@example.com', 'T rolled back', 'b')`);
      throw new Error('roll back');
    }), /roll back/);
    assert.equal((await owner.one('select count(*)::int as n from meta.mail_queue where app_id = $1', [appId])).n, before);
    // a good one: addresses split, deduplicated, From of the application
    const id = await asApp(async (q) => (await q(`select meta.send_mail('a@example.com; b@example.com, a@example.com', 'T good', 'b', null, null, 'c@example.com') as id`))[0].id);
    const m = await owner.one('select * from meta.mail_queue where id = $1', [id]);
    assert.deepEqual(m.to_addresses, ['a@example.com', 'b@example.com']);
    assert.deepEqual(m.cc_addresses, ['c@example.com']);
    assert.equal(m.from_address, 'hr@example.com');
    assert.equal(m.username, 'KING');
    assert.equal(m.status, 'queued');
    assert.equal(await asApp(async (q) => (await q('select meta.mail_status($1) as s', [id]))[0].s), 'queued');
  });

  test('templates: #NAME# escaped in HTML, as it is in text and the subject; #NAME!RAW# trusted', async () => {
    await useService('log', {});
    await owner.query(`delete from meta.email_template where app_id = $1 and name = 'T_DECIDED'`, [appId]);
    await owner.query(`insert into meta.email_template (app_id, name, subject, html_body, text_body) values ($1, 'T_DECIDED', 'T Leave #STATUS#',
      '<p>Dear #name#, your leave is #STATUS#.</p>#SIGNATURE!RAW# #UNKNOWN#', 'Dear #NAME#, your leave is #STATUS#.')`, [appId]);
    const id = await asApp(async (q) => (await q(`select meta.send_mail_template('t_decided', $1::jsonb, 'king@example.com') as id`,
      [JSON.stringify({ NAME: '<b>King</b> & co', status: 'approved', SIGNATURE: '<i>HR</i>' })]))[0].id);
    const m = await owner.one('select * from meta.mail_queue where id = $1', [id]);
    assert.equal(m.subject, 'T Leave approved');
    assert.equal(m.body_html, '<p>Dear &lt;b&gt;King&lt;/b&gt; &amp; co, your leave is approved.</p><i>HR</i> #UNKNOWN#');
    assert.equal(m.body_text, 'Dear <b>King</b> & co, your leave is approved.');
    assert.equal(m.template, 'T_DECIDED');
    await assert.rejects(asApp((q) => q(`select meta.send_mail_template('T_NONE', '{}', 'king@example.com')`)), /no e-mail template T_NONE/);
  });

  test('attachments only for a mail queued in the same transaction; the daily limit', async () => {
    await useService('log', {});
    const id = await asApp(async (q) => {
      const [{ id }] = await q(`select meta.send_mail('a@example.com', 'T attach', 'b') as id`);
      await q(`select meta.add_mail_attachment($1, '\\x00ff'::bytea, 'x/../evil"name.bin', 'application/octet-stream')`, [id]);
      return id;
    });
    assert.equal((await owner.one('select filename from meta.mail_attachment where mail_id = $1', [id])).filename, 'x_.._evil_name.bin');
    await assert.rejects(asApp((q) => q(`select meta.add_mail_attachment($1, '\\x00'::bytea, 'late.bin')`, [id])), /was not queued in this transaction/);
    await owner.query('update meta.app_mail_service set max_per_day = 0 where app_id = $1', [appId]);
    await assert.rejects(asApp((q) => q(`select meta.send_mail('a@example.com', 'T limited', 'b')`)), /limit of 0 mails per day/);
    await owner.query('update meta.app_mail_service set max_per_day = null where app_id = $1', [appId]);
  });
});

describe('mail: providers (mock servers)', () => {
  test('SMTP with a password: the message, attachments, bcc only in the envelope', async () => {
    await useService('smtp', { host: '127.0.0.1', port: mock.smtpPort, security: 'none', auth: 'password', username: 'mailer@example.com' }, 'the-password');
    const m = await sendOne({ subject: 'T smtp', html: '<p>Hi</p>', cc: 'c@example.com', bcc: 'hidden@example.com', attach: true });
    assert.equal(m.status, 'sent', m.message);
    assert.equal(m.service, SERVICE);
    const hit = mock.smtpHits[0];
    assert.equal(hit.auth, 'plain');
    assert.equal(hit.from, 'hr@example.com');
    assert.deepEqual(hit.to.sort(), ['c@example.com', 'hidden@example.com', 'king@example.com']);
    assert.match(hit.data, /Subject: T smtp/);
    assert.match(hit.data, /filename=data\.csv/);
    assert.doesNotMatch(hit.data, /hidden@example\.com/);
  });

  test('SMTP with OAuth2 (XOAUTH2, client credentials from the token endpoint)', async () => {
    await useService('smtp', { host: '127.0.0.1', port: mock.smtpPort, security: 'none', auth: 'oauth2', username: 'mailer@example.com',
      client_id: 'the-client', token_url: `${mock.httpUrl}/tenant/oauth2/v2.0/token` }, 'the-client-secret');
    const m = await sendOne({ subject: 'T xoauth2' });
    assert.equal(m.status, 'sent', m.message);
    assert.equal(mock.smtpHits[0].auth, 'xoauth2');
    const token = mock.httpHits.find((h) => h.path.endsWith('/token'))!;
    const form = new URLSearchParams(token.body.toString());
    assert.equal(form.get('grant_type'), 'client_credentials');
    assert.equal(form.get('scope'), 'https://outlook.office365.com/.default');
  });

  test('SMTP: a refused recipient fails at once; a temporary refusal is tried again later', async () => {
    await useService('smtp', { host: '127.0.0.1', port: mock.smtpPort, security: 'none', auth: 'password', username: 'mailer@example.com' }, 'the-password');
    mock.smtpReject.set('gone@example.com', 550);
    let m = await sendOne({ to: 'gone@example.com', subject: 'T refused' });
    assert.equal(m.status, 'error');
    assert.match(m.message, /refused the message.*no such user/);
    mock.smtpReject.set('busy@example.com', 451);
    m = await sendOne({ to: 'busy@example.com', subject: 'T busy' });
    assert.equal(m.status, 'queued');
    assert.equal(m.attempts, 1);
    assert.ok(new Date(m.not_before).getTime() > Date.now() + 30_000, 'not before a minute later');
  });

  test('Microsoft Graph sendMail with an Entra token', async () => {
    await useService('graph', { tenant_id: 'tenant', client_id: 'the-client', token_url: `${mock.httpUrl}/tenant/oauth2/v2.0/token`, base_url: mock.httpUrl }, 'the-client-secret');
    const m = await sendOne({ subject: 'T graph', html: '<p>Hi</p>', attach: true, bcc: 'b@example.com' });
    assert.equal(m.status, 'sent', m.message);
    const hit = mock.httpHits.find((h) => h.path.includes('/sendMail'))!;
    assert.equal(hit.path, '/v1.0/users/hr%40example.com/sendMail');
    const body = JSON.parse(hit.body.toString());
    assert.equal(body.message.body.contentType, 'HTML');
    assert.deepEqual(body.message.bccRecipients, [{ emailAddress: { address: 'b@example.com' } }]);
    assert.equal(Buffer.from(body.message.attachments[0].contentBytes, 'base64').toString(), 'a,b\n1,2');
    assert.equal(body.saveToSentItems, false);
    const form = new URLSearchParams(mock.httpHits.find((h) => h.path.endsWith('/token'))!.body.toString());
    assert.equal(form.get('scope'), 'https://graph.microsoft.com/.default');
  });

  test('Amazon SES (raw MIME, Signature Version 4)', async () => {
    await useService('ses', { region: 'eu-west-1', access_key_id: 'AKIDEXAMPLE', base_url: mock.httpUrl }, 'aws-secret');
    const m = await sendOne({ subject: 'T ses', bcc: 'b@example.com', attach: true });
    assert.equal(m.status, 'sent', m.message);
    assert.equal(m.provider_id, 'ses-1');
    const hit = mock.httpHits[0];
    assert.match(String(hit.headers.authorization), /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-west-1\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/);
    const body = JSON.parse(hit.body.toString());
    assert.deepEqual(body.Destination.BccAddresses, ['b@example.com']);
    const raw = Buffer.from(body.Content.Raw.Data, 'base64').toString();
    assert.match(raw, /Subject: T ses/);
    assert.doesNotMatch(raw, /b@example\.com/);
  });

  test('Resend, Postmark, SendGrid and Mailgun', async () => {
    for (const [provider, settings, path, auth, id] of [
      ['resend', {}, '/emails', (h: any) => h.authorization === 'Bearer key-1', 'resend-1'],
      ['postmark', { message_stream: 'broadcast' }, '/email', (h: any) => h['x-postmark-server-token'] === 'key-1', 'postmark-1'],
      ['sendgrid', {}, '/v3/mail/send', (h: any) => h.authorization === 'Bearer key-1', 'sendgrid-1'],
      ['mailgun', { domain: 'mg.example.com' }, '/v3/mg.example.com/messages', (h: any) => h.authorization === `Basic ${Buffer.from('api:key-1').toString('base64')}`, '<mailgun-1@example.com>'],
    ] as const) {
      mock.reset();
      await useService(provider, { ...settings, base_url: mock.httpUrl }, 'key-1');
      const m = await sendOne({ subject: `T ${provider}`, html: '<p>Hi</p>', attach: true });
      assert.equal(m.status, 'sent', `${provider}: ${m.message}`);
      assert.equal(m.provider_id, id, provider);
      const hit = mock.httpHits[0];
      assert.equal(hit.path, path, provider);
      assert.ok(auth(hit.headers), `${provider}: authorization`);
      const body = hit.body.toString();
      assert.match(body, /data\.csv/, `${provider}: the attachment`);
      if (provider === 'postmark') assert.equal(JSON.parse(body).MessageStream, 'broadcast');
      if (provider === 'sendgrid') assert.deepEqual(JSON.parse(body).content.map((c: any) => c.type), ['text/plain', 'text/html']);
    }
  });

  test('HTTP 5xx and 429 are tried again, other refusals fail; after five attempts the mail fails', async () => {
    await useService('resend', { base_url: mock.httpUrl }, 'key-1');
    mock.failWith.push(503);
    let m = await sendOne({ subject: 'T retry' });
    assert.equal(m.status, 'queued');
    assert.match(m.message, /HTTP 503/);
    mock.failWith.push(422);
    m = await sendOne({ subject: 'T rejected' });
    assert.equal(m.status, 'error');
    assert.match(m.message, /HTTP 422/);
    // the fifth failure
    await owner.query(`update meta.mail_queue set attempts = 4, not_before = now() where subject = 'T retry' and app_id = $1`, [appId]);
    mock.failWith.push(500);
    await mailTick();
    m = await owner.one(`select * from meta.mail_queue where subject = 'T retry' and app_id = $1`, [appId]);
    assert.equal(m.status, 'error');
    assert.equal(m.attempts, 5);
  });

  test('a wrong client secret: no token, the mail fails with the identity provider\'s message', async () => {
    await useService('graph', { tenant_id: 't', client_id: 'c', token_url: `${mock.httpUrl}/t/token`, base_url: mock.httpUrl }, 'wrong');
    const m = await sendOne({ subject: 'T bad secret' });
    assert.equal(m.status, 'error');
    assert.match(m.message, /No access token.*bad secret/);
    assert.doesNotMatch(m.message, /wrong/, 'the secret is not in the message');
  });

  test('MIME of a message: UTF-8 subject and bodies', async () => {
    const raw = (await mime({ from: 'a@example.com', to: ['b@example.com'], cc: [], bcc: [], replyTo: 'r@example.com', subject: 'Überweisung €', text: 'Grüße', html: '<p>Grüße</p>', attachments: [] })).toString();
    assert.match(raw, /Subject: =\?UTF-8\?/);
    assert.match(raw, /Reply-To: r@example\.com/);
    assert.match(raw, /multipart\/alternative/);
  });
});

describe('mail: the send_email process and the builder', () => {
  test('the process queues in the page\'s transaction, item values escaped in HTML, attachments from a query', async () => {
    await useService('log', {});
    const page = (await owner.one('select id from meta.page where app_id = $1 and page_no = 1', [appId])).id;
    const button = (await owner.one(`insert into meta.button (page_id, seq, name, label, action) values ($1, 999, 'T_SEND', 'Send', 'submit') returning id`, [page])).id;
    const process = (await owner.one(
      `insert into meta.process (page_id, seq, name, type, point, when_button, config) values ($1, 999, 'T send', 'send_email', 'submit', 'T_SEND', $2) returning id`,
      [page, JSON.stringify({ to: 'king@example.com', subject: 'T process &APP_USER.', body: 'Hi &APP_USER.', body_html: '<p>&APP_USER.</p>',
        attachments: `select convert_to('x', 'UTF8') as content, 'note-' || :APP_USER || '.txt' as filename, 'text/plain' as mime` })])).id;
    try {
      const b = new Browser(app);
      await b.login('king');
      await b.get('/a/hr/1');
      const res = await b.submit('/a/hr/1', { __request: 'T_SEND' });
      assert.equal(res.statusCode, 303);
      const m = await owner.one(`select * from meta.mail_queue where app_id = $1 and subject = 'T process king'`, [appId]);
      assert.equal(m.body_text, 'Hi king');
      assert.equal(m.body_html, '<p>king</p>');
      assert.equal((await owner.one('select filename from meta.mail_attachment where mail_id = $1', [m.id])).filename, 'note-king.txt');
    } finally {
      await owner.query('delete from meta.process where id = $1', [process]);
      await owner.query('delete from meta.button where id = $1', [button]);
    }
  });

  test('administrators manage services (the secret is write-only); developers see their application\'s mail', async () => {
    const dev = new Browser(app);
    await dev.get('/builder/login');
    await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
    let res = await dev.get('/builder/mail');
    assert.equal(res.statusCode, 200);
    // adding a service: first the provider, then only its settings
    assert.match((await dev.get('/builder/mail/new')).body, /href="\/builder\/mail\/new\?provider=graph"/);
    const graphForm = (await dev.get('/builder/mail/new?provider=graph')).body;
    assert.match(graphForm, /name="tenant_id"/);
    assert.doesNotMatch(graphForm, /name="host"|name="region"|name="domain"/, 'no other provider\'s fields');
    assert.doesNotMatch((await dev.get('/builder/mail/new?provider=log')).body, /name="secret"/, 'log only needs no secret');
    await owner.query('delete from meta.mail_service where name = $1', [SERVICE]);
    res = await dev.submit('/builder/mail', { name: SERVICE.toLowerCase(), provider: 'resend', senders: '@example.com, hr@other.example', default_from: 'hr@example.com', secret: 'resend-key-secret', enabled: 'true', base_url: mock.httpUrl });
    assert.equal(res.statusCode, 303);
    const x = await owner.one('select * from meta.mail_service where name = $1', [SERVICE]);
    assert.match(x.secret_enc, /^v1:/);
    assert.deepEqual(x.senders, ['@example.com', 'hr@other.example']);
    const pageHtml = (await dev.get(`/builder/mail/${x.id}`)).body;
    assert.doesNotMatch(pageHtml, /resend-key-secret|v1:/);
    assert.match(pageHtml, /A secret is stored \(encrypted\)/);
    // a test through the mock
    res = await dev.submit(`/builder/mail/${x.id}/test`, { to: 'king@example.com', from: 'hr@example.com' });
    assert.match((await dev.get(`/builder/mail/${x.id}`)).body, /Sent \(the provider&#39;s id: resend-1\)/);
    assert.equal(mock.httpHits[0].headers.authorization, 'Bearer resend-key-secret');
    // the application, its From address and limit
    res = await dev.submit(`/builder/mail/${x.id}/apps`, { allow: String(appId), [`from_${appId}`]: 'hr@example.com', [`max_${appId}`]: '100' });
    assert.equal((await owner.one('select service_id, max_per_day from meta.app_mail_service where app_id = $1', [appId])).max_per_day, 100);
    // the application's mail page: retry an error, cancel a queued one
    const failed = (await owner.one(`insert into meta.mail_queue (app_id, from_address, to_addresses, subject, body_text, status, attempts) values ($1, 'hr@example.com', '{a@example.com}', 'T failed', 'x', 'error', 5) returning id`, [appId])).id;
    const mailPage = (await dev.get(`/builder/apps/${appId}/mail`)).body;
    assert.match(mailPage, /T failed/);
    res = await dev.submit(`/builder/apps/${appId}/mail/${failed}/retry`, {});
    assert.deepEqual(await owner.one('select status, attempts from meta.mail_queue where id = $1', [failed]), { status: 'queued', attempts: 0 });
    await dev.get(`/builder/apps/${appId}/mail`);
    res = await dev.submit(`/builder/apps/${appId}/mail/${failed}/cancel`, {});
    assert.equal((await owner.one('select status from meta.mail_queue where id = $1', [failed])).status, 'cancelled');
  });

  test('e-mail templates travel with the export; services, the queue and secrets don\'t', async () => {
    await owner.query(`insert into meta.email_template (app_id, name, subject, text_body) values ($1, 'T_EXPORT', 'T subject', 'body') on conflict do nothing`, [appId]);
    const doc = (await owner.one(`select meta.export_app('hr') as d`)).d;
    assert.ok(doc.email_templates.some((t: any) => t.name === 'T_EXPORT'));
    const text = JSON.stringify(doc);
    assert.doesNotMatch(text, /mail_service|mail_queue|secret_enc|T_MAIL/);
    const copy = (await owner.one(`select meta.import_app($1::jsonb, 'hr-mail-copy') as id`, [JSON.stringify(doc)])).id;
    try {
      assert.equal((await owner.one(`select subject from meta.email_template where app_id = $1 and name = 'T_EXPORT'`, [copy])).subject, 'T subject');
      assert.equal((await owner.one('select count(*)::int as n from meta.app_mail_service where app_id = $1', [copy])).n, 0, 'the copy has no mail service');
    } finally {
      await owner.query('delete from meta.app where id = $1', [copy]);
    }
  });
});

void TOKEN;
