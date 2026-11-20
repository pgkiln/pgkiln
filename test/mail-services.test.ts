// Sprint 236 (MG-1, migration 191): several mail services per application. The links
// (app_id, service_id) with exactly one default per application, the choice of the service
// by the From address (else the default) when queuing and when sending, the daily limit per
// service, the builder's Mail services → Applications (several services, the default), the
// application's mail page, and the HR example's second service (part 99).
process.env.PGKILN_SECRET_KEY = 'test-only-secret-key-0123456789abcdef';
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { mailTick } from '../src/mail/mail.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
let role: string;
let svcA: number;
let svcB: number;
let saved: { service_id: number; from_address: string | null; max_per_day: number | null; is_default: boolean }[] = [];
const A = 'T236_ORDERS';
const B = 'T236_SAFETY';

/** Run SQL as the HR application does: its role, its app id, a user (rolled back unless commit). */
async function asApp<T>(fn: (q: (sql: string, params?: unknown[]) => Promise<any[]>) => Promise<T>, commit = true) {
  const c = await owner.pool.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('pgkiln.app_id', $1, true), set_config('pgkiln.app_user', 'KING', true)`, [String(appId)]);
    await c.query(`set local role ${role}`);
    const r = await fn(async (sql, params) => (await c.query(sql, params)).rows);
    await c.query(commit ? 'commit' : 'rollback');
    return r;
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}

const links = async () => (await owner.query<{ name: string; is_default: boolean }>(
  `select s.name, x.is_default from meta.app_mail_service x join meta.mail_service s on s.id = x.service_id where x.app_id = $1 order by s.name`, [appId])).rows;
const defaultOf = async () => (await links()).filter((l) => l.is_default).map((l) => l.name);

async function admin() {
  const b = new Browser(app);
  await b.get('/builder/login');
  assert.equal((await b.submit('/builder/login', { username: 'admin', password: 'admin' })).statusCode, 303);
  return b;
}

before(async () => {
  app = await buildApp({ logger: false });
  const a = await owner.one(`select id, db_role from meta.app where alias = 'hr'`);
  appId = a.id;
  role = a.db_role;
  saved = (await owner.query('select service_id, from_address, max_per_day, is_default from meta.app_mail_service where app_id = $1 order by is_default desc', [appId])).rows;
});

beforeEach(async () => {
  // HR with exactly two services of its own: orders (the default) and safety
  await owner.query('delete from meta.mail_service where name = any($1)', [[A, B]]);
  await owner.query('delete from meta.app_mail_service where app_id = $1', [appId]);
  await owner.query(`update meta.mail_queue set status = 'cancelled' where app_id = $1 and status = 'queued'`, [appId]);
  svcA = (await owner.one(`insert into meta.mail_service (name, provider, senders, settings) values ($1, 'log', '{@orders.example}', '{"default_from": "shop@orders.example"}') returning id`, [A])).id;
  svcB = (await owner.one(`insert into meta.mail_service (name, provider, senders) values ($1, 'log', '{safety@safety.example, @both.example}') returning id`, [B])).id;
  await owner.query(`insert into meta.app_mail_service (app_id, service_id, from_address) values ($1, $2, 'shop@orders.example')`, [appId, svcA]);
  await owner.query(`insert into meta.app_mail_service (app_id, service_id, from_address) values ($1, $2, 'safety@safety.example')`, [appId, svcB]);
});

after(async () => {
  await owner.query('delete from meta.mail_service where name = any($1)', [[A, B]]);
  await owner.query('delete from meta.app_mail_service where app_id = $1', [appId]);
  for (const r of saved)
    await owner.query('insert into meta.app_mail_service (app_id, service_id, from_address, max_per_day, is_default) values ($1, $2, $3, $4, $5)',
      [appId, r.service_id, r.from_address, r.max_per_day, r.is_default]);
  await app.close();
  await closePools();
});

describe('mail services per application: the links', () => {
  test('the first link is the default; a new default takes over; deleting the default promotes another', async () => {
    assert.deepEqual(await links(), [{ name: A, is_default: true }, { name: B, is_default: false }]);
    await owner.query('update meta.app_mail_service set is_default = true where app_id = $1 and service_id = $2', [appId, svcB]);
    assert.deepEqual(await defaultOf(), [B]);
    // a link inserted as the default takes over too
    await owner.query('delete from meta.app_mail_service where app_id = $1 and service_id = $2', [appId, svcA]);
    assert.deepEqual(await defaultOf(), [B]);
    await owner.query('insert into meta.app_mail_service (app_id, service_id, is_default) values ($1, $2, true)', [appId, svcA]);
    assert.deepEqual(await defaultOf(), [A]);
    // deleting the default (here: its service) promotes the other
    await owner.query('delete from meta.mail_service where id = $1', [svcA]);
    assert.deepEqual(await links(), [{ name: B, is_default: true }]);
    // never two defaults, even with the triggers off (the partial unique index)
    await owner.query('insert into meta.app_mail_service (app_id, service_id) values ($1, $2)', [appId, (await owner.one(`insert into meta.mail_service (name, provider, senders) values ($1, 'log', '{@x.example}') returning id`, [A])).id]);
    await assert.rejects(owner.tx(async (c) => {
      await c.query('set local session_replication_role = replica');
      await c.query('update meta.app_mail_service set is_default = true where app_id = $1', [appId]);
    }), /app_mail_service_default/);
  });

  test('meta.mail_service_for_app: one argument the default, with a From address the service that may send as it', async () => {
    const pick = async (from: string | null) => (await owner.one('select meta.mail_service_for_app($1, $2::text) as s', [appId, from])).s;
    assert.equal((await owner.one('select meta.mail_service_for_app($1) as s', [appId])).s, svcA);
    assert.equal(await pick(null), svcA);
    assert.equal(await pick('safety@safety.example'), svcB);
    assert.equal(await pick('SAFETY@Safety.Example'), svcB, 'addresses compare case-insensitively');
    assert.equal(await pick('shop@orders.example'), svcA);
    assert.equal(await pick('nobody@elsewhere.example'), svcA, 'no match: the default');
    // both may send as it: the default wins
    await owner.query(`update meta.mail_service set senders = '{@orders.example, @both.example}' where id = $1`, [svcA]);
    assert.equal(await pick('x@both.example'), svcA);
    // a disabled service is not chosen for its senders
    await owner.query('update meta.mail_service set enabled = false where id = $1', [svcB]);
    assert.equal(await pick('safety@safety.example'), svcA);
  });
});

describe('mail services per application: sending', () => {
  test('meta.send_mail goes through the service whose senders match p_from, else the default; the sender uses it', async () => {
    const [viaB, viaA, dflt] = await asApp(async (q) => [
      (await q(`select meta.send_mail('king@example.com', 'T236 safety', 'x', p_from => 'safety@safety.example') as id`))[0].id,
      (await q(`select meta.send_mail('king@example.com', 'T236 order', 'x', p_from => 'orders@orders.example') as id`))[0].id,
      (await q(`select meta.send_mail('king@example.com', 'T236 default', 'x') as id`))[0].id,
    ]);
    const row = (id: string) => owner.one('select service_id, from_address, status, service from meta.mail_queue where id = $1', [id]);
    assert.equal((await row(viaB)).service_id, svcB);
    assert.equal((await row(viaA)).service_id, svcA);
    assert.deepEqual([(await row(dflt)).service_id, (await row(dflt)).from_address], [svcA, 'shop@orders.example'], 'no From: the default service and its From address');
    await mailTick();
    assert.deepEqual([(await row(viaB)).status, (await row(viaB)).service], ['sent', B]);
    assert.deepEqual([(await row(viaA)).status, (await row(viaA)).service], ['sent', A]);
    assert.deepEqual([(await row(dflt)).status, (await row(dflt)).service], ['sent', A]);
  });

  test('a From address no linked service may send as is refused; templates choose the same way', async () => {
    await assert.rejects(asApp((q) => q(`select meta.send_mail('king@example.com', 'T236', 'x', p_from => 'ceo@elsewhere.example')`)), /the mail service may not send as ceo@elsewhere\.example \(nor may another/);
    await owner.query(`insert into meta.email_template (app_id, name, subject, text_body) values ($1, 'T236_TPL', 'Hello #NAME#', 'Hi') on conflict do nothing`, [appId]);
    try {
      const id = await asApp(async (q) => (await q(`select meta.send_mail_template('T236_TPL', '{"NAME": "Ann"}', 'king@example.com', p_from => 'safety@safety.example') as id`))[0].id);
      assert.equal((await owner.one('select service_id from meta.mail_queue where id = $1', [id])).service_id, svcB);
    } finally {
      await owner.query(`delete from meta.email_template where app_id = $1 and name = 'T236_TPL'`, [appId]);
    }
  });

  test('the daily limit is per service; meta.mail_available() still answers for the default', async () => {
    await owner.query('update meta.app_mail_service set max_per_day = 0 where app_id = $1 and service_id = $2', [appId, svcB]);
    await assert.rejects(asApp((q) => q(`select meta.send_mail('king@example.com', 'T236', 'x', p_from => 'safety@safety.example')`)), /limit of 0 mails per day/);
    assert.ok(await asApp((q) => q(`select meta.send_mail('king@example.com', 'T236', 'x', p_from => 'shop@orders.example')`), false));
    assert.equal((await asApp((q) => q('select meta.mail_available() as ok'), false))[0].ok, true);
    // the default disabled: mail_available says no, and mail without a From address can't be queued
    await owner.query('update meta.mail_service set enabled = false where id = $1', [svcA]);
    assert.equal((await asApp((q) => q('select meta.mail_available() as ok'), false))[0].ok, false);
    await assert.rejects(asApp((q) => q(`select meta.send_mail('king@example.com', 'T236', 'x')`)), /may not send e-mail/);
  });

  test('a queued mail whose service was unlinked goes through the service for its From address now', async () => {
    const id = await asApp(async (q) => (await q(`select meta.send_mail('king@example.com', 'T236 relinked', 'x', p_from => 'x@both.example') as id`))[0].id);
    assert.equal((await owner.one('select service_id from meta.mail_queue where id = $1', [id])).service_id, svcB);
    await owner.query('delete from meta.app_mail_service where app_id = $1 and service_id = $2', [appId, svcB]);
    await owner.query(`update meta.mail_service set senders = '{@orders.example, @both.example}' where id = $1`, [svcA]);
    await mailTick();
    assert.deepEqual(await owner.one('select status, service from meta.mail_queue where id = $1', [id]), { status: 'sent', service: A });
  });
});

describe('mail services per application: the builder', () => {
  test('Mail services → Applications: several services per application, the default chosen there', async () => {
    const b = await admin();
    let page = (await b.get(`/builder/mail/${svcB}`)).body;
    assert.match(page, new RegExp(`name="default" value="${appId}" aria-label="Default service for hr"> default`), 'not the default: unchecked');
    assert.match(page, new RegExp(`also: ${A} \\(default\\)`));
    // make B the default (keeping the link, its From address and a limit)
    await b.submit(`/builder/mail/${svcB}/apps`, { allow: String(appId), default: String(appId), [`from_${appId}`]: 'safety@safety.example', [`max_${appId}`]: '20' });
    assert.deepEqual(await defaultOf(), [B]);
    assert.equal((await links()).length, 2, 'A stays linked');
    page = (await b.get(`/builder/mail/${svcB}`)).body;
    assert.match(page, new RegExp(`name="default" value="${appId}" checked`));
    assert.match(page, new RegExp(`also: ${A}<`), 'A is no longer the default');
    // the overview: "(default)" after the alias on the default's row
    assert.match((await b.get('/builder/mail')).body, /hr \(default\)/);
    // the application's mail page: the default, and the others with their senders
    const mailPage = (await b.get(`/builder/apps/${appId}/mail`)).body;
    assert.match(mailPage, new RegExp(`It sends through <b>${B}</b>`));
    assert.match(mailPage, new RegExp(`goes through them: ${A} \\(@orders\\.example\\)`));
    // no longer the default: the other service is
    await b.get(`/builder/mail/${svcB}`);
    await b.submit(`/builder/mail/${svcB}/apps`, { allow: String(appId), [`from_${appId}`]: 'safety@safety.example' });
    assert.deepEqual(await defaultOf(), [A]);
    // unlinking the default promotes the other
    await b.get(`/builder/mail/${svcA}`);
    await b.submit(`/builder/mail/${svcA}/apps`, {});
    assert.deepEqual(await links(), [{ name: B, is_default: true }]);
  });

  test('an only service stays the default when "Default" is unchecked', async () => {
    await owner.query('delete from meta.app_mail_service where app_id = $1 and service_id = $2', [appId, svcB]);
    const b = await admin();
    await b.get(`/builder/mail/${svcA}`);
    await b.submit(`/builder/mail/${svcA}/apps`, { allow: String(appId), [`from_${appId}`]: 'shop@orders.example' });
    assert.deepEqual(await links(), [{ name: A, is_default: true }]);
  });
});

describe('the HR example (part 99)', () => {
  test('hr.send_safety_notice goes through SAFETY_LOG, other HR mail through the default DEVELOPMENT_LOG', async () => {
    // HR's links as parts 51 and 99 install them (other test files may have replaced them)
    await owner.query('delete from meta.app_mail_service where app_id = $1', [appId]);
    await owner.query(`insert into meta.mail_service (name, description, provider, senders, settings)
      values ('DEVELOPMENT_LOG', 'Writes mail to the server log; sends nothing', 'log', '{@example.com}', '{"default_from": "hr@example.com"}'),
             ('SAFETY_LOG', 'Safety notices', 'log', '{@safety.example.org}', '{"default_from": "alerts@safety.example.org"}')
      on conflict (name) do update set enabled = true`);
    await owner.query(`insert into meta.app_mail_service (app_id, service_id, from_address, max_per_day, is_default)
      select $1, id, case name when 'SAFETY_LOG' then 'alerts@safety.example.org' else 'hr@example.com' end, null, name = 'DEVELOPMENT_LOG'
        from meta.mail_service where name in ('DEVELOPMENT_LOG', 'SAFETY_LOG') order by name`, [appId]);
    const names = (await links()).map((l) => l.name);
    assert.ok(names.includes('SAFETY_LOG') && names.includes('DEVELOPMENT_LOG'), names.join());
    assert.deepEqual(await defaultOf(), ['DEVELOPMENT_LOG']);
    const ids = await asApp(async (q) => [
      (await q(`select hr.send_safety_notice('king@example.com', 'Fire drill at 10:00') as id`))[0].id,
      (await q(`select meta.send_mail('king@example.com', 'T236 HR', 'x') as id`))[0].id,
    ]);
    const svc = async (id: string) => (await owner.one('select s.name from meta.mail_queue q join meta.mail_service s on s.id = q.service_id where q.id = $1', [id])).name;
    assert.equal(await svc(ids[0]), 'SAFETY_LOG');
    assert.equal(await svc(ids[1]), 'DEVELOPMENT_LOG');
    await owner.query(`update meta.mail_queue set status = 'cancelled' where id = any($1::bigint[])`, [ids]);
  });
});
