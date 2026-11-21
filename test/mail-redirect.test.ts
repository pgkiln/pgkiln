// Sprint 250 (MG-24, MG-25; migration 206): "Redirect all mail to" (the application setting
// meta.app.mail_redirect_to and the environment variable MAIL_REDIRECT_TO, which wins), applied when
// the server sends, through every provider (mock servers: no real mail); the builder's form on the
// application's Mail page, Activity → Mail showing the redirect, the builder's test mail; and absolute
// URLs: meta.page_url(…, p_absolute => true), meta.app_url() and meta.public_url() from the address the
// server records (src/public-url.ts).
process.env.PGKILN_SECRET_KEY = 'test-only-secret-key-0123456789abcdef';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { encryptSecret } from '../src/secrets.ts';
import { mailTick } from '../src/mail/mail.ts';
import { clearTokens } from '../src/mail/providers.ts';
import { envRedirect, redirectMail } from '../src/mail/redirect.ts';
import { publicUrlToRecord, recordPublicUrl } from '../src/public-url.ts';
import { urlChecksum } from '../src/security.ts';
import { Browser } from './helpers.ts';
import { MailMock } from './mail-mock.ts';

let app: FastifyInstance;
let appId: number;
let role: string;
let savedLinks: { service_id: number; from_address: string | null; max_per_day: number | null; is_default: boolean }[] = [];
let savedPublicUrl: string | null = null;
const mock = new MailMock();
const SERVICE = 'T250_MAIL';
const TESTER = 'tester@example.com';

async function asApp<T>(fn: (q: (sql: string, params?: unknown[]) => Promise<any[]>) => Promise<T>, user = 'KING') {
  const c = await owner.pool.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('pgkiln.app_id', $1, true), set_config('pgkiln.app_user', $2, true)`, [String(appId), user]);
    await c.query(`set local role ${role}`);
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

async function useService(provider: string, settings: Record<string, unknown>, secret: string | null = 'key-1') {
  await owner.query('delete from meta.mail_service where name = $1', [SERVICE]);
  const id = (await owner.one('insert into meta.mail_service (name, provider, settings, secret_enc, senders) values ($1, $2, $3, $4, $5) returning id',
    [SERVICE, provider, JSON.stringify(settings), secret ? encryptSecret(secret) : null, ['@example.com']])).id;
  await owner.query(`insert into meta.app_mail_service (app_id, service_id, from_address) values ($1, $2, 'hr@example.com')`, [appId, id]);
  await owner.query('update meta.app_mail_service set is_default = true where app_id = $1 and service_id = $2', [appId, id]);
}

const smtp = () => useService('smtp', { host: '127.0.0.1', port: mock.smtpPort, security: 'none', auth: 'password', username: 'mailer@example.com' }, 'the-password');

async function sendOne(a: { to?: string; cc?: string; bcc?: string; subject?: string; body?: string | null; html?: string | null } = {}) {
  const id = await asApp(async (q) => (await q('select meta.send_mail($1, $2, $3, $4, null, $5, $6, null) as id',
    [a.to ?? 'king@example.com', a.subject ?? 'T250 hello', a.body === undefined ? 'Plain text' : a.body, a.html ?? null, a.cc ?? null, a.bcc ?? null]))[0].id);
  await mailTick();
  return owner.one('select * from meta.mail_queue where id = $1', [id]);
}

const setRedirect = (to: string | null) => owner.query('update meta.app set mail_redirect_to = $2 where id = $1', [appId, to]);

before(async () => {
  app = await buildApp({ logger: false });
  const a = await owner.one(`select id, db_role from meta.app where alias = 'hr'`);
  appId = a.id;
  role = a.db_role;
  savedLinks = (await owner.query('select service_id, from_address, max_per_day, is_default from meta.app_mail_service where app_id = $1 order by is_default desc', [appId])).rows;
  savedPublicUrl = (await owner.one(`select value from meta.instance_setting where name = 'public_url'`))?.value ?? null;
  await mock.start();
});

beforeEach(async () => {
  mock.reset();
  clearTokens();
  delete process.env.MAIL_REDIRECT_TO;
  await owner.query(`update meta.mail_queue set status = 'cancelled' where app_id = $1 and status = 'queued'`, [appId]);
});

afterEach(async () => {
  delete process.env.MAIL_REDIRECT_TO;
  await setRedirect(null);
});

after(async () => {
  await owner.query(`delete from meta.mail_queue where app_id = $1 and subject like '%T250%'`, [appId]);
  await owner.query('delete from meta.mail_service where name = $1', [SERVICE]);
  await owner.query('delete from meta.app_mail_service where app_id = $1', [appId]);
  for (const r of savedLinks)
    await owner.query('insert into meta.app_mail_service (app_id, service_id, from_address, max_per_day, is_default) values ($1, $2, $3, $4, $5)',
      [appId, r.service_id, r.from_address, r.max_per_day, r.is_default]);
  if (savedPublicUrl === null) await owner.query(`delete from meta.instance_setting where name = 'public_url'`);
  else await recordPublicUrl(savedPublicUrl);
  await mock.stop();
  await app.close();
  await closePools();
});

describe('MG-24: redirect all mail', () => {
  test('redirectMail: one recipient, [TEST] once, the original recipients in headers and at the top of the body', () => {
    const m = { from: 'hr@example.com', to: ['a@example.com', 'b@example.com'], cc: ['c@example.com'], bcc: ['d@example.com'], replyTo: 'hr@example.com',
      subject: 'Payslip', text: 'Hello', html: '<html><body class="x"><p>Hello</p></body></html>', attachments: [] };
    const r = redirectMail(m, { to: TESTER, source: 'application' });
    assert.deepEqual([r.to, r.cc, r.bcc], [[TESTER], [], []]);
    assert.equal(r.subject, '[TEST] Payslip');
    assert.equal(redirectMail(r, { to: TESTER, source: 'application' }).subject, '[TEST] Payslip', 'not twice');
    assert.equal(r.headers!['X-Original-To'], 'a@example.com, b@example.com');
    assert.equal(r.headers!['X-Original-Cc'], 'c@example.com');
    assert.equal(r.headers!['X-Original-Bcc'], 'd@example.com');
    assert.match(r.text!, /^\[TEST\] Redirected to tester@example\.com .*Originally To: a@example\.com, b@example\.com; Cc: c@example\.com; Bcc: d@example\.com\.\n\nHello$/);
    assert.match(r.html!, /^<html><body class="x"><p style="[^"]*">\[TEST\] Redirected to tester@example\.com/);
    assert.equal(r.replyTo, 'hr@example.com');
    // an HTML-only mail gets the line in the HTML only; a mail without a body gets it as text
    const h = redirectMail({ ...m, text: null, html: '<p>x</p>' }, { to: TESTER, source: 'MAIL_REDIRECT_TO' });
    assert.equal(h.text, null);
    assert.match(h.html!, /^<p style="[^"]*">\[TEST\] Redirected to tester@example\.com \(MAIL_REDIRECT_TO\)/);
    assert.match(redirectMail({ ...m, text: null, html: null }, { to: TESTER, source: 'application' }).text!, /^\[TEST\]/);
  });

  test('the application setting: SMTP gets one recipient, the queue keeps the original and records the redirect', async () => {
    await smtp();
    await setRedirect(TESTER);
    const m = await sendOne({ to: 'king@example.com, jones@example.com', cc: 'blake@example.com', bcc: 'hidden@example.com', subject: 'T250 smtp' });
    assert.equal(m.status, 'sent', m.message);
    assert.equal(m.redirected_to, TESTER);
    assert.deepEqual(m.to_addresses, ['king@example.com', 'jones@example.com'], 'the queue keeps the recipients');
    assert.equal(mock.smtpHits.length, 1);
    const hit = mock.smtpHits[0];
    assert.deepEqual(hit.to, [TESTER], 'the envelope: only the redirect address');
    assert.match(hit.data, /^Subject: \[TEST\] T250 smtp/m);
    assert.match(hit.data, /^To: tester@example\.com/m);
    assert.doesNotMatch(hit.data, /^Cc:/m);
    assert.match(hit.data, /^X-Original-To: king@example\.com, jones@example\.com/m);
    assert.match(hit.data, /^X-Original-Cc: blake@example\.com/m);
    assert.match(hit.data, /^X-Original-Bcc: hidden@example\.com/m);
    assert.match(hit.data.replace(/=\r\n/g, ''), /Originally To: king@example\.com, jones@example\.com; Cc: blake@example\.com; Bcc: hidden@example\.com/);
  });

  test('MAIL_REDIRECT_TO wins over the application setting; an invalid one stops the mail', async () => {
    await smtp();
    await setRedirect(TESTER);
    process.env.MAIL_REDIRECT_TO = 'ops-inbox@example.com';
    let m = await sendOne({ subject: 'T250 env' });
    assert.equal(m.status, 'sent', m.message);
    assert.equal(m.redirected_to, 'ops-inbox@example.com');
    assert.deepEqual(mock.smtpHits[0].to, ['ops-inbox@example.com']);
    assert.match(mock.smtpHits[0].data, /^X-Pgkiln-Redirected: MAIL_REDIRECT_TO; to ops-inbox@example\.com/m);
    // the environment alone, without the application's setting
    await setRedirect(null);
    mock.reset();
    m = await sendOne({ subject: 'T250 env only' });
    assert.deepEqual(mock.smtpHits[0].to, ['ops-inbox@example.com']);
    // not one address: nothing leaves
    process.env.MAIL_REDIRECT_TO = 'a@example.com, b@example.com';
    assert.throws(() => envRedirect(), /not one e-mail address/);
    mock.reset();
    m = await sendOne({ subject: 'T250 bad env' });
    assert.equal(m.status, 'error');
    assert.match(m.message, /MAIL_REDIRECT_TO .* is not one e-mail address/);
    assert.equal(mock.smtpHits.length, 0);
  });

  test('without a redirect nothing changes', async () => {
    await smtp();
    const m = await sendOne({ subject: 'T250 plain', cc: 'blake@example.com' });
    assert.equal(m.redirected_to, null);
    assert.deepEqual(mock.smtpHits[0].to.sort(), ['blake@example.com', 'king@example.com']);
    assert.match(mock.smtpHits[0].data, /^Subject: T250 plain/m);
    assert.doesNotMatch(mock.smtpHits[0].data, /X-Original-To/);
  });

  test('every HTTP provider: one recipient and the X-Original headers', async () => {
    await setRedirect(TESTER);
    for (const [provider, settings, check] of [
      ['graph', { tenant_id: 't', client_id: 'the-client', token_url: `${mock.httpUrl}/t/oauth2/v2.0/token` }, (b: any) => {
        assert.deepEqual([b.message.toRecipients, b.message.ccRecipients, b.message.bccRecipients], [[{ emailAddress: { address: TESTER } }], [], []]);
        assert.ok(b.message.internetMessageHeaders.some((h: any) => h.name === 'X-Original-Bcc' && h.value === 'hidden@example.com'));
        assert.match(b.message.subject, /^\[TEST\] /);
      }],
      ['ses', { region: 'eu-west-1', access_key_id: 'AKIDEXAMPLE' }, (b: any) => {
        assert.deepEqual(b.Destination, { ToAddresses: [TESTER], CcAddresses: [], BccAddresses: [] });
        assert.match(Buffer.from(b.Content.Raw.Data, 'base64').toString(), /^X-Original-Bcc: hidden@example\.com/m);
      }],
      ['resend', {}, (b: any) => {
        assert.deepEqual([b.to, b.cc, b.bcc], [[TESTER], undefined, undefined]);
        assert.equal(b.headers['X-Original-To'], 'king@example.com');
      }],
      ['postmark', {}, (b: any) => {
        assert.deepEqual([b.To, b.Cc, b.Bcc], [TESTER, undefined, undefined]);
        assert.ok(b.Headers.some((h: any) => h.Name === 'X-Original-Cc' && h.Value === 'blake@example.com'));
      }],
      ['sendgrid', {}, (b: any) => {
        assert.deepEqual(b.personalizations, [{ to: [{ email: TESTER }] }]);
        assert.equal(b.headers['X-Original-Bcc'], 'hidden@example.com');
      }],
      ['mailgun', { domain: 'mg.example.com' }, (b: string) => {
        assert.match(b, new RegExp(`name="to"\\r\\n\\r\\n${TESTER}\\r\\n`));
        assert.doesNotMatch(b, /name="(cc|bcc)"/);
        assert.match(b, /name="h:X-Original-Bcc"\r\n\r\nhidden@example\.com/);
      }],
    ] as const) {
      mock.reset();
      clearTokens();
      await useService(provider, { ...settings, base_url: mock.httpUrl }, provider === 'graph' ? 'the-client-secret' : 'key-1');
      const m = await sendOne({ subject: `T250 ${provider}`, cc: 'blake@example.com', bcc: 'hidden@example.com', html: '<p>Hi</p>' });
      assert.equal(m.status, 'sent', `${provider}: ${m.message}`);
      assert.equal(m.redirected_to, TESTER, provider);
      const hit = mock.httpHits.find((h) => !h.path.endsWith('/token'))!;
      const body = hit.body.toString();
      (check as (b: unknown) => void)(provider === 'mailgun' ? body : JSON.parse(body));
      assert.ok(!(provider === 'mailgun' ? /name="bcc"/.test(body) : /"(Bcc|BccAddresses|bcc|bccRecipients)":\s*\[?\{?"?[^\]]*hidden/.test(body)), `${provider}: no Bcc recipient`);
    }
  });

  test('the builder: the form on the application\'s Mail page, the notice, the redirect in the list; export carries it', async () => {
    await useService('log', {});
    const dev = new Browser(app);
    await dev.get('/builder/login');
    assert.equal((await dev.submit('/builder/login', { username: 'admin', password: 'admin' })).statusCode, 303);
    let page = (await dev.get(`/builder/apps/${appId}/mail`)).body;
    assert.match(page, /action="\/builder\/apps\/\d+\/mail\/redirect"/);
    assert.match(page, /name="mail_redirect_to" [^>]*value=""/);
    let res = await dev.submit(`/builder/apps/${appId}/mail/redirect`, { mail_redirect_to: 'a@example.com, b@example.com' });
    assert.equal(res.statusCode, 303);
    assert.equal((await owner.one('select mail_redirect_to from meta.app where id = $1', [appId])).mail_redirect_to, null, 'two addresses: refused');
    res = await dev.submit(`/builder/apps/${appId}/mail/redirect`, { mail_redirect_to: `  ${TESTER} ` });
    assert.equal((await owner.one('select mail_redirect_to from meta.app where id = $1', [appId])).mail_redirect_to, TESTER);
    const log = await owner.one(`select detail from meta.activity_log where event = 'mail_redirect' and app_id = $1 order by id desc limit 1`, [appId]);
    assert.equal(log.detail, `redirect all mail to ${TESTER}`);
    await sendOne({ subject: 'T250 shown' });
    page = (await dev.get(`/builder/apps/${appId}/mail`)).body;
    assert.match(page, /Every mail of this application goes only to tester@example\.com/);
    assert.match(page, /<span class="tag">redirected to tester@example\.com<\/span>/);
    // the export carries it (an ordinary column of meta.app)
    const doc = (await owner.one(`select meta.export_app('hr') as d`)).d;
    assert.equal(doc.app.mail_redirect_to, TESTER);
    // MAIL_REDIRECT_TO is shown above it
    process.env.MAIL_REDIRECT_TO = 'ops-inbox@example.com';
    page = (await dev.get(`/builder/apps/${appId}/mail`)).body;
    assert.match(page, /MAIL_REDIRECT_TO is set on this installation: every mail goes only to ops-inbox@example\.com/);
    // the builder's test mail goes there too
    mock.reset();
    const svc = (await owner.one('select id from meta.mail_service where name = $1', [SERVICE])).id;
    const res2 = await dev.submit('/builder/mail/check', { service_id: String(svc), provider: 'resend', senders: '@example.com',
      base_url: mock.httpUrl, secret: 'key-1', check: 'send', test_to: 'someone@example.com', test_from: 'hr@example.com' });
    assert.match(res2.body, /MAIL_REDIRECT_TO: it went to ops-inbox@example\.com instead/);
    assert.deepEqual(JSON.parse(mock.httpHits[0].body.toString()).to, ['ops-inbox@example.com']);
    await dev.get(`/builder/apps/${appId}/mail`);
    // empty: off
    delete process.env.MAIL_REDIRECT_TO;
    await dev.submit(`/builder/apps/${appId}/mail/redirect`, { mail_redirect_to: '' });
    assert.equal((await owner.one('select mail_redirect_to from meta.app where id = $1', [appId])).mail_redirect_to, null);
  });

  test('the column refuses anything but one address', async () => {
    for (const bad of ['a@example.com, b@example.com', 'a@example.com\r\nBcc: x@example.com', 'no-at-sign', 'x'.repeat(250) + '@example.com'])
      await assert.rejects(owner.query('update meta.app set mail_redirect_to = $2 where id = $1', [appId, bad]), /check constraint/, bad);
  });
});

describe('MG-25: absolute URLs', () => {
  test('PUBLIC_URL as recorded: no trailing slash, query or fragment; the fallback without it', () => {
    assert.equal(publicUrlToRecord({ PUBLIC_URL: 'https://apps.example.com/' }), 'https://apps.example.com');
    assert.equal(publicUrlToRecord({ PUBLIC_URL: 'https://apps.example.com/pgkiln/?x=1#y' }), 'https://apps.example.com/pgkiln');
    assert.equal(publicUrlToRecord({ PUBLIC_URL: 'https://user:pw@apps.example.com' }), 'https://apps.example.com');
    assert.equal(publicUrlToRecord({ PORT: '3999' }), 'http://127.0.0.1:3999');
    assert.equal(publicUrlToRecord({ PUBLIC_URL: 'ftp://x.example', PORT: '3999' }), 'http://127.0.0.1:3999');
  });

  test('meta.page_url(…, p_absolute => true) and meta.app_url(): the public address, checksummed as the relative link', async () => {
    await recordPublicUrl('https://apps.example.com');
    const [r] = await asApp((q) => q(`select meta.page_url(3, '{"P3_EMPNO": 7839}') as rel,
                                             meta.page_url(3, '{"P3_EMPNO": 7839}', p_absolute => true) as abs,
                                             meta.page_url(1, p_clear => false, p_absolute => true) as bare,
                                             meta.app_url() as home, meta.app_url(false) as home_rel, meta.public_url() as pub`));
    assert.equal(r.abs, `https://apps.example.com${r.rel}`);
    const cs = new URL(r.abs).searchParams.get('cs');
    assert.equal(cs, urlChecksum(appId, 3, 'KING', { P3_EMPNO: '7839' }));
    assert.equal(r.bare, 'https://apps.example.com/a/hr/1');
    assert.equal(r.home, 'https://apps.example.com/a/hr');
    assert.equal(r.home_rel, '/a/hr');
    assert.equal(r.pub, 'https://apps.example.com');
    // the old three-argument calls still work
    const [old] = await asApp((q) => q(`select meta.page_url(3, '{}'::jsonb, false) as u`));
    assert.equal(old.u, '/a/hr/3');
  });

  test('not recorded: a clear error', async () => {
    await owner.query(`delete from meta.instance_setting where name = 'public_url'`);
    await assert.rejects(asApp((q) => q('select meta.app_url()')), /The public address of pgkiln is not known here: set PUBLIC_URL/);
    await assert.rejects(asApp((q) => q('select meta.page_url(1, p_absolute => true)')), /set PUBLIC_URL/);
    const [r] = await asApp((q) => q('select meta.page_url(1) as u'));
    assert.equal(r.u, '/a/hr/1?clear=1', 'relative links need no address');
    await recordPublicUrl('https://apps.example.com');
  });

  test('the Sample Processes mail links to its tracking page with an absolute URL and redirects its mail', async () => {
    const { readFileSync } = await import('node:fs');
    const sql = readFileSync(new URL('../examples/gallery/samples/sample-processes.sql', import.meta.url), 'utf8');
    assert.match(sql, /mail_redirect_to\)[\s\S]*'shop-test@example\.com'\)/);
    assert.match(sql, /meta\.page_url\(8, jsonb_build_object\(''P8_ID'', :P4_ORDER\), p_absolute => true\) as p4_track_url/);
    assert.match(sql, /Follow it: &P4_TRACK_URL\./);
  });
});
