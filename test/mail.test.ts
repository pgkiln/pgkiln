// E-mail: meta.send_mail(), templates, attachments, the Send e-mail
// process, delivery with retries (with a fake transport), the Mail page.
import { after, afterEach, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { pushQueue, setTransport } from '../src/mail.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
const sent: Record<string, any>[] = [];
let failNext = 0;

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  await owner.query(`delete from meta.mail_queue where status <> 'sent'`);
  setTransport({
    async sendMail(m) {
      if (failNext > 0) {
        failNext--;
        throw new Error('451 try again later');
      }
      sent.push(m);
      return {};
    },
  });
});

afterEach(async () => {
  await owner.query(`delete from meta.mail_queue where subject like 'test:%' or template = 'LEAVE_DECIDED'`);
  sent.length = 0;
});

after(async () => {
  setTransport(undefined);
  await app.close();
  await closePools();
});

/** Run SQL as an application does: in a transaction, as the app role, with the app context. */
async function asApp<T>(user: string, fn: (q: (sql: string, p?: unknown[]) => Promise<any[]>) => Promise<T>, commit = true) {
  const c = await owner.pool.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('pgapex.app_id', $1, true), set_config('pgapex.app_user', $2, true)`, [String(appId), user]);
    await c.query('set local role hr_app');
    const r = await fn(async (sql, p = []) => (await c.query(sql, p)).rows);
    await c.query(commit ? 'commit' : 'rollback');
    return r;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

describe('queueing mail', () => {
  test('apps queue mail with meta.send_mail(); it is delivered by the queue', async () => {
    const [{ id }] = await asApp('king', (q) => q(`select meta.send_mail('a@example.com, B <b@example.com>', 'test: hello', 'Body', '<p>Body</p>', null, 'c@example.com') as id`));
    const row = await owner.one('select * from meta.mail_queue where id = $1', [id]);
    assert.equal(row.app_id, appId);
    assert.equal(row.created_by, 'king');
    assert.equal(row.status, 'queued');
    const r = await pushQueue();
    assert.equal(r.sent, 1);
    assert.deepEqual(sent[0].to, ['a@example.com', 'B <b@example.com>']);
    assert.deepEqual(sent[0].cc, ['c@example.com']);
    assert.equal(sent[0].html, '<p>Body</p>');
    assert.equal((await owner.one('select status from meta.mail_queue where id = $1', [id])).status, 'sent');
  });

  test('a rolled-back transaction sends nothing', async () => {
    await asApp('king', (q) => q(`select meta.send_mail('a@example.com', 'test: rolled back', 'x')`), false);
    assert.equal((await owner.one(`select count(*)::int as n from meta.mail_queue where subject = 'test: rolled back'`)).n, 0);
  });

  test('addresses and headers cannot be injected', async () => {
    for (const bad of ['not-an-address', 'a@example.com\r\nBcc: x@evil.example', 'a@b.c; d@e.f', Array.from({ length: 51 }, (_, i) => `u${i}@example.com`).join(',')])
      await assert.rejects(asApp('king', (q) => q(`select meta.send_mail($1, 'test: bad', 'x')`, [bad])), /Invalid e-mail address/);
    await assert.rejects(asApp('king', (q) => q(`select meta.send_mail(null, 'test: none', 'x')`)), /at least one recipient/);
    const [{ id }] = await asApp('king', (q) => q(`select meta.send_mail('a@example.com', E'test: line\\r\\nBcc: x@evil.example', 'x') as id`));
    assert.doesNotMatch((await owner.one('select subject from meta.mail_queue where id = $1', [id])).subject, /[\r\n]/, 'no newlines in the subject');
  });

  test('templates escape placeholders in HTML, unless !RAW', async () => {
    await owner.query(`insert into meta.email_template (app_id, static_id, name, subject, body_html, body_text)
      values ($1, 'TEST_T', 'Test', 'test: Hi #NAME#', '<p>#NAME# #HTML!RAW#</p>', 'Hi #NAME#') on conflict do nothing`, [appId]);
    try {
      const [{ id }] = await asApp('king', (q) => q(`select meta.send_mail_template('test_t', '{"NAME": "<b>Ann</b>", "HTML": "<i>ok</i>"}', 'a@example.com') as id`));
      const m = await owner.one('select * from meta.mail_queue where id = $1', [id]);
      assert.equal(m.subject, 'test: Hi <b>Ann</b>');
      assert.equal(m.body_html, '<p>&lt;b&gt;Ann&lt;/b&gt; <i>ok</i></p>');
      assert.equal(m.body_text, 'Hi <b>Ann</b>');
      assert.equal(m.template, 'TEST_T');
      await assert.rejects(asApp('king', (q) => q(`select meta.send_mail_template('NOPE', '{}', 'a@example.com')`)), /not found/);
    } finally {
      await owner.query(`delete from meta.email_template where static_id = 'TEST_T'`);
    }
  });

  test('attachments only on queued mail of the same app and user', async () => {
    const [{ id }] = await asApp('king', (q) => q(`select meta.send_mail('a@example.com', 'test: attach', 'x') as id`));
    await asApp('king', (q) => q(`select meta.add_attachment($1, convert_to('hello', 'UTF8'), 'hello.txt', 'text/plain')`, [id]));
    await assert.rejects(asApp('allen', (q) => q(`select meta.add_attachment($1, 'x'::bytea, 'evil.txt')`, [id])), /not a queued mail/);
    await pushQueue();
    assert.equal(sent[0].attachments[0].filename, 'hello.txt');
    assert.equal(Buffer.from(sent[0].attachments[0].content).toString(), 'hello');
    await assert.rejects(asApp('king', (q) => q(`select meta.add_attachment($1, 'x'::bytea, 'late.txt')`, [id])), /not a queued mail/, 'already sent');
  });

  test('the runtime and app roles cannot read the queue', async () => {
    await assert.rejects(asApp('king', (q) => q('select * from meta.mail_queue')), /permission denied/);
  });
});

describe('delivery', () => {
  test('failures are retried with back-off, then marked failed', async () => {
    const [{ id }] = await asApp('king', (q) => q(`select meta.send_mail('a@example.com', 'test: retry', 'x') as id`));
    failNext = 1;
    assert.deepEqual(await pushQueue(), { sent: 0, failed: 1, configured: true });
    let m = await owner.one('select * from meta.mail_queue where id = $1', [id]);
    assert.equal(m.status, 'queued');
    assert.match(m.last_error, /451/);
    assert.equal((await pushQueue()).sent, 0, 'not due yet');
    await owner.query('update meta.mail_queue set next_attempt_at = now() where id = $1', [id]);
    assert.equal((await pushQueue()).sent, 1);
    const [{ id: id2 }] = await asApp('king', (q) => q(`select meta.send_mail('a@example.com', 'test: give up', 'x') as id`));
    failNext = 99;
    for (let i = 0; i < 5; i++) {
      await owner.query('update meta.mail_queue set next_attempt_at = now() where id = $1', [id2]);
      await pushQueue();
    }
    failNext = 0;
    m = await owner.one('select status, attempts from meta.mail_queue where id = $1', [id2]);
    assert.deepEqual(m, { status: 'failed', attempts: 5 });
  });
});

describe('Send e-mail process and the HR sample', () => {
  test('deciding on leave mails the employee (template, in the same transaction)', async () => {
    const start = new Date(Date.now() + 90 * 86400000);
    start.setUTCDate(start.getUTCDate() + ((8 - start.getUTCDay()) % 7));
    const d = start.toISOString().slice(0, 10);
    const [{ id }] = await asApp('allen', (q) => q(`select hr.request_leave($1, $1, 'mail test') as id`, [d]));
    try {
      await asApp('blake', (q) => q(`select hr.decide_leave($1, 'APPROVED', 'Enjoy')`, [id]));
      const m = await owner.one(`select * from meta.mail_queue where template = 'LEAVE_DECIDED' order by id desc limit 1`);
      assert.equal(m.mail_to, 'allen@example.com');
      assert.match(m.subject, /was approved/);
      assert.match(m.body_html, /Enjoy/);
    } finally {
      await owner.query('delete from hr.leave_request where id = $1', [id]);
      await owner.query(`delete from hr.notification where message like '%' || to_char($1::date, 'DD Mon') || '%'`, [d]);
    }
  });

  test('a send_email page process queues mail with item substitutions', async () => {
    const page = (await owner.one(`select id from meta.page where app_id = $1 and page_no = 1`, [appId])).id;
    const btn = (await owner.one(`insert into meta.button (page_id, seq, name, label, action) values ($1, 99, 'TEST_MAIL', 'Mail', 'submit') returning id`, [page])).id;
    const proc = (await owner.one(`insert into meta.process (page_id, seq, name, type, when_button, config, success_message)
      values ($1, 99, 'mail', 'send_email', 'TEST_MAIL', '{"to": "&APP_USER.@example.com", "subject": "test: from &APP_USER.", "body": "Hi", "body_html": "<p>&APP_USER.</p>"}', 'Mail sent.') returning id`, [page])).id;
    try {
      const b = new Browser(app);
      await b.login('king');
      await b.get('/a/hr/1');
      const res = await b.submit('/a/hr/1', { __request: 'TEST_MAIL' });
      assert.equal(res.statusCode, 303);
      const m = await owner.one(`select * from meta.mail_queue where subject = 'test: from king'`);
      assert.equal(m.mail_to, 'king@example.com');
      assert.equal(m.body_html, '<p>king</p>');
      assert.match((await b.get('/a/hr/1')).body, /Mail sent\./);
    } finally {
      await owner.query('delete from meta.process where id = $1', [proc]);
      await owner.query('delete from meta.button where id = $1', [btn]);
    }
  });
});

describe('Builder → Mail', () => {
  test('developers see the queue, queue a test mail and retry', async () => {
    const b = new Browser(app);
    assert.equal((await b.get('/builder/mail')).statusCode, 302, 'developers only');
    await b.get('/builder/login');
    await b.submit('/builder/login', { username: 'admin', password: 'admin' });
    const page = await b.get('/builder/mail');
    assert.equal(page.statusCode, 200);
    await b.submit('/builder/mail/test', { to: 'dev@example.com' });
    const m = await owner.one(`select id from meta.mail_queue where mail_to = 'dev@example.com' order by id desc limit 1`);
    assert.ok(m);
    assert.equal((await b.get(`/builder/mail/${m.id}`)).statusCode, 200);
    await owner.query('delete from meta.mail_queue where id = $1', [m.id]);
  });
});
