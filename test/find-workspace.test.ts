// Sprint 68: "Find my workspace" on the builder's sign-in page (migration 096):
// developers' e-mail addresses, the builder's mail service (Mail services →
// Builder mail), the mail with an account's workspaces, the same answer for
// every address, and the limits per address.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { builderMail, workspacesMail } from '../src/builder/find-workspace.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let admin: Browser;
const DEV = 's68_dev';
const DEV_PW = 'S68-dev-password!';
const ADDRESS = 's68.dev@example.com';
const logged: string[] = [];
const realLog = console.log;

async function cleanup() {
  await owner.query(`delete from meta.developer where username like 's68\\_%'`);
  await owner.query(`delete from meta.workspace where name like 'S68 %'`);
  await owner.query(`delete from meta.setting where name in ('builder_mail_service', 'builder_mail_from')`);
  await owner.query(`delete from meta.mail_service where name like 'S68\\_%'`);
  await owner.query(`delete from meta.activity_log where event = 'find_workspace'`);
}

/** The mails the "log" provider wrote since the last call (the mail goes out after the answer). */
async function sent() {
  await new Promise((r) => setTimeout(r, 300));
  return logged.splice(0).filter((l) => l.startsWith('mail (log only)'));
}

before(async () => {
  await cleanup();
  console.log = (...a: unknown[]) => (logged.push(a.map(String).join(' ')), undefined);
  app = await buildApp({ logger: false });
  await owner.query(`insert into meta.developer (username, password_hash, is_admin, email) values ($1, meta.hash_password($2), false, $3)`, [DEV, DEV_PW, ADDRESS]);
  const ws = (await owner.one(`insert into meta.workspace (name) values ('S68 Sales') returning id`)).id;
  // only in the test workspace (a developer added by SQL also joins Default)
  await owner.query('delete from meta.workspace_member where username = $1', [DEV]);
  await owner.query('insert into meta.workspace_member (workspace_id, username) values ($1, $2)', [ws, DEV]);
  await owner.query(`insert into meta.mail_service (name, provider, senders) values ('S68_LOG', 'log', '{@example.com}')`);
  admin = new Browser(app);
  await admin.get('/builder/login');
  await admin.submit('/builder/login', { username: 'admin', password: 'admin' });
});

after(async () => {
  console.log = realLog;
  await cleanup();
  await app.close();
  await closePools();
});

describe('find my workspace', () => {
  test('the sign-in page links to it; without a builder mail service it says to ask an administrator', async () => {
    assert.match((await new Browser(app).get('/builder/login')).body, /href="\/builder\/find-workspace"/);
    assert.equal(await builderMail(), null);
    const page = (await new Browser(app).get('/builder/find-workspace')).body;
    assert.match(page, /doesn&#39;t send mail to developers|doesn't send mail to developers/);
    assert.doesNotMatch(page, /name="email"/);
  });

  test('administrators choose the builder\'s mail service and a From address it may send as', async () => {
    await admin.get('/builder/mail');
    await admin.submit('/builder/mail/builder', { service: 'S68_LOG', from: 'pgkiln@elsewhere.org' });
    assert.match((await admin.get('/builder/mail')).body, /may not send as pgkiln@elsewhere\.org/);
    assert.equal(await builderMail(), null);
    await admin.submit('/builder/mail/builder', { service: 'S68_LOG', from: 'pgkiln@example.com' });
    const m = await builderMail();
    assert.equal(m?.service.name, 'S68_LOG');
    assert.equal(m?.from, 'pgkiln@example.com');
    assert.match((await admin.get('/builder/mail')).body, /<option value="S68_LOG" selected>/);
  });

  test('the mail lists each account with the address and its workspaces', async () => {
    const m = (await workspacesMail(ADDRESS.toUpperCase()))!;
    assert.equal(m.subject, 'Your pgkiln workspaces');
    assert.match(m.text, new RegExp(`${DEV}\\n  - S68 Sales\\n`));
    assert.doesNotMatch(m.text, /Default/, 'only the workspaces the developer belongs to');
    assert.match(m.text, /Sign in at http.*\/builder\/login/);
    assert.match(m.html, /<b>s68_dev<\/b>/);
    assert.equal(await workspacesMail('nobody@example.com'), null);
  });

  test('a known and an unknown address get the same answer; only the known one gets mail', async () => {
    const b = new Browser(app);
    await b.get('/builder/find-workspace');
    const known = await b.submit('/builder/find-workspace', { email: ADDRESS });
    const knownPage = (await b.get(known.headers.location as string)).body.replace(new RegExp(ADDRESS.replace(/\./g, '\\.'), 'g'), 'X').replace(/name="__csrf" value="[^"]+"/, '');
    assert.deepEqual(await sent(), [`mail (log only): from pgkiln@example.com to ${ADDRESS}: Your pgkiln workspaces (0 attachment(s))`]);
    const unknown = await b.submit('/builder/find-workspace', { email: 'stranger@example.com' });
    const unknownPage = (await b.get(unknown.headers.location as string)).body.replace(/stranger@example\.com/g, 'X').replace(/name="__csrf" value="[^"]+"/, '');
    assert.equal(knownPage, unknownPage);
    assert.match(knownPage, /If a developer account has the address X, it gets a mail/);
    assert.deepEqual(await sent(), []);
  });

  test('at most three mails an hour per address; a malformed address is refused', async () => {
    const b = new Browser(app);
    await b.get('/builder/find-workspace');
    for (let i = 0; i < 3; i++) await b.submit('/builder/find-workspace', { email: ADDRESS });
    assert.equal((await sent()).length, 2, 'one was sent in the test before');
    await b.submit('/builder/find-workspace', { email: ADDRESS });
    assert.deepEqual(await sent(), [], 'limited');
    await b.get('/builder/find-workspace');
    const bad = await b.submit('/builder/find-workspace', { email: 'not an address' });
    assert.match((await b.get(bad.headers.location as string)).body, /Enter an e-mail address/);
  });

  test('developers set their own address; administrators set anyone\'s', async () => {
    const dev = new Browser(app);
    await dev.get('/builder/login');
    await dev.submit('/builder/login', { username: DEV, password: DEV_PW });
    const page = (await dev.get('/builder/developers')).body;
    assert.match(page, new RegExp(`name="email" type="email" value="${ADDRESS.replace(/\./g, '\\.')}"`));
    await dev.submit('/builder/developers/email', { username: DEV, email: 'new.s68@example.com' });
    assert.equal((await owner.one('select email from meta.developer where username = $1', [DEV])).email, 'new.s68@example.com');
    await dev.get('/builder/developers');
    assert.equal((await dev.submit('/builder/developers/email', { username: 'admin', email: 'evil@example.com' })).statusCode, 403);
    await dev.get('/builder/developers');
    await dev.submit('/builder/developers/email', { username: DEV, email: 'a@b' });
    assert.equal((await owner.one('select email from meta.developer where username = $1', [DEV])).email, 'new.s68@example.com', 'refused: not an address');
    await admin.get('/builder/developers');
    await admin.submit('/builder/developers/email', { username: DEV, email: '' });
    assert.equal((await owner.one('select email from meta.developer where username = $1', [DEV])).email, null);
    await admin.get('/builder/developers');
    await admin.submit('/builder/developers', { username: 's68_new', password: 'S68-new-password!', email: 'fresh.s68@example.com' });
    assert.equal((await owner.one('select email from meta.developer where username = $1', ['s68_new'])).email, 'fresh.s68@example.com');
  });
});
